//! Aura-provisioned machines.
//!
//! The other half of the place programme. BYO adopts a box the user already
//! owns; this one *makes* the box — in a cloud account Aura holds the credential
//! for, and bills for the time. Everything above the `Place` seam is handed the
//! same record either way, which is the point: a managed place is not a second
//! kind of place with its own features, it is the same place with a different
//! answer to "who created the machine".
//!
//! ## The four things a mode may differ on
//!
//! Who creates the machine (here: Aura), where the address lives (here: the
//! record this returns, because the substrate is the only thing that knows where
//! the box landed), who holds the key (here: Aura, server-side — the member
//! never sees it and never needs to), and who gets the bill (here: Aura, which
//! is why [`steps::end`] really ends a machine where the BYO arm refuses to).
//! Nothing else differs, and nothing else is allowed to.
//!
//! ## How it is split
//!
//! * [`settings`] — what the operator configured, and the three answers to
//!   "is managed mode set up here": no, badly, yes.
//! * [`plan`] — request plus settings into a plan, as a pure function. Every
//!   decision anybody would argue about is decided there, where it can be read.
//! * [`floor`] — what a fresh machine runs on its first boot, which is the
//!   team's own `aura-runner/aws/floor.sh` embedded rather than restated, so a
//!   box Aura made and a box built by hand answer `capabilities()` identically.
//! * [`driver`] — the swappable seam. One small set of verbs, one
//!   implementation per cloud.
//! * [`aws`] — the first implementation: EC2, following the recipe the team
//!   already runs (`aura-runner/aws/provision.sh`).
//! * [`steps`] — the named steps, so a failure says which one it was rather than
//!   "something broke".
//!
//! The driver is behind a trait because the substrate is the part of this most
//! likely to be replaced — Firecracker on our own metal, a per-task sandbox,
//! somebody's VPC. When that happens it should cost one file under [`aws`]'s
//! sibling and one arm of [`driver_for`], not a rewrite of the steps above it.
//!
//! ## Nothing here is exercised against a real cloud by a test
//!
//! The proofs run against [`fake`], a scripted cloud that starts nothing and
//! costs nothing. That is not a convenience: the cases worth proving — a region
//! out of capacity, a box that comes up and never gets an address, a machine
//! that dies on the way — are slow, expensive or impossible to arrange on real
//! hardware, and a test suite that spent money would be a test suite people stop
//! running.

// Three of these are visible to the rest of the provisioner rather than to this
// file alone. The grant arm next door reaches a customer's own account with the
// same signed transport, the same driver seam and the same word for which cloud
// — because the only thing that differs between a machine Aura made and a
// machine Aura was let in to is which credential signs the request. A second
// copy of any of the three would be the place the two arms drift apart, with
// only one of them getting the fix.
pub(in crate::provisioner) mod aws;
pub(in crate::provisioner) mod driver;
#[cfg(test)]
mod fake;
mod floor;
mod plan;
pub(in crate::provisioner) mod settings;
mod steps;

use std::sync::Arc;

use async_trait::async_trait;

use super::domain::{
    ProvisionError, ProvisionKind, ProvisionSpec, ProvisionStep, ProvisionedTarget, Result,
    TargetId, TargetStatus,
};
use super::grant;
use super::Provisioner;
use driver::{CloudDriver, InstanceId};
use settings::{Configured, ManagedSettings, AWS_EC2};

/// Whether this install can make machines, and what with.
///
/// Three states, matching [`Configured`]'s three, because they send a person to
/// three different places: nothing to do, a file to fix, or nothing wrong at
/// all. The distinction survives all the way to the error a surface shows —
/// collapsing it here would be the same as never having made it.
enum Backing {
    /// No cloud is configured. Managed mode is off on this install, honestly and
    /// on purpose — the desktop ships this driver whole and turned off, rather
    /// than shipping a hole where it would go.
    Unset,
    /// A cloud is configured and the configuration does not add up.
    Broken(String),
    /// Ready to make machines.
    Ready(Backend),
}

/// A configured cloud of Aura's own.
struct Backend {
    driver: Arc<dyn CloudDriver>,
    settings: ManagedSettings,
}

/// One machine in one account, ready to be stopped or started.
///
/// Owned rather than borrowed, and that is the whole reason it exists. A
/// borrowed backend is fine while every machine lives in the one account this
/// install was configured with; a machine in a customer's own account is reached
/// by asking that account for a session first, which is an `await`, and there is
/// nothing to borrow from until it answers.
struct Reaching {
    driver: Arc<dyn CloudDriver>,
    instance: InstanceId,
}

/// Provisioner for machines Aura makes — and for machines Aura was let in to.
///
/// The second half arrived without a second provisioner, which is the point: a
/// customer's own box that Aura may stop is not a third kind of place, it is the
/// same place reached with a different credential. Everything above this seam
/// asks the same questions and gets the same answers; what changed is one branch
/// on the shape of the handle.
pub struct ManagedProvider {
    backing: Backing,
    /// How long to wait on a machine that is coming up.
    ///
    /// Held here rather than on [`Backend`] because a machine in a granted
    /// account has no `Backend` — nothing on this install configured it — and a
    /// wake there deserves the same patience as a wake anywhere else. Kept as a
    /// value so the tests can run the same code path with the clock taken out.
    patience: steps::Patience,
}

impl ManagedProvider {
    /// Read the operator's setup and build the driver it names.
    pub fn new() -> Self {
        Self {
            backing: match settings::configured() {
                Configured::Absent => Backing::Unset,
                Configured::Broken(why) => Backing::Broken(why),
                Configured::Ready(settings) => match driver_for(&settings) {
                    Ok(driver) => Backing::Ready(Backend {
                        driver,
                        settings: *settings,
                    }),
                    // A setup that names a cloud we cannot open an account on is
                    // a half-finished setup, not an install without managed
                    // mode. Saying "not available yet" here would hide the one
                    // thing that is missing from somebody who is two lines from
                    // supplying it.
                    Err(why) => Backing::Broken(why),
                },
            },
            patience: steps::Patience::default(),
        }
    }

    /// The same provider wired to a driver of the caller's choosing.
    ///
    /// The seam that makes the whole module provable without a cloud: the tests
    /// hand it a scripted one. Test-only, because a way to swap the cloud at
    /// runtime is a way to point a member's machine somewhere nobody chose.
    #[cfg(test)]
    fn with_driver(
        driver: Arc<dyn CloudDriver>,
        settings: ManagedSettings,
        patience: steps::Patience,
    ) -> Self {
        Self {
            backing: Backing::Ready(Backend { driver, settings }),
            patience,
        }
    }

    /// A provider in one of the two states an install can be in without a cloud.
    #[cfg(test)]
    fn without_cloud(backing: Backing) -> Self {
        Self {
            backing,
            patience: steps::Patience::default(),
        }
    }

    /// The configured cloud, or the reason there isn't one — named against the
    /// step the caller was trying to take.
    fn backend(&self, step: ProvisionStep) -> Result<&Backend> {
        match &self.backing {
            Backing::Unset => Err(ProvisionError::ManagedNotConfigured),
            Backing::Broken(why) => Err(ProvisionError::Step {
                step,
                detail: why.clone(),
            }),
            Backing::Ready(backend) => Ok(backend),
        }
    }

    /// Which account this machine's lifecycle is decided in, and the machine's
    /// own handle in it.
    ///
    /// The one branch the grant arm cost. A handle that names an account
    /// ([`grant::handle`]) is reached by asking that account for the role it
    /// granted; every other handle is a machine Aura made in its own. Both come
    /// back as the same two fields, so the four verbs below neither know nor ask
    /// which they got — which is what makes "sleep works on your own boxes too"
    /// a routing change rather than a second lifecycle.
    async fn reaching(&self, id: &TargetId, step: ProvisionStep) -> Result<Reaching> {
        match grant::handle::parse(id.as_str()) {
            Some((account, machine)) => Ok(Reaching {
                driver: grant::reach(account)
                    .await
                    .map_err(|detail| ProvisionError::Step { step, detail })?,
                instance: InstanceId(machine.to_string()),
            }),
            None => {
                let backend = self.backend(step)?;
                Ok(Reaching {
                    driver: backend.driver.clone(),
                    instance: instance(id),
                })
            }
        }
    }
}

/// Which driver a setup asks for.
///
/// The swap point. A second substrate is an arm here and a module beside
/// [`aws`]; nothing else in this file changes, and nothing at all changes above
/// it. The final arm is not dead code even though [`settings`] refuses unknown
/// substrates today — it is what keeps a substrate added to the settings file
/// and forgotten here from falling through to the one driver that does exist,
/// which would make a machine in the wrong cloud and bill somebody for it.
fn driver_for(settings: &ManagedSettings) -> std::result::Result<Arc<dyn CloudDriver>, String> {
    match settings.substrate.as_str() {
        AWS_EC2 => Ok(Arc::new(aws::Ec2Driver::new(&settings.region)?)),
        other => Err(format!(
            "the setup names a cloud called {other:?}, and Aura has no way to make machines there"
        )),
    }
}

impl std::fmt::Debug for ManagedProvider {
    /// Hand-written, and deliberately thin.
    ///
    /// A derived one would have to reach through [`Backend`] to the driver,
    /// which holds the credential that spends the account. The one thing that
    /// must never happen to that credential is being written down by something
    /// that was only trying to be helpful, so what a debug line can say is
    /// exactly: whether this install can make machines, and in which cloud.
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        let state = match &self.backing {
            Backing::Unset => "no cloud configured".to_string(),
            Backing::Broken(_) => "configured, not usable".to_string(),
            Backing::Ready(backend) => backend.driver.substrate().to_string(),
        };
        f.debug_struct("ManagedProvider").field("cloud", &state).finish()
    }
}

#[async_trait]
impl Provisioner for ManagedProvider {
    fn kind(&self) -> ProvisionKind {
        ProvisionKind::Managed
    }

    /// Whether an operator has set this install up to make machines.
    ///
    /// The three states of [`Backing`], reported as the two answers a caller
    /// can act on, with the distinction kept in the sentence: no account is
    /// "connect your own machine instead", a broken account names the thing to
    /// fix. [`ProvisionStep::Plan`] is the step that carries the second because
    /// it is the step a create would have failed on — the settings are read
    /// before anything outside this process is touched.
    fn readiness(&self) -> Result<()> {
        self.backend(ProvisionStep::Plan).map(|_| ())
    }

    async fn provision(&self, spec: ProvisionSpec) -> Result<ProvisionedTarget> {
        // The name is checked before the cloud is even consulted, so an unnamed
        // machine is refused the same way in both modes and on every install.
        // Asked the other way round, the same mistake reads as "managed mode
        // isn't set up" on one desktop and "give the machine a name" on the
        // next, about identical input.
        spec.machine_name()?;
        let backend = self.backend(ProvisionStep::Plan)?;
        let plan = plan::plan_for(&spec, &backend.settings)?;
        steps::create(backend.driver.as_ref(), &plan, self.patience).await
    }

    async fn status(&self, id: &TargetId) -> Result<TargetStatus> {
        let at = self.reaching(id, ProvisionStep::Look).await?;
        steps::look(at.driver.as_ref(), &at.instance).await
    }

    async fn sleep(&self, id: &TargetId) -> Result<TargetStatus> {
        let at = self.reaching(id, ProvisionStep::Sleep).await?;
        steps::sleep(at.driver.as_ref(), &at.instance).await
    }

    async fn wake(&self, id: &TargetId) -> Result<String> {
        let at = self.reaching(id, ProvisionStep::Wake).await?;
        steps::wake(at.driver.as_ref(), &at.instance, self.patience).await
    }

    /// End the machine — but only ever one of Aura's own.
    ///
    /// The one verb the grant arm answers with a refusal, and it is a refusal on
    /// purpose rather than a gap. Ending a machine is the permission Aura most
    /// deliberately did not ask a customer for
    /// ([`grant::permissions::WITHHELD`]): sleeping is reversible and this is
    /// not, and a role that could end a box could take a disk, the work nobody
    /// had pushed yet, and an afternoon of installed toolchain with it. Refused
    /// here, before anything is signed, so the sentence names the reason rather
    /// than being whatever the customer's account says when a call it never
    /// allowed arrives.
    async fn teardown(&self, id: &TargetId) -> Result<()> {
        if let Some((account, _)) = grant::handle::parse(id.as_str()) {
            return Err(ProvisionError::Unsupported(format!(
                "This machine is yours, in the account {account:?}, and Aura was given \
                 permission to stop it and start it — nothing more. Getting rid of it for good \
                 is yours to do, where you made it."
            )));
        }
        let backend = self.backend(ProvisionStep::Teardown)?;
        steps::end(backend.driver.as_ref(), &instance(id)).await
    }
}

/// The substrate's handle for a target Aura made in its own account.
///
/// One line, because for a machine Aura made the two are the same string: the id
/// this seam hands out is the id the substrate gave the machine, so there is
/// nothing to look up and nothing that can drift out of step with the cloud's
/// own bookkeeping. A machine in somebody else's account is the case where they
/// are *not* the same string — the row has to say which account as well — and
/// that one is read by [`grant::handle`] rather than here.
fn instance(id: &TargetId) -> InstanceId {
    InstanceId(id.as_str().to_string())
}

#[cfg(test)]
mod tests {
    use super::*;
    use driver::{DriverError, InstanceState};
    use fake::{FakeCloud, Stage};
    use std::time::Duration;

    fn settings() -> ManagedSettings {
        ManagedSettings {
            substrate: AWS_EC2.to_string(),
            region: "eu-central-1".into(),
            image_id: "ami-0123456789abcdef0".into(),
            ssh_user: "ubuntu".into(),
            key_pair: "aura-managed".into(),
            key_ref: "managed:2f9c1f8e-0b2a-4d55-9a44-1c2d3e4f5a6b".into(),
            security_group: "aura-managed".into(),
            home: "/home/ubuntu".into(),
            disk_gb: 40,
        }
    }

    /// A provider wired to a scripted cloud, with no waiting in it.
    fn wired(cloud: FakeCloud) -> ManagedProvider {
        ManagedProvider::with_driver(
            Arc::new(cloud),
            settings(),
            steps::Patience {
                attempts: 3,
                gap: Duration::ZERO,
            },
        )
    }

    fn asked(name: &str, repo: Option<&str>) -> ProvisionSpec {
        ProvisionSpec {
            kind: ProvisionKind::Managed,
            name: name.into(),
            repo: repo.map(str::to_string),
            class: None,
        }
    }

    #[tokio::test]
    async fn making_a_place_hands_back_a_machine_anything_above_the_seam_can_reach() {
        // The acceptance criterion, end to end. Before this, every managed call
        // answered `ManagedNotConfigured` and the four fields did not exist; the
        // claim now is that they come back filled, from the cloud that made the
        // machine, in the same shape a box somebody brought produces.
        let made = wired(FakeCloud::new())
            .provision(asked("crew-box", Some("MHASK/aura-sovereign")))
            .await
            .expect("a managed place");

        assert_eq!(made.kind, ProvisionKind::Managed);
        assert_eq!(made.name, "crew-box");
        assert_eq!(made.id, TargetId(FakeCloud::INSTANCE.into()));

        let address = made.address.expect("a managed machine knows where it is");
        assert_eq!(address.host, FakeCloud::HOST);
        assert_eq!(address.ssh_user, "ubuntu");
        assert_eq!(address.key_ref, settings().key_ref);
        assert_eq!(
            address.repo_path.as_deref(),
            Some("/home/ubuntu/aura-sovereign")
        );
        // Up, not yet on the board. Claiming online here would put a row in the
        // picker that every call against it fails until the runner joins.
        assert_eq!(made.status, TargetStatus::Provisioning);
    }

    #[tokio::test]
    async fn the_record_carries_a_reference_and_never_a_credential() {
        // The rule the runner registry's own column is guarded for, kept on this
        // side of the wire too: what travels is a name for the key, and the key
        // itself never enters this process at all.
        let made = wired(FakeCloud::new())
            .provision(asked("crew-box", None))
            .await
            .expect("a managed place");
        assert!(made.runner_token.is_none(), "a token was baked into the machine");
        let key_ref = made.address.expect("an address").key_ref;
        assert!(key_ref.starts_with("managed:"), "{key_ref}");
        assert!(!key_ref.to_ascii_uppercase().contains("PRIVATE KEY"), "{key_ref}");
    }

    #[tokio::test]
    async fn a_place_that_could_not_be_made_says_which_step_failed() {
        // The spec's own words: not "something broke". Each of these is a
        // different afternoon — a group nobody made, a key nobody made, a region
        // with no capacity — and each names the one to go and look at.
        for (stage, code, expected) in [
            (Stage::Network, "InvalidGroup.NotFound", ProvisionStep::Network),
            (Stage::Key, "InvalidKeyPair.NotFound", ProvisionStep::Key),
            (
                Stage::Launch,
                "InsufficientInstanceCapacity",
                ProvisionStep::Launch,
            ),
        ] {
            let refused = wired(FakeCloud::new().refusing(stage, code, "the cloud's own sentence"))
                .provision(asked("crew-box", None))
                .await;
            let Err(ProvisionError::Step { step, detail }) = refused else {
                panic!("{stage:?} failed without naming a step");
            };
            assert_eq!(step, expected);
            // And in the cloud's words, because ours would name neither the
            // group nor the region nor the permission.
            assert!(detail.contains("the cloud's own sentence"), "{detail}");
        }
    }

    #[tokio::test]
    async fn an_install_with_no_cloud_says_so_instead_of_failing_oddly() {
        // The honest off state. Every operation answers — with a typed error
        // that tells the user the one thing they can act on — and none of them
        // panics, which is the rule the seam test one level up enforces for
        // both modes.
        let off = ManagedProvider::without_cloud(Backing::Unset);
        assert!(matches!(
            off.provision(asked("crew-box", None)).await,
            Err(ProvisionError::ManagedNotConfigured)
        ));
        assert!(matches!(
            off.status(&TargetId("i-1".into())).await,
            Err(ProvisionError::ManagedNotConfigured)
        ));
        assert!(matches!(
            off.teardown(&TargetId("i-1".into())).await,
            Err(ProvisionError::ManagedNotConfigured)
        ));
    }

    #[tokio::test]
    async fn a_setup_that_does_not_add_up_is_not_reported_as_no_setup() {
        // The distinction [`Configured`] exists for, carried all the way to what
        // a person is shown. Folded together, a typo in a region name comes out
        // as "managed machines aren't available yet" and nobody ever opens the
        // file.
        let broken =
            ManagedProvider::without_cloud(Backing::Broken("the region is spelled oddly".into()));
        let Err(ProvisionError::Step { step, detail }) =
            broken.provision(asked("crew-box", None)).await
        else {
            panic!("a broken setup was reported as something else");
        };
        assert_eq!(step, ProvisionStep::Plan);
        assert!(detail.contains("spelled oddly"), "{detail}");
        // And the same complaint against the step the caller was actually
        // taking, so it reads as a sentence either way.
        let Err(ProvisionError::Step { step, .. }) =
            broken.teardown(&TargetId("i-1".into())).await
        else {
            panic!("a broken setup was reported as something else");
        };
        assert_eq!(step, ProvisionStep::Teardown);
    }

    #[tokio::test]
    async fn an_unnamed_machine_is_refused_the_same_way_on_every_install() {
        // Asked the other way round, identical input reads as "managed mode
        // isn't set up" on one desktop and "give the machine a name" on the
        // next.
        for provider in [
            wired(FakeCloud::new()),
            ManagedProvider::without_cloud(Backing::Unset),
        ] {
            assert!(matches!(
                provider.provision(asked("   ", None)).await,
                Err(ProvisionError::MissingName)
            ));
        }
    }

    #[tokio::test]
    async fn a_machine_aura_made_can_be_read_back_and_ended() {
        // The asymmetry the managed arm exists to close: an idle box you brought
        // stays up on your bill because Aura holds no credential for it. This
        // one Aura made, so ending it is exactly what teardown means.
        let cloud = FakeCloud::new().sitting_at(InstanceState::Running);
        let provider = wired(cloud);
        assert_eq!(
            provider
                .status(&TargetId(FakeCloud::INSTANCE.into()))
                .await
                .expect("a state"),
            TargetStatus::Online
        );
        provider
            .teardown(&TargetId(FakeCloud::INSTANCE.into()))
            .await
            .expect("a machine Aura made is a machine Aura can end");
    }

    #[tokio::test]
    async fn a_machine_aura_made_can_be_put_to_sleep_and_started_again() {
        // The other half of the same asymmetry `teardown` closes, and the half
        // people actually use: ending a box loses everything on it, so nobody
        // ends one they intend to come back to. Stopping it costs nothing and
        // keeps the disk, which is the only version of "walk away" that is free.
        let cloud = Arc::new(FakeCloud::new());
        let provider = ManagedProvider::with_driver(
            cloud.clone(),
            settings(),
            steps::Patience {
                attempts: 3,
                gap: Duration::ZERO,
            },
        );
        let id = TargetId(FakeCloud::INSTANCE.into());
        assert_eq!(
            provider.sleep(&id).await.expect("it sleeps"),
            TargetStatus::Asleep
        );
        assert_eq!(
            provider.status(&id).await.expect("a state"),
            TargetStatus::Asleep,
            "a place Aura slept read back as something else"
        );
        assert_eq!(
            provider.wake(&id).await.expect("it wakes"),
            FakeCloud::HOST,
            "waking must say where the machine is now, not merely that it started"
        );
        assert!(
            !cloud.calls().contains(&"terminate".to_string()),
            "sleeping and waking a place ended it: {:?}",
            cloud.calls()
        );
    }

    #[tokio::test]
    async fn an_install_with_no_cloud_cannot_sleep_anything_and_says_which_step() {
        // The off state, kept honest across the two new verbs too: nothing
        // panics, and a setup that does not add up is still distinguishable from
        // an install nobody set up.
        let off = ManagedProvider::without_cloud(Backing::Unset);
        assert!(matches!(
            off.sleep(&TargetId("i-1".into())).await,
            Err(ProvisionError::ManagedNotConfigured)
        ));
        let broken =
            ManagedProvider::without_cloud(Backing::Broken("the region is spelled oddly".into()));
        let Err(ProvisionError::Step { step, .. }) = broken.wake(&TargetId("i-1".into())).await
        else {
            panic!("a broken setup was reported as something else");
        };
        assert_eq!(step, ProvisionStep::Wake);
    }

    #[tokio::test]
    async fn nothing_in_a_provision_asks_the_cloud_for_more_than_the_recipe() {
        // The order is the recipe's, and it is load-bearing: network and key are
        // the operator's setup and are checked before anything is launched, so a
        // misconfigured install never leaves a stray machine on somebody's bill.
        let cloud = Arc::new(FakeCloud::new());
        ManagedProvider::with_driver(
            cloud.clone(),
            settings(),
            steps::Patience {
                attempts: 3,
                gap: Duration::ZERO,
            },
        )
        .provision(asked("crew-box", None))
        .await
        .expect("a managed place");
        assert_eq!(
            cloud.calls(),
            vec!["ensure_network", "ensure_key", "launch", "describe"]
        );
    }

    #[tokio::test]
    async fn ending_a_customers_own_machine_is_refused_before_anything_is_signed() {
        // The one verb the grant arm answers with a refusal, and a refusal on
        // purpose. Ending a machine is the permission Aura most deliberately did
        // not ask a customer for: sleeping is reversible and this is not.
        //
        // Refused on the SHAPE of the handle, so no account is reached to find
        // out — which is what makes this test hermetic, and also what makes the
        // sentence name the reason instead of repeating whatever a customer's
        // account says when a call it never allowed arrives.
        let cloud = Arc::new(FakeCloud::new());
        let provider = ManagedProvider::with_driver(
            cloud.clone(),
            settings(),
            steps::Patience {
                attempts: 3,
                gap: Duration::ZERO,
            },
        );
        let theirs = TargetId(format!("grant:acme-eu/{}", FakeCloud::INSTANCE));
        let Err(ProvisionError::Unsupported(why)) = provider.teardown(&theirs).await else {
            panic!("a machine in somebody else's account was reported as ended");
        };
        assert!(why.contains("acme-eu"), "{why}");
        assert!(why.contains("stop it and start it"), "{why}");
        assert!(
            cloud.calls().is_empty(),
            "a refusal on the handle's shape reached a cloud: {:?}",
            cloud.calls()
        );

        // And the same install still ends its OWN machines, because the
        // refusal is about whose account it is and not about this install.
        provider
            .teardown(&TargetId(FakeCloud::INSTANCE.into()))
            .await
            .expect("a machine Aura made is a machine Aura can end");
    }

    #[tokio::test]
    async fn a_machine_in_a_granted_account_is_not_looked_for_in_auras_own() {
        // The bug this branch exists to prevent, and it is the sharpest one in
        // the whole arm: the same `i-0abc…` names one machine in Aura's account
        // and, quite possibly, a different customer's machine in theirs. Routed
        // by configuration rather than by the handle, a stop for one lands on the
        // other — which is not an error message, it is somebody else's box going
        // down.
        //
        // The account named here is not set up, so the sentence says so and no
        // request is signed. What is being proved is where it went looking.
        let cloud = Arc::new(FakeCloud::new());
        let provider = ManagedProvider::with_driver(
            cloud.clone(),
            settings(),
            steps::Patience {
                attempts: 3,
                gap: Duration::ZERO,
            },
        );
        let theirs = TargetId(format!("grant:not-set-up-here/{}", FakeCloud::INSTANCE));
        let Err(ProvisionError::Step { step, detail }) = provider.sleep(&theirs).await else {
            panic!("a machine in an account nobody set up was reported as slept");
        };
        assert_eq!(step, ProvisionStep::Sleep);
        assert!(detail.contains("not-set-up-here"), "{detail}");
        assert!(
            !cloud.calls().contains(&"stop".to_string()),
            "a stop meant for somebody else's account was sent to Aura's: {:?}",
            cloud.calls()
        );
    }

    #[tokio::test]
    async fn an_install_with_no_cloud_of_its_own_can_still_sleep_a_customers_box() {
        // The whole acceptance criterion, stated where it is decided. A customer
        // who runs their own metal has no managed account on this install and
        // never will — and the reason their box could not sleep was never the
        // machine, it was that nothing here held a credential for the account it
        // runs in. A grant supplies exactly that, so the route to the machine
        // must not pass through the setup they do not have.
        //
        // Nobody has granted anything in a test process either, so what this
        // proves is that the refusal is about the ACCOUNT rather than about this
        // install having no cloud of its own: the answer names the account, and
        // it is not `ManagedNotConfigured`.
        let off = ManagedProvider::without_cloud(Backing::Unset);
        let theirs = TargetId("grant:acme-eu/i-0123456789abcdef0".into());

        for (asked, step) in [
            (off.sleep(&theirs).await.err(), ProvisionStep::Sleep),
            (off.wake(&theirs).await.err(), ProvisionStep::Wake),
        ] {
            let Some(ProvisionError::Step { step: named, detail }) = asked else {
                panic!("{step:?} on a granted machine fell back to this install's own setup");
            };
            assert_eq!(named, step);
            assert!(detail.contains("acme-eu"), "{detail}");
        }

        // And a machine Aura would have made still reports the honest off state,
        // so the branch narrowed nothing that was working before.
        assert!(matches!(
            off.sleep(&TargetId("i-0123456789abcdef0".into())).await,
            Err(ProvisionError::ManagedNotConfigured)
        ));
    }

    #[test]
    fn a_debug_line_cannot_print_the_credential_that_spends_the_account() {
        // Not a style point. The driver holds a secret access key, and a derived
        // `Debug` three levels up is exactly how one reaches a log file.
        let printed = format!(
            "{:?}",
            ManagedProvider::without_cloud(Backing::Unset)
        );
        assert!(printed.contains("no cloud configured"), "{printed}");
        let wired = format!("{:?}", wired(FakeCloud::new()));
        assert!(wired.contains("scripted"), "{wired}");
        assert!(!wired.contains("key"), "{wired}");
    }

    #[test]
    fn a_cloud_with_no_driver_does_not_fall_through_to_the_one_that_exists() {
        // The swap point, guarded on this side too. A substrate added to the
        // settings file and forgotten here would otherwise make a machine in
        // whichever cloud happens to be first.
        let mut elsewhere = settings();
        elsewhere.substrate = "firecracker".into();
        let why = driver_for(&elsewhere).err().expect("no driver for that cloud");
        assert!(why.contains("firecracker"), "{why}");
    }

    #[test]
    fn a_scripted_cloud_is_never_what_a_real_install_gets() {
        // The fake exists so the cases worth proving cost nothing. A build that
        // could reach it would be a cloud somebody configures by accident, and
        // "it said it made a machine" is the one failure this module is arranged
        // to prevent — so the only way to a scripted cloud is `with_driver`,
        // which is test-only, and `driver_for` has no arm that reaches it.
        for named in ["scripted", "fake", "memory"] {
            let mut elsewhere = settings();
            elsewhere.substrate = named.into();
            assert!(
                driver_for(&elsewhere).is_err(),
                "a setup naming {named:?} produced a driver"
            );
        }
    }

    #[tokio::test]
    async fn a_cloud_that_cannot_be_reached_is_not_reported_as_a_refusal() {
        // The two are different afternoons: one is worth retrying and the other
        // is somebody's account. Kept apart by the driver's own error type, and
        // this checks the distinction survives being turned into a sentence.
        let unreachable = DriverError::Unreachable("the network went away".into());
        assert!(unreachable.to_string().contains("went away"));
        let refused = DriverError::Refused {
            code: "UnauthorizedOperation".into(),
            message: "you are not allowed to do that".into(),
        };
        assert!(refused.to_string().contains("not allowed"));
    }
}
