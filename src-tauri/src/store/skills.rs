//! When each skill was last used, and every revision of a skill file.

use super::*;

impl Store {
    // ---- skill use ----

    /// Records that a run used `skills` at `at`, keeping each skill's latest use.
    pub fn record_skill_use(&self, employee_id: &str, skills: &HashSet<String>, at: Ts) -> Result<()> {
        for skill in skills {
            self.conn.execute(
                "INSERT INTO skill_use(employee_id, skill, used_at) VALUES (?1, ?2, ?3)
                 ON CONFLICT(employee_id, skill) DO UPDATE SET used_at = MAX(used_at, ?3)",
                params![employee_id, skill, ms(at)],
            )?;
        }
        Ok(())
    }

    /// When each of an employee's skills was last used, and since when uses have been recorded at all.
    pub fn skill_use(&self, employee_id: &str) -> Result<(Vec<(String, Ts)>, Ts)> {
        let mut st = self.conn.prepare("SELECT skill, used_at FROM skill_use WHERE employee_id = ?")?;
        let rows = st.query_map([employee_id], |r| Ok((r.get(0)?, Ts::from_timestamp_millis(r.get(1)?).unwrap_or_default())))?;
        let used = rows.collect::<rusqlite::Result<_>>()?;
        Ok((used, self.meta("skill_use_since")?.unwrap_or_else(chrono::Utc::now)))
    }

    // ---- skill revisions ----

    pub fn insert_revision(&self, employee_id: &str, r: &SkillRevision) -> Result<()> {
        self.conn.execute(
            "INSERT INTO skill_revisions(id, employee_id, run_id, at, data) VALUES (?1, ?2, ?3, ?4, ?5)",
            params![r.id, employee_id, r.run_id, ms(r.at), to_json(r)?],
        )?;
        Ok(())
    }

    /// The newest revision since `since` of the same file with the same text before and after, if one is recorded.
    pub fn same_revision(&self, employee_id: &str, c: &SkillChange, before: Option<&str>, after: Option<&str>, since: Ts) -> Result<Option<SkillRevision>> {
        let mut st = self.conn.prepare(
            "SELECT data FROM skill_revisions WHERE employee_id = ?1 AND at >= ?2 AND json_valid(data)
               AND json_extract(data, '$.skill') = ?3 AND json_extract(data, '$.file') = ?4
               AND json_extract(data, '$.before') IS ?5 AND json_extract(data, '$.after') IS ?6
             ORDER BY at DESC, rowid DESC LIMIT 1",
        )?;
        let v = readable("skill_revisions", st.query_map(params![employee_id, ms(since), c.skill, c.file, before, after], |r| from_row(r, 0))?)?;
        Ok(v.into_iter().next())
    }

    /// Credits a revision recorded with no run to the run that made it.
    pub fn credit_revision(&self, id: &str, run_id: &str) -> Result<()> {
        self.conn.execute("UPDATE skill_revisions SET run_id = ?2, data = json_set(data, '$.runId', ?2) WHERE id = ?1 AND json_valid(data)", params![id, run_id])?;
        Ok(())
    }

    pub fn revisions(&self, employee_id: &str) -> Result<Vec<SkillRevision>> {
        let mut st = self
            .conn
            .prepare("SELECT data FROM skill_revisions WHERE employee_id = ? ORDER BY at DESC, rowid DESC")?;
        let v = readable("skill_revisions", st.query_map([employee_id], |r| from_row(r, 0))?)?;
        Ok(v)
    }

    /// (skill, file, when) of every edit since `since`, without the file texts.
    pub fn edits_since(&self, employee_id: &str, since: Ts) -> Result<Vec<(String, String, Ts)>> {
        let mut st = self.conn.prepare(
            "SELECT json_extract(data, '$.skill'), json_extract(data, '$.file'), at FROM skill_revisions WHERE employee_id = ? AND at >= ?",
        )?;
        let rows = st.query_map(params![employee_id, ms(since)], |r| {
            let at: i64 = r.get(2)?;
            Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?, Ts::from_timestamp_millis(at).unwrap_or_default()))
        })?;
        Ok(rows.collect::<rusqlite::Result<_>>()?)
    }

    /// A revision with the employee it belongs to.
    pub fn revision(&self, id: &str) -> Result<Option<(String, SkillRevision)>> {
        Ok(self
            .conn
            .query_row("SELECT employee_id, data FROM skill_revisions WHERE id = ?", [id], |r| {
                Ok((r.get(0)?, from_row(r, 1)?))
            })
            .optional()?)
    }

    /// Skill revisions since `since` that an employee's runs made with nobody watching (not in a conversation
    /// with you, a tidy or an organize), each with its run, newest first. Pseudo-skills like the company page
    /// are left out: OmegaStar guards those.
    pub fn unattended_revisions(&self, employee_id: &str, since: Ts) -> Result<Vec<(SkillRevision, Run)>> {
        let mut st = self.conn.prepare(
            "SELECT r.data, runs.data FROM skill_revisions r JOIN runs ON runs.id = r.run_id
             WHERE r.employee_id = ?1 AND r.at >= ?2 AND json_valid(r.data) AND json_valid(runs.data)
               AND json_extract(runs.data, '$.kind.type') NOT IN ('chat', 'task', 'reply', 'tidy', 'organize')
               AND json_extract(r.data, '$.skill') NOT LIKE '@%'
             ORDER BY r.at DESC",
        )?;
        let v = readable("skill_revisions", st.query_map(params![employee_id, ms(since)], |r| Ok((from_row(r, 0)?, from_row(r, 1)?)))?)?;
        Ok(v)
    }

    /// The file was recorded as changed since `since`, by one employee or by anyone.
    pub fn revised_since(&self, skill: &str, file: &str, employee_id: Option<&str>, since: Ts) -> Result<bool> {
        Ok(self
            .conn
            .query_row(
                "SELECT 1 FROM skill_revisions WHERE json_extract(data, '$.skill') = ?1 AND json_extract(data, '$.file') = ?2
                   AND (?3 IS NULL OR employee_id = ?3) AND at >= ?4 LIMIT 1",
                params![skill, file, employee_id, ms(since)],
                |_| Ok(()),
            )
            .optional()?
            .is_some())
    }
}
