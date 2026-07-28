//! AST-aware 3-way merge engine for the `aura merge-driver` git merge driver.
//!
//! Strategy: parse base/ours/theirs into TOP-LEVEL nodes (fn/struct/impl/class…)
//! with byte spans, collapse each node to a single content-addressed placeholder
//! line ("scaffold"), 3-way line-merge the scaffolds with `git merge-file`, then
//! resolve node-level conflicts semantically:
//!
//! - placeholder line changed on one side only → that side's node version wins
//!   (this is what makes two agents editing DIFFERENT functions merge cleanly,
//!   even when the functions are textually adjacent);
//! - both sides added DIFFERENT new named nodes at the same spot → keep both;
//! - same node modified on both sides → inner line-level 3-way on the node
//!   bodies (never worse than plain `git merge-file`); real overlap → conflict
//!   markers, exit 1;
//! - delete-vs-modify → conflict markers (the line merge already produces them);
//! - inter-node text (imports/comments/whitespace) → plain line-level 3-way.
//!
//! On ANY doubt — parse error, unsupported language, malformed markers, non-UTF8
//! — the caller falls back to `git merge-file` on the original files. This
//! engine only ever runs on in-memory strings; it never touches the work tree.

use sha2::{Digest, Sha256};
use std::collections::HashMap;
use std::io::Write as _;
use std::process::Command;
use tree_sitter::{Node, Parser};

/// Outcome of the semantic merge. `Fallback` means "run `git merge-file` on the
/// original files instead" — the engine refuses to guess.
#[derive(Debug)]
pub enum SemanticMerge {
    /// Merged cleanly — write `content` to the ours file, exit 0.
    Clean(String),
    /// Conflict markers remain — write `content`, exit 1. `details` carries
    /// one entry per NAMED node the engine could honestly attribute the
    /// conflict to (same-node both sides, delete-vs-modify, add/add same
    /// name); pure-text or anonymous-node conflicts produce no detail. This
    /// is purely informational — the merge result and exit code never depend
    /// on it.
    Conflicted {
        content: String,
        conflicts: usize,
        details: Vec<NodeConflict>,
    },
    /// Engine declines (reason) — caller must run `git merge-file`.
    Fallback(String),
}

/// A real semantic conflict pinned to one named top-level node. Bodies are the
/// full node source on each side; an empty body means that side DELETED the
/// node (delete-vs-modify). `base_hash` is the engine's 16-hex content hash of
/// the base version (hash of "" when the node did not exist in base, e.g.
/// add/add of the same name).
#[derive(Debug, Clone)]
pub struct NodeConflict {
    pub identifier: String,
    pub base_hash: String,
    pub ours: String,
    pub theirs: String,
}

/// A top-level semantic node with a byte span and a (kind, name) identity.
struct TopNode {
    kind: String,
    /// None = anonymous; anonymous nodes never participate in add/add or
    /// modify/modify resolution (too risky to match them up).
    name: Option<String>,
    start: usize,
    end: usize,
    hash: String,
}

/// (kind, name) identity — only meaningful when name is Some.
type Identity = (String, Option<String>);

struct NodeIndex {
    /// content hash → exact node source text (union of all three versions).
    content_by_hash: HashMap<String, String>,
    /// content hash → identity.
    identity_by_hash: HashMap<String, Identity>,
    /// identities present in BASE → their content hashes (for add/add + inner merge).
    base_by_identity: HashMap<Identity, Vec<String>>,
}

pub fn semantic_merge_3way(
    base: &str,
    ours: &str,
    theirs: &str,
    ext: &str,
    marker_size: usize,
) -> SemanticMerge {
    if !is_supported_ext(ext) {
        return SemanticMerge::Fallback(format!("unsupported extension .{}", ext));
    }
    let base_nodes = match collect_top_nodes(base, ext) {
        Ok(n) => n,
        Err(e) => return SemanticMerge::Fallback(format!("base: {}", e)),
    };
    let ours_nodes = match collect_top_nodes(ours, ext) {
        Ok(n) => n,
        Err(e) => return SemanticMerge::Fallback(format!("ours: {}", e)),
    };
    let theirs_nodes = match collect_top_nodes(theirs, ext) {
        Ok(n) => n,
        Err(e) => return SemanticMerge::Fallback(format!("theirs: {}", e)),
    };
    if ours_nodes.is_empty() && theirs_nodes.is_empty() && base_nodes.is_empty() {
        // Nothing semantic to anchor on — let git handle it.
        return SemanticMerge::Fallback("no top-level nodes found".to_string());
    }

    // Per-run nonce: source text can never contain our placeholder token.
    let nonce = format!("{:016x}", rand::random::<u64>());

    let mut index = NodeIndex {
        content_by_hash: HashMap::new(),
        identity_by_hash: HashMap::new(),
        base_by_identity: HashMap::new(),
    };
    for (src, nodes, is_base) in [
        (base, &base_nodes, true),
        (ours, &ours_nodes, false),
        (theirs, &theirs_nodes, false),
    ] {
        for n in nodes.iter() {
            let content = src[n.start..n.end].to_string();
            index.content_by_hash.insert(n.hash.clone(), content);
            index
                .identity_by_hash
                .insert(n.hash.clone(), (n.kind.clone(), n.name.clone()));
            if is_base {
                index
                    .base_by_identity
                    .entry((n.kind.clone(), n.name.clone()))
                    .or_default()
                    .push(n.hash.clone());
            }
        }
    }

    let base_scaffold = scaffold(base, &base_nodes, &nonce);
    let ours_scaffold = scaffold(ours, &ours_nodes, &nonce);
    let theirs_scaffold = scaffold(theirs, &theirs_nodes, &nonce);

    let (merged_scaffold, line_conflicts) =
        match merge_file_strings(&ours_scaffold, &base_scaffold, &theirs_scaffold, marker_size) {
            Ok(v) => v,
            Err(e) => return SemanticMerge::Fallback(format!("scaffold merge: {}", e)),
        };

    let (resolved, remaining, details) = if line_conflicts == 0 {
        (merged_scaffold, 0, Vec::new())
    } else {
        match resolve_scaffold_conflicts(&merged_scaffold, marker_size, &nonce, &index) {
            Ok(v) => v,
            Err(e) => return SemanticMerge::Fallback(format!("conflict resolution: {}", e)),
        }
    };

    let output = match substitute_placeholders(&resolved, &nonce, &index.content_by_hash) {
        Ok(o) => o,
        Err(e) => return SemanticMerge::Fallback(format!("substitution: {}", e)),
    };

    if remaining == 0 {
        SemanticMerge::Clean(output)
    } else {
        SemanticMerge::Conflicted { content: output, conflicts: remaining, details }
    }
}

fn is_supported_ext(ext: &str) -> bool {
    matches!(ext, "rs" | "ts" | "tsx" | "js" | "jsx" | "py" | "go")
}

// ─── Parsing: top-level nodes with byte spans ──────────────────────────────

fn make_parser(ext: &str) -> Result<Parser, String> {
    let mut parser = Parser::new();
    let res = match ext {
        "rs" => parser.set_language(&tree_sitter_rust::LANGUAGE.into()),
        "ts" => parser.set_language(&tree_sitter_typescript::LANGUAGE_TYPESCRIPT.into()),
        "tsx" => parser.set_language(&tree_sitter_typescript::LANGUAGE_TSX.into()),
        "js" | "jsx" => parser.set_language(&tree_sitter_javascript::LANGUAGE.into()),
        "py" => parser.set_language(&tree_sitter_python::LANGUAGE.into()),
        "go" => parser.set_language(&tree_sitter_go::LANGUAGE.into()),
        _ => return Err(format!("unsupported extension .{}", ext)),
    };
    res.map_err(|e| format!("grammar load failed: {}", e))?;
    Ok(parser)
}

/// Parse `src` and return its top-level semantic nodes (sorted by span,
/// non-overlapping — they are direct children of the root). Errors when the
/// grammar reports ANY syntax error: a half-parsed file must fall back to git.
fn collect_top_nodes(src: &str, ext: &str) -> Result<Vec<TopNode>, String> {
    if src.is_empty() {
        return Ok(Vec::new());
    }
    let mut parser = make_parser(ext)?;
    let tree = parser.parse(src, None).ok_or("parse returned no tree")?;
    let root = tree.root_node();
    if root.has_error() {
        return Err("syntax errors in source".to_string());
    }

    let mut nodes = Vec::new();
    let mut cursor = root.walk();
    for child in root.named_children(&mut cursor) {
        if let Some((kind, name)) = classify_node(&child, src, ext) {
            let content = &src[child.byte_range()];
            let hash = short_content_hash(content);
            nodes.push(TopNode {
                kind,
                name,
                start: child.start_byte(),
                end: child.end_byte(),
                hash,
            });
        }
    }
    Ok(nodes)
}

/// Decide whether a direct child of the file root is a semantic node worth
/// collapsing, and compute its (kind, name) identity. Whatever is NOT a node
/// (imports, attributes, comments, small statements) stays as inter-node text
/// and gets ordinary line-level merging.
fn classify_node(node: &Node, src: &str, ext: &str) -> Option<(String, Option<String>)> {
    let kind = node.kind();
    let name_of = |n: &Node| -> Option<String> {
        n.child_by_field_name("name")
            .map(|c| src[c.byte_range()].to_string())
    };

    match ext {
        "rs" => match kind {
            "function_item" | "struct_item" | "enum_item" | "trait_item" | "mod_item"
            | "union_item" | "macro_definition" => Some((kind.to_string(), name_of(node))),
            "impl_item" => {
                // Identity must distinguish `impl Foo` from `impl Display for Foo`.
                let trait_part = node
                    .child_by_field_name("trait")
                    .map(|c| normalize_ws(&src[c.byte_range()]));
                let type_part = node
                    .child_by_field_name("type")
                    .map(|c| normalize_ws(&src[c.byte_range()]));
                let name = match (trait_part, type_part) {
                    (Some(t), Some(ty)) => Some(format!("{} for {}", t, ty)),
                    (None, Some(ty)) => Some(ty),
                    _ => None,
                };
                Some((kind.to_string(), name))
            }
            _ => None,
        },
        "py" => match kind {
            "function_definition" | "class_definition" => {
                Some((kind.to_string(), name_of(node)))
            }
            "decorated_definition" => {
                // Span includes decorators; identity comes from the inner def
                // so adding a decorator is a MODIFY, not delete+add.
                let inner = node.child_by_field_name("definition")?;
                Some((inner.kind().to_string(), name_of(&inner)))
            }
            _ => None,
        },
        "go" => match kind {
            "function_declaration" => Some((kind.to_string(), name_of(node))),
            "method_declaration" => {
                // Receiver type is part of the identity: (s *Server) Close vs
                // (c *Client) Close are different methods.
                let recv = node
                    .child_by_field_name("receiver")
                    .map(|c| normalize_ws(&src[c.byte_range()]))
                    .unwrap_or_default();
                let name = name_of(node).map(|n| format!("{} {}", recv, n));
                Some((kind.to_string(), name))
            }
            "type_declaration" => {
                // `type Foo struct {...}` — name from the first type_spec.
                let mut cursor = node.walk();
                let name = node
                    .named_children(&mut cursor)
                    .find_map(|c| c.child_by_field_name("name"))
                    .map(|c| src[c.byte_range()].to_string());
                Some((kind.to_string(), name))
            }
            _ => None,
        },
        "ts" | "tsx" | "js" | "jsx" => classify_ts_like(node, src),
        _ => None,
    }
}

/// TS/TSX/JS/JSX classification, shared because export wrappers and
/// `const foo = () => {}` declarations look the same across all four.
fn classify_ts_like(node: &Node, src: &str) -> Option<(String, Option<String>)> {
    let kind = node.kind();
    let name_of = |n: &Node| -> Option<String> {
        n.child_by_field_name("name")
            .map(|c| src[c.byte_range()].to_string())
    };
    match kind {
        "function_declaration"
        | "generator_function_declaration"
        | "class_declaration"
        | "abstract_class_declaration"
        | "interface_declaration"
        | "enum_declaration"
        | "type_alias_declaration" => Some((kind.to_string(), name_of(node))),
        "lexical_declaration" | "variable_declaration" => {
            // Only single-declarator statements get node identity; multi
            // declarations stay as plain text.
            let mut cursor = node.walk();
            let declarators: Vec<Node> = node
                .named_children(&mut cursor)
                .filter(|c| c.kind() == "variable_declarator")
                .collect();
            if declarators.len() != 1 {
                return None;
            }
            let name = name_of(&declarators[0]);
            name.as_ref()?;
            Some(("lexical_declaration".to_string(), name))
        }
        "export_statement" => {
            // Identity comes from the wrapped declaration so adding/removing
            // `export` is a MODIFY of the same node. Span = whole statement.
            let inner = node.child_by_field_name("declaration")?;
            let (inner_kind, inner_name) = classify_ts_like(&inner, src)?;
            if inner_name.is_none() {
                return None;
            }
            Some((inner_kind, inner_name))
        }
        _ => None,
    }
}

fn normalize_ws(s: &str) -> String {
    s.split_whitespace().collect::<Vec<_>>().join(" ")
}

/// The engine's content address: first 16 hex chars of SHA-256. Used for node
/// placeholders AND as `NodeConflict::base_hash`, so conflict rows are
/// addressable in the same scheme.
fn short_content_hash(content: &str) -> String {
    let mut hasher = Sha256::new();
    hasher.update(content.as_bytes());
    hex::encode(hasher.finalize())[..16].to_string()
}

// ─── Scaffolding ───────────────────────────────────────────────────────────

fn placeholder(nonce: &str, hash: &str) -> String {
    format!("@@AURA:MERGE:{}:{}@@", nonce, hash)
}

fn placeholder_prefix(nonce: &str) -> String {
    format!("@@AURA:MERGE:{}:", nonce)
}

/// Replace each node's byte span with its placeholder token. Nodes are
/// non-overlapping and ordered, so splice back-to-front.
fn scaffold(src: &str, nodes: &[TopNode], nonce: &str) -> String {
    let mut out = src.to_string();
    for n in nodes.iter().rev() {
        out.replace_range(n.start..n.end, &placeholder(nonce, &n.hash));
    }
    out
}

// ─── Line-level 3-way via `git merge-file` ─────────────────────────────────

/// Run `git merge-file -p` on three in-memory strings.
/// Returns (merged_text, conflict_count). Err = real error → caller falls back.
fn merge_file_strings(
    ours: &str,
    base: &str,
    theirs: &str,
    marker_size: usize,
) -> Result<(String, usize), String> {
    let dir = tempfile::tempdir().map_err(|e| format!("tempdir: {}", e))?;
    let write = |name: &str, content: &str| -> Result<std::path::PathBuf, String> {
        let p = dir.path().join(name);
        let mut f = std::fs::File::create(&p).map_err(|e| format!("create {}: {}", name, e))?;
        f.write_all(content.as_bytes())
            .map_err(|e| format!("write {}: {}", name, e))?;
        Ok(p)
    };
    let ours_p = write("ours", ours)?;
    let base_p = write("base", base)?;
    let theirs_p = write("theirs", theirs)?;

    // Run it from the directory we just made. All three inputs are absolute
    // and `-p` writes to stdout, so the child never needs the caller's cwd —
    // and inheriting it is a real hazard: git exits 128 before doing any work
    // if the directory it starts in has been removed, which is exactly what
    // happens when another thread's scratch directory is reaped mid-merge.
    let out = Command::new("git")
        .current_dir(dir.path())
        .arg("merge-file")
        .arg("-p")
        .arg(format!("--marker-size={}", marker_size))
        .args(["-L", "ours", "-L", "base", "-L", "theirs"])
        .arg(&ours_p)
        .arg(&base_p)
        .arg(&theirs_p)
        .output()
        .map_err(|e| format!("spawn git merge-file: {}", e))?;

    let code = out.status.code().ok_or("git merge-file killed by signal")?;
    // Exit semantics: 0 = clean, 1..=127 = conflict count, negative (→255) = error.
    if !(0..=127).contains(&code) {
        return Err(format!("git merge-file failed (exit {})", code));
    }
    let merged =
        String::from_utf8(out.stdout).map_err(|_| "merge produced non-UTF8".to_string())?;
    Ok((merged, code as usize))
}

// ─── Semantic conflict resolution on the merged scaffold ──────────────────

struct ConflictBlock {
    ours: Vec<String>,
    theirs: Vec<String>,
}

/// Walk the merged scaffold, parse `git merge-file` conflict blocks, and try
/// to resolve each one semantically. Returns (text, remaining_conflicts,
/// per-node conflict details for the blocks that stayed conflicted).
fn resolve_scaffold_conflicts(
    merged: &str,
    marker_size: usize,
    nonce: &str,
    index: &NodeIndex,
) -> Result<(String, usize, Vec<NodeConflict>), String> {
    let ours_marker = format!("{} ours", "<".repeat(marker_size));
    let sep_marker = "=".repeat(marker_size);
    let theirs_marker = format!("{} theirs", ">".repeat(marker_size));

    let lines: Vec<&str> = merged.split('\n').collect();
    let mut out: Vec<String> = Vec::with_capacity(lines.len());
    let mut remaining = 0usize;
    let mut details: Vec<NodeConflict> = Vec::new();
    let mut i = 0usize;

    while i < lines.len() {
        if lines[i] != ours_marker {
            out.push(lines[i].to_string());
            i += 1;
            continue;
        }
        // Find the block bounds. Malformed markers = doubt = error out.
        let sep = (i + 1..lines.len())
            .find(|&j| lines[j] == sep_marker)
            .ok_or("conflict block missing separator")?;
        let end = (sep + 1..lines.len())
            .find(|&j| lines[j] == theirs_marker)
            .ok_or("conflict block missing terminator")?;
        let block = ConflictBlock {
            ours: lines[i + 1..sep].iter().map(|s| s.to_string()).collect(),
            theirs: lines[sep + 1..end].iter().map(|s| s.to_string()).collect(),
        };

        match resolve_block(&block, marker_size, nonce, index)? {
            BlockResolution::Resolved(replacement) => out.extend(replacement),
            BlockResolution::StillConflicted {
                lines: replacement,
                conflicts,
                details: block_details,
            } => {
                remaining += conflicts;
                details.extend(block_details);
                out.extend(replacement);
            }
        }
        i = end + 1;
    }

    Ok((out.join("\n"), remaining, details))
}

enum BlockResolution {
    Resolved(Vec<String>),
    StillConflicted {
        lines: Vec<String>,
        conflicts: usize,
        details: Vec<NodeConflict>,
    },
}

fn resolve_block(
    block: &ConflictBlock,
    marker_size: usize,
    nonce: &str,
    index: &NodeIndex,
) -> Result<BlockResolution, String> {
    // Case B first: same named node modified on both sides → inner line-level
    // 3-way on the node BODIES. Never worse than what plain git would do.
    if let Some(res) = try_same_node_inner_merge(block, marker_size, nonce, index)? {
        return Ok(res);
    }
    // Case A: both sides consist purely of placeholders for NEW, NAMED,
    // DISJOINT nodes → it's an add/add of different functions; keep both.
    if let Some(lines) = try_add_add_union(block, nonce, index) {
        return Ok(BlockResolution::Resolved(lines));
    }
    // Anything else (delete-vs-modify, mixed text, anonymous nodes…) stays a
    // conflict; re-emit the block verbatim with its markers.
    let mut lines = Vec::with_capacity(block.ours.len() + block.theirs.len() + 3);
    lines.push(format!("{} ours", "<".repeat(marker_size)));
    lines.extend(block.ours.iter().cloned());
    lines.push("=".repeat(marker_size));
    lines.extend(block.theirs.iter().cloned());
    lines.push(format!("{} theirs", ">".repeat(marker_size)));
    Ok(BlockResolution::StillConflicted {
        lines,
        conflicts: 1,
        details: block_node_details(block, nonce, index),
    })
}

/// Best-effort per-node attribution for a conflict block the engine re-emits
/// verbatim (delete-vs-modify, add/add same name, mixed). A detail is produced
/// only for NAMED placeholder nodes whose two sides genuinely differ; plain
/// text lines and anonymous nodes are skipped — never fabricate an identity.
fn block_node_details(
    block: &ConflictBlock,
    nonce: &str,
    index: &NodeIndex,
) -> Vec<NodeConflict> {
    // identity → (ours hash, theirs hash); insertion order preserved.
    let mut slots: Vec<(Identity, Option<String>, Option<String>)> = Vec::new();
    for (side, is_ours) in [(&block.ours, true), (&block.theirs, false)] {
        for line in side.iter() {
            let Some(hash) = line_placeholder_hash(line, nonce) else {
                continue;
            };
            let Some(id) = index.identity_by_hash.get(hash) else {
                continue;
            };
            if id.1.is_none() {
                continue; // anonymous — not safely attributable
            }
            let slot = match slots.iter_mut().find(|(i, _, _)| i == id) {
                Some(s) => s,
                None => {
                    slots.push((id.clone(), None, None));
                    slots.last_mut().expect("just pushed")
                }
            };
            if is_ours {
                slot.1 = Some(hash.to_string());
            } else {
                slot.2 = Some(hash.to_string());
            }
        }
    }
    slots
        .into_iter()
        .filter_map(|(id, ours_hash, theirs_hash)| {
            let body = |h: &Option<String>| -> String {
                h.as_ref()
                    .and_then(|h| index.content_by_hash.get(h))
                    .cloned()
                    .unwrap_or_default()
            };
            let ours = body(&ours_hash);
            let theirs = body(&theirs_hash);
            if ours == theirs {
                // Same content on both sides — the node just got swept into a
                // textual block; it is not itself in conflict.
                return None;
            }
            let base_hash = match index.base_by_identity.get(&id) {
                Some(hashes) if hashes.len() == 1 => hashes[0].clone(),
                // No (unique) base version — add/add of the same name, or an
                // ambiguous duplicate identity. Hash of the empty body keeps
                // the field honest and stable.
                _ => short_content_hash(""),
            };
            Some(NodeConflict {
                identifier: id.1.clone().unwrap_or_default(),
                base_hash,
                ours,
                theirs,
            })
        })
        .collect()
}

/// Extract the placeholder hash if a line is EXACTLY one placeholder token.
fn line_placeholder_hash<'a>(line: &'a str, nonce: &str) -> Option<&'a str> {
    let t = line.trim();
    let prefix = placeholder_prefix(nonce);
    let rest = t.strip_prefix(&prefix)?;
    let hash = rest.strip_suffix("@@")?;
    if hash.len() == 16 && hash.bytes().all(|b| b.is_ascii_hexdigit()) {
        Some(hash)
    } else {
        None
    }
}

/// Case B: each side is exactly one placeholder, both map to the SAME named
/// identity, and that identity existed (uniquely) in base → 3-way merge the
/// node bodies themselves at line level.
fn try_same_node_inner_merge(
    block: &ConflictBlock,
    marker_size: usize,
    nonce: &str,
    index: &NodeIndex,
) -> Result<Option<BlockResolution>, String> {
    let single_hash = |side: &[String]| -> Option<String> {
        let non_blank: Vec<&String> = side.iter().filter(|l| !l.trim().is_empty()).collect();
        if non_blank.len() != 1 {
            return None;
        }
        line_placeholder_hash(non_blank[0], nonce).map(|h| h.to_string())
    };
    let (Some(ours_hash), Some(theirs_hash)) =
        (single_hash(&block.ours), single_hash(&block.theirs))
    else {
        return Ok(None);
    };
    let ours_id = index.identity_by_hash.get(&ours_hash);
    let theirs_id = index.identity_by_hash.get(&theirs_hash);
    let (Some(ours_id), Some(theirs_id)) = (ours_id, theirs_id) else {
        return Ok(None);
    };
    if ours_id != theirs_id || ours_id.1.is_none() {
        return Ok(None);
    }
    // Need exactly one base version of this identity to anchor the 3-way.
    let base_hashes = match index.base_by_identity.get(ours_id) {
        Some(h) if h.len() == 1 => h,
        _ => return Ok(None),
    };
    let base_content = index
        .content_by_hash
        .get(&base_hashes[0])
        .ok_or("missing base content")?;
    let ours_content = index
        .content_by_hash
        .get(&ours_hash)
        .ok_or("missing ours content")?;
    let theirs_content = index
        .content_by_hash
        .get(&theirs_hash)
        .ok_or("missing theirs content")?;

    let (merged, conflicts) =
        merge_file_strings(ours_content, base_content, theirs_content, marker_size)?;
    let lines: Vec<String> = merged.split('\n').map(|s| s.to_string()).collect();
    // Node bodies don't end with \n (spans are exact), but `git merge-file`
    // output always terminates the last line — drop the trailing empty line
    // so we don't inject a blank line into the file.
    let lines = match lines.last() {
        Some(l) if l.is_empty() => lines[..lines.len() - 1].to_vec(),
        _ => lines,
    };
    if conflicts == 0 {
        Ok(Some(BlockResolution::Resolved(lines)))
    } else {
        // The inner 3-way left real overlap inside ONE named node — that is
        // exactly one semantic conflict to report, regardless of how many
        // marker hunks the line merge produced.
        let detail = NodeConflict {
            identifier: ours_id.1.clone().unwrap_or_default(),
            base_hash: base_hashes[0].clone(),
            ours: ours_content.clone(),
            theirs: theirs_content.clone(),
        };
        Ok(Some(BlockResolution::StillConflicted {
            lines,
            conflicts,
            details: vec![detail],
        }))
    }
}

/// Case A: pure add/add of different named nodes — union both sides.
fn try_add_add_union(
    block: &ConflictBlock,
    nonce: &str,
    index: &NodeIndex,
) -> Option<Vec<String>> {
    let side_identities = |side: &[String]| -> Option<Vec<Identity>> {
        let mut ids = Vec::new();
        for line in side {
            if line.trim().is_empty() {
                continue;
            }
            let hash = line_placeholder_hash(line, nonce)?; // any plain text → bail
            let id = index.identity_by_hash.get(hash)?;
            id.1.as_ref()?; // anonymous nodes are not safely matchable
            if index.base_by_identity.contains_key(id) {
                return None; // existed in base → a move/modify, not an add
            }
            ids.push(id.clone());
        }
        if ids.is_empty() {
            None // one side empty = add-vs-delete territory, not add/add
        } else {
            Some(ids)
        }
    };
    let ours_ids = side_identities(&block.ours)?;
    let theirs_ids = side_identities(&block.theirs)?;
    if ours_ids.iter().any(|id| theirs_ids.contains(id)) {
        return None; // same identity added on both sides with different bodies
    }
    let mut lines = block.ours.clone();
    lines.extend(block.theirs.iter().cloned());
    Some(lines)
}

// ─── Placeholder substitution ──────────────────────────────────────────────

fn substitute_placeholders(
    text: &str,
    nonce: &str,
    content_by_hash: &HashMap<String, String>,
) -> Result<String, String> {
    let mut out = text.to_string();
    for (hash, content) in content_by_hash {
        let token = placeholder(nonce, hash);
        if out.contains(&token) {
            out = out.replace(&token, content);
        }
    }
    if out.contains(&placeholder_prefix(nonce)) {
        return Err("unresolved placeholder after substitution".to_string());
    }
    Ok(out)
}
