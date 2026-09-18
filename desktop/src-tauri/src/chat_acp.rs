//! ACP stdio bridge. Agent-owned tools run inside the agent; this client
//! advertises no filesystem/terminal capabilities and never executes requests.
use super::{ChildRegistry, ExitInfo, ImageAttachment, StreamEvent};
use crate::cmd_permission::{emit_prompt, PendingPrompt, PermissionDecision, PermissionRegistry};
use serde_json::{json, Value};
use std::{
    process::Stdio,
    time::{Duration, Instant},
};
use tauri::{AppHandle, Emitter, Manager};
use tokio::{
    io::{AsyncBufReadExt, AsyncWriteExt, BufReader},
    process::Command,
    sync::{mpsc, watch},
    task::JoinSet,
};

struct ProcessTree(u32);
impl Drop for ProcessTree {
    fn drop(&mut self) {
        #[cfg(unix)]
        unsafe {
            libc::kill(-(self.0 as i32), libc::SIGTERM);
        }
    }
}
async fn write(stdin: &mut tokio::process::ChildStdin, value: Value) -> Result<(), String> {
    let mut bytes = serde_json::to_vec(&value).map_err(|e| e.to_string())?;
    bytes.push(b'\n');
    stdin.write_all(&bytes).await.map_err(|e| e.to_string())?;
    stdin.flush().await.map_err(|e| e.to_string())
}
fn request(id: u64, method: &str, params: Value) -> Value {
    json!({"jsonrpc":"2.0","id":id,"method":method,"params":params})
}

pub(super) async fn run(
    app: AppHandle,
    provider: &str,
    bin: &str,
    cwd: &str,
    prompt: &str,
    resume: Option<&str>,
    model: Option<&str>,
    permission_mode: Option<&str>,
    channel: &str,
    turn: &str,
    attachments: &[ImageAttachment],
    mut cancel: watch::Receiver<bool>,
) {
    let topic = format!("agent-stream:{channel}");
    let started = Instant::now();
    let mut prompts: Vec<(String, Value)> = vec![];
    let mut tasks = JoinSet::new();
    let outcome: Result<String,String> = async {
        let mut cmd=Command::new(bin);
        cmd.arg(if provider=="gemini" {"--acp"}else{"acp"}).current_dir(crate::spawn_dir::safe_spawn_dir(cwd)).stdin(Stdio::piped()).stdout(Stdio::piped()).stderr(Stdio::piped()).kill_on_drop(true);
        #[cfg(unix)] cmd.process_group(0);
        let mut child=cmd.spawn().map_err(|e|format!("Could not start {provider}: {e}"))?;
        let _tree=child.id().map(ProcessTree);
        if let Some(pid)=child.id() { app.state::<ChildRegistry>().set(channel,pid); }
        let mut stdin=child.stdin.take().ok_or("Missing input stream")?;
        let mut lines=BufReader::new(child.stdout.take().ok_or("Missing output stream")?).lines();
        let stderr=child.stderr.take().ok_or("Missing diagnostic stream")?;
        let diagnostic_app=app.clone(); let diagnostic_topic=topic.clone(); let diagnostic_turn=turn.to_string();
        tasks.spawn(async move {
            let mut lines=BufReader::new(stderr).lines();
            while let Ok(Some(text))=lines.next_line().await {
                let _=diagnostic_app.emit(&diagnostic_topic,StreamEvent::ContentBlock{event_id:format!("diag-{}",uuid::Uuid::new_v4()),role:"assistant".into(),payload:json!({"type":"diagnostic","text":text}),turn_id:diagnostic_turn.clone()});
            }
        });
        write(&mut stdin,request(0,"initialize",json!({"protocolVersion":1,"clientCapabilities":{"fs":{"readTextFile":false,"writeTextFile":false},"terminal":false},"clientInfo":{"name":"aura-shell","title":"Aura","version":"1"}}))).await?;
        let mut prompt_parts=vec![];
        if !prompt.is_empty() { prompt_parts.push(json!({"type":"text","text":prompt})); }
        for image in attachments { prompt_parts.push(json!({"type":"image","mimeType":image.media_type,"data":image.data})); }
        let mut sid=resume.unwrap_or("").to_string(); let mut stage=0; let mut seq=0;
        let mut session_mode: Option<String> = None;
        let mut cancelling=false; let mut deadline=Instant::now()+Duration::from_secs(60);
        let (reply_tx,mut reply_rx)=mpsc::unbounded_channel::<Value>();
        loop {
            tokio::select! {
                _ = cancel.changed(), if !cancelling => {
                    cancelling=true; deadline=Instant::now()+Duration::from_secs(5);
                    if sid.is_empty() { return Ok("cancelled".into()); }
                    write(&mut stdin,json!({"jsonrpc":"2.0","method":"session/cancel","params":{"sessionId":sid}})).await?;
                    for (local, remote) in &prompts {
                        app.state::<PermissionRegistry>().cancel_prompt(local);
                        let _=app.emit("permission:closed",json!({"prompt_id":local}));
                        write(&mut stdin,json!({"jsonrpc":"2.0","id":remote,"result":{"outcome":{"outcome":"cancelled"}}})).await?;
                    }
                    prompts.clear(); tasks.abort_all();
                }
                _ = tokio::time::sleep_until(tokio::time::Instant::from_std(deadline)), if stage != 3 || cancelling => {
                    if cancelling { return Ok("cancelled".into()); }
                    return Err("Agent connection timed out. Check its login and configuration in Terminal, then retry.".into());
                }
                Some(reply)=reply_rx.recv(), if !cancelling => { prompts.retain(|(_,id)| Some(id) != reply.get("id")); write(&mut stdin,reply).await?; }
                line=lines.next_line() => {
                    let line=line.map_err(|e|e.to_string())?.ok_or("Agent disconnected before finishing")?;
                    let v:Value=serde_json::from_str(&line).map_err(|e|format!("Invalid agent protocol message: {e}"))?;
                    if v.get("method").and_then(Value::as_str)==Some("session/update") {
                        // session/load replays history; it is already in this
                        // chat's durable log. Only append the new prompt turn.
                        if stage==3 && v.pointer("/params/sessionId").and_then(Value::as_str)==Some(sid.as_str()) {
                            seq+=1;
                            let _=app.emit(&topic,StreamEvent::ContentBlock{event_id:format!("{turn}:acp:{seq}"),role:"assistant".into(),payload:json!({"type":"acp_update","update":v["params"]["update"]}),turn_id:turn.into()});
                        }
                        continue;
                    }
                    if let Some(method)=v.get("method").and_then(Value::as_str) {
                        if let Some(remote)=v.get("id") {
                            if method=="session/request_permission" && !cancelling && v.pointer("/params/sessionId").and_then(Value::as_str)==Some(sid.as_str()) {
                                let params=&v["params"]; let options=params["options"].as_array().cloned().unwrap_or_default();
                                let local=format!("perm-{}",uuid::Uuid::new_v4());
                                let meta=PendingPrompt{prompt_id:local.clone(),channel:channel.into(),tool_name:params["toolCall"]["title"].as_str().unwrap_or("Agent action").into(),input:json!({"action":params["toolCall"],"_acp_options":options}),ts:chrono::Utc::now().timestamp()};
                                let rx=app.state::<PermissionRegistry>().enqueue(meta.clone()); emit_prompt(&app,&meta);
                                prompts.push((local,remote.clone())); let remote=remote.clone(); let tx=reply_tx.clone();
                                tasks.spawn(async move {
                                    let response=rx.await.ok();
                                    let selected=response.as_ref().and_then(|r|r.updated_input.as_ref()).and_then(|i|i.get("_acp_option_id")).and_then(Value::as_str);
                                    let kind=if matches!(response.as_ref().map(|r|&r.decision),Some(PermissionDecision::Allow)){"allow_once"}else{"reject_once"};
                                    let outcome=permission_outcome(&options,selected,kind);
                                    let _=tx.send(json!({"jsonrpc":"2.0","id":remote,"result":{"outcome":outcome}}));
                                });
                            } else {
                                write(&mut stdin,json!({"jsonrpc":"2.0","id":remote,"error":{"code":-32601,"message":"Client capability not available"}})).await?;
                                seq+=1; let _=app.emit(&topic,StreamEvent::ContentBlock{event_id:format!("{turn}:request:{seq}"),role:"assistant".into(),payload:v.clone(),turn_id:turn.into()});
                            }
                        }
                        continue;
                    }
                    let id=v.get("id").and_then(Value::as_u64);
                    if id!=Some(stage) { continue; }
                    if let Some(error)=v.get("error") { if cancelling { return Ok("cancelled".into()); } return Err(format!("{provider}: {error}")); }
                    let result=&v["result"];
                    match stage {
                        0 => {
                            if result["protocolVersion"].as_u64()!=Some(1) { return Err("Unsupported agent protocol version".into()); }
                            if !attachments.is_empty() && result.pointer("/agentCapabilities/promptCapabilities/image").and_then(Value::as_bool)!=Some(true) { return Err("This agent version does not accept image attachments.".into()); }
                            let method=if resume.is_some() {
                                if result.pointer("/agentCapabilities/sessionCapabilities/resume").is_some() {"session/resume"}
                                else if result.pointer("/agentCapabilities/loadSession").and_then(Value::as_bool)==Some(true) {"session/load"}
                                else {return Err("This agent version cannot resume an ACP chat. Continue in Terminal or start a new chat.".into());}
                            }else{"session/new"};
                            let mut params=json!({"cwd":cwd,"mcpServers":[]}); if resume.is_some(){params["sessionId"]=json!(sid);}
                            stage=1; write(&mut stdin,request(1,method,params)).await?;
                        }
                        1 => {
                            if resume.is_none() { sid=result["sessionId"].as_str().ok_or("Agent returned no session ID")?.into(); }
                            let _=app.emit(&topic,StreamEvent::SystemInit{session_id:sid.clone(),model:result.pointer("/models/currentModelId").and_then(Value::as_str).map(str::to_owned),tools:vec![],turn_id:turn.into()});
                            session_mode = native_session_mode(&result, permission_mode);
                            if permission_mode != Some("plan") && session_mode.is_none() && result.pointer("/modes/currentModeId").and_then(Value::as_str).is_some_and(|id| matches!(id, "plan" | "read-only" | "readonly")) {
                                return Err("This session is still in Plan mode and offers no standard Agent mode. Change its mode in Terminal before continuing.".into());
                            }
                            if let Some(model)=model {
                                if !result.pointer("/models/availableModels").and_then(Value::as_array).is_some_and(|ms|ms.iter().any(|m|m["modelId"].as_str()==Some(model))) {
                                    return Err(format!("Model {model} is not offered by this agent session. Clear the override to use its default."));
                                }
                                stage=2; write(&mut stdin,request(2,"session/set_model",json!({"sessionId":sid,"modelId":model}))).await?;
                            } else if let Some(mode_id)=session_mode.as_deref() { stage=4; write(&mut stdin,request(4,"session/set_mode",json!({"sessionId":sid,"modeId":mode_id}))).await?; }
                            else { stage=3; write(&mut stdin,request(3,"session/prompt",json!({"sessionId":sid,"prompt":prompt_parts}))).await?; }
                        }
                        2 => {
                            if let Some(mode_id)=session_mode.as_deref() {stage=4;write(&mut stdin,request(4,"session/set_mode",json!({"sessionId":sid,"modeId":mode_id}))).await?;}
                            else {stage=3;write(&mut stdin,request(3,"session/prompt",json!({"sessionId":sid,"prompt":prompt_parts}))).await?;}
                        }
                        4 => {stage=3;write(&mut stdin,request(3,"session/prompt",json!({"sessionId":sid,"prompt":prompt_parts}))).await?;}
                        3 => return Ok(result["stopReason"].as_str().unwrap_or("end_turn").into()),
                        _=>{}
                    }
                }
            }
        }
    }.await;
    tasks.abort_all();
    for (id, _) in prompts {
        app.state::<PermissionRegistry>().cancel_prompt(&id);
        let _ = app.emit("permission:closed", json!({"prompt_id":id}));
    }
    let (success, message, cancelled) = match outcome {
        Ok(reason) => (
            true,
            if reason == "end_turn" {
                None
            } else {
                Some(format!("Agent stopped: {reason}"))
            },
            reason == "cancelled",
        ),
        Err(e) => (false, Some(e), false),
    };
    if cancelled {
        let _ = app.emit(
            &topic,
            StreamEvent::ContentBlock {
                event_id: format!("{turn}:cancelled"),
                role: "assistant".into(),
                payload: json!({"type":"turn_cancelled"}),
                turn_id: turn.into(),
            },
        );
    } else {
        let _ = app.emit(
            &topic,
            StreamEvent::Result {
                success,
                duration_ms: started.elapsed().as_millis() as u64,
                cost_usd: None,
                total_tokens: None,
                message,
                turn_id: turn.into(),
            },
        );
    }
    let _ = app.emit(
        &format!("agent-stream-done:{channel}"),
        ExitInfo {
            turn_id: turn.into(),
            exit_code: if success { 0 } else { 1 },
        },
    );
}

fn permission_outcome(options: &[Value], selected: Option<&str>, fallback_kind: &str) -> Value {
    let option = options
        .iter()
        .find(|o| {
            if let Some(id) = selected {
                o["optionId"].as_str() == Some(id)
            } else {
                o["kind"].as_str() == Some(fallback_kind)
            }
        })
        .and_then(|o| o.get("optionId"));
    option
        .map(|id| json!({"outcome":"selected","optionId":id}))
        .unwrap_or_else(|| json!({"outcome":"cancelled"}))
}
// Select only modes actually offered by the native session. Returning from
// Plan never selects a permission-bypassing mode such as yolo or dontAsk.
fn native_session_mode(result: &Value, permission_mode: Option<&str>) -> Option<String> {
    let modes = result.pointer("/modes/availableModes")?.as_array()?;
    let current = result.pointer("/modes/currentModeId").and_then(Value::as_str);
    let readonly = ["plan", "read-only", "readonly"];
    let normal = ["default", "code", "build", "agent"];
    let candidates = if permission_mode == Some("plan") {
        &readonly[..]
    } else if current.is_some_and(|id| readonly.contains(&id)) {
        &normal[..]
    } else {
        return None;
    };
    candidates.iter().find(|id| modes.iter().any(|mode| mode["id"].as_str() == Some(**id))).map(|id| (*id).to_owned())
}

#[cfg(test)]
mod chat_coverage_tests {
    use super::*;
    #[test]
    fn plan_mode_can_return_to_agent_without_bypassing_permissions() {
        let mut result = json!({"modes":{"currentModeId":"default","availableModes":[{"id":"plan"},{"id":"default"},{"id":"yolo"}]}});
        assert_eq!(native_session_mode(&result, Some("plan")).as_deref(), Some("plan"));
        result["modes"]["currentModeId"] = json!("plan");
        assert_eq!(native_session_mode(&result, None).as_deref(), Some("default"));
        result["modes"]["availableModes"] = json!([{"id":"plan"},{"id":"yolo"}]);
        assert_eq!(native_session_mode(&result, None), None);
        assert_eq!(native_session_mode(&json!({}), Some("plan")), None);
    }
    #[test]
    fn permission_reply_uses_exact_option_and_never_upgrades_scope() {
        let options = vec![
            json!({"optionId":"scope-session-uuid","kind":"allow_always"}),
            json!({"optionId":"deny-uuid","kind":"reject_once"}),
        ];
        assert_eq!(
            permission_outcome(&options, None, "allow_once"),
            json!({"outcome":"cancelled"})
        );
        assert_eq!(
            permission_outcome(&options, Some("scope-session-uuid"), "allow_once"),
            json!({"outcome":"selected","optionId":"scope-session-uuid"})
        );
        assert_eq!(
            permission_outcome(&options, Some("forged"), "allow_once"),
            json!({"outcome":"cancelled"})
        );
    }
}
