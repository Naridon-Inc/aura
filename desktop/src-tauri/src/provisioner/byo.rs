//! Bring-your-own provisioner.
//!
//! The user already owns the Linux box; Aura's only job is the one privileged
//! step that can't happen inside the box's own shell — minting a
//! runner-registry token on the signed-in cloud account so a fresh box can join
//! the user's board. Everything else (install `aura`, `claude setup-token`,
//! start the service) the wizard drives over the embedded SSH terminal.
//!
//! This is the refactored home of the logic that used to live inline in
//! `cmd_remote_connect::runner_provision`. It shells the bundled `aura` CLI
//! rather than re-implementing the cloud HTTP client, so the token is minted
//! through the exact same `recall_cloud_creds` path the CLI itself uses — one
//! source of truth for "who am I on the cloud".

use async_trait::async_trait;

use super::domain::{
    ProvisionError, ProvisionKind, ProvisionSpec, ProvisionedTarget, Result, TargetId,
    TargetStatus,
};
use super::Provisioner;

/// Provisioner for machines the user brings. Stateless — every target it hands
/// back is identified by its registry name, and each call shells the CLI fresh.
#[derive(Debug, Default, Clone)]
pub struct ByoProvider;

impl ByoProvider {
    pub fn new() -> Self {
        Self
    }
}

#[async_trait]
impl Provisioner for ByoProvider {
    fn kind(&self) -> ProvisionKind {
        ProvisionKind::Byo
    }

    /// Mint a runner token on the signed-in cloud account for a brand-new box.
    ///
    /// Requires the user to be signed in to cloud — the underlying
    /// `aura runner register` reads `recall_cloud_creds`, the same store the
    /// desktop's `cloud_auth_*` commands use, and fails clearly if it's absent.
    async fn provision(&self, spec: ProvisionSpec) -> Result<ProvisionedTarget> {
        let name = spec.name.trim().to_string();
        if name.is_empty() {
            return Err(ProvisionError::MissingName);
        }

        let bin = crate::agent_event_listener::resolve_aura_bin();
        let mut cmd = tokio::process::Command::new(&bin);
        cmd.arg("runner").arg("register").arg("--name").arg(&name);
        if let Some(r) = spec
            .repo
            .as_deref()
            .map(str::trim)
            .filter(|s| !s.is_empty())
        {
            cmd.arg("--repo").arg(r);
        }
        // Force plain output so token parsing is ANSI-free regardless of the
        // child's colour heuristics (belt-and-braces with `colored`'s own
        // non-TTY auto-disable).
        cmd.env("NO_COLOR", "1");

        let out = cmd
            .output()
            .await
            .map_err(|e| ProvisionError::CliSpawn(format!("run aura runner register: {e}")))?;

        if !out.status.success() {
            let err = String::from_utf8_lossy(&out.stderr);
            let msg = err.trim();
            return Err(ProvisionError::CliFailed(if msg.is_empty() {
                "Couldn't register the machine — are you signed in to cloud?".to_string()
            } else {
                format!("Couldn't register the machine: {msg}")
            }));
        }

        let stdout = String::from_utf8_lossy(&out.stdout);
        let token = parse_runner_token(&stdout).ok_or(ProvisionError::TokenNotFound)?;

        Ok(ProvisionedTarget {
            id: TargetId(name.clone()),
            kind: ProvisionKind::Byo,
            name,
            runner_token: Some(token),
            // The token is minted, but the user still has to run the setup steps
            // on the box before it reports online — so it's provisioning, not
            // online. Honest hand-off state.
            status: TargetStatus::Provisioning,
        })
    }

    /// Report the box's runner state via `aura runner status`.
    ///
    /// That CLI reports the box's OWN registry record and reads
    /// `AURA_RUNNER_TOKEN` from the environment — that is how the command is
    /// defined. We surface exactly that here, mapping its `●/○` line to a
    /// [`TargetStatus`]. From a desktop that doesn't carry the runner token the
    /// CLI says so and we return a typed [`ProvisionError::StatusUnavailable`];
    /// live board liveness for the wizard's "wait until online" step is polled
    /// by the frontend against the cloud board, not through this call. `id` is
    /// not a selector because the CLI scopes to the ambient token, not an
    /// arbitrary registry id.
    async fn status(&self, _id: &TargetId) -> Result<TargetStatus> {
        let bin = crate::agent_event_listener::resolve_aura_bin();
        let out = tokio::process::Command::new(&bin)
            .arg("runner")
            .arg("status")
            .env("NO_COLOR", "1")
            .output()
            .await
            .map_err(|e| ProvisionError::CliSpawn(format!("run aura runner status: {e}")))?;

        if !out.status.success() {
            let err = String::from_utf8_lossy(&out.stderr);
            let msg = err.trim();
            return Err(ProvisionError::StatusUnavailable(if msg.is_empty() {
                "Couldn't read the machine's status — is it registered?".to_string()
            } else {
                msg.to_string()
            }));
        }

        let stdout = String::from_utf8_lossy(&out.stdout);
        Ok(parse_status_line(&stdout))
    }

    /// A BYO box is the user's own hardware, and the runner registry has no
    /// remote-delete verb. Detaching = stopping `aura runner serve` on the box
    /// itself (the wizard does this over its SSH terminal). We refuse to pretend
    /// we can destroy a machine we don't own — a real product boundary, not a
    /// stub, expressed as a typed error.
    async fn teardown(&self, _id: &TargetId) -> Result<()> {
        Err(ProvisionError::Unsupported(
            "This machine is yours — stop the runner from the box itself (or the setup \
             terminal). Aura won't remotely tear down hardware you own."
                .to_string(),
        ))
    }
}

/// Pull the runner token out of `aura runner register`'s human output. The CLI
/// prints it twice — standalone under "shown only once", and in the
/// `export AURA_RUNNER_TOKEN=<tok>` hint. We key off the export line since its
/// shape is unambiguous, falling back to the first non-empty line after the
/// "shown only once" note.
fn parse_runner_token(stdout: &str) -> Option<String> {
    // Preferred: the `export AURA_RUNNER_TOKEN=<tok>` line (indentation varies,
    // so trim first).
    for line in stdout.lines() {
        if let Some(rest) = line.trim().strip_prefix("export AURA_RUNNER_TOKEN=") {
            let tok = rest.trim();
            if !tok.is_empty() {
                return Some(tok.to_string());
            }
        }
    }
    // Fallback: the first non-empty line after the "shown only once" marker.
    let mut lines = stdout.lines();
    while let Some(l) = lines.next() {
        if l.contains("shown only once") {
            for next in lines.by_ref() {
                let tok = next.trim();
                if !tok.is_empty() {
                    return Some(tok.to_string());
                }
            }
        }
    }
    None
}

/// Map `aura runner status`'s one-line output (`● name · running · task`) to a
/// coarse [`TargetStatus`]. The leading glyph is the authoritative online flag;
/// with `NO_COLOR=1` it is a plain `●`/`○`. If the glyph is absent we fall back
/// to the status word between the first pair of `·` separators.
fn parse_status_line(stdout: &str) -> TargetStatus {
    let line = stdout
        .lines()
        .find(|l| !l.trim().is_empty())
        .unwrap_or("")
        .trim();
    if line.contains('●') {
        return TargetStatus::Online;
    }
    if line.contains('○') {
        return TargetStatus::Offline;
    }
    match line.split('·').nth(1).map(str::trim).unwrap_or("") {
        "online" | "running" | "busy" => TargetStatus::Online,
        "offline" => TargetStatus::Offline,
        _ => TargetStatus::Unknown,
    }
}

#[cfg(test)]
mod tests {
    use super::{parse_runner_token, parse_status_line};
    use crate::provisioner::TargetStatus;

    #[test]
    fn parses_export_line() {
        let out = "\u{2713} runner box-1 registered\n\nSave this token — it is shown only once:\n\n  rk_live_ABC123\n\nOn the runner box, export it and start serving:\n  export AURA_RUNNER_TOKEN=rk_live_ABC123\n  aura runner serve\n";
        assert_eq!(parse_runner_token(out).as_deref(), Some("rk_live_ABC123"));
    }

    #[test]
    fn falls_back_to_standalone_line() {
        // No export hint — only the "shown only once" standalone token.
        let out = "Save this token — it is shown only once:\n\n  rk_live_XYZ789\n";
        assert_eq!(parse_runner_token(out).as_deref(), Some("rk_live_XYZ789"));
    }

    #[test]
    fn none_when_absent() {
        assert_eq!(parse_runner_token("nothing here\n"), None);
    }

    #[test]
    fn status_line_online_and_offline() {
        assert_eq!(
            parse_status_line("● home-server · running · idle\n"),
            TargetStatus::Online
        );
        assert_eq!(
            parse_status_line("○ home-server · offline · idle\n"),
            TargetStatus::Offline
        );
    }

    #[test]
    fn status_line_word_fallback_when_no_glyph() {
        assert_eq!(
            parse_status_line("home-server · online · task-42\n"),
            TargetStatus::Online
        );
        assert_eq!(parse_status_line("garbage\n"), TargetStatus::Unknown);
    }
}
