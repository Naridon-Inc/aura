//! Which org you are acting as.
//!
//! An Aura account is not one team. Every signup already owns an org — the
//! server mints `"{username} team"` on registration and on all three OAuth
//! callbacks — and joining a company's org adds a second, a contractor's a
//! third. `repos.org_id` is `NOT NULL`, so every project belongs to exactly one
//! of them and *personal is simply an org of one*. There is no org-less state
//! to model, and no user with only one org by construction.
//!
//! The desktop had none of that. `~/.aura/credentials.json` held a single
//! `cloud_org_slug`, written once by the pairing exchange and read in exactly
//! one place — a subtitle under your name in the account menu. Nothing sent it
//! anywhere. Changing which org you were acting as meant signing out, which
//! re-resolves from the server and lands you wherever it lands you. That is not
//! a switcher; it is a coin toss with a re-authentication attached.
//!
//! This module is the answer to "who am I right now", and it has three jobs:
//!
//! * [`active_org`] — read the choice back off the credentials file.
//! * [`remember_org`] — write a new one, so it survives a restart.
//! * [`OrgScoped`] — put it on the wire, so every cloud call says who is asking.
//!
//! ## Why the header goes on *every* call, not just the org-shaped ones
//!
//! The alternative is each call site deciding whether its endpoint is
//! org-scoped, and that decision going stale the moment the server changes its
//! mind. A bearer token names a *user*; the header names which of that user's
//! hats they are wearing, which is information no token can carry and no
//! endpoint is worse off for having. It costs one header, and it means the day
//! the server starts honouring it, every desktop that ever shipped this is
//! already telling it the truth.
//!
//! There is exactly one exception, and it is the one that proves the rule:
//! `GET /api/v2/repos`. That call is how the app learns which orgs exist at
//! all, so scoping it to the org you are already in would answer "your orgs
//! are: the one you cannot leave". Both readers of it — [`crate::cmd_cloud_orgs`]
//! and the job board's name index — send no header and narrow the rows here
//! instead, where the rule is visible.
//!
//! ## The grouping is here and the request is next door
//!
//! [`orgs_from_repos`] is a pure function over rows, so the rule that decides
//! what you are offered and which one is ticked is testable without a network
//! anywhere near it. The one call that fetches those rows lives in
//! [`crate::cmd_cloud_orgs`], which is also where the Tauri commands are.

use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::cloud_session_sync::{read_credentials, write_credentials};

/// The header that carries the org on every cloud request.
///
/// A slug rather than an id: it is what the server's own `/orgs/{slug}/…`
/// routes already speak, and what a person can read in a proxy log without
/// looking anything up.
pub const ORG_HEADER: &str = "X-Aura-Org";

/// One org the signed-in account can act as.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct CloudOrg {
    pub id: String,
    pub slug: String,
    /// The display name — `"ashiq team"`, `"Naridon"`. Falls back to the slug
    /// when the server has none, because a row with a blank name is a row
    /// nobody can pick.
    pub name: String,
    /// How many repos in it this account can see. Shown beside the name so a
    /// switcher says what changing to it would actually get you — and so an
    /// org you were added to but hold nothing in reads as empty rather than
    /// broken.
    pub repo_count: u32,
    /// Whether this is the one the app is acting as.
    pub current: bool,
}

/// The org recorded in `credentials.json`, in the three parts different
/// surfaces need: the slug to name it, the id to match server rows against, the
/// name to print.
///
/// All optional because a credentials file written before this existed carries
/// only the slug, and one written while signed out carries none of it.
#[derive(Debug, Clone, Default, PartialEq)]
pub struct ActiveOrg {
    pub id: Option<String>,
    pub slug: Option<String>,
    pub name: Option<String>,
}

fn field(creds: &serde_json::Map<String, Value>, key: &str) -> Option<String> {
    creds
        .get(key)
        .and_then(|v| v.as_str())
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(str::to_string)
}

/// Which org the app is acting as, from a credentials map already in hand.
pub fn active_org(creds: &serde_json::Map<String, Value>) -> ActiveOrg {
    ActiveOrg {
        id: field(creds, "cloud_org_id"),
        slug: field(creds, "cloud_org_slug"),
        name: field(creds, "cloud_org_name"),
    }
}

/// The active org's slug, read from disk.
///
/// Deliberately re-read rather than cached in a static. The credentials file is
/// a few hundred bytes and every caller is about to open a socket, so the read
/// is free next to what follows it — and the CLI writes this same file, so a
/// cached copy would have the desktop acting as an org the user switched away
/// from at a terminal until the app was restarted.
pub fn active_org_slug() -> Option<String> {
    active_org(&read_credentials().unwrap_or_default()).slug
}

/// Record the org the user picked, so it survives a restart.
///
/// Writes all three fields together. The id is what runner and repo rows are
/// matched on and the slug is what the wire and the `/orgs/{slug}/…` routes
/// speak, so a file holding one without the other would leave half the app
/// filtering and the other half not.
pub fn remember_org(org: &CloudOrg) -> Result<(), String> {
    let mut creds = read_credentials()?;
    creds.insert("cloud_org_id".into(), Value::String(org.id.clone()));
    creds.insert("cloud_org_slug".into(), Value::String(org.slug.clone()));
    creds.insert("cloud_org_name".into(), Value::String(org.name.clone()));
    write_credentials(&creds)
}

/// One repo row as `GET /api/v2/repos` returns it.
///
/// That endpoint is the only genuinely cross-org read the server has: it walks
/// every repo the caller can see, across every org they belong to, and tags
/// each with the org it belongs to. Everything else is `/orgs/{slug}/…`, which
/// can only answer about an org you already named — which is the question.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct CloudRepo {
    pub id: String,
    pub full_name: String,
    pub org_id: String,
    pub org_slug: String,
    pub org_name: String,
}

/// The orgs behind a set of repo rows, plus the one recorded on this laptop.
///
/// Folding `active` in is not belt-and-braces: an org you own and have not put
/// a repo in yet returns no rows at all, and a switcher that dropped it would
/// hide the org a fresh account is *standing in*. It comes back with
/// `repo_count: 0`, which is the truth and reads as an invitation.
///
/// Ordering is by name, case-insensitively, then by slug — stable, so the list
/// doesn't reshuffle between two reads of the same account, and alphabetical,
/// because any activity-based order would put the org you are leaving on top.
pub fn orgs_from_repos(repos: &[CloudRepo], active: &ActiveOrg) -> Vec<CloudOrg> {
    let mut out: Vec<CloudOrg> = Vec::new();
    for repo in repos {
        let slug = repo.org_slug.trim();
        if slug.is_empty() {
            continue;
        }
        match out.iter_mut().find(|o| o.slug == slug) {
            Some(found) => found.repo_count += 1,
            None => out.push(CloudOrg {
                id: repo.org_id.trim().to_string(),
                slug: slug.to_string(),
                name: display_name(&repo.org_name, slug),
                repo_count: 1,
                current: false,
            }),
        }
    }

    if let Some(slug) = active.slug.as_deref() {
        if !out.iter().any(|o| o.slug == slug) {
            out.push(CloudOrg {
                id: active.id.clone().unwrap_or_default(),
                slug: slug.to_string(),
                name: display_name(active.name.as_deref().unwrap_or_default(), slug),
                repo_count: 0,
                current: false,
            });
        }
    }

    out.sort_by(|a, b| {
        a.name
            .to_lowercase()
            .cmp(&b.name.to_lowercase())
            .then_with(|| a.slug.cmp(&b.slug))
    });

    // With nothing recorded — a sign-in from before this existed — the first
    // org is what the app is already acting as, so it is ticked rather than
    // leaving the menu with no answer to "which one am I in". `cloud_orgs`
    // then writes that down, so the guess happens exactly once.
    let current = active
        .slug
        .clone()
        .or_else(|| out.first().map(|o| o.slug.clone()));
    if let Some(slug) = current {
        for org in out.iter_mut() {
            org.current = org.slug == slug;
        }
    }
    out
}

/// A name worth printing, or the slug. An org row with a blank name is one
/// nobody can pick out of a list.
fn display_name(name: &str, slug: &str) -> String {
    let name = name.trim();
    if name.is_empty() {
        slug.to_string()
    } else {
        name.to_string()
    }
}

/// Stamp a cloud request with the org the user is acting as.
///
/// Chained after `bearer_auth` at every aura-cloud call site. A no-op when
/// nothing is recorded, so a signed-out or never-paired install sends exactly
/// what it always sent.
pub trait OrgScoped {
    fn org_scoped(self) -> Self;
}

impl OrgScoped for reqwest::RequestBuilder {
    fn org_scoped(self) -> Self {
        match active_org_slug() {
            Some(slug) => self.header(ORG_HEADER, slug),
            None => self,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn repo(full: &str, org: &str) -> CloudRepo {
        CloudRepo {
            id: format!("r-{full}"),
            full_name: full.into(),
            org_id: format!("o-{org}"),
            org_slug: org.into(),
            org_name: format!("{org} team"),
        }
    }

    #[test]
    fn repos_fold_into_the_orgs_they_belong_to() {
        let repos = [
            repo("naridon/aura", "naridon"),
            repo("naridon/site", "naridon"),
            repo("mhask/notes", "mhask"),
        ];
        let orgs = orgs_from_repos(&repos, &ActiveOrg::default());
        assert_eq!(orgs.len(), 2);
        let naridon = orgs.iter().find(|o| o.slug == "naridon").unwrap();
        assert_eq!(naridon.repo_count, 2);
        assert_eq!(naridon.name, "naridon team");
        assert_eq!(naridon.id, "o-naridon");
    }

    #[test]
    fn the_org_you_are_in_is_offered_even_with_nothing_in_it() {
        // Every signup owns an org before it owns a repo. An empty one is the
        // state a fresh account is *standing in*, and a switcher that dropped
        // it would offer no way back to where you already are.
        let active = ActiveOrg {
            id: Some("o-mine".into()),
            slug: Some("mine".into()),
            name: Some("my team".into()),
        };
        let orgs = orgs_from_repos(&[repo("naridon/aura", "naridon")], &active);
        assert_eq!(orgs.len(), 2);
        let mine = orgs.iter().find(|o| o.slug == "mine").unwrap();
        assert_eq!(mine.repo_count, 0);
        assert!(mine.current, "the org we are acting as must be the ticked one");
    }

    #[test]
    fn exactly_one_org_is_ever_ticked() {
        let repos = [repo("a/one", "alpha"), repo("b/two", "beta")];
        let active = ActiveOrg {
            slug: Some("beta".into()),
            ..Default::default()
        };
        let orgs = orgs_from_repos(&repos, &active);
        assert_eq!(orgs.iter().filter(|o| o.current).count(), 1);
        assert!(orgs.iter().find(|o| o.slug == "beta").unwrap().current);
    }

    #[test]
    fn a_sign_in_from_before_this_existed_still_knows_where_it_is() {
        // No recorded choice. Leaving every row unticked would show a menu that
        // cannot say which org the app is currently acting as.
        let repos = [repo("b/two", "beta"), repo("a/one", "alpha")];
        let orgs = orgs_from_repos(&repos, &ActiveOrg::default());
        assert!(orgs[0].current, "the first row is what we are acting as");
        assert_eq!(orgs.iter().filter(|o| o.current).count(), 1);
    }

    #[test]
    fn the_list_is_alphabetical_and_does_not_reshuffle() {
        let repos = [
            repo("z/one", "zulu"),
            repo("a/two", "alpha"),
            repo("m/three", "mike"),
        ];
        let a = orgs_from_repos(&repos, &ActiveOrg::default());
        let b = orgs_from_repos(&repos, &ActiveOrg::default());
        assert_eq!(
            a.iter().map(|o| o.slug.as_str()).collect::<Vec<_>>(),
            ["alpha", "mike", "zulu"]
        );
        assert_eq!(a, b, "two reads of one account must agree on the order");
    }

    #[test]
    fn an_org_with_no_name_is_named_by_its_slug() {
        // A blank cell in the database must not become a blank row in a menu.
        let mut r = repo("x/y", "naridon");
        r.org_name = "   ".into();
        let orgs = orgs_from_repos(&[r], &ActiveOrg::default());
        assert_eq!(orgs[0].name, "naridon");
    }

    #[test]
    fn a_row_with_no_org_is_skipped_rather_than_becoming_a_blank_org() {
        let mut r = repo("x/y", "naridon");
        r.org_slug = "".into();
        assert!(orgs_from_repos(&[r], &ActiveOrg::default()).is_empty());
    }

    #[test]
    fn nothing_recorded_reads_as_nothing_rather_than_as_an_empty_string() {
        let mut creds = serde_json::Map::new();
        creds.insert("cloud_org_slug".into(), Value::String("  ".into()));
        assert_eq!(active_org(&creds).slug, None);
    }

    #[test]
    fn the_slug_the_pairing_wrote_is_read_back_whole() {
        let mut creds = serde_json::Map::new();
        creds.insert("cloud_org_slug".into(), Value::String("naridon".into()));
        creds.insert("cloud_org_id".into(), Value::String("o-1".into()));
        let active = active_org(&creds);
        assert_eq!(active.slug.as_deref(), Some("naridon"));
        assert_eq!(active.id.as_deref(), Some("o-1"));
        // Never written by the pairing exchange, which only sends a slug.
        assert_eq!(active.name, None);
    }
}
