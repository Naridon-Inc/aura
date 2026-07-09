//! OpenAI Chat Completions API as a `Brain` impl.
//!
//! Streams from `api.openai.com/v1/chat/completions` with `stream: true`
//! and parses SSE `data: {...}` lines into `ChatChunk`s. Maps
//! `choices[0].delta.content` to `ChatChunk::Text` and assembles
//! `choices[0].delta.tool_calls[].function.arguments` deltas into one
//! `ChatChunk::ToolUse` per tool call once the call finishes (signaled
//! by either a new tool-call `index` or stream end). `data: [DONE]`
//! emits `ChatChunk::End` and breaks the loop. Non-2xx → `BrainError::Api`.
//!
//! W6 of v0.2.30 KK.3. Real wire-protocol impl; opt-in via the
//! `brain_openai_native` Cargo feature. Default-on lands in v0.2.31.

#![cfg(feature = "brain_openai_native")]

use async_stream::try_stream;
use async_trait::async_trait;
use futures_util::{StreamExt, stream::BoxStream};
use serde_json::{Value, json};
use tokio::io::{AsyncBufReadExt, BufReader};

use super::{
    Brain,
    types::{BrainCapabilities, BrainError, ChatChunk, ChatRequest, cap_keys},
};

const PROVIDER_ID: &str = "openai_native";
const ENDPOINT: &str = "https://api.openai.com/v1/chat/completions";
const DEFAULT_MODEL: &str = "gpt-4o";
const DEFAULT_MAX_TOKENS: u32 = 4096;

#[derive(Debug, Clone)]
pub struct OpenAINativeBrain {
    api_key: String,
    model: String,
    /// Optional override base URL (used by Azure OpenAI, OpenAI-compatible
    /// gateways, and tests). None → real endpoint.
    base_url: Option<String>,
}

impl OpenAINativeBrain {
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

    fn endpoint(&self) -> String {
        self.base_url.clone().unwrap_or_else(|| ENDPOINT.into())
    }
}

/// Translate Aura's Anthropic-shaped `ChatRequest` into OpenAI's
/// `messages: [{role, content}]` array. system prompt becomes a
/// leading `{"role":"system"}` entry. Content blocks that aren't a
/// plain string are passed through as JSON — OpenAI accepts the
/// multi-part `content: [{type:"text"|"image_url", ...}]` shape.
fn build_messages(req: &ChatRequest) -> Vec<Value> {
    let mut out: Vec<Value> = Vec::with_capacity(req.messages.len() + 1);
    if let Some(sys) = req.system.as_deref() {
        if !sys.is_empty() {
            out.push(json!({ "role": "system", "content": sys }));
        }
    }
    for m in &req.messages {
        out.push(json!({ "role": m.role, "content": m.content }));
    }
    out
}

#[async_trait]
impl Brain for OpenAINativeBrain {
    fn provider_id(&self) -> &str {
        PROVIDER_ID
    }

    fn capabilities(&self) -> BrainCapabilities {
        BrainCapabilities::new()
            .with(cap_keys::SUPPORTS_STREAMING, true)
            .with(cap_keys::SUPPORTS_TOOL_USE, true)
            .with(cap_keys::SUPPORTS_VISION, true)
            .with(cap_keys::MAX_INPUT_TOKENS, 128_000)
            .with(cap_keys::MAX_OUTPUT_TOKENS, 16_384)
            .with(cap_keys::DEFAULT_MODEL, json!(self.model.clone()))
            .with(
                cap_keys::SUPPORTED_MODELS,
                json!([
                    "gpt-4o",
                    "gpt-4o-mini",
                    "gpt-4.1",
                    "o1",
                    "o1-mini",
                ]),
            )
    }

    async fn chat(
        &self,
        request: ChatRequest,
    ) -> Result<BoxStream<'static, Result<ChatChunk, BrainError>>, BrainError> {
        let endpoint = self.endpoint();
        let api_key = self.api_key.clone();
        // Per-turn model override from the composer's model picker; Auto
        // falls back to this brain's configured model.
        let model = request
            .model
            .clone()
            .unwrap_or_else(|| self.model.clone());

        let mut body = json!({
            "model": model,
            "messages": build_messages(&request),
            "max_tokens": request.max_tokens.unwrap_or(DEFAULT_MAX_TOKENS),
            "stream": true,
        });
        if let Some(temp) = request.temperature {
            body["temperature"] = json!(temp);
        }
        if !request.tools.is_empty() {
            body["tools"] = json!(request.tools);
        }
        // Reasoning models (GPT-5 / o-series) take `reasoning_effort` and use
        // `max_completion_tokens` instead of `max_tokens`, and reject a custom
        // temperature. Only reshape when the caller picked an effort — with
        // effort=None the body is unchanged.
        if let Some(effort) = request.effort {
            let value = if request.fast {
                "minimal"
            } else {
                effort.openai_value()
            };
            body["reasoning_effort"] = json!(value);
            if let Some(obj) = body.as_object_mut() {
                if let Some(mt) = obj.remove("max_tokens") {
                    obj.insert("max_completion_tokens".to_string(), mt);
                }
                obj.remove("temperature");
            }
        }

        let client = reqwest::Client::new();
        let res = client
            .post(&endpoint)
            .bearer_auth(&api_key)
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

        // Adapt reqwest's bytes stream to an AsyncBufRead so we can read
        // SSE lines ergonomically (same pattern as anthropic_native).
        let byte_stream = res
            .bytes_stream()
            .map(|r| r.map_err(|e| std::io::Error::new(std::io::ErrorKind::Other, e)));
        let reader = BufReader::new(tokio_util::io::StreamReader::new(byte_stream));

        let stream = try_stream! {
            let mut lines = reader.lines();

            // Tool-call assembly state. OpenAI streams partial JSON in
            // `delta.tool_calls[i].function.arguments` and identifies each
            // call by its `index`. We flush a `ChatChunk::ToolUse` when a
            // new index appears or the stream ends.
            let mut tool_index: Option<u64> = None;
            let mut tool_id = String::new();
            let mut tool_name = String::new();
            let mut tool_args = String::new();
            // Token accounting — when the request opts into usage
            // (`stream_options.include_usage`) OpenAI sends a trailing chunk
            // whose `usage` block carries `prompt_tokens` / `completion_tokens`.
            // Capture it whenever present and emit a single Usage chunk before
            // End; absent → never emitted, meter stays hidden.
            let mut last_usage: Option<(u32, u32)> = None;

            while let Some(line) = lines.next_line().await.map_err(|e| BrainError::Network {
                message: format!("read: {e}"),
            })? {
                let Some(payload) = line.strip_prefix("data: ") else {
                    continue;
                };
                if payload == "[DONE]" {
                    // Flush any open tool call before ending.
                    if tool_index.is_some() {
                        let input: Value = serde_json::from_str(&tool_args)
                            .unwrap_or(json!({}));
                        yield ChatChunk::ToolUse {
                            block_idx: 0,
                            tool_use_id: std::mem::take(&mut tool_id),
                            name: std::mem::take(&mut tool_name),
                            input,
                        };
                        tool_args.clear();
                        tool_index = None;
                    }
                    if let Some((input_tokens, output_tokens)) = last_usage.take() {
                        yield ChatChunk::Usage { input_tokens, output_tokens };
                    }
                    yield ChatChunk::End { stop_reason: None };
                    break;
                }

                let event: Value = match serde_json::from_str(payload) {
                    Ok(v) => v,
                    Err(e) => {
                        Err(BrainError::Parse { message: format!("sse: {e}") })?;
                        unreachable!()
                    }
                };

                // `usage` rides a trailing chunk (often with empty `choices`)
                // when the caller asked for it. OpenAI uses prompt/completion
                // token names; map them onto our input/output pair.
                if let Some(usage) = event.get("usage").filter(|u| u.is_object()) {
                    let input_tokens = usage
                        .get("prompt_tokens")
                        .and_then(|v| v.as_u64())
                        .unwrap_or(0) as u32;
                    let output_tokens = usage
                        .get("completion_tokens")
                        .and_then(|v| v.as_u64())
                        .unwrap_or(0) as u32;
                    if input_tokens > 0 || output_tokens > 0 {
                        last_usage = Some((input_tokens, output_tokens));
                    }
                }

                let choice = match event.get("choices").and_then(|v| v.as_array()).and_then(|a| a.first()) {
                    Some(c) => c.clone(),
                    None => continue,
                };
                let delta = choice.get("delta").cloned().unwrap_or(json!({}));

                // Text deltas: choices[0].delta.content.
                if let Some(text) = delta.get("content").and_then(|v| v.as_str()) {
                    if !text.is_empty() {
                        yield ChatChunk::Text { block_idx: 0, text: text.to_string() };
                    }
                }

                // Tool-call deltas: choices[0].delta.tool_calls[].
                if let Some(calls) = delta.get("tool_calls").and_then(|v| v.as_array()) {
                    for call in calls {
                        let idx = call.get("index").and_then(|v| v.as_u64());

                        // A new index means flush the previous call and
                        // start fresh. Same index means accumulate.
                        if let Some(new_idx) = idx {
                            if tool_index != Some(new_idx) {
                                if tool_index.is_some() {
                                    let input: Value = serde_json::from_str(&tool_args)
                                        .unwrap_or(json!({}));
                                    yield ChatChunk::ToolUse {
                                        block_idx: 0,
                                        tool_use_id: std::mem::take(&mut tool_id),
                                        name: std::mem::take(&mut tool_name),
                                        input,
                                    };
                                    tool_args.clear();
                                }
                                tool_index = Some(new_idx);
                            }
                        }

                        if let Some(id) = call.get("id").and_then(|v| v.as_str()) {
                            if !id.is_empty() {
                                tool_id = id.to_string();
                            }
                        }
                        if let Some(func) = call.get("function") {
                            if let Some(name) = func.get("name").and_then(|v| v.as_str()) {
                                if !name.is_empty() {
                                    tool_name = name.to_string();
                                }
                            }
                            if let Some(args) = func.get("arguments").and_then(|v| v.as_str()) {
                                tool_args.push_str(args);
                            }
                        }
                    }
                }

                // finish_reason on the choice closes the turn even without [DONE].
                if let Some(reason) = choice.get("finish_reason").and_then(|v| v.as_str()) {
                    if !reason.is_empty() {
                        if tool_index.is_some() {
                            let input: Value = serde_json::from_str(&tool_args)
                                .unwrap_or(json!({}));
                            yield ChatChunk::ToolUse {
                                block_idx: 0,
                                tool_use_id: std::mem::take(&mut tool_id),
                                name: std::mem::take(&mut tool_name),
                                input,
                            };
                            tool_args.clear();
                            tool_index = None;
                        }
                        if let Some((input_tokens, output_tokens)) = last_usage.take() {
                            yield ChatChunk::Usage { input_tokens, output_tokens };
                        }
                        yield ChatChunk::End { stop_reason: Some(reason.to_string()) };
                        break;
                    }
                }
            }
        };

        Ok(Box::pin(stream))
    }
}
