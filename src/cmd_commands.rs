//! `aura commands` — the full command reference, plus the help-shaping that keeps
//! everyday commands on the first-run path while the long tail stays one
//! `--help` away.
//!
//! Aura's CLI has grown past a hundred subcommands. Listing all of them in
//! `aura --help` buries the handful a new user actually needs. This module is
//! the two halves of one idea:
//!
//!   * [`shape_help`] hides every non-primary subcommand from the top-level help
//!     listing. Hidden commands stay fully invokable, keep their aliases, and
//!     still show up in shell completions and their own `aura <cmd> --help` — only
//!     the `aura --help` *listing* is trimmed, so a first run shows ~10 commands.
//!   * [`print_commands`] renders the *complete* reference, grouped under the
//!     three verbs the product is organized around — **Trace** (capture,
//!     understand, rewind), **Crew** (plan & execute with agents), and
//!     **Control** (policy, governance, access) — with a **More** bucket for the
//!     long tail (sync, sessions, node, plugins, …).
//!
//! One vocabulary, one spine: the same Trace / Crew / Control names the desktop's
//! Trace surface, the Crew overlay, and the console's governance tab. The
//! grouping lives in data (the tables below) so the reference can't drift from
//! the commands that actually exist — a unit test asserts every name here
//! resolves to a real subcommand, and that `--help` shows exactly the primary set.

use clap::Command;
use colored::Colorize;

/// Commands shown in `aura --help` — the first-run path. Everything else is
/// hidden from that listing by [`shape_help`] (but stays invokable and appears in
/// `aura commands`). Names are clap command names (post-rename), not Rust idents.
///
/// The set covers the four things a new user needs — capture, why, rewind, and
/// Crew setup — with one representative per verb of Control, and stays around ten.
pub const PRIMARY: &[&str] = &[
    // Trace — capture, understand, rewind
    "init", "enable", "status", "explain", "history", "rewind",
    // Crew — execution
    "crew",
    // Control — policy, governance, access
    "pr-review", "access", "doctor",
    // Always available
    "commands", "help",
];

/// Trace — capture, understand, and rewind the code's real history.
const TRACE: &[&str] = &[
    "init", "enable", "disable", "status", "save", "log-intent",
    "explain", "history", "intents", "recall", "intent-vs-actual",
    "review", "diff", "change-note", "audit",
    "rewind", "restore", "replay",
];

/// Crew — plan and execute work with agents.
const CREW: &[&str] = &[
    "crew", "plan", "propose-plan", "execute", "orchestrate", "symphony",
    "runner", "work", "worktrees", "task", "goals", "activity",
    "subagent", "a2a-task",
];

/// Control — policy, governance, and access.
const CONTROL: &[&str] = &[
    "access", "policy", "scope", "grant", "request-access",
    "goal-trace", "pr-review", "doctor", "config",
    "attest", "keys", "taste", "refs",
];

#[derive(Clone, Copy)]
enum Group {
    Trace,
    Crew,
    Control,
    More,
}

impl Group {
    fn heading(self) -> &'static str {
        match self {
            Group::Trace => "TRACE      capture, understand, rewind",
            Group::Crew => "CREW       plan and execute with agents",
            Group::Control => "CONTROL    policy, governance, access",
            Group::More => "MORE       everything else — sync, sessions, node, plugins, …",
        }
    }
}

fn group_of(name: &str) -> Group {
    if TRACE.contains(&name) {
        Group::Trace
    } else if CREW.contains(&name) {
        Group::Crew
    } else if CONTROL.contains(&name) {
        Group::Control
    } else {
        Group::More
    }
}

/// Hide every non-primary subcommand from the top-level `--help` listing. The
/// commands still parse, keep their aliases, and appear in shell completions and
/// in `aura commands`; only the `aura --help` listing is trimmed to the primary
/// set. Applied to the parsed command in `main`, never to the one handed to
/// `clap_complete` (completions stay complete).
pub fn shape_help(mut cmd: Command) -> Command {
    let names: Vec<String> = cmd
        .get_subcommands()
        .map(|c| c.get_name().to_string())
        .collect();
    for name in names {
        // clap's built-in `help` and the primary set stay visible.
        if name == "help" || PRIMARY.contains(&name.as_str()) {
            continue;
        }
        cmd = cmd.mut_subcommand(&name, |c| c.hide(true));
    }
    cmd
}

/// Print the full command reference grouped by Trace · Crew · Control · More.
///
/// `root` is the *unshaped* command tree (so grouping reflects every command,
/// hidden or not). Commands the derive marks internal (`hide = true` plumbing
/// like `git-credential`, `mcp`, `capture-context`) are skipped unless `all` is
/// set — they are machinery, not user surface. Respects `NO_COLOR` /
/// accessible mode automatically via the `colored` crate.
pub fn print_commands(root: &Command, all: bool) {
    // buckets: Trace, Crew, Control, More — each (name, about-first-line, primary?)
    let mut buckets: [Vec<(String, String, bool)>; 4] =
        [Vec::new(), Vec::new(), Vec::new(), Vec::new()];

    for sc in root.get_subcommands() {
        let name = sc.get_name();
        if name == "help" {
            continue;
        }
        // Internal plumbing (originally hidden in the derive) only with --all.
        if sc.is_hide_set() && !all {
            continue;
        }
        let about = sc.get_about().map(|s| s.to_string()).unwrap_or_default();
        let about = about.lines().next().unwrap_or("").trim().to_string();
        let primary = PRIMARY.contains(&name);
        let idx = match group_of(name) {
            Group::Trace => 0,
            Group::Crew => 1,
            Group::Control => 2,
            Group::More => 3,
        };
        buckets[idx].push((name.to_string(), about, primary));
    }

    println!();
    println!(
        "  {}",
        "aura — commands grouped by Trace · Crew · Control".bold()
    );
    println!(
        "  {}",
        "★ marks the everyday commands shown in `aura --help`.".dimmed()
    );

    let order = [Group::Trace, Group::Crew, Group::Control, Group::More];
    for (i, g) in order.iter().enumerate() {
        let mut rows = std::mem::take(&mut buckets[i]);
        if rows.is_empty() {
            continue;
        }
        rows.sort_by(|a, b| a.0.cmp(&b.0));
        let width = rows.iter().map(|(n, _, _)| n.len()).max().unwrap_or(0);
        println!();
        println!("  {}", g.heading().cyan().bold());
        for (name, about, primary) in rows {
            let star = if primary { "★".yellow() } else { " ".normal() };
            println!("    {} {:<width$}  {}", star, name, about.dimmed(), width = width);
        }
    }

    println!();
    if all {
        println!(
            "  Run {} for details on any command.",
            "aura <command> --help".cyan()
        );
    } else {
        println!(
            "  Run {} for any command; {} also lists internal plumbing.",
            "aura <command> --help".cyan(),
            "aura commands --all".cyan()
        );
    }
    println!();
}

#[cfg(test)]
mod tests {
    use super::*;
    use clap::CommandFactory;
    use std::collections::HashSet;

    /// Run a test body on a 16 MiB stack. Building this ~115-command clap tree
    /// (and `debug_assert`-ing it) recurses deeper than the 2 MiB default
    /// test-thread stack — a clap depth artifact, not a defect. `main` runs on
    /// macOS's 8 MiB main thread, exactly as the original `Cli::parse()` did, so
    /// production is unaffected; only these tests need the headroom.
    fn on_big_stack<T: Send + 'static>(f: impl FnOnce() -> T + Send + 'static) -> T {
        std::thread::Builder::new()
            .stack_size(16 * 1024 * 1024)
            .spawn(f)
            .expect("spawn big-stack test thread")
            .join()
            .expect("test body panicked (see panic message above)")
    }

    fn real_names() -> HashSet<String> {
        crate::Cli::command()
            .get_subcommands()
            .map(|c| c.get_name().to_string())
            .collect()
    }

    /// clap's own structural invariants (dup args, bad defaults, etc.). This is
    /// the CI safety net the CLI previously lacked.
    #[test]
    fn clap_command_tree_is_valid() {
        on_big_stack(|| crate::Cli::command().debug_assert());
    }

    /// Every name in PRIMARY and the three group tables must resolve to a real
    /// subcommand — catches a typo or a renamed/removed command at test time.
    #[test]
    fn tables_reference_only_real_commands() {
        on_big_stack(|| {
            let real = real_names();
            for name in PRIMARY {
                if *name == "help" {
                    continue; // clap builtin, always present at parse time
                }
                assert!(real.contains(*name), "PRIMARY lists unknown command `{name}`");
            }
            for name in TRACE.iter().chain(CREW).chain(CONTROL) {
                assert!(
                    real.contains(*name),
                    "group table lists unknown command `{name}`"
                );
            }
        });
    }

    /// After shaping, `aura --help` shows exactly the primary set: every
    /// primary command is visible, every other command is hidden.
    #[test]
    fn shape_help_shows_only_primary() {
        on_big_stack(|| {
            let shaped = shape_help(crate::Cli::command());
            for sc in shaped.get_subcommands() {
                let name = sc.get_name();
                if name == "help" {
                    continue;
                }
                let visible = !sc.is_hide_set();
                let primary = PRIMARY.contains(&name);
                assert_eq!(
                    visible, primary,
                    "`{name}`: visible in help = {visible}, but primary = {primary}"
                );
            }
        });
    }

    /// Hiding is cosmetic: an advanced command still exists in the tree after
    /// shaping, and a renamed command keeps its compatibility alias
    /// (`aura loop` → `crew`).
    #[test]
    fn hidden_commands_and_aliases_survive_shaping() {
        on_big_stack(|| {
            let shaped = shape_help(crate::Cli::command());
            assert!(
                shaped.get_subcommands().any(|c| c.get_name() == "daemon"),
                "hidden `daemon` should still be present after shaping"
            );
            let crew = shaped
                .get_subcommands()
                .find(|c| c.get_name() == "crew")
                .expect("`crew` command should exist");
            assert!(
                crew.get_all_aliases().any(|a| a == "loop"),
                "`crew` should keep its `loop` compatibility alias"
            );
        });
    }

    /// The primary set stays "roughly ten" user commands (plus `commands` and
    /// the `help` builtin) — a guard against the first-run path silently growing.
    #[test]
    fn primary_set_stays_small() {
        let user_primary = PRIMARY
            .iter()
            .filter(|n| **n != "help" && **n != "commands")
            .count();
        assert!(
            (8..=12).contains(&user_primary),
            "primary user commands = {user_primary}, expected ~10"
        );
    }
}
