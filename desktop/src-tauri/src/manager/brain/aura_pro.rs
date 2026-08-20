//! Aura Pro — managed/subscription `Brain` impl.
//!
//! v0.2.31 task #352. Unlike the BYOK rows (`anthropic_native`,
//! `openai_native`, `gemini_native`, `openai_compat`), this brain
//! doesn't need the user to paste an API key. It posts to the
//! aura-cloud proxy (`POST /v1/brain/anthropic/messages/stream`)
//! with the same `cloud_api_token` that OnboardingDialog already
//! stashes in `~/.aura/credentials.json`, and the cloud forwards to
//! Anthropic using a server-side key.
//!
//! Wire shape on the way out is identical to `anthropic_native` so
//! the SSE parser is essentially the same: `content_block_start`,
//! `content_block_delta` (`text_delta` + `input_json_delta`),
//! `content_block_stop`, `message_stop`. The only real difference is
//! the failure surface — `auth_required` (401) maps to
//! `BrainError::AuthRequired` so the picker can re-launch sign-in,
//! and `quota_exceeded` (402) maps to `BrainError::QuotaExceeded`
//! with the served-back token counts so the UI can render an exact
//! banner.
//!
//! The Anthropic SSE parser is intentionally inlined here rather than
//! factored into a shared `anthropic_sse.rs` helper. The two impls
//! differ in their HTTP setup (Bearer aura-token vs. `x-api-key`) and
//! in their error mapping; sharing the inner loop would force a
//! generic error-mapper closure that's actually heavier than the
//! 60-line duplication. If a third Anthropic-shaped consumer ever
//! appears, the extraction will pay for itself — until then, keep it
//! readable.

#![cfg(feature = "brain_aura_pro")]

use async_stream::try_stream;
use async_trait::async_trait;
use futures_util::{StreamExt, stream::BoxStream};
use serde_json::{Value, json};
use tokio::io::{AsyncBufReadExt, BufReader};

use super::{
    Brain,
    types::{BrainCapabilities, BrainError, ChatChunk, ChatRequest, cacheable_prefix, cap_keys},
};
use crate::cloud_org::OrgScoped;

pub const PROVIDER_ID: &str = "aura_pro";

/// Snapshot of the currently-stored Aura credentials. Returned from
/// [`read_credentials`] so the registry can both check sign-in state
/// (is the token present?) and construct an `AuraProBrain` without
/// re-reading the file. `None` for either field means "not set".
#[derive(Debug, Clone, Default)]
pub struct AuraCredentials {
    pub cloud_token: Option<String>,
    pub cloud_origin: Option<String>,
    pub cloud_user: Option<String>,
}

impl AuraCredentials {
    pub fn is_signed_in(&self) -> bool {
        self.cloud_token
            .as_deref()
            .map(|t| !t.is_empty())
            .unwrap_or(false)
    }
}

/// Read `~/.aura/credentials.json` and extract the three fields the
/// Aura Pro brain cares about. Returns `Ok(default)` (no token, no
/// origin) when the file is missing / unreadable — sign-in surfaces
/// "not signed in" rather than a hard error.
///
/// We don't take a dependency on `cloud_session_sync` here because
/// that module's helpers are `pub(crate)` and pulling them across the
/// `manager/brain/` boundary would force a public re-export the rest
/// of the codebase doesn't need. The file is small enough that the
/// duplicated read is cheaper than the API surface change.
pub fn read_credentials() -> AuraCredentials {
    let Some(home) = dirs::home_dir() else {
        return AuraCredentials::default();
    };
    let path = home.join(".aura").join("credentials.json");
    let Ok(raw) = std::fs::read_to_string(&path) else {
        return AuraCredentials::default();
    };
    if raw.trim().is_empty() {
        return AuraCredentials::default();
    }
    let Ok(parsed) = serde_json::from_str::<Value>(&raw) else {
        return AuraCredentials::default();
    };
    let obj = match parsed {
        Value::Object(m) => m,
        _ => return AuraCredentials::default(),
    };
    AuraCredentials {
        cloud_token: obj
            .get("cloud_api_token")
            .and_then(|v| v.as_str())
            .map(str::to_string)
            .filter(|s| !s.is_empty()),
        cloud_origin: obj
            .get("cloud_url")
            .and_then(|v| v.as_str())
            .map(|s| s.trim_end_matches('/').to_string())
            .filter(|s| !s.is_empty()),
        cloud_user: obj
            .get("cloud_user")
            .and_then(|v| v.as_str())
            .map(str::to_string)
            .filter(|s| !s.is_empty()),
    }
}

/// Default cloud origin — the picker fetches the override (if any) from
/// `~/.aura/credentials.json` `cloud_url` at construction time so
/// dev/staging deployments work without code changes.
pub const DEFAULT_CLOUD_ORIGIN: &str = "https://auravcs.com";
/// Path on the cloud — kept relative so swapping `DEFAULT_CLOUD_ORIGIN`
/// is the one and only knob.
const STREAM_PATH: &str = "/v1/brain/anthropic/messages/stream";

const ANTHROPIC_VERSION_HEADER: &str = "2023-06-01";
/// Anthropic 1M-context beta token — forwarded through the proxy only when
/// the picker's "1M" model row is selected. Mirrors anthropic_native.
const LONG_CONTEXT_BETA: &str = "context-1m-2025-08-07";
const DEFAULT_MODEL: &str = "claude-sonnet-4-5-20250929";
const DEFAULT_MAX_TOKENS: u32 = 4096;

#[derive(Debug, Clone)]
pub struct AuraProBrain {
    /// The user's Aura cloud token. Pulled from `credentials.json` by
    /// the registry at build-time so we don't re-hit disk per turn.
    aura_token: String,
    /// `https://auravcs.com` or whatever override the user has in
    /// credentials.json. No trailing slash.
    cloud_origin: String,
    /// Anthropic model id the proxy should request. Defaults to the
    /// current Sonnet — the proxy will reject unknown models with the
    /// usual Anthropic error, which we surface as `BrainError::Provider`.
    model: String,
}

impl AuraProBrain {
    pub fn new(aura_token: impl Into<String>) -> Self {
        Self {
            aura_token: aura_token.into(),
            cloud_origin: DEFAULT_CLOUD_ORIGIN.to_string(),
            model: DEFAULT_MODEL.to_string(),
        }
    }

    pub fn with_cloud_origin(mut self, origin: impl Into<String>) -> Self {
        // Defensive trim — credentials.json sometimes has a trailing
        // slash from earlier CLI versions; we want exactly one when we
        // concat with STREAM_PATH.
        let raw = origin.into();
        self.cloud_origin = raw.trim_end_matches('/').to_string();
        self
    }

    pub fn with_model(mut self, model: impl Into<String>) -> Self {
        self.model = model.into();
        self
    }

    fn stream_url(&self) -> String {
        format!("{}{}", self.cloud_origin, STREAM_PATH)
    }
}

#[async_trait]
impl Brain for AuraProBrain {
    fn provider_id(&self) -> &str {
        PROVIDER_ID
    }

    fn capabilities(&self) -> BrainCapabilities {
        // Same shape as anthropic_native — the proxy doesn't downgrade
        // capability, it just adds an auth+quota gate on top.
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
                    "claude-opus-5",
                    "claude-sonnet-5",
                    "claude-haiku-4-5-20251001",
                ]),
            )
    }

    async fn chat(
        &self,
        request: ChatRequest,
    ) -> Result<BoxStream<'static, Result<ChatChunk, BrainError>>, BrainError> {
        let url = self.stream_url();
        let aura_token = self.aura_token.clone();
        // Per-turn model override from the composer's model picker; Auto
        // falls back to the configured model (the proxy rejects unknown ids).
        let model = request
            .model
            .clone()
            .unwrap_or_else(|| self.model.clone());
        // The picker's "1M" rows light up Anthropic's long-context beta —
        // forwarded through the proxy just like the version header below.
        let long_context = request.long_context;

        // Same cache-prefix markers as anthropic_native — the proxy forwards
        // the body to Anthropic verbatim, so `cache_control` on the stable
        // system+tools prefix lets the prompt cache serve repeat rounds/turns.
        let (system_val, tools_val) = cacheable_prefix(request.system.as_deref(), &request.tools);

        let mut body = json!({
            "model": model,
            "max_tokens": request.max_tokens.unwrap_or(DEFAULT_MAX_TOKENS),
            "system": system_val,
            "messages": request.messages,
            "tools": tools_val,
            "stream": true,
        });
        // Extended thinking — the proxy forwards to Anthropic, so the same
        // `thinking` block + temperature/max_tokens rules apply. Only when the
        // caller picked an effort and isn't in fast mode; effort=None leaves
        // the body byte-identical to before.
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
            .post(&url)
            .bearer_auth(&aura_token)
            .org_scoped()
            // The proxy forwards to Anthropic — sending the anthropic
            // version header here keeps the contract explicit so a
            // future direct-mode debug build can hit Anthropic without
            // re-deriving it.
            .header("anthropic-version", ANTHROPIC_VERSION_HEADER)
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
            let body_txt = res.text().await.unwrap_or_default();
            return Err(map_proxy_error(status.as_u16(), body_txt));
        }

        // Adapt reqwest's bytes stream to a tokio AsyncBufRead so we
        // can read SSE lines ergonomically — same trick as
        // anthropic_native.
        let byte_stream = res
            .bytes_stream()
            .map(|r| r.map_err(|e| std::io::Error::new(std::io::ErrorKind::Other, e)));
        let reader = BufReader::new(tokio_util::io::StreamReader::new(byte_stream));

        let stream = try_stream! {
            let mut lines = reader.lines();
            let mut current_block: Option<usize> = None;
            let mut current_tool: Option<(String, String, String)> = None; // (id, name, json_buf)
            // Token accounting passed through from the wrapped Anthropic
            // stream — `input_tokens` on message_start, running `output_tokens`
            // on message_delta — so the UI meter works on Aura Pro too. The
            // cloud separately debits its own bucket; this is display-only.
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
                            // Extended-thinking stream (when the cloud relays
                            // an effort-gated thinking budget). Surfaced as a
                            // collapsible reasoning block, same as the direct
                            // Anthropic brain.
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
                                signature: None,
                            };
                        }
                    }
                    "message_delta" => {
                        // stop_reason / usage land here on the final delta.
                        // The cloud already debited the bucket, but we still
                        // surface the count to the UI's context-fill meter.
                        if let Some(n) = event
                            .get("usage")
                            .and_then(|u| u.get("output_tokens"))
                            .and_then(|v| v.as_u64())
                        {
                            output_tokens = n as u32;
                        }
                    }
                    "message_stop" => {
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

/// Translate a non-2xx response from the proxy into the appropriate
/// `BrainError` variant. Keeps the mapping in one place so callers can
/// pattern-match on the type rather than inspecting HTTP codes.
fn map_proxy_error(status: u16, body: String) -> BrainError {
    match status {
        401 => BrainError::AuthRequired {
            message: if body.trim().is_empty() {
                "Aura cloud rejected the stored token — please sign in again".into()
            } else {
                body
            },
        },
        402 => {
            // The cloud returns `{ error, message, tier, monthly_token_limit,
            // tokens_used_current_period }` — parse what's there, fall
            // back to None for any missing piece.
            let parsed: Value = serde_json::from_str(&body).unwrap_or(Value::Null);
            let message = parsed
                .get("message")
                .and_then(|v| v.as_str())
                .map(str::to_string)
                .unwrap_or_else(|| "Aura Pro quota exceeded for this period".to_string());
            let tokens_used = parsed
                .get("tokens_used_current_period")
                .and_then(|v| v.as_i64());
            let monthly_token_limit = parsed.get("monthly_token_limit").and_then(|v| v.as_i64());
            BrainError::QuotaExceeded {
                message,
                tokens_used,
                monthly_token_limit,
            }
        }
        s => BrainError::Provider {
            status: Some(s),
            message: if body.trim().is_empty() {
                format!("upstream returned HTTP {s}")
            } else {
                body
            },
        },
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn maps_401_to_auth_required() {
        let err = map_proxy_error(401, "".into());
        assert!(matches!(err, BrainError::AuthRequired { .. }));
    }

    #[test]
    fn maps_402_to_quota_with_numbers_parsed() {
        let body = r#"{"error":"quota_exceeded","message":"over limit",
                       "tier":"free","monthly_token_limit":50000,
                       "tokens_used_current_period":60000}"#;
        let err = map_proxy_error(402, body.to_string());
        match err {
            BrainError::QuotaExceeded {
                message,
                tokens_used,
                monthly_token_limit,
            } => {
                assert_eq!(message, "over limit");
                assert_eq!(tokens_used, Some(60000));
                assert_eq!(monthly_token_limit, Some(50000));
            }
            _ => panic!("expected QuotaExceeded"),
        }
    }

    #[test]
    fn maps_500_to_provider() {
        let err = map_proxy_error(503, "upstream timeout".into());
        match err {
            BrainError::Provider { status, message } => {
                assert_eq!(status, Some(503));
                assert_eq!(message, "upstream timeout");
            }
            _ => panic!("expected Provider"),
        }
    }

    #[test]
    fn stream_url_concatenates_cleanly_with_or_without_trailing_slash() {
        let a = AuraProBrain::new("t").with_cloud_origin("https://auravcs.com/");
        let b = AuraProBrain::new("t").with_cloud_origin("https://auravcs.com");
        assert_eq!(a.stream_url(), b.stream_url());
        assert_eq!(a.stream_url(), "https://auravcs.com/v1/brain/anthropic/messages/stream");
    }
}
