use crate::checkpoint::CheckpointStore;
use axum::{
    routing::{get, post},
    Router,
    response::{Html, IntoResponse, Json},
    extract::Json as ExtractJson,
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

pub async fn start_dashboard() {
    let app = Router::new()
        .route("/", get(serve_html))
        .route("/api/checkpoints", get(api_checkpoints))
        .route("/api/plan", get(api_plan))
        .route("/api/metrics", get(api_metrics))
        .route("/api/webhook/rollback", post(webhook_rollback));

    let addr = SocketAddr::from(([127, 0, 0, 1], 8090));
    println!("\n{} {}", "🚀".bold(), "Starting Aura Local Web Dashboard".bold().cyan());
    println!("  {} {}", "↳ URL:".dimmed(), "http://127.0.0.1:8090".green().bold().underline());
    println!("  {} API Hardening Active: Bound strictly to localhost.", "↳".dimmed());
    println!("  {} Webhook listening at /api/webhook/rollback", "↳".dimmed());
    println!("  {} Press Ctrl+C to stop the server.\n", "↳".dimmed());
    
    // Force flush stdout to ensure the AI agent sees the URL immediately before tokio blocks
    let _ = std::io::stdout().flush();
    
    let listener = tokio::net::TcpListener::bind(&addr).await.unwrap();
    axum::serve(listener, app).await.unwrap();
}

async fn serve_html() -> Html<&'static str> {
    Html(include_str!("../assets/aura-team-dashboard.html"))
}

async fn api_checkpoints() -> impl IntoResponse {
    let repo = Repository::open(".").unwrap();
    let checkpoints = CheckpointStore::get_all_checkpoints(&repo).unwrap_or_default();
    Json(checkpoints)
}

async fn api_plan() -> impl IntoResponse {
    match std::fs::read_to_string(".aura/plans/PLAN.md") {
        Ok(content) => Json(serde_json::json!({ "status": "ok", "content": content })),
        Err(_) => Json(serde_json::json!({ "status": "empty", "content": "" })),
    }
}

async fn api_metrics() -> impl IntoResponse {
    let repo = Repository::open(".").unwrap();
    let checkpoints = CheckpointStore::get_all_checkpoints(&repo).unwrap_or_default();
    
    let mut churn_map: HashMap<String, usize> = HashMap::new();
    
    // Simple churn metric: how many times a node appears across checkpoints
    for cp in &checkpoints {
        for node in &cp.ast_nodes {
            if let Some(ref ident) = node.identifier {
                *churn_map.entry(ident.clone()).or_insert(0) += 1;
            }
        }
    }
    
    let mut churn_vec: Vec<_> = churn_map.into_iter().collect();
    churn_vec.sort_by(|a, b| b.1.cmp(&a.1)); // Sort descending
    
    // Take top 10
    let top_churn = churn_vec.into_iter().take(10).collect::<Vec<_>>();
    
    Json(serde_json::json!({
        "total_checkpoints": checkpoints.len(),
        "top_churned_nodes": top_churn
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
