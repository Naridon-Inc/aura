// Which agent session a terminal command belongs to.
//
// `aura log-intent` writes a row that the Console groups into a session by
// `session_id`. A hook that fires inside the desktop app knows the id and
// passes `--session`; a person or an agent running the command straight from
// a terminal does not, so the row landed with no session at all.
//
// The consequence was quiet and bad. The Console synthesises a terminal
// session out of the intent rows that share an id, and derives its window from
// them — so work logged without one never extended the session it belonged to.
// A session that had gone quiet for thirty minutes was closed by
// `close_stale_cli_sessions`, the next hour of real work arrived with no id to
// reopen it, and every commit made afterwards fell outside the window. The
// session sat there reading "ended" while its agent was still typing into it.
//
// Every agent CLI that runs Aura already publishes its own session id into the
// environment. Read it.
//
// A leaf module: resolution is a pure function of the environment, so it is
// tested as one.

/// Environment variables that carry an agent session id, most specific first.
///
/// `AURA_SESSION_ID` leads so a caller can always override — a wrapper script,
/// a crew node, a test. The rest are the agent CLIs' own names for the same
/// thing, and cost nothing to read when absent.
const SESSION_VARS: &[&str] = &[
    "AURA_SESSION_ID",
    "CLAUDE_CODE_SESSION_ID",
    "CODEX_SESSION_ID",
    "GEMINI_SESSION_ID",
    "CURSOR_SESSION_ID",
    "OPENCODE_SESSION_ID",
];

/// The session id this process belongs to, if the environment names one.
///
/// `lookup` is a parameter rather than a direct `std::env::var` call so the
/// rule can be tested without mutating the real process environment, which no
/// two tests can do at once.
pub fn resolve<F>(lookup: F) -> Option<String>
where
    F: Fn(&str) -> Option<String>,
{
    SESSION_VARS.iter().find_map(|name| {
        let value = lookup(name)?;
        let trimmed = value.trim();
        // An empty or whitespace-only variable is not an answer. Exported-but-
        // unset is the normal shape of a shell that mentioned the name once.
        (!trimmed.is_empty()).then(|| trimmed.to_string())
    })
}

/// {@link resolve} against the real process environment.
pub fn current() -> Option<String> {
    resolve(|name| std::env::var(name).ok())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::HashMap;

    fn env(pairs: &[(&str, &str)]) -> impl Fn(&str) -> Option<String> {
        let map: HashMap<String, String> = pairs
            .iter()
            .map(|(k, v)| ((*k).to_string(), (*v).to_string()))
            .collect();
        move |name: &str| map.get(name).cloned()
    }

    #[test]
    fn a_claude_code_terminal_knows_which_session_it_is() {
        let got = resolve(env(&[("CLAUDE_CODE_SESSION_ID", "d3f39198-610a-462b-8c3d-c6650e64aa21")]));
        assert_eq!(got.as_deref(), Some("d3f39198-610a-462b-8c3d-c6650e64aa21"));
    }

    #[test]
    fn an_explicit_aura_id_beats_the_agent_cli_s_own() {
        let got = resolve(env(&[
            ("CLAUDE_CODE_SESSION_ID", "from-claude"),
            ("AURA_SESSION_ID", "from-wrapper"),
        ]));
        assert_eq!(got.as_deref(), Some("from-wrapper"));
    }

    #[test]
    fn exported_but_empty_is_not_an_answer() {
        // A shell that mentions the name once exports it empty; treating that
        // as an id would file every such row under "".
        assert_eq!(resolve(env(&[("CLAUDE_CODE_SESSION_ID", "   ")])), None);
    }

    #[test]
    fn an_empty_one_does_not_shadow_a_real_one_behind_it() {
        let got = resolve(env(&[
            ("AURA_SESSION_ID", ""),
            ("CLAUDE_CODE_SESSION_ID", "real"),
        ]));
        assert_eq!(got.as_deref(), Some("real"));
    }

    #[test]
    fn a_plain_shell_belongs_to_no_session() {
        assert_eq!(resolve(env(&[])), None);
    }

    #[test]
    fn the_id_is_taken_without_the_whitespace_around_it() {
        let got = resolve(env(&[("CODEX_SESSION_ID", " abc \n")]));
        assert_eq!(got.as_deref(), Some("abc"));
    }
}
