//! File-system + git tauri commands.
//!
//! W2: thin wrappers around stdlib + git porcelain. Every function returns
//! a serializable struct the React side can consume directly. Path safety
//! is the caller's responsibility today (W2 ships the demo); a follow-up
//! wave will gate every read/write to a registered project root via tauri's
//! capability/scope system so a malicious React payload can't escape.

use std::collections::HashMap;
use std::fs;
use std::path::{Path, PathBuf};

use serde::Serialize;

#[derive(Serialize)]
pub struct DirEntry {
    pub name: String,
    pub path: String,
    pub is_dir: bool,
    /// Git porcelain status char ('M' / 'A' / '?' / 'D'), if any. Lets the
    /// tree render colored badges without a second round-trip.
    pub git_status: Option<String>,
}

#[derive(Serialize)]
pub struct FileContent {
    pub path: String,
    pub text: String,
    pub size: u64,
    /// Best-guess language slug derived from extension. Frontend uses this
    /// to pick the CodeMirror language pack without re-deriving.
    pub language: String,
    /// "ok" | "too_large" | "binary". When set to anything other than
    /// "ok" the `text` field is empty and the React side renders a
    /// placeholder instead of trying to mount the editor.
    pub status: String,
}

/// Hard cap on file size we'll send to the editor. 2 MB matches Superset.
const MAX_FILE_BYTES: u64 = 2_000_000;

/// Names we never want in the file tree regardless of dotfile status —
/// OS metadata, VCS internals, and tooling caches that bloat the tree
/// without ever being something the user edits. Dotfiles NOT in this
/// list (`.env`, `.gitignore`, `.prettierrc`, …) stay visible.
fn is_always_hidden(name: &str) -> bool {
    matches!(
        name,
        ".git"
            | ".DS_Store"
            | ".AppleDouble"
            | ".LSOverride"
            | "Thumbs.db"
            | "desktop.ini"
            | "node_modules"
            | ".next"
            | ".turbo"
            | ".nuxt"
            | ".svelte-kit"
            | ".cache"
            | ".parcel-cache"
            | ".pytest_cache"
            | ".mypy_cache"
            | ".ruff_cache"
            | ".tox"
            | "__pycache__"
            | ".gradle"
            | ".idea"
            | ".vscode-test"
    )
}
/// Number of leading bytes we sniff for binary content (NUL byte heuristic).
const BINARY_SNIFF_BYTES: usize = 8192;

#[tauri::command]
pub async fn list_dir(path: String) -> Result<Vec<DirEntry>, String> {
    crate::blocking::run(move || {
        let p = PathBuf::from(&path);
        if !p.is_dir() {
            return Err(format!("not a directory: {}", path));
        }
        // Resolve git status once for the whole directory so each entry lookup
        // is O(1). For small dirs this is overkill; for repos it's the same
        // cost as a single porcelain shell-out either way.
        let status_map = git_status_map(&p);

        let mut entries: Vec<DirEntry> = fs::read_dir(&p)
            .map_err(|e| e.to_string())?
            .filter_map(|r| r.ok())
            .filter_map(|e| {
                let name = e.file_name().to_string_lossy().into_owned();
                // VSCode-parity: show dotfiles (.env, .gitignore, .prettierrc,
                // etc.) by default. Only the noise — .git internals, OS junk,
                // and heavyweight tooling caches — stays hidden.
                if is_always_hidden(&name) {
                    return None;
                }
                let entry_path = e.path();
                let is_dir = entry_path.is_dir();
                let status = status_map
                    .get(&entry_path)
                    .copied()
                    .map(|c| c.to_string());
                Some(DirEntry {
                    path: entry_path.to_string_lossy().into_owned(),
                    name,
                    is_dir,
                    git_status: status,
                })
            })
            .collect();

        // Directories first, then files; alphabetical inside each group. Same
        // order every editor uses.
        entries.sort_by(|a, b| match (a.is_dir, b.is_dir) {
            (true, false) => std::cmp::Ordering::Less,
            (false, true) => std::cmp::Ordering::Greater,
            _ => a.name.to_lowercase().cmp(&b.name.to_lowercase()),
        });
        Ok(entries)
    })
    .await
}

#[tauri::command]
pub async fn read_file(path: String) -> Result<FileContent, String> {
    let p = PathBuf::from(&path);
    let meta = fs::metadata(&p).map_err(|e| e.to_string())?;
    let lang = language_for(&p);
    let size = meta.len();

    // Refuse to ferry oversize files across IPC; the React side renders a
    // placeholder instead of mounting the editor (which would beachball
    // even with our perf tiers).
    if size > MAX_FILE_BYTES {
        return Ok(FileContent {
            path: p.to_string_lossy().into_owned(),
            text: String::new(),
            size,
            language: lang,
            status: "too_large".into(),
        });
    }

    let bytes = fs::read(&p).map_err(|e| e.to_string())?;

    // Binary sniff — first N bytes; a NUL is a strong signal. Same
    // heuristic git uses for is_binary. Cheaper than full UTF-8 validation
    // and catches the common cases (.png, .jar, sqlite db, etc.).
    let sniff_len = BINARY_SNIFF_BYTES.min(bytes.len());
    if bytes[..sniff_len].contains(&0u8) {
        return Ok(FileContent {
            path: p.to_string_lossy().into_owned(),
            text: String::new(),
            size,
            language: lang,
            status: "binary".into(),
        });
    }

    let text = String::from_utf8_lossy(&bytes).into_owned();
    Ok(FileContent {
        path: p.to_string_lossy().into_owned(),
        text,
        size,
        language: lang,
        status: "ok".into(),
    })
}

/// A file's raw bytes, base64-encoded, with a best-guess media type — the
/// shape the chat composer needs to turn an OS-dropped screenshot into an
/// inline image attachment. (`read_file` returns UTF-8 text, which mangles
/// binary; this is its binary-safe sibling.)
#[derive(Serialize)]
pub struct FileBase64 {
    pub path: String,
    pub name: String,
    /// MIME type guessed from the extension (e.g. `image/png`). Defaults to
    /// `application/octet-stream` for unknown kinds.
    pub media_type: String,
    /// Standard (padded) base64 of the file bytes, no `data:` prefix —
    /// matches what the Anthropic image-block API expects.
    pub data_base64: String,
    pub size: u64,
    pub is_image: bool,
}

/// Cap for base64-over-IPC. 20 MB mirrors the composer's own client-side
/// attachment limit — a dropped screenshot is kilobytes; anything past this
/// is almost certainly a mis-drop we don't want to balloon through IPC.
const MAX_BASE64_BYTES: u64 = 20 * 1024 * 1024;

#[tauri::command]
pub async fn read_file_base64(path: String) -> Result<FileBase64, String> {
    use base64::Engine as _;
    let p = PathBuf::from(&path);
    let meta = fs::metadata(&p).map_err(|e| e.to_string())?;
    if meta.is_dir() {
        return Err("path is a directory".into());
    }
    let size = meta.len();
    if size > MAX_BASE64_BYTES {
        return Err(format!("file too large ({size} bytes)"));
    }
    let bytes = fs::read(&p).map_err(|e| e.to_string())?;
    let media_type = media_type_for(&p);
    let is_image = media_type.starts_with("image/");
    let name = p
        .file_name()
        .and_then(|s| s.to_str())
        .unwrap_or("file")
        .to_string();
    let data_base64 = base64::engine::general_purpose::STANDARD.encode(&bytes);
    Ok(FileBase64 {
        path: p.to_string_lossy().into_owned(),
        name,
        media_type,
        data_base64,
        size,
        is_image,
    })
}

/// Best-guess MIME type from a path's extension — enough to label dropped
/// images so the chat renders + delivers them as image blocks. Falls back to
/// `application/octet-stream` for anything unrecognized.
fn media_type_for(p: &Path) -> String {
    let ext = p
        .extension()
        .and_then(|e| e.to_str())
        .unwrap_or("")
        .to_ascii_lowercase();
    match ext.as_str() {
        "png" => "image/png",
        "jpg" | "jpeg" => "image/jpeg",
        "gif" => "image/gif",
        "webp" => "image/webp",
        "bmp" => "image/bmp",
        "svg" => "image/svg+xml",
        "heic" => "image/heic",
        "pdf" => "application/pdf",
        "txt" | "log" | "md" => "text/plain",
        "json" => "application/json",
        _ => "application/octet-stream",
    }
    .to_string()
}

#[tauri::command]
pub async fn write_file(
    path: String,
    contents: String,
    tracker: tauri::State<'_, crate::agent_mutation_guard::EditorWriteTracker>,
) -> Result<(), String> {
    // Stamp the editor-write tracker BEFORE the actual write so the
    // guard's debounced FS event (which can fire slightly after we
    // return) sees the entry already. Order matters: write-then-stamp
    // would race with notify under high load and the guard might
    // emit a false positive.
    tracker.stamp(PathBuf::from(&path));
    fs::write(PathBuf::from(&path), contents).map_err(|e| e.to_string())
}

/// Create a new empty file at `path`. Errors if the parent doesn't
/// exist or if the path already exists. Used by the FileTree toolbar
/// + context menu's "New File" action.
#[tauri::command]
pub async fn fs_create_file(
    path: String,
    tracker: tauri::State<'_, crate::agent_mutation_guard::EditorWriteTracker>,
) -> Result<String, String> {
    let p = PathBuf::from(&path);
    if p.exists() {
        return Err(format!("path already exists: {path}"));
    }
    if let Some(parent) = p.parent() {
        if !parent.is_dir() {
            return Err(format!("parent does not exist: {}", parent.display()));
        }
    }
    tracker.stamp(p.clone());
    fs::write(&p, "").map_err(|e| e.to_string())?;
    Ok(p.to_string_lossy().into_owned())
}

/// Create a new directory at `path`. Errors if the path already
/// exists. Parent must exist (use `mkdir -p` semantics only on the
/// final component to avoid surprise nested creates).
#[tauri::command]
pub async fn fs_create_folder(path: String) -> Result<String, String> {
    let p = PathBuf::from(&path);
    if p.exists() {
        return Err(format!("path already exists: {path}"));
    }
    if let Some(parent) = p.parent() {
        if !parent.is_dir() {
            return Err(format!("parent does not exist: {}", parent.display()));
        }
    }
    fs::create_dir(&p).map_err(|e| e.to_string())?;
    Ok(p.to_string_lossy().into_owned())
}

/// Rename or move `from` → `to`. Refuses to overwrite an existing
/// path. Atomic when both paths live on the same filesystem (which
/// is the common case for tree-row renames).
#[tauri::command]
pub async fn fs_rename(
    from: String,
    to: String,
    tracker: tauri::State<'_, crate::agent_mutation_guard::EditorWriteTracker>,
) -> Result<String, String> {
    let from_p = PathBuf::from(&from);
    let to_p = PathBuf::from(&to);
    if !from_p.exists() {
        return Err(format!("source does not exist: {from}"));
    }
    if to_p.exists() {
        return Err(format!("destination already exists: {to}"));
    }
    tracker.stamp(from_p.clone());
    tracker.stamp(to_p.clone());
    fs::rename(&from_p, &to_p).map_err(|e| e.to_string())?;
    Ok(to_p.to_string_lossy().into_owned())
}

/// Delete a file or directory. Recursive for directories. Caller
/// (UI) is responsible for confirming with the user — there's no
/// trash bin here, this is a hard delete.
#[tauri::command]
pub async fn fs_delete(
    path: String,
    tracker: tauri::State<'_, crate::agent_mutation_guard::EditorWriteTracker>,
) -> Result<(), String> {
    let p = PathBuf::from(&path);
    if !p.exists() {
        return Err(format!("path does not exist: {path}"));
    }
    tracker.stamp(p.clone());
    if p.is_dir() {
        fs::remove_dir_all(&p).map_err(|e| e.to_string())
    } else {
        fs::remove_file(&p).map_err(|e| e.to_string())
    }
}

/// A gitignored file we still surface in the project index because it's a
/// config file people open and edit, not build noise. The `.env` family is
/// the canonical case (`.env`, `.env.local`, `.env.production`, …) — it lives
/// in `.gitignore` by convention, so `--exclude-standard` drops it, yet it's
/// one of the files users most want to reach from ⌘P or an `@`-mention.
/// Mirrors the dotfile-visibility doctrine in [`is_always_hidden`], which
/// keeps `.env` in the file tree.
fn is_meaningful_ignored(base: &str) -> bool {
    const ENV: &str = ".env";
    base == ENV || base.starts_with(&format!("{ENV}."))
}

/// Project-wide file index for the command palette and the `@`-mention
/// picker. Shells `git ls-files` against `repo_root`: the `--exclude-standard`
/// pass keeps node_modules / build caches / `target` out for free. We then
/// union the *ignored* set back in, but filtered to the meaningful config
/// files ([`is_meaningful_ignored`]) so `.env` reappears without dragging
/// node_modules along. Falls back to an empty list for non-git roots; returns
/// repo-relative paths sorted lexically. The frontend filters + ranks; the
/// backend just supplies the haystack.
#[tauri::command]
pub async fn fs_find_files(repo_root: String) -> Vec<String> {
    crate::blocking::run(move || {
        let cwd = PathBuf::from(&repo_root);
        let run = |args: &[&str]| -> Vec<String> {
            let Ok(out) = std::process::Command::new("git")
                .args(args)
                .current_dir(&cwd)
                .output()
            else {
                return Vec::new();
            };
            if !out.status.success() {
                return Vec::new();
            }
            String::from_utf8_lossy(&out.stdout)
                .lines()
                .filter(|s| !s.is_empty())
                .map(|s| s.to_string())
                .collect()
        };

        // Tracked + untracked-but-not-ignored: the normal editable surface.
        let mut paths = run(&["ls-files", "--cached", "--others", "--exclude-standard"]);

        // …plus the few gitignored files worth opening — the `.env` family above
        // all. `--ignored` (with an exclude flag) lists what the standard rules
        // hide; we keep only the meaningful ones so caches stay out.
        //
        // `--directory` is load-bearing, not a tidy-up: without it git enumerates
        // every ignored path individually, which on a repo carrying node_modules
        // and Cargo's `target/` means ~470k lines and ~5s of wall clock — all of
        // it allocated into a Vec and then thrown away, since only a handful of
        // `.env` files survive the filter. With it git stops at the first wholly
        // ignored directory and reports that one entry, taking the same listing
        // to ~800 lines and ~40ms. The trade is deliberate: a `.env` buried
        // *inside* a wholly ignored folder is no longer surfaced, which is the
        // intent — those are caches and vendored trees, not files people edit.
        for rel in run(&[
            "ls-files",
            "--others",
            "--ignored",
            "--exclude-standard",
            "--directory",
        ]) {
            // Collapsed directories arrive with a trailing slash. They are not
            // files and must never reach the picker.
            if rel.ends_with('/') {
                continue;
            }
            let is_env = Path::new(&rel)
                .file_name()
                .map(|n| is_meaningful_ignored(&n.to_string_lossy()))
                .unwrap_or(false);
            if is_env {
                paths.push(rel);
            }
        }

        paths.sort();
        paths.dedup();
        paths
    })
    .await
}

/// Open the OS file manager focused on `path`. macOS uses `open -R`
/// (Finder's reveal-and-select); Linux falls back to opening the
/// parent directory; Windows uses `explorer /select,`. Errors are
/// returned as the spawned command's stderr.
#[tauri::command]
pub async fn fs_reveal_in_finder(path: String) -> Result<(), String> {
    crate::blocking::run(move || {
        let p = PathBuf::from(&path);
        if !p.exists() {
            return Err(format!("path does not exist: {path}"));
        }
        #[cfg(target_os = "macos")]
        let out = std::process::Command::new("open")
            .args(["-R"])
            .arg(&p)
            .output();
        #[cfg(target_os = "windows")]
        let out = std::process::Command::new("explorer")
            .arg(format!("/select,{}", p.display()))
            .output();
        #[cfg(all(unix, not(target_os = "macos")))]
        let out = {
            // No standard "reveal" on Linux; open the containing folder.
            let parent = p.parent().unwrap_or(&p);
            std::process::Command::new("xdg-open").arg(parent).output()
        };
        match out {
            Ok(o) if o.status.success() => Ok(()),
            Ok(o) => Err(String::from_utf8_lossy(&o.stderr).into_owned()),
            Err(e) => Err(e.to_string()),
        }
    })
    .await
}

#[tauri::command]
pub async fn git_diff(
    repo_root: String,
    file: String,
    since_base: Option<bool>,
) -> Result<String, String> {
    crate::blocking::run(move || {
        let cwd = PathBuf::from(&repo_root);
        let p = PathBuf::from(&file);
        let rel = p.strip_prefix(&cwd).unwrap_or(&p);

        // "All work since this worktree forked": this file's patch from the
        // fork-base commit to the working tree (committed + uncommitted), via
        // two-dot `git diff <base> -- <path>`. Only when a base actually resolves;
        // otherwise fall through to the plain `git diff HEAD` path below.
        if since_base == Some(true) {
            if let Some(base) = crate::cmd_aura_fs::worktree_fork_base(&repo_root) {
                let out = std::process::Command::new("git")
                    .args(["diff", &base, "--no-color", "--"])
                    .arg(rel)
                    .current_dir(&cwd)
                    .output()
                    .map_err(|e| e.to_string())?;
                if out.status.success() {
                    let body = String::from_utf8_lossy(&out.stdout).into_owned();
                    if !body.trim().is_empty() {
                        return Ok(body);
                    }
                    // Empty base diff falls through to the HEAD path below, which
                    // also handles the brand-new-untracked-file case.
                }
            }
        }

        let out = std::process::Command::new("git")
            .args(["diff", "HEAD", "--no-color", "--"])
            .arg(rel)
            .current_dir(&cwd)
            .output()
            .map_err(|e| e.to_string())?;
        if !out.status.success() {
            return Ok(String::new());
        }
        let body = String::from_utf8_lossy(&out.stdout).into_owned();
        if !body.trim().is_empty() {
            return Ok(body);
        }
        // A brand-new untracked file is invisible to `git diff HEAD` (it isn't in
        // the index OR the tree), so the diff comes back empty and the review pane
        // shows nothing. Detect that case and synthesize an add-diff of the whole
        // file via `git diff --no-index /dev/null <file>` so the reviewer actually
        // sees the new contents. git uses exit code 1 to mean "differences found"
        // here (not an error), so we accept both 0 and 1.
        if git_is_untracked(&cwd, rel) {
            let added = std::process::Command::new("git")
                .args(["diff", "--no-color", "--no-index", "--", "/dev/null"])
                .arg(rel)
                .current_dir(&cwd)
                .output()
                .map_err(|e| e.to_string())?;
            if matches!(added.status.code(), Some(0) | Some(1)) {
                return Ok(String::from_utf8_lossy(&added.stdout).into_owned());
            }
        }
        Ok(body)
    })
    .await
}

/// Is `rel` an untracked, non-ignored file in the repo at `cwd`? Uses
/// `git ls-files --others --exclude-standard -- <rel>`: a non-empty result
/// means git considers the path untracked-but-not-ignored. Quiet on any
/// failure (returns false), so the caller just keeps the empty diff.
fn git_is_untracked(cwd: &Path, rel: &Path) -> bool {
    let Ok(out) = std::process::Command::new("git")
        .args(["ls-files", "--others", "--exclude-standard", "--"])
        .arg(rel)
        .current_dir(cwd)
        .output()
    else {
        return false;
    };
    out.status.success() && !String::from_utf8_lossy(&out.stdout).trim().is_empty()
}

#[tauri::command]
pub async fn git_status(repo_root: String) -> Result<HashMap<String, String>, String> {
    crate::blocking::run(move || {
        let cwd = PathBuf::from(&repo_root);
        let map = git_status_map(&cwd);
        Ok(map
            .into_iter()
            .map(|(p, c)| (p.to_string_lossy().into_owned(), c.to_string()))
            .collect())
    })
    .await
}

/// Resolve the user's home dir as the default project root for first-run.
/// React can override by calling `set_project` (added W2 follow-up).
#[tauri::command]
pub async fn home_dir() -> String {
    std::env::var("HOME").unwrap_or_else(|_| "/".to_string())
}

/// The directory the shell was launched from. In dev (`bun run tauri dev`)
/// that's the user's project root; in a packaged build it's whatever the
/// OS hands us, which is fine — we'll fall back to home.
#[tauri::command]
pub async fn current_dir() -> String {
    std::env::current_dir()
        .map(|p| p.to_string_lossy().into_owned())
        .unwrap_or_else(|_| {
            std::env::var("HOME").unwrap_or_else(|_| "/".to_string())
        })
}

/// Active git branch name (HEAD short ref). Empty string if not a repo.
#[tauri::command]
pub async fn git_branch(repo_root: String) -> String {
    crate::blocking::run(move || {
        let cwd = PathBuf::from(&repo_root);
        let Ok(out) = std::process::Command::new("git")
            .args(["rev-parse", "--abbrev-ref", "HEAD"])
            .current_dir(&cwd)
            .output()
        else {
            return String::new();
        };
        if !out.status.success() {
            return String::new();
        }
        String::from_utf8_lossy(&out.stdout).trim().to_string()
    })
    .await
}

/// One branch row for the footer branch switcher.
#[derive(Serialize)]
pub struct GitBranchInfo {
    /// Short name: `main`, `feat/x`, or `origin/feat/x` for remotes.
    pub name: String,
    pub is_current: bool,
    pub is_remote: bool,
    /// Short upstream ref (`origin/main`) when the local branch tracks one.
    pub upstream: Option<String>,
    /// Last commit subject — context in the dropdown.
    pub subject: Option<String>,
}

/// Local + remote-tracking branches for the switcher, newest-commit first.
/// Current branch is flagged. The remote `origin/HEAD` symbolic pointer is
/// skipped. Empty vec if not a repo.
#[tauri::command]
pub async fn git_branches(repo_root: String) -> Vec<GitBranchInfo> {
    crate::blocking::run(move || {
        let cwd = PathBuf::from(&repo_root);
        // One for-each-ref call gives every field in a stable, tab-delimited
        // form. `%(HEAD)` marks the current branch with `*`. Full `%(refname)`
        // lets us tell locals (refs/heads) from remotes (refs/remotes) since
        // the short name alone is ambiguous (both can contain slashes).
        let fmt = "%(refname)\t%(refname:short)\t%(HEAD)\t%(upstream:short)\t%(contents:subject)";
        let Ok(out) = std::process::Command::new("git")
            .args([
                "for-each-ref",
                "--sort=-committerdate",
                "--format",
                fmt,
                "refs/heads",
                "refs/remotes",
            ])
            .current_dir(&cwd)
            .output()
        else {
            return Vec::new();
        };
        if !out.status.success() {
            return Vec::new();
        }
        let text = String::from_utf8_lossy(&out.stdout);
        let mut branches = Vec::new();
        for line in text.lines() {
            let mut cols = line.split('\t');
            let full = cols.next().unwrap_or("").trim();
            let short = cols.next().unwrap_or("").trim().to_string();
            let head = cols.next().unwrap_or("").trim();
            let upstream = cols.next().unwrap_or("").trim();
            let subject = cols.next().unwrap_or("").trim();
            if short.is_empty() {
                continue;
            }
            // Skip the `origin/HEAD -> origin/main` symbolic pointer; it isn't a
            // real branch and would show as a duplicate of the default.
            if short.ends_with("/HEAD") {
                continue;
            }
            branches.push(GitBranchInfo {
                is_remote: full.starts_with("refs/remotes/"),
                is_current: head == "*",
                upstream: if upstream.is_empty() {
                    None
                } else {
                    Some(upstream.to_string())
                },
                subject: if subject.is_empty() {
                    None
                } else {
                    Some(subject.to_string())
                },
                name: short,
            });
        }
        branches
    })
    .await
}

/// A richly-detailed branch row for the Cmd-K branch switcher. One
/// `git for-each-ref` call (NOT N) fills every field so the modal can show
/// per-branch context — author, when it last moved, the subject line, and how
/// far ahead/behind its upstream — without a round-trip per branch.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GitBranchRich {
    /// Short name: `main`, `feat/x`, or `origin/feat/x` for remotes.
    pub name: String,
    pub is_current: bool,
    pub is_remote: bool,
    /// Short upstream ref (`origin/main`) when the local branch tracks one.
    pub upstream: Option<String>,
    /// Commits this branch is ahead of its upstream (0 when no upstream).
    pub ahead: u32,
    /// Commits this branch is behind its upstream (0 when no upstream).
    pub behind: u32,
    /// Last-commit author name — who last moved this branch.
    pub author: Option<String>,
    /// Last-commit time, unix seconds — drives the "2h ago" relative label.
    pub committed_at: Option<i64>,
    /// Last commit subject — the one-line "what's on this branch".
    pub subject: Option<String>,
}

/// Parse `%(upstream:track)` — git emits e.g. `[ahead 3, behind 1]`,
/// `[ahead 2]`, `[behind 5]`, `[gone]`, or empty. Returns (ahead, behind).
fn parse_track(track: &str) -> (u32, u32) {
    let mut ahead = 0u32;
    let mut behind = 0u32;
    let inner = track.trim().trim_start_matches('[').trim_end_matches(']');
    for part in inner.split(',') {
        let part = part.trim();
        if let Some(n) = part.strip_prefix("ahead ") {
            ahead = n.trim().parse().unwrap_or(0);
        } else if let Some(n) = part.strip_prefix("behind ") {
            behind = n.trim().parse().unwrap_or(0);
        }
    }
    (ahead, behind)
}

/// Local + remote branches with rich per-branch context for the Cmd-K
/// switcher, newest-commit first. One `for-each-ref` call yields every field;
/// the current branch is flagged and the `origin/HEAD` pointer skipped. Empty
/// vec if not a repo.
#[tauri::command]
pub async fn git_branches_rich(repo_root: String) -> Vec<GitBranchRich> {
    crate::blocking::run(move || {
        let cwd = PathBuf::from(&repo_root);
        // A unit-separator (\x1f, "US") between fields survives subjects and
        // author names that themselves contain tabs; `%(upstream:track)` carries
        // the ahead/behind summary so we never shell out per branch.
        let fmt = "%(refname)\x1f%(refname:short)\x1f%(HEAD)\x1f%(upstream:short)\x1f%(upstream:track)\x1f%(authorname)\x1f%(committerdate:unix)\x1f%(contents:subject)";
        let Ok(out) = std::process::Command::new("git")
            .args([
                "for-each-ref",
                "--sort=-committerdate",
                "--format",
                fmt,
                "refs/heads",
                "refs/remotes",
            ])
            .current_dir(&cwd)
            .output()
        else {
            return Vec::new();
        };
        if !out.status.success() {
            return Vec::new();
        }
        let text = String::from_utf8_lossy(&out.stdout);
        let mut branches = Vec::new();
        for line in text.lines() {
            let mut cols = line.split('\x1f');
            let full = cols.next().unwrap_or("").trim();
            let short = cols.next().unwrap_or("").trim().to_string();
            let head = cols.next().unwrap_or("").trim();
            let upstream = cols.next().unwrap_or("").trim();
            let track = cols.next().unwrap_or("");
            let author = cols.next().unwrap_or("").trim();
            let committed = cols.next().unwrap_or("").trim();
            let subject = cols.next().unwrap_or("").trim();
            if short.is_empty() {
                continue;
            }
            // Skip the `origin/HEAD -> origin/main` symbolic pointer.
            if short.ends_with("/HEAD") {
                continue;
            }
            let (ahead, behind) = parse_track(track);
            branches.push(GitBranchRich {
                is_remote: full.starts_with("refs/remotes/"),
                is_current: head == "*",
                upstream: if upstream.is_empty() {
                    None
                } else {
                    Some(upstream.to_string())
                },
                ahead,
                behind,
                author: if author.is_empty() {
                    None
                } else {
                    Some(author.to_string())
                },
                committed_at: committed.parse::<i64>().ok(),
                subject: if subject.is_empty() {
                    None
                } else {
                    Some(subject.to_string())
                },
                name: short,
            });
        }
        branches
    })
    .await
}

/// Does `ref_path` (a fully-qualified ref like `refs/heads/x` or
/// `refs/remotes/origin/x`) resolve in this repo?
fn git_ref_exists(cwd: &std::path::Path, ref_path: &str) -> bool {
    std::process::Command::new("git")
        .args(["show-ref", "--verify", "--quiet", ref_path])
        .current_dir(cwd)
        .status()
        .map(|s| s.success())
        .unwrap_or(false)
}

/// The git arguments that switch to `branch` without ever landing in detached
/// HEAD. The branch list hands us either a plain local name (`feat/x`) or a
/// remote-tracking ref under *any* remote (`origin/feat/x`, `upstream/feat/x`,
/// `fork/feat/x`). Checking a remote ref out verbatim detaches HEAD, so when
/// the ref belongs to a remote we create/switch to a local branch that tracks
/// it. The remote is the first path segment of a `refs/remotes/<remote>/…` ref.
fn checkout_args(cwd: &std::path::Path, branch: &str) -> Vec<String> {
    // A real local branch of this exact name → just switch.
    if git_ref_exists(cwd, &format!("refs/heads/{branch}")) {
        return vec!["checkout".into(), branch.into()];
    }
    // A remote-tracking ref → make a local branch that tracks it. Works for
    // origin and for any other remote alike (the old code only stripped
    // `origin/`, so `upstream/feat/x` detached HEAD).
    if git_ref_exists(cwd, &format!("refs/remotes/{branch}")) {
        if let Some((_remote, rest)) = branch.split_once('/') {
            if !rest.is_empty() && !rest.ends_with("/HEAD") {
                // A local branch of the short name may already exist (e.g. the
                // user checked it out earlier from a different remote) — git
                // refuses `-b` on an existing branch, so just switch to it.
                if git_ref_exists(cwd, &format!("refs/heads/{rest}")) {
                    return vec!["checkout".into(), rest.into()];
                }
                return vec![
                    "checkout".into(),
                    "-b".into(),
                    rest.into(),
                    "--track".into(),
                    branch.into(),
                ];
            }
        }
    }
    // Neither a known local nor remote branch — fall back to git's own DWIM so
    // tags / detached SHAs the UI might pass still resolve as before.
    vec!["checkout".into(), branch.into()]
}

/// Checkout an existing branch. A remote-tracking ref under any remote
/// (`origin/feat/x`, `upstream/feat/x`) is resolved to a local branch tracking
/// it instead of landing in detached HEAD. Returns `Ok(())` on success, else
/// git's own stderr (e.g. "would be overwritten by checkout") for the UI.
#[tauri::command]
pub async fn git_checkout(repo_root: String, branch: String) -> Result<(), String> {
    crate::blocking::run(move || {
        let cwd = PathBuf::from(&repo_root);
        let args = checkout_args(&cwd, &branch);
        let out = std::process::Command::new("git")
            .args(&args)
            .current_dir(&cwd)
            .output()
            .map_err(|e| e.to_string())?;
        if out.status.success() {
            return Ok(());
        }
        let err = String::from_utf8_lossy(&out.stderr).trim().to_string();
        Err(if err.is_empty() {
            "checkout failed".to_string()
        } else {
            err
        })
    })
    .await
}

/// Create a new branch from HEAD and switch to it (`git checkout -b`).
/// Returns git's stderr on failure (e.g. name already exists).
#[tauri::command]
pub async fn git_create_branch(repo_root: String, name: String) -> Result<(), String> {
    crate::blocking::run(move || {
        let cwd = PathBuf::from(&repo_root);
        let out = std::process::Command::new("git")
            .args(["checkout", "-b", &name])
            .current_dir(&cwd)
            .output()
            .map_err(|e| e.to_string())?;
        if out.status.success() {
            return Ok(());
        }
        let err = String::from_utf8_lossy(&out.stderr).trim().to_string();
        Err(if err.is_empty() {
            "create branch failed".to_string()
        } else {
            err
        })
    })
    .await
}

/// Raw `origin` remote URL. Empty string if no remote or not a repo.
/// Frontend parses the URL into `owner/name` for github filtering
/// (A2A task listing uses github_full_name as the scope key).
#[tauri::command]
pub async fn git_remote_origin(repo_root: String) -> String {
    crate::blocking::run(move || {
        let cwd = PathBuf::from(&repo_root);
        let Ok(out) = std::process::Command::new("git")
            .args(["remote", "get-url", "origin"])
            .current_dir(&cwd)
            .output()
        else {
            return String::new();
        };
        if !out.status.success() {
            return String::new();
        }
        String::from_utf8_lossy(&out.stdout).trim().to_string()
    })
    .await
}

#[derive(Serialize)]
pub struct WorktreeEntry {
    pub path: String,
    pub branch: String,
    pub head: String,
    pub is_main: bool,
    pub locked: bool,
    /// Unix seconds of the worktree HEAD's commit (committer date). Lets the
    /// Workspaces center view group copies by recency ("Today / This week /
    /// Earlier") the way Conductor does — real time, never invented. `None`
    /// when the branch tip can't be resolved (e.g. a detached or empty head).
    pub head_committed_at: Option<i64>,
}

/// `git worktree list --porcelain` parsed into structured rows. Used by the
/// workspace rail to show sibling worktrees so multiple agents can be parked
/// on different branches of the same project.
///
/// Errors are returned as `Err`, NOT as an empty list. That distinction is the
/// whole point: a caller that can't tell "this project has no worktrees" from
/// "git didn't answer just now" will cache the failure as truth and show an
/// empty rail — which reads, to the person looking at it, as though their
/// worktrees were deleted. They weren't; nothing here writes to disk. Say
/// "I couldn't look" out loud and let the caller retry.
///
/// The git calls run on the blocking pool. This command is fanned out across
/// every recent project at once, and `std::process::Command` parks the thread
/// it runs on — doing that on async runtime threads is what makes the calls
/// fail under load in the first place.
#[tauri::command]
pub async fn git_worktree_list(repo_root: String) -> Result<Vec<WorktreeEntry>, String> {
    tokio::task::spawn_blocking(move || git_worktree_list_blocking(&repo_root))
        .await
        .map_err(|e| format!("worktree list task failed: {e}"))?
}

fn git_worktree_list_blocking(repo_root: &str) -> Result<Vec<WorktreeEntry>, String> {
    let cwd = PathBuf::from(repo_root);
    let out = std::process::Command::new("git")
        .args(["worktree", "list", "--porcelain"])
        .current_dir(&cwd)
        .output()
        .map_err(|e| format!("could not run git in {repo_root}: {e}"))?;
    if !out.status.success() {
        return Err(format!(
            "git worktree list failed in {repo_root}: {}",
            String::from_utf8_lossy(&out.stderr).trim()
        ));
    }
    let body = String::from_utf8_lossy(&out.stdout);
    let mut entries: Vec<WorktreeEntry> = Vec::new();
    let mut cur: Option<WorktreeEntry> = None;
    for line in body.lines() {
        if let Some(rest) = line.strip_prefix("worktree ") {
            if let Some(prev) = cur.take() {
                entries.push(prev);
            }
            cur = Some(WorktreeEntry {
                path: rest.to_string(),
                branch: String::new(),
                head: String::new(),
                is_main: false,
                locked: false,
                head_committed_at: None,
            });
        } else if let Some(rest) = line.strip_prefix("HEAD ") {
            if let Some(e) = cur.as_mut() {
                e.head = rest.to_string();
            }
        } else if let Some(rest) = line.strip_prefix("branch ") {
            if let Some(e) = cur.as_mut() {
                // `refs/heads/<name>` → `<name>` for display.
                e.branch = rest.strip_prefix("refs/heads/").unwrap_or(rest).to_string();
            }
        } else if line == "locked" || line.starts_with("locked ") {
            if let Some(e) = cur.as_mut() {
                e.locked = true;
            }
        } else if line == "detached" {
            if let Some(e) = cur.as_mut() {
                e.branch = String::new();
            }
        }
    }
    if let Some(prev) = cur.take() {
        entries.push(prev);
    }
    // The first entry from `git worktree list` is always the main
    // worktree. Mark it so the UI can label it distinctly.
    if let Some(first) = entries.first_mut() {
        first.is_main = true;
    }
    // One batched `for-each-ref` builds an oid → committer-unix map over every
    // local branch tip, so we stamp each worktree's HEAD commit time without N
    // per-worktree `git log` calls. Worktrees whose HEAD isn't a branch tip
    // (detached) simply stay `None` — honest, never guessed.
    if !entries.is_empty() {
        if let Ok(refs) = std::process::Command::new("git")
            .args([
                "for-each-ref",
                "--format=%(objectname) %(committerdate:unix)",
                "refs/heads/",
            ])
            .current_dir(&cwd)
            .output()
        {
            if refs.status.success() {
                let text = String::from_utf8_lossy(&refs.stdout);
                let mut time_by_oid: std::collections::HashMap<&str, i64> =
                    std::collections::HashMap::new();
                for line in text.lines() {
                    if let Some((oid, ts)) = line.split_once(' ') {
                        if let Ok(secs) = ts.trim().parse::<i64>() {
                            time_by_oid.insert(oid, secs);
                        }
                    }
                }
                for e in entries.iter_mut() {
                    if let Some(secs) = time_by_oid.get(e.head.as_str()) {
                        e.head_committed_at = Some(*secs);
                    }
                }
            }
        }
    }
    Ok(entries)
}

/// Create a fresh worktree at `worktree_path` rooted at `repo_root`. If
/// `branch` is `Some`, the new worktree is on a fresh branch off HEAD;
/// otherwise it tracks HEAD detached. Used by the Manager loop to
/// isolate each task in its own working dir so multiple subagents on
/// adjacent files don't collide. Errors return their stderr verbatim.
#[tauri::command]
pub async fn git_worktree_add(
    repo_root: String,
    worktree_path: String,
    branch: Option<String>,
) -> Result<String, String> {
    crate::blocking::run(move || {
        let cwd = PathBuf::from(&repo_root);
        let mut args = vec!["worktree".to_string(), "add".to_string()];
        if let Some(b) = &branch {
            args.push("-b".to_string());
            args.push(b.clone());
        }
        args.push(worktree_path.clone());
        let out = std::process::Command::new("git")
            .args(&args)
            .current_dir(&cwd)
            .output()
            .map_err(|e| format!("spawn git: {e}"))?;
        if !out.status.success() {
            return Err(String::from_utf8_lossy(&out.stderr).to_string());
        }
        Ok(worktree_path)
    })
    .await
}

/// `git worktree remove [--force] <path>`. `force=true` lets us cleanup
/// after a cancelled task even when the working tree is dirty. The
/// branch the worktree was on is left intact — caller can prune later.
#[tauri::command]
pub async fn git_worktree_remove(
    repo_root: String,
    worktree_path: String,
    force: bool,
) -> Result<(), String> {
    crate::blocking::run(move || {
        let cwd = PathBuf::from(&repo_root);
        let mut args = vec!["worktree".to_string(), "remove".to_string()];
        if force {
            args.push("--force".to_string());
        }
        args.push(worktree_path.clone());
        let out = std::process::Command::new("git")
            .args(&args)
            .current_dir(&cwd)
            .output()
            .map_err(|e| format!("spawn git: {e}"))?;
        if !out.status.success() {
            return Err(String::from_utf8_lossy(&out.stderr).to_string());
        }
        Ok(())
    })
    .await
}

/// Outcome of a `git_worktree_rebase` attempt. `exit` is the raw exit
/// code so the caller can distinguish 0 (clean) from 128 (worktree
/// missing) from 1 (conflict). `diagnostic` is stdout+stderr trimmed
/// to ~2KB — enough to surface which file conflicted.
#[derive(serde::Serialize)]
pub struct WorktreeRebaseResult {
    pub exit: i32,
    pub diagnostic: String,
    pub conflicted_files: Vec<String>,
}

/// `git rebase <onto_ref>` inside an existing worktree. Used by the
/// Manager auto-rebase hook so a downstream task's worktree picks up
/// an upstream task's changes the moment the parent completes. On
/// conflict, leaves the worktree paused (rebase HEAD detached) so the
/// caller can decide to abort or hand off to a resolver — we don't
/// auto-`--abort` here because that would discard the conflict markers
/// the user might want to inspect.
#[tauri::command]
pub async fn git_worktree_rebase(
    worktree_path: String,
    onto_ref: String,
) -> Result<WorktreeRebaseResult, String> {
    crate::blocking::run(move || {
        let cwd = PathBuf::from(&worktree_path);
        if !cwd.is_dir() {
            return Err(format!("worktree path is not a directory: {worktree_path}"));
        }
        let out = std::process::Command::new("git")
            .args(["rebase", &onto_ref])
            .current_dir(&cwd)
            .output()
            .map_err(|e| format!("spawn git rebase: {e}"))?;
        let exit = out.status.code().unwrap_or(-1);
        let mut diagnostic = String::new();
        diagnostic.push_str(&String::from_utf8_lossy(&out.stdout));
        if !out.stderr.is_empty() {
            if !diagnostic.is_empty() {
                diagnostic.push('\n');
            }
            diagnostic.push_str(&String::from_utf8_lossy(&out.stderr));
        }
        if diagnostic.len() > 2048 {
            diagnostic.truncate(2048);
            diagnostic.push_str("…");
        }
        let mut conflicted_files = Vec::new();
        if exit != 0 {
            // `git diff --name-only --diff-filter=U` lists files with
            // unmerged paths. Cheap follow-up; ignore failure.
            if let Ok(d) = std::process::Command::new("git")
                .args(["diff", "--name-only", "--diff-filter=U"])
                .current_dir(&cwd)
                .output()
            {
                for line in String::from_utf8_lossy(&d.stdout).lines() {
                    let t = line.trim();
                    if !t.is_empty() {
                        conflicted_files.push(t.to_string());
                    }
                }
            }
        }
        Ok(WorktreeRebaseResult {
            exit,
            diagnostic,
            conflicted_files,
        })
    })
    .await
}

/// One row from `git_branch_diff_files`. `status` is the porcelain
/// letter from `git diff --name-status` (`A` added, `M` modified, `D`
/// deleted, `R` renamed, `T` type-changed); `additions` / `deletions`
/// are pulled from `--numstat`. Surfaces in the Compare Worktrees
/// dialog so the user can scan which files each agent touched before
/// drilling into the diff.
#[derive(serde::Serialize)]
pub struct BranchDiffFile {
    pub path: String,
    pub status: String,
    pub additions: u64,
    pub deletions: u64,
}

/// Files changed between two refs in the same repository. Used by F2's
/// Compare Worktrees comparator: each managed worktree's branch is
/// diffed against a common base (typically the main repo's current
/// branch) so the user can see what each parallel agent run produced.
#[tauri::command]
pub async fn git_branch_diff_files(
    repo_root: String,
    base_ref: String,
    head_ref: String,
) -> Result<Vec<BranchDiffFile>, String> {
    crate::blocking::run(move || {
        let cwd = PathBuf::from(&repo_root);
        let range = format!("{base_ref}...{head_ref}");
        let names = std::process::Command::new("git")
            .args(["diff", "--name-status", "--no-renames", &range])
            .current_dir(&cwd)
            .output()
            .map_err(|e| format!("spawn git diff --name-status: {e}"))?;
        if !names.status.success() {
            return Err(String::from_utf8_lossy(&names.stderr).to_string());
        }
        let mut rows: Vec<BranchDiffFile> = Vec::new();
        for line in String::from_utf8_lossy(&names.stdout).lines() {
            let mut parts = line.splitn(2, '\t');
            let status = parts.next().unwrap_or("").to_string();
            let path = parts.next().unwrap_or("").to_string();
            if status.is_empty() || path.is_empty() {
                continue;
            }
            rows.push(BranchDiffFile { path, status, additions: 0, deletions: 0 });
        }
        let stats = std::process::Command::new("git")
            .args(["diff", "--numstat", "--no-renames", &range])
            .current_dir(&cwd)
            .output()
            .map_err(|e| format!("spawn git diff --numstat: {e}"))?;
        if stats.status.success() {
            for line in String::from_utf8_lossy(&stats.stdout).lines() {
                let mut parts = line.split('\t');
                let add = parts.next().unwrap_or("0");
                let del = parts.next().unwrap_or("0");
                let path = parts.next().unwrap_or("");
                // Binary files report `-` for both counts; treat as zero so
                // the row still renders without panicking on parse.
                let add: u64 = add.parse().unwrap_or(0);
                let del: u64 = del.parse().unwrap_or(0);
                if let Some(row) = rows.iter_mut().find(|r| r.path == path) {
                    row.additions = add;
                    row.deletions = del;
                }
            }
        }
        Ok(rows)
    })
    .await
}

/// Unified diff text for one file between two refs. Returns empty
/// string when the file is unchanged or the diff fails — callers
/// render "no change in this branch" in that case.
#[tauri::command]
pub async fn git_branch_diff_file(
    repo_root: String,
    base_ref: String,
    head_ref: String,
    file: String,
) -> String {
    crate::blocking::run(move || {
        let cwd = PathBuf::from(&repo_root);
        let range = format!("{base_ref}...{head_ref}");
        let Ok(out) = std::process::Command::new("git")
            .args(["diff", "--no-color", &range, "--", &file])
            .current_dir(&cwd)
            .output()
        else {
            return String::new();
        };
        if !out.status.success() {
            return String::new();
        }
        String::from_utf8_lossy(&out.stdout).into_owned()
    })
    .await
}

/// `git merge --no-ff <branch>` from the main repo's current HEAD.
/// Returns the combined stdout/stderr so the caller can show it on
/// failure (merge conflict, divergent histories). On success, the
/// caller refreshes worktree list + status.
#[tauri::command]
pub async fn git_merge_branch(
    repo_root: String,
    branch: String,
    message: Option<String>,
) -> Result<String, String> {
    crate::blocking::run(move || {
        let cwd = PathBuf::from(&repo_root);
        let mut args: Vec<String> = vec![
            "merge".into(),
            "--no-ff".into(),
            branch.clone(),
        ];
        if let Some(m) = message {
            args.push("-m".into());
            args.push(m);
        }
        let out = std::process::Command::new("git")
            .args(&args)
            .current_dir(&cwd)
            .output()
            .map_err(|e| format!("spawn git merge: {e}"))?;
        let combined = format!(
            "{}{}",
            String::from_utf8_lossy(&out.stdout),
            String::from_utf8_lossy(&out.stderr),
        );
        if !out.status.success() {
            return Err(combined);
        }
        Ok(combined)
    })
    .await
}

/// `git show HEAD:<rel>` — the file as it exists in the most recent commit.
/// Empty string when the file is untracked or HEAD doesn't exist yet.
#[tauri::command]
pub async fn git_show_head(repo_root: String, file: String) -> String {
    crate::blocking::run(move || {
        let cwd = PathBuf::from(&repo_root);
        let p = PathBuf::from(&file);
        let rel = p.strip_prefix(&cwd).unwrap_or(&p);
        let rel_str = rel.to_string_lossy();
        let spec = format!("HEAD:{}", rel_str);
        let Ok(out) = std::process::Command::new("git")
            .args(["show", &spec])
            .current_dir(&cwd)
            .output()
        else {
            return String::new();
        };
        if !out.status.success() {
            return String::new();
        }
        String::from_utf8_lossy(&out.stdout).into_owned()
    })
    .await
}

/// Per-line blame for a single file. Shells `git blame --line-porcelain`
/// once and parses the porcelain stream into a flat `Vec<BlameLine>` so
/// the frontend can render an inline gutter without further work.
///
/// Returns an empty vec when the file is untracked, the repo is missing,
/// or git blame fails — callers degrade gracefully (no gutter shown).
#[derive(Serialize)]
pub struct BlameLine {
    pub line: u32,
    pub sha: String,
    pub author: String,
    pub ts: i64,
    pub summary: String,
}

#[tauri::command]
pub async fn git_blame_lines(
    repo_root: String,
    file: String,
) -> Vec<BlameLine> {
    crate::blocking::run(move || {
        let cwd = PathBuf::from(&repo_root);
        let p = PathBuf::from(&file);
        let rel = p.strip_prefix(&cwd).unwrap_or(&p);
        let Ok(out) = std::process::Command::new("git")
            .args(["blame", "--line-porcelain", "--", &rel.to_string_lossy()])
            .current_dir(&cwd)
            .output()
        else {
            return Vec::new();
        };
        if !out.status.success() {
            return Vec::new();
        }
        let text = String::from_utf8_lossy(&out.stdout);

        // Porcelain layout: each line group starts with `<sha> <orig> <final>
        // <count>`, followed by header lines (`author X`, `author-time T`,
        // `summary S`, etc.), and ends with a tab-prefixed content line. We
        // only keep one entry per `final` line number.
        let mut out_lines: Vec<BlameLine> = Vec::new();
        let mut cur_sha = String::new();
        let mut cur_line: u32 = 0;
        let mut cur_author = String::new();
        let mut cur_ts: i64 = 0;
        let mut cur_summary = String::new();
        let mut have_header = false;

        for raw in text.lines() {
            if raw.starts_with('\t') {
                // Content line — this is the final marker for the current group.
                if have_header && cur_line > 0 {
                    out_lines.push(BlameLine {
                        line: cur_line,
                        sha: cur_sha.clone(),
                        author: cur_author.clone(),
                        ts: cur_ts,
                        summary: cur_summary.clone(),
                    });
                }
                have_header = false;
                continue;
            }
            let mut parts = raw.splitn(2, ' ');
            let head = parts.next().unwrap_or("");
            let rest = parts.next().unwrap_or("");
            // The header line has 4 space-separated tokens; everything else is
            // a single key/value pair we care about a handful of.
            if head.len() >= 7 && head.chars().all(|c| c.is_ascii_hexdigit()) {
                // sha + " " + orig_line + " " + final_line + " " + count?
                let mut tokens = raw.split_ascii_whitespace();
                cur_sha = tokens.next().unwrap_or("").to_string();
                let _orig = tokens.next();
                cur_line = tokens
                    .next()
                    .and_then(|s| s.parse::<u32>().ok())
                    .unwrap_or(0);
                have_header = true;
            } else if head == "author" {
                cur_author = rest.to_string();
            } else if head == "author-time" {
                cur_ts = rest.parse::<i64>().unwrap_or(0);
            } else if head == "summary" {
                cur_summary = rest.to_string();
            }
        }
        out_lines
    })
    .await
}

/// Seconds since the most recent commit on HEAD. Returns -1 if not a repo.
#[tauri::command]
pub async fn git_last_commit_age(repo_root: String) -> i64 {
    crate::blocking::run(move || {
        let cwd = PathBuf::from(&repo_root);
        let Ok(out) = std::process::Command::new("git")
            .args(["log", "-1", "--format=%ct"])
            .current_dir(&cwd)
            .output()
        else {
            return -1;
        };
        if !out.status.success() {
            return -1;
        }
        let s = String::from_utf8_lossy(&out.stdout);
        let Ok(ts) = s.trim().parse::<i64>() else {
            return -1;
        };
        let now = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_secs() as i64)
            .unwrap_or(ts);
        (now - ts).max(0)
    })
    .await
}

/// Stage one or more paths (relative to repo root or absolute). Returns
/// the trimmed git stderr/stdout so the React side can surface failures.
#[tauri::command]
pub async fn git_stage(repo_root: String, paths: Vec<String>) -> Result<String, String> {
    crate::blocking::run(move || {
        git_simple(&repo_root, "add", &paths)
    })
    .await
}

/// Unstage by resetting paths back to HEAD's index entry. Same surface as
/// `git_stage` so the UI can call them symmetrically.
#[tauri::command]
pub async fn git_unstage(repo_root: String, paths: Vec<String>) -> Result<String, String> {
    crate::blocking::run(move || {
        let cwd = PathBuf::from(&repo_root);
        let mut args = vec!["reset".to_string(), "HEAD".to_string(), "--".to_string()];
        args.extend(paths);
        let out = std::process::Command::new("git")
            .args(&args)
            .current_dir(&cwd)
            .output()
            .map_err(|e| e.to_string())?;
        git_output_result(&out)
    })
    .await
}

/// `git commit -m <message>` against whatever is currently staged. The
/// caller is responsible for staging first; we deliberately don't pass
/// `-a` so the user keeps the explicit two-step VCS workflow.
#[tauri::command]
pub async fn git_commit(repo_root: String, message: String) -> Result<String, String> {
    crate::blocking::run(move || {
        let cwd = PathBuf::from(&repo_root);

        // Auto-log intent from the commit message before invoking git so the
        // pre-commit hook (which checks `.aura/.intent_logged`) doesn't fire
        // a "no intent" abort. The user typed the commit message — that IS
        // the intent. Best-effort: any IO failure is swallowed; the hook
        // will still abort with its existing message if it can't find the
        // marker.
        let aura_dir = cwd.join(".aura");
        if std::fs::create_dir_all(&aura_dir).is_ok() {
            let _ = std::fs::write(aura_dir.join(".intent_logged"), "1");
            let log_path = aura_dir.join("intent_log.jsonl");
            let now = std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .map(|d| d.as_secs())
                .unwrap_or(0);
            let line = serde_json::json!({
                "agent_id": "aura-shell-commit",
                "intent": message.trim(),
                "timestamp": now,
            });
            if let Ok(mut f) = std::fs::OpenOptions::new()
                .create(true)
                .append(true)
                .open(&log_path)
            {
                use std::io::Write;
                let _ = writeln!(f, "{}", line);
            }
        }

        let out = std::process::Command::new("git")
            .args(["commit", "-m", &message])
            .current_dir(&cwd)
            .output()
            .map_err(|e| e.to_string())?;
        if !out.status.success() {
            return Err(String::from_utf8_lossy(&out.stderr).trim().to_string());
        }
        Ok(String::from_utf8_lossy(&out.stdout).trim().to_string())
    })
    .await
}

/// `git push` — set-upstream when the branch hasn't been published yet.
/// Returns trimmed stdout/stderr so the caller can surface the result.
#[tauri::command]
pub async fn git_push(repo_root: String, set_upstream: bool) -> Result<String, String> {
    crate::blocking::run(move || {
        let cwd = PathBuf::from(&repo_root);
        let branch = current_branch(&cwd);
        let mut args: Vec<String> = vec!["push".into()];
        if set_upstream {
            args.push("-u".into());
            args.push("origin".into());
            if let Some(b) = branch {
                args.push(b);
            }
        }
        let out = std::process::Command::new("git")
            .args(&args)
            .current_dir(&cwd)
            .output()
            .map_err(|e| e.to_string())?;
        if !out.status.success() {
            return Err(String::from_utf8_lossy(&out.stderr).trim().to_string());
        }
        Ok(String::from_utf8_lossy(&out.stdout).trim().to_string())
    })
    .await
}

/// `git pull` against the configured upstream — fast-forward only by
/// default to avoid surprise merge commits. Caller can fall back to
/// `git_fetch` + manual rebase via the chevron menu.
#[tauri::command]
pub async fn git_pull(repo_root: String) -> Result<String, String> {
    crate::blocking::run(move || {
        let cwd = PathBuf::from(&repo_root);
        let out = std::process::Command::new("git")
            .args(["pull", "--ff-only"])
            .current_dir(&cwd)
            .output()
            .map_err(|e| e.to_string())?;
        if !out.status.success() {
            return Err(String::from_utf8_lossy(&out.stderr).trim().to_string());
        }
        Ok(String::from_utf8_lossy(&out.stdout).trim().to_string())
    })
    .await
}

/// `git fetch --all --prune` — refresh remote tracking refs without
/// touching the working copy. Cheap; doesn't risk merge conflicts.
#[tauri::command]
pub async fn git_fetch(repo_root: String) -> Result<String, String> {
    crate::blocking::run(move || {
        let cwd = PathBuf::from(&repo_root);
        let out = std::process::Command::new("git")
            .args(["fetch", "--all", "--prune"])
            .current_dir(&cwd)
            .output()
            .map_err(|e| e.to_string())?;
        if !out.status.success() {
            return Err(String::from_utf8_lossy(&out.stderr).trim().to_string());
        }
        Ok(String::from_utf8_lossy(&out.stdout).trim().to_string())
    })
    .await
}

/// "Sync" = pull then push. Used by the CommitInput's primary action
/// when the branch has both inbound and outbound commits.
#[tauri::command]
pub async fn git_sync(repo_root: String) -> Result<String, String> {
    let pull = git_pull(repo_root.clone()).await?;
    let push = git_push(repo_root, false).await?;
    Ok(format!("{}\n{}", pull, push).trim().to_string())
}

/// Derive a directory name from a clone URL. `git@host:owner/repo.git` and
/// `https://host/owner/repo.git` both reduce to `repo`. Falls back to
/// "repo" if nothing usable is found.
fn repo_name_from_url(url: &str) -> String {
    let trimmed = url.trim().trim_end_matches('/');
    let tail = trimmed
        .rsplit(|c| c == '/' || c == ':')
        .find(|s| !s.is_empty())
        .unwrap_or("repo");
    let name = tail.strip_suffix(".git").unwrap_or(tail);
    if name.is_empty() {
        "repo".to_string()
    } else {
        name.to_string()
    }
}

/// Result of creating a new project on disk — the absolute path the
/// frontend should hand to `loadProjectAt` to open it as a workspace.
#[derive(Serialize)]
pub struct NewRepo {
    pub root: String,
    pub name: String,
}

/// Clone a remote repository into `parent_dir`. Used by the New Project
/// screen's "Clone" tile. The destination folder name is derived from the
/// URL unless `name` is given. Refuses to overwrite an existing non-empty
/// directory so we never clobber the user's files.
#[tauri::command]
pub async fn git_clone(
    url: String,
    parent_dir: String,
    name: Option<String>,
) -> Result<NewRepo, String> {
    crate::blocking::run(move || {
        let url = url.trim().to_string();
        if url.is_empty() {
            return Err("Repository URL is required.".into());
        }
        let folder = name
            .map(|s| s.trim().to_string())
            .filter(|s| !s.is_empty())
            .unwrap_or_else(|| repo_name_from_url(&url));

        let parent = PathBuf::from(&parent_dir);
        fs::create_dir_all(&parent).map_err(|e| format!("create {}: {e}", parent.display()))?;
        let dest = parent.join(&folder);
        if dest.exists() && fs::read_dir(&dest).map(|mut d| d.next().is_some()).unwrap_or(false) {
            return Err(format!("{} already exists and is not empty.", dest.display()));
        }

        let out = std::process::Command::new("git")
            .args(["clone", "--progress", &url])
            .arg(&dest)
            .output()
            .map_err(|e| format!("spawn git: {e}"))?;
        if !out.status.success() {
            return Err(String::from_utf8_lossy(&out.stderr).trim().to_string());
        }
        Ok(NewRepo {
            root: dest.to_string_lossy().to_string(),
            name: folder,
        })
    })
    .await
}

/// Create a fresh git repository from scratch under `parent_dir/name`.
/// Used by the New Project screen's "Empty" tile. Seeds a README and an
/// initial commit so the repo opens with a real HEAD/branch (the rest of
/// the app assumes a committed history exists).
#[tauri::command]
pub async fn git_init(parent_dir: String, name: String) -> Result<NewRepo, String> {
    crate::blocking::run(move || {
        let folder = name.trim().to_string();
        if folder.is_empty() {
            return Err("Project name is required.".into());
        }
        let parent = PathBuf::from(&parent_dir);
        fs::create_dir_all(&parent).map_err(|e| format!("create {}: {e}", parent.display()))?;
        let dest = parent.join(&folder);
        if dest.exists() && fs::read_dir(&dest).map(|mut d| d.next().is_some()).unwrap_or(false) {
            return Err(format!("{} already exists and is not empty.", dest.display()));
        }
        fs::create_dir_all(&dest).map_err(|e| format!("create {}: {e}", dest.display()))?;

        let run = |args: &[&str]| -> Result<(), String> {
            let out = std::process::Command::new("git")
                .args(args)
                .current_dir(&dest)
                .output()
                .map_err(|e| format!("spawn git: {e}"))?;
            if !out.status.success() {
                return Err(String::from_utf8_lossy(&out.stderr).trim().to_string());
            }
            Ok(())
        };

        run(&["init"])?;
        // -b main isn't universal across git versions; rename after init instead.
        let _ = run(&["symbolic-ref", "HEAD", "refs/heads/main"]);
        let readme = dest.join("README.md");
        fs::write(&readme, format!("# {folder}\n"))
            .map_err(|e| format!("write README: {e}"))?;
        run(&["add", "README.md"])?;
        run(&[
            "-c",
            "commit.gpgsign=false",
            "commit",
            "-m",
            "Initial commit",
        ])?;
        Ok(NewRepo {
            root: dest.to_string_lossy().to_string(),
            name: folder,
        })
    })
    .await
}

/// The starter files for each built-in template, as (relative path, body).
/// Real, deterministic scaffolds — no network — so the "Template" tile on
/// the New Project screen creates a working repo offline.
fn template_files(template: &str, name: &str) -> Result<Vec<(String, String)>, String> {
    let gitignore = "node_modules/\ndist/\nbuild/\ntarget/\n.env\n.env.*\n.DS_Store\n*.log\n".to_string();
    match template {
        "minimal" => Ok(vec![
            ("README.md".into(), format!("# {name}\n\nA new project, started with Aura.\n")),
            (".gitignore".into(), gitignore),
        ]),
        "node-ts" => Ok(vec![
            (
                "package.json".into(),
                format!(
                    "{{\n  \"name\": \"{name}\",\n  \"version\": \"0.1.0\",\n  \"private\": true,\n  \"type\": \"module\",\n  \"scripts\": {{\n    \"build\": \"tsc\",\n    \"start\": \"node dist/index.js\"\n  }},\n  \"devDependencies\": {{\n    \"typescript\": \"^5.4.0\"\n  }}\n}}\n"
                ),
            ),
            (
                "tsconfig.json".into(),
                "{\n  \"compilerOptions\": {\n    \"target\": \"ES2022\",\n    \"module\": \"ES2022\",\n    \"moduleResolution\": \"bundler\",\n    \"outDir\": \"dist\",\n    \"rootDir\": \"src\",\n    \"strict\": true,\n    \"esModuleInterop\": true,\n    \"skipLibCheck\": true\n  },\n  \"include\": [\"src\"]\n}\n".into(),
            ),
            (
                "src/index.ts".into(),
                format!("export function main(): void {{\n  console.log(\"Hello from {name}\");\n}}\n\nmain();\n"),
            ),
            (".gitignore".into(), gitignore),
            (
                "README.md".into(),
                format!("# {name}\n\nNode + TypeScript starter, scaffolded by Aura.\n\n```sh\nnpm install\nnpm run build && npm start\n```\n"),
            ),
        ]),
        other => Err(format!("unknown template: {other}")),
    }
}

/// Create a new project from a built-in template (New Project screen's
/// "Template" tile). Writes the template's files under `parent_dir/name`,
/// then `git init` + initial commit so it opens like any other repo.
#[tauri::command]
pub async fn scaffold_template(
    parent_dir: String,
    name: String,
    template: String,
) -> Result<NewRepo, String> {
    crate::blocking::run(move || {
        let folder = name.trim().to_string();
        if folder.is_empty() {
            return Err("Project name is required.".into());
        }
        let files = template_files(&template, &folder)?;

        let parent = PathBuf::from(&parent_dir);
        fs::create_dir_all(&parent).map_err(|e| format!("create {}: {e}", parent.display()))?;
        let dest = parent.join(&folder);
        if dest.exists() && fs::read_dir(&dest).map(|mut d| d.next().is_some()).unwrap_or(false) {
            return Err(format!("{} already exists and is not empty.", dest.display()));
        }
        fs::create_dir_all(&dest).map_err(|e| format!("create {}: {e}", dest.display()))?;

        for (rel, body) in &files {
            let path = dest.join(rel);
            if let Some(parent) = path.parent() {
                fs::create_dir_all(parent).map_err(|e| format!("create {}: {e}", parent.display()))?;
            }
            fs::write(&path, body).map_err(|e| format!("write {}: {e}", path.display()))?;
        }

        let run = |args: &[&str]| -> Result<(), String> {
            let out = std::process::Command::new("git")
                .args(args)
                .current_dir(&dest)
                .output()
                .map_err(|e| format!("spawn git: {e}"))?;
            if !out.status.success() {
                return Err(String::from_utf8_lossy(&out.stderr).trim().to_string());
            }
            Ok(())
        };
        run(&["init"])?;
        let _ = run(&["symbolic-ref", "HEAD", "refs/heads/main"]);
        run(&["add", "."])?;
        run(&[
            "-c",
            "commit.gpgsign=false",
            "commit",
            "-m",
            "Initial commit",
        ])?;
        Ok(NewRepo {
            root: dest.to_string_lossy().to_string(),
            name: folder,
        })
    })
    .await
}

/// Counts of commits the local branch is ahead/behind its upstream
/// tracking ref. `has_upstream=false` when the branch hasn't been
/// published yet — caller should render "Publish branch" instead of
/// Push/Pull.
///
/// This used to be infallible: it returned the struct directly, and its
/// own doc said "both counts default to zero on any git failure rather
/// than bubbling — the CommitInput polls this on every tick". That
/// sentence is the bug written down. Three unrelated failures all left
/// through the same door:
///
///  * `git` couldn't be spawned at all (not on PATH, sandboxed, the
///    directory gone) → `has_upstream: false`, which every caller reads
///    as "this branch was never published". Four surfaces then offered a
///    **Publish** button, and the one in the repo header ran
///    `git push --set-upstream` on a branch that already had one.
///  * `rev-list` failed or the repo was mid-rebase → `(0, 0)` with
///    `has_upstream: true`, which is byte-for-byte the "in sync with the
///    upstream branch" state. A command that errored rendered as a tick.
///  * A count that wouldn't parse became `0` the same way.
///
/// None of the three could be told from a real answer, because there was
/// no channel to tell them apart in. Now there is: a genuine missing
/// upstream is `Ok(has_upstream: false)`, and anything that stopped us
/// finding out is `Err` — which the TypeScript side surfaces as "couldn't
/// check", never as a verdict about the branch.
#[derive(Serialize)]
pub struct AheadBehind {
    pub ahead: u32,
    pub behind: u32,
    pub has_upstream: bool,
    pub branch: Option<String>,
}

#[tauri::command]
pub async fn git_ahead_behind(repo_root: String) -> Result<AheadBehind, String> {
    crate::blocking::run(move || {
        let cwd = PathBuf::from(&repo_root);
        let branch = current_branch(&cwd);
        // Probe upstream via `rev-parse @{u}` — exits non-zero when
        // none configured. Cheap and definitive.
        //
        // A non-zero exit is the answer "no upstream". A failure to RUN the
        // command is not an answer at all, and the two are different values
        // now instead of the same `false`.
        let probe = std::process::Command::new("git")
            .args(["rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{u}"])
            .current_dir(&cwd)
            .output()
            .map_err(|e| format!("couldn't run git in {}: {e}", cwd.display()))?;
        if !probe.status.success() {
            return Ok(AheadBehind {
                ahead: 0,
                behind: 0,
                has_upstream: false,
                branch,
            });
        }
        let counts = std::process::Command::new("git")
            .args(["rev-list", "--left-right", "--count", "@{u}...HEAD"])
            .current_dir(&cwd)
            .output()
            .map_err(|e| format!("couldn't run git in {}: {e}", cwd.display()))?;
        if !counts.status.success() {
            let why = String::from_utf8_lossy(&counts.stderr);
            let why = why.trim();
            return Err(if why.is_empty() {
                "git couldn't count this branch against its upstream".to_string()
            } else {
                why.lines().next().unwrap_or(why).to_string()
            });
        }
        // There IS an upstream and git answered, so a line we can't read is a
        // broken answer, not a zero. Reporting it as 0/0 is what made "in sync"
        // the resting state of every failure.
        let s = String::from_utf8_lossy(&counts.stdout);
        let mut parts = s.split_whitespace();
        let mut count = |what: &str| -> Result<u32, String> {
            parts
                .next()
                .and_then(|n| n.parse::<u32>().ok())
                .ok_or_else(|| format!("git returned a {what} count we couldn't read: {:?}", s.trim()))
        };
        let behind = count("behind")?;
        let ahead = count("ahead")?;
        Ok(AheadBehind {
            ahead,
            behind,
            has_upstream: true,
            branch,
        })
    })
    .await
}

fn current_branch(cwd: &Path) -> Option<String> {
    let out = std::process::Command::new("git")
        .args(["rev-parse", "--abbrev-ref", "HEAD"])
        .current_dir(cwd)
        .output()
        .ok()?;
    if !out.status.success() {
        return None;
    }
    let raw = String::from_utf8_lossy(&out.stdout).trim().to_string();
    if raw.is_empty() || raw == "HEAD" { None } else { Some(raw) }
}

/// Discard local edits to a tracked file by checking out HEAD's version.
/// No-op for untracked paths (which need `git clean`, intentionally not
/// wired here — too easy to lose work).
#[tauri::command]
pub async fn git_discard(repo_root: String, paths: Vec<String>) -> Result<String, String> {
    crate::blocking::run(move || {
        let cwd = PathBuf::from(&repo_root);
        let mut args = vec!["checkout".to_string(), "--".to_string()];
        args.extend(paths);
        let out = std::process::Command::new("git")
            .args(&args)
            .current_dir(&cwd)
            .output()
            .map_err(|e| e.to_string())?;
        git_output_result(&out)
    })
    .await
}

/// `git show <sha> --stat -p` — formatted patch + filesummary for a
/// single commit. Used by the History sidebar to surface a commit's
/// changes inline. Empty when the sha is unknown or git isn't available.
#[tauri::command]
pub async fn git_show_commit(repo_root: String, sha: String) -> String {
    crate::blocking::run(move || {
        let cwd = PathBuf::from(&repo_root);
        let Ok(out) = std::process::Command::new("git")
            .args(["show", "--no-color", "--stat", "-p", &sha])
            .current_dir(&cwd)
            .output()
        else {
            return String::new();
        };
        if !out.status.success() {
            return String::from_utf8_lossy(&out.stderr).into_owned();
        }
        String::from_utf8_lossy(&out.stdout).into_owned()
    })
    .await
}

/// `git show <sha> --format=format: -- <file>` — the patch a single commit
/// applied to one file, with no commit-message header (the empty `format:`
/// suppresses it). Used by the Trace Changes view to render the real diff of
/// a committed run: once a run lands, `git diff HEAD` reports nothing for the
/// file, but the run's change still lives in its commit. `git show` diffs the
/// commit against its parent — or against the empty tree for a root commit —
/// so it works for the very first commit too. Empty when the sha or path is
/// unknown.
#[tauri::command]
pub async fn git_diff_at_commit(
    repo_root: String,
    sha: String,
    file: String,
) -> Result<String, String> {
    crate::blocking::run(move || {
        let cwd = PathBuf::from(&repo_root);
        let p = PathBuf::from(&file);
        let rel = p.strip_prefix(&cwd).unwrap_or(&p);
        let out = std::process::Command::new("git")
            .args(["show", &sha, "--no-color", "--format=format:", "--"])
            .arg(rel)
            .current_dir(&cwd)
            .output()
            .map_err(|e| e.to_string())?;
        if !out.status.success() {
            return Ok(String::new());
        }
        Ok(String::from_utf8_lossy(&out.stdout).into_owned())
    })
    .await
}

/// Render one file's NET change from a baseline commit to its current
/// working-tree state — `git diff <base> --no-color -- <path>`. This is the
/// native-Aura-chat path: such a session never lands its own commit, it edits
/// the working tree and stamps a per-turn `tree_commit` baseline, so the only
/// honest "what this session changed" is the two-dot diff from that baseline to
/// now. Unlike `git_diff_at_commit` (which shows the patch a commit
/// *introduced*), this shows the difference *between* the baseline and the
/// live tree, so it stays correct whether the edits are still uncommitted OR
/// were later committed (a commit doesn't move the working tree). A file the
/// session newly created is untracked relative to the baseline and invisible to
/// plain `git diff`, so we fall back to the same whole-file add-diff synthesis
/// `git_diff` uses. Empty string (never an error) on any git failure so the
/// Changes pane degrades to "no diff" rather than blowing up.
#[tauri::command]
pub async fn git_diff_base(
    repo_root: String,
    base: String,
    file: String,
) -> Result<String, String> {
    crate::blocking::run(move || {
        let cwd = PathBuf::from(&repo_root);
        let p = PathBuf::from(&file);
        let rel = p.strip_prefix(&cwd).unwrap_or(&p);
        let out = std::process::Command::new("git")
            .args(["diff", &base, "--no-color", "--"])
            .arg(rel)
            .current_dir(&cwd)
            .output()
            .map_err(|e| e.to_string())?;
        if out.status.success() {
            let body = String::from_utf8_lossy(&out.stdout).into_owned();
            if !body.trim().is_empty() {
                return Ok(body);
            }
        }
        // Brand-new file the session created — show its full contents as an add.
        if git_is_untracked(&cwd, rel) {
            let added = std::process::Command::new("git")
                .args(["diff", "--no-color", "--no-index", "--", "/dev/null"])
                .arg(rel)
                .current_dir(&cwd)
                .output()
                .map_err(|e| e.to_string())?;
            if matches!(added.status.code(), Some(0) | Some(1)) {
                return Ok(String::from_utf8_lossy(&added.stdout).into_owned());
            }
        }
        Ok(String::new())
    })
    .await
}

/// Per-file stats for one commit — the "Files changed" list in the History
/// detail. `status` is the single-letter change (`A` added, `M` modified,
/// `D` deleted, `R` renamed); `added`/`deleted` are line counts. A binary
/// file's numstat is `- -`, surfaced here as `-1` so the UI can show "binary"
/// instead of a misleading "0 / 0".
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GitCommitFileStat {
    pub path: String,
    pub status: String,
    pub added: i64,
    pub deleted: i64,
}

/// `git show --numstat --name-status <sha>` parsed into per-file rows. One git
/// call carries both the change kind (name-status) and the line counts
/// (numstat); we zip them by path so each file row is complete. Empty vec for
/// an unknown sha or a non-repo. A rename's name-status line is
/// `R<score>\t<old>\t<new>` — we key the row on the new path so it lines up
/// with the numstat row.
#[tauri::command]
pub async fn git_commit_file_stats(repo_root: String, sha: String) -> Vec<GitCommitFileStat> {
    crate::blocking::run(move || {
        let cwd = PathBuf::from(&repo_root);
        let Ok(out) = std::process::Command::new("git")
            .args([
                "show",
                "--no-color",
                "--format=format:",
                "--numstat",
                "--name-status",
                &sha,
            ])
            .current_dir(&cwd)
            .output()
        else {
            return Vec::new();
        };
        if !out.status.success() {
            return Vec::new();
        }
        let text = String::from_utf8_lossy(&out.stdout);

        // numstat lines: `<added>\t<deleted>\t<path>` (binary: `-\t-\t<path>`).
        // name-status lines: `<STATUS>\t<path>` (rename: `R<score>\t<old>\t<new>`).
        // The two blocks are concatenated with `--numstat --name-status`, so a line
        // is numstat when its first column parses as a count (or is the binary `-`)
        // AND it has 3 tab-fields; everything else is a name-status line. We key
        // both on the final path so they merge.
        let mut status_by_path: HashMap<String, String> = HashMap::new();
        let mut stats: Vec<GitCommitFileStat> = Vec::new();
        let mut seen: HashMap<String, usize> = HashMap::new();

        for line in text.lines() {
            if line.trim().is_empty() {
                continue;
            }
            let cols: Vec<&str> = line.split('\t').collect();
            // numstat row: 3 columns, first two are counts (or `-` for binary).
            let is_numstat = cols.len() == 3
                && (cols[0] == "-" || cols[0].chars().all(|c| c.is_ascii_digit()))
                && (cols[1] == "-" || cols[1].chars().all(|c| c.is_ascii_digit()));
            if is_numstat {
                let added = if cols[0] == "-" { -1 } else { cols[0].parse().unwrap_or(0) };
                let deleted = if cols[1] == "-" { -1 } else { cols[1].parse().unwrap_or(0) };
                let path = cols[2].to_string();
                let idx = stats.len();
                seen.insert(path.clone(), idx);
                stats.push(GitCommitFileStat {
                    path,
                    status: "M".to_string(),
                    added,
                    deleted,
                });
            } else {
                // name-status row. Rename/copy carries old + new; key on the new.
                let status = cols.first().copied().unwrap_or("M");
                let letter = status.chars().next().unwrap_or('M').to_string();
                let path = cols.last().copied().unwrap_or("").to_string();
                if !path.is_empty() {
                    status_by_path.insert(path, letter);
                }
            }
        }

        // Fold statuses onto the numstat rows by path; a name-status-only file
        // (rare with both flags) is appended so nothing is dropped.
        for (path, status) in &status_by_path {
            if let Some(&idx) = seen.get(path) {
                stats[idx].status = status.clone();
            } else {
                stats.push(GitCommitFileStat {
                    path: path.clone(),
                    status: status.clone(),
                    added: 0,
                    deleted: 0,
                });
            }
        }

        stats
    })
    .await
}

/// Two-letter porcelain status per path. `index` is the staged side
/// (commit-bound), `worktree` the unstaged side. Untracked files come
/// back as `("?", "?")`. The frontend uses this to render staged vs
/// unstaged sections in the Source Control sidebar.
#[derive(Serialize)]
pub struct StatusEntry {
    pub path: String,
    pub index: String,
    pub worktree: String,
}

#[tauri::command]
pub async fn git_status_v2(repo_root: String) -> Vec<StatusEntry> {
    crate::blocking::run(move || {
        let cwd = PathBuf::from(&repo_root);
        let Ok(out) = std::process::Command::new("git")
            .args(["status", "--porcelain=v1", "-z"])
            .current_dir(&cwd)
            .output()
        else {
            return Vec::new();
        };
        if !out.status.success() {
            return Vec::new();
        }
        let text = String::from_utf8_lossy(&out.stdout);
        let mut entries = Vec::new();
        for chunk in text.split('\0') {
            if chunk.len() < 4 {
                continue;
            }
            let bytes = chunk.as_bytes();
            let x = bytes[0] as char;
            let y = bytes[1] as char;
            let path_part = &chunk[3..];
            let rel = if let Some(idx) = path_part.find(" -> ") {
                &path_part[idx + 4..]
            } else {
                path_part
            };
            entries.push(StatusEntry {
                path: rel.to_string(),
                index: if x == ' ' { String::new() } else { x.to_string() },
                worktree: if y == ' ' { String::new() } else { y.to_string() },
            });
        }
        entries
    })
    .await
}

fn git_simple(repo_root: &str, sub: &str, paths: &[String]) -> Result<String, String> {
    let cwd = PathBuf::from(repo_root);
    let mut args = vec![sub.to_string()];
    args.extend(paths.iter().cloned());
    let out = std::process::Command::new("git")
        .args(&args)
        .current_dir(&cwd)
        .output()
        .map_err(|e| e.to_string())?;
    git_output_result(&out)
}

/// Turn a finished `git` invocation into a `Result` the React side can act
/// on: `Ok(stdout)` when git exited 0, `Err(stderr)` otherwise. Previously
/// every mutating git command (`stage`/`unstage`/`discard`) returned
/// `Ok(stderr)` on failure too, so the UI reported success for a stage that
/// didn't stage or — worse — a "Discard" that left the edit in place. Fall
/// back to stdout (or a generic line) when a failing git writes nothing to
/// stderr, so the error is never an empty string the UI would render blank.
fn git_output_result(out: &std::process::Output) -> Result<String, String> {
    if out.status.success() {
        Ok(String::from_utf8_lossy(&out.stdout).trim().to_string())
    } else {
        let msg = String::from_utf8_lossy(&out.stderr).trim().to_string();
        let msg = if msg.is_empty() {
            let stdout = String::from_utf8_lossy(&out.stdout).trim().to_string();
            if stdout.is_empty() {
                format!("git exited with status {}", out.status)
            } else {
                stdout
            }
        } else {
            msg
        };
        Err(msg)
    }
}

// ── helpers ────────────────────────────────────────────────────────────────

fn git_status_map(cwd: &Path) -> HashMap<PathBuf, char> {
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
    let root = cwd.canonicalize().unwrap_or_else(|_| cwd.to_path_buf());
    for line in text.lines() {
        if line.len() < 4 {
            continue;
        }
        let bytes = line.as_bytes();
        let x = bytes[0] as char;
        let y = bytes[1] as char;
        let path_part = &line[3..];
        if path_part.starts_with('"') {
            continue;
        }
        let rel = if let Some(idx) = path_part.find(" -> ") {
            &path_part[idx + 4..]
        } else {
            path_part
        };
        let full = root.join(rel);
        // Order matters. A conflict has to be recognised BEFORE the A/D
        // ladder, because git spells several of its unmerged states with the
        // very letters that ladder is looking for. `AA` (both added) and `DD`
        // (both deleted) are conflicts, not an add and a delete, and `UU`
        // (both modified) used to fall past every arm into the `else` and
        // come out as an ordinary modified file — so a file with conflict
        // markers sitting in it looked exactly like one you had just edited.
        //
        // The unmerged set, in full, is: DD AU UD UA DU AA UU — which is
        // "either side is U, or both sides carry the same letter".
        let unmerged = x == 'U' || y == 'U' || (x == 'A' && y == 'A') || (x == 'D' && y == 'D');
        let ch = if x == '?' || y == '?' {
            '?'
        } else if unmerged {
            'U'
        } else if x == 'R' || y == 'R' {
            // A rename reported as "modified" sends you looking for an edit
            // that was never made.
            'R'
        } else if x == 'A' || y == 'A' {
            'A'
        } else if x == 'D' || y == 'D' {
            'D'
        } else {
            'M'
        };
        map.insert(full, ch);
    }
    map
}

fn language_for(path: &Path) -> String {
    let ext = path
        .extension()
        .and_then(|s| s.to_str())
        .unwrap_or("")
        .to_ascii_lowercase();
    match ext.as_str() {
        "rs" => "rust",
        "toml" => "toml",
        "md" | "mdx" => "markdown",
        "json" | "jsonc" => "json",
        "yml" | "yaml" => "yaml",
        "ts" | "tsx" => "typescript",
        "js" | "jsx" | "mjs" | "cjs" => "javascript",
        "py" => "python",
        "go" => "go",
        "sh" | "bash" | "zsh" | "fish" => "shell",
        "html" | "htm" => "html",
        "css" | "scss" | "sass" => "css",
        _ => "plaintext",
    }
    .to_string()
}
