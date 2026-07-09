//! Real-file loader for the code editor.
//!
//! Reads a file off disk, classifies it (text vs binary, language by extension),
//! enforces a size cap, and produces an `OpenFile` populated with `CodeLine`s.
//! Syntax highlighting is intentionally naive: a hand-rolled Rust lexer covers
//! the bulk of files in this repo, and unknown languages fall back to plain
//! text spans (still real content, just one color).

use std::fs;
use std::path::{Path, PathBuf};

use crate::fixtures::{CodeLine, OpenFile, Span, TokenKind};

/// Hard cap so a stray click on a giant file doesn't lock up the UI.
/// Anything larger renders a one-line notice instead of the file body.
const MAX_BYTES: u64 = 1_500_000;

/// Result of attempting to load a file from disk into the editor.
pub enum LoadResult {
    Ok(OpenFile),
    /// File exceeds `MAX_BYTES`. Argument is the file's size in bytes.
    TooLarge(u64),
    /// File appears to be binary (NUL byte in the first chunk).
    Binary,
    /// I/O error (missing, permission denied, etc.). Argument is the message.
    Error(String),
}

pub fn load(path: &Path) -> LoadResult {
    let meta = match fs::metadata(path) {
        Ok(m) => m,
        Err(e) => return LoadResult::Error(e.to_string()),
    };
    if meta.len() > MAX_BYTES {
        return LoadResult::TooLarge(meta.len());
    }
    let bytes = match fs::read(path) {
        Ok(b) => b,
        Err(e) => return LoadResult::Error(e.to_string()),
    };
    if is_binary(&bytes) {
        return LoadResult::Binary;
    }
    let text = String::from_utf8_lossy(&bytes).into_owned();
    let lang = language_for(path);
    let lines = highlight(&text, &lang);
    let name = path
        .file_name()
        .map(|s| s.to_string_lossy().into_owned())
        .unwrap_or_else(|| path.to_string_lossy().into_owned());
    LoadResult::Ok(OpenFile {
        name,
        path: path.to_string_lossy().into_owned(),
        language: lang,
        lines,
        current_line: 1,
    })
}

/// Build an `OpenFile` shell that displays a single notice line. Used for
/// oversized / binary / errored files so the editor surface still has
/// something to show instead of going blank.
pub fn notice(path: &Path, message: &str) -> OpenFile {
    let name = path
        .file_name()
        .map(|s| s.to_string_lossy().into_owned())
        .unwrap_or_else(|| path.to_string_lossy().into_owned());
    OpenFile {
        name,
        path: path.to_string_lossy().into_owned(),
        language: String::new(),
        lines: vec![CodeLine {
            change: None,
            spans: vec![Span { text: message.to_string(), kind: TokenKind::Comment }],
        }],
        current_line: 1,
    }
}

fn is_binary(bytes: &[u8]) -> bool {
    let head = &bytes[..bytes.len().min(8192)];
    head.contains(&0)
}

fn language_for(path: &Path) -> String {
    let ext = path
        .extension()
        .and_then(|s| s.to_str())
        .unwrap_or("")
        .to_ascii_lowercase();
    match ext.as_str() {
        "rs" => "rust",
        "toml" => "toml",
        "md" | "mdx" => "markdown",
        "json" | "jsonc" => "json",
        "yml" | "yaml" => "yaml",
        "ts" | "tsx" => "typescript",
        "js" | "jsx" | "mjs" | "cjs" => "javascript",
        "py" => "python",
        "go" => "go",
        "sh" | "bash" | "zsh" | "fish" => "shell",
        "html" | "htm" => "html",
        "css" | "scss" | "sass" => "css",
        _ => "",
    }
    .to_string()
}

fn highlight(text: &str, lang: &str) -> Vec<CodeLine> {
    text.lines()
        .map(|line| CodeLine {
            change: None,
            spans: highlight_line(line, lang),
        })
        .collect()
}

fn highlight_line(line: &str, lang: &str) -> Vec<Span> {
    if line.is_empty() {
        return Vec::new();
    }
    match lang {
        "rust" => highlight_rust(line),
        _ => vec![Span { text: line.to_string(), kind: TokenKind::Ident }],
    }
}

/// Hand-rolled Rust lexer. Handles strings (with escapes), char literals, line
/// comments, numbers, idents/keywords, and falls back to single-char punct.
/// It is line-local — multi-line strings and `/* */` blocks aren't tracked
/// across lines, which is fine for highlighting (worst case: a stray quote
/// makes one line look funny).
fn highlight_rust(line: &str) -> Vec<Span> {
    let mut out: Vec<Span> = Vec::new();
    let bytes = line.as_bytes();
    let mut i = 0;

    while i < bytes.len() {
        let b = bytes[i];

        if b == b' ' || b == b'\t' {
            let start = i;
            while i < bytes.len() && (bytes[i] == b' ' || bytes[i] == b'\t') {
                i += 1;
            }
            push(&mut out, &line[start..i], TokenKind::Ident);
            continue;
        }

        if b == b'/' && i + 1 < bytes.len() && bytes[i + 1] == b'/' {
            push(&mut out, &line[i..], TokenKind::Comment);
            return out;
        }

        if b == b'"' {
            let start = i;
            i += 1;
            while i < bytes.len() {
                if bytes[i] == b'\\' && i + 1 < bytes.len() {
                    i += 2;
                    continue;
                }
                if bytes[i] == b'"' {
                    i += 1;
                    break;
                }
                i += 1;
            }
            push(&mut out, &line[start..i], TokenKind::String);
            continue;
        }

        if b == b'\'' {
            // Could be a char literal or a lifetime — disambiguate by peek.
            let start = i;
            i += 1;
            // Lifetime: `'a`, `'static`, etc. — alpha/_ then idents, no closing quote.
            if i < bytes.len() && (bytes[i].is_ascii_alphabetic() || bytes[i] == b'_') {
                let lt_start = start;
                while i < bytes.len() && (bytes[i].is_ascii_alphanumeric() || bytes[i] == b'_') {
                    i += 1;
                }
                if i < bytes.len() && bytes[i] == b'\'' {
                    // Actually a multi-char char literal (rare, treat as string).
                    i += 1;
                    push(&mut out, &line[lt_start..i], TokenKind::String);
                } else {
                    push(&mut out, &line[lt_start..i], TokenKind::Keyword);
                }
                continue;
            }
            // Simple char literal: `'x'` or `'\n'`.
            while i < bytes.len() {
                if bytes[i] == b'\\' && i + 1 < bytes.len() {
                    i += 2;
                    continue;
                }
                if bytes[i] == b'\'' {
                    i += 1;
                    break;
                }
                i += 1;
            }
            push(&mut out, &line[start..i], TokenKind::String);
            continue;
        }

        if b.is_ascii_digit() {
            let start = i;
            while i < bytes.len()
                && (bytes[i].is_ascii_alphanumeric() || bytes[i] == b'_' || bytes[i] == b'.')
            {
                i += 1;
            }
            push(&mut out, &line[start..i], TokenKind::Number);
            continue;
        }

        if b.is_ascii_alphabetic() || b == b'_' {
            let start = i;
            while i < bytes.len() && (bytes[i].is_ascii_alphanumeric() || bytes[i] == b'_') {
                i += 1;
            }
            let word = &line[start..i];
            // Macro call: `vec!`, `println!`, etc.
            let is_macro = i < bytes.len() && bytes[i] == b'!';
            // Function call / type / ident classification.
            let kind = if is_rust_keyword(word) {
                TokenKind::Keyword
            } else if is_macro {
                TokenKind::Fn
            } else if word.starts_with(|c: char| c.is_ascii_uppercase()) {
                TokenKind::Type
            } else if i < bytes.len() && bytes[i] == b'(' {
                TokenKind::Fn
            } else {
                TokenKind::Ident
            };
            push(&mut out, word, kind);
            if is_macro {
                push(&mut out, "!", TokenKind::Punct);
                i += 1;
            }
            continue;
        }

        // Punctuation fallthrough — single char.
        let start = i;
        i += 1;
        push(&mut out, &line[start..i], TokenKind::Punct);
    }

    out
}

fn push(out: &mut Vec<Span>, text: &str, kind: TokenKind) {
    if text.is_empty() {
        return;
    }
    // Coalesce consecutive same-kind spans to keep the row widget count down.
    if let Some(last) = out.last_mut() {
        if same_kind(last.kind, kind) {
            last.text.push_str(text);
            return;
        }
    }
    out.push(Span { text: text.to_string(), kind });
}

fn same_kind(a: TokenKind, b: TokenKind) -> bool {
    matches!(
        (a, b),
        (TokenKind::Ident, TokenKind::Ident)
            | (TokenKind::Punct, TokenKind::Punct)
            | (TokenKind::Comment, TokenKind::Comment)
    )
}

fn is_rust_keyword(w: &str) -> bool {
    matches!(
        w,
        "as" | "async"
            | "await"
            | "break"
            | "const"
            | "continue"
            | "crate"
            | "dyn"
            | "else"
            | "enum"
            | "extern"
            | "false"
            | "fn"
            | "for"
            | "if"
            | "impl"
            | "in"
            | "let"
            | "loop"
            | "match"
            | "mod"
            | "move"
            | "mut"
            | "pub"
            | "ref"
            | "return"
            | "self"
            | "Self"
            | "static"
            | "struct"
            | "super"
            | "trait"
            | "true"
            | "type"
            | "union"
            | "unsafe"
            | "use"
            | "where"
            | "while"
            | "yield"
    )
}

/// Open-tabs registry. The editor shows real, recently-clicked files as tabs;
/// `recent_files` is the LRU. Caller maintains it on `SelectFile`.
pub fn push_recent(recent: &mut Vec<PathBuf>, path: &Path, cap: usize) {
    if let Some(pos) = recent.iter().position(|p| p == path) {
        recent.remove(pos);
    }
    recent.insert(0, path.to_path_buf());
    if recent.len() > cap {
        recent.truncate(cap);
    }
}
