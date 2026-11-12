//! The note at the top of a run's first message: what changed around the employee since their last
//! run, from the time and your answers to what their team finished.

use super::*;

/// How a request the employee is waiting on stands, as their opening note says it.
fn watch_status(r: &HumanRequest) -> &'static str {
    let Some(d) = &r.delivery else { return "**not recorded as sent**: call `sent` once you have sent it" };
    match (&d.locator, d.watch.as_ref().map(|w| &w.phase)) {
        (_, Some(WatchPhase::Stopped { .. })) => "stopped watching",
        (_, Some(WatchPhase::GaveUp { .. })) => "gave up",
        (Locator::TeamsChat { server: Some(_), .. }, _) => "sent via Teams, Omega Star is watching",
        _ => "sent, Omega Star checks for replies",
    }
}

/// A moment on your local clock, the way a person writes it: "Tue 6 Oct 1:15 pm".
pub fn local_time(t: Ts) -> String {
    t.with_timezone(&chrono::Local).format("%a %-d %b %-I:%M %P").to_string()
}

/// A day on your local calendar: "Tue 6 Oct".
fn local_day(t: Ts) -> String {
    t.with_timezone(&chrono::Local).format("%a %-d %b").to_string()
}

pub fn kind_label(k: &RunKind) -> String {
    match k {
        RunKind::Manual => "manual".into(),
        RunKind::Chat => "chat".into(),
        RunKind::Scheduled { label, .. } => format!("scheduled '{label}'"),
        RunKind::Delegated { .. } => "delegated by your manager".into(),
        RunKind::Asked { task: false, .. } => "question from a colleague".into(),
        RunKind::Asked { task: true, .. } => "task from a colleague".into(),
        RunKind::Answered { .. } => "a colleague's answer".into(),
        RunKind::FollowUp { .. } => "follow-up on a reply".into(),
        RunKind::Organize { .. } => "organized imported skills".into(),
        RunKind::Tidy { reason: TidyReason::Approved, .. } => "tidy of your skills (approved changes)".into(),
        RunKind::Tidy { .. } => "tidy of your skills and notes".into(),
        RunKind::Reply { task: false, .. } => "reply to your report".into(),
        RunKind::Reply { task: true, label, .. } => format!("reply in your conversation '{label}'"),
        RunKind::Task { label, .. } => format!("conversation '{label}'"),
        RunKind::HireDecided { approved: true, .. } => "hire proposal approved".into(),
        RunKind::HireDecided { approved: false, .. } => "hire proposal declined".into(),
        RunKind::ReplyCheck { .. } => "reply check".into(),
        RunKind::Nudge { .. } => "nudge to a person".into(),
        RunKind::Unanswered { .. } => "no reply to a request".into(),
    }
}

const WORK_LINES: usize = 12;

const TEAM_LINES: usize = 8;

const NOTE_LINES: usize = 8;

const ANSWER_LINES: usize = 10;

fn ended(r: &Run) -> Ts {
    r.ended_at.unwrap_or(r.created_at)
}

/// The schedule and label of a quiet routine's run that ended without flagging anything, with its error
/// when it failed.
fn quiet_run(r: &Run) -> Option<(&str, &str, Option<&str>)> {
    let RunKind::Scheduled { schedule_id, label, quiet: true, .. } = &r.kind else { return None };
    match r.state {
        _ if !r.needs_you.is_empty() => None,
        RunState::Succeeded => Some((schedule_id, label, None)),
        RunState::Failed => Some((schedule_id, label, Some(r.error.as_deref().unwrap_or("no details")))),
        _ => None,
    }
}

/// How a finished run ended: the start and end of its report, or why it did not finish, and what it raised.
fn result(r: &Run) -> String {
    let mut t = if r.state == RunState::Succeeded {
        r.summary.as_deref().filter(|s| !s.trim().is_empty()).map(|s| ends(s, 150)).unwrap_or_else(|| "no report".into())
    } else {
        format!("did not finish: {}", clip(&one_line(r.error.as_deref().unwrap_or(r.state.as_str())), 150))
    };
    if let Some(raised) = r.needs_you.first() {
        t += &format!(" (you raised: {})", clip(&one_line(raised), 120));
    }
    t
}

struct Fold<'a> {
    schedule: &'a str,
    label: &'a str,
    error: Option<&'a str>,
    runs: Vec<&'a Run>,
}

/// One line per run with its time, `line` writing each; a quiet routine's successful unflagged runs
/// fold into one line per schedule at the newest one's time, led by `lead`, and so do its failures with
/// the same error. A run is said to reach someone when it is one of `parents`: it asked or delegated something.
fn run_lines<'a>(runs: impl Iterator<Item = &'a Run>, lead: &str, parents: &HashSet<String>, line: impl Fn(&Run) -> String) -> Vec<(Ts, String)> {
    let mut lines = vec![];
    let mut folds: Vec<Fold> = vec![];
    for r in runs {
        let Some((schedule, label, error)) = quiet_run(r) else {
            lines.push((ended(r), line(r)));
            continue;
        };
        match folds.iter_mut().find(|f| f.schedule == schedule && f.error == error) {
            Some(f) => f.runs.push(r),
            None => folds.push(Fold { schedule, label, error, runs: vec![r] }),
        }
    }
    folds.sort_by_key(|f| f.error.is_none());
    for Fold { label, error, runs, .. } in folds {
        let newest = *runs.iter().max_by_key(|r| ended(r)).expect("a fold has a run");
        if runs.len() == 1 {
            lines.push((ended(newest), line(newest)));
            continue;
        }
        let oldest = runs.iter().map(|r| ended(r)).min().expect("a fold has a run");
        let (n, since, at) = (runs.len(), local_day(oldest), local_time(ended(newest)));
        let text = match error {
            Some(error) => format!("{lead}{label}: {n} quiet runs since {since} did not finish, the latest at {at}: {}", clip(&one_line(error), 150)),
            None => {
                let reached = runs.iter().filter(|r| parents.contains(&r.id)).count();
                let reach = if reached == 0 { "none reached anyone".to_string() } else { format!("{reached} reached someone") };
                let latest = clip(&one_line(newest.summary.as_deref().unwrap_or("no report")), 140);
                format!("{lead}{label}: {n} quiet runs since {since}, {reach}. Latest ({at}): {latest}")
            }
        };
        lines.push((ended(newest), text));
    }
    lines
}

/// Lines newest first, at most `max`, then how many were left out.
fn newest_first(mut lines: Vec<(Ts, String)>, max: usize) -> Vec<String> {
    lines.sort_by_key(|line| std::cmp::Reverse(line.0));
    let left = lines.len().saturating_sub(max);
    let mut v: Vec<String> = lines.into_iter().take(max).map(|(_, l)| l).collect();
    if left > 0 {
        v.push(format!("({left} older {} left out)", if left == 1 { "entry" } else { "entries" }));
    }
    v
}

/// The lines under the "What I decide alone" heading of what the employee owns, as written, so an exception
/// under them keeps its place, down to the next heading as high.
fn decide_alone(owns: &str) -> Vec<&str> {
    let mut level = None;
    let mut lines = vec![];
    for line in owns.lines().map(str::trim_end) {
        let t = line.trim_start();
        let depth = t.chars().take_while(|c| *c == '#').count();
        if depth > 0 && t[depth..].starts_with(' ') && level.is_none_or(|l| depth <= l) {
            level = t.to_lowercase().contains("decide alone").then_some(depth);
        } else if level.is_some() && !t.is_empty() {
            lines.push(line);
        }
    }
    lines
}

/// Each section that has lines, as its title over a bullet per line.
fn render(sections: Vec<(String, Vec<String>)>) -> Vec<String> {
    sections
        .into_iter()
        .filter(|(_, lines)| !lines.is_empty())
        .map(|(title, lines)| format!("{title}\n{}", lines.iter().map(|l| format!("- {l}")).collect::<Vec<_>>().join("\n")))
        .collect()
}

/// The note at the top of a run's first message: the time, what you approved for the employee and your
/// answers to their cards, news from colleagues and the reports held for the employee, what waits and which
/// of their cards were replaced, what they did lately, what their team finished, what else is running and
/// which notes changed. With `since`, only what is new since then. `None` when the run gets no note; a
/// quiet routine with nothing new gets only what you approved and answered, so its first message stays the
/// same from run to run.
pub(super) fn opening_note(s: &Snapshot, run: &Run) -> Option<String> {
    let o = s.opening.as_ref()?;
    let ceo = &s.company.ceo_name;
    let since = o.since.is_some();
    let new = |t: Ts| o.since.is_none_or(|since| t > since);
    let mut sections: Vec<(String, Vec<String>)> = vec![];

    // In your words, so a session that has not heard them works within them: Claude Code's checks look for
    // your approval in the conversation, not in the handbook.
    let mut standing = vec![];
    let approved = decide_alone(&s.owns);
    if !s.resume && !approved.is_empty() {
        standing.push(format!("{ceo} has approved these for you to do without asking:\n{}", approved.join("\n")));
    }
    let answers = o
        .answers
        .iter()
        .filter_map(|c| Some((c, c.answer.as_ref()?)))
        .filter(|(_, a)| !s.resume || new(a.at))
        .take(ANSWER_LINES)
        .map(|(c, a)| {
            let said = clip(&one_line(&a.text), 1000);
            let said = if a.how == AnswerHow::Typed { format!("\"{said}\"") } else { said };
            format!("Your card \"{}\": {said}", clip(&one_line(&c.message), 300))
        })
        .collect();
    let when = if s.resume { "since your last turn here" } else { "in the last 7 days, newest first" };
    standing.extend(render(vec![(format!("{ceo}'s answers to your cards {when}:"), answers)]));

    let news = o.news.iter().map(|(at, who, text)| format!("{who}, {}: {}", local_time(*at), clip(&one_line(text), 1500))).collect();
    sections.push(("News from colleagues. It needs no reply:".into(), news));
    let held = o
        .held
        .iter()
        .map(|(who, task, report)| format!("{who}. Task: {}\n  Report: {}", clip(&one_line(task), 1500), clip(&one_line(report), 6000)))
        .collect();
    sections.push((
        "Reports from your team that came back after your run had ended. They reach you only here, so act on each in this run:".into(),
        held,
    ));

    let mut waiting = vec![];
    for c in o.checks.iter().filter(|c| c.due_at <= o.now && new(c.due_at)) {
        waiting.push(format!("Check due {}: {} (check id `{}`). `my_checks` has how.", local_day(c.due_at), clip(&one_line(&c.what), 300), c.id));
    }
    let later = o.checks.iter().filter(|c| c.due_at > o.now).count();
    if !since && later > 0 {
        waiting.push(if later == 1 { "1 more open check is not due yet.".to_string() } else { format!("{later} more open checks are not due yet.") });
    }
    let cards: Vec<&(Ts, Card)> = o.cards.iter().filter(|(at, _)| new(*at)).collect();
    for (at, c) in &cards {
        let key = c.key.as_deref().filter(|_| !matches!(c.ask, CardAsk::Chore { .. })).map(|k| format!(" (key `{}`)", crate::cards::key_label(k))).unwrap_or_default();
        waiting.push(format!("Card to {ceo} since {}, not answered yet{key}: {}", local_time(*at), clip(&one_line(&c.message), 300)));
    }
    if cards.iter().any(|(_, c)| !matches!(c.ask, CardAsk::Chore { .. })) {
        waiting.push(format!("A card settled without {ceo} gets `close_ask(key, reason)`; one still needed stays as it is: do not ask it again."));
    }
    for (r, who) in o.waiting_on.iter().filter(|(r, _)| new(r.created_at)) {
        let kind = r.kind.as_str();
        let kind = kind[..1].to_uppercase() + &kind[1..];
        let sent = r.delivery.as_ref().map_or(r.created_at, |d| d.sent_at);
        let due = r.due_at.map(|d| format!(", due {}", local_day(d))).unwrap_or_default();
        waiting.push(format!(
            "{kind} to {who}, sent {}{due}: {} (request id `{}`), {}",
            local_day(sent),
            clip(&one_line(&r.message), 300),
            r.id,
            watch_status(r)
        ));
    }
    for p in o.proposals.iter().filter(|p| new(p.created_at)) {
        waiting.push(format!(
            "Hire proposal for {}, {}, waiting on {ceo} since {} (proposal id `{}`)",
            p.draft.name,
            p.draft.title,
            local_day(p.created_at),
            p.id
        ));
    }
    sections.push((if since { "Waiting, new since your last turn here:" } else { "Waiting:" }.into(), waiting));

    let replaced = o
        .replaced
        .iter()
        .map(|(at, c)| {
            let key = c.key.as_deref().map(|k| format!(" (key `{}`)", crate::cards::key_label(k))).unwrap_or_default();
            format!("\"{}\"{key} was replaced by a newer card on {}, so it is no longer in {ceo}'s Inbox.", clip(&one_line(&c.message), 300), local_time(*at))
        })
        .collect();
    sections.push((format!("Your cards replaced since your last run. Ask again only if one still needs {ceo}:"), replaced));

    let what = |r: &Run| match &r.kind {
        RunKind::Chat | RunKind::Answered { chat: true, .. } => format!("conversation with {ceo}"),
        RunKind::Reply { label, task: false, .. } => format!("reply in your thread on '{label}'"),
        RunKind::Reply { label, task: true, .. } | RunKind::Task { label, .. } => format!("your conversation '{label}'"),
        k => kind_label(k),
    };
    let wrote = |r: &Run| if r.omega_wrote { "Omega Star".to_string() } else { ceo.clone() };
    let work = run_lines(o.work.iter(), "", &o.parents, |r| {
        let said = if r.kind.is_conversation() { format!(" {}: \"{}\" You:", wrote(r), clip(&one_line(&r.prompt), 160)) } else { String::new() };
        format!("{}, {}:{said} {}", local_time(ended(r)), what(r), result(r))
    });
    let title = if since {
        "What you did elsewhere since your last turn here, newest first."
    } else {
        "What you have been doing, last 7 days, newest first. Each line keeps how the report began and how it ended."
    };
    sections.push((title.into(), newest_first(work, WORK_LINES)));

    let mut team = vec![];
    let mut names: Vec<&str> = vec![];
    for (name, _) in &o.team {
        if !names.contains(&name.as_str()) {
            names.push(name);
        }
    }
    for name in names {
        let runs = o.team.iter().filter(|(n, _)| n == name).map(|(_, r)| r);
        team.extend(run_lines(runs, &format!("{name}, "), &o.parents, |r| format!("{name}, {} ({}): {}", kind_label(&r.kind), local_time(ended(r)), result(r))));
    }
    sections.push((format!("From your team since your last {}:", if since { "turn here" } else { "run" }), newest_first(team, TEAM_LINES)));

    let running = o
        .running
        .iter()
        .map(|r| {
            let said = if r.kind.is_conversation() {
                format!(": {} {} \"{}\"", wrote(r), if r.omega_wrote { "wrote" } else { "said" }, clip(&one_line(&r.prompt), 150))
            } else {
                String::new()
            };
            format!("{}, started {}{said}", what(r), local_time(r.started_at.unwrap_or(r.created_at)))
        })
        .collect();
    sections.push(("Also running now, in your other conversations. Do not repeat what they do outside, such as sending, posting or paying:".into(), running));

    let mut notes: Vec<String> = o.notes.iter().take(NOTE_LINES).map(|(file, at)| format!("`workspace/{file}` ({})", local_time(*at))).collect();
    if o.notes.len() > NOTE_LINES {
        notes.push(format!("+{} more", o.notes.len() - NOTE_LINES));
    }
    sections.push((format!("Your notes changed {}:", if since { "since then" } else { "this week" }), notes));

    let now = format!("Now: {}.", o.now.with_timezone(&chrono::Local).format("%A %-d %B %Y, %-I:%M %P"));
    let sections = render(sections);
    if sections.is_empty() && since && matches!(run.kind, RunKind::Scheduled { quiet: true, .. }) {
        return (!standing.is_empty()).then(|| standing.join("\n\n"));
    }
    Some(std::iter::once(now).chain(standing).chain(sections).collect::<Vec<_>>().join("\n\n"))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::claude::fixtures::*;
    use crate::fixtures::scheduled;

    #[test]
    fn a_quiet_routines_same_failure_folds_into_one_line() {
        let failed = |error: &str, mins: i64| {
            let mut r = run(scheduled("s1", true));
            r.state = RunState::Failed;
            r.ended_at = Some(chrono::Utc::now() - chrono::Duration::minutes(mins));
            r.error = Some(error.into());
            r
        };
        let runs = [failed("Usage limit reached.", 30), failed("Usage limit reached.", 20), failed("Usage limit reached.", 10), failed("Login expired.", 5)];
        let lines = run_lines(runs.iter(), "", &HashSet::new(), |_| "one run".into());
        assert_eq!(lines.len(), 2, "{lines:?}");
        assert!(lines.iter().any(|(_, l)| l.starts_with("Inbox sweep: 3 quiet runs since ") && l.ends_with(": Usage limit reached.")), "{lines:?}");
        assert!(lines.iter().any(|(_, l)| l == "one run"), "a different failure keeps its own line");
    }

    #[test]
    fn the_opening_note_quotes_what_pat_approved_and_answered() {
        let now = chrono::Utc::now();
        let answered = |message: &str, how: AnswerHow, text: &str, mins: i64| {
            let mut c = Card::new(message, None, Some("ask:room".into()), CardAsk::Choices { choices: vec!["Book".into()], recommended: 0 });
            c.answer = Some(CardAnswer { at: now - chrono::Duration::minutes(mins), how, text: text.into(), held: false });
            c
        };
        let mut s = snap();
        s.owns = "# What Ada owns\n\n## The number I answer for\n\nDays to close.\n\n## What I decide alone\n\n- Reconcile a bank line with one match.\n\
- Pay a supplier invoice under 200 dollars.\n  - Never a new supplier.\n\n### Not without asking\n\nRefunds.\n\n## Limits\n\n- No loans.\n"
            .into();
        let answers = vec![answered("Book the bigger room?", AnswerHow::Tapped, "Chose: Book.", 30), answered("Which caterer?", AnswerHow::Typed, "The one on\nMain Street.", 90)];
        s.opening = Some(Opening { now, answers, ..Opening::default() });
        let text = first_message(&s, &run(RunKind::Manual));
        assert!(
            text.contains(
                "\n\nPat has approved these for you to do without asking:\n- Reconcile a bank line with one match.\n\
- Pay a supplier invoice under 200 dollars.\n  - Never a new supplier.\n### Not without asking\nRefunds.\n\n"
            ),
            "{text}"
        );
        assert!(!text.contains("Days to close") && !text.contains("No loans"), "{text}");
        assert!(
            text.contains("\n\nPat's answers to your cards in the last 7 days, newest first:\n- Your card \"Book the bigger room?\": Chose: Book.\n- Your card \"Which caterer?\": \"The one on Main Street.\""),
            "{text}"
        );
        assert!(text.find("Now: ").unwrap() < text.find("Pat has approved").unwrap(), "{text}");
        assert!(!text.contains('\u{2014}'), "{text}");

        s.resume = true;
        s.opening.as_mut().unwrap().since = Some(now - chrono::Duration::minutes(60));
        let turn = first_message(&s, &run(RunKind::Reply { to_run_id: "r0".into(), label: "Sweep".into(), task: true, card: false }));
        assert!(!turn.contains("has approved these"), "the session heard them at its start: {turn}");
        assert!(turn.contains("Pat's answers to your cards since your last turn here:\n- Your card \"Book the bigger room?\": Chose: Book.\n"), "{turn}");
        assert!(!turn.contains("Which caterer?"), "{turn}");

        s.resume = false;
        let quiet = first_message(&s, &run(scheduled("s1", true)));
        assert!(quiet.starts_with("<omega-star>\nOmega Star wrote this note. It is not a message from Pat.\n\nPat has approved these"), "{quiet}");
        assert!(quiet.contains("Which caterer?") && !quiet.contains("Now: "), "a quiet routine with nothing new hears what stands, and no clock: {quiet}");
        s.owns = String::new();
        s.opening.as_mut().unwrap().answers.clear();
        assert_eq!(first_message(&s, &run(scheduled("s1", true))), "Go.");
    }

    #[test]
    fn the_opening_note_brings_news_held_reports_and_replaced_cards() {
        let now = chrono::Utc::now();
        let mut card = Card::new("Book the bigger room?", None, Some("ask:room".into()), CardAsk::Choices { choices: vec!["Book".into()], recommended: 0 });
        card.answer = Some(CardAnswer { at: now, how: AnswerHow::Replaced, text: String::new(), held: false });
        let o = Opening {
            now,
            news: vec![(now, "Bo".into(), "The new opening hours are up.".into())],
            held: vec![("Cy".into(), "Count the till.".into(), "The till holds 40 coins.\nAll counted.".into())],
            replaced: vec![(now, card)],
            ..Opening::default()
        };
        let mut s = snap();
        s.opening = Some(o);
        let text = first_message(&s, &run(RunKind::Manual));
        assert!(text.contains("\n\nNews from colleagues. It needs no reply:\n- Bo, "), "{text}");
        assert!(text.contains(": The new opening hours are up.\n"), "{text}");
        assert!(
            text.contains(
                "\n\nReports from your team that came back after your run had ended. They reach you only here, so act on each in this run:\n\
- Cy. Task: Count the till.\n  Report: The till holds 40 coins. All counted.\n"
            ),
            "{text}"
        );
        assert!(
            text.contains("\n\nYour cards replaced since your last run. Ask again only if one still needs Pat:\n- \"Book the bigger room?\" (key `room`) was replaced by a newer card on "),
            "{text}"
        );
        assert!(text.contains(", so it is no longer in Pat's Inbox."), "{text}");
        assert!(text.find("News from colleagues").unwrap() < text.find("Reports from your team").unwrap(), "news comes first: {text}");
        assert!(!text.contains('\u{2014}'), "{text}");
    }

    #[test]
    fn quiet_runs_fold_into_one_line_per_routine() {
        let mut o = now_opening(None);
        for i in 0..47 {
            o.work.push(done(scheduled("s1", true), 10 + i, &format!("Nothing new in run {i}.")));
        }
        let mut flagged = done(scheduled("s1", true), 5, "Found a renewal notice.");
        flagged.needs_you = vec!["The domain renews on Friday.".into()];
        o.work.insert(0, flagged);
        o.parents = [o.work[3].id.clone(), o.work[9].id.clone()].into();
        let run = Run::new("e1", RunKind::Manual, "Go.".into(), chrono::Utc::now());
        let text = first_message(&snapshot(Some(o), false), &run);
        let fold = text.lines().find(|l| l.contains("quiet runs")).unwrap();
        assert!(fold.starts_with("- Inbox sweep: 47 quiet runs since "), "{fold}");
        assert!(fold.contains(", 2 reached someone. Latest (") && fold.ends_with("): Nothing new in run 0."), "{fold}");
        let raised = text.lines().find(|l| l.contains("(you raised: The domain renews on Friday.)")).unwrap();
        assert!(raised.contains("scheduled 'Inbox sweep': Found a renewal notice."), "{raised}");
        assert_eq!(text.lines().filter(|l| l.starts_with("- ")).count(), 2, "{text}");

        let mut o = now_opening(None);
        o.work = (0..3).map(|i| done(scheduled("s1", true), 10 + i, "Nothing new.")).collect();
        let text = first_message(&snapshot(Some(o), false), &run);
        assert!(text.contains("3 quiet runs since ") && text.contains(", none reached anyone. Latest ("), "{text}");
    }

    #[test]
    fn a_long_report_keeps_its_start_and_its_end() {
        let mut o = now_opening(None);
        let summary = format!("Reconciled the accounts. {}**Still open:** the bank has not confirmed the transfer.", "Checked every line twice. ".repeat(35));
        assert!(summary.chars().count() > 900);
        o.work = vec![done(RunKind::Manual, 30, &summary)];
        let run = Run::new("e1", RunKind::Manual, "Go.".into(), chrono::Utc::now());
        let text = first_message(&snapshot(Some(o), false), &run);
        let line = text.lines().find(|l| l.contains("Reconciled the accounts.")).unwrap();
        assert!(line.contains(" ... ") && line.ends_with("**Still open:** the bank has not confirmed the transfer."), "{line}");
        assert_eq!(ends("short", 150), "short");
    }

    #[test]
    fn a_quiet_routine_with_nothing_new_gets_no_note() {
        let quiet = Run::new("e1", scheduled("s1", true), "Sweep the inbox.".into(), chrono::Utc::now());
        let since = Some(chrono::Utc::now() - chrono::Duration::minutes(15));
        assert_eq!(first_message(&snapshot(Some(now_opening(since)), false), &quiet), quiet.prompt);
        let loud = Run::new("e1", scheduled("s2", false), "Write the weekly report.".into(), chrono::Utc::now());
        let text = first_message(&snapshot(Some(now_opening(since)), false), &loud);
        let note = text.split_once("\n\n").unwrap().1;
        assert!(note.starts_with("Now: ") && note.contains(".\n</omega-star>"), "only the time: {text}");
        assert_eq!(first_message(&snapshot(None, false), &quiet), quiet.prompt, "no note at all");
    }
}
