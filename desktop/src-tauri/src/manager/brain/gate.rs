//! Who answers when a third-party agent wants to do something.
//!
//! Every engine Aura hosts natively reaches this same trait, whatever
//! protocol it speaks. ACP inverts control and *asks* the client to write
//! the file; pi executes its own tools and offers a pre-execution hook
//! instead. Different wires, one question: may this run, and what has to
//! happen first. Keeping the answer in one place is what makes "every edit
//! goes through Aura's gate" a property of the app rather than a claim
//! repeated per integration.
//!
//! Two pieces:
//!
//!   - [`HostPolicy`] — the connection to the rest of Aura: who to ask, and
//!     what to do before a file is overwritten. A trait rather than a
//!     direct Tauri call so the rules are testable without a window.
//!   - [`install`] / [`for_agent`] — the seam. `registry::build` constructs
//!     brains by provider id and has no `AppHandle` to hand them, so rather
//!     than thread Tauri state through every construction site, the app
//!     installs its gate once at startup and brains read it from here.
//!
//! What is installed is a *factory* keyed by provider id, not one shared
//! policy. Remembered "always" answers are filed under whoever asked, so
//! trusting OpenCode with a tool never quietly extends that trust to pi.
//!
//! Nothing is installed in tests, and nothing is installed if the app's
//! setup ever stops calling [`install`]. That case is not treated as "carry
//! on unsupervised": [`NoApprover`] refuses, and says why. An agent editing
//! this user's repo with nobody able to see the prompt is the exact failure
//! this whole layer exists to prevent, so it fails loudly instead of
//! quietly widening.

use std::path::{Path, PathBuf};
use std::sync::{Arc, OnceLock};

use async_trait::async_trait;
use serde_json::Value;

use super::authority::{self, Capability, Rules, Verdict};

/// Resolve symlinks as far as the filesystem allows.
///
/// Both brains enforce a session root by checking that a path the agent
/// named still starts with it, and both need this first, for two reasons
/// that look unrelated and are the same reason:
///
///   - **The root is often reached through a symlink.** On macOS `/tmp` and
///     `/var/folders` both are. Resolve one side of the comparison and not
///     the other and the root appears to contain nothing — every write in
///     the session refused, the human never even asked.
///   - **A symlink is how you leave a directory you are locked into.** An
///     agent may create one *inside* the root, which is a permitted write
///     because the link's own path is inside, and then act through it.
///     Comparing the un-resolved path lets that through.
///
/// [`Path::canonicalize`] alone cannot do this: it is all-or-nothing, and a
/// write usually names a file that does not exist yet. Canonicalising the
/// deepest ancestor that *does* exist and re-appending the rest resolves
/// every symlink anyway, because a symlink can only be part of the path
/// that exists.
pub fn resolve_symlinks(path: &Path) -> PathBuf {
    let mut tail: Vec<&std::ffi::OsStr> = Vec::new();
    let mut cursor = path;
    loop {
        if let Ok(real) = cursor.canonicalize() {
            let mut out = real;
            out.extend(tail.iter().rev());
            return out;
        }
        match (cursor.parent(), cursor.file_name()) {
            (Some(parent), Some(name)) => {
                tail.push(name);
                cursor = parent;
            }
            // Nothing on this path exists — a bare relative name, or a root
            // that is gone. Lexical is the best answer available.
            _ => return path.to_path_buf(),
        }
    }
}

/// What the human (or a remembered rule) decided about a tool call.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum GateDecision {
    /// Let it run this once.
    Allow,
    /// Let it run, and stop asking for this tool.
    AllowAlways,
    /// Refuse.
    Deny,
}

/// The gate's connection to the rest of Aura. Implemented against Tauri in
/// the app and against a recorder in tests.
#[async_trait]
pub trait HostPolicy: Send + Sync {
    /// Ask about a tool call the agent wants to make. Implementations that
    /// remember an earlier "always" answer return without asking.
    async fn ask_permission(&self, tool: &str, input: &Value) -> GateDecision;

    /// Ask about a capability the project governs, naming the concrete
    /// thing that triggered it.
    ///
    /// Separate from [`Self::ask_permission`] because the two are answered
    /// differently and must be remembered differently. A tool answer is
    /// about a *kind* of call and an "always" for it is reasonable. A
    /// capability answer is about one specific act — this symbol, this
    /// teammate's file, this machine — and remembering it forever would
    /// turn "yes, delete `parse_token`" into "yes, delete anything".
    ///
    /// The default implementation defers to the tool prompt so an existing
    /// `HostPolicy` (there are several, mostly in tests) keeps compiling
    /// and keeps behaving as it did.
    async fn ask_capability(&self, cap: Capability, detail: &str) -> GateDecision {
        self.ask_permission(
            cap.key(),
            &serde_json::json!({ "capability": cap.key(), "detail": detail }),
        )
        .await
    }

    /// Called immediately before a file is written, with the absolute path
    /// and the content about to land there.
    ///
    /// This is where the snapshot is taken. An `Err` aborts the write — if
    /// we cannot protect the file, we do not overwrite it.
    ///
    /// `proposed` is what the agent wants the file to say. It is here
    /// because the interesting question about a write is not *that* it
    /// happened but *what it removes*, and that cannot be answered from a
    /// path alone. `None` means the caller genuinely does not know the new
    /// content — an in-place edit tool, say — and the content-dependent
    /// capabilities are skipped rather than guessed at.
    async fn before_write(&self, path: &Path, proposed: Option<&str>) -> Result<(), String>;
}

/// Builds the policy for one agent, given its provider id.
pub type PolicyFactory = Box<dyn Fn(&str) -> Arc<dyn HostPolicy> + Send + Sync>;

static INSTALLED: OnceLock<PolicyFactory> = OnceLock::new();

/// Install the process-wide gate. Called once, from the app's setup.
/// Later calls are ignored — the first approver wins, so a stray call can't
/// swap the gate out from under a live session.
pub fn install(factory: PolicyFactory) -> bool {
    INSTALLED.set(factory).is_ok()
}

/// The policy this agent's requests should be gated through. `agent` is the
/// provider id that asked (`acp:opencode`, `pi`), which is what remembered
/// answers are keyed on.
pub fn for_agent(agent: &str) -> Arc<dyn HostPolicy> {
    match INSTALLED.get() {
        Some(make) => make(agent),
        None => Arc::new(NoApprover) as Arc<dyn HostPolicy>,
    }
}

/// The fallback when no approver is attached: refuse everything, and name
/// the reason so it surfaces in the agent's own transcript rather than
/// looking like the tool itself failed.
pub struct NoApprover;

pub const NO_APPROVER_REASON: &str =
    "No approver is attached to this Aura session, so there is nobody who could \
     see a permission prompt. Refusing rather than acting unsupervised.";

#[async_trait]
impl HostPolicy for NoApprover {
    async fn ask_permission(&self, _tool: &str, _input: &Value) -> GateDecision {
        GateDecision::Deny
    }

    async fn before_write(&self, _path: &Path, _proposed: Option<&str>) -> Result<(), String> {
        Err(NO_APPROVER_REASON.to_string())
    }
}

// ─── The one door ──────────────────────────────────────────────────────────
//
// Everything below composes the project's standing rules with the human's
// answer, in that order. Callers use these rather than reaching for
// `ask_permission` directly, so "a capability the project refused cannot be
// clicked past" is a property of this module instead of a convention each
// integration is trusted to remember.

/// Put one governed capability through the project's rules, then — only if
/// the rules defer — through the human.
///
/// Note what is deliberately absent: there is no `AllowAlways` outcome. A
/// capability answer is about one specific act, and remembering it would
/// turn "yes, delete `parse_token`" into "yes, delete anything". If someone
/// wants a standing yes, that is what `allow` in `[authority]` is for, and
/// it lands in a commit with their name on it.
pub async fn guard_capability(
    policy: &Arc<dyn HostPolicy>,
    rules: &Rules,
    cap: Capability,
    detail: &str,
) -> Result<(), String> {
    match authority::decide(rules, cap, detail) {
        Verdict::NotGoverned | Verdict::Allow => Ok(()),
        Verdict::Refuse(why) => Err(why),
        Verdict::Ask(cap) => match policy.ask_capability(cap, detail).await {
            GateDecision::Allow | GateDecision::AllowAlways => Ok(()),
            GateDecision::Deny => Err(format!(
                "Aura asked whether you wanted to let this {} ({detail}), and the answer was no.",
                cap.describe()
            )),
        },
    }
}

/// Everything that must be true before a file is overwritten.
///
/// Order is load-bearing and was chosen so a refusal costs nothing and a
/// mistake costs nothing either:
///
/// 1. **Governed capabilities first.** If the project refuses this write,
///    nothing should have happened — no snapshot, no prompt, no disk churn.
/// 2. **Snapshot last, immediately before the write.** A snapshot taken
///    before a prompt the user then sat on for a minute records a file that
///    may have moved on. Taken here, it is the truth at the moment of
///    overwrite.
///
/// `session_id` identifies the run for zone purposes: your own zone must
/// never block you, and the only way to know which is yours is to be told.
pub async fn guard_write(
    policy: &Arc<dyn HostPolicy>,
    session_id: &str,
    path: &Path,
    proposed: Option<&str>,
) -> Result<(), String> {
    // Rules are per-project, and a file's project is its own worktree —
    // the same rule `host_policy` uses to decide where a snapshot lands.
    if let Some(root) = authority::repo_root_for(path) {
        let rules = Rules::load(&root);

        if let Some(holder) = authority::zone_holder(&root, session_id, path) {
            guard_capability(
                policy,
                &rules,
                Capability::WriteOutsideClaimedZone,
                &format!("{} is held by {}", path.display(), holder.describe()),
            )
            .await?;
        }

        // Only answerable when we know what the file is about to say. An
        // in-place edit tool that passes `None` is not guessed at — it
        // falls through to the commit-time deletion guard, which has the
        // full symbol index this shallow reader does not.
        if let Some(after) = proposed {
            let before = tokio::fs::read_to_string(path).await.unwrap_or_default();
            let dropped = authority::symbols_dropped(&before, after);
            if !dropped.is_empty() {
                guard_capability(
                    policy,
                    &rules,
                    Capability::DeleteExportedSymbol,
                    &format!("{} removes {}", path.display(), dropped.join(", ")),
                )
                .await?;
            }
        }
    }

    policy.before_write(path, proposed).await
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[tokio::test]
    async fn an_uninstalled_gate_refuses_rather_than_allows() {
        // `for_agent` is reachable from a brain built in a context that
        // never ran app setup. The safe answer there is no.
        let p = for_agent("acp:opencode");
        assert_eq!(
            p.ask_permission("write", &json!({})).await,
            GateDecision::Deny
        );
        assert!(p.before_write(Path::new("/tmp/x"), None).await.is_err());
    }

    #[tokio::test]
    async fn the_refusal_explains_itself() {
        let err = NoApprover
            .before_write(Path::new("/tmp/x"), None)
            .await
            .unwrap_err();
        assert!(
            err.contains("approver"),
            "the agent shows this to the user; it has to say what went wrong: {err}"
        );
    }

    /// A policy that records what it was asked and answers however the test
    /// wants, so the *composition* can be checked without a window.
    struct Spy {
        answer: GateDecision,
        asked: std::sync::Mutex<Vec<String>>,
    }

    impl Spy {
        fn new(answer: GateDecision) -> Arc<dyn HostPolicy> {
            Arc::new(Spy {
                answer,
                asked: std::sync::Mutex::new(Vec::new()),
            })
        }
    }

    #[async_trait]
    impl HostPolicy for Spy {
        async fn ask_permission(&self, tool: &str, _input: &Value) -> GateDecision {
            self.asked.lock().unwrap().push(tool.to_string());
            self.answer
        }
        async fn before_write(&self, _path: &Path, _proposed: Option<&str>) -> Result<(), String> {
            Ok(())
        }
    }

    #[tokio::test]
    async fn a_refused_capability_never_reaches_the_human() {
        // The whole point of putting the rules first: there is no card to
        // click, because there is no answer that would let it through.
        let policy = Spy::new(GateDecision::Allow);
        let rules = Rules::load(Path::new("/nonexistent"));
        let refuse = Rules::from_toml("[authority]\ndispatch_to_machine = \"refuse\"\n");

        let err = guard_capability(&policy, &refuse, Capability::DispatchToMachine, "box-1")
            .await
            .unwrap_err();
        assert!(err.contains("box-1"), "{err}");

        // And the default really is "ask", so this is a rule doing work
        // rather than a capability that refuses no matter what.
        assert!(
            guard_capability(&policy, &rules, Capability::DispatchToMachine, "box-1")
                .await
                .is_ok()
        );
    }

    #[tokio::test]
    async fn an_allowed_capability_costs_no_prompt() {
        let policy = Spy::new(GateDecision::Deny);
        let rules = Rules::from_toml("[authority]\ndispatch_to_machine = \"allow\"\n");
        assert!(
            guard_capability(&policy, &rules, Capability::DispatchToMachine, "box-1")
                .await
                .is_ok(),
            "an `allow` rule must not be second-guessed by the prompt"
        );
    }

    #[tokio::test]
    async fn a_denied_prompt_names_the_act_in_plain_words() {
        let policy = Spy::new(GateDecision::Deny);
        let rules = Rules::load(Path::new("/nonexistent")); // all Ask
        let err = guard_capability(&policy, &rules, Capability::DeleteExportedSymbol, "parse_token")
            .await
            .unwrap_err();
        assert!(err.contains("parse_token"), "{err}");
        assert!(
            err.contains("other code may be calling"),
            "the person reading this did not write the enum: {err}"
        );
    }
}
