//! Tidy runs: queueing one by hand or on the auto-tidy tick, what it works from, and the bigger changes it proposes for
//! your OK.

use super::*;

/// The flag on a tidy that proposes changes: the Inbox shows it as the approval it waits on.
const PROPOSES: &str = "Proposes bigger changes that need your OK.";

impl Office {
    /// What a Tidy run works from; none for any other run.
    pub(super) fn tidy_brief(&self, run: &Run, e: &Employee) -> Result<Option<claude::TidyBrief>> {
        if !matches!(run.kind, RunKind::Tidy { .. }) {
            return Ok(None);
        }
        // An overdue check is work of its own, not something for the tidy to do.
        let findings = self.skill_health(&e.id)?.findings.into_iter().filter(|f| f.kind != HealthKind::OverdueCheck).collect();
        let db = self.db();
        // What you taught since the last tidy that got as far as confirming it.
        let since = db.tidy_runs(&e.id)?.into_iter().find(|r| r.id != run.id && r.state == RunState::Succeeded).map(|r| r.created_at);
        let taught = db.taught_since(&e.id, since, tidy::TAUGHT_LIMIT)?;
        Ok(Some(claude::TidyBrief { findings, taught }))
    }

    /// A finished tidy goes to your Inbox only when it proposes changes that need your OK. Everything else it
    /// did is in the Archive, and every change can be reverted.
    pub(super) fn review_tidy(&self, run: &mut Run) {
        if run.proposed.is_some() {
            let name = self.db().employee(&run.employee_id).ok().flatten().map(|e| e.name).unwrap_or_default();
            run.needs_you.push(PROPOSES.into());
            self.sink().notify(&format!("{name} proposes tidy changes"), "Approve them from your Inbox.");
        }
    }

    /// Queues a tidy for the employee, unless one is already waiting or running.
    fn enqueue_tidy(&self, employee_id: &str, reason: TidyReason, why: &str, plan: Option<String>) -> Result<Run> {
        let signature = tidy::signature(&self.skill_health(employee_id)?.findings);
        {
            let db = self.db();
            let e = db.employee(employee_id)?.ok_or_else(|| AppError::not_found("employee not found"))?;
            if db.active_runs_of(employee_id)?.iter().any(|r| matches!(r.kind, RunKind::Tidy { .. })) {
                return Err(AppError::conflict(format!("{} is already tidying", e.name)));
            }
        }
        let prompt = match reason {
            TidyReason::Approved => "Make the changes you proposed and I approved.".to_string(),
            _ => format!("Tidy your skills and notes: {}.", why.trim_end_matches('.')),
        };
        let run = Run::new(employee_id, RunKind::Tidy { reason, signature, plan }, prompt, now());
        let session = run.id.clone();
        self.enqueue(run, session)
    }

    /// You asked for a tidy.
    pub fn tidy(&self, employee_id: &str) -> Result<Run> {
        self.enqueue_tidy(employee_id, TidyReason::Manual, "you asked for one", None)
    }

    /// You approved the bigger changes a tidy proposed: a second run makes exactly those. Asking about them first
    /// decides nothing. A proposal you archived waits until you reopen it, so one an older build approved (it left
    /// them archived, with no mark of their own) is never approved twice.
    pub fn approve_tidy(&self, run_id: &str) -> Result<Run> {
        let (run, plan) = {
            let db = self.db();
            let run = db.run(run_id)?.ok_or_else(|| AppError::not_found("run not found"))?.run;
            if !matches!(run.kind, RunKind::Tidy { .. }) {
                return Err(AppError::invalid("that run was not a tidy"));
            }
            if !run.state.is_finished() {
                return Err(AppError::conflict("wait for the tidy to finish"));
            }
            let plan = run.proposed.clone().filter(|p| !p.trim().is_empty()).ok_or_else(|| AppError::invalid("that tidy proposed nothing"))?;
            if run.approved_at.is_some() {
                return Err(AppError::conflict("you already approved that tidy"));
            }
            if run.archived_at.is_some() {
                return Err(AppError::conflict("that tidy is archived, so reopen it to approve it"));
            }
            (run, plan)
        };
        // Queue the follow-up first: if that fails, the proposal stays in the Inbox to try again.
        let approved = self.enqueue_tidy(&run.employee_id, TidyReason::Approved, "", Some(plan))?;
        let answered = {
            let db = self.db();
            let mut answered = db.run(run_id)?.map(|r| r.run).unwrap_or(run);
            answered.approved_at = Some(now());
            answered.archived_at = Some(now());
            db.save_run(&answered)?;
            answered
        };
        self.sink().run_updated(&answered);
        Ok(approved)
    }

    /// The employee's tidy runs, newest first, for the Skills tab.
    pub fn tidy_runs(&self, employee_id: &str) -> Result<Vec<Run>> {
        self.db().tidy_runs(employee_id)
    }

    /// One pass over the employees who tidy on their own: queue a tidy for each that is due. Real work
    /// comes first: nobody is tidied while busy, or while the plan's windows are nearly full.
    pub fn tidy_tick(&self, at: Ts) -> Result<usize> {
        if self.db().settings()?.map(|s| s.paused).unwrap_or(false) || !tidy::room_for_a_tidy(&lock(&self.0.usage)) {
            return Ok(0);
        }
        let mut queued = 0;
        let employees = self.db().employees()?;
        for e in employees.into_iter().filter(|e| e.auto_tidy) {
            let (busy, last, taught) = {
                let db = self.db();
                let runs = db.tidy_runs(&e.id)?;
                let since = runs.iter().find(|r| r.state == RunState::Succeeded).map(|r| r.created_at);
                (!db.active_runs_of(&e.id)?.is_empty(), runs.into_iter().next(), db.taught_since(&e.id, since, tidy::TAUGHT_LIMIT)?.len())
            };
            if busy {
                continue;
            }
            let findings = self.skill_health(&e.id)?.findings;
            let sizes = tidy::sizes(&self.employee_dir(&e.id), &e.slug, &findings);
            // A tidy that failed saw nothing through, so its findings still count as new.
            let seen: Vec<String> = match &last {
                Some(Run { kind: RunKind::Tidy { signature, .. }, state: RunState::Succeeded, .. }) => signature.clone(),
                _ => vec![],
            };
            let situation =
                tidy::Situation { now: at, findings: &findings, last: last.as_ref().map(|r| (r.created_at, seen.as_slice())), taught, slug: &e.slug, sizes: &sizes };
            if let Some(why) = tidy::due(&situation) {
                match self.enqueue_tidy(&e.id, TidyReason::Auto, &why, None) {
                    Ok(_) => queued += 1,
                    Err(err) => log!("queueing a tidy for {} failed: {err}", e.name),
                }
            }
        }
        Ok(queued)
    }

    /// The bigger changes a tidy proposes, recorded on its run for you to approve.
    pub fn propose_changes_tool(&self, caller_run: &str, plan: &str) -> Result<Value> {
        let plan = plan.trim();
        if plan.is_empty() {
            return Err(AppError::invalid("plan is empty"));
        }
        if !matches!(self.run(caller_run)?.kind, RunKind::Tidy { reason, .. } if reason != TidyReason::Approved) {
            return Err(AppError::invalid("propose_changes is only for a tidy run that has not been approved yet"));
        }
        let mut active = lock(&self.0.active);
        let a = active.get_mut(caller_run).ok_or_else(|| AppError::invalid("this run has ended"))?;
        match &mut a.proposed {
            Some(p) => {
                p.push_str("\n\n");
                p.push_str(plan);
            }
            None => a.proposed = Some(plan.to_string()),
        }
        Ok(json!({ "recorded": true, "note": "They see it in their Inbox with an Approve button. Do not make these changes in this run." }))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::fixtures::{self, open_office, temp_path};

    #[tokio::test]
    async fn a_question_about_a_tidys_proposal_leaves_it_to_approve() {
        let dir = temp_path("tidy-ok");
        let e = fixtures::employee();
        let proposal = |archived: bool| {
            let mut r = Run::new(&e.id, RunKind::Tidy { reason: TidyReason::Auto, signature: vec![], plan: None }, "Tidy your skills.".into(), now());
            r.state = RunState::Succeeded;
            r.ended_at = Some(now());
            r.proposed = Some("Split the long pricing skill in two.".into());
            r.needs_you = vec![PROPOSES.into()];
            // An older build marked its approval only by replying and archiving.
            if archived {
                r.replied_at = Some(now());
                r.archived_at = Some(now());
            }
            r
        };
        let (open, old) = (proposal(false), proposal(true));
        {
            fs::create_dir_all(&dir).unwrap();
            let db = Store::open(&dir.join("office.db")).unwrap();
            db.save_employee(&e).unwrap();
            db.set_held_until(Some(now() + chrono::Duration::hours(1))).unwrap();
            assert!(db.insert_run(&open, &open.id).unwrap());
            assert!(db.insert_run(&old, &old.id).unwrap());
        }
        let office = open_office(&dir).await;
        office.reply_to_run(&open.id, "Why split it?", false, vec![]).unwrap();
        let approved = office.approve_tidy(&open.id).unwrap();
        assert!(matches!(&approved.kind, RunKind::Tidy { reason: TidyReason::Approved, plan, .. } if *plan == open.proposed), "{:?}", approved.kind);
        let s = office.run(&open.id).unwrap();
        assert!(s.replied_at.is_some() && s.approved_at.is_some() && s.archived_at.is_some(), "approved after a question, and filed");
        assert_eq!(office.approve_tidy(&open.id).unwrap_err().message, "you already approved that tidy");
        assert_eq!(office.approve_tidy(&old.id).unwrap_err().message, "that tidy is archived, so reopen it to approve it");
        drop(office);
        let _ = fs::remove_dir_all(&dir);
    }
}
