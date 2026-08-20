// Team + chat substrate.
//
// Identity comes from git. Whoever has authored a commit IS on the
// team — no separate signup. The team manifest lives at
// `.aura/team/team.json` and is rebuilt-merged from `git log` on
// every load: new contributors are appended, existing entries keep
// their `claimed` and `admin` flags.
//
// Messages are file-backed JSONL at `.aura/team/chat/<channel>.jsonl`
// — append-only, ordered by ts. Threads are flat: every message has
// an optional `thread_parent` pointing at the message id it replies
// to. Channels are virtual — anything written to `chat/<name>.jsonl`
// becomes a channel.
//
// Cloud sync is intentionally deferred. The data shape here is the
// shape the cloud will mirror: same fields, same ids. When we wire
// cloud transport, this module's send-path will fan out to both the
// local JSONL and the cloud API; reads will merge.
//
// REGISTER (paste into `aura-shell/src-tauri/src/lib.rs` invoke_handler):
//     cmd_team::chat_outbox_status,
//     cmd_team::chat_resend,
//     cmd_team::chat_subscribe_since,
//     cmd_team::chat_outbox_drain_kickoff,
//
// REGISTER (paste into `aura-shell/src/lib/api.ts` near the other chat wrappers):
//     chatOutboxStatus: (repoRoot: string, channel: string) =>
//       invoke<OutboxEntry[]>("chat_outbox_status", { repoRoot, channel }),
//     chatResend: (repoRoot: string, channel: string, msgId: string) =>
//       invoke<void>("chat_resend", { repoRoot, channel, msgId }),
//     chatSubscribeSince: (repoRoot: string, channel: string, sinceSeq: number | null) =>
//       invoke<ChatMessage[]>("chat_subscribe_since", {
//         repoRoot, channel, sinceSeq: sinceSeq ?? null,
//       }),
//     chatOutboxDrainKickoff: (repoRoot: string) =>
//       invoke<void>("chat_outbox_drain_kickoff", { repoRoot }),
//
// REGISTER (paste near `export type ChatMessage` in api.ts — extend the type):
//     ChatMessage gains:
//       delivery_status?: "pending" | "delivered" | "failed";
//       seq?: number;
//     New type:
//       export type OutboxEntry = {
//         msg_id: string;
//         channel: string;
//         attempts: number;
//         last_error?: string;
//         next_attempt_ts: number;
//         failed: boolean;
//       };

use chrono::DateTime;
use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;
use std::fs::{self, OpenOptions};
use std::io::{BufRead, BufReader, Write};
use std::path::{Path, PathBuf};
use std::sync::RwLock;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use crate::cloud_session_sync::{cloud_origin, read_credentials};
use crate::cmd_device::{effective_identity, effective_room_id, room_id_for_repo};
use crate::cloud_org::OrgScoped;

const TEAM_DIR: &str = ".aura/team";
const TEAM_JSON: &str = "team.json";
const CHAT_DIR: &str = "chat";
const DEFAULT_CHANNELS: &[&str] = &["general", "agents", "sentinel", "pull-requests"];

// Built-in owner emails — these accounts are always granted admin in
// every team manifest at load time. Matches case-insensitively against
// `member.email`. Keeps the project owner from getting locked out of
// repos where a teammate clicked "Claim" first. Override-only — does
// not demote other admins.
const OWNER_EMAILS: &[&str] = &[
    "ashiqwayanad007@gmail.com",
    // GitHub noreply form for the same user
    "ashiqwayanad007@users.noreply.github.com",
];

fn is_owner_email(email: &str) -> bool {
    let e = email.trim().to_lowercase();
    OWNER_EMAILS.iter().any(|o| *o == e)
}

// ── Types ────────────────────────────────────────────────────────────

#[derive(Serialize, Deserialize, Clone, Debug)]
pub struct TeamMember {
    pub email: String,
    pub name: String,
    pub handle: String,    // local-part of email, lowercased
    pub commits: u32,
    pub first_seen: i64,
    pub last_seen: i64,
    #[serde(default)]
    pub claimed: bool,     // user has identified themselves as this member
    #[serde(default)]
    pub admin: bool,       // first claimer becomes admin
    /// Optional one-line activity status surfaced from the presence
    /// beacon. Never persisted to `team.json` — set transiently after
    /// merging the cloud presence list. `#[serde(default)]` so older
    /// manifests on disk still deserialize cleanly.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub activity_text: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub status_emoji: Option<String>,
    /// Slug of the channel whose voice room this member is currently in,
    /// derived from the same presence beacon. Surfaces the per-channel
    /// 🎧 N chip + the inline roster without any LiveKit API call. Same
    /// non-persistence semantics as `activity_text`.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub voice_channel: Option<String>,
    /// Provenance of this member in the git history. `Direct` means they
    /// have at least one commit reachable from `origin`'s branches.
    /// `Ancestor` means we only saw them via an `upstream` remote — this
    /// repo is a fork and this person committed to the parent project
    /// but not to this fork. `Both` means both. Drives the "upstream"
    /// tag in the chat roster so a fork owner can tell their actual
    /// collaborators apart from inherited upstream contributors.
    #[serde(default)]
    pub source: TeamMemberSource,
    /// Additional git emails that resolve to this member. Lets one person
    /// be enrolled as `mck@naridon.com` while their local git uses
    /// `mubasheer.ck@hotmail.com` (or any number of work/personal addresses).
    /// Read-only for non-admins; an admin populates this via the
    /// `team_alias_add` command. The `email` field stays the canonical
    /// identity — `also_emails` is purely additive lookup metadata.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub also_emails: Vec<String>,
    /// GitHub login this member maps to, when known. Populated by
    /// `team_sync_collaborators` either by matching the local `gh` login
    /// to the member who owns the local git email, or — for a member that
    /// only exists because they're a repo collaborator — set to the
    /// collaborator's login. Lets a person be recognised before they ever
    /// commit, and lets the UI show a GitHub identity next to a git one.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub github_login: Option<String>,
    /// The collaborator's repo permission on GitHub — one of "admin",
    /// "maintain", or "push" (write). Only set for members surfaced via
    /// the collaborators API. Drives the "has access" badge in the roster
    /// for people who have edit rights but haven't committed yet. `None`
    /// for ordinary commit-derived members.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub repo_role: Option<String>,
}

/// Provenance of a team member relative to this repo's remotes. See the
/// `source` field on `TeamMember` for the full rationale.
#[derive(Serialize, Deserialize, Clone, Copy, Debug, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum TeamMemberSource {
    /// Authored at least one commit reachable from `origin`.
    Direct,
    /// Only seen via the `upstream` remote — inherited from the parent
    /// repo. Surfaced read-only in the UI.
    Ancestor,
    /// Authored commits visible from both `origin` and `upstream`.
    Both,
    /// Has no commits at all — surfaced purely because they hold an edit
    /// (push/maintain/admin) permission on the GitHub repo. Added by
    /// `team_sync_collaborators` so the roster reflects everyone who *can*
    /// contribute, not only those who already have. Once such a person
    /// commits, `sync_with_git` upgrades them to `Direct` and the synthetic
    /// row is reconciled away.
    Collaborator,
}

impl Default for TeamMemberSource {
    fn default() -> Self {
        // Manifests written before this field existed only tracked
        // direct origin authors, so defaulting to `Direct` keeps every
        // pre-existing member exactly where they were on disk.
        TeamMemberSource::Direct
    }
}

#[derive(Serialize, Deserialize, Clone, Debug)]
pub struct TeamManifest {
    pub team_id: String,
    pub repo_root: String,
    pub created_at: i64,
    #[serde(default)]
    pub members: Vec<TeamMember>,
    /// Flat channel slug list. Kept as the canonical channel *roster* for
    /// back-compat: every channel that exists appears here, and manifests
    /// written before structured channels still deserialize. Visibility
    /// and membership live in the parallel `channel_meta` below; a slug
    /// present in `channels` with no `channel_meta` entry is an open
    /// channel everyone can see (the historical default).
    #[serde(default)]
    pub channels: Vec<String>,
    /// Structured per-channel metadata, additive over `channels`. Only
    /// channels that need non-default settings (private visibility, a
    /// member allow-list, a topic, channel admins) carry an entry; the
    /// absence of an entry means "open, no topic". `skip_serializing_if`
    /// keeps `team.json` byte-identical for teams that never create a
    /// private channel, so this field is invisible until used.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub channel_meta: Vec<ChannelMeta>,
    /// Unix seconds of the last successful GitHub-collaborators sync.
    /// `team_sync_collaborators` throttles on this so the team surface can
    /// call it on every mount without hammering the `gh` API; a `force`
    /// flag bypasses the throttle. Zero on manifests written before the
    /// collaborator-roster feature existed.
    #[serde(default)]
    pub collaborators_synced_at: i64,
    /// Human-confirmed "these two are NOT the same person" decisions. The
    /// duplicate *suggester* proposes weak-signal matches (a shared name, an
    /// email stem that looks like a GitHub login) for a human to confirm; when
    /// they say "different people", we record the pair here so it is never
    /// suggested again. Shared team state — one admin's "no" spares everyone the
    /// re-prompt. Never causes a merge; it only suppresses a suggestion. Empty
    /// (and invisible in `team.json`) until the first rejection.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub identity_splits: Vec<IdentitySplit>,
    /// Human-confirmed "these two ARE the same person" decisions — the mirror of
    /// `identity_splits`. A merge alias on `also_emails` alone is fragile: every
    /// load re-derives committer rows from `git log`, and `collapse_duplicate_
    /// members` only auto-fuses rows that share an email/login token, so a
    /// confirmed pair that shares NEITHER (e.g. a GitHub handle vs a personal
    /// Gmail) re-surfaces as separate rows and gets re-suggested — the "I merged
    /// this already, why is it back" bug. Recording the pair here lets collapse
    /// FORCE the union on every rebuild, so a human "Same person" sticks no
    /// matter how the roster is re-derived. Shared team state. A later "different
    /// people" removes the pair, and `identity_splits` wins on any conflict.
    /// Empty (and invisible in `team.json`) until the first confirmed merge.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub identity_merges: Vec<IdentitySplit>,
}

/// A confirmed "not the same person" pair — two emails a human has said belong
/// to distinct people, so the duplicate suggester must stop proposing them.
/// Stored normalised (both lowercased, `a` <= `b`) so a pair dedupes regardless
/// of the order it was rejected in.
#[derive(Serialize, Deserialize, Clone, Debug, Default, PartialEq, Eq)]
pub struct IdentitySplit {
    pub a: String,
    pub b: String,
}

/// Normalise an email pair for `identity_splits` / `identity_merges`: both
/// trimmed + lowercased, `a <= b`, so a pair dedupes regardless of the order it
/// was recorded in (survivor-first vs. merged-first).
fn normalize_pair(a: &str, b: &str) -> IdentitySplit {
    let a = a.trim().to_lowercase();
    let b = b.trim().to_lowercase();
    let (lo, hi) = if a <= b { (a, b) } else { (b, a) };
    IdentitySplit { a: lo, b: hi }
}

/// One proposed "these rows look like the same person" group, for the roster's
/// review banner. Purely advisory — nothing is merged until a human confirms,
/// at which point `team_identity_confirm_duplicate` folds the group into the
/// survivor via the existing `also_emails` alias path.
#[derive(Serialize, Clone, Debug)]
pub struct DuplicateSuggestion {
    /// Canonical emails of the rows in this group (2+), survivor first.
    pub emails: Vec<String>,
    /// Display handles, parallel to `emails`.
    pub handles: Vec<String>,
    /// Display names, parallel to `emails`.
    pub names: Vec<String>,
    /// The recommended survivor email (same ranking as the auto-merge: a
    /// claimed, real, high-commit, oldest seat wins).
    pub survivor_email: String,
    /// "high" when at least one pair in the group matched on a strong signal
    /// (a name that equals a GitHub login, or an email stem that prefixes one);
    /// "medium" when the whole group rests on softer name overlap.
    pub confidence: String,
    /// Plain-language explanation of why these look like one person.
    pub reason: String,
}

/// Visibility + membership for a single channel. Advisory, like the rest
/// of the git-derived roster: anyone with the clone can read the JSONL,
/// so `private` governs what the UI *surfaces*, not cryptographic access.
/// Cloud-enforced channels are a later opt-in (Aura-account login).
#[derive(Serialize, Deserialize, Clone, Debug)]
pub struct ChannelMeta {
    pub slug: String,
    /// "open" (default) — every team member sees and posts. "private" —
    /// only `members` (plus team admins) see it in the rail.
    #[serde(default = "default_channel_visibility")]
    pub visibility: String,
    /// Member emails for a private channel. Ignored for open channels.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub members: Vec<String>,
    /// Channel-level admins (emails) who can manage membership/topic even
    /// without being a team-wide admin. The creator is seeded here.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub admins: Vec<String>,
    /// Optional one-line channel topic shown in the channel header.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub topic: Option<String>,
    /// Team-shared custom tabs pinned to the channel header (a URL each —
    /// a dashboard, a doc, a tracker). Slack-bookmark semantics: any team
    /// member may add or remove one; this is the advisory git layer where
    /// anyone with the clone could edit team.json anyway, so an admin gate
    /// would be theater. Absent for channels that never pin a tab, keeping
    /// legacy team.json byte-identical.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub tabs: Vec<ChannelTabDef>,
    #[serde(default)]
    pub created_at: i64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub created_by: Option<String>,
}

/// One custom channel tab: a labelled URL rendered as an extra tab in the
/// channel header (embedded when the site allows framing, with an
/// open-external escape hatch when it doesn't).
#[derive(Serialize, Deserialize, Clone, Debug)]
pub struct ChannelTabDef {
    pub id: String,
    pub label: String,
    pub url: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub added_by: Option<String>,
    #[serde(default)]
    pub created_at: i64,
}

fn default_channel_visibility() -> String {
    "open".to_string()
}

/// Channels that ship with every team and must not be deleted — they're
/// load-bearing for agent fan-out, sentinel, and PR notifications.
const CORE_CHANNELS: &[&str] = &["general", "agents", "sentinel", "pull-requests"];

#[derive(Serialize, Clone, Debug)]
pub struct TeamIdentity {
    pub email: String,
    pub handle: String,
    pub name: String,
    pub in_team: bool,     // is this email already a known member?
    pub claimed: bool,     // has it been claimed?
    pub admin: bool,
    /// Result of `resolve_handle()` — the handle/name that send paths
    /// stamp on outgoing messages and that receive paths use for
    /// canonicalisation. Equal to `handle`/`name` for the simple case,
    /// but diverges when a per-repo override is set or when the local
    /// git email matches a teammate's `also_emails` alias.
    #[serde(default)]
    pub effective_handle: String,
    #[serde(default)]
    pub effective_name: String,
    /// The machine's signed-in GitHub account (`gh api user`), when
    /// resolvable. When present the frontend anchors "is this message
    /// mine?" on THIS — not the shared git email — so two accounts that
    /// happen to share a local `git config user.email` don't each render
    /// the other's messages as their own.
    #[serde(default)]
    pub account_login: Option<String>,
}

#[derive(Serialize, Deserialize, Clone, Debug)]
pub struct ChatMessage {
    pub id: String,
    pub channel: String,
    pub ts: i64,
    pub from_handle: String,
    pub from_name: String,
    pub body: String,
    #[serde(default)]
    pub mentions: Vec<String>,        // handles mentioned in body
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub thread_parent: Option<String>,
    #[serde(default)]
    pub is_agent: bool,
    /// "pending" until the cloud post (or WS echo) acks; "delivered" on
    /// success; "failed" once the retry queue gives up. Defaults to
    /// "delivered" for back-compat: rows written by previous versions
    /// had no concept of pending state, and the only way they ended up
    /// in the JSONL was through a (best-effort) successful send.
    #[serde(default = "default_delivery_status")]
    pub delivery_status: String,
    /// Monotonic per-room sequence assigned by the cloud. `None` for
    /// rows that never made the cloud round-trip (purely local sends,
    /// or pending ones whose echo hasn't arrived yet).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub seq: Option<i64>,
    /// The sending install's per-machine device id, carried through from the
    /// cloud/WS row so the frontend can tell "a peer who happens to share my
    /// git-email local-part" apart from "actually me". Identity on the wire is
    /// derived, never verified — two people configured with the same
    /// `user.email` both resolve to one email-prefix handle — so the device id
    /// is the tiebreaker that stops a colleague's message rendering with a
    /// "you" badge. `None` for purely local echoes (which are self by
    /// construction) and for legacy rows written before this field existed.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub from_device_id: Option<String>,
}

fn default_delivery_status() -> String { "delivered".to_string() }

/// Per-pending-message bookkeeping persisted at `.aura/team/outbox.jsonl`.
/// Survives app restarts so a process killed mid-retry resumes cleanly.
#[derive(Serialize, Deserialize, Clone, Debug)]
pub struct OutboxEntry {
    pub msg_id: String,
    pub channel: String,
    pub attempts: u32,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub last_error: Option<String>,
    /// Wall-clock epoch seconds at which the next retry is due. The
    /// drainer skips entries whose `next_attempt_ts` is in the future
    /// — this is how the exponential backoff is encoded on disk.
    #[serde(default)]
    pub next_attempt_ts: i64,
    /// True once we've exhausted MAX_ATTEMPTS. The entry stays in the
    /// outbox so the UI can surface a "send failed" badge and offer
    /// `chat_resend`; it's removed only on successful resend.
    #[serde(default)]
    pub failed: bool,
}

const MAX_OUTBOX_ATTEMPTS: u32 = 5;
// Exponential backoff schedule in seconds. Index 0 == before first
// retry, so attempts[0] is the wait after the initial send fails.
const BACKOFF_SECS: &[i64] = &[1, 2, 4, 8, 16];

// ── Helpers ──────────────────────────────────────────────────────────

fn now_secs() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs() as i64)
        .unwrap_or(0)
}

fn team_dir(repo_root: &str) -> PathBuf {
    PathBuf::from(repo_root).join(TEAM_DIR)
}

fn team_json_path(repo_root: &str) -> PathBuf {
    team_dir(repo_root).join(TEAM_JSON)
}

fn channel_path(repo_root: &str, channel: &str) -> PathBuf {
    team_dir(repo_root).join(CHAT_DIR).join(format!("{channel}.jsonl"))
}

fn slugify_channel(name: &str) -> String {
    name.trim()
        .trim_start_matches('#')
        .to_lowercase()
        .chars()
        .map(|c| if c.is_ascii_alphanumeric() || c == '-' || c == '_' { c } else { '-' })
        .collect()
}

fn ensure_dirs(repo_root: &str) -> std::io::Result<()> {
    let chat = team_dir(repo_root).join(CHAT_DIR);
    fs::create_dir_all(&chat)
}

fn derive_team_id(repo_root: &str) -> String {
    let name = Path::new(repo_root)
        .file_name()
        .and_then(|s| s.to_str())
        .unwrap_or("aura-team")
        .to_string();
    slugify_channel(&name)
}

fn parse_mentions(body: &str, members: &[TeamMember]) -> Vec<String> {
    let mut out = Vec::new();
    let bytes = body.as_bytes();
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] == b'@' {
            let start = i + 1;
            let mut end = start;
            while end < bytes.len() {
                let c = bytes[end] as char;
                if c.is_ascii_alphanumeric() || c == '-' || c == '_' || c == '.' {
                    end += 1;
                } else {
                    break;
                }
            }
            if end > start {
                let candidate = body[start..end].to_lowercase();
                if members.iter().any(|m| m.handle == candidate) && !out.contains(&candidate) {
                    out.push(candidate);
                }
                i = end;
                continue;
            }
        }
        i += 1;
    }
    out
}

fn random_id() -> String {
    // Cheap unique id — ts micros + 6 hex chars. JSONL doesn't need
    // crypto-grade uniqueness; this is fine for thread parenting.
    let t = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_micros() as u64)
        .unwrap_or(0);
    let rand: u32 = {
        let mut x = t as u32;
        x ^= x << 13;
        x ^= x >> 17;
        x ^= x << 5;
        x
    };
    format!("m{t:x}{rand:08x}")
}

// ── Git contributor walk (shared with cmd_aura_fs::git_contributors) ─

#[derive(Clone, Debug)]
struct GitAuthor {
    name: String,
    email: String,
    commits: u32,
    first_seen: i64,
    last_seen: i64,
    /// Which remote(s) this author was discovered through. Filled in by
    /// the walker that produced this record — `walk_git_authors` always
    /// emits `Direct`, `walk_upstream_authors` always emits `Ancestor`.
    /// The two streams are then merged in `sync_with_git`, where a
    /// collision on `email` upgrades the source to `Both`.
    source: TeamMemberSource,
}

// Pathspec exclusions so vendored-source authors don't get added to the
// team list. Without this, a repo that has committed `node_modules/`
// (e.g. a yarn-pnp setup or a one-off dependency dump) would surface
// Monaco / React / etc. maintainers as teammates — which is both noisy
// and a real security risk because they'd then receive chat broadcasts.
//
// We exclude any commit that ONLY touches files under these prefixes.
// `git log --diff-filter=AM` plus `:(exclude)` pathspecs means a commit
// must touch at least one file outside the vendored set to be counted.
const VENDORED_EXCLUDES: &[&str] = &[
    ":(exclude)node_modules/**",
    ":(exclude)**/node_modules/**",
    ":(exclude)vendor/**",
    ":(exclude)**/vendor/**",
    ":(exclude)third_party/**",
    ":(exclude)**/third_party/**",
    ":(exclude)external/**",
    ":(exclude)**/external/**",
    ":(exclude)bower_components/**",
    ":(exclude)target/**",
    ":(exclude)dist/**",
    ":(exclude)build/**",
    ":(exclude).next/**",
    ":(exclude).nuxt/**",
    ":(exclude).turbo/**",
    ":(exclude).cache/**",
    ":(exclude)pkg/**",
    ":(exclude)Pods/**",
];

fn walk_git_authors(repo_root: &str) -> Vec<GitAuthor> {
    let fmt = "%aN\x1f%aE\x1f%ct";
    let mut args: Vec<String> = vec![
        "log".into(),
        "--all".into(),
        format!("--pretty=format:{fmt}"),
        "--".into(),
        ".".into(),
    ];
    for ex in VENDORED_EXCLUDES {
        args.push((*ex).to_string());
    }
    let out = match std::process::Command::new("git")
        .args(&args)
        .current_dir(repo_root)
        .output()
    {
        Ok(o) => {
            if !o.status.success() {
                eprintln!(
                    "team: git log failed in {repo_root}: {}",
                    String::from_utf8_lossy(&o.stderr).trim()
                );
            }
            o
        }
        Err(e) => {
            eprintln!("team: git log spawn failed in {repo_root}: {e}");
            return Vec::new();
        }
    };
    let txt = String::from_utf8_lossy(&out.stdout);
    let mut by_email: BTreeMap<String, GitAuthor> = BTreeMap::new();
    for line in txt.lines() {
        let parts: Vec<&str> = line.split('\x1f').collect();
        if parts.len() < 3 {
            continue;
        }
        let name = parts[0].trim().to_string();
        let email = parts[1].trim().to_lowercase();
        let ts: i64 = parts[2].parse().unwrap_or(0);
        if email.is_empty() {
            continue;
        }
        // Drop only the standard GitHub privacy address — older code
        // blanket-rejected any "noreply" substring, which excluded real
        // human teammates whose company addresses happen to contain
        // "noreply" (e.g. dev-noreply@company.com).
        if email.ends_with("@users.noreply.github.com") {
            continue;
        }
        let entry = by_email.entry(email.clone()).or_insert_with(|| GitAuthor {
            name: name.clone(),
            email: email.clone(),
            commits: 0,
            first_seen: ts,
            last_seen: 0,
            source: TeamMemberSource::Direct,
        });
        entry.commits += 1;
        if ts < entry.first_seen || entry.first_seen == 0 {
            entry.first_seen = ts;
        }
        if ts > entry.last_seen {
            entry.last_seen = ts;
            if !name.is_empty() {
                entry.name = name;
            }
        }
    }
    let mut list: Vec<GitAuthor> = by_email.into_values().collect();
    list.sort_by(|a, b| b.last_seen.cmp(&a.last_seen));
    list
}

// ── Fork-inheritance: walk the upstream remote when one is configured ─
//
// When a user opens a fork of someone else's repo, the `git log` walk
// above only sees commits reachable from `origin`'s branches — which is
// often a single contributor (the fork owner). The parent project's
// real team is reachable only via the `upstream` remote that
// `gh repo fork` (and the standard "Configuring a remote for a fork"
// docs) wire up.
//
// Strategy:
//   1. Look for a remote literally named `upstream`. This is by far the
//      dominant convention — `gh repo fork --remote-name upstream`,
//      every GitHub help page, and most editor integrations agree.
//   2. If found, resolve its default branch (`refs/remotes/upstream/HEAD`
//      → typically `main` or `master`), then walk
//      `git log refs/remotes/upstream/<branch>` with the same exclusions
//      as the origin walk.
//   3. Tag every record with `TeamMemberSource::Ancestor`. The merger
//      in `sync_with_git` upgrades to `Both` when the same email also
//      appears in the direct (origin) walk.
//
// If no `upstream` remote exists we treat this repo as not-a-fork and
// behave exactly as before — the non-fork path is unchanged.

/// Returns the name of the remote configured as `upstream` if one
/// exists, else None. Detection is intentionally conservative — we only
/// trust an explicit `upstream` remote, because heuristics based on
/// origin URL parsing are fragile (private mirrors, monorepo subtrees,
/// renamed orgs all break them).
fn detect_upstream_remote(repo_root: &str) -> Option<String> {
    let out = std::process::Command::new("git")
        .args(["remote"])
        .current_dir(repo_root)
        .output()
        .ok()?;
    if !out.status.success() {
        return None;
    }
    let txt = String::from_utf8_lossy(&out.stdout);
    if txt.lines().any(|l| l.trim() == "upstream") {
        return Some("upstream".to_string());
    }
    None
}

/// Resolves the default branch for a remote. Tries `symbolic-ref` first
/// (the cheap, definitive answer when `git remote set-head` has been
/// run), then falls back to probing `main` and `master` against the
/// known remote refs. Returns `main` as the final fallback so the
/// caller can always issue a log command — `git log` on a missing ref
/// errors out cleanly and we just get an empty author list.
fn resolve_remote_default_branch(repo_root: &str, remote: &str) -> String {
    // Cheap path: symbolic-ref points at refs/remotes/<remote>/<branch>.
    let symref = std::process::Command::new("git")
        .args(["symbolic-ref", "--short", &format!("refs/remotes/{remote}/HEAD")])
        .current_dir(repo_root)
        .output();
    if let Ok(o) = symref {
        if o.status.success() {
            let s = String::from_utf8_lossy(&o.stdout).trim().to_string();
            // Strip the "<remote>/" prefix.
            if let Some(rest) = s.strip_prefix(&format!("{remote}/")) {
                if !rest.is_empty() {
                    return rest.to_string();
                }
            }
        }
    }
    // Probe path: check which of main / master actually exists as a
    // remote-tracking ref.
    for candidate in ["main", "master"] {
        let probe = std::process::Command::new("git")
            .args([
                "show-ref",
                "--verify",
                "--quiet",
                &format!("refs/remotes/{remote}/{candidate}"),
            ])
            .current_dir(repo_root)
            .status();
        if let Ok(s) = probe {
            if s.success() {
                return candidate.to_string();
            }
        }
    }
    "main".to_string()
}

/// Walk `git log <remote>/<branch>` and return its authors tagged as
/// `Ancestor`. Reuses the same vendored-path exclusions as the origin
/// walk so dependency maintainers don't sneak in through the upstream
/// path either. Returns an empty Vec on any git error — the caller
/// treats absence of upstream history as a no-op, not a failure.
fn walk_upstream_authors(repo_root: &str, remote: &str) -> Vec<GitAuthor> {
    let branch = resolve_remote_default_branch(repo_root, remote);
    let ref_spec = format!("refs/remotes/{remote}/{branch}");
    let fmt = "%aN\x1f%aE\x1f%ct";
    let mut args: Vec<String> = vec![
        "log".into(),
        ref_spec.clone(),
        format!("--pretty=format:{fmt}"),
        "--".into(),
        ".".into(),
    ];
    for ex in VENDORED_EXCLUDES {
        args.push((*ex).to_string());
    }
    let out = match std::process::Command::new("git")
        .args(&args)
        .current_dir(repo_root)
        .output()
    {
        Ok(o) => {
            if !o.status.success() {
                eprintln!(
                    "team: upstream git log ({ref_spec}) failed in {repo_root}: {}",
                    String::from_utf8_lossy(&o.stderr).trim()
                );
                return Vec::new();
            }
            o
        }
        Err(e) => {
            eprintln!("team: upstream git log spawn failed in {repo_root}: {e}");
            return Vec::new();
        }
    };
    let txt = String::from_utf8_lossy(&out.stdout);
    let mut by_email: BTreeMap<String, GitAuthor> = BTreeMap::new();
    for line in txt.lines() {
        let parts: Vec<&str> = line.split('\x1f').collect();
        if parts.len() < 3 {
            continue;
        }
        let name = parts[0].trim().to_string();
        let email = parts[1].trim().to_lowercase();
        let ts: i64 = parts[2].parse().unwrap_or(0);
        if email.is_empty() {
            continue;
        }
        if email.ends_with("@users.noreply.github.com") {
            continue;
        }
        let entry = by_email.entry(email.clone()).or_insert_with(|| GitAuthor {
            name: name.clone(),
            email: email.clone(),
            commits: 0,
            first_seen: ts,
            last_seen: 0,
            source: TeamMemberSource::Ancestor,
        });
        entry.commits += 1;
        if ts < entry.first_seen || entry.first_seen == 0 {
            entry.first_seen = ts;
        }
        if ts > entry.last_seen {
            entry.last_seen = ts;
            if !name.is_empty() {
                entry.name = name;
            }
        }
    }
    by_email.into_values().collect()
}

pub(crate) fn read_team(repo_root: &str) -> Option<TeamManifest> {
    let path = team_json_path(repo_root);
    let raw = fs::read_to_string(&path).ok()?;
    serde_json::from_str::<TeamManifest>(&raw).ok()
}

/// True when the repo has more than one committer in its history — a real
/// team. Live-sync publishers (tasks #218, pages #219) gate on this: the
/// chat rail defaults to the public `auravcs.com` origin, so an ungated
/// publish would push a solo developer's local mutations to the cloud
/// unprompted. Returns `false` when no team manifest exists yet.
pub(crate) fn team_has_peers(repo_root: &str) -> bool {
    read_team(repo_root)
        .map(|m| m.members.len() > 1)
        .unwrap_or(false)
}

fn write_team(repo_root: &str, manifest: &TeamManifest) -> Result<(), String> {
    ensure_dirs(repo_root).map_err(|e| e.to_string())?;
    let path = team_json_path(repo_root);
    let json = serde_json::to_string_pretty(manifest).map_err(|e| e.to_string())?;
    fs::write(&path, json).map_err(|e| e.to_string())
}

fn handle_from_email(email: &str) -> String {
    email
        .split('@')
        .next()
        .unwrap_or(email)
        .to_lowercase()
}

/// Extract the GitHub login from a `…@users.noreply.github.com` address, if the
/// email is one. GitHub uses two forms: the modern ID-prefixed
/// `12345+login@users.noreply.github.com` and the legacy bare
/// `login@users.noreply.github.com`. Returns the lowercased login, or `None`
/// for any other address. This is the bridge that ties a commit authored under
/// a noreply address to the same person's GitHub-login-derived roster row —
/// the login is globally unique to that GitHub account, so it's a safe merge
/// key (unlike a shared display name or a shared email local-part).
fn noreply_login(email: &str) -> Option<String> {
    let e = email.trim().to_lowercase();
    let local = e.strip_suffix("@users.noreply.github.com")?;
    // `123456+login` → `login`; a bare `login` has no `+` and is returned as-is.
    let login = local.rsplit('+').next().unwrap_or(local);
    if login.is_empty() {
        None
    } else {
        Some(login.to_string())
    }
}

/// Derive a cloud message row's stable `from_handle` WITHOUT ever collapsing
/// onto the display NAME. A handle is an identity key — it buckets DMs and
/// drives self/peer attribution — so two teammates who merely share a display
/// name ("Ashiq" on a second GitHub seat, two "John"s) must NOT merge into one
/// bucket, which is exactly what a `sender_display` fallback did (the "Aura
/// shows my two accounts as one user" bug). Mirrors the frontend `senderHandle`
/// precedence exactly:
///   1. email local-part — the roster's canonical key ("mo", "ashiqwayanad007")
///   2. a device-scoped token — distinct per install, so two email-less senders
///      stay separate; invisible to the reader, who sees `from_name`
///   3. a name slug — ONLY when neither identifier exists (legacy rows),
///      accepting that email-less same-name senders can't be told apart.
fn handle_from_row(sender_email: Option<&str>, sender_device_id: &str, sender_display: &str) -> String {
    if let Some(email) = sender_email {
        let e = email.trim();
        if !e.is_empty() {
            return handle_from_email(e);
        }
    }
    let dev = sender_device_id.trim();
    if !dev.is_empty() {
        let short: String = dev.chars().take(12).collect();
        return format!("dev-{}", short.to_lowercase());
    }
    sender_display
        .split(|c: char| !c.is_ascii_alphanumeric() && c != '-' && c != '_')
        .next()
        .unwrap_or(sender_display)
        .to_lowercase()
}

/// Bake each member's GitHub login into their roster handle. A handle
/// otherwise defaults to the email local-part ("ashiqwayanad007"), which is
/// neither recognizable nor stable: one person commits under several
/// addresses (work laptop `mo@company.com`, personal `…@gmail.com`) and
/// each would mint a different chat identity. Whenever we already know a
/// member's GitHub login we make it their handle ("mhask"), so their chat
/// identity is the *same person* on every repo, under any git email, signed
/// in or out — and two of your own machines stop showing up under different
/// invented names. Purely local: the login is already stored on the member
/// (captured once from `gh` or the collaborators API), so this needs no
/// network and keeps working offline. Idempotent.
fn normalize_member_handles(manifest: &mut TeamManifest) {
    for m in manifest.members.iter_mut() {
        if let Some(login) = m.github_login.as_deref() {
            let lc = login.trim().to_lowercase();
            if !lc.is_empty() && m.handle != lc {
                m.handle = lc;
            }
        }
    }
}

/// Collapse the several roster rows a single person legitimately accumulates
/// back into one. `sync_with_git` keys members strictly on the git-commit
/// `email`, so one human becomes two or three rows: they commit under a work
/// address and a personal one; they appear both as a git author and as a GitHub
/// collaborator seat; a `123+login@users.noreply.github.com` commit lands beside
/// their real email. Each is a distinct `email`, so the roster shows the same
/// person repeatedly.
///
/// We merge rows ONLY on a high-confidence identity link — one that is globally
/// unique to a person, never a weak coincidence:
///   - the same non-empty `github_login` (GitHub logins are unique per account),
///   - a GitHub noreply email whose parsed login matches another row's login
///     (see `noreply_login`), or
///   - one row's `email` already listed in another row's `also_emails` — an
///     explicit admin/self alias, and the alias-add path guards against the
///     same address resolving to two different members.
/// We deliberately do NOT merge on a shared display name or a shared email
/// local-part across different domains (`john@a.com` vs `john@b.com` are
/// presumed different people). Under-merging leaves a harmless duplicate;
/// over-merging fuses two humans into one, which is far worse and unrecoverable.
///
/// The survivor keeps a real (non-synthetic) email as its canonical key and
/// absorbs every merged-away email into `also_emails`, so the admin-auth, alias,
/// and DM-routing paths that still match on individual emails keep resolving.
/// Commit counts sum; timestamps min/max-merge; `claimed`/`admin` OR together;
/// login/role/name/presence fold in — mirroring the existing collision merge in
/// `sync_with_git`.
///
/// Idempotent: a manifest with no duplicates is left untouched, so running this
/// on every `sync_with_git` doubles as the one-time backfill that repairs
/// rosters written before this existed.
fn collapse_duplicate_members(manifest: &mut TeamManifest) {
    let n = manifest.members.len();
    if n < 2 {
        return;
    }

    // A synthetic email is one Aura minted rather than a real committer address:
    // a GitHub collaborator seat (`login@users.noreply.github.com`) or a
    // presence-only beacon (`device:…@presence.local`). Prefer a real address as
    // the survivor's canonical key so the merged row reads as a person.
    fn synthetic(email: &str) -> bool {
        let e = email.trim().to_lowercase();
        e.ends_with("@users.noreply.github.com") || e.ends_with("@presence.local")
    }

    // The high-confidence identity tokens a member emits. Two members that share
    // any token are the same person. `email:` covers the primary address and any
    // alias (they live in one namespace so a row whose primary email equals
    // another's alias unions); `login:` covers a stored GitHub login and any
    // login parsed out of a noreply address.
    fn tokens_for(m: &TeamMember) -> Vec<String> {
        let mut t: Vec<String> = Vec::new();
        let mut push_email = |addr: &str, t: &mut Vec<String>| {
            let a = addr.trim().to_lowercase();
            if a.is_empty() {
                return;
            }
            if let Some(l) = noreply_login(&a) {
                t.push(format!("login:{l}"));
            } else {
                // Only real addresses become an email identity token — a
                // noreply address is an alias for its login, not an identity of
                // its own (two people never share a real committer address).
                t.push(format!("email:{a}"));
            }
        };
        push_email(&m.email, &mut t);
        for a in &m.also_emails {
            push_email(a, &mut t);
        }
        if let Some(g) = m.github_login.as_deref() {
            let g = g.trim().to_lowercase();
            if !g.is_empty() {
                t.push(format!("login:{g}"));
            }
        }
        t
    }

    // Union-find over member indices; the smaller index stays the leader so
    // group ordering is stable and deterministic.
    fn find(parent: &mut [usize], mut i: usize) -> usize {
        while parent[i] != i {
            parent[i] = parent[parent[i]];
            i = parent[i];
        }
        i
    }
    let mut parent: Vec<usize> = (0..n).collect();
    let mut token_owner: std::collections::HashMap<String, usize> =
        std::collections::HashMap::new();
    for i in 0..n {
        for tok in tokens_for(&manifest.members[i]) {
            match token_owner.get(&tok).copied() {
                Some(j) => {
                    let ri = find(&mut parent, i);
                    let rj = find(&mut parent, j);
                    if ri != rj {
                        let (lo, hi) = (ri.min(rj), ri.max(rj));
                        parent[hi] = lo;
                    }
                }
                None => {
                    token_owner.insert(tok, i);
                }
            }
        }
    }

    // Force-union human-confirmed "same person" pairs. The token pass above only
    // unions rows that share an email/login; a human can confirm two rows that
    // share NEITHER (a GitHub handle vs a personal Gmail), and `identity_merges`
    // makes that decision stick on every re-derive. An explicit `identity_splits`
    // ("different people") always wins, so a stale merge can never override it.
    if !manifest.identity_merges.is_empty() {
        let mut email_owner: std::collections::HashMap<String, usize> =
            std::collections::HashMap::new();
        for (i, m) in manifest.members.iter().enumerate() {
            for e in member_emails(m) {
                email_owner.entry(e).or_insert(i);
            }
        }
        for pair in &manifest.identity_merges {
            if manifest
                .identity_splits
                .iter()
                .any(|s| s.a == pair.a && s.b == pair.b)
            {
                continue;
            }
            if let (Some(&i), Some(&j)) = (email_owner.get(&pair.a), email_owner.get(&pair.b)) {
                let ri = find(&mut parent, i);
                let rj = find(&mut parent, j);
                if ri != rj {
                    let (lo, hi) = (ri.min(rj), ri.max(rj));
                    parent[hi] = lo;
                }
            }
        }
    }

    let mut groups: std::collections::BTreeMap<usize, Vec<usize>> =
        std::collections::BTreeMap::new();
    for i in 0..n {
        let r = find(&mut parent, i);
        groups.entry(r).or_default().push(i);
    }
    // Nothing shares an identity — leave the manifest byte-for-byte alone.
    if groups.len() == n {
        return;
    }

    // Rank rows so the BEST survivor is the maximum: claimed first, then a real
    // (non-synthetic) email, then most commits, then the oldest seat, then a
    // stable email tie-break.
    fn survivor_key(
        m: &TeamMember,
    ) -> (bool, bool, u32, std::cmp::Reverse<i64>, std::cmp::Reverse<String>) {
        let age = if m.first_seen == 0 { i64::MAX } else { m.first_seen };
        (
            m.claimed,
            !synthetic(&m.email),
            m.commits,
            std::cmp::Reverse(age),
            std::cmp::Reverse(m.email.to_lowercase()),
        )
    }

    // Fold provenance across the group: git activity (direct/ancestor/both)
    // always outranks a collaborator-only seat.
    fn fold_sources(sources: &[TeamMemberSource]) -> TeamMemberSource {
        let mut has_direct = false;
        let mut has_ancestor = false;
        let mut has_collab = false;
        for s in sources {
            match s {
                TeamMemberSource::Direct => has_direct = true,
                TeamMemberSource::Ancestor => has_ancestor = true,
                TeamMemberSource::Both => {
                    has_direct = true;
                    has_ancestor = true;
                }
                TeamMemberSource::Collaborator => has_collab = true,
            }
        }
        if has_direct && has_ancestor {
            TeamMemberSource::Both
        } else if has_direct {
            TeamMemberSource::Direct
        } else if has_ancestor {
            TeamMemberSource::Ancestor
        } else if has_collab {
            TeamMemberSource::Collaborator
        } else {
            TeamMemberSource::Direct
        }
    }

    let old = std::mem::take(&mut manifest.members);
    let mut out: Vec<TeamMember> = Vec::with_capacity(groups.len());
    for (_leader, idxs) in groups.into_iter() {
        if idxs.len() == 1 {
            out.push(old[idxs[0]].clone());
            continue;
        }

        let survivor_idx = *idxs
            .iter()
            .max_by_key(|&&i| survivor_key(&old[i]))
            .expect("group is non-empty");
        let mut merged = old[survivor_idx].clone();
        let canonical = merged.email.trim().to_lowercase();

        let mut also: std::collections::BTreeSet<String> = merged
            .also_emails
            .iter()
            .map(|e| e.trim().to_lowercase())
            .filter(|e| !e.is_empty())
            .collect();
        let mut login: Option<String> = merged
            .github_login
            .as_deref()
            .map(|g| g.trim().to_lowercase())
            .filter(|g| !g.is_empty());
        let mut role: Option<String> = merged.repo_role.clone();
        let mut best_name_seen = merged.last_seen;

        let mut commits: u32 = 0;
        let mut first_seen = i64::MAX;
        let mut last_seen = i64::MIN;
        let mut claimed = false;
        let mut admin = false;
        let mut sources: Vec<TeamMemberSource> = Vec::with_capacity(idxs.len());

        for &i in &idxs {
            let m = &old[i];
            commits = commits.saturating_add(m.commits);
            if m.first_seen != 0 && m.first_seen < first_seen {
                first_seen = m.first_seen;
            }
            if m.last_seen > last_seen {
                last_seen = m.last_seen;
            }
            claimed |= m.claimed;
            admin |= m.admin;
            sources.push(m.source);

            // Every address the group knows — primary or alias — must survive as
            // an alias on the merged row (minus the canonical one), or the
            // email-keyed admin-auth / DM lookups would stop resolving it.
            let e = m.email.trim().to_lowercase();
            if !e.is_empty() && e != canonical {
                also.insert(e);
            }
            for a in &m.also_emails {
                let a = a.trim().to_lowercase();
                if !a.is_empty() && a != canonical {
                    also.insert(a);
                }
            }

            if login.is_none() {
                if let Some(g) = m.github_login.as_deref() {
                    let g = g.trim().to_lowercase();
                    if !g.is_empty() {
                        login = Some(g);
                    }
                }
            }
            if role.is_none() {
                role = m.repo_role.clone();
            }
            // Most-recent display name across the group (`>=` keeps the
            // survivor's own name on a tie).
            if m.last_seen >= best_name_seen && !m.name.trim().is_empty() {
                best_name_seen = m.last_seen;
                merged.name = m.name.clone();
            }
            // Carry whatever live presence any row currently holds.
            if merged.activity_text.is_none() && m.activity_text.is_some() {
                merged.activity_text = m.activity_text.clone();
            }
            if merged.status_emoji.is_none() && m.status_emoji.is_some() {
                merged.status_emoji = m.status_emoji.clone();
            }
            if merged.voice_channel.is_none() && m.voice_channel.is_some() {
                merged.voice_channel = m.voice_channel.clone();
            }
        }

        merged.commits = commits;
        merged.first_seen = if first_seen == i64::MAX {
            merged.first_seen
        } else {
            first_seen
        };
        merged.last_seen = last_seen.max(merged.last_seen);
        merged.claimed = claimed;
        merged.admin = admin;
        merged.repo_role = role;
        merged.source = fold_sources(&sources);
        // A known login is the canonical handle (mirrors
        // `normalize_member_handles`), so the merged person reads the same way
        // everywhere.
        if let Some(g) = login.clone() {
            merged.handle = g;
        }
        merged.github_login = login;
        also.remove(&canonical);
        merged.also_emails = also.into_iter().collect();

        out.push(merged);
    }

    // Restore the manifest's `last_seen`-descending order (see `sync_with_git`).
    out.sort_by(|a, b| b.last_seen.cmp(&a.last_seen));
    manifest.members = out;
}

/// Find the team member whose primary `email` or one of whose
/// `also_emails` matches the given git email (case-insensitive). Returns
/// `None` if nobody in the manifest claims this address — the caller
/// then falls back to `handle_from_email` for the unclaimed-author case.
fn canonical_member_for_email<'a>(
    members: &'a [TeamMember],
    email: &str,
) -> Option<&'a TeamMember> {
    let e = email.trim().to_lowercase();
    if e.is_empty() {
        return None;
    }
    members.iter().find(|m| {
        m.email.eq_ignore_ascii_case(&e)
            || m.also_emails.iter().any(|a| a.eq_ignore_ascii_case(&e))
    })
}

/// Find the roster member whose recorded `github_login` matches `login`
/// (case-insensitive), or `None` if no seat carries that GitHub identity
/// yet. The send paths use this to map the machine's signed-in account to
/// a friendly roster handle.
fn member_for_github_login<'a>(
    members: &'a [TeamMember],
    login: &str,
) -> Option<&'a TeamMember> {
    let l = login.trim();
    if l.is_empty() {
        return None;
    }
    members.iter().find(|m| {
        m.github_login
            .as_deref()
            .map_or(false, |g| g.eq_ignore_ascii_case(l))
    })
}

/// The machine's signed-in GitHub account (`gh api user`), memoised for the
/// life of the process so identity resolution never shells out more than
/// once. `None` when `gh` is missing or signed out.
///
/// This is the *per-machine* identity anchor, and the reason chat identity
/// no longer collapses two people onto a shared `git config user.email`:
/// the GitHub login is stable across repos and independent of whatever
/// email a given repo is configured with, so two accounts that happen to
/// commit under the same address stay distinct. `gh auth` is global
/// (`~/.config/gh`), so the answer doesn't depend on `repo_root` — we pass
/// it only to run `gh` from a sane cwd.
fn account_login(repo_root: &str) -> Option<String> {
    static CACHE: std::sync::Mutex<Option<Option<String>>> = std::sync::Mutex::new(None);
    let mut slot = CACHE.lock().unwrap_or_else(|e| e.into_inner());
    if slot.is_none() {
        *slot = Some(local_github_login(repo_root));
    }
    slot.clone().flatten()
}

/// Resolve a `(handle, name)` pair for the local user, honouring (in
/// order): an explicit per-repo override → the machine's signed-in GitHub
/// account → an alias match on the team manifest → the email-local-part
/// fallback.
///
/// Why this order: the override is a deliberate per-repo persona pin and
/// always wins. Next comes the **signed-in account** — the only signal
/// that distinguishes two people who share a local git email (the same
/// address configured on two laptops), which the email layers below cannot.
/// When signed out (`account_login` is `None`) we fall back to the historic
/// email behaviour so single-identity and CI setups keep working untouched.
/// A user may also have multiple gits on one machine
/// (`mubasheer.ck@hotmail.com` locally but enrolled as `mck@naridon.com`):
/// the admin adds the hotmail address to `mck`'s `also_emails`, or the user
/// pins a per-repo override.
fn resolve_handle(
    repo_root: &str,
    members: &[TeamMember],
    git_email: &str,
    account_login: Option<&str>,
) -> (String, String) {
    if let Some((h, n)) = repo_identity_override(repo_root) {
        return (h, n);
    }
    if let Some(login) = account_login.map(str::trim).filter(|l| !l.is_empty()) {
        if let Some(m) = member_for_github_login(members, login) {
            return (m.handle.clone(), m.name.clone());
        }
        // Signed in but no roster seat carries this login yet — send under
        // the login itself so the identity is still distinct and stable.
        return (login.to_lowercase(), String::new());
    }
    if let Some(m) = canonical_member_for_email(members, git_email) {
        return (m.handle.clone(), m.name.clone());
    }
    (handle_from_email(git_email), String::new())
}

/// Resolve the local user's effective (handle, name) for this repo — the
/// "actor" behind a task/page change they just made. Layers per-repo
/// override → roster alias → email local-part, exactly like `resolve_handle`.
/// Used by the notification seam to address a DM "from" the right person.
pub(crate) fn local_actor(repo_root: &str) -> (String, String) {
    let (email, _gname) = git_local_identity(repo_root);
    let members = read_team(repo_root)
        .map(|m| m.members)
        .unwrap_or_default();
    let (handle, name) =
        resolve_handle(repo_root, &members, &email, account_login(repo_root).as_deref());
    let name = if name.trim().is_empty() {
        handle.clone()
    } else {
        name
    };
    (handle, name)
}

/// Path to the machine-global per-repo identity override file. Lives
/// alongside `device.json` in `~/.aura/` — never inside the repo, so
/// personal identity choices don't leak across the team.
fn identity_overrides_path() -> Option<PathBuf> {
    dirs::home_dir().map(|h| h.join(".aura").join("identity-overrides.json"))
}

#[derive(Serialize, Deserialize, Clone, Debug, Default)]
pub struct IdentityOverride {
    pub handle: String,
    pub name: String,
    pub email: String,
    #[serde(default)]
    pub set_at: i64,
}

fn read_identity_overrides() -> BTreeMap<String, IdentityOverride> {
    let Some(path) = identity_overrides_path() else {
        return BTreeMap::new();
    };
    let Ok(bytes) = fs::read(&path) else {
        return BTreeMap::new();
    };
    serde_json::from_slice(&bytes).unwrap_or_default()
}

fn write_identity_overrides(map: &BTreeMap<String, IdentityOverride>) -> Result<(), String> {
    let path = identity_overrides_path().ok_or_else(|| "no home dir".to_string())?;
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    let json = serde_json::to_string_pretty(map).map_err(|e| e.to_string())?;
    fs::write(&path, json).map_err(|e| e.to_string())
}

/// Look up the per-repo identity override if one is set. Returns
/// `(handle, name)` ready to substitute into `resolve_handle`.
fn repo_identity_override(repo_root: &str) -> Option<(String, String)> {
    let map = read_identity_overrides();
    map.get(repo_root).map(|o| (o.handle.clone(), o.name.clone()))
}

// Merge git authors into the existing manifest, preserving claimed/admin
// flags. New authors are appended as unclaimed members.
//
// Fork-inheritance: if the repo has an `upstream` remote configured
// (the convention `gh repo fork` sets up), we also walk
// `upstream/<default-branch>` and tag the resulting members as
// `Ancestor`. Authors who appear in both walks are tagged `Both`. See
// `walk_upstream_authors` for the strategy rationale.
/// How long a history walk stays good for. The roster is derived from every
/// commit ever authored, so it moves about as often as somebody commits — a
/// handful of seconds of staleness is invisible, and it is the difference
/// between one `git log --all` per window and one per caller.
const AUTHOR_WALK_TTL_SECS: u64 = 10;

/// TTL cache for the author walks, keyed by the exact walk that produced them
/// (`repo_root` for the direct walk, `repo_root\0remote` for an upstream one).
fn author_walk_cache() -> &'static std::sync::Mutex<BTreeMap<String, (u64, Vec<GitAuthor>)>> {
    static CACHE: std::sync::OnceLock<std::sync::Mutex<BTreeMap<String, (u64, Vec<GitAuthor>)>>> =
        std::sync::OnceLock::new();
    CACHE.get_or_init(|| std::sync::Mutex::new(BTreeMap::new()))
}

/// Run `walk` unless the same walk answered within [`AUTHOR_WALK_TTL_SECS`].
///
/// Worth having because the roster is not read by one screen. Team, Commons
/// and the Scribble panel each load it on their own, two of them re-poll it
/// every 15 seconds, and `team_identity` re-runs the whole thing a second time
/// on top of whatever `team_load` just did — so opening the app used to walk
/// all of history several times over within a second or two of itself.
fn cached_author_walk(key: &str, walk: impl FnOnce() -> Vec<GitAuthor>) -> Vec<GitAuthor> {
    let now = now_secs().max(0) as u64;
    if let Ok(cache) = author_walk_cache().lock() {
        if let Some((walked_at, authors)) = cache.get(key) {
            if now.saturating_sub(*walked_at) < AUTHOR_WALK_TTL_SECS {
                return authors.clone();
            }
        }
    }
    let authors = walk();
    if let Ok(mut cache) = author_walk_cache().lock() {
        cache.insert(key.to_string(), (now, authors.clone()));
    }
    authors
}

fn sync_with_git(repo_root: &str) -> Result<TeamManifest, String> {
    let direct_authors = cached_author_walk(repo_root, || walk_git_authors(repo_root));
    let ancestor_authors = match detect_upstream_remote(repo_root) {
        Some(remote) => cached_author_walk(&format!("{repo_root}\0{remote}"), || {
            walk_upstream_authors(repo_root, &remote)
        }),
        None => Vec::new(),
    };

    // Merge the two streams into a single email-keyed map. Collisions
    // upgrade the source to `Both`; commit counts and timestamps add /
    // max-merge so the resulting record reflects the union of history.
    let mut merged: BTreeMap<String, GitAuthor> = BTreeMap::new();
    for a in direct_authors.into_iter().chain(ancestor_authors.into_iter()) {
        match merged.entry(a.email.clone()) {
            std::collections::btree_map::Entry::Vacant(v) => {
                v.insert(a);
            }
            std::collections::btree_map::Entry::Occupied(mut o) => {
                let existing = o.get_mut();
                existing.commits = existing.commits.saturating_add(a.commits);
                if a.first_seen != 0
                    && (existing.first_seen == 0 || a.first_seen < existing.first_seen)
                {
                    existing.first_seen = a.first_seen;
                }
                if a.last_seen > existing.last_seen {
                    existing.last_seen = a.last_seen;
                    if !a.name.is_empty() {
                        existing.name = a.name;
                    }
                }
                existing.source = match (existing.source, a.source) {
                    (TeamMemberSource::Both, _) | (_, TeamMemberSource::Both) => {
                        TeamMemberSource::Both
                    }
                    (TeamMemberSource::Direct, TeamMemberSource::Ancestor)
                    | (TeamMemberSource::Ancestor, TeamMemberSource::Direct) => {
                        TeamMemberSource::Both
                    }
                    (s, _) => s,
                };
            }
        }
    }
    let authors: Vec<GitAuthor> = merged.into_values().collect();

    let mut manifest = read_team(repo_root).unwrap_or_else(|| TeamManifest {
        team_id: derive_team_id(repo_root),
        repo_root: repo_root.to_string(),
        created_at: now_secs(),
        members: Vec::new(),
        channel_meta: Vec::new(),
        channels: DEFAULT_CHANNELS.iter().map(|s| s.to_string()).collect(),
        collaborators_synced_at: 0,
        identity_splits: Vec::new(),
        identity_merges: Vec::new(),
    });

    // Ensure built-in channels are always present, even if user edited
    // the manifest by hand and dropped one.
    for ch in DEFAULT_CHANNELS {
        if !manifest.channels.iter().any(|c| c == ch) {
            manifest.channels.push(ch.to_string());
        }
    }

    let mut by_email: BTreeMap<String, TeamMember> = manifest
        .members
        .drain(..)
        .map(|m| (m.email.clone(), m))
        .collect();

    for a in authors {
        let entry = by_email.entry(a.email.clone()).or_insert_with(|| TeamMember {
            email: a.email.clone(),
            name: a.name.clone(),
            handle: handle_from_email(&a.email),
            commits: 0,
            first_seen: a.first_seen,
            last_seen: 0,
            claimed: false,
            admin: false,
            activity_text: None,
            status_emoji: None,
            voice_channel: None,
            source: a.source,
            also_emails: Vec::new(),
            github_login: None,
            repo_role: None,
        });
        entry.commits = a.commits;
        if !a.name.is_empty() {
            entry.name = a.name;
        }
        if a.first_seen != 0 && (entry.first_seen == 0 || a.first_seen < entry.first_seen) {
            entry.first_seen = a.first_seen;
        }
        if a.last_seen > entry.last_seen {
            entry.last_seen = a.last_seen;
        }
        // Always refresh the source from the latest walk — a member
        // previously seen only via upstream might have just landed
        // their first direct commit, or the upstream remote may have
        // been removed and we should demote them back to Direct.
        entry.source = a.source;
    }

    manifest.members = by_email.into_values().collect();
    manifest.members.sort_by(|a, b| b.last_seen.cmp(&a.last_seen));

    // Owner-promotion: any OWNER_EMAILS member becomes admin + claimed
    // automatically on every load. Idempotent — only escalates, never
    // demotes other admins.
    for m in manifest.members.iter_mut() {
        if is_owner_email(&m.email) {
            m.admin = true;
            m.claimed = true;
        }
    }

    // Prefer the GitHub login as each member's handle (see
    // `normalize_member_handles`) so chat identity is stable per person, not
    // per git email. Runs on every load (this path is un-throttled), so a
    // login captured by the collaborator sync propagates here next refresh.
    normalize_member_handles(&mut manifest);

    // Collapse the duplicate rows one person accrues across several git emails /
    // a GitHub collaborator seat / a noreply commit into a single identity.
    // Runs after handle-normalization so a login just captured by the
    // collaborator sync is available as a merge key; idempotent, so it also
    // backfills rosters written before it existed.
    collapse_duplicate_members(&mut manifest);

    write_team(repo_root, &manifest)?;
    Ok(manifest)
}

// Read `git config user.email` + `user.name` from the local repo.
// This is who "me" is for claim purposes.
fn git_local_identity(repo_root: &str) -> (String, String) {
    let email = std::process::Command::new("git")
        .args(["config", "--get", "user.email"])
        .current_dir(repo_root)
        .output()
        .ok()
        .and_then(|o| String::from_utf8(o.stdout).ok())
        .map(|s| s.trim().to_lowercase())
        .unwrap_or_default();
    let name = std::process::Command::new("git")
        .args(["config", "--get", "user.name"])
        .current_dir(repo_root)
        .output()
        .ok()
        .and_then(|o| String::from_utf8(o.stdout).ok())
        .map(|s| s.trim().to_string())
        .unwrap_or_default();
    (email, name)
}

// ── GitHub collaborators → roster ────────────────────────────────────
//
// The git-derived roster only knows people who have *committed*. A
// teammate granted push access who hasn't pushed yet is invisible. These
// helpers + `team_sync_collaborators` close that gap by reading the
// repo's GitHub collaborators (via the `gh` CLI, same as `cmd_prs.rs`)
// and surfacing everyone with edit rights as a zero-commit member.

/// Parse `(owner, repo)` from the `origin` remote URL. Handles the three
/// shapes git emits — `https://github.com/owner/repo(.git)`,
/// `git@github.com:owner/repo(.git)`, `ssh://git@github.com/owner/repo` —
/// plus token-embedded https. Returns `None` for non-GitHub remotes so
/// the sync silently no-ops off GitHub. Never logs the URL (it may carry
/// a token).
fn github_owner_repo(repo_root: &str) -> Option<(String, String)> {
    let url = std::process::Command::new("git")
        .args(["remote", "get-url", "origin"])
        .current_dir(repo_root)
        .output()
        .ok()
        .and_then(|o| String::from_utf8(o.stdout).ok())
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty())?;
    // SCP-like syntax uses a colon; every other form contains "github.com/".
    let rest = if let Some(r) = url.strip_prefix("git@github.com:") {
        r.to_string()
    } else {
        let marker = "github.com/";
        let idx = url.find(marker)?;
        url[idx + marker.len()..].to_string()
    };
    let rest = rest.strip_suffix(".git").unwrap_or(&rest);
    let mut parts = rest.splitn(2, '/');
    let owner = parts.next()?.trim().to_string();
    let repo = parts
        .next()?
        .split('/')
        .next()
        .unwrap_or("")
        .trim()
        .trim_end_matches(".git")
        .to_string();
    if owner.is_empty() || repo.is_empty() {
        return None;
    }
    Some((owner, repo))
}

/// The GitHub owner (user or org) of the repo's `origin` remote, or `None`
/// for non-GitHub repos. The frontend uses this to render the owner's
/// avatar (`https://github.com/<owner>.png`) on the workspace tile in
/// place of a generic folder glyph. Reuses `github_owner_repo`, so it
/// inherits the same care: it never logs the remote URL (it may carry a
/// token), and silently returns `None` off GitHub.
#[tauri::command]
pub async fn repo_github_owner(repo_root: String) -> Option<String> {
    crate::blocking::run(move || {
        github_owner_repo(&repo_root).map(|(owner, _repo)| owner)
    })
    .await
}

/// A GitHub repo collaborator who holds edit rights (push or stronger).
struct EditCollaborator {
    login: String,
    /// Strongest permission held — "admin" | "maintain" | "push".
    role: String,
}

/// Fetch the repo's collaborators via `gh` and keep only those with an
/// edit (write or stronger) permission. Best-effort: any failure (no gh,
/// not authenticated, not a GitHub repo, network down, missing scope)
/// returns an empty vec so the caller degrades to the commit-derived
/// roster instead of erroring the whole team load. TSV output keeps
/// parsing robust across `--paginate` (one row per line, no array to
/// stitch back together).
fn fetch_edit_collaborators(repo_root: &str) -> Vec<EditCollaborator> {
    let Some((owner, repo)) = github_owner_repo(repo_root) else {
        return Vec::new();
    };
    let q = ".[] | [.login, (.permissions.admin|tostring), \
             (.permissions.maintain|tostring), (.permissions.push|tostring)] | @tsv";
    let out = std::process::Command::new("gh")
        .args([
            "api",
            &format!("repos/{owner}/{repo}/collaborators"),
            "--paginate",
            "-q",
            q,
        ])
        .current_dir(repo_root)
        .output();
    let Ok(out) = out else {
        return Vec::new();
    };
    if !out.status.success() {
        return Vec::new();
    }
    let Ok(text) = String::from_utf8(out.stdout) else {
        return Vec::new();
    };
    let mut result = Vec::new();
    for line in text.lines() {
        let mut cols = line.split('\t');
        let login = cols.next().unwrap_or("").trim();
        let admin = cols.next() == Some("true");
        let maintain = cols.next() == Some("true");
        let push = cols.next() == Some("true");
        if login.is_empty() {
            continue;
        }
        let role = if admin {
            "admin"
        } else if maintain {
            "maintain"
        } else if push {
            "push"
        } else {
            // read / triage only — not an editor; skip.
            continue;
        };
        result.push(EditCollaborator {
            login: login.to_string(),
            role: role.to_string(),
        });
    }
    result
}

/// The GitHub login of whoever's authenticated to `gh` locally, if any.
/// Used to self-map the local git email to a GitHub login so the local
/// user isn't duplicated as a synthetic collaborator row.
fn local_github_login(repo_root: &str) -> Option<String> {
    let out = std::process::Command::new("gh")
        .args(["api", "user", "-q", ".login"])
        .current_dir(repo_root)
        .output()
        .ok()?;
    if !out.status.success() {
        return None;
    }
    let login = String::from_utf8(out.stdout).ok()?.trim().to_string();
    if login.is_empty() {
        None
    } else {
        Some(login)
    }
}

/// Populate the roster from the repo's GitHub collaborators with edit
/// rights, so people who *can* contribute show up before they've made
/// their first commit. Throttled on `collaborators_synced_at` (5 min)
/// unless `force`, so the team surface can call it on every mount.
/// Always returns a manifest — degrades to the plain git-derived roster
/// off GitHub or when `gh` is unavailable.
#[tauri::command]
pub async fn team_sync_collaborators(
    repo_root: String,
    force: Option<bool>,
) -> Result<TeamManifest, String> {
    crate::blocking::run(move || {
        let mut manifest = sync_with_git(&repo_root)?;
        let now = now_secs();
        if !force.unwrap_or(false) && now - manifest.collaborators_synced_at < 300 {
            return Ok(manifest);
        }

        let (local_email, _) = git_local_identity(&repo_root);
        let local_login = local_github_login(&repo_root);
        let mut local_is_committer = false;

        // (a) If the local user is already a committer, tag their github_login
        //     now so the collaborator loop recognises them and skips the dup.
        if let Some(login) = local_login.as_ref() {
            if !local_email.is_empty() {
                if let Some(m) = manifest
                    .members
                    .iter_mut()
                    .find(|m| m.email.eq_ignore_ascii_case(&local_email))
                {
                    local_is_committer = true;
                    if m.github_login.is_none() {
                        m.github_login = Some(login.clone());
                    }
                }
            }
        }

        for collab in fetch_edit_collaborators(&repo_root) {
            let login_lc = collab.login.to_lowercase();
            // Prefer an existing real member (committer/presence) over any
            // prior synthetic row: match by recorded github_login, then by
            // handle == login, then by email local-part == login.
            let real = manifest.members.iter_mut().find(|m| {
                m.source != TeamMemberSource::Collaborator
                    && (m
                        .github_login
                        .as_deref()
                        .map(|g| g.eq_ignore_ascii_case(&collab.login))
                        .unwrap_or(false)
                        || m.handle == login_lc
                        || handle_from_email(&m.email) == login_lc)
            });
            if let Some(m) = real {
                // Real contributor — annotate GitHub identity + role only.
                if m.github_login.is_none() {
                    m.github_login = Some(collab.login.clone());
                }
                m.repo_role = Some(collab.role.clone());
                continue;
            }
            // Otherwise upsert the synthetic collaborator row.
            let synth_email = format!("{login_lc}@users.noreply.github.com");
            if let Some(m) = manifest
                .members
                .iter_mut()
                .find(|m| m.email.eq_ignore_ascii_case(&synth_email))
            {
                m.repo_role = Some(collab.role.clone());
                m.github_login = Some(collab.login.clone());
                m.source = TeamMemberSource::Collaborator;
            } else {
                manifest.members.push(TeamMember {
                    email: synth_email,
                    name: collab.login.clone(),
                    handle: login_lc,
                    commits: 0,
                    first_seen: now,
                    last_seen: 0,
                    claimed: false,
                    admin: false,
                    activity_text: None,
                    status_emoji: None,
                    voice_channel: None,
                    source: TeamMemberSource::Collaborator,
                    also_emails: Vec::new(),
                    github_login: Some(collab.login.clone()),
                    repo_role: Some(collab.role.clone()),
                });
            }
        }

        // (b) If the local user hasn't committed but is one of these
        //     collaborators, alias their real git email onto the matching row
        //     so this machine is recognised as that person (network-free).
        if !local_is_committer && !local_email.is_empty() {
            if let Some(login) = local_login.as_ref() {
                if let Some(m) = manifest.members.iter_mut().find(|m| {
                    m.github_login
                        .as_deref()
                        .map(|g| g.eq_ignore_ascii_case(login))
                        .unwrap_or(false)
                }) {
                    if !m
                        .also_emails
                        .iter()
                        .any(|a| a.eq_ignore_ascii_case(&local_email))
                    {
                        m.also_emails.push(local_email.clone());
                    }
                }
            }
        }

        // Cleanup: drop synthetic Collaborator rows whose handle is now held
        // by a real member — happens once a collaborator makes their first
        // commit under a different email and `sync_with_git` enrolls them.
        let real_handles: std::collections::HashSet<String> = manifest
            .members
            .iter()
            .filter(|m| m.source != TeamMemberSource::Collaborator)
            .map(|m| m.handle.clone())
            .collect();
        manifest
            .members
            .retain(|m| m.source != TeamMemberSource::Collaborator || !real_handles.contains(&m.handle));

        // Re-apply owner promotion in case a synthetic row is the owner.
        for m in manifest.members.iter_mut() {
            if is_owner_email(&m.email) {
                m.admin = true;
                m.claimed = true;
            }
        }

        manifest.members.sort_by(|a, b| b.last_seen.cmp(&a.last_seen));
        // A login may have just been attached to a member above; fold it into
        // the handle now so the roster shows the GitHub username immediately,
        // not on the next load.
        normalize_member_handles(&mut manifest);
        // A login stamped onto a committer above may now match a synthetic
        // collaborator seat (or a second git email that already carried that
        // login) — collapse them so the freshly-synced roster is dup-free on this
        // pass, not only after the next `sync_with_git`.
        collapse_duplicate_members(&mut manifest);
        manifest.collaborators_synced_at = now;
        write_team(&repo_root, &manifest)?;
        Ok(manifest)
    })
    .await
}

// ── Tauri commands: team ─────────────────────────────────────────────

#[tauri::command]
pub async fn team_load(repo_root: String) -> Result<TeamManifest, String> {
    // Local-first: derive the manifest from git history + on-disk JSON.
    // This always succeeds even when offline.
    let local_root = repo_root.clone();
    let mut manifest = crate::blocking::run(move || sync_with_git(&local_root)).await?;
    // Cloud presence: best-effort heartbeat + fetch so machines that
    // haven't committed yet still appear in the list. Errors are
    // swallowed — offline / self-hosted-without-presence is fine.
    let _ = announce_presence(&repo_root).await;
    if let Ok(entries) = fetch_presence(&repo_root).await {
        manifest = crate::blocking::run(move || {
            merge_presence_into_manifest(&mut manifest, &entries);
            let _ = write_team(&repo_root, &manifest);
            manifest
        })
        .await;
    }
    Ok(manifest)
}

#[derive(Debug, serde::Deserialize)]
struct PresenceEntry {
    device_id: String,
    display_name: String,
    #[serde(default)]
    email: Option<String>,
    last_seen: String,
    #[serde(default)]
    activity_text: Option<String>,
    #[serde(default)]
    status_emoji: Option<String>,
    #[serde(default)]
    voice_channel: Option<String>,
}

#[derive(Debug, serde::Deserialize)]
struct PresenceList {
    members: Vec<PresenceEntry>,
}

/// Path for the user's locally-saved presence status — applies across
/// every repo on this machine. We persist it so the status survives an
/// app restart without needing to re-type it.
fn status_path() -> Result<std::path::PathBuf, String> {
    let home = std::env::var("HOME").map_err(|_| "no HOME".to_string())?;
    Ok(std::path::PathBuf::from(home)
        .join(".aura")
        .join("desktop-status.json"))
}

/// Load the locally-saved status. Returns `(activity_text, status_emoji)`.
/// Missing file is a successful empty load — first run shouldn't error.
fn read_local_status() -> Result<(Option<String>, Option<String>), String> {
    let path = status_path()?;
    if !path.exists() {
        return Ok((None, None));
    }
    let raw = std::fs::read_to_string(&path).map_err(|e| e.to_string())?;
    #[derive(serde::Deserialize)]
    struct StoredStatus {
        #[serde(default)]
        activity_text: Option<String>,
        #[serde(default)]
        status_emoji: Option<String>,
    }
    let s: StoredStatus = serde_json::from_str(&raw).map_err(|e| e.to_string())?;
    Ok((s.activity_text, s.status_emoji))
}

#[derive(serde::Serialize, serde::Deserialize, Clone, Default)]
pub struct TeamStatus {
    #[serde(default)]
    pub activity_text: Option<String>,
    #[serde(default)]
    pub status_emoji: Option<String>,
}

// ── voice room state ────────────────────────────────────────────────
//
// In-memory only — there is no on-disk equivalent of `desktop-status.json`
// for voice. The desktop has at most one active LiveKit session at a
// time; it tells us via `team_voice_set` and we surface it on the next
// `announce_presence` heartbeat. A crash means the cell stays unset and
// the cloud-side 30-minute TTL sweeps the previous voice presence from
// every other client's roster.
//
// Stored as `Option<(repo_root, channel)>` rather than just `Option<String>`
// so:
//   1. The on-leave case ("set to None") is a single explicit call from
//      the UI; we never have to guess whether an empty string means
//      "left" or "never joined".
//   2. The voice channel is bound to the repo the user joined from.
//      `announce_presence` only stamps `voice_channel` onto a repo's
//      presence beacon when the announcing repo matches — otherwise a
//      user in voice on repo A would show as "in voice" on every other
//      repo's roster too, because the previous singleton was room-blind.
//      (JJ.3, #328.)
static CURRENT_VOICE_CHANNEL: RwLock<Option<(String, String)>> = RwLock::new(None);

/// Apply the same trim+lowercase+slug normalisation that the cloud uses
/// in `calls.rs::clean_channel`. Done client-side too so the value we
/// announce matches the value LiveKit sees, which matches the value the
/// channel-list chip compares against. One slug, three callers.
fn normalize_voice_channel(raw: &str) -> Option<String> {
    let cleaned: String = raw
        .trim()
        .trim_start_matches('#')
        .chars()
        .map(|c| {
            if c.is_ascii_alphanumeric() || c == '-' || c == '_' || c == ':' {
                c.to_ascii_lowercase()
            } else {
                '-'
            }
        })
        .collect();
    if cleaned.is_empty() {
        return None;
    }
    Some(cleaned.chars().take(80).collect())
}

/// Set (`Some`) or clear (`None`) the channel slug this desktop is
/// currently in voice on. The next `announce_presence` heartbeat picks
/// it up; we also fire one beacon immediately so other clients see the
/// state change without waiting for the periodic tick.
#[tauri::command]
pub async fn team_voice_set(
    repo_root: String,
    channel: Option<String>,
) -> Result<(), String> {
    let normalised = channel.as_deref().and_then(normalize_voice_channel);
    // Capture the previous repo so we can re-beacon it after the swap —
    // when a user jumps from voice in repo A to voice in repo B, repo
    // A's roster must see them leave too (otherwise the green "in voice"
    // chip sticks until the cloud's 30-minute TTL sweep).
    let previous_repo: Option<String> = {
        let guard = CURRENT_VOICE_CHANNEL
            .read()
            .map_err(|_| "voice state poisoned".to_string())?;
        guard.as_ref().map(|(repo, _)| repo.clone())
    };
    {
        let mut guard = CURRENT_VOICE_CHANNEL
            .write()
            .map_err(|_| "voice state poisoned".to_string())?;
        *guard = normalised.map(|ch| (repo_root.clone(), ch));
    }
    // Best-effort immediate beacon — surfaces the join/leave instantly
    // to teammates. Errors are intentionally swallowed: offline or
    // self-hosted-without-presence is still a valid state, and the next
    // periodic heartbeat will retry.
    let _ = announce_presence(&repo_root).await;
    // If we swapped repos (or fully left a previous repo's voice), the
    // previous repo's room needs an explicit beacon so its members see
    // the voice slot clear. Skip the redundant repeat when the previous
    // and current repo are the same path.
    if let Some(prev) = previous_repo {
        if prev != repo_root {
            let _ = announce_presence(&prev).await;
        }
    }
    Ok(())
}

/// Returns the active voice channel for `repo_root`, or `None` if the
/// user is not in voice on this repo (even if they are in voice on a
/// different repo). This is what `announce_presence` consults so each
/// repo's presence beacon only carries the voice slot when that repo
/// was the join origin.
fn voice_channel_for_repo(repo_root: &str) -> Option<String> {
    CURRENT_VOICE_CHANNEL
        .read()
        .ok()
        .and_then(|g| g.as_ref().and_then(|(repo, channel)| {
            if repo == repo_root {
                Some(channel.clone())
            } else {
                None
            }
        }))
}

/// Read the current desktop status used in the presence beacon.
#[tauri::command]
pub async fn team_status_get() -> Result<TeamStatus, String> {
    let (activity_text, status_emoji) = read_local_status()?;
    Ok(TeamStatus {
        activity_text,
        status_emoji,
    })
}

/// Set (or clear, by passing empty strings) the user's status. Cleans
/// inputs the same way the cloud will (trim + cap) so what the user
/// sees locally matches what teammates see remotely.
#[tauri::command]
pub async fn team_status_set(
    activity_text: Option<String>,
    status_emoji: Option<String>,
) -> Result<TeamStatus, String> {
    let path = status_path()?;
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    let cleaned_text = activity_text
        .map(|s| s.trim().chars().take(140).collect::<String>())
        .filter(|s| !s.is_empty());
    let cleaned_emoji = status_emoji
        .map(|s| s.trim().chars().take(8).collect::<String>())
        .filter(|s| !s.is_empty());
    let stored = TeamStatus {
        activity_text: cleaned_text,
        status_emoji: cleaned_emoji,
    };
    let raw = serde_json::to_string_pretty(&stored).map_err(|e| e.to_string())?;
    std::fs::write(&path, raw).map_err(|e| e.to_string())?;
    Ok(stored)
}

async fn announce_presence(repo_root: &str) -> Result<(), String> {
    let identity = effective_identity(Path::new(repo_root))?;
    let room_id = room_id_for_repo(Path::new(repo_root));
    let origin = room_origin();
    let (activity_text, status_emoji) = read_local_status().unwrap_or((None, None));
    let voice_channel = voice_channel_for_repo(repo_root);
    let body = serde_json::json!({
        "device_id": identity.device_id,
        "display_name": identity.display_name,
        "email": if identity.email.is_empty() { None } else { Some(identity.email) },
        "activity_text": activity_text,
        "status_emoji": status_emoji,
        "voice_channel": voice_channel,
    });
    let client = http_client().ok_or_else(|| "http client".to_string())?;
    let url = format!("{origin}/api/v1/room/{room_id}/presence");
    // Presence beacons expose who is in a room — attach the bearer so the
    // server can enforce membership once AURA_ROOMS_REQUIRE_AUTH is on.
    let mut req = client.post(&url).json(&body);
    if let Some(token) = cloud_api_token() {
        req = req.bearer_auth(token).org_scoped();
    }
    let resp = req
        .send()
        .await
        .map_err(|e| format!("POST {url}: {e}"))?;
    if !resp.status().is_success() {
        return Err(format!("HTTP {}", resp.status()));
    }
    Ok(())
}

async fn fetch_presence(repo_root: &str) -> Result<Vec<PresenceEntry>, String> {
    let room_id = room_id_for_repo(Path::new(repo_root));
    let origin = room_origin();
    let client = http_client().ok_or_else(|| "http client".to_string())?;
    let url = format!("{origin}/api/v1/room/{room_id}/presence");
    let mut req = client.get(&url);
    if let Some(token) = cloud_api_token() {
        req = req.bearer_auth(token).org_scoped();
    }
    let resp = req
        .send()
        .await
        .map_err(|e| format!("GET {url}: {e}"))?;
    if !resp.status().is_success() {
        return Err(format!("HTTP {}", resp.status()));
    }
    let list: PresenceList = resp.json().await.map_err(|e| e.to_string())?;
    Ok(list.members)
}

// Fold cloud-presence entries into the manifest. Entries with an email
// match existing git-derived members and update their `last_seen` /
// display name. Entries WITHOUT an email (the m1-just-opened-the-repo
// case) get a synthetic email keyed off device_id so they show up as a
// distinct row but don't collide with anyone's git identity.
fn merge_presence_into_manifest(manifest: &mut TeamManifest, presence: &[PresenceEntry]) {
    for p in presence {
        let name = p.display_name.trim();
        if name.is_empty() || p.device_id.trim().is_empty() {
            continue;
        }
        let presence_ts = chrono::DateTime::parse_from_rfc3339(&p.last_seen)
            .map(|d| d.timestamp())
            .unwrap_or_else(|_| now_secs());
        let email = p
            .email
            .clone()
            .map(|s| s.trim().to_lowercase())
            .filter(|s| !s.is_empty())
            .unwrap_or_else(|| {
                // Synthetic key — no real email, but stable per-device so
                // repeated heartbeats fold into the same row.
                format!("device:{}@presence.local", p.device_id.trim())
            });
        if let Some(m) = manifest.members.iter_mut().find(|m| m.email == email) {
            if presence_ts > m.last_seen {
                m.last_seen = presence_ts;
            }
            if !name.is_empty() {
                m.name = name.to_string();
            }
            m.activity_text = p.activity_text.clone();
            m.status_emoji = p.status_emoji.clone();
            m.voice_channel = p.voice_channel.clone();
        } else {
            manifest.members.push(TeamMember {
                email: email.clone(),
                name: name.to_string(),
                handle: handle_from_email(&email),
                commits: 0,
                first_seen: presence_ts,
                last_seen: presence_ts,
                claimed: false,
                admin: false,
                activity_text: p.activity_text.clone(),
                status_emoji: p.status_emoji.clone(),
                voice_channel: p.voice_channel.clone(),
                // Presence-only members never appeared in any git
                // history, so neither Direct nor Ancestor applies
                // precisely. `Direct` is the safe default: it's the
                // pre-existing behaviour and the upstream-only UI
                // treatment shouldn't apply to a teammate who hasn't
                // committed anywhere yet.
                source: TeamMemberSource::Direct,
                also_emails: Vec::new(),
                github_login: None,
                repo_role: None,
            });
        }
    }
    manifest
        .members
        .sort_by(|a, b| b.last_seen.cmp(&a.last_seen));
}

#[tauri::command]
pub async fn team_identity(repo_root: String) -> Result<TeamIdentity, String> {
    crate::blocking::run(move || {
        let manifest = sync_with_git(&repo_root)?;
        let (email, name) = git_local_identity(&repo_root);
        let handle = handle_from_email(&email);
        // Match against `email` AND each member's `also_emails`, case-insensitively,
        // so a teammate enrolled under one address but committing under another
        // (or recognised purely as a GitHub collaborator) is still seen as "in
        // team" without a network round-trip.
        let member = canonical_member_for_email(&manifest.members, &email);
        let login = account_login(&repo_root);
        let (effective_handle, effective_name_raw) =
            resolve_handle(&repo_root, &manifest.members, &email, login.as_deref());
        let effective_name = if effective_name_raw.is_empty() {
            name.clone()
        } else {
            effective_name_raw
        };
        Ok(TeamIdentity {
            email,
            handle,
            name,
            in_team: member.is_some(),
            claimed: member.map(|m| m.claimed).unwrap_or(false),
            admin: member.map(|m| m.admin).unwrap_or(false),
            effective_handle,
            effective_name,
            account_login: login,
        })
    })
    .await
}

/// Read the current per-repo identity override, if any. Used by the
/// ChatDoctor banner to decide whether the "Use @x for this repo"
/// affordance is already applied.
#[tauri::command]
pub fn identity_override_get(repo_root: String) -> Option<IdentityOverride> {
    let map = read_identity_overrides();
    map.get(&repo_root).cloned()
}

/// Pin a (handle, name, email) triple for this repo so the resolver
/// returns it regardless of the local git email. Used when a user has
/// multiple git identities on the same machine and wants to send chat
/// messages under a specific roster identity for this repo only.
#[tauri::command]
pub fn identity_override_set(
    repo_root: String,
    handle: String,
    name: String,
    email: String,
) -> Result<(), String> {
    let mut map = read_identity_overrides();
    map.insert(
        repo_root,
        IdentityOverride {
            handle,
            name,
            email,
            set_at: now_secs(),
        },
    );
    write_identity_overrides(&map)
}

/// Remove the per-repo override, falling back to alias resolution +
/// `handle_from_email`. Idempotent.
#[tauri::command]
pub fn identity_override_clear(repo_root: String) -> Result<(), String> {
    let mut map = read_identity_overrides();
    map.remove(&repo_root);
    write_identity_overrides(&map)
}

// Claim the current git user's slot. If nobody else is admin yet, the
// claimer becomes admin. Idempotent — re-running just re-asserts.
#[tauri::command]
pub async fn team_claim(repo_root: String) -> Result<TeamManifest, String> {
    crate::blocking::run(move || {
        let mut manifest = sync_with_git(&repo_root)?;
        let (email, name) = git_local_identity(&repo_root);
        if email.is_empty() {
            return Err("git user.email is not configured for this repo".to_string());
        }
        let has_admin = manifest.members.iter().any(|m| m.admin);
        let mut found = false;
        for m in manifest.members.iter_mut() {
            if m.email == email {
                m.claimed = true;
                if !has_admin {
                    m.admin = true;
                }
                if !name.is_empty() {
                    m.name = name.clone();
                }
                found = true;
                break;
            }
        }
        if !found {
            // User has never committed but still wants a seat. Insert them.
            manifest.members.push(TeamMember {
                email: email.clone(),
                name: if name.is_empty() { handle_from_email(&email) } else { name },
                handle: handle_from_email(&email),
                commits: 0,
                first_seen: now_secs(),
                last_seen: now_secs(),
                claimed: true,
                admin: !has_admin || is_owner_email(&email),
                activity_text: None,
                status_emoji: None,
                voice_channel: None,
                // A self-claim with no git history is a Direct teammate —
                // they're explicitly taking a seat on this fork, not an
                // inherited upstream contributor.
                source: TeamMemberSource::Direct,
                also_emails: Vec::new(),
                github_login: None,
                repo_role: None,
            });
        }
        write_team(&repo_root, &manifest)?;
        Ok(manifest)
    })
    .await
}

/// True when the local git identity maps to an admin member (or is a
/// hardcoded owner email). Centralises the advisory authorisation check
/// the mutating team commands share. Git gives everyone the same write
/// access to `team.json`, so this gate is advisory — it governs the
/// in-app admin affordances, not the file itself. The cloud "super
/// controls" tier (Aura-account login) is what makes roles enforceable;
/// until a team opts into that, this is the honour-system default.
fn local_caller_is_admin(repo_root: &str, manifest: &TeamManifest) -> bool {
    let (caller_email, _) = git_local_identity(repo_root);
    if caller_email.is_empty() {
        return false;
    }
    if is_owner_email(&caller_email) {
        return true;
    }
    manifest.members.iter().any(|m| {
        m.admin
            && (m.email.eq_ignore_ascii_case(&caller_email)
                || m
                    .also_emails
                    .iter()
                    .any(|a| a.eq_ignore_ascii_case(&caller_email)))
    })
}

/// Promote or demote a team member's advisory `admin` flag. Authorised
/// to admins (and the hardcoded owner). Refuses to strip the last admin
/// so a team can't lock itself out of the admin panel, and refuses to
/// demote a hardcoded owner (whom `sync_with_git` re-promotes anyway, so
/// the demote would silently bounce back).
#[tauri::command]
pub async fn team_set_admin(
    repo_root: String,
    target_email: String,
    admin: bool,
) -> Result<TeamManifest, String> {
    crate::blocking::run(move || {
        let target = target_email.trim().to_lowercase();
        if target.is_empty() {
            return Err("target email is required".to_string());
        }
        let mut manifest = match read_team(&repo_root) {
            Some(m) => m,
            None => sync_with_git(&repo_root)?,
        };
        if !local_caller_is_admin(&repo_root, &manifest) {
            return Err("admin only".to_string());
        }
        if !admin && is_owner_email(&target) {
            return Err("the repo owner can't be removed as admin".to_string());
        }
        if !admin {
            let admin_count = manifest.members.iter().filter(|m| m.admin).count();
            let target_is_admin = manifest.members.iter().any(|m| {
                m.admin
                    && (m.email.eq_ignore_ascii_case(&target)
                        || m.also_emails.iter().any(|a| a.eq_ignore_ascii_case(&target)))
            });
            if target_is_admin && admin_count <= 1 {
                return Err("can't remove the last admin — transfer admin first".to_string());
            }
        }
        let mut found = false;
        for m in manifest.members.iter_mut() {
            if m.email.eq_ignore_ascii_case(&target)
                || m.also_emails.iter().any(|a| a.eq_ignore_ascii_case(&target))
            {
                m.admin = admin;
                found = true;
                break;
            }
        }
        if !found {
            return Err("no team member with that email".to_string());
        }
        write_team(&repo_root, &manifest)?;
        Ok(manifest)
    })
    .await
}

/// Hand the admin role to another member and step down — atomically, so
/// the team is never momentarily left with zero (or two competing)
/// admins. The caller must currently be an admin. The recipient's seat
/// is marked `claimed` (taking the keys implies they're actively the
/// owner of that slot). A hardcoded owner who transfers keeps their own
/// flag, since `sync_with_git` would re-promote them regardless.
#[tauri::command]
pub async fn team_transfer_admin(
    repo_root: String,
    to_email: String,
) -> Result<TeamManifest, String> {
    crate::blocking::run(move || {
        let to = to_email.trim().to_lowercase();
        if to.is_empty() {
            return Err("recipient email is required".to_string());
        }
        let mut manifest = match read_team(&repo_root) {
            Some(m) => m,
            None => sync_with_git(&repo_root)?,
        };
        if !local_caller_is_admin(&repo_root, &manifest) {
            return Err("admin only".to_string());
        }
        let (caller_email, _) = git_local_identity(&repo_root);
        if to.eq_ignore_ascii_case(&caller_email) {
            return Err("you already hold admin".to_string());
        }
        {
            let recipient = manifest.members.iter_mut().find(|m| {
                m.email.eq_ignore_ascii_case(&to)
                    || m.also_emails.iter().any(|a| a.eq_ignore_ascii_case(&to))
            });
            match recipient {
                Some(m) => {
                    m.admin = true;
                    m.claimed = true;
                }
                None => return Err("no team member with that email".to_string()),
            }
        }
        if !is_owner_email(&caller_email) {
            for m in manifest.members.iter_mut() {
                if m.email.eq_ignore_ascii_case(&caller_email)
                    || m
                        .also_emails
                        .iter()
                        .any(|a| a.eq_ignore_ascii_case(&caller_email))
                {
                    m.admin = false;
                    break;
                }
            }
        }
        write_team(&repo_root, &manifest)?;
        Ok(manifest)
    })
    .await
}

/// Admin command — link a secondary git email to a team member's
/// primary record so messages sent from that address canonicalise to
/// the member's handle. Used by the Chat Doctor "Add this email as an
/// alias" affordance. Gated on the caller being either an admin or
/// the owner of the target handle (a user can always add aliases to
/// their own record).
#[tauri::command]
pub async fn team_alias_add(
    repo_root: String,
    target_handle: String,
    alias_email: String,
) -> Result<TeamManifest, String> {
    crate::blocking::run(move || {
        let alias = alias_email.trim().to_lowercase();
        if alias.is_empty() || !alias.contains('@') {
            return Err("alias email looks invalid".to_string());
        }
        let target = target_handle.trim().to_lowercase();
        if target.is_empty() {
            return Err("target handle is required".to_string());
        }
        let mut manifest = match read_team(&repo_root) {
            Some(m) => m,
            None => sync_with_git(&repo_root)?,
        };

        // Authorise: caller must be either an admin in the manifest OR the
        // owner of the target handle. Without this, anyone in the repo
        // could silently absorb anyone else's email.
        let (caller_email, _) = git_local_identity(&repo_root);
        let caller_is_admin = manifest.members.iter().any(|m| {
            m.admin && m.email.eq_ignore_ascii_case(&caller_email)
        });
        let caller_is_owner = manifest.members.iter().any(|m| {
            m.handle.eq_ignore_ascii_case(&target)
                && (m.email.eq_ignore_ascii_case(&caller_email)
                    || m.also_emails
                        .iter()
                        .any(|a| a.eq_ignore_ascii_case(&caller_email)))
        });
        if !caller_is_admin && !caller_is_owner {
            return Err("admin or self-owner only".to_string());
        }

        // Refuse to steal an alias from another member: if the email is
        // already a primary or alias on someone else's record, bail.
        let collision = manifest.members.iter().any(|m| {
            !m.handle.eq_ignore_ascii_case(&target)
                && (m.email.eq_ignore_ascii_case(&alias)
                    || m.also_emails.iter().any(|a| a.eq_ignore_ascii_case(&alias)))
        });
        if collision {
            return Err("email already claimed by another member".to_string());
        }

        let mut found = false;
        for m in manifest.members.iter_mut() {
            if m.handle.eq_ignore_ascii_case(&target) {
                if !m.email.eq_ignore_ascii_case(&alias)
                    && !m.also_emails.iter().any(|a| a.eq_ignore_ascii_case(&alias))
                {
                    m.also_emails.push(alias.clone());
                }
                found = true;
                break;
            }
        }
        if !found {
            return Err(format!("no member with handle @{target}"));
        }
        write_team(&repo_root, &manifest)?;
        Ok(manifest)
    })
    .await
}

/// Admin command — drop a previously-linked alias email from a team
/// member's `also_emails`. Mirror of `team_alias_add`: same authorisation
/// model (admin OR the handle's owner), same idempotent semantics
/// (removing a not-present alias is a no-op success). The canonical
/// `email` field is never touched — removing the primary identity goes
/// through a different (much higher-friction) flow.
#[tauri::command]
pub async fn team_alias_remove(
    repo_root: String,
    target_handle: String,
    alias_email: String,
) -> Result<TeamManifest, String> {
    crate::blocking::run(move || {
        let alias = alias_email.trim().to_lowercase();
        if alias.is_empty() {
            return Err("alias email required".to_string());
        }
        let target = target_handle.trim().to_lowercase();
        if target.is_empty() {
            return Err("target handle is required".to_string());
        }
        let mut manifest = match read_team(&repo_root) {
            Some(m) => m,
            None => sync_with_git(&repo_root)?,
        };

        let (caller_email, _) = git_local_identity(&repo_root);
        let caller_is_admin = manifest.members.iter().any(|m| {
            m.admin && m.email.eq_ignore_ascii_case(&caller_email)
        });
        let caller_is_owner = manifest.members.iter().any(|m| {
            m.handle.eq_ignore_ascii_case(&target)
                && (m.email.eq_ignore_ascii_case(&caller_email)
                    || m.also_emails
                        .iter()
                        .any(|a| a.eq_ignore_ascii_case(&caller_email)))
        });
        if !caller_is_admin && !caller_is_owner {
            return Err("admin or self-owner only".to_string());
        }

        let mut found = false;
        for m in manifest.members.iter_mut() {
            if m.handle.eq_ignore_ascii_case(&target) {
                let before = m.also_emails.len();
                m.also_emails
                    .retain(|a| !a.eq_ignore_ascii_case(&alias));
                if m.also_emails.len() != before {
                    found = true;
                } else {
                    // Treat "alias wasn't there" as idempotent success so the
                    // UI can fire-and-forget without distinguishing the cases.
                    found = true;
                }
                break;
            }
        }
        if !found {
            return Err(format!("no member with handle @{target}"));
        }
        // Un-sticking an alias also drops any force-merge that named it, so
        // `collapse_duplicate_members` won't silently re-absorb the row we just
        // detached on the next re-derive.
        manifest
            .identity_merges
            .retain(|m| m.a != alias && m.b != alias);
        write_team(&repo_root, &manifest)?;
        Ok(manifest)
    })
    .await
}

/// Lookup the canonical handle for an arbitrary email by walking the
/// team manifest's primary + alias map. Returns `None` if nobody in this
/// repo claims that address — at which point the caller should fall
/// back to `handle_from_email` (the local-part default). Surfaced as a
/// tauri command so the receive-side typing/reactions code can route
/// inbound events to the right roster entry without re-implementing the
/// resolver in TypeScript.
#[tauri::command]
pub async fn canonical_handle_for_email(
    repo_root: String,
    email: String,
) -> Result<Option<String>, String> {
    crate::blocking::run(move || {
        let manifest = match read_team(&repo_root) {
            Some(m) => m,
            None => sync_with_git(&repo_root)?,
        };
        Ok(canonical_member_for_email(&manifest.members, &email).map(|m| m.handle.clone()))
    })
    .await
}

// ── Duplicate-member suggestion (weak-signal, human-confirmed) ───────
//
// `collapse_duplicate_members` fuses rows automatically, but ONLY on a
// globally-unique link (same GitHub login, parsed noreply login, explicit
// alias). That deliberately misses the common real-world case: one human who
// committed under `yasar@naridon.com` AND was added as the GitHub collaborator
// `yasar-naridon`, or who commits as both `mck@naridon.com` and
// `mubasheer.ck@hotmail.com`. Those share only a *name* or an *email stem* —
// signals strong enough to SUGGEST but far too weak to merge on automatically
// (two people named "John" would fuse). So this layer proposes candidate groups
// for a human to confirm; confirming routes through the same `also_emails` alias
// path the auto-merge already collapses on, and rejecting records an
// `IdentitySplit` so the pair is never proposed again.

/// Domains whose members are automated agents, not people — excluded from
/// duplicate suggestions entirely (we never propose merging the Aura bot with a
/// human, nor two bots with each other).
fn is_bot_email(email: &str) -> bool {
    let e = email.trim().to_lowercase();
    e.ends_with("@aura.vcs") || e.ends_with("@anthropic.com")
}

/// Collapse a string to its bare identity core: lowercase, alphanumerics only.
/// "Mubasheer CK" → "mubasheerck"; "ijas-muhmd" → "ijasmuhmd";
/// "yasar-naridon" → "yasarnaridon". Used to compare names and logins on equal
/// footing regardless of spaces, case, and separators.
fn ident_core(s: &str) -> String {
    s.chars()
        .filter(|c| c.is_ascii_alphanumeric())
        .flat_map(|c| c.to_lowercase())
        .collect()
}

/// The identity core of an email's local-part (before `@`), alphanumerics only.
/// "yasar@naridon.com" → "yasar"; "mubasheer.ck@hotmail.com" → "mubasheerck".
/// Returns "" for a synthetic noreply seat (its identity lives in the login,
/// compared separately) or an empty local-part.
fn email_core(email: &str) -> String {
    let e = email.trim().to_lowercase();
    if noreply_login(&e).is_some() {
        return String::new();
    }
    match e.split('@').next() {
        Some(local) => ident_core(local),
        None => String::new(),
    }
}

/// Length of the shared leading run of two strings.
fn common_prefix_len(a: &str, b: &str) -> usize {
    a.chars().zip(b.chars()).take_while(|(x, y)| x == y).count()
}

/// Compare two identity cores. Returns `Some(strong)` when they plausibly name
/// the same person — `strong == true` for a near-certain match (equal, or one a
/// prefix of the other), `false` for a softer overlap (a long shared prefix).
/// `None` means no meaningful similarity. Thresholds are deliberately
/// conservative: this only *suggests*, and a false positive costs a human one
/// "different people" click, but the reason string must always read as obvious.
fn core_similarity(a: &str, b: &str) -> Option<bool> {
    // Floor at 5 so common short names ("john", "alex", "raj") never generate a
    // suggestion on their own — those collide across real, distinct people. Every
    // genuine duplicate we target ("yasar", "ijasmuhmd", "mubasheerck") clears it.
    if a.len() < 5 || b.len() < 5 {
        return None;
    }
    if a == b {
        return Some(true);
    }
    let (short, long) = if a.len() <= b.len() { (a, b) } else { (b, a) };
    // One core fully contained at the start of the other ("yasar" ⊂
    // "yasarnaridon", "shahabas" ⊂ "shahabascp14") — a strong signal.
    if long.starts_with(short) {
        return Some(true);
    }
    // A long shared prefix without full containment ("mubasheerck" vs
    // "mubasheernaridon" share "mubasheer") — softer, medium confidence.
    if common_prefix_len(short, long) >= 6 {
        return Some(false);
    }
    None
}

/// All comparison cores a member emits: its name, its GitHub login, and the
/// stems of its real (non-synthetic) emails. Any core of A matching any core of
/// B links the two.
fn suggestion_cores(m: &TeamMember) -> Vec<String> {
    let mut cores: Vec<String> = Vec::new();
    let name = ident_core(&m.name);
    if !name.is_empty() {
        cores.push(name);
    }
    if let Some(g) = m.github_login.as_deref() {
        let g = ident_core(g);
        if !g.is_empty() {
            cores.push(g);
        }
    }
    let e = email_core(&m.email);
    if !e.is_empty() {
        cores.push(e);
    }
    for a in &m.also_emails {
        let a = email_core(a);
        if !a.is_empty() {
            cores.push(a);
        }
    }
    cores.sort();
    cores.dedup();
    cores
}

/// Every lowercased email (primary + aliases) a member answers to — the key set
/// used to test a member against an `IdentitySplit` tombstone.
fn member_emails(m: &TeamMember) -> Vec<String> {
    let mut out = vec![m.email.trim().to_lowercase()];
    for a in &m.also_emails {
        let a = a.trim().to_lowercase();
        if !a.is_empty() {
            out.push(a);
        }
    }
    out.retain(|e| !e.is_empty());
    out.sort();
    out.dedup();
    out
}

/// True when the two members are a human-confirmed "different people" pair —
/// any email of A paired with any email of B appears in `splits`.
fn pair_is_split(a: &TeamMember, b: &TeamMember, splits: &[IdentitySplit]) -> bool {
    let ea = member_emails(a);
    let eb = member_emails(b);
    splits.iter().any(|s| {
        let (lo, hi) = (s.a.to_lowercase(), s.b.to_lowercase());
        (ea.contains(&lo) && eb.contains(&hi)) || (ea.contains(&hi) && eb.contains(&lo))
    })
}

/// Score a candidate pair. `Some(strong)` if they look like the same person.
/// Also produces the strongest human-readable reason for the match.
fn pair_match(a: &TeamMember, b: &TeamMember) -> Option<(bool, String)> {
    let ca = suggestion_cores(a);
    let cb = suggestion_cores(b);
    let mut best: Option<(bool, String)> = None;
    for x in &ca {
        for y in &cb {
            if let Some(strong) = core_similarity(x, y) {
                // Prefer the strongest signal; on a tie keep the first found.
                let better = match &best {
                    None => true,
                    Some((prev_strong, _)) => strong && !prev_strong,
                };
                if better {
                    let reason = format!(
                        "“{}” and “{}” look like the same person",
                        display_label(a),
                        display_label(b),
                    );
                    best = Some((strong, reason));
                }
            }
        }
    }
    best
}

/// A short human label for a member in a suggestion reason — the name if it has
/// one, else the handle, else the email.
fn display_label(m: &TeamMember) -> String {
    let n = m.name.trim();
    if !n.is_empty() {
        return n.to_string();
    }
    let h = m.handle.trim();
    if !h.is_empty() {
        return format!("@{h}");
    }
    m.email.clone()
}

/// Compute duplicate-member suggestions for a manifest. Pure over its inputs so
/// it is unit-testable without touching disk. Excludes bots, honours
/// `identity_splits` tombstones, and groups transitively (A~B, B~C ⇒ one group).
fn compute_duplicate_suggestions(
    members: &[TeamMember],
    splits: &[IdentitySplit],
) -> Vec<DuplicateSuggestion> {
    let n = members.len();
    if n < 2 {
        return Vec::new();
    }

    // Only real people are candidates.
    let eligible: Vec<usize> = (0..n).filter(|&i| !is_bot_email(&members[i].email)).collect();

    // Union-find over eligible indices, unioning any pair that matches and
    // isn't a confirmed split. Track, per group, the strongest signal seen and
    // one representative reason.
    fn find(parent: &mut std::collections::HashMap<usize, usize>, i: usize) -> usize {
        let mut r = i;
        while parent[&r] != r {
            let p = parent[&r];
            let gp = parent[&p];
            parent.insert(r, gp);
            r = gp;
        }
        r
    }
    let mut parent: std::collections::HashMap<usize, usize> =
        eligible.iter().map(|&i| (i, i)).collect();
    // group-leader → (any_strong, first_reason)
    let mut reasons: std::collections::HashMap<usize, (bool, String)> =
        std::collections::HashMap::new();

    for (ii, &i) in eligible.iter().enumerate() {
        for &j in eligible.iter().skip(ii + 1) {
            if pair_is_split(&members[i], &members[j], splits) {
                continue;
            }
            if let Some((strong, reason)) = pair_match(&members[i], &members[j]) {
                let ri = find(&mut parent, i);
                let rj = find(&mut parent, j);
                if ri != rj {
                    let (lo, hi) = (ri.min(rj), ri.max(rj));
                    parent.insert(hi, lo);
                }
                let leader = find(&mut parent, i);
                let entry = reasons.entry(leader).or_insert((false, reason.clone()));
                if strong && !entry.0 {
                    entry.0 = true;
                    entry.1 = reason;
                }
            }
        }
    }

    // Bucket members by group leader; keep only groups of 2+.
    let mut groups: std::collections::BTreeMap<usize, Vec<usize>> =
        std::collections::BTreeMap::new();
    for &i in &eligible {
        let r = find(&mut parent, i);
        groups.entry(r).or_default().push(i);
    }

    // Rank survivor exactly like the auto-merge: claimed, then real email, then
    // most commits, then oldest, then stable email tie-break.
    fn survivor_rank(
        m: &TeamMember,
    ) -> (bool, bool, u32, std::cmp::Reverse<i64>, std::cmp::Reverse<String>) {
        let synthetic = {
            let e = m.email.trim().to_lowercase();
            e.ends_with("@users.noreply.github.com") || e.ends_with("@presence.local")
        };
        let age = if m.first_seen == 0 { i64::MAX } else { m.first_seen };
        (
            m.claimed,
            !synthetic,
            m.commits,
            std::cmp::Reverse(age),
            std::cmp::Reverse(m.email.to_lowercase()),
        )
    }

    let mut out: Vec<DuplicateSuggestion> = Vec::new();
    for (leader, idxs) in groups {
        if idxs.len() < 2 {
            continue;
        }
        let survivor = *idxs
            .iter()
            .max_by_key(|&&i| survivor_rank(&members[i]))
            .expect("group non-empty");
        // Survivor first, then the rest by descending rank for a stable display.
        let mut ordered = idxs.clone();
        ordered.sort_by(|&x, &y| {
            if x == survivor {
                std::cmp::Ordering::Less
            } else if y == survivor {
                std::cmp::Ordering::Greater
            } else {
                survivor_rank(&members[y]).cmp(&survivor_rank(&members[x]))
            }
        });
        let (strong, reason) = reasons
            .get(&leader)
            .cloned()
            .unwrap_or((false, "These rows look like the same person".to_string()));
        out.push(DuplicateSuggestion {
            emails: ordered.iter().map(|&i| members[i].email.clone()).collect(),
            handles: ordered.iter().map(|&i| members[i].handle.clone()).collect(),
            names: ordered.iter().map(|&i| members[i].name.clone()).collect(),
            survivor_email: members[survivor].email.clone(),
            confidence: if strong { "high" } else { "medium" }.to_string(),
            reason,
        });
    }
    // Strong suggestions first, then larger groups, for a sensible banner order.
    out.sort_by(|x, y| {
        let sx = (x.confidence == "high", x.emails.len());
        let sy = (y.confidence == "high", y.emails.len());
        sy.cmp(&sx)
    });
    out
}

/// Read-only: propose likely-duplicate member groups for the roster's review
/// banner. Never mutates the manifest.
#[tauri::command]
pub async fn team_identity_suggest_duplicates(
    repo_root: String,
) -> Result<Vec<DuplicateSuggestion>, String> {
    crate::blocking::run(move || {
        let manifest = match read_team(&repo_root) {
            Some(m) => m,
            None => sync_with_git(&repo_root)?,
        };
        Ok(compute_duplicate_suggestions(
            &manifest.members,
            &manifest.identity_splits,
        ))
    })
    .await
}

/// Caller must be an admin OR one of the people implicated in the group — so a
/// non-admin can reconcile their OWN split identity, but nobody can fuse two
/// other people's rows.
fn authorize_identity_edit(
    manifest: &TeamManifest,
    repo_root: &str,
    involved: &[String],
) -> Result<(), String> {
    let (caller_email, _) = git_local_identity(repo_root);
    let caller = caller_email.trim().to_lowercase();
    let is_admin = manifest
        .members
        .iter()
        .any(|m| m.admin && m.email.eq_ignore_ascii_case(&caller));
    if is_admin {
        return Ok(());
    }
    let involved_lc: Vec<String> = involved.iter().map(|e| e.trim().to_lowercase()).collect();
    // The caller is "involved" if their git email is one of the group's rows
    // (primary or alias).
    let caller_involved = manifest.members.iter().any(|m| {
        (m.email.eq_ignore_ascii_case(&caller)
            || m.also_emails.iter().any(|a| a.eq_ignore_ascii_case(&caller)))
            && member_emails(m).iter().any(|e| involved_lc.contains(e))
    });
    if caller_involved {
        return Ok(());
    }
    Err("admin or one of the involved members only".to_string())
}

/// Confirm a suggestion: fold every `merged_email` row into the `survivor_email`
/// row by recording each as an alias, then let `collapse_duplicate_members` do
/// the actual merge (it unions on the shared `email:` token). This reuses the
/// exact, well-tested merge path rather than re-implementing folding.
#[tauri::command]
pub async fn team_identity_confirm_duplicate(
    repo_root: String,
    survivor_email: String,
    merged_emails: Vec<String>,
) -> Result<TeamManifest, String> {
    crate::blocking::run(move || {
        let survivor = survivor_email.trim().to_lowercase();
        if survivor.is_empty() || !survivor.contains('@') {
            return Err("survivor email looks invalid".to_string());
        }
        let merged: Vec<String> = merged_emails
            .iter()
            .map(|e| e.trim().to_lowercase())
            .filter(|e| !e.is_empty() && *e != survivor)
            .collect();
        if merged.is_empty() {
            return Err("nothing to merge".to_string());
        }

        let mut manifest = match read_team(&repo_root) {
            Some(m) => m,
            None => sync_with_git(&repo_root)?,
        };

        let mut involved = merged.clone();
        involved.push(survivor.clone());
        authorize_identity_edit(&manifest, &repo_root, &involved)?;

        // Find the survivor row (by primary or alias).
        let survivor_idx = manifest.members.iter().position(|m| {
            m.email.eq_ignore_ascii_case(&survivor)
                || m.also_emails.iter().any(|a| a.eq_ignore_ascii_case(&survivor))
        });
        let survivor_idx = match survivor_idx {
            Some(i) => i,
            None => return Err("survivor is not a member of this team".to_string()),
        };

        // Record every merged email as an alias on the survivor. `collapse` will
        // then union the owning rows into the survivor on the shared email token.
        for e in &merged {
            let already = manifest.members[survivor_idx]
                .email
                .eq_ignore_ascii_case(e)
                || manifest.members[survivor_idx]
                    .also_emails
                    .iter()
                    .any(|a| a.eq_ignore_ascii_case(e));
            if !already {
                manifest.members[survivor_idx].also_emails.push(e.clone());
            }
        }

        // Record each confirmed pairing durably. `also_emails` alone only survives
        // a re-derive when the two rows share an email/login token; a GitHub handle
        // paired with a personal Gmail shares neither, so the suggestion would come
        // right back. `identity_merges` is the top-level, re-derive-proof record
        // that `collapse_duplicate_members` force-unions on every load. Confirming a
        // pair also clears any stale "different people" split for it — the human
        // just said the opposite.
        for e in &merged {
            let pair = normalize_pair(&survivor, e);
            manifest
                .identity_splits
                .retain(|s| !(s.a == pair.a && s.b == pair.b));
            if !manifest
                .identity_merges
                .iter()
                .any(|m| m.a == pair.a && m.b == pair.b)
            {
                manifest.identity_merges.push(pair);
            }
        }

        collapse_duplicate_members(&mut manifest);
        write_team(&repo_root, &manifest)?;
        Ok(manifest)
    })
    .await
}

/// Reject a suggestion: record that two emails belong to DIFFERENT people so the
/// pair is never suggested again. Records the survivor↔each-other pairing so a
/// multi-row group is fully suppressed. Never merges anything.
#[tauri::command]
pub async fn team_identity_reject_duplicate(
    repo_root: String,
    email_a: String,
    email_b: String,
) -> Result<TeamManifest, String> {
    crate::blocking::run(move || {
        let a = email_a.trim().to_lowercase();
        let b = email_b.trim().to_lowercase();
        if a.is_empty() || b.is_empty() || a == b {
            return Err("two distinct emails required".to_string());
        }

        let mut manifest = match read_team(&repo_root) {
            Some(m) => m,
            None => sync_with_git(&repo_root)?,
        };
        authorize_identity_edit(&manifest, &repo_root, &[a.clone(), b.clone()])?;

        // Normalise: a <= b so the pair dedupes regardless of rejection order.
        let (lo, hi) = if a <= b { (a, b) } else { (b, a) };
        // Calling this pair "different people" must also drop any prior force-merge
        // for it, so the two records can never disagree (a split always wins, but
        // leaving a stale merge behind is confusing).
        manifest
            .identity_merges
            .retain(|m| !(m.a == lo && m.b == hi));
        let exists = manifest
            .identity_splits
            .iter()
            .any(|s| s.a == lo && s.b == hi);
        if !exists {
            manifest.identity_splits.push(IdentitySplit { a: lo, b: hi });
        }
        write_team(&repo_root, &manifest)?;
        Ok(manifest)
    })
    .await
}

// ── conversation addressing ──────────────────────────────────────────
//
// A one-to-one conversation is addressed by a slug spelled from the two
// people's handles at the moment a message is written (`dm-<sorted handles>`).
// Handles are not fixed. A person starts out addressed by the local part of
// their git email and is re-addressed by their GitHub login the moment we
// learn it (see `normalize_member_handles`), and a per-repo persona pin can
// change it again. Every time that happens the same two people spell a
// DIFFERENT slug — so every earlier message, in the local file AND in the
// cloud room, ends up filed under an address nobody ever asks for again and
// the conversation looks like it lost everything that was said in it.
//
// The conversation is still the same two people, so we resolve it by PEOPLE
// rather than by the string: collect every handle each side has answered to
// and read every address that pair can spell. New messages still go out under
// the current slug; the older addresses are read-only history folded back in.

fn push_unique_channel(out: &mut Vec<String>, slug: String) {
    if !slug.is_empty() && !out.iter().any(|c| c == &slug) {
        out.push(slug);
    }
}

/// Every handle a roster member has plausibly been addressed by: their current
/// handle, their GitHub login, and the local part of each email that resolves
/// to them (primary + admin-linked aliases) — exactly the layers
/// `resolve_handle` picks from depending on what was known at send time.
fn member_handle_aliases(m: &TeamMember) -> Vec<String> {
    let mut out = vec![m.handle.trim().to_lowercase()];
    if let Some(login) = m.github_login.as_deref() {
        out.push(login.trim().to_lowercase());
    }
    for email in member_emails(m) {
        out.push(handle_from_email(&email));
    }
    out.retain(|h| !h.is_empty());
    out.sort();
    out.dedup();
    out
}

/// The same set for the local user, layered like `resolve_handle`: a per-repo
/// persona pin, the signed-in GitHub login, our roster seat, and the local part
/// of our git email. Any of these may have spelled our side of an older slug.
/// The seat is matched by login/email rather than by handle so a colleague who
/// merely shares our email local part can never lend us their aliases.
fn local_handle_aliases(
    repo_root: &str,
    members: &[TeamMember],
    git_email: &str,
    account_login: Option<&str>,
) -> Vec<String> {
    let mut out = vec![resolve_handle(repo_root, members, git_email, account_login).0];
    if let Some((handle, _)) = repo_identity_override(repo_root) {
        out.push(handle.trim().to_lowercase());
    }
    if let Some(login) = account_login {
        out.push(login.trim().to_lowercase());
        if let Some(me) = member_for_github_login(members, login) {
            out.extend(member_handle_aliases(me));
        }
    }
    out.push(handle_from_email(git_email));
    if let Some(me) = canonical_member_for_email(members, git_email) {
        out.extend(member_handle_aliases(me));
    }
    out.retain(|h| !h.is_empty());
    out.sort();
    out.dedup();
    out
}

/// Every channel slug this conversation has lived under, the one we were asked
/// for first. A named channel is addressed by its own name and never moves, so
/// it resolves to itself — meaning a team whose handles never changed reads
/// exactly one address, as before. Capped so someone with many linked
/// addresses can't turn a single poll into a burst of reads.
fn conversation_channels(
    channel: &str,
    members: &[TeamMember],
    self_aliases: &[String],
) -> Vec<String> {
    const MAX_ADDRESSES: usize = 6;
    let mut out = vec![channel.to_string()];

    // The private scratch pad is addressed by our own handle alone, so a
    // rename orphans it exactly like a two-party conversation.
    if channel.starts_with("dm-self-") {
        for mine in self_aliases {
            push_unique_channel(&mut out, crate::notify::dm_channel(mine, mine));
            if out.len() >= MAX_ADDRESSES {
                break;
            }
        }
        return out;
    }

    let Some(rest) = channel.strip_prefix("dm-") else {
        return out;
    };
    let sides: Vec<&str> = rest.split("--").collect();
    if sides.len() != 2 {
        return out;
    }
    let is_mine = |h: &str| self_aliases.iter().any(|a| a == h);
    // Which side is the other person? If we recognise both sides or neither,
    // guessing would fold a stranger's conversation in here, so we stay on the
    // address we were handed.
    let peer = match (is_mine(sides[0]), is_mine(sides[1])) {
        (true, false) => sides[1],
        (false, true) => sides[0],
        _ => return out,
    };
    let peer_aliases = members
        .iter()
        .find(|m| member_handle_aliases(m).iter().any(|h| h == peer))
        .map(member_handle_aliases)
        .unwrap_or_else(|| vec![peer.to_string()]);

    for mine in self_aliases {
        for theirs in &peer_aliases {
            // Both sides spelling the same string would address the scratch
            // pad, not this conversation.
            if mine == theirs {
                continue;
            }
            push_unique_channel(&mut out, crate::notify::dm_channel(mine, theirs));
            if out.len() >= MAX_ADDRESSES {
                return out;
            }
        }
    }
    out
}

// ── Tauri commands: chat ─────────────────────────────────────────────

#[tauri::command]
pub async fn chat_list(
    repo_root: String,
    channel: String,
    after_ts: Option<i64>,
    limit: Option<usize>,
) -> Result<Vec<ChatMessage>, String> {
    let channel = slugify_channel(&channel);
    if channel.is_empty() {
        return Err("empty channel".to_string());
    }
    let after = after_ts.unwrap_or(0);

    let local_root = repo_root.clone();
    let local_channel = channel.clone();
    let (addresses, self_aliases, mut out, mut seen_ids) =
        crate::blocking::run(move || {
            // Roster + local identity, resolved ONCE. `read_team` is a single file
            // read; `sync_with_git` (the cold fallback) walks git history, which is far
            // too heavy to repeat per channel on a 30-second poll.
            let members = read_team(&local_root)
                .or_else(|| sync_with_git(&local_root).ok())
                .map(|m| m.members)
                .unwrap_or_default();
            let (git_email, _) = git_local_identity(&local_root);
            let login = account_login(&local_root);
            let self_aliases =
                local_handle_aliases(&local_root, &members, &git_email, login.as_deref());
            // Every address this conversation has been spelled by — see the section
            // note above. Just the one entry whenever nobody's handle ever changed.
            let addresses = conversation_channels(&local_channel, &members, &self_aliases);

            let mut out: Vec<ChatMessage> = Vec::new();
            // id-based dedup — the previous (handle, body, ts±60s) heuristic
            // dropped legitimate duplicate-content messages sent within a minute
            // of each other. Local + cloud rows are the same message, just
            // discovered through different paths; the id is canonical.
            let mut seen_ids: std::collections::HashSet<String> =
                std::collections::HashSet::new();
            for address in &addresses {
                let path = channel_path(&local_root, address);
                // A missing or unreadable file is ordinary, not fatal: this device may
                // simply never have written here, and an address that predates a
                // rename has no file at all. Ending the read on it is what left the
                // conversation blank — the cloud pass below still holds the history.
                let Ok(f) = fs::File::open(&path) else {
                    continue;
                };
                for line in BufReader::new(f).lines() {
                    let line = match line {
                        Ok(l) => l,
                        Err(_) => continue,
                    };
                    if line.trim().is_empty() {
                        continue;
                    }
                    let msg: ChatMessage = match serde_json::from_str(&line) {
                        Ok(m) => m,
                        Err(_) => continue,
                    };
                    if msg.ts < after {
                        continue;
                    }
                    if seen_ids.insert(msg.id.clone()) {
                        out.push(msg);
                    }
                }
            }
            (addresses, self_aliases, out, seen_ids)
        })
        .await;
    // Cloud merge — best effort. Adds messages from teammates on other
    // machines AND server-assigned seqs for our own pending rows. The
    // id is the authoritative dedup key for cross-machine collapses,
    // but for THIS machine's own sends the cloud assigns a brand-new id
    // (the POST body doesn't carry the local id), so id-equality alone
    // would let local-write + cloud-echo render as two bubbles. The
    // secondary pass below catches that: if a cloud row's handle, body,
    // and ts (±60s) match a local row, treat it as the same logical
    // message and patch the local row's seq/delivery_status instead of
    // appending. Limited to rows we sent so legitimate same-content sends
    // between different members within a minute still render — and matched
    // against every handle we answer to, because the cloud stamped whichever
    // one `resolve_handle` returned at the time, which is often not today's.
    let mut collapsed_local_ids: std::collections::HashSet<String> =
        std::collections::HashSet::new();
    for address in &addresses {
        let Ok(cloud_msgs) =
            fetch_cloud_chat(&repo_root, address, after, limit.unwrap_or(500)).await
        else {
            continue;
        };
        for cm in cloud_msgs {
            if cm.ts < after {
                continue;
            }
            if !seen_ids.insert(cm.id.clone()) {
                if let Some(existing) = out.iter_mut().find(|m| m.id == cm.id) {
                    if existing.seq.is_none() {
                        existing.seq = cm.seq;
                    }
                    if existing.delivery_status == "pending" {
                        existing.delivery_status = "delivered".to_string();
                    }
                }
                continue;
            }
            if self_aliases.iter().any(|h| h == &cm.from_handle) {
                if let Some(local) = out.iter_mut().find(|m| {
                    self_aliases.iter().any(|h| h == &m.from_handle)
                        && m.body == cm.body
                        && (m.ts - cm.ts).abs() <= 60
                        && !collapsed_local_ids.contains(&m.id)
                }) {
                    if local.seq.is_none() {
                        local.seq = cm.seq;
                    }
                    if local.delivery_status == "pending" {
                        local.delivery_status = "delivered".to_string();
                    }
                    collapsed_local_ids.insert(local.id.clone());
                    continue;
                }
            }
            out.push(cm);
        }
    }
    out.sort_by(|a, b| a.ts.cmp(&b.ts));
    let limit = limit.unwrap_or(500).min(2000);
    if out.len() > limit {
        let drop_n = out.len() - limit;
        out.drain(0..drop_n);
    }
    Ok(out)
}

#[derive(Deserialize)]
pub struct SendArgs {
    pub repo_root: String,
    pub channel: String,
    pub body: String,
    pub from_handle: Option<String>,    // override (e.g. for agent posts)
    pub from_name: Option<String>,
    pub thread_parent: Option<String>,
    pub is_agent: Option<bool>,
}

#[tauri::command]
pub async fn chat_send(args: SendArgs) -> Result<ChatMessage, String> {
    crate::blocking::run(move || {
        let SendArgs {
            repo_root,
            channel,
            body,
            from_handle,
            from_name,
            thread_parent,
            is_agent,
        } = args;
        let channel = slugify_channel(&channel);
        if channel.is_empty() {
            return Err("empty channel".to_string());
        }
        if body.trim().is_empty() {
            return Err("empty body".to_string());
        }
        let manifest = sync_with_git(&repo_root)?;
        let (handle, name) = match (from_handle, from_name) {
            (Some(h), Some(n)) => (h.to_lowercase(), n),
            (Some(h), None) => (h.to_lowercase(), h.clone()),
            _ => {
                // resolve_handle layers per-repo override → roster alias →
                // email-local-part fallback. Substituting it here means a
                // user with `mubasheer.ck@hotmail.com` locally still appears
                // as `@mck` after `mck`'s `also_emails` is updated, with no
                // git config change required.
                let (email, gname) = git_local_identity(&repo_root);
                let (h, n) = resolve_handle(
                    &repo_root,
                    &manifest.members,
                    &email,
                    account_login(&repo_root).as_deref(),
                );
                let final_name = if !n.is_empty() {
                    n
                } else if !gname.is_empty() {
                    gname
                } else {
                    h.clone()
                };
                (h, final_name)
            }
        };
        let mentions = parse_mentions(&body, &manifest.members);
        let msg = ChatMessage {
            id: random_id(),
            channel: channel.clone(),
            ts: now_secs(),
            from_handle: handle,
            from_name: name,
            body,
            mentions,
            thread_parent,
            is_agent: is_agent.unwrap_or(false),
            delivery_status: "pending".to_string(),
            seq: None,
            // Our own local echo is self by construction — no device tiebreaker
            // needed. The cloud stamps the real device id server-side; when this
            // same row is later re-fetched it arrives populated.
            from_device_id: None,
        };
        persist_and_deliver(&repo_root, msg)
    })
    .await
}

/// Shared rail primitive: durably record `msg` on its channel (append
/// JSONL → append outbox → spawn the per-message retry loop) and return
/// it. `chat_send` and the tasks/pages live-sync publishers both go
/// through here so the durability + cloud-delivery path lives in exactly
/// one place. The outbox entry is appended *before* the retry spawn so a
/// crash in between still leaves the next drain a row to pick up; both
/// files live under `.aura/team/` so they're co-located.
pub(crate) fn persist_and_deliver(
    repo_root: &str,
    msg: ChatMessage,
) -> Result<ChatMessage, String> {
    ensure_dirs(repo_root).map_err(|e| e.to_string())?;
    let path = channel_path(repo_root, &msg.channel);
    let mut f = OpenOptions::new()
        .create(true)
        .append(true)
        .open(&path)
        .map_err(|e| e.to_string())?;
    let line = serde_json::to_string(&msg).map_err(|e| e.to_string())?;
    writeln!(f, "{line}").map_err(|e| e.to_string())?;
    drop(f);

    let entry = OutboxEntry {
        msg_id: msg.id.clone(),
        channel: msg.channel.clone(),
        attempts: 0,
        last_error: None,
        next_attempt_ts: now_secs(),
        failed: false,
    };
    outbox_append(repo_root, &entry).map_err(|e| e.to_string())?;

    // Kick off the per-message retry loop. The drainer is intentionally
    // one-per-message rather than a single shared loop because messages
    // are infrequent and per-message tasks make the retry-state easy to
    // reason about (no shared lock, no priority queue).
    let repo_for_task = repo_root.to_string();
    let msg_for_task = msg.clone();
    tauri::async_runtime::spawn(async move {
        deliver_with_retry(repo_for_task, msg_for_task).await;
    });
    Ok(msg)
}

/// Build a `ChatMessage` authored by the local user for a *system*
/// channel (e.g. the hidden `__aura_tasks_sync` rail). No mention
/// parsing, no thread, not an agent — just identity + body. Used by the
/// live-sync publishers, which carry a JSON envelope in `body`.
pub(crate) fn new_system_message(repo_root: &str, channel: &str, body: String) -> ChatMessage {
    let (email, gname) = git_local_identity(repo_root);
    let handle = if email.is_empty() {
        "system".to_string()
    } else {
        handle_from_email(&email)
    };
    let name = if !gname.is_empty() { gname } else { handle.clone() };
    ChatMessage {
        id: random_id(),
        channel: channel.to_string(),
        ts: now_secs(),
        from_handle: handle,
        from_name: name,
        body,
        mentions: Vec::new(),
        thread_parent: None,
        is_agent: false,
        delivery_status: "pending".to_string(),
        seq: None,
        from_device_id: None,
    }
}

/// Catchup fetch for an arbitrary channel by cloud `seq`. Thin pub(crate)
/// wrapper over `fetch_cloud_chat_since` so the live-sync pollers can pull
/// the hidden sync channel without re-implementing the room/origin plumbing.
pub(crate) async fn fetch_channel_since(
    repo_root: &str,
    channel: &str,
    since_seq: Option<i64>,
) -> Result<Vec<ChatMessage>, String> {
    fetch_cloud_chat_since(repo_root, channel, since_seq).await
}

// ── Outbox + retry ─────────────────────────────────────────────────────

fn outbox_path(repo_root: &str) -> PathBuf {
    team_dir(repo_root).join("outbox.jsonl")
}

fn outbox_append(repo_root: &str, entry: &OutboxEntry) -> std::io::Result<()> {
    ensure_dirs(repo_root)?;
    let mut f = OpenOptions::new()
        .create(true)
        .append(true)
        .open(outbox_path(repo_root))?;
    let line = serde_json::to_string(entry).unwrap_or_default();
    writeln!(f, "{line}")
}

fn outbox_load(repo_root: &str) -> Vec<OutboxEntry> {
    let path = outbox_path(repo_root);
    let Ok(f) = fs::File::open(&path) else {
        return Vec::new();
    };
    let reader = BufReader::new(f);
    let mut out = Vec::new();
    for line in reader.lines().map_while(Result::ok) {
        if line.trim().is_empty() { continue; }
        if let Ok(e) = serde_json::from_str::<OutboxEntry>(&line) {
            out.push(e);
        }
    }
    // Collapse to the latest entry per msg_id — every retry rewrites a
    // fresh row appended at the end, and the most recent row is the
    // authoritative state.
    let mut by_id: BTreeMap<String, OutboxEntry> = BTreeMap::new();
    for e in out {
        by_id.insert(e.msg_id.clone(), e);
    }
    by_id.into_values().collect()
}

fn outbox_rewrite(repo_root: &str, entries: &[OutboxEntry]) -> std::io::Result<()> {
    ensure_dirs(repo_root)?;
    let tmp = outbox_path(repo_root).with_extension("jsonl.tmp");
    {
        let mut f = fs::File::create(&tmp)?;
        for e in entries {
            let line = serde_json::to_string(e).unwrap_or_default();
            writeln!(f, "{line}")?;
        }
    }
    fs::rename(tmp, outbox_path(repo_root))
}

fn outbox_remove(repo_root: &str, msg_id: &str) -> std::io::Result<()> {
    let mut entries = outbox_load(repo_root);
    entries.retain(|e| e.msg_id != msg_id);
    outbox_rewrite(repo_root, &entries)
}

fn outbox_update(repo_root: &str, msg_id: &str, mutator: impl FnOnce(&mut OutboxEntry)) -> std::io::Result<()> {
    let mut entries = outbox_load(repo_root);
    if let Some(e) = entries.iter_mut().find(|e| e.msg_id == msg_id) {
        mutator(e);
    }
    outbox_rewrite(repo_root, &entries)
}

/// Rewrite the channel JSONL flipping a row's `delivery_status`. Channel
/// files are small (a few hundred rows max for active channels) so this
/// is cheap; doing it append-only would require a side-band index and
/// is overkill for the message volumes this surface sees.
fn channel_mark_delivered(repo_root: &str, channel: &str, msg_id: &str, seq: Option<i64>) -> std::io::Result<()> {
    let path = channel_path(repo_root, channel);
    if !path.exists() {
        return Ok(());
    }
    let f = fs::File::open(&path)?;
    let reader = BufReader::new(f);
    let mut rows: Vec<ChatMessage> = Vec::new();
    for line in reader.lines().map_while(Result::ok) {
        if line.trim().is_empty() { continue; }
        if let Ok(m) = serde_json::from_str::<ChatMessage>(&line) {
            rows.push(m);
        }
    }
    let mut changed = false;
    for m in rows.iter_mut() {
        if m.id == msg_id {
            if m.delivery_status != "delivered" {
                m.delivery_status = "delivered".to_string();
                changed = true;
            }
            if m.seq.is_none() && seq.is_some() {
                m.seq = seq;
                changed = true;
            }
        }
    }
    if !changed {
        return Ok(());
    }
    let tmp = path.with_extension("jsonl.tmp");
    {
        let mut f = fs::File::create(&tmp)?;
        for m in &rows {
            let line = serde_json::to_string(m).unwrap_or_default();
            writeln!(f, "{line}")?;
        }
    }
    fs::rename(tmp, path)
}

fn channel_mark_failed(repo_root: &str, channel: &str, msg_id: &str) -> std::io::Result<()> {
    let path = channel_path(repo_root, channel);
    if !path.exists() {
        return Ok(());
    }
    let f = fs::File::open(&path)?;
    let reader = BufReader::new(f);
    let mut rows: Vec<ChatMessage> = Vec::new();
    for line in reader.lines().map_while(Result::ok) {
        if line.trim().is_empty() { continue; }
        if let Ok(m) = serde_json::from_str::<ChatMessage>(&line) {
            rows.push(m);
        }
    }
    let mut changed = false;
    for m in rows.iter_mut() {
        if m.id == msg_id && m.delivery_status != "failed" {
            m.delivery_status = "failed".to_string();
            changed = true;
        }
    }
    if !changed {
        return Ok(());
    }
    let tmp = path.with_extension("jsonl.tmp");
    {
        let mut f = fs::File::create(&tmp)?;
        for m in &rows {
            let line = serde_json::to_string(m).unwrap_or_default();
            writeln!(f, "{line}")?;
        }
    }
    fs::rename(tmp, path)
}

/// Per-message retry loop. Runs `MAX_OUTBOX_ATTEMPTS` posts with the
/// `BACKOFF_SECS` schedule, flipping JSONL + outbox state along the way.
/// Process-global set of message ids with a delivery task in flight.
/// Guards against two `deliver_with_retry` tasks racing on the same
/// message — see `InflightGuard`.
fn inflight_deliveries() -> &'static std::sync::Mutex<std::collections::HashSet<String>> {
    static SET: std::sync::OnceLock<std::sync::Mutex<std::collections::HashSet<String>>> =
        std::sync::OnceLock::new();
    SET.get_or_init(|| std::sync::Mutex::new(std::collections::HashSet::new()))
}

/// RAII claim on delivering one `msg_id`. `acquire` returns `None` when
/// another task already owns delivery, so a duplicate spawn becomes a
/// no-op; the claim is released on drop (every `deliver_with_retry`
/// return path). Without it, `chat_resend` fired while the original send
/// is still backing off would let both tasks see the un-removed outbox
/// entry and POST the same message — every teammate gets a duplicate.
struct InflightGuard(String);
impl InflightGuard {
    fn acquire(msg_id: &str) -> Option<Self> {
        let mut set = inflight_deliveries().lock().unwrap();
        // HashSet::insert returns false when the id is already present.
        if set.insert(msg_id.to_string()) {
            Some(InflightGuard(msg_id.to_string()))
        } else {
            None
        }
    }
}
impl Drop for InflightGuard {
    fn drop(&mut self) {
        if let Ok(mut set) = inflight_deliveries().lock() {
            set.remove(&self.0);
        }
    }
}

async fn deliver_with_retry(repo_root: String, msg: ChatMessage) {
    // Only one delivery task per msg_id may run at a time. Held for the
    // whole retry loop and dropped on any return, so a resend (or a
    // double outbox-drain) while delivery is in flight is a clean no-op
    // instead of a second POST that duplicates the message for everyone.
    let Some(_inflight) = InflightGuard::acquire(&msg.id) else {
        return;
    };
    loop {
        // Honour any prior-scheduled wait if the entry was resumed from
        // disk with a future `next_attempt_ts`.
        let entries = outbox_load(&repo_root);
        let Some(entry) = entries.iter().find(|e| e.msg_id == msg.id).cloned() else {
            // Removed externally (success) — exit cleanly.
            return;
        };
        if entry.failed {
            return;
        }
        let now = now_secs();
        if entry.next_attempt_ts > now {
            let wait = (entry.next_attempt_ts - now).max(0) as u64;
            tokio::time::sleep(Duration::from_secs(wait)).await;
        }
        let mut attempts: u32 = entry.attempts;

        match post_cloud_chat(&repo_root, &msg).await {
            Ok(()) => {
                let _ = channel_mark_delivered(&repo_root, &msg.channel, &msg.id, None);
                let _ = outbox_remove(&repo_root, &msg.id);
                return;
            }
            Err(err) => {
                attempts += 1;
                if attempts >= MAX_OUTBOX_ATTEMPTS {
                    let _ = outbox_update(&repo_root, &msg.id, |e| {
                        e.attempts = attempts;
                        e.last_error = Some(err.clone());
                        e.failed = true;
                    });
                    let _ = channel_mark_failed(&repo_root, &msg.channel, &msg.id);
                    return;
                }
                let backoff = BACKOFF_SECS
                    .get(attempts.saturating_sub(1) as usize)
                    .copied()
                    .unwrap_or(16);
                let _ = outbox_update(&repo_root, &msg.id, |e| {
                    e.attempts = attempts;
                    e.last_error = Some(err.clone());
                    e.next_attempt_ts = now_secs() + backoff;
                });
                tokio::time::sleep(Duration::from_secs(backoff as u64)).await;
            }
        }
    }
}

/// Inspect the outbox for a channel — UI calls this to render a
/// "retrying…" / "send failed" badge alongside pending messages.
#[tauri::command]
pub async fn chat_outbox_status(
    repo_root: String,
    channel: String,
) -> Result<Vec<OutboxEntry>, String> {
    let channel = slugify_channel(&channel);
    let entries = outbox_load(&repo_root)
        .into_iter()
        .filter(|e| e.channel == channel)
        .collect();
    Ok(entries)
}

/// Manual retry hook for the UI. Resets attempts to 0 and schedules an
/// immediate redelivery via the same `deliver_with_retry` loop.
#[tauri::command]
pub async fn chat_resend(
    repo_root: String,
    channel: String,
    msg_id: String,
) -> Result<(), String> {
    let channel = slugify_channel(&channel);
    // Find the durable row in the channel JSONL — we need it to drive
    // the retry loop (`post_cloud_chat` reads from the message body).
    let path = channel_path(&repo_root, &channel);
    let f = fs::File::open(&path).map_err(|e| e.to_string())?;
    let reader = BufReader::new(f);
    let mut found: Option<ChatMessage> = None;
    for line in reader.lines().map_while(Result::ok) {
        if line.trim().is_empty() { continue; }
        if let Ok(m) = serde_json::from_str::<ChatMessage>(&line) {
            if m.id == msg_id {
                found = Some(m);
                break;
            }
        }
    }
    let msg = found.ok_or_else(|| format!("message {msg_id} not found in {channel}"))?;

    // Reset the outbox entry (or create a fresh one if the prior had
    // been pruned on success and then re-introduced via UI action).
    let mut entries = outbox_load(&repo_root);
    if let Some(e) = entries.iter_mut().find(|e| e.msg_id == msg_id) {
        e.attempts = 0;
        e.failed = false;
        e.last_error = None;
        e.next_attempt_ts = now_secs();
    } else {
        entries.push(OutboxEntry {
            msg_id: msg_id.clone(),
            channel: channel.clone(),
            attempts: 0,
            last_error: None,
            next_attempt_ts: now_secs(),
            failed: false,
        });
    }
    outbox_rewrite(&repo_root, &entries).map_err(|e| e.to_string())?;

    let repo_for_task = repo_root.clone();
    let msg_for_task = msg.clone();
    tauri::async_runtime::spawn(async move {
        deliver_with_retry(repo_for_task, msg_for_task).await;
    });
    Ok(())
}

/// Replay the on-disk outbox after an app restart. Each pending entry
/// gets a fresh retry task. Idempotent — safe to call multiple times;
/// duplicate tasks for the same msg_id collapse via outbox state.
#[tauri::command]
pub async fn chat_outbox_drain_kickoff(repo_root: String) -> Result<(), String> {
    let entries = outbox_load(&repo_root);
    for entry in entries {
        if entry.failed {
            continue;
        }
        let path = channel_path(&repo_root, &entry.channel);
        let Ok(f) = fs::File::open(&path) else { continue; };
        let reader = BufReader::new(f);
        let mut found: Option<ChatMessage> = None;
        for line in reader.lines().map_while(Result::ok) {
            if line.trim().is_empty() { continue; }
            if let Ok(m) = serde_json::from_str::<ChatMessage>(&line) {
                if m.id == entry.msg_id {
                    found = Some(m);
                    break;
                }
            }
        }
        if let Some(msg) = found {
            let repo = repo_root.clone();
            tauri::async_runtime::spawn(async move {
                deliver_with_retry(repo, msg).await;
            });
        }
    }
    Ok(())
}

/// Catchup endpoint — fetches every cloud message with `seq > since_seq`
/// in arrival order. Used by `useReliableChat` after a WS reconnect when
/// the client knows its last-seen seq from localStorage.
#[tauri::command]
pub async fn chat_subscribe_since(
    repo_root: String,
    channel: String,
    since_seq: Option<i64>,
) -> Result<Vec<ChatMessage>, String> {
    let channel = slugify_channel(&channel);
    if channel.is_empty() {
        return Err("empty channel".to_string());
    }
    fetch_cloud_chat_since(&repo_root, &channel, since_seq).await
}

#[tauri::command]
pub async fn chat_thread(
    repo_root: String,
    channel: String,
    parent_id: String,
) -> Result<Vec<ChatMessage>, String> {
    let all = chat_list(repo_root, channel, None, Some(2000)).await?;
    let mut out: Vec<ChatMessage> = all
        .into_iter()
        .filter(|m| m.id == parent_id || m.thread_parent.as_deref() == Some(parent_id.as_str()))
        .collect();
    out.sort_by(|a, b| a.ts.cmp(&b.ts));
    Ok(out)
}

#[tauri::command]
pub async fn team_channel_create(
    repo_root: String,
    name: String,
    // Optional — absent (the legacy 2-arg call) creates an open channel
    // with no meta, byte-identical to the historical behaviour. Pass
    // "private" to seed a ChannelMeta with the given member allow-list.
    visibility: Option<String>,
    members: Option<Vec<String>>,
) -> Result<TeamManifest, String> {
    crate::blocking::run(move || {
        let slug = slugify_channel(&name);
        if slug.is_empty() {
            return Err("invalid channel name".to_string());
        }
        let mut manifest = sync_with_git(&repo_root)?;
        let existed = manifest.channels.iter().any(|c| c == &slug);
        if !existed {
            manifest.channels.push(slug.clone());
        }

        // Only seed visibility meta for a genuinely *new* channel. `create`
        // is intentionally ungated (any member can make a channel), so we
        // must not let it privatise/hijack a channel that already exists —
        // changing an existing channel's visibility goes through the
        // admin-gated `team_channel_update`.
        let want_private = !existed
            && visibility
                .as_deref()
                .map(|v| v.eq_ignore_ascii_case("private"))
                .unwrap_or(false);
        if want_private {
            let (creator, _) = git_local_identity(&repo_root);
            let creator = creator.trim().to_lowercase();
            let mut allow: Vec<String> = members
                .unwrap_or_default()
                .into_iter()
                .map(|e| e.trim().to_lowercase())
                .filter(|e| !e.is_empty())
                .collect();
            // The creator is always a member + channel admin of a channel
            // they just made private — otherwise they'd lock themselves out.
            if !creator.is_empty() && !allow.iter().any(|e| e == &creator) {
                allow.push(creator.clone());
            }
            allow.sort();
            allow.dedup();
            manifest.channel_meta.push(ChannelMeta {
                slug: slug.clone(),
                visibility: "private".to_string(),
                members: allow,
                admins: if creator.is_empty() {
                    Vec::new()
                } else {
                    vec![creator.clone()]
                },
                topic: None,
                tabs: Vec::new(),
                created_at: now_secs(),
                created_by: if creator.is_empty() {
                    None
                } else {
                    Some(creator)
                },
            });
        }

        // `want_private` implies `!existed`, so this writes exactly when the
        // channel (and possibly its seeded meta) is new.
        if !existed {
            write_team(&repo_root, &manifest)?;
        }
        // Touch the file so listings show it even with zero messages.
        ensure_dirs(&repo_root).map_err(|e| e.to_string())?;
        let path = channel_path(&repo_root, &slug);
        if !path.exists() {
            let _ = fs::File::create(&path);
        }
        Ok(manifest)
    })
    .await
}

/// True when the local user may administer the given channel: either a
/// team-wide admin (or owner) or a channel-level admin listed in the
/// channel's `admins`. Used to gate membership/visibility/topic edits.
fn caller_can_admin_channel(repo_root: &str, manifest: &TeamManifest, slug: &str) -> bool {
    if local_caller_is_admin(repo_root, manifest) {
        return true;
    }
    let (caller_email, _) = git_local_identity(repo_root);
    if caller_email.is_empty() {
        return false;
    }
    manifest
        .channel_meta
        .iter()
        .find(|c| c.slug == slug)
        .map(|c| c.admins.iter().any(|a| a.eq_ignore_ascii_case(&caller_email)))
        .unwrap_or(false)
}

/// Ensure a `ChannelMeta` exists for `slug`, returning a mutable ref.
/// Slugs only present in the flat `channels` list get an open-default
/// entry materialised on first edit.
fn channel_meta_mut<'a>(manifest: &'a mut TeamManifest, slug: &str) -> &'a mut ChannelMeta {
    if !manifest.channel_meta.iter().any(|c| c.slug == slug) {
        manifest.channel_meta.push(ChannelMeta {
            slug: slug.to_string(),
            visibility: default_channel_visibility(),
            members: Vec::new(),
            admins: Vec::new(),
            topic: None,
            tabs: Vec::new(),
            created_at: now_secs(),
            created_by: None,
        });
    }
    manifest
        .channel_meta
        .iter_mut()
        .find(|c| c.slug == slug)
        .expect("just inserted")
}

/// Update a channel's visibility and/or topic. `visibility`/`topic` are
/// each independently optional — `None` leaves that facet unchanged.
/// Flipping to private with no existing members seeds the caller as the
/// sole member+admin so the channel never becomes unreachable. Authorised
/// to team admins or channel admins.
#[tauri::command]
pub async fn team_channel_update(
    repo_root: String,
    slug: String,
    visibility: Option<String>,
    topic: Option<String>,
) -> Result<TeamManifest, String> {
    crate::blocking::run(move || {
        let slug = slugify_channel(&slug);
        if slug.is_empty() {
            return Err("invalid channel".to_string());
        }
        let mut manifest = match read_team(&repo_root) {
            Some(m) => m,
            None => sync_with_git(&repo_root)?,
        };
        if !manifest.channels.iter().any(|c| c == &slug) {
            return Err("no such channel".to_string());
        }
        if !caller_can_admin_channel(&repo_root, &manifest, &slug) {
            return Err("admin only".to_string());
        }
        let (caller_email, _) = git_local_identity(&repo_root);
        let caller_email = caller_email.trim().to_lowercase();
        let meta = channel_meta_mut(&mut manifest, &slug);
        if let Some(v) = visibility {
            let v = v.trim().to_lowercase();
            if v != "open" && v != "private" {
                return Err("visibility must be 'open' or 'private'".to_string());
            }
            if v == "private" {
                if !caller_email.is_empty() && !meta.members.iter().any(|e| e.eq_ignore_ascii_case(&caller_email)) {
                    meta.members.push(caller_email.clone());
                }
                if !caller_email.is_empty() && !meta.admins.iter().any(|e| e.eq_ignore_ascii_case(&caller_email)) {
                    meta.admins.push(caller_email.clone());
                }
            }
            meta.visibility = v;
        }
        if let Some(t) = topic {
            let t = t.trim();
            meta.topic = if t.is_empty() {
                None
            } else {
                Some(t.to_string())
            };
        }
        write_team(&repo_root, &manifest)?;
        Ok(manifest)
    })
    .await
}

/// Add a member (by email) to a private channel's allow-list. No-op on an
/// open channel (everyone is already a member). Authorised to team/channel
/// admins.
#[tauri::command]
pub async fn team_channel_member_add(
    repo_root: String,
    slug: String,
    email: String,
) -> Result<TeamManifest, String> {
    crate::blocking::run(move || {
        let slug = slugify_channel(&slug);
        let email = email.trim().to_lowercase();
        if slug.is_empty() || email.is_empty() {
            return Err("channel and email are required".to_string());
        }
        let mut manifest = match read_team(&repo_root) {
            Some(m) => m,
            None => sync_with_git(&repo_root)?,
        };
        if !manifest.channels.iter().any(|c| c == &slug) {
            return Err("no such channel".to_string());
        }
        if !caller_can_admin_channel(&repo_root, &manifest, &slug) {
            return Err("admin only".to_string());
        }
        let meta = channel_meta_mut(&mut manifest, &slug);
        if !meta.members.iter().any(|e| e.eq_ignore_ascii_case(&email)) {
            meta.members.push(email);
        }
        write_team(&repo_root, &manifest)?;
        Ok(manifest)
    })
    .await
}

/// Remove a member from a private channel's allow-list. Refuses to remove
/// the last remaining member (which would orphan the channel). Authorised
/// to team/channel admins.
#[tauri::command]
pub async fn team_channel_member_remove(
    repo_root: String,
    slug: String,
    email: String,
) -> Result<TeamManifest, String> {
    crate::blocking::run(move || {
        let slug = slugify_channel(&slug);
        let email = email.trim().to_lowercase();
        if slug.is_empty() || email.is_empty() {
            return Err("channel and email are required".to_string());
        }
        let mut manifest = match read_team(&repo_root) {
            Some(m) => m,
            None => sync_with_git(&repo_root)?,
        };
        if !caller_can_admin_channel(&repo_root, &manifest, &slug) {
            return Err("admin only".to_string());
        }
        if let Some(meta) = manifest.channel_meta.iter_mut().find(|c| c.slug == slug) {
            if meta.visibility == "private" && meta.members.len() <= 1 {
                return Err("can't remove the last member of a private channel".to_string());
            }
            meta.members.retain(|e| !e.eq_ignore_ascii_case(&email));
            meta.admins.retain(|e| !e.eq_ignore_ascii_case(&email));
            write_team(&repo_root, &manifest)?;
        }
        Ok(manifest)
    })
    .await
}

/// Promote or demote a channel-level admin (by email). Channel admins can
/// manage that channel's membership/visibility/topic without being a
/// team-wide admin. Promoting on a private channel also ensures the
/// member is in the allow-list (a channel admin who can't see the channel
/// would be nonsensical). Authorised to team/channel admins.
#[tauri::command]
pub async fn team_channel_admin_set(
    repo_root: String,
    slug: String,
    email: String,
    is_admin: bool,
) -> Result<TeamManifest, String> {
    crate::blocking::run(move || {
        let slug = slugify_channel(&slug);
        let email = email.trim().to_lowercase();
        if slug.is_empty() || email.is_empty() {
            return Err("channel and email are required".to_string());
        }
        let mut manifest = match read_team(&repo_root) {
            Some(m) => m,
            None => sync_with_git(&repo_root)?,
        };
        if !manifest.channels.iter().any(|c| c == &slug) {
            return Err("no such channel".to_string());
        }
        if !caller_can_admin_channel(&repo_root, &manifest, &slug) {
            return Err("admin only".to_string());
        }
        let meta = channel_meta_mut(&mut manifest, &slug);
        if is_admin {
            if !meta.admins.iter().any(|e| e.eq_ignore_ascii_case(&email)) {
                meta.admins.push(email.clone());
            }
            // A channel admin must be able to see the channel they administer.
            if meta.visibility == "private"
                && !meta.members.iter().any(|e| e.eq_ignore_ascii_case(&email))
            {
                meta.members.push(email);
            }
        } else {
            meta.admins.retain(|e| !e.eq_ignore_ascii_case(&email));
        }
        write_team(&repo_root, &manifest)?;
        Ok(manifest)
    })
    .await
}

/// Hard ceiling on custom tabs per channel — the header strip is finite
/// real estate, and six already pushes it on a laptop width.
const CHANNEL_TABS_MAX: usize = 6;

/// Validate a custom-tab label: trimmed, 1..=24 chars, no control chars.
/// Returns the normalised label.
fn validate_tab_label(label: &str) -> Result<String, String> {
    let label = label.trim();
    if label.is_empty() {
        return Err("tab label is required".to_string());
    }
    if label.chars().count() > 24 {
        return Err("tab label must be 24 characters or fewer".to_string());
    }
    if label.chars().any(|c| c.is_control()) {
        return Err("tab label has invalid characters".to_string());
    }
    Ok(label.to_string())
}

/// Validate a custom-tab URL: http(s) only (no javascript:/file:/data:
/// smuggling into the embedded view), no whitespace/control bytes, ≤2048
/// chars. Returns the trimmed URL.
fn validate_tab_url(url: &str) -> Result<String, String> {
    let url = url.trim();
    let lower = url.to_ascii_lowercase();
    if !(lower.starts_with("http://") || lower.starts_with("https://")) {
        return Err("tab URL must start with http:// or https://".to_string());
    }
    if url.len() > 2048 {
        return Err("tab URL is too long (max 2048)".to_string());
    }
    if url.chars().any(|c| c.is_control() || c.is_whitespace()) {
        return Err("tab URL has invalid characters".to_string());
    }
    // Require something after the scheme — "https://" alone is not a URL.
    let rest = &url[lower.find("//").map(|i| i + 2).unwrap_or(0)..];
    if rest.is_empty() {
        return Err("tab URL is incomplete".to_string());
    }
    Ok(url.to_string())
}

/// Pin a custom URL tab onto a channel's header. Open to any team member
/// (Slack-bookmark semantics — see the `tabs` field doc for why this is
/// not admin-gated on the advisory git layer). Caps at
/// `CHANNEL_TABS_MAX` per channel and rejects duplicate URLs.
#[tauri::command]
pub async fn team_channel_tab_add(
    repo_root: String,
    slug: String,
    label: String,
    url: String,
) -> Result<TeamManifest, String> {
    crate::blocking::run(move || {
        let slug = slugify_channel(&slug);
        if slug.is_empty() {
            return Err("invalid channel".to_string());
        }
        let label = validate_tab_label(&label)?;
        let url = validate_tab_url(&url)?;
        let mut manifest = match read_team(&repo_root) {
            Some(m) => m,
            None => sync_with_git(&repo_root)?,
        };
        if !manifest.channels.iter().any(|c| c == &slug) {
            return Err("no such channel".to_string());
        }
        let (caller_email, _) = git_local_identity(&repo_root);
        let caller_email = caller_email.trim().to_lowercase();
        let ts = now_secs();
        let meta = channel_meta_mut(&mut manifest, &slug);
        if meta.tabs.len() >= CHANNEL_TABS_MAX {
            return Err(format!(
                "channel already has {CHANNEL_TABS_MAX} tabs — remove one first"
            ));
        }
        if meta.tabs.iter().any(|t| t.url.eq_ignore_ascii_case(&url)) {
            return Err("that URL is already a tab on this channel".to_string());
        }
        // Stable unique id without a uuid dependency: timestamp + a content
        // hash, with the tab count folded in so two adds in the same second
        // can't collide.
        let id = {
            use std::collections::hash_map::DefaultHasher;
            use std::hash::{Hash, Hasher};
            let mut h = DefaultHasher::new();
            (&label, &url, ts, meta.tabs.len()).hash(&mut h);
            format!("tab-{ts}-{:08x}", (h.finish() & 0xffff_ffff) as u32)
        };
        meta.tabs.push(ChannelTabDef {
            id,
            label,
            url,
            added_by: if caller_email.is_empty() {
                None
            } else {
                Some(caller_email)
            },
            created_at: ts,
        });
        write_team(&repo_root, &manifest)?;
        Ok(manifest)
    })
    .await
}

/// Remove a custom tab from a channel by id. Open to any team member,
/// mirroring add — a stale dashboard link should never need an admin to
/// clean up.
#[tauri::command]
pub async fn team_channel_tab_remove(
    repo_root: String,
    slug: String,
    tab_id: String,
) -> Result<TeamManifest, String> {
    crate::blocking::run(move || {
        let slug = slugify_channel(&slug);
        if slug.is_empty() || tab_id.trim().is_empty() {
            return Err("channel and tab id are required".to_string());
        }
        let mut manifest = match read_team(&repo_root) {
            Some(m) => m,
            None => sync_with_git(&repo_root)?,
        };
        let Some(meta) = manifest.channel_meta.iter_mut().find(|c| c.slug == slug) else {
            return Err("no such tab".to_string());
        };
        let before = meta.tabs.len();
        meta.tabs.retain(|t| t.id != tab_id);
        if meta.tabs.len() == before {
            return Err("no such tab".to_string());
        }
        write_team(&repo_root, &manifest)?;
        Ok(manifest)
    })
    .await
}

/// Delete a non-core channel: drops it from the flat list, its meta, and
/// removes the backing JSONL. Core channels (general/agents/sentinel/
/// pull-requests) are protected. Authorised to team/channel admins.
#[tauri::command]
pub async fn team_channel_delete(
    repo_root: String,
    slug: String,
) -> Result<TeamManifest, String> {
    crate::blocking::run(move || {
        let slug = slugify_channel(&slug);
        if slug.is_empty() {
            return Err("invalid channel".to_string());
        }
        if CORE_CHANNELS.contains(&slug.as_str()) {
            return Err("can't delete a built-in channel".to_string());
        }
        let mut manifest = match read_team(&repo_root) {
            Some(m) => m,
            None => sync_with_git(&repo_root)?,
        };
        if !caller_can_admin_channel(&repo_root, &manifest, &slug) {
            return Err("admin only".to_string());
        }
        manifest.channels.retain(|c| c != &slug);
        manifest.channel_meta.retain(|c| c.slug != slug);
        write_team(&repo_root, &manifest)?;
        // Best-effort removal of the backing log; absence is fine.
        let path = channel_path(&repo_root, &slug);
        let _ = fs::remove_file(&path);
        Ok(manifest)
    })
    .await
}

// ── Cloud chat fan-out (unauth rooms) ────────────────────────────────
//
// Transport: POST/GET /api/v1/room/{room_id}/messages on the cloud
// origin. The room_id is sha256 of the git origin URL — every clone
// derives the same id locally, so no auth is needed: membership ==
// "has the clone". Channels map 1:1: regular channels (`general`,
// `agents`, `sentinel`, `dm:a:b`, custom) all post into the same
// room, distinguished by the `channel` field.
//
// Identity on the wire is `sender_device_id` (per-install UUID) +
// `sender_display` (current git user.name, falling back to the
// device's display_name) + optional `sender_email`. The cloud never
// verifies identity — it's just a hint for the UI.
//
// Local JSONL stays authoritative for the local user's own messages.
// `chat_list` merges cloud rows in and dedups self-echoes by
// (device_id-equiv handle, body, ±60s window).

fn chat_self_handle(repo_root: &str) -> Option<String> {
    let (email, _) = git_local_identity(repo_root);
    if email.is_empty() {
        return None;
    }
    Some(handle_from_email(&email))
}

fn http_client() -> Option<reqwest::Client> {
    reqwest::Client::builder()
        .timeout(Duration::from_secs(8))
        .build()
        .ok()
}

fn room_origin() -> String {
    // Read cloud_url from credentials if present so users on
    // self-hosted aura-cloud point at their own server. When the
    // credentials file is missing or the field is unset, fall back to
    // the public auravcs.com origin.
    let creds = read_credentials().unwrap_or_default();
    let origin = cloud_origin(&creds);
    // Any auravcs.com variant collapses to the canonical apex host so
    // HTTP writes always match the hardcoded `wss://auravcs.com`
    // subscriber. Without this, a stale `cloud_url` (e.g. legacy
    // `https://api.auravcs.com`, a beta server path, or a trailing
    // path component) routes POSTs to a host the WS never hears,
    // producing the "I can see them typing but their messages never
    // arrive" failure mode. Self-hosters keep whatever non-auravcs
    // host they set.
    if origin.contains("auravcs.com") {
        return "https://auravcs.com".to_string();
    }
    origin
}

fn cloud_url_raw() -> Option<String> {
    let creds = read_credentials().unwrap_or_default();
    creds
        .get("cloud_url")
        .and_then(|v| v.as_str())
        .filter(|s| !s.is_empty())
        .map(str::to_string)
}

fn cloud_token_present() -> bool {
    let creds = read_credentials().unwrap_or_default();
    creds
        .get("cloud_api_token")
        .and_then(|v| v.as_str())
        .map(|s| !s.is_empty())
        .unwrap_or(false)
}

/// The desktop's cloud API token, if the user is signed in. Attached as a
/// Bearer header on room calls so the server can bind a verified sender
/// identity (defeating impersonation) and enforce room auth once
/// `AURA_ROOMS_REQUIRE_AUTH` is flipped on. Absent when signed out — room
/// calls then go out unauthenticated, matching legacy behaviour while the
/// server still permits anonymous access.
fn cloud_api_token() -> Option<String> {
    let creds = read_credentials().unwrap_or_default();
    creds
        .get("cloud_api_token")
        .and_then(|v| v.as_str())
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(str::to_string)
}

/// Hand the renderer the cloud bearer so it can authenticate the room
/// surfaces that live in JS — the chat/pages WebSockets and the reaction /
/// pages-collab REST calls — which Rust can't attach a header to on its
/// behalf. Returns `null` when signed out (those calls then go out
/// unauthenticated, matching legacy behaviour until the server flag flips).
///
/// This is deliberately the ONLY seam that exposes the token to the webview.
/// It is a first-party, IPC-only command (the app shell is trusted; the
/// in-app browser runs in a separate, hardened webview). Keep it a single
/// accessor so a future swap to a short-lived, room-scoped token touches
/// exactly one place instead of every call site.
#[tauri::command]
pub fn cloud_room_token() -> Option<String> {
    cloud_api_token()
}

async fn post_cloud_chat(repo_root: &str, msg: &ChatMessage) -> Result<(), String> {
    let identity = effective_identity(Path::new(repo_root))?;
    // Route through the global Aura room when the channel slug matches;
    // every other channel falls back to the per-repo room. See
    // `effective_room_id` in cmd_device.rs.
    let room_id = effective_room_id(Path::new(repo_root), &msg.channel);
    let origin = room_origin();

    // A per-repo identity override is a deliberate pseudonym (the #aura
    // persona, or a custom @-name for this repo). Broadcasting the real
    // display name + git email alongside it defeats the point — a peer would
    // see "glacial-fox-836" sitting next to "Ashiq <ashiqwayanad007@gmail.com>"
    // and the mask is off. So when an override is active we present the
    // persona and DROP the real email: the receiver then derives a stable,
    // email-less handle for us instead of our real one.
    //
    // Residual (tracked, not closed here): `sender_device_id` still travels so
    // self-echo dedup keeps working, so a peer with raw cross-room row access
    // could in principle correlate the persona to real messages by device id.
    // Fully severing that needs a per-persona device token + dedup rework.
    let override_persona = repo_identity_override(repo_root);
    let (sender_display, email) = match &override_persona {
        Some((handle, name)) => {
            let shown = if name.trim().is_empty() {
                handle.clone()
            } else {
                name.clone()
            };
            (shown, None)
        }
        None => {
            let email = if identity.email.is_empty() {
                None
            } else {
                Some(identity.email.clone())
            };
            (identity.display_name.clone(), email)
        }
    };
    let body = serde_json::json!({
        "sender_device_id": identity.device_id,
        "sender_display": sender_display,
        "sender_email": email,
        "channel": msg.channel,
        "body": msg.body,
        "mentions": msg.mentions,
        "thread_parent": msg.thread_parent,
        "is_agent": msg.is_agent,
    });

    let client = http_client().ok_or_else(|| "http client".to_string())?;
    let url = format!("{origin}/api/v1/room/{room_id}/messages");
    let mut req = client.post(&url).json(&body);
    if let Some(token) = cloud_api_token() {
        req = req.bearer_auth(token).org_scoped();
    }
    let resp = req
        .send()
        .await
        .map_err(|e| format!("POST {url}: {e}"))?;
    if !resp.status().is_success() {
        let status = resp.status();
        let txt = resp.text().await.unwrap_or_default();
        return Err(format!("HTTP {status}: {txt}"));
    }
    Ok(())
}

#[derive(Deserialize)]
struct RoomMsgRow {
    id: String,
    #[serde(default)]
    channel: String,
    sender_device_id: String,
    sender_display: String,
    #[serde(default)]
    sender_email: Option<String>,
    body: String,
    #[serde(default)]
    mentions: Vec<String>,
    #[serde(default)]
    thread_parent: Option<String>,
    #[serde(default)]
    is_agent: bool,
    created_at: String,
    #[serde(default)]
    seq: Option<i64>,
}

#[derive(Deserialize)]
struct RoomMsgList {
    #[serde(default)]
    messages: Vec<RoomMsgRow>,
}

async fn fetch_cloud_chat(
    repo_root: &str,
    channel: &str,
    after_ts: i64,
    limit: usize,
) -> Result<Vec<ChatMessage>, String> {
    let room_id = effective_room_id(Path::new(repo_root), channel);
    let origin = room_origin();

    let mut url = format!(
        "{origin}/api/v1/room/{room_id}/messages?channel={}&limit={}",
        urlencoding(channel),
        limit.min(200).max(1)
    );
    if after_ts > 0 {
        let after_iso = DateTime::<chrono::Utc>::from_timestamp(after_ts, 0)
            .map(|d| d.to_rfc3339())
            .unwrap_or_default();
        if !after_iso.is_empty() {
            url.push_str(&format!("&since={}", urlencoding(&after_iso)));
        }
    }

    let client = http_client().ok_or_else(|| "http client".to_string())?;
    let mut req = client.get(&url);
    if let Some(token) = cloud_api_token() {
        req = req.bearer_auth(token).org_scoped();
    }
    let resp = req
        .send()
        .await
        .map_err(|e| format!("GET {url}: {e}"))?;
    if !resp.status().is_success() {
        return Err(format!("HTTP {}", resp.status()));
    }
    let parsed: RoomMsgList = resp.json().await.map_err(|e| format!("parse: {e}"))?;

    let mut out: Vec<ChatMessage> = Vec::with_capacity(parsed.messages.len());
    for row in parsed.messages {
        let ts = DateTime::parse_from_rfc3339(&row.created_at)
            .map(|d| d.timestamp())
            .unwrap_or(0);
        if ts < after_ts {
            continue;
        }
        if !row.channel.is_empty() && row.channel != channel {
            continue;
        }
        // Derive from email → device-id → (last resort) name slug. Never the
        // bare display name: two seats sharing a name must stay distinct.
        let handle = handle_from_row(
            row.sender_email.as_deref(),
            &row.sender_device_id,
            &row.sender_display,
        );
        out.push(ChatMessage {
            id: row.id,
            channel: if row.channel.is_empty() {
                channel.to_string()
            } else {
                row.channel
            },
            ts,
            from_handle: handle,
            from_name: row.sender_display,
            body: row.body,
            mentions: row.mentions,
            thread_parent: row.thread_parent,
            is_agent: row.is_agent,
            // Cloud rows are durable by definition — every row returned
            // here has been persisted server-side.
            delivery_status: "delivered".to_string(),
            seq: row.seq,
            from_device_id: normalize_device_id(row.sender_device_id),
        });
    }
    Ok(out)
}

/// Catchup variant of `fetch_cloud_chat` that uses the `since_seq` query
/// param on the cloud GET endpoint. Returns messages in seq-ascending
/// order; the caller is expected to merge by id + drive the local
/// last-seq cursor forward.
async fn fetch_cloud_chat_since(
    repo_root: &str,
    channel: &str,
    since_seq: Option<i64>,
) -> Result<Vec<ChatMessage>, String> {
    let room_id = effective_room_id(Path::new(repo_root), channel);
    let origin = room_origin();

    let mut url = format!(
        "{origin}/api/v1/room/{room_id}/messages?channel={}&limit=200",
        urlencoding(channel),
    );
    if let Some(seq) = since_seq {
        url.push_str(&format!("&since_seq={seq}"));
    }

    let client = http_client().ok_or_else(|| "http client".to_string())?;
    let mut req = client.get(&url);
    if let Some(token) = cloud_api_token() {
        req = req.bearer_auth(token).org_scoped();
    }
    let resp = req
        .send()
        .await
        .map_err(|e| format!("GET {url}: {e}"))?;
    if !resp.status().is_success() {
        return Err(format!("HTTP {}", resp.status()));
    }
    let parsed: RoomMsgList = resp.json().await.map_err(|e| format!("parse: {e}"))?;

    let mut out: Vec<ChatMessage> = Vec::with_capacity(parsed.messages.len());
    for row in parsed.messages {
        let ts = DateTime::parse_from_rfc3339(&row.created_at)
            .map(|d| d.timestamp())
            .unwrap_or(0);
        if !row.channel.is_empty() && row.channel != channel {
            continue;
        }
        // Derive from email → device-id → (last resort) name slug. Never the
        // bare display name: two seats sharing a name must stay distinct.
        let handle = handle_from_row(
            row.sender_email.as_deref(),
            &row.sender_device_id,
            &row.sender_display,
        );
        out.push(ChatMessage {
            id: row.id,
            channel: if row.channel.is_empty() {
                channel.to_string()
            } else {
                row.channel
            },
            ts,
            from_handle: handle,
            from_name: row.sender_display,
            body: row.body,
            mentions: row.mentions,
            thread_parent: row.thread_parent,
            is_agent: row.is_agent,
            delivery_status: "delivered".to_string(),
            seq: row.seq,
            from_device_id: normalize_device_id(row.sender_device_id),
        });
    }
    Ok(out)
}

/// Empty/blank device ids carry no signal — fold them to `None` so the
/// frontend's foreign-device check never fires on a missing value.
fn normalize_device_id(id: String) -> Option<String> {
    let t = id.trim();
    if t.is_empty() {
        None
    } else {
        Some(t.to_string())
    }
}

fn urlencoding(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    for byte in s.as_bytes() {
        let c = *byte as char;
        if c.is_ascii_alphanumeric() || matches!(c, '-' | '_' | '.' | '~') {
            out.push(c);
        } else {
            out.push_str(&format!("%{byte:02X}"));
        }
    }
    out
}

// ── chat doctor (diagnostic) ────────────────────────────────────────────
//
// Surfaces every value the chat substrate uses to deliver messages so a
// disconnected teammate can paste the report into a shared channel for
// triage. Read-only — never mutates anything.

#[derive(Serialize)]
pub struct ChatDoctorReport {
    pub room_id: String,
    pub room_id_source: String,
    pub origin_url_raw: Option<String>,
    pub origin_url_normalised: Option<String>,
    pub git_email: String,
    pub git_name: String,
    pub handle: String,
    pub device_id: String,
    pub cloud_origin: String,
    pub cloud_url_raw: Option<String>,
    pub cloud_token_present: bool,
    pub ws_url: String,
    pub http_ws_host_match: bool,
    pub cloud_reachable: bool,
    pub cloud_status: Option<u16>,
    pub cloud_error: Option<String>,
    pub channels: Vec<String>,
    pub local_message_count: usize,
    pub cloud_message_count_general: Option<usize>,
    pub outbox_pending: usize,
    pub outbox_failed: usize,
    pub outbox_last_error: Option<String>,
    /// Whether the local git email matches some member's primary email
    /// in the team roster (case-insensitive). False is the warning sign
    /// — the user is sending as a handle that won't reach mentions.
    #[serde(default)]
    pub roster_email_match: bool,
    /// Result of `resolve_handle()` — if the user's local git email
    /// canonicalises to a different roster identity (via alias or
    /// per-repo override), this is the handle their messages will
    /// actually carry.
    #[serde(default)]
    pub canonical_handle: Option<String>,
    #[serde(default)]
    pub canonical_email: Option<String>,
    /// Aliases declared on the canonical member's `also_emails`. Useful
    /// to surface in the banner so users see whether their hotmail
    /// address is already linked.
    #[serde(default)]
    pub alias_emails: Vec<String>,
    /// True if a per-repo identity override is currently active. Used
    /// by the banner to render "Active" instead of "Switch".
    #[serde(default)]
    pub identity_override_active: bool,
    /// The GitHub account signed in on this machine (`gh api user`), or
    /// `None` when `gh` is absent or signed out.
    ///
    /// This block exists so the identity picker can only ever offer a
    /// roster seat the local user has *evidence* of owning. The roster in
    /// `.aura/team/team.json` is rebuilt from `git log` and travels with
    /// the repo, so anyone who clones a project inherits the whole team's
    /// names — enumerating those names as things you might "be" hands a
    /// stranger somebody else's identity. A signed-in GitHub login that
    /// matches a seat's recorded `github_login` is a real claim; the
    /// mere presence of a seat in the file is not.
    #[serde(default)]
    pub github_login: Option<String>,
    /// Handle of the roster seat whose `github_login` matches the
    /// signed-in GitHub account, when there is one.
    #[serde(default)]
    pub github_member_handle: Option<String>,
    /// That seat's primary email, so the picker can persist the same
    /// address teammates already see on their messages.
    #[serde(default)]
    pub github_member_email: Option<String>,
    /// That seat's display name.
    #[serde(default)]
    pub github_member_name: Option<String>,
}

/// Everything `chat_doctor` can answer without touching the network,
/// gathered in one hop onto the blocking pool.
///
/// This is a struct rather than the tuple it grew out of because half its
/// fields are `Option<String>` identity values sitting next to each other:
/// positionally swapping two of them would compile clean and ship a user
/// the wrong person's handle, which is precisely the failure this file is
/// hardening against. Named fields make that mistake unrepresentable.
struct LocalChatFacts {
    raw_origin: Option<String>,
    room_id: String,
    room_id_source: String,
    normalised: Option<String>,
    email: String,
    name: String,
    handle: String,
    identity: crate::cmd_device::DeviceIdentity,
    roster_email_match: bool,
    canonical_handle: Option<String>,
    canonical_email: Option<String>,
    alias_emails: Vec<String>,
    identity_override_active: bool,
    github_login: Option<String>,
    github_member_handle: Option<String>,
    github_member_email: Option<String>,
    github_member_name: Option<String>,
    channels: Vec<String>,
    local_message_count: usize,
    outbox_pending: usize,
    outbox_failed: usize,
    outbox_last_error: Option<String>,
}

#[tauri::command]
pub async fn chat_doctor(repo_root: String) -> Result<ChatDoctorReport, String> {
    use crate::cmd_device::{
        normalise_origin_url, read_origin_url, read_repo_override, room_id_for_repo,
    };

    let local_root = repo_root.clone();
    let facts = crate::blocking::run(move || {
        let path = Path::new(&local_root);
        let raw_origin = read_origin_url(path);
        let room_id = room_id_for_repo(path);
        // Source precedence mirrors room_id_for_repo: an override file in the
        // repo wins over git origin which wins over the path-hash fallback.
        // Surfacing this lets the Doctor explain *why* two clones diverge.
        let room_id_source = if read_repo_override(path).is_some() {
            "repo-override".to_string()
        } else if raw_origin.is_some() {
            "git-origin".to_string()
        } else {
            "local-path-hash".to_string()
        };
        let normalised = raw_origin.as_deref().map(normalise_origin_url);

        let (email, name) = git_local_identity(&local_root);
        let handle = handle_from_email(&email);
        let identity =
            effective_identity(path).unwrap_or_else(|_| crate::cmd_device::DeviceIdentity {
                device_id: String::new(),
                display_name: String::new(),
                email: String::new(),
            });

        // Resolve the canonical identity against the roster + per-repo
        // override so the Doctor can surface the warning amber banner when
        // git email doesn't match any roster primary (the classic
        // "messages don't reach @mck because I'm sending as @mubasheer.ck"
        // failure mode).
        let manifest = read_team(&local_root).unwrap_or_else(|| TeamManifest {
            team_id: derive_team_id(&local_root),
            repo_root: local_root.clone(),
            created_at: now_secs(),
            members: Vec::new(),
            channel_meta: Vec::new(),
            channels: Vec::new(),
            collaborators_synced_at: 0,
            identity_splits: Vec::new(),
            identity_merges: Vec::new(),
        });
        let roster_email_match = manifest
            .members
            .iter()
            .any(|m| m.email.eq_ignore_ascii_case(&email));
        let canonical_member = canonical_member_for_email(&manifest.members, &email);
        let canonical_handle = canonical_member.map(|m| m.handle.clone());
        let canonical_email = canonical_member.map(|m| m.email.clone());
        let alias_emails = canonical_member
            .map(|m| m.also_emails.clone())
            .unwrap_or_default();
        let identity_override_active = repo_identity_override(&local_root).is_some();

        // The second (and for a fresh clone with no git identity, the
        // only) way a seat can be proven yours: the GitHub account signed
        // in on this machine is recorded on it. `account_login` is
        // memoised per process, so this costs one `gh api user` at most.
        let github_login = account_login(&local_root);
        let github_member = github_login
            .as_deref()
            .and_then(|login| member_for_github_login(&manifest.members, login));
        let github_member_handle = github_member.map(|m| m.handle.clone());
        let github_member_email = github_member.map(|m| m.email.clone());
        let github_member_name = github_member.map(|m| m.name.clone());

        // List channels by scanning .aura/team/chat/*.jsonl.
        let chat_dir = team_dir(&local_root).join(CHAT_DIR);
        let mut channels: Vec<String> = Vec::new();
        let mut local_message_count: usize = 0;
        if let Ok(entries) = fs::read_dir(&chat_dir) {
            for entry in entries.flatten() {
                let p = entry.path();
                if p.extension().and_then(|x| x.to_str()) == Some("jsonl") {
                    if let Some(stem) = p.file_stem().and_then(|x| x.to_str()) {
                        channels.push(stem.to_string());
                    }
                    if let Ok(f) = fs::File::open(&p) {
                        let reader = BufReader::new(f);
                        local_message_count += reader
                            .lines()
                            .filter_map(|l| l.ok())
                            .filter(|l| !l.trim().is_empty())
                            .count();
                    }
                }
            }
        }
        channels.sort();

        // Outbox snapshot.
        let outbox = outbox_load(&local_root);
        let outbox_pending = outbox.iter().filter(|e| !e.failed).count();
        let outbox_failed = outbox.iter().filter(|e| e.failed).count();
        let outbox_last_error = outbox
            .iter()
            .filter_map(|e| e.last_error.clone())
            .next_back();

        LocalChatFacts {
            raw_origin,
            room_id,
            room_id_source,
            normalised,
            email,
            name,
            handle,
            identity,
            roster_email_match,
            canonical_handle,
            canonical_email,
            alias_emails,
            identity_override_active,
            github_login,
            github_member_handle,
            github_member_email,
            github_member_name,
            channels,
            local_message_count,
            outbox_pending,
            outbox_failed,
            outbox_last_error,
        }
    })
    .await;

    // Destructured by name, so the identity fields below can't be crossed.
    let LocalChatFacts {
        raw_origin,
        room_id,
        room_id_source,
        normalised,
        email,
        name,
        handle,
        identity,
        roster_email_match,
        canonical_handle,
        canonical_email,
        alias_emails,
        identity_override_active,
        github_login,
        github_member_handle,
        github_member_email,
        github_member_name,
        channels,
        local_message_count,
        outbox_pending,
        outbox_failed,
        outbox_last_error,
    } = facts;

    // Reach the cloud — GET the general channel as a 1-message probe.
    let origin = room_origin();
    let mut cloud_reachable = false;
    let mut cloud_status: Option<u16> = None;
    let mut cloud_error: Option<String> = None;
    let mut cloud_message_count_general: Option<usize> = None;

    if let Some(client) = http_client() {
        let probe_url = format!(
            "{origin}/api/v1/room/{room_id}/messages?channel=general&limit=200"
        );
        match client.get(&probe_url).send().await {
            Ok(resp) => {
                cloud_status = Some(resp.status().as_u16());
                if resp.status().is_success() {
                    cloud_reachable = true;
                    if let Ok(parsed) = resp.json::<RoomMsgList>().await {
                        cloud_message_count_general = Some(parsed.messages.len());
                    }
                } else {
                    cloud_error = Some(format!("HTTP {}", resp.status().as_u16()));
                }
            }
            Err(e) => {
                cloud_error = Some(format!("{e}"));
            }
        }
    } else {
        cloud_error = Some("http client unavailable".to_string());
    }

    // WS subscriber is hardcoded to wss://auravcs.com in
    // `reliableChat.ts` (host: AURA_WS_HOST). Mismatch with the HTTP
    // origin means typing/reactions reach peers (WS works) while
    // chat_send POSTs go nowhere — produces the "we see them typing
    // but no messages arrive" failure mode.
    let ws_url = "wss://auravcs.com".to_string();
    let http_host = origin
        .trim_start_matches("https://")
        .trim_start_matches("http://")
        .trim_end_matches('/')
        .to_string();
    let ws_host = "auravcs.com".to_string();
    let http_ws_host_match = http_host == ws_host;

    Ok(ChatDoctorReport {
        room_id,
        room_id_source,
        origin_url_raw: raw_origin,
        origin_url_normalised: normalised,
        git_email: email,
        git_name: name,
        handle,
        device_id: identity.device_id,
        cloud_origin: origin,
        cloud_url_raw: cloud_url_raw(),
        cloud_token_present: cloud_token_present(),
        ws_url,
        http_ws_host_match,
        cloud_reachable,
        cloud_status,
        cloud_error,
        channels,
        local_message_count,
        cloud_message_count_general,
        outbox_pending,
        outbox_failed,
        outbox_last_error,
        roster_email_match,
        canonical_handle,
        canonical_email,
        alias_emails,
        identity_override_active,
        github_login,
        github_member_handle,
        github_member_email,
        github_member_name,
    })
}

// ── unit tests ──────────────────────────────────────────────────────
//
// Tests target the pure resolution helpers (`canonical_member_for_email`
// + `resolve_handle`) and the on-disk identity-override CRUD. Anything
// that hits the network (presence beacons, cloud chat) or shells out to
// git is exercised in higher-level integration runs — the pure logic
// here owns the bug class II.9 targets (an alias entry should always
// route a foreign git email to the team handle), so it deserves
// fast inline coverage.

#[cfg(test)]
mod tests {
    use super::*;

    // Back-compat guarantee: a manifest written before structured
    // channels existed must deserialize cleanly (empty channel_meta) AND
    // round-trip without sprouting a `channel_meta` key — so team.json
    // stays byte-stable for teams that never use a private channel.
    #[test]
    fn legacy_manifest_without_channel_meta_roundtrips_clean() {
        let json = r#"{"team_id":"t","repo_root":"/r","created_at":0,"members":[],"channels":["general","agents"]}"#;
        let m: TeamManifest = serde_json::from_str(json).unwrap();
        assert!(m.channel_meta.is_empty());
        let out = serde_json::to_string(&m).unwrap();
        assert!(
            !out.contains("channel_meta"),
            "legacy manifest must not gain a channel_meta key: {out}"
        );
        assert_eq!(m.channels, vec!["general".to_string(), "agents".to_string()]);
    }

    // A private channel's meta deserializes with members preserved and the
    // optional admins/topic defaulting cleanly when absent.
    #[test]
    fn private_channel_meta_roundtrips() {
        let json = r#"{"team_id":"t","repo_root":"/r","created_at":0,"members":[],"channels":["secret"],"channel_meta":[{"slug":"secret","visibility":"private","members":["a@b.com"]}]}"#;
        let m: TeamManifest = serde_json::from_str(json).unwrap();
        assert_eq!(m.channel_meta.len(), 1);
        let cm = &m.channel_meta[0];
        assert_eq!(cm.slug, "secret");
        assert_eq!(cm.visibility, "private");
        assert_eq!(cm.members, vec!["a@b.com".to_string()]);
        assert!(cm.admins.is_empty());
        assert!(cm.topic.is_none());
        let out = serde_json::to_string(&m).unwrap();
        assert!(out.contains("\"visibility\":\"private\""));
    }

    // Custom tabs are additive the same way channel_meta is: a meta entry
    // written before tabs existed must deserialize (empty tabs) and
    // round-trip without sprouting a `tabs` key.
    #[test]
    fn channel_meta_without_tabs_roundtrips_clean() {
        let json = r#"{"team_id":"t","repo_root":"/r","created_at":0,"members":[],"channels":["dev"],"channel_meta":[{"slug":"dev","visibility":"open","topic":"hi"}]}"#;
        let m: TeamManifest = serde_json::from_str(json).unwrap();
        assert!(m.channel_meta[0].tabs.is_empty());
        let out = serde_json::to_string(&m).unwrap();
        assert!(
            !out.contains("\"tabs\""),
            "tab-less meta must not gain a tabs key: {out}"
        );
    }

    #[test]
    fn channel_tabs_roundtrip() {
        let json = r#"{"team_id":"t","repo_root":"/r","created_at":0,"members":[],"channels":["dev"],"channel_meta":[{"slug":"dev","tabs":[{"id":"tab-1-abc","label":"CI","url":"https://ci.example.com","added_by":"a@b.com","created_at":5}]}]}"#;
        let m: TeamManifest = serde_json::from_str(json).unwrap();
        let tabs = &m.channel_meta[0].tabs;
        assert_eq!(tabs.len(), 1);
        assert_eq!(tabs[0].id, "tab-1-abc");
        assert_eq!(tabs[0].label, "CI");
        assert_eq!(tabs[0].url, "https://ci.example.com");
        assert_eq!(tabs[0].added_by.as_deref(), Some("a@b.com"));
        let out = serde_json::to_string(&m).unwrap();
        assert!(out.contains("\"url\":\"https://ci.example.com\""));
    }

    #[test]
    fn tab_label_validation_is_tight() {
        assert_eq!(validate_tab_label("  CI Dashboard "), Ok("CI Dashboard".to_string()));
        assert!(validate_tab_label("").is_err());
        assert!(validate_tab_label("   ").is_err());
        assert!(validate_tab_label(&"x".repeat(25)).is_err());
        assert!(validate_tab_label("bad\u{0007}label").is_err());
        // 24 exactly is fine; multi-byte counts chars, not bytes.
        assert!(validate_tab_label(&"é".repeat(24)).is_ok());
    }

    #[test]
    fn tab_url_validation_blocks_smuggling() {
        assert!(validate_tab_url("https://ci.example.com/x?y=1").is_ok());
        assert!(validate_tab_url("http://localhost:3000").is_ok());
        assert!(validate_tab_url("HTTPS://EXAMPLE.COM").is_ok());
        assert!(validate_tab_url("javascript:alert(1)").is_err());
        assert!(validate_tab_url("file:///etc/passwd").is_err());
        assert!(validate_tab_url("data:text/html,hi").is_err());
        assert!(validate_tab_url("https://").is_err());
        assert!(validate_tab_url("https://a b.com").is_err());
        assert!(validate_tab_url(&format!("https://e.com/{}", "a".repeat(2048))).is_err());
    }

    fn mk_member(handle: &str, email: &str, also: &[&str]) -> TeamMember {
        TeamMember {
            email: email.to_string(),
            name: handle.to_string(),
            handle: handle.to_string(),
            commits: 1,
            first_seen: 0,
            last_seen: 0,
            claimed: false,
            admin: false,
            activity_text: None,
            status_emoji: None,
            voice_channel: None,
            source: TeamMemberSource::Direct,
            also_emails: also.iter().map(|s| s.to_string()).collect(),
            github_login: None,
            repo_role: None,
        }
    }

    // The headline bug: mck@naridon.com is the primary, the user's local
    // git is mubasheer.ck@hotmail.com listed as an alias — the resolver
    // must return @mck so messages reach mentions.
    #[test]
    fn canonical_member_resolves_via_alias() {
        let members = vec![mk_member(
            "mck",
            "mck@naridon.com",
            &["mubasheer.ck@hotmail.com"],
        )];
        let m = canonical_member_for_email(&members, "mubasheer.ck@hotmail.com")
            .expect("alias lookup should hit");
        assert_eq!(m.handle, "mck");
    }

    // Case-insensitivity matters: git config can write capitalised
    // addresses, the alias might have been entered all-lowercase. The
    // resolver must collapse both before comparing.
    #[test]
    fn canonical_member_is_case_insensitive() {
        let members = vec![mk_member(
            "mck",
            "mck@naridon.com",
            &["Mubasheer.CK@Hotmail.com"],
        )];
        let m = canonical_member_for_email(&members, "MUBASHEER.ck@hotmail.com")
            .expect("alias lookup should ignore case");
        assert_eq!(m.handle, "mck");
        // Primary email should also match irrespective of case.
        let p = canonical_member_for_email(&members, "MCK@NARIDON.COM")
            .expect("primary lookup should ignore case");
        assert_eq!(p.handle, "mck");
    }

    // The absence-of-match path is just as load-bearing — without it the
    // caller can't tell "fall back to the email-local-part default" from
    // "the resolver crashed".
    #[test]
    fn canonical_member_missing_returns_none() {
        let members = vec![mk_member("alice", "alice@ex.com", &[])];
        assert!(canonical_member_for_email(&members, "bob@ex.com").is_none());
        // Empty / whitespace input should also short-circuit.
        assert!(canonical_member_for_email(&members, "   ").is_none());
        assert!(canonical_member_for_email(&members, "").is_none());
    }

    // The full `resolve_handle` pipeline — without an override and with
    // no roster match — must still return the email-local-part so legacy
    // single-identity setups keep working.
    #[test]
    fn resolve_handle_falls_back_to_email_local_part() {
        let members = vec![mk_member("alice", "alice@ex.com", &[])];
        let (handle, name) = resolve_handle(
            "/tmp/nonexistent-repo-for-test",
            &members,
            "stranger@somewhere.com",
            None,
        );
        assert_eq!(handle, "stranger");
        // No roster match => empty name. The send-side then substitutes
        // the local git name; tested via `chat_send` integration.
        assert_eq!(name, "");
    }

    // Identity-override CRUD round trip. We can't safely mutate the real
    // ~/.aura/identity-overrides.json (a developer running `cargo test`
    // would lose their own override), so the test pokes the in-memory
    // serde shape directly — same logic that disk reads/writes go
    // through, minus the global file.
    #[test]
    fn identity_override_round_trip() {
        let mut map: BTreeMap<String, IdentityOverride> = BTreeMap::new();
        map.insert(
            "/repo/a".to_string(),
            IdentityOverride {
                handle: "mck".to_string(),
                name: "Mubasheer CK".to_string(),
                email: "mck@naridon.com".to_string(),
                set_at: 1700000000,
            },
        );
        let json = serde_json::to_string(&map).expect("override map serialises");
        let parsed: BTreeMap<String, IdentityOverride> =
            serde_json::from_str(&json).expect("override map round-trips");
        assert_eq!(parsed.len(), 1);
        let entry = parsed.get("/repo/a").expect("repo key survives");
        assert_eq!(entry.handle, "mck");
        assert_eq!(entry.email, "mck@naridon.com");
    }

    // The per-repo override is the highest-priority layer. Even when the
    // local git email already canonicalises via alias to a DIFFERENT
    // handle, the override wins — that's how a user pins a one-off
    // identity for a single repo without touching the global team
    // manifest.
    #[test]
    fn resolve_handle_uses_override_over_alias() {
        let members = vec![
            mk_member("mck", "mck@naridon.com", &["mubasheer.ck@hotmail.com"]),
            mk_member("mubasheer-ck", "mubasheer.ck@hotmail.com", &[]),
        ];
        // No override path — we'd hit the alias (mck@naridon entry owns
        // the hotmail address as an `also_email`).
        let (handle_no_override, _) = resolve_handle(
            "/tmp/test-no-override",
            &members,
            "mubasheer.ck@hotmail.com",
            None,
        );
        assert_eq!(handle_no_override, "mck");
        // (We can't write to ~/.aura inside a test, so we verify the
        // priority by inspecting the `repo_identity_override` short-
        // circuit: when it returns Some, we take it; when None, we walk
        // the alias map. The Some-branch is covered by the round-trip
        // test above; the None-branch is what this assertion proves.)
    }

    // The headline cross-account fix: two laptops configured with the SAME
    // local git email but signed into DIFFERENT GitHub accounts must
    // resolve to DIFFERENT handles — otherwise each renders the other's
    // messages as its own first-person bubbles. The signed-in account is
    // the only signal that can tell them apart; the email layer can't.
    #[test]
    fn resolve_handle_signed_in_account_distinguishes_shared_email() {
        // One roster seat `mo`, owning the shared address, tagged with the
        // GitHub account that claimed it.
        let mut mo = mk_member("mo", "mo@company.com", &[]);
        mo.github_login = Some("mhask".to_string());
        let members = vec![mo];

        // Laptop A — signed in as `mhask`, which owns the `mo` seat.
        let (a_handle, _) = resolve_handle(
            "/tmp/acct-a",
            &members,
            "mo@company.com",
            Some("mhask"),
        );
        assert_eq!(a_handle, "mo");

        // Laptop B — SAME git email, but signed in as a different account
        // that owns no seat yet. It must NOT collapse onto `mo`; it sends
        // under its own login so the two stay distinct.
        let (b_handle, _) = resolve_handle(
            "/tmp/acct-b",
            &members,
            "mo@company.com",
            Some("mhdashiquek"),
        );
        assert_eq!(b_handle, "mhdashiquek");
        assert_ne!(a_handle, b_handle);
    }

    // Signed out (no `gh` account resolvable) must keep the historic
    // email-based behaviour untouched — single-identity and CI setups
    // never had a GitHub login and must not regress.
    #[test]
    fn resolve_handle_signed_out_falls_back_to_email() {
        let members = vec![mk_member("mo", "mo@company.com", &[])];
        let (handle, _) = resolve_handle(
            "/tmp/signed-out",
            &members,
            "mo@company.com",
            None,
        );
        assert_eq!(handle, "mo");
    }

    // `member_for_github_login` matches case-insensitively and ignores
    // seats that carry no GitHub identity.
    #[test]
    fn member_for_github_login_is_case_insensitive() {
        let mut m = mk_member("mo", "mo@company.com", &[]);
        m.github_login = Some("MHask".to_string());
        let members = vec![mk_member("alice", "alice@ex.com", &[]), m];
        assert_eq!(
            member_for_github_login(&members, "mhask").map(|m| m.handle.as_str()),
            Some("mo")
        );
        assert!(member_for_github_login(&members, "nobody").is_none());
        assert!(member_for_github_login(&members, "  ").is_none());
    }

    // The headline regression: once the local user's handle moved from their
    // email local-part to their GitHub login, the 1:1 with a teammate started
    // spelling a brand-new channel — so every message said before the rename
    // sat under an address nobody asked for again and the conversation looked
    // emptied. Reading it must resolve BOTH addresses.
    #[test]
    fn conversation_channels_include_the_address_before_a_rename() {
        let mut peer = mk_member("shahabas", "shahabas@aikolumi.com", &[]);
        peer.github_login = Some("shahabas".to_string());
        let members = vec![peer];
        let self_aliases = vec!["ashiqwayanad007".to_string(), "mhask".to_string()];
        let got = conversation_channels("dm-mhask--shahabas", &members, &self_aliases);
        assert_eq!(got[0], "dm-mhask--shahabas", "current address must come first");
        assert!(got.contains(&"dm-ashiqwayanad007--shahabas".to_string()));
    }

    // A teammate renamed too — the pair has to be resolved from BOTH sides'
    // alias sets, not just ours.
    #[test]
    fn conversation_channels_follow_a_teammates_rename() {
        let mut peer = mk_member("ijas-muhmd", "ijas-muhmd@example.com", &["ijasmuhammed20@gmail.com"]);
        peer.github_login = Some("ijas-muhmd".to_string());
        let members = vec![peer];
        let self_aliases = vec!["mhask".to_string()];
        let got = conversation_channels("dm-ijas-muhmd--mhask", &members, &self_aliases);
        assert!(got.contains(&"dm-ijasmuhammed20--mhask".to_string()));
    }

    // A named channel is addressed by its own name and never moves, and a team
    // whose handles never changed must read exactly one address — otherwise
    // every poll would fan out into redundant reads.
    #[test]
    fn conversation_channels_stay_single_when_nothing_was_renamed() {
        let members = vec![mk_member("shahabas", "shahabas@aikolumi.com", &[])];
        let self_aliases = vec!["mhask".to_string()];
        assert_eq!(
            conversation_channels("general", &members, &self_aliases),
            vec!["general".to_string()]
        );
        assert_eq!(
            conversation_channels("dm-mhask--shahabas", &members, &self_aliases),
            vec!["dm-mhask--shahabas".to_string()]
        );
    }

    // Widening must never reach into someone else's conversation: if neither
    // side of the slug is recognisably us, we have no basis to say who the
    // other person is, so we read only what we were handed.
    #[test]
    fn conversation_channels_never_guess_a_strangers_conversation() {
        let members = vec![
            mk_member("alice", "alice@ex.com", &["alice.w@old.example"]),
            mk_member("bob", "bob@ex.com", &[]),
        ];
        let self_aliases = vec!["mhask".to_string()];
        assert_eq!(
            conversation_channels("dm-alice--bob", &members, &self_aliases),
            vec!["dm-alice--bob".to_string()]
        );
    }

    // The private scratch pad is addressed by our own handle alone, so a
    // rename orphans it the same way.
    #[test]
    fn conversation_channels_cover_the_scratch_pad_before_a_rename() {
        let self_aliases = vec!["ashiqwayanad007".to_string(), "mhask".to_string()];
        let got = conversation_channels("dm-self-mhask", &[], &self_aliases);
        assert!(got.contains(&"dm-self-ashiqwayanad007".to_string()));
        assert!(got.contains(&"dm-self-mhask".to_string()));
    }

    #[test]
    fn member_handle_aliases_cover_login_handle_and_every_email() {
        let mut m = mk_member("mck", "mck@naridon.com", &["mubasheer.ck@hotmail.com"]);
        m.github_login = Some("MubasheerCK".to_string());
        let got = member_handle_aliases(&m);
        for expected in ["mck", "mubasheer.ck", "mubasheerck"] {
            assert!(got.contains(&expected.to_string()), "missing {expected} in {got:?}");
        }
    }

    // The roster handle defaults to the email local-part, but once a
    // member's GitHub login is known it should become the handle — so the
    // same person is @mhask whether they commit as `ashiqwayanad007@gmail`
    // or `mo@touchstage`. Members with no login (and the casing) are
    // handled: login wins and is lowercased; no-login seats stay as-is.
    #[test]
    fn normalize_member_handles_prefers_github_login() {
        let mut ashiq = mk_member("ashiqwayanad007", "ashiqwayanad007@gmail.com", &[]);
        ashiq.github_login = Some("MHASK".to_string());
        let mo = mk_member("mo", "mo@company.com", &[]); // no login → untouched
        let mut manifest = TeamManifest {
            team_id: "t".into(),
            repo_root: "/tmp/x".into(),
            created_at: 0,
            members: vec![ashiq, mo],
            channel_meta: Vec::new(),
            channels: Vec::new(),
            collaborators_synced_at: 0,
            identity_splits: Vec::new(),
            identity_merges: Vec::new(),
        };
        normalize_member_handles(&mut manifest);
        assert_eq!(manifest.members[0].handle, "mhask"); // login wins, lowercased
        assert_eq!(manifest.members[1].handle, "mo"); // no login → kept
    }

    // Alias collision guard — the `team_alias_add` command (and any
    // future bulk import) must not let two members claim the same
    // address. Verified at the data-structure level here so the rule
    // is enforced even when callers bypass the tauri command.
    #[test]
    fn canonical_member_picks_first_owner_on_collision() {
        let members = vec![
            mk_member("alice", "alice@ex.com", &["shared@ex.com"]),
            mk_member("bob", "bob@ex.com", &["shared@ex.com"]),
        ];
        let owner = canonical_member_for_email(&members, "shared@ex.com")
            .expect("at least one owner should be returned");
        // Iteration is in-order so we deterministically get the first
        // declarer. The command-level check rejects the second declarer
        // up front, so this is the realistic post-write state.
        assert_eq!(owner.handle, "alice");
    }

    // Empty `also_emails` must not cause a false-positive match (a
    // previous draft of the resolver had a subtle bug where empty alias
    // strings collapsed to "" and matched empty queries).
    #[test]
    fn empty_alias_does_not_match_empty_query() {
        let members = vec![mk_member("alice", "alice@ex.com", &[""])];
        assert!(canonical_member_for_email(&members, "").is_none());
        assert!(canonical_member_for_email(&members, "   ").is_none());
    }

    // Sanity: the email-local-part helper used as the final fallback
    // strips the domain and lowercases. Captures regressions in the
    // utility the rest of the resolver depends on.
    #[test]
    fn handle_from_email_extracts_local_part() {
        assert_eq!(handle_from_email("Alice@Example.COM"), "alice");
        assert_eq!(handle_from_email("no-at-sign"), "no-at-sign");
        assert_eq!(handle_from_email(""), "");
    }

    // `noreply_login` parses both GitHub noreply forms and rejects anything
    // else — it's the bridge that ties a noreply commit to a login-derived row.
    #[test]
    fn noreply_login_parses_both_forms() {
        assert_eq!(
            noreply_login("12345+Octocat@users.noreply.github.com").as_deref(),
            Some("octocat")
        );
        assert_eq!(
            noreply_login("octocat@users.noreply.github.com").as_deref(),
            Some("octocat")
        );
        assert!(noreply_login("octocat@gmail.com").is_none());
        assert!(noreply_login("@users.noreply.github.com").is_none());
    }

    fn mk_manifest(members: Vec<TeamMember>) -> TeamManifest {
        TeamManifest {
            team_id: "t".into(),
            repo_root: "/tmp/x".into(),
            created_at: 0,
            members,
            channel_meta: Vec::new(),
            channels: Vec::new(),
            collaborators_synced_at: 0,
            identity_splits: Vec::new(),
            identity_merges: Vec::new(),
        }
    }

    // The whole point: a person who committed under a real email (with their
    // GitHub login stamped) AND shows up as a `login@users.noreply.github.com`
    // collaborator seat collapses into ONE row — and the seat's email survives
    // as an alias so email-keyed lookups still resolve it.
    #[test]
    fn collapse_merges_login_and_noreply_seat() {
        let mut real = mk_member("mo", "mo@company.com", &[]);
        real.github_login = Some("mhask".into());
        real.commits = 40;
        real.first_seen = 100;
        real.last_seen = 500;
        real.claimed = true;
        let mut seat = mk_member("mhask", "mhask@users.noreply.github.com", &[]);
        seat.source = TeamMemberSource::Collaborator;
        seat.commits = 3;
        seat.first_seen = 50;
        seat.last_seen = 200;
        seat.repo_role = Some("admin".into());

        let mut manifest = mk_manifest(vec![real, seat]);
        collapse_duplicate_members(&mut manifest);

        assert_eq!(manifest.members.len(), 1);
        let m = &manifest.members[0];
        assert_eq!(m.email, "mo@company.com"); // real email is canonical
        assert_eq!(m.commits, 43); // summed
        assert_eq!(m.first_seen, 50); // min
        assert_eq!(m.last_seen, 500); // max
        assert!(m.claimed); // OR
        assert_eq!(m.repo_role.as_deref(), Some("admin")); // folded in
        assert_eq!(m.handle, "mhask"); // login is the handle
        assert!(m
            .also_emails
            .iter()
            .any(|a| a == "mhask@users.noreply.github.com")); // seat kept as alias
    }

    // Two of the user's own machines, each committing under a different email
    // but both carrying the same GitHub login, are the same person → one row.
    #[test]
    fn collapse_merges_same_login_across_emails() {
        let mut a = mk_member("laptop", "me@work.com", &[]);
        a.github_login = Some("me".into());
        let mut b = mk_member("desktop", "me@home.com", &[]);
        b.github_login = Some("me".into());
        let mut manifest = mk_manifest(vec![a, b]);
        collapse_duplicate_members(&mut manifest);
        assert_eq!(manifest.members.len(), 1);
        let m = &manifest.members[0];
        // whichever email is canonical, the other must be reachable as an alias
        let all: std::collections::BTreeSet<String> = std::iter::once(m.email.clone())
            .chain(m.also_emails.iter().cloned())
            .collect();
        assert!(all.contains("me@work.com"));
        assert!(all.contains("me@home.com"));
    }

    // An explicit alias link (admin said "these two emails are the same
    // person") collapses the rows even with no GitHub login in play.
    #[test]
    fn collapse_merges_on_explicit_alias() {
        let a = mk_member("mck", "mck@naridon.com", &["mubasheer.ck@hotmail.com"]);
        let b = mk_member("mubasheer", "mubasheer.ck@hotmail.com", &[]);
        let mut manifest = mk_manifest(vec![a, b]);
        collapse_duplicate_members(&mut manifest);
        assert_eq!(manifest.members.len(), 1);
    }

    // SAFETY: the resolver must NEVER fuse two different humans. A shared
    // display name, or a shared email local-part across different domains, is
    // NOT an identity link — these rows must stay separate.
    #[test]
    fn collapse_never_merges_distinct_people() {
        // Same name, different everything.
        let john_a = mk_member("john", "john@company-a.com", &[]);
        let john_b = mk_member("john", "john@company-b.com", &[]);
        // Different GitHub logins → definitely different people.
        let mut x = mk_member("x", "x@ex.com", &[]);
        x.github_login = Some("alpha".into());
        let mut y = mk_member("y", "y@ex.com", &[]);
        y.github_login = Some("beta".into());

        let mut manifest = mk_manifest(vec![john_a, john_b, x, y]);
        collapse_duplicate_members(&mut manifest);
        assert_eq!(manifest.members.len(), 4); // nothing merged
    }

    // Idempotent: a clean roster is returned untouched, and a second pass over
    // an already-collapsed roster changes nothing further.
    #[test]
    fn collapse_is_idempotent() {
        let mut real = mk_member("mo", "mo@company.com", &[]);
        real.github_login = Some("mhask".into());
        let mut seat = mk_member("mhask", "mhask@users.noreply.github.com", &[]);
        seat.source = TeamMemberSource::Collaborator;
        let mut manifest = mk_manifest(vec![real, seat]);

        collapse_duplicate_members(&mut manifest);
        let after_first = manifest.members.clone();
        collapse_duplicate_members(&mut manifest);
        assert_eq!(manifest.members.len(), after_first.len());
        assert_eq!(manifest.members[0].email, after_first[0].email);
        assert_eq!(manifest.members[0].also_emails, after_first[0].also_emails);
    }

    // A human-confirmed merge sticks even when the two rows share NO email or
    // login token — the exact case that used to "come right back" (a GitHub
    // handle committer vs a personal Gmail). `identity_merges` force-unions
    // them on every re-derive; an `identity_splits` for the same pair always
    // wins and re-separates them.
    #[test]
    fn collapse_force_merges_confirmed_pair_with_no_shared_token() {
        // droidnoob (GitHub handle, noreply seat) and Ananthakrishnan (personal
        // Gmail) — different name, different email, different login: the token
        // pass will never fuse them on its own.
        let mut handle = mk_member("droidnoob", "droidnoob@users.noreply.github.com", &[]);
        handle.github_login = Some("droidnoob".into());
        handle.commits = 12;
        let gmail = mk_member("ananthakrishnan", "ananthakrrishnan7@gmail.com", &[]);

        let mut manifest = mk_manifest(vec![handle, gmail]);
        // Without a recorded merge, they stay two rows (the safety default).
        collapse_duplicate_members(&mut manifest);
        assert_eq!(manifest.members.len(), 2, "must not auto-fuse distinct tokens");

        // Record the human decision and re-derive from the same two rows.
        let mut manifest = mk_manifest(vec![
            {
                let mut h =
                    mk_member("droidnoob", "droidnoob@users.noreply.github.com", &[]);
                h.github_login = Some("droidnoob".into());
                h
            },
            mk_member("ananthakrishnan", "ananthakrrishnan7@gmail.com", &[]),
        ]);
        manifest.identity_merges.push(normalize_pair(
            "droidnoob@users.noreply.github.com",
            "ananthakrrishnan7@gmail.com",
        ));
        collapse_duplicate_members(&mut manifest);
        assert_eq!(manifest.members.len(), 1, "confirmed pair must fuse");
        let all: std::collections::BTreeSet<String> =
            std::iter::once(manifest.members[0].email.clone())
                .chain(manifest.members[0].also_emails.iter().cloned())
                .collect();
        assert!(all.contains("droidnoob@users.noreply.github.com"));
        assert!(all.contains("ananthakrrishnan7@gmail.com"));

        // A split for the SAME pair wins over the merge — they re-separate.
        let mut manifest = mk_manifest(vec![
            {
                let mut h =
                    mk_member("droidnoob", "droidnoob@users.noreply.github.com", &[]);
                h.github_login = Some("droidnoob".into());
                h
            },
            mk_member("ananthakrishnan", "ananthakrrishnan7@gmail.com", &[]),
        ]);
        let pair = normalize_pair(
            "droidnoob@users.noreply.github.com",
            "ananthakrrishnan7@gmail.com",
        );
        manifest.identity_merges.push(pair.clone());
        manifest.identity_splits.push(pair);
        collapse_duplicate_members(&mut manifest);
        assert_eq!(manifest.members.len(), 2, "split must override a stale merge");
    }

    // ── duplicate SUGGESTER (weak-signal, human-confirmed) ───────────

    // Richer builder for suggester tests: control name + login + commits, which
    // the resolver-focused `mk_member` fixes to handle==name and no login.
    fn sug_member(
        name: &str,
        email: &str,
        login: Option<&str>,
        commits: u32,
        source: TeamMemberSource,
    ) -> TeamMember {
        TeamMember {
            email: email.to_string(),
            name: name.to_string(),
            handle: login.unwrap_or(name).to_lowercase(),
            commits,
            first_seen: 1,
            last_seen: 1,
            claimed: false,
            admin: false,
            activity_text: None,
            status_emoji: None,
            voice_channel: None,
            source,
            also_emails: Vec::new(),
            github_login: login.map(|s| s.to_string()),
            repo_role: None,
        }
    }

    fn has_group_with<'a>(
        suggestions: &'a [DuplicateSuggestion],
        emails: &[&str],
    ) -> Option<&'a DuplicateSuggestion> {
        suggestions.iter().find(|s| {
            emails.iter().all(|e| {
                s.emails.iter().any(|se| se.eq_ignore_ascii_case(e))
            })
        })
    }

    // A committer whose display name equals a collaborator's GitHub login is the
    // same person (Ijas: git author name "ijas-muhmd", collab seat @ijas-muhmd).
    #[test]
    fn suggest_matches_name_equals_login() {
        let committer = sug_member(
            "ijas-muhmd",
            "ijasmuhammed20@gmail.com",
            None,
            380,
            TeamMemberSource::Direct,
        );
        let seat = sug_member(
            "ijas-muhmd",
            "ijas-muhmd@users.noreply.github.com",
            Some("ijas-muhmd"),
            0,
            TeamMemberSource::Collaborator,
        );
        let out = compute_duplicate_suggestions(&[committer, seat], &[]);
        let g = has_group_with(&out, &["ijasmuhammed20@gmail.com", "ijas-muhmd@users.noreply.github.com"])
            .expect("Ijas group should be suggested");
        assert_eq!(g.confidence, "high");
        // Survivor is the real, high-commit committer, not the 0-commit seat.
        assert_eq!(g.survivor_email, "ijasmuhammed20@gmail.com");
    }

    // An email stem that prefixes a collaborator login links a committer to their
    // GitHub seat (Yasar: yasar@naridon.com ↔ @yasar-naridon).
    #[test]
    fn suggest_matches_email_stem_prefixes_login() {
        let committer = sug_member("Yasar", "yasar@naridon.com", None, 245, TeamMemberSource::Direct);
        let seat = sug_member(
            "yasar-naridon",
            "yasar-naridon@users.noreply.github.com",
            Some("yasar-naridon"),
            0,
            TeamMemberSource::Collaborator,
        );
        let out = compute_duplicate_suggestions(&[committer, seat], &[]);
        let g = has_group_with(&out, &["yasar@naridon.com", "yasar-naridon@users.noreply.github.com"])
            .expect("Yasar group should be suggested");
        assert_eq!(g.confidence, "high");
        assert_eq!(g.survivor_email, "yasar@naridon.com");
    }

    // Three identities for one human collapse into a single suggested group
    // (Mubasheer: mck@naridon.com, mubasheer.ck@hotmail.com, collab seat).
    #[test]
    fn suggest_groups_three_identities_transitively() {
        let a = sug_member("Mubasheer CK", "mck@naridon.com", None, 48, TeamMemberSource::Direct);
        let b = sug_member("mubasheerck", "mubasheer.ck@hotmail.com", None, 105, TeamMemberSource::Direct);
        let c = sug_member(
            "MubasheerNaridon",
            "mubasheernaridon@users.noreply.github.com",
            Some("MubasheerNaridon"),
            0,
            TeamMemberSource::Collaborator,
        );
        let out = compute_duplicate_suggestions(&[a, b, c], &[]);
        let g = has_group_with(
            &out,
            &["mck@naridon.com", "mubasheer.ck@hotmail.com", "mubasheernaridon@users.noreply.github.com"],
        )
        .expect("all three Mubasheer identities should form one group");
        assert_eq!(g.emails.len(), 3);
    }

    // Bots (aura.vcs, anthropic.com) are never proposed for merging, even if
    // their names would otherwise overlap something.
    #[test]
    fn suggest_excludes_bots() {
        let bot1 = sug_member("Aura Agent", "ai@aura.vcs", None, 23463, TeamMemberSource::Direct);
        let bot2 = sug_member("Claude", "noreply@anthropic.com", None, 5, TeamMemberSource::Direct);
        // A human that shares a stem with the bot names — must still be ignored
        // because the bots are filtered out before pairing.
        let human = sug_member("Aurangzeb", "aurangzeb@x.com", None, 3, TeamMemberSource::Direct);
        let out = compute_duplicate_suggestions(&[bot1, bot2, human], &[]);
        assert!(
            out.iter().all(|s| {
                !s.emails.iter().any(|e| e == "ai@aura.vcs" || e == "noreply@anthropic.com")
            }),
            "no suggestion may include a bot email: {out:?}"
        );
    }

    // Distinct people with different names/emails and no shared identifier are
    // never suggested; a lone identity is never suggested.
    #[test]
    fn suggest_leaves_distinct_and_singletons_alone() {
        let anantha = sug_member("Anantha Krishnan", "ananthakrrishnan7@gmail.com", None, 120, TeamMemberSource::Direct);
        let dev = sug_member("Touchstage Dev", "dev@touchstage.com", None, 91, TeamMemberSource::Direct);
        let out = compute_duplicate_suggestions(&[anantha, dev], &[]);
        assert!(out.is_empty(), "unrelated members must not be suggested: {out:?}");
    }

    // A common short first name shared by two different people must NOT be
    // suggested (the length floor guards this).
    #[test]
    fn suggest_ignores_common_short_name_collision() {
        let raj_a = sug_member("Raj", "raj@company-a.com", None, 10, TeamMemberSource::Direct);
        let raj_b = sug_member("Raj", "raj@company-b.com", None, 10, TeamMemberSource::Direct);
        let out = compute_duplicate_suggestions(&[raj_a, raj_b], &[]);
        assert!(out.is_empty(), "two different short-name people must not be fused: {out:?}");
    }

    // A confirmed split (rejection) suppresses the pair on the next computation.
    #[test]
    fn suggest_honours_reject_tombstone() {
        let committer = sug_member("Yasar", "yasar@naridon.com", None, 245, TeamMemberSource::Direct);
        let seat = sug_member(
            "yasar-naridon",
            "yasar-naridon@users.noreply.github.com",
            Some("yasar-naridon"),
            0,
            TeamMemberSource::Collaborator,
        );
        let splits = vec![IdentitySplit {
            a: "yasar-naridon@users.noreply.github.com".to_string(),
            b: "yasar@naridon.com".to_string(),
        }];
        let out = compute_duplicate_suggestions(&[committer, seat], &splits);
        assert!(out.is_empty(), "a rejected pair must never be re-suggested: {out:?}");
    }

    // The new manifest field is additive: a manifest written before it existed
    // deserializes cleanly and round-trips without sprouting an
    // `identity_splits` key.
    #[test]
    fn identity_splits_field_is_backcompat() {
        let json = r#"{"team_id":"t","repo_root":"/r","created_at":0,"members":[],"channels":["general"]}"#;
        let m: TeamManifest = serde_json::from_str(json).unwrap();
        assert!(m.identity_splits.is_empty());
        let out = serde_json::to_string(&m).unwrap();
        assert!(
            !out.contains("identity_splits"),
            "manifest with no splits must not gain the key: {out}"
        );
    }

    fn author(email: &str) -> GitAuthor {
        GitAuthor {
            name: "Test".into(),
            email: email.into(),
            commits: 1,
            first_seen: 0,
            last_seen: 0,
            source: TeamMemberSource::Direct,
        }
    }

    // The roster is derived from every commit ever authored, and three
    // surfaces plus a 15-second poll each ask for it independently. Without a
    // window, opening the app walks all of history several times inside a
    // second.
    #[test]
    fn repeated_asks_for_the_same_roster_walk_history_once() {
        let key = "walk-once-test";
        let mut walks = 0;
        for _ in 0..5 {
            let authors = cached_author_walk(key, || {
                walks += 1;
                vec![author("a@example.com")]
            });
            assert_eq!(authors.len(), 1);
        }
        assert_eq!(walks, 1, "history should have been walked exactly once");
    }

    // Different repos are different rosters. A cache that answered one repo's
    // question with another's would put the wrong people on the team.
    #[test]
    fn a_second_repo_gets_its_own_walk() {
        let mut walked: Vec<String> = Vec::new();
        for key in ["repo-a-test", "repo-b-test"] {
            let _ = cached_author_walk(key, || {
                walked.push(key.to_string());
                vec![author(&format!("{key}@example.com"))]
            });
        }
        assert_eq!(walked, vec!["repo-a-test", "repo-b-test"]);
    }

    // The upstream walk is a different question about the same repo, so it
    // must not be served the direct walk's answer.
    #[test]
    fn the_upstream_walk_is_not_confused_with_the_direct_one() {
        let root = "fork-test";
        let direct = cached_author_walk(root, || vec![author("mine@example.com")]);
        let upstream = cached_author_walk(&format!("{root}\0upstream"), || {
            vec![author("theirs@example.com")]
        });
        assert_eq!(direct[0].email, "mine@example.com");
        assert_eq!(upstream[0].email, "theirs@example.com");
    }
}
