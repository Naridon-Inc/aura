// W2 — provenance binding + read-time verification (AURA-40).
//
// Every `MemoryEntry` written through `MemoryManager` is stamped with WHERE
// the knowledge came from, so a future reader can decide whether to trust it:
//
//   - `source_commit`      — HEAD short sha at write time
//   - `intent_id`          — id of the LATEST `.aura/intent_log.jsonl` row at
//                            write time: the row's `signed_block_id` when the
//                            intent was signed, else `ts:<unix-secs>`
//   - `signer_key_id`      — `key_id` of that same row, when present
//   - `valid_from`         — RFC3339 timestamp of the write
//   - `source_symbol`      — optional code anchor (format below)
//   - `source_symbol_hash` — sha256 (hex) of the symbol's source text at
//                            write time
//
// # Symbol reference format
//
// `<repo-relative-path>#<identifier>` — e.g. `src/auth.rs#verify_token` or
// `aura-web/src/pages/Desktop.tsx#Desktop`. A single `#` separates the file
// path from the bare symbol identifier exactly as the AST parser reports it
// (no module / namespace qualification). This is THE one format used
// everywhere: the CLI `--symbol` flag, the MCP `symbol` argument, and the
// stored `source_symbol` field.
//
// # Read-time verification
//
// On recall, an entry carrying `source_symbol` is re-checked against the live
// code via the existing tree-sitter `SemanticParser`: if the file or symbol
// no longer exists, or the symbol's current text hashes differently from the
// stamped `source_symbol_hash`, the result is marked `stale` with a reason —
// the memory was learned from code that has since moved.
//
// Nothing in this module fabricates data: a missing repo, an empty intent
// log, or an unresolvable symbol simply leaves the corresponding field None.

use std::path::Path;

use sha2::{Digest, Sha256};

use crate::memory::{MemoryEntry, MemoryManager};
use crate::parser::SemanticParser;

/// Repo-relative path of the intent log this module reads.
const INTENT_LOG_PATH: &str = ".aura/intent_log.jsonl";

/// The write-time provenance fields shared by every memory write.
#[derive(Debug, Clone, Default)]
pub struct ProvenanceStamp {
    pub source_commit: Option<String>,
    pub intent_id: Option<String>,
    pub signer_key_id: Option<String>,
    pub valid_from: Option<String>,
}

/// Capture the full stamp for a write happening right now: HEAD short sha,
/// latest intent row reference, and the RFC3339 write timestamp. Absent data
/// stays None — never fabricated.
pub fn capture() -> ProvenanceStamp {
    let (intent_id, signer_key_id) = latest_intent_ref();
    ProvenanceStamp {
        source_commit: head_short_sha(),
        intent_id,
        signer_key_id,
        valid_from: Some(chrono::Utc::now().to_rfc3339()),
    }
}

/// HEAD short sha of the repo containing the cwd (worktree-aware via
/// `Repository::discover`). None when not in a repo or the repo has no
/// commits yet.
pub fn head_short_sha() -> Option<String> {
    let repo = git2::Repository::discover(".").ok()?;
    let commit = repo.head().ok()?.peel_to_commit().ok()?;
    if let Ok(buf) = commit.as_object().short_id() {
        if let Some(s) = buf.as_str() {
            return Some(s.to_string());
        }
    }
    // Fallback: first 7 chars of the full sha.
    Some(commit.id().to_string().chars().take(7).collect())
}

/// Reference to the LATEST row of `.aura/intent_log.jsonl`, reusing the
/// intent_query parsing + "newest wins" ordering. Returns
/// `(intent_id, signer_key_id)`.
fn latest_intent_ref() -> (Option<String>, Option<String>) {
    let rows = crate::intent_query::read_all_rows(Path::new(INTENT_LOG_PATH));
    if rows.is_empty() {
        return (None, None);
    }
    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0);
    let q = crate::intent_query::query_rows(rows, None, 0, 1, now);
    match q.entries.first() {
        Some(row) => (intent_row_id(row), row.key_id.clone()),
        None => (None, None),
    }
}

/// The id a memory stores to point back at one intent row: the signed block
/// id when the intent was signed, else a `ts:<unix-secs>` reference. Legacy
/// rows with neither a block id nor a timestamp yield None.
fn intent_row_id(row: &crate::intent_query::IntentRow) -> Option<String> {
    if let Some(bid) = &row.signed_block_id {
        return Some(bid.clone());
    }
    if row.timestamp > 0 {
        return Some(format!("ts:{}", row.timestamp));
    }
    None
}

/// Look an `intent_id` back up in the intent log. Matches `signed_block_id`
/// first, then the `ts:<secs>` form (newest row wins on a same-second tie).
pub fn lookup_intent(intent_id: &str) -> Option<crate::intent_query::IntentRow> {
    let rows = crate::intent_query::read_all_rows(Path::new(INTENT_LOG_PATH));
    rows.into_iter().rev().find(|r| {
        r.signed_block_id.as_deref() == Some(intent_id)
            || (r.timestamp > 0 && format!("ts:{}", r.timestamp) == intent_id)
    })
}

/// sha256 (hex) of a symbol's source text — the content fingerprint stored
/// in `source_symbol_hash` and recomputed at read time.
pub fn hash_symbol_text(text: &str) -> String {
    let mut hasher = Sha256::new();
    hasher.update(text.as_bytes());
    hex::encode(hasher.finalize())
}

/// Split a `<path>#<identifier>` reference. Returns None when the `#` or
/// either side is missing — such a reference is stored but unverifiable.
pub fn parse_symbol_ref(s: &str) -> Option<(String, String)> {
    let (file, name) = s.rsplit_once('#')?;
    let (file, name) = (file.trim(), name.trim());
    if file.is_empty() || name.is_empty() {
        return None;
    }
    Some((file.to_string(), name.to_string()))
}

/// Outcome of resolving a symbol reference against the live tree.
pub enum SymbolLookup {
    /// Symbol found — carries its current source text.
    Found(String),
    /// The referenced file no longer exists.
    FileMissing,
    /// File exists but the identifier is no longer defined in it.
    SymbolMissing,
    /// File exists but could not be parsed (unsupported extension, parse
    /// failure) — verification is inconclusive, NOT stale.
    Unverifiable(String),
}

/// Resolve `file` + `name` via the AST parser and return the symbol's
/// current source text.
pub fn locate_symbol_text(parser: &mut SemanticParser, file: &str, name: &str) -> SymbolLookup {
    let path = Path::new(file);
    let source = match std::fs::read_to_string(path) {
        Ok(s) => s,
        Err(_) => return SymbolLookup::FileMissing,
    };
    let ext = match path.extension().and_then(|e| e.to_str()) {
        Some(e) => e.to_string(),
        None => return SymbolLookup::Unverifiable(format!("{} has no file extension", file)),
    };
    match parser.retrieve_node_source(&source, &ext, name) {
        Ok(Some((text, _range))) => SymbolLookup::Found(text),
        Ok(None) => SymbolLookup::SymbolMissing,
        Err(e) => SymbolLookup::Unverifiable(format!("could not parse {}: {}", file, e)),
    }
}

/// Write-time symbol stamping: normalize the reference and, when it resolves
/// to live code, fingerprint the symbol's current text. The reference is
/// stored even when unresolvable (the caller said the fact is about that
/// symbol); only the hash is withheld — never fabricated.
/// Returns `(source_symbol, source_symbol_hash)`.
pub fn stamp_symbol(symbol: &str) -> (Option<String>, Option<String>) {
    let sym = symbol.trim();
    if sym.is_empty() {
        return (None, None);
    }
    let stored = Some(sym.to_string());
    let Some((file, name)) = parse_symbol_ref(sym) else {
        return (stored, None);
    };
    let mut parser = match SemanticParser::new() {
        Ok(p) => p,
        Err(_) => return (stored, None),
    };
    match locate_symbol_text(&mut parser, &file, &name) {
        SymbolLookup::Found(text) => (stored, Some(hash_symbol_text(&text))),
        _ => (stored, None),
    }
}

/// Read-time verdict for one provenance-bound entry.
#[derive(Debug, Clone, PartialEq)]
pub struct Staleness {
    /// True when the source symbol changed or disappeared since stamping.
    pub stale: bool,
    /// False when the check was inconclusive (no hash stamped, unparseable
    /// file, malformed reference) — `stale` is then always false too.
    pub verified: bool,
    pub reason: Option<String>,
}

impl Staleness {
    fn fresh() -> Self {
        Self { stale: false, verified: true, reason: None }
    }
    fn stale_because(reason: String) -> Self {
        Self { stale: true, verified: true, reason: Some(reason) }
    }
    fn unverifiable(reason: String) -> Self {
        Self { stale: false, verified: false, reason: Some(reason) }
    }
}

/// Verify one entry against the live tree, building a throwaway parser.
/// Returns None when the entry carries no `source_symbol` (nothing to check).
pub fn verify_entry(entry: &MemoryEntry) -> Option<Staleness> {
    entry.source_symbol.as_deref()?;
    match SemanticParser::new() {
        Ok(mut parser) => verify_entry_with_parser(entry, &mut parser),
        Err(e) => Some(Staleness::unverifiable(format!("parser unavailable: {}", e))),
    }
}

/// Same as `verify_entry` but with a caller-owned parser so a search over
/// many results builds the (13-grammar) parser once.
pub fn verify_entry_with_parser(
    entry: &MemoryEntry,
    parser: &mut SemanticParser,
) -> Option<Staleness> {
    let sym = entry.source_symbol.as_deref()?;
    Some(verify_symbol(
        parser,
        sym,
        entry.source_symbol_hash.as_deref(),
        entry.source_commit.as_deref(),
    ))
}

/// The core check: resolve the reference, compare content hashes.
pub fn verify_symbol(
    parser: &mut SemanticParser,
    symbol_ref: &str,
    stamped_hash: Option<&str>,
    source_commit: Option<&str>,
) -> Staleness {
    let Some((file, name)) = parse_symbol_ref(symbol_ref) else {
        return Staleness::unverifiable(format!(
            "symbol reference '{}' is not in <path>#<identifier> form",
            symbol_ref
        ));
    };
    let since = source_commit.unwrap_or("it was stamped");
    match locate_symbol_text(parser, &file, &name) {
        SymbolLookup::FileMissing => Staleness::stale_because(format!(
            "symbol removed — {} no longer exists (stamped at {})",
            file, since
        )),
        SymbolLookup::SymbolMissing => Staleness::stale_because(format!(
            "symbol removed — '{}' is no longer defined in {} (stamped at {})",
            name, file, since
        )),
        SymbolLookup::Unverifiable(why) => Staleness::unverifiable(why),
        SymbolLookup::Found(text) => match stamped_hash {
            None => Staleness::unverifiable(
                "no content hash was stamped at write time".to_string(),
            ),
            Some(h) if h == hash_symbol_text(&text) => Staleness::fresh(),
            Some(_) => Staleness::stale_because(format!("symbol changed since {}", since)),
        },
    }
}

// ── `aura memory why <id>` ──

/// Structured provenance report for one memory: the fact, its stamp, the
/// intent it was written under, and a live staleness check. JSON form —
/// the prose renderer below builds from this so the two can't disagree.
pub fn why_json(id: &str) -> Result<serde_json::Value, String> {
    let (section, entry) = MemoryManager::find_entry(id)
        .ok_or_else(|| format!("No memory entry with id '{}'.", id))?;

    let mut v = serde_json::json!({
        "id": entry.id,
        "section": section,
        "content": entry.content,
        "tags": entry.tags,
        "added_by": entry.added_by,
        "added_at": entry.added_at,
    });
    if let Some(c) = &entry.source_commit {
        v["source_commit"] = serde_json::json!(c);
    }
    if let Some(s) = &entry.source_symbol {
        v["source_symbol"] = serde_json::json!(s);
    }
    if let Some(k) = &entry.signer_key_id {
        v["signer_key_id"] = serde_json::json!(k);
    }
    if let Some(f) = &entry.valid_from {
        v["valid_from"] = serde_json::json!(f);
    }
    if let Some(t) = &entry.valid_to {
        v["valid_to"] = serde_json::json!(t);
        v["superseded"] = serde_json::json!(true);
    }
    // W3 — supersession chain: what this entry replaced, who replaced it,
    // and the whole oldest→newest lineage when there is one.
    {
        let mem = MemoryManager::load();
        if let Some(s) = &entry.supersedes {
            v["supersedes"] = serde_json::json!(s);
        }
        if let Some(heir) = crate::memory::reconcile::superseded_by(&mem, &entry.id) {
            v["superseded_by"] = serde_json::json!(heir);
        }
        let chain = crate::memory::reconcile::supersession_chain(&mem, &entry.id);
        if chain.len() > 1 {
            v["supersession_chain"] = serde_json::json!(chain);
        }
    }
    if let Some(iid) = &entry.intent_id {
        v["intent_id"] = serde_json::json!(iid);
        if let Some(row) = lookup_intent(iid) {
            v["intent"] = serde_json::json!(row.intent);
            v["intent_agent"] = serde_json::json!(row.agent_id);
            if let Some(t) = &row.intent_type {
                v["intent_type"] = serde_json::json!(t);
            }
        }
    }
    if let Some(staleness) = verify_entry(&entry) {
        v["stale"] = serde_json::json!(staleness.stale);
        v["verified"] = serde_json::json!(staleness.verified);
        if let Some(r) = &staleness.reason {
            v["stale_reason"] = serde_json::json!(r);
        }
    }
    Ok(v)
}

/// Human-readable rendering of `why_json` for the CLI.
pub fn why_report(id: &str) -> Result<String, String> {
    let v = why_json(id)?;
    let mut out = String::new();

    let added_at = v["added_at"].as_u64().unwrap_or(0);
    let when = chrono::DateTime::from_timestamp(added_at as i64, 0)
        .map(|d| d.to_rfc3339())
        .unwrap_or_else(|| added_at.to_string());
    out.push_str(&format!(
        "{} [{}] — added by {} @ {}\n",
        v["id"].as_str().unwrap_or(id),
        v["section"].as_str().unwrap_or("?"),
        v["added_by"].as_str().unwrap_or("unknown"),
        when,
    ));
    out.push_str(&format!("  \"{}\"\n", v["content"].as_str().unwrap_or("")));
    let tags: Vec<&str> = v["tags"]
        .as_array()
        .map(|a| a.iter().filter_map(|t| t.as_str()).collect())
        .unwrap_or_default();
    if !tags.is_empty() {
        out.push_str(&format!("  tags: {}\n", tags.join(", ")));
    }

    out.push_str("\n  provenance\n");
    let field = |label: &str, key: &str, v: &serde_json::Value| -> Option<String> {
        v[key].as_str().map(|s| format!("    {:<8} {}\n", label, s))
    };
    let mut any = false;
    for (label, key) in [
        ("commit:", "source_commit"),
        ("symbol:", "source_symbol"),
        ("signer:", "signer_key_id"),
    ] {
        if let Some(line) = field(label, key, &v) {
            out.push_str(&line);
            any = true;
        }
    }
    if let Some(iid) = v["intent_id"].as_str() {
        match v["intent"].as_str() {
            Some(text) => out.push_str(&format!("    {:<8} \"{}\" (id {})\n", "intent:", text, iid)),
            None => out.push_str(&format!(
                "    {:<8} (id {} — not found in {})\n",
                "intent:", iid, INTENT_LOG_PATH
            )),
        }
        any = true;
    }
    if let Some(from) = v["valid_from"].as_str() {
        let to = v["valid_to"].as_str().unwrap_or("open");
        out.push_str(&format!("    {:<8} {} → {}\n", "valid:", from, to));
        any = true;
    }
    if !any {
        out.push_str("    (none recorded — entry predates provenance stamping)\n");
    }

    // W3 — supersession lineage. A superseded entry renders its full
    // oldest→newest chain so the reader can follow the fact's history.
    if v["supersedes"].as_str().is_some()
        || v["superseded_by"].as_str().is_some()
        || v["supersession_chain"].as_array().is_some()
    {
        out.push_str("\n  supersession\n");
        if let Some(s) = v["supersedes"].as_str() {
            out.push_str(&format!("    {:<12} {}\n", "supersedes:", s));
        }
        if let Some(s) = v["superseded_by"].as_str() {
            out.push_str(&format!("    {:<12} {} (this entry is no longer current)\n", "replaced by:", s));
        }
        if let Some(chain) = v["supersession_chain"].as_array() {
            let ids: Vec<&str> = chain.iter().filter_map(|c| c.as_str()).collect();
            let this_id = v["id"].as_str().unwrap_or("");
            let rendered: Vec<String> = ids
                .iter()
                .map(|i| if *i == this_id { format!("[{}]", i) } else { i.to_string() })
                .collect();
            out.push_str(&format!("    {:<12} {}\n", "chain:", rendered.join(" → ")));
        }
    }

    match (v.get("stale").and_then(|s| s.as_bool()), v["stale_reason"].as_str()) {
        (Some(true), reason) => out.push_str(&format!(
            "    {:<8} ⚠ stale — {}\n",
            "status:",
            reason.unwrap_or("code moved")
        )),
        (Some(false), _) if v["verified"].as_bool() == Some(true) => {
            out.push_str(&format!("    {:<8} ✓ verified — symbol unchanged\n", "status:"));
        }
        (Some(false), reason) => out.push_str(&format!(
            "    {:<8} ? unverified — {}\n",
            "status:",
            reason.unwrap_or("inconclusive")
        )),
        (None, _) => {} // no source_symbol — nothing to verify
    }

    Ok(out)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::memory::ProjectMemory;

    fn stamped_entry(symbol: Option<String>, hash: Option<String>) -> MemoryEntry {
        MemoryEntry {
            id: "mem-test1".to_string(),
            content: "verify_token validates the JWT signature".to_string(),
            tags: vec!["auth".to_string()],
            added_by: "test".to_string(),
            added_at: 1_750_000_000,
            source_commit: Some("abc1234".to_string()),
            source_symbol: symbol,
            source_symbol_hash: hash,
            intent_id: Some("ts:1750000000".to_string()),
            signer_key_id: Some("key-9".to_string()),
            valid_from: Some("2026-06-11T00:00:00+00:00".to_string()),
            ..Default::default()
        }
    }

    #[test]
    fn stamp_fields_persist_round_trip_through_save_load_format() {
        // Same serialize/deserialize pair `MemoryManager::save`/`load` use
        // (serde_json pretty → from_str), exercised on a temp file.
        let mut mem = ProjectMemory::default();
        mem.gotchas.push(stamped_entry(
            Some("src/auth.rs#verify_token".to_string()),
            Some("deadbeef".to_string()),
        ));

        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("memory.json");
        std::fs::write(&path, serde_json::to_string_pretty(&mem).unwrap()).unwrap();
        let loaded: ProjectMemory =
            serde_json::from_str(&std::fs::read_to_string(&path).unwrap()).unwrap();

        let e = &loaded.gotchas[0];
        assert_eq!(e.source_commit.as_deref(), Some("abc1234"));
        assert_eq!(e.source_symbol.as_deref(), Some("src/auth.rs#verify_token"));
        assert_eq!(e.source_symbol_hash.as_deref(), Some("deadbeef"));
        assert_eq!(e.intent_id.as_deref(), Some("ts:1750000000"));
        assert_eq!(e.signer_key_id.as_deref(), Some("key-9"));
        assert_eq!(e.valid_from.as_deref(), Some("2026-06-11T00:00:00+00:00"));
        assert_eq!(e.valid_to, None);
    }

    #[test]
    fn legacy_memory_json_without_provenance_still_loads() {
        // A pre-W1/W2 file: entries carry only the original five fields.
        let legacy = r#"{
            "identity": "", "stack": [], "architecture": [], "decisions": [],
            "conventions": [],
            "gotchas": [{"id":"mem-old","content":"old fact","tags":[],"added_by":"x","added_at":5}],
            "context": [], "active_work": [], "last_updated": 5
        }"#;
        let mem: ProjectMemory = serde_json::from_str(legacy).unwrap();
        let e = &mem.gotchas[0];
        assert_eq!(e.id, "mem-old");
        assert!(e.embedding.is_none());
        assert!(e.source_commit.is_none());
        assert!(e.source_symbol.is_none());
        assert!(e.source_symbol_hash.is_none());
        assert!(e.intent_id.is_none());
        assert!(e.signer_key_id.is_none());
        assert!(e.valid_from.is_none());
        assert!(e.valid_to.is_none());
    }

    #[test]
    fn parse_symbol_ref_accepts_path_hash_identifier() {
        assert_eq!(
            parse_symbol_ref("src/auth.rs#verify_token"),
            Some(("src/auth.rs".to_string(), "verify_token".to_string()))
        );
        // rsplit: a path containing '#' keeps everything before the LAST '#'.
        assert_eq!(
            parse_symbol_ref("odd#dir/file.py#handler"),
            Some(("odd#dir/file.py".to_string(), "handler".to_string()))
        );
        assert_eq!(parse_symbol_ref("no-separator"), None);
        assert_eq!(parse_symbol_ref("#name_only"), None);
        assert_eq!(parse_symbol_ref("path/only.rs#"), None);
    }

    #[test]
    fn staleness_flips_when_symbol_text_changes() {
        let dir = tempfile::tempdir().unwrap();
        let file = dir.path().join("vault.rs");
        let file_str = file.to_string_lossy().to_string();
        std::fs::write(&file, "fn guard_gate() -> u32 {\n    let x = 41;\n    x + 1\n}\n")
            .unwrap();

        let mut parser = SemanticParser::new().expect("parser");

        // Stamp: resolve + fingerprint the symbol as `stamp_symbol` does.
        let text = match locate_symbol_text(&mut parser, &file_str, "guard_gate") {
            SymbolLookup::Found(t) => t,
            _ => panic!("symbol should resolve at stamp time"),
        };
        let stamped = hash_symbol_text(&text);
        let sym_ref = format!("{}#guard_gate", file_str);

        // Unchanged file → fresh.
        let s = verify_symbol(&mut parser, &sym_ref, Some(&stamped), Some("abc1234"));
        assert!(!s.stale, "unchanged symbol must not be stale: {:?}", s);
        assert!(s.verified);
        assert_eq!(s.reason, None);

        // Mutate the symbol body → stale, "changed since <commit>".
        std::fs::write(&file, "fn guard_gate() -> u32 {\n    let x = 100;\n    x + 1\n}\n")
            .unwrap();
        let s = verify_symbol(&mut parser, &sym_ref, Some(&stamped), Some("abc1234"));
        assert!(s.stale, "mutated symbol must be stale");
        assert!(s.verified);
        assert!(
            s.reason.as_deref().unwrap().contains("changed since abc1234"),
            "reason: {:?}",
            s.reason
        );

        // Remove the symbol (file still parses) → stale, "removed".
        std::fs::write(&file, "fn other_fn() -> u32 {\n    7\n}\n").unwrap();
        let s = verify_symbol(&mut parser, &sym_ref, Some(&stamped), Some("abc1234"));
        assert!(s.stale);
        assert!(s.reason.as_deref().unwrap().contains("removed"));

        // Delete the file entirely → stale, "removed — ... no longer exists".
        std::fs::remove_file(&file).unwrap();
        let s = verify_symbol(&mut parser, &sym_ref, Some(&stamped), Some("abc1234"));
        assert!(s.stale);
        assert!(s.reason.as_deref().unwrap().contains("no longer exists"));
    }

    #[test]
    fn verify_without_stamped_hash_is_inconclusive_not_stale() {
        let dir = tempfile::tempdir().unwrap();
        let file = dir.path().join("lib.rs");
        std::fs::write(&file, "fn present() {}\n").unwrap();
        let mut parser = SemanticParser::new().expect("parser");
        let sym_ref = format!("{}#present", file.to_string_lossy());

        let s = verify_symbol(&mut parser, &sym_ref, None, None);
        assert!(!s.stale);
        assert!(!s.verified);
        assert!(s.reason.is_some());
    }

    #[test]
    fn verify_entry_skips_entries_without_symbol() {
        let entry = stamped_entry(None, None);
        assert!(verify_entry(&entry).is_none());
    }

    #[test]
    fn malformed_reference_is_unverifiable() {
        let mut parser = SemanticParser::new().expect("parser");
        let s = verify_symbol(&mut parser, "just_a_name", Some("hash"), None);
        assert!(!s.stale);
        assert!(!s.verified);
    }

    #[test]
    fn hash_symbol_text_is_deterministic_and_content_sensitive() {
        let a = hash_symbol_text("fn a() {}");
        assert_eq!(a, hash_symbol_text("fn a() {}"));
        assert_ne!(a, hash_symbol_text("fn a() { 1; }"));
        assert_eq!(a.len(), 64); // sha256 hex
    }

    #[test]
    fn stamp_symbol_stores_reference_even_when_unresolvable() {
        // Unresolvable file: the reference is kept, the hash is withheld —
        // never fabricated.
        let (sym, hash) = stamp_symbol("does/not/exist.rs#ghost");
        assert_eq!(sym.as_deref(), Some("does/not/exist.rs#ghost"));
        assert_eq!(hash, None);

        let (sym, hash) = stamp_symbol("   ");
        assert_eq!(sym, None);
        assert_eq!(hash, None);
    }

    #[test]
    fn intent_row_id_prefers_signed_block_id() {
        let signed = crate::intent_query::IntentRow {
            timestamp: 100,
            agent_id: "a".into(),
            intent: "x".into(),
            intent_type: None,
            signed_block_id: Some("blk_42".into()),
            key_id: Some("key-1".into()),
            source: None,
        };
        assert_eq!(intent_row_id(&signed).as_deref(), Some("blk_42"));

        let unsigned = crate::intent_query::IntentRow {
            timestamp: 100,
            agent_id: "a".into(),
            intent: "x".into(),
            intent_type: None,
            signed_block_id: None,
            key_id: None,
            source: None,
        };
        assert_eq!(intent_row_id(&unsigned).as_deref(), Some("ts:100"));

        let legacy = crate::intent_query::IntentRow {
            timestamp: 0,
            agent_id: "a".into(),
            intent: "x".into(),
            intent_type: None,
            signed_block_id: None,
            key_id: None,
            source: None,
        };
        assert_eq!(intent_row_id(&legacy), None);
    }
}
