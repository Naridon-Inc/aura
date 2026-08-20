// Code search + replace backend.
//
// Three Tauri commands:
//   * fs_grep_content    — text/regex grep across the repo via `git grep`.
//                          gitignore-aware for free, sub-second on huge
//                          repos, returns file/line/preview tuples.
//   * fs_replace_in_files — bulk find-and-replace across selected files.
//                          Caller hands us the exact files + (query,
//                          replacement, regex?, case?). We do an in-memory
//                          replace and write atomically.
//   * fs_grep_symbol     — symbol-aware lookup (function / class / type
//                          definitions). Best-effort: shells `aura defs`
//                          if available; if it isn't, falls back to a
//                          word-boundary `git grep` on the symbol name.
//
// All three return repo-relative paths so the UI can address them
// consistently. `fs_grep_content` caps results to keep the palette
// responsive — VSCode does the same with a "showing N of M" footer.

use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};
use std::process::Command;

const GREP_MAX_HITS: usize = 2000;
const PREVIEW_BYTES: usize = 240;

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct GrepHit {
    /// Repo-relative path.
    pub path: String,
    /// 1-based line number.
    pub line: u32,
    /// 1-based column of the first match on this line, when available
    /// (`git grep --column`). 0 when the column couldn't be parsed.
    pub column: u32,
    /// The full line text, trimmed to `PREVIEW_BYTES` for UI display.
    pub preview: String,
}

#[derive(Debug, Serialize, Deserialize, Clone, Default)]
pub struct GrepOpts {
    /// Treat `query` as a regular expression. Default: literal search.
    #[serde(default)]
    pub regex: bool,
    /// Case-sensitive. Default false (smart-case is hard to reason
    /// about across UI surfaces; we default to case-insensitive and let
    /// the UI offer a toggle).
    #[serde(default)]
    pub case_sensitive: bool,
    /// Whole-word match — wraps `query` with `\b` boundaries.
    #[serde(default)]
    pub whole_word: bool,
    /// Optional glob filters. `include` runs first; `exclude` filters
    /// what `include` returned. Examples: `["*.ts", "*.tsx"]`.
    #[serde(default)]
    pub include: Vec<String>,
    #[serde(default)]
    pub exclude: Vec<String>,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct GrepResult {
    pub hits: Vec<GrepHit>,
    /// True when we capped the result set — caller can show a footer
    /// like "showing 2000 of N+ matches, narrow your query".
    pub truncated: bool,
}

/// Grep the repository for `query`. Uses `git grep -n` so .gitignored
/// paths are skipped for free. Falls back to an empty result if the
/// directory isn't a git repo or git fails.
#[tauri::command]
pub async fn fs_grep_content(
    repo_root: String,
    query: String,
    opts: Option<GrepOpts>,
) -> Result<GrepResult, String> {
    crate::blocking::run(move || {
        if query.trim().is_empty() {
            return Ok(GrepResult { hits: Vec::new(), truncated: false });
        }
        let opts = opts.unwrap_or_default();
        let cwd = PathBuf::from(&repo_root);
        if !cwd.exists() {
            return Err(format!("repo_root does not exist: {repo_root}"));
        }

        let mut cmd = Command::new("git");
        cmd.current_dir(&cwd).arg("grep").arg("-n").arg("--column").arg("--no-color");
        if !opts.case_sensitive {
            cmd.arg("-i");
        }
        if opts.whole_word {
            cmd.arg("-w");
        }
        if opts.regex {
            cmd.arg("-E");
        } else {
            cmd.arg("-F");
        }
        // Untracked files too — users want to find content in new files
        // they haven't committed yet.
        cmd.arg("--untracked");
        cmd.arg("--");
        cmd.arg(&query);
        // Pathspec filters. `:(glob)` is git's portable glob magic.
        for inc in &opts.include {
            cmd.arg(format!(":(glob){inc}"));
        }
        for exc in &opts.exclude {
            cmd.arg(format!(":(exclude,glob){exc}"));
        }

        let out = cmd.output().map_err(|e| format!("git grep failed: {e}"))?;
        // git grep exits 1 when there are no matches — not an error for us.
        if !out.status.success() && out.status.code() != Some(1) {
            let stderr = String::from_utf8_lossy(&out.stderr).to_string();
            return Err(format!("git grep error: {stderr}"));
        }

        let mut hits = Vec::new();
        let mut truncated = false;
        for line in String::from_utf8_lossy(&out.stdout).lines() {
            if hits.len() >= GREP_MAX_HITS {
                truncated = true;
                break;
            }
            // Format with --column: path:line:col:text
            let mut parts = line.splitn(4, ':');
            let path = parts.next().unwrap_or("").to_string();
            let line_no: u32 = parts.next().and_then(|s| s.parse().ok()).unwrap_or(0);
            let col_no: u32 = parts.next().and_then(|s| s.parse().ok()).unwrap_or(0);
            let preview = parts.next().unwrap_or("").to_string();
            if path.is_empty() || line_no == 0 {
                continue;
            }
            let preview = if preview.len() > PREVIEW_BYTES {
                // Truncate on a UTF-8 char boundary — slicing raw bytes panics
                // when byte PREVIEW_BYTES lands inside a multibyte char (e.g. an
                // em-dash), which crashed the whole search command live.
                format!("{}…", truncate_on_char_boundary(&preview, PREVIEW_BYTES))
            } else {
                preview
            };
            hits.push(GrepHit { path, line: line_no, column: col_no, preview });
        }
        Ok(GrepResult { hits, truncated })
    })
    .await
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct ReplaceReport {
    pub files_changed: usize,
    pub total_replacements: usize,
    /// Repo-relative paths that were modified.
    pub paths: Vec<String>,
}

/// Replace `query` with `replacement` across the given repo-relative
/// `paths`. Honors the same `regex`/`case_sensitive`/`whole_word`
/// flags as the grep so the UI can mirror its preview state. Writes
/// atomically (write to tmp file in same dir, rename over).
#[tauri::command]
pub async fn fs_replace_in_files(
    repo_root: String,
    paths: Vec<String>,
    query: String,
    replacement: String,
    opts: Option<GrepOpts>,
) -> Result<ReplaceReport, String> {
    crate::blocking::run(move || {
        if query.is_empty() {
            return Err("empty query".to_string());
        }
        let opts = opts.unwrap_or_default();
        let root = PathBuf::from(&repo_root);
        if !root.exists() {
            return Err(format!("repo_root does not exist: {repo_root}"));
        }

        // Build a regex matcher once. Literal search converts the query
        // via regex::escape so the same engine handles both modes.
        let pattern = if opts.regex {
            if opts.whole_word { format!(r"\b(?:{query})\b") } else { query.clone() }
        } else {
            let esc = regex::escape(&query);
            if opts.whole_word { format!(r"\b(?:{esc})\b") } else { esc }
        };
        let re = regex::RegexBuilder::new(&pattern)
            .case_insensitive(!opts.case_sensitive)
            .build()
            .map_err(|e| format!("bad pattern: {e}"))?;

        let mut report = ReplaceReport {
            files_changed: 0,
            total_replacements: 0,
            paths: Vec::new(),
        };

        for rel in paths {
            let abs = root.join(&rel);
            if !abs.starts_with(&root) {
                // path-traversal guard
                continue;
            }
            let Ok(content) = std::fs::read_to_string(&abs) else { continue };
            let mut count = 0usize;
            let new_content = re.replace_all(&content, |_caps: &regex::Captures| {
                count += 1;
                replacement.clone()
            });
            if count == 0 {
                continue;
            }
            // Atomic write: write to a sibling temp, then rename.
            let dir = abs.parent().unwrap_or(&root);
            let stem = abs
                .file_name()
                .and_then(|n| n.to_str())
                .unwrap_or(".tmp")
                .to_string();
            let tmp = dir.join(format!(".{stem}.aura-replace.tmp"));
            std::fs::write(&tmp, new_content.as_bytes())
                .map_err(|e| format!("write {rel}: {e}"))?;
            std::fs::rename(&tmp, &abs)
                .map_err(|e| format!("rename {rel}: {e}"))?;
            report.files_changed += 1;
            report.total_replacements += count;
            report.paths.push(rel);
        }

        Ok(report)
    })
    .await
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct SymbolHit {
    pub path: String,
    pub line: u32,
    pub kind: String, // "function" | "class" | "type" | "const" | "unknown"
    pub name: String,
    pub preview: String,
}

/// Symbol lookup. Tries `aura defs <name>` first (semantic, AST-level);
/// if the binary isn't on PATH or returns non-zero, falls back to a
/// word-boundary git grep that surfaces lines beginning with the
/// language's typical definition keywords (`fn`, `function`, `class`,
/// `def`, `const`, `let`, `var`, `type`, `interface`, `struct`,
/// `pub fn`, `pub struct`, `pub enum`, `export function`, etc.).
#[tauri::command]
pub async fn fs_grep_symbol(
    repo_root: String,
    name: String,
) -> Result<Vec<SymbolHit>, String> {
    crate::blocking::run(move || {
        if name.trim().is_empty() {
            return Ok(Vec::new());
        }
        let cwd = PathBuf::from(&repo_root);
        if !cwd.exists() {
            return Err(format!("repo_root does not exist: {repo_root}"));
        }

        // Semantic, AST-level lookup first — but only trust it when it actually
        // found something. An empty-but-successful `aura defs` (name not indexed,
        // or no AST graph yet) must fall through to grep, not short-circuit to [].
        if let Some(hits) = try_aura_defs(&cwd, &name) {
            if !hits.is_empty() {
                return Ok(hits);
            }
        }

        // Fallback grep: definition keyword followed by an identifier that
        // CONTAINS the query (case-insensitive), so "agent" finds `AgentIcon`,
        // `useAgentState`, `agent_id`, etc.
        //
        // POSIX ERE only — git grep's `-E` engine does NOT understand Perl
        // escapes. `\s` silently matches nothing (the old pattern's bug: every
        // symbol search came back empty), and `\b` is non-portable. So we spell
        // whitespace as `[[:space:]]` and require a non-word char (or line start)
        // before the keyword instead of `\b`. That non-word lead-in also covers
        // `pub fn`, `export function`, `export class`, … for free.
        let esc = regex_escape(&name);
        let pattern = format!(
            "(^|[^A-Za-z0-9_])(fn|function|class|def|const|let|var|type|interface|struct|enum)[[:space:]]+[A-Za-z0-9_$]*{esc}[A-Za-z0-9_$]*",
        );
        let out = Command::new("git")
            .current_dir(&cwd)
            .args([
                "grep",
                "-niE",
                "--column",
                "--no-color",
                "--untracked",
                &pattern,
            ])
            .output()
            .map_err(|e| format!("git grep failed: {e}"))?;
        if !out.status.success() && out.status.code() != Some(1) {
            return Err(String::from_utf8_lossy(&out.stderr).to_string());
        }
        let mut hits = Vec::new();
        let mut seen = std::collections::HashSet::new();
        for line in String::from_utf8_lossy(&out.stdout).lines() {
            let mut parts = line.splitn(4, ':');
            let path = parts.next().unwrap_or("").to_string();
            let line_no: u32 = parts.next().and_then(|s| s.parse().ok()).unwrap_or(0);
            let _col: u32 = parts.next().and_then(|s| s.parse().ok()).unwrap_or(0);
            let preview = parts.next().unwrap_or("").to_string();
            if path.is_empty() || line_no == 0 {
                continue;
            }
            // Skip the noise that `--untracked` would otherwise drag in: Aura's
            // own gitignored sidecars are not user code.
            if path.starts_with(".aura/") || path.contains("/.aura/") {
                continue;
            }
            if !seen.insert((path.clone(), line_no)) {
                continue;
            }
            let kind = infer_kind(&preview);
            let name = extract_defined_name(&preview).unwrap_or_else(|| name.clone());
            hits.push(SymbolHit {
                path,
                line: line_no,
                kind,
                name,
                preview: preview.trim().to_string(),
            });
            // Bound the scan; we sort + truncate to a tighter window below.
            if hits.len() >= 600 {
                break;
            }
        }

        // Relevance order — the palette only shows the top few, so float the
        // strongest definitions up: exact-name matches first, then by how much
        // of the identifier the query covers (shorter ⇒ closer), then declared
        // functions/classes/types ahead of bare variable bindings.
        let needle = name.to_lowercase();
        hits.sort_by_key(|h| {
            let n = h.name.to_lowercase();
            let exact = if n == needle { 0 } else { 1 };
            let kind_rank = match h.kind.as_str() {
                "function" | "class" | "type" => 0,
                "const" => 1,
                _ => 2,
            };
            (exact, n.len(), kind_rank)
        });
        hits.truncate(200);
        Ok(hits)
    })
    .await
}

/// Return the longest prefix of `s` that fits in `max_bytes` AND ends on a
/// UTF-8 char boundary. `&s[..n]` panics if `n` splits a multibyte char, so
/// every byte-bounded preview must go through here.
fn truncate_on_char_boundary(s: &str, max_bytes: usize) -> &str {
    if s.len() <= max_bytes {
        return s;
    }
    let mut end = max_bytes;
    while end > 0 && !s.is_char_boundary(end) {
        end -= 1;
    }
    &s[..end]
}

/// Escape regex metacharacters so a user's literal query can't break the
/// fallback pattern (the palette only fires this for identifier-ish queries,
/// but be defensive).
fn regex_escape(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    for c in s.chars() {
        if "\\.+*?()|[]{}^$".contains(c) {
            out.push('\\');
        }
        out.push(c);
    }
    out
}

/// Pull the actual defined identifier out of a definition line so the row
/// shows `AgentIcon`, not the raw query "agent". Best-effort; returns None
/// when the shape isn't recognized and the caller keeps the query.
fn extract_defined_name(preview: &str) -> Option<String> {
    let t = preview.trim_start();
    let rest = [
        "export function ",
        "export class ",
        "export const ",
        "export default function ",
        "pub async fn ",
        "pub fn ",
        "async function ",
        "async fn ",
        "function ",
        "interface ",
        "class ",
        "struct ",
        "enum ",
        "const ",
        "type ",
        "let ",
        "var ",
        "def ",
        "fn ",
    ]
    .iter()
    .find_map(|kw| t.strip_prefix(kw))?;
    let ident: String = rest
        .chars()
        .take_while(|c| c.is_alphanumeric() || *c == '_' || *c == '$')
        .collect();
    if ident.is_empty() {
        None
    } else {
        Some(ident)
    }
}

fn try_aura_defs(cwd: &Path, name: &str) -> Option<Vec<SymbolHit>> {
    let out = Command::new(crate::agent_event_listener::resolve_aura_bin())
        .current_dir(cwd)
        .args(["defs", "--json", name])
        .output()
        .ok()?;
    if !out.status.success() {
        return None;
    }
    let stdout = String::from_utf8_lossy(&out.stdout);
    #[derive(Deserialize)]
    struct Def {
        path: String,
        line: u32,
        kind: Option<String>,
        name: Option<String>,
        preview: Option<String>,
    }
    let parsed: Vec<Def> = serde_json::from_str(&stdout).ok()?;
    Some(
        parsed
            .into_iter()
            .map(|d| SymbolHit {
                path: d.path,
                line: d.line,
                kind: d.kind.unwrap_or_else(|| "unknown".to_string()),
                name: d.name.unwrap_or_else(|| name.to_string()),
                preview: d.preview.unwrap_or_default(),
            })
            .collect(),
    )
}

fn infer_kind(preview: &str) -> String {
    let t = preview.trim_start();
    if t.starts_with("fn ") || t.starts_with("pub fn ") || t.starts_with("async fn ") {
        "function".into()
    } else if t.starts_with("function ") || t.starts_with("export function ") || t.starts_with("async function ") {
        "function".into()
    } else if t.starts_with("def ") {
        "function".into()
    } else if t.starts_with("class ") || t.starts_with("export class ") || t.starts_with("pub struct ") || t.starts_with("struct ") {
        "class".into()
    } else if t.starts_with("type ") || t.starts_with("interface ") || t.starts_with("pub type ") || t.starts_with("enum ") || t.starts_with("pub enum ") {
        "type".into()
    } else if t.starts_with("const ") || t.starts_with("let ") || t.starts_with("var ") || t.starts_with("pub const ") {
        "const".into()
    } else {
        "unknown".into()
    }
}

/// Detect macOS App Translocation — the OS-quarantined random path
/// under `/private/var/folders/.../AppTranslocation/...` that strips
/// the app's ability to auto-update in place. Returns the bundle path
/// when translocation is active so the UI can prompt "drag Aura to
/// /Applications" before the updater fails opaquely.
#[tauri::command]
pub async fn app_bundle_location() -> AppLocation {
    #[cfg(target_os = "macos")]
    {
        let exe = std::env::current_exe().ok();
        if let Some(p) = exe.as_ref() {
            let s = p.to_string_lossy();
            let translocated = s.contains("/AppTranslocation/");
            // Walk up to find the .app bundle root.
            let bundle = p
                .ancestors()
                .find(|a| a.extension().map(|e| e == "app").unwrap_or(false))
                .map(|a| a.to_string_lossy().to_string());
            let in_applications = bundle
                .as_deref()
                .map(|b| b.starts_with("/Applications/") || b.starts_with("/Users/"))
                .unwrap_or(false);
            let writable = bundle.as_deref().map(is_writable).unwrap_or(false);
            return AppLocation {
                bundle_path: bundle,
                translocated,
                in_applications,
                writable,
            };
        }
    }
    AppLocation::default()
}

#[derive(Debug, Serialize, Deserialize, Clone, Default)]
pub struct AppLocation {
    pub bundle_path: Option<String>,
    pub translocated: bool,
    pub in_applications: bool,
    pub writable: bool,
}

fn is_writable(path: &str) -> bool {
    let p = PathBuf::from(path);
    if !p.exists() {
        return false;
    }
    let probe = p.join(".aura-write-probe");
    let ok = std::fs::write(&probe, b"x").is_ok();
    let _ = std::fs::remove_file(&probe);
    ok
}
