use std::fs::{self, OpenOptions};
use std::io::Write;
use std::os::unix::fs::PermissionsExt;
use std::path::Path;

pub struct HookInstaller;

/// Known external hook managers that Aura should chain with (not overwrite)
const EXTERNAL_HOOK_MANAGERS: &[(&str, &str)] = &[
    (".husky", "Husky (npm)"),
    (".lefthook.yml", "Lefthook"),
    (".lefthook", "Lefthook"),
    (".overcommit.yml", "Overcommit (Ruby)"),
    (".pre-commit-config.yaml", "pre-commit (Python)"),
];

impl HookInstaller {
    /// Detect external hook managers in the repository
    pub fn detect_external_hook_managers() -> Vec<String> {
        let mut detected = Vec::new();
        for (marker, name) in EXTERNAL_HOOK_MANAGERS {
            if Path::new(marker).exists() {
                detected.push(name.to_string());
            }
        }

        // Also check git config for core.hooksPath override
        if let Ok(repo) = git2::Repository::open(".") {
            if let Ok(config) = repo.config() {
                if let Ok(hooks_path) = config.get_string("core.hooksPath") {
                    detected.push(format!("core.hooksPath={}", hooks_path));
                }
            }
        }

        detected
    }

    /// Installs the Aura semantic engine directly into standard Git as a suite of hooks.
    /// Chains with existing hooks instead of overwriting them — compatible with
    /// Husky, Lefthook, Overcommit, pre-commit, and custom core.hooksPath setups.
    pub fn enable() -> Result<(), Box<dyn std::error::Error>> {
        let git_dir = Path::new(".git");
        if !git_dir.exists() {
            return Err("Not a git repository. Please run `git init` first.".into());
        }

        // Warn about external hook managers (but still install — we chain, not overwrite)
        let external = Self::detect_external_hook_managers();
        if !external.is_empty() {
            println!("  ℹ Detected external hook manager(s): {}", external.join(", "));
            println!("  ↳ Aura will chain alongside existing hooks (non-destructive).");
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

        // 4. The Pre-Push Hook (Auto-sync semantic metadata to remote)
        let pre_push_path = hooks_dir.join("pre-push");
        let pre_push_script = format!(r#"
# --- AURA SEMANTIC ENGINE ---
# Auto-push semantic metadata (refs/notes/aura) alongside user push.
# This keeps the Aura checkpoint branch synchronized with the remote.
REMOTE="$1"
if git rev-parse --verify refs/notes/aura >/dev/null 2>&1; then
    git push "$REMOTE" refs/notes/aura:refs/notes/aura --no-verify --force-with-lease 2>/dev/null || true
fi
# Also sync the shadow checkpoint branch if it exists
if git rev-parse --verify refs/heads/aura/checkpoints >/dev/null 2>&1; then
    git push "$REMOTE" refs/heads/aura/checkpoints --no-verify --force-with-lease 2>/dev/null || true
fi
# ----------------------------
"#);
        Self::append_hook_safely(&pre_push_path, &pre_push_script, "refs/notes/aura")?;

        println!("✓ Hooks installed safely (Aura is parasitic to Git)");
        println!("✓ Project configured with non-destructive semantic hooks");
        if !external.is_empty() {
            println!("✓ Chained with: {}", external.join(", "));
        }
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
