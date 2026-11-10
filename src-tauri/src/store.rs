//! SQLite persistence. Each domain object is stored as its JSON form in `data`, with the columns
//! the Office queries on derived from it in exactly one place (the save functions below).

use crate::log::log;
use crate::model::*;
use rusqlite::{params, Connection, OptionalExtension, Row};
use serde::{de::DeserializeOwned, Serialize};
use std::collections::{BTreeSet, HashSet};
use std::path::Path;
use std::sync::Mutex;

pub struct Store {
    conn: Connection,
}

/// The whole schema. Every statement is idempotent, so opening an existing office changes nothing.
const SCHEMA: &str = r#"
CREATE TABLE IF NOT EXISTS meta(key TEXT PRIMARY KEY, value TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS employees(id TEXT PRIMARY KEY, slug TEXT NOT NULL UNIQUE, departed_at INTEGER, data TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS people(id TEXT PRIMARY KEY, removed_at INTEGER, data TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS schedules(id TEXT PRIMARY KEY, employee_id TEXT NOT NULL, last_slot INTEGER NOT NULL, data TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS runs(
  id TEXT PRIMARY KEY,
  employee_id TEXT NOT NULL,
  lane TEXT NOT NULL,
  state TEXT NOT NULL,
  schedule_id TEXT,
  slot INTEGER,
  parent_run_id TEXT,
  request_id TEXT,
  session TEXT NOT NULL,
  inited INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  data TEXT NOT NULL,
  UNIQUE(schedule_id, slot)
);
DROP INDEX IF EXISTS runs_one_running_per_lane;
CREATE UNIQUE INDEX IF NOT EXISTS runs_one_running_per_session ON runs(session) WHERE state = 'running';
CREATE UNIQUE INDEX IF NOT EXISTS runs_one_follow_up ON runs(request_id) WHERE request_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS runs_by_employee ON runs(employee_id, created_at);
CREATE INDEX IF NOT EXISTS runs_by_state ON runs(state, created_at);
CREATE INDEX IF NOT EXISTS runs_by_parent ON runs(parent_run_id);
CREATE TABLE IF NOT EXISTS requests(
  id TEXT PRIMARY KEY, person_id TEXT NOT NULL, employee_id TEXT NOT NULL, state TEXT NOT NULL,
  created_at INTEGER NOT NULL, data TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS skill_revisions(
  id TEXT PRIMARY KEY, employee_id TEXT NOT NULL, run_id TEXT, at INTEGER NOT NULL, data TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS revisions_by_employee ON skill_revisions(employee_id, at);
CREATE TABLE IF NOT EXISTS proposals(
  id TEXT PRIMARY KEY, employee_id TEXT NOT NULL, state TEXT NOT NULL, created_at INTEGER NOT NULL, data TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS proposals_by_state ON proposals(state, created_at);
CREATE TABLE IF NOT EXISTS checks(
  id TEXT PRIMARY KEY, employee_id TEXT NOT NULL, state TEXT NOT NULL, due_at INTEGER NOT NULL, created_at INTEGER NOT NULL, data TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS checks_by_employee ON checks(employee_id, state, due_at);
CREATE TABLE IF NOT EXISTS news(
  id TEXT PRIMARY KEY, employee_id TEXT NOT NULL, created_at INTEGER NOT NULL, read_at INTEGER, data TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS news_by_employee ON news(employee_id, read_at, created_at);
CREATE TABLE IF NOT EXISTS skill_use(employee_id TEXT NOT NULL, skill TEXT NOT NULL, used_at INTEGER NOT NULL, PRIMARY KEY(employee_id, skill));
"#;

fn ms(t: Ts) -> i64 {
    t.timestamp_millis()
}

fn to_json<T: Serialize>(v: &T) -> Result<String> {
    Ok(serde_json::to_string(v)?)
}

/// The error names the row by the start of its JSON, which begins with the row's id.
fn from_row<T: DeserializeOwned>(row: &Row, idx: usize) -> rusqlite::Result<T> {
    let s: String = row.get(idx)?;
    serde_json::from_str(&s).map_err(|e| {
        let head: String = s.chars().take(60).collect();
        rusqlite::Error::FromSqlConversionFailure(idx, rusqlite::types::Type::Text, Box::new(AppError::internal(format!("{e} in {head}"))))
    })
}

/// The rows this build can read. A row it cannot (written by a newer build, or damaged) is left out
/// and logged once per process, so one bad row never hides every other one.
fn readable<T>(table: &str, rows: impl Iterator<Item = rusqlite::Result<T>>) -> Result<Vec<T>> {
    static LOGGED: Mutex<BTreeSet<String>> = Mutex::new(BTreeSet::new());
    let mut v = vec![];
    for row in rows {
        match row {
            Ok(r) => v.push(r),
            Err(err @ rusqlite::Error::FromSqlConversionFailure(..)) => {
                if LOGGED.lock().unwrap_or_else(|e| e.into_inner()).insert(err.to_string()) {
                    log!("left out a {table} row this build cannot read: {err}");
                }
            }
            Err(e) => return Err(e.into()),
        }
    }
    Ok(v)
}

pub struct RunRecord {
    pub run: Run,
    pub session: String,
}

#[derive(Default)]
pub struct RequestFilter {
    pub person_id: Option<String>,
    pub employee_id: Option<String>,
    pub state: Option<RequestState>,
}

impl Store {
    pub fn open(path: &Path) -> Result<Store> {
        let conn = Connection::open(path)?;
        conn.pragma_update(None, "journal_mode", "WAL")?;
        conn.pragma_update(None, "synchronous", "NORMAL")?;
        conn.busy_timeout(std::time::Duration::from_secs(5))?;
        conn.execute_batch(&format!("BEGIN; {SCHEMA} COMMIT;"))?;
        let store = Store { conn };
        store.migrate_cards()?;
        store.drop_unrecorded_revisions()?;
        if store.meta::<Ts>("skill_use_since")?.is_none() {
            store.set_meta("skill_use_since", &chrono::Utc::now())?;
        }
        if store.meta::<Ts>("typed_answers_since")?.is_none() {
            store.set_meta("typed_answers_since", &chrono::Utc::now())?;
        }
        Ok(store)
    }

    /// Once: deletes the revisions older builds recorded of files that skill snapshots now leave out, as
    /// `own_skills` does: anything in a dependency or cache folder, and data files. Nobody wrote them, and they
    /// were most of the table.
    fn drop_unrecorded_revisions(&self) -> Result<()> {
        const DIRS: [&str; 5] = ["node_modules", "__pycache__", ".cache", ".venv", ".git"];
        const EXTS: [&str; 3] = ["json", "jsonl", "csv"];
        if self.meta::<bool>("unrecorded_revisions_dropped")?.unwrap_or(false) {
            return Ok(());
        }
        let left_out: Vec<String> = DIRS.iter().map(|d| format!("instr(f, '/{d}/') > 0")).chain(EXTS.iter().map(|x| format!("f LIKE '%.{x}'"))).collect();
        self.tx(|| {
            let n = self.conn.execute(
                &format!(
                    "DELETE FROM skill_revisions WHERE id IN (
                       SELECT id FROM (SELECT id, '/' || json_extract(data, '$.file') AS f FROM skill_revisions
                                       WHERE json_valid(data) AND json_extract(data, '$.skill') NOT LIKE '@%')
                       WHERE {})",
                    left_out.join(" OR ")
                ),
                [],
            )?;
            if n > 0 {
                log!("deleted {n} skill revisions of dependency and data files, which skills no longer record");
            }
            self.set_meta("unrecorded_revisions_dropped", &true)
        })
    }

    /// Once: a run's one `card` becomes its list of `cards`, and a chore card gets the key every card now
    /// has, so the queries below read one shape.
    fn migrate_cards(&self) -> Result<()> {
        if self.meta::<bool>("cards_listed")?.unwrap_or(false) {
            return Ok(());
        }
        self.tx(|| {
            self.conn.execute(
                "UPDATE runs SET data = json_set(json_remove(data, '$.card'), '$.cards',
                   CASE
                     WHEN json_type(data, '$.card') != 'object' THEN json_array()
                     WHEN json_extract(data, '$.card.ask.type') = 'chore'
                       THEN json_array(json_set(json(json_extract(data, '$.card')), '$.key', 'chore:' || json_extract(data, '$.card.ask.subject')))
                     ELSE json_array(json(json_extract(data, '$.card')))
                   END)
                 WHERE json_valid(data) AND json_type(data, '$.card') IS NOT NULL",
                [],
            )?;
            self.set_meta("cards_listed", &true)
        })
    }

    /// Runs `f` as one unit: every write it makes lands, or none does. A savepoint, so units nest.
    pub fn tx<T>(&self, f: impl FnOnce() -> Result<T>) -> Result<T> {
        self.conn.execute_batch("SAVEPOINT tx")?;
        match f() {
            Ok(v) => {
                self.conn.execute_batch("RELEASE tx")?;
                Ok(v)
            }
            Err(e) => {
                if let Err(undo) = self.conn.execute_batch("ROLLBACK TO tx; RELEASE tx") {
                    log!("rolling back a failed write failed: {undo}");
                }
                Err(e)
            }
        }
    }

    // ---- meta ----

    fn meta<T: DeserializeOwned>(&self, key: &str) -> Result<Option<T>> {
        Ok(self
            .conn
            .query_row("SELECT value FROM meta WHERE key = ?", [key], |r| from_row(r, 0))
            .optional()?)
    }

    fn set_meta<T: Serialize>(&self, key: &str, v: &T) -> Result<()> {
        self.conn.execute(
            "INSERT INTO meta(key, value) VALUES (?1, ?2) ON CONFLICT(key) DO UPDATE SET value = ?2",
            params![key, to_json(v)?],
        )?;
        Ok(())
    }

    pub fn company(&self) -> Result<Option<Company>> {
        self.meta("company")
    }
    pub fn set_company(&self, c: &Company) -> Result<()> {
        self.set_meta("company", c)
    }
    pub fn settings(&self) -> Result<Option<AppSettings>> {
        self.meta("settings")
    }
    pub fn set_settings(&self, s: &AppSettings) -> Result<()> {
        self.set_meta("settings", s)
    }
    pub fn backup_status(&self) -> Result<Option<BackupStatus>> {
        self.meta("backup_status")
    }
    pub fn set_backup_status(&self, s: &BackupStatus) -> Result<()> {
        self.set_meta("backup_status", s)
    }
    /// When the usage limit that holds the office resets; `None` when nothing holds it.
    pub fn held_until(&self) -> Result<Option<Ts>> {
        Ok(self.meta::<Option<Ts>>("held_until")?.flatten())
    }
    pub fn set_held_until(&self, t: Option<Ts>) -> Result<()> {
        self.set_meta("held_until", &t)
    }
    /// Rate limits in a row since a run last succeeded, and whether the hold on work is for one, so a restart keeps
    /// the backoff and a usage check cannot end the hold.
    pub fn rate_limits(&self) -> Result<(u32, bool)> {
        Ok(self.meta::<(u32, bool)>("rate_limits")?.unwrap_or_default())
    }
    pub fn set_rate_limits(&self, in_a_row: u32, holding: bool) -> Result<()> {
        self.set_meta("rate_limits", &(in_a_row, holding))
    }
    /// Whether every employee hired before weekly reviews existed has been given one.
    pub fn reviews_seeded(&self) -> Result<bool> {
        Ok(self.meta::<bool>("reviewsSeeded")?.unwrap_or(false))
    }
    pub fn set_reviews_seeded(&self) -> Result<()> {
        self.set_meta("reviewsSeeded", &true)
    }
    /// Whether the transcripts runs saved before images were left out of them have had theirs taken out.
    pub fn transcripts_compacted(&self) -> Result<bool> {
        Ok(self.meta::<bool>("transcriptsCompacted")?.unwrap_or(false))
    }
    pub fn set_transcripts_compacted(&self) -> Result<()> {
        self.set_meta("transcriptsCompacted", &true)
    }

    /// Writes a consistent copy of the whole database to `path`, which must not exist.
    pub fn snapshot_to(&self, path: &Path) -> Result<()> {
        self.conn.execute("VACUUM INTO ?1", [path.to_string_lossy()])?;
        Ok(())
    }

    // ---- employees ----

    pub fn employees(&self) -> Result<Vec<Employee>> {
        let mut st = self.conn.prepare("SELECT data FROM employees WHERE departed_at IS NULL")?;
        let mut v: Vec<Employee> = readable("employees", st.query_map([], |r| from_row(r, 0))?)?;
        v.sort_by_key(|e| e.hired_at);
        Ok(v)
    }

    pub fn employee(&self, id: &str) -> Result<Option<Employee>> {
        Ok(self
            .conn
            .query_row("SELECT data FROM employees WHERE id = ? AND departed_at IS NULL", [id], |r| from_row(r, 0))
            .optional()?)
    }

    /// Every slug ever used, departed employees included (the column is UNIQUE).
    pub fn slugs(&self) -> Result<Vec<String>> {
        let mut st = self.conn.prepare("SELECT slug FROM employees")?;
        let v = st.query_map([], |r| r.get(0))?.collect::<rusqlite::Result<_>>()?;
        Ok(v)
    }

    pub fn save_employee(&self, e: &Employee) -> Result<()> {
        self.conn.execute(
            "INSERT INTO employees(id, slug, data) VALUES (?1, ?2, ?3)
             ON CONFLICT(id) DO UPDATE SET data = ?3",
            params![e.id, e.slug, to_json(e)?],
        )?;
        Ok(())
    }

    pub fn depart_employee(&self, id: &str, at: Ts) -> Result<()> {
        self.conn.execute("UPDATE employees SET departed_at = ? WHERE id = ?", params![ms(at), id])?;
        Ok(())
    }

    // ---- people ----

    pub fn people(&self) -> Result<Vec<Person>> {
        let mut st = self.conn.prepare("SELECT data FROM people WHERE removed_at IS NULL")?;
        let mut v: Vec<Person> = readable("people", st.query_map([], |r| from_row(r, 0))?)?;
        v.sort_by_key(|p| p.added_at);
        Ok(v)
    }

    pub fn person(&self, id: &str) -> Result<Option<Person>> {
        Ok(self
            .conn
            .query_row("SELECT data FROM people WHERE id = ? AND removed_at IS NULL", [id], |r| from_row(r, 0))
            .optional()?)
    }

    pub fn save_person(&self, p: &Person) -> Result<()> {
        self.conn.execute(
            "INSERT INTO people(id, data) VALUES (?1, ?2) ON CONFLICT(id) DO UPDATE SET data = ?2",
            params![p.id, to_json(p)?],
        )?;
        Ok(())
    }

    pub fn remove_person(&self, id: &str, at: Ts) -> Result<()> {
        self.conn.execute("UPDATE people SET removed_at = ? WHERE id = ?", params![ms(at), id])?;
        Ok(())
    }

    // ---- schedules ----

    fn schedules_where(&self, clause: &str, p: &[&dyn rusqlite::ToSql]) -> Result<Vec<(Schedule, Ts)>> {
        let mut st = self.conn.prepare(&format!("SELECT data, last_slot FROM schedules {clause}"))?;
        let rows = st.query_map(p, |r| {
            let s: Schedule = from_row(r, 0)?;
            let last: i64 = r.get(1)?;
            Ok((s, Ts::from_timestamp_millis(last).unwrap_or_default()))
        })?;
        let v = readable("schedules", rows)?;
        Ok(v)
    }

    /// Schedules with the slot they last fired (or were anchored) at.
    pub fn all_schedules(&self) -> Result<Vec<(Schedule, Ts)>> {
        self.schedules_where("", &[])
    }

    pub fn schedules(&self, employee_id: &str) -> Result<Vec<Schedule>> {
        Ok(self.schedules_where("WHERE employee_id = ?", &[&employee_id])?.into_iter().map(|(s, _)| s).collect())
    }

    pub fn schedule(&self, id: &str) -> Result<Option<(Schedule, Ts)>> {
        Ok(self.schedules_where("WHERE id = ?", &[&id])?.into_iter().next())
    }

    pub fn save_schedule(&self, s: &Schedule, last_slot: Ts) -> Result<()> {
        self.conn.execute(
            "INSERT INTO schedules(id, employee_id, last_slot, data) VALUES (?1, ?2, ?3, ?4)
             ON CONFLICT(id) DO UPDATE SET last_slot = ?3, data = ?4",
            params![s.id, s.employee_id, ms(last_slot), to_json(s)?],
        )?;
        Ok(())
    }

    pub fn set_last_slot(&self, schedule_id: &str, slot: Ts) -> Result<()> {
        self.conn.execute("UPDATE schedules SET last_slot = ? WHERE id = ?", params![ms(slot), schedule_id])?;
        Ok(())
    }

    pub fn delete_schedule(&self, id: &str) -> Result<()> {
        self.conn.execute("DELETE FROM schedules WHERE id = ?", [id])?;
        Ok(())
    }

    pub fn delete_schedules_of(&self, employee_id: &str) -> Result<()> {
        self.conn.execute("DELETE FROM schedules WHERE employee_id = ?", [employee_id])?;
        Ok(())
    }

    // ---- runs ----

    /// Inserts a queued run. Returns false when an equivalent run already exists (same schedule slot,
    /// or a follow-up for the same request): that unique constraint is the claim.
    pub fn insert_run(&self, run: &Run, session: &str) -> Result<bool> {
        let (schedule_id, slot) = match &run.kind {
            RunKind::Scheduled { schedule_id, slot, .. } => (Some(schedule_id.as_str()), Some(ms(*slot))),
            _ => (None, None),
        };
        let request_id = match &run.kind {
            RunKind::FollowUp { request_id, .. } => Some(request_id.as_str()),
            _ => None,
        };
        let n = self.conn.execute(
            "INSERT INTO runs(id, employee_id, lane, state, schedule_id, slot, parent_run_id, request_id, session, created_at, data)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11)
             ON CONFLICT DO NOTHING",
            params![
                run.id,
                run.employee_id,
                run.kind.lane().as_str(),
                run.state.as_str(),
                schedule_id,
                slot,
                run.parent_run_id(),
                request_id,
                session,
                ms(run.created_at),
                to_json(run)?
            ],
        )?;
        Ok(n == 1)
    }

    pub fn save_run(&self, run: &Run) -> Result<()> {
        self.conn.execute(
            "UPDATE runs SET state = ?2, data = ?3 WHERE id = ?1",
            params![run.id, run.state.as_str(), to_json(run)?],
        )?;
        Ok(())
    }

    /// Saves a run whose kind moved it to another lane, with that lane.
    pub fn save_run_moved(&self, run: &Run) -> Result<()> {
        self.conn.execute("UPDATE runs SET lane = ?2, data = ?3 WHERE id = ?1", params![run.id, run.kind.lane().as_str(), to_json(run)?])?;
        Ok(())
    }

    /// Marks every run still running as lost, in SQL, so it reaches rows this build cannot read; JSON
    /// that is not valid is left as it is. `recover` calls it after saving the readable ones, so a row
    /// from another build never holds its session's running slot.
    pub fn lose_unreadable_running(&self, at: Ts, error: &str) -> Result<usize> {
        let at = serde_json::to_value(at)?;
        Ok(self.conn.execute(
            "UPDATE runs SET state = 'lost',
               data = CASE WHEN json_valid(data) THEN json_set(data, '$.state', 'lost', '$.endedAt', ?1, '$.error', ?2) ELSE data END
             WHERE state = 'running'",
            params![at.as_str(), error],
        )?)
    }

    pub fn mark_inited(&self, run_id: &str) -> Result<()> {
        self.conn.execute("UPDATE runs SET inited = 1 WHERE id = ?", [run_id])?;
        Ok(())
    }

    /// Whether Claude Code has already started this session (so the next turn must --resume it).
    pub fn session_started(&self, session: &str) -> Result<bool> {
        Ok(self
            .conn
            .query_row("SELECT 1 FROM runs WHERE session = ? AND inited = 1 LIMIT 1", [session], |_| Ok(()))
            .optional()?
            .is_some())
    }

    pub fn run(&self, id: &str) -> Result<Option<RunRecord>> {
        Ok(self
            .conn
            .query_row("SELECT data, session FROM runs WHERE id = ?", [id], |r| {
                Ok(RunRecord { run: from_row(r, 0)?, session: r.get(1)? })
            })
            .optional()?)
    }

    fn runs_where(&self, clause: &str, p: &[&dyn rusqlite::ToSql]) -> Result<Vec<Run>> {
        let mut st = self.conn.prepare(&format!("SELECT data FROM runs {clause}"))?;
        let v = readable("runs", st.query_map(p, |r| from_row(r, 0))?)?;
        Ok(v)
    }

    pub fn runs_in_state(&self, state: RunState) -> Result<Vec<Run>> {
        self.runs_where("WHERE state = ? ORDER BY created_at, rowid", &[&state.as_str()])
    }

    /// The same runs with their sessions.
    pub fn records_in_state(&self, state: RunState) -> Result<Vec<RunRecord>> {
        let mut st = self.conn.prepare("SELECT data, session FROM runs WHERE state = ? ORDER BY created_at, rowid")?;
        let v = readable("runs", st.query_map([state.as_str()], |r| Ok(RunRecord { run: from_row(r, 0)?, session: r.get(1)? }))?)?;
        Ok(v)
    }

    pub fn recent_runs(&self, employee_id: Option<&str>, limit: u32) -> Result<Vec<Run>> {
        match employee_id {
            Some(e) => self.runs_where("WHERE employee_id = ? ORDER BY created_at DESC, rowid DESC LIMIT ?", &[&e, &limit]),
            None => self.runs_where(
                "WHERE employee_id IN (SELECT id FROM employees WHERE departed_at IS NULL)
                 ORDER BY created_at DESC, rowid DESC LIMIT ?",
                &[&limit],
            ),
        }
    }

    pub fn children(&self, parent_run_id: &str) -> Result<Vec<Run>> {
        self.runs_where("WHERE parent_run_id = ? ORDER BY created_at, rowid", &[&parent_run_id])
    }

    /// Latest work-lane runs of an employee, newest first.
    pub fn work_runs(&self, employee_id: &str, limit: u32) -> Result<Vec<Run>> {
        self.runs_where(
            "WHERE employee_id = ? AND lane = 'work' ORDER BY created_at DESC, rowid DESC LIMIT ?",
            &[&employee_id, &limit],
        )
    }

    /// An employee's finished runs created since `since`, both lanes, with their sessions, newest first.
    pub fn finished_since(&self, employee_id: &str, since: Ts) -> Result<Vec<RunRecord>> {
        let mut st = self.conn.prepare(
            "SELECT data, session FROM runs WHERE employee_id = ?1 AND created_at >= ?2 AND state NOT IN ('queued', 'running')
             ORDER BY created_at DESC, rowid DESC",
        )?;
        let v = readable("runs", st.query_map(params![employee_id, ms(since)], |r| Ok(RunRecord { run: from_row(r, 0)?, session: r.get(1)? }))?)?;
        Ok(v)
    }

    /// When the last turn of a conversation ended: its newest finished run other than `except`.
    pub fn last_turn_ended(&self, session: &str, except: &str) -> Result<Option<Ts>> {
        Ok(self
            .runs_where(
                "WHERE session = ? AND id != ? AND state NOT IN ('queued', 'running') ORDER BY created_at DESC, rowid DESC LIMIT 1",
                &[&session, &except],
            )?
            .pop()
            .and_then(|r| r.ended_at))
    }

    /// The finished runs of a session other than `except`, newest first.
    pub fn turns_of_session(&self, session: &str, except: &str) -> Result<Vec<Run>> {
        self.runs_where("WHERE session = ? AND id != ? AND state NOT IN ('queued', 'running') ORDER BY created_at DESC, rowid DESC", &[&session, &except])
    }

    /// An employee's finished runs with a card you have not answered yet, oldest first.
    pub fn open_cards(&self, employee_id: &str) -> Result<Vec<Run>> {
        self.runs_where(
            "WHERE employee_id = ? AND json_valid(data)
               AND EXISTS (SELECT 1 FROM json_each(CASE WHEN json_valid(data) THEN data ELSE '{}' END, '$.cards') c WHERE json_extract(c.value, '$.answer') IS NULL)
               AND state NOT IN ('queued', 'running')
             ORDER BY created_at, rowid",
            &[&employee_id],
        )
    }

    /// The ids of runs that asked a colleague something or delegated work since `since`.
    pub fn parents_since(&self, since: Ts) -> Result<HashSet<String>> {
        let mut st = self.conn.prepare("SELECT DISTINCT parent_run_id FROM runs WHERE parent_run_id IS NOT NULL AND created_at >= ?")?;
        let v = st.query_map([ms(since)], |r| r.get(0))?.collect::<rusqlite::Result<_>>()?;
        Ok(v)
    }

    pub fn active_runs_of(&self, employee_id: &str) -> Result<Vec<Run>> {
        self.runs_where(
            "WHERE employee_id = ? AND state IN ('queued', 'running') ORDER BY created_at, rowid",
            &[&employee_id],
        )
    }

    /// Raw SQL on purpose: a queued row this build cannot read is a newer build's run, which that build will start.
    pub fn schedule_has_queued_run(&self, schedule_id: &str) -> Result<bool> {
        Ok(self
            .conn
            .query_row(
                "SELECT 1 FROM runs WHERE schedule_id = ? AND state = 'queued' LIMIT 1",
                [schedule_id],
                |_| Ok(()),
            )
            .optional()?
            .is_some())
    }

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
            "WHERE schedule_id IS NOT NULL AND json_valid(data) AND json_extract(data, '$.kind.review') = 1
               AND created_at >= ? AND state NOT IN ('queued', 'running')
             ORDER BY created_at, rowid",
            &[&ms(since)],
        )
    }

    /// Finished routine runs since `since`, of one employee or with `None` everyone's, one count per schedule,
    /// busiest first. Reviews and due checks are not routines. A run reached someone when it notified you or handed
    /// work to a colleague, and did something when it reached someone, changed a skill or failed.
    pub fn routine_counts(&self, employee_id: Option<&str>, since: Ts) -> Result<Vec<RoutineUsage>> {
        let mut st = self.conn.prepare(
            "SELECT schedule_id, MAX(employee_id), MAX(json_extract(data, '$.kind.label')), MAX(COALESCE(json_extract(data, '$.kind.quiet'), 0)), COUNT(*),
               SUM(reached), SUM(failed), SUM(reached OR failed OR COALESCE(json_array_length(data, '$.skillChanges'), 0) > 0), TOTAL(json_extract(data, '$.costUsd'))
             FROM (SELECT r.*, r.state IN ('failed', 'lost') AS failed,
                     COALESCE(json_array_length(r.data, '$.needsYou'), 0) > 0 OR EXISTS (SELECT 1 FROM runs c WHERE c.parent_run_id = r.id) AS reached
                   FROM runs r
                   WHERE (?1 IS NULL OR r.employee_id = ?1) AND r.schedule_id IS NOT NULL AND r.schedule_id NOT LIKE 'check:%' AND r.created_at >= ?2
                     AND r.state NOT IN ('queued', 'running') AND json_valid(r.data)
                     AND COALESCE(json_extract(r.data, '$.kind.review'), 0) = 0)
             GROUP BY schedule_id ORDER BY 5 DESC",
        )?;
        let rows = st.query_map(params![employee_id, ms(since)], |r| {
            Ok(RoutineUsage {
                schedule_id: r.get(0)?,
                employee_id: r.get(1)?,
                label: r.get::<_, Option<String>>(2)?.unwrap_or_default(),
                quiet: r.get::<_, i64>(3)? != 0,
                runs: r.get(4)?,
                reached: r.get(5)?,
                failed: r.get(6)?,
                useful: r.get(7)?,
                cost_usd: r.get(8)?,
            })
        })?;
        Ok(rows.collect::<rusqlite::Result<_>>()?)
    }

    /// Each employee's finished runs since `since`: how many, the cards they raised, the work they handed to
    /// colleagues since then, how many failed, and what they cost.
    pub fn employee_usage(&self, since: Ts) -> Result<Vec<EmployeeUsage>> {
        let mut st = self.conn.prepare(
            "SELECT r.employee_id, COUNT(*), SUM(COALESCE(json_array_length(r.data, '$.cards'), 0)), MAX(COALESCE(h.n, 0)),
               SUM(r.state IN ('failed', 'lost')), TOTAL(json_extract(r.data, '$.costUsd'))
             FROM runs r
             LEFT JOIN (SELECT p.employee_id, COUNT(*) AS n FROM runs c JOIN runs p ON p.id = c.parent_run_id
                        WHERE c.created_at >= ?1 GROUP BY p.employee_id) h ON h.employee_id = r.employee_id
             WHERE r.created_at >= ?1 AND r.state NOT IN ('queued', 'running') AND json_valid(r.data)
             GROUP BY r.employee_id",
        )?;
        let rows = st.query_map([ms(since)], |r| {
            Ok(EmployeeUsage { employee_id: r.get(0)?, runs: r.get(1)?, decisions: r.get(2)?, handoffs: r.get(3)?, failed: r.get(4)?, cost_usd: r.get(5)? })
        })?;
        Ok(rows.collect::<rusqlite::Result<_>>()?)
    }

    /// The newest `limit` runs of the employees still here whose instruction, report or a card's question
    /// contains `query`, ignoring case in ASCII letters as SQLite's `lower` does.
    pub fn search_runs(&self, query: &str, limit: u32) -> Result<Vec<Run>> {
        let q = query.trim().to_ascii_lowercase();
        if q.is_empty() {
            return Ok(vec![]);
        }
        self.runs_where(
            "WHERE employee_id IN (SELECT id FROM employees WHERE departed_at IS NULL)
               AND CASE WHEN json_valid(data) THEN
                     instr(lower(COALESCE(json_extract(data, '$.prompt'), '')), ?1) > 0
                     OR instr(lower(COALESCE(json_extract(data, '$.summary'), '')), ?1) > 0
                     OR EXISTS (SELECT 1 FROM json_each(data, '$.cards') c WHERE instr(lower(COALESCE(json_extract(c.value, '$.message'), '')), ?1) > 0)
                   ELSE 0 END
             ORDER BY created_at DESC, rowid DESC LIMIT ?2",
            &[&q, &limit],
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

    /// Skill revisions since `since` that an employee's runs made with nobody watching (not in a conversation
    /// with you, a tidy or an organize), each with its run, newest first. Pseudo-skills like the company page
    /// are left out: Omega Star guards those.
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
                 AND state NOT IN ('queued', 'running')
                 AND NOT (json_extract(data, '$.kind.type') = 'nudge' AND state = 'cancelled')
                 AND NOT ((COALESCE(json_extract(data, '$.kind.quiet'), 0) = 1 OR json_extract(data, '$.kind.type') IN ('tidy', 'nudge'))
                          AND NOT (schedule_id LIKE 'check:%' AND COALESCE(json_extract(data, '$.durationMs'), 0) > {long})
                          AND state = 'succeeded'
                          AND COALESCE(json_array_length(data, '$.needsYou'), 0) = 0
                          AND (COALESCE(json_array_length(data, '$.denials'), 0) = 0 OR json_extract(data, '$.kind.type') = 'tidy')
                          AND COALESCE(json_extract(data, '$.steered'), 0) = 0)
                 AND {archived}
                 ORDER BY {order} LIMIT ?",
                long = crate::threads::CHECK_QUIET_MS
            ),
            &[&roots, &flagged, &limit.map_or(-1, i64::from)],
        )
    }

    /// Colleague asks still in flight: queued or running, or answered while the asker's own run is
    /// still going and has not collected the answer yet. Oldest first.
    pub fn open_asks(&self) -> Result<Vec<Run>> {
        self.runs_where(
            "WHERE json_valid(data)
               AND json_extract(data, '$.kind.type') = 'asked'
               AND (state IN ('queued', 'running')
                    OR (json_valid(data) AND json_extract(data, '$.deliveredAt') IS NULL
                        AND parent_run_id IN (SELECT id FROM runs WHERE state IN ('queued', 'running'))))
             ORDER BY created_at, rowid",
            &[],
        )
    }

    /// Work runs with a card about `topic` (`Card::topic`) still waiting on you (`Card::waiting`: no answer yet, or put
    /// off with Later), oldest first: finished ones, and ones the usage limit sent back to the queue with the cards
    /// they raised.
    pub fn open_topic_runs(&self, topic: &str) -> Result<Vec<Run>> {
        self.runs_where(
            "WHERE json_valid(data)
               AND EXISTS (SELECT 1 FROM json_each(CASE WHEN json_valid(data) THEN data ELSE '{}' END, '$.cards') c
                           WHERE json_extract(c.value, '$.key') = ? AND (json_extract(c.value, '$.answer') IS NULL
                             OR json_extract(c.value, '$.backAt') IS NOT NULL OR json_extract(c.value, '$.parked') = 1))
               AND state != 'running' AND lane = 'work'
             ORDER BY created_at, rowid",
            &[&topic],
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

    /// Deletes a run that never started: reports held for a manager, once a run of theirs took them in instead.
    pub fn delete_queued_run(&self, id: &str) -> Result<bool> {
        Ok(self.conn.execute("DELETE FROM runs WHERE id = ? AND state = 'queued'", [id])? == 1)
    }

    /// When a session's first run was made, and the context its newest finished run that measured one ended with.
    pub fn session_size(&self, session: &str) -> Result<(Option<Ts>, Option<u64>)> {
        let began: Option<i64> = self.conn.query_row("SELECT MIN(created_at) FROM runs WHERE session = ?", [session], |r| r.get(0))?;
        let context: Option<i64> = self
            .conn
            .query_row(
                "SELECT json_extract(data, '$.contextTokens') FROM runs
                 WHERE session = ? AND state NOT IN ('queued', 'running') AND json_valid(data) AND json_extract(data, '$.contextTokens') IS NOT NULL
                 ORDER BY created_at DESC, rowid DESC LIMIT 1",
                [session],
                |r| r.get(0),
            )
            .optional()?;
        Ok((began.and_then(Ts::from_timestamp_millis), context.map(|c| c.max(0) as u64)))
    }

    /// An employee's cards that a newer card replaced after `since`, with when, oldest first.
    pub fn replaced_cards(&self, employee_id: &str, since: Ts) -> Result<Vec<(Ts, Card)>> {
        // The stored times compare as text: a second's leeway keeps every later one, and the exact test is below.
        let after = serde_json::to_value(since - chrono::Duration::seconds(1))?;
        let runs = self.runs_where(
            "WHERE employee_id = ? AND json_valid(data)
               AND EXISTS (SELECT 1 FROM json_each(CASE WHEN json_valid(data) THEN data ELSE '{}' END, '$.cards') c
                           WHERE json_extract(c.value, '$.answer.how') = 'replaced' AND json_extract(c.value, '$.answer.at') > ?)",
            &[&employee_id, &after.as_str()],
        )?;
        let mut v: Vec<(Ts, Card)> = runs
            .into_iter()
            .flat_map(|r| r.cards)
            .filter_map(|c| c.answer.as_ref().filter(|a| a.how == AnswerHow::Replaced && a.at > since).map(|a| (a.at, c.clone())))
            .collect();
        v.sort_by_key(|(at, _)| *at);
        Ok(v)
    }

    /// An employee's decision and item cards you answered after `since` (a tap, your own words or No), newest first,
    /// leaving out the runs of `session`, which heard them already, and answers still held back for their run. Your own
    /// words count only from when this build first opened the office: an older build put one typed reply on every card
    /// open in its thread, so an answer typed before then may not be about its card at all.
    pub fn answered_cards(&self, employee_id: &str, since: Ts, session: &str) -> Result<Vec<Card>> {
        let typed_since = self.meta::<Ts>("typed_answers_since")?.unwrap_or(since);
        // The stored times compare as text: a second's leeway keeps every later one, and the exact test is below.
        let after = serde_json::to_value(since - chrono::Duration::seconds(1))?;
        let runs = self.runs_where(
            "WHERE employee_id = ? AND session != ? AND json_valid(data)
               AND EXISTS (SELECT 1 FROM json_each(CASE WHEN json_valid(data) THEN data ELSE '{}' END, '$.cards') c
                           WHERE json_extract(c.value, '$.answer.how') IN ('tapped', 'typed', 'rejected') AND json_extract(c.value, '$.answer.at') > ?)",
            &[&employee_id, &session, &after.as_str()],
        )?;
        let mut v: Vec<Card> = runs
            .into_iter()
            .flat_map(|r| r.cards)
            .filter(|c| !matches!(c.ask, CardAsk::Chore { .. }))
            .filter(|c| c.answer.as_ref().is_some_and(|a| matches!(a.how, AnswerHow::Tapped | AnswerHow::Typed | AnswerHow::Rejected) && !a.held && a.at > since))
            .filter(|c| c.answer.as_ref().is_some_and(|a| a.how != AnswerHow::Typed || a.at > typed_since))
            .collect();
        v.sort_by_key(|c| std::cmp::Reverse(c.answer.as_ref().map(|a| a.at)));
        Ok(v)
    }

    /// Runs not working right now with a card you said Later to that is due back by `at`, oldest first.
    pub fn cards_due_back(&self, at: Ts) -> Result<Vec<Run>> {
        // The stored times compare as text: a second's leeway keeps every earlier one, and the exact test is below.
        let by = serde_json::to_value(at + chrono::Duration::seconds(1))?;
        let runs = self.runs_where(
            "WHERE json_valid(data) AND state != 'running'
               AND EXISTS (SELECT 1 FROM json_each(CASE WHEN json_valid(data) THEN data ELSE '{}' END, '$.cards') c
                           WHERE json_extract(c.value, '$.backAt') IS NOT NULL AND json_extract(c.value, '$.backAt') <= ?)
             ORDER BY created_at, rowid",
            &[&by.as_str()],
        )?;
        Ok(runs.into_iter().filter(|r| r.cards.iter().any(|c| c.back_at.is_some_and(|t| t <= at))).collect())
    }

    /// Current employees' runs holding a card you parked, newest first.
    pub fn parked_runs(&self) -> Result<Vec<Run>> {
        self.runs_where(
            "WHERE employee_id IN (SELECT id FROM employees WHERE departed_at IS NULL) AND json_valid(data)
               AND EXISTS (SELECT 1 FROM json_each(CASE WHEN json_valid(data) THEN data ELSE '{}' END, '$.cards') c
                           WHERE json_extract(c.value, '$.parked') = 1)
             ORDER BY created_at DESC, rowid DESC",
            &[],
        )
    }

    /// Whether `employee_id` closed a card about `topic` with `close_ask` after `since`.
    pub fn withdrew_since(&self, employee_id: &str, topic: &str, since: Ts) -> Result<bool> {
        let after = serde_json::to_value(since - chrono::Duration::seconds(1))?;
        let runs = self.runs_where(
            "WHERE employee_id = ? AND json_valid(data)
               AND EXISTS (SELECT 1 FROM json_each(CASE WHEN json_valid(data) THEN data ELSE '{}' END, '$.cards') c
                           WHERE json_extract(c.value, '$.key') = ? AND json_extract(c.value, '$.answer.how') = 'withdrawn'
                             AND json_extract(c.value, '$.answer.at') > ?)",
            &[&employee_id, &topic, &after.as_str()],
        )?;
        let withdrawn = |c: &Card| c.key.as_deref() == Some(topic) && c.answer.as_ref().is_some_and(|a| a.how == AnswerHow::Withdrawn && a.at > since);
        Ok(runs.iter().flat_map(|r| &r.cards).any(withdrawn))
    }

    /// A schedule's runs from before `before` with a decision or item card still waiting on you (`Card::waiting`),
    /// oldest first.
    pub fn open_cards_of_schedule(&self, schedule_id: &str, before: Ts) -> Result<Vec<Run>> {
        self.runs_where(
            "WHERE schedule_id = ? AND created_at < ? AND json_valid(data)
               AND EXISTS (SELECT 1 FROM json_each(CASE WHEN json_valid(data) THEN data ELSE '{}' END, '$.cards') c
                           WHERE json_extract(c.value, '$.ask.type') IN ('choices', 'items') AND (json_extract(c.value, '$.answer') IS NULL
                             OR json_extract(c.value, '$.backAt') IS NOT NULL OR json_extract(c.value, '$.parked') = 1))
             ORDER BY created_at, rowid",
            &[&schedule_id, &ms(before)],
        )
    }

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

    /// The queued or running run of `kind` (its `type` tag) about a request.
    pub fn active_run_for(&self, request_id: &str, kind: &str) -> Result<Option<Run>> {
        Ok(self
            .runs_where(
                "WHERE state IN ('queued', 'running') AND json_valid(data) AND json_extract(data, '$.kind.type') = ? AND json_extract(data, '$.kind.requestId') = ? LIMIT 1",
                &[&kind, &request_id],
            )?
            .into_iter()
            .next())
    }

    /// Whether a run of `kind` about a request was ever made, in any state.
    pub fn has_run_for(&self, request_id: &str, kind: &str) -> Result<bool> {
        Ok(self
            .conn
            .query_row(
                "SELECT 1 FROM runs WHERE json_valid(data) AND json_extract(data, '$.kind.type') = ? AND json_extract(data, '$.kind.requestId') = ? LIMIT 1",
                [kind, request_id],
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

    // ---- hire proposals ----

    pub fn save_proposal(&self, p: &HireProposal) -> Result<()> {
        self.conn.execute(
            "INSERT INTO proposals(id, employee_id, state, created_at, data) VALUES (?1, ?2, ?3, ?4, ?5)
             ON CONFLICT(id) DO UPDATE SET state = ?3, data = ?5",
            params![p.id, p.employee_id, p.state.as_str(), ms(p.created_at), to_json(p)?],
        )?;
        Ok(())
    }

    pub fn proposal(&self, id: &str) -> Result<Option<HireProposal>> {
        Ok(self
            .conn
            .query_row("SELECT data FROM proposals WHERE id = ?", [id], |r| from_row(r, 0))
            .optional()?)
    }

    /// Newest first.
    pub fn proposals(&self, employee_id: Option<&str>, state: Option<ProposalState>) -> Result<Vec<HireProposal>> {
        let mut st = self.conn.prepare(
            "SELECT data FROM proposals WHERE (?1 IS NULL OR employee_id = ?1) AND (?2 IS NULL OR state = ?2)
             ORDER BY created_at DESC, rowid DESC",
        )?;
        let v = readable("proposals", st.query_map(params![employee_id, state.map(|s| s.as_str())], |r| from_row(r, 0))?)?;
        Ok(v)
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

    /// When each successful run of a schedule was created, oldest first.
    pub fn successes_of_schedule(&self, schedule_id: &str) -> Result<Vec<Ts>> {
        let mut st = self.conn.prepare("SELECT created_at FROM runs WHERE schedule_id = ? AND state = 'succeeded' ORDER BY created_at")?;
        let v = st.query_map([schedule_id], |r| Ok(Ts::from_timestamp_millis(r.get::<_, i64>(0)?).unwrap_or_default()))?.collect::<rusqlite::Result<_>>()?;
        Ok(v)
    }

    /// A schedule's runs that failed or were lost, oldest first.
    pub fn failures_of_schedule(&self, schedule_id: &str) -> Result<Vec<Run>> {
        self.runs_where("WHERE schedule_id = ? AND state IN ('failed', 'lost') ORDER BY created_at, rowid", &[&schedule_id])
    }

    /// The last run of a schedule that finished before `before`.
    pub fn previous_finished(&self, schedule_id: &str, before: Ts) -> Result<Option<Run>> {
        Ok(self
            .runs_where(
                "WHERE schedule_id = ? AND created_at < ? AND state NOT IN ('queued', 'running') ORDER BY created_at DESC, rowid DESC LIMIT 1",
                &[&schedule_id, &ms(before)],
            )?
            .pop())
    }

    /// The runs with these ids, in no particular order.
    pub fn runs_by_id(&self, ids: &[String]) -> Result<Vec<Run>> {
        let ids = serde_json::to_string(ids)?;
        self.runs_where("WHERE id IN (SELECT value FROM json_each(?))", &[&ids])
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

    /// A conversation with you is working: one you started, a reply, or a turn of an older build's chat, of
    /// one employee or of anyone. An answer coming back into a conversation is not one: nobody may be watching.
    pub fn ceo_conversation_running(&self, employee_id: Option<&str>) -> Result<bool> {
        Ok(self
            .conn
            .query_row(
                "SELECT 1 FROM runs WHERE state = 'running' AND json_valid(data) AND json_extract(data, '$.kind.type') IN ('chat', 'task', 'reply')
                   AND (?1 IS NULL OR employee_id = ?1) LIMIT 1",
                [employee_id],
                |_| Ok(()),
            )
            .optional()?
            .is_some())
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

#[cfg(test)]
mod tests {
    use super::*;
    use crate::threads;
    use chrono::Utc;
    use std::path::PathBuf;

    fn temp_dir() -> PathBuf {
        let dir = std::env::temp_dir().join(format!("omegastar-store-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    /// An employee reporting to `manager_id`, or to you.
    fn employee(name: &str, manager_id: Option<&str>) -> Employee {
        let id = uuid::Uuid::new_v4().to_string();
        Employee {
            id: id.clone(),
            slug: name.to_lowercase(),
            name: name.into(),
            title: "Tester".into(),
            description: String::new(),
            objective: String::new(),
            manager_id: manager_id.map(String::from),
            skills: SkillGrant { builtins: false, keys: vec![] },
            clearance: Clearance::Supervised,
            allow_rules: vec![],
            model: None,
            effort: None,
            browser: false,
            auto_tidy: false,
            workspaces: vec![format!("/office/employees/{id}")],
            hue: 0,
            image: None,
            chat_session: format!("chat-{name}"),
            hired_at: Utc::now(),
        }
    }

    /// A run in `state`, ended now if it is finished.
    fn run(e: &Employee, kind: RunKind, state: RunState) -> Run {
        let mut r = Run::new(&e.id, kind, "go".into(), Utc::now());
        r.state = state;
        if state.is_finished() {
            r.ended_at = Some(r.created_at);
        }
        r
    }

    /// Inserts a work-lane row of `e` as it is, readable or not.
    fn raw(db: &Store, e: &Employee, id: &str, state: &str, session: &str, data: &str) {
        db.conn
            .execute(
                "INSERT INTO runs(id, employee_id, lane, state, session, created_at, data) VALUES (?1, ?2, 'work', ?3, ?4, ?5, ?6)",
                params![id, e.id, state, session, ms(Utc::now()), data],
            )
            .unwrap();
    }

    /// A run's JSON with a kind this build does not know.
    fn future_kind(e: &Employee, state: RunState) -> (String, String) {
        let mut v = serde_json::to_value(run(e, RunKind::Manual, state)).unwrap();
        v["kind"] = serde_json::json!({ "type": "someFutureKind", "detail": "from a newer build" });
        (v["id"].as_str().unwrap().to_string(), v.to_string())
    }

    fn ids(runs: &[Run]) -> BTreeSet<String> {
        runs.iter().map(|r| r.id.clone()).collect()
    }

    #[test]
    fn the_opening_note_queries() {
        let dir = temp_dir();
        let db = Store::open(&dir.join("office.db")).unwrap();
        let ada = employee("Ada", None);
        db.save_employee(&ada).unwrap();
        let at = |mins: i64| Utc::now() - chrono::Duration::minutes(mins);
        let insert = |mut r: Run, mins: i64, session: &str| {
            r.created_at = at(mins);
            if r.state.is_finished() {
                r.ended_at = Some(at(mins - 1));
            }
            assert!(db.insert_run(&r, session).unwrap());
            r
        };
        let old = insert(run(&ada, RunKind::Chat, RunState::Succeeded), 120, "chat-1");
        let newer = insert(run(&ada, RunKind::Chat, RunState::Failed), 60, "chat-1");
        let now_turn = insert(run(&ada, RunKind::Chat, RunState::Running), 5, "chat-1");
        let report = insert(run(&ada, RunKind::Manual, RunState::Succeeded), 30, "m1");
        insert(run(&ada, RunKind::Manual, RunState::Queued), 2, "m2");

        let found: Vec<(String, String)> = db.finished_since(&ada.id, at(90)).unwrap().into_iter().map(|r| (r.run.id, r.session)).collect();
        assert_eq!(found, vec![(report.id.clone(), "m1".to_string()), (newer.id.clone(), "chat-1".to_string())]);
        assert_eq!(db.finished_since(&ada.id, at(200)).unwrap().len(), 3);

        assert_eq!(db.last_turn_ended("chat-1", &now_turn.id).unwrap(), newer.ended_at);
        assert_eq!(db.last_turn_ended("chat-1", &newer.id).unwrap(), old.ended_at);
        assert_eq!(db.last_turn_ended("m2", "x").unwrap(), None);

        let choices = || CardAsk::Choices { choices: vec!["Not now".into(), "Go".into()], recommended: 0 };
        let open = insert(with_card(run(&ada, RunKind::Manual, RunState::Succeeded), choices(), false), 50, "c1");
        let chore = insert(with_card(run(&ada, RunKind::Manual, RunState::Failed), CardAsk::Chore { subject: "chrome".into(), url: None }, false), 40, "c2");
        insert(with_card(run(&ada, RunKind::Manual, RunState::Succeeded), choices(), true), 45, "c3");
        insert(with_card(run(&ada, RunKind::Manual, RunState::Running), choices(), false), 3, "c4");
        assert_eq!(db.open_cards(&ada.id).unwrap().iter().map(|r| r.id.clone()).collect::<Vec<_>>(), vec![open.id, chore.id]);

        let asker = insert(run(&ada, RunKind::Manual, RunState::Succeeded), 100, "a1");
        insert(run(&ada, RunKind::Asked { parent_run_id: asker.id.clone(), asked_by: ada.id.clone(), task: false }, RunState::Succeeded), 20, "a2");
        insert(run(&ada, RunKind::Delegated { parent_run_id: "long-ago".into() }, RunState::Succeeded), 300, "a3");
        assert_eq!(db.parents_since(at(60)).unwrap(), HashSet::from([asker.id.clone()]));
        assert_eq!(db.parents_since(at(400)).unwrap(), HashSet::from([asker.id, "long-ago".to_string()]));

        drop(db);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn an_unreadable_row_is_left_out() {
        let dir = temp_dir();
        let db = Store::open(&dir.join("office.db")).unwrap();
        let ada = employee("Ada", None);
        db.save_employee(&ada).unwrap();
        let queued = run(&ada, RunKind::Manual, RunState::Queued);
        let mut done = run(&ada, RunKind::Manual, RunState::Succeeded);
        done.needs_you = vec!["Look at this.".into()];
        assert!(db.insert_run(&queued, &queued.id).unwrap());
        assert!(db.insert_run(&done, &done.id).unwrap());
        for state in [RunState::Queued, RunState::Succeeded] {
            let (id, data) = future_kind(&ada, state);
            raw(&db, &ada, &id, state.as_str(), &id, &data);
            let id = uuid::Uuid::new_v4().to_string();
            raw(&db, &ada, &id, state.as_str(), &id, "not json");
        }

        let queued_id = queued.id.clone();
        let both = ids(&[queued.clone(), done.clone()]);
        assert_eq!(ids(&db.recent_runs(None, 100).unwrap()), both);
        let records: Vec<Run> = db.records_in_state(RunState::Queued).unwrap().into_iter().map(|r| r.run).collect();
        assert_eq!(ids(&records), ids(std::slice::from_ref(&queued)));
        assert_eq!(ids(&db.runs_in_state(RunState::Queued).unwrap()), ids(&[queued]));
        assert_eq!(ids(&db.runs_in_state(RunState::Succeeded).unwrap()), ids(&[done.clone()]));
        let ada_only = std::slice::from_ref(&ada.id);
        assert_eq!(ids(&db.finished_root_runs(ada_only, ada_only).unwrap()), ids(&[done.clone()]));
        assert_eq!(ids(&db.reached_root_runs(ada_only, ada_only, 10).unwrap()), ids(&[done.clone()]));
        assert_eq!(ids(&db.open_cards(&ada.id).unwrap()), ids(&[]));
        assert!(db.open_topic_runs("chore:chrome").unwrap().is_empty());
        // The Inbox's other queries read the JSON in SQL too.
        assert!(db.reply_runs(None).unwrap().is_empty());
        assert!(db.open_tasks(&ada.id).unwrap().is_empty());
        assert!(db.archived_tasks(10).unwrap().is_empty());
        assert!(db.conversation_runs().unwrap().is_empty());
        assert!(db.open_asks().unwrap().is_empty());
        // So do the reply watch and Tidy.
        assert!(!db.has_run_for("req-1", "nudge").unwrap());
        assert!(db.active_run_for("req-1", "nudge").unwrap().is_none());
        assert!(db.tidy_runs(&ada.id).unwrap().is_empty());
        assert!(db.taught_since(&ada.id, None, 10).unwrap().is_empty());
        // And the hand-off queries.
        assert!(db.replaced_cards(&ada.id, Utc::now() - chrono::Duration::days(1)).unwrap().is_empty());
        raw(&db, &ada, "bad-handoff", "succeeded", "s-bad", "not json");
        db.conn.execute("UPDATE runs SET parent_run_id = ?1 WHERE id = 'bad-handoff'", [&queued_id]).unwrap();
        assert!(db.chain_handoffs("c1").unwrap().is_empty());
        assert!(db.noted_in("r1").unwrap().is_empty());
        assert_eq!(db.delegated_since(&ada.id, &ada.id, Utc::now() - chrono::Duration::days(1)).unwrap(), 0);
        assert_eq!(db.session_size("s-bad").unwrap().1, None);
        let now = ms(Utc::now());
        db.conn
            .execute(
                "INSERT INTO requests(id, person_id, employee_id, state, created_at, data) VALUES ('req-1', 'p1', ?1, 'open', ?2, 'not json')",
                params![ada.id, now],
            )
            .unwrap();
        assert!(db.watched_requests().unwrap().is_empty());
        assert!(db.requests_of_run(&queued_id).unwrap().is_empty());

        drop(db);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn unreadable_running_rows_are_lost() {
        let dir = temp_dir();
        let db = Store::open(&dir.join("office.db")).unwrap();
        let ada = employee("Ada", None);
        db.save_employee(&ada).unwrap();
        let (future, data) = future_kind(&ada, RunState::Running);
        raw(&db, &ada, &future, "running", "s1", &data);
        raw(&db, &ada, "corrupt", "running", "s2", "not json");

        let at = Utc::now();
        assert_eq!(db.lose_unreadable_running(at, "Stopped.").unwrap(), 2);
        let state = |id: &str| -> String { db.conn.query_row("SELECT state FROM runs WHERE id = ?", [id], |r| r.get(0)).unwrap() };
        assert_eq!(state(&future), "lost");
        assert_eq!(state("corrupt"), "lost");
        let (json_state, ended, error): (String, String, String) = db
            .conn
            .query_row(
                "SELECT json_extract(data, '$.state'), json_extract(data, '$.endedAt'), json_extract(data, '$.error') FROM runs WHERE id = ?",
                [&future],
                |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)),
            )
            .unwrap();
        assert_eq!(json_state, "lost");
        assert_eq!(ended.parse::<Ts>().unwrap(), at);
        assert_eq!(error, "Stopped.");
        let corrupt: String = db.conn.query_row("SELECT data FROM runs WHERE id = 'corrupt'", [], |r| r.get(0)).unwrap();
        assert_eq!(corrupt, "not json");

        for session in ["s1", "s2"] {
            let next = run(&ada, RunKind::Manual, RunState::Running);
            assert!(db.insert_run(&next, session).unwrap(), "a new run takes {session}");
        }

        drop(db);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn an_old_office_still_opens() {
        let dir = temp_dir();
        let path = dir.join("office.db");
        let old = Connection::open(&path).unwrap();
        old.execute_batch(
            r#"
CREATE TABLE meta(key TEXT PRIMARY KEY, value TEXT NOT NULL);
CREATE TABLE employees(id TEXT PRIMARY KEY, slug TEXT NOT NULL UNIQUE, departed_at INTEGER, data TEXT NOT NULL);
CREATE TABLE people(id TEXT PRIMARY KEY, removed_at INTEGER, data TEXT NOT NULL);
CREATE TABLE schedules(id TEXT PRIMARY KEY, employee_id TEXT NOT NULL, last_slot INTEGER NOT NULL, data TEXT NOT NULL);
CREATE TABLE runs(
  id TEXT PRIMARY KEY,
  employee_id TEXT NOT NULL,
  lane TEXT NOT NULL,
  state TEXT NOT NULL,
  schedule_id TEXT,
  slot INTEGER,
  parent_run_id TEXT,
  request_id TEXT,
  session TEXT NOT NULL,
  inited INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  data TEXT NOT NULL,
  UNIQUE(schedule_id, slot)
);
CREATE UNIQUE INDEX runs_one_running_per_lane ON runs(employee_id, lane) WHERE state = 'running';
INSERT INTO meta(key, value) VALUES ('settings', '{"maxConcurrentRuns":2,"claudePath":null,"dataDir":"/office","paused":false}');
INSERT INTO employees(id, slug, data) VALUES ('e1', 'ada', '{"id":"e1","slug":"ada","name":"Ada","title":"Analyst","description":"","objective":"Keep the numbers right.","managerId":null,"skills":{"builtins":true,"keys":[]},"clearance":"supervised","allowRules":[],"model":null,"effort":null,"workspaces":["/office/employees/e1/workspace"],"hue":200,"chatSession":"chat-e1","hiredAt":"2026-09-20T09:00:00Z"}');
INSERT INTO runs(id, employee_id, lane, state, session, inited, created_at, data) VALUES ('r1', 'e1', 'work', 'succeeded', 'r1', 1, 1759050000000, '{"id":"r1","employeeId":"e1","kind":{"type":"manual"},"prompt":"Check the numbers.","state":"succeeded","createdAt":"2026-09-28T09:00:00Z","startedAt":"2026-09-28T09:00:01Z","endedAt":"2026-09-28T09:05:00Z","turns":4,"durationMs":299000,"costUsd":0.12,"summary":"All good.","error":null,"needsYou":[]}');
"#,
        )
        .unwrap();
        drop(old);

        let db = Store::open(&path).unwrap();
        let mut st = db.conn.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").unwrap();
        let tables: BTreeSet<String> = st.query_map([], |r| r.get(0)).unwrap().collect::<rusqlite::Result<_>>().unwrap();
        drop(st);
        for t in ["checks", "proposals", "skill_revisions", "requests", "news", "skill_use"] {
            assert!(tables.contains(t), "{t} created");
        }
        let lane_index: Option<String> =
            db.conn.query_row("SELECT name FROM sqlite_master WHERE name = 'runs_one_running_per_lane'", [], |r| r.get(0)).optional().unwrap();
        assert_eq!(lane_index, None);

        let r = db.run("r1").unwrap().unwrap().run;
        assert!(r.allow_once.is_empty() && r.denials.is_empty() && r.skill_changes.is_empty() && r.attachments.is_empty());
        assert_eq!(r.proposed, None);
        let e = db.employee("e1").unwrap().unwrap();
        assert!(e.browser);
        assert!(e.auto_tidy);
        let s = db.settings().unwrap().unwrap();
        assert_eq!(s.max_concurrent_runs, 2);
        assert_eq!(s.backup, BackupSettings::default());
        assert_eq!(s.watch, WatchSettings::default());
        assert_eq!((s.notifications.mode, s.notifications.quiet), (NotifyMode::Batched, None));

        drop(db);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn news_is_unread_until_marked() {
        let dir = temp_dir();
        let db = Store::open(&dir.join("office.db")).unwrap();
        let (ada, bo) = (employee("Ada", None), employee("Bo", None));
        let news = |text: &str, mins: i64| News {
            id: uuid::Uuid::new_v4().to_string(),
            employee_id: bo.id.clone(),
            from: ada.id.clone(),
            text: text.into(),
            created_at: Utc::now() - chrono::Duration::minutes(mins),
            read_at: None,
            read_in: None,
        };
        let (later, earlier) = (news("The till is counted.", 5), news("The shelf is counted.", 10));
        db.save_news(&later).unwrap();
        db.save_news(&earlier).unwrap();
        let unread: Vec<String> = db.unread_news(&bo.id).unwrap().into_iter().map(|n| n.text).collect();
        assert_eq!(unread, vec!["The shelf is counted.", "The till is counted."], "oldest first");
        assert!(db.unread_news(&ada.id).unwrap().is_empty());
        db.save_news(&News { read_at: Some(Utc::now()), read_in: Some("r1".into()), ..earlier.clone() }).unwrap();
        assert_eq!(db.unread_news(&bo.id).unwrap(), vec![later.clone()]);

        // The run that showed it never started, so the next one shows it again.
        assert_eq!(db.unread_news_of("r2").unwrap(), 0);
        assert_eq!(db.unread_news_of("r1").unwrap(), 1);
        assert_eq!(db.unread_news(&bo.id).unwrap(), vec![earlier, later]);

        drop(db);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn answered_cards_are_your_decisions_this_session_has_not_heard() {
        let dir = temp_dir();
        let db = Store::open(&dir.join("office.db")).unwrap();
        let ada = employee("Ada", None);
        let card = |question: &str, ask: CardAsk, how: AnswerHow, mins: i64, held: bool| {
            let mut c = Card::new(question, None, Some(format!("ask:{question}")), ask);
            c.answer = Some(CardAnswer { at: Utc::now() - chrono::Duration::minutes(mins), how, text: "Chose: Book.".into(), held });
            c
        };
        let choices = || CardAsk::Choices { choices: vec!["Book".into()], recommended: 0 };
        // This build first opened the office 25 minutes ago.
        db.set_meta("typed_answers_since", &(Utc::now() - chrono::Duration::minutes(25))).unwrap();
        let mut r = run(&ada, RunKind::Manual, RunState::Succeeded);
        r.cards = vec![
            card("Book the room?", choices(), AnswerHow::Tapped, 30, false),
            card("Order lunch?", choices(), AnswerHow::Rejected, 10, false),
            card("Which caterer?", choices(), AnswerHow::Typed, 20, false),
            card("Which florist?", choices(), AnswerHow::Typed, 40, false),
            card("Print menus?", choices(), AnswerHow::Dismissed, 5, false),
            card("Move chairs?", choices(), AnswerHow::Replaced, 5, false),
            card("Hang the sign?", choices(), AnswerHow::Withdrawn, 5, false),
            card("Count the till?", choices(), AnswerHow::Tapped, 2, true),
            card("Sign in?", CardAsk::Chore { subject: "sign-in:example.com".into(), url: None }, AnswerHow::Tapped, 2, false),
            card("Paint the wall?", choices(), AnswerHow::Tapped, 60 * 24 * 8, false),
        ];
        assert!(db.insert_run(&r, "s1").unwrap());
        let week = Utc::now() - chrono::Duration::days(7);
        let found: Vec<String> = db.answered_cards(&ada.id, week, "s2").unwrap().into_iter().map(|c| c.message).collect();
        assert_eq!(found, ["Order lunch?", "Which caterer?", "Book the room?"], "your taps, words and noes this week, newest first");
        assert!(!found.contains(&"Which florist?".to_string()), "words typed before this build may be an older build's reply put on every card");
        assert!(db.answered_cards(&ada.id, week, "s1").unwrap().is_empty(), "the session they came back to heard them");
        assert!(db.answered_cards(&employee("Bo", None).id, week, "s2").unwrap().is_empty());

        drop(db);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn a_skill_keeps_its_latest_use() {
        let dir = temp_dir();
        let db = Store::open(&dir.join("office.db")).unwrap();
        let (used, since) = db.skill_use("e1").unwrap();
        assert!(used.is_empty() && since <= Utc::now());
        let at = |days: i64| Utc::now() - chrono::Duration::days(days);
        let (three, one, five) = (at(3), at(1), at(5));
        let skills = |names: &[&str]| names.iter().map(|n| n.to_string()).collect::<HashSet<_>>();
        db.record_skill_use("e1", &skills(&["ada-invoices", "ada-payroll"]), three).unwrap();
        db.record_skill_use("e1", &skills(&["ada-invoices"]), one).unwrap();
        db.record_skill_use("e1", &skills(&["ada-payroll"]), five).unwrap();
        let mut used: Vec<(String, i64)> = db.skill_use("e1").unwrap().0.into_iter().map(|(s, t)| (s, t.timestamp_millis())).collect();
        used.sort();
        assert_eq!(used, [("ada-invoices".to_string(), one.timestamp_millis()), ("ada-payroll".to_string(), three.timestamp_millis())], "an older use never hides a newer one");
        assert!(db.skill_use("e2").unwrap().0.is_empty());
        drop(db);
        let db = Store::open(&dir.join("office.db")).unwrap();
        assert_eq!(db.skill_use("e1").unwrap().1, since, "counting began once");

        drop(db);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn taught_since_keeps_only_your_own_words() {
        let dir = temp_dir();
        let db = Store::open(&dir.join("office.db")).unwrap();
        let ada = employee("Ada", None);
        db.save_employee(&ada).unwrap();
        let report = run(&ada, RunKind::Manual, RunState::Succeeded);
        db.insert_run(&report, &report.id).unwrap();
        let reply = |prompt: &str, omega_wrote: bool| {
            let mut r = Run::new(&ada.id, RunKind::Reply { to_run_id: report.id.clone(), label: "Manual run".into(), task: false, card: false }, prompt.into(), Utc::now());
            r.omega_wrote = omega_wrote;
            db.insert_run(&r, &r.id).unwrap();
        };
        // An approval from the app, and a reply of yours wrapped because the report's session never started.
        reply("Pat allowed the build for this retry.", true);
        reply("Your report (Manual run):\n\nIt failed.\n\nPat's reply:\n\nTry the other folder.", false);
        let came = RunKind::Answered { asked_run_id: "r1".into(), from: "e0".into(), task: false, chat: false, thread: Some(report.id.clone()) };
        let mut answer = Run::new(&ada.id, came, "Bo answered your question.".into(), Utc::now());
        answer.omega_wrote = true;
        db.insert_run(&answer, &report.id).unwrap();

        let taught: Vec<String> = db.taught_since(&ada.id, None, 10).unwrap().into_iter().map(|(_, t)| t).collect();
        assert_eq!(taught.len(), 1, "{taught:?}");
        assert!(taught[0].ends_with("Try the other folder."));

        drop(db);
        let _ = std::fs::remove_dir_all(&dir);
    }

    fn tables(db: &Store) -> BTreeSet<String> {
        let mut st = db.conn.prepare("SELECT name FROM sqlite_master WHERE type IN ('table', 'index')").unwrap();
        let v = st.query_map([], |r| r.get(0)).unwrap().collect::<rusqlite::Result<_>>().unwrap();
        v
    }

    #[test]
    fn a_briefs_table_is_left_alone() {
        let dir = temp_dir();
        let path = dir.join("office.db");
        let db = Store::open(&path).unwrap();
        let ada = employee("Ada", None);
        db.save_employee(&ada).unwrap();
        let done = run(&ada, RunKind::Manual, RunState::Succeeded);
        assert!(db.insert_run(&done, &done.id).unwrap());
        // As an older build left it.
        let brief = r#"{"id":"b1","employeeId":"e1","rootRunId":"r1","label":"Manual run","replies":1,"excerpt":"Done.","text":"Settled."}"#;
        db.conn
            .execute_batch(
                "CREATE TABLE IF NOT EXISTS briefs(
  id TEXT PRIMARY KEY, employee_id TEXT NOT NULL, session TEXT NOT NULL, created_at INTEGER NOT NULL, consumed_at INTEGER, data TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS briefs_by_session ON briefs(employee_id, session, created_at);",
            )
            .unwrap();
        db.conn.execute("INSERT INTO briefs(id, employee_id, session, created_at, data) VALUES ('b1', 'e1', 's1', 1, ?)", [brief]).unwrap();
        drop(db);

        let db = Store::open(&path).unwrap();
        assert_eq!(db.run(&done.id).unwrap().unwrap().run, done);
        assert_eq!(ids(&db.recent_runs(None, 10).unwrap()), ids(&[done]));
        let t = tables(&db);
        assert!(t.contains("briefs") && t.contains("briefs_by_session"), "the briefs table stays");
        let rows: Vec<(String, String)> = {
            let mut st = db.conn.prepare("SELECT id, data FROM briefs").unwrap();
            let v = st.query_map([], |r| Ok((r.get(0)?, r.get(1)?))).unwrap().collect::<rusqlite::Result<_>>().unwrap();
            v
        };
        assert_eq!(rows, vec![("b1".to_string(), brief.to_string())]);

        drop(db);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn a_fresh_office_has_no_briefs_table() {
        let dir = temp_dir();
        let db = Store::open(&dir.join("office.db")).unwrap();
        let t = tables(&db);
        assert!(t.contains("runs"));
        assert!(!t.contains("briefs") && !t.contains("briefs_by_session"));

        drop(db);
        let _ = std::fs::remove_dir_all(&dir);
    }

    fn with_card(mut r: Run, ask: CardAsk, answered: bool) -> Run {
        let mut card = Card::new("Needs you.", None, Some("ask:boost".into()), ask);
        card.answer = answered.then(|| CardAnswer { at: Utc::now(), how: AnswerHow::Tapped, text: "Chose: Not now.".into(), held: false });
        r.cards = vec![card];
        r
    }

    #[test]
    fn a_runs_one_card_becomes_its_list_once() {
        let dir = temp_dir();
        let db = Store::open(&dir.join("office.db")).unwrap();
        let ada = employee("Ada", None);
        db.save_employee(&ada).unwrap();
        let old = |id: &str, card: serde_json::Value| {
            let mut v = serde_json::to_value(run(&ada, RunKind::Manual, RunState::Succeeded)).unwrap();
            v["id"] = id.into();
            v.as_object_mut().unwrap().remove("cards");
            v["card"] = card;
            raw(&db, &ada, id, "succeeded", id, &v.to_string());
        };
        old("chore", serde_json::json!({ "message": "Open Chrome.", "ask": { "type": "chore", "subject": "chrome" }, "answer": null }));
        old("choice", serde_json::json!({ "message": "Boost?", "ask": { "type": "choices", "choices": ["No", "Yes"], "recommended": 0 }, "answer": null }));
        old("none", serde_json::Value::Null);
        db.conn.execute("DELETE FROM meta WHERE key = 'cards_listed'", []).unwrap();
        db.migrate_cards().unwrap();
        let get = |id: &str| db.run(id).unwrap().unwrap().run;
        assert_eq!(get("chore").cards[0].key.as_deref(), Some("chore:chrome"), "a chore gets its key");
        assert_eq!(get("choice").cards.len(), 1);
        assert!(get("none").cards.is_empty());
        let raw_json: String = db.conn.query_row("SELECT data FROM runs WHERE id = 'choice'", [], |r| r.get(0)).unwrap();
        assert!(!raw_json.contains("\"card\""), "{raw_json}");
        assert_eq!(ids(&db.open_topic_runs("chore:chrome").unwrap()), ids(&[get("chore")]));
        assert_eq!(ids(&db.open_cards(&ada.id).unwrap()), ids(&[get("chore"), get("choice")]));
        drop(db);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn revisions_of_dependency_and_data_files_are_dropped_once() {
        let dir = temp_dir();
        let db = Store::open(&dir.join("office.db")).unwrap();
        let ada = employee("Ada", None);
        db.save_employee(&ada).unwrap();
        let revise = |skill: &str, file: &str| {
            let change = SkillChange { skill: skill.into(), file: file.into(), change: ChangeKind::Added };
            db.insert_revision(&ada.id, &SkillRevision { change, id: uuid::Uuid::new_v4().to_string(), run_id: None, at: Utc::now(), before: None, after: Some("x".into()) }).unwrap();
        };
        let left_out = ["node_modules/left-pad/index.js", "scripts/__pycache__/a.pyc", ".venv/lib/x.py", ".git/HEAD", "data/pull.json", "log.JSONL", "rates.csv"];
        let kept = ["SKILL.md", "scripts/fetch.py", "examples.md", ".github/notes.md", "jsonfeed.md"];
        for f in left_out.iter().chain(&kept) {
            revise("ada-reports", f);
        }
        revise(crate::own_skills::NOTES, "rates.csv.md");
        db.conn.execute("DELETE FROM meta WHERE key = 'unrecorded_revisions_dropped'", []).unwrap();
        db.drop_unrecorded_revisions().unwrap();
        let files = || db.revisions(&ada.id).unwrap().into_iter().map(|r| r.change.file).collect::<BTreeSet<_>>();
        let mut want: BTreeSet<String> = kept.iter().map(|f| f.to_string()).collect();
        want.insert("rates.csv.md".into());
        assert_eq!(files(), want);
        revise("ada-reports", "late.json");
        db.drop_unrecorded_revisions().unwrap();
        assert!(files().contains("late.json"), "it runs once");
        drop(db);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn open_cards_are_found_by_chore_and_by_schedule() {
        let dir = temp_dir();
        let db = Store::open(&dir.join("office.db")).unwrap();
        let ada = employee("Ada", None);
        db.save_employee(&ada).unwrap();
        let chrome = || CardAsk::Chore { subject: "chrome".into(), url: None };
        let choices = || CardAsk::Choices { choices: vec!["Not now".into(), "Go".into()], recommended: 0 };
        let insert = |r: Run| {
            assert!(db.insert_run(&r, &r.id).unwrap());
            r
        };
        let waiting = insert(with_card(run(&ada, RunKind::Manual, RunState::Failed), chrome(), false));
        insert(with_card(run(&ada, RunKind::Manual, RunState::Succeeded), chrome(), true));
        let held = insert(with_card(run(&ada, RunKind::Manual, RunState::Queued), chrome(), false));
        insert(with_card(run(&ada, RunKind::Manual, RunState::Running), chrome(), false));
        insert(with_card(run(&ada, RunKind::Chat, RunState::Succeeded), chrome(), false));
        insert(with_card(run(&ada, RunKind::Manual, RunState::Succeeded), CardAsk::Chore { subject: "sign-in:acme".into(), url: None }, false));
        insert(with_card(run(&ada, RunKind::Manual, RunState::Succeeded), choices(), false));
        assert_eq!(ids(&db.open_topic_runs("chore:chrome").unwrap()), ids(&[waiting, held]), "a run held for the usage limit still waits; a chat turn never does");

        let at = |mins: i64| Utc::now() - chrono::Duration::minutes(mins);
        let scheduled = |id: &str, mins: i64, ask: CardAsk, answered: bool| {
            let kind = RunKind::Scheduled { schedule_id: id.into(), slot: at(mins), label: "Sweep".into(), quiet: true, model: None, effort: None, review: false };
            let mut r = run(&ada, kind, RunState::Succeeded);
            r.created_at = at(mins);
            insert(with_card(r, ask, answered))
        };
        let older = scheduled("s1", 30, choices(), false);
        let items = CardAsk::Items { verb: "Post".into(), items: vec![CardItem { id: "d1".into(), text: "Draft".into(), about: None, recommended: true }] };
        let older_items = scheduled("s1", 20, items, false);
        scheduled("s1", 15, choices(), true);
        // Put off with Later, it still waits on you.
        let mut put_off = scheduled("s1", 14, choices(), true);
        put_off.cards[0].back_at = Some(at(-60));
        db.save_run(&put_off).unwrap();
        scheduled("s1", 12, chrome(), false);
        scheduled("s2", 10, choices(), false);
        let newer = scheduled("s1", 5, choices(), false);
        let found = db.open_cards_of_schedule("s1", newer.created_at).unwrap();
        assert_eq!(found.iter().map(|r| r.id.clone()).collect::<Vec<_>>(), vec![older.id, older_items.id, put_off.id]);

        drop(db);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn cards_said_later_to_parked_and_withdrawn_are_found() {
        let dir = temp_dir();
        let db = Store::open(&dir.join("office.db")).unwrap();
        let (ada, bo) = (employee("Ada", None), employee("Bo", None));
        db.save_employee(&ada).unwrap();
        db.save_employee(&bo).unwrap();
        let now = Utc::now();
        let insert = |e: &Employee, state: RunState, mins: i64, f: &dyn Fn(&mut Card)| {
            let mut r = with_card(run(e, RunKind::Manual, state), CardAsk::Choices { choices: vec!["Go".into()], recommended: 0 }, true);
            r.created_at = now - chrono::Duration::minutes(mins);
            f(&mut r.cards[0]);
            assert!(db.insert_run(&r, &r.id).unwrap());
            r
        };
        // Due a moment ago, a fraction of a second from now, and tomorrow; one is due but still working.
        let due = insert(&ada, RunState::Succeeded, 30, &|c| c.back_at = Some(now - chrono::Duration::milliseconds(1500)));
        let just = insert(&ada, RunState::Succeeded, 20, &|c| c.back_at = Some(now + chrono::Duration::milliseconds(300)));
        let tomorrow = insert(&ada, RunState::Succeeded, 10, &|c| c.back_at = Some(now + chrono::Duration::days(1)));
        insert(&ada, RunState::Running, 5, &|c| c.back_at = Some(now - chrono::Duration::hours(1)));
        assert_eq!(ids(&db.cards_due_back(now).unwrap()), ids(std::slice::from_ref(&due)));
        assert_eq!(ids(&db.cards_due_back(now + chrono::Duration::seconds(1)).unwrap()), ids(&[due.clone(), just.clone()]));

        let older = insert(&ada, RunState::Succeeded, 40, &|c| c.parked = true);
        let newer = insert(&bo, RunState::Succeeded, 1, &|c| c.parked = true);
        // Put off or parked, a card still waits on you: a newer one about the same thing replaces it, and an answer reaches it.
        assert_eq!(ids(&db.open_topic_runs("ask:boost").unwrap()), ids(&[due, just, tomorrow, older.clone(), newer.clone()]));
        assert_eq!(db.parked_runs().unwrap().iter().map(|r| r.id.clone()).collect::<Vec<_>>(), vec![newer.id.clone(), older.id.clone()], "newest first");
        db.depart_employee(&bo.id, now).unwrap();
        assert_eq!(ids(&db.parked_runs().unwrap()), ids(&[older]), "only people still here");

        let withdrawn = |mins: i64| move |c: &mut Card| c.answer = Some(CardAnswer { at: now - chrono::Duration::minutes(mins), how: AnswerHow::Withdrawn, text: "Settled.".into(), held: false });
        insert(&ada, RunState::Succeeded, 50, &withdrawn(30));
        assert!(!db.withdrew_since(&ada.id, "ask:boost", now - chrono::Duration::minutes(15)).unwrap(), "half an hour ago");
        insert(&ada, RunState::Succeeded, 50, &withdrawn(5));
        assert!(db.withdrew_since(&ada.id, "ask:boost", now - chrono::Duration::minutes(15)).unwrap());
        assert!(!db.withdrew_since(&bo.id, "ask:boost", now - chrono::Duration::minutes(15)).unwrap(), "someone else's");
        assert!(!db.withdrew_since(&ada.id, "ask:other", now - chrono::Duration::minutes(15)).unwrap());
        drop(db);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn a_due_check_is_run_once() {
        let dir = temp_dir();
        let db = Store::open(&dir.join("office.db")).unwrap();
        let ada = employee("Ada", None);
        db.save_employee(&ada).unwrap();
        let now = Utc::now();
        let check = |state: CheckState, due_at: Ts| {
            let c = Check {
                id: uuid::Uuid::new_v4().to_string(),
                employee_id: ada.id.clone(),
                what: "Did the fix hold".into(),
                how: "Rerun the weekly report".into(),
                due_at,
                state,
                created_at: now - chrono::Duration::days(3),
                run_id: None,
                closed_at: None,
                result: None,
            };
            db.save_check(&c).unwrap();
            c
        };
        let hour = chrono::Duration::hours(1);
        let due = check(CheckState::Open, now - hour);
        check(CheckState::Open, now + hour);
        check(CheckState::Done, now - hour);
        check(CheckState::Dropped, now - hour);
        let to_run = |db: &Store| db.checks_to_run(now).unwrap().into_iter().map(|c| c.id).collect::<Vec<_>>();
        assert_eq!(to_run(&db), vec![due.id.clone()]);

        let kind = RunKind::Scheduled { schedule_id: format!("{CHECK_PREFIX}{}", due.id), slot: due.due_at, label: "Check: Did the fix hold".into(), quiet: true, model: None, effort: None, review: false };
        let first = Run::new(&ada.id, kind.clone(), "go".into(), now);
        assert!(db.insert_run(&first, &first.id).unwrap());
        assert!(to_run(&db).is_empty());
        let again = Run::new(&ada.id, kind, "go".into(), now);
        assert!(!db.insert_run(&again, &again.id).unwrap());

        drop(db);
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// One of each kind of run. `i` makes its ids unique, since `insert_run` skips a second run of the
    /// same schedule slot or follow-up.
    fn every_kind(i: usize) -> Vec<RunKind> {
        let slot = Utc::now();
        let person = || "p1".to_string();
        vec![
            RunKind::Manual,
            RunKind::Chat,
            RunKind::Scheduled { schedule_id: format!("loud-{i}"), slot, label: "Sweep".into(), quiet: false, model: None, effort: None, review: false },
            RunKind::Scheduled { schedule_id: format!("quiet-{i}"), slot, label: "Sweep".into(), quiet: true, model: None, effort: None, review: false },
            RunKind::Scheduled { schedule_id: format!("review-{i}"), slot, label: "Weekly review".into(), quiet: false, model: None, effort: None, review: true },
            RunKind::Scheduled { schedule_id: format!("{CHECK_PREFIX}short-{i}"), slot, label: "Check: Did it ship".into(), quiet: true, model: None, effort: None, review: false },
            RunKind::Scheduled { schedule_id: format!("{CHECK_PREFIX}long-{i}"), slot, label: "Check: Did it ship".into(), quiet: true, model: None, effort: None, review: false },
            RunKind::Delegated { parent_run_id: format!("parent-{i}") },
            RunKind::Asked { parent_run_id: format!("parent-{i}"), asked_by: "e0".into(), task: false },
            RunKind::Answered { asked_run_id: format!("asked-{i}"), from: "e0".into(), task: false, chat: false, thread: None },
            RunKind::Answered { asked_run_id: format!("asked-chat-{i}"), from: "e0".into(), task: true, chat: true, thread: None },
            RunKind::Answered { asked_run_id: format!("asked-thread-{i}"), from: "e0".into(), task: false, chat: false, thread: Some(format!("task-{i}")) },
            RunKind::FollowUp { request_id: format!("request-{i}"), person_id: person() },
            RunKind::Organize { imported: vec![], settled: false },
            RunKind::Reply { to_run_id: format!("root-{i}"), label: "Manual run".into(), task: false, card: false },
            RunKind::Reply { to_run_id: format!("card-{i}"), label: "Sweep".into(), task: false, card: true },
            RunKind::Task { label: "Draft it".into(), from: None, context: String::new() },
            RunKind::HireDecided { proposal_id: format!("proposal-{i}"), approved: true },
            RunKind::Tidy { reason: TidyReason::Auto, signature: vec![], plan: None },
            RunKind::ReplyCheck { request_id: format!("request-{i}"), person_id: person() },
            RunKind::Nudge { request_id: format!("request-{i}"), person_id: person() },
            RunKind::Unanswered { request_id: format!("request-{i}"), person_id: person() },
        ]
    }

    #[test]
    fn the_inbox_query_matches_reaches_you() {
        let dir = temp_dir();
        let db = Store::open(&dir.join("office.db")).unwrap();
        let ada = employee("Ada", None);
        let bo = employee("Bo", Some(&ada.id));
        db.save_employee(&ada).unwrap();
        db.save_employee(&bo).unwrap();
        let states = [RunState::Queued, RunState::Running, RunState::Succeeded, RunState::Failed, RunState::Cancelled, RunState::Lost];
        let denial = Denial { tool: "Bash".into(), brief: "rm -rf build".into(), suggested_rule: "Bash(rm:*)".into() };

        let mut all = vec![];
        let mut i = 0;
        for e in [&ada, &bo] {
            for state in states {
                for flag in [false, true] {
                    for blocked in [false, true] {
                        i += 1;
                        for (j, kind) in every_kind(i).into_iter().enumerate() {
                            let mut r = run(e, kind, state);
                            // A due check's run that worked for long reports like other work.
                            if r.kind.check_id().is_some_and(|c| c.starts_with("long")) {
                                r.duration_ms = Some(threads::CHECK_QUIET_MS + 1);
                            }
                            if flag {
                                r.needs_you = vec!["Look at this.".into()];
                            }
                            if j % 2 == 0 {
                                r.replied_at = Some(Utc::now());
                            }
                            r.steered = (i + j) % 3 == 0;
                            if blocked {
                                r.denials = vec![denial.clone()];
                            }
                            assert!(db.insert_run(&r, &r.id).unwrap(), "inserted {:?}", r.kind);
                            all.push(r);
                        }
                    }
                }
            }
        }

        let got = ids(&db.finished_root_runs(std::slice::from_ref(&ada.id), &[ada.id.clone(), bo.id.clone()]).unwrap());
        let want: BTreeSet<String> =
            all.iter().filter(|r| threads::reaches_you(r, false, r.employee_id == ada.id) && threads::could_need_you(r)).map(|r| r.id.clone()).collect();
        let differ: Vec<String> = all
            .iter()
            .filter(|r| got.contains(&r.id) != want.contains(&r.id))
            .map(|r| format!("{:?} {:?} needs_you {} denials {} top {}", r.kind, r.state, r.needs_you.len(), r.denials.len(), r.employee_id == ada.id))
            .collect();
        assert!(differ.is_empty(), "the query and reaches_you differ on {differ:#?}");
        assert!(!want.is_empty());

        drop(db);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn the_weekly_review_counts() {
        let dir = temp_dir();
        let db = Store::open(&dir.join("office.db")).unwrap();
        let (ada, bo) = (employee("Ada", None), employee("Bo", Some("x")));
        db.save_employee(&ada).unwrap();
        db.save_employee(&bo).unwrap();
        let at = |hours: i64| Utc::now() - chrono::Duration::hours(hours);
        let since = at(24 * 7);
        let insert = |e: &Employee, kind: RunKind, state: RunState, hours: i64| {
            let mut r = run(e, kind, state);
            r.created_at = at(hours);
            assert!(db.insert_run(&r, &r.id).unwrap());
            r
        };
        let scheduled = |id: &str, label: &str, quiet: bool, review: bool, hours: i64| RunKind::Scheduled {
            schedule_id: id.into(),
            slot: at(hours),
            label: label.into(),
            quiet,
            model: None,
            effort: None,
            review,
        };
        insert(&ada, scheduled("s1", "Sweep", true, false, 1), RunState::Succeeded, 1);
        let mut notified = run(&ada, scheduled("s1", "Sweep", true, false, 2), RunState::Succeeded);
        notified.created_at = at(2);
        notified.needs_you = vec!["Look at this.".into()];
        assert!(db.insert_run(&notified, &notified.id).unwrap());
        let asker = insert(&ada, scheduled("s1", "Sweep", true, false, 3), RunState::Succeeded, 3);
        insert(&bo, RunKind::Asked { parent_run_id: asker.id.clone(), asked_by: ada.id.clone(), task: false }, RunState::Succeeded, 3);
        insert(&ada, scheduled("s1", "Sweep", true, false, 4), RunState::Failed, 4);
        insert(&ada, scheduled("s1", "Sweep", true, false, 300), RunState::Succeeded, 300);
        insert(&ada, scheduled("s1", "Sweep", true, false, 0), RunState::Queued, 0);
        insert(&ada, scheduled("s2", "Post", false, false, 5), RunState::Succeeded, 5);
        insert(&ada, scheduled("r1", "Weekly review", false, true, 6), RunState::Succeeded, 6);
        insert(&ada, scheduled("check:c1", "Check: Did it hold", true, false, 7), RunState::Succeeded, 7);
        insert(&bo, scheduled("s3", "Bo's sweep", true, false, 8), RunState::Succeeded, 8);

        let counts: Vec<(String, bool, u32, u32, u32)> =
            db.routine_counts(Some(&ada.id), since).unwrap().into_iter().map(|c| (c.label, c.quiet, c.runs, c.reached, c.failed)).collect();
        assert_eq!(counts, vec![("Sweep".to_string(), true, 4, 2, 1), ("Post".to_string(), false, 1, 0, 0)]);

        let delegated = insert(&ada, RunKind::Delegated { parent_run_id: "p1".into() }, RunState::Succeeded, 10);
        let chat = insert(&ada, RunKind::Chat, RunState::Succeeded, 10);
        let tidy = insert(&ada, RunKind::Tidy { reason: TidyReason::Auto, signature: vec![], plan: None }, RunState::Succeeded, 10);
        let revise = |r: &Run, skill: &str, hours: i64| {
            let change = SkillChange { skill: skill.into(), file: "SKILL.md".into(), change: ChangeKind::Modified };
            let rev = SkillRevision { change, id: uuid::Uuid::new_v4().to_string(), run_id: Some(r.id.clone()), at: at(hours), before: None, after: Some("x".into()) };
            db.insert_revision(&ada.id, &rev).unwrap();
            rev.id
        };
        let older = revise(&delegated, "ops", 9);
        revise(&chat, "ops", 8);
        revise(&tidy, "ops", 7);
        revise(&delegated, "@company", 6);
        let newer = revise(&asker, "ops", 2);
        revise(&delegated, "ops", 400);
        let found: Vec<(String, String)> = db.unattended_revisions(&ada.id, since).unwrap().into_iter().map(|(rev, r)| (rev.id, r.id)).collect();
        assert_eq!(found, vec![(newer, asker.id.clone()), (older, delegated.id.clone())]);
        assert!(db.unattended_revisions(&bo.id, since).unwrap().is_empty());

        drop(db);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn a_conversation_with_you_is_found_while_it_runs() {
        let dir = temp_dir();
        let db = Store::open(&dir.join("office.db")).unwrap();
        let (ada, bo) = (employee("Ada", None), employee("Bo", None));
        db.save_employee(&ada).unwrap();
        db.save_employee(&bo).unwrap();
        let insert = |r: Run| assert!(db.insert_run(&r, &r.id).unwrap());
        let came = |chat: bool, thread: Option<String>| RunKind::Answered { asked_run_id: "r1".into(), from: bo.id.clone(), task: false, chat, thread };
        insert(run(&ada, came(true, None), RunState::Running));
        insert(run(&ada, came(false, Some("t1".into())), RunState::Running));
        insert(run(&ada, RunKind::Chat, RunState::Succeeded));
        insert(run(&ada, RunKind::Manual, RunState::Running));
        assert!(!db.ceo_conversation_running(None).unwrap(), "an answer coming back into a conversation is not you");
        insert(run(&bo, RunKind::Task { label: "Draft it".into(), from: None, context: String::new() }, RunState::Running));
        assert!(db.ceo_conversation_running(None).unwrap());
        assert!(db.ceo_conversation_running(Some(&bo.id)).unwrap());
        assert!(!db.ceo_conversation_running(Some(&ada.id)).unwrap());

        let start = Utc::now();
        let revise = |e: &Employee, skill: &str, file: &str, at| {
            let change = SkillChange { skill: skill.into(), file: file.into(), change: ChangeKind::Modified };
            let rev = SkillRevision { change, id: uuid::Uuid::new_v4().to_string(), run_id: None, at, before: None, after: Some("x".into()) };
            db.insert_revision(&e.id, &rev).unwrap();
        };
        revise(&ada, "@company", "CLAUDE.md", start - chrono::Duration::minutes(5));
        revise(&ada, "@own", "what-you-own.md", start + chrono::Duration::minutes(1));
        assert!(!db.revised_since("@company", "CLAUDE.md", None, start).unwrap(), "changed before the run started");
        assert!(db.revised_since("@own", "what-you-own.md", Some(&ada.id), start).unwrap());
        assert!(!db.revised_since("@own", "what-you-own.md", Some(&bo.id), start).unwrap());
        revise(&bo, "@company", "CLAUDE.md", start + chrono::Duration::minutes(2));
        assert!(db.revised_since("@company", "CLAUDE.md", None, start).unwrap());

        drop(db);
        let _ = std::fs::remove_dir_all(&dir);
    }


    fn sweep(id: &str, label: &str, quiet: bool, review: bool, slot: Ts) -> RunKind {
        RunKind::Scheduled { schedule_id: id.into(), slot, label: label.into(), quiet, model: None, effort: None, review }
    }

    #[test]
    fn usage_counts_what_runs_did_and_cost() {
        let dir = temp_dir();
        let db = Store::open(&dir.join("office.db")).unwrap();
        let (ada, bo) = (employee("Ada", None), employee("Bo", None));
        db.save_employee(&ada).unwrap();
        db.save_employee(&bo).unwrap();
        let at = |hours: i64| Utc::now() - chrono::Duration::hours(hours);
        let since = at(24);
        let insert = |e: &Employee, kind: RunKind, state: RunState, hours: i64, cost: Option<f64>, edit: &dyn Fn(&mut Run)| {
            let mut r = run(e, kind, state);
            r.created_at = at(hours);
            r.cost_usd = cost;
            edit(&mut r);
            assert!(db.insert_run(&r, &r.id).unwrap());
            r
        };
        insert(&ada, sweep("s1", "Sweep", true, false, at(1)), RunState::Succeeded, 1, Some(0.1), &|_| {});
        insert(&ada, sweep("s1", "Sweep", true, false, at(2)), RunState::Succeeded, 2, Some(0.2), &|r| {
            r.skill_changes = vec![SkillChange { skill: "ops".into(), file: "SKILL.md".into(), change: ChangeKind::Modified }];
        });
        insert(&ada, sweep("s1", "Sweep", true, false, at(3)), RunState::Failed, 3, None, &|_| {});
        let asker = insert(&ada, sweep("s1", "Sweep", true, false, at(4)), RunState::Succeeded, 4, Some(0.3), &|_| {});
        insert(&ada, sweep("s1", "Sweep", true, false, at(30)), RunState::Succeeded, 30, Some(5.0), &|_| {});
        insert(&ada, sweep("s1", "Sweep", true, false, at(0)), RunState::Queued, 0, None, &|_| {});
        insert(&ada, RunKind::Manual, RunState::Succeeded, 5, Some(1.0), &|r| {
            let ask = || CardAsk::Choices { choices: vec!["Go".into()], recommended: 0 };
            r.cards = vec![Card::new("Post it?", None, Some("ask:post".into()), ask()), Card::new("Boost it?", None, Some("ask:boost".into()), ask())];
        });
        insert(&ada, sweep("r1", "Weekly review", false, true, at(6)), RunState::Succeeded, 6, Some(0.4), &|_| {});
        insert(&bo, RunKind::Asked { parent_run_id: asker.id.clone(), asked_by: ada.id.clone(), task: false }, RunState::Succeeded, 4, Some(0.05), &|_| {});
        insert(&bo, sweep("s2", "Digest", false, false, at(7)), RunState::Succeeded, 7, None, &|_| {});

        let round = |c: f64| (c * 100.0).round() / 100.0;
        let routines: Vec<(String, String, u32, u32, u32, u32, f64)> = db
            .routine_counts(None, since)
            .unwrap()
            .into_iter()
            .map(|c| (c.schedule_id, c.employee_id, c.runs, c.reached, c.failed, c.useful, round(c.cost_usd)))
            .collect();
        assert_eq!(
            routines,
            vec![("s1".to_string(), ada.id.clone(), 4, 1, 1, 3, 0.6), ("s2".to_string(), bo.id.clone(), 1, 0, 0, 0, 0.0)],
            "the review is not a routine; the hand-off, the skill change and the failure did something"
        );
        assert_eq!(db.routine_counts(Some(&bo.id), since).unwrap().len(), 1);

        let usage: Vec<(String, u32, u32, u32, u32, f64)> =
            db.employee_usage(since).unwrap().into_iter().map(|u| (u.employee_id, u.runs, u.decisions, u.handoffs, u.failed, round(u.cost_usd))).collect();
        let of = |e: &Employee| usage.iter().find(|u| u.0 == e.id).cloned();
        assert_eq!(of(&ada), Some((ada.id.clone(), 6, 2, 1, 1, 2.0)), "finished runs since then, everything they did and cost");
        assert_eq!(of(&bo), Some((bo.id.clone(), 2, 0, 0, 0, 0.05)));
        assert_eq!(usage.len(), 2);

        drop(db);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn search_finds_runs_by_their_words_newest_first() {
        let dir = temp_dir();
        let db = Store::open(&dir.join("office.db")).unwrap();
        let (ada, bo, cy) = (employee("Ada", None), employee("Bo", None), employee("Cy", None));
        for e in [&ada, &bo, &cy] {
            db.save_employee(e).unwrap();
        }
        let insert = |e: &Employee, days: i64, edit: &dyn Fn(&mut Run)| {
            let mut r = run(e, RunKind::Manual, RunState::Succeeded);
            r.created_at = Utc::now() - chrono::Duration::days(days);
            edit(&mut r);
            assert!(db.insert_run(&r, &r.id).unwrap());
            r.id
        };
        let asked = insert(&ada, 90, &|r| r.prompt = "Send the Quarterly Invoice to Acme.".into());
        let reported = insert(&bo, 30, &|r| r.summary = Some("Done.\n\nThe INVOICE is paid.".into()));
        let carded = insert(&ada, 2, &|r| {
            r.cards = vec![Card::new("Chase the invoice with Acme?", None, Some("ask:chase".into()), CardAsk::Choices { choices: vec!["Chase".into()], recommended: 0 })];
        });
        insert(&ada, 1, &|r| r.summary = Some("Nothing new in the inbox.".into()));
        insert(&cy, 1, &|r| r.prompt = "Find the invoice.".into());
        db.depart_employee(&cy.id, Utc::now()).unwrap();
        raw(&db, &ada, "broken", "succeeded", "broken", "not json, an invoice");

        let found = |q: &str, limit: u32| db.search_runs(q, limit).unwrap().into_iter().map(|r| r.id).collect::<Vec<_>>();
        assert_eq!(found("invoice", 10), vec![carded.clone(), reported.clone(), asked], "newest first; a departed employee's are left out");
        assert_eq!(found("  Invoice ", 2), vec![carded, reported]);
        assert!(found("refund", 10).is_empty());
        assert!(found("  ", 10).is_empty());

        drop(db);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn the_latest_number_and_report_are_found() {
        let dir = temp_dir();
        let db = Store::open(&dir.join("office.db")).unwrap();
        let ada = employee("Ada", None);
        db.save_employee(&ada).unwrap();
        let t = Utc::now();
        let hours = |h: i64| t - chrono::Duration::hours(h);
        let schedule = |id: &str, review: bool| Schedule {
            id: id.into(),
            employee_id: ada.id.clone(),
            label: if review { "Weekly review".into() } else { "Sweep".into() },
            cron: "0 7 * * 1".into(),
            instruction: "Go.".into(),
            enabled: true,
            misfire: Misfire::CatchUp,
            quiet: !review,
            model: None,
            effort: None,
            review,
            active_hours: false,
            next_fire: None,
        };
        db.save_schedule(&schedule("r1", true), t).unwrap();
        db.save_schedule(&schedule("s1", false), t).unwrap();
        let insert = |kind: RunKind, h: i64, edit: &dyn Fn(&mut Run)| {
            let mut r = run(&ada, kind, RunState::Succeeded);
            r.created_at = hours(h);
            r.ended_at = Some(hours(h));
            edit(&mut r);
            assert!(db.insert_run(&r, &r.id).unwrap());
            r.id
        };
        assert_eq!(db.latest_score(&ada.id).unwrap(), None);
        let score = |value: &str| Score { metric: "Signups".into(), value: value.into(), change: String::new(), note: String::new() };
        insert(sweep("r1", "Weekly review", false, true, hours(24 * 14)), 24 * 14, &|r| r.score = Some(score("30")));
        insert(sweep("r1", "Weekly review", false, true, hours(24 * 7)), 24 * 7, &|r| r.score = Some(score("42")));
        insert(sweep("r1", "Weekly review", false, true, hours(2)), 2, &|_| {});
        assert_eq!(db.latest_score(&ada.id).unwrap(), Some(score("42")), "the newest review that recorded one");

        let since = hours(24 * 30);
        let report = insert(RunKind::Manual, 10, &|r| r.summary = Some("Paused both campaigns.".into()));
        insert(sweep("s1", "Sweep", true, false, hours(5)), 5, &|r| r.summary = Some("Nothing new.".into()));
        insert(RunKind::Task { label: "Plan".into(), from: None, context: String::new() }, 4, &|r| r.summary = Some("Sure.".into()));
        insert(RunKind::ReplyCheck { request_id: "q1".into(), person_id: "p1".into() }, 3, &|r| r.summary = Some("No reply yet.".into()));
        insert(RunKind::Manual, 1, &|r| r.summary = Some("  ".into()));
        assert_eq!(db.last_report(&ada.id, since).unwrap().map(|r| r.id), Some(report), "the newest that says something to you");
        let raised = insert(sweep("s1", "Sweep", true, false, hours(0)), 0, &|r| {
            r.summary = Some("Found a refund request.".into());
            r.needs_you = vec!["Refund it?".into()];
        });
        assert_eq!(db.last_report(&ada.id, since).unwrap().map(|r| r.id), Some(raised), "a quiet run that raised something");
        assert_eq!(db.last_report(&ada.id, t + chrono::Duration::hours(1)).unwrap(), None);

        drop(db);
        let _ = std::fs::remove_dir_all(&dir);
    }
}
