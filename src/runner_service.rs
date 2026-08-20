//! `aura runner install` — make the runner outlive the shell that started it.
//!
//! The wizard used to start a box with `nohup aura runner serve &`. That works
//! exactly until something ends the session: closing the setup terminal reaps
//! the process group, and a reboot loses it entirely. The box then sits there
//! looking connected — it still has its token and its checkout — while the
//! cloud board slowly ages its last heartbeat out. Nobody is told. Work queued
//! against that machine simply never drains.
//!
//! So the runner belongs to the init system, not to a login shell. This module
//! renders a systemd unit and installs it in one of two scopes:
//!
//! * [`Scope::System`] — `/etc/systemd/system/aura-runner.service`, running as
//!   one named user. The right shape for a box that is one person's runner.
//! * [`Scope::User`]  — `~/.config/systemd/user/aura-runner.service` plus
//!   `loginctl enable-linger`, so the unit starts at boot without anyone
//!   logging in. This is what makes a *shared* box work: each member gets
//!   their own unit, under their own uid, reading their own credentials, and
//!   one member's runner cannot see, signal, or starve another's.
//!
//! Resource limits are part of the unit rather than an afterthought — on a
//! shared machine an unbounded agent build is a denial of service against
//! everyone else on it.

use std::path::{Path, PathBuf};
use std::process::Command;

use crate::runner_limits;

/// Where the unit is installed, which decides who it runs as and how it is
/// enabled.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Scope {
    /// System-wide unit running as one named user.
    System,
    /// Per-user unit under the caller's own uid, with lingering enabled.
    User,
}

impl Scope {
    fn unit_dir(self, home: &Path) -> PathBuf {
        match self {
            Scope::System => PathBuf::from("/etc/systemd/system"),
            Scope::User => home.join(".config/systemd/user"),
        }
    }

    /// The `WantedBy` target. A user unit hangs off `default.target`; a system
    /// unit off `multi-user.target`.
    fn wanted_by(self) -> &'static str {
        match self {
            Scope::System => "multi-user.target",
            Scope::User => "default.target",
        }
    }
}

/// The unit name is fixed: one runner per scope per box. Installing twice
/// rewrites the same file rather than accumulating orphans.
pub const UNIT_NAME: &str = "aura-runner.service";

/// Every place a runner token is known to live, in the order we trust them.
///
/// The wizard writes `~/.config/aura/runner.env`. Boxes provisioned by hand
/// from `aura-runner/aws/` predate the wizard and write
/// `/etc/aura-runner/runner.env`. Both are real, both are in the field, and
/// neither is wrong — so a *system* install looks in both rather than declaring
/// one of them the only truth and refusing on a box that is already working.
///
/// A **per-user** install is different, and the difference is the whole point
/// of it. `--user` is what a team sharing one box runs: each member gets their
/// own unit, their own credentials and their own workspaces, so nobody can
/// read or spend anyone else's. Letting that install fall back to the box-wide
/// root-owned token would hand a member a runner that quietly checks in as
/// somebody else — the board would attribute their work to another account,
/// and the isolation the flag promises would be a label with nothing behind
/// it. So a user-scope install only ever accepts the user's own file.
pub fn runner_env_candidates(home: &Path, scope: Scope) -> Vec<PathBuf> {
    let own = home.join(".config/aura/runner.env");
    match scope {
        Scope::User => vec![own],
        Scope::System => vec![own, PathBuf::from("/etc/aura-runner/runner.env")],
    }
}

/// Resolve which runner-token file this box uses.
///
/// An explicit path is taken at face value — if the operator names a file, the
/// answer is that file, and a typo should say so rather than silently falling
/// back to a different box's config.
///
/// `scope` narrows where we are willing to look; see [`runner_env_candidates`]
/// for why a per-user install must not settle for the box-wide token.
pub fn discover_runner_env(
    home: &Path,
    explicit: Option<&str>,
    scope: Scope,
) -> Result<PathBuf, String> {
    if let Some(p) = explicit.map(str::trim).filter(|s| !s.is_empty()) {
        let path = PathBuf::from(p);
        if !path.exists() {
            return Err(format!("no runner token at {}", path.display()));
        }
        return Ok(path);
    }
    let candidates = runner_env_candidates(home, scope);
    if let Some(found) = candidates.iter().find(|p| p.exists()) {
        return Ok(found.clone());
    }
    // The unit would start, fail to authenticate, and restart forever. Say so
    // now rather than leaving a red unit behind for someone to find later.
    Err(format!(
        "no runner token found. Looked in: {}.\nRun `aura runner register --name <name>` on \
         your Mac first, then write AURA_RUNNER_TOKEN=<token> into one of those files.",
        candidates
            .iter()
            .map(|p| p.display().to_string())
            .collect::<Vec<_>>()
            .join(", ")
    ))
}

/// Agent credentials sit *beside* the runner token, whichever layout the box
/// uses, because that is the directory the unit loads them from.
///
/// Getting this wrong is not a loud failure — the key lands on disk, `creds
/// list` cheerfully reports it, and the agent still exits "Not logged in"
/// because the unit was reading a different directory the whole time.
pub fn agent_env_beside(runner_env: &Path) -> PathBuf {
    runner_env
        .parent()
        .unwrap_or_else(|| Path::new("."))
        .join("agent.env")
}

/// The `PATH` a runner unit should run with: the system directories, plus the
/// two places a per-user install of an agent CLI actually lands.
///
/// `npm install -g` with a user prefix writes `~/.local/bin`; `cargo install`
/// writes `~/.cargo/bin`. Neither is on systemd's default `PATH`. Omitting them
/// produces the worst shape of failure — `claude` runs fine when the operator
/// SSHes in to check, and the service that is supposed to run it says the
/// command does not exist.
pub fn service_path(home: &Path) -> String {
    let home = home.display();
    format!(
        "/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin:\
         {home}/.local/bin:{home}/.cargo/bin"
    )
}

/// Everything the unit template needs. Split out from [`InstallOpts`] so the
/// rendering is a pure function we can test without touching a filesystem or
/// shelling `systemctl`.
#[derive(Debug, Clone)]
pub struct UnitSpec {
    pub scope: Scope,
    /// Absolute path to the `aura` binary the unit should exec.
    pub bin: PathBuf,
    /// Unix user the unit runs as. Only emitted for [`Scope::System`] — a user
    /// unit already runs as its owner, and `User=` is rejected there.
    pub user: String,
    /// The runner's display name, for the unit description.
    pub name: String,
    /// Absolute path to the env file carrying `AURA_RUNNER_TOKEN`.
    pub env_file: PathBuf,
    /// Optional agent-credential file (`aura runner creds set`). Loaded with a
    /// leading `-` so a box that signs in interactively — the common case —
    /// still starts when this file doesn't exist.
    pub agent_env_file: Option<PathBuf>,
    /// Absolute path the runner's stdout/stderr append to.
    pub log_file: PathBuf,
    /// Directory the runner starts in. systemd defaults to `/`, which is not
    /// writable and is nobody's idea of a working directory.
    pub working_dir: PathBuf,
    /// `PATH` the unit runs with. systemd's default omits the per-user bin
    /// directories, so an agent CLI installed by `npm -g` or `cargo install`
    /// is on the operator's interactive `PATH` and invisible to the service.
    pub path: String,
    /// Arguments appended after `runner serve`.
    pub serve_args: Vec<String>,
    /// Optional `CPUQuota=` value, e.g. `"400%"` for four cores.
    pub cpu_quota: Option<String>,
    /// Optional `MemoryMax=` value, e.g. `"8G"`.
    pub memory_max: Option<String>,
    /// Optional `MemorySwapMax=` value. How much this member may push out to
    /// swap *in addition to* [`Self::memory_max`] — systemd adds the two rather
    /// than the second being a slice of the first.
    ///
    /// Its own field rather than something inferred from `memory_max`, because
    /// the two answer different questions and a box can have a sensible answer
    /// to one and none to the other: `"0"` is right on a machine with no swap
    /// and wrong on every machine with some.
    pub memory_swap_max: Option<String>,
    /// Optional `TasksMax=` — processes and threads together. The other way to
    /// wedge a box, and the one `MemoryMax` cannot catch: a fork bomb needs
    /// almost no memory.
    pub tasks_max: Option<u32>,
    /// Optional `LimitFSIZE=`, in bytes — the largest single file this member's
    /// runner may write. Bounds the disk failure that arrives in minutes (a log
    /// that never rotates, a core dump, a `dd` with a typo); it does not bound
    /// the sum of a member's files, which needs filesystem quotas nobody's
    /// cloud image mounts for.
    pub max_file_size: Option<u64>,
}

/// Render the systemd unit.
///
/// Paths are quoted because a home directory with a space in it would
/// otherwise split `ExecStart` into the wrong argv — rare on Linux, but a
/// silent and very confusing failure when it happens.
pub fn render_unit(spec: &UnitSpec) -> String {
    let mut s = String::new();
    s.push_str("[Unit]\n");
    s.push_str(&format!("Description=Aura cloud runner ({})\n", spec.name));
    s.push_str("Documentation=https://auravcs.com/docs/runner\n");
    // A runner whose first act is an HTTPS poll should not race DNS at boot.
    s.push_str("After=network-online.target\n");
    s.push_str("Wants=network-online.target\n");
    // The rate limiter lives in [Unit], not [Service]. systemd moved it in
    // v229 and silently ignores it in the wrong section — logging "Unknown key
    // name" and then restarting a genuinely broken runner every RestartSec
    // forever. The guard has to be here to exist at all.
    s.push_str("StartLimitIntervalSec=300\n");
    s.push_str("StartLimitBurst=10\n\n");

    s.push_str("[Service]\n");
    s.push_str("Type=simple\n");
    if spec.scope == Scope::System {
        s.push_str(&format!("User={}\n", spec.user));
    }
    s.push_str(&format!(
        "EnvironmentFile={}\n",
        quote(&spec.env_file.display().to_string())
    ));
    if let Some(a) = spec.agent_env_file.as_ref() {
        s.push_str(&format!(
            "EnvironmentFile=-{}\n",
            quote(&a.display().to_string())
        ));
    }
    // systemd's default PATH is not the operator's PATH. `npm -g` and `cargo
    // install` both land in the home directory, so a box where `claude` works
    // in SSH can still fail under the unit with "command not found" — which
    // reads like the agent is broken rather than unreachable.
    s.push_str(&format!("Environment=PATH={}\n", spec.path));
    // Unset, this is `/`: not writable, and not where anything belongs.
    s.push_str(&format!(
        "WorkingDirectory={}\n",
        quote(&spec.working_dir.display().to_string())
    ));
    s.push_str(&format!(
        "ExecStart={} runner serve{}\n",
        quote(&spec.bin.display().to_string()),
        spec.serve_args
            .iter()
            .map(|a| format!(" {}", quote(a)))
            .collect::<String>()
    ));
    // An agent box is worth restarting forever: the failure modes are almost
    // all transient (network drop, expired token, a crashed child).
    s.push_str("Restart=always\n");
    s.push_str("RestartSec=5\n");
    // A claimed task can run the target repo's own build and test suite. Give
    // the operator's own SSH session priority over that, so a busy box stays
    // one you can log into and look at.
    s.push_str("Nice=5\n");
    // Everything this unit writes belongs to the member it runs as: the checkout
    // it clones, the agent transcripts, the log, the credentials an agent CLI
    // drops in its own dotfiles. systemd starts services at umask 0022, so on a
    // shared box every one of those lands world-readable — and the whole point
    // of a per-member unit is that the member beside you cannot read them. The
    // account's profile carries the same umask for its login shells; systemd
    // reads no profile, so it has to be said here too.
    s.push_str("UMask=0077\n");
    // The wizard tails this exact file to explain a start that never checked
    // in, so the unit writes where that tail already looks.
    s.push_str(&format!(
        "StandardOutput=append:{}\n",
        quote(&spec.log_file.display().to_string())
    ));
    s.push_str(&format!(
        "StandardError=append:{}\n",
        quote(&spec.log_file.display().to_string())
    ));
    // The isolation the shared-box flow promises, made real. Every one of these
    // defaulted to unset until `--cpu-quota auto` existed, and nothing that
    // installs a runner passed them — so `--user`, whose whole point is that
    // one member cannot starve another, rendered a unit with no limits in it.
    // What that cost is written up in [`crate::runner_limits`].
    if let Some(q) = spec.cpu_quota.as_deref().filter(|s| !s.trim().is_empty()) {
        s.push_str(&format!("CPUQuota={q}\n"));
    }
    if let Some(m) = spec.memory_max.as_deref().filter(|s| !s.trim().is_empty()) {
        s.push_str(&format!("MemoryMax={m}\n"));
    }
    // Only ever beside a `MemoryMax`. On its own it bounds nothing useful —
    // swap is where memory goes when the ceiling is reached, so a swap ceiling
    // without a memory one is a limit on the overflow of something unlimited.
    if let Some(sw) = spec
        .memory_swap_max
        .as_deref()
        .filter(|s| !s.trim().is_empty())
        .filter(|_| spec.memory_max.as_deref().is_some_and(|m| !m.trim().is_empty()))
    {
        s.push_str(&format!("MemorySwapMax={sw}\n"));
    }
    if let Some(t) = spec.tasks_max.filter(|t| *t > 0) {
        s.push_str(&format!("TasksMax={t}\n"));
    }
    if let Some(f) = spec.max_file_size.filter(|f| *f > 0) {
        s.push_str(&format!("LimitFSIZE={f}\n"));
    }
    s.push('\n');

    s.push_str("[Install]\n");
    s.push_str(&format!("WantedBy={}\n", spec.scope.wanted_by()));
    s
}

/// What `install` was asked to do, before defaults are resolved.
#[derive(Debug, Clone, Default)]
pub struct InstallOpts {
    /// Install as a per-user unit with lingering (the shared-box shape).
    pub user_scope: bool,
    /// Runner display name. Defaults to the hostname.
    pub name: Option<String>,
    /// Pin the runner to one repo instead of draining every project.
    pub repo: Option<String>,
    /// Default agent for tasks that don't name one.
    pub agent: Option<String>,
    /// Point at a runner-token file explicitly. Left unset, `install` looks
    /// through [`runner_env_candidates`].
    pub env_file: Option<String>,
    /// A systemd value taken literally, or [`runner_limits::AUTO`] to have the
    /// box size itself. Unset installs no CPU limit at all — still reachable,
    /// deliberately, for an operator who wants exactly that, but no longer what
    /// the connect wizard asks for.
    pub cpu_quota: Option<String>,
    /// As [`Self::cpu_quota`], for `MemoryMax=`.
    pub memory_max: Option<String>,
    /// As [`Self::cpu_quota`], for `MemorySwapMax=`.
    pub memory_swap_max: Option<String>,
    /// Override how many people the box divides itself between. Left unset,
    /// [`runner_limits::count_members`] counts the box's own accounts — which
    /// is the right answer often enough that this exists for the case it isn't:
    /// a box with service accounts in the human uid range, or an operator
    /// sizing for a team that hasn't all joined yet.
    pub members: Option<u32>,
}

/// What an install left behind, in enough detail for the caller to say so.
///
/// The limits are part of the result rather than something the caller re-derives
/// because "what did this actually do to my machine" must be answerable from
/// the same numbers that were written, not from a second calculation that could
/// disagree with the unit on disk.
#[derive(Debug, Clone)]
pub struct Installed {
    /// The unit file that was written.
    pub path: PathBuf,
    /// What the box decided one member's share was — `None` when every limit
    /// was passed literally or left unset, so nothing was derived.
    pub limits: Option<runner_limits::Limits>,
    /// The box measured itself and found no swap. Worth saying out loud: a
    /// memory ceiling with nothing underneath it turns a build that would have
    /// got slow into one that gets killed.
    pub swapless: bool,
}

/// Resolve the three limit flags against a box that has measured itself.
///
/// Split out and pure so the interesting decision — which values are literal,
/// which are derived, and what happens when the box will not say how big it is
/// — is testable without a machine. `measured` is `None` off Linux and on
/// anything without procfs.
///
/// An `auto` that cannot be answered resolves to *no limit*, not to a guess.
/// A number nobody measured is worse than an honest gap: it would look like
/// isolation in `systemctl cat` and behave like a number picked on a laptop
/// that had never seen the box. The caller says so instead.
fn resolve_limits(
    opts: &InstallOpts,
    measured: Option<runner_limits::BoxSize>,
) -> (Option<String>, Option<String>, Option<String>, Option<u32>, Option<u64>, Option<runner_limits::Limits>) {
    let wants_auto = |v: &Option<String>| v.as_deref().is_some_and(runner_limits::is_auto);
    let any_auto =
        wants_auto(&opts.cpu_quota) || wants_auto(&opts.memory_max) || wants_auto(&opts.memory_swap_max);

    let derived = measured.map(|mut size| {
        if let Some(n) = opts.members.filter(|n| *n > 0) {
            size.members = n;
        }
        runner_limits::derive(size)
    });
    let derived = derived.filter(|_| any_auto);

    // A literal value always wins over a derived one: an operator who wrote
    // `--memory-max 2G` meant 2G, and silently replacing it with the box's own
    // arithmetic would make the flag a suggestion.
    let pick = |asked: &Option<String>, auto: Option<&str>| -> Option<String> {
        match asked.as_deref().map(str::trim).filter(|s| !s.is_empty()) {
            Some(v) if runner_limits::is_auto(v) => auto.map(str::to_string),
            Some(v) => Some(v.to_string()),
            None => None,
        }
    };
    let cpu = pick(&opts.cpu_quota, derived.as_ref().map(|l| l.cpu_quota.as_str()));
    let mem = pick(&opts.memory_max, derived.as_ref().map(|l| l.memory_max.as_str()));
    let swap = pick(
        &opts.memory_swap_max,
        derived.as_ref().map(|l| l.memory_swap_max.as_str()),
    );
    // These two have no flag of their own. They are not a separate policy — a
    // fork bomb and a runaway file wedge the same box the same way — so they
    // ride with whatever the box worked out, and an operator who wants none of
    // this passes no `auto` at all.
    let tasks = derived.as_ref().map(|l| l.tasks_max);
    let fsize = derived.as_ref().map(|l| l.max_file_size);
    (cpu, mem, swap, tasks, fsize, derived)
}

/// Install and start the runner as a systemd unit.
///
/// Returns what it wrote and what it decided, so the caller can print both —
/// see [`Installed`].
pub fn install(opts: InstallOpts) -> Result<Installed, String> {
    require_systemd()?;

    let scope = if opts.user_scope {
        Scope::User
    } else {
        Scope::System
    };
    let home = home_dir()?;
    let user = current_user()?;
    let bin = std::env::current_exe()
        .map_err(|e| format!("couldn't find this binary's own path: {e}"))?;

    let env_file = discover_runner_env(&home, opts.env_file.as_deref(), scope)?;
    let agent_env_file = agent_env_beside(&env_file);

    let mut serve_args: Vec<String> = Vec::new();
    match opts.repo.as_deref().map(str::trim).filter(|s| !s.is_empty()) {
        Some(r) => {
            serve_args.push("--repo".into());
            serve_args.push(r.to_string());
        }
        // No repo pin means this box earns its keep across every project.
        None => serve_args.push("--all-projects".into()),
    }
    if let Some(a) = opts.agent.as_deref().map(str::trim).filter(|s| !s.is_empty()) {
        serve_args.push("--agent".into());
        serve_args.push(a.to_string());
    }

    // Measured before the unit is written and from the machine the unit will
    // run on — which is the whole reason the wizard passes `auto` rather than a
    // number it chose on somebody's Mac.
    let measured = runner_limits::measure(&home);
    let (cpu_quota, memory_max, memory_swap_max, tasks_max, max_file_size, limits) =
        resolve_limits(&opts, measured);

    let spec = UnitSpec {
        scope,
        bin,
        user: user.clone(),
        name: opts
            .name
            .map(|n| n.trim().to_string())
            .filter(|n| !n.is_empty())
            .unwrap_or_else(hostname),
        env_file,
        agent_env_file: Some(agent_env_file),
        log_file: home.join("aura-runner.log"),
        working_dir: home.clone(),
        path: service_path(&home),
        serve_args,
        cpu_quota,
        memory_max,
        memory_swap_max,
        tasks_max,
        max_file_size,
    };

    // Before the unit is written, close what it is about to read. The token in
    // that env file is enough to check in to the board AS this member; on a box
    // several people share, a `0644` copy of it is not a runner, it is everyone
    // else's runner.
    keep_to_owner(&home, &spec);

    let dir = scope.unit_dir(&home);
    std::fs::create_dir_all(&dir).map_err(|e| write_hint(&dir, e, scope))?;
    let path = dir.join(UNIT_NAME);
    std::fs::write(&path, render_unit(&spec)).map_err(|e| write_hint(&path, e, scope))?;

    // A user unit only survives logout — and therefore only starts at boot —
    // once the user lingers. Without this the whole per-member model silently
    // reduces to "runs while someone is SSH'd in".
    if scope == Scope::User {
        let _ = run("loginctl", &["enable-linger", &user]);
    }

    systemctl(scope, &["daemon-reload"])?;
    systemctl(scope, &["enable", "--now", UNIT_NAME])?;
    Ok(Installed {
        path,
        swapless: limits.as_ref().is_some_and(|l| l.swapless),
        limits,
    })
}

/// Stop, disable and remove the unit. Idempotent: a missing unit is success,
/// because "make sure this box is not running a runner" is the actual intent.
pub fn uninstall(user_scope: bool) -> Result<(), String> {
    require_systemd()?;
    let scope = if user_scope { Scope::User } else { Scope::System };
    let home = home_dir()?;
    let path = scope.unit_dir(&home).join(UNIT_NAME);

    let _ = systemctl(scope, &["disable", "--now", UNIT_NAME]);
    if path.exists() {
        std::fs::remove_file(&path)
            .map_err(|e| format!("couldn't remove {}: {e}", path.display()))?;
    }
    let _ = systemctl(scope, &["daemon-reload"]);
    Ok(())
}

/// `systemctl status` for whichever scope, passed straight through.
pub fn service_status(user_scope: bool) -> Result<String, String> {
    require_systemd()?;
    let scope = if user_scope { Scope::User } else { Scope::System };
    let mut args = vec!["--no-pager"];
    if scope == Scope::User {
        args.insert(0, "--user");
    }
    args.push("status");
    args.push(UNIT_NAME);
    let out = Command::new("systemctl")
        .args(&args)
        .output()
        .map_err(|e| format!("run systemctl: {e}"))?;
    // `status` exits non-zero for an inactive unit; that is information, not
    // an error, so both streams are handed back as-is.
    let mut s = String::from_utf8_lossy(&out.stdout).to_string();
    s.push_str(&String::from_utf8_lossy(&out.stderr));
    Ok(s.trim().to_string())
}

fn systemctl(scope: Scope, args: &[&str]) -> Result<(), String> {
    let mut full: Vec<&str> = Vec::new();
    if scope == Scope::User {
        full.push("--user");
    }
    full.extend_from_slice(args);
    run("systemctl", &full)
}

fn run(bin: &str, args: &[&str]) -> Result<(), String> {
    let out = Command::new(bin)
        .args(args)
        .output()
        .map_err(|e| format!("run {bin}: {e}"))?;
    if out.status.success() {
        return Ok(());
    }
    let err = String::from_utf8_lossy(&out.stderr);
    let msg = err.trim();
    Err(format!(
        "{bin} {} failed{}",
        args.join(" "),
        if msg.is_empty() {
            String::new()
        } else {
            format!(": {msg}")
        }
    ))
}

/// Turn a permission error on the unit path into the advice that actually
/// unblocks the user, instead of a bare "permission denied".
fn write_hint(path: &Path, e: std::io::Error, scope: Scope) -> String {
    if e.kind() == std::io::ErrorKind::PermissionDenied && scope == Scope::System {
        return format!(
            "can't write {} without root. Either re-run with sudo, or install a \
             per-user runner with `aura runner install --user` (which needs no root \
             and is what a shared box wants anyway).",
            path.display()
        );
    }
    format!("couldn't write {}: {e}", path.display())
}

/// Close the files this unit reads and writes to the account that owns them.
///
/// The token, the agent credentials beside it, and the log the agent's output
/// appends to. Every one of them is written by something with a umask of its
/// own: the wizard types a `printf` into a login shell, an agent CLI writes its
/// own dotfiles, and systemd creates the log — and the default of all three is
/// world-readable. On one person's box that is merely untidy. On a box a team
/// shares it is the whole isolation gone, because reading another member's
/// `runner.env` is enough to check in to the board as them.
///
/// Only ever inside the member's own home. `/etc/aura-runner/runner.env` is the
/// box-wide layout of a single-owner machine, owned by root and shared by
/// design; re-permissioning somebody else's file is not this command's business,
/// and without root it would fail anyway.
///
/// Best-effort on purpose: a mode we could not set must not stop a runner
/// installing. The unit's own `UMask=0077` covers everything written from here
/// on regardless.
fn keep_to_owner(home: &Path, spec: &UnitSpec) {
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;

        let mut close = |path: &Path, mode: u32| {
            if !path.starts_with(home) || !path.exists() {
                return;
            }
            let _ = std::fs::set_permissions(path, std::fs::Permissions::from_mode(mode));
        };
        // The directory first: a `0700` directory is what stops another member
        // listing the tokens even when a file inside it is left readable.
        if let Some(dir) = spec.env_file.parent() {
            close(dir, 0o700);
        }
        close(&spec.env_file, 0o600);
        if let Some(agent) = spec.agent_env_file.as_deref() {
            close(agent, 0o600);
        }
        close(&spec.log_file, 0o600);
    }
    #[cfg(not(unix))]
    {
        let _ = (home, spec);
    }
}

fn require_systemd() -> Result<(), String> {
    if !cfg!(target_os = "linux") {
        return Err(
            "`aura runner install` manages a systemd unit, which is Linux-only. On macOS \
             leave the Aura app running, or point the wizard at a Linux box."
                .to_string(),
        );
    }
    if !Path::new("/run/systemd/system").exists() {
        return Err(
            "this machine isn't running systemd, so there's nothing to install into. \
             Start the runner yourself with `aura runner serve --all-projects`."
                .to_string(),
        );
    }
    Ok(())
}

/// The home directory the runner should use.
///
/// Installing a *system* unit needs root, so this is nearly always reached
/// through `sudo` — and under sudo `$HOME` is `/root`. Writing that into the
/// unit points the agent's dotfiles, its credentials and its log at root's
/// home, which is neither where the operator put them nor where the wizard
/// looks. Resolve the invoking human's home instead.
fn home_dir() -> Result<PathBuf, String> {
    if let Some(u) = sudo_user() {
        if let Some(h) = passwd_home(&u) {
            return Ok(h);
        }
    }
    std::env::var("HOME")
        .map(PathBuf::from)
        .map_err(|_| "HOME isn't set, so there's no home directory to install into".to_string())
}

/// The human who invoked us, when we are running under `sudo`.
fn sudo_user() -> Option<String> {
    std::env::var("SUDO_USER")
        .ok()
        .map(|u| u.trim().to_string())
        .filter(|u| !u.is_empty() && u != "root")
}

/// Look a user's home up in the passwd database rather than guessing
/// `/home/<name>` — which is wrong on macOS, on NixOS, and for any account
/// whose home was placed somewhere else.
fn passwd_home(user: &str) -> Option<PathBuf> {
    let out = Command::new("getent").args(["passwd", user]).output().ok()?;
    if !out.status.success() {
        return None;
    }
    let line = String::from_utf8_lossy(&out.stdout);
    let home = line.trim_end().split(':').nth(5)?;
    if home.is_empty() {
        return None;
    }
    Some(PathBuf::from(home))
}

/// The account the unit should run the runner as.
///
/// Same reasoning as [`home_dir`]: `sudo aura runner install` must not produce
/// `User=root`. An agent run as root on a shared box can read every other
/// member's credentials, which is precisely what the seat model exists to stop.
fn current_user() -> Result<String, String> {
    if let Some(u) = sudo_user() {
        return Ok(u);
    }
    if let Ok(u) = std::env::var("USER") {
        if !u.trim().is_empty() {
            return Ok(u);
        }
    }
    let out = Command::new("id")
        .arg("-un")
        .output()
        .map_err(|e| format!("run id -un: {e}"))?;
    let u = String::from_utf8_lossy(&out.stdout).trim().to_string();
    if u.is_empty() {
        Err("couldn't determine the current user".to_string())
    } else {
        Ok(u)
    }
}

fn hostname() -> String {
    Command::new("hostname")
        .output()
        .ok()
        .map(|o| String::from_utf8_lossy(&o.stdout).trim().to_string())
        .filter(|s| !s.is_empty())
        .unwrap_or_else(|| "aura-runner".to_string())
}

/// Quote a value for a systemd unit if it contains anything that would split
/// or be reinterpreted. systemd accepts double quotes around a whole argument.
fn quote(v: &str) -> String {
    if v.is_empty() {
        return "\"\"".to_string();
    }
    if v
        .chars()
        .all(|c| c.is_ascii_alphanumeric() || "/._-=:+,@%".contains(c))
    {
        v.to_string()
    } else {
        format!("\"{}\"", v.replace('\\', r"\\").replace('"', "\\\""))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn spec(scope: Scope) -> UnitSpec {
        UnitSpec {
            scope,
            bin: PathBuf::from("/usr/local/bin/aura"),
            user: "ubuntu".into(),
            name: "home-server".into(),
            env_file: PathBuf::from("/home/ubuntu/.config/aura/runner.env"),
            agent_env_file: None,
            // NOTE: kept None here so the base template test asserts the
            // no-credentials shape; the optional-load case has its own test.
            log_file: PathBuf::from("/home/ubuntu/aura-runner.log"),
            working_dir: PathBuf::from("/home/ubuntu"),
            path: service_path(Path::new("/home/ubuntu")),
            serve_args: vec!["--all-projects".into()],
            cpu_quota: None,
            memory_max: None,
            memory_swap_max: None,
            tasks_max: None,
            max_file_size: None,
        }
    }

    #[test]
    fn an_agent_cli_installed_per_user_is_still_on_the_services_path() {
        let u = render_unit(&spec(Scope::System));
        // The two places `npm -g` and `cargo install` actually write. Without
        // these the unit cannot exec an agent the operator can run by hand.
        assert!(u.contains("/home/ubuntu/.local/bin"));
        assert!(u.contains("/home/ubuntu/.cargo/bin"));
        // ...without losing the system directories the binary itself lives in.
        assert!(u.contains("Environment=PATH=/usr/local/sbin:/usr/local/bin:"));
    }

    #[test]
    fn the_runner_starts_somewhere_writable_rather_than_at_the_filesystem_root() {
        let u = render_unit(&spec(Scope::System));
        assert!(u.contains("WorkingDirectory=/home/ubuntu"));
    }

    #[test]
    fn a_busy_box_stays_one_you_can_ssh_into() {
        let u = render_unit(&spec(Scope::System));
        assert!(u.contains("Nice=5"));
    }

    #[test]
    fn a_system_unit_names_the_user_it_runs_as() {
        let u = render_unit(&spec(Scope::System));
        assert!(u.contains("User=ubuntu"));
        assert!(u.contains("WantedBy=multi-user.target"));
    }

    #[test]
    fn a_user_unit_never_sets_user_because_systemd_rejects_it_there() {
        let u = render_unit(&spec(Scope::User));
        assert!(!u.contains("User="));
        assert!(u.contains("WantedBy=default.target"));
    }

    /// The lines of one `[Section]` of a unit file.
    ///
    /// A directive in the wrong section is not an error — systemd logs
    /// "Unknown key name" and carries on — so asserting on the whole file
    /// cannot tell a working unit from a silently ignored one.
    fn section<'a>(unit: &'a str, name: &str) -> Vec<&'a str> {
        unit.lines()
            .skip_while(|l| l.trim() != name)
            .skip(1)
            .take_while(|l| !l.trim_start().starts_with('['))
            .map(str::trim)
            .filter(|l| !l.is_empty())
            .collect()
    }

    #[test]
    fn the_runner_restarts_forever_but_not_in_a_hot_loop() {
        let u = render_unit(&spec(Scope::System));
        assert!(section(&u, "[Service]").contains(&"Restart=always"));
        // systemd moved the rate limiter to [Unit] in v229 and ignores it in
        // [Service]. Assert where it lands, not merely that we wrote it.
        assert!(section(&u, "[Unit]").contains(&"StartLimitBurst=10"));
        assert!(section(&u, "[Unit]").contains(&"StartLimitIntervalSec=300"));
        assert!(!section(&u, "[Service]").contains(&"StartLimitBurst=10"));
    }

    #[test]
    fn limits_are_emitted_only_when_asked_for() {
        let mut s = spec(Scope::System);
        assert!(!render_unit(&s).contains("CPUQuota"));
        s.cpu_quota = Some("400%".into());
        s.memory_max = Some("8G".into());
        s.memory_swap_max = Some("8G".into());
        s.tasks_max = Some(4096);
        s.max_file_size = Some(90 * 1024 * 1024 * 1024);
        let u = render_unit(&s);
        assert!(u.contains("CPUQuota=400%"));
        assert!(u.contains("MemoryMax=8G"));
        assert!(u.contains("MemorySwapMax=8G"));
        assert!(u.contains("TasksMax=4096"));
        assert!(u.contains("LimitFSIZE=96636764160"));
    }

    #[test]
    fn a_swap_ceiling_without_a_memory_one_is_not_written() {
        // On its own it bounds nothing: swap is where memory goes when the
        // ceiling is reached, so a swap limit over an unlimited service caps
        // the overflow of something that never overflows. Emitting it anyway
        // would put a limit in `systemctl cat` that reads like isolation.
        let mut s = spec(Scope::System);
        s.memory_swap_max = Some("4G".into());
        assert!(!render_unit(&s).contains("MemorySwapMax"));
        s.memory_max = Some("8G".into());
        assert!(render_unit(&s).contains("MemorySwapMax=4G"));
    }

    #[test]
    fn a_swapless_box_writes_a_zero_ceiling_rather_than_leaving_it_open() {
        // `MemorySwapMax=0` is systemd for "may use none", which is the truth
        // on a box with no swap — and unlike an omitted directive, it says so.
        let mut s = spec(Scope::System);
        s.memory_max = Some("7168M".into());
        s.memory_swap_max = Some("0".into());
        assert!(render_unit(&s).contains("MemorySwapMax=0"));
    }

    #[test]
    fn an_empty_limit_string_is_treated_as_unset_not_as_a_broken_directive() {
        let mut s = spec(Scope::System);
        s.cpu_quota = Some("   ".into());
        assert!(!render_unit(&s).contains("CPUQuota"));
        s.cpu_quota = None;
        s.memory_max = Some("8G".into());
        s.memory_swap_max = Some("  ".into());
        assert!(!render_unit(&s).contains("MemorySwapMax"));
        // A zero is not an empty string. `TasksMax=0` would forbid the service
        // its own first process, so it is dropped rather than written.
        s.tasks_max = Some(0);
        s.max_file_size = Some(0);
        let u = render_unit(&s);
        assert!(!u.contains("TasksMax"));
        assert!(!u.contains("LimitFSIZE"));
    }

    /// The install flags as the connect wizard sends them.
    fn auto_opts() -> InstallOpts {
        InstallOpts {
            user_scope: true,
            cpu_quota: Some(runner_limits::AUTO.into()),
            memory_max: Some(runner_limits::AUTO.into()),
            memory_swap_max: Some(runner_limits::AUTO.into()),
            ..InstallOpts::default()
        }
    }

    /// A 32 GB, 8-core box with swap, shared by four people.
    fn measured() -> runner_limits::BoxSize {
        runner_limits::BoxSize {
            cores: 8,
            mem_bytes: 32 * 1024 * 1024 * 1024,
            swap_bytes: 8 * 1024 * 1024 * 1024,
            disk_bytes: 500 * 1024 * 1024 * 1024,
            members: 4,
        }
    }

    #[test]
    fn auto_becomes_the_boxs_own_arithmetic() {
        // The end of the bug this task exists for: the wizard says `auto`, the
        // box answers with its own size, and a real ceiling reaches the unit.
        let (cpu, mem, swap, tasks, fsize, limits) = resolve_limits(&auto_opts(), Some(measured()));
        assert_eq!(cpu.as_deref(), Some("175%"));
        assert_eq!(mem.as_deref(), Some("7168M"));
        assert_eq!(swap.as_deref(), Some("7168M"));
        assert_eq!(tasks, Some(2048));
        assert!(fsize.is_some_and(|f| f > 0));
        assert!(limits.is_some());
    }

    #[test]
    fn a_value_the_operator_typed_is_never_replaced_by_the_boxs_guess() {
        // Otherwise `--memory-max 2G` is a suggestion, and a person who sized
        // their own box gets overruled by arithmetic they never asked for.
        let opts = InstallOpts {
            memory_max: Some("2G".into()),
            ..auto_opts()
        };
        let (cpu, mem, _, _, _, _) = resolve_limits(&opts, Some(measured()));
        assert_eq!(mem.as_deref(), Some("2G"));
        // And the flags they *did* leave on auto still get the box's answer.
        assert_eq!(cpu.as_deref(), Some("175%"));
    }

    #[test]
    fn a_box_that_will_not_say_how_big_it_is_gets_no_limit_rather_than_a_guess() {
        // A number nobody measured is worse than an honest gap: it would read
        // as isolation in `systemctl cat` and behave like a constant picked on
        // a laptop that had never seen the machine.
        let (cpu, mem, swap, tasks, fsize, limits) = resolve_limits(&auto_opts(), None);
        assert_eq!(cpu, None);
        assert_eq!(mem, None);
        assert_eq!(swap, None);
        assert_eq!(tasks, None);
        assert_eq!(fsize, None);
        assert!(limits.is_none());
    }

    #[test]
    fn nothing_is_derived_for_an_install_that_asked_for_nothing() {
        // The pre-existing shape, still reachable: no flags means no limits and
        // no measurement. Deriving anyway would change what every hand-run
        // `aura runner install` does to a box.
        let (cpu, mem, swap, tasks, fsize, limits) =
            resolve_limits(&InstallOpts::default(), Some(measured()));
        assert_eq!(cpu, None);
        assert_eq!(mem, None);
        assert_eq!(swap, None);
        assert_eq!(tasks, None);
        assert_eq!(fsize, None);
        assert!(limits.is_none());
    }

    #[test]
    fn an_explicit_member_count_overrides_what_the_box_counted() {
        // For the box whose service accounts sit in the human uid range, and
        // for the operator sizing ahead of a team that hasn't all joined.
        let opts = InstallOpts {
            members: Some(2),
            ..auto_opts()
        };
        let (cpu, mem, ..) = resolve_limits(&opts, Some(measured()));
        // Eight cores less one for the box, halved rather than quartered.
        assert_eq!(cpu.as_deref(), Some("350%"));
        assert_eq!(mem.as_deref(), Some("14336M"));
    }

    #[test]
    fn the_unit_a_shared_box_ends_up_with_carries_every_limit() {
        // The acceptance test, read off the file that is actually written: a
        // member's unit on a shared box has a CPU ceiling, a memory ceiling and
        // a swap ceiling, and none of them is the whole machine.
        let opts = auto_opts();
        let (cpu_quota, memory_max, memory_swap_max, tasks_max, max_file_size, _) =
            resolve_limits(&opts, Some(measured()));
        let s = UnitSpec {
            cpu_quota,
            memory_max,
            memory_swap_max,
            tasks_max,
            max_file_size,
            ..spec(Scope::User)
        };
        let u = render_unit(&s);
        for directive in ["CPUQuota=175%", "MemoryMax=7168M", "MemorySwapMax=7168M", "TasksMax="] {
            assert!(u.contains(directive), "the unit is missing {directive}:\n{u}");
        }
        // The umask was already here and is the other half of the same promise
        // — limits stop a member starving the box, `0077` stops them reading it.
        assert!(u.contains("UMask=0077"));
    }

    #[test]
    fn a_path_with_a_space_is_quoted_so_execstart_keeps_one_argv() {
        let mut s = spec(Scope::System);
        s.bin = PathBuf::from("/opt/my tools/aura");
        let u = render_unit(&s);
        assert!(u.contains("ExecStart=\"/opt/my tools/aura\" runner serve --all-projects"));
    }

    #[test]
    fn the_log_target_is_the_file_the_wizard_tails() {
        let u = render_unit(&spec(Scope::System));
        assert!(u.contains("StandardOutput=append:/home/ubuntu/aura-runner.log"));
        assert!(u.contains("StandardError=append:/home/ubuntu/aura-runner.log"));
    }

    /// Credentials must be loaded from the directory the token lives in.
    /// A box provisioned by hand keeps both under `/etc/aura-runner/`; one set
    /// up by the wizard keeps both under `$HOME/.config/aura/`. Splitting them
    /// across layouts is how a key ends up on disk that the agent never reads.
    #[test]
    fn agent_credentials_sit_beside_the_token_in_either_layout() {
        assert_eq!(
            agent_env_beside(Path::new("/etc/aura-runner/runner.env")),
            PathBuf::from("/etc/aura-runner/agent.env")
        );
        assert_eq!(
            agent_env_beside(Path::new("/home/ubuntu/.config/aura/runner.env")),
            PathBuf::from("/home/ubuntu/.config/aura/agent.env")
        );
    }

    #[test]
    fn an_explicitly_named_token_file_that_is_missing_is_an_error_not_a_fallback() {
        // Silently falling back would install a unit pointing at a *different*
        // box's config, which starts green and drains the wrong queue.
        let home = PathBuf::from("/home/ubuntu");
        let err =
            discover_runner_env(&home, Some("/nope/runner.env"), Scope::System).unwrap_err();
        assert!(err.contains("/nope/runner.env"));
    }

    #[test]
    fn a_box_with_no_token_anywhere_names_every_place_we_looked() {
        let home = PathBuf::from("/nonexistent-home-for-tests");
        let err = discover_runner_env(&home, None, Scope::System).unwrap_err();
        assert!(err.contains(".config/aura/runner.env"));
        assert!(err.contains("/etc/aura-runner/runner.env"));
        assert!(err.contains("aura runner register"));
    }

    /// The shared-box promise. `--user` exists so several people can run on one
    /// machine with their own credentials and their own board identity. If a
    /// member with no token of their own could fall back to the box-wide
    /// root-owned one, their runner would check in as whoever registered that
    /// token — their work attributed to another account, on a flag whose entire
    /// purpose was to keep them apart.
    #[test]
    fn a_per_user_install_never_borrows_the_boxes_shared_token() {
        let home = PathBuf::from("/home/ada");
        let looked = runner_env_candidates(&home, Scope::User);
        assert_eq!(looked, vec![home.join(".config/aura/runner.env")]);
        assert!(
            !looked.iter().any(|p| p.starts_with("/etc")),
            "a user-scope install must not reach outside the user's home: {looked:?}"
        );
    }

    /// A system install is the single-tenant shape, and boxes provisioned by
    /// hand before the wizard existed keep their token under `/etc`. Refusing
    /// those would break machines that work today.
    #[test]
    fn a_system_install_still_accepts_a_hand_provisioned_box() {
        let looked = runner_env_candidates(&PathBuf::from("/home/ubuntu"), Scope::System);
        assert!(looked.iter().any(|p| p.starts_with("/etc/aura-runner")));
    }

    /// The other half of the shared-box promise, and the half systemd will not
    /// give you by default: it starts services at umask 0022, so the checkout a
    /// member's runner clones, its agent transcripts and its log all land
    /// world-readable — on the exact machine where the person at the next desk
    /// has a login. The account's profile sets the same umask for login shells;
    /// systemd reads no profile, so the unit has to carry its own.
    #[test]
    fn what_a_members_runner_writes_is_not_readable_by_the_member_beside_them() {
        for scope in [Scope::System, Scope::User] {
            let u = render_unit(&spec(scope));
            assert!(
                section(&u, "[Service]").contains(&"UMask=0077"),
                "{scope:?} unit writes group- and world-readable files"
            );
        }
    }

    /// Everything the wizard and the agent CLIs wrote BEFORE the unit existed —
    /// with their own umasks, in a login shell — is closed on the way in. The
    /// token is the sharp one: a readable `runner.env` is enough to check in to
    /// the board as that member.
    #[test]
    fn installing_closes_the_token_the_wizard_left_world_readable() {
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;

            let home = std::env::temp_dir().join(format!("aura-runner-perms-{}", std::process::id()));
            let dir = home.join(".config/aura");
            let _ = std::fs::remove_dir_all(&home);
            std::fs::create_dir_all(&dir).unwrap();
            let env_file = dir.join("runner.env");
            let agent = dir.join("agent.env");
            let log = home.join("aura-runner.log");
            for f in [&env_file, &agent, &log] {
                std::fs::write(f, "AURA_RUNNER_TOKEN=secret\n").unwrap();
                std::fs::set_permissions(f, std::fs::Permissions::from_mode(0o644)).unwrap();
            }
            std::fs::set_permissions(&dir, std::fs::Permissions::from_mode(0o755)).unwrap();

            let mut s = spec(Scope::User);
            s.env_file = env_file.clone();
            s.agent_env_file = Some(agent.clone());
            s.log_file = log.clone();
            keep_to_owner(&home, &s);

            let mode = |p: &Path| std::fs::metadata(p).unwrap().permissions().mode() & 0o777;
            assert_eq!(mode(&env_file), 0o600, "the runner token is still readable");
            assert_eq!(mode(&agent), 0o600, "the agent credentials are still readable");
            assert_eq!(mode(&log), 0o600, "the agent's output is still readable");
            assert_eq!(mode(&dir), 0o700, "the directory holding them is still listable");
            let _ = std::fs::remove_dir_all(&home);
        }
    }

    /// A box provisioned by hand keeps its token in `/etc`, owned by root and
    /// shared by design. Re-permissioning somebody else's file is not this
    /// command's business — and the file that says so is the same one that
    /// refuses to let a per-user install read it.
    #[test]
    fn the_box_wide_token_is_not_ours_to_re_permission() {
        let home = PathBuf::from("/home/ada");
        let mut s = spec(Scope::System);
        s.env_file = PathBuf::from("/etc/aura-runner/runner.env");
        s.agent_env_file = Some(PathBuf::from("/etc/aura-runner/agent.env"));
        // Nothing outside the home is touched — the guard is the path check, so
        // this runs safely even where those files exist.
        keep_to_owner(&home, &s);
        assert!(!s.env_file.starts_with(&home));
    }

    #[test]
    fn the_optional_credentials_file_loads_with_a_leading_dash() {
        // `-` means "start anyway if it isn't there". Without it, every box
        // that signs in interactively fails to start.
        let mut s = spec(Scope::System);
        s.agent_env_file = Some(PathBuf::from("/etc/aura-runner/agent.env"));
        let u = render_unit(&s);
        assert!(u.contains("EnvironmentFile=-/etc/aura-runner/agent.env"));
    }
}
