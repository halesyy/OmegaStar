//! Threads and Inbox rows, replies, archiving and approving blocked tools.

use super::*;
use crate::cards;
use crate::threads::View;

/// How many rows the Archive shows, and how many of each kind of run it reads for them, newest first.
const ARCHIVE_ROWS: u32 = 200;

/// Who wrote a reply: you, or Omega Star from something you did in the app (an approval, or your answer
/// on a card).
#[derive(Clone, Copy, PartialEq)]
pub(super) enum ReplyBy {
    Ceo,
    App,
    Card,
}

impl Office {
    /// Colleague asks still in flight, for Activity's "Between colleagues" list.
    pub fn open_asks(&self) -> Result<Vec<Run>> {
        self.db().open_asks()
    }

    /// Weekly reviews from the last eight days, for Activity's "This week's numbers".
    pub fn week_reviews(&self) -> Result<Vec<Run>> {
        self.db().review_runs(now() - chrono::Duration::days(8))
    }

    /// The Archive: every row that reached you and needs nothing from you now, the rows you archived, and the
    /// conversations you started and marked done, newest first (`threads::archive_at`).
    pub fn archived(&self) -> Result<Vec<Thread>> {
        Self::rows(&self.db(), View::Archive)
    }

    /// The employees who report to you.
    pub(super) fn top_ids(employees: &[Employee]) -> HashSet<String> {
        employees.iter().filter(|e| e.manager_id.is_none()).map(|e| e.id.clone()).collect()
    }

    /// The run of failures in a row a scheduled run that broke belongs to: its schedule and the last
    /// success before it. None for anything else. `cache` keeps each schedule's successes.
    fn streak_of(db: &Store, cache: &std::cell::RefCell<HashMap<String, Vec<Ts>>>, r: &Run) -> Option<String> {
        let RunKind::Scheduled { schedule_id, .. } = &r.kind else { return None };
        if !threads::broke(r) {
            return None;
        }
        let mut cache = cache.borrow_mut();
        let ok = cache.entry(schedule_id.clone()).or_insert_with(|| db.successes_of_schedule(schedule_id).unwrap_or_default());
        let since = ok.iter().rev().find(|t| **t < r.created_at).map(|t| t.timestamp_millis()).unwrap_or(0);
        Some(format!("{schedule_id}@{since}"))
    }

    /// The Inbox or the Archive (`view`) as rows (`threads::file`): one row per piece of work, most recently
    /// active (or archived) first. A row is a thread (a report and your exchange on it) with the threads that
    /// belong with it in `related`: everything a hand-off between employees set off, a schedule's earlier
    /// failures in a row, or the team's other reviews that week. The Inbox reads only runs that might need
    /// you; the Archive reads the newest of everything that reached you, and adds the conversations you
    /// started and marked done, each a line of its own.
    pub(super) fn rows(db: &Store, view: View) -> Result<Vec<Thread>> {
        let employees = db.employees()?;
        let top = Self::top_ids(&employees);
        let all: Vec<String> = employees.into_iter().map(|e| e.id).collect();
        let roots: Vec<String> = top.iter().cloned().collect();
        // The Archive reads the runs that might need you too, so a row that needs you is whole and stays out of it.
        let mut starts = db.finished_root_runs(&roots, &all)?;
        if view == View::Archive {
            starts.extend(db.reached_root_runs(&roots, &all, ARCHIVE_ROWS)?);
        }
        // A review brings the team's other reviews that week, as `row_of` does, so a week that needs you is one
        // whole row in the Inbox and none of it is left in the Archive. Only current employees': a review by
        // someone you let go would lead a row nobody can show.
        let weeks: HashSet<String> = starts.iter().filter_map(threads::review_week).collect();
        if let Some(first) = starts.iter().filter(|r| threads::review_week(r).is_some()).map(|r| r.created_at).min() {
            let have: HashSet<String> = starts.iter().map(|r| r.id.clone()).collect();
            let same = |r: &Run| !have.contains(&r.id) && all.contains(&r.employee_id) && threads::review_week(r).is_some_and(|w| weeks.contains(&w));
            starts.extend(db.review_runs(first - chrono::Duration::days(8))?.into_iter().filter(same));
        }
        starts.retain(|r| threads::reaches_you(r, false, top.contains(&r.employee_id)));
        if view == View::Archive {
            let mut archived = db.archived_root_runs(&all, ARCHIVE_ROWS)?;
            archived.retain(|r| threads::reaches_you(r, false, true));
            starts.extend(archived);
        }
        let rows = threads::file(&starts, db.conversation_runs()?, |id| run_of(db, id), &top);
        let cache = std::cell::RefCell::new(HashMap::new());
        let rows = threads::merge_rows(rows, |row| Self::row_key(db, &cache, row));
        let mut out: Vec<Thread> = rows.into_iter().filter_map(|r| threads::present(r, view)).collect();
        if view == View::Archive {
            // A conversation you started is never filed into a row: once done, it is a line of its own.
            let mut replies = threads::group(db.reply_runs(None)?);
            out.extend(db.archived_tasks(ARCHIVE_ROWS)?.into_iter().map(|root| {
                let turns = replies.remove(&root.id).unwrap_or_default();
                Thread::new(root, turns)
            }));
            out.sort_by_key(|t| std::cmp::Reverse(threads::archive_at(t)));
            out.truncate(ARCHIVE_ROWS as usize);
        } else {
            out.sort_by_key(|t| std::cmp::Reverse(threads::activity_at(&t.root, &t.replies)));
        }
        Ok(out)
    }

    /// What a row belongs to, so rows with the same key become one: a chore waiting on you first, then a
    /// week's reviews, then a schedule's run of failures.
    fn row_key(db: &Store, cache: &std::cell::RefCell<HashMap<String, Vec<Ts>>>, row: &threads::Row) -> Option<String> {
        let lead = row.members.first().map(|(t, _)| &t.root);
        threads::chore_key(row)
            .or_else(|| lead.and_then(threads::review_week))
            .or_else(|| lead.and_then(|r| Self::streak_of(db, cache, r)))
    }

    /// Every thread in the row `root` (a thread's root) is filed under, oldest first: its hand-off, for a
    /// schedule's failure the rest of that run of failures, and for a weekly review the team's other
    /// reviews that week.
    fn row_of(db: &Store, root: &Run) -> Result<Vec<Thread>> {
        let employees = db.employees()?;
        let top = Self::top_ids(&employees);
        let current: HashSet<&str> = employees.iter().map(|e| e.id.as_str()).collect();
        let conversation = db.conversation_runs()?;
        let lookup = |id: &str| run_of(db, id);
        let cache = std::cell::RefCell::new(HashMap::new());
        let mut starts = vec![root.clone()];
        let first = threads::file(&starts, conversation.clone(), lookup, &top).into_iter().next().and_then(|r| r.members.into_iter().next());
        if let Some((t, _)) = first {
            if let Some(week) = threads::review_week(&t.root) {
                let same = |r: &Run| r.id != t.root.id && current.contains(r.employee_id.as_str()) && threads::review_week(r).as_ref() == Some(&week);
                starts.extend(db.review_runs(t.root.created_at - chrono::Duration::days(8))?.into_iter().filter(same));
            } else if let (Some(key), RunKind::Scheduled { schedule_id, .. }) = (Self::streak_of(db, &cache, &t.root), &t.root.kind) {
                let same = |f: &Run| f.id != t.root.id && Self::streak_of(db, &cache, f).as_ref() == Some(&key);
                starts.extend(db.failures_of_schedule(schedule_id)?.into_iter().filter(same));
            }
        }
        // Keyed as the Inbox keys them, so a review held in a chore's row neither joins the week nor brings it along.
        let rows = threads::merge_rows(threads::file(&starts, conversation, lookup, &top), |row| Self::row_key(db, &cache, row));
        let at = rows.iter().position(|r| r.members.iter().any(|(t, _)| t.root.id == root.id)).unwrap_or(0);
        Ok(rows.into_iter().nth(at).map(|r| r.members.into_iter().map(|(t, _)| t).collect()).unwrap_or_default())
    }

    /// The thread a run belongs to: the report or conversation you started (root) and every later turn, oldest first.
    pub(super) fn thread_in(db: &Store, run_id: &str) -> Result<Thread> {
        let run = db.run(run_id)?.ok_or_else(|| AppError::not_found("run not found"))?.run;
        let root = match run.reply_to() {
            Some(id) => db.run(id)?.map(|r| r.run).ok_or_else(|| AppError::not_found("the report this reply answers is gone"))?,
            None => run,
        };
        let replies = threads::group(db.reply_runs(Some(&root.employee_id))?).remove(&root.id).unwrap_or_default();
        Ok(Thread::new(root, replies))
    }

    pub fn thread(&self, run_id: &str) -> Result<Thread> {
        Self::thread_in(&self.db(), run_id)
    }

    /// A reply that lands on an archived thread brings it back to the Inbox only when it needs you:
    /// "Send & archive" meant you did not want the answer back, unless the answer raises something.
    pub(super) fn surface_thread(&self, reply: &Run) -> Result<()> {
        if reply.reply_to().is_none() {
            return Ok(());
        }
        let flagged = !reply.needs_you.is_empty() || !reply.denials.is_empty() || matches!(reply.state, RunState::Failed | RunState::Lost);
        if !flagged {
            return Ok(());
        }
        let root = {
            let db = self.db();
            let Some(root_id) = reply.reply_to() else { return Ok(()) };
            let Some(mut root) = db.run(root_id)?.map(|r| r.run) else { return Ok(()) };
            if root.archived_at.is_none() {
                return Ok(());
            }
            root.archived_at = None;
            db.save_run(&root)?;
            root
        };
        self.sink().run_updated(&root);
        Ok(())
    }

    /// Archives a report with its thread and the rest of its Inbox row (they leave the Inbox and the
    /// employee's chips), or moves them all back. Archiving leaves alone any other conversation you are in
    /// in the row (`threads::talking`), cards and all. `run_id` may be any run in the row.
    pub fn set_archived(&self, run_id: &str, archived: bool) -> Result<Run> {
        self.archive_row(run_id, archived, false)
    }

    /// `set_archived`, but when `spare_own` and `run_id`'s thread is a conversation you are in (`yours`), it is left
    /// going and only the rest of its row is archived: what a typed reply leaves alone, a tap there does too.
    fn archive_row(&self, run_id: &str, archived: bool, spare_own: bool) -> Result<Run> {
        let (root, changed) = {
            let db = self.db();
            let t = Self::thread_in(&db, run_id)?;
            if !t.root.state.is_finished() {
                return Err(AppError::conflict("it is still working, so it cannot be archived yet"));
            }
            let own = archived && !(spare_own && yours(&t));
            // Done ends only this conversation: another one you are in goes on in its own chip, so neither it
            // nor a card in it is Done's to settle. `t` holds every turn, answers that came back into it too.
            let row: Vec<Thread> = Self::row_of(&db, &t.root)?.into_iter().filter(|m| !archived || (m.root.id != t.root.id && !threads::talking(m))).collect();
            if archived && ((own && threads::open_card(&t).is_some()) || threads::card_open(&row)) {
                return Err(AppError::conflict("Answer the card first, or dismiss it."));
            }
            let mut changed = vec![];
            for m in row.into_iter().chain(own.then(|| t.clone())) {
                // A run still going joins the row when it finishes, and shows only if it needs you.
                let mut root = m.root;
                if !root.state.is_finished() || root.archived_at.is_some() == archived {
                    continue;
                }
                root.archived_at = archived.then(now);
                db.save_run(&root)?;
                changed.push(root);
            }
            let root = db.run(&t.root.id)?.map(|r| r.run).unwrap_or(t.root);
            (root, changed)
        };
        for r in &changed {
            self.sink().run_updated(r);
        }
        Ok(root)
    }

    /// Your reply in a report's thread. It goes into the thread's run while that works, or else starts a
    /// run that resumes the thread's session, so the employee answers with everything it saw. The reply
    /// joins the thread and the report stays in the Inbox, unless `archive`: "send, and bring the answer
    /// back only if it needs me".
    /// A reply you type answers the thread's open cards too, once it has gone, so their buttons go and the row
    /// can be archived.
    pub fn reply_to_run(&self, run_id: &str, text: &str, archive: bool, attachments: Vec<NewAttachment>) -> Result<Run> {
        let reply = self.reply_with(run_id, text, archive, vec![], attachments, ReplyBy::Ceo)?;
        let typed = {
            let db = self.db();
            db.tx(|| answer_typed(&db, run_id, text, now()))?
        };
        for r in &typed {
            self.sink().run_updated(r);
        }
        Ok(reply)
    }

    /// Your answer on card `index` of a run. It goes to the run as a fixed message through `reply_with` and
    /// archives its row. Everyone waiting on the same thing (a chore, or a decision with the same key) hears
    /// the same answer, and those still working hear it straight away. Returns the reply runs it started.
    pub fn answer_card(&self, run_id: &str, index: usize, reply: CardReply) -> Result<Vec<Run>> {
        let at = now();
        let (card, answer, targets) = {
            let db = self.db();
            let run = db.run(run_id)?.ok_or_else(|| AppError::not_found("run not found"))?.run;
            let card = run.cards.get(index).cloned().ok_or_else(|| AppError::invalid("That run has no such card."))?;
            if !card.is_open() {
                return Err(AppError::conflict("That card was already answered."));
            }
            if !run.state.is_finished() {
                return Err(AppError::conflict("It is still working, so answer the card when it finishes."));
            }
            let text = cards::answer_text(&card.ask, &reply, &ceo_of(&db)?)?;
            let how = if reply == CardReply::Dismiss { AnswerHow::Dismissed } else { AnswerHow::Tapped };
            let answer = CardAnswer { at, how, text: text.unwrap_or_default() };
            let mut targets = vec![run];
            if let Some(topic) = card.topic() {
                targets.extend(db.open_topic_runs(&topic)?.into_iter().filter(|r| r.id != run_id));
            }
            db.tx(|| answer_cards(&db, &mut targets, Some(index), card.topic().as_deref(), &answer))?;
            (card, answer, targets)
        };
        let text = Some(answer.text.as_str()).filter(|t| !t.is_empty());
        let mut replies = self.send_card_answers(&targets, &card, text);
        if let Some(topic) = card.topic() {
            // Runs still working on the same thing hear it now, in the turn they are in. Told and marked under one
            // lock, so a run ending meanwhile either keeps the answer or is found by the read below.
            for a in lock(&self.0.active).values_mut() {
                let Some(i) = a.cards.iter().position(|c| c.is_open() && c.topic().as_deref() == Some(topic.as_str())) else { continue };
                let told = match text {
                    Some(t) => a.input.as_ref().is_some_and(|input| input.send(claude::user_line(&card_reply_text(&a.cards[i], t))).is_ok()),
                    None => true,
                };
                if told {
                    a.cards[i].answer = Some(answer.clone());
                    // Answered, so it no longer needs you for it: the run ends unflagged unless something else does.
                    let message = a.cards[i].message.clone();
                    a.needs_you.retain(|m| *m != message);
                }
            }
            // A run that finished while the answers above went out was in neither pass.
            let late = {
                let db = self.db();
                db.open_topic_runs(&topic).and_then(|mut late| db.tx(|| answer_cards(&db, &mut late, None, Some(&topic), &answer)).map(|_| late))
            };
            match late {
                Ok(late) => replies.extend(self.send_card_answers(&late, &card, text)),
                Err(e) => log!("answering the runs that finished waiting on {topic} failed: {e}"),
            }
        }
        Ok(replies)
    }

    /// Sends your answer `text` on `card` to each run and archives its row (but not a conversation you are in),
    /// carrying on past a run that fails.
    /// Each run hears it under its own card about the same thing. A run back in the queue after the usage
    /// limit only keeps its answered card: its retry carries on anyway. Returns the reply runs it started.
    fn send_card_answers(&self, targets: &[Run], card: &Card, text: Option<&str>) -> Vec<Run> {
        let mut replies = vec![];
        for t in targets {
            self.sink().run_updated(t);
            if t.state == RunState::Queued {
                continue;
            }
            if let Some(text) = text {
                let own = card.topic().and_then(|k| t.cards.iter().find(|c| c.topic().as_deref() == Some(k.as_str()))).unwrap_or(card);
                match self.reply_with(&t.id, &card_reply_text(own, text), false, vec![], vec![], ReplyBy::Card) {
                    Ok(r) => replies.push(r),
                    Err(e) => {
                        log!("sending your answer on the card of run {} failed: {e}", t.id);
                        continue;
                    }
                }
            }
            // A tap in a conversation you are in answers the card, and the conversation goes on.
            match self.archive_row(&t.id, true, true) {
                Err(e) if e.code != crate::error::ErrorCode::Conflict => log!("archiving run {} after its card failed: {e}", t.id),
                _ => {}
            }
        }
        replies
    }

    /// A blocked run's way forward: you allow what it was denied, and it resumes to retry. `always`
    /// saves the rules to the employee; otherwise they apply to the retry run only. The rules must
    /// come from what the run was denied: its own suggested rule, or every tool of the same MCP server.
    pub fn approve_blocked(&self, run_id: &str, rules: Vec<String>, always: bool) -> Result<Run> {
        let (original, employee, ceo, mine) = {
            let db = self.db();
            let original = db.run(run_id)?.ok_or_else(|| AppError::not_found("run not found"))?.run;
            let mine = yours(&Self::thread_in(&db, run_id)?);
            if original.denials.is_empty() {
                return Err(AppError::conflict("nothing was blocked in that run"));
            }
            if !original.state.is_finished() {
                return Err(AppError::conflict("that run is still working"));
            }
            let employee = db.employee(&original.employee_id)?.ok_or_else(|| AppError::not_found("that employee no longer works here"))?;
            let ceo = ceo_of(&db)?;
            (original, employee, ceo, mine)
        };
        let mut rules: Vec<String> = rules.into_iter().map(|r| r.trim().to_string()).filter(|r| !r.is_empty()).collect();
        rules.dedup();
        if rules.is_empty() {
            return Err(AppError::invalid("choose what to allow"));
        }
        for r in &rules {
            let asked_for = original.denials.iter().any(|d| d.suggested_rule == *r || claude::mcp_server_rule(&d.tool).as_deref() == Some(r.as_str()));
            if !asked_for {
                return Err(AppError::invalid(format!("'{r}' is not something this run was blocked on")));
            }
        }
        if always {
            for r in &rules {
                self.allow_rule(&employee.id, r)?;
            }
        }
        let blocked = original.denials.iter().map(|d| format!("- {}: {}", d.tool, d.brief)).collect::<Vec<_>>().join("\n");
        let scope = if always { "from now on" } else { "for this retry" };
        let text = format!(
            "{ceo} approved what was blocked:\n{blocked}\n\nYou may now use {} {scope}. Retry it and finish the task. \
Approval covers only what is listed, so if something else is blocked, stop and say what.",
            rules.join(", ")
        );
        // Decided, so it leaves the Inbox: the retry comes back only if it needs you again. A conversation you are
        // in goes on instead.
        let reply = self.reply_with(run_id, &text, !mine, rules, vec![], ReplyBy::App)?;
        Ok(reply)
    }

    /// A thread's newest turn as stored, and whether the next turn resumes its session: yes while that turn is
    /// still to come (it has the session, even before it starts) or once its session started. No when it never
    /// started (it failed first), so there is nothing to resume and the next turn starts a fresh one.
    pub(super) fn next_turn(db: &Store, t: &Thread) -> Result<(RunRecord, bool)> {
        let latest = t.replies.last().unwrap_or(&t.root);
        let rec = db.run(&latest.id)?.ok_or_else(|| AppError::not_found("run not found"))?;
        let resumes = !rec.run.state.is_finished() || db.session_started(&rec.session)?;
        Ok((rec, resumes))
    }

    /// `run_id` may be any run in the thread. The reply answers the thread's root and resumes the
    /// thread's newest session (the root's, or a fresh one an earlier reply had to start). A plain reply
    /// goes into that session's run while it works; one that carries files or rules, or that Omega Star
    /// wrote (`by`), is a run of its own.
    fn reply_with(&self, run_id: &str, text: &str, archive: bool, allow_once: Vec<String>, attachments: Vec<NewAttachment>, by: ReplyBy) -> Result<Run> {
        let text = text.trim();
        if text.is_empty() && attachments.is_empty() {
            return Err(AppError::invalid("reply is empty"));
        }
        let files = Self::decode_attachments(&attachments)?;
        let plain = files.is_empty() && allow_once.is_empty() && by == ReplyBy::Ceo;
        let (root, mut reply, session) = {
            let db = self.db();
            let t = Self::thread_in(&db, run_id)?;
            let mut root = t.root.clone();
            let e = db.employee(&root.employee_id)?.ok_or_else(|| AppError::not_found("that employee no longer works here"))?;
            let latest = t.replies.last().cloned().unwrap_or_else(|| root.clone());
            if plain && latest.state == RunState::Running && self.steer(&latest.id, text) {
                root.replied_at = Some(now());
                root.archived_at = archive.then(now);
                db.save_run(&root)?;
                drop(db);
                self.sink().run_updated(&root);
                return Ok(latest);
            }
            let (rec, resumes) = Self::next_turn(&db, &t)?;
            // An older build's chat message that an answer came back into is a conversation you started too.
            let chat = matches!(root.kind, RunKind::Chat);
            let label = if chat { threads::task_label(&root.prompt, &root.attachments) } else { threads::report_label(&root.kind) };
            let task = chat || matches!(root.kind, RunKind::Task { .. });
            let (prompt, session) = if resumes {
                (text.to_string(), rec.session)
            } else {
                let report = rec.run.summary.clone().or_else(|| rec.run.error.clone()).unwrap_or_else(|| "(no report)".into());
                let ceo = db.company()?.map(|c| c.ceo_name).unwrap_or_else(|| "Your manager".into());
                let before = if task {
                    format!("{ceo} started this conversation ({label}):\n\n{}\n\nWhat came of it:\n\n{report}", root.prompt)
                } else {
                    format!("Your report ({label}):\n\n{report}")
                };
                (format!("{before}\n\n{ceo}'s reply:\n\n{text}"), String::new())
            };
            let card = by == ReplyBy::Card;
            let mut reply = Run::new(&e.id, RunKind::Reply { to_run_id: root.id.clone(), label, task, card }, prompt, now());
            reply.allow_once = allow_once;
            // The never-started wrapper quotes your reply in full, so it still counts as your words.
            reply.omega_wrote = by != ReplyBy::Ceo;
            let session = if session.is_empty() { reply.id.clone() } else { session };
            root.replied_at = Some(now());
            root.archived_at = archive.then(now);
            db.save_run(&root)?;
            (root, reply, session)
        };
        self.attach(&mut reply, &files)?;
        self.sink().run_updated(&root);
        self.enqueue(reply, session)
    }
}

/// A conversation you are in: one you started (an older build's chat message an answer came back into too), or a
/// report you typed into (`threads::talking`).
fn yours(t: &Thread) -> bool {
    matches!(t.root.kind, RunKind::Task { .. } | RunKind::Chat) || threads::talking(t)
}

/// Marks every open card on a finished run of `run_id`'s thread answered by your typed reply (`text`,
/// clipped), and returns those runs, saved. Call inside a transaction.
fn answer_typed(db: &Store, run_id: &str, text: &str, at: Ts) -> Result<Vec<Run>> {
    let t = Office::thread_in(db, run_id)?;
    let mut out = vec![];
    for mut r in std::iter::once(t.root).chain(t.replies) {
        if !r.state.is_finished() || !r.has_open_card() {
            continue;
        }
        for c in r.cards.iter_mut().filter(|c| c.is_open()) {
            c.answer = Some(CardAnswer { at, how: AnswerHow::Typed, text: claude::clip(text, 300) });
        }
        db.save_run(&r)?;
        out.push(r);
    }
    Ok(out)
}

/// Puts `answer` on card `index` of the first run, and on every open card about `topic` in all of them, and
/// saves them. Call inside a transaction.
fn answer_cards(db: &Store, runs: &mut [Run], index: Option<usize>, topic: Option<&str>, answer: &CardAnswer) -> Result<()> {
    for (n, r) in runs.iter_mut().enumerate() {
        for (i, c) in r.cards.iter_mut().enumerate() {
            let same = topic.is_some() && c.is_open() && c.topic().as_deref() == topic;
            if same || (n == 0 && Some(i) == index) {
                c.answer = Some(answer.clone());
            }
        }
        db.save_run(r)?;
    }
    Ok(())
}

/// What your answer on `card` says to the run that raised it: a chore's answer as it is, a decision's
/// under the question it answers.
fn card_reply_text(card: &Card, text: &str) -> String {
    match card.ask {
        CardAsk::Chore { .. } => text.to_string(),
        _ => format!("Your card: \"{}\"\n{text}", claude::clip(&card.message, 300)),
    }
}

/// A run by id while walking threads. A store error is logged and the run treated as missing, since
/// the thread walkers take a plain lookup.
pub(super) fn run_of(db: &Store, id: &str) -> Option<Run> {
    match db.run(id) {
        Ok(r) => r.map(|r| r.run),
        Err(e) => {
            log!("reading run {id}: {e}");
            None
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    struct NoSink;
    impl EventSink for NoSink {
        fn org_changed(&self) {}
        fn run_updated(&self, _run: &Run) {}
        fn run_events(&self, _run_id: &str, _events: &[RunEvent]) {}
        fn request_updated(&self, _request: &HumanRequest) {}
    }

    fn tester() -> Employee {
        Employee {
            id: uuid::Uuid::new_v4().to_string(),
            slug: "cy".into(),
            name: "Cy".into(),
            title: "Tester".into(),
            description: String::new(),
            objective: String::new(),
            manager_id: None,
            skills: SkillGrant { builtins: false, keys: vec![] },
            clearance: Clearance::Supervised,
            allow_rules: vec![],
            model: None,
            effort: None,
            browser: false,
            auto_tidy: false,
            workspaces: vec![],
            hue: 0,
            chat_session: "chat-cy".into(),
            hired_at: now(),
        }
    }

    /// A finished report of `e` asking a decision with a card.
    fn carded(e: &Employee) -> Run {
        let mut r = Run::new(&e.id, RunKind::Manual, "go".into(), now());
        r.state = RunState::Succeeded;
        r.ended_at = Some(now());
        r.needs_you = vec!["Boost the post?".into()];
        r.cards = vec![Card::new("Boost the post?", None, Some("ask:boost".into()), CardAsk::Choices { choices: vec!["Not now".into(), "Go".into()], recommended: 0 })];
        r
    }

    #[test]
    fn a_reply_you_type_answers_the_threads_open_cards() {
        let dir = std::env::temp_dir().join(format!("omegastar-typed-{}", uuid::Uuid::new_v4()));
        fs::create_dir_all(&dir).unwrap();
        let db = Store::open(&dir.join("office.db")).unwrap();
        let e = tester();
        db.save_employee(&e).unwrap();
        let report = carded(&e);
        assert!(db.insert_run(&report, &report.id).unwrap());
        let mut working = carded(&e);
        working.kind = RunKind::Reply { to_run_id: report.id.clone(), label: "Manual run".into(), task: false, card: false };
        working.state = RunState::Running;
        assert!(db.insert_run(&working, &report.id).unwrap());

        let long = format!("Not now. {}", "x".repeat(400));
        let typed = db.tx(|| answer_typed(&db, &working.id, &long, now())).unwrap();
        assert_eq!(typed.iter().map(|r| r.id.as_str()).collect::<Vec<_>>(), vec![report.id.as_str()]);
        let answer = db.run(&report.id).unwrap().unwrap().run.cards.remove(0).answer.unwrap();
        assert_eq!(answer.how, AnswerHow::Typed);
        assert_eq!(answer.text, claude::clip(&long, 300));
        assert!(db.run(&working.id).unwrap().unwrap().run.has_open_card(), "a run still working keeps its card");
        assert!(db.tx(|| answer_typed(&db, &report.id, "Again.", now())).unwrap().is_empty());
        drop(db);
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn a_weeks_reviews_share_one_row() {
        let dir = std::env::temp_dir().join(format!("omegastar-team-week-{}", uuid::Uuid::new_v4()));
        fs::create_dir_all(&dir).unwrap();
        let db = Store::open(&dir.join("office.db")).unwrap();
        let hire = |slug: &str, manager: Option<&Employee>| {
            let e = Employee { slug: slug.into(), name: slug.into(), chat_session: format!("chat-{slug}"), manager_id: manager.map(|m| m.id.clone()), ..tester() };
            db.save_employee(&e).unwrap();
            e
        };
        let ada = hire("ada", None);
        let bo = hire("bo", Some(&ada));
        let cy = hire("cy", None);
        // Wednesdays at noon UTC, in ISO weeks 41 and 42 in every time zone.
        let (this_week, next_week) = ("2026-10-07T12:00:00Z".parse::<Ts>().unwrap(), "2026-10-14T12:00:00Z".parse::<Ts>().unwrap());
        let review = |e: &Employee, slot: Ts, state: RunState| {
            let kind = RunKind::Scheduled { schedule_id: format!("review-{}", e.slug), slot, label: "Weekly review".into(), quiet: false, model: None, effort: None, review: true };
            let mut r = Run::new(&e.id, kind, "Review your week.".into(), slot);
            r.state = state;
            r.ended_at = Some(slot);
            r.summary = Some("Signups 40, up 5.".into());
            assert!(db.insert_run(&r, &r.id).unwrap());
            r
        };
        let a = review(&ada, this_week, RunState::Succeeded);
        let b = review(&bo, this_week, RunState::Succeeded);
        let c = review(&cy, this_week, RunState::Failed);
        let later = review(&ada, next_week, RunState::Succeeded);
        // A review waiting on a chore sits in the chore's row, as the Inbox files it.
        let dee = hire("dee", None);
        let mut d = review(&dee, "2026-10-08T12:00:00Z".parse::<Ts>().unwrap(), RunState::Succeeded);
        d.needs_you = vec!["Open Chrome.".into()];
        d.cards = vec![Card::new("Open Chrome.", None, None, CardAsk::Chore { subject: "chrome".into() })];
        db.save_run(&d).unwrap();

        let ids = |t: &Thread| -> HashSet<String> { std::iter::once(t).chain(&t.related).map(|x| x.root.id.clone()).collect() };
        let week: HashSet<String> = [&a, &b, &c].iter().map(|r| r.id.clone()).collect();
        let rows = Office::rows(&db, View::Inbox).unwrap();
        assert_eq!(
            rows.iter().map(ids).collect::<Vec<_>>(),
            vec![HashSet::from([d.id.clone()])],
            "only the review waiting on a chore needs you: plain reviews are in the Archive, and one failure is not a streak"
        );
        assert!(!rows.iter().any(|t| ids(t).contains(&later.id)));
        let chored = Office::row_of(&db, &d).unwrap();
        assert_eq!(chored.iter().map(|t| t.root.id.clone()).collect::<Vec<_>>(), vec![d.id.clone()], "answering the chore leaves the week alone");

        let row = Office::row_of(&db, &b).unwrap();
        assert_eq!(row.iter().map(|t| t.root.id.clone()).collect::<HashSet<_>>(), week, "a second-level employee's review leads to the whole week");
        for t in row {
            let mut r = t.root;
            r.archived_at = Some(now());
            db.save_run(&r).unwrap();
        }
        let rows = Office::rows(&db, View::Inbox).unwrap();
        assert_eq!(rows.iter().map(ids).collect::<Vec<_>>(), vec![HashSet::from([d.id.clone()])]);
        let archived: Vec<HashSet<String>> = Office::rows(&db, View::Archive).unwrap().iter().map(ids).collect();
        assert_eq!(archived.len(), 2, "the week you archived, and next week's review, which needs nothing");
        assert!(archived.contains(&week) && archived.contains(&HashSet::from([later.id.clone()])));
        drop(db);
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn a_week_that_needs_you_is_one_inbox_row_with_every_review() {
        let dir = std::env::temp_dir().join(format!("omegastar-week-needs-{}", uuid::Uuid::new_v4()));
        fs::create_dir_all(&dir).unwrap();
        let db = Store::open(&dir.join("office.db")).unwrap();
        let slot = "2026-10-07T12:00:00Z".parse::<Ts>().unwrap();
        let review = |slug: &str, flag: bool| {
            let e = Employee { slug: slug.into(), name: slug.into(), chat_session: format!("chat-{slug}"), ..tester() };
            db.save_employee(&e).unwrap();
            let kind = RunKind::Scheduled { schedule_id: format!("review-{slug}"), slot, label: "Weekly review".into(), quiet: false, model: None, effort: None, review: true };
            let mut r = Run::new(&e.id, kind, "Review your week.".into(), slot);
            r.state = RunState::Succeeded;
            r.ended_at = Some(slot);
            r.summary = Some("Signups 40, up 5.".into());
            if flag {
                r.needs_you = vec!["Approve the budget.".into()];
            }
            assert!(db.insert_run(&r, &r.id).unwrap());
            r.id
        };
        let week: HashSet<String> = [review("ada", false), review("bo", true), review("cy", false)].into();
        let ids = |t: &Thread| -> HashSet<String> { std::iter::once(t).chain(&t.related).map(|x| x.root.id.clone()).collect() };
        let inbox: Vec<HashSet<String>> = Office::rows(&db, View::Inbox).unwrap().iter().map(ids).collect();
        assert_eq!(inbox, vec![week], "the reviews that need nothing come along with the one that does");
        assert!(Office::rows(&db, View::Archive).unwrap().is_empty(), "so none of them is lost between the two");
        drop(db);
        let _ = fs::remove_dir_all(&dir);
    }

    /// A week of plain reviews by `slugs`, reporting to you, at noon UTC on a Wednesday of one ISO week.
    fn plain_week(db: &Store, slugs: &[&str]) -> Vec<Run> {
        let slot = "2026-10-07T12:00:00Z".parse::<Ts>().unwrap();
        slugs
            .iter()
            .enumerate()
            .map(|(i, slug)| {
                let e = Employee { slug: (*slug).into(), name: (*slug).into(), chat_session: format!("chat-{slug}"), ..tester() };
                db.save_employee(&e).unwrap();
                let at = slot + chrono::Duration::hours(i as i64);
                let kind = RunKind::Scheduled { schedule_id: format!("review-{slug}"), slot: at, label: "Weekly review".into(), quiet: false, model: None, effort: None, review: true };
                let mut r = Run::new(&e.id, kind, "Review your week.".into(), at);
                r.state = RunState::Succeeded;
                r.ended_at = Some(at);
                r.summary = Some("Signups 40, up 5.".into());
                assert!(db.insert_run(&r, &r.id).unwrap());
                r
            })
            .collect()
    }

    /// Your reply on `report` and the employee's answer, a later turn of its thread. Returns the turn.
    fn talk_about(db: &Store, report: &Run) -> Run {
        let mut root = report.clone();
        let at = root.created_at + chrono::Duration::hours(4);
        root.replied_at = Some(at);
        db.save_run(&root).unwrap();
        let kind = RunKind::Reply { to_run_id: root.id.clone(), label: threads::report_label(&root.kind), task: false, card: false };
        let mut turn = Run::new(&root.employee_id, kind, "Why up?".into(), at);
        turn.state = RunState::Succeeded;
        turn.ended_at = Some(at);
        assert!(db.insert_run(&turn, &root.id).unwrap());
        turn
    }

    #[tokio::test]
    async fn done_on_one_review_conversation_leaves_another_in_the_same_week_going() {
        let dir = std::env::temp_dir().join(format!("omegastar-week-done-{}", uuid::Uuid::new_v4()));
        fs::create_dir_all(&dir).unwrap();
        let week = {
            let db = Store::open(&dir.join("office.db")).unwrap();
            db.set_held_until(Some(now() + chrono::Duration::hours(1))).unwrap();
            let week = plain_week(&db, &["ada", "bo", "cy"]);
            talk_about(&db, &week[0]);
            talk_about(&db, &week[1]);
            week
        };
        let office = Office::open(dir.clone(), Arc::new(NoSink), Build::new("0.0.0".into())).await.unwrap();
        office.set_archived(&week[0].id, true).unwrap();
        let archived = |r: &Run| office.db().run(&r.id).unwrap().unwrap().run.archived_at.is_some();
        assert!(archived(&week[0]), "Done ends the conversation you pressed it on");
        assert!(!archived(&week[1]), "another conversation on the week goes on");
        assert!(archived(&week[2]), "the rest of the week goes with it");
        drop(office);
        let _ = fs::remove_dir_all(&dir);
    }

    /// A card on `run` with no answer yet.
    fn with_card(mut run: Run, message: &str) -> Run {
        run.needs_you = vec![message.into()];
        run.cards = vec![Card::new(message, None, None, CardAsk::Choices { choices: vec!["Not now".into(), "Go".into()], recommended: 0 })];
        run
    }

    #[tokio::test]
    async fn answering_the_last_card_of_a_week_archives_a_review_whose_card_was_answered_first() {
        let dir = std::env::temp_dir().join(format!("omegastar-week-cards-{}", uuid::Uuid::new_v4()));
        fs::create_dir_all(&dir).unwrap();
        let week = {
            let db = Store::open(&dir.join("office.db")).unwrap();
            db.set_held_until(Some(now() + chrono::Duration::hours(1))).unwrap();
            let week = plain_week(&db, &["ada", "bo"]);
            for r in &week {
                db.save_run(&with_card(r.clone(), "Boost the post?")).unwrap();
            }
            week
        };
        let office = Office::open(dir.clone(), Arc::new(NoSink), Build::new("0.0.0".into())).await.unwrap();
        let archived = |r: &Run| office.db().run(&r.id).unwrap().unwrap().run.archived_at.is_some();
        assert_eq!(office.answer_card(&week[0].id, 0, CardReply::Choice { index: 1 }).unwrap().len(), 1);
        assert!(!archived(&week[0]), "the week still waits on the other card");
        office.answer_card(&week[1].id, 0, CardReply::Choice { index: 1 }).unwrap();
        assert!(archived(&week[0]) && archived(&week[1]), "the answer to a tap is no conversation of yours, so the whole week goes");
        drop(office);
        let _ = fs::remove_dir_all(&dir);
    }

    #[tokio::test]
    async fn a_card_in_another_conversation_of_the_row_does_not_hold_up_done() {
        let dir = std::env::temp_dir().join(format!("omegastar-week-other-card-{}", uuid::Uuid::new_v4()));
        fs::create_dir_all(&dir).unwrap();
        let week = {
            let db = Store::open(&dir.join("office.db")).unwrap();
            db.set_held_until(Some(now() + chrono::Duration::hours(1))).unwrap();
            let week = plain_week(&db, &["ada", "bo"]);
            talk_about(&db, &week[0]);
            let turn = talk_about(&db, &week[1]);
            db.save_run(&with_card(turn, "Boost the post?")).unwrap();
            week
        };
        let office = Office::open(dir.clone(), Arc::new(NoSink), Build::new("0.0.0".into())).await.unwrap();
        office.set_archived(&week[0].id, true).unwrap();
        let archived = |r: &Run| office.db().run(&r.id).unwrap().unwrap().run.archived_at.is_some();
        assert!(archived(&week[0]) && !archived(&week[1]), "the card waits in its own conversation");
        assert_eq!(office.set_archived(&week[1].id, true).unwrap_err().message, "Answer the card first, or dismiss it.");
        drop(office);
        let _ = fs::remove_dir_all(&dir);
    }

    #[tokio::test]
    async fn a_card_in_an_answer_that_came_back_into_a_conversation_holds_up_done() {
        let dir = std::env::temp_dir().join(format!("omegastar-answer-card-{}", uuid::Uuid::new_v4()));
        fs::create_dir_all(&dir).unwrap();
        let e = tester();
        let mut task = Run::new(&e.id, RunKind::Task { label: "Draft it".into(), from: None, context: String::new() }, "Draft it.".into(), now());
        task.state = RunState::Succeeded;
        task.ended_at = Some(now());
        let kind = RunKind::Answered { asked_run_id: "asked-1".into(), from: e.id.clone(), task: false, chat: false, thread: Some(task.id.clone()) };
        let mut answer = with_card(Run::new(&e.id, kind, "Bo answered your question.".into(), now()), "Send it to the printer?");
        answer.state = RunState::Succeeded;
        answer.ended_at = Some(now());
        answer.omega_wrote = true;
        let office = held_office(&dir, &e, &[&task, &answer]).await;
        assert_eq!(office.set_archived(&task.id, true).unwrap_err().message, "Answer the card first, or dismiss it.");
        assert!(office.db().run(&task.id).unwrap().unwrap().run.archived_at.is_none());
        drop(office);
        let _ = fs::remove_dir_all(&dir);
    }

    #[tokio::test]
    async fn a_tap_or_an_approval_in_a_conversation_you_started_keeps_it_going() {
        let dir = std::env::temp_dir().join(format!("omegastar-task-tap-{}", uuid::Uuid::new_v4()));
        fs::create_dir_all(&dir).unwrap();
        let e = tester();
        let start = |label: &str| {
            let mut r = Run::new(&e.id, RunKind::Task { label: label.into(), from: None, context: String::new() }, format!("{label}."), now());
            r.state = RunState::Succeeded;
            r.ended_at = Some(now());
            r
        };
        let carded = with_card(start("Check the supplier site"), "Order the spare parts?");
        let mut blocked = start("Publish the menu");
        blocked.denials = vec![Denial { tool: "Bash".into(), brief: "npm publish".into(), suggested_rule: "Bash(npm publish)".into() }];
        let office = held_office(&dir, &e, &[&carded, &blocked]).await;
        let archived = |r: &Run| office.db().run(&r.id).unwrap().unwrap().run.archived_at.is_some();
        assert_eq!(office.answer_card(&carded.id, 0, CardReply::Choice { index: 1 }).unwrap().len(), 1);
        assert!(!archived(&carded), "the answer goes on in the conversation, as a typed one does");
        office.approve_blocked(&blocked.id, vec!["Bash(npm publish)".into()], false).unwrap();
        assert!(!archived(&blocked), "the retry goes on in the conversation");
        drop(office);
        let _ = fs::remove_dir_all(&dir);
    }

    #[tokio::test]
    async fn a_reply_in_an_older_chat_message_is_a_turn_of_your_conversation() {
        let dir = std::env::temp_dir().join(format!("omegastar-old-chat-reply-{}", uuid::Uuid::new_v4()));
        fs::create_dir_all(&dir).unwrap();
        let e = tester();
        let mut message = Run::new(&e.id, RunKind::Chat, "Can you check the rota with Bo?".into(), now());
        message.state = RunState::Succeeded;
        message.ended_at = Some(now());
        let came = RunKind::Answered { asked_run_id: "asked-1".into(), from: e.id.clone(), task: false, chat: false, thread: Some(message.id.clone()) };
        let mut answer = Run::new(&e.id, came, "Bo answered your question.".into(), now());
        answer.state = RunState::Succeeded;
        answer.ended_at = Some(now());
        answer.omega_wrote = true;
        let office = held_office(&dir, &e, &[&message, &answer]).await;
        let reply = office.reply_to_run(&message.id, "Thanks, book it.", false, vec![]).unwrap();
        assert_eq!(reply.kind, RunKind::Reply { to_run_id: message.id.clone(), label: "Check the rota with Bo".into(), task: true, card: false });
        assert!(reply.prompt.starts_with("Your manager started this conversation (Check the rota with Bo)"), "{}", reply.prompt);
        drop(office);
        let _ = fs::remove_dir_all(&dir);
    }

    #[tokio::test]
    async fn a_tap_on_an_answer_in_an_older_chat_message_keeps_its_conversation_going() {
        let dir = std::env::temp_dir().join(format!("omegastar-old-chat-tap-{}", uuid::Uuid::new_v4()));
        fs::create_dir_all(&dir).unwrap();
        let e = tester();
        let mut message = Run::new(&e.id, RunKind::Chat, "Can you check the rota with Bo?".into(), now());
        message.state = RunState::Succeeded;
        message.ended_at = Some(now());
        let came = RunKind::Answered { asked_run_id: "asked-1".into(), from: e.id.clone(), task: false, chat: false, thread: Some(message.id.clone()) };
        let mut answer = with_card(Run::new(&e.id, came, "Bo answered your question.".into(), now()), "Swap the Friday shift?");
        answer.state = RunState::Succeeded;
        answer.ended_at = Some(now());
        answer.omega_wrote = true;
        let office = held_office(&dir, &e, &[&message, &answer]).await;
        assert_eq!(office.answer_card(&answer.id, 0, CardReply::Choice { index: 1 }).unwrap().len(), 1);
        assert!(office.db().run(&message.id).unwrap().unwrap().run.archived_at.is_none(), "the answer goes on in the conversation");
        assert!(office.conversations().unwrap().threads.iter().any(|t| t.root.id == message.id), "and it keeps its chip");
        drop(office);
        let _ = fs::remove_dir_all(&dir);
    }

    #[tokio::test]
    async fn turns_an_older_chat_left_waiting_move_to_the_work_lane() {
        let dir = std::env::temp_dir().join(format!("omegastar-old-chat-{}", uuid::Uuid::new_v4()));
        fs::create_dir_all(&dir).unwrap();
        let e = tester();
        let message = Run::new(&e.id, RunKind::Chat, "Can you draft the launch note?".into(), now());
        let came = RunKind::Answered { asked_run_id: "asked-1".into(), from: e.id.clone(), task: false, chat: true, thread: None };
        let answer = Run::new(&e.id, came, "Bo answered your question.".into(), now());
        let mut done = Run::new(&e.id, RunKind::Chat, "Hi.".into(), now());
        done.state = RunState::Succeeded;
        done.ended_at = Some(now());
        let office = held_office(&dir, &e, &[&message, &answer, &done]).await;
        let stored = |r: &Run| office.db().run(&r.id).unwrap().unwrap().run.kind;
        assert_eq!(stored(&message), RunKind::Task { label: "Draft the launch note".into(), from: None, context: String::new() }, "your message is a conversation");
        assert_eq!(stored(&answer), RunKind::Answered { asked_run_id: "asked-1".into(), from: e.id.clone(), task: false, chat: false, thread: None });
        assert_eq!(stored(&done), RunKind::Chat, "a finished turn stays as it was");
        let work: HashSet<String> = office.db().work_runs(&e.id, 10).unwrap().into_iter().map(|r| r.id).collect();
        assert_eq!(work, HashSet::from([message.id.clone(), answer.id.clone()]));
        drop(office);
        let _ = fs::remove_dir_all(&dir);
    }

    #[tokio::test]
    async fn an_older_chat_answer_comes_back_into_the_chat_message_that_asked() {
        let dir = std::env::temp_dir().join(format!("omegastar-old-chat-answer-{}", uuid::Uuid::new_v4()));
        fs::create_dir_all(&dir).unwrap();
        let ana = Employee { id: uuid::Uuid::new_v4().to_string(), slug: "ana".into(), name: "Ana".into(), chat_session: "chat-ana".into(), ..tester() };
        let bo = Employee { id: uuid::Uuid::new_v4().to_string(), slug: "bo".into(), name: "Bo".into(), chat_session: "chat-bo".into(), ..tester() };
        let cy = Employee { manager_id: Some(ana.id.clone()), ..tester() };
        let mut message = Run::new(&cy.id, RunKind::Chat, "Can you check the rota with Bo?".into(), now());
        message.state = RunState::Succeeded;
        message.ended_at = Some(now());
        let mut asked = Run::new(&bo.id, RunKind::Asked { parent_run_id: message.id.clone(), asked_by: cy.id.clone(), task: false }, "Is the rota final?".into(), now());
        asked.state = RunState::Succeeded;
        asked.ended_at = Some(now());
        let came = RunKind::Answered { asked_run_id: asked.id.clone(), from: bo.id.clone(), task: false, chat: true, thread: None };
        let answer = Run::new(&cy.id, came, "Bo answered your question.".into(), now());
        {
            let db = Store::open(&dir.join("office.db")).unwrap();
            db.save_employee(&ana).unwrap();
            db.save_employee(&bo).unwrap();
        }
        let office = held_office(&dir, &cy, &[&message, &asked, &answer]).await;
        let kind = office.db().run(&answer.id).unwrap().unwrap().run.kind;
        assert_eq!(kind, RunKind::Answered { asked_run_id: asked.id.clone(), from: bo.id.clone(), task: false, chat: false, thread: Some(message.id.clone()) });
        let open = office.conversations().unwrap().threads;
        let chat = open.iter().find(|t| t.root.id == message.id).expect("the chat message is a conversation to follow");
        assert_eq!(chat.replies.iter().map(|r| r.id.clone()).collect::<Vec<_>>(), vec![answer.id.clone()], "even though Cy reports to Ana");
        drop(office);
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn a_review_you_are_talking_about_leaves_the_rest_of_its_week_in_the_archive() {
        let dir = std::env::temp_dir().join(format!("omegastar-week-talking-{}", uuid::Uuid::new_v4()));
        fs::create_dir_all(&dir).unwrap();
        let db = Store::open(&dir.join("office.db")).unwrap();
        let week = plain_week(&db, &["ada", "bo", "cy"]);
        talk_about(&db, &week[0]);
        let ids = |t: &Thread| -> HashSet<String> { std::iter::once(t).chain(&t.related).map(|x| x.root.id.clone()).collect() };
        let archived: Vec<HashSet<String>> = Office::rows(&db, View::Archive).unwrap().iter().map(ids).collect();
        assert_eq!(archived, vec![HashSet::from([week[1].id.clone(), week[2].id.clone()])], "the conversation shows in its chip, the rest of the week here");
        drop(db);
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn a_week_leaves_out_the_reviews_of_someone_you_let_go() {
        let dir = std::env::temp_dir().join(format!("omegastar-week-departed-{}", uuid::Uuid::new_v4()));
        fs::create_dir_all(&dir).unwrap();
        let db = Store::open(&dir.join("office.db")).unwrap();
        let week = plain_week(&db, &["bo", "dee"]);
        // Both need you, and the review by the one you let go is the newer.
        for r in &week {
            let mut r = r.clone();
            r.needs_you = vec!["Approve the order.".into()];
            db.save_run(&r).unwrap();
        }
        db.depart_employee(&week[1].employee_id, now()).unwrap();
        let ids = |t: &Thread| -> HashSet<String> { std::iter::once(t).chain(&t.related).map(|x| x.root.id.clone()).collect() };
        let inbox = Office::rows(&db, View::Inbox).unwrap();
        assert_eq!(inbox.iter().map(ids).collect::<Vec<_>>(), vec![HashSet::from([week[0].id.clone()])]);
        assert_eq!(inbox[0].root.id, week[0].id, "a current employee's decision leads the row");
        let row = Office::row_of(&db, &week[0]).unwrap();
        assert_eq!(row.iter().map(|t| t.root.id.clone()).collect::<Vec<_>>(), vec![week[0].id.clone()], "Done reaches only what the row shows");
        drop(db);
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn the_archive_holds_what_reached_you_and_needs_nothing_and_the_inbox_what_does() {
        let dir = std::env::temp_dir().join(format!("omegastar-archive-{}", uuid::Uuid::new_v4()));
        fs::create_dir_all(&dir).unwrap();
        let db = Store::open(&dir.join("office.db")).unwrap();
        let e = tester();
        db.save_employee(&e).unwrap();
        let ago = |hours: f64| now() - chrono::Duration::minutes((hours * 60.0) as i64);
        let report = |hours: f64, f: &dyn Fn(&mut Run)| {
            let at = ago(hours);
            let mut r = Run::new(&e.id, RunKind::Manual, "go".into(), at);
            r.state = RunState::Succeeded;
            r.ended_at = Some(at);
            r.summary = Some("Done.".into());
            f(&mut r);
            assert!(db.insert_run(&r, &r.id).unwrap());
            r
        };
        let plain = report(1.0, &|_| {});
        let carded = report(2.0, &|r| *r = Run { id: r.id.clone(), created_at: r.created_at, ended_at: r.ended_at, ..carded(&e) });
        let limited = report(3.0, &|r| {
            r.state = RunState::Failed;
            r.limited = true;
        });
        let broken = report(4.0, &|r| r.state = RunState::Failed);
        let old = report(24.0 * 10.0, &|_| {});
        let done = report(30.0, &|r| r.archived_at = Some(ago(0.5)));
        let talking = report(5.0, &|_| {});
        talk_about(&db, &talking);
        // A reply typed into a report while it worked, with no later turn, then it finished needing nothing.
        let steered = report(7.0, &|r| r.replied_at = Some(ago(6.5)));
        // A conversation you started and marked done, with the employee's answer in it, and one still going.
        let task = |hours: f64, archived: Option<Ts>| {
            let at = ago(hours);
            let mut r = Run::new(&e.id, RunKind::Task { label: "Draft it".into(), from: None, context: String::new() }, "Draft it.".into(), at);
            r.state = RunState::Succeeded;
            r.ended_at = Some(at);
            r.archived_at = archived;
            assert!(db.insert_run(&r, &r.id).unwrap());
            r
        };
        let finished = task(50.0, Some(ago(2.0)));
        let mut turn = Run::new(&e.id, RunKind::Reply { to_run_id: finished.id.clone(), label: "Draft it".into(), task: true, card: false }, "Shorter.".into(), ago(49.0));
        turn.state = RunState::Succeeded;
        turn.ended_at = Some(ago(49.0));
        assert!(db.insert_run(&turn, &finished.id).unwrap());
        let going = task(6.0, None);

        let roots = |v: &[Thread]| v.iter().map(|t| t.root.id.clone()).collect::<Vec<_>>();
        let archive = Office::rows(&db, View::Archive).unwrap();
        assert_eq!(
            roots(&archive),
            vec![done.id.clone(), plain.id.clone(), finished.id.clone(), limited.id.clone(), steered.id.clone(), old.id.clone()],
            "newest first by when each was done or last moved; what needs you, a conversation still going and an open task stay out"
        );
        assert_eq!(archive[2].replies.iter().map(|r| r.id.clone()).collect::<Vec<_>>(), vec![turn.id.clone()], "a finished conversation keeps its turns");
        assert!(!roots(&archive).contains(&talking.id) && !roots(&archive).contains(&going.id), "the chips show those");
        let inbox = Office::rows(&db, View::Inbox).unwrap();
        assert_eq!(roots(&inbox), vec![carded.id.clone(), broken.id.clone()], "the usage limit is never yours to fix");
        drop(db);
        let _ = fs::remove_dir_all(&dir);
    }

    #[tokio::test]
    async fn an_open_card_keeps_its_row_in_the_inbox() {
        let dir = std::env::temp_dir().join(format!("omegastar-card-row-{}", uuid::Uuid::new_v4()));
        fs::create_dir_all(&dir).unwrap();
        let e = tester();
        let report = carded(&e);
        {
            let db = Store::open(&dir.join("office.db")).unwrap();
            db.save_employee(&e).unwrap();
            assert!(db.insert_run(&report, &report.id).unwrap());
        }
        let office = Office::open(dir.clone(), Arc::new(NoSink), Build::new("0.0.0".into())).await.unwrap();
        assert_eq!(office.set_archived(&report.id, true).unwrap_err().message, "Answer the card first, or dismiss it.");
        assert!(office.set_archived(&report.id, false).is_ok(), "moving it back is never blocked");
        assert_eq!(office.answer_card(&report.id, 0, CardReply::Choice { index: 5 }).unwrap_err().message, "That answer does not fit this card.");
        let unreadable = vec![NewAttachment { name: "notes.txt".into(), data: "not base64!".into() }];
        assert_eq!(office.reply_to_run(&report.id, "Not now.", false, unreadable).unwrap_err().message, "notes.txt could not be read");
        assert!(office.db().run(&report.id).unwrap().unwrap().run.has_open_card(), "a reply that did not go leaves the card open");
        drop(office);
        let _ = fs::remove_dir_all(&dir);
    }

    /// A finished run of `e` waiting on the Chrome chore, in `state`.
    fn chrome_wait(e: &Employee, state: RunState) -> Run {
        let mut r = Run::new(&e.id, RunKind::Manual, "go".into(), now());
        r.state = state;
        r.ended_at = Some(now()).filter(|_| state.is_finished());
        r.needs_you = vec!["Open Chrome.".into()];
        r.cards = vec![Card::new("Open Chrome.", None, None, CardAsk::Chore { subject: cards::CHROME.into() })];
        r
    }

    /// An office on `dir` whose work is held for the usage limit, so nothing it queues starts.
    async fn held_office(dir: &Path, e: &Employee, runs: &[&Run]) -> Office {
        {
            let db = Store::open(&dir.join("office.db")).unwrap();
            db.save_employee(e).unwrap();
            db.set_held_until(Some(now() + chrono::Duration::hours(1))).unwrap();
            for r in runs {
                assert!(db.insert_run(r, &r.id).unwrap());
            }
        }
        Office::open(dir.to_path_buf(), Arc::new(NoSink), Build::new("0.0.0".into())).await.unwrap()
    }

    #[tokio::test]
    async fn one_answer_reaches_everyone_asked_the_same_thing_and_close_ask_withdraws_one() {
        let dir = std::env::temp_dir().join(format!("omegastar-same-ask-{}", uuid::Uuid::new_v4()));
        fs::create_dir_all(&dir).unwrap();
        let ada = tester();
        let bo = Employee { id: uuid::Uuid::new_v4().to_string(), slug: "bo".into(), name: "Bo".into(), chat_session: "chat-bo".into(), ..tester() };
        let ask = |e: &Employee, message: &str, key: &str| {
            let mut r = Run::new(&e.id, RunKind::Manual, "go".into(), now());
            r.state = RunState::Succeeded;
            r.ended_at = Some(now());
            r.needs_you = vec![message.into()];
            r.cards = vec![Card::new(message, Some("Top page.".into()), Some(key.into()), CardAsk::Choices { choices: vec!["Merge".into(), "Not now".into()], recommended: 0 })];
            r
        };
        let (a, b, c) = (ask(&ada, "Merge PR #12?", "ask:pr:12"), ask(&bo, "Can #12 go live?", "ask:pr:12"), ask(&bo, "Merge PR #13?", "ask:pr:13"));
        let office = {
            let db = Store::open(&dir.join("office.db")).unwrap();
            db.save_employee(&bo).unwrap();
            drop(db);
            held_office(&dir, &ada, &[&a, &b, &c]).await
        };
        let replies = office.answer_card(&a.id, 0, CardReply::Choice { index: 0 }).unwrap();
        // Each run hears it under its own question (quoted whole here, since these sessions never started).
        let heard = |q: &str| replies.iter().filter(|r| r.prompt.ends_with(&format!("Your card: \"{q}\"\nChose: Merge."))).count();
        assert_eq!((replies.len(), heard("Merge PR #12?"), heard("Can #12 go live?")), (2, 1, 1));
        let stored = |r: &Run| office.db().run(&r.id).unwrap().unwrap().run;
        for r in [&a, &b] {
            let s = stored(r);
            assert_eq!(s.cards[0].answer.as_ref().map(|x| (x.how, x.text.as_str())), Some((AnswerHow::Tapped, "Chose: Merge.")));
            assert!(s.archived_at.is_some(), "answered, so it leaves the Inbox");
        }
        assert!(stored(&c).has_open_card(), "another key is another question");

        let err = office.close_ask_tool(&bo, "pr:14", "No such thing.").unwrap_err().message;
        assert_eq!(err, "You have no open card about 'pr:14'. Your open cards: pr:13.");
        assert_eq!(office.close_ask_tool(&bo, "PR:13", "Merged by hand.").unwrap()["closed"], 1);
        let c = stored(&c);
        assert_eq!(c.cards[0].answer.as_ref().map(|x| (x.how, x.text.as_str())), Some((AnswerHow::Withdrawn, "Merged by hand.")));
        assert!(c.archived_at.is_some());
        drop(office);
        let _ = fs::remove_dir_all(&dir);
    }

    #[tokio::test]
    async fn chrome_dropping_in_a_chat_raises_no_card() {
        let dir = std::env::temp_dir().join(format!("omegastar-chrome-chat-{}", uuid::Uuid::new_v4()));
        fs::create_dir_all(&dir).unwrap();
        let e = tester();
        let mut chat = Run::new(&e.id, RunKind::Chat, "hi".into(), now());
        chat.state = RunState::Succeeded;
        chat.ended_at = Some(now());
        let office = held_office(&dir, &e, &[&chat]).await;
        office.chrome_down(&chat, &e);
        let stored = office.db().run(&chat.id).unwrap().unwrap().run;
        assert!(stored.cards.is_empty() && stored.needs_you.is_empty(), "the chat says it itself");
        assert!(office.db().open_topic_runs("chore:chrome").unwrap().is_empty());
        drop(office);
        let _ = fs::remove_dir_all(&dir);
    }

    #[tokio::test]
    async fn done_reaches_a_run_held_for_the_usage_limit_without_a_reply() {
        let dir = std::env::temp_dir().join(format!("omegastar-chore-held-{}", uuid::Uuid::new_v4()));
        fs::create_dir_all(&dir).unwrap();
        let e = tester();
        let done = chrome_wait(&e, RunState::Succeeded);
        let held = chrome_wait(&e, RunState::Queued);
        let office = held_office(&dir, &e, &[&done, &held]).await;
        let replies = office.answer_card(&done.id, 0, CardReply::Done).unwrap();
        assert_eq!(replies.len(), 1, "only the finished run gets a reply");
        assert!(matches!(&replies[0].kind, RunKind::Reply { to_run_id, .. } if *to_run_id == done.id));
        let held = office.db().run(&held.id).unwrap().unwrap().run;
        assert_eq!(held.state, RunState::Queued);
        assert!(!held.cards.is_empty() && !held.has_open_card(), "its retry carries the answered card");
        assert!(held.archived_at.is_none());
        drop(office);
        let _ = fs::remove_dir_all(&dir);
    }

    #[tokio::test]
    async fn done_on_a_working_run_clears_its_chore_headline() {
        let dir = std::env::temp_dir().join(format!("omegastar-chore-live-{}", uuid::Uuid::new_v4()));
        fs::create_dir_all(&dir).unwrap();
        let e = tester();
        let done = chrome_wait(&e, RunState::Succeeded);
        let office = held_office(&dir, &e, &[&done]).await;
        let (input, _heard) = tokio::sync::mpsc::unbounded_channel();
        let live = chrome_wait(&e, RunState::Running);
        lock(&office.0.active).insert(
            live.id.clone(),
            Active { token: "t".into(), pid: None, cancelled: false, needs_you: vec!["Open Chrome.".into(), "Totals look off.".into()], cards: live.cards.clone(), score: None, proposed: None, verdict: false, transcript: None, input: Some(input) },
        );
        office.answer_card(&done.id, 0, CardReply::Done).unwrap();
        let active = lock(&office.0.active);
        let a = &active[&live.id];
        assert!(!a.cards.is_empty() && a.cards.iter().all(|c| !c.is_open()));
        assert_eq!(a.needs_you, vec!["Totals look off.".to_string()], "only the answered chore leaves");
        drop(active);
        drop(office);
        let _ = fs::remove_dir_all(&dir);
    }

    /// Every row of every table, each column as text, with `archivedAt` left out of run data.
    fn every_row(path: &Path) -> Vec<(String, Vec<String>)> {
        let c = rusqlite::Connection::open(path).unwrap();
        let mut st = c.prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name").unwrap();
        let tables: Vec<String> = st.query_map([], |r| r.get(0)).unwrap().collect::<rusqlite::Result<_>>().unwrap();
        let mut out = vec![];
        for t in tables {
            let mut st = c.prepare(&format!("SELECT * FROM {t} ORDER BY rowid")).unwrap();
            let names: Vec<String> = st.column_names().into_iter().map(String::from).collect();
            let rows = st
                .query_map([], |r| {
                    let mut cols = vec![];
                    for (i, name) in names.iter().enumerate() {
                        let v: rusqlite::types::Value = r.get(i)?;
                        cols.push(match v {
                            rusqlite::types::Value::Text(s) if t == "runs" && name == "data" => {
                                let mut j: Value = serde_json::from_str(&s).unwrap();
                                j.as_object_mut().unwrap().remove("archivedAt");
                                j.to_string()
                            }
                            v => format!("{v:?}"),
                        });
                    }
                    Ok(cols)
                })
                .unwrap();
            for row in rows {
                out.push((t.clone(), row.unwrap()));
            }
        }
        out
    }

    #[tokio::test]
    async fn archiving_a_replied_thread_writes_only_archived_at() {
        let dir = std::env::temp_dir().join(format!("omegastar-inbox-{}", uuid::Uuid::new_v4()));
        let path = dir.join("office.db");
        fs::create_dir_all(&dir).unwrap();
        let ada = Employee {
            id: uuid::Uuid::new_v4().to_string(),
            slug: "ada".into(),
            name: "Ada".into(),
            title: "Tester".into(),
            description: String::new(),
            objective: String::new(),
            manager_id: None,
            skills: SkillGrant { builtins: false, keys: vec![] },
            clearance: Clearance::Supervised,
            allow_rules: vec![],
            model: None,
            effort: None,
            browser: false,
            auto_tidy: false,
            workspaces: vec![],
            hue: 0,
            chat_session: "chat-ada".into(),
            hired_at: now(),
        };
        let mut report = Run::new(&ada.id, RunKind::Manual, "go".into(), now());
        report.state = RunState::Succeeded;
        report.ended_at = Some(now());
        report.summary = Some("All good.".into());
        report.replied_at = Some(now());
        let mut reply = Run::new(&ada.id, RunKind::Reply { to_run_id: report.id.clone(), label: "Manual run".into(), task: false, card: false }, "Thanks.".into(), now());
        reply.state = RunState::Succeeded;
        reply.ended_at = Some(now());
        reply.summary = Some("Noted.".into());
        {
            let db = Store::open(&path).unwrap();
            db.save_employee(&ada).unwrap();
            assert!(db.insert_run(&report, &report.id).unwrap());
            assert!(db.insert_run(&reply, &report.id).unwrap());
        }

        let office = Office::open(dir.clone(), Arc::new(NoSink), Build::new("0.0.0".into())).await.unwrap();
        let before = every_row(&path);
        let archived = office.set_archived(&reply.id, true).unwrap();
        assert_eq!(archived.id, report.id);
        assert!(archived.archived_at.is_some());
        assert_eq!(every_row(&path), before, "nothing but archivedAt changed");
        let c = rusqlite::Connection::open(&path).unwrap();
        let mut st = c.prepare("SELECT id FROM runs WHERE json_extract(data, '$.archivedAt') IS NOT NULL").unwrap();
        let stamped: Vec<String> = st.query_map([], |r| r.get(0)).unwrap().collect::<rusqlite::Result<_>>().unwrap();
        assert_eq!(stamped, vec![report.id.clone()]);

        drop(office);
        let _ = fs::remove_dir_all(&dir);
    }
}
