//! Test helpers the office's tool and hand-off tests share.

use super::*;
use crate::fixtures::{acme, employee_named, open_office, temp_path};

pub(super) struct Office0 {
    pub(super) dir: PathBuf,
    pub(super) db: Store,
}

impl Drop for Office0 {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.dir);
    }
}

/// A temp store whose CEO is called Pat.
pub(super) fn office() -> Office0 {
    let dir = temp_path("tools");
    fs::create_dir_all(dir.join("runs")).unwrap();
    let db = Store::open(&dir.join("office.db")).unwrap();
    db.set_company(&acme()).unwrap();
    Office0 { dir, db }
}

/// An employee reporting to `manager_id`, or to you.
pub(super) fn employee(db: &Store, name: &str, manager_id: Option<&str>) -> Employee {
    let e = Employee { manager_id: manager_id.map(String::from), ..employee_named(name) };
    db.save_employee(&e).unwrap();
    e
}

pub(super) fn standup(id: &str) -> RunKind {
    RunKind::Scheduled { schedule_id: id.into(), slot: now(), label: "Stand-up".into(), quiet: false, model: None, effort: None, review: false }
}

/// The Office on `o`'s store, held for an hour so nothing it queues starts.
pub(super) async fn held_office(o: &Office0) -> Office {
    o.db.set_held_until(Some(now() + chrono::Duration::hours(1))).unwrap();
    open_office(&o.dir).await
}

pub(super) fn saved(db: &Store, id: &str) -> Run {
    db.run(id).unwrap().unwrap().run
}
