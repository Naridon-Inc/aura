//! Seeding a new workspace with the files git doesn't carry — the
//! repository's `[copy] files` (`.env`, `.env.local`, `config/*.local`),
//! copied from the main checkout into the new one before its setup script
//! runs. Best-effort: a missing or unreadable file is skipped, never fatal.

use std::io::Read;
use std::path::{Component, Path};

/// Files larger than this count as binary whatever their bytes say.
pub const BINARY_SIZE_LIMIT: u64 = 20 * 1024 * 1024;
const BINARY_SNIFF_BYTES: usize = 8 * 1024;

/// What the copy did, for the first lines of the setup log.
#[derive(Debug, Default, PartialEq, Eq)]
pub struct CopyReport {
    pub copied: Vec<String>,
    /// Left out because they look binary and binaries weren't asked for.
    pub skipped_binary: Vec<String>,
}

impl CopyReport {
    /// The lines the setup log opens with; none when nothing was copied or
    /// skipped.
    pub fn log_lines(&self) -> Vec<String> {
        let mut out = Vec::new();
        if !self.copied.is_empty() {
            out.push(format!("Copied {} into this workspace", self.copied.join(", ")));
        }
        if !self.skipped_binary.is_empty() {
            out.push(format!(
                "Didn't copy {} — binary files are only copied when the repository's copy settings include them",
                self.skipped_binary.join(", ")
            ));
        }
        out
    }
}

/// Copy each `[copy] files` entry from `repo_root` into `worktree`.
pub fn copy_files_into(
    repo_root: &Path,
    worktree: &Path,
    entries: &[String],
    include_binaries: bool,
) -> CopyReport {
    let mut report = CopyReport::default();
    for entry in entries {
        let entry = entry.trim();
        if entry.is_empty() {
            continue;
        }
        for rel in expand_entry(repo_root, entry) {
            if !include_binaries && looks_binary(&repo_root.join(&rel)) {
                report.skipped_binary.push(rel);
                continue;
            }
            if copy_one(repo_root, worktree, &rel) {
                report.copied.push(rel);
            }
        }
    }
    report
}

/// One entry to the paths it names: itself, or for an entry with `*` in its
/// last segment, the files in that folder whose names match.
fn expand_entry(repo_root: &Path, entry: &str) -> Vec<String> {
    if !entry.contains('*') {
        return vec![entry.to_string()];
    }
    let normalized = entry.replace('\\', "/");
    let (dir_part, pat) = match normalized.rsplit_once('/') {
        Some((d, p)) => (d.to_string(), p.to_string()),
        None => (String::new(), normalized.clone()),
    };
    let scan = if dir_part.is_empty() { repo_root.to_path_buf() } else { repo_root.join(&dir_part) };
    let Ok(read) = std::fs::read_dir(&scan) else { return Vec::new() };
    let mut out: Vec<String> = read
        .flatten()
        .filter_map(|e| {
            let name = e.file_name().to_string_lossy().into_owned();
            glob_match(&pat, &name).then(|| {
                if dir_part.is_empty() { name } else { format!("{dir_part}/{name}") }
            })
        })
        .collect();
    out.sort();
    out
}

/// PURE: match one path segment against a pattern where `*` is any run of
/// characters.
pub fn glob_match(pattern: &str, name: &str) -> bool {
    let p: Vec<char> = pattern.chars().collect();
    let n: Vec<char> = name.chars().collect();
    let (mut pi, mut ni) = (0usize, 0usize);
    let (mut star, mut mark) = (None, 0usize);
    while ni < n.len() {
        if pi < p.len() && p[pi] == n[ni] {
            pi += 1;
            ni += 1;
        } else if pi < p.len() && p[pi] == '*' {
            star = Some(pi);
            mark = ni;
            pi += 1;
        } else if let Some(s) = star {
            pi = s + 1;
            mark += 1;
            ni = mark;
        } else {
            return false;
        }
    }
    while pi < p.len() && p[pi] == '*' {
        pi += 1;
    }
    pi == p.len()
}

/// A NUL in the first 8 KiB, or over [`BINARY_SIZE_LIMIT`].
fn looks_binary(path: &Path) -> bool {
    if std::fs::metadata(path).is_ok_and(|m| m.len() > BINARY_SIZE_LIMIT) {
        return true;
    }
    let Ok(mut file) = std::fs::File::open(path) else { return false };
    let mut head = vec![0u8; BINARY_SNIFF_BYTES];
    let mut filled = 0usize;
    while filled < head.len() {
        match file.read(&mut head[filled..]) {
            Ok(0) => break,
            Ok(n) => filled += n,
            Err(_) => return false,
        }
    }
    head[..filled].contains(&0)
}

/// Copy one repository-relative file to the same place in the workspace.
/// Never anything absolute or reaching out with `..`.
fn copy_one(repo_root: &Path, worktree: &Path, rel: &str) -> bool {
    let rel_path = Path::new(rel);
    if rel_path.is_absolute() || rel_path.components().any(|c| matches!(c, Component::ParentDir)) {
        return false;
    }
    let src = repo_root.join(rel_path);
    if !src.is_file() {
        return false;
    }
    let dst = worktree.join(rel_path);
    if let Some(parent) = dst.parent() {
        if std::fs::create_dir_all(parent).is_err() {
            return false;
        }
    }
    std::fs::copy(&src, &dst).is_ok()
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;

    #[test]
    fn star_matches_any_run_of_characters() {
        assert!(glob_match(".env*", ".env.local"));
        assert!(glob_match("*.local", "config.local"));
        assert!(!glob_match("*.local", "config.json"));
    }

    #[test]
    fn copies_named_and_matched_files_and_says_what_it_skipped() {
        let repo = tempfile::tempdir().unwrap();
        let wt = tempfile::tempdir().unwrap();
        fs::write(repo.path().join(".env"), "A=1").unwrap();
        fs::write(repo.path().join(".env.local"), "B=2").unwrap();
        fs::write(repo.path().join(".env.db"), b"\x00\x01").unwrap();
        fs::create_dir_all(repo.path().join("config")).unwrap();
        fs::write(repo.path().join("config/app.local"), "C=3").unwrap();
        let entries = vec![".env*".to_string(), "config/*.local".to_string(), "missing".to_string()];
        let report = copy_files_into(repo.path(), wt.path(), &entries, false);
        assert_eq!(report.copied, vec![".env", ".env.local", "config/app.local"]);
        assert_eq!(report.skipped_binary, vec![".env.db"]);
        assert_eq!(fs::read_to_string(wt.path().join("config/app.local")).unwrap(), "C=3");
        assert_eq!(report.log_lines().len(), 2);
    }

    #[test]
    fn never_reaches_outside_the_repository() {
        let repo = tempfile::tempdir().unwrap();
        let wt = tempfile::tempdir().unwrap();
        let entries = vec!["../secret".to_string(), "/etc/hosts".to_string()];
        assert_eq!(copy_files_into(repo.path(), wt.path(), &entries, true), CopyReport::default());
    }
}
