//! AWS Bedrock (Anthropic Claude) as a `Brain` impl.
//!
//! Bedrock speaks the Anthropic Messages body shape, but the endpoint is
//! authenticated with SigV4 and the model id lives in the URL path
//! (`/model/{id}/invoke`) rather than the body. We use the **non-streaming**
//! `/invoke` endpoint and buffer the single JSON response into `ChatChunk`s —
//! deliberately not `invoke-with-response-stream`, whose AWS binary
//! event-stream framing would need a bespoke demuxer we can't exercise
//! without live AWS credentials. A turn therefore arrives in one piece rather
//! than token-by-token; everything else (tool use, usage, stop reason) is
//! preserved exactly.
//!
//! Config (from `BrainSettings.providers["bedrock"]`):
//!   - `extra.region`         e.g. "us-east-1"        (required)
//!   - `extra.access_key_id`  IAM access key id       (required)
//!   - `extra.session_token`  temp-cred token         (optional)
//!   - `model` / `extra.model` Bedrock model id       (required),
//!         e.g. "anthropic.claude-3-5-sonnet-20241022-v2:0" or an inference
//!         profile like "us.anthropic.claude-sonnet-4-5-20250929-v1:0".
//! The secret access key is stored in the OS keychain under account
//! `"bedrock"`, never in settings JSON.
#![cfg(feature = "brain_bedrock")]

use async_stream::try_stream;
use async_trait::async_trait;
use futures_util::stream::BoxStream;
use serde_json::{Value, json};

use super::{
    Brain,
    aws_sigv4::{self, AwsCredentials},
    types::{BrainCapabilities, BrainError, ChatChunk, ChatRequest, cap_keys},
};

const PROVIDER_ID: &str = "bedrock";
const SERVICE: &str = "bedrock";
const ANTHROPIC_VERSION: &str = "bedrock-2023-05-31";
const DEFAULT_MAX_TOKENS: u32 = 4096;

#[derive(Debug, Clone)]
pub struct BedrockBrain {
    access_key_id: String,
    secret_access_key: String,
    session_token: Option<String>,
    region: String,
    model: String,
}

impl BedrockBrain {
    pub fn new(
        access_key_id: impl Into<String>,
        secret_access_key: impl Into<String>,
        region: impl Into<String>,
        model: impl Into<String>,
    ) -> Self {
        Self {
            access_key_id: access_key_id.into(),
            secret_access_key: secret_access_key.into(),
            session_token: None,
            region: region.into(),
            model: model.into(),
        }
    }

    pub fn with_session_token(mut self, token: Option<String>) -> Self {
        self.session_token = token.filter(|t| !t.is_empty());
        self
    }
}

#[async_trait]
impl Brain for BedrockBrain {
    fn provider_id(&self) -> &str {
        PROVIDER_ID
    }

    fn capabilities(&self) -> BrainCapabilities {
        BrainCapabilities::new()
            // Non-streaming today — the answer arrives as one block. Tool use
            // and usage accounting still work.
            .with(cap_keys::SUPPORTS_STREAMING, false)
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
        // Bedrock model ids are region/profile-specific (e.g.
        // "us.anthropic.claude-…-v1:0"), so the composer's plain Anthropic
        // picker ids ("claude-opus-4-7") don't apply — we always use the
        // configured Bedrock id. A future model picker scoped to Bedrock can
        // pass a real Bedrock id through `request.model`; until then we accept
        // an override only when it looks like a Bedrock id.
        let model = request
            .model
            .as_deref()
            .filter(|m| m.contains("anthropic."))
            .unwrap_or(&self.model)
            .to_string();

        let host = format!("bedrock-runtime.{}.amazonaws.com", self.region);
        let encoded_path = aws_sigv4::encode_path(&format!("/model/{model}/invoke"));
        let url = format!("https://{host}{encoded_path}");

        // Anthropic Messages body, minus `model` (in the URL) and `stream`.
        let mut body = json!({
            "anthropic_version": ANTHROPIC_VERSION,
            "max_tokens": request.max_tokens.unwrap_or(DEFAULT_MAX_TOKENS),
            "messages": request.messages,
        });
        if let Some(sys) = request.system.as_deref().filter(|s| !s.is_empty()) {
            body["system"] = json!(sys);
        }
        if !request.tools.is_empty() {
            body["tools"] = json!(request.tools);
        }
        // Extended thinking on Bedrock uses the same `thinking` block; leave
        // temperature off when it's enabled (Anthropic requires temp==1 then).
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

        let payload = serde_json::to_vec(&body).map_err(|e| BrainError::Other {
            message: format!("serialize bedrock body: {e}"),
        })?;

        let amz_date = chrono::Utc::now().format("%Y%m%dT%H%M%SZ").to_string();
        let creds = AwsCredentials {
            access_key_id: self.access_key_id.clone(),
            secret_access_key: self.secret_access_key.clone(),
            session_token: self.session_token.clone(),
        };
        let signed = aws_sigv4::sign_post(
            &creds,
            &self.region,
            SERVICE,
            &host,
            &encoded_path,
            "application/json",
            &payload,
            &amz_date,
        );

        let client = reqwest::Client::new();
        let mut req = client
            .post(&url)
            .header("content-type", "application/json");
        for (k, v) in &signed {
            req = req.header(k.as_str(), v.as_str());
        }
        let res = req
            .body(payload)
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

        let resp: Value = res.json().await.map_err(|e| BrainError::Parse {
            message: format!("bedrock json: {e}"),
        })?;

        // Reassemble the single response into the same chunk sequence a
        // streaming brain emits, so the frontend renders it identically.
        let mut chunks: Vec<ChatChunk> = Vec::new();
        if let Some(content) = resp.get("content").and_then(|c| c.as_array()) {
            for (idx, block) in content.iter().enumerate() {
                match block.get("type").and_then(|v| v.as_str()) {
                    Some("text") => {
                        let text = block
                            .get("text")
                            .and_then(|v| v.as_str())
                            .unwrap_or("")
                            .to_string();
                        if !text.is_empty() {
                            chunks.push(ChatChunk::Text {
                                block_idx: idx,
                                text,
                            });
                        }
                    }
                    Some("tool_use") => {
                        chunks.push(ChatChunk::ToolUse {
                            block_idx: idx,
                            tool_use_id: block
                                .get("id")
                                .and_then(|v| v.as_str())
                                .unwrap_or("")
                                .to_string(),
                            name: block
                                .get("name")
                                .and_then(|v| v.as_str())
                                .unwrap_or("")
                                .to_string(),
                            input: block.get("input").cloned().unwrap_or(json!({})),
                        });
                    }
                    _ => {}
                }
            }
        }
        if let Some(usage) = resp.get("usage") {
            let input_tokens = usage
                .get("input_tokens")
                .and_then(|v| v.as_u64())
                .unwrap_or(0) as u32;
            let output_tokens = usage
                .get("output_tokens")
                .and_then(|v| v.as_u64())
                .unwrap_or(0) as u32;
            if input_tokens > 0 || output_tokens > 0 {
                chunks.push(ChatChunk::Usage {
                    input_tokens,
                    output_tokens,
                });
            }
        }
        let stop_reason = resp
            .get("stop_reason")
            .and_then(|v| v.as_str())
            .map(|s| s.to_string());
        chunks.push(ChatChunk::End { stop_reason });

        let stream = try_stream! {
            for chunk in chunks {
                yield chunk;
            }
        };
        Ok(Box::pin(stream))
    }
}
