//! `aura work` — human-facing isolated worktrees for parallel coding sessions
//! (a second Claude Code, Codex, or just your own hands), with an AST-aware,
//! tracked merge-back.
//!
//! The problem this solves: you can't open a second coding session on the same
//! repo without either switching branches — which yanks your other in-flight
//! work out from under you — or hand-rolling a `git worktree`, which isolates
//! fine but leaves the hard part on you: merging it back, and knowing WHAT and
//! WHY came back. `aura work` makes that first-class:
//!
//!   aura work new <name>      → fresh worktree on branch `work/<slug>`, off HEAD
//!   aura work list            → every active work worktree + how far ahead it is
//!   aura work merge <name>    → AST-merge it back, gated + recorded in the log
//!   aura work drop <name>     → tear the worktree + branch down
//!
//! Merge-back reuses the exact machinery the autonomous crew uses: the aura AST
//! merge driver (a semantic 3-way merge, not git's line merge) plus an
//! intent-log entry so the merge itself carries provenance — the "proper track"
//! a bare `git merge` never gives you.

use std::path::{Path, PathBuf};
use std::process::Command;

use colored::Colorize;

use crate::env_cmd;
use crate::loop_worktree::{self, LoopWorktree};
use crate::merge_driver;
use crate::repo_settings;
use crate::worktree_scripts;
use aura_env::Scope;

#[derive(clap::Subcommand)]
pub enum WorkSubcommands {
    /// Open a fresh isolated worktree for a parallel session.
    New {
        /// A short name for this piece of work (becomes branch `work/<slug>`).
        /// Optional — a memorable name is generated if omitted.
        name: Option<String>,
        /// Branch or commit to start from (default: the current HEAD).
        #[arg(long)]
        from: Option<String>,
        /// Print only the new worktree path, e.g. `cd "$(aura work new x --quiet)"`.
        #[arg(long)]
        quiet: bool,
        /// Skip the project's `[worktree] setup` warm-up command for this one.
        #[arg(long)]
        no_setup: bool,
    },
    /// Open a fresh isolated worktree AND launch Claude Code inside it in one
    /// step — the "spawn a new agent, it lands in its own workspace" flow.
    Claude {
        /// A short name for this session (becomes branch `work/<slug>`).
        /// Optional — a memorable name is generated if omitted.
        name: Option<String>,
        /// Branch or commit to start from (default: the current HEAD).
        #[arg(long)]
        from: Option<String>,
        /// Skip the project's `[worktree] setup` warm-up before launching.
        #[arg(long)]
        no_setup: bool,
    },
    /// Open a fresh isolated worktree AND run any command inside it (codex, aura,
    /// your editor, a shell). `aura work spawn <name> -- <cmd> [args…]`.
    Spawn {
        /// A short name for this session (becomes branch `work/<slug>`).
        /// Optional — a memorable name is generated if omitted.
        name: Option<String>,
        /// Branch or commit to start from (default: the current HEAD).
        #[arg(long)]
        from: Option<String>,
        /// Skip the project's `[worktree] setup` warm-up before launching.
        #[arg(long)]
        no_setup: bool,
        /// The command to run inside the worktree (everything after `--`).
        #[arg(trailing_var_arg = true, allow_hyphen_values = true)]
        cmd: Vec<String>,
    },
    /// List every active work worktree and how far ahead each one is.
    List {
        #[arg(long)]
        json: bool,
    },
    /// Run the project's `[worktree] run` command inside a work worktree (e.g.
    /// start its dev server), without leaving your current checkout.
    Run {
        /// The work name (its slug, or the full `work/<slug>` branch).
        name: String,
    },
    /// AST-merge a work worktree's branch back into the current branch — gated
    /// by an optional check and recorded in the intent log.
    Merge {
        /// The work name (its slug, or the full `work/<slug>` branch).
        name: String,
        /// A command to run inside the worktree as a gate before merging (e.g. a
        /// build or test). If it fails, the merge is refused and nothing changes.
        #[arg(long)]
        verify: Option<String>,
        /// Keep the worktree + branch after merging (default: remove them).
        #[arg(long)]
        keep: bool,
    },
    /// Tear down a work worktree and delete its branch (without merging).
    Drop {
        /// The work name (its slug, or the full `work/<slug>` branch).
        name: String,
    },
}

pub fn handle(sub: &WorkSubcommands) -> Result<(), Box<dyn std::error::Error>> {
    let repo_root = repo_root()?;
    match sub {
        WorkSubcommands::New { name, from, quiet, no_setup } => {
            cmd_new(&repo_root, name.as_deref(), from.as_deref(), *quiet, *no_setup)
        }
        WorkSubcommands::Claude { name, from, no_setup } => {
            cmd_spawn(&repo_root, name.as_deref(), from.as_deref(), *no_setup, &["claude".to_string()])
        }
        WorkSubcommands::Spawn { name, from, no_setup, cmd } => {
            cmd_spawn(&repo_root, name.as_deref(), from.as_deref(), *no_setup, cmd)
        }
        WorkSubcommands::List { json } => cmd_list(&repo_root, *json),
        WorkSubcommands::Run { name } => cmd_run(&repo_root, name),
        WorkSubcommands::Merge { name, verify, keep } => {
            cmd_merge(&repo_root, name, verify.as_deref(), *keep)
        }
        WorkSubcommands::Drop { name } => cmd_drop(&repo_root, name),
    }
}

// ─── new / spawn ─────────────────────────────────────────────────────────────

/// PURE: pick the git start-point for a new worktree. An explicit caller
/// `--from` always wins; otherwise fall back to the project's `[git] base` when
/// it's set and non-empty; with neither, `None` so git uses HEAD (today's bare
/// behaviour). Kept separate from the git shell-out so the precedence is
/// unit-testable.
fn resolve_start_point(from: Option<&str>, base: Option<&str>) -> Option<String> {
    match from {
        Some(b) => Some(b.to_string()),
        None => base
            .map(str::trim)
            .filter(|b| !b.is_empty())
            .map(str::to_string),
    }
}

/// Create the worktree for `name`: returns `(slug, path, branch)`. Errors if
/// the target path already exists or git refuses. Shared by `new` and `spawn`.
fn create_worktree(
    repo_root: &Path,
    name: Option<&str>,
    from: Option<&str>,
) -> Result<(String, PathBuf, String), Box<dyn std::error::Error>> {
    let slug = match name {
        Some(n) => slugify(n),
        None => random_place_name(repo_root),
    };
    let (path, branch) = paths_for(repo_root, &slug);
    if path.exists() {
        return Err(format!(
            "a work worktree already exists at {} — pick another name, or `aura work drop {}` first",
            path.display(),
            slug
        )
        .into());
    }

    // The project's per-repo settings: drives the default start-point
    // (`[git] base`) and the files copied into the fresh worktree (`[copy]`).
    let settings = repo_settings::load(repo_root);

    // Start-point precedence: an explicit caller `--from` always wins; otherwise
    // fall back to the project's `[git] base` (e.g. "main") so a worktree opened
    // off a feature branch still branches from the trunk. With neither set, git
    // uses HEAD (today's behaviour).
    let start_point: Option<String> = resolve_start_point(from, settings.base.as_deref());

    // git -C <repo> worktree add -b work/<slug> <path> [<start_point>]
    let repo_str = repo_root.to_string_lossy().into_owned();
    let path_str = path.to_string_lossy().into_owned();
    let mut args: Vec<String> = vec![
        "-C".into(),
        repo_str,
        "worktree".into(),
        "add".into(),
        "-b".into(),
        branch.clone(),
        path_str,
    ];
    if let Some(b) = &start_point {
        args.push(b.clone());
    }
    let out = Command::new("git").args(&args).output()?;
    if !out.status.success() {
        return Err(String::from_utf8_lossy(&out.stderr).trim().to_string().into());
    }

    // Seed the worktree with the project's `[copy] files` (e.g. `.env`,
    // `.env.local`). Best-effort: a missing/failed copy never aborts creation —
    // this is purely the "warmed copy can actually run" convenience.
    let _ = repo_settings::copy_files_into(repo_root, &path, &settings);

    Ok((slug, path, branch))
}

/// Bring a fresh worktree to the environment the project declares, with the work
/// env exported, printing progress. No-op when `no_setup` or nothing is declared.
///
/// This used to run `[worktree] setup` and nothing else, which warmed the
/// project's own dependencies and silently assumed everything underneath them —
/// the toolchain, the tools the setup script shells out to, the database the
/// tests talk to. It now runs the whole declared spec, so what a person gets
/// here is what a box gets: same plan, same order, same judgement, one
/// implementation. A project that declares only `setup` gets a plan of exactly
/// one step, which is the behaviour it already had.
fn run_setup(repo_root: &Path, path: &Path, slug: &str, branch: &str, no_setup: bool) {
    if no_setup || worktree_scripts::spec(repo_root).is_empty() {
        return;
    }
    let env_owned = work_env(slug, branch);
    let env: Vec<(&str, &str)> = env_owned.iter().map(|(k, v)| (k.as_str(), v.as_str())).collect();
    println!();
    println!("  {}", "warming up".dimmed());
    match worktree_scripts::bring_to_spec(repo_root, path, Scope::Full, false, &env, false) {
        Ok(report) => {
            env_cmd::print_report(&report);
            if !report.at_spec {
                println!(
                    "  {} the worktree is still here; fix it there",
                    "⚠".yellow()
                );
            }
        }
        // A refused seal is the one failure worth stopping to read: the spec on
        // disk is not the spec anybody reviewed.
        Err(e) => println!("  {} {}", "⚠".yellow(), e.yellow()),
    }
}

/// Take a worktree's world down: the declared services first, in reverse of the
/// order that brought them up, then the project's own `[worktree] archive`.
///
/// Best-effort throughout — a teardown that stopped at the first failure would
/// leave the rest of the world running, which is the opposite of what was asked.
fn cleanup(repo_root: &Path, path: &Path, slug: &str, branch: &str) {
    if worktree_scripts::spec(repo_root).is_empty() {
        return;
    }
    let env_owned = work_env(slug, branch);
    let env: Vec<(&str, &str)> = env_owned.iter().map(|(k, v)| (k.as_str(), v.as_str())).collect();
    match worktree_scripts::teardown(repo_root, path, false, &env) {
        Ok(0) => {}
        Ok(stopped) => println!("  {} {} command(s)", "cleanup".dimmed(), stopped),
        // Dropping a worktree is not the moment to fail on a settings file, but
        // it is very much the moment to say that nothing was taken down.
        Err(e) => println!("  {} nothing taken down — {}", "⚠".yellow(), e.yellow()),
    }
}

fn cmd_new(
    repo_root: &Path,
    name: Option<&str>,
    from: Option<&str>,
    quiet: bool,
    no_setup: bool,
) -> Result<(), Box<dyn std::error::Error>> {
    // Quiet mode stays pure (path only, for `cd "$(…)"`) — no setup, no chatter.
    if quiet {
        let (_slug, path, _branch) = create_worktree(repo_root, name, from)?;
        println!("{}", path.display());
        return Ok(());
    }

    let (slug, path, branch) = create_worktree(repo_root, name, from)?;
    println!("{} {}", "✓ opened".green().bold(), slug.bold());
    println!("  {}  {}", "branch".dimmed(), branch.cyan());
    println!("  {}    {}", "path".dimmed(), path.display().to_string().cyan());
    run_setup(repo_root, &path, &slug, &branch, no_setup);
    println!();
    println!(
        "  {}",
        "Run a session there — your current work stays exactly as it is:".dimmed()
    );
    println!("    {}", format!("cd {}", quote(&path)).bold());
    println!("    {}", "claude        # or: aura, codex, your editor".bold());
    println!();
    println!(
        "  {}",
        format!("Tip: next time `aura work claude {slug}` opens + launches in one step.").dimmed()
    );
    println!();
    println!("  {}", "When it's done, bring it back with a tracked merge:".dimmed());
    println!("    {}", format!("aura work merge {slug}").bold());
    Ok(())
}

/// Create a worktree and immediately run a command inside it — the "spawn a new
/// agent, it lands in its own isolated workspace" flow (e.g. `aura work claude
/// fix-login`). The worktree is LEFT in place after the session ends so you can
/// review and merge it deliberately — same as Conductor leaving the workspace
/// open for review.
fn cmd_spawn(
    repo_root: &Path,
    name: Option<&str>,
    from: Option<&str>,
    no_setup: bool,
    cmd: &[String],
) -> Result<(), Box<dyn std::error::Error>> {
    if cmd.is_empty() {
        return Err(
            "nothing to run — usage: aura work spawn <name> -- <command> [args…]".into(),
        );
    }
    let (slug, path, branch) = create_worktree(repo_root, name, from)?;
    println!("{} {}", "✓ opened".green().bold(), slug.bold());
    println!("  {}  {}", "branch".dimmed(), branch.cyan());
    println!("  {}    {}", "path".dimmed(), path.display().to_string().cyan());
    run_setup(repo_root, &path, &slug, &branch, no_setup);
    println!();
    println!("  {} {}", "▶ launching".green().bold(), cmd.join(" ").bold());
    println!(
        "  {}",
        format!("(isolated on {branch} — your checkout is untouched)").dimmed()
    );
    println!();

    // Exec the command inside the worktree, inheriting the terminal so an
    // interactive TUI (claude/codex) owns it fully. The work env is exported so
    // the session and any run-scripts it invokes see AURA_WORK_PORT/NAME/BRANCH.
    let env_owned = work_env(&slug, &branch);
    let status = Command::new(&cmd[0])
        .args(&cmd[1..])
        .current_dir(&path)
        .envs(env_owned.iter().map(|(k, v)| (k.clone(), v.clone())))
        .status();
    if let Err(e) = status {
        return Err(format!(
            "couldn't launch `{}` in the worktree: {} (the worktree is still here at {})",
            cmd[0],
            e,
            path.display()
        )
        .into());
    }

    // Session ended — leave the worktree with its commits for review + merge.
    println!();
    println!(
        "{}  {}",
        "session ended".dimmed(),
        format!("worktree {branch} kept").dimmed()
    );
    println!("  {} {}", "bring it back:".dimmed(), format!("aura work merge {slug}").bold());
    println!("  {} {}", "or discard:".dimmed(), format!("aura work drop {slug}").bold());
    Ok(())
}

// ─── list ─────────────────────────────────────────────────────────────────--

fn cmd_list(repo_root: &Path, json: bool) -> Result<(), Box<dyn std::error::Error>> {
    let entries = list_work_trees(repo_root)?;
    if json {
        println!("{}", serde_json::to_string(&entries)?);
        return Ok(());
    }
    if entries.is_empty() {
        println!(
            "{}",
            "No active work worktrees. Start one with `aura work new <name>`.".dimmed()
        );
        return Ok(());
    }
    println!("{} ({})", "WORK".green().bold(), entries.len());
    for e in &entries {
        let state = if e.ahead > 0 {
            format!("{} ahead", e.ahead).yellow().to_string()
        } else {
            "in sync".dimmed().to_string()
        };
        println!("  {}  {}  {}", e.branch.cyan(), state, e.path.dimmed());
    }
    Ok(())
}

// ─── run ──────────────────────────────────────────────────────────────────--

fn cmd_run(repo_root: &Path, name: &str) -> Result<(), Box<dyn std::error::Error>> {
    let slug = normalize_name(name);
    let (path, branch) = paths_for(repo_root, &slug);
    if !path.exists() {
        return Err(format!(
            "no work worktree named '{}' (looked for {}). Run `aura work list` to see them.",
            slug,
            path.display()
        )
        .into());
    }
    let run_cmd = match worktree_scripts::load(repo_root).run {
        Some(c) => c,
        None => {
            return Err(
                "no `[worktree] run` command is set in .aura/settings.toml — add one, e.g.\n\n  [worktree]\n  run = \"npm run dev\""
                    .into(),
            )
        }
    };
    println!("{} {} {}", "▶ run".green().bold(), branch.cyan(), run_cmd.dimmed());
    let env_owned = work_env(&slug, &branch);
    println!(
        "  {}",
        format!("AURA_WORK_PORT={} (use it so parallel sessions don't collide)", env_owned[0].1)
            .dimmed()
    );
    let env: Vec<(&str, &str)> = env_owned.iter().map(|(k, v)| (k.as_str(), v.as_str())).collect();
    // Foreground, inheriting stdio — this is the dev server / long-running task,
    // so the command owns the terminal until the user stops it (Ctrl-C).
    let ok = run_in(&path, &run_cmd, &env)?;
    if ok {
        Ok(())
    } else {
        Err(format!("`{run_cmd}` exited non-zero in {}", path.display()).into())
    }
}

// ─── merge ────────────────────────────────────────────────────────────────--

fn cmd_merge(
    repo_root: &Path,
    name: &str,
    verify: Option<&str>,
    keep: bool,
) -> Result<(), Box<dyn std::error::Error>> {
    let slug = normalize_name(name);
    let (path, branch) = paths_for(repo_root, &slug);
    if !path.exists() {
        return Err(format!(
            "no work worktree named '{}' (looked for {}). Run `aura work list` to see them.",
            slug,
            path.display()
        )
        .into());
    }

    // 1. What's coming back — commits + files between HEAD and the work branch.
    let commits = count_ahead(repo_root, &branch);
    if commits == 0 {
        println!(
            "{}",
            format!("'{slug}' has no new commits over the current branch — nothing to merge.")
                .dimmed()
        );
        return Ok(());
    }
    let head_sha = rev_parse(&path, "HEAD").unwrap_or_default();
    let files = changed_files(repo_root, &branch);
    println!(
        "{} {} {}",
        "Merging".bold(),
        branch.cyan(),
        format!(
            "({commits} commit{}, {files} file{})",
            plural(commits),
            plural(files)
        )
        .dimmed()
    );

    // 2. Gate: optional verify command, run INSIDE the worktree so it checks the
    //    work in isolation before any of it touches your branch.
    if let Some(cmd) = verify {
        println!("  {} {}", "check".dimmed(), cmd);
        let env_owned = work_env(&slug, &branch);
        let env: Vec<(&str, &str)> = env_owned.iter().map(|(k, v)| (k.as_str(), v.as_str())).collect();
        if !run_in(&path, cmd, &env)? {
            return Err(format!(
                "check failed — leaving '{slug}' un-merged so you can fix it (worktree at {})",
                path.display()
            )
            .into());
        }
        println!("  {}", "check passed".green());
    }

    // 3. Ensure the AST merge driver is configured so this is a semantic 3-way
    //    merge (rename-aware, block-aware), not git's blunt line merge.
    if let Err(e) = merge_driver::ensure_installed(repo_root) {
        println!(
            "  {} semantic merge unavailable ({}); falling back to git's line merge",
            "·".dimmed(),
            first_line(&e).dimmed()
        );
    }

    // 4. AST merge-back (reuses the crew's worktree merge path).
    let wt = LoopWorktree { path: path.clone(), branch: branch.clone() };
    if let Err(e) = loop_worktree::merge_back(repo_root, &wt) {
        return Err(format!(
            "merge hit a conflict the AST driver couldn't resolve on its own:\n{}\n\nResolve it in {}, commit, then re-run `aura work merge {slug}`.",
            e.trim(),
            repo_root.display()
        )
        .into());
    }

    // 5. Record the merge in the intent log — the "proper track" a bare
    //    `git merge` never leaves behind.
    let summary = format!(
        "Merged work/{slug} back into the current branch via AST merge ({commits} commit(s), {files} file(s); tip {}).",
        short(&head_sha)
    );
    record_intent(repo_root, &summary, &slug);

    println!("{} {}", "✓ merged".green().bold(), branch.cyan());
    println!("  {}", "recorded in the intent log with full provenance".dimmed());

    // 6. Clean up unless asked to keep the worktree around.
    if keep {
        println!("  {} {}", "kept worktree".dimmed(), path.display());
    } else {
        // Take the declared services down, then run the project's own
        // `[worktree] archive` (stop a dev server, drop containers, prune
        // scratch). Best-effort — a failed cleanup never blocks the teardown,
        // and a service left running is exactly what leaks a port onto the next
        // worktree that wants it.
        cleanup(repo_root, &path, &slug, &branch);
        match loop_worktree::discard(repo_root, &wt) {
            Ok(()) => println!("  {}", "worktree cleaned up".dimmed()),
            Err(e) => println!("  {} couldn't remove worktree: {}", "·".dimmed(), first_line(&e)),
        }
    }
    Ok(())
}

// ─── drop ─────────────────────────────────────────────────────────────────--

fn cmd_drop(repo_root: &Path, name: &str) -> Result<(), Box<dyn std::error::Error>> {
    let slug = normalize_name(name);
    let (path, branch) = paths_for(repo_root, &slug);
    if !path.exists() {
        return Err(format!(
            "no work worktree named '{}' ({} doesn't exist)",
            slug,
            path.display()
        )
        .into());
    }
    let ahead = count_ahead(repo_root, &branch);
    if ahead > 0 {
        println!(
            "{} '{slug}' has {ahead} unmerged commit{} — they'll be discarded.",
            "⚠".yellow(),
            plural(ahead)
        );
    }
    cleanup(repo_root, &path, &slug, &branch);
    let wt = LoopWorktree { path, branch };
    loop_worktree::discard(repo_root, &wt)?;
    println!("{} {}", "✓ dropped".green().bold(), slug);
    Ok(())
}

// ─── shared helpers ─────────────────────────────────────────────────────────

#[derive(serde::Serialize)]
struct WorkTreeInfo {
    name: String,
    slug: String,
    branch: String,
    path: String,
    head: String,
    ahead: usize,
}

/// The repo's top-level working directory, or a clear error if we're not in one.
fn repo_root() -> Result<PathBuf, Box<dyn std::error::Error>> {
    let out = Command::new("git")
        .args(["rev-parse", "--show-toplevel"])
        .output()?;
    if !out.status.success() {
        return Err(
            "not inside a git repository — run `git init` (or `aura init`) first".into(),
        );
    }
    Ok(PathBuf::from(
        String::from_utf8_lossy(&out.stdout).trim().to_string(),
    ))
}

/// `(worktree_path, branch)` for a slug: sibling dir `<repo>-work-<slug>` on
/// branch `work/<slug>`. Mirrors the crew's sibling-dir scheme but with a `work`
/// namespace so human worktrees never collide with `aura-loop-*` ones.
fn paths_for(repo_root: &Path, slug: &str) -> (PathBuf, String) {
    let parent = repo_root
        .parent()
        .map(|p| p.to_path_buf())
        .unwrap_or_else(|| PathBuf::from("/tmp"));
    let repo_name = repo_root
        .file_name()
        .and_then(|n| n.to_str())
        .unwrap_or("repo");
    let path = parent.join(format!("{repo_name}-work-{slug}"));
    let branch = format!("work/{slug}");
    (path, branch)
}

/// Strip a leading `work/` then slugify, so `merge`/`drop` accept either the
/// bare name, the slug, or the full branch.
fn normalize_name(name: &str) -> String {
    slugify(name.strip_prefix("work/").unwrap_or(name))
}

/// Lowercase, `[a-z0-9-]`-only, collapsed/ trimmed dashes, ≤40 chars, never
/// empty. Filesystem- and git-ref-safe.
fn slugify(raw: &str) -> String {
    let mut slug = String::with_capacity(raw.len());
    let mut last_dash = false;
    for ch in raw.chars().flat_map(|c| c.to_lowercase()) {
        if ch.is_ascii_alphanumeric() {
            slug.push(ch);
            last_dash = false;
        } else if !last_dash {
            slug.push('-');
            last_dash = true;
        }
    }
    if slug.len() > 40 {
        slug.truncate(40);
    }
    let trimmed = slug.trim_matches('-');
    if trimmed.is_empty() {
        "work".to_string()
    } else {
        trimmed.to_string()
    }
}

/// Memorable place names used to auto-name an un-named worktree (Conductor-style:
/// you get `work/houston`, not `work/work-1`). All lowercase and hyphen-safe so
/// they survive `slugify` unchanged and make valid branch refs + sibling dirs.
const PLACES: &[&str] = &[
    "houston", "auckland", "lagos", "machu-picchu", "kyoto", "oslo", "cairo",
    "lima", "dakar", "hanoi", "porto", "tbilisi", "nairobi", "bergen", "quito",
    "reykjavik", "marrakesh", "valparaiso", "ljubljana", "kigali", "santiago",
    "helsinki", "montevideo", "windhoek", "antwerp", "busan", "medellin",
    "casablanca", "tallinn", "nagoya", "sapporo", "gothenburg", "vilnius",
    "asuncion", "brisbane", "rotterdam", "salzburg", "tromso", "ushuaia",
    "zanzibar", "wellington", "bratislava", "ponce", "luanda",
];

/// Pick a memorable place name for an un-named worktree whose sibling path is
/// still free. Re-rolls on collision; after a cap it falls back to appending a
/// short numeric suffix so it always returns a usable, slugified name.
fn random_place_name(repo_root: &Path) -> String {
    use rand::seq::SliceRandom;
    let mut rng = rand::thread_rng();
    for _ in 0..32 {
        if let Some(pick) = PLACES.choose(&mut rng) {
            let slug = slugify(pick);
            if !paths_for(repo_root, &slug).0.exists() {
                return slug;
            }
        }
    }
    // Every pick collided (a lot of worktrees) — append a short suffix derived
    // from the clock and keep bumping until the sibling path is free.
    let base = slugify(PLACES.choose(&mut rng).copied().unwrap_or("work"));
    let mut n = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs() % 1000)
        .unwrap_or(0);
    loop {
        let slug = slugify(&format!("{base}-{n}"));
        if !paths_for(repo_root, &slug).0.exists() {
            return slug;
        }
        n += 1;
    }
}

/// Parse `git worktree list --porcelain`, keeping only branches under `work/`.
fn list_work_trees(repo_root: &Path) -> Result<Vec<WorkTreeInfo>, Box<dyn std::error::Error>> {
    let repo_str = repo_root.to_string_lossy().into_owned();
    let out = Command::new("git")
        .args(["-C", &repo_str, "worktree", "list", "--porcelain"])
        .output()?;
    if !out.status.success() {
        return Err(String::from_utf8_lossy(&out.stderr).trim().to_string().into());
    }
    let text = String::from_utf8_lossy(&out.stdout);
    let mut result = Vec::new();
    let mut cur_path: Option<String> = None;
    let mut cur_head: Option<String> = None;
    for line in text.lines() {
        if let Some(p) = line.strip_prefix("worktree ") {
            cur_path = Some(p.to_string());
            cur_head = None;
        } else if let Some(h) = line.strip_prefix("HEAD ") {
            cur_head = Some(h.to_string());
        } else if let Some(b) = line.strip_prefix("branch ") {
            if let Some(slug) = b.strip_prefix("refs/heads/work/") {
                let branch = format!("work/{slug}");
                let ahead = count_ahead(repo_root, &branch);
                result.push(WorkTreeInfo {
                    name: slug.to_string(),
                    slug: slug.to_string(),
                    branch,
                    path: cur_path.clone().unwrap_or_default(),
                    head: cur_head.clone().unwrap_or_default(),
                    ahead,
                });
            }
        }
    }
    Ok(result)
}

/// Commits on `branch` that the current HEAD doesn't have (`HEAD..branch`).
fn count_ahead(repo_root: &Path, branch: &str) -> usize {
    let repo_str = repo_root.to_string_lossy().into_owned();
    let spec = format!("HEAD..{branch}");
    Command::new("git")
        .args(["-C", &repo_str, "rev-list", "--count", &spec])
        .output()
        .ok()
        .filter(|o| o.status.success())
        .and_then(|o| String::from_utf8_lossy(&o.stdout).trim().parse::<usize>().ok())
        .unwrap_or(0)
}

/// Count of files that differ between the current HEAD and `branch`.
fn changed_files(repo_root: &Path, branch: &str) -> usize {
    let repo_str = repo_root.to_string_lossy().into_owned();
    let spec = format!("HEAD..{branch}");
    Command::new("git")
        .args(["-C", &repo_str, "diff", "--name-only", &spec])
        .output()
        .ok()
        .filter(|o| o.status.success())
        .map(|o| {
            String::from_utf8_lossy(&o.stdout)
                .lines()
                .filter(|l| !l.trim().is_empty())
                .count()
        })
        .unwrap_or(0)
}

/// `git -C <dir> rev-parse <rev>`, trimmed; `None` on failure.
fn rev_parse(dir: &Path, rev: &str) -> Option<String> {
    let d = dir.to_string_lossy().into_owned();
    Command::new("git")
        .args(["-C", &d, "rev-parse", rev])
        .output()
        .ok()
        .filter(|o| o.status.success())
        .map(|o| String::from_utf8_lossy(&o.stdout).trim().to_string())
}

/// Run a shell command inside `dir`, inheriting stdio, with the work env
/// (AURA_WORK_PORT/NAME/BRANCH) exported; returns whether it passed.
fn run_in(dir: &Path, cmd: &str, env: &[(&str, &str)]) -> Result<bool, Box<dyn std::error::Error>> {
    let mut c = Command::new("sh");
    c.arg("-c").arg(cmd).current_dir(dir);
    for (k, v) in env {
        c.env(k, v);
    }
    let status = c.status()?;
    Ok(status.success())
}

/// Deterministic per-worktree port in `[3000, 3999]` so parallel sessions' dev
/// servers don't collide — the role Conductor's `CONDUCTOR_PORT` plays. Stable
/// across runs for the same slug (pure FNV-1a hash, no rng, no clock).
fn port_for(slug: &str) -> u16 {
    let mut hash: u64 = 0xcbf2_9ce4_8422_2325;
    for b in slug.as_bytes() {
        hash ^= *b as u64;
        hash = hash.wrapping_mul(0x0000_0100_0000_01b3);
    }
    3000 + (hash % 1000) as u16
}

/// The environment exported into every lifecycle script and spawned session for
/// a worktree, so dev servers and tools can run side-by-side without collision.
fn work_env(slug: &str, branch: &str) -> Vec<(String, String)> {
    vec![
        ("AURA_WORK_PORT".to_string(), port_for(slug).to_string()),
        ("AURA_WORK_NAME".to_string(), slug.to_string()),
        ("AURA_WORK_BRANCH".to_string(), branch.to_string()),
    ]
}

/// Append a provenance row to `.aura/intent_log.jsonl` recording the merge, and
/// drop the `.intent_logged` marker so a worktree pre-commit hook is satisfied.
fn record_intent(repo_root: &Path, intent: &str, slug: &str) {
    use std::io::Write;
    let aura = repo_root.join(".aura");
    if std::fs::create_dir_all(&aura).is_err() {
        return;
    }
    let ts = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0);
    let entry = serde_json::json!({
        "agent_id": "aura-work",
        "intent": intent,
        "intent_type": "Merge",
        "timestamp": ts,
        "source": "aura work merge",
        "task_id": format!("work/{slug}"),
    });
    if let Ok(mut f) = std::fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(aura.join("intent_log.jsonl"))
    {
        let _ = writeln!(f, "{entry}");
    }
    let _ = std::fs::write(aura.join(".intent_logged"), "1");
}

/// Double-quote a path for a copy-pasteable shell line (repo paths can contain
/// spaces, e.g. "New Git").
fn quote(p: &Path) -> String {
    format!("\"{}\"", p.display())
}

fn short(sha: &str) -> String {
    sha.chars().take(7).collect()
}

fn plural(n: usize) -> &'static str {
    if n == 1 {
        ""
    } else {
        "s"
    }
}

fn first_line(s: &str) -> String {
    s.lines().next().unwrap_or("").trim().to_string()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn slugify_basics() {
        assert_eq!(slugify("Fix the login bug!"), "fix-the-login-bug");
        assert_eq!(slugify("AURA-203"), "aura-203");
        assert_eq!(slugify("  --weird__name-- "), "weird-name");
    }

    #[test]
    fn slugify_never_empty() {
        assert_eq!(slugify(""), "work");
        assert_eq!(slugify("★★★"), "work");
    }

    #[test]
    fn slugify_truncates_to_40() {
        let s = slugify(&"a".repeat(80));
        assert!(s.len() <= 40);
    }

    #[test]
    fn normalize_name_strips_branch_prefix() {
        assert_eq!(normalize_name("work/my-thing"), "my-thing");
        assert_eq!(normalize_name("my-thing"), "my-thing");
        assert_eq!(normalize_name("My Thing"), "my-thing");
    }

    #[test]
    fn resolve_start_point_precedence() {
        // Explicit --from always wins, even when a base is set.
        assert_eq!(
            resolve_start_point(Some("feature-x"), Some("main")).as_deref(),
            Some("feature-x")
        );
        // No --from → fall back to [git] base.
        assert_eq!(resolve_start_point(None, Some("main")).as_deref(), Some("main"));
        // Neither set → None (git uses HEAD).
        assert_eq!(resolve_start_point(None, None), None);
        // A blank/whitespace base is treated as unset (don't pass `git worktree
        // add` an empty start-point).
        assert_eq!(resolve_start_point(None, Some("   ")).as_deref(), None);
        assert_eq!(resolve_start_point(None, Some("")), None);
        // An explicit --from is never trimmed away by the base-only guard.
        assert_eq!(resolve_start_point(Some("dev"), None).as_deref(), Some("dev"));
    }

    #[test]
    fn paths_for_work_namespace() {
        let (path, branch) = paths_for(Path::new("/home/dev/myrepo"), "login-fix");
        assert_eq!(path, PathBuf::from("/home/dev/myrepo-work-login-fix"));
        assert_eq!(branch, "work/login-fix");
    }

    #[test]
    fn plural_and_short() {
        assert_eq!(plural(1), "");
        assert_eq!(plural(0), "s");
        assert_eq!(plural(2), "s");
        assert_eq!(short("abcdef1234567890"), "abcdef1");
    }

    #[test]
    fn port_for_is_deterministic_and_in_range() {
        let p = port_for("login-fix");
        assert_eq!(p, port_for("login-fix"), "same slug → same port");
        assert!((3000..4000).contains(&p), "port {p} out of [3000,4000)");
        // Different slugs generally differ (not a hard guarantee, but these do).
        assert_ne!(port_for("alpha"), port_for("beta"));
    }

    #[test]
    fn work_env_carries_port_name_branch() {
        let env = work_env("login-fix", "work/login-fix");
        assert_eq!(env[0].0, "AURA_WORK_PORT");
        assert_eq!(env[1], ("AURA_WORK_NAME".to_string(), "login-fix".to_string()));
        assert_eq!(env[2], ("AURA_WORK_BRANCH".to_string(), "work/login-fix".to_string()));
    }

    #[test]
    fn random_place_name_is_nonempty_and_slugified() {
        // A directory that exists but contains no `<repo>-work-*` siblings, so no
        // place name can collide → the pick comes straight from PLACES.
        let repo_root = Path::new("/this/path/should/not/exist/myrepo");
        let name = random_place_name(repo_root);
        assert!(!name.is_empty(), "generated name was empty");
        assert!(
            name.chars().all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '-'),
            "generated name '{name}' is not slugified ([a-z0-9-])"
        );
    }

    #[test]
    fn random_place_name_picks_a_known_place() {
        // With no collisions possible, the result must be a slugified PLACES entry.
        let repo_root = Path::new("/this/path/should/not/exist/myrepo");
        let known: Vec<String> = PLACES.iter().map(|p| slugify(p)).collect();
        for _ in 0..20 {
            let name = random_place_name(repo_root);
            assert!(known.contains(&name), "'{name}' is not a member of PLACES");
        }
    }

    #[test]
    fn places_are_all_slug_stable() {
        // Every place name must survive slugify unchanged (precondition for the
        // membership test and for producing clean branch refs).
        assert!(!PLACES.is_empty());
        for p in PLACES {
            assert_eq!(&slugify(p), p, "place '{p}' is not slug-stable");
        }
    }
}
