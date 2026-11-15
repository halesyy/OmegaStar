//! The Mac's power state: whether it is in a full wake, and keeping it awake while a run works.

/// False in a Power Nap dark wake, when the display and graphics stay off and background work would
/// freeze when the Mac naps again. Any failure counts as a full wake. Blocks: runs `ioreg`.
pub fn full_wake() -> bool {
    #[cfg(target_os = "macos")]
    {
        let out = std::process::Command::new("/usr/sbin/ioreg").args(["-n", "IOPMrootDomain", "-r", "-d1"]).output();
        match out {
            Ok(o) if o.status.success() => graphics_on(&String::from_utf8_lossy(&o.stdout)).unwrap_or(true),
            _ => true,
        }
    }
    #[cfg(not(target_os = "macos"))]
    {
        true
    }
}

/// Whether the root power domain's "System Capabilities" include graphics (bit 0x2), which a dark
/// wake leaves out. `None` when the line is missing.
#[cfg_attr(not(target_os = "macos"), allow(dead_code))]
fn graphics_on(ioreg_out: &str) -> Option<bool> {
    let line = ioreg_out.lines().find(|l| l.contains("\"System Capabilities\""))?;
    let caps: u64 = line.split('=').nth(1)?.trim().parse().ok()?;
    Some(caps & 0x2 != 0)
}

/// Asks macOS not to sleep until the process `pid` exits, so the Mac does not nap mid-run: `-i` holds off idle
/// sleep, and `-s` holds off the sleep a closed lid or a dark wake's end brings, which `-i` does not. macOS
/// honours `-s` on mains power only, so on battery a closed lid still sleeps the Mac.
pub fn stay_awake_while(pid: u32) {
    #[cfg(target_os = "macos")]
    {
        let child = tokio::process::Command::new("/usr/bin/caffeinate")
            .args(["-i", "-s", "-w", &pid.to_string()])
            .stdin(std::process::Stdio::null())
            .stdout(std::process::Stdio::null())
            .stderr(std::process::Stdio::null())
            .spawn();
        if let Ok(mut child) = child {
            tokio::spawn(async move {
                let _ = child.wait().await;
            });
        }
    }
    #[cfg(not(target_os = "macos"))]
    let _ = pid;
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn graphics_on_reads_the_capability_bit() {
        let out = |caps: &str| format!("+-o IOPMrootDomain  <class IOPMrootDomain>\n    {{\n      \"Supported Features\" = {{}}\n      \"System Capabilities\" = {caps}\n    }}\n");
        assert_eq!(graphics_on(&out("15")), Some(true));
        assert_eq!(graphics_on(&out("9")), Some(false));
        assert_eq!(graphics_on("+-o IOPMrootDomain\n    {\n    }\n"), None);
    }

    /// Whether macOS holds a `PreventSystemSleep` assertion made for the process `pid`, per `pmset -g assertions`.
    #[cfg(target_os = "macos")]
    fn system_sleep_held_for(pid: u32) -> bool {
        let out = std::process::Command::new("/usr/bin/pmset").args(["-g", "assertions"]).output().expect("pmset runs");
        let out = String::from_utf8_lossy(&out.stdout).into_owned();
        let lines: Vec<&str> = out.lines().collect();
        lines.windows(2).any(|w| w[0].contains(" PreventSystemSleep named:") && w[1].trim_end().ends_with(&format!("Process ID {pid}")))
    }

    /// Polls for up to five seconds: `caffeinate` takes and drops its assertions a moment after it is asked.
    #[cfg(target_os = "macos")]
    async fn system_sleep_becomes(held: bool, pid: u32) -> bool {
        for _ in 0..50 {
            if system_sleep_held_for(pid) == held {
                return true;
            }
            tokio::time::sleep(std::time::Duration::from_millis(100)).await;
        }
        false
    }

    #[cfg(target_os = "macos")]
    #[tokio::test]
    async fn a_run_holds_off_system_sleep_until_it_exits() {
        let mut run = tokio::process::Command::new("/bin/sleep").arg("60").kill_on_drop(true).spawn().unwrap();
        let pid = run.id().unwrap();
        stay_awake_while(pid);
        assert!(system_sleep_becomes(true, pid).await, "macOS holds no system-sleep assertion for the run, so a closed lid naps it");
        run.kill().await.unwrap();
        assert!(system_sleep_becomes(false, pid).await, "the assertion outlived the run, so the Mac could not sleep after it");
    }
}
