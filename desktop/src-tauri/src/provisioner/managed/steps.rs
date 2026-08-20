//! Making a machine, one named step at a time.
//!
//! The whole reason this is a sequence of named steps rather than one function
//! is the sentence somebody reads when it does not work. Provisioning is five
//! things in a row against somebody else's API and each fails for its own
//! reason with its own fix: a key pair that was never made, a region with no
//! capacity this afternoon, a box that booted and never got an address. Rolled
//! into "couldn't create the machine", all three are the same dead end. Carried
//! as a [`ProvisionStep`], each one says what to go and look at.
//!
//! Nothing here knows which cloud it is talking to — that is
//! [`CloudDriver`]'s half — and nothing here opens a connection to the machine
//! it just made. A provisioner that dialled would be the second transport the
//! single-`ssh` guard exists to prevent; whether a box answers is `Place`'s
//! question, asked identically for every mode.

use std::time::Duration;

use crate::provisioner::domain::{
    ProvisionError, ProvisionKind, ProvisionStep, ProvisionedTarget, Result, TargetAddress,
    TargetId, TargetStatus,
};

use super::driver::{CloudDriver, DriverError, Instance, InstanceId, InstanceState};
use super::plan::LaunchPlan;

/// How long to wait for a new machine to come up, and how often to look.
///
/// A cloud accepts a launch in a second and takes the better part of a minute
/// to hand the box an address. Polling is the only honest way to find out —
/// there is nothing to subscribe to — so the only decisions are how often and
/// for how long. Both are values rather than constants because the tests need
/// the same code path with no waiting in it; a test that slept for real would
/// be a test somebody eventually deletes.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Patience {
    pub attempts: u32,
    pub gap: Duration,
}

impl Default for Patience {
    fn default() -> Self {
        // Five minutes at five-second intervals. Past that a box is not slow,
        // it is not coming — and a spinner that never ends is worse than a
        // sentence saying so.
        Self {
            attempts: 60,
            gap: Duration::from_secs(5),
        }
    }
}

/// Make a machine, and hand back the record everything above the seam uses.
///
/// The order is the recipe's: somewhere to sit, something to connect with, the
/// box, then waiting for it to have an address. Network and key come first
/// because both are cheap to check and both are the operator's setup rather
/// than the cloud's mood — failing on them before anything is launched means a
/// misconfigured install never leaves a half-made machine on somebody's bill.
pub async fn create(
    driver: &dyn CloudDriver,
    plan: &LaunchPlan,
    patience: Patience,
) -> Result<ProvisionedTarget> {
    let network = driver
        .ensure_network(plan)
        .await
        .map_err(|e| at(ProvisionStep::Network, e))?;
    let key = driver
        .ensure_key(plan)
        .await
        .map_err(|e| at(ProvisionStep::Key, e))?;
    let launched = driver
        .launch(plan, &network, &key)
        .await
        .map_err(|e| at(ProvisionStep::Launch, e))?;

    let (id, host) = wait_for_an_address(driver, launched, Waiting::ToStart, patience).await?;

    Ok(ProvisionedTarget {
        id: TargetId(id.0),
        kind: ProvisionKind::Managed,
        name: plan.name.clone(),
        // Not minted here, and not baked into the boot script: a runner token
        // in a machine's user data is a credential handed to every process on
        // the box, because the metadata service will read it back to any of
        // them. It is delivered over the connection afterwards, the same way
        // the connect wizard delivers one to a box somebody brought.
        runner_token: None,
        address: Some(TargetAddress {
            host,
            ssh_user: plan.ssh_user.clone(),
            key_ref: plan.key_ref.clone(),
            repo_path: plan.repo_path.clone(),
        }),
        // The machine is up; the runner has not joined the board yet. Same
        // answer the BYO arm gives a freshly registered box, and for the same
        // reason: claiming online here would put a row in the picker that every
        // call against it fails until the setup steps have run.
        status: TargetStatus::Provisioning,
    })
}

/// What the substrate says about a machine we already made.
///
/// Deliberately the substrate's answer and not the board's. Whether the *runner*
/// on the box is draining work is a question for the cloud board, which the
/// frontend already polls; what a provisioner can honestly know is whether the
/// machine it made still exists and is up. Answering the second question with
/// the first is how a place shows as online while nothing on it is listening.
pub async fn look(driver: &dyn CloudDriver, id: &InstanceId) -> Result<TargetStatus> {
    let seen = driver
        .describe(id)
        .await
        .map_err(|e| at(ProvisionStep::Look, e))?;
    Ok(match seen.state {
        InstanceState::Starting => TargetStatus::Provisioning,
        InstanceState::Running => TargetStatus::Online,
        // On its way to sleep is, to everything above here, asleep: nothing runs
        // on it and nothing will until somebody wakes it. The difference is the
        // forty seconds the guest takes to shut down cleanly, and it is not a
        // difference anybody can act on.
        InstanceState::Stopping | InstanceState::Stopped => TargetStatus::Asleep,
        InstanceState::Ending => TargetStatus::Terminating,
        InstanceState::Gone => TargetStatus::Terminated,
    })
}

/// Put a machine Aura made to sleep.
///
/// Stopped, not ended. The two are one keystroke apart in every cloud's API and
/// opposite in effect: the disk, the checkouts, the half-finished branch and the
/// toolchain somebody spent forty minutes installing all survive a stop and none
/// of them survives a termination. A member who walked away for an hour is asking
/// for the first and would never ask for the second, so the verbs stay apart all
/// the way down to the driver.
///
/// Answers [`TargetStatus::Asleep`] rather than reading the machine back. The
/// stop has been accepted, and a cloud takes the better part of a minute to
/// finish it — a caller that polled for `stopped` before writing the fact down
/// would leave the place reading as awake for that minute, on every surface,
/// right after somebody watched it be put to sleep.
pub async fn sleep(driver: &dyn CloudDriver, id: &InstanceId) -> Result<TargetStatus> {
    driver
        .stop(id)
        .await
        .map_err(|e| at(ProvisionStep::Sleep, e))?;
    Ok(TargetStatus::Asleep)
}

/// Wake a machine Aura put to sleep, and say where it is now.
///
/// The address is the part that must not be assumed. A stopped machine gives up
/// its public address, and starting it gets a different one — so a wake that
/// answered "done" and left the book holding yesterday's host would produce a
/// place that is up, billed, and unreachable. That is a worse failure than never
/// having slept it, because the machine is running the whole time. What this
/// returns is what the caller writes down.
pub async fn wake(
    driver: &dyn CloudDriver,
    id: &InstanceId,
    patience: Patience,
) -> Result<String> {
    let started = driver
        .start(id)
        .await
        .map_err(|e| at(ProvisionStep::Wake, e))?;
    let (_, host) = wait_for_an_address(driver, started, Waiting::ToWake, patience).await?;
    Ok(host)
}

/// Which way a machine is expected to be moving while we wait on it.
///
/// The same state means opposite things depending on the answer. Waiting on a
/// machine that was just created, `stopped` means it died on the way up and
/// waiting the full five minutes is five minutes of somebody watching a spinner
/// for a box that is already finished. Waiting on one being woken, `stopped` is
/// simply the state it is leaving — a cloud can report it for a beat after it has
/// accepted the start — and giving up there would fail a wake that was about to
/// succeed.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Waiting {
    ToStart,
    ToWake,
}

/// End a machine Aura made.
///
/// Unlike the BYO arm — which refuses, because the hardware is the user's —
/// this is a machine Aura created in its own account and is billing for, so
/// ending it is exactly what teardown means here. That asymmetry is the one the
/// managed arm exists to close: an idle box you brought stays up on your bill
/// because Aura holds no credential for it, and this one does not.
pub async fn end(driver: &dyn CloudDriver, id: &InstanceId) -> Result<()> {
    driver
        .terminate(id)
        .await
        .map_err(|e| at(ProvisionStep::Teardown, e))
}

/// Poll until the machine has an address, or until it is clear it will not get
/// one.
///
/// A launch call answers as soon as the request is accepted, which is before
/// the box exists in any useful sense. Handing that answer straight back would
/// produce a place with no host in it — a record every surface accepts and
/// nothing can dial.
async fn wait_for_an_address(
    driver: &dyn CloudDriver,
    launched: Instance,
    waiting: Waiting,
    patience: Patience,
) -> Result<(InstanceId, String)> {
    let mut seen = launched;
    for attempt in 0..=patience.attempts {
        match seen.state {
            InstanceState::Running => {
                if let Some(host) = seen.host.as_deref().map(str::trim).filter(|h| !h.is_empty()) {
                    return Ok((seen.id, host.to_string()));
                }
            }
            InstanceState::Starting => {}
            // It went the other way. Waiting longer cannot help, and the five
            // minutes we would otherwise spend are five minutes of somebody
            // watching a spinner for a machine that is already gone. Unless we
            // are waking one, in which case down is the state it is leaving.
            InstanceState::Stopping | InstanceState::Stopped
                if waiting == Waiting::ToStart =>
            {
                return Err(gave_up("it stopped before it was ready to use"))
            }
            InstanceState::Stopping | InstanceState::Stopped => {}
            InstanceState::Ending | InstanceState::Gone => {
                return Err(gave_up("it ended before it was ready to use"))
            }
        }
        if attempt == patience.attempts {
            break;
        }
        tokio::time::sleep(patience.gap).await;
        seen = driver
            .describe(&seen.id)
            .await
            .map_err(|e| at(ProvisionStep::Reach, e))?;
    }

    // Two different afternoons, so two different sentences. Still starting is a
    // slow region; running with no address is a network that hands out none,
    // which is a setting somebody has to change and no amount of waiting will.
    Err(gave_up(match seen.state {
        InstanceState::Running => {
            "it started, but the cloud gave it no address to reach it on — check the \
             network it was put in"
        }
        _ => "it hasn't finished starting. It may still come up; try opening it again in a \
              few minutes",
    }))
}

/// A step failed, in the words of whatever failed it.
///
/// The driver's own message is kept rather than paraphrased: it is the half
/// that knows whether the region was full or the credential was refused, and
/// that sentence is the only one with a fix in it. A refusal with nothing to
/// say falls back to its code, because a machine-readable name is still
/// something to search for and an empty string is not.
fn at(step: ProvisionStep, error: DriverError) -> ProvisionError {
    let detail = match error {
        DriverError::Refused { code, message } => {
            let message = message.trim().to_string();
            if message.is_empty() {
                format!("the cloud refused it ({code})")
            } else {
                message
            }
        }
        DriverError::Unreachable(why) | DriverError::Unreadable(why) => {
            let why = why.trim().to_string();
            if why.is_empty() {
                "the cloud didn't answer".to_string()
            } else {
                why
            }
        }
    };
    ProvisionError::Step { step, detail }
}

fn gave_up(detail: &str) -> ProvisionError {
    ProvisionError::Step {
        step: ProvisionStep::Reach,
        detail: detail.to_string(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::provisioner::managed::fake::{FakeCloud, Stage};
    use crate::provisioner::managed::plan::plan_for;
    use crate::provisioner::managed::settings::{ManagedSettings, AWS_EC2};
    use crate::provisioner::domain::{MachineClass, ProvisionKind, ProvisionSpec};

    /// No waiting: the same code path, with the clock taken out of it.
    fn impatient() -> Patience {
        Patience {
            attempts: 4,
            gap: Duration::ZERO,
        }
    }

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

    fn plan(repo: Option<&str>) -> LaunchPlan {
        let spec = ProvisionSpec {
            kind: ProvisionKind::Managed,
            name: "crew-box".into(),
            repo: repo.map(str::to_string),
            class: Some(MachineClass::Medium),
        };
        plan_for(&spec, &settings()).expect("the plan is well formed")
    }

    #[tokio::test]
    async fn a_made_machine_comes_back_with_the_four_fields_it_takes_to_reach_one() {
        // The acceptance criterion of the whole managed arm, in one assertion:
        // what comes back is the same record a box somebody brought produces —
        // host, login, a reference to a key, and where the project sits — so
        // nothing above the seam can tell which of the two it got.
        let cloud = FakeCloud::new();
        let made = create(&cloud, &plan(Some("MHASK/aura-sovereign")), impatient())
            .await
            .expect("a machine");

        let address = made.address.expect("a machine you cannot reach is not a machine");
        assert_eq!(address.host, FakeCloud::HOST);
        assert_eq!(address.ssh_user, "ubuntu");
        assert_eq!(address.key_ref, settings().key_ref);
        assert_eq!(address.repo_path.as_deref(), Some("/home/ubuntu/aura-sovereign"));

        assert_eq!(made.kind, ProvisionKind::Managed);
        assert_eq!(made.name, "crew-box");
        assert_eq!(made.id, TargetId(FakeCloud::INSTANCE.to_string()));
        // Up, but not yet on the board — the runner still has to join it.
        assert_eq!(made.status, TargetStatus::Provisioning);
    }

    #[tokio::test]
    async fn no_credential_travels_in_the_record() {
        // The record is written down, synced and shown. A key that reached it
        // would be a key in a database, a devtools panel and a screenshot.
        let cloud = FakeCloud::new();
        let made = create(&cloud, &plan(None), impatient()).await.expect("a machine");
        assert!(made.runner_token.is_none());
        let address = made.address.expect("an address");
        assert!(address.key_ref.starts_with("managed:"), "{}", address.key_ref);
        assert!(!address.key_ref.contains("BEGIN"));
    }

    #[tokio::test]
    async fn the_steps_happen_in_the_order_that_leaves_no_stray_machine() {
        // Network and key are both the operator's setup and both cost nothing
        // to check. Checked after the launch instead, a misconfigured install
        // leaves a running box on somebody's bill every time somebody clicks.
        let cloud = FakeCloud::new();
        create(&cloud, &plan(None), impatient()).await.expect("a machine");
        let calls = cloud.calls();
        assert_eq!(calls[0], "ensure_network");
        assert_eq!(calls[1], "ensure_key");
        assert_eq!(calls[2], "launch");
    }

    #[tokio::test]
    async fn a_failure_says_which_step_failed_and_keeps_the_clouds_own_words() {
        // Each step, refused in turn. "Something went wrong" would collapse
        // five different afternoons into one dead end.
        for (stage, step) in [
            (Stage::Network, ProvisionStep::Network),
            (Stage::Key, ProvisionStep::Key),
            (Stage::Launch, ProvisionStep::Launch),
        ] {
            let cloud = FakeCloud::new().refusing(stage, "Capacity", "there is none right now");
            let refused = create(&cloud, &plan(None), impatient()).await;
            let Err(ProvisionError::Step { step: failed, detail }) = refused else {
                panic!("{stage:?} was refused and the machine was made anyway");
            };
            assert_eq!(failed, step);
            assert_eq!(detail, "there is none right now");
            // And the sentence a person reads names the step in their terms.
            let told = ProvisionError::Step { step: failed, detail }.to_string();
            assert!(told.starts_with("Couldn't "), "{told}");
        }
    }

    #[tokio::test]
    async fn a_refusal_with_nothing_to_say_still_leaves_something_to_search_for() {
        let cloud = FakeCloud::new().refusing(Stage::Launch, "UnauthorizedOperation", "  ");
        let told = create(&cloud, &plan(None), impatient())
            .await
            .unwrap_err()
            .to_string();
        assert!(told.contains("UnauthorizedOperation"), "{told}");
    }

    #[tokio::test]
    async fn a_machine_that_is_still_starting_is_waited_for() {
        // The launch call answers before the box has an address. Handing that
        // answer back would produce a place with no host in it — a record every
        // surface accepts and nothing can dial.
        let cloud = FakeCloud::new().running_after(3);
        let made = create(&cloud, &plan(None), impatient()).await.expect("a machine");
        assert_eq!(made.address.expect("an address").host, FakeCloud::HOST);
        assert_eq!(cloud.describes(), 3);
    }

    #[tokio::test]
    async fn losing_the_cloud_while_waiting_is_its_own_step() {
        // The machine was made — the failure is that we stopped being able to
        // see it. Reported as a launch failure, somebody goes looking for a box
        // that is very probably running and billing.
        let cloud = FakeCloud::new().refusing(Stage::Describe, "Throttled", "slow down");
        let refused = create(&cloud, &plan(None), impatient()).await;
        let Err(ProvisionError::Step { step, detail }) = refused else {
            panic!("a cloud that stopped answering was reported as a made machine");
        };
        assert_eq!(step, ProvisionStep::Reach);
        assert_eq!(detail, "slow down");
    }

    #[tokio::test]
    async fn a_machine_that_never_comes_up_is_a_sentence_rather_than_a_spinner() {
        let cloud = FakeCloud::new().running_after(99);
        let refused = create(&cloud, &plan(None), impatient()).await;
        let Err(ProvisionError::Step { step, detail }) = refused else {
            panic!("a machine that never started was reported as made");
        };
        assert_eq!(step, ProvisionStep::Reach);
        assert!(detail.contains("try opening it again"), "{detail}");
    }

    #[tokio::test]
    async fn a_machine_that_died_on_the_way_up_is_not_waited_out() {
        // Waiting the full five minutes for a box that is already gone is five
        // minutes of somebody watching a spinner for nothing.
        let cloud = FakeCloud::new().dying();
        let refused = create(&cloud, &plan(None), impatient()).await;
        let Err(ProvisionError::Step { step, detail }) = refused else {
            panic!("a machine that ended was reported as made");
        };
        assert_eq!(step, ProvisionStep::Reach);
        assert!(detail.contains("before it was ready"), "{detail}");
        // One look, not four: the answer was already final.
        assert_eq!(cloud.describes(), 1);
    }

    #[tokio::test]
    async fn a_machine_that_runs_with_no_address_says_so_rather_than_saying_it_is_slow() {
        // A different afternoon: this one is a network setting nobody will fix
        // by waiting, so telling them to try again later is telling them wrong.
        let cloud = FakeCloud::new().addressless();
        let told = create(&cloud, &plan(None), impatient())
            .await
            .unwrap_err()
            .to_string();
        assert!(told.contains("no address"), "{told}");
    }

    #[tokio::test]
    async fn what_the_substrate_says_is_what_status_reports() {
        for (state, status) in [
            (InstanceState::Starting, TargetStatus::Provisioning),
            (InstanceState::Running, TargetStatus::Online),
            (InstanceState::Stopping, TargetStatus::Asleep),
            (InstanceState::Stopped, TargetStatus::Asleep),
            (InstanceState::Ending, TargetStatus::Terminating),
            (InstanceState::Gone, TargetStatus::Terminated),
        ] {
            let cloud = FakeCloud::new().sitting_at(state);
            let seen = look(&cloud, &InstanceId(FakeCloud::INSTANCE.into())).await;
            assert_eq!(seen.expect("a state"), status, "{state:?}");
        }
    }

    #[tokio::test]
    async fn a_stopped_machine_reads_as_asleep_and_not_as_one_that_stopped_answering() {
        // The bug this task exists to prevent, at the lowest level it can be
        // stated. `Offline` is a machine that should be answering and isn't —
        // somebody's afternoon. A machine Aura stopped because nobody was using
        // it is the feature working, and reported as `Offline` it is
        // indistinguishable from a broken box on every surface above.
        let cloud = FakeCloud::new().sitting_at(InstanceState::Stopped);
        let seen = look(&cloud, &InstanceId(FakeCloud::INSTANCE.into()))
            .await
            .expect("a state");
        assert_eq!(seen, TargetStatus::Asleep);
        assert_ne!(seen, TargetStatus::Offline);
    }

    #[tokio::test]
    async fn sleeping_a_machine_stops_it_and_never_ends_it() {
        // One keystroke apart in every cloud's API and opposite in effect. A
        // sleep that terminated would take the member's checkouts, their
        // uncommitted work and forty minutes of installed toolchain with it.
        let cloud = FakeCloud::new();
        create(&cloud, &plan(None), impatient()).await.expect("a machine");
        let now = sleep(&cloud, &InstanceId(FakeCloud::INSTANCE.into()))
            .await
            .expect("it sleeps");
        assert_eq!(now, TargetStatus::Asleep);
        assert!(cloud.calls().contains(&"stop".to_string()));
        assert!(
            !cloud.calls().contains(&"terminate".to_string()),
            "sleeping a place ended it: {:?}",
            cloud.calls()
        );
        // And the cloud agrees, rather than this being a note we kept about a
        // machine that is still running and billing.
        assert_eq!(
            look(&cloud, &InstanceId(FakeCloud::INSTANCE.into()))
                .await
                .expect("a state"),
            TargetStatus::Asleep
        );
    }

    #[tokio::test]
    async fn waking_answers_with_where_the_machine_is_now() {
        // A stopped machine gives up its public address and gets a different one
        // when it starts. A wake that answered "done" would leave the book
        // holding yesterday's host — a place that is up, billed, and unreachable.
        let cloud = FakeCloud::new();
        create(&cloud, &plan(None), impatient()).await.expect("a machine");
        sleep(&cloud, &InstanceId(FakeCloud::INSTANCE.into()))
            .await
            .expect("it sleeps");
        let host = wake(&cloud, &InstanceId(FakeCloud::INSTANCE.into()), impatient())
            .await
            .expect("it wakes");
        assert_eq!(host, FakeCloud::HOST);
        assert!(cloud.calls().contains(&"start".to_string()));
    }

    #[tokio::test]
    async fn a_machine_still_showing_as_stopped_is_not_a_failed_wake() {
        // A cloud can report the state a machine is LEAVING for a beat after it
        // has accepted the start. Read the way a fresh launch reads it, that is
        // "it stopped before it was ready" — a wake failed on the strength of the
        // one state a wake begins in.
        let cloud = FakeCloud::new().running_after(3);
        let host = wake(&cloud, &InstanceId(FakeCloud::INSTANCE.into()), impatient())
            .await
            .expect("a slow wake is still a wake");
        assert_eq!(host, FakeCloud::HOST);
    }

    #[tokio::test]
    async fn a_sleep_that_was_refused_says_which_step_it_was() {
        // Named apart from teardown because they send a person to different
        // places: one is a permission on stopping instances, the other on ending
        // them, and an account may well have exactly one of the two.
        let cloud = FakeCloud::new().refusing(Stage::Stop, "Denied", "you may not stop that");
        let refused = sleep(&cloud, &InstanceId(FakeCloud::INSTANCE.into())).await;
        let Err(ProvisionError::Step { step, detail }) = refused else {
            panic!("a refused sleep was reported as done");
        };
        assert_eq!(step, ProvisionStep::Sleep);
        assert_eq!(detail, "you may not stop that");

        let cloud = FakeCloud::new().refusing(Stage::Start, "Capacity", "there is none right now");
        let refused = wake(&cloud, &InstanceId(FakeCloud::INSTANCE.into()), impatient()).await;
        let Err(ProvisionError::Step { step, .. }) = refused else {
            panic!("a refused wake was reported as done");
        };
        assert_eq!(step, ProvisionStep::Wake);
    }

    #[tokio::test]
    async fn aura_ends_the_machines_it_made() {
        // The asymmetry the managed arm exists to close: Aura holds this box's
        // credential, so unlike a box you brought, it can stop paying for it.
        let cloud = FakeCloud::new();
        let made = create(&cloud, &plan(None), impatient()).await.expect("a machine");
        end(&cloud, &InstanceId(made.id.0)).await.expect("it ends");
        assert!(cloud.calls().contains(&"terminate".to_string()));
    }

    #[tokio::test]
    async fn failing_to_end_one_says_so_as_its_own_step() {
        let cloud = FakeCloud::new().refusing(Stage::Terminate, "Denied", "you may not do that");
        let refused = end(&cloud, &InstanceId(FakeCloud::INSTANCE.into())).await;
        let Err(ProvisionError::Step { step, .. }) = refused else {
            panic!("a refused teardown was reported as done");
        };
        assert_eq!(step, ProvisionStep::Teardown);
    }
}
