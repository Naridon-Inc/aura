//! Shared Anthropic Messages SSE decoder.
//!
//! `api.anthropic.com`, Anthropic-on-Vertex (`:streamRawPredict`), and other
//! Claude endpoints all emit the SAME `stream: true` event sequence
//! (`message_start` → `content_block_*` → `message_delta` → `message_stop`).
//! This module owns the one authoritative decode of that sequence into
//! [`ChatChunk`]s so `anthropic_native` and `vertex` never drift. Only the
//! endpoint URL and auth headers differ between those brains; the byte parsing
//! is identical, so it lives here once.
#![cfg(any(feature = "brain_anthropic_native", feature = "brain_vertex"))]

use async_stream::try_stream;
use futures_util::{StreamExt, stream::BoxStream};
use serde_json::{Value, json};
use tokio::io::{AsyncBufReadExt, BufReader};

use super::types::{BrainError, ChatChunk};

/// Decode an Anthropic SSE `Response` body into a `ChatChunk` stream.
///
/// The caller has already sent the request and verified a 2xx status; this
/// consumes the streaming body. Maps `text_delta` → `Text`, `thinking_delta`
/// → `Reasoning`, `tool_use` blocks (+ `input_json_delta`) → `ToolUse`, and
/// carries the billed `input_tokens` / running `output_tokens` into a single
/// `Usage` chunk emitted just before `End`.
pub fn decode_stream(
    res: reqwest::Response,
) -> BoxStream<'static, Result<ChatChunk, BrainError>> {
    let byte_stream = res
        .bytes_stream()
        .map(|r| r.map_err(|e| std::io::Error::new(std::io::ErrorKind::Other, e)));
    let reader = BufReader::new(tokio_util::io::StreamReader::new(byte_stream));

    let stream = try_stream! {
        let mut lines = reader.lines();
        let mut current_block: Option<usize> = None;
        let mut current_tool: Option<(String, String, String)> = None; // (id, name, json_buf)
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
                    let idx = event.get("index").and_then(|v| v.as_u64()).unwrap_or(0) as usize;
                    current_block = Some(idx);
                    let block = event.get("content_block").cloned().unwrap_or(json!({}));
                    if block.get("type").and_then(|v| v.as_str()) == Some("tool_use") {
                        let id = block.get("id").and_then(|v| v.as_str()).unwrap_or("").to_string();
                        let name = block.get("name").and_then(|v| v.as_str()).unwrap_or("").to_string();
                        current_tool = Some((id, name, String::new()));
                    }
                }
                "content_block_delta" => {
                    let idx = event.get("index").and_then(|v| v.as_u64()).unwrap_or(0) as usize;
                    let delta = event.get("delta").cloned().unwrap_or(json!({}));
                    match delta.get("type").and_then(|v| v.as_str()) {
                        Some("text_delta") => {
                            let text = delta.get("text").and_then(|v| v.as_str()).unwrap_or("").to_string();
                            if !text.is_empty() {
                                yield ChatChunk::Text { block_idx: idx, text };
                            }
                        }
                        Some("thinking_delta") => {
                            let text = delta.get("thinking").and_then(|v| v.as_str()).unwrap_or("").to_string();
                            if !text.is_empty() {
                                yield ChatChunk::Reasoning { block_idx: idx, text };
                            }
                        }
                        Some("input_json_delta") => {
                            if let Some((_, _, buf)) = current_tool.as_mut() {
                                if let Some(s) = delta.get("partial_json").and_then(|v| v.as_str()) {
                                    buf.push_str(s);
                                }
                            }
                        }
                        _ => {}
                    }
                }
                "content_block_stop" => {
                    if let Some((id, name, buf)) = current_tool.take() {
                        let input: Value = serde_json::from_str(&buf).unwrap_or(json!({}));
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

    Box::pin(stream)
}
