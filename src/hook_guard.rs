//! Keeping Aura's git hooks from wedging a commit.
//!
//! Everything in here exists because of one asymmetry: a slow gate is annoying,
//! a stuck gate is indistinguishable from a crashed app. `pre-commit` sits
//! directly between the user pressing Commit and anything happening, and when
//! git is driven by a GUI — the Aura desktop app, an IDE source-control panel,
//! `gh`, a CI runner — there is no terminal to show a spinner in and nobody to
//! read a message. A gate that blocks there blocks forever, and the report that
//! comes back is "the app froze", not "the hook is thinking".
//!
//! Two things caused that in practice, and this module answers both:
//!
//! * **Questions nobody can answer.** A hook inherits git's stdin. Under a GUI
//!   client that is a pipe no one will ever write a line to, so `dialoguer`
//!   blocks on a read that cannot complete. [`confirm`] only asks when someone
//!   is actually there, and otherwise takes the documented default out loud.
//!
//! * **Work with no ceiling.** The generated hook used to wrap `capture-context`
//!   in `timeout 30`, which does nothing on macOS — `timeout` and `gtimeout` are
//!   GNU coreutils and neither is installed by default, so every Mac fell
//!   through to the unbounded branch. [`arm_time_budget`] puts the ceiling
//!   inside the binary, where it works on every platform and, crucially, reaches
//!   people whose hook file was written months ago and is never rewritten.

use std::io::IsTerminal;
use std::time::Duration;

use dialoguer::theme::ColorfulTheme;

/// Is there a human on the other end of this process?
///
/// Both ends matter: stdin is what a prompt reads from, stdout is where it draws.
/// A hook run by a GUI client typically has neither.
pub fn interactive() -> bool {
    if std::env::var_os("AURA_NONINTERACTIVE").is_some() {
        return false;
    }
    std::io::stdin().is_terminal() && std::io::stdout().is_terminal()
}

/// Ask a yes/no question when someone can answer, and decide without asking when
/// nobody can — never block waiting for input that will not arrive.
///
/// The two answers are deliberately separate arguments, because they are
/// different questions:
///
/// * `default` is what Enter means to a person who is reading the warning. It is
///   a nudge, and it can be the cautious one, because they can see the list and
///   override it.
/// * `unattended` is what Aura decides on its own behalf when there is no person
///   at all. Cautious is *not* automatically right here: a gate that Aura's own
///   configuration says is advisory must not turn into a hard block just because
///   it ran under a GUI client instead of a terminal.
///
/// `consequence` says what the unattended answer means in this spot, so the hook
/// output explains itself to whoever reads the log afterwards.
pub fn confirm(question: &str, default: bool, unattended: bool, consequence: &str) -> bool {
    if !interactive() {
        eprintln!(
            "[Aura] Nothing is attached to answer \"{question}\" — {consequence}. \
             Run this in a terminal to be asked, or set AURA_SKIP=1 to skip Aura's \
             pre-commit checks."
        );
        return unattended;
    }

    dialoguer::Confirm::with_theme(&ColorfulTheme::default())
        .with_prompt(question)
        .default(default)
        .interact()
        // A prompt that fails despite a terminal (stdin closed mid-prompt, a
        // signal) is still "nobody answered", so it lands on the unattended
        // answer rather than on whatever `unwrap_or` was written inline.
        .unwrap_or(unattended)
}

/// How long a pre-commit gate may run before it gives up and lets the commit
/// through. Overridable with `AURA_CAPTURE_TIMEOUT_SECS`; `0` disables the
/// ceiling for anyone who would rather wait than lose a checkpoint.
fn budget_from_env() -> Option<Duration> {
    let secs = std::env::var("AURA_CAPTURE_TIMEOUT_SECS")
        .ok()
        .and_then(|v| v.trim().parse::<u64>().ok())
        .unwrap_or(60);
    (secs > 0).then(|| Duration::from_secs(secs))
}

/// Put a ceiling on a hook-side gate: after the budget elapses, say so and exit
/// **0** so git proceeds with the commit.
///
/// Exiting zero is the deliberate choice. This gate is advisory — it records
/// meaning about a commit and warns about removals — so failing to finish it
/// must cost the user a checkpoint, never their commit. Blocking work behind an
/// analysis that ran long is precisely the failure being fixed.
///
/// The watchdog is only armed when [`interactive`] is false. At a real terminal
/// a human can see the spinner and press Ctrl-C, and may legitimately be sitting
/// on a prompt for longer than the budget; killing that would be a regression.
/// Without a terminal there is nobody to notice, which is exactly where an
/// unbounded gate turns into a frozen app.
///
/// Returns whether a watchdog was armed, so callers can report it.
pub fn arm_time_budget() -> bool {
    if interactive() {
        return false;
    }
    let Some(budget) = budget_from_env() else {
        return false;
    };

    std::thread::spawn(move || {
        std::thread::sleep(budget);
        eprintln!(
            "[Aura] Semantic analysis passed {}s and is still going, so it is being left behind \
             and the commit continues. No checkpoint was recorded for this commit. Raise the \
             ceiling with AURA_CAPTURE_TIMEOUT_SECS, or set it to 0 to wait however long it takes.",
            budget.as_secs()
        );
        // The process is mid-analysis with nothing durable half-written — the
        // checkpoint is staged in one atomic write at the end — so leaving now
        // is clean.
        std::process::exit(0);
    });
    true
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Under `cargo test` stdin is not a terminal, which is the same shape as a
    /// hook launched by a GUI client — so this pins the property that matters:
    /// the call returns rather than blocking, and it returns the default.
    #[test]
    fn takes_the_unattended_answer_without_a_terminal() {
        assert!(confirm("proceed?", true, true, "proceeding"));
        assert!(!confirm("proceed?", true, false, "stopping"));
        // And it is the *unattended* answer that wins, not the interactive
        // default — the distinction the two arguments exist for.
        assert!(confirm("proceed?", false, true, "proceeding anyway"));
    }

    /// One test, not three, because these all read the same process-wide
    /// variable and `cargo test` runs test fns on parallel threads — split up,
    /// they would race each other's `set_var` and fail at random.
    #[test]
    fn budget_reads_the_env_and_falls_back_sanely() {
        // Explicit zero means "no ceiling, I'd rather wait".
        unsafe { std::env::set_var("AURA_CAPTURE_TIMEOUT_SECS", "0") };
        assert!(budget_from_env().is_none());

        unsafe { std::env::set_var("AURA_CAPTURE_TIMEOUT_SECS", "5") };
        assert_eq!(budget_from_env(), Some(Duration::from_secs(5)));

        // Anything unparseable must not silently disable the ceiling — that is
        // the failure mode this whole module exists to prevent.
        unsafe { std::env::set_var("AURA_CAPTURE_TIMEOUT_SECS", "soon") };
        assert_eq!(budget_from_env(), Some(Duration::from_secs(60)));

        unsafe { std::env::remove_var("AURA_CAPTURE_TIMEOUT_SECS") };
        assert_eq!(budget_from_env(), Some(Duration::from_secs(60)));
    }
}
