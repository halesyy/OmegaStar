//! Office backups: one zip of the office folder per backup, with a consistent database snapshot in
//! place of the live `office.db`, pruned to the newest few. File work only; the Office decides when.

use crate::model::*;
use crate::own_skills;
use chrono::{DateTime, Datelike, Duration, Local, NaiveDateTime, Timelike};
use std::fs::{self, File};
use std::io::{BufWriter, ErrorKind, Read, Write};
use std::path::{Path, PathBuf};
use zip::write::SimpleFileOptions;
use zip::{CompressionMethod, ZipWriter};

const PREFIX: &str = "OmegaStar-backup-";
const EXT: &str = ".zip";
const STAMP: &str = "%Y%m%d-%H%M%S";
/// A backup being written; renamed to its final name only once complete.
pub const PARTIAL: &str = ".partial";
/// The live database and its journals. The snapshot goes in as `office.db` instead.
const DB_FILES: [&str; 4] = ["office.db", "office.db-wal", "office.db-shm", "office.db-journal"];
pub const RESTORE_STEPS: &str = "Quit Omega Star from the tray, replace the contents of the office folder with the contents \
of this zip, then start Omega Star.";

impl From<zip::result::ZipError> for AppError {
    fn from(e: zip::result::ZipError) -> Self {
        AppError::internal(format!("zip: {e}"))
    }
}

pub fn file_name(at: DateTime<Local>) -> String {
    format!("{PREFIX}{}{EXT}", at.format(STAMP))
}

fn is_backup_name(name: &str) -> bool {
    name.strip_prefix(PREFIX)
        .and_then(|r| r.strip_suffix(EXT))
        .is_some_and(|stamp| stamp.len() == 15 && NaiveDateTime::parse_from_str(stamp, STAMP).is_ok())
}

/// When the next automatic backup is due: an interval after the last success, but no sooner than an
/// hour (or the interval, if shorter) after a failed attempt. `None` when backups are off.
pub fn next_at(freq: BackupFrequency, st: &BackupStatus, now: Ts) -> Option<Ts> {
    let interval = freq.interval()?;
    // A clock set far back would otherwise hold backups off until it caught up.
    let due = st.last_at.map(|t| t + interval).filter(|t| *t <= now + interval);
    let retry = st.last_error.as_ref().and(st.last_attempt_at).map(|t| t + interval.min(Duration::hours(1)));
    Some(match (due, retry) {
        (Some(d), Some(r)) => d.max(r),
        (d, r) => d.or(r).unwrap_or(now),
    })
}

pub fn is_due(freq: BackupFrequency, st: &BackupStatus, now: Ts) -> bool {
    next_at(freq, st, now).is_some_and(|t| t <= now)
}

/// The existing part of `p` resolved (symlinks, case, 8.3 names), with the rest appended as given.
fn resolved(p: &Path) -> PathBuf {
    let mut rest = Vec::new();
    let mut cur = p;
    loop {
        if let Ok(c) = fs::canonicalize(cur) {
            return rest.iter().rev().fold(c, |acc, part| acc.join(part));
        }
        match (cur.parent(), cur.file_name()) {
            (Some(parent), Some(name)) => {
                rest.push(name.to_os_string());
                cur = parent;
            }
            _ => return p.to_path_buf(),
        }
    }
}

/// Checks a backup folder: a full path, outside the office folder. It need not exist yet.
pub fn validate_dir(dir: &str, data_dir: &Path) -> Result<PathBuf> {
    let d = dir.trim();
    if d.is_empty() {
        return Err(AppError::invalid("Choose a folder for backups."));
    }
    let p = PathBuf::from(d);
    if !p.is_absolute() {
        return Err(AppError::invalid("The backup folder must be a full path, like C:\\Backups."));
    }
    if resolved(&p).starts_with(resolved(data_dir)) {
        return Err(AppError::invalid("Choose a backup folder outside the office folder, so backups survive if it's lost."));
    }
    Ok(p)
}

#[derive(Debug, Default, Clone, PartialEq)]
pub struct Summary {
    pub files: u64,
    /// Files or folders that couldn't be read and were left out.
    pub skipped: u32,
    /// The zip's size.
    pub bytes: u64,
}

fn options(meta: Option<&fs::Metadata>) -> SimpleFileOptions {
    let mut o = SimpleFileOptions::default().compression_method(CompressionMethod::Deflated);
    if let Some(m) = meta {
        o = o.large_file(m.len() >= u32::MAX as u64);
        let t = m.modified().ok().map(DateTime::<Local>::from).and_then(|t| {
            zip::DateTime::from_date_and_time(t.year() as u16, t.month() as u8, t.day() as u8, t.hour() as u8, t.minute() as u8, t.second() as u8).ok()
        });
        if let Some(t) = t {
            o = o.last_modified_time(t);
        }
    }
    o
}

/// Copies `src` into the open entry. Returns false if reading stopped early (the entry keeps what
/// was read); errors are only for writing the zip.
fn copy_into(src: &mut File, out: &mut impl Write) -> Result<bool> {
    let mut buf = vec![0; 64 * 1024];
    loop {
        let n = match src.read(&mut buf) {
            Ok(0) => return Ok(true),
            Ok(n) => n,
            Err(e) if e.kind() == ErrorKind::Interrupted => continue,
            Err(_) => return Ok(false),
        };
        out.write_all(&buf[..n])?;
    }
}

fn entry_name(root: &Path, p: &Path) -> Option<String> {
    let rel = p.strip_prefix(root).ok()?;
    let parts: Vec<_> = rel.components().map(|c| c.as_os_str().to_string_lossy().into_owned()).collect();
    (!parts.is_empty()).then(|| parts.join("/"))
}

fn walk<W: Write + std::io::Seek>(root: &Path, dir: &Path, zip: &mut ZipWriter<W>, s: &mut Summary) -> Result<()> {
    let Ok(entries) = fs::read_dir(dir) else {
        s.skipped += 1;
        return Ok(());
    };
    for e in entries {
        let Ok(e) = e else {
            s.skipped += 1;
            continue;
        };
        let path = e.path();
        let Ok(ft) = e.file_type() else {
            s.skipped += 1;
            continue;
        };
        // Links (`.claude/skills` points at `skills/`) are rebuilt by Omega Star; following them
        // would store their target twice.
        if ft.is_symlink() || (ft.is_dir() && own_skills::is_link(&path)) {
            continue;
        }
        let Some(name) = entry_name(root, &path) else { continue };
        if dir == root && DB_FILES.contains(&name.as_str()) {
            continue;
        }
        if ft.is_dir() {
            zip.add_directory(format!("{name}/"), options(e.metadata().ok().as_ref()))?;
            walk(root, &path, zip, s)?;
        } else if ft.is_file() {
            let Ok(mut f) = File::open(&path) else {
                s.skipped += 1;
                continue;
            };
            zip.start_file(name, options(f.metadata().ok().as_ref()))?;
            if copy_into(&mut f, zip)? {
                s.files += 1;
            } else {
                s.skipped += 1;
            }
        }
    }
    Ok(())
}

/// Writes a new zip at `dest`: the database snapshot as `office.db`, everything else in `data_dir`
/// except the live database and links, and `backup.json` (the manifest plus the file count).
pub fn write_archive(data_dir: &Path, db_snapshot: &Path, dest: &Path, mut manifest: serde_json::Value) -> Result<Summary> {
    let mut zip = ZipWriter::new(BufWriter::new(File::create_new(dest)?));
    let mut s = Summary::default();
    let mut db = File::open(db_snapshot)?;
    zip.start_file("office.db", options(db.metadata().ok().as_ref()))?;
    if !copy_into(&mut db, &mut zip)? {
        return Err(AppError::internal("could not read the database snapshot"));
    }
    s.files += 1;
    walk(data_dir, data_dir, &mut zip, &mut s)?;
    manifest["files"] = s.files.into();
    manifest["skipped"] = s.skipped.into();
    zip.start_file("backup.json", options(None))?;
    zip.write_all(serde_json::to_string_pretty(&manifest)?.as_bytes())?;
    let file = zip.finish()?.into_inner().map_err(|e| e.into_error())?;
    file.sync_all()?;
    s.bytes = file.metadata()?.len();
    Ok(s)
}

/// Deletes all but the newest `keep` backups in `dir`, and any half-written ones. Files that aren't
/// Omega Star backups are never touched. Returns how many were deleted.
pub fn prune(dir: &Path, keep: u32) -> Result<usize> {
    let mut done = Vec::new();
    let mut partial = Vec::new();
    for e in fs::read_dir(dir)?.flatten() {
        if !e.file_type().is_ok_and(|t| t.is_file()) {
            continue;
        }
        let name = e.file_name().to_string_lossy().into_owned();
        if is_backup_name(&name) {
            done.push(name);
        } else if name.strip_suffix(PARTIAL).is_some_and(is_backup_name) {
            partial.push(name);
        }
    }
    done.sort(); // the stamp sorts by time
    let excess = done.len().saturating_sub(keep.max(1) as usize);
    let doomed: Vec<_> = done.into_iter().take(excess).chain(partial).collect();
    for name in &doomed {
        fs::remove_file(dir.join(name))?;
    }
    Ok(doomed.len())
}
