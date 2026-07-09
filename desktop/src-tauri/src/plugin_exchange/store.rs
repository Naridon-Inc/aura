//! Local persistence for the Plugin Exchange.
//!
//! Everything lives under `.aura/exchange/` in the repo:
//!   `_sync_cursor.json`            — last rail seq we applied
//!   `index.json`                   — listings visible in the browser
//!   `blobs/<publish_id>.gz`        — complete verified archives
//!   `pending/<publish_id>/<i>.part`— chunks still being assembled

use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};

use super::wire::ExchangePublisher;

/// A published bundle as shown in the team's plugin browser.
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct Listing {
    pub publish_id: String,
    pub bundle_id: String,
    pub version: String,
    /// Display name from the manifest (falls back to the bundle id).
    pub name: String,
    #[serde(default)]
    pub description: String,
    #[serde(default)]
    pub capabilities: Vec<String>,
    pub publisher: ExchangePublisher,
    pub archive_sha256: String,
    pub ts: i64,
}

#[derive(Clone, Debug, Default, Serialize, Deserialize)]
pub struct Index {
    #[serde(default)]
    pub listings: Vec<Listing>,
}

#[derive(Clone, Copy, Debug, Default, Serialize, Deserialize)]
pub struct SyncCursor {
    #[serde(default)]
    pub last_seq: i64,
}

pub fn exchange_root(repo_root: &Path) -> PathBuf {
    repo_root.join(".aura").join("exchange")
}

fn cursor_path(repo_root: &Path) -> PathBuf {
    exchange_root(repo_root).join("_sync_cursor.json")
}

fn index_path(repo_root: &Path) -> PathBuf {
    exchange_root(repo_root).join("index.json")
}

pub fn blob_path(repo_root: &Path, publish_id: &str) -> PathBuf {
    exchange_root(repo_root)
        .join("blobs")
        .join(format!("{}.gz", sanitize_id(publish_id)))
}

fn pending_dir(repo_root: &Path, publish_id: &str) -> PathBuf {
    exchange_root(repo_root)
        .join("pending")
        .join(sanitize_id(publish_id))
}

/// publish_ids come off the wire — never let one name a path outside
/// our directories. uuids only need [a-z0-9-]; anything else becomes '_'.
fn sanitize_id(id: &str) -> String {
    id.chars()
        .map(|c| {
            if c.is_ascii_alphanumeric() || c == '-' {
                c
            } else {
                '_'
            }
        })
        .collect()
}

pub fn load_cursor(repo_root: &Path) -> SyncCursor {
    std::fs::read_to_string(cursor_path(repo_root))
        .ok()
        .and_then(|s| serde_json::from_str(&s).ok())
        .unwrap_or_default()
}

pub fn save_cursor(repo_root: &Path, cursor: &SyncCursor) -> Result<(), String> {
    crate::fs_atomic::write_json_pretty(&cursor_path(repo_root), cursor)
}

pub fn load_index(repo_root: &Path) -> Index {
    std::fs::read_to_string(index_path(repo_root))
        .ok()
        .and_then(|s| serde_json::from_str(&s).ok())
        .unwrap_or_default()
}

pub fn save_index(repo_root: &Path, index: &Index) -> Result<(), String> {
    crate::fs_atomic::write_json_pretty(&index_path(repo_root), index)
}

/// Insert or replace a listing. Newer publishes of the same bundle by
/// the same publisher key replace the old listing (one live version
/// per publisher per bundle keeps the browser sane).
pub fn upsert_listing(index: &mut Index, listing: Listing) {
    index.listings.retain(|l| {
        !(l.bundle_id == listing.bundle_id && l.publisher.key_id == listing.publisher.key_id)
    });
    index.listings.push(listing);
    index.listings.sort_by(|a, b| b.ts.cmp(&a.ts));
}

/// Remove a listing, honored only when the remover matches the
/// publisher (checked by the caller against key_id/device_id).
pub fn remove_listing(index: &mut Index, publish_id: &str) -> Option<Listing> {
    let pos = index.listings.iter().position(|l| l.publish_id == publish_id)?;
    Some(index.listings.remove(pos))
}

pub fn write_blob(repo_root: &Path, publish_id: &str, gz: &[u8]) -> Result<(), String> {
    crate::fs_atomic::write_bytes(&blob_path(repo_root, publish_id), gz)
}

pub fn read_blob(repo_root: &Path, publish_id: &str) -> Result<Vec<u8>, String> {
    std::fs::read(blob_path(repo_root, publish_id))
        .map_err(|e| format!("archive blob missing for {publish_id}: {e}"))
}

/// Everything needed to assemble + list an in-flight publish. Written
/// when chunk 0 (the manifest carrier) arrives; chunks can land in any
/// order across polls.
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct PendingMeta {
    pub listing: Listing,
    pub chunk_count: usize,
}

pub fn save_pending_meta(
    repo_root: &Path,
    publish_id: &str,
    meta: &PendingMeta,
) -> Result<(), String> {
    let dir = pending_dir(repo_root, publish_id);
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    crate::fs_atomic::write_json_pretty(&dir.join("meta.json"), meta)
}

pub fn load_pending_meta(repo_root: &Path, publish_id: &str) -> Option<PendingMeta> {
    let raw =
        std::fs::read_to_string(pending_dir(repo_root, publish_id).join("meta.json")).ok()?;
    serde_json::from_str(&raw).ok()
}

/// Stash one chunk of an in-flight publish.
pub fn save_part(
    repo_root: &Path,
    publish_id: &str,
    chunk_index: usize,
    b64: &str,
) -> Result<(), String> {
    let dir = pending_dir(repo_root, publish_id);
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    crate::fs_atomic::write_bytes(&dir.join(format!("{chunk_index}.part")), b64.as_bytes())
}

/// Load every stashed chunk for a publish as (index, b64) pairs.
pub fn load_parts(repo_root: &Path, publish_id: &str) -> Vec<(usize, String)> {
    let dir = pending_dir(repo_root, publish_id);
    let Ok(entries) = std::fs::read_dir(&dir) else {
        return Vec::new();
    };
    let mut parts = Vec::new();
    for entry in entries.flatten() {
        let name = entry.file_name().to_string_lossy().into_owned();
        let Some(stem) = name.strip_suffix(".part") else {
            continue;
        };
        let Ok(idx) = stem.parse::<usize>() else {
            continue;
        };
        if let Ok(b64) = std::fs::read_to_string(entry.path()) {
            parts.push((idx, b64));
        }
    }
    parts
}

/// Drop the pending dir once a publish is complete (or abandoned).
pub fn clear_parts(repo_root: &Path, publish_id: &str) {
    let _ = std::fs::remove_dir_all(pending_dir(repo_root, publish_id));
}

/// GC pending dirs whose newest file is older than `max_age` — a
/// publisher went offline mid-publish and the chunks will never
/// complete. Returns how many dirs were dropped.
pub fn gc_pending(repo_root: &Path, max_age: std::time::Duration) -> usize {
    let pending = exchange_root(repo_root).join("pending");
    let Ok(entries) = std::fs::read_dir(&pending) else {
        return 0;
    };
    let now = std::time::SystemTime::now();
    let mut dropped = 0;
    for entry in entries.flatten() {
        let dir = entry.path();
        if !dir.is_dir() {
            continue;
        }
        // Newest mtime across the dir's files — chunks may keep arriving
        // across polls, so any fresh part keeps the publish alive.
        let newest = std::fs::read_dir(&dir)
            .ok()
            .into_iter()
            .flatten()
            .flatten()
            .filter_map(|f| f.metadata().ok().and_then(|m| m.modified().ok()))
            .max()
            .or_else(|| entry.metadata().ok().and_then(|m| m.modified().ok()));
        let Some(newest) = newest else { continue };
        let stale = now
            .duration_since(newest)
            .map(|age| age > max_age)
            .unwrap_or(false); // future mtime (clock skew) → keep
        if stale && std::fs::remove_dir_all(&dir).is_ok() {
            dropped += 1;
        }
    }
    dropped
}

#[cfg(test)]
mod tests {
    use super::*;

    fn demo_publisher(key_id: &str) -> ExchangePublisher {
        ExchangePublisher {
            key_id: key_id.into(),
            public_key_b64: "cHVi".into(),
            label: "Acme".into(),
            device_id: "dev-1".into(),
            display: "Ada".into(),
        }
    }

    fn demo_listing(publish_id: &str, bundle_id: &str, key_id: &str, ts: i64) -> Listing {
        Listing {
            publish_id: publish_id.into(),
            bundle_id: bundle_id.into(),
            version: "1.0.0".into(),
            name: "Demo".into(),
            description: String::new(),
            capabilities: vec!["ui:toast".into()],
            publisher: demo_publisher(key_id),
            archive_sha256: "feed".into(),
            ts,
        }
    }

    #[test]
    fn cursor_and_index_roundtrip() {
        let tmp = tempfile::tempdir().unwrap();
        assert_eq!(load_cursor(tmp.path()).last_seq, 0);
        save_cursor(tmp.path(), &SyncCursor { last_seq: 42 }).unwrap();
        assert_eq!(load_cursor(tmp.path()).last_seq, 42);

        let mut index = load_index(tmp.path());
        assert!(index.listings.is_empty());
        upsert_listing(&mut index, demo_listing("p1", "@a/x", "k1", 10));
        save_index(tmp.path(), &index).unwrap();
        assert_eq!(load_index(tmp.path()).listings.len(), 1);
    }

    #[test]
    fn upsert_replaces_same_bundle_same_key_only() {
        let mut index = Index::default();
        upsert_listing(&mut index, demo_listing("p1", "@a/x", "k1", 10));
        // Same bundle, same key → replaces.
        upsert_listing(&mut index, demo_listing("p2", "@a/x", "k1", 20));
        assert_eq!(index.listings.len(), 1);
        assert_eq!(index.listings[0].publish_id, "p2");
        // Same bundle, DIFFERENT key → coexists (no hijack-by-replace).
        upsert_listing(&mut index, demo_listing("p3", "@a/x", "k2", 30));
        assert_eq!(index.listings.len(), 2);
        assert_eq!(index.listings[0].publish_id, "p3"); // newest first
    }

    #[test]
    fn parts_roundtrip_and_clear() {
        let tmp = tempfile::tempdir().unwrap();
        save_part(tmp.path(), "pub-1", 1, "BB").unwrap();
        save_part(tmp.path(), "pub-1", 0, "AA").unwrap();
        let mut parts = load_parts(tmp.path(), "pub-1");
        parts.sort_by_key(|(i, _)| *i);
        assert_eq!(parts, vec![(0, "AA".into()), (1, "BB".into())]);
        clear_parts(tmp.path(), "pub-1");
        assert!(load_parts(tmp.path(), "pub-1").is_empty());
    }

    #[test]
    fn wire_ids_cannot_escape_store_dirs() {
        let tmp = tempfile::tempdir().unwrap();
        let evil = "../../escape";
        let blob = blob_path(tmp.path(), evil);
        assert!(blob.starts_with(exchange_root(tmp.path())));
        assert!(!blob.to_string_lossy().contains(".."));
        save_part(tmp.path(), evil, 0, "x").unwrap();
        // Sanitized name lands INSIDE pending/, not above the repo.
        assert!(exchange_root(tmp.path()).join("pending").exists());
    }

    #[test]
    fn blob_roundtrip() {
        let tmp = tempfile::tempdir().unwrap();
        write_blob(tmp.path(), "pub-9", b"gzbytes").unwrap();
        assert_eq!(read_blob(tmp.path(), "pub-9").unwrap(), b"gzbytes");
        assert!(read_blob(tmp.path(), "missing").is_err());
    }

    #[test]
    fn gc_drops_stale_pending_keeps_fresh() {
        let tmp = tempfile::tempdir().unwrap();
        save_part(tmp.path(), "fresh", 0, "AA").unwrap();
        save_part(tmp.path(), "stale", 0, "BB").unwrap();
        // Zero max-age: everything written "now" is already older than 0,
        // so both qualify — prove the sweep actually removes dirs.
        assert_eq!(gc_pending(tmp.path(), std::time::Duration::ZERO), 2);
        assert!(load_parts(tmp.path(), "fresh").is_empty());
        // Generous max-age: a just-written publish survives.
        save_part(tmp.path(), "fresh", 0, "AA").unwrap();
        assert_eq!(
            gc_pending(tmp.path(), std::time::Duration::from_secs(3600)),
            0
        );
        assert_eq!(load_parts(tmp.path(), "fresh").len(), 1);
        // Missing pending dir → quiet no-op.
        let empty = tempfile::tempdir().unwrap();
        assert_eq!(gc_pending(empty.path(), std::time::Duration::ZERO), 0);
    }
}
