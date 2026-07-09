//! Turn a failed engine-CLI subprocess into calm, plain-language chat text.
//!
//! A "continued on <engine>" turn runs Codex / Gemini / Claude Code / Cursor as
//! the Aura Manager via a spawned CLI. When that CLI exits non-zero, its raw
//! stderr must NEVER reach the chat: those traces embed the full Manager system
//! prompt (the CLI echoes it back inside `spawnargs` on a failed spawn) and read
//! as a wall of stack frames to a non-engineer. `humanize_cli_failure` maps the
//! common failure signatures to one short sentence and, for anything it doesn't
//! recognize, returns a generic line with the preamble scrubbed out — so the
//! surface stays clean and the system prompt never leaks.

/// Human label for an engine CLI binary (accepts a basename or a full path).
pub fn engine_label(bin: &str) -> String {
    let base = bin.rsplit(['/', '\\']).next().unwrap_or(bin);
    let stem = base.strip_suffix(".exe").unwrap_or(base);
    match stem {
        "codex" => "Codex".to_string(),
        "gemini" => "Gemini".to_string(),
        "claude" => "Claude Code".to_string(),
        "cursor" | "cursor-agent" => "Cursor".to_string(),
        other => other.to_string(),
    }
}

/// True when the (already-lowercased) haystack contains any needle.
fn any_of(haystack_lower: &str, needles: &[&str]) -> bool {
    needles.iter().any(|n| haystack_lower.contains(n))
}

/// One short, plain-language sentence for a non-zero engine exit. Never the raw
/// stderr (which can embed the system prompt) and never a stack trace.
pub fn humanize_cli_failure(bin: &str, exit: i32, stderr: &str) -> String {
    let label = engine_label(bin);
    let low = stderr.to_lowercase();

    // Not installed / program missing — often the CLI's own vendored native
    // binary, not our spawn of the wrapper (e.g. codex ENOENT on a partial
    // `@openai/codex` install).
    if any_of(
        &low,
        &[
            "enoent",
            "command not found",
            "no such file or directory",
            "is not recognized",
            "executable file not found",
        ],
    ) {
        return format!(
            "{label} isn’t installed, or part of it is missing. Reinstall {label}, then try again."
        );
    }

    // Missing / invalid API key or auth.
    if any_of(
        &low,
        &[
            "api key not valid",
            "api_key_invalid",
            "invalid api key",
            "invalid_api_key",
            "missing api key",
            "please pass a valid api key",
            "not authenticated",
            "unauthorized",
            "permission_denied",
        ],
    ) {
        return format!(
            "{label} needs a valid API key. Add or update it in Settings → Models, then try again."
        );
    }

    // Quota / rate / spend limits.
    if any_of(
        &low,
        &[
            "quota",
            "resource_exhausted",
            "rate limit",
            "rate-limit",
            "too many requests",
            "spend limit",
            "usage limit",
            "insufficient_quota",
        ],
    ) {
        return format!(
            "{label} has hit its usage limit. Check your plan or try again in a bit."
        );
    }

    // Network.
    if any_of(
        &low,
        &[
            "econnrefused",
            "etimedout",
            "getaddrinfo",
            "socket hang up",
            "network error",
            "dns",
        ],
    ) {
        return format!(
            "{label} couldn’t reach the network. Check your connection, then try again."
        );
    }

    // Unknown failure — generic line, plus a short scrubbed hint if it's safe
    // to show (i.e. it does not embed the system prompt).
    match scrubbed_hint(stderr) {
        Some(hint) => format!("{label} couldn’t finish this response (exit {exit}). {hint}"),
        None => format!("{label} couldn’t finish this response (exit {exit})."),
    }
}

/// A short single-line hint from stderr, or None when it can't be shown safely.
/// Returns None if stderr embeds the Manager preamble or a `spawnargs` dump
/// anywhere — so the system prompt can never leak through the fallback path.
fn scrubbed_hint(stderr: &str) -> Option<String> {
    const UNSAFE: &[&str] = &["spawnargs", "you are the aura manager"];
    let low = stderr.to_lowercase();
    if UNSAFE.iter().any(|m| low.contains(m)) {
        return None;
    }
    let line = stderr.lines().map(str::trim).find(|l| !l.is_empty())?;
    let mut hint: String = line.chars().take(160).collect();
    if line.chars().count() > 160 {
        hint.push('…');
    }
    Some(hint)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn labels_known_engines_from_paths() {
        assert_eq!(engine_label("/opt/homebrew/bin/codex"), "Codex");
        assert_eq!(engine_label("gemini"), "Gemini");
        assert_eq!(engine_label("/usr/local/bin/claude"), "Claude Code");
        assert_eq!(engine_label("cursor-agent"), "Cursor");
        assert_eq!(engine_label("weird-tool"), "weird-tool");
    }

    #[test]
    fn codex_enoent_reads_as_not_installed() {
        let stderr = "Error: spawn /opt/homebrew/.../codex ENOENT\n  spawnargs: [ 'exec', 'You are the Aura Manager — a coordinator agent ...' ]";
        let msg = humanize_cli_failure("codex", 1, stderr);
        assert!(msg.contains("Codex isn’t installed"), "got: {msg}");
        // The system prompt must never survive into the chat text.
        assert!(!msg.contains("Aura Manager"), "leaked prompt: {msg}");
        assert!(!msg.contains("spawnargs"), "leaked args: {msg}");
    }

    #[test]
    fn gemini_invalid_key_reads_as_key_needed() {
        let stderr = r#"_ApiError: {"error":{"code":400,"message":"API key not valid. Please pass a valid API key.","status":"INVALID_ARGUMENT"}}"#;
        let msg = humanize_cli_failure("/opt/homebrew/bin/gemini", 1, stderr);
        assert!(msg.contains("Gemini needs a valid API key"), "got: {msg}");
    }

    #[test]
    fn unknown_failure_with_preamble_scrubs_hint() {
        // Even an unrecognized failure must not echo the preamble.
        let stderr = "some novel error\nspawnargs: [ 'exec', 'You are the Aura Manager ...' ]";
        let msg = humanize_cli_failure("codex", 7, stderr);
        assert!(!msg.contains("Aura Manager"), "leaked prompt: {msg}");
        assert!(msg.contains("exit 7"), "got: {msg}");
    }

    #[test]
    fn unknown_failure_keeps_a_safe_hint() {
        let msg = humanize_cli_failure("claude", 2, "TypeError: cannot read property 'x' of undefined");
        assert!(msg.contains("Claude Code couldn’t finish"), "got: {msg}");
        assert!(msg.contains("TypeError"), "dropped safe hint: {msg}");
    }
}
