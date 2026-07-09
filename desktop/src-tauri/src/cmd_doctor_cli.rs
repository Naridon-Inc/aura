//! Aura CLI version doctor — task #229.
//!
//! Resolves the `aura` binary on PATH, runs `aura --version`, parses the
//! `aura X.Y.Z` line, and compares to the shell's expected CLI version.
//! Powers the footer chip in `StatusBar` so users notice when their
//! installed CLI drifts from the shell's IPC contract (mismatched
//! versions cause MCP tool calls to misbehave silently).
//!
//! The check is *not* a hard gate — outdated/missing only produces an
//! amber/red chip with a copy-install-command popover. The shell still
//! tries every IPC call; the chip just sets expectations.

use serde::Serialize;
use std::io::Write as _;
use std::path::{Path, PathBuf};
use std::process::Command;
use tempfile::NamedTempFile;

/// Expected aura CLI version the shell was built against.
///
/// As of the unified-versioning policy (v0.15.0), the desktop app and the
/// CLI ship as one version, so the shell expects a CLI matching *its own*
/// version — sourced here from `env!("CARGO_PKG_VERSION")` (this crate's
/// `Cargo.toml`, stamped by `scripts/set-version.sh`). One source of truth;
/// no hand-maintained string to drift.
///
/// The comparison is still on `major.minor` only (see `major_minor_matches`),
/// so a patch-level skew between an installed CLI and the shell stays green —
/// it's a soft "are these from the same release line?" chip, not a hard gate.
/// A different minor flips to amber ("outdated"); a missing binary flips to
/// red ("missing").
pub const EXPECTED_AURA_CLI_VERSION: &str = env!("CARGO_PKG_VERSION");

#[derive(Serialize, Clone, Debug)]
pub struct AuraCliVersionCheck {
    /// Parsed `X.Y.Z` from `aura --version`, or `None` if the binary
    /// is missing / unreadable / produces unparseable output.
    pub installed: Option<String>,
    /// The shell's expected CLI version (constant above).
    pub expected: String,
    /// Resolved absolute path to the `aura` binary on PATH. `None` when
    /// `which aura` finds nothing.
    pub path: Option<String>,
    /// Coarse status used by the footer chip:
    ///
    ///   * `"ok"`        — installed.major.minor >= expected.major.minor
    ///                     (same OR newer; a newer CLI is never downgraded)
    ///   * `"outdated"`  — installed exists but is strictly OLDER on major/minor
    ///   * `"missing"`   — `which aura` failed (no binary on PATH)
    ///   * `"unknown"`   — binary found but `--version` output didn't
    ///                     parse (e.g. someone aliased `aura` to a wrapper)
    pub status: String,
    /// Raw first non-empty line from `aura --version`, kept for the
    /// popover so users can sanity-check what we actually saw.
    pub raw: Option<String>,
}

/// Spawn `which aura` (or `where.exe aura` on Windows) and return the
/// resolved path, or `None` when no binary is on PATH.
fn resolve_aura_path() -> Option<String> {
    #[cfg(windows)]
    let cmd = "where";
    #[cfg(not(windows))]
    let cmd = "which";
    let out = Command::new(cmd).arg("aura").output().ok()?;
    if !out.status.success() {
        return None;
    }
    let s = String::from_utf8_lossy(&out.stdout).trim().to_string();
    // `where.exe` can print multiple paths — take the first.
    let first = s.lines().next().map(|l| l.trim().to_string())?;
    if first.is_empty() {
        None
    } else {
        Some(first)
    }
}

/// Extract `X.Y.Z` (or `X.Y.Z-suffix`) from `aura --version` output.
/// The CLI prints `aura 0.15.1` today; this is intentionally lenient so
/// we keep working if a future build adds a build-suffix or branding.
fn parse_version_line(line: &str) -> Option<String> {
    // Find the first whitespace-delimited token that looks like
    // <digit>(.<digit>+){1,2}(-suffix)?. Skip a leading "aura" label.
    for tok in line.split_whitespace() {
        let core = tok.trim_start_matches('v');
        let head: &str = core.split('-').next().unwrap_or(core);
        let parts: Vec<&str> = head.split('.').collect();
        if (2..=4).contains(&parts.len()) && parts.iter().all(|p| !p.is_empty() && p.chars().all(|c| c.is_ascii_digit())) {
            return Some(core.to_string());
        }
    }
    None
}

/// Parse a semver-ish string down to its `(major, minor)` tuple,
/// tolerating a `-rc1`/`-beta` suffix and a missing patch. `None` when
/// the head doesn't start with two parseable dotted integers.
fn major_minor(v: &str) -> Option<(u32, u32)> {
    let head = v.split('-').next().unwrap_or(v);
    let mut it = head.split('.');
    let maj: u32 = it.next()?.parse().ok()?;
    let min: u32 = it.next()?.parse().ok()?;
    Some((maj, min))
}

/// Compare two semver-ish strings on `major.minor`. Patch differences
/// are tolerated (a 0.15.1 shell happily talks to a 0.15.4 CLI). We
/// don't pull in a semver crate for this — the comparison is trivial
/// and the dependency would dwarf the logic.
fn major_minor_matches(a: &str, b: &str) -> bool {
    match (major_minor(a), major_minor(b)) {
        (Some(x), Some(y)) => x == y,
        _ => false,
    }
}

/// True when `installed`'s `(major, minor)` is the SAME or NEWER than
/// `expected`'s. This is the gate for "is the on-PATH CLI fine?" — and
/// crucially it must NOT flag a newer CLI as stale. A user who installed
/// a newer release CLI globally (0.17.x) while running an older desktop
/// build (which bundles 0.16.x) would otherwise see the lockstep
/// installer try to *downgrade* onto the bundled binary — an endless
/// "Updating Aura CLI…" pill that can never reach parity because the
/// next check still reads the (newer) installed version as a mismatch.
fn major_minor_at_least(installed: &str, expected: &str) -> bool {
    match (major_minor(installed), major_minor(expected)) {
        (Some(i), Some(e)) => i >= e,
        _ => false,
    }
}

/// Tauri command — invoked on shell startup and from the footer chip's
/// refresh button. Returns synchronously enough to keep the UI snappy
/// (two short subprocess spawns; ~10ms on a warm cache).
#[tauri::command]
pub async fn aura_cli_version_check() -> Result<AuraCliVersionCheck, String> {
    let expected = EXPECTED_AURA_CLI_VERSION.to_string();
    let Some(path) = resolve_aura_path() else {
        return Ok(AuraCliVersionCheck {
            installed: None,
            expected,
            path: None,
            status: "missing".into(),
            raw: None,
        });
    };

    let out = match Command::new(&path).arg("--version").output() {
        Ok(o) => o,
        Err(e) => {
            // Binary was on PATH but we couldn't exec it. Surface as
            // "unknown" so the chip nudges the user without screaming.
            return Ok(AuraCliVersionCheck {
                installed: None,
                expected,
                path: Some(path),
                status: "unknown".into(),
                raw: Some(format!("spawn failed: {e}")),
            });
        }
    };

    // `aura --version` writes to stdout; some older builds wrote to
    // stderr. Prefer stdout, fall back to stderr.
    let stdout = String::from_utf8_lossy(&out.stdout);
    let stderr = String::from_utf8_lossy(&out.stderr);
    let raw_line = stdout
        .lines()
        .chain(stderr.lines())
        .find(|l| !l.trim().is_empty())
        .map(|l| l.trim().to_string());

    let installed = raw_line.as_deref().and_then(parse_version_line);
    let status = match &installed {
        // Same-or-newer than what this build bundles → green. A newer
        // installed CLI is fine (and must never be "updated" by
        // downgrading onto the older bundled binary — that pins the
        // install pill forever). Only a strictly OLDER CLI is "outdated".
        Some(v) if major_minor_at_least(v, EXPECTED_AURA_CLI_VERSION) => "ok",
        Some(_) => "outdated",
        None => "unknown",
    };

    Ok(AuraCliVersionCheck {
        installed,
        expected,
        path: Some(path),
        status: status.to_string(),
        raw: raw_line,
    })
}

/// Platform binary name for the CLI.
fn bin_name() -> &'static str {
    if cfg!(windows) {
        "aura.exe"
    } else {
        "aura"
    }
}

/// Resolve the `aura` CLI binary this desktop build can install.
///
/// Release builds ship the matching, Developer-ID-signed + notarized CLI
/// next to the shell executable inside `Aura.app/Contents/MacOS/aura`
/// (placed there by `app:bundle-cli` and signed by `sign-notarize.sh`,
/// exactly like the `aura-shell-mcp` sidecar). We resolve it by the
/// running exe's own directory — never PATH — so the bundled CLI version
/// always matches the shell that ships it.
///
/// Debug builds (`tauri dev`) have no bundled CLI next to the shell, but a
/// developer who ran `app:build-cli` has a freshly built RELEASE binary in
/// the workspace at `aura-cli/target/<triple>/release/aura`. We resolve that
/// so the "Update" button — and the launch auto-install — work in dev too,
/// instead of dead-ending on a "dev build?" error. We deliberately ignore
/// the sibling `target/debug/aura`: it's a slow, unsigned dev binary we must
/// never install over a user's real CLI.
fn bundled_cli_path() -> Option<PathBuf> {
    if cfg!(debug_assertions) {
        return dev_workspace_cli_path();
    }
    let mut p = std::env::current_exe().ok()?;
    p.pop();
    p.push(bin_name());
    if p.exists() {
        Some(p)
    } else {
        None
    }
}

/// The Rust host triple this shell was built for — used in debug to find the
/// matching `app:build-cli` output. Empty on platforms we don't ship the
/// desktop app for (the no-triple `target/release` fallback covers those).
#[cfg(debug_assertions)]
fn host_triple() -> &'static str {
    #[cfg(all(target_os = "macos", target_arch = "aarch64"))]
    {
        "aarch64-apple-darwin"
    }
    #[cfg(all(target_os = "macos", target_arch = "x86_64"))]
    {
        "x86_64-apple-darwin"
    }
    #[cfg(not(target_os = "macos"))]
    {
        ""
    }
}

/// In a dev build, find a release-built CLI in the workspace to install.
///
/// Walks up from the running shell binary to the workspace root (the first
/// ancestor holding `aura-cli/Cargo.toml` — the CLI is a workspace-excluded
/// package with its own `target/`), then prefers the host-triple release
/// output that `app:build-cli` produces, falling back to the default
/// `target/release`. Returns `None` if the developer hasn't built the CLI
/// yet (the caller then degrades to a friendly "build it first" message, not
/// a hard failure).
#[cfg(debug_assertions)]
fn dev_workspace_cli_path() -> Option<PathBuf> {
    let exe = std::env::current_exe().ok()?;
    let mut dir = exe.parent();
    while let Some(d) = dir {
        if d.join("aura-cli").join("Cargo.toml").is_file() {
            let cli = d.join("aura-cli");
            let triple = host_triple();
            if !triple.is_empty() {
                let cand = cli.join("target").join(triple).join("release").join(bin_name());
                if cand.exists() {
                    return Some(cand);
                }
            }
            let cand = cli.join("target").join("release").join(bin_name());
            return cand.exists().then_some(cand);
        }
        dir = d.parent();
    }
    None
}

/// Release-build stub: there is no dev workspace CLI to resolve.
#[cfg(not(debug_assertions))]
fn dev_workspace_cli_path() -> Option<PathBuf> {
    None
}

/// Where to install the CLI so it lands on the user's PATH.
///
/// Preference order:
///   1. The exact path `which aura` already resolves — overwrite in place so
///      the binary the user's shell finds is the one we update (no second
///      stale copy shadowing it).
///   2. `~/.cargo/bin/aura` when that dir exists (cargo's bin is on PATH for
///      anyone who installed via the documented `cargo install` route).
///   3. `~/.local/bin/aura` as a last resort (created on install).
fn install_target_path() -> Result<PathBuf, String> {
    if let Some(p) = resolve_aura_path() {
        return Ok(PathBuf::from(p));
    }
    let home = dirs::home_dir().ok_or_else(|| "no home directory".to_string())?;
    let cargo_bin = home.join(".cargo").join("bin");
    if cargo_bin.is_dir() {
        return Ok(cargo_bin.join(bin_name()));
    }
    Ok(home.join(".local").join("bin").join(bin_name()))
}

/// Stage a verified, executable copy of `src` into `stage_dir`.
///
/// Writes the bytes to a uniquely-named tempfile, marks it 0755, and on
/// macOS checks the embedded signature — the bundled binary is already
/// Developer-ID-signed + notarized and a byte copy preserves that, so we
/// only fall back to an ad-hoc signature if the staged copy fails
/// `codesign --verify`, guaranteeing we never install an unverifiable
/// Mach-O. Returns the staged temp path (deleted on drop).
fn stage_verified_copy(src: &Path, stage_dir: &Path) -> Result<tempfile::TempPath, String> {
    let bytes = std::fs::read(src)
        .map_err(|e| format!("read bundled CLI {}: {e}", src.display()))?;
    let mut tmp = NamedTempFile::new_in(stage_dir)
        .map_err(|e| format!("tempfile in {}: {e}", stage_dir.display()))?;
    tmp.as_file_mut()
        .write_all(&bytes)
        .map_err(|e| format!("write staged CLI: {e}"))?;
    tmp.as_file_mut()
        .flush()
        .map_err(|e| format!("flush staged CLI: {e}"))?;
    let tmp_path = tmp.into_temp_path();

    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let mut perms = std::fs::metadata(&tmp_path)
            .map_err(|e| format!("stat staged CLI: {e}"))?
            .permissions();
        perms.set_mode(0o755);
        std::fs::set_permissions(&tmp_path, perms)
            .map_err(|e| format!("chmod staged CLI: {e}"))?;
    }

    #[cfg(target_os = "macos")]
    {
        let verified = Command::new("codesign")
            .args(["--verify", "--strict"])
            .arg(&*tmp_path)
            .output()
            .map(|o| o.status.success())
            .unwrap_or(false);
        if !verified {
            let out = Command::new("codesign")
                .args(["--force", "--sign", "-"])
                .arg(&*tmp_path)
                .output()
                .map_err(|e| format!("ad-hoc codesign staged CLI: {e}"))?;
            if !out.status.success() {
                return Err(format!(
                    "codesign staged CLI failed: {}",
                    String::from_utf8_lossy(&out.stderr).trim()
                ));
            }
        }
    }

    Ok(tmp_path)
}

/// Install `src` to `target` atomically.
///
/// Stage into a uniquely-named tempfile in the *same directory* as the
/// target, mark it executable, then `rename(2)` it into place. The atomic
/// rename — never an in-place `cp` — is what keeps a concurrently-running
/// `aura` from being SIGKILLed mid-exec (replacing the running inode's bytes
/// changes its cdhash; swapping the dir entry to a fresh inode does not).
fn install_binary_atomically(src: &Path, target: &Path) -> Result<(), String> {
    let parent = target
        .parent()
        .ok_or_else(|| format!("install target {} has no parent", target.display()))?;
    std::fs::create_dir_all(parent)
        .map_err(|e| format!("mkdir {}: {e}", parent.display()))?;

    let tmp_path = stage_verified_copy(src, parent)?;
    tmp_path
        .persist(target)
        .map_err(|e| format!("install {}: {}", target.display(), e.error))?;
    Ok(())
}

/// Can the current user create files in `dir`? Probed by actually creating
/// a tempfile — permission bits lie (ACLs, SIP, read-only volumes), the
/// syscall doesn't. The probe file is removed on drop.
fn dir_writable(dir: &Path) -> bool {
    NamedTempFile::new_in(dir).is_ok()
}

/// Quote `s` for a POSIX shell (single-quote wrapping).
#[cfg(target_os = "macos")]
fn sh_quote(s: &str) -> String {
    format!("'{}'", s.replace('\'', r"'\''"))
}

/// Escape `s` for embedding inside an AppleScript string literal.
#[cfg(target_os = "macos")]
fn applescript_escape(s: &str) -> String {
    s.replace('\\', "\\\\").replace('"', "\\\"")
}

/// Install into a root-owned directory (e.g. `/usr/local/bin`) by asking
/// macOS for an admin authorization — the same one-password prompt VS Code
/// uses to install its `code` shim. The binary is staged + verified in a
/// user-writable temp dir first, then the privileged step is only
/// `mkdir/cp/chmod/mv` — stage-in-target-dir + `mv` keeps the swap an
/// atomic same-filesystem rename, so a running `aura` is never SIGKILLed.
#[cfg(target_os = "macos")]
fn install_binary_escalated(src: &Path, target: &Path) -> Result<(), String> {
    let parent = target
        .parent()
        .ok_or_else(|| format!("install target {} has no parent", target.display()))?;
    let staged = stage_verified_copy(src, &std::env::temp_dir())?;

    let stage_in_dir = format!("{}.aura-stage", target.display());
    let cmd = format!(
        "/bin/mkdir -p {parent} && /bin/cp -f {staged} {stage} && /bin/chmod 755 {stage} && /bin/mv -f {stage} {target}",
        parent = sh_quote(&parent.display().to_string()),
        staged = sh_quote(&staged.display().to_string()),
        stage = sh_quote(&stage_in_dir),
        target = sh_quote(&target.display().to_string()),
    );
    let script = format!(
        "do shell script \"{}\" with prompt \"Aura needs an administrator password to update the aura CLI in {}.\" with administrator privileges",
        applescript_escape(&cmd),
        applescript_escape(&parent.display().to_string()),
    );

    let out = Command::new("osascript")
        .arg("-e")
        .arg(&script)
        .output()
        .map_err(|e| format!("osascript: {e}"))?;
    if !out.status.success() {
        let err = String::from_utf8_lossy(&out.stderr);
        if err.contains("-128") || err.to_lowercase().contains("canceled") {
            return Err("Update canceled — administrator authorization is required to replace the CLI in a system directory.".into());
        }
        return Err(format!(
            "privileged install failed: {}",
            err.trim().lines().last().unwrap_or("unknown error")
        ));
    }
    Ok(())
}

/// Non-macOS fallback: we have no privilege-escalation UI, so a root-owned
/// install dir is a hard error with a copyable hint.
#[cfg(not(target_os = "macos"))]
fn install_binary_escalated(_src: &Path, target: &Path) -> Result<(), String> {
    Err(format!(
        "{} is not writable — re-run your package manager or `sudo install` to update it",
        target.display()
    ))
}

/// Tauri command — install the CLI this build carries in place, so the
/// on-PATH `aura` matches the app after an update. Called automatically on
/// launch when the version chip reads "outdated"/"missing", and from the
/// chip's "Update now" button. In a release build that's the signed CLI
/// bundled inside the .app; in a dev build it's the developer's
/// `app:build-cli` output (see `bundled_cli_path`).
///
/// `interactive` distinguishes the two callers when the install dir is
/// root-owned (a Homebrew-era `/usr/local/bin/aura` on Apple Silicon is the
/// classic case — tempfile staging there fails with EACCES):
///
///   * `false`/absent — silent launch-time auto-update. Never pops a
///     password dialog at the user unprompted; returns a marker error
///     (`"needs authorization: …"`) the toast turns into an Authorize button.
///   * `true` — the user clicked Update/Authorize, so we may show the macOS
///     admin prompt and install via an escalated atomic rename.
///
/// Returns a fresh `AuraCliVersionCheck` so the caller can update the chip
/// without a second round-trip. Errors (no bundled binary in a dev build,
/// permission denied, codesign failure) propagate as `Err` for the frontend
/// to surface or silently ignore.
#[tauri::command]
pub async fn aura_cli_install_bundled(
    interactive: Option<bool>,
) -> Result<AuraCliVersionCheck, String> {
    let interactive = interactive.unwrap_or(false);
    // The "no bundled" / "dev build" wording is a sentinel: the launch-time
    // toast (CliUpdateToast.isNoBundleError) treats it as a silent no-op so a
    // dev build never pops a scary failure. The manual chip still shows the
    // actionable hint.
    let src = bundled_cli_path().ok_or_else(|| {
        if cfg!(debug_assertions) {
            "no bundled aura CLI to install (dev build) — run `bun run app:build-cli` first"
                .to_string()
        } else {
            "no bundled aura CLI found alongside the app".to_string()
        }
    })?;
    let target = install_target_path()?;
    let parent = target
        .parent()
        .ok_or_else(|| format!("install target {} has no parent", target.display()))?;

    // Best-effort create for the ~/.local/bin first-install case; a failure
    // here just means the writability probe below says "no".
    let _ = std::fs::create_dir_all(parent);

    if dir_writable(parent) {
        install_binary_atomically(&src, &target)?;
    } else if interactive {
        install_binary_escalated(&src, &target)?;
    } else {
        return Err(format!(
            "needs authorization: {} is not writable by your user",
            parent.display()
        ));
    }
    aura_cli_version_check().await
}

// ─────────────────────────────────────────────────────────────────────────
// Repo-health doctor — structured JSON for the `/doctor` slash card.
// ─────────────────────────────────────────────────────────────────────────
//
// This is the REPO-HEALTH doctor (`aura doctor --json`), NOT the team-chat
// connectivity doctor. The engine (aura-cli `doctor::collect_report`) owns
// the whole computation — stuck sessions, orphaned/oversized snapshots, git
// hooks, shadow branch, signing key, cloud rotation-chain drift, skill
// ledger, replay worktrees, plugins — and emits a well-shaped read-only JSON
// report (no repairs are performed in `--json` mode). This bridge just runs
// it in the repo root and ferries the parsed report back, so the doctor
// schema lives in exactly one place (the engine). The frontend's
// `DoctorReport` type in `lib/api.ts` mirrors the same shape.
//
// Uses tokio's async Command: on a large repo the shadow-checkpoint walk can
// take a few seconds, so we must not block the IPC runtime thread.
#[tauri::command]
pub async fn aura_doctor_json(repo_root: String) -> Result<serde_json::Value, String> {
    let cwd = PathBuf::from(&repo_root);
    if !cwd.is_dir() {
        return Err(format!("repo root does not exist: {}", repo_root));
    }

    let out = tokio::process::Command::new("aura")
        .args(["doctor", "--json"])
        .current_dir(&cwd)
        .output()
        .await
        .map_err(|e| format!("failed to spawn aura doctor: {}", e))?;

    if !out.status.success() {
        let stderr = String::from_utf8_lossy(&out.stderr);
        return Err(format!(
            "aura doctor exited with {}: {}",
            out.status.code().unwrap_or(-1),
            stderr.trim()
        ));
    }

    let stdout = String::from_utf8_lossy(&out.stdout);
    serde_json::from_str(&stdout)
        .map_err(|e| format!("failed to parse doctor JSON: {}", e))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_canonical_aura_version_line() {
        assert_eq!(parse_version_line("aura 0.15.1"), Some("0.15.1".into()));
    }

    #[test]
    fn parses_v_prefix() {
        assert_eq!(parse_version_line("aura v0.15.1"), Some("0.15.1".into()));
    }

    #[test]
    fn parses_prerelease_suffix() {
        assert_eq!(
            parse_version_line("aura 0.16.0-rc1"),
            Some("0.16.0-rc1".into())
        );
    }

    #[test]
    fn rejects_garbage() {
        assert_eq!(parse_version_line("hello world"), None);
    }

    #[test]
    fn major_minor_ignores_patch() {
        assert!(major_minor_matches("0.15.1", "0.15.4"));
        assert!(major_minor_matches("0.15.0-rc1", "0.15.3"));
    }

    #[test]
    fn major_minor_catches_drift() {
        assert!(!major_minor_matches("0.15.1", "0.16.0"));
        assert!(!major_minor_matches("0.14.9", "0.15.0"));
        assert!(!major_minor_matches("1.0.0", "0.15.0"));
    }

    #[test]
    fn at_least_treats_same_or_newer_as_ok() {
        // Equal minor (patch ignored) → ok.
        assert!(major_minor_at_least("0.16.3", "0.16.0"));
        assert!(major_minor_at_least("0.16.0-rc1", "0.16.4"));
        // Newer installed than the bundled expected → ok (never downgrade).
        assert!(major_minor_at_least("0.17.0", "0.16.3"));
        assert!(major_minor_at_least("1.0.0", "0.16.3"));
    }

    #[test]
    fn at_least_flags_only_strictly_older() {
        // The regression we're guarding: an OLDER installed CLI is the
        // only thing that should read as "outdated".
        assert!(!major_minor_at_least("0.15.9", "0.16.0"));
        assert!(!major_minor_at_least("0.14.0", "0.16.3"));
    }
}
