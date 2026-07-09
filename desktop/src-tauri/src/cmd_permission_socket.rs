//! UNIX socket server that bridges the `aura-shell-mcp` shim into the
//! main aura-shell process. The shim (spawned by claude via
//! `--mcp-config`) writes one JSON envelope per prompt — we register it
//! in `PermissionRegistry`, push the prompt to React, and write the
//! user's decision back so the shim returns it to claude.
//!
//! Wire layout:
//!
//!   claude  ──stdio JSON-RPC──▶  aura-shell-mcp
//!                                       │
//!                                       │ UNIX socket
//!                                       │ {channel, tool_name, input}\n
//!                                       ▼
//!                                  this listener
//!                                       │
//!                                       ├─emit `permission:prompt`──▶ React
//!                                       │
//!                                       └─await oneshot ◀─ React `permission_respond`
//!                                       │
//!                                       │ {behavior, ...}\n
//!                                       ▼
//!                                  aura-shell-mcp
//!
//! Path: `~/.aura/run/aura-shell-mcp.sock`. Parent dir is created on
//! demand; a stale socket is unlinked before bind so a previous crash
//! doesn't wedge the listener.

use std::path::PathBuf;
use std::time::{SystemTime, UNIX_EPOCH};

use serde::Deserialize;
use serde_json::{json, Value};
use tauri::{AppHandle, Manager};
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio::net::{UnixListener, UnixStream};
use uuid::Uuid;

use crate::cli_bridge::{
    AskUserPayload, BridgeRegistry, PlanDecision, ProposePlanPayload,
};
use crate::cmd_permission::{
    emit_prompt, PendingPrompt, PermissionDecision, PermissionRegistry,
};

/// JSON envelope the shim writes. `prompt_id` is filled in by us — the
/// shim doesn't know one yet.
#[derive(Deserialize)]
struct ShimRequest {
    #[serde(default)]
    channel: String,
    tool_name: String,
    #[serde(default)]
    input: Value,
}

/// Resolve the socket path. macOS+Linux only — Tauri's Windows shim
/// would use a TCP loopback fallback, but the rest of the build is
/// already gated by `cfg(unix)` features in `cmd_agent_stream.rs`.
pub fn socket_path() -> PathBuf {
    let mut p = dirs::home_dir().unwrap_or_else(|| PathBuf::from("."));
    p.push(".aura");
    p.push("run");
    p.push("aura-shell-mcp.sock");
    p
}

/// Spawn the listener task. Idempotent — calling twice would race on
/// the bind, so we only call this once from `lib.rs::run()` setup.
/// Uses Tauri's runtime-agnostic spawn since the `setup` hook runs
/// before tokio's reactor is registered as the thread-local.
pub fn start(app: AppHandle) {
    tauri::async_runtime::spawn(async move {
        let path = socket_path();
        if let Some(parent) = path.parent() {
            let _ = tokio::fs::create_dir_all(parent).await;
        }
        // Remove stale socket from a previous run; bind(2) refuses to
        // claim the path otherwise.
        let _ = tokio::fs::remove_file(&path).await;
        let listener = match UnixListener::bind(&path) {
            Ok(l) => l,
            Err(e) => {
                tracing::error!(
                    "permission socket bind failed at {}: {e}",
                    path.display()
                );
                return;
            }
        };
        tracing::info!("permission socket listening at {}", path.display());
        loop {
            match listener.accept().await {
                Ok((stream, _)) => {
                    let app_for_conn = app.clone();
                    tokio::spawn(async move {
                        if let Err(e) = handle_connection(app_for_conn, stream).await {
                            tracing::warn!("permission socket conn: {e}");
                        }
                    });
                }
                Err(e) => {
                    tracing::warn!("permission socket accept: {e}");
                    // Don't busy-loop on permanent errors — yield then retry.
                    tokio::time::sleep(std::time::Duration::from_millis(100)).await;
                }
            }
        }
    });
}

async fn handle_connection(app: AppHandle, stream: UnixStream) -> Result<(), String> {
    let (reader_half, mut writer_half) = stream.into_split();
    let mut reader = BufReader::new(reader_half);
    let mut line = String::new();
    reader
        .read_line(&mut line)
        .await
        .map_err(|e| format!("read: {e}"))?;

    // Discriminate on `kind`. Absent (= legacy permission shim) → run the
    // existing permission flow. Present → dispatch to the Manager bridge.
    let raw: Value = serde_json::from_str(line.trim())
        .map_err(|e| format!("parse envelope: {e}"))?;
    let kind = raw.get("kind").and_then(|s| s.as_str()).unwrap_or("permission");
    match kind {
        "ask_user" => {
            let payload: AskUserPayload = serde_json::from_value(raw)
                .map_err(|e| format!("parse ask_user: {e}"))?;
            return handle_ask_user(app, payload, &mut writer_half).await;
        }
        "propose_plan" => {
            let payload: ProposePlanPayload = serde_json::from_value(raw)
                .map_err(|e| format!("parse propose_plan: {e}"))?;
            return handle_propose_plan(app, payload, &mut writer_half).await;
        }
        _ => {}
    }
    let req: ShimRequest = serde_json::from_value(raw)
        .map_err(|e| format!("parse shim request: {e}"))?;

    let registry: tauri::State<'_, PermissionRegistry> = app.state();

    // Auto-allow short-circuit: prior AllowAlways decision means we
    // never bother the user. The shim still needs a response shape.
    if registry.is_auto_allowed(&req.channel, &req.tool_name) {
        let resp = json!({
            "behavior": "allow",
            "updatedInput": req.input,
        });
        write_line(&mut writer_half, &resp).await?;
        return Ok(());
    }

    let prompt_id = format!("perm-{}", Uuid::new_v4());
    let now = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs() as i64)
        .unwrap_or(0);
    let meta = PendingPrompt {
        prompt_id: prompt_id.clone(),
        channel: req.channel.clone(),
        tool_name: req.tool_name.clone(),
        input: req.input.clone(),
        ts: now,
    };
    let rx = registry.enqueue(meta.clone());
    emit_prompt(&app, &meta);

    // Wait for the user's click. Sender half lives in PermissionRegistry
    // until `permission_respond` removes the slot and resolves us.
    let response = match rx.await {
        Ok(r) => r,
        Err(_) => {
            // Slot was dropped without a decision — treat as deny so
            // claude doesn't sit forever on a vanished prompt.
            let resp = json!({
                "behavior": "deny",
                "message": "aura-shell prompt was dropped before user responded",
            });
            write_line(&mut writer_half, &resp).await?;
            return Ok(());
        }
    };

    let payload = match response.decision {
        PermissionDecision::Allow | PermissionDecision::AllowAlways => json!({
            "behavior": "allow",
            "updatedInput": response.updated_input.unwrap_or(req.input),
        }),
        PermissionDecision::Deny => json!({
            "behavior": "deny",
            "message": "User denied the tool call from aura-shell",
        }),
    };
    write_line(&mut writer_half, &payload).await?;
    Ok(())
}

async fn write_line<W>(w: &mut W, v: &Value) -> Result<(), String>
where
    W: AsyncWriteExt + Unpin,
{
    let mut bytes = serde_json::to_vec(v).map_err(|e| format!("encode: {e}"))?;
    bytes.push(b'\n');
    w.write_all(&bytes).await.map_err(|e| format!("write: {e}"))?;
    w.flush().await.map_err(|e| format!("flush: {e}"))?;
    Ok(())
}

// ── Manager bridge handlers ────────────────────────────────────────────

async fn handle_ask_user<W>(
    app: AppHandle,
    payload: AskUserPayload,
    writer: &mut W,
) -> Result<(), String>
where
    W: AsyncWriteExt + Unpin,
{
    let shape = match payload.shape.as_str() {
        "choice" => crate::manager::QuestionKind::Choice,
        "multi_choice" => crate::manager::QuestionKind::MultiChoice,
        _ => crate::manager::QuestionKind::Text,
    };
    let answer = ask_user_blocking(
        &app,
        &payload.session_id,
        payload.question,
        payload.options,
        shape,
    )
    .await;
    write_line(writer, &json!({ "answer": answer })).await
}

/// Project a question onto the Manager session and block until the user
/// answers it (or a 60-min timeout returns a sentinel so the brain never
/// hangs forever). Shared by the CLI socket bridge (`aura ask-user`) and
/// the native brain's in-process tool loop — both register a
/// [`BridgeRegistry`] waiter and set `from_cli: true` so
/// `manager_answer_question` routes the answer back through the same
/// waiter instead of synthesizing a legacy tool_result. The existing
/// QuestionCard renders off `pending_question`, so neither caller needs
/// any frontend work.
pub async fn ask_user_blocking(
    app: &AppHandle,
    session_id: &str,
    question: String,
    options: Vec<String>,
    kind: crate::manager::QuestionKind,
) -> String {
    // A single question is just a 1-item set — delegate so both paths share
    // one waiter + pending-question shape.
    ask_user_items_blocking(
        app,
        session_id,
        vec![crate::manager::QuestionItem {
            question,
            options,
            kind,
            header: None,
        }],
    )
    .await
}

/// Project a clubbed set of 1–4 questions onto the Manager session and block
/// until the user answers them all (the QuestionCard joins the per-question
/// answers into one string before posting). The native brain's tool loop
/// uses this directly for batched `ask_user` calls; the CLI socket bridge
/// reaches it via the single-question [`ask_user_blocking`] wrapper. The
/// top-level `question`/`options`/`kind` mirror `items[0]` so the existing
/// QuestionCard fallback + answer-routing keep working unchanged.
pub async fn ask_user_items_blocking(
    app: &AppHandle,
    session_id: &str,
    items: Vec<crate::manager::QuestionItem>,
) -> String {
    let bridge: tauri::State<'_, BridgeRegistry> = app.state();
    let request_id = format!("ask-{}", Uuid::new_v4());
    let rx = bridge.register_question(request_id.clone());
    let first = items.first().cloned().unwrap_or_else(|| {
        crate::manager::QuestionItem {
            question: "(empty question)".to_string(),
            options: Vec::new(),
            kind: crate::manager::QuestionKind::Text,
            header: None,
        }
    });
    let pq = crate::manager::PendingQuestion {
        tool_use_id: request_id.clone(),
        question: first.question,
        options: first.options,
        kind: first.kind,
        at: SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map(|d| d.as_secs())
            .unwrap_or(0),
        from_cli: true,
        items,
    };
    if let Err(e) = crate::cmd_manager::set_pending_question(app, session_id, pq) {
        eprintln!("aura-shell: ask_user set_pending_question failed: {e}");
        return String::new();
    }
    match tokio::time::timeout(std::time::Duration::from_secs(3600), rx).await {
        Ok(Ok(s)) => s,
        Ok(Err(_)) => "(no answer)".to_string(),
        Err(_) => {
            eprintln!("aura-shell: ask-user oneshot timed out after 60min");
            "(no answer — timed out)".to_string()
        }
    }
}

async fn handle_propose_plan<W>(
    app: AppHandle,
    payload: ProposePlanPayload,
    writer: &mut W,
) -> Result<(), String>
where
    W: AsyncWriteExt + Unpin,
{
    let decision = propose_plan_blocking(&app, payload).await;
    write_line(writer, &plan_decision_response(&decision)).await
}

/// Project a plan onto the Manager session — running Aura's Scout
/// architectural pre-review first when the plan is substantial — and block
/// until the user clicks Build or Cancel (a 60-min timeout treats
/// no-decision as Cancel). Shared by the CLI socket bridge
/// (`aura propose-plan`) and the native brain's in-process tool loop, so
/// the **same** flow fires whichever brain proposed: Scout fan-out →
/// PlanCard → Build mints the dependency-ordered a2a tasks the Crew runs.
/// On Build the returned [`PlanDecision`] carries those task ids. The
/// existing PlanCard renders off `pending_plan`, so neither caller needs
/// frontend work.
pub async fn propose_plan_blocking(app: &AppHandle, payload: ProposePlanPayload) -> PlanDecision {
    let bridge: tauri::State<'_, BridgeRegistry> = app.state();
    let request_id = format!("plan-{}", Uuid::new_v4());
    let rx = bridge.register_plan(request_id.clone());
    let session_id = payload.session_id.clone();

    // Bucket A1 — Scout eligibility check. Branch BEFORE we set
    // pending_plan: if eligible, hand off to the parallel specialist
    // pre-review and let the bridge waiter stay parked. Scout promotes
    // the (annotated) draft into pending_plan once findings are
    // consolidated, at which point the existing Build/Cancel UI fires
    // resolve_plan and we unblock below.
    let mut scout_owns = false;
    if scout_eligible(&payload) {
        match crate::manager::scout::start_scout(app, &session_id, request_id.clone(), payload.clone())
            .await
        {
            Ok(()) => scout_owns = true,
            // Scout failed to spawn — fail open by falling through to the
            // direct-PlanCard path so the user isn't blocked.
            Err(e) => eprintln!("aura-shell: scout start failed, falling through: {e}"),
        }
    }

    if !scout_owns {
        let mut todos: Vec<crate::manager::PendingPlanTodo> = payload
            .todos
            .into_iter()
            .map(|t| crate::manager::PendingPlanTodo {
                description: t.description,
                agent: t.agent,
                file_refs: t.file_refs,
                assignee: t.assignee,
                suggested_provider: None,
                goal: t.goal,
                acceptance: t.acceptance,
                subtasks: t
                    .subtasks
                    .into_iter()
                    .map(|s| crate::manager::PendingPlanSubtask {
                        description: s.description,
                        agent: s.agent,
                        goal: s.goal,
                        acceptance: s.acceptance,
                    })
                    .collect(),
            })
            .collect();
        // Bucket G2 — annotate each todo with its historical best provider
        // when ≥10 samples exist. Best-effort: if `aura skill stats` fails
        // (cloud down, network), suggestions stay None and the brain's
        // original `agent` pick is what gets dispatched.
        crate::manager::skill::annotate_todos_with_suggestions(&mut todos);

        if let Err(e) = crate::cmd_manager::set_pending_plan(
            app,
            &session_id,
            crate::manager::PendingPlan {
                id: request_id.clone(),
                title: payload.title,
                summary: payload.summary,
                objective: payload.objective,
                baseline: payload.baseline,
                architecture_mermaid: payload.architecture_mermaid,
                phases: payload
                    .phases
                    .into_iter()
                    .map(|p| crate::manager::PlanPhase {
                        title: p.title,
                        body: p.body,
                        file_refs: p.file_refs,
                    })
                    .collect(),
                deliverables: payload.deliverables,
                tests: payload.tests,
                todos,
                parallelism: crate::manager::PlanParallelism::Auto,
                // Inventory blocker #3 — fresh plans land unapproved. The
                // user fills these in via `manager_approve_plan` on the
                // PlanCard.
                approved_by: None,
                approved_at: None,
                at: SystemTime::now()
                    .duration_since(UNIX_EPOCH)
                    .map(|d| d.as_secs())
                    .unwrap_or(0),
            },
        ) {
            eprintln!("aura-shell: propose_plan set_pending_plan failed: {e}");
            return PlanDecision::Cancel;
        }
    }

    match tokio::time::timeout(std::time::Duration::from_secs(3600), rx).await {
        Ok(Ok(d)) => d,
        Ok(Err(_)) => PlanDecision::Cancel,
        Err(_) => {
            eprintln!("aura-shell: propose-plan oneshot timed out after 60min");
            PlanDecision::Cancel
        }
    }
}

/// Socket response shape for a resolved plan decision — `action: build`
/// threads the minted a2a ids back to the CLI brain so it can spawn
/// subagents tagged with the cloud task id; `action: cancel` is bare.
fn plan_decision_response(decision: &PlanDecision) -> Value {
    match decision {
        PlanDecision::Build {
            a2a_task_ids,
            plan_task_id,
        } => json!({
            "action": "build",
            "a2a_task_ids": a2a_task_ids,
            "plan_task_id": plan_task_id,
        }),
        PlanDecision::Cancel => json!({ "action": "cancel" }),
    }
}

/// Bucket A1 — eligibility heuristic. Match the plan doc's spec
/// exactly: ≥3 file refs across all phases+todos, OR a deliverable
/// that adds a new feature ("Add user invites", "New OAuth flow").
/// `force_skip_scout` short-circuits to false so Scout's own internal
/// "summary-of-findings" plan doesn't recurse into another Scout.
fn scout_eligible(payload: &ProposePlanPayload) -> bool {
    if payload.force_skip_scout {
        return false;
    }
    let file_refs_count: usize = payload
        .phases
        .iter()
        .map(|p| p.file_refs.len())
        .sum::<usize>()
        + payload
            .todos
            .iter()
            .map(|t| t.file_refs.len())
            .sum::<usize>();
    if file_refs_count >= 3 {
        return true;
    }
    payload.deliverables.iter().any(|d| {
        let lower = d.trim().to_ascii_lowercase();
        lower.starts_with("add ") || lower.starts_with("new ")
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::cli_bridge::{PlanPhasePayload, PlanTodo};

    fn payload() -> ProposePlanPayload {
        ProposePlanPayload {
            session_id: "s".into(),
            title: "t".into(),
            summary: String::new(),
            objective: None,
            baseline: None,
            architecture_mermaid: None,
            phases: vec![],
            deliverables: vec![],
            tests: vec![],
            todos: vec![],
            force_skip_scout: false,
        }
    }

    #[test]
    fn scout_skipped_when_force_flag() {
        let mut p = payload();
        p.force_skip_scout = true;
        p.phases = vec![PlanPhasePayload {
            title: "p".into(),
            body: String::new(),
            file_refs: vec!["a".into(), "b".into(), "c".into(), "d".into()],
        }];
        assert!(!scout_eligible(&p));
    }

    #[test]
    fn scout_fires_at_three_file_refs() {
        let mut p = payload();
        p.phases = vec![PlanPhasePayload {
            title: "p".into(),
            body: String::new(),
            file_refs: vec!["a".into(), "b".into(), "c".into()],
        }];
        assert!(scout_eligible(&p));
    }

    #[test]
    fn scout_skips_with_two_file_refs_no_add_deliverable() {
        let mut p = payload();
        p.phases = vec![PlanPhasePayload {
            title: "p".into(),
            body: String::new(),
            file_refs: vec!["a".into(), "b".into()],
        }];
        p.deliverables = vec!["Refactor token cache".into()];
        assert!(!scout_eligible(&p));
    }

    #[test]
    fn scout_fires_on_add_deliverable() {
        let mut p = payload();
        p.deliverables = vec!["Add user invites".into()];
        assert!(scout_eligible(&p));
    }

    #[test]
    fn scout_fires_on_new_deliverable_case_insensitive() {
        let mut p = payload();
        p.deliverables = vec!["New OAuth flow".into()];
        assert!(scout_eligible(&p));
    }

    #[test]
    fn scout_counts_refs_across_phases_and_todos() {
        let mut p = payload();
        p.phases = vec![PlanPhasePayload {
            title: "p".into(),
            body: String::new(),
            file_refs: vec!["a".into()],
        }];
        p.todos = vec![PlanTodo {
            description: "do thing".into(),
            agent: None,
            file_refs: vec!["b".into(), "c".into()],
            assignee: None,
            goal: None,
            acceptance: vec![],
            subtasks: vec![],
        }];
        assert!(scout_eligible(&p));
    }
}
