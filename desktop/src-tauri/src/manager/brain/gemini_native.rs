//! Gemini (Generative Language API) as a `Brain` impl.
//!
//! Streams from
//! `generativelanguage.googleapis.com/v1beta/models/{model}:streamGenerateContent?alt=sse`
//! and parses SSE `data: {...}` lines into `ChatChunk`s. Maps
//! `candidates[0].content.parts[i].text` to `ChatChunk::Text` and
//! `candidates[0].content.parts[i].functionCall` to `ChatChunk::ToolUse`.
//! Emits `ChatChunk::End` when the stream closes or `finishReason`
//! lands on a candidate. Non-2xx → `BrainError::Api`.
//!
//! W6 of v0.2.30 KK.3. Real wire-protocol impl; opt-in via the
//! `brain_gemini_native` Cargo feature. Default-on lands in v0.2.31.

#![cfg(feature = "brain_gemini_native")]

use std::collections::HashMap;

use async_stream::try_stream;
use async_trait::async_trait;
use futures_util::{StreamExt, stream::BoxStream};
use serde_json::{Map, Value, json};
use tokio::io::{AsyncBufReadExt, BufReader};

use super::{
    Brain,
    types::{BrainCapabilities, BrainError, ChatChunk, ChatMessage, ChatRequest, cap_keys},
};

const PROVIDER_ID: &str = "gemini_native";
const ENDPOINT_BASE: &str = "https://generativelanguage.googleapis.com/v1beta/models";
const DEFAULT_MODEL: &str = "gemini-2.5-pro";
const DEFAULT_MAX_TOKENS: u32 = 8_192;

#[derive(Debug, Clone)]
pub struct GeminiNativeBrain {
    api_key: String,
    model: String,
    /// Optional override base URL (used by Vertex AI proxies and tests).
    /// None → real Generative Language endpoint.
    base_url: Option<String>,
}

impl GeminiNativeBrain {
    pub fn new(api_key: impl Into<String>) -> Self {
        Self {
            api_key: api_key.into(),
            model: DEFAULT_MODEL.to_string(),
            base_url: None,
        }
    }

    pub fn with_model(mut self, model: impl Into<String>) -> Self {
        self.model = model.into();
        self
    }

    pub fn with_base_url(mut self, base_url: impl Into<String>) -> Self {
        self.base_url = Some(base_url.into());
        self
    }

    /// Build the streaming endpoint for a given model id — Gemini carries
    /// the model in the URL path, so a per-turn model override (from the
    /// composer's picker) is applied here rather than in the body.
    fn endpoint_for(&self, model: &str) -> String {
        let base = self
            .base_url
            .clone()
            .unwrap_or_else(|| ENDPOINT_BASE.into());
        format!(
            "{base}/{model}:streamGenerateContent?alt=sse&key={key}",
            key = self.api_key,
        )
    }
}

/// Lift a `ChatMessage.content` Value into Gemini's `parts: [...]` shape.
///
/// Anthropic-shape `content` is one of:
///   - a plain JSON string → `[{"text": "..."}]`
///   - an array of content blocks (text / image / tool_use / tool_result)
///     → we map text + tool_use/tool_result and pass-through the rest as text
///   - anything else (object, etc.) → serialized to a single text part
///
/// `call_names` maps a tool-call id (the loop's synthetic `gemini-call-N`,
/// stamped onto the assistant's `tool_use` block as `id`, then echoed on the
/// follow-up `tool_result` block's `tool_use_id`) back to the function NAME
/// the model originally called. Gemini correlates a `functionResponse` to its
/// `functionCall` by NAME — it has no call-id field — so we must resolve the
/// id back to the name here, or the model would see an orphan response and
/// re-call the tool forever. The map is built in `build_contents` from the
/// `tool_use` blocks of earlier assistant turns.
fn content_to_parts(content: &Value, call_names: &HashMap<String, String>) -> Vec<Value> {
    if let Some(s) = content.as_str() {
        return vec![json!({ "text": s })];
    }
    if let Some(arr) = content.as_array() {
        let mut parts = Vec::with_capacity(arr.len());
        for block in arr {
            let kind = block.get("type").and_then(|v| v.as_str()).unwrap_or("");
            match kind {
                "text" => {
                    let text = block.get("text").and_then(|v| v.as_str()).unwrap_or("");
                    parts.push(json!({ "text": text }));
                }
                "tool_use" => {
                    let name = block.get("name").and_then(|v| v.as_str()).unwrap_or("");
                    let input = block.get("input").cloned().unwrap_or(json!({}));
                    parts.push(json!({
                        "functionCall": { "name": name, "args": input }
                    }));
                }
                "tool_result" => {
                    // Resolve the synthetic call id back to the function name
                    // the model called, so Gemini can match this response to
                    // its functionCall by name. Fall back to the raw id if the
                    // call wasn't seen (shouldn't happen, but stays robust).
                    let id = block
                        .get("tool_use_id")
                        .and_then(|v| v.as_str())
                        .unwrap_or("");
                    let name = call_names.get(id).map(String::as_str).unwrap_or(id);
                    let response = tool_result_response(block.get("content"));
                    parts.push(json!({
                        "functionResponse": {
                            "name": name,
                            "response": response,
                        }
                    }));
                }
                _ => {
                    // Unknown block type — stringify and pass through so
                    // we don't drop user-visible content silently.
                    parts.push(json!({ "text": block.to_string() }));
                }
            }
        }
        return parts;
    }
    vec![json!({ "text": content.to_string() })]
}

/// Shape a `tool_result` block's content into the JSON OBJECT Gemini requires
/// for a `functionResponse.response` field. The native loop feeds back a plain
/// string (the tool's `(result_text, is_error)` text); Gemini rejects a bare
/// string here and wants an object, so we wrap it. A content value that's
/// already an object is passed through unchanged; anything else is wrapped
/// under `content`.
fn tool_result_response(content: Option<&Value>) -> Value {
    match content {
        Some(Value::Object(map)) => Value::Object(map.clone()),
        Some(other) => json!({ "content": other.clone() }),
        None => json!({ "content": "" }),
    }
}

/// Translate Aura's Anthropic-shaped `ChatRequest.messages` into Gemini's
/// `contents: [{ role, parts }]`. `user` stays `user`, `assistant`
/// becomes `model`, `system` is hoisted to `systemInstruction` by the
/// caller (we drop it here if it sneaks into `messages`).
///
/// We make one forward pass first to map every `tool_use` block's id → its
/// function name, then translate each message. The map lets `content_to_parts`
/// rewrite a later `tool_result`'s id back to the name Gemini matches on.
fn build_contents(req: &ChatRequest) -> Vec<Value> {
    let call_names = collect_call_names(&req.messages);
    let mut out = Vec::with_capacity(req.messages.len());
    for m in &req.messages {
        let role = match m.role.as_str() {
            "assistant" => "model",
            "system" => continue,
            other => other,
        };
        out.push(json!({
            "role": role,
            "parts": content_to_parts(&m.content, &call_names),
        }));
    }
    out
}

/// Build the `tool_use_id → function name` map from every `tool_use` block in
/// the conversation. Gemini's `functionResponse` correlates by name, so this
/// is how a later `tool_result` (which only carries the id) recovers the name.
fn collect_call_names(messages: &[ChatMessage]) -> HashMap<String, String> {
    let mut map = HashMap::new();
    for m in messages {
        let Some(arr) = m.content.as_array() else {
            continue;
        };
        for block in arr {
            if block.get("type").and_then(|v| v.as_str()) != Some("tool_use") {
                continue;
            }
            let (Some(id), Some(name)) = (
                block.get("id").and_then(|v| v.as_str()),
                block.get("name").and_then(|v| v.as_str()),
            ) else {
                continue;
            };
            if !id.is_empty() && !name.is_empty() {
                map.insert(id.to_string(), name.to_string());
            }
        }
    }
    map
}

/// Translate one Anthropic-format tool schema (`{name, description,
/// input_schema}`) into a Gemini `functionDeclaration`
/// (`{name, description, parameters}`). `input_schema` (or `parameters`, if a
/// caller already supplied the Gemini name) becomes `parameters`, sanitized
/// into Gemini's OpenAPI-3.0 subset by [`sanitize_schema`].
fn tool_to_function_declaration(t: &Value) -> Value {
    let name = t.get("name").and_then(|v| v.as_str()).unwrap_or("");
    let description = t.get("description").and_then(|v| v.as_str()).unwrap_or("");
    let raw_params = t
        .get("input_schema")
        .or_else(|| t.get("parameters"))
        .cloned()
        .unwrap_or_else(|| json!({ "type": "object" }));
    let parameters = sanitize_schema(raw_params);
    json!({
        "name": name,
        "description": description,
        "parameters": parameters,
    })
}

/// Recursively normalize a JSON-Schema value into the OpenAPI-3.0 subset
/// Gemini's `functionDeclarations.parameters` accepts. JSON-Schema keywords
/// Gemini rejects (and which our Anthropic-format schemas, or a caller's, may
/// carry) are dropped or downgraded:
///
///   - `$schema`, `$id`, `$ref`, `$defs`/`definitions` — meta/refs Gemini
///     doesn't resolve.
///   - `additionalProperties` — not in Gemini's object schema; dropped (it
///     trips a 400 on some model versions).
///   - `default`, `examples`, `title`, `const`, `oneOf`/`anyOf`/`allOf`,
///     `patternProperties`, `$comment` — unsupported; dropped.
///   - everything we DO keep (`type`, `description`, `enum`, `properties`,
///     `required`, `items`, `format`, `nullable`, `minimum`, `maximum`) is
///     recursed into so nested object/array schemas are sanitized too.
fn sanitize_schema(schema: Value) -> Value {
    match schema {
        Value::Object(map) => {
            let mut out = Map::new();
            for (k, v) in map {
                match k.as_str() {
                    // Meta / refs / unsupported keywords → drop.
                    "$schema" | "$id" | "$ref" | "$defs" | "definitions"
                    | "additionalProperties" | "default" | "examples" | "title"
                    | "const" | "oneOf" | "anyOf" | "allOf" | "not"
                    | "patternProperties" | "$comment" => {}
                    // `properties` is a map of field-name → sub-schema; recurse
                    // into each value, preserving the keys.
                    "properties" => {
                        if let Value::Object(props) = v {
                            let mut clean = Map::new();
                            for (pk, pv) in props {
                                clean.insert(pk, sanitize_schema(pv));
                            }
                            out.insert(k, Value::Object(clean));
                        }
                    }
                    // `items` / nested objects → recurse.
                    "items" => {
                        out.insert(k, sanitize_schema(v));
                    }
                    // Everything else (type, description, enum, required,
                    // format, minimum, maximum, nullable, …) → keep, recursing
                    // in case it nests further schemas.
                    _ => {
                        out.insert(k, sanitize_schema(v));
                    }
                }
            }
            Value::Object(out)
        }
        Value::Array(arr) => Value::Array(arr.into_iter().map(sanitize_schema).collect()),
        other => other,
    }
}

#[async_trait]
impl Brain for GeminiNativeBrain {
    fn provider_id(&self) -> &str {
        PROVIDER_ID
    }

    fn capabilities(&self) -> BrainCapabilities {
        BrainCapabilities::new()
            .with(cap_keys::SUPPORTS_STREAMING, true)
            .with(cap_keys::SUPPORTS_TOOL_USE, true)
            .with(cap_keys::SUPPORTS_VISION, true)
            .with(cap_keys::MAX_INPUT_TOKENS, 1_000_000)
            .with(cap_keys::MAX_OUTPUT_TOKENS, 8_192)
            .with(cap_keys::DEFAULT_MODEL, json!(self.model.clone()))
            .with(
                cap_keys::SUPPORTED_MODELS,
                json!([
                    "gemini-2.0-flash",
                    "gemini-2.0-pro",
                    "gemini-2.5-flash",
                    "gemini-2.5-pro",
                ]),
            )
    }

    async fn chat(
        &self,
        request: ChatRequest,
    ) -> Result<BoxStream<'static, Result<ChatChunk, BrainError>>, BrainError> {
        // Per-turn model override from the composer's model picker; Auto
        // falls back to this brain's configured model.
        let model = request
            .model
            .clone()
            .unwrap_or_else(|| self.model.clone());
        let endpoint = self.endpoint_for(&model);

        let mut body = json!({
            "contents": build_contents(&request),
            "generationConfig": {
                "maxOutputTokens": request.max_tokens.unwrap_or(DEFAULT_MAX_TOKENS),
            },
        });
        if let Some(temp) = request.temperature {
            body["generationConfig"]["temperature"] = json!(temp);
        }
        // Extended thinking — only when the caller picked an effort. `fast`
        // uses 128 (the minimum valid budget on both Flash and Pro) rather
        // than 0 so we never trip Pro's "thinking can't be disabled" error.
        // effort=None leaves generationConfig unchanged.
        if let Some(effort) = request.effort {
            let budget: i64 = if request.fast {
                128
            } else {
                effort.budget_tokens() as i64
            };
            body["generationConfig"]["thinkingConfig"] = json!({ "thinkingBudget": budget });
        }
        if let Some(sys) = request.system.as_deref() {
            if !sys.is_empty() {
                body["systemInstruction"] = json!({
                    "role": "system",
                    "parts": [{ "text": sys }],
                });
            }
        }
        if !request.tools.is_empty() {
            // Aura passes Anthropic-shape tools (`{name, description,
            // input_schema}`); Gemini wants `tools: [{ functionDeclarations:
            // [{name, description, parameters}] }]`. `tool_to_function_-
            // declaration` maps `input_schema → parameters` and sanitizes the
            // schema into Gemini's OpenAPI-3.0 subset (drops `$schema`,
            // `additionalProperties`, etc.) so the request is valid. Empty
            // tools → no `tools` key, leaving the byte-stable no-tool request.
            let decls: Vec<Value> = request
                .tools
                .iter()
                .map(tool_to_function_declaration)
                .collect();
            body["tools"] = json!([{ "functionDeclarations": decls }]);
        }

        let client = super::http::shared_client();
        let res = client
            .post(&endpoint)
            .header("content-type", "application/json")
            .header("accept", "text/event-stream")
            .json(&body)
            .send()
            .await
            .map_err(|e| BrainError::Network {
                message: format!("send: {e}"),
            })?;

        let status = res.status();
        if !status.is_success() {
            let body = res.text().await.unwrap_or_default();
            return Err(BrainError::Api {
                status: status.as_u16(),
                message: body,
            });
        }

        let byte_stream = res
            .bytes_stream()
            .map(|r| r.map_err(|e| std::io::Error::new(std::io::ErrorKind::Other, e)));
        let reader = BufReader::new(tokio_util::io::StreamReader::new(byte_stream));

        let stream = try_stream! {
            let mut lines = reader.lines();
            let mut tool_seq: usize = 0;
            let mut finish_reason: Option<String> = None;
            // Token accounting from Gemini's top-level `usageMetadata`
            // (`promptTokenCount` / `candidatesTokenCount`). Carried to the
            // end of the stream and emitted once as a Usage chunk. Absent →
            // never emitted, so the meter stays hidden.
            let mut input_tokens: u32 = 0;
            let mut output_tokens: u32 = 0;

            while let Some(line) = lines.next_line().await.map_err(|e| BrainError::Network {
                message: format!("read: {e}"),
            })? {
                // Gemini emits both `data: {...}` SSE frames and blank
                // separators. Skip non-data lines.
                let Some(payload) = line.strip_prefix("data: ") else {
                    continue;
                };
                if payload.is_empty() {
                    continue;
                }

                let event: Value = match serde_json::from_str(payload) {
                    Ok(v) => v,
                    Err(e) => {
                        Err(BrainError::Parse { message: format!("sse: {e}") })?;
                        unreachable!()
                    }
                };

                let candidate = match event
                    .get("candidates")
                    .and_then(|v| v.as_array())
                    .and_then(|a| a.first())
                {
                    Some(c) => c.clone(),
                    None => continue,
                };

                if let Some(parts) = candidate
                    .get("content")
                    .and_then(|c| c.get("parts"))
                    .and_then(|p| p.as_array())
                {
                    for part in parts {
                        if let Some(text) = part.get("text").and_then(|v| v.as_str()) {
                            if !text.is_empty() {
                                // Gemini flags chain-of-thought parts with
                                // `"thought": true`; route those to the
                                // collapsible reasoning block, ordinary text to
                                // the answer bubble.
                                let is_thought = part
                                    .get("thought")
                                    .and_then(|v| v.as_bool())
                                    .unwrap_or(false);
                                if is_thought {
                                    yield ChatChunk::Reasoning {
                                        block_idx: 0,
                                        text: text.to_string(),
                                    };
                                } else {
                                    yield ChatChunk::Text {
                                        block_idx: 0,
                                        text: text.to_string(),
                                    };
                                }
                            }
                        }
                        if let Some(call) = part.get("functionCall") {
                            let name = call
                                .get("name")
                                .and_then(|v| v.as_str())
                                .unwrap_or("")
                                .to_string();
                            let input = call.get("args").cloned().unwrap_or(json!({}));
                            // Gemini doesn't ship a call id; synthesize one
                            // so the caller can correlate the tool_result.
                            let tool_use_id = format!("gemini-call-{}", tool_seq);
                            tool_seq += 1;
                            yield ChatChunk::ToolUse {
                                block_idx: 0,
                                tool_use_id,
                                name,
                                input,
                            };
                        }
                    }
                }

                if let Some(reason) = candidate.get("finishReason").and_then(|v| v.as_str()) {
                    if !reason.is_empty() {
                        finish_reason = Some(reason.to_string());
                    }
                }

                // usageMetadata is a top-level sibling of `candidates`, sent
                // on the trailing chunk(s). Latest wins.
                if let Some(meta) = event.get("usageMetadata") {
                    if let Some(n) = meta.get("promptTokenCount").and_then(|v| v.as_u64()) {
                        input_tokens = n as u32;
                    }
                    if let Some(n) = meta.get("candidatesTokenCount").and_then(|v| v.as_u64()) {
                        output_tokens = n as u32;
                    }
                }
            }

            if input_tokens > 0 || output_tokens > 0 {
                yield ChatChunk::Usage { input_tokens, output_tokens };
            }
            yield ChatChunk::End { stop_reason: finish_reason };
        };

        Ok(Box::pin(stream))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn request_with(messages: Value, tools: Value) -> ChatRequest {
        serde_json::from_value(json!({
            "messages": messages,
            "tools": tools,
        }))
        .expect("valid ChatRequest")
    }

    #[test]
    fn sanitize_strips_unsupported_keywords() {
        // An Anthropic-style input_schema carrying draft keywords Gemini's
        // OpenAPI subset rejects.
        let raw = json!({
            "$schema": "https://json-schema.org/draft/2020-12/schema",
            "type": "object",
            "additionalProperties": false,
            "title": "Args",
            "properties": {
                "id": { "type": "string", "description": "the id", "default": "" },
                "tags": {
                    "type": "array",
                    "items": { "type": "string", "const": "x" }
                }
            },
            "required": ["id"]
        });
        let clean = sanitize_schema(raw);
        let obj = clean.as_object().expect("object");
        // Dropped at the top level.
        assert!(!obj.contains_key("$schema"));
        assert!(!obj.contains_key("additionalProperties"));
        assert!(!obj.contains_key("title"));
        // Kept.
        assert_eq!(obj["type"], "object");
        assert_eq!(obj["required"], json!(["id"]));
        // Recursed into properties: `default` gone, `description`/`type` kept.
        let id = &obj["properties"]["id"];
        assert!(!id.as_object().unwrap().contains_key("default"));
        assert_eq!(id["type"], "string");
        assert_eq!(id["description"], "the id");
        // Recursed into items: `const` gone, `type` kept.
        let items = &obj["properties"]["tags"]["items"];
        assert!(!items.as_object().unwrap().contains_key("const"));
        assert_eq!(items["type"], "string");
    }

    #[test]
    fn tool_maps_input_schema_to_parameters() {
        // Anthropic-format tool → Gemini functionDeclaration.
        let tool = json!({
            "name": "aura_task_get",
            "description": "Get one task.",
            "input_schema": {
                "type": "object",
                "$schema": "x",
                "properties": { "id": { "type": "string" } },
                "required": ["id"]
            }
        });
        let decl = tool_to_function_declaration(&tool);
        assert_eq!(decl["name"], "aura_task_get");
        assert_eq!(decl["description"], "Get one task.");
        // input_schema became parameters, sanitized (no $schema), recursed.
        let params = decl["parameters"].as_object().expect("parameters");
        assert!(!params.contains_key("$schema"));
        assert_eq!(params["type"], "object");
        assert_eq!(params["properties"]["id"]["type"], "string");
        assert_eq!(params["required"], json!(["id"]));
    }

    #[test]
    fn request_translates_tools_into_function_declarations() {
        let req = request_with(
            json!([{ "role": "user", "content": "hi" }]),
            json!([{
                "name": "aura_tasks_list",
                "description": "List tasks.",
                "input_schema": { "type": "object", "properties": {} }
            }]),
        );
        let decls: Vec<Value> = req
            .tools
            .iter()
            .map(tool_to_function_declaration)
            .collect();
        let tools_val = json!([{ "functionDeclarations": decls }]);
        let arr = tools_val.as_array().unwrap();
        let fns = arr[0]["functionDeclarations"].as_array().unwrap();
        assert_eq!(fns.len(), 1);
        assert_eq!(fns[0]["name"], "aura_tasks_list");
        assert!(fns[0]["parameters"].is_object());
    }

    #[test]
    fn function_call_round_trips_to_response_by_name() {
        // A full Anthropic-shaped tool loop turn as the native loop builds it:
        //   user → assistant(text + tool_use id=gemini-call-0) → user(tool_result)
        // build_contents must emit a functionCall (name=aura_task_get) AND a
        // functionResponse whose name resolves BACK to aura_task_get (not the
        // synthetic id), so Gemini can match them.
        let messages = json!([
            { "role": "user", "content": "get AURA-1" },
            { "role": "assistant", "content": [
                { "type": "text", "text": "looking" },
                { "type": "tool_use", "id": "gemini-call-0", "name": "aura_task_get",
                  "input": { "id": "AURA-1" } }
            ]},
            { "role": "user", "content": [
                { "type": "tool_result", "tool_use_id": "gemini-call-0",
                  "content": "{\"title\":\"x\"}", "is_error": false }
            ]}
        ]);
        let req = request_with(messages, json!([]));
        let contents = build_contents(&req);

        // assistant → model, carries the functionCall by NAME.
        let model_turn = &contents[1];
        assert_eq!(model_turn["role"], "model");
        let call = model_turn["parts"][1]["functionCall"].clone();
        assert_eq!(call["name"], "aura_task_get");
        assert_eq!(call["args"]["id"], "AURA-1");

        // tool_result user turn → functionResponse, name resolved back to the
        // function name (NOT the synthetic gemini-call-0 id) so it matches.
        let resp_turn = &contents[2];
        assert_eq!(resp_turn["role"], "user");
        let resp = resp_turn["parts"][0]["functionResponse"].clone();
        assert_eq!(resp["name"], "aura_task_get");
        // Plain-string tool output is wrapped into an object under `content`.
        assert!(resp["response"].is_object());
        assert_eq!(resp["response"]["content"], "{\"title\":\"x\"}");
    }

    #[test]
    fn system_message_in_messages_is_dropped() {
        let req = request_with(
            json!([
                { "role": "system", "content": "you are aura" },
                { "role": "user", "content": "hi" }
            ]),
            json!([]),
        );
        let contents = build_contents(&req);
        // The system message is dropped (hoisted to systemInstruction by the
        // caller); only the user turn survives.
        assert_eq!(contents.len(), 1);
        assert_eq!(contents[0]["role"], "user");
    }
}
