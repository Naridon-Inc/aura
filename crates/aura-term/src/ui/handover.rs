//! `⌘H` handover modal — surfaces the dense XML payload produced by
//! `aura handover` so the user can paste it into a fresh Claude Code session
//! without manually re-running the CLI.
//!
//! This module is pure UI + pure state. It does NOT spawn the `aura handover`
//! subprocess, does NOT talk to the clipboard, and does NOT own a keybind.
//! All of that is wired upstream in `app.rs`:
//!
//!   * `⌘H` pressed  → app dispatches [`Action::Open`], runs `aura handover`
//!                    async, then calls [`State::set_payload`] with the
//!                    captured stdout (or [`State::set_error`] on failure).
//!   * Close button  → app observes [`Action::Close`], calls [`State::close`].
//!   * Copy button   → app observes [`Action::Copy`], writes `state.payload`
//!                    to the system clipboard via `iced::clipboard::write`.
//!
//! The `view` function returns `Option<Element<'_, M>>` so the caller can
//! skip mounting the overlay entirely when the modal is closed:
//!
//! ```ignore
//! if let Some(overlay) = handover::view(&self.handover, Message::Handover) {
//!     stack![main, overlay].into()
//! } else {
//!     main.into()
//! }
//! ```

use iced::widget::{button, column, container, mouse_area, row, scrollable, text, Space, Stack};
use iced::{
    Alignment, Background, Border, Color, Element, Length, Padding, Shadow, Theme, Vector,
};

use crate::ui::icon::{self, Icon};
use crate::ui::style;
use crate::theme as t;

// ── state ────────────────────────────────────────────────────────────────

/// UI state for the handover modal. Owned by `App`.
///
/// `payload` holds the last captured `aura handover` stdout; it is emptied
/// every time the modal is re-opened so the user never sees a stale payload
/// while the subprocess is still running.
#[derive(Debug, Clone, Default)]
pub struct State {
    /// Whether the modal is currently mounted.
    pub open: bool,
    /// The XML-ish payload produced by `aura handover`. Empty means we are
    /// either not yet opened, or the subprocess has not yet finished.
    pub payload: String,
    /// Non-`None` when the last `aura handover` attempt failed; rendered in
    /// red above the payload area.
    pub error: Option<String>,
}

impl State {
    /// Open the modal in its loading state. Clears any previous payload and
    /// error so the user sees the "Generating payload…" placeholder while
    /// the app re-runs `aura handover` in the background.
    pub fn open_empty(&mut self) {
        self.open = true;
        self.payload.clear();
        self.error = None;
    }

    /// Close the modal. The payload is retained so the next open can start
    /// empty explicitly — see [`Self::open_empty`].
    pub fn close(&mut self) {
        self.open = false;
    }

    /// Fill the payload and clear any error. Called by the app once the
    /// `aura handover` subprocess completes successfully.
    pub fn set_payload(&mut self, xml: String) {
        self.payload = xml;
        self.error = None;
    }

    /// Record an error from the `aura handover` subprocess. The modal stays
    /// open so the user can read the message.
    pub fn set_error(&mut self, msg: String) {
        self.error = Some(msg);
    }
}

// ── actions ──────────────────────────────────────────────────────────────

/// Outbound actions this view emits. The app maps each variant into its own
/// `Message` type via the `on_action` callback passed to [`view`].
#[derive(Debug, Clone)]
pub enum Action {
    /// ⌘H was pressed (dispatched from the app's global keybind, not from
    /// inside this view). Listed here so the app has a single enum to
    /// pattern-match against.
    Open,
    /// User clicked Close, the × icon, hit Esc, or clicked the backdrop.
    Close,
    /// User clicked Copy. The app owns the clipboard write.
    Copy,
}

// ── view ─────────────────────────────────────────────────────────────────

/// Returns the overlay element when the modal is open, or `None` when it is
/// closed (letting the caller skip the overlay entirely).
///
/// `on_action` maps a handover [`Action`] into the caller's own `Message`
/// type. The view itself only emits [`Action::Close`] and [`Action::Copy`];
/// [`Action::Open`] is dispatched by the app's keybind layer.
pub fn view<'a, M: 'a + Clone>(
    state: &'a State,
    on_action: impl Fn(Action) -> M + 'a,
) -> Option<Element<'a, M>> {
    if !state.open {
        return None;
    }

    let close_msg = on_action(Action::Close);
    let copy_msg = on_action(Action::Copy);

    // ── header ──────────────────────────────────────────────────────────
    let title = text("Handover context")
        .size(t::SZ_TITLE)
        .font(t::UI_MED)
        .color(t::TEXT);

    let close_x = button(icon::svg_colored(Icon::X, t::SZ_ICON, t::TEXT_MUTED))
        .padding(Padding::from([t::P_XS, t::P_XS]))
        .style(style::icon_button)
        .on_press(close_msg.clone());

    let header = row![
        title,
        Space::new().width(Length::Fill),
        close_x,
    ]
    .align_y(Alignment::Center);

    // ── body: scrollable payload, or placeholder / error ────────────────
    let body_inner: Element<'a, M> = if let Some(err) = &state.error {
        // Error: red line above, then payload if we happen to have one.
        let err_line = text(err.clone())
            .size(t::SZ_META)
            .color(t::RED)
            .font(t::UI);
        if state.payload.is_empty() {
            column![err_line].spacing(t::P_SM).into()
        } else {
            let payload = text(state.payload.clone())
                .size(t::SZ_META)
                .color(t::TEXT)
                .font(t::MONO);
            column![err_line, payload].spacing(t::P_SM).into()
        }
    } else if state.payload.is_empty() {
        text("Generating payload…")
            .size(t::SZ_BODY)
            .color(t::TEXT_DIM)
            .font(t::UI)
            .into()
    } else {
        text(state.payload.clone())
            .size(t::SZ_META)
            .color(t::TEXT)
            .font(t::MONO)
            .into()
    };

    let payload_box = container(
        scrollable(
            container(body_inner)
                .padding(Padding::from([t::P_MD, t::P_MD]))
                .width(Length::Fill),
        )
        .height(Length::Fill)
        .style(style::scroller),
    )
    .width(Length::Fixed(640.0))
    .height(Length::Fixed(360.0))
    .style(payload_surface_style);

    // ── footer ──────────────────────────────────────────────────────────
    let hint = text("Paste this payload into a new Claude Code session.")
        .size(t::SZ_META)
        .color(t::TEXT_MUTED)
        .font(t::UI);

    // "Copy" is disabled while the payload is empty — use `on_press_maybe`
    // so we keep the same styled widget regardless of state.
    let copy_on_press: Option<M> = if state.payload.is_empty() {
        None
    } else {
        Some(copy_msg)
    };
    let copy_btn = button(
        text("Copy")
            .size(t::SZ_BODY)
            .font(t::UI_MED)
            .color(t::BG_0),
    )
    .padding(Padding::from([t::P_SM, t::P_LG]))
    .style(primary_button_style)
    .on_press_maybe(copy_on_press);

    let close_btn = button(
        text("Close")
            .size(t::SZ_BODY)
            .font(t::UI_MED)
            .color(t::TEXT_MUTED),
    )
    .padding(Padding::from([t::P_SM, t::P_LG]))
    .style(secondary_button_style)
    .on_press(close_msg.clone());

    let footer = row![
        hint,
        Space::new().width(Length::Fill),
        close_btn,
        Space::new().width(Length::Fixed(t::P_SM)),
        copy_btn,
    ]
    .align_y(Alignment::Center);

    // ── card ────────────────────────────────────────────────────────────
    let card_body = column![
        header,
        Space::new().height(Length::Fixed(t::P_MD)),
        payload_box,
        Space::new().height(Length::Fixed(t::P_MD)),
        footer,
    ];

    let card = container(card_body)
        .width(Length::Fixed(720.0))
        .height(Length::Fixed(520.0))
        .padding(Padding::from([t::P_XL, t::P_XL]))
        .style(card_style);

    // ── backdrop (click-to-dismiss) ─────────────────────────────────────
    let backdrop = mouse_area(
        container(Space::new().width(Length::Fill).height(Length::Fill))
            .width(Length::Fill)
            .height(Length::Fill)
            .style(backdrop_style),
    )
    .on_press(close_msg);

    // ── assembled overlay: backdrop + centered card ─────────────────────
    // Center the card by wrapping it in a full-fill container whose content
    // alignment is center on both axes. The backdrop sits underneath in a
    // `stack!` so clicks outside the card still fall through to it.
    let centered_card = container(card)
        .width(Length::Fill)
        .height(Length::Fill)
        .align_x(Alignment::Center)
        .align_y(Alignment::Center);

    // Build the stack by hand — the `iced::widget::stack!` macro isn't
    // re-exported by the `iced` facade in 0.14, and we don't want to pull
    // `iced_widget` in as a direct dep for one call site. `Stack` renders
    // children in insertion order, so the backdrop (first) sits under the
    // centered card (second).
    let overlay = Stack::new().push(backdrop).push(centered_card);

    Some(
        container(overlay)
            .width(Length::Fill)
            .height(Length::Fill)
            .into(),
    )
}

// ── local style fns ──────────────────────────────────────────────────────
//
// Kept local on purpose — style.rs is frozen while the design system
// stabilises. If any of these prove reusable, lift them in a later wave.

/// Full-bleed semi-transparent dim under the card.
fn backdrop_style(_: &Theme) -> container::Style {
    container::Style {
        background: Some(Background::Color(t::with_alpha(t::BG_0, 0.55))),
        ..container::Style::default()
    }
}

/// The card itself — BG_2, hairline border, R_LG, and a drop shadow so it
/// reads as floating over the backdrop.
fn card_style(_: &Theme) -> container::Style {
    container::Style {
        background: Some(Background::Color(t::BG_2)),
        border: Border {
            color: t::LINE,
            width: 1.0,
            radius: t::R_LG.into(),
        },
        text_color: Some(t::TEXT),
        shadow: Shadow {
            color: Color::from_rgba(0.0, 0.0, 0.0, 0.35),
            offset: Vector::new(0.0, 8.0),
            blur_radius: 24.0,
        },
        ..container::Style::default()
    }
}

/// Background for the scrollable payload area — a small step darker than the
/// card so the mono text sits in its own "well".
fn payload_surface_style(_: &Theme) -> container::Style {
    container::Style {
        background: Some(Background::Color(t::BG_1)),
        border: Border {
            color: t::LINE,
            width: 1.0,
            radius: t::R_SM.into(),
        },
        text_color: Some(t::TEXT),
        ..container::Style::default()
    }
}

/// Primary "Copy" button — accent teal, `BG_0` text so it reads on the
/// saturated ground. Darkens a notch on hover. Disabled state greys out the
/// background to `ACCENT_SOFT`.
fn primary_button_style(_: &Theme, status: button::Status) -> button::Style {
    let hovered = matches!(status, button::Status::Hovered);
    let disabled = matches!(status, button::Status::Disabled);
    let (bg, fg) = if disabled {
        (t::ACCENT_SOFT, t::TEXT_DIM)
    } else if hovered {
        // A slightly deeper tint on hover — mix ACCENT toward BG_0.
        let a = t::ACCENT;
        let mixed = Color {
            r: a.r * 0.88,
            g: a.g * 0.88,
            b: a.b * 0.88,
            a: 1.0,
        };
        (mixed, t::BG_0)
    } else {
        (t::ACCENT, t::BG_0)
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

/// Secondary "Close" button — transparent with a subtle border that brightens
/// on hover. Mirrors the low-emphasis action pattern but with a visible
/// hairline so it reads as a button (not a link) next to the primary.
fn secondary_button_style(_: &Theme, status: button::Status) -> button::Style {
    let hovered = matches!(status, button::Status::Hovered);
    let pressed = matches!(status, button::Status::Pressed);
    let bg = if hovered || pressed {
        t::BG_3
    } else {
        t::BG_2
    };
    let fg = if hovered || pressed {
        t::TEXT
    } else {
        t::TEXT_MUTED
    };
    button::Style {
        background: Some(Background::Color(bg)),
        text_color: fg,
        border: Border {
            color: t::LINE,
            width: 1.0,
            radius: t::R_MD.into(),
        },
        ..button::Style::default()
    }
}

// ── tests ────────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn state_round_trips() {
        let mut s = State::default();
        assert!(!s.open);
        assert!(s.payload.is_empty());
        assert!(s.error.is_none());

        s.open_empty();
        assert!(s.open);
        assert!(s.payload.is_empty());

        s.set_payload("x".into());
        assert_eq!(s.payload, "x");

        s.close();
        assert!(!s.open);
    }

    #[test]
    fn view_is_none_when_closed() {
        assert!(view::<()>(&State::default(), |_| ()).is_none());
    }

    #[test]
    fn view_is_some_when_open() {
        let mut s = State::default();
        s.open_empty();
        assert!(view::<()>(&s, |_| ()).is_some());
    }

    #[test]
    fn set_error_surfaces() {
        let mut s = State::default();
        s.set_error("boom".into());
        assert_eq!(s.error.as_deref(), Some("boom"));
    }
}
