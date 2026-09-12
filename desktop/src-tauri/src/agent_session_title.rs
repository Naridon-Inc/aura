//! What an agent session is *about*, for the surfaces that list sessions.
//!
//! An interactive agent tab has no objective of its own — it is a terminal, and
//! the person's request lives inside the CLI's own transcript. So the cloud was
//! told the tool's name instead ("Claude Code", "Codex", "Gemini CLI"), and the
//! console and the phone listed a whole day's work under four labels: fifteen
//! rows reading "Claude Code", ten reading "Codex", none of them tellable apart.
//! The first thing the person typed is the sentence that names the work, and the
//! CLI is already writing it to disk, so read it from there.
//!
//! Best-effort by construction. An agent whose transcript we have no reader for,
//! a session nobody has typed into yet, and a file we cannot parse all return
//! `None`, and the caller keeps the tool's name as the label. A generic title is
//! a small cost; a confidently wrong one is a lie about what someone did.

use crate::manager::summarize_objective;

/// One line naming the work in this agent session, or `None` to keep the
/// caller's own label.
///
/// `repo_root` is the directory the session runs in, which is how every CLI
/// scopes its transcripts — a session authored in a worktree belongs to that
/// worktree, and that is the rule both readers below already follow.
pub fn opening_prompt(agent_id: &str, repo_root: &str) -> Option<String> {
    let raw = match agent_id {
        "claude" => crate::cmd_claude_sessions::opening_prompt_for_repo(repo_root),
        "codex" => crate::cmd_codex_sessions::opening_prompt_for_repo(repo_root),
        _ => None,
    }?;
    // The same trim the Manager's own chats are named with, so a session that
    // ran in a terminal and a session that ran in a chat read alike in a list.
    let named = summarize_objective(&raw);
    let named = named.trim();
    (!named.is_empty()).then(|| named.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn an_agent_we_have_no_reader_for_keeps_its_own_label() {
        assert_eq!(opening_prompt("cursor", "/nowhere"), None);
        assert_eq!(opening_prompt("gemini", "/nowhere"), None);
    }

    #[test]
    fn a_repo_the_agent_never_ran_in_has_no_title() {
        assert_eq!(
            opening_prompt("claude", "/tmp/aura-no-such-repo-ever"),
            None
        );
        assert_eq!(opening_prompt("codex", "/tmp/aura-no-such-repo-ever"), None);
    }

    /// Reads a transcript this machine actually has.
    ///
    /// The two tests above pin the shape of a miss, which is the part that has
    /// to hold on every machine. They cannot pin the part that matters — that
    /// a real CLI transcript yields a real sentence — because that needs a
    /// transcript, and one written by whoever is running the suite. So this is
    /// ignored by default and asks for the repo by name:
    ///
    ///     AURA_TITLE_REPO=/path/to/a/repo/an/agent/ran/in \
    ///       cargo test --lib agent_session_title -- --ignored --nocapture
    ///
    /// It asserts the weak thing on purpose — that something came back, that
    /// it is not the tool's own name, and that it fits a row — because the
    /// sentence itself belongs to whoever typed it and is different every run.
    #[test]
    #[ignore = "needs a repo on this machine that claude or codex has run in"]
    fn a_real_transcript_yields_a_real_sentence() {
        let Ok(repo) = std::env::var("AURA_TITLE_REPO") else {
            panic!("set AURA_TITLE_REPO to a repo an agent has run in");
        };
        let mut seen = 0;
        for agent in ["claude", "codex"] {
            let Some(title) = opening_prompt(agent, &repo) else {
                println!("{agent}: no transcript under {repo}");
                continue;
            };
            seen += 1;
            println!("{agent}: {title}");
            assert!(!title.trim().is_empty());
            assert_ne!(title, "Claude Code");
            assert_ne!(title, "Codex");
            // The summariser exists to keep a title to one line in a list.
            assert!(!title.contains('\n'), "a title is one line: {title}");
        }
        assert!(seen > 0, "no agent has run in {repo} — pick another repo");
    }
}
