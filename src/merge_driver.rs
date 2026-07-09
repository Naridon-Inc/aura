//! `aura merge-driver` — git merge driver entry point (board AURA-44).
//!
//! Git invokes the driver as `%O %A %B` (base/ours/theirs TEMP files, no
//! meaningful extension) plus `%L` (marker size) and `%P` (the real repo path,
//! which drives language detection). The merged result is written INTO the
//! ours file; exit 0 = clean, exit 1 = conflicts left.
//!
//! This IMPROVES git's merge, never replaces it: any doubt (parse failure,
//! unsupported language, internal error) falls back to `git merge-file` on the
//! original files and passes its exit semantics through.

use colored::Colorize;
use std::path::Path;
use std::process::Command;

// The AST merge engine lives next to its only caller; the module list in
// main.rs stays a single `mod merge_driver;` line. (Same pattern as
// pr.rs / pr_humanize.rs.)
#[path = "merge_driver_engine.rs"]
mod engine;

// Wire 5 (AURA-46): real node conflicts additionally land as ConflictedNode
// rows in `.aura/conflicts.jsonl` for the desktop ConflictsDialog. Strictly
// additive — the merge result and exit code never depend on it.
#[path = "merge_driver_conflicts.rs"]
mod conflict_rows;

#[cfg(test)]
#[path = "merge_driver_tests.rs"]
mod tests;

use engine::SemanticMerge;

/// Patterns appended to `.git/info/attributes` by `--install` (repo-local,
/// never a committed .gitattributes — installing the driver is a per-clone
/// choice, and clones without aura must not see broken `merge=aura` refs).
const ATTRIBUTE_HEADER: &str = "# aura merge-driver (managed by `aura merge-driver --install`)";
const ATTRIBUTE_PATTERNS: [&str; 5] = [
    "*.rs merge=aura",
    "*.ts merge=aura",
    "*.tsx merge=aura",
    "*.py merge=aura",
    "*.go merge=aura",
];

/// Dispatch for the subcommand. Returns the process exit code.
#[allow(clippy::too_many_arguments)]
pub fn run(
    base: Option<&Path>,
    ours: Option<&Path>,
    theirs: Option<&Path>,
    path_hint: Option<&str>,
    marker_size: usize,
    install: bool,
    uninstall: bool,
    status: bool,
    json: bool,
) -> i32 {
    if status {
        return do_status(json);
    }
    if install {
        return match do_install() {
            Ok(()) => 0,
            Err(e) => {
                eprintln!("{} {}", "✗".red().bold(), e);
                1
            }
        };
    }
    if uninstall {
        return match do_uninstall() {
            Ok(()) => 0,
            Err(e) => {
                eprintln!("{} {}", "✗".red().bold(), e);
                1
            }
        };
    }
    let (Some(base), Some(ours), Some(theirs)) = (base, ours, theirs) else {
        eprintln!(
            "{} merge-driver needs <base> <ours> <theirs> (or --install / --uninstall)",
            "✗".red().bold()
        );
        return 2;
    };
    run_driver(base, ours, theirs, path_hint, marker_size)
}

/// The actual merge. Marker size 0 from a misconfigured `%L` is normalized to
/// git's default of 7 so we never emit marker-less conflicts.
fn run_driver(
    base: &Path,
    ours: &Path,
    theirs: &Path,
    path_hint: Option<&str>,
    marker_size: usize,
) -> i32 {
    let marker_size = if marker_size == 0 { 7 } else { marker_size };

    let ext = path_hint
        .and_then(|p| Path::new(p).extension().map(|e| e.to_string_lossy().to_lowercase()));

    let semantic = match (read_utf8(base), read_utf8(ours), read_utf8(theirs), ext) {
        (Some(b), Some(o), Some(t), Some(ext)) => {
            engine::semantic_merge_3way(&b, &o, &t, &ext, marker_size)
        }
        (_, _, _, None) => SemanticMerge::Fallback("no --path extension to detect language".into()),
        _ => SemanticMerge::Fallback("unreadable or non-UTF8 input".into()),
    };

    match semantic {
        SemanticMerge::Clean(content) => match std::fs::write(ours, content) {
            Ok(()) => 0,
            Err(e) => {
                // Could not write the result — let git merge-file own the file.
                eprintln!("aura merge-driver: write failed ({}), falling back", e);
                git_merge_file_in_place(ours, base, theirs, marker_size)
            }
        },
        SemanticMerge::Conflicted { content, conflicts, details } => {
            if std::env::var("AURA_MERGE_DEBUG").is_ok() {
                eprintln!("aura merge-driver: {} semantic conflict(s) left", conflicts);
            }
            match std::fs::write(ours, content) {
                Ok(()) => {
                    // Additive only — the markers are already on disk and the
                    // exit code is already decided. emit() swallows every
                    // failure (and skips repos without a `.aura/` dir).
                    conflict_rows::emit(path_hint, &details);
                    1
                }
                Err(e) => {
                    eprintln!("aura merge-driver: write failed ({}), falling back", e);
                    git_merge_file_in_place(ours, base, theirs, marker_size)
                }
            }
        }
        SemanticMerge::Fallback(reason) => {
            // Quiet by design: the fallback IS the normal git behavior. The
            // reason only matters when debugging, so gate it on env.
            if std::env::var("AURA_MERGE_DEBUG").is_ok() {
                eprintln!("aura merge-driver: fallback → git merge-file ({})", reason);
            }
            git_merge_file_in_place(ours, base, theirs, marker_size)
        }
    }
}

fn read_utf8(path: &Path) -> Option<String> {
    std::fs::read(path).ok().and_then(|b| String::from_utf8(b).ok())
}

/// `git merge-file` writes the merge (markers and all) into <ours> and exits
/// with the number of conflicts (0 = clean, negative→255 = error). Pass that
/// straight through — git only distinguishes zero from non-zero.
fn git_merge_file_in_place(ours: &Path, base: &Path, theirs: &Path, marker_size: usize) -> i32 {
    let status = Command::new("git")
        .arg("merge-file")
        .arg(format!("--marker-size={}", marker_size))
        .args(["-L", "ours", "-L", "base", "-L", "theirs"])
        .arg(ours)
        .arg(base)
        .arg(theirs)
        .status();
    match status {
        Ok(s) => s.code().unwrap_or(255),
        Err(e) => {
            eprintln!("aura merge-driver: failed to run git merge-file: {}", e);
            255
        }
    }
}

// ─── Install / Uninstall ───────────────────────────────────────────────────

fn git_in_repo(args: &[&str]) -> Result<String, String> {
    let out = Command::new("git")
        .args(args)
        .output()
        .map_err(|e| format!("failed to run git: {}", e))?;
    if !out.status.success() {
        return Err(format!(
            "git {} failed: {}",
            args.join(" "),
            String::from_utf8_lossy(&out.stderr).trim()
        ));
    }
    Ok(String::from_utf8_lossy(&out.stdout).trim().to_string())
}

/// `[merge "aura"]` in .git/config + suggested patterns in
/// .git/info/attributes. Idempotent: re-running changes nothing.
fn do_install() -> Result<(), String> {
    git_in_repo(&["rev-parse", "--git-dir"])
        .map_err(|_| "not inside a git repository".to_string())?;

    git_in_repo(&["config", "merge.aura.name", "Aura semantic AST merge"])?;
    // Do NOT add quotes around %P: git shell-quotes the substituted path
    // itself, so `--path "%P"` would hand us a literally-quoted 'lib.rs'
    // (extension "rs'" → permanent fallback). %O/%A/%B are git-generated
    // temp names, also safe bare.
    git_in_repo(&[
        "config",
        "merge.aura.driver",
        "aura merge-driver %O %A %B --marker-size %L --path %P",
    ])?;

    let attributes_path = git_in_repo(&["rev-parse", "--git-path", "info/attributes"])?;
    let attributes_path = Path::new(&attributes_path);
    if let Some(parent) = attributes_path.parent() {
        std::fs::create_dir_all(parent)
            .map_err(|e| format!("cannot create {}: {}", parent.display(), e))?;
    }
    let existing = std::fs::read_to_string(attributes_path).unwrap_or_default();
    let existing_lines: Vec<&str> = existing.lines().map(str::trim).collect();

    let mut additions = Vec::new();
    for pattern in ATTRIBUTE_PATTERNS {
        if !existing_lines.contains(&pattern) {
            additions.push(pattern);
        }
    }
    if !additions.is_empty() {
        let mut content = existing.clone();
        if !content.is_empty() && !content.ends_with('\n') {
            content.push('\n');
        }
        if !existing_lines.contains(&ATTRIBUTE_HEADER) {
            content.push_str(ATTRIBUTE_HEADER);
            content.push('\n');
        }
        for pattern in &additions {
            content.push_str(pattern);
            content.push('\n');
        }
        std::fs::write(attributes_path, content)
            .map_err(|e| format!("cannot write {}: {}", attributes_path.display(), e))?;
    }

    println!(
        "{} merge driver installed: [merge \"aura\"] in .git/config, patterns in {}",
        "✓".green().bold(),
        attributes_path.display()
    );
    println!(
        "  {}",
        "rs / ts / tsx / py / go files now merge at the AST node level.".dimmed()
    );
    Ok(())
}

/// Quiet, idempotent install into a SPECIFIC repo — the programmatic twin of
/// `do_install` for callers that aren't the `--install` CLI (e.g. the loop's
/// worktree drain, which configures the AST merge driver before it merges N
/// agents' branches back so overlapping edits auto-resolve at the node level
/// instead of conflicting). Operates on `repo_root` rather than the process
/// cwd, and prints nothing. Re-running is a no-op.
pub fn ensure_installed(repo_root: &Path) -> Result<(), String> {
    let git = |args: &[&str]| -> Result<String, String> {
        let out = Command::new("git")
            .args(args)
            .current_dir(repo_root)
            .output()
            .map_err(|e| format!("failed to run git: {}", e))?;
        if !out.status.success() {
            return Err(format!(
                "git {} failed: {}",
                args.join(" "),
                String::from_utf8_lossy(&out.stderr).trim()
            ));
        }
        Ok(String::from_utf8_lossy(&out.stdout).trim().to_string())
    };

    git(&["rev-parse", "--git-dir"]).map_err(|_| "not inside a git repository".to_string())?;
    git(&["config", "merge.aura.name", "Aura semantic AST merge"])?;
    git(&[
        "config",
        "merge.aura.driver",
        "aura merge-driver %O %A %B --marker-size %L --path %P",
    ])?;

    let attributes_path = git(&["rev-parse", "--git-path", "info/attributes"])?;
    let attributes_path = Path::new(&attributes_path);
    if let Some(parent) = attributes_path.parent() {
        std::fs::create_dir_all(parent)
            .map_err(|e| format!("cannot create {}: {}", parent.display(), e))?;
    }
    let existing = std::fs::read_to_string(attributes_path).unwrap_or_default();
    let existing_lines: Vec<&str> = existing.lines().map(str::trim).collect();

    let additions: Vec<&str> = ATTRIBUTE_PATTERNS
        .iter()
        .copied()
        .filter(|p| !existing_lines.contains(p))
        .collect();
    if !additions.is_empty() {
        let mut content = existing.clone();
        if !content.is_empty() && !content.ends_with('\n') {
            content.push('\n');
        }
        if !existing_lines.contains(&ATTRIBUTE_HEADER) {
            content.push_str(ATTRIBUTE_HEADER);
            content.push('\n');
        }
        for pattern in &additions {
            content.push_str(pattern);
            content.push('\n');
        }
        std::fs::write(attributes_path, content)
            .map_err(|e| format!("cannot write {}: {}", attributes_path.display(), e))?;
    }
    Ok(())
}

/// Remove the `[merge "aura"]` section and our attribute lines. Idempotent;
/// other people's attribute lines are left untouched.
fn do_uninstall() -> Result<(), String> {
    git_in_repo(&["rev-parse", "--git-dir"])
        .map_err(|_| "not inside a git repository".to_string())?;

    // Section may not exist — that's fine, uninstall is idempotent.
    let _ = Command::new("git")
        .args(["config", "--remove-section", "merge.aura"])
        .output();

    let attributes_path = git_in_repo(&["rev-parse", "--git-path", "info/attributes"])?;
    let attributes_path = Path::new(&attributes_path);
    if let Ok(existing) = std::fs::read_to_string(attributes_path) {
        let kept: Vec<&str> = existing
            .lines()
            .filter(|line| {
                let t = line.trim();
                t != ATTRIBUTE_HEADER && !ATTRIBUTE_PATTERNS.contains(&t)
            })
            .collect();
        if kept.iter().all(|l| l.trim().is_empty()) {
            let _ = std::fs::remove_file(attributes_path);
        } else {
            let mut content = kept.join("\n");
            content.push('\n');
            std::fs::write(attributes_path, content)
                .map_err(|e| format!("cannot write {}: {}", attributes_path.display(), e))?;
        }
    }

    println!("{} merge driver removed from this repository", "✓".green().bold());
    Ok(())
}

// ─── Status (wire 4 of AURA-46) ────────────────────────────────────────────

/// What `--status` reports. Mirrors exactly what `--install` writes, plus
/// whether a bare `aura` resolves on PATH (the driver line invokes `aura`, so
/// a missing binary means git would silently fall back to its own merge).
#[derive(serde::Serialize)]
struct DriverStatus {
    /// True when `.git/config` carries a `[merge "aura"]` driver line.
    installed: bool,
    /// The configured `merge.aura.driver` command, when present.
    driver_line: Option<String>,
    /// The `merge=aura` lines currently in `.git/info/attributes`.
    attributes_patterns: Vec<String>,
    /// True when an `aura` executable resolves on PATH.
    aura_on_path: bool,
}

fn collect_status() -> DriverStatus {
    let driver_line =
        git_in_repo(&["config", "--get", "merge.aura.driver"]).ok().filter(|s| !s.is_empty());
    let attributes_patterns = git_in_repo(&["rev-parse", "--git-path", "info/attributes"])
        .ok()
        .and_then(|p| std::fs::read_to_string(p).ok())
        .map(|body| {
            body.lines()
                .map(str::trim)
                .filter(|l| !l.starts_with('#') && l.contains("merge=aura"))
                .map(String::from)
                .collect()
        })
        .unwrap_or_default();
    DriverStatus {
        installed: driver_line.is_some(),
        driver_line,
        attributes_patterns,
        aura_on_path: aura_resolves_on_path(),
    }
}

fn aura_resolves_on_path() -> bool {
    let exe = if cfg!(windows) { "aura.exe" } else { "aura" };
    std::env::var_os("PATH")
        .map(|path| std::env::split_paths(&path).any(|dir| dir.join(exe).is_file()))
        .unwrap_or(false)
}

/// Read-only report; always exits 0 so callers (the desktop Settings pane)
/// can distinguish "not installed" (a state) from "command failed" (an error).
fn do_status(json: bool) -> i32 {
    let status = collect_status();
    if json {
        match serde_json::to_string(&status) {
            Ok(line) => println!("{}", line),
            Err(e) => {
                eprintln!("{} failed to serialize status: {}", "✗".red().bold(), e);
                return 1;
            }
        }
        return 0;
    }
    match &status.driver_line {
        Some(line) => println!(
            "{} driver installed — {}",
            "✓".green().bold(),
            line.dimmed()
        ),
        None => println!(
            "{} driver not installed — run `aura merge-driver --install`",
            "○".dimmed()
        ),
    }
    match status.attributes_patterns.len() {
        0 => println!("  no merge=aura patterns in .git/info/attributes"),
        n => println!(
            "  {} merge=aura pattern(s) in .git/info/attributes",
            n
        ),
    }
    if status.aura_on_path {
        println!("  aura binary resolves on PATH");
    } else {
        println!("  {} aura binary NOT on PATH — git would fall back silently", "!".yellow());
    }
    0
}
