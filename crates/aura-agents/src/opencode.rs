//! OpenCode provider — the open-source agent CLI that bridges to whatever
//! providers the user has configured (including local models and BYO
//! subscriptions), rather than to one vendor's key.
//!
//! Argv shapes, verified against `opencode --help` / `opencode run --help` /
//! `opencode agent list` on 1.18.11:
//!   * OneShot / StreamJson: `opencode run [flags] <prompt>`
//!   * PtyRepl:              `opencode [flags]`  (the TUI; same flags apply)
//!
//! Flags this maps onto, all real and all checked:
//!   `-m provider/model`  the model picker's choice, in OpenCode's own
//!                        `provider/model` form
//!   `--variant <effort>` provider-specific reasoning effort
//!   `--agent plan`       a real built-in read-only agent, which is a truer
//!                        read-only mode than asking the model in prose
//!   `--auto`             auto-approve permissions (the Bypass policy only)
//!   `-s <id>` / `-c`     resume a session by id / continue the last one
//!
//! TWO flags are here for one reason: without them OpenCode's failures are
//! unreadable, and that unreadability is its single most-reported integration
//! problem. Ask it to run a model it can't resolve and stderr says, in full:
//!
//! ```text
//! Error: { "name": "UnknownError",
//!          "data": { "message": "Unexpected server error. Check server
//!                    logs for details.", "ref": "err_64f2cf87" } }
//! ```
//!
//! The real reason — `ProviderModelNotFoundError: Model not found: zai/glm-5.2.
//! Did you mean: glm-5.2?` — goes to OpenCode's log and nowhere else. A wrapper
//! reading only stderr has nothing to say but a restatement of the envelope,
//! which is why every one of them ends up printing some variant of "OpenCode
//! service failure" at a user whose actual problem is one wrong model id.
//!
//! `--print-logs --log-level ERROR` moves that line onto stderr, where
//! `engine_errors` can turn it into a sentence naming the model. Verified free
//! on the happy path: at ERROR level a successful run adds nothing to stderr,
//! and logs never touch stdout, so the answer itself is byte-identical.
//!
//! They go on `run` ONLY. The TUI shares one PTY between OpenCode's screen and
//! its stderr, so log lines there would be painted straight through the
//! interface — and the TUI already shows its own errors on screen.
//!
//! ONE flag is deliberately not set yet: `--format json`. OpenCode's run wire
//! is its own NDJSON of `{ type, timestamp, sessionID, part }` records — the
//! frontend adapter for it exists (`agentProtocol/adapters/opencode.ts`) — but
//! the spawn site keys structured parsing off `stdout_is_stream_json`, which
//! means ANTHROPIC stream-json and routes to Claude's line parser. Setting it
//! here would hand OpenCode's records to a parser that understands none of
//! them; setting `--format json` WITHOUT it would replace today's readable
//! answer with a wall of raw JSON. So the format switch lands with the reader
//! that consumes it, not before, and until then a one-shot run returns the
//! same plain text it always has.

use crate::{
    AgentProvider, Capabilities, CostPer1k, InvokeMode, InvokeRequest, Invocation,
};

pub struct OpenCode;

const PREFS: &[(&str, i32)] = &[
    ("research", 2),
    ("explore", 2),
    ("review", 1),
    ("implement", 1),
    ("refactor", 1),
    ("test", 1),
];

/// The flags shared by the `run` and TUI shapes — everything that describes
/// WHICH model, HOW hard it should think, and WHAT it is allowed to do.
/// Building them once keeps a resumed TUI on the same model as the one-shot
/// run that preceded it.
fn common_args(req: &InvokeRequest) -> Vec<String> {
    let mut args: Vec<String> = Vec::new();
    if let Some(model) = req.model {
        args.extend(["-m".into(), model.to_string()]);
    }
    // Only when the user actually picked an effort: `--variant` takes the
    // PROVIDER's vocabulary, so a default guess could be rejected by a model
    // that has no variants at all.
    if let Some(effort) = req.effort {
        args.extend(["--variant".into(), effort.opencode_variant(req.fast).into()]);
    }
    if let Some(policy) = req.approval {
        args.extend(policy.opencode_args());
    }
    args
}

impl AgentProvider for OpenCode {
    fn id(&self) -> &str {
        "opencode"
    }

    fn label(&self) -> &str {
        "OpenCode"
    }

    fn bin_name(&self) -> &str {
        "opencode"
    }

    fn capabilities(&self) -> Capabilities {
        Capabilities {
            // Not Anthropic stream-json — see the module note. OpenCode's own
            // event stream is wired at the adapter layer, not here.
            stream: false,
            pty: true,
            // `-s <id>` on both `run` and the TUI, so a restored tab rejoins
            // the session it left instead of starting a new one.
            resume: true,
        }
    }

    fn cost_per_1k(&self) -> Option<CostPer1k> {
        // OpenCode bridges to user-configured providers; cost depends on the
        // active model, not the CLI. Returning None defers to the
        // model-pricing table the shell already maintains.
        None
    }

    fn classifier_prefs(&self) -> &[(&str, i32)] {
        PREFS
    }

    fn build_invocation(&self, req: &InvokeRequest) -> Result<Invocation, String> {
        match req.mode {
            InvokeMode::OneShot | InvokeMode::StreamJson => {
                // Errors to stderr, nothing else. See the module note: the
                // envelope OpenCode prints without this says only that
                // something went wrong on a server.
                let mut args: Vec<String> = vec![
                    "run".into(),
                    "--print-logs".into(),
                    "--log-level".into(),
                    "ERROR".into(),
                ];
                args.extend(common_args(req));
                if let Some(sid) = req.resume_session_id {
                    args.extend(["-s".into(), sid.into()]);
                }
                // The prompt goes in last: `run [message..]` is variadic, so
                // anything after it is swallowed as more message.
                //
                // No prompt steering here — effort and read-only mode both
                // have real flags above, and prepending a sentence on top of
                // them would say the same thing twice, in the user's own
                // prompt, where the model reads it as an instruction they
                // wrote.
                args.push(req.prompt.to_string());
                Ok(Invocation {
                    bin: "opencode".into(),
                    args,
                    env: vec![],
                    stdout_is_stream_json: false,
                })
            }
            InvokeMode::PtyRepl => {
                let mut args = common_args(req);
                if let Some(sid) = req.resume_session_id {
                    args.extend(["-s".into(), sid.into()]);
                }
                Ok(Invocation {
                    bin: "opencode".into(),
                    args,
                    env: vec![],
                    stdout_is_stream_json: false,
                })
            }
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
    fn a_plain_run_is_the_prompt_plus_the_flags_that_make_failures_legible() {
        let inv = OpenCode.build_invocation(&req(InvokeMode::OneShot)).unwrap();
        assert_eq!(
            inv.args,
            vec!["run", "--print-logs", "--log-level", "ERROR", "fix the retry loop"]
        );
        // Not Anthropic stream-json — flipping this feeds OpenCode's records
        // to Claude's line parser.
        assert!(!inv.stdout_is_stream_json);
    }

    #[test]
    fn a_run_asks_opencode_for_the_reason_behind_its_own_error_envelope() {
        // Without these, a failed run's stderr is `UnknownError / "Unexpected
        // server error"` and the actual cause never leaves OpenCode's log —
        // which is how a wrong model id turns into "service failure".
        let inv = OpenCode.build_invocation(&req(InvokeMode::OneShot)).unwrap();
        assert!(inv.args.iter().any(|a| a == "--print-logs"));
        assert!(inv.args.windows(2).any(|w| w == ["--log-level", "ERROR"]));
    }

    #[test]
    fn the_tui_gets_no_log_flags_because_they_would_paint_over_its_screen() {
        // The TUI and its stderr share one PTY, so a log line lands in the
        // middle of the interface. It shows its own errors on screen anyway.
        let inv = OpenCode.build_invocation(&req(InvokeMode::PtyRepl)).unwrap();
        assert!(!inv.args.iter().any(|a| a == "--print-logs"));
        assert!(!inv.args.iter().any(|a| a == "--log-level"));
    }

    #[test]
    fn the_prompt_stays_last_so_flags_are_not_read_as_message() {
        let mut r = req(InvokeMode::OneShot);
        r.model = Some("anthropic/claude-sonnet-5");
        r.effort = Some(ReasoningEffort::High);
        let inv = OpenCode.build_invocation(&r).unwrap();
        assert_eq!(inv.args.last().unwrap(), "fix the retry loop");
        assert_eq!(
            inv.args,
            vec![
                "run",
                "--print-logs",
                "--log-level",
                "ERROR",
                "-m",
                "anthropic/claude-sonnet-5",
                "--variant",
                "high",
                "fix the retry loop",
            ]
        );
    }

    #[test]
    fn no_effort_picked_means_no_variant_flag_at_all() {
        // `--variant` speaks the provider's vocabulary, not OpenCode's. A
        // default guess would reject models that have no variants.
        let inv = OpenCode.build_invocation(&req(InvokeMode::OneShot)).unwrap();
        assert!(!inv.args.iter().any(|a| a == "--variant"));
    }

    #[test]
    fn fast_asks_for_the_smallest_variant() {
        let mut r = req(InvokeMode::OneShot);
        r.effort = Some(ReasoningEffort::Max);
        r.fast = true;
        let inv = OpenCode.build_invocation(&r).unwrap();
        assert!(inv.args.windows(2).any(|w| w == ["--variant", "minimal"]));
    }

    #[test]
    fn read_only_mode_switches_agent_rather_than_asking_nicely() {
        let mut r = req(InvokeMode::OneShot);
        r.approval = Some(ApprovalPolicy::Plan);
        let inv = OpenCode.build_invocation(&r).unwrap();
        assert!(inv.args.windows(2).any(|w| w == ["--agent", "plan"]));
        // The prompt is the user's prompt, not the user's prompt with our
        // instructions glued to the front of it.
        assert_eq!(inv.args.last().unwrap(), "fix the retry loop");
    }

    #[test]
    fn accept_edits_grants_nothing_because_auto_would_grant_everything() {
        let mut r = req(InvokeMode::OneShot);
        r.approval = Some(ApprovalPolicy::AcceptEdits);
        let inv = OpenCode.build_invocation(&r).unwrap();
        assert_eq!(
            inv.args,
            vec!["run", "--print-logs", "--log-level", "ERROR", "fix the retry loop"]
        );
    }

    #[test]
    fn bypass_is_the_only_policy_that_auto_approves() {
        let mut r = req(InvokeMode::OneShot);
        r.approval = Some(ApprovalPolicy::Bypass);
        let inv = OpenCode.build_invocation(&r).unwrap();
        assert!(inv.args.iter().any(|a| a == "--auto"));
    }

    #[test]
    fn a_restored_tab_rejoins_its_session_instead_of_starting_a_new_one() {
        let mut r = req(InvokeMode::PtyRepl);
        r.resume_session_id = Some("ses_abc123");
        r.model = Some("zai/glm-5.2");
        let inv = OpenCode.build_invocation(&r).unwrap();
        assert_eq!(inv.args, vec!["-m", "zai/glm-5.2", "-s", "ses_abc123"]);
        assert!(OpenCode.capabilities().resume);
    }

    #[test]
    fn a_bare_repl_takes_no_flags_and_no_prompt() {
        let inv = OpenCode.build_invocation(&req(InvokeMode::PtyRepl)).unwrap();
        assert!(inv.args.is_empty());
    }
}
