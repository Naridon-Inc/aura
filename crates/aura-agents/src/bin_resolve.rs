//! Find an agent's binary the way the user would, not the way launchd does.
//!
//! A macOS app launched from the Dock or Finder inherits launchd's PATH —
//! `/usr/bin:/bin:/usr/sbin:/sbin` — not the one the user's shell builds
//! from their profile. So `which opencode` succeeds in a terminal and fails
//! inside the app, and every surface downstream reads that as "not
//! installed": the agent vanishes from the picker, its model list is never
//! probed, and the composer falls back to a bare "Default" row.
//!
//! This module is the one place that knows the difference. It tries `which`
//! first, because when PATH *is* right that is the user's own answer, then
//! falls back to checking the directories package managers actually install
//! into. A fallback hit returns an **absolute path** on purpose: handing a
//! bare name to `Command::new` would re-run the same PATH search that just
//! failed.
//!
//! Results are cached per candidate list for the process lifetime —
//! availability is read on every picker open, and this is a `fork`/`exec`.
//!
//! If an install lives somewhere not probed here, `~/.aura/agents.toml`
//! overrides it. That is what the TOML loader is for.

use std::collections::HashMap;
use std::path::PathBuf;
use std::process::Command;
use std::sync::{Mutex, OnceLock};

/// Directories to probe when `which` comes up empty — where Homebrew,
/// npm-global, pipx, cargo, bun and the various curl-installers put user
/// binaries. Ordered most-likely first; the first hit wins.
fn extended_dirs() -> Vec<PathBuf> {
    let mut dirs: Vec<PathBuf> = vec![
        PathBuf::from("/opt/homebrew/bin"),
        PathBuf::from("/usr/local/bin"),
    ];
    if let Some(home) = std::env::var_os("HOME").map(PathBuf::from) {
        dirs.push(home.join(".local/bin"));
        dirs.push(home.join(".npm-global/bin"));
        dirs.push(home.join(".bun/bin"));
        dirs.push(home.join(".cargo/bin"));
        dirs.push(home.join("bin"));
    }
    dirs
}

/// Resolve the first of `candidates` that exists, as a name (when `which`
/// found it) or an absolute path (when the extended probe did).
///
/// `None` means the agent genuinely is not installed — which is a truthful
/// thing for a picker to act on, and the reason this returns an `Option`
/// rather than falling back to the bare name and letting the spawn fail
/// later with a confusing error.
pub fn resolve(candidates: &[&str]) -> Option<String> {
    static CACHE: OnceLock<Mutex<HashMap<String, Option<String>>>> = OnceLock::new();
    let cache = CACHE.get_or_init(|| Mutex::new(HashMap::new()));
    let key = candidates.join("\u{0}");

    if let Ok(map) = cache.lock() {
        if let Some(hit) = map.get(&key) {
            return hit.clone();
        }
    }

    let found = probe(candidates);

    if let Ok(mut map) = cache.lock() {
        map.insert(key, found.clone());
    }
    found
}

/// True when any of `candidates` resolves. The common question.
pub fn is_installed(candidates: &[&str]) -> bool {
    resolve(candidates).is_some()
}

fn probe(candidates: &[&str]) -> Option<String> {
    // 1) The user's own PATH, when we have it. A name that `which` answers
    //    is left as a name so the spawn keeps honouring PATH order — the
    //    user may deliberately shadow one install with another.
    for name in candidates {
        let found = Command::new("which")
            .arg(name)
            .output()
            .map(|o| o.status.success())
            .unwrap_or(false);
        if found {
            return Some((*name).to_string());
        }
    }
    // 2) Where the package managers actually put things.
    probe_in(candidates, &extended_dirs())
}

/// The fallback half, with the directories passed in so it can be exercised
/// without depending on what happens to be installed on the machine.
///
/// Returns an absolute path, never a bare name: this branch runs precisely
/// because PATH did not contain the binary, so handing back a name would
/// re-run the search that just failed.
fn probe_in(candidates: &[&str], dirs: &[PathBuf]) -> Option<String> {
    for dir in dirs {
        for name in candidates {
            let p = dir.join(name);
            if p.is_file() {
                return Some(p.to_string_lossy().into_owned());
            }
        }
    }
    None
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_binary_that_exists_nowhere_resolves_to_nothing() {
        assert_eq!(resolve(&["aura-no-such-binary-anywhere"]), None);
        assert!(!is_installed(&["aura-no-such-binary-anywhere"]));
    }

    /// `sh` is on every POSIX PATH, including launchd's. If this fails the
    /// resolver is broken, not the machine.
    #[test]
    fn a_binary_on_the_plain_path_resolves_by_name() {
        assert_eq!(resolve(&["sh"]).as_deref(), Some("sh"));
    }

    #[test]
    fn the_first_candidate_that_exists_wins() {
        let got = resolve(&["aura-no-such-binary-anywhere", "sh"]);
        assert_eq!(got.as_deref(), Some("sh"));
    }

    /// A directory only this test knows about, so the fallback's behaviour
    /// doesn't depend on what happens to be installed. Removed on drop.
    struct Sandbox(PathBuf);

    impl Sandbox {
        fn new(tag: &str) -> Self {
            let dir = std::env::temp_dir().join(format!(
                "aura-bin-resolve-{}-{tag}",
                std::process::id()
            ));
            let _ = std::fs::remove_dir_all(&dir);
            std::fs::create_dir_all(&dir).expect("sandbox dir");
            Self(dir)
        }

        fn with_file(&self, name: &str) -> &Self {
            std::fs::write(self.0.join(name), b"#!/bin/sh\n").expect("sandbox file");
            self
        }
    }

    impl Drop for Sandbox {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.0);
        }
    }

    /// The fallback must hand back something spawnable without a second
    /// PATH search — an absolute path, not a bare name. This is the whole
    /// point of the branch: it only runs because PATH already came up empty.
    #[test]
    fn the_extended_probe_returns_an_absolute_path() {
        let sandbox = Sandbox::new("absolute");
        sandbox.with_file("aura-fake-agent");

        let hit = probe_in(&["aura-fake-agent"], &[sandbox.0.clone()])
            .expect("the file is right there");

        assert!(
            std::path::Path::new(&hit).is_absolute(),
            "fallback returned `{hit}`, which is not spawnable without PATH"
        );
        assert_eq!(hit, sandbox.0.join("aura-fake-agent").to_string_lossy());
    }

    /// Directory order decides, not candidate order: an agent installed in
    /// two places should resolve to the one listed first, which is how a
    /// Homebrew install wins over a stale copy in `~/bin`.
    #[test]
    fn the_earlier_directory_wins_over_a_later_one() {
        let first = Sandbox::new("first");
        let second = Sandbox::new("second");
        first.with_file("aura-fake-agent");
        second.with_file("aura-fake-agent");

        let hit = probe_in(&["aura-fake-agent"], &[first.0.clone(), second.0.clone()])
            .expect("both dirs have it");

        assert_eq!(hit, first.0.join("aura-fake-agent").to_string_lossy());
    }

    #[test]
    fn a_directory_that_does_not_exist_is_skipped_not_fatal() {
        let real = Sandbox::new("skip");
        real.with_file("aura-fake-agent");
        let missing = PathBuf::from("/aura-no-such-directory-anywhere");

        let hit = probe_in(&["aura-fake-agent"], &[missing, real.0.clone()])
            .expect("the second dir has it");

        assert_eq!(hit, real.0.join("aura-fake-agent").to_string_lossy());
    }

    /// A directory of the same name must not answer — we spawn files.
    #[test]
    fn a_directory_named_like_the_binary_is_not_a_hit() {
        let sandbox = Sandbox::new("dirname");
        std::fs::create_dir_all(sandbox.0.join("aura-fake-agent")).expect("decoy dir");

        assert_eq!(probe_in(&["aura-fake-agent"], &[sandbox.0.clone()]), None);
    }
}
