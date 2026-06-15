//! Dispatcher for which CRDT doc layout applies to a file (plan W4.3).
//!
//! MVP: whole-file CRDT for every text file. The per-function splitter
//! (`FunctionList`) lands in a follow-up once the file path is stable.

use std::path::Path;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum CrdtKind {
    /// One yrs doc covering the full file text.
    File,
    /// File is AST-split into per-function docs + one envelope file doc.
    /// Not yet active — treated as `File` until the splitter ships.
    FunctionList,
}

/// Max file size we CRDT. Binaries and generated blobs skip CRDT and use
/// hash-conflict path instead (W3). Configurable later via `.aura/config.toml`.
pub const MAX_CRDT_FILE_BYTES: u64 = 5 * 1024 * 1024;

/// Paths we never CRDT under any circumstance (binaries, caches, lock files
/// that are rewritten atomically by tooling, secrets).
const BLOCKED_PREFIXES: &[&str] = &[
    "target/",
    "node_modules/",
    ".aura/",
    ".git/",
    ".ssh/",
    "dist/",
    "build/",
];

const BINARY_EXTS: &[&str] = &[
    "png", "jpg", "jpeg", "gif", "webp", "pdf", "ico", "bmp",
    "mp4", "mov", "mp3", "wav", "flac",
    "zip", "tar", "gz", "xz", "bz2", "7z",
    "wasm", "so", "dylib", "dll", "exe", "o", "a", "bin",
];

/// Credential-bearing files. These are plain text but must never fan out to
/// teammates over a Live session — a collab feature that syncs `.env` or a
/// private key would be a security incident, not a feature.
fn is_secret_path(path: &Path) -> bool {
    let name = path
        .file_name()
        .and_then(|s| s.to_str())
        .unwrap_or("");
    // dotenv family: .env, .env.local, .env.production, ...
    if name == ".env" || name.starts_with(".env.") {
        return true;
    }
    const SECRET_NAMES: &[&str] = &[
        "id_rsa", "id_ed25519", "id_ecdsa", "id_dsa",
        ".netrc", ".pgpass", ".htpasswd", "credentials",
    ];
    if SECRET_NAMES.contains(&name) {
        return true;
    }
    if let Some(ext) = path.extension().and_then(|s| s.to_str()) {
        const SECRET_EXTS: &[&str] =
            &["pem", "key", "p12", "pfx", "keystore", "jks", "asc", "gpg"];
        if SECRET_EXTS.contains(&ext.to_ascii_lowercase().as_str()) {
            return true;
        }
    }
    false
}

pub fn is_crdt_eligible(path: &Path) -> bool {
    let p = path.to_string_lossy();
    for pref in BLOCKED_PREFIXES {
        if p.starts_with(pref) || p.contains(&format!("/{}", pref)) {
            return false;
        }
    }
    if is_secret_path(path) {
        return false;
    }
    if let Some(ext) = path.extension().and_then(|s| s.to_str()) {
        if BINARY_EXTS.contains(&ext.to_ascii_lowercase().as_str()) {
            return false;
        }
    }
    if let Ok(meta) = std::fs::metadata(path) {
        if meta.len() > MAX_CRDT_FILE_BYTES {
            return false;
        }
    }
    true
}

pub fn classify(path: &Path) -> CrdtKind {
    // FunctionList deferred — ship File for everything first so the
    // transport is exercised end-to-end.
    let _ = path;
    CrdtKind::File
}

pub fn kind_str(k: CrdtKind) -> &'static str {
    match k {
        CrdtKind::File => "file",
        CrdtKind::FunctionList => "function",
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::Path;

    fn eligible(p: &str) -> bool {
        is_crdt_eligible(Path::new(p))
    }

    #[test]
    fn text_files_of_any_kind_sync() {
        // Code and non-code alike — the "everything in the tree" guarantee.
        for p in [
            "src/main.rs",
            "README.md",
            "Cargo.toml",
            "package.json",
            "config.yaml",
            "notes.txt",
            "Makefile",
        ] {
            assert!(eligible(p), "{p} should be CRDT-eligible");
        }
    }

    #[test]
    fn build_dirs_and_binaries_are_skipped() {
        for p in [
            "target/debug/aura",
            "node_modules/x/index.js",
            ".git/config",
            ".aura/crdt/state.bin",
            "dist/app.js",
            "assets/logo.png",
            "vendor.tar.gz",
            "lib/native.dylib",
        ] {
            assert!(!eligible(p), "{p} must be skipped");
        }
    }

    #[test]
    fn secrets_never_sync() {
        for p in [
            ".env",
            ".env.production",
            "config/.env.local",
            "keys/server.pem",
            "tls/private.key",
            "certs/bundle.p12",
            ".ssh/id_ed25519",
            "deploy/id_rsa",
        ] {
            assert!(!eligible(p), "{p} is a secret and must not sync");
        }
    }
}
