//! Registry parsing, launch resolution and the install path, against the
//! pinned snapshot and fake PATH lookups.

use aura_acp::registry::install::{self, ArchiveKind, InstallPlan};
use aura_acp::registry::{self, Availability, LaunchSource, Probe, Registry};
use std::path::{Path, PathBuf};

fn none(_: &str) -> Option<PathBuf> {
    None
}

#[test]
fn pinned_snapshot_knows_the_agents_aura_wires() {
    let r = Registry::pinned();
    for aura in ["claude", "codex", "gemini", "opencode", "goose", "cursor", "kimi"] {
        let ids = registry::registry_ids_for(aura);
        assert!(ids.iter().any(|id| r.get(id).is_some()), "{aura} missing from the registry snapshot");
    }
    let gemini = r.get("gemini").unwrap();
    assert!(gemini.distribution.npx.as_ref().unwrap().args.contains(&"--acp".to_string()));
    assert_eq!(registry::aura_id_for("claude-acp"), "claude");
    assert_eq!(registry::aura_id_for("kimi"), "kimi");
    assert_eq!(registry::aura_id_for("goose"), "goose");
}

#[test]
fn live_entries_override_and_unknown_ones_survive() {
    let mut live = Registry::pinned();
    live.agents.retain(|a| a.id == "gemini");
    live.agents[0].version = "99.0.0".into();
    let merged = Registry::merged(Some(live));
    assert_eq!(merged.get("gemini").unwrap().version, "99.0.0");
    assert!(merged.get("opencode").is_some(), "pinned agents absent from a live copy stay");
    assert!(Registry::parse(r#"{"version":"2.0.0","agents":[]}"#).is_err());
}

#[test]
fn package_names_drop_versions() {
    assert_eq!(registry::package_name("@google/gemini-cli@0.67.0"), "@google/gemini-cli");
    assert_eq!(registry::package_name("fast-agent-acp==0.10.1"), "fast-agent-acp");
    assert_eq!(registry::package_name("plain"), "plain");
}

#[test]
fn a_cli_on_path_resolves_with_the_registry_acp_args() {
    let home = tempfile::tempdir().unwrap();
    let r = Registry::pinned();
    let which = |n: &str| (n == "gemini").then(|| PathBuf::from("/opt/bin/gemini"));
    let probe = Probe { home: home.path(), which: &which };
    match registry::resolve(r.get("gemini").unwrap(), &probe) {
        Availability::Ready { launch } => {
            assert_eq!(launch.source, LaunchSource::Path);
            assert_eq!(launch.program, Path::new("/opt/bin/gemini"));
            assert!(launch.args.contains(&"--acp".to_string()));
        }
        other => panic!("expected ready, got {other:?}"),
    }
}

#[test]
fn missing_agents_come_back_installable() {
    let home = tempfile::tempdir().unwrap();
    let r = Registry::pinned();
    let with_npm = |n: &str| (n == "npm").then(|| PathBuf::from("/usr/bin/npm"));
    let probe = Probe { home: home.path(), which: &with_npm };
    match registry::resolve(r.get("codex-acp").unwrap(), &probe) {
        Availability::Installable { plan: InstallPlan::Npm { package, dir, .. } } => {
            assert!(package.starts_with("@agentclientprotocol/codex-acp@"));
            assert!(dir.starts_with(home.path().join(".aura/acp/agents/codex-acp")));
        }
        other => panic!("expected an npm plan, got {other:?}"),
    }
    let probe = Probe { home: home.path(), which: &none };
    if let Availability::Installable { plan } = registry::resolve(r.get("claude-acp").unwrap(), &probe) {
        if let InstallPlan::Binary { sha256, .. } = &plan {
            assert!(sha256.is_some(), "checksummed binaries are preferred");
        }
    }
}

#[test]
fn checksums_are_enforced() {
    let body = b"agent";
    let wrong = "f5d5a8a9e1d4a89f6b2a8d0b1d4b0b4e4e2f6a4e0f6c3a7cba8f6f2d8f0f2b1a";
    assert!(install::verify_sha256(body, wrong).is_err());
    let real = {
        use sha2::Digest;
        hex::encode(sha2::Sha256::digest(body))
    };
    assert!(install::verify_sha256(body, &real.to_uppercase()).is_ok());
}

#[test]
fn archive_kinds_come_from_the_url() {
    assert_eq!(ArchiveKind::from_url("https://x/a.tar.gz?sig=1"), Some(ArchiveKind::TarGz));
    assert_eq!(ArchiveKind::from_url("https://x/a.zip"), Some(ArchiveKind::Zip));
    assert_eq!(ArchiveKind::from_url("https://x/a.tar.bz2"), Some(ArchiveKind::TarBz2));
    assert_eq!(ArchiveKind::from_url("https://x/a.exe"), None);
}

fn tarball(dir: &Path) -> Vec<u8> {
    let src = dir.join("src");
    std::fs::create_dir_all(src.join("bin")).unwrap();
    std::fs::write(src.join("bin/fake-agent"), "#!/bin/sh\necho hi\n").unwrap();
    let out = dir.join("a.tar.gz");
    let ok = std::process::Command::new("tar").arg("-czf").arg(&out).arg("-C").arg(&src).arg("bin").status().unwrap();
    assert!(ok.success());
    std::fs::read(out).unwrap()
}

fn binary_plan(home: &Path, sha: Option<String>, cmd: &str) -> InstallPlan {
    InstallPlan::Binary {
        registry_id: "fake".into(),
        name: "Fake".into(),
        version: "1.2.3".into(),
        url: "https://example.invalid/fake.tar.gz".into(),
        archive: ArchiveKind::TarGz,
        cmd: cmd.into(),
        args: vec!["acp".into()],
        sha256: sha,
        dir: install::install_dir(home, "fake", "1.2.3"),
    }
}

#[test]
fn binary_install_verifies_unpacks_and_registers() {
    let home = tempfile::tempdir().unwrap();
    let work = tempfile::tempdir().unwrap();
    let bytes = tarball(work.path());
    let sum = {
        use sha2::Digest;
        hex::encode(sha2::Sha256::digest(&bytes))
    };

    let bad = binary_plan(home.path(), Some("00".repeat(32)), "./bin/fake-agent");
    assert!(install::install_binary(&bad, home.path(), &bytes, false).unwrap_err().contains("checksum"));

    let unsigned = binary_plan(home.path(), None, "./bin/fake-agent");
    assert!(unsigned.unverified());
    assert!(install::install_binary(&unsigned, home.path(), &bytes, false).is_err());

    let escape = binary_plan(home.path(), Some(sum.clone()), "../../etc/passwd");
    assert!(install::install_binary(&escape, home.path(), &bytes, false).is_err());

    let plan = binary_plan(home.path(), Some(sum), "./bin/fake-agent");
    let program = install::install_binary(&plan, home.path(), &bytes, false).unwrap();
    assert!(program.is_file());
    let (version, found, args) = install::installed(home.path(), "fake", "9.9.9").expect("found by newest version");
    assert_eq!(version, "1.2.3");
    assert_eq!(found, program);
    assert_eq!(args, vec!["acp".to_string()]);
    assert!(!home.path().join(".aura/acp/agents/.staging").read_dir().map(|mut d| d.next().is_some()).unwrap_or(false));
}

#[test]
fn npm_bin_names_come_from_package_json() {
    let one: serde_json::Value = serde_json::json!({"bin": {"codex-acp": "dist/index.js"}});
    assert_eq!(install::npm_bin_name(&one, "@agentclientprotocol/codex-acp").as_deref(), Some("codex-acp"));
    let string: serde_json::Value = serde_json::json!({"bin": "cli.js"});
    assert_eq!(install::npm_bin_name(&string, "@scope/tool").as_deref(), Some("tool"));
    let many: serde_json::Value = serde_json::json!({"bin": {"gemini": "a", "gemini-dev": "b"}});
    assert_eq!(install::npm_bin_name(&many, "@google/gemini-cli").as_deref(), Some("gemini"));
}

#[test]
fn npm_installs_into_the_agent_dir_only() {
    let home = tempfile::tempdir().unwrap();
    let plan = InstallPlan::Npm {
        registry_id: "codex-acp".into(),
        name: "Codex".into(),
        version: "2.6.0".into(),
        package: "@agentclientprotocol/codex-acp@2.6.0".into(),
        args: vec![],
        npm: "/usr/bin/npm".into(),
        dir: install::install_dir(home.path(), "codex-acp", "2.6.0"),
    };
    let cmd = install::npm_install_command(&plan).unwrap();
    let args: Vec<String> = cmd.get_args().map(|a| a.to_string_lossy().into_owned()).collect();
    let prefix = args.iter().position(|a| a == "--prefix").unwrap();
    assert_eq!(PathBuf::from(&args[prefix + 1]), install::install_dir(home.path(), "codex-acp", "2.6.0"));
    assert!(!args.iter().any(|a| a == "-g" || a == "--global"));

    // Simulate npm's result, then finish.
    let dir = plan.dir().to_path_buf();
    std::fs::create_dir_all(dir.join("node_modules/@agentclientprotocol/codex-acp")).unwrap();
    std::fs::write(
        dir.join("node_modules/@agentclientprotocol/codex-acp/package.json"),
        r#"{"bin":{"codex-acp":"bin/x.js"}}"#,
    )
    .unwrap();
    std::fs::create_dir_all(dir.join("node_modules/.bin")).unwrap();
    std::fs::write(install::npm_bin_path(&dir, "codex-acp"), "#!/bin/sh\n").unwrap();
    let program = install::finish_npm(&plan).unwrap();
    assert_eq!(program, install::npm_bin_path(&dir, "codex-acp"));
    assert!(install::installed(home.path(), "codex-acp", "2.6.0").is_some());
}
