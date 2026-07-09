//! Anthropic Messages API as a `Brain` impl.
//!
//! Streams from `api.anthropic.com/v1/messages` with `stream: true` and
//! parses the SSE event types we care about into `ChatChunk`s. Maps
//! `text_delta`, `content_block_start` (`tool_use`), `input_json_delta`,
//! and `message_stop` events; everything else is ignored.
//!
//! This is the "new path" Brain impl. The legacy `run_anthropic` in
//! `legacy.rs` still drives the existing manager loop; W5 swaps the
//! caller to `BrainManager` and retires the legacy path.

#![cfg(feature = "brain_anthropic_native")]

use async_stream::try_stream;
use async_trait::async_trait;
use futures_util::{StreamExt, stream::BoxStream};
use serde_json::{Value, json};
use tokio::io::{AsyncBufReadExt, BufReader};

use super::{
    Brain,
    types::{BrainCapabilities, BrainError, ChatChunk, ChatRequest, cacheable_prefix, cap_keys},
};

const PROVIDER_ID: &str = "anthropic_native";
const ENDPOINT: &str = "https://api.anthropic.com/v1/messages";
const API_VERSION: &str = "2023-06-01";
/// Anthropic 1M-context beta token — sent only when the picker's "1M" model
/// row is selected (`ChatRequest::long_context`). Omitted otherwise, so the
/// default request stays byte-identical.
const LONG_CONTEXT_BETA: &str = "context-1m-2025-08-07";
const DEFAULT_MODEL: &str = "claude-sonnet-4-5-20250929";
const DEFAULT_MAX_TOKENS: u32 = 4096;

#[derive(Debug, Clone)]
pub struct AnthropicNativeBrain {
    api_key: String,
    model: String,
    /// Optional override base URL (used by some proxies). None → real endpoint.
    base_url: Option<String>,
}

impl AnthropicNativeBrain {
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

#[async_trait]
impl Brain for AnthropicNativeBrain {
    fn provider_id(&self) -> &str {
        PROVIDER_ID
    }

    fn capabilities(&self) -> BrainCapabilities {
        BrainCapabilities::new()
            .with(cap_keys::SUPPORTS_STREAMING, true)
            .with(cap_keys::SUPPORTS_TOOL_USE, true)
            .with(cap_keys::SUPPORTS_VISION, true)
            .with(cap_keys::MAX_INPUT_TOKENS, 200_000)
            .with(cap_keys::MAX_OUTPUT_TOKENS, 8_192)
            .with(cap_keys::DEFAULT_MODEL, json!(self.model.clone()))
            .with(
                cap_keys::SUPPORTED_MODELS,
                json!([
                    "claude-sonnet-4-5-20250929",
                    "claude-opus-4-7",
                    "claude-haiku-4-5-20251001",
                ]),
            )
    }

    async fn chat(
        &self,
        request: ChatRequest,
    ) -> Result<BoxStream<'static, Result<ChatChunk, BrainError>>, BrainError> {
        let endpoint = self.endpoint();
        let api_key = self.api_key.clone();
        // Per-turn model override from the composer's model picker; falls
        // back to this brain's configured model when the picker is on Auto.
        let model = request
            .model
            .clone()
            .unwrap_or_else(|| self.model.clone());
        // The picker's "1M" rows light up Anthropic's long-context beta.
        let long_context = request.long_context;

        // Mark the byte-stable prefix (tools + system) with `cache_control`
        // so Anthropic's prompt cache serves it on the 2nd+ round of a tool
        // loop and on later turns of the same session, instead of re-billing
        // the full system+tools every round. Below the cache minimum the
        // markers are simply ignored, so this is always safe to send.
        let (system_val, tools_val) = cacheable_prefix(request.system.as_deref(), &request.tools);

        let mut body = json!({
            "model": model,
            "max_tokens": request.max_tokens.unwrap_or(DEFAULT_MAX_TOKENS),
            "system": system_val,
            "messages": request.messages,
            "tools": tools_val,
            "stream": true,
        });
        // Extended thinking — only when the caller opted into an effort level
        // and not in fast mode. Anthropic requires the temperature be omitted
        // (it must equal 1) while thinking is on, and max_tokens to exceed the
        // thinking budget — so we bump max_tokens and leave temperature off.
        // With no effort the body is byte-identical to before (temperature
        // preserved, no thinking block).
        match request.effort.filter(|_| !request.fast) {
            Some(effort) => {
                let budget = effort.budget_tokens();
                body["thinking"] = json!({ "type": "enabled", "budget_tokens": budget });
                let need = (budget + 4096) as u64;
                if body["max_tokens"].as_u64().unwrap_or(0) < need {
                    body["max_tokens"] = json!(need);
                }
            }
            None => {
                body["temperature"] = json!(request.temperature);
            }
        }

        let client = reqwest::Client::new();
        let mut req_builder = client
            .post(&endpoint)
            .header("x-api-key", &api_key)
            .header("anthropic-version", API_VERSION)
            .header("content-type", "application/json");
        if long_context {
            req_builder = req_builder.header("anthropic-beta", LONG_CONTEXT_BETA);
        }
        let res = req_builder
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

        // Adapt reqwest's bytes stream to a tokio AsyncBufRead so we can
        // read SSE lines ergonomically.
        let byte_stream = res.bytes_stream().map(|r| {
            r.map_err(|e| std::io::Error::new(std::io::ErrorKind::Other, e))
        });
        let reader = BufReader::new(tokio_util::io::StreamReader::new(byte_stream));

        let stream = try_stream! {
            let mut lines = reader.lines();
            let mut current_block: Option<usize> = None;
            let mut current_tool: Option<(String, String, String)> = None; // (id, name, json_buf)
            // Token accounting — Anthropic reports `input_tokens` on
            // `message_start` and the running `output_tokens` on each
            // `message_delta`. We carry the latest of each and emit a single
            // `Usage` chunk just before `End` so the context-fill meter has
            // real numbers. Defaults to 0 when a field is absent.
            let mut input_tokens: u32 = 0;
            let mut output_tokens: u32 = 0;

            while let Some(line) = lines.next_line().await.map_err(|e| BrainError::Network {
                message: format!("read: {e}"),
            })? {
                let Some(payload) = line.strip_prefix("data: ") else {
                    continue;
                };
                if payload == "[DONE]" {
                    break;
                }

                let event: Value = match serde_json::from_str(payload) {
                    Ok(v) => v,
                    Err(e) => {
                        Err(BrainError::Parse { message: format!("sse: {e}") })?;
                        unreachable!()
                    }
                };

                let kind = event.get("type").and_then(|v| v.as_str()).unwrap_or("");

                match kind {
                    "message_start" => {
                        // The opening event carries the billed prompt size.
                        if let Some(n) = event
                            .get("message")
                            .and_then(|m| m.get("usage"))
                            .and_then(|u| u.get("input_tokens"))
                            .and_then(|v| v.as_u64())
                        {
                            input_tokens = n as u32;
                        }
                    }
                    "content_block_start" => {
                        let idx = event
                            .get("index")
                            .and_then(|v| v.as_u64())
                            .unwrap_or(0) as usize;
                        current_block = Some(idx);
                        let block = event.get("content_block").cloned().unwrap_or(json!({}));
                        if block.get("type").and_then(|v| v.as_str()) == Some("tool_use") {
                            let id = block
                                .get("id")
                                .and_then(|v| v.as_str())
                                .unwrap_or("")
                                .to_string();
                            let name = block
                                .get("name")
                                .and_then(|v| v.as_str())
                                .unwrap_or("")
                                .to_string();
                            current_tool = Some((id, name, String::new()));
                        }
                    }
                    "content_block_delta" => {
                        let idx = event
                            .get("index")
                            .and_then(|v| v.as_u64())
                            .unwrap_or(0) as usize;
                        let delta = event.get("delta").cloned().unwrap_or(json!({}));
                        match delta.get("type").and_then(|v| v.as_str()) {
                            Some("text_delta") => {
                                let text = delta
                                    .get("text")
                                    .and_then(|v| v.as_str())
                                    .unwrap_or("")
                                    .to_string();
                                if !text.is_empty() {
                                    yield ChatChunk::Text { block_idx: idx, text };
                                }
                            }
                            // Extended thinking — the model streams its
                            // chain-of-thought as `thinking_delta` blocks when
                            // the caller enabled a thinking budget (effort
                            // chip). Surface them as a separate Reasoning
                            // block so the UI can collapse them away from the
                            // answer prose. `signature_delta` (the opaque
                            // thinking signature) carries no readable text and
                            // is intentionally dropped.
                            Some("thinking_delta") => {
                                let text = delta
                                    .get("thinking")
                                    .and_then(|v| v.as_str())
                                    .unwrap_or("")
                                    .to_string();
                                if !text.is_empty() {
                                    yield ChatChunk::Reasoning { block_idx: idx, text };
                                }
                            }
                            Some("input_json_delta") => {
                                if let Some((_, _, buf)) = current_tool.as_mut() {
                                    if let Some(s) = delta
                                        .get("partial_json")
                                        .and_then(|v| v.as_str())
                                    {
                                        buf.push_str(s);
                                    }
                                }
                            }
                            _ => {}
                        }
                    }
                    "content_block_stop" => {
                        if let Some((id, name, buf)) = current_tool.take() {
                            let input: Value = serde_json::from_str(&buf)
                                .unwrap_or(json!({}));
                            yield ChatChunk::ToolUse {
                                block_idx: current_block.unwrap_or(0),
                                tool_use_id: id,
                                name,
                                input,
                            };
                        }
                    }
                    "message_delta" => {
                        // stop_reason lands here on the final delta; we
                        // surface it via the End chunk below when the
                        // stream completes. The cumulative output-token count
                        // also rides on this event's `usage` block.
                        if let Some(n) = event
                            .get("usage")
                            .and_then(|u| u.get("output_tokens"))
                            .and_then(|v| v.as_u64())
                        {
                            output_tokens = n as u32;
                        }
                    }
                    "message_stop" => {
                        // Emit token accounting just before End so the UI's
                        // context-fill meter updates atomically with turn end.
                        if input_tokens > 0 || output_tokens > 0 {
                            yield ChatChunk::Usage { input_tokens, output_tokens };
                        }
                        yield ChatChunk::End { stop_reason: None };
                        break;
                    }
                    _ => {}
                }
            }
        };

        Ok(Box::pin(stream))
    }
}
