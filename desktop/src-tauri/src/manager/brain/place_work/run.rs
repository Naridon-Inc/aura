//! "How do I run this project?" — asked of the checkout on a machine.
//!
//! Twin of `cmd_run::run_detect`, answering in the same shape. The reading is
//! [`crate::run_sniff::detect`] either way; what differs is where the files
//! come from. Here they come back in ONE scripted answer — the names that
//! exist, then the text of each file the sniffer reads — so a Run button on a
//! remote workspace costs one round trip, not one per file it might look at.
//!
//! Never errors, like the local arm: a box that can't be reached is a project
//! with no candidates, which the UI already handles by asking.

use crate::cloudbox::script::quote;
use crate::run_sniff::{detect, Bag, RunSuggestion, PROBE_FILES, READ_FILES};

use super::{Place, Work, FENCE};

/// One script that says which of the sniffer's files exist and what the
/// readable ones hold.
///
/// Layout of the answer, top to bottom:
///   * one name per line, for every file in [`PROBE_FILES`] + [`READ_FILES`]
///     that exists;
///   * then, per readable file that exists: a fence line, the name on its own
///     line, and the file's text.
///
/// The fence is the module's record separator, so a file whose text does not
/// end in a newline is still cut cleanly from the next record — the split is
/// on `FENCE + "\n"`, which the script prints as one unit and no text
/// contains. Each file is capped at 1 MiB: the sniffer looks at `scripts` and
/// targets, and a `package.json` bigger than that is not a project root.
fn snapshot_script() -> String {
    let probe: Vec<String> = PROBE_FILES.iter().chain(READ_FILES.iter()).map(|n| quote(n)).collect();
    let read: Vec<String> = READ_FILES.iter().map(|n| quote(n)).collect();
    format!(
        "for f in {}; do [ -e \"$f\" ] && printf '%s\\n' \"$f\"; done; \
         for f in {}; do if [ -f \"$f\" ]; then printf '\\036\\n%s\\n' \"$f\"; head -c 1048576 -- \"$f\"; fi; done; \
         exit 0",
        probe.join(" "),
        read.join(" ")
    )
}

/// Read the script's answer back into a [`Bag`] the sniffer can be handed.
fn parse_snapshot(stdout: &str) -> Bag {
    let cut = format!("{FENCE}\n");
    let mut records = stdout.split(cut.as_str());
    let mut bag = Bag::default();
    for name in records.next().unwrap_or("").lines() {
        let name = name.trim_end_matches('\r');
        if !name.is_empty() {
            bag = bag.with_present(name);
        }
    }
    for record in records {
        let (name, text) = record.split_once('\n').unwrap_or((record, ""));
        let name = name.trim_end_matches('\r');
        if name.is_empty() {
            continue;
        }
        bag.texts.push((name.to_string(), text.to_string()));
        if !bag.present.iter().any(|p| p == name) {
            bag.present.push(name.to_string());
        }
    }
    bag
}

/// What the checkout at `root` on `machine_id` says about running itself.
/// `remote_root` is the worktree on the box a launched workspace lives in,
/// as every other `place_*` twin takes it; absent means the machine's own
/// checkout.
#[tauri::command]
pub async fn place_run_detect(
    machine_id: String,
    root: String,
    remote_root: Option<String>,
) -> RunSuggestion {
    let Ok(w) = Place::at_machine(&machine_id)
        .and_then(|p| Work::at_worktree(p, &root, remote_root.as_deref()))
    else {
        return RunSuggestion::default();
    };
    let Ok(out) = w.ask(&snapshot_script()).await else {
        return RunSuggestion::default();
    };
    detect(&parse_snapshot(&out.stdout))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_script_names_every_file_the_sniffer_may_ask_for() {
        let s = snapshot_script();
        for n in PROBE_FILES.iter().chain(READ_FILES.iter()) {
            assert!(s.contains(&quote(n)), "{n} is not probed");
        }
        for n in READ_FILES {
            // Read files are catted, and only they are.
            assert!(s.contains(&format!("for f in {}", READ_FILES.map(quote).join(" "))));
            assert!(s.contains(&quote(n)));
        }
        assert!(s.ends_with("exit 0"));
    }

    #[test]
    fn a_snapshot_reads_back_as_the_files_it_shipped() {
        let out = format!(
            "package.json\nbun.lock\nMakefile\n{FENCE}\npackage.json\n{{\"scripts\":{{\"dev\":\"vite\"}}}}{FENCE}\nMakefile\ndev:\n\techo hi\n"
        );
        let bag = parse_snapshot(&out);
        assert_eq!(
            bag,
            Bag::default()
                .with_present("package.json")
                .with_present("bun.lock")
                .with_present("Makefile")
                .with_text_only("package.json", r#"{"scripts":{"dev":"vite"}}"#)
                .with_text_only("Makefile", "dev:\n\techo hi\n")
        );
        let got = detect(&bag);
        assert_eq!(got.command, Some("bun run dev".to_string()));
        assert_eq!(got.candidates[1].command, "make dev");
    }

    #[test]
    fn an_empty_or_failed_answer_is_no_command() {
        assert_eq!(detect(&parse_snapshot("")).command, None);
        assert_eq!(detect(&parse_snapshot("\n\n")).command, None);
    }

    #[test]
    fn a_file_that_does_not_end_in_a_newline_still_ends_at_the_fence() {
        let out = format!("Cargo.toml\nsrc/main.rs\n{FENCE}\nCargo.toml\n[package]\nname = \"x\"");
        let bag = parse_snapshot(&out);
        assert_eq!(bag.read("Cargo.toml").as_deref(), Some("[package]\nname = \"x\""));
        assert_eq!(detect(&bag).command, Some("cargo run".to_string()));
    }

    impl Bag {
        /// Text for a name already listed as present — the shape the script
        /// produces, where the first block lists every name and the fenced
        /// records add text without re-listing.
        fn with_text_only(mut self, name: &str, text: &str) -> Self {
            self.texts.push((name.to_string(), text.to_string()));
            self
        }
    }

    use crate::run_sniff::Files;
}
