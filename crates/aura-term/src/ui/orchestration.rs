//! Orchestration grid — a responsive tile grid for multi-agent plans.
//!
//! Each tile represents one agent active in an orchestration run: its role,
//! its current task, status, and last logged intent. The grid is inspired by
//! Warp's AI block tiles but uses Aura's agent theme colors
//! (`AGENT_CLAUDE`, `AGENT_CODEX`, `AGENT_GEMINI`, `AGENT_REVIEW`,
//! `AGENT_SECURITY`, `AGENT_BUILTIN`) as a 4px left accent strip so the
//! caller can tell at a glance which agent owns which lane.
//!
//! Layout:
//!   * up to 3 tiles per row, each `Length::FillPortion(1)`;
//!   * tile height is fixed at 112px so rows line up cleanly;
//!   * when `progress` is `Some`, a 6px bar is drawn across the bottom.
//!
//! This module only exposes [`grid`] and [`empty_state`]. The pane wrapper
//! (`panes::orchestration`) owns the data loading and header chrome.

use aura_blocks::AgentRef;
use iced::widget::{button, column, container, row, text, Space};
use iced::{Alignment, Background, Border, Color, Element, Length, Padding, Theme};

use crate::theme as t;

// ── public types ─────────────────────────────────────────────────────────

/// One agent lane in an orchestration run.
#[derive(Debug, Clone)]
pub struct Tile {
    /// DID of the agent running this lane (e.g. `did:aura:agent/claude-code`).
    pub actor: AgentRef,
    /// Role label, e.g. `"reviewer"`, `"implementer"`, `"security"`.
    pub role: String,
    /// Current task, e.g. `"W3.T4 — apply_op roundtrip"`.
    pub current_task: String,
    /// Lifecycle state of the lane.
    pub status: TileStatus,
    /// Most recent `aura log-intent` summary from this agent, if any.
    pub last_intent: Option<String>,
    /// `0.0..=1.0` — draws a thin progress bar at the bottom of the tile.
    pub progress: Option<f32>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum TileStatus {
    Idle,
    Running,
    Gated,
    /// Explicitly stopped by a policy / pre-commit hook.
    Blocked,
    Completed,
    Failed,
}

// ── public builders ─────────────────────────────────────────────────────

/// Build a responsive grid of up to 3 tiles per row. `on_tile_click` is
/// invoked with the tile's index when a tile is clicked.
pub fn grid<'a, M: 'a + Clone>(
    tiles: &'a [Tile],
    on_tile_click: impl Fn(usize) -> M + 'a,
) -> Element<'a, M> {
    if tiles.is_empty() {
        return empty_state();
    }

    let mut col = column![].spacing(t::P_SM);
    let mut base = 0usize;
    for chunk in tiles.chunks(3) {
        let mut r = row![].spacing(t::P_SM);
        for (offset, tile) in chunk.iter().enumerate() {
            // Running counter is safer than pointer math across slice chunks.
            let idx = base + offset;
            r = r.push(tile_card(tile, on_tile_click(idx)));
        }
        // Pad the final short row so the last tile keeps its width instead of
        // stretching across the whole row.
        for _ in chunk.len()..3 {
            r = r.push(Space::new().width(Length::FillPortion(1)));
        }
        col = col.push(r);
        base += chunk.len();
    }

    container(col)
        .width(Length::Fill)
        .padding(Padding::from([0.0, 0.0]))
        .into()
}

/// Empty-state panel shown when there are zero tiles.
pub fn empty_state<'a, M: 'a>() -> Element<'a, M> {
    column![
        Space::new().height(Length::Fixed(32.0)),
        container(
            text("no agents active")
                .size(t::SZ_BODY)
                .color(t::TEXT_MUTED)
                .font(t::UI_MED),
        )
        .width(Length::Fill)
        .align_x(Alignment::Center),
        Space::new().height(Length::Fixed(4.0)),
        container(
            text("start with: aura orchestrate start <plan>")
                .size(t::SZ_META)
                .color(t::TEXT_DIM)
                .font(t::MONO),
        )
        .width(Length::Fill)
        .align_x(Alignment::Center),
    ]
    .into()
}

// ── tile internals ──────────────────────────────────────────────────────

fn tile_card<'a, M: 'a + Clone>(tile: &'a Tile, on_press: M) -> Element<'a, M> {
    let accent = t::agent_color(&tile.actor).unwrap_or(t::AGENT_BUILTIN);
    let label = t::actor_label(&tile.actor);
    let status_color = status_color(tile.status);
    let status_label = status_label(tile.status);

    // Left agent-accent strip (4px).
    let strip = container(
        Space::new()
            .width(Length::Fixed(4.0))
            .height(Length::Fill),
    )
    .style(super::style::strip(accent));

    // ── header row: agent label · role · status dot+label ───────────────
    let status_dot = container(
        Space::new()
            .width(Length::Fixed(6.0))
            .height(Length::Fixed(6.0)),
    )
    .style(super::style::dot(status_color));

    let header = row![
        text(label).size(t::SZ_META).color(t::TEXT).font(t::UI_MED),
        Space::new().width(Length::Fixed(8.0)),
        text(tile.role.clone())
            .size(t::SZ_TINY)
            .color(t::TEXT_DIM),
        Space::new().width(Length::Fill),
        status_dot,
        Space::new().width(Length::Fixed(6.0)),
        text(status_label)
            .size(t::SZ_MICRO)
            .color(status_color)
            .font(t::UI_MED),
    ]
    .align_y(Alignment::Center);

    // ── current task (truncated 40) ────────────────────────────────────
    let current = truncate(&tile.current_task, 40);
    let current_line = text(current)
        .size(t::SZ_META)
        .color(t::TEXT)
        .font(t::MONO);

    // ── last intent (truncated 60, dim) ────────────────────────────────
    let last_intent: Element<'a, M> = match tile.last_intent.as_deref() {
        Some(s) if !s.is_empty() => text(truncate(s, 60))
            .size(t::SZ_MICRO)
            .color(t::TEXT_DIM)
            .into(),
        _ => text("—").size(t::SZ_MICRO).color(t::TEXT_DIM).into(),
    };

    // ── progress bar (6px) when Some ───────────────────────────────────
    let progress_el: Element<'a, M> = match tile.progress {
        Some(p) => {
            let p = p.clamp(0.0, 1.0);
            let fg_portion = ((p * 1000.0).round() as u16).max(1);
            let bg_portion = (1000u16).saturating_sub(fg_portion).max(1);
            let bar_fg = container(Space::new().height(Length::Fixed(6.0)))
                .width(Length::FillPortion(fg_portion))
                .style(progress_fg);
            let bar_bg = container(Space::new().height(Length::Fixed(6.0)))
                .width(Length::FillPortion(bg_portion))
                .style(progress_bg);
            container(
                row![bar_fg, bar_bg]
                    .height(Length::Fixed(6.0))
                    .align_y(Alignment::Center),
            )
            .width(Length::Fill)
            .into()
        }
        None => Space::new().height(Length::Fixed(6.0)).into(),
    };

    let body = column![
        header,
        Space::new().height(Length::Fixed(t::P_SM)),
        current_line,
        Space::new().height(Length::Fixed(t::P_XS)),
        last_intent,
        Space::new().height(Length::Fill),
        progress_el,
    ]
    .spacing(0)
    .padding(Padding::from([t::P_MD, t::P_MD]));

    let inner = row![strip, container(body).width(Length::Fill)]
        .align_y(Alignment::Start)
        .height(Length::Fixed(112.0));

    // Wrap in a button so clicks dispatch on_press; the button itself uses
    // local styling to render BG_2 idle / BG_3 hover with a card-like border.
    button(inner)
        .padding(0)
        .on_press(on_press)
        .style(tile_button)
        .width(Length::FillPortion(1))
        .height(Length::Fixed(112.0))
        .into()
}

// ── local styles (tile-scoped; do not pollute style.rs) ──────────────────

fn tile_button(_: &Theme, status: iced::widget::button::Status) -> iced::widget::button::Style {
    let hovered = matches!(status, iced::widget::button::Status::Hovered);
    let pressed = matches!(status, iced::widget::button::Status::Pressed);
    let bg = if hovered || pressed { t::BG_3 } else { t::BG_2 };
    iced::widget::button::Style {
        background: Some(Background::Color(bg)),
        text_color: t::TEXT,
        border: Border {
            color: t::LINE,
            width: 1.0,
            radius: t::R_LG.into(),
        },
        ..iced::widget::button::Style::default()
    }
}

fn progress_fg(_: &Theme) -> container::Style {
    container::Style {
        background: Some(Background::Color(t::ACCENT)),
        border: Border {
            color: Color::TRANSPARENT,
            width: 0.0,
            radius: 4.0.into(),
        },
        ..container::Style::default()
    }
}

fn progress_bg(_: &Theme) -> container::Style {
    container::Style {
        background: Some(Background::Color(t::LINE_SOFT)),
        border: Border {
            color: Color::TRANSPARENT,
            width: 0.0,
            radius: 4.0.into(),
        },
        ..container::Style::default()
    }
}

// ── helpers ─────────────────────────────────────────────────────────────

fn status_color(status: TileStatus) -> Color {
    match status {
        TileStatus::Idle => t::TEXT_DIM,
        TileStatus::Running => t::S_RUNNING,
        TileStatus::Gated => t::S_GATED,
        TileStatus::Blocked => t::S_DENIED,
        TileStatus::Completed => t::S_COMPLETED,
        TileStatus::Failed => t::S_FAILED,
    }
}

fn status_label(status: TileStatus) -> &'static str {
    match status {
        TileStatus::Idle => "idle",
        TileStatus::Running => "running",
        TileStatus::Gated => "gated",
        TileStatus::Blocked => "blocked",
        TileStatus::Completed => "done",
        TileStatus::Failed => "failed",
    }
}

fn truncate(s: &str, n: usize) -> String {
    let first = s.lines().next().unwrap_or("");
    // Clip on char boundaries — slicing on bytes would panic on multi-byte
    // scalars (emoji, accented role names).
    if first.chars().count() > n {
        let limit = n.saturating_sub(1);
        let mut out: String = first.chars().take(limit).collect();
        out.push('…');
        out
    } else {
        first.to_string()
    }
}

// ── tests ───────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;

    fn sample(actor: &str, status: TileStatus) -> Tile {
        Tile {
            actor: AgentRef(actor.to_string()),
            role: "implementer".into(),
            current_task: "W1.T1 — do a thing".into(),
            status,
            last_intent: Some("did the thing".into()),
            progress: Some(0.5),
        }
    }

    #[test]
    fn grid_builds_with_three_tiles() {
        let tiles = vec![
            sample("did:aura:agent/claude-code", TileStatus::Running),
            sample("did:aura:agent/codex", TileStatus::Idle),
            sample("did:aura:agent/gemini", TileStatus::Completed),
        ];
        // The returned element is `Element<'a, ()>` — asserting this compiles
        // is the whole point of the test.
        let _el: Element<'_, ()> = grid::<()>(&tiles, |_| ());
    }

    #[test]
    fn empty_state_builds() {
        let _el: Element<'_, ()> = empty_state::<()>();
    }

    #[test]
    fn status_maps_to_color() {
        // Every variant of TileStatus must yield a Color from the theme —
        // the match is exhaustive so adding a variant without a color would
        // fail to compile.
        for s in [
            TileStatus::Idle,
            TileStatus::Running,
            TileStatus::Gated,
            TileStatus::Blocked,
            TileStatus::Completed,
            TileStatus::Failed,
        ] {
            let c: Color = status_color(s);
            // Sanity: alpha should be 1.0 for every theme color we route
            // through. This guards against a future refactor that injects
            // a transparent color by accident.
            assert!((c.a - 1.0).abs() < f32::EPSILON, "alpha != 1 for {:?}", s);
        }
    }

    #[test]
    fn truncate_respects_char_boundaries() {
        assert_eq!(truncate("hello", 10), "hello");
        assert_eq!(truncate("abcdefghij", 5), "abcd…");
    }
}
