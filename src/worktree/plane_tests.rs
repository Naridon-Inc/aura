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
use crate::sentinel::{claim_label, SentinelManager, ZoneMode, WHOLE_FILE};

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

/// A file the parser can't name symbols in — a stylesheet, a config, a language
/// we don't read — is claimed whole. That marker used to carry the absolute
/// path inside the symbol name, which quietly reintroduced the bug the test
/// above fixed: one file looked like a different symbol from every checkout, so
/// two agents editing it never heard about each other.
#[test]
fn a_whole_file_claim_collides_across_checkouts_too() {
    let _lock = crate::TEST_CWD_LOCK.lock().unwrap_or_else(|e| e.into_inner());
    let _cwd = CwdGuard::enter();
    let repo = fake_repo(&["barcelona", "granada"]);

    repo.enter("barcelona");
    let abs = repo.worktree("barcelona").join("src/theme.css");
    claim("s-bcn", "claude", &abs.to_string_lossy(), WHOLE_FILE);

    repo.enter("granada");
    let abs_here = repo.worktree("granada").join("src/theme.css");
    let hit = claim("s-gra", "gemini", &abs_here.to_string_lossy(), WHOLE_FILE);

    assert_eq!(hit.len(), 1, "the whole-file claim must be visible too");
    assert_eq!(hit[0].held_by_worktree.as_deref(), Some("barcelona"));
}

/// What a person is shown for a claim. The marker is ours; the file name is
/// theirs.
#[test]
fn a_whole_file_claim_reads_as_the_file_not_as_a_marker() {
    assert_eq!(
        claim_label(WHOLE_FILE, "aura-shell/src/styles.css"),
        "styles.css (whole file)"
    );
    // Claims written before the marker was path-free still say something.
    assert_eq!(
        claim_label("__file__/Users/someone/checkout/styles.css", ""),
        "styles.css (whole file)"
    );
    // An ordinary symbol is left exactly as it is.
    assert_eq!(claim_label("zone_is_live", "src/sentinel.rs"), "zone_is_live");
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

/// Backdate a zone on disk, the way a zone claimed months ago looks today.
fn age_zone(zone_id: &str, secs: u64) {
    let path = format!(
        "{}/{}.json",
        paths::shared_aura_path("sentinel/zones"),
        zone_id
    );
    let body = std::fs::read_to_string(&path).expect("zone file");
    let mut zone: serde_json::Value = serde_json::from_str(&body).expect("zone json");
    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap()
        .as_secs();
    zone["claimed_at"] = serde_json::json!(now.saturating_sub(secs));
    std::fs::write(&path, serde_json::to_string_pretty(&zone).unwrap()).expect("write zone");
}

/// The bug this closes: a zone claimed in May was still warning in August, from
/// a session that no longer existed, on every snapshot of a quarter of the
/// repo. A warning that never clears is one people learn to ignore.
#[test]
fn a_zone_outlives_neither_its_session_nor_the_day_it_was_claimed() {
    let _lock = crate::TEST_CWD_LOCK.lock().unwrap_or_else(|e| e.into_inner());
    let _cwd = CwdGuard::enter();
    let repo = fake_repo(&["barcelona", "granada"]);

    repo.enter("barcelona");
    let zone = SentinelManager::create_zone("s-may", vec!["aura-cli/".to_string()], ZoneMode::Warn);

    // Fresh, and its owner never claimed a function — the ordinary case a
    // moment after `aura team zones claim`. It must bind.
    repo.enter("granada");
    assert!(
        SentinelManager::check_zone("s-gra", "aura-cli/src/main.rs").is_some(),
        "a zone claimed seconds ago must be enforced even with no claim file"
    );

    // Three months later, same session, still no claim file anywhere.
    age_zone(&zone.zone_id, 90 * 24 * 3600);
    assert!(
        SentinelManager::check_zone("s-gra", "aura-cli/src/main.rs").is_none(),
        "a zone whose session left months ago must stop binding"
    );
}

/// A live session keeps its zone regardless of age — the age rule is only for
/// owners that are not on record at all.
#[test]
fn a_zone_belonging_to_a_working_session_is_kept_however_old_it_is() {
    let _lock = crate::TEST_CWD_LOCK.lock().unwrap_or_else(|e| e.into_inner());
    let _cwd = CwdGuard::enter();
    let repo = fake_repo(&["barcelona", "granada"]);

    repo.enter("barcelona");
    let zone = SentinelManager::create_zone("s-bcn", vec!["aura-cli/".to_string()], ZoneMode::Block);
    // Same session is demonstrably working: a claim under our own live pid.
    claim("s-bcn", "claude", "aura-cli/src/main.rs", "main");
    age_zone(&zone.zone_id, 90 * 24 * 3600);

    repo.enter("granada");
    assert!(
        SentinelManager::check_zone("s-gra", "aura-cli/src/main.rs").is_some(),
        "an old zone whose owner is still working must keep binding"
    );
}

/// Listing has to show the expired one *and* say it expired. Someone asking
/// "why was I warned about this yesterday and not today" needs an answer, not
/// a row that quietly vanished.
#[test]
fn listing_shows_an_expired_zone_and_pruning_removes_it() {
    let _lock = crate::TEST_CWD_LOCK.lock().unwrap_or_else(|e| e.into_inner());
    let _cwd = CwdGuard::enter();
    let repo = fake_repo(&["barcelona"]);

    repo.enter("barcelona");
    let dead = SentinelManager::create_zone("s-old", vec!["aura-cli/".to_string()], ZoneMode::Warn);
    let live = SentinelManager::create_zone("s-new", vec!["aura-web/".to_string()], ZoneMode::Warn);
    age_zone(&dead.zone_id, 90 * 24 * 3600);

    let views = SentinelManager::list_zone_views();
    assert_eq!(views.len(), 2, "both zones are listed");
    let dead_view = views.iter().find(|v| v.zone.zone_id == dead.zone_id).unwrap();
    let live_view = views.iter().find(|v| v.zone.zone_id == live.zone_id).unwrap();
    assert!(!dead_view.live, "the old zone is shown as no longer in force");
    assert!(live_view.live, "the fresh zone is shown as in force");
    assert!(dead_view.age_secs > 80 * 24 * 3600, "and it says how old it is");

    assert_eq!(SentinelManager::prune_dead_zones(), 1);
    let after = SentinelManager::list_zone_views();
    assert_eq!(after.len(), 1);
    assert_eq!(after[0].zone.zone_id, live.zone_id);
}

/// Releasing by id is the escape hatch, and it has to report honestly when
/// there is nothing to release — the old command reported success either way.
#[test]
fn releasing_a_zone_says_whether_anything_was_released() {
    let _lock = crate::TEST_CWD_LOCK.lock().unwrap_or_else(|e| e.into_inner());
    let _cwd = CwdGuard::enter();
    let repo = fake_repo(&["barcelona"]);

    repo.enter("barcelona");
    let zone = SentinelManager::create_zone("s-bcn", vec!["aura-cli/".to_string()], ZoneMode::Warn);
    assert!(SentinelManager::release_zone(&zone.zone_id));
    assert!(SentinelManager::list_zones().is_empty());
    assert!(!SentinelManager::release_zone(&zone.zone_id), "a second release is not a success");
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
