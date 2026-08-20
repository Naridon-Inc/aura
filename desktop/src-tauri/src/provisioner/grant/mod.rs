//! Machines the customer owns, in a cloud account the customer owns, that Aura
//! has been given a narrow role in.
//!
//! The third way of coming to have a place, and the one that exists to close a
//! gap rather than to open a market. A box somebody brought could not be put to
//! sleep — Aura held no credential for the account it runs in, so an idle
//! machine stayed up on its owner's bill and "walk away" cost real money. The
//! managed arm closed that by making the machine in Aura's own account, which
//! works and is not what everybody wants: plenty of teams have hardware, have a
//! cloud account, have spent a year on their network, and have no intention of
//! moving any of it.
//!
//! So: the metal stays theirs, the account stays theirs, the bill stays theirs,
//! and what Aura holds is a role in it that can do exactly three things —
//! [`permissions`] says which, says why, and says at length what it deliberately
//! cannot do. With that role present, sleep and wake work on their boxes on the
//! same code path as everything else, and the asymmetry stops being an
//! asymmetry. Without it, nothing changes and the surfaces go on saying so
//! honestly.
//!
//! ## How it is split
//!
//! * [`settings`] — what the customer wrote down, and the three answers to "has
//!   anybody granted anything here": no, badly, yes. **Absence is the switch.**
//! * [`permissions`] — the exact ask, as data, rendered into the document they
//!   paste. The list the code spends and the list they grant are the same list.
//! * [`handle`] — which account a machine's row belongs to, written on the row
//!   as `grant:<name>/…`, so one field says both which account and which machine.
//! * [`assume`] — the one call that crosses into their account, and the session
//!   it hands back.
//!
//! ## What this arm reuses rather than restates
//!
//! Everything below the driver seam. The customer's machines are EC2 machines,
//! stopped and started by the same signed requests
//! ([`crate::provisioner::managed::aws`]) as the ones Aura makes for itself —
//! the only difference is which credential signs them, which is the difference
//! this module exists to produce. Nothing here is a second transport, a second
//! parser or a second way of naming a machine's state, because a second one of
//! any of those is a place the two arms drift apart and only one of them gets
//! the fix.

pub(crate) mod assume;
pub(crate) mod handle;
pub(crate) mod permissions;
pub(crate) mod settings;

use std::sync::Arc;

use crate::provisioner::managed::aws::Ec2Driver;
use crate::provisioner::managed::driver::CloudDriver;
use settings::{Grant, AWS_EC2};

/// A way into the account this grant names, ready to stop and start machines in.
///
/// A sentence rather than a typed failure, because every caller is about to tell
/// somebody why a machine they can see will not sleep, and each of the three
/// ways this fails sends them somewhere different: the account is not set up on
/// this computer, this copy of Aura has no credentials to be recognised by, or
/// the account itself refused — in which case the account's own words come back
/// whole, since they are the ones that say whether it was the role, the id or
/// the trust policy.
pub(crate) async fn reach(name: &str) -> Result<Arc<dyn CloudDriver>, String> {
    let grant = settings::find(name)?;
    driver_for(&grant).await
}

/// Find the machine at an address in a granted account, and say which machine in
/// which account it is.
///
/// The call that turns "I have a box and an account Aura may act in" into a row
/// Aura can put to sleep. It is deliberately a lookup rather than a field to
/// type: the customer knows the address they connect to and has no reason to
/// know what their cloud calls the same box, and a handle typed by hand is a
/// handle that can name a different machine.
///
/// It is also the proof. Getting an answer at all means the role was assumed and
/// the account was read, so a grant that was set up wrongly says so while
/// somebody is still looking at the screen — rather than a fortnight later, the
/// first time a sleep is due.
pub(crate) async fn link(name: &str, address: &str) -> Result<String, String> {
    let grant = settings::find(name)?;
    let found = driver_for(&grant)
        .await?
        .locate(address.trim())
        .await
        .map_err(|refused| {
            format!(
                "Aura got into the account {:?} and couldn't look the machine up: {refused}",
                grant.name
            )
        })?;
    match found {
        Some(machine) => Ok(handle::qualify(&grant.name, machine.as_str())),
        // Worth its own sentence. Aura reached the account — so the role, the id
        // and the trust policy are all working — and the account holds no
        // running machine at that address. That is a typo or a stopped box, and
        // both are things the person reading this can fix.
        None => Err(format!(
            "Aura can act in the account {:?}, and nothing running in it answers on {}. \
             Check the address, and check the machine is switched on.",
            grant.name,
            address.trim()
        )),
    }
}

/// Which driver a grant asks for.
///
/// The same swap point [`crate::provisioner::managed`] has, guarded for the same
/// reason. [`settings`] refuses a cloud with no driver already, so this arm is
/// not reachable today — and it is what keeps a cloud added to that list and
/// forgotten here from falling through to the one driver that does exist, which
/// would send a stop into a cloud nobody chose.
async fn driver_for(grant: &Grant) -> Result<Arc<dyn CloudDriver>, String> {
    match grant.substrate.as_str() {
        AWS_EC2 => {
            let creds = assume::credentials_for(grant).await?;
            Ok(Arc::new(Ec2Driver::with_credentials(&grant.region, creds)))
        }
        other => Err(format!(
            "the account {:?} names a cloud called {other:?}, and Aura has no way to stop and \
             start machines there",
            grant.name
        )),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_cloud_with_no_driver_does_not_fall_through_to_the_one_that_exists() {
        // The guard that matters even though the settings reader refuses this
        // first: a cloud added there and forgotten here would send a stop into
        // whichever cloud happens to be first in the list.
        let elsewhere = Grant {
            name: "acme-eu".into(),
            substrate: "firecracker".into(),
            region: "eu-central-1".into(),
            role_arn: "arn:aws:iam::000000000000:role/AuraLifecycle".into(),
            external_id: "fixture-external-id-not-a-real-one".into(),
        };
        // No account is reached: the substrate is checked before anything is
        // signed, which is also why this test costs nothing and calls nowhere.
        let why = tokio::runtime::Builder::new_current_thread()
            .build()
            .expect("a runtime")
            .block_on(driver_for(&elsewhere))
            .err()
            .expect("no driver for that cloud");
        assert!(why.contains("firecracker"), "{why}");
        assert!(why.contains("acme-eu"), "{why}");
    }

    #[tokio::test]
    async fn an_account_nobody_set_up_is_a_sentence_rather_than_a_dead_end() {
        // The state every install is in, and the one a row can be in if a grant
        // is removed from the file while a machine still names it. It must read
        // as something a person can act on, because it is.
        let why = reach("nobody-configured-this")
            .await
            .err()
            .expect("no such account is set up");
        assert!(why.contains("nobody-configured-this"), "{why}");
        // And nothing was signed on the way to finding that out.
        assert!(!why.contains("signature"), "{why}");
    }
}
