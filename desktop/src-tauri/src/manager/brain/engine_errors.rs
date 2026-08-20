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
//!
//! "Never the raw stderr" is not the same as "never the reason". The sentence
//! has to carry the one fact that lets someone act — which model, which key,
//! which sign-in — and it has to point at the place that actually holds that
//! setting. For a CLI that resolves its own providers, that place is its own
//! config and not ours: see `owns_its_own_models`.

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
        "opencode" => "OpenCode".to_string(),
        // Without this the fallback yields "pi", and a sentence that opens
        // "pi has no model called …" reads as a typo rather than a name.
        "pi" => "Pi".to_string(),
        other => other.to_string(),
    }
}

/// For a CLI that resolves providers, credentials and models ITSELF, the two
/// remedies in that CLI's own terms: `(where the key lives, where the model
/// list lives)`. `None` when Aura's Settings → Models really is the right door.
///
/// OpenCode is the case this exists for. It reads Models.dev plus the user's
/// `auth.json` and `opencode.json`, and people run it precisely because their
/// plan is one Aura doesn't front — a z.ai coding subscription, a local model,
/// a gateway of their own. Sending them to Settings → Models when their key
/// lives in `opencode auth login` is worse than saying nothing: it is a
/// confident wrong direction, and they follow it.
///
/// Pi is the same situation with a different door, which is why this returns
/// strings rather than a bool. Pi has no `auth login`: its `pi auth` subcommand
/// PRINTS credentials for external clients, and the command that acquires one
/// is `/login <provider>` inside a session. Telling someone to run `pi auth
/// login` would be the same confident wrong direction in a new costume. Its
/// model list is `pi --list-models`, not `pi models`.
fn own_model_remedies(bin: &str) -> Option<(String, String)> {
    let cmd = bin_base(bin);
    let label = engine_label(bin);
    match cmd {
        "opencode" => Some((
            format!("{label} keeps its own credentials — run `{cmd} auth login` in a terminal, then try again."),
            format!("Run `{cmd} models` to see what your install is configured for."),
        )),
        "pi" => Some((
            format!("{label} keeps its own credentials — run `/login <provider>` in a {label} session, then try again."),
            format!("Run `{cmd} --list-models` to see what your install is configured for."),
        )),
        _ => None,
    }
}

/// The command someone would actually type, out of whatever path we spawned.
/// A remedy that says `` `/Users/me/.opencode/bin/opencode auth login` `` is a
/// line nobody wants to read, let alone retype.
fn bin_base(bin: &str) -> &str {
    let base = bin.rsplit(['/', '\\']).next().unwrap_or(bin);
    base.strip_suffix(".exe").unwrap_or(base)
}

/// Where to go and fix a missing key, in that engine's own terms.
fn key_remedy(bin: &str) -> String {
    // Name the one door that works. Naming ours as well, even to rule it out,
    // is a second place to try for someone who is already stuck.
    if let Some((key, _)) = own_model_remedies(bin) {
        return key;
    }
    "Add or update it in Settings → Models, then try again.".to_string()
}

/// Where to go and pick a different model, likewise.
fn model_remedy(bin: &str) -> String {
    if let Some((_, model)) = own_model_remedies(bin) {
        return model;
    }
    "Pick a different model, then try again.".to_string()
}

/// stderr with ANSI colour sequences removed.
///
/// Several CLIs paint their error line — OpenCode's begins with a bright-red
/// bold pair before the word `Error` — and those bytes break both halves of
/// this file: a needle like "model not found" fails to match across an escape,
/// and `scrubbed_hint` would put the raw sequence into chat text, where it
/// renders as `[91m[1m`. Stripping is the whole fix; nothing else here has to
/// know that colour ever existed.
fn strip_ansi(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    let mut chars = s.chars().peekable();
    while let Some(c) = chars.next() {
        if c != '\u{1b}' {
            out.push(c);
            continue;
        }
        // CSI (`ESC [` … final byte in @–~) covers colour and cursor moves,
        // which is everything a CLI writes to decorate a line. Anything else
        // after ESC is a single-character escape; drop just that.
        match chars.peek() {
            Some('[') => {
                chars.next();
                for c in chars.by_ref() {
                    if ('\u{40}'..='\u{7e}').contains(&c) {
                        break;
                    }
                }
            }
            Some(_) => {
                chars.next();
            }
            None => {}
        }
    }
    out
}

/// The model id and OpenCode's own suggestion out of a
/// `ProviderModelNotFoundError: Model not found: <id>. Did you mean: <alt>?`
/// line, which is the single most useful sentence OpenCode produces and the one
/// its stderr envelope hides. Returns `(id, suggestion)`.
fn model_not_found_detail(clean: &str) -> Option<(String, Option<String>)> {
    let at = clean.find("Model not found:")?;
    let rest = clean[at + "Model not found:".len()..].trim_start();
    let id = token(rest);
    if id.is_empty() {
        return None;
    }
    let suggestion = rest
        .find("Did you mean:")
        .map(|i| token(rest[i + "Did you mean:".len()..].trim_start()));
    Some((id, suggestion.filter(|s| !s.is_empty())))
}

/// One model id off the front of `s`.
///
/// Stops at whitespace or a quote and then drops trailing sentence
/// punctuation, rather than stopping at the first `.` — model names have dots
/// in them (`glm-5.2`, `gpt-4.1`), and cutting at one turns naming the model
/// into naming most of it, which is worse than saying nothing.
fn token(s: &str) -> String {
    let raw: String = s
        .chars()
        .take_while(|c| !c.is_whitespace() && *c != '"')
        .collect();
    raw.trim_end_matches(['.', ',', '?', '!', ')', ';', ':'])
        .to_string()
}

/// True when the (already-lowercased) haystack contains any needle.
fn any_of(haystack_lower: &str, needles: &[&str]) -> bool {
    needles.iter().any(|n| haystack_lower.contains(n))
}

/// One short, plain-language sentence for a non-zero engine exit. Never the raw
/// stderr (which can embed the system prompt) and never a stack trace.
pub fn humanize_cli_failure(bin: &str, exit: i32, stderr: &str) -> String {
    let label = engine_label(bin);
    let stderr = &strip_ansi(stderr);
    let low = stderr.to_lowercase();

    // The named model, before the generic model branch below — this is the one
    // failure where we can say WHICH model and what the CLI itself suggests
    // instead, so it must not be swallowed by the vaguer match.
    if let Some((id, suggestion)) = model_not_found_detail(stderr) {
        let remedy = model_remedy(bin);
        return match suggestion {
            Some(alt) => format!(
                "{label} has no model called “{id}”. It suggests “{alt}”. {remedy}"
            ),
            None => format!("{label} has no model called “{id}”. {remedy}"),
        };
    }

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
            // Pi's own wording, from its `auth-guidance` module and its model
            // registry: `No API key found for "anthropic"`, `No API key for
            // google/gemini-3-pro`, `No API key providers available.`. None of
            // them said "invalid" or "missing", so all three used to fall
            // through to a bare "exit 1" — on the single most common reason a
            // fresh Pi install fails.
            "no api key",
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
        return format!("{label} needs a valid API key. {}", key_remedy(bin));
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
            "{label} couldn’t use the selected model — it may not be available on your plan. {}",
            model_remedy(bin)
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
    let stderr = &strip_ansi(stderr);
    let low = stderr.to_lowercase();
    if UNSAFE.iter().any(|m| low.contains(m)) {
        return None;
    }
    let line = logfmt_error(stderr)
        .or_else(|| stderr.lines().map(str::trim).find(|l| !l.is_empty()).map(str::to_string))?;
    let mut hint: String = line.chars().take(160).collect();
    if line.chars().count() > 160 {
        hint.push('…');
    }
    Some(hint)
}

/// The `error="…"` value out of a logfmt line, first occurrence, first line
/// only of a multi-line value.
///
/// A CLI that logs in logfmt puts the cause in that one field and everything
/// else on the line — timestamp, run id, span — is bookkeeping. OpenCode is the
/// reason: run it with `--print-logs` (which `aura-agents` now does, precisely
/// so there IS a cause on stderr) and the first line is
/// `timestamp=… level=ERROR run=… message=failed ref=… error="ProviderModel…"`.
/// Showing that whole line spends the hint's 160 characters on the prefix; the
/// field alone is the sentence someone can act on.
fn logfmt_error(clean: &str) -> Option<String> {
    let at = clean.find("error=\"")?;
    let rest = &clean[at + "error=\"".len()..];
    let mut out = String::new();
    let mut escaped = false;
    for c in rest.chars() {
        if escaped {
            // A logged stack trace arrives as `\n` inside the quoted value;
            // the first line of it is the message, the rest is frames.
            if c == 'n' {
                break;
            }
            out.push(c);
            escaped = false;
            continue;
        }
        match c {
            '\\' => escaped = true,
            '"' => break,
            '\n' => break,
            _ => out.push(c),
        }
    }
    let out = out.trim().to_string();
    (!out.is_empty()).then_some(out)
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

    /// OpenCode's stderr for a model it can't resolve, exactly as captured from
    /// 1.18.11 running `run --print-logs --log-level ERROR -m zai/glm-5.2`.
    /// The colour bytes, the log lines and the opaque envelope are all real.
    const OPENCODE_BAD_MODEL: &str = concat!(
        "timestamp=2026-08-02T21:41:11.909Z level=ERROR run=a009a34c ",
        "message=\"share subscriber failed\" type=message.updated ",
        "cause=\"Cause([Fail(ProviderModelNotFoundError: Model not found: zai/glm-5.2. ",
        "Did you mean: glm-5.2?)])\"\n",
        "timestamp=2026-08-02T21:41:11.917Z level=ERROR run=a009a34c message=failed ",
        "ref=err_64f2cf87 error=\"ProviderModelNotFoundError: Model not found: zai/glm-5.2. ",
        "Did you mean: glm-5.2?\" cause=\"ProviderModelNotFoundError: Model not found: ",
        "zai/glm-5.2. Did you mean: glm-5.2?\\n    at <anonymous> (/$bunfs/root/chunk.js:1:1)\"\n",
        "\u{1b}[91m\u{1b}[1mError: \u{1b}[0m{\n",
        "  \"name\": \"UnknownError\",\n",
        "  \"data\": {\n",
        "    \"message\": \"Unexpected server error. Check server logs for details.\",\n",
        "    \"ref\": \"err_64f2cf87\"\n",
        "  }\n}\n",
    );

    #[test]
    fn labels_opencode_with_its_own_capitalisation() {
        assert_eq!(engine_label("opencode"), "OpenCode");
        assert_eq!(engine_label("/Users/x/.opencode/bin/opencode"), "OpenCode");
    }

    #[test]
    fn a_wrong_opencode_model_names_the_model_not_the_server() {
        // The whole point. OpenCode's stderr envelope says "Unexpected server
        // error" and every wrapper that reads only that ends up telling the
        // user their service is broken, when one model id is wrong.
        let msg = humanize_cli_failure("opencode", 1, OPENCODE_BAD_MODEL);
        assert!(msg.contains("zai/glm-5.2"), "didn't name the model: {msg}");
        assert!(msg.contains("glm-5.2”"), "dropped its suggestion: {msg}");
        assert!(!msg.to_lowercase().contains("unexpected server error"), "got: {msg}");
    }

    #[test]
    fn opencode_is_sent_to_its_own_config_never_to_our_settings() {
        // OpenCode resolves providers itself, so Settings → Models is a
        // confident wrong direction — the user's key lives in `auth login`.
        let bad_model = humanize_cli_failure("opencode", 1, OPENCODE_BAD_MODEL);
        assert!(bad_model.contains("opencode models"), "got: {bad_model}");
        assert!(!bad_model.contains("Settings"), "sent to our settings: {bad_model}");

        let no_key = humanize_cli_failure("opencode", 1, "Error: unauthorized");
        assert!(no_key.contains("opencode auth login"), "got: {no_key}");
        assert!(!no_key.contains("Settings"), "sent to our settings: {no_key}");
    }

    #[test]
    fn the_remedy_is_a_command_you_could_type_not_the_path_we_spawned() {
        let msg = humanize_cli_failure(
            "/Users/me/.opencode/bin/opencode",
            1,
            "Error: unauthorized",
        );
        assert!(msg.contains("`opencode auth login`"), "got: {msg}");
        assert!(!msg.contains("/Users/me"), "leaked the spawn path: {msg}");
    }

    #[test]
    fn a_model_name_with_a_dot_in_it_survives_intact() {
        // `glm-5.2` and `gpt-4.1` are ordinary model names. Naming most of a
        // model is worse than naming none of it — the user searches for a
        // string that doesn't exist.
        let msg = humanize_cli_failure(
            "opencode",
            1,
            "error=\"ProviderModelNotFoundError: Model not found: openai/gpt-4.1. \
             Did you mean: gpt-4.1-mini?\"",
        );
        assert!(msg.contains("openai/gpt-4.1”"), "truncated the id: {msg}");
        assert!(msg.contains("gpt-4.1-mini”"), "truncated the suggestion: {msg}");
    }

    #[test]
    fn labels_pi_so_a_sentence_can_start_with_it() {
        // The fallback would give "pi", and "pi has no model called …" reads
        // as a dropped capital rather than a product name.
        assert_eq!(engine_label("pi"), "Pi");
        assert_eq!(engine_label("/opt/homebrew/bin/pi"), "Pi");
    }

    #[test]
    fn pis_own_no_api_key_wording_is_recognized_as_missing_auth() {
        // Pi's `auth-guidance` module writes `No API key found for "<provider>"`
        // and its model registry writes `No API key for <provider>/<id>`.
        // Neither says "invalid" or "missing", so both used to fall through to
        // a bare exit code — on the most common first-run failure there is.
        for stderr in [
            "Error: No API key found for \"anthropic\".\n\nUse /login to log into a provider via OAuth or API key.",
            "Error: No API key for google/gemini-3-pro",
            "Error: No API key providers available.",
        ] {
            let msg = humanize_cli_failure("pi", 1, stderr);
            assert!(msg.contains("needs a valid API key"), "got: {msg}");
        }
    }

    #[test]
    fn pi_is_sent_to_its_own_login_never_to_ours_and_never_to_auth_login() {
        // Pi resolves its own providers, so Settings → Models is the wrong
        // door — but so is `pi auth login`, which does not exist: `pi auth`
        // PRINTS credentials for external clients. `/login` is the real one.
        let msg = humanize_cli_failure("pi", 1, "Error: No API key found for \"anthropic\".");
        assert!(msg.contains("/login <provider>"), "got: {msg}");
        assert!(!msg.contains("Settings"), "sent to our settings: {msg}");
        assert!(!msg.contains("auth login"), "invented a command: {msg}");
    }

    #[test]
    fn a_wrong_pi_model_is_named_and_points_at_pis_own_list() {
        // Pi prints `Model not found: <provider>/<id>` in the clear, so the
        // existing detail parser already names it; what must be right is the
        // remedy, because `pi models` is not a command — `--list-models` is.
        let msg = humanize_cli_failure("pi", 1, "Error: Model not found: google/gemini-3-pro");
        assert!(msg.contains("google/gemini-3-pro”"), "didn't name it: {msg}");
        assert!(msg.contains("pi --list-models"), "got: {msg}");
        assert!(!msg.contains("Settings"), "sent to our settings: {msg}");
    }

    #[test]
    fn a_vendor_cli_still_goes_to_our_settings() {
        // The engine-aware remedy must not have moved everyone else's door.
        let msg = humanize_cli_failure("gemini", 1, "Error: unauthorized");
        assert!(msg.contains("Settings → Models"), "got: {msg}");
    }

    #[test]
    fn colour_codes_never_reach_the_chat() {
        let msg = humanize_cli_failure("opencode", 1, "\u{1b}[91m\u{1b}[1msomething odd\u{1b}[0m");
        assert!(!msg.contains('\u{1b}'), "raw escape: {msg:?}");
        assert!(!msg.contains("[91m"), "stripped escape but kept its body: {msg}");
        assert!(msg.contains("something odd"), "lost the text: {msg}");
    }

    #[test]
    fn an_unrecognized_logfmt_failure_shows_its_error_field_not_its_bookkeeping() {
        let stderr = "timestamp=2026-08-02T21:41:11.917Z level=ERROR run=a009a34c \
                      message=failed ref=err_1 error=\"SomethingNovelError: the disk went away\" \
                      cause=\"SomethingNovelError\\n    at <anonymous>\"";
        let msg = humanize_cli_failure("opencode", 1, stderr);
        assert!(msg.contains("the disk went away"), "got: {msg}");
        assert!(!msg.contains("timestamp="), "leaked bookkeeping: {msg}");
    }

    #[test]
    fn a_logged_stack_trace_contributes_its_message_and_not_its_frames() {
        let stderr = "level=ERROR error=\"Boom: it broke\\n    at a (x.js:1:1)\\n    at b\"";
        let msg = humanize_cli_failure("opencode", 3, stderr);
        assert!(msg.contains("Boom: it broke"), "got: {msg}");
        assert!(!msg.contains("at a ("), "leaked frames: {msg}");
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
