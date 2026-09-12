//! Per-repo worktree settings — the desktop IPC surface over a repo's
//! `<repo_root>/.aura/settings.toml`.
//!
//! These two commands let the Settings UI read and edit the same git-tracked
//! file the `aura` CLI's worktree engine (`aura-cli/src/repo_settings.rs`)
//! consumes when it creates a worktree:
//!
//! ```toml
//! [worktree]
//! setup   = "npm install"
//! run     = "npm run dev"
//! archive = "docker compose down"
//!
//! [scripts]
//! dev = "npm run dev"
//! test = "npm test"
//!
//! [git]
//! base = "main"            # default start-point for new worktrees
//!
//! [copy]
//! files = [".env", ".env.local"]   # copied into each fresh worktree
//! ```
//!
//! The shell does not depend on the (workspace-excluded) `aura` CLI crate, so it
//! re-implements the small parse/render here against the identical on-disk
//! format. Writes go through `toml_edit`, so unrelated tables, keys, comments
//! and formatting a human left in the file survive untouched — only the keys
//! this surface owns are inserted/updated/removed.

use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};

/// The worktree settings the UI edits. Field names match the frontend contract
/// exactly (camelCase via serde): `setup`/`run`/`archive`/`base`/`copyFiles`.
/// Every field is optional; defaults mean "nothing configured".
#[derive(Serialize, Deserialize, Clone, Default)]
#[serde(rename_all = "camelCase")]
pub struct RepoWorktreeSettings {
    pub setup: Option<String>,
    pub run: Option<String>,
    pub archive: Option<String>,
    /// `[git] base` — branch new worktrees are created from by default.
    pub base: Option<String>,
    /// `[copy] files` — repo-root-relative paths (or simple globs) copied into
    /// each fresh worktree. Serializes as `copyFiles`.
    pub copy_files: Vec<String>,
    /// Additional one-click commands shown by the Run control. Stored under
    /// `[scripts]` without changing the CLI's legacy setup/run contract.
    #[serde(default)]
    pub named_scripts: Vec<NamedScript>,
    /// `[copy] include_binaries` — copy binary-looking files too (off by
    /// default). Serializes as `copyFilesIncludeBinaries`.
    #[serde(default)]
    pub copy_files_include_binaries: bool,
    /// `[instructions] review` — how the agent should review this repo.
    #[serde(default)]
    pub review_instructions: Option<String>,
    /// `[instructions] pr` — how pull requests are written here.
    #[serde(default)]
    pub pr_instructions: Option<String>,
    /// `[instructions] conflicts` — how merge conflicts get resolved here.
    #[serde(default)]
    pub conflict_instructions: Option<String>,
    /// `[github] host` — GitHub Enterprise hostname handed to `gh` as
    /// `GH_HOST` for this repo. None means github.com.
    #[serde(default)]
    pub gh_host: Option<String>,
}

/// The `[github] host` of a repo, for callers that shell out to `gh` and need
/// to point it at a GitHub Enterprise instance. Cheap: one small TOML read.
pub fn gh_host_for(repo_root: &str) -> Option<String> {
    let text = std::fs::read_to_string(settings_path(Path::new(repo_root))).ok()?;
    parse(&text).gh_host
}

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct NamedScript {
    pub name: String,
    pub command: String,
}

/// Read the repo's worktree settings. Returns defaults (all `None` / empty vec)
/// when the file or the relevant sections are absent or unparseable — the recipe
/// is advisory, never required.
#[tauri::command]
pub async fn repo_worktree_settings_get(repo_root: String) -> Result<RepoWorktreeSettings, String> {
    crate::blocking::run(move || {
        let path = settings_path(Path::new(&repo_root));
        let text = std::fs::read_to_string(&path).unwrap_or_default();
        Ok(parse(&text))
    })
    .await
}

/// Write the repo's worktree settings to `<repo_root>/.aura/settings.toml`,
/// creating `.aura/` if needed and preserving any unrelated tables/keys/comments
/// already present. Only `[worktree] setup/run/archive`, `[git] base` and
/// `[copy] files` are touched.
#[tauri::command]
pub async fn repo_worktree_settings_set(
    repo_root: String,
    settings: RepoWorktreeSettings,
) -> Result<(), String> {
    crate::blocking::run(move || {
        let path = settings_path(Path::new(&repo_root));
        let existing = std::fs::read_to_string(&path).unwrap_or_default();
        let rendered = render(&existing, &settings)?;
        if let Some(parent) = path.parent() {
            std::fs::create_dir_all(parent)
                .map_err(|e| format!("couldn't create {}: {e}", parent.display()))?;
        }
        std::fs::write(&path, rendered).map_err(|e| format!("couldn't write {}: {e}", path.display()))
    })
    .await
}

// ─── internals ──────────────────────────────────────────────────────────────-

fn settings_path(repo_root: &Path) -> PathBuf {
    repo_root.join(".aura").join("settings.toml")
}

/// PURE: parse the on-disk TOML into the typed settings, ignoring unknown
/// tables/keys. A parse error yields defaults (the file is advisory).
fn parse(text: &str) -> RepoWorktreeSettings {
    let doc: toml_edit::DocumentMut = match text.parse() {
        Ok(d) => d,
        Err(_) => return RepoWorktreeSettings::default(),
    };
    let mut s = RepoWorktreeSettings::default();

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
    s.review_instructions = str_at("instructions", "review");
    s.pr_instructions = str_at("instructions", "pr");
    s.conflict_instructions = str_at("instructions", "conflicts");
    s.gh_host = str_at("github", "host");

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
    s.copy_files_include_binaries = doc
        .get("copy")
        .and_then(|t| t.as_table())
        .and_then(|t| t.get("include_binaries"))
        .and_then(|v| v.as_bool())
        .unwrap_or(false);

    if let Some(table) = doc.get("scripts").and_then(|item| item.as_table()) {
        for (name, item) in table.iter() {
            if let Some(command) = item.as_str() {
                let name = name.trim();
                let command = command.trim();
                if !name.is_empty() && !command.is_empty() {
                    s.named_scripts.push(NamedScript {
                        name: name.to_string(),
                        command: command.to_string(),
                    });
                }
            }
        }
    }

    s
}

/// PURE: render `settings` into TOML, starting from `existing` so unrelated
/// tables/keys/comments survive. `None`/empty values clear their key (and prune
/// a table this surface owns once it's empty).
fn render(existing: &str, settings: &RepoWorktreeSettings) -> Result<String, String> {
    let mut doc: toml_edit::DocumentMut = existing
        .parse()
        .map_err(|e| format!("settings.toml is not valid TOML: {e}"))?;

    set_or_clear_str(&mut doc, "worktree", "setup", settings.setup.as_deref());
    set_or_clear_str(&mut doc, "worktree", "run", settings.run.as_deref());
    set_or_clear_str(&mut doc, "worktree", "archive", settings.archive.as_deref());
    set_or_clear_str(&mut doc, "git", "base", settings.base.as_deref());
    set_or_clear_str(&mut doc, "instructions", "review", settings.review_instructions.as_deref());
    set_or_clear_str(&mut doc, "instructions", "pr", settings.pr_instructions.as_deref());
    set_or_clear_str(
        &mut doc,
        "instructions",
        "conflicts",
        settings.conflict_instructions.as_deref(),
    );
    set_or_clear_str(&mut doc, "github", "host", settings.gh_host.as_deref());
    // The default (off) is the absent key, so an untouched file stays untouched.
    if settings.copy_files_include_binaries {
        let table = ensure_table(&mut doc, "copy");
        table["include_binaries"] = toml_edit::value(true);
    } else {
        clear_key(&mut doc, "copy", "include_binaries");
    }

    let files: Vec<&str> = settings
        .copy_files
        .iter()
        .map(|s| s.trim())
        .filter(|s| !s.is_empty())
        .collect();
    if files.is_empty() {
        clear_key(&mut doc, "copy", "files");
    } else {
        let table = ensure_table(&mut doc, "copy");
        let mut arr = toml_edit::Array::new();
        for f in &files {
            arr.push(*f);
        }
        table["files"] = toml_edit::value(arr);
    }

    doc.remove("scripts");
    let mut scripts = Vec::new();
    let mut script_names = std::collections::HashSet::new();
    for script in &settings.named_scripts {
        let name = script.name.trim();
        let command = script.command.trim();
        if name.is_empty() || command.is_empty() {
            continue;
        }
        if !script_names.insert(name.to_string()) {
            return Err(format!("duplicate named script: {name}"));
        }
        scripts.push(NamedScript {
            name: name.to_string(),
            command: command.to_string(),
        });
    }
    if !scripts.is_empty() {
        let table = ensure_table(&mut doc, "scripts");
        for script in scripts {
            table[&script.name] = toml_edit::value(script.command);
        }
    }

    prune_empty_owned_tables(&mut doc);
    Ok(doc.to_string())
}

fn ensure_table<'a>(doc: &'a mut toml_edit::DocumentMut, table: &str) -> &'a mut toml_edit::Table {
    if doc.get(table).and_then(|t| t.as_table()).is_none() {
        doc[table] = toml_edit::Item::Table(toml_edit::Table::new());
    }
    doc[table].as_table_mut().expect("just ensured table")
}

fn set_or_clear_str(
    doc: &mut toml_edit::DocumentMut,
    table: &str,
    key: &str,
    val: Option<&str>,
) {
    match val.map(str::trim).filter(|v| !v.is_empty()) {
        Some(v) => {
            let t = ensure_table(doc, table);
            t[key] = toml_edit::value(v);
        }
        None => clear_key(doc, table, key),
    }
}

fn clear_key(doc: &mut toml_edit::DocumentMut, table: &str, key: &str) {
    if let Some(t) = doc.get_mut(table).and_then(|t| t.as_table_mut()) {
        t.remove(key);
    }
}

/// Drop only OUR tables once we've emptied them; foreign tables are never touched.
fn prune_empty_owned_tables(doc: &mut toml_edit::DocumentMut) {
    for table in ["worktree", "git", "copy", "scripts", "instructions", "github"] {
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

    #[test]
    fn get_defaults_when_absent() {
        let s = parse("");
        assert!(s.setup.is_none() && s.run.is_none() && s.archive.is_none());
        assert!(s.base.is_none() && s.copy_files.is_empty());
    }

    #[test]
    fn parse_reads_contract_fields() {
        let doc = r#"
            [worktree]
            setup = "npm install"
            run = "npm run dev"
            archive = "down"
            [git]
            base = "main"
            [copy]
            files = [".env", ".env.local"]
            [scripts]
            dev = "npm run dev"
            test = "npm test"
        "#;
        let s = parse(doc);
        assert_eq!(s.setup.as_deref(), Some("npm install"));
        assert_eq!(s.run.as_deref(), Some("npm run dev"));
        assert_eq!(s.archive.as_deref(), Some("down"));
        assert_eq!(s.base.as_deref(), Some("main"));
        assert_eq!(s.copy_files, vec![".env".to_string(), ".env.local".to_string()]);
        assert_eq!(
            s.named_scripts,
            vec![
                NamedScript { name: "dev".into(), command: "npm run dev".into() },
                NamedScript { name: "test".into(), command: "npm test".into() },
            ]
        );
    }

    #[test]
    fn serde_camel_case_round_trip() {
        let s = RepoWorktreeSettings {
            base: Some("trunk".into()),
            copy_files: vec![".env".into()],
            ..Default::default()
        };
        let json = serde_json::to_string(&s).unwrap();
        assert!(json.contains("\"copyFiles\""), "must serialize as copyFiles: {json}");
        assert!(json.contains("\"base\":\"trunk\""));
        let back: RepoWorktreeSettings = serde_json::from_str(&json).unwrap();
        assert_eq!(back.copy_files, vec![".env".to_string()]);
        assert_eq!(back.base.as_deref(), Some("trunk"));
    }

    #[test]
    fn render_preserves_unrelated_and_updates_ours() {
        let existing = "# note\n[editor]\ntheme = \"dark\"\n[worktree]\nsetup = \"OLD\"\n";
        let s = RepoWorktreeSettings {
            setup: Some("npm ci".into()),
            base: Some("main".into()),
            copy_files: vec![".env".into()],
            ..Default::default()
        };
        let out = render(existing, &s).unwrap();
        assert!(out.contains("# note"));
        assert!(out.contains("[editor]"));
        assert!(out.contains("theme = \"dark\""));
        assert!(out.contains("setup = \"npm ci\""));
        assert!(!out.contains("OLD"));
        assert!(out.contains("[git]") && out.contains("base = \"main\""));
        assert!(out.contains("[copy]") && out.contains(".env"));
        // Re-parse equals what we wrote.
        let re = parse(&out);
        assert_eq!(re.setup.as_deref(), Some("npm ci"));
        assert_eq!(re.base.as_deref(), Some("main"));
        assert_eq!(re.copy_files, vec![".env".to_string()]);
    }

    #[test]
    fn render_clearing_prunes_only_owned_table() {
        let existing = "[worktree]\nsetup = \"x\"\n[editor]\ntheme=\"dark\"\n";
        let s = RepoWorktreeSettings::default(); // everything cleared
        let out = render(existing, &s).unwrap();
        assert!(!out.contains("[worktree]"));
        assert!(out.contains("[editor]"));
    }

    #[test]
    fn instructions_host_and_binaries_round_trip_and_stay_optional() {
        let s = RepoWorktreeSettings {
            review_instructions: Some("Check migrations first.".into()),
            pr_instructions: Some("Title carries the ticket id.".into()),
            conflict_instructions: Some("Prefer the incoming schema.".into()),
            gh_host: Some("github.example.com".into()),
            copy_files: vec![".env".into()],
            copy_files_include_binaries: true,
            ..Default::default()
        };
        let out = render("", &s).unwrap();
        assert!(out.contains("[instructions]") && out.contains("[github]"));
        assert!(out.contains("include_binaries = true"));
        let re = parse(&out);
        assert_eq!(re.review_instructions.as_deref(), Some("Check migrations first."));
        assert_eq!(re.pr_instructions.as_deref(), Some("Title carries the ticket id."));
        assert_eq!(re.conflict_instructions.as_deref(), Some("Prefer the incoming schema."));
        assert_eq!(re.gh_host.as_deref(), Some("github.example.com"));
        assert!(re.copy_files_include_binaries);

        // The frontend contract is camelCase, and an old payload without the
        // new keys still deserializes.
        let json = serde_json::to_string(&s).unwrap();
        assert!(json.contains("\"reviewInstructions\"") && json.contains("\"ghHost\""));
        assert!(json.contains("\"copyFilesIncludeBinaries\":true"));
        let old: RepoWorktreeSettings =
            serde_json::from_str(r#"{"setup":null,"run":null,"archive":null,"base":null,"copyFiles":[]}"#)
                .unwrap();
        assert!(old.gh_host.is_none() && !old.copy_files_include_binaries);

        // Clearing prunes only the tables we own.
        let cleared = render(&out, &RepoWorktreeSettings::default()).unwrap();
        assert!(!cleared.contains("[instructions]") && !cleared.contains("[github]"));
        assert!(!cleared.contains("include_binaries"));
    }

    #[test]
    fn rejects_duplicate_named_scripts_in_structured_settings() {
        let settings = RepoWorktreeSettings {
            named_scripts: vec![
                NamedScript { name: "test".into(), command: "cargo test".into() },
                NamedScript { name: "test".into(), command: "bun test".into() },
            ],
            ..RepoWorktreeSettings::default()
        };
        let error = render("", &settings).unwrap_err();
        assert!(error.contains("duplicate named script: test"));
    }
}
