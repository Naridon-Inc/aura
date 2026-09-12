//! Reading what `git` prints, with no `git` anywhere near it.
//!
//! Every parser here is a pure function from text to a value the React side
//! already consumes. They used to live inline in `cmd_files.rs` and
//! `cmd_aura_fs.rs`, each one glued to the `std::process::Command` that
//! produced its input — which meant that the day a workspace's files moved to
//! a box across the wire (AURA-1306), there was no way to read `git status`
//! from *there* without copying the parser, and a copied parser is two parsers
//! the moment either one is fixed.
//!
//! So the split is: the local commands spawn `git` and hand the bytes here;
//! the remote commands (`manager::brain::place_work`) run the same `git` line
//! through [`Place::sh`](crate::manager::brain::place::Place::sh) and hand the
//! bytes here. One reading of each format, tested once, and the two arms
//! cannot drift apart because neither owns the reading.

pub mod branches;
pub mod files;
pub mod graph;
pub mod stats;
pub mod status;
