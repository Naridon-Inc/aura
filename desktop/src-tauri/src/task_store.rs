//! The desktop side of the one ledger behind `.aura/tasks/`.
//!
//! The projection itself — card shape, status table, atomic per-file write —
//! lives in `aura_loop::board_card`, because the agent-facing MCP board and
//! the crew runner write these same files and a second copy of that table
//! here would let the surfaces disagree about what a status means. This
//! module is only the adapter that puts a typed [`Task`] on either end of
//! it, so `cmd_tasks` keeps working in the struct it already renders.

use std::path::Path;

use aura_loop::board_card;
pub use aura_loop::board_card::{is_card_id, tasks_dir, Card};

use crate::cmd_tasks::Task;

/// Project a card onto the board row the app renders.
///
/// Every field on `Task` that a card does not carry is `#[serde(default)]`,
/// so the row the projection produces deserializes without naming the other
/// thirty — the same way a row written before a field existed does.
pub fn card_to_task(card: &Card) -> Task {
    serde_json::from_value(board_card::card_to_row(card))
        .expect("a card's fields are a subset of a board row")
}

/// Fold a board row back into the card it came from, keeping the comments,
/// the linked branch and anything else that lives only on the card.
pub fn task_into_card(task: &Task, prev: Option<&Card>) -> Card {
    let row = serde_json::to_value(task).expect("a board row always encodes");
    board_card::row_into_card(&row, prev)
}

/// Every per-file card in the directory, as the rows the board renders.
pub fn read_card_tasks(repo_root: &Path) -> Vec<Task> {
    board_card::read_cards(repo_root)
        .iter()
        .map(card_to_task)
        .collect()
}

pub fn read_cards(repo_root: &Path) -> Vec<Card> {
    board_card::read_cards(repo_root)
}

pub fn write_card(repo_root: &Path, card: &Card) -> Result<(), String> {
    board_card::write_card(repo_root, card)
}

pub fn remove_card(repo_root: &Path, id: &str) -> Result<(), String> {
    board_card::remove_card(repo_root, id)
}

/// Catalog state for a card status. Re-exported so the board's state seeder
/// and its tests can ask what a card needs to point at.
pub fn card_status_to_state_id(status: &str) -> &'static str {
    board_card::card_status_to_state_id(status)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn card(id: &str, status: &str) -> Card {
        Card {
            id: id.into(),
            title: "a task".into(),
            body: "why it exists".into(),
            status: status.into(),
            priority: "critical".into(),
            author: "ashiq".into(),
            assignee: Some("ashiq".into()),
            claimed_by: Some("claude".into()),
            labels: vec!["audit".into()],
            created_at: 1_767_225_600,
            updated_at: 1_767_225_600,
            comments: vec![serde_json::json!({ "body": "picked it up" })],
            linked_pr: Some("https://github.com/MHASK/aura-sovereign/pull/57".into()),
            linked_branch: Some("post-audit".into()),
            sequence_id: 412,
            rest: Default::default(),
        }
    }

    #[test]
    fn a_card_arrives_as_a_board_row_the_app_can_render() {
        let t = card_to_task(&card("T-11111111", "in_progress"));
        assert_eq!(t.id, "T-11111111");
        assert_eq!(t.state_id, "started");
        assert_eq!(t.priority, "urgent");
        assert_eq!(t.sequence_id, 412, "the AURA- handle must survive the trip");
        assert_eq!(t.assignee.as_deref(), Some("ashiq"));
        assert_eq!(t.agent_assignee.as_deref(), Some("claude"));
        let pr = t.linked_pr.as_ref().expect("the card's pull request reaches the board");
        assert_eq!(pr.repo, "MHASK/aura-sovereign");
        assert_eq!(pr.number, 57);
        assert_eq!(t.labels, vec!["audit".to_string()]);
    }

    #[test]
    fn every_card_status_round_trips_through_a_board_row() {
        for status in ["open", "in_progress", "blocked", "done", "cancelled"] {
            let c = card("T-22222222", status);
            let back = task_into_card(&card_to_task(&c), Some(&c));
            assert_eq!(back.status, status, "{status} did not survive");
            assert_eq!(back.sequence_id, 412);
            assert_eq!(back.comments.len(), 1);
        }
    }

    #[test]
    fn card_ids_and_board_ids_stay_apart() {
        assert!(is_card_id("T-7af2c091"));
        assert!(!is_card_id("task_9a0d3f11-0000-4000-8000-000000000000"));
    }
}
