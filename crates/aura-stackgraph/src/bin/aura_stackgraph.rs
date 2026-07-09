//! `aura-stackgraph` — out-of-process query CLI for the
//! [`aura_stackgraph`] crate.
//!
//! Why a separate binary: stack-graphs pins tree-sitter 0.24 while
//! aura-cli's parser stack pins 0.26, which conflicts on
//! `links = "tree-sitter"`. Putting this behind a process boundary
//! lets the MCP `aura_refs` / `aura_defs` tools call into it without
//! dragging both tree-sitter versions into the same crate.
//!
//! ## Protocol
//!
//! ```
//! aura-stackgraph query
//! ```
//!
//! Reads one JSON object from stdin:
//!
//! ```json
//! {
//!   "symbol": "apply_limiter",
//!   "kind":   "refs" | "defs",
//!   "files":  [{"path": "limiter.py", "source": "..."}, ...]
//! }
//! ```
//!
//! Writes one JSON object to stdout (always, even on error — error
//! payloads have `"error": "..."` and exit code 0; only protocol-level
//! failures produce a non-zero exit). Exit code 2 on usage errors.

use std::io::Read;

use aura_stackgraph::SymbolIndex;
use serde::Deserialize;

#[derive(Debug, Deserialize)]
struct QueryFile {
    path: String,
    source: String,
}

#[derive(Debug, Deserialize)]
struct QueryRequest {
    symbol: String,
    kind: String,
    files: Vec<QueryFile>,
}

fn main() {
    let mut args = std::env::args().skip(1);
    let sub = args.next().unwrap_or_default();
    if sub != "query" {
        eprintln!("usage: aura-stackgraph query   (reads {{symbol, kind, files}} JSON on stdin)");
        std::process::exit(2);
    }
    let mut buf = String::new();
    if let Err(e) = std::io::stdin().read_to_string(&mut buf) {
        emit_error(&format!("read stdin: {e}"));
        return;
    }
    let req: QueryRequest = match serde_json::from_str(&buf) {
        Ok(r) => r,
        Err(e) => {
            emit_error(&format!("invalid request JSON: {e}"));
            return;
        }
    };
    if req.symbol.trim().is_empty() {
        emit_error("symbol must be non-empty");
        return;
    }
    if req.files.is_empty() {
        emit_error("files must be non-empty");
        return;
    }
    let pairs: Vec<(&str, &str)> = req
        .files
        .iter()
        .map(|f| (f.path.as_str(), f.source.as_str()))
        .collect();
    let mut index = match SymbolIndex::build(&pairs) {
        Ok(ix) => ix,
        Err(e) => {
            emit_error(&format!("build: {e}"));
            return;
        }
    };
    let result = match req.kind.as_str() {
        "refs" => index.find_refs(&req.symbol),
        "defs" => index.find_defs(&req.symbol),
        other => {
            emit_error(&format!("unknown kind: {other} (expected 'refs' or 'defs')"));
            return;
        }
    };
    let rows = match result {
        Ok(r) => r,
        Err(e) => {
            emit_error(&format!("query: {e}"));
            return;
        }
    };
    let payload = serde_json::json!({
        "symbol": req.symbol,
        "kind": req.kind,
        "count": rows.len(),
        "rows": rows,
        "indexed_files": req.files.len(),
    });
    println!("{}", payload);
}

fn emit_error(msg: &str) {
    let payload = serde_json::json!({ "error": msg });
    println!("{}", payload);
}
