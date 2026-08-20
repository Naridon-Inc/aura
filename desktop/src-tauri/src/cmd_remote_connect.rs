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

use crate::provisioner::{provisioner_for, ProvisionKind, ProvisionSpec, ProvisionedTarget};

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
    let spec = spec_for(name, repo);
    let target = provisioner_for(spec.kind)
        .provision(spec)
        .await
        .map_err(|e| e.to_string())?;

    handed_off(target)
}

/// The provisioning request behind "connect a machine".
///
/// Always [`ProvisionKind::Byo`], because that is what this wizard is: the user
/// already owns the box. It is a field on the spec rather than a constant at the
/// call site so the managed path, when its substrate lands, changes which kind
/// is built here and nothing else — the factory, the trait and this command
/// already take it as data.
fn spec_for(name: String, repo: Option<String>) -> ProvisionSpec {
    ProvisionSpec {
        kind: ProvisionKind::Byo,
        name,
        repo,
        class: None,
    }
}

/// Flatten a provisioned target into the shape the wizard consumes.
///
/// A target with no token is a hard error, not a partial success: the wizard's
/// very next step tells the user to export `AURA_RUNNER_TOKEN`, and an empty
/// one there produces a box that starts, joins nothing, and reports no reason
/// why. Better to fail on the step that actually went wrong.
///
/// The name that comes back is the *target's*, not the string the caller typed.
/// The provisioner trims it, and the frontend then polls the board for a row
/// with that exact name — hand back the untrimmed original and the box comes
/// online while the wizard waits for one that never appears.
fn handed_off(target: ProvisionedTarget) -> Result<RunnerProvision, String> {
    let name = target.name;
    let token = target
        .runner_token
        .filter(|t| !t.trim().is_empty())
        .ok_or_else(|| "Registered, but no token was returned — try again.".to_string())?;

    Ok(RunnerProvision { token, name })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::provisioner::{TargetId, TargetStatus};

    fn target(name: &str, token: Option<&str>) -> ProvisionedTarget {
        ProvisionedTarget {
            id: TargetId(name.into()),
            kind: ProvisionKind::Byo,
            name: name.into(),
            runner_token: token.map(str::to_string),
            address: None,
            status: TargetStatus::Provisioning,
        }
    }

    #[test]
    fn connecting_a_machine_asks_for_the_box_you_already_own() {
        let spec = spec_for("home-server".into(), None);
        assert_eq!(spec.kind, ProvisionKind::Byo);
        assert_eq!(spec.name, "home-server");
        assert!(spec.repo.is_none());
        // Sizing is the managed backend's word, and this wizard has no say in
        // it — the box is whatever hardware the user already has.
        assert!(spec.class.is_none());
    }

    #[test]
    fn a_repo_scope_is_carried_through_untouched() {
        // The wizard offers "this project only" and the CLI is the half that
        // knows what a valid `owner/name` is. Normalising it here would give
        // two places an opinion about repo names.
        let spec = spec_for("ci-box".into(), Some("MHASK/aura-sovereign".into()));
        assert_eq!(spec.repo.as_deref(), Some("MHASK/aura-sovereign"));
    }

    #[test]
    fn a_tokenless_box_is_a_failure_not_a_half_finished_wizard() {
        // The alternative is the wizard's next screen telling the user to
        // export an empty token: the box starts, joins nothing, and says
        // nothing about why.
        for missing in [None, Some(""), Some("   \n")] {
            let refused = handed_off(target("home-server", missing));
            assert_eq!(
                refused.unwrap_err(),
                "Registered, but no token was returned — try again."
            );
        }
    }

    #[test]
    fn the_name_handed_back_is_the_one_the_board_will_show() {
        // Not the string the user typed. The provisioner trims it, the runner
        // registers under the trimmed one, and the wizard polls the board for
        // exactly this — so a mismatch here is a box that comes online behind a
        // spinner that never stops.
        let ok = handed_off(target("home-server", Some("rk_live_ABC"))).unwrap();
        assert_eq!(ok.name, "home-server");
        assert_eq!(ok.token, "rk_live_ABC");
    }

    #[tokio::test]
    async fn an_unnamed_machine_is_refused_in_the_users_words() {
        // The whole command, end to end, on the one input it can refuse without
        // a cloud account: no CLI is launched, and what crosses the wire to the
        // wizard is a sentence rather than a debug-formatted error.
        let told = runner_provision("   ".into(), None).await.unwrap_err();
        assert_eq!(told, "Give the machine a name first.");
    }
}
