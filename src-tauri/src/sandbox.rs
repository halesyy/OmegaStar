//! Test copies of Omega Star beside the one you work in. Two guards:
//!
//! - Only a release build opens the release office. A dev or dogfood build pointed at it (OMEGASTAR_DATA_DIR, a
//!   symlink, a different case) refuses to start, since an older build that saves a row drops the fields a newer
//!   one wrote, and its runs would act as your employees.
//! - A sandboxed office never starts Claude Code, never backs up and never watches anyone, so a copy of a real
//!   office can be opened and clicked through without sending a message or touching a backup. An office is
//!   sandboxed when its folder holds `omega.sandbox`, which travels with the copy.

use crate::backup::resolved;
use crate::model::{AppError, BuildChannel, Result};
use std::path::{Path, PathBuf};

/// In an office folder: this office is a sandbox, whoever opens it.
pub const MARKER: &str = "omega.sandbox";

/// The folder a release build keeps its office in when OMEGASTAR_DATA_DIR is not set.
pub fn release_dir() -> Option<PathBuf> {
    dirs::data_dir().map(|d| d.join("OmegaStar"))
}

/// Whether the office in `data_dir` is a sandbox: it holds the marker.
pub fn is_sandbox(data_dir: &Path) -> bool {
    data_dir.join(MARKER).exists()
}

/// Refuses to open `data_dir` from a build of `channel` when it is the release office or inside it, whatever
/// symlinks or capitals the path goes through (`resolved`). A release build opens any folder.
pub fn check_office(channel: BuildChannel, data_dir: &Path, release_dir: Option<&Path>) -> Result<()> {
    let Some(release) = release_dir else { return Ok(()) };
    if channel == BuildChannel::Release || !resolved(data_dir).starts_with(resolved(release)) {
        return Ok(());
    }
    Err(AppError::invalid(format!(
        "This is a {} build, and {} is the office your company works in, which only a release build opens. \
         Set OMEGASTAR_DATA_DIR to a folder of its own, or copy the office with scripts/office-copy.sh.",
        format!("{channel:?}").to_lowercase(),
        data_dir.display()
    )))
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
}
