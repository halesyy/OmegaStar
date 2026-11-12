//! Schedules and the checks employees leave themselves for later.

use super::*;

/// Checks an employee may hold open at once; more means they are using the tool as a notebook.
const MAX_OPEN_CHECKS: usize = 20;
/// The soonest a check comes due: a check waits for something to show, it does not poll for it.
const MIN_CHECK_HOURS: i64 = 6;
/// What the schedule tool tells an employee whose routine runs more often than hourly on a heavier model.
const LIGHT_MODEL_TIP: &str = "This routine runs more often than hourly. If each run is a simple check, set model \"haiku\" and effort \"low\" on it: it costs a fraction and finishes sooner.";

impl Office {
    fn with_next_fire(mut s: Schedule, hours: &BusinessHours) -> Schedule {
        s.next_fire = if s.enabled { next_slot(&s, hours, now(), &Local) } else { None };
        s
    }

    pub fn schedules(&self, employee_id: &str) -> Result<Vec<Schedule>> {
        let hours = self.settings()?.watch.hours;
        Ok(self.db().schedules(employee_id)?.into_iter().map(|s| Self::with_next_fire(s, &hours)).collect())
    }

    pub fn save_schedule(&self, d: ScheduleDraft) -> Result<Schedule> {
        schedule::parse(&d.cron).map_err(|e| AppError::invalid(format!("cron: {e}")))?;
        let s = {
            let db = self.db();
            db.employee(&d.employee_id)?.ok_or_else(|| AppError::not_found("employee not found"))?;
            let existing = match &d.id {
                Some(id) => Some(db.schedule(id)?.ok_or_else(|| AppError::not_found("schedule not found"))?),
                None => None,
            };
            // Re-timing the weekly review keeps it the review.
            let review = existing.as_ref().map(|(o, _)| o.review).unwrap_or(false);
            let s = Schedule {
                id: d.id.clone().unwrap_or_else(|| uuid::Uuid::new_v4().to_string()),
                employee_id: d.employee_id,
                label: if d.label.trim().is_empty() { d.cron.trim().to_string() } else { d.label.trim().to_string() },
                cron: d.cron.trim().to_string(),
                instruction: d.instruction,
                enabled: d.enabled,
                misfire: Misfire::CatchUp,
                quiet: d.quiet,
                model: d.model,
                effort: d.effort,
                review,
                active_hours: d.active_hours,
                next_fire: None,
            };
            // A new, re-timed or re-enabled schedule starts counting from now: it never fires for
            // slots that passed before the edit.
            let last = match existing {
                Some((old, last)) if old.cron == s.cron && (old.enabled || !s.enabled) => last,
                _ => now(),
            };
            db.save_schedule(&s, last)?;
            s
        };
        self.sink().org_changed();
        Ok(Self::with_next_fire(s, &self.settings()?.watch.hours))
    }

    pub fn delete_schedule(&self, id: &str) -> Result<()> {
        self.db().delete_schedule(id)?;
        self.sink().org_changed();
        Ok(())
    }

    /// Gives every employee the weekly review, once per office: a review someone deletes never returns. A
    /// review still as first seeded gets today's instruction, and so does one an older build saved without
    /// its flag, which gets the flag back. Either keeps its times, model and effort.
    pub(super) fn seed_reviews(&self) -> Result<()> {
        let db = self.db();
        if db.reviews_seeded()? {
            let ceo = ceo_of(&db)?;
            let (old, new) = (first_review_instruction(&ceo), review_instruction(&ceo));
            return db.tx(|| {
                for (mut s, last) in db.all_schedules()? {
                    let unflagged = lost_review_flag(&s);
                    if unflagged || (s.review && s.instruction == old) {
                        if unflagged {
                            log!("schedule {} is the weekly review again: an older build saved it without its flag", s.id);
                        }
                        s.review = true;
                        s.instruction = new.clone();
                        db.save_schedule(&s, last)?;
                    }
                }
                Ok(())
            });
        }
        let ceo = ceo_of(&db)?;
        db.tx(|| {
            for (nth, e) in db.employees()?.iter().enumerate() {
                Self::seed_review(&db, e, &ceo, nth)?;
            }
            db.set_reviews_seeded()
        })
    }

    /// Adds `e`'s weekly review on Monday: 7 am for the first employee, then ten minutes later for each one
    /// after (`nth`), up to 7:50, so the team does not all start at once. It counts from now, so it never
    /// fires for a slot already past.
    pub(super) fn seed_review(db: &Store, e: &Employee, ceo: &str, nth: usize) -> Result<()> {
        let s = Schedule {
            id: uuid::Uuid::new_v4().to_string(),
            employee_id: e.id.clone(),
            label: "Weekly review".into(),
            cron: format!("{} 7 * * 1", nth % 6 * 10),
            instruction: review_instruction(ceo),
            enabled: true,
            misfire: Misfire::CatchUp,
            quiet: false,
            model: None,
            effort: None,
            review: true,
            active_hours: false,
            next_fire: None,
        };
        db.save_schedule(&s, now())
    }

    pub fn cron_preview(&self, cron: &str) -> CronPreview {
        schedule::preview(cron, now(), &Local)
    }

    /// One scheduler pass at `now`: cards you said Later to whose day has come (paused or not: no run starts for
    /// them), then due schedule slots and due checks. Inserting the run row is the claim, so a slot or a check's due
    /// date fires once however often this runs.
    pub fn tick(&self, now: Ts) -> Result<()> {
        if let Err(e) = self.bring_back_cards(now) {
            log!("bringing back the cards due by {now} failed: {e}");
        }
        let created = {
            let db = self.db();
            let settings = db.settings()?.unwrap_or_default();
            if settings.paused {
                return Ok(());
            }
            let mut created = vec![];
            for (s, last) in db.all_schedules()? {
                if !s.enabled {
                    continue;
                }
                let Ok(cron) = schedule::parse(&s.cron) else { continue };
                let Some(slot) = schedule::due_slot(&cron, last, now, &Local) else { continue };
                db.set_last_slot(&s.id, slot)?;
                // Kept to business hours: a slot outside them is skipped, never caught up later.
                if s.active_hours && !watch::in_hours(slot, &settings.watch.hours, &Local) {
                    continue;
                }
                if db.schedule_has_queued_run(&s.id)? {
                    continue;
                }
                let Some(e) = db.employee(&s.employee_id)? else { continue };
                let prompt = slot_prompt(&db, &s, &e, slot)?;
                let kind = RunKind::Scheduled { schedule_id: s.id.clone(), slot, label: s.label.clone(), quiet: s.quiet, model: s.model.clone(), effort: s.effort, review: s.review };
                let run = Run::new(&s.employee_id, kind, prompt, now);
                if db.insert_run(&run, &run.id)? {
                    created.push(run);
                }
            }
            // A check set in a conversation you are in, and not archived, comes back into it as its next turn.
            let (mut checks, mut into) = (vec![], HashMap::new());
            for c in db.checks_to_run(now)? {
                let t = Self::set_in(&db, &c)?;
                if t.as_ref().is_some_and(|t| turned(&c, t)) {
                    continue;
                }
                if let Some(t) = t.filter(|t| t.root.archived_at.is_none() && inbox::yours(t)) {
                    into.insert(c.id.clone(), t);
                }
                checks.push(c);
            }
            let (mut busy, mut departed) = (HashSet::new(), HashSet::new());
            for id in checks.iter().map(|c| &c.employee_id).collect::<HashSet<_>>() {
                if db.employee(id)?.is_none() {
                    departed.insert(id.clone());
                } else if db.active_runs_of(id)?.iter().any(|r| r.check_id().is_some()) {
                    busy.insert(id.clone());
                }
            }
            for run in due_check_runs(checks, &busy, &departed, &ceo_of(&db)?, now) {
                let (run, session) = match run.kind.check_id().and_then(|id| into.get(id)) {
                    Some(t) => {
                        let (latest, resumes) = Self::next_turn(&db, t)?;
                        let turn = into_turn(run, t);
                        let session = if resumes { latest.session } else { turn.id.clone() };
                        (turn, session)
                    }
                    None => {
                        let session = run.id.clone();
                        (run, session)
                    }
                };
                if db.insert_run(&run, &session)? {
                    created.push(run);
                }
            }
            created
        };
        for r in &created {
            self.sink().run_updated(r);
        }
        if !created.is_empty() {
            self.sink().org_changed();
        }
        // Every tick, not only one that queued work: a hold may have ended, or a dark wake turned full.
        self.release_hold(now);
        self.pump();
        Ok(())
    }

    /// The thread of the run that set `c`, while that run and its thread's first run are still there.
    fn set_in(db: &Store, c: &Check) -> Result<Option<Thread>> {
        let Some(id) = c.run_id.as_deref() else { return Ok(None) };
        match Self::thread_in(db, id) {
            Ok(t) => Ok(Some(t)),
            Err(e) if e.code == crate::error::ErrorCode::NotFound => Ok(None),
            Err(e) => Err(e),
        }
    }

    // ------------------------------------------------------------------ checks

    pub fn checks(&self, employee_id: &str) -> Result<Vec<Check>> {
        self.db().checks(employee_id, None)
    }

    /// The person you work for decides a check no longer matters.
    pub fn drop_check(&self, check_id: &str) -> Result<Check> {
        let c = {
            let db = self.db();
            let mut c = db.check(check_id)?.ok_or_else(|| AppError::not_found("check not found"))?;
            if c.state != CheckState::Open {
                return Err(AppError::conflict("that check is already closed"));
            }
            c.state = CheckState::Dropped;
            c.closed_at = Some(now());
            db.save_check(&c)?;
            c
        };
        self.sink().org_changed();
        Ok(c)
    }

    pub fn check_later_tool(&self, run_id: &str, caller: &Employee, args: &Value) -> Result<Value> {
        let text = |k: &str| args.get(k).and_then(|v| v.as_str()).unwrap_or("").trim().to_string();
        let (what, how) = (text("what"), text("how"));
        if what.is_empty() || how.is_empty() {
            return Err(AppError::invalid("what and how are both required: what you will find out, and where or how you will look"));
        }
        let days = args.get("inDays").and_then(|v| v.as_f64()).unwrap_or(7.0);
        if !(0.0..=180.0).contains(&days) {
            return Err(AppError::invalid("inDays must be between 0 and 180"));
        }
        let minutes = (days * 24.0 * 60.0) as i64;
        let raised = minutes < MIN_CHECK_HOURS * 60;
        let (c, moved) = {
            let db = self.db();
            let at = now();
            let due_at = at + chrono::Duration::minutes(minutes.max(MIN_CHECK_HOURS * 60));
            let open = db.checks(&caller.id, Some(CheckState::Open))?;
            // The check this run is doing closes with check_done, so setting it again is a new check.
            let doing = db.run(run_id)?.and_then(|r| r.run.check_id().map(String::from));
            match open.iter().find(|c| Some(&c.id) != doing.as_ref() && same_check(&c.what, &what)) {
                Some(c) => {
                    let c = Check { due_at, ..c.clone() };
                    db.save_check(&c)?;
                    (c, true)
                }
                None => {
                    if open.len() >= MAX_OPEN_CHECKS {
                        return Err(AppError::conflict(format!("you already hold {MAX_OPEN_CHECKS} open checks: close some with check_done before adding more")));
                    }
                    let c = Check {
                        id: uuid::Uuid::new_v4().to_string(),
                        employee_id: caller.id.clone(),
                        what,
                        how,
                        due_at,
                        state: CheckState::Open,
                        created_at: at,
                        run_id: Some(run_id.to_string()),
                        closed_at: None,
                        result: None,
                    };
                    db.save_check(&c)?;
                    (c, false)
                }
            }
        };
        self.sink().org_changed();
        let mut note = String::new();
        if raised {
            note.push_str(&format!("Checks come due at least {MIN_CHECK_HOURS} hours out, so this one is due in {MIN_CHECK_HOURS} hours. "));
        }
        if moved {
            note.push_str("You already had this check open, so it moved to the new date instead of adding another. ");
        }
        note.push_str("On its due date Omega Star starts a quiet run of yours to do it, or brings it back into this conversation if you set it in one that is still open. Do not also leave it as a note in a skill or promise it in your report.");
        Ok(json!({ "check": c, "note": note }))
    }

    pub fn my_checks(&self, caller: &Employee) -> Result<Value> {
        let at = now();
        let open: Vec<Value> = self
            .db()
            .checks(&caller.id, Some(CheckState::Open))?
            .into_iter()
            .map(|c| json!({ "id": c.id, "what": c.what, "how": c.how, "due": c.due_at, "overdue": c.due_at <= at }))
            .collect();
        Ok(json!({ "now": at, "open": open }))
    }

    pub fn check_done_tool(&self, caller: &Employee, id: &str, result: &str) -> Result<Value> {
        if result.trim().is_empty() {
            return Err(AppError::invalid("result is required: say what you found"));
        }
        let c = {
            let db = self.db();
            let mut c = db.check(id)?.ok_or_else(|| AppError::not_found("check not found"))?;
            if c.employee_id != caller.id {
                return Err(AppError::invalid("that is not one of your checks"));
            }
            if c.state != CheckState::Open {
                return Err(AppError::conflict("that check is already closed"));
            }
            c.state = CheckState::Done;
            c.closed_at = Some(now());
            c.result = Some(result.trim().to_string());
            db.save_check(&c)?;
            c
        };
        self.sink().org_changed();
        Ok(json!({ "check": c, "note": "Now write what you found into the skill it belongs to, with today's date, so it is not lost." }))
    }
}

/// The runs for due checks, oldest first: at most one per employee per pass, and none for someone who
/// has left or already has a check run queued or running (`busy`). Pure.
fn due_check_runs(mut checks: Vec<Check>, busy: &HashSet<String>, departed: &HashSet<String>, ceo: &str, now: Ts) -> Vec<Run> {
    checks.sort_by_key(|c| c.due_at);
    let mut taken = HashSet::new();
    checks
        .into_iter()
        .filter(|c| !busy.contains(&c.employee_id) && !departed.contains(&c.employee_id) && taken.insert(c.employee_id.clone()))
        .map(|c| {
            let kind = RunKind::Scheduled {
                schedule_id: format!("{CHECK_PREFIX}{}", c.id),
                slot: c.due_at,
                label: format!("Check: {}", claude::clip(&claude::one_line(&c.what), 60)),
                quiet: true,
                model: None,
                effort: None,
                review: false,
            };
            Run::new(&c.employee_id, kind, check_prompt(&c, ceo), now)
        })
        .collect()
}

/// A due check's run as the next turn of `t`, the conversation it was set in: a reply Omega Star writes there with
/// the same instruction, so what it finds shows where the work began. Named as a reply you type there is. Pure.
fn into_turn(run: Run, t: &Thread) -> Run {
    let (label, task) = threads::reply_label(&t.root);
    let check = run.kind.check_id().map(String::from);
    Run { kind: RunKind::Reply { to_run_id: t.root.id.clone(), label, task, card: false }, omega_wrote: true, check, ..run }
}

/// `c` already came back into `t` for its due date: that turn is its claim, as a check's own run is. Pure.
fn turned(c: &Check, t: &Thread) -> bool {
    t.replies.iter().any(|r| r.check.as_deref() == Some(c.id.as_str()) && r.created_at >= c.due_at)
}

/// Two checks are about the same thing when their `what` reads the same, whatever the case and spacing. Pure.
fn same_check(a: &str, b: &str) -> bool {
    a.split_whitespace().map(str::to_lowercase).eq(b.split_whitespace().map(str::to_lowercase))
}

/// The next slot `s` runs at after `after`. One kept to business hours skips the slots outside them,
/// looking up to a year or 20,000 slots ahead (two weeks of a routine that runs every minute). Pure.
pub(super) fn next_slot<Tz: chrono::TimeZone>(s: &Schedule, hours: &BusinessHours, after: Ts, tz: &Tz) -> Option<Ts> {
    let mut slots = schedule::slots_after(&schedule::parse(&s.cron).ok()?, after, tz);
    if !s.active_hours {
        return slots.next();
    }
    let until = after + chrono::Duration::days(366);
    slots.take_while(|t| *t <= until).take(20_000).find(|t| watch::in_hours(*t, hours, tz))
}

/// Whether `cron` runs more often than hourly: two of its next dozen slots are under an hour apart. Pure.
fn more_than_hourly<Tz: chrono::TimeZone>(cron: &str, after: Ts, tz: &Tz) -> bool {
    let Ok(cron) = schedule::parse(cron) else { return false };
    let next: Vec<Ts> = schedule::slots_after(&cron, after, tz).take(12).collect();
    next.windows(2).any(|w| w[1] - w[0] < chrono::Duration::hours(1))
}

/// What the schedule tool adds for a routine that runs more often than hourly on a model heavier than Haiku.
pub(super) fn light_model_tip(s: &Schedule) -> Option<&'static str> {
    let light = s.model.as_deref().is_some_and(|m| m.to_ascii_lowercase().contains("haiku"));
    (!light && more_than_hourly(&s.cron, now(), &Local)).then_some(LIGHT_MODEL_TIP)
}

/// The instruction of a due check's run.
fn check_prompt(c: &Check, ceo: &str) -> String {
    format!(
        "Your check is due (check id `{}`, set {}): {}\nHow: {}\n\nDo it now. Close it with check_done and what you found, and write the finding \
where it belongs. Then act on it within your remit: fix it, hand it to whoever owns it, or put a card to {ceo} with notify if only they \
can decide. If it cannot be settled yet, close it saying why and set a new check_later for the day it can.",
        c.id,
        c.created_at.with_timezone(&Local).format("%Y-%m-%d"),
        c.what,
        c.how
    )
}

/// The instruction of the weekly review Omega Star seeds for every employee.
fn review_instruction(ceo: &str) -> String {
    format!(
        "Your weekly review. Omega Star adds what it counted this week below.
1. Measure your number with a command you can rerun, compare it with last week, and record it with report_number. If you have no number yet, pick one that shows your objective moving.
2. For each routine, decide to keep it, reshape it or stop it, and change your own schedules to match.
3. Act on the biggest lever your remit allows. Put each decision only {ceo} can make on a card of its own, with your recommendation.
4. Close every check that is due or overdue with check_done, or close it and set a new check_later for the day it can be settled. Leave checks that are not due yet.
5. Remove each blocker you hit twice: fix it, hand it to a colleague, or raise one chore card.
6. Check your skills and routing rules against the current team, and remove any rule your runs wrote this week that a run next month would not need. Leave every rule {ceo} taught you (marked taught or confirmed) as it is: to merge or drop one, put it to {ceo} on a card with your recommendation.
7. Read what-you-own.md in your folder. If it is empty or out of date, write the version you propose there: the number you answer for, your limits, and what you decide alone. Omega Star puts the file back and shows {ceo} your version: only they set it.
Your report is one sentence on what you changed this week. Your number and your cards already reach {ceo}: do not repeat them."
    )
}

/// A weekly review an older build saved without its flag, known by the name and opening Omega Star gave
/// it. It runs as a plain routine: no brief, and report_number refuses it. Pure.
fn lost_review_flag(s: &Schedule) -> bool {
    !s.review && s.label == "Weekly review" && s.instruction.trim_start().starts_with("Your weekly review.")
}

/// The weekly review's instruction as Omega Star seeded it before reviews recorded a number, so a review
/// nobody edited can be brought up to date.
fn first_review_instruction(ceo: &str) -> String {
    format!(
        "Your weekly review. Omega Star adds what it counted this week below.
1. Measure your number with a command you can rerun, and compare it with last week. If you have no number yet, pick one that shows your objective moving.
2. For each routine, decide to keep it, reshape it or stop it, and change your own schedules to match.
3. Act on the biggest lever your remit allows, or put the decision to {ceo} as a card with your recommendation.
4. Close every check that is due or overdue with check_done, or close it and set a new check_later for the day it can be settled. Leave checks that are not due yet.
5. Remove each blocker you hit twice: fix it, hand it to a colleague, or raise one chore card.
6. Check your skills and routing rules against the current team, and remove any rule your runs wrote this week that a run next month would not need. Leave every rule {ceo} taught you (marked taught or confirmed) as it is: to merge or drop one, put it to {ceo} on a card with your recommendation.
7. Read what-you-own.md in your folder. If it is empty or out of date, write the version you propose there: the number you answer for, your limits, and what you decide alone. Omega Star puts the file back and shows {ceo} your version: only they set it.
End with at most three lines. The first opens with your number."
    )
}

/// The instruction a schedule's run at `slot` is given. A weekly review keeps its stored instruction, so
/// an employee's own edit of it stands, and gets what Omega Star counted over the week before it.
fn slot_prompt(db: &Store, s: &Schedule, e: &Employee, slot: Ts) -> Result<String> {
    if !s.review {
        return Ok(if s.instruction.trim().is_empty() { DEFAULT_PROMPT.to_string() } else { s.instruction.clone() });
    }
    let ceo = ceo_of(db)?;
    let instruction = if s.instruction.trim().is_empty() { review_instruction(&ceo) } else { s.instruction.clone() };
    let brief = review_brief(db, e, &ceo, slot - chrono::Duration::days(7))?;
    Ok(if brief.is_empty() { instruction } else { format!("{instruction}\n\n{brief}") })
}

/// What Omega Star counted for `e`'s weekly review since `since`: their routines, open checks, cards still
/// waiting on `ceo`, and the rules their runs wrote with nobody watching. A section with nothing in it is
/// left out, and with nothing at all the brief is empty.
fn review_brief(db: &Store, e: &Employee, ceo: &str, since: Ts) -> Result<String> {
    let at = now();
    let day = |t: Ts| t.with_timezone(&Local).format("%A %-d %B").to_string();
    let ago = |t: Ts| match (at - t).num_days() {
        n if n <= 0 => "today".to_string(),
        1 => "1 day ago".to_string(),
        n => format!("{n} days ago"),
    };
    let quote = |s: &str| claude::clip(&claude::one_line(s), 200);
    let mut sections = vec![];

    let routines: Vec<String> = db
        .routine_counts(Some(&e.id), since)?
        .into_iter()
        .map(|c| {
            let runs = if c.runs == 1 { "1 run".to_string() } else { format!("{} runs", c.runs) };
            let usage = usd(c.cost_usd).map(|u| format!(", usage {u}")).unwrap_or_default();
            if c.quiet {
                format!("- {} (quiet): {runs}, {} did something, {} reached someone, {} failed{usage}", c.label, c.useful, c.reached, c.failed)
            } else {
                format!("- {}: {runs}, each reported to {ceo}, {} did something{usage}", c.label, c.useful)
            }
        })
        .collect();
    if !routines.is_empty() {
        sections.push(format!(
            "Your routines:\n{}\n\nA run did something when it raised a card, handed work to a colleague, changed a skill or failed. \
Usage is what the runs cost at API list price.",
            routines.join("\n")
        ));
    }

    let checks: Vec<String> = db
        .checks(&e.id, Some(CheckState::Open))?
        .into_iter()
        .map(|c| format!("- \"{}\": set {}, due {}", quote(&c.what), ago(c.created_at), day(c.due_at)))
        .collect();
    if !checks.is_empty() {
        sections.push(format!("Your open checks:\n{}", checks.join("\n")));
    }

    let cards: Vec<String> = db
        .open_cards(&e.id)?
        .into_iter()
        .flat_map(|r| {
            let at = r.ended_at.unwrap_or(r.created_at);
            r.cards.into_iter().filter(Card::is_open).map(move |c| format!("- \"{}\": raised {}", quote(&c.message), ago(at))).collect::<Vec<_>>()
        })
        .collect();
    if !cards.is_empty() {
        sections.push(format!("Your cards still waiting on {ceo}:\n{}", cards.join("\n")));
    }

    let mut rules = vec![];
    for (rev, run) in db.unattended_revisions(&e.id, since)? {
        let Some(after) = rev.after.as_deref().filter(|_| rev.change.file.ends_with(".md")) else { continue };
        for line in added_rule_lines(rev.before.as_deref().unwrap_or(""), after) {
            let when = rev.at.with_timezone(&Local).format("%A");
            rules.push(format!("- `{}` {}: \"{}\" ({}, {when})", rev.change.skill, rev.change.file, quote(&line), threads::report_label(&run.kind)));
        }
    }
    if rules.len() > RULES_LISTED {
        let more = rules.len() - RULES_LISTED;
        rules.truncate(RULES_LISTED);
        rules.push(format!("({more} more left out)"));
    }
    if !rules.is_empty() {
        sections.push(format!(
            "Rules your runs wrote with nobody watching:\n{}\n\nKeep a rule only if a run next month needs it. A rule about security alerts, \
money or deleting anything should have been a card: remove it and raise the card now.",
            rules.join("\n")
        ));
    }

    if sections.is_empty() {
        return Ok(String::new());
    }
    Ok(format!("## What Omega Star counted since {}\n\n{}", day(since), sections.join("\n\n")))
}

/// How many rule lines a weekly review's brief lists.
const RULES_LISTED: usize = 40;

/// Usage in US dollars as the brief gives it, or `None` when no run recorded a cost. Pure.
fn usd(cost: f64) -> Option<String> {
    (cost > 0.0).then(|| if cost < 0.01 { "under $0.01".to_string() } else { format!("${cost:.2}") })
}

/// The lines a revision added: lines of `after` not in `before`, trimmed, leaving out blank lines,
/// headings, anything shorter than four words, and records rather than rules: table rows and lines that
/// open with a date, as a log's entries do. Pure.
fn added_rule_lines(before: &str, after: &str) -> Vec<String> {
    let old: HashSet<&str> = before.lines().map(str::trim).collect();
    let record = |l: &str| l.starts_with('|') || dated(l.trim_start_matches(['-', '*', ' ']));
    after
        .lines()
        .map(str::trim)
        .filter(|l| !l.is_empty() && !l.starts_with('#') && !record(l) && !old.contains(l) && l.split_whitespace().count() >= 4)
        .map(String::from)
        .collect()
}

/// `l` opens with an ISO date, such as `2026-10-14`. Pure.
fn dated(l: &str) -> bool {
    let b = l.as_bytes();
    b.len() >= 10 && b[..10].iter().enumerate().all(|(i, c)| if i == 4 || i == 7 { *c == b'-' } else { c.is_ascii_digit() })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::fixtures::{self, acme, open_office, task, temp_dir};

    fn check(employee_id: &str, what: &str, due_at: Ts) -> Check {
        Check {
            id: uuid::Uuid::new_v4().to_string(),
            employee_id: employee_id.into(),
            what: what.into(),
            how: "Rerun the weekly report".into(),
            due_at,
            state: CheckState::Open,
            created_at: due_at - chrono::Duration::days(7),
            run_id: None,
            closed_at: None,
            result: None,
        }
    }

    #[test]
    fn due_checks_run_one_per_employee() {
        let t = now();
        let day = chrono::Duration::days(1);
        let newer = check("ada", "Did the newer fix hold", t - day);
        let older = check("ada", "Did the older fix hold", t - day * 2);
        let bo = check("bo", "Did signups move", t - day);
        let none = HashSet::new();
        let runs = due_check_runs(vec![newer, older.clone(), bo.clone()], &none, &none, "Pat", t);
        let got: Vec<(&str, Option<&str>)> = runs.iter().map(|r| (r.employee_id.as_str(), r.kind.check_id())).collect();
        assert_eq!(got, vec![("ada", Some(older.id.as_str())), ("bo", Some(bo.id.as_str()))]);
        match &runs[0].kind {
            RunKind::Scheduled { slot, label, quiet, review, .. } => {
                assert_eq!((*slot, label.as_str(), *quiet, *review), (older.due_at, "Check: Did the older fix hold", true, false));
            }
            k => panic!("{k:?}"),
        }
        assert!(runs[0].prompt.contains(&format!("check id `{}`", older.id)));
        assert!(runs[0].prompt.contains("put a card to Pat with notify"));

        let ada: HashSet<String> = ["ada".to_string()].into();
        let bo_only = |busy: &HashSet<String>, departed: &HashSet<String>| -> Vec<String> {
            due_check_runs(vec![older.clone(), bo.clone()], busy, departed, "Pat", t).into_iter().map(|r| r.employee_id).collect()
        };
        assert_eq!(bo_only(&ada, &none), vec!["bo"]);
        assert_eq!(bo_only(&none, &ada), vec!["bo"]);
    }

    #[test]
    fn a_check_back_in_a_report_thread_is_named_like_a_reply_there() {
        let sweep = RunKind::Scheduled { schedule_id: "s1".into(), slot: now(), label: "Inbox sweep".into(), quiet: true, model: None, effort: None, review: false };
        let report = Run::new("ada", sweep, "Sweep.".into(), now() - chrono::Duration::days(2));
        let c = check("ada", "Did the fix hold", now() - chrono::Duration::hours(1));
        let run = due_check_runs(vec![c.clone()], &HashSet::new(), &HashSet::new(), "Pat", now()).remove(0);
        let turn = into_turn(run.clone(), &Thread::new(report.clone(), vec![]));
        assert_eq!(turn.kind, RunKind::Reply { to_run_id: report.id.clone(), label: "Inbox sweep".into(), task: false, card: false });
        assert_eq!((&turn.id, &turn.prompt, turn.omega_wrote, turn.check_id()), (&run.id, &run.prompt, true, Some(c.id.as_str())));
        let back = Thread::new(report, vec![turn]);
        assert!(turned(&c, &back));
        assert!(!turned(&Check { due_at: now() + chrono::Duration::days(1), ..c.clone() }, &back), "set again for a later day, it comes back again");
    }

    #[test]
    fn a_check_label_is_one_short_line() {
        let long = format!("Did the fix\nhold {}", "and more ".repeat(20));
        let runs = due_check_runs(vec![check("ada", &long, now())], &HashSet::new(), &HashSet::new(), "Pat", now());
        let RunKind::Scheduled { label, .. } = &runs[0].kind else { panic!() };
        assert!(label.starts_with("Check: Did the fix hold and more"));
        assert!(!label.contains('\n') && label.chars().count() <= "Check: ".len() + 63);
    }

    #[test]
    fn the_review_instruction_names_the_ceo_without_dashes() {
        let text = review_instruction("Pat");
        assert!(text.contains("Put each decision only Pat can make on a card of its own"));
        assert!(!text.contains('\u{2014}') && !check_prompt(&check("ada", "x", now()), "Pat").contains('\u{2014}'));
    }

    #[test]
    fn the_brief_gives_usage_in_dollars() {
        assert_eq!(usd(0.0), None, "no run recorded a cost");
        assert_eq!(usd(0.004).as_deref(), Some("under $0.01"));
        assert_eq!(usd(12.3).as_deref(), Some("$12.30"));
    }

    #[test]
    fn added_rule_lines_are_new_lines_that_read_as_rules() {
        let before = "# Ops\n\nAlways check the queue first.\n";
        let after = "# Ops\n\n  Always check the queue first.  \n## Alerts\nSkip it.\n\n  Archive security alerts from the bank without asking.\nMove spend over 50 to the shared sheet.\n";
        assert_eq!(
            added_rule_lines(before, after),
            vec!["Archive security alerts from the bank without asking.", "Move spend over 50 to the shared sheet."]
        );
        assert!(added_rule_lines(after, after).is_empty());
        let log = "| Handle | Followed on |\n| @ada | 2026-10-12 sent a hello |\n- 2026-10-12 followed @ada after her launch post\n2026-10-13: followed @bo, replied to his thread\nFollow back anyone who replies twice in a week.\n";
        assert_eq!(added_rule_lines("", log), vec!["Follow back anyone who replies twice in a week."], "log and table lines are records, not rules");
    }

    #[test]
    fn the_review_brief_lists_only_what_there_is() {
        let dir = temp_dir("brief");
        let db = Store::open(&dir.join("office.db")).unwrap();
        db.set_company(&acme()).unwrap();
        let hire = |slug: &str| {
            let e = employee(slug);
            db.save_employee(&e).unwrap();
            e
        };
        let (ada, bo) = (hire("ada"), hire("bo"));
        let t = now();
        let since = t - chrono::Duration::days(7);
        let finished = |e: &Employee, kind: RunKind, hours: i64| {
            let mut r = Run::new(&e.id, kind, "go".into(), t - chrono::Duration::hours(hours));
            r.state = RunState::Succeeded;
            r.ended_at = Some(r.created_at);
            r
        };
        let sweep = |hours: i64| RunKind::Scheduled {
            schedule_id: "s1".into(),
            slot: t - chrono::Duration::hours(hours),
            label: "Inbox sweep".into(),
            quiet: true,
            model: None,
            effort: None,
            review: false,
        };
        let routine = finished(&ada, sweep(30), 30);
        assert!(db.insert_run(&routine, &routine.id).unwrap());
        let mut carded = finished(&ada, sweep(50), 50);
        carded.needs_you = vec!["Boost the post?".into()];
        carded.cost_usd = Some(1.234);
        carded.cards = vec![Card::new("Boost the post?", None, Some("ask:boost".into()), CardAsk::Choices { choices: vec!["Not now".into(), "Go".into()], recommended: 0 })];
        assert!(db.insert_run(&carded, &carded.id).unwrap());
        let report = RunKind::Scheduled { schedule_id: "s2".into(), slot: t - chrono::Duration::hours(20), label: "Daily report".into(), quiet: false, model: None, effort: None, review: false };
        let daily = finished(&ada, report, 20);
        assert!(db.insert_run(&daily, &daily.id).unwrap());
        let mut c = check(&ada.id, "Did the fix hold", t + chrono::Duration::days(2));
        c.created_at = t - chrono::Duration::days(3);
        db.save_check(&c).unwrap();
        let change = SkillChange { skill: "ops".into(), file: "SKILL.md".into(), change: ChangeKind::Modified };
        let rev = SkillRevision {
            change,
            id: uuid::Uuid::new_v4().to_string(),
            run_id: Some(routine.id.clone()),
            at: t - chrono::Duration::hours(29),
            before: Some("# Ops\n".into()),
            after: Some("# Ops\nArchive security alerts without asking anyone.\n".into()),
        };
        db.insert_revision(&ada.id, &rev).unwrap();

        let brief = review_brief(&db, &ada, "Pat", since).unwrap();
        assert!(brief.starts_with(&format!("## What Omega Star counted since {}\n\nYour routines:\n", since.with_timezone(&Local).format("%A %-d %B"))));
        assert!(brief.contains("- Inbox sweep (quiet): 2 runs, 1 did something, 1 reached someone, 0 failed, usage $1.23\n"), "{brief}");
        assert!(
            brief.contains("- Daily report: 1 run, each reported to Pat, 0 did something\n\nA run did something when it raised a card, handed work"),
            "{brief}"
        );
        assert!(brief.contains("Your open checks:\n- \"Did the fix hold\": set 3 days ago, due "), "{brief}");
        assert!(brief.contains("Your cards still waiting on Pat:\n- \"Boost the post?\": raised 2 days ago"), "{brief}");
        assert!(brief.contains("- `ops` SKILL.md: \"Archive security alerts without asking anyone.\" (Inbox sweep, "), "{brief}");
        assert!(brief.ends_with("remove it and raise the card now."));
        assert!(!brief.contains('\u{2014}'));
        let many: String = (1..=45).map(|i| format!("Reply to thread number {i} within the hour.\n")).collect();
        let more = SkillRevision { id: uuid::Uuid::new_v4().to_string(), before: Some("# Ops\n".into()), after: Some(format!("# Ops\n{many}")), ..rev.clone() };
        db.insert_revision(&ada.id, &more).unwrap();
        let long = review_brief(&db, &ada, "Pat", since).unwrap();
        assert_eq!(long.matches("\n- `ops` SKILL.md: ").count(), RULES_LISTED);
        assert!(long.contains("\n(6 more left out)\n"), "{long}");

        let mut d = check(&bo.id, "Did signups move", t + chrono::Duration::days(1));
        d.created_at = t;
        db.save_check(&d).unwrap();
        let only_checks = review_brief(&db, &bo, "Pat", since).unwrap();
        assert!(only_checks.contains("- \"Did signups move\": set today"));
        for absent in ["Your routines:", "Your cards", "Rules your runs wrote", "Keep a rule"] {
            assert!(!only_checks.contains(absent), "{absent} in {only_checks}");
        }
        db.save_check(&Check { state: CheckState::Done, ..d }).unwrap();
        assert_eq!(review_brief(&db, &bo, "Pat", since).unwrap(), "");

        let review = |instruction: &str| Schedule {
            id: "r1".into(),
            employee_id: bo.id.clone(),
            label: "Weekly review".into(),
            cron: "0 7 * * 1".into(),
            instruction: instruction.into(),
            enabled: true,
            misfire: Misfire::CatchUp,
            quiet: false,
            model: None,
            effort: None,
            review: true,
            active_hours: false,
            next_fire: None,
        };
        assert_eq!(slot_prompt(&db, &review("Count the signups."), &bo, t).unwrap(), "Count the signups.", "the employee's own edit stands");
        assert_eq!(slot_prompt(&db, &review(" "), &bo, t).unwrap(), review_instruction("Pat"));
        let with_brief = slot_prompt(&db, &review(" "), &ada, t).unwrap();
        assert!(with_brief.starts_with(&format!("{}\n\n## What Omega Star counted since ", review_instruction("Pat"))));
        let routine_schedule = Schedule { review: false, ..review(" ") };
        assert_eq!(slot_prompt(&db, &routine_schedule, &ada, t).unwrap(), DEFAULT_PROMPT);

        drop(db);
        let _ = fs::remove_dir_all(&dir);
    }

    fn employee(slug: &str) -> Employee {
        Employee { slug: slug.into(), name: slug.into(), chat_session: format!("chat-{slug}"), ..fixtures::employee() }
    }

    /// An office of Pat's at Acme with `e` on it, and its folder.
    async fn office_with(e: &Employee) -> (Office, PathBuf) {
        let dir = temp_dir("schedules");
        {
            let db = Store::open(&dir.join("office.db")).unwrap();
            db.set_company(&acme()).unwrap();
            db.save_employee(e).unwrap();
        }
        (open_office(&dir).await, dir)
    }

    fn routine(employee_id: &str, cron: &str) -> Schedule {
        Schedule {
            id: "s1".into(),
            employee_id: employee_id.into(),
            label: "Inbox sweep".into(),
            cron: cron.into(),
            instruction: "Sweep the inbox.".into(),
            enabled: true,
            misfire: Misfire::CatchUp,
            quiet: true,
            model: None,
            effort: None,
            review: false,
            active_hours: false,
            next_fire: None,
        }
    }

    #[tokio::test]
    async fn every_employee_gets_one_review_once() {
        let ada = employee("ada");
        let (office, dir) = office_with(&ada).await;
        let reviews = office.schedules(&ada.id).unwrap();
        assert_eq!(reviews.len(), 1);
        let r = &reviews[0];
        assert!(r.review && r.enabled && !r.quiet);
        assert_eq!((r.label.as_str(), r.cron.as_str()), ("Weekly review", "0 7 * * 1"));
        assert_eq!(r.instruction, review_instruction("Pat"));
        assert!(!r.instruction.contains("propose_changes"), "a review cannot propose: only a tidy can");

        // Re-timing keeps it the review.
        let draft = ScheduleDraft {
            id: Some(r.id.clone()),
            employee_id: ada.id.clone(),
            label: r.label.clone(),
            cron: "0 8 * * 1".into(),
            instruction: r.instruction.clone(),
            enabled: true,
            quiet: false,
            model: None,
            effort: None,
            active_hours: false,
        };
        assert!(office.save_schedule(draft).unwrap().review);

        office.seed_reviews().unwrap();
        assert_eq!(office.schedules(&ada.id).unwrap().len(), 1, "seeded once");
        office.delete_schedule(&r.id).unwrap();
        office.seed_reviews().unwrap();
        assert!(office.schedules(&ada.id).unwrap().is_empty(), "a deleted review stays deleted");

        drop(office);
        let _ = fs::remove_dir_all(&dir);
    }

    #[tokio::test]
    async fn a_review_saved_without_its_flag_is_the_review_again() {
        let ada = employee("ada");
        let (office, dir) = office_with(&ada).await;
        let seeded = Schedule { next_fire: None, ..office.schedules(&ada.id).unwrap().remove(0) };
        // As an older build left it: no flag and the first wording, moved to another day, off, on a model of its own.
        let lost = Schedule {
            review: false,
            instruction: first_review_instruction("Pat"),
            cron: "30 15 * * 1".into(),
            enabled: false,
            model: Some("sonnet".into()),
            effort: Some(Effort::High),
            ..seeded.clone()
        };
        let named_alike = Schedule { id: "s2".into(), review: false, instruction: "Count the signups.".into(), ..seeded.clone() };
        let worded_alike = Schedule { id: "s3".into(), review: false, label: "Monday report".into(), ..lost.clone() };
        let last: Ts = "2026-10-19T04:30:00Z".parse().unwrap();
        for s in [&lost, &named_alike, &worded_alike] {
            office.db().save_schedule(s, last).unwrap();
        }

        office.seed_reviews().unwrap();
        let (fixed, fixed_last) = office.db().schedule(&lost.id).unwrap().unwrap();
        assert_eq!(fixed, Schedule { review: true, instruction: review_instruction("Pat"), ..lost.clone() }, "the flag and today's wording, nothing else");
        assert_eq!(fixed_last, last, "it counts its slots on from where it was");
        for s in [&named_alike, &worded_alike] {
            assert_eq!(office.db().schedule(&s.id).unwrap().unwrap().0, *s, "{} is not a review", s.instruction);
        }
        let brief = slot_prompt(&office.db(), &fixed, &ada, now()).unwrap();
        assert!(brief.starts_with(&review_instruction("Pat")), "it runs as the review again");

        drop(office);
        let _ = fs::remove_dir_all(&dir);
    }

    #[tokio::test]
    async fn a_check_comes_due_six_hours_out_at_the_soonest() {
        let ada = employee("ada");
        let (office, dir) = office_with(&ada).await;
        let set = |days: f64| office.check_later_tool("run-1", &ada, &json!({ "what": format!("Is the build green after {days} days?"), "how": "Open the CI page", "inDays": days })).unwrap();

        let soon = set(0.1);
        let c: Check = serde_json::from_value(soon["check"].clone()).unwrap();
        assert_eq!(c.due_at - c.created_at, chrono::Duration::hours(MIN_CHECK_HOURS));
        assert!(soon["note"].as_str().unwrap().starts_with("Checks come due at least 6 hours out, so this one is due in 6 hours. On its due date"));
        let later = set(0.5);
        let c: Check = serde_json::from_value(later["check"].clone()).unwrap();
        assert_eq!(c.due_at - c.created_at, chrono::Duration::hours(12));
        assert!(later["note"].as_str().unwrap().starts_with("On its due date"));

        drop(office);
        let _ = fs::remove_dir_all(&dir);
    }

    #[tokio::test]
    async fn setting_a_check_again_moves_the_open_one() {
        let ada = employee("ada");
        let (office, dir) = office_with(&ada).await;
        let set = |what: &str, days: f64, run_id: &str| office.check_later_tool(run_id, &ada, &json!({ "what": what, "how": "Open the store listing", "inDays": days }));
        let first: Check = serde_json::from_value(set("Did the listing go live?", 1.0, "run-1").unwrap()["check"].clone()).unwrap();

        // Its own run sets it again for later: that run closes this one with check_done, so it is a new check.
        let doing = due_check_runs(vec![first.clone()], &HashSet::new(), &HashSet::new(), "Pat", now()).remove(0);
        office.db().insert_run(&doing, &doing.id).unwrap();
        let next: Check = serde_json::from_value(set("Did the listing go live?", 1.0, &doing.id).unwrap()["check"].clone()).unwrap();
        assert_ne!(next.id, first.id);
        office.check_done_tool(&ada, &first.id, "Still in review.").unwrap();

        for i in 1..MAX_OPEN_CHECKS {
            office.db().save_check(&check(&ada.id, &format!("Did week {i} close?"), now() + chrono::Duration::days(1))).unwrap();
        }
        assert!(set("Something new?", 1.0, "run-2").unwrap_err().message.contains("20 open checks"));
        let before = now();
        let again = set("  did the LISTING go   live? ", 2.0, "run-2").unwrap();
        let after = now();
        let moved: Check = serde_json::from_value(again["check"].clone()).unwrap();
        assert_eq!((moved.id.as_str(), moved.created_at, moved.what.as_str()), (next.id.as_str(), next.created_at, next.what.as_str()), "the same check, even at the cap");
        assert!(moved.due_at >= before + chrono::Duration::days(2) && moved.due_at <= after + chrono::Duration::days(2));
        assert!(again["note"].as_str().unwrap().starts_with("You already had this check open, so it moved to the new date instead of adding another."));
        assert_eq!(office.checks(&ada.id).unwrap().iter().filter(|c| c.state == CheckState::Open).count(), MAX_OPEN_CHECKS);
        assert_eq!(office.db().check(&next.id).unwrap().unwrap().due_at, moved.due_at);

        drop(office);
        let _ = fs::remove_dir_all(&dir);
    }

    #[tokio::test]
    async fn a_check_set_in_a_conversation_you_are_in_comes_back_into_it() {
        let (ada, bo, cy) = (employee("ada"), employee("bo"), employee("cy"));
        let dir = temp_dir("check-back");
        {
            let db = Store::open(&dir.join("office.db")).unwrap();
            db.set_company(&acme()).unwrap();
            for e in [&ada, &bo, &cy] {
                db.save_employee(e).unwrap();
            }
            // Held, so nothing a tick queues starts.
            db.set_held_until(Some(now() + chrono::Duration::days(1))).unwrap();
        }
        let office = open_office(&dir).await;
        let t = now();
        let finished = |e: &Employee, kind: RunKind, archived: bool| {
            let mut r = Run::new(&e.id, kind, "Go.".into(), t - chrono::Duration::hours(30));
            r.state = RunState::Succeeded;
            r.ended_at = Some(r.created_at);
            r.archived_at = archived.then_some(t);
            assert!(office.db().insert_run(&r, &r.id).unwrap());
            office.db().mark_inited(&r.id).unwrap();
            r
        };
        let set = |by: &Run, what: &str| {
            let c = Check { run_id: Some(by.id.clone()), ..check(&by.employee_id, what, t - chrono::Duration::hours(1)) };
            office.db().save_check(&c).unwrap();
            c
        };
        let listing = finished(&ada, task("Ship the listing"), false);
        let live = set(&listing, "Did the listing go live?");
        let sweep = set(&finished(&bo, RunKind::Manual, false), "Did signups move?");
        let done = set(&finished(&cy, task("Fix the price"), true), "Did the price update?");
        let queued = |e: &Employee| office.db().active_runs_of(&e.id).unwrap();

        office.tick(t).unwrap();
        let turn = queued(&ada).remove(0);
        assert_eq!(turn.kind, RunKind::Reply { to_run_id: listing.id.clone(), label: "Ship the listing".into(), task: true, card: false });
        assert_eq!((turn.omega_wrote, turn.check_id()), (true, Some(live.id.as_str())));
        assert!(turn.prompt.contains(&format!("check id `{}`", live.id)), "{}", turn.prompt);
        assert_eq!(office.db().run(&turn.id).unwrap().unwrap().session, listing.id, "it resumes the conversation");
        assert_eq!(office.thread(&listing.id).unwrap().replies.iter().map(|r| r.id.clone()).collect::<Vec<_>>(), vec![turn.id.clone()]);
        assert_eq!(queued(&bo)[0].kind.check_id(), Some(sweep.id.as_str()), "set outside a conversation, it runs on its own");
        assert_eq!(queued(&cy)[0].kind.check_id(), Some(done.id.as_str()), "and so does one set in a conversation you marked done");

        // The turn is the claim on that due date, even once it ended without closing the check and the conversation is done.
        let mut over = office.db().run(&turn.id).unwrap().unwrap().run;
        over.state = RunState::Succeeded;
        over.ended_at = Some(t);
        office.db().save_run(&over).unwrap();
        office.set_archived(&listing.id, true).unwrap();
        office.tick(t).unwrap();
        assert!(queued(&ada).is_empty(), "{:?}", queued(&ada));

        // Set again from the turn, it is a new check, as from a check's own run.
        let again = office.check_later_tool(&turn.id, &ada, &json!({ "what": "Did the listing go live?", "how": "Open the store listing", "inDays": 1 })).unwrap();
        assert_ne!(again["check"]["id"], json!(live.id));
        assert_eq!(office.db().check(&live.id).unwrap().unwrap().due_at, live.due_at);

        drop(office);
        let _ = fs::remove_dir_all(&dir);
    }

    #[tokio::test]
    async fn a_schedule_kept_to_business_hours_skips_slots_outside_them() {
        use chrono::TimeZone;
        let ada = employee("ada");
        let (office, dir) = office_with(&ada).await;
        // 9 to 5, Monday to Friday, on this computer's clock. 8 November 2026 is a Sunday.
        let slot = |day: u32, hour: u32| Local.with_ymd_and_hms(2026, 11, day, hour, 0, 0).unwrap().with_timezone(&Utc);
        let tick = |day: u32, hour: u32| office.tick(slot(day, hour) + chrono::Duration::minutes(5)).unwrap();
        let runs = || office.db().recent_runs(Some(&ada.id), 10).unwrap();
        office.delete_schedule(&office.schedules(&ada.id).unwrap()[0].id).unwrap(); // the weekly review
        let s = Schedule { active_hours: true, ..routine(&ada.id, "0 * * * *") };
        office.db().save_schedule(&s, slot(7, 22)).unwrap();

        tick(8, 3);
        assert!(runs().is_empty(), "nothing at 3 am on a Sunday");
        assert_eq!(office.db().schedule(&s.id).unwrap().unwrap().1, slot(8, 3), "the slot is spent, not kept for later");
        tick(9, 8);
        assert!(runs().is_empty(), "nor at 8 am on Monday");
        tick(9, 10);
        let got = runs();
        assert_eq!(got.len(), 1, "10 am on Monday runs");
        assert!(matches!(&got[0].kind, RunKind::Scheduled { slot: at, .. } if *at == slot(9, 10)));

        office.db().save_schedule(&Schedule { id: "s2".into(), active_hours: false, ..s.clone() }, slot(9, 22)).unwrap();
        tick(9, 23);
        assert_eq!(runs().len(), 2, "only the routine kept to business hours skips 11 pm");

        drop(office);
        let _ = fs::remove_dir_all(&dir);
    }

    #[tokio::test]
    async fn a_tick_brings_back_a_card_whose_day_has_come_even_while_paused() {
        let ada = employee("ada");
        let (office, dir) = office_with(&ada).await;
        office.set_paused(true).unwrap();
        let until = now() + chrono::Duration::hours(3);
        let mut r = Run::new(&ada.id, RunKind::Manual, "go".into(), now());
        r.state = RunState::Succeeded;
        r.ended_at = Some(now());
        r.archived_at = Some(now());
        let mut card = Card::new("Book the hall?", None, Some("ask:hall".into()), CardAsk::Choices { choices: vec!["Book it".into()], recommended: 0 });
        card.answer = Some(CardAnswer { at: now(), how: AnswerHow::Dismissed, text: "Not now.".into(), held: false });
        card.back_at = Some(until);
        r.cards = vec![card];
        office.db().insert_run(&r, &r.id).unwrap();
        let stored = || office.db().run(&r.id).unwrap().unwrap().run;
        office.tick(now()).unwrap();
        assert!(stored().cards[0].answer.is_some(), "not before its day");
        office.tick(until).unwrap();
        let back = stored();
        assert!(back.cards[0].is_open() && back.archived_at.is_none(), "open again");
        assert_eq!(office.db().recent_runs(Some(&ada.id), 10).unwrap().len(), 1, "with no run");
        drop(office);
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn the_next_run_of_a_routine_kept_to_business_hours_is_inside_them() {
        let hours = BusinessHours::default();
        let friday_evening: Ts = "2026-11-06T18:10:00Z".parse().unwrap();
        let s = Schedule { active_hours: true, ..routine("ada", "*/30 * * * *") };
        assert_eq!(next_slot(&s, &hours, friday_evening, &Utc), Some("2026-11-09T09:00:00Z".parse().unwrap()), "Monday at 9");
        let any_time = Schedule { active_hours: false, ..s.clone() };
        assert_eq!(next_slot(&any_time, &hours, friday_evening, &Utc), Some("2026-11-06T18:30:00Z".parse().unwrap()));
        let nightly = Schedule { cron: "0 3 * * *".into(), ..s.clone() };
        assert_eq!(next_slot(&nightly, &hours, friday_evening, &Utc), None, "it never runs");
        let monthly = Schedule { cron: "0 10 1 * *".into(), ..s.clone() };
        assert_eq!(next_slot(&monthly, &hours, friday_evening, &Utc), Some("2026-12-01T10:00:00Z".parse().unwrap()), "a Tuesday");
        let every_minute = Schedule { cron: "* * * * *".into(), ..s.clone() };
        assert_eq!(next_slot(&every_minute, &hours, friday_evening, &Utc), Some("2026-11-09T09:00:00Z".parse().unwrap()));
        let yearly = Schedule { cron: "0 3 1 1 *".into(), active_hours: false, ..s.clone() };
        assert_eq!(next_slot(&yearly, &hours, friday_evening, &Utc), Some("2027-01-01T03:00:00Z".parse().unwrap()), "any time, however far");
    }

    #[test]
    fn a_routine_more_often_than_hourly_is_told_about_haiku() {
        let friday_evening: Ts = "2026-11-06T18:10:00Z".parse().unwrap();
        for (cron, frequent) in [("*/30 * * * *", true), ("*/30 9-17 * * 1-5", true), ("0 * * * *", false), ("0 9,10 * * *", false), ("0 9 * * 1-5", false), ("now and then", false)] {
            assert_eq!(more_than_hourly(cron, friday_evening, &Utc), frequent, "{cron}");
        }
        let on = |cron: &str, model: Option<&str>| light_model_tip(&Schedule { model: model.map(String::from), ..routine("ada", cron) });
        assert_eq!(on("*/15 * * * *", None), Some(LIGHT_MODEL_TIP));
        assert_eq!(on("*/15 * * * *", Some("sonnet")), Some(LIGHT_MODEL_TIP));
        assert_eq!(on("*/15 * * * *", Some("haiku")), None);
        assert_eq!(on("*/15 * * * *", Some("claude-haiku-5-5")), None);
        assert_eq!(on("0 9 * * 1-5", None), None);
        assert!(!LIGHT_MODEL_TIP.contains('\u{2014}'));
    }
}
