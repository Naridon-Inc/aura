//! Have Aura make the machine.
//!
//! The other way into a place is [`crate::cmd_remote_connect`]: you already own
//! a Linux box, you type its address, Aura mints a token for it. This is the
//! same destination reached from the other side — an admin names a place, picks
//! how big it should be, and a machine exists that nobody had to buy, install or
//! hold a key for.
//!
//! Both arrive at the same thing. A place is a row on the org's board with an
//! address on it, and every surface in the app reaches one through
//! [`crate::manager::brain::place`] regardless of who made it. What differs is
//! only the four things a place-mode is allowed to differ on: who created the
//! machine, where its address lives, who holds the key, and who gets the bill.
//! This module is the "who created it" half of that answer, and it deliberately
//! produces the same row the other half does.
//!
//! ## The order matters, because one of these steps costs money
//!
//! ```text
//!   authority   who am I in this org?          — free, and asked first
//!   readiness   can this install make one?     — free, local
//!   provision   a machine now exists           — BILLED FROM HERE
//!   list_it     the org gets a place           — the real gate
//!   record      this laptop can dial it        — local
//! ```
//!
//! The gate that counts is `list_it`: `POST /api/v2/runners` runs
//! `runners::require_org_admin` against the database at request time, and
//! nothing on this laptop can talk it out of a 403. But it is also the step that
//! comes *after* a machine has been started, so asking it first would mean a
//! member's mistake gets billed to their org. Hence [`authority`], which asks
//! the same question of the same roster before anything is spent.
//!
//! Two checks means a window — somebody demoted between them — and that window
//! is closed by compensation rather than by a lock: a refusal at `list_it` tears
//! the machine back down (see [`unmake`]) before the error is returned. The
//! admin who was refused is not left holding a running box.
//!
//! ## What does not come back
//!
//! No host, no login, no key. A managed place's address lives on the org's board
//! and its key is held by the server, and the whole promise of the mode is that
//! the member never handles either. Returning them here so a wizard could print
//! "your machine is at …" would put an address into the renderer, into a log
//! line and eventually into a screenshot, and would make the mode's one
//! guarantee a matter of what the frontend remembers not to draw.

pub mod authority;
pub mod board;
pub mod entitled;
pub mod sizes;

use serde::Serialize;

use crate::provisioner::{
    provisioner_for, ProvisionKind, ProvisionSpec, ProvisionedTarget, Provisioner, TargetId,
};

/// Everything the surface needs to draw the offer, in one call.
///
/// One call rather than four, because every one of these can refuse and a
/// wizard that asked separately would have four independent loading states
/// racing each other into four different half-drawn panels.
#[derive(Debug, Clone, Serialize)]
pub struct MakeOffer {
    /// Whether the button does anything. False means [`MakeOffer::reason`] and
    /// [`MakeOffer::blocked`] say what to do instead.
    pub can_make: bool,
    /// `ready` when it can. Otherwise the machine-readable half of the refusal:
    /// `signed_out` | `no_org` | `unknown_role` | `not_admin` | `not_offered`.
    pub reason: String,
    /// The sentence a person reads. Empty when nothing is blocking.
    pub blocked: String,
    /// What to call the team on screen, when we got far enough to know.
    pub org: String,
    /// The sizes on offer, so the picker cannot invent one.
    pub sizes: Vec<sizes::Size>,
    /// Who will be able to open it. Absent when we never got as far as asking —
    /// which is every refusal, since there is no team to ask about.
    pub entitled: Option<entitled::Entitled>,
}

impl MakeOffer {
    /// A refusal, with the sizes still attached.
    ///
    /// The picker is drawn either way. A wizard that showed an empty panel to
    /// somebody who is not an admin tells them nothing about what they are
    /// missing out on, and the sizes are public information — the refusal is
    /// about making one, not about knowing what could be made.
    fn barred(reason: &str, blocked: impl Into<String>, org: impl Into<String>) -> Self {
        Self {
            can_make: false,
            reason: reason.to_string(),
            blocked: blocked.into(),
            org: org.into(),
            sizes: sizes::SIZES.to_vec(),
            entitled: None,
        }
    }
}

/// A place that now exists.
#[derive(Debug, Clone, Serialize)]
pub struct MadePlace {
    /// The org board row. The place id every other surface holds.
    pub place_id: String,
    /// This laptop's book row, so the surface can open it without a reload.
    pub machine_id: String,
    /// The name as it was recorded — trimmed, and the one the board matches on.
    pub name: String,
    /// The one-time runner credential. See [`board::Listed::runner_token`].
    pub runner_token: String,
    /// Who could open it at the moment it was made.
    pub entitled: entitled::Entitled,
    /// A thing that went wrong after the place was already real, in words.
    ///
    /// Empty on a clean run. The one case is the local book write: by then the
    /// org has its place and every member can see it, and failing the whole call
    /// would tell the admin nothing was made when something was.
    pub note: String,
}

/// What can be offered here, and to whom.
#[tauri::command]
pub async fn place_make_offer() -> Result<MakeOffer, String> {
    // Local and free, and the one refusal that is about this build rather than
    // about this person — so it is worth knowing before we go and ask an org
    // anything about them.
    if let Err(why) = provisioner_for(ProvisionKind::Managed).readiness() {
        return Ok(MakeOffer::barred("not_offered", why.to_string(), ""));
    }

    let standing = match authority::standing().await {
        Ok(standing) => standing,
        Err(barred) => return Ok(MakeOffer::barred(barred.reason, barred.said, "")),
    };
    let org = standing.org_label();
    let entitled = entitled::in_org(&standing.origin, &standing.token, &standing.slug).await;

    Ok(MakeOffer {
        can_make: true,
        reason: "ready".into(),
        blocked: String::new(),
        org,
        sizes: sizes::SIZES.to_vec(),
        entitled: Some(entitled),
    })
}

/// Make one.
///
/// `size` is one of the ids in [`sizes::SIZES`]. An unrecognised one is refused
/// rather than rounded to the suggestion — the alternative bills somebody for a
/// machine they did not pick.
#[tauri::command]
pub async fn place_make(name: String, size: String) -> Result<MadePlace, String> {
    let named = name.trim().to_string();
    if named.is_empty() {
        return Err("Give the machine a name first.".into());
    }
    let class = sizes::class_of(&size)?;

    // Before anything is spent.
    let standing = authority::standing().await.map_err(|barred| barred.said)?;

    let maker = provisioner_for(ProvisionKind::Managed);
    maker.readiness().map_err(|e| e.to_string())?;

    // From here a machine exists and is being billed.
    let target = maker
        .provision(ProvisionSpec {
            kind: ProvisionKind::Managed,
            name: named.clone(),
            // Org-wide. A team's machine that was filed under whichever repo the
            // admin happened to have open would be invisible to the half of the
            // team working on something else.
            repo: None,
            class: Some(class),
        })
        .await
        .map_err(|e| e.to_string())?;

    let Some(address) = target.address.clone() else {
        // A managed backend that made a machine and cannot say where it is has
        // left one running with no way to reach it or bill it back. Tear down on
        // the handle we do have.
        unmake(maker.as_ref(), &target).await;
        return Err(
            "Aura made a machine but couldn't say where it is, so it removed it again. \
             Try once more."
                .into(),
        );
    };

    // The gate that counts.
    let listed = match board::list_it(&standing.origin, &standing.token, &named, &address).await {
        Ok(listed) => listed,
        Err(not_listed) => {
            if not_listed.definitely_refused {
                unmake(maker.as_ref(), &target).await;
            }
            return Err(not_listed.said);
        }
    };

    let entitled = entitled::in_org(&standing.origin, &standing.token, &standing.slug).await;

    // Local, and last. The place is already real for the whole org by now; this
    // is only what lets THIS laptop dial it without connecting it first.
    let (machine_id, note) = match crate::cmd_machines::record_made_machine(
        &named,
        &address.host,
        &address.ssh_user,
        &address.key_ref,
        address.repo_path.as_deref(),
        target.id.as_str(),
    ) {
        Ok(machine) => (machine.id, String::new()),
        Err(why) => (
            String::new(),
            format!(
                "The machine is made and on {}'s board. This laptop couldn't save its address, \
                 so open it from the places list to connect: {why}",
                standing.org_label()
            ),
        ),
    };

    Ok(MadePlace {
        place_id: listed.place_id,
        machine_id,
        name: named,
        runner_token: listed.runner_token,
        entitled,
        note,
    })
}

/// Give back a machine the org never got to own.
///
/// Best-effort by necessity: the only alternative to trying is leaving a box
/// running that nobody has a row for, which costs money nobody authorised and
/// appears on no board where somebody could find and stop it. A teardown that
/// itself fails has nothing left to escalate to from here — the machine is in
/// the substrate's own console with the name the admin typed, and the error the
/// caller is about to read is the one that explains why they should look.
async fn unmake(maker: &dyn Provisioner, target: &ProvisionedTarget) {
    let id = TargetId(target.id.0.clone());
    if let Err(why) = maker.teardown(&id).await {
        // Not the user's sentence — this is the operator's. It names no address
        // and no key, only the substrate's own handle, which is what somebody
        // cleaning up by hand would search for.
        eprintln!("place_make: couldn't remove the machine it had just made: {why}");
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The refusal a surface gets has to be drawable. Every one carries a
    /// machine-readable reason AND a sentence, and still offers the sizes —
    /// a person who cannot make one is better served by seeing what they would
    /// be asking an admin for than by an empty panel.
    #[test]
    fn every_refusal_is_something_a_surface_can_draw() {
        for (reason, said) in [
            ("not_offered", "Aura isn't set up to make machines on this install."),
            ("signed_out", "Sign in to Aura and it can make a machine for your team."),
            ("no_org", "Pick which team you're working as first."),
            ("unknown_role", "Aura couldn't check whether you run Naridon."),
            ("not_admin", "Only an owner or admin of Naridon can."),
        ] {
            let offer = MakeOffer::barred(reason, said, "Naridon");
            assert!(!offer.can_make);
            assert!(!offer.reason.is_empty());
            assert!(!offer.blocked.is_empty());
            assert_eq!(offer.sizes.len(), sizes::SIZES.len());
            // Nobody to ask about, and an empty list of entitled members would
            // read as "your team has nobody" rather than "we never asked".
            assert!(offer.entitled.is_none());
        }
    }

    /// `ready` is the one reason that means the button works, and it must not
    /// collide with a refusal — a surface that branched on the string would
    /// otherwise open the wizard for somebody who had just been refused.
    #[test]
    fn the_ready_reason_is_not_also_a_refusal() {
        let refusals = ["not_offered", "signed_out", "no_org", "unknown_role", "not_admin"];
        assert!(!refusals.contains(&"ready"));
        for reason in refusals {
            assert!(!MakeOffer::barred(reason, "why", "Naridon").can_make);
        }
    }

    /// A machine nobody named is indistinguishable from every other one in the
    /// picker, and the refusal is the same sentence the BYO wizard gives — one
    /// rule about names, said once, whoever made the box.
    #[tokio::test]
    async fn a_machine_with_no_name_is_refused_before_anything_is_spent() {
        let told = place_make("   ".into(), "medium".into()).await.unwrap_err();
        assert_eq!(told, "Give the machine a name first.");
    }

    /// The size is validated before the org is asked and long before anything is
    /// made, because a typo that reached the substrate would either bill for a
    /// size nobody picked or fail after a machine had started.
    #[tokio::test]
    async fn a_size_nobody_offers_is_refused_before_anything_is_spent() {
        let told = place_make("design-box".into(), "enormous".into())
            .await
            .unwrap_err();
        assert!(told.contains("enormous"), "{told}");
    }

    /// The offer answers on every install, including one with no managed cloud
    /// set up and one that is signed out. A surface that got an `Err` here would
    /// have to draw an error where the honest answer is a refusal with a reason
    /// somebody can act on.
    #[tokio::test]
    async fn the_offer_always_answers() {
        let offer = place_make_offer().await.expect("the offer never errors");
        assert!(!offer.reason.is_empty());
        assert_eq!(offer.sizes.len(), 4);
        if !offer.can_make {
            assert!(!offer.blocked.is_empty(), "refused without saying why");
        }
    }
}
