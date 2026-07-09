//! The `aura review fix` flow: pick findings, then apply them.
//!
//! The picker is the interactive `[Y]es · [s]elect · [n]o` prompt entire's
//! fixer popularised. Application prefers the repo's configured **fixer
//! agent** (a CLI-wrapper brain that edits the working tree directly); when
//! no agent binary is available it falls back to Aura's deterministic
//! synthesis router ([`crate::gsd`]), writing the patched files itself.

use std::io::{BufRead, IsTerminal, Write};
use std::path::Path;
use std::process::{Command, Stdio};

use colored::Colorize;

use super::findings::Finding;

/// Result of the picker: which findings the user chose to fix.
pub enum Picked {
    /// Apply these findings.
    Selected(Vec<Finding>),
    /// User declined / nothing to do.
    None,
}

/// Show findings and ask `[Y]es · [s]elect · [n]o`. `yes` forces "all"
/// without prompting (for CI / `--yes`).
pub fn pick(findings: &[Finding], yes: bool) -> Picked {
    if findings.is_empty() {
        println!("{} No findings to fix.", "✓".green());
        return Picked::None;
    }
    if yes {
        return Picked::Selected(findings.to_vec());
    }
    if !std::io::stdin().is_terminal() {
        eprintln!(
            "{} Not a terminal — re-run with {} to apply all findings non-interactively.",
            "⚠".yellow(),
            "--yes".cyan()
        );
        return Picked::None;
    }

    println!("\n{}", "Findings".bold().cyan());
    for (i, f) in findings.iter().enumerate() {
        println!(
            "  {:>2}. {} {} {}",
            i + 1,
            severity_badge(f),
            f.title.white(),
            format!("[{}]", f.source).dimmed(),
        );
    }
    print!(
        "\nApply fixes? {} · {} · {} ",
        "[Y]es (all)".green(),
        "[s]elect".yellow(),
        "[n]o".red()
    );
    let _ = std::io::stdout().flush();

    let line = read_line();
    match line.trim().to_ascii_lowercase().as_str() {
        "" | "y" | "yes" => Picked::Selected(findings.to_vec()),
        "s" | "select" => {
            print!("Enter numbers to fix (comma-separated, e.g. 1,3,4): ");
            let _ = std::io::stdout().flush();
            let sel = read_line();
            let chosen = parse_selection(&sel, findings.len());
            if chosen.is_empty() {
                println!("{} Nothing selected.", "·".dimmed());
                Picked::None
            } else {
                Picked::Selected(chosen.into_iter().map(|i| findings[i].clone()).collect())
            }
        }
        _ => {
            println!("{} Skipped.", "·".dimmed());
            Picked::None
        }
    }
}

fn read_line() -> String {
    let mut s = String::new();
    let stdin = std::io::stdin();
    let _ = stdin.lock().read_line(&mut s);
    s
}

/// Parse a `1,3,4` style selection into zero-based, in-range, deduped indices.
fn parse_selection(input: &str, len: usize) -> Vec<usize> {
    let mut out = Vec::new();
    for tok in input.split(',') {
        if let Ok(n) = tok.trim().parse::<usize>() {
            if n >= 1 && n <= len {
                let idx = n - 1;
                if !out.contains(&idx) {
                    out.push(idx);
                }
            }
        }
    }
    out
}

fn severity_badge(f: &Finding) -> colored::ColoredString {
    use super::findings::Severity::*;
    match f.severity {
        Critical => f.severity.label().red().bold(),
        High => f.severity.label().red(),
        Moderate => f.severity.label().yellow(),
        Advisory => f.severity.label().blue(),
        Info => f.severity.label().dimmed(),
    }
}

/// Apply `selected` findings. Returns a human summary line.
pub fn apply(
    repo_root: &Path,
    fixer: Option<&str>,
    base: &str,
    selected: &[Finding],
) -> Result<String, String> {
    if selected.is_empty() {
        return Ok("nothing to apply".to_string());
    }
    // Prefer the configured fixer agent if its binary is installed.
    if let Some(agent_id) = fixer {
        let reg = aura_agents::registry();
        if let Some(p) = reg.get(agent_id) {
            if p.is_available() {
                return apply_with_agent(repo_root, agent_id, selected);
            }
            println!(
                "{} fixer '{}' not installed — falling back to Aura's synthesis router.",
                "·".dimmed(),
                agent_id
            );
        }
    }
    apply_with_router(repo_root, base, selected)
}

/// Run the fixer agent in the working tree; it edits files directly.
fn apply_with_agent(repo_root: &Path, agent_id: &str, selected: &[Finding]) -> Result<String, String> {
    let reg = aura_agents::registry();
    let provider = reg
        .get(agent_id)
        .ok_or_else(|| format!("'{agent_id}' is not a known agent"))?;
    let prompt = build_fix_prompt(selected);
    let inv = provider
        .build_invocation(&aura_agents::InvokeRequest {
            prompt: &prompt,
            mode: aura_agents::InvokeMode::OneShot,
            resume_session_id: None,
            attachments_via_stdin: false,
            effort: None,
            fast: false,
            model: None,
            approval: None,
        })
        .map_err(|e| format!("build fixer invocation: {e}"))?;

    println!(
        "{} Running fixer {} on {} finding(s)…",
        "▸".cyan(),
        agent_id.bold(),
        selected.len()
    );

    let mut cmd = Command::new(&inv.bin);
    cmd.args(&inv.args)
        .current_dir(repo_root)
        .stdin(Stdio::null())
        .stdout(Stdio::inherit())
        .stderr(Stdio::inherit());
    for (k, v) in &inv.env {
        cmd.env(k, v);
    }
    cmd.env_remove("AURA_MANAGER_SESSION_ID");
    if agent_id == "claude" {
        cmd.env_remove("CLAUDECODE");
    }

    let status = cmd
        .status()
        .map_err(|e| format!("could not run fixer {}: {e}", inv.bin))?;

    let changed = changed_files(repo_root);
    if changed.is_empty() {
        return Ok(format!(
            "fixer {agent_id} exited {} but changed no files",
            status.code().map(|c| c.to_string()).unwrap_or_else(|| "?".into())
        ));
    }
    Ok(format!(
        "fixer {agent_id} edited {} file(s): {}",
        changed.len(),
        changed.join(", ")
    ))
}

/// Fallback: synthesise patched files via Aura's deterministic router and
/// write them. Mirrors the Arbitrator's `===FILE:` protocol.
fn apply_with_router(repo_root: &Path, base: &str, selected: &[Finding]) -> Result<String, String> {
    let target_files = gather_target_files(repo_root, base, selected);
    if target_files.is_empty() {
        return Err("no source files in the diff to apply fixes to".to_string());
    }
    let mut files_block = String::new();
    for (path, content) in &target_files {
        files_block.push_str(&format!("===FILE: {path} ===\n{content}\n"));
    }
    let findings_text = selected
        .iter()
        .map(|f| format!("[{}] {}", f.severity.label(), f.title))
        .collect::<Vec<_>>()
        .join("\n");

    let prompt = format!(
        "You are the Aura Arbitrator. Resolve ONLY the findings below — make the minimal \
change that fixes each one, and touch no unrelated code.\n\
\n<findings>\n{findings_text}\n</findings>\n\
\n<target_files>\n{files_block}</target_files>\n\
\nOUTPUT RULES:\n\
1. Fix the code so the findings are resolved.\n\
2. Output ONLY the raw, fixed source for files that need changing.\n\
3. Format each file exactly as:\n===FILE: path/to/file.ext===\n[code]\n\
4. No markdown fences, no commentary.",
    );

    println!("{} Synthesising patch via Aura router…", "▸".cyan());
    let text = crate::gsd::GsdEngine::generate_content(
        &prompt,
        "",
        0.2,
        crate::gsd::CognitiveLabor::Arbitrator,
    )
    .ok_or_else(|| {
        "no fixer agent installed and the AI router has no API key configured \
(set one with `aura config`, or install a fixer agent such as claude)"
            .to_string()
    })?;

    let written = write_file_blocks(repo_root, &text);
    if written.is_empty() {
        return Err("router produced no applicable file blocks".to_string());
    }
    Ok(format!("router wrote {} file(s): {}", written.len(), written.join(", ")))
}

/// Read the source files referenced by the findings (or, if none name a
/// file, every changed source file in the diff).
fn gather_target_files(repo_root: &Path, base: &str, selected: &[Finding]) -> Vec<(String, String)> {
    let mut paths: Vec<String> = selected.iter().filter_map(|f| f.file.clone()).collect();
    paths.sort();
    paths.dedup();
    if paths.is_empty() {
        paths = changed_source_paths(repo_root, base);
    }
    let mut out = Vec::new();
    for p in paths {
        if let Ok(content) = std::fs::read_to_string(repo_root.join(&p)) {
            out.push((p, content));
        }
    }
    out
}

fn changed_source_paths(repo_root: &Path, base: &str) -> Vec<String> {
    let out = Command::new("git")
        .args(["diff", "--name-only", &format!("{base}...HEAD")])
        .current_dir(repo_root)
        .output();
    let names = match out {
        Ok(o) => String::from_utf8_lossy(&o.stdout).to_string(),
        Err(_) => return Vec::new(),
    };
    names
        .lines()
        .map(|s| s.trim().to_string())
        .filter(|s| {
            s.ends_with(".rs") || s.ends_with(".ts") || s.ends_with(".tsx")
                || s.ends_with(".js") || s.ends_with(".py")
        })
        .collect()
}

/// Parse `===FILE: path===` blocks and write each. Returns paths written.
fn write_file_blocks(repo_root: &Path, text: &str) -> Vec<String> {
    let mut written = Vec::new();
    let mut current_file: Option<String> = None;
    let mut current = String::new();
    let mut flush = |file: &mut Option<String>, body: &mut String, written: &mut Vec<String>| {
        if let Some(path) = file.take() {
            if std::fs::write(repo_root.join(&path), body.trim_end()).is_ok() {
                written.push(path);
            }
        }
        body.clear();
    };
    for line in text.lines() {
        let trimmed = line.trim();
        if trimmed.starts_with("===FILE:") && trimmed.ends_with("===") {
            flush(&mut current_file, &mut current, &mut written);
            let path = trimmed
                .trim_start_matches("===FILE:")
                .trim_end_matches("===")
                .trim()
                .to_string();
            current_file = Some(path);
        } else if current_file.is_some() {
            current.push_str(line);
            current.push('\n');
        }
    }
    flush(&mut current_file, &mut current, &mut written);
    written
}

/// Files with uncommitted changes in the working tree right now.
fn changed_files(repo_root: &Path) -> Vec<String> {
    let out = Command::new("git")
        .args(["status", "--porcelain"])
        .current_dir(repo_root)
        .output();
    match out {
        Ok(o) => String::from_utf8_lossy(&o.stdout)
            .lines()
            .filter_map(|l| l.get(3..).map(|s| s.trim().to_string()))
            .filter(|s| !s.is_empty())
            .collect(),
        Err(_) => Vec::new(),
    }
}

fn build_fix_prompt(selected: &[Finding]) -> String {
    let body = selected
        .iter()
        .enumerate()
        .map(|(i, f)| {
            let loc = f.file.as_deref().map(|p| format!(" ({p})")).unwrap_or_default();
            format!("{}. [{}]{} {}", i + 1, f.severity.label(), loc, f.title)
        })
        .collect::<Vec<_>>()
        .join("\n");
    format!(
        "You are the fixer in a code review. Edit the repository to apply minimal, surgical \
fixes for ONLY the findings below. Do not refactor unrelated code, do not weaken or game \
tests to make them pass, and do not commit. When done, print a one-line summary of what you \
changed.\n\n<findings>\n{body}\n</findings>\n"
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    use super::super::findings::Severity;

    #[test]
    fn parse_selection_dedups_and_bounds() {
        assert_eq!(parse_selection("1,3,3,9", 4), vec![0, 2]);
        assert_eq!(parse_selection(" 2 , 1 ", 4), vec![1, 0]);
        assert!(parse_selection("0,5,x", 4).is_empty());
    }

    #[test]
    fn fix_prompt_lists_findings() {
        let f = vec![
            Finding {
                file: Some("src/a.rs".into()),
                ..Finding::new("aura", Severity::High, "bug here")
            },
        ];
        let p = build_fix_prompt(&f);
        assert!(p.contains("bug here"));
        assert!(p.contains("src/a.rs"));
        assert!(p.contains("do not commit"));
    }

    #[test]
    fn write_blocks_roundtrip() {
        let dir = std::env::temp_dir().join(format!("aura-fixblk-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let text = "preamble\n===FILE: out.txt===\nhello\nworld\n";
        let w = write_file_blocks(&dir, text);
        assert_eq!(w, vec!["out.txt".to_string()]);
        let got = std::fs::read_to_string(dir.join("out.txt")).unwrap();
        assert_eq!(got, "hello\nworld");
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn empty_selection_applies_nothing() {
        let dir = std::env::temp_dir();
        let r = apply(&dir, None, "main", &[]).unwrap();
        assert_eq!(r, "nothing to apply");
    }
}
