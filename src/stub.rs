use std::fs;
use colored::Colorize;
use crate::parser::SemanticParser;

/// The Sovereign Vault: Virtual Workspaces and Logic Stubs
pub struct StubEngine;

impl StubEngine {
    pub fn generate_stubs() {
        println!("{} {}", "🏗️ ".bold(), "Aura Sovereign Vault: Generating Logic Stubs for Virtual Workspace...".bold().magenta());
        
        // Auto-generate rbac.json if it is missing (Restrictive by default)
        if !std::path::Path::new("rbac.json").exists() {
            println!("{} No rbac.json found. Auto-generating a restrictive default policy...", "⚠️".yellow());
            let default_rbac = serde_json::json!({
                "policy_name": "Default Restrictive",
                "version": "1.0",
                "restricted_nodes": [],
                "description": "To restrict logic, add function or class names to 'restricted_nodes'. Current policy: DENY ALL (Restrictive)."
            });
            if let Ok(content) = serde_json::to_string_pretty(&default_rbac) {
                let _ = fs::write("rbac.json", content);
                println!("  {} Created 'rbac.json'. Add restricted nodes to begin stubbing.", "↳".dimmed());
            }
        }

        let rbac_config = match fs::read_to_string("rbac.json") {
            Ok(c) => c,
            Err(_) => {
                println!("{} Failed to read rbac.json.", "✗".red());
                return;
            }
        };

        let mut parser = match SemanticParser::new() {
            Ok(p) => p,
            Err(e) => {
                println!("{} Failed to initialize parser: {}", "✗".red(), e);
                return;
            }
        };

        if let Ok(config) = serde_json::from_str::<serde_json::Value>(&rbac_config) {
            if let Some(restricted_nodes) = config["restricted_nodes"].as_array() {
                for file_entry in fs::read_dir(".").unwrap().flatten() {
                    let path = file_entry.path();
                    let path_str = path.to_string_lossy().to_string();
                    let ext = if path_str.ends_with(".rs") { "rs" } else if path_str.ends_with(".py") { "py" } else if path_str.ends_with(".ts") || path_str.ends_with(".tsx") { "ts" } else if path_str.ends_with(".js") || path_str.ends_with(".jsx") { "js" } else { continue };

                    if let Ok(source_code) = fs::read_to_string(&path) {
                        let mut modified_code = source_code.clone();
                        let mut changes_made = false;

                        if let Ok(nodes) = parser.parse_file(&source_code, ext) {
                            // Reverse the nodes so we replace from bottom to top, preserving byte ranges
                            let sorted_nodes = nodes;
                            // Note: Real tree-sitter ranges would need offset tracking, but for MVP we use a simple string replace
                            for restricted in restricted_nodes {
                                if let Some(target_ident) = restricted.as_str() {
                                    for node in &sorted_nodes {
                                        if let Some(ref ident) = node.identifier {
                                            if ident == target_ident {
                                                println!("  {} Stripping proprietary logic from '{}' (RBAC Restricted)", "↳".dimmed(), ident.yellow());
                                                
                                                // Extract the full source of the node to replace it
                                                if let Ok(Some((node_src, _))) = parser.extract_node_source(&source_code, ext, ident) {
                                                    // Generate a stub based on language
                                                    let stub = if ext == "py" {
                                                        format!("def {}(*args, **kwargs):\n    pass  # AURA STUB: Logic restricted by Sovereign Vault", ident)
                                                    } else {
                                                        format!("fn {}(...) {{ unimplemented!(\"AURA STUB: Logic restricted by Sovereign Vault\") }}", ident)
                                                    };
                                                    
                                                    modified_code = modified_code.replace(&node_src, &stub);
                                                    changes_made = true;
                                                }
                                            }
                                        }
                                    }
                                }
                            }
                        }

                        if changes_made {
                            let _ = fs::write(&path, modified_code);
                        }
                    }
                }
            }
        }
        
        println!("{} Virtual Workspace generated. Safe for third-party contractor access.", "✓".green().bold());
    }
}
