//! CLI-side CRDT session (plan W4).
//!
//! One `yrs::Doc` per (branch, kind, file_path, function_name?). Loaded
//! lazily on first edit or first inbound op. Persisted to disk under
//! `.aura/crdt/<doc_key>.bin` as an encoded full-state update so restarts
//! don't have to replay the full server op log. LRU cap 200 in-memory.

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::Mutex;

use base64::Engine as _;
use serde::{Deserialize, Serialize};
use yrs::{
    updates::decoder::Decode, updates::encoder::Encode, Doc, GetString, ReadTxn, StateVector,
    Text, TextRef, Transact, Update,
};

use crate::config::ConfigManager;
use crate::crdt_kind::{classify, kind_str, CrdtKind};

const LRU_CAP: usize = 200;

pub type DocKey = String;

pub fn doc_key(branch: &str, kind: CrdtKind, file_path: &str, function: Option<&str>) -> DocKey {
    format!(
        "{}::{}::{}::{}",
        branch,
        kind_str(kind),
        file_path,
        function.unwrap_or("")
    )
}

fn store_dir() -> PathBuf {
    PathBuf::from(".aura/crdt")
}

fn store_path(key: &DocKey) -> PathBuf {
    // Hash the key so ':' and '/' don't break filesystems.
    let mut h = std::collections::hash_map::DefaultHasher::new();
    use std::hash::{Hash, Hasher};
    key.hash(&mut h);
    store_dir().join(format!("{:016x}.bin", h.finish()))
}

fn atomic_write(path: &Path, bytes: &[u8]) -> std::io::Result<()> {
    if let Some(p) = path.parent() {
        std::fs::create_dir_all(p)?;
    }
    let tmp = path.with_extension("bin.tmp");
    std::fs::write(&tmp, bytes)?;
    std::fs::rename(&tmp, path)
}

/// Length in bytes of the longest common prefix of `a` and `b`, snapped down
/// to a char boundary valid in both. yrs runs with `OffsetKind::Bytes`, so
/// callers feed these byte offsets straight to `Text::insert`/`remove_range`.
fn common_prefix_bytes(a: &str, b: &str) -> usize {
    let (ab, bb) = (a.as_bytes(), b.as_bytes());
    let max = ab.len().min(bb.len());
    let mut i = 0;
    while i < max && ab[i] == bb[i] {
        i += 1;
    }
    while i > 0 && (!a.is_char_boundary(i) || !b.is_char_boundary(i)) {
        i -= 1;
    }
    i
}

/// Length in bytes of the longest common suffix of `a` and `b`, not consuming
/// more than `cap` bytes (reserve the already-matched prefix) and snapped down
/// to a char boundary valid in both.
fn common_suffix_bytes(a: &str, b: &str, cap: usize) -> usize {
    let (ab, bb) = (a.as_bytes(), b.as_bytes());
    let max = cap.min(ab.len()).min(bb.len());
    let mut i = 0;
    while i < max && ab[ab.len() - 1 - i] == bb[bb.len() - 1 - i] {
        i += 1;
    }
    while i > 0 && (!a.is_char_boundary(a.len() - i) || !b.is_char_boundary(b.len() - i)) {
        i -= 1;
    }
    i
}

pub struct CrdtSession {
    // ordered LRU — most-recently-used at the back.
    docs: Mutex<Vec<(DocKey, Doc)>>,
}

impl CrdtSession {
    pub fn new() -> Self {
        Self {
            docs: Mutex::new(Vec::with_capacity(LRU_CAP)),
        }
    }

    fn take(&self, key: &DocKey) -> Option<Doc> {
        let mut docs = self.docs.lock().ok()?;
        if let Some(pos) = docs.iter().position(|(k, _)| k == key) {
            let (_, d) = docs.remove(pos);
            Some(d)
        } else {
            None
        }
    }

    fn put(&self, key: DocKey, doc: Doc) {
        let Ok(mut docs) = self.docs.lock() else { return };
        docs.push((key, doc));
        while docs.len() > LRU_CAP {
            docs.remove(0);
        }
    }

    /// Load doc from disk snapshot if present, else fresh.
    fn load_or_new(&self, key: &DocKey) -> Doc {
        let doc = Doc::new();
        let path = store_path(key);
        if let Ok(bytes) = std::fs::read(&path) {
            if let Ok(update) = Update::decode_v1(&bytes) {
                let mut txn = doc.transact_mut();
                let _ = txn.apply_update(update);
            }
        }
        doc
    }

    fn text<'a>(doc: &'a Doc) -> TextRef {
        doc.get_or_insert_text("content")
    }

    fn persist(key: &DocKey, doc: &Doc) {
        let txn = doc.transact();
        let bytes = txn.encode_state_as_update_v1(&StateVector::default());
        let _ = atomic_write(&store_path(key), &bytes);
    }

    /// Reconcile disk text into the CRDT (user may have hand-edited the
    /// file outside Aura). Returns the update that captures the diff,
    /// base64-encoded, or None if no change.
    pub fn ingest_disk(
        &self,
        branch: &str,
        file_path: &str,
        disk_text: &str,
    ) -> Option<CrdtUpdate> {
        let path = Path::new(file_path);
        if !crate::crdt_kind::is_crdt_eligible(path) {
            return None;
        }
        let kind = classify(path);
        let key = doc_key(branch, kind, file_path, None);

        let doc = self.take(&key).unwrap_or_else(|| self.load_or_new(&key));
        let before_sv;
        let update_bytes;
        let state_vector;
        {
            let text = Self::text(&doc);
            let mut txn = doc.transact_mut();
            before_sv = txn.state_vector();
            let current = text.get_string(&txn);
            if current == disk_text {
                drop(txn);
                self.put(key, doc);
                return None;
            }
            // Minimal-diff splice: only the changed middle span is touched, so
            // two peers editing disjoint regions of the same file produce
            // non-overlapping CRDT ops that merge without duplicating the
            // untouched text. (A full-replace would delete+reinsert the whole
            // file on every edit, and concurrent full-replaces concatenate.)
            //
            // Trim the common prefix and suffix, then replace the differing
            // middle: remove `current`'s middle, insert `disk_text`'s middle.
            let prefix = common_prefix_bytes(&current, disk_text);
            let cap = current.len().min(disk_text.len()) - prefix;
            let suffix = common_suffix_bytes(&current, disk_text, cap);
            let remove_len = current.len() - prefix - suffix;
            if remove_len > 0 {
                text.remove_range(&mut txn, prefix as u32, remove_len as u32);
            }
            let inserted = &disk_text[prefix..disk_text.len() - suffix];
            if !inserted.is_empty() {
                text.insert(&mut txn, prefix as u32, inserted);
            }
            update_bytes = txn.encode_state_as_update_v1(&before_sv);
            state_vector = txn.state_vector().encode_v1();
        }
        Self::persist(&key, &doc);
        self.put(key.clone(), doc);

        Some(CrdtUpdate {
            key,
            kind: kind_str(kind).to_string(),
            file_path: file_path.to_string(),
            function_name: None,
            update_b64: base64::engine::general_purpose::STANDARD.encode(&update_bytes),
            state_vector_b64: base64::engine::general_purpose::STANDARD.encode(&state_vector),
        })
    }

    /// Apply an inbound update. Returns the new materialised text if it
    /// changed — caller writes to disk via atomic tmp+rename.
    pub fn apply_inbound(
        &self,
        branch: &str,
        file_path: &str,
        update_b64: &str,
    ) -> Option<String> {
        let bytes = base64::engine::general_purpose::STANDARD
            .decode(update_b64)
            .ok()?;
        let path = Path::new(file_path);
        let kind = classify(path);
        let key = doc_key(branch, kind, file_path, None);

        let doc = self.take(&key).unwrap_or_else(|| self.load_or_new(&key));
        let new_text = {
            let text = Self::text(&doc);
            let mut txn = doc.transact_mut();
            let update = Update::decode_v1(&bytes).ok()?;
            let _ = txn.apply_update(update);
            text.get_string(&txn)
        };
        Self::persist(&key, &doc);
        self.put(key, doc);
        Some(new_text)
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CrdtUpdate {
    pub key: DocKey,
    pub kind: String,
    pub file_path: String,
    pub function_name: Option<String>,
    pub update_b64: String,
    pub state_vector_b64: String,
}

/// HTTP push of a CRDT update to the cloud.
pub fn push_update(branch: &str, update: &CrdtUpdate) -> Result<(), String> {
    let cfg = ConfigManager::load();
    let url = cfg.cloud_url.ok_or("not connected")?;
    let token = cfg
        .cloud_api_token
        .or_else(|| std::env::var("AURA_CLOUD_TOKEN").ok())
        .ok_or("no cloud token")?;
    let repo = crate::live_events::repo_name();
    let body = serde_json::json!({
        "repo": repo,
        "branch": branch,
        "kind": update.kind,
        "file_path": update.file_path,
        "function_name": update.function_name,
        "update_b64": update.update_b64,
        "state_vector_b64": update.state_vector_b64,
    });
    let c = reqwest::blocking::Client::builder()
        .timeout(std::time::Duration::from_secs(20))
        .build()
        .map_err(|e| format!("http: {}", e))?;
    let resp = c
        .post(format!("{}/api/v2/crdt/push", url))
        .header("Authorization", format!("Bearer {}", token))
        .json(&body)
        .send()
        .map_err(|e| format!("network: {}", e))?;
    if !resp.status().is_success() {
        return Err(format!("HTTP {}", resp.status()));
    }
    Ok(())
}

/// HTTP pull of new ops for a repo+branch (cursor-paginated).
pub fn pull_ops(branch: &str, since: i64) -> Result<(Vec<PulledOp>, i64), String> {
    let cfg = ConfigManager::load();
    let url = cfg.cloud_url.ok_or("not connected")?;
    let token = cfg
        .cloud_api_token
        .or_else(|| std::env::var("AURA_CLOUD_TOKEN").ok())
        .ok_or("no cloud token")?;
    let repo = crate::live_events::repo_name();
    let c = reqwest::blocking::Client::builder()
        .timeout(std::time::Duration::from_secs(20))
        .build()
        .map_err(|e| format!("http: {}", e))?;
    let resp = c
        .get(format!(
            "{}/api/v2/crdt/pull?repo={}&branch={}&since={}",
            url, repo, branch, since
        ))
        .header("Authorization", format!("Bearer {}", token))
        .send()
        .map_err(|e| format!("network: {}", e))?;
    if !resp.status().is_success() {
        return Err(format!("HTTP {}", resp.status()));
    }
    let v: serde_json::Value = resp.json().map_err(|e| format!("parse: {}", e))?;
    let cursor = v["cursor"].as_i64().unwrap_or(since);
    let ops: Vec<PulledOp> = v["ops"]
        .as_array()
        .cloned()
        .unwrap_or_default()
        .into_iter()
        .filter_map(|o| serde_json::from_value(o).ok())
        .collect();
    Ok((ops, cursor))
}

#[derive(Debug, Clone, Deserialize)]
pub struct PulledOp {
    pub op_id: i64,
    pub doc_id: String,
    pub update_b64: String,
    #[serde(default)]
    pub kind: String,
    #[serde(default)]
    pub file_path: String,
    #[serde(default)]
    pub function_name: Option<String>,
}

/// Persist cursor state for pull loop.
fn cursor_path() -> PathBuf {
    PathBuf::from(".aura/crdt/cursor.json")
}

#[derive(Debug, Default, Serialize, Deserialize)]
pub struct CrdtCursors {
    pub by_branch: HashMap<String, i64>,
}

pub fn load_cursors() -> CrdtCursors {
    std::fs::read_to_string(cursor_path())
        .ok()
        .and_then(|s| serde_json::from_str(&s).ok())
        .unwrap_or_default()
}

pub fn save_cursors(c: &CrdtCursors) {
    if let Ok(s) = serde_json::to_string(c) {
        let _ = atomic_write(&cursor_path(), s.as_bytes());
    }
}

#[cfg(test)]
mod tests {
    //! Hermetic whole-file CRDT sync tests — no server, no network.
    //!
    //! These drive the real merge path (`CrdtSession::ingest_disk` +
    //! `apply_inbound`) as two independent peers. Each peer is a separate
    //! `CrdtSession` rooted at its own temp working directory; the
    //! cwd-relative `.aura/crdt` store (`store_dir`) keeps their on-disk
    //! state independent, exactly like two checkouts on two machines. The
    //! update payloads are exchanged in-memory via the returned `CrdtUpdate`,
    //! which is how the daemon ships them over the wire.

    use super::*;

    // Tests here mutate the process cwd; serialize against every other
    // cwd-mutating test in the crate via the shared lock.
    use crate::TEST_CWD_LOCK as SERIAL;

    /// Restores the process cwd on drop so a panicking assertion can't leak
    /// a changed directory into the next serialized test.
    struct CwdGuard(PathBuf);
    impl CwdGuard {
        fn capture() -> Self {
            CwdGuard(std::env::current_dir().expect("cwd"))
        }
    }
    impl Drop for CwdGuard {
        fn drop(&mut self) {
            let _ = std::env::set_current_dir(&self.0);
        }
    }

    fn cd(p: &Path) {
        std::env::set_current_dir(p).expect("set cwd");
    }

    const BRANCH: &str = "main";

    /// Two peers edit different regions of the same file concurrently — one a
    /// function body (AST region), one the import line (non-AST region) — and
    /// the merge converges with neither edit lost. This is the property plain
    /// git can't give without surfacing a conflict.
    #[test]
    fn whole_file_concurrent_edits_converge_without_loss() {
        let _lk = SERIAL.lock().unwrap_or_else(|e| e.into_inner());
        let _restore = CwdGuard::capture();

        let dir_a = tempfile::tempdir().expect("tmp a");
        let dir_b = tempfile::tempdir().expect("tmp b");
        let a = CrdtSession::new();
        let b = CrdtSession::new();
        let file = "src/lib.rs";

        // Shared base: peer A authors T0, peer B receives it.
        let base = "use std::io;\n\nfn login() {}\n\nfn logout() {}\n";
        cd(dir_a.path());
        let u0 = a.ingest_disk(BRANCH, file, base).expect("base update");
        cd(dir_b.path());
        b.apply_inbound(BRANCH, file, &u0.update_b64)
            .expect("base applied on B");

        // Concurrent, non-overlapping edits.
        let edit_a = "use std::io;\n\nfn login() { /*MARKER_A*/ }\n\nfn logout() {}\n";
        let edit_b = "use std::io; /*MARKER_B*/\n\nfn login() {}\n\nfn logout() {}\n";
        cd(dir_a.path());
        let ua = a.ingest_disk(BRANCH, file, edit_a).expect("edit a");
        cd(dir_b.path());
        let ub = b.ingest_disk(BRANCH, file, edit_b).expect("edit b");

        // Exchange the concurrent updates.
        cd(dir_a.path());
        let final_a = a
            .apply_inbound(BRANCH, file, &ub.update_b64)
            .expect("A applies B");
        cd(dir_b.path());
        let final_b = b
            .apply_inbound(BRANCH, file, &ua.update_b64)
            .expect("B applies A");

        // Core CRDT guarantee: both peers converge to identical bytes.
        assert_eq!(final_a, final_b, "peers diverged after concurrent edits");
        // Neither region's edit was silently dropped on merge.
        assert!(
            final_a.contains("MARKER_A"),
            "lost peer A's edit: {final_a:?}"
        );
        assert!(
            final_a.contains("MARKER_B"),
            "lost peer B's edit: {final_a:?}"
        );
        // And nothing was duplicated: a full-replace reconcile would delete
        // the whole base and re-insert it twice (once per peer), doubling the
        // untouched regions. A minimal diff touches only the changed span, so
        // each unchanged anchor must still appear exactly once.
        assert_eq!(
            final_a.matches("fn logout").count(),
            1,
            "untouched region duplicated on merge: {final_a:?}"
        );
        assert_eq!(
            final_a.matches("use std::io").count(),
            1,
            "import line duplicated on merge: {final_a:?}"
        );
    }

    /// Edits adjacent to multi-byte characters must not split a UTF-8 scalar
    /// when the diff computes byte offsets for yrs (`OffsetKind::Bytes`). A bad
    /// offset would panic inside `remove_range`/`insert`; this proves the
    /// char-boundary backoff holds and the peers still converge.
    #[test]
    fn unicode_edits_stay_on_char_boundaries() {
        let _lk = SERIAL.lock().unwrap_or_else(|e| e.into_inner());
        let _restore = CwdGuard::capture();

        let dir_a = tempfile::tempdir().expect("tmp a");
        let dir_b = tempfile::tempdir().expect("tmp b");
        let a = CrdtSession::new();
        let b = CrdtSession::new();
        let file = "src/i18n.rs";

        // Base packed with multi-byte scalars (accents, em dash, CJK, emoji).
        let base = "// café — 日本語 🦀\nfn greet() {}\nfn farewell() {}\n";
        cd(dir_a.path());
        let u0 = a.ingest_disk(BRANCH, file, base).expect("base");
        cd(dir_b.path());
        b.apply_inbound(BRANCH, file, &u0.update_b64).expect("base B");

        // A edits the comment (right next to multi-byte runs); B edits a body.
        let edit_a = "// café — 日本語 🦀🔥\nfn greet() {}\nfn farewell() {}\n";
        let edit_b = "// café — 日本語 🦀\nfn greet() { /*β*/ }\nfn farewell() {}\n";
        cd(dir_a.path());
        let ua = a.ingest_disk(BRANCH, file, edit_a).expect("edit a");
        cd(dir_b.path());
        let ub = b.ingest_disk(BRANCH, file, edit_b).expect("edit b");

        cd(dir_a.path());
        let final_a = a.apply_inbound(BRANCH, file, &ub.update_b64).expect("A<-B");
        cd(dir_b.path());
        let final_b = b.apply_inbound(BRANCH, file, &ua.update_b64).expect("B<-A");

        assert_eq!(final_a, final_b, "unicode peers diverged");
        assert!(final_a.contains("🔥"), "lost A's emoji edit: {final_a:?}");
        assert!(final_a.contains("/*β*/"), "lost B's edit: {final_a:?}");
        assert_eq!(
            final_a.matches("fn farewell").count(),
            1,
            "duplicated region around multi-byte text: {final_a:?}"
        );
    }

    /// Non-code files (the "non-AST, general CRDT" case) sync too.
    #[test]
    fn non_code_file_syncs() {
        let _lk = SERIAL.lock().unwrap_or_else(|e| e.into_inner());
        let _restore = CwdGuard::capture();

        let dir_a = tempfile::tempdir().expect("tmp a");
        let dir_b = tempfile::tempdir().expect("tmp b");
        let a = CrdtSession::new();
        let b = CrdtSession::new();
        let file = "docs/readme.md";
        let body = "# Title\n\nbody\n";

        cd(dir_a.path());
        let u = a.ingest_disk(BRANCH, file, body).expect("md is eligible");
        cd(dir_b.path());
        let got = b
            .apply_inbound(BRANCH, file, &u.update_b64)
            .expect("md applied on B");

        assert_eq!(got, body, "markdown did not sync");
    }
}
