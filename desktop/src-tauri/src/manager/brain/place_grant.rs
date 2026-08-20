//! Letting Aura switch off a machine you own, in an account you own.
//!
//! The surface over [`crate::provisioner::grant`], and the point at which the
//! lifecycle asymmetry actually stops being one for a member. Everything else in
//! the sleep programme reads a machine's row and acts; this is the one place a
//! row *gains* the permission those readers are looking for.
//!
//! Three commands, and the order they are used in is the order they are written:
//!
//! * [`place_grant_offer`] — what Aura is asking for, what it deliberately is
//!   not, and which accounts this laptop already knows about. Read-only, reaches
//!   nothing, and safe to draw on a settings pane that nobody has decided
//!   anything on yet.
//! * [`place_grant_link`] — the customer has made the role; connect this machine
//!   to that account. It is where the grant is *proved*, and it writes nothing
//!   down until it is.
//! * [`place_grant_unlink`] — take the permission back.
//!
//! ## Linking proves before it records
//!
//! The tempting version of linking is a form: pick an account, save. It would
//! work, and every one of its failures would arrive weeks later as a machine
//! that quietly never slept — because the trust policy had a typo in it, or the
//! external id did not match, or the tag was never put on the box. Nothing about
//! that is discoverable from the row.
//!
//! So linking goes and looks. It assumes the role, asks the account which
//! machine answers on the address this laptop already has for the place, and
//! only then writes the handle down. A grant set up wrongly says so while
//! somebody is still on the screen where they can fix it, and the handle that
//! lands on the row is one the account itself named rather than one a person
//! typed.
//!
//! ## Unlinking will not strand a sleeping machine
//!
//! Waking is the same permission as sleeping, read the same way — so removing a
//! grant from a machine that is currently asleep would leave a stopped box that
//! nothing here can start, and the member would have to go to their own console
//! to get their work back. [`place_grant_unlink`] refuses that and says why.
//! It is the one asymmetry between the two directions, and it exists because the
//! two directions are not symmetrical in what they cost somebody.

use serde::Serialize;

use crate::provisioner::grant::{self, permissions::Ask, settings::Granted};

use super::place::Place;
use super::place_sleep::{place_sleeping, Sleeping};

/// One cloud account this laptop knows Aura may act in.
///
/// Deliberately not the [`grant::settings::Grant`] itself: that holds the
/// external id, and the external id is the shared secret this whole arrangement
/// rests on. What a surface needs is which accounts exist and enough to
/// recognise them by, which is this.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct Account {
    /// What it is called here, and what goes on a machine's row.
    pub name: String,
    /// Which cloud.
    pub cloud: String,
    /// Where the machines are.
    pub region: String,
    /// The account the role lives in, read out of the role's own name — so what
    /// is shown is the account the requests are really made against.
    pub number: String,
}

/// Everything a surface needs to draw the ask and the state of it.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct Offer {
    /// The permissions, the refusals, the tag and the document to paste.
    pub ask: Ask,
    /// The accounts already set up here. Empty on every install where nobody has
    /// granted anything, which is the shipping default and not a problem.
    pub accounts: Vec<Account>,
    /// Something is written down and does not add up, in the words of whatever
    /// is wrong with it. Kept apart from an empty list because "nobody has done
    /// this yet" and "somebody did this and got it wrong" send a person to
    /// completely different places.
    pub trouble: Option<String>,
}

/// What Aura is asking for in somebody else's account, and what it already has.
///
/// Reads one file on this disk and reaches nothing — no role is assumed to
/// answer it, because a pane that cost a signed request every time it was drawn
/// would be a pane nobody could leave open.
#[tauri::command]
pub async fn place_grant_offer() -> Result<Offer, String> {
    let (accounts, trouble) = match grant::settings::configured() {
        Granted::Absent => (vec![], None),
        Granted::Broken(why) => (vec![], Some(why)),
        Granted::Ready(grants) => (
            grants
                .iter()
                .map(|g| Account {
                    name: g.name.clone(),
                    cloud: g.substrate.clone(),
                    region: g.region.clone(),
                    number: g.account().to_string(),
                })
                .collect(),
            None,
        ),
    };
    Ok(Offer {
        ask: grant::permissions::ask(),
        accounts,
        trouble,
    })
}

/// Connect this machine to an account Aura may act in, and prove it.
///
/// Answers with the place's sleep report rather than an acknowledgement, because
/// the whole visible consequence of linking is that the report changes: a place
/// that said Aura holds no account which could stop it now says it will be put
/// to sleep when nobody is using it. Handing back the same shape every other
/// sleep surface reads means the pane that called this can redraw from the
/// answer instead of asking again.
#[tauri::command]
pub async fn place_grant_link(machine_id: String, account: String) -> Result<Sleeping, String> {
    let place = Place::at_machine(&machine_id)?;
    let account = account.trim();
    if account.is_empty() {
        return Err("Pick which of your cloud accounts this machine is in.".to_string());
    }
    // The address the book already holds, rather than one typed again. It is
    // what this laptop connects to, so a machine found by it is the machine on
    // screen — where a second address, typed a second time, is a second chance
    // to name somebody else's box.
    let Some(address) = place.identity().host.filter(|h| !h.trim().is_empty()) else {
        return Err(
            "Work here runs on your own computer, and there's no cloud account that could \
             switch it off."
                .to_string(),
        );
    };

    // Nothing is written down until the account has been reached and has named
    // the machine itself. A row saved on the strength of a form would fail
    // weeks later as a place that quietly never sleeps.
    let handle = grant::link(account, &address).await?;
    crate::cmd_machines::set_granted_handle(&machine_id, Some(&handle))?;
    place_sleeping(None, Some(machine_id)).await
}

/// Take the permission back.
///
/// The metal was always the customer's and nothing about the machine changes —
/// what stops is Aura offering to switch it off. Refused for a place that is
/// asleep right now, because starting one is the same permission as stopping it
/// and removing it mid-sleep would leave a stopped box this laptop cannot get
/// back.
#[tauri::command]
pub async fn place_grant_unlink(machine_id: String) -> Result<Sleeping, String> {
    let place = Place::at_machine(&machine_id)?;
    let now = place_sleeping(None, Some(machine_id.clone())).await?;
    if now.state == "asleep" {
        return Err(format!(
            "{} is asleep right now. Start it first — once Aura can't switch it on any more, \
             getting it back is something you'd have to do in your own cloud console.",
            place.label()
        ));
    }
    crate::cmd_machines::set_granted_handle(&machine_id, None)?;
    place_sleeping(None, Some(machine_id)).await
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn the_ask_is_drawable_before_anybody_has_granted_anything() {
        // The state every install ships in. It must produce a whole offer — the
        // permissions, the refusals and the document — because that is what
        // somebody reads while deciding, and an empty list of accounts is the
        // ordinary case rather than a fault.
        let offer = place_grant_offer().await.expect("an offer");
        assert!(!offer.ask.needed.is_empty());
        assert!(!offer.ask.withheld.is_empty());
        assert!(offer.ask.policy.contains("ec2:StopInstances"), "{}", offer.ask.policy);
        // Whatever this developer's laptop happens to have set up, the two
        // states stay apart: accounts and trouble are never both populated.
        assert!(offer.accounts.is_empty() || offer.trouble.is_none());
    }

    #[tokio::test]
    async fn nothing_a_surface_is_handed_carries_the_shared_secret() {
        // The external id is what stops another Aura install being talked into
        // acting on this account. It is read from a file on this disk and it
        // stops there — an offer crosses to the frontend, and things that cross
        // to the frontend end up in logs, screenshots and bug reports.
        let offer = place_grant_offer().await.expect("an offer");
        let printed = serde_json::to_string(&offer).expect("an offer is serialisable");
        assert!(!printed.contains("external_id"), "{printed}");
        assert!(!printed.contains("externalId"), "{printed}");
    }

    #[tokio::test]
    async fn a_machine_nobody_has_heard_of_is_a_sentence_rather_than_a_write() {
        // Both verbs go through `Place` first, so an id that names nothing is
        // refused before an account is reached or the book is touched.
        let linked = place_grant_link("no-such-machine".into(), "acme-eu".into()).await;
        assert!(linked.is_err(), "a machine that does not exist was linked");
        let unlinked = place_grant_unlink("no-such-machine".into()).await;
        assert!(unlinked.is_err());
    }

    #[tokio::test]
    async fn linking_without_saying_which_account_says_so_before_reaching_anywhere() {
        let why = place_grant_link("no-such-machine".into(), "   ".into())
            .await
            .err()
            .expect("an empty account is refused");
        // The machine is checked first, so this is the book's complaint rather
        // than the account one — what matters is that neither reached a cloud.
        assert!(!why.is_empty());
        assert!(!why.contains("signature"), "{why}");
    }
}
