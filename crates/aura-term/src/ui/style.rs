//! Shared style closures for containers, buttons, inputs, scrollable. Every
//! widget in the UI routes through here — the goal is one design system, not
//! per-widget bespoke decisions.
//!
//! Phase 1 / W-D1: every function in this file reads tokens from
//! [`super::theme`] and only from there. If you see a raw color or radius
//! anywhere below, it is a bug — open an issue.

use iced::widget::{button, container, scrollable, text_input};
use iced::{Background, Border, Color, Shadow, Theme, Vector};

use crate::theme as t;

// ── container styles ─────────────────────────────────────────────────────

/// Root of the application window. Everything composites on top of `BG_0`.
pub fn root(_: &Theme) -> container::Style {
    container::Style {
        background: Some(Background::Color(t::BG_0)),
        text_color: Some(t::TEXT_1),
        ..container::Style::default()
    }
}

/// Side panes, topbar, statusbar body. Sits one notch brighter than root.
pub fn pane(_: &Theme) -> container::Style {
    container::Style {
        background: Some(Background::Color(t::BG_1)),
        text_color: Some(t::TEXT_1),
        ..container::Style::default()
    }
}

/// Legacy alias — `pane_alt` used to differ from `pane` but the new palette
/// collapses both to `BG_1`. Kept so existing call sites compile; flag for
/// review in a follow-up wave.
// TODO(W-D2): audit remaining `pane_alt` callers and migrate to `pane`.
pub fn pane_alt(_: &Theme) -> container::Style {
    container::Style {
        background: Some(Background::Color(t::BG_1)),
        text_color: Some(t::TEXT_1),
        ..container::Style::default()
    }
}

/// The terminal viewport surface — sits on the desktop canvas, not a pane.
pub fn content_surface(_: &Theme) -> container::Style {
    container::Style {
        background: Some(Background::Color(t::BG_0)),
        text_color: Some(t::TEXT_1),
        ..container::Style::default()
    }
}

pub fn topbar(_: &Theme) -> container::Style {
    container::Style {
        background: Some(Background::Color(t::BG_1)),
        border: Border {
            color: t::LINE_SOFT,
            width: 1.0,
            radius: 0.0.into(),
        },
        text_color: Some(t::TEXT_1),
        ..container::Style::default()
    }
}

pub fn statusbar(_: &Theme) -> container::Style {
    container::Style {
        background: Some(Background::Color(t::BG_1)),
        border: Border {
            color: t::LINE_SOFT,
            width: 1.0,
            radius: 0.0.into(),
        },
        text_color: Some(t::TEXT_2),
        ..container::Style::default()
    }
}

/// A standard elevated card. Uses the 2nd elevation step and the card
/// radius.
pub fn card(_: &Theme) -> container::Style {
    container::Style {
        background: Some(Background::Color(t::BG_2)),
        border: Border {
            color: t::LINE,
            width: 1.0,
            radius: t::R_LG.into(),
        },
        text_color: Some(t::TEXT_1),
        ..container::Style::default()
    }
}

/// A card that's been hovered or is the active one in a list.
pub fn card_hi(_: &Theme) -> container::Style {
    container::Style {
        background: Some(Background::Color(t::BG_3)),
        border: Border {
            color: t::LINE,
            width: 1.0,
            radius: t::R_LG.into(),
        },
        text_color: Some(t::TEXT_1),
        shadow: Shadow {
            color: Color::from_rgba(0.0, 0.0, 0.0, 0.35),
            offset: Vector::new(0.0, 2.0),
            blur_radius: 10.0,
        },
        ..container::Style::default()
    }
}

/// A card currently in focus (selected block in the list).
pub fn card_focus(_: &Theme) -> container::Style {
    container::Style {
        background: Some(Background::Color(t::BG_3)),
        border: Border {
            color: t::ACCENT_SOFT,
            width: 1.0,
            radius: t::R_LG.into(),
        },
        text_color: Some(t::TEXT_1),
        ..container::Style::default()
    }
}

/// A card for a failed/denied block — red-tinted border.
pub fn card_fail(_: &Theme) -> container::Style {
    container::Style {
        background: Some(Background::Color(t::BG_2)),
        border: Border {
            color: t::with_alpha(t::S_FAILED, 0.35),
            width: 1.0,
            radius: t::R_LG.into(),
        },
        text_color: Some(t::TEXT_1),
        ..container::Style::default()
    }
}

/// Inline chip with a soft background and a text-color accent. Rounded pill.
pub fn chip_soft(bg: Color, fg: Color) -> impl Fn(&Theme) -> container::Style {
    move |_| container::Style {
        background: Some(Background::Color(bg)),
        border: Border {
            color: t::LINE_SOFT,
            width: 1.0,
            radius: t::R_PILL.into(),
        },
        text_color: Some(fg),
        ..container::Style::default()
    }
}

/// Inline chip with no border — used for counters/badges.
pub fn chip_flat(bg: Color, fg: Color) -> impl Fn(&Theme) -> container::Style {
    move |_| container::Style {
        background: Some(Background::Color(bg)),
        border: Border {
            color: Color::TRANSPARENT,
            width: 0.0,
            radius: t::R_PILL.into(),
        },
        text_color: Some(fg),
        ..container::Style::default()
    }
}

/// A small colored dot — used for state indicators on block cards & tabs.
pub fn dot(color: Color) -> impl Fn(&Theme) -> container::Style {
    move |_| container::Style {
        background: Some(Background::Color(color)),
        border: Border {
            color: Color::TRANSPARENT,
            width: 0.0,
            radius: t::R_PILL.into(),
        },
        ..container::Style::default()
    }
}

/// A 2px vertical stripe — used as the agent identity band on block cards.
pub fn strip(color: Color) -> impl Fn(&Theme) -> container::Style {
    move |_| container::Style {
        background: Some(Background::Color(color)),
        ..container::Style::default()
    }
}

/// Legacy divider — 1px line background. Prefer [`divider_h`] going forward.
// TODO(W-D2): consolidate `divider` and `divider_h` into one call site.
pub fn divider(_: &Theme) -> container::Style {
    container::Style {
        background: Some(Background::Color(t::LINE_SOFT)),
        ..container::Style::default()
    }
}

/// Horizontal 1px divider used inside menus and list headers.
pub fn divider_h(_: &Theme) -> container::Style {
    container::Style {
        background: Some(Background::Color(t::LINE_SOFT)),
        ..container::Style::default()
    }
}

// ── input styles ─────────────────────────────────────────────────────────

/// The primary text input — search boxes, filter boxes, prompts.
pub fn input_primary(theme: &Theme, status: text_input::Status) -> text_input::Style {
    let focused = matches!(status, text_input::Status::Focused { .. });
    text_input::Style {
        background: Background::Color(t::BG_2),
        border: Border {
            color: if focused { t::ACCENT } else { t::LINE },
            width: 1.0,
            radius: t::R_MD.into(),
        },
        icon: t::TEXT_2,
        placeholder: t::TEXT_3,
        value: t::TEXT_1,
        selection: t::ACCENT_SOFT,
        ..text_input::default(theme, status)
    }
}

/// A frameless input — the terminal prompt line.
pub fn input_ghost(theme: &Theme, status: text_input::Status) -> text_input::Style {
    text_input::Style {
        background: Background::Color(Color::TRANSPARENT),
        border: Border {
            color: Color::TRANSPARENT,
            width: 0.0,
            radius: 0.0.into(),
        },
        icon: t::TEXT_2,
        placeholder: t::TEXT_3,
        value: t::TEXT_1,
        selection: t::ACCENT_SOFT,
        ..text_input::default(theme, status)
    }
}

/// Monospace input — file path fields, command palettes.
// TODO(W-D2): review whether `input_mono` is still needed after the palette
// refactor collapses `CONTENT` to `BG_0`.
pub fn input_mono(theme: &Theme, status: text_input::Status) -> text_input::Style {
    let focused = matches!(status, text_input::Status::Focused { .. });
    text_input::Style {
        background: Background::Color(t::BG_0),
        border: Border {
            color: if focused { t::ACCENT_SOFT } else { t::LINE },
            width: 1.0,
            radius: t::R_LG.into(),
        },
        icon: t::TEXT_2,
        placeholder: t::TEXT_3,
        value: t::TEXT_1,
        selection: t::ACCENT_SOFT,
        ..text_input::default(theme, status)
    }
}

// ── button styles ────────────────────────────────────────────────────────

/// Toolbar icon button — transparent idle, `BG_2` on hover, radius `R_MD`.
/// The active (pressed) state shares the hover background so the press feels
/// continuous.
pub fn icon_button(_: &Theme, status: button::Status) -> button::Style {
    let hovered = matches!(status, button::Status::Hovered);
    let pressed = matches!(status, button::Status::Pressed);
    let bg = if hovered || pressed {
        t::BG_2
    } else {
        Color::TRANSPARENT
    };
    let fg = if hovered || pressed {
        t::TEXT_1
    } else {
        t::TEXT_2
    };
    button::Style {
        background: Some(Background::Color(bg)),
        text_color: fg,
        border: Border {
            color: Color::TRANSPARENT,
            width: 0.0,
            radius: t::R_MD.into(),
        },
        ..button::Style::default()
    }
}

/// Top-bar tab — active tab gets `BG_2` with `R_MD`; idle is transparent.
pub fn tab_button(active: bool) -> impl Fn(&Theme, button::Status) -> button::Style {
    move |_, status| {
        let hovered = matches!(status, button::Status::Hovered);
        let bg = if active {
            t::BG_2
        } else if hovered {
            t::BG_1
        } else {
            Color::TRANSPARENT
        };
        button::Style {
            background: Some(Background::Color(bg)),
            text_color: if active { t::TEXT_1 } else { t::TEXT_2 },
            border: Border {
                color: Color::TRANSPARENT,
                width: 0.0,
                radius: t::R_MD.into(),
            },
            ..button::Style::default()
        }
    }
}

/// Pill-shaped chip button — used for filters in the activity/status rails.
pub fn chip_button(active: bool) -> impl Fn(&Theme, button::Status) -> button::Style {
    move |_, status| {
        let hovered = matches!(status, button::Status::Hovered);
        let bg = if active {
            t::ACCENT_SOFT
        } else if hovered {
            t::BG_2
        } else {
            t::BG_1
        };
        let fg = if active { t::TEXT_1 } else { t::TEXT_2 };
        button::Style {
            background: Some(Background::Color(bg)),
            text_color: fg,
            border: Border {
                color: if active { t::ACCENT_SOFT } else { t::LINE_SOFT },
                width: 1.0,
                radius: t::R_PILL.into(),
            },
            ..button::Style::default()
        }
    }
}

/// Low-emphasis action — transparent idle, `BG_1` on hover.
pub fn ghost_button(_: &Theme, status: button::Status) -> button::Style {
    let hovered = matches!(status, button::Status::Hovered);
    button::Style {
        background: Some(Background::Color(if hovered {
            t::BG_1
        } else {
            Color::TRANSPARENT
        })),
        text_color: if hovered { t::TEXT_1 } else { t::TEXT_2 },
        border: Border {
            color: Color::TRANSPARENT,
            width: 0.0,
            radius: t::R_MD.into(),
        },
        ..button::Style::default()
    }
}

/// The only "real" button — confirm/submit style.
pub fn primary_action(_: &Theme, status: button::Status) -> button::Style {
    let hovered = matches!(status, button::Status::Hovered);
    button::Style {
        background: Some(Background::Color(if hovered { t::BG_3 } else { t::BG_2 })),
        text_color: t::TEXT_1,
        border: Border {
            color: t::LINE,
            width: 1.0,
            radius: t::R_MD.into(),
        },
        ..button::Style::default()
    }
}

/// Static pill container — `BG_2`, pill radius, 0 12 padding assumed at the
/// call site.
pub fn pill(_: &Theme) -> container::Style {
    container::Style {
        background: Some(Background::Color(t::BG_2)),
        border: Border {
            color: Color::TRANSPARENT,
            width: 0.0,
            radius: t::R_PILL.into(),
        },
        text_color: Some(t::TEXT_2),
        ..container::Style::default()
    }
}

/// Circular avatar bubble — used for user initials in the topbar.
pub fn avatar(tint: Color) -> impl Fn(&Theme) -> container::Style {
    move |_| container::Style {
        background: Some(Background::Color(tint)),
        border: Border {
            color: Color::TRANSPARENT,
            width: 0.0,
            radius: t::R_PILL.into(),
        },
        text_color: Some(t::BG_0),
        ..container::Style::default()
    }
}

/// Keyboard shortcut chip — `BG_2` background, hairline border, chip radius.
pub fn kbd_chip(_: &Theme) -> container::Style {
    container::Style {
        background: Some(Background::Color(t::BG_2)),
        border: Border {
            color: t::LINE,
            width: 1.0,
            radius: t::R_SM.into(),
        },
        text_color: Some(t::TEXT_2),
        ..container::Style::default()
    }
}

/// Status-bar stat chip — `BG_2` background, pill radius, no border.
pub fn stat_chip(_: &Theme) -> container::Style {
    container::Style {
        background: Some(Background::Color(t::BG_2)),
        border: Border {
            color: Color::TRANSPARENT,
            width: 0.0,
            radius: t::R_PILL.into(),
        },
        text_color: Some(t::TEXT_2),
        ..container::Style::default()
    }
}

/// The terminal area itself — sits on the desktop canvas.
pub fn terminal_surface(_: &Theme) -> container::Style {
    container::Style {
        background: Some(Background::Color(t::BG_0)),
        text_color: Some(t::TEXT_1),
        ..container::Style::default()
    }
}

/// Left sidebar tab (Explorer / Agents / Blocks). Active gets `BG_2`.
pub fn sidebar_tab(active: bool) -> impl Fn(&Theme, button::Status) -> button::Style {
    move |_, status| {
        let hovered = matches!(status, button::Status::Hovered);
        let bg = if active {
            t::BG_2
        } else if hovered {
            t::BG_1
        } else {
            Color::TRANSPARENT
        };
        button::Style {
            background: Some(Background::Color(bg)),
            text_color: if active { t::TEXT_1 } else { t::TEXT_2 },
            border: Border {
                color: Color::TRANSPARENT,
                width: 0.0,
                radius: t::R_MD.into(),
            },
            ..button::Style::default()
        }
    }
}

/// A row in a list (explorer entry, block entry). Selected → `ACCENT_SOFT`
/// with chip radius. Hover nudges to `BG_1` so the list gets a subtle hit
/// target without flashing.
pub fn row_button(selected: bool) -> impl Fn(&Theme, button::Status) -> button::Style {
    move |_, status| {
        let hovered = matches!(status, button::Status::Hovered);
        let bg = if selected {
            t::ACCENT_SOFT
        } else if hovered {
            t::BG_1
        } else {
            Color::TRANSPARENT
        };
        button::Style {
            background: Some(Background::Color(bg)),
            text_color: if selected { t::TEXT_1 } else { t::TEXT_2 },
            border: Border {
                color: Color::TRANSPARENT,
                width: 0.0,
                radius: t::R_SM.into(),
            },
            ..button::Style::default()
        }
    }
}

/// Floating menu popover — `BG_2`, card radius, heavy shadow.
pub fn menu_popover(_: &Theme) -> container::Style {
    container::Style {
        background: Some(Background::Color(t::BG_2)),
        border: Border {
            color: t::LINE,
            width: 1.0,
            radius: t::R_LG.into(),
        },
        text_color: Some(t::TEXT_1),
        shadow: Shadow {
            color: Color::from_rgba(0.0, 0.0, 0.0, 0.35),
            offset: Vector::new(0.0, 4.0),
            blur_radius: 16.0,
        },
        ..container::Style::default()
    }
}

/// Individual row inside a menu popover. Transparent idle, `BG_3` on hover.
pub fn menu_item(_: &Theme, status: button::Status) -> button::Style {
    let hovered = matches!(status, button::Status::Hovered);
    button::Style {
        background: Some(Background::Color(if hovered {
            t::BG_3
        } else {
            Color::TRANSPARENT
        })),
        text_color: t::TEXT_1,
        border: Border {
            color: Color::TRANSPARENT,
            width: 0.0,
            radius: t::R_SM.into(),
        },
        ..button::Style::default()
    }
}

// ── scrollable ───────────────────────────────────────────────────────────

/// Scrollbar — thumb uses `LINE` (brighter on hover), track stays
/// transparent so content breathes.
pub fn scroller(theme: &Theme, status: scrollable::Status) -> scrollable::Style {
    let rail_color = match status {
        scrollable::Status::Hovered { .. } | scrollable::Status::Dragged { .. } => t::TEXT_3,
        _ => t::LINE,
    };
    let rail = scrollable::Rail {
        background: None,
        border: Border {
            color: Color::TRANSPARENT,
            width: 0.0,
            radius: 0.0.into(),
        },
        scroller: scrollable::Scroller {
            background: Background::Color(rail_color),
            border: Border {
                color: Color::TRANSPARENT,
                width: 0.0,
                radius: t::R_SM.into(),
            },
        },
    };
    scrollable::Style {
        container: container::Style::default(),
        vertical_rail: rail,
        horizontal_rail: rail,
        gap: None,
        ..scrollable::default(theme, status)
    }
}
