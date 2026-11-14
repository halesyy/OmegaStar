//! Test copies of Omega Star beside the one you work in. Two guards:
//!
//! - Only a release build opens the release office. A dev or dogfood build pointed at it (OMEGASTAR_DATA_DIR, a
//!   symlink, a different case) refuses to start, since an older build that saves a row drops the fields a newer
//!   one wrote, and its runs would act as your employees.
//! - A sandboxed office never starts Claude Code, never backs up and never watches anyone, so a copy of a real
//!   office can be opened and clicked through without sending a message or touching a backup. An office is
//!   sandboxed when its folder holds `omega.sandbox` (it travels with the copy) or OMEGASTAR_SANDBOX is set.

use crate::model::{AppError, BuildChannel, Result};
use std::ffi::OsStr;
use std::path::{Component, Path, PathBuf};

/// In an office folder: this office is a sandbox, whoever opens it.
pub const MARKER: &str = "omega.sandbox";
pub const ENV: &str = "OMEGASTAR_SANDBOX";

/// The folder a release build keeps its office in when OMEGASTAR_DATA_DIR is not set.
pub fn release_dir() -> Option<PathBuf> {
    dirs::data_dir().map(|d| d.join("OmegaStar"))
}

/// Whether the office in `data_dir` is a sandbox: it holds the marker, or `env` (OMEGASTAR_SANDBOX) is set to
/// anything but empty, `0` or `false`.
pub fn is_sandbox(data_dir: &Path, env: Option<&OsStr>) -> bool {
    let set = env.map(|v| v.to_string_lossy().trim().to_ascii_lowercase()).is_some_and(|v| !v.is_empty() && v != "0" && v != "false");
    set || data_dir.join(MARKER).exists()
}

/// `is_sandbox` with this process's OMEGASTAR_SANDBOX.
pub fn sandboxed(data_dir: &Path) -> bool {
    is_sandbox(data_dir, std::env::var_os(ENV).as_deref())
}

/// Refuses to open `data_dir` from a build of `channel` when it is the release office or inside it. A release
/// build opens any folder.
pub fn check_office(channel: BuildChannel, data_dir: &Path, release_dir: Option<&Path>) -> Result<()> {
    let Some(release) = release_dir else { return Ok(()) };
    if channel == BuildChannel::Release || !within(data_dir, release) {
        return Ok(());
    }
    Err(AppError::invalid(format!(
        "This is a {} build, and {} is the office your company works in, which only a release build opens. \
         Set OMEGASTAR_DATA_DIR to a folder of its own, or copy the office with scripts/office-copy.sh.",
        format!("{channel:?}").to_lowercase(),
        data_dir.display()
    )))
}

/// Whether `p` is `root` or inside it, after resolving symlinks, and ignoring case where the file system usually
/// does (macOS, Windows).
fn within(p: &Path, root: &Path) -> bool {
    let (p, root) = (normal(&crate::backup::resolved(p)), normal(&crate::backup::resolved(root)));
    p.len() >= root.len() && p[..root.len()] == root[..]
}

fn normal(p: &Path) -> Vec<String> {
    p.components()
        .filter(|c| !matches!(c, Component::CurDir))
        .map(|c| {
            let s = c.as_os_str().to_string_lossy().into_owned();
            if cfg!(any(target_os = "macos", windows)) { s.to_lowercase() } else { s }
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::fixtures::temp_dir;
    use std::fs;

    #[test]
    fn only_a_release_build_opens_the_release_office() {
        let home = temp_dir("sandbox-release");
        let release = home.join("OmegaStar");
        fs::create_dir_all(release.join("employees")).unwrap();
        for dir in [release.clone(), release.join("employees"), release.join("not-made-yet")] {
            assert!(check_office(BuildChannel::Dev, &dir, Some(&release)).is_err(), "{}", dir.display());
            assert!(check_office(BuildChannel::Dogfood, &dir, Some(&release)).is_err(), "{}", dir.display());
            assert!(check_office(BuildChannel::Release, &dir, Some(&release)).is_ok(), "{}", dir.display());
        }
        for dir in [home.join("OmegaStar-dev"), home.join("OmegaStar-dev-feature"), home.join("OmegaStarCopy")] {
            assert!(check_office(BuildChannel::Dev, &dir, Some(&release)).is_ok(), "{}", dir.display());
        }
        assert!(check_office(BuildChannel::Dev, &release, None).is_ok(), "no data folder on this system, nothing to guard");
        let _ = fs::remove_dir_all(&home);
    }

    #[cfg(unix)]
    #[test]
    fn a_symlink_to_the_release_office_is_the_release_office() {
        let home = temp_dir("sandbox-link");
        let release = home.join("OmegaStar");
        fs::create_dir_all(&release).unwrap();
        let link = home.join("looks-harmless");
        std::os::unix::fs::symlink(&release, &link).unwrap();
        assert!(check_office(BuildChannel::Dev, &link, Some(&release)).is_err());
        assert!(check_office(BuildChannel::Dev, &link.join("runs"), Some(&release)).is_err());
        let _ = fs::remove_dir_all(&home);
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn a_different_case_is_the_same_office_on_a_mac() {
        let home = temp_dir("sandbox-case");
        let release = home.join("OmegaStar");
        fs::create_dir_all(&release).unwrap();
        assert!(check_office(BuildChannel::Dev, &home.join("omegastar"), Some(&release)).is_err());
        let _ = fs::remove_dir_all(&home);
    }

    #[test]
    fn the_marker_or_the_variable_makes_a_sandbox() {
        let dir = temp_dir("sandbox-marker");
        assert!(!is_sandbox(&dir, None));
        for off in ["", "0", "false", " FALSE "] {
            assert!(!is_sandbox(&dir, Some(OsStr::new(off))), "{off:?}");
        }
        for on in ["1", "true", "yes"] {
            assert!(is_sandbox(&dir, Some(OsStr::new(on))), "{on:?}");
        }
        fs::write(dir.join(MARKER), "").unwrap();
        assert!(is_sandbox(&dir, None));
        assert!(is_sandbox(&dir, Some(OsStr::new("0"))), "the marker travels with a copy, and a variable cannot lift it");
        let _ = fs::remove_dir_all(&dir);
    }
}
