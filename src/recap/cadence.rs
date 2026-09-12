//! The numbers a recap exists for.
//!
//! A commit count says how busy somebody was, which is the one thing nobody
//! needed a tool to find out. The questions actually being asked are *how
//! often does work come back* and *how long does it take to land* — cadence,
//! not volume.
//!
//! Kept as pure functions over a reduced shape so the arithmetic can be pinned
//! without a repository, a parser or a clock. Every number here is derived
//! from something on disk; where the source for a number does not exist, the
//! recap prints that it does not exist rather than printing a zero, because a
//! zero in a column headed "changes requested" reads as a perfect score.

/// One landed commit, reduced to what a cadence number needs.
#[derive(Debug, Clone, Default)]
pub struct Touch {
    /// When it landed.
    pub at: u64,
    /// Files it changed, repo-qualified so two repos cannot collide.
    pub files: Vec<String>,
    /// When the person asked for it, if the ask can be found.
    ///
    /// This is the timestamp of the prompt somebody typed, recovered from the
    /// agent's own transcript. Deliberately **not** the intent row: an agent
    /// logs its intent in the seconds before it commits, so a span measured
    /// from there reports the length of the ritual rather than the length of
    /// the work, and came out at "under a minute" on real history.
    ///
    /// A mis-matched session would put a wild span in the list. Nothing caps
    /// it, because the statistic taken over these is the median, which is
    /// already the answer to that — and an arbitrary cut-off would quietly
    /// discard the long pieces of work that are the most worth knowing about.
    pub started: Option<u64>,
}

/// How much of the window was spent returning to work already done.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct Rework {
    /// File-changes in the window, counting a file once per commit.
    pub touches: usize,
    /// Distinct files touched.
    pub files: usize,
    /// Files touched by more than one commit.
    pub returned: usize,
    /// Touches past the first on a file — the ones that are a return.
    pub extra: usize,
}

impl Rework {
    /// The share of touches that were returns, 0–1. `None` when nothing was
    /// touched, because 0/0 is not "no rework", it is no work.
    pub fn rate(&self) -> Option<f64> {
        if self.touches == 0 {
            return None;
        }
        Some(self.extra as f64 / self.touches as f64)
    }
}

/// Files touched more than once, and how much of the work that was.
///
/// Deliberately measured on **files**, not symbols. The symbol delta carries
/// bare names — a `new` in one module and a `new` in another are one string —
/// so a week of symbol names would report rework that never happened. A path
/// is unambiguous, and "you came back to this file" is the signal being asked
/// about anyway.
pub fn rework(touches: &[Touch]) -> Rework {
    let mut counts: std::collections::BTreeMap<&str, usize> = Default::default();
    for t in touches {
        // A file listed twice in one commit is still one touch: a commit is
        // the unit of coming back, not a line of the diff.
        let mut once: std::collections::BTreeSet<&str> = Default::default();
        for f in &t.files {
            once.insert(f.as_str());
        }
        for f in once {
            *counts.entry(f).or_insert(0) += 1;
        }
    }
    Rework {
        touches: counts.values().sum(),
        files: counts.len(),
        returned: counts.values().filter(|n| **n > 1).count(),
        extra: counts.values().map(|n| n.saturating_sub(1)).sum(),
    }
}

/// How long work took to go from being asked for to landing.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct Land {
    /// Commits an ask was matched to, so a span could be measured.
    pub counted: usize,
    /// Commits with no ask behind them. Named rather than dropped: a median
    /// over a third of the week is a different claim to a median over all of
    /// it, and the reader is entitled to know which they are looking at.
    pub uncounted: usize,
    /// Median span in seconds, over the counted commits.
    pub median: Option<u64>,
}

/// Median seconds from the ask to the commit landing.
pub fn land(touches: &[Touch]) -> Land {
    let mut spans: Vec<u64> = touches
        .iter()
        .filter_map(|t| t.started.map(|s| t.at.saturating_sub(s)))
        .collect();
    let uncounted = touches.len() - spans.len();
    if spans.is_empty() {
        return Land { counted: 0, uncounted, median: None };
    }
    spans.sort_unstable();
    Land { counted: spans.len(), uncounted, median: Some(median(&spans)) }
}

/// The middle of a sorted, non-empty list; the mean of the two middles when
/// the count is even, so an even split does not silently favour the slower
/// half the way picking the upper middle would.
fn median(sorted: &[u64]) -> u64 {
    let n = sorted.len();
    if n % 2 == 1 {
        return sorted[n / 2];
    }
    (sorted[n / 2 - 1] + sorted[n / 2]) / 2
}

#[cfg(test)]
mod tests {
    use super::*;

    fn touch(at: u64, files: &[&str]) -> Touch {
        Touch { at, files: files.iter().map(|f| f.to_string()).collect(), started: None }
    }

    fn started(at: u64, started: u64) -> Touch {
        Touch { at, files: vec!["a.rs".into()], started: Some(started) }
    }

    #[test]
    fn a_file_touched_once_is_not_rework() {
        let r = rework(&[touch(1, &["a.rs"]), touch(2, &["b.rs"])]);
        assert_eq!(r, Rework { touches: 2, files: 2, returned: 0, extra: 0 });
        assert_eq!(r.rate(), Some(0.0));
    }

    #[test]
    fn coming_back_to_a_file_is_counted_once_per_return() {
        // Three commits on one file is two returns, not three.
        let r = rework(&[touch(1, &["a.rs"]), touch(2, &["a.rs"]), touch(3, &["a.rs"])]);
        assert_eq!(r.returned, 1, "one file was returned to");
        assert_eq!(r.extra, 2, "twice");
        assert_eq!(r.rate(), Some(2.0 / 3.0));
    }

    #[test]
    fn a_file_listed_twice_in_one_commit_is_one_touch() {
        // Otherwise a commit that renames within a file reports rework
        // against itself, and every large commit looks like churn.
        let r = rework(&[touch(1, &["a.rs", "a.rs"])]);
        assert_eq!(r, Rework { touches: 1, files: 1, returned: 0, extra: 0 });
    }

    #[test]
    fn rework_over_nothing_has_no_rate() {
        // Not zero: 0/0 is "no work", and a 0% column reads as a clean week.
        assert_eq!(rework(&[]).rate(), None);
    }

    #[test]
    fn the_median_span_is_the_middle_one() {
        let l = land(&[started(100, 40), started(200, 100), started(300, 90)]);
        assert_eq!(l.counted, 3);
        assert_eq!(l.median, Some(100), "60, 100 and 210 → 100");
    }

    #[test]
    fn an_even_split_averages_the_two_middles() {
        let l = land(&[started(10, 0), started(30, 0), started(50, 0), started(90, 0)]);
        assert_eq!(l.median, Some(40), "10, 30, 50, 90 → (30+50)/2");
    }

    #[test]
    fn commits_with_no_ask_behind_them_are_named_not_dropped() {
        let l = land(&[started(100, 40), touch(200, &["a.rs"]), touch(300, &["b.rs"])]);
        assert_eq!(l.counted, 1);
        assert_eq!(l.uncounted, 2, "the reader has to know the median covers a third");
        assert_eq!(l.median, Some(60));
    }

    #[test]
    fn a_window_with_nothing_asked_for_has_no_median() {
        let l = land(&[touch(1, &["a.rs"])]);
        assert_eq!(l.median, None);
        assert_eq!(l.uncounted, 1);
    }
}
