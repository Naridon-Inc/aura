//! Two-phase execution: install with the network, run without it.
//!
//! A run of an agent is two different jobs wearing one name. The first fetches
//! a toolchain, a lockfile's worth of packages and whatever the project's setup
//! script decided it needed — it *is* network use, and confining it would only
//! mean confining nothing, since every host it reaches is one the project asked
//! for by installing from it. The second is a model with a shell, reading a
//! repository full of text that came from somewhere, and it needs the network
//! for a handful of named machines and nothing else.
//!
//! Given one network policy for both, the first job sets it, and it is
//! "everything". This crate is the split:
//!
//! | | [`Phase::Setup`] | [`Phase::Agent`] |
//! |---|---|---|
//! | reaches | anything | the [`Egress`] list, and nothing else |
//! | how | no wall at all | [`wall`] + [`Broker`] |
//! | when it is refused | never | in words, on the spot, and in the [`Journal`] |
//!
//! ## The shape of it
//!
//! * [`policy`] — what the agent phase may reach: what the project declared in
//!   `[env.network]` of its **signed** spec, plus a floor it cannot work
//!   without. Signed matters: an agent talked into adding its own exfiltration
//!   host to the allowlist has broken the seal, not widened the list.
//! * [`wall`] — the default-deny half, which knows only "loopback or nothing"
//!   and drops UDP outright so QUIC cannot go around any of this.
//! * [`broker`] — the allowlist itself, as a proxy on loopback, because a
//!   firewall allows addresses and an allowlist is written in names.
//! * [`journal`] and [`report`] — what was refused, in a sentence a person can
//!   act on. A wall that silently drops packets produces a bug report that says
//!   "it hangs".
//! * [`guard`] — the script that puts it all up in the right order and starts
//!   the work inside it.
//!
//! Nothing here decides *where* the work runs. A place — this laptop or a box
//! somebody brought — is the desktop app's word, and both of them get the same
//! two phases from the same script, because the script is generated from the
//! spec rather than written twice.

pub mod broker;
pub mod guard;
pub mod journal;
pub mod phase;
pub mod policy;
pub mod report;
pub mod wall;

pub use broker::Broker;
pub use guard::{is_run_name, Guard, REL_DIR};
pub use journal::{tally, Attempt, Journal, Refusal, Via};
pub use phase::{Phase, Reach};
pub use policy::{floor, model_endpoints, Allowed, Egress, Endpoint, Reason};
pub use report::Report;
