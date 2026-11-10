//! Test fixtures shared across the crate's test modules. Tests change what they need with struct update syntax.

use crate::model::{Clearance, Employee, HumanRequest, Person, PersonManager, Run, RunEvent, RunKind, SkillGrant};
use crate::office::EventSink;

/// A sink for an Office in tests, which drops every event.
pub struct NoSink;

impl EventSink for NoSink {
    fn org_changed(&self) {}
    fn run_updated(&self, _run: &Run) {}
    fn run_events(&self, _run_id: &str, _events: &[RunEvent]) {}
    fn request_updated(&self, _request: &HumanRequest) {}
}

/// Ada, a tester who reports to you, with a fresh id and nothing granted.
pub fn employee() -> Employee {
    Employee {
        id: uuid::Uuid::new_v4().to_string(),
        slug: "ada".into(),
        name: "Ada".into(),
        title: "Tester".into(),
        description: String::new(),
        objective: String::new(),
        manager_id: None,
        skills: SkillGrant::default(),
        clearance: Clearance::Supervised,
        allow_rules: vec![],
        model: None,
        effort: None,
        browser: false,
        auto_tidy: false,
        workspaces: vec![],
        hue: 0,
        image: None,
        chat_session: "chat-ada".into(),
        hired_at: chrono::Utc::now(),
    }
}

/// Sam, a bookkeeper who reports to you, with a fresh id.
pub fn person() -> Person {
    Person {
        id: uuid::Uuid::new_v4().to_string(),
        name: "Sam".into(),
        title: "Bookkeeper".into(),
        description: String::new(),
        strengths: String::new(),
        responsibilities: String::new(),
        channels: vec![],
        notes: String::new(),
        manager: PersonManager::You,
        hue: 0,
        image: None,
        added_at: chrono::Utc::now(),
    }
}

/// A slot of the "Inbox sweep" schedule `id`, due now.
pub fn scheduled(id: &str, quiet: bool) -> RunKind {
    RunKind::Scheduled { schedule_id: id.into(), slot: chrono::Utc::now(), label: "Inbox sweep".into(), quiet, model: None, effort: None, review: false }
}
