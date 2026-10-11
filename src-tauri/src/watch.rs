//! Watching requests to people for replies: when to check, nudge and give up, counted in business
//! hours; what a send reported; which messages could be the reply; what a verdict does to a request.
//! Pure: the clock, the time zone and the settings are parameters.

use crate::claude::{clip, result_text};
use crate::model::*;
use chrono::{DateTime, Datelike, Duration, NaiveDate, TimeZone, Timelike, Utc};
use serde_json::{Map, Value};
use std::collections::{HashMap, VecDeque};

/// The longest a failing check backs off to, unless its interval is already longer.
const BACKOFF_CAP: Duration = Duration::hours(8);

/// What a send reported, through `sent` or in the asking run's transcript.
#[derive(Debug, Clone, PartialEq)]
pub struct Sent {
    pub locator: Locator,
    pub sender_id: Option<String>,
    pub sent_at: Ts,
    pub via: String,
}

/// A chat message as the native reader returns it.
#[derive(Debug, Clone, PartialEq)]
pub struct ChatMessage {
    pub id: String,
    pub at: Ts,
    pub from_id: Option<String>,
    pub from_name: String,
    pub text: String,
}

impl Delivery {
    /// The only way to build one: an FYI is never watched, anything else starts watching.
    pub fn new(sent: Sent, source: DeliverySource, kind: RequestKind) -> Delivery {
        let watch = (kind != RequestKind::Info).then_some(Watch {
            phase: WatchPhase::Watching,
            resumed_at: None,
            last_checked_at: None,
            failures: 0,
            last_error: None,
            seen: None,
            heard: None,
            nudged_at: None,
            plan: None,
        });
        Delivery { locator: sent.locator, sender_id: sent.sender_id, sent_at: sent.sent_at, via: sent.via, source, watch }
    }
}

/// What `plan` needs to know about a watched request.
#[derive(Debug, Clone, PartialEq)]
pub struct Facts {
    /// Your last Resume, else when it was sent.
    pub start: Ts,
    pub due_at: Option<Ts>,
    pub last_checked_at: Option<Ts>,
    pub failures: u32,
    pub nudged: bool,
    /// When the person last said they would get to it.
    pub acked_at: Option<Ts>,
    /// The Office reads the channel itself.
    pub native: bool,
}

impl Facts {
    /// None unless the request is open, delivered and being watched.
    pub fn of(r: &HumanRequest) -> Option<Facts> {
        if !r.state.is_open() {
            return None;
        }
        let d = r.delivery.as_ref()?;
        let w = d.watch.as_ref()?;
        if w.phase != WatchPhase::Watching {
            return None;
        }
        Some(Facts {
            start: w.resumed_at.unwrap_or(d.sent_at),
            due_at: r.due_at,
            last_checked_at: w.last_checked_at,
            failures: w.failures,
            nudged: w.nudged_at.is_some(),
            acked_at: w.heard.as_ref().filter(|h| h.verdict == Verdict::Acknowledged).map(|h| h.at),
            native: matches!(d.locator, Locator::TeamsChat { server: Some(_), .. }),
        })
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Due {
    Nothing,
    Check,
    Nudge,
    GiveUp,
}

impl WatchPlan {
    /// Giving up comes before a nudge and a nudge before a check, so after a long shutdown nobody is
    /// nudged and then dropped in the same minute.
    pub fn due(&self, now: Ts) -> Due {
        if now >= self.give_up_at {
            Due::GiveUp
        } else if self.nudge_at.is_some_and(|n| now >= n) {
            Due::Nudge
        } else if now >= self.next_check_at {
            Due::Check
        } else {
            Due::Nothing
        }
    }
}

/// How long after the previous check the next one falls, by how long the request has waited.
fn interval(age: Duration, native: bool, in_hours: bool, s: &WatchSettings, failures: u32) -> Duration {
    let row = if age < Duration::hours(2) {
        0
    } else if age < Duration::hours(8) {
        1
    } else if age < Duration::days(3) {
        2
    } else {
        3
    };
    let minutes = match (native, in_hours) {
        (true, true) => [5, 15, 30, 60][row],
        (true, false) => [15, 60, 120, 240][row],
        (false, _) => [60, 60, 180, 480][row],
    };
    let base = Duration::minutes(minutes);
    let base = match s.frequency {
        CheckFrequency::Eager => (base / 2).max(Duration::minutes(if native { 2 } else { 30 })),
        CheckFrequency::Normal => base,
        CheckFrequency::Relaxed => base * 2,
    };
    (base * 2i32.pow(failures.min(4))).min(base.max(BACKOFF_CAP))
}

/// When the next check, the nudge and the give-up fall. Independent of the current time, so the
/// card's "next check" does not drift between reads.
pub fn plan<Tz: TimeZone>(f: &Facts, s: &WatchSettings, tz: &Tz) -> WatchPlan {
    let h = &s.hours;
    let base = f.acked_at.map_or(f.start, |a| a.max(f.start));
    let prev = f.last_checked_at.unwrap_or(f.start);
    let next = prev + interval((prev - f.start).max(Duration::zero()), f.native, in_hours(prev, h, tz), s, f.failures);
    let next_check_at = if f.native { next } else { open_at(next, h, tz) };
    let nudge_at = (s.nudge_after_days > 0 && !f.nudged).then(|| match f.due_at {
        Some(due) if due > base => open_at(due, h, tz),
        _ => add_business_days(base, s.nudge_after_days, h, tz),
    });
    let give_up_at = add_business_days(f.due_at.map_or(base, |d| d.max(base)), s.give_up_after_days, h, tz);
    WatchPlan { next_check_at, nudge_at, give_up_at }
}

fn is_business_day(date: NaiveDate, h: &BusinessHours) -> bool {
    h.days.contains(&(date.weekday().number_from_monday() as u8))
}

pub fn in_hours<Tz: TimeZone>(t: Ts, h: &BusinessHours, tz: &Tz) -> bool {
    let local = t.with_timezone(tz);
    let minute = local.hour() * 60 + local.minute();
    is_business_day(local.date_naive(), h) && u32::from(h.start_minute) <= minute && minute < u32::from(h.end_minute)
}

/// `minute` minutes into `date` on the local clock. A time the clock skips at a change moves to the
/// first instant after the gap.
fn at_minute<Tz: TimeZone>(date: NaiveDate, minute: u16, tz: &Tz) -> Ts {
    let mut naive = date.and_hms_opt(0, 0, 0).unwrap() + Duration::minutes(minute.into());
    for _ in 0..8 {
        if let Some(t) = tz.from_local_datetime(&naive).earliest() {
            return t.with_timezone(&Utc);
        }
        naive += Duration::minutes(15);
    }
    naive.and_utc()
}

/// `t` itself when it is inside business hours, else the next opening.
fn open_at<Tz: TimeZone>(t: Ts, h: &BusinessHours, tz: &Tz) -> Ts {
    if in_hours(t, h, tz) {
        return t;
    }
    let local = t.with_timezone(tz);
    let before_opening = local.hour() * 60 + local.minute() < u32::from(h.start_minute);
    (0..=7)
        .map(|d| local.date_naive() + Duration::days(d))
        .filter(|date| is_business_day(*date, h))
        .find(|date| *date != local.date_naive() || before_opening)
        .map_or(t, |date| at_minute(date, h.start_minute, tz))
}

/// Moves `t` forward by `days` business days of open time: Fri 4 pm + 1 day = Mon 4 pm with 9 to 5
/// hours. A start outside hours counts from the next opening, and an end at closing time moves to
/// the next opening.
fn add_business_days<Tz: TimeZone>(t: Ts, days: u32, h: &BusinessHours, tz: &Tz) -> Ts {
    let mut left = Duration::minutes(i64::from(days) * (i64::from(h.end_minute) - i64::from(h.start_minute)));
    let mut at = open_at(t, h, tz);
    for _ in 0..=days * 2 + 7 {
        let close = at_minute(at.with_timezone(tz).date_naive(), h.end_minute, tz);
        let open = close - at;
        if left < open {
            return at + left;
        }
        left -= open;
        at = open_at(close, h, tz);
    }
    at
}

/// The MCP server a tool belongs to (`mcp__<server>__<tool>`), when the Office could launch it: never
/// `omega` itself, nor a claude.ai connector.
pub fn server_of(tool: &str) -> Option<String> {
    let (server, name) = tool.strip_prefix("mcp__")?.split_once("__")?;
    let launchable = !server.is_empty() && !name.is_empty() && server != "omega" && !server.starts_with("claude_ai_");
    launchable.then(|| server.to_string())
}

/// The first JSON object in `text`, wherever it starts and whatever follows it.
fn first_object(text: &str) -> Option<Map<String, Value>> {
    text.match_indices('{').take(50).find_map(|(i, _)| match serde_json::Deserializer::from_str(&text[i..]).into_iter::<Value>().next() {
        Some(Ok(Value::Object(o))) => Some(o),
        _ => None,
    })
}

/// What a send tool's result says about where the ask went. A Teams `send-chat-message` (the
/// Microsoft 365 MCP server's, the one `reader` reads back) returns the created message (`id`,
/// `chatId`, `createdDateTime`, `from.user.id`); anything else is kept as text.
pub fn parse_sent(tool: &str, result: &str, now: Ts) -> Sent {
    let teams = if tool.ends_with("send-chat-message") { first_object(result) } else { None }.and_then(|o| {
        let text = |k: &str| o.get(k).and_then(|v| v.as_str()).map(String::from);
        let sent_at = DateTime::parse_from_rfc3339(&text("createdDateTime")?).ok()?.with_timezone(&Utc);
        let sender = o.get("from").and_then(|f| f.get("user")).and_then(|u| u.get("id")).and_then(|v| v.as_str()).map(String::from);
        Some((Locator::TeamsChat { chat_id: text("chatId")?, message_id: text("id")?, server: server_of(tool) }, sender, sent_at))
    });
    match teams {
        Some((locator, sender_id, sent_at)) => Sent { locator, sender_id, sent_at, via: tool.to_string() },
        None => Sent { locator: Locator::Other { text: clip(result, 300) }, sender_id: None, sent_at: now, via: tool.to_string() },
    }
}

/// The deliveries a run's transcript shows for requests it made and did not report sending. Each
/// successful `send-chat-message` whose result is a Teams message goes with the oldest of those
/// requests still waiting, in the order the run made them; a send with none waiting is ignored, and
/// so is a send of a message in `claimed`, already recorded as another request's delivery.
/// Returns (request id, tool, result).
pub fn capture(transcript: &str, undelivered: &[String], claimed: &[String]) -> Vec<(String, String, String)> {
    let mut waiting: VecDeque<String> = VecDeque::new();
    let mut sends: HashMap<String, String> = HashMap::new();
    let mut out: Vec<(String, String, String)> = vec![];
    for line in transcript.lines() {
        let Ok(v) = serde_json::from_str::<Value>(line) else { continue };
        let blocks = v["message"]["content"].as_array().cloned().unwrap_or_default();
        match v["type"].as_str() {
            Some("omega") if v["event"]["type"] == "requested" => {
                let Some(id) = v["event"]["requestId"].as_str() else { continue };
                let known = waiting.iter().any(|w| w == id) || out.iter().any(|(r, _, _)| r == id);
                if undelivered.iter().any(|u| u == id) && !known {
                    waiting.push_back(id.to_string());
                }
            }
            Some("assistant") => {
                for b in blocks.iter().filter(|b| b["type"] == "tool_use") {
                    if let (Some(id), Some(name)) = (b["id"].as_str(), b["name"].as_str()) {
                        if name.ends_with("send-chat-message") {
                            sends.insert(id.to_string(), name.to_string());
                        }
                    }
                }
            }
            Some("user") => {
                for b in blocks.iter().filter(|b| b["type"] == "tool_result" && !b["is_error"].as_bool().unwrap_or(false)) {
                    let Some(tool) = b["tool_use_id"].as_str().and_then(|id| sends.get(id)) else { continue };
                    let result = result_text(&b["content"]);
                    match parse_sent(tool, &result, DateTime::UNIX_EPOCH).locator {
                        Locator::TeamsChat { message_id, .. } if !claimed.contains(&message_id) => {}
                        _ => continue,
                    }
                    if let Some(request) = waiting.pop_front() {
                        out.push((request, tool.clone(), result));
                    }
                }
            }
            _ => {}
        }
    }
    out
}

/// The sending account: the one recorded with the delivery, else the author of the delivered message.
pub fn sender_of<'a>(messages: &'a [ChatMessage], d: &'a Delivery) -> Option<&'a str> {
    d.sender_id.as_deref().or_else(|| match &d.locator {
        Locator::TeamsChat { message_id, .. } => messages.iter().find(|m| &m.id == message_id).and_then(|m| m.from_id.as_deref()),
        Locator::Other { .. } => None,
    })
}

/// Every message after the ask and after `seen`, other than the ask itself, oldest first.
pub fn after_ask(messages: &[ChatMessage], d: &Delivery, seen: Option<&Seen>) -> Vec<ChatMessage> {
    let anchor = match &d.locator {
        Locator::TeamsChat { message_id, .. } => Some(message_id.as_str()),
        Locator::Other { .. } => None,
    };
    let mut v: Vec<ChatMessage> = messages
        .iter()
        .filter(|m| m.at > d.sent_at && Some(m.id.as_str()) != anchor && seen.is_none_or(|s| m.at > s.at && m.id != s.id))
        .cloned()
        .collect();
    v.sort_by_key(|m| m.at);
    v
}

/// The messages that could be the person's reply, oldest first: those after the ask and after `seen`
/// that the sending account did not write. With no sender known, nobody is left out: the judge sees the names.
pub fn replies(messages: &[ChatMessage], d: &Delivery, seen: Option<&Seen>) -> Vec<ChatMessage> {
    let sender = sender_of(messages, d);
    after_ask(messages, d, seen).into_iter().filter(|m| sender.is_none() || m.from_id.as_deref() != sender).collect()
}

#[derive(Debug, Clone, PartialEq)]
pub enum Applied {
    /// The request moved on while it was read or judged, or these messages were already judged.
    Stale,
    /// Still watching; the cursor moved.
    Kept,
    /// The caller resolves the request with this state and response.
    Resolve { state: RequestState, response: String },
}

/// What a verdict on the messages up to `through` does to a fresh copy of the request. `response` is
/// the person's messages since the ask, the reply a resolved request keeps.
pub fn apply_verdict(r: &mut HumanRequest, through: &Seen, heard: Heard, response: &str) -> Applied {
    let open = r.state.is_open();
    let Some(d) = r.delivery.as_mut() else { return Applied::Stale };
    let before_ask = through.at < d.sent_at;
    let Some(w) = d.watch.as_mut() else { return Applied::Stale };
    let judged = w.seen.as_ref().is_some_and(|s| s.id == through.id || s.at >= through.at);
    if !open || w.phase != WatchPhase::Watching || before_ask || judged {
        return Applied::Stale;
    }
    w.seen = Some(through.clone());
    w.failures = 0;
    w.last_error = None;
    let verdict = heard.verdict;
    if verdict != Verdict::NoReply {
        w.heard = Some(Heard { text: clip(&heard.text, 500), ..heard });
    }
    let response = clip(response, 4000);
    match verdict {
        Verdict::Answered | Verdict::AskedBack => Applied::Resolve { state: RequestState::Answered, response },
        Verdict::Done => Applied::Resolve { state: RequestState::Done, response },
        Verdict::Acknowledged | Verdict::NoReply => Applied::Kept,
    }
}
