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
        "agy" | "antigravity" => "Antigravity".to_string(),
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

    // Missing / invalid API key or auth. Includes the Gemini CLI's own auth
    // signatures (OAuth / ADC), which otherwise fell through to the generic
    // scrubbed fallback and showed a bare "exit 1".
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
            // Gemini CLI: expired/absent OAuth or application-default creds.
            "could not load the default credentials",
            "reauthenticate",
            "gemini_api_key",
            "google_application_credentials",
        ],
    ) {
        return format!(
            "{label} needs a valid API key. Add or update it in Settings → Models, then try again."
        );
    }

    // Selected model isn't available to this account/CLI — likely a per-turn
    // model pick the CLI (or the provider behind it) doesn't accept. Now that
    // the picker forwards a real `--model` to Gemini / Kimi / Antigravity, a
    // bad id fails here instead of silently ignoring the choice.
    if any_of(
        &low,
        &[
            "model not found",
            "unknown model",
            "unsupported model",
            "invalid model",
            "no such model",
            "model_not_found",
            "not found for api version",
            "is not supported",
        ],
    ) {
        return format!(
            "{label} couldn’t use the selected model — it may not be available on your plan. \
             Pick a different model, then try again."
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

/// A plain-language line for a turn that exited *cleanly* (code 0) but produced
/// no visible text. The user watched it "think" and then saw nothing — the exact
/// dead-end we must never leave blank. The usual cause is a print-mode CLI that
/// wants a one-time interactive sign-in it can't do non-interactively (seen with
/// Antigravity's `agy --print`), or one that emitted only to its own log. Name
/// the engine and give the concrete next step; fold in a safe stderr hint when
/// there is one.
pub fn humanize_empty_output(bin: &str, stderr: &str) -> String {
    let label = engine_label(bin);
    match scrubbed_hint(stderr) {
        Some(hint) => format!(
            "{label} finished but didn’t return any text. {hint} If this keeps \
             happening, open {label} in a terminal once to finish signing in, then try again."
        ),
        None => format!(
            "{label} finished but didn’t return any text — it may need a one-time \
             sign-in it can’t do from here. Open {label} in a terminal once, then try again."
        ),
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
    fn gemini_stale_oauth_reads_as_key_needed() {
        // The Gemini CLI's OAuth/ADC failures used to fall through to the
        // generic "exit 1" line; they now map to the auth message.
        let stderr = "Error: Could not load the default credentials. Browse to https://… to reauthenticate.";
        let msg = humanize_cli_failure("gemini", 1, stderr);
        assert!(msg.contains("Gemini needs a valid API key"), "got: {msg}");
    }

    #[test]
    fn bad_model_pick_reads_as_model_unavailable() {
        // A per-turn `--model` the account can't use (e.g. a picker id gated
        // behind a plan) should name the model, not show a bare exit code.
        let stderr = r#"{"error":{"code":404,"message":"models/gemini-3-pro-preview is not found for API version v1beta, or is not supported."}}"#;
        let msg = humanize_cli_failure("gemini", 1, stderr);
        assert!(msg.contains("couldn’t use the selected model"), "got: {msg}");
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

    #[test]
    fn labels_antigravity_from_agy_binary() {
        assert_eq!(engine_label("/Users/x/.local/bin/agy"), "Antigravity");
        assert_eq!(engine_label("antigravity"), "Antigravity");
    }

    #[test]
    fn clean_exit_empty_output_reads_as_no_text() {
        // agy --print can exit 0 yet print nothing (wants a one-time sign-in);
        // the turn must surface a reason, never render blank.
        let msg = humanize_empty_output("agy", "");
        assert!(msg.contains("Antigravity finished but didn’t return any text"), "got: {msg}");
        assert!(msg.contains("terminal"), "missing next step: {msg}");
    }

    #[test]
    fn empty_output_folds_in_safe_hint_and_scrubs_preamble() {
        let msg = humanize_empty_output("agy", "warning: profile not found");
        assert!(msg.contains("profile not found"), "dropped safe hint: {msg}");
        // A preamble-bearing stderr must still never leak through this path.
        let leak = humanize_empty_output("agy", "spawnargs: [ 'You are the Aura Manager ...' ]");
        assert!(!leak.contains("Aura Manager"), "leaked prompt: {leak}");
    }
}
