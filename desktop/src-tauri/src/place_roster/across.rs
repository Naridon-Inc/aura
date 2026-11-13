//! Every machine you can work on, across every org you belong to, each group
//! marked with whose it is.
//!
//! An Aura account is several hats: the org of one every signup owns (your
//! personal account), the company's, a client's. Everywhere else the machine
//! list follows the hat you are wearing — a client's box has no business in
//! the composer while you are working as yourself, and that rule stays. This
//! is the one read that answers the other question, "what do I have, all of
//! it", for the page that wants to show it at once with each row saying which
//! account it belongs to. Data, billing and access stay per org; only the view
//! is merged.
//!
//! Built from the same three reads [`super::places_list`] makes for one org,
//! made once per org with the org NAMED on the request rather than switched to:
//!
//! 1. the machine book, all of it, each row in the org it was filed under
//! 2. each org's runner board ([`crate::cmd_cloud_runners::runners_in_org`])
//! 3. each org's member roster, for names — and for whether it is an org of
//!    one, which is what "personal" means here
//!
//! A box in the book that no org has filed and no board claims is listed once,
//! under "this laptop", rather than once per org the way the per-org list shows
//! it. Like the per-org list this never writes the book and never invents an
//! address for a place this laptop has never connected.

use serde::Serialize;

use super::members;
use super::roster::{self, Directory, OrgHalf, PlaceRow};
use crate::cloud_org::CloudOrg;
use crate::cmd_cloud_runners::CloudRunner;
use crate::cmd_machines::Machine;
use crate::cloud_session_sync::{cloud_origin, cloud_token, read_credentials};

/// One account's machines.
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct PlaceGroup {
    /// `"personal"` — an org with you as its only member: your own account.
    /// `"team"`     — an org with other people in it.
    /// `"laptop"`   — boxes only this laptop's book knows, filed under no org.
    pub kind: String,
    pub org: OrgHalf,
    /// Whether this is the org the app is acting as. Opening a row of another
    /// org's group means switching to that org first.
    pub current: bool,
    /// People in the org, when its roster answered.
    pub members: Option<usize>,
    pub places: Vec<PlaceRow>,
}

/// Every group, and whether the cloud half could be asked at all.
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct AllPlaces {
    /// `"ok"` | `"signed_out"` | `"unreachable"` — about the list of orgs. One
    /// org whose board did not answer says so on its own group.
    pub status: String,
    pub detail: String,
    pub groups: Vec<PlaceGroup>,
}

/// What we learned about one org, ready to fold.
pub(crate) struct OrgRead {
    pub org: CloudOrg,
    /// `Err` carries the server's words when its board did not answer.
    pub runners: Result<Vec<CloudRunner>, String>,
    pub directory: Directory,
}

fn key(name: &str) -> String {
    name.trim().to_lowercase()
}

fn filed_under(machine: &Machine) -> Option<String> {
    machine
        .org_slug
        .as_deref()
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(str::to_lowercase)
}

/// Personal or team. The roster is the honest answer — one member, and it is
/// you — and when it did not answer, an org named after your login is the
/// personal one every signup is given.
fn kind_of(org: &CloudOrg, directory: &Directory) -> &'static str {
    if !directory.by_id.is_empty() {
        let only_me = directory.by_id.len() == 1
            && directory.me.as_deref().is_some_and(|me| {
                directory
                    .by_id
                    .values()
                    .any(|login| login.eq_ignore_ascii_case(me.trim()))
            });
        return if only_me { "personal" } else { "team" };
    }
    match directory.me.as_deref().map(str::trim) {
        Some(me) if !me.is_empty() && org.slug.eq_ignore_ascii_case(me) => "personal",
        _ => "team",
    }
}

/// Fold the book and every org's read into groups: the org you are acting as
/// first, then your personal account, then the rest by name, then this laptop.
pub(crate) fn group(book: &[Machine], reads: Vec<OrgRead>, me: Option<String>) -> Vec<PlaceGroup> {
    let mut unfiled: Vec<&Machine> = book.iter().filter(|m| filed_under(m).is_none()).collect();
    let mut groups: Vec<PlaceGroup> = Vec::new();

    let mut reads = reads;
    reads.sort_by_key(|r| {
        (
            !r.org.current,
            kind_of(&r.org, &r.directory) != "personal",
            r.org.name.to_lowercase(),
        )
    });

    for read in reads {
        let slug = read.org.slug.to_lowercase();
        let (half, runners) = match read.runners {
            Ok(runners) => (
                OrgHalf {
                    status: "ok".into(),
                    detail: String::new(),
                    slug: Some(read.org.slug.clone()),
                    name: Some(read.org.name.clone()),
                    my_role: read.directory.my_role.clone(),
                },
                runners,
            ),
            Err(detail) => (
                OrgHalf::unreachable(detail, Some(read.org.slug.clone()), Some(read.org.name.clone())),
                Vec::new(),
            ),
        };
        // The book's rows for this org: the ones filed under it, plus any
        // unfiled box whose name is on this org's board — it is the same
        // machine, and the board says whose.
        let names: Vec<String> = runners.iter().map(|r| key(&r.name)).collect();
        let mut subset: Vec<Machine> = book
            .iter()
            .filter(|m| filed_under(m).as_deref() == Some(slug.as_str()))
            .cloned()
            .collect();
        unfiled.retain(|m| {
            if names.contains(&key(&m.name)) {
                subset.push((*m).clone());
                false
            } else {
                true
            }
        });
        subset.sort_by(|a, b| b.last_used_at.cmp(&a.last_used_at));
        let kind = kind_of(&read.org, &read.directory);
        let members = (!read.directory.by_id.is_empty()).then_some(read.directory.by_id.len());
        groups.push(PlaceGroup {
            kind: kind.into(),
            current: read.org.current,
            members,
            places: roster::merge(&subset, &runners, &half, &read.directory),
            org: half,
        });
    }

    if !unfiled.is_empty() {
        let mut rest: Vec<Machine> = unfiled.into_iter().cloned().collect();
        rest.sort_by(|a, b| b.last_used_at.cmp(&a.last_used_at));
        let half = OrgHalf {
            status: "ok".into(),
            detail: String::new(),
            slug: None,
            name: None,
            my_role: None,
        };
        let directory = Directory {
            me,
            ..Directory::default()
        };
        groups.push(PlaceGroup {
            kind: "laptop".into(),
            current: false,
            members: None,
            places: roster::merge(&rest, &[], &half, &directory),
            org: half,
        });
    }
    groups
}

/// Every machine across every org you belong to, grouped by whose it is.
///
/// Never throws for the cloud's sake, for the same reason the per-org list
/// doesn't: the book is a file on this disk and is always answerable.
#[tauri::command]
pub async fn places_list_all() -> Result<AllPlaces, String> {
    let book = crate::cmd_machines::every_machine();
    let creds = read_credentials().unwrap_or_default();
    let me = creds
        .get("cloud_user")
        .and_then(|v| v.as_str())
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(str::to_string);

    let Some(token) = cloud_token(&creds) else {
        return Ok(AllPlaces {
            status: "signed_out".into(),
            detail: String::new(),
            groups: group(&book, Vec::new(), me),
        });
    };
    let orgs = match crate::cmd_cloud_orgs::cloud_orgs().await {
        Ok(orgs) => orgs,
        Err(detail) => {
            return Ok(AllPlaces {
                status: "unreachable".into(),
                detail,
                groups: group(&book, Vec::new(), me),
            })
        }
    };

    let origin = cloud_origin(&creds);
    let reads = futures_util::future::join_all(orgs.into_iter().map(|org| {
        let (origin, token, me) = (origin.clone(), token.clone(), me.clone());
        async move {
            let id = Some(org.id.as_str()).filter(|s| !s.trim().is_empty());
            let (runners, directory) = tokio::join!(
                crate::cmd_cloud_runners::runners_in_org(&origin, &token, &org.slug, id),
                members::directory(&origin, &token, &org.slug, me),
            );
            OrgRead { org, runners, directory }
        }
    }))
    .await;

    Ok(AllPlaces {
        status: "ok".into(),
        detail: String::new(),
        groups: group(&book, reads, me),
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::HashMap;

    fn machine(name: &str, org: Option<&str>, used: i64) -> Machine {
        Machine {
            id: format!("m-{name}"),
            aliases: Vec::new(),
            name: name.into(),
            host: "10.0.0.4".into(),
            user: "ubuntu".into(),
            key_path: "/Users/me/.ssh/aura.pem".into(),
            box_kind: "mine".into(),
            repo_path: Some("/srv/app".into()),
            project_root: None,
            repo_branch: None,
            org_slug: org.map(str::to_string),
            forward_agent: false,
            instance_id: None,
            asleep_since: 0,
            added_at: 1,
            last_used_at: used,
        }
    }

    fn runner(id: &str, name: &str) -> CloudRunner {
        CloudRunner {
            id: id.into(),
            org_id: None,
            name: name.into(),
            agent_kinds: vec!["claude".into()],
            version: None,
            status: "idle".into(),
            last_heartbeat_at: None,
            current_task: None,
            online: true,
            created_by: Some("u-ana".into()),
            created_at: None,
        }
    }

    fn org(slug: &str, name: &str, current: bool) -> CloudOrg {
        CloudOrg {
            id: format!("o-{slug}"),
            slug: slug.into(),
            name: name.into(),
            repo_count: 1,
            current,
        }
    }

    fn roster(logins: &[&str], my_role: &str) -> Directory {
        Directory {
            by_id: logins
                .iter()
                .map(|l| (format!("u-{l}"), l.to_string()))
                .collect::<HashMap<_, _>>(),
            me: Some("mo".into()),
            my_role: Some(my_role.into()),
        }
    }

    /// The case the page is for: your own account's box, the team's box and a
    /// box you connected that no org knows about, in one answer — each in the
    /// group that says whose it is.
    #[test]
    fn personal_team_and_laptop_machines_come_back_marked() {
        let book = [
            machine("mo-box", Some("mo"), 30),
            machine("scratch", None, 20),
        ];
        let reads = vec![
            OrgRead {
                org: org("naridon", "Naridon", true),
                runners: Ok(vec![runner("r1", "team-box")]),
                directory: roster(&["ana", "mo"], "member"),
            },
            OrgRead {
                org: org("mo", "mo", false),
                runners: Ok(vec![runner("r2", "mo-box")]),
                directory: roster(&["mo"], "owner"),
            },
        ];
        let groups = group(&book, reads, Some("mo".into()));
        let kinds: Vec<&str> = groups.iter().map(|g| g.kind.as_str()).collect();
        assert_eq!(kinds, ["team", "personal", "laptop"]);

        let team = &groups[0];
        assert!(team.current);
        assert_eq!(team.members, Some(2));
        assert_eq!(team.places.len(), 1);
        assert_eq!(team.places[0].name, "team-box");
        assert_eq!(team.places[0].owner.label, "Naridon");

        let personal = &groups[1];
        assert!(!personal.current);
        assert_eq!(personal.places.len(), 1);
        assert!(personal.places[0].machine.is_some(), "the book's address rides along");

        let laptop = &groups[2];
        assert_eq!(laptop.places.len(), 1);
        assert_eq!(laptop.places[0].name, "scratch");
        assert_eq!(laptop.places[0].owner.kind, "you");
    }

    /// The per-org list shows an unfiled box under every org; the all-orgs
    /// list must show it once — under the org whose board knows it, or under
    /// this laptop when none does.
    #[test]
    fn an_unfiled_box_appears_once() {
        let book = [machine("shared-box", None, 10)];
        let reads = vec![
            OrgRead {
                org: org("a", "A", true),
                runners: Ok(vec![]),
                directory: roster(&["mo", "x"], "member"),
            },
            OrgRead {
                org: org("b", "B", false),
                runners: Ok(vec![runner("rb", "shared-box")]),
                directory: roster(&["mo", "y"], "admin"),
            },
        ];
        let groups = group(&book, reads, Some("mo".into()));
        let total: usize = groups.iter().map(|g| g.places.len()).sum();
        assert_eq!(total, 1);
        let b = groups.iter().find(|g| g.org.slug.as_deref() == Some("b")).unwrap();
        assert_eq!(b.places[0].runner_id.as_deref(), Some("rb"));
        assert!(groups.iter().all(|g| g.kind != "laptop"));
    }

    /// One org's board not answering costs that org's places, said on its own
    /// group — never the other orgs', and never the boxes filed under it.
    #[test]
    fn one_org_unreachable_is_said_on_that_group_only() {
        let book = [machine("filed", Some("down"), 5)];
        let reads = vec![
            OrgRead {
                org: org("down", "Down Co", false),
                runners: Err("HTTP 502".into()),
                directory: Directory::default(),
            },
            OrgRead {
                org: org("up", "Up Co", true),
                runners: Ok(vec![runner("r", "up-box")]),
                directory: roster(&["mo", "z"], "member"),
            },
        ];
        let groups = group(&book, reads, Some("mo".into()));
        let down = groups.iter().find(|g| g.org.slug.as_deref() == Some("down")).unwrap();
        assert_eq!(down.org.status, "unreachable");
        assert_eq!(down.org.detail, "HTTP 502");
        assert_eq!(down.places.len(), 1, "a box you can reach stays listed");
        let up = groups.iter().find(|g| g.org.slug.as_deref() == Some("up")).unwrap();
        assert_eq!(up.org.status, "ok");
    }

    /// Without a roster, the org named after you is your personal one; any
    /// other is a team, because guessing "personal" for a company's org would
    /// tell someone a shared box is theirs alone.
    #[test]
    fn with_no_roster_only_the_org_named_after_you_is_personal() {
        let none = Directory {
            me: Some("Mo".into()),
            ..Directory::default()
        };
        assert_eq!(kind_of(&org("mo", "mo", false), &none), "personal");
        assert_eq!(kind_of(&org("naridon", "Naridon", false), &none), "team");
        // With a roster, the roster decides — an org of one that is not you
        // is not your personal account.
        let alone = Directory {
            by_id: HashMap::from([("u-ana".to_string(), "ana".to_string())]),
            me: Some("mo".into()),
            my_role: None,
        };
        assert_eq!(kind_of(&org("mo", "mo", false), &alone), "team");
    }

    /// Signed out: the book is the whole list, under this laptop.
    #[test]
    fn signed_out_lists_the_book_under_this_laptop() {
        let book = [machine("one", None, 1), machine("two", Some("naridon"), 2)];
        let groups = group(&book, Vec::new(), None);
        assert_eq!(groups.len(), 1);
        assert_eq!(groups[0].kind, "laptop");
        // A box filed under an org we could not ask about is still yours to
        // reach, and is not dropped.
        assert_eq!(groups[0].places.len(), 1);
    }
}
