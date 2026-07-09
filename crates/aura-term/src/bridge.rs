//! Bridge — translates PTY events into Block lifecycle + BlockOps.
//!
//! Ported verbatim from aura-term/src/bridge.rs. See that file's doc-comment
//! for the conceptual flow. Single block in flight at a time; AppendOutput
//! goes through the OutputRing (fast path); transitions go through the
//! transactional reducer.

use std::path::PathBuf;
use std::sync::Arc;

use aura_blocks::{
    AgentRef, AnchorRef, Attestations, Block, BlockId, BlockKind, BlockOp, BlockOpPayload,
    BlockPayload, BlockState, DeclaredImpacts, Intent, Provenance, SCHEMA_VERSION,
};
use aura_blockstore::{BlockStore, output_ring::DEFAULT_CAP_BYTES};
use base64::Engine;
use bytes::Bytes;
use std::collections::BTreeMap;
use time::OffsetDateTime;
use uuid::Uuid;

use crate::error::Result;
use crate::pty::{Osc133, PtyEvent};

const STDOUT_STREAM: &str = "stdout";

#[derive(Debug)]
struct RunningBlock {
    id: BlockId,
    lamport: u64,
}

#[derive(Debug)]
pub struct Bridge {
    store: Arc<BlockStore>,
    actor: AgentRef,
    origin_host: String,
    cwd: PathBuf,
    shell: String,
    current: Option<RunningBlock>,
}

impl Bridge {
    pub fn new(
        store: Arc<BlockStore>,
        actor: AgentRef,
        origin_host: String,
        cwd: PathBuf,
        shell: String,
    ) -> Self {
        Self {
            store,
            actor,
            origin_host,
            cwd,
            shell,
            current: None,
        }
    }

    pub fn current_block(&self) -> Option<BlockId> {
        self.current.as_ref().map(|r| r.id)
    }

    pub fn start_command(&mut self, command_line: String, intent_summary: String) -> Result<BlockId> {
        if self.current.is_some() {
            self.finish_command(130)?;
        }

        let now = OffsetDateTime::now_utc();
        let block = Block {
            id: BlockId::new(),
            schema_version: SCHEMA_VERSION,
            kind: BlockKind::Command,
            parent_id: None,
            prior_sibling_id: None,
            supersedes_id: None,
            anchor: AnchorRef::None,
            intent: Intent {
                summary: intent_summary,
                detail: None,
                parent_intent: None,
            },
            declared_impacts: DeclaredImpacts::default(),
            actual_impacts: None,
            payload: BlockPayload::Command {
                command: command_line,
                shell: Some(self.shell.clone()),
                cwd: self.cwd.to_string_lossy().into_owned(),
            },
            state: BlockState::Proposed,
            policy: None,
            provenance: Provenance {
                actor: self.actor.clone(),
                on_behalf_of: None,
                origin_host: self.origin_host.clone(),
                signature: None,
            },
            attestations: Attestations::default(),
            created_at: now,
            updated_at: now,
            extensions: BTreeMap::new(),
        };
        let block_id = block.id;
        self.store.insert_block(&block)?;

        let transition = BlockOp {
            op_id: Uuid::now_v7(),
            block_id,
            actor: self.actor.clone(),
            timestamp: OffsetDateTime::now_utc(),
            lamport: 0,
            payload: BlockOpPayload::Transition {
                to: BlockState::Running,
                reason: None,
            },
        };
        self.store.apply_op(&transition)?;

        self.current = Some(RunningBlock {
            id: block_id,
            lamport: 1,
        });
        tracing::debug!(block_id = ?block_id, "bridge: command started");
        Ok(block_id)
    }

    pub fn append_output(&mut self, bytes: Bytes) -> Result<()> {
        let Some(current) = self.current.as_mut() else {
            return Ok(());
        };
        let op = BlockOp {
            op_id: Uuid::now_v7(),
            block_id: current.id,
            actor: self.actor.clone(),
            timestamp: OffsetDateTime::now_utc(),
            lamport: current.lamport,
            payload: BlockOpPayload::AppendOutput {
                stream: STDOUT_STREAM.to_string(),
                bytes_b64: base64::engine::general_purpose::STANDARD.encode(&bytes),
                redactions: Vec::new(),
            },
        };
        current.lamport += 1;
        let ring = self
            .store
            .rings()
            .get_or_create(current.id, DEFAULT_CAP_BYTES);
        ring.append(op)?;
        Ok(())
    }

    pub fn finish_command(&mut self, exit: i32) -> Result<()> {
        let Some(current) = self.current.take() else {
            return Ok(());
        };
        let next_state = if exit == 0 {
            BlockState::Completed
        } else {
            BlockState::Failed
        };
        let op = BlockOp {
            op_id: Uuid::now_v7(),
            block_id: current.id,
            actor: self.actor.clone(),
            timestamp: OffsetDateTime::now_utc(),
            lamport: current.lamport,
            payload: BlockOpPayload::Transition {
                to: next_state,
                reason: Some(format!("exit {exit}")),
            },
        };
        self.store.flush_output_rings()?;
        self.store.apply_op(&op)?;
        tracing::debug!(block_id = ?current.id, exit, "bridge: command finished");
        Ok(())
    }

    pub fn on_pty_event(&mut self, event: PtyEvent) -> Result<()> {
        match event {
            PtyEvent::Output(bytes) => self.append_output(bytes)?,
            PtyEvent::Marker(Osc133::CommandStart) => {
                // OSC 133;B fires at the start of user input region. Treat
                // as "command about to run" if no block is live yet; the
                // UI may have already called start_command from Submit.
            }
            PtyEvent::Marker(Osc133::CommandEnd { exit }) => {
                self.finish_command(exit.unwrap_or(0))?;
            }
            PtyEvent::Marker(_) => {}
            PtyEvent::Closed => {
                if self.current.is_some() {
                    self.finish_command(0)?;
                }
            }
        }
        Ok(())
    }
}

impl Drop for Bridge {
    fn drop(&mut self) {
        if self.current.is_some() {
            let _ = self.finish_command(130);
        }
    }
}
