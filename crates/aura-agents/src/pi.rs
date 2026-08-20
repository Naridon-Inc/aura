//! Pi provider — the `pi` coding agent (@earendil-works/pi-coding-agent), a
//! minimal, provider-agnostic terminal coding harness. Pi runs the same agent
//! loop against Claude / GPT / Gemini / Grok / local models, picking the
//! backend from the user's own config — bring-your-own-key, so we attribute no
//! fixed per-token cost.
//!
//! Argv shapes, verified against `pi --help` and `dist/cli/args.js` on 0.83.0:
//!   * OneShot / StreamJson: `pi [flags] -p <prompt>`
//!   * PtyRepl:              `pi [flags]`   (the interactive TUI)
//!
//! Flags this maps onto, all real and all checked:
//!   `--model <provider/id>`  the picker's choice, in pi's own combined form
//!   `--thinking <level>`     pi's thinking ladder, which is already ours:
//!                            off / minimal / low / medium / high / xhigh / max
//!   `--tools read,grep,find,ls`  read-only mode, verbatim from pi's own help
//!   `--session-id <id>`      rejoin a session by exact id
//!
//! Two of those are worth saying why, because the obvious choice is wrong in
//! both cases.
//!
//! READ-ONLY IS A TOOL LIST, NOT A REQUEST. Pi has no approval gate at all
//! headless — no permission round-trip in its RPC command union, and
//! `--approve` is about trusting project-local config files rather than tool
//! calls. Asking the model in prose to please not write anything is therefore
//! the ONLY thing a wrapper could do, and it is worth exactly as much as the
//! model's cooperation. Pi's own help answers this directly: `pi --tools
//! read,grep,find,ls -p "Review the code in src/"`, captioned "Read-only mode
//! (no file modifications possible)". With `write`, `edit` and `bash` never
//! loaded, read-only is a fact about the process rather than an instruction
//! inside the prompt.
//!
//! RESUME USES `--session-id`, NOT `--session`. They look interchangeable and
//! are not. `--session <path|id>` resolves an existing file: if the id belongs
//! to another project it PROMPTS ("Fork this session into current directory?")
//! and if it resolves to nothing it exits 1. Both are fatal for a desktop tab
//! respawning a child — one hangs on a confirm nobody can see, the other dies
//! because a session was pruned. `--session-id <id>` reopens the session when
//! it exists and creates it with that id when it doesn't, which is the
//! idempotent behaviour a restored tab needs.
//!
//! ONE flag is deliberately not set yet: `--mode json`. Pi's print mode is the
//! plainest event stream of any CLI here — a session header, then one
//! `AgentSessionEvent` per line, deltas and all — and the frontend adapter for
//! it exists (`agentProtocol/adapters/pi.ts`). But the one-shot spawn site
//! keys structured parsing off `stdout_is_stream_json`, which means ANTHROPIC
//! stream-json and routes to Claude's line parser. Setting it here would hand
//! pi's records to a parser that understands none of them; setting `--mode
//! json` WITHOUT it would replace today's readable answer with a wall of raw
//! JSON. So the format switch lands with the reader that consumes it.
//!
//! That is not a gap in coverage, because the chat does not read pi through
//! this path anyway: pi runs as a TUI in a PTY, and its conversation is read
//! from the session JSONL it writes under `~/.pi/agent/sessions/`, whose
//! header and message entries the same adapter parses. `cmd_pi_sessions.rs`
//! tails it.

use crate::{
    AgentProvider, Capabilities, CostPer1k, InvokeMode, InvokeRequest, Invocation,
};

pub struct Pi;

const PREFS: &[(&str, i32)] = &[
    ("local model", 2),
    ("offline", 2),
    ("byok", 1),
    ("terminal", 1),
];

/// The flags shared by the print and TUI shapes — which model, how hard it
/// thinks, and what it is allowed to touch. Building them once keeps a resumed
/// TUI on the same model as the one-shot run that preceded it.
fn common_args(req: &InvokeRequest) -> Vec<String> {
    let mut args: Vec<String> = Vec::new();
    if let Some(model) = req.model {
        // Pi's `--model` takes a bare id or the combined `provider/id`, and
        // resolves it against the catalog its own `--list-models` prints. The
        // picker hands us whichever form that catalog gave, so it goes
        // through unchanged rather than being split and re-joined.
        args.extend(["--model".into(), model.to_string()]);
    }
    if let Some(effort) = req.effort {
        args.extend(["--thinking".into(), effort.pi_thinking(req.fast).into()]);
    }
    if let Some(policy) = req.approval {
        args.extend(policy.pi_args());
    }
    args
}

impl AgentProvider for Pi {
    fn id(&self) -> &str {
        "pi"
    }

    fn label(&self) -> &str {
        "Pi"
    }

    fn bin_name(&self) -> &str {
        "pi"
    }

    fn capabilities(&self) -> Capabilities {
        Capabilities {
            // Not Anthropic stream-json — see the module note. Pi's own event
            // stream is wired at the adapter layer, not here.
            stream: false,
            pty: true,
            // `--session-id <id>` on both shapes, so a restored tab rejoins
            // the conversation it left.
            resume: true,
        }
    }

    fn cost_per_1k(&self) -> Option<CostPer1k> {
        // Provider-agnostic / BYO-key — cost depends entirely on the model the
        // user points pi at, so we can't attribute a fixed rate. Pi does
        // report real dollars per call in its own `Usage.cost`, which is what
        // the transcript's footer reads instead of a table.
        None
    }

    fn classifier_prefs(&self) -> &[(&str, i32)] {
        PREFS
    }

    fn build_invocation(&self, req: &InvokeRequest) -> Result<Invocation, String> {
        let mut args = common_args(req);
        if let Some(sid) = req.resume_session_id {
            args.extend(["--session-id".into(), sid.into()]);
        }
        match req.mode {
            InvokeMode::OneShot | InvokeMode::StreamJson => {
                // `-p/--print` runs the prompt and exits.
                //
                // No prompt steering: effort and read-only mode both have real
                // flags above, and prepending a sentence on top of them would
                // say the same thing twice, inside the user's own prompt,
                // where the model reads it as something they wrote.
                args.push("-p".into());
                // The prompt goes last. Pi treats every non-flag argument as
                // part of the message, so anything after it is swallowed.
                args.push(req.prompt.to_string());
                Ok(Invocation {
                    bin: "pi".into(),
                    args,
                    env: vec![],
                    stdout_is_stream_json: false,
                })
            }
            InvokeMode::PtyRepl => Ok(Invocation {
                bin: "pi".into(),
                args,
                env: vec![],
                stdout_is_stream_json: false,
            }),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{ApprovalPolicy, ReasoningEffort};

    fn req(mode: InvokeMode) -> InvokeRequest<'static> {
        InvokeRequest {
            prompt: "fix the retry loop",
            mode,
            resume_session_id: None,
            attachments_via_stdin: false,
            effort: None,
            fast: false,
            model: None,
            approval: None,
        }
    }

    #[test]
    fn a_plain_run_is_the_prompt_and_nothing_else() {
        let inv = Pi.build_invocation(&req(InvokeMode::OneShot)).unwrap();
        assert_eq!(inv.bin, "pi");
        assert_eq!(inv.args, vec!["-p", "fix the retry loop"]);
        // Not Anthropic stream-json — flipping this feeds pi's records to
        // Claude's line parser.
        assert!(!inv.stdout_is_stream_json);
    }

    #[test]
    fn the_prompt_stays_last_so_flags_are_not_read_as_message() {
        let mut r = req(InvokeMode::OneShot);
        r.model = Some("anthropic/claude-sonnet-5");
        r.effort = Some(ReasoningEffort::High);
        let inv = Pi.build_invocation(&r).unwrap();
        assert_eq!(inv.args.last().unwrap(), "fix the retry loop");
        assert_eq!(
            inv.args,
            vec![
                "--model",
                "anthropic/claude-sonnet-5",
                "--thinking",
                "high",
                "-p",
                "fix the retry loop",
            ]
        );
    }

    #[test]
    fn the_model_id_goes_through_in_pis_own_spelling() {
        // `provider/id` is what `pi --list-models` prints and what `--model`
        // takes; splitting it into `--provider` + `--model` would be a
        // round-trip through two flags for no gain.
        let mut r = req(InvokeMode::PtyRepl);
        r.model = Some("google/gemini-3-pro");
        let inv = Pi.build_invocation(&r).unwrap();
        assert_eq!(inv.args, vec!["--model", "google/gemini-3-pro"]);
    }

    #[test]
    fn no_effort_picked_means_no_thinking_flag_at_all() {
        let inv = Pi.build_invocation(&req(InvokeMode::OneShot)).unwrap();
        assert!(!inv.args.iter().any(|a| a == "--thinking"));
    }

    #[test]
    fn every_effort_tier_maps_onto_pis_own_ladder() {
        // Pi is the one CLI whose thinking vocabulary is already ours, so this
        // is a straight mapping with nothing collapsed at either end — unlike
        // Codex, where Max has to fall back to "high".
        for (effort, want) in [
            (ReasoningEffort::Low, "low"),
            (ReasoningEffort::Medium, "medium"),
            (ReasoningEffort::High, "high"),
            (ReasoningEffort::Max, "max"),
        ] {
            let mut r = req(InvokeMode::OneShot);
            r.effort = Some(effort);
            let inv = Pi.build_invocation(&r).unwrap();
            assert!(inv.args.windows(2).any(|w| w == ["--thinking", want]));
        }
    }

    #[test]
    fn fast_asks_for_minimal_thinking_not_none() {
        // "off" would disable extended thinking outright on a model that may
        // reason better with a little of it; "minimal" is pi's own
        // low-latency tier.
        let mut r = req(InvokeMode::OneShot);
        r.effort = Some(ReasoningEffort::Max);
        r.fast = true;
        let inv = Pi.build_invocation(&r).unwrap();
        assert!(inv.args.windows(2).any(|w| w == ["--thinking", "minimal"]));
    }

    #[test]
    fn read_only_mode_removes_the_tools_rather_than_asking_nicely() {
        // Pi has no approval gate, so this is the only real read-only mode it
        // has — and it is a stronger one than an approval prompt: `write`,
        // `edit` and `bash` are never loaded, so there is nothing to approve.
        let mut r = req(InvokeMode::OneShot);
        r.approval = Some(ApprovalPolicy::Plan);
        let inv = Pi.build_invocation(&r).unwrap();
        assert!(inv
            .args
            .windows(2)
            .any(|w| w == ["--tools", "read,grep,find,ls"]));
        // The prompt is the user's prompt, not the user's prompt with our
        // instructions glued to the front of it.
        assert_eq!(inv.args.last().unwrap(), "fix the retry loop");
    }

    #[test]
    fn the_looser_policies_add_nothing_because_pi_gates_nothing() {
        // With no approval gate to relax, pi's default already IS full
        // autonomy. Emitting a flag here would have to invent one.
        for policy in [ApprovalPolicy::AcceptEdits, ApprovalPolicy::Bypass] {
            let mut r = req(InvokeMode::OneShot);
            r.approval = Some(policy);
            let inv = Pi.build_invocation(&r).unwrap();
            assert_eq!(inv.args, vec!["-p", "fix the retry loop"]);
        }
    }

    #[test]
    fn a_restored_tab_rejoins_by_exact_id() {
        // `--session <id>` would prompt for a fork when the id belongs to
        // another project and exit 1 when it resolves to nothing. Neither is
        // survivable for a child nobody is watching.
        let mut r = req(InvokeMode::PtyRepl);
        r.resume_session_id = Some("a1b2c3d4");
        let inv = Pi.build_invocation(&r).unwrap();
        assert_eq!(inv.args, vec!["--session-id", "a1b2c3d4"]);
        assert!(!inv.args.iter().any(|a| a == "--session"));
        assert!(Pi.capabilities().resume);
    }

    #[test]
    fn a_resumed_one_shot_keeps_the_session_ahead_of_the_prompt() {
        let mut r = req(InvokeMode::OneShot);
        r.resume_session_id = Some("a1b2c3d4");
        let inv = Pi.build_invocation(&r).unwrap();
        assert_eq!(
            inv.args,
            vec!["--session-id", "a1b2c3d4", "-p", "fix the retry loop"]
        );
    }

    #[test]
    fn a_bare_repl_takes_no_flags_and_no_prompt() {
        let inv = Pi.build_invocation(&req(InvokeMode::PtyRepl)).unwrap();
        assert!(inv.args.is_empty());
    }

    #[test]
    fn the_repl_carries_the_same_model_and_effort_as_the_run() {
        // A tab that switches from a one-shot to the TUI should not silently
        // change model underneath the user.
        let mut r = req(InvokeMode::PtyRepl);
        r.model = Some("anthropic/claude-sonnet-5");
        r.effort = Some(ReasoningEffort::Low);
        let inv = Pi.build_invocation(&r).unwrap();
        assert_eq!(
            inv.args,
            vec!["--model", "anthropic/claude-sonnet-5", "--thinking", "low"]
        );
    }
}
