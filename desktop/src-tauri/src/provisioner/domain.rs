//! Shared domain model for the provisioning seam.
//!
//! These types are the vocabulary both backends speak — the BYO
//! "connect-a-machine" flow that ships today and the managed Firecracker/E2B
//! flow described in the "Cloud Runners & Managed VMs" plan. Nothing here
//! knows *which* backend fulfils a request; that choice lives in
//! [`super::provisioner_for`]. Keeping the model in its own file (rather than
//! inside a provider) means a new backend adds a struct, never a new type.
//!
//! Error strings are user-facing and follow the plain-language UX standard —
//! no infra jargon ("microVM", "egress", "jailer") leaks to the surface.

use serde::{Deserialize, Serialize};

/// Which provisioning backend fulfils a request. This is the discriminator the
/// factory switches on, and the seam that lets one call site serve both "you
/// bring the box" and "we host it".
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum ProvisionKind {
    /// Bring-your-own: the user supplies a Linux box; Aura mints a runner
    /// token and orchestrates. Free — the compute is the user's own hardware.
    Byo,
    /// Aura-provisioned managed machine (E2B/Firecracker microVM). Paid and
    /// metered. Not yet wired — see [`super::managed`].
    Managed,
}

/// Named machine size for MANAGED provisioning. BYO ignores it — the box is
/// whatever hardware the user already brought. Backed later by request/limit
/// tuples (`cpu = (floor, burst)`), with the larger classes gated to higher
/// paid tiers (see plan §6, requirement 2).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum MachineClass {
    Small,
    Medium,
    Large,
    XLarge,
}

/// A request to provision — or, for BYO, to adopt — a target that will run the
/// `aura runner` agent and drain the user's cloud crew board.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ProvisionSpec {
    /// Which backend should fulfil this request.
    pub kind: ProvisionKind,
    /// Friendly label the runner reports under (e.g. the box's hostname).
    pub name: String,
    /// Optional repo scope `owner/name`. `None` => an org-wide runner that can
    /// drain every project the user owns (the `--all-projects` model).
    #[serde(default)]
    pub repo: Option<String>,
    /// Managed-only sizing hint; ignored by BYO. `None` => the backend's
    /// default class.
    #[serde(default)]
    pub class: Option<MachineClass>,
}

/// Opaque, stable identifier for a provisioned target. For BYO it is derived
/// from the runner's registry name; for managed it will be the microVM id.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct TargetId(pub String);

impl TargetId {
    pub fn as_str(&self) -> &str {
        &self.0
    }
}

impl std::fmt::Display for TargetId {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(&self.0)
    }
}

/// A target that has been provisioned (or adopted) and is ready to be handed
/// the setup steps that bring it online on the board.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ProvisionedTarget {
    /// Stable handle used for later [`super::Provisioner::status`] /
    /// [`super::Provisioner::teardown`] calls.
    pub id: TargetId,
    /// Which backend produced this target.
    pub kind: ProvisionKind,
    /// The friendly label the runner reports under.
    pub name: String,
    /// One-time runner-registry token to export on the box as
    /// `AURA_RUNNER_TOKEN` so it joins the user's board. Present when the
    /// backend mints one (BYO always does); `None` when the token is delivered
    /// out-of-band (e.g. a managed box that self-registers at boot).
    #[serde(default)]
    pub runner_token: Option<String>,
    /// Lifecycle state at hand-off. A freshly provisioned BYO box is
    /// [`TargetStatus::Provisioning`] — the token is minted, but the user must
    /// still run the setup steps on the box before it reports online.
    pub status: TargetStatus,
}

/// Coarse lifecycle state of a provisioned target. Deliberately small — the
/// wizard only ever needs "is it there yet?" not a full state machine.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum TargetStatus {
    /// Created / token minted, not yet reporting to the board.
    Provisioning,
    /// The runner is online and draining work.
    Online,
    /// Registered but not seen recently.
    Offline,
    /// Teardown in progress.
    Terminating,
    /// Torn down / no longer registered.
    Terminated,
    /// State can't be determined from where we're asking.
    Unknown,
}

/// Typed failures across every provisioning backend.
///
/// The `#[error(...)]` strings are what the user sees, so they stay in plain
/// language. [`ProvisionError::ManagedNotConfigured`] and
/// [`ProvisionError::Unsupported`] are *legitimate runtime states*, not stubs:
/// the first means the managed cloud simply isn't wired in this build, the
/// second means an operation is genuinely inapplicable to a target (Aura won't
/// remotely destroy a machine you own).
#[derive(Debug, thiserror::Error)]
pub enum ProvisionError {
    /// The caller gave an empty / whitespace-only name.
    #[error("Give the machine a name first.")]
    MissingName,

    /// The underlying `aura` CLI could not be launched at all.
    #[error("Couldn't run the aura CLI: {0}")]
    CliSpawn(String),

    /// The CLI ran but exited non-zero — carries its cleaned-up message.
    #[error("{0}")]
    CliFailed(String),

    /// Registration succeeded but no runner token was found in the output.
    #[error("Registered, but no token was returned — try again.")]
    TokenNotFound,

    /// The managed cloud backend (E2B/Firecracker) isn't wired in this build.
    /// An honest "not available yet" state — never a panic or a `todo!()`.
    #[error(
        "Managed cloud machines aren't available yet — connect your own machine instead."
    )]
    ManagedNotConfigured,

    /// The operation doesn't apply to this kind of target (e.g. tearing down
    /// hardware the user owns). Carries a specific explanation.
    #[error("{0}")]
    Unsupported(String),

    /// A target's live status can't be read from where we're asking.
    #[error("{0}")]
    StatusUnavailable(String),
}

/// Convenience alias so backends can write `Result<ProvisionedTarget>`.
pub type Result<T> = std::result::Result<T, ProvisionError>;
