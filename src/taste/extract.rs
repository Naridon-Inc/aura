// Template extractors for the Taste Engine.
//
// One pure function per template. Each takes (before, after, scope)
// and emits zero or more Hits. Hits become Observation rows in
// `.aura/taste/observations.jsonl`.
//
// Phase 0 ships four templates — enough to demonstrate the loop
// across Rust + TS/JS + general formatting:
//   - error_handling.with_context    (Rust)
//   - naming.exports                 (TS/JS)
//   - imports.style                  (TS/JS)
//   - formatting.indent              (any text file)
//
// Templates are deliberately cheap (regex / line-prefix scans). No
// AST, no LLM. The aggregator handles confidence + decay; extractors
// just report what they see.

use serde_json::json;

/// File-level context passed to every extractor.
pub struct Scope {
    pub file_path: String,
    pub language: String,
    pub layer: String,
}

/// One template hit. `detail` is template-specific JSON.
pub struct Hit {
    pub template: String,
    pub detail: serde_json::Value,
}

/// Run every template that applies to this scope. Templates that
/// don't match the scope's language are skipped internally.
pub fn run_all(before: &str, after: &str, scope: &Scope) -> Vec<Hit> {
    let mut out = Vec::new();
    out.extend(error_handling_with_context(before, after, scope));
    out.extend(naming_exports(before, after, scope));
    out.extend(imports_style(before, after, scope));
    out.extend(formatting_indent(before, after, scope));
    out
}

/// Map file extension → coarse language tag. Empty string means
/// "skip this file" (binary, lockfile, unknown).
pub fn detect_language(path: &str) -> String {
    let lower = path.to_lowercase();
    if lower.ends_with(".lock") || lower.ends_with("lock.json") || lower.ends_with("lock.yaml") {
        return String::new();
    }
    let ext = lower.rsplit('.').next().unwrap_or("");
    match ext {
        "rs" => "rust".into(),
        "ts" | "tsx" => "typescript".into(),
        "js" | "jsx" | "mjs" | "cjs" => "javascript".into(),
        "py" => "python".into(),
        "go" => "go".into(),
        "sh" | "bash" | "zsh" => "shell".into(),
        "md" => "markdown".into(),
        "json" => "json".into(),
        "yaml" | "yml" => "yaml".into(),
        "toml" => "toml".into(),
        _ => String::new(),
    }
}

/// Bucket the file into a coarse architectural layer. Used as a
/// secondary scope key so a rule can apply to "frontend rust" vs
/// "backend rust" independently. Cheap path-prefix heuristics.
pub fn detect_layer(path: &str) -> String {
    let p = path.to_lowercase();
    if p.contains("/migrations/") || p.contains("/db/") || p.contains("/schema") {
        "data".into()
    } else if p.contains("test") || p.contains("spec") {
        "test".into()
    } else if p.contains("/src-tauri/") || p.contains("/server/") || p.contains("/api/") || p.contains("/backend/") {
        "backend".into()
    } else if p.contains("/components/") || p.contains("/pages/") || p.contains("/ui/") || p.ends_with(".tsx") || p.ends_with(".jsx") {
        "frontend".into()
    } else if p.starts_with("scripts/") || p.contains("/scripts/") {
        "scripts".into()
    } else {
        "core".into()
    }
}

// --- Template 1: Rust error handling ----------------------------------------
//
// Counts bare `?` vs `.context("...")?` / `.with_context(...)?` in the
// added lines. Emits a hit per added pattern so the aggregator sees
// the ratio drift over many commits.
fn error_handling_with_context(before: &str, after: &str, scope: &Scope) -> Vec<Hit> {
    if scope.language != "rust" {
        return vec![];
    }
    let added: Vec<&str> = added_lines(before, after);
    let mut bare = 0u32;
    let mut with_ctx = 0u32;
    for line in &added {
        let t = line.trim();
        if t.starts_with("//") {
            continue;
        }
        if t.contains(".context(") || t.contains(".with_context(") {
            with_ctx += 1;
        } else if t.ends_with('?') || t.contains("?;") {
            bare += 1;
        }
    }
    if bare == 0 && with_ctx == 0 {
        return vec![];
    }
    vec![Hit {
        template: "error_handling.with_context".into(),
        detail: json!({ "bare": bare, "with_context": with_ctx }),
    }]
}

// --- Template 2: TS/JS export style -----------------------------------------
//
// Counts `export default` vs `export const|function|class|...` in the
// added lines. The aggregator turns the ratio into a "prefer named
// exports" rule (or the inverse) per layer.
fn naming_exports(before: &str, after: &str, scope: &Scope) -> Vec<Hit> {
    if scope.language != "typescript" && scope.language != "javascript" {
        return vec![];
    }
    let added = added_lines(before, after);
    let mut named = 0u32;
    let mut default = 0u32;
    for line in &added {
        let t = line.trim_start();
        if t.starts_with("//") {
            continue;
        }
        if t.starts_with("export default") {
            default += 1;
        } else if t.starts_with("export const")
            || t.starts_with("export function")
            || t.starts_with("export async function")
            || t.starts_with("export class")
            || t.starts_with("export type")
            || t.starts_with("export interface")
            || t.starts_with("export enum")
        {
            named += 1;
        }
    }
    if named == 0 && default == 0 {
        return vec![];
    }
    vec![Hit {
        template: "naming.exports".into(),
        detail: json!({ "named": named, "default": default }),
    }]
}

// --- Template 3: TS/JS import style -----------------------------------------
//
// Distinguishes `import * as X from "..."` (namespace) from
// `import { a, b } from "..."` (named) and `import X from "..."`
// (default). The aggregator surfaces the dominant style per layer.
fn imports_style(before: &str, after: &str, scope: &Scope) -> Vec<Hit> {
    if scope.language != "typescript" && scope.language != "javascript" {
        return vec![];
    }
    let added = added_lines(before, after);
    let mut namespace = 0u32;
    let mut named = 0u32;
    let mut default = 0u32;
    for line in &added {
        let t = line.trim_start();
        if !t.starts_with("import ") {
            continue;
        }
        if t.contains("* as ") {
            namespace += 1;
        } else if t.contains('{') {
            named += 1;
        } else {
            // `import X from "..."` or side-effect `import "..."`
            // Only count the former as "default" — bare side-effect
            // imports don't carry a style preference.
            if !t.starts_with("import \"") && !t.starts_with("import '") {
                default += 1;
            }
        }
    }
    if namespace == 0 && named == 0 && default == 0 {
        return vec![];
    }
    vec![Hit {
        template: "imports.style".into(),
        detail: json!({
            "namespace": namespace,
            "named": named,
            "default": default,
        }),
    }]
}

// --- Template 4: indent width -----------------------------------------------
//
// Detects the dominant leading-whitespace step (2 vs 4 spaces, or
// tab) on the lines the commit added. Only scanning added lines —
// not the whole after-image — means a small edit to a large file
// doesn't cast a stadium-sized vote for the existing style; the
// observation reflects what the contributor actually typed.
fn formatting_indent(before: &str, after: &str, scope: &Scope) -> Vec<Hit> {
    if scope.language.is_empty() || scope.language == "json" {
        return vec![];
    }
    let added = added_lines(before, after);

    // Collect every distinct non-zero space-indent width from the
    // added lines. The dominant indent unit is the GCD of these
    // widths — a 2-space project nesting 4 levels deep produces
    // widths {2,4,6,8,10}; GCD = 2. A 4-space project produces
    // {4,8,12,16}; GCD = 4. Naïve "count modulo 4" is wrong because
    // 8 is divisible by 4 and pulls a 2-space file into the 4-space
    // bucket.
    let mut widths: std::collections::BTreeSet<u32> = std::collections::BTreeSet::new();
    let mut tabs = 0u32;
    let mut space_lines = 0u32;
    for line in &added {
        let trimmed = line.trim_start();
        if trimmed.is_empty() {
            continue;
        }
        let leading: String = line.chars().take_while(|c| *c == ' ' || *c == '\t').collect();
        if leading.is_empty() {
            continue;
        }
        if leading.starts_with('\t') {
            tabs += 1;
        } else {
            space_lines += 1;
            widths.insert(leading.len() as u32);
        }
    }
    if tabs + space_lines < 4 {
        return vec![];
    }
    let dominant = if tabs > space_lines {
        "tab".to_string()
    } else if widths.is_empty() {
        return vec![];
    } else {
        let mut g = 0u32;
        for w in &widths {
            g = gcd(g, *w);
        }
        match g {
            2 => "2".into(),
            4 => "4".into(),
            8 => "8".into(),
            other => other.to_string(),
        }
    };
    vec![Hit {
        template: "formatting.indent".into(),
        detail: json!({
            "dominant": dominant,
            "tabs": tabs,
            "space_lines": space_lines,
            "widths": widths.iter().copied().collect::<Vec<u32>>(),
        }),
    }]
}

fn gcd(a: u32, b: u32) -> u32 {
    if b == 0 { a } else { gcd(b, a % b) }
}

// --- helpers ----------------------------------------------------------------
//
// Cheap line-set diff: lines present in `after` but not in `before`.
// Good enough for v1 — we don't need true LCS; we only care which
// lines the agent newly introduced. False positives (a line moved
// from one place to another) bias toward over-reporting, which is
// fine because the aggregator weights by ratio over many commits.
fn added_lines<'a>(before: &str, after: &'a str) -> Vec<&'a str> {
    use std::collections::HashSet;
    let before_set: HashSet<&str> = before.lines().collect();
    after.lines().filter(|l| !before_set.contains(l)).collect()
}
