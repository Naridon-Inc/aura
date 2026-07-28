//! Deletion accountability — the pure decision logic behind the pre-commit
//! "Logic Node Deletion Guard".
//!
//! The guard exists to stop an agent (Claude Code, Gemini, Codex, any) from
//! silently REMOVING working code — the classic "the AI rewrote the file and
//! dropped three functions while adding one" failure. A deletion is only
//! allowed through when the agent has ACCOUNTED for it: the logged intent (or
//! commit message) must both signal a removal AND name what was removed (a
//! node name, or a deleted file/directory path).
//!
//! This module is deliberately free of I/O, git, and process exits. It answers
//! three questions the `capture-context` gate asks, and nothing else:
//!
//!   1. `detect_deleted_nodes` — which named nodes vanished vs. the last
//!      checkpoint?
//!   2. `is_deletion_accounted` — did the agent's stated intent account for
//!      those removals (removal keyword + a specific name or path)?
//!   3. `rejection_instruction` — when it did NOT, what is the EXACT command
//!      the agent must run to become accountable and retry?
//!
//! (3) is the crux of the accountability loop: the returned command already
//! contains a removal keyword AND the concrete node names, so an agent that
//! fills in the reason and runs it verbatim will pass `is_deletion_accounted`
//! on the next attempt. The gate rejects with a fix, not just a "no". The
//! round-trip is asserted in the tests below so the two can never drift.

use std::collections::HashSet;

/// Removal keywords the stated intent must contain for a deletion to read as
/// deliberate. Matched case-insensitively as substrings so "removed",
/// "removing", "removal" all hit "remov". Kept in one place so the gate and
/// the instruction we hand back agree on what counts as a removal signal.
pub const DELETION_KEYWORDS: &[&str] = &[
    "remov",     // remove / removed / removing / removal
    "delet",     // delete / deleted / deletion
    "deprecat",  // deprecate / deprecated
    "drop",      // drop / dropped
    "strip",     // strip / stripped
    "clean",     // clean / cleaned / cleanup
    "refactor",  // refactor / refactored
];

/// The removal verb we put in front of the generated `log-intent` command.
/// It is one of [`DELETION_KEYWORDS`] (contains "remov") so the instruction we
/// hand back is guaranteed to satisfy the removal-keyword half of the gate.
const INSTRUCTION_VERB: &str = "Removed";

/// How many node names to inline into the generated command before eliding the
/// rest with "…". One name is enough to satisfy the gate's specific-name check,
/// but listing several keeps the intent honest about the full blast radius
/// without producing an unreadably long command line.
const MAX_NAMES_IN_INSTRUCTION: usize = 8;

/// Compare the identifiers that existed in the last checkpoint against the set
/// still present in the staged tree and return the names that vanished.
///
/// Anonymous / generated identifiers are skipped with the exact same exclusion
/// list the alignment matcher uses (`""`, `"anonymous"`, `"__"`-prefixed) so
/// the guard never flags a closure or a compiler-generated symbol as a
/// "deleted feature".
///
/// Takes an iterator of `Option<&str>` rather than the full `AstNode` list so
/// the decision stays decoupled from the parser types and is trivially
/// testable. Result is de-duplicated and preserves first-seen order.
pub fn detect_deleted_nodes<'a>(
    previous_identifiers: impl IntoIterator<Item = Option<&'a str>>,
    staged_identifiers: &HashSet<String>,
) -> Vec<String> {
    let mut deleted: Vec<String> = Vec::new();
    let mut seen: HashSet<&str> = HashSet::new();
    for ident in previous_identifiers.into_iter().flatten() {
        if is_ignorable_identifier(ident) {
            continue;
        }
        if staged_identifiers.contains(ident) {
            continue;
        }
        if seen.insert(ident) {
            deleted.push(ident.to_string());
        }
    }
    deleted
}

/// True when the identifier carries no auditable meaning and must never be
/// treated as a removed feature: empty, the literal "anonymous", or a
/// dunder/compiler-generated name (`__init__`, `__wbindgen_*`, …).
pub fn is_ignorable_identifier(ident: &str) -> bool {
    ident.is_empty() || ident == "anonymous" || ident.starts_with("__")
}

/// Decide whether the agent's stated intent ACCOUNTS for the removals.
///
/// A deletion is accounted for only when BOTH hold:
///   * the intent signals a removal at all (contains a [`DELETION_KEYWORDS`]
///     token), AND
///   * it is specific — it names at least one of the removed nodes, OR it
///     names a deleted file/directory path (so bulk directory removals don't
///     have to enumerate every symbol).
///
/// `intent_haystack` is the union of the logged intent + commit message. It is
/// lowercased internally, so the caller may pass it in any case.
pub fn is_deletion_accounted(
    deleted_nodes: &[String],
    deleted_file_paths: &[String],
    intent_haystack: &str,
) -> bool {
    let haystack = intent_haystack.to_lowercase();

    let mentions_removal = DELETION_KEYWORDS.iter().any(|kw| haystack.contains(kw));
    if !mentions_removal {
        return false;
    }

    let mentions_specific_node = deleted_nodes
        .iter()
        .any(|name| haystack.contains(&name.to_lowercase()));

    let mentions_deleted_path = deleted_file_paths.iter().any(|path| {
        // A path counts as "named" when the intent mentions the file or any
        // meaningful (>2 char) path segment — enough to tie the removal to a
        // concrete location without demanding the exact relative path.
        path.to_lowercase()
            .split('/')
            .any(|part| part.len() > 2 && haystack.contains(part))
    });

    mentions_specific_node || mentions_deleted_path
}

/// Build the EXACT command the agent must run to make an unaccounted deletion
/// accountable and become ready to commit again.
///
/// The command is intentionally self-satisfying: it opens with a removal verb
/// ("Removed") and lists the concrete node names, so an agent that fills in the
/// trailing reason and runs it verbatim will clear [`is_deletion_accounted`] on
/// the retry. This is what turns the rejection into a fix rather than a wall.
///
/// Node names are elided after [`MAX_NAMES_IN_INSTRUCTION`] with a "…and N
/// more" tail so the line stays readable on a mass deletion; the retained
/// prefix always contains at least one real name.
pub fn rejection_instruction(deleted_nodes: &[String]) -> String {
    let named: Vec<&String> = deleted_nodes
        .iter()
        .filter(|n| !is_ignorable_identifier(n))
        .collect();

    if named.is_empty() {
        // No auditable name survived (bulk/anonymous removal). Fall back to a
        // path-anchored instruction the agent can complete with the location.
        return "aura log-intent \"Removed <file/directory> because <state why it is no longer needed>\""
            .to_string();
    }

    let shown = named.len().min(MAX_NAMES_IN_INSTRUCTION);
    let mut list = named
        .iter()
        .take(shown)
        .map(|s| s.as_str())
        .collect::<Vec<_>>()
        .join(", ");
    if named.len() > shown {
        list.push_str(&format!(", …and {} more", named.len() - shown));
    }

    format!(
        "aura log-intent \"{verb} {list} because <state why {they} no longer needed>\"",
        verb = INSTRUCTION_VERB,
        list = list,
        they = if named.len() == 1 { "it is" } else { "they are" },
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    fn set(items: &[&str]) -> HashSet<String> {
        items.iter().map(|s| s.to_string()).collect()
    }

    #[test]
    fn detects_a_removed_named_node() {
        let prev = vec![Some("handle"), Some("validate")];
        let staged = set(&["handle"]);
        let deleted = detect_deleted_nodes(prev, &staged);
        assert_eq!(deleted, vec!["validate".to_string()]);
    }

    #[test]
    fn ignores_anonymous_and_dunder_identifiers() {
        let prev = vec![Some(""), Some("anonymous"), Some("__wbindgen_x"), None, Some("keep_me")];
        let staged = set(&[]); // everything "removed"
        let deleted = detect_deleted_nodes(prev, &staged);
        assert_eq!(deleted, vec!["keep_me".to_string()]);
    }

    #[test]
    fn dedupes_repeated_identifiers() {
        let prev = vec![Some("dup"), Some("dup"), Some("other")];
        let staged = set(&[]);
        let deleted = detect_deleted_nodes(prev, &staged);
        assert_eq!(deleted, vec!["dup".to_string(), "other".to_string()]);
    }

    #[test]
    fn unaccounted_when_intent_has_no_removal_keyword() {
        let deleted = vec!["validate".to_string()];
        // Names the node, but never signals a removal → not accounted.
        assert!(!is_deletion_accounted(&deleted, &[], "Updated validate to return json"));
    }

    #[test]
    fn unaccounted_when_removal_keyword_but_nothing_specific() {
        let deleted = vec!["validate".to_string()];
        // Signals a removal but names neither the node nor a path → not accounted.
        assert!(!is_deletion_accounted(&deleted, &[], "removed some dead code"));
    }

    #[test]
    fn accounted_when_removal_keyword_and_node_named() {
        let deleted = vec!["validate".to_string()];
        assert!(is_deletion_accounted(&deleted, &[], "Removed validate because it was unused"));
    }

    #[test]
    fn accounted_when_removal_keyword_and_path_named() {
        let deleted = vec!["validate".to_string()];
        let paths = vec!["src/legacy/auth.rs".to_string()];
        // Mentions a removal + a path segment ("legacy") but not the node name.
        assert!(is_deletion_accounted(&deleted, &paths, "Deleted the legacy module"));
    }

    #[test]
    fn accounting_is_case_insensitive() {
        let deleted = vec!["Validate".to_string()];
        assert!(is_deletion_accounted(&deleted, &[], "REMOVED VALIDATE, no longer needed"));
    }

    #[test]
    fn instruction_names_the_removed_nodes() {
        let deleted = vec!["validate".to_string(), "parse_header".to_string()];
        let cmd = rejection_instruction(&deleted);
        assert!(cmd.contains("aura log-intent"));
        assert!(cmd.contains("validate"));
        assert!(cmd.contains("parse_header"));
    }

    #[test]
    fn instruction_elides_a_long_removal_list() {
        let deleted: Vec<String> = (0..20).map(|i| format!("node_{i}")).collect();
        let cmd = rejection_instruction(&deleted);
        assert!(cmd.contains("node_0"));
        assert!(cmd.contains("…and"));
        assert!(cmd.contains("more"));
    }

    #[test]
    fn instruction_falls_back_when_no_named_node() {
        let deleted: Vec<String> = vec!["".to_string(), "__gen".to_string()];
        let cmd = rejection_instruction(&deleted);
        assert!(cmd.contains("aura log-intent"));
        assert!(cmd.contains("<file/directory>"));
    }

    /// The load-bearing guarantee: the command we hand back, once its reason is
    /// filled in, actually clears the gate. If this ever fails the rejection
    /// would be sending the agent in a circle.
    #[test]
    fn generated_instruction_round_trips_through_the_gate() {
        let deleted = vec!["validate".to_string(), "parse_header".to_string()];
        let cmd = rejection_instruction(&deleted);
        // Simulate the agent running the command with a concrete reason. The
        // logged intent text is the quoted payload of the command.
        let logged_intent = cmd.replace(
            "<state why they are no longer needed>",
            "the endpoint was retired",
        );
        assert!(
            is_deletion_accounted(&deleted, &[], &logged_intent),
            "the instruction we hand back must satisfy the gate on retry: {logged_intent}"
        );
    }
}
