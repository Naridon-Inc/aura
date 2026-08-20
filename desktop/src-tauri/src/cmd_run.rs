//! "How do I run this project?" — asked once, of the repo itself.
//!
//! Every checkout already answers this somewhere: a `dev` script in
//! `package.json`, a `dev:` target in a Makefile, a `manage.py`, a
//! `Cargo.toml`. The person who opens the project knows it; the app never
//! asked, so starting the thing you are building meant remembering the
//! incantation and typing it into a terminal you opened by hand.
//!
//! This reads those files — all of them, in one hop, off the UI thread — and
//! returns every candidate it can justify, ranked, each carrying the file it
//! came from. The caller shows the top one and lets the user pick another.
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

use std::fs;
use std::path::{Path, PathBuf};

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

#[derive(Serialize, Clone, Debug, PartialEq)]
pub struct RunSuggestion {
    /// The best candidate's command, or `None` when the repo gave us
    /// nothing we can defend. `None` is a real answer — the UI asks the
    /// user rather than guessing.
    pub command: Option<String>,
    /// Every candidate we found, best first. The UI offers these as
    /// alternatives so a wrong top pick costs one click, not a retype.
    pub candidates: Vec<RunCandidate>,
}

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
fn npm_script_pick(pkg_json: &str) -> Option<String> {
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
fn make_target_pick(makefile: &str) -> Option<String> {
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
fn npm_run_prefix(dir: &Path) -> &'static str {
    if dir.join("bun.lock").exists() || dir.join("bun.lockb").exists() {
        return "bun run";
    }
    if dir.join("pnpm-lock.yaml").exists() {
        return "pnpm run";
    }
    if dir.join("yarn.lock").exists() {
        return "yarn";
    }
    "npm run"
}

/// Read a file, or `None` if it isn't there / isn't readable / isn't text.
fn read(dir: &Path, name: &str) -> Option<String> {
    fs::read_to_string(dir.join(name)).ok()
}

/// Everything this repo tells us about how to run it, best first.
///
/// Ordering is deliberate. A `package.json` dev script and a `Makefile` dev
/// target can both exist; the script is the one a JS project's author edits
/// daily, so it leads. `docker compose` comes last on purpose — it is
/// usually the way to run the *system*, not the thing you just changed.
fn detect_in(dir: &Path) -> RunSuggestion {
    let mut candidates: Vec<RunCandidate> = Vec::new();

    if let Some(pkg) = read(dir, "package.json") {
        if let Some(script) = npm_script_pick(&pkg) {
            candidates.push(RunCandidate {
                command: format!("{} {}", npm_run_prefix(dir), script),
                source: format!("package.json · {script}"),
            });
        }
    }

    if let Some(makefile) = read(dir, "Makefile").or_else(|| read(dir, "makefile")) {
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
    if let Some(cargo) = read(dir, "Cargo.toml") {
        if dir.join("src/main.rs").exists() || cargo.contains("[[bin]]") {
            candidates.push(RunCandidate {
                command: "cargo run".to_string(),
                source: "Cargo.toml".to_string(),
            });
        }
    }

    if dir.join("manage.py").exists() {
        candidates.push(RunCandidate {
            command: "python manage.py runserver".to_string(),
            source: "manage.py".to_string(),
        });
    }

    if dir.join("go.mod").exists() && dir.join("main.go").exists() {
        candidates.push(RunCandidate {
            command: "go run .".to_string(),
            source: "go.mod".to_string(),
        });
    }

    for name in ["compose.yaml", "compose.yml", "docker-compose.yml", "docker-compose.yaml"] {
        if dir.join(name).exists() {
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

/// What this repo says about running itself. Never errors — a repo we cannot
/// read is a repo with no candidates, which the UI already has to handle.
#[tauri::command]
pub async fn run_detect(repo_root: String) -> RunSuggestion {
    crate::blocking::run(move || detect_in(&PathBuf::from(&repo_root))).await
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
    fn empty_repo_offers_no_command() {
        // The whole point: nothing found is `None`, not a hopeful default.
        let dir = std::env::temp_dir().join("aura-run-detect-empty");
        let _ = fs::create_dir_all(&dir);
        let out = detect_in(&dir);
        assert_eq!(out.command, None);
        assert!(out.candidates.is_empty());
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn a_library_crate_is_not_runnable() {
        let dir = std::env::temp_dir().join("aura-run-detect-lib");
        let _ = fs::remove_dir_all(&dir);
        let _ = fs::create_dir_all(dir.join("src"));
        let _ = fs::write(dir.join("Cargo.toml"), "[package]\nname = \"x\"\n");
        let _ = fs::write(dir.join("src/lib.rs"), "");
        assert_eq!(detect_in(&dir).command, None);
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn the_lockfile_decides_the_package_manager() {
        let dir = std::env::temp_dir().join("aura-run-detect-pm");
        let _ = fs::remove_dir_all(&dir);
        let _ = fs::create_dir_all(&dir);
        let _ = fs::write(dir.join("package.json"), r#"{"scripts":{"dev":"vite"}}"#);
        assert_eq!(detect_in(&dir).command, Some("npm run dev".to_string()));
        let _ = fs::write(dir.join("bun.lock"), "");
        assert_eq!(detect_in(&dir).command, Some("bun run dev".to_string()));
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn every_candidate_names_its_evidence() {
        let dir = std::env::temp_dir().join("aura-run-detect-evidence");
        let _ = fs::remove_dir_all(&dir);
        let _ = fs::create_dir_all(&dir);
        let _ = fs::write(dir.join("package.json"), r#"{"scripts":{"dev":"vite"}}"#);
        let _ = fs::write(dir.join("Makefile"), "dev:\n\techo hi\n");
        let out = detect_in(&dir);
        assert_eq!(out.candidates.len(), 2);
        assert_eq!(out.candidates[0].source, "package.json · dev");
        assert_eq!(out.candidates[1].source, "Makefile · dev");
        assert!(out.candidates.iter().all(|c| !c.source.is_empty()));
        let _ = fs::remove_dir_all(&dir);
    }
}
