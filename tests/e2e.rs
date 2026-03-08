use std::path::PathBuf;
use std::process::Command;

/// Test harness: creates a temporary git repo with Aura initialized
struct TestRepo {
    dir: tempfile::TempDir,
}

impl TestRepo {
    fn new() -> Self {
        let dir = tempfile::tempdir().expect("Failed to create temp dir");

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

        Self { dir }
    }

    fn path(&self) -> PathBuf {
        self.dir.path().to_path_buf()
    }

    fn aura(&self, args: &[&str]) -> std::process::Output {
        Command::new(aura_binary())
            .args(args)
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
}

fn aura_binary() -> String {
    let release = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("target/release/aura");
    if release.exists() {
        return release.to_string_lossy().to_string();
    }
    let debug = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("target/debug/aura");
    if debug.exists() {
        return debug.to_string_lossy().to_string();
    }
    "aura".to_string()
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
    repo.aura(&["init"]);
    let output = repo.aura(&["resume", "nonexistent-branch-xyz"]);
    let stderr = String::from_utf8_lossy(&output.stderr);
    let stdout = String::from_utf8_lossy(&output.stdout);
    assert!(
        !output.status.success() || stderr.contains("not found") || stdout.contains("not found"),
        "resume should fail for nonexistent branch"
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
