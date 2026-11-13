//! The chats this machine answers by itself.
//!
//! A cloud workspace linked with `driver: "box"` is answered here, not by
//! somebody's laptop. Beside the crew drain, `aura runner serve` keeps one
//! thread asking the cloud which prompts on this machine's workspaces nobody
//! has answered (`GET /places/{place}/chats`), and starts one
//! `aura runner chat-turn` per prompt (see [`crate::runner_chat_turn`]).
//!
//! The turn is a child process for one reason: the member it acts for. A
//! clone, a push and the agent's sign-in are all spent as the member whose
//! sign-in the prompt runs on — whoever started the workspace, which is not
//! always who typed it ([`Prompt::runs_as`]) — and the code that does that
//! reads who that is from the environment
//! ([`push_credential::ACTING_MEMBER_ENV`]). A child is told at birth and can
//! never act for anybody else; the long-running parent never changes its own
//! environment, so two members' turns cannot bleed into one another.
//!
//! One turn per project at a time. Workspaces of one project share a clone,
//! and the commit identity lives in its config, so two members' turns there at
//! once could sign each other's commits.
//!
//! Every so often the same thread also asks which of the workspaces it holds a
//! copy of were archived, and removes those copies ([`crate::runner_chat_sweep`]),
//! so a busy machine's disk doesn't fill with work nobody will open again.

use std::collections::{HashMap, HashSet};
use std::io::Write;
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::time::{Duration, Instant};

use colored::Colorize;
use serde::{Deserialize, Serialize};

use crate::push_credential;

/// How often the machine asks for new prompts.
const POLL: Duration = Duration::from_secs(5);
/// The longest one turn may run before the machine stops it and says so. The
/// turn's own limit on the agent is shorter ([`crate::runner_chat_turn`]), so
/// this only fires when the turn itself is stuck.
const TURN_LIMIT: Duration = Duration::from_secs(55 * 60);
/// How many prompts a run of the machine remembers having tried, so one whose
/// answer the cloud refuses is not retried every five seconds forever.
const TRIED_CAP: usize = 2_000;

#[derive(Debug, Clone, Deserialize, Serialize, PartialEq, Eq)]
pub struct Prompt {
    pub message_id: String,
    pub text: String,
    pub author_id: String,
    #[serde(default)]
    pub author_login: Option<String>,
    #[serde(default)]
    pub author_name: Option<String>,
    /// The member whose sign-in this prompt runs on: whoever started the
    /// workspace. A teammate's prompt keeps its author and runs as the
    /// starter. A cloud from before this field sends none, and the prompt runs
    /// as its author, as it always did.
    #[serde(default)]
    pub runs_as: Option<String>,
    #[serde(default)]
    pub lease: Option<String>,
    #[serde(default)]
    pub refused: Option<String>,
    /// The model the sender picked, when they picked one. A cloud from before
    /// this field sends none, and the agent runs on its own default.
    #[serde(default)]
    pub model: Option<String>,
}

impl Prompt {
    /// Who this machine acts as for the prompt: the member the cloud named in
    /// [`Prompt::runs_as`], else its author.
    pub fn runs_as(&self) -> &str {
        self.runs_as.as_deref().map(str::trim).filter(|m| !m.is_empty()).unwrap_or(self.author_id.as_str())
    }

    /// Whether the prompt runs on somebody else's sign-in than its author's.
    pub fn on_starter_s_sign_in(&self) -> bool {
        self.runs_as() != self.author_id
    }
}

#[derive(Debug, Clone, Deserialize, Serialize, PartialEq, Eq)]
pub struct Chat {
    pub workspace: String,
    pub workspace_id: String,
    pub repo: String,
    pub default_branch: String,
    #[serde(default)]
    pub branch: Option<String>,
    pub engine: String,
    #[serde(default)]
    pub agent_session_id: Option<String>,
    pub prompt: Prompt,
}

#[derive(Debug, Deserialize)]
struct Pending {
    #[serde(default)]
    chats: Vec<Chat>,
}

/// Where a turn's work is on this machine, told to the cloud with its answer
/// so the workspace shows the branch and folder it really has.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct At {
    pub branch: Option<String>,
    pub folder: Option<String>,
}

/// Where the machine speaks to the cloud from.
pub struct Cloud {
    pub client: reqwest::blocking::Client,
    pub base: String,
    pub token: String,
    pub place: String,
}

impl Cloud {
    /// The machine's own credential and place. Only a machine token: a chat is
    /// answered by a place, and a person's login on the box is not one.
    pub fn connect() -> Result<Cloud, String> {
        if push_credential::runner_token().is_none() {
            return Err("this computer has no runner token, so it is not a place that answers chats".into());
        }
        let (base, token) = push_credential::cloud_credentials()?;
        let client = crate::cloud_http_client();
        let place = push_credential::place_id(&client, &base, &token)?;
        Ok(Cloud { client, base, token, place })
    }

    fn pending(&self) -> Result<Vec<Chat>, String> {
        let url = format!("{}/api/v2/places/{}/chats", self.base, self.place);
        let resp = self
            .client
            .get(&url)
            .header("Authorization", format!("Bearer {}", self.token))
            .send()
            .map_err(|e| format!("asking for waiting prompts: {e}"))?;
        let status = resp.status();
        if status == reqwest::StatusCode::NOT_FOUND {
            return Err("the cloud does not hand chats to machines yet".into());
        }
        let body: serde_json::Value = resp.json().unwrap_or(serde_json::Value::Null);
        if !status.is_success() {
            return Err(format!("asking for waiting prompts: {status} {}", error_of(&body)));
        }
        serde_json::from_value::<Pending>(body)
            .map(|p| p.chats)
            .map_err(|e| format!("reading waiting prompts: {e}"))
    }

    /// Post the answer to `chat`'s prompt, acting for the member whose
    /// sign-in it ran on.
    /// A resend of the same answer is one row on the cloud.
    pub fn answer(
        &self,
        chat: &Chat,
        text: &str,
        agent_session_id: Option<&str>,
        failed: bool,
        at: &At,
    ) -> Result<(), String> {
        let url = format!("{}/api/v2/places/{}/chats/{}/answers", self.base, self.place, chat.workspace);
        let resp = self
            .client
            .post(&url)
            .header("Authorization", format!("Bearer {}", self.token))
            .header(push_credential::ACTING_MEMBER_HEADER, chat.prompt.runs_as())
            .json(&answer_body(chat, text, agent_session_id, failed, at))
            .send()
            .map_err(|e| format!("posting the answer: {e}"))?;
        let status = resp.status();
        if status.is_success() {
            return Ok(());
        }
        let body: serde_json::Value = resp.json().unwrap_or(serde_json::Value::Null);
        Err(format!("posting the answer: {status} {}", error_of(&body)))
    }

    /// Which of `held` — names of workspace copies on this machine — the
    /// cloud says are archived. Only ever a subset of what was asked about.
    pub fn archived(&self, held: &[String]) -> Result<Vec<String>, String> {
        #[derive(Deserialize)]
        struct Archived {
            #[serde(default)]
            archived: Vec<String>,
        }
        let url = format!("{}/api/v2/places/{}/chats/archived", self.base, self.place);
        let resp = self
            .client
            .post(&url)
            .header("Authorization", format!("Bearer {}", self.token))
            .json(&serde_json::json!({ "held": held }))
            .send()
            .map_err(|e| format!("asking which workspaces were archived: {e}"))?;
        let status = resp.status();
        if status == reqwest::StatusCode::NOT_FOUND {
            return Err("the cloud doesn't say which workspaces were archived yet".into());
        }
        let body: serde_json::Value = resp.json().unwrap_or(serde_json::Value::Null);
        if !status.is_success() {
            return Err(format!("asking which workspaces were archived: {status} {}", error_of(&body)));
        }
        let asked: HashSet<&str> = held.iter().map(String::as_str).collect();
        serde_json::from_value::<Archived>(body)
            .map(|a| a.archived.into_iter().filter(|n| asked.contains(n.as_str())).collect())
            .map_err(|e| format!("reading which workspaces were archived: {e}"))
    }
}

pub(crate) fn answer_body(
    chat: &Chat,
    text: &str,
    agent_session_id: Option<&str>,
    failed: bool,
    at: &At,
) -> serde_json::Value {
    serde_json::json!({
        "answers": chat.prompt.message_id,
        "text": text,
        "agent_session_id": agent_session_id,
        "failed": failed,
        "branch": at.branch,
        "folder": at.folder,
    })
}

fn error_of(body: &serde_json::Value) -> String {
    body.get("error")
        .or_else(|| body.get("detail"))
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .to_string()
}

/// Who a prompt is from, for the log.
fn sender(p: &Prompt) -> String {
    p.author_login.clone().or_else(|| p.author_name.clone()).unwrap_or_else(|| p.author_id.clone())
}

/// Whose sign-in a prompt runs on, for the log.
fn on_whose(p: &Prompt) -> String {
    if p.on_starter_s_sign_in() {
        format!("on the sign-in of whoever started the workspace ({})", p.runs_as())
    } else {
        "on their own sign-in".to_string()
    }
}

struct InFlight {
    child: Child,
    chat: Chat,
    started: Instant,
}

/// Start answering chats beside the serve loop. `None`, with the reason said
/// once, when this computer is not a place that can.
pub fn spawn(bin: PathBuf, workspaces_root: PathBuf, running: Arc<AtomicBool>) -> Option<std::thread::JoinHandle<()>> {
    let cloud = match Cloud::connect() {
        Ok(c) => c,
        Err(why) => {
            eprintln!("{} not answering cloud chats: {why}", "[chat]".dimmed());
            return None;
        }
    };
    eprintln!(
        "{} answering cloud chats for this computer; turns run under {}",
        "[chat]".cyan(),
        workspaces_root.display()
    );
    std::thread::Builder::new()
        .name("aura-chat".into())
        .spawn(move || drive(&cloud, &bin, &workspaces_root, &running))
        .ok()
}

fn drive(cloud: &Cloud, bin: &Path, root: &Path, running: &AtomicBool) {
    let mut inflight: HashMap<String, InFlight> = HashMap::new();
    let mut tried: HashSet<String> = HashSet::new();
    let mut last_error: Option<String> = None;
    let mut sweeper = crate::runner_chat_sweep::Sweeper::new();
    while running.load(Ordering::SeqCst) {
        reap(cloud, &mut inflight);
        // Never a copy a turn is working in right now. Turns start only on
        // this thread, below, so none can begin while the sweep runs.
        let busy: HashSet<String> =
            inflight.values().map(|f| crate::runner_chat_turn::slug(&f.chat.workspace)).collect();
        sweeper.tick(cloud, root, &busy);
        match cloud.pending() {
            Ok(chats) => {
                last_error = None;
                for chat in chats {
                    if tried.contains(&chat.prompt.message_id) || inflight.contains_key(&chat.repo) {
                        continue;
                    }
                    if tried.len() >= TRIED_CAP {
                        tried.clear();
                    }
                    tried.insert(chat.prompt.message_id.clone());
                    match start(cloud, bin, root, &chat) {
                        Ok(child) => {
                            eprintln!(
                                "{} {} asked in {} — running it {}",
                                "[chat]".cyan(),
                                sender(&chat.prompt).bold(),
                                chat.repo,
                                on_whose(&chat.prompt)
                            );
                            inflight.insert(chat.repo.clone(), InFlight { child, chat, started: Instant::now() });
                        }
                        Err(why) => {
                            let text = format!("This computer couldn't start on this prompt: {why}");
                            if let Err(e) = cloud.answer(&chat, &text, None, true, &At::default()) {
                                eprintln!("{} {e}", "[chat]".yellow());
                            }
                        }
                    }
                }
            }
            Err(e) => {
                if last_error.as_deref() != Some(e.as_str()) {
                    eprintln!("{} {e}", "[chat]".yellow());
                    last_error = Some(e);
                }
            }
        }
        let until = Instant::now() + POLL;
        while Instant::now() < until && running.load(Ordering::SeqCst) {
            std::thread::sleep(Duration::from_millis(250));
        }
    }
}

/// Start one turn as its own process, told at birth whose it is.
fn start(cloud: &Cloud, bin: &Path, root: &Path, chat: &Chat) -> Result<Child, String> {
    let mut child = Command::new(bin)
        .args(["runner", "chat-turn", "--workspaces-root"])
        .arg(root)
        .env(push_credential::ACTING_MEMBER_ENV, chat.prompt.runs_as())
        .env(push_credential::PLACE_ID_ENV, &cloud.place)
        .stdin(Stdio::piped())
        .spawn()
        .map_err(|e| format!("starting the turn: {e}"))?;
    let json = serde_json::to_vec(chat).map_err(|e| e.to_string())?;
    if let Some(mut stdin) = child.stdin.take() {
        stdin.write_all(&json).map_err(|e| format!("handing the prompt to the turn: {e}"))?;
    }
    Ok(child)
}

/// Collect finished turns. A turn that died without answering, or ran past
/// [`TURN_LIMIT`], is answered for: nobody should be left watching a prompt
/// that will never come back. A turn that did answer makes this a no-op, since
/// a second answer to one prompt is the same row.
fn reap(cloud: &Cloud, inflight: &mut HashMap<String, InFlight>) {
    let mut done = Vec::new();
    for (repo, f) in inflight.iter_mut() {
        match f.child.try_wait() {
            Ok(Some(status)) if status.success() => done.push((repo.clone(), None)),
            Ok(Some(status)) => done.push((
                repo.clone(),
                Some(format!("This computer stopped before it finished this prompt ({status}). Send it again.")),
            )),
            Ok(None) if f.started.elapsed() > TURN_LIMIT => {
                let _ = f.child.kill();
                let _ = f.child.wait();
                done.push((
                    repo.clone(),
                    Some(format!("This prompt ran past {} minutes and was stopped.", TURN_LIMIT.as_secs() / 60)),
                ));
            }
            Ok(None) => {}
            Err(e) => done.push((repo.clone(), Some(format!("This computer lost track of this prompt: {e}")))),
        }
    }
    for (repo, why) in done {
        let Some(f) = inflight.remove(&repo) else { continue };
        if let Some(why) = why {
            if let Err(e) = cloud.answer(&f.chat, &why, None, true, &At::default()) {
                eprintln!("{} {e}", "[chat]".yellow());
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn chat() -> Chat {
        serde_json::from_value(serde_json::json!({
            "workspace": "ws-1",
            "workspace_id": "0b7c1f2e-9a4d-4c55-8e3a-1f2d3c4b5a69",
            "repo": "acme/app",
            "default_branch": "main",
            "branch": null,
            "engine": "claude",
            "agent_session_id": null,
            "prompt": {
                "message_id": "m-1",
                "text": "hi",
                "author_id": "u-1",
                "author_login": "sam",
                "author_name": "Sam",
                "created_at": "2026-11-11T13:00:00Z",
                "lease": "l-1",
                "refused": null
            }
        }))
        .unwrap()
    }

    #[test]
    fn the_cloud_s_list_reads_as_chats() {
        let c = chat();
        assert_eq!(c.prompt.lease.as_deref(), Some("l-1"));
        assert_eq!(sender(&c.prompt), "sam");
    }

    #[test]
    fn a_prompt_from_an_older_cloud_names_no_model() {
        assert_eq!(chat().prompt.model, None);
    }

    #[test]
    fn a_prompt_from_an_older_cloud_runs_as_its_author() {
        let c = chat();
        assert_eq!(c.prompt.runs_as, None);
        assert_eq!(c.prompt.runs_as(), "u-1");
        assert!(!c.prompt.on_starter_s_sign_in());
        assert_eq!(on_whose(&c.prompt), "on their own sign-in");
        let mut blank = chat();
        blank.prompt.runs_as = Some("  ".into());
        assert_eq!(blank.prompt.runs_as(), "u-1", "an empty name is no name");
    }

    #[test]
    fn a_teammate_s_prompt_runs_as_the_starter_and_stays_theirs() {
        let mut c = chat();
        c.prompt.runs_as = Some("u-starter".into());
        assert_eq!(c.prompt.runs_as(), "u-starter");
        assert!(c.prompt.on_starter_s_sign_in());
        assert_eq!(sender(&c.prompt), "sam", "the words are still sam's");
        assert_eq!(on_whose(&c.prompt), "on the sign-in of whoever started the workspace (u-starter)");
        // The child is handed the same prompt, the starter's name included.
        let back: Chat = serde_json::from_slice(&serde_json::to_vec(&c).unwrap()).unwrap();
        assert_eq!(back.prompt.runs_as(), "u-starter");
        let same = serde_json::json!({"message_id": "m", "text": "t", "author_id": "u-1", "runs_as": "u-1"});
        let own: Prompt = serde_json::from_value(same).unwrap();
        assert!(!own.on_starter_s_sign_in());
    }

    #[test]
    fn the_answer_is_posted_as_the_member_the_turn_ran_as() {
        let src = include_str!("runner_chat.rs");
        let answer = src.split("pub fn answer(").nth(1).unwrap().split("pub(crate) fn answer_body(").next().unwrap();
        assert!(answer.contains(".header(push_credential::ACTING_MEMBER_HEADER, chat.prompt.runs_as())"));
    }

    #[test]
    fn an_answer_names_its_prompt() {
        let at = At { branch: Some("aura/ws-1".into()), folder: Some("/opt/aura-runner/workspaces/.chats/ws-1".into()) };
        let b = answer_body(&chat(), "done", Some("s-1"), false, &at);
        assert_eq!(b["answers"], "m-1");
        assert_eq!(b["agent_session_id"], "s-1");
        assert_eq!(b["failed"], false);
        assert_eq!(b["branch"], "aura/ws-1");
        assert_eq!(b["folder"], "/opt/aura-runner/workspaces/.chats/ws-1");
        let none = answer_body(&chat(), "x", None, true, &At::default());
        assert!(none["branch"].is_null() && none["folder"].is_null());
    }

    #[test]
    fn a_sweep_never_touches_a_copy_a_turn_is_in() {
        let src = include_str!("runner_chat.rs");
        let body = src.split("fn drive(").nth(1).unwrap().split("fn start(").next().unwrap();
        let sweep = body.find("sweeper.tick(cloud, root, &busy)").unwrap();
        assert!(body[..sweep].contains("inflight.values().map(|f| crate::runner_chat_turn::slug(&f.chat.workspace))"));
    }

    #[test]
    fn a_turn_is_told_whose_it_is_and_the_parent_never_changes_its_own_env() {
        let src = include_str!("runner_chat.rs");
        let start = src.split("fn start(").nth(1).unwrap().split("fn reap(").next().unwrap();
        assert!(start.contains(".env(push_credential::ACTING_MEMBER_ENV, chat.prompt.runs_as())"));
        let needle = ["set", "_var("].concat();
        assert!(!src.contains(&needle));
    }
}
