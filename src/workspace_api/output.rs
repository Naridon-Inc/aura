//! Rendering: `--json` prints the raw response; otherwise a few plain lines.
//!
//! Every renderer is `fn(&Value) -> String` so it is testable without a
//! terminal, and `emit` is the only place that prints.

use serde_json::Value;

use super::client::ApiError;

/// Print either the raw JSON or the human rendering.
pub fn emit(json: bool, value: &Value, render: fn(&Value) -> String) {
    if json {
        println!("{}", serde_json::to_string_pretty(value).unwrap_or_else(|_| "null".into()));
    } else {
        println!("{}", render(value));
    }
}

pub fn print_error(e: &ApiError) {
    eprintln!("  ✗ {}", e.message());
}

fn s<'a>(v: &'a Value, key: &str) -> &'a str {
    v.get(key).and_then(|x| x.as_str()).unwrap_or("")
}

fn opt_line(out: &mut String, label: &str, value: &str) {
    if !value.is_empty() {
        out.push_str(&format!("  {label:<10} {value}\n"));
    }
}

/// One workspace: id first (the thing every other verb needs), then what it
/// is for, then the intent that created it.
pub fn render_workspace(v: &Value) -> String {
    let mut out = String::new();
    out.push_str(&format!("  {:<10} {}\n", "id", s(v, "id")));
    opt_line(&mut out, "status", s(v, "status"));
    opt_line(&mut out, "title", s(v, "objective"));
    opt_line(&mut out, "intent", s(v, "intent"));
    opt_line(&mut out, "agent", s(v, "agent"));
    opt_line(&mut out, "branch", s(v, "branch"));
    opt_line(&mut out, "model", s(v, "model"));
    opt_line(&mut out, "created", s(v, "created_at"));
    opt_line(&mut out, "active", s(v, "last_activity_at"));
    opt_line(&mut out, "ended", s(v, "ended_at"));
    out.trim_end().to_string()
}

pub fn render_workspace_list(v: &Value) -> String {
    let rows = match v.as_array() {
        Some(r) if !r.is_empty() => r,
        _ => return "  no workspaces".to_string(),
    };
    let mut out = String::new();
    for w in rows {
        let title = s(w, "objective");
        let intent = s(w, "intent");
        let what = if !intent.is_empty() {
            intent
        } else if !title.is_empty() {
            title
        } else {
            "(untitled)"
        };
        out.push_str(&format!("  {:<36}  {:<9}  {}\n", s(w, "id"), s(w, "status"), what));
    }
    out.trim_end().to_string()
}

pub fn render_prompt_ack(v: &Value) -> String {
    let mut out = format!("  queued  {}", s(v, "id"));
    let status = s(v, "status");
    if !status.is_empty() {
        out.push_str(&format!("  ({status})"));
    }
    out
}

pub fn render_messages(v: &Value) -> String {
    let rows = match v.as_array() {
        Some(r) if !r.is_empty() => r,
        _ => return "  no messages".to_string(),
    };
    let mut out = String::new();
    for m in rows {
        let body = s(m, "body");
        let mut lines = body.lines();
        let first = lines.next().unwrap_or("");
        out.push_str(&format!("  [{}] {:<9} {}\n", s(m, "created_at"), s(m, "role"), first));
        for l in lines {
            out.push_str(&format!("  {:<37}{}\n", "", l));
        }
    }
    out.trim_end().to_string()
}

pub fn render_models(v: &Value) -> String {
    let rows = match v.get("models").and_then(|m| m.as_array()) {
        Some(r) if !r.is_empty() => r,
        _ => return "  no models".to_string(),
    };
    let mut out = String::new();
    for m in rows {
        let available = m.get("available").and_then(|a| a.as_bool()).unwrap_or(false);
        out.push_str(&format!(
            "  {:<32} {:<10} {:<8} {}\n",
            s(m, "id"),
            s(m, "provider"),
            s(m, "tier"),
            if available { "key configured" } else { "no key" }
        ));
    }
    let default = s(v, "default_provider");
    if !default.is_empty() {
        out.push_str(&format!("  default provider: {default}\n"));
    }
    let catalog = s(v, "catalog_url");
    if !catalog.is_empty() {
        out.push_str(&format!("  full catalog: {catalog}\n"));
    }
    out.trim_end().to_string()
}

pub fn render_whoami(v: &Value) -> String {
    let user = v.get("user").cloned().unwrap_or(Value::Null);
    let org = v.get("org").cloned().unwrap_or(Value::Null);
    let key = v.get("key").cloned().unwrap_or(Value::Null);
    let mut out = String::new();
    let login = s(&user, "login");
    let user_line = if login.is_empty() {
        s(&user, "id").to_string()
    } else {
        format!("{login} ({})", s(&user, "id"))
    };
    out.push_str(&format!("  {:<10} {}\n", "user", user_line));
    out.push_str(&format!("  {:<10} {} ({})\n", "org", s(&org, "slug"), s(&org, "name")));
    let kind = s(&key, "kind");
    let label = s(&key, "label");
    let key_line = if label.is_empty() {
        kind.to_string()
    } else {
        format!("{kind} \"{label}\"")
    };
    out.push_str(&format!("  {:<10} {}\n", "key", key_line));
    let unrestricted = key.get("unrestricted").and_then(|u| u.as_bool()).unwrap_or(false);
    let scopes: Vec<&str> = key
        .get("scopes")
        .and_then(|x| x.as_array())
        .map(|a| a.iter().filter_map(|x| x.as_str()).collect())
        .unwrap_or_default();
    let scope_line = if unrestricted {
        "unrestricted (a person's token)".to_string()
    } else if scopes.is_empty() {
        "none".to_string()
    } else {
        scopes.join(", ")
    };
    out.push_str(&format!("  {:<10} {}\n", "scopes", scope_line));
    opt_line(&mut out, "agent", s(&key, "agent"));
    opt_line(&mut out, "token", s(v, "token_source"));
    opt_line(&mut out, "origin", s(v, "origin"));
    out.trim_end().to_string()
}
