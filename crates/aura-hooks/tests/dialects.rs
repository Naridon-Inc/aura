//! The shared hook script, run for real, once per CLI dialect.
//!
//! The unit tests check that the script *mentions* each CLI's tool names. That
//! is not the same as reading its payload correctly, and the difference is
//! exactly where this would break: five CLIs send the same event under five
//! spellings — `tool_name` / `toolName` / `tool`, `tool_input` / `args`,
//! `file_path` / `path` / `filePath` — and a wrong guess produces no error
//! anywhere. The hook exits 0, nothing is logged, and the console shows an
//! idle repo while somebody is editing it.
//!
//! So each payload here is shaped the way its CLI actually sends one, `aura`
//! is a stub that records how it was called, and the assertion is on the whole
//! command line that came out — text, tool, file and session id.
//!
//! The session id is the one worth staring at. The console groups intent rows
//! into sessions by it, so a payload whose id is read under the wrong spelling
//! does not fail: it produces one lonely session per edit, which reads as a
//! busy repo full of one-second sessions.

use std::path::{Path, PathBuf};
use std::process::Command;

#[test]
fn every_dialect_produces_the_intent_row_it_should() {
    let Some(fixture) = Fixture::new() else {
        eprintln!("skipped: this test needs `jq`, which is what the hook parses with");
        return;
    };
    let work = fixture.workdir.to_string_lossy().into_owned();

    // codex: snake_case, and its patches carry the file names inside the patch
    // text rather than in an argument.
    fixture.assert_logs(
        "Codex",
        &serde_json::json!({
            "hook_event_name": "PostToolUse",
            "tool_name": "apply_patch",
            "tool_input": { "input": "*** Begin Patch\n*** Update File: src/main.rs\n@@\n-a\n+b\n*** End Patch" },
            "session_id": "codex-sess-1",
            "cwd": work,
        }),
        &["Codex patch on src/main.rs --tool apply_patch --file src/main.rs --session codex-sess-1"],
    );

    // codex again, with a plain unified diff — the other spelling that shows up.
    fixture.assert_logs(
        "Codex",
        &serde_json::json!({
            "tool_name": "apply_patch",
            "tool_input": { "patch": "--- a/lib/x.ts\n+++ b/lib/x.ts\n@@\n-1\n+2\n" },
            "session_id": "codex-sess-1",
            "cwd": work,
        }),
        &["Codex patch on lib/x.ts --tool apply_patch --file lib/x.ts --session codex-sess-1"],
    );

    fixture.assert_logs(
        "Codex",
        &serde_json::json!({
            "tool_name": "shell",
            "tool_input": { "command": "git commit -m wip" },
            "session_id": "codex-sess-1",
            "cwd": work,
        }),
        &["Codex shell: git commit -m wip --tool shell --session codex-sess-1"],
    );

    // kimi: camelCase, all of it.
    fixture.assert_logs(
        "Kimi",
        &serde_json::json!({
            "toolName": "write",
            "toolInput": { "path": format!("{work}/src/kimi.rs") },
            "toolCallId": "call_1",
            "sessionId": "kimi-sess-1",
            "cwd": work,
        }),
        &["Kimi write on src/kimi.rs --tool write --file src/kimi.rs --session kimi-sess-1"],
    );

    // opencode: `tool` and `args`, and a camelCase file key.
    fixture.assert_logs(
        "OpenCode",
        &serde_json::json!({
            "tool": "edit",
            "args": { "filePath": format!("{work}/app/page.tsx") },
            "sessionID": "oc-sess-1",
            "cwd": work,
        }),
        &["OpenCode edit on app/page.tsx --tool edit --file app/page.tsx --session oc-sess-1"],
    );

    // pi: camelCase tool name, `args` for the arguments.
    fixture.assert_logs(
        "Pi",
        &serde_json::json!({
            "toolName": "write",
            "args": { "path": "notes/todo.md" },
            "sessionId": "pi-sess-1",
            "cwd": work,
        }),
        &["Pi write on notes/todo.md --tool write --file notes/todo.md --session pi-sess-1"],
    );
}

#[test]
fn a_read_only_command_is_not_worth_an_intent_row() {
    let Some(fixture) = Fixture::new() else {
        return;
    };
    // Listing, reading and grepping are most of what an agent runs. Logging
    // them would bury the handful of rows that say something changed.
    for command in ["ls -la", "cat README.md", "grep -rn foo .", "git status"] {
        fixture.assert_logs(
            "Codex",
            &serde_json::json!({
                "tool_name": "shell",
                "tool_input": { "command": command },
                "cwd": fixture.workdir.to_string_lossy(),
            }),
            &[],
        );
    }
}

#[test]
fn a_payload_the_hook_does_not_understand_is_survived_quietly() {
    let Some(fixture) = Fixture::new() else {
        return;
    };
    // A post-tool hook runs between the agent's tool call and the agent seeing
    // its result, so anything but a silent exit 0 shows up as the agent's own
    // work having gone wrong.
    for payload in [
        serde_json::json!({}),
        serde_json::json!({ "tool_name": "Read", "tool_input": { "file_path": "x" } }),
        serde_json::json!({ "tool_name": "write" }),
        serde_json::json!({ "tool_name": "apply_patch", "tool_input": { "input": "" } }),
        serde_json::json!("not an object at all"),
    ] {
        fixture.assert_logs("Codex", &payload, &[]);
    }
}

/// The hook, a scratch working directory, and a stub `aura` that records how
/// it was called instead of writing anything to a real repo.
struct Fixture {
    _home: tempfile::TempDir,
    hook: PathBuf,
    workdir: PathBuf,
    bin: PathBuf,
    log: PathBuf,
}

impl Fixture {
    fn new() -> Option<Self> {
        if !has("jq") {
            return None;
        }
        let home = tempfile::tempdir().expect("a scratch home");
        let root = home.path();

        let hook = root.join("on-post-tool-use.sh");
        std::fs::write(&hook, aura_hooks::AURA_AGENT_SCRIPTS[0].1).unwrap();
        make_executable(&hook);

        let (bin, log) = stub_aura(root);
        let workdir = root.join("work");
        std::fs::create_dir_all(workdir.join("src")).unwrap();

        Some(Fixture { _home: home, hook, workdir, bin, log })
    }

    /// Run the hook on one payload and assert on the intent rows it produced.
    fn assert_logs(&self, agent: &str, payload: &serde_json::Value, expected: &[&str]) {
        let rows = run_hook(
            &self.hook,
            &self.workdir,
            &self.bin,
            &self.log,
            Some(agent),
            payload,
            expected.len(),
            is_intent,
        );
        assert_eq!(
            rows,
            expected
                .iter()
                .map(|e| format!("AURA_AGENT={agent} log-intent {e}"))
                .collect::<Vec<_>>(),
            "payload: {payload}",
        );
    }
}

/// A stub `aura` on a scratch PATH, and the file it records its calls in.
///
/// It records the agent name as well as the arguments: `AURA_AGENT` is what
/// `aura log-intent` files a row under, so a row with the wrong one is
/// somebody else's work in the feed.
fn stub_aura(root: &Path) -> (PathBuf, PathBuf) {
    let bin = root.join("bin");
    std::fs::create_dir_all(&bin).unwrap();
    let log = root.join("calls.txt");
    let stub = bin.join("aura");
    std::fs::write(
        &stub,
        format!(
            "#!/bin/sh\nprintf 'AURA_AGENT=%s %s\\n' \"${{AURA_AGENT-}}\" \"$*\" >> {}\n",
            log.display()
        ),
    )
    .unwrap();
    make_executable(&stub);
    (bin, log)
}

/// Feed one payload to a hook and return the rows it produced that `keep`
/// accepts.
///
/// The filter is not decoration. One hook call now makes two unrelated calls
/// to `aura` — an intent row and a liveness beat — and they race, so a test
/// that waited for "one row" got whichever landed first. Each test says which
/// kind it is about and waits for that.
fn run_hook(
    hook: &Path,
    workdir: &Path,
    bin: &Path,
    log: &Path,
    agent: Option<&str>,
    payload: &serde_json::Value,
    want: usize,
    keep: fn(&str) -> bool,
) -> Vec<String> {
    let _ = std::fs::remove_file(log);

    let path = format!("{}:{}", bin.display(), std::env::var("PATH").unwrap_or_default());
    let mut cmd = Command::new(hook);
    cmd.current_dir(workdir)
        .env("PATH", path)
        // The beat throttle keeps its stamp under TMPDIR. Pointed at the
        // fixture so a test neither reads a stamp left by the last run — which
        // would silently skip the beat it is asserting on — nor leaves one
        // behind on the machine running the suite.
        .env("TMPDIR", workdir)
        .stdin(std::process::Stdio::piped())
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::null());
    match agent {
        // The shared script is told who is running it; the Claude script works
        // that out from the payload, so leaving the variable set would hide
        // exactly the thing its test is checking.
        Some(a) => cmd.env("AURA_HOOK_AGENT", a),
        None => cmd.env_remove("AURA_HOOK_AGENT"),
    };
    let mut child = cmd.spawn().expect("the hook runs");
    {
        use std::io::Write;
        let mut stdin = child.stdin.take().unwrap();
        write!(stdin, "{payload}").unwrap();
    }
    let status = child.wait().expect("the hook finishes");
    assert!(status.success(), "the hook exited non-zero on {payload}");

    // `aura log-intent` is backgrounded on purpose — this hook sits between an
    // agent's tool call and its result, so it must not make the person wait.
    // Which means the row can land a moment after the hook exits.
    wait_for_rows(log, want, keep)
}

/// A row written by `aura log-intent`, as opposed to a beat.
fn is_intent(row: &str) -> bool {
    row.contains(" log-intent ")
}

/// A row written by `aura beat`.
fn is_beat(row: &str) -> bool {
    row.contains(" beat ")
}

/// Poll for the expected number of rows rather than sleeping a fixed amount:
/// on a loaded machine a fixed wait is either flaky or slow, and this is
/// neither.
fn wait_for_rows(log: &Path, want: usize, keep: fn(&str) -> bool) -> Vec<String> {
    // Nothing expected: there is no event to wait for, so settle briefly
    // instead — long enough that a row which should not have been written
    // still has time to appear and fail the test.
    if want == 0 {
        std::thread::sleep(std::time::Duration::from_millis(250));
        return rows(log).into_iter().filter(|r| keep(r)).collect();
    }
    let deadline = std::time::Instant::now() + std::time::Duration::from_secs(5);
    loop {
        let found: Vec<String> = rows(log).into_iter().filter(|r| keep(r)).collect();
        if found.len() >= want || std::time::Instant::now() > deadline {
            return found;
        }
        std::thread::sleep(std::time::Duration::from_millis(20));
    }
}

fn rows(log: &Path) -> Vec<String> {
    std::fs::read_to_string(log)
        .unwrap_or_default()
        .lines()
        .map(str::to_string)
        .collect()
}

fn has(bin: &str) -> bool {
    Command::new("sh")
        .arg("-c")
        .arg(format!("command -v {bin}"))
        .stdout(std::process::Stdio::null())
        .status()
        .is_ok_and(|s| s.success())
}

#[cfg(unix)]
fn make_executable(path: &Path) {
    use std::os::unix::fs::PermissionsExt;
    let mut perms = std::fs::metadata(path).unwrap().permissions();
    perms.set_mode(0o755);
    std::fs::set_permissions(path, perms).unwrap();
}

#[cfg(not(unix))]
fn make_executable(_path: &Path) {}

/// The Claude script, run the way cursor-agent runs it.
///
/// Cursor has no hook file of its own — it reads the repo's
/// `.claude/settings.local.json`, remaps the event and tool names onto its own
/// vocabulary, and calls Claude's scripts. So the only place cursor's dialect
/// can be tested is here, and it is worth testing: before this, every row
/// cursor wrote was filed under Claude's name.
#[test]
fn cursor_gets_its_own_name_and_its_own_session_on_the_row() {
    let Some(fixture) = ClaudeFixture::new() else {
        eprintln!("skipped: this test needs `jq`, which is what the hook parses with");
        return;
    };

    // Cursor's `Write` covers both editing and creating, and it sends the file
    // under Claude's key because it is speaking Claude's protocol.
    fixture.assert_logs(
        &serde_json::json!({
            "hook_event_name": "PostToolUse",
            "tool_name": "Write",
            "tool_input": { "file_path": format!("{}/src/app.ts", fixture.workdir.display()) },
            "conversation_id": "cur-conv-1",
            "generation_id": "cur-gen-9",
            "cwd": fixture.workdir.to_string_lossy(),
        }),
        &["AURA_AGENT=Cursor log-intent Cursor Write on src/app.ts --tool Write --file src/app.ts --session cur-conv-1"],
    );

    // `Shell` is cursor's spelling of Bash.
    fixture.assert_logs(
        &serde_json::json!({
            "tool_name": "Shell",
            "tool_input": { "command": "git commit -m done" },
            "conversation_id": "cur-conv-1",
            "generation_id": "cur-gen-10",
            "cwd": fixture.workdir.to_string_lossy(),
        }),
        &["AURA_AGENT=Cursor log-intent Cursor Shell: git commit -m done --tool Shell --session cur-conv-1"],
    );

    // The same script, run by Claude itself: same shape, different name, and
    // the session id under Claude's own spelling.
    fixture.assert_logs(
        &serde_json::json!({
            "tool_name": "Edit",
            "tool_input": { "file_path": format!("{}/src/app.ts", fixture.workdir.display()) },
            "session_id": "claude-sess-1",
            "cwd": fixture.workdir.to_string_lossy(),
        }),
        &["AURA_AGENT=Claude log-intent Claude Edit on src/app.ts --tool Edit --file src/app.ts --session claude-sess-1"],
    );
}

/// Every tool call beats, whatever the tool was and whoever ran it.
///
/// The beat is what tells the console somebody is still in here. An intent row
/// only exists when a file changes, so a session spent reading, grepping,
/// building and driving a browser used to look finished the whole time it was
/// being worked in — and a session somebody had walked away from twenty minutes
/// ago still read "Working". Two things are worth pinning: that a *read* beats,
/// which is the case an intent row cannot cover, and that the agent name on the
/// beat is the agent that ran, so the roster does not file cursor's work under
/// Claude.
#[test]
fn every_tool_call_says_somebody_is_still_here() {
    let Some(fixture) = ClaudeFixture::new() else {
        eprintln!("skipped: this test needs `jq`, which is what the hook parses with");
        return;
    };

    // A read changes nothing, writes no intent row, and is still work.
    fixture.assert_beats(
        &serde_json::json!({
            "tool_name": "Read",
            "tool_input": { "file_path": format!("{}/src/app.ts", fixture.workdir.display()) },
            "session_id": "claude-sess-1",
            "cwd": fixture.workdir.to_string_lossy(),
        }),
        &["AURA_AGENT= beat --session claude-sess-1 --agent Claude"],
    );

    // Cursor's session lives under a different key, and its beat has to find
    // it — a beat under the wrong id is a second, empty session on the roster.
    fixture.assert_beats(
        &serde_json::json!({
            "tool_name": "Shell",
            "tool_input": { "command": "ls" },
            "conversation_id": "cur-conv-1",
            "generation_id": "cur-gen-9",
            "cwd": fixture.workdir.to_string_lossy(),
        }),
        &["AURA_AGENT= beat --session cur-conv-1 --agent Cursor"],
    );

    // No session to beat for. Nothing is sent, rather than a row the console
    // would have to file under nobody.
    fixture.assert_beats(
        &serde_json::json!({
            "tool_name": "Read",
            "tool_input": { "file_path": format!("{}/src/app.ts", fixture.workdir.display()) },
            "cwd": fixture.workdir.to_string_lossy(),
        }),
        &[],
    );
}

/// The whole Claude script set staged together, because the hook sources its
/// siblings from its own directory.
struct ClaudeFixture {
    _home: tempfile::TempDir,
    hook: PathBuf,
    workdir: PathBuf,
    bin: PathBuf,
    log: PathBuf,
}

impl ClaudeFixture {
    fn new() -> Option<Self> {
        if !has("jq") {
            return None;
        }
        let home = tempfile::tempdir().expect("a scratch home");
        let root = home.path();

        let scripts = root.join("scripts");
        std::fs::create_dir_all(&scripts).unwrap();
        for (name, body) in aura_hooks::AURA_CLAUDE_SCRIPTS {
            let path = scripts.join(name);
            std::fs::write(&path, body).unwrap();
            make_executable(&path);
        }

        let (bin, log) = stub_aura(root);
        let workdir = root.join("work");
        std::fs::create_dir_all(workdir.join("src")).unwrap();
        // Canonicalised because this script trims the repo prefix using its own
        // `$PWD`, and on macOS a temp dir is reached through a symlink — so the
        // uncanonicalised path in a payload would never match the one bash
        // reports, for reasons that have nothing to do with the hook.
        let workdir = workdir.canonicalize().unwrap();

        Some(ClaudeFixture {
            _home: home,
            hook: scripts.join("on-post-tool-use.sh"),
            workdir,
            bin,
            log,
        })
    }

    fn assert_logs(&self, payload: &serde_json::Value, expected: &[&str]) {
        let rows = run_hook(
            &self.hook,
            &self.workdir,
            &self.bin,
            &self.log,
            None,
            payload,
            expected.len(),
            is_intent,
        );
        assert_eq!(rows, expected, "payload: {payload}");
    }

    /// The same run, asked about the beat instead of the intent row.
    fn assert_beats(&self, payload: &serde_json::Value, expected: &[&str]) {
        let rows = run_hook(
            &self.hook,
            &self.workdir,
            &self.bin,
            &self.log,
            None,
            payload,
            expected.len(),
            is_beat,
        );
        assert_eq!(rows, expected, "payload: {payload}");
    }

}
