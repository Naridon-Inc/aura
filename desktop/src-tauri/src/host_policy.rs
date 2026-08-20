//! Aura's answer when a hosted agent asks to run a tool or write a file.
//!
//! The agent asks; this decides. Every engine Aura hosts natively lands
//! here — ACP agents through `session/request_permission`, pi through its
//! `tool_call` hook — so "the gate" is one implementation rather than one
//! per protocol.
//!
//! Both halves reuse machinery the app already had, which is the point — a
//! third-party coding agent gets the same treatment as Claude Code rather
//! than a parallel, weaker one:
//!
//! - **Permission** goes through [`PermissionRegistry`], the same queue
//!   and the same React card that `permission:prompt` already renders. An
//!   "always" answer is remembered per (agent, tool) by that registry, so
//!   the user's decision carries across turns without us keeping a second
//!   copy of it.
//! - **Before a write**, `aura snapshot create` runs and is awaited. If
//!   the snapshot fails the write does not happen: an overwrite we can't
//!   rewind is worse than a refused edit.
//!
//! The repo root for a snapshot is found by walking up from the file to
//! the nearest `.git`. That is deliberately the *file's* repo and not the
//! session root — an agent working in a worktree writes files whose
//! snapshots belong to that worktree's `.aura`, not the parent's.

use std::path::Path;
use std::sync::Arc;

use async_trait::async_trait;
use serde_json::Value;
use tauri::{AppHandle, Manager};

use crate::cmd_permission::{
    PendingPrompt, PermissionDecision, PermissionRegistry, emit_prompt,
};
use crate::manager::brain::authority::{Capability, repo_root_for};
use crate::manager::brain::gate::{self, GateDecision, HostPolicy};

/// One approver, bound to the running window.
pub struct TauriHostPolicy {
    app: AppHandle,
    /// Which agent is asking — the permission registry keys remembered
    /// "always" answers on this, so OpenCode being trusted with a tool
    /// doesn't silently extend that trust to a different agent.
    channel: String,
}

impl TauriHostPolicy {
    pub fn new(app: AppHandle, channel: impl Into<String>) -> Self {
        Self {
            app,
            channel: channel.into(),
        }
    }
}

#[async_trait]
impl HostPolicy for TauriHostPolicy {
    async fn ask_permission(&self, tool: &str, input: &Value) -> GateDecision {
        let registry = self.app.state::<PermissionRegistry>();

        // A remembered "always" answers without another card.
        if registry.is_auto_allowed(&self.channel, tool) {
            return GateDecision::AllowAlways;
        }

        let prompt = PendingPrompt {
            prompt_id: uuid::Uuid::new_v4().to_string(),
            channel: self.channel.clone(),
            tool_name: tool.to_string(),
            input: input.clone(),
            ts: chrono::Utc::now().timestamp(),
        };
        let rx = registry.enqueue(prompt.clone());
        emit_prompt(&self.app, &prompt);

        // A closed channel means the window went away mid-prompt. Nobody
        // answered, so nothing is approved.
        match rx.await {
            Ok(resp) => match resp.decision {
                PermissionDecision::Allow => GateDecision::Allow,
                PermissionDecision::AllowAlways => GateDecision::AllowAlways,
                PermissionDecision::Deny => GateDecision::Deny,
            },
            Err(_) => GateDecision::Deny,
        }
    }

    /// A governed capability, asked through the same card as a tool call
    /// but remembered differently — which is the whole reason this is not
    /// left to the default implementation.
    ///
    /// `ask_permission` consults and populates the registry's auto-allow
    /// set, keyed by `(agent, tool)`. Reusing that here would turn a single
    /// "always" click into a standing permission for the *whole class* of
    /// act: "yes, delete `parse_token`" becoming "yes, delete anything
    /// exported, forever". So this never reads the auto-allow set, and the
    /// key it would be remembered under names the specific act, so a
    /// remembered answer cannot match a later, different one.
    ///
    /// A standing yes is still available — it is `allow` in `[authority]`,
    /// which lands in a commit with someone's name on it.
    async fn ask_capability(&self, cap: Capability, detail: &str) -> GateDecision {
        let prompt = PendingPrompt {
            prompt_id: uuid::Uuid::new_v4().to_string(),
            channel: self.channel.clone(),
            tool_name: format!("{}:{detail}", cap.key()),
            input: serde_json::json!({
                "capability": cap.key(),
                "act": cap.describe(),
                "detail": detail,
            }),
            ts: chrono::Utc::now().timestamp(),
        };
        let registry = self.app.state::<PermissionRegistry>();
        let rx = registry.enqueue(prompt.clone());
        emit_prompt(&self.app, &prompt);

        match rx.await {
            // `AllowAlways` is folded into `Allow` deliberately: the card
            // offers the button, and the honest reading of it here is "yes,
            // this one".
            Ok(resp) => match resp.decision {
                PermissionDecision::Allow | PermissionDecision::AllowAlways => GateDecision::Allow,
                PermissionDecision::Deny => GateDecision::Deny,
            },
            Err(_) => GateDecision::Deny,
        }
    }

    async fn before_write(&self, path: &Path, _proposed: Option<&str>) -> Result<(), String> {
        let Some(root) = repo_root_for(path) else {
            // Outside any repo there is no `.aura` to snapshot into and
            // no rewind to protect the file with. Say so plainly instead
            // of implying the file was protected.
            return Err(format!(
                "{} is not inside a repository Aura tracks, so the edit could not be \
                 snapshotted and cannot be rewound.",
                path.display()
            ));
        };
        crate::cmd_aura::aura_snapshot(
            root.to_string_lossy().into_owned(),
            path.to_string_lossy().into_owned(),
        )
        .await
        .map_err(|e| format!("could not snapshot {} before the edit: {e}", path.display()))
    }
}

/// Attach Aura's gate to every hosted agent this process builds. Called
/// from app setup, before any brain can be constructed. The factory is
/// handed the asking agent's provider id so each one's remembered answers
/// stay its own.
pub fn install(app: &AppHandle) {
    let app = app.clone();
    gate::install(Box::new(move |agent| {
        Arc::new(TauriHostPolicy::new(app.clone(), agent)) as Arc<dyn HostPolicy>
    }));
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_repo_root_is_the_files_own_worktree() {
        let tmp = std::env::temp_dir().join(format!(
            "aura-acp-policy-{}",
            std::process::id()
        ));
        let nested = tmp.join("wt").join("src");
        std::fs::create_dir_all(&nested).unwrap();
        // A worktree's `.git` is a file, not a directory.
        std::fs::write(tmp.join("wt").join(".git"), "gitdir: ../.git/wt").unwrap();
        std::fs::create_dir_all(tmp.join(".git")).unwrap();

        let found = repo_root_for(&nested.join("main.rs")).unwrap();
        assert_eq!(
            found,
            tmp.join("wt"),
            "a file in a worktree snapshots into that worktree, not the parent repo"
        );
        let _ = std::fs::remove_dir_all(&tmp);
    }

    #[test]
    fn a_file_outside_any_repo_has_no_root() {
        let tmp = std::env::temp_dir().join(format!(
            "aura-acp-noroot-{}",
            std::process::id()
        ));
        std::fs::create_dir_all(&tmp).unwrap();
        // `std::env::temp_dir()` itself has no `.git` ancestor on either
        // platform we ship, so this is genuinely rootless.
        assert!(repo_root_for(&tmp.join("loose.txt")).is_none());
        let _ = std::fs::remove_dir_all(&tmp);
    }
}
