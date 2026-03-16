use serde::{Deserialize, Serialize};
use std::fs;
use std::time::{SystemTime, UNIX_EPOCH};

use crate::session::worktree_aura_path;

// ── Data structures ──

#[derive(Serialize, Deserialize, Clone, Debug)]
pub struct FunctionClaim {
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
}

#[derive(Serialize, Deserialize, Clone, Debug)]
pub struct Collision {
    pub file_path: String,
    pub function_name: String,
    pub held_by_session: String,
    pub held_by_agent: String,
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
}

// ── Manager ──

pub struct SentinelManager;

impl SentinelManager {
    fn claims_dir() -> String {
        worktree_aura_path("sentinel/claims")
    }

    fn zones_dir() -> String {
        worktree_aura_path("sentinel/zones")
    }

    fn collisions_marker() -> String {
        worktree_aura_path("sentinel/collisions_pending")
    }

    fn messages_dir() -> String {
        worktree_aura_path("sentinel/messages")
    }

    fn unread_marker() -> String {
        worktree_aura_path("sentinel/unread_pending")
    }

    fn ensure_dirs() {
        let _ = fs::create_dir_all(Self::claims_dir());
        let _ = fs::create_dir_all(Self::zones_dir());
        let _ = fs::create_dir_all(Self::messages_dir());
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

    /// Load all claim files (one per session)
    fn load_all_claims() -> Vec<SentinelClaims> {
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
    fn is_pid_alive(pid: u32) -> bool {
        use sysinfo::System;
        let mut sys = System::new();
        sys.refresh_processes(sysinfo::ProcessesToUpdate::Some(&[sysinfo::Pid::from_u32(pid)]), true);
        sys.process(sysinfo::Pid::from_u32(pid)).is_some()
    }

    /// Remove claims for dead processes.
    /// PID alive = keep (even if idle). PID dead = remove.
    /// Heartbeat staleness (>1hr) is only a fallback for zombie claim files.
    pub fn cleanup_stale() -> usize {
        Self::ensure_dirs();
        let now = Self::now();
        let zombie_threshold = 3600; // 1 hour — only for truly abandoned claims
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

        // Load existing claims for this session
        let path = Self::claim_path(session_id);
        let mut my_claims = if let Ok(content) = fs::read_to_string(&path) {
            serde_json::from_str::<SentinelClaims>(&content).unwrap_or_else(|_| SentinelClaims {
                session_id: session_id.to_string(),
                agent_id: agent_id.to_string(),
                pid,
                last_heartbeat: Self::now(),
                claims: Vec::new(),
            })
        } else {
            SentinelClaims {
                session_id: session_id.to_string(),
                agent_id: agent_id.to_string(),
                pid,
                last_heartbeat: Self::now(),
                claims: Vec::new(),
            }
        };

        // Check for collisions against other sessions
        let others = Self::load_all_claims();
        let mut collisions = Vec::new();

        for func_name in functions {
            for other in &others {
                if other.session_id == session_id {
                    continue;
                }
                for claim in &other.claims {
                    if claim.file_path == file_path && claim.function_name == *func_name {
                        collisions.push(Collision {
                            file_path: file_path.to_string(),
                            function_name: func_name.clone(),
                            held_by_session: other.session_id.clone(),
                            held_by_agent: other.agent_id.clone(),
                        });
                    }
                }
            }

            // Add/update our claim
            let already = my_claims.claims.iter().any(|c| {
                c.file_path == file_path && c.function_name == *func_name
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

        // Update heartbeat and write
        my_claims.last_heartbeat = Self::now();
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

    /// Check if a file falls within any zone claimed by another session
    pub fn check_zone(session_id: &str, file_path: &str) -> Option<ZoneRule> {
        let dir = Self::zones_dir();
        if let Ok(entries) = fs::read_dir(&dir) {
            for entry in entries.flatten() {
                if entry.path().extension().map(|x| x == "json").unwrap_or(false) {
                    if let Ok(content) = fs::read_to_string(entry.path()) {
                        if let Ok(zone) = serde_json::from_str::<ZoneRule>(&content) {
                            if zone.session_id == session_id {
                                continue; // Own zone
                            }
                            for pattern in &zone.patterns {
                                if file_matches_pattern(file_path, pattern) {
                                    return Some(zone);
                                }
                            }
                        }
                    }
                }
            }
        }
        None
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
                            }));
                        }
                    }
                }
            }
        }

        let zones = Self::list_zones();

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
            })).collect::<Vec<_>>(),
            "collisions": collisions,
            "zones": zones.iter().map(|z| serde_json::json!({
                "zone_id": z.zone_id,
                "session_id": z.session_id,
                "patterns": z.patterns,
                "mode": format!("{:?}", z.mode),
            })).collect::<Vec<_>>(),
            "total_active_sessions": all.len(),
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

    /// Send a message to a specific session or broadcast to all
    pub fn send_message(
        from_session: &str,
        from_agent: &str,
        to_session: Option<&str>,
        content: &str,
    ) -> SentinelMessage {
        Self::ensure_dirs();
        let msg = SentinelMessage {
            id: format!("msg-{}", &uuid::Uuid::new_v4().to_string()[..8]),
            from_session: from_session.to_string(),
            from_agent: from_agent.to_string(),
            to_session: to_session.map(|s| s.to_string()),
            content: content.to_string(),
            timestamp: Self::now(),
            read_by: vec![from_session.to_string()], // sender has "read" it
        };
        let path = format!("{}/{}.json", Self::messages_dir(), msg.id);
        if let Ok(json) = serde_json::to_string_pretty(&msg) {
            let _ = Self::atomic_write(&path, json.as_bytes());
        }
        Self::update_unread_marker();
        msg
    }

    /// Read messages for a session (unread + recent read). Marks them as read.
    /// Returns Vec of (message, was_newly_read) — newly_read=true means first time seeing it.
    pub fn read_messages(session_id: &str, limit: usize) -> Vec<(SentinelMessage, bool)> {
        Self::ensure_dirs();
        let dir = Self::messages_dir();
        let mut messages = Vec::new();

        if let Ok(entries) = fs::read_dir(&dir) {
            for entry in entries.flatten() {
                if entry.path().extension().map(|x| x == "json").unwrap_or(false) {
                    if let Ok(content) = fs::read_to_string(entry.path()) {
                        if let Ok(msg) = serde_json::from_str::<SentinelMessage>(&content) {
                            // Include if: broadcast, or addressed to us, or sent by us
                            let dominated = msg.to_session.is_none()
                                || msg.to_session.as_deref() == Some(session_id)
                                || msg.from_session == session_id;
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
        let dir = Self::messages_dir();
        let mut unread = Vec::new();
        if let Ok(entries) = fs::read_dir(&dir) {
            for entry in entries.flatten() {
                if entry.path().extension().map(|x| x == "json").unwrap_or(false) {
                    if let Ok(content) = fs::read_to_string(entry.path()) {
                        if let Ok(msg) = serde_json::from_str::<SentinelMessage>(&content) {
                            let dominated = msg.to_session.is_none()
                                || msg.to_session.as_deref() == Some(session_id);
                            if dominated
                                && msg.from_session != session_id
                                && !msg.read_by.contains(&session_id.to_string())
                            {
                                unread.push(msg);
                            }
                        }
                    }
                }
            }
        }
        unread.sort_by(|a, b| b.timestamp.cmp(&a.timestamp));
        unread
    }

    /// Count unread messages for a specific session
    pub fn unread_count(session_id: &str) -> u64 {
        let dir = Self::messages_dir();
        let mut count = 0u64;
        if let Ok(entries) = fs::read_dir(&dir) {
            for entry in entries.flatten() {
                if entry.path().extension().map(|x| x == "json").unwrap_or(false) {
                    if let Ok(content) = fs::read_to_string(entry.path()) {
                        if let Ok(msg) = serde_json::from_str::<SentinelMessage>(&content) {
                            let dominated = msg.to_session.is_none()
                                || msg.to_session.as_deref() == Some(session_id);
                            if dominated
                                && msg.from_session != session_id
                                && !msg.read_by.contains(&session_id.to_string())
                            {
                                count += 1;
                            }
                        }
                    }
                }
            }
        }
        count
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
        let dir = Self::messages_dir();
        let mut total_unread = 0u64;

        // Count messages that have at least one session that hasn't read them
        let all_sessions = Self::load_all_claims();
        if let Ok(entries) = fs::read_dir(&dir) {
            for entry in entries.flatten() {
                if entry.path().extension().map(|x| x == "json").unwrap_or(false) {
                    if let Ok(content) = fs::read_to_string(entry.path()) {
                        if let Ok(msg) = serde_json::from_str::<SentinelMessage>(&content) {
                            for sess in &all_sessions {
                                if sess.session_id == msg.from_session {
                                    continue;
                                }
                                let dominated = msg.to_session.is_none()
                                    || msg.to_session.as_deref() == Some(&sess.session_id);
                                if dominated && !msg.read_by.contains(&sess.session_id) {
                                    total_unread += 1;
                                    break; // count each message once
                                }
                            }
                        }
                    }
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
