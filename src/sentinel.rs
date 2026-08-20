//! Sentinel — the shared plane.
//!
//! Claims, zones and agent-to-agent messages exist to tell one agent what
//! another is doing. That only works if every checkout of the repository reads
//! and writes ONE set of them, so every path here resolves through
//! [`crate::worktree::paths::shared_aura_path`] (the repository root), not the
//! per-checkout private plane. Session state, transcripts and memory stay
//! private — see the module docs on `worktree::paths` for why the split runs
//! this way.
//!
//! Every record carries the worktree it came from, so the answer to "who holds
//! `resolve_handle`?" is "claude, in `barcelona`" rather than "someone".

use serde::{Deserialize, Serialize};
use std::fs;
use std::time::{SystemTime, UNIX_EPOCH};

use crate::worktree::paths::{repo_relative, shared_aura_path};

/// How long a claim file survives without a heartbeat before it is treated as
/// left behind by a crash. A live PID always wins over this — the timeout only
/// decides what to do about a file whose process is gone.
const ZOMBIE_CLAIM_SECS: u64 = 3600;

/// How long a zone survives when its owning session never wrote a claim file.
///
/// Deliberately much longer than [`ZOMBIE_CLAIM_SECS`]: a zone is a coarser and
/// more deliberate statement than a function claim ("this directory is mine for
/// this piece of work"), and the cost of expiring one early — a teammate edits
/// under you — is worse than the cost of holding it a while longer. Any real
/// activity from that session refreshes it through the claim-file path instead.
const ZONE_ORPHAN_MAX_SECS: u64 = 12 * 3600;

/// The symbol name a claim carries when the parser found no symbols to name —
/// a stylesheet, a config file, a language we don't parse. It means "all of
/// it", and it is deliberately path-free: the claim already records the file
/// repo-relative, and a marker that embedded the path would make the same file
/// look like a different symbol from every checkout, which is exactly the
/// cross-worktree collision [`FunctionClaim::file_path`] exists to catch.
pub const WHOLE_FILE: &str = "__file__";

/// What to show a person for a claim.
///
/// Symbol claims read as themselves. A whole-file claim is an internal marker,
/// and printing `__file__/Users/someone/checkout/app.css` at a teammate tells
/// them nothing they can act on — name the file instead, and say it's the whole
/// thing. Claims written before the marker was path-free carry the path inside
/// the name, so read it from there when it's present.
pub fn claim_label(function_name: &str, file_path: &str) -> String {
    let Some(legacy_path) = function_name.strip_prefix(WHOLE_FILE) else {
        return function_name.to_string();
    };
    let path = if legacy_path.is_empty() {
        file_path
    } else {
        legacy_path
    };
    let name = std::path::Path::new(path)
        .file_name()
        .and_then(|n| n.to_str())
        .unwrap_or(path);
    format!("{name} (whole file)")
}

// ── Data structures ──

#[derive(Serialize, Deserialize, Clone, Debug)]
pub struct FunctionClaim {
    /// Repository-relative. Absolute paths carry the checkout they were
    /// recorded in, which would make the same file look like two different
    /// files to two worktrees and hide every cross-worktree collision.
    pub file_path: String,
    pub function_name: String,
    pub node_id: Option<String>,
    pub claimed_at: u64,
}

#[derive(Serialize, Deserialize, Clone, Debug)]
pub struct SentinelClaims {
    pub session_id: String,
    pub agent_id: String,
    pub pid: u32,
    pub last_heartbeat: u64,
    pub claims: Vec<FunctionClaim>,
    /// Checkout this session is working in. `None` = the main checkout (also
    /// what records written before the shared plane existed deserialize to).
    #[serde(default)]
    pub worktree: Option<String>,
    /// Branch that checkout was on when the claim was last written.
    #[serde(default)]
    pub branch: Option<String>,
}

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
pub enum ZoneMode {
    Warn,
    Block,
}

#[derive(Serialize, Deserialize, Clone, Debug)]
pub struct ZoneRule {
    pub zone_id: String,
    pub session_id: String,
    pub patterns: Vec<String>,
    pub mode: ZoneMode,
    /// Checkout the zone was claimed from. `None` = the main checkout.
    #[serde(default)]
    pub worktree: Option<String>,
    /// When the zone was claimed. `0` for records written before zones were
    /// dated — [`SentinelManager::zone_claimed_at`] falls back to the file's
    /// mtime for those, because the filesystem still knows even when the
    /// record doesn't.
    #[serde(default)]
    pub claimed_at: u64,
}

/// A zone as a person needs to see it: the rule, plus whether it still binds
/// anyone and why.
#[derive(Clone, Debug)]
pub struct ZoneView {
    pub zone: ZoneRule,
    /// Enforced right now — what [`SentinelManager::check_zone`] would honour.
    pub live: bool,
    /// How long ago it was claimed.
    pub age_secs: u64,
    /// `None` when the owning session never wrote a claim file, which is the
    /// ordinary case for a session that claimed a zone and then thought for a
    /// while. Distinct from `Some(false)`, which means the session is on record
    /// and gone.
    pub owner_alive: Option<bool>,
    /// Checkout the owning session works in, when it is on record.
    pub owner_worktree: Option<String>,
}

#[derive(Serialize, Deserialize, Clone, Debug)]
pub struct Collision {
    pub file_path: String,
    pub function_name: String,
    pub held_by_session: String,
    pub held_by_agent: String,
    /// Checkout the other agent is holding it from. `None` = main checkout.
    #[serde(default)]
    pub held_by_worktree: Option<String>,
}

// ── Messaging ──

#[derive(Serialize, Deserialize, Clone, Debug)]
pub struct SentinelMessage {
    pub id: String,
    pub from_session: String,
    pub from_agent: String,
    pub to_session: Option<String>,  // None = broadcast to all
    pub content: String,
    pub timestamp: u64,
    pub read_by: Vec<String>,        // session_ids that have read this
    /// Checkout the sender is working in, so the reader knows where the
    /// message came from without looking the session up.
    #[serde(default)]
    pub from_worktree: Option<String>,
    /// Set when the message was addressed to a checkout rather than a single
    /// session ("whoever is working in `barcelona`").
    #[serde(default)]
    pub to_worktree: Option<String>,
    /// Set when the message was addressed to a kind of agent rather than to
    /// everyone in the checkout ("codex in `auckland`"). A checkout commonly
    /// runs several agents at once — Claude on the feature, Codex on the
    /// tests — and telling all of them to stop touching a file when you meant
    /// one of them is how a coordination channel becomes noise people ignore.
    ///
    /// Combines with [`Self::to_worktree`]: both set means "that agent, in
    /// that checkout"; agent alone means "every Codex, wherever it is".
    #[serde(default)]
    pub to_agent: Option<String>,
}

/// Who a message is for.
///
/// Three independent narrowings — a session id, a checkout, a kind of agent —
/// that AND together. Grouped into a struct rather than three more positional
/// `Option<&str>` parameters because at the call site
/// `send_message_to(a, b, None, None, Some("codex"), msg)` is unreadable and
/// one slipped argument silently misroutes the message.
#[derive(Default, Clone, Debug)]
pub struct Address {
    /// One exact session. The narrowest form, and the one you rarely have.
    pub session: Option<String>,
    /// A checkout by name; `main` for the main checkout.
    pub worktree: Option<String>,
    /// An agent by name — `claude`, `codex`, `gemini`.
    pub agent: Option<String>,
}

impl Address {
    /// Everyone, everywhere.
    pub fn broadcast() -> Self {
        Self::default()
    }

    /// Parse the shorthand an agent actually types: `codex@auckland`,
    /// `auckland`, or `codex`.
    ///
    /// A bare word is ambiguous, so it is resolved against the live plane
    /// rather than guessed: if a checkout by that name exists it is a
    /// checkout, otherwise it is an agent. That way `main` and `auckland`
    /// address trees, `codex` addresses agents, and neither needs a flag.
    pub fn parse(spec: &str) -> Self {
        let spec = spec.trim();
        if let Some((agent, worktree)) = spec.split_once('@') {
            return Self {
                session: None,
                worktree: non_empty(worktree),
                agent: non_empty(agent),
            };
        }
        if spec.is_empty() {
            return Self::broadcast();
        }
        if Self::names_a_checkout(spec) {
            Self {
                session: None,
                worktree: Some(spec.to_string()),
                agent: None,
            }
        } else {
            Self {
                session: None,
                worktree: None,
                agent: Some(spec.to_string()),
            }
        }
    }

    /// Does `name` name a checkout of this repository? `main` always does.
    fn names_a_checkout(name: &str) -> bool {
        if name.eq_ignore_ascii_case("main") {
            return true;
        }
        crate::worktree::discover::checkout_names()
            .iter()
            .any(|w| w.eq_ignore_ascii_case(name))
    }

    /// Human-readable target, for the line the CLI prints back.
    pub fn describe(&self) -> String {
        match (&self.session, &self.agent, &self.worktree) {
            (Some(s), _, _) => format!("session {s}"),
            (None, Some(a), Some(w)) => format!("{a} in {w}"),
            (None, Some(a), None) => format!("every {a}"),
            (None, None, Some(w)) => w.clone(),
            (None, None, None) => "everyone".to_string(),
        }
    }

    fn is_broadcast(&self) -> bool {
        self.session.is_none() && self.worktree.is_none() && self.agent.is_none()
    }
}

fn non_empty(s: &str) -> Option<String> {
    let s = s.trim();
    if s.is_empty() {
        None
    } else {
        Some(s.to_string())
    }
}

// ── Manager ──

pub struct SentinelManager;

impl SentinelManager {
    pub(crate) fn claims_dir() -> String {
        shared_aura_path("sentinel/claims")
    }

    pub(crate) fn zones_dir() -> String {
        shared_aura_path("sentinel/zones")
    }

    fn collisions_marker() -> String {
        shared_aura_path("sentinel/collisions_pending")
    }

    pub(crate) fn messages_dir() -> String {
        shared_aura_path("sentinel/messages")
    }

    fn unread_marker() -> String {
        shared_aura_path("sentinel/unread_pending")
    }

    fn ensure_dirs() {
        let _ = fs::create_dir_all(Self::claims_dir());
        let _ = fs::create_dir_all(Self::zones_dir());
        let _ = fs::create_dir_all(Self::messages_dir());
        // Claims/zones/messages written while sentinel was still per-checkout
        // are folded into the shared set on first touch, so nobody loses the
        // work they had in flight when they upgrade.
        crate::worktree::migrate::adopt_legacy_sentinel_state();
    }

    /// The checkout this process is running in — stamped onto everything it
    /// writes so peers can attribute it.
    fn here() -> Option<String> {
        crate::worktree::paths::current_worktree()
    }

    fn here_branch() -> Option<String> {
        let b = crate::live_events::current_branch();
        if b.is_empty() { None } else { Some(b) }
    }

    fn now() -> u64 {
        SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap_or_default()
            .as_secs()
    }

    fn claim_path(session_id: &str) -> String {
        format!("{}/{}.json", Self::claims_dir(), session_id)
    }

    /// Atomic write: write to tmp then rename
    fn atomic_write(path: &str, data: &[u8]) -> Result<(), String> {
        let tmp = format!("{}.tmp", path);
        fs::write(&tmp, data).map_err(|e| format!("Write error: {}", e))?;
        fs::rename(&tmp, path).map_err(|e| format!("Rename error: {}", e))?;
        Ok(())
    }

    /// Load all claim files (one per session), across every checkout of the
    /// repository. Public so the worktree control plane can group them.
    pub fn load_all_claims() -> Vec<SentinelClaims> {
        let dir = Self::claims_dir();
        let mut all = Vec::new();
        if let Ok(entries) = fs::read_dir(&dir) {
            for entry in entries.flatten() {
                if entry.path().extension().map(|x| x == "json").unwrap_or(false) {
                    if let Ok(content) = fs::read_to_string(entry.path()) {
                        if let Ok(claims) = serde_json::from_str::<SentinelClaims>(&content) {
                            all.push(claims);
                        }
                    }
                }
            }
        }
        all
    }

    /// Check if a PID is still alive
    pub(crate) fn is_pid_alive(pid: u32) -> bool {
        use sysinfo::System;
        let mut sys = System::new();
        sys.refresh_processes(sysinfo::ProcessesToUpdate::Some(&[sysinfo::Pid::from_u32(pid)]), true);
        sys.process(sysinfo::Pid::from_u32(pid)).is_some()
    }

    /// Remove claims for dead processes, and zones whose owner is gone.
    /// PID alive = keep (even if idle). PID dead = remove.
    /// Heartbeat staleness ([`ZOMBIE_CLAIM_SECS`]) is only a fallback for
    /// zombie claim files.
    pub fn cleanup_stale() -> usize {
        Self::ensure_dirs();
        let now = Self::now();
        let zombie_threshold = ZOMBIE_CLAIM_SECS;
        let mut removed = 0;

        let all = Self::load_all_claims();
        for claims in &all {
            let pid_dead = !Self::is_pid_alive(claims.pid);
            let zombie = now - claims.last_heartbeat > zombie_threshold;
            // Remove if PID is dead, or if heartbeat is ancient (zombie file from crash)
            if pid_dead || zombie {
                let path = Self::claim_path(&claims.session_id);
                let _ = fs::remove_file(&path);
                removed += 1;
            }
        }

        // Zones outlive the claims beside them unless something sweeps them:
        // claiming a zone doesn't write a claim file, so the loop above never
        // sees one. This is where a zone whose session died actually leaves.
        removed += Self::prune_dead_zones();

        if removed > 0 {
            Self::update_collision_marker();
        }
        removed
    }

    /// Claim functions in a file for a session. Returns any collisions found.
    pub fn claim_functions(
        session_id: &str,
        agent_id: &str,
        pid: u32,
        file_path: &str,
        functions: &[String],
    ) -> Vec<Collision> {
        Self::ensure_dirs();

        // Keyed repo-relative so a claim made in one checkout matches the same
        // file seen from another.
        let file_path = &repo_relative(file_path);

        let blank = || SentinelClaims {
            session_id: session_id.to_string(),
            agent_id: agent_id.to_string(),
            pid,
            last_heartbeat: Self::now(),
            claims: Vec::new(),
            worktree: Self::here(),
            branch: Self::here_branch(),
        };

        // Load existing claims for this session
        let path = Self::claim_path(session_id);
        let mut my_claims = fs::read_to_string(&path)
            .ok()
            .and_then(|c| serde_json::from_str::<SentinelClaims>(&c).ok())
            .unwrap_or_else(blank);

        // Check for collisions against other sessions
        let others = Self::load_all_claims();
        let mut collisions = Vec::new();

        for func_name in functions {
            for other in &others {
                if other.session_id == session_id {
                    continue;
                }
                for claim in &other.claims {
                    if claim.file_path == *file_path && claim.function_name == *func_name {
                        collisions.push(Collision {
                            file_path: file_path.to_string(),
                            function_name: func_name.clone(),
                            held_by_session: other.session_id.clone(),
                            held_by_agent: other.agent_id.clone(),
                            held_by_worktree: other.worktree.clone(),
                        });
                    }
                }
            }

            // Add/update our claim
            let already = my_claims.claims.iter().any(|c| {
                c.file_path == *file_path && c.function_name == *func_name
            });
            if !already {
                my_claims.claims.push(FunctionClaim {
                    file_path: file_path.to_string(),
                    function_name: func_name.clone(),
                    node_id: None,
                    claimed_at: Self::now(),
                });
            }
        }

        // Drop any symbol this record holds twice. The push above already
        // guards against it, but a record written by an older build or by two
        // writers racing can carry a duplicate, and a session that appears to
        // hold the same symbol twice reads downstream as two agents colliding.
        // Self-healing on write, so the bad row disappears the next time the
        // session claims anything.
        let mut seen = std::collections::HashSet::new();
        my_claims
            .claims
            .retain(|c| seen.insert((c.file_path.clone(), c.function_name.clone())));

        // Update heartbeat and write. Re-stamp the checkout every time: a
        // session file written by an older build carries no worktree, and a
        // resumed session can legitimately move between checkouts.
        my_claims.last_heartbeat = Self::now();
        my_claims.worktree = Self::here();
        my_claims.branch = Self::here_branch();
        if let Ok(json) = serde_json::to_string_pretty(&my_claims) {
            let _ = Self::atomic_write(&path, json.as_bytes());
        }

        // Update collision marker
        Self::update_collision_marker();

        collisions
    }

    /// Release all claims for a session
    pub fn release_claims(session_id: &str) {
        let path = Self::claim_path(session_id);
        let _ = fs::remove_file(&path);
        Self::update_collision_marker();
    }

    /// Release claims for a specific file within a session
    pub fn release_file_claims(session_id: &str, file_path: &str) {
        let file_path = repo_relative(file_path);
        let path = Self::claim_path(session_id);
        if let Ok(content) = fs::read_to_string(&path) {
            if let Ok(mut claims) = serde_json::from_str::<SentinelClaims>(&content) {
                claims.claims.retain(|c| c.file_path != file_path);
                claims.last_heartbeat = Self::now();
                if let Ok(json) = serde_json::to_string_pretty(&claims) {
                    let _ = Self::atomic_write(&path, json.as_bytes());
                }
            }
        }
        Self::update_collision_marker();
    }

    /// Check if a file falls within any zone claimed by another *live* session
    /// — including a session in a different checkout, which is the point: a
    /// zone that only protected the worktree that declared it protected
    /// nothing.
    ///
    /// Liveness is the whole difference between a zone and a nuisance. Zones
    /// used to be honoured forever, so a claim made in May was still warning on
    /// every snapshot in August, from a session that no longer existed. A
    /// warning that never goes away isn't a signal — it teaches everyone on the
    /// team to click past the one that matters. See [`Self::zone_is_live`].
    pub fn check_zone(session_id: &str, file_path: &str) -> Option<ZoneRule> {
        let file_path = repo_relative(file_path);
        for zone in Self::live_zones() {
            if zone.session_id == session_id {
                continue; // Own zone
            }
            for pattern in &zone.patterns {
                if file_matches_pattern(&file_path, pattern) {
                    return Some(zone);
                }
            }
        }
        None
    }

    /// When a zone was claimed, in epoch seconds.
    ///
    /// Zones written before they carried a date deserialize to `0`. Reading
    /// that as "claimed in 1970" would expire every legacy zone the instant
    /// this shipped, and reading it as "no date, so assume fresh" would keep
    /// them forever. The file's mtime is the honest third answer: it is real
    /// evidence of when the claim was made, and it is what the record would
    /// have said if it had been dated.
    fn zone_claimed_at(zone: &ZoneRule) -> u64 {
        if zone.claimed_at > 0 {
            return zone.claimed_at;
        }
        let path = format!("{}/{}.json", Self::zones_dir(), zone.zone_id);
        fs::metadata(&path)
            .and_then(|m| m.modified())
            .ok()
            .and_then(|t| t.duration_since(UNIX_EPOCH).ok())
            .map(|d| d.as_secs())
            .unwrap_or(0)
    }

    /// Is this zone still in force?
    ///
    /// Two signals, in order of how much they know:
    ///
    /// 1. The owning session's claim file. If it exists, that session's own
    ///    liveness decides — a live process holds its zone for as long as it
    ///    runs, and a dead one releases it. This is the same rule claims use,
    ///    so a zone and the claims beside it expire together.
    /// 2. Zone age. Claiming a zone writes no claim file, so a session that
    ///    declared "this directory is mine" and then thought for ten minutes
    ///    has no entry under signal 1. Expiring those immediately would break
    ///    the feature for its most ordinary use, so an owner with no claim file
    ///    keeps the zone until it is [`ZONE_ORPHAN_MAX_SECS`] old.
    ///
    /// The pathological case this closes: a zone whose session vanished months
    /// ago, still warning today, with no way to list or release it.
    pub fn zone_is_live(zone: &ZoneRule) -> bool {
        if let Some(claims) = Self::load_all_claims()
            .into_iter()
            .find(|c| c.session_id == zone.session_id)
        {
            let fresh = Self::now().saturating_sub(claims.last_heartbeat) <= ZOMBIE_CLAIM_SECS;
            return Self::is_pid_alive(claims.pid) || fresh;
        }
        Self::now().saturating_sub(Self::zone_claimed_at(zone)) <= ZONE_ORPHAN_MAX_SECS
    }

    /// Zones that are actually enforced right now.
    pub fn live_zones() -> Vec<ZoneRule> {
        Self::list_zones()
            .into_iter()
            .filter(Self::zone_is_live)
            .collect()
    }

    /// Every zone on disk, each with the reason it is or isn't in force.
    ///
    /// `live_zones` answers "what do I enforce"; this answers "what would I
    /// tell a person". They differ deliberately: someone asking why their edit
    /// was flagged needs to see the expired zone too, and be told it expired,
    /// rather than have it silently missing from a list that also silently
    /// stopped enforcing it.
    pub fn list_zone_views() -> Vec<ZoneView> {
        let now = Self::now();
        let claims = Self::load_all_claims();
        Self::list_zones()
            .into_iter()
            .map(|zone| {
                let owner = claims.iter().find(|c| c.session_id == zone.session_id);
                let owner_alive = owner.map(|c| {
                    Self::is_pid_alive(c.pid)
                        || now.saturating_sub(c.last_heartbeat) <= ZOMBIE_CLAIM_SECS
                });
                ZoneView {
                    live: Self::zone_is_live(&zone),
                    age_secs: now.saturating_sub(Self::zone_claimed_at(&zone)),
                    owner_alive,
                    owner_worktree: owner.and_then(|c| c.worktree.clone()),
                    zone,
                }
            })
            .collect()
    }

    /// The caller's *own* live zone covering this file, if any.
    ///
    /// [`Self::check_zone`] deliberately skips your own zones — you are not
    /// blocked by yourself — so "no zone" from it means two different things.
    /// This separates them, so a listing can say "yours" instead of "none".
    pub fn own_zone(session_id: &str, file_path: &str) -> Option<ZoneRule> {
        let file_path = repo_relative(file_path);
        Self::live_zones().into_iter().find(|z| {
            z.session_id == session_id
                && z.patterns.iter().any(|p| file_matches_pattern(&file_path, p))
        })
    }

    /// Who to record as the owner when a command runs outside an agent
    /// session — a plain `aura team zones claim` in a terminal.
    ///
    /// The old answer was the literal string `unknown`, which is worse than it
    /// looks: two people claiming zones from two checkouts both became
    /// `unknown`, and `check_zone` skips zones owned by your own session. Each
    /// would have been silently exempt from the other's zone — the exact
    /// collision the feature exists to catch. Keying on the checkout gives a
    /// distinct owner per working copy, and reads properly in a listing.
    pub fn cli_session_id() -> String {
        match Self::here() {
            Some(w) => format!("cli:{w}"),
            None => "cli:main".to_string(),
        }
    }

    /// Release one zone by id, whoever owns it. Returns false if there was no
    /// such zone — the caller can then say so instead of reporting success.
    pub fn release_zone(zone_id: &str) -> bool {
        let path = format!("{}/{}.json", Self::zones_dir(), zone_id);
        fs::remove_file(&path).is_ok()
    }

    /// Delete zones whose owner is gone. Returns how many were removed.
    ///
    /// Separate from filtering because the two answer different questions:
    /// `live_zones` decides what to enforce on this call, and this decides what
    /// to stop carrying around. A read path that deletes is a read path that
    /// surprises people.
    pub fn prune_dead_zones() -> usize {
        let mut removed = 0;
        for zone in Self::list_zones() {
            if !Self::zone_is_live(&zone) {
                let path = format!("{}/{}.json", Self::zones_dir(), zone.zone_id);
                if fs::remove_file(&path).is_ok() {
                    removed += 1;
                }
            }
        }
        removed
    }

    /// Update heartbeat for a session
    pub fn update_heartbeat(session_id: &str) {
        let path = Self::claim_path(session_id);
        if let Ok(content) = fs::read_to_string(&path) {
            if let Ok(mut claims) = serde_json::from_str::<SentinelClaims>(&content) {
                claims.last_heartbeat = Self::now();
                if let Ok(json) = serde_json::to_string_pretty(&claims) {
                    let _ = Self::atomic_write(&path, json.as_bytes());
                }
            }
        }
    }

    /// Get full sentinel status for a session
    pub fn get_status(session_id: &str) -> serde_json::Value {
        Self::ensure_dirs();
        let all = Self::load_all_claims();

        let own = all.iter().find(|c| c.session_id == session_id);
        let others: Vec<&SentinelClaims> = all.iter()
            .filter(|c| c.session_id != session_id)
            .collect();

        // Compute collisions
        let mut collisions = Vec::new();
        if let Some(mine) = own {
            for my_claim in &mine.claims {
                for other in &others {
                    for their_claim in &other.claims {
                        if my_claim.file_path == their_claim.file_path
                            && my_claim.function_name == their_claim.function_name
                        {
                            collisions.push(serde_json::json!({
                                "file": my_claim.file_path,
                                "function": my_claim.function_name,
                                "held_by_session": other.session_id,
                                "held_by_agent": other.agent_id,
                                "held_by_worktree": other.worktree,
                                "held_by_branch": other.branch,
                                // A collision inside one checkout is two agents
                                // in the same tree; across checkouts it is two
                                // branches heading for the same merge.
                                "cross_worktree": other.worktree != mine.worktree,
                            }));
                        }
                    }
                }
            }
        }

        let zones = Self::live_zones();

        serde_json::json!({
            "session_id": session_id,
            "own_claims": own.map(|c| &c.claims).unwrap_or(&Vec::new())
                .iter()
                .map(|c| serde_json::json!({
                    "file": c.file_path,
                    "function": c.function_name,
                    "claimed_at": c.claimed_at,
                }))
                .collect::<Vec<_>>(),
            "other_sessions": others.iter().map(|o| serde_json::json!({
                "session_id": o.session_id,
                "agent_id": o.agent_id,
                "pid": o.pid,
                "claim_count": o.claims.len(),
                "last_heartbeat": o.last_heartbeat,
                "worktree": o.worktree,
                "branch": o.branch,
            })).collect::<Vec<_>>(),
            "collisions": collisions,
            // Live only. Status is read to answer "what is in force right
            // now", and listing an expired zone there is how a dead claim gets
            // treated as a live one by whoever reads it next.
            "zones": zones.iter().map(|z| serde_json::json!({
                "zone_id": z.zone_id,
                "session_id": z.session_id,
                "patterns": z.patterns,
                "mode": format!("{:?}", z.mode),
                "worktree": z.worktree,
                "claimed_at": Self::zone_claimed_at(z),
            })).collect::<Vec<_>>(),
            "total_active_sessions": all.len(),
            "worktree": own.and_then(|c| c.worktree.clone()),
        })
    }

    /// Create a zone rule
    pub fn create_zone(session_id: &str, patterns: Vec<String>, mode: ZoneMode) -> ZoneRule {
        Self::ensure_dirs();
        let zone_id = format!("zone-{}", &uuid::Uuid::new_v4().to_string()[..8]);
        let zone = ZoneRule {
            zone_id: zone_id.clone(),
            session_id: session_id.to_string(),
            patterns,
            mode,
            worktree: Self::here(),
            claimed_at: Self::now(),
        };
        let path = format!("{}/{}.json", Self::zones_dir(), zone_id);
        if let Ok(json) = serde_json::to_string_pretty(&zone) {
            let _ = Self::atomic_write(&path, json.as_bytes());
        }
        zone
    }

    /// List all active zones
    pub fn list_zones() -> Vec<ZoneRule> {
        let dir = Self::zones_dir();
        let mut zones = Vec::new();
        if let Ok(entries) = fs::read_dir(&dir) {
            for entry in entries.flatten() {
                if entry.path().extension().map(|x| x == "json").unwrap_or(false) {
                    if let Ok(content) = fs::read_to_string(entry.path()) {
                        if let Ok(zone) = serde_json::from_str::<ZoneRule>(&content) {
                            zones.push(zone);
                        }
                    }
                }
            }
        }
        zones
    }

    // ── Messaging ──

    /// Canonical token for addressing a checkout. The main checkout has no
    /// worktree name, so it answers to the literal `main`.
    pub fn worktree_token(worktree: Option<&str>) -> String {
        worktree.unwrap_or("main").to_string()
    }

    /// The claim record for one session, if it has ever claimed anything.
    fn load_claims(session_id: &str) -> Option<SentinelClaims> {
        fs::read_to_string(Self::claim_path(session_id))
            .ok()
            .and_then(|c| serde_json::from_str::<SentinelClaims>(&c).ok())
    }

    /// Which checkout a session is working in, read from its claim file.
    pub fn worktree_of_session(session_id: &str) -> Option<String> {
        Self::load_claims(session_id).and_then(|c| c.worktree)
    }

    /// Which checkout to judge a session's mail against.
    ///
    /// A session in the main checkout records `worktree: None`, which reads
    /// identically to "this session has no record at all" — so presence of the
    /// *file* is what decides, not the field. Only a session we have never
    /// seen falls back to this process's checkout, which is what lets an agent
    /// receive mail before its first claim lands. The distinction matters
    /// because the control plane reads every session's inbox from whichever
    /// checkout the command happened to run in.
    fn worktree_context(session_id: &str) -> Option<String> {
        match Self::load_claims(session_id) {
            Some(c) => c.worktree,
            None => Self::here(),
        }
    }

    /// Every session currently claiming work from `worktree` (use `main` for
    /// the main checkout). This is how "message whoever is in barcelona"
    /// resolves to real recipients.
    pub fn sessions_in_worktree(worktree: &str) -> Vec<SentinelClaims> {
        Self::load_all_claims()
            .into_iter()
            .filter(|c| Self::worktree_token(c.worktree.as_deref()).eq_ignore_ascii_case(worktree))
            .collect()
    }

    /// Every live session an [`Address`] resolves to, right now.
    ///
    /// This is what makes "delivered to nobody" visible: an agent that thinks
    /// it has coordinated when it hasn't is worse than one that knows it
    /// hasn't. A session id addresses exactly itself whether or not it has
    /// claimed anything yet, so it counts as one either way.
    pub fn sessions_matching(addr: &Address) -> Vec<SentinelClaims> {
        if let Some(sid) = &addr.session {
            return Self::load_all_claims()
                .into_iter()
                .filter(|c| &c.session_id == sid)
                .collect();
        }
        Self::load_all_claims()
            .into_iter()
            .filter(|c| {
                let wt_ok = addr.worktree.as_deref().is_none_or(|w| {
                    Self::worktree_token(c.worktree.as_deref()).eq_ignore_ascii_case(w)
                });
                let agent_ok = addr
                    .agent
                    .as_deref()
                    .is_none_or(|a| Self::agent_matches(&c.agent_id, a));
                wt_ok && agent_ok
            })
            .collect()
    }

    /// Does a session's recorded agent id answer to the name `want`?
    ///
    /// Agent ids in the wild are not tidy — a Claude Code session records
    /// `claude`, but a spawned one can carry a suffix (`claude-code`,
    /// `codex-cli`). Matching on the leading segment means `--to codex@auckland`
    /// reaches the Codex there without the sender having to know which
    /// variant of the name that particular launcher wrote down.
    fn agent_matches(agent_id: &str, want: &str) -> bool {
        let id = agent_id.to_ascii_lowercase();
        let want = want.trim().to_ascii_lowercase();
        if want.is_empty() {
            return true;
        }
        id == want || id.split(['-', '_', ':']).next() == Some(want.as_str())
    }

    /// Is this message meant for `session_id` — an agent named `my_agent`,
    /// sitting in `my_worktree`?
    ///
    /// The three narrowings AND together, so `codex@auckland` reaches the Codex
    /// in auckland and nobody else, while a message with only `to_agent` set
    /// reaches every Codex in the repository.
    fn addressed_to(
        msg: &SentinelMessage,
        session_id: &str,
        my_worktree: Option<&str>,
        my_agent: Option<&str>,
    ) -> bool {
        if let Some(to) = &msg.to_session {
            return to == session_id;
        }
        if let Some(to_wt) = &msg.to_worktree {
            if !Self::worktree_token(my_worktree).eq_ignore_ascii_case(to_wt) {
                return false;
            }
        }
        if let Some(to_agent) = &msg.to_agent {
            // A reader whose agent we don't know yet must not silently swallow
            // mail meant for a named agent — it would be marked read and the
            // real recipient would never see it.
            let Some(mine) = my_agent else { return false };
            if !Self::agent_matches(mine, to_agent) {
                return false;
            }
        }
        true // broadcast, or every narrowing passed
    }

    /// Which agent to judge a session's mail against.
    ///
    /// A caller that knows who it is (every agent does — it is the identity it
    /// sends under) wins, because an agent must be able to collect mail
    /// addressed to it *before* its first claim lands. The claim record is the
    /// fallback for readers that only carry a session id. Neither ⇒ the reader
    /// gets broadcasts and checkout mail but never agent-addressed mail, which
    /// is the safe direction: swallowing it would mark it read and the real
    /// recipient would never see it.
    fn agent_context(session_id: &str, declared: Option<&str>) -> Option<String> {
        declared
            .map(str::to_string)
            .or_else(|| Self::load_claims(session_id).map(|c| c.agent_id))
    }

    /// Send a message to a specific session or broadcast to all
    pub fn send_message(
        from_session: &str,
        from_agent: &str,
        to_session: Option<&str>,
        content: &str,
    ) -> SentinelMessage {
        Self::send_message_to(from_session, from_agent, to_session, None, content)
    }

    /// Send a message addressed to a session, to a whole checkout, or to
    /// everyone. Addressing a checkout ("whoever is working in `barcelona`")
    /// is the cross-worktree case: you rarely know a peer's session id, but you
    /// always know which tree they are in.
    pub fn send_message_to(
        from_session: &str,
        from_agent: &str,
        to_session: Option<&str>,
        to_worktree: Option<&str>,
        content: &str,
    ) -> SentinelMessage {
        Self::send_addressed(
            from_session,
            from_agent,
            &Address {
                session: to_session.map(str::to_string),
                worktree: to_worktree.map(str::to_string),
                agent: None,
            },
            content,
        )
    }

    /// Send a message to everyone an [`Address`] covers — the general form the
    /// other two senders delegate to. Narrowing by agent as well as checkout is
    /// what makes "codex, in auckland" sayable.
    pub fn send_addressed(
        from_session: &str,
        from_agent: &str,
        to: &Address,
        content: &str,
    ) -> SentinelMessage {
        Self::ensure_dirs();
        let msg = SentinelMessage {
            id: format!("msg-{}", &uuid::Uuid::new_v4().to_string()[..8]),
            from_session: from_session.to_string(),
            from_agent: from_agent.to_string(),
            to_session: to.session.clone(),
            content: content.to_string(),
            timestamp: Self::now(),
            read_by: vec![from_session.to_string()], // sender has "read" it
            from_worktree: Self::here(),
            to_worktree: to.worktree.clone(),
            to_agent: to.agent.clone(),
        };
        let path = format!("{}/{}.json", Self::messages_dir(), msg.id);
        if let Ok(json) = serde_json::to_string_pretty(&msg) {
            let _ = Self::atomic_write(&path, json.as_bytes());
        }
        Self::update_unread_marker();
        msg
    }

    /// How many live sessions an address currently reaches. A broadcast counts
    /// everyone but the sender; a bare session id counts as one whether or not
    /// that session has claimed anything yet.
    pub fn reach_of(addr: &Address, from_session: &str) -> usize {
        if addr.is_broadcast() {
            return Self::load_all_claims()
                .iter()
                .filter(|c| c.session_id != from_session)
                .count();
        }
        if addr.session.is_some() {
            return 1;
        }
        Self::sessions_matching(addr).len()
    }

    /// Read messages for a session (unread + recent read). Marks them as read.
    /// Returns Vec of (message, was_newly_read) — newly_read=true means first time seeing it.
    pub fn read_messages(session_id: &str, limit: usize) -> Vec<(SentinelMessage, bool)> {
        Self::read_messages_as(session_id, None, limit)
    }

    /// Read messages, declaring which agent is reading.
    ///
    /// The agent name matters because mail can be addressed to one — a reader
    /// that cannot say who it is must not consume `codex@auckland`'s mail and
    /// mark it read. Callers that know their identity (every agent does)
    /// should pass it; [`Self::read_messages`] is the shorthand that falls
    /// back to the session's claim record.
    pub fn read_messages_as(
        session_id: &str,
        agent: Option<&str>,
        limit: usize,
    ) -> Vec<(SentinelMessage, bool)> {
        Self::ensure_dirs();
        let dir = Self::messages_dir();
        let mut messages = Vec::new();
        let my_wt = Self::worktree_context(session_id);
        let my_agent = Self::agent_context(session_id, agent);

        if let Ok(entries) = fs::read_dir(&dir) {
            for entry in entries.flatten() {
                if entry.path().extension().map(|x| x == "json").unwrap_or(false) {
                    if let Ok(content) = fs::read_to_string(entry.path()) {
                        if let Ok(msg) = serde_json::from_str::<SentinelMessage>(&content) {
                            // Include if: for us (broadcast, direct, or to our
                            // checkout), or sent by us.
                            let dominated = Self::addressed_to(
                                &msg,
                                session_id,
                                my_wt.as_deref(),
                                my_agent.as_deref(),
                            ) || msg.from_session == session_id;
                            if dominated {
                                messages.push((entry.path(), msg));
                            }
                        }
                    }
                }
            }
        }

        // Sort by timestamp descending
        messages.sort_by(|a, b| b.1.timestamp.cmp(&a.1.timestamp));

        // Mark unread ones as read, track which were newly read
        let mut result = Vec::new();
        for entry in &mut messages {
            let was_unread = !entry.1.read_by.contains(&session_id.to_string());
            if was_unread {
                entry.1.read_by.push(session_id.to_string());
                if let Ok(json) = serde_json::to_string_pretty(&entry.1) {
                    let _ = Self::atomic_write(&entry.0.to_string_lossy(), json.as_bytes());
                }
            }
            result.push((entry.1.clone(), was_unread));
        }

        Self::update_unread_marker();

        result.into_iter().take(limit).collect()
    }

    /// Get unread messages for a specific session WITHOUT marking them as read.
    /// Returns messages sorted by timestamp descending (newest first).
    pub fn get_unread_messages(session_id: &str) -> Vec<SentinelMessage> {
        let my_wt = Self::worktree_context(session_id);
        let my_agent = Self::agent_context(session_id, None);
        let mut unread: Vec<SentinelMessage> = Self::all_messages()
            .into_iter()
            .filter(|msg| {
                Self::addressed_to(msg, session_id, my_wt.as_deref(), my_agent.as_deref())
                    && msg.from_session != session_id
                    && !msg.read_by.contains(&session_id.to_string())
            })
            .collect();
        unread.sort_by(|a, b| b.timestamp.cmp(&a.timestamp));
        unread
    }

    /// Count unread messages for a specific session
    pub fn unread_count(session_id: &str) -> u64 {
        Self::get_unread_messages(session_id).len() as u64
    }

    /// Every message on the shared plane, unsorted. The control plane reads
    /// this to show what has been said across checkouts.
    pub fn all_messages() -> Vec<SentinelMessage> {
        let dir = Self::messages_dir();
        let mut out = Vec::new();
        if let Ok(entries) = fs::read_dir(&dir) {
            for entry in entries.flatten() {
                if entry.path().extension().map(|x| x == "json").unwrap_or(false) {
                    if let Ok(content) = fs::read_to_string(entry.path()) {
                        if let Ok(msg) = serde_json::from_str::<SentinelMessage>(&content) {
                            out.push(msg);
                        }
                    }
                }
            }
        }
        out
    }

    /// List all active agents (alive sessions with their agent types)
    pub fn list_agents() -> Vec<serde_json::Value> {
        Self::ensure_dirs();
        Self::cleanup_stale();
        let all = Self::load_all_claims();
        all.iter().map(|c| {
            serde_json::json!({
                "session_id": c.session_id,
                "agent_id": c.agent_id,
                "pid": c.pid,
                "claim_count": c.claims.len(),
                "last_heartbeat": c.last_heartbeat,
                "worktree": c.worktree,
                "branch": c.branch,
                "files": c.claims.iter()
                    .map(|cl| cl.file_path.clone())
                    .collect::<std::collections::HashSet<_>>()
                    .into_iter()
                    .collect::<Vec<_>>(),
            })
        }).collect()
    }

    /// Cleanup old messages (>1 hour)
    pub fn cleanup_old_messages() -> usize {
        let dir = Self::messages_dir();
        let now = Self::now();
        let max_age = 3600; // 1 hour
        let mut removed = 0;
        if let Ok(entries) = fs::read_dir(&dir) {
            for entry in entries.flatten() {
                if entry.path().extension().map(|x| x == "json").unwrap_or(false) {
                    if let Ok(content) = fs::read_to_string(entry.path()) {
                        if let Ok(msg) = serde_json::from_str::<SentinelMessage>(&content) {
                            if now - msg.timestamp > max_age {
                                let _ = fs::remove_file(entry.path());
                                removed += 1;
                            }
                        }
                    }
                }
            }
        }
        if removed > 0 {
            Self::update_unread_marker();
        }
        removed
    }

    /// Update the unread marker file (total unread across all sessions)
    fn update_unread_marker() {
        let mut total_unread = 0u64;

        // Count messages that have at least one session that hasn't read them
        let all_sessions = Self::load_all_claims();
        for msg in Self::all_messages() {
            for sess in &all_sessions {
                if sess.session_id == msg.from_session {
                    continue;
                }
                // The claim record carries both narrowings, so an
                // agent-addressed message only counts against the agent it
                // actually names.
                if Self::addressed_to(
                    &msg,
                    &sess.session_id,
                    sess.worktree.as_deref(),
                    Some(&sess.agent_id),
                ) && !msg.read_by.contains(&sess.session_id)
                {
                    total_unread += 1;
                    break; // count each message once
                }
            }
        }

        let marker = Self::unread_marker();
        if total_unread > 0 {
            let _ = fs::write(&marker, total_unread.to_string());
        } else {
            let _ = fs::remove_file(&marker);
        }
    }

    /// Recount active collisions across all sessions and update the marker file
    fn update_collision_marker() {
        let all = Self::load_all_claims();
        let mut collision_count: u64 = 0;

        for (i, a) in all.iter().enumerate() {
            for b in all.iter().skip(i + 1) {
                for ca in &a.claims {
                    for cb in &b.claims {
                        if ca.file_path == cb.file_path && ca.function_name == cb.function_name {
                            collision_count += 1;
                        }
                    }
                }
            }
        }

        let marker = Self::collisions_marker();
        if collision_count > 0 {
            let _ = fs::write(&marker, collision_count.to_string());
        } else {
            let _ = fs::remove_file(&marker);
        }
    }
}

/// Simple glob-like pattern matching for zone rules.
/// Supports prefix matching (e.g. "src/auth/" matches "src/auth/login.rs")
/// and wildcard "*" at end (e.g. "src/auth/*").
fn file_matches_pattern(file_path: &str, pattern: &str) -> bool {
    let pattern = pattern.trim_end_matches('*');
    file_path.starts_with(pattern)
}
