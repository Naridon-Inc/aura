//! Merging Aura's hooks into a Claude-shaped `hooks.json`.
//!
//! Claude Code invented this file's shape and two other CLIs adopted it
//! verbatim: codex reads `~/.codex/hooks.json`, and cursor-agent reads
//! Claude's own `settings.local.json` and remaps the event names onto its own.
//! So one merge serves all of them.
//!
//! ```json
//! { "hooks": { "PostToolUse": [ { "hooks": [ { "type": "command",
//!                                             "command": "…" } ] } ] } }
//! ```
//!
//! The merge is the delicate part, not the shape. These files belong to the
//! user and to whatever other tools they installed — Superset stamps the same
//! codex file — so it has to add exactly Aura's entries, replace Aura's own
//! stale ones, and never touch anything else.

use serde_json::{Map, Value};

/// One hook Aura wants stamped: which event, what to run, and what to run it
/// for.
pub(crate) struct Stamp {
    pub event: &'static str,
    pub command: String,
    pub matcher: Option<&'static str>,
}

/// Merge `stamps` into a parsed hooks document, in place.
///
/// `marker` decides what counts as ours: any command containing it is an Aura
/// stamp and may be replaced, anything else is somebody's and is left exactly
/// where it is. It has to be a path fragment stable across versions and across
/// homes — see `is_ours` below for the failure that taught us the difference.
///
/// Returns `None`, leaving the document untouched, when the `hooks` key exists
/// but isn't an object: the user has shaped this file themselves and a merge
/// would corrupt it.
pub(crate) fn merge(root: &mut Map<String, Value>, stamps: &[Stamp], marker: &str) -> Option<()> {
    let hooks_val = root
        .entry("hooks".to_string())
        .or_insert_with(|| Value::Object(Map::new()));
    let Value::Object(hooks_map) = hooks_val else {
        return None;
    };

    // Is this matcher entry one of ours? True when every command in it points
    // inside a staged Aura script dir — under ANY home, not just the current
    // one. That "any home" is the whole point: an earlier version de-duped by
    // exact string equality on the assumption that "our staged dir is stable
    // under HOME", and HOME is not stable. Launch the app once with HOME
    // pointing somewhere else (a UI test does exactly this) and the command
    // string differs, the equality check misses, and a second entry is appended
    // beside the first. Delete that other home — /tmp gets swept — and every
    // tool call in the repo prints a hook error for a script that no longer
    // exists. Non-blocking, so nothing breaks; it just makes noise forever, in
    // a file the user never opens.
    let is_ours = |entry: &Value| -> bool {
        let Some(hooks) = entry.get("hooks").and_then(|h| h.as_array()) else {
            return false;
        };
        !hooks.is_empty()
            && hooks.iter().all(|h| {
                h.get("command")
                    .and_then(|c| c.as_str())
                    .is_some_and(|c| c.contains(marker))
            })
    };

    for stamp in stamps {
        let entry = entry_for(stamp);
        let arr = hooks_map
            .entry(stamp.event.to_string())
            .or_insert_with(|| Value::Array(vec![]));
        let Value::Array(items) = arr else {
            continue;
        };
        // Drop every stamp of ours that isn't the one we're about to write — a
        // rotated HOME, a renamed script — and leave everything else alone.
        // Re-stamping is how a stale entry gets cleaned up, so the fix reaches
        // files that were already stamped wrong rather than only new ones.
        items.retain(|it| !is_ours(it) || *it == entry);
        if !items.contains(&entry) {
            items.push(entry);
        }
    }

    // An event we no longer stamp (a script we dropped) leaves an empty array
    // behind, which the CLI reads as a matcher list with nothing in it. Prune
    // those so the file doesn't accumulate dead keys.
    hooks_map.retain(|_, v| !matches!(v, Value::Array(a) if a.is_empty()));

    Some(())
}

fn entry_for(stamp: &Stamp) -> Value {
    // `hooks` before `matcher`, matching what is already on disk in every repo
    // stamped so far. The key order is only cosmetic to the CLI, but a build
    // with serde_json's `preserve_order` on would otherwise rewrite every
    // settings file the first time it ran, for no change at all.
    let mut obj = Map::new();
    obj.insert(
        "hooks".into(),
        serde_json::json!([{ "type": "command", "command": stamp.command }]),
    );
    if let Some(m) = stamp.matcher {
        obj.insert("matcher".into(), Value::String(m.into()));
    }
    Value::Object(obj)
}

/// Read a hooks document, merge into it, and write it back.
///
/// Shared by every CLI whose hooks live in a file of their own — which is all
/// of them except Claude, whose hooks share `settings.local.json` with the
/// rest of a repo's Claude settings and so needs the two halves separately.
pub(crate) fn merge_file(
    path: &std::path::Path,
    stamps: &[Stamp],
    marker: &str,
) -> Option<()> {
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).ok()?;
    }
    let existing = std::fs::read_to_string(path)
        .ok()
        .and_then(|s| serde_json::from_str::<Value>(&s).ok())
        .unwrap_or_else(|| serde_json::json!({}));
    let mut root = match existing {
        Value::Object(m) => m,
        // A hooks file that isn't an object at all is not something we can
        // merge into without throwing away whatever the user put there.
        _ => return None,
    };
    merge(&mut root, stamps, marker)?;
    let serialized = serde_json::to_string_pretty(&Value::Object(root)).ok()?;
    std::fs::write(path, serialized).ok()?;
    Some(())
}
