//! Agent mutation guard (v0.2.11+).
//!
//! When a coding-agent CLI (Claude Code / Gemini / Codex / OpenCode / …)
//! runs inside an Aura PTY tab and edits a file in the workspace, that
//! mutation MUST be explained by a freshly-logged `aura_log_intent`
//! entry. If the file changes without a covering intent and an agent
//! process was alive nearby in time, this module emits
//! `aura:agent-mutation-unattributed` to the frontend so the user can
//! revert or accept the change.
//!
//! Why a separate module from `cmd_watcher.rs`:
//!   * cmd_watcher fires `fs:changed` to refresh editor buffers — it's
//!     a hot UI path with a 200ms debounce.
//!   * this guard runs slower (best-effort) and reads `.aura/` state
//!     per event, so it shouldn't share the same closure or budget.
//!   * the constraint sheet asks for an isolated subscriber instead
//!     of rewriting the existing watcher.
//!
//! Heuristic stack (in order, conservative — false negatives over
//! false positives):
//!
//!   1. Hard-ignore VCS internals, build dirs, .aura/, editor temps.
//!      Most repos generate megabytes of churn here per second.
//!   2. Honor `.gitignore` via `git check-ignore`.
//!   3. If the path was just written by the in-app editor (`write_file`
//!      / `fs_*` Tauri commands) within `EDITOR_GRACE_MS`, skip — the
//!      human typed that themselves and the editor flow handles intent
//!      via the save-sync gate.
//!   4. If `.aura/intent_log.jsonl` has a row with `timestamp >= now -
//!      INTENT_WINDOW_S` (and either no changeset, a changeset covering
//!      this path, or any ancestor of this path), the change is
//!      attributed. Skip.
//!   5. If no agent PTY is alive in this workspace right now, skip —
//!      we don't guard plain-shell commands the user typed; the user
//!      owns those.
//!   6. Otherwise emit `aura:agent-mutation-unattributed`.

use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::Arc;
use std::sync::Mutex;
use std::sync::OnceLock;
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use notify::{Event, EventKind, RecommendedWatcher, RecursiveMode, Watcher};
use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter, Manager, State};

use crate::cmd_agent_pty::AgentPtyRegistry;

/// Cooldown between PTY nudges for the same session. Once we've asked
/// an agent to log intent, sit on further reminders for this long so
/// the prompt isn't drowned in self-repeating noise — the agent gets
/// time to read and respond.
const NUDGE_COOLDOWN_MS: u64 = 20_000;

/// Per-session "last nudge sent at" so the cooldown applies regardless
/// of how many files trigger nudges back-to-back.
fn nudge_clock() -> &'static Mutex<HashMap<String, Instant>> {
    static CLOCK: OnceLock<Mutex<HashMap<String, Instant>>> = OnceLock::new();
    CLOCK.get_or_init(|| Mutex::new(HashMap::new()))
}

/// How long after `aura_log_intent` we treat a mutation as covered.
/// Wide enough for an agent to log intent → make the edit through its
/// tool stack → have the FS event fire on us, tight enough that a
/// stale intent from minutes ago doesn't cover a brand-new rogue write.
const INTENT_WINDOW_S: i64 = 30;

/// How long after the in-app editor wrote a path we treat any FS event
/// on that path as the user, not an agent. Matches the longest typical
/// gap between Monaco's save and notify's event under load.
const EDITOR_GRACE_MS: u64 = 3_000;

/// Per-event debounce. notify fires 3-5 events per editor save; we
/// only emit at most one banner per path per window.
const EVENT_DEBOUNCE_MS: u64 = 1_500;

/// Tracker of recent writes performed through Aura's own filesystem
/// commands (`write_file`, `fs_create_file`, `fs_rename`, `fs_delete`).
/// These are by definition *human-initiated* — the user clicked Save
/// in Monaco or clicked Delete in the file tree — so any FS event for
/// the same path within `EDITOR_GRACE_MS` is filtered out of the guard.
#[derive(Default)]
pub struct EditorWriteTracker {
    inner: Mutex<HashMap<PathBuf, Instant>>,
}

impl EditorWriteTracker {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn stamp<P: Into<PathBuf>>(&self, path: P) {
        let now = Instant::now();
        if let Ok(mut map) = self.inner.lock() {
            map.insert(path.into(), now);
            // Opportunistic GC: prune entries older than 60s so the map
            // doesn't grow unbounded across a long session.
            map.retain(|_, t| now.duration_since(*t) < Duration::from_secs(60));
        }
    }

    fn was_recent(&self, path: &std::path::Path) -> bool {
        let Ok(map) = self.inner.lock() else {
            return false;
        };
        let Some(t) = map.get(path) else {
            return false;
        };
        Instant::now().duration_since(*t) < Duration::from_millis(EDITOR_GRACE_MS)
    }
}

/// One running guard per workspace root.
struct GuardEntry {
    #[allow(dead_code)]
    watcher: RecommendedWatcher,
}

#[derive(Default)]
pub struct GuardRegistry {
    by_root: Mutex<HashMap<String, GuardEntry>>,
}

impl GuardRegistry {
    pub fn new() -> Self {
        Self::default()
    }
}

#[derive(Serialize, Clone)]
pub struct UnattributedMutation {
    pub path: String,
    /// "create" | "modify" | "remove"
    pub kind: &'static str,
    /// Best-guess agent that owns the change. Empty if multiple agents
    /// are alive (we don't pick one) or if attribution is purely
    /// time-based.
    pub agent_id: String,
    /// Comma-separated list of all live agent ids in the workspace at
    /// detection time. Useful for the banner subtitle.
    pub live_agents: String,
    /// Unix seconds of detection.
    pub ts: i64,
    /// Stable id so the React side can de-dupe across renders.
    pub event_id: String,
}

#[tauri::command]
pub async fn agent_guard_start(
    repo_root: String,
    app: AppHandle,
    state: State<'_, GuardRegistry>,
    _agents: State<'_, AgentPtyRegistry>,
) -> Result<(), String> {
    {
        let map = state.by_root.lock().unwrap();
        if map.contains_key(&repo_root) {
            return Ok(());
        }
    }

    let root_path = PathBuf::from(&repo_root);
    if !root_path.is_dir() {
        return Err(format!("not a directory: {repo_root}"));
    }

    let app_for_cb = app.clone();
    let repo_for_cb = repo_root.clone();
    let last_emit: Arc<Mutex<HashMap<PathBuf, Instant>>> =
        Arc::new(Mutex::new(HashMap::new()));

    let mut watcher: RecommendedWatcher = notify::recommended_watcher(
        move |res: Result<Event, notify::Error>| {
            let Ok(ev) = res else { return };
            let kind = classify(&ev.kind);
            if kind == "other" {
                // Access-only / metadata-touch events don't represent a
                // content change — never useful for the guard.
                return;
            }
            for raw in ev.paths {
                if is_ignored(&raw, &repo_for_cb) {
                    continue;
                }

                // Debounce per path.
                {
                    let mut emit_map = last_emit.lock().unwrap();
                    let now = Instant::now();
                    if let Some(prev) = emit_map.get(&raw) {
                        if now.duration_since(*prev)
                            < Duration::from_millis(EVENT_DEBOUNCE_MS)
                        {
                            continue;
                        }
                    }
                    emit_map.insert(raw.clone(), now);
                }

                // Hand the rest off to async so we don't block the
                // notify thread on `git check-ignore` or JSONL parse.
                let app2 = app_for_cb.clone();
                let repo2 = repo_for_cb.clone();
                let path2 = raw.clone();
                tauri::async_runtime::spawn(async move {
                    evaluate_event(app2, repo2, path2, kind).await;
                });
            }
        },
    )
    .map_err(|e| format!("guard watcher init failed: {e}"))?;

    watcher
        .watch(&root_path, RecursiveMode::Recursive)
        .map_err(|e| format!("guard watch failed: {e}"))?;

    state
        .by_root
        .lock()
        .unwrap()
        .insert(repo_root, GuardEntry { watcher });
    Ok(())
}

#[tauri::command]
pub async fn agent_guard_stop(
    repo_root: String,
    state: State<'_, GuardRegistry>,
) -> Result<(), String> {
    state.by_root.lock().unwrap().remove(&repo_root);
    Ok(())
}

/// Restore a file from its most-recent snapshot in
/// `<repo>/.aura/snapshots/`. Reads the JSON blob, writes `content`
/// back to `file_path`. Returns `Ok(snapshot_id)` on success so the UI
/// can surface "reverted to snapshot <id>".
///
/// This is the v1 of "Revert" on the unattributed-mutation banner. The
/// `aura rewind` CLI works at function granularity and needs an
/// identifier; for whole-file revert there's no existing entry point,
/// so the guard hosts this one.
#[tauri::command]
pub async fn agent_guard_revert_from_snapshot(
    repo_root: String,
    file_path: String,
) -> Result<String, String> {
    let abs = if PathBuf::from(&file_path).is_absolute() {
        PathBuf::from(&file_path)
    } else {
        PathBuf::from(&repo_root).join(&file_path)
    };
    let abs_str = abs.to_string_lossy().into_owned();

    let snap_dir = PathBuf::from(&repo_root).join(".aura").join("snapshots");
    if !snap_dir.is_dir() {
        return Err("no .aura/snapshots directory — nothing to restore".into());
    }

    let mut best: Option<(i64, PathBuf, String)> = None;
    let entries = std::fs::read_dir(&snap_dir).map_err(|e| e.to_string())?;
    for entry in entries.flatten() {
        let p = entry.path();
        if p.extension().and_then(|s| s.to_str()) != Some("json") {
            continue;
        }
        let body = match std::fs::read_to_string(&p) {
            Ok(b) => b,
            Err(_) => continue,
        };
        let Ok(json) = serde_json::from_str::<serde_json::Value>(&body) else {
            continue;
        };
        let Some(fp) = json.get("file_path").and_then(|v| v.as_str()) else {
            continue;
        };
        if fp != abs_str {
            continue;
        }
        let Some(content) = json.get("content").and_then(|v| v.as_str()) else {
            continue;
        };
        let mtime = entry
            .metadata()
            .and_then(|m| m.modified())
            .ok()
            .and_then(|t| t.duration_since(UNIX_EPOCH).ok())
            .map(|d| d.as_secs() as i64)
            .unwrap_or(0);
        if best.as_ref().map(|(t, _, _)| mtime > *t).unwrap_or(true) {
            best = Some((mtime, p.clone(), content.to_string()));
        }
    }

    let Some((_, snap_path, content)) = best else {
        return Err(format!("no snapshot found for {abs_str}"));
    };

    // Stamp the editor-write tracker so the watcher doesn't re-fire
    // on the restore as another unattributed mutation.
    // The state is a process-global resource managed by Tauri — we use
    // the convention also followed elsewhere in this module: fetch via
    // app state passed through commands; here the call site already
    // knows it's a UI-initiated restore so we stamp from the frontend
    // via `markEditorWrite` (auto-called inside `writeFile`).
    std::fs::write(&abs, content).map_err(|e| format!("restore write failed: {e}"))?;

    let _ = crate::op_log::record_op(
        &repo_root,
        "guard_revert",
        &format!("Reverted {abs_str} from snapshot"),
        "aura-shell-guard",
        serde_json::json!({
            "snapshot_path": snap_path.to_string_lossy(),
            "file": abs_str,
        }),
    );

    Ok(snap_path
        .file_stem()
        .and_then(|s| s.to_str())
        .unwrap_or("")
        .to_string())
}

/// Frontend "Accept" flow calls this after the user types a one-line
/// intent. It snapshots the file (so we still have a rewind point if
/// they change their mind later) and appends the intent. Returns the
/// intent timestamp.
#[tauri::command]
pub async fn agent_guard_accept_with_intent(
    repo_root: String,
    file_path: String,
    intent: String,
    agent_id: Option<String>,
) -> Result<u64, String> {
    // Best-effort post-hoc snapshot — never block the accept on a
    // snapshot failure, the file is already mutated.
    let _ = crate::cmd_aura::aura_snapshot(repo_root.clone(), file_path.clone()).await;
    let changeset = Some(crate::cmd_aura::IntentChangeset {
        files: vec![crate::cmd_aura::IntentChangesetFile {
            path: file_path.clone(),
            status: "M".into(),
            additions: None,
            deletions: None,
            symbols: Vec::new(),
            commit: None,
            base: None,
        }],
        block_id: None,
        source: Some("guard_accept".into()),
        captured_at: None,
    });
    crate::cmd_aura::aura_log_intent(repo_root, intent, agent_id, changeset, None).await
}

/// Frontend "self-heal" flow calls this on every unattributed-mutation
/// event before deciding whether to surface the loud red banner. The
/// command:
///   1. Picks the most recently-active session in the repo.
///   2. Composes a one-line prompt telling the agent to run
///      `aura_log_intent` describing why the file changed.
///   3. Writes the prompt + newline straight into that agent's PTY.
///
/// Returns the (`session_id`, `agent_id`) of the session that got
/// nudged, or `None` if no session is alive in this repo (in which
/// case the frontend should fall back to the banner immediately).
///
/// This is "Manager nudges Claude" — the user doesn't see the
/// friction; the manager writes the prompt and the agent self-heals
/// in seconds. Only if the agent doesn't react in time does the
/// banner appear.
#[derive(Deserialize)]
pub struct NudgeFile {
    pub path: String,
    pub kind: String,
}

/// Coalesced nudge: take a batch of file changes and emit ONE prompt
/// listing all of them. The frontend buffers events over a short window
/// and calls this once — never once per file. Additionally, this
/// honors a per-session cooldown: if we wrote a nudge to the same PTY
/// within `NUDGE_COOLDOWN_MS`, return a `skipped` result instead of
/// spamming the prompt again. The agent gets time to read and respond.
#[tauri::command]
pub async fn agent_guard_self_heal_nudge(
    repo_root: String,
    files: Vec<NudgeFile>,
    agents: State<'_, AgentPtyRegistry>,
) -> Result<Option<NudgeResult>, String> {
    if files.is_empty() {
        return Ok(None);
    }
    let Some((session_id, agent_id)) = agents.latest_session_for_repo(&repo_root) else {
        return Ok(None);
    };

    // Cooldown gate — don't re-prompt the same session faster than the
    // agent can plausibly read + react to the previous nudge.
    {
        let mut clock = nudge_clock().lock().unwrap();
        if let Some(prev) = clock.get(&session_id) {
            if Instant::now().duration_since(*prev)
                < Duration::from_millis(NUDGE_COOLDOWN_MS)
            {
                return Ok(Some(NudgeResult {
                    session_id,
                    agent_id,
                    skipped: true,
                    file_count: files.len(),
                }));
            }
        }
        clock.insert(session_id.clone(), Instant::now());
    }

    // Build one human-friendly prompt covering all files at once.
    let mut created: Vec<String> = Vec::new();
    let mut modified: Vec<String> = Vec::new();
    let mut deleted: Vec<String> = Vec::new();
    for f in &files {
        let rel = std::path::Path::new(&f.path)
            .strip_prefix(&repo_root)
            .map(|p| p.to_string_lossy().into_owned())
            .unwrap_or_else(|_| f.path.clone());
        match f.kind.as_str() {
            "create" => created.push(rel),
            "remove" => deleted.push(rel),
            _ => modified.push(rel),
        }
    }

    let mut parts: Vec<String> = Vec::new();
    let render = |verb: &str, list: &[String]| -> String {
        if list.is_empty() {
            return String::new();
        }
        if list.len() == 1 {
            format!("{verb} `{}`", list[0])
        } else {
            let bullets = list
                .iter()
                .map(|p| format!("  - `{p}`"))
                .collect::<Vec<_>>()
                .join("\n");
            format!("{verb} {} files:\n{bullets}", list.len())
        }
    };
    let m = render("modified", &modified);
    if !m.is_empty() {
        parts.push(m);
    }
    let c = render("created", &created);
    if !c.is_empty() {
        parts.push(c);
    }
    let d = render("deleted", &deleted);
    if !d.is_empty() {
        parts.push(d);
    }
    let summary = parts.join("; ");

    // ── New nudge channel ─────────────────────────────────────────────
    // We no longer write into the PTY stdin. Stdin lands wherever the
    // cursor is, including in the user's half-typed prompt, which is
    // the contamination users reported. Instead we do two non-invasive
    // things:
    //
    //   1. Self-heal the guard *immediately* by logging a stub intent
    //      to .aura/intent_log.jsonl that covers exactly the files in
    //      this batch. The next FS event will see the fresh row,
    //      intent_covers() returns true, and the guard goes quiet —
    //      no more recurring nudges every 20s.
    //
    //   2. Queue a "please backfill" note to
    //      .aura/agent_pending_backfill.json. The aura-cli MCP server
    //      reads + clears this file on each tool dispatch and prepends
    //      the note to its tool reply, so the agent sees it in
    //      tool-result context (where it belongs) and never via stdin.

    let mut all_rels: Vec<String> = Vec::new();
    all_rels.extend(modified.iter().cloned());
    all_rels.extend(created.iter().cloned());
    all_rels.extend(deleted.iter().cloned());

    // (1) Auto-log a covering intent for these files. Resolve the live Claude
    // session first so the row carries BOTH a durable link to the conversation
    // AND its actual prompt as the reason. The guard only fires while an agent
    // is actively editing, so the freshest transcript IS this session's
    // (see newest_session_id_for_repo).
    let claude_sid = crate::cmd_claude_sessions::newest_session_id_for_repo(&repo_root);

    // The "why": the user's own words from this session, captured at edit time
    // so a file an external CLI touched no longer reads "no notes mention this
    // file" until a commit runs. When the transcript has no readable prompt yet
    // we fall back to an honest, plain-language line — never the old
    // "[auto] … backfill pending" text, which is engineer jargon that surfaced
    // verbatim in the non-engineer-facing "why" column.
    let session_prompt = claude_sid
        .as_deref()
        .and_then(|sid| crate::cmd_claude_sessions::latest_prompt_for_session(&repo_root, sid));
    // Resolve the "why", best source first:
    //   1. the live session's own prompt — the actual ask, most truthful;
    //   2. Aura's own brain reading the diff — the "if the agent didn't log
    //      intent, we do it with our brain" path, so a change never lands as
    //      a hollow, meaningless flag;
    //   3. an honest last-resort stub when even the brain can't be reached.
    let (stub_intent, stub_source) = match session_prompt {
        Some(reason) => (reason, "session_prompt"),
        None => match brain_infer_intent(&repo_root, &all_rels).await {
            Some(line) => (line, "brain_inferred"),
            None => (
                format!(
                    "{agent_id} edited {n} file(s) — reason not captured yet",
                    n = files.len(),
                ),
                "guard_auto_stub",
            ),
        },
    };
    // A brain-inferred line is a real reason too — only the bare stub counts
    // as "not captured" for the backfill note's wording.
    let captured_reason = stub_source != "guard_auto_stub";
    let stub_changeset = crate::cmd_aura::IntentChangeset {
        files: all_rels
            .iter()
            .map(|rel| crate::cmd_aura::IntentChangesetFile {
                path: rel.clone(),
                status: "M".into(),
                additions: None,
                deletions: None,
                symbols: Vec::new(),
                commit: None,
                base: None,
            })
            .collect(),
        block_id: None,
        source: Some(stub_source.into()),
        captured_at: None,
    };
    let _ = crate::cmd_aura::aura_log_intent(
        repo_root.clone(),
        stub_intent,
        Some(agent_id.clone()),
        Some(stub_changeset),
        claude_sid,
    )
    .await;

    // (2) Append a pending-backfill note for the next MCP tool reply.
    let backfill_path = std::path::PathBuf::from(&repo_root)
        .join(".aura")
        .join("agent_pending_backfill.json");
    let ask = if captured_reason {
        format!(
            "aura-guard bound this session's prompt as the reason for {} file(s). \
            If a more specific one-line reason fits these exact changes, call \
            aura_log_intent to refine it. Files: {}",
            files.len(),
            all_rels.join(", ")
        )
    } else {
        format!(
            "aura-guard logged a covering reason for {} file(s) but couldn't read \
            this session's prompt yet. When you have a moment, call aura_log_intent \
            with the real one-line reason for these changes. Files: {}",
            files.len(),
            all_rels.join(", ")
        )
    };
    let payload = serde_json::json!({
        "agent_id": agent_id,
        "session_id": session_id,
        "summary": summary,
        "files": all_rels,
        "queued_at_unix_s": now_unix_secs(),
        "ask": ask,
    });
    if let Some(parent) = backfill_path.parent() {
        let _ = std::fs::create_dir_all(parent);
    }
    let _ = std::fs::write(
        &backfill_path,
        serde_json::to_vec_pretty(&payload).unwrap_or_default(),
    );

    Ok(Some(NudgeResult {
        session_id,
        agent_id,
        skipped: false,
        file_count: files.len(),
    }))
}

#[derive(serde::Serialize)]
pub struct NudgeResult {
    pub session_id: String,
    pub agent_id: String,
    pub skipped: bool,
    pub file_count: usize,
}

/// Frontend polls this ~30 seconds after a nudge to find out whether
/// the agent logged intent in response. True = self-heal worked,
/// dismiss the in-flight event silently. False = escalate to the
/// loud red banner.
#[tauri::command]
pub fn agent_guard_intent_covers(
    repo_root: String,
    file_path: String,
) -> Result<bool, String> {
    let now_s = now_unix_secs();
    let p = std::path::Path::new(&file_path);
    intent_covers(&repo_root, p, now_s).map_err(|e| e.to_string())
}

async fn evaluate_event(
    app: AppHandle,
    repo_root: String,
    path: PathBuf,
    kind: &'static str,
) {
    // Editor grace: skip if the path was just written by the in-app
    // editor or any fs_* Tauri command.
    if let Some(tracker) = app.try_state::<EditorWriteTracker>() {
        if tracker.was_recent(&path) {
            return;
        }
    }

    // Gitignore check (best-effort — `git check-ignore` returns
    // exit-code 0 when ignored, 1 when not, 128 on error). We treat
    // any non-zero exit as "not ignored" so an error doesn't silently
    // mask a real mutation.
    if is_gitignored(&repo_root, &path) {
        return;
    }

    // Intent freshness — does the most recent intent cover this path?
    let now_s = now_unix_secs();
    if intent_covers(&repo_root, &path, now_s).unwrap_or(false) {
        return;
    }

    // Agent attribution — is there a live agent in this workspace?
    let live_agents = match app.try_state::<AgentPtyRegistry>() {
        Some(reg) => reg.active_agents_in(&repo_root),
        None => Vec::new(),
    };
    if live_agents.is_empty() {
        // No agent alive — assume the user typed the command in a
        // plain shell PTY or via an external editor. Either way, not
        // an agent mutation; skip.
        return;
    }

    // Deduplicate the agent list (same agent can have multiple
    // sessions open) and pick a single best-guess attribution.
    let mut unique: Vec<String> = Vec::new();
    for a in &live_agents {
        if !unique.iter().any(|x| x == a) {
            unique.push(a.clone());
        }
    }
    let primary = if unique.len() == 1 {
        unique[0].clone()
    } else {
        String::new()
    };

    let event_id = format!("{}:{}", path.display(), now_s);
    let payload = UnattributedMutation {
        path: path.to_string_lossy().into_owned(),
        kind,
        agent_id: primary,
        live_agents: unique.join(","),
        ts: now_s,
        event_id,
    };
    let _ = app.emit("aura:agent-mutation-unattributed", payload);
}

fn classify(kind: &EventKind) -> &'static str {
    match kind {
        EventKind::Create(_) => "create",
        EventKind::Modify(_) => "modify",
        EventKind::Remove(_) => "remove",
        _ => "other",
    }
}

fn is_ignored(path: &std::path::Path, repo_root: &str) -> bool {
    let s = path.to_string_lossy();
    // Containment match (path lives *inside* the dir) plus suffix match
    // (path *is* the dir itself). notify fires events on the directory
    // node when its mtime flips, so without the suffix check we get
    // recurring `.git` / `.aura` nudges every time git or the intent
    // logger touches their roots — exactly the noise users reported.
    let inside_or_eq = |dir: &str| -> bool {
        let with_slash = format!("/{dir}/");
        let trailing = format!("/{dir}");
        s.contains(with_slash.as_str()) || s.ends_with(trailing.as_str())
    };
    if inside_or_eq(".git")
        || inside_or_eq(".aura")
        || inside_or_eq("node_modules")
        || inside_or_eq("target")
        || inside_or_eq("dist")
        || inside_or_eq(".next")
        || inside_or_eq(".nuxt")
        || inside_or_eq(".turbo")
        || inside_or_eq(".cache")
        || inside_or_eq("build")
        || s.ends_with(".swp")
        || s.ends_with(".swo")
        || s.ends_with("~")
        || s.ends_with(".DS_Store")
        || s.ends_with(".tmp")
    {
        return true;
    }
    // Agent atomic-write scratch files. Claude Code (and other CLIs/editors)
    // write to a sibling temp like `<file>.tmp.<pid>.<hex>` and then rename
    // it onto the real target. That transient temp ends in the hex suffix,
    // not `.tmp`, so the plain `.ends_with(".tmp")` above misses it — it then
    // gets mis-classified as a file *create* and fires a bogus `[auto] …
    // backfill pending` stub intent on every agent edit (and re-nudges every
    // 20s). Match the `.tmp.` segment on the file name so the scratch file is
    // ignored and only the real renamed-into-place edit is attributed.
    if let Some(name) = path.file_name().and_then(|n| n.to_str()) {
        if name.contains(".tmp.") {
            return true;
        }
    }
    // The repo_root itself isn't useful as a target. notify emits an
    // event on the dir whenever a child changes; we only want leaf
    // events.
    if s == repo_root {
        return true;
    }
    false
}

fn is_gitignored(repo_root: &str, path: &std::path::Path) -> bool {
    // Convert to relative path for cleaner git invocation.
    let arg = path.to_string_lossy().into_owned();
    let out = std::process::Command::new("git")
        .args(["check-ignore", "-q", "--"])
        .arg(&arg)
        .current_dir(repo_root)
        .output();
    match out {
        Ok(o) => o.status.success(),
        Err(_) => false,
    }
}

/// Walk `.aura/intent_log.jsonl` from the tail and return true if any
/// row within the freshness window covers `path` (either no changeset
/// declared, or the changeset's `files` array lists the path or any
/// ancestor).
fn intent_covers(
    repo_root: &str,
    path: &std::path::Path,
    now_s: i64,
) -> Result<bool, std::io::Error> {
    let p = PathBuf::from(repo_root).join(".aura").join("intent_log.jsonl");
    if !p.is_file() {
        return Ok(false);
    }
    let body = std::fs::read_to_string(&p)?;
    let abs_str = path.to_string_lossy().into_owned();
    let rel_str = path
        .strip_prefix(repo_root)
        .map(|p| p.to_string_lossy().into_owned())
        .unwrap_or_else(|_| abs_str.clone());
    // Iterate newest-first.
    for line in body.lines().rev() {
        let line = line.trim();
        if line.is_empty() {
            continue;
        }
        let Ok(v) = serde_json::from_str::<serde_json::Value>(line) else {
            continue;
        };
        let ts = v
            .get("timestamp")
            .and_then(|t| t.as_i64())
            .unwrap_or(0);
        if ts < now_s - INTENT_WINDOW_S {
            // Rest of the file is older — stop.
            return Ok(false);
        }
        // Open changeset (no file list) ⇒ covers everything until a
        // newer intent supersedes it.
        let Some(cs) = v.get("changeset") else {
            return Ok(true);
        };
        let Some(files) = cs.get("files").and_then(|f| f.as_array()) else {
            return Ok(true);
        };
        if files.is_empty() {
            return Ok(true);
        }
        for f in files {
            let Some(fp) = f.get("path").and_then(|p| p.as_str()) else {
                continue;
            };
            if path_covers(fp, &abs_str) || path_covers(fp, &rel_str) {
                return Ok(true);
            }
        }
    }
    Ok(false)
}

/// `claim` covers `target` if `claim == target` OR `target` is inside
/// the directory `claim` (`claim` is an ancestor of `target`).
fn path_covers(claim: &str, target: &str) -> bool {
    if claim == target {
        return true;
    }
    // Trailing separator normalization so "src/" matches "src/foo.rs".
    let claim_dir = if claim.ends_with('/') {
        claim.to_string()
    } else {
        format!("{claim}/")
    };
    target.starts_with(&claim_dir)
}

/// Ask Aura's own brain to read the diff for `rels` and return a one-line
/// intent — the "if the agent didn't log it, we do it with our brain" path.
/// Bounded by a hard timeout so a slow or absent brain never stalls the
/// self-heal; `None` on any failure/empty result, which lets the caller fall
/// back to an honest stub.
async fn brain_infer_intent(repo_root: &str, rels: &[String]) -> Option<String> {
    if rels.is_empty() {
        return None;
    }
    let diff = collect_diff_for(repo_root, rels);
    if diff.trim().is_empty() {
        return None;
    }

    use crate::manager::brain::types::{ChatMessage, ChatRequest};
    let prompt = format!(
        "A coding agent changed these files but didn't say why. Read the diff \
         and write the reason as ONE terse line (max 12 words, plain language, \
         no quotes, no file names, no code). It becomes the 'why' in an audit \
         trail.\n\nFiles: {}\n\nDiff:\n{}",
        rels.join(", "),
        diff,
    );
    let request = ChatRequest {
        messages: vec![ChatMessage {
            role: "user".into(),
            content: serde_json::json!(prompt),
        }],
        system: Some(
            "You write one-line change intents for an audit trail. Output only \
             the single line — no preamble, no quotes."
                .into(),
        ),
        tools: vec![],
        max_tokens: Some(40),
        temperature: Some(0.2),
        effort: None,
        fast: true,
        model: None,
        long_context: false,
        approval: None,
        cwd: repo_root.to_string(),
    };

    let text = match tokio::time::timeout(
        Duration::from_secs(12),
        crate::cmd_loop::plan_collect(request),
    )
    .await
    {
        Ok(Ok(t)) => t,
        _ => return None,
    };

    let line = clean_intent_line(&text);
    if line.is_empty() {
        None
    } else {
        Some(line)
    }
}

/// Build a bounded diff for the changed files to hand the brain. Prefers
/// `git diff HEAD` (both staged and working changes vs the last commit); for
/// brand-new/untracked files that don't show there, falls back to their head
/// bytes so the brain still has content to summarize.
fn collect_diff_for(repo_root: &str, rels: &[String]) -> String {
    const CAP: usize = 6000;
    let mut args: Vec<String> = vec![
        "--no-pager".into(),
        "diff".into(),
        "HEAD".into(),
        "--".into(),
    ];
    args.extend(rels.iter().cloned());
    let mut diff = std::process::Command::new("git")
        .args(&args)
        .current_dir(repo_root)
        .output()
        .ok()
        .filter(|o| o.status.success())
        .map(|o| String::from_utf8_lossy(&o.stdout).into_owned())
        .unwrap_or_default();

    if diff.trim().is_empty() {
        for r in rels {
            if let Ok(body) =
                std::fs::read_to_string(std::path::Path::new(repo_root).join(r))
            {
                diff.push_str(&format!("--- new file {r} ---\n"));
                diff.push_str(&body.chars().take(2000).collect::<String>());
                diff.push('\n');
            }
        }
    }

    if diff.len() > CAP {
        diff.truncate(CAP);
        diff.push_str("\n… (truncated)");
    }
    diff
}

/// Take the first non-empty line of a brain reply and strip wrapping quotes
/// so a chatty model that answers with `"Added a search box."` still yields a
/// clean audit line.
fn clean_intent_line(raw: &str) -> String {
    raw.lines()
        .map(|l| l.trim())
        .find(|l| !l.is_empty())
        .unwrap_or("")
        .trim_matches(|c| c == '"' || c == '\'' || c == '`')
        .trim()
        .to_string()
}

fn now_unix_secs() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs() as i64)
        .unwrap_or(0)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn path_covers_matches_dir_ancestor() {
        assert!(path_covers("src", "src/foo.rs"));
        assert!(path_covers("src/", "src/foo.rs"));
        assert!(path_covers("src/foo.rs", "src/foo.rs"));
        assert!(!path_covers("src/bar.rs", "src/foo.rs"));
        assert!(!path_covers("srcbar", "src/foo.rs"));
    }

    #[test]
    fn ignored_matches_dir_self_and_contents() {
        // Bare-dir events (notify firing on the directory node when its
        // mtime flips) must be filtered the same way as child events.
        // Regression test for the .git/.aura nudge spam users reported.
        let repo = "/Users/me/repo";
        assert!(is_ignored(std::path::Path::new("/Users/me/repo/.git"), repo));
        assert!(is_ignored(std::path::Path::new("/Users/me/repo/.git/HEAD"), repo));
        assert!(is_ignored(std::path::Path::new("/Users/me/repo/.aura"), repo));
        assert!(is_ignored(std::path::Path::new("/Users/me/repo/.aura/intent_log.jsonl"), repo));
        assert!(is_ignored(std::path::Path::new("/Users/me/repo/node_modules"), repo));
        assert!(is_ignored(std::path::Path::new("/Users/me/repo/node_modules/foo/index.js"), repo));
        // Genuine source files must still pass through.
        assert!(!is_ignored(std::path::Path::new("/Users/me/repo/src/main.rs"), repo));
        // Substring-collision guard — `.gitkeep` is not `.git`.
        assert!(!is_ignored(std::path::Path::new("/Users/me/repo/assets/.gitkeep"), repo));
    }

    #[test]
    fn ignored_drops_agent_atomic_write_scratch() {
        // Claude Code writes `<file>.tmp.<pid>.<hex>` then renames it onto
        // the real target. The scratch file must be ignored so it isn't
        // mis-classified as a `create` and used to fire a bogus auto-stub
        // intent on every agent edit.
        let repo = "/Users/me/repo";
        assert!(is_ignored(
            std::path::Path::new("/Users/me/repo/aura-shell/src/server.ts.tmp.51156.819c57c7ec"),
            repo,
        ));
        assert!(is_ignored(
            std::path::Path::new("/Users/me/repo/src/main.rs.tmp.999.abcdef"),
            repo,
        ));
        // Plain trailing `.tmp` was already covered; keep it covered.
        assert!(is_ignored(std::path::Path::new("/Users/me/repo/src/x.tmp"), repo));
        // A real source file that merely has "tmp" in its name must pass.
        assert!(!is_ignored(std::path::Path::new("/Users/me/repo/src/tmpfile.rs"), repo));
        assert!(!is_ignored(std::path::Path::new("/Users/me/repo/src/template.ts"), repo));
    }

    #[test]
    fn editor_tracker_grace_window() {
        let t = EditorWriteTracker::new();
        let p = std::path::PathBuf::from("/tmp/aura-guard-test/file.txt");
        t.stamp(p.clone());
        assert!(t.was_recent(&p));
        let other = std::path::PathBuf::from("/tmp/aura-guard-test/other.txt");
        assert!(!t.was_recent(&other));
    }

    #[test]
    fn classify_maps_kinds() {
        use notify::event::{CreateKind, ModifyKind, RemoveKind};
        assert_eq!(classify(&EventKind::Create(CreateKind::File)), "create");
        assert_eq!(
            classify(&EventKind::Modify(ModifyKind::Data(
                notify::event::DataChange::Content
            ))),
            "modify"
        );
        assert_eq!(classify(&EventKind::Remove(RemoveKind::File)), "remove");
        assert_eq!(classify(&EventKind::Any), "other");
    }

    #[tokio::test]
    async fn intent_covers_recent_open_changeset() {
        let dir = tempfile::tempdir().unwrap();
        let aura = dir.path().join(".aura");
        std::fs::create_dir_all(&aura).unwrap();
        let now = now_unix_secs();
        let body = format!(
            "{{\"intent\":\"x\",\"timestamp\":{now}}}\n"
        );
        std::fs::write(aura.join("intent_log.jsonl"), body).unwrap();
        let target = dir.path().join("src/lib.rs");
        let covers = intent_covers(
            &dir.path().to_string_lossy(),
            &target,
            now,
        )
        .unwrap();
        assert!(covers, "open changeset within window should cover any file");
    }

    #[tokio::test]
    async fn intent_covers_specific_file() {
        let dir = tempfile::tempdir().unwrap();
        let aura = dir.path().join(".aura");
        std::fs::create_dir_all(&aura).unwrap();
        let now = now_unix_secs();
        let body = format!(
            "{{\"intent\":\"x\",\"timestamp\":{now},\"changeset\":{{\"files\":[{{\"path\":\"src/lib.rs\"}}]}}}}\n"
        );
        std::fs::write(aura.join("intent_log.jsonl"), body).unwrap();

        let covered = dir.path().join("src/lib.rs");
        let not_covered = dir.path().join("src/other.rs");
        assert!(intent_covers(&dir.path().to_string_lossy(), &covered, now).unwrap());
        assert!(!intent_covers(&dir.path().to_string_lossy(), &not_covered, now).unwrap());
    }

    #[tokio::test]
    async fn intent_outside_window_does_not_cover() {
        let dir = tempfile::tempdir().unwrap();
        let aura = dir.path().join(".aura");
        std::fs::create_dir_all(&aura).unwrap();
        let now = now_unix_secs();
        let old = now - 600;
        let body = format!(
            "{{\"intent\":\"old\",\"timestamp\":{old}}}\n"
        );
        std::fs::write(aura.join("intent_log.jsonl"), body).unwrap();
        let target = dir.path().join("src/lib.rs");
        assert!(!intent_covers(&dir.path().to_string_lossy(), &target, now).unwrap());
    }
}
