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

// The read-time verdict (`Staleness { stale, verified }`) and its
// `verify_entry`/`verify_symbol` family lived here until CTX-04. That pair
// was overloaded — `verified: true` over an unchanged fingerprint rendered
// as "this statement is true", which the fingerprint never established.
// The replacement is `crate::memory::truth`: one exclusive evidence-based
// state (supported / contradicted / stale / unverified / superseded) per
// entry, built on this module's `parse_symbol_ref` / `locate_symbol_text` /
// `hash_symbol_text` primitives.

// ── `aura memory why <id>` ──

/// Structured provenance report for one memory: the fact, its stamp, the
/// AURA-1372 — reach: has this fact left the machine, and if it is a
/// correction of one that had, does the team still hold the older wording?
///
/// The second question is the one nobody could answer before. Editing a
/// shared fact changes it here and nowhere else: the copy your team pulls is
/// still the sentence you just decided was wrong. Silence read as "local",
/// which was true of this entry and misleading about the team's.
///
/// `replaced` is the entry this one supersedes, when there is one.
pub fn stamp_reach(
    v: &mut serde_json::Value,
    entry: &MemoryEntry,
    replaced: Option<&MemoryEntry>,
) {
    if let Some(when) = &entry.shared_at {
        v["shared_at"] = serde_json::json!(when);
        // The server's verdict, recorded at push time — not a claim we make
        // now about a signature we would have to re-check to stand behind.
        v["shared_signature"] =
            serde_json::json!(entry.shared_signature.as_deref().unwrap_or("unsigned"));
        return;
    }
    if let Some(when) = &entry.shared_retracted_at {
        // Withdrawn is not the same as never shared: the fact was out
        // there, and somebody may still be holding the copy they pulled.
        v["shared_retracted_at"] = serde_json::json!(when);
    }
    if let Some(when) = replaced.and_then(|old| old.shared_at.as_ref()) {
        v["supersedes_shared_at"] = serde_json::json!(when);
        v["correction_unshared"] = serde_json::json!(true);
    }
}

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
    let heir = {
        let mem = MemoryManager::load();
        if let Some(s) = &entry.supersedes {
            v["supersedes"] = serde_json::json!(s);
        }
        let heir = crate::memory::reconcile::superseded_by(&mem, &entry.id);
        if let Some(h) = &heir {
            v["superseded_by"] = serde_json::json!(h);
        }
        let chain = crate::memory::reconcile::supersession_chain(&mem, &entry.id);
        if chain.len() > 1 {
            v["supersession_chain"] = serde_json::json!(chain);
        }
        heir
    };
    // AURA-1372 — reach.
    let replaced = entry
        .supersedes
        .as_deref()
        .and_then(MemoryManager::find_entry)
        .map(|(_, e)| e);
    stamp_reach(&mut v, &entry, replaced.as_ref());
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
    // AUDIT-CTX-05 — entry-signature verdict. `unsigned` is honest absence
    // (pre-schema entry or a box without an identity); `invalid` means the
    // fields are present but wrong — tampered content or a spoofed key.
    {
        use crate::memory::signing::{self, SigVerdict};
        let verdict = signing::verify(&entry, section);
        v["signature"] = serde_json::json!(verdict.as_str());
        match &verdict {
            SigVerdict::Valid(kid) => {
                v["signature_key_id"] = serde_json::json!(kid);
            }
            SigVerdict::Invalid(reason) => {
                v["signature_reason"] = serde_json::json!(reason);
            }
            SigVerdict::Unsigned => {}
        }
    }
    // CTX-04 — one evidence-based truth state replaces the old
    // stale/verified boolean pair. `stale` stays as a DERIVED compat bool;
    // `verified` is gone: an unchanged anchor fingerprint never implied the
    // claim was true, and the output no longer says it did.
    {
        let report = crate::memory::truth::evaluate_entry(&entry, heir.as_deref());
        v["truth_state"] = serde_json::json!(report.state.as_str());
        v["truth_reason"] = serde_json::json!(report.reason);
        if !report.evidence.is_empty() {
            v["truth_evidence"] = serde_json::json!(report.evidence);
        }
        v["stale"] = serde_json::json!(report.state == crate::memory::truth::TruthState::Stale);
        if report.state == crate::memory::truth::TruthState::Stale {
            v["stale_reason"] = serde_json::json!(report.reason);
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

    // AURA-1372 — reach. Local is the default and stays silent; the two
    // things worth saying are that a fact left this machine, and that a
    // correction did not follow the wording it replaced.
    if let Some(when) = v["shared_at"].as_str() {
        let sig = v["shared_signature"].as_str().unwrap_or("unsigned");
        out.push_str("\n  reach\n");
        out.push_str(&format!(
            "    {:<8} shared with your team on {} ({})\n",
            "shared:", when, sig
        ));
    } else {
        let withdrawn = v["shared_retracted_at"].as_str();
        let orphaned = v["correction_unshared"].as_bool() == Some(true);
        if withdrawn.is_some() || orphaned {
            out.push_str("\n  reach\n");
        }
        if let Some(when) = withdrawn {
            out.push_str(&format!(
                "    {:<8} withdrawn from your team on {} — Aura no longer serves it, but a \
                 copy someone already pulled is not reached\n",
                "shared:", when
            ));
        }
        if orphaned {
            out.push_str(&format!(
                "    {:<8} this correction is local; the wording it replaced was shared on {} \
                 and is still what your team has\n",
                if withdrawn.is_some() { "also:" } else { "shared:" },
                v["supersedes_shared_at"].as_str().unwrap_or("?")
            ));
        }
    }

    // CTX-04 — the status line renders the truth state with its evidence,
    // so a reader sees WHAT was checked, not a bare "verified".
    if let Some(state) = v["truth_state"].as_str() {
        let glyph = match state {
            "supported" => "✓",
            "contradicted" => "✗",
            "stale" => "⚠",
            "superseded" => "⏳",
            _ => "?",
        };
        out.push_str(&format!(
            "    {:<8} {} {} — {}\n",
            "status:",
            glyph,
            state,
            v["truth_reason"].as_str().unwrap_or("")
        ));
        if let Some(evidence) = v["truth_evidence"].as_array() {
            for line in evidence.iter().filter_map(|l| l.as_str()) {
                out.push_str(&format!("      {} {}\n", "·", line));
            }
        }
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
    fn a_fact_that_never_left_the_machine_says_nothing_about_reach() {
        let mut v = serde_json::json!({});
        stamp_reach(&mut v, &stamped_entry(None, None), None);
        assert!(v.get("shared_at").is_none());
        assert!(v.get("correction_unshared").is_none());
    }

    #[test]
    fn a_shared_fact_carries_the_day_and_the_servers_verdict() {
        let mut e = stamped_entry(None, None);
        e.shared_at = Some("2026-09-09T11:02:00+00:00".to_string());
        e.shared_signature = Some("signed".to_string());
        let mut v = serde_json::json!({});
        stamp_reach(&mut v, &e, None);
        assert_eq!(v["shared_at"], "2026-09-09T11:02:00+00:00");
        assert_eq!(v["shared_signature"], "signed");

        // Pushed before signing existed, or pushed unsigned: the field is
        // still answered, because "we don't know" and "not signed" are the
        // same thing to the team reading it.
        e.shared_signature = None;
        let mut v = serde_json::json!({});
        stamp_reach(&mut v, &e, None);
        assert_eq!(v["shared_signature"], "unsigned");
    }

    #[test]
    fn correcting_a_shared_fact_says_the_team_still_has_the_old_wording() {
        let mut old = stamped_entry(None, None);
        old.id = "mem-old".to_string();
        old.shared_at = Some("2026-09-09T11:02:00+00:00".to_string());

        let mut fixed = stamped_entry(None, None);
        fixed.id = "mem-new".to_string();
        fixed.supersedes = Some("mem-old".to_string());

        let mut v = serde_json::json!({});
        stamp_reach(&mut v, &fixed, Some(&old));
        assert_eq!(v["correction_unshared"], true);
        assert_eq!(v["supersedes_shared_at"], "2026-09-09T11:02:00+00:00");

        // Correcting something that never left the machine is just an edit.
        old.shared_at = None;
        let mut v = serde_json::json!({});
        stamp_reach(&mut v, &fixed, Some(&old));
        assert!(v.get("correction_unshared").is_none());

        // And once the correction itself is shared, the warning is over —
        // the team has this wording now, so the old one is only history.
        old.shared_at = Some("2026-09-09T11:02:00+00:00".to_string());
        fixed.shared_at = Some("2026-09-10T08:00:00+00:00".to_string());
        let mut v = serde_json::json!({});
        stamp_reach(&mut v, &fixed, Some(&old));
        assert!(v.get("correction_unshared").is_none());
        assert_eq!(v["shared_at"], "2026-09-10T08:00:00+00:00");
    }

    #[test]
    fn a_withdrawn_fact_says_so_instead_of_reading_as_never_shared() {
        let mut e = stamped_entry(None, None);
        e.shared_retracted_at = Some("2026-09-10T09:30:00+00:00".to_string());
        let mut v = serde_json::json!({});
        stamp_reach(&mut v, &e, None);
        assert!(v.get("shared_at").is_none());
        assert_eq!(v["shared_retracted_at"], "2026-09-10T09:30:00+00:00");

        // Shared again after a withdrawal: the current state wins, and the
        // old retraction stops being the headline.
        e.shared_at = Some("2026-09-11T09:00:00+00:00".to_string());
        let mut v = serde_json::json!({});
        stamp_reach(&mut v, &e, None);
        assert_eq!(v["shared_at"], "2026-09-11T09:00:00+00:00");
        assert!(v.get("shared_retracted_at").is_none());
    }

    #[test]
    fn a_withdrawn_correction_of_a_shared_fact_reports_both() {
        // The messy real case: you shared a fact, corrected it, shared the
        // correction, then took the correction back. Your team has neither
        // the correction nor an accurate original — both halves have to be
        // said, because either one alone is misleading.
        let mut old = stamped_entry(None, None);
        old.id = "mem-old".to_string();
        old.shared_at = Some("2026-09-09T11:02:00+00:00".to_string());

        let mut fixed = stamped_entry(None, None);
        fixed.id = "mem-new".to_string();
        fixed.supersedes = Some("mem-old".to_string());
        fixed.shared_retracted_at = Some("2026-09-10T09:30:00+00:00".to_string());

        let mut v = serde_json::json!({});
        stamp_reach(&mut v, &fixed, Some(&old));
        assert_eq!(v["shared_retracted_at"], "2026-09-10T09:30:00+00:00");
        assert_eq!(v["correction_unshared"], true);
        assert_eq!(v["supersedes_shared_at"], "2026-09-09T11:02:00+00:00");
    }

    #[test]
    fn reach_fields_survive_the_file_and_are_absent_from_one_never_shared() {
        let mut mem = ProjectMemory::default();
        let mut e = stamped_entry(None, None);
        e.shared_at = Some("2026-09-09T11:02:00+00:00".to_string());
        e.shared_signature = Some("signed".to_string());
        mem.gotchas.push(e);
        mem.context.push(stamped_entry(None, None));

        let text = serde_json::to_string_pretty(&mem).unwrap();
        let loaded: ProjectMemory = serde_json::from_str(&text).unwrap();
        assert_eq!(
            loaded.gotchas[0].shared_at.as_deref(),
            Some("2026-09-09T11:02:00+00:00")
        );
        assert_eq!(loaded.gotchas[0].shared_signature.as_deref(), Some("signed"));
        assert!(loaded.context[0].shared_at.is_none());
        // A fact that never left stays out of the file entirely, so an older
        // Aura reading this store sees no reach keys rather than empty ones.
        assert_eq!(text.matches("\"shared_at\"").count(), 1);
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

    // The staleness-transition and inconclusive-check behaviors formerly
    // tested here (via the removed `verify_symbol`/`verify_entry`) are now
    // pinned by `crate::memory::truth::tests` on the replacement states.

    #[test]
    fn symbol_lookup_reports_missing_symbol_and_missing_file() {
        let dir = tempfile::tempdir().unwrap();
        let file = dir.path().join("vault.rs");
        let file_str = file.to_string_lossy().to_string();
        std::fs::write(&file, "fn other_fn() -> u32 {\n    7\n}\n").unwrap();
        let mut parser = SemanticParser::new().expect("parser");

        match locate_symbol_text(&mut parser, &file_str, "guard_gate") {
            SymbolLookup::SymbolMissing => {}
            other => panic!("expected SymbolMissing, got {:?}", match other {
                SymbolLookup::Found(_) => "Found",
                SymbolLookup::FileMissing => "FileMissing",
                SymbolLookup::SymbolMissing => "SymbolMissing",
                SymbolLookup::Unverifiable(_) => "Unverifiable",
            }),
        }
        std::fs::remove_file(&file).unwrap();
        assert!(matches!(
            locate_symbol_text(&mut parser, &file_str, "guard_gate"),
            SymbolLookup::FileMissing
        ));
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
            file: None,
            session_id: None,
            stated_at: None,
            change: None,
            tool: None,
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
            file: None,
            session_id: None,
            stated_at: None,
            change: None,
            tool: None,
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
            file: None,
            session_id: None,
            stated_at: None,
            change: None,
            tool: None,
        };
        assert_eq!(intent_row_id(&legacy), None);
    }
}
