//! What is running on a box, and how to start more of it.
//!
//! A connected machine used to be able to do exactly one thing: drain a queue.
//! `aura runner serve` pulls ready tasks, runs them one at a time, pushes the
//! branch, sleeps. That is a task finisher. It cannot be watched, interrupted,
//! or handed half a thought, and it holds one project at a time.
//!
//! A box should be a *place*. Several things running at once, across several
//! projects, each in its own working copy, each something you can open, watch,
//! type into, walk away from and come back to tomorrow from a different
//! computer — and, when you want, that someone else can look at too.
//!
//! ## Why there is nothing to install over there
//!
//! tmux is already how a remote session survives losing the wire
//! (`remoteShell.ts`). What we had not used is that tmux will hold arbitrary
//! metadata *per session* — `@`-prefixed options, set once and handed back in a
//! format string. So the session list is not a record we keep and hope stays
//! true; the sessions **are** the record. Nothing to install, no daemon, no
//! port, no second source of truth to drift. A box needs ssh, tmux and git, and
//! it can have never heard of Aura.
//!
//! ## Why this lives in Rust rather than the frontend
//!
//! The frontend builds `ssh` lines already, for terminals. It must not also be
//! able to hand a box an arbitrary command and read the output back: that is a
//! remote-execution primitive one XSS away from the internet. So the scripts
//! are constants here, the arguments are validated here, and the frontend gets
//! named questions — `sessions`, `start`, `stop` — that it cannot spell in any
//! other way.
//!
//! ## Where the bodies went
//!
//! Every `box_*` command below is now one line: name a machine, and ask
//! [`Place`]. That is not indirection for its own sake — none of this was ever
//! *about* a box. "What is running here", "start one", "which agents can you
//! run" are questions this laptop answers too, and it answers them with the
//! same tmux and the same scripts. Leaving the bodies here would have meant a
//! local half written separately and drifting from this one on the first fix.
//!
//! So this module keeps what genuinely belongs to a machine — dialling one,
//! multiplexing the connection, the scripts and the parsers — and
//! `manager/brain/place.rs` holds the contract they implement.
//!
//! That arrangement holds only while nothing goes around it, and the next
//! command that wants something off a box is three lines from calling [`dial`]
//! itself — working perfectly, and leaving whatever it does out of every other
//! way of getting a machine. [`sole_ssh`] is the test that fails when one does.

pub mod domain;
pub mod managed_key;
pub mod parse;
pub mod script;
mod sole_ssh;

use std::process::Stdio;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use tokio::io::AsyncWriteExt;
use tokio::process::Command;

use crate::cmd_machines::{find_machine, Machine};
use crate::manager::brain::place::Place;
use crate::manager::brain::place_contract::Capabilities;
use crate::manager::brain::place_projects::PlaceProjects;
use domain::{BoxProject, BoxSession, NewSession};

/// How long to wait on a box before saying it didn't answer.
///
/// Generous enough for a cold VM across an ocean, short enough that a stopped
/// box doesn't leave a surface spinning. Everything here is a question, not a
/// piece of work — the work runs in tmux and outlives the call.
pub(crate) const SSH_TIMEOUT: Duration = Duration::from_secs(25);

/// The `ssh` arguments for asking a box a question.
pub(crate) fn ssh_args(m: &Machine, remote: &str) -> Vec<String> {
    ssh_argv(m, remote, false)
}

/// The `ssh` arguments for a machine, as a list — never a command line.
///
/// Passing argv directly means the local shell is not involved at all, so a key
/// path with a space in it is just a path with a space in it, and nothing the
/// book holds can be read as an instruction on *this* machine.
///
/// `tty` forces a pty on the far side. A question does not want one — it would
/// merge stderr into stdout and hand back terminal control codes where a parser
/// expects lines. A *terminal* needs one, because a shell with no tty is not a
/// shell you can type into and an agent that draws a UI has nothing to draw on.
///
/// ## The one line that differs between a box you brought and one Aura made
///
/// A box you brought carries the path to its own key, and that is what `-i`
/// names. A box Aura made has a key the member is never given — so instead of a
/// file, the far side is pointed at a local agent that answers signing
/// challenges by asking Aura, which holds the key and returns 64 bytes. See
/// [`managed_key`], including what that means for a stolen laptop.
///
/// Everything after this point is byte-for-byte the same call. That is
/// deliberate and it is the whole reason the branch is two options wide rather
/// than a second function: multiplexing, the timeouts, the tmux scripts and
/// every surface built on `Place` cannot tell the two apart, so a fix to one is
/// a fix to both.
pub(crate) fn ssh_argv(m: &Machine, remote: &str, tty: bool) -> Vec<String> {
    let mut args: Vec<String> = match managed_key::identity_args(m) {
        Some(agent) => agent,
        // A machine Aura made that this laptop cannot serve an agent for gets
        // no identity at all. Falling through to `-i` would hand ssh
        // `managed:…` as a path and produce a missing-file error about a file
        // that was never meant to exist. `dialable` refuses this case in words
        // before anything is spawned; this is only what the argv looks like if
        // something ever reaches here anyway.
        None if managed_key::is_managed(m.key_path.trim()) => vec![],
        None => vec!["-i".into(), shellexpand_home(&m.key_path)],
    };
    args.extend([
        "-o".into(),
        "StrictHostKeyChecking=accept-new".into(),
        "-o".into(),
        "ConnectTimeout=15".into(),
    ]);
    if tty {
        args.push("-t".into());
    } else {
        // No password prompt can ever appear: this call has no terminal to
        // answer one on, and without this it would hang until the timeout and
        // report as "the box didn't answer", which is a different problem. A
        // terminal, by contrast, has a person in front of it who can answer.
        args.push("-o".into());
        args.push("BatchMode=yes".into());
    }
    args.extend(forward_args(m.forward_agent));
    args.extend(multiplex_args(m.forward_agent));
    args.push(format!("{}@{}", m.user.trim(), m.host.trim()));
    args.push(remote.to_string());
    args
}

/// Whether this machine may use the agent on this laptop — said out loud in
/// both directions.
///
/// The `no` arm is the half that is easy to leave out and is the whole reason
/// this is a function. `~/.ssh/config` is the user's own file and may well say
/// `ForwardAgent yes` for a host, or for `Host *`; without an explicit option
/// on the command line, ssh would honour it and a place the member never opted
/// in would quietly be lending out their key. Off by default has to mean off,
/// not "off unless something else said otherwise" — so the decision recorded
/// against the machine is stated every time, and nothing further up has to know
/// that a config file exists.
fn forward_args(on: bool) -> Vec<String> {
    vec![
        "-o".into(),
        format!("ForwardAgent={}", if on { "yes" } else { "no" }),
    ]
}

/// Hold one connection open and send every later call down it.
///
/// This is not a tuning knob, it is what makes a remote chat usable at all. A
/// conversation that reads six files and runs the tests is eight round trips,
/// and a fresh ssh handshake costs ~200ms of key exchange against ~5ms down a
/// connection that already exists. That difference is the whole distance
/// between a cloud chat that feels like the local one and one nobody opens
/// twice.
///
/// `%C` is ssh's own fixed-length hash of (local host, remote host, port,
/// user) — the right name for this socket, and short. It matters because a
/// unix socket path has a hard length limit (104 bytes on macOS) that ssh
/// reports as a puzzling failure rather than a clear one; so a home directory
/// long enough to threaten it turns multiplexing off rather than breaking
/// every call to the box.
///
/// ## Why a forwarded connection gets a socket of its own
///
/// A shared socket would silently defeat the flag in both directions, and
/// neither failure announces itself. A client asking for forwarding down a
/// master that was opened without it does not get an agent — the member turned
/// it on and their pushes still fail as somebody else. Worse the other way: a
/// call made with forwarding off, riding a master opened with it, is a
/// connection the setting says has no agent on it and which does. So the
/// decision is part of the socket's name, and the two can never meet.
///
/// The persist window is shorter for the same reason. An idle master is a
/// connection nobody is watching, and while a forwarded one is up, anything on
/// that box running as that login can reach back through it — so the window
/// between the last call and the connection closing is exposure, not just a
/// cache. Fifteen seconds still covers a conversation's burst of tool calls.
fn multiplex_args(forward: bool) -> Vec<String> {
    let Some(dir) = control_dir() else {
        return vec![];
    };
    // `%C` hashes to a fixed length; the tag is ours and has to be counted too.
    let tag = if forward { FORWARDED_SOCKET } else { "" };
    if dir.len() + tag.len() + 41 > 92 {
        return vec![];
    }
    vec![
        "-o".into(),
        "ControlMaster=auto".into(),
        "-o".into(),
        format!("ControlPath={dir}/{tag}%C"),
        // Long enough to cover a conversation's worth of tool calls, short
        // enough that a laptop closed for the night isn't holding a socket
        // onto a box that has since been stopped.
        "-o".into(),
        format!("ControlPersist={}", if forward { 15 } else { 180 }),
    ]
}

/// What marks a control socket as one carrying an agent. Part of the path, so
/// a forwarded connection and a plain one to the same box are different
/// sockets — see [`multiplex_args`].
const FORWARDED_SOCKET: &str = "agent-";

/// Close the connection to a machine now, rather than when it happens to
/// expire.
///
/// Only meaningful for a place lending its agent, and that is the whole point
/// of it existing. Every other reason to hold a connection open is a
/// performance question — the next call is cheaper — but a forwarded one is
/// also the box's window onto your key, and a window that closes when the work
/// finishes is a different promise from one that closes three minutes later.
///
/// `-O exit` asks the master to go away. It is not an error for there to be no
/// master: nothing was open, which is the state being asked for. Anything the
/// far side is running keeps running — the work lives in tmux on the box, not
/// in this connection.
pub(crate) async fn hang_up(m: &Machine) -> Result<(), String> {
    let mut args = ssh_argv(m, "", false);
    // `ssh_argv` ends with the destination and then the remote command. A
    // control request has no command to run, and the request itself belongs
    // before the destination — so both come off and the tail is rebuilt.
    args.pop();
    let target = args.pop().unwrap_or_default();
    args.push("-O".into());
    args.push("exit".into());
    args.push(target);
    let out = tokio::time::timeout(HANG_UP_TIMEOUT, run_ssh(args, None))
        .await
        .map_err(|_| format!("{} didn't let go of its connection.", m.name))?
        .map_err(|e| format!("Couldn't close the connection to {}: {e}", m.name))?;
    let said = String::from_utf8_lossy(&out.stderr);
    // "No such file or directory" / "not found" — there was no master. Asked
    // for and already true is not a failure.
    if out.status.success() || said.contains("No such file") || said.contains("not found") {
        return Ok(());
    }
    Err(format!(
        "Couldn't close the connection to {}: {}",
        m.name,
        said.trim()
    ))
}

/// How long to wait for a connection to be let go. Local: it talks to a socket
/// on this disk, not to the box.
const HANG_UP_TIMEOUT: Duration = Duration::from_secs(5);

/// The one line in the repo that runs `ssh`.
///
/// Split out from [`dial`] when closing a connection became a second thing to
/// ask ssh for. Two spawns would have been two places to add whatever the next
/// transport needs — see [`sole_ssh`], which fails the build on the second.
///
/// `feed` is written to the child's standard input and nowhere else; see
/// [`dial`] for why that distinction is the point rather than a detail. `None`
/// closes stdin outright, so a remote command that reads it sees end of file
/// immediately instead of waiting on a terminal that will never type.
async fn run_ssh(args: Vec<String>, feed: Option<&str>) -> std::io::Result<std::process::Output> {
    let mut child = Command::new("ssh")
        .args(args)
        .stdin(if feed.is_some() {
            Stdio::piped()
        } else {
            Stdio::null()
        })
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()?;
    if let Some(bytes) = feed {
        let mut sink = child.stdin.take().ok_or_else(|| {
            std::io::Error::new(std::io::ErrorKind::BrokenPipe, "ssh has no input")
        })?;
        sink.write_all(bytes.as_bytes()).await?;
        // Dropped rather than merely flushed: the far side's `cat` reads until
        // end of file, and a pipe that is still open is not one.
        drop(sink);
    }
    child.wait_with_output().await
}

/// Beside the rest of Aura's state, not in `/tmp`: a stale socket in a
/// world-writable directory is somebody else's ssh session to hijack.
fn control_dir() -> Option<String> {
    let home = std::env::var("HOME").ok()?;
    let dir = format!("{}/.aura/ssh", home.trim_end_matches('/'));
    std::fs::create_dir_all(&dir).ok()?;
    Some(dir)
}

/// `~` is the user's, not the box's — the key lives on this disk.
pub(crate) fn shellexpand_home(p: &str) -> String {
    match std::env::var("HOME") {
        Ok(home) => under_home(p, &home),
        Err(_) => p.trim().to_string(),
    }
}

/// The same expansion, against a home directory named rather than read.
///
/// Split out so the test below can name one instead of setting `$HOME` on the
/// process. That distinction cost a morning once: a test here pointed the whole
/// binary's home at a directory nobody can write, and every other test that
/// happened to be mid-flight asking for the agent socket a machine Aura made is
/// opened through was told there wasn't one. The failure surfaced in the parity
/// matrix two modules away, and only when the two overlapped.
fn under_home(p: &str, home: &str) -> String {
    let p = p.trim();
    match p.strip_prefix("~/") {
        Some(rest) => format!("{}/{}", home.trim_end_matches('/'), rest),
        None => p.to_string(),
    }
}

/// Hosts and logins go into an argv slot that ssh parses itself, so they are
/// held to what a host and a login can actually be. The book is a file on disk;
/// a hand-edited row must not become an argument to ssh.
///
/// Reachable from `Place` because a machine reaches this check by two routes
/// and both have to pass it: a row read out of the book, and an address the
/// connect wizard has typed but not saved yet. One rule, applied twice, rather
/// than a second opinion written where the second route arrived.
pub(crate) fn is_dialable(m: &Machine) -> bool {
    let ok = |v: &str| {
        !v.is_empty()
            && v.len() <= 255
            && v.chars()
                .all(|c| c.is_ascii_alphanumeric() || matches!(c, '.' | '-' | '_'))
    };
    ok(m.host.trim()) && ok(m.user.trim()) && !m.key_path.trim().is_empty()
}

/// Everything a box said back.
#[derive(Debug, Clone)]
pub(crate) struct Ran {
    /// The remote command's exit code — except 255, which is also what ssh
    /// itself exits with when it could not connect at all. `stderr` tells the
    /// two apart, and is why it is carried here rather than folded into an
    /// error string.
    pub code: i32,
    pub stdout: String,
    pub stderr: String,
}

/// The machine behind an id, checked as far as this laptop can check it —
/// which is that we have a row for it and its address is one ssh will accept
/// as an address rather than as an argument.
pub(crate) fn dialable(machine_id: &str) -> Result<Machine, String> {
    let m = find_machine(machine_id)
        .ok_or_else(|| format!("{machine_id} isn't a machine this laptop knows how to reach."))?;
    if !is_dialable(&m) {
        return Err(format!(
            "{}'s address isn't one this laptop can dial. Reconnect the machine to fix it.",
            m.name
        ));
    }
    // An address is not the whole of reachability for a machine Aura made: its
    // key is held server-side, and without the local connection that borrows it
    // there is nothing to authenticate with. Refused here, in words, rather than
    // three hundred milliseconds later as `Permission denied (publickey)` —
    // which reads as "the box has stopped trusting you" and sends somebody to
    // re-provision a machine that is working.
    if let Some(why) = managed_key::unbrokerable(&m) {
        return Err(why);
    }
    Ok(m)
}

/// Run one command on a box and hand back everything it said.
///
/// A non-zero exit is deliberately not an error. A `grep` that matched nothing
/// and a test suite that failed are both *answers*; a caller that can only see
/// `Err` cannot tell either from a machine that is switched off — and that is
/// the one distinction that matters when the machine is three thousand miles
/// away. Only "we never got to run it" is an error here.
///
/// `feed` is what the command reads on standard input, and it exists for one
/// reason: **a command line is public**. The `remote` string becomes argv — for
/// `ssh` on this laptop, for `sshd` on the box, in `ps` on both, and in any `-v`
/// output somebody pastes into an issue. Everything that goes over this wire is
/// fine there, except the one thing [`Place::deliver`] carries: the contents of
/// a file that may be a credential. Those go on stdin, where the only reader is
/// the process they were sent to. Nothing else about the call changes, so there
/// is still exactly one line in the repo that spawns `ssh`.
pub(crate) async fn dial(
    m: &Machine,
    remote: &str,
    feed: Option<&str>,
    wait: Duration,
) -> Result<Ran, String> {
    let ran = run_ssh(ssh_args(m, remote), feed);

    let out = tokio::time::timeout(wait, ran)
        .await
        .map_err(|_| {
            format!(
                "{} didn't answer within {}s. It may be stopped, or its address may have changed.",
                m.name,
                wait.as_secs()
            )
        })?
        .map_err(|e| unreachable(m, e))?;

    Ok(Ran {
        code: out.status.code().unwrap_or(-1),
        stdout: String::from_utf8_lossy(&out.stdout).into_owned(),
        stderr: String::from_utf8_lossy(&out.stderr).into_owned(),
    })
}

fn unreachable(m: &Machine, e: std::io::Error) -> String {
    format!("Couldn't reach {}: {e}", m.name)
}

/// Ask a box something and read the answer.
///
/// The production path for this is now [`Place::ask`], which asks the same
/// question of a box or of this laptop; what remains here is the machine-only
/// spelling the live tests use to set up and tear down on a real box, where
/// naming a machine id directly is the whole point.
#[cfg(test)]
async fn ask(machine_id: &str, remote: String) -> Result<String, String> {
    let m = dialable(machine_id)?;
    let ran = dial(&m, &remote, None, SSH_TIMEOUT).await?;
    if ran.code == 0 {
        return Ok(ran.stdout);
    }
    // ssh's own words. A guess here ("check your credentials") is how someone
    // ends up debugging the wrong thing: the real line is usually "Connection
    // refused" or "Permission denied (publickey)", and both say what to do.
    let line = ran
        .stderr
        .lines()
        .rev()
        .find(|l| !l.trim().is_empty())
        .unwrap_or("no output")
        .trim();
    Err(format!("{}: {line}", m.name))
}

/// Enough noise to keep two sessions started in the same second apart.
pub(crate) fn nonce() -> String {
    let n = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_nanos())
        .unwrap_or(0);
    format!("{:x}", n & 0xffff_ffff)
}

/// Everything running on a box, right now.
#[tauri::command]
pub async fn box_sessions(machine_id: String) -> Result<Vec<BoxSession>, String> {
    Place::at_machine(&machine_id)?.sessions().await
}

/// Every project the box has a copy of that belongs to the org you opened it as.
///
/// The discovery is unchanged and still box-wide — the box is the only thing
/// that knows what is on it. What comes back is then narrowed by
/// [`crate::manager::brain::place_projects`], because a shared runner holds more
/// than one org's work and a picker that lists all of it hands a contractor the
/// repo names of their client's other clients. A place with no org, or an org
/// this laptop could not ask about, is not narrowed at all and says so.
///
/// On the way past, this is also the cheapest moment in the app to learn what
/// is checked out over there: the listing already carries a branch per project,
/// so the rail can name the *work* on a machine row instead of naming the
/// computer, and it costs no extra round trip to find out. That happens against
/// the projects the box actually holds rather than the narrowed list — the
/// machine's own repo directory is a fact about the machine, and an org filter
/// must not make the rail forget which branch is checked out in it.
#[tauri::command]
pub async fn box_projects(machine_id: String) -> Result<PlaceProjects, String> {
    let place = Place::at_machine(&machine_id)?;
    let found = place.projects().await?;
    remember_branch(&machine_id, &found).await;
    Ok(crate::manager::brain::place_projects::narrow(
        &found,
        &place.org_index().await,
    ))
}

/// What a place can actually run.
///
/// The picker asks this before offering agents for a session, so it shows what
/// will run THERE — not the six the laptop imagines every box holds and then
/// discovers, one failed session at a time, that it doesn't. `bins` is the
/// candidate set (the picker's own list of binary names); `agents` comes back
/// as the subset present, in the order asked. An empty `agents` is a real
/// answer ("this place has none of them"), distinct from an ssh error, which is
/// an Err — a caller that renders the two the same way tells somebody whose box
/// is merely slow that their machine is empty.
///
/// This used to be `box_agents` and hand back the bare list. Two problems, one
/// cause. It threw away `git`/`tmux`/`aura` from the very probe that found
/// them, so the next surface needing "this place has no tmux, it cannot hold a
/// session" had to go and ask again in its own words; and it took a machine id,
/// so the question could not be put to this laptop at all — which is a
/// capability existing in one place-mode only, by signature.
///
/// So: name a machine and you get that machine, with an unknown id an error
/// rather than a quiet fall back to here ("which agents can you run" answered
/// about the wrong computer is worse than unanswered). Name none and the answer
/// is about this laptop, in `root`, through the same probe script and the same
/// parser.
#[tauri::command]
pub async fn place_capabilities(
    root: Option<String>,
    machine_id: Option<String>,
    bins: Vec<String>,
) -> Result<Capabilities, String> {
    let place = match machine_id
        .as_deref()
        .map(str::trim)
        .filter(|id| !id.is_empty())
    {
        Some(id) => Place::at_machine(id)?,
        None => Place::resolve(root.unwrap_or_default(), None),
    };
    place.capabilities(&bins).await
}

/// Cache the branch checked out in the machine's own repo directory.
///
/// Best-effort on purpose. This is an observation made while doing something
/// else, and a book that won't write is not a reason to fail a listing the
/// caller actually asked for — the rail simply keeps the last name it had.
///
/// A machine with no `repo_path` is skipped rather than guessed at: a box
/// holding four checkouts has no single branch, and picking one would put a
/// confident wrong word on the row.
async fn remember_branch(machine_id: &str, projects: &[BoxProject]) {
    let Some(repo_path) = find_machine(machine_id).and_then(|m| m.repo_path) else {
        return;
    };
    let want = repo_path.trim_end_matches('/');
    let branch = projects
        .iter()
        .find(|p| p.path.trim_end_matches('/') == want)
        .and_then(|p| p.branch.as_deref())
        .map(str::trim)
        .filter(|b| !b.is_empty())
        .map(str::to_string);
    let _ = crate::cmd_machines::machine_set_branch(machine_id.to_string(), branch).await;
}

/// Start something, and hand back the session it started so the caller can open
/// it without asking the box a second time what just happened.
#[tauri::command]
pub async fn box_start(machine_id: String, spec: NewSession) -> Result<BoxSession, String> {
    Place::at_machine(&machine_id)?.start(spec).await
}

/// End a session. Whatever it was running ends with it — and if it was the last
/// one, the place stops being able to reach your agent as well.
#[tauri::command]
pub async fn box_stop(machine_id: String, session: String) -> Result<(), String> {
    Place::at_machine(&machine_id)?.stop_and_release(&session).await
}

/// Put a project on the box, in a session you can watch it arrive in.
///
/// `member` is who it is being cloned for, so the clone spends that member's
/// credential rather than whatever the box happens to hold. Optional because the
/// signed-in member is the right default, and never guessed further down.
#[tauri::command]
pub async fn box_clone(
    machine_id: String,
    remote_url: String,
    dir: String,
    member: Option<String>,
) -> Result<BoxSession, String> {
    Place::at_machine(&machine_id)?
        .clone_project(&remote_url, &dir, member.as_deref())
        .await
}

#[cfg(test)]
mod tests {
    use super::*;

    fn machine(host: &str, user: &str, key: &str) -> Machine {
        Machine {
            id: "ubuntu@h:/p".into(),
            name: "aura-runner".into(),
            host: host.into(),
            user: user.into(),
            key_path: key.into(),
            box_kind: "mine".into(),
            repo_path: None,
            repo_branch: None,
            project_root: None,
            org_slug: None,
            forward_agent: false,
            instance_id: None,
            asleep_since: 0,
            added_at: 0,
            last_used_at: 0,
        }
    }

    /// The same machine, having been opted in.
    fn lending(host: &str, user: &str, key: &str) -> Machine {
        Machine {
            forward_agent: true,
            ..machine(host, user, key)
        }
    }

    #[test]
    fn a_place_nobody_opted_in_says_no_rather_than_saying_nothing() {
        // The default this task exists for, and the reason it is stated rather
        // than omitted: `~/.ssh/config` is the member's own file and may hold
        // `ForwardAgent yes` for this host or for `Host *`. Leaving the option
        // off the command line would let that decide, and a place the member
        // never opted in would be lending out their key.
        let args = ssh_args(&machine("h", "u", "/k.pem"), "true");
        assert!(args.contains(&"ForwardAgent=no".to_string()));
        assert!(!args.contains(&"ForwardAgent=yes".to_string()));
        assert!(!args.contains(&"-A".to_string()));
    }

    #[test]
    fn a_place_that_was_opted_in_carries_the_agent() {
        let args = ssh_args(&lending("h", "u", "/k.pem"), "git push");
        assert!(args.contains(&"ForwardAgent=yes".to_string()));
        assert!(!args.contains(&"ForwardAgent=no".to_string()));
        // And a terminal gets it too — a person typing `git push` over there is
        // the case this whole feature is for.
        let term = ssh_argv(&lending("h", "u", "/k.pem"), "bash -l", true);
        assert!(term.contains(&"ForwardAgent=yes".to_string()));
    }

    /// **The acceptance criterion, at the argv.**
    ///
    /// A member opens a machine Aura made and no private key reaches their
    /// laptop. This is where that is true or false: if the line carries `-i`,
    /// something on this disk is being read as a key, and the whole arrangement
    /// behind [`managed_key`] has been bypassed.
    #[test]
    fn a_machine_aura_made_is_opened_with_no_key_on_this_laptop() {
        if std::env::var("HOME").is_err() {
            return;
        }
        let m = machine("h", "u", "managed:d290f1ee-6c54-4b01-90e6-d701748f0851");
        for args in [ssh_args(&m, "true"), ssh_argv(&m, "bash -l", true)] {
            let flat = args.join(" ");
            assert!(!args.contains(&"-i".to_string()), "{flat}");
            assert!(!flat.contains("managed:"), "the reference reached the wire: {flat}");
            assert!(flat.contains("IdentityAgent="), "{flat}");
            // Without this the far side offers the member's whole keyring to a
            // box they were only trying to open one way.
            assert!(flat.contains("IdentitiesOnly=yes"), "{flat}");
        }
    }

    /// And the other arm is untouched. A box somebody brought still opens with
    /// the key on their own disk — parity means neither mode loses anything,
    /// not that both go through the new path.
    #[test]
    fn a_box_somebody_brought_still_opens_with_its_own_key() {
        let args = ssh_args(&machine("h", "u", "~/keys/k.pem"), "true");
        assert_eq!(args[0], "-i");
        assert!(!args[1].starts_with('~'), "the home directory was not expanded");
        assert!(args[1].ends_with("/keys/k.pem"), "{}", args[1]);
        assert!(!args.join(" ").contains("IdentityAgent"));
    }

    /// Everything after the identity is the same call. This is what lets one
    /// `Place` serve both modes: a fix to multiplexing, a timeout or a script
    /// lands on both, because below the first two options there is nothing to
    /// land on twice.
    #[test]
    fn the_two_place_modes_differ_by_the_identity_and_by_nothing_else() {
        if std::env::var("HOME").is_err() {
            return;
        }
        let brought = ssh_args(&machine("h", "u", "/k.pem"), "tmux ls");
        let made = ssh_args(
            &machine("h", "u", "managed:550e8400-e29b-41d4-a716-446655440000"),
            "tmux ls",
        );
        // `-i <path>` is two arguments; the agent is four. Past those, the two
        // lines have to be identical — including the destination and the
        // command, which is what a surface actually depends on.
        assert_eq!(brought[2..], made[4..]);
    }

    #[test]
    fn a_forwarded_connection_never_shares_a_socket_with_a_plain_one() {
        // Both directions are silent failures. A client asking for an agent
        // down a master opened without one simply doesn't get it — the member
        // turned it on and their push still fails as somebody else. And a call
        // made with forwarding off, riding a master opened with it, is a
        // connection the setting says has no agent on it and which does.
        std::env::set_var("HOME", std::env::temp_dir().display().to_string());
        let plain = ssh_args(&machine("h", "u", "/k.pem"), "true");
        let lent = ssh_args(&lending("h", "u", "/k.pem"), "true");
        let path = |args: &[String]| {
            args.iter()
                .find(|a| a.starts_with("ControlPath="))
                .cloned()
                .unwrap_or_default()
        };
        // A home directory too long for a control socket turns multiplexing
        // off for both, and then there is no socket to disagree about.
        if path(&plain).is_empty() {
            return;
        }
        assert_ne!(path(&plain), path(&lent), "one socket serves both settings");
        assert!(path(&lent).contains(FORWARDED_SOCKET));
        // An idle forwarded master is the box's open window onto your key, so
        // it closes sooner than one that is only a cache.
        assert!(lent.contains(&"ControlPersist=15".to_string()));
        assert!(plain.contains(&"ControlPersist=180".to_string()));
    }

    #[test]
    fn letting_go_of_a_connection_is_a_request_and_not_a_command_to_run() {
        // `-O exit` talks to the master socket. A destination is still needed
        // to name which one, but a remote command would be nonsense — and a
        // stray empty argument is a command ssh would try to run.
        let m = lending("h", "u", "/k.pem");
        let mut args = ssh_argv(&m, "", false);
        args.pop();
        let target = args.pop().unwrap_or_default();
        args.push("-O".into());
        args.push("exit".into());
        args.push(target);
        assert_eq!(args.last().unwrap(), "u@h");
        assert_eq!(args[args.len() - 3], "-O");
        assert_eq!(args[args.len() - 2], "exit");
        assert!(!args.iter().any(String::is_empty), "an empty argv slot survived");
    }

    #[test]
    fn the_remote_command_is_one_argv_slot() {
        // Not a command line we build and hand to a local shell — the payload
        // travels as a single argument, so nothing in it is ever interpreted
        // on this laptop.
        let args = ssh_args(&machine("h", "u", "/k.pem"), "tmux list-sessions");
        assert_eq!(args.last().unwrap(), "tmux list-sessions");
        assert!(args.contains(&"BatchMode=yes".to_string()));
        assert!(args.contains(&"u@h".to_string()));
    }

    #[test]
    fn a_hand_edited_address_cannot_become_an_ssh_option() {
        // The book is a plain file. Someone (or something) editing it must not
        // be able to turn a host into an argument.
        assert!(is_dialable(&machine("203.0.113.10", "ubuntu", "/k.pem")));
        assert!(!is_dialable(&machine("-oProxyCommand=x", "ubuntu", "/k.pem")));
        assert!(!is_dialable(&machine("h", "u name", "/k.pem")));
        assert!(!is_dialable(&machine("h", "u", "   ")));
    }

    #[test]
    fn the_frontends_copy_of_dialability_is_pinned_to_this_one() {
        // `lib/place/boot.ts` reads the same file and asserts the same rows.
        // It keeps a copy at all because a form validates as you type and a
        // button has to be enabled before anything is asked — and a copy that
        // quietly stopped agreeing is a button that opens a terminal onto an
        // address this laptop then refuses, or refuses one that works.
        let raw = include_str!("dialable.cases.json");
        let v: serde_json::Value = serde_json::from_str(raw).expect("the dialable table parses");
        let cases = v["cases"].as_array().expect("a `cases` array");
        assert!(cases.len() >= 10, "the shared dialable table has been gutted");
        for c in cases {
            let user = c["user"].as_str().expect("a user");
            let host = c["host"].as_str().expect("a host");
            let key = c["key_path"].as_str().expect("a key path");
            let want = c["dialable"].as_bool().expect("a verdict");
            let why = c["why"].as_str().unwrap_or("");
            assert_eq!(
                is_dialable(&machine(host, user, key)),
                want,
                "{user}@{host} with key {key:?} disagrees with the shared table — {why}"
            );
        }
    }

    #[test]
    fn a_key_path_starting_with_a_tilde_is_this_laptops_home() {
        // The key never leaves this disk, so `~` can only mean the local one.
        // The home is named rather than set on the process: these tests run in
        // parallel in one binary and `$HOME` is one variable shared by all of
        // them, so setting it here is setting it under everybody.
        assert_eq!(under_home("~/keys/a.pem", "/Users/someone"), "/Users/someone/keys/a.pem");
        assert_eq!(under_home("/abs/a.pem", "/Users/someone"), "/abs/a.pem");
        assert_eq!(under_home("~/keys/a.pem", "/Users/someone/"), "/Users/someone/keys/a.pem");
    }

    #[test]
    fn two_sessions_started_together_get_different_names() {
        assert_ne!(nonce(), "");
        let a = script::session_name("agent", "/home/u/p", &nonce());
        let b = script::session_name("agent", "/home/u/p", &nonce());
        assert_ne!(a, b);
    }
}

/// The same commands, against a real machine.
///
/// Every test above proves we *build* the right string. None of them prove tmux
/// accepts it, that `@aura_project` survives a round trip, or that a session
/// outlives the ssh connection that made it — and those are the claims the
/// whole surface rests on. So these run for real, against a box named in the
/// environment, and are ignored otherwise:
///
/// ```text
/// AURA_LIVE_MACHINE='ubuntu@1.2.3.4:/home/ubuntu/naridon' \
///   cargo test --lib cloudbox::live -- --ignored --test-threads=1
/// ```
///
/// They clean up after themselves, and every session they make is named
/// `aura-…-livetest-…` so a failed run leaves something obviously disposable
/// rather than something you have to guess about.
#[cfg(test)]
mod live {
    use super::*;

    fn machine_id() -> Option<String> {
        std::env::var("AURA_LIVE_MACHINE").ok().filter(|v| !v.is_empty())
    }

    fn block_on<F: std::future::Future>(f: F) -> F::Output {
        tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .expect("a runtime")
            .block_on(f)
    }

    fn project(id: &str) -> String {
        // Whatever the box actually has. Hard-coding a path would make this a
        // test of one machine rather than of the code.
        let ps = block_on(box_projects(id.to_string())).expect("projects");
        let first = ps
            .projects
            .first()
            .unwrap_or_else(|| panic!("the box offers no git projects to work in: {}", ps.notice));
        first.path.clone()
    }

    #[test]
    #[ignore = "needs a real box; set AURA_LIVE_MACHINE"]
    fn the_box_lists_the_projects_it_actually_has() {
        let Some(id) = machine_id() else { return };
        let ps = block_on(box_projects(id)).expect("projects");
        // Offered or held back, every row the box sent is a real directory on
        // it — the narrowing decides what is listed, never what a row says.
        let seen: Vec<(&str, &str)> = ps
            .projects
            .iter()
            .map(|p| (p.path.as_str(), p.name.as_str()))
            .chain(ps.withheld.iter().map(|w| (w.path.as_str(), w.name.as_str())))
            .collect();
        assert!(!seen.is_empty());
        for (path, name) in seen {
            assert!(path.starts_with('/'), "{path} is not a path");
            assert!(!name.is_empty());
        }
        for w in &ps.withheld {
            assert!(!w.reason.trim().is_empty(), "{} was held back with no reason", w.path);
        }
    }

    #[test]
    #[ignore = "needs a real box; set AURA_LIVE_MACHINE"]
    fn a_shell_session_starts_is_listed_and_stops() {
        let Some(id) = machine_id() else { return };
        let dir = project(&id);
        let started = block_on(box_start(
            id.clone(),
            NewSession {
                project: dir.clone(),
                kind: "shell".into(),
                agent: None,
                title: Some("livetest shell".into()),
                branch: None,
                prompt: None,
            },
        ))
        .expect("start");

        // Everything we stamped came back off the machine, not out of our own
        // memory of what we asked for.
        assert_eq!(started.project, dir);
        assert_eq!(started.kind, "shell");
        assert_eq!(started.title, "livetest shell");
        assert!(started.created_at > 0);

        let listed = block_on(box_sessions(id.clone())).expect("sessions");
        assert!(
            listed.iter().any(|s| s.name == started.name),
            "the session we started is not in the box's own list"
        );

        block_on(box_stop(id.clone(), started.name.clone())).expect("stop");
        let after = block_on(box_sessions(id)).expect("sessions");
        assert!(!after.iter().any(|s| s.name == started.name));
    }

    #[test]
    #[ignore = "needs a real box; set AURA_LIVE_MACHINE"]
    fn a_session_with_its_own_branch_gets_its_own_directory() {
        let Some(id) = machine_id() else { return };
        let dir = project(&id);
        let branch = format!("livetest/{}", nonce());
        let started = block_on(box_start(
            id.clone(),
            NewSession {
                project: dir.clone(),
                kind: "shell".into(),
                agent: None,
                title: Some("livetest worktree".into()),
                branch: Some(branch.clone()),
                prompt: None,
            },
        ))
        .expect("start");

        // Beside the project, never inside it — otherwise every `git status` in
        // the parent reports a directory full of someone else's work.
        assert_ne!(started.project, dir, "it reused the project's own checkout");
        assert!(!started.project.starts_with(&format!("{dir}/")));
        assert_eq!(started.branch.as_deref(), Some(branch.as_str()));

        let worktree = started.project.clone();
        block_on(box_stop(id.clone(), started.name.clone())).expect("stop");
        // Leave the box as we found it.
        let _ = block_on(ask(
            &id,
            format!(
                "git -C {} worktree remove --force {} 2>/dev/null; git -C {} branch -D {} 2>/dev/null; true",
                script::quote(&dir),
                script::quote(&worktree),
                script::quote(&dir),
                script::quote(&branch),
            ),
        ));
    }

    #[test]
    #[ignore = "needs a real box; set AURA_LIVE_MACHINE"]
    fn work_outlives_the_connection_that_started_it() {
        // The reason any of this is on another machine. Each call below is its
        // own ssh connection that opens, does one thing and closes; the session
        // has to still be there for the next one.
        let Some(id) = machine_id() else { return };
        let dir = project(&id);
        let started = block_on(box_start(
            id.clone(),
            NewSession {
                project: dir,
                kind: "shell".into(),
                agent: None,
                title: Some("livetest durability".into()),
                branch: None,
                prompt: None,
            },
        ))
        .expect("start");

        for _ in 0..3 {
            let listed = block_on(box_sessions(id.clone())).expect("sessions");
            assert!(listed.iter().any(|s| s.name == started.name));
        }
        block_on(box_stop(id, started.name)).expect("stop");
    }

    #[test]
    #[ignore = "needs a real box; set AURA_LIVE_MACHINE"]
    fn an_agent_session_runs_the_agent_over_there() {
        let Some(id) = machine_id() else { return };
        let dir = project(&id);
        let started = block_on(box_start(
            id.clone(),
            NewSession {
                project: dir,
                kind: "agent".into(),
                agent: Some("claude".into()),
                title: Some("livetest agent".into()),
                branch: None,
                prompt: None,
            },
        ))
        .expect("start");
        assert_eq!(started.kind, "agent");
        assert_eq!(started.agent.as_deref(), Some("claude"));

        // What is actually running in there, according to the machine.
        let panes = block_on(ask(
            &id,
            format!(
                "tmux list-panes -t {} -F '#{{pane_current_command}}' 2>/dev/null || true",
                script::quote(&started.name)
            ),
        ))
        .expect("panes");
        assert!(
            !panes.trim().is_empty(),
            "the agent session has no pane running anything"
        );

        block_on(box_stop(id, started.name)).expect("stop");
    }

    #[test]
    #[ignore = "needs a real box; set AURA_LIVE_MACHINE"]
    fn a_session_started_by_hand_is_listed_under_the_project_it_is_in() {
        // Most sessions on a real box were not started from this window: the
        // CLI made them, or somebody ran `tmux new` over ssh. They carry none
        // of our options, and the surface still has to place them correctly —
        // otherwise the very sessions a shared box exists for are the ones it
        // files under "elsewhere".
        let Some(id) = machine_id() else { return };
        let dir = project(&id);
        let name = format!("aura-livetest-byhand-{}", nonce());

        block_on(ask(
            &id,
            format!(
                "tmux new-session -d -s {} -c {} 'sleep 120'",
                script::quote(&name),
                script::quote(&dir)
            ),
        ))
        .expect("start one the way anything else on the box would");

        let listed = block_on(box_sessions(id.clone())).expect("sessions");
        let found = listed
            .iter()
            .find(|s| s.name == name)
            .expect("a session the box is running is missing from the box's own list");
        assert_eq!(
            found.project, dir,
            "an unstamped session lost the directory the machine knows it is in"
        );

        block_on(box_stop(id, name)).expect("stop");
    }

    #[test]
    #[ignore = "needs a real box; set AURA_LIVE_MACHINE"]
    fn a_folder_name_lands_where_the_box_keeps_things() {
        // The laptop has no idea where a box's home is. Naming a folder has to
        // be enough, or "put this project on that machine" becomes a question
        // about someone else's filesystem layout.
        let Some(id) = machine_id() else { return };
        let dir = format!("aura-livetest-clone-{}", nonce());
        // The clone itself runs inside the session, so this returns as soon as
        // the box has started it — which is the point being tested, and why
        // github being slow or unreachable can't turn this red for the wrong
        // reason.
        let started = block_on(box_clone(
            id.clone(),
            "https://github.com/octocat/Hello-World.git".into(),
            dir.clone(),
            None,
        ));

        // Clean up before asserting, so a failure can't leave a session and a
        // half-cloned directory behind on a shared box.
        if let Ok(s) = &started {
            let _ = block_on(box_stop(id.clone(), s.name.clone()));
        }
        let _ = block_on(ask(
            &id,
            format!("rm -rf \"$HOME\"/{}; true", script::quote(&dir)),
        ));

        let project = started.expect("clone").project;
        assert!(
            project.starts_with('/') && project.ends_with(&dir),
            "{project} is not the box's own home plus the name we gave"
        );
    }

    #[test]
    #[ignore = "needs a real box; set AURA_LIVE_MACHINE"]
    fn a_machine_that_is_not_in_the_book_says_so_rather_than_hanging() {
        let e = block_on(box_sessions("nobody@nowhere:/x".into())).unwrap_err();
        assert!(e.contains("isn't a machine this laptop knows how to reach"));
    }
}
