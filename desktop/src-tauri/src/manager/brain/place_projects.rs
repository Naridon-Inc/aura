//! Which of the projects on a place belong to the org you opened it as.
//!
//! A box discovers projects box-wide. [`crate::cloudbox::script::list_projects`]
//! scans a couple of roots one level deep and takes whatever has a `.git` in it,
//! which is the right way to find them — the two repos somebody cloned by hand
//! long before any of this existed are real projects, and a layout we invented
//! would have made them invisible.
//!
//! But a shared runner is not a personal box. Two orgs' work sits on one disk,
//! under one discovery, and the list a member sees is currently everything: the
//! contractor opening their client's runner reads the client's *other* client's
//! repo names off the picker. Nothing here changes the discovery. It runs
//! exactly as it did, and what comes back is then **narrowed** — because the
//! only thing that can honestly say which projects are on a machine is the
//! machine.
//!
//! ## What files a project under an org
//!
//! The place's own org, off its book row ([`crate::cmd_machines::Machine::org_slug`]),
//! and the org's project registry — the same cross-org `GET /api/v2/repos` read
//! [`crate::cmd_cloud_orgs`] derives the switcher from. A project's git remote
//! resolves to `owner/name`, and `owner/name` is the one handle a checkout on
//! someone else's hardware has on a repo the server knows about.
//!
//! ## Three states, because two would lie
//!
//! Narrowing is only honest when we can say what we narrowed *against*:
//!
//! 1. **Unfiled** — the place has no org. A book row written before the field
//!    existed, a box somebody set up for themselves. Nothing to filter by, so
//!    nothing is filtered. Tightening this is how an upgrade takes away
//!    somebody's working machine.
//! 2. **Unreadable** — signed out, offline, or the org's server having a bad
//!    afternoon. Everything is offered, with the reason said out loud. A filter
//!    that fails *closed* here would show an empty machine to somebody whose
//!    wifi dropped, and the only thing they could conclude is that their work is
//!    gone.
//! 3. **Known** — we hold the org's project list. Now `only` means only, and
//!    every project held back says which it is and why.
//!
//! An org we can reach but that holds no projects we can see is state 2, not a
//! very strict state 3. "Naridon has no repos" and "we could not find out what
//! Naridon's repos are" produce identical evidence here, and blanking a box on
//! the strength of that is the same failure with extra steps.
//!
//! ## Withheld is not hidden
//!
//! Every project the narrowing drops comes back in [`PlaceProjects::withheld`]
//! with a sentence saying why. A surface that showed a shorter list and said
//! nothing would be indistinguishable from a box that had quietly lost half its
//! repos — and the person looking at it is exactly the person who knows the repo
//! is there.

use std::collections::HashMap;

use serde::{Deserialize, Serialize};

use crate::cloud_org::CloudRepo;
use crate::cloudbox::domain::BoxProject;

use super::place::Place;

/// A project the place holds but does not offer, and why not.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct WithheldProject {
    /// Absolute path on the place. Named rather than merely counted: the person
    /// reading this is the one who knows the repo is there, and "one project
    /// isn't listed" without saying which is not an explanation.
    pub path: String,
    pub name: String,
    /// One sentence, in the words somebody would use. Not a code.
    pub reason: String,
}

/// What a place offers, once the org it was opened as has had its say.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct PlaceProjects {
    /// The slug the narrowing ran under, or `None` when none did.
    pub org: Option<String>,
    /// What to call that org on screen. Falls back to the slug.
    pub org_name: Option<String>,
    /// The projects this place offers.
    pub projects: Vec<BoxProject>,
    /// The ones it holds and does not offer, each with its reason.
    pub withheld: Vec<WithheldProject>,
    /// Whether the list was actually narrowed. `false` with a non-empty
    /// [`Self::notice`] is the "we could not find out" state, and a surface must
    /// not draw it the same way as a clean filter.
    pub narrowed: bool,
    /// The one sentence above the list, or empty when the list needs no
    /// explaining. Covers both directions: what was held back, and why nothing
    /// could be.
    pub notice: String,
}

/// The org's project list, as far as this laptop could get one.
///
/// Built once per read and handed to [`narrow`], which is pure — so the rule
/// that decides what a member is offered is testable without a box, a server or
/// a signed-in account anywhere near it.
#[derive(Debug, Clone, Default)]
pub struct OrgIndex {
    /// The place's own org, off its book row.
    pub org: Option<String>,
    /// `owner/name`, lowercased, to the slug of the org that holds it — across
    /// every org this account can see, not only the active one. Knowing that
    /// `mhask/notes` is *mhask's* is what turns "not ours" into a sentence.
    pub by_repo: HashMap<String, String>,
    /// slug → display name, for the same reason.
    pub org_names: HashMap<String, String>,
    /// Why the registry is missing, when it is. `None` with an org and an empty
    /// `by_repo` cannot happen — see [`OrgIndex::from_repos`].
    pub blocked: Option<String>,
}

impl OrgIndex {
    /// A place with no org recorded. Nothing to narrow by.
    pub fn unfiled() -> Self {
        Self::default()
    }

    /// An org we know of and could not ask about. `why` is the server's own
    /// words, kept verbatim — "Connection refused" says what to do next and
    /// "something went wrong" does not.
    pub fn blocked(org: &str, why: impl Into<String>) -> Self {
        Self {
            org: Some(org.to_string()),
            blocked: Some(why.into()),
            ..Default::default()
        }
    }

    /// The registry, from the one cross-org read the server has.
    ///
    /// An org holding nothing we can see comes back [`blocked`](Self::blocked)
    /// rather than as an index that matches nothing: an empty allowlist and an
    /// unread allowlist are the same evidence, and only one of them is a reason
    /// to empty somebody's machine.
    pub fn from_repos(org: &str, repos: &[CloudRepo]) -> Self {
        let mut by_repo = HashMap::new();
        let mut org_names = HashMap::new();
        for repo in repos {
            let slug = repo.org_slug.trim();
            if slug.is_empty() {
                continue;
            }
            let name = repo.org_name.trim();
            if !name.is_empty() {
                org_names.insert(slug.to_ascii_lowercase(), name.to_string());
            }
            let full = repo.full_name.trim();
            if full.is_empty() {
                continue;
            }
            by_repo.insert(full.to_ascii_lowercase(), slug.to_ascii_lowercase());
        }
        let ours = org.to_ascii_lowercase();
        if !by_repo.values().any(|slug| *slug == ours) {
            let blocked = format!(
                "Aura doesn't know of any {} projects to match against.",
                display(org, &org_names)
            );
            return Self {
                org: Some(org.to_string()),
                org_names,
                blocked: Some(blocked),
                by_repo: HashMap::new(),
            };
        }
        Self {
            org: Some(org.to_string()),
            by_repo,
            org_names,
            blocked: None,
        }
    }

    /// Whether this index can actually narrow anything.
    fn usable(&self) -> bool {
        self.org.is_some() && self.blocked.is_none() && !self.by_repo.is_empty()
    }
}

/// What to call an org on screen: its name if the registry gave one, else the
/// slug. A blank cell in a database must not become a blank word in a sentence.
fn display(slug: &str, names: &HashMap<String, String>) -> String {
    names
        .get(&slug.to_ascii_lowercase())
        .cloned()
        .unwrap_or_else(|| slug.to_string())
}

/// `owner/name` for a project's remote, when it has one we can read.
///
/// The same parse [`crate::cloud_session_sync::repo_full_name_of_url`] does for
/// a checkout on this disk, called on a URL that came back off a box — which is
/// the only difference: over there there is no `.git/config` to read, only the
/// string the listing already carried.
fn full_name(project: &BoxProject) -> Option<String> {
    let url = project.remote.as_deref().map(str::trim).filter(|u| !u.is_empty())?;
    crate::cloud_session_sync::repo_full_name_of_url(url)
}

/// The rule, as a pure function over rows.
///
/// Everything a person is offered, everything they are not, and the sentence
/// that explains the difference — decided here, once, so the picker and the
/// workspace composer cannot come to different conclusions about the same box.
pub fn narrow(found: &[BoxProject], index: &OrgIndex) -> PlaceProjects {
    let org_name = index
        .org
        .as_deref()
        .map(|slug| display(slug, &index.org_names));

    if !index.usable() {
        // Unfiled says nothing — a personal box offering its own projects needs
        // no explanation. Blocked says why, because a list that isn't narrowed
        // while you're acting as an org is a fact about the network, not a fact
        // about the box.
        let notice = match (&index.org, &index.blocked) {
            (Some(_), Some(why)) => format!(
                "Showing every project on this machine — {} {}",
                why.trim(),
                "Sign in and reconnect to see only your org's."
            ),
            _ => String::new(),
        };
        return PlaceProjects {
            org: index.org.clone(),
            org_name,
            projects: found.to_vec(),
            withheld: Vec::new(),
            narrowed: false,
            notice,
        };
    }

    let ours = index.org.as_deref().unwrap_or_default().to_ascii_lowercase();
    let ours_label = org_name.clone().unwrap_or_else(|| ours.clone());

    let mut projects = Vec::new();
    let mut withheld = Vec::new();
    for project in found {
        match full_name(project) {
            Some(full) => match index.by_repo.get(&full.to_ascii_lowercase()) {
                Some(slug) if *slug == ours => projects.push(project.clone()),
                Some(slug) => withheld.push(WithheldProject {
                    path: project.path.clone(),
                    name: project.name.clone(),
                    reason: format!(
                        "{full} belongs to {}, not {ours_label}.",
                        display(slug, &index.org_names)
                    ),
                }),
                None => withheld.push(WithheldProject {
                    path: project.path.clone(),
                    name: project.name.clone(),
                    reason: format!("{full} isn't one of {ours_label}'s projects."),
                }),
            },
            None => withheld.push(WithheldProject {
                path: project.path.clone(),
                name: project.name.clone(),
                // A repo with no readable remote can't be pushed anywhere, so
                // there is nothing that could file it under an org. Said as what
                // it is rather than as a refusal.
                reason: format!(
                    "Nothing says this is {ours_label}'s — it has no remote Aura can read."
                ),
            }),
        }
    }

    let notice = match withheld.len() {
        0 => String::new(),
        1 => format!(
            "1 other project on this machine isn't {ours_label}'s, so it isn't listed here."
        ),
        n => format!(
            "{n} other projects on this machine aren't {ours_label}'s, so they aren't listed here."
        ),
    };

    PlaceProjects {
        org: index.org.clone(),
        org_name,
        projects,
        withheld,
        narrowed: true,
        notice,
    }
}

impl Place {
    /// The org this place was connected under, when it has one.
    ///
    /// This laptop never has one, and that is not a special case being made for
    /// it: the machine book is where an org is recorded, and this laptop has no
    /// row in it. Your own disk holds your own projects in every org you act as.
    pub fn org(&self) -> Option<&str> {
        match self {
            Place::Here { .. } => None,
            Place::Box { machine, .. } => machine
                .org_slug
                .as_deref()
                .map(str::trim)
                .filter(|s| !s.is_empty()),
        }
    }

    /// The org's project registry, or the honest reason there isn't one.
    ///
    /// The other half of the answer. [`Place::projects`] says what the place
    /// holds; this says what its org holds, and [`narrow`] is the rule between
    /// them. Deliberately three pieces rather than one `org_projects()` verb:
    /// [`crate::cloudbox::box_projects`] has a use for the value in the middle,
    /// because the branch cached on a machine row is read off the projects the
    /// box *holds* — an org filter must not make the rail forget which branch is
    /// checked out in the machine's own repo directory.
    ///
    /// Never an `Err`. Failing the whole read because a laptop is offline would
    /// take away a list that is sitting on the box in front of you; the failure
    /// belongs in the notice, where somebody can act on it.
    pub(crate) async fn org_index(&self) -> OrgIndex {
        let Some(org) = self.org() else {
            return OrgIndex::unfiled();
        };
        match crate::cmd_cloud_orgs::visible_repos().await {
            Ok(repos) => OrgIndex::from_repos(org, &repos),
            Err(why) => OrgIndex::blocked(org, why),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn project(name: &str, remote: Option<&str>) -> BoxProject {
        BoxProject {
            path: format!("/srv/{name}"),
            name: name.into(),
            remote: remote.map(str::to_string),
            branch: Some("main".into()),
            dirty: 0,
        }
    }

    fn repo(full: &str, org: &str, org_name: &str) -> CloudRepo {
        CloudRepo {
            id: format!("r-{full}"),
            full_name: full.into(),
            org_id: format!("o-{org}"),
            org_slug: org.into(),
            org_name: org_name.into(),
        }
    }

    /// The registry two orgs sharing one runner would produce.
    fn two_orgs() -> Vec<CloudRepo> {
        vec![
            repo("Naridon-Inc/aura", "naridon", "Naridon"),
            repo("Naridon-Inc/aura-web", "naridon", "Naridon"),
            repo("mhask/notes", "mhask", "mhask team"),
        ]
    }

    /// One box, both orgs' work on it. The whole feature, in one assertion.
    #[test]
    fn a_box_holding_two_orgs_projects_offers_each_member_only_their_own() {
        let on_disk = [
            project("aura", Some("https://github.com/Naridon-Inc/aura.git")),
            project("aura-web", Some("git@github.com:Naridon-Inc/aura-web.git")),
            project("notes", Some("https://github.com/mhask/notes.git")),
        ];

        let naridon = narrow(&on_disk, &OrgIndex::from_repos("naridon", &two_orgs()));
        assert_eq!(
            naridon.projects.iter().map(|p| p.name.as_str()).collect::<Vec<_>>(),
            ["aura", "aura-web"]
        );
        assert_eq!(naridon.withheld.len(), 1);
        assert_eq!(naridon.withheld[0].name, "notes");

        let mhask = narrow(&on_disk, &OrgIndex::from_repos("mhask", &two_orgs()));
        assert_eq!(
            mhask.projects.iter().map(|p| p.name.as_str()).collect::<Vec<_>>(),
            ["notes"]
        );
        assert_eq!(mhask.withheld.len(), 2);
    }

    /// The reason names the other org rather than saying "not yours", because
    /// the person reading it put that repo there and needs to know which hat to
    /// wear to get it back.
    #[test]
    fn a_project_held_back_says_whose_it_is() {
        let out = narrow(
            &[project("notes", Some("https://github.com/mhask/notes.git"))],
            &OrgIndex::from_repos("naridon", &two_orgs()),
        );
        assert_eq!(
            out.withheld[0].reason,
            "mhask/notes belongs to mhask team, not Naridon."
        );
        assert_eq!(out.notice, "1 other project on this machine isn't Naridon's, so it isn't listed here.");
    }

    /// Plural, because "1 other projects" is the sentence that tells everyone
    /// nobody read it.
    #[test]
    fn the_notice_counts_in_words_a_person_would_use() {
        let out = narrow(
            &[
                project("notes", Some("https://github.com/mhask/notes.git")),
                project("linux", Some("https://github.com/torvalds/linux.git")),
            ],
            &OrgIndex::from_repos("naridon", &two_orgs()),
        );
        assert_eq!(
            out.notice,
            "2 other projects on this machine aren't Naridon's, so they aren't listed here."
        );
    }

    /// A repo nobody's org holds is held back too — that is what "only" means —
    /// but it is not accused of belonging to somebody else.
    #[test]
    fn a_repo_no_org_of_yours_holds_is_not_this_orgs_either() {
        let out = narrow(
            &[project("linux", Some("https://github.com/torvalds/linux.git"))],
            &OrgIndex::from_repos("naridon", &two_orgs()),
        );
        assert!(out.projects.is_empty());
        assert_eq!(
            out.withheld[0].reason,
            "torvalds/linux isn't one of Naridon's projects."
        );
    }

    /// A checkout with no remote can't be pushed anywhere, so nothing files it
    /// under an org. Held back, and told what the missing fact is.
    #[test]
    fn a_project_with_no_remote_is_held_back_with_the_missing_fact_named() {
        let out = narrow(
            &[project("scratch", None)],
            &OrgIndex::from_repos("naridon", &two_orgs()),
        );
        assert!(out.projects.is_empty());
        assert!(
            out.withheld[0].reason.contains("no remote Aura can read"),
            "{}",
            out.withheld[0].reason
        );
    }

    /// The state that ships if nobody writes this test: a place connected before
    /// orgs existed loses every project the moment the feature lands.
    #[test]
    fn a_place_with_no_org_is_not_narrowed_at_all() {
        let on_disk = [
            project("aura", Some("https://github.com/Naridon-Inc/aura.git")),
            project("scratch", None),
        ];
        let out = narrow(&on_disk, &OrgIndex::unfiled());
        assert_eq!(out.projects.len(), 2);
        assert!(out.withheld.is_empty());
        assert!(!out.narrowed);
        // Nothing to explain: this is a personal box offering its own projects.
        assert_eq!(out.notice, "");
    }

    /// Offline is not "your box is empty". Everything is offered and the reason
    /// is said out loud, because the answer to this one is to try again rather
    /// than to go looking for missing repos.
    #[test]
    fn a_registry_we_could_not_read_offers_everything_and_says_why() {
        let out = narrow(
            &[
                project("aura", Some("https://github.com/Naridon-Inc/aura.git")),
                project("notes", Some("https://github.com/mhask/notes.git")),
            ],
            &OrgIndex::blocked("naridon", "Connection refused"),
        );
        assert_eq!(out.projects.len(), 2, "an offline laptop emptied a live box");
        assert!(out.withheld.is_empty());
        assert!(!out.narrowed);
        assert!(out.notice.contains("Connection refused"), "{}", out.notice);
        assert!(out.notice.starts_with("Showing every project"), "{}", out.notice);
    }

    /// An org whose repos we cannot see is the same evidence as an org we could
    /// not ask about, and only one reading of it empties a working machine.
    #[test]
    fn an_org_holding_nothing_we_can_see_does_not_become_an_empty_allowlist() {
        let index = OrgIndex::from_repos("contractor", &two_orgs());
        assert!(index.blocked.is_some(), "an unknown org became a strict filter");
        let out = narrow(
            &[project("aura", Some("https://github.com/Naridon-Inc/aura.git"))],
            &index,
        );
        assert_eq!(out.projects.len(), 1);
        assert!(!out.narrowed);
    }

    /// Remotes come off a box in whatever spelling whoever cloned it used.
    #[test]
    fn every_spelling_of_one_remote_files_under_the_same_org() {
        for url in [
            "https://github.com/Naridon-Inc/aura.git",
            "https://github.com/Naridon-Inc/aura",
            "git@github.com:Naridon-Inc/aura.git",
            "ssh://git@github.com/Naridon-Inc/aura",
        ] {
            let out = narrow(
                &[project("aura", Some(url))],
                &OrgIndex::from_repos("naridon", &two_orgs()),
            );
            assert_eq!(out.projects.len(), 1, "{url} did not file under its org");
        }
    }

    /// GitHub is case-insensitive about owner and repo, and a book row's slug is
    /// whatever was typed. Neither may decide whether you see your own work.
    #[test]
    fn case_does_not_decide_whether_you_see_your_own_project() {
        let out = narrow(
            &[project("aura", Some("https://github.com/naridon-inc/AURA.git"))],
            &OrgIndex::from_repos("NARIDON", &two_orgs()),
        );
        assert_eq!(out.projects.len(), 1);
    }

    /// An org with no display name is named by its slug rather than by a gap.
    #[test]
    fn an_org_with_no_name_is_named_by_its_slug() {
        let repos = vec![repo("a/b", "naridon", "   "), repo("c/d", "mhask", "")];
        let out = narrow(
            &[project("d", Some("https://github.com/c/d.git"))],
            &OrgIndex::from_repos("naridon", &repos),
        );
        assert_eq!(out.org_name.as_deref(), Some("naridon"));
        assert_eq!(out.withheld[0].reason, "c/d belongs to mhask, not naridon.");
    }

    /// The discovery is untouched: nothing here reorders, renames or rewrites a
    /// row, so a project that survives the narrowing is the box's own answer.
    #[test]
    fn a_project_that_survives_is_the_row_the_box_sent() {
        let mut p = project("aura", Some("https://github.com/Naridon-Inc/aura.git"));
        p.dirty = 7;
        p.branch = Some("feat/x".into());
        let out = narrow(&[p.clone()], &OrgIndex::from_repos("naridon", &two_orgs()));
        assert_eq!(out.projects, vec![p]);
    }

    /// This laptop is not an org place, and it does not become one by your being
    /// signed into an org while you use it.
    #[test]
    fn this_laptop_has_no_org_to_be_narrowed_by() {
        let here = Place::Here { root: "/Users/me/alpha".into() };
        assert_eq!(here.org(), None);
    }

    /// A box's org comes off its own book row, not off whichever org the app
    /// happens to be acting as — an open workspace must not re-file itself when
    /// somebody uses the switcher in another window.
    #[test]
    fn a_boxs_org_is_the_one_it_was_connected_under() {
        let mut machine = crate::cmd_machines::Machine {
            id: "ubuntu@10.0.0.4:/srv/alpha".into(),
            name: "aura-runner".into(),
            host: "10.0.0.4".into(),
            user: "ubuntu".into(),
            key_path: "/Users/me/.ssh/aura.pem".into(),
            box_kind: "shared".into(),
            repo_path: Some("/srv/alpha".into()),
            project_root: Some("/Users/me/alpha".into()),
            repo_branch: None,
            org_slug: Some("naridon".into()),
            forward_agent: false,
            instance_id: None,
            asleep_since: 0,
            added_at: 1,
            last_used_at: 2,
        };
        let place = |m: &crate::cmd_machines::Machine| Place::Box {
            machine: Box::new(m.clone()),
            root: "/srv/alpha".into(),
            here: "/Users/me/alpha".into(),
        };
        assert_eq!(place(&machine).org(), Some("naridon"));
        // Blank is nothing recorded, not an org named "".
        machine.org_slug = Some("   ".into());
        assert_eq!(place(&machine).org(), None);
        machine.org_slug = None;
        assert_eq!(place(&machine).org(), None);
    }
}
