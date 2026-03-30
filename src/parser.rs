use crate::models::{AstNode, SemanticHash, DependencyUri};
use crate::lsp::LspClient;
use crate::ecosystem::Ecosystem;
use std::collections::hash_map::DefaultHasher;
use std::collections::HashSet;
use std::hash::{Hash, Hasher};
use tree_sitter::{Node, Parser};

/// The semantic engine that translates human source code into Aura's AST Graph.
pub struct SemanticParser {
    python_parser: Parser,
    rust_parser: Parser,
    ts_parser: Parser,
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
            python_parser, rust_parser, ts_parser, js_parser,
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

    pub fn parse_file(&mut self, source_code: &str, ext: &str) -> Result<Vec<AstNode>, Box<dyn std::error::Error>> {
        let tree = match ext {
            "py" => self.python_parser.parse(source_code, None).ok_or("Failed to parse Python tree")?,
            "rs" => self.rust_parser.parse(source_code, None).ok_or("Failed to parse Rust tree")?,
            "ts" | "tsx" => self.ts_parser.parse(source_code, None).ok_or("Failed to parse TypeScript tree")?,
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

        let root_node = tree.root_node();
        let mut extracted_nodes = Vec::new();
        self.walk_ast(&root_node, source_code, ext, &mut extracted_nodes);

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

    /// Recursively walks the AST to find semantic blocks (functions, classes, structs)
    fn walk_ast(&self, node: &Node, source_code: &str, ext: &str, extracted_nodes: &mut Vec<AstNode>) {
        let kind = node.kind();

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

            let mut hasher = DefaultHasher::new();
            content.hash(&mut hasher);
            let content_hash: SemanticHash = format!("ast_{:x}", hasher.finish());

            // KILL SHOT FIX: Two-Stage Rename-Proof Identity
            // Stage 1: Generate Structural ID by masking the identifier name
            let mut skeleton = content.replace(|c: char| c.is_whitespace(), "");
            if let Some(ref id) = identifier {
                skeleton = skeleton.replace(id, "__ASL_IDENTIFIER__");
            }
            
            let mut id_hasher = DefaultHasher::new();
            format!("{}_{}", kind, skeleton).hash(&mut id_hasher);
            let node_id = format!("node_{:x}", id_hasher.finish());

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
            });
        }

        // Walk deeper
        let mut cursor = node.walk();
        for child in node.children(&mut cursor) {
            self.walk_ast(&child, source_code, ext, extracted_nodes);
        }
    }

    /// Finds a specific node by its identifier and returns its full source code string and byte range.
    /// Used for Semantic Rewind.
    pub fn retrieve_node_source(&mut self, source_code: &str, ext: &str, target_identifier: &str) -> Result<Option<(String, std::ops::Range<usize>)>, Box<dyn std::error::Error>> {
        let tree = match ext {
            "py" => self.python_parser.parse(source_code, None).ok_or("Failed to parse Python tree")?,
            "rs" => self.rust_parser.parse(source_code, None).ok_or("Failed to parse Rust tree")?,
            "ts" | "tsx" => self.ts_parser.parse(source_code, None).ok_or("Failed to parse TypeScript tree")?,
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

        let root_node = tree.root_node();
        Ok(self.find_node_source(&root_node, source_code, ext, target_identifier))
    }

    fn find_node_source(&self, node: &Node, source_code: &str, ext: &str, target_identifier: &str) -> Option<(String, std::ops::Range<usize>)> {
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

        let mut cursor = node.walk();
        for child in node.children(&mut cursor) {
            if let Some(found) = self.find_node_source(&child, source_code, ext, target_identifier) {
                return Some(found);
            }
        }
        None
    }
}
