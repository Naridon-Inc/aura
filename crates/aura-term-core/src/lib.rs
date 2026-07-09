//! `aura-term-core` — a UI-agnostic terminal engine.
//!
//! The engine has two halves, neither of which knows about any GUI toolkit:
//!
//! * [`pty`] — spawn a shell in a pseudo-terminal, stream its bytes, and
//!   detect OSC 133 prompt markers. Runs its read side on a dedicated blocking
//!   thread and hands events out over a channel.
//! * [`grid`] — feed those bytes into an `alacritty_terminal::Term` and take a
//!   cheap immutable [`grid::GridSnapshot`] (char + color + flags per cell,
//!   plus cursor) for a renderer to paint.
//!
//! Colors are resolved into a toolkit-neutral [`color::Rgba`] via a
//! [`color::Palette`]. The iced work surface (`aura-term`) converts `Rgba` ->
//! `iced::Color`; the Tauri shell's native GPU renderer uploads `Rgba`
//! straight into a wgpu vertex buffer. Same engine, two front-ends.
//!
//! Everything here is synchronous and testable without a window, so the whole
//! core is exercised by unit tests that run behind the macOS synthetic-input
//! wall.

pub mod color;
pub mod error;
pub mod grid;
pub mod pty;
pub mod render;

pub use color::{Palette, Rgba};
pub use error::{Error, Result};
pub use grid::{
    GridSnapshot, GridTerminal, RenderCell, Selection, snapshot_selection_text, snapshot_to_text,
};
pub use pty::{Osc133, PtyConfig, PtyEvent, PtySession, default_window_size, spawn};
pub use render::{
    BgRect, CellMetrics, CursorRect, GlyphQuad, RenderList, append_selection_rects,
    build_render_list,
};

// Re-export the alacritty window-size type so callers can build a `PtyConfig`
// without depending on `alacritty_terminal` directly.
pub use alacritty_terminal::event::WindowSize;
