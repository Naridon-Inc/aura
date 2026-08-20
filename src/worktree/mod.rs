//! Cross-worktree coordination — the control plane.
//!
//! A repository often has many checkouts at once: one per agent, one per
//! branch under review, one for the release. Aura already recorded who was
//! editing what; it just recorded it *per checkout*, so every worktree held a
//! private opinion about the world and none of them could see each other. A
//! claim in `barcelona` was invisible in `granada`, a message sent from one was
//! undeliverable to the other, and a zone protected only the tree that declared
//! it.
//!
//! The fix is a split, not a rewrite:
//!
//! * [`paths`] resolves the **repository root** (not the current directory) and
//!   hands out two kinds of path — shared and private.
//! * [`crate::sentinel`] and [`crate::awareness::store`] moved to the shared
//!   one; sessions, transcripts and memory stayed private.
//! * Every record now carries the checkout it came from, so the answer is
//!   "claude, in `barcelona`" rather than "someone".
//! * [`migrate`] adopts state written before the split, so nobody loses work
//!   in flight at upgrade time.
//!
//! [`discover`] enumerates the checkouts, [`overview`] joins them against agent
//! activity, [`render`] and [`cmd`] are the `aura worktrees` surface.
//!
//! Two later additions finish the loop from *seeing* another checkout to
//! *handing it work*: [`board_root`] anchors the task board to the repository
//! so every checkout reads one board rather than quietly starting its own, and
//! [`assign`] addresses a task to an agent in a named checkout and tells that
//! agent it has arrived.

pub mod api;
pub mod assign;
pub mod board_root;
pub mod cmd;
pub mod discover;
pub mod migrate;
pub mod overview;
pub mod paths;
pub mod render;

#[cfg(test)]
pub mod testing;

#[cfg(test)]
mod plane_tests;
