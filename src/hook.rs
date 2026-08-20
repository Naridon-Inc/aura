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

    /// The directory git will actually run this repository's hooks from.
    ///
    /// `.git/hooks` is only right for a plain checkout. In a linked worktree
    /// `.git` is a *file* pointing at `…/.git/worktrees/<name>`, so creating
    /// `.git/hooks` there fails outright with "Not a directory" — which is how
    /// `aura enable` used to die inside every worktree, leaving capture off
    /// with no way to turn it on. A repo with `core.hooksPath` set runs hooks
    /// from that directory and nowhere else, so writing to `.git/hooks` there
    /// installs hooks git never calls. `git rev-parse --git-path hooks`
    /// answers both cases exactly the way git itself resolves them (shared
    /// common dir for worktrees, the configured path when one is set).
    /// Falls back to `.git/hooks` only if git can't be run at all.
    pub fn hooks_dir() -> std::path::PathBuf {
        let fallback = Path::new(".git").join("hooks");
        let Ok(out) = std::process::Command::new("git")
            .args(["rev-parse", "--git-path", "hooks"])
            .output()
        else {
            return fallback;
        };
        if !out.status.success() {
            return fallback;
        }
        let resolved = String::from_utf8_lossy(&out.stdout).trim().to_string();
        if resolved.is_empty() {
            return fallback;
        }
        std::path::PathBuf::from(resolved)
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

        let hooks_dir = Self::hooks_dir();
        fs::create_dir_all(&hooks_dir)?;

        let current_exe = std::env::current_exe().unwrap_or_else(|_| std::path::PathBuf::from("aura"));
        // The invocation in every generated hook MUST quote this path: a user's
        // install dir or repo path can contain spaces (e.g. ".../New Git/...").
        // Unquoted, /bin/sh word-splits it and the commit dies with
        // "<first-word>: is a directory" — and because the pre-commit hook then
        // `exit 1`s, it blocks the commit entirely. So we wrap `{aura_path}` in
        // double quotes at every call site below.
        let aura_path = current_exe.to_string_lossy();

        // 1. The Pre-Commit Hook (Scrapes intent and ASTs)
        let pre_commit_path = hooks_dir.join("pre-commit");
        let pre_commit_script = format!(r#"
# --- AURA SEMANTIC ENGINE ---
echo "[Aura] Analyzing staged files semantically..."
"{}" capture-context
if [ $? -ne 0 ]; then
    echo "[Aura] Semantic analysis failed. Commit aborted."
    exit 1
fi
# ----------------------------
"#, aura_path);
        Self::append_hook_safely(&pre_commit_path, &pre_commit_script, "capture-context")?;

        // 1b. The staged intent gate. Own block + own marker for the same
        // reason as 3c/4b below: `append_hook_safely` returns the moment it
        // finds the block above's marker, so anything folded into it would
        // never install on a repo that is already wired.
        Self::arm_intent_gate()?;

        // 2. The Commit-Msg Hook (Injects the Trailer)
        let commit_msg_path = hooks_dir.join("commit-msg");
        let commit_msg_script = format!(r#"
# --- AURA SEMANTIC ENGINE ---
"{}" inject-trailer "$1"
# ----------------------------
"#, aura_path);
        Self::append_hook_safely(&commit_msg_path, &commit_msg_script, "inject-trailer")?;

        // 3. The Post-Commit Hook (Saves to the hidden branch)
        let post_commit_path = hooks_dir.join("post-commit");
        let post_commit_script = format!(r#"
# --- AURA SEMANTIC ENGINE ---
"{}" persist-checkpoint
# ----------------------------
"#, aura_path);
        Self::append_hook_safely(&post_commit_path, &post_commit_script, "persist-checkpoint")?;

        // 3b. The Post-Merge Hook (W4: reconcile hand-edits into CRDT after
        // `git pull` / `git merge` so concurrent branches stay in sync).
        let post_merge_path = hooks_dir.join("post-merge");
        let post_merge_script = format!(r#"
# --- AURA SEMANTIC ENGINE ---
# W4: feed post-merge workdir state back into CRDT so hand-edits that
# arrived via `git pull` are pushed to the cloud ops log.
"{}" crdt reconcile >/dev/null 2>&1 || true
# ----------------------------
"#, aura_path);
        Self::append_hook_safely(&post_merge_path, &post_merge_script, "crdt reconcile")?;

        // 3c. Intent-in / meaning plane (own block + own marker on purpose).
        // Folding this into the block above would never reach anyone already
        // set up: append_hook_safely bails the moment it sees that block's
        // marker, so an existing repo would silently skip the upgrade. A
        // separate marker lets both fresh and already-wired repos pick it up.
        let post_merge_intent = format!(r#"
# --- AURA MEANING PLANE (intent-in) ---
# Bring teammates' WHY with their code: union-merge the remote's
# aura-intent notes so a `git pull` delivers not just what they changed
# but the intent they logged for it. Without this the meaning plane stays
# on whichever laptop wrote it and a shared project reads silent.
"{}" meta pull >/dev/null 2>&1 || true
# ----------------------------
"#, aura_path);
        Self::append_hook_safely(&post_merge_path, &post_merge_intent, "meta pull")?;

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

        // 4b. Intent-out. Separate block + marker for the same reason as 3c:
        // the block above already exists on every wired repo, so anything
        // added inside it would never install for them.
        let pre_push_intent = format!(r#"
# --- AURA MEANING PLANE (intent-out) ---
# Attribute this push's intent-log rows to their commits as aura-intent
# notes (local only — no network in this step), then ship that ref with
# the code. Pushing checkpoints without intent sends teammates the WHAT
# and keeps the WHY on this machine — the reason a shared project can
# read silent even while everyone is logging intent.
REMOTE="$1"
"{}" meta push --no-push >/dev/null 2>&1 || true
if git rev-parse --verify refs/notes/aura-intent >/dev/null 2>&1; then
    git push "$REMOTE" refs/notes/aura-intent:refs/notes/aura-intent --no-verify --force-with-lease 2>/dev/null || true
fi
# ----------------------------
"#, aura_path);
        Self::append_hook_safely(&pre_push_path, &pre_push_intent, "aura-intent")?;

        println!("✓ Hooks installed safely (Aura is parasitic to Git)");
        println!("✓ Project configured with non-destructive semantic hooks");
        if !external.is_empty() {
            println!("✓ Chained with: {}", external.join(", "));
        }
        println!("Ready.");

        Ok(())
    }

    /// Install just the staged intent gate into `pre-commit`.
    ///
    /// Separate from [`enable`] because the gate has its own moment: approving
    /// an intent contract is a person saying "hold the agent to this", and a
    /// promise that only takes effect after a separate setup step is not a
    /// promise. `aura intent-contract approve` calls this so the gate is armed
    /// the instant it is needed, without dragging in keys, checkpoints or the
    /// rest of the `init` wizard.
    ///
    /// This is the only hook that stops a commit on a *semantic* judgement, so
    /// it is deliberately narrow. It does nothing until a contract exists, and
    /// once one does it blocks on exactly one finding: a protected or exported
    /// symbol was removed and that removal was not approved. `AURA_SKIP=1` is
    /// honoured because a gate with no escape hatch is a gate people uninstall.
    ///
    /// Idempotent — re-approving a contract does not stack duplicate blocks.
    pub fn arm_intent_gate() -> Result<(), Box<dyn std::error::Error>> {
        let hooks_dir = Self::hooks_dir();
        fs::create_dir_all(&hooks_dir)?;

        let current_exe =
            std::env::current_exe().unwrap_or_else(|_| std::path::PathBuf::from("aura"));
        // Quoted at every call site: an install dir or repo path can contain
        // spaces, and an unquoted path makes /bin/sh word-split it and kill the
        // commit with "<first-word>: is a directory".
        let aura_path = current_exe.to_string_lossy();

        let script = format!(
            r#"
# --- AURA INTENT GATE ---
if [ "${{AURA_SKIP:-0}}" != "1" ]; then
    "{}" verify-intent --staged
    if [ $? -ne 0 ]; then
        exit 1
    fi
fi
# ----------------------------
"#,
            aura_path
        );
        Self::append_hook_safely(&hooks_dir.join("pre-commit"), &script, "verify-intent")
    }

    /// Is the intent gate wired into this repository's `pre-commit`?
    pub fn intent_gate_armed() -> bool {
        fs::read_to_string(Self::hooks_dir().join("pre-commit"))
            .map(|s| s.contains("AURA INTENT GATE"))
            .unwrap_or(false)
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
