//! What this computer tells Aura about itself when it joins: a name people
//! recognise, and the size of the machine. Nothing else — no serial numbers,
//! no user names, no network addresses.

use std::process::Command;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Machine {
    pub name: String,
    pub os: &'static str,
    pub arch: &'static str,
    pub cpus: Option<i64>,
    pub memory_mb: Option<i64>,
}

const NAME_MAX: usize = 64;

/// This computer, as best it can be measured. Every part is best-effort: a
/// machine whose memory can't be read still joins, it just shows no size.
pub fn this_machine() -> Machine {
    Machine {
        name: clean_name(&friendly_name()),
        os: os(),
        arch: arch(),
        cpus: std::thread::available_parallelism()
            .ok()
            .map(|n| n.get() as i64),
        memory_mb: memory_mb(),
    }
}

/// A name fit to show in a list: no control characters, single spaces, not
/// too long, never empty. The cloud cleans it again; this keeps the unit file
/// and the terminal honest too.
pub fn clean_name(raw: &str) -> String {
    let spaced: String = raw
        .chars()
        .map(|c| if c.is_control() { ' ' } else { c })
        .collect();
    let joined = spaced.split_whitespace().collect::<Vec<_>>().join(" ");
    let cut: String = joined.chars().take(NAME_MAX).collect();
    let cut = cut.trim().to_string();
    if cut.is_empty() {
        "Computer".to_string()
    } else {
        cut
    }
}

fn os() -> &'static str {
    if cfg!(target_os = "macos") {
        "macos"
    } else if cfg!(target_os = "linux") {
        "linux"
    } else {
        std::env::consts::OS
    }
}

fn arch() -> &'static str {
    match std::env::consts::ARCH {
        "x86_64" => "x86_64",
        "aarch64" => "aarch64",
        other => other,
    }
}

/// On a Mac the name its owner gave it ("Sam's MacBook Pro"), elsewhere the
/// host name.
fn friendly_name() -> String {
    if cfg!(target_os = "macos") {
        if let Some(n) = output("scutil", &["--get", "ComputerName"]) {
            return n;
        }
    }
    output("hostname", &[]).unwrap_or_default()
}

fn memory_mb() -> Option<i64> {
    if cfg!(target_os = "linux") {
        let text = std::fs::read_to_string("/proc/meminfo").ok()?;
        return meminfo_mb(&text);
    }
    if cfg!(target_os = "macos") {
        let bytes: i64 = output("sysctl", &["-n", "hw.memsize"])?.parse().ok()?;
        return Some(bytes / (1024 * 1024));
    }
    None
}

/// `MemTotal:  196608000 kB` → megabytes.
pub fn meminfo_mb(text: &str) -> Option<i64> {
    let line = text.lines().find(|l| l.starts_with("MemTotal:"))?;
    let kb: i64 = line
        .trim_start_matches("MemTotal:")
        .split_whitespace()
        .next()?
        .parse()
        .ok()?;
    Some(kb / 1024)
}

fn output(bin: &str, args: &[&str]) -> Option<String> {
    let out = Command::new(bin).args(args).output().ok()?;
    if !out.status.success() {
        return None;
    }
    let s = String::from_utf8_lossy(&out.stdout).trim().to_string();
    (!s.is_empty()).then_some(s)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_name_is_cleaned_before_it_goes_anywhere() {
        assert_eq!(clean_name("build-box\n"), "build-box");
        assert_eq!(clean_name("Sam's\tMacBook   Pro"), "Sam's MacBook Pro");
        assert_eq!(clean_name("evil\nExecStart=/bin/sh"), "evil ExecStart=/bin/sh");
        assert_eq!(clean_name(""), "Computer");
        assert_eq!(clean_name("\u{7}\u{1b}"), "Computer");
        assert_eq!(clean_name(&"x".repeat(200)).chars().count(), NAME_MAX);
    }

    #[test]
    fn memory_is_read_from_meminfo() {
        let text = "MemTotal:       197132888 kB\nMemFree:         1000 kB\n";
        assert_eq!(meminfo_mb(text), Some(192512));
        assert_eq!(meminfo_mb("MemFree: 1 kB\n"), None);
        assert_eq!(meminfo_mb("MemTotal: lots kB\n"), None);
    }

    #[test]
    fn this_machine_always_has_a_name_and_a_kind() {
        let m = this_machine();
        assert!(!m.name.is_empty());
        assert!(!m.os.is_empty());
        assert!(!m.arch.is_empty());
    }
}
