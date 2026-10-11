//! Cron evaluation. Pure: the clock and the time zone are parameters.

use crate::model::{CronPreview, Misfire, Ts};
use chrono::{Duration, TimeZone, Utc};
use croner::Cron;
use std::str::FromStr;

/// Slots older than this are dropped under `Misfire::Skip`.
const SKIP_WINDOW: Duration = Duration::minutes(2);

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Due {
    /// Nothing new since `last_slot`.
    Nothing,
    /// Fire this slot (the latest one if several were missed).
    Fire(Ts),
    /// The latest slot is too old to run under `Skip`; record it as seen without firing.
    Missed(Ts),
}

pub fn parse(cron: &str) -> Result<Cron, String> {
    Cron::from_str(cron.trim()).map_err(|e| e.to_string())
}

/// Decides whether a schedule is due at `now`, given the last slot it fired (or was created) at.
pub fn due_slot<Tz: TimeZone>(cron: &Cron, misfire: Misfire, last_slot: Ts, now: Ts, tz: &Tz) -> Due {
    let local_now = now.with_timezone(tz);
    let Ok(latest) = cron.find_previous_occurrence(&local_now, true) else {
        return Due::Nothing;
    };
    let latest = latest.with_timezone(&Utc);
    if latest <= last_slot {
        Due::Nothing
    } else if misfire == Misfire::Skip && now - latest > SKIP_WINDOW {
        Due::Missed(latest)
    } else {
        Due::Fire(latest)
    }
}

fn next_fires<Tz: TimeZone>(cron: &Cron, after: Ts, tz: &Tz, n: usize) -> Vec<Ts> {
    cron.iter_after(after.with_timezone(tz)).take(n).map(|t| t.with_timezone(&Utc)).collect()
}

pub fn next_fire<Tz: TimeZone>(cron: &str, after: Ts, tz: &Tz) -> Option<Ts> {
    parse(cron).ok().and_then(|c| next_fires(&c, after, tz, 1).into_iter().next())
}

pub fn preview<Tz: TimeZone>(cron: &str, now: Ts, tz: &Tz) -> CronPreview {
    match parse(cron) {
        Ok(c) => CronPreview::Ok { description: twelve_hour(&c.describe()), next: next_fires(&c, now, tz, 5) },
        Err(error) => CronPreview::Err { error },
    }
}

/// Croner writes clock times as 24-hour "15:05" (or "15:05:30"); the app shows 12-hour "3:05 pm".
fn twelve_hour(s: &str) -> String {
    let b = s.as_bytes();
    let digit = |i: usize| b.get(i).is_some_and(|c| c.is_ascii_digit());
    let (mut out, mut last, mut i) = (String::new(), 0, 0);
    while i < b.len() {
        let starts = digit(i) && digit(i + 1) && b.get(i + 2) == Some(&b':') && digit(i + 3) && digit(i + 4);
        let bounded = i == 0 || !(b[i - 1].is_ascii_digit() || b[i - 1] == b':');
        let hour: u32 = if starts { s[i..i + 2].parse().unwrap_or(99) } else { 99 };
        if starts && bounded && hour < 24 {
            let mut end = i + 5;
            if b.get(end) == Some(&b':') && digit(end + 1) && digit(end + 2) {
                end += 3;
            }
            out.push_str(&s[last..i]);
            out.push_str(&format!("{}{} {}", if hour.is_multiple_of(12) { 12 } else { hour % 12 }, &s[i + 2..end], if hour < 12 { "am" } else { "pm" }));
            last = end;
            i = end;
        } else {
            i += 1;
        }
    }
    out.push_str(&s[last..]);
    out
}
