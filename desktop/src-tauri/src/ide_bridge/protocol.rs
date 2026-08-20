//! Wire shapes for the IDE control plane Aura exposes to coding-agent CLIs.
//!
//! This is Claude Code's *existing* IDE-integration protocol, not something
//! we invented: the CLI scans `~/.claude/ide/<port>.lock`, reads the JSON
//! inside, and — when `transport` is `"ws"` — opens a WebSocket to
//! `ws://127.0.0.1:<port>` with subprotocol `mcp` and speaks plain MCP over
//! it. VS Code and the JetBrains plugin are two implementations of the same
//! server; this module is a third.
//!
//! Everything here is pure: shapes in, JSON out. The socket lives in
//! `server.rs`, the UI round-trip in `bridge.rs`. Keeping it pure is what
//! lets the protocol be pinned by unit tests without standing up a server.
//!
//! ## The bits that are load-bearing (verified against the shipped CLI)
//!
//! * `tools/call` results are read as `result.content` — a content array.
//! * `openDiff` is answered with one of exactly three shapes, and the CLI
//!   discriminates on `content[0].text`:
//!     - `FILE_SAVED` + a second text block holding the final file text,
//!     - `DIFF_REJECTED` — the person threw the change away,
//!     - `TAB_CLOSED` — the tab went away without a verdict.
//!   Anything else is treated as "Not accepted" and the CLI errors out.
//! * The CLI sets no idle timeout on these calls, so blocking `openDiff`
//!   until a human acts is the intended behaviour, not a hang.

use serde::Deserialize;
use serde_json::{json, Value};

/// MCP revision we answer with when the client doesn't state one. Clients
/// normally do, and [`initialize_result`] echoes theirs back — a server that
/// insists on its own revision gets dropped by a newer client.
pub const FALLBACK_PROTOCOL_VERSION: &str = "2024-11-05";

/// How Aura introduces itself over MCP. Distinct from [`IDE_NAME`], which is
/// what the lock file advertises and what the CLI prints in its IDE picker.
pub const SERVER_NAME: &str = "aura";

/// Display name for the lock file / the CLI's `/ide` menu.
pub const IDE_NAME: &str = "Aura";

/// One inbound JSON-RPC frame. `id` is absent on notifications, which is
/// exactly how we tell a request (owes a reply) from a notification (does
/// not) — see [`JsonRpcRequest::is_notification`].
#[derive(Debug, Deserialize)]
pub struct JsonRpcRequest {
    #[serde(default)]
    pub id: Option<Value>,
    pub method: String,
    #[serde(default)]
    pub params: Value,
}

impl JsonRpcRequest {
    /// A frame with no `id` is a notification: replying to one is a protocol
    /// violation, and `notifications/initialized` plus the CLI's own
    /// `ide_connected` both arrive this way.
    pub fn is_notification(&self) -> bool {
        self.id.is_none()
    }

    /// Tool name for a `tools/call`, or `None` when the frame isn't one.
    pub fn tool_name(&self) -> Option<&str> {
        self.params.get("name").and_then(|v| v.as_str())
    }

    /// `params.arguments` for a `tools/call`, defaulting to an empty object
    /// so a caller that omits it (legal for a no-arg tool) still reads
    /// cleanly with `.get(..)`.
    pub fn tool_arguments(&self) -> Value {
        self.params
            .get("arguments")
            .cloned()
            .unwrap_or_else(|| json!({}))
    }
}

/// Success envelope. `id` is echoed verbatim — it may be a number or a
/// string and we must not normalise it.
pub fn success(id: &Value, result: Value) -> Value {
    json!({ "jsonrpc": "2.0", "id": id, "result": result })
}

/// Error envelope. Codes follow JSON-RPC: -32601 unknown method, -32602 bad
/// params, -32603 internal.
pub fn error(id: &Value, code: i64, message: impl Into<String>) -> Value {
    json!({
        "jsonrpc": "2.0",
        "id": id,
        "error": { "code": code, "message": message.into() },
    })
}

pub const ERR_METHOD_NOT_FOUND: i64 = -32601;
pub const ERR_INVALID_PARAMS: i64 = -32602;
pub const ERR_INTERNAL: i64 = -32603;

/// Reply to `initialize`. `client_version` is the client's requested
/// `protocolVersion`; echoing it is what keeps us compatible as the MCP
/// revision moves, since every revision we'd care about is wire-identical
/// for the handful of methods we implement.
pub fn initialize_result(client_version: Option<&str>, server_version: &str) -> Value {
    json!({
        "protocolVersion": client_version.unwrap_or(FALLBACK_PROTOCOL_VERSION),
        "capabilities": { "tools": {} },
        "serverInfo": { "name": SERVER_NAME, "version": server_version },
    })
}

/// A single `{"type":"text","text":…}` content block.
pub fn text_block(text: impl Into<String>) -> Value {
    json!({ "type": "text", "text": text.into() })
}

/// `tools/call` result envelope. The CLI reads `.content` and nothing else.
pub fn tool_result(blocks: Vec<Value>) -> Value {
    json!({ "content": blocks })
}

/// A tool that failed in a way the *model* should see and reason about,
/// rather than a transport-level JSON-RPC error.
pub fn tool_error(message: impl Into<String>) -> Value {
    json!({ "content": [text_block(message)], "isError": true })
}

/// How an `openDiff` round-trip ended. The three variants are the three
/// shapes the CLI knows how to read; there is deliberately no fourth.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum DiffOutcome {
    /// The person kept the change (possibly after editing it further).
    /// Carries the text that is now on disk — which is what the CLI adopts
    /// as the post-edit file content, so it must be the real final text and
    /// never the text we proposed.
    Saved(String),
    /// The person threw the change away; the file on disk is untouched.
    Rejected,
    /// The tab went away without a verdict — the CLI aborted, or the diff
    /// was closed out from under us.
    Closed,
}

impl DiffOutcome {
    /// Render into the content array the CLI discriminates on.
    pub fn into_content(self) -> Vec<Value> {
        match self {
            DiffOutcome::Saved(contents) => {
                vec![text_block("FILE_SAVED"), text_block(contents)]
            }
            DiffOutcome::Rejected => vec![text_block("DIFF_REJECTED")],
            DiffOutcome::Closed => vec![text_block("TAB_CLOSED")],
        }
    }

    /// Parse the frontend's verdict. Unknown/garbled verdicts collapse to
    /// [`DiffOutcome::Closed`] rather than a guess — "we don't know what the
    /// human decided" is exactly what TAB_CLOSED means, and it's the only
    /// one of the three that can't lose work or fake consent.
    pub fn from_reply(reply: &Value) -> DiffOutcome {
        match reply.get("outcome").and_then(|v| v.as_str()) {
            Some("saved") => {
                let contents = reply
                    .get("contents")
                    .and_then(|v| v.as_str())
                    .unwrap_or_default()
                    .to_string();
                DiffOutcome::Saved(contents)
            }
            Some("rejected") => DiffOutcome::Rejected,
            _ => DiffOutcome::Closed,
        }
    }
}

/// Every tool this server advertises.
///
/// `getDiagnostics` is deliberately absent: Aura has no language-server
/// diagnostics to report, and a tool that always answers "no problems" is
/// worse than no tool — the CLI treats a missing tool as "this IDE can't do
/// that" and moves on, but it would believe a fabricated clean bill of
/// health. Same reasoning for `executeCode`.
pub fn tool_catalog() -> Vec<Value> {
    vec![
        json!({
            "name": "openDiff",
            "description":
                "Show a proposed change to a file as a diff tab in Aura and wait for the \
                 person to decide. Returns FILE_SAVED with the final text if they keep it, \
                 or DIFF_REJECTED if they throw it away.",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "old_file_path": { "type": "string", "description": "File being changed." },
                    "new_file_path": { "type": "string", "description": "Usually the same path." },
                    "new_file_contents": { "type": "string", "description": "Proposed full text." },
                    "tab_name": { "type": "string", "description": "Label for the tab." },
                },
                "required": ["old_file_path", "new_file_contents", "tab_name"],
            },
        }),
        json!({
            "name": "close_tab",
            "description": "Close a tab that was opened by name.",
            "inputSchema": {
                "type": "object",
                "properties": { "tab_name": { "type": "string" } },
                "required": ["tab_name"],
            },
        }),
        json!({
            "name": "closeAllDiffTabs",
            "description": "Close every diff tab this agent opened.",
            "inputSchema": { "type": "object", "properties": {} },
        }),
        json!({
            "name": "openFile",
            "description":
                "Open a file in an Aura tab, optionally scrolled to a line range or with a \
                 span of text selected. Use this to put the file you are talking about in \
                 front of the person instead of describing where to look.",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "filePath": { "type": "string", "description": "Absolute path to open." },
                    "startLine": { "type": "number", "description": "1-based line to reveal." },
                    "endLine": { "type": "number", "description": "1-based end of the selection." },
                    "startText": { "type": "string", "description": "Select from this text." },
                    "endText": { "type": "string", "description": "Select up to this text." },
                    "makeFrontmost": {
                        "type": "boolean",
                        "description": "Focus the tab. Defaults to true.",
                    },
                },
                "required": ["filePath"],
            },
        }),
        json!({
            "name": "getOpenEditors",
            "description":
                "List the tabs open in Aura right now, and which one is in front. Check this \
                 before assuming which file the person is looking at.",
            "inputSchema": { "type": "object", "properties": {} },
        }),
        json!({
            "name": "getCurrentSelection",
            "description":
                "Get the text the person currently has selected, and where it is. Empty when \
                 nothing is selected or no file tab is in front.",
            "inputSchema": { "type": "object", "properties": {} },
        }),
        json!({
            "name": "getWorkspaceFolders",
            "description": "List the project folders Aura has open.",
            "inputSchema": { "type": "object", "properties": {} },
        }),
    ]
}

/// Names in [`tool_catalog`], for the dispatcher's "is this ours?" check and
/// for tests that assert catalog and dispatcher can't drift apart.
pub fn tool_names() -> Vec<String> {
    tool_catalog()
        .iter()
        .filter_map(|t| t.get("name")?.as_str().map(str::to_string))
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn notification_has_no_id() {
        let n: JsonRpcRequest =
            serde_json::from_str(r#"{"jsonrpc":"2.0","method":"notifications/initialized"}"#)
                .unwrap();
        assert!(n.is_notification());

        let r: JsonRpcRequest =
            serde_json::from_str(r#"{"jsonrpc":"2.0","id":7,"method":"tools/list"}"#).unwrap();
        assert!(!r.is_notification());
    }

    #[test]
    fn ide_connected_notification_parses() {
        // The CLI fires this the moment it attaches. It carries an id-less
        // envelope, so a server that assumed every frame owes a reply would
        // answer it and desync the stream.
        let n: JsonRpcRequest = serde_json::from_str(
            r#"{"jsonrpc":"2.0","method":"ide_connected","params":{"pid":4242}}"#,
        )
        .unwrap();
        assert!(n.is_notification());
        assert_eq!(n.params["pid"], 4242);
    }

    #[test]
    fn tool_call_params_are_read_from_arguments() {
        let r: JsonRpcRequest = serde_json::from_str(
            r#"{"id":1,"method":"tools/call","params":{"name":"openFile","arguments":{"filePath":"/a/b.ts"}}}"#,
        )
        .unwrap();
        assert_eq!(r.tool_name(), Some("openFile"));
        assert_eq!(r.tool_arguments()["filePath"], "/a/b.ts");
    }

    #[test]
    fn tool_call_without_arguments_yields_empty_object() {
        let r: JsonRpcRequest = serde_json::from_str(
            r#"{"id":1,"method":"tools/call","params":{"name":"getOpenEditors"}}"#,
        )
        .unwrap();
        assert_eq!(r.tool_arguments(), json!({}));
    }

    #[test]
    fn string_ids_survive_the_round_trip() {
        // JSON-RPC ids may be strings; coercing one to a number would strand
        // the caller's promise forever.
        let id = json!("req-9");
        assert_eq!(success(&id, json!({}))["id"], json!("req-9"));
    }

    #[test]
    fn initialize_echoes_the_clients_revision() {
        let r = initialize_result(Some("2025-06-18"), "0.19.33");
        assert_eq!(r["protocolVersion"], "2025-06-18");
        assert_eq!(r["serverInfo"]["name"], SERVER_NAME);
        // Advertising `tools` is what makes the client bother to list them.
        assert!(r["capabilities"]["tools"].is_object());
    }

    #[test]
    fn initialize_falls_back_when_client_states_nothing() {
        let r = initialize_result(None, "0.19.33");
        assert_eq!(r["protocolVersion"], FALLBACK_PROTOCOL_VERSION);
    }

    // The next three tests are the whole reason this module is pure: they
    // pin the exact byte shapes the shipped CLI discriminates on. If any of
    // them changes, agents silently stop being able to review their work.

    #[test]
    fn saved_outcome_carries_the_final_text_in_the_second_block() {
        let c = DiffOutcome::Saved("after\n".into()).into_content();
        assert_eq!(c.len(), 2);
        assert_eq!(c[0]["type"], "text");
        assert_eq!(c[0]["text"], "FILE_SAVED");
        assert_eq!(c[1]["type"], "text");
        assert_eq!(c[1]["text"], "after\n");
    }

    #[test]
    fn rejected_and_closed_are_single_text_blocks() {
        let r = DiffOutcome::Rejected.into_content();
        assert_eq!(r.len(), 1);
        assert_eq!(r[0]["text"], "DIFF_REJECTED");

        let c = DiffOutcome::Closed.into_content();
        assert_eq!(c.len(), 1);
        assert_eq!(c[0]["text"], "TAB_CLOSED");
    }

    #[test]
    fn tool_result_wraps_blocks_under_content() {
        // `callIdeRpc` returns `result.content`; a result that put the array
        // anywhere else would read as undefined at the call site.
        let r = tool_result(DiffOutcome::Rejected.into_content());
        assert_eq!(r["content"][0]["text"], "DIFF_REJECTED");
    }

    #[test]
    fn unknown_verdicts_collapse_to_closed() {
        // Never guess "saved" — that would hand the CLI a fabricated consent
        // and let it treat unreviewed text as approved.
        assert_eq!(DiffOutcome::from_reply(&json!({})), DiffOutcome::Closed);
        assert_eq!(
            DiffOutcome::from_reply(&json!({ "outcome": "who knows" })),
            DiffOutcome::Closed
        );
        assert_eq!(
            DiffOutcome::from_reply(&json!({ "outcome": "rejected" })),
            DiffOutcome::Rejected
        );
        assert_eq!(
            DiffOutcome::from_reply(&json!({ "outcome": "saved", "contents": "x" })),
            DiffOutcome::Saved("x".into())
        );
    }

    #[test]
    fn catalog_advertises_the_tab_control_surface() {
        let names = tool_names();
        for want in [
            "openDiff",
            "close_tab",
            "closeAllDiffTabs",
            "openFile",
            "getOpenEditors",
            "getCurrentSelection",
            "getWorkspaceFolders",
        ] {
            assert!(names.contains(&want.to_string()), "missing tool {want}");
        }
    }

    #[test]
    fn catalog_omits_capabilities_aura_cannot_actually_provide() {
        // A tool that always answers "nothing to report" is worse than an
        // absent one: the CLI degrades gracefully around absence, but
        // believes an answer.
        let names = tool_names();
        assert!(!names.contains(&"getDiagnostics".to_string()));
        assert!(!names.contains(&"executeCode".to_string()));
    }

    #[test]
    fn every_advertised_tool_has_an_object_input_schema() {
        for t in tool_catalog() {
            let name = t["name"].as_str().unwrap();
            assert_eq!(t["inputSchema"]["type"], "object", "{name} schema");
            assert!(t["description"].as_str().is_some_and(|d| !d.is_empty()));
        }
    }
}
