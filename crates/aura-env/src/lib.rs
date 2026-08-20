//! What a project needs to exist, declared once and brought about everywhere.
//!
//! ## Where this came from
//!
//! A fresh `git worktree` has the source and none of the derived state, so
//! `[worktree] setup` was added to `.aura/settings.toml`: one shell command, run
//! once per fresh tree, and the agent that lands there can build. That closed
//! the immediate hole and left a larger one open, because `setup` is a command
//! and not a description. `npm ci` installs what `package.json` names — on a box
//! that already has the right Node. `cargo build` needs a toolchain. A test that
//! talks to Postgres needs Postgres to be *running*, which no install step does.
//! Each of those is assumed rather than stated, and an assumption is exactly the
//! thing that is true on the laptop it was written on and false on the machine
//! it was written for.
//!
//! So this is the same file, grown. `[worktree] setup/run/archive` stays and
//! still means what it meant; `[env]` says the rest out loud:
//!
//! ```toml
//! [env]
//! version = 3                     # bumped by whoever changes the spec
//!
//! [env.toolchain]
//! manager = "mise"                # mise | asdf | proto — how versions arrive
//! node    = "20.11.0"
//! rust    = "1.79.0"
//!
//! [[env.package]]                 # a tool the work needs on PATH
//! manager = "cargo"
//! name    = "cargo-nextest"
//! version = "0.9.72"
//!
//! [[env.service]]                 # something that must be RUNNING, not installed
//! name  = "postgres"
//! start = "docker compose up -d db"
//! ready = "pg_isready -h 127.0.0.1"
//! stop  = "docker compose down"
//!
//! [worktree]
//! setup   = "npm ci"              # the project's own dependency manifests
//! run     = "npm run dev"
//! archive = "docker compose down"
//! ```
//!
//! That is the whole point of the exercise: **how someone installs a package is
//! that they declare it.** It lands for everyone, and because the file is
//! committed, it is in history — you can ask when `cargo-nextest` arrived and
//! read the commit that says why, instead of finding out from a red CI run.
//!
//! ## Why it is signed
//!
//! A spec is a list of commands that will be run, as whoever runs them, on every
//! machine the team owns. That is a supply-chain surface, and `settings.toml` is
//! a text file any tool with write access can edit. So the spec is sealed: the
//! canonical JSON of [`EnvSpec`] is hashed, the digest and the spec are signed
//! ed25519 into `.aura/env.lock.json`, and the lock is committed alongside. A
//! place refuses by default to apply a spec whose content no longer matches what
//! was signed ([`TrustState::Stale`]) or whose signature does not check out
//! ([`TrustState::Invalid`]). The key resolves through the same git-tracked
//! `.aura/team/keys.jsonl` a signed intent block uses, so "who declared this
//! environment" is a question the repository itself answers.
//!
//! ## Why the applier is a state machine and not a function
//!
//! The governing rule of this programme is that no feature may land in one
//! place-mode only. An environment that only converges on the laptop, or only
//! over ssh, would be exactly that. But the two callers are shaped differently:
//! the CLI runs commands synchronously with [`std::process::Command`], the
//! desktop app runs them through `Place::sh`, which is `async` and may be
//! crossing a wire. Written as two loops they agree until the first fix.
//!
//! So the ordering, the idempotency and the readiness polling live in [`drive`]
//! as a pump the caller turns: [`Run::next`] hands out one command and
//! [`Run::answer`] takes its exit code. Sync or async, local or remote, there is
//! one implementation of *what to do next*, and the caller only supplies the
//! ability to run a string somewhere.
//!
//! ## Module map
//!
//! | Module | Owns |
//! |---|---|
//! | [`spec`] | the declared state, as data — and its digest |
//! | [`parse`] | `.aura/settings.toml` → [`EnvSpec`] |
//! | [`managers`] | how each package/toolchain manager is asked and told |
//! | [`plan`] | [`EnvSpec`] → the ordered [`Step`]s that realise it |
//! | [`drive`] | the pump: which command next, and what its answer meant |
//! | [`lock`] | sign, verify, and the trust verdict a place acts on |

pub mod drive;
pub mod lock;
pub mod managers;
pub mod parse;
pub mod plan;
pub mod spec;

pub use drive::{Ask, EnvReport, Phase, Run, StepOutcome, StepState};
pub use lock::{
    lock_path, read_lock, sign_spec, trust, verdict, verify_lock, write_lock, LockError,
    SigEnvelope, SignedSpec, TrustState, LOCK_REL_PATH,
};
pub use parse::{
    load, load_checked, load_declared, parse_declared, parse_spec, settings_path, ParseError,
    SETTINGS_REL_PATH,
};
pub use plan::{plan, teardown, Plan, PlanError, Scope, Step, StepKind};
pub use spec::{EnvSpec, Lifecycle, Network, Package, Service, Tool, Toolchain, SPEC_SCHEMA};
