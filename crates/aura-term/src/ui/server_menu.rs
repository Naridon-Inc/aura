use iced::widget::{button, column, container, row, text, Space};
use iced::{Border, Color, Element, Length, Shadow};

use crate::{theme, ui::icons, Message};

pub fn view<'a>() -> Element<'a, Message> {
    let tabs = row![
        tab("Servers", true),
        tab("MCP", false),
        tab("LSP", false),
        tab("Plugins", false),
    ]
    .spacing(0.0)
    .align_y(iced::Alignment::Center);

    let server_row = container(
        row![
            icons::dot(theme::GREEN, 6.0),
            Space::new().width(Length::Fixed(10.0)).height(0.0),
            column![
                text("Local Server")
                    .size(theme::SZ_META)
                    .style(|_| iced::widget::text::Style { color: Some(theme::TEXT_1) }),
                text("v1.14.20")
                    .size(theme::SZ_MICRO)
                    .style(|_| iced::widget::text::Style { color: Some(theme::TEXT_3) }),
            ]
            .spacing(2.0),
            Space::new().width(Length::Fill).height(0.0),
            text("Ready")
                .size(theme::SZ_MICRO)
                .style(|_| iced::widget::text::Style { color: Some(theme::GREEN) }),
        ]
        .align_y(iced::Alignment::Center),
    )
    .padding([10.0, 12.0])
    .width(Length::Fill)
    .style(|_| {
        iced::widget::container::Style::default().border(Border {
            color: theme::LINE_SOFT,
            width: 0.0,
            radius: 0.0.into(),
        })
    });

    let divider = container(Space::new().width(Length::Fill).height(Length::Fixed(1.0)))
        .width(Length::Fill)
        .height(Length::Fixed(1.0))
        .style(|_| iced::widget::container::Style::default().background(theme::LINE_SOFT));

    let manage_btn = button(
        container(
            text("Manage servers")
                .size(theme::SZ_META)
                .style(|_| iced::widget::text::Style { color: Some(theme::TEXT_1) }),
        )
        .padding([7.0, 10.0])
        .width(Length::Fill)
        .center_x(Length::Fill),
    )
    .on_press(Message::None)
    .padding(0.0)
    .width(Length::Fill)
    .style(|_, status| iced::widget::button::Style {
        background: Some(match status {
            iced::widget::button::Status::Hovered => theme::BG_3.into(),
            _ => theme::BG_2.into(),
        }),
        text_color: theme::TEXT_1,
        border: Border {
            color: theme::LINE,
            width: 1.0,
            radius: 6.0.into(),
        },
        shadow: Shadow::default(),
        snap: false,
    });

    let body = column![
        tabs,
        divider,
        server_row,
        container(manage_btn)
            .padding(iced::Padding { top: 8.0, right: 10.0, bottom: 10.0, left: 10.0 })
            .width(Length::Fill),
    ]
    .spacing(0.0);

    container(body)
        .width(Length::Fixed(280.0))
        .style(|_| {
            iced::widget::container::Style::default()
                .background(theme::BG_2)
                .border(Border {
                    color: theme::LINE,
                    width: 1.0,
                    radius: 8.0.into(),
                })
                .shadow(Shadow {
                    color: Color::from_rgba(0.0, 0.0, 0.0, 0.35),
                    offset: iced::Vector::new(0.0, 4.0),
                    blur_radius: 16.0,
                })
        })
        .into()
}

fn tab<'a>(label: &'a str, active: bool) -> Element<'a, Message> {
    let (txt, border_bottom) = if active {
        (theme::TEXT_1, theme::ACCENT)
    } else {
        (theme::TEXT_3, Color::TRANSPARENT)
    };

    let content = column![
        container(
            text(label.to_string())
                .size(theme::SZ_META)
                .style(move |_| iced::widget::text::Style { color: Some(txt) }),
        )
        .padding([8.0, 12.0]),
        container(Space::new().width(Length::Fill).height(Length::Fixed(2.0)))
            .width(Length::Fill)
            .height(Length::Fixed(2.0))
            .style(move |_| iced::widget::container::Style::default().background(border_bottom)),
    ]
    .spacing(0.0);

    container(content).into()
}
