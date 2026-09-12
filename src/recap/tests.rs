//! What a recap must never get wrong.
//!
//! The assembly is exercised through fixtures rather than a repository,
//! because the questions worth pinning — whose row a commit lands in, what
//! counts as coming back, what "under you" means — are decisions, not git.

use std::collections::BTreeMap;

use super::*;
use crate::dispatch::symbols::Delta;
use crate::dispatch::{Change, RepoReport};
use crate::intent_query::IntentRow;

fn row(at: u64, agent: &str) -> IntentRow {
    IntentRow {
        timestamp: at,
        agent_id: agent.into(),
        intent: "tighten the parser".into(),
        intent_type: None,
        signed_block_id: None,
        key_id: None,
        source: None,
        file: None,
        session_id: None,
        stated_at: None,
        change: None,
        tool: None,
    }
}

/// A commit with the ask behind it recorded, which is what a time-to-land
/// span is measured from.
fn asked(mut c: Change, at: u64) -> Change {
    c.prompt = Some(crate::history::Prompt { at, text: "make the parser strict".into() });
    c
}

fn change(who: &str, email: &str, at: u64, files: &[&str], intent: Option<IntentRow>) -> Change {
    Change {
        sha: "a".repeat(40),
        short: "aaaaaaa".into(),
        author: who.into(),
        email: email.into(),
        at,
        subject: "tighten the parser".into(),
        delta: Delta {
            files: files.iter().map(|f| f.to_string()).collect(),
            changed: vec!["parse".into()],
            ..Default::default()
        },
        intent,
        intent_basis: None,
        prompt: None,
        prompt_basis: None,
        goals: Vec::new(),
    }
}

fn report(changes: Vec<Change>) -> RepoReport {
    RepoReport {
        name: "app".into(),
        root: std::path::PathBuf::from("/tmp/app"),
        branch: "main".into(),
        since: 0,
        until: 10_000,
        changes,
        omitted: 0,
        people: BTreeMap::new(),
        agents: BTreeMap::new(),
        problem: None,
    }
}

fn me() -> Person {
    Person { name: "Ash".into(), email: "ash@example.com".into() }
}

fn build(reports: &[RepoReport], dirty: &[&str], agent: Option<&str>) -> Recap {
    let mut d = BTreeMap::new();
    d.insert("app".to_string(), dirty.iter().map(|f| f.to_string()).collect::<Vec<_>>());
    assemble(
        reports,
        &d,
        Reviews::default(),
        Window::Week,
        0,
        10_000,
        View::Both,
        agent,
        Some(me()),
    )
}

// ── The window ─────────────────────────────────────────────────────────────

#[test]
fn no_window_flag_means_the_week() {
    assert_eq!(Window::from_flags(false, false, false, false), Ok(Window::Week));
}

#[test]
fn each_flag_picks_its_own_window() {
    assert_eq!(Window::from_flags(true, false, false, false), Ok(Window::Day));
    assert_eq!(Window::from_flags(false, false, false, true), Ok(Window::Ninety));
    assert_eq!(Window::Ninety.seconds(), 90 * 86_400);
}

#[test]
fn two_windows_is_refused_with_both_named() {
    // Silently taking the first would give a recap of a window nobody asked
    // for, and every number in it would be wrong without saying so.
    let err = Window::from_flags(true, true, false, false).unwrap_err();
    assert!(err.contains("day") && err.contains("week"), "{err}");
}

// ── The view ───────────────────────────────────────────────────────────────

#[test]
fn the_view_reads_the_three_names_and_the_obvious_synonyms() {
    assert_eq!(View::parse("you"), Ok(View::You));
    assert_eq!(View::parse("ME"), Ok(View::You));
    assert_eq!(View::parse(" team "), Ok(View::Team));
    assert_eq!(View::parse("both"), Ok(View::Both));
}

#[test]
fn an_unknown_view_says_what_the_three_are() {
    let err = View::parse("everyone").unwrap_err();
    assert!(err.contains("you") && err.contains("team") && err.contains("both"), "{err}");
}

// ── Whose row a commit lands in ────────────────────────────────────────────

#[test]
fn a_person_is_their_email_not_their_name() {
    // The same person spells their name three ways across two laptops and a
    // CI box; merging those into one row is the point of a team table.
    let r = build(
        &[report(vec![
            change("Ash", "ash@example.com", 100, &["a.rs"], None),
            change("ashiq", "ASH@example.com", 200, &["b.rs"], None),
        ])],
        &[],
        None,
    );
    assert_eq!(r.team.len(), 1, "one person, two spellings");
    assert_eq!(r.team[0].commits, 2);
}

#[test]
fn you_are_in_the_team_table_as_well_as_your_own_section() {
    // `both` is two lenses on one window, not a union of two halves — seeing
    // yourself beside the others is the comparison being asked for.
    let r = build(
        &[report(vec![
            change("Ash", "ash@example.com", 100, &["a.rs"], None),
            change("Dana", "dana@example.com", 200, &["b.rs"], None),
        ])],
        &[],
        None,
    );
    assert_eq!(r.you.as_ref().map(|y| y.commits), Some(1));
    assert_eq!(r.team.len(), 2);
    assert!(r.team.iter().any(|p| p.email == "ash@example.com"));
}

#[test]
fn the_team_is_ordered_by_who_landed_most() {
    let r = build(
        &[report(vec![
            change("Ash", "ash@example.com", 100, &["a.rs"], None),
            change("Dana", "dana@example.com", 200, &["b.rs"], None),
            change("Dana", "dana@example.com", 300, &["c.rs"], None),
        ])],
        &[],
        None,
    );
    assert_eq!(r.team[0].name, "Dana");
}

// ── Cadence, through the assembly ──────────────────────────────────────────

#[test]
fn coming_back_is_counted_per_person_not_per_repo() {
    // Two people touching the same file once each is not rework; it is two
    // people. Only returning to your own work is.
    let r = build(
        &[report(vec![
            change("Ash", "ash@example.com", 100, &["a.rs"], None),
            change("Dana", "dana@example.com", 200, &["a.rs"], None),
        ])],
        &[],
        None,
    );
    for p in &r.team {
        assert_eq!(p.rework.returned, 0, "{} came back to nothing", p.name);
    }
}

#[test]
fn the_same_file_in_two_repos_is_two_files() {
    let mut other = report(vec![change("Ash", "ash@example.com", 200, &["a.rs"], None)]);
    other.name = "lib".into();
    let r = build(
        &[report(vec![change("Ash", "ash@example.com", 100, &["a.rs"], None)]), other],
        &[],
        None,
    );
    let you = r.you.unwrap();
    assert_eq!(you.files, 2, "`app/a.rs` and `lib/a.rs` are not one file");
    assert_eq!(you.rework.returned, 0);
}

#[test]
fn a_commit_with_no_stated_reason_is_counted_as_unexplained() {
    let r = build(
        &[report(vec![
            change("Ash", "ash@example.com", 100, &["a.rs"], Some(row(90, "claude"))),
            change("Ash", "ash@example.com", 200, &["b.rs"], None),
        ])],
        &[],
        None,
    );
    let you = r.you.unwrap();
    assert_eq!(you.unexplained, 1);
    assert_eq!(you.agents.get("Claude"), Some(&1));
}

#[test]
fn time_to_land_is_measured_from_the_ask_not_from_the_intent_row() {
    // An agent logs its intent in the seconds before it commits. Measuring
    // from there reported "under a minute" on real history — true, useless,
    // and indistinguishable from an answer.
    let r = build(
        &[report(vec![asked(
            change("Ash", "ash@example.com", 4_000, &["a.rs"], Some(row(3_990, "claude"))),
            1_000,
        )])],
        &[],
        None,
    );
    let you = r.you.unwrap();
    assert_eq!(you.land.median, Some(3_000), "the prompt, not the intent row");
    assert_eq!(you.land.counted, 1);
}

#[test]
fn a_commit_with_no_ask_behind_it_is_left_out_of_the_median_and_counted() {
    let r = build(
        &[report(vec![
            asked(change("Ash", "ash@example.com", 4_000, &["a.rs"], None), 1_000),
            change("Ash", "ash@example.com", 5_000, &["b.rs"], None),
        ])],
        &[],
        None,
    );
    let you = r.you.unwrap();
    assert_eq!(you.land.counted, 1);
    assert_eq!(you.land.uncounted, 1, "the median covers half this window");
}

#[test]
fn a_dialect_that_records_no_clock_does_not_become_a_span_of_decades() {
    // `Prompt::at` is 0 when the transcript carries no time for the row.
    // Treating that as an epoch second turns one bad match into a median of
    // fifty-six years.
    let r = build(
        &[report(vec![asked(
            change("Ash", "ash@example.com", 4_000, &["a.rs"], None),
            0,
        )])],
        &[],
        None,
    );
    let you = r.you.unwrap();
    assert_eq!(you.land.median, None);
    assert_eq!(you.land.uncounted, 1);
}

// ── The agent filter ───────────────────────────────────────────────────────

#[test]
fn the_agent_filter_keeps_only_what_that_agent_explained() {
    let r = build(
        &[report(vec![
            change("Ash", "ash@example.com", 100, &["a.rs"], Some(row(90, "claude"))),
            change("Ash", "ash@example.com", 200, &["b.rs"], Some(row(190, "codex"))),
            change("Ash", "ash@example.com", 300, &["c.rs"], None),
        ])],
        &[],
        Some("Claude"),
    );
    let you = r.you.unwrap();
    assert_eq!(you.commits, 1, "case-insensitive, and a bare commit is nobody's");
    assert_eq!(you.files, 1);
}

// ── What moved under you ───────────────────────────────────────────────────

#[test]
fn a_file_you_committed_and_somebody_else_changed_shows_up() {
    let r = build(
        &[report(vec![
            change("Ash", "ash@example.com", 100, &["a.rs"], None),
            change("Dana", "dana@example.com", 200, &["a.rs"], None),
        ])],
        &[],
        None,
    );
    assert_eq!(r.under_you.len(), 1);
    assert_eq!(r.under_you[0].who, "Dana");
    assert!(!r.under_you[0].in_flight);
}

#[test]
fn a_file_dirty_in_your_tree_is_flagged_and_sorts_first() {
    // The overlap worth interrupting somebody for is on the file open in
    // front of them, which is the one git has not been told about yet.
    let r = build(
        &[report(vec![
            change("Ash", "ash@example.com", 100, &["a.rs"], None),
            change("Dana", "dana@example.com", 200, &["a.rs"], None),
            change("Dana", "dana@example.com", 900, &["open.rs"], None),
        ])],
        &["open.rs"],
        None,
    );
    assert_eq!(r.under_you.len(), 2);
    assert!(r.under_you[0].in_flight, "the uncommitted one leads");
    assert_eq!(r.under_you[0].file, "open.rs");
}

#[test]
fn your_own_commits_never_show_as_moving_under_you() {
    let r = build(
        &[report(vec![
            change("Ash", "ash@example.com", 100, &["a.rs"], None),
            change("Ash", "ash@example.com", 200, &["a.rs"], None),
        ])],
        &["a.rs"],
        None,
    );
    assert!(r.under_you.is_empty(), "coming back to your own file is rework, not a collision");
}

#[test]
fn a_file_only_somebody_else_touched_is_not_under_you() {
    let r = build(
        &[report(vec![
            change("Ash", "ash@example.com", 100, &["a.rs"], None),
            change("Dana", "dana@example.com", 200, &["far.rs"], None),
        ])],
        &[],
        None,
    );
    assert!(r.under_you.is_empty(), "it is only news where your work is");
}

#[test]
fn the_newest_change_to_a_file_is_the_one_shown() {
    let r = build(
        &[report(vec![
            change("Ash", "ash@example.com", 100, &["a.rs"], None),
            change("Dana", "dana@example.com", 200, &["a.rs"], None),
            change("Sam", "sam@example.com", 500, &["a.rs"], None),
        ])],
        &[],
        None,
    );
    assert_eq!(r.under_you.len(), 1);
    assert_eq!(r.under_you[0].who, "Sam");
}

// ── The renderings ─────────────────────────────────────────────────────────

#[test]
fn the_static_rendering_carries_no_escape_codes() {
    // `--static` exists to survive a pipe, a cron job and a Slack post.
    let r = build(
        &[report(vec![change("Ash", "ash@example.com", 100, &["a.rs"], Some(row(40, "claude")))])],
        &[],
        None,
    );
    let text = render::plain(&r);
    assert!(!text.contains('\u{1b}'), "an escape byte reached a pipe");
    assert!(text.contains("Recap"));
}

#[test]
fn the_static_rendering_says_when_not_how_long_ago() {
    // A recap read tomorrow must not still claim something happened "2h ago".
    let r = build(
        &[report(vec![
            change("Ash", "ash@example.com", 100, &["a.rs"], None),
            change("Dana", "dana@example.com", 200, &["a.rs"], None),
        ])],
        &[],
        None,
    );
    let text = render::plain(&r);
    assert!(text.contains("What moved under you"));
    assert!(!text.contains("ago"), "relative time does not survive being saved");
}

#[test]
fn every_rendering_names_what_it_could_not_answer() {
    // A "changes requested" column of zeroes reads as a clean window rather
    // than an unrecorded one, so the absence is stated instead.
    let r = build(&[report(vec![])], &[], None);
    for text in [render::plain(&r), render::markdown(&r)] {
        assert!(text.contains("changes requested") || text.contains("Changes requested"), "{text}");
        assert!(text.contains("no review ran"), "{text}");
    }
}

#[test]
fn a_span_is_said_the_way_a_person_says_it() {
    assert_eq!(render::span(30), "under a minute");
    assert_eq!(render::span(18 * 60), "18m");
    assert_eq!(render::span(2 * 3600), "2h");
    assert_eq!(render::span(2 * 3600 + 10 * 60), "2h 10m");
    assert_eq!(render::span(3 * 86_400), "3d");
    assert_eq!(render::span(3 * 86_400 + 4 * 3600), "3d 4h");
}

#[test]
fn a_checkout_with_no_git_identity_says_so_rather_than_showing_an_empty_you() {
    let mut d = BTreeMap::new();
    d.insert("app".to_string(), Vec::new());
    let r = assemble(
        &[report(vec![change("Dana", "dana@example.com", 100, &["a.rs"], None)])],
        &d,
        Reviews::default(),
        Window::Week,
        0,
        10_000,
        View::You,
        None,
        None,
    );
    assert!(r.you.is_none());
    assert!(render::plain(&r).contains("no git identity"));
}
