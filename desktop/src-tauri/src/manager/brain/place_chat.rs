//! A conversation with an agent that runs at a place and outlives the laptop.
//!
//! The agent is started once and kept by the place (see
//! [`crate::cloudbox::chat_script`]); this laptop only ever *attaches*. An
//! attach is a stream whose stdin is the agent's stdin and whose stdout is the
//! agent's log from a byte offset, so the protocol client on this side can lose
//! the link, come back, and pick up at the next unread byte.
//!
//! Every verb goes through [`Place`], so a chat on a managed machine and one on
//! a box you brought are the same code.

use std::time::Duration;

use serde::Deserialize;

use super::place::Place;
use crate::cloudbox::chat_script::{self, Launch, SignIn, Started, Status, RUNNER_ENV};

/// Starting, asking about and stopping a chat are questions: tmux returns as
/// soon as the session exists.
const ASK: Duration = Duration::from_secs(30);

/// The member's sign-in the place should fetch for this chat.
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ChatSignIn {
    pub place: String,
    pub member: String,
    pub lease: String,
    pub workspace: String,
    pub harness: String,
}

/// One agent to start at a place.
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ChatLaunch {
    pub key: String,
    pub cwd: String,
    pub argv: Vec<String>,
    #[serde(default)]
    pub sign_in: Option<ChatSignIn>,
}

impl From<ChatLaunch> for Launch {
    fn from(l: ChatLaunch) -> Self {
        Launch {
            key: l.key,
            cwd: l.cwd,
            argv: l.argv,
            sign_in: l.sign_in.map(|s| SignIn {
                place: s.place,
                member: s.member,
                lease: s.lease,
                workspace: s.workspace,
                harness: s.harness,
                token_file: RUNNER_ENV.to_string(),
                cloud: crate::cmd_cloud_box_open::laptop_cloud(),
            }),
        }
    }
}

fn refused(what: &str, stderr: &str) -> String {
    let line = stderr.lines().rev().map(str::trim).find(|l| !l.is_empty()).unwrap_or("no output");
    format!("{what}: {line}")
}

/// Start the agent at `place`, or find it already running.
pub async fn start(place: &Place, launch: Launch) -> Result<Started, String> {
    let out = place.sh(&chat_script::start(&launch)?, ASK).await?;
    if out.code != 0 {
        return Err(refused("the chat could not be started", &out.stderr));
    }
    chat_script::parse_started(&out.stdout)
        .ok_or_else(|| refused("the machine did not say whether the chat started", &out.stdout))
}

/// How the chat at `place` is doing.
pub async fn status(place: &Place, key: &str) -> Result<Status, String> {
    let out = place.sh(&chat_script::status(key)?, ASK).await?;
    if out.code != 0 {
        return Err(refused("the chat could not be read", &out.stderr));
    }
    Ok(chat_script::parse_status(&out.stdout))
}

/// End the agent at `place`. Its log stays.
pub async fn stop(place: &Place, key: &str) -> Result<(), String> {
    let out = place.sh(&chat_script::stop(key)?, ASK).await?;
    if out.code != 0 {
        return Err(refused("the chat could not be stopped", &out.stderr));
    }
    Ok(())
}

/// A connection to the chat, unspawned, reading from byte `from` of its log.
///
/// What an agent protocol client is handed: it sets its own pipes and calls
/// this again with the last offset it saw whenever the link drops.
pub fn attach_command(machine_id: &str, key: &str, from: u64) -> Result<tokio::process::Command, String> {
    let place = Place::at_machine_home(machine_id)?;
    Ok(place.stream_command(&chat_script::attach(key, from)?))
}

/// What an agent protocol client re-runs to reach the chat at a place.
///
/// The machine and the key are checked once, here, so each reconnect after a
/// dropped link is only a new stream from the offset the client asks for:
/// nothing about the chat itself can fail between one attach and the next.
pub fn attacher(
    machine_id: &str,
    key: &str,
) -> Result<impl Fn(u64) -> tokio::process::Command + Send + Sync + 'static, String> {
    chat_script::attach(key, 0)?;
    let place = Place::at_machine_home(machine_id)?;
    let key = key.to_string();
    Ok(move |from: u64| {
        // `attach` refuses only a malformed key, and this one was accepted above.
        let script = chat_script::attach(&key, from).expect("a key accepted once is accepted again");
        place.stream_command(&script)
    })
}

#[tauri::command]
pub async fn place_chat_start(machine_id: String, launch: ChatLaunch) -> Result<Started, String> {
    let place = Place::at_machine_home(&machine_id)?;
    start(&place, launch.into()).await
}

#[tauri::command]
pub async fn place_chat_status(machine_id: String, key: String) -> Result<Status, String> {
    let place = Place::at_machine_home(&machine_id)?;
    status(&place, &key).await
}

#[tauri::command]
pub async fn place_chat_stop(machine_id: String, key: String) -> Result<(), String> {
    let place = Place::at_machine_home(&machine_id)?;
    stop(&place, &key).await
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn an_attacher_refuses_a_malformed_key_before_it_looks_for_the_machine() {
        let Err(why) = attacher("not-in-any-book", "two words") else {
            panic!("a key with a space was accepted");
        };
        assert!(why.contains("letters, digits and dashes"), "{why}");
    }
}

/// Against a real machine: `AURA_CHAT_LIVE_MACHINE=<machine id>` names one this
/// laptop's book can reach, with tmux and python3 on it.
#[cfg(test)]
mod live {
    use super::*;
    use std::process::Stdio;
    use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};

    /// Answers each line with its id; `slow` answers two seconds later, so the
    /// answer lands while nobody is attached.
    const ECHO: &str = "import json,sys,time\nfor line in sys.stdin:\n    m=json.loads(line)\n    if m.get('method')=='slow':\n        time.sleep(2)\n    print(json.dumps({'jsonrpc':'2.0','id':m['id'],'result':{'method':m['method']}}),flush=True)\n";

    fn machine() -> Option<String> {
        std::env::var("AURA_CHAT_LIVE_MACHINE").ok().filter(|v| !v.trim().is_empty())
    }

    async fn attach(machine: &str, key: &str, from: u64) -> tokio::process::Child {
        let mut cmd = attach_command(machine, key, from).expect("attach command");
        cmd.stdin(Stdio::piped()).stdout(Stdio::piped()).stderr(Stdio::null()).kill_on_drop(true);
        cmd.spawn().expect("attach")
    }

    #[tokio::test]
    #[ignore = "needs a real machine; set AURA_CHAT_LIVE_MACHINE"]
    async fn a_dropped_attach_resumes_at_the_next_unread_byte() {
        let Some(machine) = machine() else { return };
        let place = Place::at_machine(&machine).expect("place");
        let key = format!("live-{}", uuid::Uuid::new_v4().simple());
        let setup = format!(
            "mkdir -p \"$HOME/.aura/chat-live\" && printf '%s' {} > \"$HOME/.aura/chat-live/{key}.py\"",
            crate::cloudbox::script::quote(ECHO)
        );
        assert_eq!(place.sh(&setup, ASK).await.unwrap().code, 0);
        let launch = Launch {
            key: key.clone(),
            cwd: "~/".to_string() + ".aura",
            argv: vec!["python3".into(), "-u".into(), format!("{}/.aura/chat-live/{key}.py", home(&place).await)],
            sign_in: None,
        };
        let Started::At(origin) = start(&place, launch.clone()).await.expect("start") else {
            panic!("a new chat said it was already running");
        };
        assert_eq!(start(&place, launch).await.unwrap(), Started::Already);

        // First link: one answer, read whole.
        let mut a = attach(&machine, &key, origin).await;
        let mut w = a.stdin.take().unwrap();
        let mut r = BufReader::new(a.stdout.take().unwrap());
        w.write_all(b"{\"jsonrpc\":\"2.0\",\"id\":1,\"method\":\"echo\"}\n").await.unwrap();
        let mut first = String::new();
        r.read_line(&mut first).await.unwrap();
        assert!(first.contains("\"id\": 1"), "{first}");
        let seen = origin + first.len() as u64;

        // Ask for a slow answer and drop the link before it comes.
        w.write_all(b"{\"jsonrpc\":\"2.0\",\"id\":2,\"method\":\"slow\"}\n").await.unwrap();
        w.flush().await.unwrap();
        tokio::time::sleep(Duration::from_millis(300)).await;
        drop(w);
        drop(r);
        a.kill().await.ok();
        tokio::time::sleep(Duration::from_secs(3)).await;

        let st = status(&place, &key).await.unwrap();
        assert!(st.alive, "the agent outlived the link: {st:?}");
        assert!(st.size.unwrap() > seen, "the answer landed while nobody was attached: {st:?}");

        // Second link, from the last byte seen: the slow answer and nothing older.
        let mut b = attach(&machine, &key, seen).await;
        let mut w = b.stdin.take().unwrap();
        let mut r = BufReader::new(b.stdout.take().unwrap());
        let mut next = String::new();
        r.read_line(&mut next).await.unwrap();
        assert!(next.contains("\"id\": 2") && next.contains("slow"), "{next}");
        w.write_all(b"{\"jsonrpc\":\"2.0\",\"id\":3,\"method\":\"echo\"}\n").await.unwrap();
        let mut third = String::new();
        r.read_line(&mut third).await.unwrap();
        assert!(third.contains("\"id\": 3"), "{third}");
        drop(w);
        b.kill().await.ok();

        stop(&place, &key).await.unwrap();
        let st = status(&place, &key).await.unwrap();
        assert!(!st.alive, "{st:?}");
        let done = attach(&machine, &key, seen).await.wait_with_output().await.unwrap();
        assert_eq!(done.status.code(), Some(4), "an ended chat says so");
        let tidy = format!(
            "find \"$HOME/.aura/chat/{key}\" \"$HOME/.aura/chat-live/{key}.py\" -depth -delete"
        );
        place.sh(&tidy, ASK).await.ok();
    }

    async fn home(place: &Place) -> String {
        place.sh("printf '%s' \"$HOME\"", ASK).await.unwrap().stdout
    }
}
