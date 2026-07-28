//! Adopt sentinel state written before the plane split.
//!
//! Until the shared plane existed, every checkout kept its own
//! `.aura/worktrees/<name>/sentinel/…`. Repointing sentinel at the repository
//! root without adopting those files would silently drop whatever an agent had
//! in flight at upgrade time — claims it holds, zones it declared, messages it
//! had not read yet.
//!
//! So the first shared access folds them in: each legacy record is stamped with
//! the checkout it came from, its file paths are re-keyed repository-relative,
//! and it is written into the shared set **only if nothing is there already**.
//! Live shared state always wins. A marker file makes the whole thing a single
//! `stat` on every subsequent call.
//!
//! The awareness feed needs no equivalent: it was always cwd-relative, so the
//! main checkout's log is already at the shared path, and a worktree's local
//! log held at most 500 ephemeral events that no peer could ever see.

use std::fs;
use std::path::{Path, PathBuf};

use super::paths;

/// Written once adoption has run. Its presence is the fast path.
const MARKER: &str = ".adopted-shared-v1";

/// Re-key an absolute path recorded inside `worktree`'s checkout so it names
/// the same file from anywhere.
///
/// Deliberately lexical — this runs inside `ensure_dirs`, so it must not shell
/// out to git. A path recorded in `…/workspaces/New Git/barcelona/src/auth.rs`
/// is cut after the last `/barcelona/`; anything else is left alone, which is
/// the safe direction (a path that fails to normalise simply doesn't match
/// across checkouts, exactly as before).
fn rekey(path: &str, worktree: &str, repo_root: &Path) -> String {
    if !path.starts_with('/') {
        return path.to_string();
    }
    let needle = format!("/{worktree}/");
    if let Some(idx) = path.rfind(&needle) {
        return path[idx + needle.len()..].to_string();
    }
    if let Ok(rel) = Path::new(path).strip_prefix(repo_root) {
        let rel = rel.to_string_lossy().to_string();
        if !rel.is_empty() {
            return rel;
        }
    }
    path.to_string()
}

/// Copy `src` into `dst_dir` under its own file name unless it is already
/// there, applying `transform` to the JSON on the way. Returns true on a write.
fn adopt_file(
    src: &Path,
    dst_dir: &Path,
    transform: impl FnOnce(&mut serde_json::Value),
) -> bool {
    let Some(name) = src.file_name() else {
        return false;
    };
    let dst = dst_dir.join(name);
    if dst.exists() {
        return false; // live shared state wins
    }
    let Ok(body) = fs::read_to_string(src) else {
        return false;
    };
    let Ok(mut v) = serde_json::from_str::<serde_json::Value>(&body) else {
        return false;
    };
    transform(&mut v);
    let Ok(out) = serde_json::to_string_pretty(&v) else {
        return false;
    };
    let _ = fs::create_dir_all(dst_dir);
    fs::write(&dst, out).is_ok()
}

fn set_if_absent(v: &mut serde_json::Value, key: &str, value: &str) {
    let is_absent = v.get(key).map(|x| x.is_null()).unwrap_or(true);
    if is_absent {
        if let Some(obj) = v.as_object_mut() {
            obj.insert(key.to_string(), serde_json::Value::String(value.to_string()));
        }
    }
}

/// Fold every legacy per-checkout sentinel directory into the shared one.
/// Cheap and idempotent after the first run.
pub fn adopt_legacy_sentinel_state() -> usize {
    let Some(root) = paths::repo_root() else {
        return 0;
    };
    let shared = root.join(".aura").join("sentinel");
    if shared.join(MARKER).exists() {
        return 0;
    }
    let legacy_root = root.join(".aura").join("worktrees");
    let mut adopted = 0;

    if let Ok(entries) = fs::read_dir(&legacy_root) {
        for entry in entries.flatten() {
            let dir = entry.path();
            if !dir.is_dir() {
                continue;
            }
            let Some(name) = dir.file_name().map(|n| n.to_string_lossy().to_string()) else {
                continue;
            };
            adopted += adopt_worktree(&dir, &name, &shared, &root);
        }
    }

    let _ = fs::create_dir_all(&shared);
    let _ = fs::write(shared.join(MARKER), format!("{adopted}\n"));
    adopted
}

fn adopt_worktree(dir: &Path, name: &str, shared: &Path, root: &Path) -> usize {
    let legacy = dir.join("sentinel");
    if !legacy.is_dir() {
        return 0;
    }
    let mut n = 0;

    for (sub, kind) in [
        ("claims", Kind::Claims),
        ("zones", Kind::Zones),
        ("messages", Kind::Messages),
    ] {
        let from = legacy.join(sub);
        let to = shared.join(sub);
        let Ok(files) = fs::read_dir(&from) else {
            continue;
        };
        for f in files.flatten() {
            let p = f.path();
            if p.extension().map(|x| x != "json").unwrap_or(true) {
                continue;
            }
            let adopted = adopt_file(&p, &to, |v| match kind {
                Kind::Claims => {
                    set_if_absent(v, "worktree", name);
                    if let Some(claims) = v.get_mut("claims").and_then(|c| c.as_array_mut()) {
                        for c in claims {
                            let Some(fp) = c.get("file_path").and_then(|x| x.as_str()) else {
                                continue;
                            };
                            let rekeyed = rekey(fp, name, root);
                            if let Some(obj) = c.as_object_mut() {
                                obj.insert("file_path".into(), serde_json::Value::String(rekeyed));
                            }
                        }
                    }
                }
                Kind::Zones => set_if_absent(v, "worktree", name),
                Kind::Messages => set_if_absent(v, "from_worktree", name),
            });
            if adopted {
                n += 1;
            }
        }
    }
    n
}

#[derive(Clone, Copy)]
enum Kind {
    Claims,
    Zones,
    Messages,
}

/// Where the marker lives, for tests and diagnostics.
pub fn marker_path() -> Option<PathBuf> {
    paths::repo_root().map(|r| r.join(".aura").join("sentinel").join(MARKER))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::worktree::testing::{fake_repo, CwdGuard};
    use crate::TEST_CWD_LOCK as SERIAL;

    #[test]
    fn rekey_cuts_a_path_at_its_checkout() {
        let root = Path::new("/repo/main");
        assert_eq!(
            rekey("/ws/New Git/barcelona/src/auth.rs", "barcelona", root),
            "src/auth.rs"
        );
        // Recorded from the main checkout — strips the repo root instead.
        assert_eq!(rekey("/repo/main/src/auth.rs", "main", root), "src/auth.rs");
        // Already portable, or unrelated: left exactly as found.
        assert_eq!(rekey("src/auth.rs", "barcelona", root), "src/auth.rs");
        assert_eq!(rekey("/elsewhere/x.rs", "barcelona", root), "/elsewhere/x.rs");
    }

    #[test]
    fn legacy_claims_are_adopted_stamped_and_rekeyed() {
        let _lk = SERIAL.lock().unwrap_or_else(|e| e.into_inner());
        let _g = CwdGuard::enter();
        let repo = fake_repo(&["barcelona"]);
        std::env::set_current_dir(&repo.main).expect("cd");

        // An agent's claim as an older build wrote it: private to its
        // checkout, unstamped, with an absolute path.
        let legacy = repo
            .main
            .join(".aura/worktrees/barcelona/sentinel/claims");
        fs::create_dir_all(&legacy).expect("mkdir");
        fs::write(
            legacy.join("sess-1.json"),
            serde_json::json!({
                "session_id": "sess-1",
                "agent_id": "claude",
                "pid": 999,
                "last_heartbeat": 42,
                "claims": [{
                    "file_path": repo.worktree("barcelona").join("src/auth.rs").to_string_lossy(),
                    "function_name": "login",
                    "node_id": null,
                    "claimed_at": 42
                }]
            })
            .to_string(),
        )
        .expect("write");

        assert_eq!(adopt_legacy_sentinel_state(), 1);

        let moved = repo.main.join(".aura/sentinel/claims/sess-1.json");
        let v: serde_json::Value =
            serde_json::from_str(&fs::read_to_string(&moved).expect("read")).expect("json");
        assert_eq!(v["worktree"], "barcelona", "stamped with its checkout");
        assert_eq!(
            v["claims"][0]["file_path"], "src/auth.rs",
            "re-keyed so another checkout can match it"
        );

        // Idempotent: a second call is a no-op, not a re-copy.
        assert_eq!(adopt_legacy_sentinel_state(), 0);
        assert!(marker_path().expect("marker").exists());
    }

    #[test]
    fn adoption_never_clobbers_live_shared_state() {
        let _lk = SERIAL.lock().unwrap_or_else(|e| e.into_inner());
        let _g = CwdGuard::enter();
        let repo = fake_repo(&["barcelona"]);
        std::env::set_current_dir(&repo.main).expect("cd");

        let shared = repo.main.join(".aura/sentinel/claims");
        fs::create_dir_all(&shared).expect("mkdir");
        fs::write(shared.join("sess-1.json"), r#"{"session_id":"sess-1","live":true}"#)
            .expect("write");

        let legacy = repo.main.join(".aura/worktrees/barcelona/sentinel/claims");
        fs::create_dir_all(&legacy).expect("mkdir");
        fs::write(legacy.join("sess-1.json"), r#"{"session_id":"sess-1","live":false}"#)
            .expect("write");

        assert_eq!(adopt_legacy_sentinel_state(), 0, "nothing adopted");
        let body = fs::read_to_string(shared.join("sess-1.json")).expect("read");
        assert!(body.contains("\"live\":true"), "the live record survived");
    }
}
