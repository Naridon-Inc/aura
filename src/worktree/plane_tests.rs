//! End-to-end tests for the two planes, driven the way real agents drive them:
//! `chdir` into one checkout, do a thing, `chdir` into another, and check what
//! the second one can see.
//!
//! Every test in here would have *failed* before the split — a claim, a zone
//! and a message were all invisible one directory over — so they are the
//! regression net for the whole feature, not just for a function.
//!
//! Two rules for anything added here. Hold [`crate::TEST_CWD_LOCK`] and a
//! [`CwdGuard`]: the working directory is process-global, and cargo runs tests
//! in threads. And claim with [`std::process::id`]: `cleanup_stale` drops any
//! claim whose pid is gone, so a made-up pid would delete itself mid-test.

use super::testing::{fake_repo, CwdGuard};
use super::paths;
use crate::awareness::emit::EmitInput;
use crate::awareness::{emit, store, AwarenessKind};
use crate::sentinel::{SentinelManager, ZoneMode};

/// Our own pid, so the claim survives `cleanup_stale`.
fn live_pid() -> u32 {
    std::process::id()
}

fn claim(session: &str, agent: &str, file: &str, func: &str) -> Vec<crate::sentinel::Collision> {
    SentinelManager::claim_functions(session, agent, live_pid(), file, &[func.to_string()])
}

/// The headline case. Claude takes `login` in `barcelona`; Gemini reaches for
/// the same symbol in `granada` and is told who already has it, in which
/// checkout.
#[test]
fn a_claim_in_one_checkout_is_seen_from_another() {
    let _lock = crate::TEST_CWD_LOCK.lock().unwrap_or_else(|e| e.into_inner());
    let _cwd = CwdGuard::enter();
    let repo = fake_repo(&["barcelona", "granada"]);

    repo.enter("barcelona");
    let none = claim("s-bcn", "claude", "src/auth.rs", "login");
    assert!(none.is_empty(), "first claimant collides with nobody");

    repo.enter("granada");
    let hit = claim("s-gra", "gemini", "src/auth.rs", "login");
    assert_eq!(hit.len(), 1, "the other checkout's claim must be visible");
    assert_eq!(hit[0].held_by_agent, "claude");
    assert_eq!(hit[0].held_by_worktree.as_deref(), Some("barcelona"));

    // And the status view names the checkout rather than saying "someone".
    let status = SentinelManager::get_status("s-gra");
    let collisions = status["collisions"].as_array().cloned().unwrap_or_default();
    assert_eq!(collisions.len(), 1);
    assert_eq!(collisions[0]["held_by_worktree"], "barcelona");
    assert_eq!(collisions[0]["cross_worktree"], true);
}

/// The same file reached by two different absolute paths — one per checkout —
/// is one file. Keying claims on the absolute path is what made cross-worktree
/// collisions undetectable even after the state was shared.
#[test]
fn absolute_paths_from_different_checkouts_key_to_the_same_file() {
    let _lock = crate::TEST_CWD_LOCK.lock().unwrap_or_else(|e| e.into_inner());
    let _cwd = CwdGuard::enter();
    let repo = fake_repo(&["barcelona", "granada"]);

    repo.enter("barcelona");
    let abs = repo.worktree("barcelona").join("src/auth.rs");
    claim("s-bcn", "claude", &abs.to_string_lossy(), "login");

    repo.enter("granada");
    // Same file, spelled as this checkout's absolute path.
    let abs_here = repo.worktree("granada").join("src/auth.rs");
    let hit = claim("s-gra", "gemini", &abs_here.to_string_lossy(), "login");
    assert_eq!(hit.len(), 1, "two spellings of one repo file must collide");
    assert_eq!(
        hit[0].file_path, "src/auth.rs",
        "claims are stored repo-relative"
    );
}

/// Contention within one checkout is still contention — the split must not
/// have traded the old bug for a new blind spot.
#[test]
fn two_agents_in_the_same_checkout_still_collide() {
    let _lock = crate::TEST_CWD_LOCK.lock().unwrap_or_else(|e| e.into_inner());
    let _cwd = CwdGuard::enter();
    let repo = fake_repo(&["barcelona"]);

    repo.enter("barcelona");
    claim("s-one", "claude", "src/auth.rs", "login");
    let hit = claim("s-two", "codex", "src/auth.rs", "login");
    assert_eq!(hit.len(), 1);
    assert_eq!(hit[0].held_by_worktree.as_deref(), Some("barcelona"));
}

/// Addressing a checkout instead of a session id: you rarely know a peer's
/// session, but you always know which tree they are in.
#[test]
fn a_message_addressed_to_a_checkout_reaches_only_that_checkout() {
    let _lock = crate::TEST_CWD_LOCK.lock().unwrap_or_else(|e| e.into_inner());
    let _cwd = CwdGuard::enter();
    let repo = fake_repo(&["barcelona", "granada", "kyoto"]);

    // Each agent claims something so the plane knows where it lives.
    repo.enter("barcelona");
    claim("s-bcn", "claude", "src/auth.rs", "login");
    repo.enter("kyoto");
    claim("s-kyo", "codex", "src/ui.rs", "render");
    repo.enter("granada");
    claim("s-gra", "gemini", "src/db.rs", "migrate");

    SentinelManager::send_message_to(
        "s-gra",
        "gemini",
        None,
        Some("barcelona"),
        "rebasing onto trunk — hold off on auth.rs",
    );

    assert_eq!(SentinelManager::unread_count("s-bcn"), 1, "the addressee");
    assert_eq!(SentinelManager::unread_count("s-kyo"), 0, "a bystander");
    assert_eq!(SentinelManager::unread_count("s-gra"), 0, "the sender");

    // The receiver learns where it came from without a lookup.
    let inbox = SentinelManager::get_unread_messages("s-bcn");
    assert_eq!(inbox[0].from_worktree.as_deref(), Some("granada"));
    assert_eq!(inbox[0].to_worktree.as_deref(), Some("barcelona"));
}

/// The main checkout is addressable too — it just answers to `main`, since it
/// has no worktree name of its own.
#[test]
fn the_main_checkout_answers_to_main() {
    let _lock = crate::TEST_CWD_LOCK.lock().unwrap_or_else(|e| e.into_inner());
    let _cwd = CwdGuard::enter();
    let repo = fake_repo(&["barcelona"]);

    repo.enter_main();
    claim("s-main", "claude", "src/lib.rs", "boot");
    assert_eq!(SentinelManager::worktree_of_session("s-main"), None);

    repo.enter("barcelona");
    claim("s-bcn", "gemini", "src/auth.rs", "login");
    SentinelManager::send_message_to("s-bcn", "gemini", None, Some("main"), "trunk is green");

    // Read from `barcelona` — the reader's own checkout must not be mistaken
    // for the recipient's.
    assert_eq!(SentinelManager::unread_count("s-main"), 1);
    assert_eq!(SentinelManager::unread_count("s-bcn"), 0);

    repo.enter_main();
    assert_eq!(SentinelManager::unread_count("s-main"), 1);
}

/// A broadcast still reaches every checkout.
#[test]
fn a_broadcast_reaches_every_checkout() {
    let _lock = crate::TEST_CWD_LOCK.lock().unwrap_or_else(|e| e.into_inner());
    let _cwd = CwdGuard::enter();
    let repo = fake_repo(&["barcelona", "granada"]);

    repo.enter("barcelona");
    claim("s-bcn", "claude", "src/auth.rs", "login");
    repo.enter("granada");
    claim("s-gra", "gemini", "src/db.rs", "migrate");

    SentinelManager::send_message_to("s-gra", "gemini", None, None, "pulling trunk in 5");
    assert_eq!(SentinelManager::unread_count("s-bcn"), 1);
    assert_eq!(SentinelManager::unread_count("s-gra"), 0, "not to yourself");
}

/// `sessions_in_worktree` is how "tell whoever is in barcelona" resolves to
/// real recipients — including the count the CLI reports back.
#[test]
fn sessions_resolve_by_checkout_name() {
    let _lock = crate::TEST_CWD_LOCK.lock().unwrap_or_else(|e| e.into_inner());
    let _cwd = CwdGuard::enter();
    let repo = fake_repo(&["barcelona", "granada"]);

    repo.enter("barcelona");
    claim("s-one", "claude", "src/a.rs", "f");
    claim("s-two", "codex", "src/b.rs", "g");
    repo.enter("granada");
    claim("s-three", "gemini", "src/c.rs", "h");
    repo.enter_main();
    claim("s-main", "claude", "src/d.rs", "i");

    assert_eq!(SentinelManager::sessions_in_worktree("barcelona").len(), 2);
    assert_eq!(SentinelManager::sessions_in_worktree("granada").len(), 1);
    assert_eq!(SentinelManager::sessions_in_worktree("main").len(), 1);
    assert_eq!(SentinelManager::sessions_in_worktree("nowhere").len(), 0);
}

/// A zone declared in one checkout protects the repo, not just the tree that
/// declared it. Before the split it protected nothing.
#[test]
fn a_zone_declared_in_one_checkout_is_enforced_in_another() {
    let _lock = crate::TEST_CWD_LOCK.lock().unwrap_or_else(|e| e.into_inner());
    let _cwd = CwdGuard::enter();
    let repo = fake_repo(&["barcelona", "granada"]);

    repo.enter("barcelona");
    SentinelManager::create_zone("s-bcn", vec!["aura-cli/".to_string()], ZoneMode::Block);

    repo.enter("granada");
    let blocked = SentinelManager::check_zone("s-gra", "aura-cli/src/main.rs")
        .expect("a zone from another checkout must be enforced here");
    assert_eq!(blocked.session_id, "s-bcn");
    assert_eq!(blocked.worktree.as_deref(), Some("barcelona"));
    assert_eq!(blocked.mode, ZoneMode::Block);

    // Outside the pattern, nothing is blocked.
    assert!(SentinelManager::check_zone("s-gra", "aura-web/src/App.tsx").is_none());

    // And an absolute path from this checkout resolves into the zone too.
    let abs = repo.worktree("granada").join("aura-cli/src/main.rs");
    assert!(SentinelManager::check_zone("s-gra", &abs.to_string_lossy()).is_some());

    // Your own zone never blocks you, wherever you read it from.
    repo.enter("barcelona");
    assert!(SentinelManager::check_zone("s-bcn", "aura-cli/src/main.rs").is_none());
}

/// Awareness events are the "what is everyone doing right now" feed. They are
/// shared, and each one carries the checkout it was emitted from.
#[test]
fn awareness_events_are_shared_and_stamped_with_their_checkout() {
    let _lock = crate::TEST_CWD_LOCK.lock().unwrap_or_else(|e| e.into_inner());
    let _cwd = CwdGuard::enter();
    let repo = fake_repo(&["barcelona", "granada"]);

    repo.enter("barcelona");
    let ev = emit::emit(EmitInput {
        kind: AwarenessKind::Editing,
        file: Some("src/auth.rs".into()),
        symbol: Some("login".into()),
        intent: None,
        impact: None,
        agent: Some("claude@barcelona".into()),
    });
    assert_eq!(ev.worktree.as_deref(), Some("barcelona"));

    repo.enter("granada");
    let seen = store::read_all();
    let mine = seen
        .iter()
        .find(|e| e.actor == "claude@barcelona")
        .expect("an event emitted next door must be readable here");
    assert_eq!(mine.worktree.as_deref(), Some("barcelona"));
    assert_eq!(mine.symbol.as_deref(), Some("login"));

    // Emitting from here lands in the same feed, stamped differently.
    emit::emit(EmitInput {
        kind: AwarenessKind::Editing,
        file: Some("src/db.rs".into()),
        symbol: Some("migrate".into()),
        intent: None,
        impact: None,
        agent: Some("gemini@granada".into()),
    });
    let both = store::read_all();
    assert_eq!(both.len(), 2, "one shared log, not one per checkout");
    let trees: Vec<Option<&str>> = both.iter().map(|e| e.worktree.as_deref()).collect();
    assert!(trees.contains(&Some("barcelona")) && trees.contains(&Some("granada")));
}

/// The other half of the split: private state must stay private. Two agents
/// working side by side cannot be sharing a session file.
#[test]
fn sessions_stay_private_to_their_checkout() {
    let _lock = crate::TEST_CWD_LOCK.lock().unwrap_or_else(|e| e.into_inner());
    let _cwd = CwdGuard::enter();
    let repo = fake_repo(&["barcelona", "granada"]);

    repo.enter("barcelona");
    let bcn_sessions = crate::session::worktree_aura_path("sessions");
    std::fs::create_dir_all(&bcn_sessions).expect("mkdir sessions");
    std::fs::write(format!("{bcn_sessions}/active.json"), "{}").expect("write session");

    repo.enter("granada");
    let gra_sessions = crate::session::worktree_aura_path("sessions");
    assert_ne!(bcn_sessions, gra_sessions, "the private plane is per checkout");
    assert!(
        !std::path::Path::new(&format!("{gra_sessions}/active.json")).exists(),
        "one checkout's session must not appear in another's"
    );

    // Both private planes nest under the one shared `.aura`, so a single
    // directory still holds everything about the repository.
    let shared = paths::shared_aura_path("");
    assert!(bcn_sessions.starts_with(&shared));
    assert!(gra_sessions.starts_with(&shared));
}

/// The control plane joins it all up: checkouts, who is in them, and what two
/// of them are both holding.
#[test]
fn the_assembled_plane_reports_cross_checkout_contention() {
    let _lock = crate::TEST_CWD_LOCK.lock().unwrap_or_else(|e| e.into_inner());
    let _cwd = CwdGuard::enter();
    let repo = fake_repo(&["barcelona", "granada"]);

    repo.enter("barcelona");
    claim("s-bcn", "claude", "src/auth.rs", "login");
    repo.enter("granada");
    claim("s-gra", "gemini", "src/auth.rs", "login");

    // `git worktree list` needs a real repository, so the roster comes back
    // empty here; the claims still have to be accounted for rather than
    // dropped, which is what `stranded` is for.
    let plane = super::overview::assemble(false);
    assert_eq!(plane.total_agents(), 2, "no claim may go unreported");
    assert_eq!(plane.contention.len(), 1);
    assert!(plane.contention[0].cross_worktree);
    assert_eq!(plane.contention[0].function, "login");
    assert_eq!(plane.contention[0].file, "src/auth.rs");
    let mut who: Vec<&str> = plane.contention[0]
        .holders
        .iter()
        .map(|h| h.worktree.as_str())
        .collect();
    who.sort();
    assert_eq!(who, vec!["barcelona", "granada"]);
}

/// A claim record that arrived carrying a symbol twice is repaired the next
/// time that session claims anything, so it stops looking like two agents.
#[test]
fn a_duplicated_claim_row_is_healed_on_the_next_write() {
    let _lock = crate::TEST_CWD_LOCK.lock().unwrap_or_else(|e| e.into_inner());
    let _cwd = CwdGuard::enter();
    let repo = fake_repo(&["barcelona"]);

    repo.enter("barcelona");
    claim("s-bcn", "claude", "src/auth.rs", "login");

    // Forge the state an older build could leave behind: the same symbol
    // twice in one record.
    let path = format!(
        "{}/s-bcn.json",
        paths::shared_aura_path("sentinel/claims")
    );
    let mut rec: serde_json::Value =
        serde_json::from_str(&std::fs::read_to_string(&path).expect("read claims")).expect("parse");
    let rows = rec["claims"].as_array().expect("claims array").clone();
    rec["claims"] = serde_json::Value::Array(vec![rows[0].clone(), rows[0].clone()]);
    std::fs::write(&path, rec.to_string()).expect("write claims");

    // Any further claim rewrites the record, dropping the duplicate.
    claim("s-bcn", "claude", "src/db.rs", "migrate");
    let healed = SentinelManager::load_all_claims();
    let mine = healed.iter().find(|c| c.session_id == "s-bcn").expect("record");
    let logins = mine
        .claims
        .iter()
        .filter(|c| c.function_name == "login")
        .count();
    assert_eq!(logins, 1, "the duplicate row must not survive a write");

    // ...and the plane no longer reports the session against itself.
    assert!(super::overview::assemble(false).contention.is_empty());
}

/// Releasing gives the symbol back — across checkouts, same as taking it.
#[test]
fn releasing_a_claim_clears_it_for_the_other_checkout_too() {
    let _lock = crate::TEST_CWD_LOCK.lock().unwrap_or_else(|e| e.into_inner());
    let _cwd = CwdGuard::enter();
    let repo = fake_repo(&["barcelona", "granada"]);

    repo.enter("barcelona");
    claim("s-bcn", "claude", "src/auth.rs", "login");

    repo.enter("granada");
    assert_eq!(claim("s-gra", "gemini", "src/auth.rs", "login").len(), 1);

    repo.enter("barcelona");
    SentinelManager::release_file_claims("s-bcn", "src/auth.rs");

    repo.enter("granada");
    SentinelManager::release_claims("s-gra");
    assert!(
        claim("s-gra", "gemini", "src/auth.rs", "login").is_empty(),
        "released next door means free here"
    );
}
