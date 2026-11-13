//! What a row in the machine book is called, and every name it went by before.
//!
//! A row used to be called by its address — `user@host:/repo`. That made the
//! key a description of where the box was, and the box does not stay there:
//! a stopped machine comes back on a new address, and the wizard pointed at the
//! new one wrote a NEW row under a NEW key. Every workspace, chat and panel on
//! this laptop still held the old key, so all of them found their machine gone
//! at the same moment, for a box that had only moved.
//!
//! So a row's id is now a name of its own, `m-` and sixteen hex digits, with
//! no host in it. Changing the address underneath it is an edit to one row and
//! changes nothing that points at it.
//!
//! Two rules keep the ids that were already handed out working:
//!
//! - A row written under its address is renamed once, the first time the book
//!   is read, and keeps the address key in `aliases`. Anything still holding
//!   the old key — a saved chat, a tab strip, a background session — resolves
//!   to the same row through it.
//! - The new name is DERIVED from the address key, not drawn at random. Two
//!   copies of the app reading one book rename it the same way, a rename that
//!   could not be written back comes out the same on the next read, and an old
//!   key still finds its row even if an older build rewrote the book and
//!   dropped the alias list it does not know about.
//!
//! A row made fresh takes the same derivation of the address it was first
//! reached at, which is also what that address would have been renamed to. It
//! does not follow the address after that: the id is fixed the moment the row
//! is, and the host field is the only thing that moves.

use super::{machine_id, Machine};

const PREFIX: &str = "m-";
/// Sixteen hex digits — 64 bits. The book holds a handful of rows on one
/// laptop; this is about not having to think about collisions, not about
/// surviving an adversary, and a short id is kinder to the storage keys that
/// embed it.
const DIGITS: usize = 16;

/// Whether `id` is an address key from before rows had names of their own.
///
/// An address always has a login in it, and an `m-` name never has an `@`, so
/// the one character is enough to tell the two apart without parsing either.
pub(crate) fn is_address_key(id: &str) -> bool {
    id.contains('@')
}

/// Whether `id` is a name this module hands out.
pub(crate) fn is_stable(id: &str) -> bool {
    id.strip_prefix(PREFIX).is_some_and(|hex| {
        hex.len() == DIGITS && hex.bytes().all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
    })
}

/// The name a row reached at `address_key` goes by.
pub(crate) fn from_address_key(address_key: &str) -> String {
    let hex = blake3::hash(address_key.trim().as_bytes()).to_hex();
    format!("{PREFIX}{}", &hex.as_str()[..DIGITS])
}

/// The name for a row first reached as `user` on `host` in `repo_path`.
pub(crate) fn from_address(user: &str, host: &str, repo_path: Option<&str>) -> String {
    from_address_key(&machine_id(user, host, repo_path))
}

/// Whether any row in `book` already answers to `id`.
fn taken(book: &[Machine], id: &str) -> bool {
    book.iter().any(|m| m.id == id || m.aliases.iter().any(|a| a == id))
}

/// A name no row in `book` answers to.
///
/// Only reached when a derived name is already in use — a row that has moved
/// off an address, and a different box turning up at that address later.
pub(crate) fn fresh(book: &[Machine]) -> String {
    loop {
        let hex = uuid::Uuid::new_v4().simple().to_string();
        let id = format!("{PREFIX}{}", &hex[..DIGITS]);
        if !taken(book, &id) {
            return id;
        }
    }
}

/// Which row `id` names.
///
/// A row's own id wins over another row's old one, so a name handed out today
/// can never be shadowed by something a different row used to be called. After
/// that the aliases, and last the derivation, for an address key held by
/// something that outlived the alias list it was recorded in.
pub(crate) fn locate(book: &[Machine], id: &str) -> Option<usize> {
    let id = id.trim();
    if id.is_empty() {
        return None;
    }
    book.iter()
        .position(|m| m.id == id)
        .or_else(|| book.iter().position(|m| m.aliases.iter().any(|a| a == id)))
        .or_else(|| {
            if !is_address_key(id) {
                return None;
            }
            let derived = from_address_key(id);
            book.iter().position(|m| m.id == derived)
        })
}

/// The id of the row `id` names, or `id` itself when no row does — so a
/// mutator that compares against it matches nothing rather than something.
pub(crate) fn canonical(book: &[Machine], id: &str) -> String {
    match locate(book, id) {
        Some(at) => book[at].id.clone(),
        None => id.trim().to_string(),
    }
}

/// The id and aliases a brand-new row takes.
///
/// `asked` is the id the caller is reconnecting, when it is reconnecting one
/// the book no longer holds. The new row takes that name so everything still
/// pointing at it finds it again — directly for a name, through the alias for
/// an address key. With nothing asked, it is named after where it was reached.
pub(crate) fn claim(
    book: &[Machine],
    asked: Option<&str>,
    user: &str,
    host: &str,
    repo_path: Option<&str>,
) -> (String, Vec<String>) {
    let (wanted, aliases) = match asked.map(str::trim).filter(|a| !a.is_empty()) {
        Some(a) if is_address_key(a) => (from_address_key(a), vec![a.to_string()]),
        Some(a) if is_stable(a) => (a.to_string(), Vec::new()),
        _ => (from_address(user, host, repo_path), Vec::new()),
    };
    let id = if taken(book, &wanted) { fresh(book) } else { wanted };
    (id, aliases)
}

/// Rename every row still called by its address. Answers whether any was.
///
/// Idempotent: a renamed row has no `@` in its id, so a second pass finds
/// nothing to do.
pub(crate) fn migrate(book: &mut [Machine]) -> bool {
    let mut changed = false;
    for at in 0..book.len() {
        if !is_address_key(&book[at].id) {
            continue;
        }
        let old = book[at].id.trim().to_string();
        let derived = from_address_key(&old);
        let clash = book
            .iter()
            .enumerate()
            .any(|(other, m)| other != at && (m.id == derived || m.aliases.contains(&derived)));
        let id = if clash { fresh(book) } else { derived };
        let row = &mut book[at];
        if !row.aliases.contains(&old) {
            row.aliases.push(old);
        }
        row.id = id;
        changed = true;
    }
    changed
}

#[cfg(test)]
mod tests {
    use super::*;

    fn row(id: &str, host: &str) -> Machine {
        Machine {
            id: id.into(),
            aliases: Vec::new(),
            name: "aura-runner".into(),
            host: host.into(),
            user: "ubuntu".into(),
            key_path: "/keys/aura.pem".into(),
            box_kind: "mine".into(),
            repo_path: Some("/srv/app".into()),
            project_root: Some("/Users/me/app".into()),
            repo_branch: None,
            org_slug: None,
            forward_agent: false,
            instance_id: None,
            asleep_since: 0,
            added_at: 1,
            last_used_at: 2,
        }
    }

    #[test]
    fn a_name_carries_no_address() {
        let id = from_address("ubuntu", "10.0.0.1", Some("/srv/app"));
        assert!(is_stable(&id), "{id}");
        assert!(!id.contains("10.0.0.1") && !is_address_key(&id));
        assert!(is_stable(&fresh(&[])));
    }

    #[test]
    fn the_same_address_is_always_given_the_same_name() {
        assert_eq!(
            from_address(" Ubuntu ", "Box.Example", Some("/srv/app")),
            from_address_key("ubuntu@box.example:/srv/app"),
        );
        assert_ne!(
            from_address("ubuntu", "10.0.0.1", Some("/srv/app")),
            from_address("ubuntu", "10.0.0.2", Some("/srv/app")),
        );
    }

    #[test]
    fn an_old_book_is_renamed_once_and_keeps_its_old_keys() {
        let mut book = vec![row("ubuntu@10.0.0.1:/srv/app", "10.0.0.1"), row("m-0123456789abcdef", "10.0.0.2")];
        assert!(migrate(&mut book));
        assert_eq!(book[0].id, from_address_key("ubuntu@10.0.0.1:/srv/app"));
        assert_eq!(book[0].aliases, vec!["ubuntu@10.0.0.1:/srv/app".to_string()]);
        assert_eq!(book[1].id, "m-0123456789abcdef", "a row that already has a name keeps it");

        let once = book.clone();
        assert!(!migrate(&mut book), "a second pass has nothing to do");
        assert_eq!(book, once);
    }

    #[test]
    fn an_old_key_finds_its_row_by_alias_and_without_one() {
        let mut book = vec![row("ubuntu@10.0.0.1:/srv/app", "10.0.0.1")];
        migrate(&mut book);
        assert_eq!(locate(&book, "ubuntu@10.0.0.1:/srv/app"), Some(0));
        // An older build that rewrote the book dropped the field it doesn't
        // know about. The derivation still gets there.
        book[0].aliases.clear();
        assert_eq!(locate(&book, "ubuntu@10.0.0.1:/srv/app"), Some(0));
        assert_eq!(locate(&book, "ubuntu@10.0.0.9:/srv/app"), None);
    }

    #[test]
    fn a_rows_own_id_wins_over_another_rows_old_one() {
        let mut a = row("m-aaaaaaaaaaaaaaaa", "10.0.0.1");
        a.aliases.push("m-bbbbbbbbbbbbbbbb".into());
        let b = row("m-bbbbbbbbbbbbbbbb", "10.0.0.2");
        let book = vec![a, b];
        assert_eq!(locate(&book, "m-bbbbbbbbbbbbbbbb"), Some(1));
        assert_eq!(canonical(&book, "nothing"), "nothing");
    }

    #[test]
    fn a_new_row_never_takes_a_name_already_answered_to() {
        // The box that used to be at .1 moved to .2 and kept its name; a
        // different box turning up at .1 must not be filed under it.
        let moved = row(&from_address("ubuntu", "10.0.0.1", Some("/srv/app")), "10.0.0.2");
        let book = vec![moved.clone()];
        let (id, aliases) = claim(&book, None, "ubuntu", "10.0.0.1", Some("/srv/app"));
        assert_ne!(id, moved.id);
        assert!(is_stable(&id) && aliases.is_empty());
    }

    #[test]
    fn reconnecting_a_lost_machine_takes_back_the_id_it_had() {
        let (id, aliases) = claim(&[], Some("m-0123456789abcdef"), "ubuntu", "10.0.0.2", None);
        assert_eq!((id.as_str(), aliases.len()), ("m-0123456789abcdef", 0));

        let (id, aliases) = claim(&[], Some("ubuntu@10.0.0.1"), "ubuntu", "10.0.0.2", None);
        assert_eq!(id, from_address_key("ubuntu@10.0.0.1"));
        assert_eq!(aliases, vec!["ubuntu@10.0.0.1".to_string()]);
    }
}
