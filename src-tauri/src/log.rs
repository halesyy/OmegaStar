//! Problems the app recovers from. They go to stderr and, once the app has called `to_file`, to
//! `omega.log` in the office folder, since a Windows release build has no console.

use std::fs::{File, OpenOptions};
use std::io::Write;
use std::path::Path;
use std::sync::{Mutex, OnceLock};

/// Past this size the log starts over when the app opens.
const MAX_BYTES: u64 = 1024 * 1024;

static FILE: OnceLock<Mutex<File>> = OnceLock::new();

pub fn to_file(path: &Path) -> std::io::Result<()> {
    let big = std::fs::metadata(path).is_ok_and(|m| m.len() > MAX_BYTES);
    let file = OpenOptions::new().create(true).append(!big).write(true).truncate(big).open(path)?;
    let _ = FILE.set(Mutex::new(file));
    Ok(())
}

pub fn write(message: std::fmt::Arguments) {
    let line = format!("{} {message}", chrono::Local::now().format("%Y-%m-%d %H:%M:%S"));
    eprintln!("{line}");
    if let Some(f) = FILE.get() {
        let mut f = f.lock().unwrap_or_else(|e| e.into_inner());
        let _ = writeln!(f, "{line}");
    }
}

/// `log!("...", args)`: like `eprintln!`, and also into `omega.log`.
macro_rules! log {
    ($($t:tt)*) => { $crate::log::write(format_args!($($t)*)) };
}
pub(crate) use log;
