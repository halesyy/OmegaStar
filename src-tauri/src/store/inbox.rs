//! Runs read back as reports, reviews, asks, hand-offs, tasks, tidies and conversations, and news.

use super::*;

impl Store {
    /// The runs that may need you in the Inbox, not archived, newest first: those that reach you and might
    /// need you (`threads::could_need_you`). `roots` are the employees who report to you, `flagged` everyone.
    /// Reply runs never appear, nor answers that came back into a conversation: they belong to their thread (`reply_runs`).
    pub fn finished_root_runs(&self, roots: &[String], flagged: &[String]) -> Result<Vec<Run>> {
        self.reports(
            roots,
            flagged,
            None,
            "json_extract(data, '$.archivedAt') IS NULL
             AND CASE WHEN json_valid(data) THEN
                   COALESCE(json_array_length(data, '$.needsYou'), 0) > 0
                   OR (COALESCE(json_array_length(data, '$.denials'), 0) > 0 AND json_extract(data, '$.kind.type') IS NOT 'tidy')
                   OR state IN ('failed', 'lost')
                   OR json_extract(data, '$.repliedAt') IS NOT NULL
                   OR json_extract(data, '$.steered') = 1
                 ELSE 0 END",
            "created_at DESC, rowid DESC",
        )
    }

    /// Finished weekly reviews created since `since`, oldest first: the runs one team week's row gathers.
    pub fn review_runs(&self, since: Ts) -> Result<Vec<Run>> {
        self.runs_where(
            concat!("WHERE schedule_id IS NOT NULL AND json_valid(data) AND json_extract(data, '$.kind.review') = 1
               AND created_at >= ? AND state NOT IN ", active!(), "
             ORDER BY created_at, rowid"),
            &[&ms(since)],
        )
    }

    /// The number an employee's latest weekly review recorded, from the reviews among their schedules. A number
    /// this build cannot read counts as none.
    pub fn latest_score(&self, employee_id: &str) -> Result<Option<Score>> {
        let score: Option<String> = self
            .conn
            .query_row(
                "SELECT json_extract(data, '$.score') FROM runs
                 WHERE schedule_id IN (SELECT id FROM schedules WHERE employee_id = ?1 AND json_valid(data) AND json_extract(data, '$.review') = 1)
                   AND json_valid(data) AND json_type(data, '$.score') = 'object'
                 ORDER BY slot DESC LIMIT 1",
                [employee_id],
                |r| r.get(0),
            )
            .optional()?;
        Ok(score.and_then(|s| serde_json::from_str(&s).ok()))
    }

    /// An employee's newest report since `since`: a work run that succeeded with something to say, other than a
    /// turn of a conversation, a reply check, a nudge, a tidy or a quiet run that raised nothing.
    pub fn last_report(&self, employee_id: &str, since: Ts) -> Result<Option<Run>> {
        Ok(self
            .runs_where(
                "WHERE employee_id = ? AND created_at >= ? AND lane = 'work' AND state = 'succeeded' AND json_valid(data)
                   AND json_extract(data, '$.kind.type') NOT IN ('task', 'reply', 'replyCheck', 'nudge', 'tidy')
                   AND json_extract(data, '$.kind.thread') IS NULL
                   AND NOT (COALESCE(json_extract(data, '$.kind.quiet'), 0) = 1 AND COALESCE(json_array_length(data, '$.needsYou'), 0) = 0)
                   AND trim(COALESCE(json_extract(data, '$.summary'), '')) != ''
                 ORDER BY created_at DESC, rowid DESC LIMIT 1",
                &[&employee_id, &ms(since)],
            )?
            .pop())
    }

    /// The newest `limit` runs that reach you, as `finished_root_runs` picks them, archived or not: what the
    /// Archive reads for everything that reached you and needs nothing now.
    pub fn reached_root_runs(&self, roots: &[String], flagged: &[String], limit: u32) -> Result<Vec<Run>> {
        self.reports(roots, flagged, Some(limit), "1", "created_at DESC, rowid DESC")
    }

    /// The same runs once archived: the most recently archived `limit`, newest first.
    pub fn archived_root_runs(&self, employee_ids: &[String], limit: u32) -> Result<Vec<Run>> {
        self.reports(employee_ids, employee_ids, Some(limit), "json_extract(data, '$.archivedAt') IS NOT NULL", "json_extract(data, '$.archivedAt') DESC, rowid DESC")
    }

    /// A fast pre-filter for `threads::reaches_you` with `quiet_chain` false and `top` meaning one of
    /// `roots`, so the Inbox does not load every quiet run ever made. The Office still applies
    /// `reaches_you` to what comes back, and `the_inbox_query_matches_reaches_you` keeps the two equal.
    /// `json_valid` goes first, and again in the OR branch SQLite may run on its own: a JSON function on a
    /// row that is not JSON fails the whole query.
    fn reports(&self, roots: &[String], flagged: &[String], limit: Option<u32>, archived: &str, order: &str) -> Result<Vec<Run>> {
        let (roots, flagged) = (serde_json::to_string(roots)?, serde_json::to_string(flagged)?);
        self.runs_where(
            &format!(
                "WHERE json_valid(data)
                 AND lane = 'work'
                 AND json_extract(data, '$.kind.type') IS NOT 'reply'
                 AND json_extract(data, '$.kind.type') IS NOT 'replyCheck'
                 AND json_extract(data, '$.kind.type') IS NOT 'task'
                 AND NOT (json_extract(data, '$.kind.type') = 'answered' AND json_extract(data, '$.kind.thread') IS NOT NULL)
                 AND ((employee_id IN (SELECT value FROM json_each(?)) AND parent_run_id IS NULL)
                      OR (employee_id IN (SELECT value FROM json_each(?))
                          AND json_valid(data)
                          AND (COALESCE(json_array_length(data, '$.needsYou'), 0) > 0
                               OR (COALESCE(json_array_length(data, '$.denials'), 0) > 0 AND json_extract(data, '$.kind.type') IS NOT 'tidy')
                               OR (parent_run_id IS NOT NULL AND state IN ('failed', 'lost'))
                               OR json_extract(data, '$.kind.review') = 1
                               OR json_extract(data, '$.steered') = 1)))
                 AND state NOT IN {active}
                 AND NOT (json_extract(data, '$.kind.type') = 'nudge' AND state = 'cancelled')
                 AND NOT ((COALESCE(json_extract(data, '$.kind.quiet'), 0) = 1 OR json_extract(data, '$.kind.type') IN ('tidy', 'nudge'))
                          AND NOT (schedule_id LIKE {check} AND COALESCE(json_extract(data, '$.durationMs'), 0) > {long})
                          AND state = 'succeeded'
                          AND COALESCE(json_array_length(data, '$.needsYou'), 0) = 0
                          AND (COALESCE(json_array_length(data, '$.denials'), 0) = 0 OR json_extract(data, '$.kind.type') = 'tidy')
                          AND COALESCE(json_extract(data, '$.steered'), 0) = 0)
                 AND {archived}
                 ORDER BY {order} LIMIT ?",
                active = active!(),
                check = check_run!(),
                long = crate::threads::CHECK_QUIET_MS
            ),
            &[&roots, &flagged, &limit.map_or(-1, i64::from)],
        )
    }

    /// Colleague asks still in flight: queued or running, or answered while the asker's own run is
    /// still going and has not collected the answer yet. Oldest first.
    pub fn open_asks(&self) -> Result<Vec<Run>> {
        self.runs_where(
            concat!("WHERE json_valid(data)
               AND json_extract(data, '$.kind.type') = 'asked'
               AND (state IN ", active!(), "
                    OR (json_valid(data) AND json_extract(data, '$.deliveredAt') IS NULL
                        AND parent_run_id IN (SELECT id FROM runs WHERE state IN ", active!(), ")))
             ORDER BY created_at, rowid"),
            &[],
        )
    }

    /// Every run bringing back the answer or report of the hand-off `asked_run_id`, oldest first.
    pub fn answers_to(&self, asked_run_id: &str) -> Result<Vec<Run>> {
        self.runs_where(
            "WHERE json_valid(data) AND json_extract(data, '$.kind.type') = 'answered' AND json_extract(data, '$.kind.askedRunId') = ?
             ORDER BY created_at, rowid",
            &[&asked_run_id],
        )
    }

    /// Every hand-off (delegated or asked run) in the chain `chain` (`Run::chain`): who handed it over, to whom, when,
    /// and whether it was delegated work.
    pub fn chain_handoffs(&self, chain: &str) -> Result<Vec<(String, String, Ts, bool)>> {
        let mut st = self.conn.prepare(
            "SELECT p.employee_id, r.employee_id, r.created_at, json_extract(r.data, '$.kind.type') = 'delegated' FROM runs r JOIN runs p ON p.id = r.parent_run_id
             WHERE r.parent_run_id IS NOT NULL AND json_valid(r.data) AND json_extract(r.data, '$.chain') = ?",
        )?;
        let rows = st.query_map([chain], |r| Ok((r.get(0)?, r.get(1)?, Ts::from_timestamp_millis(r.get::<_, i64>(2)?).unwrap_or_default(), r.get(3)?)))?;
        Ok(rows.collect::<rusqlite::Result<_>>()?)
    }

    /// How many asks between `a` and `b`, either way, the loop guard paused since `since`: each paused one starts a
    /// chain of its own (`Run::chain`).
    pub fn paused_asks(&self, a: &str, b: &str, since: Ts) -> Result<u32> {
        Ok(self.conn.query_row(
            "SELECT COUNT(*) FROM runs r JOIN runs p ON p.id = r.parent_run_id
             WHERE r.created_at >= ?3 AND ((p.employee_id = ?1 AND r.employee_id = ?2) OR (p.employee_id = ?2 AND r.employee_id = ?1))
               AND json_valid(r.data) AND json_extract(r.data, '$.kind.type') = 'asked' AND json_extract(r.data, '$.chain') = r.id",
            params![a, b, ms(since)],
            |r| r.get(0),
        )?)
    }

    /// How many tasks `manager_id`'s runs handed `report_id` since `since`, leaving out the ones you stopped.
    pub fn delegated_since(&self, manager_id: &str, report_id: &str, since: Ts) -> Result<u32> {
        Ok(self.conn.query_row(
            "SELECT COUNT(*) FROM runs r JOIN runs p ON p.id = r.parent_run_id
             WHERE r.employee_id = ?1 AND p.employee_id = ?2 AND r.created_at >= ?3 AND r.state != 'cancelled'
               AND json_valid(r.data) AND json_extract(r.data, '$.kind.type') = 'delegated'",
            params![report_id, manager_id, ms(since)],
            |r| r.get(0),
        )?)
    }

    /// The held reports whose opening note was `run_id`'s (`Run::noted_in`), oldest first.
    pub fn noted_in(&self, run_id: &str) -> Result<Vec<Run>> {
        self.runs_where(
            "WHERE parent_run_id IS NOT NULL AND json_valid(data) AND json_extract(data, '$.notedIn') = ? ORDER BY created_at, rowid",
            &[&run_id],
        )
    }

    // ---- tidy ----

    /// An employee's Tidy runs, newest first.
    pub fn tidy_runs(&self, employee_id: &str) -> Result<Vec<Run>> {
        self.runs_where("WHERE employee_id = ? AND json_valid(data) AND json_extract(data, '$.kind.type') = 'tidy' ORDER BY created_at DESC, rowid DESC", &[&employee_id])
    }

    /// What you told this employee since `since`, in conversations, Inbox replies and an older build's chat:
    /// (when, your words), oldest first, at most `limit` of the newest.
    pub fn taught_since(&self, employee_id: &str, since: Option<Ts>, limit: usize) -> Result<Vec<(Ts, String)>> {
        let mut st = self.conn.prepare(
            "SELECT created_at, json_extract(data, '$.prompt') FROM runs
             WHERE employee_id = ?1 AND created_at > ?2 AND json_valid(data) AND json_extract(data, '$.kind.type') IN ('chat', 'reply', 'task')
               AND COALESCE(json_extract(data, '$.omegaWrote'), 0) = 0
             ORDER BY created_at DESC, rowid DESC LIMIT ?3",
        )?;
        let rows = st.query_map(params![employee_id, since.map(ms).unwrap_or(0), limit as i64], |r| {
            Ok((Ts::from_timestamp_millis(r.get::<_, i64>(0)?).unwrap_or_default(), r.get::<_, Option<String>>(1)?.unwrap_or_default()))
        })?;
        let mut v: Vec<(Ts, String)> = rows.collect::<rusqlite::Result<_>>()?;
        v.retain(|(_, t)| !t.trim().is_empty() && !t.contains("approved what was blocked"));
        v.reverse();
        Ok(v)
    }

    // ---- threads ----

    /// Every later turn of a thread (Reply runs, and answers that came back into a conversation), of one
    /// employee or of everyone, oldest first. Threads are built from them.
    pub fn reply_runs(&self, employee_id: Option<&str>) -> Result<Vec<Run>> {
        self.runs_where(
            "WHERE json_valid(data) AND (?1 IS NULL OR employee_id = ?1)
               AND (json_extract(data, '$.kind.type') = 'reply'
                    OR (json_extract(data, '$.kind.type') = 'answered' AND json_extract(data, '$.kind.thread') IS NOT NULL))
             ORDER BY created_at, rowid",
            &[&employee_id],
        )
    }

    /// An employee's conversations you started and have not archived, oldest first.
    pub fn open_tasks(&self, employee_id: &str) -> Result<Vec<Run>> {
        self.runs_where(
            "WHERE employee_id = ? AND json_valid(data) AND json_extract(data, '$.kind.type') = 'task' AND json_extract(data, '$.archivedAt') IS NULL
             ORDER BY created_at, rowid",
            &[&employee_id],
        )
    }

    /// Conversations you started and marked done, the most recently done `limit`, newest first.
    pub fn archived_tasks(&self, limit: u32) -> Result<Vec<Run>> {
        self.runs_where(
            "WHERE json_valid(data) AND json_extract(data, '$.kind.type') = 'task' AND json_extract(data, '$.archivedAt') IS NOT NULL
             ORDER BY json_extract(data, '$.archivedAt') DESC, rowid DESC LIMIT ?",
            &[&limit],
        )
    }

    /// Every run that continues a conversation (replies, colleagues' asks and answers, delegated
    /// work), oldest first: what `threads::file` follows to put a hand-off in one Inbox row. An answer
    /// that came back into a conversation belongs to that conversation's thread, never to a row, and so does
    /// one that came back as a turn of an older build's chat.
    pub fn conversation_runs(&self) -> Result<Vec<Run>> {
        self.runs_where(
            "WHERE json_valid(data) AND json_extract(data, '$.kind.type') IN ('reply', 'answered', 'asked', 'delegated')
               AND NOT (json_extract(data, '$.kind.type') = 'answered'
                        AND (COALESCE(json_extract(data, '$.kind.chat'), 0) = 1 OR json_extract(data, '$.kind.thread') IS NOT NULL))
             ORDER BY created_at, rowid",
            &[],
        )
    }

    // ---- news ----

    pub fn save_news(&self, n: &News) -> Result<()> {
        self.conn.execute(
            "INSERT INTO news(id, employee_id, created_at, read_at, data) VALUES (?1, ?2, ?3, ?4, ?5)
             ON CONFLICT(id) DO UPDATE SET read_at = ?4, data = ?5",
            params![n.id, n.employee_id, ms(n.created_at), n.read_at.map(ms), to_json(n)?],
        )?;
        Ok(())
    }

    /// News for an employee that they have not read yet, oldest first.
    pub fn unread_news(&self, employee_id: &str) -> Result<Vec<News>> {
        let mut st = self.conn.prepare("SELECT data FROM news WHERE employee_id = ? AND read_at IS NULL ORDER BY created_at, rowid")?;
        let v = readable("news", st.query_map([employee_id], |r| from_row(r, 0))?)?;
        Ok(v)
    }

    /// Makes the news `run_id`'s opening note showed unread again, for a run that never started. Returns how many.
    pub fn unread_news_of(&self, run_id: &str) -> Result<usize> {
        Ok(self.conn.execute(
            "UPDATE news SET read_at = NULL, data = json_remove(data, '$.readAt', '$.readIn') WHERE json_valid(data) AND json_extract(data, '$.readIn') = ?",
            [run_id],
        )?)
    }
}
