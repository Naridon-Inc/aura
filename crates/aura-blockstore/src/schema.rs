//! SQLite schema for aura-blockstore.
//!
//! Four tables:
//!   * `blocks` — envelope + reduced mutable header, one row per block.
//!   * `block_ops` — append-only op log; source of truth for state rebuilds.
//!   * `block_refs` — dynamic N:M edges (tags, skill membership, subscriptions).
//!   * `sidebar_cards` — materialized projection for the work-surface sidebar.
//!
//! Schema evolves via `user_version` pragma. `SCHEMA_USER_VERSION` is the
//! current version; fresh databases are initialized at this version; existing
//! databases at a lower version fail `check_version` until a migrator exists
//! (first migrator lands with the next schema bump — not this wave).
//!
//! No ALTER TABLE in-place. Schema bumps land as a new migrator that reads
//! the old user_version, runs ordered SQL, and bumps the pragma.

use rusqlite::Connection;

use crate::error::{Result, StoreError};

/// Current schema version. Bump when adding a migrator.
pub const SCHEMA_USER_VERSION: u32 = 1;

/// Table definitions. Written as one `execute_batch` string so init is atomic.
///
/// Columns that hold serialized envelope fragments use TEXT + JSON — SQLite's
/// JSON1 extension is always available in `rusqlite` with `bundled`, and we
/// need indexing on a handful of extracted fields, not arbitrary queries.
const SCHEMA: &str = r#"
-- blocks: full envelope stored as block_json (source of truth for the row).
-- Redundant columns are denormalized for indexing only; they are derived from
-- block_json on every write and never consulted during reconstruction.
CREATE TABLE IF NOT EXISTS blocks (
    id                 BLOB    PRIMARY KEY,
    kind               TEXT    NOT NULL,
    state              TEXT    NOT NULL,
    parent_id          BLOB    REFERENCES blocks(id) DEFERRABLE INITIALLY DEFERRED,
    prior_sibling_id   BLOB    REFERENCES blocks(id) DEFERRABLE INITIALLY DEFERRED,
    supersedes_id      BLOB    REFERENCES blocks(id) DEFERRABLE INITIALLY DEFERRED,
    anchor_kind        TEXT    NOT NULL,
    anchor_value       TEXT,
    created_at         INTEGER NOT NULL,
    updated_at         INTEGER NOT NULL,
    block_json         TEXT    NOT NULL,
    partition_key      TEXT    NOT NULL DEFAULT 'default',
    compaction_version INTEGER NOT NULL DEFAULT 0
);

CREATE INDEX IF NOT EXISTS idx_blocks_parent     ON blocks(parent_id);
CREATE INDEX IF NOT EXISTS idx_blocks_anchor     ON blocks(anchor_kind, anchor_value);
CREATE INDEX IF NOT EXISTS idx_blocks_kind_state ON blocks(kind, state);
CREATE INDEX IF NOT EXISTS idx_blocks_updated    ON blocks(updated_at DESC);

-- block_ops: append-only log; source of truth
CREATE TABLE IF NOT EXISTS block_ops (
    op_id         BLOB    PRIMARY KEY,
    block_id      BLOB    NOT NULL REFERENCES blocks(id) DEFERRABLE INITIALLY DEFERRED,
    actor         TEXT    NOT NULL,
    ts            INTEGER NOT NULL,
    lamport       INTEGER NOT NULL,
    payload_kind  TEXT    NOT NULL,
    payload_json  TEXT    NOT NULL,
    partition_key TEXT    NOT NULL DEFAULT 'default'
);

CREATE INDEX IF NOT EXISTS idx_block_ops_order ON block_ops(block_id, ts, lamport, actor);
CREATE INDEX IF NOT EXISTS idx_block_ops_kind  ON block_ops(payload_kind);

-- block_refs: dynamic edges (tags, skill membership, sentinel subscriptions)
CREATE TABLE IF NOT EXISTS block_refs (
    block_id  BLOB    NOT NULL REFERENCES blocks(id) DEFERRABLE INITIALLY DEFERRED,
    ref_kind  TEXT    NOT NULL,
    ref_value TEXT    NOT NULL,
    PRIMARY KEY (block_id, ref_kind, ref_value)
);

CREATE INDEX IF NOT EXISTS idx_block_refs_kv ON block_refs(ref_kind, ref_value);

-- sidebar_cards: materialized projection
CREATE TABLE IF NOT EXISTS sidebar_cards (
    block_id        BLOB    PRIMARY KEY REFERENCES blocks(id) DEFERRABLE INITIALLY DEFERRED,
    priority_bucket INTEGER NOT NULL,
    score           REAL    NOT NULL,
    actor_label     TEXT    NOT NULL,
    anchor_label    TEXT,
    summary         TEXT    NOT NULL,
    unread          INTEGER NOT NULL DEFAULT 1,
    children_count  INTEGER NOT NULL DEFAULT 0,
    created_at      INTEGER NOT NULL,
    updated_at      INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_sidebar_prio ON sidebar_cards(priority_bucket, score DESC, updated_at DESC);
"#;

/// Initialize a fresh or existing database.
///
/// Idempotent via `IF NOT EXISTS`. On fresh databases, stamps the
/// `user_version` pragma to [`SCHEMA_USER_VERSION`]. On existing databases
/// already at that version, is a no-op. On existing databases at a different
/// version, does not run — callers must invoke a migrator first (and there is
/// no migrator in this wave — the first one ships with the next schema bump).
pub fn init_db(conn: &Connection) -> Result<()> {
    conn.execute_batch("PRAGMA foreign_keys = ON;")?;
    let current: u32 = conn.query_row("PRAGMA user_version", [], |r| r.get(0))?;
    if current == 0 {
        conn.execute_batch(SCHEMA)?;
        conn.pragma_update(None, "user_version", SCHEMA_USER_VERSION)?;
    } else if current == SCHEMA_USER_VERSION {
        // Idempotent: schema already installed at the current version. Running
        // the batch again is safe (IF NOT EXISTS) but the pragma write is
        // unnecessary work, so we skip.
        conn.execute_batch(SCHEMA)?;
    } else {
        return Err(StoreError::SchemaVersion {
            found: current,
            expected: SCHEMA_USER_VERSION,
        });
    }
    Ok(())
}

/// Verify the database is at the expected schema version. Returns
/// `StoreError::SchemaVersion` on mismatch so callers can refuse to operate
/// on a stale store rather than silently corrupting it.
pub fn check_version(conn: &Connection) -> Result<()> {
    let current: u32 = conn.query_row("PRAGMA user_version", [], |r| r.get(0))?;
    if current == SCHEMA_USER_VERSION {
        Ok(())
    } else {
        Err(StoreError::SchemaVersion {
            found: current,
            expected: SCHEMA_USER_VERSION,
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn open_memory() -> Connection {
        Connection::open_in_memory().expect("open in-memory sqlite")
    }

    #[test]
    fn init_fresh_sets_schema_and_user_version() {
        let conn = open_memory();
        init_db(&conn).unwrap();
        check_version(&conn).unwrap();

        // Every table exists.
        let names: Vec<String> = conn
            .prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name")
            .unwrap()
            .query_map([], |r| r.get(0))
            .unwrap()
            .collect::<Result<_, _>>()
            .unwrap();
        for expected in ["block_ops", "block_refs", "blocks", "sidebar_cards"] {
            assert!(
                names.iter().any(|n| n == expected),
                "missing table {expected}; got {names:?}"
            );
        }
    }

    #[test]
    fn init_twice_is_noop() {
        let conn = open_memory();
        init_db(&conn).unwrap();
        init_db(&conn).unwrap();
        check_version(&conn).unwrap();
    }

    #[test]
    fn check_version_refuses_mismatch() {
        let conn = open_memory();
        init_db(&conn).unwrap();
        // Simulate a future-version database.
        conn.pragma_update(None, "user_version", SCHEMA_USER_VERSION + 1)
            .unwrap();
        let err = check_version(&conn).unwrap_err();
        assert!(matches!(err, StoreError::SchemaVersion { .. }));
    }
}
