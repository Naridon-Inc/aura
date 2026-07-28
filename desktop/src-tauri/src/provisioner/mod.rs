//! Provisioning seam — one interface, two backends.
//!
//! Aura offers the same "give me a machine that runs `aura runner`" capability
//! two ways (see the "Cloud Runners & Managed VMs" plan):
//!
//!   * **BYO** ([`ByoProvider`]) — you bring a Linux box; we mint its runner
//!     token and orchestrate. Free. Ships today; this is what the
//!     connect-a-machine wizard drives.
//!   * **Managed** ([`ManagedProvider`]) — Aura spins up an isolated
//!     Firecracker/E2B microVM on demand, meters compute, tears it down. Paid.
//!     Backend not wired yet — every op returns a typed
//!     [`ProvisionError::ManagedNotConfigured`].
//!
//! Both sit behind the [`Provisioner`] trait, and both call sites route through
//! [`provisioner_for`]. Nothing above this seam knows or cares which backend it
//! got — the whole point is that adding the managed cloud later touches only
//! [`managed`], never the wizard command.
//!
//! Control model (brain/muscle split): Aura cloud owns the queue, auth, policy
//! and proof; the provisioned box just runs `aura runner`, which PULLS work
//! outbound and PUSHES signed output back. Provisioning only has to get a box
//! to the point where it can join the board — it never pushes work in.

mod byo;
mod domain;
mod managed;

pub use byo::ByoProvider;
pub use domain::{
    MachineClass, ProvisionError, ProvisionKind, ProvisionSpec, ProvisionedTarget, Result,
    TargetId, TargetStatus,
};
pub use managed::ManagedProvider;

use async_trait::async_trait;

/// The seam every provisioning backend implements.
///
/// Async because both backends do IO (BYO shells the `aura` CLI; managed will
/// hit the substrate's HTTP API). `Send + Sync` so a `Box<dyn Provisioner>` can
/// be handed across tokio tasks.
#[async_trait]
pub trait Provisioner: Send + Sync {
    /// Which backend this is. Lets a caller that erased the concrete type still
    /// branch on kind (e.g. to show "free" vs "metered" in the UI).
    fn kind(&self) -> ProvisionKind;

    /// Provision — or, for BYO, adopt — a target and return a handle to it.
    async fn provision(&self, spec: ProvisionSpec) -> Result<ProvisionedTarget>;

    /// Report a target's current lifecycle state.
    async fn status(&self, id: &TargetId) -> Result<TargetStatus>;

    /// Tear the target down (managed) or detach it (BYO).
    async fn teardown(&self, id: &TargetId) -> Result<()>;
}

/// Pick the provisioning backend for a [`ProvisionKind`]. The single factory
/// both the BYO wizard and the future managed flow route through — the one
/// place that maps "what kind of machine" to "which implementation".
pub fn provisioner_for(kind: ProvisionKind) -> Box<dyn Provisioner> {
    match kind {
        ProvisionKind::Byo => Box::new(ByoProvider::new()),
        ProvisionKind::Managed => Box::new(ManagedProvider::new()),
    }
}
