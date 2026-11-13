//! `session/request_permission` replies. The user's choice is matched to an
//! option the agent offered by exact id; nothing here can widen the scope
//! the user picked.

use serde_json::{json, Value};

#[derive(Debug, Clone, PartialEq)]
pub struct PermissionOption {
    pub option_id: String,
    pub name: String,
    /// `allow_once` | `allow_always` | `reject_once` | `reject_always`.
    pub kind: String,
}

impl PermissionOption {
    pub fn parse_list(params: &Value) -> Vec<PermissionOption> {
        params
            .get("options")
            .and_then(Value::as_array)
            .into_iter()
            .flatten()
            .filter_map(|o| {
                Some(PermissionOption {
                    option_id: o.get("optionId")?.as_str()?.to_string(),
                    name: o.get("name").and_then(Value::as_str).unwrap_or_default().to_string(),
                    kind: o.get("kind").and_then(Value::as_str).unwrap_or_default().to_string(),
                })
            })
            .collect()
    }
    pub fn is_allow(&self) -> bool {
        self.kind.starts_with("allow")
    }
}

/// The reply outcome. `selected` must be an id the agent offered; without
/// one, `fallback_kind` picks the first option of exactly that kind. No
/// match → `cancelled`, never a broader grant.
pub fn outcome(options: &[PermissionOption], selected: Option<&str>, fallback_kind: &str) -> Value {
    let hit = match selected {
        Some(id) => options.iter().find(|o| o.option_id == id),
        None => options.iter().find(|o| o.kind == fallback_kind),
    };
    match hit {
        Some(o) => json!({"outcome": "selected", "optionId": o.option_id}),
        None => cancelled(),
    }
}

pub fn cancelled() -> Value {
    json!({"outcome": "cancelled"})
}

/// The full `result` body for a permission response.
pub fn result(outcome: Value) -> Value {
    json!({"outcome": outcome})
}
