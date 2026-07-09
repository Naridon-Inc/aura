//! Prompt assembly for ManagerTask dispatch.
//!
//! The Manager loop hands each agent a prompt that combines:
//!   1. Session-level context (objective).
//!   2. Inbound relay summaries from upstream tasks (DuoTask.summary).
//!   3. The task's own description.
//!
//! Capped at 8KB. Truncation order on overflow: relay summaries first
//! (oldest dropped), then the objective preamble. The task description
//! is always preserved.

use super::{ManagerSession, ManagerTask};

const MAX_PROMPT_BYTES: usize = 8 * 1024;
const SUMMARY_HEADER: &str = "## Upstream context\n";
const OBJECTIVE_HEADER: &str = "## Session objective\n";
const TASK_HEADER: &str = "## Your task\n";

pub fn build_prompt(session: &ManagerSession, task: &ManagerTask) -> String {
    let task_block = format!("{TASK_HEADER}{}\n", task.description);

    let mut summaries: Vec<String> = task
        .depends_on
        .iter()
        .filter_map(|dep_id| session.task(*dep_id))
        .filter_map(|dep| {
            dep.summary.as_ref().map(|s| {
                format!("- Task #{} ({}):\n  {}\n", dep.id, dep.description, s.trim())
            })
        })
        .collect();

    let objective_block = if session.objective.is_empty() {
        String::new()
    } else {
        format!("{OBJECTIVE_HEADER}{}\n\n", session.objective)
    };

    loop {
        let summary_block = if summaries.is_empty() {
            String::new()
        } else {
            format!("{SUMMARY_HEADER}{}\n", summaries.join(""))
        };
        let combined = format!("{objective_block}{summary_block}{task_block}");
        if combined.len() <= MAX_PROMPT_BYTES {
            return combined;
        }
        if !summaries.is_empty() {
            summaries.remove(0);
            continue;
        }
        // Last resort: drop the objective preamble; never truncate the
        // task itself — the agent needs the full instruction.
        if !objective_block.is_empty() {
            return task_block;
        }
        return combined;
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::manager::{ManagerSession, ManagerTask, ManagerTaskStatus};

    fn task(id: usize, deps: Vec<usize>, summary: Option<&str>) -> ManagerTask {
        ManagerTask {
            id,
            description: format!("Do thing #{id}"),
            agent_id: Some("claude".into()),
            depends_on: deps,
            status: ManagerTaskStatus::Pending,
            project_root: "/tmp".into(),
            zones: vec![],
            blocked_reason: None,
            output: String::new(),
            summary: summary.map(|s| s.to_string()),
            started_at: None,
            completed_at: None,
            stream_channel: None,
            worktree_path: None,
            a2a_task_id: None,
            pre_dispatch_snapshot_ids: Vec::new(),
            recent_output: Vec::new(),
            line_count: 0,
            pending_skill: None,
        }
    }

    #[test]
    fn includes_objective_summary_and_task() {
        let session = ManagerSession::new(
            "s".into(),
            "Build login".into(),
            vec![],
            vec![
                task(1, vec![], Some("Designed schema")),
                task(2, vec![1], None),
            ],
        );
        let prompt = build_prompt(&session, &session.tasks[1]);
        assert!(prompt.contains("Build login"));
        assert!(prompt.contains("Designed schema"));
        assert!(prompt.contains("Do thing #2"));
    }

    #[test]
    fn truncates_summaries_when_over_cap() {
        let big = "x".repeat(5 * 1024);
        let session = ManagerSession::new(
            "s".into(),
            "obj".into(),
            vec![],
            vec![
                task(1, vec![], Some(&big)),
                task(2, vec![], Some(&big)),
                task(3, vec![1, 2], None),
            ],
        );
        let prompt = build_prompt(&session, &session.tasks[2]);
        assert!(prompt.len() <= MAX_PROMPT_BYTES);
        assert!(prompt.contains("Do thing #3"));
    }
}
