use std::collections::HashMap;
use std::fs;
use std::path::{Path, PathBuf};

use directories::ProjectDirs;

use crate::error::{Result, TermError};

const QUALIFIER: &str = "dev";
const ORG: &str = "aura";
const APP: &str = "aura-proto";

pub fn project_dirs() -> Result<ProjectDirs> {
    ProjectDirs::from(QUALIFIER, ORG, APP)
        .ok_or_else(|| TermError::Config("no home directory on this platform".into()))
}

pub fn data_dir() -> Result<PathBuf> {
    let dirs = project_dirs()?;
    let path = dirs.data_dir().to_path_buf();
    fs::create_dir_all(&path)?;
    Ok(path)
}

pub fn db_path() -> Result<PathBuf> {
    Ok(data_dir()?.join("blocks.db"))
}

pub fn projects_file() -> Result<PathBuf> {
    Ok(data_dir()?.join("projects.json"))
}

/// Load the persisted project list. Returns an empty vec on any error — the
/// caller seeds a default when the list is empty so first launch Just Works.
pub fn load_projects() -> Vec<PathBuf> {
    let Ok(path) = projects_file() else {
        return Vec::new();
    };
    let Ok(bytes) = fs::read(&path) else {
        return Vec::new();
    };
    let v: Vec<String> = serde_json::from_slice(&bytes).unwrap_or_default();
    v.into_iter()
        .map(PathBuf::from)
        .filter(|p| p.is_dir())
        .collect()
}

pub fn save_projects(paths: &[PathBuf]) -> Result<()> {
    let path = projects_file()?;
    let strings: Vec<String> = paths
        .iter()
        .map(|p| p.to_string_lossy().into_owned())
        .collect();
    let bytes = serde_json::to_vec_pretty(&strings)
        .map_err(|e| TermError::Config(format!("serialize projects: {e}")))?;
    fs::write(&path, bytes).map_err(TermError::Io)?;
    Ok(())
}

/// Interactive login shell args so `.zprofile`/`.bash_profile` populate PATH.
pub fn login_shell_args(shell: &str) -> Vec<&'static str> {
    let name = Path::new(shell)
        .file_name()
        .and_then(|s| s.to_str())
        .unwrap_or("");
    match name {
        "zsh" | "bash" | "fish" | "sh" => vec!["-l", "-i"],
        _ => vec![],
    }
}

pub fn hostname() -> String {
    std::env::var("HOST")
        .or_else(|_| std::env::var("HOSTNAME"))
        .unwrap_or_else(|_| "localhost".into())
}

/// Short user-facing label for a path: if it sits under `$HOME`, show
/// `~/rel/path`; otherwise the basename (or the full path if there is no
/// basename, e.g. `/`). Used in the topbar pill.
pub fn cwd_label(path: &Path) -> String {
    if let Some(home) = std::env::var_os("HOME").map(PathBuf::from) {
        if let Ok(rel) = path.strip_prefix(&home) {
            let rel = rel.to_string_lossy();
            if rel.is_empty() {
                return "~".to_string();
            }
            return format!("~/{rel}");
        }
    }
    path.file_name()
        .map(|s| s.to_string_lossy().into_owned())
        .unwrap_or_else(|| path.to_string_lossy().into_owned())
}

/// Metadata for one git worktree — path, branch, short HEAD.
#[derive(Debug, Clone)]
pub struct WorktreeInfo {
    pub path: PathBuf,
    pub branch: Option<String>,
    pub head: Option<String>,
    pub is_current: bool,
}

impl WorktreeInfo {
    pub fn label(&self) -> String {
        self.branch.clone().unwrap_or_else(|| {
            self.path
                .file_name()
                .map(|n| n.to_string_lossy().into_owned())
                .unwrap_or_else(|| self.path.to_string_lossy().into_owned())
        })
    }
}

/// Resolve the main worktree for a repository regardless of which worktree
/// we're standing in. Returns `None` outside a git repo.
pub fn git_main_worktree(cwd: &Path) -> Option<PathBuf> {
    let out = std::process::Command::new("git")
        .args(["rev-parse", "--path-format=absolute", "--git-common-dir"])
        .current_dir(cwd)
        .output()
        .ok()?;
    if !out.status.success() {
        return None;
    }
    let common_dir = String::from_utf8_lossy(&out.stdout).trim().to_string();
    if common_dir.is_empty() {
        return None;
    }
    PathBuf::from(common_dir).parent().map(|p| p.to_path_buf())
}

/// Enumerate every worktree of the repo containing `cwd`. The current
/// worktree (whichever path contains `cwd`) is marked `is_current`.
pub fn git_worktrees(cwd: &Path) -> Vec<WorktreeInfo> {
    let Ok(out) = std::process::Command::new("git")
        .args(["worktree", "list", "--porcelain"])
        .current_dir(cwd)
        .output()
    else {
        return Vec::new();
    };
    if !out.status.success() {
        return Vec::new();
    }
    let text = String::from_utf8_lossy(&out.stdout).into_owned();
    let mut entries: Vec<WorktreeInfo> = Vec::new();
    let mut cur: Option<WorktreeInfo> = None;
    for line in text.lines() {
        if line.is_empty() {
            if let Some(entry) = cur.take() {
                entries.push(entry);
            }
            continue;
        }
        if let Some(rest) = line.strip_prefix("worktree ") {
            cur = Some(WorktreeInfo {
                path: PathBuf::from(rest),
                branch: None,
                head: None,
                is_current: false,
            });
        } else if let Some(rest) = line.strip_prefix("HEAD ") {
            if let Some(e) = cur.as_mut() {
                e.head = Some(rest.chars().take(7).collect());
            }
        } else if let Some(rest) = line.strip_prefix("branch ") {
            if let Some(e) = cur.as_mut() {
                e.branch = Some(rest.trim_start_matches("refs/heads/").to_string());
            }
        } else if line == "detached" {
            // already None branch
        }
    }
    if let Some(entry) = cur.take() {
        entries.push(entry);
    }
    for e in entries.iter_mut() {
        e.is_current = cwd.starts_with(&e.path);
    }
    entries
}

/// True when the working tree at `cwd` has uncommitted changes. Cheap
/// porcelain invocation — no diff text, just a boolean. Returns false on
/// any error (keeps the UI quiet when git isn't around).
pub fn git_is_dirty(cwd: &Path) -> bool {
    let Ok(out) = std::process::Command::new("git")
        .args(["status", "--porcelain"])
        .current_dir(cwd)
        .output()
    else {
        return false;
    };
    if !out.status.success() {
        return false;
    }
    !out.stdout.is_empty()
}

/// Create a new worktree for `branch_name` at `<repo>/.aura/worktrees/<slug>`.
/// If the branch already exists, attach to it; otherwise create it from HEAD.
/// Returns the absolute path of the new worktree on success.
pub fn git_worktree_add(repo_root: &Path, branch_name: &str) -> Result<PathBuf> {
    let slug: String = branch_name
        .chars()
        .map(|c| if c.is_ascii_alphanumeric() || c == '-' || c == '_' { c } else { '-' })
        .collect();
    let target = repo_root.join(".aura").join("worktrees").join(&slug);
    if let Some(parent) = target.parent() {
        fs::create_dir_all(parent).map_err(TermError::Io)?;
    }

    let branch_exists = std::process::Command::new("git")
        .args(["rev-parse", "--verify", "--quiet"])
        .arg(format!("refs/heads/{branch_name}"))
        .current_dir(repo_root)
        .status()
        .map(|s| s.success())
        .unwrap_or(false);

    let out = if branch_exists {
        std::process::Command::new("git")
            .args(["worktree", "add"])
            .arg(&target)
            .arg(branch_name)
            .current_dir(repo_root)
            .output()
    } else {
        std::process::Command::new("git")
            .args(["worktree", "add", "-b", branch_name])
            .arg(&target)
            .current_dir(repo_root)
            .output()
    }
    .map_err(TermError::Io)?;

    if !out.status.success() {
        let msg = String::from_utf8_lossy(&out.stderr).into_owned();
        return Err(TermError::Config(format!(
            "git worktree add failed: {}",
            msg.trim()
        )));
    }
    Ok(target)
}

/// Current git branch for a working directory, or `None` if the directory is
/// not a repo or `git` is unavailable. Fast path — single `git rev-parse`.
pub fn git_branch(cwd: &Path) -> Option<String> {
    let out = std::process::Command::new("git")
        .args(["rev-parse", "--abbrev-ref", "HEAD"])
        .current_dir(cwd)
        .output()
        .ok()?;
    if !out.status.success() {
        return None;
    }
    let s = String::from_utf8_lossy(&out.stdout).trim().to_string();
    if s.is_empty() || s == "HEAD" {
        None
    } else {
        Some(s)
    }
}

/// Cheap directory listing for the file tree: directories first, then files,
/// both alphabetically case-folded. Skips heavy or irrelevant entries (VCS
/// metadata, vendored deps, build artifacts, OS junk) so the tree shows what
/// the developer actually cares about. Returns an empty vec on any error.
#[derive(Debug, Clone)]
pub struct DirEntryLite {
    pub path: PathBuf,
    pub name: String,
    pub is_dir: bool,
}

pub fn list_dir_sorted(path: &Path) -> Vec<DirEntryLite> {
    let Ok(rd) = fs::read_dir(path) else { return Vec::new(); };
    let mut out: Vec<DirEntryLite> = Vec::new();
    for entry in rd.flatten() {
        let name = entry.file_name().to_string_lossy().into_owned();
        if should_hide_fs_entry(&name) {
            continue;
        }
        let is_dir = entry.file_type().map(|t| t.is_dir()).unwrap_or(false);
        out.push(DirEntryLite {
            path: entry.path(),
            name,
            is_dir,
        });
    }
    out.sort_by(|a, b| match (a.is_dir, b.is_dir) {
        (true, false) => std::cmp::Ordering::Less,
        (false, true) => std::cmp::Ordering::Greater,
        _ => a.name.to_lowercase().cmp(&b.name.to_lowercase()),
    });
    out
}

fn should_hide_fs_entry(name: &str) -> bool {
    matches!(
        name,
        ".git"
            | ".DS_Store"
            | "node_modules"
            | "target"
            | "dist"
            | "build"
            | ".next"
            | ".cache"
            | ".turbo"
            | ".vercel"
            | "__pycache__"
            | ".pytest_cache"
            | ".mypy_cache"
            | ".venv"
            | "venv"
    )
}

/// Snapshot of `git status --porcelain` for the repo at `cwd`, keyed by
/// absolute path → a single status char: `M` (modified/renamed), `A` (added),
/// `?` (untracked), `D` (deleted). Parent directories of any changed file
/// also get an `M` entry so the tree can show a badge without walking the
/// entire subtree. Returns an empty map if `cwd` isn't a repo.
pub fn git_status_map(cwd: &Path) -> HashMap<PathBuf, char> {
    let mut map: HashMap<PathBuf, char> = HashMap::new();
    let Ok(out) = std::process::Command::new("git")
        .args(["status", "--porcelain=v1"])
        .current_dir(cwd)
        .output()
    else {
        return map;
    };
    if !out.status.success() {
        return map;
    }
    let text = String::from_utf8_lossy(&out.stdout);
    // Resolve cwd once so parent-walk comparisons stay stable.
    let root = match cwd.canonicalize() {
        Ok(c) => c,
        Err(_) => cwd.to_path_buf(),
    };
    for line in text.lines() {
        if line.len() < 4 {
            continue;
        }
        let bytes = line.as_bytes();
        let x = bytes[0] as char;
        let y = bytes[1] as char;
        let path_part = &line[3..];
        // Quoted paths (unusual chars) — skip for v1 rather than risk escapes.
        if path_part.starts_with('"') {
            continue;
        }
        // Rename/copy lines look like `old -> new`; only the destination
        // matters for status display.
        let rel = if let Some(idx) = path_part.find(" -> ") {
            &path_part[idx + 4..]
        } else {
            path_part
        };
        let full = root.join(rel);
        let ch = if x == '?' || y == '?' {
            '?'
        } else if x == 'A' || y == 'A' {
            'A'
        } else if x == 'D' || y == 'D' {
            'D'
        } else if x == 'M' || y == 'M' || x == 'R' || y == 'R' {
            'M'
        } else {
            'M'
        };
        map.insert(full.clone(), ch);

        // Mark every ancestor up to root as modified so collapsed dirs can
        // still show the amber dot.
        let mut cursor = full.parent();
        while let Some(par) = cursor {
            if par.strip_prefix(&root).is_err() {
                break;
            }
            map.entry(par.to_path_buf()).or_insert('M');
            if par == root {
                break;
            }
            cursor = par.parent();
        }
    }
    map
}

/// Run `git diff -- <file>` for a working-tree-vs-HEAD diff of a single
/// path. Returns the unified diff as one string (empty when there are no
/// changes, or when `git` isn't on PATH / cwd isn't a repo). Used by the
/// editor's diff toggle to render the active file's pending changes.
pub fn git_file_diff(cwd: &Path, file: &Path) -> String {
    // Compute the path relative to cwd so `git diff` resolves it inside the
    // repo. Falls back to absolute on failure (git accepts both).
    let rel = file.strip_prefix(cwd).unwrap_or(file);
    let Ok(out) = std::process::Command::new("git")
        .args(["diff", "--no-color", "--"])
        .arg(rel)
        .current_dir(cwd)
        .output()
    else {
        return String::new();
    };
    if !out.status.success() {
        return String::new();
    }
    String::from_utf8_lossy(&out.stdout).into_owned()
}

/// Resolve initial cwd. Priority:
///   1. The main worktree of the enclosing repo (via `git rev-parse
///      --git-common-dir`), so launching from a worktree still opens
///      the primary repo root.
///   2. The nearest `.git` ancestor of the current directory.
///   3. `$HOME`, if the current dir is `/` or doesn't exist.
///   4. The raw current directory as last resort.
pub fn resolve_initial_cwd() -> PathBuf {
    let raw = std::env::current_dir().unwrap_or_else(|_| PathBuf::from("/"));
    let home = std::env::var_os("HOME").map(PathBuf::from);
    if raw == PathBuf::from("/") || !raw.is_dir() {
        return home.filter(|h| h.is_dir()).unwrap_or(raw);
    }
    if let Some(main) = git_main_worktree(&raw) {
        if main.is_dir() {
            return main;
        }
    }
    let mut probe = raw.clone();
    loop {
        if probe.join(".git").exists() {
            return probe;
        }
        if !probe.pop() {
            break;
        }
    }
    raw
}
