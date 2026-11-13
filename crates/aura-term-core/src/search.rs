//! Find-in-terminal — the scan half, with no terminal in it.
//!
//! The GPU engine owns its grid in Rust, so a search over what a terminal has
//! shown cannot be done where the other engine does it. xterm.js hands its
//! SearchAddon a buffer the webview already holds; here the buffer is behind a
//! mutex on the render thread, and the only honest place to look through it is
//! this side of the IPC boundary.
//!
//! What lives here is deliberately only the matching: rows of text in, hits
//! out. [`crate::grid::GridTerminal`] reads the rows off the live grid and
//! decides what to do with the hits (scroll to one, wash them), and because
//! that part is the part that needs a PTY, keeping it out of here is what lets
//! every matching rule below be a unit test.
//!
//! Positions are carried in GRID columns rather than string indices. A row's
//! text is not its cells: a wide glyph occupies two columns and contributes one
//! character, so the Nth character of a line is not the Nth column of it, and a
//! highlight placed at a string index drifts one cell left per CJK character
//! ahead of it on the row. [`RowText`] carries the mapping it was built with so
//! a hit comes back in the coordinates the renderer draws in.

/// How to interpret the query. Mirrors the three toggles the find widget
/// already shows for xterm panes (`Aa`, `.*`, `W`), because the widget is
/// shared and a toggle that only worked on one engine would be a lie on the
/// other.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct SearchOpts {
    pub case_sensitive: bool,
    /// Match only where the hit is bounded by non-word characters.
    pub whole_word: bool,
    /// Treat the query as a regular expression rather than literal text.
    pub regex: bool,
}

/// One match, in the coordinates the grid is drawn in: `line` is an absolute
/// alacritty line (negative in scrollback, 0.. on the live screen), `col` is
/// the first grid column the match covers and `len` how many columns it spans.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct SearchHit {
    pub line: i32,
    pub col: u16,
    pub len: u16,
}

/// A row of the grid as text, plus the column each character came from.
///
/// `cols[i]` is the grid column of the `i`th character of `text`, and
/// `end_col` is one past the last column the row's characters occupy — the
/// span of a hit that runs to the end of the row. Built by the grid, which is
/// the only thing that knows which cells were wide-glyph spacers.
#[derive(Clone, Debug)]
pub struct RowText {
    pub line: i32,
    pub text: String,
    pub cols: Vec<u16>,
    pub end_col: u16,
}

impl RowText {
    /// The column span of the characters `[start, end)` of this row.
    ///
    /// Clamped rather than indexed blind: a regex can report a match that ends
    /// at the end of the string, and `cols` has no entry one past the last
    /// character.
    fn span(&self, start: usize, end: usize) -> Option<(u16, u16)> {
        if end <= start {
            return None;
        }
        let c0 = *self.cols.get(start)?;
        let c1 = self.cols.get(end).copied().unwrap_or(self.end_col);
        if c1 <= c0 {
            return None;
        }
        Some((c0, c1 - c0))
    }
}

/// Every hit in `rows`, in reading order.
///
/// An empty query has no hits — not every hit — because the find widget runs a
/// search on each keystroke and an empty field is the state it starts in.
///
/// A bad regular expression is an error rather than zero hits: the widget
/// shows "no results" for a query that genuinely matches nothing, and a user
/// halfway through typing `(foo` has not asked a question yet. Telling the two
/// apart is the difference between a field that explains itself and one that
/// silently reports nothing.
pub fn scan(rows: &[RowText], query: &str, opts: SearchOpts) -> Result<Vec<SearchHit>, String> {
    if query.is_empty() {
        return Ok(Vec::new());
    }
    if opts.regex {
        scan_regex(rows, query, opts)
    } else {
        Ok(scan_literal(rows, query, opts))
    }
}

/// Which hit a search should land on when it is (re)run.
///
/// The rule is "the first match at or after where you are looking", so typing
/// into the field walks forward from the viewport instead of jumping to the top
/// of the scrollback. `None` when there are no hits at all.
pub fn hit_at_or_after(hits: &[SearchHit], line: i32) -> Option<usize> {
    if hits.is_empty() {
        return None;
    }
    // Hits are in reading order and scrollback lines are negative, so the
    // first one whose line is not above the viewport is the answer; falling off
    // the end means every hit is behind us and the search wraps to the first.
    Some(hits.iter().position(|h| h.line >= line).unwrap_or(0))
}

/// Literal matching, character by character.
///
/// Char-indexed rather than byte-indexed on purpose. Case folding a whole row
/// with `to_lowercase` can change its length — `İ` folds to two characters —
/// and a byte offset taken from the folded copy then addresses the wrong cell
/// of the original. Folding one character at a time keeps the two strings in
/// step, which is all the column mapping needs.
fn scan_literal(rows: &[RowText], query: &str, opts: SearchOpts) -> Vec<SearchHit> {
    let needle: Vec<char> = query.chars().map(|c| fold(c, opts.case_sensitive)).collect();
    let mut out = Vec::new();
    for row in rows {
        let hay: Vec<char> = row.text.chars().map(|c| fold(c, opts.case_sensitive)).collect();
        if hay.len() < needle.len() {
            continue;
        }
        let mut i = 0;
        while i + needle.len() <= hay.len() {
            if hay[i..i + needle.len()] == needle[..] {
                let end = i + needle.len();
                if !opts.whole_word || bounded(&hay, i, end) {
                    if let Some((col, len)) = row.span(i, end) {
                        out.push(SearchHit { line: row.line, col, len });
                    }
                    // Overlapping hits are not two answers to "find next", so
                    // the walk resumes after the match rather than inside it.
                    i = end;
                    continue;
                }
            }
            i += 1;
        }
    }
    out
}

/// Regex matching, with the same two modifiers applied through the pattern
/// itself so there is one matcher rather than one per toggle combination.
fn scan_regex(
    rows: &[RowText],
    query: &str,
    opts: SearchOpts,
) -> Result<Vec<SearchHit>, String> {
    let mut pattern = String::new();
    if !opts.case_sensitive {
        pattern.push_str("(?i)");
    }
    if opts.whole_word {
        // Non-capturing, because the user's pattern may contain alternation and
        // `\bfoo|bar\b` is not the question they asked.
        pattern.push_str("\\b(?:");
        pattern.push_str(query);
        pattern.push_str(")\\b");
    } else {
        pattern.push_str(query);
    }
    let re = regex::Regex::new(&pattern).map_err(|e| e.to_string())?;
    let mut out = Vec::new();
    for row in rows {
        // The regex crate answers in byte offsets and the column map is
        // char-indexed, so each row carries a byte -> char index beside it for
        // exactly as long as this row is being scanned.
        let chars: Vec<(usize, char)> = row.text.char_indices().collect();
        let char_of = |byte: usize| -> usize {
            chars
                .iter()
                .position(|(b, _)| *b >= byte)
                .unwrap_or(chars.len())
        };
        for m in re.find_iter(&row.text) {
            // A zero-width match (`^`, `\b`, `x*`) covers no cells. Skipping it
            // keeps "3 of 12" counting things a user can see.
            if m.start() == m.end() {
                continue;
            }
            if let Some((col, len)) = row.span(char_of(m.start()), char_of(m.end())) {
                out.push(SearchHit { line: row.line, col, len });
            }
        }
    }
    Ok(out)
}

fn fold(c: char, case_sensitive: bool) -> char {
    if case_sensitive {
        c
    } else {
        c.to_lowercase().next().unwrap_or(c)
    }
}

/// Whether `[start, end)` of `hay` is a whole word — a word character on
/// either side disqualifies it.
fn bounded(hay: &[char], start: usize, end: usize) -> bool {
    let before = start.checked_sub(1).and_then(|i| hay.get(i));
    let after = hay.get(end);
    !before.is_some_and(|c| is_word(*c)) && !after.is_some_and(|c| is_word(*c))
}

fn is_word(c: char) -> bool {
    c.is_alphanumeric() || c == '_'
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A row whose characters are one column each, which is every row that
    /// holds no wide glyphs.
    fn row(line: i32, text: &str) -> RowText {
        let cols: Vec<u16> = (0..text.chars().count() as u16).collect();
        RowText {
            line,
            text: text.to_string(),
            cols,
            end_col: text.chars().count() as u16,
        }
    }

    #[test]
    fn empty_query_matches_nothing() {
        let rows = [row(0, "cargo build")];
        assert!(scan(&rows, "", SearchOpts::default()).unwrap().is_empty());
    }

    #[test]
    fn literal_is_case_insensitive_by_default() {
        let rows = [row(0, "Cargo Build")];
        let hits = scan(&rows, "cargo", SearchOpts::default()).unwrap();
        assert_eq!(hits, vec![SearchHit { line: 0, col: 0, len: 5 }]);
    }

    #[test]
    fn case_sensitive_rejects_the_other_casing() {
        let opts = SearchOpts { case_sensitive: true, ..SearchOpts::default() };
        let rows = [row(0, "Cargo")];
        assert!(scan(&rows, "cargo", opts).unwrap().is_empty());
    }

    #[test]
    fn hits_come_back_in_reading_order_across_rows() {
        let rows = [row(-2, "error here"), row(0, "and error there")];
        let hits = scan(&rows, "error", SearchOpts::default()).unwrap();
        assert_eq!(hits.len(), 2);
        assert_eq!(hits[0].line, -2);
        assert_eq!(hits[1].line, 0);
        assert_eq!(hits[1].col, 4);
    }

    #[test]
    fn repeated_matches_on_one_row_do_not_overlap() {
        let rows = [row(0, "aaaa")];
        let hits = scan(&rows, "aa", SearchOpts::default()).unwrap();
        assert_eq!(hits.len(), 2);
        assert_eq!(hits[0].col, 0);
        assert_eq!(hits[1].col, 2);
    }

    #[test]
    fn whole_word_rejects_a_substring_hit() {
        let opts = SearchOpts { whole_word: true, ..SearchOpts::default() };
        let rows = [row(0, "retry retried")];
        let hits = scan(&rows, "retry", opts).unwrap();
        assert_eq!(hits, vec![SearchHit { line: 0, col: 0, len: 5 }]);
    }

    #[test]
    fn regex_spans_are_column_spans() {
        let opts = SearchOpts { regex: true, ..SearchOpts::default() };
        let rows = [row(0, "exit code 137")];
        let hits = scan(&rows, "[0-9]+", opts).unwrap();
        assert_eq!(hits, vec![SearchHit { line: 0, col: 10, len: 3 }]);
    }

    #[test]
    fn a_bad_regex_is_an_error_not_an_empty_result() {
        let opts = SearchOpts { regex: true, ..SearchOpts::default() };
        let rows = [row(0, "anything")];
        assert!(scan(&rows, "(unclosed", opts).is_err());
    }

    #[test]
    fn zero_width_regex_matches_are_not_counted() {
        let opts = SearchOpts { regex: true, ..SearchOpts::default() };
        let rows = [row(0, "abc")];
        assert!(scan(&rows, "x*", opts).unwrap().is_empty());
    }

    /// The reason positions are columns and not string indices: a wide glyph
    /// is one character and two cells, so everything after it on the row sits
    /// a column further right than its index suggests.
    #[test]
    fn wide_glyphs_shift_the_columns_of_later_hits() {
        let r = RowText {
            line: 0,
            text: "字 ok".to_string(),
            // 字 occupies columns 0-1, the space is 2, "ok" is 3-4.
            cols: vec![0, 2, 3, 4],
            end_col: 5,
        };
        let hits = scan(&[r], "ok", SearchOpts::default()).unwrap();
        assert_eq!(hits, vec![SearchHit { line: 0, col: 3, len: 2 }]);
    }

    #[test]
    fn the_hit_to_land_on_is_the_first_at_or_after_the_viewport() {
        let hits = vec![
            SearchHit { line: -40, col: 0, len: 1 },
            SearchHit { line: -5, col: 0, len: 1 },
            SearchHit { line: 3, col: 0, len: 1 },
        ];
        assert_eq!(hit_at_or_after(&hits, -10), Some(1));
        assert_eq!(hit_at_or_after(&hits, 0), Some(2));
        // Everything is behind the viewport, so the search wraps.
        assert_eq!(hit_at_or_after(&hits, 99), Some(0));
        assert_eq!(hit_at_or_after(&[], 0), None);
    }
}
