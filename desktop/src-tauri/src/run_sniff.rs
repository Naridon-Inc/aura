//! "How do I run this project?" — read off the files, wherever they are.
//!
//! The sniffing that decides `bun run dev` versus `make dev` versus `cargo run`
//! is a pure reading of a handful of files at the repo root. It used to be
//! welded to `std::fs`, which was fine while every checkout was on this
//! laptop. A workspace can now stand in a machine, and the files that justify
//! its run command are over there — so the same reading has to work off a
//! bundle a box sent back as well as off a directory here.
//!
//! Hence [`Files`]: the two questions the sniffer asks (`exists`, `read`),
//! and nothing about where the answers come from. `cmd_run` implements it
//! over a directory; `place_work::run` over one scripted answer from a
//! machine. Both hand back the same [`RunSuggestion`], because there is one
//! [`detect`], and that is the point — a run button that reads a project
//! differently depending on where it is would be a bug with a good excuse.
//!
//! TWO RULES THIS MODULE KEEPS.
//!
//! *Never invent a command.* A repo with no dev script gets `command: None`,
//! not a hopeful `npm run dev`. Offering a command that fails on the first
//! keystroke is worse than offering nothing, because the failure looks like
//! the project's fault rather than the guess's.
//!
//! *Say where it came from.* Every candidate names the file that justifies it
//! (`package.json · dev`), so a wrong pick is legible instead of magic — the
//! user can see we read `Makefile` and chose `make dev`, and disagree.
//!
//! Scope is the repo root only. A monorepo's inner packages each have their
//! own scripts and picking between them is a guess we would have to hide; the
//! root is the one place whose answer we can defend.

use serde::Serialize;

/// One way to run this project, with the evidence for it.
#[derive(Serialize, Clone, Debug, PartialEq)]
pub struct RunCandidate {
    /// The shell command, ready to send to a PTY.
    pub command: String,
    /// Where it came from, for the UI to show under the command —
    /// e.g. `"package.json · dev"`, `"Makefile · dev"`, `"Cargo.toml"`.
    pub source: String,
}

#[derive(Serialize, Clone, Debug, PartialEq, Default)]
pub struct RunSuggestion {
    /// The best candidate's command, or `None` when the repo gave us
    /// nothing we can defend. `None` is a real answer — the UI asks the
    /// user rather than guessing.
    pub command: Option<String>,
    /// Every candidate we found, best first. The UI offers these as
    /// alternatives so a wrong top pick costs one click, not a retype.
    pub candidates: Vec<RunCandidate>,
}

/// The repo root, as the sniffer needs to see it. Paths are relative to the
/// root and slash-separated (`src/main.rs`), and every name asked for is one
/// of [`READ_FILES`] or [`PROBE_FILES`] — a source may pre-answer exactly
/// those and nothing else.
pub trait Files {
    /// Is there something at this path? A directory counts.
    fn exists(&self, name: &str) -> bool;
    /// The file's text, or `None` if it isn't there, isn't readable, or
    /// isn't text. Unreadable is the same answer as absent on purpose: a
    /// file we cannot read cannot justify a command.
    fn read(&self, name: &str) -> Option<String>;
}

/// The files whose CONTENT decides something. A remote source has to ship
/// these; a local one reads them on demand.
pub const READ_FILES: [&str; 4] = ["package.json", "Makefile", "makefile", "Cargo.toml"];

/// The files whose PRESENCE decides something. A remote source has to say
/// which of these exist; none of their bytes are wanted.
pub const PROBE_FILES: [&str; 12] = [
    "bun.lock",
    "bun.lockb",
    "pnpm-lock.yaml",
    "yarn.lock",
    "src/main.rs",
    "manage.py",
    "go.mod",
    "main.go",
    "compose.yaml",
    "compose.yml",
    "docker-compose.yml",
    "docker-compose.yaml",
];

/// Script names worth running, best first. `dev` beats `start` because a
/// `start` script in a JS project is as often "serve the built output" as it
/// is "run the thing I am editing".
const NPM_SCRIPT_PREFERENCE: [&str; 4] = ["dev", "start", "serve", "develop"];

/// Make targets worth running, best first. Same reasoning as above.
const MAKE_TARGET_PREFERENCE: [&str; 4] = ["dev", "run", "start", "serve"];

/// Pick the runnable script out of a `package.json`, best first.
///
/// Returns the script NAME so the caller can pair it with the right package
/// manager. A malformed `package.json` yields `None` rather than an error:
/// a file we cannot parse is a file that cannot justify a command.
pub fn npm_script_pick(pkg_json: &str) -> Option<String> {
    let parsed: serde_json::Value = serde_json::from_str(pkg_json).ok()?;
    let scripts = parsed.get("scripts")?.as_object()?;
    for name in NPM_SCRIPT_PREFERENCE {
        if scripts.get(name).and_then(|v| v.as_str()).is_some() {
            return Some(name.to_string());
        }
    }
    None
}

/// Pick the runnable target out of a Makefile, best first.
///
/// Targets are the `name:` at the head of a line. `.PHONY` and friends are
/// directives, not things to run, so anything starting with `.` is skipped;
/// so is a pattern rule (`%.o:`) and a variable assignment (`X := y`), which
/// both otherwise match the shape.
pub fn make_target_pick(makefile: &str) -> Option<String> {
    let mut targets: Vec<&str> = Vec::new();
    for line in makefile.lines() {
        if line.starts_with('\t') {
            continue; // a recipe line, not a target
        }
        let Some(colon) = line.find(':') else { continue };
        // `X := y` and `X ::= y` are assignments; a target's colon is not
        // followed by `=`, and the name before it carries no whitespace.
        if line[colon..].starts_with(":=") || line[colon + 1..].starts_with('=') {
            continue;
        }
        let name = line[..colon].trim();
        if name.is_empty() || name.starts_with('.') || name.contains('%') {
            continue;
        }
        if name.contains(char::is_whitespace) {
            continue;
        }
        targets.push(name);
    }
    for wanted in MAKE_TARGET_PREFERENCE {
        if targets.contains(&wanted) {
            return Some(wanted.to_string());
        }
    }
    None
}

/// The command prefix that runs a `package.json` script here, decided by
/// which lockfile the repo actually carries.
///
/// A lockfile is the only honest signal: it is what the project committed,
/// not what happens to be installed on this machine. With no lockfile we say
/// `npm run`, the one every Node install has.
fn npm_run_prefix(files: &impl Files) -> &'static str {
    if files.exists("bun.lock") || files.exists("bun.lockb") {
        return "bun run";
    }
    if files.exists("pnpm-lock.yaml") {
        return "pnpm run";
    }
    if files.exists("yarn.lock") {
        return "yarn";
    }
    "npm run"
}

/// Everything this repo tells us about how to run it, best first.
///
/// Ordering is deliberate. A `package.json` dev script and a `Makefile` dev
/// target can both exist; the script is the one a JS project's author edits
/// daily, so it leads. `docker compose` comes last on purpose — it is
/// usually the way to run the *system*, not the thing you just changed.
pub fn detect(files: &impl Files) -> RunSuggestion {
    let mut candidates: Vec<RunCandidate> = Vec::new();

    if let Some(pkg) = files.read("package.json") {
        if let Some(script) = npm_script_pick(&pkg) {
            candidates.push(RunCandidate {
                command: format!("{} {}", npm_run_prefix(files), script),
                source: format!("package.json · {script}"),
            });
        }
    }

    if let Some(makefile) = files.read("Makefile").or_else(|| files.read("makefile")) {
        if let Some(target) = make_target_pick(&makefile) {
            candidates.push(RunCandidate {
                command: format!("make {target}"),
                source: format!("Makefile · {target}"),
            });
        }
    }

    // A Cargo project is runnable only if something in it is a binary. A pure
    // library crate has no `cargo run`, and offering one would fail with
    // "a bin target must be available".
    if let Some(cargo) = files.read("Cargo.toml") {
        if files.exists("src/main.rs") || cargo.contains("[[bin]]") {
            candidates.push(RunCandidate {
                command: "cargo run".to_string(),
                source: "Cargo.toml".to_string(),
            });
        }
    }

    if files.exists("manage.py") {
        candidates.push(RunCandidate {
            command: "python manage.py runserver".to_string(),
            source: "manage.py".to_string(),
        });
    }

    if files.exists("go.mod") && files.exists("main.go") {
        candidates.push(RunCandidate {
            command: "go run .".to_string(),
            source: "go.mod".to_string(),
        });
    }

    for name in ["compose.yaml", "compose.yml", "docker-compose.yml", "docker-compose.yaml"] {
        if files.exists(name) {
            candidates.push(RunCandidate {
                command: "docker compose up".to_string(),
                source: name.to_string(),
            });
            break;
        }
    }

    let command = candidates.first().map(|c| c.command.clone());
    RunSuggestion { command, candidates }
}

/// A root known entirely in advance: which names exist, and the text of the
/// ones that were read. This is what a machine's one scripted answer parses
/// into, and what a test hands the sniffer without touching a disk.
#[derive(Debug, Default, Clone, PartialEq)]
pub struct Bag {
    pub present: Vec<String>,
    pub texts: Vec<(String, String)>,
}

impl Bag {
    pub fn with_text(mut self, name: &str, text: &str) -> Self {
        self.present.push(name.to_string());
        self.texts.push((name.to_string(), text.to_string()));
        self
    }

    pub fn with_present(mut self, name: &str) -> Self {
        self.present.push(name.to_string());
        self
    }
}

impl Files for Bag {
    fn exists(&self, name: &str) -> bool {
        self.present.iter().any(|p| p == name)
    }

    fn read(&self, name: &str) -> Option<String> {
        self.texts.iter().find(|(n, _)| n == name).map(|(_, t)| t.clone())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn picks_dev_over_start() {
        let pkg = r#"{"scripts":{"build":"x","start":"y","dev":"z"}}"#;
        assert_eq!(npm_script_pick(pkg), Some("dev".to_string()));
    }

    #[test]
    fn falls_through_the_preference_order() {
        assert_eq!(
            npm_script_pick(r#"{"scripts":{"serve":"x","start":"y"}}"#),
            Some("start".to_string())
        );
        assert_eq!(
            npm_script_pick(r#"{"scripts":{"serve":"x"}}"#),
            Some("serve".to_string())
        );
    }

    #[test]
    fn a_package_json_with_nothing_runnable_offers_nothing() {
        assert_eq!(npm_script_pick(r#"{"scripts":{"test":"vitest","lint":"eslint"}}"#), None);
        assert_eq!(npm_script_pick(r#"{"name":"x"}"#), None);
    }

    #[test]
    fn a_broken_package_json_is_not_a_command() {
        // Half-written JSON is the normal state of a file mid-edit. It must
        // read as "no answer", never as a crash and never as a guess.
        assert_eq!(npm_script_pick(r#"{"scripts":{"dev":"#), None);
        assert_eq!(npm_script_pick(""), None);
    }

    #[test]
    fn a_script_whose_value_is_not_a_string_is_not_a_script() {
        assert_eq!(npm_script_pick(r#"{"scripts":{"dev":{"nested":true}}}"#), None);
    }

    #[test]
    fn reads_make_targets_and_prefers_dev() {
        let mk = ".PHONY: dev test\n\nbuild:\n\tcargo build\n\ndev:\n\tcargo watch\n";
        assert_eq!(make_target_pick(mk), Some("dev".to_string()));
    }

    #[test]
    fn make_assignments_and_pattern_rules_are_not_targets() {
        // `CC := gcc` and `%.o: %.c` both have the shape of a target and are
        // not runnable. `.PHONY` is a directive. None may become a command.
        let mk = "CC := gcc\nCFLAGS = -O2\n%.o: %.c\n\t$(CC) -c $<\n.PHONY: run\n";
        assert_eq!(make_target_pick(mk), None);
    }

    #[test]
    fn make_recipe_lines_are_not_targets() {
        // A recipe line is tab-indented and routinely contains a colon
        // (`docker run a:b`). Reading one as a target would offer to run it.
        let mk = "build:\n\tdocker run img:tag\n";
        assert_eq!(make_target_pick(mk), None);
    }

    #[test]
    fn an_empty_root_offers_no_command() {
        // The whole point: nothing found is `None`, not a hopeful default.
        let out = detect(&Bag::default());
        assert_eq!(out.command, None);
        assert!(out.candidates.is_empty());
    }

    #[test]
    fn a_library_crate_is_not_runnable() {
        let bag = Bag::default().with_text("Cargo.toml", "[package]\nname = \"x\"\n");
        assert_eq!(detect(&bag).command, None);
        let bin = bag.clone().with_present("src/main.rs");
        assert_eq!(detect(&bin).command, Some("cargo run".to_string()));
    }

    #[test]
    fn the_lockfile_decides_the_package_manager() {
        let bag = Bag::default().with_text("package.json", r#"{"scripts":{"dev":"vite"}}"#);
        assert_eq!(detect(&bag).command, Some("npm run dev".to_string()));
        let bun = bag.clone().with_present("bun.lock");
        assert_eq!(detect(&bun).command, Some("bun run dev".to_string()));
        let pnpm = bag.with_present("pnpm-lock.yaml");
        assert_eq!(detect(&pnpm).command, Some("pnpm run dev".to_string()));
    }

    #[test]
    fn every_candidate_names_its_evidence() {
        let bag = Bag::default()
            .with_text("package.json", r#"{"scripts":{"dev":"vite"}}"#)
            .with_text("Makefile", "dev:\n\techo hi\n");
        let out = detect(&bag);
        assert_eq!(out.candidates.len(), 2);
        assert_eq!(out.candidates[0].source, "package.json · dev");
        assert_eq!(out.candidates[1].source, "Makefile · dev");
        assert!(out.candidates.iter().all(|c| !c.source.is_empty()));
    }

    #[test]
    fn compose_comes_last_and_only_once() {
        let bag = Bag::default()
            .with_present("go.mod")
            .with_present("main.go")
            .with_present("compose.yaml")
            .with_present("docker-compose.yml");
        let out = detect(&bag);
        let sources: Vec<&str> = out.candidates.iter().map(|c| c.source.as_str()).collect();
        assert_eq!(sources, vec!["go.mod", "compose.yaml"]);
    }

    #[test]
    fn every_name_the_sniffer_asks_for_is_declared() {
        // A source that pre-answers READ_FILES + PROBE_FILES must be enough
        // for every branch of `detect`. Make a bag holding all of them and a
        // recording source that panics on any name outside the lists.
        struct Strict(Bag);
        impl Files for Strict {
            fn exists(&self, name: &str) -> bool {
                assert!(
                    READ_FILES.contains(&name) || PROBE_FILES.contains(&name),
                    "detect asked for {name}, which no source is told to ship"
                );
                self.0.exists(name)
            }
            fn read(&self, name: &str) -> Option<String> {
                assert!(READ_FILES.contains(&name), "detect read {name}, which is not a READ_FILE");
                self.0.read(name)
            }
        }
        let mut bag = Bag::default();
        for n in READ_FILES {
            bag = bag.with_text(n, "");
        }
        for n in PROBE_FILES {
            bag = bag.with_present(n);
        }
        let _ = detect(&Strict(bag));
    }
}
