//! Per-actor signing identity for awareness events (M3a). Reuses the
//! `aura-attestation` Ed25519 primitives. The 32-byte seed lives at
//! `.aura/awareness/identity.key` (written 0600 on unix by aura-attestation);
//! losing the seed loses the identity. The public `key_id`
//! (`did:aura:key/...`) is the stable, shareable handle for this actor — the
//! same primitive that will later anchor sovereign canonical refs (M4).

use std::path::PathBuf;

use aura_attestation::SigningKey;
use colored::Colorize;

use crate::worktree::paths;

/// Anchored at the repository root, like the event log it signs. It was
/// cwd-relative, which meant `load_or_create` minted a SECOND seed the first
/// time you ran from a worktree or a subdirectory — one human, two `key_id`s,
/// and teammates watching what looked like two actors. (Nothing failed
/// verification: the key is self-certifying, so both identities were perfectly
/// valid. They just weren't the same person.) It also scattered private key
/// material into whatever directory you happened to be standing in.
fn key_path() -> PathBuf {
    PathBuf::from(paths::shared_aura_path("awareness")).join("identity.key")
}

/// `aura identity` — show the repo-local signing identity used to sign awareness
/// events. Creates one on first call (same as the emit path), so a fresh repo
/// gets a stable handle immediately.
pub fn run_show(json: bool) {
    let path = key_path();
    let kid = key_id();

    if json {
        let data = serde_json::json!({
            "key_id": kid,
            "key_path": path.display().to_string(),
            "exists": kid.is_some(),
        });
        println!("{}", data);
        return;
    }

    println!();
    println!("  {}", "🔑 Awareness Identity".bold());
    println!("  {}", "─".repeat(46).dimmed());
    match kid {
        Some(k) => {
            println!("  {}  {}", "id  ".dimmed(), k.green().bold());
            println!("  {}  {}", "key ".dimmed(), path.display().to_string().dimmed());
            println!(
                "  {}",
                "signs every `aura radar emit` so events can't be spoofed".dimmed()
            );
        }
        None => {
            println!(
                "  {}  {}",
                "✗".red(),
                "no identity — keystore could not be created".red()
            );
            println!(
                "  {}",
                "events still emit, just unsigned (awareness degrades gracefully)".dimmed()
            );
        }
    }
    println!();
}

/// Load the repo-local signing identity, creating one on first use. Returns
/// `None` if the keystore can't be read or created — in that case events are
/// still emitted, just unsigned, so awareness degrades gracefully.
pub fn load() -> Option<SigningKey> {
    aura_attestation::load_or_create(&key_path()).ok()
}

/// The stable identity string for this repo-local key (`did:aura:key/...`),
/// or `None` if no identity is available.
pub fn key_id() -> Option<String> {
    load().map(|k| k.key_id())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;
    // The key path is resolved from the process cwd, so these tests take the
    // same serial lock as every other cwd-mutating test in the crate.
    use crate::TEST_CWD_LOCK as SERIAL;

    struct CwdGuard(PathBuf);
    impl Drop for CwdGuard {
        fn drop(&mut self) {
            let _ = std::env::set_current_dir(&self.0);
        }
    }

    #[test]
    fn one_person_in_a_repo_has_one_identity_wherever_they_stand() {
        let _lk = SERIAL.lock().unwrap_or_else(|e| e.into_inner());
        let guard = CwdGuard(std::env::current_dir().expect("cwd"));
        let d = tempfile::tempdir().expect("tmp");
        std::env::set_current_dir(d.path()).expect("cd");
        let _guard = guard;

        // A checkout is a directory with a `.git` in it — enough for the
        // repo-root walk, and enough for this test.
        fs::create_dir_all(d.path().join(".git")).expect("git dir");
        let deep = d.path().join("crates").join("engine");
        fs::create_dir_all(&deep).expect("subdir");

        let root_id = key_id().expect("an identity is minted on first use");

        // `load_or_create` does exactly what it says, so a cwd-relative key
        // path minted a SECOND seed the first time you ran from a worktree or
        // a subdirectory: one human, two `did:aura:key/...` handles, and
        // teammates watching what looked like two actors. Nothing failed
        // verification — the key is self-certifying, so both identities were
        // perfectly valid. They just weren't the same person.
        std::env::set_current_dir(&deep).expect("cd deep");
        assert_eq!(key_id().as_deref(), Some(root_id.as_str()));
        assert!(
            !deep.join(".aura").exists(),
            "private key material must not be scattered into subdirectories"
        );
    }
}
