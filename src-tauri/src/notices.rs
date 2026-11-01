//! Desktop notifications as your settings let them through: each as it comes, an employee's decisions in the 90
//! seconds after their first as one, or none. In quiet hours none shows, and when they end one summary says what came
//! in. Pure: the clock is a parameter.

use crate::model::{NotificationSettings, NotifyMode};
use std::collections::BTreeSet;
use std::time::{Duration, Instant};

/// How long an employee's first decision waits for their next ones, so they show as one.
const WINDOW: Duration = Duration::from_secs(90);
/// How often the sink asks what is due.
pub const TICK: Duration = Duration::from_secs(10);

/// An employee's decisions waiting to show as one notification, until `due`.
struct Batch {
    title: String,
    bodies: Vec<String>,
    due: Instant,
}

/// What is waiting to be shown, under the settings in force.
#[derive(Default)]
pub struct Notices {
    settings: NotificationSettings,
    batches: Vec<Batch>,
    /// What came in quiet hours: for a decision, the employee it is from.
    away: Vec<Option<String>>,
}

impl Notices {
    pub fn set(&mut self, settings: NotificationSettings) {
        self.settings = settings;
    }

    /// Takes a notification at `now` (`minute`: local minutes since midnight). Returns it when it shows at once.
    pub fn add(&mut self, title: &str, body: &str, now: Instant, minute: u16) -> Option<(String, String)> {
        let from = decision_of(title);
        match self.settings.mode {
            NotifyMode::Off => return None,
            _ if self.quiet(minute) => {
                self.away.push(from.map(String::from));
                return None;
            }
            NotifyMode::All => return Some((title.into(), body.into())),
            NotifyMode::Batched if from.is_none() => return Some((title.into(), body.into())),
            NotifyMode::Batched => {}
        }
        match self.batches.iter_mut().find(|b| b.title == title) {
            Some(b) => b.bodies.push(body.into()),
            None => self.batches.push(Batch { title: title.into(), bodies: vec![body.into()], due: now + WINDOW }),
        }
        None
    }

    /// What shows at `now`: each batch whose window has passed as one notification, and once quiet hours are over,
    /// the summary of what came in them. A batch that comes due in quiet hours joins what the summary counts.
    pub fn due(&mut self, now: Instant, minute: u16) -> Vec<(String, String)> {
        if self.settings.mode == NotifyMode::Off {
            self.batches.clear();
            self.away.clear();
            return vec![];
        }
        let quiet = self.quiet(minute);
        let (ready, waiting): (Vec<Batch>, Vec<Batch>) = std::mem::take(&mut self.batches).into_iter().partition(|b| b.due <= now);
        self.batches = waiting;
        let mut out = vec![];
        for b in ready {
            if quiet {
                let from = decision_of(&b.title).map(String::from);
                self.away.extend(b.bodies.iter().map(|_| from.clone()));
            } else {
                out.push((b.title, together(&b.bodies)));
            }
        }
        if !quiet && !self.away.is_empty() {
            out.push(("While you were away".into(), away(&std::mem::take(&mut self.away))));
        }
        out
    }

    fn quiet(&self, minute: u16) -> bool {
        self.settings.quiet.is_some_and(|q| q.contains(minute))
    }
}

/// The employee a notification is a decision of: one titled "<name> needs you" (`EventSink::notify`). Pure.
fn decision_of(title: &str) -> Option<&str> {
    title.strip_suffix(" needs you").map(str::trim).filter(|name| !name.is_empty())
}

/// An employee's decisions as one notification's text: "3 decisions: <the first> and 2 more". Pure.
fn together(bodies: &[String]) -> String {
    match bodies {
        [first, rest @ ..] if !rest.is_empty() => format!("{} decisions: {first} and {} more", bodies.len(), rest.len()),
        _ => bodies.concat(),
    }
}

/// What came in quiet hours, counted: "6 decisions from 3 employees and 1 other notification". Pure.
fn away(from: &[Option<String>]) -> String {
    let names: Vec<&str> = from.iter().flatten().map(String::as_str).collect();
    let employees: BTreeSet<&str> = names.iter().copied().collect();
    let others = from.len() - names.len();
    let mut parts = vec![];
    if let Some(first) = names.first() {
        let who = if employees.len() == 1 { first.to_string() } else { format!("{} employees", employees.len()) };
        parts.push(format!("{} from {who}", count(names.len(), "decision")));
    }
    if others > 0 {
        parts.push(count(others, if names.is_empty() { "notification" } else { "other notification" }));
    }
    parts.join(" and ")
}

fn count(n: usize, noun: &str) -> String {
    if n == 1 { format!("1 {noun}") } else { format!("{n} {noun}s") }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::model::QuietHours;

    fn notices(mode: NotifyMode, quiet: Option<(u16, u16)>) -> Notices {
        let quiet = quiet.map(|(start_minute, end_minute)| QuietHours { start_minute, end_minute });
        let mut n = Notices::default();
        n.set(NotificationSettings { mode, quiet });
        n
    }

    const NOON: u16 = 12 * 60;

    #[test]
    fn batched_decisions_show_as_one_per_employee() {
        let mut n = notices(NotifyMode::Batched, None);
        let t = Instant::now();
        assert_eq!(n.add("Bo needs you", "Merge the docs fix?", t, NOON), None);
        for (i, ask) in ["Merge the pricing fix?", "Post the reply?", "Boost the post?", "Renew the domain?"].iter().enumerate() {
            assert_eq!(n.add("Bo needs you", ask, t + Duration::from_secs(10 * i as u64 + 10), NOON), None);
        }
        assert_eq!(n.add("Ada needs you", "Send the invoice?", t + Duration::from_secs(60), NOON), None);
        let shown = n.add("Backup failed", "The disk is full.", t + Duration::from_secs(61), NOON);
        assert_eq!(shown, Some(("Backup failed".into(), "The disk is full.".into())), "anything but a decision shows at once");

        assert!(n.due(t + Duration::from_secs(89), NOON).is_empty(), "the window is still open");
        assert_eq!(n.due(t + WINDOW, NOON), vec![("Bo needs you".into(), "5 decisions: Merge the docs fix? and 4 more".into())]);
        assert_eq!(n.due(t + Duration::from_secs(60) + WINDOW, NOON), vec![("Ada needs you".into(), "Send the invoice?".into())], "one alone reads as itself");
        assert!(n.due(t + Duration::from_secs(600), NOON).is_empty());
    }

    #[test]
    fn all_shows_each_and_off_shows_none() {
        let t = Instant::now();
        let mut all = notices(NotifyMode::All, None);
        assert_eq!(all.add("Bo needs you", "Merge it?", t, NOON), Some(("Bo needs you".into(), "Merge it?".into())));
        assert!(all.due(t + WINDOW, NOON).is_empty());

        let mut off = notices(NotifyMode::Off, Some((22 * 60, 8 * 60)));
        assert_eq!(off.add("Bo needs you", "Merge it?", t, 23 * 60), None);
        assert_eq!(off.add("Backup failed", "The disk is full.", t, NOON), None);
        assert!(off.due(t + WINDOW, NOON).is_empty(), "no summary either");
    }

    #[test]
    fn quiet_hours_hold_everything_for_one_summary() {
        let mut n = notices(NotifyMode::Batched, Some((22 * 60, 8 * 60)));
        let t = Instant::now();
        let night = 23 * 60;
        for (title, body) in [("Bo needs you", "Merge it?"), ("Bo needs you", "Post it?"), ("Ada needs you", "Pay it?"), ("Cy needs you", "Sign in?")] {
            assert_eq!(n.add(title, body, t, night), None);
        }
        assert_eq!(n.add("Waiting for the usage limit", "Work starts again at 5:00 am.", t, night), None);
        assert!(n.due(t + WINDOW, 7 * 60 + 59).is_empty(), "still quiet at 7:59 am");
        assert_eq!(n.due(t + WINDOW, 8 * 60), vec![("While you were away".into(), "4 decisions from 3 employees and 1 other notification".into())]);
        assert!(n.due(t + WINDOW, 8 * 60 + 1).is_empty(), "said once");

        // A batch that comes due once quiet hours have begun is held for the summary too.
        let evening = 21 * 60 + 59;
        assert_eq!(n.add("Bo needs you", "Merge it?", t, evening), None);
        assert!(n.due(t + WINDOW, 22 * 60).is_empty());
        assert_eq!(n.due(t + WINDOW, 8 * 60), vec![("While you were away".into(), "1 decision from Bo".into())]);
    }

    #[test]
    fn turning_quiet_hours_off_shows_the_summary() {
        let mut n = notices(NotifyMode::All, Some((NOON, NOON + 60)));
        let t = Instant::now();
        assert_eq!(n.add("No reply from Pat", "Bo will go on without it.", t, NOON + 5), None);
        assert!(n.due(t, NOON + 6).is_empty());
        n.set(NotificationSettings { mode: NotifyMode::All, quiet: None });
        assert_eq!(n.due(t, NOON + 7), vec![("While you were away".into(), "1 notification".into())]);
    }

    #[test]
    fn quiet_hours_may_run_overnight() {
        let night = QuietHours { start_minute: 22 * 60, end_minute: 8 * 60 };
        assert!(night.contains(22 * 60) && night.contains(0) && night.contains(8 * 60 - 1));
        assert!(!night.contains(8 * 60) && !night.contains(NOON) && !night.contains(22 * 60 - 1));
        let lunch = QuietHours { start_minute: NOON, end_minute: NOON + 60 };
        assert!(lunch.contains(NOON) && !lunch.contains(NOON + 60) && !lunch.contains(NOON - 1));
    }

    #[test]
    fn only_a_named_need_is_a_decision() {
        assert_eq!(decision_of("Bo needs you"), Some("Bo"));
        assert_eq!(decision_of(" needs you"), None);
        assert_eq!(decision_of("Bo proposes a hire"), None);
        assert_eq!(away(&[Some("Bo".into()), None, None]), "1 decision from Bo and 2 other notifications");
        assert_eq!(together(&["Merge it?".into(), "Post it?".into()]), "2 decisions: Merge it? and 1 more");
    }
}
