//! One run's egress, in sentences.
//!
//! [`journal`](crate::journal) records refusals and [`policy`](crate::policy)
//! holds the list; neither is a thing to show somebody. This is: what the agent
//! phase was allowed to reach and on whose say-so, what it asked for and did not
//! get, and — the sentence that matters — whether that is a line somebody
//! forgot to declare or the first anybody has seen of a prompt injection trying
//! to leave.
//!
//! The report deliberately never says which of those two it is. It cannot know,
//! and a guess printed in confident words is worse than the facts: `npm.example`
//! wanted once during an install is an afternoon's fix, and the same shape of
//! row pointing at a host nobody recognises is an incident. Both are shown the
//! same way, and the person reading knows which project they are on.

use serde::{Deserialize, Serialize};

use crate::journal::{tally, Attempt, Refusal};
use crate::policy::{Allowed, Egress};

/// What the agent phase of one run could reach, and what it wanted.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Report {
    /// The run this is about — the same name the guard script is filed under.
    pub run: String,
    /// The list, with each entry's reason for being on it.
    pub allowed: Vec<Allowed>,
    /// One row per machine it was refused, most-wanted first.
    pub refused: Vec<Attempt>,
}

impl Report {
    /// Build one from the list this run was given and the journal it left.
    ///
    /// `journal` is the file's whole text, and it is allowed to be empty, absent
    /// or half-written — a run that reached nothing it was not supposed to
    /// leaves nothing behind, and that is the ordinary outcome rather than an
    /// error to handle.
    pub fn read(run: impl Into<String>, egress: &Egress, journal: &str) -> Report {
        Report {
            run: run.into(),
            allowed: egress.entries().to_vec(),
            refused: tally(&Refusal::read(journal)),
        }
    }

    /// True when nothing was refused: the agent asked for what it was given and
    /// nothing else.
    pub fn clean(&self) -> bool {
        self.refused.is_empty()
    }

    /// How many times the wall was reached for, across every host.
    pub fn tries(&self) -> u32 {
        self.refused.iter().map(|a| a.tries).sum()
    }

    /// The one line at the top.
    pub fn headline(&self) -> String {
        match (self.refused.len(), self.allowed.len()) {
            (0, 0) => "The agent phase reached nothing, and was allowed nothing.".to_string(),
            (0, n) => format!(
                "The agent phase stayed inside its allowlist ({n} machine{}).",
                plural(n)
            ),
            (1, _) => format!(
                "The allowlist stopped this run reaching {}.",
                self.refused[0].host
            ),
            (n, _) => format!("The allowlist stopped this run reaching {n} machines."),
        }
    }

    /// Every refusal as its own sentence, most-wanted first.
    pub fn refusals(&self) -> Vec<String> {
        self.refused.iter().map(Attempt::plainly).collect()
    }

    /// Every permission as its own sentence, with why it was granted.
    ///
    /// Shown next to the refusals on purpose: the useful question in front of a
    /// blocked host is "compared to what", and a list of what *was* allowed is
    /// the fastest way to see that the run had its model and its remote and
    /// wanted a third thing anyway.
    pub fn permissions(&self) -> Vec<String> {
        self.allowed
            .iter()
            .map(|a| format!("{} — {}", a.endpoint, a.reason.plainly()))
            .collect()
    }

    /// The whole thing as text, for a terminal or a log.
    pub fn plainly(&self) -> String {
        let mut out = self.headline();
        if !self.refused.is_empty() {
            out.push_str("\n\nIt wanted:");
            for line in self.refusals() {
                out.push_str("\n  · ");
                out.push_str(&line);
            }
            out.push_str(
                "\n\nIf the work genuinely needs one of those, add it to `[env.network]` in \
                 .aura/settings.toml and sign the spec again. If you did not expect it, something \
                 in the run's context asked for it — that is what the list is for.",
            );
        }
        if !self.allowed.is_empty() {
            out.push_str("\n\nIt was allowed:");
            for line in self.permissions() {
                out.push_str("\n  · ");
                out.push_str(&line);
            }
        }
        out
    }
}

fn plural(n: usize) -> &'static str {
    if n == 1 {
        ""
    } else {
        "s"
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::journal::Via;
    use crate::policy::floor;

    fn journal(rows: &[(&str, u16)]) -> String {
        rows.iter()
            .enumerate()
            .map(|(i, (host, port))| {
                serde_json::to_string(&Refusal {
                    at: 100 + i as u64,
                    host: (*host).to_string(),
                    port: *port,
                    via: Via::Connect,
                })
                .expect("a row")
            })
            .collect::<Vec<_>>()
            .join("\n")
    }

    #[test]
    fn a_run_that_stayed_inside_its_list_says_so_and_nothing_more() {
        let egress = Egress::plan(&[], floor("claude", None)).expect("a plan");
        let report = Report::read("run-1", &egress, "");
        assert!(report.clean());
        assert_eq!(report.tries(), 0);
        assert_eq!(
            report.headline(),
            "The agent phase stayed inside its allowlist (2 machines)."
        );
        // No advice, no scolding: nothing happened.
        assert!(!report.plainly().contains("It wanted"), "{}", report.plainly());
    }

    #[test]
    fn a_refusal_names_the_machine_and_says_what_would_change_it() {
        let egress = Egress::plan(&["api.anthropic.com".into()], vec![]).expect("a plan");
        let report = Report::read(
            "run-2",
            &egress,
            &journal(&[("evil.example.com", 443), ("evil.example.com", 443)]),
        );
        assert!(!report.clean());
        assert_eq!(report.tries(), 2);
        assert_eq!(
            report.headline(),
            "The allowlist stopped this run reaching evil.example.com."
        );
        let text = report.plainly();
        assert!(text.contains("wanted evil.example.com:443 2 times"), "{text}");
        assert!(text.contains("[env.network]"), "{text}");
        // …against what it did have, which is how a person judges the row.
        assert!(text.contains("api.anthropic.com:443 — this project asked for it"), "{text}");
    }

    #[test]
    fn several_machines_are_counted_rather_than_listed_in_the_headline() {
        let report = Report::read(
            "run-3",
            &Egress::default(),
            &journal(&[("a.example", 443), ("b.example", 443), ("c.example", 80)]),
        );
        assert_eq!(
            report.headline(),
            "The allowlist stopped this run reaching 3 machines."
        );
        // …and every one of them is still named underneath.
        assert_eq!(report.refusals().len(), 3);
    }

    #[test]
    fn a_journal_cut_in_half_still_produces_a_report() {
        // The broker is killed when the agent exits, so the last line may be a
        // fragment. The report is read after that, and must not be empty
        // because of it.
        let text = format!("{}\n{{\"at\":9,\"host\":\"cu", journal(&[("a.example", 443)]));
        let report = Report::read("run-4", &Egress::default(), &text);
        assert_eq!(report.refusals(), vec!["wanted a.example:443 once"]);
    }

    #[test]
    fn a_report_survives_the_trip_to_a_surface_that_shows_it() {
        let egress = Egress::plan(&["github.com".into()], floor("claude", None)).expect("a plan");
        let report = Report::read("run-5", &egress, &journal(&[("evil.example", 443)]));
        let wire = serde_json::to_string(&report).expect("json");
        let back: Report = serde_json::from_str(&wire).expect("a report");
        assert_eq!(back, report);
    }

    #[test]
    fn a_run_allowed_nothing_and_refused_nothing_says_the_true_thing() {
        // An agent nobody has a floor row for, on a project that declared no
        // list, that never tried to leave. Rare, and not an error.
        let report = Report::read("run-6", &Egress::default(), "");
        assert_eq!(
            report.headline(),
            "The agent phase reached nothing, and was allowed nothing."
        );
    }
}
