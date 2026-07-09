use iced::widget::{column, container, row, text, Space};
use iced::{Border, Element, Font, Length};

use crate::{theme, ui::icons, Message};

pub fn view<'a>() -> Element<'a, Message> {
    let logo = text("aura")
        .size(96.0)
        .font(Font::MONOSPACE)
        .style(|_| iced::widget::text::Style { color: Some(theme::TEXT_4) });

    let status = row![
        icons::dot(theme::GREEN, 7.0),
        text("Local Server")
            .size(theme::SZ_BODY)
            .style(|_| iced::widget::text::Style { color: Some(theme::TEXT_3) })
    ]
    .spacing(8.0)
    .align_y(iced::Alignment::Center);

    let open_cta = container(
        row![
            icons::folder(14.0),
            text("Open project")
                .size(13.0)
                .style(|_| iced::widget::text::Style { color: Some(theme::TEXT_1) }),
        ]
        .spacing(8.0)
        .align_y(iced::Alignment::Center),
    )
    .padding([6.0, 12.0])
    .style(|_| {
        iced::widget::container::Style::default()
            .background(theme::BG_2)
            .border(Border {
                radius: 6.0.into(),
                width: 1.0,
                color: theme::LINE,
            })
    });

    let header = row![
        text("Recent projects")
            .size(theme::SZ_BODY)
            .style(|_| iced::widget::text::Style { color: Some(theme::TEXT_1) }),
        Space::new().width(Length::Fill).height(0.0),
        open_cta,
    ]
    .width(Length::Fill)
    .align_y(iced::Alignment::Center);

    let recents = column![
        header,
        Space::new().width(0.0).height(20.0),
        project_row("~/Documents/enricher", "32 minutes ago"),
        project_row("~/Documents/Test-app", "3 months ago"),
    ]
    .width(theme::RECENTS_W);

    container(
        column![
            logo,
            Space::new().width(0.0).height(24.0),
            status,
            Space::new().width(0.0).height(64.0),
            recents,
        ]
        .align_x(iced::Alignment::Center),
    )
    .width(Length::Fill)
    .height(Length::Fill)
    .center_x(Length::Fill)
    .center_y(Length::Fill)
    .into()
}

fn project_row<'a>(path: &'a str, time: &'a str) -> Element<'a, Message> {
    row![
        text(path)
            .size(theme::SZ_BODY)
            .font(Font::MONOSPACE)
            .style(|_| iced::widget::text::Style { color: Some(theme::TEXT_1) }),
        Space::new().width(Length::Fill).height(0.0),
        text(time)
            .size(theme::SZ_META)
            .style(|_| iced::widget::text::Style { color: Some(theme::TEXT_3) }),
    ]
    .width(Length::Fill)
    .padding([8.0, 0.0])
    .align_y(iced::Alignment::Center)
    .into()
}
