//! `git status --porcelain=v1`, read two ways: as rows for the Changes list
//! and as one letter per path for the file tree's badges.

use serde::Serialize;

/// One row of `git status --porcelain=v1 -z`. `index` is the staged side
/// (commit-bound), `worktree` the unstaged side. Untracked files come back
/// as `("?", "?")`. The frontend uses this to render staged vs unstaged
/// sections in the Source Control sidebar.
#[derive(Serialize, Debug, Clone, PartialEq, Eq)]
pub struct StatusEntry {
    pub path: String,
    pub index: String,
    pub worktree: String,
}

/// `git status --porcelain=v1 -z` → rows. A rename record carries
/// `new -> old`; the *new* path is the one the user is looking at.
pub fn parse_porcelain_z(text: &str) -> Vec<StatusEntry> {
    let mut entries = Vec::new();
    for chunk in text.split('\0') {
        if chunk.len() < 4 {
            continue;
        }
        let bytes = chunk.as_bytes();
        let x = bytes[0] as char;
        let y = bytes[1] as char;
        let path_part = &chunk[3..];
        let rel = match path_part.find(" -> ") {
            Some(idx) => &path_part[idx + 4..],
            None => path_part,
        };
        entries.push(StatusEntry {
            path: rel.to_string(),
            index: if x == ' ' { String::new() } else { x.to_string() },
            worktree: if y == ' ' { String::new() } else { y.to_string() },
        });
    }
    entries
}

/// The one letter the file tree draws beside a path, from the two porcelain
/// columns.
///
/// Order matters. A conflict has to be recognised BEFORE the A/D ladder,
/// because git spells several of its unmerged states with the very letters
/// that ladder is looking for. `AA` (both added) and `DD` (both deleted) are
/// conflicts, not an add and a delete, and `UU` (both modified) used to fall
/// past every arm into the `else` and come out as an ordinary modified file —
/// so a file with conflict markers sitting in it looked exactly like one you
/// had just edited.
///
/// The unmerged set, in full, is: DD AU UD UA DU AA UU — which is "either
/// side is U, or both sides carry the same letter".
pub fn status_letter(x: char, y: char) -> char {
    let unmerged = x == 'U' || y == 'U' || (x == 'A' && y == 'A') || (x == 'D' && y == 'D');
    if x == '?' || y == '?' {
        '?'
    } else if unmerged {
        'U'
    } else if x == 'R' || y == 'R' {
        // A rename reported as "modified" sends you looking for an edit that
        // was never made.
        'R'
    } else if x == 'A' || y == 'A' {
        'A'
    } else if x == 'D' || y == 'D' {
        'D'
    } else {
        'M'
    }
}

/// `git status --porcelain=v1` (newline records) → `(repo-relative path,
/// letter)` pairs. Quoted paths — the ones git C-escapes because they carry
/// odd bytes — are skipped, as the tree always has.
pub fn parse_porcelain_lines(text: &str) -> Vec<(String, char)> {
    let mut out = Vec::new();
    for line in text.lines() {
        if line.len() < 4 {
            continue;
        }
        let bytes = line.as_bytes();
        let x = bytes[0] as char;
        let y = bytes[1] as char;
        let path_part = &line[3..];
        if path_part.starts_with('"') {
            continue;
        }
        let rel = match path_part.find(" -> ") {
            Some(idx) => &path_part[idx + 4..],
            None => path_part,
        };
        out.push((rel.to_string(), status_letter(x, y)));
    }
    out
}

/// How many entries a `git status --porcelain -z` listing has — the figure
/// shown as "Also reset files (N)". Records are NUL-terminated; a rename
/// carries a second NUL-terminated path, which is still one changed entry —
/// close enough for a count.
pub fn count_records(stdout: &[u8]) -> u32 {
    stdout.split(|b| *b == 0).filter(|r| !r.is_empty()).count() as u32
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn nul_records_become_rows_with_the_new_name_of_a_rename() {
        let text = " M src/a.rs\0A  src/b.rs\0?? new.txt\0R  old.rs -> new.rs\0";
        let rows = parse_porcelain_z(text);
        assert_eq!(rows.len(), 4);
        assert_eq!(rows[0], StatusEntry { path: "src/a.rs".into(), index: "".into(), worktree: "M".into() });
        assert_eq!(rows[1].index, "A");
        assert_eq!(rows[1].worktree, "");
        assert_eq!(rows[2].index, "?");
        assert_eq!(rows[2].worktree, "?");
        assert_eq!(rows[3].path, "new.rs");
    }

    #[test]
    fn a_conflict_is_a_conflict_before_it_is_an_add_or_a_delete() {
        assert_eq!(status_letter('U', 'U'), 'U');
        assert_eq!(status_letter('A', 'A'), 'U');
        assert_eq!(status_letter('D', 'D'), 'U');
        assert_eq!(status_letter('A', ' '), 'A');
        assert_eq!(status_letter(' ', 'D'), 'D');
        assert_eq!(status_letter('R', ' '), 'R');
        assert_eq!(status_letter('?', '?'), '?');
        assert_eq!(status_letter(' ', 'M'), 'M');
    }

    #[test]
    fn newline_records_skip_quoted_paths() {
        let text = " M a.rs\n?? \"we ird\".txt\nR  x -> y\n";
        let rows = parse_porcelain_lines(text);
        assert_eq!(rows, vec![("a.rs".to_string(), 'M'), ("y".to_string(), 'R')]);
    }

    #[test]
    fn counting_records_ignores_the_trailing_terminator() {
        assert_eq!(count_records(b" M a\0?? b\0"), 2);
        assert_eq!(count_records(b""), 0);
    }
}
