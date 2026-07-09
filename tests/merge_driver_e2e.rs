//! Integration test: a real `git merge` with the aura merge driver configured.
//!
//! Scenario chosen so that PLAIN git would textually conflict: both branches
//! append a different function at the end of the same file (classic add/add).
//! With the driver, the semantic union keeps both functions and the merge
//! commits cleanly.

use std::path::Path;
use std::process::Command;

fn git(dir: &Path, args: &[&str]) -> std::process::Output {
    Command::new("git")
        .args(args)
        .current_dir(dir)
        .env("GIT_CONFIG_NOSYSTEM", "1")
        .output()
        .unwrap_or_else(|e| panic!("git {:?} failed to spawn: {}", args, e))
}

fn git_ok(dir: &Path, args: &[&str]) {
    let out = git(dir, args);
    assert!(
        out.status.success(),
        "git {:?} failed:\nstdout: {}\nstderr: {}",
        args,
        String::from_utf8_lossy(&out.stdout),
        String::from_utf8_lossy(&out.stderr)
    );
}

const BASE: &str = "use std::fmt;\n\nfn alpha() -> i32 {\n    1\n}\n\nfn beta() -> i32 {\n    2\n}\n";

#[test]
fn real_git_merge_uses_driver_for_add_add() {
    let aura_bin = env!("CARGO_BIN_EXE_aura");

    let dir = tempfile::tempdir().expect("tempdir");
    let repo = dir.path();

    git_ok(repo, &["init", "-b", "main"]);
    git_ok(repo, &["config", "user.email", "test@aura.test"]);
    git_ok(repo, &["config", "user.name", "Aura Test"]);
    git_ok(repo, &["config", "commit.gpgsign", "false"]);

    std::fs::write(repo.join("lib.rs"), BASE).expect("write base");
    git_ok(repo, &["add", "."]);
    git_ok(repo, &["commit", "-m", "base", "--no-verify"]);

    // Configure the driver pointing at the test-built binary. The path can
    // contain spaces (".../New Git/..."), so quote it for the shell.
    git_ok(repo, &["config", "merge.aura.name", "Aura semantic AST merge"]);
    // The binary path needs quoting (".../New Git/..." has a space) but %P
    // must stay BARE — git shell-quotes the substituted path itself.
    let driver_cmd = format!(
        "\"{}\" merge-driver %O %A %B --marker-size %L --path %P",
        aura_bin
    );
    git_ok(repo, &["config", "merge.aura.driver", &driver_cmd]);
    std::fs::create_dir_all(repo.join(".git/info")).expect("info dir");
    std::fs::write(repo.join(".git/info/attributes"), "*.rs merge=aura\n")
        .expect("write attributes");

    // Branch A appends gamma.
    git_ok(repo, &["checkout", "-b", "feature-a"]);
    std::fs::write(
        repo.join("lib.rs"),
        format!("{}\nfn gamma() -> i32 {{\n    3\n}}\n", BASE),
    )
    .expect("write a");
    git_ok(repo, &["commit", "-am", "add gamma", "--no-verify"]);

    // main appends delta at the same spot.
    git_ok(repo, &["checkout", "main"]);
    std::fs::write(
        repo.join("lib.rs"),
        format!("{}\nfn delta() -> i32 {{\n    4\n}}\n", BASE),
    )
    .expect("write b");
    git_ok(repo, &["commit", "-am", "add delta", "--no-verify"]);

    // A clean merge that lands BOTH functions is only possible via the
    // driver: stock git textually conflicts on this add/add (both branches
    // appended different lines at the same spot).
    let merge = git(repo, &["merge", "--no-edit", "feature-a"]);
    let merged = std::fs::read_to_string(repo.join("lib.rs")).expect("read merged");
    assert!(
        merge.status.success(),
        "merge failed.\nstdout: {}\nstderr: {}\nfile:\n{}",
        String::from_utf8_lossy(&merge.stdout),
        String::from_utf8_lossy(&merge.stderr),
        merged
    );
    assert!(merged.contains("fn gamma"), "gamma missing:\n{}", merged);
    assert!(merged.contains("fn delta"), "delta missing:\n{}", merged);
    assert!(!merged.contains("<<<<<<<"), "conflict markers left:\n{}", merged);
    // Untouched parts intact.
    assert!(merged.contains("use std::fmt;"));
    assert!(merged.contains("fn alpha"));
    assert!(merged.contains("fn beta"));
}

#[test]
fn real_git_merge_conflicts_on_same_function() {
    let aura_bin = env!("CARGO_BIN_EXE_aura");

    let dir = tempfile::tempdir().expect("tempdir");
    let repo = dir.path();

    git_ok(repo, &["init", "-b", "main"]);
    git_ok(repo, &["config", "user.email", "test@aura.test"]);
    git_ok(repo, &["config", "user.name", "Aura Test"]);
    git_ok(repo, &["config", "commit.gpgsign", "false"]);

    std::fs::write(repo.join("lib.rs"), BASE).expect("write base");
    git_ok(repo, &["add", "."]);
    git_ok(repo, &["commit", "-m", "base", "--no-verify"]);

    git_ok(repo, &["config", "merge.aura.name", "Aura semantic AST merge"]);
    // The binary path needs quoting (".../New Git/..." has a space) but %P
    // must stay BARE — git shell-quotes the substituted path itself.
    let driver_cmd = format!(
        "\"{}\" merge-driver %O %A %B --marker-size %L --path %P",
        aura_bin
    );
    git_ok(repo, &["config", "merge.aura.driver", &driver_cmd]);
    std::fs::create_dir_all(repo.join(".git/info")).expect("info dir");
    std::fs::write(repo.join(".git/info/attributes"), "*.rs merge=aura\n")
        .expect("write attributes");

    git_ok(repo, &["checkout", "-b", "feature-a"]);
    std::fs::write(repo.join("lib.rs"), BASE.replace("    1", "    111")).expect("write a");
    git_ok(repo, &["commit", "-am", "alpha=111", "--no-verify"]);

    git_ok(repo, &["checkout", "main"]);
    std::fs::write(repo.join("lib.rs"), BASE.replace("    1", "    999")).expect("write b");
    git_ok(repo, &["commit", "-am", "alpha=999", "--no-verify"]);

    let merge = git(repo, &["merge", "--no-edit", "feature-a"]);
    assert!(!merge.status.success(), "same-function merge must conflict");
    let merged = std::fs::read_to_string(repo.join("lib.rs")).expect("read merged");
    assert!(merged.contains("<<<<<<<"), "markers expected:\n{}", merged);
    assert!(merged.contains("111") && merged.contains("999"), "both sides shown:\n{}", merged);
    assert!(merged.contains("fn beta"), "untouched fn intact:\n{}", merged);
}
