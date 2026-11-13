//! The acting member's own agent sign-in, for one run on a shared box.
//!
//! A box in the cloud belongs to the organization; the Claude, Codex or Cursor
//! account an agent runs on belongs to whoever the box is acting for. Before it
//! runs one board task, the runner asks the cloud — with its machine token,
//! `X-Aura-Acting-Member` and the task's id — what that member saved, and hands
//! it to the one `crew run` child working that task. Nothing is written to
//! disk, nothing is put in the runner's own environment, and the values are
//! never printed.
//!
//! The cloud answers only for a live task the member started, sent to this box
//! themselves, and this box has claimed, so naming a member is never enough on
//! its own (the shared box's token is readable by anyone with a shell on it).
//!
//! The answer also names the agent variables to remove from the child, so a
//! key the box's operator left in its own environment never stands in for the
//! member's.
//!
//! One sign-in is the exception to "nothing on disk": Codex on a ChatGPT plan
//! reads a file, not a variable, so that one is written into a Codex home of
//! the member's own (see [`crate::codex_member_home`]) before the run starts.

use std::collections::BTreeMap;
use std::path::Path;
use std::process::Command;

use crate::codex_member_home::{self, Seeded, CODEX_AUTH_JSON_VAR};
use crate::push_credential;

/// What the cloud answered for one run. Values live here for the length of a
/// drain and are dropped with it.
#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub struct AgentEnv {
    pub env: BTreeMap<String, String>,
    pub clear: Vec<String>,
    /// The saved credential that served the run, by name only.
    pub credential: Option<String>,
    pub manual: bool,
}

impl AgentEnv {
    /// Set this answer on `cmd`: the clears first, then the values. A Codex
    /// ChatGPT sign-in is never set as a variable, seeded or not.
    pub fn apply(&self, cmd: &mut Command) {
        for name in &self.clear {
            cmd.env_remove(name);
        }
        cmd.env_remove(CODEX_AUTH_JSON_VAR);
        cmd.envs(self.env.iter().filter(|(k, _)| k.as_str() != CODEX_AUTH_JSON_VAR));
    }

    /// A Codex ChatGPT sign-in comes as a value and Codex reads a file: write
    /// it into `member`'s own Codex home and point the run there instead.
    /// `None` when the answer carries no such sign-in.
    pub fn seed_codex_home(&mut self, member: &str) -> Result<Option<Seeded>, String> {
        if !self.env.contains_key(CODEX_AUTH_JSON_VAR) {
            return Ok(None);
        }
        let root = codex_member_home::homes_root()?;
        self.seed_codex_home_in(&root, member, codex_member_home::box_config().as_deref())
    }

    fn seed_codex_home_in(
        &mut self,
        root: &Path,
        member: &str,
        box_config: Option<&str>,
    ) -> Result<Option<Seeded>, String> {
        let Some(json) = self.env.remove(CODEX_AUTH_JSON_VAR) else {
            return Ok(None);
        };
        let (dir, seeded) = codex_member_home::seed(root, member, &json, box_config)?;
        self.env.insert("CODEX_HOME".into(), dir.to_string_lossy().into_owned());
        if !self.clear.iter().any(|c| c == CODEX_AUTH_JSON_VAR) {
            self.clear.push(CODEX_AUTH_JSON_VAR.into());
        }
        Ok(Some(seeded))
    }

    /// One line for the log: which sign-in, and how many variables. Never a
    /// value.
    pub fn describe(&self, harness: &str) -> String {
        if self.manual {
            return format!("{harness} runs on the member's own setup on this box");
        }
        match &self.credential {
            Some(name) => format!("{harness} runs on the member's {name} ({} variables)", self.env.len()),
            None => format!("the member has no {harness} sign-in saved; this box's agent keys are cleared"),
        }
    }
}

/// Why there is no answer to apply.
#[derive(Debug, PartialEq, Eq)]
pub enum NotApplied {
    /// The box is not acting for a member, or the agent is not one a member
    /// signs in to here. The run goes ahead exactly as before.
    NotNeeded,
    /// The cloud has no such route yet. The run goes ahead exactly as before.
    NotOffered,
    /// The task is not a live run of the member on this box yet: the box has
    /// not claimed it as itself, or it has finished. Claim, then ask again.
    NotLive(String),
    /// The cloud refused, or could not be reached. The run must not go ahead
    /// on the box's own keys in the member's name.
    Refused(String),
}


/// Which harness a crew agent name runs on, if a member signs in to it.
pub fn harness_of(agent: &str) -> Option<&'static str> {
    let a = agent.trim().to_ascii_lowercase();
    if a.starts_with("claude") {
        Some("claude")
    } else if a.starts_with("codex") {
        Some("codex")
    } else if a.starts_with("cursor") {
        Some("cursor")
    } else {
        None
    }
}

/// Read the cloud's answer. Every value must be a string; anything else is
/// refused rather than guessed at.
pub fn parse(body: &serde_json::Value) -> Result<AgentEnv, String> {
    let mut env = BTreeMap::new();
    if let Some(map) = body.get("env").and_then(|v| v.as_object()) {
        for (k, v) in map {
            let v = v.as_str().ok_or_else(|| format!("agent env {k} was not text"))?;
            env.insert(k.clone(), v.to_string());
        }
    }
    let clear = body
        .get("clear")
        .and_then(|v| v.as_array())
        .map(|a| a.iter().filter_map(|n| n.as_str().map(str::to_string)).collect())
        .unwrap_or_default();
    Ok(AgentEnv {
        env,
        clear,
        credential: body.get("credential").and_then(|v| v.as_str()).map(str::to_string),
        manual: body.get("manual").and_then(|v| v.as_bool()).unwrap_or(false),
    })
}

/// Ask the cloud what the acting member's `agent` runs on, for board task `task`.
pub fn fetch(agent: &str, task: &str) -> Result<AgentEnv, NotApplied> {
    let Some(member) = push_credential::acting_member() else {
        return Err(NotApplied::NotNeeded);
    };
    let Some(harness) = harness_of(agent) else {
        return Err(NotApplied::NotNeeded);
    };
    let (base, token) = push_credential::cloud_credentials().map_err(NotApplied::Refused)?;
    let client = crate::cloud_http_client();
    let place = push_credential::place_id(&client, &base, &token).map_err(NotApplied::Refused)?;

    let resp = request(&client, &base, &place, harness, task, &token, &member)
        .send()
        .map_err(|e| NotApplied::Refused(format!("asking the cloud for the member's sign-in: {e}")))?;
    let status = resp.status();
    let body: serde_json::Value = resp.json().unwrap_or(serde_json::Value::Null);
    answer_of(status, &body)
}

/// Ask the cloud for the acting member's `harness` sign-in for one chat turn:
/// the one-time lease their send minted for this place, in workspace
/// `workspace`. Spent by this call — a second ask for the same lease is
/// refused, which is the point.
pub fn fetch_chat(harness: &str, lease: &str, workspace: &str) -> Result<AgentEnv, NotApplied> {
    let Some(member) = push_credential::acting_member() else {
        return Err(NotApplied::NotNeeded);
    };
    let (base, token) = push_credential::cloud_credentials().map_err(NotApplied::Refused)?;
    let client = crate::cloud_http_client();
    let place = push_credential::place_id(&client, &base, &token).map_err(NotApplied::Refused)?;
    let resp = client
        .get(format!("{base}/api/v2/places/{place}/agent-env"))
        .query(&[("harness", harness), ("chat", lease), ("workspace", workspace)])
        .header("Authorization", format!("Bearer {token}"))
        .header(push_credential::ACTING_MEMBER_HEADER, &member)
        .send()
        .map_err(|e| NotApplied::Refused(format!("asking the cloud for the member's sign-in: {e}")))?;
    let status = resp.status();
    let body: serde_json::Value = resp.json().unwrap_or(serde_json::Value::Null);
    answer_of(status, &body)
}

/// The ask itself: which place, which agent, which task, and whose sign-in.
fn request(
    client: &reqwest::blocking::Client,
    base: &str,
    place: &str,
    harness: &str,
    task: &str,
    token: &str,
    member: &str,
) -> reqwest::blocking::RequestBuilder {
    client
        .get(format!("{base}/api/v2/places/{place}/agent-env"))
        .query(&[("harness", harness), ("task", task)])
        .header("Authorization", format!("Bearer {token}"))
        .header(push_credential::ACTING_MEMBER_HEADER, member)
}

/// What the cloud's reply means for the run.
fn answer_of(status: reqwest::StatusCode, body: &serde_json::Value) -> Result<AgentEnv, NotApplied> {
    if status.is_success() {
        return parse(body).map_err(NotApplied::Refused);
    }
    let reason = body.get("reason").and_then(|v| v.as_str());
    if status == reqwest::StatusCode::NOT_FOUND && reason.is_none() {
        return Err(NotApplied::NotOffered);
    }
    let detail = body.get("detail").and_then(|v| v.as_str()).unwrap_or("no detail given");
    if status == reqwest::StatusCode::FORBIDDEN && reason == Some("no_live_run") {
        return Err(NotApplied::NotLive(detail.to_string()));
    }
    Err(NotApplied::Refused(format!("{}: {detail}", reason.unwrap_or("refused"))))
}

/// Claim board task `task` as this box, acting for its member, when the member
/// sent it here: the act that makes it a live run on this box, which is what
/// the cloud checks before it hands out a sign-in. Idempotent: a task already
/// working here stays working.
///
/// A task the member sent to another box, or to none, is left alone. The cloud
/// would refuse its sign-in anyway (it needs `dispatch_place_id` to name this
/// box), and claiming it would only strand it as `working` on a box that then
/// skips it.
///
/// Only a machine token can do this. A human login on the box would claim the
/// task as that person's own laptop, which proves nothing about the box.
pub fn claim_if_sent_here(task: &str) -> Result<(), String> {
    let member = push_credential::acting_member().ok_or("this box is not acting for a member")?;
    let token = push_credential::runner_token().ok_or("this box has no runner token")?;
    let (base, _) = push_credential::cloud_credentials()?;
    let client = crate::cloud_http_client();
    let place = push_credential::place_id(&client, &base, &token)?;
    let url = format!("{base}/api/v2/a2a/tasks/{}", crate::a2a_safe_id(task));

    let row: serde_json::Value = client
        .get(&url)
        .header("Authorization", format!("Bearer {token}"))
        .header(push_credential::ACTING_MEMBER_HEADER, &member)
        .send()
        .map_err(|e| format!("reading the task: {e}"))?
        .json()
        .map_err(|e| format!("reading the task: {e}"))?;
    if !sent_here(&row, &place) {
        return Err("the member did not send this task to this computer".into());
    }

    let resp = client
        .patch(&url)
        .header("Authorization", format!("Bearer {token}"))
        .header(push_credential::ACTING_MEMBER_HEADER, &member)
        .json(&serde_json::json!({ "status": "working" }))
        .send()
        .map_err(|e| format!("claiming the task: {e}"))?;
    match resp.status() {
        s if s.is_success() => Ok(()),
        reqwest::StatusCode::CONFLICT => Err("another computer is running it".into()),
        s => Err(format!("the cloud would not let this box claim it ({s})")),
    }
}

/// True when the task row says its member sent it to `place`.
fn sent_here(row: &serde_json::Value, place: &str) -> bool {
    row.get("dispatch_place_id").and_then(|v| v.as_str()) == Some(place)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_ask_names_the_task_it_is_for() {
        let client = reqwest::blocking::Client::new();
        let req = request(&client, "https://cloud.test", "p-1", "claude", "task-9", "fake-token", "alice")
            .build()
            .unwrap();
        let url = req.url();
        assert_eq!(url.path(), "/api/v2/places/p-1/agent-env");
        let q: Vec<(String, String)> = url.query_pairs().map(|(k, v)| (k.into_owned(), v.into_owned())).collect();
        assert_eq!(q, vec![("harness".into(), "claude".into()), ("task".into(), "task-9".into())]);
        assert_eq!(req.headers()[push_credential::ACTING_MEMBER_HEADER], "alice");
    }

    #[test]
    fn only_work_sent_to_this_box_is_claimed() {
        let row = |sent: serde_json::Value| serde_json::json!({ "id": "t", "dispatch_place_id": sent });
        assert!(sent_here(&row(serde_json::json!("p-1")), "p-1"));
        assert!(!sent_here(&row(serde_json::json!("p-2")), "p-1"), "sent to another box");
        assert!(!sent_here(&row(serde_json::Value::Null), "p-1"), "sent to no box");
        assert!(!sent_here(&serde_json::json!({ "id": "t" }), "p-1"), "an older cloud says nothing");
    }

    #[test]
    fn a_task_that_is_not_live_yet_is_told_apart_from_a_refusal() {
        use reqwest::StatusCode as S;
        let refused = |reason: &str| serde_json::json!({ "reason": reason, "detail": "d" });
        assert_eq!(answer_of(S::FORBIDDEN, &refused("no_live_run")), Err(NotApplied::NotLive("d".into())));
        assert_eq!(
            answer_of(S::FORBIDDEN, &refused("no_cloud_grant")),
            Err(NotApplied::Refused("no_cloud_grant: d".into()))
        );
        assert_eq!(
            answer_of(S::BAD_REQUEST, &refused("task_required")),
            Err(NotApplied::Refused("task_required: d".into()))
        );
        assert_eq!(answer_of(S::NOT_FOUND, &serde_json::Value::Null), Err(NotApplied::NotOffered));
        let ok = serde_json::json!({ "env": { "ANTHROPIC_API_KEY": "fake" }, "clear": [], "credential": "anthropic_api_key" });
        assert_eq!(answer_of(S::OK, &ok).unwrap().credential.as_deref(), Some("anthropic_api_key"));
    }

    #[test]
    fn crew_agent_names_map_to_the_agent_a_member_signs_in_to() {
        assert_eq!(harness_of("claude"), Some("claude"));
        assert_eq!(harness_of("claude-code"), Some("claude"));
        assert_eq!(harness_of("Codex"), Some("codex"));
        assert_eq!(harness_of("cursor-agent"), Some("cursor"));
        assert_eq!(harness_of("gemini"), None);
        assert_eq!(harness_of("opencode"), None);
    }

    #[test]
    fn the_answer_clears_then_sets_only_on_the_child() {
        let answer = parse(&serde_json::json!({
            "harness": "claude",
            "env": { "ANTHROPIC_API_KEY": "fake-key", "APP_ENV": "dev" },
            "clear": ["CLAUDE_CODE_OAUTH_TOKEN", "AWS_REGION"],
            "credential": "anthropic_api_key",
            "manual": false,
            "ephemeral": true
        }))
        .unwrap();
        let mut cmd = Command::new("true");
        answer.apply(&mut cmd);
        let got: BTreeMap<String, Option<String>> = cmd
            .get_envs()
            .map(|(k, v)| (k.to_string_lossy().into_owned(), v.map(|v| v.to_string_lossy().into_owned())))
            .collect();
        assert_eq!(got["ANTHROPIC_API_KEY"].as_deref(), Some("fake-key"));
        assert_eq!(got["CLAUDE_CODE_OAUTH_TOKEN"], None);
        assert_eq!(got["AWS_REGION"], None);
        assert!(std::env::var("ANTHROPIC_API_KEY").map_or(true, |v| v != "fake-key"));
    }

    #[test]
    fn the_log_line_names_the_credential_never_its_value() {
        let answer = parse(&serde_json::json!({
            "env": { "OPENAI_API_KEY": "fake-secret", "CODEX_API_KEY": "fake-secret" },
            "clear": [],
            "credential": "codex_api_key"
        }))
        .unwrap();
        let line = answer.describe("codex");
        assert!(line.contains("codex_api_key"));
        assert!(!line.contains("fake-secret"));
    }

    #[test]
    fn a_chatgpt_sign_in_reaches_codex_as_a_file_never_a_variable() {
        let root = tempfile::tempdir().unwrap();
        let mut answer = parse(&serde_json::json!({
            "env": { CODEX_AUTH_JSON_VAR: r#"{"tokens":{"refresh_token":"fake-r"}}"#, "APP_ENV": "dev" },
            "clear": ["OPENAI_API_KEY", "CODEX_API_KEY"],
            "credential": "codex_chatgpt_auth"
        }))
        .unwrap();
        let seeded = answer.seed_codex_home_in(root.path(), "member-1", None).unwrap();
        assert_eq!(seeded, Some(Seeded::Written));
        let home = std::path::PathBuf::from(&answer.env["CODEX_HOME"]);
        assert!(home.starts_with(root.path()));
        assert!(std::fs::read_to_string(home.join("auth.json")).unwrap().contains("fake-r"));

        let mut cmd = Command::new("true");
        answer.apply(&mut cmd);
        let got: BTreeMap<String, Option<String>> = cmd
            .get_envs()
            .map(|(k, v)| (k.to_string_lossy().into_owned(), v.map(|v| v.to_string_lossy().into_owned())))
            .collect();
        assert_eq!(got[CODEX_AUTH_JSON_VAR], None, "removed from the child");
        assert_eq!(got["CODEX_HOME"].as_deref(), Some(home.to_str().unwrap()));
        assert_eq!(got["OPENAI_API_KEY"], None);
        assert!(got.values().flatten().all(|v| !v.contains("fake-r")));
        assert!(!answer.describe("codex").contains("fake-r"));
    }

    #[test]
    fn an_unseeded_chatgpt_sign_in_is_still_never_set_on_the_child() {
        let answer = parse(&serde_json::json!({ "env": { CODEX_AUTH_JSON_VAR: "{}" }, "clear": [] })).unwrap();
        let mut cmd = Command::new("true");
        answer.apply(&mut cmd);
        let v = cmd.get_envs().find(|(k, _)| *k == CODEX_AUTH_JSON_VAR).map(|(_, v)| v.map(|v| v.to_owned()));
        assert_eq!(v, Some(None));
    }

    #[test]
    fn an_answer_without_a_chatgpt_sign_in_touches_no_disk() {
        let mut answer = parse(&serde_json::json!({ "env": { "OPENAI_API_KEY": "fake" }, "clear": [] })).unwrap();
        assert_eq!(answer.seed_codex_home("member-1").unwrap(), None);
        assert!(!answer.env.contains_key("CODEX_HOME"));
    }

    #[test]
    fn a_value_that_is_not_text_is_refused() {
        assert!(parse(&serde_json::json!({ "env": { "X": 1 } })).is_err());
    }
}
