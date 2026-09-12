//! The files a commit is about to write.
//!
//! Two gates ask the same question a few lines apart — the deletion guard,
//! which has to name those files in the command it hands back, and the
//! unexplained-writes gate, which has to know which of them nobody explained.
//! They used to answer it separately, and the deletion guard's answer was to
//! not ask at all: the command it printed named the removed symbols and no
//! files, so an agent that ran it verbatim satisfied the deletion guard and
//! was stopped one gate later by the writes gate, for a reason the first gate
//! had every chance to include. One answer, given once, keeps the two gates
//! talking about the same commit.

use git2::{Index, Repository};

/// Every path this commit adds or changes, minus Aura's own bookkeeping.
///
/// Deletions are left out on purpose: they are the deletion guard's subject,
/// not a write anybody has to declare.
pub fn staged(repo: &Repository, index: &Index) -> Vec<String> {
    let head_tree = repo.head().ok().and_then(|h| h.peel_to_tree().ok());
    let mut opts = git2::DiffOptions::new();
    let Ok(diff) = repo.diff_tree_to_index(head_tree.as_ref(), Some(index), Some(&mut opts)) else {
        return Vec::new();
    };

    let mut paths = Vec::new();
    for delta in diff.deltas() {
        use git2::Delta::{Added, Copied, Modified, Renamed, Typechange};
        if !matches!(delta.status(), Added | Modified | Renamed | Copied | Typechange) {
            continue;
        }
        let Some(path) = delta.new_file().path() else { continue };
        let path = path.to_string_lossy().to_string();
        if !is_aura_bookkeeping(&path) {
            paths.push(path);
        }
    }
    paths
}

/// Aura's own files, which no agent has to account for.
///
/// Besides the `.aura/` and `.git/` trees, the per-agent intent handshake
/// files live at the repository root. The pre-commit hook writes them itself,
/// so counting them would have Aura flagging its own control file as an
/// undeclared write on every single commit.
fn is_aura_bookkeeping(path: &str) -> bool {
    if path.contains(".aura/") || path.contains(".git/") {
        return true;
    }
    let name = std::path::Path::new(path)
        .file_name()
        .map(|n| n.to_string_lossy().to_string())
        .unwrap_or_default();
    matches!(name.as_str(), ".gemini.intent" | ".claude.intent" | ".aura.intent")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_source_file_is_a_write_somebody_has_to_own() {
        assert!(!is_aura_bookkeeping("src/billing.rs"));
        assert!(!is_aura_bookkeeping("docs/intent.md"));
    }

    #[test]
    fn auras_own_files_are_not_the_agents_to_explain() {
        assert!(is_aura_bookkeeping(".aura/intent_log.jsonl"));
        assert!(is_aura_bookkeeping("nested/.aura/blocks/1.json"));
        assert!(is_aura_bookkeeping(".gemini.intent"));
        assert!(is_aura_bookkeeping(".claude.intent"));
        assert!(is_aura_bookkeeping(".aura.intent"));
    }
}
