//! Cards: what an employee asks you with the answer built in (`notify` with choices, items or chore), and
//! the fixed text your answer sends back. A card is one decision, short enough to answer from the Inbox
//! without opening anything. Pure.

use crate::claude::{clip, one_line};
use crate::model::*;
use serde_json::Value;
use std::collections::HashSet;
use std::path::Path;

/// The chore of reconnecting Claude in Chrome.
pub const CHROME: &str = "chrome";
const SIGN_IN: &str = "sign-in:";
/// A card's question, as the Inbox item's title.
pub const QUESTION_CHARS: usize = 80;
/// The one line under the question.
pub const WHY_CHARS: usize = 140;
const KEY_CHARS: usize = 60;
/// What a key an employee names is stored under, so it never meets a chore's.
const ASK: &str = "ask:";
const MAX_CHOICES: usize = 4;
/// The buttons every decision card has already, so never one of its choices.
const BUILT_IN: [&str; 2] = ["not now", "no"];
const CHOICE_CHARS: usize = 40;
const MAX_ITEMS: usize = 10;
const ITEM_ID_CHARS: usize = 20;
/// An item's text in full, never clipped: what you tick is what goes out.
const ITEM_CHARS: usize = 2000;
const ABOUT_CHARS: usize = 200;
const VERB_CHARS: usize = 20;
const NOTE_CHARS: usize = 300;
const DEFAULT_VERB: &str = "Approve";
/// Kinds of file a card shows: markdown and plain text.
const FILE_KINDS: &[&str] = &["md", "markdown", "txt"];
/// Largest file a card shows.
pub const FILE_BYTES: u64 = 200 * 1024;

/// The chore of signing in to `site`.
pub fn sign_in(site: &str) -> String {
    format!("{SIGN_IN}{site}")
}

/// A chore's subject as stored: lower case without spaces, exactly `chrome` or `sign-in:<site>`.
pub fn chore_subject(raw: &str) -> Result<String> {
    let s: String = raw.chars().filter(|c| !c.is_whitespace()).collect::<String>().to_lowercase();
    let site_ok = |site: &str| (1..=40).contains(&site.len()) && site.chars().all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '.' || c == '-');
    match s.strip_prefix(SIGN_IN) {
        _ if s == CHROME => Ok(s),
        Some(site) if site_ok(site) => Ok(sign_in(site)),
        _ => Err(AppError::invalid("chore must be 'chrome' or 'sign-in:<site>', for example 'sign-in:acme'.")),
    }
}

/// A key an employee names, as stored: lower case, spaces as dashes, under `ask:`, so `PR #12` is `ask:pr-#12`.
pub fn ask_key(raw: &str) -> Result<String> {
    let k: String = raw.trim().to_lowercase().split_whitespace().collect::<Vec<_>>().join("-");
    let k = k.strip_prefix(ASK).unwrap_or(&k).to_string();
    let ok = |c: char| c.is_ascii_lowercase() || c.is_ascii_digit() || ":#._/-".contains(c);
    if !(2..=KEY_CHARS).contains(&k.chars().count()) || !k.chars().all(ok) {
        return Err(AppError::invalid(format!(
            "key names what the card is about in 2 to {KEY_CHARS} letters, digits and : # . _ / -, e.g. 'pr:12' or 'spring-sale'."
        )));
    }
    Ok(format!("{ASK}{k}"))
}

/// A key as the employee named it, without the prefix it is stored under.
pub fn key_label(key: &str) -> &str {
    key.strip_prefix(ASK).unwrap_or(key)
}

/// The card `notify`'s arguments ask for: exactly one of choices, items and chore, a short question, an
/// optional line on why, and for a choice or a list a key naming what it is about and optionally the markdown
/// or text file it is about, as given (the caller checks where it is). An empty list or text counts as left out.
pub fn card(args: &Value) -> Result<Card> {
    let list = |k: &str| args.get(k).and_then(Value::as_array).filter(|a| !a.is_empty());
    let text = |k: &str| args.get(k).and_then(Value::as_str).map(str::trim).filter(|s| !s.is_empty());
    let message = text("message").ok_or_else(|| AppError::invalid("message is empty"))?;
    let n = message.chars().count();
    if n > QUESTION_CHARS {
        return Err(AppError::invalid(format!(
            "message is the question itself, at most {QUESTION_CHARS} characters (yours has {n}), e.g. 'Merge PR #12, the pricing page?'. \
Put the reason in why, at most {WHY_CHARS}."
        )));
    }
    if message.matches('?').count() > 1 {
        return Err(AppError::invalid("A card asks one thing. Raise one card for each decision."));
    }
    let why = text("why").map(one_line);
    if let Some(n) = why.as_ref().map(|w| w.chars().count()).filter(|n| *n > WHY_CHARS) {
        return Err(AppError::invalid(format!(
            "why is one line of at most {WHY_CHARS} characters (yours has {n}): what it changes or costs. The rest stays in your report."
        )));
    }
    let (choices, items, chore) = (list("choices"), list("items"), text("chore"));
    let ask = match (choices, items, chore) {
        (Some(c), None, None) => choices_ask(c)?,
        (None, Some(i), None) => items_ask(i, text("itemVerb"))?,
        (None, None, Some(c)) => CardAsk::Chore { subject: chore_subject(c)? },
        (None, None, None) => {
            return Err(AppError::invalid(
                "notify asks for a decision: add choices (e.g. Merge), items, or chore. Updates and results go in your report.",
            ))
        }
        _ => return Err(AppError::invalid("Use one of choices, items or chore in a card, not several.")),
    };
    let key = match (&ask, text("key")) {
        (CardAsk::Chore { .. }, _) => None,
        (_, Some(k)) => Some(ask_key(k)?),
        (_, None) => {
            return Err(AppError::invalid(
                "Add a key naming what this card is about, e.g. 'pr:12' or 'spring-sale', so asking about it again replaces this card.",
            ))
        }
    };
    let file = text("file");
    if file.is_some() && matches!(ask, CardAsk::Chore { .. }) {
        return Err(AppError::invalid("file goes with choices or items: the draft or page the decision is about."));
    }
    if file.is_some_and(|f| !shows_file(f)) {
        return Err(AppError::invalid("file must be a markdown or text file (.md or .txt), so it shows on the card."));
    }
    let mut card = Card::new(message, why, key, ask);
    card.file = file.map(String::from);
    Ok(card)
}

/// Whether a card shows the file at `path`, by its name.
fn shows_file(path: &str) -> bool {
    Path::new(path).extension().and_then(|e| e.to_str()).is_some_and(|e| FILE_KINDS.contains(&e.to_ascii_lowercase().as_str()))
}

fn choices_ask(raw: &[Value]) -> Result<CardAsk> {
    if !(1..=MAX_CHOICES).contains(&raw.len()) {
        return Err(AppError::invalid(format!("Give 1 to {MAX_CHOICES} choices.")));
    }
    let mut choices: Vec<String> = vec![];
    let mut recommended = vec![];
    for (i, c) in raw.iter().enumerate() {
        let label = c.get("label").and_then(Value::as_str).map(str::trim).unwrap_or("");
        if label.is_empty() || label.chars().count() > CHOICE_CHARS {
            return Err(AppError::invalid(format!("Each choice needs a label of 1 to {CHOICE_CHARS} characters.")));
        }
        if BUILT_IN.contains(&label.trim_end_matches(['.', '!']).to_lowercase().as_str()) {
            return Err(AppError::invalid("Every card has Not now and No built in: give only the ways to go ahead."));
        }
        if choices.iter().any(|x| x.to_lowercase() == label.to_lowercase()) {
            return Err(AppError::invalid(format!("Each choice must differ: '{label}' is there twice.")));
        }
        if c.get("recommended").and_then(Value::as_bool) == Some(true) {
            recommended.push(i);
        }
        choices.push(label.to_string());
    }
    match recommended[..] {
        [i] => Ok(CardAsk::Choices { choices, recommended: i }),
        [] if choices.len() == 1 => Ok(CardAsk::Choices { choices, recommended: 0 }),
        _ => Err(AppError::invalid("Mark exactly one choice with recommended: true: the one you recommend.")),
    }
}

fn items_ask(raw: &[Value], verb: Option<&str>) -> Result<CardAsk> {
    if raw.len() > MAX_ITEMS {
        return Err(AppError::invalid(format!("Give at most {MAX_ITEMS} items.")));
    }
    let verb = verb.unwrap_or(DEFAULT_VERB);
    if verb.chars().count() > VERB_CHARS {
        return Err(AppError::invalid(format!("itemVerb is one word of at most {VERB_CHARS} characters, e.g. 'Post'.")));
    }
    let mut ids = HashSet::new();
    let mut items = vec![];
    for i in raw {
        let field = |k: &str| i.get(k).and_then(Value::as_str).map(str::trim).unwrap_or("");
        let (id, text) = (field("id"), field("text"));
        if id.is_empty() || id.chars().count() > ITEM_ID_CHARS {
            return Err(AppError::invalid(format!("Each item needs an id of 1 to {ITEM_ID_CHARS} characters.")));
        }
        if !ids.insert(id.to_string()) {
            return Err(AppError::invalid(format!("Each item needs its own id: '{id}' is there twice.")));
        }
        if text.is_empty() {
            return Err(AppError::invalid(format!("Item '{id}' needs its text.")));
        }
        let n = text.chars().count();
        if n > ITEM_CHARS {
            return Err(AppError::invalid(format!(
                "Item '{id}': text is at most {ITEM_CHARS} characters (it has {n}). Put a longer draft in a file and ask about it on its own card."
            )));
        }
        let about = Some(one_line(field("about"))).filter(|a| !a.is_empty());
        if let Some(n) = about.as_ref().map(|a| a.chars().count()).filter(|n| *n > ABOUT_CHARS) {
            return Err(AppError::invalid(format!("Item '{id}': about is one line of at most {ABOUT_CHARS} characters (it has {n}).")));
        }
        let recommended = i.get("recommended").and_then(Value::as_bool).unwrap_or(false);
        items.push(CardItem { id: id.to_string(), text: text.to_string(), about, recommended });
    }
    Ok(CardAsk::Items { verb: verb.to_string(), items })
}

/// What Not now on a decision tells the employee.
pub const NOT_NOW: &str = "Not now: busy, not a no. Leave it as it is. Omega Star brings it back tomorrow, to ask again if it still matters.";
/// What No on a decision tells the employee.
pub const REJECTED: &str = "No. Do not do it, and do not ask again.";

/// The fixed message your answer sends to the employee, or None when it sends nothing (a dismissed chore). An
/// answer in your own words is your words as you typed them, on any card.
pub fn answer_text(ask: &CardAsk, reply: &CardReply, ceo: &str) -> Result<Option<String>> {
    let unfit = || AppError::invalid("That answer does not fit this card.");
    let text = match (ask, reply) {
        (_, CardReply::Text { text }) => Some(text.trim()).filter(|t| !t.is_empty()).ok_or_else(|| AppError::invalid("Type your answer first."))?.to_string(),
        (CardAsk::Choices { choices, .. }, CardReply::Choice { index }) => format!("Chose: {}.", choices.get(*index).ok_or_else(unfit)?),
        (CardAsk::Items { verb, items }, CardReply::Items { picks }) => items_text(verb, items, picks, ceo)?,
        (CardAsk::Choices { .. } | CardAsk::Items { .. }, CardReply::Dismiss) => NOT_NOW.into(),
        (CardAsk::Choices { .. } | CardAsk::Items { .. }, CardReply::Reject) => REJECTED.into(),
        (CardAsk::Chore { subject }, CardReply::Done) => match subject.strip_prefix(SIGN_IN) {
            Some(site) => format!("{ceo} signed in to {site}. Carry on with what was waiting on it."),
            // Done is what they say, not a check: Chrome can still be down.
            None => format!(
                "{ceo} pressed Done on reconnecting Chrome. Check with list_connected_browsers first. If Chrome is connected, carry on \
with what was waiting on it. If it is still not connected, say so in one line and stop. Do not raise another Chrome card in this run."
            ),
        },
        (CardAsk::Chore { .. }, CardReply::Dismiss) => return Ok(None),
        _ => return Err(unfit()),
    };
    Ok(Some(text))
}

/// `Post d1, d3. Skip d2 (Pat: 'too late'). No answer on d4.`, in the card's order.
fn items_text(verb: &str, items: &[CardItem], picks: &[ItemPick], ceo: &str) -> Result<String> {
    if let Some(p) = picks.iter().find(|p| !items.iter().any(|i| i.id == p.id)) {
        return Err(AppError::invalid(format!("'{}' is not on this card.", p.id)));
    }
    let (mut plain, mut noted, mut untouched) = (vec![], vec![], vec![]);
    for i in items {
        let pick = picks.iter().find(|p| p.id == i.id);
        let tick = pick.is_some_and(|p| p.tick);
        let note = pick.and_then(|p| p.note.as_deref()).map(one_line).filter(|n| !n.is_empty()).map(|n| clip(&n, NOTE_CHARS));
        match (tick, note) {
            (true, None) => plain.push(i.id.as_str()),
            (true, Some(n)) => noted.push(format!("{verb} {} ({ceo}: '{n}').", i.id)),
            (false, Some(n)) => noted.push(format!("Skip {} ({ceo}: '{n}').", i.id)),
            (false, None) => untouched.push(i.id.as_str()),
        }
    }
    if plain.is_empty() && noted.is_empty() {
        return Err(AppError::invalid("Tick or note at least one item."));
    }
    let mut parts = vec![];
    if !plain.is_empty() {
        parts.push(format!("{verb} {}.", plain.join(", ")));
    }
    parts.extend(noted);
    if !untouched.is_empty() {
        parts.push(format!("No answer on {}.", untouched.join(", ")));
    }
    Ok(parts.join(" "))
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    /// `args` with a question and a key, as most cards need.
    fn asked(mut args: Value) -> Value {
        let o = args.as_object_mut().unwrap();
        o.entry("message").or_insert(json!("Boost it?"));
        o.entry("key").or_insert(json!("boost"));
        args
    }

    fn ask_of(args: Value) -> CardAsk {
        card(&asked(args)).unwrap().ask
    }

    fn err(args: Value) -> String {
        card(&asked(args)).unwrap_err().message
    }

    #[test]
    fn choices_need_one_to_four_distinct_labels_and_one_recommendation() {
        let ok = ask_of(json!({ "choices": [{ "label": " Try it for a day " }, { "label": "Try it for a week", "recommended": true }] }));
        assert_eq!(ok, CardAsk::Choices { choices: vec!["Try it for a day".into(), "Try it for a week".into()], recommended: 1 });
        assert_eq!(ask_of(json!({ "choices": [{ "label": "Merge" }] })), CardAsk::Choices { choices: vec!["Merge".into()], recommended: 0 }, "one choice is the one recommended");
        let five: Vec<Value> = (0..5).map(|i| json!({ "label": format!("Option {i}"), "recommended": i == 0 })).collect();
        assert_eq!(err(json!({ "choices": five })), "Give 1 to 4 choices.");
        assert_eq!(err(json!({ "choices": [{ "label": "Yes" }, { "label": "Later" }] })), "Mark exactly one choice with recommended: true: the one you recommend.");
        assert_eq!(err(json!({ "choices": [{ "label": "Yes", "recommended": true }, { "label": "Later", "recommended": true }] })), "Mark exactly one choice with recommended: true: the one you recommend.");
        for built_in in ["Not now", " not now. ", "No", "NO!"] {
            let e = err(json!({ "choices": [{ "label": "Merge", "recommended": true }, { "label": built_in }] }));
            assert_eq!(e, "Every card has Not now and No built in: give only the ways to go ahead.", "{built_in}");
        }
        assert!(err(json!({ "choices": [{ "label": "Yes", "recommended": true }, { "label": "yes" }] })).contains("'yes' is there twice"));
        assert!(err(json!({ "choices": [{ "label": "Yes", "recommended": true }, { "label": " " }] })).starts_with("Each choice needs a label"));
        assert!(err(json!({ "choices": [{ "label": "Yes", "recommended": true }, { "label": "x".repeat(41) }] })).starts_with("Each choice needs a label"));
    }

    #[test]
    fn items_need_short_unique_ids_and_text() {
        let long = "y".repeat(2000);
        let about = " 1 star, 3 May:\n\"Too slow.\" ";
        let CardAsk::Items { verb, items } = ask_of(json!({ "items": [{ "id": " d1 ", "text": "Reply to the launch post", "about": about, "recommended": true }, { "id": "d2", "text": long, "about": " " }], "itemVerb": " Post " })) else { panic!("items") };
        assert_eq!(verb, "Post");
        assert_eq!(items[0], CardItem { id: "d1".into(), text: "Reply to the launch post".into(), about: Some("1 star, 3 May: \"Too slow.\"".into()), recommended: true });
        assert!(!items[1].recommended && items[1].text.chars().count() == 2000, "never clipped");
        assert_eq!(items[1].about, None, "a blank about counts as left out");
        assert!(err(json!({ "items": [{ "id": "d1", "text": "y".repeat(2001) }] })).starts_with("Item 'd1': text is at most 2000 characters (it has 2001)"));
        assert!(err(json!({ "items": [{ "id": "d1", "text": "a", "about": "y".repeat(201) }] })).starts_with("Item 'd1': about is one line of at most 200 characters (it has 201)"));
        let CardAsk::Items { verb, .. } = ask_of(json!({ "items": [{ "id": "a", "text": "One" }] })) else { panic!("items") };
        assert_eq!(verb, "Approve");
        let eleven: Vec<Value> = (0..11).map(|i| json!({ "id": format!("d{i}"), "text": "x" })).collect();
        assert_eq!(err(json!({ "items": eleven })), "Give at most 10 items.");
        assert!(err(json!({ "items": [{ "id": "d1", "text": "a" }, { "id": "d1", "text": "b" }] })).contains("'d1' is there twice"));
        assert!(err(json!({ "items": [{ "id": "x".repeat(21), "text": "a" }] })).starts_with("Each item needs an id"));
        assert_eq!(err(json!({ "items": [{ "id": "d1", "text": " " }] })), "Item 'd1' needs its text.");
        assert!(err(json!({ "items": [{ "id": "d1", "text": "a" }], "itemVerb": "x".repeat(21) })).starts_with("itemVerb"));
    }

    #[test]
    fn a_card_asks_one_short_decision() {
        let yes_no = json!([{ "label": "Merge", "recommended": true }]);
        assert!(err(json!({ "message": "FYI: signups are up." })).starts_with("notify asks for a decision"), "an update is not a card");
        assert!(err(json!({ "choices": [], "chore": "" })).starts_with("notify asks for a decision"));
        assert_eq!(
            err(json!({ "choices": [{ "label": "A", "recommended": true }, { "label": "B" }], "chore": "chrome" })),
            "Use one of choices, items or chore in a card, not several."
        );
        assert!(err(json!({ "message": "x".repeat(81), "choices": yes_no })).contains("at most 80 characters (yours has 81)"));
        assert_eq!(err(json!({ "message": "Merge #12? And #13?", "choices": yes_no })), "A card asks one thing. Raise one card for each decision.");
        assert!(err(json!({ "why": "y".repeat(141), "choices": yes_no })).starts_with("why is one line of at most 140 characters (yours has 141)"));
        let c = card(&json!({ "message": " Merge PR #12? ", "why": "Busiest page.\nReviewed.", "key": "PR #12", "choices": yes_no })).unwrap();
        assert_eq!((c.message.as_str(), c.why.as_deref(), c.key.as_deref()), ("Merge PR #12?", Some("Busiest page. Reviewed."), Some("ask:pr-#12")));
        assert!(card(&json!({ "message": "Merge PR #12?", "choices": yes_no })).unwrap_err().message.starts_with("Add a key"));
        let chore = card(&json!({ "message": "Reconnect Chrome.", "chore": "chrome" })).unwrap();
        assert_eq!(chore.key.as_deref(), Some("chore:chrome"), "a chore needs no key of its own");
    }

    #[test]
    fn a_card_can_show_the_text_file_it_is_about() {
        let yes_no = json!([{ "label": "Send", "recommended": true }]);
        let c = card(&asked(json!({ "choices": yes_no, "file": " workspace/drafts/Reply.MD " }))).unwrap();
        assert_eq!(c.file.as_deref(), Some("workspace/drafts/Reply.MD"));
        assert_eq!(card(&asked(json!({ "choices": yes_no, "file": "" }))).unwrap().file, None);
        assert!(card(&asked(json!({ "items": [{ "id": "d1", "text": "One" }], "file": "/tmp/notes.txt" }))).is_ok());
        for bad in ["workspace/drafts/reply.pdf", "workspace/drafts", "notes.md.sh"] {
            assert!(err(json!({ "choices": yes_no, "file": bad })).starts_with("file must be a markdown or text file"), "{bad}");
        }
        assert!(card(&json!({ "message": "Reconnect Chrome.", "chore": "chrome", "file": "a.md" })).unwrap_err().message.starts_with("file goes with choices or items"));
    }

    #[test]
    fn keys_are_short_plain_names() {
        assert_eq!(ask_key(" ask:Spring  Sale ").unwrap(), "ask:spring-sale");
        assert_eq!(key_label("ask:pr:12"), "pr:12");
        for bad in ["x", "pr 12!", &"k".repeat(61)] {
            assert!(ask_key(bad).unwrap_err().message.starts_with("key names what the card is about"), "{bad}");
        }
    }

    #[test]
    fn a_chore_is_chrome_or_a_sign_in() {
        assert_eq!(ask_of(json!({ "chore": "Sign-In: Acme" })), CardAsk::Chore { subject: "sign-in:acme".into() });
        assert_eq!(chore_subject(" Chrome ").unwrap(), CHROME);
        assert_eq!(chore_subject("sign-in:app.example-bank.com").unwrap(), sign_in("app.example-bank.com"));
        for bad in ["gmail", "account", "sign-in:", "sign-in:acme/login", &format!("sign-in:{}", "a".repeat(41))] {
            assert_eq!(chore_subject(bad).unwrap_err().message, "chore must be 'chrome' or 'sign-in:<site>', for example 'sign-in:acme'.", "{bad}");
        }
    }

    fn items() -> CardAsk {
        let item = |id: &str| CardItem { id: id.into(), text: format!("Draft {id}"), about: None, recommended: false };
        CardAsk::Items { verb: "Post".into(), items: vec![item("d1"), item("d2"), item("d3"), item("d4")] }
    }

    fn pick(id: &str, tick: bool, note: Option<&str>) -> ItemPick {
        ItemPick { id: id.into(), tick, note: note.map(String::from) }
    }

    #[test]
    fn answers_are_fixed_text() {
        let choices = CardAsk::Choices { choices: vec!["Try it".into(), "Try it for a week".into()], recommended: 0 };
        assert_eq!(answer_text(&choices, &CardReply::Choice { index: 0 }, "Pat").unwrap().as_deref(), Some("Chose: Try it."));
        assert_eq!(answer_text(&choices, &CardReply::Choice { index: 2 }, "Pat").unwrap_err().message, "That answer does not fit this card.");
        for ask in [&choices, &items()] {
            assert_eq!(answer_text(ask, &CardReply::Dismiss, "Pat").unwrap().as_deref(), Some(NOT_NOW));
            assert_eq!(answer_text(ask, &CardReply::Reject, "Pat").unwrap().as_deref(), Some(REJECTED));
        }
        assert!(answer_text(&choices, &CardReply::Done, "Pat").is_err());

        let picks = vec![pick("d1", true, None), pick("d2", false, Some("too late")), pick("d3", true, Some(" ")), pick("d4", false, None)];
        assert_eq!(
            answer_text(&items(), &CardReply::Items { picks }, "Pat").unwrap().as_deref(),
            Some("Post d1, d3. Skip d2 (Pat: 'too late'). No answer on d4.")
        );
        let noted = vec![pick("d2", true, Some("shorter"))];
        assert_eq!(answer_text(&items(), &CardReply::Items { picks: noted }, "Pat").unwrap().as_deref(), Some("Post d2 (Pat: 'shorter'). No answer on d1, d3, d4."));
        assert_eq!(answer_text(&items(), &CardReply::Items { picks: vec![pick("d1", false, None)] }, "Pat").unwrap_err().message, "Tick or note at least one item.");
        assert_eq!(answer_text(&items(), &CardReply::Items { picks: vec![pick("d9", true, None)] }, "Pat").unwrap_err().message, "'d9' is not on this card.");

        let chrome = CardAsk::Chore { subject: CHROME.into() };
        let back = answer_text(&chrome, &CardReply::Done, "Pat").unwrap().unwrap();
        assert!(back.starts_with("Pat pressed Done on reconnecting Chrome. Check with list_connected_browsers first."), "{back}");
        assert!(back.contains("If it is still not connected, say so in one line and stop. Do not raise another Chrome card"), "{back}");
        let acme = CardAsk::Chore { subject: sign_in("acme") };
        assert_eq!(answer_text(&acme, &CardReply::Done, "Pat").unwrap().as_deref(), Some("Pat signed in to acme. Carry on with what was waiting on it."));
        assert_eq!(answer_text(&acme, &CardReply::Dismiss, "Pat").unwrap(), None);
        assert!(answer_text(&acme, &CardReply::Reject, "Pat").is_err(), "a chore is done or not now");
        assert!(answer_text(&acme, &CardReply::Choice { index: 0 }, "Pat").is_err());

        let typed = CardReply::Text { text: " Only after the copy fix lands. ".into() };
        for ask in [&choices, &items(), &acme] {
            assert_eq!(answer_text(ask, &typed, "Pat").unwrap().as_deref(), Some("Only after the copy fix lands."), "your words on any card");
        }
        assert_eq!(answer_text(&choices, &CardReply::Text { text: " ".into() }, "Pat").unwrap_err().message, "Type your answer first.");
        assert!(answer_text(&choices, &CardReply::Ask { text: "Why?".into() }, "Pat").is_err(), "a question answers nothing");
    }
}
