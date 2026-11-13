//! MCP tools for review comments on the diff — `aura_review_comment_add` and
//! `aura_review_comments_list`.
//!
//! An agent reviewing a change leaves comments on lines of it, the way a
//! reviewer would; the Aura app shows them in the Changes view under the lines
//! they name, marked with the agent's name, and the user can send any of them
//! back to the agent in chat. The agent can also read the comments the user
//! wrote there.
//!
//! The two sides never talk directly. Each workspace (checkout root) gets a
//! folder under `~/.aura/review-comments/<key>/`, `<key>` being the FNV-1a 64
//! hash of the root path (the app computes the same one):
//!
//! - `agent.jsonl` — what agents posted, one comment per line, appended. Only
//!   this server writes it, and only by appending whole lines, so two agents
//!   in one checkout never lose each other's comments.
//! - `app.json` — the app's copy of every comment it shows for the workspace,
//!   with its state. Only the app writes it; this server only reads it.
//!
//! Nothing here touches the repository: the comments are this machine's.

use std::fs::{self, OpenOptions};
use std::io::Write;
use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};

use serde_json::{json, Value};

/// Most comments one call may post. A review that finds more than this is
/// better split by file.
const MAX_PER_CALL: usize = 50;
/// Longest body kept, in characters.
const MAX_BODY_CHARS: usize = 20_000;
/// Once the agents' file passes this size, the oldest lines are dropped.
const MAX_AGENT_FILE_BYTES: u64 = 1_000_000;
/// How many of the newest lines survive that trim.
const KEEP_AFTER_TRIM: usize = 500;

/// The tool-list entries, in the shape `tools/list` returns.
pub fn tool_definitions() -> Vec<Value> {
    vec![
        json!({
            "name": "aura_review_comment_add",
            "description": "Leave review comments on lines of the current diff, the way a reviewer would. They show in the Aura app's Changes view under the lines they name, marked with your name, and the user can send any of them back to you in chat. Post ONE comment per distinct issue and keep each range as short as possible (a few lines). Put concrete replacement code in a ```suggestion block, keeping the replaced lines' exact leading whitespace. Paths are relative to the repository root. Use this instead of listing findings only in your reply when you review a change.",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "comments": {
                        "type": "array",
                        "description": "The comments to leave.",
                        "items": {
                            "type": "object",
                            "properties": {
                                "file": { "type": "string", "description": "Path of the changed file, relative to the repository root." },
                                "line": { "type": "integer", "minimum": 1, "description": "First line the comment is about, 1-based, in the version named by `side`." },
                                "end_line": { "type": "integer", "minimum": 1, "description": "Last line, when the comment covers more than one." },
                                "side": { "type": "string", "enum": ["new", "old"], "description": "\"new\" (default): lines of the changed file. \"old\": lines that were removed." },
                                "body": { "type": "string", "description": "The comment, in markdown." }
                            },
                            "required": ["file", "line", "body"]
                        }
                    },
                    "author": { "type": "string", "description": "Your model name, shown on each comment (e.g. claude-sonnet-4-6). Defaults to the agent's name." }
                },
                "required": ["comments"]
            },
            "annotations": {
                "title": "Leave Review Comments",
                "readOnlyHint": false, "destructiveHint": false, "idempotentHint": false, "openWorldHint": false,
                "auraCapability": "auto"
            }
        }),
        json!({
            "name": "aura_review_comments_list",
            "description": "Read the review comments on the current diff: the ones the user wrote in the Aura app's Changes view and the ones agents left, each with its file and lines. Use it when the user asks you to address or read the comments on the diff. Pass `file` for one file, or nothing for every file. Comments already sent to you in chat are left out unless `include_reviewed` is true. Reading does not resolve or change them.",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "file": { "type": "string", "description": "Only this file's comments (path relative to the repository root)." },
                    "include_reviewed": { "type": "boolean", "description": "Also return comments already sent to the agent in chat." }
                }
            },
            "annotations": {
                "title": "Read Review Comments",
                "readOnlyHint": true, "destructiveHint": false, "idempotentHint": true, "openWorldHint": false,
                "auraCapability": "auto"
            }
        }),
    ]
}

/// Route one `aura_review_comment*` call. `agent` is the connecting client's
/// agent id, the author when the call names none.
pub fn call(name: &str, args: Value, agent: &str) -> Value {
    let Some(home) = std::env::var_os("HOME").map(PathBuf::from) else {
        return err("HOME is not set, so there is nowhere to keep review comments.");
    };
    let cwd = match std::env::current_dir() {
        Ok(c) => c,
        Err(e) => return err(&format!("Cannot read the working directory: {e}")),
    };
    let root = workspace_root(&cwd);
    let dir = comments_dir(&home, &root);
    let result = match name {
        "aura_review_comment_add" => add(&dir, &root, &args, agent, now_ms()),
        "aura_review_comments_list" => list(&dir, &root, &args),
        _ => Err("Unknown tool".to_string()),
    };
    match result {
        Ok(v) => ok(&v),
        Err(e) => err(&e),
    }
}

/// The checkout the agent is working in: the repository's work tree holding
/// `cwd`, or `cwd` itself outside one. No trailing slash, as the app keys it.
pub fn workspace_root(cwd: &Path) -> String {
    let root = git2::Repository::discover(cwd)
        .ok()
        .and_then(|r| r.workdir().map(Path::to_path_buf))
        .unwrap_or_else(|| cwd.to_path_buf());
    let s = root.to_string_lossy().into_owned();
    let trimmed = s.trim_end_matches('/');
    if trimmed.is_empty() { "/".to_string() } else { trimmed.to_string() }
}

/// FNV-1a, 64-bit, over the path's UTF-8 bytes, as 16 hex digits. The app's
/// `workspaceKey` is the same function.
pub fn workspace_key(root: &str) -> String {
    let mut h: u64 = 0xcbf2_9ce4_8422_2325;
    for b in root.as_bytes() {
        h ^= u64::from(*b);
        h = h.wrapping_mul(0x0000_0100_0000_01b3);
    }
    format!("{h:016x}")
}

pub fn comments_dir(home: &Path, root: &str) -> PathBuf {
    home.join(".aura").join("review-comments").join(workspace_key(root))
}

fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

/// A path the diff keys comments by: relative to the root. An absolute path
/// inside the root is made relative; one outside it is refused.
fn relative_file(root: &str, file: &str) -> Result<String, String> {
    let f = file.trim();
    if f.is_empty() {
        return Err("A comment needs a `file`.".into());
    }
    if let Some(rest) = f.strip_prefix(&format!("{root}/")) {
        return Ok(rest.to_string());
    }
    if f.starts_with('/') {
        return Err(format!("`{f}` is outside the repository at {root}."));
    }
    Ok(f.trim_start_matches("./").to_string())
}

fn line_arg(v: &Value, key: &str, at: usize) -> Result<Option<u64>, String> {
    match v.get(key) {
        None | Some(Value::Null) => Ok(None),
        Some(n) => match n.as_u64() {
            Some(x) if x >= 1 => Ok(Some(x)),
            _ => Err(format!("Comment {}: `{key}` must be a line number of 1 or more.", at + 1)),
        },
    }
}

/// Check every comment, then append them all; nothing is written when any
/// one of them is wrong.
fn add(dir: &Path, root: &str, args: &Value, agent: &str, now: u64) -> Result<Value, String> {
    let Some(items) = args.get("comments").and_then(Value::as_array) else {
        return Err("Pass `comments`: a list of {file, line, body}.".into());
    };
    if items.is_empty() {
        return Err("`comments` is empty.".into());
    }
    if items.len() > MAX_PER_CALL {
        return Err(format!("At most {MAX_PER_CALL} comments per call; split the rest by file."));
    }
    let author = args
        .get("author")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(str::to_string)
        .unwrap_or_else(|| agent_label(agent));
    let request = format!("a{:x}{:04x}", now, rand::random::<u16>());

    let mut lines = Vec::with_capacity(items.len());
    let mut ids = Vec::with_capacity(items.len());
    for (i, c) in items.iter().enumerate() {
        let file = relative_file(root, c.get("file").and_then(Value::as_str).unwrap_or(""))
            .map_err(|e| format!("Comment {}: {e}", i + 1))?;
        let line = line_arg(c, "line", i)?
            .ok_or_else(|| format!("Comment {}: needs a `line`.", i + 1))?;
        let end = line_arg(c, "end_line", i)?;
        if let Some(e) = end {
            if e < line {
                return Err(format!("Comment {}: `end_line` is before `line`.", i + 1));
            }
        }
        let side = match c.get("side").and_then(Value::as_str).unwrap_or("new") {
            "new" => "new",
            "old" => "old",
            other => return Err(format!("Comment {}: `side` is \"new\" or \"old\", not \"{other}\".", i + 1)),
        };
        let body = c.get("body").and_then(Value::as_str).unwrap_or("").trim_end();
        if body.trim().is_empty() {
            return Err(format!("Comment {}: needs a `body`.", i + 1));
        }
        let body: String = body.chars().take(MAX_BODY_CHARS).collect();
        let id = format!("{request}-{i}");
        let mut row = json!({
            "id": id,
            "workspace": root,
            "file": file,
            "line": line,
            "side": side,
            "body": body,
            "author": author,
            "created_at": now,
        });
        if let Some(e) = end.filter(|e| *e != line) {
            row["end_line"] = json!(e);
        }
        lines.push(row.to_string());
        ids.push(id);
    }

    fs::create_dir_all(dir).map_err(|e| format!("Cannot create {}: {e}", dir.display()))?;
    let path = dir.join("agent.jsonl");
    trim_if_large(&path);
    let mut out = OpenOptions::new()
        .create(true)
        .append(true)
        .open(&path)
        .map_err(|e| format!("Cannot open {}: {e}", path.display()))?;
    // One write for the whole batch, so a reader never sees half of it.
    let mut buf = lines.join("\n");
    buf.push('\n');
    out.write_all(buf.as_bytes())
        .map_err(|e| format!("Cannot write {}: {e}", path.display()))?;

    Ok(json!({
        "posted": ids.len(),
        "ids": ids,
        "author": author,
        "workspace": root,
        "note": "The comments show in the Aura app's Changes view under their lines.",
    }))
}

/// Keep the newest lines once the file grows past its cap.
fn trim_if_large(path: &Path) {
    let Ok(meta) = fs::metadata(path) else { return };
    if meta.len() <= MAX_AGENT_FILE_BYTES {
        return;
    }
    let Ok(text) = fs::read_to_string(path) else { return };
    let all: Vec<&str> = text.lines().filter(|l| !l.trim().is_empty()).collect();
    let keep = &all[all.len().saturating_sub(KEEP_AFTER_TRIM)..];
    let tmp = path.with_extension("jsonl.tmp");
    let mut body = keep.join("\n");
    body.push('\n');
    if fs::write(&tmp, body).is_ok() {
        let _ = fs::rename(&tmp, path);
    }
}

/// The name shown on a comment when the agent gave none.
fn agent_label(agent: &str) -> String {
    match agent {
        "claude" => "Claude Code".into(),
        "codex" => "Codex".into(),
        "gemini" => "Gemini CLI".into(),
        "cursor" => "Cursor".into(),
        "" | "MCP Agent" => "Agent".into(),
        other => other.into(),
    }
}

/// One comment as the list tool hands it back.
fn shaped(c: &Value, state: &str) -> Value {
    let mut out = json!({
        "id": c["id"],
        "file": c["file"],
        "line": c["line"],
        "side": c.get("side").cloned().unwrap_or(json!("new")),
        "body": c["body"],
        "author": c.get("author").cloned().filter(|a| !a.is_null()).unwrap_or(json!("user")),
        "state": state,
    });
    if let Some(e) = c.get("end_line").filter(|e| !e.is_null()) {
        out["end_line"] = e.clone();
    }
    out
}

fn list(dir: &Path, root: &str, args: &Value) -> Result<Value, String> {
    let file = match args.get("file").and_then(Value::as_str) {
        Some(f) if !f.trim().is_empty() => Some(relative_file(root, f)?),
        _ => None,
    };
    let include_reviewed = args.get("include_reviewed").and_then(Value::as_bool).unwrap_or(false);

    // The app's copy is the truth for every comment it has seen.
    let mut seen = std::collections::HashSet::new();
    let mut out = Vec::new();
    if let Ok(text) = fs::read_to_string(dir.join("app.json")) {
        let app: Value = serde_json::from_str(&text).unwrap_or(Value::Null);
        if app.get("workspace").and_then(Value::as_str) == Some(root) {
            for c in app.get("comments").and_then(Value::as_array).into_iter().flatten() {
                let Some(id) = c.get("id").and_then(Value::as_str) else { continue };
                seen.insert(id.to_string());
                let state = c.get("state").and_then(Value::as_str).unwrap_or("ready_for_review");
                if state == "draft" || (state == "reviewed" && !include_reviewed) {
                    continue;
                }
                out.push(shaped(c, state));
            }
        }
    }
    // Agents' comments the app has not picked up yet are still waiting.
    if let Ok(text) = fs::read_to_string(dir.join("agent.jsonl")) {
        for line in text.lines() {
            let Ok(c) = serde_json::from_str::<Value>(line) else { continue };
            let Some(id) = c.get("id").and_then(Value::as_str) else { continue };
            if c.get("workspace").and_then(Value::as_str) != Some(root) || !seen.insert(id.to_string()) {
                continue;
            }
            out.push(shaped(&c, "pending"));
        }
    }
    if let Some(f) = &file {
        out.retain(|c| c["file"].as_str() == Some(f.as_str()));
    }
    Ok(json!({
        "workspace": root,
        "file": file,
        "count": out.len(),
        "comments": out,
    }))
}

fn ok(v: &Value) -> Value {
    let body = serde_json::to_string_pretty(v).unwrap_or_else(|_| "null".into());
    json!({ "content": [{ "type": "text", "text": body }] })
}

fn err(msg: &str) -> Value {
    json!({ "isError": true, "content": [{ "type": "text", "text": msg }] })
}

#[cfg(test)]
mod tests {
    use super::*;

    const ROOT: &str = "/repo/a";

    fn read_lines(dir: &Path) -> Vec<Value> {
        fs::read_to_string(dir.join("agent.jsonl"))
            .unwrap_or_default()
            .lines()
            .map(|l| serde_json::from_str(l).unwrap())
            .collect()
    }

    #[test]
    fn the_key_is_the_one_the_app_computes() {
        assert_eq!(workspace_key("/repo/a"), "564ecae661f01822");
        assert_eq!(workspace_key("/Users/me/Ünï code"), "8ce2db74dd47c88c");
        assert_eq!(workspace_key(""), "cbf29ce484222325");
    }

    #[test]
    fn posting_appends_every_comment_with_its_author() {
        let tmp = tempfile::tempdir().unwrap();
        let dir = tmp.path().join("k");
        let args = json!({ "comments": [
            { "file": "src/x.ts", "line": 4, "body": "Check the bounds." },
            { "file": "/repo/a/src/y.ts", "line": 2, "end_line": 6, "side": "old", "body": "Dead code." }
        ]});
        let r = add(&dir, ROOT, &args, "claude", 1_000).unwrap();
        assert_eq!(r["posted"], 2);
        assert_eq!(r["author"], "Claude Code");
        let rows = read_lines(&dir);
        assert_eq!(rows.len(), 2);
        assert_eq!(rows[0]["file"], "src/x.ts");
        assert_eq!(rows[0]["side"], "new");
        assert!(rows[0].get("end_line").is_none());
        assert_eq!(rows[1]["file"], "src/y.ts");
        assert_eq!(rows[1]["end_line"], 6);
        assert_eq!(rows[1]["side"], "old");
        assert_eq!(rows[0]["workspace"], ROOT);
        assert_eq!(rows[0]["created_at"], 1_000);
        let id0 = rows[0]["id"].as_str().unwrap();
        let id1 = rows[1]["id"].as_str().unwrap();
        assert!(id0.ends_with("-0") && id1.ends_with("-1"));
        assert_eq!(id0.trim_end_matches("-0"), id1.trim_end_matches("-1"));

        add(&dir, ROOT, &json!({ "comments": [{ "file": "z", "line": 1, "body": "b" }], "author": "claude-sonnet-4-6" }), "claude", 2_000).unwrap();
        let rows = read_lines(&dir);
        assert_eq!(rows.len(), 3);
        assert_eq!(rows[2]["author"], "claude-sonnet-4-6");
    }

    #[test]
    fn one_bad_comment_writes_nothing() {
        let tmp = tempfile::tempdir().unwrap();
        let dir = tmp.path().join("k");
        let bad = [
            json!({ "comments": [] }),
            json!({ "comments": [{ "file": "a", "line": 1, "body": "ok" }, { "file": "a", "line": 0, "body": "x" }] }),
            json!({ "comments": [{ "file": "a", "line": 5, "end_line": 2, "body": "x" }] }),
            json!({ "comments": [{ "file": "a", "line": 1, "body": "   " }] }),
            json!({ "comments": [{ "file": "a", "line": 1, "side": "left", "body": "x" }] }),
            json!({ "comments": [{ "file": "/elsewhere/a", "line": 1, "body": "x" }] }),
            json!({ "comments": [{ "line": 1, "body": "x" }] }),
            json!({}),
        ];
        for a in bad {
            assert!(add(&dir, ROOT, &a, "codex", 1).is_err(), "{a}");
        }
        assert!(!dir.join("agent.jsonl").exists());
    }

    #[test]
    fn the_author_falls_back_to_the_agent() {
        assert_eq!(agent_label("codex"), "Codex");
        assert_eq!(agent_label("MCP Agent"), "Agent");
        assert_eq!(agent_label("opencode"), "opencode");
    }

    #[test]
    fn reading_merges_the_apps_copy_over_what_agents_posted() {
        let tmp = tempfile::tempdir().unwrap();
        let dir = tmp.path().join("k");
        let r = add(&dir, ROOT, &json!({ "comments": [
            { "file": "src/x.ts", "line": 4, "body": "first" },
            { "file": "src/y.ts", "line": 8, "body": "second" }
        ]}), "claude", 1).unwrap();
        let first = r["ids"][0].as_str().unwrap().to_string();

        // Before the app has seen them, both are waiting.
        let all = list(&dir, ROOT, &json!({})).unwrap();
        assert_eq!(all["count"], 2);
        assert_eq!(all["comments"][0]["state"], "pending");

        // The app sent the first back in chat and has one of the user's own.
        fs::write(dir.join("app.json"), json!({ "workspace": ROOT, "comments": [
            { "id": first, "file": "src/x.ts", "line": 4, "side": "new", "body": "first", "author": "Claude Code", "state": "reviewed" },
            { "id": "cuser1", "file": "src/x.ts", "line": 10, "end_line": 12, "side": "new", "body": "rename this", "state": "ready_for_review" },
            { "id": "cdraft", "file": "src/x.ts", "line": 1, "side": "new", "body": "", "state": "draft" }
        ]}).to_string()).unwrap();
        let open = list(&dir, ROOT, &json!({})).unwrap();
        let ids: Vec<&str> = open["comments"].as_array().unwrap().iter().map(|c| c["id"].as_str().unwrap()).collect();
        assert_eq!(ids.len(), 2);
        assert!(ids.contains(&"cuser1"));
        assert!(!ids.contains(&first.as_str()));
        let user = open["comments"].as_array().unwrap().iter().find(|c| c["id"] == "cuser1").unwrap();
        assert_eq!(user["author"], "user");
        assert_eq!(user["end_line"], 12);

        let with = list(&dir, ROOT, &json!({ "include_reviewed": true })).unwrap();
        assert_eq!(with["count"], 3);

        let one = list(&dir, ROOT, &json!({ "file": "src/y.ts" })).unwrap();
        assert_eq!(one["count"], 1);
        assert_eq!(one["comments"][0]["body"], "second");
    }

    #[test]
    fn another_checkouts_copy_is_not_read() {
        let tmp = tempfile::tempdir().unwrap();
        let dir = tmp.path().join("k");
        fs::create_dir_all(&dir).unwrap();
        fs::write(dir.join("app.json"), json!({ "workspace": "/repo/b", "comments": [
            { "id": "x", "file": "f", "line": 1, "body": "b", "state": "ready_for_review" }
        ]}).to_string()).unwrap();
        assert_eq!(list(&dir, ROOT, &json!({})).unwrap()["count"], 0);
    }

    #[test]
    fn a_large_file_keeps_its_newest_lines() {
        let tmp = tempfile::tempdir().unwrap();
        let path = tmp.path().join("agent.jsonl");
        let line = format!("{}\n", "x".repeat(2_000));
        fs::write(&path, line.repeat(600)).unwrap();
        trim_if_large(&path);
        let left = fs::read_to_string(&path).unwrap();
        assert_eq!(left.lines().count(), KEEP_AFTER_TRIM);
    }

    #[test]
    fn the_root_is_the_checkout_holding_the_folder() {
        let tmp = tempfile::tempdir().unwrap();
        let repo = git2::Repository::init(tmp.path()).unwrap();
        let sub = tmp.path().join("src");
        fs::create_dir_all(&sub).unwrap();
        let want = repo.workdir().unwrap().to_string_lossy().trim_end_matches('/').to_string();
        assert_eq!(workspace_root(&sub), want);
        assert!(!workspace_root(&sub).ends_with('/'));
    }
}
