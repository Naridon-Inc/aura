//! `elicitation/create`: the agent asks the user for structured input.
//!
//! Form mode carries a flat restricted JSON Schema; this turns it into
//! fields a question UI can render, and turns the user's answers back into
//! schema-conformant `content`. URL mode is validated so the UI can show the
//! full URL and its host before the user consents.

use crate::rpc::RpcError;
use serde::Serialize;
use serde_json::{json, Map, Value};

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum FieldKind {
    Text { format: Option<String> },
    Number { integer: bool, minimum: Option<f64>, maximum: Option<f64> },
    Boolean,
    Choice { options: Vec<Choice>, multi: bool },
}

#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct Choice {
    pub value: String,
    pub label: String,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct Field {
    pub name: String,
    pub title: Option<String>,
    pub description: Option<String>,
    pub required: bool,
    pub default: Option<Value>,
    #[serde(flatten)]
    pub kind: FieldKind,
}

impl Field {
    pub fn label(&self) -> &str {
        self.title.as_deref().unwrap_or(&self.name)
    }
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(tag = "mode", rename_all = "snake_case")]
pub enum Elicitation {
    Form { session_id: Option<String>, tool_call_id: Option<String>, message: String, fields: Vec<Field> },
    Url { session_id: Option<String>, elicitation_id: String, url: String, host: String, suspicious: bool, message: String },
}

impl Elicitation {
    pub fn parse(params: &Value) -> Result<Elicitation, RpcError> {
        let session_id = params.get("sessionId").and_then(Value::as_str).map(str::to_string);
        let message = params.get("message").and_then(Value::as_str).unwrap_or_default().to_string();
        match params.get("mode").and_then(Value::as_str) {
            Some("form") => {
                let schema = params.get("requestedSchema").ok_or_else(|| RpcError::invalid_params("form elicitation needs requestedSchema"))?;
                Ok(Elicitation::Form {
                    session_id,
                    tool_call_id: params.get("toolCallId").and_then(Value::as_str).map(str::to_string),
                    message,
                    fields: parse_fields(schema)?,
                })
            }
            Some("url") => {
                let url = params.get("url").and_then(Value::as_str).ok_or_else(|| RpcError::invalid_params("url elicitation needs url"))?;
                let (host, suspicious) = url_host(url).ok_or_else(|| RpcError::invalid_params("elicitation url must be http(s) with a host"))?;
                Ok(Elicitation::Url {
                    session_id,
                    elicitation_id: params.get("elicitationId").and_then(Value::as_str).unwrap_or_default().to_string(),
                    url: url.to_string(),
                    host,
                    suspicious,
                    message,
                })
            }
            _ => Err(RpcError::invalid_params("elicitation mode must be form or url")),
        }
    }

    pub fn session_id(&self) -> Option<&str> {
        match self {
            Elicitation::Form { session_id, .. } | Elicitation::Url { session_id, .. } => session_id.as_deref(),
        }
    }
}

fn parse_fields(schema: &Value) -> Result<Vec<Field>, RpcError> {
    let props = schema.get("properties").and_then(Value::as_object).ok_or_else(|| RpcError::invalid_params("requestedSchema needs properties"))?;
    let required: Vec<&str> = schema.get("required").and_then(Value::as_array).map(|a| a.iter().filter_map(Value::as_str).collect()).unwrap_or_default();
    props
        .iter()
        .map(|(name, p)| {
            let kind = field_kind(p).ok_or_else(|| RpcError::invalid_params(format!("unsupported schema for field {name}")))?;
            Ok(Field {
                name: name.clone(),
                title: p.get("title").and_then(Value::as_str).map(str::to_string),
                description: p.get("description").and_then(Value::as_str).map(str::to_string),
                required: required.contains(&name.as_str()),
                default: p.get("default").cloned(),
                kind,
            })
        })
        .collect()
}

fn choices(p: &Value) -> Option<Vec<Choice>> {
    if let Some(values) = p.get("enum").and_then(Value::as_array) {
        let names = p.get("enumNames").and_then(Value::as_array);
        return Some(
            values
                .iter()
                .enumerate()
                .filter_map(|(i, v)| {
                    let value = v.as_str()?.to_string();
                    let label = names.and_then(|n| n.get(i)).and_then(Value::as_str).unwrap_or(&value).to_string();
                    Some(Choice { value, label })
                })
                .collect(),
        );
    }
    let titled = p.get("oneOf").or_else(|| p.get("anyOf"))?.as_array()?;
    Some(
        titled
            .iter()
            .filter_map(|o| {
                let value = o.get("const")?.as_str()?.to_string();
                let label = o.get("title").and_then(Value::as_str).unwrap_or(&value).to_string();
                Some(Choice { value, label })
            })
            .collect(),
    )
}

fn field_kind(p: &Value) -> Option<FieldKind> {
    match p.get("type").and_then(Value::as_str)? {
        "string" => Some(match choices(p) {
            Some(options) => FieldKind::Choice { options, multi: false },
            None => FieldKind::Text { format: p.get("format").and_then(Value::as_str).map(str::to_string) },
        }),
        "number" | "integer" => Some(FieldKind::Number {
            integer: p.get("type").and_then(Value::as_str) == Some("integer"),
            minimum: p.get("minimum").and_then(Value::as_f64),
            maximum: p.get("maximum").and_then(Value::as_f64),
        }),
        "boolean" => Some(FieldKind::Boolean),
        "array" => Some(FieldKind::Choice { options: choices(p.get("items")?)?, multi: true }),
        _ => None,
    }
}

/// One answer as a UI collects it: picked choice values and/or free text.
#[derive(Debug, Clone, Default)]
pub struct Answer {
    pub selected: Vec<String>,
    pub text: String,
}

/// Validate answers against the fields and build the `content` object.
/// Errors name the field so the UI can say what to fix.
pub fn content(fields: &[Field], answers: &[(String, Answer)]) -> Result<Value, String> {
    let mut out = Map::new();
    for f in fields {
        let a = answers.iter().find(|(n, _)| n == &f.name).map(|(_, a)| a);
        let text = a.map(|a| a.text.trim()).unwrap_or("");
        let picked: Vec<&str> = a.map(|a| a.selected.iter().map(String::as_str).collect()).unwrap_or_default();
        let value = match &f.kind {
            FieldKind::Text { .. } => (!text.is_empty()).then(|| json!(text)),
            FieldKind::Number { integer, minimum, maximum } => {
                if text.is_empty() {
                    None
                } else {
                    let n: f64 = text.parse().map_err(|_| format!("{} must be a number", f.label()))?;
                    if *integer && n.fract() != 0.0 {
                        return Err(format!("{} must be a whole number", f.label()));
                    }
                    if minimum.is_some_and(|m| n < m) || maximum.is_some_and(|m| n > m) {
                        return Err(format!("{} is out of range", f.label()));
                    }
                    Some(if *integer { json!(n as i64) } else { json!(n) })
                }
            }
            FieldKind::Boolean => {
                let v = picked.first().copied().unwrap_or(text);
                match v.to_ascii_lowercase().as_str() {
                    "" => None,
                    "true" | "yes" => Some(json!(true)),
                    "false" | "no" => Some(json!(false)),
                    _ => return Err(format!("{} must be yes or no", f.label())),
                }
            }
            FieldKind::Choice { options, multi } => {
                let mut vals: Vec<&str> = picked.clone();
                if vals.is_empty() && !text.is_empty() {
                    vals = text.split(',').map(str::trim).filter(|s| !s.is_empty()).collect();
                }
                for v in &vals {
                    if !options.iter().any(|o| o.value == *v || o.label == *v) {
                        return Err(format!("{} has no option {v}", f.label()));
                    }
                }
                let canon: Vec<String> = vals
                    .iter()
                    .map(|v| options.iter().find(|o| o.value == *v || o.label == *v).map(|o| o.value.clone()).unwrap_or_default())
                    .collect();
                match (multi, canon.len()) {
                    (_, 0) => None,
                    (true, _) => Some(json!(canon)),
                    (false, 1) => Some(json!(canon[0])),
                    (false, _) => return Err(format!("{} takes one choice", f.label())),
                }
            }
        };
        match value {
            Some(v) => {
                out.insert(f.name.clone(), v);
            }
            None if f.required => return Err(format!("{} is required", f.label())),
            None => {}
        }
    }
    Ok(Value::Object(out))
}

pub fn accept(content: Option<Value>) -> Value {
    match content {
        Some(c) => json!({"action": "accept", "content": c}),
        None => json!({"action": "accept"}),
    }
}

pub fn decline() -> Value {
    json!({"action": "decline"})
}

pub fn cancel() -> Value {
    json!({"action": "cancel"})
}

/// Host of an http(s) URL, and whether it looks suspicious (punycode,
/// embedded credentials, raw IP literal).
pub fn url_host(url: &str) -> Option<(String, bool)> {
    let rest = url.strip_prefix("https://").or_else(|| url.strip_prefix("http://"))?;
    let authority = rest.split(['/', '?', '#']).next()?;
    let has_userinfo = authority.contains('@');
    let hostport = authority.rsplit('@').next()?;
    let host = if hostport.starts_with('[') {
        hostport.split(']').next()?.trim_start_matches('[').to_string()
    } else {
        hostport.split(':').next()?.to_string()
    };
    if host.is_empty() {
        return None;
    }
    let host = host.to_ascii_lowercase();
    let ip_literal = host.contains(':') || host.split('.').all(|p| !p.is_empty() && p.bytes().all(|b| b.is_ascii_digit()));
    let suspicious = has_userinfo || host.split('.').any(|l| l.starts_with("xn--")) || ip_literal;
    Some((host, suspicious))
}
