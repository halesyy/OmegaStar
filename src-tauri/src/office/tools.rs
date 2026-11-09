//! The office tools employees call over MCP (dispatched from `mcp.rs`).

use super::*;
use crate::cards;

/// How many cards one run may have waiting on you.
const CARDS_PER_RUN: usize = 5;
/// The loop guard: once a chain holds PAIR_HANDOFFS asks between the same two employees within PAIR_WINDOW, or
/// CHAIN_HANDOFFS hand-offs in all, the next hand-off waits PAUSE and goes as a chain of its own. Answers never count,
/// and delegated work counts only toward the chain: the daily cap on tasks covers it. Once it paused PAUSES_PER_DAY
/// asks between the same two employees in a day, it stops the next one between them.
const PAIR_HANDOFFS: usize = 6;
const PAIR_WINDOW: chrono::Duration = chrono::Duration::hours(2);
const CHAIN_HANDOFFS: usize = 40;
const PAUSE: chrono::Duration = chrono::Duration::hours(1);
const PAUSES_PER_DAY: u32 = 2;
/// Most runs the walk up a chain of hand-offs goes through, against a damaged trail.
const CHAIN_HOPS: usize = 64;
/// Most tasks a manager hands one report in a day.
const TASKS_PER_DAY: u32 = 4;
/// Reports held for a manager reach them in one run once this long passes without another, and never later than
/// HOLD_MAX after the first.
const HOLD: chrono::Duration = chrono::Duration::minutes(30);
const HOLD_MAX: chrono::Duration = chrono::Duration::hours(2);
/// An answer resumes the asker's session only while that is under a day old and its context under this.
const FRESH_TOKENS: u64 = 120_000;
/// An answer whose run failed goes again this many more times, each after REDELIVER_AFTER.
const REDELIVERIES: u32 = 2;
const REDELIVER_AFTER: chrono::Duration = chrono::Duration::minutes(10);
/// Under Claude Code's 300 s idle abort, so a wait never races it.
const AWAIT_LIMIT: Duration = Duration::from_secs(240);
/// Most runs `source_chain` walks back through hand-offs.
const SOURCE_HOPS: usize = 12;
/// What `ask_colleague` takes as `to` for news to every colleague.
const EVERYONE: &str = "everyone";
/// The longest name `name_thread` gives a thread.
const TITLE_CHARS: usize = 60;
/// A card raised within this long after its employee closed one about the same thing is an edit: no new notification.
const QUIET_AFTER_CLOSE: chrono::Duration = chrono::Duration::minutes(15);
/// A card raised in a conversation you sent a message in within this long shows there, with no notification.
const LIVE: chrono::Duration = chrono::Duration::minutes(15);

impl Office {
    /// The live run a token belongs to, and its employee.
    pub fn caller(&self, token: &str) -> Option<(String, Employee)> {
        let run_id = lock(&self.0.active).iter().find(|(_, a)| a.token == token).map(|(id, _)| id.clone())?;
        let db = self.db();
        let run = db.run(&run_id).ok()??.run;
        let e = db.employee(&run.employee_id).ok()??;
        Some((run_id, e))
    }

    pub fn team(&self, caller: &Employee) -> Result<Value> {
        let db = self.db();
        let now = now();
        let today = day_start(now);
        let reports: Vec<Value> = db
            .employees()?
            .iter()
            .filter(|e| e.manager_id.as_deref() == Some(&caller.id))
            .map(|e| {
                let v = Self::presence(&db, e, now, false)?;
                Ok(json!({
                    "id": e.id, "name": e.name, "slug": e.slug, "title": e.title, "objective": e.objective,
                    "presence": v.presence,
                    "lastSummary": v.last_run.and_then(|r| r.summary),
                    "tasksToday": db.delegated_since(&caller.id, &e.id, today)?,
                }))
            })
            .collect::<Result<_>>()?;
        Ok(json!({ "reports": reports, "tasksPerDay": TASKS_PER_DAY }))
    }

    /// Hands a direct report a task. Refuses one who is working further up this chain (they would wait on each
    /// other) and a fifth task in a day, except in a conversation you are in, and pauses one the loop guard stops.
    pub fn delegate(&self, caller_run: &str, caller: &Employee, to: &str, task: &str) -> Result<Value> {
        if task.trim().is_empty() {
            return Err(AppError::invalid("task is empty"));
        }
        let at = now();
        let (report, run, ahead, conversation) = {
            let db = self.db();
            let reports: Vec<Employee> = db.employees()?.into_iter().filter(|e| e.manager_id.as_deref() == Some(&caller.id)).collect();
            let report = find_member(&reports, to, |e| (&e.id, Some(&e.slug), &e.name))
                .ok_or_else(|| AppError::invalid(format!("'{to}' is not one of your direct reports. Call team() for the list.")))?
                .clone();
            let (up, chain) = chain_up(&db, caller_run)?;
            if waiting_up(&up, &report.id) {
                return Err(AppError::invalid(format!(
                    "{} is already waiting on you further up this chain, so they cannot take this now. Finish with what you have, and say in your report what you still need from them.",
                    report.name
                )));
            }
            let conversation = up.first().is_some_and(|r| r.conversation_root().is_some());
            if !conversation && db.delegated_since(&caller.id, &report.id, day_start(at))? >= TASKS_PER_DAY {
                return Err(AppError::invalid(format!(
                    "{} already has {TASKS_PER_DAY} tasks from you today. Put the rest in your plan for tomorrow.",
                    report.name
                )));
            }
            let mut run = Run::new(&report.id, RunKind::Delegated { parent_run_id: caller_run.to_string() }, task.trim().to_string(), at);
            guard(&db, &mut run, chain, caller, &report)?;
            let ahead = queue_ahead(&db, &run, at)?;
            (report, run, ahead, conversation)
        };
        let session = run.id.clone();
        let run = self.enqueue(run, session)?;
        self.append_event(
            caller_run,
            RunEvent::Delegated { child_run_id: run.id.clone(), employee_id: report.id.clone(), task: run.prompt.clone() },
        );
        let note = match run.not_before {
            Some(t) => paused_note(&report.name, "Their report", t),
            None => handoff_note(&report.name, "Their report", ahead, conversation, !conversation),
        };
        Ok(json!({ "runId": run.id, "employee": report.name, "state": run.state, "note": note }))
    }

    /// Every other agent, with what they are for, who they report to and whether they are free.
    pub fn colleagues(&self, caller: &Employee) -> Result<Value> {
        let db = self.db();
        let now = now();
        let employees = db.employees()?;
        let people = db.people()?;
        let manager_name = |id: &Option<String>| {
            id.as_ref().and_then(|m| {
                employees.iter().find(|x| &x.id == m).map(|x| x.name.clone()).or_else(|| people.iter().find(|p| &p.id == m).map(|p| p.name.clone()))
            })
        };
        let list: Vec<Value> = employees
            .iter()
            .filter(|e| e.id != caller.id)
            .map(|e| {
                let v = Self::presence(&db, e, now, false)?;
                Ok(json!({
                    "id": e.id, "name": e.name, "slug": e.slug, "title": e.title,
                    "objective": e.objective, "description": e.description,
                    "reportsTo": manager_name(&e.manager_id),
                    "presence": v.presence,
                }))
            })
            .collect::<Result<_>>()?;
        Ok(json!({ "colleagues": list }))
    }

    /// Asks any other agent one question, with kind "task" hands them a task, or with kind "info" leaves them
    /// news that starts no run (`share_news`). Refuses a colleague who is working further up this chain (they
    /// would wait on each other), adds to a request of the caller's they have not started yet, and pauses a
    /// hand-off the loop guard stops.
    pub fn ask_colleague(&self, caller_run: &str, caller: &Employee, to: &str, question: &str, kind: &str) -> Result<Value> {
        let task = kind == "task";
        if question.trim().is_empty() {
            return Err(AppError::invalid(if task { "task is empty" } else if kind == "info" { "the news is empty" } else { "question is empty" }));
        }
        if kind == "info" {
            return self.share_news(caller, to, question.trim());
        }
        if to.trim().eq_ignore_ascii_case(EVERYONE) {
            return Err(AppError::invalid("Only news (kind info) goes to everyone. Ask one colleague at a time."));
        }
        let at = now();
        let what = if task { "Their report" } else { "The answer" };
        let (colleague, run, folded, ahead, conversation) = {
            let db = self.db();
            let others: Vec<Employee> = db.employees()?.into_iter().filter(|e| e.id != caller.id).collect();
            let colleague = colleague_in(&others, to)?;
            let (up, chain) = chain_up(&db, caller_run)?;
            if waiting_up(&up, &colleague.id) {
                return Err(AppError::invalid(format!(
                    "{} is already waiting on you further up this chain, so they cannot answer now. Answer with what you have, and say in your report what you still need from them.",
                    colleague.name
                )));
            }
            let here = up.first().and_then(|r| r.conversation_root().map(String::from));
            // A request of the caller's they have not started yet takes this one too, when both came from the same
            // place, so one answer covers both and goes where the first would have.
            let earlier = db.active_runs_of(&colleague.id)?.into_iter().find(|r| {
                untouched(r)
                    && matches!(&r.kind, RunKind::Asked { asked_by, .. } if *asked_by == caller.id)
                    && r.parent_run_id().and_then(|p| inbox::run_of(&db, p)).and_then(|p| p.conversation_root().map(String::from)) == here
            });
            let (run, folded) = match earlier {
                Some(mut r) => {
                    r.prompt = format!("{}\n\nLater, {} added:\n\n{}", r.prompt, caller.name, question.trim());
                    if let RunKind::Asked { task: t, .. } = &mut r.kind {
                        *t |= task;
                    }
                    db.save_run(&r)?;
                    (r, true)
                }
                None => {
                    let kind = RunKind::Asked { parent_run_id: caller_run.to_string(), asked_by: caller.id.clone(), task };
                    let mut run = Run::new(&colleague.id, kind, question.trim().to_string(), at);
                    guard(&db, &mut run, chain, caller, &colleague)?;
                    (run, false)
                }
            };
            let ahead = queue_ahead(&db, &run, at)?;
            (colleague, run, folded, ahead, here.is_some())
        };
        let (run, note) = if folded {
            self.sink().run_updated(&run);
            let back = handoff_note(&colleague.name, what, ahead, conversation, false);
            (run, format!("{} had not started your earlier request yet, so Omega Star added this one to it, and one answer covers both. {back}", colleague.name))
        } else {
            let session = run.id.clone();
            let run = self.enqueue(run, session)?;
            let note = match run.not_before {
                Some(t) => paused_note(&colleague.name, what, t),
                None => handoff_note(&colleague.name, what, ahead, conversation, false),
            };
            (run, note)
        };
        self.append_event(
            caller_run,
            RunEvent::Asked { child_run_id: run.id.clone(), employee_id: colleague.id.clone(), question: question.trim().to_string(), task },
        );
        Ok(json!({ "runId": run.id, "colleague": colleague.name, "state": run.state, "note": note }))
    }

    /// Leaves news for one colleague, or with `to` "everyone" for every colleague: it starts no run and nothing
    /// comes back. Each reads it at the top of their next run (`catch_up`).
    fn share_news(&self, caller: &Employee, to: &str, text: &str) -> Result<Value> {
        let names: Vec<String> = {
            let db = self.db();
            let others: Vec<Employee> = db.employees()?.into_iter().filter(|e| e.id != caller.id).collect();
            let to = if to.trim().eq_ignore_ascii_case(EVERYONE) { others } else { vec![colleague_in(&others, to)?] };
            if to.is_empty() {
                return Err(AppError::invalid("You have no colleagues to tell."));
            }
            let at = now();
            db.tx(|| {
                for e in &to {
                    let news = News { id: uuid::Uuid::new_v4().to_string(), employee_id: e.id.clone(), from: caller.id.clone(), text: text.to_string(), created_at: at, read_at: None, read_in: None };
                    db.save_news(&news)?;
                }
                Ok(())
            })?;
            to.into_iter().map(|e| e.name).collect()
        };
        let who = match names.split_last() {
            Some((last, rest)) if !rest.is_empty() => format!("{} and {last}", rest.join(", ")),
            _ => names.join(""),
        };
        let note = format!("Omega Star shows this to {who} at the top of their next run. It starts no run, and nothing comes back.");
        Ok(json!({ "told": names, "note": note }))
    }

    pub async fn await_reports(&self, caller: &Employee, run_ids: &[String]) -> Result<Value> {
        let mut rx = self.0.finished.subscribe();
        let deadline = tokio::time::Instant::now() + AWAIT_LIMIT;
        loop {
            let runs = {
                let db = self.db();
                let mut v = vec![];
                for id in run_ids {
                    let r = db.run(id)?.ok_or_else(|| AppError::not_found(format!("run {id} not found")))?.run;
                    let parent_ok = r.parent_run_id().and_then(|p| inbox::run_of(&db, p)).map(|p| p.employee_id == caller.id);
                    if parent_ok != Some(true) {
                        return Err(AppError::invalid(format!("run {id} was not delegated or asked by you")));
                    }
                    v.push(r);
                }
                v
            };
            let done = runs.iter().all(|r| r.state.is_finished());
            if done || tokio::time::Instant::now() >= deadline {
                self.mark_delivered(runs.iter().filter(|r| r.state.is_finished()).map(|r| r.id.as_str()))?;
                let names: HashMap<String, String> = self.db().employees()?.into_iter().map(|e| (e.id, e.name)).collect();
                let reports: Vec<Value> = runs
                    .iter()
                    .map(|r| {
                        json!({
                            "runId": r.id, "employee": names.get(&r.employee_id), "state": r.state,
                            "summary": r.summary, "error": r.error,
                        })
                    })
                    .collect();
                let note = if done {
                    "All reports are in."
                } else {
                    "Some runs are still going. Each comes back to you when it finishes, so you can finish now; call await_reports again only if you need it in this run."
                };
                return Ok(json!({ "reports": reports, "note": note }));
            }
            let _ = tokio::time::timeout_at(deadline, rx.changed()).await;
        }
    }

    /// Records that these finished answers and reports reached whoever handed them over.
    fn mark_delivered<'a>(&self, run_ids: impl Iterator<Item = &'a str>) -> Result<()> {
        let db = self.db();
        for id in run_ids {
            if let Some(mut r) = db.run(id)?.map(|d| d.run) {
                if matches!(r.kind, RunKind::Asked { .. } | RunKind::Delegated { .. }) && r.delivered_at.is_none() {
                    r.delivered_at = Some(now());
                    db.save_run(&r)?;
                }
            }
        }
        Ok(())
    }

    /// Brings every finished answer or report whose asker's run ended without collecting it to the
    /// asker, as an Answered run, or holds it for them (`hold`), and queues a failed answer again. Called
    /// whenever a run ends, since either side can end last; the check and `delivered_at` happen under one
    /// lock, so each is delivered exactly once.
    pub(super) fn deliver_answers(&self, ended: &Run) -> Result<()> {
        let due = due_answers(&self.db(), ended)?;
        for (run, session) in due {
            self.enqueue(run, session)?;
        }
        Ok(())
    }

    pub fn people_list(&self) -> Result<Value> {
        let people: Vec<Value> = self
            .db()
            .people()?
            .iter()
            .map(|p| {
                json!({
                    "id": p.id, "name": p.name, "title": p.title, "description": p.description,
                    "strengths": p.strengths, "responsibilities": p.responsibilities,
                    "channels": p.channels, "notes": p.notes,
                })
            })
            .collect();
        Ok(json!({ "people": people }))
    }

    pub fn request_tool(&self, caller_run: &str, caller: &Employee, args: &Value) -> Result<Value> {
        let (req, person) = self.create_request(caller_run, caller, args)?;
        let channel = req.channel_id.as_ref().and_then(|c| person.channels.iter().find(|x| &x.id == c));
        let relay = ceo_of(&self.db())?;
        let then = "then call `sent` with the request id, the tool you sent it with and exactly what that tool returned";
        let hint = match channel {
            Some(c) => format!(
                "Recorded. Now deliver it: {}. Use a connector or skill you have for that channel, {then}. If you cannot reach it, say so in your report and {relay} will relay it from Omega Star.",
                claude::channel_line(c)
            ),
            None => format!("Recorded without a channel. Deliver it through whichever of their channels fits the ask if you can reach one, {then}; otherwise say so in your report and {relay} will relay it from Omega Star."),
        };
        Ok(json!({
            "request": req,
            "person": { "id": person.id, "name": person.name, "title": person.title, "channels": person.channels, "notes": person.notes },
            "channel": channel,
            "hint": hint,
        }))
    }

    pub fn my_requests(&self, caller: &Employee) -> Result<Value> {
        let watch = self.settings()?.watch;
        let mut reqs = self.db().requests(&RequestFilter { employee_id: Some(caller.id.clone()), ..Default::default() })?;
        reqs.truncate(50);
        for r in &mut reqs {
            Self::present_with(&watch, r);
        }
        Ok(json!({ "requests": reqs }))
    }

    /// Records that the caller delivered one of its requests, from what the send tool returned.
    pub fn sent_tool(&self, caller_run: &str, caller: &Employee, args: &Value) -> Result<Value> {
        let text = |k: &str| args.get(k).and_then(|v| v.as_str()).map(str::trim).unwrap_or("").to_string();
        let (id, tool) = (text("requestId"), text("tool"));
        let result = match args.get("result") {
            Some(Value::String(s)) => s.clone(),
            Some(v) if !v.is_null() => v.to_string(),
            _ => String::new(),
        };
        if id.is_empty() || tool.is_empty() {
            return Err(AppError::invalid("requestId and tool are required: the request you sent and the tool you sent it with"));
        }
        if result.trim().is_empty() {
            return Err(AppError::invalid("result is required: exactly what the send tool returned"));
        }
        let (r, person, lane) = {
            let db = self.db();
            let mut r = match db.request(&id)? {
                Some(r) if r.employee_id == caller.id => r,
                _ => return Err(AppError::not_found(format!("'{id}' is not one of your requests. Call my_requests() for the list."))),
            };
            if r.state == RequestState::Cancelled {
                return Err(AppError::invalid("that request was cancelled, so there is nothing to watch"));
            }
            if r.delivery.is_some() {
                return Err(AppError::conflict("that request is already recorded as sent"));
            }
            r.delivery = Some(Delivery::new(watch::parse_sent(&tool, &result, now()), DeliverySource::Employee, r.kind));
            db.save_request(&r)?;
            let person = Self::person_name(&db, &r.person_id)?;
            (r, person, db.run(caller_run)?.map(|x| x.run.kind.lane()))
        };
        self.announce(&r);
        let back = if lane == Some(Lane::Work) { "starts a follow-up run that resumes this session" } else { "starts a follow-up run for you" };
        let note = match &r.delivery {
            Some(Delivery { watch: None, .. }) => "Recorded as sent. An FYI needs no reply, so nothing watches it.".to_string(),
            _ if !r.state.is_open() => "Recorded as sent.".to_string(),
            Some(Delivery { locator: Locator::TeamsChat { server: Some(_), .. }, .. }) => format!(
                "Omega Star now watches that Teams chat for {person}'s reply, nudges them once when it is due, and {back} when they reply. Do not watch for it yourself."
            ),
            _ => format!("Omega Star now checks for {person}'s reply in business hours, nudges them once when it is due, and {back} when they reply. Do not watch for it yourself."),
        };
        Ok(json!({ "request": self.present(r), "note": note }))
    }

    /// What a reply check or a nudge found about its own request, recorded once per run. A reply
    /// resolves the request as recorded by nobody, so the employee's one follow-up run starts. On a
    /// Teams chat, a finding that keeps watching leaves the native reader's cursor where it was: the
    /// run may have missed a message, so the reader still judges everything after the cursor.
    pub fn check_result_tool(&self, caller_run: &str, args: &Value) -> Result<Value> {
        let text = |k: &str| args.get(k).and_then(|v| v.as_str()).map(str::trim).unwrap_or("").to_string();
        let id = text("requestId");
        let verdict: Verdict = serde_json::from_value(json!(text("verdict")))
            .map_err(|_| AppError::invalid("verdict must be answered, done, askedBack, acknowledged or noReply"))?;
        let kind = self.run(caller_run)?.kind;
        let nudging = matches!(kind, RunKind::Nudge { .. });
        if !matches!(&kind, RunKind::ReplyCheck { request_id, .. } | RunKind::Nudge { request_id, .. } if *request_id == id) {
            return Err(AppError::invalid("check_result is only for a reply check or a nudge that Omega Star started, about its own request"));
        }
        {
            let mut active = lock(&self.0.active);
            let a = active.get_mut(caller_run).ok_or_else(|| AppError::invalid("this run has ended"))?;
            if a.verdict {
                return Err(AppError::conflict("you already recorded what you found in this run"));
            }
            a.verdict = true;
        }
        let at = now();
        let (words, note) = (text("response"), text("note"));
        let (applied, r) = {
            let db = self.db();
            let mut r = db.request(&id)?.ok_or_else(|| AppError::not_found("request not found"))?;
            let said = if !words.is_empty() { words.clone() } else if !note.is_empty() { note.clone() } else { text("verdict") };
            let heard = Heard { at, from: Self::person_name(&db, &r.person_id)?, text: said.clone(), verdict, note };
            let chat = matches!(r.delivery, Some(Delivery { locator: Locator::TeamsChat { .. }, .. }));
            let seen = watch_of(&mut r).and_then(|w| w.seen.clone());
            let applied = watch::apply_verdict(&mut r, &Seen { id: caller_run.to_string(), at }, heard, &said);
            if chat && applied == Applied::Kept {
                if let Some(w) = watch_of(&mut r) {
                    w.seen = seen;
                }
            }
            if applied != Applied::Stale {
                db.save_request(&r)?;
            }
            (applied, r)
        };
        let next = match (&applied, verdict) {
            (Applied::Stale, _) => "Nothing changed: the request was already answered or is no longer watched. Send nothing; end now with one line.",
            (Applied::Kept, Verdict::NoReply) if nudging => "Recorded: no reply yet. Send the reminder now, as your instructions say.",
            (Applied::Kept, _) if nudging => "Recorded. Send nothing; end now with one line.",
            (Applied::Kept, _) => "Recorded. Omega Star keeps watching. End now with one line.",
            (Applied::Resolve { .. }, _) => "Recorded. A follow-up run carries on with their reply. Send nothing; end now with one line.",
        };
        if applied != Applied::Stale {
            self.announce(&r);
        }
        if let Applied::Resolve { state, response } = applied {
            self.resolve_request(&id, state, Some(response), None)?;
        }
        Ok(json!({ "recorded": verdict, "note": next }))
    }

    /// `update_request` from an employee's run. A reply check or a nudge records with `check_result`
    /// instead: recording as the requester would start no follow-up run.
    pub fn update_request_tool(&self, caller_run: &str, caller: &Employee, args: &Value) -> Result<Value> {
        if matches!(self.run(caller_run)?.kind, RunKind::ReplyCheck { .. } | RunKind::Nudge { .. }) {
            return Err(AppError::invalid("in a reply check or a nudge, record what you found with check_result"));
        }
        let text = |k: &str| args.get(k).and_then(|v| v.as_str()).unwrap_or("");
        let response = args.get("response").and_then(|v| v.as_str()).map(String::from);
        let r = self.resolve_request(text("id"), RequestState::parse(text("state"))?, response, Some(&caller.id))?;
        Ok(json!({ "request": self.present(r) }))
    }

    fn own_schedule(&self, caller: &Employee, id: &str) -> Result<Schedule> {
        match self.db().schedule(id)? {
            Some((s, _)) if s.employee_id == caller.id => Ok(s),
            _ => Err(AppError::not_found(format!("'{id}' is not one of your schedules. Call schedules() for the list."))),
        }
    }

    pub fn my_schedules(&self, caller: &Employee) -> Result<Value> {
        Ok(json!({
            "schedules": self.schedules(&caller.id)?,
            "localTime": Local::now().format("%Y-%m-%d %-I:%M %P (UTC%:z)").to_string(),
        }))
    }

    /// Creates a schedule, or with `id` changes only the fields given.
    pub fn schedule_tool(&self, caller: &Employee, args: &Value) -> Result<Value> {
        let id = args.get("id").and_then(|v| v.as_str()).filter(|s| !s.trim().is_empty());
        let mut d = match id {
            Some(id) => {
                let s = self.own_schedule(caller, id)?;
                ScheduleDraft {
                    id: Some(s.id),
                    employee_id: s.employee_id,
                    label: s.label,
                    cron: s.cron,
                    instruction: s.instruction,
                    enabled: s.enabled,
                    quiet: s.quiet,
                    model: s.model,
                    effort: s.effort,
                    active_hours: s.active_hours,
                }
            }
            None => ScheduleDraft {
                id: None,
                employee_id: caller.id.clone(),
                label: String::new(),
                cron: String::new(),
                instruction: String::new(),
                enabled: true,
                quiet: false,
                model: None,
                effort: None,
                active_hours: false,
            },
        };
        let text = |k: &str| args.get(k).and_then(|v| v.as_str());
        let flag = |k: &str| args.get(k).and_then(|v| v.as_bool());
        if let Some(v) = text("label") {
            d.label = v.to_string();
        }
        if let Some(v) = text("cron") {
            d.cron = v.to_string();
        }
        if let Some(v) = text("instruction") {
            d.instruction = v.to_string();
        }
        if let Some(v) = flag("quiet") {
            d.quiet = v;
        }
        if let Some(v) = flag("enabled") {
            d.enabled = v;
        }
        if let Some(v) = flag("activeHours") {
            d.active_hours = v;
        }
        if let Some(v) = text("model") {
            d.model = Some(v.trim()).filter(|m| !m.is_empty() && *m != "default").map(String::from);
        }
        if let Some(v) = text("effort") {
            d.effort = effort_arg(v)?;
        }
        if d.cron.trim().is_empty() {
            return Err(AppError::invalid("cron is required"));
        }
        if d.instruction.trim().is_empty() {
            return Err(AppError::invalid("instruction is required: what you do each time it fires"));
        }
        let s = self.save_schedule(d)?;
        let when = match schedule::preview(&s.cron, now(), &Local) {
            CronPreview::Ok { description, .. } => description,
            CronPreview::Err { error } => error,
        };
        let mut out = json!({ "schedule": s, "when": when });
        if let Some(tip) = super::schedules::light_model_tip(&s) {
            out["tip"] = tip.into();
        }
        Ok(out)
    }

    pub fn unschedule_tool(&self, caller: &Employee, id: &str) -> Result<Value> {
        let s = self.own_schedule(caller, id)?;
        self.delete_schedule(&s.id)?;
        Ok(json!({ "deleted": s.id }))
    }

    /// Puts something in front of you as a card on the calling run: an item in your Inbox with the answer built in, and a
    /// desktop notification (`ask_card`). A question someone already asked you (same key, or the same chore) joins that
    /// item and notifies nobody again, and so does an edit of the caller's own card about the same thing. A list raised
    /// while the caller's list about the same thing is open grows it (`cards::grow`).
    pub fn notify_tool(&self, caller_run: &str, caller: &Employee, args: &Value) -> Result<Value> {
        let mut card = cards::card(args)?;
        let home = self.employee_dir(&caller.id);
        if let Some(raw) = &card.file {
            card.file = Some(card_file_path(&home, &caller.workspaces, raw)?.to_string_lossy().into_owned());
        }
        card.images = card.images.iter().map(|raw| Ok(card_image_path(&home, &caller.workspaces, raw)?.to_string_lossy().into_owned())).collect::<Result<_>>()?;
        let ceo = {
            let db = self.db();
            // A turn of an older build's chat: a card there would never reach them.
            if db.run(caller_run)?.map(|r| r.run.kind.lane()) == Some(Lane::Chat) {
                return Err(AppError::invalid(format!("Ask {} in your reply instead: a card from this run would not reach them.", ceo_of(&db)?)));
            }
            ceo_of(&db)?
        };
        let mine = match card.topic() {
            Some(t) => self.own_pending(caller, &t)?,
            None => vec![],
        };
        let open_lists: Vec<Vec<CardItem>> = mine
            .iter()
            .filter_map(|c| match &c.ask {
                CardAsk::Items { items, .. } => Some(items.clone()),
                _ => None,
            })
            .collect();
        let grown = match &mut card.ask {
            CardAsk::Items { items, .. } if !open_lists.is_empty() => {
                *items = cards::grow(open_lists.into_iter().chain([std::mem::take(items)]))?;
                Some(items.len())
            }
            _ => None,
        };
        let tip = cards::wants_attachment(&card).then(|| format!("Attach what it is about (file for a draft, link for a pull request) so {ceo} can read it on the card."));
        let news = card.ask == CardAsk::News;
        let chore = matches!(card.ask, CardAsk::Chore { .. });
        let (first, notified) = self.ask_card(caller_run, caller, card, !mine.is_empty())?;
        let note = match (grown, chore, first) {
            (Some(n), ..) => format!("Added to your open list about this: the card now holds {n} items, one item in {ceo}'s Inbox, and they were not notified again. Finish this run now; do not wait for it."),
            (_, true, true) => format!("Recorded. {ceo} has been asked. When they press Done, this conversation carries on with a short message. Carry on without it now, or finish."),
            (_, true, false) => format!("{ceo} has already been asked to do this for another run. When they press Done, this conversation carries on too. Carry on without it now, or finish."),
            _ if news => format!("Recorded. {ceo} sees it in their Inbox until they mark it seen. Nothing comes back to you."),
            (_, _, true) => "Recorded. They answer on the card, and their answers to this run's cards come back to you in this conversation as one short message. Finish this run now; do not wait for it.".to_string(),
            (_, _, false) => format!("{ceo} already has this question from another run, so it is one item in their Inbox and their answer comes back to you too. Finish this run now; do not wait for it."),
        };
        let mut out = json!({ "notified": notified, "note": note });
        if let Some(tip) = tip {
            out["tip"] = tip.into();
        }
        Ok(out)
    }

    /// Puts a line for the company page to you on a card from any run (`cards::company_line_card`), as `notify` puts a
    /// card. Going ahead adds it to the page (`carry_out`).
    pub fn propose_company_line_tool(&self, caller_run: &str, caller: &Employee, args: &Value) -> Result<Value> {
        let s = |k: &str| args.get(k).and_then(Value::as_str).unwrap_or("");
        let card = cards::company_line_card(s("section"), s("line"), s("why"))?;
        let ceo = ceo_of(&self.db())?;
        let edit = match card.topic() {
            Some(t) => !self.own_pending(caller, &t)?.is_empty(),
            None => false,
        };
        let (_, notified) = self.ask_card(caller_run, caller, card, edit)?;
        let note = format!(
            "Recorded. {ceo} sees the line on a card, and Omega Star adds it to the page when they tap Add it, so do not write it there \
yourself. Their answer comes back to you in this conversation. Finish this run now; do not wait for it."
        );
        Ok(json!({ "notified": notified, "note": note }))
    }

    /// Raises `card` on `who`'s run `run_id` (`raise_card`) with a desktop notification, unless someone already asked you
    /// the same thing, or it shows quietly: an `edit` of their own open card about the same thing, a card raised again
    /// within QUIET_AFTER_CLOSE of their closing one about the same thing, or a turn of a conversation you sent a message
    /// in within LIVE, where it shows anyway. Returns whether this is the first time you are asked, and whether you were
    /// notified.
    pub(super) fn ask_card(&self, run_id: &str, who: &Employee, card: Card, edit: bool) -> Result<(bool, bool)> {
        let at = now();
        let topic = card.topic();
        let since = at - QUIET_AFTER_CLOSE;
        let closed = |c: &Card| c.topic() == topic && c.answer.as_ref().is_some_and(|a| a.how == AnswerHow::Withdrawn && a.at > since);
        let reclosed = match &topic {
            Some(t) => self.db().withdrew_since(&who.id, t, since)? || lock(&self.0.active).values().any(|a| a.employee_id == who.id && a.cards.iter().any(closed)),
            None => false,
        };
        let live = {
            let db = self.db();
            let root = db.run(run_id)?.and_then(|r| r.run.conversation_root().map(String::from));
            match root.map(|id| db.run(&id)).transpose()?.flatten() {
                Some(root) => root.run.replied_at.into_iter().chain([root.run.created_at]).max().is_some_and(|t| at - t < LIVE),
                None => false,
            }
        };
        let message = card.message.clone();
        let first = self.raise_card(run_id, card)?;
        let notified = first && !edit && !reclosed && !live;
        if notified {
            self.sink().notify(&format!("{} needs you", who.name), &message);
        }
        Ok((first, notified))
    }

    /// The caller's own cards about `topic` still waiting on you (`Card::waiting`), oldest first: on their runs that
    /// finished (or went back to the queue) and on those still working, this one included.
    fn own_pending(&self, caller: &Employee, topic: &str) -> Result<Vec<Card>> {
        let about = |c: &Card| c.waiting() && c.topic().as_deref() == Some(topic);
        let mut out: Vec<Card> = self.db().open_topic_runs(topic)?.into_iter().filter(|r| r.employee_id == caller.id).flat_map(|r| r.cards).filter(about).collect();
        out.extend(lock(&self.0.active).values().filter(|a| a.employee_id == caller.id).flat_map(|a| a.cards.iter().filter(|c| about(c)).cloned()));
        Ok(out)
    }

    /// Puts `card` on a run: a live run carries it until it ends, a finished one shows it in the Inbox again. A
    /// card about the same thing as one the run already has replaces it. Returns whether nobody else is waiting
    /// on the same thing, so this is the first time you are asked. No desktop notification.
    fn raise_card(&self, run_id: &str, card: Card) -> Result<bool> {
        let topic = card.topic();
        let same = |c: &Card| c.waiting() && topic.is_some() && c.topic() == topic;
        let waiting = match &topic {
            Some(t) => self.db().open_topic_runs(t)?.iter().any(|r| r.id != run_id),
            None => false,
        };
        let asking = lock(&self.0.active).iter().any(|(id, a)| id != run_id && a.cards.iter().any(&same));
        let first = !waiting && !asking;
        let put = |cards: &mut Vec<Card>, needs_you: &mut Vec<String>| -> Result<()> {
            if let Some(old) = cards.iter_mut().find(|c| same(c)) {
                needs_you.retain(|m| *m != old.message);
                *old = card.clone();
            } else if cards.iter().filter(|c| c.pending()).count() >= CARDS_PER_RUN {
                return Err(AppError::conflict(format!("This run already has {CARDS_PER_RUN} cards waiting. Put the rest in your report.")));
            } else {
                cards.push(card.clone());
            }
            needs_you.push(card.message.clone());
            Ok(())
        };
        {
            let mut active = lock(&self.0.active);
            if let Some(a) = active.get_mut(run_id) {
                let (mut cards, mut needs_you) = (std::mem::take(&mut a.cards), std::mem::take(&mut a.needs_you));
                let done = put(&mut cards, &mut needs_you);
                (a.cards, a.needs_you) = (cards, needs_you);
                return done.map(|_| first);
            }
        }
        let run = {
            let db = self.db();
            let mut run = db.run(run_id)?.ok_or_else(|| AppError::not_found("run not found"))?.run;
            if !run.state.is_finished() {
                return Err(AppError::conflict("that run has not finished yet"));
            }
            put(&mut run.cards, &mut run.needs_you)?;
            run.archived_at = None;
            db.save_run(&run)?;
            run
        };
        self.sink().run_updated(&run);
        Ok(first)
    }

    /// Asks you on a run to reconnect Claude in Chrome, with `why` under it. Only the first run to ask for it
    /// sends a desktop notification; the rest wait on the same Done.
    pub(super) fn raise_chrome_chore(&self, run_id: &str, why: &str) -> Result<()> {
        const MESSAGE: &str = "Reconnect Claude in Chrome";
        let name = {
            let db = self.db();
            let run = db.run(run_id)?.map(|r| r.run);
            run.and_then(|r| db.employee(&r.employee_id).ok().flatten()).map(|e| e.name).unwrap_or_default()
        };
        let chore = CardAsk::Chore { subject: cards::CHROME.into(), url: None };
        if self.raise_card(run_id, Card::new(MESSAGE, Some(why.to_string()), None, chore))? {
            self.sink().notify(&format!("{name} needs you"), MESSAGE);
        }
        Ok(())
    }

    /// Closes the caller's cards about `key` still waiting on you (`Card::waiting`), ones put off with Later too: it was
    /// settled without you, so they never come back. Rows left with nothing open leave your Inbox, news you have not
    /// seen aside.
    pub fn close_ask_tool(&self, caller: &Employee, key: &str, reason: &str) -> Result<Value> {
        let topic = cards::ask_key(key)?;
        let answer = CardAnswer { at: now(), how: AnswerHow::Withdrawn, text: claude::clip(&claude::one_line(reason), 300), held: false };
        let about = |c: &Card| c.waiting() && c.topic().as_deref() == Some(topic.as_str());
        let close = |c: &mut Card| {
            c.answer = Some(answer.clone());
            (c.back_at, c.parked) = (None, false);
        };
        let mut closed = 0;
        let (runs, said) = {
            let db = self.db();
            let mut runs: Vec<Run> = db.open_topic_runs(&topic)?.into_iter().filter(|r| r.employee_id == caller.id).collect();
            for r in db.parked_runs()? {
                if r.employee_id == caller.id && r.cards.iter().any(about) && !runs.iter().any(|x| x.id == r.id) {
                    runs.push(r);
                }
            }
            let mut said = vec![];
            db.tx(|| {
                for r in &mut runs {
                    for c in r.cards.iter_mut().filter(|c| about(c)) {
                        close(c);
                        closed += 1;
                    }
                    said.push(super::inbox::take_held(r));
                    db.save_run(r)?;
                }
                Ok(())
            })?;
            (runs, said)
        };
        for a in lock(&self.0.active).values_mut().filter(|a| a.employee_id == caller.id) {
            for c in a.cards.iter_mut().filter(|c| about(c)) {
                close(c);
                closed += 1;
            }
        }
        // A run left with nothing open hears the answers you gave its other cards, as a tap would have sent them.
        let (sends, runs): (Vec<_>, Vec<_>) = runs.into_iter().zip(said).partition(|(_, s)| s.is_some());
        self.send_card_answers(&sends);
        for (r, _) in &runs {
            self.sink().run_updated(r);
            if r.state.is_finished() {
                // As a tap files it, so news nobody has seen keeps its row.
                match self.archive_row(&r.id, true, true) {
                    Err(e) if e.code != crate::error::ErrorCode::Conflict => log!("archiving run {} after closing its card failed: {e}", r.id),
                    _ => {}
                }
            }
        }
        if closed == 0 {
            let open: Vec<String> = self.db().open_cards(&caller.id)?.iter().flat_map(|r| r.cards.iter().filter(|c| c.pending()).filter_map(|c| c.key.clone())).collect();
            let open: Vec<&str> = open.iter().map(|k| cards::key_label(k)).collect();
            let list = if open.is_empty() { "none".to_string() } else { open.join(", ") };
            return Err(AppError::invalid(format!("You have no open card about '{key}'. Your open cards: {list}.")));
        }
        Ok(json!({ "closed": closed }))
    }

    /// Records the number the caller's weekly review measured, for your team's scoreboard. Only in a weekly review.
    pub fn report_number_tool(&self, caller_run: &str, args: &Value) -> Result<Value> {
        let text = |k: &str, max: usize| -> Result<String> {
            let v = args.get(k).and_then(Value::as_str).map(str::trim).unwrap_or("");
            if v.chars().count() > max {
                return Err(AppError::invalid(format!("{k} is at most {max} characters.")));
            }
            Ok(claude::one_line(v))
        };
        let score = Score { metric: text("metric", 40)?, value: text("value", 20)?, change: text("change", 30)?, note: text("note", 100)? };
        if score.metric.is_empty() || score.value.is_empty() {
            return Err(AppError::invalid("Give the metric and its value, e.g. metric 'Open support tickets', value '0'."));
        }
        let review = self.db().run(caller_run)?.is_some_and(|r| matches!(r.run.kind, RunKind::Scheduled { review: true, .. }));
        if !review {
            return Err(AppError::invalid("report_number is for your weekly review."));
        }
        let mut active = lock(&self.0.active);
        let a = active.get_mut(caller_run).ok_or_else(|| AppError::invalid("this run has ended"))?;
        a.score = Some(score);
        Ok(json!({ "recorded": true }))
    }

    /// Your Claude Code skill catalog, for choosing the skills a proposed hire needs.
    pub fn catalog_tool(&self) -> Result<Value> {
        let skills: Vec<Value> = self
            .skill_catalog()
            .iter()
            .map(|s| json!({ "name": s.name, "description": claude::clip(&s.description, 300), "source": s.source, "skills": s.skills }))
            .collect();
        Ok(json!({ "skills": skills }))
    }

    /// Records a hire the caller proposes. The hire reports to the caller unless they name one of
    /// their direct reports; skills are matched against your catalog by name.
    pub fn propose_hire_tool(&self, caller_run: &str, caller: &Employee, args: &Value) -> Result<Value> {
        let s = |k: &str| args.get(k).and_then(|v| v.as_str()).map(str::trim).unwrap_or("").to_string();
        let (name, title, reason) = (s("name"), s("title"), s("reason"));
        if title.is_empty() {
            return Err(AppError::invalid("title is required: the role you want hired"));
        }
        if name.is_empty() {
            return Err(AppError::invalid("name is required: suggest a first name for the new hire"));
        }
        if reason.is_empty() {
            return Err(AppError::invalid("reason is required: the gap this hire fills and what they would own"));
        }
        let asked: Vec<String> = args
            .get("skills")
            .and_then(|v| v.as_array())
            .map(|a| a.iter().filter_map(|x| x.as_str()).map(|x| x.trim().to_string()).filter(|x| !x.is_empty()).collect())
            .unwrap_or_default();
        let catalog = self.skill_catalog();
        let (mut keys, mut missing) = (vec![], vec![]);
        for n in &asked {
            match catalog.iter().find(|c| c.name.eq_ignore_ascii_case(n) || c.id.eq_ignore_ascii_case(n)) {
                Some(c) if !keys.contains(&c.id) => keys.push(c.id.clone()),
                Some(_) => {}
                None => missing.push(n.clone()),
            }
        }
        let (proposal, lane, ceo) = {
            let db = self.db();
            let to = s("reportsTo");
            let manager_id = if to.is_empty() || find_member(std::slice::from_ref(caller), &to, |e| (&e.id, Some(&e.slug), &e.name)).is_some() {
                caller.id.clone()
            } else {
                let reports: Vec<Employee> = db.employees()?.into_iter().filter(|e| e.manager_id.as_deref() == Some(&caller.id)).collect();
                find_member(&reports, &to, |e| (&e.id, Some(&e.slug), &e.name)).map(|e| e.id.clone()).ok_or_else(|| {
                    AppError::invalid(format!("'{to}' is neither you nor one of your direct reports. Leave reportsTo out and the hire reports to you."))
                })?
            };
            if let Some(dup) = db.proposals(Some(&caller.id), Some(ProposalState::Open))?.into_iter().find(|p| p.draft.title.eq_ignore_ascii_case(&title)) {
                return Err(AppError::conflict(format!(
                    "You already proposed a {} (proposal `{}`) and it is waiting on a decision. To change it, withdraw_proposal it and propose again.",
                    dup.draft.title, dup.id
                )));
            }
            let hue = hue_from_name(&name);
            let p = HireProposal {
                id: uuid::Uuid::new_v4().to_string(),
                employee_id: caller.id.clone(),
                run_id: Some(caller_run.to_string()),
                reason,
                draft: EmployeeDraft {
                    name,
                    title,
                    description: s("description"),
                    objective: s("objective"),
                    manager_id: Some(manager_id),
                    skills: SkillGrant { builtins: false, keys },
                    clearance: Clearance::Supervised,
                    allow_rules: vec![],
                    model: None,
                    effort: None,
                    browser: false,
                    auto_tidy: true,
                    workspaces: vec![],
                    hue,
                    image: None,
                },
                missing_skills: missing,
                state: ProposalState::Open,
                note: None,
                hired_id: None,
                created_at: now(),
                resolved_at: None,
            };
            db.save_proposal(&p)?;
            let lane = db.run(caller_run)?.map(|r| r.run.kind.lane());
            (p, lane, ceo_of(&db)?)
        };
        let d = &proposal.draft;
        self.append_event(caller_run, RunEvent::ProposedHire { proposal_id: proposal.id.clone(), name: d.name.clone(), title: d.title.clone() });
        self.sink().proposal_updated(&proposal);
        if lane != Some(Lane::Chat) {
            self.sink().notify(&format!("{} proposes a hire", caller.name), &format!("{}, {}", d.name, d.title));
        }
        let mut note = format!(
            "Recorded. {ceo} reviews it in their Inbox, may change it, and approves or declines it. Their decision comes back to \
you as a new run. Never create the hire any other way."
        );
        if !proposal.missing_skills.is_empty() {
            note += &format!(
                " Not in the catalog, so not granted: {}. Say what the hire needs them for; {ceo} can install them.",
                proposal.missing_skills.join(", ")
            );
        }
        Ok(json!({ "proposal": proposal, "note": note }))
    }

    pub fn my_proposals(&self, caller: &Employee) -> Result<Value> {
        let v = self.db().proposals(Some(&caller.id), None)?;
        Ok(json!({ "proposals": v.into_iter().take(20).collect::<Vec<_>>() }))
    }

    pub fn withdraw_proposal_tool(&self, caller: &Employee, id: &str) -> Result<Value> {
        let p = {
            let db = self.db();
            let mut p = match db.proposal(id)? {
                Some(p) if p.employee_id == caller.id => p,
                _ => return Err(AppError::not_found(format!("'{id}' is not one of your proposals. Call my_proposals() for the list."))),
            };
            if p.state != ProposalState::Open {
                return Err(AppError::conflict(format!("that proposal is already {}", p.state.as_str())));
            }
            p.state = ProposalState::Withdrawn;
            p.resolved_at = Some(now());
            db.save_proposal(&p)?;
            p
        };
        self.sink().proposal_updated(&p);
        Ok(json!({ "withdrawn": p.id }))
    }

    /// Names the thread the calling run is in (`Run::title`, on its first run): the conversation, or the report and
    /// the replies on it. When that first run is the caller, its end saves the name again, so it keeps it.
    pub fn name_thread_tool(&self, caller_run: &str, title: &str) -> Result<Value> {
        let title = claude::one_line(title);
        if title.is_empty() {
            return Err(AppError::invalid("Give the thread a name of a few words, e.g. 'Spring sale emails'."));
        }
        if title.chars().count() > TITLE_CHARS {
            return Err(AppError::invalid(format!("title is at most {TITLE_CHARS} characters.")));
        }
        let root = {
            let db = self.db();
            let mut root = Self::thread_in(&db, caller_run)?.root;
            root.title = Some(title.clone());
            db.save_run(&root)?;
            root
        };
        if let Some(a) = lock(&self.0.active).get_mut(&root.id) {
            a.title = Some(title.clone());
        }
        self.sink().run_updated(&root);
        Ok(json!({ "named": title }))
    }

    /// Opens a file, a folder or a page on your screen for the caller (`open_target` says what they may open), and
    /// says whether it worked. Only in a conversation you are in (`skills::ceo_present`): from a run nobody watches,
    /// a tab or a window would appear out of nowhere.
    pub fn open_tool(&self, caller_run: &str, caller: &Employee, target: &str) -> Result<Value> {
        let ceo = {
            let db = self.db();
            let ceo = ceo_of(&db)?;
            if !db.run(caller_run)?.is_some_and(|r| skills::ceo_present(&r.run)) {
                return Err(AppError::invalid(format!(
                    "{ceo} is not in this run, so nothing opens on their screen. Put the link on your card instead: a sign-in page goes in the chore's url."
                )));
            }
            ceo
        };
        let target = open_target(&self.employee_dir(&caller.id), &caller.workspaces, target.trim())?;
        if let Err(e) = self.sink().open(&target) {
            return Err(AppError::internal(format!("It did not open: {e}. Tell {ceo} where it is instead.")));
        }
        Ok(json!({ "opened": true, "note": format!("It is open on {ceo}'s screen.") }))
    }
}

/// Where the file a card shows is, as a full path (`in_folders`). It must be plain text of at most `cards::FILE_BYTES`,
/// so the card can show it.
pub(super) fn card_file_path(employee_dir: &Path, workspaces: &[String], raw: &str) -> Result<PathBuf> {
    let path = in_folders(employee_dir, workspaces, raw)?;
    let len = fs::metadata(&path)?.len();
    if len > cards::FILE_BYTES {
        return Err(AppError::invalid(format!(
            "'{raw}' is {} KB, and a card shows files up to {} KB. Point at a shorter file, or leave file out.",
            len.div_ceil(1024),
            cards::FILE_BYTES / 1024
        )));
    }
    if fs::read_to_string(&path).is_err() {
        return Err(AppError::invalid(format!("'{raw}' is not plain text, so the card cannot show it.")));
    }
    Ok(path)
}

/// What `open` opens: an https link as it is, or a path (full, or from the employee's folder as their runs see it),
/// resolved, in one of their workspaces or the folder that holds the company page, which holds every employee's
/// folder too. Links are followed first, so one cannot lead anywhere else.
fn open_target(employee_dir: &Path, workspaces: &[String], raw: &str) -> Result<String> {
    if raw.starts_with("https://") {
        return Ok(raw.to_string());
    }
    if raw.is_empty() {
        return Err(AppError::invalid("Pass the full path of what to open, or an https link."));
    }
    let path = fs::canonicalize(employee_dir.join(raw))
        .map_err(|_| AppError::invalid(format!("Nothing is at '{raw}'. Pass a full path, or an https link.")))?;
    let company = employee_dir.parent().unwrap_or(employee_dir);
    let mut roots = std::iter::once(company.to_path_buf()).chain(workspaces.iter().map(|w| employee_dir.join(w))).filter_map(|r| fs::canonicalize(r).ok());
    if !roots.any(|r| path.starts_with(r)) {
        return Err(AppError::invalid("You can open what is in your folder, one of your workspaces or the company page's folder, or an https link."));
    }
    Ok(path.to_string_lossy().into_owned())
}

/// Where an image a card shows is, as a full path (`in_folders`): a png, jpg, gif or webp file.
pub(super) fn card_image_path(employee_dir: &Path, workspaces: &[String], raw: &str) -> Result<PathBuf> {
    let path = in_folders(employee_dir, workspaces, raw)?;
    if image_mime(&path).is_none() {
        return Err(AppError::invalid(format!("'{raw}' is not a png, jpg, gif or webp file, so the card cannot show it.")));
    }
    Ok(path)
}

/// A file a card shows, as a full path: `raw` is full, or from the employee's folder as their runs see it. Links are
/// followed first, so one cannot lead out of their folder and workspaces.
fn in_folders(employee_dir: &Path, workspaces: &[String], raw: &str) -> Result<PathBuf> {
    let path = fs::canonicalize(employee_dir.join(raw))
        .ok()
        .filter(|p| p.is_file())
        .ok_or_else(|| AppError::invalid(format!("No file at '{raw}'. Pass the path of the file you wrote, e.g. 'workspace/drafts/reply.md'.")))?;
    let mut roots = std::iter::once(employee_dir.to_path_buf()).chain(workspaces.iter().map(|w| employee_dir.join(w))).filter_map(|r| fs::canonicalize(r).ok());
    if !roots.any(|r| path.starts_with(r)) {
        return Err(AppError::invalid("file must be in your folder or one of your workspaces."));
    }
    Ok(path)
}

/// The note `delegate` and `ask_colleague` return: the hand-off comes back either way, so wait only for a quick
/// one. `ahead`: the runs ahead of it while its colleague is busy (`queue_ahead`). `conversation`: it was handed
/// over in a conversation you started, so it comes back there. `held`: a report held for your next run (`hold`).
fn handoff_note(name: &str, what: &str, ahead: usize, conversation: bool, held: bool) -> String {
    let wait = match ahead {
        0 => String::new(),
        1 => format!("{name} is busy with other work: 1 run is ahead of this one, so this starts when that finishes. "),
        n => format!("{name} is busy with other work: {n} runs are ahead of this one, so this starts when those finish. "),
    };
    let back = if held {
        format!(
            "Omega Star keeps it for your next run, or brings it with any other reports from your team in one run once {} minutes pass without a new one",
            HOLD.num_minutes()
        )
    } else if conversation {
        "Omega Star starts a new run for you when it arrives, as your next turn in this conversation".to_string()
    } else {
        "Omega Star starts a new run for you when it arrives".to_string()
    };
    format!(
        "{wait}{what} comes back to you either way. Wait for it with await_reports only if it should take a few minutes and you need it \
before you finish. Otherwise finish now: {back}."
    )
}

/// The note a hand-off the loop guard paused returns, in words that blame nobody: Omega Star paused it, not the colleague.
fn paused_note(name: &str, what: &str, at: Ts) -> String {
    format!(
        "Omega Star paused this hand-off to keep the chain short. It goes to {name} by itself at {}, and {} comes back to you as usual. \
Do not send it again or set a check for it: finish now.",
        at.with_timezone(&Local).format("%-I:%M %P"),
        what.to_lowercase()
    )
}

/// The runs up the chain of hand-offs from `run_id`, itself first, as far as the run a person or a schedule
/// started, and the chain a hand-off from it joins (`Run::chain`): the nearest one stored on the way, else that run.
fn chain_up(db: &Store, run_id: &str) -> Result<(Vec<Run>, String)> {
    let (mut up, mut chain): (Vec<Run>, Option<String>) = (vec![], None);
    let mut cur = db.run(run_id)?.map(|d| d.run);
    while let Some(r) = cur {
        if chain.is_none() {
            chain = r.chain.clone().or_else(|| r.upstream().is_none().then(|| r.id.clone()));
        }
        cur = match r.upstream() {
            Some(p) if up.len() < CHAIN_HOPS => db.run(p)?.map(|d| d.run),
            _ => None,
        };
        up.push(r);
    }
    let chain = chain.or_else(|| up.last().map(|r| r.id.clone())).unwrap_or_else(|| run_id.to_string());
    Ok((up, chain))
}

/// `employee_id` is still at work further up the chain `up`, waiting on its end: a hand-off to them would wait on itself.
fn waiting_up(up: &[Run], employee_id: &str) -> bool {
    up.iter().any(|r| !r.state.is_finished() && r.employee_id == employee_id)
}

/// The loop guard on a new hand-off `run` from `from` to `to` in the chain `chain`: it joins the chain, unless it is an
/// ask and the chain already holds PAIR_HANDOFFS asks between the same two employees within PAIR_WINDOW, or the chain
/// holds CHAIN_HANDOFFS hand-offs in all. Then it waits PAUSE and starts a chain of its own. An ask is refused, in words
/// that blame nobody, once PAUSES_PER_DAY asks between the two were paused today.
fn guard(db: &Store, run: &mut Run, chain: String, from: &Employee, to: &Employee) -> Result<()> {
    let ask = matches!(run.kind, RunKind::Asked { .. });
    if ask && db.paused_asks(&from.id, &to.id, day_start(run.created_at))? >= PAUSES_PER_DAY {
        return Err(AppError::invalid(format!(
            "Omega Star stopped this hand-off: {} and {} have passed this back and forth all day. Finish with what you have and say in your report what is still open.",
            from.name, to.name
        )));
    }
    let handoffs = db.chain_handoffs(&chain)?;
    let since = run.created_at - PAIR_WINDOW;
    let between = |a: &String, b: &String| (*a == from.id && *b == to.id) || (*a == to.id && *b == from.id);
    let pair = handoffs.iter().filter(|(a, b, at, delegated)| ask && !delegated && *at > since && between(a, b)).count();
    if pair < PAIR_HANDOFFS && handoffs.len() < CHAIN_HANDOFFS {
        run.chain = Some(chain);
    } else {
        run.chain = Some(run.id.clone());
        run.not_before = Some(run.created_at + PAUSE);
    }
    Ok(())
}

/// How many runs are ahead of `of` while its employee is busy: their background work running, and queued before
/// it and due. 0 when it starts without waiting: a question or an answer, which runs beside other work, or work
/// that finds one of its employee's lanes free (`runs::cap`).
fn queue_ahead(db: &Store, of: &Run, at: Ts) -> Result<usize> {
    if !runs::takes_a_lane(&of.kind) {
        return Ok(0);
    }
    let lanes = runs::cap(db)?;
    let work: Vec<Run> = db.active_runs_of(&of.employee_id)?.into_iter().filter(|r| r.id != of.id && runs::takes_a_lane(&r.kind)).collect();
    let ahead = work.iter().filter(|r| r.state == RunState::Running || (r.created_at <= of.created_at && r.not_before.is_none_or(|t| t <= at))).count();
    Ok(if ahead < lanes { 0 } else { ahead })
}

/// A queued run that never started, so what it was asked can still change.
fn untouched(r: &Run) -> bool {
    r.state == RunState::Queued && r.restarts == 0 && r.limit_retries == 0
}

/// The colleague `to` names: by id, slug or name, or by a first name only one of them has.
fn colleague_in(others: &[Employee], to: &str) -> Result<Employee> {
    let key = to.trim().to_lowercase();
    let by_first: Vec<&Employee> = others.iter().filter(|e| e.name.split_whitespace().next().map(str::to_lowercase) == Some(key.clone())).collect();
    find_member(others, to, |e| (&e.id, Some(&e.slug), &e.name))
        .or(if by_first.len() == 1 { Some(by_first[0]) } else { None })
        .cloned()
        .ok_or_else(|| AppError::invalid(format!("'{to}' is not a colleague. Call colleagues() for the list.")))
}

/// An employee's name, for a hand-off they may have left since.
fn colleague_name(db: &Store, id: &str) -> Result<String> {
    Ok(db.employee(id)?.map(|e| e.name).unwrap_or_else(|| "A former colleague".into()))
}

/// The start of the day `t` falls in, on your local calendar.
fn day_start(t: Ts) -> Ts {
    let midnight = t.with_timezone(&Local).date_naive().and_time(chrono::NaiveTime::MIN);
    midnight.and_local_timezone(Local).earliest().map(|d| d.with_timezone(&Utc)).unwrap_or(t - chrono::Duration::days(1))
}

/// The employee's own work, which takes in the reports held for them: not a conversation with you, a tidy, or a
/// hand-off from someone else, which each do only what they were asked.
fn own_work(kind: &RunKind) -> bool {
    !kind.is_conversation() && !matches!(kind, RunKind::Tidy { .. } | RunKind::Asked { .. } | RunKind::Delegated { .. })
}

/// What came in for the employee since their last run, for this run's opening note: news from colleagues, now
/// read in this run (`News::read_in`); when the run is their own work (`own_work`), the reports held for them, which
/// it brings in place of their queued run (`Run::noted_in`); and their cards a newer card replaced. A tidy takes in
/// none of it.
pub(super) fn catch_up(db: &Store, employees: &[Employee], run: &Run, o: &mut claude::Opening) -> Result<()> {
    if matches!(run.kind, RunKind::Tidy { .. }) {
        return Ok(());
    }
    let name = |id: &str| employees.iter().find(|e| e.id == id).map(|e| e.name.clone()).unwrap_or_else(|| "A former colleague".into());
    db.tx(|| {
        for mut n in db.unread_news(&run.employee_id)? {
            o.news.push((n.created_at, name(&n.from), n.text.clone()));
            n.read_at = Some(o.now);
            n.read_in = Some(run.id.clone());
            db.save_news(&n)?;
        }
        let batch = db.active_runs_of(&run.employee_id)?.into_iter().find(|r| r.id != run.id && untouched(r) && !r.reports.is_empty());
        if let Some(batch) = batch.filter(|_| own_work(&run.kind)) {
            for id in &batch.reports {
                let Some(mut h) = db.run(id)?.map(|r| r.run) else { continue };
                o.held.push((name(&h.employee_id), h.prompt.clone(), report_of(&h)));
                h.noted_in = Some(run.id.clone());
                db.save_run(&h)?;
            }
            db.delete_queued_run(&batch.id)?;
        }
        // Since their last run with a note started: it was told of anything replaced before then.
        let last = db
            .work_runs(&run.employee_id, 50)?
            .into_iter()
            .filter(|r| r.id != run.id && !matches!(r.kind, RunKind::Tidy { .. } | RunKind::ReplyCheck { .. } | RunKind::Nudge { .. } | RunKind::Organize { .. }))
            .filter_map(|r| r.started_at)
            .max();
        if let Some(since) = last {
            o.replaced = db.replaced_cards(&run.employee_id, since)?;
        }
        Ok(())
    })
}

/// The answers and reports `ended` lets through: its finished Asked and Delegated children, and itself
/// when it was one, whose asker's run has finished too, each with the session it runs in. Each is
/// stamped delivered as it is found, so a second call finds nothing; a direct report's finished task is held
/// for its manager instead (`hold`). When `ended` failed or was lost, an answer it brought goes again
/// (`redeliver`); when it failed, was lost or you stopped it, the reports its opening note brought are held again.
pub(super) fn due_answers(db: &Store, ended: &Run) -> Result<Vec<(Run, String)>> {
    let ceo = ceo_of(db)?;
    let at = now();
    let mut ids: Vec<String> = db.children(&ended.id)?.into_iter().map(|r| r.id).collect();
    if ended.parent_run_id().is_some() {
        ids.push(ended.id.clone());
    }
    let mut due = vec![];
    // Your answer on the card of a colleague's ask or delegated work let them carry on: what came of it goes
    // to whoever handed it over, who already had their first report. Not when you stopped the reply.
    if let Some(RunKind::Reply { card: true, to_run_id, .. }) = (ended.state != RunState::Cancelled).then_some(&ended.kind) {
        if let Some(root) = db.run(to_run_id)?.map(|r| r.run).filter(|r| r.state.is_finished()) {
            let parent = match root.parent_run_id() {
                Some(p) => db.run(p)?.filter(|p| p.run.state.is_finished()),
                None => None,
            };
            if let Some(parent) = parent {
                let from = colleague_name(db, &root.employee_id)?;
                let answer = root.cards.iter().rev().find_map(|c| c.answer.as_ref()).map(|a| format!(" ({})", a.text)).unwrap_or_default();
                let note = format!("{ceo} answered {from}'s card{answer} and {from} carried on.");
                if let Some(d) = answered_run(db, &ceo, &root, &parent, &report_of(ended), Some(&note))? {
                    due.push(d);
                }
            }
        }
    }
    for id in ids {
        let Some(mut c) = db.run(&id)?.map(|d| d.run) else { continue };
        let Some(parent_run_id) = c.parent_run_id().map(String::from) else { continue };
        if c.delivered_at.is_some() || !c.state.is_finished() {
            continue;
        }
        let Some(parent) = db.run(&parent_run_id)? else { continue };
        if !parent.run.state.is_finished() {
            continue; // still working: it collects with await_reports, or gets it when it ends
        }
        c.delivered_at = Some(at);
        db.save_run(&c)?;
        if c.state == RunState::Cancelled {
            continue; // you stopped it
        }
        if held(db, &c, &parent)? {
            hold(db, &ceo, &c, &parent, at)?;
        } else if let Some(d) = answered_run(db, &ceo, &c, &parent, &report_of(&c), None)? {
            due.push(d);
        }
    }
    due.extend(redeliver(db, ended, at)?);
    // Taken in by a run that did not finish, they would reach nobody: the manager's next run brings them after all.
    if matches!(ended.state, RunState::Failed | RunState::Lost | RunState::Cancelled) {
        for mut r in db.noted_in(&ended.id)? {
            r.noted_in = None;
            db.save_run(&r)?;
            if let Some(parent) = r.parent_run_id().map(|p| db.run(p)).transpose()?.flatten() {
                hold(db, &ceo, &r, &parent, at)?;
            }
        }
    }
    Ok(due)
}

/// Whether a finished hand-off waits for its asker (`hold`) rather than coming back at once: a direct report's
/// task, handed over outside any conversation you started. Questions and tasks between colleagues come back at once.
fn held(db: &Store, handed: &Run, parent: &RunRecord) -> Result<bool> {
    Ok(matches!(handed.kind, RunKind::Delegated { .. }) && parent.run.kind.lane() == Lane::Work && super::conversation_of(db, &parent.run)?.is_none())
}

/// Holds a direct report's finished task for its manager, in the one queued run that brings them every report
/// held for them (`Run::reports`). It starts once HOLD passes without another, or HOLD_MAX after the first, so a
/// steady trickle never holds them for good, unless a run of the manager's own work takes them in first
/// (`catch_up`). Written here, under the lock that looks for it, so reports that come back together share one run.
fn hold(db: &Store, ceo: &str, handed: &Run, parent: &RunRecord, at: Ts) -> Result<()> {
    let manager = &parent.run.employee_id;
    if db.employee(manager)?.is_none() {
        return Ok(());
    }
    let (mut run, session, new) = match db.active_runs_of(manager)?.into_iter().find(|r| untouched(r) && !r.reports.is_empty()) {
        Some(b) => {
            let session = db.run(&b.id)?.map(|r| r.session).unwrap_or_else(|| b.id.clone());
            (b, session, false)
        }
        None => {
            let kind = RunKind::Answered { asked_run_id: handed.id.clone(), from: handed.employee_id.clone(), task: true, chat: false, thread: None };
            let mut run = Run::new(manager, kind, String::new(), at);
            run.omega_wrote = true;
            let session = answer_session(db, parent, at)?.0.unwrap_or_else(|| run.id.clone());
            (run, session, true)
        }
    };
    run.reports.push(handed.id.clone());
    run.not_before = Some((at + HOLD).min(run.created_at + HOLD_MAX));
    run.prompt = held_prompt(db, ceo, &run.reports, &session)?;
    if new {
        db.insert_run(&run, &session)?;
    } else {
        db.save_run(&run)?;
    }
    Ok(())
}

/// What the run bringing held reports says: each as a returned report says it, quoting where its manager's run
/// started unless this run resumes that run's session, and how many there are when there are several.
fn held_prompt(db: &Store, ceo: &str, reports: &[String], session: &str) -> Result<String> {
    let resumes = db.session_started(session)?;
    let (mut parts, mut quoted) = (vec![], HashSet::new());
    for id in reports {
        let Some(h) = db.run(id)?.map(|r| r.run) else { continue };
        let Some(parent) = h.parent_run_id().map(|p| db.run(p)).transpose()?.flatten() else { continue };
        let quote = !(resumes && parent.session == session) && quoted.insert(parent.run.id.clone());
        parts.push(answer_text(ceo, &colleague_name(db, &h.employee_id)?, &h, &parent.run, quote, &report_of(&h), None));
    }
    Ok(match parts.len() {
        1 => parts.remove(0),
        n => format!("{n} reports from your team came back after your run had ended.\n\n{}", parts.join("\n\n---\n\n")),
    })
}

/// An answer whose run failed or was lost, queued again after REDELIVER_AFTER as a new answered run for the same
/// ask, up to REDELIVERIES more times; after that it stays failed where you can see it. None for anything else,
/// and when the asker has left.
fn redeliver(db: &Store, ended: &Run, at: Ts) -> Result<Option<(Run, String)>> {
    let failed = matches!(ended.state, RunState::Failed | RunState::Lost);
    if !failed || !matches!(ended.kind, RunKind::Answered { .. }) || ended.redelivered >= REDELIVERIES || db.employee(&ended.employee_id)?.is_none() {
        return Ok(None);
    }
    let Some(rec) = db.run(&ended.id)? else { return Ok(None) };
    let mut again = Run::new(&ended.employee_id, ended.kind.clone(), ended.prompt.clone(), at);
    again.omega_wrote = ended.omega_wrote;
    again.reports = ended.reports.clone();
    again.redelivered = ended.redelivered + 1;
    again.not_before = Some(at + REDELIVER_AFTER);
    Ok(Some((again, rec.session)))
}

/// What a finished run reports back: its summary, or why it did not finish.
fn report_of(r: &Run) -> String {
    match (r.state, r.summary.as_deref()) {
        (RunState::Succeeded, Some(s)) => s.to_string(),
        (RunState::Succeeded, None) => "(no report)".to_string(),
        (state, _) => format!("They did not finish ({}): {}", state.as_str(), r.error.as_deref().unwrap_or("no details")),
    }
}

/// Whether a hand-off was a task (delegated, or asked as one) rather than a question.
fn is_task(handed: &Run) -> bool {
    !matches!(handed.kind, RunKind::Asked { task: false, .. })
}

/// The run that brings `handed`'s answer or report (`report`) to whoever handed it over, from
/// `parent`, and the session it runs in. When the asker handed it over in a conversation you started, it is
/// that conversation's next turn, in the session the conversation continues in. An older build's chat message
/// counts as one, and so does an answer turn of its chat that asked on (`conversation_of`), as `adopt_chat_turns`
/// makes them, though the message's first answer gets a fresh session rather than the old chat's. Otherwise it
/// resumes the asking run's session while that is fresh enough (`answer_session`). It quotes where the asker's run
/// started only when it does not resume it.
/// None when the asker has left.
fn answered_run(db: &Store, ceo: &str, handed: &Run, parent: &RunRecord, report: &str, note: Option<&str>) -> Result<Option<(Run, String)>> {
    let Some(asker) = db.employee(&parent.run.employee_id)? else { return Ok(None) };
    let from = colleague_name(db, &handed.employee_id)?;
    let into = super::conversation_of(db, &parent.run)?.map(|root| Office::thread_in(db, &root)).transpose()?;
    let (session, resumes) = match &into {
        Some(t) if matches!(t.root.kind, RunKind::Chat) && t.replies.is_empty() => (None, false),
        Some(t) => {
            let (rec, resumes) = Office::next_turn(db, t)?;
            (resumes.then_some(rec.session), resumes)
        }
        None if parent.run.kind.lane() == Lane::Chat => (None, false),
        None => answer_session(db, parent, now())?,
    };
    let prompt = answer_text(ceo, &from, handed, &parent.run, !resumes, report, note);
    let thread = into.map(|t| t.root.id);
    let kind = RunKind::Answered { asked_run_id: handed.id.clone(), from: handed.employee_id.clone(), task: is_task(handed), chat: false, thread };
    let mut run = Run::new(&asker.id, kind, prompt, now());
    run.omega_wrote = true;
    let session = session.unwrap_or_else(|| run.id.clone());
    Ok(Some((run, session)))
}

/// The session an answer to `parent`, a run outside any conversation you started, runs in, and whether it resumes
/// it. The asker's session holds everything it knew, but once it began over a day ago or its context passed
/// FRESH_TOKENS, the answer starts a fresh one (None) rather than compact it again. A session that never started is
/// the answer's to start.
fn answer_session(db: &Store, parent: &RunRecord, at: Ts) -> Result<(Option<String>, bool)> {
    if !db.session_started(&parent.session)? {
        return Ok((Some(parent.session.clone()), false));
    }
    let (began, context) = db.session_size(&parent.session)?;
    if began.is_some_and(|t| at - t > chrono::Duration::days(1)) || context.is_some_and(|c| c > FRESH_TOKENS) {
        return Ok((None, false));
    }
    Ok((Some(parent.session.clone()), true))
}

/// The words that bring `handed`'s answer or report (`report`) from `from` to whoever handed it over in `parent`:
/// `note` when there is one, where `parent` had started when `quote` (the run does not resume it), the ask and the report.
fn answer_text(ceo: &str, from: &str, handed: &Run, parent: &Run, quote: bool, report: &str, note: Option<&str>) -> String {
    let (did, yours, theirs) =
        if is_task(handed) { ("finished the task you handed them", "Your task", "Their report") } else { ("answered your question", "Your question", "Their answer") };
    let mut prompt = format!("{from} {did}.");
    if let Some(n) = note {
        prompt += &format!("\n\n{n}");
    }
    if quote {
        let origin = if skills::ceo_in(&parent.kind) && !parent.omega_wrote {
            format!("You were talking with {ceo}, whose message was:")
        } else {
            "Your run had started from:".to_string()
        };
        prompt += &format!("\n\n{origin}\n\n{}", claude::clip(&parent.prompt, 2000));
    }
    prompt + &format!("\n\n{yours}:\n\n{}\n\n{theirs}:\n\n{}", handed.prompt, claude::clip(report, 20000))
}

/// Where a hand-off began, read from the store under its lock; `source_text` turns it into a note
/// from the transcripts once the lock is released.
pub(super) struct SourceChain {
    ceo: String,
    /// Whoever `from` belongs to, who sent the hand-off on.
    sender: String,
    /// The hand-off runs walked back through, nearest first, with their employees' names.
    handoffs: Vec<(Run, String)>,
    /// The first run that did not come from a hand-off, with its employee's name; None when it is gone.
    origin: Option<(Run, String)>,
    /// For a hire decision: your note on the proposal.
    note: Option<String>,
    /// For a follow-up: the person who replied.
    person: Option<String>,
}

/// Walks back from the run `from` (the upstream of a hand-off) to the run the work began in.
pub(super) fn source_chain(db: &Store, ceo: &str, from: &str) -> Result<SourceChain> {
    let mut chain = SourceChain { ceo: ceo.to_string(), sender: String::new(), handoffs: vec![], origin: None, note: None, person: None };
    let mut seen = HashSet::new();
    let mut next = Some(from.to_string());
    for _ in 0..SOURCE_HOPS {
        let Some(id) = next.take().filter(|id| seen.insert(id.clone())) else { break };
        let Some(rec) = db.run(&id)? else { break };
        let name = db.employee(&rec.run.employee_id)?.map(|e| e.name).unwrap_or_else(|| "a former colleague".into());
        if chain.sender.is_empty() {
            chain.sender = name.clone();
        }
        if let Some(up) = rec.run.upstream() {
            next = Some(up.to_string());
            chain.handoffs.push((rec.run, name));
            continue;
        }
        match &rec.run.kind {
            RunKind::HireDecided { proposal_id, .. } => chain.note = db.proposal(proposal_id)?.and_then(|p| p.note),
            RunKind::FollowUp { person_id, .. } => {
                chain.person = Some(db.person(person_id)?.map(|p| p.name).unwrap_or_else(|| "a former member".into()))
            }
            _ => {}
        }
        chain.origin = Some((rec.run, name));
        break;
    }
    if chain.sender.is_empty() {
        chain.sender = "the sender".into();
    }
    Ok(chain)
}

/// A note on where a hand-off began, quoting your own words where there are some, with what you
/// wrote into its runs on the way. Reads the runs' transcripts under `runs_dir`.
pub(super) fn source_text(chain: &SourceChain, runs_dir: &Path) -> String {
    let ceo = &chain.ceo;
    let steered = |id: &str| claude::steered(&fs::read_to_string(runs_dir.join(id).join(TRANSCRIPT)).unwrap_or_default());
    let quote = |s: &str| format!("> \"{}\"", claude::clip(&claude::one_line(s), 600));
    let missing = format!("Where this began is no longer on record, so treat it as {}'s own request.", chain.sender);
    let mut text = match &chain.origin {
        None => missing,
        Some((r, _)) if r.omega_wrote => format!(
            "This began with a message Omega Star wrote in the app from something {ceo} did there. It is not {ceo}'s own words, except where it quotes them:\n{}",
            quote(&r.prompt)
        ),
        Some((r, employee)) => match &r.kind {
            RunKind::Manual if r.prompt == DEFAULT_PROMPT => format!("This began when {ceo} started a run for {employee} from the app, with no instructions."),
            RunKind::Manual | RunKind::Chat | RunKind::Task { .. } | RunKind::Reply { .. } => {
                let words: Vec<String> = std::iter::once(r.prompt.clone()).chain(steered(&r.id)).collect();
                format!("This began with {ceo}'s own message to {employee}:\n{}", quote(&words.join(" ")))
            }
            RunKind::HireDecided { .. } => {
                let mut t = format!("This began with {ceo}'s decision on a hire {employee} proposed; Omega Star wrote the message.");
                if let Some(n) = &chain.note {
                    t += &format!(" {ceo}'s note: \"{}\"", claude::clip(&claude::one_line(n), 600));
                }
                t
            }
            RunKind::Scheduled { label, .. } => format!("This began with {employee}'s scheduled '{label}', not a message from {ceo}."),
            RunKind::FollowUp { .. } => format!(
                "This began with {}'s reply to a request from {employee}, not a message from {ceo}.",
                chain.person.as_deref().unwrap_or("a former member")
            ),
            RunKind::Tidy { .. } | RunKind::Organize { .. } | RunKind::ReplyCheck { .. } | RunKind::Nudge { .. } | RunKind::Unanswered { .. } => {
                format!("This began with {employee}'s {}, which Omega Star started, not a message from {ceo}.", claude::kind_label(&r.kind))
            }
            // A hand-off is never an origin: the walk goes on past it.
            RunKind::Delegated { .. } | RunKind::Asked { .. } | RunKind::Answered { .. } => missing,
        },
    };
    for (r, employee) in chain.handoffs.iter().rev() {
        let said = steered(&r.id);
        if !said.is_empty() {
            text += &format!("\n{ceo} also wrote into {employee}'s run on the way:");
            for s in said {
                text += &format!("\n{}", quote(&s));
            }
        }
    }
    text
}

/// The avatar hue the hire sheet derives from a name (`hueFromName` in lib/format.ts).
fn hue_from_name(name: &str) -> u16 {
    let n = name.trim().to_lowercase();
    if n.is_empty() {
        return 250;
    }
    n.encode_utf16().fold(0u32, |h, c| (h * 31 + c as u32) % 360) as u16
}

pub(super) fn parse_due(s: &str) -> Result<Ts> {
    if let Ok(t) = chrono::DateTime::parse_from_rfc3339(s) {
        return Ok(t.with_timezone(&Utc));
    }
    NaiveDate::parse_from_str(s, "%Y-%m-%d")
        .map(|d| d.and_hms_opt(12, 0, 0).unwrap().and_utc())
        .map_err(|_| AppError::invalid("dueAt must be an ISO date or date-time"))
}

/// The schedule tool's `effort`: a level, or 'default' (or nothing) to go back to the employee's own.
fn effort_arg(v: &str) -> Result<Option<Effort>> {
    match v.trim() {
        "" | "default" => Ok(None),
        v => serde_json::from_value(json!(v)).map(Some).map_err(|_| AppError::invalid("effort must be low, medium, high, xhigh or max")),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::fixtures::{self, NoSink};

    struct Office0 {
        dir: PathBuf,
        db: Store,
    }

    impl Drop for Office0 {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.dir);
        }
    }

    /// A temp store whose CEO is called Pat.
    fn office() -> Office0 {
        let dir = std::env::temp_dir().join(format!("omegastar-tools-{}", uuid::Uuid::new_v4()));
        fs::create_dir_all(dir.join("runs")).unwrap();
        let db = Store::open(&dir.join("office.db")).unwrap();
        db.set_company(&Company { name: "Acme".into(), ceo_name: "Pat".into(), ..Company::unset() }).unwrap();
        Office0 { dir, db }
    }

    /// An employee reporting to `manager_id`, or to you.
    fn employee(db: &Store, name: &str, manager_id: Option<&str>) -> Employee {
        let e = Employee { slug: name.to_lowercase(), name: name.into(), manager_id: manager_id.map(String::from), chat_session: format!("chat-{name}"), ..fixtures::employee() };
        db.save_employee(&e).unwrap();
        e
    }

    /// Saves a run of `e` in `state`, created `ago` minutes back, in `session` (its own id when None).
    fn run(db: &Store, e: &Employee, kind: RunKind, prompt: &str, state: RunState, ago: i64, session: Option<&str>) -> Run {
        let at = now() - chrono::Duration::minutes(ago);
        let mut r = Run::new(&e.id, kind, prompt.into(), at);
        r.state = state;
        if state.is_finished() {
            r.ended_at = Some(at);
            r.summary = (state == RunState::Succeeded).then(|| format!("{} did it.", e.name));
        }
        let session = session.map(String::from).unwrap_or_else(|| r.id.clone());
        assert!(db.insert_run(&r, &session).unwrap());
        r
    }

    fn delegated(parent: &Run) -> RunKind {
        RunKind::Delegated { parent_run_id: parent.id.clone() }
    }

    fn asked(parent: &Run, task: bool) -> RunKind {
        RunKind::Asked { parent_run_id: parent.id.clone(), asked_by: parent.employee_id.clone(), task }
    }

    fn delivered(db: &Store, r: &Run) -> bool {
        db.run(&r.id).unwrap().unwrap().run.delivered_at.is_some()
    }

    #[test]
    fn a_late_report_comes_home_once() {
        let o = office();
        let ada = employee(&o.db, "Ada", None);
        let bo = employee(&o.db, "Bo", Some(&ada.id));
        let parent = run(&o.db, &ada, RunKind::Manual, "Plan the launch.", RunState::Succeeded, 30, None);
        o.db.mark_inited(&parent.id).unwrap();
        let child = run(&o.db, &bo, asked(&parent, true), "Count the stock.", RunState::Succeeded, 20, None);

        let due = due_answers(&o.db, &child).unwrap();
        assert_eq!(due.len(), 1);
        let (a, session) = &due[0];
        assert_eq!(a.employee_id, ada.id);
        assert_eq!(a.kind, RunKind::Answered { asked_run_id: child.id.clone(), from: bo.id.clone(), task: true, chat: false, thread: None });
        assert_eq!(session, &parent.id, "it resumes the manager's session");
        assert!(a.omega_wrote);
        assert!(a.prompt.starts_with("Bo finished the task you handed them.\n\nYour task:\n\nCount the stock.\n\nTheir report:\n\nBo did it."), "{}", a.prompt);
        assert!(delivered(&o.db, &child));
        assert!(due_answers(&o.db, &child).unwrap().is_empty(), "delivered once");
        assert!(due_answers(&o.db, &parent).unwrap().is_empty());
    }

    #[tokio::test]
    async fn reports_come_home_when_a_run_is_lost_at_startup() {
        let o = office();
        let ada = employee(&o.db, "Ada", None);
        let bo = employee(&o.db, "Bo", Some(&ada.id));
        // Ada was waiting on Bo's report when the app quit; Bo's own hand-off to Cy was lost with it.
        let parent = run(&o.db, &ada, RunKind::Manual, "Plan the launch.", RunState::Running, 30, None);
        let child = run(&o.db, &bo, delegated(&parent), "Count the stock.", RunState::Succeeded, 20, None);
        let cy = employee(&o.db, "Cy", Some(&bo.id));
        let asker = run(&o.db, &bo, RunKind::Manual, "Price the stock.", RunState::Succeeded, 25, None);
        let lost = run(&o.db, &cy, delegated(&asker), "Check the prices.", RunState::Running, 20, None);
        // Both already went back to the queue as often as a run may, so this restart loses them.
        for mut r in [parent.clone(), lost.clone()] {
            r.restarts = RESTART_RETRIES;
            o.db.save_run(&r).unwrap();
        }

        let office = Office::open(o.dir.clone(), Arc::new(NoSink), Build::new("0.0.0".into())).await.unwrap();
        assert!(delivered(&o.db, &child), "the lost manager still gets the report that waited for it");
        assert!(delivered(&o.db, &lost), "the lost hand-off reports back to who handed it over");
        let answered: Vec<Run> = o.db.runs_in_state(RunState::Queued).unwrap();
        let to = |id: &str| answered.iter().find(|r| matches!(&r.kind, RunKind::Answered { asked_run_id, .. } if asked_run_id == id)).map(|r| r.employee_id.clone());
        assert_eq!(to(&child.id), Some(ada.id.clone()));
        assert_eq!(to(&lost.id), Some(bo.id.clone()));
        drop(office);
    }

    #[test]
    fn a_card_shows_only_text_files_in_the_employees_folders() {
        let o = office();
        let home = o.dir.join("employees").join("e1");
        let repo = o.dir.join("repo");
        fs::create_dir_all(home.join("workspace/drafts")).unwrap();
        fs::create_dir_all(&repo).unwrap();
        fs::write(home.join("workspace/drafts/reply.md"), "Hi").unwrap();
        fs::write(repo.join("notes.txt"), "Notes").unwrap();
        fs::write(o.dir.join("outside.md"), "Not theirs").unwrap();
        fs::write(home.join("big.md"), "x".repeat(cards::FILE_BYTES as usize + 1)).unwrap();
        fs::write(home.join("binary.md"), [0xff, 0xfe, 0x00]).unwrap();
        std::os::unix::fs::symlink(o.dir.join("outside.md"), home.join("link.md")).unwrap();
        let workspaces = vec![repo.to_string_lossy().into_owned()];
        let at = |raw: &str| card_file_path(&home, &workspaces, raw);
        let real = |p: PathBuf| fs::canonicalize(p).unwrap();
        assert_eq!(at("workspace/drafts/reply.md").unwrap(), real(home.join("workspace/drafts/reply.md")));
        assert_eq!(at(&repo.join("notes.txt").to_string_lossy()).unwrap(), real(repo.join("notes.txt")));
        for (raw, why) in [
            ("workspace/drafts/gone.md", "No file at"),
            ("workspace/drafts", "No file at"),
            ("../../outside.md", "file must be in your folder"),
            ("link.md", "file must be in your folder"),
            ("big.md", "KB, and a card shows files up to 200 KB"),
            ("binary.md", "is not plain text"),
        ] {
            assert!(at(raw).unwrap_err().message.contains(why), "{raw}");
        }
    }

    #[tokio::test]
    async fn a_card_shows_its_file_as_it_is_now() {
        let o = office();
        let ada = employee(&o.db, "Ada", None);
        let r = run(&o.db, &ada, RunKind::Manual, "Draft the reply.", RunState::Succeeded, 5, None);
        let office = Office::open(o.dir.clone(), Arc::new(NoSink), Build::new("0.0.0".into())).await.unwrap();
        let draft = office.employee_dir(&ada.id).join("workspace/reply.md");
        fs::create_dir_all(draft.parent().unwrap()).unwrap();
        fs::write(&draft, "First go").unwrap();
        let args = json!({ "message": "Send the reply?", "key": "reply", "file": "workspace/reply.md", "choices": [{ "label": "Send", "recommended": true }] });
        office.notify_tool(&r.id, &ada, &args).unwrap();
        let card = o.db.run(&r.id).unwrap().unwrap().run.cards.remove(0);
        assert_eq!(card.file, Some(fs::canonicalize(&draft).unwrap().to_string_lossy().into_owned()), "kept as a full path");

        fs::write(&draft, "Second go").unwrap();
        assert_eq!(office.card_file(&r.id, 0).unwrap(), "Second go", "what would go out now");
        assert_eq!(office.card_file(&r.id, 1).unwrap_err().message, "That card shows no file.");
        fs::remove_file(&draft).unwrap();
        assert!(office.card_file(&r.id, 0).unwrap_err().message.starts_with("Nothing is at"));
        std::os::unix::fs::symlink(o.dir.join("office.db"), &draft).unwrap();
        assert!(office.card_file(&r.id, 0).unwrap_err().message.starts_with("Nothing is at"), "a link put in its place is not followed");
        drop(office);
    }

    /// A sink that keeps the desktop notifications, by body.
    #[derive(Default)]
    struct Told(std::sync::Mutex<Vec<String>>);
    impl EventSink for Told {
        fn org_changed(&self) {}
        fn run_updated(&self, _run: &Run) {}
        fn run_events(&self, _run_id: &str, _events: &[RunEvent]) {}
        fn request_updated(&self, _request: &HumanRequest) {}
        fn notify(&self, _title: &str, body: &str) {
            self.0.lock().unwrap().push(body.to_string());
        }
    }

    /// The Office on `o`'s store, held so nothing it queues starts, keeping its notifications in the sink it returns.
    async fn told_office(o: &Office0) -> (Office, Arc<Told>) {
        o.db.set_held_until(Some(now() + chrono::Duration::hours(1))).unwrap();
        let told = Arc::new(Told::default());
        (Office::open(o.dir.clone(), told.clone(), Build::new("0.0.0".into())).await.unwrap(), told)
    }

    #[tokio::test]
    async fn a_list_grows_and_an_edit_notifies_nobody_again() {
        let o = office();
        let ada = employee(&o.db, "Ada", None);
        let first = run(&o.db, &ada, RunKind::Manual, "Review the pull requests.", RunState::Succeeded, 30, None);
        let later = run(&o.db, &ada, RunKind::Manual, "Review the pull requests.", RunState::Succeeded, 10, None);
        let (office, told) = told_office(&o).await;
        let list = |items: &[(&str, &str)]| {
            let items: Vec<Value> = items.iter().map(|(id, text)| json!({ "id": id, "text": text })).collect();
            json!({ "message": "Merge these?", "key": "merges", "itemVerb": "Merge", "items": items })
        };
        assert_eq!(office.notify_tool(&first.id, &ada, &list(&[("pr:1", "Fix the footer."), ("pr:2", "New prices.")])).unwrap()["notified"], true);
        let grown = office.notify_tool(&later.id, &ada, &list(&[("pr:2", "New prices, with tax."), ("pr:3", "Faster search.")])).unwrap();
        assert_eq!(grown["notified"], false, "{grown}");
        assert!(grown["note"].as_str().unwrap().starts_with("Added to your open list about this: the card now holds 3 items"), "{grown}");
        let CardAsk::Items { items, .. } = saved(&o.db, &later.id).cards.remove(0).ask else { panic!("items") };
        let items: Vec<(&str, &str)> = items.iter().map(|i| (i.id.as_str(), i.text.as_str())).collect();
        assert_eq!(items, vec![("pr:1", "Fix the footer."), ("pr:2", "New prices, with tax."), ("pr:3", "Faster search.")], "the newer text wins");

        // Asking again with the same key edits the card in place, and so does raising it again soon after closing it.
        let venue = |why: &str| json!({ "message": "Book the hall?", "key": "venue", "why": why, "choices": [{ "label": "Book it" }] });
        assert_eq!(office.notify_tool(&later.id, &ada, &venue("Cheapest in May.")).unwrap()["notified"], true);
        assert_eq!(office.notify_tool(&later.id, &ada, &venue("Cheapest in June.")).unwrap()["notified"], false);
        let venues = |r: &Run| saved(&o.db, &r.id).cards.into_iter().filter(|c| c.key.as_deref() == Some("ask:venue")).collect::<Vec<_>>();
        assert_eq!(venues(&later).len(), 1, "changed in place");
        office.close_ask_tool(&ada, "venue", "Asked it wrongly.").unwrap();
        assert_eq!(office.notify_tool(&later.id, &ada, &venue("Cheapest in July.")).unwrap()["notified"], false, "soon after closing it");
        assert_eq!(told.0.lock().unwrap().clone(), vec!["Merge these?".to_string(), "Book the hall?".to_string()]);
        drop(office);
    }

    #[tokio::test]
    async fn a_card_in_a_conversation_you_are_in_shows_there_without_a_notification() {
        let o = office();
        let ada = employee(&o.db, "Ada", None);
        let fresh = run(&o.db, &ada, talk("The offsite"), "Plan the offsite.", RunState::Succeeded, 5, None);
        let old = run(&o.db, &ada, talk("The rota"), "Plan the rota.", RunState::Succeeded, 60, None);
        let (office, told) = told_office(&o).await;
        let ask = |message: &str, key: &str| json!({ "message": message, "key": key, "choices": [{ "label": "Go ahead" }] });
        assert_eq!(office.notify_tool(&fresh.id, &ada, &ask("Book the hall?", "hall")).unwrap()["notified"], false, "you wrote in it 5 minutes ago");
        assert_eq!(office.notify_tool(&old.id, &ada, &ask("Swap the Friday shift?", "shift")).unwrap()["notified"], true);
        let mut replied = saved(&o.db, &old.id);
        replied.replied_at = Some(now() - chrono::Duration::minutes(1));
        o.db.save_run(&replied).unwrap();
        assert_eq!(office.notify_tool(&old.id, &ada, &ask("Add a Sunday shift?", "sunday")).unwrap()["notified"], false, "your reply a minute ago");
        assert_eq!(told.0.lock().unwrap().len(), 1);
        assert_eq!(saved(&o.db, &fresh.id).cards.len(), 1, "the card is raised all the same");
        drop(office);
    }

    #[tokio::test]
    async fn a_card_carries_a_link_and_images_and_asks_for_what_it_is_about() {
        let o = office();
        let ada = employee(&o.db, "Ada", None);
        let r = run(&o.db, &ada, RunKind::Manual, "Review it.", RunState::Succeeded, 5, None);
        let office = held_office(&o).await;
        let home = office.employee_dir(&ada.id);
        fs::create_dir_all(home.join("workspace/shots")).unwrap();
        fs::write(home.join("workspace/shots/before.png"), [0x89, b'P', b'N', b'G']).unwrap();
        fs::write(home.join("workspace/shots/notes.md"), "Notes").unwrap();
        std::os::unix::fs::symlink(home.join("workspace/shots/notes.md"), home.join("workspace/shots/fake.png")).unwrap();
        fs::write(o.dir.join("outside.png"), [0u8]).unwrap();
        let merge = |extra: Value| {
            let mut args = json!({ "message": "Merge PR #12?", "key": "pr:12", "choices": [{ "label": "Merge" }] });
            args.as_object_mut().unwrap().extend(extra.as_object().unwrap().clone());
            args
        };
        let v = office.notify_tool(&r.id, &ada, &merge(json!({ "images": ["workspace/shots/before.png"] }))).unwrap();
        assert_eq!(v["tip"], "Attach what it is about (file for a draft, link for a pull request) so Pat can read it on the card.");
        let shot = fs::canonicalize(home.join("workspace/shots/before.png")).unwrap().to_string_lossy().into_owned();
        assert_eq!(saved(&o.db, &r.id).cards[0].images, vec![shot], "kept as a full path");
        let v = office.notify_tool(&r.id, &ada, &merge(json!({ "link": "https://example.com/acme/site/pull/12" }))).unwrap();
        assert!(v.get("tip").is_none(), "{v}");
        assert_eq!(saved(&o.db, &r.id).cards[0].link.as_deref(), Some("https://example.com/acme/site/pull/12"));
        for (raw, why) in [("../../outside.png", "file must be in your folder"), ("workspace/shots/gone.png", "No file at"), ("workspace/shots/fake.png", "is not a png, jpg, gif or webp file")] {
            assert!(office.notify_tool(&r.id, &ada, &merge(json!({ "images": [raw] }))).unwrap_err().message.contains(why), "{raw}");
        }
        drop(office);
    }

    #[tokio::test]
    async fn a_company_line_is_proposed_on_a_card_from_any_run() {
        let o = office();
        let ada = employee(&o.db, "Ada", None);
        let r = run(&o.db, &ada, standup("s1"), "Sweep the inbox.", RunState::Succeeded, 5, None);
        let (office, told) = told_office(&o).await;
        let line = json!({ "section": "Who to ask", "line": "Bo signs off refunds.", "why": "Three of us asked this week." });
        let v = office.propose_company_line_tool(&r.id, &ada, &line).unwrap();
        assert!(v["note"].as_str().unwrap().starts_with("Recorded. Pat sees the line on a card"), "{v}");
        assert_eq!(v["notified"], true);
        let card = saved(&o.db, &r.id).cards.remove(0);
        assert_eq!((card.message.as_str(), card.proposal), (cards::ADD_LINE, Some(Proposal::CompanyLine { section: "Who to ask".into(), line: "Bo signs off refunds.".into() })));
        assert_eq!(office.propose_company_line_tool(&r.id, &ada, &line).unwrap()["notified"], false, "the same line again is the same card");
        assert_eq!(saved(&o.db, &r.id).cards.len(), 1);
        assert!(office.propose_company_line_tool(&r.id, &ada, &json!({ "section": "Who to ask", "line": " ", "why": "Asked." })).is_err());
        assert_eq!(told.0.lock().unwrap().len(), 1);
        drop(office);
    }

    #[tokio::test]
    async fn a_card_read_back_after_a_restart_shows_its_file_only_if_notify_would_have() {
        let o = office();
        let ada = employee(&o.db, "Ada", None);
        let r = run(&o.db, &ada, RunKind::Manual, "Draft the replies.", RunState::Running, 10, None);
        let home = o.dir.join("employees").join(&ada.id);
        fs::create_dir_all(home.join("workspace")).unwrap();
        fs::write(home.join("workspace/reply.md"), "Hi").unwrap();
        fs::write(o.dir.join("outside.md"), "Not theirs").unwrap();
        let ask = |key: &str, file: &str| {
            let input = json!({ "message": "Send it?", "key": key, "file": file, "choices": [{ "label": "Send", "recommended": true }] });
            json!({ "type": "assistant", "parent_tool_use_id": null, "message": { "content": [{ "type": "tool_use", "id": key, "name": "mcp__omega__notify", "input": input }] } }).to_string()
        };
        let done = json!({ "type": "result", "subtype": "success", "is_error": false, "num_turns": 2, "duration_ms": 900, "result": "Drafted.", "permission_denials": [] });
        let transcript = [ask("ours", "workspace/reply.md"), ask("theirs", "../../outside.md"), done.to_string()].join("\n");
        fs::create_dir_all(o.dir.join("runs").join(&r.id)).unwrap();
        fs::write(o.dir.join("runs").join(&r.id).join("transcript.jsonl"), transcript).unwrap();

        let office = Office::open(o.dir.clone(), Arc::new(NoSink), Build::new("0.0.0".into())).await.unwrap();
        let cards = o.db.run(&r.id).unwrap().unwrap().run.cards;
        let files: Vec<_> = cards.iter().map(|c| c.file.clone()).collect();
        assert_eq!(files, vec![Some(fs::canonicalize(home.join("workspace/reply.md")).unwrap().to_string_lossy().into_owned()), None]);
        drop(office);
    }

    #[tokio::test]
    async fn a_report_waits_for_a_manager_the_restart_put_back_in_the_queue() {
        let o = office();
        let ada = employee(&o.db, "Ada", None);
        let bo = employee(&o.db, "Bo", Some(&ada.id));
        let parent = run(&o.db, &ada, RunKind::Manual, "Plan the launch.", RunState::Running, 30, None);
        let child = run(&o.db, &bo, delegated(&parent), "Count the stock.", RunState::Succeeded, 20, None);

        let office = Office::open(o.dir.clone(), Arc::new(NoSink), Build::new("0.0.0".into())).await.unwrap();
        assert_eq!(o.db.run(&parent.id).unwrap().unwrap().run.state, RunState::Queued, "it carries on");
        assert!(!delivered(&o.db, &child), "it collects the report with await_reports, or gets it when it ends");
        drop(office);
    }

    #[test]
    fn a_report_waits_for_its_manager_to_finish() {
        let o = office();
        let ada = employee(&o.db, "Ada", None);
        let bo = employee(&o.db, "Bo", Some(&ada.id));
        let mut parent = run(&o.db, &ada, RunKind::Manual, "Plan the launch.", RunState::Running, 30, None);
        let child = run(&o.db, &bo, asked(&parent, true), "Count the stock.", RunState::Succeeded, 20, None);
        assert!(due_answers(&o.db, &child).unwrap().is_empty(), "the manager can still collect it");
        assert!(!delivered(&o.db, &child));

        parent.state = RunState::Succeeded;
        parent.ended_at = Some(now());
        o.db.save_run(&parent).unwrap();
        let due = due_answers(&o.db, &parent).unwrap();
        assert_eq!(due.len(), 1);
        assert!(matches!(&due[0].0.kind, RunKind::Answered { asked_run_id, .. } if *asked_run_id == child.id));
    }

    #[test]
    fn a_stopped_or_collected_report_is_not_brought_back() {
        let o = office();
        let ada = employee(&o.db, "Ada", None);
        let bo = employee(&o.db, "Bo", Some(&ada.id));
        let parent = run(&o.db, &ada, RunKind::Manual, "Plan the launch.", RunState::Succeeded, 30, None);
        let stopped = run(&o.db, &bo, delegated(&parent), "Count the stock.", RunState::Cancelled, 20, None);
        assert!(due_answers(&o.db, &stopped).unwrap().is_empty());
        assert!(delivered(&o.db, &stopped), "stamped all the same");

        let mut collected = run(&o.db, &bo, delegated(&parent), "Count the till.", RunState::Succeeded, 20, None);
        collected.delivered_at = Some(now());
        o.db.save_run(&collected).unwrap();
        assert!(due_answers(&o.db, &collected).unwrap().is_empty());
        assert!(due_answers(&o.db, &parent).unwrap().is_empty());
    }

    #[test]
    fn an_answer_to_an_ask_from_a_conversation_is_its_next_turn() {
        let o = office();
        let ada = employee(&o.db, "Ada", None);
        let bo = employee(&o.db, "Bo", Some(&ada.id));
        let task = RunKind::Task { label: "The numbers".into(), from: None, context: String::new() };
        let parent = run(&o.db, &ada, task, "Ask Bo for the numbers.", RunState::Succeeded, 30, None);
        o.db.mark_inited(&parent.id).unwrap();
        let mut child = run(&o.db, &bo, asked(&parent, false), "What are the numbers?", RunState::Succeeded, 20, None);
        child.needs_you = vec!["Look at this.".into()];
        o.db.save_run(&child).unwrap();

        let (a, session) = due_answers(&o.db, &child).unwrap().remove(0);
        assert_eq!(a.kind, RunKind::Answered { asked_run_id: child.id.clone(), from: bo.id.clone(), task: false, chat: false, thread: Some(parent.id.clone()) });
        assert_eq!(session, parent.id, "the conversation's session");
        assert!(a.kind.is_conversation());
        assert_eq!(a.kind.lane(), Lane::Work);
        assert!(a.prompt.starts_with("Bo answered your question.\n\nYour question:"), "it resumes the conversation, so it quotes nothing: {}", a.prompt);

        assert!(o.db.insert_run(&a, &session).unwrap());
        assert_eq!(Office::thread_in(&o.db, &parent.id).unwrap().replies.iter().map(|r| r.id.clone()).collect::<Vec<_>>(), vec![a.id.clone()]);
        assert!(!o.db.conversation_runs().unwrap().iter().any(|r| r.id == a.id));
        let rows = Office::rows(&o.db, crate::threads::View::Inbox).unwrap();
        let filed: Vec<&str> = rows.iter().flat_map(|t| std::iter::once(t).chain(&t.related)).map(|t| t.root.id.as_str()).collect();
        assert!(filed.contains(&child.id.as_str()), "the flagged answer has its row: {filed:?}");
        assert!(!filed.contains(&a.id.as_str()), "the turn is in no row");

        // An ask from your reply in the conversation comes back into it too, after the turn before it.
        let reply = RunKind::Reply { to_run_id: parent.id.clone(), label: "The numbers".into(), task: true, card: false };
        let replied = run(&o.db, &ada, reply, "And the totals?", RunState::Succeeded, 5, Some(&parent.id));
        let again = run(&o.db, &bo, asked(&replied, false), "And the totals?", RunState::Succeeded, 2, None);
        let (b, session) = due_answers(&o.db, &again).unwrap().remove(0);
        assert!(matches!(&b.kind, RunKind::Answered { thread: Some(t), .. } if *t == parent.id), "{:?}", b.kind);
        assert_eq!(session, parent.id);
    }

    #[test]
    fn an_answer_to_an_older_builds_chat_comes_back_into_its_message_in_a_fresh_session() {
        let o = office();
        let ada = employee(&o.db, "Ada", None);
        let bo = employee(&o.db, "Bo", Some(&ada.id));
        let parent = run(&o.db, &ada, RunKind::Chat, "Ask Bo for the numbers.", RunState::Succeeded, 30, Some(&ada.chat_session));
        o.db.mark_inited(&parent.id).unwrap();
        let child = run(&o.db, &bo, asked(&parent, false), "What are the numbers?", RunState::Succeeded, 20, None);
        let (a, session) = due_answers(&o.db, &child).unwrap().remove(0);
        assert_eq!(a.kind, RunKind::Answered { asked_run_id: child.id.clone(), from: bo.id.clone(), task: false, chat: false, thread: Some(parent.id.clone()) });
        assert_eq!(session, a.id, "never into the old chat");
        assert!(a.prompt.starts_with("Bo answered your question.\n\nYou were talking with Pat, whose message was:\n\nAsk Bo for the numbers."), "{}", a.prompt);
    }

    #[test]
    fn an_ask_from_an_older_builds_chat_answer_turn_comes_back_into_the_chat_message() {
        let o = office();
        let di = employee(&o.db, "Di", None);
        let ada = employee(&o.db, "Ada", Some(&di.id));
        let bo = employee(&o.db, "Bo", Some(&ada.id));
        let cy = employee(&o.db, "Cy", None);
        let message = run(&o.db, &ada, RunKind::Chat, "Ask Bo for the numbers.", RunState::Succeeded, 40, Some(&ada.chat_session));
        o.db.mark_inited(&message.id).unwrap();
        let first = run(&o.db, &bo, asked(&message, false), "What are the numbers?", RunState::Succeeded, 30, None);
        let came = RunKind::Answered { asked_run_id: first.id.clone(), from: bo.id.clone(), task: false, chat: true, thread: None };
        let turn = run(&o.db, &ada, came, "Bo answered your question.", RunState::Succeeded, 20, Some(&ada.chat_session));
        let child = run(&o.db, &cy, asked(&turn, false), "Do they include the till?", RunState::Succeeded, 10, None);
        let (a, _) = due_answers(&o.db, &child).unwrap().remove(0);
        assert_eq!(a.kind, RunKind::Answered { asked_run_id: child.id.clone(), from: cy.id.clone(), task: false, chat: false, thread: Some(message.id.clone()) });
    }

    #[test]
    fn a_report_quotes_where_its_run_started_only_when_it_does_not_resume_it() {
        let o = office();
        let ada = employee(&o.db, "Ada", None);
        let bo = employee(&o.db, "Bo", Some(&ada.id));
        let never_started = run(&o.db, &ada, RunKind::Manual, "Plan the launch.", RunState::Failed, 30, None);
        let child = run(&o.db, &bo, asked(&never_started, true), "Count the stock.", RunState::Succeeded, 20, None);
        let (a, session) = due_answers(&o.db, &child).unwrap().remove(0);
        assert_eq!(session, never_started.id);
        assert!(a.prompt.contains("\n\nYour run had started from:\n\nPlan the launch.\n\nYour task:"), "{}", a.prompt);

        let came = RunKind::Answered { asked_run_id: child.id.clone(), from: bo.id.clone(), task: true, chat: false, thread: None };
        let answered = run(&o.db, &ada, came, "Bo finished the task you handed them.", RunState::Succeeded, 10, None);
        let child = run(&o.db, &bo, asked(&answered, true), "Count the till.", RunState::Failed, 5, None);
        let (a, _) = due_answers(&o.db, &child).unwrap().remove(0);
        assert!(a.prompt.contains("\n\nYour run had started from:\n\nBo finished the task"), "{}", a.prompt);
        assert!(a.prompt.contains("Their report:\n\nThey did not finish (failed): no details"), "{}", a.prompt);
    }

    #[test]
    fn an_answered_card_on_handed_work_reports_to_whoever_handed_it() {
        let o = office();
        let ada = employee(&o.db, "Ada", None);
        let bo = employee(&o.db, "Bo", Some(&ada.id));
        let parent = run(&o.db, &ada, RunKind::Manual, "Plan the launch.", RunState::Succeeded, 30, None);
        o.db.mark_inited(&parent.id).unwrap();
        let mut child = run(&o.db, &bo, delegated(&parent), "Boost the post.", RunState::Succeeded, 20, None);
        let answer = CardAnswer { at: now(), how: AnswerHow::Tapped, text: "Chose: Not now.".into(), held: false };
        let mut card = Card::new("Boost it?", None, Some("ask:boost".into()), CardAsk::Choices { choices: vec!["Not now".into(), "Go".into()], recommended: 0 });
        card.answer = Some(answer);
        child.cards = vec![card];
        o.db.save_run(&child).unwrap();
        assert!(due_answers(&o.db, &child).unwrap().is_empty(), "the first report is held for Ada");
        assert!(delivered(&o.db, &child));

        let reply = |card: bool, state: RunState| {
            let kind = RunKind::Reply { to_run_id: child.id.clone(), label: "Delegated".into(), task: false, card };
            run(&o.db, &bo, kind, "Your card: \"Boost it?\"\nChose: Not now.", state, 5, Some(&child.id))
        };
        assert!(due_answers(&o.db, &reply(false, RunState::Succeeded)).unwrap().is_empty(), "a reply you typed stays with Bo");
        assert!(due_answers(&o.db, &reply(true, RunState::Cancelled)).unwrap().is_empty(), "a reply you stopped stays with Bo");
        let tapped = reply(true, RunState::Succeeded);
        let due = due_answers(&o.db, &tapped).unwrap();
        assert_eq!(due.len(), 1);
        let (a, session) = &due[0];
        assert_eq!(a.employee_id, ada.id);
        assert_eq!(session, &parent.id);
        assert_eq!(a.kind, RunKind::Answered { asked_run_id: child.id.clone(), from: bo.id.clone(), task: true, chat: false, thread: None });
        assert!(
            a.prompt.starts_with("Bo finished the task you handed them.\n\nPat answered Bo's card (Chose: Not now.) and Bo carried on.\n\nYour task:\n\nBoost the post.\n\nTheir report:\n\nBo did it."),
            "{}",
            a.prompt
        );
    }

    #[test]
    fn older_runs_load_without_the_new_fields() {
        let kind: RunKind = serde_json::from_value(json!({ "type": "answered", "askedRunId": "r1", "from": "e1", "task": true })).unwrap();
        assert_eq!(kind, RunKind::Answered { asked_run_id: "r1".into(), from: "e1".into(), task: true, chat: false, thread: None });
        let mut v = serde_json::to_value(Run::new("e1", RunKind::Manual, "go".into(), now())).unwrap();
        for field in ["omegaWrote", "notBefore", "chain", "reports", "notedIn", "redelivered"] {
            v.as_object_mut().unwrap().remove(field);
        }
        let r: Run = serde_json::from_value(v).unwrap();
        assert!(!r.omega_wrote);
        assert_eq!((r.not_before, r.chain, r.reports, r.noted_in, r.redelivered), (None, None, vec![], None, 0));
    }

    #[test]
    fn a_handoff_note_says_when_to_wait() {
        let plain = handoff_note("Bo", "Their report", 0, false, false);
        assert_eq!(
            plain,
            "Their report comes back to you either way. Wait for it with await_reports only if it should take a few minutes and you need it \
before you finish. Otherwise finish now: Omega Star starts a new run for you when it arrives."
        );
        let both = handoff_note("Bo", "The answer", 1, true, false);
        assert!(both.starts_with("Bo is busy with other work: 1 run is ahead of this one, so this starts when that finishes. The answer comes back"), "{both}");
        assert!(both.ends_with("when it arrives, as your next turn in this conversation."));
        let queue = handoff_note("Bo", "The answer", 3, false, false);
        assert!(queue.starts_with("Bo is busy with other work: 3 runs are ahead of this one, so this starts when those finish. "), "{queue}");
        let held = handoff_note("Bo", "Their report", 0, false, true);
        assert!(held.ends_with("Otherwise finish now: Omega Star keeps it for your next run, or brings it with any other reports from your team in one run once 30 minutes pass without a new one."), "{held}");
        let paused = paused_note("Bo", "Their report", now());
        assert!(paused.starts_with("Omega Star paused this hand-off to keep the chain short. It goes to Bo by itself at "), "{paused}");
        assert!(!paused.contains("declin") && !paused.contains("refus"), "nothing suggests Bo said no: {paused}");
        for t in [&plain, &both, &queue, &held, &paused] {
            assert!(!t.contains('\u{2014}'), "{t}");
        }
    }

    #[test]
    fn only_work_that_waits_for_a_lane_has_runs_ahead_of_it() {
        let o = office();
        let ada = employee(&o.db, "Ada", None);
        let bo = employee(&o.db, "Bo", None);
        let cap = |n: u32| o.db.set_settings(&AppSettings { max_concurrent_runs: n, ..AppSettings::default() }).unwrap();
        cap(1);
        let asker = run(&o.db, &ada, RunKind::Manual, "Ask Bo.", RunState::Succeeded, 30, None);
        run(&o.db, &bo, RunKind::Manual, "A long build.", RunState::Running, 20, None);
        let earlier = run(&o.db, &bo, RunKind::Asked { parent_run_id: asker.id.clone(), asked_by: ada.id.clone(), task: true }, "Fix it.", RunState::Queued, 10, None);
        let task = run(&o.db, &bo, RunKind::Asked { parent_run_id: asker.id.clone(), asked_by: ada.id.clone(), task: true }, "Ship it.", RunState::Queued, 5, None);
        let question = run(&o.db, &bo, RunKind::Asked { parent_run_id: asker.id.clone(), asked_by: ada.id.clone(), task: false }, "Which room?", RunState::Queued, 1, None);
        assert_eq!(queue_ahead(&o.db, &task, now()).unwrap(), 2, "the build, and the task queued before it");
        assert_eq!(queue_ahead(&o.db, &earlier, now()).unwrap(), 1);
        assert_eq!(queue_ahead(&o.db, &question, now()).unwrap(), 0, "a question runs beside background work");
        cap(2);
        assert_eq!(queue_ahead(&o.db, &earlier, now()).unwrap(), 0, "a second lane opens with the cap");
        assert_eq!(queue_ahead(&o.db, &task, now()).unwrap(), 2);
    }

    /// Writes your messages into a run's transcript, as if steered into it while it worked.
    fn steer(o: &Office0, r: &Run, said: &[&str]) {
        let dir = o.dir.join("runs").join(&r.id);
        fs::create_dir_all(&dir).unwrap();
        let lines: Vec<String> = said.iter().map(|t| claude::omega_line(&RunEvent::User { text: t.to_string(), id: None })).collect();
        fs::write(dir.join("transcript.jsonl"), lines.join("\n") + "\n").unwrap();
    }

    /// Where the hand-off `r` began, as the run being prepared for it is told: walked from its upstream.
    fn source(o: &Office0, r: &Run) -> String {
        source_text(&source_chain(&o.db, "Pat", r.upstream().unwrap()).unwrap(), &o.dir.join("runs"))
    }

    #[test]
    fn a_handoff_from_a_conversation_quotes_what_you_wrote_into_it() {
        let o = office();
        let ada = employee(&o.db, "Ada", None);
        let bo = employee(&o.db, "Bo", Some(&ada.id));
        let cy = employee(&o.db, "Cy", None);
        let task = RunKind::Task { label: "The stock".into(), from: None, context: String::new() };
        let delegating = run(&o.db, &ada, task, "Get Bo to count the stock.", RunState::Succeeded, 35, None);
        steer(&o, &delegating, &["Only the warehouse."]);

        let d = run(&o.db, &bo, delegated(&delegating), "Count the stock.", RunState::Running, 30, None);
        steer(&o, &d, &["Use last week's sheet."]);
        assert_eq!(source(&o, &d), "This began with Pat's own message to Ada:\n> \"Get Bo to count the stock. Only the warehouse.\"");
        // Bo asks Cy on: what Pat wrote into Bo's run on the way comes with it.
        let a = run(&o.db, &cy, asked(&d, false), "Where is last week's sheet?", RunState::Running, 20, None);
        assert_eq!(
            source(&o, &a),
            "This began with Pat's own message to Ada:\n> \"Get Bo to count the stock. Only the warehouse.\"\n\
Pat also wrote into Bo's run on the way:\n\
> \"Use last week's sheet.\""
        );
        // A hand-off from an older build's chat quotes the message it began with.
        let chat = run(&o.db, &ada, RunKind::Chat, "Ask Bo for a date.", RunState::Succeeded, 10, Some(&ada.chat_session));
        let d = run(&o.db, &bo, delegated(&chat), "Find a date.", RunState::Running, 5, None);
        assert_eq!(source(&o, &d), "This began with Pat's own message to Ada:\n> \"Ask Bo for a date.\"");
    }

    #[test]
    fn a_handoff_says_when_it_did_not_begin_with_your_words() {
        let o = office();
        let ada = employee(&o.db, "Ada", None);
        let bo = employee(&o.db, "Bo", Some(&ada.id));
        let from = |origin: &Run| {
            let d = run(&o.db, &bo, delegated(origin), "Count the stock.", RunState::Running, 0, None);
            source(&o, &d)
        };

        let sweep = RunKind::Scheduled { schedule_id: "s1".into(), slot: now(), label: "Sweep".into(), quiet: true, model: None, effort: None, review: false };
        let scheduled = run(&o.db, &ada, sweep, "Sweep the inbox.", RunState::Running, 5, None);
        assert_eq!(from(&scheduled), "This began with Ada's scheduled 'Sweep', not a message from Pat.");

        let root = run(&o.db, &ada, RunKind::Manual, "Plan the launch.", RunState::Succeeded, 60, None);
        assert_eq!(from(&root), "This began with Pat's own message to Ada:\n> \"Plan the launch.\"");
        let reply = RunKind::Reply { to_run_id: root.id.clone(), label: "Manual run".into(), task: false, card: false };
        let mut approval = Run::new(&ada.id, reply, "Pat approved what was blocked:\n- Bash: npm publish".into(), now());
        approval.omega_wrote = true;
        o.db.insert_run(&approval, &root.id).unwrap();
        assert_eq!(
            from(&approval),
            "This began with a message Omega Star wrote in the app from something Pat did there. It is not Pat's own words, except where it \
quotes them:\n> \"Pat approved what was blocked: - Bash: npm publish\""
        );

        let bare = run(&o.db, &ada, RunKind::Manual, DEFAULT_PROMPT, RunState::Running, 5, None);
        assert_eq!(from(&bare), "This began when Pat started a run for Ada from the app, with no instructions.");

        let lost = run(&o.db, &bo, RunKind::Delegated { parent_run_id: "gone".into() }, "Count the stock.", RunState::Running, 0, None);
        assert_eq!(source(&o, &lost), "Where this began is no longer on record, so treat it as the sender's own request.");
        let cy = employee(&o.db, "Cy", None);
        let on = run(&o.db, &cy, asked(&lost, false), "Which stock?", RunState::Running, 0, None);
        assert_eq!(source(&o, &on), "Where this began is no longer on record, so treat it as Bo's own request.");
    }

    #[test]
    fn schedule_effort_takes_a_level_or_default() {
        assert_eq!(effort_arg("low").unwrap(), Some(Effort::Low));
        assert_eq!(effort_arg(" xhigh ").unwrap(), Some(Effort::Xhigh));
        assert_eq!(effort_arg("default").unwrap(), None);
        assert_eq!(effort_arg("quick").unwrap_err().message, "effort must be low, medium, high, xhigh or max");
    }

    fn standup(id: &str) -> RunKind {
        RunKind::Scheduled { schedule_id: id.into(), slot: now(), label: "Stand-up".into(), quiet: false, model: None, effort: None, review: false }
    }

    fn talk(label: &str) -> RunKind {
        RunKind::Task { label: label.into(), from: None, context: String::new() }
    }

    /// A finished, delivered hand-off of `kind` to `to` in the chain `root` started, `ago` minutes back.
    fn handed(db: &Store, to: &Employee, kind: RunKind, root: &Run, ago: i64) -> Run {
        let mut r = run(db, to, kind, "Over to you.", RunState::Succeeded, ago, None);
        r.chain = Some(root.id.clone());
        r.delivered_at = Some(now());
        db.save_run(&r).unwrap();
        r
    }

    /// The Office on `o`'s store, held for an hour so nothing it queues starts.
    async fn held_office(o: &Office0) -> Office {
        o.db.set_held_until(Some(now() + chrono::Duration::hours(1))).unwrap();
        Office::open(o.dir.clone(), Arc::new(NoSink), Build::new("0.0.0".into())).await.unwrap()
    }

    fn saved(db: &Store, id: &str) -> Run {
        db.run(id).unwrap().unwrap().run
    }

    fn run_id(v: &Value) -> String {
        v["runId"].as_str().unwrap().to_string()
    }

    /// What `catch_up` puts in the opening note of `r`.
    fn caught_up(db: &Store, employees: &[Employee], r: &Run) -> claude::Opening {
        let mut o = claude::Opening { now: now(), ..Default::default() };
        catch_up(db, employees, r, &mut o).unwrap();
        o
    }

    #[tokio::test]
    async fn back_and_forth_pauses_the_next_handoff_instead_of_refusing_it() {
        let o = office();
        let ada = employee(&o.db, "Ada", None);
        let cy = employee(&o.db, "Cy", None);
        let root = run(&o.db, &ada, standup("s1"), "Sweep the inbox.", RunState::Succeeded, 180, None);
        for _ in 0..3 {
            handed(&o.db, &cy, asked(&root, false), &root, 150);
        }
        // Five hand-offs between Ada and Cy in the last two hours, either way. Older ones and answers do not count.
        let h1 = handed(&o.db, &cy, asked(&root, false), &root, 60);
        let h2 = handed(&o.db, &ada, asked(&h1, false), &root, 50);
        let h3 = handed(&o.db, &cy, asked(&h2, false), &root, 40);
        let h4 = handed(&o.db, &ada, asked(&h3, false), &root, 30);
        let h5 = handed(&o.db, &cy, asked(&h4, false), &root, 20);
        let answer = |h: &Run, state| {
            let came = RunKind::Answered { asked_run_id: h.id.clone(), from: cy.id.clone(), task: false, chat: false, thread: None };
            run(&o.db, &ada, came, "Cy answered your question.", state, 10, None)
        };
        answer(&h3, RunState::Succeeded);
        let caller = answer(&h5, RunState::Running);
        let office = held_office(&o).await;

        let first = office.ask_colleague(&caller.id, &ada, "Cy", "And the totals?", "question").unwrap();
        let mut r = saved(&o.db, &run_id(&first));
        assert_eq!((r.not_before, r.chain.clone()), (None, Some(root.id.clone())), "{first}");
        r.state = RunState::Succeeded;
        o.db.save_run(&r).unwrap();

        let second = office.ask_colleague(&caller.id, &ada, "Cy", "And the till?", "question").unwrap();
        let r = saved(&o.db, &run_id(&second));
        assert_eq!(r.state, RunState::Queued, "paused, not refused");
        let wait = r.not_before.unwrap() - now();
        assert!(wait > chrono::Duration::minutes(59) && wait <= chrono::Duration::hours(1), "{wait:?}");
        assert_eq!(r.chain, Some(r.id.clone()), "it starts a chain of its own");
        assert_eq!(chain_up(&o.db, &r.id).unwrap().1, r.id, "what it hands on counts there");
        let note = second["note"].as_str().unwrap();
        assert!(note.starts_with("Omega Star paused this hand-off to keep the chain short. It goes to Cy by itself at "), "{note}");
        drop(office);
    }

    #[tokio::test]
    async fn a_pair_paused_twice_today_is_stopped_and_tasks_count_only_toward_the_chain() {
        let o = office();
        let ada = employee(&o.db, "Ada", None);
        let bo = employee(&o.db, "Bo", Some(&ada.id));
        let cy = employee(&o.db, "Cy", None);
        let root = run(&o.db, &ada, standup("s1"), "Sweep the inbox.", RunState::Running, 0, None);
        // Six tasks Ada handed Bo in this chain just now: the daily cap covers those, so they never pause an ask.
        for _ in 0..6 {
            handed(&o.db, &bo, delegated(&root), &root, 0);
        }
        let theirs = run(&o.db, &cy, RunKind::Manual, "Price the stock.", RunState::Running, 0, None);
        // Two asks between Ada and Cy were paused today, one each way: each started a chain of its own.
        for (from, to) in [(&root, &cy), (&theirs, &ada)] {
            let mut r = run(&o.db, to, asked(from, false), "Which supplier?", RunState::Succeeded, 0, None);
            r.chain = Some(r.id.clone());
            o.db.save_run(&r).unwrap();
        }
        let office = held_office(&o).await;
        let ask = office.ask_colleague(&root.id, &ada, "Bo", "Which shelf?", "question").unwrap();
        assert_eq!(saved(&o.db, &run_id(&ask)).not_before, None, "{ask}");

        let stopped = office.ask_colleague(&root.id, &ada, "Cy", "And the till?", "question").unwrap_err();
        assert_eq!(
            stopped.message,
            "Omega Star stopped this hand-off: Ada and Cy have passed this back and forth all day. Finish with what you have and say in your report what is still open."
        );
        let back = office.ask_colleague(&theirs.id, &cy, "Ada", "Can you check the till?", "task").unwrap_err();
        assert!(back.message.starts_with("Omega Star stopped this hand-off: Cy and Ada have passed this back and forth all day."), "{}", back.message);
        drop(office);
    }

    #[test]
    fn held_reports_wait_two_hours_at_most_however_often_one_comes() {
        let o = office();
        let ada = employee(&o.db, "Ada", None);
        let bo = employee(&o.db, "Bo", Some(&ada.id));
        let morning = run(&o.db, &ada, standup("s1"), "Stand-up.", RunState::Succeeded, 300, None);
        let parent = o.db.run(&morning.id).unwrap().unwrap();
        let report = |task: &str| run(&o.db, &bo, delegated(&morning), task, RunState::Succeeded, 0, None);
        let batch = || o.db.active_runs_of(&ada.id).unwrap().remove(0);
        let first = now() - chrono::Duration::minutes(110);
        hold(&o.db, "Pat", &report("Count the shelf."), &parent, first).unwrap();
        assert_eq!(batch().not_before, Some(first + HOLD));
        // Another every 20 minutes would put it off for good: it goes two hours after the first.
        hold(&o.db, "Pat", &report("Count the till."), &parent, first + chrono::Duration::minutes(100)).unwrap();
        let b = batch();
        assert_eq!((b.not_before, b.reports.len()), (Some(first + HOLD_MAX), 2));
    }

    #[tokio::test]
    async fn reports_a_run_took_in_are_held_again_when_you_stop_it() {
        let o = office();
        let ada = employee(&o.db, "Ada", None);
        let bo = employee(&o.db, "Bo", Some(&ada.id));
        let morning = run(&o.db, &ada, standup("s1"), "Stand-up.", RunState::Succeeded, 60, None);
        let shelf = run(&o.db, &bo, delegated(&morning), "Count the shelf.", RunState::Succeeded, 20, None);
        assert!(due_answers(&o.db, &shelf).unwrap().is_empty(), "held for Ada");
        // Ada's next run took it in, then went back to the queue for the usage limit, where you stop it.
        let next = run(&o.db, &ada, RunKind::Manual, "Go.", RunState::Running, 0, None);
        assert_eq!(caught_up(&o.db, &[ada.clone(), bo.clone()], &next).held.len(), 1);
        let mut back = saved(&o.db, &next.id);
        (back.state, back.limit_retries) = (RunState::Queued, 1);
        o.db.save_run(&back).unwrap();
        let office = held_office(&o).await;
        office.cancel_run(&next.id).unwrap();
        let held: Vec<Vec<String>> = o.db.active_runs_of(&ada.id).unwrap().into_iter().map(|r| r.reports).collect();
        assert_eq!(held, vec![vec![shelf.id.clone()]], "Ada's next run brings it after all");
        assert_eq!(saved(&o.db, &shelf.id).noted_in, None);
        drop(office);
    }

    #[tokio::test]
    async fn a_long_chain_pauses_a_task_and_a_report_takes_four_a_day() {
        let o = office();
        let ada = employee(&o.db, "Ada", None);
        employee(&o.db, "Bo", Some(&ada.id));
        let (cy, dee) = (employee(&o.db, "Cy", None), employee(&o.db, "Dee", None));
        let root = run(&o.db, &ada, standup("s1"), "Hand out the week's work.", RunState::Running, 300, None);
        let theirs = run(&o.db, &cy, RunKind::Manual, "Ask Dee.", RunState::Succeeded, 290, None);
        for _ in 0..39 {
            handed(&o.db, &dee, asked(&theirs, false), &root, 280);
        }
        let office = held_office(&o).await;
        let task = |n: usize| office.delegate(&root.id, &ada, "Bo", &format!("Count shelf {n}."));
        let first = saved(&o.db, &run_id(&task(1).unwrap()));
        assert_eq!((first.not_before, first.chain.clone()), (None, Some(root.id.clone())), "39 hand-offs came before it");
        let second = task(2).unwrap();
        assert!(second["note"].as_str().unwrap().starts_with("Omega Star paused this hand-off to keep the chain short. It goes to Bo by itself at "), "{second}");
        assert!(saved(&o.db, &run_id(&second)).not_before.is_some(), "the 41st waits");
        task(3).unwrap();
        task(4).unwrap();
        assert_eq!(task(5).unwrap_err().message, "Bo already has 4 tasks from you today. Put the rest in your plan for tomorrow.");
        let team = office.team(&ada).unwrap();
        assert_eq!((team["reports"][0]["tasksToday"].clone(), team["tasksPerDay"].clone()), (json!(4), json!(4)));
        // One you stopped no longer counts, and a conversation with Pat may hand out more.
        office.cancel_run(&first.id).unwrap();
        task(5).unwrap();
        let talking = run(&o.db, &ada, talk("The stock"), "Get Bo on the shelves.", RunState::Running, 5, None);
        let v = office.delegate(&talking.id, &ada, "Bo", "Count shelf 6.").unwrap();
        assert!(v["note"].as_str().unwrap().ends_with("as your next turn in this conversation."), "{v}");
        drop(office);
    }

    #[tokio::test]
    async fn a_colleague_waiting_on_you_up_the_chain_is_still_refused() {
        let o = office();
        let ada = employee(&o.db, "Ada", None);
        let bo = employee(&o.db, "Bo", Some(&ada.id));
        let waiting = run(&o.db, &bo, RunKind::Manual, "Price the stock.", RunState::Running, 10, None);
        let asked_ada = run(&o.db, &ada, asked(&waiting, false), "Which supplier?", RunState::Running, 5, None);
        let office = held_office(&o).await;
        let ask = office.ask_colleague(&asked_ada.id, &ada, "Bo", "Which shelf?", "question").unwrap_err();
        assert!(ask.message.starts_with("Bo is already waiting on you further up this chain, so they cannot answer now."), "{}", ask.message);
        let task = office.delegate(&asked_ada.id, &ada, "Bo", "Count the shelf.").unwrap_err();
        assert!(task.message.starts_with("Bo is already waiting on you further up this chain, so they cannot take this now."), "{}", task.message);
        drop(office);
    }

    #[tokio::test]
    async fn a_repeat_request_joins_the_one_not_started_yet() {
        let o = office();
        let ada = employee(&o.db, "Ada", None);
        let cy = employee(&o.db, "Cy", None);
        let sweep = run(&o.db, &ada, standup("s1"), "Sweep.", RunState::Succeeded, 30, None);
        let later = run(&o.db, &ada, RunKind::Manual, "Plan.", RunState::Running, 5, None);
        let office = held_office(&o).await;
        let first = run_id(&office.ask_colleague(&sweep.id, &ada, "Cy", "Which room?", "question").unwrap());
        let again = office.ask_colleague(&later.id, &ada, "Cy", "Book it for Friday.", "task").unwrap();
        assert_eq!(run_id(&again), first, "{again}");
        let note = again["note"].as_str().unwrap();
        assert!(note.starts_with("Cy had not started your earlier request yet, so Omega Star added this one to it, and one answer covers both."), "{note}");
        let r = saved(&o.db, &first);
        assert_eq!(r.prompt, "Which room?\n\nLater, Ada added:\n\nBook it for Friday.");
        assert!(matches!(r.kind, RunKind::Asked { task: true, .. }), "a task added makes it one");
        assert_eq!(o.db.active_runs_of(&cy.id).unwrap().len(), 1);

        // Not from a conversation with Pat, where its answer would land elsewhere, nor once it has started.
        let talking = run(&o.db, &ada, talk("Rooms"), "Find a room.", RunState::Running, 2, None);
        assert_ne!(run_id(&office.ask_colleague(&talking.id, &ada, "Cy", "Which floor?", "question").unwrap()), first);
        let mut started = r.clone();
        started.state = RunState::Running;
        o.db.save_run(&started).unwrap();
        assert_ne!(run_id(&office.ask_colleague(&later.id, &ada, "Cy", "And the projector?", "question").unwrap()), first);
        drop(office);
    }

    #[tokio::test]
    async fn news_starts_no_run_and_tops_the_next_one() {
        let o = office();
        let ada = employee(&o.db, "Ada", None);
        let bo = employee(&o.db, "Bo", None);
        let cy = employee(&o.db, "Cy", None);
        let sender = run(&o.db, &ada, RunKind::Manual, "Ship it.", RunState::Running, 5, None);
        let office = held_office(&o).await;
        let one = office.ask_colleague(&sender.id, &ada, "Bo", "The new opening hours are up.", "info").unwrap();
        assert_eq!(one["note"], "Omega Star shows this to Bo at the top of their next run. It starts no run, and nothing comes back.");
        let all = office.ask_colleague(&sender.id, &ada, "everyone", "We close at noon on Friday.", "info").unwrap();
        assert_eq!(all["told"], json!(["Bo", "Cy"]));
        assert!(all["note"].as_str().unwrap().starts_with("Omega Star shows this to Bo and Cy at the top of their next run."), "{all}");
        assert!(o.db.active_runs_of(&bo.id).unwrap().is_empty() && o.db.active_runs_of(&cy.id).unwrap().is_empty(), "news starts no run");
        let err = office.ask_colleague(&sender.id, &ada, "everyone", "Who is free?", "question").unwrap_err();
        assert!(err.message.starts_with("Only news (kind info) goes to everyone."), "{}", err.message);
        drop(office);

        let employees = vec![ada.clone(), bo.clone(), cy.clone()];
        let tidy = Run::new(&bo.id, RunKind::Tidy { reason: TidyReason::Auto, signature: vec![], plan: None }, "Tidy.".into(), now());
        assert!(caught_up(&o.db, &employees, &tidy).news.is_empty(), "a tidy leaves it for real work");
        let next = Run::new(&bo.id, RunKind::Manual, "Go.".into(), now());
        let news: Vec<(String, String)> = caught_up(&o.db, &employees, &next).news.into_iter().map(|(_, who, text)| (who, text)).collect();
        assert_eq!(news, vec![("Ada".into(), "The new opening hours are up.".into()), ("Ada".into(), "We close at noon on Friday.".into())]);
        assert!(o.db.unread_news(&bo.id).unwrap().is_empty(), "read once shown");
        assert_eq!(o.db.unread_news(&cy.id).unwrap().len(), 1);
        // A run that never started gives back the news it took in, so the next one shows it.
        assert_eq!(o.db.unread_news_of(&next.id).unwrap(), 2);
        let again = Run::new(&bo.id, RunKind::Manual, "Go.".into(), now());
        assert_eq!(caught_up(&o.db, &employees, &again).news.len(), 2);
    }

    #[test]
    fn a_reports_finished_task_waits_for_the_managers_next_run() {
        let o = office();
        let ada = employee(&o.db, "Ada", None);
        let bo = employee(&o.db, "Bo", Some(&ada.id));
        let cy = employee(&o.db, "Cy", Some(&ada.id));
        let morning = run(&o.db, &ada, standup("s1"), "Stand-up.", RunState::Succeeded, 60, None);
        o.db.mark_inited(&morning.id).unwrap();
        let shelf = run(&o.db, &bo, delegated(&morning), "Count the shelf.", RunState::Succeeded, 20, None);
        let till = run(&o.db, &cy, delegated(&morning), "Count the till.", RunState::Succeeded, 10, None);
        let queued = |db: &Store| db.active_runs_of(&ada.id).unwrap();

        assert!(due_answers(&o.db, &shelf).unwrap().is_empty(), "held, not brought back at once");
        assert!(delivered(&o.db, &shelf));
        let first = queued(&o.db).remove(0);
        assert_eq!(first.kind, RunKind::Answered { asked_run_id: shelf.id.clone(), from: bo.id.clone(), task: true, chat: false, thread: None });
        assert_eq!(first.reports, vec![shelf.id.clone()]);
        assert_eq!(o.db.run(&first.id).unwrap().unwrap().session, morning.id, "it resumes the stand-up");
        assert!(first.prompt.starts_with("Bo finished the task you handed them.\n\nYour task:\n\nCount the shelf.\n\nTheir report:\n\nBo did it."), "{}", first.prompt);
        let wait = first.not_before.unwrap() - now();
        assert!(wait > chrono::Duration::minutes(29) && wait <= chrono::Duration::minutes(30), "{wait:?}");

        assert!(due_answers(&o.db, &till).unwrap().is_empty());
        let both = queued(&o.db);
        assert_eq!(both.len(), 1, "one run brings them all");
        let both = &both[0];
        assert_eq!(both.reports, vec![shelf.id.clone(), till.id.clone()]);
        assert!(both.prompt.starts_with("2 reports from your team came back after your run had ended.\n\nBo finished the task"), "{}", both.prompt);
        assert!(both.prompt.contains("\n\n---\n\nCy finished the task you handed them.\n\nYour task:\n\nCount the till."), "{}", both.prompt);
        assert!(both.not_before >= first.not_before, "a new report pushes it back");

        // A conversation with Pat leaves them, and the next run of Ada's own work takes them in, in place of the held run.
        let employees = vec![ada.clone(), bo.clone(), cy.clone()];
        let chat = Run::new(&ada.id, talk("Stock"), "How is the count going?".into(), now());
        assert!(caught_up(&o.db, &employees, &chat).held.is_empty());
        let next = run(&o.db, &ada, RunKind::Manual, "Go.", RunState::Running, 0, None);
        let took = caught_up(&o.db, &employees, &next).held;
        let said = |who: &str, task: &str| (who.to_string(), task.to_string(), format!("{who} did it."));
        assert_eq!(took, vec![said("Bo", "Count the shelf."), said("Cy", "Count the till.")]);
        assert!(o.db.run(&both.id).unwrap().is_none(), "the held run is gone");
        assert_eq!(saved(&o.db, &shelf.id).noted_in, Some(next.id.clone()));

        // That run failed, so they are held again.
        let mut failed = saved(&o.db, &next.id);
        failed.state = RunState::Failed;
        o.db.save_run(&failed).unwrap();
        assert!(due_answers(&o.db, &failed).unwrap().is_empty());
        assert_eq!(queued(&o.db).into_iter().map(|r| r.reports).collect::<Vec<_>>(), vec![vec![shelf.id.clone(), till.id.clone()]]);
        assert_eq!(saved(&o.db, &shelf.id).noted_in, None);
    }

    #[test]
    fn a_task_handed_over_in_a_conversation_comes_back_at_once() {
        let o = office();
        let ada = employee(&o.db, "Ada", None);
        let bo = employee(&o.db, "Bo", Some(&ada.id));
        let talking = run(&o.db, &ada, talk("The stock"), "Get Bo to count the shelf.", RunState::Succeeded, 30, None);
        let counted = run(&o.db, &bo, delegated(&talking), "Count the shelf.", RunState::Succeeded, 20, None);
        let due = due_answers(&o.db, &counted).unwrap();
        assert!(matches!(&due[0].0.kind, RunKind::Answered { thread: Some(t), .. } if *t == talking.id), "{due:?}");
    }

    #[test]
    fn an_answer_to_a_long_or_old_session_starts_a_fresh_one() {
        let o = office();
        let ada = employee(&o.db, "Ada", None);
        let bo = employee(&o.db, "Bo", None);
        let asker = |kind: RunKind, prompt: &str, ago: i64, context: u64| {
            let mut r = run(&o.db, &ada, kind, prompt, RunState::Succeeded, ago, None);
            r.context_tokens = Some(context);
            o.db.save_run(&r).unwrap();
            o.db.mark_inited(&r.id).unwrap();
            r
        };
        let answer_to = |parent: &Run| {
            let child = run(&o.db, &bo, asked(parent, false), "Which room?", RunState::Succeeded, 5, None);
            due_answers(&o.db, &child).unwrap().remove(0)
        };
        let (a, session) = answer_to(&asker(RunKind::Manual, "Plan the launch.", 30, 150_000));
        assert_eq!(session, a.id, "a fresh session");
        assert!(a.prompt.contains("\n\nYour run had started from:\n\nPlan the launch.\n\nYour question:"), "{}", a.prompt);
        let (a, session) = answer_to(&asker(RunKind::Manual, "Plan the week.", 2 * 24 * 60, 20_000));
        assert_eq!(session, a.id, "a session over a day old");
        let recent = asker(RunKind::Manual, "Plan the day.", 30, 20_000);
        assert_eq!(answer_to(&recent).1, recent.id, "a short, recent one resumes");
        // Never for a conversation with Pat.
        let talking = asker(talk("The offsite"), "Plan the offsite.", 3 * 24 * 60, 150_000);
        let (a, session) = answer_to(&talking);
        assert_eq!(session, talking.id);
        assert!(matches!(&a.kind, RunKind::Answered { thread: Some(t), .. } if *t == talking.id));
    }

    #[test]
    fn a_failed_answer_goes_again_twice_then_stays_failed() {
        let o = office();
        let ada = employee(&o.db, "Ada", None);
        let bo = employee(&o.db, "Bo", None);
        let parent = run(&o.db, &ada, RunKind::Manual, "Plan the launch.", RunState::Succeeded, 30, None);
        o.db.mark_inited(&parent.id).unwrap();
        let answer_for = |question: &str| {
            let child = run(&o.db, &bo, asked(&parent, false), question, RunState::Succeeded, 20, None);
            due_answers(&o.db, &child).unwrap().remove(0)
        };
        let (mut answer, session) = answer_for("Which room?");
        answer.reports = vec!["r9".into()];
        let mut tries = 0;
        loop {
            assert!(o.db.insert_run(&answer, &session).unwrap());
            answer.state = if tries == 1 { RunState::Lost } else { RunState::Failed };
            answer.ended_at = Some(now());
            o.db.save_run(&answer).unwrap();
            let Some((again, s)) = due_answers(&o.db, &answer).unwrap().pop() else { break };
            tries += 1;
            assert_eq!((&again.kind, &again.prompt, &again.reports, &s), (&answer.kind, &answer.prompt, &answer.reports, &session));
            assert_eq!(again.redelivered, tries);
            let wait = again.not_before.unwrap() - now();
            assert!(wait > chrono::Duration::minutes(9) && wait <= chrono::Duration::minutes(10), "{wait:?}");
            answer = again;
        }
        assert_eq!(tries, 2, "two more tries, then it stays failed");

        let (mut stopped, session) = answer_for("Which floor?");
        assert!(o.db.insert_run(&stopped, &session).unwrap());
        stopped.state = RunState::Cancelled;
        o.db.save_run(&stopped).unwrap();
        assert!(due_answers(&o.db, &stopped).unwrap().is_empty(), "you stopped it");
    }

    #[test]
    fn the_next_run_hears_which_cards_were_replaced_since_the_last() {
        let o = office();
        let ada = employee(&o.db, "Ada", None);
        let replaced = |message: &str, mins: i64| {
            let mut r = run(&o.db, &ada, RunKind::Manual, "Go.", RunState::Succeeded, 300, None);
            let mut card = Card::new(message, None, Some(format!("ask:card-{mins}")), CardAsk::Choices { choices: vec!["Go".into()], recommended: 0 });
            card.answer = Some(CardAnswer { at: now() - chrono::Duration::minutes(mins), how: AnswerHow::Replaced, text: String::new(), held: false });
            r.cards = vec![card];
            o.db.save_run(&r).unwrap();
        };
        replaced("Order more paper?", 180);
        replaced("Book the bigger room?", 60);
        let started = |kind: RunKind, mins: i64| {
            let mut r = run(&o.db, &ada, kind, "Go.", RunState::Succeeded, mins, None);
            r.started_at = Some(now() - chrono::Duration::minutes(mins));
            o.db.save_run(&r).unwrap();
        };
        started(RunKind::Manual, 120);
        started(RunKind::Tidy { reason: TidyReason::Auto, signature: vec![], plan: None }, 30);
        let next = run(&o.db, &ada, RunKind::Manual, "Go.", RunState::Running, 0, None);
        let said: Vec<String> = caught_up(&o.db, std::slice::from_ref(&ada), &next).replaced.into_iter().map(|(_, c)| c.message).collect();
        assert_eq!(said, vec!["Book the bigger room?".to_string()], "the last run heard of the earlier one, and a tidy hears of none");
    }

    #[tokio::test]
    async fn name_thread_names_the_thread_its_run_is_in() {
        let o = office();
        let ada = employee(&o.db, "Ada", None);
        let first = run(&o.db, &ada, talk("Can you look at the sale"), "Can you look at the sale?", RunState::Succeeded, 30, None);
        let reply = Run::new(&ada.id, RunKind::Reply { to_run_id: first.id.clone(), label: "Can you look at the sale".into(), task: true, card: false }, "And the emails?".into(), now());
        assert!(o.db.insert_run(&reply, &first.id).unwrap());
        let office = held_office(&o).await;

        assert_eq!(office.name_thread_tool(&reply.id, "  Spring sale\n emails ").unwrap(), json!({ "named": "Spring sale emails" }));
        assert_eq!(saved(&o.db, &first.id).title.as_deref(), Some("Spring sale emails"), "on the conversation's first run");
        assert_eq!(saved(&o.db, &reply.id).title, None);
        assert!(office.name_thread_tool(&reply.id, " ").unwrap_err().message.starts_with("Give the thread a name of a few words"));
        assert_eq!(office.name_thread_tool(&reply.id, &"x".repeat(61)).unwrap_err().message, "title is at most 60 characters.");
        office.name_thread_tool(&reply.id, &"x".repeat(60)).unwrap();

        // A report still being written names its own thread, and its end keeps the name.
        let report = run(&o.db, &ada, standup("s1"), "Stand-up.", RunState::Running, 5, None);
        let live = Active { token: "t".into(), employee_id: ada.id.clone(), ..Default::default() };
        lock(&office.0.active).insert(report.id.clone(), live);
        office.name_thread_tool(&report.id, "Weekly numbers").unwrap();
        assert_eq!(saved(&o.db, &report.id).title.as_deref(), Some("Weekly numbers"));
        assert_eq!(lock(&office.0.active)[&report.id].title.as_deref(), Some("Weekly numbers"));
        drop(office);
    }

    /// Records what it opens, and fails on anything ending in `.fail`.
    #[derive(Default)]
    struct Screen(Mutex<Vec<String>>);
    impl EventSink for Screen {
        fn org_changed(&self) {}
        fn run_updated(&self, _run: &Run) {}
        fn run_events(&self, _run_id: &str, _events: &[RunEvent]) {}
        fn request_updated(&self, _request: &HumanRequest) {}
        fn open(&self, target: &str) -> std::result::Result<(), String> {
            if target.ends_with(".fail") {
                return Err("its app is gone".into());
            }
            lock(&self.0).push(target.to_string());
            Ok(())
        }
    }

    #[tokio::test]
    async fn open_shows_only_what_is_in_the_office_or_a_workspace() {
        let o = office();
        let repo = o.dir.join("repo");
        fs::create_dir_all(&repo).unwrap();
        fs::write(repo.join("notes.md"), "Notes").unwrap();
        fs::write(o.dir.join("outside.md"), "Not theirs").unwrap();
        let ada = Employee { workspaces: vec![repo.to_string_lossy().into_owned()], ..employee(&o.db, "Ada", None) };
        let bo = employee(&o.db, "Bo", None);
        // Finished, so nothing is left to start: whether Pat is in a run depends on its kind alone.
        let talking = run(&o.db, &ada, talk("The report"), "Show me the report.", RunState::Succeeded, 1, None);
        let sweep = run(&o.db, &ada, standup("s1"), "Stand-up.", RunState::Succeeded, 1, None);
        let back = RunKind::Reply { to_run_id: talking.id.clone(), label: "The report".into(), task: true, card: false };
        let check = Run { check: Some("c1".into()), state: RunState::Succeeded, ..Run::new(&ada.id, back, "Check.".into(), now()) };
        assert!(o.db.insert_run(&check, &talking.id).unwrap());
        let screen = Arc::new(Screen::default());
        let office = Office::open(o.dir.clone(), screen.clone(), Build::new("0.0.0".into())).await.unwrap();
        let home = office.employee_dir(&ada.id);
        let theirs = office.employee_dir(&bo.id);
        fs::create_dir_all(home.join("workspace")).unwrap();
        fs::create_dir_all(&theirs).unwrap();
        fs::write(home.join("workspace/report.pdf"), "%PDF").unwrap();
        fs::write(home.join("workspace/broken.fail"), "x").unwrap();
        fs::write(theirs.join("draft.md"), "Bo's draft").unwrap();
        std::os::unix::fs::symlink(o.dir.join("outside.md"), home.join("link.md")).unwrap();
        let real = |p: PathBuf| fs::canonicalize(p).unwrap().to_string_lossy().into_owned();
        let open = |target: &str| office.open_tool(&talking.id, &ada, target);

        // Only where Pat is in the run: a routine, or a check back in the conversation, has nobody watching.
        for unseen in [&sweep, &check] {
            let err = office.open_tool(&unseen.id, &ada, "https://acme.example/sign-in").unwrap_err().message;
            assert_eq!(err, "Pat is not in this run, so nothing opens on their screen. Put the link on your card instead: a sign-in page goes in the chore's url.");
        }
        assert!(lock(&screen.0).is_empty());

        assert_eq!(open("https://acme.example/sign-in").unwrap(), json!({ "opened": true, "note": "It is open on Pat's screen." }));
        open(&home.join("workspace/report.pdf").to_string_lossy()).unwrap();
        open("workspace").unwrap();
        open(&repo.join("notes.md").to_string_lossy()).unwrap();
        open(&o.dir.join("employees").join("CLAUDE.md").to_string_lossy()).unwrap();
        open(&theirs.join("draft.md").to_string_lossy()).unwrap();
        let want = vec![
            "https://acme.example/sign-in".to_string(),
            real(home.join("workspace/report.pdf")),
            real(home.join("workspace")),
            real(repo.join("notes.md")),
            real(o.dir.join("employees").join("CLAUDE.md")),
            real(theirs.join("draft.md")),
        ];
        assert_eq!(*lock(&screen.0), want);

        for (target, why) in [
            ("", "Pass the full path of what to open"),
            ("http://acme.example", "Nothing is at 'http://acme.example'"),
            ("workspace/gone.pdf", "Nothing is at"),
            ("../../outside.md", "You can open what is in your folder"),
            ("link.md", "You can open what is in your folder"),
        ] {
            assert!(open(target).unwrap_err().message.starts_with(why), "{target}");
        }
        assert_eq!(open("workspace/broken.fail").unwrap_err().message, "It did not open: its app is gone. Tell Pat where it is instead.");
        assert_eq!(lock(&screen.0).len(), want.len(), "nothing it refused reached the screen");
        drop(office);

        let office = held_office(&o).await;
        assert!(office.open_tool(&talking.id, &ada, "workspace").unwrap_err().message.starts_with("It did not open: there is no screen to open it on."));
        drop(office);
    }
}
