//! The swappable half of managed provisioning.
//!
//! Everything in [`super`] is about *what* has to happen to end up with a
//! machine: a network to sit in, a credential to accept a connection on, a box,
//! and an address that answers. This trait is *who does it*. AWS EC2 is the
//! first implementation because the recipe already exists and works
//! (`aura-runner/aws/provision.sh`), and it is behind a trait because the
//! substrate is the part of this most likely to be replaced — Firecracker on
//! our own metal, a per-task microsandbox, somebody's VPC. A swap should cost
//! one file, not a rewrite of the steps above it.
//!
//! The verbs are deliberately the smallest set that covers the recipe. Two of
//! them are `ensure_*` rather than `create_*`: running the same provision twice
//! must not leave two of anything behind, and the substrate is the only thing
//! that can answer "is it already there" without us keeping a ledger that would
//! drift from it.
//!
//! One of them — [`CloudDriver::locate`] — is not part of the recipe at all,
//! because it is about a machine the recipe never made: a box the customer
//! already runs, in a cloud account they have let Aura stop and start machines
//! in ([`crate::provisioner::grant`]). It is here rather than in a driver of its
//! own for the reason the whole seam exists: the calls that stop that box and the
//! calls that stop one Aura made are the same calls, and the only difference is
//! whose credential signs them.
//!
//! ## Nothing here dials the machine
//!
//! A driver's job ends at "the substrate says this box is running and here is
//! its address". It does not open a connection to check, and it must not: the
//! repo holds exactly one line that spawns `ssh` (`cloudbox::dial`, reached only
//! through `Place`), and a provisioner that grew its own would be the second
//! transport that whole arrangement exists to prevent. Whether a box actually
//! answers is `Place`'s question, asked the same way for every mode.

use async_trait::async_trait;

use super::plan::LaunchPlan;

/// The substrate's own handle for a machine — an EC2 instance id, a microVM
/// name, whatever the backend calls it. Opaque above this seam.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct InstanceId(pub String);

impl InstanceId {
    pub fn as_str(&self) -> &str {
        &self.0
    }
}

impl std::fmt::Display for InstanceId {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(&self.0)
    }
}

/// What the substrate says a machine is doing.
///
/// Six states rather than the substrate's own vocabulary, because every backend
/// has a slightly different word for the same few moments and the steps above
/// have to read one of them. [`InstanceState::Gone`] covers both "terminated"
/// and "we have never heard of it": from here they are the same answer — there
/// is no machine — and a caller that tried to distinguish them would be guessing
/// at a race with the substrate's own bookkeeping.
///
/// [`InstanceState::Stopping`] and [`InstanceState::Ending`] used to be one
/// state, and folding them was fine while the only way down was permanent. Sleep
/// made them opposite facts: one machine is going away for good and the other is
/// coming back in ninety seconds with everything on its disk intact. Told apart
/// nowhere else, a member watching a place go to sleep would be watching what the
/// app calls a teardown.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum InstanceState {
    /// Asked for, not yet usable.
    Starting,
    /// Up.
    Running,
    /// On its way down to sleep, and coming back.
    Stopping,
    /// On its way out for good.
    Ending,
    /// Down but still exists, so it can come back.
    Stopped,
    /// Ended, or never existed.
    Gone,
}

/// A machine as the substrate currently sees it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Instance {
    pub id: InstanceId,
    pub state: InstanceState,
    /// What you would dial. `None` while it is still starting — an address is
    /// assigned partway through boot, which is exactly why the step above polls
    /// rather than trusting the launch call's answer.
    pub host: Option<String>,
}

/// The network a machine is launched into, as the substrate names it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct NetworkRef(pub String);

/// The credential a machine will accept a connection on.
///
/// Two strings because they answer to two different systems. `launch_name` is
/// what the substrate is told at launch; `reference` is what gets written down
/// on the runner row, and it is a REFERENCE — `managed:<id>` for a key Aura
/// holds on the member's behalf. Key material appears in neither, here or
/// anywhere else in this module: a private key that reached this process would
/// be a private key in a laptop's memory, a crash report and a log line.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct KeyPair {
    pub launch_name: String,
    pub reference: String,
}

/// Why a driver could not do the thing it was asked.
///
/// Three cases because the step above tells the user something different for
/// each: we could not reach the substrate at all (their network, or ours), the
/// substrate answered and said no (their account, their quota, their
/// permissions), or it answered in a shape we do not understand (ours to fix,
/// and it should not be reported as if the user did something wrong).
#[derive(Debug, thiserror::Error)]
pub enum DriverError {
    /// The request never got an answer.
    #[error("{0}")]
    Unreachable(String),

    /// The substrate answered and refused. `code` is its own machine-readable
    /// name for the refusal, kept because it is the part worth branching on;
    /// `message` is its sentence, kept because it is the part worth reading.
    #[error("{message}")]
    Refused { code: String, message: String },

    /// The substrate answered with something we could not read. Ours.
    #[error("{0}")]
    Unreadable(String),
}

pub type DriverResult<T> = std::result::Result<T, DriverError>;

/// One cloud that Aura can make a machine in.
#[async_trait]
pub trait CloudDriver: Send + Sync {
    /// Which substrate this is, for the record a place carries and for a log
    /// line that says which cloud a failure came from.
    fn substrate(&self) -> &'static str;

    /// Resolve the network the machine will sit in.
    ///
    /// Resolve, deliberately, and not create-if-absent. What may reach port 22
    /// on a machine Aura hosts is a decision with a blast radius, and a
    /// provisioner that quietly opened a firewall because one was missing would
    /// be making that decision at whatever hour the first member clicked
    /// "create". A missing network is a sentence to a human, not a default.
    async fn ensure_network(&self, plan: &LaunchPlan) -> DriverResult<NetworkRef>;

    /// Resolve the credential the machine will accept.
    ///
    /// Also resolve rather than create, and for a sharper reason: on every
    /// substrate we know of, *creating* a key pair is the one call that hands
    /// back private key material, and this process is the wrong place for it to
    /// land. Aura holds a managed machine's key server-side and brokers the
    /// connection; the laptop only ever learns the reference.
    async fn ensure_key(&self, plan: &LaunchPlan) -> DriverResult<KeyPair>;

    /// Ask for the machine itself. Answers as soon as the substrate has
    /// accepted the request — typically before the box has an address.
    async fn launch(
        &self,
        plan: &LaunchPlan,
        network: &NetworkRef,
        key: &KeyPair,
    ) -> DriverResult<Instance>;

    /// Read back the state of one we already have.
    async fn describe(&self, id: &InstanceId) -> DriverResult<Instance>;

    /// Find the handle of a machine we did **not** make, by the address somebody
    /// is already reaching it on.
    ///
    /// The one verb here that exists for a box Aura never launched. A customer
    /// who lets Aura stop and start their own machines has typed an address into
    /// the connect wizard and nothing else — they have no reason to know the
    /// substrate's own id for it, and asking them to go and find one would be
    /// asking them to do a lookup this can do correctly.
    ///
    /// It is also the one call that proves a grant works before anything is
    /// written down: an answer at all means the role was assumed and the account
    /// was read, so a grant that was set up wrongly says so while somebody is
    /// still looking at the screen rather than a fortnight later when the first
    /// sleep is due.
    ///
    /// `None` is an answer and not a failure — the account is reachable and no
    /// machine in it answers on that address, which is a different sentence from
    /// "the account refused us" and sends somebody somewhere different.
    async fn locate(&self, address: &str) -> DriverResult<Option<InstanceId>>;

    /// Stop it without ending it — the machine keeps its disk and its address
    /// book row, and stops costing compute.
    ///
    /// The verb that makes scale-to-zero possible, and the reason it is separate
    /// from [`CloudDriver::terminate`] rather than a flag on it: one of these is
    /// reversible and the other is not. A driver that answered "stop" by ending
    /// the machine would take a member's checkouts, their uncommitted work and
    /// their installed toolchain with it, and the caller asking for sleep is
    /// asking for the opposite of that.
    ///
    /// Stopping one that is already stopped is a success. The caller wanted a
    /// machine that is not running, and there is one.
    async fn stop(&self, id: &InstanceId) -> DriverResult<()>;

    /// Start a stopped one back up. Answers as soon as the substrate accepts,
    /// which — exactly as with [`CloudDriver::launch`] — is before the box has
    /// an address, so the step above polls rather than trusting this.
    async fn start(&self, id: &InstanceId) -> DriverResult<Instance>;

    /// End it. Ending one that is already gone is a success, not an error —
    /// the caller wanted no machine, and there is no machine.
    async fn terminate(&self, id: &InstanceId) -> DriverResult<()>;
}
