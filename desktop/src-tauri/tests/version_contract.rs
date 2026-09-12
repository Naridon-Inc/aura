//! One version, or the build fails.
//!
//! `RELEASE.toml` has been the single authority for every component's version
//! since AUDIT-REL-01, and `scripts/set-version.sh --verify` checks that the
//! six stamped files and the CHANGELOG head still agree with it. The gate was
//! real; nothing local ran it. It lives in `.github/workflows/version-drift.yml`,
//! and this account's GitHub Actions are disabled, so the one thing that would
//! have caught drift ran on no push for months while the tree sat at 0.19.29
//! and the CDN served 0.19.42.
//!
//! A gate nobody runs is a comment. This is the same check as a test, so it
//! runs wherever `cargo test` runs — which is every gate we actually have.
//!
//! It lives in `aura-shell` rather than beside the script because this crate
//! has the most to lose from drift: `cmd_doctor_cli::EXPECTED_AURA_CLI_VERSION`
//! is `env!("CARGO_PKG_VERSION")`, and it decides which `aura` binary every
//! passthrough in the desktop app spawns. A stale version here does not
//! produce a wrong number on a screen — it produces the app running a
//! different program than the one it was built against.

use std::path::{Path, PathBuf};

/// Walk up from this crate until `RELEASE.toml` turns up.
///
/// `None` means the crate is being built outside the repository — a vendored
/// or packaged source tree — where there is no authority to check against and
/// nothing to assert.
fn repo_root() -> Option<PathBuf> {
    let mut dir: &Path = Path::new(env!("CARGO_MANIFEST_DIR"));
    loop {
        if dir.join("RELEASE.toml").is_file() {
            return Some(dir.to_path_buf());
        }
        dir = dir.parent()?;
    }
}

/// The `version = "…"` under `[release]`.
///
/// Hand-parsed rather than pulled through a TOML dependency: the file is
/// eleven lines of comments and three keys, and a build-dependency added to
/// read it would be a larger change than the thing it reads.
fn declared_version(release_toml: &str) -> Option<String> {
    let mut in_release = false;
    for line in release_toml.lines() {
        let line = line.trim();
        if line.starts_with('#') {
            continue;
        }
        if line.starts_with('[') {
            in_release = line == "[release]";
            continue;
        }
        if !in_release {
            continue;
        }
        if let Some(rest) = line.strip_prefix("version") {
            let rest = rest.trim_start().strip_prefix('=')?.trim();
            return Some(rest.trim_matches('"').to_string());
        }
    }
    None
}

#[test]
fn this_crate_is_stamped_with_the_version_release_toml_declares() {
    let Some(root) = repo_root() else {
        return; // built outside the repo: no authority to check against
    };
    let raw = std::fs::read_to_string(root.join("RELEASE.toml"))
        .expect("RELEASE.toml is the authority and must be readable");
    let declared = declared_version(&raw).expect("RELEASE.toml must declare [release].version");

    assert_eq!(
        env!("CARGO_PKG_VERSION"),
        declared,
        "aura-shell/src-tauri/Cargo.toml says {} and RELEASE.toml says {}. \
         Run scripts/set-version.sh {} rather than editing either by hand — \
         this number is what the app expects its CLI to be, so a wrong one \
         here means the app runs a binary it was never tested against.",
        env!("CARGO_PKG_VERSION"),
        declared,
        declared,
    );
}

#[test]
fn release_toml_parses_the_shape_it_is_written_in() {
    // Guards the reader above, so a parse that silently returns None can
    // never turn the real assertion into a test that passes by doing nothing.
    let sample = "# a comment\n\
                  [release]\n\
                  version = \"1.2.3\"\n\
                  channel = \"stable\"\n";
    assert_eq!(declared_version(sample).as_deref(), Some("1.2.3"));
    // A version outside [release] is not the authority's version.
    let elsewhere = "[other]\nversion = \"9.9.9\"\n";
    assert_eq!(declared_version(elsewhere), None);
    assert_eq!(declared_version(""), None);
}

/// Every other stamped file, via the script that already knows the list.
///
/// Shelling out instead of re-listing the six files here is the point: a
/// second copy of that list is one more thing to drift, and the next file
/// added to the contract would be covered by the script and missed by us.
#[cfg(unix)]
#[test]
fn every_stamped_file_still_agrees_with_the_authority() {
    let Some(root) = repo_root() else {
        return;
    };
    let script = root.join("scripts").join("set-version.sh");
    assert!(
        script.is_file(),
        "scripts/set-version.sh is the version contract; it must exist alongside RELEASE.toml"
    );

    let out = std::process::Command::new("bash")
        .arg(&script)
        .arg("--verify")
        .current_dir(&root)
        .output()
        .expect("bash is available on every platform this test is compiled for");

    assert!(
        out.status.success(),
        "components disagree about what version this is:\n{}{}",
        String::from_utf8_lossy(&out.stdout),
        String::from_utf8_lossy(&out.stderr),
    );
}
