//! Opening a machine Aura made, without ever holding its key.
//!
//! A box somebody brought has a key on their own disk, and [`super::ssh_argv`]
//! points at it with `-i`. A box Aura made has a key too — and the member never
//! gets a copy. They did not build the machine, they cannot re-key it, and a
//! copy on a laptop outlives their access to the org by exactly as long as the
//! laptop does.
//!
//! So the key stays on Aura's side and this laptop is handed a *connection*: an
//! address it already had, the public half the box already trusts, and a
//! short-lived grant that buys a bounded number of signatures. The three pieces
//! here are that arrangement:
//!
//!   * [`broker`] — asking for the connection, and spending it.
//!   * [`wire`] — the agent protocol, as bytes.
//!   * [`agent`] — a socket that answers signing challenges by asking Aura.
//!
//! ## Why this is not a second transport
//!
//! It would have been easy to give managed places their own way out — fetch
//! something, write it somewhere, run a different command. That is the failure
//! this whole seam exists to prevent: two ways of reaching a box means every fix
//! to one of them is a bug in the other, and the difference only shows up on
//! whichever kind of machine the person reporting it happens to own.
//!
//! There is no second spawn here, and no second command line. `ssh` will
//! authenticate against an *agent* as readily as against a key file — it is the
//! same interface a hardware token uses, and the reason a Yubikey works without
//! the key ever being readable. So a managed place is the identical `ssh` call
//! with one option changed: `IdentityAgent` instead of `-i`. Everything
//! downstream — multiplexing, timeouts, the tmux scripts, the parsers, every
//! surface built on [`crate::manager::brain::place::Place`] — cannot tell the
//! two apart, which is the point.
//!
//! ## WHAT AN ATTACKER WHO STEALS THIS LAPTOP SEES
//!
//! No key. There is no file to copy, no keychain item to unlock and nothing in
//! this process's memory that still works tomorrow. What they get is whatever
//! grants are live: minutes each, a few dozen signatures each, one machine each,
//! as one named member — and every signature goes through Aura, is counted, and
//! is attributable. Revoking that member's cloud access kills them on the next
//! signature rather than at the next expiry.
//!
//! Compare the honest alternative. Had the key been shipped here, the same theft
//! would be permanent, silent, unrevocable without re-keying every box in the
//! fleet, and passable to anybody. The claim is not that this laptop is harder
//! to steal. It is that stealing it buys minutes of one person's access instead
//! of the fleet.

pub mod broker;
pub mod wire;

#[cfg(unix)]
pub mod agent;

use crate::cmd_machines::Machine;

/// What marks a key reference as one Aura holds rather than one on this disk.
///
/// The same prefix the runner registry's `key_ref` column and the managed
/// provisioner's settings both check for — one spelling, because a machine
/// classified as managed here and as bring-your-own there would be a machine
/// that asks for a connection and then dials with `-i managed:…`.
pub const MANAGED_PREFIX: &str = "managed:";

/// Is this a key Aura holds?
pub fn is_managed(key_ref: &str) -> bool {
    key_ref.trim().starts_with(MANAGED_PREFIX)
}

/// The identity options for a machine, or `None` for one that carries its own
/// key path and needs nothing from here.
///
/// `IdentitiesOnly=yes` goes with the agent for the same reason it would go with
/// a key: without it the far side offers everything the member's own agent
/// holds before it gets to this one, and on a box that logs failed attempts that
/// is a member's whole keyring walked past a machine they were only trying to
/// open one way.
///
/// A `None` for a machine that IS managed — no home directory, a path too long
/// for a unix socket — is deliberately not papered over with a fallback to `-i`,
/// which would hand `ssh` a key path of `managed:…` and produce a file-not-found
/// where the real answer is "this laptop cannot broker a connection". See
/// [`unbrokerable`], which says that in words before anything is dialled.
pub fn identity_args(m: &Machine) -> Option<Vec<String>> {
    let key_ref = m.key_path.trim();
    if !is_managed(key_ref) {
        return None;
    }
    let socket = socket_for(m.name.trim(), key_ref)?;
    Some(vec![
        "-o".into(),
        format!("IdentityAgent={socket}"),
        "-o".into(),
        "IdentitiesOnly=yes".into(),
    ])
}

/// Why this laptop cannot open this machine, when it cannot.
///
/// `None` is the ordinary answer, including for every bring-your-own box. It
/// exists so the refusal arrives as a sentence a person can act on rather than
/// as `Permission denied (publickey)`, which is the least diagnosable thing
/// `ssh` says and reads as "the box has stopped trusting you".
pub fn unbrokerable(m: &Machine) -> Option<String> {
    if !is_managed(m.key_path.trim()) {
        return None;
    }
    if identity_args(m).is_some() {
        return None;
    }
    Some(format!(
        "{} is a machine Aura looks after, and this laptop couldn't open the local \
         connection it needs. Restart Aura, and if it keeps happening, connect the box \
         with a key of your own instead.",
        m.name.trim()
    ))
}

#[cfg(unix)]
fn socket_for(machine_name: &str, key_ref: &str) -> Option<String> {
    agent::socket_for(machine_name, key_ref)
}

/// Windows has no unix socket to serve this on, and its `ssh` names an agent by
/// a pipe this process does not yet publish.
///
/// A named `None` rather than a half-built path: a managed place refuses to open
/// with the sentence in [`unbrokerable`], which is true, checkable and fixable
/// by bringing a box. Pretending otherwise would produce a machine that appears
/// in the list and fails on every call.
#[cfg(not(unix))]
fn socket_for(_machine_name: &str, _key_ref: &str) -> Option<String> {
    None
}

#[cfg(test)]
mod tests {
    use super::*;

    fn machine(key_path: &str) -> Machine {
        Machine {
            id: "ubuntu@10.0.0.4".into(),
            name: "builder".into(),
            host: "10.0.0.4".into(),
            user: "ubuntu".into(),
            key_path: key_path.into(),
            box_kind: "mine".into(),
            repo_path: None,
            repo_branch: None,
            project_root: None,
            org_slug: None,
            forward_agent: false,
            instance_id: None,
            asleep_since: 0,
            added_at: 0,
            last_used_at: 0,
        }
    }

    #[test]
    fn a_reference_aura_holds_is_told_apart_from_a_path_on_this_disk() {
        assert!(is_managed("managed:d290f1ee-6c54-4b01-90e6-d701748f0851"));
        assert!(is_managed("  managed:x  "));
        assert!(!is_managed("~/.ssh/id_ed25519"));
        assert!(!is_managed("/Users/someone/keys/managed:not-really.pem"));
        assert!(!is_managed(""));
    }

    #[test]
    fn a_box_somebody_brought_asks_nothing_of_this_module() {
        // The whole bring-your-own path has to be untouched by this existing.
        assert!(identity_args(&machine("~/.ssh/id_ed25519")).is_none());
        assert!(unbrokerable(&machine("~/.ssh/id_ed25519")).is_none());
    }

    #[cfg(unix)]
    #[test]
    fn a_managed_place_is_offered_one_identity_and_only_that_one() {
        if std::env::var("HOME").is_err() {
            return;
        }
        let args = identity_args(&machine("managed:d290f1ee-6c54-4b01-90e6-d701748f0851"))
            .expect("an agent");
        assert_eq!(args[0], "-o");
        assert!(args[1].starts_with("IdentityAgent=/"), "{}", args[1]);
        assert!(args[1].ends_with(".sock"), "{}", args[1]);
        // Without this the far side walks the member's whole keyring past a box
        // they were only trying to open one way.
        assert_eq!(args[3], "IdentitiesOnly=yes");
        // And nothing in the argv is a key or a path to one.
        let flat = args.join(" ");
        assert!(!flat.contains("-i "), "{flat}");
        assert!(!flat.to_ascii_uppercase().contains("PRIVATE"), "{flat}");
    }

    #[cfg(unix)]
    #[test]
    fn a_managed_place_this_laptop_can_serve_has_nothing_to_complain_about() {
        if std::env::var("HOME").is_err() {
            return;
        }
        assert!(unbrokerable(&machine("managed:550e8400-e29b-41d4-a716-446655440000")).is_none());
    }

    #[test]
    fn the_refusal_names_the_machine_and_what_to_do_instead() {
        // Exercised through the one path that can produce it without a socket:
        // a machine that is managed on a build with no agent to serve it.
        let m = machine("managed:x");
        if let Some(said) = unbrokerable(&m) {
            assert!(said.contains("builder"), "{said}");
            assert!(said.contains("connect the box"), "{said}");
            // Never `ssh`'s own words, which say the box stopped trusting you.
            assert!(!said.contains("publickey"), "{said}");
        }
    }
}
