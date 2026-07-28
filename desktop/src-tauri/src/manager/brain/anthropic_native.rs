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

use async_trait::async_trait;
use futures_util::stream::BoxStream;
use serde_json::json;

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

        let client = super::http::shared_client();
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

        // Decode the SSE body via the shared Anthropic decoder (also used by
        // the Vertex brain, which speaks the identical event stream).
        Ok(super::anthropic_sse::decode_stream(res))
    }
}
