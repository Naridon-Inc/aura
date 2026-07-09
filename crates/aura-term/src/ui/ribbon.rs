use iced::widget::{button, container, row, text, Space};
use iced::{Border, Element, Length, Shadow};

use crate::{config, theme, ui::icons, App, Message};

pub fn view<'a>(state: &'a App) -> Element<'a, Message> {
    let dot_sep = || {
        text("·")
            .size(theme::SZ_MICRO)
            .line_height(iced::widget::text::LineHeight::Absolute(iced::Pixels(14.0)))
            .style(|_| iced::widget::text::Style { color: Some(theme::TEXT_4) })
    };

    let version = text("aura v0.12.6")
        .size(theme::SZ_MICRO)
        .line_height(iced::widget::text::LineHeight::Absolute(iced::Pixels(14.0)))
        .style(|_| iced::widget::text::Style { color: Some(theme::TEXT_4) });

    let status_text = text(if state.status.is_empty() {
        "ready".to_string()
    } else {
        state.status.clone()
    })
    .size(theme::SZ_MICRO)
    .line_height(iced::widget::text::LineHeight::Absolute(iced::Pixels(14.0)))
    .style(|_| iced::widget::text::Style { color: Some(theme::TEXT_4) });

    let aura_pill = |label: &'static str, subcmd: &'static str| -> Element<'a, Message> {
        button(
            container(
                text(label)
                    .size(theme::SZ_MICRO)
                    .style(|_| iced::widget::text::Style { color: Some(theme::TEXT_2) }),
            )
            .padding(iced::Padding { top: 2.0, right: 8.0, bottom: 2.0, left: 8.0 }),
        )
        .on_press(Message::RunAura(subcmd))
        .padding(0)
        .style(|_, status| iced::widget::button::Style {
            background: match status {
                iced::widget::button::Status::Hovered
                | iced::widget::button::Status::Pressed => Some(theme::BG_HOVER.into()),
                _ => Some(theme::BG_CARD.into()),
            },
            text_color: theme::TEXT_2,
            border: Border {
                color: theme::LINE,
                width: 1.0,
                radius: theme::R_SM.into(),
            },
            shadow: Shadow::default(),
            snap: false,
        })
        .into()
    };

    let content = row![
        cwd_branch_pill(state),
        Space::new().width(Length::Fixed(theme::P_SM)).height(0.0),
        open_folder_btn(),
        Space::new().width(Length::Fixed(theme::P_MD)).height(0.0),
        version,
        Space::new().width(Length::Fixed(theme::P_SM)).height(0.0),
        dot_sep(),
        Space::new().width(Length::Fixed(theme::P_SM)).height(0.0),
        status_text,
        Space::new().width(Length::Fill).height(0.0),
        aura_pill("status", "status"),
        Space::new().width(Length::Fixed(6.0)).height(0.0),
        aura_pill("messages", "msg list"),
        Space::new().width(Length::Fixed(6.0)).height(0.0),
        aura_pill("zones", "zone list"),
    ]
    .align_y(iced::Alignment::Center);

    container(content)
        .width(Length::Fill)
        .height(theme::RIBBON_H)
        .padding(iced::Padding { top: 0.0, right: theme::P_LG, bottom: 0.0, left: theme::P_LG })
        .align_y(iced::alignment::Vertical::Center)
        .style(|_| iced::widget::container::Style::default().background(theme::BG_DEEP))
        .into()
}

fn cwd_branch_pill<'a>(state: &'a App) -> Element<'a, Message> {
    let cwd_text = config::cwd_label(&state.cwd);
    let cwd_node = text(cwd_text)
        .size(theme::SZ_MICRO)
        .line_height(iced::widget::text::LineHeight::Absolute(iced::Pixels(14.0)))
        .style(|_| iced::widget::text::Style { color: Some(theme::TEXT_2) });

    let inner: Element<'a, Message> = if let Some(branch) = state.git_branch.as_ref() {
        row![
            icons::folder(12.0),
            Space::new().width(Length::Fixed(5.0)).height(0.0),
            cwd_node,
            Space::new().width(Length::Fixed(8.0)).height(0.0),
            text("·")
                .size(theme::SZ_MICRO)
                .style(|_| iced::widget::text::Style { color: Some(theme::TEXT_4) }),
            Space::new().width(Length::Fixed(8.0)).height(0.0),
            icons::git_compare(),
            Space::new().width(Length::Fixed(4.0)).height(0.0),
            text(branch.clone())
                .size(theme::SZ_MICRO)
                .line_height(iced::widget::text::LineHeight::Absolute(iced::Pixels(14.0)))
                .style(|_| iced::widget::text::Style { color: Some(theme::TEXT_2) }),
        ]
        .align_y(iced::Alignment::Center)
        .into()
    } else {
        row![
            icons::folder(12.0),
            Space::new().width(Length::Fixed(5.0)).height(0.0),
            cwd_node,
        ]
        .align_y(iced::Alignment::Center)
        .into()
    };

    container(inner)
        .padding(iced::Padding { top: 2.0, right: 8.0, bottom: 2.0, left: 8.0 })
        .style(|_| {
            iced::widget::container::Style::default()
                .background(theme::BG_CARD)
                .border(Border {
                    color: theme::LINE,
                    width: 1.0,
                    radius: theme::R_SM.into(),
                })
        })
        .into()
}

fn open_folder_btn<'a>() -> Element<'a, Message> {
    button(
        container(
            row![
                icons::folder(12.0),
                Space::new().width(Length::Fixed(5.0)).height(0.0),
                text("Open folder…")
                    .size(theme::SZ_MICRO)
                    .style(|_| iced::widget::text::Style { color: Some(theme::TEXT_2) }),
            ]
            .align_y(iced::Alignment::Center),
        )
        .padding(iced::Padding { top: 2.0, right: 8.0, bottom: 2.0, left: 8.0 }),
    )
    .on_press(Message::OpenFolderDialog)
    .padding(0)
    .style(|_, status| iced::widget::button::Style {
        background: match status {
            iced::widget::button::Status::Hovered
            | iced::widget::button::Status::Pressed => Some(theme::BG_HOVER.into()),
            _ => Some(theme::BG_CARD.into()),
        },
        text_color: theme::TEXT_2,
        border: Border {
            color: theme::LINE,
            width: 1.0,
            radius: theme::R_SM.into(),
        },
        shadow: Shadow::default(),
        snap: false,
    })
    .into()
}
