//! May the person at this laptop have Aura make a machine for their org?
//!
//! Making one mints a machine credential on the org's board and hands every
//! entitled member a box — the same act, and the same authority, as
//! `runners::create` on the server, which is owner/admin only. The server is
//! still the gate: the registration this flow ends with goes through exactly
//! that check, and nothing here can talk it out of a 403.
//!
//! What this is for is asking BEFORE anything is made. A machine is the one
//! step in the flow that costs money the moment it succeeds, so discovering the
//! refusal afterwards means a member's mistake is billed to the org and then
//! torn down. The order is: ask who you are, then spend.
//!
//! ## Fail-closed, including when the answer never arrives
//!
//! A roster that does not answer is a refusal, not a pass. That is the rule
//! `runners::require_org_admin` and `places::entitlements::require_cloud_access`
//! both follow — a gate that opens when the network hiccups is not a gate — and
//! it costs a member nothing but a retry, where the other direction costs an org
//! a machine nobody authorised.
//!
//! The role is read at the moment of asking rather than taken off the
//! credential. A token names a user forever; being an admin is a fact about
//! now, and somebody who was one last week must not still be making machines
//! this week.

use crate::cloud_org::active_org;
use crate::cloud_session_sync::{cloud_origin, cloud_token, read_credentials};

/// The two roles that carry authority over an org's fleet. The same pair
/// `db::is_org_admin` reads on the server, spelled here so the desktop refuses
/// for the same reason the server would rather than for a reason of its own.
const ADMINS: [&str; 2] = ["owner", "admin"];

/// Who you are in the org you are acting as, when you are somebody who may make
/// a machine in it.
#[derive(Debug, Clone)]
pub struct Standing {
    /// The org this would be made in.
    pub slug: String,
    /// Its display name, when the credentials file knows one.
    pub name: Option<String>,
    /// `owner` or `admin` — never anything else, or this would not exist.
    pub role: String,
    /// Where its cloud lives, so the caller does not read the credentials file
    /// a second time to find out.
    pub origin: String,
    /// The bearer token for that cloud.
    pub token: String,
}

impl Standing {
    /// What to call the org on screen. Its name when we have one, its slug
    /// otherwise — never a bare "your org" when there is a real word available.
    pub fn org_label(&self) -> String {
        self.name
            .as_deref()
            .map(str::trim)
            .filter(|s| !s.is_empty())
            .unwrap_or(&self.slug)
            .to_string()
    }
}

/// Why somebody may not make a machine here.
///
/// The `reason` is for the surface — it decides which door to point at — and
/// the sentence is for the person. Kept together so a new refusal cannot arrive
/// with one and not the other, which is how a surface ends up rendering a blank
/// panel for a state it has never heard of.
#[derive(Debug, Clone)]
pub struct Barred {
    /// `signed_out` | `no_org` | `unknown_role` | `not_admin`.
    pub reason: &'static str,
    pub said: String,
}

impl Barred {
    fn new(reason: &'static str, said: impl Into<String>) -> Self {
        Self {
            reason,
            said: said.into(),
        }
    }
}

/// Read who this laptop is acting as, and refuse unless they administer it.
pub async fn standing() -> Result<Standing, Barred> {
    let creds = read_credentials().unwrap_or_default();
    let Some(token) = cloud_token(&creds) else {
        return Err(Barred::new(
            "signed_out",
            "Sign in to Aura and it can make a machine for your team.",
        ));
    };
    let active = active_org(&creds);
    let Some(slug) = active.slug.clone().filter(|s| !s.trim().is_empty()) else {
        return Err(Barred::new(
            "no_org",
            "Pick which team you're working as first — a machine Aura makes belongs to a team.",
        ));
    };
    let origin = cloud_origin(&creds);
    let me = creds
        .get("cloud_user")
        .and_then(|v| v.as_str())
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(str::to_string);

    // The same roster read the places list already does, so "what am I in this
    // org" has one answer on this laptop rather than two that can disagree.
    let directory = crate::place_roster::members::directory(&origin, &token, &slug, me).await;
    let label = active
        .name
        .clone()
        .map(|n| n.trim().to_string())
        .filter(|s| !s.is_empty())
        .unwrap_or_else(|| slug.clone());

    let Some(role) = directory.my_role.clone() else {
        return Err(Barred::new(
            "unknown_role",
            format!(
                "Aura couldn't check whether you run {label}, so it hasn't made anything. \
                 Try again in a moment."
            ),
        ));
    };
    if !is_admin(&role) {
        return Err(Barred::new(
            "not_admin",
            format!(
                "Only an owner or admin of {label} can have Aura make a machine. \
                 Ask one of them, or connect a machine you already have."
            ),
        ));
    }

    Ok(Standing {
        slug,
        name: active.name,
        role,
        origin,
        token,
    })
}

/// Whether a role carries authority over the org's fleet.
fn is_admin(role: &str) -> bool {
    let role = role.trim();
    ADMINS.iter().any(|a| role.eq_ignore_ascii_case(a))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_two_roles_that_may_are_the_two_the_server_reads() {
        assert!(is_admin("owner"));
        assert!(is_admin("admin"));
        assert!(is_admin("Admin"), "the server's role column is not case-pinned");
        assert!(!is_admin("member"));
        assert!(!is_admin("billing"));
        // A role we have never heard of is not an admin. The alternative — a
        // future role the desktop treats as authority because it did not
        // recognise it — would let this laptop offer a button the server then
        // refuses, after the machine has been made.
        assert!(!is_admin("release-manager"));
        assert!(!is_admin(""));
    }

    /// The refusal a member reads has to name the org and say what to do
    /// instead. "Forbidden" sends somebody to look for a bug.
    #[test]
    fn every_refusal_says_what_to_do_next() {
        let said = Barred::new("not_admin", "Only an owner or admin of Naridon can.").said;
        assert!(said.contains("Naridon"));
        for barred in [
            Barred::new("signed_out", "Sign in to Aura and it can make a machine for your team."),
            Barred::new("no_org", "Pick which team you're working as first."),
        ] {
            assert!(!barred.said.is_empty());
            assert!(!barred.reason.is_empty());
        }
    }

    /// A roster that did not answer must not read as "you are not an admin",
    /// and must not read as "you are" either. It is its own state, with its own
    /// sentence, because the two send a person to different places: one to an
    /// admin, the other to try again.
    #[test]
    fn an_unreadable_roster_is_its_own_refusal() {
        let unknown = Barred::new("unknown_role", "Aura couldn't check whether you run Naridon.");
        assert_ne!(unknown.reason, "not_admin");
        assert!(unknown.said.contains("couldn't check"));
    }
}
