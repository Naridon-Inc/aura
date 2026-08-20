//! Every place, through every workflow. The parity proof, as a table.
//!
//! The governing rule of this programme is that no feature lands in one place-
//! mode only. Every other task in the group moves a surface behind the `Place`
//! contract so that rule *can* hold; this is the thing that finds out whether it
//! does — and it is deliberately not a smoke test. **A mode is not shipped until
//! its column is green.**
//!
//! ## Why a table rather than tests per mode
//!
//! Tests written per mode are how the drift happens. Someone adds a case for the
//! box because they were working on the box, the local arm never gets one, and
//! the suite is greener than the product. Here the cases are a list, the modes
//! are a list, and the suite is their product: a workflow added to [`WORKFLOWS`]
//! is immediately asked of every mode, and a mode added to [`MODES`] is
//! immediately asked all of them. **Adding an implementation costs one row and
//! nothing else** — that is the property this file exists to hold, and
//! `adding_a_mode_costs_one_row_and_asks_it_everything` pins it.
//!
//! ## What a check is allowed to look at
//!
//! Only the contract. A check takes a [`Mode`], builds its place through the one
//! constructor, and then asks `Place` the same questions any surface asks. No
//! check matches on `Place::Here` / `Place::Box` — the moment one does, it has
//! stopped testing a contract and started testing an enum, and it would go on
//! passing while the two modes diverged underneath it.
//!
//! Where a workflow genuinely turns on one of the four things a mode is *allowed*
//! to differ on — who creates the machine, where the address lives, who holds
//! root, who gets the bill — a check reads that difference off the contract
//! (`identity().host`, `billing()`), never off the variant. That is what let the
//! Aura-managed row flip two cells from amber to green by being a different kind
//! of place rather than by anyone editing a check.
//!
//! ## Nothing here dials
//!
//! Every question below is answered without a machine on the other end, because
//! a suite that needs a live box is a suite that gets skipped. The live half is
//! already covered where it belongs — `place::live` runs the four verbs against a
//! real machine under `AURA_LIVE_MACHINE`, and `place_account`'s docker test puts
//! two real members on a real Linux. What *this* proves is the part those cannot:
//! that both modes are asked the same thing and answer in the same shape.
//!
//! One local thing does happen, and it is worth naming because the paragraph
//! above would otherwise be read as promising it does not: opening a place whose
//! key Aura holds puts up the agent socket that stands in for a key file, because
//! that socket's name is what goes in the argv. It is `0600` under Aura's own
//! directory, nothing connects to it, and it asks Aura for nothing — but it is a
//! file, and it is here rather than mocked away because a managed column proved
//! against a stubbed transport is a column proved against a place that does not
//! ship.
//!
//! ## The amber cells
//!
//! Every expected-unsupported cell was named up front rather than discovered.
//! There were two, both on the row for a box somebody brought: Aura could not
//! sleep a machine it held no credential for, and a box that promises only
//! ssh + tmux + git separates its members by Unix account, not by kernel. Both
//! are stated in [`BYOC_ASYMMETRIES`], and both are what the Aura-managed row
//! closes — it declares nothing, and the two cells come out green there because
//! Aura made that machine, not because a check was taught about it.
//!
//! The fourth row is what proved those two were never one asymmetry wearing two
//! names. A box you brought, in a cloud account whose owner has granted Aura a
//! role in it, is still somebody else's metal on somebody else's bill and still
//! separates its members by Unix account — so it declares [`KERNEL_ISOLATION`]
//! exactly as the row above it does. It does not declare the lifecycle one,
//! because it sleeps. Ownership and permission had been folded together, and the
//! row that has one without the other is what unfolds them.
//!
//! An expected-unsupported cell still runs, and still has to clear a floor. That
//! is the whole difference between an honest asymmetry and a place to hide a
//! regression: `W11` on a box still proves the per-member home is `0700` before
//! it is allowed to say the boundary is not a kernel one, and a mode that starts
//! *promising* a cell the table says it doesn't fails just as loudly as one that
//! stops promising a cell it should — see [`cell`].

mod workflows;

use crate::cmd_machines::Machine;

use super::place::Place;

/// The things a person does with a place.
///
/// Not a taxonomy of the code — a list of what somebody sits down and does. Each
/// one is asked of every mode, and the answer has to come out of the contract
/// rather than out of whichever surface happened to implement it first.
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum Workflow {
    W1,
    W2,
    W3,
    W4,
    W5,
    W6,
    W7,
    W8,
    W9,
    W10,
    W11,
    W12,
    W13,
    W14,
    W15,
}

/// The matrix's rows of questions, in the order a person meets them.
pub const WORKFLOWS: [Workflow; 15] = [
    Workflow::W1,
    Workflow::W2,
    Workflow::W3,
    Workflow::W4,
    Workflow::W5,
    Workflow::W6,
    Workflow::W7,
    Workflow::W8,
    Workflow::W9,
    Workflow::W10,
    Workflow::W11,
    Workflow::W12,
    Workflow::W13,
    Workflow::W14,
    Workflow::W15,
];

impl Workflow {
    /// What a failure calls it, so a red cell can be found by grepping the spec.
    pub fn id(self) -> &'static str {
        match self {
            Workflow::W1 => "W1",
            Workflow::W2 => "W2",
            Workflow::W3 => "W3",
            Workflow::W4 => "W4",
            Workflow::W5 => "W5",
            Workflow::W6 => "W6",
            Workflow::W7 => "W7",
            Workflow::W8 => "W8",
            Workflow::W9 => "W9",
            Workflow::W10 => "W10",
            Workflow::W11 => "W11",
            Workflow::W12 => "W12",
            Workflow::W13 => "W13",
            Workflow::W14 => "W14",
            Workflow::W15 => "W15",
        }
    }

    /// The workflow in the words it was specified in — the sentence a person
    /// would use, not the name of the function that happens to serve it.
    pub fn title(self) -> &'static str {
        match self {
            Workflow::W1 => "open a project",
            Workflow::W2 => "new chat",
            Workflow::W3 => "new workspace",
            Workflow::W4 => "several workspaces on different projects on one place",
            Workflow::W5 => "several places from one laptop",
            Workflow::W6 => "pick which org I act as",
            Workflow::W7 => "an org place offers only that org's projects",
            Workflow::W8 => "personal and self-setup keep working",
            Workflow::W9 => "admin enables cloud for a member, who then reaches it with zero SSH",
            Workflow::W10 => "push a commit as myself on a shared place",
            Workflow::W11 => "install a package without breaking a teammate",
            Workflow::W12 => "see my spend separately from my teammate's",
            Workflow::W13 => "sleep on idle and wake on demand",
            Workflow::W14 => "ask a place what it has against what the project asks for",
            Workflow::W15 => "run an agent that cannot reach the whole network",
        }
    }
}

/// What a mode answered when it was asked a workflow.
///
/// Two cases rather than a bool because "we do not do this" is a real answer a
/// place is allowed to give, and it carries a reason. A bool would have made the
/// two amber cells indistinguishable from a broken one.
#[derive(Debug, PartialEq)]
pub enum Outcome {
    /// The mode does this. The string is what it actually does — evidence, in
    /// the mode's own terms, so a green cell says something rather than merely
    /// being green.
    Met(String),
    /// The mode does not promise this. The string is what it does *instead* and
    /// what it does not do, because "unsupported" on its own is the shape of
    /// answer that stops anyone asking whether it should be.
    NotPromised(String),
}

/// A check: one workflow, asked of one mode.
///
/// `Err` is not "this mode doesn't do it" — that is [`Outcome::NotPromised`].
/// `Err` is the floor breaking: the contract answered something it should never
/// answer, and no entry in any table makes that acceptable.
type Check = fn(&Mode) -> Result<Outcome, String>;

/// A project, as the two paths a place holds it under.
///
/// Two fields, not one. `here` is a path on this disk and means nothing over
/// there; `there` is a path on the place and means nothing here. Collapsing them
/// is how a box gets filed under a repo it has never seen, so the fixture keeps
/// them apart exactly as `Place` does.
pub struct Project {
    pub here: &'static str,
    pub there: &'static str,
}

/// The project every workflow uses unless it needs a second one.
const ALPHA: Project = Project {
    here: "/Users/me/alpha",
    there: "/srv/alpha",
};

/// A second project, for the workflows about holding more than one at once.
const BETA: Project = Project {
    here: "/Users/me/beta",
    there: "/srv/beta",
};

/// The org the fixture places are connected under.
const ORG: &str = "naridon";

/// An org the account also belongs to, for asking what a switch hides.
const OTHER_ORG: &str = "mhask";

/// The member the workflows are run as — a person, never the login a box came
/// with.
const MEMBER: &str = "mo";

/// A teammate on the same place, for the workflows that are only meaningful
/// with two people in them.
const TEAMMATE: &str = "ana";

/// Where the fixture pushes to.
const REMOTE: &str = "https://github.com/naridon/aura.git";

/// The same repository over ssh — which is a different way of being the member
/// pushing, not a different repository. Over https "as myself" means a token;
/// over ssh it can only mean a key, and W10 has to hold for both or a member is
/// as anonymous as ever the moment their remote is spelled the other way.
const SSH_REMOTE: &str = "git@github.com:naridon/aura.git";

/// One Place implementation, as a row of the matrix.
///
/// **Adding a mode is this struct, once.** Everything else in the file is
/// written against the contract, so a new row is asked every workflow
/// the moment it is added and cannot quietly be asked fewer.
pub struct Mode {
    /// What a failure calls this column.
    pub id: &'static str,
    /// What it is, in the words the product uses.
    pub title: &'static str,
    /// The machine book row this mode's places come from, filed under `org`.
    ///
    /// `None` is this laptop, which is not in the book at all — which is
    /// precisely why no org filter and no teardown ever reach it, rather than it
    /// being special-cased out of them.
    pub row: fn(org: Option<&str>) -> Option<Machine>,
    /// The workflows this mode does not promise, and why.
    ///
    /// Empty is the target every mode is held to. A non-empty list is a claim
    /// somebody has to defend, and the runner will not let it sit there once the
    /// mode starts doing the thing anyway.
    pub not_promised: &'static [(Workflow, &'static str)],
}

impl Mode {
    /// This mode's place, holding `project`, connected under `org`.
    ///
    /// The one constructor, and the only thing in this file that knows the modes
    /// are built differently — because *how you come to have a machine* is one of
    /// the four things a mode is allowed to differ on. Every workflow below takes
    /// what comes out of here and asks it contract questions.
    fn place_in(&self, project: &Project, org: Option<&str>) -> Place {
        match (self.row)(org) {
            Some(machine) => Place::Box {
                machine: Box::new(machine),
                root: project.there.into(),
                here: project.here.into(),
            },
            None => Place::Here {
                root: project.here.into(),
            },
        }
    }

    /// This mode's place, holding `project`, under the org it was connected in.
    fn place(&self, project: &Project) -> Place {
        self.place_in(project, Some(ORG))
    }

    /// What this mode says it does not promise about `w`, if anything.
    fn caveat(&self, w: Workflow) -> Option<&'static str> {
        self.not_promised
            .iter()
            .find(|(x, _)| *x == w)
            .map(|(_, why)| *why)
    }
}

/// This laptop has no row in the machine book. Nothing files it, nothing hides
/// it, and nothing can tear it down.
fn no_row(_org: Option<&str>) -> Option<Machine> {
    None
}

/// A box you brought: an address, a login, a key this laptop holds, and a
/// promise of ssh + tmux + git and nothing more.
fn byoc_row(org: Option<&str>) -> Option<Machine> {
    Some(Machine {
        id: "ubuntu@10.0.0.4:/srv/alpha".into(),
        name: "aura-runner".into(),
        host: "10.0.0.4".into(),
        user: "ubuntu".into(),
        key_path: "/Users/me/.ssh/aura-runner.pem".into(),
        // A box the team shares — the case every per-member workflow is about.
        box_kind: "shared".into(),
        repo_path: Some("/srv/alpha".into()),
        repo_branch: Some("main".into()),
        project_root: Some("/Users/me/alpha".into()),
        org_slug: org.map(str::to_string),
        // Nobody opted this row in, which is the state every workflow below
        // has to be answerable in.
        forward_agent: false,
        instance_id: None,
        asleep_since: 0,
        added_at: 1_750_000_000,
        last_used_at: 1_750_003_600,
    })
}

/// The two honest asymmetries of a box Aura did not make, stated up front.
///
/// Neither is a bug and neither is a to-do against this row: they are the shape
/// of what a customer's own machine can promise. Both are also exactly what the
/// Aura-managed arm closes, which is why they are written as the difference
/// between "a place Aura dials" and "a place Aura made" rather than as the name
/// of a variant.
const BYOC_ASYMMETRIES: &[(Workflow, &str)] = &[
    KERNEL_ISOLATION,
    (
        Workflow::W13,
        "Lifecycle. Aura holds no credential for the account this machine runs \
         in, so it cannot stop one or start one. An idle box stays up on its \
         owner's bill. Walking away costs the work nothing — the sessions are \
         tmux and they are there when you come back — but the idle is not free. \
         This one is about permission rather than about hardware: the same box, \
         in an account whose owner grants Aura a role in it, is the `granted` \
         row below and does not declare this.",
    ),
];

/// The asymmetry that belongs to the runtime rather than to the account, so it
/// is shared by both rows that run on somebody else's metal.
///
/// Written once and referenced twice, because two copies of an excuse are two
/// excuses that can be retired separately — and the day this stops being true it
/// has to stop being true in both places at once or the table is lying about one
/// of them.
const KERNEL_ISOLATION: (Workflow, &str) = (
    Workflow::W11,
    "Kernel-level isolation. A box that promises only ssh + tmux + git \
     separates its members by Unix account — own home at 0700, own keys, own \
     umask, own prefix — which is real separation of files, credentials and \
     installs: a member installs into their own home without root, and two \
     members can hold two versions of one tool. It is not a kernel boundary: \
     teammates still share one kernel and one /usr, and a system package \
     manager is still system-wide, which is why `apt` is refused with a \
     sentence rather than run.",
);

/// What is left once a customer has granted Aura a role in their own account.
///
/// One entry rather than two, and that is the whole point of the row: the
/// lifecycle asymmetry is gone, and the isolation one is not — because a grant
/// changes who may switch the machine off and changes nothing whatsoever about
/// what the machine is.
const GRANTED_ASYMMETRIES: &[(Workflow, &str)] = &[KERNEL_ISOLATION];

/// The name Aura's own key for this machine answers to.
///
/// A reference and not a path, which is the single most load-bearing difference
/// between the two box rows: there is no file behind it anywhere on this laptop,
/// and `ssh_argv` turns it into an agent socket instead of an `-i`. Spelling it
/// as a `.pem` here would have made the whole column green about a machine whose
/// key the member holds — which is the one thing a machine Aura made never does.
const MANAGED_KEY_REF: &str = "managed:0f5b1f1a-9c4b-4c6f-8a3e-6d5c4b3a2e10";

/// A box Aura made: the same ssh + tmux + git runtime, reached the same way,
/// differing only in who made the machine and therefore who holds the key and
/// who gets the bill.
///
/// Built by [`crate::cmd_machines::made_machine`] — the one function that writes
/// a managed row — rather than spelled out beside it. A fixture written by hand
/// is a second opinion about what a managed place is, and this suite's whole
/// claim is that the column is green about the machine that ships. Drift between
/// the two would be invisible in exactly the way this file exists to prevent:
/// fifteen green cells about a row nothing produces.
///
/// The fields that differ from [`byoc_row`] are exactly the permitted four and
/// nothing else. `box_kind` says Aura made it, which is what `billing()` reads to
/// decide that the time is ours to charge for and the lifecycle is ours to drive;
/// `instance_id` is the substrate's handle, which is the thing Aura has for a
/// machine it made and has not got for one it did not. Everything else — the
/// login, a project under a root — is deliberately the same shape, because a
/// managed place is not a second kind of place.
fn managed_row(org: Option<&str>) -> Option<Machine> {
    let mut made = crate::cmd_machines::made_machine(
        "aura-managed",
        "10.0.0.7",
        "ubuntu",
        MANAGED_KEY_REF,
        Some(ALPHA.there),
        // The handle the substrate answers to. Having one is what lets Aura stop
        // and start this machine, which is the asymmetry the BYOC row declares.
        "i-0abc123def456789",
        org.map(str::to_string),
        1_750_000_000,
    )
    .expect("the row a machine Aura made is written down as");
    // The two things a freshly made row does not know yet, filled in here the
    // way `machine_set_project` and `machine_set_branch` fill them in once
    // something has opened the box — a place that has been worked in is the
    // state every workflow below is asked about.
    made.project_root = Some(ALPHA.here.into());
    made.repo_branch = Some("main".into());
    made.last_used_at = 1_750_003_600;
    Some(made)
}

/// A box you brought, in a cloud account you have granted Aura a role in.
///
/// The same hardware as [`byoc_row`], on the same bill, reached the same way —
/// differing in exactly one field, which is the point of the row. The handle is
/// *qualified*: it names the account before it names the machine, because a stop
/// against this box is signed by the role the customer granted rather than by
/// Aura's own credential.
///
/// Written by the same function the product writes it with, for the reason
/// [`managed_row`] is: a fixture that spelled the handle out by hand would be a
/// second opinion about the one string this row exists to demonstrate, and the
/// column would go green about a shape nothing produces.
fn granted_row(org: Option<&str>) -> Option<Machine> {
    let mut brought = byoc_row(org)?;
    brought.name = "acme-runner".into();
    brought.instance_id = Some(crate::provisioner::grant::handle::qualify(
        "acme-eu",
        "i-0abc123def456789",
    ));
    Some(brought)
}

/// Every Place implementation there is, as rows.
///
/// Four, and the last two both arrived the way this file promised they would:
/// one row each, asked every workflow without a check changing. The two cells
/// the BYOC row declares are flipped by a row being a different kind of place —
/// Aura made this machine, so it can stop it and start it, and the boundary
/// around it is a kernel one — rather than by anybody editing a workflow to know
/// about it.
///
/// The fourth row is the one that shows those two cells were never the same
/// cell. It runs on the customer's own metal, on the customer's own bill, and
/// still sleeps — because a lifecycle needs permission rather than ownership,
/// and a customer can grant permission without giving up either.
pub const MODES: &[Mode] = &[
    Mode {
        id: "here",
        title: "This laptop",
        row: no_row,
        not_promised: &[],
    },
    Mode {
        id: "box",
        title: "A box you brought (ssh + tmux + git)",
        row: byoc_row,
        not_promised: BYOC_ASYMMETRIES,
    },
    Mode {
        id: "managed",
        title: "A box Aura made (ssh + tmux + git, on Aura's account)",
        row: managed_row,
        not_promised: &[],
    },
    Mode {
        id: "granted",
        title: "A box you brought, in a cloud account Aura may act in",
        row: granted_row,
        not_promised: GRANTED_ASYMMETRIES,
    },
];

/// A second place, always somewhere else.
///
/// "Several places from one laptop" means this place and another one, and the
/// other one has to be a machine whichever mode is under test: two laptops is not
/// a case this app has. Deliberately a different host, login, key and org from
/// [`byoc_row`], so a workflow that confuses two places has nothing to hide
/// behind.
fn neighbour() -> Place {
    Place::Box {
        machine: Box::new(Machine {
            id: "ana@10.0.0.9:/srv/beta".into(),
            name: "ana-box".into(),
            host: "10.0.0.9".into(),
            user: "ana".into(),
            key_path: "/Users/me/.ssh/ana-box.pem".into(),
            box_kind: "mine".into(),
            repo_path: Some("/srv/beta".into()),
            repo_branch: Some("main".into()),
            project_root: Some("/Users/me/beta".into()),
            org_slug: Some(OTHER_ORG.into()),
            forward_agent: false,
            instance_id: None,
            asleep_since: 0,
            added_at: 1_750_000_000,
            last_used_at: 1_750_007_200,
        }),
        root: BETA.there.into(),
        here: BETA.here.into(),
    }
}

/// Run every mode through every workflow.
///
/// Returns one line per cell that did not hold. Empty is the whole claim of the
/// group: every place does every workflow, except where a row says out loud that
/// it does not and why.
pub fn run() -> Vec<String> {
    let mut failures = vec![];
    for mode in MODES {
        for w in WORKFLOWS {
            if let Err(line) = cell(mode, w) {
                failures.push(line);
            }
        }
    }
    failures
}

/// One cell: this mode, this workflow, against what the table says to expect.
///
/// Four of the five outcomes are worth naming:
///
/// * the floor broke — the contract answered something no table makes
///   acceptable, and the cell is red whatever anybody declared;
/// * met and undeclared — green, the ordinary case;
/// * not promised and declared — amber, an honest asymmetry;
/// * **not promised and undeclared** — red. A mode that quietly stopped doing
///   something is the failure this whole file exists to catch;
/// * **met but declared not-promised** — also red, and this is the one that is
///   easy to leave out. An expected-unsupported entry that has come true is a
///   stale excuse, and left in place it is somewhere a real regression can sit
///   for months wearing the word "expected".
fn cell(mode: &Mode, w: Workflow) -> Result<(), String> {
    let named = |what: String| format!("{} × {} ({}): {what}", mode.id, w.id(), w.title());
    match (workflows::check(w)(mode), mode.caveat(w)) {
        (Err(why), _) => Err(named(format!("the contract broke — {why}"))),
        (Ok(Outcome::Met(_)), None) => Ok(()),
        (Ok(Outcome::NotPromised(_)), Some(_)) => Ok(()),
        (Ok(Outcome::NotPromised(why)), None) => Err(named(format!(
            "not promised, and nothing in the table says so — {why}"
        ))),
        (Ok(Outcome::Met(how)), Some(caveat)) => Err(named(format!(
            "the table says this mode does not promise it, but it does: {how}. \
             Take the entry out of the table — it currently reads: {caveat}"
        ))),
    }
}

#[test]
fn every_place_runs_the_whole_workflow_matrix() {
    // The parity proof. A mode is not shipped until its column is green.
    let failures = run();
    assert!(
        failures.is_empty(),
        "{} of {} cells did not hold:\n  {}",
        failures.len(),
        MODES.len() * WORKFLOWS.len(),
        failures.join("\n  ")
    );
}

#[test]
fn adding_a_mode_costs_one_row_and_asks_it_everything() {
    // The property the file is for. A mode is a row; the questions are a list;
    // the suite is their product. Nothing anywhere selects which workflows a
    // mode gets asked, so a new row cannot arrive with a short column.
    let mut cells = 0;
    for mode in MODES {
        for w in WORKFLOWS {
            // Every check answers every mode. A check that only knew how to
            // answer one of them would land here, not in a mode-shaped test
            // file somebody forgot to write.
            workflows::check(w)(mode)
                .unwrap_or_else(|e| panic!("{} was not answerable about {}: {e}", w.id(), mode.id));
            cells += 1;
        }
    }
    assert_eq!(cells, MODES.len() * WORKFLOWS.len());
    assert_eq!(cells, 60, "four modes, fifteen workflows");
}

#[test]
fn the_aura_made_column_is_run_against_the_row_the_product_writes() {
    // A green column is worth what the row under it is worth. This one is built
    // by `made_machine` — the one function that writes a managed row — so the
    // fields nobody would think to check are the product's rather than a
    // fixture author's, and the two cannot drift.
    //
    // The key is why this test exists rather than being left to the reading. A
    // row written by hand would almost certainly have carried a `.pem` path,
    // because that is what every other row in this file carries and it looks
    // right; and the whole column would have gone green about a place whose key
    // the member holds — which is the one thing a machine Aura made never is.
    let row = managed_row(Some(ORG)).expect("the Aura-made row");
    assert!(
        crate::cloudbox::managed_key::is_managed(&row.key_path),
        "the Aura-made row carries a key this laptop could open on its own: {}",
        row.key_path
    );
    assert!(
        !row.key_path.contains('/'),
        "a reference Aura holds has no file behind it, so it is not a path: {}",
        row.key_path
    );
    // And the handle, which is what makes the row sleepable and is therefore
    // what flips W13 from amber to green.
    assert!(row.instance_id.is_some(), "an Aura-made row with nothing to stop");
    assert_eq!(row.box_kind, "managed");
    // Off, because there is no key on this laptop to lend anybody.
    assert!(!row.forward_agent);

    // The permitted four, and the proof that nothing else moved: every other
    // field a place is built from is the same shape as the row for a box
    // somebody brought.
    let brought = byoc_row(Some(ORG)).expect("the brought row");
    assert_eq!(row.user, brought.user);
    assert_eq!(row.repo_path, brought.repo_path);
    assert_eq!(row.project_root, brought.project_root);
    assert_eq!(row.repo_branch, brought.repo_branch);
    assert_eq!(row.org_slug, brought.org_slug);
}

#[test]
fn the_granted_column_is_the_brought_one_plus_a_permission_and_nothing_else() {
    // The claim the fourth row makes is a narrow one: nothing about the machine
    // changed. Same metal, same login, same key on this laptop, same bill —
    // somebody granted Aura a role in the account it runs in, and that is all.
    // A row that quietly also became a managed one would flip W13 for the wrong
    // reason and the column would be green about a place nobody has.
    let brought = byoc_row(Some(ORG)).expect("the brought row");
    let granted = granted_row(Some(ORG)).expect("the granted row");
    assert_eq!(granted.box_kind, brought.box_kind);
    assert_eq!(granted.key_path, brought.key_path);
    assert_eq!(granted.user, brought.user);
    assert_eq!(granted.host, brought.host);
    assert_eq!(granted.org_slug, brought.org_slug);
    // Who pays does not move, which is the whole difference from the managed
    // row: the saving lands on the customer's bill because the machine was
    // always on it.
    assert_eq!(
        crate::manager::brain::place::billing_of(&granted),
        crate::manager::brain::place::billing_of(&brought)
    );

    // And the one field that does differ names the account before the machine,
    // because a stop against this box is signed by the role its owner granted.
    let handle = granted.instance_id.expect("a granted row with nothing to stop");
    assert!(crate::provisioner::granted_handle(&handle), "{handle}");
    assert!(brought.instance_id.is_none());
}

#[test]
fn the_only_asymmetries_are_the_ones_declared_up_front() {
    // Three entries over two rows, and the shape of them is the claim: the
    // lifecycle one is declared once, by the only row that has no way to switch
    // its machine off, and the isolation one twice, by both rows that run on
    // hardware Aura did not make. A fourth entry appearing here is a product
    // decision, not a test edit.
    let declared: Vec<(&str, &str)> = MODES
        .iter()
        .flat_map(|m| m.not_promised.iter().map(move |(w, _)| (m.id, w.id())))
        .collect();
    assert_eq!(
        declared,
        vec![("box", "W11"), ("box", "W13"), ("granted", "W11")]
    );

    for mode in MODES {
        for (w, why) in mode.not_promised {
            assert!(
                WORKFLOWS.contains(w),
                "{} names a workflow the matrix doesn't run",
                mode.id
            );
            // An excuse nobody can read is an excuse nobody can challenge.
            assert!(
                why.len() > 80,
                "{} × {} says it does not promise this without saying what it does instead",
                mode.id,
                w.id()
            );
        }
    }
}

#[test]
fn a_failure_names_which_mode_failed_which_workflow() {
    // A red cell has to be findable. "assertion failed" in a table of 26 is a
    // morning spent bisecting, so every line carries the mode, the workflow's
    // id and the workflow in the words it was specified in.
    let lying = Mode {
        id: "here",
        title: "This laptop",
        row: no_row,
        // A claim this mode cannot support: opening a project plainly works.
        not_promised: &[(Workflow::W1, "a stale excuse, left in the table")],
    };
    let err = cell(&lying, Workflow::W1).expect_err("a table that lies must not pass");
    assert!(err.starts_with("here × W1 (open a project):"), "{err}");
    assert!(err.contains("Take the entry out of the table"), "{err}");

    // And the other direction: a mode that stops doing something it never had
    // an excuse for is named the same way.
    let broken = Mode {
        id: "box",
        title: "A box you brought (ssh + tmux + git)",
        row: byoc_row,
        not_promised: &[],
    };
    let err = cell(&broken, Workflow::W13).expect_err("an undeclared gap must not pass");
    assert!(
        err.starts_with("box × W13 (sleep on idle and wake on demand):"),
        "{err}"
    );
    assert!(err.contains("nothing in the table says so"), "{err}");
}

#[test]
fn no_check_asks_which_variant_of_place_it_is_holding() {
    // The rule that keeps this a contract suite. A check that matched on
    // `Place::Here` / `Place::Box` would keep passing while the two modes
    // diverged underneath it, because it would be asserting the enum rather
    // than the contract. Where a workflow genuinely turns on one of the four
    // permitted differences it reads that off `identity()` or `billing()`, and
    // the managed row then flips its cells by being a different kind of place
    // rather than by anyone editing a check.
    let src = include_str!("workflows.rs");
    let code: String = src
        .lines()
        .filter(|l| !l.trim_start().starts_with("//"))
        .collect::<Vec<_>>()
        .join("\n");
    for forbidden in ["Place::Here", "Place::Box", "is_remote()"] {
        assert!(
            !code.contains(forbidden),
            "a workflow check reaches for {forbidden}: it is testing the enum, not the contract"
        );
    }
}
