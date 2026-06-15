//! Wire `aura validate-tool` into Claude Code's PreToolUse hook so the Team
//! Radar gets live, throttled `editing` events — and the destructive-op gate —
//! with ZERO MCP. This is the keystone of the "works in plain Claude Code"
//! adoption path: a single project-level `.claude/settings.json` entry turns
//! the awareness plane on for anyone who clones the repo and opens it in Claude
//! Code, no MCP server and no per-developer setup.
//!
//! Why PreToolUse: `aura validate-tool` reads the tool-call JSON on stdin,
//! returns the safety-gate verdict, AND best-effort emits a throttled `editing`
//! awareness event for allowed Write/Edit/MultiEdit/NotebookEdit calls (see
//! `validate_tool::auto_emit_editing`). Git hooks already cover the `committed`
//! half of the radar (`HookInstaller::enable`); this covers the *live* half.
//!
//! Idempotent + reversible by construction:
//!   - [`ensure`] adds exactly one matcher block and is a no-op if ours is
//!     already present (re-running `aura enable` never duplicates it).
//!   - [`remove`] strips ONLY Aura's block, leaving every other PreToolUse hook
//!     the developer configured untouched.
//!   - We append our entry to the `PreToolUse` array rather than replacing it,
//!     so a developer's existing hooks survive.

use std::fs;
use std::io;
use std::path::{Path, PathBuf};

use serde_json::{json, Value};

/// The shell command the PreToolUse hook runs. Bare `aura` is assumed on PATH —
/// true the moment `aura enable` runs, since `aura` is the binary running it.
const HOOK_COMMAND: &str = "aura validate-tool";

/// Tools the hook fires on. The first four are what `auto_emit_editing`
/// recognises (so the radar reflects in-flight edits); `Bash` brings in the
/// destructive-op gate for shell commands. validate-tool returns "allow" for
/// ordinary commands, so this adds the safety net without adding noise.
const HOOK_MATCHER: &str = "Edit|Write|MultiEdit|NotebookEdit|Bash";

/// Substring that identifies *our* hook entry inside an arbitrary settings
/// file, so [`remove`]/[`is_wired`] can find it without disturbing the rest.
const HOOK_MARKER: &str = "aura validate-tool";

/// What `ensure` did, so the CLI can print an honest one-liner.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Outcome {
    /// Our PreToolUse block was added to a file that lacked it.
    Installed,
    /// Our block was already present and current — nothing changed.
    AlreadyPresent,
    /// Our block existed but the matcher was stale; we refreshed it.
    Updated,
}

/// `<dir>/.claude/settings.json` — the project-level, checked-in settings file
/// Claude Code reads. Project scope (not `~/.claude`) is deliberate: it travels
/// with the repo so the whole team gets the radar from a single `aura enable`.
fn settings_path(dir: &Path) -> PathBuf {
    dir.join(".claude").join("settings.json")
}

/// Parse an existing settings file into JSON, tolerating a missing file (fresh
/// object) but surfacing a genuinely corrupt one rather than silently nuking
/// the developer's config.
fn load_settings(path: &Path) -> io::Result<Value> {
    match fs::read_to_string(path) {
        Ok(s) if s.trim().is_empty() => Ok(json!({})),
        Ok(s) => serde_json::from_str(&s).map_err(|e| {
            io::Error::new(
                io::ErrorKind::InvalidData,
                format!("{} is not valid JSON ({e}); refusing to overwrite", path.display()),
            )
        }),
        Err(e) if e.kind() == io::ErrorKind::NotFound => Ok(json!({})),
        Err(e) => Err(e),
    }
}

/// True if `entry` is a PreToolUse block whose inner hooks invoke our command.
fn is_our_entry(entry: &Value) -> bool {
    entry
        .get("hooks")
        .and_then(Value::as_array)
        .map(|hooks| {
            hooks.iter().any(|h| {
                h.get("command")
                    .and_then(Value::as_str)
                    .is_some_and(|c| c.contains(HOOK_MARKER))
            })
        })
        .unwrap_or(false)
}

/// The PreToolUse entry Aura installs.
fn our_entry() -> Value {
    json!({
        "matcher": HOOK_MATCHER,
        "hooks": [ { "type": "command", "command": HOOK_COMMAND } ]
    })
}

/// Pure core of [`ensure`]: mutate a settings JSON value in place, returning the
/// outcome. Split out from filesystem I/O so it is unit-testable without temp
/// dirs.
pub fn upsert(settings: &mut Value) -> Outcome {
    if !settings.is_object() {
        *settings = json!({});
    }
    let root = settings.as_object_mut().expect("settings is an object");

    let hooks = root
        .entry("hooks")
        .or_insert_with(|| json!({}));
    if !hooks.is_object() {
        *hooks = json!({});
    }
    let hooks = hooks.as_object_mut().expect("hooks is an object");

    let pre = hooks
        .entry("PreToolUse")
        .or_insert_with(|| json!([]));
    if !pre.is_array() {
        *pre = json!([]);
    }
    let arr = pre.as_array_mut().expect("PreToolUse is an array");

    if let Some(existing) = arr.iter_mut().find(|e| is_our_entry(e)) {
        // Already ours — refresh only if the matcher drifted (e.g. we widened
        // the tool set in a newer release).
        let current = existing.get("matcher").and_then(Value::as_str).unwrap_or("");
        if current == HOOK_MATCHER {
            return Outcome::AlreadyPresent;
        }
        *existing = our_entry();
        return Outcome::Updated;
    }

    arr.push(our_entry());
    Outcome::Installed
}

/// Pure core of [`remove`]: strip our entry, collapsing now-empty containers.
/// Returns whether anything was removed.
pub fn strip(settings: &mut Value) -> bool {
    let Some(root) = settings.as_object_mut() else {
        return false;
    };
    let Some(hooks) = root.get_mut("hooks").and_then(Value::as_object_mut) else {
        return false;
    };
    let Some(pre) = hooks.get_mut("PreToolUse").and_then(Value::as_array_mut) else {
        return false;
    };

    let before = pre.len();
    pre.retain(|e| !is_our_entry(e));
    let changed = pre.len() != before;

    if pre.is_empty() {
        hooks.remove("PreToolUse");
    }
    if hooks.is_empty() {
        root.remove("hooks");
    }
    changed
}

/// Install (or refresh) the PreToolUse hook in `<dir>/.claude/settings.json`,
/// creating the file and `.claude/` directory if needed. Pretty-prints so the
/// result stays human-diffable in git.
pub fn ensure(dir: &Path) -> io::Result<Outcome> {
    let path = settings_path(dir);
    let mut settings = load_settings(&path)?;
    let outcome = upsert(&mut settings);
    if outcome != Outcome::AlreadyPresent {
        if let Some(parent) = path.parent() {
            fs::create_dir_all(parent)?;
        }
        let mut body = serde_json::to_string_pretty(&settings)
            .map_err(|e| io::Error::new(io::ErrorKind::InvalidData, e))?;
        body.push('\n');
        fs::write(&path, body)?;
    }
    Ok(outcome)
}

/// Remove Aura's PreToolUse hook from `<dir>/.claude/settings.json`. Returns
/// `Ok(false)` when there was nothing to remove (no file, or our block absent).
pub fn remove(dir: &Path) -> io::Result<bool> {
    let path = settings_path(dir);
    if !path.exists() {
        return Ok(false);
    }
    let mut settings = load_settings(&path)?;
    if !strip(&mut settings) {
        return Ok(false);
    }
    let mut body = serde_json::to_string_pretty(&settings)
        .map_err(|e| io::Error::new(io::ErrorKind::InvalidData, e))?;
    body.push('\n');
    fs::write(&path, body)?;
    Ok(true)
}

/// Whether `<dir>/.claude/settings.json` already routes PreToolUse through us.
pub fn is_wired(dir: &Path) -> bool {
    let path = settings_path(dir);
    let Ok(settings) = load_settings(&path) else {
        return false;
    };
    settings
        .get("hooks")
        .and_then(|h| h.get("PreToolUse"))
        .and_then(Value::as_array)
        .map(|arr| arr.iter().any(is_our_entry))
        .unwrap_or(false)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn upsert_into_empty_installs_one_block() {
        let mut s = json!({});
        assert_eq!(upsert(&mut s), Outcome::Installed);
        let arr = s["hooks"]["PreToolUse"].as_array().unwrap();
        assert_eq!(arr.len(), 1);
        assert_eq!(arr[0]["matcher"], HOOK_MATCHER);
        assert_eq!(arr[0]["hooks"][0]["command"], HOOK_COMMAND);
    }

    #[test]
    fn upsert_is_idempotent() {
        let mut s = json!({});
        assert_eq!(upsert(&mut s), Outcome::Installed);
        assert_eq!(upsert(&mut s), Outcome::AlreadyPresent);
        assert_eq!(upsert(&mut s), Outcome::AlreadyPresent);
        assert_eq!(s["hooks"]["PreToolUse"].as_array().unwrap().len(), 1);
    }

    #[test]
    fn upsert_preserves_a_developers_existing_hook() {
        let mut s = json!({
            "hooks": {
                "PreToolUse": [
                    { "matcher": "Bash", "hooks": [ { "type": "command", "command": "my-linter" } ] }
                ]
            },
            "statusLine": { "type": "command", "command": "bash x.sh" }
        });
        assert_eq!(upsert(&mut s), Outcome::Installed);
        let arr = s["hooks"]["PreToolUse"].as_array().unwrap();
        assert_eq!(arr.len(), 2, "ours appended, theirs kept");
        // Their hook + unrelated settings survive untouched.
        assert_eq!(arr[0]["hooks"][0]["command"], "my-linter");
        assert_eq!(s["statusLine"]["command"], "bash x.sh");
    }

    #[test]
    fn upsert_refreshes_a_stale_matcher() {
        let mut s = json!({
            "hooks": {
                "PreToolUse": [
                    { "matcher": "Edit", "hooks": [ { "type": "command", "command": "aura validate-tool" } ] }
                ]
            }
        });
        assert_eq!(upsert(&mut s), Outcome::Updated);
        assert_eq!(s["hooks"]["PreToolUse"][0]["matcher"], HOOK_MATCHER);
        assert_eq!(s["hooks"]["PreToolUse"].as_array().unwrap().len(), 1);
    }

    #[test]
    fn strip_removes_only_ours_and_collapses_empties() {
        let mut s = json!({});
        upsert(&mut s);
        assert!(strip(&mut s));
        // PreToolUse + hooks collapsed away entirely, leaving a clean object.
        assert!(s.get("hooks").is_none());
        assert!(!strip(&mut s), "second strip is a no-op");
    }

    #[test]
    fn strip_keeps_other_hooks() {
        let mut s = json!({
            "hooks": {
                "PreToolUse": [
                    { "matcher": "Bash", "hooks": [ { "type": "command", "command": "my-linter" } ] }
                ]
            }
        });
        upsert(&mut s); // now 2 entries
        assert!(strip(&mut s));
        let arr = s["hooks"]["PreToolUse"].as_array().unwrap();
        assert_eq!(arr.len(), 1);
        assert_eq!(arr[0]["hooks"][0]["command"], "my-linter");
    }

    #[test]
    fn corrupt_settings_is_an_error_not_a_silent_clobber() {
        let dir = std::env::temp_dir().join(format!("aura-agenthook-corrupt-{}", std::process::id()));
        let claude = dir.join(".claude");
        fs::create_dir_all(&claude).unwrap();
        fs::write(claude.join("settings.json"), "{ not json").unwrap();
        let err = ensure(&dir).unwrap_err();
        assert_eq!(err.kind(), io::ErrorKind::InvalidData);
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn ensure_then_is_wired_then_remove_round_trips_on_disk() {
        let dir = std::env::temp_dir().join(format!("aura-agenthook-rt-{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();

        assert!(!is_wired(&dir));
        assert_eq!(ensure(&dir).unwrap(), Outcome::Installed);
        assert!(is_wired(&dir));
        assert_eq!(ensure(&dir).unwrap(), Outcome::AlreadyPresent);

        // The written file is valid, pretty JSON ending in a newline.
        let body = fs::read_to_string(settings_path(&dir)).unwrap();
        assert!(body.ends_with('\n'));
        serde_json::from_str::<Value>(&body).expect("written settings is valid JSON");

        assert!(remove(&dir).unwrap());
        assert!(!is_wired(&dir));
        assert!(!remove(&dir).unwrap(), "second remove is a no-op");

        let _ = fs::remove_dir_all(&dir);
    }
}
