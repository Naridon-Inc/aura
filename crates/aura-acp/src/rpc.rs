//! JSON-RPC 2.0 frames as ACP uses them: newline-delimited objects, numeric
//! ids on the client side, error codes from the ACP schema.

use serde_json::{json, Value};
use std::fmt;

/// A JSON-RPC error object. `code` follows the ACP schema (`-32000` auth
/// required, `-32002` resource not found, `-32800` request cancelled, …).
#[derive(Debug, Clone, PartialEq)]
pub struct RpcError {
    pub code: i64,
    pub message: String,
    pub data: Option<Value>,
}

impl RpcError {
    pub const AUTH_REQUIRED: i64 = -32000;
    pub const RESOURCE_NOT_FOUND: i64 = -32002;
    pub const METHOD_NOT_FOUND: i64 = -32601;
    pub const INVALID_PARAMS: i64 = -32602;
    pub const INTERNAL: i64 = -32603;
    pub const REQUEST_CANCELLED: i64 = -32800;
    /// Local only, never sent on the wire: the transport closed before a
    /// response arrived. Inside the JSON-RPC server-error range.
    pub const DISCONNECTED: i64 = -32099;

    pub fn new(code: i64, message: impl Into<String>) -> Self {
        Self { code, message: message.into(), data: None }
    }
    pub fn method_not_found(method: &str) -> Self {
        Self::new(Self::METHOD_NOT_FOUND, format!("Method not found: {method}"))
    }
    pub fn invalid_params(message: impl Into<String>) -> Self {
        Self::new(Self::INVALID_PARAMS, message)
    }
    pub fn internal(message: impl Into<String>) -> Self {
        Self::new(Self::INTERNAL, message)
    }
    pub fn cancelled() -> Self {
        Self::new(Self::REQUEST_CANCELLED, "Request cancelled")
    }
    pub fn disconnected() -> Self {
        Self::new(Self::DISCONNECTED, "Agent connection closed")
    }
    pub fn is_auth_required(&self) -> bool {
        self.code == Self::AUTH_REQUIRED
    }
    pub fn is_disconnected(&self) -> bool {
        self.code == Self::DISCONNECTED
    }
    pub fn from_value(v: &Value) -> Self {
        Self {
            code: v.get("code").and_then(Value::as_i64).unwrap_or(Self::INTERNAL),
            message: v.get("message").and_then(Value::as_str).unwrap_or("Agent error").to_string(),
            data: v.get("data").cloned().filter(|d| !d.is_null()),
        }
    }
    pub fn to_value(&self) -> Value {
        let mut v = json!({"code": self.code, "message": self.message});
        if let Some(d) = &self.data {
            v["data"] = d.clone();
        }
        v
    }
    /// The most specific human sentence in the error: agents often put the
    /// useful part ("run `agent login` first") in `data.message`.
    pub fn detail(&self) -> &str {
        self.data
            .as_ref()
            .and_then(|d| d.get("message").and_then(Value::as_str).or_else(|| d.as_str()))
            .unwrap_or(&self.message)
    }
}

impl fmt::Display for RpcError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "{} ({})", self.detail(), self.code)
    }
}

impl std::error::Error for RpcError {}

/// One decoded line.
#[derive(Debug, Clone, PartialEq)]
pub enum Frame {
    Request { id: Value, method: String, params: Value },
    Notification { method: String, params: Value },
    Response { id: Value, result: Result<Value, RpcError> },
}

/// Classify a parsed JSON value. `None` for objects that are not JSON-RPC
/// (some agents print stray JSON to stdout).
pub fn classify(v: Value) -> Option<Frame> {
    let Value::Object(mut map) = v else { return None };
    let params = map.remove("params").unwrap_or(Value::Null);
    let id = map.remove("id").filter(|id| !id.is_null());
    match (map.remove("method"), id) {
        (Some(Value::String(method)), Some(id)) => Some(Frame::Request { id, method, params }),
        (Some(Value::String(method)), None) => Some(Frame::Notification { method, params }),
        (None, Some(id)) => {
            if let Some(err) = map.get("error") {
                Some(Frame::Response { id, result: Err(RpcError::from_value(err)) })
            } else {
                map.remove("result").map(|r| Frame::Response { id, result: Ok(r) })
            }
        }
        _ => None,
    }
}

pub fn request_frame(id: u64, method: &str, params: Value) -> Value {
    json!({"jsonrpc": "2.0", "id": id, "method": method, "params": params})
}

pub fn notification_frame(method: &str, params: Value) -> Value {
    json!({"jsonrpc": "2.0", "method": method, "params": params})
}

pub fn response_frame(id: &Value, result: &Result<Value, RpcError>) -> Value {
    match result {
        Ok(r) => json!({"jsonrpc": "2.0", "id": id, "result": r}),
        Err(e) => json!({"jsonrpc": "2.0", "id": id, "error": e.to_value()}),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn classifies_every_frame_shape() {
        let req = classify(json!({"jsonrpc":"2.0","id":7,"method":"session/request_permission","params":{"a":1}})).unwrap();
        assert!(matches!(req, Frame::Request { ref method, .. } if method == "session/request_permission"));
        let note = classify(json!({"jsonrpc":"2.0","method":"session/update","params":{}})).unwrap();
        assert!(matches!(note, Frame::Notification { .. }));
        let ok = classify(json!({"jsonrpc":"2.0","id":1,"result":{}})).unwrap();
        assert_eq!(ok, Frame::Response { id: json!(1), result: Ok(json!({})) });
        let err = classify(json!({"jsonrpc":"2.0","id":1,"error":{"code":-32000,"message":"Authentication required","data":{"message":"run agent login"}}})).unwrap();
        let Frame::Response { result: Err(e), .. } = err else { panic!() };
        assert!(e.is_auth_required());
        assert_eq!(e.detail(), "run agent login");
        assert!(classify(json!([1, 2])).is_none());
        assert!(classify(json!({"hello": "world"})).is_none());
    }

    #[test]
    fn null_id_is_a_notification_not_a_request() {
        let f = classify(json!({"jsonrpc":"2.0","id":null,"method":"x"})).unwrap();
        assert!(matches!(f, Frame::Notification { .. }));
    }
}
