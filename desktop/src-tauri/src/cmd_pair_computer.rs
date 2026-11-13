//! Adding a computer somebody already has, from the app.
//!
//! Three requests to `/api/v2/places/pair` on the signed-in token, org-scoped
//! by header: make a one-time code, watch it until a computer spends it, and
//! throw it away. A fourth command connects the computer the app is running
//! on: it makes a code for the signed-in person and hands it to `aura join -`
//! on stdin, so the code never reaches the page and never sits in the
//! process list.
//!
//! The server decides who may add which kind of computer and writes every
//! sentence about a refusal; these commands carry the answer across.

use std::process::Stdio;
use std::time::Duration;

use reqwest::Method;
use serde_json::{json, Value};
use tokio::io::AsyncWriteExt;

use crate::cmd_cloud_admin::{send, signed_in};

/// Long enough for the network call, the service to be written and started,
/// and launchd's retries; short enough that a hung run is not a hung button.
const JOIN_TIMEOUT: Duration = Duration::from_secs(120);

fn pairs(origin: &str, id: Option<&str>) -> String {
    let base = format!("{}/api/v2/places/pair", origin.trim_end_matches('/'));
    match id {
        Some(id) => format!("{base}/{id}"),
        None => base,
    }
}

/// Only the two kinds the server knows; anything else is refused here rather
/// than sent.
fn scope_of(raw: Option<&str>) -> Result<&'static str, String> {
    match raw.map(str::trim).unwrap_or("personal") {
        "" | "personal" => Ok("personal"),
        "team" => Ok("team"),
        _ => Err("A computer is either yours or the team's.".to_string()),
    }
}

/// A code's id goes into a path, so it must be exactly a UUID.
fn pair_id(raw: &str) -> Result<String, String> {
    uuid::Uuid::parse_str(raw.trim())
        .map(|u| u.hyphenated().to_string())
        .map_err(|_| "That code isn't one Aura made.".to_string())
}

/// A fresh code for the signed-in person. The answer carries the code, the
/// one line to paste (`install`), and when it runs out.
#[tauri::command]
pub async fn pair_computer_start(scope: Option<String>) -> Result<Value, String> {
    let scope = scope_of(scope.as_deref())?;
    let (token, origin) = signed_in()?;
    send(Method::POST, pairs(&origin, None), &token, Some(json!({ "scope": scope }))).await
}

/// Where a code is: `waiting`, `joining`, `connected` (with the computer's
/// name, cores and memory), `expired` or `removed`.
#[tauri::command]
pub async fn pair_computer_status(id: String) -> Result<Value, String> {
    let id = pair_id(&id)?;
    let (token, origin) = signed_in()?;
    send(Method::GET, pairs(&origin, Some(&id)), &token, None).await
}

/// Throw a code away before anybody spends it.
#[tauri::command]
pub async fn pair_computer_cancel(id: String) -> Result<(), String> {
    let id = pair_id(&id)?;
    let (token, origin) = signed_in()?;
    send(Method::DELETE, pairs(&origin, Some(&id)), &token, None).await.map(|_| ())
}

/// Connect the computer the app runs on, for the signed-in person only.
///
/// Answers with what `aura join --json` said (`ok`, `state`, `message`,
/// `name`, `org`, `notes`, …) plus `pair_id`, so the screen can watch the
/// computer come up the same way it watches any other.
#[tauri::command]
pub async fn pair_this_computer() -> Result<Value, String> {
    let (token, origin) = signed_in()?;
    let issued = send(Method::POST, pairs(&origin, None), &token, Some(json!({ "scope": "personal" }))).await?;
    let (id, code) = issued_parts(&issued)?;
    let outcome = run_join(&code, &origin).await;
    let mut report = match outcome {
        Ok(report) => report,
        Err(e) => {
            discard(&token, &origin, &id).await;
            return Err(e);
        }
    };
    // Only a join that says `connected` spent the code. Anything else — a
    // refusal, or a computer that was already connected and never sent it —
    // leaves it unspent, so it is thrown away now rather than left valid.
    if report.get("state").and_then(Value::as_str) != Some("connected") {
        discard(&token, &origin, &id).await;
    }
    if let Some(obj) = report.as_object_mut() {
        obj.insert("pair_id".into(), Value::String(id));
    }
    Ok(report)
}

/// A code that was not spent is thrown away rather than left valid for ten
/// minutes. Best effort: a spent or expired code is already useless.
async fn discard(token: &str, origin: &str, id: &str) {
    let _ = send(Method::DELETE, pairs(origin, Some(id)), token, None).await;
}

fn issued_parts(issued: &Value) -> Result<(String, String), String> {
    let id = issued.get("id").and_then(Value::as_str).map(pair_id).transpose()?;
    let code = issued.get("code").and_then(Value::as_str).map(str::to_string);
    match (id, code) {
        (Some(id), Some(code)) if !code.is_empty() => Ok((id, code)),
        _ => Err("Aura Cloud answered, but without a code.".to_string()),
    }
}

/// `aura join - --json`, the code on stdin, pointed at the cloud this app is
/// signed in to.
async fn run_join(code: &str, origin: &str) -> Result<Value, String> {
    let mut cmd = tokio::process::Command::new(crate::agent_event_listener::resolve_aura_bin());
    cmd.args(["join", "-", "--json"])
        .env("AURA_CLOUD_URL", origin.trim_end_matches('/'))
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true);
    let mut child = cmd.spawn().map_err(|e| format!("Couldn't start Aura on this computer: {e}"))?;
    if let Some(mut stdin) = child.stdin.take() {
        stdin
            .write_all(format!("{code}\n").as_bytes())
            .await
            .map_err(|e| format!("Couldn't hand the code to Aura: {e}"))?;
    }
    let out = match tokio::time::timeout(JOIN_TIMEOUT, child.wait_with_output()).await {
        Err(_) => return Err("Connecting this computer took too long. Try again.".to_string()),
        Ok(r) => r.map_err(|e| format!("Aura stopped before it answered: {e}"))?,
    };
    join_answer(&String::from_utf8_lossy(&out.stdout), &String::from_utf8_lossy(&out.stderr))
}

/// The last line of JSON `aura join` printed. An older `aura` without pair
/// codes prints sentences instead; that is said plainly.
fn join_answer(stdout: &str, stderr: &str) -> Result<Value, String> {
    let report = stdout
        .lines()
        .rev()
        .map(str::trim)
        .filter(|l| l.starts_with('{'))
        .find_map(|l| serde_json::from_str::<Value>(l).ok())
        .filter(|v| v.get("state").is_some_and(Value::is_string) && v.get("ok").is_some_and(Value::is_boolean));
    match report {
        Some(r) => Ok(r),
        None => {
            let said = stderr.lines().map(str::trim).rfind(|l| !l.is_empty()).unwrap_or("");
            Err(if said.is_empty() {
                "The Aura on this computer is too old to connect it. Update Aura and try again.".to_string()
            } else {
                format!("Aura couldn't connect this computer: {said}")
            })
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_paths_are_the_cloud_routes() {
        assert_eq!(pairs("https://auravcs.com/", None), "https://auravcs.com/api/v2/places/pair");
        assert_eq!(
            pairs("https://auravcs.com", Some("0b5c2f1e-1d2a-4c55-9d7e-3f1a2b3c4d5e")),
            "https://auravcs.com/api/v2/places/pair/0b5c2f1e-1d2a-4c55-9d7e-3f1a2b3c4d5e"
        );
    }

    #[test]
    fn only_the_two_kinds_are_sent() {
        assert_eq!(scope_of(None), Ok("personal"));
        assert_eq!(scope_of(Some("")), Ok("personal"));
        assert_eq!(scope_of(Some("team")), Ok("team"));
        assert!(scope_of(Some("everyone")).is_err());
        assert!(scope_of(Some("Team")).is_err());
    }

    #[test]
    fn an_id_cannot_walk_into_another_path() {
        assert!(pair_id("../../orgs").is_err());
        assert!(pair_id("0b5c2f1e-1d2a-4c55-9d7e-3f1a2b3c4d5e/../x").is_err());
        assert_eq!(
            pair_id(" 0B5C2F1E-1D2A-4C55-9D7E-3F1A2B3C4D5E ").unwrap(),
            "0b5c2f1e-1d2a-4c55-9d7e-3f1a2b3c4d5e"
        );
    }

    #[test]
    fn a_code_answer_needs_both_halves() {
        let ok = json!({ "id": "0b5c2f1e-1d2a-4c55-9d7e-3f1a2b3c4d5e", "code": "AURA-K7QM-3XPT" });
        assert_eq!(
            issued_parts(&ok).unwrap(),
            ("0b5c2f1e-1d2a-4c55-9d7e-3f1a2b3c4d5e".to_string(), "AURA-K7QM-3XPT".to_string())
        );
        assert!(issued_parts(&json!({ "code": "AURA-K7QM-3XPT" })).is_err());
        assert!(issued_parts(&json!({ "id": "nope", "code": "AURA-K7QM-3XPT" })).is_err());
        assert!(issued_parts(&json!({ "id": "0b5c2f1e-1d2a-4c55-9d7e-3f1a2b3c4d5e", "code": "" })).is_err());
    }

    #[test]
    fn the_join_answer_is_its_last_json_line() {
        let out = "Connecting…\n{\"ok\":true,\"state\":\"connected\",\"message\":\"Connected to Acme.\",\"name\":\"Mo's Mac\"}\n";
        let r = join_answer(out, "").unwrap();
        assert_eq!(r["state"], "connected");
        assert_eq!(r["name"], "Mo's Mac");

        let refused = "{\"ok\":false,\"state\":\"refused\",\"message\":\"That code was already used.\"}";
        assert_eq!(join_answer(refused, "").unwrap()["ok"], false);
    }

    #[test]
    fn an_old_aura_is_named_as_the_problem() {
        let e = join_answer("", "").unwrap_err();
        assert!(e.contains("too old"), "{e}");
        let e = join_answer("", "✗ Invalid join token. Get a new one from the mothership operator.\n").unwrap_err();
        assert!(e.contains("Invalid join token"), "{e}");
        assert!(join_answer("{\"something\":\"else\"}", "").is_err());
    }
}
