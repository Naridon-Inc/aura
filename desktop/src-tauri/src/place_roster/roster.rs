//! The merge itself: two lists of machines, one list of places, and a straight
//! answer on each row about whose it is and what you may do with it.
//!
//! Pure on purpose. Everything that reaches a disk or a socket is next door in
//! [`super`] and [`super::members`], so the rule that decides what a person
//! sees can be argued with in a test rather than against a live server and
//! somebody's real `~/.aura/machines.json`.
//!
//! ## The two halves are not the same kind of fact
//!
//! The machine book is an ADDRESS BOOK: a host, a login and the path of a key
//! that stays on this laptop. It is `0600` and it is nobody else's. The org's
//! runner registry is a BOARD: names, liveness, who registered what — no
//! address at all, because a registry row has never carried one.
//!
//! So a row on this list is one of three things, and the type says which:
//!
//! * **mine** — in the book, not on the board. A box you brought and nobody
//!   else has been told about.
//! * **both** — in the book AND on the board. You hold the address; the org
//!   holds the place.
//! * **org** — on the board, not in the book. Your team has a machine and this
//!   laptop has no way to dial it yet.
//!
//! The third case is the one this whole task is for. It used to be invisible:
//! the fleet page drew the book, the runner board was a different screen, and
//! a member who had been given a machine had to be told about it in Slack.
//!
//! ## The merge is at read time, and only at read time
//!
//! Nothing here writes. The board is not copied into the book, the book is not
//! pushed to the board, and no row carries a key path — a list is a thing you
//! show on a screen somebody else can see, and the one fact the book holds that
//! the org has no business with is where your key lives. The book stays exactly
//! as private as it was before this list existed.

use std::collections::HashMap;

use serde::{Deserialize, Serialize};

use crate::cmd_cloud_runners::CloudRunner;
use crate::cmd_machines::Machine;

/// Where a row came from — see the module note.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum PlaceSource {
    /// In this laptop's book, unknown to the org's board.
    Mine,
    /// In the book and on the board.
    Both,
    /// On the board, with no address on this laptop.
    Org,
}

impl PlaceSource {
    /// Whether this laptop holds an address for it. The one question every
    /// right on the row turns on, spelled once.
    fn dialable(self) -> bool {
        matches!(self, PlaceSource::Mine | PlaceSource::Both)
    }
}

/// Whose place this is.
///
/// Two answers, because there are two ways a machine comes to be on this list.
/// A box only your book knows is yours — you connected it, nobody else can see
/// it, and forgetting it costs no one anything. A machine on the org's board
/// belongs to the org: your teammates see it, its runner drains the org's work,
/// and dropping your address for it does not take it away from them.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct PlaceOwner {
    /// `"you"` or `"org"`.
    pub kind: String,
    /// What to print — `"You"`, or the org's display name.
    pub label: String,
    /// The org's slug when it owns this, so a surface can name it back.
    pub org_slug: Option<String>,
}

/// Who put it there.
///
/// For a book row that is always you: an address arrives in your book because
/// you typed it into the wizard. For a board row it is whoever registered the
/// runner, resolved from the org's member roster — and when it cannot be
/// resolved the row says so in words rather than printing a uuid at somebody.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct PlaceAddedBy {
    /// `"you"`, `"@ana"`, `"someone in Naridon"`, or `"not recorded"`.
    pub label: String,
    pub is_you: bool,
}

/// What you may do with this row, on this laptop.
///
/// Deliberately the four verbs the app actually offers, and no more. A right
/// this list invents — "you may tear it down", "you may remove it from the
/// org" — is a right the server has never agreed to, and the first person to
/// find out would be the one whose click came back 403.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct PlaceRights {
    /// Open a workspace here. Needs an address, so it is false for exactly the
    /// org rows this laptop has never connected.
    pub open: bool,
    /// Change what this laptop records about it — its key, its directory.
    pub edit: bool,
    /// Drop it from this laptop's book. Never touches the machine, and never
    /// touches the org's board.
    pub forget: bool,
    /// Give this laptop an address for it. The one thing you can do with an
    /// org place you have not connected.
    pub connect: bool,
    /// The same thing in one sentence, for the row's tooltip. Written here
    /// rather than in the component so the words cannot drift from the flags.
    pub summary: String,
}

/// One row of the one list.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct PlaceRow {
    /// Stable key for this row. The book's id when there is one, otherwise the
    /// registry's id behind a `runner:` prefix so the two id spaces cannot
    /// collide into one React key.
    pub id: String,
    /// What to call it.
    pub name: String,
    pub source: PlaceSource,
    pub owner: PlaceOwner,
    pub added_by: PlaceAddedBy,
    pub may: PlaceRights,
    /// The book row, whole, when this laptop holds an address — and `None`
    /// when it does not. Never a half-filled `Machine` with invented fields: a
    /// blank host is a thing some later surface tries to ssh to.
    pub machine: Option<Machine>,
    /// The registry's id, when the org's board knows this place.
    pub runner_id: Option<String>,
    /// The board's verdict on liveness. `None` means nobody asked — a box only
    /// your book knows has no board to be up on, and rendering that as "down"
    /// would call every personal machine dead.
    pub online: Option<bool>,
    /// Which agent CLIs the board says it can run. Empty for a row with no
    /// board entry, which is an absence of an answer rather than an answer.
    pub agents: Vec<String>,
    /// Unix seconds from the book: when you added it, and when you were last
    /// on it. Both zero for a place you have never connected.
    pub added_at: i64,
    pub last_used_at: i64,
}

/// Everything the list needs, including why half of it might be missing.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct PlaceRoster {
    pub places: Vec<PlaceRow>,
    pub org: OrgHalf,
}

/// What happened when we asked the org for its places.
///
/// Carried beside the rows rather than thrown as an error, because the local
/// half is always answerable: the book is a file on this disk. A list that
/// failed whole when the network did would hide the boxes you can definitely
/// reach because we could not ask about the ones you might not have.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct OrgHalf {
    /// `"ok"` — we asked and got an answer.
    /// `"signed_out"` — there is nobody to ask as.
    /// `"unreachable"` — we asked and it did not answer.
    pub status: String,
    /// The server's own words when it went wrong, empty otherwise. Shown
    /// verbatim: "Connection refused" and "you may have been removed from it"
    /// each say what to do next, and "something went wrong" says nothing.
    pub detail: String,
    pub slug: Option<String>,
    /// The org's display name, when we know it.
    pub name: Option<String>,
    /// Your role in it — `"owner"`, `"admin"`, `"member"` — or `None` when the
    /// roster could not be read. Not a right on any row (all four verbs here
    /// are this laptop's own), but it is the honest answer to "what am I in
    /// this org", which is the question behind half of them.
    pub my_role: Option<String>,
}

impl OrgHalf {
    /// Nobody is signed in. Not an error: a laptop with no cloud account has a
    /// complete list already, and it is the book.
    pub fn signed_out() -> Self {
        Self {
            status: "signed_out".into(),
            detail: String::new(),
            slug: None,
            name: None,
            my_role: None,
        }
    }

    /// We asked and could not get an answer.
    pub fn unreachable(detail: impl Into<String>, slug: Option<String>, name: Option<String>) -> Self {
        Self {
            status: "unreachable".into(),
            detail: detail.into(),
            slug,
            name,
            my_role: None,
        }
    }

    /// What to call the org on a row that belongs to it. Falls back through the
    /// slug to a phrase rather than to a blank: "owned by" followed by nothing
    /// is worse than a vague truth.
    fn label(&self) -> String {
        self.name
            .as_deref()
            .map(str::trim)
            .filter(|s| !s.is_empty())
            .or_else(|| {
                self.slug
                    .as_deref()
                    .map(str::trim)
                    .filter(|s| !s.is_empty())
            })
            .unwrap_or("your org")
            .to_string()
    }
}

/// Who the org's user ids belong to, and which of them is you.
///
/// Built from the org's member roster in [`super::members`]. Every field is
/// allowed to be missing — the roster is a second network call and this list
/// does not fail when it doesn't answer; it just says less.
#[derive(Debug, Clone, Default)]
pub struct Directory {
    /// Registry `created_by` → the member's login.
    pub by_id: HashMap<String, String>,
    /// The login this laptop is signed in as, as written.
    pub me: Option<String>,
    /// Your role in the org.
    pub my_role: Option<String>,
}

impl Directory {
    /// Whether `login` is the account this laptop is signed in as. Logins are
    /// case-insensitive on every provider the server accepts, and the two
    /// sides of this comparison are written by different systems.
    fn is_me(&self, login: &str) -> bool {
        self.me
            .as_deref()
            .is_some_and(|me| me.trim().eq_ignore_ascii_case(login.trim()))
    }
}

/// Board name, normalised for matching. A runner row is matched back to a book
/// row by what it is CALLED, because that is the only field the two halves
/// share — the registry has no address and the book has no registry id.
fn key(name: &str) -> String {
    name.trim().to_lowercase()
}

/// Merge the book and the board into one list.
///
/// Matching is by board name, and a name is matched to EVERY book row that
/// carries it: one runner holds clones of several repos, the book files those
/// as a row each, and all of them are the same machine on the same board. Two
/// registrations under one name in one org are also one place — they are
/// already indistinguishable in every other surface in the app — so the first,
/// which is the liveliest by `cloud_runners`' own ordering, is the one shown.
pub(crate) fn merge(
    book: &[Machine],
    runners: &[CloudRunner],
    org: &OrgHalf,
    directory: &Directory,
) -> Vec<PlaceRow> {
    let org_label = org.label();

    // The board, by name, keeping the first of any duplicate — `cloud_runners`
    // hands these back online-first, most-recently-seen-first, so the first row
    // under a name is the one worth showing.
    let mut board: HashMap<String, &CloudRunner> = HashMap::new();
    for runner in runners {
        board.entry(key(&runner.name)).or_insert(runner);
    }

    let mut rows: Vec<PlaceRow> = Vec::new();
    let mut claimed: Vec<String> = Vec::new();

    for machine in book {
        let matched = board.get(&key(&machine.name)).copied();
        if let Some(runner) = matched {
            claimed.push(key(&runner.name));
        }
        let source = if matched.is_some() {
            PlaceSource::Both
        } else {
            PlaceSource::Mine
        };
        rows.push(PlaceRow {
            id: machine.id.clone(),
            name: machine.name.clone(),
            source,
            owner: owner_of(source, org, &org_label),
            added_by: added_by(source, matched, directory, &org_label),
            may: rights(source, &org_label),
            machine: Some(machine.clone()),
            runner_id: matched.map(|r| r.id.clone()),
            online: matched.map(|r| r.online),
            agents: matched.map(|r| r.agent_kinds.clone()).unwrap_or_default(),
            added_at: machine.added_at,
            last_used_at: machine.last_used_at,
        });
    }

    // Whatever the book never claimed: your org has a machine and this laptop
    // has no way to dial it.
    let mut orphans: Vec<&CloudRunner> = runners
        .iter()
        .filter(|r| !claimed.contains(&key(&r.name)))
        .collect();
    // One row per name, same rule as above.
    let mut seen: Vec<String> = Vec::new();
    orphans.retain(|r| {
        let k = key(&r.name);
        if seen.contains(&k) {
            false
        } else {
            seen.push(k);
            true
        }
    });
    // Live ones first, then alphabetically — a board row you cannot open is
    // ordered by whether it is worth connecting, and nothing here has a
    // last-used time because you have never used it.
    orphans.sort_by(|a, b| {
        b.online
            .cmp(&a.online)
            .then_with(|| key(&a.name).cmp(&key(&b.name)))
    });
    for runner in orphans {
        rows.push(PlaceRow {
            id: format!("runner:{}", runner.id),
            name: runner.name.clone(),
            source: PlaceSource::Org,
            owner: owner_of(PlaceSource::Org, org, &org_label),
            added_by: added_by(PlaceSource::Org, Some(runner), directory, &org_label),
            may: rights(PlaceSource::Org, &org_label),
            machine: None,
            runner_id: Some(runner.id.clone()),
            online: Some(runner.online),
            agents: runner.agent_kinds.clone(),
            added_at: 0,
            last_used_at: 0,
        });
    }

    rows
}

/// Whose it is. A row the org's board knows about belongs to the org, whichever
/// hat you were wearing when you saved its address; a row only your book knows
/// is yours, whichever org it was filed under.
fn owner_of(source: PlaceSource, org: &OrgHalf, org_label: &str) -> PlaceOwner {
    match source {
        PlaceSource::Mine => PlaceOwner {
            kind: "you".into(),
            label: "You".into(),
            org_slug: None,
        },
        PlaceSource::Both | PlaceSource::Org => PlaceOwner {
            kind: "org".into(),
            label: org_label.to_string(),
            org_slug: org.slug.clone(),
        },
    }
}

/// Who put it there, in words.
fn added_by(
    source: PlaceSource,
    runner: Option<&CloudRunner>,
    directory: &Directory,
    org_label: &str,
) -> PlaceAddedBy {
    // An address is in your book because you typed it into the wizard. There is
    // no other way one gets there, and the book records no author for that
    // reason.
    if source == PlaceSource::Mine {
        return PlaceAddedBy {
            label: "you".into(),
            is_you: true,
        };
    }
    let id = runner
        .and_then(|r| r.created_by.as_deref())
        .map(str::trim)
        .filter(|s| !s.is_empty());
    let Some(id) = id else {
        return PlaceAddedBy {
            label: "not recorded".into(),
            is_you: false,
        };
    };
    match directory.by_id.get(id) {
        Some(login) if directory.is_me(login) => PlaceAddedBy {
            label: "you".into(),
            is_you: true,
        },
        Some(login) => PlaceAddedBy {
            label: format!("@{login}"),
            is_you: false,
        },
        // We hold an id and no name for it — the roster didn't answer, or they
        // have since left. A uuid on a row helps nobody; "somebody in this org"
        // is the true part of what we know.
        None => PlaceAddedBy {
            label: format!("someone in {org_label}"),
            is_you: false,
        },
    }
}

/// What you may do with it, and the sentence that says so.
fn rights(source: PlaceSource, org_label: &str) -> PlaceRights {
    let dialable = source.dialable();
    let summary = match source {
        PlaceSource::Mine => {
            "Open it, change its address, or forget it — it is yours alone.".to_string()
        }
        PlaceSource::Both => format!(
            "Open it. Forgetting drops this laptop's address; the place stays on {org_label}'s board."
        ),
        PlaceSource::Org => {
            "Connect it to open a workspace — this laptop has no address for it yet.".to_string()
        }
    };
    PlaceRights {
        open: dialable,
        edit: dialable,
        forget: dialable,
        connect: !dialable,
        summary,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn machine(name: &str, repo: &str) -> Machine {
        Machine {
            id: format!("ubuntu@10.0.0.4:{repo}"),
            name: name.into(),
            host: "10.0.0.4".into(),
            user: "ubuntu".into(),
            key_path: "/Users/me/.ssh/aura.pem".into(),
            box_kind: "shared".into(),
            repo_path: Some(repo.into()),
            project_root: Some("/Users/me/alpha".into()),
            repo_branch: Some("main".into()),
            org_slug: Some("naridon".into()),
            forward_agent: false,
            instance_id: None,
            asleep_since: 0,
            added_at: 1_750_000_000,
            last_used_at: 1_750_003_600,
        }
    }

    fn runner(id: &str, name: &str, author: Option<&str>) -> CloudRunner {
        CloudRunner {
            id: id.into(),
            org_id: Some("o1".into()),
            name: name.into(),
            agent_kinds: vec!["claude".into()],
            version: Some("0.19.35".into()),
            status: "idle".into(),
            last_heartbeat_at: Some("2026-08-05T09:00:00Z".into()),
            current_task: None,
            online: true,
            created_by: author.map(str::to_string),
            created_at: Some("2026-07-01T09:00:00Z".into()),
        }
    }

    fn naridon() -> OrgHalf {
        OrgHalf {
            status: "ok".into(),
            detail: String::new(),
            slug: Some("naridon".into()),
            name: Some("Naridon".into()),
            my_role: Some("member".into()),
        }
    }

    /// mo is signed in; ana registered the team's box.
    fn directory() -> Directory {
        Directory {
            by_id: HashMap::from([
                ("u-ana".to_string(), "ana".to_string()),
                ("u-mo".to_string(), "mo".to_string()),
            ]),
            me: Some("mo".into()),
            my_role: Some("member".into()),
        }
    }

    /// The case the task is for: a member with a box of their own AND a place
    /// their org gave them, in one list, each saying whose it is.
    #[test]
    fn a_member_sees_their_own_box_and_their_orgs_place_in_one_list() {
        let rows = merge(
            &[machine("my-laptop-box", "/srv/alpha")],
            &[runner("r1", "team-box", Some("u-ana"))],
            &naridon(),
            &directory(),
        );
        assert_eq!(rows.len(), 2);

        let mine = &rows[0];
        assert_eq!(mine.source, PlaceSource::Mine);
        assert_eq!(mine.owner.kind, "you");
        assert_eq!(mine.owner.label, "You");
        assert_eq!(mine.added_by.label, "you");
        assert!(mine.may.open && mine.may.edit && mine.may.forget);
        assert!(!mine.may.connect);

        let theirs = &rows[1];
        assert_eq!(theirs.source, PlaceSource::Org);
        assert_eq!(theirs.owner.kind, "org");
        assert_eq!(theirs.owner.label, "Naridon");
        assert_eq!(theirs.owner.org_slug.as_deref(), Some("naridon"));
        assert_eq!(theirs.added_by.label, "@ana");
        assert!(!theirs.added_by.is_you);
        // Nothing to dial, so nothing to open, edit or forget — one thing to do.
        assert!(!theirs.may.open && !theirs.may.edit && !theirs.may.forget);
        assert!(theirs.may.connect);
    }

    /// A box in the book that the org's board also knows: you hold the address,
    /// the org holds the place, and forgetting says which of the two it drops.
    #[test]
    fn a_box_on_both_sides_is_one_row_that_says_so() {
        let rows = merge(
            &[machine("team-box", "/srv/alpha")],
            &[runner("r1", "team-box", Some("u-ana"))],
            &naridon(),
            &directory(),
        );
        assert_eq!(rows.len(), 1, "one machine is not two rows");
        let row = &rows[0];
        assert_eq!(row.source, PlaceSource::Both);
        assert_eq!(row.owner.label, "Naridon");
        assert_eq!(row.added_by.label, "@ana");
        assert!(row.may.open && row.may.forget);
        assert!(row.may.summary.contains("stays on Naridon's board"));
        assert_eq!(row.runner_id.as_deref(), Some("r1"));
        assert_eq!(row.online, Some(true));
        assert_eq!(row.agents, vec!["claude"]);
    }

    /// One runner holding two checkouts is two book rows, and both of them are
    /// on the board. Matching that consumed the runner on the first row would
    /// file the second as a personal box.
    #[test]
    fn two_projects_on_one_org_box_are_both_org_rows() {
        let rows = merge(
            &[
                machine("team-box", "/srv/alpha"),
                machine("team-box", "/srv/beta"),
            ],
            &[runner("r1", "team-box", Some("u-ana"))],
            &naridon(),
            &directory(),
        );
        assert_eq!(rows.len(), 2);
        assert!(rows.iter().all(|r| r.source == PlaceSource::Both));
        assert!(rows.iter().all(|r| r.owner.label == "Naridon"));
        // And the board row is not ALSO emitted on its own.
        assert!(rows.iter().all(|r| r.machine.is_some()));
    }

    /// The board and the book spell a name with different padding and case —
    /// they are written by different programs on different machines.
    #[test]
    fn a_name_matches_across_case_and_padding() {
        let rows = merge(
            &[machine("Team-Box", "/srv/alpha")],
            &[runner("r1", " team-box ", Some("u-ana"))],
            &naridon(),
            &directory(),
        );
        assert_eq!(rows.len(), 1);
        assert_eq!(rows[0].source, PlaceSource::Both);
    }

    /// You registered it yourself from another laptop. "Added by you" is the
    /// truth, and reading a uuid to find that out is not.
    #[test]
    fn a_place_you_registered_yourself_says_you() {
        let rows = merge(
            &[],
            &[runner("r1", "team-box", Some("u-mo"))],
            &naridon(),
            &directory(),
        );
        assert_eq!(rows[0].added_by.label, "you");
        assert!(rows[0].added_by.is_you);
    }

    /// The member roster didn't answer, or they have left the org. We hold an
    /// id and no name for it — and a uuid on a row helps nobody.
    #[test]
    fn an_author_we_cannot_name_is_described_rather_than_printed() {
        let rows = merge(
            &[],
            &[runner("r1", "team-box", Some("u-gone"))],
            &naridon(),
            &Directory::default(),
        );
        assert_eq!(rows[0].added_by.label, "someone in Naridon");
        assert!(!rows[0].added_by.is_you);
    }

    /// A server too old to send it. "Not recorded" is a different fact from
    /// "somebody we can't name", and the row says which.
    #[test]
    fn a_place_with_no_recorded_author_says_that_rather_than_guessing() {
        let rows = merge(&[], &[runner("r1", "team-box", None)], &naridon(), &directory());
        assert_eq!(rows[0].added_by.label, "not recorded");
    }

    /// Signed out, cloud down, or an org with no board: the list is still the
    /// list, and every box you can actually reach is on it.
    #[test]
    fn the_local_half_stands_on_its_own_when_the_org_half_is_missing() {
        let rows = merge(
            &[machine("my-box", "/srv/alpha")],
            &[],
            &OrgHalf::signed_out(),
            &Directory::default(),
        );
        assert_eq!(rows.len(), 1);
        assert_eq!(rows[0].source, PlaceSource::Mine);
        assert_eq!(rows[0].owner.label, "You");
        assert!(rows[0].may.open);
    }

    /// A box only your book knows has no board to be up on. Rendering an
    /// unknown as "offline" would call every personal machine dead.
    #[test]
    fn a_personal_box_is_not_reported_as_offline() {
        let rows = merge(
            &[machine("my-box", "/srv/alpha")],
            &[],
            &naridon(),
            &directory(),
        );
        assert_eq!(rows[0].online, None);
        assert!(rows[0].agents.is_empty());
    }

    /// Places you can enter come first; the ones you'd have to connect are
    /// ordered by whether they're worth connecting.
    #[test]
    fn rows_you_can_open_lead_and_live_ones_lead_the_rest() {
        let mut down = runner("r-down", "sleepy-box", Some("u-ana"));
        down.online = false;
        let rows = merge(
            &[machine("my-box", "/srv/alpha")],
            &[down, runner("r-up", "awake-box", Some("u-ana"))],
            &naridon(),
            &directory(),
        );
        let names: Vec<&str> = rows.iter().map(|r| r.name.as_str()).collect();
        assert_eq!(names, ["my-box", "awake-box", "sleepy-box"]);
    }

    /// Two registrations under one name in one org are one place. They are
    /// already indistinguishable everywhere else in the app, and two identical
    /// rows in a list you pick from is worse than one.
    #[test]
    fn one_name_on_the_board_is_one_row() {
        let rows = merge(
            &[],
            &[
                runner("r-new", "team-box", Some("u-ana")),
                runner("r-old", "team-box", Some("u-ana")),
            ],
            &naridon(),
            &directory(),
        );
        assert_eq!(rows.len(), 1);
        assert_eq!(rows[0].runner_id.as_deref(), Some("r-new"));
    }

    /// An org whose display name never arrived. "Owned by" followed by nothing
    /// is worse than a vague truth.
    #[test]
    fn an_org_with_no_name_is_still_named_on_the_row() {
        let mut org = naridon();
        org.name = None;
        let rows = merge(&[], &[runner("r1", "team-box", None)], &org, &directory());
        assert_eq!(rows[0].owner.label, "naridon");

        org.slug = None;
        let rows = merge(&[], &[runner("r1", "team-box", None)], &org, &directory());
        assert_eq!(rows[0].owner.label, "your org");
    }

    /// The claim this list has to keep: it SHOWS the book, it does not spread
    /// it. A row for a place the org's board knows carries no address at all,
    /// and no row anywhere carries a key path — the one fact in that `0600`
    /// file that has no business on a screen somebody can look over.
    #[test]
    fn a_row_never_carries_a_key_path_off_this_laptop() {
        let rows = merge(
            &[machine("team-box", "/srv/alpha")],
            &[runner("r1", "team-box", Some("u-ana"))],
            &naridon(),
            &directory(),
        );
        let json = serde_json::to_string(&rows).expect("rows serialise");
        // The book row travels whole to the surface that has to open it — that
        // is this laptop's own renderer — but it is the ONLY carrier, so there
        // is exactly one place to look when asking what leaves the book.
        assert_eq!(json.matches("key_path").count(), 1);

        let org_only = merge(&[], &[runner("r1", "team-box", None)], &naridon(), &directory());
        let json = serde_json::to_string(&org_only).expect("rows serialise");
        assert!(
            !json.contains("key_path") && !json.contains("10.0.0.4"),
            "an org place we have no address for must not acquire one: {json}",
        );
    }
}
