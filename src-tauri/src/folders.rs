//! Workspace folders: the folders outside their own that an employee's runs may read and edit.
//!
//! One normaliser turns what was typed or picked (`~/dev/site`, `/Users/jack/dev/site/`) into one full path, and
//! every place that uses a workspace goes through it: saving one, `--add-dir`, and the check
//! that a card's file is in the employee's folders.

use std::path::{is_separator, Component, Path, PathBuf};

/// This computer's home folder, which `~` stands for.
pub fn home() -> PathBuf {
    dirs::home_dir().unwrap_or_default()
}

/// A workspace folder as a full path, or why it cannot be one. `~` and `~/…` become the home folder; `.`, `..`,
/// doubled and trailing separators are tidied away. It only looks at the text: whether the folder is there is
/// `check`'s job.
pub fn normalize(raw: &str) -> Result<PathBuf, String> {
    normalize_in(raw, &home())
}

fn normalize_in(raw: &str, home: &Path) -> Result<PathBuf, String> {
    let raw = raw.trim();
    if raw.is_empty() {
        return Err("is empty".into());
    }
    let path = match raw.strip_prefix('~') {
        Some("") => home.to_path_buf(),
        Some(rest) if rest.starts_with(is_separator) => home.join(rest.trim_start_matches(is_separator)),
        Some(_) => return Err("starts with ~ and a name; only ~ on its own means your home folder".into()),
        None => PathBuf::from(raw),
    };
    if !path.is_absolute() {
        return Err("is not a full path. Start it with / or ~/".into());
    }
    let mut full = PathBuf::new();
    for part in path.components() {
        match part {
            Component::CurDir => {}
            Component::ParentDir => {
                full.pop();
            }
            p => full.push(p),
        }
    }
    Ok(full)
}

/// Where a saved path is on this computer. A folder saved before workspaces were checked may still be relative: it
/// stays relative to the employee's folder, where their runs start, as it always was.
pub fn resolve(raw: &str, employee_dir: &Path) -> PathBuf {
    normalize(raw).unwrap_or_else(|_| employee_dir.join(raw.trim()))
}

/// Every saved workspace of an employee as the full path their runs use, blanks left out.
pub fn resolve_all(workspaces: &[String], employee_dir: &Path) -> Vec<PathBuf> {
    workspaces.iter().filter(|w| !w.trim().is_empty()).map(|w| resolve(w, employee_dir)).collect()
}

#[cfg(all(test, unix))]
mod tests {
    use super::*;

    fn norm(raw: &str) -> Result<String, String> {
        normalize_in(raw, Path::new("/Users/jack")).map(|p| p.to_string_lossy().into_owned())
    }

    #[test]
    fn a_tilde_becomes_the_home_folder() {
        assert_eq!(norm("~/dev/site").unwrap(), "/Users/jack/dev/site");
        assert_eq!(norm("~").unwrap(), "/Users/jack");
        assert_eq!(norm("  ~/dev/site/  ").unwrap(), "/Users/jack/dev/site");
    }

    #[test]
    fn a_full_path_is_tidied_but_kept() {
        assert_eq!(norm("/Users/jack/dev//site/./src/../").unwrap(), "/Users/jack/dev/site");
        assert_eq!(norm("/").unwrap(), "/");
        assert_eq!(norm("/../..").unwrap(), "/");
        assert_eq!(norm("/Users/jack/My Site").unwrap(), "/Users/jack/My Site");
    }

    #[test]
    fn a_relative_or_empty_folder_is_refused_with_the_reason() {
        assert!(norm("dev/site").unwrap_err().contains("not a full path"));
        assert!(norm("./site").unwrap_err().contains("not a full path"));
        assert_eq!(norm("   ").unwrap_err(), "is empty");
        assert!(norm("~bob/site").unwrap_err().contains("only ~ on its own"));
    }

    #[test]
    fn a_tilde_folder_saved_earlier_resolves_to_home_not_inside_the_employee_folder() {
        let employee = Path::new("/office/employees/e1");
        assert_eq!(resolve("~/x", employee), home().join("x"));
        assert_eq!(resolve_all(&["workspace/shared".into(), " ".into()], employee), vec![PathBuf::from("/office/employees/e1/workspace/shared")]);
    }
}
