//! Reusable UI building blocks — consume only tokens from `theme`.

use iced::widget::{button, container, Space};
use iced::{Border, Color, Element, Length, Shadow};

use crate::{theme, Message};

// ─── Ghost icon button ──────────────────────────────────────────────────────
/// Transparent button with hover-on-BG_HOVER, square, rounded.
pub fn ghost_icon_btn<'a>(
    icon: Element<'a, Message>,
    msg: Message,
) -> iced::widget::Button<'a, Message> {
    button(container(icon).padding(5.0))
        .on_press(msg)
        .padding(0)
        .style(ghost_btn_style)
}

pub fn ghost_btn_style(_: &iced::Theme, status: iced::widget::button::Status) -> iced::widget::button::Style {
    iced::widget::button::Style {
        background: match status {
            iced::widget::button::Status::Hovered => Some(theme::BG_HOVER.into()),
            iced::widget::button::Status::Pressed => Some(theme::BG_HOVER.into()),
            _ => None,
        },
        text_color: theme::TEXT_2,
        border: Border {
            color: Color::TRANSPARENT,
            width: 0.0,
            radius: theme::R_MD.into(),
        },
        shadow: Shadow::default(),
        snap: false,
    }
}

// ─── Outlined card button ───────────────────────────────────────────────────
/// Button with 1px LINE_SOFT border, chrome bg, hover → BG_HOVER.
pub fn outlined_btn_style(_: &iced::Theme, status: iced::widget::button::Status) -> iced::widget::button::Style {
    iced::widget::button::Style {
        background: Some(match status {
            iced::widget::button::Status::Hovered | iced::widget::button::Status::Pressed => theme::BG_HOVER,
            _ => theme::BG_CHROME,
        }.into()),
        text_color: theme::TEXT_1,
        border: Border {
            color: theme::LINE_SOFT,
            width: 1.0,
            radius: theme::R_MD.into(),
        },
        shadow: Shadow::default(),
        snap: false,
    }
}

// ─── Dividers ───────────────────────────────────────────────────────────────
pub fn divider_v<'a>() -> Element<'a, Message> {
    container(Space::new().width(Length::Fixed(1.0)).height(Length::Fill))
        .width(Length::Fixed(1.0))
        .height(Length::Fill)
        .style(|_| iced::widget::container::Style::default().background(theme::LINE_SOFT))
        .into()
}

pub fn divider_h<'a>() -> Element<'a, Message> {
    container(Space::new().width(Length::Fill).height(Length::Fixed(1.0)))
        .width(Length::Fill)
        .height(Length::Fixed(1.0))
        .style(|_| iced::widget::container::Style::default().background(theme::LINE_SOFT))
        .into()
}
