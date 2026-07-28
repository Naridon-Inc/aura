//! Google Vertex AI (Anthropic Claude) as a `Brain` impl.
//!
//! Anthropic-on-Vertex speaks the identical Anthropic Messages SSE stream as
//! `api.anthropic.com`, so this brain is thin: mint a GCP OAuth2 Bearer token
//! from the service-account JSON (see `gcp_oauth`), POST to the
//! `:streamRawPredict` endpoint, and hand the response body to the shared
//! [`super::anthropic_sse::decode_stream`]. The only Vertex-specific shape is
//! the model living in the URL path and `anthropic_version` in the body
//! (`vertex-2023-10-16`) instead of a `model` field.
//!
//! Config (from `BrainSettings.providers["vertex"]`):
//!   - `extra.project_id`  GCP project id                (required)
//!   - `extra.location`    region, e.g. "us-east5"        (required)
//!   - `model` / `extra.model`  Vertex model id           (required),
//!         e.g. "claude-sonnet-4-5@20250929".
//! The service-account JSON is stored in the OS keychain under account
//! `"vertex"`, never in settings.
#![cfg(feature = "brain_vertex")]

use std::sync::Arc;

use async_trait::async_trait;
use futures_util::stream::BoxStream;
use serde_json::json;
use tokio::sync::Mutex;

use super::{
    Brain,
    gcp_oauth::{AccessToken, ServiceAccount, fetch_access_token},
    types::{BrainCapabilities, BrainError, ChatChunk, ChatRequest, cap_keys},
};

const PROVIDER_ID: &str = "vertex";
const ANTHROPIC_VERSION: &str = "vertex-2023-10-16";
const DEFAULT_MAX_TOKENS: u32 = 4096;
/// Refresh a cached token this many seconds before it actually expires, so a
/// turn never starts with a token that lapses mid-request.
const REFRESH_SKEW_SECS: i64 = 120;

#[derive(Clone)]
pub struct VertexBrain {
    sa: ServiceAccount,
    project_id: String,
    location: String,
    model: String,
    /// Cached access token, shared across turns; refreshed when near expiry.
    token: Arc<Mutex<Option<AccessToken>>>,
}

impl VertexBrain {
    pub fn new(
        sa: ServiceAccount,
        project_id: impl Into<String>,
        location: impl Into<String>,
        model: impl Into<String>,
    ) -> Self {
        Self {
            sa,
            project_id: project_id.into(),
            location: location.into(),
            model: model.into(),
            token: Arc::new(Mutex::new(None)),
        }
    }

    /// Return a valid Bearer token, minting or refreshing as needed.
    async fn access_token(&self) -> Result<String, BrainError> {
        let now = chrono::Utc::now().timestamp();
        let mut guard = self.token.lock().await;
        let needs_refresh = match guard.as_ref() {
            Some(tok) => tok.is_expiring(now, REFRESH_SKEW_SECS),
            None => true,
        };
        if needs_refresh {
            let fresh = fetch_access_token(&self.sa).await?;
            *guard = Some(fresh);
        }
        Ok(guard.as_ref().expect("token set above").token.clone())
    }
}

#[async_trait]
impl Brain for VertexBrain {
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
    }

    async fn chat(
        &self,
        request: ChatRequest,
    ) -> Result<BoxStream<'static, Result<ChatChunk, BrainError>>, BrainError> {
        let token = self.access_token().await?;

        // Vertex model ids carry an `@version` suffix (e.g.
        // "claude-sonnet-4-5@20250929"); the composer's plain Anthropic picker
        // ids don't apply. Accept a per-turn override only when it looks like a
        // Vertex id, otherwise use the configured model.
        let model = request
            .model
            .as_deref()
            .filter(|m| m.contains('@'))
            .unwrap_or(&self.model)
            .to_string();

        let endpoint = format!(
            "https://{loc}-aiplatform.googleapis.com/v1/projects/{proj}/locations/{loc}/publishers/anthropic/models/{model}:streamRawPredict",
            loc = self.location,
            proj = self.project_id,
        );

        // Anthropic Messages body, minus `model` (in the URL) plus the Vertex
        // `anthropic_version` discriminator.
        let mut body = json!({
            "anthropic_version": ANTHROPIC_VERSION,
            "max_tokens": request.max_tokens.unwrap_or(DEFAULT_MAX_TOKENS),
            "messages": request.messages,
            "stream": true,
        });
        if let Some(sys) = request.system.as_deref().filter(|s| !s.is_empty()) {
            body["system"] = json!(sys);
        }
        if !request.tools.is_empty() {
            body["tools"] = json!(request.tools);
        }
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
                if let Some(temp) = request.temperature {
                    body["temperature"] = json!(temp);
                }
            }
        }

        let client = reqwest::Client::new();
        let res = client
            .post(&endpoint)
            .header("authorization", format!("Bearer {token}"))
            .header("content-type", "application/json")
            .json(&body)
            .send()
            .await
            .map_err(|e| BrainError::Network {
                message: format!("send: {e}"),
            })?;

        let status = res.status();
        if !status.is_success() {
            let text = res.text().await.unwrap_or_default();
            return Err(BrainError::Api {
                status: status.as_u16(),
                message: text,
            });
        }

        Ok(super::anthropic_sse::decode_stream(res))
    }
}
