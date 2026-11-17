//! Questions and tasks to people, how they went out, and the watch for a reply.

use super::*;
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum RequestKind {
    Question,
    Task,
    /// An FYI: created done, never watched, never followed up.
    Info,
}

impl RequestKind {
    pub fn as_str(self) -> &'static str {
        match self {
            RequestKind::Question => "question",
            RequestKind::Task => "task",
            RequestKind::Info => "FYI",
        }
    }
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum RequestState {
    Open,
    Answered,
    Done,
    Cancelled,
}

impl RequestState {
    pub fn is_open(self) -> bool {
        matches!(self, RequestState::Open)
    }
    pub fn parse(s: &str) -> Result<Self> {
        serde_json::from_value(serde_json::Value::String(s.to_string()))
            .map_err(|_| AppError::invalid(format!("unknown request state '{s}'")))
    }
    pub fn as_str(self) -> &'static str {
        match self {
            RequestState::Open => "open",
            RequestState::Answered => "answered",
            RequestState::Done => "done",
            RequestState::Cancelled => "cancelled",
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct HumanRequest {
    pub id: String,
    pub person_id: String,
    pub employee_id: String,
    pub run_id: Option<String>,
    pub kind: RequestKind,
    pub message: String,
    pub due_at: Option<Ts>,
    pub channel_id: Option<String>,
    pub state: RequestState,
    pub response: Option<String>,
    pub created_at: Ts,
    pub resolved_at: Option<Ts>,
    /// How the ask went out. None for asks nobody reported sending.
    #[serde(default)]
    pub delivery: Option<Delivery>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Delivery {
    pub locator: Locator,
    /// The sending account (Teams `from.user.id`). Its messages are never a reply: the user and every agent type as it.
    #[serde(default)]
    pub sender_id: Option<String>,
    pub sent_at: Ts,
    /// The tool that sent it, e.g. `mcp__ms365-local__send-chat-message`.
    pub via: String,
    pub source: DeliverySource,
    /// None exactly for Info. Only `Delivery::new` builds one.
    #[serde(default)]
    pub watch: Option<Watch>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(tag = "type", rename_all = "camelCase", rename_all_fields = "camelCase")]
pub enum Locator {
    /// `server`: the employee's stdio MCP server the Office reads through; None = model checks instead.
    TeamsChat { chat_id: String, message_id: String, server: Option<String> },
    /// Anywhere else: the send's result or the employee's words, clipped to 300 chars.
    Other { text: String },
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum DeliverySource {
    /// The employee called `sent`.
    Employee,
    /// Found in the asking run's transcript.
    Transcript,
}

/// OmegaStar's watch on one delivered question or task. Only facts are stored; when the next check,
/// the nudge and the give-up fall is derived (`watch::plan`).
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Watch {
    pub phase: WatchPhase,
    /// Your last Resume; the clocks restart from it.
    #[serde(default)]
    pub resumed_at: Option<Ts>,
    #[serde(default)]
    pub last_checked_at: Option<Ts>,
    /// Consecutive failed checks.
    #[serde(default)]
    pub failures: u32,
    #[serde(default)]
    pub last_error: Option<String>,
    /// The newest message already judged; only later ones are judged.
    #[serde(default)]
    pub seen: Option<Seen>,
    /// The person's latest words about the ask and how they were read.
    #[serde(default)]
    pub heard: Option<Heard>,
    /// Any nudge, automatic or yours; the automatic one fires only while None.
    #[serde(default)]
    pub nudged_at: Option<Ts>,
    /// Filled on every read path by `Office::present`; never read back from storage.
    #[serde(skip_deserializing)]
    pub plan: Option<WatchPlan>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(tag = "type", rename_all = "camelCase", rename_all_fields = "camelCase")]
pub enum WatchPhase {
    Watching,
    /// You stopped it.
    Stopped { at: Ts },
    /// Nobody replied in time; the employee was told to go on without it. The request stays open.
    GaveUp { at: Ts },
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Seen {
    pub id: String,
    pub at: Ts,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Heard {
    pub at: Ts,
    pub from: String,
    /// Clipped to 500 characters.
    pub text: String,
    pub verdict: Verdict,
    pub note: String,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum Verdict {
    /// It answers the question.
    Answered,
    /// They did the task.
    Done,
    /// They asked something that must be answered first.
    AskedBack,
    /// They saw it and will get to it.
    Acknowledged,
    /// Nothing there is about this ask.
    NoReply,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct WatchPlan {
    pub next_check_at: Ts,
    pub nudge_at: Option<Ts>,
    pub give_up_at: Ts,
}

/// What you can do to a watched request from its card.
#[derive(Debug, Clone, Copy, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum WatchAction {
    Check,
    Nudge,
    Stop,
    Resume,
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::{json, Value};

    #[test]
    fn the_uis_state_args_deserialize() {
        let request = |v: Value| serde_json::from_value::<Option<RequestState>>(v).unwrap();
        assert_eq!(request(json!(null)), None);
        for (s, want) in [("open", RequestState::Open), ("answered", RequestState::Answered), ("done", RequestState::Done), ("cancelled", RequestState::Cancelled)] {
            assert_eq!(request(json!(s)), Some(want));
            assert_eq!(serde_json::from_value::<RequestState>(json!(s)).unwrap(), want);
        }
    }
}
