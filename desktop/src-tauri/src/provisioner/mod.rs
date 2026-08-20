//! Provisioning seam — one interface, two backends.
//!
//! Aura offers the same "give me a machine that runs `aura runner`" capability
//! two ways (see the "Cloud Runners & Managed VMs" plan):
//!
//!   * **BYO** ([`ByoProvider`]) — you bring a Linux box; we mint its runner
//!     token and orchestrate. Free. Ships today; this is what the
//!     connect-a-machine wizard drives.
//!   * **Managed** ([`ManagedProvider`]) — Aura makes the box in a cloud account
//!     it holds the credential for, meters the compute and tears it down. Paid.
//!     Real: a driver behind a trait, with EC2 as the first substrate. What can
//!     still be absent is the *account* — an install nobody set up answers
//!     [`ProvisionError::ManagedNotConfigured`], which is a true runtime state
//!     rather than a hole where a backend goes.
//!
//! Both sit behind the [`Provisioner`] trait, and both call sites route through
//! [`provisioner_for`]. Nothing above this seam knows or cares which backend it
//! got — the whole point is that the managed cloud arriving touched only
//! [`managed`], never the wizard command.
//!
//! Control model (brain/muscle split): Aura cloud owns the queue, auth, policy
//! and proof; the provisioned box just runs `aura runner`, which PULLS work
//! outbound and PUSHES signed output back. Provisioning only has to get a box
//! to the point where it can join the board — it never pushes work in.

mod byo;
mod domain;
pub(crate) mod grant;
mod managed;

pub use byo::ByoProvider;
pub use domain::{
    MachineClass, ProvisionError, ProvisionKind, ProvisionSpec, ProvisionedTarget, Result,
    TargetAddress, TargetId, TargetStatus,
};
pub use managed::ManagedProvider;

/// Does this machine's handle name an account somebody granted Aura a role in?
///
/// Re-exported at the seam because the callers that ask are surfaces deciding
/// whether to offer a Sleep button, and they have no business reaching into a
/// backend's private module to find out. It is a question about a string and
/// costs a `split`, so a list can ask it once per row while drawing.
///
/// What it does *not* answer is whether that account is still set up on this
/// computer. That is asked later, by the one call that is about to spend it, and
/// answered with a sentence — the same shape [`ProvisionError::ManagedNotConfigured`]
/// already sets, and for the same reason: a surface that had to read a file to
/// draw a row would read it once per row.
pub use grant::handle::is_granted as granted_handle;

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

    /// Can this install fulfil a request of this kind at all, right now?
    ///
    /// On the seam rather than only on the managed backend, and for the same
    /// reason [`Provisioner::sleep`] is: the question is asked by a surface
    /// that wants to offer somebody a machine, BEFORE it has decided which kind
    /// to ask for. A surface that had to know it was about to ask the managed
    /// arm before it could find out whether the managed arm was set up is a
    /// surface with the branch back in it.
    ///
    /// Both arms answer. BYO is ready on every install by construction — the
    /// hardware is the user's and there is nothing here to configure; what it
    /// still needs is a cloud account, and that is reported by the one step
    /// that needs it rather than guessed at here. Managed is ready when an
    /// operator has set up an account for it, and says which of the two ways it
    /// is not when it is not.
    ///
    /// Deliberately not `async`: whatever a backend has to read to answer this
    /// is local, and a readiness check that went to the network would be asked
    /// on every draw of a surface and would turn a slow afternoon into a button
    /// that flickers.
    fn readiness(&self) -> Result<()>;

    /// Provision — or, for BYO, adopt — a target and return a handle to it.
    async fn provision(&self, spec: ProvisionSpec) -> Result<ProvisionedTarget>;

    /// Report a target's current lifecycle state.
    async fn status(&self, id: &TargetId) -> Result<TargetStatus>;

    /// Stop paying for a target nobody is using, without ending it.
    ///
    /// On the seam rather than only on the managed backend, because the question
    /// "may this place be slept?" is asked by a surface holding a place, and a
    /// surface that had to know which backend it got before it could ask is a
    /// surface with a branch in it. Both arms answer: one stops the machine, the
    /// other says — in a sentence, as a typed error — that Aura holds no
    /// credential for hardware it did not make and so cannot stop it. That is an
    /// honest asymmetry about who pays, which is one of the four things a mode is
    /// allowed to differ on, and it is not a feature missing from one of them.
    async fn sleep(&self, id: &TargetId) -> Result<TargetStatus>;

    /// Start a sleeping target and answer with where it is now.
    ///
    /// The address rather than an acknowledgement, because a machine that slept
    /// does not necessarily come back on the one it went down on. A caller told
    /// only "done" would keep dialling the old one, and a place that is running,
    /// billed and unreachable is a worse state than one that never slept.
    async fn wake(&self, id: &TargetId) -> Result<String>;

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

#[cfg(test)]
mod tests {
    use super::*;

    /// Both modes, every operation. The governing rule of the place programme
    /// is that no capability may exist in one place-mode only, and this is
    /// where that rule is either kept or quietly broken: a backend that answers
    /// `provision` by panicking, or one whose `teardown` is a `todo!()`, means
    /// every caller above the seam has to know which kind it got. Then the
    /// branch appears, and the feature lives in one mode.
    ///
    /// So each arm is asked the questions it can answer without a machine, and
    /// required to *answer* — with a value or a typed error, never a panic.
    /// `ManagedNotConfigured` is a legitimate answer ("no cloud account is set
    /// up on this install"); a crash is not.
    ///
    /// Neither arm reaches a cloud to answer either question, and that is by
    /// construction rather than by luck: an empty name is refused before a plan
    /// is made, and a handle no substrate could have issued is refused before a
    /// request is signed. A desktop that *does* have managed mode configured
    /// runs this test without spending anything.
    ///
    /// `status` is left out deliberately: it is the one operation that has to
    /// go and look, and on the BYO arm that means launching the CLI. A unit
    /// test that shells out is a test that fails on whichever machine happens
    /// not to have a runner. Its two decisions — reading the CLI's line, and
    /// what to say when the CLI refuses — are asserted directly in `byo`.
    #[tokio::test]
    async fn both_modes_answer_every_question_the_seam_asks() {
        for kind in [ProvisionKind::Byo, ProvisionKind::Managed] {
            let p = provisioner_for(kind);
            assert_eq!(p.kind(), kind, "the factory handed back the other backend");

            // An empty name is the one provisioning request both arms can
            // refuse without touching anything, and both refuse it for the
            // same reason and with the same sentence — a machine nobody named
            // is indistinguishable from every other one in the picker.
            // Asked first, because it is the question a surface asks before it
            // offers anybody anything, and it is the one question that must
            // never fail — "is this available here" has an answer on every
            // install, including one where the answer is no.
            let ready = p.readiness();
            match kind {
                // Nothing to configure: the box is the user's own.
                ProvisionKind::Byo => assert!(ready.is_ok(), "the BYO arm reported a setup problem"),
                // Either — this machine may or may not have a managed account
                // set up on it. What matters is that it ANSWERS rather than
                // panicking, and that a refusal is a sentence.
                ProvisionKind::Managed => {
                    if let Err(why) = &ready {
                        assert!(!why.to_string().is_empty(), "managed refused without saying why");
                    }
                }
            }

            let spec = ProvisionSpec {
                kind,
                name: String::new(),
                repo: None,
                class: None,
            };
            let provisioned = p.provision(spec).await;
            assert!(
                provisioned.is_err(),
                "{kind:?} provisioned a machine with no name"
            );

            let torn = p.teardown(&TargetId("nothing-registered-here".into())).await;
            assert!(torn.is_err(), "{kind:?} claimed to tear down a machine it never had");

            // The two lifecycle verbs sleep added. Both arms must ANSWER: the
            // managed one by stopping or starting a machine it made, the BYO one
            // by saying it holds no account that could. A backend that panicked
            // on either would put the branch back above the seam, and "can this
            // place sleep?" would become a question only one kind of place could
            // be asked.
            let slept = p.sleep(&TargetId("nothing-registered-here".into())).await;
            assert!(slept.is_err(), "{kind:?} slept a machine it never had");
            let woken = p.wake(&TargetId("nothing-registered-here".into())).await;
            assert!(woken.is_err(), "{kind:?} woke a machine it never had");

            for answer in [
                ready.err().map(|e| e.to_string()),
                provisioned.err().map(|e| e.to_string()),
                torn.err().map(|e| e.to_string()),
                slept.err().map(|e| e.to_string()),
                woken.err().map(|e| e.to_string()),
            ]
            .into_iter()
            .flatten()
            {
                assert!(!answer.is_empty(), "{kind:?} failed without saying why");
                // Plain language: the seam's errors are shown to the user, and
                // this is the vocabulary the managed backend would leak first.
                for jargon in ["microVM", "egress", "jailer", "unwrap", "panicked"] {
                    assert!(
                        !answer.contains(jargon),
                        "{kind:?} said {jargon:?} to a user: {answer}"
                    );
                }
            }
        }
    }

    #[test]
    fn the_two_kinds_are_the_two_place_modes_and_nothing_else() {
        // A third kind added here without a backend would compile — the factory
        // matches exhaustively, so it would not — but a kind added and mapped
        // to an existing provider would. This pins the pairing that the wizard,
        // the board and the parity gate all assume.
        assert_eq!(provisioner_for(ProvisionKind::Byo).kind(), ProvisionKind::Byo);
        assert_eq!(
            provisioner_for(ProvisionKind::Managed).kind(),
            ProvisionKind::Managed
        );
        assert_ne!(ProvisionKind::Byo, ProvisionKind::Managed);
    }
}
