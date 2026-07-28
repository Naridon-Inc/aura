//! cmd_remote_connect — the desktop side of "connect a remote machine" as a
//! cloud runner.
//!
//! The Connect-a-machine wizard does almost everything in the embedded SSH
//! terminal the frontend drives — install `aura`, run `claude setup-token`
//! (whose OAuth bounces through the user's own browser), start the service.
//! Exactly ONE step needs the laptop's cloud credentials and so can't happen
//! inside the box's shell: minting a runner-registry token on the signed-in
//! account so a fresh box can join the user's cloud board. That single
//! privileged step lives here.
//!
//! It mirrors [`crate::cmd_loop::loop_cloud_send`]: we shell the bundled `aura`
//! CLI rather than re-implement the cloud HTTP client, so the token is minted
//! through the exact same `recall_cloud_creds` path the CLI itself uses — one
//! source of truth for "who am I on the cloud".

//! As of the provisioning-seam refactor, the token-minting logic itself lives
//! in [`crate::provisioner::ByoProvider`] (behind the shared [`Provisioner`]
//! trait, alongside the not-yet-wired managed path). This command is now the
//! thin Tauri wrapper that builds a BYO [`ProvisionSpec`] and delegates, so the
//! wizard's call site is unchanged while both provisioning kinds share one
//! interface.
//!
//! [`Provisioner`]: crate::provisioner::Provisioner
//! [`ProvisionSpec`]: crate::provisioner::ProvisionSpec

use serde::Serialize;

use crate::provisioner::{provisioner_for, ProvisionKind, ProvisionSpec};

/// A freshly minted runner-registry credential, ready to export on the box as
/// `AURA_RUNNER_TOKEN` so `aura runner serve` shows up on the user's board.
///
/// The wire shape the wizard frontend consumes — kept stable across the
/// provisioning-seam refactor (it is a flattened view of the BYO
/// [`ProvisionedTarget`](crate::provisioner::ProvisionedTarget)).
#[derive(Debug, Clone, Serialize)]
pub struct RunnerProvision {
    /// The one-time runner token — `aura runner register` shows it once.
    pub token: String,
    /// The registry name the runner will report under.
    pub name: String,
}

/// Mint a runner token on the signed-in cloud account for a brand-new box.
///
/// `name` is the friendly label the runner reports (e.g. the box's hostname).
/// `repo` optionally scopes the runner to one repo (`owner/name`); omitted, the
/// runner is org-wide and can drain every project (the `--all-projects` model).
///
/// Delegates to the BYO [`Provisioner`](crate::provisioner::Provisioner), which
/// requires the user to be signed in to cloud — the underlying
/// `aura runner register` reads `recall_cloud_creds`, the same store the
/// desktop's `cloud_auth_*` commands use, and fails clearly if it's absent.
#[tauri::command]
pub async fn runner_provision(
    name: String,
    repo: Option<String>,
) -> Result<RunnerProvision, String> {
    let spec = ProvisionSpec {
        kind: ProvisionKind::Byo,
        name,
        repo,
        class: None,
    };

    let target = provisioner_for(ProvisionKind::Byo)
        .provision(spec)
        .await
        .map_err(|e| e.to_string())?;

    // BYO always mints a token; treat its absence as a hard error rather than
    // handing the wizard a tokenless box.
    let token = target
        .runner_token
        .ok_or_else(|| "Registered, but no token was returned — try again.".to_string())?;

    Ok(RunnerProvision {
        token,
        name: target.name,
    })
}
