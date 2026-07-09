use iced::widget::{column, container, row, scrollable, stack, text, Space};
use iced::{Color, Element, Length};

use crate::{
    fixtures::{mock_team_members, mock_zone_claims, TeamMember, ZoneClaim},
    theme,
    ui::{components, icons},
    App, Message,
};

pub fn view<'a>(_state: &'a App) -> Element<'a, Message> {
    let members_header = section_header("Team");
    let mut members_col = column![members_header].spacing(0.0);
    for m in mock_team_members() {
        members_col = members_col.push(member_row(m));
    }

    let zones_header = section_header("Zone claims");
    let mut zones_col = column![zones_header].spacing(0.0);
    for z in mock_zone_claims() {
        zones_col = zones_col.push(zone_row(z));
    }

    let body = column![
        members_col,
        Space::new().width(0.0).height(Length::Fixed(theme::P_SM)),
        components::divider_h(),
        zones_col,
    ];

    scrollable(body).width(Length::Fill).height(Length::Fill).into()
}

fn section_header<'a>(label: &'a str) -> Element<'a, Message> {
    container(
        text(label)
            .size(theme::SZ_MICRO)
            .style(|_| iced::widget::text::Style { color: Some(theme::TEXT_3) }),
    )
    .padding(iced::Padding {
        top: 10.0,
        right: theme::P_MD,
        bottom: 4.0,
        left: theme::P_MD,
    })
    .width(Length::Fill)
    .into()
}

fn member_row<'a>(m: TeamMember) -> Element<'a, Message> {
    let avatar = avatar_square(m.avatar_letter, m.accent, 24.0);

    let name = text(m.name)
        .size(theme::SZ_META)
        .style(|_| iced::widget::text::Style { color: Some(theme::TEXT_1) });

    let status_text = m
        .editing
        .as_ref()
        .map(|f| format!("editing {}", f))
        .unwrap_or_else(|| "idle".to_string());
    let status_color = if m.editing.is_some() { theme::ACCENT } else { theme::TEXT_4 };

    let status_dot = container(icons::dot::<Message>(status_color, 5.0))
        .width(Length::Fixed(8.0))
        .height(Length::Fixed(8.0))
        .center_x(Length::Fixed(8.0))
        .center_y(Length::Fixed(8.0));

    let status = row![
        status_dot,
        Space::new().width(Length::Fixed(6.0)).height(0.0),
        text(status_text)
            .size(theme::SZ_MICRO)
            .style(|_| iced::widget::text::Style { color: Some(theme::TEXT_3) }),
    ]
    .align_y(iced::Alignment::Center);

    let info = column![
        name,
        Space::new().width(0.0).height(Length::Fixed(2.0)),
        status,
    ]
    .spacing(0.0);

    container(
        row![
            avatar,
            Space::new().width(Length::Fixed(10.0)).height(0.0),
            info,
        ]
        .align_y(iced::Alignment::Center),
    )
    .width(Length::Fill)
    .padding(iced::Padding {
        top: 8.0,
        right: theme::P_MD,
        bottom: 8.0,
        left: theme::P_MD,
    })
    .into()
}

fn zone_row<'a>(z: ZoneClaim) -> Element<'a, Message> {
    let badge = avatar_square(z.owner_initial, z.owner_accent, 16.0);

    let file = text(z.file)
        .size(theme::SZ_META)
        .style(|_| iced::widget::text::Style { color: Some(theme::TEXT_1) });

    let expires = text(z.expires_in)
        .size(theme::SZ_MICRO)
        .style(|_| iced::widget::text::Style { color: Some(theme::TEXT_3) });

    container(
        row![
            badge,
            Space::new().width(Length::Fixed(8.0)).height(0.0),
            container(file).width(Length::Fill),
            expires,
        ]
        .align_y(iced::Alignment::Center),
    )
    .width(Length::Fill)
    .padding(iced::Padding {
        top: 6.0,
        right: theme::P_MD,
        bottom: 6.0,
        left: theme::P_MD,
    })
    .into()
}

fn avatar_square<'a>(letter: char, accent: Color, size: f32) -> Element<'a, Message> {
    let bg = icons::agent_square::<Message>(Color { a: 0.28, ..accent }, size);
    let letter_text = container(
        text(letter.to_string())
            .size((size * 0.6).max(9.0))
            .font(theme::FONT_SANS_MEDIUM)
            .style(move |_| iced::widget::text::Style { color: Some(accent) }),
    )
    .width(Length::Fixed(size))
    .height(Length::Fixed(size))
    .center_x(Length::Fixed(size))
    .center_y(Length::Fixed(size));

    stack![bg, letter_text].into()
}
