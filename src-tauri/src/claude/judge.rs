//! Judging whether a person's reply answers an open request: one bare, schema-bound haiku turn.

use super::*;

/// The judge's answer: one verdict and a one-line note.
const JUDGE_SCHEMA: &str = r#"{"type":"object","properties":{"verdict":{"type":"string","enum":["answered","done","askedBack","acknowledged","noReply"]},"note":{"type":"string"}},"required":["verdict","note"],"additionalProperties":false}"#;

const JUDGE_LIMIT: Duration = Duration::from_secs(120);

/// One message the judge reads. `sender`: written by the account that sent the ask.
pub struct Said {
    pub at: Ts,
    pub from: String,
    pub sender: bool,
    pub text: String,
}

/// What the judge is asked: the ask, the messages since, and what each verdict means.
pub fn judge_prompt(ask: &str, kind: RequestKind, asker: &str, person: &str, sent_at: Ts, messages: &[Said]) -> String {
    let when = |t: Ts| t.with_timezone(&chrono::Local).format("%-d %b %-I:%M %P").to_string();
    let kind = kind.as_str();
    let lines: Vec<String> = messages
        .iter()
        .map(|m| format!("- {}, {}{}: {}", when(m.at), m.from, if m.sender { " (sending account)" } else { "" }, clip(&one_line(&m.text), 1000)))
        .collect();
    format!(
        "{asker} (an AI employee) asked {person}, a person on the team, a {kind} on Teams. Decide whether {person}'s messages \
since then respond to it.\n\n\
The ask (a {kind}, sent {sent}):\n{ask}\n\n\
Messages in the chat since the ask, oldest first. Lines marked \"(sending account)\" come from the account that sent the ask: \
the person {asker} works for, or an agent typing as them. They are never {person}'s reply.\n{lines}\n\n\
Verdicts:\n\
- answered: {person}'s messages answer the question.\n\
- done: {person} says the task is done.\n\
- askedBack: {person} asks something that must be answered before they can answer or act.\n\
- acknowledged: {person} saw the ask and says they will get to it, without answering or finishing it.\n\
- noReply: nothing {person} wrote is about this ask.\n\
Give the verdict and a one-line note of what {person} said about the ask.",
        sent = when(sent_at),
        ask = ask.trim(),
        lines = lines.join("\n"),
    )
}

/// One bare model turn: no employee, no tools, no MCP servers, no saved session.
fn judge_args() -> Vec<String> {
    ["-p", "--model", "haiku", "--effort", "low", "--tools", "", "--strict-mcp-config", "--no-session-persistence", "--output-format", "json", "--json-schema", JUDGE_SCHEMA]
        .map(String::from)
        .to_vec()
}

/// The verdict in a judge's stdout: one JSON result whose `structured_output` holds it.
fn parse_judge(stdout: &str) -> Result<(Verdict, String)> {
    let v = serde_json::from_str::<Value>(stdout.trim())
        .ok()
        .or_else(|| stdout.lines().rev().find_map(|l| serde_json::from_str::<Value>(l.trim()).ok().filter(|v| v.is_object())))
        .ok_or_else(|| AppError::internal(format!("the judge gave no result: {}", clip(stdout, 200))))?;
    if v["is_error"].as_bool().unwrap_or(false) {
        return Err(AppError::internal(format!("the judge failed: {}", clip(v["result"].as_str().unwrap_or(""), 300))));
    }
    let out = match &v["structured_output"] {
        o @ Value::Object(_) => o.clone(),
        _ => serde_json::from_str(v["result"].as_str().unwrap_or("")).unwrap_or(Value::Null),
    };
    let verdict: Verdict = serde_json::from_value(out["verdict"].clone()).map_err(|_| AppError::internal(format!("the judge gave no verdict: {}", clip(&v.to_string(), 200))))?;
    Ok((verdict, out["note"].as_str().unwrap_or("").trim().to_string()))
}

/// Asks the judge whether the messages in `prompt` answer the ask. `cwd` is an empty folder, so no
/// handbook or skills load. Never gated by usage room: one small call, and replies are time-sensitive.
pub async fn judge(program: &Path, env: &[(String, String)], cwd: &Path, prompt: &str) -> Result<(Verdict, String)> {
    let mut c = command(program);
    c.args(judge_args()).envs(env.iter().cloned()).current_dir(cwd).stdin(Stdio::piped()).stdout(Stdio::piped()).stderr(Stdio::piped());
    #[cfg(unix)]
    c.process_group(0);
    let mut child = c.spawn().map_err(|e| AppError::internal(format!("could not start Claude Code: {e}")))?;
    let pid = child.id();
    let (stdin, stdout, mut stderr) = (child.stdin.take(), child.stdout.take(), child.stderr.take());
    let errors = tokio::spawn(async move {
        let mut s = String::new();
        if let Some(e) = stderr.as_mut() {
            let _ = e.read_to_string(&mut s).await;
        }
        s
    });
    let talk = async move {
        if let Some(mut stdin) = stdin {
            let _ = stdin.write_all(prompt.as_bytes()).await;
            let _ = stdin.shutdown().await;
        }
        let mut out = String::new();
        if let Some(mut stdout) = stdout {
            let _ = stdout.read_to_string(&mut out).await;
        }
        out
    };
    let answered = tokio::time::timeout(JUDGE_LIMIT, talk).await;
    if answered.is_err() {
        if let Some(pid) = pid {
            kill_tree(pid);
        }
    }
    let _ = tokio::time::timeout(Duration::from_secs(5), child.wait()).await;
    let errors = tokio::time::timeout(Duration::from_secs(5), errors).await.ok().and_then(|e| e.ok()).unwrap_or_default();
    let Ok(out) = answered else {
        return Err(AppError::internal("the judge did not answer within two minutes"));
    };
    parse_judge(&out).map_err(|e| if errors.trim().is_empty() { e } else { AppError::internal(format!("{} ({})", e.message, clip(&one_line(&errors), 300))) })
}
