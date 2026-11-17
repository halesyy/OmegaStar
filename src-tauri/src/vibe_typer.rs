//! Vibe Typer, voice typing from the same maker: when it last put dictated words into Omega Star.
//!
//! After each insertion Vibe Typer records the app it typed into in its own settings file,
//! `<config dir>/vibe-typer/config.json`, at `user.textInsertion.paste.recentTargets`: `{ id, name, lastUsed }`, with
//! `lastUsed` in milliseconds since the Unix epoch. Only that list is read; nothing else in the folder is opened.

use serde_json::Value;

/// When Vibe Typer last inserted text into Omega Star, in milliseconds since the Unix epoch. `None` when it is not
/// installed, has never typed here, or its settings cannot be read.
pub fn last_dictation_here() -> Option<u64> {
    let path = dirs::config_dir()?.join("vibe-typer").join("config.json");
    last_dictation(&std::fs::read_to_string(path).ok()?)
}

/// The newest `lastUsed` among the recent targets in Vibe Typer's settings text that are Omega Star (`is_omega_star`).
/// `None` for text that is not that shape.
fn last_dictation(config_json: &str) -> Option<u64> {
    let config: Value = serde_json::from_str(config_json).ok()?;
    let targets = config.pointer("/user/textInsertion/paste/recentTargets")?.as_array()?;
    targets
        .iter()
        .filter(|t| ["id", "name"].iter().any(|k| t.get(k).and_then(Value::as_str).is_some_and(is_omega_star)))
        .filter_map(|t| t.get("lastUsed")?.as_u64())
        .max()
}

/// Whether an app's id or name is Omega Star's on any desktop: lowercased, with everything but ASCII letters and digits
/// dropped, it contains `omegastar`. That covers the Mac's bundle ids (`com.abramindustries.omegastar`), the Windows exe
/// (`omega-star`), the Linux window class (`omegastar`, `omega-star`) and the name "Omega Star".
fn is_omega_star(id_or_name: &str) -> bool {
    let plain: String = id_or_name.chars().filter(char::is_ascii_alphanumeric).map(|c| c.to_ascii_lowercase()).collect();
    plain.contains("omegastar")
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Vibe Typer's settings text with these recent targets.
    fn config(targets: &str) -> String {
        format!(r#"{{ "user": {{ "theme": "dark", "textInsertion": {{ "paste": {{ "recentTargets": [{targets}] }} }} }} }}"#)
    }

    #[test]
    fn omega_star_is_found_by_the_id_each_desktop_records() {
        for id in ["com.abramindustries.omegastar", "one.omegastar.app", "omega-star", "omegastar"] {
            let text = config(&format!(r#"{{ "id": "{id}", "name": "", "lastUsed": 1763337354000 }}"#));
            assert_eq!(last_dictation(&text), Some(1763337354000), "{id}");
        }
    }

    #[test]
    fn omega_star_is_found_by_its_name_alone() {
        let text = config(r#"{ "id": "app-4021", "name": "Omega Star", "lastUsed": 1763337354000 }"#);
        assert_eq!(last_dictation(&text), Some(1763337354000));
    }

    #[test]
    fn the_newest_of_two_omega_star_entries_counts() {
        let text = config(
            r#"{ "id": "one.omegastar.app", "name": "Omega Star", "lastUsed": 1763000000000 },
               { "id": "com.abramindustries.omegastar", "name": "Omega Star", "lastUsed": 1763337354000 }"#,
        );
        assert_eq!(last_dictation(&text), Some(1763337354000));
    }

    #[test]
    fn another_app_used_since_is_ignored() {
        let text = config(
            r#"{ "id": "com.apple.mail", "name": "Mail", "lastUsed": 1763339999000 },
               { "id": "com.abramindustries.omegastar", "name": "Omega Star", "lastUsed": 1763337354000 }"#,
        );
        assert_eq!(last_dictation(&text), Some(1763337354000));
    }

    #[test]
    fn nothing_without_an_omega_star_entry() {
        assert_eq!(last_dictation(&config(r#"{ "id": "com.apple.mail", "name": "Mail", "lastUsed": 1763339999000 }"#)), None);
        assert_eq!(last_dictation(&config("")), None);
    }

    #[test]
    fn nothing_from_text_of_another_shape() {
        assert_eq!(last_dictation(r#"{ "user": { "textInsertion": {} } }"#), None, "no recent targets");
        assert_eq!(last_dictation(r#"{ "user": { "textInsertion": { "paste": { "recentTargets": {} } } } }"#), None, "not a list");
        assert_eq!(last_dictation(&config(r#"{ "id": "omega-star", "name": "Omega Star" }"#)), None, "no lastUsed");
        assert_eq!(last_dictation(&config(r#"{ "id": "omega-star", "lastUsed": "yesterday" }"#)), None, "lastUsed not a number");
        assert_eq!(last_dictation(r#"{ "user": { "textInsertion": "#), None, "malformed");
        assert_eq!(last_dictation(""), None, "empty");
    }
}
