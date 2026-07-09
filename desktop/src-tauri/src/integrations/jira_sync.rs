//! Pull-mirror — fetch Jira issues into Aura tasks.
//!
//! W2 surface: list projects on a cloud site, pull all issues in a
//! chosen project, map Jira fields onto Aura's `Task` shape, and
//! upsert via `cmd_tasks::tasks_upsert_external` (which already dedupes
//! on `(external_source, external_id)`).
//!
//! What's intentionally NOT here:
//!  - Comments. The Jira comment store needs a separate endpoint
//!    (`/rest/api/3/issue/{key}/comment`) and a corresponding write
//!    path into Aura's `cmd_tasks_comments`. Postponed to W3 to keep
//!    W2's blast radius small.
//!  - Attachments. Same reasoning.
//!  - Custom fields. Atlassian exposes them as `customfield_NNNNN`
//!    keys with site-specific names — needs a per-mirror field map
//!    which lands in W7 alongside the workflow editor.
//!  - Outbound push. W4.
//!  - Webhook delta-apply. W5.
//!
//! Token lifecycle: every public entry point starts with
//! `valid_access_token()`, which refreshes the cached blob if it's
//! within 30 seconds of expiry and persists the new tokens to the
//! keychain. Callers never see expired tokens.

use std::time::{Duration, SystemTime, UNIX_EPOCH};

use serde::{Deserialize, Serialize};
use serde_json::Value;

use super::config::{self};
use super::jira;
use super::tokens;
use super::types::{IntegrationError, IntegrationKind, ProviderTokens};
use crate::cmd_tasks::{
    tasks_list, tasks_update, tasks_upsert_external, UpdateTaskInput,
    UpsertExternalTaskInput,
};

const HTTP_TIMEOUT_SECS: u64 = 30;
const PAGE_SIZE: u32 = 100;

/// One project on a Jira cloud site, returned to the renderer for the
/// project-picker dropdown.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct JiraProject {
    pub id: String,
    pub key: String,
    pub name: String,
    #[serde(default)]
    pub avatar_url: Option<String>,
    /// Atlassian's project-type discriminator (`software`, `business`,
    /// `service_desk`). Surfaced so the UI can render a glyph hint
    /// without re-querying Atlassian for the icon.
    #[serde(default)]
    pub project_type_key: Option<String>,
}

/// Result of one sync run on a single project. Returned by `sync_now`
/// so the UI can render "Imported 12 · updated 3 · skipped 0".
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SyncOutcome {
    pub project_key: String,
    pub created: u32,
    pub updated: u32,
    pub skipped: u32,
    /// One error message per issue that failed to upsert. Soft —
    /// other issues in the same run still go through.
    pub errors: Vec<String>,
    pub synced_at: u64,
}

/// Cached-or-refreshed access token. Centralised so every Jira call
/// in this module goes through the same expiry-check path.
pub async fn valid_access_token() -> Result<ProviderTokens, IntegrationError> {
    let stored = tokens::load(IntegrationKind::Jira)?
        .ok_or_else(|| IntegrationError::NotConfigured("Jira not connected".into()))?;
    if !is_expired(&stored) {
        return Ok(stored);
    }
    let cfg = config::jira()?;
    let rt = stored.refresh_token.as_deref().ok_or_else(|| {
        IntegrationError::OAuth(
            "no refresh_token cached — disconnect + reconnect Jira to issue a new one".into(),
        )
    })?;
    let refreshed = jira::refresh(&cfg, rt).await?;
    tokens::store(IntegrationKind::Jira, &refreshed)?;
    Ok(refreshed)
}

fn is_expired(t: &ProviderTokens) -> bool {
    let Some(exp) = t.expires_at else {
        return false;
    };
    let now = now_secs();
    now + 30 >= exp
}

fn now_secs() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0)
}

fn http_client() -> Result<reqwest::Client, IntegrationError> {
    reqwest::Client::builder()
        .timeout(Duration::from_secs(HTTP_TIMEOUT_SECS))
        .build()
        .map_err(|e| IntegrationError::Other(format!("reqwest build: {e}")))
}

// ── Projects ─────────────────────────────────────────────────────────

/// List every Jira project on a cloud site that the user can access.
/// Pages through the `/project/search` endpoint (max 50/page).
pub async fn list_projects(
    access_token: &str,
    cloud_id: &str,
) -> Result<Vec<JiraProject>, IntegrationError> {
    let client = http_client()?;
    let mut out = Vec::new();
    let mut start_at: u32 = 0;
    let max_results: u32 = 50;
    loop {
        let url = format!(
            "https://api.atlassian.com/ex/jira/{cloud_id}/rest/api/3/project/search\
             ?startAt={start_at}&maxResults={max_results}&orderBy=name"
        );
        let resp = client
            .get(&url)
            .bearer_auth(access_token)
            .header("Accept", "application/json")
            .send()
            .await?;
        let status = resp.status();
        if !status.is_success() {
            let body = resp.text().await.unwrap_or_default();
            return Err(IntegrationError::Http {
                status: status.as_u16(),
                body,
            });
        }
        let page: Value = resp.json().await?;
        let values = page
            .get("values")
            .and_then(|v| v.as_array())
            .cloned()
            .unwrap_or_default();
        let n = values.len() as u32;
        for v in values {
            let id = v.get("id").and_then(|x| x.as_str()).unwrap_or("").to_string();
            let key = v.get("key").and_then(|x| x.as_str()).unwrap_or("").to_string();
            let name = v.get("name").and_then(|x| x.as_str()).unwrap_or("").to_string();
            let avatar_url = v
                .get("avatarUrls")
                .and_then(|a| a.get("48x48"))
                .and_then(|s| s.as_str())
                .map(String::from);
            let project_type_key = v
                .get("projectTypeKey")
                .and_then(|s| s.as_str())
                .map(String::from);
            if id.is_empty() || key.is_empty() {
                continue;
            }
            out.push(JiraProject {
                id,
                key,
                name,
                avatar_url,
                project_type_key,
            });
        }
        let is_last = page
            .get("isLast")
            .and_then(|v| v.as_bool())
            .unwrap_or(true);
        if is_last || n == 0 {
            break;
        }
        start_at += n;
    }
    Ok(out)
}

// ── Issues ───────────────────────────────────────────────────────────

#[derive(Debug, Clone, Deserialize)]
struct IssuePage {
    #[serde(default)]
    issues: Vec<Value>,
    #[serde(default, rename = "nextPageToken")]
    next_page_token: Option<String>,
    #[serde(default, rename = "isLast")]
    is_last: bool,
}

/// One pull-and-upsert run over a project. Walks the full issue set
/// with cursor pagination, mapping each issue to an Aura task. Errors
/// on individual issues are collected into `outcome.errors` rather
/// than aborting the whole run.
pub async fn sync_project(
    access_token: &str,
    cloud_id: &str,
    site_url: &str,
    project_key: &str,
    repo_root: &str,
) -> Result<SyncOutcome, IntegrationError> {
    sync_project_with_cache(
        access_token,
        cloud_id,
        site_url,
        project_key,
        repo_root,
        None,
    )
    .await
}

/// Same as `sync_project` but skips Jira issues unchanged since
/// `since_iso` (RFC3339, no fractional seconds). Used by the periodic
/// poller — full first pull, then incremental every 5 minutes.
pub async fn sync_project_with_cache(
    access_token: &str,
    cloud_id: &str,
    site_url: &str,
    project_key: &str,
    repo_root: &str,
    since_iso: Option<&str>,
) -> Result<SyncOutcome, IntegrationError> {
    let mut created = 0u32;
    let mut updated = 0u32;
    let mut skipped = 0u32;
    let mut errors: Vec<String> = Vec::new();
    // (child_jira_key, parent_jira_key, is_epic)
    // Collected during page sweeps; resolved into Aura parent_ids in a
    // single pass at the end so we don't have to repeatedly reload the
    // task store.
    let mut linkages: Vec<(String, Option<String>, bool)> = Vec::new();

    let client = http_client()?;
    let mut next_page: Option<String> = None;
    // JQL identifier — must be a project key. We quote the key to be
    // safe against Atlassian's reserved-word list (e.g. `OR`, `AND`).
    // Incremental: only re-fetch issues whose `updated` is after the
    // last-known sync watermark. Atlassian's JQL accepts `updated >=
    // "YYYY-MM-DD HH:MM"` (Jira time format), so we normalise the
    // ISO timestamp on the way in.
    let jql = match since_iso {
        Some(s) => {
            let stamp = s.replace('T', " ");
            let stamp = stamp.split('.').next().unwrap_or(&stamp);
            let stamp = stamp.trim_end_matches('Z');
            format!(
                "project = \"{project_key}\" AND updated >= \"{stamp}\" ORDER BY updated DESC"
            )
        }
        None => format!("project = \"{project_key}\" ORDER BY updated DESC"),
    };
    // Added: parent, issuetype, subtasks — needed for epic linkage.
    let fields = "summary,description,status,priority,assignee,labels,duedate,updated,created,parent,issuetype,subtasks";

    loop {
        let base = format!(
            "https://api.atlassian.com/ex/jira/{cloud_id}/rest/api/3/search/jql"
        );
        // url::Url handles percent-encoding for us; building this by
        // hand with `format!` invites the classic JQL space/quote bug
        // where a project key with reserved chars 400s the request.
        let mut url = url::Url::parse(&base)
            .map_err(|e| IntegrationError::Other(format!("bad base url: {e}")))?;
        {
            let mut q = url.query_pairs_mut();
            q.append_pair("jql", &jql);
            q.append_pair("fields", fields);
            q.append_pair("maxResults", &PAGE_SIZE.to_string());
            if let Some(tok) = next_page.as_deref() {
                q.append_pair("nextPageToken", tok);
            }
        }

        let resp = client
            .get(url.as_str())
            .bearer_auth(access_token)
            .header("Accept", "application/json")
            .send()
            .await?;
        let status = resp.status();
        if !status.is_success() {
            let body = resp.text().await.unwrap_or_default();
            return Err(IntegrationError::Http {
                status: status.as_u16(),
                body,
            });
        }
        let page: IssuePage = resp.json().await?;
        for issue in &page.issues {
            match upsert_issue(repo_root, issue, site_url).await {
                Ok(UpsertResult {
                    was_created,
                    child_key,
                    parent_key,
                    is_epic,
                }) => {
                    if was_created {
                        created += 1;
                    } else {
                        updated += 1;
                    }
                    linkages.push((child_key, parent_key, is_epic));
                }
                Err(e) => {
                    let key = issue
                        .get("key")
                        .and_then(|k| k.as_str())
                        .unwrap_or("<?>");
                    errors.push(format!("{key}: {e}"));
                    skipped += 1;
                }
            }
        }
        // Two termination signals: `isLast` true OR no `nextPageToken`.
        // Atlassian's API sometimes returns one or the other depending
        // on dataset size; treating either as terminal avoids an
        // infinite loop on edge-case responses.
        if page.is_last || page.next_page_token.is_none() {
            break;
        }
        next_page = page.next_page_token;
    }

    // Parent linking pass — runs once after all pages are upserted so a
    // child's parent is in the store by the time we resolve it. We load
    // the task list a single time and build a (external_id → task.id)
    // lookup keyed on the Jira source; the patch loop hits the on-disk
    // file via `tasks_update`, which already serialises writes safely.
    if !linkages.is_empty() {
        let all = tasks_list(repo_root.to_string())
            .await
            .map_err(IntegrationError::Other)?;
        let mut by_ext: std::collections::HashMap<&str, &crate::cmd_tasks::Task> =
            std::collections::HashMap::new();
        for t in &all {
            if t.external_source.as_deref() == Some("jira") {
                if let Some(ext) = t.external_id.as_deref() {
                    by_ext.insert(ext, t);
                }
            }
        }
        for (child_key, parent_key, is_epic) in &linkages {
            let child = match by_ext.get(child_key.as_str()) {
                Some(t) => *t,
                None => continue,
            };
            let want_parent_id: Option<String> = parent_key.as_deref().and_then(|pk| {
                by_ext.get(pk).map(|p| p.id.clone())
            });
            let needs_parent_patch = match (&child.parent_id, &want_parent_id) {
                (a, b) => a != b && want_parent_id.is_some(),
            };
            let needs_epic_patch = child.is_epic != *is_epic;
            if !needs_parent_patch && !needs_epic_patch {
                continue;
            }
            let mut patch = blank_update(&child.id);
            if needs_parent_patch {
                patch.parent_id = want_parent_id;
            }
            if needs_epic_patch {
                patch.is_epic = Some(*is_epic);
            }
            if let Err(e) = tasks_update(repo_root.to_string(), patch).await {
                errors.push(format!("{child_key}: parent link failed: {e}"));
            }
        }
    }

    Ok(SyncOutcome {
        project_key: project_key.into(),
        created,
        updated,
        skipped,
        errors,
        synced_at: now_secs(),
    })
}

/// One issue's upsert outcome plus the bits the parent-linking pass
/// needs to wire hierarchy correctly: the issue's Jira key, the
/// referenced parent key (if any), and whether the issue itself is an
/// epic. Returned per call so the surrounding sync loop can do one
/// consolidated lookup at the end.
pub struct UpsertResult {
    pub was_created: bool,
    pub child_key: String,
    pub parent_key: Option<String>,
    pub is_epic: bool,
}

/// Map one Jira issue JSON blob → upsert call → optional state patch.
/// Records (child_key, parent_key, is_epic) for the post-pass parent
/// linker; never sets `parent_id` itself because the parent may not be
/// in the store yet on a fresh sync.
async fn upsert_issue(
    repo_root: &str,
    issue: &Value,
    site_url: &str,
) -> Result<UpsertResult, IntegrationError> {
    let key = issue
        .get("key")
        .and_then(|k| k.as_str())
        .ok_or_else(|| IntegrationError::Other("issue missing key".into()))?
        .to_string();
    let fields = issue
        .get("fields")
        .ok_or_else(|| IntegrationError::Other("issue missing fields".into()))?;
    // Hierarchy bits — read both `parent` (sub-task / story-under-epic
    // standard field) and `issuetype.name` (Epic detection). Atlassian
    // exposes a parent for sub-tasks reliably and for story-under-epic
    // tickets in Jira Cloud since 2020; older "Epic Link" customfield
    // (10014) is handled by the modern parent field on the cloud API.
    let parent_key = fields
        .get("parent")
        .and_then(|p| p.get("key"))
        .and_then(|k| k.as_str())
        .map(String::from);
    let is_epic = fields
        .get("issuetype")
        .and_then(|t| t.get("name"))
        .and_then(|n| n.as_str())
        .map(|n| n.eq_ignore_ascii_case("Epic"))
        .unwrap_or(false);

    let title = fields
        .get("summary")
        .and_then(|s| s.as_str())
        .unwrap_or("")
        .to_string();
    let description = fields
        .get("description")
        .map(adf_to_text)
        .unwrap_or_default();
    let priority = jira_priority_to_aura(fields.get("priority"));
    let state_id = jira_status_to_state_id(fields.get("status"));
    let labels: Vec<String> = fields
        .get("labels")
        .and_then(|l| l.as_array())
        .map(|arr| {
            arr.iter()
                .filter_map(|v| v.as_str().map(String::from))
                .collect()
        })
        .unwrap_or_default();
    let due_date = fields
        .get("duedate")
        .and_then(|d| d.as_str())
        .map(String::from);
    // Assignee — Jira Cloud exposes the rich user object under `assignee`
    // (null when unassigned). Rather than dump the raw Jira name onto the
    // task (where it never lines up with the Aura roster), we resolve it to a
    // teammate: a deterministic email match — or a previously-confirmed link —
    // becomes the roster handle, so the board avatar is the real person. An
    // account we can't place yet is recorded for the brain-assisted reconcile
    // pass and shows its Jira name meanwhile. See `jira_users`.
    let assignee_ids: Vec<String> = fields
        .get("assignee")
        .and_then(super::jira_users::JiraUserRef::from_assignee)
        .map(|jira_user| super::jira_users::resolve_for_import(repo_root, &jira_user))
        .unwrap_or_default();
    let external_url = format!("{}/browse/{}", site_url.trim_end_matches('/'), key);

    let input = UpsertExternalTaskInput {
        external_source: "jira".into(),
        external_id: key.clone(),
        external_url: Some(external_url),
        title,
        description: Some(description),
        priority: Some(priority.into()),
        labels,
        due_date,
        assignee_ids,
    };
    let result = tasks_upsert_external(repo_root.to_string(), input)
        .await
        .map_err(IntegrationError::Other)?;

    // Force the state to match the Jira status category. The upsert
    // helper doesn't touch `state_id` itself (it carries no status
    // field on its input shape) so without this patch, re-runs of a
    // Jira issue that moved from "To Do" → "In Progress" would still
    // show in Aura's Backlog column.
    let current_state = result.task.state_id.as_str();
    if current_state != state_id {
        let patch = blank_update(&result.task.id);
        let patch = UpdateTaskInput {
            state_id: Some(state_id.into()),
            status: Some(state_id_to_legacy_status(state_id).into()),
            ..patch
        };
        tasks_update(repo_root.to_string(), patch)
            .await
            .map_err(IntegrationError::Other)?;
    }

    Ok(UpsertResult {
        was_created: result.created,
        child_key: key,
        parent_key,
        is_epic,
    })
}

/// All-None `UpdateTaskInput` keyed by id. Build-on-top helper so the
/// callers above can write `..blank_update(id)` and only set the few
/// fields they actually care about, instead of a 25-field struct
/// literal at every callsite.
pub(crate) fn blank_update(id: &str) -> UpdateTaskInput {
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
        bead_id: None,
        sprint: None,
        cycle_id: None,
        module_id: None,
        external_source: None,
        external_id: None,
        external_url: None,
    }
}

// ── Field mappers ────────────────────────────────────────────────────

/// Jira's `priority.name` → Aura's 5-stop ladder. Anything we don't
/// recognise (custom priority schemes) flattens to `medium` so a Jira
/// site that doesn't use the default ladder doesn't lose the value
/// entirely.
fn jira_priority_to_aura(priority: Option<&Value>) -> &'static str {
    let Some(name) = priority.and_then(|p| p.get("name")).and_then(|n| n.as_str()) else {
        return "medium";
    };
    match name.to_ascii_lowercase().as_str() {
        "highest" | "blocker" => "urgent",
        "high" | "critical" => "high",
        "medium" | "major" | "normal" => "medium",
        "low" | "minor" => "low",
        "lowest" | "trivial" => "low",
        _ => "medium",
    }
}

/// Jira's `status.statusCategory.key` → Aura's default state id.
/// Atlassian guarantees every workflow status maps onto one of three
/// canonical categories (`new` / `indeterminate` / `done`), so this
/// mapping covers every Jira site without per-workflow configuration.
/// Workflow-aware mapping (e.g. routing "In Review" → a custom Aura
/// state) is W7.
fn jira_status_to_state_id(status: Option<&Value>) -> &'static str {
    let Some(cat_key) = status
        .and_then(|s| s.get("statusCategory"))
        .and_then(|c| c.get("key"))
        .and_then(|k| k.as_str())
    else {
        return "backlog";
    };
    match cat_key {
        "new" => "backlog",
        "indeterminate" => "started",
        "done" => "completed",
        _ => "backlog",
    }
}

/// Round-trip helper — given a default state id, return the legacy
/// `status` field a v0.2.30 reader would expect. Mirrors the inverse
/// of `legacy_status_to_state_id` in `cmd_tasks.rs`.
fn state_id_to_legacy_status(state_id: &str) -> &'static str {
    match state_id {
        "backlog" | "unstarted" => "backlog",
        "started" => "in_progress",
        "completed" => "done",
        "cancelled" => "done",
        _ => "backlog",
    }
}

// ── ADF (Atlassian Document Format) → plaintext ──────────────────────
//
// Jira's `description` field is an ADF JSON document, not plain text.
// We walk the tree and emit a markdown-flavoured text rendering —
// good enough for the description card without dragging in a full
// ADF parser (which is a thousand-line dependency). Users who want
// the full formatting click `external_url` to view the issue in Jira.

fn adf_to_text(node: &Value) -> String {
    let mut out = String::new();
    walk_adf(node, &mut out, 0);
    // Collapse runs of more than two newlines — easier than tracking
    // emission state through every node type.
    let mut compact = String::with_capacity(out.len());
    let mut blank_run = 0u8;
    for line in out.split('\n') {
        if line.trim().is_empty() {
            blank_run += 1;
            if blank_run <= 2 {
                compact.push('\n');
            }
        } else {
            blank_run = 0;
            compact.push_str(line);
            compact.push('\n');
        }
    }
    compact.trim().to_string()
}

fn walk_adf(node: &Value, out: &mut String, depth: u32) {
    // Leaf text node.
    if let Some(text) = node.get("text").and_then(|t| t.as_str()) {
        out.push_str(text);
        return;
    }
    let node_type = node.get("type").and_then(|t| t.as_str()).unwrap_or("");
    let content = node.get("content").and_then(|c| c.as_array());
    match node_type {
        "paragraph" => {
            walk_children(content, out, depth);
            out.push_str("\n\n");
        }
        "heading" => {
            let level = node
                .get("attrs")
                .and_then(|a| a.get("level"))
                .and_then(|l| l.as_u64())
                .unwrap_or(1) as u32;
            for _ in 0..level.min(6) {
                out.push('#');
            }
            out.push(' ');
            walk_children(content, out, depth);
            out.push_str("\n\n");
        }
        "hardBreak" => out.push('\n'),
        "bulletList" => {
            if let Some(items) = content {
                for item in items {
                    out.push_str("- ");
                    walk_adf(item, out, depth + 1);
                    if !out.ends_with('\n') {
                        out.push('\n');
                    }
                }
            }
        }
        "orderedList" => {
            if let Some(items) = content {
                for (i, item) in items.iter().enumerate() {
                    out.push_str(&format!("{}. ", i + 1));
                    walk_adf(item, out, depth + 1);
                    if !out.ends_with('\n') {
                        out.push('\n');
                    }
                }
            }
        }
        "listItem" => {
            walk_children(content, out, depth + 1);
        }
        "codeBlock" => {
            out.push_str("\n```\n");
            walk_children(content, out, depth);
            if !out.ends_with('\n') {
                out.push('\n');
            }
            out.push_str("```\n");
        }
        "blockquote" => {
            // Simplified — no `>` prefixing because that would require
            // line-by-line buffering. Plain text is fine for the
            // description card.
            walk_children(content, out, depth);
        }
        "rule" => out.push_str("\n---\n"),
        // Mentions / emojis / inline cards: emit a friendly fallback so
        // the surrounding text doesn't look broken.
        "mention" => {
            if let Some(name) = node
                .get("attrs")
                .and_then(|a| a.get("text"))
                .and_then(|t| t.as_str())
            {
                out.push_str(name);
            } else if let Some(id) = node
                .get("attrs")
                .and_then(|a| a.get("id"))
                .and_then(|t| t.as_str())
            {
                out.push('@');
                out.push_str(id);
            }
        }
        "emoji" => {
            if let Some(s) = node
                .get("attrs")
                .and_then(|a| a.get("shortName"))
                .and_then(|t| t.as_str())
            {
                out.push_str(s);
            }
        }
        // Unknown node — preserve text content so we never lose
        // information on a future ADF version.
        _ => walk_children(content, out, depth),
    }
}

fn walk_children(content: Option<&Vec<Value>>, out: &mut String, depth: u32) {
    if let Some(items) = content {
        for item in items {
            walk_adf(item, out, depth);
        }
    }
}
