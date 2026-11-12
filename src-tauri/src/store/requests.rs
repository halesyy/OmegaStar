//! Requests to people, the runs made about them, and the checks employees set for later.

use super::*;

#[derive(Default)]
pub struct RequestFilter {
    pub person_id: Option<String>,
    pub employee_id: Option<String>,
    pub state: Option<RequestState>,
}

/// The kinds of run made about a request, which `active_run_for` and `has_run_for` look up.
#[derive(Clone, Copy)]
pub enum RequestRun {
    ReplyCheck,
    Nudge,
    Unanswered,
}

impl RequestRun {
    /// Its `RunKind`'s serde `type` tag, as the run's JSON stores it.
    pub(super) fn tag(self) -> &'static str {
        match self {
            RequestRun::ReplyCheck => "replyCheck",
            RequestRun::Nudge => "nudge",
            RequestRun::Unanswered => "unanswered",
        }
    }
}

impl Store {
    // ---- human requests ----

    pub fn save_request(&self, r: &HumanRequest) -> Result<()> {
        self.conn.execute(
            "INSERT INTO requests(id, person_id, employee_id, state, created_at, data) VALUES (?1, ?2, ?3, ?4, ?5, ?6)
             ON CONFLICT(id) DO UPDATE SET state = ?4, data = ?6",
            params![r.id, r.person_id, r.employee_id, r.state.as_str(), ms(r.created_at), to_json(r)?],
        )?;
        Ok(())
    }

    pub fn request(&self, id: &str) -> Result<Option<HumanRequest>> {
        Ok(self
            .conn
            .query_row("SELECT data FROM requests WHERE id = ?", [id], |r| from_row(r, 0))
            .optional()?)
    }

    /// Open requests Omega Star is watching for a reply, oldest first.
    pub fn watched_requests(&self) -> Result<Vec<HumanRequest>> {
        self.requests_where("WHERE state = 'open' AND json_valid(data) AND json_extract(data, '$.delivery.watch.phase.type') = 'watching'", &[])
    }

    /// The requests a run made, oldest first.
    pub fn requests_of_run(&self, run_id: &str) -> Result<Vec<HumanRequest>> {
        self.requests_where("WHERE json_valid(data) AND json_extract(data, '$.runId') = ?", &[&run_id])
    }

    fn requests_where(&self, clause: &str, p: &[&dyn rusqlite::ToSql]) -> Result<Vec<HumanRequest>> {
        let mut st = self.conn.prepare(&format!("SELECT data FROM requests {clause} ORDER BY created_at, rowid"))?;
        let v = readable("requests", st.query_map(p, |r| from_row(r, 0))?)?;
        Ok(v)
    }

    /// The queued or running run of `kind` about a request.
    pub fn active_run_for(&self, request_id: &str, kind: RequestRun) -> Result<Option<Run>> {
        Ok(self
            .runs_where(
                "WHERE state IN ('queued', 'running') AND json_valid(data) AND json_extract(data, '$.kind.type') = ? AND json_extract(data, '$.kind.requestId') = ? LIMIT 1",
                &[&kind.tag(), &request_id],
            )?
            .into_iter()
            .next())
    }

    /// Whether a run of `kind` about a request was ever made, in any state.
    pub fn has_run_for(&self, request_id: &str, kind: RequestRun) -> Result<bool> {
        Ok(self
            .conn
            .query_row(
                "SELECT 1 FROM runs WHERE json_valid(data) AND json_extract(data, '$.kind.type') = ? AND json_extract(data, '$.kind.requestId') = ? LIMIT 1",
                [kind.tag(), request_id],
                |_| Ok(()),
            )
            .optional()?
            .is_some())
    }

    pub fn requests(&self, f: &RequestFilter) -> Result<Vec<HumanRequest>> {
        let mut st = self.conn.prepare(
            "SELECT data FROM requests WHERE (?1 IS NULL OR person_id = ?1) AND (?2 IS NULL OR employee_id = ?2)
             AND (?3 IS NULL OR state = ?3) ORDER BY created_at DESC, rowid DESC",
        )?;
        let v = readable("requests", st.query_map(params![f.person_id, f.employee_id, f.state.map(|s| s.as_str())], |r| from_row(r, 0))?)?;
        Ok(v)
    }

    // ---- checks ----

    pub fn save_check(&self, c: &Check) -> Result<()> {
        self.conn.execute(
            "INSERT INTO checks(id, employee_id, state, due_at, created_at, data) VALUES (?1, ?2, ?3, ?4, ?5, ?6)
             ON CONFLICT(id) DO UPDATE SET state = ?3, due_at = ?4, data = ?6",
            params![c.id, c.employee_id, c.state.as_str(), ms(c.due_at), ms(c.created_at), to_json(c)?],
        )?;
        Ok(())
    }

    pub fn check(&self, id: &str) -> Result<Option<Check>> {
        Ok(self.conn.query_row("SELECT data FROM checks WHERE id = ?", [id], |r| from_row(r, 0)).optional()?)
    }

    /// Soonest due first; open ones by date, finished ones newest first.
    pub fn checks(&self, employee_id: &str, state: Option<CheckState>) -> Result<Vec<Check>> {
        let mut st = self.conn.prepare(
            "SELECT data FROM checks WHERE employee_id = ?1 AND (?2 IS NULL OR state = ?2)
             ORDER BY (state = 'open') DESC, CASE WHEN state = 'open' THEN due_at END ASC, created_at DESC",
        )?;
        let v = readable("checks", st.query_map(params![employee_id, state.map(|s| s.as_str())], |r| from_row(r, 0))?)?;
        Ok(v)
    }

    /// Open checks due by `now` whose run has not been made yet, oldest first. A check's run is the
    /// Scheduled run of schedule_id check:<id> at slot due_at, so each due date runs once.
    pub fn checks_to_run(&self, now: Ts) -> Result<Vec<Check>> {
        let mut st = self.conn.prepare(
            "SELECT data FROM checks c WHERE state = 'open' AND due_at <= ?1
               AND NOT EXISTS (SELECT 1 FROM runs WHERE runs.schedule_id = 'check:' || c.id AND runs.slot = c.due_at)
             ORDER BY due_at",
        )?;
        let v = readable("checks", st.query_map([ms(now)], |r| from_row(r, 0))?)?;
        Ok(v)
    }
}
