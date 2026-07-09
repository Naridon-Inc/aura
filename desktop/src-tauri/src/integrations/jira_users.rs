//! Jira person ⇄ Aura teammate linking.
//!
//! A Jira issue's `assignee` is a Jira *account* (a stable `accountId`, a
//! display name, and — only when the site exposes it — an email). The Aura
//! board, by contrast, shows people from the repo's own roster
//! (`.aura/team/team.json`), keyed by `handle`. Before this module the
//! importer dropped the raw Jira display name straight into a task's
//! `assignee_ids`, so "Alice Smith" from Jira never lined up with roster
//! `handle: alice` — wrong avatars, no way to filter the board by a real
//! teammate, and a re-sync never healed it.
//!
//! This module gives every Jira account a durable link to a roster handle:
//!
//!   1. **Deterministic** — if Jira exposes the assignee's email and it matches
//!      a teammate's `email` / `also_emails`, we link immediately. Zero
//!      ambiguity, no model call.
//!   2. **Brain-assisted** — Jira frequently hides email (privacy), leaving only
//!      a display name. Those land as *unresolved*; the reconcile pass asks
//!      Aura's own brain to propose the most likely teammate with a confidence,
//!      which the user confirms with one click (we never merge two identities
//!      silently — mis-merging real people is hard to undo).
//!
//! The link table is persisted per-repo at `.aura/integrations/jira_user_map.json`
//! so resolution is stable and cheap on every later sync (a known account
//! resolves from the map without touching the roster or the brain), and so a
//! confirmed match survives restarts.

use std::collections::BTreeSet;
use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};

use serde::{Deserialize, Serialize};
use serde_json::{json, Value};

// ── Jira-side identity ────────────────────────────────────────────────────

/// One Jira person as the issue's `assignee` object exposes them. Every field
/// is optional: a Jira Cloud site may withhold the email, and very old
/// instances may lack a stable `accountId`.
#[derive(Debug, Clone, Default)]
pub struct JiraUserRef {
    pub account_id: Option<String>,
    pub display_name: Option<String>,
    pub email: Option<String>,
}

impl JiraUserRef {
    /// Pull a `JiraUserRef` out of an issue's `assignee` value. Returns `None`
    /// for an unassigned issue (Jira sends JSON `null`) or a value with nothing
    /// human-identifying in it.
    pub fn from_assignee(assignee: &Value) -> Option<Self> {
        if assignee.is_null() {
            return None;
        }
        let str_field = |k: &str| {
            assignee
                .get(k)
                .and_then(|v| v.as_str())
                .map(str::trim)
                .filter(|s| !s.is_empty())
                .map(str::to_string)
        };
        let me = JiraUserRef {
            account_id: str_field("accountId"),
            display_name: str_field("displayName").or_else(|| str_field("name")),
            email: str_field("emailAddress"),
        };
        if me.account_id.is_none() && me.display_name.is_none() && me.email.is_none() {
            return None;
        }
        Some(me)
    }

    /// The best human-facing label for this Jira account — what we store on a
    /// task's `assignee_ids` while the account is still unlinked, so the board
    /// shows *something* recognisable instead of a blank avatar.
    pub fn label(&self) -> String {
        self.display_name
            .clone()
            .or_else(|| self.email.clone())
            .or_else(|| self.account_id.clone())
            .unwrap_or_default()
    }
}

// ── Persisted link table ──────────────────────────────────────────────────

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum LinkStatus {
    /// Bound to a roster handle (deterministically or by a confirmed match).
    Resolved,
    /// Seen on an import but not yet matched to a teammate.
    Unresolved,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum LinkVia {
    /// Jira email matched a teammate's `email` / `also_emails`.
    Email,
    /// The brain proposed it and the user confirmed.
    Brain,
    /// The user picked the teammate by hand.
    Manual,
    /// Not linked yet.
    None,
}

/// One Jira account's link state. Keyed by `account_id` (falling back to the
/// display label when a legacy Jira instance has no account id).
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct JiraUserLink {
    /// Stable Jira key for this person (`accountId`, or the display label when
    /// the site is too old to expose one).
    pub account_id: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub display_name: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub email: Option<String>,
    /// The Aura roster handle this account is linked to, when resolved.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub handle: Option<String>,
    pub status: LinkStatus,
    pub via: LinkVia,
    /// Confidence of a brain-proposed match (0–1). `None` for deterministic /
    /// manual links.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub confidence: Option<f64>,
    /// Unix seconds of the last change to this link.
    pub updated_at: i64,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct JiraUserMap {
    #[serde(default)]
    pub links: Vec<JiraUserLink>,
}

impl JiraUserMap {
    fn path(repo_root: &str) -> PathBuf {
        Path::new(repo_root)
            .join(".aura")
            .join("integrations")
            .join("jira_user_map.json")
    }

    pub fn load(repo_root: &str) -> Self {
        let path = Self::path(repo_root);
        std::fs::read_to_string(&path)
            .ok()
            .and_then(|raw| serde_json::from_str::<JiraUserMap>(&raw).ok())
            .unwrap_or_default()
    }

    pub fn save(&self, repo_root: &str) -> Result<(), String> {
        let path = Self::path(repo_root);
        if let Some(dir) = path.parent() {
            std::fs::create_dir_all(dir).map_err(|e| format!("create integrations dir: {e}"))?;
        }
        let raw = serde_json::to_string_pretty(self).map_err(|e| e.to_string())?;
        std::fs::write(&path, raw).map_err(|e| format!("write jira user map: {e}"))
    }

    pub fn get(&self, account_id: &str) -> Option<&JiraUserLink> {
        self.links.iter().find(|l| l.account_id == account_id)
    }

    /// Insert or replace the link for an account id.
    pub fn upsert(&mut self, link: JiraUserLink) {
        if let Some(slot) = self
            .links
            .iter_mut()
            .find(|l| l.account_id == link.account_id)
        {
            *slot = link;
        } else {
            self.links.push(link);
        }
    }
}

// ── Aura roster (slim reader) ─────────────────────────────────────────────

/// Only the roster fields this module needs. Deserialized straight from
/// `.aura/team/team.json` so we stay decoupled from `cmd_team`'s full
/// `TeamMember` shape (and tolerant of older manifests).
#[derive(Debug, Clone, Deserialize)]
pub struct RosterMember {
    #[serde(default)]
    pub handle: String,
    #[serde(default)]
    pub name: String,
    #[serde(default)]
    pub email: String,
    #[serde(default)]
    pub also_emails: Vec<String>,
    #[serde(default)]
    pub github_login: Option<String>,
}

#[derive(Debug, Default, Deserialize)]
struct RosterManifest {
    #[serde(default)]
    members: Vec<RosterMember>,
}

pub fn load_roster(repo_root: &str) -> Vec<RosterMember> {
    let path = Path::new(repo_root)
        .join(".aura")
        .join("team")
        .join("team.json");
    std::fs::read_to_string(&path)
        .ok()
        .and_then(|raw| serde_json::from_str::<RosterManifest>(&raw).ok())
        .map(|m| m.members)
        .unwrap_or_default()
}

/// Deterministic match: a Jira email that equals a teammate's `email` or one of
/// their `also_emails` (case-insensitive). Returns the roster handle. Names are
/// deliberately NOT matched here — that's the brain's job, because names
/// collide and a wrong auto-link is worse than an unresolved one.
fn match_by_email(roster: &[RosterMember], email: &str) -> Option<String> {
    let e = email.trim().to_lowercase();
    if e.is_empty() {
        return None;
    }
    roster
        .iter()
        .find(|m| {
            m.email.eq_ignore_ascii_case(&e)
                || m.also_emails.iter().any(|a| a.eq_ignore_ascii_case(&e))
        })
        .filter(|m| !m.handle.is_empty())
        .map(|m| m.handle.clone())
}

fn now_secs() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs() as i64)
        .unwrap_or(0)
}

// ── Import-time resolution ────────────────────────────────────────────────

/// Resolve a Jira assignee to the `assignee_ids` value to store on the task.
///
/// Order: a confirmed/known link in the map → a deterministic email match →
/// otherwise record the account as *unresolved* and fall back to its display
/// label (so the board still shows who owns the card until it's linked).
///
/// The map is only written when something actually changes (a new account, or a
/// freshly-resolved one), so re-syncing a project full of already-known people
/// touches no disk.
pub fn resolve_for_import(repo_root: &str, jira: &JiraUserRef) -> Vec<String> {
    let label = jira.label();
    // The stable key: prefer accountId, fall back to the label for legacy
    // Jira instances that don't expose one (still better than nothing).
    let key = jira
        .account_id
        .clone()
        .or_else(|| (!label.is_empty()).then(|| label.clone()));
    let Some(key) = key else {
        return Vec::new();
    };

    let mut map = JiraUserMap::load(repo_root);

    // 1. Already linked? Use the stored handle, no roster/brain work.
    if let Some(existing) = map.get(&key) {
        if let Some(handle) = existing.handle.clone() {
            if existing.status == LinkStatus::Resolved && !handle.is_empty() {
                return vec![handle];
            }
        }
    }

    // 2. Deterministic email match.
    if let Some(email) = jira.email.as_deref() {
        let roster = load_roster(repo_root);
        if let Some(handle) = match_by_email(&roster, email) {
            map.upsert(JiraUserLink {
                account_id: key,
                display_name: jira.display_name.clone(),
                email: jira.email.clone(),
                handle: Some(handle.clone()),
                status: LinkStatus::Resolved,
                via: LinkVia::Email,
                confidence: None,
                updated_at: now_secs(),
            });
            let _ = map.save(repo_root);
            return vec![handle];
        }
    }

    // 3. Unresolved — record it (once) so the reconcile pass can surface it,
    //    and show the display label on the board meanwhile.
    let already_recorded = map
        .get(&key)
        .map(|l| l.status == LinkStatus::Unresolved && l.handle.is_none())
        .unwrap_or(false);
    if !already_recorded {
        map.upsert(JiraUserLink {
            account_id: key,
            display_name: jira.display_name.clone(),
            email: jira.email.clone(),
            handle: None,
            status: LinkStatus::Unresolved,
            via: LinkVia::None,
            confidence: None,
            updated_at: now_secs(),
        });
        let _ = map.save(repo_root);
    }

    if label.is_empty() {
        Vec::new()
    } else {
        vec![label]
    }
}

// ── Brain-assisted reconcile ──────────────────────────────────────────────

/// One brain-proposed (or empty) match for an unresolved Jira person, shaped
/// for the reconcile UI.
#[derive(Debug, Clone, Serialize)]
pub struct ReconcileSuggestion {
    pub account_id: String,
    pub display_name: Option<String>,
    pub email: Option<String>,
    /// The roster handle the brain proposes, or `None` for "no confident match".
    pub suggested_handle: Option<String>,
    /// That teammate's display name, for the UI.
    pub suggested_name: Option<String>,
    pub confidence: f64,
    pub reason: String,
}

/// Result of confirming a link — how many existing tasks were re-pointed at the
/// teammate's handle.
#[derive(Debug, Clone, Serialize)]
pub struct LinkApplied {
    pub account_id: String,
    pub handle: String,
    pub tasks_updated: usize,
}

/// The current link table, for the Settings panel to render (resolved +
/// unresolved). Sorted unresolved-first so the work-to-do floats up.
pub fn list_links(repo_root: &str) -> Vec<JiraUserLink> {
    let mut links = JiraUserMap::load(repo_root).links;
    links.sort_by(|a, b| {
        let rank = |s: LinkStatus| match s {
            LinkStatus::Unresolved => 0,
            LinkStatus::Resolved => 1,
        };
        rank(a.status)
            .cmp(&rank(b.status))
            .then_with(|| a.display_name.cmp(&b.display_name))
    });
    links
}

#[derive(Deserialize)]
struct RawSuggestion {
    account_id: String,
    #[serde(default)]
    handle: Option<String>,
    #[serde(default)]
    confidence: Option<f64>,
    #[serde(default)]
    reason: Option<String>,
}

/// Ask Aura's own brain to match every *unresolved* Jira person to the most
/// likely teammate. Conservative by instruction: it returns `null` for anyone
/// it isn't confident about, so the user is never nudged into a wrong merge.
///
/// Returns one suggestion per unresolved account (including the no-match ones,
/// so the UI can show "no confident match — pick by hand"). An empty roster or
/// no unresolved accounts short-circuits without a brain call.
pub async fn reconcile_suggest(repo_root: &str) -> Result<Vec<ReconcileSuggestion>, String> {
    let map = JiraUserMap::load(repo_root);
    let unresolved: Vec<JiraUserLink> = map
        .links
        .into_iter()
        .filter(|l| l.status == LinkStatus::Unresolved)
        .collect();
    if unresolved.is_empty() {
        return Ok(Vec::new());
    }
    let roster = load_roster(repo_root);
    if roster.is_empty() {
        // Nothing to match against — surface the people as no-match rows rather
        // than spending a brain call.
        return Ok(unresolved
            .into_iter()
            .map(|l| ReconcileSuggestion {
                account_id: l.account_id,
                display_name: l.display_name,
                email: l.email,
                suggested_handle: None,
                suggested_name: None,
                confidence: 0.0,
                reason: "No teammates in this repo's roster yet.".into(),
            })
            .collect());
    }

    let valid_handles: BTreeSet<String> =
        roster.iter().map(|m| m.handle.clone()).collect();

    let payload = json!({
        "jira_people": unresolved.iter().map(|l| json!({
            "account_id": l.account_id,
            "display_name": l.display_name,
            "email": l.email,
        })).collect::<Vec<_>>(),
        "team": roster.iter().map(|m| json!({
            "handle": m.handle,
            "name": m.name,
            "email": m.email,
            "also_emails": m.also_emails,
            "github_login": m.github_login,
        })).collect::<Vec<_>>(),
    });

    let request = crate::manager::brain::types::ChatRequest {
        messages: vec![crate::manager::brain::types::ChatMessage {
            role: "user".into(),
            content: Value::String(format!(
                "Match each Jira person to the single teammate who is most likely \
                 the SAME human, or null if none is a confident match.\n\n{}",
                serde_json::to_string_pretty(&payload).unwrap_or_default()
            )),
        }],
        cwd: String::new(),
        system: Some(RECONCILE_SYSTEM.into()),
        tools: vec![],
        max_tokens: Some(1024),
        temperature: Some(0.0),
        effort: None,
        fast: true,
        model: None,
        long_context: false,
        approval: None,
    };

    let raw = crate::cmd_loop::plan_collect(request).await?;
    let parsed = parse_suggestions(&raw);

    // Join the brain output back onto the unresolved list, defending against a
    // hallucinated handle that isn't actually on the roster.
    Ok(unresolved
        .into_iter()
        .map(|l| {
            let hit = parsed.iter().find(|s| s.account_id == l.account_id);
            let handle = hit
                .and_then(|s| s.handle.clone())
                .filter(|h| valid_handles.contains(h));
            let suggested_name = handle
                .as_ref()
                .and_then(|h| roster.iter().find(|m| &m.handle == h))
                .map(|m| m.name.clone())
                .filter(|n| !n.is_empty());
            ReconcileSuggestion {
                account_id: l.account_id,
                display_name: l.display_name,
                email: l.email,
                confidence: hit.and_then(|s| s.confidence).unwrap_or(0.0).clamp(0.0, 1.0),
                reason: hit
                    .and_then(|s| s.reason.clone())
                    .filter(|r| !r.trim().is_empty())
                    .unwrap_or_else(|| "No confident match — pick by hand.".into()),
                suggested_handle: handle,
                suggested_name,
            }
        })
        .collect())
}

/// Pull the first JSON array out of the brain's reply (it may wrap it in prose
/// or a ```json fence) and parse the suggestions. A garbled reply yields an
/// empty list — every account then shows as "pick by hand", never a fake match.
fn parse_suggestions(raw: &str) -> Vec<RawSuggestion> {
    let start = match raw.find('[') {
        Some(i) => i,
        None => return Vec::new(),
    };
    let end = match raw.rfind(']') {
        Some(i) if i > start => i,
        _ => return Vec::new(),
    };
    serde_json::from_str::<Vec<RawSuggestion>>(&raw[start..=end]).unwrap_or_default()
}

const RECONCILE_SYSTEM: &str = "You reconcile external Jira users with members \
of a software team's roster. For each Jira person, pick the one roster member \
who is most plausibly the same human — judge by display name, email, and email \
local-part. Be conservative: when in doubt, return null rather than guess, \
because a wrong link merges two different people and is painful to undo. Output \
ONLY a JSON array, one object per Jira person, each: {\"account_id\": string, \
\"handle\": string or null, \"confidence\": number between 0 and 1, \"reason\": \
short string}. No prose, no code fence.";

/// Confirm a link: bind the Jira account to a teammate's handle and re-point
/// every already-imported Jira task that still carries the old display label.
/// This is the one-click "Link" the reconcile UI calls — never automatic.
pub async fn apply_link(
    repo_root: &str,
    account_id: &str,
    handle: &str,
) -> Result<LinkApplied, String> {
    let handle = handle.trim().to_string();
    if handle.is_empty() {
        return Err("Pick a teammate to link to.".into());
    }

    // 1. Record the confirmed link.
    let mut map = JiraUserMap::load(repo_root);
    let prior = map.get(account_id).cloned();
    let (display_name, email, confidence) = prior
        .as_ref()
        .map(|l| (l.display_name.clone(), l.email.clone(), l.confidence))
        .unwrap_or((None, None, None));
    map.upsert(JiraUserLink {
        account_id: account_id.to_string(),
        display_name: display_name.clone(),
        email: email.clone(),
        handle: Some(handle.clone()),
        status: LinkStatus::Resolved,
        via: LinkVia::Manual,
        confidence,
        updated_at: now_secs(),
    });
    map.save(repo_root)?;

    // 2. Re-point existing Jira tasks. The old assignee value could be any of
    //    the labels `resolve_for_import` might have written for this account.
    let mut old_labels: BTreeSet<String> = BTreeSet::new();
    if let Some(dn) = display_name {
        old_labels.insert(dn);
    }
    if let Some(em) = email {
        old_labels.insert(em);
    }
    old_labels.insert(account_id.to_string());

    let tasks = crate::cmd_tasks::tasks_list(repo_root.to_string()).await?;
    let mut updated = 0usize;
    for task in tasks {
        if task.external_source.as_deref() != Some("jira") {
            continue;
        }
        if !task
            .assignee_ids
            .iter()
            .any(|a| old_labels.contains(a) && a != &handle)
        {
            continue;
        }
        // Swap any old-label entry for the handle, de-duplicating.
        let mut next: Vec<String> = Vec::new();
        for a in &task.assignee_ids {
            let mapped = if old_labels.contains(a) {
                handle.clone()
            } else {
                a.clone()
            };
            if !next.contains(&mapped) {
                next.push(mapped);
            }
        }
        let patch = crate::cmd_tasks::UpdateTaskInput {
            assignee_ids: Some(next),
            ..crate::integrations::jira_sync::blank_update(&task.id)
        };
        crate::cmd_tasks::tasks_update(repo_root.to_string(), patch).await?;
        updated += 1;
    }

    Ok(LinkApplied {
        account_id: account_id.to_string(),
        handle,
        tasks_updated: updated,
    })
}

/// Drop a link (e.g. it was wrong). Resets the account to unresolved so it
/// reappears in the reconcile list; does not touch already-imported tasks.
pub fn unlink(repo_root: &str, account_id: &str) -> Result<(), String> {
    let mut map = JiraUserMap::load(repo_root);
    if let Some(slot) = map.links.iter_mut().find(|l| l.account_id == account_id) {
        slot.handle = None;
        slot.status = LinkStatus::Unresolved;
        slot.via = LinkVia::None;
        slot.confidence = None;
        slot.updated_at = now_secs();
        map.save(repo_root)?;
    }
    Ok(())
}
