//! The machine book — the boxes this laptop knows how to reach.
//!
//! Connecting a machine used to be a one-shot event: the wizard held the host,
//! the user and the key path in React state, opened one SSH session with them,
//! and forgot all three the moment it closed. That was enough to *install* a
//! runner and never enough to *return* to one. The board can tell you a runner
//! called `crew-box` is online, but a registry row carries no address — so
//! "open my cloud machine" had nothing to dial.
//!
//! This is the address book that makes returning possible. It stores only what
//! you would type into `ssh` yourself: a host, a login, and the PATH of a key
//! that stays on this disk. No key material, no passwords, no runner token —
//! those live where they already lived (`~/.aura/credentials.json`, the box's
//! own environment) and are deliberately not duplicated here.
//!
//! It is local-only and mode `0600`: it names your servers, which is not
//! something to hand to a sync loop.

use std::path::PathBuf;

use serde::{Deserialize, Serialize};

use crate::cloud_session_sync::aura_dir;

/// One machine you can open a workspace on.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Machine {
    /// Stable key for this cloud copy — a login, a box and the directory the
    /// project sits in — so re-running the wizard against the same box and the
    /// same repo updates this entry rather than laying a second one beside it,
    /// while a second project on that box gets a row of its own.
    pub id: String,
    /// What it is called on the cloud board — how a runner row is matched back
    /// to an address.
    pub name: String,
    pub host: String,
    pub user: String,
    /// A REFERENCE to the key this box is opened with — never the key itself.
    ///
    /// Two shapes, one field, because a place is a place. For a box somebody
    /// brought it is a path on THIS LAPTOP, which is what `-i` names. For a box
    /// Aura made it is `managed:<id>`, and there is no file behind it anywhere
    /// on this disk: Aura holds that key and lends a signature at a time over a
    /// local connection — see [`crate::cloudbox::managed_key`].
    ///
    /// One field rather than two on purpose. The moment a managed machine
    /// carries a field a brought one lacks, every surface that reads a machine
    /// grows a branch, and the branches drift apart on whichever kind the person
    /// fixing them happens to own. The same string that means "here is where it
    /// is" also means "it is not here at all", and everything downstream reads
    /// it the same way — it is `ssh_argv` alone that turns the difference into
    /// one changed option.
    pub key_path: String,
    /// `"mine"` or `"shared"`. On a shared box each member installs their own
    /// runner under their own account, so this changes what a workspace may
    /// assume about whose sessions it will find there.
    pub box_kind: String,
    /// Where the project sits on the box, when we know. A workspace opens its
    /// shells here so you land in the repo rather than in `$HOME`.
    pub repo_path: Option<String>,
    /// The project ON THIS LAPTOP this box is a cloud copy of — a local repo
    /// root, the same string the roster keys a project by.
    ///
    /// A box is not a free-floating thing you visit; you connected it *for*
    /// something. Without this the rail could only file machines in a group of
    /// their own, away from the project whose work they are doing, and the
    /// remote copy of a project sat further from it than an idle local branch.
    ///
    /// Optional and defaulted because books written before this field exist and
    /// must keep parsing; a machine that hasn't named its project yet is shown
    /// on its own rather than guessed into someone else's list.
    #[serde(default)]
    pub project_root: Option<String>,
    /// What is checked out in `repo_path` ON THE BOX, last time we looked.
    ///
    /// The rail used to label these rows with the machine's name, which answers
    /// a question nobody was asking. Every other row in that list names a piece
    /// of work — a branch, a copy — and "aura-runner" names a computer, so the
    /// one row that could tell you what is happening somewhere else told you
    /// only that somewhere else exists.
    ///
    /// Cached rather than asked, because the rail draws on every keystroke and
    /// `git rev-parse` over ssh is a round trip. It is refreshed whenever
    /// something is already talking to the box and gets the answer for free —
    /// see `machine_set_branch`. Stale by a session at worst, and a name that is
    /// one branch out of date is still worth more than no name at all.
    #[serde(default)]
    pub repo_branch: Option<String>,
    /// Which org this box belongs to — the slug, the same one the account menu
    /// switches between.
    ///
    /// A place is not neutral about who you are acting as. A box you connected
    /// for a client's org has no business on screen while you are working as
    /// yourself, and the reverse is worse: a shared company box listed under a
    /// personal hat invites work onto a machine the rest of that team is on.
    ///
    /// Stamped from the org that was active when the machine was saved, and
    /// backfilled by [`file_machines_by_org`] whenever something has the
    /// cross-org repo list in hand. `None` means "we don't know", NOT "no org":
    /// a box written before this field existed, or one whose project has no
    /// cloud repo behind it. Those stay visible under every org, because losing
    /// a machine you connected is a far worse failure than showing one twice.
    #[serde(default)]
    pub org_slug: Option<String>,
    /// May this box use the ssh agent on this laptop, for as long as it is
    /// connected?
    ///
    /// Off unless the member turned it on for THIS box, and defaulted off so a
    /// book written before the field reads as off rather than as consent
    /// nobody gave. It is not a convenience toggle: while a connection is up,
    /// anything running as that login on that machine can ask your agent to
    /// sign with your key — it cannot read the key, but it can use it, on any
    /// host your key opens. That is a decision about trust in one machine, so
    /// it is recorded per machine and nowhere else.
    #[serde(default)]
    pub forward_agent: bool,
    /// The substrate's own handle for this machine — an EC2 instance id, and
    /// whatever the next substrate calls one — for a box AURA IS ALLOWED TO
    /// SWITCH OFF.
    ///
    /// `None` for a box nobody gave Aura the keys to, and that is the whole of
    /// "Aura may only sleep what it was given permission to sleep", made
    /// structural rather than remembered: there is no handle to stop, so there
    /// is nothing to stop, and no amount of getting a check wrong somewhere else
    /// can turn into a request against somebody's own hardware.
    ///
    /// It arrives two ways, and the difference is written in the value rather
    /// than in a second field. Aura's own provisioning puts a bare handle here
    /// for a machine it made. A customer connecting a box of their own, in a
    /// cloud account they have granted Aura a role in, puts a *qualified* one —
    /// `grant:<account>/<handle>` — because a stop against their box has to be
    /// signed by the role they granted rather than by Aura's own credential, and
    /// one field that says both which account and which machine cannot come
    /// apart the way two fields can.
    ///
    /// Never an address and never a credential. It is a name the cloud gave the
    /// machine, and it is useless to anyone who cannot already sign requests
    /// against the account that holds it.
    #[serde(default)]
    pub instance_id: Option<String>,
    /// Unix seconds since Aura put this place to sleep; `0` means awake.
    ///
    /// Written down rather than inferred. The alternative — reading "not on the
    /// board" as "asleep" — would call every unreachable machine asleep and every
    /// genuinely broken one fine, which is the precise inversion this field
    /// exists to prevent. A place is asleep because Aura stopped it and said so.
    #[serde(default)]
    pub asleep_since: i64,
    /// Unix seconds. `last_used_at` orders the list — the box you worked on an
    /// hour ago is the one you mean.
    pub added_at: i64,
    pub last_used_at: i64,
}

/// What the frontend sends to record a machine. `id` is derived, not given, and
/// the timestamps are ours to stamp.
#[derive(Debug, Clone, Deserialize)]
pub struct MachineInput {
    pub name: String,
    pub host: String,
    pub user: String,
    pub key_path: String,
    pub box_kind: String,
    pub repo_path: Option<String>,
    /// Omitted by callers that have no opinion — the directory editor inside a
    /// workspace, for one. Omission MEANS "leave it alone", never "clear it".
    #[serde(default)]
    pub project_root: Option<String>,
}

fn now_secs() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs() as i64)
        .unwrap_or(0)
}

fn book_path() -> Result<PathBuf, String> {
    Ok(aura_dir()?.join("machines.json"))
}

/// The key for one cloud copy of one project.
///
/// `user@host` names a box, and for a long time that was the whole key — one
/// entry per machine. But a box is not what you open; a *project on* a box is.
/// One runner can hold clones of several repos, and with the box as the key
/// they could not both be recorded: connecting the second silently overwrote
/// the first, and the sidebar, which files a machine under its project, had
/// nowhere to put it.
///
/// So the directory joins the key when we know it. A box with no repo path
/// keeps the bare `user@host` form, which is also what every entry written
/// before this looked like — see `machine_save` for why that matters.
pub fn machine_id(user: &str, host: &str, repo_path: Option<&str>) -> String {
    let base = format!("{}@{}", user.trim(), host.trim()).to_lowercase();
    match repo_path.map(str::trim).filter(|p| !p.is_empty()) {
        // The path is NOT lowercased: it is a real path on a real filesystem,
        // and `/srv/App` is not `/srv/app` on the Linux boxes these run on.
        Some(path) => format!("{base}:{path}"),
        None => base,
    }
}

fn read_book() -> Vec<Machine> {
    let Ok(path) = book_path() else {
        return Vec::new();
    };
    let Ok(raw) = std::fs::read_to_string(&path) else {
        return Vec::new();
    };
    // A book we can't parse is a book we don't have. Refusing to list machines
    // because one hand-edit went wrong would take the whole surface down with
    // it; the next save rewrites the file cleanly.
    serde_json::from_str::<Vec<Machine>>(&raw).unwrap_or_default()
}

/// One machine, by id. The book is the only place an address lives, so
/// anything that needs to *reach* a box starts here rather than being handed a
/// host and a key by whatever surface happened to call it — a caller that
/// carries its own copy of an address is a caller that will one day dial a box
/// the user removed.
pub fn find_machine(id: &str) -> Option<Machine> {
    let id = id.trim();
    read_book().into_iter().find(|m| m.id == id)
}

/// Every row in the book, whatever hat you happen to be wearing.
///
/// [`visible_machines`] is the right reader for anything a person is looking at:
/// a box you connected for a client's org has no business on screen while you
/// are working as yourself. The idle sweep is not a surface. A machine still
/// running under an org you are not acting as is still costing money, and a
/// sweep that only saw the current org's boxes would let every other one bill
/// forever — worse, it would stop and start machines depending on which account
/// menu entry happened to be selected.
pub(crate) fn every_machine() -> Vec<Machine> {
    read_book()
}

fn write_book(machines: &[Machine]) -> Result<(), String> {
    let path = book_path()?;
    if let Some(dir) = path.parent() {
        std::fs::create_dir_all(dir).map_err(|e| format!("create {}: {e}", dir.display()))?;
    }
    let body = serde_json::to_string_pretty(machines).map_err(|e| e.to_string())?;
    std::fs::write(&path, body).map_err(|e| format!("write {}: {e}", path.display()))?;
    harden(&path);
    Ok(())
}

/// Close the book to everyone but its owner.
///
/// Spelled as its own function rather than inline in [`write_book`] so the one
/// promise this file makes about the file it writes — *it names your servers,
/// so it is not group-readable and not world-readable* — is a thing a test can
/// hold. Nothing else in the app may relax this: a surface that merges the book
/// with anything (the org's board, a roster, a report) reads it and writes
/// nothing, so the mode bit has exactly one author.
fn harden(path: &std::path::Path) {
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let _ = std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o600));
    }
    #[cfg(not(unix))]
    let _ = path;
}

/// Whether a box belongs on screen while acting as `org`.
///
/// Two of the three cases are deliberately permissive. A machine with no org
/// recorded is one we could not attribute — a book written before the field, a
/// project with no cloud repo behind it — and hiding it would take somebody's
/// working boxes away on upgrade. Being signed out is not a hat either: with no
/// org to act as, every machine is yours to see.
pub(crate) fn visible_in(machine: &Machine, org: Option<&str>) -> bool {
    let mine = machine
        .org_slug
        .as_deref()
        .map(str::trim)
        .filter(|s| !s.is_empty());
    match (org, mine) {
        (_, None) => true,
        (None, Some(_)) => true,
        (Some(active), Some(mine)) => active.eq_ignore_ascii_case(mine),
    }
}

/// Every machine this laptop can reach in the org you're acting as, most
/// recently used first.
///
/// The filter is here rather than in each surface that draws a list, so a place
/// cannot follow the org switch on the fleet page and quietly not follow it in
/// the workspace composer. [`find_machine`] is deliberately NOT filtered:
/// resolving an id you already hold — an open workspace, a session row — is a
/// different question from "what can I reach", and an org switch must not break
/// a terminal that is already open.
#[tauri::command]
pub async fn machines_list() -> Result<Vec<Machine>, String> {
    Ok(visible_machines())
}

/// The same list, for a caller inside the app rather than across the bridge.
///
/// [`machines_list`] is this and nothing else, so a second surface built on the
/// book — the merged place roster, for one — cannot quietly see a different set
/// of machines than the one the fleet page draws. Read-only, like every other
/// reader of the book: the org's board is merged with this at READ time, and
/// nothing in that direction is ever written back into a `0600` file.
pub(crate) fn visible_machines() -> Vec<Machine> {
    let active = crate::cloud_org::active_org_slug();
    let mut all: Vec<Machine> = read_book()
        .into_iter()
        .filter(|m| visible_in(m, active.as_deref()))
        .collect();
    all.sort_by(|a, b| b.last_used_at.cmp(&a.last_used_at));
    all
}

/// File the book's boxes under the orgs their projects belong to.
///
/// Called from [`crate::cmd_cloud_orgs`], which is the only thing in the app
/// that ever holds a cross-org repo list. `by_repo` maps `owner/name` to an org
/// slug; a machine is attributed by resolving the git remote of the LOCAL
/// checkout it is a cloud copy of, which is the one handle a box on someone
/// else's hardware has on a repo the server knows about.
///
/// Only ever fills a blank. A machine that already names an org was stamped
/// when it was saved or filed by an earlier pass, and re-deciding it here would
/// let a repo moving between orgs silently drag a box with it.
pub(crate) fn file_machines_by_org(by_repo: &std::collections::HashMap<String, String>) {
    if by_repo.is_empty() {
        return;
    }
    let mut all = read_book();
    let mut changed = false;
    for m in all.iter_mut() {
        if m.org_slug.as_deref().map(str::trim).is_some_and(|s| !s.is_empty()) {
            continue;
        }
        let Some(root) = m.project_root.as_deref().map(str::trim).filter(|p| !p.is_empty()) else {
            continue;
        };
        let Some(full_name) =
            crate::cloud_session_sync::resolve_repo_full_name(std::path::Path::new(root))
        else {
            continue;
        };
        if let Some(slug) = by_repo.get(&full_name) {
            m.org_slug = Some(slug.clone());
            changed = true;
        }
    }
    // A 0600 file is not rewritten to store what it already says.
    if changed {
        let _ = write_book(&all);
    }
}

/// Record a cloud copy, or update the one already recorded for that login, box
/// and directory.
///
/// Re-connecting keeps the entry's `added_at` — when you first reached this box
/// is history the wizard shouldn't rewrite — and refreshes everything a second
/// run can legitimately change: its board name, its key, and whether it's
/// shared. Pointing the wizard at a DIFFERENT directory on the same box is not
/// a correction, it is a second project, and it gets its own entry.
#[tauri::command]
pub async fn machine_save(machine: MachineInput) -> Result<Machine, String> {
    let host = machine.host.trim().to_string();
    let user = machine.user.trim().to_string();
    let key_path = machine.key_path.trim().to_string();
    if host.is_empty() || user.is_empty() || key_path.is_empty() {
        return Err("A machine needs a host, a login and a key.".into());
    }

    let repo_path = machine
        .repo_path
        .map(|p| p.trim().to_string())
        .filter(|p| !p.is_empty());

    let now = now_secs();
    let mut all = read_book();
    // Match on what the entry IS — this login, on this box, in this directory —
    // rather than on the id we would compute for it. Entries written when the
    // key was just `user@host` carry that shorter id, and recomputing would not
    // find them: re-running the wizard against a box you already had would lay
    // a second row beside the first. Found, we keep its id, so an id already
    // referenced by an open workspace never changes underneath it.
    let prior = all.iter().find(|m| {
        m.user.trim().eq_ignore_ascii_case(&user)
            && m.host.trim().eq_ignore_ascii_case(&host)
            && m.repo_path.as_deref().map(str::trim) == repo_path.as_deref()
    });
    let id = prior
        .map(|m| m.id.clone())
        .unwrap_or_else(|| machine_id(&user, &host, repo_path.as_deref()));
    let added_at = prior.map(|m| m.added_at).unwrap_or(now);
    // A caller that doesn't mention the project isn't asking to forget it. The
    // directory editor inside a workspace re-saves the whole record to change
    // one path; if omission meant `None` it would quietly unfile the machine
    // from its project every time you corrected a typo.
    let project_root = machine
        .project_root
        .map(|p| p.trim().to_string())
        .filter(|p| !p.is_empty())
        .or_else(|| prior.and_then(|m| m.project_root.clone()));

    let saved = Machine {
        id: id.clone(),
        name: machine.name.trim().to_string(),
        host,
        user,
        key_path,
        box_kind: if machine.box_kind == "shared" {
            "shared".into()
        } else {
            "mine".into()
        },
        repo_path,
        project_root,
        // Same rule as the project: an omitted field is not a request to
        // forget. The wizard has no idea what is checked out over there — only
        // something already talking to the box does — so re-saving a record
        // must not throw away the branch the last workspace open observed.
        repo_branch: prior.and_then(|m| m.repo_branch.clone()),
        // You connected this box while acting as somebody, and that is who it
        // belongs to. Never re-decided on a re-save: correcting a key path in
        // the directory editor while wearing a different hat must not move a
        // machine between orgs. The wizard is not asked — it doesn't know, and
        // a question with one possible answer is not worth a field on a form.
        org_slug: prior
            .and_then(|m| m.org_slug.clone())
            .or_else(crate::cloud_org::active_org_slug),
        // Never re-decided by a re-save, and never turned ON by one. The wizard
        // does not ask — consent to lend a box your key is given deliberately,
        // on the place itself, and correcting a key path there must neither
        // withdraw it nor grant it. `false` for a machine being written for the
        // first time is the whole default this task is about.
        forward_agent: prior.is_some_and(|m| m.forward_agent),
        // Carried, never minted here. A box that arrives through this function
        // arrived because somebody typed an address into the wizard, and a box
        // you typed in is a box you brought — Aura holds no account that could
        // stop it, so it has no substrate handle and must not acquire one by
        // being re-saved. Carrying `prior` matters for the other direction:
        // correcting a key path on a machine Aura *did* make must not erase the
        // handle, because a row that forgot its instance id is a machine that
        // can never be slept again and keeps billing forever.
        instance_id: prior.and_then(|m| m.instance_id.clone()),
        // Likewise carried. Editing a sleeping machine's directory does not
        // wake it, and a re-save that zeroed this would make the roster draw an
        // asleep place as a running one — the exact misreading in reverse.
        asleep_since: prior.map_or(0, |m| m.asleep_since),
        added_at,
        last_used_at: now,
    };

    all.retain(|m| m.id != id);
    all.push(saved.clone());
    write_book(&all)?;
    Ok(saved)
}

/// Mark a machine as the one you just worked on, so the list stays ordered by
/// where your attention actually is.
#[tauri::command]
pub async fn machine_touch(id: String) -> Result<(), String> {
    let mut all = read_book();
    let mut hit = false;
    for m in all.iter_mut() {
        if m.id == id {
            m.last_used_at = now_secs();
            hit = true;
        }
    }
    if !hit {
        return Ok(());
    }
    write_book(&all)
}

/// File a machine under the project it is a cloud copy of.
///
/// Separate from `machine_save` because it answers a different question and has
/// a different caller: `machine_save` is the wizard writing a whole record,
/// this is a workspace noticing, on the way in, that the box it just opened for
/// a project had never been told which one. That backfill is why books written
/// before `project_root` existed heal themselves the first time you use them
/// instead of needing a migration nobody would run.
///
/// Passing `None` unfiles it — the machine goes back to standing on its own.
#[tauri::command]
pub async fn machine_set_project(id: String, project_root: Option<String>) -> Result<(), String> {
    let root = project_root
        .map(|p| p.trim().to_string())
        .filter(|p| !p.is_empty());
    let mut all = read_book();
    let mut changed = false;
    for m in all.iter_mut() {
        if m.id == id && m.project_root != root {
            m.project_root = root.clone();
            changed = true;
        }
    }
    // Rewriting the book to store what it already says would churn a 0600 file
    // on every workspace open.
    if !changed {
        return Ok(());
    }
    write_book(&all)
}

/// Record what is checked out on the box, so the rail can name the work rather
/// than the computer.
///
/// Written by whoever already had the box on the line — listing its projects
/// hands back a branch per checkout, so the answer costs nothing extra. Kept
/// separate from `machine_save` for the same reason `machine_set_project` is:
/// this is a passing observation, not the wizard rewriting a record, and it
/// must never clear the fields it wasn't asked about.
///
/// `None` means "we looked and there is nothing checked out there" — a bare
/// directory, a detached head we couldn't name. That is a real answer and it
/// clears the cached one, because a branch name we know to be wrong is worse
/// than none.
#[tauri::command]
pub async fn machine_set_branch(id: String, branch: Option<String>) -> Result<(), String> {
    let branch = branch
        .map(|b| b.trim().to_string())
        .filter(|b| !b.is_empty() && b != "HEAD");
    let mut all = read_book();
    let mut changed = false;
    for m in all.iter_mut() {
        if m.id == id && m.repo_branch != branch {
            m.repo_branch = branch.clone();
            changed = true;
        }
    }
    // Same reason as `machine_set_project`: a workspace open shouldn't rewrite a
    // 0600 file to store what it already says.
    if !changed {
        return Ok(());
    }
    write_book(&all)
}

/// Record whether this box may use the ssh agent on this laptop.
///
/// Deliberately NOT a `#[tauri::command]`, unlike its neighbours. Lending a
/// machine the use of your key is a decision about a *place*, and it is taken
/// through [`crate::manager::brain::place_forward`] so that turning it off also
/// drops the connection still carrying it — a book that said "off" while a live
/// master socket went on offering your agent would be a setting that lies.
/// This is only the writing-down.
///
/// Answers whether anything changed, so the caller can skip the work that
/// follows a change without re-reading the book to find out.
pub(crate) fn set_forward_agent(id: &str, on: bool) -> Result<bool, String> {
    let id = id.trim();
    let mut all = read_book();
    let mut changed = false;
    for m in all.iter_mut() {
        if m.id == id && m.forward_agent != on {
            m.forward_agent = on;
            changed = true;
        }
    }
    if !changed {
        return Ok(false);
    }
    write_book(&all)?;
    Ok(true)
}

/// Write down that a place is asleep, or awake again.
///
/// Deliberately NOT a `#[tauri::command]`, for the same reason as
/// [`set_forward_agent`]: sleeping a place is an act, not a note, and it is taken
/// through [`crate::manager::brain::place_sleep`] so the machine is really
/// stopped before the book says it is. A book that said "asleep" about a running
/// box would be a bill nobody is watching; one that said "awake" about a stopped
/// one would send every surface dialling a machine that cannot answer. This is
/// only the writing-down.
///
/// `at` is unix seconds, or `0` for awake.
pub(crate) fn set_asleep_since(id: &str, at: i64) -> Result<bool, String> {
    let id = id.trim();
    let mut all = read_book();
    let mut changed = false;
    for m in all.iter_mut() {
        if m.id == id && m.asleep_since != at {
            m.asleep_since = at;
            changed = true;
        }
    }
    if !changed {
        return Ok(false);
    }
    write_book(&all)?;
    Ok(true)
}

/// Write down that a box the customer owns may be switched off by Aura, or that
/// it may not any more.
///
/// The one door through which a machine somebody brought gains a lifecycle
/// handle, and it is deliberately narrower than the field it writes. It accepts
/// only a *qualified* handle — `grant:<account>/<machine>` — so nothing that
/// comes through here can make a row look like a machine Aura made in its own
/// account. That distinction decides whose credential signs a stop and whose
/// bill it lands on, and it is not one a caller should be able to blur by
/// passing a bare string.
///
/// `None` gives the permission back. The row keeps working exactly as it did
/// before the grant — the metal was always the customer's — and the only thing
/// that changes is that Aura stops offering to switch it off.
///
/// Not a `#[tauri::command]` for the same reason as [`set_asleep_since`]:
/// linking is an act, taken through [`crate::manager::brain::place_grant`],
/// which proves the account can actually be reached and finds the machine's real
/// handle before anything is written down. This is only the writing-down.
pub(crate) fn set_granted_handle(id: &str, handle: Option<&str>) -> Result<bool, String> {
    let id = id.trim();
    let handle = handle.map(str::trim).filter(|h| !h.is_empty());
    if let Some(h) = handle {
        if !crate::provisioner::granted_handle(h) {
            return Err(
                "That isn't a machine in an account you've given Aura permission to use.".into(),
            );
        }
    }
    let handle = handle.map(str::to_string);

    let mut all = read_book();
    let mut changed = false;
    for m in all.iter_mut() {
        if m.id != id {
            continue;
        }
        // Only a row with no handle, or one already granted, is this function's
        // to touch. A machine Aura made carries a bare handle it still needs in
        // order to stop itself, and quietly replacing that would strand a
        // running box on Aura's own bill with nothing able to name it.
        if !grant_may_replace(m.instance_id.as_deref()) {
            return Err("Aura made this machine and already switches it off for you.".to_string());
        }
        if m.instance_id != handle {
            m.instance_id = handle.clone();
            changed = true;
        }
    }
    if !changed {
        return Ok(false);
    }
    write_book(&all)?;
    Ok(true)
}

/// Whether the handle a row is carrying is one a grant may write over.
///
/// Split out of [`set_granted_handle`] so the rule can be read and tested
/// without a book on disk, because it is the rule that keeps two very different
/// machines apart: nothing, which anybody may claim, and a handle Aura's own
/// provisioning minted, which is the only string standing between a machine on
/// Aura's bill and nobody being able to stop it.
fn grant_may_replace(current: Option<&str>) -> bool {
    current.is_none_or(crate::provisioner::granted_handle)
}

/// Record where a machine is now, after it moved.
///
/// A stopped machine gives up its public address and gets a different one when
/// it starts, so waking one without writing this leaves a place that is up,
/// billed, and dialling yesterday's host.
///
/// What it does NOT touch is the row's `id`. The id is derived from the address
/// — `user@host:/repo` — but it is also the book's KEY, and every workspace,
/// every open tab and every session on this laptop holds it. Re-deriving it here
/// because the host moved would orphan all of them at once, to fix a string
/// nothing reads for its parts. So the key stays put and the address underneath
/// it is corrected, which is what the key was always standing for.
pub(crate) fn set_host(id: &str, host: &str) -> Result<bool, String> {
    let id = id.trim();
    let host = host.trim();
    if host.is_empty() {
        return Err("A machine with no address isn't one this laptop can reach.".to_string());
    }
    let mut all = read_book();
    let mut changed = false;
    for m in all.iter_mut() {
        if m.id == id && m.host != host {
            m.host = host.to_string();
            changed = true;
        }
    }
    if !changed {
        return Ok(false);
    }
    write_book(&all)?;
    Ok(true)
}

/// Write down a machine AURA MADE, with the substrate handle that proves it.
///
/// Deliberately apart from [`machine_save`], which is the wizard's door and
/// refuses to mint an `instance_id` on purpose: a row that arrives through
/// there arrived because somebody typed an address, and a box you typed in is a
/// box you brought. This is the other door, and it is narrow — not a
/// `#[tauri::command]`, so nothing across the wire can claim a machine is
/// Aura's — and taken by exactly one caller,
/// [`crate::place_make`], right after the provisioner said where the machine
/// landed.
///
/// The handle is the point. It is what makes the place sleepable, and a managed
/// row written without one is a machine that bills forever and can never be
/// stopped, which is worse than not writing the row at all. So it is a
/// parameter rather than an option, and an empty one is refused.
///
/// `key_ref` is a REFERENCE — `managed:<id>` — and never a key: Aura holds the
/// key server-side and lends a signature at a time (see
/// [`crate::cloudbox::managed_key`]). It goes in `key_path` because that field
/// has always been the reference rather than the material, which is what lets
/// every surface downstream read one machine shape instead of two.
pub(crate) fn record_made_machine(
    name: &str,
    host: &str,
    ssh_user: &str,
    key_ref: &str,
    repo_path: Option<&str>,
    instance_id: &str,
) -> Result<Machine, String> {
    let saved = made_machine(
        name,
        host,
        ssh_user,
        key_ref,
        repo_path,
        instance_id,
        // Whoever made it made it as somebody, and that is the org it belongs
        // to — the same rule `machine_save` follows.
        crate::cloud_org::active_org_slug(),
        now_secs(),
    )?;

    let mut all = read_book();
    all.retain(|m| m.id != saved.id);
    all.push(saved.clone());
    write_book(&all)?;
    Ok(saved)
}

/// The row a machine Aura made gets, before anything writes it down.
///
/// Split out of [`record_made_machine`] rather than inlined there so the parity
/// matrix can run its Aura-made column against THIS row instead of against a
/// literal standing beside it. A fixture that spells out what a managed machine
/// looks like is a second opinion about what one IS, and the field it is likeliest
/// to get wrong is the field that carries the whole point: a hand-written row
/// that gives the member a `.pem` on their own disk describes a place Aura never
/// makes, and every workflow run against it comes out green about the wrong
/// machine.
///
/// The two ambient facts are parameters rather than reads, because that is the
/// only thing standing between this and a pure function — and a builder that
/// reaches for the clock and the active org is one nothing else can call.
#[allow(clippy::too_many_arguments)]
pub(crate) fn made_machine(
    name: &str,
    host: &str,
    ssh_user: &str,
    key_ref: &str,
    repo_path: Option<&str>,
    instance_id: &str,
    org_slug: Option<String>,
    made_at: i64,
) -> Result<Machine, String> {
    let name = name.trim();
    let host = host.trim();
    let user = ssh_user.trim();
    let key_ref = key_ref.trim();
    let instance_id = instance_id.trim();
    if host.is_empty() || user.is_empty() || key_ref.is_empty() {
        return Err("Aura made a machine but couldn't say where it is.".into());
    }
    if instance_id.is_empty() {
        return Err("Aura made a machine but didn't get a handle for it.".into());
    }
    let repo_path = repo_path
        .map(str::trim)
        .filter(|p| !p.is_empty())
        .map(str::to_string);

    Ok(Machine {
        id: machine_id(user, host, repo_path.as_deref()),
        name: name.to_string(),
        host: host.to_string(),
        user: user.to_string(),
        key_path: key_ref.to_string(),
        // The third kind, and the reason it is a string rather than a pair of
        // booleans. A managed box IS shared — several members work on it — but
        // it is shared under an account Aura holds rather than one its owner
        // handed round, which is what decides who may sleep it and whose bill
        // it lands on.
        box_kind: "managed".into(),
        repo_path,
        // The org-wide machine this flow makes has no project of its own on
        // this laptop yet. Naming one here would file a team's box under
        // whichever checkout the admin happened to have open. `machine_set_project`
        // and `machine_set_branch` fill both in later, once something has
        // actually opened the box and knows.
        project_root: None,
        repo_branch: None,
        org_slug,
        // A machine Aura made is opened through a key Aura holds, so there is
        // no key on this laptop to lend anybody. Off, and never asked about.
        forward_agent: false,
        instance_id: Some(instance_id.to_string()),
        asleep_since: 0,
        added_at: made_at,
        last_used_at: made_at,
    })
}

/// Forget how to reach a machine. Nothing on the box is touched — the runner
/// there keeps draining the board; this laptop just stops holding its address.
#[tauri::command]
pub async fn machine_forget(id: String) -> Result<(), String> {
    let mut all = read_book();
    let before = all.len();
    all.retain(|m| m.id != id);
    if all.len() == before {
        return Ok(());
    }
    write_book(&all)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn id_is_stable_across_case_and_padding() {
        assert_eq!(
            machine_id("ubuntu", "box.example", None),
            "ubuntu@box.example",
        );
        assert_eq!(
            machine_id(" Ubuntu ", " Box.Example ", None),
            machine_id("ubuntu", "box.example", None),
        );
    }

    /// Granting Aura a role in your own account must never be able to reach a
    /// machine Aura made in its own.
    ///
    /// Those rows carry the only string that can name the box in a stop
    /// request, and they are billed to Aura rather than to whoever is clicking.
    /// Overwriting one would leave a machine running, metered, and unstoppable —
    /// so the rule is about the handle already on the row and not about who
    /// asked, which is what makes it hold however the call arrives.
    #[test]
    fn a_grant_can_claim_a_box_you_brought_and_never_one_aura_made() {
        assert!(grant_may_replace(None));
        assert!(grant_may_replace(Some("grant:acme-eu/i-0123456789abcdef0")));
        assert!(!grant_may_replace(Some("i-0123456789abcdef0")));
    }

    /// Two projects on one box are two cloud copies, and the sidebar files each
    /// under its own project — which it cannot do if they share a key.
    #[test]
    fn two_projects_on_one_box_are_two_entries() {
        let a = machine_id("ubuntu", "box.example", Some("/home/ubuntu/aura-src"));
        let b = machine_id("ubuntu", "box.example", Some("/home/ubuntu/naridon"));
        assert_ne!(a, b);
        assert_eq!(a, "ubuntu@box.example:/home/ubuntu/aura-src");
    }

    /// A box with no directory keeps the bare form — which is also the form
    /// every entry written before the directory joined the key already has, so
    /// nothing in an existing book has to be rewritten.
    #[test]
    fn a_box_with_no_directory_keeps_the_old_key() {
        assert_eq!(
            machine_id("ubuntu", "box.example", Some("   ")),
            machine_id("ubuntu", "box.example", None),
        );
    }

    /// The login and host are case-insensitive (DNS is); the directory is not.
    /// These boxes run Linux, where `/srv/App` and `/srv/app` are two places.
    #[test]
    fn the_directory_half_of_the_key_keeps_its_case() {
        assert_ne!(
            machine_id("ubuntu", "box.example", Some("/srv/App")),
            machine_id("ubuntu", "box.example", Some("/srv/app")),
        );
    }

    /// A book written before `project_root` existed still has to load. Without
    /// the serde default this is a parse error, and `read_book` answers a parse
    /// error by returning an EMPTY book — every machine the user connected
    /// would silently vanish from the rail on upgrade.
    #[test]
    fn a_book_from_before_the_field_still_parses() {
        let old = r#"[{
            "id": "ubuntu@10.0.0.1",
            "name": "aura-runner",
            "host": "10.0.0.1",
            "user": "ubuntu",
            "key_path": "/keys/aura.pem",
            "box_kind": "mine",
            "repo_path": "/home/ubuntu/aura-src",
            "added_at": 1,
            "last_used_at": 2
        }]"#;
        let parsed: Vec<Machine> = serde_json::from_str(old).expect("old book must still load");
        assert_eq!(parsed.len(), 1);
        assert_eq!(parsed[0].project_root, None);
        // Same bargain for the org: unknown, not "no org", so the box keeps
        // showing up until something can attribute it.
        assert_eq!(parsed[0].org_slug, None);
    }

    fn boxed(org: Option<&str>) -> Machine {
        Machine {
            id: "ubuntu@box.example:/srv/app".into(),
            name: "aura-runner".into(),
            host: "box.example".into(),
            user: "ubuntu".into(),
            key_path: "/keys/aura.pem".into(),
            box_kind: "mine".into(),
            repo_path: Some("/srv/app".into()),
            project_root: Some("/Users/me/app".into()),
            repo_branch: None,
            org_slug: org.map(str::to_string),
            forward_agent: false,
            instance_id: None,
            asleep_since: 0,
            added_at: 1,
            last_used_at: 2,
        }
    }

    /// The switcher's whole claim about places: a box you connected for one org
    /// is not on screen while you are acting as another.
    #[test]
    fn a_box_belongs_to_the_org_it_was_connected_under() {
        assert!(visible_in(&boxed(Some("naridon")), Some("naridon")));
        assert!(!visible_in(&boxed(Some("naridon")), Some("mhask")));
    }

    /// A machine we could not attribute is shown everywhere. Books written
    /// before this field exist on every install that has ever connected a box,
    /// and an upgrade that made those vanish would read as data loss.
    #[test]
    fn a_machine_with_no_org_is_never_hidden_by_one() {
        assert!(visible_in(&boxed(None), Some("naridon")));
        assert!(visible_in(&boxed(None), None));
    }

    /// Signed out is not a hat. With no org to act as, there is nothing for a
    /// machine to be filtered against.
    #[test]
    fn signed_out_sees_every_machine() {
        assert!(visible_in(&boxed(Some("naridon")), None));
    }

    /// Slugs are lowercase by construction, but the credentials file is
    /// hand-editable and the book is written by several versions of the app.
    #[test]
    fn the_match_does_not_turn_on_case() {
        assert!(visible_in(&boxed(Some("Naridon")), Some("naridon")));
    }

    /// A blank string in the book is not an org — it is the same "we don't
    /// know" that `None` is, and must not hide the machine from everyone.
    #[test]
    fn a_blank_org_reads_as_unknown_rather_than_as_a_name_nobody_has() {
        assert!(visible_in(&boxed(Some("   ")), Some("naridon")));
    }

    /// The book is closed to everyone but its owner, and stays closed.
    ///
    /// Written as a test rather than trusted to the one line in `write_book`
    /// because the mode bit is the whole of the book's privacy: it names your
    /// servers, and the merged place roster now reads it beside a list that
    /// came off the network. A change that widened this — a `create` that
    /// forgot the chmod, a "make it readable so the CLI can see it too" — would
    /// be silent everywhere else.
    #[cfg(unix)]
    #[test]
    fn the_book_is_shut_to_everyone_but_its_owner() {
        use std::os::unix::fs::PermissionsExt;
        let path = std::env::temp_dir().join(format!(
            "aura-machine-book-{}-{}.json",
            std::process::id(),
            line!(),
        ));
        std::fs::write(&path, "[]").expect("write the scratch book");
        // Start from what a stock umask would have left, so the test would fail
        // if `harden` became a no-op rather than passing on a file that was
        // already tight.
        std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o644))
            .expect("open it first");
        harden(&path);
        let mode = std::fs::metadata(&path).expect("stat").permissions().mode() & 0o777;
        let _ = std::fs::remove_file(&path);
        assert_eq!(mode, 0o600, "the machine book must be owner-only");
    }

    /// Omitting the field means "leave it alone". The directory editor inside a
    /// workspace re-sends the whole record to change one path, and it has no
    /// idea which project the box is filed under.
    #[test]
    fn input_without_a_project_root_is_not_a_request_to_clear_it() {
        let input: MachineInput = serde_json::from_str(
            r#"{
                "name": "aura-runner",
                "host": "10.0.0.1",
                "user": "ubuntu",
                "key_path": "/keys/aura.pem",
                "box_kind": "mine",
                "repo_path": "/home/ubuntu/aura-src"
            }"#,
        )
        .expect("input without the field must parse");
        assert_eq!(input.project_root, None);
    }
}
