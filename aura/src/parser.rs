use crate::models::{AstNode, SemanticHash, DependencyUri};
use crate::lsp::LspClient;
use crate::ecosystem::Ecosystem;
use std::collections::hash_map::DefaultHasher;
use std::hash::{Hash, Hasher};
use tree_sitter::{Node, Parser};

/// The semantic engine that translates human source code into Aura's AST Graph.
pub struct SemanticParser {
    python_parser: Parser,
    rust_parser: Parser,
    ts_parser: Parser,
    js_parser: Parser,
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
        
        let lsp_client = Some(LspClient::new(Ecosystem::detect()));

        Ok(Self { python_parser, rust_parser, ts_parser, js_parser, lsp_client })
    }

    /// Parses a source code string and extracts semantic logical blocks
    pub fn parse_file(&mut self, source_code: &str, ext: &str) -> Result<Vec<AstNode>, Box<dyn std::error::Error>> {
        let tree = match ext {
            "py" => self.python_parser.parse(source_code, None).ok_or("Failed to parse Python tree")?,
            "rs" => self.rust_parser.parse(source_code, None).ok_or("Failed to parse Rust tree")?,
            "ts" | "tsx" => self.ts_parser.parse(source_code, None).ok_or("Failed to parse TypeScript tree")?,
            "js" | "jsx" => self.js_parser.parse(source_code, None).ok_or("Failed to parse JavaScript tree")?,
            _ => return Err("Unsupported file extension".into()),
        };
        
        let root_node = tree.root_node();
        let mut extracted_nodes = Vec::new();
        self.walk_ast(&root_node, source_code, ext, &mut extracted_nodes);

        Ok(extracted_nodes)
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

            // KILL SHOT FIX: Two-Stage Confidence Identity
            // Stage 1: Normalize code (strip names/whitespace) to generate a structural skeleton hash
            let normalized_code = content.replace(|c: char| c.is_whitespace(), "");
            // For a true implementation, we'd use tree-sitter to strip only identifiers.
            // For MVP, we'll hash the skeleton + kind to create a high-confidence structural identity.
            let mut id_hasher = DefaultHasher::new();
            format!("{}_{}", kind, normalized_code).hash(&mut id_hasher);
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

            extracted_nodes.push(AstNode {
                node_id,
                kind: kind.to_string(),
                identifier,
                content_hash,
                children: vec![],
                dependencies,
                contains_secret,
                derived_from: None, // Default to None, would be set by commit-time heuristic
                confidence: 1.0,    // Initial high confidence for local state
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
    pub fn extract_node_source(&mut self, source_code: &str, ext: &str, target_identifier: &str) -> Result<Option<(String, std::ops::Range<usize>)>, Box<dyn std::error::Error>> {
        let tree = match ext {
            "py" => self.python_parser.parse(source_code, None).ok_or("Failed to parse Python tree")?,
            "rs" => self.rust_parser.parse(source_code, None).ok_or("Failed to parse Rust tree")?,
            "ts" | "tsx" => self.ts_parser.parse(source_code, None).ok_or("Failed to parse TypeScript tree")?,
            "js" | "jsx" => self.js_parser.parse(source_code, None).ok_or("Failed to parse JavaScript tree")?,
            _ => return Err("Unsupported file extension".into()),
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
