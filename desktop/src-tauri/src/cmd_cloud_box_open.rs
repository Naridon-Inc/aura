//! Start a cloud workspace's chat on one of the org's machines.
//!
//! One command does the whole walk, in the order each step needs the last:
//! the workspace gets its own worktree of the project on the machine, the
//! workspace is linked to that machine (so its members can see where the
//! conversation runs and the lease below has a place to be bound to), the
//! member mints a one-time lease for their own sign-in, and the machine starts
//! the agent under tmux, fetching that sign-in with its runner token. Then
//! this laptop attaches, exactly as it does when the workspace is reopened
//! (see [`crate::cmd_cloud_box_brain`]).
//!
//! The agent outlives this laptop from the moment it is started: the machine
//! keeps it, and closing the lid only drops the attach.

use std::time::Duration;

use serde::Deserialize;
use serde_json::Value;

use crate::cloudbox::chat_script::{self, Launch, SignIn, RUNNER_ENV};
use crate::cloudbox::{continue_branch, restore_folder, script};
use crate::cmd_cloud_box_brain::{absolute_root, agent_for, chat_key, cloud_box_chat_attach, Attached, BoxChat};
use crate::cmd_cloud_box_chat::{self as box_chat, BoxLink};
use crate::manager::brain::place::Place;
use crate::manager::brain::place_chat;

/// Making a worktree checks out the project, which on a large one is not quick.
const CHECKOUT: Duration = Duration::from_secs(120);
const ASK: Duration = Duration::from_secs(30);

/// What the create flow knows when it starts a workspace's chat.
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BoxOpen {
    pub workspace_id: String,
    /// The machine-book entry that reaches the machine.
    pub machine_id: String,
    /// The org board's row for the machine, which the sign-in lease is bound to.
    pub place_id: String,
    /// The project's checkout on the machine.
    pub project: String,
    /// The branch the workspace works on. Made when the project has no such
    /// branch yet.
    pub branch: String,
    /// `claude` or `codex`.
    pub engine: String,
    #[serde(default)]
    pub author_name: Option<String>,
    /// The branch is one GitHub already has — an open pull request carried on
    /// from a laptop — so the machine checks out GitHub's copy of it rather
    /// than starting a branch of that name off its own.
    #[serde(default)]
    pub continue_branch: bool,
    /// The teammates' GitHub logins, for messages addressed to them.
    #[serde(default)]
    pub people: Vec<String>,
    /// The chat's first message when the workspace's log already holds it:
    /// messages sent while no computer ran the workspace. The agent gets
    /// them; the log doesn't get them twice.
    #[serde(default)]
    pub on_log: Option<String>,
}

/// The executables an ACP agent goes by, newest-installed first.
fn bins_for(agent: &str) -> &'static [&'static str] {
    match agent {
        "claude-acp" => &["claude-agent-acp", "claude-code-acp"],
        "codex-acp" => &["codex-acp"],
        _ => &[],
    }
}

/// The member's sign-in as the machine should fetch it, from the lease the
/// cloud minted. Every field is the cloud's own answer, never this laptop's
/// guess, so a lease for one workspace can't be spent on another.
fn sign_in_from(lease: &Value, cloud: String) -> Result<SignIn, String> {
    let field = |k: &str| {
        lease
            .get(k)
            .and_then(Value::as_str)
            .map(str::to_string)
            .ok_or_else(|| format!("the cloud's sign-in lease has no {k}"))
    };
    Ok(SignIn {
        place: field("place")?,
        member: field("member")?,
        lease: field("lease")?,
        workspace: field("workspace")?,
        harness: field("harness")?,
        token_file: RUNNER_ENV.to_string(),
        cloud,
    })
}

/// The cloud this laptop is signed in to, for a machine whose runner file
/// names none. Nothing when the app is pointed somewhere else for a test, so a
/// machine's runner token is never sent to a host it did not join.
pub(crate) fn laptop_cloud() -> String {
    if crate::cloud_endpoint::is_overridden() {
        return String::new();
    }
    crate::cloud_session_sync::read_credentials()
        .map(|c| crate::cloud_session_sync::cloud_origin(&c))
        .unwrap_or_default()
}

/// The last thing a failed step said, as a sentence.
fn refused(what: &str, out: &crate::manager::brain::place::Output) -> String {
    let text = if out.stderr.trim().is_empty() { &out.stdout } else { &out.stderr };
    let line = text.lines().rev().map(str::trim).find(|l| !l.is_empty()).unwrap_or("no output");
    format!("{what}: {line}")
}

/// Why a chat that was started is not running, in the words its exit code means.
fn not_started(machine: &str, exit: Option<i32>, errors: &[String]) -> String {
    let said = errors.last().map(|e| format!(" It said: {e}")).unwrap_or_default();
    match exit {
        Some(chat_script::EXIT_NO_SIGN_IN) => {
            format!("{machine} couldn't fetch your sign-in for this chat. Connect your agent from Cloud, then try again.{said}")
        }
        Some(chat_script::EXIT_NO_RUNNER) => {
            format!("{machine} has no runner token to fetch your sign-in with. Reconnect it from Cloud.{said}")
        }
        Some(chat_script::EXIT_NO_DIR) => format!("The workspace's folder isn't on {machine}.{said}"),
        _ => format!("The chat on {machine} stopped as soon as it started.{said}"),
    }
}

/// The agent adapter `machine` has for `agent`, as an absolute path there.
async fn installed_agent(place: &Place, machine: &str, agent: &str, engine: &str) -> Result<String, String> {
    let found = place.sh(&chat_script::find_agent(agent, bins_for(agent))?, ASK).await?;
    let program = found.stdout.lines().map(str::trim).find(|l| l.starts_with('/')).map(str::to_string);
    program.filter(|_| found.code == 0).ok_or_else(|| {
        format!("{machine} doesn't have the {engine} agent installed. Set the machine up from Cloud, then try again.")
    })
}

/// Start the agent and make sure it stayed up. The sign-in is fetched and the
/// agent exec'd in the first instant; a chat that fails either is gone before
/// anything attaches, and says why.
async fn start_running(place: &Place, machine: &str, launch: Launch) -> Result<chat_script::Status, String> {
    let key = launch.key.clone();
    place_chat::start(place, launch).await?;
    let status = place_chat::status(place, &key).await?;
    if !status.alive {
        return Err(not_started(machine, status.exit, &status.errors));
    }
    Ok(status)
}

/// The workspace's folder on the machine, made again when the machine no
/// longer has it — a replaced machine has the project at most — from the
/// project it was made beside, on the workspace's own branch.
async fn restored_folder(place: &Place, machine: &str, link: &BoxLink) -> Result<String, String> {
    let gone = || format!("{machine} no longer has this workspace's folder ({}).", link.remote_root.trim());
    let there = place.sh(&chat_script::absolute(link.remote_root.trim())?, ASK).await?;
    let path = there.stdout.trim();
    if there.code == 0 && path.starts_with('/') {
        return Ok(path.to_string());
    }
    let branch = link.branch.as_deref().map(str::trim).filter(|b| script::is_branch(b)).ok_or_else(gone)?;
    let project = restore_folder::project_of(&link.remote_root, branch).ok_or_else(gone)?;
    let missing = || {
        format!(
            "{machine} doesn't have {project}, the project this workspace was made from. Put a copy of it there, then open the workspace again."
        )
    };
    let at = absolute_root(place, &project).await.map_err(|_| missing())?;
    let root = script::worktree_path(&at, branch);
    let made = place.sh(&restore_folder::restore(&at, &root, branch), CHECKOUT).await?;
    match made.code {
        0 => Ok(root),
        restore_folder::EXIT_NO_PROJECT => Err(missing()),
        code => Err(continue_branch::refusal(machine, branch, code)
            .unwrap_or_else(|| refused(&format!("{machine} couldn't make the workspace's folder again"), &made))),
    }
}

/// A computer that answers by itself runs its own agent on each sender's
/// sign-in; a laptop starting one there would answer for everyone on its own.
fn laptop_driven(link: &BoxLink) -> Result<(), String> {
    match link.driver.as_deref().map(str::trim) {
        None | Some("") => Ok(()),
        Some(_) => Err(format!("{} answers this workspace by itself; there is no chat here to start.", link.machine.trim())),
    }
}

/// Start a workspace's chat again on the machine it is linked to, when the
/// machine keeps no running agent for it: replaced, restarted, or the agent
/// ended. The folder comes back first when it's gone, then the agent starts on
/// a fresh lease of the member's own sign-in, exactly as the first open did.
/// Returns how the new chat stands, so the attach knows where its log starts.
pub(crate) async fn restart(
    place: &Place,
    workspace_id: &str,
    link: &BoxLink,
) -> Result<chat_script::Status, String> {
    laptop_driven(link)?;
    let key = chat_key(workspace_id)?;
    let agent = agent_for(&link.engine)?;
    let machine = link.machine.trim();
    let root = restored_folder(place, machine, link).await?;
    let program = installed_agent(place, machine, agent, &link.engine).await?;
    let engine = link.engine.trim().to_ascii_lowercase();
    let lease = box_chat::cloud_box_lease(workspace_id.to_string(), engine).await?;
    let launch = Launch { key, cwd: root, argv: vec![program], sign_in: Some(sign_in_from(&lease, laptop_cloud())?) };
    start_running(place, machine, launch).await
}

/// Start a workspace's chat on a machine and connect this laptop to it.
#[tauri::command]
pub async fn cloud_box_chat_open(open: BoxOpen) -> Result<Attached, String> {
    let key = chat_key(&open.workspace_id)?;
    let agent = agent_for(&open.engine)?;
    let branch = open.branch.trim().to_string();
    if branch.is_empty() {
        return Err("a workspace on a machine needs a branch to work on".into());
    }
    // By the id the workspace was saved with, or one the machine used to carry:
    // a workspace made before the machine was renamed still names it the old way.
    let machine = crate::cmd_machines::pick(crate::cmd_machines::visible_machines(), &open.machine_id)
        .ok_or("That machine isn't connected from this laptop. Connect it from Cloud, then try again.")?;
    let place = Place::at_machine_home(&machine.id)?;

    let project = absolute_root(&place, &open.project).await?;
    let root = script::worktree_path(&project, &branch);
    if open.continue_branch {
        if !script::is_branch(&branch) {
            return Err(format!("{branch} isn't a branch name the machine can check out"));
        }
        let made = place.sh(&continue_branch::continue_worktree(&project, &root, &branch), CHECKOUT).await?;
        if made.code != 0 {
            return Err(continue_branch::refusal(&machine.name, &branch, made.code).unwrap_or_else(|| {
                refused(&format!("{} couldn't pick up {branch}", machine.name), &made)
            }));
        }
    } else {
        let made = place.sh(&script::add_worktree(&project, &root, &branch), CHECKOUT).await?;
        if made.code != 0 {
            return Err(refused(&format!("{} couldn't make the workspace's copy", machine.name), &made));
        }
    }

    let program = installed_agent(&place, &machine.name, agent, &open.engine).await?;

    let link = BoxLink {
        machine: machine.name.clone(),
        remote_root: root.clone(),
        branch: Some(branch),
        engine: open.engine.trim().to_ascii_lowercase(),
        agent_session_id: None,
        place_id: Some(open.place_id.clone()),
        driver: None,
    };
    box_chat::cloud_box_link(open.workspace_id.clone(), link.clone()).await?;
    let lease = box_chat::cloud_box_lease(open.workspace_id.clone(), link.engine.clone()).await?;

    let launch = Launch { key: key.clone(), cwd: root, argv: vec![program], sign_in: Some(sign_in_from(&lease, laptop_cloud())?) };
    start_running(&place, &machine.name, launch).await?;

    if let Some(words) = open.on_log.as_deref() {
        crate::cloud_box_people::hold_on_log(&open.workspace_id, words);
    }
    cloud_box_chat_attach(BoxChat {
        workspace_id: open.workspace_id,
        link,
        author_name: open.author_name,
        people: open.people,
    })
    .await
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    const ID: &str = "8d0c3a4e-6a31-4e7b-9b8f-1c2d3e4f5a6b";

    #[test]
    fn the_machine_fetches_the_sign_in_the_cloud_leased_and_nothing_else() {
        let lease = json!({"lease": ID, "place": ID, "member": ID, "workspace": ID, "harness": "claude", "expires_at": "2026-11-10T20:00:00Z"});
        let s = sign_in_from(&lease, "https://cloud.example".into()).unwrap();
        assert_eq!((s.harness.as_str(), s.token_file.as_str()), ("claude", RUNNER_ENV));
        let mut short = lease.clone();
        short.as_object_mut().unwrap().remove("member");
        assert_eq!(sign_in_from(&short, String::new()).unwrap_err(), "the cloud's sign-in lease has no member");
    }

    #[test]
    fn a_workspace_continues_a_branch_only_when_asked_to() {
        let base = json!({"workspaceId": ID, "machineId": "m", "placeId": ID, "project": "p", "branch": "fix/login", "engine": "claude"});
        let open: BoxOpen = serde_json::from_value(base.clone()).unwrap();
        assert!(!open.continue_branch, "a desktop that never sends it keeps making new branches");
        let mut asked = base;
        asked["continueBranch"] = json!(true);
        assert!(serde_json::from_value::<BoxOpen>(asked).unwrap().continue_branch);
    }

    #[test]
    fn each_agent_is_looked_for_by_the_names_it_installs_as() {
        assert_eq!(bins_for(agent_for("claude").unwrap()), &["claude-agent-acp", "claude-code-acp"]);
        assert_eq!(bins_for(agent_for("Codex").unwrap()), &["codex-acp"]);
        assert!(bins_for("gemini").is_empty());
    }

    #[test]
    fn a_chat_that_never_ran_says_which_step_failed() {
        let m = "aura-runner";
        assert!(not_started(m, Some(chat_script::EXIT_NO_SIGN_IN), &[]).contains("couldn't fetch your sign-in"));
        assert!(not_started(m, Some(chat_script::EXIT_NO_RUNNER), &[]).contains("no runner token"));
        assert!(not_started(m, Some(chat_script::EXIT_NO_DIR), &[]).contains("folder isn't on aura-runner"));
        let e = not_started(m, Some(1), &["node: not found".into()]);
        assert!(e.ends_with("It said: node: not found"));
    }

    #[test]
    fn only_a_chat_this_laptop_drives_is_started_again_from_it() {
        let mut link = BoxLink {
            machine: "aura-runner".into(),
            remote_root: "/home/ubuntu/Lumi-hi-df3774".into(),
            branch: Some("hi-df3774".into()),
            engine: "claude".into(),
            agent_session_id: None,
            place_id: None,
            driver: None,
        };
        assert!(laptop_driven(&link).is_ok());
        link.driver = Some("box".into());
        assert!(laptop_driven(&link).unwrap_err().contains("aura-runner answers this workspace by itself"));
    }

    /// A real workspace's chat, started again on the machine it is linked to
    /// through the cloud this laptop is signed in to: the folder comes back if
    /// it is gone, a lease is minted and the agent runs.
    #[tokio::test]
    #[ignore = "needs a real machine and workspace; set AURA_RESTART_LIVE_*"]
    async fn a_machine_that_lost_a_chat_runs_it_again() {
        let var = |k: &str| std::env::var(k).ok().filter(|v| !v.trim().is_empty());
        let (Some(machine), Some(workspace), Some(root), Some(branch)) = (
            var("AURA_RESTART_LIVE_MACHINE"),
            var("AURA_RESTART_LIVE_WORKSPACE"),
            var("AURA_RESTART_LIVE_ROOT"),
            var("AURA_RESTART_LIVE_BRANCH"),
        ) else {
            return;
        };
        let place = Place::at_machine_home(&machine).expect("place");
        let link = BoxLink {
            machine: var("AURA_RESTART_LIVE_NAME").unwrap_or_else(|| machine.clone()),
            remote_root: root,
            branch: Some(branch),
            engine: "claude".into(),
            agent_session_id: None,
            place_id: None,
            driver: None,
        };
        let started = restart(&place, &workspace, &link).await.expect("restart");
        assert!(started.alive, "the agent didn't start");
        // The sign-in is fetched once the agent's script runs, so a refused one
        // shows only after a few seconds.
        tokio::time::sleep(Duration::from_secs(20)).await;
        let key = chat_key(&workspace).unwrap();
        let now = place_chat::status(&place, &key).await.unwrap();
        assert!(now.alive, "the agent stopped (exit {:?}): {}", now.exit, now.errors.join(" | "));
    }
}
