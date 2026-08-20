//! The last line of defence on what telemetry may carry.
//!
//! `telemetry_track` is callable from the frontend with an arbitrary property
//! bag, and call sites accumulate over time. Reviewing each one is not a
//! guarantee — a future call site that passes a repo path, a branch name or a
//! prompt would quietly break the promise the product is built on, and nobody
//! would notice, because telemetry has no visible output.
//!
//! So the promise is enforced here instead of trusted: every property passes
//! through `sanitize` before it reaches the wire. The rule is deliberately
//! severe — allow short, low-cardinality, content-free scalars and drop
//! everything else. A dropped property costs a chart; a leaked one costs the
//! thing Aura sells.

use serde_json::{Map, Value};

/// Longest string a property value may be. Anything a person typed, a path,
/// or a name is longer than a stable token like `crew_run` or `claude`.
const MAX_STR: usize = 48;

/// Property keys PostHog owns. Passed through untouched — they're set by our
/// own code in `telemetry.rs`, never by a call site.
fn is_reserved_key(k: &str) -> bool {
    k.starts_with('$')
}

/// Keep the audited set of properties `telemetry.rs` attaches itself, plus
/// anything a call site passes that survives the rules below.
pub fn sanitize(props: Value) -> Value {
    match props {
        Value::Object(map) => Value::Object(sanitize_map(map)),
        // A non-object property bag is a caller mistake, not data.
        _ => Value::Object(Map::new()),
    }
}

fn sanitize_map(map: Map<String, Value>) -> Map<String, Value> {
    let mut out = Map::new();
    for (k, v) in map {
        if is_reserved_key(&k) {
            out.insert(k, v);
            continue;
        }
        if !is_safe_key(&k) {
            continue;
        }
        if let Some(clean) = sanitize_value(&v) {
            out.insert(k, clean);
        }
    }
    out
}

/// A key must read like a schema field — lowercase, snake_case, short. This
/// also stops a caller inventing a key per repo or per user, which would blow
/// up cardinality even if every value were safe.
pub fn is_safe_key(k: &str) -> bool {
    !k.is_empty()
        && k.len() <= 32
        && k.starts_with(|c: char| c.is_ascii_lowercase())
        && k.chars().all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '_')
}

/// Numbers and booleans are always safe — they cannot carry content. Strings
/// must survive `is_safe_string`. Everything else (arrays, objects, null) is
/// dropped: nesting is how content sneaks through.
fn sanitize_value(v: &Value) -> Option<Value> {
    match v {
        Value::Bool(_) | Value::Number(_) => Some(v.clone()),
        Value::String(s) => {
            let t = s.trim();
            if is_safe_string(t) {
                Some(Value::String(t.to_string()))
            } else {
                None
            }
        }
        _ => None,
    }
}

/// A safe string is a short, stable token: an identifier, a version, a status
/// word. Anything that looks like a path, a URL, an address, a home directory
/// or free prose is rejected outright rather than truncated — a truncated
/// path is still a leaked path.
pub fn is_safe_string(s: &str) -> bool {
    if s.is_empty() || s.len() > MAX_STR {
        return false;
    }
    // Shapes that mean "this is content, not a token".
    if s.contains('/')
        || s.contains('\\')
        || s.contains('@')
        || s.contains(' ')
        || s.contains('\n')
        || s.contains('\t')
        || s.contains('~')
        || s.contains(':')
    {
        return false;
    }
    // Whatever is left must be drawn from an identifier alphabet. Dots and
    // dashes are in so versions ("0.19.37") and ids ("claude-code") pass.
    s.chars()
        .all(|c| c.is_ascii_alphanumeric() || c == '_' || c == '-' || c == '.')
}

/// Reduce a free-form command argument to a token safe to report, or None.
/// Used for things like the `aura` subcommand a surface just ran, where the
/// verb is worth knowing and the rest of the argv never is.
pub fn safe_token(raw: &str) -> Option<String> {
    let t = raw.trim();
    if is_safe_string(t) { Some(t.to_string()) } else { None }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn keeps_stable_tokens_numbers_and_flags() {
        let out = sanitize(json!({
            "feature": "crew_run",
            "agent": "claude-code",
            "app_version": "0.19.37",
            "count": 3,
            "resumed": true,
        }));
        assert_eq!(out["feature"], json!("crew_run"));
        assert_eq!(out["agent"], json!("claude-code"));
        assert_eq!(out["app_version"], json!("0.19.37"));
        assert_eq!(out["count"], json!(3));
        assert_eq!(out["resumed"], json!(true));
    }

    #[test]
    fn drops_anything_shaped_like_a_path_or_an_address() {
        let out = sanitize(json!({
            "repo": "/Users/mo/Documents/New Git",
            "home": "~/.aura",
            "remote": "git@github.com:mhask/aura-sovereign.git",
            "url": "https://auravcs.com/x",
            "branch": "feat/worktree-control-plane",
        }));
        assert_eq!(out.as_object().unwrap().len(), 0);
    }

    #[test]
    fn drops_prose_and_anything_a_person_typed() {
        let out = sanitize(json!({
            "prompt": "fix the login bug please",
            "message": "Cannot read property 'x' of undefined",
        }));
        assert_eq!(out.as_object().unwrap().len(), 0);
    }

    #[test]
    fn drops_long_values_even_when_they_look_like_tokens() {
        let long = "a".repeat(MAX_STR + 1);
        let out = sanitize(json!({ "feature": long }));
        assert!(out.get("feature").is_none());
    }

    #[test]
    fn drops_nesting_so_content_cannot_hide_one_level_down() {
        let out = sanitize(json!({
            "nested": { "repo": "/Users/mo" },
            "list": ["/Users/mo"],
            "nothing": Value::Null,
        }));
        assert_eq!(out.as_object().unwrap().len(), 0);
    }

    #[test]
    fn drops_high_cardinality_keys_but_keeps_posthog_reserved_ones() {
        let out = sanitize(json!({
            "RepoName": "aura",          // not snake_case
            "user-id": "abc",            // dash in key
            "": "x",                     // empty
            "$set": { "os": "macos" },   // PostHog's own, set by telemetry.rs
        }));
        assert!(out.get("RepoName").is_none());
        assert!(out.get("user-id").is_none());
        assert_eq!(out["$set"], json!({ "os": "macos" }));
    }

    #[test]
    fn safe_token_passes_verbs_and_refuses_arguments() {
        assert_eq!(safe_token("pr-review").as_deref(), Some("pr-review"));
        assert_eq!(safe_token("  prove ").as_deref(), Some("prove"));
        assert_eq!(safe_token("/Users/mo/x"), None);
        assert_eq!(safe_token("user can log in"), None);
    }
}
