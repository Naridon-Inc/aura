//! A machine that moves, or comes back, is still the machine that every
//! workspace, chat and panel points at: what `machine_save` does with an id it
//! is handed, what it does with a folder it is not, and how a book written
//! before rows had ids of their own is renamed without losing anyone's link.

use super::*;

/// A folder left out and a folder cleared are two different requests, and
/// only the second one forgets where the project is.
#[test]
fn a_folder_left_out_is_not_a_folder_cleared() {
    let parse = |extra: &str| -> MachineInput {
        serde_json::from_str(&format!(
            r#"{{"name": "r", "host": "h", "user": "u", "key_path": "k", "box_kind": "mine"{extra}}}"#
        ))
        .expect("parse")
    };
    assert_eq!(parse("").repo_path, None);
    assert_eq!(parse(r#", "repo_path": null"#).repo_path, Some(None));
    assert_eq!(
        parse(r#", "repo_path": "/srv/app""#).repo_path,
        Some(Some("/srv/app".to_string()))
    );
}

/// The wizard's form, for the box at `host`, reconnecting `id` if given.
fn wizard(host: &str, id: Option<&str>) -> MachineInput {
    MachineInput {
        id: id.map(str::to_string),
        name: "aura-runner".into(),
        host: host.into(),
        user: "ubuntu".into(),
        key_path: "/keys/aura.pem".into(),
        box_kind: "mine".into(),
        // The real wizard never sends one: it has no idea where the
        // project lives on the box.
        repo_path: None,
        project_root: Some("/Users/me/app".into()),
    }
}

/// Where a chat about this machine would do its work — the same door a
/// saved session goes through when it runs a turn.
fn dialled_host(id: &str) -> String {
    match crate::manager::brain::place::Place::at_machine(id).expect("the place resolves") {
        crate::manager::brain::place::Place::Box { machine, .. } => machine.host,
        other => panic!("expected a box, got {other:?}"),
    }
}

/// The bug this field exists for. A box came back on a new address and the
/// wizard was pointed at it; the row used to be re-keyed by the new address,
/// and every workspace, chat and panel still holding the old key found its
/// machine gone. Now the move is an edit to the row they all point at.
#[tokio::test]
async fn a_machine_reconnected_at_a_new_host_keeps_what_points_at_it() {
    let _home = crate::test_home::borrow();
    let first = machine_save(MachineInput {
        repo_path: Some(Some("/srv/app".into())),
        ..wizard("10.0.0.1", None)
    })
    .await
    .expect("save");
    assert!(ids::is_stable(&first.id), "{}", first.id);
    assert!(!first.id.contains("10.0.0.1"), "the id carries no address");
    // What a workspace, its tab strip and its chat are holding.
    let held = first.id.clone();
    machine_set_branch(held.clone(), Some("main".into())).await.expect("branch");

    let moved = machine_save(wizard("10.0.0.2", Some(&held))).await.expect("re-point");
    assert_eq!(moved.id, held, "a move does not rename the machine");
    assert_eq!(moved.host, "10.0.0.2");
    assert_eq!(moved.added_at, first.added_at);
    assert_eq!(moved.repo_branch.as_deref(), Some("main"), "nothing else is forgotten");
    assert_eq!(
        moved.repo_path.as_deref(),
        Some("/srv/app"),
        "the wizard doesn't know the folder, and doesn't forget it either"
    );
    assert_eq!(every_machine().len(), 1, "a move is an edit, not a second machine");
    assert_eq!(find_machine(&held).map(|m| m.host).as_deref(), Some("10.0.0.2"));
    assert_eq!(dialled_host(&held), "10.0.0.2", "a chat on it dials where it is now");

    // The directory editor, which does know, can still say there is none.
    let cleared = machine_save(MachineInput {
        repo_path: Some(None),
        ..wizard("10.0.0.2", Some(&held))
    })
    .await
    .expect("clear the folder");
    assert_eq!((cleared.id.as_str(), cleared.repo_path), (held.as_str(), None));
}

/// The other half of "reconnect": the book had lost the machine, and the
/// workspace still names it — by an address key from before rows had names,
/// or by a name. Connecting it again from that workspace has to land on the
/// id the workspace holds, or it is connected and still reads as missing.
#[tokio::test]
async fn reconnecting_a_lost_machine_answers_to_the_id_it_was_lost_under() {
    let _home = crate::test_home::borrow();
    let old_key = "ubuntu@10.0.0.1:/srv/app";
    let back = machine_save(wizard("10.0.0.2", Some(old_key))).await.expect("save");
    assert!(ids::is_stable(&back.id));
    assert_eq!(find_machine(old_key).map(|m| m.id), Some(back.id.clone()));
    assert_eq!(dialled_host(old_key), "10.0.0.2");

    let name = "m-0123456789abcdef";
    let again = machine_save(MachineInput {
        repo_path: Some(Some("/srv/other".into())),
        ..wizard("10.0.0.3", Some(name))
    })
    .await
    .expect("save");
    assert_eq!(again.id, name, "a lost name is taken back as it was");
}

/// Somebody who hit the bug before this fix has a second row at the new
/// address already. Reconnecting the lost machine there must not lay a
/// third — the row at that address IS the machine, and takes its old id.
#[tokio::test]
async fn reconnecting_onto_a_row_already_at_that_address_adopts_the_lost_id() {
    let _home = crate::test_home::borrow();
    let there = machine_save(wizard("10.0.0.2", None)).await.expect("save");
    let lost = "m-0123456789abcdef";
    let back = machine_save(wizard("10.0.0.2", Some(lost))).await.expect("save");
    assert_eq!(back.id, there.id);
    assert_eq!(every_machine().len(), 1);
    assert_eq!(find_machine(lost).map(|m| m.id), Some(there.id));
}

/// Re-running the wizard against a box you already have, from scratch,
/// still updates the row rather than duplicating it.
#[tokio::test]
async fn the_same_address_from_scratch_is_the_same_row() {
    let _home = crate::test_home::borrow();
    let a = machine_save(wizard("10.0.0.1", None)).await.expect("save");
    let b = machine_save(wizard("10.0.0.1", None)).await.expect("save");
    assert_eq!(a.id, b.id);
    assert_eq!(every_machine().len(), 1);
}

/// A book written before rows had names of their own: every row is renamed
/// once, the file is rewritten to say so, and every id handed out before —
/// to a saved chat, a tab strip, a background session — still finds its row,
/// for reading and for writing.
#[tokio::test]
async fn an_old_book_is_renamed_once_and_its_old_ids_still_resolve() {
    let home = crate::test_home::borrow();
    let dir = home.path().join(".aura");
    std::fs::create_dir_all(&dir).expect("dir");
    let file = dir.join("machines.json");
    std::fs::write(
        &file,
        r#"[{
            "id": "ubuntu@10.0.0.1:/home/ubuntu/aura-src",
            "name": "aura-runner",
            "host": "10.0.0.1",
            "user": "ubuntu",
            "key_path": "/keys/aura.pem",
            "box_kind": "mine",
            "repo_path": "/home/ubuntu/aura-src",
            "added_at": 1,
            "last_used_at": 2
        }, {
            "id": "ubuntu@10.0.0.5",
            "name": "spare",
            "host": "10.0.0.5",
            "user": "ubuntu",
            "key_path": "/keys/aura.pem",
            "box_kind": "mine",
            "repo_path": null,
            "added_at": 1,
            "last_used_at": 1
        }]"#,
    )
    .expect("write the old book");
    let old = "ubuntu@10.0.0.1:/home/ubuntu/aura-src";

    let book = every_machine();
    assert_eq!(book.len(), 2, "nothing is lost on the way");
    assert!(book.iter().all(|m| ids::is_stable(&m.id)), "{book:?}");
    assert_eq!(book[0].aliases, vec![old.to_string()]);
    assert_eq!(book[1].aliases, vec!["ubuntu@10.0.0.5".to_string()]);
    let on_disk = std::fs::read_to_string(&file).expect("read back");
    assert!(on_disk.contains(&book[0].id), "the rename is written down");
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let mode = std::fs::metadata(&file).expect("stat").permissions().mode() & 0o777;
        assert_eq!(mode, 0o600, "rewriting the book does not open it up");
    }
    assert_eq!(every_machine(), book, "a second read renames nothing");

    // Read by the old id…
    assert_eq!(find_machine(old).map(|m| m.id), Some(book[0].id.clone()));
    assert_eq!(dialled_host(old), "10.0.0.1");
    // …written by it…
    assert!(set_asleep_since(old, 42).expect("write"));
    assert_eq!(find_machine(&book[0].id).map(|m| m.asleep_since), Some(42));
    // …and a reconnect by it moves the renamed row rather than adding one.
    let moved = machine_save(wizard("10.0.0.9", Some(old))).await.expect("re-point");
    assert_eq!(moved.id, book[0].id);
    assert_eq!(moved.repo_path.as_deref(), Some("/home/ubuntu/aura-src"));
    assert_eq!(every_machine().len(), 2);
    // Forgetting by it lets the row go.
    machine_forget(old.to_string()).await.expect("forget");
    assert!(find_machine(old).is_none());
    assert_eq!(every_machine().len(), 1);
}

/// A machine Aura made, written down again — a retry — keeps its row. A
/// different machine landing on an address a moved row was named after gets
/// a row of its own, and the moved one keeps its handle.
#[test]
fn a_made_machine_never_takes_over_a_row_that_is_not_it() {
    let _home = crate::test_home::borrow();
    let first = record_made_machine("crew", "10.0.0.7", "ubuntu", "managed:a", None, "i-aaa")
        .expect("record");
    let again = record_made_machine("crew", "10.0.0.7", "ubuntu", "managed:a", None, "i-aaa")
        .expect("record");
    assert_eq!(first.id, again.id);
    assert_eq!(every_machine().len(), 1);

    set_host(&first.id, "10.0.0.8").expect("moved");
    let other = record_made_machine("crew-2", "10.0.0.7", "ubuntu", "managed:b", None, "i-bbb")
        .expect("record");
    assert_ne!(other.id, first.id);
    let kept = find_machine(&first.id).expect("still there");
    assert_eq!(kept.instance_id.as_deref(), Some("i-aaa"));
}
