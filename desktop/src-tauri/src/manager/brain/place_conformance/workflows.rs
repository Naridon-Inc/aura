//! The workflows, as questions put to the contract.
//!
//! Each function here is asked of every mode in the table and has no idea which
//! one it is holding. That is enforced rather than encouraged: the parent module
//! reads this file's own source and fails the suite if a check reaches for a
//! variant of the place enum. A check that knew which mode it was answering
//! would go on passing while the two of them drifted apart, which is the exact
//! failure the matrix exists to catch.
//!
//! Where a workflow genuinely turns on one of the four things a mode is allowed
//! to differ on, it asks the contract: `identity().host` for "is this somewhere
//! you dial", `billing()` for "did Aura make this and does Aura charge for it".
//! Those two questions are what separate a box Aura dials from a box Aura made,
//! and they are why the managed row — when it lands — turns the two amber cells
//! green without a line changing in this file.

use aura_egress::{Egress, Guard, Phase};
use aura_env::{EnvReport, EnvSpec, Plan, Scope, StepOutcome, StepState, TrustState};

use crate::cloudbox::managed_key;
use crate::cloudbox::script;
use crate::cmd_machines::visible_in;

use super::super::place_account::{provision_script, AccountPlan};
use super::super::place_base::layers::{PRIVATE, SHARED};
// Named apart because `crate::cloudbox::script` is already `script` here, and
// because what these two render is not a place's transport but a place's
// stockroom.
use super::super::place_base::script::{base_script, branch_script, STAMP as BASE_STAMP};
use super::super::place_author::{authorship, Author, Authorship, PlaceAuthorFacts};
use super::super::place_agent_key::{
    choose as choose_key, sources as key_sources, AgentKeyAsk, OrgKeyring, PlaceKeyFacts,
};
use super::super::place_contract::{Capabilities, Open, Shell};
use super::super::place_drift::Standing;
use super::super::place_egress::{agent_phase_of, run_name};
use super::super::place_env::Declared;
use super::super::place_git::{
    choose, sources, AgentFacts, CredentialAsk, PlaceGitFacts, StoreFile,
};
use super::super::place_projects::{narrow, OrgIndex};
use super::super::place_sleep::sleeping_of;
use super::super::place_wake::waking_of;
use super::super::place_toolbox::{install_dirs, install_path, install_script, Ask};
// Aliased because `aura_env` above has a `Scope` of its own, and the two mean
// different things: one is how far an env spec's declaration reaches, the other
// is whose home a tool's directory is in. Spelled the same here, whichever was
// imported second would silently win.
use super::super::place_toolchain::{profile_block, scope_of, Scope as ToolScope, SCOPED};
use super::{
    Mode, Outcome, Workflow, ALPHA, BETA, MEMBER, ORG, OTHER_ORG, REMOTE, SSH_REMOTE, TEAMMATE,
};

/// The check for one workflow.
///
/// A `match` rather than a field on the workflow so that adding a case to the
/// enum fails to compile until it has a check — a workflow in the list with
/// nothing behind it would be a green cell that asks nothing.
pub(super) fn check(w: Workflow) -> super::Check {
    match w {
        Workflow::W1 => open_a_project,
        Workflow::W2 => new_chat,
        Workflow::W3 => new_workspace,
        Workflow::W4 => several_workspaces_on_one_place,
        Workflow::W5 => several_places_from_one_laptop,
        Workflow::W6 => pick_which_org_i_act_as,
        Workflow::W7 => an_org_place_offers_only_that_orgs_projects,
        Workflow::W8 => personal_and_self_setup_keep_working,
        Workflow::W9 => reach_it_with_zero_ssh,
        Workflow::W10 => push_as_myself,
        Workflow::W11 => install_without_breaking_a_teammate,
        Workflow::W12 => my_spend_apart_from_my_teammates,
        Workflow::W13 => sleep_on_idle_and_wake_on_demand,
        Workflow::W14 => what_it_has_against_what_is_asked_for,
        Workflow::W15 => an_agent_that_cannot_reach_the_whole_network,
    }
}

/// W1 — open a project.
///
/// Two things, and the second is the one that is easy to lose: a terminal that
/// starts in the project, and the project's *records* still on this laptop. The
/// code is wherever the place keeps it; the intent log, the task board, the Pages
/// and the session file are under `.aura/` on this disk, for this project. A
/// place that moved those would have moved your history onto a machine you might
/// give back at the end of the month.
fn open_a_project(mode: &Mode) -> Result<Outcome, String> {
    let place = mode.place(&ALPHA);
    let shell = place
        .open(&Open::Shell { session: None })
        .map_err(|e| format!("no terminal here: {e}"))?;
    ensure(!shell.program.is_empty(), "a place that says to spawn nothing")?;
    let line = command_body(&shell)?;
    ensure(
        line.contains(place.root()),
        format!("the terminal does not start in {}", place.root()),
    )?;
    ensure(
        place.here() == ALPHA.here,
        format!(
            "the project's records moved to {} — they belong on this laptop",
            place.here()
        ),
    )?;
    Ok(Outcome::Met(format!(
        "`{}` opens {} and the project's records stay at {}",
        shell.program,
        place.root(),
        place.here()
    )))
}

/// W2 — new chat.
///
/// A conversation is an agent in the project, plus the first thing said to it.
/// Both have to survive the trip: a prompt that arrives mangled is a chat that
/// starts by doing the wrong thing. And a place without that agent has to say so
/// in a sentence — `command not found` and a window that closes is the same
/// information delivered as a fault.
fn new_chat(mode: &Mode) -> Result<Outcome, String> {
    let place = mode.place(&ALPHA);
    let first_words = "fix the flake in place_env";
    let shell = place
        .open(&Open::Agent {
            bin: "claude".into(),
            args: vec![],
            prompt: Some(first_words.into()),
            session: Some("aura-chat-1".into()),
        })
        .map_err(|e| format!("no agent here: {e}"))?;
    let line = command_body(&shell)?;
    ensure(line.contains("claude"), "the chat's agent isn't in what would run")?;
    ensure(
        line.contains(first_words),
        "the first thing said to the agent did not reach it whole",
    )?;
    // The apostrophe in the sentence comes back escaped, which is why this looks
    // for the halves either side of it: an unescaped one would end the string
    // and run the remainder of the message as a command.
    ensure(
        line.contains("command -v 'claude'") && line.contains("installed here yet"),
        "a place without that agent would close the window instead of saying so",
    )?;
    ensure(
        place.here() == ALPHA.here,
        "a chat on this place files its work somewhere other than your own board",
    )?;
    Ok(Outcome::Met(format!(
        "claude starts in {} with the prompt intact, and the chat files on this laptop",
        place.root()
    )))
}

/// W3 — new workspace.
///
/// A workspace is only a workspace if it outlives the connection that made it.
/// Quit the app, lose wifi in a tunnel, come back tomorrow from another
/// computer — the same running process, or it was never a workspace, it was a
/// window. tmux is that guarantee in both places, including the read-only attach
/// that lets two people watch one agent without typing over each other.
fn new_workspace(mode: &Mode) -> Result<Outcome, String> {
    let place = mode.place(&ALPHA);
    let name = "aura-w3";
    let held = command_body(&place.open(&Open::Shell {
        session: Some(name.into()),
    })?)?;
    ensure(
        held.contains(&format!("tmux new -A -s '{name}'")),
        "the workspace would die with the connection that opened it",
    )?;
    let back = command_body(&place.open(&Open::Attach {
        session: name.into(),
        read_only: false,
    })?)?;
    ensure(
        back.contains(&format!("tmux attach -t '{name}'")),
        "there is no way back into a workspace once you leave it",
    )?;
    let watching = command_body(&place.open(&Open::Attach {
        session: name.into(),
        read_only: true,
    })?)?;
    ensure(
        watching.contains(&format!("tmux attach -r -t '{name}'")),
        "two people could not follow one agent without typing over each other",
    )?;
    Ok(Outcome::Met(format!(
        "`{name}` is held under tmux on {}, re-enterable and watchable",
        place.label()
    )))
}

/// W4 — several workspaces on different projects on one place.
///
/// One machine, two pieces of work. The claim has two halves and both are easy
/// to get wrong: the two workspaces must not land on top of each other, and they
/// must still be *one place* — same address, one machine's worth of resources —
/// rather than the app quietly treating a second project as a second box.
fn several_workspaces_on_one_place(mode: &Mode) -> Result<Outcome, String> {
    let alpha = mode.place(&ALPHA);
    let beta = mode.place(&BETA);
    ensure(
        alpha.root() != beta.root(),
        "two projects on one place share a working directory",
    )?;
    ensure(
        alpha.identity().address == beta.identity().address,
        "a second project on one place answered as though it were a different place",
    )?;
    // The same nonce on both, so any difference in the names has to come from
    // the directory rather than from the randomness that is there to stop two
    // *simultaneous* starts colliding.
    let one = script::session_name("shell", alpha.root(), "fixed");
    let two = script::session_name("shell", beta.root(), "fixed");
    ensure(
        one != two,
        "two workspaces on one place would be handed the same tmux session",
    )?;
    for (place, project) in [(&alpha, &ALPHA), (&beta, &BETA)] {
        let line = command_body(&place.open(&Open::Shell { session: None })?)?;
        ensure(
            line.contains(place.root()),
            format!("the workspace for {} opens somewhere else", project.here),
        )?;
    }
    Ok(Outcome::Met(format!(
        "{} and {} are two sessions on one address",
        alpha.root(),
        beta.root()
    )))
}

/// W5 — several places from one laptop.
///
/// Nothing global decides which machine is "current". Each place carries
/// everything needed to reach it, so two of them are two values held at once,
/// and the terminal you get depends on the one you asked rather than on the one
/// something last set.
fn several_places_from_one_laptop(mode: &Mode) -> Result<Outcome, String> {
    let mine = mode.place(&ALPHA);
    let theirs = super::neighbour();
    ensure(
        mine.identity().address != theirs.identity().address,
        "two places this laptop holds at once share one address",
    )?;
    let one = mine.open(&Open::Shell { session: None })?;
    let two = theirs.open(&Open::Shell { session: None })?;
    ensure(
        one != two,
        "two different places produced the same terminal",
    )?;
    ensure(
        mine.here() != theirs.here(),
        "two places file their records under the same project on this disk",
    )?;
    Ok(Outcome::Met(format!(
        "{} and {} are held side by side, each opened by what it carries",
        mine.label(),
        theirs.label()
    )))
}

/// W6 — pick which org I act as.
///
/// Acting as an org is a hat, not a move. It changes which places are *offered*;
/// it must never change what a place IS, or an open workspace would stop being
/// reachable the moment somebody looked at another team's board.
fn pick_which_org_i_act_as(mode: &Mode) -> Result<Outcome, String> {
    let under_ours = mode.place(&ALPHA).identity();
    let under_theirs = mode.place_in(&ALPHA, Some(OTHER_ORG)).identity();
    ensure(
        under_ours.user == under_theirs.user
            && under_ours.host == under_theirs.host
            && under_ours.key_path == under_theirs.key_path
            && under_ours.address == under_theirs.address,
        "acting as another org changed how this place is reached",
    )?;

    match (mode.row)(Some(ORG)) {
        Some(row) => {
            ensure(
                visible_in(&row, Some(ORG)),
                "a place vanished from the very org it was connected under",
            )?;
            ensure(
                !visible_in(&row, Some(OTHER_ORG)),
                "a place followed you into an org it does not belong to",
            )?;
            // Signed out there is no hat to wear, and with no org to act as
            // every machine is yours to see.
            ensure(
                visible_in(&row, None),
                "signing out hid a machine you can still reach",
            )?;
            Ok(Outcome::Met(format!(
                "filed under {ORG}, hidden while acting as {OTHER_ORG}, and reached the same way either way"
            )))
        }
        None => {
            // This laptop is not in the machine book at all, which is why no org
            // filter reaches it — not because anything remembered to exempt it.
            ensure(
                under_ours.address.is_none(),
                "this laptop was given an address for an org to file it under",
            )?;
            Ok(Outcome::Met(
                "this laptop is in no org's book, so no switch can take it away".into(),
            ))
        }
    }
}

/// W7 — an org place offers only that org's projects.
///
/// Two questions, one sentence. Which *places* you are offered while acting as
/// an org, and — once you are inside one — which of the projects on its disk it
/// offers you. The second is the one a shared runner forces: a box discovers
/// projects box-wide, so two orgs' work sits under one listing, and a picker
/// that draws all of it hands a contractor the repo names of their client's
/// other clients.
///
/// Two ways each goes wrong. A place (or a project) from another org appearing
/// is the obvious one; a place from *before* orgs existed disappearing is the
/// one that ships, because it looks like tightening. So both are asked here, in
/// both directions.
fn an_org_place_offers_only_that_orgs_projects(mode: &Mode) -> Result<Outcome, String> {
    let place = mode.place(&ALPHA);
    // One project, spelled twice: where this laptop keeps it and where the place
    // keeps it. A place holding one repo on this disk and another on itself
    // would be a box filed under a project it has never seen.
    ensure(
        leaf(place.root()) == leaf(place.here()),
        format!(
            "this place holds {} on itself but is filed under {}",
            place.root(),
            place.here()
        ),
    )?;

    // The box every member of two orgs eventually shares: one disk, both orgs'
    // checkouts on it, discovered together because that is how discovery works.
    let on_disk = [
        held(ALPHA.there, &format!("https://github.com/{ORG}/alpha.git")),
        held(BETA.there, &format!("https://github.com/{OTHER_ORG}/beta.git")),
    ];
    let registry = [
        listed(&format!("{ORG}/alpha"), ORG),
        listed(&format!("{OTHER_ORG}/beta"), OTHER_ORG),
    ];

    // Asked of the contract rather than of the variant: a place says which org
    // it was connected under, and a place with none is not narrowed at all.
    match place.org() {
        Some(org) => {
            let mine = narrow(&on_disk, &OrgIndex::from_repos(org, &registry));
            ensure(
                mine.projects.iter().all(|p| p.path == ALPHA.there),
                format!("this {org} place offered a project belonging to {OTHER_ORG}"),
            )?;
            ensure(
                mine.projects.len() == 1,
                format!("this {org} place stopped offering its own project"),
            )?;
            // Held back is not hidden. The person reading a shorter list is the
            // one who knows the repo is there, and silence is indistinguishable
            // from a box that has quietly lost half its checkouts.
            ensure(
                mine.withheld.len() == 1 && !mine.withheld[0].reason.trim().is_empty(),
                "a project was left off the list without saying which, or why",
            )?;
            ensure(
                !mine.notice.trim().is_empty(),
                "a narrowed list said nothing about what it left out",
            )?;
            // The same disk, read as the other org: each member gets their own,
            // which is the whole claim and not merely "one of them gets less".
            let theirs = narrow(&on_disk, &OrgIndex::from_repos(OTHER_ORG, &registry));
            ensure(
                theirs.projects.iter().all(|p| p.path == BETA.there) && theirs.projects.len() == 1,
                format!("a {OTHER_ORG} member on this place was not offered {OTHER_ORG}'s project"),
            )?;
            // Signed out, offline, or an org server having a bad afternoon. A
            // filter that failed closed here would show an empty machine to
            // somebody whose wifi dropped.
            let offline = narrow(&on_disk, &OrgIndex::blocked(org, "Connection refused"));
            ensure(
                offline.projects.len() == on_disk.len(),
                "a laptop that could not reach the org emptied a live machine",
            )?;
            ensure(
                offline.notice.contains("Connection refused"),
                "the list stopped being narrowed and did not say why",
            )?;

            let elsewhere = (mode.row)(Some(OTHER_ORG))
                .ok_or("a mode with a place in one org but none in another")?;
            ensure(
                !visible_in(&elsewhere, Some(ORG)),
                "a place belonging to another org was offered anyway",
            )?;
            let unattributed = (mode.row)(None)
                .ok_or("a mode with a book row under an org but none without one")?;
            ensure(
                visible_in(&unattributed, Some(ORG)),
                "a place connected before orgs existed vanished on upgrade",
            )?;
            ensure(
                narrow(&on_disk, &OrgIndex::unfiled()).projects.len() == on_disk.len(),
                "a place connected before orgs existed lost its projects on upgrade",
            )?;
            Ok(Outcome::Met(format!(
                "while acting as {ORG}: only {ORG}'s places are offered, and inside one only \
                 {ORG}'s projects — with {} said out loud and an unattributed place untouched",
                mine.withheld[0].reason
            )))
        }
        None => {
            ensure(
                place.identity().address.is_none(),
                "this laptop was given an address, so an org filter can reach it",
            )?;
            // Nothing files this laptop under an org, so nothing narrows it.
            // Your own disk holds your own projects in every org you act as.
            let here = narrow(&on_disk, &OrgIndex::unfiled());
            ensure(
                here.projects.len() == on_disk.len() && here.withheld.is_empty(),
                "an org filter reached this laptop and took projects off your own disk",
            )?;
            ensure(
                here.notice.is_empty(),
                "this laptop explained a filter it never applied",
            )?;
            Ok(Outcome::Met(
                "the projects here are the ones on this disk, and they are yours in every org".into(),
            ))
        }
    }
}

/// A project sitting on a place, as its listing reports one.
fn held(path: &str, remote: &str) -> crate::cloudbox::domain::BoxProject {
    crate::cloudbox::domain::BoxProject {
        path: path.into(),
        name: leaf(path).into(),
        remote: Some(remote.into()),
        branch: Some("main".into()),
        dirty: 0,
    }
}

/// A project on an org's registry, as the cross-org repo read returns one.
fn listed(full_name: &str, org: &str) -> crate::cloud_org::CloudRepo {
    crate::cloud_org::CloudRepo {
        id: format!("r-{full_name}"),
        full_name: full_name.into(),
        org_id: format!("o-{org}"),
        org_slug: org.into(),
        org_name: org.into(),
    }
}

/// W8 — personal and self-setup keep working.
///
/// The whole org apparatus arrived after people were already using this. A place
/// with no org recorded — a book row written before the field existed, a box
/// somebody set up for themselves one afternoon — has to keep opening, signed in
/// or out, and the contract still has to name who pays for it.
fn personal_and_self_setup_keep_working(mode: &Mode) -> Result<Outcome, String> {
    if let Some(row) = (mode.row)(None) {
        ensure(
            visible_in(&row, Some(ORG)),
            "a self-set-up place vanished the moment you acted as an org",
        )?;
        ensure(
            visible_in(&row, None),
            "a self-set-up place vanished when you signed out",
        )?;
    }
    let place = mode.place_in(&ALPHA, None);
    place
        .open(&Open::Shell { session: None })
        .map_err(|e| format!("a place with no org would not open: {e}"))?;
    let (payer, _) = place.billing();
    ensure(
        !payer.is_empty(),
        "a place that will not say whose bill it is",
    )?;
    Ok(Outcome::Met(format!(
        "opens with no org and nobody signed in; the bill is {payer}'s"
    )))
}

/// W9 — an admin turns cloud on for a member, who then reaches it with zero SSH.
///
/// "Zero SSH" is not "no ssh happens". It is that the member never configures
/// one, never types one and never holds a key: everything needed to reach the
/// place is already inside the thing the seam hands the pty layer. Which is also
/// why this is spawned as argv rather than assembled into a line — a key path
/// with a space in it splits an argument, and a backtick in a host runs a
/// command.
///
/// The identity is the one thing here with two spellings, and they are two
/// arguments to the same call rather than two ways of connecting: a key this
/// laptop holds is named with `-i`, and a key AURA holds is reached through a
/// local agent — the same option a hardware token uses, and the reason ssh needs
/// no file. Which of the two applies is read off the key reference itself, never
/// off the mode: who holds the key is one of the four things a mode may differ
/// on, and this workflow is precisely the claim that the member holds neither.
///
/// A laptop that cannot put that agent up is a third outcome and it is still the
/// contract kept, because the promise was never "an agent" — it was that nothing
/// is ever asked of the member. A refusal that names the machine is asking them
/// nothing. Dialling anyway and letting the far side say `Permission denied` is.
fn reach_it_with_zero_ssh(mode: &Mode) -> Result<Outcome, String> {
    let place = mode.place(&ALPHA);
    let shell = place
        .open(&Open::Shell { session: None })
        .map_err(|e| format!("nothing to spawn: {e}"))?;
    ensure(
        !shell.program.is_empty() && !shell.args.is_empty(),
        "a place that hands back nothing to run",
    )?;
    ensure(
        !shell.args.iter().any(|a| a.contains("PRIVATE KEY")),
        "key material was put in an argument instead of a key path",
    )?;
    let id = place.identity();
    match (id.host.as_deref(), id.key_path.as_deref()) {
        (Some(host), Some(key)) => {
            ensure(!host.trim().is_empty(), "a place you dial that has no host")?;
            let named = if managed_key::is_managed(key) {
                // A reference is not a path and there is no file behind it
                // anywhere on this disk, so `-i` would send ssh looking for a
                // key that was never meant to exist — and the member, who was
                // never given one, would read the missing file as a broken box.
                ensure(
                    !shell.args.iter().any(|a| a == "-i"),
                    "a key Aura holds was handed to ssh as though it were a path on this laptop",
                )?;
                ensure(
                    !shell.args.iter().any(|a| a.contains(key)),
                    "the name of a key Aura holds was put on a command line",
                )?;
                // What stands in for the key file: a local agent this laptop
                // serves for exactly this place, which answers signing
                // challenges by asking Aura. Named here because "the member
                // configures nothing" is only true if something else does — an
                // argv with no identity in it at all would pass every other line
                // of this check and open nothing. What that agent may then offer
                // is the door's own business and is proved there, in
                // `cloudbox::managed_key`.
                //
                // The second half is not a loophole in the first. This laptop
                // cannot always put that agent up — no home directory, or a home
                // whose path leaves no room under the length limit a unix socket
                // has — and *that* is the case the promise is really about: the
                // member is told, by name, before anything is dialled, instead of
                // waiting out a connection that comes back as
                // `Permission denied (publickey)` and reads as the box having
                // stopped trusting them. An identity or a sentence. What is
                // refused is the silent third option.
                let served = shell.args.iter().any(|a| a.starts_with("IdentityAgent="));
                let refused = (mode.row)(Some(ORG))
                    .as_ref()
                    .and_then(managed_key::unbrokerable)
                    .is_some();
                ensure(
                    served || refused,
                    "nothing in what is spawned says how to authenticate and nothing refused \
                     in words, so this laptop dials a place whose key it was never given and \
                     finds out at the far end",
                )?;
                if served {
                    "a local connection that borrows a key Aura holds"
                } else {
                    "no key at all, and a refusal naming the machine because this laptop \
                     cannot serve the local connection that would stand in for one"
                }
            } else {
                ensure(
                    shell.args.iter().any(|a| a == "-i"),
                    "the member would have to put this machine in their own ssh config",
                )?;
                ensure(
                    shell.args.iter().any(|a| a == key),
                    "the place's own key is not the one used to reach it",
                )?;
                "the path to the key on this laptop"
            };
            ensure(
                shell.args.iter().any(|a| *a == format!("{}@{host}", id.user)),
                "the login and the host were assembled into a line rather than passed as one argument",
            )?;
            ensure(
                shell.cwd.is_none(),
                "a directory on the box was handed to a process starting on this disk",
            )?;
            Ok(Outcome::Met(format!(
                "the login and the host are inside what is spawned, with {named} — \
                 {MEMBER} configures nothing"
            )))
        }
        (None, None) => {
            ensure(
                id.address.is_none(),
                "this laptop was given an address to dial",
            )?;
            ensure(
                shell.cwd.is_some(),
                "a local terminal with nowhere to start",
            )?;
            // Still a real terminal in the project, not a stub that answers the
            // shape of the question and none of it.
            ensure(
                command_body(&shell)?.contains(place.root()),
                "the local terminal does not start in the project",
            )?;
            Ok(Outcome::Met(
                "nothing to dial and no key to hold: the work runs where the app is".into(),
            ))
        }
        _ => Err("a place with a host and no key, or a key and no host — one of them is invented".into()),
    }
}

/// W10 — push a commit as myself on a shared place.
///
/// The bug this is against: `provision.sh` writes one token into
/// `~/.git-credentials` for the whole machine, a bare `git push` inherits it, and
/// the first anyone learns whose it was is a commit on GitHub with the wrong name
/// against it. So the member's own credential must win when they have one, the
/// box's must announce itself as everybody's when they do not, and the reason
/// must be sayable either way.
fn push_as_myself(mode: &Mode) -> Result<Outcome, String> {
    let place = mode.place(&ALPHA);
    let ask = CredentialAsk::new(MEMBER, REMOTE).map_err(|e| e.to_string())?;
    let facts = PlaceGitFacts {
        place: place.label().into(),
        you: MEMBER.into(),
        member_present: true,
        member_store: StoreFile {
            path: format!("/home/{MEMBER}/.git-credentials"),
            exists: true,
            holds: Some(true),
            mode: "-rw-------".into(),
            owner: MEMBER.into(),
        },
        helper: "store".into(),
        helper_origin: "file:/etc/gitconfig".into(),
        // What provisioning left behind: readable by everyone with a shell here.
        default_store: StoreFile {
            path: "/home/ubuntu/.git-credentials".into(),
            exists: true,
            holds: Some(true),
            mode: "-rw-r--r--".into(),
            owner: "ubuntu".into(),
        },
        // Nobody lent this place an agent, which is what every place looks like
        // until a member decides otherwise. The ssh half below turns it on.
        agent: AgentFacts::default(),
    };

    let plan = choose(&ask, &facts, sources(None));
    let mine = plan
        .credential
        .ok_or("a place holding the member's own credential chose nothing")?;
    ensure(
        !mine.shared,
        format!("a push would land under {} rather than under {MEMBER}", mine.label),
    )?;
    ensure(
        mine.source == "member-store",
        format!("the member's own credential lost to {}", mine.source),
    )?;
    // `credential.helper` is a list, so naming ours without clearing it first
    // would leave the box's answering before ours and change nothing at all.
    ensure(
        mine.git_config_args()
            .contains(&"credential.helper=".to_string()),
        "the place's existing helper would still be asked first",
    )?;

    // The same place before the member has an account on it.
    let bare = PlaceGitFacts {
        member_present: false,
        member_store: StoreFile::default(),
        ..facts.clone()
    };
    let fallback = choose(&ask, &bare, sources(None));
    let box_wide = fallback
        .credential
        .ok_or("a place with a machine-wide credential offered nothing at all")?;
    ensure(
        box_wide.shared,
        "a credential everybody on this place can use did not admit that it is everybody's",
    )?;
    ensure(
        box_wide.last_resort,
        "the machine-wide credential was not demoted behind the member's own",
    )?;
    ensure(
        fallback.considered.iter().any(|c| !c.held && !c.why.is_empty()),
        "nothing said why the member's own credential was not the one used",
    )?;

    // The same workflow over ssh, where "as myself" cannot mean a stored token
    // at all. A place the member has NOT opted into forwarding pushes with the
    // place's own key and must say so rather than implying it is theirs.
    let over_ssh = CredentialAsk::new(MEMBER, SSH_REMOTE).map_err(|e| e.to_string())?;
    let unlent = choose(&over_ssh, &facts, sources(None));
    ensure(
        unlent.credential.is_none(),
        "a key nobody lent this place was offered as the member's own",
    )?;
    ensure(
        unlent
            .considered
            .iter()
            .any(|c| c.source == "ssh-agent" && !c.held),
        "nothing said why the push would go out under the place's own key",
    )?;

    // And once they have opted in, their own key is the one that signs — with
    // the key itself never written down here. This is the same `impl` on both
    // place-modes, reading facts the place reported, so neither can gain it
    // without the other.
    let lent = PlaceGitFacts {
        agent: AgentFacts {
            socket: "/tmp/ssh-lent/agent.11".into(),
            reachable: true,
            keys: 1,
            fingerprints: vec!["SHA256:the-members-own-key".into()],
            // The comparison `Place::push_credential` makes: this laptop's agent
            // holds the same key, which is what "forwarded" means and what an
            // agent the machine runs itself would fail.
            mine: true,
        },
        ..facts
    };
    let signed = choose(&over_ssh, &lent, sources(None))
        .credential
        .ok_or("a place lent the member's agent still pushed with its own key")?;
    ensure(
        signed.source == "ssh-agent" && !signed.shared && !signed.last_resort,
        format!("a push over ssh would go out as {} rather than as {MEMBER}", signed.label),
    )?;
    ensure(
        signed.git_config_args().is_empty(),
        "a key in an agent was handed to git as a credential helper",
    )?;

    // The other half of "as myself", and a different failure: the credential
    // decides which ACCOUNT the push lands in, the author decides whose NAME is
    // in the commit. A push with the right token and the wrong author is the
    // worse of the two, because no later fix reaches back into history.
    let mine = Author::new(MEMBER, &format!("{MEMBER}@users.noreply.auravcs.com"))
        .map_err(|g| g.to_string())?;
    let git_config = format!("file:{}/.git/config", place.root());
    let holding = |author: Option<Author>, origin: &str| PlaceAuthorFacts {
        place: place.label().into(),
        you: MEMBER.into(),
        root: place.root().into(),
        repo: true,
        local: author.clone(),
        effective: author,
        origin: origin.into(),
        only_config: false,
    };

    ensure(
        authorship(&holding(Some(mine.clone()), &git_config), Some(&mine)).is_mine(),
        "a checkout already carrying the member's own name did not read as theirs",
    )?;

    // What a box provisioned before any of this holds: a well-formed identity
    // that is not a person. It must be named as the machine rather than passed
    // over as "an author is set".
    let baked = Author::new("Aura Runner", "runner@auravcs.com").map_err(|g| g.to_string())?;
    match authorship(&holding(Some(baked), &git_config), Some(&mine)) {
        Authorship::Machine { why, .. } => ensure(
            !why.trim().is_empty(),
            "the machine's own identity was flagged without saying what gave it away",
        )?,
        other => {
            return Err(format!(
                "a commit authored by the box read as {other:?} rather than as the machine"
            ))
        }
    }

    // An identity from no file is one git assembled from the login and the
    // hostname. It is the quietest way to lose the person, and no list of names
    // could have caught it.
    ensure(
        !authorship(&holding(Some(mine.clone()), ""), Some(&mine)).is_mine()
            || mine.email.contains('@'),
        "an invented identity was accepted as the member's own",
    )?;

    // A teammate's identity left in a shared checkout is the ONE case where
    // overwriting unasked would be wrong, so it must not read as the machine.
    let ana = Author::new(TEAMMATE, &format!("{TEAMMATE}@users.noreply.auravcs.com"))
        .map_err(|g| g.to_string())?;
    ensure(
        matches!(
            authorship(&holding(Some(ana), &git_config), Some(&mine)),
            Authorship::Someone { .. }
        ),
        "a teammate's identity was mistaken for the machine's",
    )?;

    // Nothing at all is an answer too — and the reason git would refuse has to
    // be sayable, or a member is told only that something went wrong.
    match authorship(&holding(None, ""), Some(&mine)) {
        Authorship::Missing { why } => ensure(
            !why.trim().is_empty(),
            "a checkout with no author gave no reason",
        )?,
        other => return Err(format!("a checkout with no identity read as {other:?}")),
    }

    Ok(Outcome::Met(format!(
        "{MEMBER}'s own credential wins on {}, and the commit carries {MEMBER}'s own name — \
         the box's own identity is named as the machine rather than passed off as a person",
        place.label()
    )))
}

/// W11 — install a package without breaking a teammate.
///
/// Asked of the seam that makes accounts, because that is where the separation
/// either exists or does not. A place that will provision has to give each member
/// their own home closed to the others, their own key file, their own umask and
/// their own runner config *before* it is allowed to say anything about how
/// strong the boundary is.
///
/// How strong it is, is then the place's own promise: only a place Aura made can
/// offer a kernel boundary. A box that promises ssh, tmux and git gives a Unix
/// one — which is real, and is not the same thing.
///
/// Then the install, because separated accounts that share one `npm install -g`
/// have separated nothing this workflow is about. [`super::super::place_toolbox`]
/// is asked for the real thing both members would run: it must want no root, it
/// must write nowhere but the member's own home, and the two members must
/// resolve tools off two different prefixes — otherwise the second install is
/// the first one's replacement and the teammate finds out at the worst moment.
fn install_without_breaking_a_teammate(mode: &Mode) -> Result<Outcome, String> {
    let place = mode.place(&ALPHA);
    let asked = AccountPlan {
        login: MEMBER.into(),
        public_key: Some("ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAI mo@laptop".into()),
        may_provision: true,
    };
    let plan = place.account_plan(&asked);
    let script_text = provision_script(&plan);

    if !plan.may_provision {
        // The place answered "there is nobody here to separate you from", and
        // that answer has to be a read-out and nothing else. `useradd` behind a
        // button meant for shared hardware, on the computer somebody is sitting
        // at, is an accident waiting for a caller that passed the wrong login.
        ensure(
            plan.public_key.is_none(),
            "this place was handed a key that would let somebody else in",
        )?;
        ensure(
            script_text.contains("PROVISION=no"),
            "asking who I am here would have changed this place",
        )?;
        return Ok(Outcome::Met(format!(
            "one member works on {}, so an install changes one environment and it is theirs",
            place.label()
        )));
    }

    for (needed, complaint) in [
        ("chmod 700 '$HOME_DIR'", "a member's home is readable by the others"),
        ("umask 077", "files a member creates later would be everybody's"),
        (
            "chmod 600 '$HOME_DIR/.ssh/authorized_keys'",
            "a member's key file is writable by the others",
        ),
        (
            "$HOME_DIR/.config/aura",
            "the member's runner token would not be in their own home",
        ),
    ] {
        ensure(script_text.contains(needed), complaint)?;
    }
    // Separation is not only about reading each other's files. A member who can
    // take every page of memory on the box has broken the other member's work
    // just as completely as one who overwrote their toolchain — and does it
    // without touching a single file of theirs. The runner's own unit carries
    // the per-member ceilings (see the CLI's `runner_limits`); what has to
    // happen *here*, because this is the one step that runs with root on every
    // kind of place, is giving the box somewhere to swap to. Without it a
    // ceiling turns an overshooting build into a killed one rather than a slow
    // one, which is the 2026-08-04 wedge with a different last line.
    ensure(
        script_text.contains("SWAP=") && script_text.contains("mkswap"),
        "this place would leave a box with no swap, so a member reaching their \
         memory limit is killed rather than slowed",
    )?;

    let theirs = place.account_plan(&AccountPlan {
        login: TEAMMATE.into(),
        ..asked
    });
    ensure(
        theirs.login != plan.login,
        "two members here would end up owning one account",
    )?;

    // A private home stops a teammate READING your things. It does not stop
    // their `npm install -g` OVERWRITING them: npm's prefix defaults to
    // /usr/local however locked down the homes are. So the toolchain has to be
    // scoped as well as the home closed, and the two are checked apart because
    // they fail apart.
    ensure(
        script_text.contains("AURA_TOOLCHAIN_BLOCK="),
        "a member's global installs would still land wherever the tools default to",
    )?;
    for s in SCOPED {
        ensure(
            script_text.contains(&format!("{}=\"$HOME/{}\"", s.var, s.under)),
            format!("{} is not scoped to the member, so {}", s.var, s.collides),
        )?;
    }
    // Against `$HOME`, never a baked path — the profile is read by the member's
    // own login shell, and a path resolved at provisioning time would hand every
    // member whichever home the wizard happened to be run from.
    ensure(
        !profile_block().contains(&format!("/home/{MEMBER}")),
        "one member's home was baked into the block every member reads",
    )?;

    // The claim itself, put as a question about two people rather than one: the
    // same block, read by two members, has to resolve to two sets of directories
    // with nothing in common.
    for s in SCOPED {
        let mine = s.path_under(&format!("/home/{MEMBER}"));
        let theirs = s.path_under(&format!("/home/{TEAMMATE}"));
        ensure(
            scope_of(&s, &mine, &format!("/home/{MEMBER}")) == ToolScope::Mine,
            format!("{}'s own {} did not read as theirs", MEMBER, s.tool),
        )?;
        ensure(
            scope_of(&s, &theirs, &format!("/home/{MEMBER}")).collides(),
            format!(
                "{TEAMMATE}'s {} was not reported as a collision for {MEMBER}",
                s.tool
            ),
        )?;
        ensure(
            mine != theirs,
            format!("{MEMBER} and {TEAMMATE} share one {}", s.var),
        )?;
    }

    // Separate accounts and then one shared `npm install -g` would be a
    // separation of nothing that matters, so the install itself is asked for
    // here — the same question the workflow is named for.
    let ask = Ask::tool("npm", "cowsay", Some("1.5.0"));
    let mut prefixes = vec![];
    for who in [MEMBER, TEAMMATE] {
        let home = format!("/home/{who}");
        let script_text = install_script(&home, &ask).map_err(|r| r.to_string())?;
        ensure(
            !script_text.contains("sudo"),
            "installing something for one member asks for root",
        )?;
        for dir in install_dirs(&home) {
            ensure(
                dir.starts_with(&format!("{home}/")),
                "a member's install writes outside their own home",
            )?;
        }
        prefixes.push(install_path(&home));
    }
    ensure(
        prefixes[0] != prefixes[1],
        "both members resolve tools off one prefix, so the second install replaces the first",
    )?;

    // Separation has a bill, and this is where it comes due. Two members with
    // two of everything means the second one's `CARGO_HOME` starts empty, and
    // on a place whose spec asks for a rust toolchain that is the whole install
    // again — the same bytes, over the same network, onto the same machine. A
    // place that separated its members and made the second one pay for it twice
    // has not finished this workflow; it has traded one way of ruining a
    // teammate's afternoon for another.
    let base = place.base_plan();
    let built = base_script(&base);
    let mine_branch = place.branch_plan(MEMBER);
    let their_branch = place.branch_plan(TEAMMATE);
    ensure(
        mine_branch.base_login == base.login && their_branch.base_login == base.login,
        "the two members would build the team's environment twice, once each",
    )?;
    ensure(
        mine_branch.member_login != their_branch.member_login,
        "both members branch into one home, so the second overwrites the first",
    )?;
    ensure(
        base.login.as_deref() != Some(MEMBER) && base.login.as_deref() != Some(TEAMMATE),
        "the thing everybody starts from belongs to one of them",
    )?;
    // Built with the same block every member reads, or the install lands in
    // /usr/local and the base comes up empty however many times it is applied.
    ensure(
        built.contains("AURA_TOOLCHAIN_BLOCK="),
        "the team's environment installs into the machine rather than into itself, \
         so there is nothing in it for a member to start from",
    )?;
    ensure(
        built.contains(BASE_STAMP),
        "nothing records which spec the team's environment was built from, so \
         'already built' could only ever mean 'the directory is there'",
    )?;

    // What comes out of it, and — the part that has to be true before any of the
    // rest is worth having — what does not. The shared half is downloads. Every
    // credential the members were separated for stays where it was.
    let branch = branch_script(&mine_branch);
    for layer in SHARED {
        ensure(
            branch.contains(layer.under),
            format!(
                "{} is not carried across, so the second member re-downloads {}",
                layer.under, layer.holds
            ),
        )?;
    }
    for secret in PRIVATE {
        ensure(
            built.contains(secret.under),
            format!(
                "the team's environment is never checked for {} — {}",
                secret.under, secret.holds
            ),
        )?;
        ensure(
            branch.contains(secret.under),
            format!(
                "{} could ride out of the shared environment into a member's home — {}",
                secret.under, secret.holds
            ),
        )?;
    }
    // And the one honest refusal: `apt` has no per-member spelling, so it says
    // so and names what to do instead rather than reaching for `sudo`.
    let machine_wide = install_script("/home/mo", &Ask::tool("apt", "postgresql", None))
        .err()
        .ok_or("a machine-wide manager was installed as though it were one member's")?;
    ensure(
        machine_wide.to_string().contains("settings.toml"),
        "refusing a machine-wide install says nothing about what to do instead",
    )?;

    let (_, aura_made_it) = place.billing();
    if aura_made_it {
        Ok(Outcome::Met(format!(
            "a kernel boundary around {}, with a Unix boundary per member inside it, each member's toolchain in their own home, an install that lands there without root, and a team environment built once that the second member starts from instead of rebuilding",
            place.label()
        )))
    } else {
        Ok(Outcome::NotPromised(format!(
            "{MEMBER} and {TEAMMATE} each get their own home at 0700 on {}, their own authorized_keys at 0600, umask 077 and their own GH_CONFIG_DIR, CARGO_HOME, RUSTUP_HOME, npm prefix and PYTHONUSERBASE — so each installs into their own prefix without root, two versions of one tool coexist, and neither member is the other's problem. Separate does not mean starting from nothing: the project's declared environment is built once in an account that belongs to nobody, holds no credential of anybody's, and each member's caches are branched from it, so the first member pays the install and the second pays a file copy. They still share one kernel and one /usr, and a system package manager is still system-wide, which is why `apt` is refused with a sentence rather than run",
            place.label()
        )))
    }
}

/// The credential facts a place reports about one member who has a key of their
/// own: their file, in their own home, closed to everybody else — beside a place
/// that also holds one for everyone.
///
/// A fixture rather than a live survey, for the same reason
/// [`PlaceGitFacts`] is one three workflows up: the resolver is pure and the
/// survey is one script both modes are sent, so what a column has to prove is
/// what this place would DECIDE from a given report. That the two modes report
/// in the same words is proved where it can be — `place_agent_key` runs the
/// whole survey through the local arm and parses it with the same parser.
fn key_facts(place: &str, who: &str, holds: Option<bool>) -> PlaceKeyFacts {
    PlaceKeyFacts {
        place: place.to_string(),
        you: who.to_string(),
        member_present: true,
        member_login: StoreFile::default(),
        member_key: StoreFile {
            path: format!("/home/{who}/.config/aura/agent.env"),
            exists: holds.is_some(),
            holds,
            mode: "-rw-------".into(),
            owner: who.into(),
        },
        // What `provision.sh` leaves behind, and what every agent on a runner has
        // been spending: one key, loaded for the unit, the same for everybody.
        place_key: StoreFile {
            path: "/etc/aura-runner/agent.env".into(),
            exists: true,
            holds: Some(true),
            mode: "-rw-------".into(),
            owner: "root".into(),
        },
        env_holds: true,
    }
}

/// W12 — see my spend separately from my teammate's.
///
/// Spend lands on the person, never on the machine. That needs three things from
/// this seam and none of them is the counting itself: the place has to name who
/// the bill goes to, two members on one place have to be two identities before
/// anything is added up, and — the part a ledger cannot recover afterwards — the
/// two of them have to be spending two different credentials. A place where both
/// people are `ubuntu` produces one total no matter how carefully the cloud adds
/// it, and a place where both of them run on the org's one API key produces two
/// totals that are the same money.
fn my_spend_apart_from_my_teammates(mode: &Mode) -> Result<Outcome, String> {
    let place = mode.place(&ALPHA);
    let (payer, metered) = place.billing();
    ensure(
        !payer.is_empty(),
        "a place that will not say whose bill it is",
    )?;
    // Aura charges for what Aura made and for nothing else. Your own laptop
    // costs electricity and a box you brought costs whoever pays its provider —
    // real bills, just not ours to send.
    let aura_made_it = place.identity().kind == "managed";
    ensure(
        metered == aura_made_it,
        format!(
            "{} is metered as though Aura {} it",
            place.label(),
            if metered { "made" } else { "did not make" }
        ),
    )?;

    let plan_for = |who: &str| AccountPlan {
        login: who.into(),
        public_key: None,
        may_provision: true,
    };
    let mine = place.account_plan(&plan_for(MEMBER));
    let theirs = place.account_plan(&plan_for(TEAMMATE));
    ensure(
        mine.login == MEMBER && theirs.login == TEAMMATE,
        "the place renamed whose spend this is",
    )?;
    ensure(
        mine.login != theirs.login,
        "two members on one place would spend as one identity",
    )?;

    // Two identities is the floor. What actually separates the two bills is which
    // credential each run spends, so the same place is asked about both members
    // and the two answers have to be different keys.
    let label = place.label();
    let org = OrgKeyring::empty(ORG).holding("anthropic", "sk-a••••wxyz");
    let key_for = |who: &str, holds: Option<bool>| -> Result<_, String> {
        let ask = AgentKeyAsk::new(who, "claude").map_err(|gap| gap.to_string())?;
        Ok(choose_key(&ask, &key_facts(label, who, holds), key_sources(org.clone())))
    };

    let my_run = key_for(MEMBER, Some(true))?;
    let their_run = key_for(TEAMMATE, Some(true))?;
    let (mine_key, theirs_key) = match (my_run.key.as_ref(), their_run.key.as_ref()) {
        (Some(a), Some(b)) => (a, b),
        _ => return Err(format!("{label} would start an agent with no credential at all")),
    };
    ensure(
        !mine_key.shared && !theirs_key.shared,
        format!("an agent on {label} runs on a credential that is everybody's"),
    )?;
    ensure(
        mine_key.detail != theirs_key.detail && mine_key.prefix() != theirs_key.prefix(),
        format!("{MEMBER} and {TEAMMATE} would spend one credential on {label}"),
    )?;
    ensure(
        mine_key.spender == MEMBER && theirs_key.spender == TEAMMATE,
        "the place renamed whose tokens these are",
    )?;

    // And the shared keys are still there, still working, and still saying so.
    // Demoted is not removed: a team that pays centrally wants exactly this — it
    // just has to be reached last and named out loud.
    let neither = key_for(MEMBER, None)?;
    let fallback = neither
        .key
        .as_ref()
        .ok_or_else(|| format!("{label} lost the shared credential it has always had"))?;
    ensure(
        fallback.shared && fallback.last_resort,
        format!("{label} hands out an everybody's credential as though it were {MEMBER}'s"),
    )?;
    ensure(
        neither.considered.iter().any(|c| c.source == "org-key" && c.last_resort),
        format!("the org's own key is not a labelled fallback on {label}"),
    )?;
    ensure(
        !neither.note().trim().is_empty() && neither.note().contains(&fallback.spender),
        format!("{label} would spend somebody else's credential without saying whose"),
    )?;

    Ok(Outcome::Met(format!(
        "the bill is {payer}'s, {MEMBER} and {TEAMMATE} are two identities here rather than one \
         login, and an agent each spends their own credential — {}'s key and the org's are \
         reached last and named as everybody's",
        place.label()
    )))
}

/// W13 — sleep on idle and wake on demand.
///
/// The floor first, and it is the same floor for every mode: walking away must
/// not lose the work. Whether the place then *stops costing* while nobody is
/// looking is a lifecycle question, and a lifecycle is only actionable by
/// whoever can act in the account the machine runs in. Aura can act in its own,
/// and in any account whose owner has granted it a role — which is why this cell
/// turns on permission rather than on who bought the hardware.
///
/// The second half used to be a sentence this file wrote about a feature that
/// did not exist. It asks the feature now: every mode is put through the idle
/// policy and has to come back with an answer that agrees with what the cell
/// claims — a place that says "Aura stops me when I am idle" and is not a place
/// Aura can stop is the cell going green on a promise nobody keeps.
fn sleep_on_idle_and_wake_on_demand(mode: &Mode) -> Result<Outcome, String> {
    let place = mode.place(&ALPHA);
    let name = "aura-w13";
    let held = command_body(&place.open(&Open::Shell {
        session: Some(name.into()),
    })?)?;
    ensure(
        held.contains(&format!("tmux new -A -s '{name}'")),
        "work here would not survive being walked away from",
    )?;
    let back = command_body(&place.open(&Open::Attach {
        session: name.into(),
        read_only: false,
    })?)?;
    ensure(
        back.contains("tmux attach"),
        "there would be no way back to what was left running",
    )?;

    // Nothing running on it and nobody on it — the state the whole question is
    // about. Asked of every mode with the same empty list, so the answers differ
    // only where the modes are genuinely allowed to.
    let idle = sleeping_of(&place, Some(&[]));
    ensure(
        !idle.policy.trim().is_empty() && !idle.note.trim().is_empty(),
        format!("{} will not say what happens to it when it is idle", place.label()),
    )?;
    // Never inferred from a failed dial. A place that only discovered it was
    // asleep by failing to reach itself would read as broken on every surface
    // that draws it, which is the bug the state exists to prevent.
    ensure(
        idle.state == "awake" || idle.state == "asleep",
        format!("{} has no word for whether it is asleep", place.label()),
    )?;

    let dialled = place.identity().host.is_some();
    let (payer, aura_made_it) = place.billing();
    // Whether Aura may switch this machine off, which is not the same question
    // as whether Aura made it and stopped being the same question the day a
    // customer could grant a role in their own account. A machine Aura made is
    // always one Aura may stop — that direction is checked below — but the
    // converse is now false, and a cell that still tied the two together would
    // fail the row that proves it.
    let aura_drives_lifecycle = idle.can_sleep;
    ensure(
        !dialled || !aura_made_it || aura_drives_lifecycle,
        format!(
            "Aura made {} and cannot stop it — a machine on Aura's own bill that nothing can \
             switch off",
            place.label()
        ),
    )?;
    ensure(
        dialled || !aura_drives_lifecycle,
        "this laptop says Aura could put it to sleep".to_string(),
    )?;

    // Stopping is only half a lifecycle, and on its own it is a worse place to
    // be than never stopping at all: a machine the member has to learn to get
    // themselves out of. So the other half is asked here too — does reaching
    // this place start it, and does it say how long that takes. The two claims
    // have to agree, because a cell that promises a stop and no start is a cell
    // promising a member a dead box.
    let rousing = waking_of(&place);
    ensure(
        rousing.wakes_on_demand == aura_drives_lifecycle,
        format!(
            "{} says it can{} be put to sleep and that reaching it would{} start it — one of \
             those leaves a member with a box they cannot get back",
            place.label(),
            if aura_drives_lifecycle { "" } else { "not" },
            if rousing.wakes_on_demand { "" } else { " not" }
        ),
    )?;
    ensure(
        rousing.usually > 0 && !rousing.note.trim().is_empty(),
        format!(
            "{} will not say how long it takes to start, so a member waiting on it has nothing but a spinner",
            place.label()
        ),
    )?;

    match (dialled, aura_drives_lifecycle) {
        (false, _) => Ok(Outcome::Met(
            "an idle laptop costs Aura nothing, and the sessions on it are there when you come back"
                .into(),
        )),
        (true, true) => Ok(Outcome::Met(format!(
            "Aura can act in the account this place runs in, so an idle box is stopped and the next thing that reaches it starts it again — about {}s, on {payer}, with no error in between. {}",
            rousing.usually,
            if aura_made_it {
                "Aura made the machine and holds the credential for it."
            } else {
                "The machine and the bill are the customer's; what Aura holds is a role they granted in their own account, which is why the saving lands on their bill rather than ours."
            }
        ))),
        (true, false) => Ok(Outcome::NotPromised(format!(
            "Aura holds no credential for the account {} runs in, so it can neither stop it nor start it: it stays up, on the bill of {payer}. Walking away costs the work nothing — the sessions are tmux and they are there when you come back — but the idle is not free. It says so rather than offering a control that would do nothing: {}",
            place.label(),
            idle.note
        ))),
    }
}

/// W14 — ask a place what it has against what the project asks for.
///
/// The bug this is against is the oldest one there is: "it works on my machine".
/// Two places, one project, one of them fails, and the only way anyone has ever
/// found out why is to sit down on both and type `command -v` until something
/// differs.
///
/// Asked of every mode because a drift report you can only get about a box is
/// worth nothing — the comparison anybody actually wants is the box against the
/// laptop it works on, and that needs both ends to answer the same question in
/// the same shape. So this puts each mode's place deliberately behind the same
/// spec and reads back what it says: the same lines, in the same order, with the
/// same commands attached, differing only in which place it is about.
fn what_it_has_against_what_is_asked_for(mode: &Mode) -> Result<Outcome, String> {
    let place = mode.place(&ALPHA);
    let bins: Vec<String> = ["claude", "codex"].iter().map(|b| b.to_string()).collect();

    // A place short of most of it: no tmux, one agent, and none of the three
    // things the project declared.
    let behind = Capabilities {
        agents: vec!["claude".into()],
        git: true,
        tmux: false,
        aura: false,
    };
    let (declared, plan, report) = measured(DECLARES, false);
    let drift = place.drift_of(&bins, &behind, &declared, &plan, &report);

    ensure(
        drift.place == place.label(),
        "a drift report that does not say which place it is about",
    )?;
    ensure(
        !drift.at_spec && drift.missing == 4,
        format!(
            "a place short of four things reported {} missing",
            drift.missing
        ),
    )?;

    // Exactly what is missing, in the order it has to be fixed in — and the same
    // list whichever mode is holding it, which is the parity claim.
    let missing: Vec<&str> = drift.blocking().iter().map(|i| i.id.as_str()).collect();
    ensure(
        missing
            == vec![
                "runtime:tmux",
                "toolchain:node",
                "package:custom/ripgrep",
                "service:postgres",
            ],
        format!("this place is short of a different list: {missing:?}"),
    )?;

    // Naming a gap is only worth it if you are one step from closing it.
    let node = drift
        .items
        .iter()
        .find(|i| i.id == "toolchain:node")
        .ok_or("the spec's toolchain is not in the report at all")?;
    ensure(
        node.fix.as_deref() == Some("mise install node@20.11.0"),
        "a gap that names no way out of itself",
    )?;

    // The half that makes this a diff rather than a checklist: what the place
    // turned out to have that nobody declared. Without it, two reports agree
    // right up to the moment the work behaves differently.
    let unasked: Vec<&str> = drift
        .items
        .iter()
        .filter(|i| i.standing == Standing::Unasked)
        .map(|i| i.id.as_str())
        .collect();
    ensure(
        unasked == vec!["agent:claude"],
        format!("what this place has and nobody asked for came back as {unasked:?}"),
    )?;
    // And nothing invented: an agent it hasn't got is not a line.
    ensure(
        !drift.items.iter().any(|i| i.id == "agent:codex"),
        "a place was reported short of something nothing ever asked it for",
    )?;

    // The same place once it has all of it says so in one sentence, rather than
    // going quiet — a report that only speaks up when it is unhappy is one
    // nobody trusts when it is silent.
    let (declared, plan, report) = measured(DECLARES, true);
    let at_spec = place.drift_of(
        &bins,
        &Capabilities {
            agents: bins.clone(),
            git: true,
            tmux: true,
            aura: true,
        },
        &declared,
        &plan,
        &report,
    );
    ensure(
        at_spec.at_spec && at_spec.blocking().is_empty(),
        "a place holding everything the spec asked for still reported drift",
    )?;
    ensure(
        at_spec.summary.contains("at spec v7"),
        format!("a place at spec says: {}", at_spec.summary),
    )?;

    Ok(Outcome::Met(format!(
        "{} answers what it has against spec v{}: {}",
        place.label(),
        drift.version,
        drift.summary
    )))
}

/// W15 — run an agent that cannot reach the whole network.
///
/// A run has two phases and they get different networks. Setup installs, with
/// everything, because a list that has to contain whatever `npm ci` reaches is
/// not a list. The agent phase — the half nobody is watching — is default-deny
/// with an allowlist, and that split is what bounds what a prompt injection can
/// actually carry out: reading a token is only worth doing if there is somewhere
/// to send it.
///
/// Asked of every mode because a wall that exists on a box and not on a laptop
/// is the same feature as no wall — the agent anybody actually runs unattended
/// is the one on their own machine at 2am. So this puts each mode's place behind
/// the same spec and reads back the same plan, the same guard, and the same
/// sentence, differing only in which place it is about.
fn an_agent_that_cannot_reach_the_whole_network(mode: &Mode) -> Result<Outcome, String> {
    let place = mode.place(&ALPHA);
    let (declared, _, _) = measured(DECLARES_NETWORK, false);

    let plan = agent_phase_of("claude", &declared, Some(REMOTE), "seatbelt")?;
    ensure(
        plan.phase == Phase::Agent && plan.holdable,
        "a place that said it can hold a wall came back unconfined",
    )?;
    ensure(
        plan.declared_honoured,
        "a spec this place would apply had its network list thrown away anyway",
    )?;

    // Exactly what it may reach, and the same list whichever mode is holding
    // it — which is the parity claim. Three sources, and the difference between
    // them is the whole security argument: what the project asked for, the model
    // the agent cannot answer without, and where this checkout came from.
    let reachable: Vec<String> = plan
        .allowed
        .iter()
        .map(|a| format!("{}={:?}", a.endpoint, a.reason))
        .collect();
    ensure(
        reachable
            == vec![
                "api.anthropic.com:443=Model",
                "console.anthropic.com:443=Model",
                "github.com:443=Remote",
                "registry.npmjs.org:443=Declared",
            ],
        format!("the agent phase at this place may reach {reachable:?}"),
    )?;

    // The seal is the thing that makes the list worth anything. A spec edited
    // after it was signed contributes NOTHING — not "what it says, with a
    // warning" — so an agent talked into widening its own allowlist has not
    // widened anything it can use in the same run.
    let stale = Declared {
        spec: declared.spec.clone(),
        trust: TrustState::Stale {
            sealed: "sha256:aaa".into(),
            actual: "sha256:bbb".into(),
        },
        source: declared.source.clone(),
    };
    let broken = agent_phase_of("claude", &stale, Some(REMOTE), "seatbelt")?;
    ensure(
        !broken.declared_honoured
            && !broken
                .allowed
                .iter()
                .any(|a| a.endpoint.host() == "registry.npmjs.org"),
        "a spec whose seal no longer matches still granted what it asked for",
    )?;
    ensure(
        broken.allowed.iter().any(|a| a.endpoint.host() == "api.anthropic.com"),
        "a broken seal took the agent's own model away, which stops the run rather than bounding it",
    )?;

    // A machine that cannot put a wall up must SAY so rather than imply one.
    // The dangerous version of this feature is the one that reports an allowlist
    // on a machine that is not holding anybody to it.
    let open = agent_phase_of("claude", &declared, Some(REMOTE), "")?;
    ensure(
        !open.holdable && open.note.contains("whole network"),
        format!("a place that can hold no wall says: {}", open.note),
    )?;

    // And the guard itself: one script, delivered to the member's own home, that
    // runs the agent behind the wall. Byte-identical whichever mode is holding
    // the place — the wall is chosen by the machine at run time, not by which
    // way somebody got there.
    let run = run_name("aura-agent-alpha-k3f9");
    let guard = Guard::new(
        &run,
        &script::agent_line("claude", &[], Some("fix the login redirect")),
        Egress::of(plan.allowed.clone()),
    )?;
    let body = guard.script();
    ensure(
        body.contains("aura_egress_wall=$(") && body.contains("aura_egress_refuse"),
        "the guard does not refuse to run on a machine that cannot hold the wall",
    )?;
    // The agent's whole command line is ONE value inside the script, so the
    // prompt's own quoting is escaped rather than executed — which is the point
    // worth checking, given the prompt is the least trusted string in the run.
    ensure(
        body.contains(&format!(
            "AURA_EGRESS_CMD={}",
            script::quote("'claude' 'fix the login redirect'")
        )),
        "the guard does not run the agent it was built for",
    )?;
    // Delivered into the home of whoever the work runs as, which only the
    // machine knows — a box with per-member accounts has one home per person,
    // and a guard written to somebody else's is a guard nobody runs.
    ensure(
        guard.rel_path() == format!(".config/aura/egress/{run}.sh")
            && script::is_home_rel_path(&guard.rel_path()),
        format!("the guard would be written to {}", guard.home_path()),
    )?;

    Ok(Outcome::Met(format!(
        "{} runs its agent phase behind {}: {}",
        place.label(),
        plan.wall,
        plan.summary
    )))
}

/// The environment the fixture project declares — one of each layer the plan
/// knows, so a place behind it is behind it in four different ways.
const DECLARES: &str = r#"
[env]
version = 7

[env.toolchain.node]
version = "20.11.0"
check   = "node --version | grep -q 20.11.0"
install = "mise install node@20.11.0"

[[env.package]]
manager = "custom"
name    = "ripgrep"
check   = "command -v rg"
install = "brew install ripgrep"

[[env.service]]
name  = "postgres"
start = "pg_ctl start"
ready = "pg_isready"
"#;

/// The same project, with the one host it genuinely needs to reach while it
/// works. Inside the signed spec, so widening it breaks the seal.
const DECLARES_NETWORK: &str = r#"
[env]
version = 7

[env.network]
allow = ["registry.npmjs.org"]
"#;

/// A spec, the plan that realises it, and a report in which every step went the
/// same way — a place that has all of it, or none of it, without a machine.
///
/// The suite dials nothing, so the measurement is supplied rather than taken.
/// What is under test is the join: two sources of truth about one place, and
/// whether the answer comes out the same shape whichever mode is holding it.
fn measured(toml: &str, met: bool) -> (Declared, Plan, EnvReport) {
    let spec: EnvSpec = aura_env::parse_declared(toml).expect("a spec the fixture wrote");
    let plan = aura_env::plan(&spec, Scope::Full).expect("a plan for it");
    let steps = plan
        .steps
        .iter()
        .map(|s| StepOutcome {
            id: s.id.clone(),
            title: s.title.clone(),
            kind: s.kind,
            state: if met {
                StepState::AlreadyAtSpec
            } else {
                StepState::Unsatisfied
            },
            code: i32::from(!met),
            detail: String::new(),
        })
        .collect();
    let report = EnvReport {
        schema: aura_env::SPEC_SCHEMA.into(),
        version: spec.version,
        digest: spec.digest().unwrap_or_default(),
        trust: TrustState::Unsigned,
        steps,
        at_spec: met,
        changed: false,
    };
    let declared = Declared {
        spec,
        trust: TrustState::Unsigned,
        source: "the place's own checkout".into(),
    };
    (declared, plan, report)
}

/// What the place will actually run, out of what it says to spawn.
///
/// The last argument either way — `sh -c <body>` here, `ssh … <body>` there —
/// which is the seam's whole claim in one line: one command, two transports.
fn command_body(shell: &Shell) -> Result<String, String> {
    shell
        .args
        .last()
        .cloned()
        .ok_or_else(|| "a terminal with no command in it".to_string())
}

/// The last segment of a path — the folder a project actually sits in, whichever
/// disk is spelling it.
fn leaf(path: &str) -> &str {
    let trimmed = path.trim_end_matches('/');
    trimmed.rsplit('/').next().unwrap_or(trimmed)
}

/// A condition the contract has to hold, and what to say when it doesn't.
///
/// The complaint is written as the *symptom a person would meet*, not as the
/// assertion that failed: a red cell is read by whoever broke it, and "a member's
/// home is readable by the others" sends them somewhere "assert_eq failed" does
/// not.
fn ensure(condition: bool, complaint: impl Into<String>) -> Result<(), String> {
    if condition {
        Ok(())
    } else {
        Err(complaint.into())
    }
}
