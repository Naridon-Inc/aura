//! `git-remote-aura` — standalone git remote helper binary.
//!
//! This is a thin entry point: `cargo install`-ing the `aura` package drops a
//! real `git-remote-aura` binary on `PATH` next to `aura`, so `git clone
//! aura://…` works out of the box. The implementation lives in one shared file,
//! `src/git_remote_aura_helper.rs`, which is also compiled into the main `aura`
//! binary (dispatched to when `aura` is invoked under this name via a
//! multi-call symlink — see `aura node install-helper`). Including it here with
//! `#[path]` keeps the two in lockstep with zero duplicated logic.

#[path = "../git_remote_aura_helper.rs"]
mod helper;

fn main() {
    helper::run();
}
