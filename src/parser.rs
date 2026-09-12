use crate::models::{AstNode, SemanticHash, DependencyUri};
use crate::lsp::LspClient;
use crate::ecosystem::Ecosystem;
use sha2::{Digest, Sha256};
use std::collections::HashSet;
use tree_sitter::{Node, Parser};

/// Sentinel emitted in place of a node's own name inside its structural-id
/// token stream, so a rename leaves the id unchanged.
const IDENTIFIER_MASK: &str = "__ASL_IDENTIFIER__";

/// Canonical-form version prefixes. Bumped whenever the token-stream rules
/// change, so a stored hash from another format can never silently compare
/// equal (or unequal) against one computed under different rules.
const CONTENT_HASH_PREFIX: &str = "ast1_";
const NODE_ID_PREFIX: &str = "node1_";

fn sha256_hex16(input: &str) -> String {
    let mut hasher = Sha256::new();
    hasher.update(input.as_bytes());
    let digest = hasher.finalize();
    let mut hex = String::with_capacity(16);
    for byte in digest.iter().take(8) {
        hex.push_str(&format!("{:02x}", byte));
    }
    hex
}

/// The semantic engine that translates human source code into Aura's AST Graph.
pub struct SemanticParser {
    python_parser: Parser,
    rust_parser: Parser,
    ts_parser: Parser,
    tsx_parser: Parser,
    js_parser: Parser,
    go_parser: Parser,
    java_parser: Parser,
    csharp_parser: Parser,
    ruby_parser: Parser,
    cpp_parser: Parser,
    c_parser: Parser,
    php_parser: Parser,
    swift_parser: Parser,
    kotlin_parser: Parser,
    lsp_client: Option<LspClient>,
}

impl SemanticParser {
    pub fn new() -> Result<Self, Box<dyn std::error::Error>> {
        let mut python_parser = Parser::new();
        python_parser.set_language(&tree_sitter_python::LANGUAGE.into())?;

        let mut rust_parser = Parser::new();
        rust_parser.set_language(&tree_sitter_rust::LANGUAGE.into())?;

        let mut ts_parser = Parser::new();
        ts_parser.set_language(&tree_sitter_typescript::LANGUAGE_TYPESCRIPT.into())?;

        // TSX is a separate grammar, not a flag on the TypeScript one. Sharing the
        // plain grammar makes every file containing a tag fail to parse, and a file
        // that fails to parse yields no nodes — which downstream reads as "every
        // symbol in it was deleted". That is how rewind came to append a duplicate
        // of a component instead of restoring it.
        let mut tsx_parser = Parser::new();
        tsx_parser.set_language(&tree_sitter_typescript::LANGUAGE_TSX.into())?;

        let mut js_parser = Parser::new();
        js_parser.set_language(&tree_sitter_javascript::LANGUAGE.into())?;

        let mut go_parser = Parser::new();
        go_parser.set_language(&tree_sitter_go::LANGUAGE.into())?;

        let mut java_parser = Parser::new();
        java_parser.set_language(&tree_sitter_java::LANGUAGE.into())?;

        let mut csharp_parser = Parser::new();
        csharp_parser.set_language(&tree_sitter_c_sharp::LANGUAGE.into())?;

        let mut ruby_parser = Parser::new();
        ruby_parser.set_language(&tree_sitter_ruby::LANGUAGE.into())?;

        let mut cpp_parser = Parser::new();
        cpp_parser.set_language(&tree_sitter_cpp::LANGUAGE.into())?;

        let mut c_parser = Parser::new();
        c_parser.set_language(&tree_sitter_c::LANGUAGE.into())?;

        let mut php_parser = Parser::new();
        php_parser.set_language(&tree_sitter_php::LANGUAGE_PHP.into())?;

        let mut swift_parser = Parser::new();
        swift_parser.set_language(&tree_sitter_swift::LANGUAGE.into())?;

        let mut kotlin_parser = Parser::new();
        kotlin_parser.set_language(&tree_sitter_kotlin_ng::LANGUAGE.into())?;

        let lsp_client = Some(LspClient::new(Ecosystem::detect()));

        Ok(Self {
            python_parser, rust_parser, ts_parser, tsx_parser, js_parser,
            go_parser, java_parser, csharp_parser, ruby_parser,
            cpp_parser, c_parser, php_parser, swift_parser, kotlin_parser,
            lsp_client,
        })
    }

    /// Parses a source code string and extracts semantic logical blocks
    /// Parses source with file path context for richer metadata
    pub fn parse_file_with_path(&mut self, source_code: &str, ext: &str, file_path: &str) -> Result<Vec<AstNode>, Box<dyn std::error::Error>> {
        let mut nodes = self.parse_file(source_code, ext)?;
        for node in &mut nodes {
            node.file_path = Some(file_path.to_string());
        }
        Ok(nodes)
    }

    /// The one place an extension chooses a grammar. Both `parse_file` and
    /// `retrieve_node_source` route through here, so a language can never be
    /// wired to two different grammars in two different code paths.
    fn parse_tree(&mut self, source_code: &str, ext: &str) -> Result<tree_sitter::Tree, Box<dyn std::error::Error>> {
        let tree = match ext {
            "py" => self.python_parser.parse(source_code, None).ok_or("Failed to parse Python tree")?,
            "rs" => self.rust_parser.parse(source_code, None).ok_or("Failed to parse Rust tree")?,
            "ts" => self.ts_parser.parse(source_code, None).ok_or("Failed to parse TypeScript tree")?,
            "tsx" => self.tsx_parser.parse(source_code, None).ok_or("Failed to parse TSX tree")?,
            "js" | "jsx" => self.js_parser.parse(source_code, None).ok_or("Failed to parse JavaScript tree")?,
            "go" => self.go_parser.parse(source_code, None).ok_or("Failed to parse Go tree")?,
            "java" => self.java_parser.parse(source_code, None).ok_or("Failed to parse Java tree")?,
            "cs" => self.csharp_parser.parse(source_code, None).ok_or("Failed to parse C# tree")?,
            "rb" => self.ruby_parser.parse(source_code, None).ok_or("Failed to parse Ruby tree")?,
            "cpp" | "cc" | "cxx" | "hpp" => self.cpp_parser.parse(source_code, None).ok_or("Failed to parse C++ tree")?,
            "c" | "h" => self.c_parser.parse(source_code, None).ok_or("Failed to parse C tree")?,
            "php" => self.php_parser.parse(source_code, None).ok_or("Failed to parse PHP tree")?,
            "swift" => self.swift_parser.parse(source_code, None).ok_or("Failed to parse Swift tree")?,
            "kt" | "kts" => self.kotlin_parser.parse(source_code, None).ok_or("Failed to parse Kotlin tree")?,
            _ => return Err(format!("Unsupported file extension: .{}", ext).into()),
        };
        Ok(tree)
    }

    pub fn parse_file(&mut self, source_code: &str, ext: &str) -> Result<Vec<AstNode>, Box<dyn std::error::Error>> {
        let tree = self.parse_tree(source_code, ext)?;

        let root_node = tree.root_node();
        let mut extracted_nodes = Vec::new();
        self.walk_ast(&root_node, source_code, ext, false, &mut extracted_nodes);

        Ok(extracted_nodes)
    }

    /// Diffs two sets of logical nodes to identify semantic changes (including renames/moves)
    pub fn diff_nodes(old_nodes: &[AstNode], new_nodes: &[AstNode]) -> Vec<(String, String)> {
        let mut changes = Vec::new();
        let mut matched_old_indices = HashSet::new();
        let mut matched_new_indices = HashSet::new();

        // Pass 1: Direct Match by Identifier (Name)
        for (new_idx, new_node) in new_nodes.iter().enumerate() {
            for (old_idx, old_node) in old_nodes.iter().enumerate() {
                if !matched_old_indices.contains(&old_idx) && old_node.identifier == new_node.identifier && old_node.kind == new_node.kind {
                    matched_old_indices.insert(old_idx);
                    matched_new_indices.insert(new_idx);
                    
                    if old_node.content_hash != new_node.content_hash {
                        changes.push((new_node.identifier.clone().unwrap_or_else(|| "anonymous".to_string()), "modified".to_string()));
                    }
                    break;
                }
            }
        }

        // Pass 2: Structural Match for Renames (Match by node_id)
        for (new_idx, new_node) in new_nodes.iter().enumerate() {
            if matched_new_indices.contains(&new_idx) { continue; }
            
            for (old_idx, old_node) in old_nodes.iter().enumerate() {
                if !matched_old_indices.contains(&old_idx) && old_node.node_id == new_node.node_id {
                    matched_old_indices.insert(old_idx);
                    matched_new_indices.insert(new_idx);
                    
                    let old_name = old_node.identifier.clone().unwrap_or_else(|| "anonymous".to_string());
                    let new_name = new_node.identifier.clone().unwrap_or_else(|| "anonymous".to_string());
                    changes.push((format!("{} -> {}", old_name, new_name), "renamed".to_string()));
                    break;
                }
            }
        }

        // Pass 3: Unmatched nodes are Added or Deleted
        for (new_idx, new_node) in new_nodes.iter().enumerate() {
            if !matched_new_indices.contains(&new_idx) {
                changes.push((new_node.identifier.clone().unwrap_or_else(|| "anonymous".to_string()), "added".to_string()));
            }
        }

        for (old_idx, old_node) in old_nodes.iter().enumerate() {
            if !matched_old_indices.contains(&old_idx) {
                changes.push((old_node.identifier.clone().unwrap_or_else(|| "anonymous".to_string()), "deleted".to_string()));
            }
        }

        changes
    }

    /// Canonical token stream for a subtree. Only leaf tokens contribute
    /// (tree-sitter never materializes whitespace, so layout is invisible by
    /// construction), comments are skipped entirely, and each token is written
    /// as `kind US text RS` so token boundaries can never be confused with
    /// token content. Two bodies that differ only in formatting or comments
    /// therefore produce byte-identical streams; any real token change — an
    /// operator, a literal, a name — produces a different one.
    ///
    /// `mask_token` masks leaf tokens whose text equals the node's own
    /// identifier, at token granularity: `fn add` masks the `add` tokens but
    /// leaves an `address` local untouched, which substring replacement on raw
    /// text used to mangle.
    fn canonical_token_stream(node: &Node, source_code: &str, mask_token: Option<&str>, out: &mut String) {
        let kind = node.kind();
        if matches!(kind, "comment" | "line_comment" | "block_comment" | "doc_comment") {
            return;
        }
        if node.child_count() == 0 {
            out.push_str(kind);
            out.push('\u{1f}');
            let text = &source_code[node.byte_range()];
            if mask_token == Some(text) {
                out.push_str(IDENTIFIER_MASK);
            } else {
                out.push_str(text);
            }
            out.push('\u{1e}');
            return;
        }
        let mut cursor = node.walk();
        for child in node.children(&mut cursor) {
            Self::canonical_token_stream(&child, source_code, mask_token, out);
        }
    }

    fn extract_dependencies(&self, node: &Node, source_code: &str, dependencies: &mut Vec<DependencyUri>) {
        let kind = node.kind();
        
        // Deep AST Traversal: Only capture explicit calls or imports, never comments or strings.
        if kind == "call" || kind == "call_expression" {
            if let Some(func_name_node) = node.child_by_field_name("function") {
                let func_name = source_code[func_name_node.byte_range()].to_string();
                
                // Sprint 4: True Symbol Resolution
                // Ask the LSP where this function actually lives
                let uri = if let Some(ref lsp) = self.lsp_client {
                    lsp.resolve_symbol(&func_name, "unknown.rs")
                } else {
                    None
                };

                dependencies.push(DependencyUri { name: func_name, uri });
            }
        } else if kind == "import_statement" || kind == "import_from_statement" || kind == "use_declaration" {
            // Also track imports as hard dependencies
            let import_name = source_code[node.byte_range()].to_string();
            let uri = if let Some(ref lsp) = self.lsp_client {
                lsp.resolve_symbol(&import_name, "unknown.rs")
            } else {
                Some("system://import".to_string())
            };

            dependencies.push(DependencyUri { 
                name: import_name, 
                uri,
            });
        }

        // Avoid recursing into strings or comments where hallucinated text might live
        if kind == "string" || kind == "comment" || kind == "line_comment" {
            return;
        }

        let mut cursor = node.walk();
        for child in node.children(&mut cursor) {
            self.extract_dependencies(&child, source_code, dependencies);
        }
    }

    /// Recursively walks the AST to find semantic blocks (functions, classes, structs).
    ///
    /// `in_callable` is true once the walk has descended into a function /
    /// closure / method *body*. Symbols captured while it's set are body-locals
    /// (loop counters, temporaries, inline helpers) — they're still extracted
    /// for the graph, but flagged `top_level: false` so surfaces like the
    /// change-note card can list only the module-level/class-member symbols a
    /// reader actually cares about. A class body does NOT set it: methods stay
    /// top-level.
    fn walk_ast(&self, node: &Node, source_code: &str, ext: &str, in_callable: bool, extracted_nodes: &mut Vec<AstNode>) {
        let kind = node.kind();

        // A node whose *body* makes its descendants locals. Mirrors the target
        // blocks below but only the callable ones — classes/structs/modules are
        // excluded so their members keep `top_level: true`.
        let node_is_callable = match ext {
            "py" => kind == "function_definition" || kind == "lambda",
            "rs" => kind == "function_item" || kind == "closure_expression",
            "ts" | "tsx" | "js" | "jsx" => matches!(
                kind,
                "function_declaration"
                    | "arrow_function"
                    | "function_expression"
                    | "generator_function"
                    | "generator_function_declaration"
                    | "method_definition"
            ),
            "go" => kind == "function_declaration" || kind == "method_declaration" || kind == "func_literal",
            "java" | "cs" => kind == "method_declaration" || kind == "constructor_declaration",
            "rb" => kind == "method" || kind == "singleton_method",
            "cpp" | "cc" | "cxx" | "hpp" | "c" | "h" => kind == "function_definition",
            "php" => kind == "function_definition" || kind == "method_declaration",
            "swift" | "kt" | "kts" => kind == "function_declaration",
            _ => false,
        };

        // Language-specific logic blocks
        let is_target_block = match ext {
            "py" => kind == "function_definition" || kind == "class_definition",
            "rs" => kind == "function_item" || kind == "struct_item" || kind == "impl_item",
            "ts" | "tsx" | "js" | "jsx" => kind == "function_declaration" || kind == "class_declaration" || kind == "method_definition" || kind == "arrow_function" || kind == "variable_declarator",
            "go" => kind == "function_declaration" || kind == "method_declaration" || kind == "type_declaration",
            "java" => kind == "method_declaration" || kind == "class_declaration" || kind == "interface_declaration" || kind == "constructor_declaration",
            "cs" => kind == "method_declaration" || kind == "class_declaration" || kind == "interface_declaration" || kind == "struct_declaration" || kind == "constructor_declaration",
            "rb" => kind == "method" || kind == "class" || kind == "module" || kind == "singleton_method",
            "cpp" | "cc" | "cxx" | "hpp" => kind == "function_definition" || kind == "class_specifier" || kind == "struct_specifier" || kind == "template_declaration",
            "c" | "h" => kind == "function_definition" || kind == "struct_specifier",
            "php" => kind == "function_definition" || kind == "class_declaration" || kind == "method_declaration",
            "swift" => kind == "function_declaration" || kind == "class_declaration" || kind == "struct_declaration" || kind == "protocol_declaration" || kind == "enum_declaration",
            "kt" | "kts" => kind == "function_declaration" || kind == "class_declaration" || kind == "object_declaration" || kind == "interface_declaration",
            _ => false,
        };

        if is_target_block {
            let content = &source_code[node.byte_range()];

            // Extract the name of the function/struct
            let mut identifier = node.child_by_field_name("name").or_else(|| node.child_by_field_name("type")).map(|n| source_code[n.byte_range()].to_string());
            
            // Special handling for JS/TS variable declarators (e.g., const myFunc = () => {})
            if kind == "variable_declarator" && identifier.is_none() {
                if let Some(name_node) = node.child_by_field_name("name") {
                     identifier = Some(source_code[name_node.byte_range()].to_string());
                }
            }

            // Canonical semantic hash: sha256 over the comment-free leaf-token
            // stream, so formatting and comments never register as a semantic
            // change, and the value is identical on every platform and Rust
            // version (std's DefaultHasher promises neither).
            let mut token_stream = String::new();
            Self::canonical_token_stream(node, source_code, None, &mut token_stream);
            let content_hash: SemanticHash =
                format!("{}{}", CONTENT_HASH_PREFIX, sha256_hex16(&token_stream));

            // Rename-proof structural id: the same canonical stream with the
            // node's own name masked at token granularity.
            let mut masked_stream = String::new();
            Self::canonical_token_stream(node, source_code, identifier.as_deref(), &mut masked_stream);
            let node_id = format!(
                "{}{}",
                NODE_ID_PREFIX,
                sha256_hex16(&format!("{}\u{1f}{}", kind, masked_stream))
            );

            let mut dependencies = Vec::new();
            self.extract_dependencies(&node, source_code, &mut dependencies);

            // Semantic Sentinel: Check for hardcoded secrets
            // We do a simple pattern match on the raw text of this block
            let mut contains_secret = false;
            let secret_patterns = ["sk-", "ghp_", "Bearer ", "xoxb-", "AIza"];
            
            // KILL SHOT FIX: Whitelist the detection logic itself to prevent false positives
            let is_sentinel_logic = content.contains("secret_patterns") || content.contains("token_re");
            
            if !is_sentinel_logic {
                // Check if this specific node is on the Sovereign Allowlist
                let config = crate::config::ConfigManager::load();
                let is_allowed = if let Some(ref id) = identifier {
                    config.secret_allowlist.contains(id)
                } else {
                    false
                };

                if !is_allowed {
                    for pattern in &secret_patterns {
                        if content.contains(pattern) {
                            contains_secret = true;
                            break;
                        }
                    }
                }
            }

            // Behavioral Analysis: Is this a stub?
            let stub_patterns = ["TODO", "FIXME", "todo!", "panic!", "unimplemented!", "return None", "pass"];
            let mut is_stub = false;
            for pattern in &stub_patterns {
                if content.contains(pattern) {
                    is_stub = true;
                    break;
                }
            }

            // Extract line numbers
            let start_line = node.start_position().row as u32 + 1; // tree-sitter is 0-based
            let end_line = node.end_position().row as u32 + 1;

            // Extract human-readable signature (first line of the block, trimmed)
            let signature = {
                let first_line = content.lines().next().unwrap_or("").trim();
                // Remove trailing { or : for cleaner display
                let sig = first_line.trim_end_matches('{').trim_end_matches(':').trim();
                if sig.is_empty() { None } else { Some(sig.to_string()) }
            };

            // Extract doc comment from preceding sibling nodes
            let doc_comment = {
                let mut doc = None;
                let mut prev = node.prev_sibling();
                let mut doc_lines = Vec::new();
                while let Some(prev_node) = prev {
                    let pk = prev_node.kind();
                    if pk == "comment" || pk == "line_comment" || pk == "block_comment" || pk == "doc_comment" || pk == "string_literal" {
                        let text = source_code[prev_node.byte_range()].trim().to_string();
                        // Only include doc-style comments (/// or /** or # or """)
                        if text.starts_with("///") || text.starts_with("/**") || text.starts_with("##") || text.starts_with("\"\"\"") || text.starts_with("//!") {
                            doc_lines.push(text);
                            prev = prev_node.prev_sibling();
                            continue;
                        }
                    }
                    break;
                }
                if !doc_lines.is_empty() {
                    doc_lines.reverse();
                    let joined = doc_lines.join("\n")
                        .replace("///", "").replace("/**", "").replace("*/", "")
                        .replace("##", "").replace("\"\"\"", "")
                        .lines().map(|l| l.trim().trim_start_matches('*').trim()).collect::<Vec<_>>().join(" ").trim().to_string();
                    if !joined.is_empty() {
                        doc = Some(joined);
                    }
                }
                doc
            };

            extracted_nodes.push(AstNode {
                node_id,
                kind: kind.to_string(),
                identifier,
                content_hash,
                children: vec![],
                dependencies,
                contains_secret,
                is_stub,
                derived_from: None,
                confidence: 1.0,
                file_path: None, // Set by parse_file_with_path or caller
                start_line: Some(start_line),
                end_line: Some(end_line),
                signature,
                doc_comment,
                top_level: !in_callable,
            });
        }

        // Walk deeper. Once we're inside a callable's body, every descendant is
        // a local — propagate the flag so the recursion stays sticky.
        let child_in_callable = in_callable || node_is_callable;
        let mut cursor = node.walk();
        for child in node.children(&mut cursor) {
            self.walk_ast(&child, source_code, ext, child_in_callable, extracted_nodes);
        }
    }

    /// Finds a specific node by its identifier and returns its full source code string and byte range.
    /// Used for Semantic Rewind.
    pub fn retrieve_node_source(&mut self, source_code: &str, ext: &str, target_identifier: &str) -> Result<Option<(String, std::ops::Range<usize>)>, Box<dyn std::error::Error>> {
        Ok(self
            .retrieve_node_matches(source_code, ext, target_identifier)?
            .into_iter()
            .next())
    }

    /// Every node in the file carrying this name, in source order.
    ///
    /// `retrieve_node_source` answers with the first and cannot say whether
    /// there was a second. One name can belong to more than one thing in a
    /// single file — a Rust struct and its `impl` block, two methods on
    /// different classes, an overload pair — and a caller that rewrites "the"
    /// node is then rewriting whichever the walk happened to reach first,
    /// having made a choice nobody asked it to make. Recovery has to be able
    /// to see the ambiguity so it can decline it.
    ///
    /// A match is not descended into: a nested thing sharing its parent's name
    /// is not the collision this exists to surface, and descending would make
    /// an `impl` block report itself twice.
    pub fn retrieve_node_matches(
        &mut self,
        source_code: &str,
        ext: &str,
        target_identifier: &str,
    ) -> Result<Vec<(String, std::ops::Range<usize>)>, Box<dyn std::error::Error>> {
        let tree = self.parse_tree(source_code, ext)?;
        let root_node = tree.root_node();
        let mut out = Vec::new();
        self.collect_node_sources(&root_node, source_code, ext, target_identifier, &mut out);
        Ok(out)
    }

    fn collect_node_sources(
        &self,
        node: &Node,
        source_code: &str,
        ext: &str,
        target_identifier: &str,
        out: &mut Vec<(String, std::ops::Range<usize>)>,
    ) {
        if let Some(found) = self.node_source_here(node, source_code, ext, target_identifier) {
            out.push(found);
            return;
        }
        let mut cursor = node.walk();
        for child in node.children(&mut cursor) {
            self.collect_node_sources(&child, source_code, ext, target_identifier, out);
        }
    }

    /// This node itself, when it is a named block called `target_identifier`.
    /// Children are the caller's business.
    fn node_source_here(&self, node: &Node, source_code: &str, ext: &str, target_identifier: &str) -> Option<(String, std::ops::Range<usize>)> {
        let kind = node.kind();
        let is_target_block = match ext {
            "py" => kind == "function_definition" || kind == "class_definition",
            "rs" => kind == "function_item" || kind == "struct_item" || kind == "impl_item",
            "ts" | "tsx" | "js" | "jsx" => kind == "function_declaration" || kind == "class_declaration" || kind == "method_definition" || kind == "arrow_function" || kind == "variable_declarator",
            "go" => kind == "function_declaration" || kind == "method_declaration" || kind == "type_declaration",
            "java" => kind == "method_declaration" || kind == "class_declaration" || kind == "interface_declaration" || kind == "constructor_declaration",
            "cs" => kind == "method_declaration" || kind == "class_declaration" || kind == "interface_declaration" || kind == "struct_declaration" || kind == "constructor_declaration",
            "rb" => kind == "method" || kind == "class" || kind == "module" || kind == "singleton_method",
            "cpp" | "cc" | "cxx" | "hpp" => kind == "function_definition" || kind == "class_specifier" || kind == "struct_specifier" || kind == "template_declaration",
            "c" | "h" => kind == "function_definition" || kind == "struct_specifier",
            "php" => kind == "function_definition" || kind == "class_declaration" || kind == "method_declaration",
            "swift" => kind == "function_declaration" || kind == "class_declaration" || kind == "struct_declaration" || kind == "protocol_declaration" || kind == "enum_declaration",
            "kt" | "kts" => kind == "function_declaration" || kind == "class_declaration" || kind == "object_declaration" || kind == "interface_declaration",
            _ => false,
        };

        if is_target_block {
            let identifier_node = node.child_by_field_name("name").or_else(|| node.child_by_field_name("type"));
            
            if let Some(id_node) = identifier_node {
                let node_name = &source_code[id_node.byte_range()];
                if node_name == target_identifier {
                    // For variable declarators (like const playAudio = () => {}), we want to return the whole statement or at least the declarator
                    return Some((source_code[node.byte_range()].to_string(), node.byte_range()));
                }
            } else if kind == "variable_declarator" {
                if let Some(name_node) = node.child_by_field_name("name") {
                    let node_name = &source_code[name_node.byte_range()];
                    if node_name == target_identifier {
                        return Some((source_code[node.byte_range()].to_string(), node.byte_range()));
                    }
                }
            }
        }

        None
    }
}

/// The byte offset of the start of the line `offset` sits on.
///
/// Insertions anchor to a line boundary rather than to a node's own range,
/// because a node's range is not always a whole statement: tree-sitter reports
/// `let FAVORITES = []` as the *declarator* `FAVORITES = []`, so inserting at
/// its start would land between `let` and the name and produce
/// `let function loadFavorites() {…} FAVORITES = []`. A line boundary can never
/// split a token. Scanning for `\n` bytes is UTF-8 safe — a newline byte cannot
/// occur inside a multi-byte sequence.
fn line_start(source: &str, offset: usize) -> usize {
    source[..offset].rfind('\n').map_or(0, |i| i + 1)
}

/// The byte offset of the end of the line `offset` sits on (before its newline).
/// The companion to [`line_start`]; see it for why insertions snap to lines.
fn line_end(source: &str, offset: usize) -> usize {
    source[offset..].find('\n').map_or(source.len(), |i| offset + i)
}

impl SemanticParser {
    /// Put a top-level node that no longer exists back into a file, and return
    /// the whole new file.
    ///
    /// `retrieve_node_source` can only locate a node that is still present, so
    /// on its own it can *replace* a rewritten node but never recover a deleted
    /// one — which is the exact case a pre-edit snapshot is taken for. Deletion
    /// is also the damage the deletion guard blocks a commit over, so "bring it
    /// back" has to work for it.
    ///
    /// The node is placed by its **nearest surviving neighbour** in `past_source`:
    /// the top-level node directly above it, then the one above that, and so on;
    /// then the same walk downward. Anchoring to a neighbour rather than a byte
    /// offset means the node lands where a reader expects even though every line
    /// around it has moved. When an agent deleted the whole neighbourhood, the
    /// node goes to the end of the file — placed, never dropped.
    ///
    /// Returns `Ok(None)` when `identifier` isn't in `past_source` either, so the
    /// caller can report honestly instead of writing the file unchanged.
    pub fn splice_node_back(
        &mut self,
        current_source: &str,
        past_source: &str,
        ext: &str,
        identifier: &str,
    ) -> Result<Option<String>, Box<dyn std::error::Error>> {
        let (node_src, past_range) =
            match self.retrieve_node_source(past_source, ext, identifier)? {
                Some(found) => found,
                None => return Ok(None),
            };
        let node_src = node_src.trim_end().to_string();

        // Every other top-level symbol in the file it came from, in source
        // order, so "directly above" means what a reader would mean by it.
        let mut siblings: Vec<(String, std::ops::Range<usize>)> = Vec::new();
        for name in self
            .parse_file(past_source, ext)?
            .into_iter()
            .filter(|n| n.top_level)
            .filter_map(|n| n.identifier)
            .filter(|n| n != identifier)
        {
            if let Some((_, range)) = self.retrieve_node_source(past_source, ext, &name)? {
                siblings.push((name, range));
            }
        }
        siblings.sort_by_key(|(_, r)| r.start);

        let above = siblings
            .iter()
            .filter(|(_, r)| r.end <= past_range.start)
            .map(|(name, _)| name.clone())
            .rev()
            .collect::<Vec<_>>();
        let below = siblings
            .iter()
            .filter(|(_, r)| r.start >= past_range.end)
            .map(|(name, _)| name.clone())
            .collect::<Vec<_>>();

        for name in above {
            if let Some((_, r)) = self.retrieve_node_source(current_source, ext, &name)? {
                let mut out = current_source.to_string();
                out.insert_str(line_end(current_source, r.end), &format!("\n\n{}", node_src));
                return Ok(Some(out));
            }
        }
        for name in below {
            if let Some((_, r)) = self.retrieve_node_source(current_source, ext, &name)? {
                let mut out = current_source.to_string();
                out.insert_str(line_start(current_source, r.start), &format!("{}\n\n", node_src));
                return Ok(Some(out));
            }
        }

        let mut out = current_source.to_string();
        if !out.ends_with('\n') {
            out.push('\n');
        }
        out.push('\n');
        out.push_str(&node_src);
        out.push('\n');
        Ok(Some(out))
    }
}

#[cfg(test)]
mod tests {
    use super::SemanticParser;

    const COMPONENT: &str = r#"
export function Card({ title }: { title: string }) {
  return <View style={{ flex: 1 }}><Text>{title}</Text></View>;
}

export function Separator() {
  return <View />;
}
"#;

    /// The bug this pins: a .tsx file parsed with the plain TypeScript grammar
    /// produces an error tree and therefore no nodes, and a file with no nodes
    /// reads downstream as a file whose every symbol was deleted.
    #[test]
    fn tsx_components_are_found_not_reported_missing() {
        let mut parser = SemanticParser::new().expect("parser");

        let nodes = parser.parse_file(COMPONENT, "tsx").expect("parse tsx");
        assert!(
            !nodes.is_empty(),
            "a .tsx file with two components parsed to no nodes at all"
        );

        let found = parser
            .retrieve_node_source(COMPONENT, "tsx", "Card")
            .expect("retrieve");
        let (src, _) = found.expect("Card should be found in its own file");
        assert!(src.contains("title"), "retrieved the wrong node: {src}");
    }

    /// TSX and TypeScript are different languages, not one language with a flag.
    /// Routing both at the same grammar is what caused the above.
    #[test]
    fn tsx_keeps_its_own_grammar_and_ts_keeps_the_plain_one() {
        let mut parser = SemanticParser::new().expect("parser");

        // Plain TypeScript has no JSX, so the tag is a parse error there. Asking
        // the ts grammar for a component in a tagged file must not succeed —
        // if it does, the two grammars have been collapsed into one again.
        let via_tsx = parser.parse_file(COMPONENT, "tsx").expect("parse tsx");
        let via_ts = parser.parse_file(COMPONENT, "ts").expect("parse ts");
        assert_eq!(via_tsx.len(), 2, "tsx grammar lost its JSX support");
        assert!(
            via_ts.len() < via_tsx.len(),
            "the plain TypeScript grammar read a tagged file as completely as the \
             TSX one did, which means both extensions are pointed at one grammar again"
        );

        // And a genuinely plain TypeScript file still parses through the ts arm.
        let plain = "export function add(a: number, b: number): number { return a + b; }";
        let nodes = parser.parse_file(plain, "ts").expect("parse ts");
        assert!(!nodes.is_empty(), "plain TypeScript stopped parsing");
    }
}
