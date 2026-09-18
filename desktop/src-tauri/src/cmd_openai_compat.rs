// OpenAI-compatible chat-completions adapter. Powers the "Local & Custom
// Models" agent kind — any endpoint that speaks `/v1/chat/completions`
// (Ollama, HuggingFace TGI, Together, Groq, OpenRouter, a self-hosted
// vLLM, …) plugs in as a profile in `~/.aura/agents/openai-compat.json`.
//
// Unlike the other agent kinds in this crate this one is NOT a PTY. The
// upstream is HTTP, so we own the message-list state on the frontend
// side and ferry SSE deltas back via Tauri events. One channel per
// running chat call so multiple profiles can stream in parallel.
//
// What lives here:
//   - on-disk profile CRUD (single JSON file under `~/.aura/agents/`)
//   - `openai_compat_chat` — POSTs `{messages, stream:true}` to
//     `<baseUrl>/chat/completions`, parses the OpenAI SSE deltas, and
//     emits `openai-compat:chunk:<profile_name>` events with
//     `{turn_id, kind: "delta" | "done" | "error", content}` payloads
//   - `openai_compat_test` — pings `<baseUrl>/models` and does a 1-token
//     completion so the Settings "Test connection" button gives a real
//     answer (not just "can we open a socket").
//
// API-key storage: spec says plaintext-in-JSON for now, with a UI
// warning. Keychain comes later.

use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::Mutex;
use std::time::Duration;

use futures_util::StreamExt;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use tauri::{AppHandle, Emitter};
#[path = "chat_sse.rs"]
mod chat_sse;

/// A single saved endpoint. `name` is the unique key the user picks
/// (e.g. "Llama 3 local"); the frontend uses it both as the row id and
/// as the event-channel suffix when streaming. `headers` is a flat map
/// so callers can stick auth tokens, HF routing hints, etc. without us
/// hardcoding vendor quirks.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct OpenAiCompatProfile {
    pub name: String,
    pub base_url: String,
    pub model: String,
    #[serde(default)]
    pub api_key: Option<String>,
    #[serde(default)]
    pub headers: HashMap<String, String>,
    #[serde(default)]
    pub temperature: Option<f32>,
    /// Optional human description shown under the row in Settings.
    #[serde(default)]
    pub description: Option<String>,
    /// Persisted creation timestamp; the UI shows "added 3d ago".
    #[serde(default)]
    pub created_at: Option<i64>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ChatMessage {
    pub role: String, // "system" | "user" | "assistant"
    pub content: String,
}

/// Disk-side wrapper so we can version-bump the file format later
/// without breaking older profile files.
#[derive(Debug, Default, Serialize, Deserialize)]
struct ProfilesFile {
    #[serde(default = "default_version")]
    version: u32,
    #[serde(default)]
    profiles: Vec<OpenAiCompatProfile>,
}

fn default_version() -> u32 {
    1
}

fn profiles_path() -> PathBuf {
    let mut p = if let Some(home) = std::env::var_os("HOME") {
        PathBuf::from(home)
    } else {
        PathBuf::from(".")
    };
    p.push(".aura");
    p.push("agents");
    p.push("openai-compat.json");
    p
}

fn load_profiles() -> Vec<OpenAiCompatProfile> {
    let path = profiles_path();
    let Ok(bytes) = std::fs::read(&path) else {
        return Vec::new();
    };
    match serde_json::from_slice::<ProfilesFile>(&bytes) {
        Ok(file) => file.profiles,
        Err(_) => Vec::new(),
    }
}

fn save_profiles(profiles: &[OpenAiCompatProfile]) -> Result<(), String> {
    let path = profiles_path();
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)
            .map_err(|e| format!("mkdir {parent:?}: {e}"))?;
    }
    let file = ProfilesFile {
        version: 1,
        profiles: profiles.to_vec(),
    };
    let body = serde_json::to_vec_pretty(&file)
        .map_err(|e| format!("serialize profiles: {e}"))?;
    // tempfile + rename for atomic replace so a crash mid-write doesn't
    // strand the user with a half-truncated profiles file.
    let tmp = path.with_extension("json.tmp");
    std::fs::write(&tmp, &body).map_err(|e| format!("write tmp: {e}"))?;
    std::fs::rename(&tmp, &path).map_err(|e| format!("rename: {e}"))?;
    Ok(())
}

/// Global cancel registry — frontend can request abort of an in-flight
/// streamed turn by calling `openai_compat_cancel(profile_name, turn_id)`.
/// We only need a flag per (profile, turn) since the streaming task is
/// the only reader.
#[derive(Default)]
pub struct OpenAiCompatRegistry {
    cancels: Mutex<HashMap<(String, String), tokio::sync::watch::Sender<bool>>>,
}

impl OpenAiCompatRegistry {
    pub fn new() -> Self {
        Self::default()
    }
    fn begin(&self, profile: &str, turn: &str) -> Result<tokio::sync::watch::Receiver<bool>, String> {
        let mut entries = self.cancels.lock().map_err(|_| "Chat cancellation registry unavailable")?;
        let key = (profile.to_string(), turn.to_string());
        if entries.contains_key(&key) { return Err("This response is already running".into()); }
        let (tx, rx) = tokio::sync::watch::channel(false);
        entries.insert(key, tx); Ok(rx)
    }
    fn mark_cancel(&self, profile: &str, turn: &str) {
        if let Ok(entries) = self.cancels.lock() {
            if let Some(tx) = entries.get(&(profile.to_string(), turn.to_string())) { let _ = tx.send(true); }
        }
    }
    fn clear(&self, profile: &str, turn: &str) {
        if let Ok(mut entries) = self.cancels.lock() { entries.remove(&(profile.to_string(), turn.to_string())); }
    }

}

// ── commands ───────────────────────────────────────────────────────────

#[tauri::command]
pub async fn openai_compat_profiles_list() -> Result<Vec<OpenAiCompatProfile>, String> {
    Ok(load_profiles())
}

#[tauri::command]
pub async fn openai_compat_profile_save(
    profile: OpenAiCompatProfile,
) -> Result<Vec<OpenAiCompatProfile>, String> {
    if profile.name.trim().is_empty() {
        return Err("profile name is required".into());
    }
    if profile.base_url.trim().is_empty() {
        return Err("base URL is required".into());
    }
    if profile.model.trim().is_empty() {
        return Err("model is required".into());
    }
    let mut list = load_profiles();
    let mut next = profile;
    if next.created_at.is_none() {
        next.created_at = Some(now_secs());
    }
    if let Some(existing) = list.iter_mut().find(|p| p.name == next.name) {
        // Preserve the original created_at on an update.
        if next.created_at.is_none() {
            next.created_at = existing.created_at;
        }
        *existing = next;
    } else {
        list.push(next);
    }
    list.sort_by(|a, b| a.name.to_lowercase().cmp(&b.name.to_lowercase()));
    save_profiles(&list)?;
    Ok(list)
}

#[tauri::command]
pub async fn openai_compat_profile_remove(
    name: String,
) -> Result<Vec<OpenAiCompatProfile>, String> {
    let mut list = load_profiles();
    list.retain(|p| p.name != name);
    save_profiles(&list)?;
    Ok(list)
}

/// Best-effort connection probe. Hits `<baseUrl>/models` for a
/// directory listing (most OpenAI-compatible servers return one) and
/// then fires a tiny `max_tokens=1` chat-completion so we know the
/// auth/model pair is actually reachable. Returns a flat status string
/// so the UI can show a single ✓ / ✗ / message without parsing JSON.
#[derive(Debug, Serialize)]
pub struct TestResult {
    pub ok: bool,
    pub models_endpoint_ok: bool,
    pub completion_ok: bool,
    pub message: String,
    /// Latency of the chat-completion ping in milliseconds (0 if not run).
    pub latency_ms: u64,
}

#[tauri::command]
pub async fn openai_compat_test(name: String) -> Result<TestResult, String> {
    let profile = load_profiles()
        .into_iter()
        .find(|p| p.name == name)
        .ok_or_else(|| format!("profile {name} not found"))?;

    let base = trim_trailing_slash(&profile.base_url);
    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(15))
        .build()
        .map_err(|e| format!("build client: {e}"))?;

    // 1. GET /models. Not every server implements it (HF inference
    //    endpoints sometimes 404), so we treat failure as a warning, not
    //    a hard fail — the chat call is the source of truth.
    let models_url = format!("{base}/models");
    let models_ok = match apply_auth(client.get(&models_url), &profile)
        .send()
        .await
    {
        Ok(r) => r.status().is_success(),
        Err(_) => false,
    };

    // 2. Tiny chat ping. `max_tokens=1` keeps the round-trip cheap on
    //    paid endpoints; "hi" is a universally-tokenized message.
    let chat_url = format!("{base}/chat/completions");
    let body = json!({
        "model": profile.model,
        "messages": [{ "role": "user", "content": "hi" }],
        "max_tokens": 1,
        "stream": false,
    });
    let started = std::time::Instant::now();
    let res = apply_auth(client.post(&chat_url), &profile)
        .json(&body)
        .send()
        .await;
    let latency_ms = started.elapsed().as_millis() as u64;

    match res {
        Ok(r) if r.status().is_success() => Ok(TestResult {
            ok: true,
            models_endpoint_ok: models_ok,
            completion_ok: true,
            message: format!("OK · {latency_ms}ms · model={}", profile.model),
            latency_ms,
        }),
        Ok(r) => {
            let status = r.status();
            let body = r.text().await.unwrap_or_default();
            let snippet = body.chars().take(240).collect::<String>();
            Ok(TestResult {
                ok: false,
                models_endpoint_ok: models_ok,
                completion_ok: false,
                message: format!("HTTP {status}: {snippet}"),
                latency_ms,
            })
        }
        Err(e) => Ok(TestResult {
            ok: false,
            models_endpoint_ok: models_ok,
            completion_ok: false,
            message: format!("Request failed: {e}"),
            latency_ms,
        }),
    }
}

/// Stream a chat turn. The frontend listens on
/// `openai-compat:chunk:<profile_name>` and matches deltas to its
/// open assistant bubble by `turn_id` (the frontend mints it before
/// invoking).
///
/// Payload variants emitted (all carry `turn_id` + `profile`):
///   - `{ kind: "delta", content }`  — append chunk to assistant bubble
///   - `{ kind: "done" }`            — turn finished cleanly
///   - `{ kind: "error", message }`  — request failed, no more chunks
#[tauri::command]
pub async fn openai_compat_chat(
    app: AppHandle,
    state: tauri::State<'_, OpenAiCompatRegistry>,
    profile_name: String,
    turn_id: String,
    messages: Vec<ChatMessage>,
) -> Result<(), String> {
    // Cancellation races the entire request, including DNS, connect, headers,
    // error bodies and a stalled stream. Dropping reqwest's future closes I/O.
    let mut cancel = state.begin(&profile_name, &turn_id)?;
    let outcome = tokio::select! {
        result = run_chat(&app, &profile_name, &turn_id, messages) => result,
        _ = cancel.changed() => Ok(()),
    };
    state.clear(&profile_name, &turn_id);
    outcome
}

async fn run_chat(app: &AppHandle, profile_name: &str, turn_id: &str, messages: Vec<ChatMessage>) -> Result<(), String> {
    let profile = load_profiles()
        .into_iter()
        .find(|p| p.name == profile_name)
        .ok_or_else(|| format!("profile {profile_name} not found"))?;


    let event_name = format!("openai-compat:chunk:{profile_name}");
    let base = trim_trailing_slash(&profile.base_url);
    let url = format!("{base}/chat/completions");

    // Total timeout is generous — local models can take many seconds to
    // warm up on cold load. We rely on the per-chunk stream timeout +
    // user-driven cancel for control rather than a tight clock.
    let client = match reqwest::Client::builder()
        .timeout(Duration::from_secs(600))
        .build()
    {
        Ok(c) => c,
        Err(e) => {
            emit_error(&app, &event_name, &profile_name, &turn_id, format!("build client: {e}"));
            return Ok(());
        }
    };

    let serialized_messages: Vec<Value> = messages
        .iter()
        .map(|m| json!({ "role": m.role, "content": m.content }))
        .collect();
    let mut body = json!({
        "model": profile.model,
        "messages": serialized_messages,
        "stream": true,
    });
    if let Some(t) = profile.temperature {
        body["temperature"] = json!(t);
    }

    let res = match apply_auth(client.post(&url), &profile)
        .json(&body)
        .send()
        .await
    {
        Ok(r) => r,
        Err(e) => {
            emit_error(&app, &event_name, &profile_name, &turn_id, format!("request failed: {e}"));
            return Ok(());
        }
    };

    if !res.status().is_success() {
        let status = res.status();
        let body = res.text().await.unwrap_or_default();
        let snippet = body.chars().take(360).collect::<String>();
        emit_error(
            &app,
            &event_name,
            &profile_name,
            &turn_id,
            format!("HTTP {status}: {snippet}"),
        );
        return Ok(());
    }

    if res.headers().get(reqwest::header::CONTENT_TYPE).and_then(|h| h.to_str().ok()).is_some_and(|h| h.contains("application/json")) {
        match res.json::<Value>().await {
            Ok(v) => {
                if let Some(e) = v.get("error") { emit_error(app, &event_name, profile_name, turn_id, e.to_string()); }
                else if v.get("choices").and_then(Value::as_array).is_some_and(|c| !c.is_empty()) {
                    emit_completion(app, &event_name, profile_name, turn_id, &v);
                    emit_done(app, &event_name, profile_name, turn_id);
                } else { emit_error(app, &event_name, profile_name, turn_id, "Endpoint returned no completion choices".into()); }
            }
            Err(e) => emit_error(app, &event_name, profile_name, turn_id, format!("Invalid completion: {e}")),
        }
        return Ok(());
    }
    let mut stream = res.bytes_stream();
    let mut decoder = chat_sse::SseDecoder::default();
    let mut finished = false;
    loop {
        let (frames, eof) = match stream.next().await {
            Some(Ok(bytes)) => (decoder.push(&bytes), false),
            Some(Err(e)) => { emit_error(app, &event_name, profile_name, turn_id, format!("Connection interrupted: {e}")); return Ok(()); }
            None => (decoder.finish(), true),
        };
        let frames = match frames { Ok(f) => f, Err(e) => { emit_error(app, &event_name, profile_name, turn_id, e); return Ok(()); } };
        for data in frames {
            if data.trim() == "[DONE]" { emit_done(app, &event_name, profile_name, turn_id); return Ok(()); }
            let v: Value = match serde_json::from_str(&data) {
                Ok(v) => v,
                Err(e) => { emit_error(app, &event_name, profile_name, turn_id, format!("Invalid response event: {e}")); return Ok(()); }
            };
            if let Some(e) = v.get("error") { emit_error(app, &event_name, profile_name, turn_id, e.to_string()); return Ok(()); }
            finished |= v.pointer("/choices/0/finish_reason").is_some_and(|r| !r.is_null());
            emit_completion(app, &event_name, profile_name, turn_id, &v);
        }
        if eof { break; }
    }
    if finished { emit_done(app, &event_name, profile_name, turn_id); }
    else { emit_error(app, &event_name, profile_name, turn_id, "Connection closed before the response finished. Partial output is saved.".into()); }
    Ok(())
}

fn emit_completion(app: &AppHandle, event: &str, profile: &str, turn: &str, data: &Value) {
    let _ = app.emit(event, json!({"profile":profile,"turn_id":turn,"kind":"event","data":data}));
}

#[tauri::command]
pub async fn openai_compat_cancel(
    state: tauri::State<'_, OpenAiCompatRegistry>,
    profile_name: String,
    turn_id: String,
) -> Result<(), String> {
    state.mark_cancel(&profile_name, &turn_id);
    Ok(())
}

// ── helpers ────────────────────────────────────────────────────────────

fn apply_auth(
    mut rb: reqwest::RequestBuilder,
    profile: &OpenAiCompatProfile,
) -> reqwest::RequestBuilder {
    if let Some(key) = profile.api_key.as_ref().filter(|k| !k.is_empty()) {
        rb = rb.header("Authorization", format!("Bearer {key}"));
    }
    for (k, v) in &profile.headers {
        if k.is_empty() {
            continue;
        }
        rb = rb.header(k.as_str(), v.as_str());
    }
    rb
}

fn trim_trailing_slash(s: &str) -> String {
    let t = s.trim();
    if let Some(stripped) = t.strip_suffix('/') {
        stripped.to_string()
    } else {
        t.to_string()
    }
}

fn parse_sse_data(frame: &str) -> Option<String> {
    let mut data: Option<String> = None;
    for line in frame.lines() {
        let line = line.trim_end_matches('\r');
        // Standard "data:" prefix; some servers omit the trailing space.
        let payload = line
            .strip_prefix("data: ")
            .or_else(|| line.strip_prefix("data:"));
        if let Some(rest) = payload {
            match &mut data {
                Some(buf) => {
                    buf.push('\n');
                    buf.push_str(rest);
                }
                None => data = Some(rest.to_string()),
            }
        }
    }
    data
}

fn now_secs() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs() as i64)
        .unwrap_or(0)
}

#[derive(Serialize, Clone)]
struct ChunkPayload<'a> {
    profile: &'a str,
    turn_id: &'a str,
    kind: &'a str,
    #[serde(skip_serializing_if = "Option::is_none")]
    content: Option<&'a str>,
    #[serde(skip_serializing_if = "Option::is_none")]
    message: Option<&'a str>,
}

fn emit_delta(app: &AppHandle, event: &str, profile: &str, turn: &str, content: &str) {
    let _ = app.emit(
        event,
        ChunkPayload {
            profile,
            turn_id: turn,
            kind: "delta",
            content: Some(content),
            message: None,
        },
    );
}

fn emit_done(app: &AppHandle, event: &str, profile: &str, turn: &str) {
    let _ = app.emit(
        event,
        ChunkPayload {
            profile,
            turn_id: turn,
            kind: "done",
            content: None,
            message: None,
        },
    );
}

fn emit_error(app: &AppHandle, event: &str, profile: &str, turn: &str, message: String) {
    let _ = app.emit(
        event,
        ChunkPayload {
            profile,
            turn_id: turn,
            kind: "error",
            content: None,
            message: Some(&message),
        },
    );
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_sse_data_with_and_without_space() {
        assert_eq!(parse_sse_data("data: hello").as_deref(), Some("hello"));
        assert_eq!(parse_sse_data("data:hello").as_deref(), Some("hello"));
        assert_eq!(parse_sse_data("event: x\ndata: y").as_deref(), Some("y"));
        assert_eq!(
            parse_sse_data("data: a\ndata: b").as_deref(),
            Some("a\nb"),
        );
    }

    #[test]
    fn trim_trailing_slash_works() {
        assert_eq!(trim_trailing_slash("http://x/"), "http://x");
        assert_eq!(trim_trailing_slash("http://x"), "http://x");
        assert_eq!(trim_trailing_slash("  http://x  "), "http://x");
    }
}
