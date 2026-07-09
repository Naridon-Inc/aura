//! Icon set — Lucide SVGs (MIT, 24x24, 1.5px stroke) embedded at compile
//! time. Each icon is rendered via `iced::widget::svg`, tinted via
//! `currentColor` so we can retheme from a single `iced::Color`.
//!
//! Add a new icon by:
//!   1. Drop the SVG into `aura-term/assets/icons/<name>.svg`. Ensure it
//!      uses `stroke="currentColor"` and `fill="none"` (no baked-in color).
//!   2. Add an `Icon::Foo` variant and a matching row in `handle_for`.
//!   3. (Optional) Add a legacy `pub const FOO` alias below.
//!
//! The old Unicode-glyph `pub const &str` exports are retained as thin
//! aliases to the corresponding `Icon` enum value so incremental call-site
//! migrations compile. New callers should prefer `svg(Icon::X, size)` over
//! `text(icon::X)`.

use std::sync::OnceLock;

use iced::widget::svg::{self, Handle};
use iced::{Color, Element, Length};

use crate::theme as t;

// ── embedded bytes ──────────────────────────────────────────────────────────

macro_rules! icon_bytes {
    ($name:literal) => {
        include_bytes!(concat!("../../assets/icons/", $name, ".svg"))
    };
}

// ── Icon enum ──────────────────────────────────────────────────────────────

/// Every icon bundled with the app. Keep this in sync with `handle_for`.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Icon {
    // sidebar / navigation
    Chat,
    Files,
    Search,
    Library,
    // rail panes
    Plan,
    Impacts,
    Team,
    Timeline,
    Proof,
    Memory,
    Doctor,
    // topbar
    Sidebar,
    Grid,
    Inbox,
    Plus,
    ChevronDown,
    ChevronRight,
    X,
    Diff,
    // content / misc
    Terminal,
    Sparkles,
    File,
    Folder,
    Rules,
    Branch,
    History,
    Refresh,
    Overflow,
    Mic,
    Image,
    List,
    Check,
}

fn handle_for(icon: Icon) -> &'static Handle {
    macro_rules! once {
        ($cell:ident, $bytes:expr) => {{
            static $cell: OnceLock<Handle> = OnceLock::new();
            $cell.get_or_init(|| {
                Handle::from_memory(std::borrow::Cow::Borrowed($bytes as &'static [u8]))
            })
        }};
    }

    match icon {
        Icon::Chat => once!(H_CHAT, icon_bytes!("chat")),
        Icon::Files => once!(H_FILES, icon_bytes!("files")),
        Icon::Search => once!(H_SEARCH, icon_bytes!("search")),
        Icon::Library => once!(H_LIBRARY, icon_bytes!("library")),
        Icon::Plan => once!(H_PLAN, icon_bytes!("plan")),
        Icon::Impacts => once!(H_IMPACTS, icon_bytes!("impacts")),
        Icon::Team => once!(H_TEAM, icon_bytes!("team")),
        Icon::Timeline => once!(H_TIMELINE, icon_bytes!("timeline")),
        Icon::Proof => once!(H_PROOF, icon_bytes!("proof")),
        Icon::Memory => once!(H_MEMORY, icon_bytes!("memory")),
        Icon::Doctor => once!(H_DOCTOR, icon_bytes!("doctor")),
        Icon::Sidebar => once!(H_SIDEBAR, icon_bytes!("sidebar")),
        Icon::Grid => once!(H_GRID, icon_bytes!("grid")),
        Icon::Inbox => once!(H_INBOX, icon_bytes!("inbox")),
        Icon::Plus => once!(H_PLUS, icon_bytes!("plus")),
        Icon::ChevronDown => once!(H_CHEV_D, icon_bytes!("chevron-down")),
        Icon::ChevronRight => once!(H_CHEV_R, icon_bytes!("chevron-right")),
        Icon::X => once!(H_X, icon_bytes!("x")),
        Icon::Diff => once!(H_DIFF, icon_bytes!("diff")),
        Icon::Terminal => once!(H_TERM, icon_bytes!("terminal")),
        Icon::Sparkles => once!(H_SPARK, icon_bytes!("sparkles")),
        Icon::File => once!(H_FILE, icon_bytes!("file")),
        Icon::Folder => once!(H_FOLDER, icon_bytes!("folder")),
        Icon::Rules => once!(H_RULES, icon_bytes!("rules")),
        Icon::Branch => once!(H_BRANCH, icon_bytes!("git-branch")),
        Icon::History => once!(H_HISTORY, icon_bytes!("history")),
        Icon::Refresh => once!(H_REFRESH, icon_bytes!("refresh")),
        Icon::Overflow => once!(H_OVERFLOW, icon_bytes!("overflow")),
        Icon::Mic => once!(H_MIC, icon_bytes!("mic")),
        Icon::Image => once!(H_IMAGE, icon_bytes!("image")),
        Icon::List => once!(H_LIST, icon_bytes!("list")),
        Icon::Check => once!(H_CHECK, icon_bytes!("check")),
    }
}

// ── render helpers ─────────────────────────────────────────────────────────

/// Render an icon at `size` pixels using the default (muted) color.
pub fn svg<'a, M: 'a>(icon: Icon, size: f32) -> Element<'a, M> {
    svg_colored(icon, size, t::TEXT_MUTED)
}

/// Render an icon at `size` pixels, tinted with `color`. Uses iced's
/// `svg::Style.color` filter so the stroke is painted uniformly even when
/// the underlying path specifies `stroke="currentColor"`.
pub fn svg_colored<'a, M: 'a>(icon: Icon, size: f32, color: Color) -> Element<'a, M> {
    let handle = handle_for(icon).clone();
    svg::Svg::new(handle)
        .width(Length::Fixed(size))
        .height(Length::Fixed(size))
        .style(move |_theme, _status| svg::Style { color: Some(color) })
        .into()
}

// ── legacy aliases ─────────────────────────────────────────────────────────
//
// Existing callers that still use the Unicode glyph path (e.g. keyboard
// chips in `prompt.rs`) keep their `&'static str` API. New UI chrome
// should use `svg(Icon::..., size)` directly.

pub const KBD_CMD: &str = "⌘";
pub const KBD_OPT: &str = "⌥";
pub const KBD_SHIFT: &str = "⇧";
pub const KBD_ENTER: &str = "↵";
pub const KBD_UP: &str = "↑";
pub const KBD_PLUS: &str = "+";

// Enum aliases — preferred spelling for call sites. These mirror the old
// `&'static str` constants one-for-one so the semantic mapping stays
// obvious when skimming imports.
pub const CHAT: Icon = Icon::Chat;
pub const FILES: Icon = Icon::Files;
pub const SEARCH: Icon = Icon::Search;
pub const LIBRARY: Icon = Icon::Library;
pub const SIDEBAR: Icon = Icon::Sidebar;
pub const GRID: Icon = Icon::Grid;
pub const PLUS: Icon = Icon::Plus;
pub const CLOSE: Icon = Icon::X;
pub const CHEVRON_DOWN: Icon = Icon::ChevronDown;
pub const CHEVRON_RIGHT: Icon = Icon::ChevronRight;
pub const CHEVRON_DOWN_SMALL: Icon = Icon::ChevronDown;
pub const CHEVRON_RIGHT_SMALL: Icon = Icon::ChevronRight;
pub const FOLDER: Icon = Icon::Folder;
pub const FILE: Icon = Icon::File;
pub const BRANCH: Icon = Icon::Branch;
pub const LIST: Icon = Icon::List;
pub const MIC: Icon = Icon::Mic;
pub const IMAGE: Icon = Icon::Image;
pub const REFRESH: Icon = Icon::Refresh;
pub const OVERFLOW: Icon = Icon::Overflow;
pub const HISTORY: Icon = Icon::History;
pub const CHECK: Icon = Icon::Check;
pub const DIFF: Icon = Icon::Diff;
pub const INBOX: Icon = Icon::Inbox;
pub const SHELL_PROMPT: Icon = Icon::Terminal;
pub const SPARKLE: Icon = Icon::Sparkles;
pub const RULES: Icon = Icon::Rules;
