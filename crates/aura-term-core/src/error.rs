//! Error type for the terminal engine.
//!
//! Deliberately small: the engine only ever fails while wiring up a PTY
//! (spawn / clone / ioctl) or doing raw IO on the master fd. Everything
//! downstream (parsing bytes, updating the grid) is infallible from the
//! caller's point of view.

use std::io;

pub type Result<T> = std::result::Result<T, Error>;

/// Failure modes for the terminal engine.
#[derive(Debug, thiserror::Error)]
pub enum Error {
    /// Raw IO against the PTY master (read / write / clone / ioctl).
    #[error("terminal io: {0}")]
    Io(#[from] io::Error),

    /// The PTY could not be created or configured (shell resolution,
    /// `openpty`, window-size setup).
    #[error("pty setup: {0}")]
    Pty(String),
}
