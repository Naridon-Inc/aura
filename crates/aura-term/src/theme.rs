use iced::font::{Family, Stretch, Style, Weight};
use iced::{Color, Font};

pub const fn hex(rgb: u32) -> Color {
    Color::from_rgba(
        ((rgb >> 16) & 0xFF) as f32 / 255.0,
        ((rgb >> 8) & 0xFF) as f32 / 255.0,
        (rgb & 0xFF) as f32 / 255.0,
        1.0,
    )
}

// ─── Typography ─────────────────────────────────────────────────────────────
// SansSerif maps to the system font — SF Pro on macOS, Segoe UI on Windows,
// DejaVu Sans on Linux. These render through the OS text stack with proper
// antialiasing, unlike the Albra "TRIAL" face which ships without full hinting
// and reads as pixelated in iced's cosmic-text renderer at UI sizes.
pub const FONT_SANS: Font = Font {
    family: Family::SansSerif,
    weight: Weight::Normal,
    stretch: Stretch::Normal,
    style: Style::Normal,
};
pub const FONT_SANS_MEDIUM: Font = Font {
    family: Family::SansSerif,
    weight: Weight::Medium,
    stretch: Stretch::Normal,
    style: Style::Normal,
};
pub const FONT_SANS_BOLD: Font = Font {
    family: Family::SansSerif,
    weight: Weight::Bold,
    stretch: Stretch::Normal,
    style: Style::Normal,
};

// ─── Surfaces — new palette (L-chrome + inset) ─────────────────────────────
// The L-shape (titlebar + rails + statusbar) is BG_1. Everything *inside*
// the L (sidebar body, editor canvas, review, terminal) inherits BG_0.
// Elevated surfaces (composer, cards) sit on BG_3. Hover is BG_2.
//
// Role aliases retained below so the ~300 existing call sites don't break —
// they're remapped to the new canonical values.
pub const BG_0: Color = hex(0x121212); // inset — everything inside the L
pub const BG_1: Color = hex(0x1b1b1d); // L chrome — titlebar + rails + statusbar
pub const BG_2: Color = hex(0x222224); // hover — icon buttons, popover rows
pub const BG_3: Color = hex(0x2a2a2d); // elevated — composer, new-session card

// Role aliases — point old names at their new palette slots.
pub const BG_DEEP: Color = BG_1;    // shell / L chrome
pub const BG_CHROME: Color = BG_0;  // panels blend with inset (no own bg)
pub const BG_CONTENT: Color = BG_0; // canvas
pub const BG_CARD: Color = BG_3;    // elevated card / active row
pub const BG_HOVER: Color = BG_2;   // hover surface

// ─── Borders ────────────────────────────────────────────────────────────────
// LINE is the subtle 1px stroke for elevated surfaces the user should notice
// (composer box, new-session card, popover outline). LINE_SOFT is for
// near-invisible structural dividers (topbar↔inset seam, ribbon top edge).
// Kept subtle — the L-shape silhouette is carried by the BG_0/BG_1 contrast,
// not by a bright border.
pub const LINE: Color = hex(0x2b2b2e);
pub const LINE_SOFT: Color = hex(0x1e1e20);

// ─── Text — 4-level ramp ────────────────────────────────────────────────────
// TEXT_1: headings + primary values. TEXT_2: labels + secondary values.
// TEXT_3: placeholders + muted paths. TEXT_4: barely-visible hints (kbd
// pills, "·" separators).
pub const TEXT_1: Color = hex(0xededee);
pub const TEXT_2: Color = hex(0xb5b5b8);
pub const TEXT_3: Color = hex(0x7e7e82);
pub const TEXT_4: Color = hex(0x555558);

// Aliases for pty_grid.rs compatibility (imported from aura-term W0)
pub const BG: Color = BG_CONTENT;
pub const CONTENT: Color = BG_CONTENT;
pub const TEXT: Color = TEXT_1;
pub const TEXT_MUTED: Color = TEXT_2;
pub const TEXT_DIM: Color = TEXT_3;
pub const TEXT_FAINT: Color = TEXT_4;

// System monospaced font for the PTY grid (SF Mono on macOS, Consolas on Win, DejaVu on Linux).
// Albra Grotesk (proto's sans default) is NOT mono — grid math requires a true mono.
pub const MONO: Font = Font {
    family: Family::Monospace,
    weight: Weight::Normal,
    stretch: Stretch::Normal,
    style: Style::Normal,
};
pub const MONO_MED: Font = Font {
    family: Family::Monospace,
    weight: Weight::Medium,
    stretch: Stretch::Normal,
    style: Style::Normal,
};

// ─── Semantic / brand ───────────────────────────────────────────────────────
// Aura UX olive — the "quiet" accent the design brief settled on. Keeps the
// interface low-saturation so syntax colors in the editor remain dominant.
pub const ACCENT: Color = hex(0x8fa96e);
pub const ACCENT_SOFT: Color = hex(0x2a3324);
pub const AMBER: Color = hex(0xd4a26a); // warn (dirty, modified)
pub const RED: Color = hex(0xc96a5a); // error
pub const VIOLET: Color = hex(0xa78bfa);
pub const CARET_ORANGE: Color = hex(0xd97757); // Anthropic brand orange, used for caret only
// Deprecated — kept for backward compat; do not use for new UI.
pub const GREEN: Color = hex(0x6ea97c);

// ─── Composer (input surface) ───────────────────────────────────────────────
pub const COMPOSER_BG: Color = hex(0x1c1b24);
pub const COMPOSER_BORDER: Color = hex(0x2e2d38);
pub const COMPOSER_BORDER_FOCUS: Color = hex(0x46455a);
pub const PILL_BG: Color = hex(0x303033);
pub const PILL_BG_HOVER: Color = hex(0x3b3b3e);
pub const PILL_FG: Color = hex(0xc0c0c3);
pub const SEND_BG: Color = hex(0xece8e5);
pub const SEND_BG_HOVER: Color = hex(0xfaf6f2);
pub const SEND_FG: Color = hex(0x15110e);
pub const KBD_BG: Color = hex(0x3b3a40);
pub const KBD_FG: Color = hex(0xb5b5b8);
pub const PILL_OUTLINE_BG: Color = hex(0x1c1b21);
pub const PILL_OUTLINE_BORDER: Color = hex(0x2b2a30);
pub const SELECTION: Color = hex(0x503055);

// ─── Popover ────────────────────────────────────────────────────────────────
pub const POPOVER_BG: Color = hex(0x1b1b1d);
pub const POPOVER_BORDER: Color = hex(0x2e2e31);
pub const POPOVER_ROW_HOVER: Color = hex(0x28282c);
pub const POPOVER_SECTION: Color = hex(0x76767a);

// ─── Toggle ─────────────────────────────────────────────────────────────────
pub const TOGGLE_ON: Color = hex(0x3bd26a);
pub const TOGGLE_OFF: Color = hex(0x3b3b3e);

// ─── Avatar ─────────────────────────────────────────────────────────────────
// Dusty magenta + lavender — project-identity tile.
pub const AVATAR_BG: Color = hex(0x4f1b41);
pub const AVATAR_FG: Color = hex(0xd77acd);
pub const AVATAR_PINK: Color = AVATAR_BG;

// Bright green accent — status dot (running), toggle ON.
pub const ACCENT_GREEN: Color = hex(0x00a502);

// ─── Syntax (One Dark-ish, tuned for our greys) ─────────────────────────────
pub const SYN_KEYWORD: Color = hex(0xc67ad1); // fn, let, pub, impl
pub const SYN_TYPE:    Color = hex(0xe5c07b); // Vec, String, Struct names
pub const SYN_FN:      Color = hex(0x7bb0e0); // function call / def names
pub const SYN_STRING:  Color = hex(0xa8cc7a); // "…"
pub const SYN_NUMBER:  Color = hex(0xe0a06a); // 42, 1.0
pub const SYN_COMMENT: Color = hex(0x6a6a6a); // //, /* */
pub const SYN_IDENT:   Color = hex(0xdcdcdc); // default text
pub const SYN_PUNCT:   Color = hex(0x9a9a9a); // (), ;, ::

pub const GUTTER_BG:       Color = hex(0x141414);
pub const GUTTER_NUM:      Color = hex(0x585858);
pub const GUTTER_NUM_CUR:  Color = hex(0xbababa);
pub const CHANGE_ADDED:    Color = hex(0x3bd26a);
pub const CHANGE_MODIFIED: Color = hex(0xe8a340);
pub const EDITOR_LINE_HL:  Color = hex(0x1c1c1c);

// ─── Agent palette ──────────────────────────────────────────────────────────
pub const AGENT_CLAUDE: Color = CARET_ORANGE;
pub const AGENT_CODEX: Color = hex(0x6a8fab);
pub const AGENT_GEMINI: Color = hex(0x8f6fb8);
pub const AGENT_REVIEW: Color = hex(0x5ba887);
pub const AGENT_SECURITY: Color = hex(0xd65656);
pub const AGENT_BUILTIN: Color = hex(0x7e8ca0);

// ─── Type ramp ──────────────────────────────────────────────────────────────
pub const SZ_DISPLAY: f32 = 26.0;
pub const SZ_TITLE: f32 = 17.0;
pub const SZ_BODY: f32 = 14.0;
pub const SZ_META: f32 = 12.0;
pub const SZ_MICRO: f32 = 11.0;

// ─── Spacing (4pt grid) ─────────────────────────────────────────────────────
pub const P_XS: f32 = 4.0;
pub const P_SM: f32 = 8.0;
pub const P_MD: f32 = 12.0;
pub const P_LG: f32 = 16.0;
pub const P_XL: f32 = 24.0;
pub const P_2XL: f32 = 32.0;
pub const P_3XL: f32 = 48.0;

// ─── Radius ─────────────────────────────────────────────────────────────────
pub const R_XS: f32 = 2.0;
pub const R_SM: f32 = 4.0;
pub const R_MD: f32 = 6.0;
pub const R_LG: f32 = 8.0;
pub const R_XL: f32 = 10.0;
/// The panel-outer-corner radius used by the "bent inward" columns (sidebar
/// and right panel). Larger than R_XL so the concave quarter-disc at the
/// rail/panel seam actually reads as a curve, not a chamfer.
pub const R_PANEL: f32 = 12.0;

// ─── Chrome dimensions ──────────────────────────────────────────────────────
pub const TOPBAR_H: f32 = 44.0;
pub const RIBBON_H: f32 = 28.0;
pub const WORKSPACE_RAIL_W: f32 = 64.0;
pub const NAV_RAIL_W: f32 = 52.0;
pub const NAV_TILE: f32 = 36.0;
pub const SESSION_SIDEBAR_W: f32 = 352.0;
pub const SIDEBAR_ROW_H: f32 = 30.0;
pub const MAC_TRAFFIC_LEFT: f32 = 82.0;
pub const CARD_RADIUS: f32 = 12.0;
pub const WINDOW_RADIUS: f32 = 12.0;
pub const RECENTS_W: f32 = 720.0;
pub const TERMINAL_H_DEFAULT: f32 = 240.0;
pub const REVIEW_W_DEFAULT: f32 = 480.0;
pub const RIGHT_SIDEBAR_W_DEFAULT: f32 = 320.0;
pub const COMPOSER_W: f32 = 760.0;
pub const COMPOSER_W_EMPTY: f32 = 520.0;
pub const AVATAR_SIZE: f32 = 36.0;
pub const SERVER_POPOVER_RIGHT_OFFSET: f32 = 150.0;
pub const ICON_BTN_H: f32 = 28.0;

// ─────────────────────────────────────────────────────────────────────────────
// Term-compat block — aliases + helpers used by the ported `ui::panes`,
// `ui::activity`, `ui::orchestration`, `ui::handover`, `ui::statusbar`
// modules. These names originated in term's theme; this block lets those
// modules compile against proto's tokens without rewriting every call site.
// ─────────────────────────────────────────────────────────────────────────────

// Size aliases
pub const SZ_BODY_LG: f32 = SZ_TITLE;
pub const SZ_TINY: f32 = SZ_MICRO;
pub const SZ_UI: f32 = SZ_BODY;
pub const SZ_HEADING: f32 = SZ_DISPLAY;
pub const STATUSBAR_H: f32 = 28.0;
pub const SZ_ICON_SM: f32 = 14.0;
pub const SZ_ICON: f32 = 16.0;
pub const SZ_ICON_LG: f32 = 18.0;

// Font alias
pub const UI: Font = FONT_SANS;
pub const UI_MED: Font = FONT_SANS_MEDIUM;

// Surface aliases
pub const PANE: iced::Color = BG_1;
pub const PANE_ALT: iced::Color = BG_0;
pub const CARD: iced::Color = BG_3;
pub const CARD_HI: iced::Color = BG_2;
pub const OVERLAY: iced::Color = BG_2;
pub const BORDER: iced::Color = LINE;
pub const BORDER_SOFT: iced::Color = LINE_SOFT;
pub const BORDER_HI: iced::Color = LINE;
pub const ACCENT_DIM: iced::Color = ACCENT_SOFT;

// Semantic shades
pub const BLUE: iced::Color = hex(0x78a6df);
pub const PINK: iced::Color = hex(0xe8a4d4);
pub const INFO: iced::Color = BLUE;
pub const PROGRESS: iced::Color = PINK;
pub const DIFF_ADD: iced::Color = GREEN;
pub const DIFF_REM: iced::Color = RED;

// Block state colors
pub const S_RUNNING: iced::Color = AMBER;
pub const S_COMPLETED: iced::Color = GREEN;
pub const S_FAILED: iced::Color = RED;
pub const S_GATED: iced::Color = hex(0xe8d050);
pub const S_DENIED: iced::Color = hex(0x9a3535);
pub const S_SUSPENDED: iced::Color = hex(0x7c828a);
pub const S_PROPOSED: iced::Color = PINK;

// Radius aliases
pub const R_PILL: f32 = 999.0;

// Helpers

pub fn state_color(state: aura_blocks::BlockState) -> iced::Color {
    use aura_blocks::BlockState;
    match state {
        BlockState::Running | BlockState::Resumed => S_RUNNING,
        BlockState::Completed => S_COMPLETED,
        BlockState::Failed | BlockState::RolledBack => S_FAILED,
        BlockState::Gated => S_GATED,
        BlockState::Denied => S_DENIED,
        BlockState::Suspended => S_SUSPENDED,
        BlockState::Proposed => S_PROPOSED,
        BlockState::Superseded => TEXT_DIM,
    }
}

pub fn state_label(state: aura_blocks::BlockState) -> &'static str {
    use aura_blocks::BlockState;
    match state {
        BlockState::Running => "running",
        BlockState::Resumed => "resumed",
        BlockState::Completed => "done",
        BlockState::Failed => "failed",
        BlockState::RolledBack => "reverted",
        BlockState::Gated => "gated",
        BlockState::Denied => "denied",
        BlockState::Suspended => "paused",
        BlockState::Proposed => "queued",
        BlockState::Superseded => "superseded",
    }
}

pub fn agent_color(actor: &aura_blocks::AgentRef) -> Option<iced::Color> {
    let did = actor.0.as_str();
    if !did.starts_with("did:aura:agent/") {
        return None;
    }
    let agent = did
        .trim_start_matches("did:aura:agent/")
        .split('/')
        .next()
        .unwrap_or("");
    match agent {
        "claude-code" | "claude" => Some(AGENT_CLAUDE),
        "codex" => Some(AGENT_CODEX),
        "gemini" => Some(AGENT_GEMINI),
        "review" | "review-agent" => Some(AGENT_REVIEW),
        "security" | "security-agent" => Some(AGENT_SECURITY),
        _ => Some(AGENT_BUILTIN),
    }
}

pub fn actor_label(actor: &aura_blocks::AgentRef) -> String {
    let did = actor.0.as_str();
    for prefix in ["did:aura:user/", "did:aura:agent/", "did:ext:"] {
        if let Some(rest) = did.strip_prefix(prefix) {
            return rest.split('/').next().unwrap_or(rest).to_string();
        }
    }
    did.rsplit('/').next().unwrap_or(did).to_string()
}

pub const fn with_alpha(c: iced::Color, a: f32) -> iced::Color {
    iced::Color { r: c.r, g: c.g, b: c.b, a }
}
