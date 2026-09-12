//! The file tree and the editor, at a place: list, read, save, make, move,
//! delete, and the project-wide index `⌘P` searches.
//!
//! Twins of `list_dir`, `read_file`, `write_file`, `fs_create_file`,
//! `fs_create_folder`, `fs_rename`, `fs_delete` and `fs_find_files` in
//! `cmd_files.rs`, answering in the same shapes. The local ones stamp the
//! editor-write tracker so the mutation guard can tell an editor save from an
//! agent's edit; that guard watches this disk, and these files are not on it.

use std::path::Path;

use crate::cloudbox::script::quote;
use crate::cmd_files::{is_always_hidden, language_for, DirEntry, FileContent};
use crate::git_parse::{files, status};

use super::{split_at_fence, Place, Work, PRINT_FENCE, WORK};

/// The same ceiling `read_file` has: past it the editor shows a placeholder
/// rather than beachballing — and here the bytes never leave the box.
const MAX_FILE_BYTES: u64 = 2_000_000;
/// How much of a file is looked at for a NUL before it is called binary.
const BINARY_SNIFF_BYTES: usize = 8192;

/// `ls -Ap` for the entries, then the directory's git status, one script.
/// `-p` marks directories with a slash, `-A` keeps dotfiles and drops `.`
/// and `..`. `ls` failing is the answer "not a directory".
fn list_script(dir: &str) -> String {
    format!(
        "ls -Ap -- {d} || exit 1; {PRINT_FENCE}; git status --porcelain=v1 -- {d} 2>/dev/null; exit 0",
        d = quote(dir)
    )
}

/// Size, then verdict, then the bytes — and only the bytes when the verdict
/// is `ok`, so a 2GB log costs two lines of transfer. The sniff is `od`
/// rather than a `grep` flag because `od` spells a NUL the same way on every
/// box.
fn read_script(file: &str) -> String {
    let f = quote(file);
    format!(
        "s=$(wc -c < {f}) || exit 1; printf '%s\\n' \"$s\"; \
         if [ \"$s\" -gt {MAX_FILE_BYTES} ]; then printf 'too_large\\n'; exit 0; fi; \
         if head -c {BINARY_SNIFF_BYTES} -- {f} | od -An -v -tx1 | grep -q ' 00'; then printf 'binary\\n'; exit 0; fi; \
         printf 'ok\\n'; cat -- {f}"
    )
}

/// Refuse an existing path, refuse a missing parent, make an empty file —
/// the same three steps as the local `fs_create_file`.
fn create_file_script(file: &str) -> String {
    let f = quote(file);
    format!(
        "if [ -e {f} ]; then echo 'path already exists' >&2; exit 1; fi; \
         if [ ! -d \"$(dirname -- {f})\" ]; then echo 'parent does not exist' >&2; exit 1; fi; \
         : > {f}"
    )
}

/// Plain `mkdir`, not `-p`: the parent must exist, as it must locally, so a
/// typo in a new folder's name never quietly makes three folders.
fn create_folder_script(dir: &str) -> String {
    let d = quote(dir);
    format!("if [ -e {d} ]; then echo 'path already exists' >&2; exit 1; fi; mkdir -- {d}")
}

/// The two `git ls-files` passes the local index makes, fenced.
fn find_files_script() -> String {
    format!(
        "git {}; {PRINT_FENCE}; git {}",
        files::TRACKED_ARGS.join(" "),
        files::IGNORED_ARGS.join(" ")
    )
}

/// What is immediately inside a directory of the project, with git badges.
#[tauri::command]
pub async fn place_fs_list(
    machine_id: String,
    root: String,
    remote_root: Option<String>,
    path: String,
) -> Result<Vec<DirEntry>, String> {
    let w = Work::at_worktree(Place::at_machine(&machine_id)?, &root, remote_root.as_deref())?;
    let rel = w.rel(&path)?;
    let out = w.ask(&list_script(&w.over_there(&rel))).await?;
    if !out.ok() {
        return Err(format!("not a directory: {path}"));
    }
    let (listing, porcelain) = split_at_fence(&out.stdout);
    // Badges keyed by project-relative path, slashes off, the way the local
    // map keys them by absolute path.
    let badges: std::collections::HashMap<String, char> = status::parse_porcelain_lines(porcelain)
        .into_iter()
        .map(|(p, ch)| (p.trim_end_matches('/').to_string(), ch))
        .collect();
    let mut entries: Vec<DirEntry> = listing
        .lines()
        .map(|l| l.trim_end_matches('\r'))
        .filter(|l| !l.is_empty())
        .filter_map(|l| {
            let (name, is_dir) = match l.strip_suffix('/') {
                Some(n) => (n, true),
                None => (l, false),
            };
            if is_always_hidden(name) {
                return None;
            }
            let entry_rel = if rel == "." { name.to_string() } else { format!("{rel}/{name}") };
            Some(DirEntry {
                path: w.over_here(&entry_rel),
                name: name.to_string(),
                is_dir,
                git_status: badges.get(&entry_rel).map(|c| c.to_string()),
            })
        })
        .collect();
    entries.sort_by(|a, b| match (a.is_dir, b.is_dir) {
        (true, false) => std::cmp::Ordering::Less,
        (false, true) => std::cmp::Ordering::Greater,
        _ => a.name.to_lowercase().cmp(&b.name.to_lowercase()),
    });
    Ok(entries)
}

/// A file for the editor: its text, or the reason there is none.
#[tauri::command]
pub async fn place_fs_read(
    machine_id: String,
    root: String,
    remote_root: Option<String>,
    path: String,
) -> Result<FileContent, String> {
    let w = Work::at_worktree(Place::at_machine(&machine_id)?, &root, remote_root.as_deref())?;
    let rel = w.rel(&path)?;
    let here = w.over_here(&rel);
    let out = w.ask(&read_script(&w.over_there(&rel))).await?;
    if !out.ok() {
        return Err(super::failed(&out, &format!("couldn't read {path}")));
    }
    let mut parts = out.stdout.splitn(3, '\n');
    let size: u64 = parts
        .next()
        .and_then(|s| s.trim().parse().ok())
        .ok_or_else(|| format!("{path}: the box gave no size for it"))?;
    let verdict = parts.next().unwrap_or("").trim().to_string();
    let text = if verdict == "ok" { parts.next().unwrap_or("").to_string() } else { String::new() };
    Ok(FileContent {
        language: language_for(Path::new(&here)),
        path: here,
        text,
        size,
        status: if verdict.is_empty() { "ok".to_string() } else { verdict },
    })
}

/// The editor's save.
#[tauri::command]
pub async fn place_fs_write(
    machine_id: String,
    root: String,
    remote_root: Option<String>,
    path: String,
    contents: String,
) -> Result<(), String> {
    let w = Work::at_worktree(Place::at_machine(&machine_id)?, &root, remote_root.as_deref())?;
    let rel = w.rel(&path)?;
    w.place.write(&rel, &contents).await
}

/// A new empty file. Answers with its path as the frontend spells it.
#[tauri::command]
pub async fn place_fs_create_file(
    machine_id: String,
    root: String,
    remote_root: Option<String>,
    path: String,
) -> Result<String, String> {
    let w = Work::at_worktree(Place::at_machine(&machine_id)?, &root, remote_root.as_deref())?;
    let rel = w.rel(&path)?;
    let out = w.ask(&create_file_script(&w.over_there(&rel))).await?;
    if !out.ok() {
        return Err(format!("{}: {path}", super::failed(&out, "couldn't create")));
    }
    Ok(w.over_here(&rel))
}

/// A new folder. Answers with its path as the frontend spells it.
#[tauri::command]
pub async fn place_fs_create_folder(
    machine_id: String,
    root: String,
    remote_root: Option<String>,
    path: String,
) -> Result<String, String> {
    let w = Work::at_worktree(Place::at_machine(&machine_id)?, &root, remote_root.as_deref())?;
    let rel = w.rel(&path)?;
    let out = w.ask(&create_folder_script(&w.over_there(&rel))).await?;
    if !out.ok() {
        return Err(format!("{}: {path}", super::failed(&out, "couldn't create")));
    }
    Ok(w.over_here(&rel))
}

/// Rename or move, refusing to land on something that exists.
#[tauri::command]
pub async fn place_fs_rename(
    machine_id: String,
    root: String,
    remote_root: Option<String>,
    from: String,
    to: String,
) -> Result<String, String> {
    let w = Work::at_worktree(Place::at_machine(&machine_id)?, &root, remote_root.as_deref())?;
    let a = w.rel(&from)?;
    let b = w.rel(&to)?;
    w.place.rename(&a, &b).await?;
    Ok(w.over_here(&b))
}

/// A hard delete, recursive for a folder. The UI confirms first.
#[tauri::command]
pub async fn place_fs_delete(machine_id: String, root: String, remote_root: Option<String>, path: String) -> Result<(), String> {
    let w = Work::at_worktree(Place::at_machine(&machine_id)?, &root, remote_root.as_deref())?;
    let rel = w.rel(&path)?;
    w.place.remove(&rel).await
}

/// The project-wide index for `⌘P` and `@`-mentions: project-relative
/// paths, sorted. Empty when the box has no git there, as locally.
#[tauri::command]
pub async fn place_fs_find_files(machine_id: String, root: String, remote_root: Option<String>) -> Vec<String> {
    let Ok(w) = Place::at_machine(&machine_id).and_then(|p| Work::at_worktree(p, &root, remote_root.as_deref())) else {
        return Vec::new();
    };
    let Ok(out) = w.run(&find_files_script(), WORK).await else {
        return Vec::new();
    };
    let (tracked, ignored) = split_at_fence(&out.stdout);
    files::merge_index(files::lines(tracked), files::lines(ignored))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_listing_and_its_badges_are_one_round_trip() {
        let s = list_script("/home/u/p/src");
        assert!(s.starts_with("ls -Ap -- '/home/u/p/src' || exit 1; printf '\\036\\n'; git status --porcelain=v1 -- '/home/u/p/src'"));
        assert!(s.ends_with("exit 0"));
    }

    #[test]
    fn a_read_sends_the_bytes_only_when_the_file_is_text_and_small() {
        let s = read_script("/home/u/p/a.rs");
        assert!(s.contains("wc -c < '/home/u/p/a.rs'"));
        assert!(s.contains("-gt 2000000"));
        assert!(s.contains("head -c 8192 -- '/home/u/p/a.rs' | od -An -v -tx1 | grep -q ' 00'"));
        assert!(s.ends_with("printf 'ok\\n'; cat -- '/home/u/p/a.rs'"));
    }

    #[test]
    fn making_things_refuses_what_exists_and_needs_a_parent() {
        assert_eq!(
            create_file_script("/p/new file"),
            "if [ -e '/p/new file' ]; then echo 'path already exists' >&2; exit 1; fi; \
             if [ ! -d \"$(dirname -- '/p/new file')\" ]; then echo 'parent does not exist' >&2; exit 1; fi; \
             : > '/p/new file'"
        );
        assert_eq!(
            create_folder_script("/p/d"),
            "if [ -e '/p/d' ]; then echo 'path already exists' >&2; exit 1; fi; mkdir -- '/p/d'"
        );
    }

    #[test]
    fn the_index_runs_the_same_two_listings_the_laptop_does() {
        assert_eq!(
            find_files_script(),
            "git ls-files --cached --others --exclude-standard; printf '\\036\\n'; \
             git ls-files --others --ignored --exclude-standard --directory"
        );
    }

    #[test]
    fn a_path_is_quoted_before_it_meets_a_shell() {
        assert!(super::super::paths::rel_of("/r", "it's").is_err());
        assert!(list_script("/r/a b").contains("'/r/a b'"));
    }
}
