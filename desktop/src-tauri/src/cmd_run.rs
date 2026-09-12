//! "How do I run this project?" — asked once, of the checkout on this laptop.
//!
//! The reading itself lives in [`crate::run_sniff`], over an abstract root,
//! so the same answer comes back for a checkout on a machine (see
//! `place_work::run`). This file is the local arm: a directory on this disk,
//! read off the UI thread.

use std::fs;
use std::path::{Path, PathBuf};

use crate::run_sniff::{detect, Files, RunSuggestion};

/// A repo root on this laptop's disk.
struct Disk<'a>(&'a Path);

impl Files for Disk<'_> {
    fn exists(&self, name: &str) -> bool {
        self.0.join(name).exists()
    }

    fn read(&self, name: &str) -> Option<String> {
        fs::read_to_string(self.0.join(name)).ok()
    }
}

/// Everything the directory at `dir` says about running itself.
pub fn detect_in(dir: &Path) -> RunSuggestion {
    detect(&Disk(dir))
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
    fn an_empty_directory_offers_no_command() {
        let dir = std::env::temp_dir().join("aura-run-detect-empty");
        let _ = fs::create_dir_all(&dir);
        let out = detect_in(&dir);
        assert_eq!(out.command, None);
        assert!(out.candidates.is_empty());
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn the_disk_answers_the_same_as_a_bag_would() {
        // The local arm is a `Files` over a directory and nothing more: what
        // it reads off the disk must reach the sniffer exactly as a bag of
        // the same texts would.
        let dir = std::env::temp_dir().join("aura-run-detect-pm");
        let _ = fs::remove_dir_all(&dir);
        let _ = fs::create_dir_all(dir.join("src"));
        let _ = fs::write(dir.join("package.json"), r#"{"scripts":{"dev":"vite"}}"#);
        let _ = fs::write(dir.join("bun.lock"), "");
        let _ = fs::write(dir.join("Cargo.toml"), "[package]\nname = \"x\"\n");
        let _ = fs::write(dir.join("src/main.rs"), "fn main() {}");
        let from_disk = detect_in(&dir);
        let from_bag = detect(
            &crate::run_sniff::Bag::default()
                .with_text("package.json", r#"{"scripts":{"dev":"vite"}}"#)
                .with_present("bun.lock")
                .with_text("Cargo.toml", "[package]\nname = \"x\"\n")
                .with_present("src/main.rs"),
        );
        assert_eq!(from_disk, from_bag);
        assert_eq!(from_disk.command, Some("bun run dev".to_string()));
        let _ = fs::remove_dir_all(&dir);
    }
}
