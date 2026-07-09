//! # aura-zones
//!
//! File and function ownership zones for multi-agent codebases.
//!
//! When multiple AI agents (or humans) edit the same codebase concurrently,
//! they need a lightweight mutex to prevent stepping on each other's work.
//! `aura-zones` provides:
//!
//! - **Function claims** — an agent claims the functions it's editing;
//!   other agents see collisions before they start.
//! - **Zone rules** — mark file patterns as Warn or Block so other agents
//!   know to stay away.
//! - **Inter-agent messaging** — broadcast or direct messages between
//!   concurrent sessions.
//! - **Stale cleanup** — dead PIDs and old messages are automatically reaped.
//!
//! Storage is file-based (one JSON file per session/zone/message), so there's
//! no database and no daemon — just the filesystem.
//!
//! ## Example
//!
//! ```no_run
//! use std::path::PathBuf;
//! use aura_zones::SentinelManager;
//!
//! let mgr = SentinelManager::new(PathBuf::from(".aura/sentinel"));
//!
//! // Claim functions before editing
//! let collisions = mgr.claim_functions("sess-1", "claude", std::process::id(), "src/auth.rs", &["login".into()]);
//! if !collisions.is_empty() {
//!     eprintln!("collision: another agent holds login()");
//! }
//!
//! // Check zone rules
//! if let Some(zone) = mgr.check_zone("sess-1", "src/auth.rs") {
//!     eprintln!("zone {:?} applies: {:?}", zone.mode, zone.patterns);
//! }
//!
//! // Send a message
//! mgr.send_message("sess-1", "claude", None, "heads up: refactoring auth");
//! ```
//!
//! Originally extracted from [Aura](https://auravcs.com), the semantic
//! version control engine.

use serde::{Deserialize, Serialize};
use std::fs;
use std::path::PathBuf;
use std::time::{SystemTime, UNIX_EPOCH};

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

#[derive(Serialize, Deserialize, Clone, Debug)]
pub struct SentinelMessage {
    pub id: String,
    pub from_session: String,
    pub from_agent: String,
    pub to_session: Option<String>,
    pub content: String,
    pub timestamp: u64,
    pub read_by: Vec<String>,
}

pub struct SentinelManager {
    base_dir: PathBuf,
}

impl SentinelManager {
    pub fn new(base_dir: PathBuf) -> Self {
        Self { base_dir }
    }

    fn claims_dir(&self) -> PathBuf {
        self.base_dir.join("claims")
    }

    fn zones_dir(&self) -> PathBuf {
        self.base_dir.join("zones")
    }

    fn collisions_marker(&self) -> PathBuf {
        self.base_dir.join("collisions_pending")
    }

    fn messages_dir(&self) -> PathBuf {
        self.base_dir.join("messages")
    }

    fn unread_marker(&self) -> PathBuf {
        self.base_dir.join("unread_pending")
    }

    fn ensure_dirs(&self) {
        let _ = fs::create_dir_all(self.claims_dir());
        let _ = fs::create_dir_all(self.zones_dir());
        let _ = fs::create_dir_all(self.messages_dir());
    }

    fn now() -> u64 {
        SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap_or_default()
            .as_secs()
    }

    fn claim_path(&self, session_id: &str) -> PathBuf {
        self.claims_dir().join(format!("{}.json", session_id))
    }

    fn atomic_write(path: &PathBuf, data: &[u8]) -> Result<(), String> {
        let tmp = path.with_extension("tmp");
        fs::write(&tmp, data).map_err(|e| format!("Write error: {}", e))?;
        fs::rename(&tmp, path).map_err(|e| format!("Rename error: {}", e))?;
        Ok(())
    }

    fn load_all_claims(&self) -> Vec<SentinelClaims> {
        let dir = self.claims_dir();
        let mut all = Vec::new();
        if let Ok(entries) = fs::read_dir(&dir) {
            for entry in entries.flatten() {
                if entry.path().extension().is_some_and(|x| x == "json") {
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

    fn is_pid_alive(pid: u32) -> bool {
        use sysinfo::System;
        let mut sys = System::new();
        sys.refresh_processes(
            sysinfo::ProcessesToUpdate::Some(&[sysinfo::Pid::from_u32(pid)]),
            true,
        );
        sys.process(sysinfo::Pid::from_u32(pid)).is_some()
    }

    pub fn cleanup_stale(&self) -> usize {
        self.ensure_dirs();
        let now = Self::now();
        let zombie_threshold = 3600;
        let mut removed = 0;

        let all = self.load_all_claims();
        for claims in &all {
            let pid_dead = !Self::is_pid_alive(claims.pid);
            let zombie = now - claims.last_heartbeat > zombie_threshold;
            if pid_dead || zombie {
                let path = self.claim_path(&claims.session_id);
                let _ = fs::remove_file(&path);
                removed += 1;
            }
        }

        if removed > 0 {
            self.update_collision_marker();
        }
        removed
    }

    pub fn claim_functions(
        &self,
        session_id: &str,
        agent_id: &str,
        pid: u32,
        file_path: &str,
        functions: &[String],
    ) -> Vec<Collision> {
        self.ensure_dirs();

        let path = self.claim_path(session_id);
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

        let others = self.load_all_claims();
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

            let already = my_claims
                .claims
                .iter()
                .any(|c| c.file_path == file_path && c.function_name == *func_name);
            if !already {
                my_claims.claims.push(FunctionClaim {
                    file_path: file_path.to_string(),
                    function_name: func_name.clone(),
                    node_id: None,
                    claimed_at: Self::now(),
                });
            }
        }

        my_claims.last_heartbeat = Self::now();
        if let Ok(json) = serde_json::to_string_pretty(&my_claims) {
            let _ = Self::atomic_write(&path, json.as_bytes());
        }

        self.update_collision_marker();
        collisions
    }

    pub fn release_claims(&self, session_id: &str) {
        let path = self.claim_path(session_id);
        let _ = fs::remove_file(&path);
        self.update_collision_marker();
    }

    pub fn release_file_claims(&self, session_id: &str, file_path: &str) {
        let path = self.claim_path(session_id);
        if let Ok(content) = fs::read_to_string(&path) {
            if let Ok(mut claims) = serde_json::from_str::<SentinelClaims>(&content) {
                claims.claims.retain(|c| c.file_path != file_path);
                claims.last_heartbeat = Self::now();
                if let Ok(json) = serde_json::to_string_pretty(&claims) {
                    let _ = Self::atomic_write(&path, json.as_bytes());
                }
            }
        }
        self.update_collision_marker();
    }

    pub fn check_zone(&self, session_id: &str, file_path: &str) -> Option<ZoneRule> {
        let dir = self.zones_dir();
        if let Ok(entries) = fs::read_dir(&dir) {
            for entry in entries.flatten() {
                if entry.path().extension().is_some_and(|x| x == "json") {
                    if let Ok(content) = fs::read_to_string(entry.path()) {
                        if let Ok(zone) = serde_json::from_str::<ZoneRule>(&content) {
                            if zone.session_id == session_id {
                                continue;
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

    pub fn update_heartbeat(&self, session_id: &str) {
        let path = self.claim_path(session_id);
        if let Ok(content) = fs::read_to_string(&path) {
            if let Ok(mut claims) = serde_json::from_str::<SentinelClaims>(&content) {
                claims.last_heartbeat = Self::now();
                if let Ok(json) = serde_json::to_string_pretty(&claims) {
                    let _ = Self::atomic_write(&path, json.as_bytes());
                }
            }
        }
    }

    pub fn get_status(&self, session_id: &str) -> serde_json::Value {
        self.ensure_dirs();
        let all = self.load_all_claims();

        let own = all.iter().find(|c| c.session_id == session_id);
        let others: Vec<&SentinelClaims> =
            all.iter().filter(|c| c.session_id != session_id).collect();

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

        let zones = self.list_zones();

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

    pub fn create_zone(&self, session_id: &str, patterns: Vec<String>, mode: ZoneMode) -> ZoneRule {
        self.ensure_dirs();
        let zone_id = format!("zone-{}", &uuid::Uuid::new_v4().to_string()[..8]);
        let zone = ZoneRule {
            zone_id: zone_id.clone(),
            session_id: session_id.to_string(),
            patterns,
            mode,
        };
        let path = self.zones_dir().join(format!("{}.json", zone_id));
        if let Ok(json) = serde_json::to_string_pretty(&zone) {
            let _ = Self::atomic_write(&path, json.as_bytes());
        }
        zone
    }

    pub fn list_zones(&self) -> Vec<ZoneRule> {
        let dir = self.zones_dir();
        let mut zones = Vec::new();
        if let Ok(entries) = fs::read_dir(&dir) {
            for entry in entries.flatten() {
                if entry.path().extension().is_some_and(|x| x == "json") {
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

    pub fn send_message(
        &self,
        from_session: &str,
        from_agent: &str,
        to_session: Option<&str>,
        content: &str,
    ) -> SentinelMessage {
        self.ensure_dirs();
        let msg = SentinelMessage {
            id: format!("msg-{}", &uuid::Uuid::new_v4().to_string()[..8]),
            from_session: from_session.to_string(),
            from_agent: from_agent.to_string(),
            to_session: to_session.map(|s| s.to_string()),
            content: content.to_string(),
            timestamp: Self::now(),
            read_by: vec![from_session.to_string()],
        };
        let path = self.messages_dir().join(format!("{}.json", msg.id));
        if let Ok(json) = serde_json::to_string_pretty(&msg) {
            let _ = Self::atomic_write(&path, json.as_bytes());
        }
        self.update_unread_marker();
        msg
    }

    pub fn read_messages(&self, session_id: &str, limit: usize) -> Vec<(SentinelMessage, bool)> {
        self.ensure_dirs();
        let dir = self.messages_dir();
        let mut messages = Vec::new();

        if let Ok(entries) = fs::read_dir(&dir) {
            for entry in entries.flatten() {
                if entry.path().extension().is_some_and(|x| x == "json") {
                    if let Ok(content) = fs::read_to_string(entry.path()) {
                        if let Ok(msg) = serde_json::from_str::<SentinelMessage>(&content) {
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

        messages.sort_by(|a, b| b.1.timestamp.cmp(&a.1.timestamp));

        let mut result = Vec::new();
        for entry in &mut messages {
            let was_unread = !entry.1.read_by.contains(&session_id.to_string());
            if was_unread {
                entry.1.read_by.push(session_id.to_string());
                if let Ok(json) = serde_json::to_string_pretty(&entry.1) {
                    let _ = Self::atomic_write(&entry.0, json.as_bytes());
                }
            }
            result.push((entry.1.clone(), was_unread));
        }

        self.update_unread_marker();
        result.into_iter().take(limit).collect()
    }

    pub fn get_unread_messages(&self, session_id: &str) -> Vec<SentinelMessage> {
        let dir = self.messages_dir();
        let mut unread = Vec::new();
        if let Ok(entries) = fs::read_dir(&dir) {
            for entry in entries.flatten() {
                if entry.path().extension().is_some_and(|x| x == "json") {
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

    pub fn unread_count(&self, session_id: &str) -> u64 {
        let dir = self.messages_dir();
        let mut count = 0u64;
        if let Ok(entries) = fs::read_dir(&dir) {
            for entry in entries.flatten() {
                if entry.path().extension().is_some_and(|x| x == "json") {
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

    pub fn list_agents(&self) -> Vec<serde_json::Value> {
        self.ensure_dirs();
        self.cleanup_stale();
        let all = self.load_all_claims();
        all.iter()
            .map(|c| {
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
            })
            .collect()
    }

    pub fn cleanup_old_messages(&self) -> usize {
        let dir = self.messages_dir();
        let now = Self::now();
        let max_age = 3600;
        let mut removed = 0;
        if let Ok(entries) = fs::read_dir(&dir) {
            for entry in entries.flatten() {
                if entry.path().extension().is_some_and(|x| x == "json") {
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
            self.update_unread_marker();
        }
        removed
    }

    fn update_unread_marker(&self) {
        let dir = self.messages_dir();
        let mut total_unread = 0u64;

        let all_sessions = self.load_all_claims();
        if let Ok(entries) = fs::read_dir(&dir) {
            for entry in entries.flatten() {
                if entry.path().extension().is_some_and(|x| x == "json") {
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
                                    break;
                                }
                            }
                        }
                    }
                }
            }
        }

        let marker = self.unread_marker();
        if total_unread > 0 {
            let _ = fs::write(&marker, total_unread.to_string());
        } else {
            let _ = fs::remove_file(&marker);
        }
    }

    fn update_collision_marker(&self) {
        let all = self.load_all_claims();
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

        let marker = self.collisions_marker();
        if collision_count > 0 {
            let _ = fs::write(&marker, collision_count.to_string());
        } else {
            let _ = fs::remove_file(&marker);
        }
    }
}

fn file_matches_pattern(file_path: &str, pattern: &str) -> bool {
    let pattern = pattern.trim_end_matches('*');
    file_path.starts_with(pattern)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::PathBuf;

    fn temp_dir() -> PathBuf {
        let dir = std::env::temp_dir().join(format!("aura-zones-test-{}", uuid::Uuid::new_v4()));
        let _ = fs::create_dir_all(&dir);
        dir
    }

    #[test]
    fn test_claim_and_detect_collision() {
        let dir = temp_dir();
        let mgr = SentinelManager::new(dir.clone());

        let c1 = mgr.claim_functions("s1", "claude-1", 99999, "src/main.rs", &["foo".into()]);
        assert!(c1.is_empty());

        let c2 = mgr.claim_functions("s2", "claude-2", 99998, "src/main.rs", &["foo".into()]);
        assert_eq!(c2.len(), 1);
        assert_eq!(c2[0].function_name, "foo");
        assert_eq!(c2[0].held_by_session, "s1");

        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn test_zone_warn_and_block() {
        let dir = temp_dir();
        let mgr = SentinelManager::new(dir.clone());

        mgr.create_zone("s1", vec!["src/auth/".into()], ZoneMode::Block);

        let zone = mgr.check_zone("s2", "src/auth/login.rs");
        assert!(zone.is_some());
        assert_eq!(zone.unwrap().mode, ZoneMode::Block);

        let no_zone = mgr.check_zone("s2", "src/utils.rs");
        assert!(no_zone.is_none());

        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn test_messaging_round_trip() {
        let dir = temp_dir();
        let mgr = SentinelManager::new(dir.clone());

        mgr.claim_functions("s1", "claude-1", 99999, "x.rs", &[]);
        mgr.claim_functions("s2", "claude-2", 99998, "y.rs", &[]);

        mgr.send_message("s1", "claude-1", None, "hello from s1");

        let unread = mgr.unread_count("s2");
        assert_eq!(unread, 1);

        let msgs = mgr.read_messages("s2", 10);
        assert_eq!(msgs.len(), 1);
        assert!(msgs[0].1); // was newly read
        assert_eq!(msgs[0].0.content, "hello from s1");

        let unread_after = mgr.unread_count("s2");
        assert_eq!(unread_after, 0);

        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn test_release_claims() {
        let dir = temp_dir();
        let mgr = SentinelManager::new(dir.clone());

        mgr.claim_functions("s1", "claude", 99999, "a.rs", &["bar".into()]);
        mgr.release_claims("s1");

        let c2 = mgr.claim_functions("s2", "claude-2", 99998, "a.rs", &["bar".into()]);
        assert!(c2.is_empty());

        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn test_file_matches_pattern() {
        assert!(file_matches_pattern("src/auth/login.rs", "src/auth/"));
        assert!(file_matches_pattern("src/auth/login.rs", "src/auth/*"));
        assert!(!file_matches_pattern("src/utils.rs", "src/auth/"));
    }
}
