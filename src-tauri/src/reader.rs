//! The optional Teams integration: reading a Teams chat through the employee's own stdio MCP server,
//! with no model involved. It works with any server that offers the `list-chat-messages` tool of the
//! Microsoft 365 MCP server (`@softeria/ms-365-mcp-server`), and returns `ReadError::Unsupported`
//! otherwise, in which case replies are checked by a model run instead. The server is found and
//! launched the way Claude Code launches it for the employee's folder, asked for the chat's newest
//! messages, and killed. No JSON-RPC or Graph type leaves this module.

use crate::catalog;
use crate::claude::{self, clip};
use crate::watch::ChatMessage;
use chrono::{DateTime, Utc};
use serde_json::{json, Value};
use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::time::Duration;
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader, Lines};
use tokio::process::{ChildStdin, ChildStdout};

/// Start-up (an `npx` start takes seconds) and every read together.
const READ_LIMIT: Duration = Duration::from_secs(60);
const NEWEST: u32 = 20;

/// A stdio MCP server as Claude Code would launch it for one employee folder.
#[derive(Debug, Clone, PartialEq)]
pub struct ServerSpec {
    pub name: String,
    pub command: String,
    pub args: Vec<String>,
    pub env: Vec<(String, String)>,
    pub cwd: PathBuf,
}

#[derive(Debug, Clone, PartialEq)]
pub enum ReadError {
    /// The server is gone, is not stdio, or cannot list chat messages: a model checks instead.
    Unsupported(String),
    /// It could not be read this time (start-up, time-out, sign-in, a Graph error): try again later.
    Failed(String),
}

/// A folder as Claude Code keys its projects: no `\\?\` prefix, forward slashes, no trailing slash,
/// and on Windows without case.
fn project_key(path: &str) -> String {
    let p = path.strip_prefix(r"\\?\").unwrap_or(path).replace('\\', "/");
    let p = p.trim_end_matches('/');
    if cfg!(windows) {
        p.to_lowercase()
    } else {
        p.to_string()
    }
}

fn stdio_spec(name: &str, entry: &Value, cwd: &Path) -> Option<ServerSpec> {
    if entry.get("type").and_then(|t| t.as_str()).is_some_and(|t| t != "stdio") {
        return None;
    }
    let strings = |v: Option<&Value>| -> Vec<String> { v.and_then(|a| a.as_array()).into_iter().flatten().filter_map(|x| x.as_str().map(String::from)).collect() };
    let env = entry.get("env").and_then(|e| e.as_object()).into_iter().flatten().filter_map(|(k, v)| Some((k.clone(), v.as_str()?.to_string()))).collect();
    Some(ServerSpec { name: name.to_string(), command: entry.get("command")?.as_str()?.to_string(), args: strings(entry.get("args")), env, cwd: cwd.to_path_buf() })
}

/// The stdio server `name`, looked up in Claude Code's precedence: the local scope
/// (`projects[<employee dir>].mcpServers` in `.claude.json`), the folder's `.mcp.json`, then the user
/// scope (`mcpServers` in `.claude.json`). With no project keyed by the employee folder, a project whose
/// key ends in `/employees/<employee id>` stands in, so a copied or moved office finds its servers.
fn find_server(claude_json: Option<&Value>, project_mcp: Option<&Value>, employee_dir: &Path, employee_id: &str, name: &str) -> Option<ServerSpec> {
    let projects = claude_json.and_then(|c| c.get("projects")).and_then(|p| p.as_object());
    let local = projects.and_then(|ps| {
        let key = project_key(&employee_dir.to_string_lossy());
        let tail = project_key(&format!("/employees/{employee_id}"));
        ps.iter().find(|(k, _)| project_key(k) == key).or_else(|| ps.iter().find(|(k, _)| project_key(k).ends_with(&tail)))
    });
    [local.and_then(|(_, p)| p.get("mcpServers")), project_mcp.and_then(|m| m.get("mcpServers")), claude_json.and_then(|c| c.get("mcpServers"))]
        .into_iter()
        .flatten()
        .filter_map(|servers| servers.get(name))
        .find_map(|entry| stdio_spec(name, entry, employee_dir))
}

/// Reads Claude Code's `.claude.json` and the folder's `.mcp.json`, then `find_server`. A file that is missing
/// holds no servers; one that exists but cannot be read is an error, never a missing server: Claude Code
/// rewrites it while it runs.
pub fn load_server(employee_dir: &Path, employee_id: &str, name: &str) -> Result<Option<ServerSpec>, String> {
    let read = |p: &Path| -> Result<Option<Value>, String> {
        match std::fs::read_to_string(p) {
            Ok(text) => serde_json::from_str(&text).map(Some).map_err(|e| format!("could not read {}: {e}", p.display())),
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(None),
            Err(e) => Err(format!("could not read {}: {e}", p.display())),
        }
    };
    Ok(find_server(read(&catalog::claude_json_path())?.as_ref(), read(&employee_dir.join(".mcp.json"))?.as_ref(), employee_dir, employee_id, name))
}

/// The program to start: a bare name is looked up on the child PATH, as a shell would (so `npx`
/// finds `npx.cmd` on Windows).
fn program(command: &str, cwd: &Path) -> PathBuf {
    let p = Path::new(command);
    if p.is_absolute() {
        return p.to_path_buf();
    }
    if command.contains(['/', '\\']) {
        return cwd.join(p);
    }
    let path = claude::child_path().or_else(|| std::env::var_os("PATH"));
    which::which_in(command, path, cwd).unwrap_or_else(|_| p.to_path_buf())
}

/// Reads the newest messages of each chat, one result per chat id, starting the server once and
/// killing it (and everything it started) at the end.
pub async fn read_teams(spec: &ServerSpec, chat_ids: &[String]) -> Vec<Result<Vec<ChatMessage>, ReadError>> {
    let every = |e: ReadError| vec![Err(e); chat_ids.len()];
    let mut c = claude::command(&program(&spec.command, &spec.cwd));
    c.args(&spec.args)
        .current_dir(&spec.cwd)
        .envs(spec.env.iter().map(|(k, v)| (k, v)))
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .kill_on_drop(true);
    #[cfg(unix)]
    c.process_group(0);
    let mut child = match c.spawn() {
        Ok(child) => child,
        Err(e) => return every(ReadError::Failed(format!("could not start {}: {e}", spec.name))),
    };
    let pid = child.id();
    let (Some(stdin), Some(stdout)) = (child.stdin.take(), child.stdout.take()) else {
        return every(ReadError::Failed(format!("could not talk to {}", spec.name)));
    };
    let mut session = Session { stdin, lines: BufReader::new(stdout).lines(), next_id: 0 };
    let out = match tokio::time::timeout(READ_LIMIT, session.read(&spec.name, chat_ids)).await {
        Ok(out) => out,
        Err(_) => every(ReadError::Failed(format!("{} did not answer within a minute", spec.name))),
    };
    drop(session);
    if let Some(pid) = pid {
        claude::kill_tree(pid);
    }
    let _ = tokio::time::timeout(Duration::from_secs(5), child.wait()).await;
    out
}

/// One JSON-RPC conversation over newline-delimited stdio.
struct Session {
    stdin: ChildStdin,
    lines: Lines<BufReader<ChildStdout>>,
    next_id: u64,
}

impl Session {
    async fn send(&mut self, msg: Value) -> Result<(), String> {
        let line = format!("{msg}\n");
        self.stdin.write_all(line.as_bytes()).await.map_err(|e| e.to_string())?;
        self.stdin.flush().await.map_err(|e| e.to_string())
    }

    /// Sends a request and waits for its response, skipping log lines, notifications and the
    /// server's own requests.
    async fn call(&mut self, method: &str, params: Value) -> Result<Value, String> {
        self.next_id += 1;
        let id = self.next_id;
        self.send(json!({ "jsonrpc": "2.0", "id": id, "method": method, "params": params })).await?;
        loop {
            let line = self.lines.next_line().await.map_err(|e| e.to_string())?.ok_or("the server stopped")?;
            let Ok(v) = serde_json::from_str::<Value>(&line) else { continue };
            if v.get("method").is_some() || v.get("id").and_then(|i| i.as_u64()) != Some(id) {
                continue;
            }
            if let Some(e) = v.get("error") {
                return Err(e.get("message").and_then(|m| m.as_str()).unwrap_or("error").to_string());
            }
            return Ok(v.get("result").cloned().unwrap_or(Value::Null));
        }
    }

    async fn lists_chat_messages(&mut self) -> Result<bool, String> {
        let mut cursor: Option<String> = None;
        for _ in 0..10 {
            let params = match &cursor {
                Some(c) => json!({ "cursor": c }),
                None => json!({}),
            };
            let page = self.call("tools/list", params).await?;
            if page["tools"].as_array().into_iter().flatten().any(|t| t["name"] == "list-chat-messages") {
                return Ok(true);
            }
            cursor = page["nextCursor"].as_str().map(String::from);
            if cursor.is_none() {
                break;
            }
        }
        Ok(false)
    }

    async fn read(&mut self, server: &str, chat_ids: &[String]) -> Vec<Result<Vec<ChatMessage>, ReadError>> {
        let every = |e: ReadError| vec![Err(e); chat_ids.len()];
        let hello = json!({ "protocolVersion": "2025-06-18", "capabilities": {}, "clientInfo": { "name": "omega-star", "version": env!("CARGO_PKG_VERSION") } });
        if let Err(e) = self.call("initialize", hello).await {
            return every(ReadError::Failed(format!("{server} did not start: {e}")));
        }
        if let Err(e) = self.send(json!({ "jsonrpc": "2.0", "method": "notifications/initialized" })).await {
            return every(ReadError::Failed(format!("{server} did not start: {e}")));
        }
        match self.lists_chat_messages().await {
            Ok(true) => {}
            Ok(false) => return every(ReadError::Unsupported(format!("{server} has no list-chat-messages tool"))),
            Err(e) => return every(ReadError::Failed(format!("{server} did not list its tools: {e}"))),
        }
        let mut out = vec![];
        for chat in chat_ids {
            let args = json!({ "chatId": chat, "top": NEWEST, "orderby": "createdDateTime desc", "select": "id,createdDateTime,messageType,from,body" });
            out.push(match self.call("tools/call", json!({ "name": "list-chat-messages", "arguments": args })).await {
                Err(e) => Err(ReadError::Failed(e)),
                Ok(r) if r["isError"].as_bool().unwrap_or(false) => Err(ReadError::Failed(clip(&claude::result_text(&r["content"]), 300))),
                Ok(r) => chat_messages(&claude::result_text(&r["content"])).map_err(ReadError::Failed),
            });
        }
        out
    }
}

/// The messages in a `list-chat-messages` result (Graph's `{ "value": [...] }`), leaving out system
/// events.
fn chat_messages(text: &str) -> Result<Vec<ChatMessage>, String> {
    let v: Value = serde_json::from_str(text.trim()).map_err(|_| format!("unexpected answer: {}", clip(text, 200)))?;
    let list = v["value"].as_array().ok_or_else(|| format!("unexpected answer: {}", clip(text, 200)))?;
    Ok(list
        .iter()
        .filter(|m| m["messageType"] == "message")
        .filter_map(|m| {
            let at = DateTime::parse_from_rfc3339(m["createdDateTime"].as_str()?).ok()?.with_timezone(&Utc);
            let from = &m["from"];
            let name = from["user"]["displayName"].as_str().or(from["application"]["displayName"].as_str()).unwrap_or("");
            let content = m["body"]["content"].as_str().unwrap_or("");
            let text = if m["body"]["contentType"] == "html" { html_to_text(content) } else { content.trim().to_string() };
            Some(ChatMessage { id: m["id"].as_str()?.to_string(), at, from_id: from["user"]["id"].as_str().map(String::from), from_name: name.to_string(), text })
        })
        .collect())
}

const BLOCKS: &[&str] = &["p", "div", "li", "tr", "h1", "h2", "h3", "h4", "h5", "h6", "blockquote", "pre", "ul", "ol", "table"];

/// Teams HTML as plain text: tags dropped, line breaks and block ends as newlines, common entities decoded.
fn html_to_text(html: &str) -> String {
    let mut text = String::new();
    let mut rest = html;
    while let Some(i) = rest.find('<') {
        text.push_str(&rest[..i]);
        let Some(len) = rest[i..].find('>') else {
            text.push_str(&rest[i..]);
            rest = "";
            break;
        };
        let tag = rest[i + 1..i + len].trim().to_lowercase();
        let closing = tag.starts_with('/');
        let name = tag.trim_start_matches('/').split(|c: char| c.is_whitespace() || c == '/').next().unwrap_or("");
        if name == "br" || (closing && BLOCKS.contains(&name)) {
            text.push('\n');
        }
        rest = &rest[i + len + 1..];
    }
    text.push_str(rest);
    let decoded = decode_entities(&text);
    let mut out = String::new();
    let mut blank = 0;
    for line in decoded.lines().map(str::trim_end) {
        blank = if line.trim().is_empty() { blank + 1 } else { 0 };
        if blank < 2 {
            out.push_str(line);
            out.push('\n');
        }
    }
    out.trim().to_string()
}

fn decode_entities(s: &str) -> String {
    let mut out = String::new();
    let mut rest = s;
    while let Some(i) = rest.find('&') {
        out.push_str(&rest[..i]);
        let tail = &rest[i..];
        let entity = tail.find(';').filter(|&j| j <= 10).map(|j| (&tail[1..j], j));
        let decoded = entity.and_then(|(name, j)| {
            let c = match name {
                "amp" => Some('&'),
                "lt" => Some('<'),
                "gt" => Some('>'),
                "quot" => Some('"'),
                "apos" => Some('\''),
                "nbsp" => Some(' '),
                n if n.starts_with("#x") || n.starts_with("#X") => u32::from_str_radix(&n[2..], 16).ok().and_then(char::from_u32),
                n if n.starts_with('#') => n[1..].parse().ok().and_then(char::from_u32),
                _ => None,
            };
            c.map(|c| (c, j))
        });
        match decoded {
            Some((c, j)) => {
                out.push(c);
                rest = &tail[j + 1..];
            }
            None => {
                out.push('&');
                rest = &tail[1..];
            }
        }
    }
    out.push_str(rest);
    out
}
