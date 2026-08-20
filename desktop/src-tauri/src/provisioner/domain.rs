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
    /// Aura-provisioned managed machine — Aura creates the box in its own
    /// cloud account, holds its key, and bills for the time. Paid and metered.
    /// See [`super::managed`].
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

impl ProvisionSpec {
    /// The name this machine will answer to on the board.
    ///
    /// Trimmed, because the field is typed into and a trailing space would
    /// register a machine whose name never matches the one the board polls for.
    /// Empty is a refusal rather than a generated name: an unnamed box is
    /// indistinguishable from every other unnamed box in the picker.
    ///
    /// On the spec rather than in a backend because both backends need exactly
    /// this rule, and a second copy of it is how one arm ends up trimming and
    /// the other not — after which the same typed name produces two different
    /// machines depending on which kind you asked for.
    pub fn machine_name(&self) -> Result<String> {
        let name = self.name.trim();
        if name.is_empty() {
            return Err(ProvisionError::MissingName);
        }
        Ok(name.to_string())
    }
}

/// Where a provisioned machine actually is, in the four fields it takes to
/// reach one.
///
/// Deliberately the SAME four the runner registry carries (`host`, `ssh_user`,
/// `key_ref`, `repo_path` — migration 050) and the same four the machine book
/// holds for a box somebody brought. That is the whole claim of the managed
/// arm: Aura creates the machine instead of the user, and everything above the
/// `Place` seam is handed the same record and cannot tell which happened.
///
/// A backend that could only produce three of them would look fine here and
/// fail at the surface — a place with no `repo_path` opens its shells in
/// `$HOME` rather than in the project, which reads as "the box is broken"
/// rather than as "the provisioner didn't say".
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct TargetAddress {
    /// What you would dial — a hostname or an address.
    pub host: String,
    /// The login on that box.
    pub ssh_user: String,
    /// A REFERENCE to the key, never the key. A path on the operator's disk, a
    /// keychain item, or an Aura-held key id (`managed:…`) for a machine whose
    /// key the member is never shown. One field serves both arms, which is why
    /// neither arm needs a field the other lacks.
    pub key_ref: String,
    /// Where the project sits ON THE BOX, so a shell lands in the repo. `None`
    /// for a machine provisioned without a repo scope — it has no checkout to
    /// land in, and inventing a path would send every later `cd` somewhere that
    /// does not exist.
    #[serde(default)]
    pub repo_path: Option<String>,
}

/// Opaque, stable identifier for a provisioned target. For BYO it is derived
/// from the runner's registry name; for managed it is the substrate's own
/// instance id.
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
    /// How to reach the machine. `Some` when the backend CREATED it and is
    /// therefore the only thing that knows where it landed; `None` for BYO,
    /// where the address is not ours to report — the user typed it into the
    /// wizard before this call, and echoing our own guess of it back would give
    /// two places an opinion about one box's address.
    #[serde(default)]
    pub address: Option<TargetAddress>,
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
    /// Stopped on purpose, and able to come back.
    ///
    /// Kept apart from [`TargetStatus::Offline`] because the two look identical
    /// from the board — nothing is reporting either way — and mean opposite
    /// things to the person looking at them. Offline is a machine that should be
    /// answering and isn't, which is somebody's afternoon. Asleep is a machine
    /// Aura stopped because nobody was using it, which is the feature working:
    /// the disk is still there, the projects on it are still there, and the next
    /// thing that needs it starts it again. Collapsing them would make the
    /// cheapest state Aura offers read as the most alarming one.
    Asleep,
    /// Registered but not seen recently.
    Offline,
    /// Teardown in progress.
    Terminating,
    /// Torn down / no longer registered.
    Terminated,
    /// State can't be determined from where we're asking.
    Unknown,
}

/// The named steps a backend goes through, so a failure can say which one it
/// was.
///
/// Making a machine is five or six things in a row against somebody else's API,
/// and each fails for its own reason with its own fix. "Something went wrong"
/// collapses all of them into one sentence nobody can act on: a key pair that
/// isn't there, a region out of capacity and a box that booted but never
/// answered are three different afternoons. The step is carried as a value
/// rather than baked into a string so a surface can branch on it — offer
/// "try another region" for [`ProvisionStep::Launch`] and nothing of the sort
/// for [`ProvisionStep::Key`].
///
/// The wording is what the user reads. It names the thing that failed in the
/// terms of what they asked for, never in the substrate's own vocabulary.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ProvisionStep {
    /// Turning the request and the operator's setup into something to ask for.
    /// The only step that fails before anything outside this process is
    /// touched, and the only one whose fix is always a file on this disk.
    Plan,
    /// Making sure the machine will be reachable and can reach out.
    Network,
    /// Confirming the credential Aura will connect with is in place.
    Key,
    /// Asking the substrate for the machine itself.
    Launch,
    /// Waiting for it to come up far enough to have an address.
    Reach,
    /// Reading back the state of one we already made.
    Look,
    /// Stopping one that nobody is using, so it stops costing.
    Sleep,
    /// Starting a stopped one back up because somebody wants it again.
    Wake,
    /// Ending it.
    Teardown,
}

impl std::fmt::Display for ProvisionStep {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(match self {
            ProvisionStep::Plan => "work out what machine to make",
            ProvisionStep::Network => "set up the machine's network",
            ProvisionStep::Key => "check the key Aura connects with",
            ProvisionStep::Launch => "start the machine",
            ProvisionStep::Reach => "reach the machine after starting it",
            ProvisionStep::Look => "check on the machine",
            ProvisionStep::Sleep => "put the machine to sleep",
            ProvisionStep::Wake => "wake the machine up",
            ProvisionStep::Teardown => "shut the machine down",
        })
    }
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

    /// No cloud account is configured for Aura to make machines in, so the
    /// managed backend has nothing to ask. An honest "not available here"
    /// runtime state — never a panic or a `todo!()`.
    ///
    /// The driver behind managed mode is real; what is absent is the account it
    /// would spend. That distinction is the difference between a build with a
    /// hole in it and an install nobody has set up yet, and only the second one
    /// is something the user can fix.
    #[error(
        "Aura isn't set up to make machines for you yet — connect your own machine instead."
    )]
    ManagedNotConfigured,

    /// A step of provisioning failed, and says which one.
    ///
    /// `detail` is the substrate's own words about that step, cleaned up — it
    /// is the half that knows whether the region was full or the credential was
    /// refused, and paraphrasing it here would throw away the only sentence
    /// with a fix in it.
    #[error("Couldn't {step} — {detail}")]
    Step {
        step: ProvisionStep,
        detail: String,
    },

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
