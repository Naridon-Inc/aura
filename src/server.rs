use crate::checkpoint::{CheckpointStore, SnapshotStore};
use crate::config::ConfigManager;
use crate::memory::MemoryManager;
use crate::session::SessionManager;
use axum::{
    routing::{get, post},
    Router,
    response::{Html, IntoResponse, Json},
    extract::{Json as ExtractJson, Query},
};
use git2::Repository;
use std::net::SocketAddr;
use serde::Deserialize;
use colored::Colorize;
use std::io::Write;
use std::collections::HashMap;

#[derive(Deserialize)]
pub struct WebhookPayload {
    pub snapshot_id: String,
}

#[derive(Deserialize)]
pub struct RewindParams {
    pub identifier: String,
    pub file: String,
}

#[derive(Deserialize)]
pub struct PaginationParams {
    pub page: Option<usize>,
    pub limit: Option<usize>,
}

pub async fn start_dashboard() {
    let app = Router::new()
        .route("/", get(serve_html))
        .route("/api/status", get(api_status))
        .route("/api/checkpoints", get(api_checkpoints))
        .route("/api/reviews", get(api_reviews))
        .route("/api/plan", get(api_plan))
        .route("/api/plans", get(api_plans))
        .route("/api/plans/active", get(api_plan))
        .route("/api/metrics", get(api_metrics))
        .route("/api/config", get(api_config))
        .route("/api/config", post(api_config_update))
        .route("/api/sessions", get(api_sessions))
        .route("/api/rewind", post(api_rewind))
        .route("/api/snapshots", get(api_snapshots))
        .route("/api/graph", get(api_graph))
        .route("/api/webhook/rollback", post(webhook_rollback));

    let addr = SocketAddr::from(([127, 0, 0, 1], 8090));
    println!("\n{} {}", "🚀".bold(), "Starting Aura Local Web Dashboard".bold().cyan());
    println!("  {} {}", "↳ URL:".dimmed(), "http://127.0.0.1:8090".green().bold().underline());
    println!("  {} API Hardening Active: Bound strictly to localhost.", "↳".dimmed());
    println!("  {} Webhook listening at /api/webhook/rollback", "↳".dimmed());
    println!("  {} Press Ctrl+C to stop the server.\n", "↳".dimmed());
    
    // Force flush stdout to ensure the AI agent sees the URL immediately before tokio blocks
    let _ = std::io::stdout().flush();
    
    let listener = match tokio::net::TcpListener::bind(&addr).await {
        Ok(l) => l,
        Err(e) => {
            eprintln!("{} Failed to bind to {}: {}", "Error:".red().bold(), addr, e);
            std::process::exit(1);
        }
    };
    if let Err(e) = axum::serve(listener, app).await {
        eprintln!("{} Server error: {}", "Error:".red().bold(), e);
        std::process::exit(1);
    }
}

async fn serve_html() -> Html<&'static str> {
    Html(include_str!("../assets/aura-team-dashboard.html"))
}

async fn api_checkpoints() -> impl IntoResponse {
    let repo = match Repository::open(".") {
        Ok(r) => r,
        Err(e) => return Json(serde_json::json!({ "error": format!("Failed to open repository: {}", e) })),
    };
    let checkpoints = CheckpointStore::get_all_checkpoints(&repo).unwrap_or_default();
    Json(serde_json::json!(checkpoints))
}

async fn api_plan() -> impl IntoResponse {
    // Check for active milestone XML first, then PLAN.md
    let active = std::fs::read_dir(".aura/plans")
        .ok()
        .and_then(|entries| {
            entries.flatten()
                .filter(|e| e.file_name().to_string_lossy().ends_with(".xml") || e.file_name().to_string_lossy() == "PLAN.md")
                .next()
        })
        .and_then(|e| std::fs::read_to_string(e.path()).ok());

    match active {
        Some(content) => Json(serde_json::json!({ "status": "ok", "active_plan": { "content": content } })),
        None => Json(serde_json::json!({ "status": "empty", "active_plan": null })),
    }
}

async fn api_plans() -> impl IntoResponse {
    let mut plans = Vec::new();
    if let Ok(entries) = std::fs::read_dir(".aura/plans") {
        for entry in entries.flatten() {
            let name = entry.file_name().to_string_lossy().to_string();
            if let Ok(content) = std::fs::read_to_string(entry.path()) {
                plans.push(serde_json::json!({
                    "name": name,
                    "content": content,
                    "size": content.len(),
                }));
            }
        }
    }
    Json(serde_json::json!({ "plans": plans, "total": plans.len() }))
}

async fn api_metrics() -> impl IntoResponse {
    let repo = match Repository::open(".") {
        Ok(r) => r,
        Err(e) => return Json(serde_json::json!({ "error": format!("Failed to open repository: {}", e) })),
    };
    let checkpoints = CheckpointStore::get_all_checkpoints(&repo).unwrap_or_default();
    
    // Rich churn tracking: count + last-seen metadata per node
    let mut churn_map: HashMap<String, (usize, serde_json::Value)> = HashMap::new();

    let system_nodes: std::collections::HashSet<&str> = [
        "fs", "path", "os", "http", "https", "url", "util", "crypto", "stream",
        "events", "buffer", "child_process", "cluster", "dgram", "dns", "net",
        "readline", "tls", "zlib", "assert", "console", "process", "require",
        "module", "exports", "import", "default", "self", "this", "super",
        "std", "crate", "pub", "mod", "use", "fn", "let", "const", "var",
        "async", "await", "return", "if", "else", "for", "while", "match",
        "React", "useState", "useEffect", "useCallback", "useRef", "useMemo",
        "{ event, history }", "{ shopId, fixId, force }",
    ].into_iter().collect();

    // Also track dependency reference counts (how many nodes call this one)
    let mut ref_count_map: HashMap<String, usize> = HashMap::new();

    for cp in &checkpoints {
        for node in &cp.ast_nodes {
            // Count incoming references
            for dep in &node.dependencies {
                *ref_count_map.entry(dep.name.clone()).or_insert(0) += 1;
            }

            if let Some(ref ident) = node.identifier {
                if ident.len() <= 3
                    || system_nodes.contains(ident.as_str())
                    || ident.starts_with('{')
                    || ident.starts_with('(')
                    || ident.starts_with('[')
                    || node.kind == "variable_declarator"
                    || node.kind == "lexical_declaration"
                    || node.kind == "assignment_expression"
                {
                    continue;
                }
                let entry = churn_map.entry(ident.clone()).or_insert((0, serde_json::json!({})));
                entry.0 += 1;
                // Keep the latest metadata for this node
                entry.1 = serde_json::json!({
                    "kind": node.kind,
                    "file_path": node.file_path,
                    "start_line": node.start_line,
                    "end_line": node.end_line,
                    "signature": node.signature,
                    "doc_comment": node.doc_comment,
                    "is_stub": node.is_stub,
                    "dep_count": node.dependencies.len(),
                });
            }
        }
    }

    let mut churn_vec: Vec<_> = churn_map.into_iter().collect();
    churn_vec.sort_by(|a, b| (b.1).0.cmp(&(a.1).0));

    // Build rich top_churned_nodes with metadata
    let top_churn: Vec<serde_json::Value> = churn_vec.into_iter().take(10).map(|(name, (count, mut meta))| {
        meta["ref_count"] = serde_json::json!(ref_count_map.get(&name).copied().unwrap_or(0));
        serde_json::json!({
            "name": name,
            "count": count,
            "kind": meta["kind"],
            "file_path": meta["file_path"],
            "start_line": meta["start_line"],
            "end_line": meta["end_line"],
            "signature": meta["signature"],
            "doc_comment": meta["doc_comment"],
            "is_stub": meta["is_stub"],
            "dep_count": meta["dep_count"],
            "ref_count": meta["ref_count"],
        })
    }).collect();

    // Legacy format for backward compat
    let top_churn_legacy: Vec<(String, usize)> = top_churn.iter().map(|n| {
        (n["name"].as_str().unwrap_or("").to_string(), n["count"].as_u64().unwrap_or(0) as usize)
    }).collect();
    
    // Build review history from .aura/reviews/ and last_review.json
    let mut review_history = Vec::new();
    if let Ok(content) = std::fs::read_to_string(".aura/last_review.json") {
        if let Ok(review) = serde_json::from_str::<serde_json::Value>(&content) {
            review_history.push(serde_json::json!({
                "risk_score": review.get("risk_score").and_then(|v| v.as_i64()).unwrap_or(0),
                "bug_count": review.get("bugs").and_then(|v| v.as_array()).map(|a| a.len()).unwrap_or(0),
                "security_count": review.get("security").and_then(|v| v.as_array()).map(|a| a.len()).unwrap_or(0),
                "violation_count": review.get("violations").and_then(|v| v.as_array()).map(|a| a.len()).unwrap_or(0),
                "changes": review.get("files_changed").and_then(|v| v.as_i64()).unwrap_or(0),
                "created_at": review.get("timestamp").unwrap_or(&serde_json::json!("")),
            }));
        }
    }

    // Build node kind distribution from latest checkpoint
    let mut kind_dist: HashMap<String, usize> = HashMap::new();
    if let Some(latest) = checkpoints.last() {
        for node in &latest.ast_nodes {
            *kind_dist.entry(node.kind.clone()).or_insert(0) += 1;
        }
    }

    Json(serde_json::json!({
        "total_checkpoints": checkpoints.len(),
        "total_reviews": review_history.len(),
        "top_churned_nodes": top_churn_legacy,
        "top_churned_nodes_rich": top_churn,
        "review_history": review_history,
        "node_kind_distribution": kind_dist,
    }))
}

/// Returns the Merkle-Graph: nodes + edges for visualization
async fn api_graph() -> impl IntoResponse {
    let repo = match Repository::open(".") {
        Ok(r) => r,
        Err(e) => return Json(serde_json::json!({ "error": format!("Failed to open repository: {}", e) })),
    };
    let checkpoints = CheckpointStore::get_all_checkpoints(&repo).unwrap_or_default();

    // Use latest checkpoint for graph state
    let latest = checkpoints.last();
    let ast_nodes = match latest {
        Some(cp) => &cp.ast_nodes,
        None => return Json(serde_json::json!({ "nodes": [], "edges": [] })),
    };

    let system_nodes: std::collections::HashSet<&str> = [
        "fs", "path", "os", "http", "https", "url", "util", "crypto", "stream",
        "events", "buffer", "child_process", "net", "console", "process", "require",
        "module", "exports", "import", "default", "self", "this", "super",
        "std", "crate", "pub", "mod", "use", "fn", "let", "const", "var",
        "async", "await", "return", "if", "else", "for", "while", "match",
        "React", "useState", "useEffect", "useCallback", "useRef", "useMemo",
    ].into_iter().collect();

    // Build node list (only named, non-system nodes)
    let mut graph_nodes = Vec::new();
    let mut node_names: std::collections::HashSet<String> = std::collections::HashSet::new();

    // Count how many checkpoints each node appears in (churn)
    let mut churn_map: HashMap<String, usize> = HashMap::new();
    for cp in &checkpoints {
        for node in &cp.ast_nodes {
            if let Some(ref ident) = node.identifier {
                *churn_map.entry(ident.clone()).or_insert(0) += 1;
            }
        }
    }

    for node in ast_nodes {
        if let Some(ref ident) = node.identifier {
            if ident.len() <= 2 || system_nodes.contains(ident.as_str())
                || ident.starts_with('{') || ident.starts_with('(')
                || node.kind == "variable_declarator"
                || node.kind == "lexical_declaration"
                || node.kind == "assignment_expression"
            {
                continue;
            }
            node_names.insert(ident.clone());
            graph_nodes.push(serde_json::json!({
                "id": ident,
                "kind": node.kind,
                "file_path": node.file_path,
                "start_line": node.start_line,
                "signature": node.signature,
                "doc_comment": node.doc_comment,
                "is_stub": node.is_stub,
                "contains_secret": node.contains_secret,
                "content_hash": &node.content_hash[..std::cmp::min(12, node.content_hash.len())],
                "dep_count": node.dependencies.len(),
                "churn": churn_map.get(ident).copied().unwrap_or(0),
            }));
        }
    }

    // Build edge list (only between known nodes)
    let mut edges = Vec::new();
    for node in ast_nodes {
        if let Some(ref source_ident) = node.identifier {
            if !node_names.contains(source_ident) { continue; }
            for dep in &node.dependencies {
                if node_names.contains(&dep.name) && dep.name != *source_ident {
                    edges.push(serde_json::json!({
                        "source": source_ident,
                        "target": dep.name,
                    }));
                }
            }
        }
    }

    Json(serde_json::json!({
        "nodes": graph_nodes,
        "edges": edges,
        "checkpoint_id": latest.map(|c| &c.id),
        "total_nodes": graph_nodes.len(),
        "total_edges": edges.len(),
    }))
}

async fn api_status() -> impl IntoResponse {
    let config = ConfigManager::load();
    let repo = Repository::open(".").ok();
    let checkpoints = repo.as_ref()
        .map(|r| CheckpointStore::get_all_checkpoints(r).unwrap_or_default())
        .unwrap_or_default();
    let session = SessionManager::get_active_session();
    let memory = MemoryManager::compact_summary();
    let snapshots = SnapshotStore::get_all_snapshots();

    Json(serde_json::json!({
        "data": {
            "logic_nodes_tracked": checkpoints.last().map(|c| c.ast_nodes.len()).unwrap_or(0),
            "total_checkpoints": checkpoints.len(),
            "total_snapshots": snapshots.len(),
            "strict_gatekeeper_mode": config.strict_gatekeeper_mode,
            "dev_mode": config.dev_mode,
            "default_base": "main",
            "session": session.map(|s| serde_json::json!({
                "session_id": s.session_id,
                "agent_id": s.agent_id,
                "phase": format!("{:?}", s.phase),
                "files_touched": s.files_touched.len(),
            })),
            "memory": memory,
        }
    }))
}

async fn api_reviews() -> impl IntoResponse {
    // Reviews are stored in .aura/reviews/ or generated on-demand
    let reviews_dir = ".aura/reviews";
    let mut reviews = Vec::new();

    if let Ok(entries) = std::fs::read_dir(reviews_dir) {
        for entry in entries.flatten() {
            if entry.path().extension().map(|e| e == "json").unwrap_or(false) {
                if let Ok(content) = std::fs::read_to_string(entry.path()) {
                    if let Ok(review) = serde_json::from_str::<serde_json::Value>(&content) {
                        reviews.push(review);
                    }
                }
            }
        }
    }

    // Also check last_review.json
    if let Ok(content) = std::fs::read_to_string(".aura/last_review.json") {
        if let Ok(review) = serde_json::from_str::<serde_json::Value>(&content) {
            reviews.push(review);
        }
    }

    Json(serde_json::json!({
        "reviews": reviews,
        "total": reviews.len(),
    }))
}

async fn api_config() -> impl IntoResponse {
    let config = ConfigManager::load();
    Json(serde_json::json!({
        "config": {
            "ai_provider": config.ai_provider,
            "strict_gatekeeper_mode": config.strict_gatekeeper_mode,
            "use_local_embeddings": config.use_local_embeddings,
            "dev_mode": config.dev_mode,
            "telemetry_enabled": config.telemetry_enabled,
            "model_architect": config.model_architect,
            "model_researcher": config.model_researcher,
            "model_auditor": config.model_auditor,
            "model_arbitrator": config.model_arbitrator,
            "has_gemini_key": ConfigManager::get_api_key("gemini").is_some(),
            "has_anthropic_key": ConfigManager::get_api_key("anthropic").is_some(),
            "has_openai_key": ConfigManager::get_api_key("openai").is_some(),
            "has_mercury_key": ConfigManager::get_api_key("mercury").is_some(),
        }
    }))
}

async fn api_config_update(ExtractJson(updates): ExtractJson<serde_json::Value>) -> impl IntoResponse {
    let mut config = ConfigManager::load();

    if let Some(v) = updates.get("strict_gatekeeper_mode").and_then(|v| v.as_bool()) { config.strict_gatekeeper_mode = v; }
    if let Some(v) = updates.get("dev_mode").and_then(|v| v.as_bool()) { config.dev_mode = v; }
    if let Some(v) = updates.get("telemetry_enabled").and_then(|v| v.as_bool()) { config.telemetry_enabled = v; }
    if let Some(v) = updates.get("use_local_embeddings").and_then(|v| v.as_bool()) { config.use_local_embeddings = v; }
    if let Some(v) = updates.get("ai_provider").and_then(|v| v.as_str()) { config.ai_provider = Some(v.to_string()); }
    if let Some(v) = updates.get("model_architect").and_then(|v| v.as_str()) { config.model_architect = Some(v.to_string()); }
    if let Some(v) = updates.get("model_researcher").and_then(|v| v.as_str()) { config.model_researcher = Some(v.to_string()); }
    if let Some(v) = updates.get("model_auditor").and_then(|v| v.as_str()) { config.model_auditor = Some(v.to_string()); }
    if let Some(v) = updates.get("model_arbitrator").and_then(|v| v.as_str()) { config.model_arbitrator = Some(v.to_string()); }

    ConfigManager::save(&config);
    Json(serde_json::json!({ "status": "ok" }))
}

async fn api_sessions() -> impl IntoResponse {
    let sessions = SessionManager::list_sessions();
    let session_data: Vec<_> = sessions.iter().map(|s| serde_json::json!({
        "session_id": s.session_id,
        "agent_id": s.agent_id,
        "phase": format!("{:?}", s.phase),
        "started_at": s.started_at,
        "last_activity": s.last_activity,
        "files_touched": s.files_touched,
        "checkpoint_count": s.checkpoint_count,
    })).collect();

    Json(serde_json::json!({
        "sessions": session_data,
        "total": session_data.len(),
    }))
}

async fn api_rewind(ExtractJson(params): ExtractJson<RewindParams>) -> impl IntoResponse {
    match crate::checkpoint::SnapshotStore::find_snapshot_with_node(&params.file, &params.identifier) {
        Some(snapshot) => {
            // Read current file content
            let current = std::fs::read_to_string(&params.file).unwrap_or_default();
            Json(serde_json::json!({
                "status": "ok",
                "identifier": params.identifier,
                "file": params.file,
                "old_source": current,
                "restored_source": snapshot.content,
                "snapshot_timestamp": snapshot.timestamp,
            }))
        }
        None => Json(serde_json::json!({
            "status": "error",
            "message": format!("No snapshot found containing '{}' in '{}'", params.identifier, params.file),
        })),
    }
}

async fn api_snapshots() -> impl IntoResponse {
    let snapshots = SnapshotStore::get_all_snapshots();
    let snap_data: Vec<_> = snapshots.iter().take(50).map(|s| serde_json::json!({
        "file_path": s.file_path,
        "timestamp": s.timestamp,
        "trigger": s.trigger,
        "agent_id": s.agent_id,
    })).collect();

    Json(serde_json::json!({
        "snapshots": snap_data,
        "total": snapshots.len(),
    }))
}

async fn webhook_rollback(ExtractJson(payload): ExtractJson<WebhookPayload>) -> impl IntoResponse {
    println!("\n🚨 [WEBHOOK TRIGGERED] Production Incident Detected!");
    let branch_name = format!("aura/snapshot/{}", payload.snapshot_id);
    println!("⏪ Aura Autonomous Arbitrator: Rolling back to safety snapshot: {}", branch_name);
    
    let status = std::process::Command::new("git").args(["reset", "--hard", &branch_name]).output();
    
    match status {
        Ok(s) if s.status.success() => {
            println!("✓ Autonomous rollback successful. Production restored.");
            Json(serde_json::json!({ "status": "success", "message": "Rollback complete" }))
        },
        _ => {
            println!("✗ Autonomous rollback failed.");
            Json(serde_json::json!({ "status": "error", "message": "Rollback failed" }))
        }
    }
}
