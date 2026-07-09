//! OpenAI-compatible generic Brain (BYOK any endpoint).
//!
//! Wraps any user-supplied server that speaks the OpenAI Chat Completions
//! API — OpenRouter, Together, Groq, vLLM, ollama, LMStudio, LiteLLM
//! proxy, etc. The user gives us a `base_url` + optional `api_key` +
//! `model` and we POST to `{base_url}/chat/completions` with
//! `stream: true`, parsing the standard SSE response into `ChatChunk`s.
//!
//! Provider ids are dynamic: `openai_compat:<slug>` where the slug is a
//! user-chosen label so several endpoints can coexist
//! (`openai_compat:local_ollama`, `openai_compat:groq_prod`). The
//! per-provider knobs (`base_url`, `model`) live in
//! `BrainSettings.providers[provider_id].extra`; the API key (if any)
//! lives in the OS keychain under the same `provider_id`.
//!
//! Endpoints that don't require auth (local ollama, unsecured vLLM)
//! accept an empty `api_key` — in that case we omit the `Authorization`
//! header entirely. We always advertise `supports_tool_use = true`
//! (fail-open) — the endpoint may or may not honor it but we don't
//! want the UI to disable the tool-use chip based on guesses about the
//! backing model.

#![cfg(feature = "brain_openai_compat")]

use async_stream::try_stream;
use async_trait::async_trait;
use futures_util::{StreamExt, stream::BoxStream};
use serde_json::{Value, json};
use tokio::io::{AsyncBufReadExt, BufReader};

use super::{
    Brain,
    types::{BrainCapabilities, BrainError, ChatChunk, ChatRequest, cap_keys},
};

/// Slug-keyed provider id prefix. Full id is `openai_compat:<slug>`.
pub const PROVIDER_PREFIX: &str = "openai_compat:";

const DEFAULT_MAX_TOKENS: u32 = 4096;

#[derive(Debug, Clone)]
pub struct OpenAICompatBrain {
    /// Full provider id (`openai_compat:<slug>`). Owned so we can hand
    /// back a `&str` from the trait method without lifetime gymnastics.
    provider_id: String,
    /// Base URL the user gave us, already including any `/v1` (or not)
    /// prefix they intended. We append `/chat/completions` to it and
    /// nothing else — never assume `/v1`.
    base_url: String,
    /// API key — empty string means "no auth, skip the Authorization
    /// header" (ollama, local vLLM, etc.).
    api_key: String,
    /// Model id passed through verbatim in the request body.
    model: String,
}

impl OpenAICompatBrain {
    /// Construct from the user-chosen slug plus its persisted config.
    ///
    /// `slug` is the part after `openai_compat:`. `base_url` is the
    /// full prefix the user configured (e.g. `http://localhost:11434/v1`
    /// for ollama or `https://openrouter.ai/api/v1` for OpenRouter).
    /// `api_key` may be empty for endpoints that don't require auth.
    pub fn new(
        slug: impl Into<String>,
        base_url: impl Into<String>,
        api_key: impl Into<String>,
        model: impl Into<String>,
    ) -> Self {
        let slug = slug.into();
        Self {
            provider_id: format!("{PROVIDER_PREFIX}{slug}"),
            base_url: base_url.into(),
            api_key: api_key.into(),
            model: model.into(),
        }
    }

    /// Construct the request URL by appending `/chat/completions` to
    /// the user-supplied base. We trim a trailing slash so users who
    /// configure `https://api.foo/v1/` and `https://api.foo/v1` both
    /// land at the same URL.
    fn endpoint(&self) -> String {
        let base = self.base_url.trim_end_matches('/');
        format!("{base}/chat/completions")
    }
}

#[async_trait]
impl Brain for OpenAICompatBrain {
    fn provider_id(&self) -> &str {
        &self.provider_id
    }

    fn capabilities(&self) -> BrainCapabilities {
        // max_input/max_output are unknown for generic endpoints — the
        // user may have plugged in anything from a 4k-context tiny
        // model to a 1M-context frontier model. We deliberately omit
        // those keys; the UI should fall back to "unknown / no limit".
        BrainCapabilities::new()
            .with(cap_keys::SUPPORTS_STREAMING, true)
            .with(cap_keys::SUPPORTS_TOOL_USE, true)
            .with(cap_keys::DEFAULT_MODEL, json!(self.model.clone()))
    }

    async fn chat(
        &self,
        request: ChatRequest,
    ) -> Result<BoxStream<'static, Result<ChatChunk, BrainError>>, BrainError> {
        let endpoint = self.endpoint();
        let api_key = self.api_key.clone();
        // Per-turn model override from the composer's model picker; Auto
        // falls back to this endpoint's configured model.
        let model = request
            .model
            .clone()
            .unwrap_or_else(|| self.model.clone());

        // Build the OpenAI Chat Completions request body. `system` (if
        // present) prepends as a `system` role message — OpenAI's API
        // doesn't have a top-level system field. `tools` is passed
        // through; the endpoint may or may not honor it.
        let mut messages: Vec<Value> = Vec::with_capacity(request.messages.len() + 1);
        if let Some(sys) = request.system.as_ref() {
            messages.push(json!({ "role": "system", "content": sys }));
        }
        for m in &request.messages {
            messages.push(json!({ "role": m.role, "content": m.content }));
        }

        let mut body = json!({
            "model": model,
            "messages": messages,
            "stream": true,
            "max_tokens": request.max_tokens.unwrap_or(DEFAULT_MAX_TOKENS),
        });
        if let Some(t) = request.temperature {
            body["temperature"] = json!(t);
        }
        if !request.tools.is_empty() {
            body["tools"] = json!(request.tools);
        }
        // Best-effort reasoning hint for compat endpoints that understand it
        // (vLLM, OpenRouter, …). Opt-in only — endpoints that ignore unknown
        // keys are unaffected; with effort=None the body is unchanged.
        if let Some(effort) = request.effort {
            body["reasoning_effort"] =
                json!(if request.fast { "minimal" } else { effort.openai_value() });
        }

        let client = reqwest::Client::new();
        let mut req = client
            .post(&endpoint)
            .header("content-type", "application/json")
            .json(&body);
        // Blank keys → skip Authorization. Some endpoints (ollama, local
        // vLLM without auth) reject the header entirely; others just
        // ignore it. Skipping is the safe default.
        if !api_key.is_empty() {
            req = req.header("authorization", format!("Bearer {api_key}"));
        }

        let res = req.send().await.map_err(|e| BrainError::Network {
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
        let byte_stream = res
            .bytes_stream()
            .map(|r| r.map_err(|e| std::io::Error::new(std::io::ErrorKind::Other, e)));
        let reader = BufReader::new(tokio_util::io::StreamReader::new(byte_stream));

        let stream = try_stream! {
            let mut lines = reader.lines();
            // OpenAI streams text in one logical content block; we use
            // block_idx = 0 for text. Tool-call blocks come in via
            // `choices[0].delta.tool_calls[i]` and we assign them
            // sequential block_idx starting at 1, keyed by the
            // call's own `index` so we can assemble across deltas.
            let mut tool_buffers: Vec<ToolCallBuf> = Vec::new();
            let mut final_stop_reason: Option<String> = None;
            // Token accounting — OpenAI-compatible servers report usage in a
            // trailing chunk (often with an empty `choices`) when
            // `stream_options.include_usage` is honored. Best-effort: many
            // proxies omit it, in which case the meter simply stays hidden.
            let mut last_usage: Option<(u32, u32)> = None;

            while let Some(line) = lines.next_line().await.map_err(|e| BrainError::Network {
                message: format!("read: {e}"),
            })? {
                // SSE protocol allows comments (`: ping`) and blank
                // lines between events — both should be skipped.
                let Some(payload) = line.strip_prefix("data: ") else {
                    continue;
                };
                let payload = payload.trim();
                if payload.is_empty() {
                    continue;
                }
                if payload == "[DONE]" {
                    // Emit any tool calls we accumulated but never saw
                    // a final delta for (some servers don't send a
                    // separate "stop" event before [DONE]).
                    for buf in tool_buffers.drain(..) {
                        let input: Value =
                            serde_json::from_str(&buf.arguments).unwrap_or(json!({}));
                        yield ChatChunk::ToolUse {
                            block_idx: buf.block_idx,
                            tool_use_id: buf.id,
                            name: buf.name,
                            input,
                        };
                    }
                    if let Some((input_tokens, output_tokens)) = last_usage.take() {
                        yield ChatChunk::Usage { input_tokens, output_tokens };
                    }
                    yield ChatChunk::End { stop_reason: final_stop_reason.clone() };
                    break;
                }

                let event: Value = match serde_json::from_str(payload) {
                    Ok(v) => v,
                    Err(e) => {
                        Err(BrainError::Parse { message: format!("sse: {e}") })?;
                        unreachable!()
                    }
                };

                // Generic OpenAI-compatible error envelope: some
                // proxies (LiteLLM, OpenRouter on rate limit) embed
                // errors inside the stream rather than via HTTP status.
                if let Some(err) = event.get("error") {
                    let msg = err
                        .get("message")
                        .and_then(|v| v.as_str())
                        .unwrap_or("upstream error")
                        .to_string();
                    Err(BrainError::Api { status: 0, message: msg })?;
                    unreachable!()
                }

                // Usage may ride on any chunk (commonly the trailing one, which
                // carries an empty `choices`), so read it BEFORE the choices
                // guard that would otherwise `continue` past a usage-only event.
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

                let choice = match event
                    .get("choices")
                    .and_then(|v| v.as_array())
                    .and_then(|a| a.first())
                {
                    Some(c) => c,
                    None => continue,
                };

                if let Some(reason) = choice.get("finish_reason").and_then(|v| v.as_str()) {
                    if !reason.is_empty() {
                        final_stop_reason = Some(reason.to_string());
                    }
                }

                let delta = choice.get("delta").cloned().unwrap_or(json!({}));

                // Text token.
                if let Some(text) = delta.get("content").and_then(|v| v.as_str()) {
                    if !text.is_empty() {
                        yield ChatChunk::Text { block_idx: 0, text: text.to_string() };
                    }
                }

                // Tool-call deltas. OpenAI streams these incrementally:
                // the first delta for a given call carries `id` and
                // `function.name`; subsequent deltas append to
                // `function.arguments`. We key by the `index` field
                // (also part of the protocol) so out-of-order arrivals
                // still assemble correctly.
                if let Some(calls) = delta.get("tool_calls").and_then(|v| v.as_array()) {
                    for call in calls {
                        let call_idx = call
                            .get("index")
                            .and_then(|v| v.as_u64())
                            .unwrap_or(0) as usize;
                        let buf = ensure_buf(&mut tool_buffers, call_idx);
                        if let Some(id) = call.get("id").and_then(|v| v.as_str()) {
                            if !id.is_empty() {
                                buf.id = id.to_string();
                            }
                        }
                        if let Some(func) = call.get("function") {
                            if let Some(name) = func.get("name").and_then(|v| v.as_str()) {
                                if !name.is_empty() {
                                    buf.name = name.to_string();
                                }
                            }
                            if let Some(args) =
                                func.get("arguments").and_then(|v| v.as_str())
                            {
                                buf.arguments.push_str(args);
                            }
                        }
                    }
                }

                // Some endpoints (Anthropic-via-OpenAI shim, a few
                // proxies) signal the end of a tool call on the same
                // delta that sets finish_reason = "tool_calls". When
                // that happens we flush the buffered calls now so the
                // caller sees them before End.
                if matches!(
                    choice.get("finish_reason").and_then(|v| v.as_str()),
                    Some("tool_calls") | Some("function_call")
                ) {
                    for buf in tool_buffers.drain(..) {
                        let input: Value =
                            serde_json::from_str(&buf.arguments).unwrap_or(json!({}));
                        yield ChatChunk::ToolUse {
                            block_idx: buf.block_idx,
                            tool_use_id: buf.id,
                            name: buf.name,
                            input,
                        };
                    }
                }
            }
        };

        Ok(Box::pin(stream))
    }
}

/// Per-call assembly buffer for streamed tool-call deltas.
struct ToolCallBuf {
    /// `choices[0].delta.tool_calls[i].index` from the wire — used to
    /// route subsequent deltas to the same buffer.
    call_index: usize,
    /// Block index emitted to the caller. We bias by +1 so text
    /// (block_idx = 0) and tool calls don't collide.
    block_idx: usize,
    id: String,
    name: String,
    arguments: String,
}

fn ensure_buf(buffers: &mut Vec<ToolCallBuf>, call_index: usize) -> &mut ToolCallBuf {
    if let Some(pos) = buffers.iter().position(|b| b.call_index == call_index) {
        return &mut buffers[pos];
    }
    buffers.push(ToolCallBuf {
        call_index,
        block_idx: call_index + 1,
        id: String::new(),
        name: String::new(),
        arguments: String::new(),
    });
    buffers.last_mut().expect("just pushed")
}
