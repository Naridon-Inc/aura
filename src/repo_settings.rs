//! Per-repo worktree settings — the typed, round-trip-preserving view of
//! `<repo_root>/.aura/settings.toml`.
//!
//! This is the engine half of the "warmed copy can land ready" story. On top of
//! the lifecycle scripts (`[worktree] setup/run/archive`, see
//! [`crate::worktree_scripts`]) two more knobs the team defines once and every
//! worktree inherits:
//!
//! ```toml
//! [worktree]
//! setup   = "npm install"
//! run     = "npm run dev"
//! archive = "docker compose down"
//!
//! [git]
//! base = "main"            # new worktrees branch off this when --from is absent
//!
//! [copy]
//! files = [".env", ".env.local", ".env*"]   # copied into each fresh worktree
//! ```
//!
//! The `[copy]` table closes the #1 "the warmed copy can't run because `.env` is
//! missing" gap: a fresh `git worktree` carries the *tracked* source but not the
//! untracked, git-ignored secrets a project needs to actually run. We copy those
//! listed files from the repo root into the new worktree, best-effort — a missing
//! entry is a no-op (the file is optional), never an error.
//!
//! The `[git] base` knob lets a team pin the default start-point (e.g. `main`)
//! so a worktree opened from a feature branch still branches off the trunk
//! unless the caller explicitly overrides with `--from`.
//!
//! ## Round-trip preservation
//!
//! [`save`] writes through `toml_edit` so unrelated tables, keys, comments and
//! formatting already in the file survive untouched — only the keys this module
//! owns are inserted/updated. A human's hand-written `# notes` and any future
//! `[editor]`/`[build]` tables are never clobbered.

use std::path::{Path, PathBuf};

/// The settings this module owns inside `.aura/settings.toml`. Every field is
/// optional; a project that defines none gets exactly today's bare behaviour.
#[derive(Debug, Default, Clone, PartialEq)]
pub struct RepoSettings {
    /// `[worktree] setup` — run once right after a worktree is created.
    pub setup: Option<String>,
    /// `[worktree] run` — the dev/run command, surfaced as `aura work run <name>`.
    pub run: Option<String>,
    /// `[worktree] archive` — run once right before teardown.
    pub archive: Option<String>,
    /// `[git] base` — branch new worktrees are created from when `--from` is absent.
    pub base: Option<String>,
    /// `[copy] files` — repo-root-relative paths (or simple `*` globs) copied
    /// into each fresh worktree.
    pub copy_files: Vec<String>,
}

impl RepoSettings {
    /// True when nothing is configured — the bare-worktree case.
    pub fn is_empty(&self) -> bool {
        self.setup.is_none()
            && self.run.is_none()
            && self.archive.is_none()
            && self.base.is_none()
            && self.copy_files.is_empty()
    }
}

/// Path to a repo's settings file: `<repo_root>/.aura/settings.toml`.
fn settings_path(repo_root: &Path) -> PathBuf {
    repo_root.join(".aura").join("settings.toml")
}

/// Read `<repo_root>/.aura/settings.toml` into a typed [`RepoSettings`]. A
/// missing file, missing tables, or any parse hiccup degrade to defaults — the
/// recipe is a convenience, never required.
pub fn load(repo_root: &Path) -> RepoSettings {
    let path = settings_path(repo_root);
    match std::fs::read_to_string(&path) {
        Ok(text) => parse(&text),
        Err(_) => RepoSettings::default(),
    }
}

/// Write `settings` back to `<repo_root>/.aura/settings.toml`, creating `.aura/`
/// if needed and PRESERVING any unrelated tables/keys/comments already present.
/// Only the keys this module owns (`[worktree] setup/run/archive`, `[git] base`,
/// `[copy] files`) are inserted/updated/removed.
pub fn save(repo_root: &Path, settings: &RepoSettings) -> std::io::Result<()> {
    let path = settings_path(repo_root);
    let existing = std::fs::read_to_string(&path).unwrap_or_default();
    let rendered = render(&existing, settings)
        .map_err(|e| std::io::Error::new(std::io::ErrorKind::InvalidData, e))?;
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)?;
    }
    std::fs::write(&path, rendered)
}

/// Copy the project's `[copy] files` from the repo root into a freshly created
/// worktree. Best-effort per file:
///   - a listed file that doesn't exist is skipped silently (it's optional);
///   - parent directories inside the worktree are created as needed;
///   - simple `*` globs (e.g. `.env*`) are expanded against the repo root;
///   - a copy that fails for any reason never aborts the others, and this
///     function never returns an error — a missing/failed copy must NEVER block
///     worktree creation.
///
/// Returns the count of files actually copied (useful for a progress line).
pub fn copy_files_into(repo_root: &Path, worktree: &Path, settings: &RepoSettings) -> usize {
    let mut copied = 0usize;
    for entry in &settings.copy_files {
        let entry = entry.trim();
        if entry.is_empty() {
            continue;
        }
        for rel in expand_entry(repo_root, entry) {
            if copy_one(repo_root, worktree, &rel) {
                copied += 1;
            }
        }
    }
    copied
}

/// Resolve one `[copy]` entry to the concrete repo-root-relative paths it names.
/// A plain path resolves to itself (whether or not it exists — the copy step
/// skips missing ones); an entry containing `*` is glob-expanded against the
/// repo root, returning only the paths that actually matched.
fn expand_entry(repo_root: &Path, entry: &str) -> Vec<String> {
    if !entry.contains('*') {
        return vec![entry.to_string()];
    }
    // Simple glob: split into a directory part (no wildcards) and a final
    // single-segment pattern, then match entries in that directory. This covers
    // the common `.env*`, `*.local`, `config/*.local` shapes without pulling in
    // a glob crate.
    let normalized = entry.replace('\\', "/");
    let (dir_part, pat) = match normalized.rsplit_once('/') {
        Some((d, p)) => (d.to_string(), p.to_string()),
        None => (String::new(), normalized.clone()),
    };
    let scan_dir = if dir_part.is_empty() {
        repo_root.to_path_buf()
    } else {
        repo_root.join(&dir_part)
    };
    let mut out = Vec::new();
    let Ok(read) = std::fs::read_dir(&scan_dir) else {
        return out;
    };
    for ent in read.flatten() {
        let name = ent.file_name();
        let name = name.to_string_lossy();
        if glob_match(&pat, &name) {
            let rel = if dir_part.is_empty() {
                name.to_string()
            } else {
                format!("{dir_part}/{name}")
            };
            out.push(rel);
        }
    }
    out
}

/// PURE: match a single path segment against a `*`-glob pattern (`*` matches any
/// run of characters, including empty). No `?`/`[…]` — just the `*` the copy
/// feature documents.
fn glob_match(pattern: &str, name: &str) -> bool {
    // Classic two-pointer wildcard match with backtracking on the last `*`.
    let p: Vec<char> = pattern.chars().collect();
    let n: Vec<char> = name.chars().collect();
    let (mut pi, mut ni) = (0usize, 0usize);
    let (mut star, mut mark) = (None, 0usize);
    while ni < n.len() {
        if pi < p.len() && (p[pi] == n[ni]) {
            pi += 1;
            ni += 1;
        } else if pi < p.len() && p[pi] == '*' {
            star = Some(pi);
            mark = ni;
            pi += 1;
        } else if let Some(s) = star {
            pi = s + 1;
            mark += 1;
            ni = mark;
        } else {
            return false;
        }
    }
    while pi < p.len() && p[pi] == '*' {
        pi += 1;
    }
    pi == p.len()
}

/// Copy a single repo-root-relative file into the worktree at the same relative
/// path. Returns `true` only if a file was actually copied. A source that's
/// missing, a directory, or unreadable is skipped (returns `false`) — never an
/// error.
fn copy_one(repo_root: &Path, worktree: &Path, rel: &str) -> bool {
    // Refuse absolute or parent-escaping paths — a copy entry names something
    // *inside* the repo root, never `/etc/passwd` or `../secrets`.
    let rel_path = Path::new(rel);
    if rel_path.is_absolute()
        || rel_path
            .components()
            .any(|c| matches!(c, std::path::Component::ParentDir))
    {
        return false;
    }
    let src = repo_root.join(rel_path);
    if !src.is_file() {
        return false;
    }
    let dst = worktree.join(rel_path);
    if let Some(parent) = dst.parent() {
        if std::fs::create_dir_all(parent).is_err() {
            return false;
        }
    }
    std::fs::copy(&src, &dst).is_ok()
}

// ─── parse / render (round-trip preserving) ─────────────────────────────────--

/// PURE: parse the TOML text into a typed [`RepoSettings`]. Unknown tables/keys
/// are ignored. A parse error yields defaults (the file is advisory).
fn parse(text: &str) -> RepoSettings {
    let doc: toml_edit::DocumentMut = match text.parse() {
        Ok(d) => d,
        Err(_) => return RepoSettings::default(),
    };
    let mut s = RepoSettings::default();

    let str_at = |table: &str, key: &str| -> Option<String> {
        doc.get(table)
            .and_then(|t| t.as_table())
            .and_then(|t| t.get(key))
            .and_then(|v| v.as_str())
            .map(|s| s.trim().to_string())
            .filter(|s| !s.is_empty())
    };

    s.setup = str_at("worktree", "setup");
    s.run = str_at("worktree", "run");
    s.archive = str_at("worktree", "archive");
    s.base = str_at("git", "base");

    if let Some(arr) = doc
        .get("copy")
        .and_then(|t| t.as_table())
        .and_then(|t| t.get("files"))
        .and_then(|v| v.as_array())
    {
        for item in arr.iter() {
            if let Some(p) = item.as_str() {
                let p = p.trim();
                if !p.is_empty() {
                    s.copy_files.push(p.to_string());
                }
            }
        }
    }

    s
}

/// PURE: render `settings` into TOML, starting from `existing` so unrelated
/// tables/keys/comments survive. Only this module's keys are inserted/updated;
/// a `None`/empty value removes the corresponding key (and prunes a table that
/// becomes empty as a result).
fn render(existing: &str, settings: &RepoSettings) -> Result<String, String> {
    let mut doc: toml_edit::DocumentMut =
        existing.parse().map_err(|e| format!("settings.toml is not valid TOML: {e}"))?;

    set_or_clear_str(&mut doc, "worktree", "setup", settings.setup.as_deref());
    set_or_clear_str(&mut doc, "worktree", "run", settings.run.as_deref());
    set_or_clear_str(&mut doc, "worktree", "archive", settings.archive.as_deref());
    set_or_clear_str(&mut doc, "git", "base", settings.base.as_deref());

    // [copy] files = [...] — set when non-empty, otherwise clear the key.
    if settings.copy_files.is_empty() {
        clear_key(&mut doc, "copy", "files");
    } else {
        let table = ensure_table(&mut doc, "copy");
        let mut arr = toml_edit::Array::new();
        for f in &settings.copy_files {
            arr.push(f.as_str());
        }
        table["files"] = toml_edit::value(arr);
    }

    prune_empty_owned_tables(&mut doc);
    Ok(doc.to_string())
}

/// Ensure `[table]` exists as a real (non-inline) table and return it.
fn ensure_table<'a>(doc: &'a mut toml_edit::DocumentMut, table: &str) -> &'a mut toml_edit::Table {
    if doc.get(table).and_then(|t| t.as_table()).is_none() {
        doc[table] = toml_edit::Item::Table(toml_edit::Table::new());
    }
    doc[table].as_table_mut().expect("just ensured table")
}

/// Set `[table] key = "val"` when `val` is `Some`/non-empty, else remove the key.
fn set_or_clear_str(doc: &mut toml_edit::DocumentMut, table: &str, key: &str, val: Option<&str>) {
    match val.map(str::trim).filter(|v| !v.is_empty()) {
        Some(v) => {
            let t = ensure_table(doc, table);
            t[key] = toml_edit::value(v);
        }
        None => clear_key(doc, table, key),
    }
}

/// Remove `[table] key` if present; leaves the table (pruned later if empty).
fn clear_key(doc: &mut toml_edit::DocumentMut, table: &str, key: &str) {
    if let Some(t) = doc.get_mut(table).and_then(|t| t.as_table_mut()) {
        t.remove(key);
    }
}

/// Drop any of OUR tables (`worktree`/`git`/`copy`) that we emptied out, so
/// clearing the last key doesn't leave a dangling `[copy]` header behind. Tables
/// we don't own are never touched, even if empty.
fn prune_empty_owned_tables(doc: &mut toml_edit::DocumentMut) {
    for table in ["worktree", "git", "copy"] {
        let empty = doc
            .get(table)
            .and_then(|t| t.as_table())
            .map(|t| t.is_empty())
            .unwrap_or(false);
        if empty {
            doc.remove(table);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;
    use tempfile::TempDir;

    fn write_settings(dir: &Path, body: &str) {
        let aura = dir.join(".aura");
        fs::create_dir_all(&aura).unwrap();
        fs::write(aura.join("settings.toml"), body).unwrap();
    }

    // ── parse ──────────────────────────────────────────────────────────────

    #[test]
    fn parse_empty_is_default() {
        assert!(parse("").is_empty());
        assert!(parse("[other]\nx = 1\n").is_empty());
    }

    #[test]
    fn parse_reads_all_sections() {
        let doc = r#"
            [worktree]
            setup = "npm install"
            run = "npm run dev"
            archive = "docker compose down"

            [git]
            base = "main"

            [copy]
            files = [".env", ".env.local"]
        "#;
        let s = parse(doc);
        assert_eq!(s.setup.as_deref(), Some("npm install"));
        assert_eq!(s.run.as_deref(), Some("npm run dev"));
        assert_eq!(s.archive.as_deref(), Some("docker compose down"));
        assert_eq!(s.base.as_deref(), Some("main"));
        assert_eq!(s.copy_files, vec![".env".to_string(), ".env.local".to_string()]);
    }

    /// The `[git] base` key is parsed and returned (contract for capability 2).
    #[test]
    fn parse_returns_base_branch() {
        let s = parse("[git]\nbase = \"develop\"\n");
        assert_eq!(s.base.as_deref(), Some("develop"));
    }

    #[test]
    fn parse_empty_copy_files_skipped() {
        let s = parse("[copy]\nfiles = [\".env\", \"\", \"  \"]\n");
        assert_eq!(s.copy_files, vec![".env".to_string()]);
    }

    // ── round-trip / preservation ───────────────────────────────────────────

    #[test]
    fn render_preserves_unrelated_tables_and_comments() {
        let existing = r#"# top-of-file note
[editor]
theme = "dark"   # keep me

[worktree]
setup = "OLD"
"#;
        let mut s = parse(existing);
        s.setup = Some("npm ci".to_string());
        s.base = Some("main".to_string());
        let out = render(existing, &s).unwrap();
        // Unrelated table + comments survive.
        assert!(out.contains("# top-of-file note"));
        assert!(out.contains("[editor]"));
        assert!(out.contains("theme = \"dark\""));
        assert!(out.contains("# keep me"));
        // Our key was updated, new [git] table added.
        assert!(out.contains("setup = \"npm ci\""));
        assert!(!out.contains("OLD"));
        assert!(out.contains("[git]"));
        assert!(out.contains("base = \"main\""));
        // And it re-parses to the same logical settings.
        assert_eq!(parse(&out), s);
    }

    #[test]
    fn render_clearing_last_key_prunes_owned_table_only() {
        let existing = "[worktree]\nsetup = \"x\"\n[editor]\ntheme=\"dark\"\n";
        let mut s = parse(existing);
        s.setup = None; // clears the only worktree key
        let out = render(existing, &s).unwrap();
        assert!(!out.contains("[worktree]"));
        // Foreign empty-ish table is left alone.
        assert!(out.contains("[editor]"));
    }

    #[test]
    fn render_round_trips_through_load_save() {
        let dir = TempDir::new().unwrap();
        let mut s = RepoSettings::default();
        s.run = Some("make dev".to_string());
        s.base = Some("trunk".to_string());
        s.copy_files = vec![".env".to_string(), "config/secrets.toml".to_string()];
        save(dir.path(), &s).unwrap();
        let back = load(dir.path());
        assert_eq!(back, s);
    }

    #[test]
    fn save_creates_aura_dir_when_absent() {
        let dir = TempDir::new().unwrap();
        // No .aura/ yet.
        assert!(!dir.path().join(".aura").exists());
        let mut s = RepoSettings::default();
        s.base = Some("main".to_string());
        save(dir.path(), &s).unwrap();
        assert!(dir.path().join(".aura").join("settings.toml").is_file());
        assert_eq!(load(dir.path()).base.as_deref(), Some("main"));
    }

    // ── copy files ──────────────────────────────────────────────────────────

    /// A `.env` at the repo root lands in a created worktree; a listed-but-
    /// missing entry is skipped without error. (Contract for capability 1.)
    #[test]
    fn copy_lands_present_file_skips_missing() {
        let repo = TempDir::new().unwrap();
        let wt = TempDir::new().unwrap();
        fs::write(repo.path().join(".env"), "SECRET=1").unwrap();
        let s = RepoSettings {
            copy_files: vec![".env".to_string(), ".env.local".to_string()],
            ..Default::default()
        };
        let n = copy_files_into(repo.path(), wt.path(), &s);
        assert_eq!(n, 1, "only the present .env should copy");
        let landed = wt.path().join(".env");
        assert!(landed.is_file());
        assert_eq!(fs::read_to_string(landed).unwrap(), "SECRET=1");
        // The missing one was skipped silently — no file, no panic.
        assert!(!wt.path().join(".env.local").exists());
    }

    #[test]
    fn copy_creates_parent_dirs() {
        let repo = TempDir::new().unwrap();
        let wt = TempDir::new().unwrap();
        fs::create_dir_all(repo.path().join("config")).unwrap();
        fs::write(repo.path().join("config/local.toml"), "k = 1").unwrap();
        let s = RepoSettings {
            copy_files: vec!["config/local.toml".to_string()],
            ..Default::default()
        };
        let n = copy_files_into(repo.path(), wt.path(), &s);
        assert_eq!(n, 1);
        assert!(wt.path().join("config/local.toml").is_file());
    }

    #[test]
    fn copy_expands_simple_glob() {
        let repo = TempDir::new().unwrap();
        let wt = TempDir::new().unwrap();
        fs::write(repo.path().join(".env"), "A=1").unwrap();
        fs::write(repo.path().join(".env.local"), "B=2").unwrap();
        fs::write(repo.path().join(".envrc"), "C=3").unwrap();
        fs::write(repo.path().join("other.txt"), "no").unwrap();
        let s = RepoSettings {
            copy_files: vec![".env*".to_string()],
            ..Default::default()
        };
        let n = copy_files_into(repo.path(), wt.path(), &s);
        assert_eq!(n, 3, ".env, .env.local, .envrc all match .env*");
        assert!(wt.path().join(".env").is_file());
        assert!(wt.path().join(".env.local").is_file());
        assert!(wt.path().join(".envrc").is_file());
        assert!(!wt.path().join("other.txt").exists());
    }

    #[test]
    fn copy_glob_no_matches_is_noop() {
        let repo = TempDir::new().unwrap();
        let wt = TempDir::new().unwrap();
        let s = RepoSettings {
            copy_files: vec!["nope*".to_string()],
            ..Default::default()
        };
        assert_eq!(copy_files_into(repo.path(), wt.path(), &s), 0);
    }

    #[test]
    fn copy_refuses_path_escape() {
        let repo = TempDir::new().unwrap();
        let wt = TempDir::new().unwrap();
        // A parent-escaping entry must never copy anything outside the repo.
        let s = RepoSettings {
            copy_files: vec!["../outside.env".to_string(), "/etc/hosts".to_string()],
            ..Default::default()
        };
        assert_eq!(copy_files_into(repo.path(), wt.path(), &s), 0);
    }

    #[test]
    fn copy_empty_settings_copies_nothing() {
        let repo = TempDir::new().unwrap();
        let wt = TempDir::new().unwrap();
        write_settings(repo.path(), "[worktree]\nsetup = \"x\"\n");
        let s = load(repo.path());
        assert_eq!(copy_files_into(repo.path(), wt.path(), &s), 0);
    }

    // ── glob_match unit ─────────────────────────────────────────────────────

    #[test]
    fn glob_match_basics() {
        assert!(glob_match(".env*", ".env"));
        assert!(glob_match(".env*", ".env.local"));
        assert!(glob_match("*.local", ".env.local"));
        assert!(glob_match("*", "anything"));
        assert!(glob_match("a*c", "abbbc"));
        assert!(!glob_match(".env*", "other"));
        assert!(!glob_match("a*c", "abbb"));
    }
}
