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
}
