//! Aura-provisioned managed VMs — the paid path.
//!
//! This is Product B from the "Cloud Runners & Managed VMs" plan: Aura spins up
//! an isolated Firecracker microVM on demand, runs the task, tears it down, and
//! meters compute. The recommended Phase-1 substrate is E2B (open-source,
//! self-hostable, Firecracker + memory pause/resume) sitting behind this exact
//! [`Provisioner`] seam so Phase 3 can drop in self-hosted Firecracker or
//! customer-VPC compute without anything above this line changing.
//!
//! None of that backend is wired in this build. Rather than panic or `todo!()`,
//! every operation returns the typed [`ProvisionError::ManagedNotConfigured`] —
//! an honest, user-facing "not available yet" runtime state. When the substrate
//! lands, this struct grows the E2B client + credit metering here and the
//! callers stay untouched.

use async_trait::async_trait;

use super::domain::{
    ProvisionError, ProvisionKind, ProvisionSpec, ProvisionedTarget, Result, TargetId,
    TargetStatus,
};
use super::Provisioner;

/// Provisioner for machines Aura hosts. A real type occupying the seam; its
/// backing cloud is simply not connected yet (see module docs).
#[derive(Debug, Default, Clone)]
pub struct ManagedProvider;

impl ManagedProvider {
    pub fn new() -> Self {
        Self
    }
}

#[async_trait]
impl Provisioner for ManagedProvider {
    fn kind(&self) -> ProvisionKind {
        ProvisionKind::Managed
    }

    async fn provision(&self, _spec: ProvisionSpec) -> Result<ProvisionedTarget> {
        Err(ProvisionError::ManagedNotConfigured)
    }

    async fn status(&self, _id: &TargetId) -> Result<TargetStatus> {
        Err(ProvisionError::ManagedNotConfigured)
    }

    async fn teardown(&self, _id: &TargetId) -> Result<()> {
        Err(ProvisionError::ManagedNotConfigured)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn every_op_reports_not_configured() {
        let p = ManagedProvider::new();
        let spec = ProvisionSpec {
            kind: ProvisionKind::Managed,
            name: "box".into(),
            repo: None,
            class: None,
        };
        assert!(matches!(
            p.provision(spec).await,
            Err(ProvisionError::ManagedNotConfigured)
        ));
        assert!(matches!(
            p.status(&TargetId("vm-1".into())).await,
            Err(ProvisionError::ManagedNotConfigured)
        ));
        assert!(matches!(
            p.teardown(&TargetId("vm-1".into())).await,
            Err(ProvisionError::ManagedNotConfigured)
        ));
    }
}
