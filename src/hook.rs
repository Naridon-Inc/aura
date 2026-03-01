use std::fs;
use std::os::unix::fs::PermissionsExt;
use std::path::Path;

pub struct HookInstaller;

impl HookInstaller {
    /// Installs the Aura semantic engine directly into standard Git as a suite of hooks.
    /// This is the "Entire.io" distribution model: zero friction, Git-native storage.
    pub fn enable() -> Result<(), Box<dyn std::error::Error>> {
        let git_dir = Path::new(".git");
        if !git_dir.exists() {
            return Err("Not a git repository. Please run `git init` first.".into());
        }

        let hooks_dir = git_dir.join("hooks");
        fs::create_dir_all(&hooks_dir)?;

        // 1. The Pre-Commit Hook (Scrapes intent and ASTs)
        let pre_commit_path = hooks_dir.join("pre-commit");
        let pre_commit_script = r#"#!/bin/sh
echo "[Aura] Analyzing staged files semantically..."
~/.cargo/bin/aura capture-context
if [ $? -ne 0 ]; then
    echo "[Aura] Semantic analysis failed. Commit aborted."
    exit 1
fi
"#;
        fs::write(&pre_commit_path, pre_commit_script)?;
        Self::make_executable(&pre_commit_path)?;

        // 2. The Commit-Msg Hook (Injects the Trailer)
        let commit_msg_path = hooks_dir.join("commit-msg");
        let commit_msg_script = r#"#!/bin/sh
~/.cargo/bin/aura inject-trailer "$1"
"#;
        fs::write(&commit_msg_path, commit_msg_script)?;
        Self::make_executable(&commit_msg_path)?;

        // 3. The Post-Commit Hook (Saves to the hidden branch)
        let post_commit_path = hooks_dir.join("post-commit");
        let post_commit_script = r#"#!/bin/sh
~/.cargo/bin/aura persist-checkpoint
"#;
        fs::write(&post_commit_path, post_commit_script)?;
        Self::make_executable(&post_commit_path)?;

        println!("✓ Hooks installed (Aura is now parasitic to Git)");
        println!("✓ Project configured with pre-commit, commit-msg, and post-commit hooks");
        println!("Ready.");

        Ok(())
    }

    fn make_executable(path: &Path) -> Result<(), std::io::Error> {
        let mut perms = fs::metadata(path)?.permissions();
        perms.set_mode(0o755);
        fs::set_permissions(path, perms)
    }
}
