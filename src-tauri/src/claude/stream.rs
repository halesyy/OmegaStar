//! Parsing Claude Code's stream-json output into run events.

use super::*;

pub struct Outcome {
    pub ok: bool,
    pub text: String,
    pub subtype: String,
    pub turns: u32,
    pub duration_ms: u64,
    pub denials: Vec<Denial>,
}

#[derive(Default)]
pub struct Parsed {
    pub events: Vec<RunEvent>,
    /// A `stream_event` partial: forwarded live, never stored.
    pub partial: bool,
    pub outcome: Option<Outcome>,
    /// Subscription usage reported by the run (`rate_limit_event`).
    pub usage: Option<UsageSample>,
}

/// One observation of the subscription usage windows. Both `None` means the account has none.
#[derive(Debug, Clone, PartialEq, Default)]
pub struct UsageSample {
    pub five_hour: Option<UsageWindow>,
    pub seven_day: Option<UsageWindow>,
}

fn percent_of(utilization: f64) -> f64 {
    ((utilization * 1000.0).round() / 10.0).clamp(0.0, 100.0)
}

/// Wraps a synthetic Office event as a transcript line, so replay needs only the transcript.
pub fn omega_line(ev: &RunEvent) -> String {
    json!({ "type": "omega", "event": ev }).to_string()
}

const BRIEF_KEYS: &[&str] = &[
    "command", "file_path", "notebook_path", "path", "pattern", "url", "query", "skill", "description", "prompt", "task", "person",
];
const PATH_KEYS: &[&str] = &["file_path", "notebook_path", "path"];

/// A file path as the UI shows it: relative to the employee's home when inside it, forward slashes,
/// no `\\?\` verbatim prefix.
fn display_path(path: &str, home: &Path) -> String {
    let norm = |s: &str| s.strip_prefix(r"\\?\").unwrap_or(s).replace('\\', "/");
    let path = norm(path);
    let home = norm(&home.to_string_lossy());
    let home = home.trim_end_matches('/');
    if !home.is_empty() && path.len() > home.len() + 1 && path.is_char_boundary(home.len()) {
        let (head, rest) = path.split_at(home.len());
        let same = if cfg!(windows) { head.eq_ignore_ascii_case(home) } else { head == home };
        if same && rest.starts_with('/') {
            return rest[1..].to_string();
        }
    }
    path
}

fn tool_brief(input: &Value, home: &Path) -> String {
    let s = match BRIEF_KEYS.iter().find_map(|k| input.get(k).and_then(|v| v.as_str()).map(|v| (*k, v))) {
        Some((k, v)) if PATH_KEYS.contains(&k) => display_path(v, home),
        Some((_, v)) => v.to_string(),
        None if input.as_object().map(|o| o.is_empty()).unwrap_or(true) => String::new(),
        None => input.to_string(),
    };
    clip(&one_line(&s), 160)
}

pub fn suggested_rule(tool: &str, input: &Value) -> String {
    match (tool, input.get("command").and_then(|c| c.as_str()).and_then(|c| c.split_whitespace().next())) {
        ("Bash", Some(word)) => format!("Bash({word}:*)"),
        _ => tool.to_string(),
    }
}

/// The rule that allows every tool of an MCP server: `mcp__claude-in-chrome__*` for
/// `mcp__claude-in-chrome__javascript_tool`. `None` for a tool that is not an MCP tool.
pub fn mcp_server_rule(tool: &str) -> Option<String> {
    let rest = tool.strip_prefix("mcp__")?;
    let (server, name) = rest.split_once("__")?;
    (!server.is_empty() && !name.is_empty()).then(|| format!("mcp__{server}__*"))
}

/// Every tool of the Claude in Chrome extension, which `--chrome` connects.
pub const CHROME_RULE: &str = "mcp__claude-in-chrome__*";

/// The text of a tool result, whether its content is a string or a list of text blocks.
pub fn result_text(content: &Value) -> String {
    match content {
        Value::String(s) => s.clone(),
        Value::Array(a) => a.iter().filter_map(|b| b.get("text").and_then(|t| t.as_str())).collect::<Vec<_>>().join("\n"),
        _ => String::new(),
    }
}

/// Parses one stream-json line. `home` is the employee directory, used to shorten file paths.
pub fn parse_line(line: &str, home: &Path) -> Parsed {
    let mut p = Parsed::default();
    let Ok(v) = serde_json::from_str::<Value>(line) else { return p };
    let str_at = |v: &Value, k: &str| v.get(k).and_then(|x| x.as_str()).unwrap_or("").to_string();
    // Subagent traffic (parent_tool_use_id set) stays in the raw transcript only.
    let nested = v.get("parent_tool_use_id").map(|x| !x.is_null()).unwrap_or(false);
    match v.get("type").and_then(|t| t.as_str()).unwrap_or("") {
        "stream_event" => {
            p.partial = true;
            let ev = &v["event"];
            if !nested && ev["type"] == "content_block_delta" && ev["delta"]["type"] == "text_delta" {
                p.events.push(RunEvent::TextDelta { text: str_at(&ev["delta"], "text") });
            }
        }
        "system" if v["subtype"] == "init" => {
            let skills = v["skills"].as_array().map(|a| a.iter().filter_map(|s| s.as_str().map(String::from)).collect()).unwrap_or_default();
            p.events.push(RunEvent::Init { model: str_at(&v, "model"), skills });
        }
        // Claude Code reports every background job as a task: sub-agents and shell commands alike, and
        // the ones a sub-agent starts too. Only the sub-agents the employee started are shown.
        "system" if v["subtype"] == "task_started" => {
            if v["task_type"] == "local_agent" && !v["owned_by_subagent"].as_bool().unwrap_or(false) {
                p.events.push(RunEvent::TaskStarted {
                    task_id: str_at(&v, "task_id"),
                    tool_use_id: str_at(&v, "tool_use_id"),
                    name: clip(&one_line(&str_at(&v, "description")), 120),
                });
            }
        }
        "system" if v["subtype"] == "task_progress" => {
            let u = &v["usage"];
            p.events.push(RunEvent::TaskProgress {
                task_id: str_at(&v, "task_id"),
                activity: clip(&one_line(&str_at(&v, "description")), 160),
                last_tool: v["last_tool_name"].as_str().filter(|t| !t.is_empty()).map(String::from),
                tool_uses: u["tool_uses"].as_u64().unwrap_or(0) as u32,
                tokens: u["total_tokens"].as_u64().unwrap_or(0),
                duration_ms: u["duration_ms"].as_u64().unwrap_or(0),
            });
        }
        "system" if v["subtype"] == "task_notification" => {
            let u = &v["usage"];
            p.events.push(RunEvent::TaskEnded {
                task_id: str_at(&v, "task_id"),
                outcome: match v["status"].as_str() {
                    Some("completed") => TaskOutcome::Done,
                    Some("failed" | "error") => TaskOutcome::Failed,
                    _ => TaskOutcome::Stopped,
                },
                tool_uses: u["tool_uses"].as_u64().unwrap_or(0) as u32,
                tokens: u["total_tokens"].as_u64().unwrap_or(0),
                duration_ms: u["duration_ms"].as_u64().unwrap_or(0),
            });
        }
        "assistant" if !nested => {
            for b in v["message"]["content"].as_array().into_iter().flatten() {
                match b["type"].as_str() {
                    Some("text") if !str_at(b, "text").trim().is_empty() => p.events.push(RunEvent::Text { text: str_at(b, "text") }),
                    Some("tool_use") => p.events.push(RunEvent::ToolCall {
                        id: str_at(b, "id"),
                        tool: str_at(b, "name"),
                        brief: tool_brief(&b["input"], home),
                    }),
                    _ => {}
                }
            }
        }
        "user" if !nested => {
            for b in v["message"]["content"].as_array().into_iter().flatten().filter(|b| b["type"] == "tool_result") {
                p.events.push(RunEvent::ToolResult {
                    id: str_at(b, "tool_use_id"),
                    ok: !b["is_error"].as_bool().unwrap_or(false),
                    brief: clip(&one_line(&result_text(&b["content"])), 200),
                });
            }
        }
        "result" => {
            let o = Outcome {
                ok: !v["is_error"].as_bool().unwrap_or(false) && v["subtype"] == "success",
                text: str_at(&v, "result"),
                subtype: str_at(&v, "subtype"),
                turns: v["num_turns"].as_u64().unwrap_or(0) as u32,
                duration_ms: v["duration_ms"].as_u64().unwrap_or(0),
                denials: v["permission_denials"]
                    .as_array()
                    .into_iter()
                    .flatten()
                    .map(|d| {
                        let tool = str_at(d, "tool_name");
                        Denial { brief: tool_brief(&d["tool_input"], home), suggested_rule: suggested_rule(&tool, &d["tool_input"]), tool }
                    })
                    .collect(),
            };
            p.events.push(RunEvent::Result {
                ok: o.ok,
                text: o.text.clone(),
                turns: o.turns,
                duration_ms: o.duration_ms,
            });
            p.outcome = Some(o);
        }
        "rate_limit_event" => {
            let windows = &v["rate_limit_info"]["unifiedWindows"];
            let window = |k: &str| {
                let w = &windows[k];
                Some(UsageWindow {
                    percent: percent_of(w["utilization"].as_f64()?),
                    resets_at: w["resetsAt"].as_i64().and_then(|s| chrono::DateTime::from_timestamp(s, 0)),
                    resets_text: None,
                })
            };
            let sample = UsageSample { five_hour: window("five_hour"), seven_day: window("seven_day") };
            if sample.five_hour.is_some() || sample.seven_day.is_some() {
                p.usage = Some(sample);
            }
        }
        "omega" => {
            if let Ok(ev) = serde_json::from_value::<RunEvent>(v["event"].clone()) {
                p.events.push(ev);
            }
        }
        _ => {}
    }
    p
}

/// Sorts the task events `parse_line` cannot judge from one line: a task's progress and end name only
/// its id, so whether it is a sub-agent is known from having seen it start.
#[derive(Default)]
pub struct TaskWatch {
    agents: std::collections::HashSet<String>,
}

impl TaskWatch {
    pub fn keep(&mut self, ev: &RunEvent) -> bool {
        match ev {
            RunEvent::TaskStarted { task_id, .. } => {
                self.agents.insert(task_id.clone());
                true
            }
            RunEvent::TaskProgress { task_id, .. } | RunEvent::TaskEnded { task_id, .. } => self.agents.contains(task_id),
            _ => true,
        }
    }
}

/// Keeps only the newest `TaskProgress` of each task: they arrive many times a second and each one
/// replaces the last.
pub fn coalesce_progress(events: &mut Vec<RunEvent>) {
    let mut newest = std::collections::HashMap::new();
    for (i, ev) in events.iter().enumerate() {
        if let RunEvent::TaskProgress { task_id, .. } = ev {
            newest.insert(task_id.clone(), i);
        }
    }
    let mut i = 0;
    events.retain(|ev| {
        let keep = match ev {
            RunEvent::TaskProgress { task_id, .. } => newest.get(task_id) == Some(&i),
            _ => true,
        };
        i += 1;
        keep
    });
}

/// Replays a stored transcript into the events the UI shows.
pub fn replay(transcript: &str, home: &Path) -> Vec<RunEvent> {
    let mut watch = TaskWatch::default();
    let mut events: Vec<RunEvent> = transcript
        .lines()
        .flat_map(|l| parse_line(l, home).events)
        .filter(|e| !matches!(e, RunEvent::TextDelta { .. }) && watch.keep(e))
        .collect();
    coalesce_progress(&mut events);
    events
}
