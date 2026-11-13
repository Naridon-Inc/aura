//! The per-project plane: Aura talking to each project's own Aura.
//!
//! The orchestrator owns no project state. A project's board, Pages, intent
//! log, worktrees and git state live in that project, under its own `.aura/`
//! and its own checkout, and every tool here reads or writes them there — by
//! an explicit root, per call. Nothing is copied into the conversation's
//! session and nothing is cached on this side, so what Aura says about a
//! project and what that project's own screens show cannot drift apart.
//!
//! Two jobs live here:
//!
//!   * **Routing.** Which root a tool call runs against. A chat bound to one
//!     project keeps the old default — an omitted `project` means that one. A
//!     chat bound to several (Aura's own conversation, which is about every
//!     project) has no default: [`resolution_root`] hands the resolver an
//!     empty root, so an omitted `project` is an error that lists the
//!     projects, instead of a silent answer about whichever repo happened to
//!     be open in the window. Results are stamped with the project they came
//!     from ([`stamp_target`]) so the chat can show — and link — where each
//!     turn actually acted.
//!   * **Two tools the other planes don't have**: a status read for any
//!     project (branch, changes, board, recent intents), and making a new
//!     workspace in a named project.

use serde_json::{Value, json};

use super::control_plane::{Target, resolve_many, resolve_one};

/// The tool names this module owns.
pub const TOOL_NAMES: &[&str] = &["aura_project_status", "aura_workspace_create"];

/// How many changed paths and recent intents one status row carries. A
/// project mid-refactor can have hundreds of dirty files; the count is the
/// answer, the paths are a sample.
const MAX_CHANGED_PATHS: usize = 20;
const MAX_RECENT_INTENTS: usize = 5;

/// The line a non-JSON result is stamped with. Kept to one fixed prefix so
/// the chat's chip reader matches it exactly and nothing else.
pub const TARGET_MARKER: &str = "aura-target: ";

pub fn is_project_tool(name: &str) -> bool {
    TOOL_NAMES.contains(&name)
}

/// The root project resolution starts from.
///
/// A chat bound to more than one project resolves with NO default, so every
/// call has to say which project it means. One project (or none) keeps the
/// chat's own root as the default, which is what a workspace chat has always
/// meant by "this project".
pub fn resolution_root(repo_root: &str, bound_projects: usize) -> &str {
    if bound_projects > 1 { "" } else { repo_root }
}

/// The `project` property every project-store tool takes. One definition so
/// the board, the Pages, the atlas and the status read all describe it the
/// same way.
fn project_property() -> Value {
    json!({
        "type": "string",
        "description": "Which project to act on: its label, id, or absolute path (a worktree path is fine). \
                        Required when this conversation spans several projects; otherwise omit it for the \
                        project this chat is open on. Call aura_projects_list to see them."
    })
}

/// Add the `project` property to a tool schema that doesn't declare one.
/// Leaves a schema that already has it alone, so a tool can still describe
/// its own `project` more precisely.
pub fn with_project_arg(mut schema: Value) -> Value {
    if let Some(props) = schema
        .get_mut("input_schema")
        .and_then(|s| s.get_mut("properties"))
        .and_then(Value::as_object_mut)
    {
        props.entry("project").or_insert_with(project_property);
    }
    schema
}

/// The `target` value a result is stamped with.
fn target_value(t: &Target) -> Value {
    json!({ "project": t.label, "root": t.root })
}

/// Mark a tool result with the project it ran against.
///
/// A JSON object gains a `target` field (unless it already names one). Any
/// other text gets a single trailing [`TARGET_MARKER`] line, so a plain-text
/// answer reads the same to the model and still carries where it came from.
pub(super) fn stamp_target(text: String, t: &Target) -> String {
    if let Ok(Value::Object(mut map)) = serde_json::from_str::<Value>(&text) {
        if !map.contains_key("target") {
            map.insert("target".to_string(), target_value(t));
        }
        return Value::Object(map).to_string();
    }
    format!("{text}\n\n{TARGET_MARKER}{}", target_value(t))
}

/// The system-prompt paragraph for a conversation that spans several
/// projects. Without it the model reads the board tools' "this project" as
/// a project it can assume.
pub fn fleet_blurb(bound_projects: usize) -> String {
    format!(
        "\n\nTHIS CONVERSATION SPANS {bound_projects} PROJECTS, and none of them is the current one. \
Every project tool — the board, Pages, aura_atlas, aura_ask, aura_project_status, \
aura_workspace_create, aura_work_start — acts on the project you name in `project` and nowhere else. \
Name it on every call (label, id, or absolute path); a call without one is refused with the list of \
projects. Each project keeps its own board, Pages, intent log and rules — read them from that \
project rather than carrying one project's answer over to another. The list tools \
(aura_worktrees_list, aura_sessions_list, aura_prs_list, aura_project_status) still sweep every \
project when `project` is omitted, because that is an explicit \"all of them\", not a guess."
    )
}

pub fn tool_schemas() -> Vec<Value> {
    vec![
        json!({
            "name": "aura_project_status",
            "description": "Where a project stands, read from that project's own Aura: the branch it is on, \
                            its uncommitted changes, its Tasks board by status, and the last few intents \
                            agents logged there. Omit `project` to read every project at once.",
            "input_schema": {
                "type": "object",
                "properties": {
                    "project": {
                        "type": "string",
                        "description": "Project label, id, or absolute path. Omit to read every project."
                    }
                },
                "required": []
            }
        }),
        json!({
            "name": "aura_workspace_create",
            "description": "Make a new workspace in a project: a git worktree on a fresh branch, in the same \
                            managed folder the app's own New workspace uses, so it shows up beside the \
                            project's other workspaces. To put an agent to work there afterwards, call \
                            aura_work_start with `project` set to the path this returns.",
            "input_schema": {
                "type": "object",
                "properties": {
                    "project": project_property(),
                    "branch": {
                        "type": "string",
                        "description": "Name for the new branch, e.g. fix/login-redirect."
                    },
                    "from": {
                        "type": "string",
                        "description": "Where the branch starts: a branch, tag or commit. Omit for the project's current HEAD."
                    }
                },
                "required": ["branch"]
            }
        }),
    ]
}

pub async fn execute(repo_root: &str, name: &str, input: &Value) -> (String, bool) {
    match name {
        "aura_project_status" => tool_project_status(repo_root, input).await,
        "aura_workspace_create" => tool_workspace_create(repo_root, input).await,
        other => (format!("unknown project tool: {other}"), true),
    }
}

async fn tool_project_status(repo_root: &str, input: &Value) -> (String, bool) {
    let (targets, capped) = match resolve_many(repo_root, input) {
        Ok(v) => v,
        Err(e) => return (e, true),
    };
    let mut rows = Vec::with_capacity(targets.len());
    for t in &targets {
        rows.push(status_for(t).await);
    }
    let mut out = json!({ "projects": rows });
    if capped {
        out["note"] = json!(
            "Only the first projects were read; name one with `project` to read the rest."
        );
    }
    // One project named → stamp it, so the chat links the turn to it. A
    // sweep names each project on its own row instead.
    let text = out.to_string();
    match targets.as_slice() {
        [only] if input.get("project").is_some() => (stamp_target(text, only), false),
        _ => (text, false),
    }
}

/// One project's status, from that project's own stores. A store that can't
/// be read says so on its own field rather than failing the whole row — a
/// project with no board yet still has a branch worth reporting.
async fn status_for(t: &Target) -> Value {
    let branch = crate::cmd_files::git_branch(t.root.clone()).await;
    let changes = match crate::cmd_files::git_status(t.root.clone()).await {
        Ok(map) => {
            let mut paths: Vec<&String> = map.keys().collect();
            paths.sort();
            json!({
                "count": map.len(),
                "paths": paths.into_iter().take(MAX_CHANGED_PATHS).collect::<Vec<_>>(),
            })
        }
        Err(e) => json!({ "error": e }),
    };
    let board = match crate::cmd_tasks::tasks_list(t.root.clone()).await {
        Ok(tasks) => {
            let mut by_status = serde_json::Map::new();
            for task in &tasks {
                let key = if task.status.trim().is_empty() {
                    "unset".to_string()
                } else {
                    task.status.trim().to_ascii_lowercase()
                };
                let n = by_status.get(&key).and_then(Value::as_u64).unwrap_or(0);
                by_status.insert(key, json!(n + 1));
            }
            json!({ "total": tasks.len(), "by_status": by_status })
        }
        Err(e) => json!({ "error": e }),
    };
    let intents = match crate::cmd_aura_fs::aura_read_intent_log_v2(
        t.root.clone(),
        MAX_RECENT_INTENTS,
        None,
        None,
    )
    .await
    {
        Ok(page) => json!(
            page.entries
                .iter()
                .map(|e| json!({
                    "when": e.timestamp,
                    "agent": e.agent,
                    "intent": e.intent,
                    "branch": e.branch,
                }))
                .collect::<Vec<_>>()
        ),
        Err(e) => json!({ "error": e }),
    };
    json!({
        "project": t.label,
        "root": t.root,
        "branch": branch,
        "changes": changes,
        "board": board,
        "recent_intents": intents,
    })
}

async fn tool_workspace_create(repo_root: &str, input: &Value) -> (String, bool) {
    let target = match resolve_one(repo_root, input) {
        Ok(t) => t,
        Err(e) => return (e, true),
    };
    let Some(branch) = input
        .get("branch")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|s| !s.is_empty())
    else {
        return (
            "Name the new workspace's branch in `branch`, e.g. fix/login-redirect.".to_string(),
            true,
        );
    };
    let from = input
        .get("from")
        .and_then(Value::as_str)
        .map(str::trim)
        .unwrap_or("")
        .to_string();
    match crate::worktree::worktree_create_managed(target.root.clone(), branch.to_string(), from)
        .await
    {
        Ok(w) => {
            let out = json!({
                "created": true,
                "project": target.label,
                "workspace": {
                    "path": w.path,
                    "branch": w.branch,
                    "start_point": w.start_point,
                },
                "target": { "project": target.label, "root": target.root, "workspace": w.path },
                "next": "To start an agent there, call aura_work_start with `project` set to this workspace's path."
            });
            (out.to_string(), false)
        }
        Err(e) => (
            format!("couldn't make a workspace in {}: {e}", target.label),
            true,
        ),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn target(label: &str, root: &str) -> Target {
        Target {
            label: label.to_string(),
            root: root.to_string(),
        }
    }

    #[test]
    fn a_chat_bound_to_several_projects_has_no_default_root() {
        assert_eq!(resolution_root("/a", 0), "/a");
        assert_eq!(resolution_root("/a", 1), "/a");
        assert_eq!(resolution_root("/a", 2), "");
        assert_eq!(resolution_root("/a", 9), "");
    }

    #[test]
    fn fleet_scope_refuses_a_call_that_names_no_project() {
        // The resolver is the same one every plane uses; an empty root is what
        // turns "no project named" from "the open one" into a question back.
        let err = resolve_one(resolution_root("/a", 3), &json!({})).err().unwrap();
        assert!(err.contains("pass `project` explicitly"), "{err}");
        let err = resolve_one(resolution_root("/a", 3), &json!({ "project": "current" }))
            .err()
            .unwrap();
        assert!(err.contains("pass `project` explicitly"), "{err}");
    }

    #[test]
    fn fleet_scope_still_routes_an_explicit_path_to_that_project() {
        let t = resolve_one(resolution_root("/a", 3), &json!({ "project": "/work/other/" })).unwrap();
        assert_eq!(t.root, "/work/other");
    }

    #[test]
    fn a_single_project_chat_keeps_its_own_root_as_the_default() {
        let t = resolve_one(resolution_root("/work/mine", 1), &json!({})).unwrap();
        assert_eq!(t.root, "/work/mine");
    }

    #[test]
    fn stamping_a_json_object_adds_target_once() {
        let t = target("Mine", "/work/mine");
        let out: Value = serde_json::from_str(&stamp_target(r#"{"tasks":[]}"#.into(), &t)).unwrap();
        assert_eq!(out["target"]["project"], "Mine");
        assert_eq!(out["target"]["root"], "/work/mine");
        assert_eq!(out["tasks"], json!([]));

        let pre = r#"{"target":{"project":"Else","root":"/e"}}"#;
        let out: Value = serde_json::from_str(&stamp_target(pre.into(), &t)).unwrap();
        assert_eq!(out["target"]["root"], "/e", "a result that names its target keeps it");
    }

    #[test]
    fn stamping_plain_text_appends_one_marker_line() {
        let t = target("Mine", "/work/mine");
        let out = stamp_target("# Page\nbody".into(), &t);
        assert!(out.starts_with("# Page\nbody\n\n"));
        let line = out.lines().last().unwrap();
        let json_part = line.strip_prefix(TARGET_MARKER).unwrap();
        let v: Value = serde_json::from_str(json_part).unwrap();
        assert_eq!(v["root"], "/work/mine");
    }

    #[test]
    fn with_project_arg_adds_the_property_without_overwriting_one() {
        let s = with_project_arg(json!({
            "name": "x",
            "input_schema": { "type": "object", "properties": { "status": { "type": "string" } } }
        }));
        assert!(s["input_schema"]["properties"]["project"].is_object());
        assert!(s["input_schema"]["properties"]["status"].is_object());

        let own = json!({ "type": "string", "description": "mine" });
        let s = with_project_arg(json!({
            "name": "y",
            "input_schema": { "type": "object", "properties": { "project": own.clone() } }
        }));
        assert_eq!(s["input_schema"]["properties"]["project"], own);
    }

    #[test]
    fn every_project_tool_has_a_schema_and_routes() {
        let names: Vec<String> = tool_schemas()
            .iter()
            .filter_map(|s| s["name"].as_str().map(str::to_string))
            .collect();
        for n in TOOL_NAMES {
            assert!(names.iter().any(|x| x == n), "{n} has no schema");
            assert!(is_project_tool(n));
        }
        assert!(!is_project_tool("aura_tasks_list"));
    }

    use super::super::native_tools::{CHAT_AUTHOR, execute_board_tool};

    fn board_dir() -> tempfile::TempDir {
        let d = tempfile::tempdir().unwrap();
        std::fs::create_dir_all(d.path().join(".aura").join("tasks")).unwrap();
        d
    }

    #[tokio::test]
    async fn board_tools_act_on_the_named_projects_own_board() {
        let a = board_dir();
        let b = board_dir();
        let ra = a.path().to_str().unwrap();
        let rb = b.path().to_str().unwrap();

        // The chat is open on A; the call names B. The task lands on B's own
        // board, and the result says so.
        let (out, err, _) = execute_board_tool(
            ra,
            "aura_task_create",
            &json!({ "project": rb, "title": "Only in B" }),
            CHAT_AUTHOR,
        )
        .await;
        assert!(!err, "{out}");
        let v: Value = serde_json::from_str(&out).unwrap();
        assert_eq!(v["target"]["root"], json!(rb));

        let (on_b, err, _) =
            execute_board_tool(rb, "aura_tasks_list", &json!({}), CHAT_AUTHOR).await;
        assert!(!err, "{on_b}");
        assert!(on_b.contains("Only in B"), "{on_b}");
        let (on_a, err, _) =
            execute_board_tool(ra, "aura_tasks_list", &json!({}), CHAT_AUTHOR).await;
        assert!(!err, "{on_a}");
        assert!(!on_a.contains("Only in B"), "A's board must not see B's task: {on_a}");

        // Pages go to the named project too.
        let (out, err, _) = execute_board_tool(
            ra,
            "aura_page_write",
            &json!({ "project": rb, "scope": "team", "title": "B notes", "body": "lives in B" }),
            CHAT_AUTHOR,
        )
        .await;
        assert!(!err, "{out}");
        let (pages_b, _, _) =
            execute_board_tool(rb, "aura_pages_list", &json!({ "scope": "team" }), CHAT_AUTHOR).await;
        assert!(pages_b.contains("B notes"), "{pages_b}");
        let (pages_a, _, _) =
            execute_board_tool(ra, "aura_pages_list", &json!({ "scope": "team" }), CHAT_AUTHOR).await;
        assert!(!pages_a.contains("B notes"), "{pages_a}");
    }

    #[tokio::test]
    async fn fleet_scope_board_call_without_a_project_is_refused() {
        let (out, err, _) = execute_board_tool(
            resolution_root("/anywhere", 2),
            "aura_tasks_list",
            &json!({}),
            CHAT_AUTHOR,
        )
        .await;
        assert!(err);
        assert!(out.contains("pass `project` explicitly"), "{out}");
    }

    #[test]
    fn every_board_tool_schema_takes_a_project() {
        for s in super::super::native_tools::board_tool_schemas() {
            assert!(
                s["input_schema"]["properties"]["project"].is_object(),
                "{} has no `project`",
                s["name"]
            );
        }
    }

    #[tokio::test]
    async fn workspace_create_in_fleet_scope_needs_a_project() {
        let (msg, is_error) =
            execute(resolution_root("/a", 2), "aura_workspace_create", &json!({ "branch": "x" }))
                .await;
        assert!(is_error);
        assert!(msg.contains("pass `project` explicitly"), "{msg}");
    }

    #[tokio::test]
    async fn status_reads_the_named_project_from_its_own_store() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path().to_string_lossy().to_string();
        std::fs::create_dir_all(dir.path().join(".aura")).unwrap();
        std::fs::write(
            dir.path().join(".aura").join("intent_log.jsonl"),
            "{\"agent_id\":\"claude\",\"intent\":\"tightened the retry budget\",\"timestamp\":1785651321}\n",
        )
        .unwrap();
        let (text, is_error) = execute(
            resolution_root("/elsewhere", 2),
            "aura_project_status",
            &json!({ "project": root }),
        )
        .await;
        assert!(!is_error, "{text}");
        let v: Value = serde_json::from_str(&text).unwrap();
        assert_eq!(v["target"]["root"], json!(root));
        let row = &v["projects"][0];
        assert_eq!(row["root"], json!(root));
        assert_eq!(row["recent_intents"][0]["intent"], "tightened the retry budget");
        assert_eq!(row["recent_intents"][0]["agent"], "claude");
    }
}
