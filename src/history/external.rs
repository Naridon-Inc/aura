//! A dialect that is a program, for an agent whose history we cannot describe.
//!
//! # Why
//!
//! [`super::manifest`] covers an agent that writes one JSONL transcript per
//! session, and says plainly what it cannot cover: a transcript in SQLite, in
//! Protobuf, or spread across several files that have to be joined. Its own
//! answer for those was "that agent needs a Rust dialect in this tree" — which
//! means editing Aura, building Aura and shipping Aura, and the person whose
//! agent keeps a SQLite database is back to waiting for us.
//!
//! This is the other half. A manifest can name a **program** instead of a
//! glob. Aura asks that program the same three questions the trait asks every
//! dialect — where are the sessions, how big is this one, what did the person
//! type — and the program answers with JSON. Whatever it has to do to find
//! out is its own business: open a database, join four files, shell to the
//! agent's own CLI.
//!
//! The protocol is deliberately small enough to implement in a shell script,
//! because "anyone can add their agent in an afternoon" is the only version of
//! this that is worth having.
//!
//! # The three verbs
//!
//! The verb is the program's last argument; the payload is JSON on stdin, and
//! the answer is JSON on stdout. Every request carries `{"aura": 1}` so a
//! program can refuse a shape it does not know.
//!
//! ```text
//! prog … index     {"aura":1,"scope":{"repo_root":"/path"|null,"active_after":1730…|null}}
//!                  → {"sessions":[ <session>, … ]}
//!
//! prog … count     {"aura":1,"session":<session>}
//!                  → {"session":<session>}          # the same session, with counts
//!
//! prog … prompts   {"aura":1,"session":<session>}
//!                  → {"prompts":[{"at":1730…,"text":"…"}, …]}   # oldest first
//! ```
//!
//! A `<session>` is the shape [`Session::to_json`] already emits, so the wire
//! format is not a second spelling of anything: a program can be checked
//! against what the built-in dialects produce.
//!
//! `index` is the one that has to be cheap — it is what `aura why` runs to find
//! one session, and it must honour the scope it is given. Counts belong to
//! `count`, which is called per session only when a caller actually wants them.
//!
//! # Guards
//!
//! A dialect is read on the path of every history command, so a program that
//! misbehaves must not be able to take `aura why` down with it:
//!
//! * **A deadline.** Default five seconds per call, `timeout_ms` in the
//!   manifest, capped at a minute. Past it the child is killed.
//! * **A ceiling on the answer.** [`MAX_OUTPUT`] bytes of stdout, after which
//!   the call fails rather than growing a buffer until the machine swaps.
//! * **Failure is silence, not a crash.** The trait returns lists, so a
//!   program that exits non-zero or prints something unparsable reads as "no
//!   sessions" to the commands that merely want history. [`History::probe`] is
//!   where the reason is available, and `aura dialects` is what calls it —
//!   that is the command a person runs when their manifest is not working.
//!
//! # Trust
//!
//! This runs a program as you. It runs **only** a program you named in a
//! manifest you wrote: nothing here scans `PATH` for a magic prefix, so a
//! binary landing on your `PATH` cannot make itself part of Aura. The child
//! gets no credential from us — it inherits the environment, as any program
//! you run from your shell does, and we add nothing to it.
//!
//! Prompt text is the person's own words. Same rule as every dialect: this
//! returns owned strings to a caller that decides what to show, and nothing
//! here opens a socket. What the program does is the program's to answer for,
//! which is the honest reason it has to be something you chose by name.

use std::io::{Read, Write};
use std::path::PathBuf;
use std::process::{Child, Command, Stdio};
use std::sync::Mutex;
use std::time::{Duration, Instant};

use serde::Deserialize;

use super::{History, Prompt, Scope, Session};

/// The most stdout we will hold from one call.
///
/// A whole machine's session index is tens of kilobytes; a transcript's prompts
/// are less. Thirty-two mebibytes is far past any honest answer and still small
/// enough that a program stuck in a print loop is a failed call rather than a
/// dead laptop.
const MAX_OUTPUT: usize = 32 * 1024 * 1024;

const DEFAULT_TIMEOUT_MS: u64 = 5_000;
/// No call may be given longer than this, whatever the manifest asks for. A
/// dialect is on the path of interactive commands; a minute is already a
/// generous reading of "cheap".
const MAX_TIMEOUT_MS: u64 = 60_000;

/// How often we look to see whether the child has finished. Short enough that a
/// fast program is not held up by the poll, long enough not to spin a core.
const POLL: Duration = Duration::from_millis(5);

/// What a manifest says when it names a program rather than a transcript.
#[derive(Debug, Clone, Deserialize)]
pub struct ExternalSpec {
    /// Lower-case, stable. Must match the hook dialect id if the agent also
    /// writes intent rows, or the two halves will not join up.
    pub id: String,
    pub display: String,
    /// The program to run. A leading `~` is `$HOME`. A bare name is resolved
    /// by the OS against `PATH`, which is the one case where `PATH` matters —
    /// and it is still a name you wrote down.
    pub program: String,
    /// Arguments before the verb. For a program that is really a subcommand of
    /// something else, or that needs a flag to speak this protocol.
    #[serde(default)]
    pub args: Vec<String>,
    /// Per-call deadline. Clamped to [`MAX_TIMEOUT_MS`].
    #[serde(default)]
    pub timeout_ms: Option<u64>,
}

impl ExternalSpec {
    /// Read one spec, or say why it cannot be used.
    pub fn check(&self) -> Result<(), String> {
        if self.id.trim().is_empty() {
            return Err("`id` is empty".into());
        }
        if self.id.chars().any(|c| !c.is_ascii_alphanumeric() && c != '-' && c != '_') {
            return Err(format!(
                "`id` must be letters, digits, `-` or `_`; got {:?}",
                self.id
            ));
        }
        if self.display.trim().is_empty() {
            return Err("`display` is empty".into());
        }
        if self.program.trim().is_empty() {
            return Err("`program` is empty".into());
        }
        Ok(())
    }

    fn timeout(&self) -> Duration {
        Duration::from_millis(self.timeout_ms.unwrap_or(DEFAULT_TIMEOUT_MS).min(MAX_TIMEOUT_MS))
    }

    /// The program's path with `~` expanded. Not canonicalised: a bare name is
    /// meant to go to the OS resolver.
    fn program_path(&self) -> PathBuf {
        expand_home(&self.program)
    }
}

/// `~/x` → `$HOME/x`. Anything else is returned as written.
fn expand_home(raw: &str) -> PathBuf {
    match raw.strip_prefix("~/") {
        Some(rest) => match super::home() {
            Some(h) => h.join(rest),
            None => PathBuf::from(raw),
        },
        None => PathBuf::from(raw),
    }
}

/// An [`ExternalSpec`] wearing the same trait as the compiled dialects.
pub struct ExternalDialect {
    spec: ExternalSpec,
    /// Leaked once at load, for the same reason [`super::manifest`] leaks
    /// its own: the trait's ids are `&'static str` because the compiled
    /// dialects are compile-time constants, and a manifest's are not. Bounded
    /// by the number of files in the dialects directory.
    id: &'static str,
    display: &'static str,
    /// Why the last call failed, if one did. The trait's methods return lists,
    /// so this is where a reason survives to be printed by `aura dialects`
    /// instead of being swallowed with the error.
    last_error: Mutex<Option<String>>,
}

impl ExternalDialect {
    pub fn new(spec: ExternalSpec) -> Self {
        let id: &'static str = Box::leak(spec.id.clone().into_boxed_str());
        let display: &'static str = Box::leak(spec.display.clone().into_boxed_str());
        Self { spec, id, display, last_error: Mutex::new(None) }
    }

    fn note(&self, e: Result<serde_json::Value, String>) -> Option<serde_json::Value> {
        match e {
            Ok(v) => {
                if let Ok(mut g) = self.last_error.lock() {
                    *g = None;
                }
                Some(v)
            }
            Err(msg) => {
                if let Ok(mut g) = self.last_error.lock() {
                    *g = Some(msg);
                }
                None
            }
        }
    }

    /// Run one verb and parse its answer.
    ///
    /// `cwd` is set to the repo the caller asked about when there is one, so a
    /// program that wants to shell to git does not have to be told twice where
    /// it is standing.
    fn ask(
        &self,
        verb: &str,
        payload: serde_json::Value,
        cwd: Option<&PathBuf>,
    ) -> Result<serde_json::Value, String> {
        let mut cmd = Command::new(self.spec.program_path());
        cmd.args(&self.spec.args)
            .arg(verb)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped());
        if let Some(dir) = cwd.filter(|d| d.is_dir()) {
            cmd.current_dir(dir);
        }

        let mut child = cmd.spawn().map_err(|e| {
            format!("`{}` could not be run: {e}", self.spec.program)
        })?;

        // Requests are a scope or one session — hundreds of bytes, far inside
        // a pipe buffer — so this cannot block on a child that reads late.
        let body = serde_json::to_vec(&payload).unwrap_or_default();
        if let Some(mut stdin) = child.stdin.take() {
            let _ = stdin.write_all(&body);
            // Dropped here, not at the end of the call: a program that reads
            // to EOF would otherwise wait for us while we wait for it.
        }

        let out = read_capped(&mut child, self.spec.timeout(), &self.spec.program)?;
        let text = String::from_utf8_lossy(&out);
        serde_json::from_str(&text).map_err(|e| {
            let head: String = text.chars().take(200).collect();
            format!("`{} {verb}` did not print JSON: {e} — got {head:?}", self.spec.program)
        })
    }
}

/// Collect a child's stdout under a ceiling and a deadline, then insist it
/// exited cleanly.
///
/// The read happens on a thread of its own and the clock stays on this one,
/// because a `read` from a pipe blocks until there is something to read: a
/// program that prints nothing and does not exit would otherwise hold this
/// thread inside `read` forever, with the deadline a line of code away and
/// never reached. One thread per call is affordable — three short calls per
/// program dialect per command — and it is the only portable way to put a
/// deadline on a blocking read. The alternative, a non-blocking pipe, is
/// `fcntl` on Unix and something else on Windows, for a program we are about
/// to kill anyway.
///
/// Draining on that thread also keeps a program that fills the pipe from
/// deadlocking against a parent that is only watching the clock.
fn read_capped(child: &mut Child, limit: Duration, name: &str) -> Result<Vec<u8>, String> {
    let deadline = Instant::now() + limit;
    let (tx, rx) = std::sync::mpsc::channel::<Result<Vec<u8>, String>>();

    match child.stdout.take() {
        Some(mut pipe) => {
            let who = name.to_string();
            std::thread::spawn(move || {
                let mut buf = Vec::new();
                let mut chunk = [0u8; 8192];
                let out = loop {
                    match pipe.read(&mut chunk) {
                        // EOF: the child closed stdout, which it does when it
                        // exits and which is the end of the answer.
                        Ok(0) => break Ok(buf),
                        Ok(n) => {
                            if buf.len() + n > MAX_OUTPUT {
                                break Err(format!(
                                    "`{who}` printed more than {} MiB",
                                    MAX_OUTPUT / (1024 * 1024)
                                ));
                            }
                            buf.extend_from_slice(&chunk[..n]);
                        }
                        Err(e) => break Err(format!("`{who}` could not be read: {e}")),
                    }
                };
                // Nobody left to tell is fine: this call already timed out and
                // the receiver is gone.
                let _ = tx.send(out);
            });
        }
        // No pipe to read. Not a failure on its own — the exit status below is
        // what decides — and an empty body fails to parse with a real message.
        None => {
            let _ = tx.send(Ok(Vec::new()));
        }
    }

    let buf = loop {
        match rx.try_recv() {
            Ok(Ok(buf)) => break buf,
            Ok(Err(e)) => {
                // Over the ceiling, or an unreadable pipe. Either way the child
                // may be blocked writing into a pipe nobody is draining.
                let _ = child.kill();
                let _ = child.wait();
                return Err(e);
            }
            // The reader thread is gone without a word — it cannot send and
            // then not send — so treat it as nothing printed and let the exit
            // status speak.
            Err(std::sync::mpsc::TryRecvError::Disconnected) => break Vec::new(),
            Err(std::sync::mpsc::TryRecvError::Empty) => {}
        }
        if Instant::now() >= deadline {
            let _ = child.kill();
            let _ = child.wait();
            return Err(format!("`{name}` did not answer within {} ms", limit.as_millis()));
        }
        std::thread::sleep(POLL);
    };

    // stdout is closed, so the child is on its way out; wait for the status,
    // still under the same deadline, because "closed stdout and kept running"
    // is a thing a program can do.
    loop {
        match child.try_wait() {
            Ok(Some(status)) => {
                if status.success() {
                    return Ok(buf);
                }
                let why = stderr_tail(child);
                let code =
                    status.code().map(|c| c.to_string()).unwrap_or_else(|| "a signal".into());
                return Err(match why {
                    Some(w) => format!("`{name}` exited with {code}: {w}"),
                    None => format!("`{name}` exited with {code}"),
                });
            }
            Ok(None) => {}
            Err(e) => return Err(format!("`{name}` could not be waited for: {e}")),
        }
        if Instant::now() >= deadline {
            let _ = child.kill();
            let _ = child.wait();
            return Err(format!("`{name}` did not exit within {} ms", limit.as_millis()));
        }
        std::thread::sleep(POLL);
    }
}

/// The end of a failed child's stderr, for the error message. Truncated: this
/// goes in a one-line report, not a log.
fn stderr_tail(child: &mut Child) -> Option<String> {
    let pipe = child.stderr.take()?;
    let mut s = String::new();
    let mut buf = Vec::new();
    pipe.take(8192).read_to_end(&mut buf).ok()?;
    s.push_str(String::from_utf8_lossy(&buf).trim());
    if s.is_empty() {
        return None;
    }
    let line = s.lines().last().unwrap_or("").trim().to_string();
    Some(if line.chars().count() > 200 {
        line.chars().take(200).collect()
    } else {
        line
    })
}

/// Read a session off the wire.
///
/// Everything but the id is optional, because a program that knows less than
/// a built-in dialect should be able to say so rather than invent a value.
/// `cwd` absent means *this session does not say where it ran*, which
/// [`Scope::keeps`] already treats as "do not claim it for this repo".
fn session_from(v: &serde_json::Value, dialect: &'static str) -> Option<Session> {
    let id = v.get("id")?.as_str()?.trim().to_string();
    if id.is_empty() {
        return None;
    }
    let s = |k: &str| v.get(k).and_then(|x| x.as_str()).map(str::to_string);
    let n = |k: &str| v.get(k).and_then(|x| x.as_u64());
    Some(Session {
        dialect,
        id,
        cwd: s("cwd"),
        cwd_digest: s("cwd_digest"),
        branch: s("branch"),
        title: s("title"),
        started_at: n("started_at").unwrap_or(0),
        last_activity_at: n("last_activity_at").unwrap_or(0),
        prompts: n("prompts").map(|x| x as usize),
        steps: n("steps").map(|x| x as usize),
        // Informational for a program-backed session: the program does its own
        // reading, and some of them have no single file to point at.
        path: s("path").map(PathBuf::from).unwrap_or_default(),
    })
}

fn scope_json(scope: &Scope) -> serde_json::Value {
    serde_json::json!({
        "aura": 1,
        "scope": {
            "repo_root": scope.repo_root.as_ref().map(|p| p.to_string_lossy().to_string()),
            "active_after": scope.active_after,
        },
    })
}

impl History for ExternalDialect {
    fn id(&self) -> &'static str {
        self.id
    }

    fn display(&self) -> &'static str {
        self.display
    }

    /// The program, when it is there to be run.
    ///
    /// For a directory-backed dialect this answers "where is the history"; for
    /// a program there is no such place to name — the program knows and we do
    /// not. What the caller actually needs from it is whether this dialect can
    /// be used on this machine, and for a program that is exactly whether the
    /// program exists. A bare name is left to the OS resolver, so it reads as
    /// present and a wrong name surfaces through [`History::probe`] instead.
    fn root(&self) -> Option<PathBuf> {
        let p = self.spec.program_path();
        if p.components().count() > 1 || self.spec.program.starts_with('.') {
            return p.is_file().then_some(p);
        }
        Some(p)
    }

    /// Why the last call failed, for a command reporting on work already
    /// done. Cleared by a call that succeeds.
    fn last_error(&self) -> Option<String> {
        self.last_error.lock().ok().and_then(|g| g.clone())
    }

    fn probe(&self) -> Result<(), String> {
        // The cheapest real question: an empty scope over no repo. A program
        // that answers this at all is wired up correctly.
        self.ask("index", scope_json(&Scope::all()), None).map(|_| ())
    }

    fn index(&self, scope: &Scope) -> Vec<Session> {
        let Some(v) = self.note(self.ask("index", scope_json(scope), scope.repo_root.as_ref()))
        else {
            return Vec::new();
        };
        let Some(rows) = v.get("sessions").and_then(|s| s.as_array()) else {
            return Vec::new();
        };
        rows.iter()
            .filter_map(|r| session_from(r, self.id))
            // The scope is a request, not a promise. A program that ignores it
            // does not get to widen what the caller asked for.
            .filter(|s| scope.keeps(s))
            .collect()
    }

    fn count(&self, session: Session) -> Session {
        let payload = serde_json::json!({ "aura": 1, "session": session.to_json() });
        let answered = self
            .note(self.ask("count", payload, None))
            .and_then(|v| v.get("session").cloned())
            .and_then(|v| session_from(&v, self.id));
        match answered {
            // Its own id or nothing: a program answering about a different
            // session is a bug we must not paper over by returning its answer
            // under the id the caller asked about.
            Some(s) if s.id == session.id => s,
            _ => session,
        }
    }

    fn prompts(&self, session: &Session) -> Vec<Prompt> {
        let payload = serde_json::json!({ "aura": 1, "session": session.to_json() });
        let Some(v) = self.note(self.ask("prompts", payload, None)) else {
            return Vec::new();
        };
        let Some(rows) = v.get("prompts").and_then(|p| p.as_array()) else {
            return Vec::new();
        };
        let mut out: Vec<Prompt> = rows
            .iter()
            .filter_map(|r| {
                let text = r.get("text")?.as_str()?.to_string();
                if text.is_empty() {
                    return None;
                }
                Some(Prompt { at: r.get("at").and_then(|a| a.as_u64()).unwrap_or(0), text })
            })
            .collect();
        // Oldest first is the contract every caller reads against, and it is
        // cheaper to sort here than to trust each program to have done it.
        // Rows with no clock keep the order the program gave them.
        out.sort_by_key(|p| p.at);
        out
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::Path;

    /// A program that prints `body` for every verb, written into `dir`.
    fn fake(dir: &Path, name: &str, script: &str) -> PathBuf {
        let path = dir.join(name);
        std::fs::write(&path, script).unwrap();
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o755)).unwrap();
        }
        path
    }

    fn dialect(program: &Path) -> ExternalDialect {
        ExternalDialect::new(ExternalSpec {
            id: "fake".into(),
            display: "Fake Agent".into(),
            program: program.to_string_lossy().to_string(),
            args: Vec::new(),
            timeout_ms: Some(4_000),
        })
    }

    #[test]
    fn a_program_answers_the_three_questions() {
        let dir = tempfile::tempdir().unwrap();
        let p = fake(
            dir.path(),
            "ok.sh",
            r#"#!/bin/sh
case "$1" in
  index)   echo '{"sessions":[{"id":"s1","cwd":"/tmp/repo","started_at":10,"last_activity_at":20}]}' ;;
  count)   echo '{"session":{"id":"s1","cwd":"/tmp/repo","prompts":3,"steps":9}}' ;;
  prompts) echo '{"prompts":[{"at":12,"text":"second"},{"at":11,"text":"first"}]}' ;;
esac
"#,
        );
        let d = dialect(&p);

        let found = d.index(&Scope::all());
        assert_eq!(found.len(), 1);
        assert_eq!(found[0].id, "s1");
        assert_eq!(found[0].dialect, "fake");
        // A cheap index reports no counts rather than zero.
        assert_eq!(found[0].prompts, None);

        let counted = d.count(found[0].clone());
        assert_eq!(counted.prompts, Some(3));
        assert_eq!(counted.steps, Some(9));

        let prompts = d.prompts(&found[0]);
        assert_eq!(prompts.len(), 2);
        // Oldest first, whatever order the program used.
        assert_eq!(prompts[0].text, "first");
        assert_eq!(prompts[1].text, "second");
    }

    #[test]
    fn the_verb_is_the_last_argument_after_the_manifests_own() {
        let dir = tempfile::tempdir().unwrap();
        let p = fake(
            dir.path(),
            "args.sh",
            r#"#!/bin/sh
# Echo the argv back as a session id so the test can read it.
echo "{\"sessions\":[{\"id\":\"$*\"}]}"
"#,
        );
        let d = ExternalDialect::new(ExternalSpec {
            id: "fake".into(),
            display: "Fake".into(),
            program: p.to_string_lossy().to_string(),
            args: vec!["--protocol".into(), "aura".into()],
            timeout_ms: Some(4_000),
        });
        let found = d.index(&Scope::all());
        assert_eq!(found[0].id, "--protocol aura index");
    }

    #[test]
    fn the_scope_is_enforced_on_a_program_that_ignores_it() {
        let dir = tempfile::tempdir().unwrap();
        let p = fake(
            dir.path(),
            "greedy.sh",
            r#"#!/bin/sh
echo '{"sessions":[
  {"id":"here","cwd":"/tmp/repo","last_activity_at":100},
  {"id":"elsewhere","cwd":"/tmp/other","last_activity_at":100},
  {"id":"stale","cwd":"/tmp/repo","last_activity_at":5}
]}'
"#,
        );
        let d = dialect(&p);
        let scope = Scope { repo_root: Some(PathBuf::from("/tmp/repo")), active_after: Some(50) };
        let ids: Vec<String> = d.index(&scope).into_iter().map(|s| s.id).collect();
        // A program is asked to narrow, never trusted to have done it: the one
        // in another tree and the one that went quiet before the window are
        // both dropped on this side.
        assert_eq!(ids, vec!["here".to_string()]);
    }

    #[test]
    fn a_failing_program_reads_as_no_history_and_keeps_the_reason() {
        let dir = tempfile::tempdir().unwrap();
        let p = fake(
            dir.path(),
            "broken.sh",
            "#!/bin/sh\necho 'cannot open database' >&2\nexit 3\n",
        );
        let d = dialect(&p);
        assert!(d.index(&Scope::all()).is_empty());
        let why = d.last_error().expect("the reason survives the empty list");
        assert!(why.contains("exited with 3"), "{why}");
        assert!(why.contains("cannot open database"), "{why}");
        // And the command a person runs when it is not working says so.
        assert!(d.probe().is_err());
    }

    #[test]
    fn output_that_is_not_json_is_a_failure_not_a_panic() {
        let dir = tempfile::tempdir().unwrap();
        let p = fake(dir.path(), "chatty.sh", "#!/bin/sh\necho 'Loading…'\n");
        let d = dialect(&p);
        assert!(d.index(&Scope::all()).is_empty());
        assert!(d.last_error().unwrap().contains("did not print JSON"));
    }

    #[test]
    fn a_program_that_hangs_is_killed_at_the_deadline() {
        let dir = tempfile::tempdir().unwrap();
        let p = fake(dir.path(), "hang.sh", "#!/bin/sh\nsleep 30\n");
        let d = ExternalDialect::new(ExternalSpec {
            id: "fake".into(),
            display: "Fake".into(),
            program: p.to_string_lossy().to_string(),
            args: Vec::new(),
            timeout_ms: Some(300),
        });
        let started = Instant::now();
        assert!(d.index(&Scope::all()).is_empty());
        // The point of the deadline: the caller gets its answer back in
        // milliseconds, not when the child feels like finishing.
        assert!(started.elapsed() < Duration::from_secs(5), "{:?}", started.elapsed());
        assert!(d.last_error().unwrap().contains("did not answer within"));
    }

    #[test]
    fn a_program_that_is_not_there_is_not_installed() {
        let d = ExternalDialect::new(ExternalSpec {
            id: "fake".into(),
            display: "Fake".into(),
            program: "/nonexistent/aura-dialect-nope".into(),
            args: Vec::new(),
            timeout_ms: None,
        });
        assert!(d.root().is_none());
        assert!(d.probe().is_err());
    }

    #[test]
    fn count_will_not_accept_an_answer_about_another_session() {
        let dir = tempfile::tempdir().unwrap();
        let p = fake(
            dir.path(),
            "confused.sh",
            r#"#!/bin/sh
case "$1" in
  index) echo '{"sessions":[{"id":"asked"}]}' ;;
  count) echo '{"session":{"id":"answered","prompts":99}}' ;;
esac
"#,
        );
        let d = dialect(&p);
        let asked = d.index(&Scope::all()).remove(0);
        let back = d.count(asked.clone());
        // Unchanged, because the program answered about something else. The
        // alternative is filing another session's numbers under this id.
        assert_eq!(back.id, "asked");
        assert_eq!(back.prompts, None);
    }

    #[test]
    fn the_deadline_is_capped_however_large_the_manifest_asks() {
        let spec = ExternalSpec {
            id: "x".into(),
            display: "X".into(),
            program: "p".into(),
            args: Vec::new(),
            timeout_ms: Some(u64::MAX),
        };
        assert_eq!(spec.timeout(), Duration::from_millis(MAX_TIMEOUT_MS));
    }

    #[test]
    fn a_spec_states_what_is_wrong_with_it() {
        let ok = ExternalSpec {
            id: "droid".into(),
            display: "Droid".into(),
            program: "aura-dialect-droid".into(),
            args: Vec::new(),
            timeout_ms: None,
        };
        assert!(ok.check().is_ok());

        let bad_id = ExternalSpec { id: "my agent".into(), ..ok.clone() };
        assert!(bad_id.check().unwrap_err().contains("`id` must be"));

        let no_program = ExternalSpec { program: "  ".into(), ..ok.clone() };
        assert!(no_program.check().unwrap_err().contains("`program` is empty"));

        let no_display = ExternalSpec { display: String::new(), ..ok };
        assert!(no_display.check().unwrap_err().contains("`display` is empty"));
    }

    #[test]
    fn prompts_with_no_text_are_dropped() {
        let dir = tempfile::tempdir().unwrap();
        let p = fake(
            dir.path(),
            "blank.sh",
            r#"#!/bin/sh
echo '{"prompts":[{"at":1,"text":""},{"at":2,"text":"real"},{"at":3}]}'
"#,
        );
        let d = dialect(&p);
        let s = Session {
            dialect: "fake",
            id: "s".into(),
            cwd: None,
            cwd_digest: None,
            branch: None,
            title: None,
            started_at: 0,
            last_activity_at: 0,
            prompts: None,
            steps: None,
            path: PathBuf::new(),
        };
        let got = d.prompts(&s);
        assert_eq!(got.len(), 1);
        assert_eq!(got[0].text, "real");
    }
}
