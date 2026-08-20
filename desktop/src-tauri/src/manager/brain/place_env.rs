//! Bringing a place to the environment its project declares.
//!
//! The seventh question in the runtime contract, and the one the other six were
//! building towards: *is this place what the work needs it to be, and if not,
//! make it so.*
//!
//! ## Why it lives on `Place` and not next to the worktree code
//!
//! `[worktree] setup` was a CLI concern because a worktree was a CLI concern —
//! `aura work` made one, the crew runner made twenty, and each got warmed by a
//! shell command before an agent was let loose in it. The moment a session can
//! run on a box, that stops being true. A remote session's worktree is a
//! directory on somebody else's computer, and "the deps are installed" is a
//! property of *that* machine.
//!
//! Written as a second implementation over ssh it would drift on the first fix,
//! which is the failure this whole seam exists to prevent. So the judgement —
//! what to run, in what order, whether a check means skip, how long to wait for
//! a database — lives in [`aura_env`] as a state machine, and this file supplies
//! the one thing it cannot: the ability to run a string somewhere. That
//! somewhere is [`Place::sh`], which already knows whether "here" is this disk
//! or a machine at the end of a multiplexed connection. Local and remote are
//! therefore not two code paths that agree; they are one code path.
//!
//! ## Where the spec is read from, and where trust is read from
//!
//! Two different files, deliberately from two different places.
//!
//! The **spec** comes from the place itself — `.aura/settings.toml` in the
//! checkout that is actually there. A box building last month's release branch
//! needs last month's toolchain, and taking the spec from this laptop's working
//! tree would quietly give it today's.
//!
//! The **team registry** that decides whether a signature belongs to somebody we
//! know comes from this laptop's checkout, never from the place. Asking the
//! machine you are about to run commands on whether its own signer is
//! trustworthy is not a check. With no local checkout to consult there is no
//! answer, and the verdict is [`TrustState::SelfSigned`] — intact, signer
//! unknown — which is the truth rather than a downgrade.

use std::time::Duration;

use aura_env::{
    plan, verdict, EnvReport, EnvSpec, Phase, Plan, Run, Scope, SignedSpec, TrustState,
};

use crate::cloudbox::script::quote;

use super::place::Place;

/// How long a check or a readiness probe may take. Generous for a round trip
/// over ssh, nowhere near long enough to hide a hung command.
const PROBE_WAIT: Duration = Duration::from_secs(120);

/// How long an install may take. `apt-get update`, `cargo install --locked` and
/// `npm ci` on a cold cache are all minutes, and a box provisioning itself from
/// nothing is the case this whole feature exists for.
const APPLY_WAIT: Duration = Duration::from_secs(30 * 60);

/// A settings file is a page of TOML; a lock is a page of JSON. Neither is ever
/// close to this, and the cap is what stops a `cat` of the wrong path pulling a
/// gigabyte across the wire.
const READ_CAP: usize = 512 * 1024;

/// What a place was asked to become, and whether that came from anywhere
/// trustworthy.
#[derive(Debug, Clone)]
pub struct Declared {
    pub spec: EnvSpec,
    pub trust: TrustState,
    /// Where the spec was read from, in words for a person: `this laptop` or the
    /// machine's name.
    pub source: String,
}

impl Place {
    /// Read the environment this place's checkout declares, and judge its seal.
    pub async fn declared_env(&self) -> Result<Declared, String> {
        let settings = self.cat(".aura/settings.toml").await;
        let spec = match settings {
            Some(text) => aura_env::parse_declared(&text)
                .map_err(|e| format!("{}: {}", self.label(), e))?,
            None => EnvSpec::default(),
        };

        let lock: Option<SignedSpec> = match self.cat(".aura/env.lock.json").await {
            Some(text) => match serde_json::from_str::<SignedSpec>(&text) {
                Ok(l) => Some(l),
                // A lock that cannot be read is not the same as no lock: it is a
                // seal that fails to open, and `verdict` says so through the
                // digest/signature path rather than here.
                Err(e) => {
                    return Ok(Declared {
                        trust: TrustState::Invalid {
                            detail: format!("{} is not a readable lock: {e}", aura_env::LOCK_REL_PATH),
                        },
                        spec,
                        source: self.label().to_string(),
                    })
                }
            },
            None => None,
        };

        // The registry is ours, not the machine's. An empty `here` means this
        // conversation has no checkout on this disk to consult.
        let here = self.here().trim().to_string();
        let registry = (!here.is_empty())
            .then(|| std::path::Path::new(&here).join(".aura").join("team").join("keys.jsonl"));

        Ok(Declared {
            trust: verdict(lock.as_ref(), &spec, registry.as_deref()),
            spec,
            source: self.label().to_string(),
        })
    }

    /// Ask this place how far it is from spec, changing nothing.
    ///
    /// Every check still runs — this is a real measurement of a real machine,
    /// not a re-read of what was declared — and each shortfall carries the
    /// command that would have fixed it.
    pub async fn env_state(&self, scope: Scope) -> Result<EnvReport, String> {
        Ok(self.observe_env(scope).await?.2)
    }

    /// The same measurement, with the spec and the plan it came from kept.
    ///
    /// `env_state` throws both away because a report is all a caller normally
    /// wants. [`super::place_drift`] wants all three: the spec says what was
    /// asked for, the plan holds the command that would close each gap, and the
    /// report says which gaps are open. Doing it in one pass matters over a
    /// wire — `.aura/settings.toml` is read off the place, and reading it twice
    /// to answer one question is a round trip nobody asked for.
    pub(super) async fn observe_env(
        &self,
        scope: Scope,
    ) -> Result<(Declared, Plan, EnvReport), String> {
        let declared = self.declared_env().await?;
        let plan = plan(&declared.spec, scope).map_err(|e| e.to_string())?;
        let report = self
            .pump(Run::observing(plan.clone()), declared.trust.clone())
            .await?;
        Ok((declared, plan, report))
    }

    /// Bring this place to the spec its project declares.
    ///
    /// Refuses a spec whose seal is stale or broken unless `force`, because the
    /// commands in it are about to run unattended on somebody's machine and an
    /// unreviewed edit is exactly the shape that arrives in.
    pub async fn bring_to_spec(&self, scope: Scope, force: bool) -> Result<EnvReport, String> {
        let declared = self.declared_env().await?;
        if !declared.trust.may_apply() && !force {
            return Err(format!(
                "refusing to bring {} to spec — {}",
                self.label(),
                declared.trust.describe()
            ));
        }
        let plan = plan(&declared.spec, scope).map_err(|e| e.to_string())?;
        self.pump(Run::new(plan), declared.trust).await
    }

    /// Take the declared services and the project's own archive step down, in
    /// reverse of the order that brought them up.
    ///
    /// Best-effort by design: a teardown that stops at the first failure leaves
    /// the rest of the world running, which is the opposite of what was asked.
    /// The count that comes back is how many commands succeeded.
    pub async fn teardown_env(&self) -> Result<usize, String> {
        let declared = self.declared_env().await?;
        let mut ok = 0usize;
        for (_, cmd) in aura_env::teardown(&declared.spec) {
            if let Ok(out) = self.sh(&cmd, PROBE_WAIT).await {
                if out.ok() {
                    ok += 1;
                }
            }
        }
        Ok(ok)
    }

    /// Turn the pump until the plan is done. The whole of what this file adds
    /// to [`aura_env`]: somewhere to run a string.
    async fn pump(&self, run: Run, trust: TrustState) -> Result<EnvReport, String> {
        self.pump_as(run, trust, None).await
    }

    /// Turn the pump as somebody else on this place.
    ///
    /// The same state machine, the same commands, the same signature check — a
    /// different `$HOME`. That last part is the whole of it: every tool the
    /// project declares keeps its state under a variable
    /// [`super::place_toolchain`] points at the home of whoever is running, so
    /// applying a spec as another login installs into *their* directories with
    /// nothing else changed. It is what lets the team's shared environment be
    /// built by [`super::place_base`] without a second applier existing.
    ///
    /// `-H` because that variable is the point, `-l` so the profile block that
    /// reads it is sourced, and `-n` because a prompt nobody can see is a hang:
    /// a place whose sudo wants a password should say so in one line rather than
    /// wait thirty minutes for a person who is not there.
    pub(super) async fn pump_as(
        &self,
        mut run: Run,
        trust: TrustState,
        as_login: Option<&str>,
    ) -> Result<EnvReport, String> {
        while let Some(ask) = run.next() {
            if ask.delay_ms > 0 {
                tokio::time::sleep(Duration::from_millis(ask.delay_ms)).await;
            }
            let wait = if ask.phase == Phase::Apply {
                APPLY_WAIT
            } else {
                PROBE_WAIT
            };
            let command = match as_login {
                Some(login) => become_login(login, &ask.command),
                None => ask.command.clone(),
            };
            match self.sh(&command, wait).await {
                Ok(out) => {
                    let detail = if out.stderr.trim().is_empty() {
                        out.stdout.trim()
                    } else {
                        out.stderr.trim()
                    };
                    run.answer(out.code, detail);
                }
                // The command never got to run — an unreachable box, a timeout.
                // That is a failure of the step, reported in the step's own
                // words, not an error that abandons the other twelve.
                Err(e) => run.answer(-1, &e),
            }
        }
        Ok(run.finish(trust))
    }

    /// Read a small file out of this place's root, or `None` if it isn't there.
    ///
    /// Goes through `sh` rather than `read` so the path stays relative to the
    /// root wherever that root lives, and so a missing file is a `None` rather
    /// than an error a caller has to pattern-match on.
    async fn cat(&self, rel: &str) -> Option<String> {
        let cmd = format!("head -c {READ_CAP} {}", aura_env::managers::sq(rel));
        match self.sh(&cmd, PROBE_WAIT).await {
            Ok(out) if out.ok() => Some(out.stdout),
            _ => None,
        }
    }
}

/// What a place declares and how far it is from it, without touching anything.
///
/// `machine_id` absent means this laptop — the same command answers for both
/// modes, which is the only way the two can be kept honest.
#[tauri::command]
pub async fn place_env_state(
    root: String,
    machine_id: Option<String>,
    deps: bool,
) -> Result<EnvReport, String> {
    Place::resolve(root, machine_id.as_deref())
        .env_state(scope_of(deps))
        .await
}

/// Bring a place to spec.
#[tauri::command]
pub async fn place_env_apply(
    root: String,
    machine_id: Option<String>,
    deps: bool,
    force: bool,
) -> Result<EnvReport, String> {
    Place::resolve(root, machine_id.as_deref())
        .bring_to_spec(scope_of(deps), force)
        .await
}

fn scope_of(deps: bool) -> Scope {
    if deps {
        Scope::Full
    } else {
        Scope::Environment
    }
}

/// Run one of the plan's commands as another login on this place.
///
/// The command is handed over whole and quoted, so a declared step containing a
/// pipe, a `&&` or a quote of its own arrives as the project wrote it rather
/// than as several commands the shell found in it. `cd ~` because the working
/// directory here is a member's checkout, which belongs to somebody else and
/// which the shared base has no business installing into: what it is building is
/// its own home.
fn become_login(login: &str, command: &str) -> String {
    format!(
        "sudo -n -H -u {} -- bash -lc {}",
        quote(login),
        quote(&format!("cd ~ && {command}"))
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    use aura_env::StepState;

    fn block_on<F: std::future::Future>(f: F) -> F::Output {
        tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .expect("runtime")
            .block_on(f)
    }

    /// A scratch path nothing else is using.
    ///
    /// The pid matters: these tests really do create, install into and delete
    /// directories, and a fixed name under `$TMPDIR` is shared with every other
    /// `cargo test` running on the machine — including the same suite in a
    /// second worktree. One of them deletes the other's checkout mid-run and the
    /// failure looks like a bug in the code under test.
    fn scratch(tag: &str) -> std::path::PathBuf {
        std::env::temp_dir().join(format!("aura-place-env-{tag}-{}", std::process::id()))
    }

    /// A checkout with a settings file, used as a local `Place`.
    struct Repo(std::path::PathBuf);

    impl Repo {
        fn new(tag: &str, settings: &str) -> Self {
            let dir = scratch(tag);
            let _ = std::fs::remove_dir_all(&dir);
            std::fs::create_dir_all(dir.join(".aura")).unwrap();
            std::fs::write(dir.join(".aura").join("settings.toml"), settings).unwrap();
            Repo(dir)
        }
        fn place(&self) -> Place {
            Place::Here {
                root: self.0.display().to_string(),
            }
        }
    }

    impl Drop for Repo {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.0);
        }
    }

    #[test]
    fn a_place_reads_the_spec_out_of_its_own_checkout() {
        let repo = Repo::new(
            "reads",
            "[env]\nversion = 4\n\n[[env.package]]\nmanager = \"brew\"\nname = \"ripgrep\"\n",
        );
        let d = block_on(repo.place().declared_env()).unwrap();
        assert_eq!(d.spec.version, 4);
        assert_eq!(d.spec.packages[0].name, "ripgrep");
        assert_eq!(d.trust, TrustState::Unsigned);
        assert_eq!(d.source, "this laptop");
    }

    #[test]
    fn a_project_with_no_settings_declares_nothing_rather_than_failing() {
        let dir = scratch("bare");
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let place = Place::Here {
            root: dir.display().to_string(),
        };
        let d = block_on(place.declared_env()).unwrap();
        assert!(d.spec.is_empty());
        let report = block_on(place.bring_to_spec(Scope::Full, false)).unwrap();
        assert!(report.at_spec);
        assert!(!report.changed);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn a_declared_environment_is_actually_realised_on_this_machine() {
        // Everything here is real: `sh` runs the checks and the installs, and
        // the marker file is the proof that the apply half ran and the verify
        // half saw it. The same pump, given a `Place::Box`, sends these exact
        // strings down an ssh connection.
        let dir = scratch("realise");
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(dir.join(".aura")).unwrap();
        std::fs::write(
            dir.join(".aura").join("settings.toml"),
            r#"
[[env.package]]
manager = "custom"
name    = "marker"
check   = "test -f installed.txt"
install = "echo yes > installed.txt"

[[env.service]]
name  = "pretend"
start = "echo up > service.txt"
ready = "test -f service.txt"

[worktree]
setup = "echo deps > deps.txt"
"#,
        )
        .unwrap();
        let place = Place::Here {
            root: dir.display().to_string(),
        };

        // Nothing is there yet, and observing changes that not at all.
        let seen = block_on(place.env_state(Scope::Full)).unwrap();
        assert!(!seen.at_spec);
        assert!(!seen.changed);
        assert!(!dir.join("installed.txt").exists());
        assert_eq!(seen.shortfalls().len(), 3);

        let first = block_on(place.bring_to_spec(Scope::Full, false)).unwrap();
        assert!(first.at_spec, "{:?}", first.shortfalls());
        assert!(first.changed);
        assert!(dir.join("installed.txt").exists());
        assert!(dir.join("service.txt").exists());
        assert!(dir.join("deps.txt").exists());

        // Convergence: asked again, it does the work it still has to do and
        // reinstalls nothing.
        std::fs::remove_file(dir.join("deps.txt")).unwrap();
        let again = block_on(place.bring_to_spec(Scope::Full, false)).unwrap();
        assert!(again.at_spec);
        let pkg = again
            .steps
            .iter()
            .find(|s| s.id == "package:custom/marker")
            .unwrap();
        assert_eq!(pkg.state, StepState::AlreadyAtSpec);
        assert!(dir.join("deps.txt").exists(), "the project's own step ran again");

        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn a_failing_install_is_reported_and_does_not_abandon_the_rest() {
        let repo = Repo::new(
            "failing",
            r#"
[[env.package]]
manager = "custom"
name    = "doomed"
check   = "false"
install = "echo 'no network' >&2; exit 7"

[[env.package]]
manager = "custom"
name    = "fine"
check   = "true"
install = "true"
"#,
        );
        let report = block_on(repo.place().bring_to_spec(Scope::Full, false)).unwrap();
        assert!(!report.at_spec);
        assert_eq!(report.steps.len(), 2);
        let bad = &report.steps[0];
        assert_eq!(bad.state, StepState::Failed);
        assert_eq!(bad.code, 7);
        assert_eq!(bad.detail, "no network");
        assert_eq!(report.steps[1].state, StepState::AlreadyAtSpec);
    }

    #[test]
    fn a_spec_edited_after_it_was_sealed_is_refused_until_forced() {
        let repo = Repo::new(
            "stale",
            "[[env.package]]\nmanager=\"custom\"\nname=\"a\"\ncheck=\"true\"\ninstall=\"true\"\n",
        );
        let sealed = aura_env::load(&repo.0);
        let key = aura_attestation::SigningKey::from_seed([3u8; 32]);
        aura_env::write_lock(&repo.0, &aura_env::sign_spec(&sealed, &key, 1).unwrap()).unwrap();

        // Somebody appends a command nobody reviewed.
        std::fs::write(
            repo.0.join(".aura").join("settings.toml"),
            "[[env.package]]\nmanager=\"custom\"\nname=\"a\"\ncheck=\"test -f OWNED\"\ninstall=\"touch OWNED\"\n",
        )
        .unwrap();

        let err = block_on(repo.place().bring_to_spec(Scope::Full, false)).unwrap_err();
        assert!(err.contains("re-sign"), "{err}");
        assert!(!repo.0.join("OWNED").exists(), "an unsealed edit ran anyway");

        // Observing is always allowed — measuring a machine changes nothing.
        let seen = block_on(repo.place().env_state(Scope::Full)).unwrap();
        assert!(matches!(seen.trust, TrustState::Stale { .. }));
        assert!(!repo.0.join("OWNED").exists());

        // And a human who has looked at the diff can still say go.
        let forced = block_on(repo.place().bring_to_spec(Scope::Full, true)).unwrap();
        assert!(forced.at_spec);
        assert!(repo.0.join("OWNED").exists());
    }

    #[test]
    fn a_sealed_spec_carries_its_verdict_into_the_report() {
        let repo = Repo::new(
            "sealed",
            "[env]\nversion = 9\n\n[[env.package]]\nmanager=\"custom\"\nname=\"a\"\ncheck=\"true\"\ninstall=\"true\"\n",
        );
        let spec = aura_env::load(&repo.0);
        let key = aura_attestation::SigningKey::from_seed([5u8; 32]);
        aura_env::write_lock(&repo.0, &aura_env::sign_spec(&spec, &key, 1).unwrap()).unwrap();

        let report = block_on(repo.place().bring_to_spec(Scope::Full, false)).unwrap();
        assert!(report.at_spec);
        assert_eq!(report.version, 9);
        assert_eq!(report.digest, spec.digest().unwrap());
        match report.trust {
            TrustState::SelfSigned { key_id } => {
                assert_eq!(key_id, key.verifying_key().key_id())
            }
            other => panic!("{other:?}"),
        }
    }

    #[test]
    fn services_come_down_in_reverse_and_the_projects_archive_runs_last() {
        let repo = Repo::new(
            "teardown",
            r#"
[[env.service]]
name  = "db"
start = "true"
stop  = "echo db >> order.txt"

[[env.service]]
name  = "cache"
start = "true"
stop  = "echo cache >> order.txt"

[worktree]
archive = "echo archive >> order.txt"
"#,
        );
        let done = block_on(repo.place().teardown_env()).unwrap();
        assert_eq!(done, 3);
        let order = std::fs::read_to_string(repo.0.join("order.txt")).unwrap();
        assert_eq!(order.lines().collect::<Vec<_>>(), vec!["cache", "db", "archive"]);
    }

    #[test]
    fn the_environment_scope_leaves_the_projects_own_install_alone() {
        let repo = Repo::new(
            "scope",
            "[worktree]\nsetup = \"touch RAN_SETUP\"\n",
        );
        let report = block_on(repo.place().bring_to_spec(Scope::Environment, false)).unwrap();
        assert!(report.steps.is_empty());
        assert!(!repo.0.join("RAN_SETUP").exists());

        block_on(repo.place().bring_to_spec(Scope::Full, false)).unwrap();
        assert!(repo.0.join("RAN_SETUP").exists());
    }

    #[test]
    fn a_place_is_held_to_exactly_the_rule_a_checkout_is() {
        // Both halves of `parse_declared`, asked through a Place, because the
        // failure that matters is the two arms disagreeing about what a project
        // declares — a worktree warming fine on this laptop and the same commit
        // refusing on a box, or the reverse.
        let loose = Repo::new("loose", "[worktree]\nsetup = touch LOOSE # warm it\n");
        let report = block_on(loose.place().bring_to_spec(Scope::Full, false)).unwrap();
        assert!(report.at_spec, "{:?}", report.shortfalls());
        assert!(loose.0.join("LOOSE").exists());

        let broken = Repo::new(
            "broken",
            "[env]\nversion = 1\n\n[[env.package]]\nmanager = \"brew\"\n",
        );
        let err = block_on(broken.place().bring_to_spec(Scope::Full, false)).unwrap_err();
        assert!(err.contains("name"), "{err}");
        assert!(block_on(broken.place().env_state(Scope::Full)).is_err());
        assert!(block_on(broken.place().teardown_env()).is_err());
    }

    #[test]
    fn both_commands_answer_for_this_laptop_when_no_machine_is_named() {
        let repo = Repo::new(
            "commands",
            "[[env.package]]\nmanager=\"custom\"\nname=\"a\"\ncheck=\"test -f done\"\ninstall=\"touch done\"\n",
        );
        let root = repo.0.display().to_string();

        let seen = block_on(place_env_state(root.clone(), None, true)).unwrap();
        assert!(!seen.at_spec);
        assert!(!repo.0.join("done").exists());

        let applied = block_on(place_env_apply(root, None, true, false)).unwrap();
        assert!(applied.at_spec);
        assert!(repo.0.join("done").exists());
    }
}

/// A fresh box, from nothing to the declared state.
///
/// Everything above runs the pump against `Place::Here`, which proves the
/// judgement and proves the strings are really executed — but a laptop is the
/// case that already worked. The claim this feature actually makes is the other
/// one: *a machine that has none of it ends up with all of it, by reading the
/// project's own spec.* That cannot be asserted from here. It needs a box.
///
/// So these run against a real one, in a scratch directory that holds nothing
/// but the settings file the test writes, and they check the box's own disk
/// afterwards rather than trusting the report. Ignored by default, in the same
/// shape as this crate's other live tests:
///
/// ```text
/// AURA_LIVE_MACHINE='ubuntu@host:/home/ubuntu/naridon' \
///   cargo test --lib manager::brain::place_env::live -- --ignored --test-threads=1
/// ```
#[cfg(test)]
mod live {
    use super::*;
    use aura_env::StepState;

    fn block_on<F: std::future::Future>(f: F) -> F::Output {
        tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .expect("a runtime")
            .block_on(f)
    }

    /// Everything the declared state is made of, and nothing a box would happen
    /// to have already.
    ///
    /// Deliberately not `node` or `postgres`. A real toolchain would make this
    /// a test of whether mise is installed on somebody's VM, and it would pass
    /// or fail for reasons that have nothing to do with the code under it. Each
    /// of these carries its own `check` and `install`, so the four kinds of step
    /// — preflight, toolchain, package, service — all really run, all really
    /// converge, and their proof is a file on the box's disk.
    const SPEC: &str = r#"
[env]
version = 7

[env.toolchain.brought]
version = "1.2.3"
check   = "test -f tool.ok"
install = "echo 1.2.3 > tool.ok"

[[env.package]]
manager = "custom"
name    = "widget"
check   = "test -f pkg.ok"
install = "echo widget > pkg.ok"

[[env.service]]
name  = "pretend"
start = "echo up > svc.ok"
ready = "test -f svc.ok"
stop  = "rm -f svc.ok"

[worktree]
setup   = "echo deps > deps.ok"
archive = "echo gone > archived.ok"
"#;

    /// A scratch checkout on the box, at a path nothing else uses.
    struct Fresh {
        place: Place,
        dir: String,
    }

    impl Fresh {
        /// `None` when no box was named, so the test is skipped rather than
        /// silently passing against this laptop.
        fn open(tag: &str) -> Option<Fresh> {
            let id = std::env::var("AURA_LIVE_MACHINE")
                .ok()
                .filter(|v| !v.is_empty())?;
            let anchor = Place::at_machine(&id).expect("a machine in the book");
            assert!(anchor.is_remote(), "{id} isn't a machine in the book");

            // Unique per run, so two of these in flight never share a directory
            // and a leftover from a killed run never makes the next one pass.
            let dir = format!("/tmp/aura-env-live-{tag}-{}", std::process::id());
            let seed = format!(
                "rm -rf {dir} && mkdir -p {dir}/.aura && cat > {dir}/.aura/settings.toml <<'AURA_SPEC_EOF'\n{SPEC}\nAURA_SPEC_EOF"
            );
            let out = block_on(anchor.sh(&seed, Duration::from_secs(120))).expect("seed the box");
            assert!(out.ok(), "could not write the spec onto the box: {out:?}");

            let Place::Box { machine, here, .. } = anchor else {
                unreachable!("checked remote above")
            };
            Some(Fresh {
                place: Place::Box {
                    machine,
                    root: dir.clone(),
                    here,
                },
                dir,
            })
        }

        /// Whether a file the spec was supposed to create is really on the box.
        fn has(&self, name: &str) -> bool {
            block_on(self.place.sh(&format!("test -f {name}"), Duration::from_secs(60)))
                .map(|o| o.ok())
                .unwrap_or(false)
        }
    }

    impl Drop for Fresh {
        fn drop(&mut self) {
            // Rooted at the scratch dir, which is about to stop existing, so
            // this one command runs from somewhere that will outlive it.
            if let Place::Box { machine, here, .. } = &self.place {
                let home = Place::Box {
                    machine: machine.clone(),
                    root: "/tmp".to_string(),
                    here: here.clone(),
                };
                let _ = block_on(home.sh(
                    &format!("rm -rf {}", self.dir),
                    Duration::from_secs(60),
                ));
            }
        }
    }

    #[test]
    #[ignore = "needs a real box; set AURA_LIVE_MACHINE"]
    fn a_fresh_box_reaches_the_declared_state_from_nothing() {
        let Some(f) = Fresh::open("scratch") else {
            return;
        };

        // The spec is read off the box, not off this laptop.
        let d = block_on(f.place.declared_env()).unwrap();
        assert_eq!(d.spec.version, 7);
        assert_eq!(d.spec.toolchain.tools.len(), 1);
        assert_eq!(d.spec.packages.len(), 1);
        assert_eq!(d.spec.services.len(), 1);
        assert_ne!(d.source, "this laptop", "the spec came from the wrong disk");

        // Nothing is there, and looking does not change that.
        let seen = block_on(f.place.env_state(Scope::Full)).unwrap();
        assert!(!seen.at_spec, "a bare box claimed to be at spec");
        assert!(!seen.changed, "observing a box changed it");
        assert!(!f.has("tool.ok") && !f.has("pkg.ok") && !f.has("svc.ok"));

        // From nothing to all of it, in one call.
        let brought = block_on(f.place.bring_to_spec(Scope::Full, false)).unwrap();
        assert!(brought.at_spec, "{:?}", brought.shortfalls());
        assert!(brought.changed);
        for made in ["tool.ok", "pkg.ok", "svc.ok", "deps.ok"] {
            assert!(f.has(made), "{made} was reported done but is not on the box");
        }

        // Asked again, it reinstalls nothing — the same convergence the local
        // arm has, over the wire, from the same code.
        let again = block_on(f.place.bring_to_spec(Scope::Full, false)).unwrap();
        assert!(again.at_spec);
        for id in ["toolchain:brought", "package:custom/widget", "service:pretend"] {
            let step = again
                .steps
                .iter()
                .find(|s| s.id == id)
                .unwrap_or_else(|| panic!("{id} is not in the plan any more"));
            assert_eq!(
                step.state,
                StepState::AlreadyAtSpec,
                "{id} was done twice on a box already at spec"
            );
        }

        // And down again: the service stops, then the project's own archive
        // runs — in that order, on the box.
        let stopped = block_on(f.place.teardown_env()).expect("a teardown");
        assert_eq!(stopped, 2, "teardown did not run both commands");
        assert!(!f.has("svc.ok"), "the service is still up");
        assert!(f.has("archived.ok"), "the project's archive never ran");
    }

    #[test]
    #[ignore = "needs a real box; set AURA_LIVE_MACHINE"]
    fn a_box_with_no_spec_is_at_spec_and_untouched() {
        // The other half of honesty: a machine holding a project that declares
        // nothing must not be reported as failing to reach anything.
        let Some(f) = Fresh::open("empty") else {
            return;
        };
        let clear = block_on(f.place.sh(
            "rm -rf .aura/settings.toml",
            Duration::from_secs(60),
        ))
        .expect("clear the spec");
        assert!(clear.ok());

        let d = block_on(f.place.declared_env()).unwrap();
        assert!(d.spec.is_empty());
        let report = block_on(f.place.bring_to_spec(Scope::Full, false)).unwrap();
        assert!(report.at_spec);
        assert!(!report.changed);
        assert!(report.steps.is_empty());
    }
}
