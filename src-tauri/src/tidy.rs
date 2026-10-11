//! The rules of tidying: when an employee is due one, and how a tidy is kept from losing what the
//! person taught. Pure functions over findings and text; the Office runs them.

use crate::model::*;
use crate::own_skills::{self, Snapshot};
use std::collections::{BTreeMap, BTreeSet, HashSet};
use std::fs;
use std::path::Path;

/// No automatic tidy starts within this long of the last one, whatever it finds.
const COOLDOWN_HOURS: i64 = 24;
/// Things you taught only start a tidy this long after the last, so a busy week is one tidy.
const TEACHING_DAYS: i64 = 7;
/// Automatic tidies wait while the plan's windows are this full: real work comes first.
const HOLD_FIVE_HOUR_PERCENT: f64 = 70.0;
const HOLD_SEVEN_DAY_PERCENT: f64 = 85.0;
/// A tidy's report goes to the Inbox for review until the employee has had this many.
pub const REVIEWED_FIRST: usize = 3;
/// How many of your words a tidy is handed to check against, newest first.
pub const TAUGHT_LIMIT: usize = 40;

/// What identifies a finding from one check to the next.
pub fn key(f: &HealthFinding) -> String {
    format!("{:?}|{}|{}", f.kind, f.skill.as_deref().unwrap_or(""), f.file.as_deref().unwrap_or(""))
}

pub fn signature(findings: &[HealthFinding]) -> Vec<String> {
    findings.iter().map(key).collect::<BTreeSet<_>>().into_iter().collect()
}

pub struct Situation<'a> {
    pub now: Ts,
    pub findings: &'a [HealthFinding],
    /// When the last tidy was queued, and which findings it started with.
    pub last: Option<(Ts, &'a [String])>,
    /// Things the person taught since then.
    pub taught: usize,
}

/// Why an automatic tidy should start now, if it should. A finding a tidy has already seen does not
/// start another: a long runbook the employee rightly kept whole is not a reason to tidy every day.
pub fn due(s: &Situation) -> Option<String> {
    if let Some((at, _)) = s.last {
        if s.now - at < chrono::Duration::hours(COOLDOWN_HOURS) {
            return None;
        }
    }
    if s.findings.iter().any(|f| f.kind == HealthKind::OverdueCheck) {
        return Some("a check you set for yourself is due".into());
    }
    let known: HashSet<&str> = s.last.map(|(_, sig)| sig.iter().map(String::as_str).collect()).unwrap_or_default();
    let fresh = s.findings.iter().filter(|f| !known.contains(key(f).as_str())).count();
    if fresh > 0 {
        return Some(format!("{fresh} {} to tidy since the last look", if fresh == 1 { "thing" } else { "things" }));
    }
    let weekly = s.last.map(|(at, _)| s.now - at >= chrono::Duration::days(TEACHING_DAYS)).unwrap_or(true);
    if s.taught > 0 && weekly {
        return Some(format!("{} to confirm were taught into your skills", if s.taught == 1 { "1 thing you were told".to_string() } else { format!("{} things you were told", s.taught) }));
    }
    None
}

/// Whether the plan's windows leave room for an automatic tidy. Unknown usage does not hold one.
pub fn room_for_a_tidy(usage: &UsageLimits) -> bool {
    let under = |w: &Option<UsageWindow>, limit: f64| w.as_ref().map(|w| w.percent < limit).unwrap_or(true);
    !usage.subscription || (under(&usage.five_hour, HOLD_FIVE_HOUR_PERCENT) && under(&usage.seven_day, HOLD_SEVEN_DAY_PERCENT))
}

// ---------------------------------------------------------------- what was taught is protected

/// A bullet or line that holds something the person taught, and the heading it sits under.
#[derive(Debug, Clone, PartialEq)]
pub struct Taught {
    pub skill: String,
    pub file: String,
    pub heading: String,
    pub line: String,
}

/// Headings whose bullets are taught rules and preferences. A tidy may move them, never drop them.
fn is_taught_heading(heading: &str) -> bool {
    let h = heading.trim_start_matches('#').trim().to_lowercase();
    h.contains("standing preference") || h == "rules" || h.starts_with("rules ") || h.contains("taught") || h.contains("correction")
}

fn is_bullet(line: &str) -> bool {
    let t = line.trim_start();
    t.starts_with("- ") || t.starts_with("* ") || t.split_once(". ").map(|(n, _)| !n.is_empty() && n.chars().all(|c| c.is_ascii_digit())).unwrap_or(false)
}

/// The words of a line, without its "(taught 2026-09-20)" provenance: that is bookkeeping, and a rule
/// folded into another line keeps its meaning without it.
fn tokens(s: &str) -> BTreeSet<String> {
    let lower = s.to_lowercase();
    let body = match lower.find("(taught") {
        Some(i) => &lower[..i],
        None => &lower,
    };
    body.split(|c: char| !c.is_alphanumeric()).filter(|w| w.chars().count() >= 2).map(String::from).collect()
}

/// (heading, line) of every taught line in `text`: bullets under a taught heading, and any line that
/// carries a `(taught ...)` provenance mark.
fn taught_lines(text: &str) -> Vec<(String, String)> {
    let mut out = vec![];
    let (mut heading, mut fence) = (String::new(), false);
    for line in text.lines() {
        let t = line.trim();
        if t.starts_with("```") || t.starts_with("~~~") {
            fence = !fence;
            continue;
        }
        if fence {
            continue;
        }
        if t.starts_with('#') {
            heading = t.to_string();
            continue;
        }
        let marked = t.to_lowercase().contains("(taught ");
        if (marked || (is_bullet(t) && is_taught_heading(&heading))) && tokens(t).len() >= 3 {
            out.push((heading.clone(), t.to_string()));
        }
    }
    out
}

/// Most of a clause's words must sit in one line of the family for the clause to count as still there.
const CLAUSE_MATCH_PERCENT: usize = 75;

/// The words of every line of the family after a run, for asking whether a line from before is still there.
struct Family {
    lines: Vec<BTreeSet<String>>,
}

impl Family {
    /// `skills_only` leaves notes out: a rule moved into a notes file is out of reach of the skills.
    fn new(after: &Snapshot, skills_only: bool) -> Family {
        let lines = after.iter().filter(|((skill, _), _)| !skills_only || skill != own_skills::NOTES);
        Family { lines: lines.flat_map(|(_, t)| t.lines().map(tokens)).filter(|t| t.len() >= 3).collect() }
    }

    /// Whether `line` is still in the family. A line is a few clauses (a rule, then the details behind it)
    /// and each must be found on its own, so a bullet split into a rule and a facts file, moved, folded
    /// into a longer bullet or lightly reworded is kept. A clause that was cut, or rewritten past
    /// recognition, is not.
    fn keeps(&self, line: &str) -> bool {
        let wanted = clauses(line);
        let wanted = if wanted.is_empty() { vec![tokens(line)] } else { wanted };
        wanted.iter().all(|want| want.len() < 3 || self.lines.iter().any(|have| want.intersection(have).count() * 100 >= want.len() * CLAUSE_MATCH_PERCENT))
    }
}

/// The sentences of a line, without the "(taught ...)" mark, as sets of words. Clauses of fewer than
/// three words say too little to look for and are left out.
fn clauses(line: &str) -> Vec<BTreeSet<String>> {
    let lower = line.to_lowercase();
    let body = lower.split("(taught").next().unwrap_or("");
    body.split(['.', ';', '!', '?']).map(tokens).filter(|w| w.len() >= 3).collect()
}

/// Taught lines of `before` that no longer appear in `after`, anywhere in the family.
pub fn dropped(before: &Snapshot, after: &Snapshot) -> Vec<Taught> {
    let family = Family::new(after, true);
    let mut out = vec![];
    for ((skill, file), text) in before {
        if after.get(&(skill.clone(), file.clone())) == Some(text) || !file.ends_with(".md") || skill == own_skills::NOTES {
            continue;
        }
        for (heading, line) in taught_lines(text) {
            if !family.keeps(&line) {
                out.push(Taught { skill: skill.clone(), file: file.clone(), heading, line });
            }
        }
    }
    out
}

/// Lines of the changed or removed files in `before` that no longer appear anywhere in `after`, as
/// (skill, file, line): what a tidy deleted, as opposed to moved. It lets you check the first tidies
/// against the diff. Headings, table rules and short lines are ignored.
pub fn vanished(before: &Snapshot, after: &Snapshot) -> Vec<(String, String, String)> {
    let family = Family::new(after, false);
    let mut out = vec![];
    for ((skill, file), text) in before {
        if after.get(&(skill.clone(), file.clone())) == Some(text) || !file.ends_with(".md") {
            continue;
        }
        for line in text.lines().map(str::trim).filter(|l| !l.starts_with('#') && tokens(l).len() >= 4) {
            if !family.keeps(line) {
                out.push((skill.clone(), file.clone(), line.to_string()));
            }
        }
    }
    out
}

/// Puts dropped taught lines back where they were: at the end of the same section of the same file,
/// or when the file is gone, in the role skill's standing preferences. Returns what it restored.
pub fn restore(skills_dir: &Path, slug: &str, lost: &[Taught]) -> std::io::Result<Vec<Taught>> {
    let mut by_file: BTreeMap<(String, String), Vec<&Taught>> = BTreeMap::new();
    for t in lost {
        let exists = skills_dir.join(&t.skill).join(&t.file).is_file();
        let key = if exists { (t.skill.clone(), t.file.clone()) } else { (slug.to_string(), "SKILL.md".to_string()) };
        by_file.entry(key).or_default().push(t);
    }
    let mut restored = vec![];
    for ((skill, file), items) in by_file {
        let path = skills_dir.join(&skill).join(&file);
        let Ok(text) = fs::read_to_string(&path) else { continue };
        let mut lines: Vec<String> = text.lines().map(String::from).collect();
        let mut sections: BTreeMap<String, Vec<&Taught>> = BTreeMap::new();
        for t in items {
            let heading = if skill == t.skill && file == t.file && !t.heading.is_empty() { t.heading.clone() } else { "## Standing preferences".to_string() };
            sections.entry(heading).or_default().push(t);
        }
        for (heading, items) in sections {
            let at = match lines.iter().position(|l| l.trim() == heading) {
                Some(h) => {
                    let end = lines[h + 1..].iter().position(|l| l.trim_start().starts_with('#')).map(|i| h + 1 + i).unwrap_or(lines.len());
                    let mut e = end;
                    while e > h + 1 && lines[e - 1].trim().is_empty() {
                        e -= 1;
                    }
                    e
                }
                None => {
                    if lines.last().map(|l| !l.trim().is_empty()).unwrap_or(false) {
                        lines.push(String::new());
                    }
                    lines.push(heading.clone());
                    lines.len()
                }
            };
            for (i, t) in items.iter().enumerate() {
                lines.insert(at + i, t.line.clone());
            }
            restored.extend(items.into_iter().cloned());
        }
        let mut out = lines.join("\n");
        out.push('\n');
        fs::write(&path, out)?;
    }
    Ok(restored)
}

/// Removes files a skill's own scripts regenerate (`__pycache__`), so they stop counting as clutter.
/// Returns how many files went.
pub fn clean_generated(skills_dir: &Path) -> usize {
    fn walk(dir: &Path) -> usize {
        let mut n = 0;
        for e in fs::read_dir(dir).into_iter().flatten().flatten() {
            let p = e.path();
            if !p.is_dir() {
                continue;
            }
            if e.file_name() == "__pycache__" {
                n += own_skills::skill_files(&p).len();
                let _ = fs::remove_dir_all(&p);
            } else {
                n += walk(&p);
            }
        }
        n
    }
    walk(skills_dir)
}
