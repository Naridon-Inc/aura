//! One list of places: the boxes this laptop can reach, and the ones your org
//! has, with a straight answer on each about whose it is.
//!
//! Until now these were two screens that never referred to each other. The
//! fleet page drew `machines_list` — the address book on this disk. The runner
//! board drew `cloud_runners` — the org's registry. Neither said anything about
//! the other, so a member who had been given a machine by their admin saw
//! nothing at all until somebody told them in Slack, and a box you had
//! connected yourself was indistinguishable from one the whole team is on.
//!
//! Three reads, folded into one answer:
//!
//! 1. the machine book, filtered to the org you are acting as ([`crate::cmd_machines`])
//! 2. the org's runner registry ([`crate::cmd_cloud_runners`])
//! 3. the org's member roster, to turn a `created_by` id into a name ([`members`])
//!
//! Only the first is required. The list of boxes you can definitely reach is a
//! file on this disk, and a laptop that is signed out, offline, or in an org
//! whose server is having a bad afternoon still gets it — with [`OrgHalf`]
//! saying, in the server's own words, why the other half is missing. A list
//! that failed whole when the network did would hide the machines you can reach
//! because we could not ask about the ones you might not have.
//!
//! ## What this does NOT do
//!
//! It does not write. Not to the book, not to the registry. The merge is at
//! READ time — see [`roster`] — so the `0600` machine book is exactly as
//! private after this feature as before it: nothing syncs it up, nothing pulls
//! the org's rows down into it, and no row this returns for a place you have
//! not connected carries a host, a login or a key path, because we do not have
//! one and inventing one is how a plausible value ends up in an ssh line.

pub(crate) mod members;
pub(crate) mod roster;

pub(crate) use roster::{OrgHalf, PlaceRoster};

use crate::cloud_org::active_org;
use crate::cloud_session_sync::{cloud_origin, cloud_token, read_credentials};

/// Every place you can work in, in one list.
///
/// Ordered the way the question is asked: the ones you can enter first, most
/// recently used first, then the org's places you would have to connect, live
/// ones first.
#[tauri::command]
pub async fn places_list() -> Result<PlaceRoster, String> {
    let book = crate::cmd_machines::visible_machines();

    // Reading the credentials file is the only thing here that can fail hard,
    // and a laptop that cannot read it is a laptop with no cloud account — which
    // is the signed-out case, not an error.
    let creds = read_credentials().unwrap_or_default();
    let active = active_org(&creds);
    let me = creds
        .get("cloud_user")
        .and_then(|v| v.as_str())
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(str::to_string);

    let Some(token) = cloud_token(&creds) else {
        // Nobody to ask as. The book is the whole list and it is complete.
        return Ok(only_the_book(&book, OrgHalf::signed_out(), me));
    };

    // Signed in, but with no org written down yet — a fresh pairing, or a
    // sign-in from before the switcher existed. That is *not* signed out, and
    // saying so hides every org place behind an instruction the user has
    // already followed. The account menu resolves this the moment somebody
    // opens it; asking the same question here means they don't have to.
    let (slug, name) = match active.slug.clone() {
        Some(slug) => (slug, active.name.clone()),
        None => match crate::cmd_cloud_orgs::cloud_orgs().await {
            // `cloud_orgs` ticks one org and writes the choice down, so this
            // costs a round trip exactly once per install rather than per read.
            Ok(orgs) => match orgs.into_iter().find(|o| o.current) {
                Some(org) => (org.slug, Some(org.name)),
                // Belonging to no org is impossible — every signup owns one —
                // so this is a shape we don't understand, not an empty account.
                None => return Ok(only_the_book(&book, OrgHalf::signed_out(), me)),
            },
            // We asked and could not get an answer. Say that, in the server's
            // own words, rather than blaming the user for not signing in.
            Err(detail) => {
                return Ok(only_the_book(
                    &book,
                    OrgHalf::unreachable(detail, None, None),
                    me,
                ))
            }
        },
    };

    let runners = match crate::cmd_cloud_runners::cloud_runners().await {
        Ok(rows) => rows,
        Err(detail) => {
            let org = OrgHalf::unreachable(detail, Some(slug), name);
            return Ok(only_the_book(&book, org, me));
        }
    };

    // Names for the ids on those rows. Best-effort: a roster that doesn't
    // answer costs a name, not a row.
    let origin = cloud_origin(&creds);
    let directory = members::directory(&origin, &token, &slug, me).await;

    let org = OrgHalf {
        status: "ok".into(),
        detail: String::new(),
        slug: Some(slug),
        name,
        my_role: directory.my_role.clone(),
    };
    Ok(PlaceRoster {
        places: roster::merge(&book, &runners, &org, &directory),
        org,
    })
}

/// The list with nothing from the org in it, and the reason why.
///
/// Every early return above is the same shape — the book is answerable from
/// this disk and stays whole, and only the org half carries the bad news. One
/// helper so a new reason cannot accidentally drop the boxes with it.
fn only_the_book(
    book: &[crate::cmd_machines::Machine],
    org: OrgHalf,
    me: Option<String>,
) -> PlaceRoster {
    PlaceRoster {
        places: roster::merge(
            book,
            &[],
            &org,
            &roster::Directory {
                me,
                ..Default::default()
            },
        ),
        org,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The three states the list can be in are three states, not two — and the
    /// difference between them is the difference between "you have no team
    /// machines" and "we could not find out".
    #[test]
    fn the_org_half_says_which_of_the_three_it_is() {
        assert_eq!(OrgHalf::signed_out().status, "signed_out");
        let down = OrgHalf::unreachable("Connection refused", Some("naridon".into()), None);
        assert_eq!(down.status, "unreachable");
        // Verbatim, because "Connection refused" says what to do next and
        // "something went wrong" does not.
        assert_eq!(down.detail, "Connection refused");
        assert_eq!(down.slug.as_deref(), Some("naridon"));
    }

    /// Signed out is a complete answer, not a degraded one: every box you can
    /// actually reach is still on the list, and it still says whose each is.
    #[test]
    fn signed_out_still_lists_the_boxes_on_this_laptop() {
        let book = vec![crate::cmd_machines::Machine {
            id: "ubuntu@10.0.0.4:/srv/alpha".into(),
            name: "my-box".into(),
            host: "10.0.0.4".into(),
            user: "ubuntu".into(),
            key_path: "/Users/me/.ssh/aura.pem".into(),
            box_kind: "mine".into(),
            repo_path: Some("/srv/alpha".into()),
            project_root: None,
            repo_branch: None,
            org_slug: None,
            forward_agent: false,
            instance_id: None,
            asleep_since: 0,
            added_at: 1,
            last_used_at: 2,
        }];
        let rows = roster::merge(
            &book,
            &[],
            &OrgHalf::signed_out(),
            &roster::Directory::default(),
        );
        assert_eq!(rows.len(), 1);
        assert_eq!(rows[0].owner.label, "You");
        assert!(rows[0].may.open);
    }

    /// A signed-in account whose org we could not resolve is *not* signed out.
    ///
    /// The two read the same on screen if you only look at the boxes — the book
    /// survives either way — but the banner above them is the difference
    /// between "sign in" (which the user already did, so nothing they do next
    /// helps) and the server's own reason. Told wrongly, every org place stays
    /// hidden behind an instruction that has already been followed.
    #[test]
    fn a_signed_in_account_we_couldnt_resolve_is_not_signed_out() {
        let book = vec![a_box()];
        let unresolved = only_the_book(
            &book,
            OrgHalf::unreachable("Connection refused", None, None),
            Some("mo".into()),
        );
        assert_eq!(unresolved.org.status, "unreachable");
        assert_ne!(unresolved.org.status, OrgHalf::signed_out().status);
        assert_eq!(unresolved.org.detail, "Connection refused");
        // No slug, because we genuinely do not have one — inventing a plausible
        // value here is how a wrong org ends up stamped on a later request.
        assert!(unresolved.org.slug.is_none());
        // And the reason it is worth distinguishing at all: the boxes on this
        // disk are still every bit as reachable as they were.
        assert_eq!(unresolved.places.len(), 1);
        assert!(unresolved.places[0].may.open);
    }

    /// Whatever went wrong with the org, the book is answerable from this disk
    /// and stays whole. One helper, so a new early return cannot drop it.
    #[test]
    fn every_reason_the_org_half_fails_keeps_the_whole_book() {
        let book = vec![a_box()];
        for org in [
            OrgHalf::signed_out(),
            OrgHalf::unreachable("Connection refused", None, None),
            OrgHalf::unreachable("HTTP 500", Some("mhask".into()), None),
        ] {
            let roster = only_the_book(&book, org.clone(), None);
            assert_eq!(roster.places.len(), 1, "{} dropped the book", org.status);
            assert_eq!(roster.org, org);
        }
    }

    fn a_box() -> crate::cmd_machines::Machine {
        crate::cmd_machines::Machine {
            id: "ubuntu@10.0.0.4:/srv/alpha".into(),
            name: "my-box".into(),
            host: "10.0.0.4".into(),
            user: "ubuntu".into(),
            key_path: "/Users/me/.ssh/aura.pem".into(),
            box_kind: "mine".into(),
            repo_path: Some("/srv/alpha".into()),
            project_root: None,
            repo_branch: None,
            org_slug: None,
            forward_agent: false,
            instance_id: None,
            asleep_since: 0,
            added_at: 1,
            last_used_at: 2,
        }
    }
}
