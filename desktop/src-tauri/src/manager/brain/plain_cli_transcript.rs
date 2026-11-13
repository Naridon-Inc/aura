//! Undo the terminal decoration a plain-text CLI wraps its answer in.
//!
//! Most engines we drive as a brain speak stream-json, so what we read is the
//! model's text and nothing else. A few only print to a terminal, and what
//! they print is laid out for a human reading a TUI — not for a chat bubble.
//!
//! Kimi is the one that does this today. Every message it prints is rendered
//! as a bullet item: `• ` on the first line, and every following line of the
//! same message indented two spaces under it. Passed through verbatim, the
//! reply arrives in Aura's chat as a stray dot in front of the first word, and
//! the rest of it carries an indent the model never wrote.
//!
//! The decoration is unambiguous because it is applied *around* the model's
//! output: a `• ` at column zero is always Kimi's own, since anything the
//! model wrote — including its own bullet list — is inside the block and
//! therefore indented. That is what makes this safe to strip rather than
//! guess at.
//!
//! Engines that don't decorate get an identity transform, byte for byte.

use serde_json::Value;

/// Strips one engine's terminal decoration off a plain-text CLI's stdout, a
/// line at a time, so it can run inside the streaming read loop.
///
/// Construct with [`PlainCliTranscript::for_engine`]; feed every stdout line
/// through [`line`](PlainCliTranscript::line) in order.
pub struct PlainCliTranscript {
    /// Whether this engine wraps each message in a `• …` bullet block.
    bullets: bool,
    /// Inside such a block — set by the bullet line, cleared by the first
    /// unindented line that follows.
    in_block: bool,
}

impl PlainCliTranscript {
    pub fn for_engine(provider_id: &str) -> Self {
        Self {
            // Matched on the provider id, not the resolved binary: the Kimi
            // CLI ships under four different names (`kimi`, `kimi-cli`,
            // `kimi-coder`, `moonshot`) and `bin_resolve` may hand back an
            // absolute path to any of them.
            bullets: engine_family(provider_id) == "kimi",
            in_block: false,
        }
    }

    /// The line as the model wrote it. Returns `Cow`-free `String` because
    /// the caller pushes it into an accumulator and emits it either way.
    pub fn line(&mut self, line: &str) -> String {
        if !self.bullets {
            return line.to_string();
        }
        if let Some(rest) = line.strip_prefix("• ") {
            self.in_block = true;
            return rest.to_string();
        }
        if line.trim().is_empty() {
            // A blank line separates paragraphs *within* a message; Kimi
            // writes it as a truly empty line, so it neither opens nor closes
            // the block.
            return line.to_string();
        }
        if self.in_block {
            if let Some(rest) = line.strip_prefix("  ") {
                return rest.to_string();
            }
            // Column zero and not a bullet — the block is over. Anything the
            // CLI prints after it is its own chrome, and we pass it through
            // rather than pretend to understand it.
            self.in_block = false;
        }
        line.to_string()
    }
}

/// The engine behind a brain/provider id (`cli:kimi`, `cli_wrapper:kimi`,
/// `kimi-coder`, `kimi`). Kept local and deliberately narrow: this module only
/// needs to answer "is this Kimi", and reusing `mod.rs`'s `engine_family`
/// would tie decoration-stripping to that function's rather different job of
/// grouping models for the picker.
fn engine_family(provider_id: &str) -> &str {
    let bare = provider_id
        .rsplit_once(':')
        .map(|(_, right)| right)
        .unwrap_or(provider_id);
    if bare == "kimi" || bare.starts_with("kimi-") || bare == "moonshot" {
        "kimi"
    } else {
        bare
    }
}

/// What a plain-text engine's error event says, in plain words — `None` when
/// the line is anything else.
///
/// An engine driven as a plain CLI writes its answer to stdout, and when it
/// fails it writes its error event to the same place. OpenCode prints
/// `{"type":"error",…,"error":{"name":"UnknownError","data":{"message":
/// "Failed to get direct access token: 401 Unauthorized"}}}`, and passed
/// through verbatim that JSON became the turn's answer.
///
/// Only a line that is one whole JSON error event qualifies: prose that
/// mentions an error, or a JSON example inside an answer, is the model's and
/// is left alone. The wording matches the chat's own guard
/// (`parseEngineErrorEvent` in `engineErrorEvent.ts`), so a failure reads the
/// same whichever side catches it.
pub fn engine_error_sentence(line: &str, engine: &str) -> Option<String> {
    let text = line.trim();
    if !text.starts_with('{') || !text.ends_with('}') {
        return None;
    }
    let parsed: Value = serde_json::from_str(text).ok()?;
    let o = parsed.as_object()?;
    let err = if o.get("type").and_then(Value::as_str) == Some("error") {
        // OpenCode's run wire: `{ type: "error", timestamp, sessionID, error }`.
        o.get("error")
            .filter(|v| !v.is_null())
            .or_else(|| o.get("message"))
            .cloned()
            .unwrap_or(Value::Null)
    } else if o.len() == 1 && o.get("error").is_some_and(Value::is_object) {
        // A bare API error body, `{ "error": { code, message, status } }`.
        o["error"].clone()
    } else {
        return None;
    };
    let detail = message_of(&err);
    let status = status_of(&err, &detail);
    let who = match engine.trim() {
        "" => "The engine",
        name => name,
    };
    let reason = reason_for(status, &detail);
    Some(match status {
        Some(code) => format!("{who} {reason} ({code})."),
        None => format!("{who} {reason}."),
    })
}

/// A string worth reading: present and not blank.
fn text_of(v: Option<&Value>) -> Option<String> {
    let s = v?.as_str()?.trim();
    (!s.is_empty()).then(|| s.to_string())
}

/// The engine's message out of whichever shape its error took.
fn message_of(err: &Value) -> String {
    if let Some(s) = err.as_str() {
        return s.trim().to_string();
    }
    let data = err.get("data");
    text_of(data.and_then(|d| d.get("message")))
        .or_else(|| text_of(err.get("message")))
        .or_else(|| text_of(err.get("name")))
        .unwrap_or_default()
}

/// An HTTP error status, whether it came as a number or a three-digit string.
fn http_status(v: Option<&Value>) -> Option<u16> {
    let n = match v? {
        Value::Number(n) => n.as_u64()?,
        Value::String(s) if s.len() == 3 && s.bytes().all(|b| b.is_ascii_digit()) => {
            s.parse().ok()?
        }
        _ => return None,
    };
    (400..=599).contains(&n).then_some(n as u16)
}

fn status_of(err: &Value, message: &str) -> Option<u16> {
    let data = err.get("data");
    http_status(err.get("status"))
        .or_else(|| http_status(err.get("code")))
        .or_else(|| http_status(data.and_then(|d| d.get("statusCode"))))
        .or_else(|| http_status(data.and_then(|d| d.get("status"))))
        .or_else(|| {
            // A status the engine only wrote into its sentence ("… 401
            // Unauthorized") — a whole word of three digits, 4xx or 5xx.
            message
                .split(|c: char| !(c.is_ascii_alphanumeric() || c == '_'))
                .find_map(|word| http_status(Some(&Value::String(word.to_string()))))
        })
}

fn reason_for(status: Option<u16>, message: &str) -> &'static str {
    let m = message.to_ascii_lowercase();
    let says = |needles: &[&str]| needles.iter().any(|n| m.contains(n));
    if matches!(status, Some(401 | 403))
        || says(&["unauthorized", "unauthorised", "forbidden", "access token", "api key"])
    {
        "couldn't sign in"
    } else if status == Some(429)
        || says(&["ratelimit", "rate limit", "rate-limit", "rate_limit", "quota"])
    {
        "hit its usage limit"
    } else if status.is_some_and(|s| s >= 500) {
        "couldn't reach its service"
    } else {
        "stopped with an error"
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Feed a whole captured stdout through, the way the read loop does.
    fn undecorate(provider_id: &str, stdout: &str) -> String {
        let mut t = PlainCliTranscript::for_engine(provider_id);
        stdout
            .lines()
            .map(|l| t.line(l))
            .collect::<Vec<_>>()
            .join("\n")
    }

    /// The exact shape of the reply that showed the bug — a stray dot in
    /// front of the first word, and the paragraph after it indented.
    #[test]
    fn kimi_loses_the_bullet_it_draws_around_a_message() {
        let raw = "• Nope — that earlier reply was OpenCode, a different engine.\n\
                   \n  \
                   What are we building?\n";
        assert_eq!(
            undecorate("cli:kimi", raw),
            "Nope — that earlier reply was OpenCode, a different engine.\n\n\
             What are we building?"
        );
    }

    /// Kimi prints one bullet per message, so several can arrive in one turn.
    #[test]
    fn every_message_in_the_turn_is_undecorated_not_just_the_first() {
        let raw = "• Let me check that.\n\n• You were right.\n\n  The path was stale.";
        assert_eq!(
            undecorate("cli:kimi", raw),
            "Let me check that.\n\nYou were right.\n\nThe path was stale."
        );
    }

    /// A list the model itself wrote sits *inside* the block, so it arrives
    /// indented — and must come back out at the nesting the model chose, not
    /// two spaces deeper (four spaces is a code block in markdown).
    #[test]
    fn the_models_own_list_keeps_the_nesting_it_was_written_with() {
        let raw = "• Three things:\n\n  - first\n    - nested\n  - second";
        assert_eq!(
            undecorate("cli:kimi", raw),
            "Three things:\n\n- first\n  - nested\n- second"
        );
    }

    /// Anything printed after the block ended is left exactly as it came.
    #[test]
    fn chrome_outside_the_block_is_passed_through() {
        let raw = "• Done.\n\n  All tests pass.\nSession saved to ~/.kimi/x.json";
        assert_eq!(
            undecorate("cli:kimi", raw),
            "Done.\n\nAll tests pass.\nSession saved to ~/.kimi/x.json"
        );
    }

    /// The whole point of gating on the engine: nothing else may be touched.
    #[test]
    fn an_engine_that_does_not_decorate_is_passed_through_byte_for_byte() {
        let raw = "• a genuine bullet the model wrote\n  and its continuation";
        for engine in ["cli:cursor", "cli:claude_code", "cli_wrapper:opencode", "codex"] {
            assert_eq!(undecorate(engine, raw), raw, "{engine} was rewritten");
        }
    }

    /// Kimi arrives under four binary names and two id prefixes.
    #[test]
    fn kimi_is_recognised_however_it_is_spelled() {
        for id in ["kimi", "cli:kimi", "cli_wrapper:kimi", "kimi-coder", "moonshot"] {
            assert_eq!(
                undecorate(id, "• hi"),
                "hi",
                "{id} was not recognised as Kimi"
            );
        }
    }

    /// The line that reached a chat bubble verbatim: OpenCode's run wire
    /// printing its sign-in failure where its answer would have been.
    #[test]
    fn an_opencode_error_event_reads_as_a_sentence_not_json() {
        let line = r#"{"type":"error","timestamp":1762790000000,"sessionID":"ses_1","error":{"name":"UnknownError","data":{"message":"Failed to get direct access token: 401 Unauthorized"}}}"#;
        assert_eq!(
            engine_error_sentence(line, "OpenCode").as_deref(),
            Some("OpenCode couldn't sign in (401).")
        );
    }

    /// A bare API error body, and a status that only a field carries.
    #[test]
    fn a_bare_api_error_body_is_worded_by_its_status() {
        let limit = r#"{"error":{"code":429,"message":"Too many requests"}}"#;
        assert_eq!(
            engine_error_sentence(limit, "Kimi").as_deref(),
            Some("Kimi hit its usage limit (429).")
        );
        let down = r#"{"type":"error","error":{"name":"APIError","data":{"statusCode":503,"message":"upstream unavailable"}}}"#;
        assert_eq!(
            engine_error_sentence(down, "Cursor").as_deref(),
            Some("Cursor couldn't reach its service (503).")
        );
    }

    /// No status and no recognisable cause still reads as a sentence, and
    /// an engine with no name is called what it is.
    #[test]
    fn an_unknown_failure_still_reads_as_a_sentence() {
        let line = r#"{"type":"error","message":"something broke"}"#;
        assert_eq!(
            engine_error_sentence(line, "").as_deref(),
            Some("The engine stopped with an error.")
        );
    }

    /// Only a line that is one whole error event is an error. The model's
    /// own words about errors, and JSON that is something else, are its
    /// answer and must pass through.
    #[test]
    fn the_models_own_text_and_other_json_are_not_errors() {
        for line in [
            "The API returned {\"type\":\"error\"} when the key expired.",
            r#"{"type":"text","text":"hello"}"#,
            r#"{"error":{"code":500},"result":"partial"}"#,
            r#"{"error":"just a string field"}"#,
            "{not json at all}",
            "",
            "  - first",
        ] {
            assert_eq!(engine_error_sentence(line, "OpenCode"), None, "{line:?} was taken for an error");
        }
    }
}
