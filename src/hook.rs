use std::fs::{self, OpenOptions};
use std::io::Write;
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

        let current_exe = std::env::current_exe().unwrap_or_else(|_| std::path::PathBuf::from("aura"));
        let aura_path = current_exe.to_string_lossy();

        // 1. The Pre-Commit Hook (Scrapes intent and ASTs)
        let pre_commit_path = hooks_dir.join("pre-commit");
        let pre_commit_script = format!(r#"
# --- AURA SEMANTIC ENGINE ---
echo "[Aura] Analyzing staged files semantically..."
{} capture-context
if [ $? -ne 0 ]; then
    echo "[Aura] Semantic analysis failed. Commit aborted."
    exit 1
fi
# ----------------------------
"#, aura_path);
        Self::append_hook_safely(&pre_commit_path, &pre_commit_script, "capture-context")?;

        // 2. The Commit-Msg Hook (Injects the Trailer)
        let commit_msg_path = hooks_dir.join("commit-msg");
        let commit_msg_script = format!(r#"
# --- AURA SEMANTIC ENGINE ---
{} inject-trailer "$1"
# ----------------------------
"#, aura_path);
        Self::append_hook_safely(&commit_msg_path, &commit_msg_script, "inject-trailer")?;

        // 3. The Post-Commit Hook (Saves to the hidden branch)
        let post_commit_path = hooks_dir.join("post-commit");
        let post_commit_script = format!(r#"
# --- AURA SEMANTIC ENGINE ---
{} persist-checkpoint
# ----------------------------
"#, aura_path);
        Self::append_hook_safely(&post_commit_path, &post_commit_script, "persist-checkpoint")?;

        println!("✓ Hooks installed safely (Aura is parasitic to Git)");
        println!("✓ Project configured with non-destructive semantic hooks");
        println!("Ready.");

        Ok(())
    }

    fn append_hook_safely(path: &Path, script: &str, signature: &str) -> Result<(), Box<dyn std::error::Error>> {
        let mut needs_shebang = true;
        
        if path.exists() {
            let content = fs::read_to_string(path)?;
            if content.contains(signature) {
                // Already installed
                return Ok(());
            }
            if content.starts_with("#!") {
                needs_shebang = false;
            }
        }

        let mut file = OpenOptions::new().create(true).append(true).open(path)?;
        
        if needs_shebang {
            writeln!(file, "#!/bin/sh")?;
        }
        
        writeln!(file, "{}", script)?;
        
        Self::make_executable(path)?;
        Ok(())
    }

    fn make_executable(path: &Path) -> Result<(), std::io::Error> {
        let mut perms = fs::metadata(path)?.permissions();
        perms.set_mode(0o755);
        fs::set_permissions(path, perms)
    }
}
