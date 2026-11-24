//! Quick ask: a shortcut that opens a small box over any app, to message someone on the team. The box is the app's
//! own page in a second window (`?window=quick-ask`), and sends as a conversation does. Settings > Running turns it on.

use crate::log::log;
use tauri::plugin::TauriPlugin;
use tauri::{AppHandle, Manager, WebviewUrl, WebviewWindowBuilder, Wry};
use tauri_plugin_global_shortcut::{GlobalShortcutExt, Shortcut, ShortcutState};

/// ⌘⇧I on a Mac. Elsewhere Alt+Shift+I, because Ctrl+Shift+I opens the developer tools in every browser and in apps
/// built on one, and Ctrl+Alt is AltGr on many keyboards, which types letters. Settings shows it (`QUICK_ASK_KEYS`).
#[cfg(target_os = "macos")]
const SHORTCUT: &str = "Cmd+Shift+I";
#[cfg(not(target_os = "macos"))]
const SHORTCUT: &str = "Alt+Shift+I";

/// The box's window.
pub const WINDOW: &str = "quick-ask";

fn shortcut() -> Shortcut {
    SHORTCUT.parse().expect("SHORTCUT is a valid shortcut")
}

/// Listens for the shortcut once `apply` registers it.
pub fn plugin() -> TauriPlugin<Wry> {
    tauri_plugin_global_shortcut::Builder::new()
        .with_handler(|app, _, event| {
            if event.state() == ShortcutState::Pressed {
                toggle(app);
            }
        })
        .build()
}

/// Holds the shortcut while quick ask is on, and gives it back to other apps while it is off. Another app holding
/// it already is logged, not an error: the setting stays as you set it.
pub fn apply(app: &AppHandle, on: bool) {
    let keys = app.global_shortcut();
    let held = keys.is_registered(shortcut());
    let done = match (on, held) {
        (true, false) => keys.register(shortcut()),
        (false, true) => keys.unregister(shortcut()),
        _ => Ok(()),
    };
    if let Err(e) = done {
        log!("could not {} the quick ask shortcut {SHORTCUT}: {e}", if on { "take" } else { "free" });
    }
    if let Some(w) = app.get_webview_window(WINDOW).filter(|_| !on) {
        let _ = w.hide();
    }
}

/// Opens the box in front of whatever you are using, or hides it when it is already in front. It is made the first
/// time and kept after, hidden, so a draft you left survives.
fn toggle(app: &AppHandle) {
    let w = match app.get_webview_window(WINDOW) {
        Some(w) => w,
        None => {
            let made = WebviewWindowBuilder::new(app, WINDOW, WebviewUrl::App("index.html?window=quick-ask".into()))
                .title("Quick ask")
                .inner_size(560.0, 120.0)
                .resizable(false)
                .decorations(false)
                .always_on_top(true)
                .skip_taskbar(true)
                .visible_on_all_workspaces(true)
                .center()
                .visible(false)
                .build();
            match made {
                Ok(w) => w,
                Err(e) => return log!("could not open the quick ask box: {e}"),
            }
        }
    };
    if w.is_visible().unwrap_or(false) && w.is_focused().unwrap_or(false) {
        let _ = w.hide();
    } else {
        let _ = w.center();
        let _ = w.show();
        let _ = w.set_focus();
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_shortcut_is_one_every_desktop_accepts() {
        let s = shortcut();
        assert_eq!(s.key, tauri_plugin_global_shortcut::Code::KeyI);
        assert!(s.mods.contains(tauri_plugin_global_shortcut::Modifiers::SHIFT));
    }
}
