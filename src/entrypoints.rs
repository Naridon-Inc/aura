//! User-facing entry-point classification.
//!
//! Given an [`AstNode`] (a function, class, component, etc.) this module
//! decides whether the symbol is something a *user* directly touches — a
//! Tauri desktop command, an HTTP route handler, a CLI subcommand, a UI
//! component — and produces a plain-language feature label.
//!
//! The point is to translate a low-level operation like "deleting symbol
//! `sign_in`" into a human sentence like "breaks feature **Sign In**".
//!
//! ## Why content-peek?
//!
//! [`AstNode`] does not store decorators/attributes or the full body. To
//! recover signals like a `#[tauri::command]` attribute or an axum route
//! registration we open the node's source file and inspect a *bounded*
//! window of lines (the handful above `start_line` for attributes) or scan
//! for a route/subcommand table. Classification is only ever called on a
//! handful of reached nodes, so a few small file reads are acceptable.
//!
//! Reads are best-effort: on any failure we fall back to
//! path/kind/signature-only heuristics, and we never panic.

use std::cell::RefCell;
use std::collections::HashMap;
use std::path::Path;

use crate::models::AstNode;

/// The category of user-facing surface a symbol exposes.
#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Serialize)]
#[serde(rename_all = "snake_case")]
pub enum EntryKind {
    /// A `#[tauri::command]` exposed to the desktop frontend.
    TauriCommand,
    /// An HTTP route handler (axum / actix / etc.).
    HttpRoute,
    /// A clap CLI subcommand.
    CliCommand,
    /// A UI component or UI event handler (`.tsx` / `.jsx`).
    UiComponent,
    /// A public/exported API boundary (used sparingly as a fallback).
    PublicApi,
}

/// A classified user-facing entry point.
#[derive(Debug, Clone, serde::Serialize)]
pub struct EntryPoint {
    /// Which kind of surface this is.
    pub kind: EntryKind,
    /// Humanized feature label, e.g. `"Sign In"`, `"Reports Export"`.
    pub feature_name: String,
    /// The identifier of the entry symbol.
    pub entry_symbol: String,
    /// The source file path, or `""` if unknown.
    pub file: String,
}

// ---------------------------------------------------------------------------
// Bounded file reading with a tiny per-call memo.
// ---------------------------------------------------------------------------

thread_local! {
    /// Process/thread-local memo so repeated peeks at the same file during a
    /// single classification batch don't re-read from disk. This is a soft
    /// optimization, not a correctness requirement — a plain read would be
    /// acceptable. The map is keyed by the absolute/relative path string we
    /// actually opened.
    static FILE_MEMO: RefCell<HashMap<String, Option<String>>> = RefCell::new(HashMap::new());
}

/// Read a file's full contents, trying `file_path` joined under `repo_root`
/// first (when relative) and then the path as-is. Returns `None` on any
/// failure. Results are memoized per thread by the path string.
fn read_source(file_path: &str, repo_root: &Path) -> Option<String> {
    // Candidate paths to try, in order. We dedupe identical strings.
    let mut candidates: Vec<String> = Vec::new();

    let joined = repo_root.join(file_path);
    if let Some(s) = joined.to_str() {
        candidates.push(s.to_string());
    }
    // Also try the path exactly as given (covers already-absolute paths and
    // paths already relative to the current working directory).
    if !candidates.iter().any(|c| c == file_path) {
        candidates.push(file_path.to_string());
    }

    for cand in candidates {
        let cached = FILE_MEMO.with(|m| m.borrow().get(&cand).cloned());
        if let Some(hit) = cached {
            if hit.is_some() {
                return hit;
            }
            // A cached miss for this exact path: skip re-reading it, try next.
            continue;
        }

        let read = std::fs::read_to_string(&cand).ok();
        FILE_MEMO.with(|m| {
            m.borrow_mut().insert(cand.clone(), read.clone());
        });
        if read.is_some() {
            return read;
        }
    }

    None
}

/// Return the (1-based) lines strictly *above* `start_line`, up to `window`
/// of them, as a single joined string. Used to inspect attributes/decorators
/// that sit immediately above a node. Empty string when nothing applies.
fn lines_above(content: &str, start_line: u32, window: usize) -> String {
    if start_line <= 1 {
        return String::new();
    }
    let lines: Vec<&str> = content.lines().collect();
    // start_line is 1-based; the line at index (start_line-1) is the node's
    // first line, so lines above are indices [.. start_line-1].
    let above_end = (start_line as usize).saturating_sub(1);
    let above_start = above_end.saturating_sub(window);
    if above_start >= above_end || above_end > lines.len() {
        // Clamp defensively if start_line is past EOF.
        let above_end = above_end.min(lines.len());
        let above_start = above_end.saturating_sub(window);
        return lines[above_start..above_end].join("\n");
    }
    lines[above_start..above_end].join("\n")
}

// ---------------------------------------------------------------------------
// Public classification entry point.
// ---------------------------------------------------------------------------

/// Classify a node as a user-facing entry point, else `None`.
///
/// Signals are checked in priority order; the first match wins:
/// 1. [`EntryKind::TauriCommand`]
/// 2. [`EntryKind::HttpRoute`]
/// 3. [`EntryKind::CliCommand`]
/// 4. [`EntryKind::UiComponent`]
/// 5. [`EntryKind::PublicApi`] (fallback, used sparingly)
///
/// Most nodes are internal helpers and return `None`. May content-peek under
/// `repo_root`; never panics.
pub fn classify(node: &AstNode, repo_root: &Path) -> Option<EntryPoint> {
    let file = node.file_path.as_deref().unwrap_or("");
    // Read source once up front if we have a path; individual detectors decide
    // whether they need it. `None` content just means peeks are skipped and we
    // lean on path/kind/signature heuristics.
    let content = if file.is_empty() {
        None
    } else {
        read_source(file, repo_root)
    };
    // Single-node callers (the impact gate) want maximum fidelity, including the
    // cross-file sibling-router scan.
    classify_with_content(node, repo_root, content.as_deref(), true)
}

/// Same as [`classify`], but the caller supplies the file's already-read source
/// (or `None`). This lets bulk callers — e.g. `aura atlas`, which classifies
/// thousands of nodes — read each file *once* and reuse it across every node in
/// that file, instead of re-reading the file per node.
///
/// `cross_file` controls whether HTTP-route detection may fall back to scanning
/// *sibling* `.rs` files for a route table that references this handler. That
/// scan reads (and string-searches) every neighbouring file and is fine for a
/// one-off single-node classification, but catastrophic when run across tens of
/// thousands of nodes — so bulk callers pass `false` and rely on same-file route
/// tables plus the handler-shape fallback instead.
pub fn classify_with_content(
    node: &AstNode,
    repo_root: &Path,
    content: Option<&str>,
    cross_file: bool,
) -> Option<EntryPoint> {
    let ident = node.identifier.as_deref().unwrap_or("").trim();
    let file = node.file_path.as_deref().unwrap_or("");

    // We can do almost nothing useful without an identifier (except enum
    // variants, but those still carry an identifier in `identifier`).
    if ident.is_empty() {
        return None;
    }

    // 1. Tauri command -----------------------------------------------------
    if let Some(ep) = detect_tauri(node, ident, file, content.as_deref()) {
        return Some(ep);
    }

    // 2. HTTP route --------------------------------------------------------
    if let Some(ep) = detect_http_route(node, ident, file, content.as_deref(), repo_root, cross_file) {
        return Some(ep);
    }

    // 3. CLI subcommand ----------------------------------------------------
    if let Some(ep) = detect_cli(node, ident, file, content.as_deref()) {
        return Some(ep);
    }

    // 4. UI component / handler -------------------------------------------
    if let Some(ep) = detect_ui(node, ident, file, content.as_deref()) {
        return Some(ep);
    }

    // 5. Public API boundary (sparingly) ----------------------------------
    if let Some(ep) = detect_public_api(node, ident, file) {
        return Some(ep);
    }

    None
}

// ---------------------------------------------------------------------------
// Signal 1: Tauri command.
// ---------------------------------------------------------------------------

/// `#[tauri::command]` / `#[command]` on a node under a `src-tauri/` path.
fn detect_tauri(node: &AstNode, ident: &str, file: &str, content: Option<&str>) -> Option<EntryPoint> {
    if !file.contains("src-tauri/") {
        return None;
    }

    let has_attr = match (content, node.start_line) {
        (Some(c), Some(start)) => {
            let above = lines_above(c, start, 4);
            attr_block_has_tauri_command(&above)
        }
        _ => false,
    };

    if !has_attr {
        return None;
    }

    // Strip a trailing `_cmd` / `_command` before humanizing.
    let base = strip_cmd_suffix(ident);
    Some(EntryPoint {
        kind: EntryKind::TauriCommand,
        feature_name: humanize(base),
        entry_symbol: ident.to_string(),
        file: file.to_string(),
    })
}

/// True if any of the given (already-isolated) lines-above contains a Tauri
/// command attribute. We match `#[tauri::command]` and a bare `#[command]`,
/// tolerating attribute arguments like `#[tauri::command(rename_all = "..")]`.
fn attr_block_has_tauri_command(above: &str) -> bool {
    for raw in above.lines() {
        let line = raw.trim();
        if !line.starts_with("#[") {
            continue;
        }
        // Normalize the inside of the attribute for a loose contains-check.
        let inner = line
            .trim_start_matches("#[")
            .trim_end_matches(']')
            .trim();
        if inner.starts_with("tauri::command") || inner == "command" || inner.starts_with("command(")
        {
            return true;
        }
    }
    false
}

/// Strip a single trailing `_cmd` or `_command` (case-insensitive) from an
/// identifier. `"sign_in_cmd"` -> `"sign_in"`.
fn strip_cmd_suffix(ident: &str) -> &str {
    let lower = ident.to_ascii_lowercase();
    if lower.ends_with("_command") {
        &ident[..ident.len() - "_command".len()]
    } else if lower.ends_with("_cmd") {
        &ident[..ident.len() - "_cmd".len()]
    } else {
        ident
    }
}

// ---------------------------------------------------------------------------
// Signal 2: HTTP route.
// ---------------------------------------------------------------------------

/// Detect an HTTP route handler. We look for the identifier being registered
/// as a handler and try to recover the URL path it is mounted at.
///
/// Detection strategies (in order of confidence):
/// * axum-style `.route("<path>", get(ident))` / `post(ident)` / etc.
/// * actix/axum function macros `#[get("<path>")]` directly above the node.
/// * framework `app.get("<path>", ident)` / `router.post("<path>", ident)`.
///
/// We scan the node's own file first, then sibling `.rs` files in the same
/// directory (router/registration is often split from the handler body).
fn detect_http_route(
    node: &AstNode,
    ident: &str,
    file: &str,
    content: Option<&str>,
    repo_root: &Path,
    cross_file: bool,
) -> Option<EntryPoint> {
    // (a) Function-macro attribute directly above the node (actix/axum-macros):
    //     `#[get("/x/y")]` / `#[post("/x/y")]` ...
    if let (Some(c), Some(start)) = (content, node.start_line) {
        let above = lines_above(c, start, 4);
        if let Some(path) = route_path_from_attr(&above) {
            return Some(route_entry(ident, file, &path));
        }
    }

    // (b) Route table referencing this identifier. Search own file, then
    //     sibling files in the same directory.
    if let Some(c) = content {
        if let Some(path) = find_route_path_for_handler(c, ident) {
            return Some(route_entry(ident, file, &path));
        }
    }

    if cross_file && !file.is_empty() {
        if let Some(path) = scan_sibling_router_files(file, ident, repo_root) {
            return Some(route_entry(ident, file, &path));
        }
    }

    // (c) Fallback: file path / signature strongly implies a handler but we
    //     could not recover a path. Classify with the identifier instead.
    if looks_like_handler(node, file) {
        return Some(EntryPoint {
            kind: EntryKind::HttpRoute,
            feature_name: humanize(ident),
            entry_symbol: ident.to_string(),
            file: file.to_string(),
        });
    }

    None
}

/// Build a route EntryPoint whose feature name comes from the URL path.
fn route_entry(ident: &str, file: &str, url_path: &str) -> EntryPoint {
    EntryPoint {
        kind: EntryKind::HttpRoute,
        feature_name: humanize(url_path),
        entry_symbol: ident.to_string(),
        file: file.to_string(),
    }
}

/// Extract a URL path from an actix/axum-style function macro in `above`,
/// e.g. `#[get("/api/reports")]` -> `Some("/api/reports")`.
fn route_path_from_attr(above: &str) -> Option<String> {
    const VERBS: [&str; 7] = ["get", "post", "put", "delete", "patch", "head", "route"];
    for raw in above.lines() {
        let line = raw.trim();
        if !line.starts_with("#[") {
            continue;
        }
        let inner = line.trim_start_matches("#[").trim_end_matches(']').trim();
        for verb in VERBS {
            if inner.starts_with(verb) {
                // Pull the first quoted string argument.
                if let Some(path) = first_quoted(inner) {
                    if path.starts_with('/') {
                        return Some(path);
                    }
                }
            }
        }
    }
    None
}

/// Scan a router registration body for the given handler identifier and return
/// the URL path it is mounted at.
///
/// Handles:
/// * axum: `.route("/x/y", get(ident))`, `.route("/x/y", post(ident).get(other))`
/// * builder: `app.get("/x/y", ident)`, `router.post("/x/y", ident)`,
///   `.get("/x/y", ident)`
fn find_route_path_for_handler(content: &str, ident: &str) -> Option<String> {
    // We do a line-oriented scan: a registration is almost always on one line.
    for raw in content.lines() {
        let line = raw.trim();

        // Quick reject: the handler identifier must appear as a whole word.
        if !contains_word(line, ident) {
            continue;
        }

        // axum `.route("<path>", ...)` — the path is the first quoted arg, and
        // the handler appears later on the same line.
        if let Some(rest) = line.split_once(".route(") {
            if let Some(path) = first_quoted(rest.1) {
                if path.starts_with('/') {
                    return Some(path);
                }
            }
        }

        // builder `*.get("<path>", ident)` / `*.post(...)` etc. The path is the
        // first quoted string and `ident` is referenced as the handler arg.
        if let Some(path) = first_quoted(line) {
            if path.starts_with('/') {
                // Make sure the verb call shape is plausible (a method call with
                // a path then a handler), not an unrelated string literal.
                if line_has_http_verb_call(line) {
                    return Some(path);
                }
            }
        }
    }
    None
}

/// True if the line contains an HTTP-verb-shaped method call.
fn line_has_http_verb_call(line: &str) -> bool {
    const CALLS: [&str; 7] = [
        ".get(", ".post(", ".put(", ".delete(", ".patch(", ".head(", ".route(",
    ];
    CALLS.iter().any(|c| line.contains(c))
}

/// Scan sibling `.rs` files in the same directory as `file` for a route table
/// that references `ident`. Bounded: only files directly in the same dir.
fn scan_sibling_router_files(file: &str, ident: &str, repo_root: &Path) -> Option<String> {
    // Resolve the directory of the node's file using the same candidate logic
    // as `read_source`.
    let dir = {
        let joined = repo_root.join(file);
        if joined.exists() {
            joined.parent().map(|p| p.to_path_buf())
        } else {
            Path::new(file).parent().map(|p| p.to_path_buf())
        }
    }?;

    let entries = std::fs::read_dir(&dir).ok()?;
    for entry in entries.flatten() {
        let path = entry.path();
        if path.extension().and_then(|e| e.to_str()) != Some("rs") {
            continue;
        }
        // Skip the node's own file (already scanned by the caller).
        if let Some(name) = path.file_name().and_then(|n| n.to_str()) {
            if file.ends_with(name) && Path::new(file).file_name() == Some(name.as_ref()) {
                // Could still be a different dir with same filename; cheap skip
                // is fine because the own-file scan already ran.
            }
        }
        if let Ok(c) = std::fs::read_to_string(&path) {
            if let Some(p) = find_route_path_for_handler(&c, ident) {
                return Some(p);
            }
        }
    }
    None
}

/// Heuristic: does this node look like a request handler even without a route
/// table? True when it lives in a `routes`/`handlers`/`api` file and its
/// signature returns a response-ish type.
fn looks_like_handler(node: &AstNode, file: &str) -> bool {
    let lower = file.to_ascii_lowercase();
    let in_route_file = lower.contains("route")
        || lower.contains("handler")
        || lower.contains("/api/")
        || lower.ends_with("api.rs")
        || lower.contains("api_");
    if !in_route_file {
        return false;
    }
    let sig = node.signature.as_deref().unwrap_or("").to_ascii_lowercase();
    // Response-ish return types commonly seen in axum/actix handlers.
    sig.contains("-> impl intoresponse")
        || sig.contains("-> response")
        || sig.contains("-> httpresponse")
        || sig.contains("-> json")
        || sig.contains("-> statuscode")
        || sig.contains("-> result<json")
        || sig.contains("-> result<response")
        || sig.contains("intoresponse")
}

// ---------------------------------------------------------------------------
// Signal 3: CLI subcommand.
// ---------------------------------------------------------------------------

/// Detect a clap subcommand. Either the node is itself an enum variant, or the
/// file declares a `Subcommand`/`Commands`-derive enum whose variants include
/// this identifier.
fn detect_cli(node: &AstNode, ident: &str, file: &str, content: Option<&str>) -> Option<EntryPoint> {
    // Only Rust source participates here.
    let lower = file.to_ascii_lowercase();
    let is_rust = lower.ends_with(".rs");
    if !is_rust && !file.is_empty() {
        return None;
    }

    // The node must plausibly belong to a CLI surface: main.rs, or a
    // `cli`/`commands` module path. (When file is empty we can't tell, so we
    // require an enum-variant kind below.)
    let cli_locale = lower.ends_with("main.rs")
        || lower.contains("/cli")
        || lower.contains("cli.rs")
        || lower.contains("command")
        || lower.contains("/commands");

    // (a) The node is itself an enum variant — strongest signal.
    if is_enum_variant_kind(&node.kind) {
        // Only treat as a CLI command if it's in a CLI locale or we can confirm
        // it lives in a clap subcommand enum.
        if cli_locale || content.map(|c| has_subcommand_enum(c)).unwrap_or(false) {
            return Some(EntryPoint {
                kind: EntryKind::CliCommand,
                feature_name: humanize(ident),
                entry_symbol: ident.to_string(),
                file: file.to_string(),
            });
        }
    }

    // (b) Scan the file for a clap subcommand enum that lists this identifier as
    //     a variant.
    if cli_locale {
        if let Some(c) = content {
            if subcommand_enum_has_variant(c, ident) {
                return Some(EntryPoint {
                    kind: EntryKind::CliCommand,
                    feature_name: humanize(ident),
                    entry_symbol: ident.to_string(),
                    file: file.to_string(),
                });
            }
        }
    }

    None
}

/// True if a tree-sitter kind denotes an enum variant.
fn is_enum_variant_kind(kind: &str) -> bool {
    kind == "enum_variant" || kind == "variant" || kind == "enum_variant_declaration"
}

/// True if the file contains a clap subcommand-style enum declaration.
fn has_subcommand_enum(content: &str) -> bool {
    content.contains("Subcommand") || derives_subcommand(content)
}

/// True if the content has a `#[derive(... Subcommand ...)]` near an enum.
fn derives_subcommand(content: &str) -> bool {
    content
        .lines()
        .any(|l| l.contains("derive(") && l.contains("Subcommand"))
}

/// Within a clap `Subcommand`/`Commands` enum, is `ident` one of the variants?
///
/// We find a `enum <Name> { ... }` block whose preceding lines derive
/// `Subcommand` (or whose name is `Commands`/`Command`/`Subcommand`) and look
/// for a variant token equal to `ident`.
fn subcommand_enum_has_variant(content: &str, ident: &str) -> bool {
    let lines: Vec<&str> = content.lines().collect();
    let mut i = 0usize;
    while i < lines.len() {
        let line = lines[i].trim();
        // Detect an enum header.
        if let Some(after) = line.strip_prefix("enum ").or_else(|| {
            line.strip_prefix("pub enum ")
                .or_else(|| line.strip_prefix("pub(crate) enum "))
        }) {
            let enum_name = after
                .split(|c: char| c == '{' || c == '<' || c.is_whitespace())
                .next()
                .unwrap_or("");

            // Is this a clap subcommand enum? Either name-based or derive-based
            // (look back a few lines for a derive).
            let name_based = matches!(enum_name, "Commands" | "Command" | "Subcommand");
            let derive_based = {
                let look_start = i.saturating_sub(4);
                lines[look_start..i]
                    .iter()
                    .any(|l| l.contains("derive(") && l.contains("Subcommand"))
            };

            if name_based || derive_based {
                // Scan the enum body for the variant.
                let mut j = i;
                let mut depth = 0i32;
                let mut started = false;
                while j < lines.len() {
                    let body = lines[j];
                    for ch in body.chars() {
                        if ch == '{' {
                            depth += 1;
                            started = true;
                        } else if ch == '}' {
                            depth -= 1;
                        }
                    }
                    if started && depth <= 0 {
                        // We've consumed the whole enum body on/after this line.
                        // Check this final line too before breaking.
                        if variant_line_matches(lines[j], ident) {
                            return true;
                        }
                        break;
                    }
                    if started && variant_line_matches(body, ident) {
                        return true;
                    }
                    j += 1;
                }
            }
        }
        i += 1;
    }
    false
}

/// True if a line inside an enum body declares a variant named `ident`.
fn variant_line_matches(line: &str, ident: &str) -> bool {
    let t = line.trim().trim_start_matches("#[");
    // Variant declarations look like `Name,` / `Name {` / `Name(...)`.
    let token: String = t
        .chars()
        .take_while(|c| c.is_alphanumeric() || *c == '_')
        .collect();
    !token.is_empty() && token == ident
}

// ---------------------------------------------------------------------------
// Signal 4: UI component / handler.
// ---------------------------------------------------------------------------

/// Detect a React/JSX UI surface: a PascalCase exported component, or an event
/// handler (`on[A-Z]…`, `…Handler`, or an `onClick`-style binding).
fn detect_ui(node: &AstNode, ident: &str, file: &str, content: Option<&str>) -> Option<EntryPoint> {
    let lower = file.to_ascii_lowercase();
    if !(lower.ends_with(".tsx") || lower.ends_with(".jsx")) {
        return None;
    }

    let exported = signature_is_exported(node.signature.as_deref())
        || content
            .map(|c| file_exports_ident(c, ident))
            .unwrap_or(false);

    // (a) PascalCase exported component returning JSX → a UI surface.
    if is_pascal_case(ident) && exported {
        // Best-effort confirm it returns JSX; if we can't read the file, the
        // PascalCase + export shape is enough (that's the React convention).
        let returns_jsx = content
            .map(|c| ident_returns_jsx(c, ident))
            .unwrap_or(true);
        if returns_jsx {
            return Some(EntryPoint {
                kind: EntryKind::UiComponent,
                feature_name: humanize(ident),
                entry_symbol: ident.to_string(),
                file: file.to_string(),
            });
        }
    }

    // (b) Event handler → a UI action.
    if is_event_handler_name(ident) {
        return Some(EntryPoint {
            kind: EntryKind::UiComponent,
            feature_name: humanize(ident),
            entry_symbol: ident.to_string(),
            file: file.to_string(),
        });
    }

    None
}

/// `onSave`, `onClickRow`, `handleSubmit`-style? We treat `on[A-Z]…`, names
/// ending in `Handler`, and a leading `handle` + Capital as handler-shaped.
fn is_event_handler_name(ident: &str) -> bool {
    if ident.ends_with("Handler") && ident != "Handler" {
        return true;
    }
    // `on` followed by an uppercase letter: onClick, onSubmit, onSaveDraft.
    if let Some(rest) = ident.strip_prefix("on") {
        if rest.chars().next().map(|c| c.is_ascii_uppercase()).unwrap_or(false) {
            return true;
        }
    }
    // `handle` followed by an uppercase letter: handleSubmit, handleSaveDraft.
    if let Some(rest) = ident.strip_prefix("handle") {
        if rest.chars().next().map(|c| c.is_ascii_uppercase()).unwrap_or(false) {
            return true;
        }
    }
    false
}

/// Does this content export `ident`? Matches `export function ident`,
/// `export const ident`, `export default function ident`, and a trailing
/// `export { ident }` / `export default ident`.
fn file_exports_ident(content: &str, ident: &str) -> bool {
    for raw in content.lines() {
        let line = raw.trim();
        if !line.starts_with("export") {
            // Still allow a re-export block `export { Foo, ... }`.
            if line.starts_with("export {") || line.starts_with("export{") {
                if contains_word(line, ident) {
                    return true;
                }
            }
            continue;
        }
        if !contains_word(line, ident) {
            continue;
        }
        // `export function Foo`, `export const Foo =`, `export default function Foo`
        if line.contains("function") || line.contains("const") || line.contains("class") {
            // Ensure the identifier is the declared name, not an argument.
            if declares_name(line, ident) {
                return true;
            }
        }
        // `export { Foo }`, `export default Foo`
        if line.contains('{') || line.contains("default") {
            return true;
        }
    }
    false
}

/// Best-effort: does the body of `ident`'s declaration return JSX? We look for
/// a `return <` or a `=> <` / `=> (` shortly after the declaration line.
fn ident_returns_jsx(content: &str, ident: &str) -> bool {
    let lines: Vec<&str> = content.lines().collect();
    // Find the declaration line for `ident`.
    let decl = lines.iter().position(|l| declares_name(l, ident));
    let Some(start) = decl else {
        // Couldn't find the declaration; don't block on it.
        return true;
    };
    // Scan a bounded window of the body for JSX-return shapes.
    let end = (start + 80).min(lines.len());
    for line in &lines[start..end] {
        let t = line.trim();
        if t.contains("return <")
            || t.contains("return (")
            || t.contains("=> <")
            || t.contains("=> (")
            || t.starts_with('<')
        {
            return true;
        }
    }
    false
}

/// True if a declaration line declares the symbol `ident` (function/const/
/// class), as opposed to merely referencing it.
fn declares_name(line: &str, ident: &str) -> bool {
    let l = line.trim();
    for kw in ["function ", "const ", "let ", "var ", "class "] {
        if let Some(idx) = l.find(kw) {
            let after = l[idx + kw.len()..].trim_start();
            // strip an optional `default ` already handled by caller; take name.
            let name: String = after
                .chars()
                .take_while(|c| c.is_alphanumeric() || *c == '_' || *c == '$')
                .collect();
            if name == ident {
                return true;
            }
        }
    }
    false
}

// ---------------------------------------------------------------------------
// Signal 5: Public API boundary (fallback, used sparingly).
// ---------------------------------------------------------------------------

/// Fallback: a clearly public/exported boundary symbol. Rust `pub fn` in a
/// `lib.rs` (or other clearly-public module), or a TS `export function`.
/// Returns `None` for ordinary internal helpers.
fn detect_public_api(node: &AstNode, ident: &str, file: &str) -> Option<EntryPoint> {
    let sig = node.signature.as_deref().unwrap_or("");
    let trimmed = sig.trim_start();
    let lower = file.to_ascii_lowercase();

    let is_rust = lower.ends_with(".rs");
    let is_ts = lower.ends_with(".ts") || lower.ends_with(".tsx");

    // Rust: only a public function that lives in a clearly-public surface.
    if is_rust && (trimmed.starts_with("pub fn ") || trimmed.starts_with("pub async fn ")) {
        let public_surface = lower.ends_with("lib.rs") || lower.ends_with("mod.rs");
        if public_surface {
            return Some(EntryPoint {
                kind: EntryKind::PublicApi,
                feature_name: humanize(ident),
                entry_symbol: ident.to_string(),
                file: file.to_string(),
            });
        }
        return None;
    }

    // TS/JS: an exported function is a public boundary.
    if is_ts && (trimmed.starts_with("export function ") || trimmed.starts_with("export async function ") || trimmed.starts_with("export const ")) {
        return Some(EntryPoint {
            kind: EntryKind::PublicApi,
            feature_name: humanize(ident),
            entry_symbol: ident.to_string(),
            file: file.to_string(),
        });
    }

    None
}

// ---------------------------------------------------------------------------
// Small shared helpers.
// ---------------------------------------------------------------------------

/// True if `signature` begins with a `pub `/`export ` boundary marker.
fn signature_is_exported(signature: Option<&str>) -> bool {
    let s = signature.unwrap_or("").trim_start();
    s.starts_with("pub ") || s.starts_with("export ")
}

/// Is `ident` PascalCase? First char uppercase, contains only alphanumerics,
/// and is not SCREAMING_CASE (which we treat as a constant, not a component).
fn is_pascal_case(ident: &str) -> bool {
    let mut chars = ident.chars();
    match chars.next() {
        Some(c) if c.is_ascii_uppercase() => {}
        _ => return false,
    }
    if !ident.chars().all(|c| c.is_alphanumeric()) {
        return false;
    }
    // Reject ALLCAPS (e.g. `API`, `URL`): a component has at least one
    // lowercase letter.
    ident.chars().any(|c| c.is_ascii_lowercase())
}

/// Extract the first double-quoted string literal from `s`.
fn first_quoted(s: &str) -> Option<String> {
    let start = s.find('"')?;
    let rest = &s[start + 1..];
    let end = rest.find('"')?;
    Some(rest[..end].to_string())
}

/// True if `word` appears in `haystack` bounded by non-identifier characters.
fn contains_word(haystack: &str, word: &str) -> bool {
    if word.is_empty() {
        return false;
    }
    let bytes = haystack.as_bytes();
    let wbytes = word.as_bytes();
    let mut idx = 0;
    while let Some(found) = haystack[idx..].find(word) {
        let abs = idx + found;
        let before_ok = abs == 0 || !is_ident_byte(bytes[abs - 1]);
        let after_pos = abs + wbytes.len();
        let after_ok = after_pos >= bytes.len() || !is_ident_byte(bytes[after_pos]);
        if before_ok && after_ok {
            return true;
        }
        idx = abs + 1;
        if idx >= haystack.len() {
            break;
        }
    }
    false
}

/// True if a byte is part of an identifier (alphanumeric or `_`).
fn is_ident_byte(b: u8) -> bool {
    b.is_ascii_alphanumeric() || b == b'_'
}

// ---------------------------------------------------------------------------
// humanize.
// ---------------------------------------------------------------------------

/// Humanize an identifier or URL path into a Title-Cased feature label.
///
/// Splits `snake_case`, `kebab-case`, `camelCase`, `PascalCase`, and
/// `/`-separated path segments into words; drops common noise segments
/// (`api`, `v1`, `v2`, `cmd`, `command`, `handler`, `fn`, empties); Title-Cases
/// each word; and joins with spaces.
///
/// ```text
/// "sign_in_cmd"            -> "Sign In"
/// "ReportsPanel"           -> "Reports Panel"
/// "/api/reports/export"    -> "Reports Export"
/// "/api/v2/reports/export" -> "Reports Export"
/// "getUserProfile"         -> "Get User Profile"
/// "kebab-case"             -> "Kebab Case"
/// ```
pub fn humanize(raw: &str) -> String {
    // Noise words/segments to drop (compared case-insensitively, after split).
    const NOISE: [&str; 9] = ["api", "v1", "v2", "v3", "cmd", "command", "handler", "fn", "rs"];

    let mut words: Vec<String> = Vec::new();

    // First split on path/word separators: `/`, `.`, `-`, `_`, and whitespace.
    for segment in raw.split(|c: char| {
        c == '/' || c == '\\' || c == '.' || c == '-' || c == '_' || c.is_whitespace()
    }) {
        if segment.is_empty() {
            continue;
        }
        // Then split the segment on camelCase / PascalCase boundaries.
        for word in split_camel(segment) {
            let lower = word.to_ascii_lowercase();
            if lower.is_empty() {
                continue;
            }
            if NOISE.contains(&lower.as_str()) {
                continue;
            }
            words.push(title_case_word(&word));
        }
    }

    words.join(" ")
}

/// Split a single segment on camelCase / PascalCase / digit boundaries.
/// `"getUserProfile"` -> `["get","User","Profile"]`;
/// `"ReportsPanel"`   -> `["Reports","Panel"]`;
/// `"HTTPServer"`     -> `["HTTP","Server"]` (acronym-aware).
fn split_camel(segment: &str) -> Vec<String> {
    let chars: Vec<char> = segment.chars().collect();
    let mut out: Vec<String> = Vec::new();
    let mut current = String::new();

    for i in 0..chars.len() {
        let c = chars[i];
        if current.is_empty() {
            current.push(c);
            continue;
        }
        let prev = chars[i - 1];
        let next = chars.get(i + 1).copied();

        // Boundary: lower/digit -> Upper  (getUser -> get|User)
        let lower_to_upper = (prev.is_lowercase() || prev.is_ascii_digit()) && c.is_uppercase();
        // Boundary: Upper -> Upper followed by lower (acronym end):
        //   HTTPServer -> HTTP|Server  (boundary before the last cap of a run)
        let acronym_end =
            prev.is_uppercase() && c.is_uppercase() && next.map(|n| n.is_lowercase()).unwrap_or(false);
        // Boundary: letter <-> digit transitions stay grouped here (we already
        // split digits out as their own boundary only on lower/digit->upper).

        if lower_to_upper || acronym_end {
            out.push(std::mem::take(&mut current));
        }
        current.push(c);
    }
    if !current.is_empty() {
        out.push(current);
    }
    out
}

/// Title-case a single word: first letter upper, remainder lower — unless the
/// word is an all-caps acronym (length ≥ 2, all uppercase), which we keep as-is.
fn title_case_word(word: &str) -> String {
    if word.len() >= 2 && word.chars().all(|c| c.is_ascii_uppercase()) {
        return word.to_string();
    }
    let mut chars = word.chars();
    match chars.next() {
        Some(first) => {
            let mut s = first.to_ascii_uppercase().to_string();
            s.extend(chars.flat_map(|c| c.to_lowercase()));
            s
        }
        None => String::new(),
    }
}

// ===========================================================================
// Tests
// ===========================================================================

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::PathBuf;

    /// Create a unique temp directory for a test and return its path.
    fn unique_tmpdir(tag: &str) -> PathBuf {
        let mut dir = std::env::temp_dir();
        let uniq = format!(
            "aura_entrypoints_{}_{}_{}",
            tag,
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .map(|d| d.as_nanos())
                .unwrap_or(0)
        );
        dir.push(uniq);
        std::fs::create_dir_all(&dir).expect("create temp dir");
        dir
    }

    /// Write `content` to `dir/name` and return the full path string.
    fn write_file(dir: &Path, name: &str, content: &str) -> String {
        let path = dir.join(name);
        if let Some(parent) = path.parent() {
            std::fs::create_dir_all(parent).expect("create parent dir");
        }
        std::fs::write(&path, content).expect("write temp file");
        path.to_str().unwrap().to_string()
    }

    /// Minimal AstNode builder for tests.
    fn node(kind: &str, ident: &str, file: &str, start_line: u32, signature: &str) -> AstNode {
        AstNode {
            node_id: "n".into(),
            kind: kind.into(),
            identifier: Some(ident.into()),
            content_hash: String::new(),
            children: Vec::new(),
            dependencies: Vec::new(),
            contains_secret: false,
            is_stub: false,
            derived_from: None,
            confidence: 0.0,
            file_path: Some(file.into()),
            start_line: Some(start_line),
            end_line: Some(start_line + 5),
            signature: if signature.is_empty() {
                None
            } else {
                Some(signature.into())
            },
            doc_comment: None,
            top_level: true,
        }
    }

    #[test]
    fn tauri_command_via_attribute_peek() {
        let dir = unique_tmpdir("tauri");
        // The attribute sits on the line just above the fn.
        let src = "\
use tauri::State;

#[tauri::command]
pub fn sign_in_cmd(state: State) -> Result<(), String> {
    Ok(())
}
";
        // Place it under a src-tauri path so the locale check passes.
        let file = write_file(&dir, "aura-shell/src-tauri/src/auth.rs", src);
        // `pub fn sign_in_cmd` is on line 4 (1-based).
        let n = node(
            "function_item",
            "sign_in_cmd",
            &file,
            4,
            "pub fn sign_in_cmd(state: State) -> Result<(), String>",
        );

        let ep = classify(&n, Path::new("/")).expect("should classify as tauri command");
        assert_eq!(ep.kind, EntryKind::TauriCommand);
        // Trailing `_cmd` stripped, then humanized.
        assert_eq!(ep.feature_name, "Sign In");
        assert_eq!(ep.entry_symbol, "sign_in_cmd");
    }

    #[test]
    fn tsx_pascalcase_component() {
        let dir = unique_tmpdir("tsx");
        let src = "\
import React from 'react';

export function ReportsPanel(props) {
  return <div className=\"reports\">Reports</div>;
}
";
        let file = write_file(&dir, "aura-shell/src/components/ReportsPanel.tsx", src);
        let n = node(
            "function_declaration",
            "ReportsPanel",
            &file,
            3,
            "export function ReportsPanel(props)",
        );

        let ep = classify(&n, Path::new("/")).expect("should classify as UI component");
        assert_eq!(ep.kind, EntryKind::UiComponent);
        assert_eq!(ep.feature_name, "Reports Panel");
        assert_eq!(ep.entry_symbol, "ReportsPanel");
    }

    #[test]
    fn http_route_mapped_from_route_table() {
        let dir = unique_tmpdir("http");
        // Handler + axum route table in the same file.
        let src = "\
use axum::{routing::get, Router};

pub async fn export_reports() -> impl IntoResponse {
    // ...
}

pub fn router() -> Router {
    Router::new()
        .route(\"/reports/export\", get(export_reports))
}
";
        let file = write_file(&dir, "aura-cloud/src/routes/reports.rs", src);
        let n = node(
            "function_item",
            "export_reports",
            &file,
            3,
            "pub async fn export_reports() -> impl IntoResponse",
        );

        let ep = classify(&n, Path::new("/")).expect("should classify as http route");
        assert_eq!(ep.kind, EntryKind::HttpRoute);
        // Feature name derived from the URL path, not the identifier.
        assert_eq!(ep.feature_name, "Reports Export");
        assert_eq!(ep.entry_symbol, "export_reports");
    }

    #[test]
    fn cli_subcommand_via_enum_scan() {
        let dir = unique_tmpdir("cli");
        let src = "\
use clap::Subcommand;

#[derive(Subcommand)]
pub enum Commands {
    Status,
    Rewind,
    PrReview,
}
";
        let file = write_file(&dir, "aura-cli/src/main.rs", src);
        // The node is the `PrReview` variant; an enum_variant kind is the
        // strongest signal but here we exercise the enum-scan path with a
        // function-ish kind too. Use the variant kind to be representative.
        let n = node("enum_variant", "PrReview", &file, 7, "");

        let ep = classify(&n, Path::new("/")).expect("should classify as cli command");
        assert_eq!(ep.kind, EntryKind::CliCommand);
        assert_eq!(ep.feature_name, "Pr Review");
        assert_eq!(ep.entry_symbol, "PrReview");
    }

    #[test]
    fn humanize_handles_snake_camel_and_paths() {
        assert_eq!(humanize("sign_in_cmd"), "Sign In");
        assert_eq!(humanize("ReportsPanel"), "Reports Panel");
        assert_eq!(humanize("/api/reports/export"), "Reports Export");
        assert_eq!(humanize("/api/v2/reports/export"), "Reports Export");
        assert_eq!(humanize("getUserProfile"), "Get User Profile");
        assert_eq!(humanize("kebab-case"), "Kebab Case");
        // Noise-only / empty inputs collapse to empty.
        assert_eq!(humanize("/api/v1"), "");
        assert_eq!(humanize(""), "");
    }

    #[test]
    fn plain_internal_helper_returns_none() {
        let dir = unique_tmpdir("internal");
        let src = "\
fn compute_checksum(bytes: &[u8]) -> u64 {
    bytes.iter().map(|b| *b as u64).sum()
}
";
        let file = write_file(&dir, "aura-cli/src/util.rs", src);
        // Private fn, ordinary .rs file, no attribute, no route, not a variant.
        let n = node(
            "function_item",
            "compute_checksum",
            &file,
            1,
            "fn compute_checksum(bytes: &[u8]) -> u64",
        );

        assert!(
            classify(&n, Path::new("/")).is_none(),
            "internal helper must not be an entry point"
        );
    }

    #[test]
    fn ui_event_handler_is_action() {
        let dir = unique_tmpdir("handler");
        let src = "\
export function onSaveDraft() {
  saveDraft();
}
";
        let file = write_file(&dir, "aura-shell/src/components/Editor.tsx", src);
        let n = node(
            "function_declaration",
            "onSaveDraft",
            &file,
            1,
            "export function onSaveDraft()",
        );

        let ep = classify(&n, Path::new("/")).expect("handler should classify");
        assert_eq!(ep.kind, EntryKind::UiComponent);
        assert_eq!(ep.feature_name, "On Save Draft");
    }

    #[test]
    fn http_route_via_actix_macro() {
        let dir = unique_tmpdir("actix");
        let src = "\
#[get(\"/users/profile\")]
pub async fn user_profile() -> HttpResponse {
    HttpResponse::Ok().finish()
}
";
        let file = write_file(&dir, "aura-cloud/src/handlers.rs", src);
        // The `#[get(...)]` macro is on the line above the fn (line 2).
        let n = node(
            "function_item",
            "user_profile",
            &file,
            2,
            "pub async fn user_profile() -> HttpResponse",
        );

        let ep = classify(&n, Path::new("/")).expect("actix macro should classify");
        assert_eq!(ep.kind, EntryKind::HttpRoute);
        assert_eq!(ep.feature_name, "Users Profile");
    }
}
