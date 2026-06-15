//! Bridge between legacy `aura-cli` operations and `aura-blockstore`.
//!
//! Stage S0.3 spike: prove the block substrate can absorb existing
//! command-shaped behaviour. `aura save` is the first integration —
//! every save now also emits a `BlockKind::Command` envelope into a
//! per-repo SQLite store at `.aura/blocks/store.db`.
//!
//! Subsequent stages widen this: `aura msg` → Message block (S0.4),
//! `aura plan` → Proposal blocks (S2), agent runs → ones with
//! AppendOutput op streams (S3+). All of them follow the same
//! open → build envelope → `insert_block` shape this module proves out.

use std::path::PathBuf;

use aura_blocks::{
    AgentRef, AnchorRef, Block, BlockId, BlockKind, BlockPayload, BlockState, Intent, Provenance,
    SCHEMA_VERSION,
};
use aura_blockstore::{BlockFilter, BlockStore};
use time::OffsetDateTime;

/// Per-repo block store path. Co-located with the rest of `.aura/`
/// per-repo runtime state (snapshots, sessions, plans, …).
pub fn store_path() -> PathBuf {
    PathBuf::from(".aura").join("blocks").join("store.db")
}

/// Open (or create) the per-repo block store.
pub fn open_store() -> Result<BlockStore, String> {
    let p = store_path();
    BlockStore::open(&p).map_err(|e| format!("open block store at {}: {}", p.display(), e))
}

/// Build the `did:aura:user/<login>` agent ref for the current user.
/// Falls back to "did:aura:user/unknown" if `$USER`/`$LOGNAME` are unset.
fn current_user_did() -> AgentRef {
    let login = std::env::var("USER")
        .or_else(|_| std::env::var("LOGNAME"))
        .unwrap_or_else(|_| "unknown".into());
    AgentRef(format!("did:aura:user/{login}"))
}

/// Hostname for `provenance.origin_host`. Uses `gethostname` via
/// `hostname` env fall-back; the block store treats this as opaque.
fn origin_host() -> String {
    std::env::var("HOSTNAME")
        .or_else(|_| std::env::var("HOST"))
        .unwrap_or_else(|_| "unknown".into())
}

/// Emit a `Command` block recording an `aura save` invocation.
///
/// The block carries the user's intent message verbatim, the literal
/// command line, the cwd, and a list of touched files in `extensions`
/// so a future query layer can join save events back to file blame.
///
/// Returns the new block's id on success.
pub fn emit_save_command(message: &str, modified_files: &[String]) -> Result<BlockId, String> {
    let store = open_store()?;
    let cwd = std::env::current_dir()
        .map(|p| p.to_string_lossy().to_string())
        .unwrap_or_else(|_| ".".into());

    let mut extensions = std::collections::BTreeMap::new();
    extensions.insert(
        "save.modified_files".to_string(),
        serde_json::to_value(modified_files).unwrap_or(serde_json::Value::Null),
    );

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
            summary: message.to_string(),
            detail: None,
            parent_intent: None,
        },
        declared_impacts: Default::default(),
        actual_impacts: None,
        payload: BlockPayload::Command {
            command: format!("aura save {message:?}"),
            shell: std::env::var("SHELL")
                .ok()
                .and_then(|s| s.rsplit('/').next().map(|n| n.to_string())),
            cwd,
        },
        state: BlockState::Completed,
        policy: None,
        provenance: Provenance {
            actor: current_user_did(),
            on_behalf_of: None,
            origin_host: origin_host(),
            signature: None,
        },
        attestations: Default::default(),
        created_at: now,
        updated_at: now,
        extensions,
    };

    store
        .insert_block(&block)
        .map_err(|e| format!("insert block: {e}"))?;
    Ok(block.id)
}

/// Emit a `Message` block recording an `aura msg send` invocation.
///
/// `recipient` is the optional DM target (None = broadcast). It maps onto
/// `BlockPayload::Message.mentions` as a single `AgentRef` so the block
/// store carries the same shape the cloud message API uses. The team
/// channel name (== current branch) is stuffed into `extensions` for
/// future query joins.
///
/// Returns the new block's id on success.
pub fn emit_message_block(
    body: &str,
    recipient: Option<&str>,
    channel: Option<&str>,
) -> Result<BlockId, String> {
    let store = open_store()?;

    let mentions = match recipient {
        Some(login) => vec![AgentRef(format!("did:aura:user/{login}"))],
        None => Vec::new(),
    };

    let mut extensions = std::collections::BTreeMap::new();
    if let Some(ch) = channel {
        extensions.insert(
            "msg.channel".to_string(),
            serde_json::Value::String(ch.to_string()),
        );
    }
    extensions.insert(
        "msg.broadcast".to_string(),
        serde_json::Value::Bool(recipient.is_none()),
    );

    let now = OffsetDateTime::now_utc();
    let block = Block {
        id: BlockId::new(),
        schema_version: SCHEMA_VERSION,
        kind: BlockKind::Message,
        parent_id: None,
        prior_sibling_id: None,
        supersedes_id: None,
        anchor: AnchorRef::None,
        intent: Intent {
            summary: body.lines().next().unwrap_or(body).to_string(),
            detail: if body.lines().count() > 1 {
                Some(body.to_string())
            } else {
                None
            },
            parent_intent: None,
        },
        declared_impacts: Default::default(),
        actual_impacts: None,
        payload: BlockPayload::Message {
            body: body.to_string(),
            mentions,
        },
        state: BlockState::Completed,
        policy: None,
        provenance: Provenance {
            actor: current_user_did(),
            on_behalf_of: None,
            origin_host: origin_host(),
            signature: None,
        },
        attestations: Default::default(),
        created_at: now,
        updated_at: now,
        extensions,
    };

    store
        .insert_block(&block)
        .map_err(|e| format!("insert block: {e}"))?;
    Ok(block.id)
}

/// Convenience for `aura blocks list` — returns recent blocks of an
/// optional kind, newest first.
pub fn list_recent(kind: Option<BlockKind>, limit: u32) -> Result<Vec<Block>, String> {
    let store = open_store()?;
    let filter = BlockFilter {
        kind,
        state: None,
        parent_id: None,
        actor: None,
        anchor_kind: None,
        anchor_value: None,
        since_ms: None,
        until_ms: None,
        limit: Some(limit),
    };
    store.list_blocks(&filter).map_err(|e| format!("list: {e}"))
}
