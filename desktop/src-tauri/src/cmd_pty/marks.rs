//! OSC-133 shell-integration parser for plain terminals.
//!
//! A focused vte `Perform` that watches only the OSC 133 prompt marks
//! (`;A/;B/;C/;D`) and the printable text that lands in the
//! command-editing window. Unlike the agent's `cmd_agent_pty::OscPerf`,
//! it doesn't reconstruct chat blocks — plain terminals render verbatim
//! through xterm; here we just extract command boundaries so the
//! frontend can drive ⌘↑/⌘↓ "scroll to previous/next command" and the
//! ^⌥R "run recent command" picker.
//!
//! The shell-integration rc we inject (see `shell_integration.rs`) emits
//! the marks; this parser is the receiving half. Both are gated behind
//! the same opt-in, so a clean shell with no integration simply never
//! produces marks and this parser stays silent.

use vte::Perform;

use super::registry::MarkKind;

/// One boundary the shell crossed during a chunk of PTY output, drained
/// by the read loop and turned into a `pty-command:<id>` event +
/// (on `CommandEnd`) a recent-command ring push.
pub struct ParsedMark {
    pub kind: MarkKind,
    /// Exit code — set only on `CommandEnd` (OSC 133;D).
    pub exit_code: Option<i32>,
    /// The command line the user ran, captured between prompt-end (;B)
    /// and command-exec (;C). Carried onto the `CommandEnd` mark so the
    /// recent ring gets `(text, exit_code)` in one shot.
    pub command: Option<String>,
}

#[derive(PartialEq, Eq)]
enum Phase {
    /// Before the first prompt, or after a command finished.
    Idle,
    /// Between ;A and ;B — the shell is drawing its prompt.
    Prompt,
    /// Between ;B and ;C — the user's keystrokes echo here; this is the
    /// command line we capture.
    Editing,
    /// Between ;C and ;D — the command's own output streams.
    Running,
}

/// Stateful across chunks: one `MarkParser` per session, fed every
/// byte. (The vte `Parser` that drives it is also per-session so OSC
/// sequences spanning two reads still parse.)
pub struct MarkParser {
    phase: Phase,
    /// Printable chars seen since ;B — the echoed command line.
    cmd_buf: String,
    /// The most recently submitted command line, carried from ;C to ;D.
    last_command: Option<String>,
    /// Marks produced since the last `take_marks`.
    pending: Vec<ParsedMark>,
}

impl Default for MarkParser {
    fn default() -> Self {
        Self {
            phase: Phase::Idle,
            cmd_buf: String::new(),
            last_command: None,
            pending: Vec::new(),
        }
    }
}

impl MarkParser {
    /// Drain the marks accumulated since the last call.
    pub fn take_marks(&mut self) -> Vec<ParsedMark> {
        std::mem::take(&mut self.pending)
    }

    fn handle_osc133(&mut self, params: &[&[u8]]) {
        if params.len() < 2 || params[1].is_empty() {
            return;
        }
        match params[1][0] {
            b'A' => {
                self.phase = Phase::Prompt;
                self.cmd_buf.clear();
                self.pending.push(ParsedMark {
                    kind: MarkKind::PromptStart,
                    exit_code: None,
                    command: None,
                });
            }
            b'B' => {
                // Prompt drawn — user input echoes from here on.
                self.phase = Phase::Editing;
                self.cmd_buf.clear();
            }
            b'C' => {
                // Command submitted — freeze the captured line.
                let cmd = self.cmd_buf.trim().to_string();
                self.last_command = if cmd.is_empty() { None } else { Some(cmd) };
                self.phase = Phase::Running;
                self.pending.push(ParsedMark {
                    kind: MarkKind::CommandStart,
                    exit_code: None,
                    command: self.last_command.clone(),
                });
            }
            b'D' => {
                self.pending.push(ParsedMark {
                    kind: MarkKind::CommandEnd,
                    exit_code: Some(parse_exit(params)),
                    command: self.last_command.take(),
                });
                self.phase = Phase::Idle;
                self.cmd_buf.clear();
            }
            _ => {}
        }
    }
}

impl Perform for MarkParser {
    fn print(&mut self, c: char) {
        // Capture only the echoed command line — the text between
        // prompt-end and command-exec. Prompt redraw (Phase::Prompt) and
        // command output (Phase::Running) are ignored.
        if self.phase == Phase::Editing {
            self.cmd_buf.push(c);
        }
    }
    fn execute(&mut self, _byte: u8) {
        // Control bytes (\n, \r, \t, …) never join the captured command:
        // ;C/;D own finalization, so a multi-line paste can't smear the
        // recent-command text.
    }
    fn osc_dispatch(&mut self, params: &[&[u8]], _bel_terminated: bool) {
        if !params.is_empty() && params[0] == b"133" {
            self.handle_osc133(params);
        }
    }
    // hook/put/unhook/csi_dispatch/esc_dispatch: intentionally no-op —
    // xterm renders the raw bytes; we only want OSC 133 + printable text.
}

/// Parse the exit code from an OSC 133;D. Two emitter conventions, same
/// as `cmd_agent_pty::OscPerf::handle_osc133`'s ;D branch:
///   `\x1b]133;D;<exit>\x07`  → exit is `params[2]`
///   `\x1b]133;D=<exit>\x07`  → exit is the tail of `params[1]`
fn parse_exit(params: &[&[u8]]) -> i32 {
    let parsed = if params.len() >= 3 {
        std::str::from_utf8(params[2])
            .ok()
            .and_then(|s| s.parse::<i32>().ok())
    } else {
        let tail = &params[1][1..];
        let tail = tail.strip_prefix(b"=").unwrap_or(tail);
        std::str::from_utf8(tail)
            .ok()
            .and_then(|s| s.parse::<i32>().ok())
    };
    parsed.unwrap_or(0)
}

#[cfg(test)]
mod tests {
    use super::*;
    use vte::Parser;

    fn run(bytes: &[u8]) -> Vec<ParsedMark> {
        let mut parser = Parser::new();
        let mut perf = MarkParser::default();
        for b in bytes {
            parser.advance(&mut perf, *b);
        }
        perf.take_marks()
    }

    #[test]
    fn captures_command_and_exit_code() {
        // A ; prompt ; B ; user types "ls -la" ; C ; output ; D;0
        let stream = b"\x1b]133;A\x07$ \x1b]133;B\x07ls -la\x1b]133;C\x07total 0\r\n\x1b]133;D;0\x07";
        let marks = run(stream);
        let kinds: Vec<MarkKind> = marks.iter().map(|m| m.kind).collect();
        assert_eq!(
            kinds,
            vec![MarkKind::PromptStart, MarkKind::CommandStart, MarkKind::CommandEnd]
        );
        let end = marks.last().unwrap();
        assert_eq!(end.exit_code, Some(0));
        assert_eq!(end.command.as_deref(), Some("ls -la"));
    }

    #[test]
    fn nonzero_exit_via_equals_form() {
        let stream = b"\x1b]133;A\x07\x1b]133;B\x07false\x1b]133;C\x07\x1b]133;D=1\x07";
        let marks = run(stream);
        let end = marks.last().unwrap();
        assert_eq!(end.kind, MarkKind::CommandEnd);
        assert_eq!(end.exit_code, Some(1));
        assert_eq!(end.command.as_deref(), Some("false"));
    }

    #[test]
    fn clean_shell_emits_no_marks() {
        // No OSC 133 at all — just ordinary output.
        let marks = run(b"hello world\r\n$ \x1b[32mgreen\x1b[0m\r\n");
        assert!(marks.is_empty());
    }
}
