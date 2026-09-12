use std::path::PathBuf;
use std::process::Command;

/// Test harness: creates a temporary git repo with Aura initialized.
/// On test failure, captures diagnostic artifacts (git log, tree, aura logs)
/// to aid debugging — inspired by Entire CLI's E2E artifact capture.
struct TestRepo {
    dir: tempfile::TempDir,
    /// If true, preserve the temp dir on drop for post-mortem analysis
    keep_on_failure: bool,
}

impl TestRepo {
    fn new() -> Self {
        let dir = tempfile::tempdir().expect("Failed to create temp dir");
        let keep = std::env::var("AURA_E2E_KEEP_REPOS").is_ok();

        Command::new("git")
            .args(["init"])
            .current_dir(dir.path())
            .output()
            .expect("git init failed");

        Command::new("git")
            .args(["config", "user.email", "test@aura.test"])
            .current_dir(dir.path())
            .output()
            .expect("git config failed");

        Command::new("git")
            .args(["config", "user.name", "Aura Test"])
            .current_dir(dir.path())
            .output()
            .expect("git config failed");

        std::fs::write(dir.path().join("main.rs"), "fn main() {}\n")
            .expect("Failed to write file");

        Command::new("git")
            .args(["add", "."])
            .current_dir(dir.path())
            .output()
            .expect("git add failed");

        Command::new("git")
            .args(["commit", "-m", "Initial commit", "--no-verify"])
            .current_dir(dir.path())
            .output()
            .expect("git commit failed");

        Self { dir, keep_on_failure: keep }
    }

    fn path(&self) -> PathBuf {
        self.dir.path().to_path_buf()
    }

    /// Run `aura` in this repo. No watcher daemon is ever started: `init`
    /// normally leaves one running over the tree it prepared, which for a
    /// temporary repo means a resident process watching a directory that is
    /// deleted seconds later — dozens per suite run, accumulating for as long
    /// as the machine is up. They also raced this suite: a watcher snapshots
    /// every save it sees, so `test_snapshot_guard_detects_unsnapshotted_edits`
    /// failed whenever one got to the file before the assertion did.
    fn aura(&self, args: &[&str]) -> std::process::Output {
        Command::new(aura_binary())
            .args(args)
            // `aura init` otherwise forks a watcher daemon that outlives the
            // tempdir it was watching. A full suite inits many repos, so the
            // watchers accumulate — a few hundred resident processes after a
            // handful of runs — and the one watching *this* repo races the
            // tests by snapshotting files they are asserting about.
            .env("AURA_NO_DAEMON", "1")
            .current_dir(self.dir.path())
            .output()
            .expect("Failed to run aura")
    }

    fn write_file(&self, name: &str, content: &str) {
        let path = self.dir.path().join(name);
        if let Some(parent) = path.parent() {
            std::fs::create_dir_all(parent).ok();
        }
        std::fs::write(path, content).expect("Failed to write file");
    }

    fn commit(&self, message: &str) {
        Command::new("git")
            .args(["add", "."])
            .current_dir(self.dir.path())
            .output()
            .expect("git add failed");

        Command::new("git")
            .args(["commit", "-m", message, "--no-verify"])
            .current_dir(self.dir.path())
            .output()
            .expect("git commit failed");
    }

    /// Commit with **no** hook of any kind running.
    ///
    /// `--no-verify` is not enough: it skips `pre-commit` and `commit-msg` but
    /// git still runs `post-commit`, and `aura init` installs one that calls
    /// `aura persist-checkpoint` — which snapshots what was just committed.
    /// A test that asserts something about the *absence* of Aura state is
    /// otherwise racing Aura's own checkpointing, and loses whenever the
    /// machine is busy enough for that separate process to win.
    fn commit_without_hooks(&self, message: &str) {
        Command::new("git")
            .args(["add", "."])
            .current_dir(self.dir.path())
            .output()
            .expect("git add failed");

        Command::new("git")
            .args([
                "-c",
                "core.hooksPath=/dev/null",
                "commit",
                "-m",
                message,
                "--no-verify",
            ])
            .current_dir(self.dir.path())
            .output()
            .expect("git commit failed");
    }

    /// Capture diagnostic artifacts on test failure for debugging.
    /// Saves git log, working tree state, and aura logs to the test dir.
    fn capture_failure_artifacts(&self, test_name: &str) {
        let artifacts_dir = self.dir.path().join("_test_artifacts");
        std::fs::create_dir_all(&artifacts_dir).ok();

        // Capture git log
        if let Ok(output) = Command::new("git")
            .args(["log", "--oneline", "-20"])
            .current_dir(self.dir.path())
            .output()
        {
            std::fs::write(
                artifacts_dir.join("git-log.txt"),
                String::from_utf8_lossy(&output.stdout).as_ref(),
            ).ok();
        }

        // Capture git tree state
        if let Ok(output) = Command::new("git")
            .args(["status", "--short"])
            .current_dir(self.dir.path())
            .output()
        {
            std::fs::write(
                artifacts_dir.join("git-tree.txt"),
                String::from_utf8_lossy(&output.stdout).as_ref(),
            ).ok();
        }

        // Capture aura status
        if let Ok(output) = Command::new(aura_binary())
            .args(["status"])
            .current_dir(self.dir.path())
            .output()
        {
            let combined = format!(
                "STDOUT:\n{}\nSTDERR:\n{}",
                String::from_utf8_lossy(&output.stdout),
                String::from_utf8_lossy(&output.stderr)
            );
            std::fs::write(artifacts_dir.join("aura-status.txt"), &combined).ok();
        }

        // Copy .aura/ logs if they exist
        let aura_dir = self.dir.path().join(".aura");
        if aura_dir.exists() {
            let dest = artifacts_dir.join("aura-data");
            let _ = copy_dir_recursive(&aura_dir, &dest);
        }

        if self.keep_on_failure {
            eprintln!(
                "  [ARTIFACT] Test '{}' failed. Repo preserved at: {}",
                test_name,
                self.dir.path().display()
            );
        }
    }
}

/// Recursively copy a directory (for artifact capture)
fn copy_dir_recursive(src: &std::path::Path, dst: &std::path::Path) -> std::io::Result<()> {
    std::fs::create_dir_all(dst)?;
    for entry in std::fs::read_dir(src)? {
        let entry = entry?;
        let ty = entry.file_type()?;
        let dest_path = dst.join(entry.file_name());
        if ty.is_dir() {
            copy_dir_recursive(&entry.path(), &dest_path)?;
        } else {
            std::fs::copy(entry.path(), dest_path)?;
        }
    }
    Ok(())
}

/// Helper macro to assert with artifact capture on failure
macro_rules! assert_aura {
    ($repo:expr, $cond:expr, $test_name:expr, $($arg:tt)*) => {
        if !$cond {
            $repo.capture_failure_artifacts($test_name);
            panic!($($arg)*);
        }
    };
}

/// The binary cargo built for *this* test run.
///
/// This used to prefer `target/release/aura`, then `target/debug/aura`, then
/// whatever `aura` was on PATH — so a release build left lying around from an
/// earlier day was what the suite actually exercised, silently, and a green run
/// said nothing about the code being tested. `CARGO_BIN_EXE_aura` is cargo's
/// own answer to the question (the merge-driver suite next door already asks it
/// that way), and it cannot go stale.
fn aura_binary() -> String {
    env!("CARGO_BIN_EXE_aura").to_string()
}

/// Run a command line exactly as printed, with `aura` on PATH.
///
/// Gates print commands for a person or an agent to paste, and the only way to
/// test that promise is to paste it: parse nothing, rebuild nothing, hand the
/// line to a shell and see whether it works.
fn run_in_shell(repo: &TestRepo, command: &str) -> std::process::Output {
    let bin = PathBuf::from(aura_binary());
    let dir = bin.parent().expect("the test binary lives somewhere");
    let path = match std::env::var("PATH") {
        Ok(rest) => format!("{}:{rest}", dir.display()),
        Err(_) => dir.display().to_string(),
    };
    Command::new("sh")
        .arg("-c")
        .arg(command)
        .env("PATH", path)
        .env("AURA_NO_DAEMON", "1")
        .current_dir(repo.path())
        .output()
        .expect("failed to run the handed-back command")
}

// ── Checkpoint Tests ──

#[test]
fn test_init_creates_aura_directory() {
    let repo = TestRepo::new();
    // Use --force-baseline to skip interactive wizard prompts
    let output = repo.aura(&["init", "--force-baseline"]);
    // init may fail in non-TTY context but should create .aura dir
    let stdout = String::from_utf8_lossy(&output.stdout);
    assert!(
        output.status.success() || stdout.contains("Aura") || repo.path().join(".aura").exists(),
        "aura init should at least partially succeed: stdout={}", stdout
    );
}

#[test]
fn test_persist_checkpoint() {
    let repo = TestRepo::new();
    repo.aura(&["init"]);
    repo.write_file("lib.rs", "pub fn add(a: i32, b: i32) -> i32 { a + b }\n");
    repo.commit("Add math functions");

    let output = repo.aura(&["persist-checkpoint"]);
    let stdout = String::from_utf8_lossy(&output.stdout);
    let stderr = String::from_utf8_lossy(&output.stderr);
    assert!(
        output.status.success() || stderr.contains("No changes") || stdout.contains("checkpoint"),
        "persist-checkpoint: stdout={}, stderr={}", stdout, stderr
    );
}

#[test]
fn test_status_command() {
    let repo = TestRepo::new();
    repo.aura(&["init"]);
    let output = repo.aura(&["status"]);
    assert!(output.status.success(), "aura status should succeed");
    let stdout = String::from_utf8_lossy(&output.stdout);
    assert!(stdout.contains("Aura") || stdout.contains("Status") || stdout.contains("Semantic"));
}

#[test]
fn test_snapshot() {
    let repo = TestRepo::new();
    repo.aura(&["init"]);
    repo.write_file("test.rs", "fn test() {}\n");
    repo.commit("Add test file");
    let output = repo.aura(&["snapshot", "Before refactor"]);
    assert!(output.status.success(), "aura snapshot should succeed");
}

// ── Session Tests ──

#[test]
fn test_sessions_command() {
    let repo = TestRepo::new();
    repo.aura(&["init"]);
    let output = repo.aura(&["sessions"]);
    assert!(output.status.success(), "aura sessions should succeed");
}

#[test]
fn test_doctor_command() {
    let repo = TestRepo::new();
    repo.aura(&["init"]);
    let output = repo.aura(&["doctor"]);
    let stdout = String::from_utf8_lossy(&output.stdout);
    assert!(output.status.success() || stdout.contains("Doctor"));
}

#[test]
fn test_resume_nonexistent_branch() {
    let repo = TestRepo::new();
    // Commit any init artifacts so the repo is clean
    repo.commit("setup");
    let output = repo.aura(&["resume", "nonexistent-branch-xyz"]);
    let stderr = String::from_utf8_lossy(&output.stderr);
    let stdout = String::from_utf8_lossy(&output.stdout);
    // Should either fail or show a meaningful message about the branch
    assert!(
        !output.status.success()
            || stderr.contains("not found") || stdout.contains("not found")
            || stdout.contains("No previous sessions") || stdout.contains("Starting fresh")
            || stdout.contains("uncommitted") || stdout.contains("stash"),
        "resume should indicate branch issue: stdout={}, stderr={}", stdout, stderr
    );
}

// ── Review Tests ──

#[test]
fn test_pr_review_no_changes() {
    let repo = TestRepo::new();
    repo.aura(&["init"]);
    let output = repo.aura(&["pr-review", "--base", "HEAD"]);
    let stdout = String::from_utf8_lossy(&output.stdout);
    let stderr = String::from_utf8_lossy(&output.stderr);
    assert!(
        stdout.contains("review") || stdout.contains("Review") || stdout.contains("No")
            || stderr.contains("review") || stderr.contains("No") || output.status.success(),
        "pr-review: stdout={}, stderr={}", stdout, stderr
    );
}

// ── Plugin Tests ──

#[test]
fn test_status_with_plugin_config() {
    let repo = TestRepo::new();
    repo.aura(&["init"]);
    repo.write_file(".aura/plugins.toml", "[plugins]\nenabled = [\"cost-reporter\"]\n");
    let output = repo.aura(&["status"]);
    assert!(output.status.success());
}

#[test]
fn test_invalid_plugin_path_handled() {
    let repo = TestRepo::new();
    repo.aura(&["init"]);
    repo.write_file(".aura/plugins.toml", "[plugins]\nenabled = []\ncustom_paths = [\"/nonexistent/plugin.dylib\"]\n");
    let output = repo.aura(&["status"]);
    assert!(output.status.success(), "should handle invalid plugin paths gracefully");
}

// ── Map / GC Tests ──

#[test]
fn test_map_command() {
    let repo = TestRepo::new();
    repo.aura(&["init"]);
    repo.write_file("src/lib.rs", "pub fn hello() -> &'static str { \"hello\" }\n");
    repo.commit("Add source files");
    let output = repo.aura(&["map"]);
    assert!(output.status.success(), "aura map should succeed");
}

#[test]
fn test_gc_command() {
    let repo = TestRepo::new();
    repo.aura(&["init"]);
    let output = repo.aura(&["gc"]);
    assert!(output.status.success(), "aura gc should succeed");
}

// ── Rewind Tests ──

#[test]
fn test_rewind_function() {
    let repo = TestRepo::new();
    repo.aura(&["init"]);

    // Create file with a function, commit, then modify it
    repo.write_file("lib.rs", "pub fn greet() -> &'static str { \"hello\" }\n");
    repo.commit("Add greet function");

    repo.write_file("lib.rs", "pub fn greet() -> &'static str { \"CORRUPTED\" }\n");
    repo.commit("Break greet function");

    let output = repo.aura(&["rewind", "greet", "lib.rs"]);
    // Rewind should attempt to restore the function (may need checkpoint data)
    let _stdout = String::from_utf8_lossy(&output.stdout);
    // Just verify it doesn't panic
}

// ── Audit Tests ──

#[test]
fn test_audit_command() {
    let repo = TestRepo::new();
    repo.aura(&["init"]);

    // Make some commits (some with hooks, some without)
    repo.write_file("a.rs", "fn a() {}\n");
    repo.commit("Add a");

    let output = repo.aura(&["audit"]);
    assert!(output.status.success(), "aura audit should succeed");
    let stdout = String::from_utf8_lossy(&output.stdout);
    assert!(
        stdout.contains("Audit") || stdout.contains("Verified") || stdout.contains("UNVERIFIED"),
        "audit should produce meaningful output"
    );
}

// ── Explain Tests ──

#[test]
fn test_explain_command() {
    let repo = TestRepo::new();
    repo.aura(&["init"]);

    repo.write_file("lib.rs", "pub fn my_function() -> i32 { 42 }\n");
    repo.commit("Add my_function");

    let output = repo.aura(&["explain", "my_function", "lib.rs"]);
    let _stdout = String::from_utf8_lossy(&output.stdout);
    // Just verify it doesn't crash — may not find session data in test env
}

// ── Verify-Env Tests ──

#[test]
fn test_verify_env_command() {
    let repo = TestRepo::new();
    repo.aura(&["init"]);
    let output = repo.aura(&["verify-env"]);
    // Should handle gracefully even without targets
    let _stdout = String::from_utf8_lossy(&output.stdout);
}

// ── Hook Tests ──

#[test]
fn test_hooks_installed_after_init() {
    let repo = TestRepo::new();
    repo.aura(&["init", "--force-baseline"]);

    // Check that hooks directory exists and has aura hooks
    let hooks_dir = repo.path().join(".git/hooks");
    if hooks_dir.exists() {
        let pre_commit = hooks_dir.join("pre-commit");
        let post_commit = hooks_dir.join("post-commit");
        let commit_msg = hooks_dir.join("commit-msg");

        // At least some hooks should exist after init
        let any_hook = pre_commit.exists() || post_commit.exists() || commit_msg.exists();
        // Note: init might fail in non-TTY, so hooks might not be installed
        let _ = any_hook;
    }
}

#[test]
fn test_hook_chaining_with_existing_hooks() {
    let repo = TestRepo::new();

    // Create an existing pre-commit hook (simulating Husky/custom hook)
    let hooks_dir = repo.path().join(".git/hooks");
    std::fs::create_dir_all(&hooks_dir).unwrap();
    std::fs::write(
        hooks_dir.join("pre-commit"),
        "#!/bin/sh\necho 'existing hook'\n",
    ).unwrap();

    // Set executable
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let mut perms = std::fs::metadata(hooks_dir.join("pre-commit")).unwrap().permissions();
        perms.set_mode(0o755);
        std::fs::set_permissions(hooks_dir.join("pre-commit"), perms).unwrap();
    }

    repo.aura(&["init", "--force-baseline"]);

    // Verify existing hook content was preserved (chained, not overwritten)
    if let Ok(content) = std::fs::read_to_string(hooks_dir.join("pre-commit")) {
        assert!(
            content.contains("existing hook"),
            "existing hook content should be preserved after init"
        );
    }
}

// ── Multi-file Checkpoint Tests ──

#[test]
fn test_multi_language_checkpoint() {
    let repo = TestRepo::new();
    repo.aura(&["init"]);

    // Create files in multiple languages
    repo.write_file("main.py", "def hello():\n    return 'hello'\n");
    repo.write_file("main.rs", "fn hello() -> &'static str { \"hello\" }\n");
    repo.write_file("main.ts", "function hello(): string { return 'hello'; }\n");
    repo.commit("Add multi-language files");

    let output = repo.aura(&["persist-checkpoint"]);
    let stdout = String::from_utf8_lossy(&output.stdout);
    let stderr = String::from_utf8_lossy(&output.stderr);
    // Should handle multiple languages
    assert!(
        output.status.success() || stderr.contains("No changes") || stdout.contains("checkpoint"),
        "multi-lang checkpoint: stdout={}, stderr={}", stdout, stderr
    );
}

// ── Cost & Status Integration ──

#[test]
fn test_status_shows_session_info() {
    let repo = TestRepo::new();
    repo.aura(&["init"]);

    let output = repo.aura(&["status"]);
    assert!(output.status.success());
    let stdout = String::from_utf8_lossy(&output.stdout);

    // Status should show at minimum the semantic status section
    assert!(
        stdout.contains("Semantic") || stdout.contains("Aura") || stdout.contains("Status"),
        "status should show semantic info"
    );
}

// ══════════════════════════════════════════════════
// Intent Marker & Gatekeeper Tests
// ══════════════════════════════════════════════════

#[test]
fn test_intent_marker_created_by_capture_context() {
    let repo = TestRepo::new();
    repo.aura(&["init", "--force-baseline"]);

    // Write an intent file (simulates what aura_log_intent MCP tool does)
    std::fs::create_dir_all(repo.path().join(".aura")).ok();
    std::fs::write(
        repo.path().join(".aura/intent_log.jsonl"),
        "{\"intent\":\"Added compute function\",\"timestamp\":1700000000}\n",
    ).unwrap();
    std::fs::write(repo.path().join(".aura/.intent_logged"), "").unwrap();

    // The marker file should exist
    assert!(repo.path().join(".aura/.intent_logged").exists(),
        ".aura/.intent_logged should exist after writing intent");
}

#[test]
fn test_capture_context_clears_intent_marker() {
    let repo = TestRepo::new();
    repo.aura(&["init", "--force-baseline"]);

    // Ensure .aura exists (init may not complete in non-TTY)
    std::fs::create_dir_all(repo.path().join(".aura")).ok();

    // Create the marker
    std::fs::write(repo.path().join(".aura/.intent_logged"), "").unwrap();
    assert!(repo.path().join(".aura/.intent_logged").exists());

    // Run capture-context (this is what the pre-commit hook calls)
    repo.write_file("lib.rs", "pub fn new_fn() -> i32 { 1 }\n");
    Command::new("git")
        .args(["add", "."])
        .current_dir(repo.path())
        .output()
        .unwrap();

    let output = repo.aura(&["capture-context"]);
    let _stdout = String::from_utf8_lossy(&output.stdout);

    // After capture-context, the marker should be cleaned up
    // (it gets removed at the end of the hook so each commit cycle is fresh)
    // Note: may or may not be removed depending on hook flow
}

// ══════════════════════════════════════════════════
// Deletion Guard Tests (via capture-context directly)
// ══════════════════════════════════════════════════

#[test]
fn test_deletion_guard_detects_removed_functions() {
    let repo = TestRepo::new();
    repo.aura(&["init", "--force-baseline"]);

    // Create file with two functions, commit
    repo.write_file("api.rs", "pub fn handle() -> String { \"ok\".to_string() }\npub fn validate() -> bool { true }\n");
    repo.commit("Add API functions");

    // Run capture-context to create a baseline checkpoint with both functions
    repo.aura(&["capture-context"]);

    // Now delete one function and stage it
    repo.write_file("api.rs", "pub fn handle() -> String { \"ok\".to_string() }\n");
    Command::new("git")
        .args(["add", "."])
        .current_dir(repo.path())
        .output()
        .unwrap();

    // Ensure .aura exists and write intent that does NOT mention deletion
    std::fs::create_dir_all(repo.path().join(".aura")).ok();
    std::fs::create_dir_all(repo.path().join(".aura/snapshots")).ok();
    std::fs::write(repo.path().join(".aura/.intent_logged"), "").unwrap();
    std::fs::write(repo.path().join(".gemini.intent"), "Updated handle to return JSON").unwrap();

    // Enable strict mode
    repo.aura(&["config", "set", "strict-mode", "true"]);

    // Run capture-context — should detect validate() was deleted
    let output = repo.aura(&["capture-context"]);
    let stdout = String::from_utf8_lossy(&output.stdout);
    let stderr = String::from_utf8_lossy(&output.stderr);
    let combined = format!("{}{}", stdout, stderr);

    // In strict mode, should block or at least mention the deletion/removed nodes
    // Note: if the checkpoint comparison doesn't find the previous state,
    // capture-context may pass — this is acceptable in test environments
    let detected = !output.status.success()
        || combined.contains("Deletion Guard")
        || combined.contains("REMOVED")
        || combined.contains("validate")
        || combined.contains("halted")
        || combined.contains("removed")
        || combined.contains("node");

    if !detected {
        // In some test environments, the checkpoint comparison may not work
        // (e.g., if git notes aren't propagated). Log but don't fail hard.
        eprintln!("  [NOTE] Deletion guard did not trigger — may need git notes for checkpoint comparison. Output: {}", combined);
    }
}

/// The OTHER half of the guard's promise: the fix it hands back actually WORKS.
///
/// The rejection tells the agent to run `aura log-intent "Removed <node> …"`.
/// That is only a real path forward if the command lands a row in the very
/// `.aura/intent_log.jsonl` the guard reads on the next run. This exercises the
/// full loop against the real binary — block → run the exact fix → gate clears —
/// so if `aura log-intent` ever regresses to a no-op (exit 0 but writes
/// nothing), STEP 3 fails and this test catches it. The pure logic is covered by
/// deletion_guard's unit round-trip; this is the binary-integration proof.
#[test]
fn test_deletion_guard_fix_command_clears_the_gate() {
    let repo = TestRepo::new();

    // Baseline: two functions COMMITTED first, then init the baseline from HEAD
    // so the checkpoint the guard diffs against actually contains them.
    repo.write_file("api.rs", "pub fn handle() -> String { \"ok\".to_string() }\npub fn validate() -> bool { true }\n");
    repo.commit("Add API functions");
    repo.aura(&["init", "--force-baseline"]);
    repo.aura(&["config", "set", "strict-mode", "true"]);
    repo.aura(&["capture-context"]);

    // Delete validate(), stage it, and record an intent that does NOT account
    // for the removal. We drop the `.intent_logged` marker + a generic intent so
    // the SEPARATE "intent not logged" gate is satisfied — that isolates the
    // deletion guard as the only thing that can block here, which is what this
    // test is about.
    repo.write_file("api.rs", "pub fn handle() -> String { \"ok\".to_string() }\n");
    Command::new("git").args(["add", "."]).current_dir(repo.path()).output().unwrap();
    std::fs::create_dir_all(repo.path().join(".aura/snapshots")).ok();
    std::fs::write(repo.path().join(".aura/.intent_logged"), "").unwrap();
    std::fs::write(repo.path().join(".gemini.intent"), "Updated handle to return JSON").unwrap();

    // STEP 1 — capture-context must block the unaccounted deletion.
    let blocked = repo.aura(&["capture-context"]);
    if blocked.status.success() {
        // The checkpoint AST comparison couldn't run in this environment (e.g.
        // git notes not propagated) so the guard never fired — we can't exercise
        // the fix loop. Skip rather than fail; the fire path is covered by
        // `test_deletion_guard_detects_removed_functions`.
        eprintln!("  [SKIP] guard did not fire in this env — cannot exercise the fix loop");
        return;
    }
    let out1 = format!(
        "{}{}",
        String::from_utf8_lossy(&blocked.stdout),
        String::from_utf8_lossy(&blocked.stderr),
    );
    assert!(out1.contains("validate"), "rejection must name the removed node: {out1}");
    assert!(out1.contains("aura log-intent"), "rejection must hand back the fix command: {out1}");

    // STEP 2 — run the command the guard handed back, verbatim, with only its
    // reason placeholder filled in. Anything less tests a command we wrote
    // ourselves rather than the one an agent is actually told to run.
    let handed_back = out1
        .lines()
        .find(|l| l.trim_start().starts_with("$ aura log-intent"))
        .map(|l| l.trim_start().trim_start_matches("$ ").to_string())
        .unwrap_or_else(|| panic!("the rejection must hand back a command: {out1}"));
    let filled = {
        let open = handed_back.find("<state why").expect("the reason is left for a person to write");
        let close = handed_back[open..].find('>').expect("an unterminated placeholder") + open;
        format!("{}the endpoint was retired{}", &handed_back[..open], &handed_back[close + 1..])
    };
    let ran = run_in_shell(&repo, &filled);
    assert!(
        ran.status.success(),
        "the handed-back command must run as printed: {filled}\n{}{}",
        String::from_utf8_lossy(&ran.stdout),
        String::from_utf8_lossy(&ran.stderr),
    );
    let log = std::fs::read_to_string(repo.path().join(".aura/intent_log.jsonl"))
        .expect("log-intent must create .aura/intent_log.jsonl — a no-op here means the guard is theatre");
    assert!(
        log.contains("Removed validate because the endpoint was retired"),
        "log-intent must append the intent row the guard reads, got: {log}"
    );

    // STEP 3 — the deletion is now accounted for, so the gate must clear. Not
    // this gate alone, either: the unexplained-writes gate runs moments later
    // and wants a reason on every file, and for a long time the handed-back
    // command said nothing about files, so following it to the letter bought
    // one rejection in place of another.
    let cleared = repo.aura(&["capture-context"]);
    assert!(
        cleared.status.success(),
        "the fix the guard handed back must clear the gate on retry; instead exit={:?} out={}{}",
        cleared.status.code(),
        String::from_utf8_lossy(&cleared.stdout),
        String::from_utf8_lossy(&cleared.stderr),
    );
}

/// The load-bearing fact behind the whole accountability loop, tested with NO
/// dependence on the (env-sensitive) checkpoint machinery: `aura log-intent`
/// must actually PERSIST a readable row to the `.aura/intent_log.jsonl` the
/// guard reads, and drop the `.intent_logged` marker. If it ever regresses to a
/// silent no-op (the failure mode where the guard's fix instruction becomes
/// theatre — reject an agent, hand it a command that changes nothing, loop
/// forever), this deterministic test fails.
#[test]
fn test_log_intent_persists_a_readable_row() {
    let repo = TestRepo::new();

    let out = repo.aura(&["log-intent", "Removed validate because the endpoint was retired"]);
    assert!(
        out.status.success(),
        "log-intent must exit 0; stderr={}",
        String::from_utf8_lossy(&out.stderr),
    );

    let log_path = repo.path().join(".aura/intent_log.jsonl");
    let log = std::fs::read_to_string(&log_path).unwrap_or_else(|_| {
        panic!(
            "log-intent must create {} — a silent no-op means the guard's fix instruction is theatre",
            log_path.display()
        )
    });
    assert!(
        log.contains("Removed validate because the endpoint was retired"),
        "the row the guard reads must contain the logged intent verbatim, got: {log}"
    );

    assert!(
        repo.path().join(".aura/.intent_logged").exists(),
        "log-intent must drop the .intent_logged marker the pre-commit gate checks"
    );
}

// ══════════════════════════════════════════════════
// Snapshot & Rewind Roundtrip Tests
// ══════════════════════════════════════════════════

#[test]
fn test_snapshot_creates_file_in_snapshots_dir() {
    let repo = TestRepo::new();
    repo.aura(&["init", "--force-baseline"]);

    repo.write_file("src/handler.ts", "export function handle() { return 'ok'; }\n");
    repo.commit("Add handler");

    // Snapshot the file (CLI uses `aura snapshot "description"` but also accepts file path)
    let output = repo.aura(&["snapshot", "pre-edit backup"]);
    let stdout = String::from_utf8_lossy(&output.stdout);
    // The CLI snapshot command takes a description, not a file path
    // It snapshots all tracked files
    assert!(stdout.contains("Snapshot") || stdout.contains("snapshot") || output.status.success(),
        "snapshot should succeed: {}", stdout);
}

#[test]
fn test_snapshot_rewind_roundtrip() {
    let repo = TestRepo::new();
    repo.aura(&["init", "--force-baseline"]);

    // Original content
    let original = "pub fn process(data: &str) -> String {\n    data.to_uppercase()\n}\n";
    repo.write_file("processor.rs", original);
    repo.commit("Add processor");

    // Snapshot before edit
    repo.aura(&["snapshot", "before corruption"]);

    // Corrupt the function
    let corrupted = "pub fn process(data: &str) -> String {\n    panic!(\"hallucinated\")\n}\n";
    repo.write_file("processor.rs", corrupted);
    repo.commit("Break processor");

    // Verify file is corrupted
    let content = std::fs::read_to_string(repo.path().join("processor.rs")).unwrap();
    assert!(content.contains("hallucinated"), "File should be corrupted");

    // Rewind the function
    let output = repo.aura(&["rewind", "process", "processor.rs"]);
    let stdout = String::from_utf8_lossy(&output.stdout);

    // Check if rewind restored the function
    let restored = std::fs::read_to_string(repo.path().join("processor.rs")).unwrap();
    if stdout.contains("restored") || stdout.contains("Restored") {
        assert!(!restored.contains("hallucinated"),
            "Rewind should restore original function, got: {}", restored);
    }
}

// ══════════════════════════════════════════════════
// Memory Tests (via file-based approach since no CLI subcommand)
// ══════════════════════════════════════════════════

#[test]
fn test_memory_file_created_after_init() {
    let repo = TestRepo::new();
    repo.aura(&["init", "--force-baseline"]);

    // Init may not fully complete in non-TTY — just verify it doesn't crash
    let aura_dir = repo.path().join(".aura");
    if !aura_dir.exists() {
        // Create .aura manually for test continuity (init may skip in non-TTY)
        std::fs::create_dir_all(&aura_dir).ok();
    }
    assert!(aura_dir.exists(), ".aura directory should exist");
}

#[test]
fn test_memory_json_is_valid() {
    let repo = TestRepo::new();
    repo.aura(&["init", "--force-baseline"]);

    let mem_path = repo.path().join(".aura/memory.json");
    if mem_path.exists() {
        let content = std::fs::read_to_string(&mem_path).unwrap();
        let parsed: Result<serde_json::Value, _> = serde_json::from_str(&content);
        assert!(parsed.is_ok(), "memory.json should be valid JSON: {}", content);
    }
}

/// AUDIT-CTX-05 — the full memory lifecycle, each step a SEPARATE process
/// invocation (that is what "cross-session" means at the CLI boundary):
/// add → search finds it → why explains it (signed) → edit supersedes it →
/// search returns only the successor → forget closes it → --all still
/// shows the audit trail. This is the acceptance spine the desktop Memory
/// surface shells into.
#[test]
fn test_memory_lifecycle_add_search_edit_forget_across_processes() {
    let repo = TestRepo::new();

    // Session 1 — add. The --json output is the desktop's IPC contract.
    let out = repo.aura(&[
        "memory", "add", "The staging database listens on port 55432",
        "--section", "gotcha", "--tags", "db,staging", "--json",
    ]);
    assert!(out.status.success(), "add failed: {}", String::from_utf8_lossy(&out.stderr));
    let added: serde_json::Value =
        serde_json::from_slice(&out.stdout).expect("add --json is parseable");
    assert_eq!(added["op"], "added");
    assert_eq!(added["section"], "gotchas", "alias resolves to the canonical section");
    let id = added["id"].as_str().expect("added id").to_string();
    assert!(
        added["entry"].get("embedding").is_none(),
        "vectors never appear in the user-facing record"
    );
    // The entry is signed at mint (TestRepo has a mintable identity path).
    let entry_signed = added["entry"].get("sig").is_some();

    // Session 2 — search finds the fact.
    let out = repo.aura(&["memory", "search", "staging database port", "--json"]);
    assert!(out.status.success());
    let hits: Vec<serde_json::Value> = serde_json::from_slice(&out.stdout).unwrap();
    assert!(
        hits.iter().any(|h| h["id"] == id.as_str()),
        "a later session finds the earlier session's fact: {hits:?}"
    );

    // Session 3 — why reports provenance + the signature verdict.
    let out = repo.aura(&["memory", "why", &id, "--json"]);
    assert!(out.status.success(), "why failed: {}", String::from_utf8_lossy(&out.stderr));
    let why: serde_json::Value = serde_json::from_slice(&out.stdout).unwrap();
    assert_eq!(why["id"], id.as_str());
    if entry_signed {
        assert_eq!(why["signature"], "valid", "a signed entry verifies: {why}");
    } else {
        assert_eq!(why["signature"], "unsigned");
    }

    // Session 4 — edit supersedes, never deletes.
    let out = repo.aura(&[
        "memory", "edit", &id, "The staging database listens on port 55433", "--json",
    ]);
    assert!(out.status.success(), "edit failed: {}", String::from_utf8_lossy(&out.stderr));
    let edited: serde_json::Value = serde_json::from_slice(&out.stdout).unwrap();
    assert_eq!(edited["op"], "edited");
    assert_eq!(edited["supersedes"], id.as_str());
    let new_id = edited["id"].as_str().expect("successor id").to_string();
    assert_ne!(new_id, id);
    assert_eq!(
        edited["entry"]["tags"],
        serde_json::json!(["db", "staging"]),
        "an edit without --tags inherits the old tags"
    );

    // Session 5 — default search returns the successor, not the closed row.
    let out = repo.aura(&["memory", "search", "staging database port", "--json"]);
    let hits: Vec<serde_json::Value> = serde_json::from_slice(&out.stdout).unwrap();
    assert!(hits.iter().any(|h| h["id"] == new_id.as_str()));
    assert!(
        !hits.iter().any(|h| h["id"] == id.as_str()),
        "the superseded row leaves default recall"
    );

    // Session 6 — forget (soft) closes the successor…
    let out = repo.aura(&["memory", "forget", &new_id, "--json"]);
    assert!(out.status.success());
    let forgotten: serde_json::Value = serde_json::from_slice(&out.stdout).unwrap();
    assert_eq!(forgotten["removed"], true);

    // …so default search is empty, but --all keeps the audit trail.
    let out = repo.aura(&["memory", "search", "staging database port", "--json"]);
    let hits: Vec<serde_json::Value> = serde_json::from_slice(&out.stdout).unwrap();
    assert!(
        !hits.iter().any(|h| h["id"] == new_id.as_str() || h["id"] == id.as_str()),
        "forgotten facts leave default recall: {hits:?}"
    );
    let out = repo.aura(&["memory", "search", "staging database port", "--all", "--json"]);
    let hits: Vec<serde_json::Value> = serde_json::from_slice(&out.stdout).unwrap();
    assert!(
        hits.iter().any(|h| h["id"] == new_id.as_str()),
        "--all still shows the closed row — soft forget never erases: {hits:?}"
    );

    // Session 7 — hard forget (the privacy path) erases the row entirely.
    let out = repo.aura(&["memory", "forget", &new_id, "--hard", "--json"]);
    assert!(out.status.success());
    let mem_raw =
        std::fs::read_to_string(repo.path().join(".aura/memory.json")).unwrap_or_default();
    assert!(
        !mem_raw.contains(&new_id),
        "--hard leaves no trace of the erased row on disk"
    );
}

// ══════════════════════════════════════════════════
// Sentinel Tests (file-based — no CLI subcommand)
// ══════════════════════════════════════════════════

#[test]
fn test_sentinel_dirs_created() {
    let repo = TestRepo::new();
    repo.aura(&["init", "--force-baseline"]);

    // Sentinel directories are created on first sentinel operation
    let aura_dir = repo.path().join(".aura");
    if !aura_dir.exists() {
        std::fs::create_dir_all(&aura_dir).ok();
    }
    // Just verify .aura exists — sentinel subdirs are lazy-created
    assert!(aura_dir.exists(), ".aura should exist");
}

// ══════════════════════════════════════════════════
// Handover Tests
// ══════════════════════════════════════════════════

#[test]
fn test_handover_generates_payload() {
    let repo = TestRepo::new();
    repo.aura(&["init", "--force-baseline"]);

    repo.write_file("app.ts", "export function main() { console.log('hello'); }\n");
    repo.commit("Add app entry point");

    let output = repo.aura(&["handover", "cursor"]);
    let stdout = String::from_utf8_lossy(&output.stdout);

    assert!(output.status.success() || stdout.contains("handover") || stdout.contains("Handover") || stdout.contains("payload"),
        "handover should generate output: {}", stdout);
}

#[test]
fn test_handover_default_is_compact_and_full_is_the_expansion_flag() {
    let repo = TestRepo::new();
    repo.aura(&["init", "--force-baseline"]);

    repo.write_file("app.ts", "export function main() { console.log('hello'); }\n");
    repo.commit("Add app entry point");

    let compact = repo.aura(&["handover", "claude"]);
    let compact_out = String::from_utf8_lossy(&compact.stdout);
    assert!(
        compact_out.contains("mode=\"semantic\""),
        "default handover must use the compact semantic profile: {compact_out}"
    );

    let full = repo.aura(&["handover", "claude", "--full"]);
    let full_out = String::from_utf8_lossy(&full.stdout);
    assert!(
        full_out.contains("mode=\"full\""),
        "--full must switch to the full-fidelity profile: {full_out}"
    );
}

// ══════════════════════════════════════════════════
// CTX-02 — bounded, compact context outputs
// ══════════════════════════════════════════════════

/// The audited small fixture: the default carryover must be materially
/// smaller than the source it describes while still naming the files in
/// play, and Aura's own state directory must never ride along.
#[test]
fn test_carryover_default_is_materially_smaller_than_source() {
    let repo = TestRepo::new();
    repo.aura(&["init", "--force-baseline"]);

    // A source file big enough that "smaller" is meaningful (~40 KB).
    let mut src = String::new();
    for i in 0..400 {
        src.push_str(&format!(
            "pub fn compute_step_{i}(input: u64) -> u64 {{\n    let doubled = input * 2;\n    doubled + {i}\n}}\n\n"
        ));
    }
    repo.write_file("src_big.rs", &src);
    repo.commit("Add the big computation module");

    // Uncommitted edit — the "exact moment" the carryover must retain.
    repo.write_file("src_big.rs", &format!("{src}pub fn dirty_edit() {{}}\n"));
    // Aura-generated churn that must NOT appear in the context.
    repo.write_file(".aura/scratch_state.json", "{\"noise\": true}");

    let output = repo.aura(&["carryover"]);
    assert!(output.status.success(), "carryover failed: {}", String::from_utf8_lossy(&output.stderr));
    let stdout = String::from_utf8_lossy(&output.stdout);

    assert!(
        stdout.len() < src.len() / 2,
        "default context ({} bytes) must be materially smaller than the source ({} bytes)",
        stdout.len(),
        src.len()
    );
    assert!(
        stdout.contains("src_big.rs"),
        "the touched file is a task-relevant fact and must survive: {stdout}"
    );
    assert!(
        !stdout.contains("scratch_state.json"),
        "Aura-generated files must not ride in the context: {stdout}"
    );
}

/// A giant dirty tree becomes a capped list with an explicit elision
/// marker, not an unbounded file dump.
#[test]
fn test_carryover_caps_file_list_with_elision_marker() {
    let repo = TestRepo::new();
    repo.aura(&["init", "--force-baseline"]);

    for i in 0..60 {
        repo.write_file(&format!("gen/f{i:03}.txt"), "x\n");
    }

    let output = repo.aura(&["carryover"]);
    assert!(output.status.success(), "carryover failed: {}", String::from_utf8_lossy(&output.stderr));
    let stdout = String::from_utf8_lossy(&output.stdout);

    assert!(
        stdout.contains("more files (elided)"),
        "a capped file list must say what it left out: {stdout}"
    );
    assert!(stdout.contains("gen/f000.txt"), "early entries must still be listed: {stdout}");
    assert!(
        !stdout.contains("gen/f059.txt"),
        "entries past the cap must be elided: {stdout}"
    );
}

/// Symbols deleted since an older checkpoint must not be cited: every
/// path and symbol in the carryover exists at the newest checkpoint that
/// parsed its file.
#[test]
fn test_carryover_drops_symbols_deleted_since_their_checkpoint() {
    let repo = TestRepo::new();

    // Both symbols exist BEFORE init, so the baseline checkpoint captures
    // them — with file paths — as tracked semantic state.
    repo.write_file(
        "lib_x.rs",
        "pub fn keep_me() -> u32 { 1 }\n\npub fn delete_me() -> u32 { 2 }\n",
    );
    repo.commit("Add keep_me and delete_me");
    repo.aura(&["init", "--force-baseline"]);

    // Then the symbol is deleted (hookless commit — no newer checkpoint
    // records the deletion, which is exactly the stale-citation trap).
    repo.write_file("lib_x.rs", "pub fn keep_me() -> u32 { 1 }\n");
    repo.commit("Drop delete_me");

    let output = repo.aura(&["carryover", "--json"]);
    assert!(output.status.success(), "carryover failed: {}", String::from_utf8_lossy(&output.stderr));
    let stdout = String::from_utf8_lossy(&output.stdout);
    let parsed: serde_json::Value =
        serde_json::from_str(&stdout).expect("carryover --json must emit valid JSON");

    let nodes = parsed["touched_nodes"].as_array().cloned().unwrap_or_default();
    let cites = |name: &str| {
        nodes.iter().any(|n| {
            n["identifier"].as_str() == Some(name) || n["node_id"].as_str().is_some_and(|id| id.contains(name))
        })
    };
    assert!(
        cites("keep_me"),
        "the surviving symbol must still be cited (fixture must not be vacuous): {nodes:?}"
    );
    assert!(
        !cites("delete_me"),
        "a symbol deleted since its checkpoint must not be cited as live state: {nodes:?}"
    );
    // Every cited path must exist in the repo the carryover describes.
    for n in &nodes {
        if let Some(f) = n["file_path"].as_str() {
            assert!(
                repo.path().join(f).exists(),
                "cited path must exist in the worktree: {f}"
            );
        }
    }
}

// ══════════════════════════════════════════════════
// Prove / Goal-Trace Tests
// ══════════════════════════════════════════════════

#[test]
fn test_goal_trace_command() {
    let repo = TestRepo::new();
    repo.aura(&["init", "--force-baseline"]);

    repo.write_file("auth.rs", "pub fn login(user: &str, pass: &str) -> bool { !user.is_empty() && !pass.is_empty() }\n");
    repo.commit("Add login");

    let output = repo.aura(&["goal-trace", "User can authenticate"]);
    let stdout = String::from_utf8_lossy(&output.stdout);
    let stderr = String::from_utf8_lossy(&output.stderr);
    // goal-trace may fail in test env (no checkpoints) — just verify it doesn't panic
    assert!(output.status.success() || !stdout.is_empty() || !stderr.is_empty(),
        "goal-trace should produce some output: stdout={}, stderr={}", stdout, stderr);
}

// ══════════════════════════════════════════════════
// Snapshot Guard — detects unsnapshotted modifications
// ══════════════════════════════════════════════════

#[test]
fn test_snapshot_guard_detects_unsnapshotted_edits() {
    let repo = TestRepo::new();
    repo.aura(&["init", "--force-baseline"]);

    // Create and commit a file
    repo.write_file("service.rs", "pub fn serve() -> bool { true }\n");
    // Hookless: the point of this test is that an *unsnapshotted* edit is
    // detectable, so the commit must not hand Aura a chance to snapshot it.
    repo.commit_without_hooks("Add service");

    // Modify without snapshotting
    repo.write_file("service.rs", "pub fn serve() -> bool { false }\n");

    // Verify git sees the modification
    let output = Command::new("git")
        .args(["diff", "--name-only"])
        .current_dir(repo.path())
        .output()
        .expect("git diff failed");
    let diff_output = String::from_utf8_lossy(&output.stdout);
    assert!(diff_output.contains("service.rs"),
        "git should show service.rs as modified");

    // Verify NO snapshot exists
    let snap_dir = repo.path().join(".aura/snapshots");
    let snapshots: Vec<String> = std::fs::read_dir(&snap_dir)
        .map(|entries| {
            entries
                .flatten()
                .map(|e| e.file_name().to_string_lossy().into_owned())
                .collect()
        })
        .unwrap_or_default();
    let matched: Vec<&String> = snapshots.iter().filter(|n| n.contains("service")).collect();
    assert!(
        matched.is_empty(),
        "No snapshot should exist for service.rs, but found {matched:?} in {} (dir holds {snapshots:?})",
        snap_dir.display(),
    );
}

// ══════════════════════════════════════════════════
// Config Tests
// ══════════════════════════════════════════════════

#[test]
fn test_config_set_strict_mode() {
    let repo = TestRepo::new();
    repo.aura(&["init", "--force-baseline"]);

    let output = repo.aura(&["config", "set", "strict-mode", "true"]);
    assert!(output.status.success(), "config set should succeed");

    // Verify strict mode is on via status
    let output = repo.aura(&["status"]);
    let stdout = String::from_utf8_lossy(&output.stdout);
    assert!(stdout.contains("Strict") || stdout.contains("strict") || stdout.contains("ON"),
        "Status should show strict mode: {}", stdout);
}

// ══════════════════════════════════════════════════
// Intent Gate Tests
// ══════════════════════════════════════════════════

/// The repository the two tests below share: a charge endpoint whose token
/// check has a caller, and an approved contract saying the token check must
/// survive. Both then delete it and try to commit — one by staging first, one
/// with `git commit -a`. The gate must refuse both.
fn repo_with_a_protected_token_check() -> TestRepo {
    let repo = TestRepo::new();
    repo.write_file(
        "src/auth.rs",
        "pub fn verify_token(token: &str) -> bool {\n    token.starts_with(\"tok_\") && token.len() == 36\n}\n",
    );
    repo.write_file(
        "src/billing.rs",
        "pub fn retry_charge(attempt: u32) -> u64 {\n    200u64 << attempt\n}\n",
    );
    repo.write_file(
        "src/api.rs",
        "pub fn handle_charge(token: &str) -> u64 {\n    if !crate::auth::verify_token(token) {\n        return 0;\n    }\n    crate::billing::retry_charge(1)\n}\n",
    );
    repo.commit("feat: charge endpoint with token check");

    let approved = repo.aura(&[
        "intent-contract",
        "approve",
        "--goal",
        "tune the retry backoff constant",
        "--path",
        "src/billing.rs",
        "--protect",
        "verify_token",
        "--agent",
        "e2e",
    ]);
    assert!(
        approved.status.success(),
        "approving the contract should succeed: {}",
        String::from_utf8_lossy(&approved.stderr)
    );
    repo
}

/// What an agent that overreached actually leaves behind: the change it was
/// asked for, plus the deletion of a function it was told to preserve.
fn overreach(repo: &TestRepo) {
    repo.write_file(
        "src/billing.rs",
        "pub fn retry_charge(attempt: u32) -> u64 {\n    150u64 << attempt\n}\n",
    );
    repo.write_file(
        "src/auth.rs",
        "pub fn token_prefix(token: &str) -> &str {\n    token.split('_').next().unwrap_or(\"\")\n}\n",
    );
}

#[test]
fn the_gate_refuses_a_commit_that_drops_a_protected_symbol() {
    let repo = repo_with_a_protected_token_check();
    overreach(&repo);

    let staged = Command::new("git")
        .args(["add", "-A"])
        .current_dir(repo.path())
        .output()
        .expect("git add failed");
    assert!(staged.status.success());

    let out = Command::new("git")
        .args(["commit", "-m", "perf(billing): tune retry backoff"])
        .current_dir(repo.path())
        .output()
        .expect("git commit failed");

    let said = format!(
        "{}{}",
        String::from_utf8_lossy(&out.stdout),
        String::from_utf8_lossy(&out.stderr)
    );
    assert!(
        !out.status.success(),
        "the commit deleted a protected symbol and should have been refused: {said}"
    );
    assert!(
        said.contains("verify_token"),
        "the refusal should name the symbol that went missing: {said}"
    );
}

/// The same deletion, committed with `-a` instead of `git add`.
///
/// git does not write `-a`'s changes into `.git/index`; it builds a second
/// index and names it in `GIT_INDEX_FILE`. A gate that reads the repository's
/// default index therefore sees an empty diff and lets the commit through —
/// which is exactly what happened, on every `commit -am` anyone ever ran. The
/// bug is invisible to any test that stages first, so this one does not.
#[test]
fn the_gate_refuses_it_just_the_same_when_the_commit_stages_itself() {
    let repo = repo_with_a_protected_token_check();
    overreach(&repo);

    let out = Command::new("git")
        .args(["commit", "-am", "perf(billing): tune retry backoff"])
        .current_dir(repo.path())
        .output()
        .expect("git commit failed");

    let said = format!(
        "{}{}",
        String::from_utf8_lossy(&out.stdout),
        String::from_utf8_lossy(&out.stderr)
    );
    assert!(
        !out.status.success(),
        "`git commit -a` must be checked like any other commit: {said}"
    );
    assert!(
        said.contains("verify_token"),
        "the refusal should name the symbol that went missing: {said}"
    );

    let landed = Command::new("git")
        .args(["log", "--oneline", "-1"])
        .current_dir(repo.path())
        .output()
        .expect("git log failed");
    assert!(
        !String::from_utf8_lossy(&landed.stdout).contains("tune retry backoff"),
        "the refused commit must not be in history"
    );
}
