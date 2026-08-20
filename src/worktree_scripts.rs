//! Running a project's declared environment on this machine.
//!
//! ## What this used to be, and what it is now
//!
//! This file was the whole of the worktree lifecycle: a hand-rolled reader for
//! `[worktree] setup/run/archive` and a `sh -c` that ran one of them. That
//! closed the immediate gap — a fresh `git worktree` has the source but no
//! `node_modules`, so an agent dropped into it fails a gate for a reason that
//! has nothing to do with its work — and left the larger one open, because a
//! setup command assumes a toolchain, assumes the tools it shells out to, and
//! cannot express a service that has to be *running* at all.
//!
//! The spec, the plan and the judgement now live in [`aura_env`], shared with
//! the desktop app so a box and a laptop converge through one implementation
//! rather than two that agree until the first fix. What stays here is the one
//! thing that is genuinely local: the ability to run a string in a directory
//! with [`std::process`].
//!
//! `[worktree] setup/run/archive` still mean exactly what they meant, and
//! [`load`] still hands back the same three optional strings, so every existing
//! caller is untouched. A project that declares nothing but those three gets a
//! plan of exactly one step, which is the behaviour it already had.
//!
//! ## Streaming versus capturing
//!
//! A check is asked; an install is watched. So checks and readiness probes are
//! always captured (their output is evidence for a report, not something a human
//! wants scrolling past), and an install streams to the terminal unless the
//! caller is `quiet` — under `--json`, where stray output would corrupt the
//! machine-readable stream, everything is captured. A streamed step therefore
//! reports no detail on failure, which is correct: the person watching already
//! read it.

use std::path::Path;
use std::process::{Command, Stdio};

pub use aura_env::{EnvReport, Lifecycle, Scope, TrustState};

/// The project's `[worktree]` scripts. Unchanged in meaning and in shape — the
/// spec grew around it, not over it.
pub fn load(repo_root: &Path) -> Lifecycle {
    aura_env::load(repo_root).lifecycle
}

/// The whole declared environment, for callers that want more than the scripts.
pub fn spec(repo_root: &Path) -> aura_env::EnvSpec {
    aura_env::load(repo_root)
}

/// Run one lifecycle phase command inside `dir`. Returns `true` if there was
/// nothing to run (a no-op is success, not a failure) or the command exited 0;
/// `false` only if a real command ran and failed. When `quiet` the child's
/// stdout/stderr are suppressed (used under `--json`, where stray output would
/// corrupt the machine-readable stream); otherwise they stream through so the
/// human watches the warm-up live. `env` pairs are exported into the command's
/// environment (e.g. `AURA_WORK_PORT`, the Conductor-`CONDUCTOR_PORT` analogue
/// that lets parallel worktrees run their dev servers on distinct ports).
pub fn run_phase(dir: &Path, cmd: Option<&str>, quiet: bool, env: &[(&str, &str)]) -> bool {
    let Some(cmd) = cmd else { return true };
    let cmd = cmd.trim();
    if cmd.is_empty() {
        return true;
    }
    let mut c = base(dir, cmd, env);
    if quiet {
        c.stdout(Stdio::null()).stderr(Stdio::null());
    }
    c.status().map(|s| s.success()).unwrap_or(false)
}

/// Bring this checkout to the environment its project declares.
///
/// Refuses a spec whose seal is stale or broken unless `force` — the commands
/// in it are about to run unattended, and an unreviewed edit to `[env]` is
/// exactly the shape that arrives in.
pub fn bring_to_spec(
    repo_root: &Path,
    dir: &Path,
    scope: Scope,
    quiet: bool,
    env: &[(&str, &str)],
    force: bool,
) -> Result<EnvReport, String> {
    let (spec, trust) = declared(repo_root)?;
    if !trust.may_apply() && !force {
        return Err(format!("refusing to apply — {}", trust.describe()));
    }
    let plan = aura_env::plan(&spec, scope).map_err(|e| e.to_string())?;
    Ok(pump(aura_env::Run::new(plan), dir, quiet, env, trust))
}

/// Measure how far this checkout is from spec, changing nothing.
pub fn observe(
    repo_root: &Path,
    dir: &Path,
    scope: Scope,
    env: &[(&str, &str)],
) -> Result<EnvReport, String> {
    let (spec, trust) = declared(repo_root)?;
    let plan = aura_env::plan(&spec, scope).map_err(|e| e.to_string())?;
    Ok(pump(aura_env::Run::observing(plan), dir, true, env, trust))
}

/// Take the declared services down, then run the project's own `[worktree]
/// archive`. Best-effort *once it knows what to take down*: a teardown that
/// stopped at the first failing command would leave the rest of the world
/// running, which is the opposite of what was asked — but a settings file it
/// cannot read is not a short list of services, it is no list at all, and
/// silently stopping nothing is the failure worth reporting.
pub fn teardown(
    repo_root: &Path,
    dir: &Path,
    quiet: bool,
    env: &[(&str, &str)],
) -> Result<usize, String> {
    let spec = aura_env::load_declared(repo_root).map_err(|e| e.to_string())?;
    Ok(aura_env::teardown(&spec)
        .iter()
        .filter(|(_, cmd)| run_phase(dir, Some(cmd), quiet, env))
        .count())
}

/// The spec this checkout declares and the verdict on its seal.
///
/// Strict about `[env]` and forgiving about a bare `[worktree]`, which is
/// [`aura_env::load_declared`]'s rule and the same one a box is held to — the
/// two arms must not disagree about what a project declares.
pub fn declared(repo_root: &Path) -> Result<(aura_env::EnvSpec, TrustState), String> {
    let spec = aura_env::load_declared(repo_root).map_err(|e| e.to_string())?;
    let trust = aura_env::trust(repo_root, &spec);
    Ok((spec, trust))
}

/// Turn the pump until the plan is done — the only thing this module adds to
/// [`aura_env`]: somewhere to run a string.
fn pump(
    mut run: aura_env::Run,
    dir: &Path,
    quiet: bool,
    env: &[(&str, &str)],
    trust: TrustState,
) -> EnvReport {
    while let Some(ask) = run.next() {
        if ask.delay_ms > 0 {
            std::thread::sleep(std::time::Duration::from_millis(ask.delay_ms));
        }
        // An install is the only thing worth watching; a check is evidence.
        let stream = !quiet && ask.phase == aura_env::Phase::Apply;
        let (code, detail) = if stream {
            let ok = run_phase(dir, Some(&ask.command), false, env);
            (if ok { 0 } else { 1 }, String::new())
        } else {
            capture(dir, &ask.command, env)
        };
        run.answer(code, &detail);
    }
    run.finish(trust)
}

/// Run a command and keep what it said. Failure to spawn is reported as the
/// step failing, in the shell's own words, rather than as an error that
/// abandons the rest of the plan.
fn capture(dir: &Path, cmd: &str, env: &[(&str, &str)]) -> (i32, String) {
    match base(dir, cmd, env).output() {
        Ok(o) => {
            let err = String::from_utf8_lossy(&o.stderr).trim().to_string();
            let out = String::from_utf8_lossy(&o.stdout).trim().to_string();
            (
                o.status.code().unwrap_or(-1),
                if err.is_empty() { out } else { err },
            )
        }
        Err(e) => (-1, format!("could not run it: {e}")),
    }
}

fn base(dir: &Path, cmd: &str, env: &[(&str, &str)]) -> Command {
    let mut c = Command::new("sh");
    c.arg("-c").arg(cmd).current_dir(dir);
    for (k, v) in env {
        c.env(k, v);
    }
    c
}

#[cfg(test)]
mod tests {
    use super::*;
    use aura_env::StepState;

    /// A scratch path nothing else is using.
    ///
    /// The pid matters: these tests really do create, install into and delete
    /// directories, and a fixed name under `$TMPDIR` is shared with every other
    /// `cargo test` running on the machine — including the same suite in a
    /// second worktree. One of them deletes the other's checkout mid-run and the
    /// failure looks like a bug in the code under test.
    fn tmp(tag: &str) -> std::path::PathBuf {
        std::env::temp_dir().join(format!("aura-wt-scripts-{tag}-{}", std::process::id()))
    }

    fn scratch(tag: &str, settings: &str) -> std::path::PathBuf {
        let dir = tmp(tag);
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(dir.join(".aura")).unwrap();
        std::fs::write(dir.join(".aura").join("settings.toml"), settings).unwrap();
        dir
    }

    #[test]
    fn run_phase_none_and_blank_are_noop_success() {
        let here = Path::new(".");
        assert!(run_phase(here, None, true, &[]));
        assert!(run_phase(here, Some("   "), true, &[]));
    }

    #[test]
    fn run_phase_runs_and_reports_status() {
        let here = Path::new(".");
        assert!(run_phase(here, Some("true"), true, &[]));
        assert!(!run_phase(here, Some("false"), true, &[]));
    }

    #[test]
    fn run_phase_exports_env() {
        let here = Path::new(".");
        // The command only succeeds if AURA_WORK_PORT reached the child.
        assert!(run_phase(
            here,
            Some("test \"$AURA_WORK_PORT\" = \"4321\""),
            true,
            &[("AURA_WORK_PORT", "4321")]
        ));
    }

    #[test]
    fn the_three_scripts_still_read_the_way_they_always_did() {
        let dir = scratch(
            "lifecycle",
            "[worktree]\nsetup = \"npm install\"\nrun = 'npm run dev'\narchive = \"docker compose down\"\n",
        );
        let life = load(&dir);
        assert_eq!(life.setup.as_deref(), Some("npm install"));
        assert_eq!(life.run.as_deref(), Some("npm run dev"));
        assert_eq!(life.archive.as_deref(), Some("docker compose down"));
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn a_project_with_only_a_setup_script_gets_exactly_its_old_behaviour() {
        let dir = scratch("legacy", "[worktree]\nsetup = \"touch WARMED\"\n");
        let report = bring_to_spec(&dir, &dir, Scope::Full, true, &[], false).unwrap();
        assert_eq!(report.steps.len(), 1);
        assert_eq!(report.steps[0].id, "deps:setup");
        assert!(report.at_spec);
        assert!(dir.join("WARMED").exists());
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn a_settings_file_that_was_never_valid_toml_is_still_run() {
        // The whole reason the legacy scanner exists: this line has always been
        // read and has always worked. Growing the spec around `[worktree]` must
        // not quietly stop warming the projects that predate it.
        let dir = scratch("legacy-loose", "[worktree]\nsetup = touch LOOSE # warm it\n");
        let report = bring_to_spec(&dir, &dir, Scope::Full, true, &[], false).unwrap();
        assert!(report.at_spec, "{:?}", report.shortfalls());
        assert!(dir.join("LOOSE").exists());
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn a_project_that_declares_an_environment_and_mistypes_it_is_told_so() {
        // The opposite bargain, and the reason the leniency above is scoped to
        // files with no `[env]`: a plan silently missing the package it could
        // not read would report itself at spec and be wrong.
        let dir = scratch(
            "broken-env",
            "[env]\nversion = 1\n\n[[env.package]]\nmanager = \"brew\"\n",
        );
        let err = bring_to_spec(&dir, &dir, Scope::Full, true, &[], false).unwrap_err();
        assert!(err.contains("name"), "{err}");
        assert!(observe(&dir, &dir, Scope::Full, &[]).is_err());
        assert!(teardown(&dir, &dir, true, &[]).is_err());
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn a_declared_environment_is_realised_and_then_converges() {
        let dir = scratch(
            "converge",
            r#"
[[env.package]]
manager = "local"
name    = "marker"
check   = "test -f installed"
install = "touch installed"

[[env.service]]
name  = "pretend"
start = "touch running"
ready = "test -f running"
"#,
        );
        let first = bring_to_spec(&dir, &dir, Scope::Environment, true, &[], false).unwrap();
        assert!(first.at_spec, "{:?}", first.shortfalls());
        assert!(first.changed);
        assert!(dir.join("installed").exists());
        assert!(dir.join("running").exists());

        let again = bring_to_spec(&dir, &dir, Scope::Environment, true, &[], false).unwrap();
        assert!(again.at_spec);
        assert!(!again.changed, "a converged place installs nothing twice");
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn observing_measures_without_touching() {
        let dir = scratch(
            "observe",
            "[[env.package]]\nmanager=\"local\"\nname=\"m\"\ncheck=\"test -f x\"\ninstall=\"touch x\"\n",
        );
        let seen = observe(&dir, &dir, Scope::Environment, &[]).unwrap();
        assert!(!seen.at_spec);
        assert!(!dir.join("x").exists());
        assert_eq!(seen.steps[0].detail, "would run: touch x");
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn a_failure_carries_what_the_command_said() {
        let dir = scratch(
            "detail",
            "[[env.package]]\nmanager=\"local\"\nname=\"m\"\ncheck=\"false\"\ninstall=\"echo 'no network' >&2; exit 9\"\n",
        );
        let report = bring_to_spec(&dir, &dir, Scope::Environment, true, &[], false).unwrap();
        assert_eq!(report.steps[0].state, StepState::Failed);
        assert_eq!(report.steps[0].code, 9);
        assert_eq!(report.steps[0].detail, "no network");
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn an_unsealed_edit_is_refused_until_someone_looks_at_it() {
        let dir = scratch(
            "sealed",
            "[[env.package]]\nmanager=\"local\"\nname=\"m\"\ncheck=\"true\"\ninstall=\"true\"\n",
        );
        let key = aura_attestation::SigningKey::from_seed([11u8; 32]);
        let sealed = aura_env::load(&dir);
        aura_env::write_lock(&dir, &aura_env::sign_spec(&sealed, &key, 1).unwrap()).unwrap();

        std::fs::write(
            dir.join(".aura").join("settings.toml"),
            "[[env.package]]\nmanager=\"local\"\nname=\"m\"\ncheck=\"test -f OWNED\"\ninstall=\"touch OWNED\"\n",
        )
        .unwrap();

        let err = bring_to_spec(&dir, &dir, Scope::Environment, true, &[], false).unwrap_err();
        assert!(err.contains("re-sign"), "{err}");
        assert!(!dir.join("OWNED").exists());

        // Measuring is always allowed, and forcing is a human's decision.
        assert!(observe(&dir, &dir, Scope::Environment, &[]).is_ok());
        assert!(bring_to_spec(&dir, &dir, Scope::Environment, true, &[], true)
            .unwrap()
            .at_spec);
        assert!(dir.join("OWNED").exists());
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn teardown_stops_services_then_runs_the_projects_archive() {
        let dir = scratch(
            "down",
            r#"
[[env.service]]
name  = "db"
start = "true"
stop  = "echo db >> order"

[[env.service]]
name  = "cache"
start = "true"
stop  = "echo cache >> order"

[worktree]
archive = "echo archive >> order"
"#,
        );
        assert_eq!(teardown(&dir, &dir, true, &[]).unwrap(), 3);
        let order = std::fs::read_to_string(dir.join("order")).unwrap();
        assert_eq!(order.lines().collect::<Vec<_>>(), vec!["cache", "db", "archive"]);
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// A machine with nothing on it, reaching a spec that names all four layers.
    ///
    /// This is the end the whole feature was built for, so it is deliberately
    /// the least mocked test here: the toolchain and the package go through the
    /// *derived* `mise`/`cargo` commands rather than hand-written `check`/
    /// `install` overrides, which means the preflight probes, the version
    /// grepping and the install strings are all the real ones. What stands in
    /// for the two managers is a pair of scripts on a `PATH` this test controls
    /// — the box is fresh, and the only honest way to prove it converges is to
    /// start it with nothing and watch it arrive.
    #[test]
    fn a_fresh_box_reaches_every_declared_layer_from_nothing() {
        let dir = scratch(
            "fresh-box",
            r#"
[env]
version = 7

[env.toolchain]
manager = "mise"
node    = "20.11.0"

[[env.package]]
manager = "cargo"
name    = "cargo-nextest"
version = "0.9.72"

[[env.service]]
name  = "postgres"
start = "echo up > pg.pid"
ready = "test -f pg.pid"
stop  = "rm -f pg.pid"

[worktree]
setup = "echo installed > node_modules.txt"
"#,
        );

        // The box's whole world: two package managers that remember what they
        // were told to install, and nothing else.
        let bin = dir.join("bin");
        std::fs::create_dir_all(&bin).unwrap();
        fake(&bin, "mise", MISE);
        fake(&bin, "cargo", CARGO);
        let path = format!("{}:/usr/bin:/bin", bin.display());
        let state = dir.join("installed.txt").display().to_string();
        let env: Vec<(&str, &str)> = vec![("PATH", &path), ("FAKE_STATE", &state)];

        // Sealed, so this is the reviewed-spec path and not the forced one.
        let key = aura_attestation::SigningKey::from_seed([7u8; 32]);
        let spec = aura_env::load(&dir);
        aura_env::write_lock(&dir, &aura_env::sign_spec(&spec, &key, 1).unwrap()).unwrap();

        // Nothing is installed, and measuring the box changes that not at all.
        let before = observe(&dir, &dir, Scope::Full, &env).unwrap();
        assert!(!before.at_spec);
        assert!(!before.changed);
        assert!(!dir.join("node_modules.txt").exists());

        let got = bring_to_spec(&dir, &dir, Scope::Full, true, &env, false).unwrap();
        assert!(got.at_spec, "did not converge: {:?}", got.shortfalls());
        assert!(got.changed);
        assert_eq!(got.version, 7);
        assert!(got.trust.may_apply(), "{:?}", got.trust);

        // Every layer, in the only order that works: the managers were checked
        // for before they were used, the toolchain before the package that
        // assumes it, the deps before the service.
        let ids: Vec<&str> = got.steps.iter().map(|s| s.id.as_str()).collect();
        assert_eq!(
            ids,
            vec![
                "preflight:mise",
                "preflight:cargo",
                "toolchain:node",
                "package:cargo/cargo-nextest",
                "deps:setup",
                "service:postgres",
            ]
        );

        // And it actually happened, on the box, rather than being reported.
        let installed = std::fs::read_to_string(&state).unwrap();
        assert!(installed.contains("node 20.11.0"), "{installed}");
        assert!(installed.contains("cargo-nextest v0.9.72"), "{installed}");
        assert!(dir.join("node_modules.txt").exists());
        assert!(dir.join("pg.pid").exists(), "the service was never started");

        // Asked again, a box already at spec installs nothing twice — the
        // property that makes this safe to run on every worktree, every hour.
        let again = bring_to_spec(&dir, &dir, Scope::Environment, true, &env, false).unwrap();
        assert!(again.at_spec);
        assert!(!again.changed, "{:?}", again.steps);
        assert_eq!(installed, std::fs::read_to_string(&state).unwrap());

        // Taking it down stops the service and runs the project's archive.
        assert!(teardown(&dir, &dir, true, &env).unwrap() >= 1);
        assert!(!dir.join("pg.pid").exists());

        let _ = std::fs::remove_dir_all(&dir);
    }

    /// Write an executable stand-in for a package manager onto the box's PATH.
    fn fake(bin: &Path, name: &str, body: &str) {
        let path = bin.join(name);
        std::fs::write(&path, body).unwrap();
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o755)).unwrap();
        }
    }

    /// `mise ls --installed <tool>` lists what `mise install <tool>@<ver>` was
    /// told to install, in the format the derived check greps for.
    const MISE: &str = r#"#!/bin/sh
case "$1" in
  ls)      grep -v '^cargo ' "$FAKE_STATE" 2>/dev/null ;;
  install) echo "$2" | tr '@' ' ' >> "$FAKE_STATE" ;;
  *)       exit 0 ;;
esac
"#;

    /// `cargo install --list` prints `<crate> v<version>:`, which is the shape
    /// the derived package check looks for.
    const CARGO: &str = r#"#!/bin/sh
if [ "$1" = "install" ] && [ "$2" = "--list" ]; then
  grep '^cargo ' "$FAKE_STATE" 2>/dev/null | sed 's/^cargo //'
  exit 0
fi
if [ "$1" = "install" ]; then
  echo "cargo $2 v$4:" >> "$FAKE_STATE"
  exit 0
fi
exit 0
"#;

    #[test]
    fn a_project_that_declares_nothing_is_at_spec_and_untouched() {
        let dir = tmp("bare");
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let report = bring_to_spec(&dir, &dir, Scope::Full, true, &[], false).unwrap();
        assert!(report.at_spec);
        assert!(!report.changed);
        assert_eq!(report.trust, TrustState::Unsigned);
        let _ = std::fs::remove_dir_all(&dir);
    }
}
