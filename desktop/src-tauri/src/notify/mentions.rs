//! @-mention extraction, kept byte-for-byte faithful to the frontend
//! parser in `src/lib/mentions.ts` so a body authored in the web UI and
//! one re-parsed here always agree on *who* was tagged.
//!
//! The frontend regex is `/(^|[\s(\[{>])@([a-zA-Z0-9][a-zA-Z0-9._-]*)/g`:
//! a mention is `@handle` where `handle` starts with an alphanumeric and
//! continues with alphanumerics or `.`/`_`/`-`, and is preceded by either
//! the start of the string or one of whitespace / `(` / `[` / `{` / `>`.
//! That leading-character rule is what keeps email addresses like
//! `foo@bar.com` from matching — the `@` there is preceded by a word
//! character, not a separator.
//!
//! We reproduce this without a regex engine (no `regex` crate dependency
//! in this module's budget) by walking the chars. The result is
//! lowercased, de-duplicated, and order-preserving — same contract as the
//! frontend's `extractHandles`, plus the lowercase normalisation the rail
//! relies on for handle equality.

/// The set of characters that may immediately precede an `@` for it to
/// open a mention. Start-of-string is handled separately. Mirrors the
/// `[\s(\[{>]` class in the frontend regex (`\s` = ASCII + Unicode
/// whitespace).
fn is_mention_prefix(c: char) -> bool {
    c.is_whitespace() || matches!(c, '(' | '[' | '{' | '>')
}

/// The first character of a handle: `[a-zA-Z0-9]`.
fn is_handle_start(c: char) -> bool {
    c.is_ascii_alphanumeric()
}

/// Subsequent handle characters: `[a-zA-Z0-9._-]`.
fn is_handle_body(c: char) -> bool {
    c.is_ascii_alphanumeric() || matches!(c, '.' | '_' | '-')
}

/// Extract the handles mentioned in `text`. Lowercased, de-duplicated,
/// order-preserving. Emails (`@` preceded by a word character) are
/// excluded, matching the frontend parser exactly.
pub fn extract_mentions(text: &str) -> Vec<String> {
    let mut out: Vec<String> = Vec::new();
    let mut seen: std::collections::HashSet<String> = std::collections::HashSet::new();

    let chars: Vec<char> = text.chars().collect();
    let mut i = 0usize;
    while i < chars.len() {
        if chars[i] != '@' {
            i += 1;
            continue;
        }
        // The `@` must be at start-of-string or immediately follow a
        // valid prefix char; otherwise it's part of an email / word and
        // is skipped.
        let prefix_ok = i == 0 || is_mention_prefix(chars[i - 1]);
        if !prefix_ok {
            i += 1;
            continue;
        }
        // First handle char must be alphanumeric.
        let start = i + 1;
        if start >= chars.len() || !is_handle_start(chars[start]) {
            i += 1;
            continue;
        }
        let mut end = start + 1;
        while end < chars.len() && is_handle_body(chars[end]) {
            end += 1;
        }
        let handle: String = chars[start..end].iter().collect::<String>().to_lowercase();
        if seen.insert(handle.clone()) {
            out.push(handle);
        }
        // Resume scanning *after* the handle. A second `@` glued to the
        // tail (e.g. `@a@b`) would not have a valid prefix char anyway.
        i = end;
    }
    out
}

#[cfg(test)]
mod tests {
    use super::extract_mentions;

    #[test]
    fn plain_mention() {
        assert_eq!(extract_mentions("hey @alice there"), vec!["alice"]);
    }

    #[test]
    fn start_of_line() {
        assert_eq!(extract_mentions("@bob ship it"), vec!["bob"]);
    }

    #[test]
    fn parenthesised() {
        assert_eq!(extract_mentions("(@bob)"), vec!["bob"]);
    }

    #[test]
    fn bracket_and_brace_prefixes() {
        assert_eq!(extract_mentions("[@carol] {@dave}"), vec!["carol", "dave"]);
    }

    #[test]
    fn quote_prefix() {
        assert_eq!(extract_mentions(">@erin replied"), vec!["erin"]);
    }

    #[test]
    fn email_excluded() {
        // `@` preceded by a word character → not a mention.
        assert_eq!(extract_mentions("ping x@y.com now"), Vec::<String>::new());
    }

    #[test]
    fn email_excluded_among_real() {
        assert_eq!(
            extract_mentions("@alice mailed bob@corp.com about it"),
            vec!["alice"]
        );
    }

    #[test]
    fn dotted_and_punctuated_handle() {
        // Full handle body class: letters, digits, `.`, `_`, `-`.
        assert_eq!(extract_mentions("see @a.b_c-d here"), vec!["a.b_c-d"]);
    }

    #[test]
    fn trailing_punctuation_kept_out() {
        // "Ping @alice." should tag @alice (the `.` is body, so it would
        // be included by the regex too — assert the on-the-edge case of a
        // trailing space-separated period).
        assert_eq!(extract_mentions("Ping @alice, then go"), vec!["alice"]);
    }

    #[test]
    fn lowercased_and_deduped_order_preserving() {
        assert_eq!(
            extract_mentions("@Bob @alice @BOB @Carol @alice"),
            vec!["bob", "alice", "carol"]
        );
    }

    #[test]
    fn empty_and_lone_at() {
        assert!(extract_mentions("").is_empty());
        assert!(extract_mentions("@").is_empty());
        assert!(extract_mentions("@ space").is_empty());
        // `@_x` is rejected — handle must START alphanumeric.
        assert!(extract_mentions("@_nope").is_empty());
    }
}
