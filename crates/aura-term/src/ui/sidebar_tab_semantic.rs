use iced::widget::{column, container, row, scrollable, text, Space};
use iced::{Border, Element, Length};

use crate::{
    fixtures::{mock_semantic_nodes, IntentStatus, SemKind, SemNode},
    theme,
    ui::icons,
    App, Message,
};

pub fn view<'a>(_state: &'a App) -> Element<'a, Message> {
    let nodes = mock_semantic_nodes();

    let mut grouped: Vec<(String, Vec<SemNode>)> = Vec::new();
    for n in nodes {
        if let Some((_, v)) = grouped.iter_mut().find(|(f, _)| *f == n.file) {
            v.push(n);
        } else {
            grouped.push((n.file.clone(), vec![n]));
        }
    }

    let mut col = column![].spacing(0.0);
    for (file, group) in grouped {
        col = col.push(file_header(file));
        for n in group {
            col = col.push(node_row(n));
        }
        col = col.push(Space::new().width(0.0).height(Length::Fixed(6.0)));
    }

    scrollable(col).width(Length::Fill).height(Length::Fill).into()
}

fn file_header<'a>(file: String) -> Element<'a, Message> {
    container(
        text(file)
            .size(theme::SZ_MICRO)
            .style(|_| iced::widget::text::Style { color: Some(theme::TEXT_3) }),
    )
    .padding(iced::Padding {
        top: 8.0,
        right: theme::P_MD,
        bottom: 4.0,
        left: theme::P_MD,
    })
    .width(Length::Fill)
    .into()
}

fn node_row<'a>(n: SemNode) -> Element<'a, Message> {
    let dot_color = match n.status {
        IntentStatus::Tracked => theme::ACCENT,
        IntentStatus::Dirty => theme::AMBER,
        IntentStatus::Missing => theme::RED,
    };

    let dot_holder = container(icons::dot::<Message>(dot_color, 6.0))
        .width(Length::Fixed(10.0))
        .height(Length::Fixed(10.0))
        .center_x(Length::Fixed(10.0))
        .center_y(Length::Fixed(10.0));

    let badge_label = match n.kind {
        SemKind::Fn => "fn",
        SemKind::Struct => "st",
        SemKind::Impl => "im",
        SemKind::Enum => "en",
    };

    let badge = container(
        text(badge_label)
            .size(theme::SZ_MICRO)
            .style(|_| iced::widget::text::Style { color: Some(theme::TEXT_3) }),
    )
    .padding(iced::Padding { top: 2.0, right: 5.0, bottom: 2.0, left: 5.0 })
    .style(|_| {
        iced::widget::container::Style::default()
            .background(theme::BG_CARD)
            .border(Border {
                color: theme::LINE_SOFT,
                width: 1.0,
                radius: theme::R_XS.into(),
            })
    });

    let name = text(n.name)
        .size(theme::SZ_META)
        .style(|_| iced::widget::text::Style { color: Some(theme::TEXT_1) });

    container(
        row![
            dot_holder,
            Space::new().width(Length::Fixed(8.0)).height(0.0),
            badge,
            Space::new().width(Length::Fixed(8.0)).height(0.0),
            name,
        ]
        .align_y(iced::Alignment::Center),
    )
    .width(Length::Fill)
    .padding(iced::Padding {
        top: 5.0,
        right: theme::P_MD,
        bottom: 5.0,
        left: theme::P_MD + 6.0,
    })
    .into()
}
