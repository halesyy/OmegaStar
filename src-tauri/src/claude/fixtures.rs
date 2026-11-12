//! What the prompt tests share: Ada, an analyst at Acme, and runs of every kind.

use super::*;
use crate::fixtures::{self, scheduled};

pub(super) fn ada() -> Employee {
    Employee { id: "e1".into(), title: "Analyst".into(), objective: "Keep the numbers right.".into(), ..fixtures::employee() }
}

pub(super) fn acme() -> Company {
    Company { name: "Acme".into(), ceo_name: "Pat".into(), ..Company::unset() }
}

pub(super) fn snapshot(opening: Option<Opening>, resume: bool) -> Snapshot {
    test_snapshot(acme(), ada(), opening, resume)
}

pub(super) fn now_opening(since: Option<Ts>) -> Opening {
    Opening { now: chrono::Utc::now(), since, ..Opening::default() }
}

/// A finished run of Ada's, `mins` minutes ago.
pub(super) fn done(kind: RunKind, mins: i64, summary: &str) -> Run {
    let at = chrono::Utc::now() - chrono::Duration::minutes(mins);
    let mut r = Run::new("e1", kind, "Go.".into(), at);
    r.state = RunState::Succeeded;
    r.started_at = Some(at);
    r.ended_at = Some(at);
    r.summary = Some(summary.into());
    r
}

/// Ada, an analyst at Acme who works for Pat, with nothing else around her.
pub(super) fn snap() -> Snapshot {
    snapshot(None, false)
}

pub(super) fn run(kind: RunKind) -> Run {
    Run::new("e1", kind, "Go.".into(), chrono::Utc::now())
}

/// The handbook and the system prompt of every kind of run, with someone in every section.
pub(super) fn every_text() -> Vec<String> {
    let mut s = snap();
    s.counterpart = Some(("Bo".into(), "Ops".into()));
    s.source = Some("This began with Pat's own message to Mo.".into());
    s.colleagues = vec![Colleague { name: "Bo".into(), slug: "bo".into(), title: "Ops".into(), objective: "Ship.".into(), description: "Knows the warehouse.".into() }];
    s.reports = vec![Report { name: "Cy".into(), slug: "cy".into(), title: "Clerk".into(), objective: "File.".into() }];
    s.people = vec![Person { id: "p1".into(), ..fixtures::person() }];
    let request = |kind: fn(String, String) -> RunKind| kind("q1".into(), "p1".into());
    let kinds = vec![
        RunKind::Manual,
        RunKind::Chat,
        scheduled("s1", true),
        scheduled("s1", false),
        scheduled("check:c1", true),
        RunKind::Delegated { parent_run_id: "r0".into() },
        RunKind::Asked { parent_run_id: "r0".into(), asked_by: "e2".into(), task: true },
        RunKind::Asked { parent_run_id: "r0".into(), asked_by: "e2".into(), task: false },
        RunKind::Answered { asked_run_id: "r0".into(), from: "e2".into(), task: true, chat: false, thread: None },
        RunKind::Answered { asked_run_id: "r0".into(), from: "e2".into(), task: false, chat: true, thread: None },
        RunKind::Answered { asked_run_id: "r0".into(), from: "e2".into(), task: false, chat: false, thread: Some("t1".into()) },
        request(|request_id, person_id| RunKind::FollowUp { request_id, person_id }),
        RunKind::Organize { imported: vec![], settled: false },
        RunKind::Tidy { reason: TidyReason::Auto, signature: vec![], plan: None },
        RunKind::Tidy { reason: TidyReason::Approved, signature: vec![], plan: Some("Merge two skills.".into()) },
        RunKind::Reply { to_run_id: "r0".into(), label: "Sweep".into(), task: false, card: true },
        RunKind::Reply { to_run_id: "r0".into(), label: "Sweep".into(), task: true, card: false },
        RunKind::Task { label: "Draft it".into(), from: None, context: String::new() },
        RunKind::Task { label: "Draft it".into(), from: Some("your chat".into()), context: "- 2:15 pm, Pat: Hi.\n".into() },
        RunKind::HireDecided { proposal_id: "h1".into(), approved: true },
        request(|request_id, person_id| RunKind::ReplyCheck { request_id, person_id }),
        request(|request_id, person_id| RunKind::Nudge { request_id, person_id }),
        request(|request_id, person_id| RunKind::Unanswered { request_id, person_id }),
    ];
    let mut texts = vec![handbook(&s)];
    texts.extend(kinds.into_iter().map(|k| system_prompt(&s, &run(k))));
    let check_back = Run { check: Some("c1".into()), ..run(RunKind::Reply { to_run_id: "r0".into(), label: "Sweep".into(), task: true, card: false }) };
    texts.push(system_prompt(&s, &check_back));
    texts
}
