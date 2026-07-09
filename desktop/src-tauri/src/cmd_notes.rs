//! Team markdown notes — Notion-style per-scope wiki backed by a tree
//! under `<repoRoot>/.aura/notes/`.
//!
//! Scopes:
//!   • team    — `.aura/notes/team/<id>.md`
//!   • channel — `.aura/notes/channel/<channel>/<id>.md`
//!   • member  — `.aura/notes/member/<handle>/<id>.md` (private by default;
//!     a frontmatter `"visibility": "shared"` opt-in surfaces it team-wide)
//!
//! File format: optional JSON frontmatter sandwiched between `---` lines,
//! followed by raw markdown. Keeping the frontmatter as JSON avoids a YAML
//! dep and round-trips through `serde_json` cleanly.
//!
//! ```text
//! ---
//! {"title":"Sprint Plan","tags":["sprint"]}
//! ---
//! # Sprint Plan
//!
//! Body...
//! ```
//!
//! Future cloud sync layers on top via `notes_sync_pull` / `notes_sync_push`
//! (Stage 3) — the file layout is the durable source of truth on each
//! device, mirrored to a cloud table.

use std::fs;
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum NoteScope {
    Team,
    Channel,
    Member,
}

impl NoteScope {
    pub fn dir_name(&self) -> &'static str {
        match self {
            NoteScope::Team => "team",
            NoteScope::Channel => "channel",
            NoteScope::Member => "member",
        }
    }
}

#[derive(Clone, Debug, Default, Serialize, Deserialize)]
pub struct NoteFrontmatter {
    #[serde(default)]
    pub title: Option<String>,
    #[serde(default)]
    pub author: Option<String>,
    #[serde(default)]
    pub created_at: Option<String>,
    #[serde(default)]
    pub updated_at: Option<String>,
    /// `"private" | "shared"` — the Publish toggle writes this. `"shared"`
    /// surfaces the note in the team-wide / Public list tab; `"private"` is a
    /// personal draft. Defaults per-scope when unset (member→private, else
    /// shared).
    #[serde(default)]
    pub visibility: Option<String>,
    /// Lock toggle — when `true` the page is read-only in the editor. Persisted
    /// here so the lock travels with the note (committed) rather than being a
    /// device-local flag. Absent/false ⇒ editable.
    #[serde(default)]
    pub locked: Option<bool>,
    #[serde(default)]
    pub tags: Vec<String>,
    /// Parent page id in the page tree. `None` ⇒ a root page. This replaces
    /// the frontend's localStorage parent hack so the hierarchy travels with
    /// the file (committed + synced) instead of living on one device.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub parent_id: Option<String>,
    /// RFC3339 timestamp of when the page was archived. `Some` ⇒ archived (the
    /// frontend filters it into the Archived list); `None` ⇒ active.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub archived_at: Option<String>,
    /// Optional emoji or icon id shown beside the page title.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub icon: Option<String>,
    /// Folder this page belongs to (a `PageFolder` id from
    /// `cmd_note_folders`). `None` ⇒ the page sits at the root of its scope.
    /// Optional + skip-when-absent so every pre-folder note still deserializes
    /// cleanly and never gains an empty `folder` key on rewrite.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub folder: Option<String>,
    /// Handles `@mentioned` anywhere in the body, lowercased + de-duplicated.
    /// Recomputed from the body on every write (never authored by hand), so it
    /// is the durable record of who a page tags — the diff against the previous
    /// version drives the mention-notification DMs.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub mentioned_handles: Vec<String>,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct NoteSummary {
    pub id: String,
    pub scope: NoteScope,
    /// For `Channel`, the channel id. For `Member`, the handle. For `Team`, empty.
    pub bucket: String,
    pub title: String,
    pub updated_at: String,
    pub tags: Vec<String>,
    pub visibility: String,
    /// Parent page id, surfaced so the frontend can build the page tree from
    /// disk rather than a device-local cache. `None` ⇒ a root page.
    pub parent_id: Option<String>,
    /// Archive timestamp, surfaced so the list view can split Active/Archived
    /// without reading each note in full. `None` ⇒ active.
    pub archived_at: Option<String>,
    /// Folder id this page lives in (`None` ⇒ root), surfaced so the tree can
    /// group pages under their folder without reading each note's body.
    pub folder: Option<String>,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct Note {
    pub id: String,
    pub scope: NoteScope,
    pub bucket: String,
    pub frontmatter: NoteFrontmatter,
    pub body: String,
    /// Full on-disk text including the frontmatter sandwich — clients
    /// that just want to edit the raw file get this.
    pub raw: String,
}

fn notes_root(repo_root: &Path) -> PathBuf {
    repo_root.join(".aura").join("notes")
}

fn scope_dir(repo_root: &Path, scope: &NoteScope, bucket: &str) -> PathBuf {
    let base = notes_root(repo_root).join(scope.dir_name());
    match scope {
        NoteScope::Team => base,
        NoteScope::Channel | NoteScope::Member => {
            if bucket.is_empty() {
                base
            } else {
                base.join(sanitize_segment(bucket))
            }
        }
    }
}

/// Strip characters that are unsafe in path segments. We don't need full
/// filesystem-safe escaping — just block `/`, `\`, NUL, and any `..`
/// traversal so a bad channel name can't escape the notes root.
fn sanitize_segment(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    for c in s.chars() {
        if c == '/' || c == '\\' || c == '\0' || c.is_control() {
            out.push('_');
        } else {
            out.push(c);
        }
    }
    let out = out.replace("..", "_");
    if out.is_empty() {
        "_".to_string()
    } else {
        out
    }
}

fn note_path(repo_root: &Path, scope: &NoteScope, bucket: &str, id: &str) -> PathBuf {
    scope_dir(repo_root, scope, bucket).join(format!("{}.md", sanitize_segment(id)))
}

fn now_iso() -> String {
    chrono::Utc::now().to_rfc3339()
}

fn new_id() -> String {
    format!("note_{}", uuid::Uuid::new_v4())
}

/// Parse the optional JSON frontmatter from raw note text. Returns
/// `(frontmatter, body)` where `body` is everything after the closing
/// `---`. If no valid frontmatter is found, the whole text is the body.
fn split_frontmatter(text: &str) -> (NoteFrontmatter, String) {
    let trimmed = text.trim_start_matches('\u{feff}');
    let mut lines = trimmed.lines();
    let Some(first) = lines.next() else {
        return (NoteFrontmatter::default(), String::new());
    };
    if first.trim() != "---" {
        return (NoteFrontmatter::default(), text.to_string());
    }
    let mut fm_buf = String::new();
    let mut closed = false;
    let mut body_offset = first.len() + 1; // include newline
    for line in lines.by_ref() {
        body_offset += line.len() + 1;
        if line.trim() == "---" {
            closed = true;
            break;
        }
        fm_buf.push_str(line);
        fm_buf.push('\n');
    }
    if !closed {
        return (NoteFrontmatter::default(), text.to_string());
    }
    let body = trimmed
        .get(body_offset..)
        .map(|s| s.trim_start_matches('\n').to_string())
        .unwrap_or_default();
    let fm: NoteFrontmatter = serde_json::from_str(fm_buf.trim()).unwrap_or_default();
    (fm, body)
}

fn assemble(frontmatter: &NoteFrontmatter, body: &str) -> String {
    let header =
        serde_json::to_string(frontmatter).unwrap_or_else(|_| "{}".to_string());
    let trimmed_body = body.trim_start_matches('\n');
    format!("---\n{}\n---\n{}", header, trimmed_body)
}

fn read_summary(
    path: &Path,
    scope: NoteScope,
    bucket: String,
) -> Option<NoteSummary> {
    let id = path.file_stem()?.to_string_lossy().to_string();
    let bytes = fs::read(path).ok()?;
    let text = String::from_utf8_lossy(&bytes);
    let (fm, body) = split_frontmatter(&text);
    let title = fm
        .title
        .clone()
        .or_else(|| extract_h1(&body))
        .unwrap_or_else(|| id.clone());
    let updated_at = fm.updated_at.clone().unwrap_or_default();
    let visibility = fm
        .visibility
        .clone()
        .unwrap_or_else(|| match scope {
            NoteScope::Member => "private".to_string(),
            _ => "shared".to_string(),
        });
    Some(NoteSummary {
        id,
        scope,
        bucket,
        title,
        updated_at,
        tags: fm.tags,
        visibility,
        parent_id: fm.parent_id,
        archived_at: fm.archived_at,
        folder: fm.folder,
    })
}

fn extract_h1(md: &str) -> Option<String> {
    for line in md.lines() {
        let t = line.trim_start();
        if let Some(rest) = t.strip_prefix("# ") {
            let cleaned = rest.trim().to_string();
            if !cleaned.is_empty() {
                return Some(cleaned);
            }
        }
    }
    None
}

/// Extract `@handle` mentions from a page body, lowercased + de-duplicated,
/// order-preserving. Mirrors the frontend parser (`src/lib/mentions.ts`,
/// regex `/(^|[\s(\[{>])@([a-zA-Z0-9][a-zA-Z0-9._-]*)/g`): a handle starts
/// with an alphanumeric and continues with alphanumerics / `.` / `_` / `-`,
/// and the `@` must be at the start of the string or directly follow
/// whitespace / `(` / `[` / `{` / `>`. That leading-character rule excludes
/// emails like `foo@bar.com` (the `@` there follows a word char). Kept local
/// to this module so the Pages domain has zero cross-file dependency; the
/// `notify::mentions` module carries its own faithful copy.
fn extract_page_mentions(body: &str) -> Vec<String> {
    fn is_prefix(c: char) -> bool {
        c.is_whitespace() || matches!(c, '(' | '[' | '{' | '>')
    }
    fn is_handle_start(c: char) -> bool {
        c.is_ascii_alphanumeric()
    }
    fn is_handle_body(c: char) -> bool {
        c.is_ascii_alphanumeric() || matches!(c, '.' | '_' | '-')
    }

    let mut out: Vec<String> = Vec::new();
    let mut seen: std::collections::HashSet<String> = std::collections::HashSet::new();
    let chars: Vec<char> = body.chars().collect();
    let mut i = 0usize;
    while i < chars.len() {
        if chars[i] != '@' {
            i += 1;
            continue;
        }
        let prefix_ok = i == 0 || is_prefix(chars[i - 1]);
        if !prefix_ok {
            i += 1;
            continue;
        }
        let start = i + 1;
        if start >= chars.len() || !is_handle_start(chars[start]) {
            i += 1;
            continue;
        }
        let mut end = start + 1;
        while end < chars.len() && is_handle_body(chars[end]) {
            end += 1;
        }
        let handle: String = chars[start..end].iter().collect::<String>().to_lowercase();
        if seen.insert(handle.clone()) {
            out.push(handle);
        }
        i = end;
    }
    out
}

#[derive(Deserialize)]
pub struct NoteListInput {
    pub repo_root: String,
    /// Optional filter — `None` lists every scope.
    #[serde(default)]
    pub scope: Option<NoteScope>,
    /// Optional bucket filter (channel id / member handle). Ignored for
    /// `Team` scope.
    #[serde(default)]
    pub bucket: Option<String>,
}

#[derive(Deserialize)]
pub struct NoteReadInput {
    pub repo_root: String,
    pub scope: NoteScope,
    #[serde(default)]
    pub bucket: String,
    pub id: String,
}

#[derive(Deserialize)]
pub struct NoteWriteInput {
    pub repo_root: String,
    pub scope: NoteScope,
    #[serde(default)]
    pub bucket: String,
    /// `None` → mint a new note id; otherwise update in place.
    #[serde(default)]
    pub id: Option<String>,
    /// Raw body markdown. Frontmatter (title/tags/visibility) lives in
    /// the dedicated fields so callers don't have to hand-craft JSON.
    pub body: String,
    #[serde(default)]
    pub title: Option<String>,
    #[serde(default)]
    pub author: Option<String>,
    #[serde(default)]
    pub visibility: Option<String>,
    /// Lock toggle. `Some(true/false)` writes the flag; `None` leaves the
    /// existing lock state untouched (so an ordinary body save never clears
    /// a lock).
    #[serde(default)]
    pub locked: Option<bool>,
    #[serde(default)]
    pub tags: Option<Vec<String>>,
    /// Page-tree parent. `Some(Some(id))` sets a parent, `Some(None)` clears it
    /// to a root page, and the field being absent (deserialized as `None`)
    /// leaves the existing parent untouched on an ordinary body save.
    #[serde(default)]
    pub parent_id: Option<Option<String>>,
    /// Archive timestamp. `Some(Some(ts))`/`Some(None)` set/clear the archive
    /// state; absent leaves it untouched.
    #[serde(default)]
    pub archived_at: Option<Option<String>>,
    /// Optional icon. `Some(Some(icon))`/`Some(None)` set/clear; absent leaves
    /// it untouched.
    #[serde(default)]
    pub icon: Option<Option<String>>,
    /// Folder membership. `Some(Some(id))` files the page into a folder,
    /// `Some(None)` moves it back to root, and the field being absent
    /// (deserialized as `None`) leaves the existing folder untouched on an
    /// ordinary body save.
    #[serde(default)]
    pub folder: Option<Option<String>>,
}

#[derive(Deserialize)]
pub struct NoteDeleteInput {
    pub repo_root: String,
    pub scope: NoteScope,
    #[serde(default)]
    pub bucket: String,
    pub id: String,
}

#[tauri::command]
pub async fn notes_list(input: NoteListInput) -> Result<Vec<NoteSummary>, String> {
    let repo = PathBuf::from(&input.repo_root);
    let root = notes_root(&repo);
    if !root.exists() {
        return Ok(Vec::new());
    }
    let mut out = Vec::new();
    let scopes: Vec<NoteScope> = match input.scope {
        Some(s) => vec![s],
        None => vec![NoteScope::Team, NoteScope::Channel, NoteScope::Member],
    };
    for scope in scopes {
        let scope_root = root.join(scope.dir_name());
        if !scope_root.exists() {
            continue;
        }
        match scope {
            NoteScope::Team => {
                collect_dir(&scope_root, scope.clone(), String::new(), &mut out);
            }
            NoteScope::Channel | NoteScope::Member => {
                let entries = match fs::read_dir(&scope_root) {
                    Ok(e) => e,
                    Err(_) => continue,
                };
                for entry in entries.flatten() {
                    let path = entry.path();
                    if !path.is_dir() {
                        continue;
                    }
                    let bucket = entry.file_name().to_string_lossy().to_string();
                    if let Some(want) = &input.bucket {
                        if want != &bucket {
                            continue;
                        }
                    }
                    collect_dir(&path, scope.clone(), bucket, &mut out);
                }
            }
        }
    }
    // Stable order: newest updated_at first; fallback to id.
    out.sort_by(|a, b| {
        b.updated_at
            .cmp(&a.updated_at)
            .then_with(|| a.id.cmp(&b.id))
    });
    Ok(out)
}

fn collect_dir(
    dir: &Path,
    scope: NoteScope,
    bucket: String,
    out: &mut Vec<NoteSummary>,
) {
    let entries = match fs::read_dir(dir) {
        Ok(e) => e,
        Err(_) => return,
    };
    for entry in entries.flatten() {
        let path = entry.path();
        if path.extension().and_then(|s| s.to_str()) != Some("md") {
            continue;
        }
        if let Some(summary) = read_summary(&path, scope.clone(), bucket.clone()) {
            out.push(summary);
        }
    }
}

#[tauri::command]
pub async fn notes_read(input: NoteReadInput) -> Result<Note, String> {
    let repo = PathBuf::from(&input.repo_root);
    let path = note_path(&repo, &input.scope, &input.bucket, &input.id);
    if !path.exists() {
        return Err(format!("note not found: {}", path.display()));
    }
    let bytes = fs::read(&path).map_err(|e| format!("read {}: {}", path.display(), e))?;
    let raw = String::from_utf8_lossy(&bytes).to_string();
    let (frontmatter, body) = split_frontmatter(&raw);
    Ok(Note {
        id: input.id,
        scope: input.scope,
        bucket: input.bucket,
        frontmatter,
        body,
        raw,
    })
}

#[tauri::command]
pub async fn notes_write(input: NoteWriteInput) -> Result<Note, String> {
    let repo = PathBuf::from(&input.repo_root);
    let id = input.id.clone().unwrap_or_else(new_id);
    let path = note_path(&repo, &input.scope, &input.bucket, &id);

    let now = now_iso();
    let mut frontmatter = if path.exists() {
        let bytes = fs::read(&path)
            .map_err(|e| format!("read {}: {}", path.display(), e))?;
        let raw = String::from_utf8_lossy(&bytes);
        let (existing, _) = split_frontmatter(&raw);
        existing
    } else {
        NoteFrontmatter {
            created_at: Some(now.clone()),
            ..NoteFrontmatter::default()
        }
    };
    // Who the *previous* version tagged — captured before we overwrite the
    // field — so we can DM only the people freshly added by this save.
    let prev_mentions = frontmatter.mentioned_handles.clone();
    if frontmatter.created_at.is_none() {
        frontmatter.created_at = Some(now.clone());
    }
    if input.title.is_some() {
        frontmatter.title = input.title.map(|s| s.trim().to_string());
    } else if frontmatter.title.is_none() {
        frontmatter.title = extract_h1(&input.body);
    }
    if let Some(a) = input.author {
        frontmatter.author = Some(a);
    }
    if let Some(v) = input.visibility {
        frontmatter.visibility = Some(v);
    }
    if let Some(l) = input.locked {
        frontmatter.locked = Some(l);
    }
    if let Some(t) = input.tags {
        frontmatter.tags = t;
    }
    // Tri-state optionals: an outer `Some` means the caller addressed the
    // field (inner value sets/clears it); an outer `None` leaves it as-is so
    // an ordinary body save never wipes parent/archive/icon.
    if let Some(p) = input.parent_id {
        frontmatter.parent_id = p;
    }
    if let Some(a) = input.archived_at {
        frontmatter.archived_at = a;
    }
    if let Some(ic) = input.icon {
        frontmatter.icon = ic;
    }
    if let Some(fd) = input.folder {
        frontmatter.folder = fd;
    }
    // Mentions are derived state — always recomputed from the freshly-saved
    // body, never trusted from the input.
    frontmatter.mentioned_handles = extract_page_mentions(&input.body);
    // Handles present now but not in the previous version → the people this
    // save newly tagged. The orchestrator turns this into mention DMs.
    let newly_mentioned: Vec<String> = frontmatter
        .mentioned_handles
        .iter()
        .filter(|h| !prev_mentions.contains(h))
        .cloned()
        .collect();
    frontmatter.updated_at = Some(now.clone());

    let raw = assemble(&frontmatter, &input.body);
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent)
            .map_err(|e| format!("mkdir {}: {}", parent.display(), e))?;
    }
    let tmp = path.with_extension("md.tmp");
    fs::write(&tmp, raw.as_bytes()).map_err(|e| format!("write tmp: {}", e))?;
    fs::rename(&tmp, &path).map_err(|e| format!("rename: {}", e))?;

    // Broadcast over the live rail (#219). Gated inside on team-has-peers and
    // shareability — private member drafts and solo repos stay silent.
    crate::cmd_notes_sync::publish_note_upsert(
        &input.repo_root,
        &input.scope,
        &input.bucket,
        &id,
        &raw,
        &frontmatter,
    );

    // Mention DMs (auto-DM): anyone newly @-tagged in this save gets a direct
    // message from the person who saved the page. Self-mentions are skipped;
    // non-roster handles and agents are filtered inside `notify`.
    let (actor_handle, actor_name) = crate::cmd_team::local_actor(&input.repo_root);
    let targets: Vec<String> = newly_mentioned
        .into_iter()
        .filter(|h| *h != actor_handle)
        .collect();
    if !targets.is_empty() {
        let title = frontmatter.title.clone().unwrap_or_else(|| id.clone());
        let scope_dir = input.scope.dir_name();
        let item = crate::notify::ItemRef {
            kind: "page".to_string(),
            id: format!("{}/{}/{}", scope_dir, input.bucket, id),
            label: title,
            deeplink: format!("aura://page/{}/{}/{}", scope_dir, input.bucket, id),
        };
        crate::notify::notify(
            &input.repo_root,
            &actor_handle,
            &actor_name,
            &targets,
            &item,
            crate::notify::Reason::Mentioned,
        );
    }

    Ok(Note {
        id,
        scope: input.scope,
        bucket: input.bucket,
        frontmatter,
        body: input.body,
        raw,
    })
}

/// Load a note's frontmatter + body off disk, returning an error when the
/// file is missing. Shared by the metadata-only mutators below so they don't
/// each re-implement the read/parse path.
fn load_note(
    repo_root: &Path,
    scope: &NoteScope,
    bucket: &str,
    id: &str,
) -> Result<(NoteFrontmatter, String), String> {
    let path = note_path(repo_root, scope, bucket, id);
    if !path.exists() {
        return Err(format!("note not found: {}", path.display()));
    }
    let bytes = fs::read(&path).map_err(|e| format!("read {}: {}", path.display(), e))?;
    Ok(split_frontmatter(&String::from_utf8_lossy(&bytes)))
}

/// Re-assemble + atomically write a note from its frontmatter and body, then
/// broadcast the upsert over the live rail. Returns the full `Note`. Used by
/// the metadata mutators (archive / set-parent) so they share `notes_write`'s
/// durability + publish path without re-deriving mentions or touching the body.
fn write_note_meta(
    repo_root: &str,
    scope: &NoteScope,
    bucket: &str,
    id: &str,
    frontmatter: NoteFrontmatter,
    body: String,
) -> Result<Note, String> {
    let repo = PathBuf::from(repo_root);
    let path = note_path(&repo, scope, bucket, id);
    let raw = assemble(&frontmatter, &body);
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent)
            .map_err(|e| format!("mkdir {}: {}", parent.display(), e))?;
    }
    let tmp = path.with_extension("md.tmp");
    fs::write(&tmp, raw.as_bytes()).map_err(|e| format!("write tmp: {}", e))?;
    fs::rename(&tmp, &path).map_err(|e| format!("rename: {}", e))?;

    crate::cmd_notes_sync::publish_note_upsert(repo_root, scope, bucket, id, &raw, &frontmatter);

    Ok(Note {
        id: id.to_string(),
        scope: scope.clone(),
        bucket: bucket.to_string(),
        frontmatter,
        body,
        raw,
    })
}

/// Archive or un-archive a page. Sets `archived_at` to now (RFC3339) when
/// `archived` is true, clears it otherwise, bumps `updated_at`, and writes +
/// publishes. The frontend splits Active/Archived off this field; the backend
/// never hides archived pages from `notes_list`.
#[tauri::command]
pub async fn notes_archive(
    repo_root: String,
    scope: NoteScope,
    bucket: String,
    id: String,
    archived: bool,
) -> Result<Note, String> {
    let repo = PathBuf::from(&repo_root);
    let (mut frontmatter, body) = load_note(&repo, &scope, &bucket, &id)?;
    let now = now_iso();
    frontmatter.archived_at = if archived { Some(now.clone()) } else { None };
    frontmatter.updated_at = Some(now);
    write_note_meta(&repo_root, &scope, &bucket, &id, frontmatter, body)
}

/// Move a page in the tree by setting (or clearing, with `None`) its
/// `parent_id`, then writing + publishing. Rejects a self-parent
/// (`id == parent_id`); deeper cycle detection is the frontend's job.
#[tauri::command]
pub async fn notes_set_parent(
    repo_root: String,
    scope: NoteScope,
    bucket: String,
    id: String,
    parent_id: Option<String>,
) -> Result<Note, String> {
    if parent_id.as_deref() == Some(id.as_str()) {
        return Err("a page cannot be its own parent".to_string());
    }
    let repo = PathBuf::from(&repo_root);
    let (mut frontmatter, body) = load_note(&repo, &scope, &bucket, &id)?;
    frontmatter.parent_id = parent_id;
    frontmatter.updated_at = Some(now_iso());
    write_note_meta(&repo_root, &scope, &bucket, &id, frontmatter, body)
}

/// File a page into a folder (`folder_id = Some`) or move it back to the root
/// (`folder_id = None`), then write + publish through the shared metadata path.
/// Exposed for the `cmd_note_folders` module so the page frontmatter stays the
/// single source of truth for folder membership.
pub fn set_note_folder(
    repo_root: &str,
    scope: &NoteScope,
    bucket: &str,
    id: &str,
    folder_id: Option<String>,
) -> Result<Note, String> {
    let repo = PathBuf::from(repo_root);
    let (mut frontmatter, body) = load_note(&repo, scope, bucket, id)?;
    frontmatter.folder = folder_id;
    frontmatter.updated_at = Some(now_iso());
    write_note_meta(repo_root, scope, bucket, id, frontmatter, body)
}

/// Move every page in a scope/bucket that currently sits in `folder_id` back to
/// the root (clearing its `folder` field). Used when a folder is deleted —
/// pages are NEVER removed, only un-filed. Returns the ids of the pages moved.
pub fn clear_folder_on_pages(
    repo_root: &str,
    scope: &NoteScope,
    bucket: &str,
    folder_id: &str,
) -> Result<Vec<String>, String> {
    let repo = PathBuf::from(repo_root);
    let dir = scope_dir(&repo, scope, bucket);
    if !dir.exists() {
        return Ok(Vec::new());
    }
    let entries = match fs::read_dir(&dir) {
        Ok(e) => e,
        Err(_) => return Ok(Vec::new()),
    };
    let mut moved = Vec::new();
    for entry in entries.flatten() {
        let path = entry.path();
        if path.extension().and_then(|s| s.to_str()) != Some("md") {
            continue;
        }
        let Some(id) = path.file_stem().map(|s| s.to_string_lossy().to_string()) else {
            continue;
        };
        let Ok((fm, _)) = load_note(&repo, scope, bucket, &id) else {
            continue;
        };
        if fm.folder.as_deref() == Some(folder_id) {
            set_note_folder(repo_root, scope, bucket, &id, None)?;
            moved.push(id);
        }
    }
    moved.sort();
    Ok(moved)
}

// ---------------------------------------------------------------------
// KK.2 — wiki triad: [[wikilinks]] resolution, backlinks, FTS
// ---------------------------------------------------------------------
//
// Notes live as .md files under `.aura/notes/...` so there is no SQL
// FTS5 to lean on — we walk the tree once per query. That's fine for
// the realistic note count (low thousands at most); when it stops
// being fine we'll add a sidecar index but not before.
//
// `notes_backlinks(repo_root, target)` — return every note that mentions
//     `[[target]]` (case-insensitive title match).
// `notes_search(repo_root, query, limit)` — substring search across all
//     bodies, returning a NoteSummary + snippet around the first hit.

#[derive(Deserialize)]
pub struct NotesBacklinksInput {
    pub repo_root: String,
    /// Target title to find references to. Case-insensitive.
    pub title: String,
}

#[derive(Deserialize)]
pub struct NotesSearchInput {
    pub repo_root: String,
    pub query: String,
    #[serde(default)]
    pub limit: Option<u32>,
}

#[derive(Clone, Debug, Serialize)]
pub struct NoteSearchHit {
    pub note: NoteSummary,
    /// ~120-char window around the first match.
    pub snippet: String,
    pub match_count: u32,
}

/// Walk all notes under `.aura/notes/**.md` and return summaries paired
/// with their on-disk body so callers can scan without re-reading.
fn walk_all_notes(repo_root: &Path) -> Vec<(NoteSummary, String)> {
    let root = notes_root(repo_root);
    if !root.exists() {
        return Vec::new();
    }
    let mut out = Vec::new();
    for scope in [NoteScope::Team, NoteScope::Channel, NoteScope::Member] {
        let scope_root = root.join(scope.dir_name());
        if !scope_root.exists() {
            continue;
        }
        match scope {
            NoteScope::Team => collect_with_bodies(&scope_root, scope, String::new(), &mut out),
            NoteScope::Channel | NoteScope::Member => {
                let entries = match fs::read_dir(&scope_root) {
                    Ok(e) => e,
                    Err(_) => continue,
                };
                for entry in entries.flatten() {
                    let path = entry.path();
                    if !path.is_dir() {
                        continue;
                    }
                    let bucket = entry.file_name().to_string_lossy().to_string();
                    collect_with_bodies(&path, scope.clone(), bucket, &mut out);
                }
            }
        }
    }
    out
}

fn collect_with_bodies(
    dir: &Path,
    scope: NoteScope,
    bucket: String,
    out: &mut Vec<(NoteSummary, String)>,
) {
    let entries = match fs::read_dir(dir) {
        Ok(e) => e,
        Err(_) => return,
    };
    for entry in entries.flatten() {
        let path = entry.path();
        if path.extension().and_then(|s| s.to_str()) != Some("md") {
            continue;
        }
        let bytes = match fs::read(&path) {
            Ok(b) => b,
            Err(_) => continue,
        };
        let raw = String::from_utf8_lossy(&bytes).to_string();
        let (_fm, body) = split_frontmatter(&raw);
        if let Some(summary) = read_summary(&path, scope.clone(), bucket.clone()) {
            out.push((summary, body));
        }
    }
}

#[tauri::command]
pub async fn notes_backlinks(input: NotesBacklinksInput) -> Result<Vec<NoteSummary>, String> {
    let repo = PathBuf::from(&input.repo_root);
    let target = input.title.trim().to_lowercase();
    if target.is_empty() {
        return Ok(Vec::new());
    }
    let mut out = Vec::new();
    for (summary, body) in walk_all_notes(&repo) {
        // Skip self-references — a note shouldn't show up in its own
        // backlinks panel.
        if summary.title.to_lowercase() == target {
            continue;
        }
        // Scan for [[Anything matching target]] case-insensitively.
        // We don't pre-compile a regex because the per-note body
        // is usually short and we'd rather avoid the regex dep
        // surface here.
        let lower = body.to_lowercase();
        let mut found = false;
        let mut idx = 0;
        while let Some(pos) = lower[idx..].find("[[") {
            let start = idx + pos + 2;
            let Some(end_rel) = lower[start..].find("]]") else {
                break;
            };
            let inner = lower[start..start + end_rel].trim();
            if inner == target {
                found = true;
                break;
            }
            idx = start + end_rel + 2;
        }
        if found {
            out.push(summary);
        }
    }
    // Newest-first, matches notes_list ordering.
    out.sort_by(|a, b| {
        b.updated_at
            .cmp(&a.updated_at)
            .then_with(|| a.id.cmp(&b.id))
    });
    Ok(out)
}

#[tauri::command]
pub async fn notes_search(input: NotesSearchInput) -> Result<Vec<NoteSearchHit>, String> {
    let repo = PathBuf::from(&input.repo_root);
    let query = input.query.trim();
    if query.is_empty() {
        return Ok(Vec::new());
    }
    let q_lower = query.to_lowercase();
    let limit = input.limit.unwrap_or(50).min(500) as usize;
    let mut out = Vec::new();
    for (summary, body) in walk_all_notes(&repo) {
        let body_lower = body.to_lowercase();
        let title_lower = summary.title.to_lowercase();
        let in_title = title_lower.contains(&q_lower);
        let mut match_count = 0u32;
        let mut idx = 0;
        while let Some(pos) = body_lower[idx..].find(&q_lower) {
            match_count += 1;
            idx += pos + q_lower.len();
        }
        if !in_title && match_count == 0 {
            continue;
        }
        // Snippet — first body hit with ~60 chars on each side; if the
        // match is only in the title, snippet falls back to the body's
        // first 120 chars.
        let snippet = if let Some(first_hit) = body_lower.find(&q_lower) {
            let start = first_hit.saturating_sub(60);
            let end = (first_hit + q_lower.len() + 60).min(body.len());
            let mut s = body[start..end].to_string();
            if start > 0 {
                s.insert_str(0, "…");
            }
            if end < body.len() {
                s.push('…');
            }
            s
        } else {
            body.chars().take(120).collect::<String>()
        };
        out.push(NoteSearchHit {
            note: summary,
            snippet,
            match_count: match_count + if in_title { 1 } else { 0 },
        });
        if out.len() >= limit {
            break;
        }
    }
    // Order: title hits first (match_count includes +1 for title), then
    // by match count desc, then by recency.
    out.sort_by(|a, b| {
        b.match_count
            .cmp(&a.match_count)
            .then_with(|| b.note.updated_at.cmp(&a.note.updated_at))
    });
    Ok(out)
}

#[tauri::command]
pub async fn notes_delete(input: NoteDeleteInput) -> Result<(), String> {
    let repo = PathBuf::from(&input.repo_root);
    let path = note_path(&repo, &input.scope, &input.bucket, &input.id);
    if !path.exists() {
        return Err(format!("note not found: {}", path.display()));
    }
    // Read visibility BEFORE removing — the broadcast gate needs to know
    // whether this was a shared page (only shared pages travel the rail).
    let shareable = fs::read(&path)
        .ok()
        .map(|b| split_frontmatter(&String::from_utf8_lossy(&b)).0)
        .map(|fm| is_shareable(&input.scope, &fm))
        .unwrap_or(false);
    fs::remove_file(&path).map_err(|e| format!("remove {}: {}", path.display(), e))?;
    if shareable {
        crate::cmd_notes_sync::publish_note_delete(
            &input.repo_root,
            &input.scope,
            &input.bucket,
            &input.id,
        );
    }
    Ok(())
}

// ─── Live-sync merge (#219 — see cmd_notes_sync / docs/plan/30) ──────────
//
// Pages, unlike tasks, are plain `.md` files committed to git, so they can
// also travel over git. The live rail adds *real-time* cross-member sync on
// top: each shared note's `notes_write`/`notes_delete` publishes a JSON
// envelope (carrying the full file `raw` + `updated_at`) on a reserved chat
// channel, and `pages_sync_poll` LWW-merges inbound envelopes here. The
// merge is per-file (no single load/save like tasks) but mirrors the same
// last-writer-wins + in-batch tombstone discipline.

/// One page mutation pulled off the rail. The `raw` on `Upsert` is the full
/// on-disk file text (frontmatter sandwich + body); `ts` is the LWW key
/// (the note's `updated_at` for upserts, the delete moment for deletes).
pub(crate) enum RemoteNoteOp {
    Upsert {
        scope: NoteScope,
        bucket: String,
        id: String,
        raw: String,
        ts: String,
    },
    Delete {
        scope: NoteScope,
        bucket: String,
        id: String,
        ts: String,
    },
}

/// Compare two RFC3339 timestamps chronologically, falling back to a lexical
/// compare when either fails to parse (lexical order matches chronological
/// order for fixed-precision RFC3339). Mirrors `cmd_tasks::rfc3339_cmp`;
/// duplicated rather than shared to keep the notes module self-contained.
fn rfc3339_cmp(a: &str, b: &str) -> std::cmp::Ordering {
    match (
        chrono::DateTime::parse_from_rfc3339(a),
        chrono::DateTime::parse_from_rfc3339(b),
    ) {
        (Ok(da), Ok(db)) => da.cmp(&db),
        _ => a.cmp(b),
    }
}

/// A note broadcasts over the live rail only when it is shared. Member-scope
/// notes are private drafts unless an explicit `visibility:"shared"` opts in;
/// Team/Channel default to shared. Matches the default in `read_summary`.
pub(crate) fn is_shareable(scope: &NoteScope, fm: &NoteFrontmatter) -> bool {
    let vis = fm.visibility.clone().unwrap_or_else(|| match scope {
        NoteScope::Member => "private".to_string(),
        _ => "shared".to_string(),
    });
    vis == "shared"
}

/// Composite identity for a note across scope/bucket/id, used to key the
/// in-batch tombstone map.
fn note_key(scope: &NoteScope, bucket: &str, id: &str) -> String {
    format!("{}/{}/{}", scope.dir_name(), bucket, id)
}

/// On-disk `updated_at` for a note, or `None` if the file is absent or has no
/// frontmatter timestamp — the LWW comparison treats `None` as "older than
/// any remote write" so a missing local copy always accepts the inbound one.
fn local_updated_at(repo_root: &Path, scope: &NoteScope, bucket: &str, id: &str) -> Option<String> {
    let path = note_path(repo_root, scope, bucket, id);
    let bytes = fs::read(&path).ok()?;
    let (fm, _) = split_frontmatter(&String::from_utf8_lossy(&bytes));
    fm.updated_at
}

/// Atomically write the full raw file text for a note (tmp + rename), the
/// same durability path `notes_write` uses.
fn write_raw(
    repo_root: &Path,
    scope: &NoteScope,
    bucket: &str,
    id: &str,
    raw: &str,
) -> Result<(), String> {
    let path = note_path(repo_root, scope, bucket, id);
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).map_err(|e| format!("mkdir {}: {}", parent.display(), e))?;
    }
    let tmp = path.with_extension("md.tmp");
    fs::write(&tmp, raw.as_bytes()).map_err(|e| format!("write tmp: {}", e))?;
    fs::rename(&tmp, &path).map_err(|e| format!("rename: {}", e))?;
    Ok(())
}

/// Apply a seq-ordered batch of remote page mutations LWW into the notes
/// tree. Per-file (no global load/save): each upsert compares the inbound
/// `ts` against the note's local `updated_at` and only overwrites when
/// strictly newer; each delete removes the file unless a strictly newer
/// local edit wins. An in-batch tombstone map stops an earlier upsert from
/// resurrecting a page a later delete removed, while a *newer*-timestamped
/// upsert after a delete legitimately re-creates it. Returns
/// `(applied_ids, removed_ids)`.
pub(crate) fn apply_remote_note_batch(
    repo_root: &Path,
    ops: Vec<RemoteNoteOp>,
) -> Result<(Vec<String>, Vec<String>), String> {
    if ops.is_empty() {
        return Ok((Vec::new(), Vec::new()));
    }
    let mut applied: Vec<String> = Vec::new();
    let mut removed: Vec<String> = Vec::new();
    // composite key -> delete timestamp seen earlier in this same batch.
    let mut tombstones: std::collections::HashMap<String, String> =
        std::collections::HashMap::new();

    for op in ops {
        match op {
            RemoteNoteOp::Upsert {
                scope,
                bucket,
                id,
                raw,
                ts,
            } => {
                let key = note_key(&scope, &bucket, &id);
                if let Some(dts) = tombstones.get(&key) {
                    if rfc3339_cmp(&ts, dts) != std::cmp::Ordering::Greater {
                        continue;
                    }
                    tombstones.remove(&key);
                }
                let should_write = match local_updated_at(repo_root, &scope, &bucket, &id) {
                    Some(lts) => rfc3339_cmp(&ts, &lts) == std::cmp::Ordering::Greater,
                    None => true,
                };
                if should_write {
                    write_raw(repo_root, &scope, &bucket, &id, &raw)?;
                    applied.push(id);
                }
            }
            RemoteNoteOp::Delete {
                scope,
                bucket,
                id,
                ts,
            } => {
                let key = note_key(&scope, &bucket, &id);
                let path = note_path(repo_root, &scope, &bucket, &id);
                if path.exists() {
                    let local_newer = match local_updated_at(repo_root, &scope, &bucket, &id) {
                        Some(lts) => rfc3339_cmp(&lts, &ts) == std::cmp::Ordering::Greater,
                        None => false,
                    };
                    if !local_newer {
                        fs::remove_file(&path)
                            .map_err(|e| format!("remove {}: {}", path.display(), e))?;
                        removed.push(id.clone());
                    }
                }
                tombstones.insert(key, ts);
            }
        }
    }

    Ok((applied, removed))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn tmp_repo(name: &str) -> PathBuf {
        let mut p = std::env::temp_dir();
        p.push(format!("aura-notes-sync-{}-{}", name, uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&p).unwrap();
        p
    }

    /// Seed a note on disk with a given body + `updated_at`, the way
    /// `notes_write` would have left it.
    fn seed(repo: &Path, scope: &NoteScope, bucket: &str, id: &str, body: &str, updated: &str) {
        let fm = NoteFrontmatter {
            title: Some(id.to_string()),
            updated_at: Some(updated.to_string()),
            created_at: Some(updated.to_string()),
            ..NoteFrontmatter::default()
        };
        write_raw(repo, scope, bucket, id, &assemble(&fm, body)).unwrap();
    }

    /// Build the raw text an upsert envelope would carry for `body`/`ts`.
    fn raw_for(id: &str, body: &str, ts: &str) -> String {
        let fm = NoteFrontmatter {
            title: Some(id.to_string()),
            updated_at: Some(ts.to_string()),
            created_at: Some(ts.to_string()),
            ..NoteFrontmatter::default()
        };
        assemble(&fm, body)
    }

    fn body_on_disk(repo: &Path, scope: &NoteScope, bucket: &str, id: &str) -> String {
        let bytes = fs::read(note_path(repo, scope, bucket, id)).unwrap();
        split_frontmatter(&String::from_utf8_lossy(&bytes)).1
    }

    #[test]
    fn note_upsert_inserts_when_absent() {
        let repo = tmp_repo("ins");
        let (applied, removed) = apply_remote_note_batch(
            &repo,
            vec![RemoteNoteOp::Upsert {
                scope: NoteScope::Team,
                bucket: String::new(),
                id: "n1".into(),
                raw: raw_for("n1", "hello", "2026-02-01T00:00:00Z"),
                ts: "2026-02-01T00:00:00Z".into(),
            }],
        )
        .unwrap();
        assert_eq!(applied, vec!["n1".to_string()]);
        assert!(removed.is_empty());
        assert_eq!(body_on_disk(&repo, &NoteScope::Team, "", "n1").trim(), "hello");
    }

    #[test]
    fn note_lww_skips_older_upsert() {
        let repo = tmp_repo("old");
        seed(&repo, &NoteScope::Team, "", "n1", "current", "2026-02-02T00:00:00Z");
        let (applied, _) = apply_remote_note_batch(
            &repo,
            vec![RemoteNoteOp::Upsert {
                scope: NoteScope::Team,
                bucket: String::new(),
                id: "n1".into(),
                raw: raw_for("n1", "stale", "2026-02-01T00:00:00Z"),
                ts: "2026-02-01T00:00:00Z".into(),
            }],
        )
        .unwrap();
        assert!(applied.is_empty());
        assert_eq!(body_on_disk(&repo, &NoteScope::Team, "", "n1").trim(), "current");
    }

    #[test]
    fn note_lww_replaces_newer_upsert() {
        let repo = tmp_repo("new");
        seed(&repo, &NoteScope::Channel, "general", "n1", "old", "2026-02-01T00:00:00Z");
        let (applied, _) = apply_remote_note_batch(
            &repo,
            vec![RemoteNoteOp::Upsert {
                scope: NoteScope::Channel,
                bucket: "general".into(),
                id: "n1".into(),
                raw: raw_for("n1", "fresh", "2026-02-03T00:00:00Z"),
                ts: "2026-02-03T00:00:00Z".into(),
            }],
        )
        .unwrap();
        assert_eq!(applied, vec!["n1".to_string()]);
        assert_eq!(body_on_disk(&repo, &NoteScope::Channel, "general", "n1").trim(), "fresh");
    }

    #[test]
    fn note_delete_removes_present() {
        let repo = tmp_repo("del");
        seed(&repo, &NoteScope::Team, "", "n1", "doomed", "2026-02-01T00:00:00Z");
        let (_, removed) = apply_remote_note_batch(
            &repo,
            vec![RemoteNoteOp::Delete {
                scope: NoteScope::Team,
                bucket: String::new(),
                id: "n1".into(),
                ts: "2026-02-02T00:00:00Z".into(),
            }],
        )
        .unwrap();
        assert_eq!(removed, vec!["n1".to_string()]);
        assert!(!note_path(&repo, &NoteScope::Team, "", "n1").exists());
    }

    #[test]
    fn note_local_edit_newer_than_delete_survives() {
        let repo = tmp_repo("surv");
        seed(&repo, &NoteScope::Team, "", "n1", "kept", "2026-02-05T00:00:00Z");
        let (_, removed) = apply_remote_note_batch(
            &repo,
            vec![RemoteNoteOp::Delete {
                scope: NoteScope::Team,
                bucket: String::new(),
                id: "n1".into(),
                ts: "2026-02-01T00:00:00Z".into(),
            }],
        )
        .unwrap();
        assert!(removed.is_empty());
        assert!(note_path(&repo, &NoteScope::Team, "", "n1").exists());
    }

    #[test]
    fn note_in_batch_tombstone_blocks_stale_resurrect() {
        let repo = tmp_repo("tomb");
        // Delete then an OLDER upsert in the same batch must not resurrect.
        let (applied, removed) = apply_remote_note_batch(
            &repo,
            vec![
                RemoteNoteOp::Delete {
                    scope: NoteScope::Team,
                    bucket: String::new(),
                    id: "n1".into(),
                    ts: "2026-02-02T00:00:00Z".into(),
                },
                RemoteNoteOp::Upsert {
                    scope: NoteScope::Team,
                    bucket: String::new(),
                    id: "n1".into(),
                    raw: raw_for("n1", "zombie", "2026-02-01T00:00:00Z"),
                    ts: "2026-02-01T00:00:00Z".into(),
                },
            ],
        )
        .unwrap();
        assert!(applied.is_empty());
        assert!(removed.is_empty()); // nothing was present to remove
        assert!(!note_path(&repo, &NoteScope::Team, "", "n1").exists());
    }

    #[test]
    fn note_in_batch_newer_upsert_after_delete_resurrects() {
        let repo = tmp_repo("resur");
        let (applied, _) = apply_remote_note_batch(
            &repo,
            vec![
                RemoteNoteOp::Delete {
                    scope: NoteScope::Team,
                    bucket: String::new(),
                    id: "n1".into(),
                    ts: "2026-02-01T00:00:00Z".into(),
                },
                RemoteNoteOp::Upsert {
                    scope: NoteScope::Team,
                    bucket: String::new(),
                    id: "n1".into(),
                    raw: raw_for("n1", "reborn", "2026-02-03T00:00:00Z"),
                    ts: "2026-02-03T00:00:00Z".into(),
                },
            ],
        )
        .unwrap();
        assert_eq!(applied, vec!["n1".to_string()]);
        assert_eq!(body_on_disk(&repo, &NoteScope::Team, "", "n1").trim(), "reborn");
    }

    #[test]
    fn shareable_gate_matches_visibility_defaults() {
        let default_fm = NoteFrontmatter::default();
        // Member drafts are private by default; team/channel default shared.
        assert!(!is_shareable(&NoteScope::Member, &default_fm));
        assert!(is_shareable(&NoteScope::Team, &default_fm));
        assert!(is_shareable(&NoteScope::Channel, &default_fm));
        // Explicit opt-in surfaces a member note; explicit opt-out hides a team one.
        let shared = NoteFrontmatter {
            visibility: Some("shared".into()),
            ..NoteFrontmatter::default()
        };
        let private = NoteFrontmatter {
            visibility: Some("private".into()),
            ..NoteFrontmatter::default()
        };
        assert!(is_shareable(&NoteScope::Member, &shared));
        assert!(!is_shareable(&NoteScope::Team, &private));
    }

    #[test]
    fn page_mentions_match_frontend_rules() {
        // Start-of-string, whitespace, and bracket prefixes all open a mention;
        // emails do not; result is lowercased + de-duplicated + order-preserving.
        assert_eq!(extract_page_mentions("@bob ship it"), vec!["bob"]);
        assert_eq!(extract_page_mentions("(@carol) [@dave]"), vec!["carol", "dave"]);
        assert_eq!(extract_page_mentions("hey @a.b_c-d here"), vec!["a.b_c-d"]);
        assert!(extract_page_mentions("ping x@y.com now").is_empty());
        assert_eq!(
            extract_page_mentions("@Bob @alice @BOB"),
            vec!["bob", "alice"]
        );
    }

    #[tokio::test]
    async fn archive_sets_and_clears_timestamp() {
        let repo = tmp_repo("arch");
        seed(&repo, &NoteScope::Team, "", "n1", "body", "2026-02-01T00:00:00Z");
        let note = notes_archive(
            repo.to_string_lossy().to_string(),
            NoteScope::Team,
            String::new(),
            "n1".into(),
            true,
        )
        .await
        .unwrap();
        assert!(note.frontmatter.archived_at.is_some());
        let (fm, _) = load_note(&repo, &NoteScope::Team, "", "n1").unwrap();
        assert!(fm.archived_at.is_some());

        let note = notes_archive(
            repo.to_string_lossy().to_string(),
            NoteScope::Team,
            String::new(),
            "n1".into(),
            false,
        )
        .await
        .unwrap();
        assert!(note.frontmatter.archived_at.is_none());
    }

    #[tokio::test]
    async fn set_parent_rejects_self_and_sets_otherwise() {
        let repo = tmp_repo("parent");
        seed(&repo, &NoteScope::Team, "", "child", "body", "2026-02-01T00:00:00Z");
        // Self-parent is rejected.
        let err = notes_set_parent(
            repo.to_string_lossy().to_string(),
            NoteScope::Team,
            String::new(),
            "child".into(),
            Some("child".into()),
        )
        .await;
        assert!(err.is_err());
        // A real parent is written, and `None` clears it back to a root page.
        let note = notes_set_parent(
            repo.to_string_lossy().to_string(),
            NoteScope::Team,
            String::new(),
            "child".into(),
            Some("root".into()),
        )
        .await
        .unwrap();
        assert_eq!(note.frontmatter.parent_id.as_deref(), Some("root"));
        let note = notes_set_parent(
            repo.to_string_lossy().to_string(),
            NoteScope::Team,
            String::new(),
            "child".into(),
            None,
        )
        .await
        .unwrap();
        assert!(note.frontmatter.parent_id.is_none());
    }
}
