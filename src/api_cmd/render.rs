//! What the caller sees.
//!
//! Two shapes, one rule: the body goes to stdout whether the call succeeded or
//! not, and anything Aura has to say about it goes to stderr. A failing call
//! still answered something — the server's own `{"error": …}` is usually the
//! only useful sentence in the whole exchange — and a script that pipes stdout
//! to `jq` should get that reply rather than a line of ours mixed into it.

use colored::Colorize;

use crate::workspace_api::client::Auth;

use super::request::{shown, Request};

/// Print the reply body. Pretty-printed when it is JSON and `raw` is off,
/// because that is what a person is reading it for; byte-for-byte otherwise,
/// because that is what a script is.
pub fn body(text: &str, raw: bool) {
    if text.trim().is_empty() {
        return;
    }
    if raw {
        println!("{text}");
        return;
    }
    match serde_json::from_str::<serde_json::Value>(text) {
        Ok(v) => println!("{}", serde_json::to_string_pretty(&v).unwrap_or_else(|_| text.to_string())),
        // Not JSON: printed as it came. A passthrough that swallowed an HTML
        // error page would hide the one clue that the request reached a proxy
        // and never reached Aura.
        Err(_) => println!("{text}"),
    }
}

/// Print the request that *would* be sent, and send nothing.
///
/// Goes to stdout, because here the plan is the output. The bearer is never in
/// it — neither the value nor its length — and the credential is described by
/// where it came from, which is the part that is actually in question when a
/// call is refused.
pub fn plan(req: &Request, auth: &Auth) {
    println!("{} {}", req.method.bold(), req.url);
    println!(
        "  {}",
        format!("Authorization: Bearer <{}>", auth.source.label()).dimmed()
    );
    println!("  {}", "Accept: application/json".dimmed());
    if req.body.is_some() {
        println!("  {}", "Content-Type: application/json".dimmed());
    }
    for (name, value) in &req.headers {
        println!("  {}", shown(name, value).dimmed());
    }
    if let Some(b) = &req.body {
        println!("\n{b}");
    }
}

/// One line on stderr about a reply that was not a success, after the body has
/// already gone to stdout.
pub fn trouble(status: u16, body_text: &str) {
    let reason = serde_json::from_str::<serde_json::Value>(body_text)
        .ok()
        .and_then(|v| {
            v.get("error")
                .and_then(|e| e.as_str())
                .map(str::to_string)
        })
        .unwrap_or_default();
    if reason.is_empty() {
        eprintln!("{}", format!("HTTP {status}").red());
    } else {
        eprintln!("{}", format!("HTTP {status}: {reason}").red());
    }
}
