//! `aura ask-user` — pause a CLI-brain Manager mid-turn to ask the user a
//! question through aura-shell's QuestionCard UI.
//!
//! The Aura Manager runs as a Claude Code / Gemini CLI subprocess inside
//! aura-shell. Those CLIs can't directly call our Tauri-side `ask_user`
//! tool — they only have generic Bash. So the Manager invokes this
//! command via its Bash tool:
//!
//!   aura ask-user "Which frontend framework?" \
//!       --kind choice --options "Next.js,Remix,Vite+React"
//!
//! We connect to the same UNIX socket the permission shim uses
//! (`~/.aura/run/aura-shell-mcp.sock` by default, override with
//! `AURA_SHELL_SOCKET`), write a JSON envelope keyed `kind: "ask_user"`,
//! and block on the response line. aura-shell renders the QuestionCard,
//! the user clicks an option, and the answer is written back as
//! `{"answer": "..."}` — we print that to stdout so claude's bash tool
//! returns it to claude's context as the next conversational input.

use std::env;
use std::io::{BufRead, BufReader, Write};
use std::os::unix::net::UnixStream;
use std::path::PathBuf;

/// Default socket path (mirrors `cmd_permission_socket::socket_path` on
/// the shell side). `$AURA_SHELL_SOCKET` overrides — set by aura-shell
/// when it spawns the CLI brain so we don't depend on $HOME matching.
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

/// Run the ask-user round-trip. Returns the process exit code.
///
/// `kind` accepts: `choice` | `multi_choice` | `text`. `options` is the
/// raw `--options` arg — comma-separated when present.
pub fn run(question: &str, kind: &str, options: Option<&str>) -> i32 {
    let session_id = match env::var("AURA_MANAGER_SESSION_ID") {
        Ok(s) if !s.is_empty() => s,
        _ => {
            eprintln!(
                "aura ask-user: AURA_MANAGER_SESSION_ID not set. \
                 This command must be invoked from inside an aura-shell Manager session."
            );
            return 2;
        }
    };

    let shape = match kind {
        "choice" | "multi_choice" | "text" => kind.to_string(),
        other => {
            eprintln!(
                "aura ask-user: invalid --kind '{other}'. Use one of: choice, multi_choice, text"
            );
            return 2;
        }
    };

    let opts: Vec<String> = options.map(split_options).unwrap_or_default();

    if shape != "text" && opts.is_empty() {
        eprintln!(
            "aura ask-user: --kind {shape} requires at least one --options entry."
        );
        return 2;
    }

    let envelope = serde_json::json!({
        "kind": "ask_user",
        "session_id": session_id,
        "question": question,
        "shape": shape,
        "options": opts,
    });

    let path = socket_path();
    let stream = match UnixStream::connect(&path) {
        Ok(s) => s,
        Err(e) => {
            eprintln!(
                "aura ask-user: connect {} failed: {e}",
                path.display()
            );
            return 3;
        }
    };

    let mut writer = match stream.try_clone() {
        Ok(s) => s,
        Err(e) => {
            eprintln!("aura ask-user: clone socket failed: {e}");
            return 3;
        }
    };

    let mut bytes = match serde_json::to_vec(&envelope) {
        Ok(b) => b,
        Err(e) => {
            eprintln!("aura ask-user: encode envelope: {e}");
            return 4;
        }
    };
    bytes.push(b'\n');
    if let Err(e) = writer.write_all(&bytes) {
        eprintln!("aura ask-user: write envelope: {e}");
        return 3;
    }
    let _ = writer.flush();

    let mut reader = BufReader::new(stream);
    let mut line = String::new();
    if let Err(e) = reader.read_line(&mut line) {
        eprintln!("aura ask-user: read response: {e}");
        return 3;
    }
    if line.trim().is_empty() {
        eprintln!("aura ask-user: socket closed before response");
        return 3;
    }

    let resp: serde_json::Value = match serde_json::from_str(line.trim()) {
        Ok(v) => v,
        Err(e) => {
            eprintln!("aura ask-user: parse response: {e}");
            return 4;
        }
    };

    let answer = resp
        .get("answer")
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .to_string();

    // Print only the raw answer so claude's Bash tool feeds the user's
    // reply directly into claude's next turn — no markdown, no banner.
    println!("{answer}");
    0
}

/// Split a `--options` argument into individual options.
///
/// Naively splitting on `,` mangles common LLM output where a choice
/// contains a parenthetical clarifier, e.g.
/// `Next.js 15 (App Router, RSC, single repo),Remix,Vite + React`
/// would split into six fragments. Rules:
///
///   * Top-level `|` (when present anywhere outside brackets) takes
///     precedence as the delimiter — gives the agent an explicit
///     comma-safe choice.
///   * Otherwise split on `,` but only when the comma is at bracket
///     depth zero. `(`, `[`, `{` increase depth; the matching closers
///     decrease it.
///   * `\\,` / `\\|` / `\\\\` escapes pass the literal character through.
///   * Trim each segment and drop empties.
fn split_options(raw: &str) -> Vec<String> {
    let delim = if has_top_level(raw, '|') { '|' } else { ',' };
    split_paren_aware(raw, delim)
}

fn has_top_level(s: &str, target: char) -> bool {
    let mut depth: i32 = 0;
    let mut chars = s.chars();
    while let Some(c) = chars.next() {
        match c {
            '\\' => {
                let _ = chars.next();
            }
            '(' | '[' | '{' => depth += 1,
            ')' | ']' | '}' => depth = (depth - 1).max(0),
            _ if c == target && depth == 0 => return true,
            _ => {}
        }
    }
    false
}

fn split_paren_aware(s: &str, delim: char) -> Vec<String> {
    let mut out: Vec<String> = Vec::new();
    let mut buf = String::new();
    let mut depth: i32 = 0;
    let mut chars = s.chars().peekable();
    while let Some(c) = chars.next() {
        if c == '\\' {
            if let Some(&next) = chars.peek() {
                if next == delim || next == '\\' || next == '(' || next == ')'
                    || next == '[' || next == ']' || next == '{' || next == '}'
                {
                    buf.push(next);
                    chars.next();
                    continue;
                }
            }
            buf.push(c);
            continue;
        }
        match c {
            '(' | '[' | '{' => {
                depth += 1;
                buf.push(c);
            }
            ')' | ']' | '}' => {
                depth = (depth - 1).max(0);
                buf.push(c);
            }
            _ if c == delim && depth == 0 => {
                push_trimmed(&mut out, &buf);
                buf.clear();
            }
            _ => buf.push(c),
        }
    }
    push_trimmed(&mut out, &buf);
    out
}

fn push_trimmed(out: &mut Vec<String>, s: &str) {
    let t = s.trim();
    if !t.is_empty() {
        out.push(t.to_string());
    }
}

#[cfg(test)]
mod tests {
    use super::split_options;

    #[test]
    fn plain_comma_split() {
        assert_eq!(
            split_options("Next.js,Remix,Vite+React"),
            vec!["Next.js", "Remix", "Vite+React"],
        );
    }

    #[test]
    fn paren_grouped_commas_stay_together() {
        assert_eq!(
            split_options("Next.js 15 (App Router, RSC, single repo),Remix,Vite + React SPA + separate API,SvelteKit"),
            vec![
                "Next.js 15 (App Router, RSC, single repo)",
                "Remix",
                "Vite + React SPA + separate API",
                "SvelteKit",
            ],
        );
    }

    #[test]
    fn pipe_takes_precedence_when_present() {
        assert_eq!(
            split_options("a, b | c, d | e"),
            vec!["a, b", "c, d", "e"],
        );
    }

    #[test]
    fn backslash_escapes_delimiter() {
        assert_eq!(
            split_options("a\\,b,c"),
            vec!["a,b", "c"],
        );
    }

    #[test]
    fn nested_brackets() {
        assert_eq!(
            split_options("alpha [one, two], beta {x, y}, gamma"),
            vec!["alpha [one, two]", "beta {x, y}", "gamma"],
        );
    }

    #[test]
    fn whitespace_and_empties_dropped() {
        assert_eq!(
            split_options(" a , , b , "),
            vec!["a", "b"],
        );
    }
}
