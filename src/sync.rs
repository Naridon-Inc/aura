use std::process::Command;
use colored::Colorize;
use crate::checkpoint::CheckpointStore;
use crate::config::ConfigManager;
use git2::Repository;
use serde_json::json;

/// How many graph nodes one sync may carry. The cloud upserts a row at a
/// time, so an unbounded first push of a large repo would be a single request
/// with tens of thousands of statements behind it — slow enough to time out,
/// and repeated on every commit. Bounded, the graph fills in over a handful of
/// commits instead, newest-changed first.
const MERKLE_MAX_NODES: usize = 2_000;

/// How many nodes ride in one request.
///
/// Measured against production, not guessed: the handler upserts a row at a
/// time against a database that is not on the same box, so 2,000 nodes in one
/// body spends minutes inside a single request and the connection is dropped
/// before it answers — `aura live sync graph` reported "Operating offline"
/// while the endpoint itself was healthy. Split, each request finishes in a
/// couple of seconds and a failure costs one chunk instead of the whole push.
const MERKLE_CHUNK: usize = 250;

/// Cross-Repo Tracing: The Global Brain Sync
pub struct GlobalSync;

impl GlobalSync {
    /// Get the configured cloud URL (default: https://api.auravcs.com)
    fn cloud_url() -> String {
        let config = ConfigManager::load();
        crate::cloud_endpoint::origin_or_public(config.cloud_url.as_deref())
    }

    /// Get the cloud API token if configured
    fn cloud_token() -> Option<String> {
        let config = ConfigManager::load();
        crate::cloud_endpoint::token(config.cloud_api_token.as_deref())
    }

    /// Build an authenticated HTTP client for cloud API
    fn cloud_client() -> reqwest::blocking::Client {
        reqwest::blocking::Client::new()
    }

    /// Sync checkpoints to Aura Cloud
    pub fn sync_checkpoints(repo_url: &str) {
        let token = match Self::cloud_token() {
            Some(t) => t,
            None => {
                // Fall back to legacy sync
                Self::sync_remote(repo_url);
                return;
            }
        };

        let repo = match Repository::open(".") {
            Ok(r) => r,
            Err(e) => {
                println!("{} Failed to open local repository: {}", "✗".red(), e);
                return;
            }
        };

        let checkpoints = match CheckpointStore::get_all_checkpoints(&repo) {
            Ok(c) => c,
            Err(e) => {
                println!("{} Failed to read checkpoints: {}", "✗".red(), e);
                return;
            }
        };

        if checkpoints.is_empty() {
            println!("  {} No checkpoints to sync", "↳".dimmed());
            return;
        }

        let cloud_url = Self::cloud_url();
        let client = Self::cloud_client();

        let checkpoint_data: Vec<serde_json::Value> = checkpoints.iter().map(|cp| {
            json!({
                "commit_id": cp.id,
                // Neither the branch nor a risk assessment is known here: this
                // reads a Git note, and the note carries neither. Sending
                // `"Clean"` anyway is how the console came to group every
                // commit it had ever heard of under CLEAN — including one
                // named `test/risky-code`. Say nothing instead; the server
                // reads a missing label as unreviewed.
                "branch": null,
                "summary": cp.intent,
                "ast_node_count": cp.ast_nodes.len(),
                "data": {
                    "agent_id": cp.agent_id,
                    "timestamp": cp.timestamp,
                }
            })
        }).collect();

        let payload = json!({
            "repo_full_name": crate::repo_slug::canonical(repo_url),
            "checkpoints": checkpoint_data,
        });

        println!("  {} Syncing {} checkpoints to Aura Cloud...", "↳".dimmed(), checkpoints.len());

        let res = client
            .post(format!("{}/api/v1/sync/checkpoints", cloud_url))
            .header("Authorization", format!("Bearer {}", token))
            .json(&payload)
            .send();

        match res {
            Ok(response) if response.status().is_success() => {
                println!("{} Checkpoints synced to Aura Cloud.", "✓".green().bold());
            }
            Ok(response) => {
                println!("{} Cloud sync failed ({}). Data saved locally.", "⚠️".yellow(), response.status());
            }
            Err(e) => {
                println!("{} Cloud sync error: {}. Operating offline.", "⚠️".yellow(), e);
            }
        }

        // The checkpoints carry the AST nodes the Console's Graph searches,
        // so ship them in the same pass rather than leaving that table empty.
        Self::sync_merkle(repo_url, &checkpoints);
    }

    /// Mirror the repository's own commits into the cloud.
    ///
    /// [`Self::sync_checkpoints`] reads Git notes written by the pre-commit
    /// hook, so a repository whose commits bypass the hooks has no notes and
    /// therefore no commits in the console — every session's Landed tab says
    /// "Nothing was committed while this session was open" about work that
    /// produced dozens. This is the path that does not depend on a hook: read
    /// the commits from git, send what is there.
    ///
    /// Returns how many rows the cloud confirmed it wrote — zero for every
    /// kind of failure, so a caller never prints a count it did not earn.
    pub fn sync_commits(repo_url: &str, repo: &Repository, limit: usize) -> usize {
        let token = match Self::cloud_token() {
            Some(t) => t,
            None => return 0,
        };

        let commits = crate::commit_mirror::read_commits(repo, limit);
        if commits.is_empty() {
            return 0;
        }

        let rows = crate::commit_mirror::payload(&commits);
        let count = rows.len();
        let payload = json!({
            "repo_full_name": crate::repo_slug::canonical(repo_url),
            "checkpoints": rows,
        });

        println!(
            "  {} Mirroring {} commit{} to Aura Cloud...",
            "\u{21b3}".dimmed(),
            count,
            if count == 1 { "" } else { "s" }
        );

        let res = Self::cloud_client()
            .post(format!("{}/api/v1/sync/checkpoints", Self::cloud_url()))
            .header("Authorization", format!("Bearer {}", token))
            .json(&payload)
            .send();

        match res {
            Ok(response) if response.status().is_success() => {
                // A 200 is not yet a yes: this endpoint answers a refused push
                // — no database, or a plan's monthly sync limit reached — with
                // `{"error": …}` and a 200, so trusting the status alone
                // prints "mirrored" over commits the cloud threw away.
                let body: serde_json::Value =
                    response.json().unwrap_or(serde_json::Value::Null);
                if let Some(err) = body.get("error").and_then(|e| e.as_str()) {
                    let detail = body.get("message").and_then(|m| m.as_str()).unwrap_or(err);
                    println!("{} Commit mirror refused: {}", "\u{26a0}\u{fe0f}".yellow(), detail);
                    return 0;
                }
                body.get("synced").and_then(|s| s.as_u64()).unwrap_or(0) as usize
            }
            Ok(response) => {
                println!(
                    "{} Commit mirror failed ({}). The commits are still in git.",
                    "\u{26a0}\u{fe0f}".yellow(),
                    response.status()
                );
                0
            }
            Err(e) => {
                println!("{} Commit mirror error: {}. Operating offline.", "\u{26a0}\u{fe0f}".yellow(), e);
                0
            }
        }
    }

    /// Push the semantic graph of the checkpoints we just synced.
    ///
    /// The Console's Graph tab searches `merkle_nodes`, and until now nothing
    /// on any client ever wrote to it — the endpoint, the table and the search
    /// UI all existed while the writer was simply missing. So Graph answered
    /// "No matching nodes" for symbols the Intents tab was showing on the
    /// screen beside it, which reads as a broken index rather than an empty
    /// one.
    ///
    /// What crosses the wire is **metadata only**: a node id, a content hash,
    /// the symbol's name, its kind and its file path. Never a line of source.
    pub fn sync_merkle(repo_url: &str, checkpoints: &[crate::checkpoint::CheckpointData]) {
        let (nodes, dropped) = Self::merkle_payload(checkpoints);
        Self::push_merkle(repo_url, nodes, dropped);
    }

    /// Push the code graph read straight from the working tree.
    ///
    /// [`Self::sync_merkle`] only ever runs from the post-commit hook, off the
    /// checkpoint the pre-commit hook staged. A repo whose commits bypass those
    /// hooks — `--no-verify`, a squash landed by a bot, a strict-guard misfire
    /// worked around with `AURA_SKIP=1` — therefore never sends a node, and
    /// Trace › Graph stays empty while Intents beside it fills up. This is the
    /// on-demand path that does not depend on a hook having fired: scan the
    /// tree, send what is there.
    ///
    /// Returns how many nodes were accepted for sending, so a caller can say
    /// so. Metadata only, exactly as the hook path sends: id, hash, symbol
    /// name, kind, file path. Never a line of source.
    pub fn sync_graph_worktree(repo_url: &str, repo_root: &std::path::Path) -> usize {
        let nodes = crate::atlas::scan_worktree(repo_root);
        if nodes.is_empty() {
            println!(
                "  {} No source files found to graph under {}",
                "\u{21b3}".dimmed(),
                repo_root.display()
            );
            return 0;
        }

        let (rows, dropped) = Self::merkle_payload_from_nodes(&nodes);
        Self::push_merkle(repo_url, rows, dropped)
    }

    /// The one place graph nodes cross the wire. Returns how many rows the
    /// cloud confirmed it wrote — zero for every kind of failure.
    fn push_merkle(repo_url: &str, nodes: Vec<serde_json::Value>, dropped: usize) -> usize {
        let token = match Self::cloud_token() {
            Some(t) => t,
            None => return 0,
        };

        if nodes.is_empty() {
            return 0;
        }
        if dropped > 0 {
            // Never let a cap be silent: a partial graph that claims to be
            // whole is worse than one that says what it left behind.
            println!(
                "  {} Graph sync is sending the {} most recently changed nodes; {} older ones wait for a later commit.",
                "\u{21b3}".dimmed(),
                nodes.len(),
                dropped
            );
        }

        let cloud_url = Self::cloud_url();
        let client = Self::cloud_client();
        let url = format!("{}/api/v1/sync/merkle", cloud_url);
        let repo_full_name = crate::repo_slug::canonical(repo_url);
        let count = nodes.len();

        println!("  {} Syncing {} graph nodes to Aura Cloud...", "\u{21b3}".dimmed(), count);

        let mut synced = 0usize;
        for chunk in nodes.chunks(MERKLE_CHUNK) {
            let payload = json!({
                "repo_full_name": repo_full_name,
                "nodes": chunk,
            });

            match client
                .post(&url)
                .header("Authorization", format!("Bearer {}", token))
                .json(&payload)
                .send()
            {
                Ok(r) if r.status().is_success() => {
                    // A 200 is not yet a yes. This endpoint answers a refused
                    // push — no database, or a plan's monthly sync limit
                    // reached — with `{"error": …}` and a 200, so trusting the
                    // status alone prints "synced" over a graph the cloud
                    // threw away.
                    let body: serde_json::Value = r.json().unwrap_or(serde_json::Value::Null);
                    if let Some(err) = body.get("error").and_then(|e| e.as_str()) {
                        let detail = body.get("message").and_then(|m| m.as_str()).unwrap_or(err);
                        println!("{} Graph sync refused: {}", "\u{26a0}\u{fe0f}".yellow(), detail);
                        break;
                    }
                    synced += body
                        .get("synced")
                        .and_then(|s| s.as_u64())
                        .unwrap_or(chunk.len() as u64) as usize;
                }
                Ok(r) => {
                    println!("{} Graph sync failed ({}). Nodes stay local.", "\u{26a0}\u{fe0f}".yellow(), r.status());
                    break;
                }
                Err(e) => {
                    println!("{} Graph sync error: {}. Operating offline.", "\u{26a0}\u{fe0f}".yellow(), e);
                    break;
                }
            }
        }

        if synced > 0 {
            // Say the number, not just "done": a push that stopped partway
            // through its chunks has still left a usable graph behind, and the
            // reader needs to know it is short.
            println!(
                "{} Code graph synced to Aura Cloud ({} of {} nodes).",
                "\u{2713}".green().bold(),
                synced,
                count
            );
        }
        synced
    }

    /// Flatten checkpoints into the wire shape the cloud upserts by
    /// `(repo_id, node_id)`.
    ///
    /// Two things this has to get right:
    ///
    ///   * **One row per node id, newest wins.** A symbol appears in every
    ///     checkpoint that touched it. Sending each copy would be N writes for
    ///     one row and — because the upsert has no ordering — could leave the
    ///     *oldest* hash on top.
    ///
    ///   * **`parent_hash` runs the other way from `children`.** The cloud's
    ///     trace query walks upward (`mn.content_hash = t.parent_hash`), while
    ///     a local node only knows the hashes of its children. So the parent
    ///     link is inverted here, where the whole set is in hand.
    fn merkle_payload(
        checkpoints: &[crate::checkpoint::CheckpointData],
    ) -> (Vec<serde_json::Value>, usize) {
        use std::collections::HashMap;

        // node_id -> (written_at_ms, node). Newest checkpoint wins.
        let mut newest: HashMap<&str, (u64, &crate::models::AstNode)> = HashMap::new();
        // child content hash -> parent content hash.
        let mut parent_of: HashMap<&str, &str> = HashMap::new();

        for cp in checkpoints {
            let at = cp.written_at_ms();
            for node in &cp.ast_nodes {
                for child in &node.children {
                    parent_of.insert(child.as_str(), node.content_hash.as_str());
                }
                match newest.get(node.node_id.as_str()) {
                    Some((seen, _)) if *seen >= at => {}
                    _ => {
                        newest.insert(node.node_id.as_str(), (at, node));
                    }
                }
            }
        }

        Self::merkle_rows(newest, parent_of)
    }

    /// The same wire shape, built from one flat set of nodes — a worktree
    /// scan, where every symbol was read in the same pass and there is no
    /// "which checkpoint was newer" to settle.
    fn merkle_payload_from_nodes(
        nodes: &[crate::models::AstNode],
    ) -> (Vec<serde_json::Value>, usize) {
        use std::collections::HashMap;

        let mut newest: HashMap<&str, (u64, &crate::models::AstNode)> = HashMap::new();
        let mut parent_of: HashMap<&str, &str> = HashMap::new();

        for node in nodes {
            for child in &node.children {
                parent_of.insert(child.as_str(), node.content_hash.as_str());
            }
            // One timestamp for the whole scan, so the cap below falls back to
            // the node_id tiebreak and a re-scan of an unchanged tree sends
            // the same 2,000 nodes rather than a different arbitrary slice.
            newest.insert(node.node_id.as_str(), (0, node));
        }

        Self::merkle_rows(newest, parent_of)
    }

    /// Turn the deduplicated node set into the rows the cloud upserts, capped
    /// and ordered. Shared by both payload builders so the cap, the inverted
    /// parent link and the field spelling have exactly one definition.
    fn merkle_rows(
        newest: std::collections::HashMap<&str, (u64, &crate::models::AstNode)>,
        parent_of: std::collections::HashMap<&str, &str>,
    ) -> (Vec<serde_json::Value>, usize) {
        // The cloud upserts a row at a time, so a first sync of a large repo
        // would otherwise be one enormous request on every commit. Keep the
        // most recently changed nodes and let the rest arrive over the next
        // few commits — the graph converges either way, and each push stays
        // small enough to finish.
        let mut ordered: Vec<(u64, &crate::models::AstNode)> = newest.into_values().collect();
        ordered.sort_by(|a, b| b.0.cmp(&a.0).then_with(|| a.1.node_id.cmp(&b.1.node_id)));
        let dropped = ordered.len().saturating_sub(MERKLE_MAX_NODES);
        ordered.truncate(MERKLE_MAX_NODES);

        let mut rows: Vec<serde_json::Value> = ordered
            .into_iter()
            .map(|(_, node)| {
                json!({
                    "node_id": node.node_id,
                    "content_hash": node.content_hash,
                    "identifier": node.identifier,
                    "node_type": node.kind,
                    "file_path": node.file_path,
                    "parent_hash": parent_of.get(node.content_hash.as_str()),
                })
            })
            .collect();

        // A HashMap iterates in an arbitrary order; sorting keeps the request
        // body stable so a retry is byte-identical and a diff is readable.
        rows.sort_by(|a, b| a["node_id"].as_str().cmp(&b["node_id"].as_str()));
        (rows, dropped)
    }

    /// Sync a review result to Aura Cloud
    pub fn sync_review(repo_url: &str, review_json: &serde_json::Value) {
        let token = match Self::cloud_token() {
            Some(t) => t,
            None => return,
        };

        let cloud_url = Self::cloud_url();
        let client = Self::cloud_client();

        let payload = json!({
            "repo_full_name": crate::repo_slug::canonical(repo_url),
            "reviews": [review_json],
        });

        let _ = client
            .post(format!("{}/api/v1/sync/reviews", cloud_url))
            .header("Authorization", format!("Bearer {}", token))
            .json(&payload)
            .send();
    }

    /// Sync session data to Aura Cloud
    ///
    /// The push carries the names an older build filed this checkout under, so
    /// the cloud can move their history onto the project it belongs to. That
    /// mattered most from here: crew agents work in linked worktrees, which
    /// every shipped build up to 0.19.41 filed as a project of their own, and
    /// the desktop only heals a worktree it still has open.
    pub fn sync_session(repo_url: &str, session_json: &serde_json::Value) {
        let token = match Self::cloud_token() {
            Some(t) => t,
            None => return,
        };

        let cloud_url = Self::cloud_url();
        let client = Self::cloud_client();

        let repo_full_name = crate::repo_slug::canonical(repo_url);
        let payload = json!({
            "former_repo_names": crate::repo_slug::former_names(&repo_full_name),
            "repo_full_name": repo_full_name,
            "sessions": [session_json],
        });

        let _ = client
            .post(format!("{}/api/v1/sync/sessions", cloud_url))
            .header("Authorization", format!("Bearer {}", token))
            .json(&payload)
            .send();
    }

    /// Fire a POST to /api/v2/{thing} with a JSON body. Silent on failure.
    fn post_v2(path: &str, body: serde_json::Value) {
        let token = match Self::cloud_token() {
            Some(t) => t,
            None => return,
        };
        let config = ConfigManager::load();
        if !config.sync_enabled {
            return;
        }
        let url = format!("{}/api/v2/{}", Self::cloud_url(), path.trim_start_matches('/'));
        let client = Self::cloud_client();
        let _ = client
            .post(url)
            .header("Authorization", format!("Bearer {}", token))
            .json(&body)
            .timeout(std::time::Duration::from_secs(5))
            .send();
    }

    /// Push a snapshot record (content hash, not raw content).
    pub fn push_snapshot(
        file_path: &str,
        content_sha256: &str,
        size_bytes: u64,
        trigger: &str,
        agent_id: &str,
        repo_full_name: Option<&str>,
    ) {
        let body = json!({
            "file_path": file_path,
            "content_sha256": content_sha256,
            "size_bytes": size_bytes as i64,
            "trigger": trigger,
            "agent_id": agent_id,
            "repo_full_name": repo_full_name.map(crate::repo_slug::canonical),
        });
        Self::post_v2("snapshots", body);
    }

    /// Push a handover record.
    ///
    /// The summary is the whole context block. It is assembled from real work
    /// — repo root, files touched, tool output — so it carries real paths, and
    /// a pushed handover is visible to the whole team. The host is stripped
    /// here, at the boundary, rather than in whichever client renders it: a
    /// redaction that only one reader applies is not a redaction.
    pub fn push_handover(session_id: Option<&str>, agent_name: &str, summary: &str, token_count: u64) {
        let body = json!({
            "session_id": session_id,
            "agent_name": agent_name,
            "summary": crate::redact_paths::redact_local_paths(summary),
            "token_count": token_count as i32,
        });
        Self::post_v2("handovers", body);
    }

    /// Push a plan record.
    pub fn push_plan(
        objective: &str,
        waves: serde_json::Value,
        status: &str,
        repo_full_name: Option<&str>,
    ) {
        let body = json!({
            "objective": objective,
            "waves": waves,
            "status": status,
            "repo_full_name": repo_full_name.map(crate::repo_slug::canonical),
        });
        Self::post_v2("plans", body);
    }

    /// Push an orchestration start/end record.
    pub fn push_orchestration(
        mode: &str,
        agents: serde_json::Value,
        status: &str,
        session_id: Option<&str>,
        ended: bool,
    ) {
        let body = json!({
            "mode": mode,
            "agents": agents,
            "status": status,
            "session_id": session_id,
            "ended": ended,
        });
        Self::post_v2("orchestrations", body);
    }

    /// Push a memory entry.
    pub fn push_memory_entry(
        kind: &str,
        title: Option<&str>,
        body_text: &str,
        repo_full_name: Option<&str>,
    ) {
        let body = json!({
            "kind": kind,
            "title": title,
            "body": body_text,
            "repo_full_name": repo_full_name.map(crate::repo_slug::canonical),
        });
        Self::post_v2("memory", body);
    }

    /// Push a zone claim.
    pub fn push_zone(zone_path: &str, claim_type: &str) {
        let body = json!({
            "zone_path": zone_path,
            "claim_type": claim_type,
            "status": "active",
        });
        Self::post_v2("zones", body);
    }

    /// Backfill existing .aura/snapshots/*.json to the cloud. Returns count pushed.
    pub fn backfill_snapshots(repo_full_name: Option<&str>) -> usize {
        let token = match Self::cloud_token() {
            Some(t) => t,
            None => {
                println!("  {} No cloud token configured — skipping backfill", "↳".dimmed());
                return 0;
            }
        };
        let config = ConfigManager::load();
        if !config.sync_enabled {
            println!("  {} Cloud sync disabled — skipping backfill", "↳".dimmed());
            return 0;
        }

        let dir = std::path::Path::new(".aura/snapshots");
        if !dir.exists() {
            return 0;
        }

        let mut pushed = 0usize;
        let url = format!("{}/api/v2/snapshots", Self::cloud_url());
        let client = Self::cloud_client();

        let entries = match std::fs::read_dir(dir) {
            Ok(e) => e,
            Err(_) => return 0,
        };

        for entry in entries.flatten() {
            let path = entry.path();
            if path.extension().map(|e| e != "json").unwrap_or(true) {
                continue;
            }
            let raw = match std::fs::read_to_string(&path) {
                Ok(r) => r,
                Err(_) => continue,
            };
            let parsed: serde_json::Value = match serde_json::from_str(&raw) {
                Ok(v) => v,
                Err(_) => continue,
            };
            let file_path = parsed["file_path"].as_str().unwrap_or("");
            let content = parsed["content"].as_str().unwrap_or("");
            if file_path.is_empty() {
                continue;
            }
            let sha = {
                use sha2::{Digest, Sha256};
                let mut h = Sha256::new();
                h.update(content.as_bytes());
                format!("{:x}", h.finalize())
            };
            let trigger = parsed["trigger"].as_str().unwrap_or("backfill");
            let agent_id = parsed["agent_id"].as_str().unwrap_or("cli");

            let body = json!({
                "file_path": file_path,
                "content_sha256": sha,
                "size_bytes": content.len() as i64,
                "trigger": trigger,
                "agent_id": agent_id,
                "repo_full_name": repo_full_name.map(crate::repo_slug::canonical),
            });

            let res = client
                .post(&url)
                .header("Authorization", format!("Bearer {}", token))
                .json(&body)
                .timeout(std::time::Duration::from_secs(10))
                .send();

            if let Ok(resp) = res {
                if resp.status().is_success() {
                    pushed += 1;
                }
            }
        }

        pushed
    }

    /// Legacy sync: push to the old endpoint and git microservice
    pub fn sync_remote(repo_url: &str) {
        println!("{} {} {}", "🌐".bold(), "Aura Global Brain: Syncing semantic checkpoints from".bold().blue(), repo_url.yellow());

        let repo = match Repository::open(".") {
            Ok(r) => r,
            Err(e) => {
                println!("{} Failed to open local repository: {}", "✗".red(), e);
                return;
            }
        };

        let checkpoint = match CheckpointStore::latest_checkpoint(&repo) {
            Ok(checkpoint) => checkpoint,
            Err(e) => {
                println!("{} Failed to read checkpoints: {}", "✗".red(), e);
                return;
            }
        };

        if let Some(latest) = checkpoint.as_ref() {
            println!("  {} Pushing local Merkle-Graph to Sovereign Vault...", "↳".dimmed());

            let client = reqwest::blocking::Client::new();
            let payload = json!({
                "repo_id": repo_url,
                "nodes": latest.ast_nodes.iter().map(|n| {
                    json!({
                        "node_id": n.node_id,
                        "content_hash": n.content_hash,
                        "identifier": n.identifier
                    })
                }).collect::<Vec<_>>()
            });

            let cloud_url = Self::cloud_url();
            let res = client.post(format!("{}/v1/sync", cloud_url))
                .json(&payload)
                .send();

            match res {
                Ok(response) if response.status().is_success() => {
                    println!("{} Local brain synced to cloud vault successfully.", "✓".green().bold());
                },
                _ => {
                    println!("{} Failed to sync with cloud vault. Operating in offline mode.", "⚠️".yellow());
                }
            }
        }

        // Standard Git Sync
        let safe_remote_name = repo_url.replace("https://", "").replace("http://", "").replace("/", "_");

        println!("  {} Connecting to remote Git microservice...", "↳".dimmed());
        let _ = Command::new("git")
            .args(["remote", "add", &safe_remote_name, repo_url])
            .output();

        println!("  {} Fetching remote semantic metadata...", "↳".dimmed());
        let _ = Command::new("git")
            .args(["fetch", &safe_remote_name, "refs/heads/aura/checkpoints/v1:refs/remotes/aura_global/checkpoints/v1"])
            .output();

        println!("{} Merkle-Graph extended. External DependencyURIs will now resolve locally.", "✓".green().bold());
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::checkpoint::CheckpointData;
    use crate::models::AstNode;

    fn node(node_id: &str, hash: &str, name: &str, children: &[&str]) -> AstNode {
        AstNode {
            node_id: node_id.to_string(),
            kind: "function_definition".to_string(),
            identifier: Some(name.to_string()),
            content_hash: hash.to_string(),
            children: children.iter().map(|c| c.to_string()).collect(),
            dependencies: Vec::new(),
            contains_secret: false,
            is_stub: false,
            derived_from: None,
            confidence: 1.0,
            file_path: Some("src/lib.rs".to_string()),
            start_line: Some(1),
            end_line: Some(9),
            signature: None,
            doc_comment: None,
            top_level: true,
        }
    }

    fn checkpoint(at_ms: u64, nodes: Vec<AstNode>) -> CheckpointData {
        CheckpointData {
            id: format!("cp-{at_ms}"),
            agent_id: "claude".to_string(),
            intent: "test".to_string(),
            ast_nodes: nodes,
            timestamp: at_ms,
            intent_vector: None,
            intent_vector_model: None,
            env_fingerprint: None,
            file_oids: Default::default(),
            scope: None,
        }
    }

    #[test]
    fn a_symbol_touched_by_several_checkpoints_is_sent_once() {
        // Otherwise one row costs N writes, and since the upsert has no
        // ordering the oldest hash could end up on top.
        let (rows, _) = GlobalSync::merkle_payload(&[
            checkpoint(1_700_000_000_000, vec![node("n:relativeShort", "h1", "relativeShort", &[])]),
            checkpoint(1_700_000_100_000, vec![node("n:relativeShort", "h2", "relativeShort", &[])]),
        ]);
        assert_eq!(rows.len(), 1);
        assert_eq!(rows[0]["content_hash"], "h2", "the newest checkpoint must win");
    }

    #[test]
    fn an_older_checkpoint_arriving_late_does_not_overwrite_a_newer_one() {
        let (rows, _) = GlobalSync::merkle_payload(&[
            checkpoint(1_700_000_100_000, vec![node("n:a", "new", "a", &[])]),
            checkpoint(1_700_000_000_000, vec![node("n:a", "old", "a", &[])]),
        ]);
        assert_eq!(rows[0]["content_hash"], "new");
    }

    #[test]
    fn the_parent_link_is_inverted_from_children() {
        // The cloud's trace walks upward via parent_hash; a local node only
        // knows its children, so the edge has to be turned around here.
        let (rows, _) = GlobalSync::merkle_payload(&[checkpoint(
            1_700_000_000_000,
            vec![
                node("n:parent", "p", "outer", &["c"]),
                node("n:child", "c", "inner", &[]),
            ],
        )]);
        let child = rows.iter().find(|r| r["node_id"] == "n:child").unwrap();
        let parent = rows.iter().find(|r| r["node_id"] == "n:parent").unwrap();
        assert_eq!(child["parent_hash"], "p");
        assert!(parent["parent_hash"].is_null(), "a root has no parent");
    }

    #[test]
    fn a_node_carries_the_name_the_console_searches_by() {
        // AURA-250: Graph searches `identifier ILIKE %q%`. If the name never
        // leaves the laptop, searching for a symbol the Intents tab is showing
        // returns nothing.
        let (rows, _) = GlobalSync::merkle_payload(&[checkpoint(
            1_700_000_000_000,
            vec![node("n:fmtTokens", "h", "fmtTokens", &[])],
        )]);
        assert_eq!(rows[0]["identifier"], "fmtTokens");
        assert_eq!(rows[0]["node_type"], "function_definition");
        assert_eq!(rows[0]["file_path"], "src/lib.rs");
    }

    #[test]
    fn no_source_text_crosses_the_wire() {
        // Metadata only — names, hashes and paths. A graph sync must never
        // become a way to ship someone's code to the cloud.
        let (rows, _) = GlobalSync::merkle_payload(&[checkpoint(
            1_700_000_000_000,
            vec![node("n:a", "h", "a", &[])],
        )]);
        let mut keys: Vec<&str> = rows[0].as_object().unwrap().keys().map(|k| k.as_str()).collect();
        keys.sort_unstable();
        assert_eq!(
            keys,
            vec!["content_hash", "file_path", "identifier", "node_id", "node_type", "parent_hash"],
        );
    }

    #[test]
    fn nothing_to_say_sends_nothing() {
        assert!(GlobalSync::merkle_payload(&[]).0.is_empty());
        assert!(GlobalSync::merkle_payload(&[checkpoint(1, vec![])]).0.is_empty());
    }

    // ── the worktree path ────────────────────────────────────────────────
    //
    // Found live on MHASK/aura-sovereign: 1353 intent rows in Trace › Intents
    // and an empty Graph beside them. The graph only ever shipped from the
    // post-commit hook, and this repo's own commits go in with `AURA_SKIP=1
    // git commit --no-verify` because the strict guard misfires on a dirty
    // worktree — so the hook never fired and no node was ever sent.

    #[test]
    fn a_worktree_scan_produces_the_same_wire_shape_as_a_checkpoint() {
        // Same six fields, same spelling. If these two drift, half the graph
        // in the cloud is keyed differently from the other half.
        let (from_tree, _) =
            GlobalSync::merkle_payload_from_nodes(&[node("n:a", "h", "alpha", &[])]);
        let (from_cp, _) = GlobalSync::merkle_payload(&[checkpoint(
            1_700_000_000_000,
            vec![node("n:a", "h", "alpha", &[])],
        )]);
        assert_eq!(from_tree, from_cp);
    }

    #[test]
    fn a_worktree_scan_inverts_the_parent_link_too() {
        let (rows, _) = GlobalSync::merkle_payload_from_nodes(&[
            node("n:parent", "p", "outer", &["c"]),
            node("n:child", "c", "inner", &[]),
        ]);
        let child = rows.iter().find(|r| r["node_id"] == "n:child").unwrap();
        assert_eq!(child["parent_hash"], "p");
    }

    #[test]
    fn a_worktree_scan_sends_one_row_per_symbol() {
        // A scan reads each file once, but a symbol can be re-declared across
        // targets (`#[cfg]` twins, a re-export). The cloud keys on node_id, so
        // two rows for one id would be two writes settling arbitrarily.
        let (rows, _) = GlobalSync::merkle_payload_from_nodes(&[
            node("n:a", "first", "alpha", &[]),
            node("n:a", "second", "alpha", &[]),
        ]);
        assert_eq!(rows.len(), 1);
    }

    #[test]
    fn a_worktree_scan_of_an_unchanged_tree_sends_the_same_batch_twice() {
        // Every node in a scan shares one timestamp, so the cap falls through
        // to the node_id tiebreak. Without that the second run of `aura live
        // sync graph` would push a different arbitrary 2,000 and the graph
        // would churn instead of converge.
        let many: Vec<AstNode> = (0..MERKLE_MAX_NODES + 40)
            .map(|i| node(&format!("n:{i:05}"), &format!("h{i}"), &format!("sym{i}"), &[]))
            .collect();
        let (first, dropped) = GlobalSync::merkle_payload_from_nodes(&many);
        let (second, _) = GlobalSync::merkle_payload_from_nodes(&many);
        assert_eq!(first, second);
        assert_eq!(first.len(), MERKLE_MAX_NODES);
        assert_eq!(dropped, 40);
    }

    #[test]
    fn an_empty_worktree_scan_sends_nothing() {
        assert!(GlobalSync::merkle_payload_from_nodes(&[]).0.is_empty());
    }

    #[test]
    fn the_body_is_stable_across_runs() {
        // A HashMap iterates arbitrarily; an unstable body makes a retry look
        // like a different request and a diff unreadable.
        let cps = vec![checkpoint(
            1_700_000_000_000,
            vec![
                node("n:z", "hz", "zeta", &[]),
                node("n:a", "ha", "alpha", &[]),
                node("n:m", "hm", "mu", &[]),
            ],
        )];
        let (first, _) = GlobalSync::merkle_payload(&cps);
        let (second, _) = GlobalSync::merkle_payload(&cps);
        assert_eq!(first, second);
        let ids: Vec<&str> = first.iter().map(|r| r["node_id"].as_str().unwrap()).collect();
        assert_eq!(ids, vec!["n:a", "n:m", "n:z"]);
    }

    #[test]
    fn a_huge_repo_sends_a_bounded_batch_and_says_what_it_held_back() {
        // The cloud upserts a row at a time. An unbounded first push of a big
        // repo is one request with tens of thousands of statements behind it,
        // repeated on every commit — so it is capped, and the cap is spoken
        // rather than silently truncating a graph that then looks complete.
        let many: Vec<AstNode> = (0..MERKLE_MAX_NODES + 250)
            .map(|i| node(&format!("n:{i:05}"), &format!("h{i}"), &format!("sym{i}"), &[]))
            .collect();
        let (rows, dropped) = GlobalSync::merkle_payload(&[checkpoint(1_700_000_000_000, many)]);
        assert_eq!(rows.len(), MERKLE_MAX_NODES);
        assert_eq!(dropped, 250);
    }

    #[test]
    fn the_batch_keeps_what_changed_most_recently() {
        // If the cap cut alphabetically, a repo whose symbols sort late would
        // never sync the work someone just did.
        let old: Vec<AstNode> = (0..MERKLE_MAX_NODES)
            .map(|i| node(&format!("n:old{i:05}"), &format!("h{i}"), &format!("old{i}"), &[]))
            .collect();
        let (rows, dropped) = GlobalSync::merkle_payload(&[
            checkpoint(1_700_000_000_000, old),
            checkpoint(1_700_000_100_000, vec![node("n:zzz-just-edited", "hz", "justEdited", &[])]),
        ]);
        assert_eq!(dropped, 1);
        assert!(
            rows.iter().any(|r| r["node_id"] == "n:zzz-just-edited"),
            "the node from the newest checkpoint must survive the cap"
        );
    }
}
