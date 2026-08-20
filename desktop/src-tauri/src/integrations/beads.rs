//! Beads importer — migrate a Beads tracker's issues into the Aura
//! task board.
//!
//! Beads (github.com/steveyegge/beads) is a git-native, dependency-aware
//! issue tracker built for coding agents. It keeps a SQLite/Dolt working
//! store but exports a plain-text **JSONL log** (`.beads/*.jsonl`, one
//! issue object per line) as its git-shareable interchange format. That
//! JSONL log is exactly what we read here: no network, no daemon, no
//! beads binary — just the file on disk, the same way the Aura desktop
//! app reads `.aura/tasks/`.
//!
//! Why this lives at the same layer as `jira_sync`:
//! the Jira connector parses external issues → Aura `Task` records and
//! upserts them through `cmd_tasks::tasks_upsert_external` (dedupe on
//! `(external_source, external_id)`), then runs a post-pass to wire
//! hierarchy that couldn't be set on first write. Beads mirrors that
//! shape precisely — the only differences are (a) the source is a local
//! file instead of an OAuth'd HTTP API, so there's no token lifecycle,
//! and (b) Beads carries a real dependency graph, which we resolve onto
//! Aura's `dependencies` (blocked-by task-id list) in the second pass.
//!
//! On-disk schema we parse (verified against the beads source —
//! `internal/types/types.go`, the `Issue`/`Dependency` structs and their
//! `json:"…"` tags, plus the status/priority/type/dependency-type
//! constants):
//!
//!   * `id`            string                 — stable beads id (e.g. `bd-a3f2`)
//!   * `title`         string
//!   * `description`   string (omitempty)
//!   * `status`        "open" | "in_progress" | "blocked" | "deferred"
//!                     | "closed" | "pinned" | "hooked"
//!   * `priority`      int 0..=4 (0 = critical … 4 = backlog)
//!   * `issue_type`    "bug" | "feature" | "task" | "epic" | "chore" | …
//!   * `labels`        []string (omitempty)
//!   * `dependencies`  [] of { issue_id, depends_on_id, type } where
//!                     `type` ∈ {"blocks","parent-child","related",
//!                     "discovered-from", …}
//!   * `created_at` / `updated_at`  RFC3339 timestamps
//!   * `external_ref`  string (omitempty) — beads' own pointer back to a
//!                     foreign tracker; surfaced as the Aura task's
//!                     clickable `external_url` when it looks like one.

use std::collections::HashMap;
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};

use super::types::IntegrationError;
use crate::cmd_tasks::{
    tasks_list, tasks_update, tasks_upsert_external, UpdateTaskInput, UpsertExternalTaskInput,
};

/// Source slug stamped onto every imported task's `external_source`.
/// The pair `("beads", <bead id>)` is the idempotency key: re-importing
/// the same `.beads` log updates rows in place instead of duplicating.
pub const SOURCE: &str = "beads";

// ── On-disk records ──────────────────────────────────────────────────

/// One issue line from a Beads JSONL log. Only the fields Aura maps are
/// named; everything else (molecule/gate/wisp/event machinery that beads
/// uses for agent coordination) is ignored via serde's default
/// unknown-field tolerance, so a newer beads schema never fails the
/// import.
#[derive(Debug, Clone, Deserialize)]
pub struct BeadsIssue {
    pub id: String,
    #[serde(default)]
    pub title: String,
    #[serde(default)]
    pub description: String,
    #[serde(default)]
    pub status: Option<String>,
    /// Beads priority is a bare int 0..=4 (0 = critical). `default`
    /// covers logs that omit it; we treat missing as 2 (medium) the same
    /// way beads' own importer does.
    #[serde(default)]
    pub priority: Option<i64>,
    #[serde(default)]
    pub issue_type: Option<String>,
    #[serde(default)]
    pub labels: Vec<String>,
    #[serde(default)]
    pub dependencies: Vec<BeadsDependency>,
    /// Beads' own pointer to a foreign tracker (e.g. "gh-9", "jira-ABC").
    /// Promoted to the Aura task's `external_url` only when it parses as
    /// a URL; otherwise dropped (it's a beads-internal cross-ref).
    #[serde(default)]
    pub external_ref: Option<String>,
}

/// One edge in a Beads issue's dependency graph. `depends_on_id` is the
/// id of the issue this one depends on; `type` classifies the edge.
#[derive(Debug, Clone, Deserialize)]
pub struct BeadsDependency {
    #[serde(default)]
    pub depends_on_id: String,
    #[serde(default, rename = "type")]
    pub dep_type: Option<String>,
}

// ── Import outcome ───────────────────────────────────────────────────

/// Result of one import run over a `.beads` log. Returned to the UI so it
/// can render "Imported 12 · updated 3 · skipped 1".
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct BeadsImportOutcome {
    /// Absolute path to the JSONL log we read.
    pub source_path: String,
    /// Total issue lines parsed (before mapping).
    pub parsed: u32,
    pub created: u32,
    pub updated: u32,
    /// Issues skipped (malformed line, or upsert failed). One message per
    /// skip lands in `errors`.
    pub skipped: u32,
    /// Dependency edges (blocks / parent-child) resolved onto Aura task
    /// `dependencies` in the second pass.
    pub links: u32,
    pub errors: Vec<String>,
}

/// Lightweight preview of a `.beads` source before committing to an
/// import — lets the UI show "Found 42 issues in <path>" with a count
/// breakdown without writing anything to the board.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct BeadsPreview {
    pub source_path: String,
    pub total: u32,
    pub open: u32,
    pub closed: u32,
    pub with_dependencies: u32,
}

// ── Source resolution ────────────────────────────────────────────────

/// Resolve a user-supplied path to the actual Beads JSONL log.
///
/// Accepts any of:
///   * a repo root containing `.beads/` (we find the `.jsonl` inside),
///   * the `.beads/` directory itself,
///   * a direct path to a `*.jsonl` file.
///
/// Beads names its export `issues.jsonl` by default but older / renamed
/// logs exist (`beads.jsonl`, `<prefix>.jsonl`); when the conventional
/// name is absent we fall back to the single `*.jsonl` in the directory,
/// erroring only if it's genuinely ambiguous.
pub fn resolve_jsonl(input: &Path) -> Result<PathBuf, IntegrationError> {
    if input.is_file() {
        return Ok(input.to_path_buf());
    }
    // A directory: it's either the repo root (look inside `.beads/`) or
    // the `.beads/` dir itself.
    let beads_dir = if input.join(".beads").is_dir() {
        input.join(".beads")
    } else {
        input.to_path_buf()
    };
    if !beads_dir.is_dir() {
        return Err(IntegrationError::NotConfigured(format!(
            "no Beads tracker found at {} (expected a .beads/ folder or a .jsonl file)",
            input.display()
        )));
    }
    for name in ["issues.jsonl", "beads.jsonl"] {
        let candidate = beads_dir.join(name);
        if candidate.is_file() {
            return Ok(candidate);
        }
    }
    // Fall back to the lone `*.jsonl` in the directory.
    let mut jsonls: Vec<PathBuf> = Vec::new();
    if let Ok(entries) = std::fs::read_dir(&beads_dir) {
        for entry in entries.flatten() {
            let p = entry.path();
            if p.extension().and_then(|e| e.to_str()) == Some("jsonl") {
                jsonls.push(p);
            }
        }
    }
    match jsonls.len() {
        0 => Err(IntegrationError::NotConfigured(format!(
            "no .jsonl issue log in {}",
            beads_dir.display()
        ))),
        1 => Ok(jsonls.remove(0)),
        _ => {
            jsonls.sort();
            Err(IntegrationError::Other(format!(
                "multiple .jsonl logs in {} — point the import at one file: {}",
                beads_dir.display(),
                jsonls
                    .iter()
                    .map(|p| p.display().to_string())
                    .collect::<Vec<_>>()
                    .join(", ")
            )))
        }
    }
}

/// Parse a Beads JSONL log into issue records. One malformed line is
/// skipped (its line number is reported) rather than aborting the whole
/// file — a partial git-merge of the log shouldn't lose the rest.
pub fn parse_log(path: &Path) -> Result<Vec<BeadsIssue>, IntegrationError> {
    let raw = std::fs::read_to_string(path)
        .map_err(|e| IntegrationError::Other(format!("read {}: {e}", path.display())))?;
    let mut out = Vec::new();
    for line in raw.lines() {
        let trimmed = line.trim();
        if trimmed.is_empty() {
            continue;
        }
        match serde_json::from_str::<BeadsIssue>(trimmed) {
            Ok(issue) if !issue.id.trim().is_empty() => out.push(issue),
            // A line with no id is not an issue (beads writes a
            // header / meta line in some logs) — skip silently.
            Ok(_) => {}
            // Soft-skip a corrupt line so a partial git-merge of the log
            // doesn't lose the rest. The preview/import report counts,
            // not line numbers, so there's nothing to collect here.
            Err(_) => continue,
        }
    }
    Ok(out)
}

/// Count-only scan for the pre-import preview. Cheap — parses the log but
/// writes nothing.
pub fn preview(input: &Path) -> Result<BeadsPreview, IntegrationError> {
    let path = resolve_jsonl(input)?;
    let issues = parse_log(&path)?;
    let mut open = 0u32;
    let mut closed = 0u32;
    let mut with_deps = 0u32;
    for issue in &issues {
        if is_closed_status(issue.status.as_deref()) {
            closed += 1;
        } else {
            open += 1;
        }
        if issue.dependencies.iter().any(|d| !d.depends_on_id.is_empty()) {
            with_deps += 1;
        }
    }
    Ok(BeadsPreview {
        source_path: path.display().to_string(),
        total: issues.len() as u32,
        open,
        closed,
        with_dependencies: with_deps,
    })
}

// ── Import ───────────────────────────────────────────────────────────

/// Import every issue in a Beads log into `repo_root`'s task board.
///
/// Two passes, mirroring `jira_sync::sync_project`:
///   1. Upsert each issue as a task (idempotent on `("beads", bead_id)`),
///      patching the canonical state to match the beads status. We can't
///      wire dependencies here because a dependency target may not be in
///      the store yet on a fresh import.
///   2. After every issue is in the store, resolve each beads dependency
///      edge (`blocks` / `parent-child`) from `depends_on_id` → the
///      imported task's Aura id and write the `dependencies` (blocked-by)
///      list plus the `bead_id` anchor.
pub async fn import(repo_root: &str, input: &Path) -> Result<BeadsImportOutcome, IntegrationError> {
    let path = resolve_jsonl(input)?;
    let issues = parse_log(&path)?;

    let mut created = 0u32;
    let mut updated = 0u32;
    let mut skipped = 0u32;
    let mut errors: Vec<String> = Vec::new();

    for issue in &issues {
        match upsert_one(repo_root, issue).await {
            Ok(true) => created += 1,
            Ok(false) => updated += 1,
            Err(e) => {
                errors.push(format!("{}: {e}", issue.id));
                skipped += 1;
            }
        }
    }

    // ── Pass 2: dependency + bead_id linking ─────────────────────────
    // Load the board once and build a (beads id → Aura task id) lookup
    // keyed on our own source slug, then write each task's blocked-by
    // list. Only `blocks` and `parent-child` edges block work in beads,
    // so those are the ones that become Aura `dependencies`; relational
    // edges (related / discovered-from / …) are informational and we
    // don't force them onto the blocked-by graph.
    let links = link_dependencies(repo_root, &issues, &mut errors).await?;

    Ok(BeadsImportOutcome {
        source_path: path.display().to_string(),
        parsed: issues.len() as u32,
        created,
        updated,
        skipped,
        links,
        errors,
    })
}

/// Upsert one beads issue → Aura task, returning whether it was newly
/// created. Sets title/description/priority/labels via the external
/// upsert, then patches the canonical state to mirror the beads status
/// (the upsert helper carries no status field, exactly like the Jira
/// path).
async fn upsert_one(repo_root: &str, issue: &BeadsIssue) -> Result<bool, IntegrationError> {
    let title = if issue.title.trim().is_empty() {
        // Beads allows a body-only issue; give it a stable placeholder so
        // the card isn't blank.
        format!("Beads issue {}", issue.id)
    } else {
        issue.title.clone()
    };
    let external_url = issue
        .external_ref
        .as_deref()
        .filter(|r| r.starts_with("http://") || r.starts_with("https://"))
        .map(String::from);

    let upsert = UpsertExternalTaskInput {
        external_source: SOURCE.to_string(),
        external_id: issue.id.clone(),
        external_url,
        title,
        description: Some(issue.description.clone()),
        priority: Some(beads_priority_to_aura(issue.priority).to_string()),
        labels: dedupe_labels(issue),
        due_date: None,
        assignee_ids: Vec::new(),
    };
    let result = tasks_upsert_external(repo_root.to_string(), upsert)
        .await
        .map_err(IntegrationError::Other)?;

    // Patch the canonical state to match the beads status. The upsert
    // helper never touches `state_id`, so without this a re-import of an
    // issue that moved open → closed would still sit in Backlog.
    let want_state = beads_status_to_state_id(issue.status.as_deref());
    if result.task.state_id.as_str() != want_state {
        let patch = UpdateTaskInput {
            state_id: Some(want_state.to_string()),
            status: Some(state_id_to_legacy_status(want_state).to_string()),
            ..blank_update(&result.task.id)
        };
        tasks_update(repo_root.to_string(), patch)
            .await
            .map_err(IntegrationError::Other)?;
    }

    Ok(result.created)
}

/// Resolve every blocking beads dependency edge onto the imported tasks'
/// Aura `dependencies` (blocked-by) lists. Returns the number of edges
/// written. Also stamps each imported task's `bead_id` with its source
/// id so the rest of Aura (A2A, agent runs) can cross-reference the
/// original bead.
async fn link_dependencies(
    repo_root: &str,
    issues: &[BeadsIssue],
    errors: &mut Vec<String>,
) -> Result<u32, IntegrationError> {
    let all = tasks_list(repo_root.to_string())
        .await
        .map_err(IntegrationError::Other)?;
    // beads id → Aura task id, for our source only.
    let mut by_bead: HashMap<&str, String> = HashMap::new();
    for t in &all {
        if t.external_source.as_deref() == Some(SOURCE) {
            if let Some(ext) = t.external_id.as_deref() {
                by_bead.insert(ext, t.id.clone());
            }
        }
    }

    let mut written = 0u32;
    for issue in issues {
        let Some(task_id) = by_bead.get(issue.id.as_str()).cloned() else {
            continue;
        };
        // Collect the Aura ids of issues this one is blocked by. Only
        // blocking edge types count toward the work-ordering graph.
        let mut blocked_by: Vec<String> = Vec::new();
        for dep in &issue.dependencies {
            if dep.depends_on_id.is_empty() || !is_blocking_dep(dep.dep_type.as_deref()) {
                continue;
            }
            if let Some(dep_task_id) = by_bead.get(dep.depends_on_id.as_str()) {
                if !blocked_by.contains(dep_task_id) {
                    blocked_by.push(dep_task_id.clone());
                }
            }
        }

        // Skip the write entirely if nothing changed — keeps re-imports
        // idempotent and quiet. We compare against the current row.
        let current = all.iter().find(|t| t.id == task_id);
        let deps_unchanged = current
            .map(|t| t.dependencies == blocked_by)
            .unwrap_or(false);
        let bead_unchanged = current
            .map(|t| t.bead_id.as_deref() == Some(issue.id.as_str()))
            .unwrap_or(false);
        if deps_unchanged && bead_unchanged {
            continue;
        }

        let patch = UpdateTaskInput {
            dependencies: if deps_unchanged {
                None
            } else {
                Some(blocked_by.clone())
            },
            bead_id: if bead_unchanged {
                None
            } else {
                Some(issue.id.clone())
            },
            ..blank_update(&task_id)
        };
        match tasks_update(repo_root.to_string(), patch).await {
            Ok(_) => written += blocked_by.len() as u32,
            Err(e) => errors.push(format!("{}: link failed: {e}", issue.id)),
        }
    }
    Ok(written)
}

// ── Field mappers ────────────────────────────────────────────────────

/// Beads numeric priority (0 = critical … 4 = backlog) → Aura's 5-stop
/// slug ladder. Missing priority flattens to `medium`, matching beads'
/// own default of P2 for issues that don't set one.
fn beads_priority_to_aura(priority: Option<i64>) -> &'static str {
    match priority.unwrap_or(2) {
        0 => "urgent",
        1 => "high",
        2 => "medium",
        3 => "low",
        _ => "low", // 4 (backlog) and any out-of-range value
    }
}

/// Beads status → Aura canonical state id. Beads' status set is
/// `open / in_progress / blocked / deferred / closed / pinned / hooked`
/// (verified in `internal/types/types.go`). Active-but-not-started
/// states map to Backlog; in-flight ones to Started; closed to
/// Completed.
fn beads_status_to_state_id(status: Option<&str>) -> &'static str {
    match status.unwrap_or("open").to_ascii_lowercase().as_str() {
        "open" | "deferred" | "pinned" => "backlog",
        "in_progress" | "blocked" | "hooked" => "started",
        "closed" => "completed",
        _ => "backlog",
    }
}

/// True for beads statuses that mean "done" — used by the preview's
/// open/closed split.
fn is_closed_status(status: Option<&str>) -> bool {
    matches!(
        status.unwrap_or("open").to_ascii_lowercase().as_str(),
        "closed"
    )
}

/// True for beads dependency edge types that gate work (and therefore
/// become Aura blocked-by edges). `blocks` and `parent-child` block in
/// beads; everything else (related / discovered-from / relates-to / …)
/// is informational.
fn is_blocking_dep(dep_type: Option<&str>) -> bool {
    matches!(
        dep_type.unwrap_or("blocks").to_ascii_lowercase().as_str(),
        "blocks" | "parent-child"
    )
}

/// Round-trip the canonical state id back to the legacy `status` string
/// older readers expect. Mirrors the inverse used by the Jira sync.
fn state_id_to_legacy_status(state_id: &str) -> &'static str {
    match state_id {
        "backlog" | "unstarted" => "backlog",
        "started" => "in_progress",
        "completed" => "done",
        "cancelled" => "done",
        _ => "backlog",
    }
}

/// Build the imported task's label set: the issue's own labels plus the
/// beads `issue_type` as a chip (so a "bug" / "epic" reads at a glance on
/// the Aura card), de-duplicated and lowercased.
fn dedupe_labels(issue: &BeadsIssue) -> Vec<String> {
    let mut out: Vec<String> = Vec::new();
    let mut push = |label: &str| {
        let l = label.trim();
        if l.is_empty() {
            return;
        }
        if !out.iter().any(|e| e.eq_ignore_ascii_case(l)) {
            out.push(l.to_string());
        }
    };
    if let Some(t) = issue.issue_type.as_deref() {
        // Skip the generic default so we don't tag every card "task".
        if !t.eq_ignore_ascii_case("task") {
            push(t);
        }
    }
    for l in &issue.labels {
        push(l);
    }
    out
}

/// All-`None` `UpdateTaskInput` keyed by id — same build-on-top helper
/// the Jira sync uses, so callers set only the fields they care about
/// via `..blank_update(id)`.
fn blank_update(id: &str) -> UpdateTaskInput {
    UpdateTaskInput {
        id: id.to_string(),
        title: None,
        description: None,
        status: None,
        state_id: None,
        priority: None,
        assignee: None,
        assignee_ids: None,
        agent_assignee: None,
        labels: None,
        label_ids: None,
        due_date: None,
        start_date: None,
        estimate: None,
        parent_id: None,
        epic_id: None,
        is_epic: None,
        objective: None,
        dependencies: None,
        steps: None,
        bead_id: None,
        sprint: None,
        crew_id: None,
        cycle_id: None,
        module_id: None,
        external_source: None,
        external_id: None,
        external_url: None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn priority_ladder_maps_all_stops() {
        assert_eq!(beads_priority_to_aura(Some(0)), "urgent");
        assert_eq!(beads_priority_to_aura(Some(1)), "high");
        assert_eq!(beads_priority_to_aura(Some(2)), "medium");
        assert_eq!(beads_priority_to_aura(Some(3)), "low");
        assert_eq!(beads_priority_to_aura(Some(4)), "low");
        assert_eq!(beads_priority_to_aura(None), "medium");
    }

    #[test]
    fn status_maps_to_canonical_states() {
        assert_eq!(beads_status_to_state_id(Some("open")), "backlog");
        assert_eq!(beads_status_to_state_id(Some("in_progress")), "started");
        assert_eq!(beads_status_to_state_id(Some("blocked")), "started");
        assert_eq!(beads_status_to_state_id(Some("closed")), "completed");
        assert_eq!(beads_status_to_state_id(None), "backlog");
    }

    #[test]
    fn only_blocking_edges_count() {
        assert!(is_blocking_dep(Some("blocks")));
        assert!(is_blocking_dep(Some("parent-child")));
        assert!(!is_blocking_dep(Some("related")));
        assert!(!is_blocking_dep(Some("discovered-from")));
        // Missing type defaults to a blocking edge (beads' `bd dep add`
        // default is `blocks`).
        assert!(is_blocking_dep(None));
    }

    #[test]
    fn parses_a_real_beads_jsonl_line() {
        let line = r#"{"id":"bd-a3f2","title":"Fix auth bug","description":"JWT expiry","status":"open","priority":1,"issue_type":"bug","labels":["backend"],"dependencies":[{"issue_id":"bd-a3f2","depends_on_id":"bd-9x1","type":"blocks"}],"created_at":"2026-01-15T10:30:00Z","updated_at":"2026-01-15T10:30:00Z"}"#;
        let issue: BeadsIssue = serde_json::from_str(line).expect("parse");
        assert_eq!(issue.id, "bd-a3f2");
        assert_eq!(issue.title, "Fix auth bug");
        assert_eq!(issue.priority, Some(1));
        assert_eq!(issue.status.as_deref(), Some("open"));
        assert_eq!(issue.dependencies.len(), 1);
        assert_eq!(issue.dependencies[0].depends_on_id, "bd-9x1");
        assert_eq!(issue.dependencies[0].dep_type.as_deref(), Some("blocks"));
    }

    #[test]
    fn labels_fold_in_issue_type_but_skip_plain_task() {
        let mut issue = sample();
        issue.issue_type = Some("bug".into());
        issue.labels = vec!["backend".into(), "BUG".into()];
        let labels = dedupe_labels(&issue);
        // "bug" from issue_type + "backend"; the duplicate "BUG" is folded.
        assert_eq!(labels, vec!["bug".to_string(), "backend".to_string()]);

        issue.issue_type = Some("task".into());
        issue.labels = vec!["ui".into()];
        let labels = dedupe_labels(&issue);
        assert_eq!(labels, vec!["ui".to_string()]);
    }

    fn sample() -> BeadsIssue {
        BeadsIssue {
            id: "bd-1".into(),
            title: "t".into(),
            description: String::new(),
            status: Some("open".into()),
            priority: Some(2),
            issue_type: None,
            labels: vec![],
            dependencies: vec![],
            external_ref: None,
        }
    }

    // ── End-to-end import against a real on-disk task board ──────────

    const LOG: &str = concat!(
        r#"{"id":"bd-1","title":"Design schema","status":"closed","priority":1,"issue_type":"task","created_at":"2026-01-01T00:00:00Z","updated_at":"2026-01-02T00:00:00Z"}"#,
        "\n",
        r#"{"id":"bd-2","title":"Build API","description":"REST endpoints","status":"in_progress","priority":0,"issue_type":"feature","labels":["backend"],"dependencies":[{"issue_id":"bd-2","depends_on_id":"bd-1","type":"blocks"}],"created_at":"2026-01-01T00:00:00Z","updated_at":"2026-01-03T00:00:00Z"}"#,
        "\n",
        r#"{"id":"bd-3","title":"Write docs","status":"open","priority":3,"issue_type":"chore","dependencies":[{"issue_id":"bd-3","depends_on_id":"bd-1","type":"related"}],"created_at":"2026-01-01T00:00:00Z","updated_at":"2026-01-01T00:00:00Z"}"#,
        "\n",
    );

    #[tokio::test]
    async fn imports_and_is_idempotent_end_to_end() {
        let dir = tempfile::tempdir().expect("tempdir");
        let beads = dir.path().join(".beads");
        std::fs::create_dir_all(&beads).expect("mkdir .beads");
        std::fs::write(beads.join("issues.jsonl"), LOG).expect("write log");

        let repo = dir.path().to_str().unwrap();

        // First import — points at the repo root; resolve_jsonl finds
        // `.beads/issues.jsonl`.
        let out = import(repo, dir.path()).await.expect("import");
        assert_eq!(out.parsed, 3);
        assert_eq!(out.created, 3);
        assert_eq!(out.updated, 0);
        assert_eq!(out.skipped, 0);
        // One blocking edge (bd-2 → bd-1). The `related` edge on bd-3 is
        // informational and must NOT become a blocked-by link.
        assert_eq!(out.links, 1);

        let tasks = tasks_list(repo.to_string()).await.expect("list");
        assert_eq!(tasks.len(), 3);

        let by_bead = |bead: &str| {
            tasks
                .iter()
                .find(|t| {
                    t.external_source.as_deref() == Some(SOURCE)
                        && t.external_id.as_deref() == Some(bead)
                })
                .cloned()
                .unwrap_or_else(|| panic!("missing task for {bead}"))
        };

        let t1 = by_bead("bd-1");
        let t2 = by_bead("bd-2");
        let t3 = by_bead("bd-3");

        // Status mapping: closed → completed, in_progress → started,
        // open → backlog.
        assert_eq!(t1.state_id, "completed");
        assert_eq!(t2.state_id, "started");
        assert_eq!(t3.state_id, "backlog");

        // bead_id anchor stamped on every imported task.
        assert_eq!(t2.bead_id.as_deref(), Some("bd-2"));

        // Dependency: bd-2 is blocked by bd-1 → t2.dependencies == [t1.id].
        assert_eq!(t2.dependencies, vec![t1.id.clone()]);
        // bd-3's only edge is `related` → no blocked-by link.
        assert!(t3.dependencies.is_empty());

        // issue_type folds into labels (feature), plus the issue's own.
        assert!(t2.labels.iter().any(|l| l.eq_ignore_ascii_case("feature")));
        assert!(t2.labels.iter().any(|l| l.eq_ignore_ascii_case("backend")));

        // ── Re-import: idempotent. No new rows, deps unchanged. ──────
        let again = import(repo, dir.path()).await.expect("re-import");
        assert_eq!(again.created, 0, "re-import must not duplicate");
        assert_eq!(again.updated, 3);
        let tasks2 = tasks_list(repo.to_string()).await.expect("list2");
        assert_eq!(tasks2.len(), 3, "no duplicate cards on re-import");
    }

    #[test]
    fn preview_counts_without_writing() {
        let dir = tempfile::tempdir().expect("tempdir");
        let beads = dir.path().join(".beads");
        std::fs::create_dir_all(&beads).expect("mkdir");
        std::fs::write(beads.join("issues.jsonl"), LOG).expect("write");

        let p = preview(dir.path()).expect("preview");
        assert_eq!(p.total, 3);
        assert_eq!(p.closed, 1); // bd-1
        assert_eq!(p.open, 2); // bd-2, bd-3
        // bd-2 and bd-3 both carry a dependencies array.
        assert_eq!(p.with_dependencies, 2);
        // Nothing written to the board.
        assert!(!dir.path().join(".aura").join("tasks").join("tasks.json").exists());
    }
}
