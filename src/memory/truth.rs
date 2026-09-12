// CTX-04 — evidence-based truth states for memory entries.
//
// The W2 read-time check answered one question — "has the anchored symbol's
// text changed since stamping?" — but its `Staleness { stale, verified }`
// pair was overloaded: `verified: true` plus an unchanged fingerprint
// rendered as "✓ verified", which reads as "this statement is true". An
// unchanged anchor says nothing of the kind: a memory claiming `calc_tax`
// rounds up stays "verified" forever while the code truncates, as long as
// nobody edits the function.
//
// This module replaces that pair with ONE exclusive state per entry:
//
//   - `supported`     — the anchor resolves, its fingerprint (when stamped)
//                       is unchanged, AND the claim's code-checkable
//                       assertions (identifiers the content names) are all
//                       present in the symbol's live text.
//   - `contradicted`  — the anchor resolves and is unchanged, but the claim
//                       names identifiers the symbol's live text does not
//                       contain — the evidence actively disagrees.
//   - `stale`         — the anchored code moved: symbol text changed since
//                       stamping, or the symbol/file is gone. Whatever the
//                       claim says, its evidence base no longer exists.
//   - `unverified`    — no evidence either way: no anchor, an unparseable
//                       or malformed reference, or a claim that makes no
//                       code-checkable assertion. An unchanged fingerprint
//                       alone lands HERE, never in `supported`.
//   - `superseded`    — the entry was closed (`valid_to`) or replaced by a
//                       newer write; its truth no longer matters.
//
// Exclusivity is by construction — the state is a single enum, so "stale
// and verified simultaneously" cannot be represented. Precedence when
// several conditions hold: superseded > stale > contradicted > supported >
// unverified. The legacy `stale` boolean in recall JSON is now DERIVED
// (`state == stale`); the legacy `verified` boolean is gone from `why`
// output, replaced by `truth_state` + `truth_evidence`.
//
// Evidence is honest and inspectable: every verdict carries the facts it
// consulted (fingerprint comparison, which named identifiers were found or
// missing), and a claim with nothing checkable says so instead of
// borrowing credibility from the fingerprint.

use crate::memory::provenance::{
    hash_symbol_text, locate_symbol_text, parse_symbol_ref, SymbolLookup,
};
use crate::memory::MemoryEntry;
use crate::parser::SemanticParser;

/// The one truth state an entry is in. See the module header for meanings.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum TruthState {
    Supported,
    Contradicted,
    Stale,
    Unverified,
    Superseded,
}

impl TruthState {
    pub fn as_str(&self) -> &'static str {
        match self {
            TruthState::Supported => "supported",
            TruthState::Contradicted => "contradicted",
            TruthState::Stale => "stale",
            TruthState::Unverified => "unverified",
            TruthState::Superseded => "superseded",
        }
    }

    /// Status glyph for CLI rendering.
    pub fn glyph(&self) -> &'static str {
        match self {
            TruthState::Supported => "✓",
            TruthState::Contradicted => "✗",
            TruthState::Stale => "⚠",
            TruthState::Unverified => "?",
            TruthState::Superseded => "⏳",
        }
    }
}

/// One entry's verdict plus the facts that produced it.
#[derive(Debug, Clone)]
pub struct TruthReport {
    pub state: TruthState,
    /// Headline: why this state.
    pub reason: String,
    /// One line per fact consulted — fingerprint comparison, identifiers
    /// found or missing. Empty only when there was nothing to consult.
    pub evidence: Vec<String>,
}

impl TruthReport {
    fn new(state: TruthState, reason: impl Into<String>, evidence: Vec<String>) -> Self {
        Self { state, reason: reason.into(), evidence }
    }
}

/// Evaluate one entry against the live tree. `superseded_by` is the id of
/// the entry that replaced this one, when the caller has looked it up
/// (`reconcile::superseded_by`); `valid_to` on the entry itself also counts
/// as superseded.
pub fn evaluate(
    entry: &MemoryEntry,
    superseded_by: Option<&str>,
    parser: &mut SemanticParser,
) -> TruthReport {
    // 1. Superseded beats everything: a replaced fact's truth is history.
    if let Some(heir) = superseded_by {
        return TruthReport::new(
            TruthState::Superseded,
            format!("replaced by {}", heir),
            vec![format!("superseded_by: {}", heir)],
        );
    }
    if let Some(to) = &entry.valid_to {
        return TruthReport::new(
            TruthState::Superseded,
            format!("closed at {}", to),
            vec![format!("valid_to: {}", to)],
        );
    }

    // 2. No anchor → nothing to check the claim against.
    let Some(sym_ref) = entry.source_symbol.as_deref() else {
        return TruthReport::new(
            TruthState::Unverified,
            "no code anchor recorded — nothing to check the claim against",
            vec![],
        );
    };
    let Some((file, name)) = parse_symbol_ref(sym_ref) else {
        return TruthReport::new(
            TruthState::Unverified,
            format!("anchor '{}' is not in <path>#<identifier> form", sym_ref),
            vec![],
        );
    };

    // 3. Resolve the anchor.
    let since = entry.source_commit.as_deref().unwrap_or("it was stamped");
    let text = match locate_symbol_text(parser, &file, &name) {
        SymbolLookup::FileMissing => {
            return TruthReport::new(
                TruthState::Stale,
                format!("anchor removed — {} no longer exists (stamped at {})", file, since),
                vec![format!("file missing: {}", file)],
            );
        }
        SymbolLookup::SymbolMissing => {
            return TruthReport::new(
                TruthState::Stale,
                format!(
                    "anchor removed — '{}' is no longer defined in {} (stamped at {})",
                    name, file, since
                ),
                vec![format!("symbol missing: {}#{}", file, name)],
            );
        }
        SymbolLookup::Unverifiable(why) => {
            return TruthReport::new(TruthState::Unverified, why, vec![]);
        }
        SymbolLookup::Found(t) => t,
    };

    // 4. Fingerprint comparison. A changed anchor is stale regardless of
    //    what the claim says — its evidence base moved.
    let mut evidence = Vec::new();
    match entry.source_symbol_hash.as_deref() {
        Some(h) if h != hash_symbol_text(&text) => {
            return TruthReport::new(
                TruthState::Stale,
                format!("anchor changed since {}", since),
                vec![format!("fingerprint of {}#{} differs from the stamped hash", file, name)],
            );
        }
        Some(_) => evidence.push(format!("anchor fingerprint of {}#{} unchanged", file, name)),
        None => evidence.push(format!(
            "no write-time fingerprint — {}#{} checked against live text only",
            file, name
        )),
    }

    // 5. The claim itself. An unchanged fingerprint does NOT make a
    //    statement true — only the claim's own checkable assertions can.
    let atoms = claim_atoms(&entry.content, &name, &file);
    if atoms.is_empty() {
        return TruthReport::new(
            TruthState::Unverified,
            "anchor unchanged, but the claim makes no code-checkable assertion — \
             an unchanged fingerprint does not make a statement true",
            evidence,
        );
    }
    let mut missing = Vec::new();
    for atom in &atoms {
        if atom_present(&text, atom) {
            evidence.push(format!("claim names `{}` — present in {}#{}", atom, file, name));
        } else {
            evidence.push(format!("claim names `{}` — NOT found in {}#{}", atom, file, name));
            missing.push(atom.clone());
        }
    }
    if missing.is_empty() {
        TruthReport::new(
            TruthState::Supported,
            format!(
                "all {} identifier{} the claim names appear in the anchored code",
                atoms.len(),
                if atoms.len() == 1 { "" } else { "s" }
            ),
            evidence,
        )
    } else {
        TruthReport::new(
            TruthState::Contradicted,
            format!(
                "the claim names `{}` but the anchored code does not contain {}",
                missing.join("`, `"),
                if missing.len() == 1 { "it" } else { "them" }
            ),
            evidence,
        )
    }
}

/// Convenience wrapper building a throwaway parser. Returns an
/// `unverified` report when no parser grammar is available.
pub fn evaluate_entry(entry: &MemoryEntry, superseded_by: Option<&str>) -> TruthReport {
    match SemanticParser::new() {
        Ok(mut parser) => evaluate(entry, superseded_by, &mut parser),
        Err(e) => TruthReport::new(
            TruthState::Unverified,
            format!("parser unavailable: {}", e),
            vec![],
        ),
    }
}

/// Code-checkable assertions inside a memory's prose: identifiers the
/// content names. Backtick-quoted spans always qualify; bare words qualify
/// only when they LOOK like code (snake_case, camelCase, `::` paths, or a
/// trailing `()`), so plain English never becomes an assertion. The anchor
/// identifier itself and tokens of the anchor's file path are excluded —
/// the subject of a claim is not evidence for it.
pub fn claim_atoms(content: &str, anchor_ident: &str, anchor_file: &str) -> Vec<String> {
    let mut out: Vec<String> = Vec::new();
    let mut push = |raw: &str| {
        let atom = raw
            .trim()
            .trim_end_matches("()")
            .trim_matches(|c: char| !c.is_alphanumeric() && c != '_' && c != ':' && c != '.')
            .to_string();
        if atom.len() < 3 || atom == anchor_ident {
            return;
        }
        // Tokens of the anchor path (dir names, file stem) are the subject's
        // address, not an assertion about its behavior.
        if anchor_file.split(|c: char| c == '/' || c == '.').any(|seg| seg == atom) {
            return;
        }
        if !atom.chars().next().is_some_and(|c| c.is_alphabetic() || c == '_') {
            return;
        }
        if !out.contains(&atom) {
            out.push(atom);
        }
    };

    // Backticked spans first — explicit code references.
    let mut rest = content;
    while let Some(start) = rest.find('`') {
        let Some(len) = rest[start + 1..].find('`') else { break };
        push(&rest[start + 1..start + 1 + len]);
        rest = &rest[start + 1 + len + 1..];
    }

    // Bare identifier-looking words.
    for word in content.split_whitespace() {
        let w = word.trim_matches(|c: char| {
            !c.is_alphanumeric() && c != '_' && c != ':' && c != '.' && c != '(' && c != ')'
        });
        if w.contains('`') {
            continue; // already handled above
        }
        let looks_like_code = w.contains('_')
            || w.contains("::")
            || w.ends_with("()")
            || has_camel_hump(w.trim_end_matches("()"));
        if looks_like_code {
            push(w);
        }
    }
    out
}

/// True for camelCase / PascalCase humps (a lowercase letter followed by an
/// uppercase one) — `calcTax` yes, `Tax` no, `CEIL` no.
fn has_camel_hump(w: &str) -> bool {
    let mut prev_lower = false;
    for c in w.chars() {
        if c.is_uppercase() && prev_lower {
            return true;
        }
        prev_lower = c.is_lowercase();
    }
    false
}

/// Word-boundary presence of `atom` in the symbol's live text. A pathy atom
/// (`mod::helper`, `obj.method`) also matches by its last segment, since
/// call sites often drop the qualifier.
pub fn atom_present(symbol_text: &str, atom: &str) -> bool {
    if ident_boundary_match(symbol_text, atom) {
        return true;
    }
    if atom.contains("::") || atom.contains('.') {
        if let Some(last) = atom.rsplit(|c| c == ':' || c == '.').next() {
            if !last.is_empty() && ident_boundary_match(symbol_text, last) {
                return true;
            }
        }
    }
    false
}

fn ident_boundary_match(haystack: &str, needle: &str) -> bool {
    let is_ident = |c: char| c.is_alphanumeric() || c == '_';
    let mut from = 0;
    while let Some(pos) = haystack[from..].find(needle) {
        let start = from + pos;
        let end = start + needle.len();
        let before_ok = start == 0 || !haystack[..start].chars().next_back().is_some_and(is_ident);
        let after_ok = end == haystack.len() || !haystack[end..].chars().next().is_some_and(is_ident);
        // Only guard boundaries where the needle's own edge is ident-like
        // (a needle like `mod::helper` has non-ident edges internally).
        let needle_starts_ident = needle.chars().next().is_some_and(is_ident);
        let needle_ends_ident = needle.chars().next_back().is_some_and(is_ident);
        if (!needle_starts_ident || before_ok) && (!needle_ends_ident || after_ok) {
            return true;
        }
        from = start + 1;
    }
    false
}

#[cfg(test)]
mod tests {
    use super::*;

    fn entry(content: &str, symbol: Option<String>, hash: Option<String>) -> MemoryEntry {
        MemoryEntry {
            id: "mem-truth1".to_string(),
            content: content.to_string(),
            tags: vec![],
            added_by: "test".to_string(),
            added_at: 1_750_000_000,
            source_commit: Some("abc1234".to_string()),
            source_symbol: symbol,
            source_symbol_hash: hash,
            ..Default::default()
        }
    }

    /// Write `body` to a tempdir rust file and return (dir, sym_ref, hash).
    /// The dir must stay alive as long as the reference is used.
    fn anchored(
        parser: &mut SemanticParser,
        body: &str,
        ident: &str,
    ) -> (tempfile::TempDir, String, String) {
        let dir = tempfile::tempdir().unwrap();
        let file = dir.path().join("billing.rs");
        std::fs::write(&file, body).unwrap();
        let file_str = file.to_string_lossy().to_string();
        let text = match locate_symbol_text(parser, &file_str, ident) {
            SymbolLookup::Found(t) => t,
            other => panic!("anchor must resolve at stamp time: {:?}", matches_name(&other)),
        };
        (dir, format!("{}#{}", file_str, ident), hash_symbol_text(&text))
    }

    fn matches_name(l: &SymbolLookup) -> &'static str {
        match l {
            SymbolLookup::Found(_) => "found",
            SymbolLookup::FileMissing => "file missing",
            SymbolLookup::SymbolMissing => "symbol missing",
            SymbolLookup::Unverifiable(_) => "unverifiable",
        }
    }

    const TRUNCATING_TAX: &str =
        "fn calc_tax(cents: u64) -> u64 {\n    (cents * 8) / 100\n}\n";

    // ── THE acceptance fixture: a deliberately false claim over an
    //    unchanged anchor must NOT come out supported/verified. ──

    #[test]
    fn false_tax_rounding_claim_with_named_helper_is_contradicted() {
        let mut parser = SemanticParser::new().expect("parser");
        let (_dir, sym, hash) = anchored(&mut parser, TRUNCATING_TAX, "calc_tax");
        // The code truncates; the memory claims it rounds up via `ceil`.
        let e = entry(
            "calc_tax rounds the tax UP with `ceil` before applying the 8% rate",
            Some(sym),
            Some(hash),
        );
        let r = evaluate(&e, None, &mut parser);
        assert_eq!(r.state, TruthState::Contradicted, "report: {:?}", r);
        assert!(r.reason.contains("ceil"));
        assert!(
            r.evidence.iter().any(|l| l.contains("NOT found")),
            "evidence must name the missing identifier: {:?}",
            r.evidence
        );
        // The unchanged fingerprint is still reported — as evidence, not
        // as a verdict.
        assert!(r.evidence.iter().any(|l| l.contains("fingerprint") && l.contains("unchanged")));
    }

    #[test]
    fn false_prose_only_claim_over_unchanged_anchor_is_unverified_not_supported() {
        let mut parser = SemanticParser::new().expect("parser");
        let (_dir, sym, hash) = anchored(&mut parser, TRUNCATING_TAX, "calc_tax");
        // Same false belief, but stated without naming any identifier —
        // there is nothing to contradict it with, and the unchanged
        // fingerprint must not promote it to supported.
        let e = entry(
            "calc_tax always rounds up to the nearest cent",
            Some(sym),
            Some(hash),
        );
        let r = evaluate(&e, None, &mut parser);
        assert_eq!(r.state, TruthState::Unverified, "report: {:?}", r);
        assert!(r.reason.contains("does not make a statement true"));
    }

    #[test]
    fn claim_naming_a_helper_the_code_calls_is_supported_with_evidence() {
        let mut parser = SemanticParser::new().expect("parser");
        let body = "fn calc_tax(cents: u64) -> u64 {\n    round_half_even(cents * 8, 100)\n}\n";
        let (_dir, sym, hash) = anchored(&mut parser, body, "calc_tax");
        let e = entry(
            "calc_tax applies banker's rounding via `round_half_even`",
            Some(sym),
            Some(hash),
        );
        let r = evaluate(&e, None, &mut parser);
        assert_eq!(r.state, TruthState::Supported, "report: {:?}", r);
        assert!(r.evidence.iter().any(|l| l.contains("round_half_even") && l.contains("present")));
    }

    // ── acceptance: editing code updates the state coherently ──

    #[test]
    fn editing_the_anchored_code_flips_supported_to_stale() {
        let mut parser = SemanticParser::new().expect("parser");
        let dir = tempfile::tempdir().unwrap();
        let file = dir.path().join("billing.rs");
        let file_str = file.to_string_lossy().to_string();
        std::fs::write(
            &file,
            "fn calc_tax(cents: u64) -> u64 {\n    round_half_even(cents * 8, 100)\n}\n",
        )
        .unwrap();
        let text = match locate_symbol_text(&mut parser, &file_str, "calc_tax") {
            SymbolLookup::Found(t) => t,
            _ => panic!("anchor must resolve"),
        };
        let e = entry(
            "calc_tax applies banker's rounding via `round_half_even`",
            Some(format!("{}#calc_tax", file_str)),
            Some(hash_symbol_text(&text)),
        );
        assert_eq!(evaluate(&e, None, &mut parser).state, TruthState::Supported);

        // Edit the function — even though `round_half_even` is still
        // called, the evidence base moved, so the state is stale (one
        // state; stale+supported cannot co-occur by construction).
        std::fs::write(
            &file,
            "fn calc_tax(cents: u64) -> u64 {\n    round_half_even(cents * 9, 100)\n}\n",
        )
        .unwrap();
        let r = evaluate(&e, None, &mut parser);
        assert_eq!(r.state, TruthState::Stale, "report: {:?}", r);
        assert!(r.reason.contains("changed since abc1234"));

        // Delete the symbol → still stale, different evidence.
        std::fs::write(&file, "fn other() {}\n").unwrap();
        let r = evaluate(&e, None, &mut parser);
        assert_eq!(r.state, TruthState::Stale);
        assert!(r.reason.contains("no longer defined"));
    }

    // ── superseded wins over everything ──

    #[test]
    fn superseded_wins_even_with_an_intact_supported_anchor() {
        let mut parser = SemanticParser::new().expect("parser");
        let body = "fn calc_tax(cents: u64) -> u64 {\n    round_half_even(cents * 8, 100)\n}\n";
        let (_dir, sym, hash) = anchored(&mut parser, body, "calc_tax");
        let mut e = entry(
            "calc_tax applies banker's rounding via `round_half_even`",
            Some(sym),
            Some(hash),
        );
        e.valid_to = Some("2026-08-01T00:00:00+00:00".to_string());
        let r = evaluate(&e, None, &mut parser);
        assert_eq!(r.state, TruthState::Superseded);

        e.valid_to = None;
        let r = evaluate(&e, Some("mem-newer"), &mut parser);
        assert_eq!(r.state, TruthState::Superseded);
        assert!(r.reason.contains("mem-newer"));
    }

    #[test]
    fn no_anchor_is_unverified() {
        let mut parser = SemanticParser::new().expect("parser");
        let e = entry("the deploy script needs sudo", None, None);
        let r = evaluate(&e, None, &mut parser);
        assert_eq!(r.state, TruthState::Unverified);
        assert!(r.reason.contains("no code anchor"));
    }

    #[test]
    fn claim_atoms_take_code_shaped_tokens_and_skip_the_subject() {
        let atoms = claim_atoms(
            "calc_tax uses `round_half_even` and applyRate, never plain division",
            "calc_tax",
            "src/billing.rs",
        );
        assert!(atoms.contains(&"round_half_even".to_string()));
        assert!(atoms.contains(&"applyRate".to_string()));
        // The anchor identifier is the subject, not evidence.
        assert!(!atoms.contains(&"calc_tax".to_string()));
        // Plain English words never become assertions.
        assert!(!atoms.iter().any(|a| a == "never" || a == "plain" || a == "division"));
        // Anchor path tokens are the subject's address, not assertions.
        let atoms = claim_atoms("billing holds `tax_table`", "calc_tax", "src/billing.rs");
        assert_eq!(atoms, vec!["tax_table".to_string()]);
    }

    #[test]
    fn atom_presence_respects_identifier_boundaries() {
        let text = "fn f() { design(); resign_all(); auth::sign_token(); }";
        // `sign` appears only inside larger identifiers — no match.
        assert!(!atom_present(text, "sign"));
        assert!(atom_present(text, "design"));
        assert!(atom_present(text, "sign_token"));
        // Pathy atom matches by last segment.
        assert!(atom_present(text, "auth::sign_token"));
        assert!(atom_present(text, "crate::auth::sign_token"));
    }

    #[test]
    fn every_report_has_exactly_one_state() {
        // Exclusivity is structural: the state is one enum value, so the
        // audit's "stale and verified simultaneously" cannot exist. This
        // pin documents the closed set.
        for s in [
            TruthState::Supported,
            TruthState::Contradicted,
            TruthState::Stale,
            TruthState::Unverified,
            TruthState::Superseded,
        ] {
            assert!(!s.as_str().is_empty());
            assert!(!s.glyph().is_empty());
        }
    }
}
