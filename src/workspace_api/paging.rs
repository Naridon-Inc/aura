//! One meaning of "a page" on the client side (AURA-1437, item 11).
//!
//! These began inside [`crate::cloud_project`], which was the first command to
//! paginate. They moved here when `aura workspace list` became the second,
//! because the alternative was a second copy of the same two rules — and two
//! copies of a rule is how `--offset -1` ends up answered one way by one
//! command and another way by the next.
//!
//! The server validates the same window, because it is the authority for every
//! client that is not this one. What lives here only makes the CLI's answer
//! immediate and its exit code 2, like every other usage mistake.

/// Catch a page a caller could not have meant before spending a round trip on
/// it.
///
/// An oversized `--limit` is deliberately *not* caught: the server clamps it,
/// so "as many as you'll give me" is a reasonable thing to ask and refusing it
/// here would make the CLI stricter than the API it speaks for.
pub(crate) fn check_page(limit: Option<i64>, offset: Option<i64>) -> Option<&'static str> {
    match (limit, offset) {
        (Some(n), _) if n < 1 => Some("--limit must be at least 1"),
        (_, Some(n)) if n < 0 => Some("--offset cannot be negative"),
        _ => None,
    }
}

/// The command that fetches the *next* page of this one.
///
/// Built from the arguments the caller actually passed, so the footer prints
/// something runnable. The filter has to come along: a hint that said only
/// `--offset 2` would hand back a page of every status and look like the rest
/// of the archived ones. `--offset` itself is appended by the renderer, which
/// is the only place that knows how far the page reached.
pub(crate) fn next_cmd(base: &str, status: Option<&str>, limit: Option<i64>) -> String {
    let mut s = base.to_string();
    if let Some(st) = status {
        s.push_str(&format!(" --status {st}"));
    }
    if let Some(n) = limit {
        s.push_str(&format!(" --limit {n}"));
    }
    s
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_page_nobody_could_have_meant_is_caught_before_the_request() {
        assert!(check_page(Some(0), None).is_some());
        assert!(check_page(Some(-3), None).is_some());
        assert!(check_page(None, Some(-1)).is_some());
    }

    #[test]
    fn the_next_page_command_keeps_the_filter_it_was_asked_for() {
        // Following a hint that had dropped `--status` would show rows of
        // every status and read as the rest of the archived ones. Which base
        // each command names is tested where that command lives; this is the
        // rule about what gets carried along with it.
        assert_eq!(
            next_cmd("aura workspace list", Some("archived"), Some(2)),
            "aura workspace list --status archived --limit 2"
        );
        assert_eq!(next_cmd("aura workspace list", None, None), "aura workspace list");
        assert_eq!(
            next_cmd("aura workspace list", None, Some(10)),
            "aura workspace list --limit 10"
        );
    }

    #[test]
    fn an_oversized_limit_is_left_to_the_server_to_clamp() {
        // Refusing 5000 here would make the CLI stricter than the API it
        // speaks for — the server clamps, so asking is not a mistake.
        assert!(check_page(Some(5000), None).is_none());
        assert!(check_page(None, None).is_none());
        assert!(check_page(Some(1), Some(0)).is_none());
    }

    #[test]
    fn both_paging_commands_answer_a_bad_window_the_same_way() {
        // The reason this module exists. `aura project list` and
        // `aura workspace list` read the same flags; a caller who learns what
        // `--offset -1` does to one of them has learned it for both.
        assert_eq!(check_page(Some(0), None), Some("--limit must be at least 1"));
        assert_eq!(check_page(None, Some(-1)), Some("--offset cannot be negative"));
    }
}
