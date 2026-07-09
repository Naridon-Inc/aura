use iced::widget::{button, column, container, row, text, Space};
use iced::{Border, Color, Element, Length, Shadow};

use crate::{theme, ui::icons, App, Message};

pub fn view<'a>(_state: &'a App) -> Element<'a, Message> {
    let topbar = settings_topbar();

    let nav = nav_column();

    let content = content_placeholder();

    let divider = container(Space::new().width(Length::Fixed(1.0)).height(Length::Fill))
        .width(Length::Fixed(1.0))
        .height(Length::Fill)
        .style(|_| iced::widget::container::Style::default().background(theme::LINE));

    let top_hairline =
        container(Space::new().width(Length::Fill).height(Length::Fixed(1.0)))
            .width(Length::Fill)
            .height(Length::Fixed(1.0))
            .style(|_| iced::widget::container::Style::default().background(theme::LINE));

    let body: Element<'_, Message> = row![nav, divider, content]
        .width(Length::Fill)
        .height(Length::Fill)
        .into();

    container(column![topbar, top_hairline, body])
        .width(Length::Fill)
        .height(Length::Fill)
        .style(|_| iced::widget::container::Style::default().background(theme::BG_1))
        .into()
}

fn settings_topbar<'a>() -> Element<'a, Message> {
    let close_btn = button(
        container(icons::close_x(14.0))
            .width(Length::Fixed(24.0))
            .height(Length::Fixed(24.0))
            .center_x(Length::Fixed(24.0))
            .center_y(Length::Fixed(24.0)),
    )
    .on_press(Message::CloseSettings)
    .padding(0)
    .style(|_, status| iced::widget::button::Style {
        background: match status {
            iced::widget::button::Status::Hovered => Some(theme::BG_HOVER.into()),
            _ => None,
        },
        text_color: theme::TEXT_2,
        border: Border {
            color: Color::TRANSPARENT,
            width: 0.0,
            radius: theme::R_SM.into(),
        },
        shadow: Shadow::default(),
        snap: false,
    });

    container(
        row![
            Space::new()
                .width(Length::Fixed(theme::MAC_TRAFFIC_LEFT))
                .height(theme::TOPBAR_H),
            text("Settings")
                .font(theme::FONT_SANS_MEDIUM)
                .size(theme::SZ_BODY)
                .style(|_| iced::widget::text::Style {
                    color: Some(theme::TEXT_1),
                }),
            Space::new().width(Length::Fill).height(theme::TOPBAR_H),
            close_btn,
            Space::new()
                .width(Length::Fixed(theme::P_MD))
                .height(theme::TOPBAR_H),
        ]
        .align_y(iced::Alignment::Center),
    )
    .width(Length::Fill)
    .height(theme::TOPBAR_H)
    .style(|_| iced::widget::container::Style::default().background(theme::BG_CHROME))
    .into()
}

fn nav_column<'a>() -> Element<'a, Message> {
    let sections = [
        ("General", true),
        ("Appearance", false),
        ("Plan & Usage", false),
        ("Agents", false),
        ("Tab", false),
        ("Models", false),
        ("Cloud Agents", false),
        ("Plugins", false),
        ("Rules & Skills", false),
        ("Tools & MCPs", false),
        ("Hooks", false),
        ("Indexing", false),
        ("Network", false),
        ("Beta", false),
        ("Docs", false),
    ];

    let mut col = column![].spacing(2.0).padding(theme::P_MD);
    for (label, active) in sections {
        col = col.push(nav_row(label, active));
    }

    container(col)
        .width(Length::Fixed(220.0))
        .height(Length::Fill)
        .style(|_| iced::widget::container::Style::default().background(theme::BG_CHROME))
        .into()
}

fn nav_row<'a>(label: &'a str, active: bool) -> Element<'a, Message> {
    let text_color = if active { theme::TEXT_1 } else { theme::TEXT_2 };
    container(
        text(label)
            .size(theme::SZ_BODY)
            .style(move |_| iced::widget::text::Style {
                color: Some(text_color),
            }),
    )
    .padding(iced::Padding {
        top: 6.0,
        right: 10.0,
        bottom: 6.0,
        left: 10.0,
    })
    .width(Length::Fill)
    .style(move |_| {
        iced::widget::container::Style::default()
            .background(if active { theme::BG_HOVER } else { Color::TRANSPARENT })
            .border(Border {
                color: Color::TRANSPARENT,
                width: 0.0,
                radius: theme::R_SM.into(),
            })
    })
    .into()
}

fn content_placeholder<'a>() -> Element<'a, Message> {
    container(
        column![
            text("General")
                .font(theme::FONT_SANS_MEDIUM)
                .size(theme::SZ_DISPLAY)
                .style(|_| iced::widget::text::Style {
                    color: Some(theme::TEXT_1),
                }),
            Space::new().width(Length::Fill).height(Length::Fixed(theme::P_SM)),
            text("Settings page — wiring in progress.")
                .size(theme::SZ_BODY)
                .style(|_| iced::widget::text::Style {
                    color: Some(theme::TEXT_3),
                }),
            Space::new().width(Length::Fill).height(Length::Fixed(theme::P_LG)),
            text("See docs/plans/settings-screen.md for the full spec.")
                .size(theme::SZ_META)
                .style(|_| iced::widget::text::Style {
                    color: Some(theme::TEXT_4),
                }),
        ]
        .spacing(0.0),
    )
    .width(Length::Fill)
    .height(Length::Fill)
    .padding(iced::Padding {
        top: theme::P_2XL,
        right: theme::P_2XL,
        bottom: theme::P_2XL,
        left: theme::P_2XL,
    })
    .style(|_| iced::widget::container::Style::default().background(theme::BG_0))
    .into()
}
