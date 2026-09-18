//! Native CLI event adapters. Unknown records survive as inspectable content.
use super::{parse_claude_line, StreamEvent};
use serde_json::{json, Value};

pub(super) struct ProviderParser {
    provider: String,
    turn: String,
    seq: usize,
    text: String,
    result: Option<StreamEvent>,
    session: String,
}

fn str_at<'a>(v: &'a Value, key: &str) -> &'a str {
    v.get(key).and_then(Value::as_str).unwrap_or("")
}
fn printable(v: &Value) -> String {
    v.as_str()
        .map(str::to_owned)
        .unwrap_or_else(|| v.to_string())
}

impl ProviderParser {
    pub(super) fn new(provider: &str, turn: &str) -> Self {
        Self {
            provider: provider.into(),
            turn: turn.into(),
            seq: 0,
            text: String::new(),
            result: None,
            session: String::new(),
        }
    }
    fn raw(&self, v: Value) -> StreamEvent {
        self.block("", v)
    }
    fn block(&self, id: &str, payload: Value) -> StreamEvent {
        StreamEvent::ContentBlock {
            event_id: if id.is_empty() {
                format!("{}:record:{}", self.turn, self.seq)
            } else {
                format!("{}:{id}", self.turn)
            },
            role: "assistant".into(),
            payload,
            turn_id: self.turn.clone(),
        }
    }
    fn text(&mut self, id: &str, text: &str) -> StreamEvent {
        self.text.push_str(text);
        StreamEvent::AssistantText {
            event_id: if id.is_empty() {
                None
            } else {
                Some(format!("{}:{id}", self.turn))
            },
            text: text.into(),
            turn_id: self.turn.clone(),
        }
    }
    fn tool(&self, id: &str, name: &str, input: Value) -> StreamEvent {
        StreamEvent::ToolUse {
            id: format!("{}:{id}", self.turn),
            name: name.into(),
            input,
            turn_id: self.turn.clone(),
        }
    }
    fn output(&self, id: &str, output: &Value, error: bool) -> StreamEvent {
        StreamEvent::ToolResult {
            tool_use_id: format!("{}:{id}", self.turn),
            content: printable(output),
            is_error: error,
            turn_id: self.turn.clone(),
        }
    }
    fn usage(&self, usage: &Value) -> StreamEvent {
        let n = |names: &[&str]| {
            names
                .iter()
                .find_map(|k| usage.get(k).and_then(Value::as_u64))
                .unwrap_or(0)
        };
        StreamEvent::Usage {
            context_tokens: n(&["input_tokens", "input", "inputTokens"]),
            output_tokens: n(&["output_tokens", "output", "outputTokens"]),
            message_id: format!("{}:usage", self.turn),
            turn_id: self.turn.clone(),
        }
    }
    pub(super) fn parse(&mut self, line: &str) -> Vec<StreamEvent> {
        if line.trim().is_empty() {
            return vec![];
        }
        self.seq += 1;
        let v: Value = match serde_json::from_str(line) {
            Ok(v) => v,
            Err(_) => return vec![self.raw(json!({"type":"unparsed_output","text":line}))],
        };
        let mut out = Vec::new();
        let session = ["session_id", "sessionID", "thread_id"]
            .iter()
            .find_map(|key| v.get(key).and_then(Value::as_str))
            .unwrap_or("");
        if !session.is_empty() && self.session != session {
            self.session = session.into();
            out.push(StreamEvent::SystemInit {
                session_id: session.into(),
                model: v.get("model").and_then(Value::as_str).map(str::to_owned),
                tools: vec![],
                turn_id: self.turn.clone(),
            });
        }
        let kind = str_at(&v, "type");
        let mut parsed = match self.provider.as_str() {
            "codex" => self.codex(&v, kind),
            "gemini" => self.gemini(&v, kind),
            "cursor" if kind == "tool_call" => self.cursor_tool(&v),
            "opencode" => self.opencode(&v, kind),
            "pi" => self.pi(&v, kind),
            _ => parse_claude_line(line, &self.turn),
        };
        for ev in parsed.drain(..) {
            // Final result is published after process exit, so a failed exit can
            // never be overwritten by an earlier optimistic protocol result.
            if matches!(ev, StreamEvent::Result { .. }) {
                self.result = Some(ev);
            } else {
                if let StreamEvent::AssistantText { text, .. } = &ev {
                    self.text.push_str(text);
                }
                out.push(ev);
            }
        }
        out
    }
    fn codex(&mut self, v: &Value, kind: &str) -> Vec<StreamEvent> {
        match kind {
            "thread.started" | "turn.started" => vec![],
            "turn.completed" => vec![self.usage(&v["usage"])],
            "turn.failed" | "error" => vec![StreamEvent::Result {
                success: false,
                duration_ms: 0,
                cost_usd: None,
                total_tokens: None,
                message: Some(printable(v.get("error").unwrap_or(v))),
                turn_id: self.turn.clone(),
            }],
            "item.started" | "item.updated" | "item.completed" => {
                let item = &v["item"];
                let id = str_at(item, "id");
                let typ = str_at(item, "type");
                let done = kind == "item.completed";
                match typ {
                    "agent_message" if done => vec![self.text(id, str_at(item, "text"))],
                    "reasoning" => vec![self.block(id, json!({"type":"thinking","thinking":str_at(item,"text")}))],
                    "agent_message" => vec![],
                    "todo_list" => vec![self.tool(id, "TodoWrite", json!({"todos":item["items"].as_array().map(|a| a.iter().map(|i| json!({"content":i["text"],"status":if i["completed"].as_bool()==Some(true){"completed"}else{"pending"}})).collect::<Vec<_>>()).unwrap_or_default()}))],
                    "command_execution" | "mcp_tool_call" | "web_search" | "file_change" => {
                        let (name, input) = match typ {
                            "command_execution" => ("Bash", json!({"command":item["command"]})),
                            "mcp_tool_call" => (str_at(item,"tool"), item["arguments"].clone()),
                            "web_search" => ("WebSearch", json!({"query":item["query"]})),
                            _ => ("ApplyPatch", json!({"changes":item["changes"]})),
                        };
                        let mut events = vec![self.tool(id, name, input)];
                        if done {
                            let failed = matches!(str_at(item,"status"),"failed"|"error") || item.get("exit_code").and_then(Value::as_i64).is_some_and(|n| n != 0) || item.get("error").is_some_and(|x| !x.is_null());
                            let value = item.get("aggregated_output").or_else(|| item.get("result")).unwrap_or(item);
                            events.push(self.output(id, value, failed));
                        }
                        events
                    }
                    _ => vec![self.raw(v.clone())],
                }
            }
            _ => vec![self.raw(v.clone())],
        }
    }
    fn gemini(&mut self, v: &Value, kind: &str) -> Vec<StreamEvent> {
        let id = str_at(v, "tool_id");
        match kind {
            "init" => vec![],
            "message" if str_at(v, "role") == "assistant" => {
                vec![self.text("", str_at(v, "content"))]
            }
            "message" if str_at(v, "role") == "user" => vec![],
            "tool_use" => vec![self.tool(id, str_at(v, "tool_name"), v["parameters"].clone())],
            "tool_result" => vec![self.output(
                id,
                v.get("output").unwrap_or(v),
                matches!(str_at(v, "status"), "error" | "failed"),
            )],
            "result" => {
                let mut out = vec![self.usage(&v["stats"])];
                if str_at(v, "status") == "error" {
                    out.push(StreamEvent::Result {
                        success: false,
                        duration_ms: 0,
                        cost_usd: None,
                        total_tokens: None,
                        message: Some(printable(v)),
                        turn_id: self.turn.clone(),
                    });
                }
                out
            }
            _ => vec![self.raw(v.clone())],
        }
    }
    fn cursor_tool(&self, v: &Value) -> Vec<StreamEvent> {
        let id = str_at(v, "call_id");
        let Some((name, detail)) = v["tool_call"].as_object().and_then(|o| o.iter().next()) else {
            return vec![self.raw(v.clone())];
        };
        let label = match name.as_str() {
            "readToolCall" => "Read",
            "writeToolCall" => "Write",
            "shellToolCall" => "Bash",
            "grepToolCall" => "Grep",
            "lsToolCall" => "List",
            _ => name,
        };
        let mut args = detail.get("args").cloned().unwrap_or_else(|| json!({}));
        if label == "Write" {
            args["content"] = args["fileText"].clone();
        }
        let mut out = vec![self.tool(id, label, args)];
        if str_at(v, "subtype") == "completed" {
            let result = &detail["result"];
            out.push(
                self.output(
                    id,
                    result
                        .get("success")
                        .and_then(|x| x.get("content"))
                        .unwrap_or(result),
                    result.get("error").is_some() || result.get("failure").is_some(),
                ),
            );
        }
        out
    }
    fn opencode(&mut self, v: &Value, kind: &str) -> Vec<StreamEvent> {
        let part = &v["part"];
        let id = str_at(part, "id");
        match kind {
            "text" => vec![self.text(id, str_at(part, "text"))],
            "reasoning" => vec![self.block(
                id,
                json!({"type":"thinking","thinking":str_at(part,"text")}),
            )],
            "tool_use" => {
                let state = &part["state"];
                let call = str_at(part, "callID");
                let mut out = vec![self.tool(call, str_at(part, "tool"), state["input"].clone())];
                if matches!(str_at(state, "status"), "completed" | "error") {
                    out.push(
                        self.output(
                            call,
                            state
                                .get("output")
                                .or_else(|| state.get("error"))
                                .unwrap_or(state),
                            str_at(state, "status") == "error",
                        ),
                    );
                }
                out
            }
            "step_start" => vec![],
            "step_finish" => vec![self.usage(&part["tokens"])],
            _ => vec![self.raw(v.clone())],
        }
    }
    fn pi(&mut self, v: &Value, kind: &str) -> Vec<StreamEvent> {
        match kind {
            "session" => vec![StreamEvent::SystemInit {
                session_id: str_at(v, "id").into(),
                model: None,
                tools: vec![],
                turn_id: self.turn.clone(),
            }],
            "message_end" => {
                let m = &v["message"];
                if str_at(m, "role") != "assistant" {
                    return vec![];
                }
                let mut out = vec![];
                if let Some(parts) = m["content"].as_array() {
                    for p in parts {
                        match str_at(p, "type") {
                            "text" => out.push(self.text("", str_at(p, "text"))),
                            "thinking" => out.push(self.block("", p.clone())),
                            _ => out.push(self.raw(p.clone())),
                        }
                    }
                }
                if m.get("usage").is_some() {
                    out.push(self.usage(&m["usage"]));
                }
                out
            }
            "tool_execution_start" => vec![self.tool(
                str_at(v, "toolCallId"),
                str_at(v, "toolName"),
                v["args"].clone(),
            )],
            "tool_execution_end" => vec![self.output(
                str_at(v, "toolCallId"),
                &v["result"],
                v["isError"].as_bool() == Some(true),
            )],
            "agent_start" | "agent_end" | "turn_start" | "turn_end" | "message_start"
            | "message_update" => vec![],
            _ => vec![self.raw(v.clone())],
        }
    }
    pub(super) fn finish(&mut self, exit: i32, elapsed: u64, stderr: &str) -> Vec<StreamEvent> {
        let mut out = vec![];
        if !stderr.is_empty() {
            out.push(self.raw(json!({"type":"diagnostic","text":stderr})));
        }
        let mut result = self.result.take().unwrap_or(StreamEvent::Result {
            success: exit == 0,
            duration_ms: elapsed,
            cost_usd: None,
            total_tokens: None,
            message: None,
            turn_id: self.turn.clone(),
        });
        if let StreamEvent::Result {
            success,
            message,
            duration_ms,
            ..
        } = &mut result
        {
            *duration_ms = elapsed;
            if exit != 0 {
                *success = false;
                *message = Some(if exit == -1 {
                    "Turn stopped before completion".into()
                } else {
                    format!("Agent exited with code {exit}. {stderr}")
                });
            }
            // Result text repeats the already-rendered assistant transcript in
            // Cursor/Claude. Keep it only when no prose was emitted.
            if *success && !self.text.is_empty() {
                *message = None;
            }
        }
        out.push(result);
        out
    }
}

#[cfg(test)]
mod chat_coverage_tests {
    use super::*;
    #[test]
    fn codex_items_pair_tools_and_report_usage() {
        let mut p = ProviderParser::new("codex", "turn");
        assert!(
            matches!(p.parse(r#"{"type":"thread.started","thread_id":"thread-a"}"#)[0],StreamEvent::SystemInit{ref session_id,..} if session_id=="thread-a")
        );
        let start=p.parse(r#"{"type":"item.started","item":{"id":"call","type":"command_execution","command":"pwd","status":"in_progress"}}"#);
        let end=p.parse(r#"{"type":"item.completed","item":{"id":"call","type":"command_execution","command":"pwd","status":"completed","exit_code":0,"aggregated_output":"/repo"}}"#);
        assert!(matches!(&start[0],StreamEvent::ToolUse{id,..} if id=="turn:call"));
        assert!(
            matches!(&end[1],StreamEvent::ToolResult{tool_use_id,is_error:false,..} if tool_use_id=="turn:call")
        );
        let usage =
            p.parse(r#"{"type":"turn.completed","usage":{"input_tokens":20,"output_tokens":3}}"#);
        assert!(matches!(
            usage[0],
            StreamEvent::Usage {
                context_tokens: 20,
                output_tokens: 3,
                ..
            }
        ));
    }
    #[test]
    fn cursor_structured_tool_failures_are_not_success() {
        let mut p = ProviderParser::new("cursor", "turn");
        let events=p.parse(r#"{"type":"tool_call","subtype":"completed","call_id":"c","tool_call":{"readToolCall":{"args":{"path":"a"},"result":{"error":"missing"}}}}"#);
        assert!(matches!(
            events[1],
            StreamEvent::ToolResult { is_error: true, .. }
        ));
    }
    #[test]
    fn process_failure_overrides_optimistic_protocol_result() {
        let mut p = ProviderParser::new("cursor", "turn");
        p.parse(r#"{"type":"result","subtype":"success","result":"done","duration_ms":1}"#);
        assert!(matches!(
            p.finish(2, 10, "failed").last(),
            Some(StreamEvent::Result { success: false, .. })
        ));
    }
    #[test]
    fn unknown_protocol_and_non_json_remain_visible() {
        let mut p = ProviderParser::new("codex", "turn");
        assert!(matches!(
            p.parse(r#"{"type":"future.event","payload":{"x":1}}"#)[0],
            StreamEvent::ContentBlock { .. }
        ));
        assert!(matches!(
            p.parse("non JSON startup message")[0],
            StreamEvent::ContentBlock { .. }
        ));
    }
    #[test]
    fn pi_messages_tools_and_model_usage_are_canonical() {
        let mut p = ProviderParser::new("pi", "turn");
        let events=p.parse(r#"{"type":"message_end","message":{"role":"assistant","content":[{"type":"thinking","thinking":"Plan"},{"type":"text","text":"Hello"}],"usage":{"input":10,"output":2}}}"#);
        assert!(matches!(events[0], StreamEvent::ContentBlock { .. }));
        assert!(matches!(events[1], StreamEvent::AssistantText { .. }));
        assert!(matches!(
            events[2],
            StreamEvent::Usage {
                context_tokens: 10,
                output_tokens: 2,
                ..
            }
        ));
    }
    #[test]
    fn canonical_session_and_complete_text_do_not_duplicate_final_answer() {
        let mut p = ProviderParser::new("cursor", "turn");
        p.parse(r#"{"type":"assistant","message":{"content":[{"type":"text","text":"Hello"}]}}"#);
        p.parse(r#"{"type":"result","subtype":"success","result":"Hello","duration_ms":10}"#);
        assert!(matches!(
            p.finish(0, 10, "").last(),
            Some(StreamEvent::Result { message: None, .. })
        ));
    }
}
