//! aura-term — Aura work surface.
//!
//! Post-merge: chrome comes from proto (topbar, rails, sidebar, active,
//! terminal_panel, ribbon, resizable dividers). The live substrate from
//! term (EmbeddedDaemon, shell completion, ⌘K palette, handover, work
//! panes, activity feed, statusbar) slots in wave-by-wave starting M3.

pub mod agents;
pub mod app;
pub mod bridge;
pub mod code_loader;
pub mod completion;
pub mod config;
pub mod daemon;
pub mod error;
pub mod fixtures;
pub mod macmenu;
pub mod pty;
pub mod pty_sub;
pub mod shell_integration;
pub mod theme;
pub mod ui;

pub use app::{
    App, COMMIT_MESSAGE_INPUT_ID, Message, ResizeTarget, SEARCH_INPUT_ID, Screen, SIDEBAR_SEARCH_INPUT_ID,
    SidebarTab,
};
pub use error::{Result, TermError};

pub const VERSION: &str = env!("CARGO_PKG_VERSION");
