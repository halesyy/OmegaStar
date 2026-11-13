//! Schedules and the checks employees set for themselves.

use super::*;
use serde::{Deserialize, Serialize, Serializer};

#[derive(Debug, Clone, Copy, Default, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum Misfire {
    #[default]
    CatchUp,
    Skip,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ScheduleDraft {
    #[serde(default)]
    pub id: Option<String>,
    pub employee_id: String,
    pub label: String,
    pub cron: String,
    pub instruction: String,
    pub enabled: bool,
    /// Quiet routines reach the Inbox only when the run calls `notify` or does not succeed.
    #[serde(default)]
    pub quiet: bool,
    /// The model and effort the routine runs on; `None` = the employee's own.
    #[serde(default)]
    pub model: Option<String>,
    #[serde(default)]
    pub effort: Option<Effort>,
    /// Only during business hours: a slot outside them is skipped.
    #[serde(default)]
    pub active_hours: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Schedule {
    pub id: String,
    pub employee_id: String,
    pub label: String,
    pub cron: String,
    pub instruction: String,
    pub enabled: bool,
    /// Kept only so older builds, which require it, can read schedules this build saves. Always CatchUp; nothing reads it.
    #[serde(default)]
    pub misfire: Misfire,
    #[serde(default)]
    pub quiet: bool,
    #[serde(default)]
    pub model: Option<String>,
    #[serde(default)]
    pub effort: Option<Effort>,
    /// The weekly review Omega Star seeds for every employee.
    #[serde(default)]
    pub review: bool,
    /// Runs only during business hours (`WatchSettings::hours`): a slot outside them is skipped, not caught up.
    #[serde(default)]
    pub active_hours: bool,
    /// Computed on read, never stored.
    #[serde(default)]
    pub next_fire: Option<Ts>,
}

impl Schedule {
    pub fn draft(&self) -> ScheduleDraft {
        ScheduleDraft {
            id: Some(self.id.clone()),
            employee_id: self.employee_id.clone(),
            label: self.label.clone(),
            cron: self.cron.clone(),
            instruction: self.instruction.clone(),
            enabled: self.enabled,
            quiet: self.quiet,
            model: self.model.clone(),
            effort: self.effort,
            active_hours: self.active_hours,
        }
    }
}

#[derive(Debug, Clone, PartialEq)]
pub enum CronPreview {
    Ok { description: String, next: Vec<Ts> },
    Err { error: String },
}

impl Serialize for CronPreview {
    fn serialize<S: Serializer>(&self, s: S) -> std::result::Result<S::Ok, S::Error> {
        let v = match self {
            CronPreview::Ok { description, next } => {
                serde_json::json!({ "ok": true, "description": description, "next": next })
            }
            CronPreview::Err { error } => serde_json::json!({ "ok": false, "error": error }),
        };
        v.serialize(s)
    }
}

/// The schedule_id prefix of a due check's run (see `RunKind::check_id`).
pub const CHECK_PREFIX: &str = "check:";

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum CheckState {
    Open,
    Done,
    /// The person you work for, or a tidy, decided it no longer matters.
    Dropped,
}

impl CheckState {
    pub fn as_str(self) -> &'static str {
        match self {
            CheckState::Open => "open",
            CheckState::Done => "done",
            CheckState::Dropped => "dropped",
        }
    }
}

/// Something an employee said they would look at again, tracked so it is not left as a sentence in a
/// file. An open check past its date starts a run of its own, see `Office::tick`.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Check {
    pub id: String,
    pub employee_id: String,
    /// What to find out.
    pub what: String,
    /// Where or how to find out: a command, a page, who to ask.
    pub how: String,
    pub due_at: Ts,
    pub state: CheckState,
    pub created_at: Ts,
    /// The run that set it.
    pub run_id: Option<String>,
    pub closed_at: Option<Ts>,
    /// What was found, once done.
    pub result: Option<String>,
}

#[cfg(test)]
mod tests {
    use super::*;

    fn schedule_json(misfire: Option<&str>) -> String {
        let misfire = misfire.map(|m| format!(r#","misfire":"{m}""#)).unwrap_or_default();
        format!(r#"{{"id":"s1","employeeId":"e1","label":"Sweep","cron":"0 9 * * *","instruction":"Look","enabled":true{misfire}}}"#)
    }

    #[test]
    fn schedules_read_old_misfire_values_and_save_catch_up() {
        let skip: Schedule = serde_json::from_str(&schedule_json(Some("skip"))).unwrap();
        assert_eq!(skip.misfire, Misfire::Skip);
        let none: Schedule = serde_json::from_str(&schedule_json(None)).unwrap();
        assert_eq!(none.misfire, Misfire::CatchUp);
        assert_eq!((none.model, none.effort, none.review), (None, None, false));
        let saved = serde_json::to_string(&Schedule { misfire: Misfire::CatchUp, ..skip }).unwrap();
        assert!(saved.contains(r#""misfire":"catchUp""#), "{saved}");
    }
}
