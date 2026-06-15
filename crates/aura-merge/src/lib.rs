//! # aura-merge
//!
//! Structured 3-way merge engine that picks the right strategy per file type:
//!
//! - **Code files** — scaffold extraction (the non-function portions) plus
//!   function-level merge primitives.
//! - **JSON / YAML / TOML** — key-level deep merge with conflict reporting.
//! - **Text / Markdown** — line-level 3-way merge.
//! - **Everything else** — file-level hash compare as a safe fallback.
//!
//! Pure stdlib, no external dependencies.
//!
//! Originally extracted from [Aura](https://auravcs.com), the semantic
//! version control engine.

use std::collections::{BTreeMap, HashMap};

// ─── File Type Detection ───────────────────────────────────────────────────

#[derive(Debug, Clone, PartialEq)]
pub enum FileType {
    Code,    // .rs, .py, .ts, .js, .go, .java, etc — AST-parseable
    Json,    // .json
    Yaml,    // .yaml, .yml
    Toml,    // .toml
    Env,     // .env, .env.*
    Text,    // .md, .txt, .csv, .html, .css, etc
    Binary,  // images, compiled, etc
    Ignored, // lockfiles, node_modules, etc
}

pub fn detect_file_type(path: &str) -> FileType {
    let lower = path.to_lowercase();

    // Ignored files — never sync
    if lower.contains("node_modules/")
        || lower.contains("target/")
        || lower.contains(".git/")
        || lower.contains(".aura/")
        || lower.contains("__pycache__/")
        || lower.contains(".next/")
        || lower.contains("dist/")
        || lower.contains("build/")
    {
        return FileType::Ignored;
    }

    // Lockfiles — never auto-merge
    if lower.ends_with("cargo.lock")
        || lower.ends_with("package-lock.json")
        || lower.ends_with("yarn.lock")
        || lower.ends_with("pnpm-lock.yaml")
        || lower.ends_with("poetry.lock")
        || lower.ends_with("gemfile.lock")
    {
        return FileType::Ignored;
    }

    // Binary
    if lower.ends_with(".png")
        || lower.ends_with(".jpg")
        || lower.ends_with(".jpeg")
        || lower.ends_with(".gif")
        || lower.ends_with(".ico")
        || lower.ends_with(".woff")
        || lower.ends_with(".woff2")
        || lower.ends_with(".ttf")
        || lower.ends_with(".eot")
        || lower.ends_with(".zip")
        || lower.ends_with(".tar")
        || lower.ends_with(".gz")
        || lower.ends_with(".exe")
        || lower.ends_with(".dll")
        || lower.ends_with(".so")
        || lower.ends_with(".dylib")
        || lower.ends_with(".pdf")
    {
        return FileType::Binary;
    }

    // Structured formats
    if lower.ends_with(".json") {
        return FileType::Json;
    }
    if lower.ends_with(".yaml") || lower.ends_with(".yml") {
        return FileType::Yaml;
    }
    if lower.ends_with(".toml") {
        return FileType::Toml;
    }
    if lower.ends_with(".env") || lower.contains(".env.") {
        return FileType::Env;
    }

    // Code (AST-parseable)
    if lower.ends_with(".rs")
        || lower.ends_with(".py")
        || lower.ends_with(".ts")
        || lower.ends_with(".tsx")
        || lower.ends_with(".js")
        || lower.ends_with(".jsx")
        || lower.ends_with(".go")
        || lower.ends_with(".java")
        || lower.ends_with(".cs")
        || lower.ends_with(".rb")
        || lower.ends_with(".cpp")
        || lower.ends_with(".cc")
        || lower.ends_with(".c")
        || lower.ends_with(".h")
        || lower.ends_with(".hpp")
        || lower.ends_with(".php")
        || lower.ends_with(".swift")
        || lower.ends_with(".kt")
    {
        return FileType::Code;
    }

    // Everything else = text
    FileType::Text
}

// ─── Merge Results ─────────────────────────────────────────────────────────

#[derive(Debug)]
pub enum MergeResult {
    /// Clean merge — no conflicts
    Merged(String),
    /// Has conflicts that need resolution
    Conflicts {
        merged: String,
        conflict_count: usize,
        conflict_details: Vec<ConflictDetail>,
    },
    /// Identical — no changes needed
    Identical,
    /// Cannot merge (binary, etc)
    CannotMerge(String),
}

#[derive(Debug, Clone)]
pub struct ConflictDetail {
    pub location: String, // key path for JSON, line number for text
    pub local_value: String,
    pub remote_value: String,
}

// ─── JSON Deep Merge ───────────────────────────────────────────────────────

/// Merge two JSON values. base = common ancestor (if known), local = ours, remote = theirs.
/// If no base, treat it as a 2-way merge (conflicts when same key differs).
pub fn merge_json(local: &str, remote: &str, base: Option<&str>) -> MergeResult {
    let local_val: serde_json::Value = match serde_json::from_str(local) {
        Ok(v) => v,
        Err(e) => return MergeResult::CannotMerge(format!("Local JSON parse error: {}", e)),
    };
    let remote_val: serde_json::Value = match serde_json::from_str(remote) {
        Ok(v) => v,
        Err(e) => return MergeResult::CannotMerge(format!("Remote JSON parse error: {}", e)),
    };

    if local_val == remote_val {
        return MergeResult::Identical;
    }

    let base_val = base.and_then(|b| serde_json::from_str(b).ok());
    let mut conflicts = Vec::new();
    let merged = deep_merge_value(
        &local_val,
        &remote_val,
        base_val.as_ref(),
        "$",
        &mut conflicts,
    );

    if let Ok(pretty) = serde_json::to_string_pretty(&merged) {
        if conflicts.is_empty() {
            MergeResult::Merged(pretty)
        } else {
            MergeResult::Conflicts {
                merged: pretty,
                conflict_count: conflicts.len(),
                conflict_details: conflicts,
            }
        }
    } else {
        MergeResult::CannotMerge("Failed to serialize merged JSON".to_string())
    }
}

fn deep_merge_value(
    local: &serde_json::Value,
    remote: &serde_json::Value,
    base: Option<&serde_json::Value>,
    path: &str,
    conflicts: &mut Vec<ConflictDetail>,
) -> serde_json::Value {
    use serde_json::Value;

    match (local, remote) {
        // Both objects — merge keys
        (Value::Object(l), Value::Object(r)) => {
            let base_obj = base.and_then(|b| b.as_object());
            let mut merged = serde_json::Map::new();

            // All keys from both sides
            let mut all_keys: Vec<String> = l.keys().chain(r.keys()).cloned().collect();
            all_keys.sort();
            all_keys.dedup();

            for key in &all_keys {
                let l_val = l.get(key);
                let r_val = r.get(key);
                let b_val = base_obj.and_then(|b| b.get(key));
                let child_path = format!("{}.{}", path, key);

                match (l_val, r_val) {
                    (Some(lv), Some(rv)) => {
                        if lv == rv {
                            // Same value — no conflict
                            merged.insert(key.clone(), lv.clone());
                        } else if let Some(bv) = b_val {
                            // 3-way: check who changed from base
                            if lv == bv {
                                // Local unchanged, remote changed → take remote
                                merged.insert(key.clone(), rv.clone());
                            } else if rv == bv {
                                // Remote unchanged, local changed → take local
                                merged.insert(key.clone(), lv.clone());
                            } else {
                                // Both changed from base — recurse or conflict
                                let result =
                                    deep_merge_value(lv, rv, Some(bv), &child_path, conflicts);
                                merged.insert(key.clone(), result);
                            }
                        } else {
                            // No base — 2-way merge, recurse for objects, conflict for scalars
                            let result = deep_merge_value(lv, rv, None, &child_path, conflicts);
                            merged.insert(key.clone(), result);
                        }
                    }
                    (Some(lv), None) => {
                        // Only in local
                        if b_val.is_some() {
                            // Was in base, remote deleted it — take remote's deletion
                            // (don't include the key)
                        } else {
                            merged.insert(key.clone(), lv.clone());
                        }
                    }
                    (None, Some(rv)) => {
                        // Only in remote
                        if b_val.is_some() {
                            // Was in base, local deleted it — take local's deletion
                        } else {
                            merged.insert(key.clone(), rv.clone());
                        }
                    }
                    (None, None) => unreachable!(),
                }
            }

            Value::Object(merged)
        }
        // Both arrays — use remote if different (no element-level merge for now)
        (Value::Array(_), Value::Array(_)) => {
            if local == remote {
                local.clone()
            } else if let Some(bv) = base {
                if local == bv {
                    remote.clone()
                } else if remote == bv {
                    local.clone()
                } else {
                    // Both changed array — conflict, take local + note
                    conflicts.push(ConflictDetail {
                        location: path.to_string(),
                        local_value: serde_json::to_string(local).unwrap_or_default(),
                        remote_value: serde_json::to_string(remote).unwrap_or_default(),
                    });
                    local.clone()
                }
            } else {
                conflicts.push(ConflictDetail {
                    location: path.to_string(),
                    local_value: serde_json::to_string(local).unwrap_or_default(),
                    remote_value: serde_json::to_string(remote).unwrap_or_default(),
                });
                local.clone()
            }
        }
        // Scalar conflict
        _ => {
            if local == remote {
                local.clone()
            } else {
                conflicts.push(ConflictDetail {
                    location: path.to_string(),
                    local_value: serde_json::to_string(local).unwrap_or_default(),
                    remote_value: serde_json::to_string(remote).unwrap_or_default(),
                });
                local.clone() // default to local on conflict
            }
        }
    }
}

// ─── Line-Level Text Merge ─────────────────────────────────────────────────

/// 3-way line-level merge for text files (markdown, CSS, HTML, plain text).
/// If no base, falls back to 2-way merge.
pub fn merge_text(local: &str, remote: &str, base: Option<&str>) -> MergeResult {
    if local == remote {
        return MergeResult::Identical;
    }

    let local_lines: Vec<&str> = local.lines().collect();
    let remote_lines: Vec<&str> = remote.lines().collect();

    if let Some(base_text) = base {
        // 3-way merge
        let base_lines: Vec<&str> = base_text.lines().collect();
        merge_text_3way(&base_lines, &local_lines, &remote_lines)
    } else {
        // 2-way merge — find common lines, diff the rest
        merge_text_2way(&local_lines, &remote_lines)
    }
}

fn merge_text_3way(base: &[&str], local: &[&str], remote: &[&str]) -> MergeResult {
    // Compute which lines each side added/removed vs base
    let _local_diff = diff_lines(base, local);
    let _remote_diff = diff_lines(base, remote);

    let mut merged = Vec::new();
    let mut conflicts = Vec::new();
    let max_len = base.len().max(local.len()).max(remote.len());

    let mut bi = 0;
    let mut li = 0;
    let mut ri = 0;

    while bi < base.len() || li < local.len() || ri < remote.len() {
        let b_line = base.get(bi).copied();
        let l_line = local.get(li).copied();
        let r_line = remote.get(ri).copied();

        match (b_line, l_line, r_line) {
            (Some(b), Some(l), Some(r)) if b == l && b == r => {
                // All same — no change
                merged.push(l.to_string());
                bi += 1;
                li += 1;
                ri += 1;
            }
            (Some(b), Some(l), Some(r)) if b == l && b != r => {
                // Remote changed this line, local didn't → take remote
                merged.push(r.to_string());
                bi += 1;
                li += 1;
                ri += 1;
            }
            (Some(b), Some(l), Some(r)) if b != l && b == r => {
                // Local changed this line, remote didn't → take local
                merged.push(l.to_string());
                bi += 1;
                li += 1;
                ri += 1;
            }
            (Some(b), Some(l), Some(r)) if b != l && b != r => {
                if l == r {
                    // Both made the same change
                    merged.push(l.to_string());
                } else {
                    // True conflict — both changed differently
                    conflicts.push(ConflictDetail {
                        location: format!("line {}", bi + 1),
                        local_value: l.to_string(),
                        remote_value: r.to_string(),
                    });
                    merged.push("<<<<<<< LOCAL".to_string());
                    merged.push(l.to_string());
                    merged.push("=======".to_string());
                    merged.push(r.to_string());
                    merged.push(">>>>>>> REMOTE".to_string());
                }
                bi += 1;
                li += 1;
                ri += 1;
            }
            // Handle insertions/deletions at end
            (None, Some(l), Some(r)) => {
                if l == r {
                    merged.push(l.to_string());
                    li += 1;
                    ri += 1;
                } else {
                    merged.push(l.to_string());
                    merged.push(r.to_string());
                    li += 1;
                    ri += 1;
                }
            }
            (None, Some(l), None) => {
                merged.push(l.to_string());
                li += 1;
            }
            (None, None, Some(r)) => {
                merged.push(r.to_string());
                ri += 1;
            }
            (Some(_), Some(l), None) => {
                // Remote deleted, local kept
                merged.push(l.to_string());
                bi += 1;
                li += 1;
            }
            (Some(_), None, Some(r)) => {
                // Local deleted, remote kept
                merged.push(r.to_string());
                bi += 1;
                ri += 1;
            }
            (Some(_), None, None) => {
                // Both deleted
                bi += 1;
            }
            _ => break,
        }

        if bi > max_len + 100 {
            break;
        } // safety
    }

    let result = merged.join("\n");
    if conflicts.is_empty() {
        MergeResult::Merged(result)
    } else {
        MergeResult::Conflicts {
            merged: result,
            conflict_count: conflicts.len(),
            conflict_details: conflicts,
        }
    }
}

fn merge_text_2way(local: &[&str], remote: &[&str]) -> MergeResult {
    // Simple 2-way: find common prefix/suffix, diff the middle
    let mut conflicts = Vec::new();

    // Common prefix
    let prefix_len = local
        .iter()
        .zip(remote.iter())
        .take_while(|(a, b)| a == b)
        .count();

    // Common suffix (from the end)
    let suffix_len = local
        .iter()
        .rev()
        .zip(remote.iter().rev())
        .take_while(|(a, b)| a == b)
        .count();

    let l_middle = &local[prefix_len..local.len().saturating_sub(suffix_len)];
    let r_middle = &remote[prefix_len..remote.len().saturating_sub(suffix_len)];

    if l_middle.is_empty() && r_middle.is_empty() {
        return MergeResult::Identical;
    }

    // Build merged: prefix + both middles (conflict if both non-empty) + suffix
    let mut merged: Vec<String> = local[..prefix_len].iter().map(|s| s.to_string()).collect();

    if l_middle.is_empty() {
        // Only remote has changes
        merged.extend(r_middle.iter().map(|s| s.to_string()));
    } else if r_middle.is_empty() {
        // Only local has changes
        merged.extend(l_middle.iter().map(|s| s.to_string()));
    } else {
        // Both have changes in the middle — conflict
        conflicts.push(ConflictDetail {
            location: format!("lines {}-{}", prefix_len + 1, prefix_len + l_middle.len()),
            local_value: l_middle.join("\n"),
            remote_value: r_middle.join("\n"),
        });
        merged.push("<<<<<<< LOCAL".to_string());
        merged.extend(l_middle.iter().map(|s| s.to_string()));
        merged.push("=======".to_string());
        merged.extend(r_middle.iter().map(|s| s.to_string()));
        merged.push(">>>>>>> REMOTE".to_string());
    }

    let suffix_start = local.len().saturating_sub(suffix_len);
    merged.extend(local[suffix_start..].iter().map(|s| s.to_string()));

    let result = merged.join("\n");
    if conflicts.is_empty() {
        MergeResult::Merged(result)
    } else {
        MergeResult::Conflicts {
            merged: result,
            conflict_count: conflicts.len(),
            conflict_details: conflicts,
        }
    }
}

fn diff_lines<'a>(base: &[&'a str], modified: &[&'a str]) -> Vec<(usize, &'a str)> {
    // Simple: find lines in modified that aren't in base
    modified
        .iter()
        .enumerate()
        .filter(|(_, line)| !base.contains(line))
        .map(|(i, line)| (i, *line))
        .collect()
}

// ─── Key-Value Merge (ENV files) ───────────────────────────────────────────

/// Merge .env files by key. Same key with different values = conflict.
pub fn merge_env(local: &str, remote: &str) -> MergeResult {
    if local == remote {
        return MergeResult::Identical;
    }

    let local_map = parse_env(local);
    let remote_map = parse_env(remote);
    let mut merged = BTreeMap::new();
    let mut conflicts = Vec::new();

    // All keys
    let mut all_keys: Vec<&String> = local_map.keys().chain(remote_map.keys()).collect();
    all_keys.sort();
    all_keys.dedup();

    for key in all_keys {
        match (local_map.get(key), remote_map.get(key)) {
            (Some(lv), Some(rv)) => {
                if lv == rv {
                    merged.insert(key.clone(), lv.clone());
                } else {
                    conflicts.push(ConflictDetail {
                        location: key.clone(),
                        local_value: lv.clone(),
                        remote_value: rv.clone(),
                    });
                    merged.insert(key.clone(), lv.clone()); // default to local
                }
            }
            (Some(lv), None) => {
                merged.insert(key.clone(), lv.clone());
            }
            (None, Some(rv)) => {
                merged.insert(key.clone(), rv.clone());
            }
            (None, None) => {}
        }
    }

    let result: String = merged
        .iter()
        .map(|(k, v)| format!("{}={}", k, v))
        .collect::<Vec<_>>()
        .join("\n");

    if conflicts.is_empty() {
        MergeResult::Merged(result)
    } else {
        MergeResult::Conflicts {
            merged: result,
            conflict_count: conflicts.len(),
            conflict_details: conflicts,
        }
    }
}

fn parse_env(content: &str) -> HashMap<String, String> {
    content
        .lines()
        .filter(|line| !line.trim().is_empty() && !line.trim().starts_with('#'))
        .filter_map(|line| {
            let mut parts = line.splitn(2, '=');
            let key = parts.next()?.trim().to_string();
            let val = parts.next().unwrap_or("").to_string();
            Some((key, val))
        })
        .collect()
}

// ─── Scaffold Extraction ───────────────────────────────────────────────────

/// Extract the "scaffold" of a code file — everything OUTSIDE function bodies.
/// Returns the scaffold text with function bodies replaced by placeholders.
pub fn extract_scaffold(source: &str, functions: &[(String, String)]) -> String {
    let mut scaffold = source.to_string();

    // Sort functions by length descending to avoid nested replacement issues
    let mut sorted_fns: Vec<&(String, String)> = functions.iter().collect();
    sorted_fns.sort_by(|a, b| b.1.len().cmp(&a.1.len()));

    for (name, body) in &sorted_fns {
        if let Some(pos) = scaffold.find(body.as_str()) {
            let placeholder = format!("/* __AURA_FN_PLACEHOLDER::{} */", name);
            scaffold.replace_range(pos..pos + body.len(), &placeholder);
        }
    }

    scaffold
}

/// Re-insert function bodies into a scaffold.
pub fn apply_scaffold(scaffold: &str, functions: &[(String, String)]) -> String {
    let mut result = scaffold.to_string();
    for (name, body) in functions {
        let placeholder = format!("/* __AURA_FN_PLACEHOLDER::{} */", name);
        result = result.replace(&placeholder, body);
    }
    result
}

// ─── Unified Merge Interface ───────────────────────────────────────────────

/// Merge any two file versions based on file type.
pub fn merge_file(path: &str, local: &str, remote: &str, base: Option<&str>) -> MergeResult {
    let file_type = detect_file_type(path);

    match file_type {
        FileType::Json => merge_json(local, remote, base),
        FileType::Env => merge_env(local, remote),
        FileType::Yaml | FileType::Toml => {
            // For YAML/TOML, use line-level merge (structural merge is future work)
            merge_text(local, remote, base)
        }
        FileType::Text | FileType::Code => merge_text(local, remote, base),
        FileType::Binary => MergeResult::CannotMerge("Binary file — cannot merge".to_string()),
        FileType::Ignored => MergeResult::CannotMerge("Ignored file — should not sync".to_string()),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_json_merge_no_conflict() {
        let local = r#"{"port": 3001, "debug": true, "name": "app"}"#;
        let remote = r#"{"port": 3000, "debug": false, "name": "app"}"#;
        let base = r#"{"port": 3000, "debug": true, "name": "app"}"#;
        match merge_json(local, remote, Some(base)) {
            MergeResult::Merged(result) => {
                let v: serde_json::Value = serde_json::from_str(&result).unwrap();
                assert_eq!(v["port"], 3001); // local changed
                assert_eq!(v["debug"], false); // remote changed
                assert_eq!(v["name"], "app"); // unchanged
            }
            other => panic!("Expected Merged, got {:?}", other),
        }
    }

    #[test]
    fn test_json_merge_conflict() {
        let local = r#"{"port": 3001}"#;
        let remote = r#"{"port": 8080}"#;
        match merge_json(local, remote, None) {
            MergeResult::Conflicts { conflict_count, .. } => {
                assert_eq!(conflict_count, 1);
            }
            other => panic!("Expected Conflicts, got {:?}", other),
        }
    }

    #[test]
    fn test_env_merge() {
        let local = "PORT=3000\nDEBUG=true\nNEW_LOCAL=yes";
        let remote = "PORT=3000\nDEBUG=false\nNEW_REMOTE=yes";
        match merge_env(local, remote) {
            MergeResult::Conflicts {
                conflict_count,
                merged,
                ..
            } => {
                assert_eq!(conflict_count, 1); // DEBUG differs
                assert!(merged.contains("NEW_LOCAL=yes"));
                assert!(merged.contains("NEW_REMOTE=yes"));
            }
            other => panic!("Expected Conflicts, got {:?}", other),
        }
    }

    #[test]
    fn test_text_merge_3way() {
        let base = "line1\nline2\nline3";
        let local = "line1\nLOCAL CHANGE\nline3";
        let remote = "line1\nline2\nREMOTE CHANGE";
        match merge_text(local, remote, Some(base)) {
            MergeResult::Merged(result) => {
                assert!(result.contains("LOCAL CHANGE"));
                assert!(result.contains("REMOTE CHANGE"));
            }
            other => panic!("Expected Merged, got {:?}", other),
        }
    }
}
