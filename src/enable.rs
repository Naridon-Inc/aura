//! `aura enable` / `aura disable` — the frictionless, no-MCP drop-in front door.
//!
//! The Entire-style adoption story: one command turns on passive semantic
//! capture for WHATEVER agent the developer already runs (Claude Code, Cursor,
//! Codex, Gemini, …). No MCP server, no agent cooperation, no interactive
//! wizard — just Aura's git hooks, so every commit records a semantic
//! checkpoint (what changed, why, by which agent) straight into git.
//!
//! `aura init` stays the full interactive setup (API keys, baseline scan,
//! statusline, MCP wiring). `aura enable` is its lean, idempotent, scriptable
//! subset: the minimum that makes Aura *capture*. `aura disable` is the exact
//! inverse — it strips Aura's hook block and nothing else, leaving the
//! semantic history already in git untouched.

use std::fs;
use std::path::Path;

use colored::Colorize;

use crate::hook::HookInstaller;

/// Agent CLIs Aura captures passively once enabled. The whole point of
/// `enable` is that it rides whatever the developer already has installed —
/// so this list is only used to print a friendly "detected on your PATH" line,
/// never to gate anything.
const KNOWN_AGENTS: &[(&str, &str)] = &[
    ("claude", "Claude Code"),
    ("codex", "Codex CLI"),
    ("gemini", "Gemini CLI"),
    ("cursor", "Cursor"),
    ("copilot", "Copilot CLI"),
    ("opencode", "OpenCode"),
    ("aider", "Aider"),
];

/// The git hooks `HookInstaller::enable()` writes. Kept here so `disable` knows
/// exactly which files to clean — the two stay in lockstep by construction.
const HOOK_FILES: &[&str] = &["pre-commit", "commit-msg", "post-commit", "post-merge", "pre-push"];

/// `aura enable` — turn on passive semantic capture for this repository.
///
/// Idempotent and non-interactive: ensures `.aura/` exists with the right
/// ignore rules, then installs Aura's git hooks (chained non-destructively
/// alongside Husky / Lefthook / pre-commit). Re-running is a safe no-op —
/// `HookInstaller` signature-checks before appending. No MCP server is started
/// or required; capture works regardless of which agent (or none) edits code.
pub fn run(quiet: bool) -> Result<(), Box<dyn std::error::Error>> {
    if !Path::new(".git").exists() {
        return Err("Not a git repository. Run `git init` first, then `aura enable`.".into());
    }

    // `.aura/` home + correct ignore rules (local runtime state ignored,
    // intent_log + memory tracked). Reuses init's single source of truth.
    fs::create_dir_all(".aura")?;
    crate::ensure_aura_gitignore();

    // The capture engine: pre-commit (AST + intent), commit-msg (trailer),
    // post-commit (durable checkpoint to refs/notes/aura + shadow branch),
    // post-merge (reconcile), pre-push (sync). HookInstaller prints its own
    // "✓ Hooks installed" lines and is idempotent.
    HookInstaller::enable()?;

    // Live `editing` events too, not just `committed`: wire Claude Code's
    // PreToolUse → `aura validate-tool` (which also carries the destructive-op
    // gate). This is the second half of the Team Radar — git hooks above feed
    // `committed`, this feeds live `editing`. Idempotent + reversible
    // (`aura radar wire --undo`), and best-effort: a settings.json hiccup must
    // never fail `enable`.
    let radar_ok = crate::awareness::agent_hook::ensure(Path::new(".")).is_ok();

    if quiet {
        return Ok(());
    }

    println!();
    println!("{} Aura capture is on.", "✓".green().bold());
    println!(
        "  Every commit now records a semantic checkpoint — {}, {}, {} — straight into git ({}).",
        "what changed".bold(),
        "why".bold(),
        "by which agent".bold(),
        "refs/notes/aura".dimmed(),
    );
    println!("  No MCP server, no agent setup. It just captures.");
    if radar_ok {
        println!(
            "  Live activity is on too — edits show on the {} as you work ({}).",
            "Team Radar".bold(),
            "aura radar status".dimmed(),
        );
    }

    let detected = detect_agents();
    if detected.is_empty() {
        println!(
            "  Works with any coding agent you run here — {}.",
            "Claude Code, Cursor, Codex, Gemini, …".dimmed()
        );
    } else {
        println!("  Detected on your PATH: {}.", detected.join(", ").cyan());
    }

    println!();
    println!("  {}   inspect what's captured", "aura status".cyan());
    println!("  {}  see the semantic history", "aura history".cyan());
    println!("  {}  turn capture back off", "aura disable".cyan());
    println!();
    Ok(())
}

/// `aura disable` — remove Aura's git hooks (capture off). Non-destructive:
/// the semantic history already in git (`refs/notes/aura`, the `aura/checkpoints`
/// shadow branch, `.aura/`) is left fully intact, so `aura enable` later resumes
/// where it left off. Only Aura's marker-delimited block is stripped from each
/// hook, so any Husky / Lefthook / user content in the same file survives.
pub fn disable() -> Result<(), Box<dyn std::error::Error>> {
    if !Path::new(".git").exists() {
        return Err("Not a git repository.".into());
    }

    let hooks_dir = Path::new(".git").join("hooks");
    let mut cleaned = 0usize;
    for name in HOOK_FILES {
        let path = hooks_dir.join(name);
        if !path.exists() {
            continue;
        }
        let content = fs::read_to_string(&path)?;
        let stripped = strip_aura_block(&content);
        if stripped != content {
            fs::write(&path, stripped)?;
            cleaned += 1;
        }
    }

    // Symmetric with `enable`'s radar wire: also unhook Claude Code's
    // PreToolUse so live `editing` events stop. Best-effort — leaves any other
    // hooks the developer configured untouched.
    let _ = crate::awareness::agent_hook::remove(Path::new("."));

    println!();
    if cleaned == 0 {
        println!("{} Aura capture wasn't enabled here — no hooks to remove.", "ℹ".blue());
    } else {
        println!(
            "{} Aura capture is off — cleaned Aura's block from {} git hook(s).",
            "✓".green().bold(),
            cleaned
        );
        println!("  Your semantic history is preserved. Run {} to resume.", "aura enable".cyan());
    }
    println!();
    Ok(())
}

/// Strip the `# --- AURA SEMANTIC ENGINE ---` … `# ----…----` block(s) that
/// `HookInstaller::append_hook_safely` writes, leaving the shebang and any
/// other hook content intact. Trailing blank lines the block leaves behind are
/// trimmed so a cleaned hook doesn't accumulate whitespace across enable/disable
/// cycles.
fn strip_aura_block(content: &str) -> String {
    const BEGIN: &str = "# --- AURA SEMANTIC ENGINE ---";
    const END: &str = "# ----------------------------";

    let mut out: Vec<&str> = Vec::new();
    let mut in_block = false;
    for line in content.lines() {
        if !in_block {
            if line.trim_start().starts_with(BEGIN) {
                in_block = true;
            } else {
                out.push(line);
            }
            continue;
        }
        // Inside an Aura block: drop every line through the closing delimiter.
        if line.trim_start().starts_with(END) {
            in_block = false;
        }
    }

    let mut joined = out.join("\n");
    while joined.ends_with('\n') {
        joined.pop();
    }
    if !joined.is_empty() {
        joined.push('\n');
    }
    joined
}

/// Which known agent CLIs are on PATH — purely for the friendly "works with X"
/// line; detection never gates capture.
fn detect_agents() -> Vec<String> {
    KNOWN_AGENTS
        .iter()
        .filter(|(bin, _)| which(bin))
        .map(|(_, label)| label.to_string())
        .collect()
}

/// Minimal PATH probe (no extra deps): is `bin` present as a file on PATH?
fn which(bin: &str) -> bool {
    let Some(path) = std::env::var_os("PATH") else {
        return false;
    };
    std::env::split_paths(&path).any(|dir| dir.join(bin).is_file())
}

#[cfg(test)]
mod tests {
    use super::strip_aura_block;

    #[test]
    fn strips_single_aura_block_keeps_shebang() {
        let hook = "#!/bin/sh\n\n# --- AURA SEMANTIC ENGINE ---\necho hi\naura capture-context\n# ----------------------------\n";
        let out = strip_aura_block(hook);
        assert_eq!(out, "#!/bin/sh\n");
    }

    #[test]
    fn preserves_foreign_hook_content() {
        let hook = "#!/bin/sh\nnpx lint-staged\n\n# --- AURA SEMANTIC ENGINE ---\naura capture-context\n# ----------------------------\n";
        let out = strip_aura_block(hook);
        assert_eq!(out, "#!/bin/sh\nnpx lint-staged\n");
    }

    #[test]
    fn noop_when_no_aura_block() {
        let hook = "#!/bin/sh\nnpx lint-staged\n";
        let out = strip_aura_block(hook);
        assert_eq!(out, hook);
    }

    #[test]
    fn strips_multiple_blocks() {
        let hook = "#!/bin/sh\n# --- AURA SEMANTIC ENGINE ---\naura inject-trailer \"$1\"\n# ----------------------------\nmy-other-hook\n# --- AURA SEMANTIC ENGINE ---\naura persist-checkpoint\n# ----------------------------\n";
        let out = strip_aura_block(hook);
        assert_eq!(out, "#!/bin/sh\nmy-other-hook\n");
    }
}
