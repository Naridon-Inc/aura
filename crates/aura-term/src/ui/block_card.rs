//! Block card — renders a Block envelope as a stacked card with header,
//! intent, command line, and captured output. Uses aura-proto's theme.

use aura_blocks::{AgentRef, AnchorRef, Block, BlockPayload, BlockState};
use iced::widget::{column, container, row, text, Space};
use iced::{Alignment, Border, Color, Element, Length, Padding};

use crate::theme;

pub fn view<'a, M: 'a>(block: &'a Block, output: &'a [u8], focused: bool) -> Element<'a, M> {
    let state_color = state_color(block.state);
    let failed = matches!(block.state, BlockState::Failed | BlockState::RolledBack);
    let state_label = state_label(block.state);

    // ── header row ────────────────────────────────────────────────────────
    let dot = container(
        Space::new()
            .width(Length::Fixed(7.0))
            .height(Length::Fixed(7.0)),
    )
    .style(move |_| iced::widget::container::Style {
        background: Some(state_color.into()),
        border: Border {
            color: Color::TRANSPARENT,
            width: 0.0,
            radius: 3.5.into(),
        },
        ..Default::default()
    });

    let actor_txt = actor_label(&block.provenance.actor);
    let time_txt = format!("{:02}:{:02}", block.created_at.hour(), block.created_at.minute());
    let secs = (block.updated_at - block.created_at).whole_seconds().max(0);
    let dur_txt = if secs >= 60 {
        format!("{}m{:02}s", secs / 60, secs % 60)
    } else if secs > 0 {
        format!("{secs}s")
    } else {
        "—".into()
    };

    let mut header = row![
        dot,
        Space::new().width(Length::Fixed(8.0)),
        text(state_label)
            .size(theme::SZ_MICRO)
            .font(theme::FONT_SANS_MEDIUM)
            .style(move |_| iced::widget::text::Style { color: Some(state_color) }),
        Space::new().width(Length::Fixed(10.0)),
        text(block.kind.wire().to_string())
            .size(theme::SZ_MICRO)
            .style(|_| iced::widget::text::Style { color: Some(theme::TEXT_3) }),
    ]
    .align_y(Alignment::Center);

    if let Some(anchor) = anchor_label(&block.anchor) {
        header = header.push(Space::new().width(Length::Fixed(10.0)));
        header = header.push(
            text(anchor)
                .size(theme::SZ_MICRO)
                .font(theme::MONO)
                .style(|_| iced::widget::text::Style { color: Some(theme::TEXT_3) }),
        );
    }

    header = header.push(Space::new().width(Length::Fixed(12.0)));
    header = header.push(
        text(actor_txt)
            .size(theme::SZ_META)
            .style(|_| iced::widget::text::Style { color: Some(theme::TEXT_2) }),
    );
    header = header.push(Space::new().width(Length::Fill));
    header = header.push(
        text(time_txt)
            .size(theme::SZ_MICRO)
            .style(|_| iced::widget::text::Style { color: Some(theme::TEXT_3) }),
    );
    header = header.push(Space::new().width(Length::Fixed(8.0)));
    header = header.push(
        text(format!("· {dur_txt}"))
            .size(theme::SZ_MICRO)
            .style(|_| iced::widget::text::Style { color: Some(theme::TEXT_3) }),
    );

    // ── body ──────────────────────────────────────────────────────────────
    let mut body = column![].spacing(6);
    if !block.intent.summary.is_empty() {
        let summary = block.intent.summary.clone();
        body = body.push(
            text(summary)
                .size(theme::SZ_META)
                .style(|_| iced::widget::text::Style { color: Some(theme::TEXT_2) }),
        );
    }
    body = body.push(payload_row(block));
    if !output.is_empty() {
        body = body.push(output_view(output));
    } else if matches!(block.state, BlockState::Running | BlockState::Resumed) {
        body = body.push(running_hint());
    }

    let inner = column![header, body]
        .spacing(10)
        .padding(Padding::from([12.0, 16.0]));

    let border_color = if focused { state_color } else { theme::LINE };
    let bg = if failed { theme::hex(0x2a1818) } else { theme::BG_3 };

    container(inner)
        .width(Length::Fill)
        .style(move |_| iced::widget::container::Style {
            background: Some(bg.into()),
            border: Border {
                color: border_color,
                width: 1.0,
                radius: theme::R_MD.into(),
            },
            ..Default::default()
        })
        .into()
}

fn payload_row<'a, M: 'a>(block: &'a Block) -> Element<'a, M> {
    let (prefix, prefix_color, body_text) = match &block.payload {
        BlockPayload::Command { command, .. } => ("$", theme::ACCENT_GREEN, command.clone()),
        BlockPayload::Proposal { proposed_command, .. } => ("◆", theme::AMBER, proposed_command.clone()),
        BlockPayload::Message { body, .. } => ("›", theme::VIOLET, body.clone()),
        BlockPayload::Sentinel { event_type, .. } => ("◉", theme::VIOLET, format!("sentinel · {event_type}")),
        BlockPayload::ExternalMirror { source, .. } => ("↗", theme::TEXT_3, format!("mirror · {source}")),
        BlockPayload::Impact { function_id, change_kind } => ("⚡", theme::AMBER, format!("{function_id} — {change_kind}")),
        BlockPayload::Zone { zone_id, action } => ("▣", theme::ACCENT_GREEN, format!("{zone_id} {action}")),
        BlockPayload::Build { build_id, status } => ("⬢", theme::ACCENT_GREEN, format!("{build_id} [{status}]")),
        BlockPayload::Skill { skill_name, .. } => ("/", theme::VIOLET, skill_name.clone()),
        BlockPayload::Branch { reason } => ("⎇", theme::TEXT_3, reason.clone()),
    };

    row![
        text(prefix.to_string())
            .size(theme::SZ_BODY)
            .font(theme::MONO_MED)
            .style(move |_| iced::widget::text::Style { color: Some(prefix_color) }),
        Space::new().width(Length::Fixed(10.0)),
        text(body_text)
            .size(theme::SZ_BODY)
            .font(theme::MONO)
            .style(|_| iced::widget::text::Style { color: Some(theme::TEXT_1) }),
    ]
    .align_y(Alignment::Start)
    .into()
}

fn output_view<'a, M: 'a>(output: &[u8]) -> Element<'a, M> {
    // Preserve raw bytes verbatim — no trimming, no line collapsing. The PTY
    // output view renders exactly what the process wrote, whitespace and all.
    let raw = String::from_utf8_lossy(output).into_owned();

    container(
        text(raw)
            .size(theme::SZ_META)
            .font(theme::MONO)
            .style(|_| iced::widget::text::Style { color: Some(theme::TEXT_1) }),
    )
    .width(Length::Fill)
    .padding(Padding::from([8.0, 12.0]))
    .style(|_| iced::widget::container::Style {
        background: Some(theme::BG_0.into()),
        border: Border {
            color: theme::LINE_SOFT,
            width: 1.0,
            radius: theme::R_SM.into(),
        },
        ..Default::default()
    })
    .into()
}

fn running_hint<'a, M: 'a>() -> Element<'a, M> {
    container(
        row![
            container(
                Space::new()
                    .width(Length::Fixed(6.0))
                    .height(Length::Fixed(6.0)),
            )
            .style(|_| iced::widget::container::Style {
                background: Some(theme::AMBER.into()),
                border: Border {
                    color: Color::TRANSPARENT,
                    width: 0.0,
                    radius: 3.0.into(),
                },
                ..Default::default()
            }),
            Space::new().width(Length::Fixed(8.0)),
            text("streaming…")
                .size(theme::SZ_META)
                .font(theme::MONO)
                .style(|_| iced::widget::text::Style { color: Some(theme::TEXT_3) }),
        ]
        .align_y(Alignment::Center),
    )
    .width(Length::Fill)
    .padding(Padding::from([8.0, 12.0]))
    .into()
}

fn anchor_label(anchor: &AnchorRef) -> Option<String> {
    match anchor {
        AnchorRef::Function(name) => Some(format!("▸ {name}")),
        AnchorRef::File(path) => {
            // Keep leaf when too long.
            let raw = format!("▸ {path}");
            if raw.chars().count() <= 48 {
                Some(raw)
            } else {
                let tail = path.rsplit('/').next().unwrap_or(path);
                Some(format!("▸ …{tail}"))
            }
        }
        _ => None,
    }
}

fn actor_label(actor: &AgentRef) -> String {
    // "did:aura:user/local" → "user"; "did:aura:agent/claude-code" → "claude-code"
    let s = actor.0.as_str();
    if let Some(rest) = s.strip_prefix("did:aura:") {
        if let Some((_, name)) = rest.split_once('/') {
            return name.to_string();
        }
        return rest.to_string();
    }
    s.to_string()
}

fn state_color(state: BlockState) -> Color {
    match state {
        BlockState::Proposed => theme::TEXT_3,
        BlockState::Gated => theme::VIOLET,
        BlockState::Denied => theme::RED,
        BlockState::Running | BlockState::Resumed => theme::AMBER,
        BlockState::Suspended => theme::TEXT_3,
        BlockState::Completed => theme::ACCENT_GREEN,
        BlockState::Failed | BlockState::RolledBack => theme::RED,
        BlockState::Superseded => theme::TEXT_3,
    }
}

fn state_label(state: BlockState) -> &'static str {
    match state {
        BlockState::Proposed => "PROPOSED",
        BlockState::Gated => "GATED",
        BlockState::Denied => "DENIED",
        BlockState::Running => "RUNNING",
        BlockState::Resumed => "RESUMED",
        BlockState::Suspended => "SUSPENDED",
        BlockState::Completed => "DONE",
        BlockState::Failed => "FAILED",
        BlockState::RolledBack => "ROLLED BACK",
        BlockState::Superseded => "SUPERSEDED",
    }
}
