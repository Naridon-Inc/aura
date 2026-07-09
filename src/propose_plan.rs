//! `aura propose-plan` — render an interactive PlanCard in aura-shell so
//! the user can approve / cancel a multi-step plan the Manager just
//! drafted, without dumping a markdown bullet list into the chat.
//!
//! Same wire layout as `aura ask-user`: connect to the shell's UNIX
//! socket, write a JSON envelope keyed `kind: "propose_plan"`, block on
//! the response. The reply is `{"action": "build" | "cancel"}`; we print
//! the action verb so claude's Bash tool sees it on the next turn and
//! can decide whether to fan out subagents or back off.
//!
//! Invocation forms:
//!
//!   aura propose-plan --json '{ "title": "...", "summary": "...",
//!                                "todos": [{"description":"...", "agent":"claude"}] }'
//!
//!   aura propose-plan --title "..." --summary "..." \
//!       --todo "Build UI shell::gemini" --todo "Wire backend::claude"
//!
//! The `--todo` short-form uses `description::agent` (agent is optional —
//! omit the `::agent` suffix to let the Manager pick).

use std::env;
use std::io::{BufRead, BufReader, Write};
use std::os::unix::net::UnixStream;
use std::path::PathBuf;

use serde::Serialize;

#[derive(Serialize)]
struct PlanTodo {
    description: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    agent: Option<String>,
    /// Bucket N1 — teammate email/username assigned to this todo.
    #[serde(skip_serializing_if = "Option::is_none")]
    assignee: Option<String>,
}

#[derive(Serialize)]
struct Envelope {
    kind: &'static str,
    session_id: String,
    title: String,
    summary: String,
    todos: Vec<PlanTodo>,
}

fn socket_path() -> PathBuf {
    if let Ok(p) = env::var("AURA_SHELL_SOCKET") {
        return PathBuf::from(p);
    }
    let mut p = env::var_os("HOME")
        .map(PathBuf::from)
        .unwrap_or_else(|| PathBuf::from("."));
    p.push(".aura");
    p.push("run");
    p.push("aura-shell-mcp.sock");
    p
}

/// Parse a `description::agent[::assignee]` short-form todo string.
/// `description` alone — Manager picks the agent, no teammate.
/// `description::agent` — pinned agent, no teammate.
/// `description::agent::assignee` — pinned agent + teammate (Bucket N1).
/// `description::::assignee` — Manager-picked agent, teammate set.
fn parse_short_todo(raw: &str) -> PlanTodo {
    let parts: Vec<&str> = raw.splitn(3, "::").collect();
    let description = parts[0].trim().to_string();
    let agent = parts
        .get(1)
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty());
    let assignee = parts
        .get(2)
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty());
    PlanTodo {
        description,
        agent,
        assignee,
    }
}

/// Run the propose-plan round-trip. Returns the process exit code.
pub fn run(
    json: Option<&str>,
    file: Option<&str>,
    title: Option<&str>,
    summary: Option<&str>,
    todos: &[String],
) -> i32 {
    let session_id = match env::var("AURA_MANAGER_SESSION_ID") {
        Ok(s) if !s.is_empty() => s,
        _ => {
            eprintln!(
                "aura propose-plan: AURA_MANAGER_SESSION_ID not set. \
                 This command must be invoked from inside an aura-shell Manager session."
            );
            return 2;
        }
    };

    // Resolve --file to the same payload shape --json expects, so the rest of
    // the function flows through one code path. --file is the preferred entry
    // for AI brains because it sidesteps shell heredoc rejection.
    let file_payload: Option<String> = match file {
        Some(path) => match std::fs::read_to_string(path) {
            Ok(s) => Some(s),
            Err(e) => {
                eprintln!("aura propose-plan: read --file {path}: {e}");
                return 2;
            }
        },
        None => None,
    };
    let json: Option<&str> = json.or(file_payload.as_deref());

    let envelope_value = if let Some(payload) = json {
        // `--json -` reads the envelope from stdin so brains can pipe
        // Cursor-grade plans (objective, baseline, mermaid, phases,
        // deliverables, tests, todos with file_refs) without trying to
        // cram a multi-paragraph JSON string into a shell argv. Inline
        // JSON via `--json '{...}'` still works for short envelopes.
        let payload_owned: String = if payload.trim() == "-" {
            use std::io::Read as _;
            let mut buf = String::new();
            if let Err(e) = std::io::stdin().read_to_string(&mut buf) {
                eprintln!("aura propose-plan: read stdin: {e}");
                return 2;
            }
            buf
        } else {
            payload.to_string()
        };
        let mut v: serde_json::Value = match serde_json::from_str(&payload_owned) {
            Ok(v) => v,
            Err(e) => {
                eprintln!("aura propose-plan: parse --json: {e}");
                return 2;
            }
        };
        v["kind"] = serde_json::Value::String("propose_plan".to_string());
        v["session_id"] = serde_json::Value::String(session_id);
        v
    } else {
        let title = title
            .map(|s| s.to_string())
            .filter(|s| !s.is_empty())
            .unwrap_or_else(|| "Plan".to_string());
        let summary = summary.map(|s| s.to_string()).unwrap_or_default();
        if todos.is_empty() {
            eprintln!(
                "aura propose-plan: must supply at least one --todo, or use --json."
            );
            return 2;
        }
        let todos: Vec<PlanTodo> = todos.iter().map(|t| parse_short_todo(t)).collect();
        let env = Envelope {
            kind: "propose_plan",
            session_id,
            title,
            summary,
            todos,
        };
        match serde_json::to_value(&env) {
            Ok(v) => v,
            Err(e) => {
                eprintln!("aura propose-plan: encode envelope: {e}");
                return 4;
            }
        }
    };

    let path = socket_path();
    let stream = match UnixStream::connect(&path) {
        Ok(s) => s,
        Err(e) => {
            eprintln!(
                "aura propose-plan: connect {} failed: {e}",
                path.display()
            );
            return 3;
        }
    };

    let mut writer = match stream.try_clone() {
        Ok(s) => s,
        Err(e) => {
            eprintln!("aura propose-plan: clone socket failed: {e}");
            return 3;
        }
    };

    let mut bytes = match serde_json::to_vec(&envelope_value) {
        Ok(b) => b,
        Err(e) => {
            eprintln!("aura propose-plan: encode envelope: {e}");
            return 4;
        }
    };
    bytes.push(b'\n');
    if let Err(e) = writer.write_all(&bytes) {
        eprintln!("aura propose-plan: write envelope: {e}");
        return 3;
    }
    let _ = writer.flush();

    let mut reader = BufReader::new(stream);
    let mut line = String::new();
    match reader.read_line(&mut line) {
        Ok(0) => {
            // EOF — bridge closed without a verb. Treat as user closed
            // the surface; print `cancel` so the brain sees a definite
            // verb, and exit 5 so the brain prompt can distinguish "user
            // closed" from "brain crashed".
            println!("cancel");
            eprintln!("aura propose-plan: socket closed before response (treated as cancel)");
            return 5;
        }
        Ok(_) => {}
        Err(e) => {
            eprintln!("aura propose-plan: read response: {e}");
            println!("cancel");
            return 5;
        }
    }
    if line.trim().is_empty() {
        println!("cancel");
        eprintln!("aura propose-plan: empty response (treated as cancel)");
        return 5;
    }

    let resp: serde_json::Value = match serde_json::from_str(line.trim()) {
        Ok(v) => v,
        Err(e) => {
            eprintln!("aura propose-plan: parse response: {e}");
            return 4;
        }
    };

    let action = resp
        .get("action")
        .and_then(|v| v.as_str())
        .unwrap_or("cancel")
        .to_string();
    println!("{action}");
    // Crew is the runner. On Build the shell mirrors the plan onto the local
    // board, syncs it into the loop graph, and AUTO-STARTS the Crew runner —
    // real coding agents work each task in dependency order, with proof, in
    // the Build rail. The brain must NOT fan out its own subagents for a built
    // plan (that would double-run the work). We print a single `runner:crew`
    // marker the brain's prompt keys on to know execution is owned by the Crew
    // — and we deliberately no longer emit `pid:`/`tid:` spawn handles, since
    // there's nothing for the brain to dispatch.
    if action == "build" {
        println!("runner:crew");
    }
    0
}
