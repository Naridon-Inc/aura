//! `aura acp-proxy -- <agent command>` — put Aura between any ACP client
//! and any ACP agent.
//!
//! The client (Zed, the Aura app, anything that speaks ACP over stdio)
//! launches the proxy as if it were the agent; the proxy launches the real
//! agent and relays every frame both ways. Four things happen on the way
//! through, and nothing else:
//!
//!   - a file the agent is about to write is snapshotted first — on
//!     `fs/write_text_file`, on a `tool_call` of kind edit/delete/move that
//!     has not run yet, and on a permission request for one — so
//!     `aura rewind` can bring it back;
//!   - a turn that touched files ends with one intent row naming them, its
//!     reason taken from what the person asked;
//!   - a permission request the gate already refuses (repo policy, or a
//!     locked strict mode without a human grant) is answered "no" on the
//!     spot, and the client is told why, instead of asking a human to
//!     approve what they have already forbidden;
//!   - every other frame is forwarded byte for byte.
//!
//! The agent's stderr is inherited, so its own logs read as if the proxy
//! were not there.

pub(crate) mod effects;
mod guard;
#[cfg(test)]
mod tests;

use std::io::{self, BufRead, BufReader, Write};
use std::process::{Child, Command, ExitStatus, Stdio};
use std::sync::{Arc, Mutex, MutexGuard};
use std::thread;

pub(crate) use effects::{Effects, LiveEffects};
pub(crate) use guard::{Guard, Step, To};

/// Run the proxy around `cmd` on this process's stdio. Returns the exit
/// code to leave with: the agent's own, or 127 when it could not start.
pub fn run(cmd: &[String], agent: Option<&str>) -> i32 {
    let Some((program, args)) = cmd.split_first() else {
        eprintln!("aura acp-proxy: name the agent to wrap, e.g. `aura acp-proxy -- gemini --experimental-acp`");
        return 2;
    };
    let exe = match std::env::current_exe() {
        Ok(p) => p,
        Err(e) => {
            eprintln!("aura acp-proxy: cannot find the aura binary to record with: {e}");
            return 1;
        }
    };
    let label = agent.map(str::to_string).unwrap_or_else(|| label_for(program));
    let child = match spawn(program, args) {
        Ok(c) => c,
        Err(e) => {
            eprintln!("aura acp-proxy: failed to start `{program}`: {e}");
            return 127;
        }
    };
    let guard = Guard::new(LiveEffects::new(label, exe));
    let out = Arc::new(Mutex::new(io::stdout()));
    match relay(BufReader::new(io::stdin()), out, child, guard) {
        Ok(status) => status.code().unwrap_or(1),
        Err(e) => {
            eprintln!("aura acp-proxy: {e}");
            1
        }
    }
}

pub(crate) fn spawn(program: &str, args: &[String]) -> io::Result<Child> {
    spawn_with(program, args, &std::collections::BTreeMap::new())
}

/// [`spawn`] with extra environment, as a registry launch carries.
pub(crate) fn spawn_with(
    program: &str,
    args: &[String],
    env: &std::collections::BTreeMap<String, String>,
) -> io::Result<Child> {
    Command::new(program)
        .args(args)
        .envs(env)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::inherit())
        .spawn()
}

/// Who rows are attributed to when the caller did not say: the agent
/// program's own name, e.g. `gemini` for `/opt/bin/gemini`.
fn label_for(program: &str) -> String {
    std::path::Path::new(program)
        .file_name()
        .map(|n| n.to_string_lossy().to_string())
        .filter(|n| !n.is_empty())
        .unwrap_or_else(|| "acp-agent".to_string())
}

/// Decides, frame by frame, what crosses the relay. [`Guard`] is the
/// proxy's; `aura acp-serve` layers its own commands over one.
pub(crate) trait Filter: Send + 'static {
    fn from_client(&mut self, frame: &str) -> Step;
    fn from_agent(&mut self, frame: &str) -> Step;
}

impl<E: Effects + 'static> Filter for Guard<E> {
    fn from_client(&mut self, frame: &str) -> Step {
        Guard::from_client(self, frame)
    }
    fn from_agent(&mut self, frame: &str) -> Step {
        Guard::from_agent(self, frame)
    }
}

/// Relay frames between the client's pipes and the agent `child` until the
/// agent's stdout closes, then reap it. `client_out` is shared so a filter
/// that answers on its own time (a long-running local command) can write
/// to the same stream without tearing a frame.
///
/// The client→agent leg runs on its own thread and is not joined: it may be
/// parked on a read from a client that is still open, and the agent having
/// gone is the end of the conversation either way.
pub(crate) fn relay<F, R, W>(client_in: R, client_out: Arc<Mutex<W>>, mut child: Child, filter: F) -> io::Result<ExitStatus>
where
    F: Filter,
    R: BufRead + Send + 'static,
    W: Write + Send + 'static + ?Sized,
{
    let agent_out = child
        .stdout
        .take()
        .ok_or_else(|| io::Error::other("agent stdout was not piped"))?;
    let agent_in = Arc::new(Mutex::new(child.stdin.take()));
    let guard = Arc::new(Mutex::new(filter));

    {
        let (agent_in, client_out, guard) = (agent_in.clone(), client_out.clone(), guard.clone());
        thread::spawn(move || {
            let mut reader = client_in;
            let mut frame = Vec::new();
            loop {
                frame.clear();
                match reader.read_until(b'\n', &mut frame) {
                    Ok(0) | Err(_) => break,
                    Ok(_) => {}
                }
                let step = lock(&guard).from_client(&String::from_utf8_lossy(&frame));
                deliver(step, &frame, Side::Agent, &agent_in, &client_out);
            }
            // The client hung up: close the agent's stdin so it can finish.
            lock(&agent_in).take();
        });
    }

    let mut reader = BufReader::new(agent_out);
    let mut frame = Vec::new();
    loop {
        frame.clear();
        match reader.read_until(b'\n', &mut frame) {
            Ok(0) | Err(_) => break,
            Ok(_) => {}
        }
        let step = lock(&guard).from_agent(&String::from_utf8_lossy(&frame));
        deliver(step, &frame, Side::Client, &agent_in, &client_out);
    }
    child.wait()
}

/// Where a frame that is passed through goes.
enum Side {
    Agent,
    Client,
}

fn deliver<W: Write + ?Sized>(
    step: Step,
    frame: &[u8],
    pass_to: Side,
    agent_in: &Mutex<Option<std::process::ChildStdin>>,
    client_out: &Mutex<W>,
) {
    if step.pass {
        match pass_to {
            Side::Agent => {
                if let Some(w) = lock(agent_in).as_mut() {
                    write_frame(w, frame);
                }
            }
            Side::Client => write_frame(&mut *lock(client_out), frame),
        }
    }
    for line in step.extra {
        match line {
            To::Agent(l) => {
                if let Some(w) = lock(agent_in).as_mut() {
                    write_frame(w, l.as_bytes());
                }
            }
            To::Client(l) => write_frame(&mut *lock(client_out), l.as_bytes()),
        }
    }
}

/// Write one frame, ending it with the newline that delimits it if the
/// sender's last frame came without one.
pub(crate) fn write_frame<W: Write + ?Sized>(w: &mut W, frame: &[u8]) {
    let _ = w.write_all(frame);
    if !frame.ends_with(b"\n") {
        let _ = w.write_all(b"\n");
    }
    let _ = w.flush();
}

pub(crate) fn lock<T: ?Sized>(m: &Mutex<T>) -> MutexGuard<'_, T> {
    m.lock().unwrap_or_else(|e| e.into_inner())
}
