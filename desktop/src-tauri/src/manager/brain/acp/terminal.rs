//! Running the agent's shell commands *for* it.
//!
//! ACP's terminal methods are the same inversion as `fs/write_text_file`,
//! applied to processes: an agent that has them does not fork a shell of
//! its own, it asks the client to, and then reads the output back through
//! us. Advertising `terminal: true` is therefore not a convenience — it
//! moves every command the agent runs from inside its process to inside
//! ours, which is the only place Aura can gate it, scope it to the project
//! root, and end it when the session ends.
//!
//! Four properties this module is responsible for:
//!
//! 1. **argv, never a shell string.** The protocol hands over a program
//!    and an argument vector, and that is exactly what gets spawned. There
//!    is no interpolation step here for a quoting bug to live in.
//! 2. **The working directory cannot leave the project root.** `cwd` is a
//!    parameter the agent chooses, so it goes through the same
//!    [`resolve_within`] as every path the agent names.
//! 3. **Output is bounded.** A command that prints forever must not grow
//!    the app's heap forever, so the buffer keeps the tail and says it
//!    truncated — the tail being the half a build log's error is in.
//! 4. **Nothing outlives the session.** Dropping the registry kills every
//!    process still in it, so closing a conversation does not leave the
//!    agent's `npm run dev` running until logout.
//!
//! The permission gate itself is not here. It lives one layer up in
//! [`super::host`], with the gate every other agent request passes
//! through, so this module is only ever asked to run a command that has
//! already been allowed.

use std::collections::HashMap;
use std::path::PathBuf;
use std::process::Stdio;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};

use serde_json::{Value, json};
use tokio::io::AsyncReadExt;
use tokio::sync::{Notify, watch};

use super::host::resolve_within;

/// How much output we keep per terminal when the agent names no limit.
/// Large enough for a full test run, small enough that a runaway `yes`
/// costs a megabyte rather than a machine.
const DEFAULT_OUTPUT_LIMIT: usize = 1024 * 1024;

/// The most we will keep however much the agent asks for. The limit is the
/// agent's to choose, but the memory is ours to spend.
const MAX_OUTPUT_LIMIT: usize = 16 * 1024 * 1024;

/// How many terminals one session may hold open at once. An agent that
/// leaks them should hit a wall it can see rather than a machine that
/// slowly stops responding.
const MAX_TERMINALS: usize = 32;

/// How long we wait for a finished command's pipes to close before giving
/// up on the last of its output. See the drain in [`Terminals::create`].
const DRAIN_GRACE: std::time::Duration = std::time::Duration::from_millis(400);

/// How a process ended, in the shape ACP asks for it.
#[derive(Debug, Clone, Default, PartialEq)]
pub struct ExitInfo {
    pub code: Option<u32>,
    pub signal: Option<String>,
}

impl ExitInfo {
    fn to_json(&self) -> Value {
        json!({ "exitCode": self.code, "signal": self.signal })
    }
}

/// A bounded, append-only capture of one process's stdout and stderr.
///
/// The two streams share this buffer, so ordering between them is only as
/// good as the order the pipes were readable in — which is what a terminal
/// gives you anyway, and better than presenting them as two unrelated
/// blobs the agent has to reassemble.
struct Output {
    bytes: Vec<u8>,
    limit: usize,
    truncated: bool,
}

impl Output {
    fn new(limit: usize) -> Self {
        Self {
            bytes: Vec::new(),
            limit,
            truncated: false,
        }
    }

    fn push(&mut self, chunk: &[u8]) {
        self.bytes.extend_from_slice(chunk);
        if self.bytes.len() <= self.limit {
            return;
        }
        // Drop from the front: the end of a command's output is where the
        // error is, and an agent reading a truncated build log wants the
        // failure, not the banner.
        let mut cut = self.bytes.len() - self.limit;
        // Land on a character boundary so the survivor is still valid
        // UTF-8 rather than starting mid-codepoint.
        while cut < self.bytes.len() && (self.bytes[cut] & 0b1100_0000) == 0b1000_0000 {
            cut += 1;
        }
        self.bytes.drain(..cut);
        self.truncated = true;
    }

    fn text(&self) -> String {
        String::from_utf8_lossy(&self.bytes).into_owned()
    }
}

/// One running (or finished) command.
struct Terminal {
    /// What was spawned, kept for the error messages and for anyone asking
    /// what this terminal is.
    argv: Vec<String>,
    output: Arc<Mutex<Output>>,
    /// `None` until the process ends. Watched rather than polled so
    /// `terminal/wait_for_exit` costs nothing while it waits.
    exit: watch::Receiver<Option<ExitInfo>>,
    /// Notified to end the process early. Repeatable — a second kill on an
    /// already-dead terminal is a no-op, not an error.
    kill: Arc<Notify>,
}

/// Every terminal one ACP session has open.
pub struct Terminals {
    /// The session's root. A terminal's working directory must be inside
    /// it, for the same reason a write must be.
    root: PathBuf,
    live: Mutex<HashMap<String, Arc<Terminal>>>,
    next: AtomicU64,
}

impl Terminals {
    pub fn new(root: impl Into<PathBuf>) -> Self {
        Self {
            root: root.into(),
            live: Mutex::new(HashMap::new()),
            next: AtomicU64::new(1),
        }
    }

    /// The argv `params` is asking for, as a command line — what the
    /// permission card shows the human, and what the refusal quotes back.
    pub fn command_line(params: &Value) -> String {
        let command = params.get("command").and_then(Value::as_str).unwrap_or("");
        let args = string_list(params.get("args"));
        if args.is_empty() {
            command.to_string()
        } else {
            format!("{command} {}", args.join(" "))
        }
    }

    /// Spawn a command and hand back its terminal id.
    ///
    /// Returns as soon as the process exists — the output accumulates in
    /// the background, which is what lets the agent start a dev server and
    /// keep talking.
    pub fn create(&self, params: &Value) -> Result<Value, String> {
        let command = params
            .get("command")
            .and_then(Value::as_str)
            .filter(|c| !c.is_empty())
            .ok_or_else(|| "terminal/create: no command".to_string())?;
        let args = string_list(params.get("args"));

        // An absent cwd means the project root; a named one still has to
        // be inside it. `resolve_within` refuses rather than clamps, so an
        // agent that tried to run `make` in `~` is told it failed.
        let cwd = match params.get("cwd").and_then(Value::as_str) {
            Some(raw) => resolve_within(&self.root, Some(raw))?,
            None => self.root.clone(),
        };

        let limit = params
            .get("outputByteLimit")
            .and_then(Value::as_u64)
            .map(|n| (n as usize).min(MAX_OUTPUT_LIMIT))
            .unwrap_or(DEFAULT_OUTPUT_LIMIT)
            .max(1);

        {
            let live = self.live.lock().unwrap();
            if live.len() >= MAX_TERMINALS {
                return Err(format!(
                    "this session already has {MAX_TERMINALS} terminals open; \
                     release one before creating another"
                ));
            }
        }

        let mut cmd = tokio::process::Command::new(command);
        cmd.args(&args)
            .current_dir(&cwd)
            // The agent talks to us over JSON-RPC, not to the command's
            // stdin. A process that reads stdin gets EOF instead of
            // blocking forever on a pipe nobody will ever write to.
            .stdin(Stdio::null())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped());
        // Its own process group, so ending it ends everything it started.
        // `npm run dev` is a shell that forks node; killing only the shell
        // leaves the server holding the port — which is exactly the "the
        // session ended but the process didn't" failure this module exists
        // to prevent.
        #[cfg(unix)]
        cmd.process_group(0);
        for var in params.get("env").and_then(Value::as_array).into_iter().flatten() {
            if let (Some(name), Some(value)) = (
                var.get("name").and_then(Value::as_str),
                var.get("value").and_then(Value::as_str),
            ) {
                cmd.env(name, value);
            }
        }

        let mut child = cmd
            .spawn()
            .map_err(|e| format!("could not run `{}`: {e}", Self::command_line(params)))?;

        let output = Arc::new(Mutex::new(Output::new(limit)));
        let (exit_tx, exit_rx) = watch::channel(None);
        let kill = Arc::new(Notify::new());

        let mut readers = Vec::new();
        if let Some(out) = child.stdout.take() {
            readers.push(tokio::spawn(pump(out, output.clone())));
        }
        if let Some(err) = child.stderr.take() {
            readers.push(tokio::spawn(pump(err, output.clone())));
        }

        let pid = child.id().map(|p| p as i32);
        let kill_signal = kill.clone();
        tokio::spawn(async move {
            let status = tokio::select! {
                s = child.wait() => s,
                _ = kill_signal.notified() => {
                    end_group(pid);
                    let _ = child.start_kill();
                    child.wait().await
                }
            };
            // Drain the pipes before announcing the exit. Publishing first
            // would let a `wait_for_exit` followed immediately by an
            // `output` miss the last thing the command printed — which is
            // usually the only line that mattered.
            //
            // Bounded, because the pipes are only guaranteed to close when
            // every holder of them is gone, and a process that double-forks
            // out of its own group can still be holding one. Losing the
            // last few bytes of a runaway command is a far smaller failure
            // than a turn that never ends.
            let drained = tokio::time::timeout(DRAIN_GRACE, async {
                for reader in &mut readers {
                    let _ = reader.await;
                }
            })
            .await;
            if drained.is_err() {
                for reader in readers {
                    reader.abort();
                }
            }
            let info = match status {
                Ok(s) => exit_info(s),
                // We failed to reap it. It has ended — we just cannot say
                // how, and inventing an exit code would be worse than an
                // empty one.
                Err(_) => ExitInfo::default(),
            };
            let _ = exit_tx.send(Some(info));
        });

        let id = format!("term-{}", self.next.fetch_add(1, Ordering::Relaxed));
        let mut argv = vec![command.to_string()];
        argv.extend(args);
        self.live.lock().unwrap().insert(
            id.clone(),
            Arc::new(Terminal {
                argv,
                output,
                exit: exit_rx,
                kill,
            }),
        );
        Ok(json!({ "terminalId": id }))
    }

    /// The output so far, and the exit status if it has one.
    pub fn output(&self, params: &Value) -> Result<Value, String> {
        let term = self.get(params)?;
        let (text, truncated) = {
            let held = term.output.lock().unwrap();
            (held.text(), held.truncated)
        };
        let exit = term.exit.borrow().clone();
        Ok(json!({
            "output": text,
            "truncated": truncated,
            "exitStatus": exit.as_ref().map(ExitInfo::to_json),
        }))
    }

    /// Block until the process ends, then report how.
    ///
    /// This is served off the stream-pumping loop, so a command that takes
    /// ten minutes holds nothing up but the agent's own turn.
    pub async fn wait_for_exit(&self, params: &Value) -> Result<Value, String> {
        let term = self.get(params)?;
        let mut exit = term.exit.clone();
        // Already finished: the current value is the answer and there will
        // be no further change to wait for.
        if let Some(info) = exit.borrow().clone() {
            return Ok(info.to_json());
        }
        while exit.changed().await.is_ok() {
            if let Some(info) = exit.borrow().clone() {
                return Ok(info.to_json());
            }
        }
        // The sender is gone without ever publishing — the task that owns
        // the process was dropped, which only happens on shutdown.
        Ok(ExitInfo::default().to_json())
    }

    /// End the process, keeping the terminal so its output is still
    /// readable. Killing something already dead is not an error.
    pub fn kill(&self, params: &Value) -> Result<Value, String> {
        self.get(params)?.kill.notify_one();
        Ok(json!({}))
    }

    /// Forget the terminal. Anything still running is killed with it —
    /// releasing a handle to a process nobody can reach again would leave
    /// it running with no way to stop it.
    pub fn release(&self, params: &Value) -> Result<Value, String> {
        let id = terminal_id(params)?;
        match self.live.lock().unwrap().remove(&id) {
            Some(term) => {
                term.kill.notify_one();
                Ok(json!({}))
            }
            None => Err(format!("no terminal called `{id}`")),
        }
    }

    /// The output of a terminal by id, for rendering the agent's tool card.
    /// Cheap and synchronous on purpose: it is called from the update
    /// mapping, which is not async.
    pub fn text_of(&self, id: &str) -> Option<String> {
        let term = self.live.lock().unwrap().get(id).cloned()?;
        let held = term.output.lock().unwrap();
        Some(held.text())
    }

    /// What a terminal is running, for a message about it.
    pub fn argv_of(&self, id: &str) -> Option<Vec<String>> {
        let live = self.live.lock().unwrap();
        live.get(id).map(|t| t.argv.clone())
    }

    fn get(&self, params: &Value) -> Result<Arc<Terminal>, String> {
        let id = terminal_id(params)?;
        self.live
            .lock()
            .unwrap()
            .get(&id)
            .cloned()
            .ok_or_else(|| format!("no terminal called `{id}`"))
    }
}

impl Drop for Terminals {
    fn drop(&mut self) {
        // The session is over. Nothing it started should still be running.
        if let Ok(live) = self.live.lock() {
            for term in live.values() {
                term.kill.notify_one();
            }
        }
    }
}

fn terminal_id(params: &Value) -> Result<String, String> {
    params
        .get("terminalId")
        .and_then(Value::as_str)
        .filter(|s| !s.is_empty())
        .map(str::to_string)
        .ok_or_else(|| "no terminalId given".to_string())
}

fn string_list(v: Option<&Value>) -> Vec<String> {
    v.and_then(Value::as_array)
        .map(|items| {
            items
                .iter()
                .filter_map(Value::as_str)
                .map(str::to_string)
                .collect()
        })
        .unwrap_or_default()
}

/// Read one pipe to EOF into the shared buffer.
async fn pump<R>(mut reader: R, into: Arc<Mutex<Output>>)
where
    R: AsyncReadExt + Unpin,
{
    let mut buf = [0u8; 8192];
    loop {
        match reader.read(&mut buf).await {
            Ok(0) | Err(_) => return,
            Ok(n) => into.lock().unwrap().push(&buf[..n]),
        }
    }
}

/// Signal the whole process group the command leads.
///
/// Killing the direct child is not enough: a shell that forked a server
/// leaves the server running with the pipe still open. The group is the
/// unit that was started, so it is the unit that ends.
///
/// The guard is the same one [`crate::pty_reap`] uses and for the same
/// reason — a bug that resolved the group to our own would take the app
/// down with the command.
#[cfg(unix)]
fn end_group(pid: Option<i32>) {
    let Some(pid) = pid.filter(|p| *p > 1) else {
        return;
    };
    let pgid = unsafe { libc::getpgid(pid) };
    let pgid = if pgid > 0 { pgid } else { pid };
    let own = unsafe { libc::getpgrp() };
    if pgid <= 1 || pgid == own {
        return;
    }
    // SIGKILL rather than SIGTERM: this runs because the human refused the
    // command, closed the conversation, or the agent asked us to stop it.
    // None of those want a process that gets to ignore the request.
    unsafe { libc::killpg(pgid, libc::SIGKILL) };
}

/// Windows has no process groups to signal; `start_kill` on the child is
/// the whole of what we can do there.
#[cfg(not(unix))]
fn end_group(_pid: Option<i32>) {}

fn exit_info(status: std::process::ExitStatus) -> ExitInfo {
    #[cfg(unix)]
    let signal = {
        use std::os::unix::process::ExitStatusExt;
        status.signal().map(signal_name)
    };
    #[cfg(not(unix))]
    let signal = None;

    ExitInfo {
        // A process ended by a signal has no code, and ACP's code is
        // unsigned, so a negative one is dropped rather than wrapped into
        // a nonsense 4-billion.
        code: status.code().and_then(|c| u32::try_from(c).ok()),
        signal,
    }
}

#[cfg(unix)]
fn signal_name(n: i32) -> String {
    match n {
        1 => "SIGHUP",
        2 => "SIGINT",
        3 => "SIGQUIT",
        6 => "SIGABRT",
        9 => "SIGKILL",
        11 => "SIGSEGV",
        13 => "SIGPIPE",
        15 => "SIGTERM",
        _ => return n.to_string(),
    }
    .to_string()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn root() -> PathBuf {
        let dir = std::env::temp_dir().join(format!("aura-acp-term-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        // The root has to be resolved the same way `resolve_within` will
        // resolve it, or macOS's `/tmp` → `/private/tmp` symlink makes
        // every path look like an escape.
        std::fs::canonicalize(&dir).unwrap()
    }

    async fn run(t: &Terminals, params: Value) -> Value {
        let created = t.create(&params).expect("spawns");
        let id = created["terminalId"].as_str().unwrap().to_string();
        let wait = json!({ "terminalId": id });
        t.wait_for_exit(&wait).await.unwrap();
        t.output(&wait).unwrap()
    }

    #[tokio::test]
    async fn a_command_runs_and_its_output_comes_back_with_the_exit_code() {
        let t = Terminals::new(root());
        let out = run(
            &t,
            json!({"command": "sh", "args": ["-c", "echo hello; echo oops >&2"]}),
        )
        .await;

        let text = out["output"].as_str().unwrap();
        assert!(text.contains("hello"), "stdout is captured: {text:?}");
        assert!(
            text.contains("oops"),
            "stderr is captured too — a command that only fails on stderr \
             must not look like it printed nothing: {text:?}"
        );
        assert_eq!(out["exitStatus"]["exitCode"], json!(0));
        assert_eq!(out["truncated"], json!(false));
    }

    #[tokio::test]
    async fn a_failing_command_reports_its_code_rather_than_an_error() {
        let t = Terminals::new(root());
        let out = run(&t, json!({"command": "sh", "args": ["-c", "exit 3"]})).await;
        assert_eq!(
            out["exitStatus"]["exitCode"],
            json!(3),
            "a non-zero exit is a result the agent reads, not a transport failure"
        );
    }

    #[tokio::test]
    async fn a_command_that_does_not_exist_fails_at_create_naming_itself() {
        let t = Terminals::new(root());
        let err = t
            .create(&json!({"command": "aura-no-such-binary", "args": ["--x"]}))
            .unwrap_err();
        assert!(
            err.contains("aura-no-such-binary --x"),
            "the refusal should quote what it tried to run: {err}"
        );
    }

    #[tokio::test]
    async fn output_is_bounded_and_says_so() {
        let t = Terminals::new(root());
        let out = run(
            &t,
            json!({
                "command": "sh",
                "args": ["-c", "for i in $(seq 1 2000); do echo 0123456789; done"],
                "outputByteLimit": 200,
            }),
        )
        .await;

        let text = out["output"].as_str().unwrap();
        assert!(text.len() <= 200, "kept {} bytes for a 200 limit", text.len());
        assert_eq!(out["truncated"], json!(true));
        assert!(
            text.contains("0123456789"),
            "the tail is what survives, and it is still readable: {text:?}"
        );
    }

    #[tokio::test]
    async fn truncation_leaves_valid_text_when_the_output_is_not_ascii() {
        let t = Terminals::new(root());
        // Each `é` is two bytes, so an even byte limit lands mid-codepoint
        // unless the cut is realigned.
        let out = run(
            &t,
            json!({
                "command": "sh",
                "args": ["-c", "for i in $(seq 1 200); do printf 'é'; done"],
                "outputByteLimit": 21,
            }),
        )
        .await;
        let text = out["output"].as_str().unwrap();
        assert!(
            !text.contains('\u{FFFD}'),
            "a truncated buffer must not start mid-character: {text:?}"
        );
    }

    #[tokio::test]
    async fn a_terminal_can_be_killed_and_still_read_afterwards() {
        let t = Terminals::new(root());
        let created = t
            .create(&json!({
                "command": "sh",
                "args": ["-c", "echo started; sleep 60"],
            }))
            .expect("spawns");
        let id = created["terminalId"].as_str().unwrap().to_string();
        let handle = json!({ "terminalId": id });

        // Give it long enough to print, but the assertion below is on the
        // kill, not on the timing.
        tokio::time::sleep(std::time::Duration::from_millis(300)).await;
        t.kill(&handle).unwrap();

        let exit = tokio::time::timeout(
            std::time::Duration::from_secs(10),
            t.wait_for_exit(&handle),
        )
        .await
        .expect("a killed command stops waiting")
        .unwrap();
        assert!(
            exit["signal"].is_string() || exit["exitCode"].is_number(),
            "a killed process still reports how it ended: {exit}"
        );

        let out = t.output(&handle).unwrap();
        assert!(
            out["output"].as_str().unwrap().contains("started"),
            "killing ends the process, it does not discard what it said"
        );
    }

    #[tokio::test]
    async fn releasing_a_terminal_forgets_it() {
        let t = Terminals::new(root());
        let created = t.create(&json!({"command": "sh", "args": ["-c", "sleep 30"]})).unwrap();
        let handle = json!({ "terminalId": created["terminalId"].clone() });
        t.release(&handle).unwrap();
        assert!(
            t.output(&handle).is_err(),
            "a released terminal is gone, not silently empty"
        );
        assert!(t.release(&handle).is_err());
    }

    #[tokio::test]
    async fn a_working_directory_outside_the_project_is_refused() {
        let t = Terminals::new(root());
        let err = t
            .create(&json!({"command": "sh", "args": ["-c", "pwd"], "cwd": "../.."}))
            .unwrap_err();
        assert!(
            err.contains("escapes the project root"),
            "an agent cannot pick where the command runs: {err}"
        );
    }

    #[tokio::test]
    async fn the_environment_the_agent_names_reaches_the_command() {
        let t = Terminals::new(root());
        let out = run(
            &t,
            json!({
                "command": "sh",
                "args": ["-c", "echo $AURA_TEST_VAR"],
                "env": [{"name": "AURA_TEST_VAR", "value": "wired"}],
            }),
        )
        .await;
        assert!(out["output"].as_str().unwrap().contains("wired"));
    }

    #[tokio::test]
    async fn unknown_terminal_ids_are_named_rather_than_ignored() {
        let t = Terminals::new(root());
        let handle = json!({ "terminalId": "term-999" });
        for err in [
            t.output(&handle).unwrap_err(),
            t.kill(&handle).unwrap_err(),
            t.release(&handle).unwrap_err(),
        ] {
            assert!(err.contains("term-999"), "{err}");
        }
        assert!(t.wait_for_exit(&handle).await.is_err());
    }

    #[tokio::test]
    async fn a_session_that_ends_takes_its_processes_with_it() {
        let root = root();
        let marker = root.join("still-running");
        let _ = std::fs::remove_file(&marker);

        let t = Terminals::new(&root);
        t.create(&json!({
            "command": "sh",
            "args": ["-c", "sleep 2; touch still-running"],
        }))
        .unwrap();
        drop(t);

        // If the drop did not kill it, the file appears within two seconds.
        tokio::time::sleep(std::time::Duration::from_millis(3500)).await;
        assert!(
            !marker.exists(),
            "closing the session must not leave the agent's commands running"
        );
    }

    /// The property the direct-child test above does not reach. An agent
    /// runs `npm run dev`, which is a shell that forks a server; killing
    /// only the shell leaves the server holding the port. The process
    /// group is what was started, so it has to be what ends.
    #[cfg(unix)]
    #[tokio::test]
    async fn ending_a_terminal_ends_what_the_command_started_too() {
        let root = root();
        let marker = root.join("grandchild-ran");
        let _ = std::fs::remove_file(&marker);

        let t = Terminals::new(&root);
        let created = t
            .create(&json!({
                "command": "sh",
                // The inner shell outlives the outer one's foreground work,
                // which is exactly the dev-server shape.
                "args": ["-c", "sh -c 'sleep 2; touch grandchild-ran' & sleep 30"],
            }))
            .unwrap();
        let handle = json!({ "terminalId": created["terminalId"].clone() });

        tokio::time::sleep(std::time::Duration::from_millis(300)).await;
        t.kill(&handle).unwrap();

        tokio::time::sleep(std::time::Duration::from_millis(3000)).await;
        assert!(
            !marker.exists(),
            "killing the terminal must reach the whole process group, not \
             just the process we happened to spawn"
        );
    }

    #[tokio::test]
    async fn a_session_will_not_hold_unbounded_terminals() {
        let t = Terminals::new(root());
        for _ in 0..MAX_TERMINALS {
            t.create(&json!({"command": "sh", "args": ["-c", "sleep 30"]}))
                .unwrap();
        }
        let err = t
            .create(&json!({"command": "sh", "args": ["-c", "true"]}))
            .unwrap_err();
        assert!(err.contains("release one"), "{err}");
    }

    #[test]
    fn the_command_line_is_what_the_human_is_asked_about() {
        assert_eq!(
            Terminals::command_line(&json!({"command": "git", "args": ["push", "--force"]})),
            "git push --force"
        );
        assert_eq!(Terminals::command_line(&json!({"command": "ls"})), "ls");
    }
}
