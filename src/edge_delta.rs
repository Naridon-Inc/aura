//! AUDIT-GRF-04: intent verification against dependency-EDGE changes.
//!
//! The keyword gate (Gate 3 in `CaptureContext`) only checks that changed
//! node NAMES appear in the intent prose. Removing an auth call from a
//! function that keeps its name changes no node name — the classic bypass:
//! `check_auth()` still exists, `handle_request` still exists, only the edge
//! between them is gone, and nothing asked for evidence.
//!
//! This module diffs each RETAINED node's dependency set between the last
//! checkpoint and the staged tree, classifies every removed/added relation
//! (call vs import, security-sensitive or not, resolution confidence), and
//! checks removals against the intent prose so the gate can demand evidence
//! for what disappeared, not just for what got renamed. Whole-node deletions
//! stay the deletion guard's job — this gate covers the edges that vanish
//! while both endpoints survive.

use crate::models::AstNode;
use std::collections::{BTreeMap, BTreeSet};

/// What kind of relation the edge is.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord)]
pub enum EdgeKind {
    /// A call expression: `verify_token(...)`.
    Call,
    /// An import/use statement: `use crate::auth::verify_token;`.
    Import,
}

impl EdgeKind {
    pub fn as_str(&self) -> &'static str {
        match self {
            EdgeKind::Call => "call",
            EdgeKind::Import => "import",
        }
    }
}

/// How the parser resolved the edge target. (Named `Resolution` to avoid
/// colliding with `callgraph::EdgeConfidence`, which scores reverse-graph
/// resolution, not dependency capture.)
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Resolution {
    /// The LSP (or import machinery) pinned the target to a URI.
    Resolved,
    /// Name captured from the AST only.
    NameOnly,
}

impl Resolution {
    pub fn as_str(&self) -> &'static str {
        match self {
            Resolution::Resolved => "resolved",
            Resolution::NameOnly => "name-only",
        }
    }
}

/// One relation that appeared or disappeared on a retained node.
#[derive(Debug, Clone)]
pub struct EdgeChange {
    /// The retained function/class whose dependency set changed.
    pub node: String,
    /// Source file of the node, when known.
    pub file: Option<String>,
    /// The dependency target: callee name or import path, normalized.
    pub target: String,
    pub kind: EdgeKind,
    pub confidence: Resolution,
    /// True when the target smells like auth/security machinery — the
    /// removals the protected contract refuses to wave through unmentioned.
    pub sensitive: bool,
}

impl EdgeChange {
    /// One evidence line, e.g.
    /// `handle_request → check_auth (call, name-only, security-sensitive)`.
    pub fn evidence(&self) -> String {
        format!(
            "{} → {} ({}, {}{})",
            self.node,
            self.target,
            self.kind.as_str(),
            self.confidence.as_str(),
            if self.sensitive { ", security-sensitive" } else { "" },
        )
    }
}

/// The full edge diff between two node sets.
#[derive(Debug, Default)]
pub struct EdgeDelta {
    pub removed: Vec<EdgeChange>,
    pub added: Vec<EdgeChange>,
}

impl EdgeDelta {
    /// Narrow the diff to the files this commit writes.
    ///
    /// The two sides of the diff are whole-repository snapshots, because that
    /// is what a checkpoint holds. The last checkpoint is not always the
    /// commit before this one — a pull, a rebase, or a stretch of
    /// `--no-verify` each leave it further back — and every file that changed
    /// in between then reads here as an edge this commit removed. It did not.
    /// Asking its author to account for those is asking them to explain
    /// somebody else's work before they are allowed to save their own, which
    /// is how a gate nobody can satisfy becomes a gate everybody turns off.
    ///
    /// A change carrying no file is dropped along with the rest. The gate has
    /// to be able to say which file it is stopping the commit over; one it
    /// cannot name is one nobody can act on, and a block nobody can act on is
    /// the kind people route around.
    pub fn within_files(self, files: &BTreeSet<String>) -> EdgeDelta {
        let mine = |c: &EdgeChange| c.file.as_deref().is_some_and(|f| files.contains(f));
        EdgeDelta {
            removed: self.removed.into_iter().filter(|c| mine(c)).collect(),
            added: self.added.into_iter().filter(|c| mine(c)).collect(),
        }
    }
}

/// Tokens that mark a dependency target as part of the auth/security surface.
/// Token membership (not substring) so `design` never matches `sign` and
/// `dessert` never matches `cert`.
const SENSITIVE_TOKENS: &[&str] = &[
    "auth", "authn", "authz", "authenticate", "authenticated", "authentication",
    "authorize", "authorized", "authorization", "login", "logout", "sso", "oauth",
    "acl", "rbac", "role", "roles", "permission", "permissions", "perm", "perms",
    "privilege", "privileges", "csrf", "xsrf", "cors",
    "token", "tokens", "jwt", "session", "sessions", "cookie", "cookies",
    "password", "passwords", "passcode", "secret", "secrets", "credential",
    "credentials", "apikey", "keychain",
    "sanitize", "sanitized", "sanitizer", "escape", "escaped", "unescape",
    "encrypt", "encrypted", "encryption", "decrypt", "decrypted", "cipher",
    "sign", "signed", "signature", "signatures", "hmac", "checksum", "digest",
    "verify", "verified", "verification", "validate", "validated", "validation",
    "guard", "guards", "gatekeeper", "audit", "policy", "policies", "scope",
    "scopes", "grant", "grants", "revoke", "ratelimit", "throttle",
];

/// Split an identifier or import path into lowercase word tokens:
/// `verifyAuthToken` → [verify, auth, token]; `crate::auth::check` →
/// [crate, auth, check].
fn tokens(target: &str) -> Vec<String> {
    let mut out = Vec::new();
    let mut cur = String::new();
    let mut prev_lower = false;
    for c in target.chars() {
        if c.is_alphanumeric() {
            // camelCase boundary: lower→Upper starts a new token.
            if c.is_uppercase() && prev_lower && !cur.is_empty() {
                out.push(std::mem::take(&mut cur));
            }
            prev_lower = c.is_lowercase() || c.is_numeric();
            cur.extend(c.to_lowercase());
        } else {
            prev_lower = false;
            if !cur.is_empty() {
                out.push(std::mem::take(&mut cur));
            }
        }
    }
    if !cur.is_empty() {
        out.push(cur);
    }
    out
}

/// Whether a dependency target belongs to the auth/security surface.
pub fn is_sensitive_target(target: &str) -> bool {
    tokens(target)
        .iter()
        .any(|t| SENSITIVE_TOKENS.contains(&t.as_str()))
}

/// Normalize one dependency for set comparison: imports collapse their
/// whitespace (a re-wrapped `use` line is the same edge), calls keep their
/// captured name verbatim.
fn normalize_target(raw: &str) -> (String, EdgeKind) {
    let trimmed = raw.trim();
    let head = trimmed.split_whitespace().next().unwrap_or("");
    let is_import = matches!(head, "use" | "import" | "from" | "require" | "include");
    if is_import {
        (
            trimmed
                .split_whitespace()
                .collect::<Vec<_>>()
                .join(" ")
                .trim_end_matches(';')
                .to_string(),
            EdgeKind::Import,
        )
    } else {
        (trimmed.to_string(), EdgeKind::Call)
    }
}

/// The identifier a human would name when writing evidence about this edge:
/// the last path/attribute segment (`crate::auth::verify_token` →
/// `verify_token`, `self.session.check` → `check`). For imports, the last
/// meaningful segment of the path.
pub fn evidence_ident(target: &str) -> String {
    let stripped = target
        .trim_end_matches(';')
        .trim_end_matches('}')
        .trim();
    stripped
        .rsplit(|c: char| !c.is_alphanumeric() && c != '_')
        .find(|s| !s.is_empty() && *s != "_")
        .unwrap_or(stripped)
        .to_string()
}

/// One retained node's dependency set, as (normalized target → sample
/// DependencyUri resolution). Set semantics deliberately: a function calling
/// `foo()` twice has ONE edge to foo — dropping one of two call sites keeps
/// the relation and is not an edge removal.
fn edge_set(node: &AstNode) -> BTreeMap<(String, EdgeKind), Resolution> {
    let mut out = BTreeMap::new();
    for dep in &node.dependencies {
        let (target, kind) = normalize_target(&dep.name);
        if target.is_empty() {
            continue;
        }
        let res = if dep.uri.is_some() {
            Resolution::Resolved
        } else {
            Resolution::NameOnly
        };
        // Resolved beats NameOnly if the same edge shows up twice.
        out.entry((target, kind))
            .and_modify(|r| {
                if res == Resolution::Resolved {
                    *r = Resolution::Resolved;
                }
            })
            .or_insert(res);
    }
    out
}

/// Key retained nodes on (file, identifier), falling back to identifier alone
/// when older checkpoints predate file_path stamping.
fn node_key(node: &AstNode) -> Option<(String, String)> {
    node.identifier
        .as_ref()
        .map(|id| (node.file_path.clone().unwrap_or_default(), id.clone()))
}

/// Diff dependency edges across two node sets, reporting changes only for
/// RETAINED nodes (present on both sides). Added/deleted nodes are other
/// gates' business; the blind spot this closes is the edge that vanishes
/// while both endpoints survive.
pub fn diff_edges(old_nodes: &[AstNode], new_nodes: &[AstNode]) -> EdgeDelta {
    let mut old_by_key: BTreeMap<(String, String), &AstNode> = BTreeMap::new();
    let mut old_by_ident: BTreeMap<String, &AstNode> = BTreeMap::new();
    for n in old_nodes {
        if let Some(key) = node_key(n) {
            old_by_ident.entry(key.1.clone()).or_insert(n);
            old_by_key.entry(key).or_insert(n);
        }
    }

    let mut delta = EdgeDelta::default();
    for new_node in new_nodes {
        let Some(key) = node_key(new_node) else { continue };
        // Exact (file, ident) match first; ident-only fallback covers
        // checkpoints written before file_path existed and file moves.
        let old_node = old_by_key
            .get(&key)
            .or_else(|| old_by_ident.get(&key.1))
            .copied();
        let Some(old_node) = old_node else { continue };

        let old_edges = edge_set(old_node);
        let new_edges = edge_set(new_node);
        let ident = key.1;

        for ((target, kind), res) in &old_edges {
            if !new_edges.contains_key(&(target.clone(), *kind)) {
                delta.removed.push(EdgeChange {
                    node: ident.clone(),
                    file: new_node.file_path.clone(),
                    target: target.clone(),
                    kind: *kind,
                    confidence: *res,
                    sensitive: is_sensitive_target(target),
                });
            }
        }
        for ((target, kind), res) in &new_edges {
            if !old_edges.contains_key(&(target.clone(), *kind)) {
                delta.added.push(EdgeChange {
                    node: ident.clone(),
                    file: new_node.file_path.clone(),
                    target: target.clone(),
                    kind: *kind,
                    confidence: *res,
                    sensitive: is_sensitive_target(target),
                });
            }
        }
    }
    delta
}

/// Removed edges the intent prose never mentions. An intended refactor
/// passes by naming what it removed — the same word-boundary evidence rule
/// Gate 3 applies to node names, here applied to the removed target (and,
/// as a courtesy, to the node the edge left). Everything else is an
/// unexplained removal for the gate to surface or block on.
pub fn unexplained_removals<'a>(
    delta: &'a EdgeDelta,
    intent_lower: &str,
) -> Vec<&'a EdgeChange> {
    delta
        .removed
        .iter()
        .filter(|e| {
            let ident = evidence_ident(&e.target).to_lowercase();
            if ident.is_empty() {
                return true;
            }
            let pattern = format!(r"\b{}\b", regex::escape(&ident));
            match regex::Regex::new(&pattern) {
                Ok(re) => !re.is_match(intent_lower),
                Err(_) => true,
            }
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::models::{AstNode, DependencyUri};

    /// Same builder shape as callgraph.rs — an `AstNode` with the fields
    /// edge diffing cares about.
    fn mk(id: &str, ident: &str, file: &str, deps: &[&str]) -> AstNode {
        AstNode {
            node_id: id.to_string(),
            kind: "function_item".to_string(),
            identifier: Some(ident.to_string()),
            content_hash: format!("h-{id}"),
            children: Vec::new(),
            dependencies: deps
                .iter()
                .map(|d| DependencyUri { name: d.to_string(), uri: None })
                .collect(),
            contains_secret: false,
            is_stub: false,
            derived_from: None,
            confidence: 1.0,
            file_path: Some(file.to_string()),
            start_line: Some(1),
            end_line: Some(10),
            signature: None,
            doc_comment: None,
            top_level: true,
        }
    }

    /// THE acceptance case: the auth function survives, the function that
    /// called it survives, only the call between them is gone — and the
    /// delta names it as a security-sensitive removal.
    #[test]
    fn removed_auth_call_on_retained_node_is_flagged() {
        let old = vec![
            mk("1", "handle_request", "src/api.rs", &["check_auth", "render"]),
            mk("2", "check_auth", "src/auth.rs", &[]),
        ];
        let new = vec![
            mk("1b", "handle_request", "src/api.rs", &["render"]),
            mk("2b", "check_auth", "src/auth.rs", &[]),
        ];
        let delta = diff_edges(&old, &new);
        assert_eq!(delta.removed.len(), 1);
        let e = &delta.removed[0];
        assert_eq!(e.node, "handle_request");
        assert_eq!(e.target, "check_auth");
        assert_eq!(e.kind, EdgeKind::Call);
        assert!(e.sensitive);
        assert!(delta.added.is_empty());

        // Unmentioned in the intent → unexplained → the contract fails.
        let unexplained = unexplained_removals(&delta, "refactored handle_request for speed");
        assert_eq!(unexplained.len(), 1);

        // Mentioned with evidence → the intended refactor passes.
        let explained = unexplained_removals(
            &delta,
            "moved the check_auth call into the router middleware so handlers stop re-checking",
        );
        assert!(explained.is_empty());
    }

    /// A commit is answerable for the files it writes, and for no others. The
    /// last checkpoint is routinely several commits back — after a pull, a
    /// rebase, or a run of `--no-verify` — and everything that moved in the
    /// meantime turns up in this diff as a removal the author never made.
    #[test]
    fn a_file_this_commit_never_touched_is_not_its_removal() {
        let old = vec![
            mk("1", "handler", "src/api.rs", &["check_auth"]),
            mk("2", "worker", "src/jobs.rs", &["verify_token"]),
        ];
        let new = vec![
            mk("1", "handler", "src/api.rs", &[]),
            mk("2", "worker", "src/jobs.rs", &[]),
        ];
        let touched: BTreeSet<String> = ["src/api.rs".to_string()].into_iter().collect();
        let delta = diff_edges(&old, &new).within_files(&touched);
        assert_eq!(delta.removed.len(), 1, "only the touched file answers for its edges");
        assert_eq!(delta.removed[0].target, "check_auth");
    }

    /// The gate has to be able to name the file it is stopping the commit over.
    #[test]
    fn a_change_with_no_file_is_not_something_the_gate_can_ask_about() {
        let old = vec![mk("1", "handler", "src/api.rs", &["check_auth"])];
        let mut gone = mk("1", "handler", "src/api.rs", &[]);
        gone.file_path = None;
        let delta = diff_edges(&old, &[gone]).within_files(&BTreeSet::new());
        assert!(delta.removed.is_empty());
    }

    #[test]
    fn removed_import_edge_is_flagged_as_import() {
        let old = vec![mk("1", "api", "src/api.py", &["import auth_client", "import json"])];
        let new = vec![mk("1b", "api", "src/api.py", &["import json"])];
        let delta = diff_edges(&old, &new);
        assert_eq!(delta.removed.len(), 1);
        assert_eq!(delta.removed[0].kind, EdgeKind::Import);
        assert!(delta.removed[0].sensitive); // auth_client tokenizes to [auth, client]
    }

    #[test]
    fn unchanged_and_added_edges_do_not_flag_removals() {
        let old = vec![mk("1", "save", "src/db.rs", &["serialize"])];
        let new = vec![mk("1b", "save", "src/db.rs", &["serialize", "encrypt_at_rest"])];
        let delta = diff_edges(&old, &new);
        assert!(delta.removed.is_empty());
        assert_eq!(delta.added.len(), 1);
        assert!(delta.added[0].sensitive);
    }

    #[test]
    fn deleted_nodes_are_not_edge_removals() {
        // Whole-node deletion is the deletion guard's job — no double report.
        let old = vec![mk("1", "legacy_login", "src/auth.rs", &["check_password"])];
        let new: Vec<AstNode> = vec![];
        let delta = diff_edges(&old, &new);
        assert!(delta.removed.is_empty());
        assert!(delta.added.is_empty());
    }

    #[test]
    fn duplicate_call_sites_are_one_edge() {
        // Dropping one of two call sites keeps the relation → no removal.
        let old = vec![mk("1", "f", "a.rs", &["log_event", "log_event"])];
        let new = vec![mk("1b", "f", "a.rs", &["log_event"])];
        let delta = diff_edges(&old, &new);
        assert!(delta.removed.is_empty());
    }

    #[test]
    fn ident_fallback_survives_missing_file_path_and_moves() {
        // Old checkpoint predates file_path stamping.
        let mut old_node = mk("1", "handler", "", &["verify_token"]);
        old_node.file_path = None;
        let new = vec![mk("1b", "handler", "src/moved/api.rs", &[])];
        let delta = diff_edges(&[old_node], &new);
        assert_eq!(delta.removed.len(), 1);
        assert_eq!(delta.removed[0].target, "verify_token");
    }

    #[test]
    fn rewrapped_import_is_the_same_edge() {
        let old = vec![mk("1", "m", "a.rs", &["use crate::auth::{a, b};"])];
        let new = vec![mk("1b", "m", "a.rs", &["use crate::auth::{a,\n    b};"])];
        // Whitespace collapse: only exact-content preserved counts as same.
        let delta = diff_edges(&old, &new);
        // "a,\n    b" collapses to "a, b" — matching the old normalized form.
        assert!(delta.removed.is_empty(), "removed: {:?}", delta.removed);
    }

    #[test]
    fn resolution_reflects_uri_presence() {
        let mut n_old = mk("1", "f", "a.rs", &[]);
        n_old.dependencies = vec![DependencyUri {
            name: "check_acl".into(),
            uri: Some("lsp://src/acl.rs#check_acl".into()),
        }];
        let n_new = mk("1b", "f", "a.rs", &[]);
        let delta = diff_edges(&[n_old], &[n_new]);
        assert_eq!(delta.removed.len(), 1);
        assert_eq!(delta.removed[0].confidence, Resolution::Resolved);
    }

    /// Labeled sensitivity fixtures. Each row is (target, is_sensitive).
    /// The false-positive traps (design, assignment, certify, dessert,
    /// tokenize-as-substring) and false-negative traps (camelCase, paths,
    /// prefixed names) are the published precision/recall corpus GRF-04
    /// asks for.
    const SENSITIVITY_FIXTURES: &[(&str, bool)] = &[
        // True positives — must be caught (recall).
        ("check_auth", true),
        ("verifyAuthToken", true),
        ("crate::security::validate_session", true),
        ("import auth_client", true),
        ("use app::middleware::csrf_guard;", true),
        ("revoke_grant", true),
        ("hmac_digest", true),
        ("sanitize_html", true),
        ("decrypt_payload", true),
        ("is_authorized", true),
        ("rbac_check", true),
        ("password_reset", true),
        // True negatives — must NOT be caught (precision).
        ("render_page", false),
        ("format_name", false),
        ("to_string", false),
        ("design_layout", false),      // 'sign' substring trap
        ("assignment_report", false),  // 'sign' substring trap
        ("dessert_menu", false),       // 'cert' substring trap
        ("certainly_helpful", false),  // 'cert' substring trap
        ("import json", false),
        ("use std::fmt::Display;", false),
        ("parse_config", false),
        ("scoped_threads", false),     // 'scope' token trap: 'scoped' ≠ 'scope'
        ("log_event", false),
    ];

    /// Precision and recall over the published fixtures — both must be 1.0,
    /// and a change to the lexicon that breaks either fails here with the
    /// exact rows it got wrong.
    #[test]
    fn sensitivity_precision_and_recall_are_perfect_on_fixtures() {
        let mut tp = 0u32;
        let mut fp = Vec::new();
        let mut fn_ = Vec::new();
        let mut tn = 0u32;
        for (target, labeled) in SENSITIVITY_FIXTURES {
            match (is_sensitive_target(target), *labeled) {
                (true, true) => tp += 1,
                (false, false) => tn += 1,
                (true, false) => fp.push(*target),
                (false, true) => fn_.push(*target),
            }
        }
        assert!(fp.is_empty(), "false positives (precision loss): {:?}", fp);
        assert!(fn_.is_empty(), "false negatives (recall loss): {:?}", fn_);
        let precision = tp as f64 / (tp as f64 + fp.len() as f64);
        let recall = tp as f64 / (tp as f64 + fn_.len() as f64);
        assert_eq!(precision, 1.0);
        assert_eq!(recall, 1.0);
        assert_eq!(tp + tn, SENSITIVITY_FIXTURES.len() as u32);
    }

    #[test]
    fn evidence_ident_names_the_last_segment() {
        assert_eq!(evidence_ident("crate::auth::verify_token"), "verify_token");
        assert_eq!(evidence_ident("self.session.check"), "check");
        assert_eq!(evidence_ident("use app::acl::grant;"), "grant");
        assert_eq!(evidence_ident("plain_call"), "plain_call");
    }
}
