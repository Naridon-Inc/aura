use iced::widget::{column, container, row, scrollable, text, text_input, Space};
use iced::{Border, Color, Element, Length};

use crate::{
    fixtures::{mock_search_hits, SearchHit},
    theme,
    ui::icons,
    App, Message, SIDEBAR_SEARCH_INPUT_ID,
};

pub fn view<'a>(state: &'a App) -> Element<'a, Message> {
    let input = text_input("Search in enricher", &state.sidebar_search_query)
        .id(SIDEBAR_SEARCH_INPUT_ID.clone())
        .on_input(Message::SidebarSearchInput)
        .size(theme::SZ_META)
        .padding(iced::Padding { top: 0.0, right: 0.0, bottom: 0.0, left: 0.0 })
        .style(|_, _status| iced::widget::text_input::Style {
            background: Color::TRANSPARENT.into(),
            border: Border {
                color: Color::TRANSPARENT,
                width: 0.0,
                radius: 0.0.into(),
            },
            icon: theme::TEXT_3,
            placeholder: theme::TEXT_3,
            value: theme::TEXT_1,
            selection: theme::LINE,
        });

    let search_box = container(
        row![
            icons::search(),
            Space::new().width(Length::Fixed(8.0)).height(0.0),
            container(input).width(Length::Fill),
        ]
        .align_y(iced::Alignment::Center),
    )
    .padding(iced::Padding { top: 6.0, right: 8.0, bottom: 6.0, left: 10.0 })
    .style(|_| {
        iced::widget::container::Style::default()
            .background(theme::BG_CARD)
            .border(Border {
                color: theme::LINE,
                width: 1.0,
                radius: theme::R_MD.into(),
            })
    });

    let search_wrap = container(search_box)
        .padding(iced::Padding { top: 0.0, right: theme::P_MD, bottom: theme::P_SM, left: theme::P_MD })
        .width(Length::Fill);

    let results: Element<'a, Message> = if state.sidebar_search_query.trim().is_empty() {
        container(
            text("Start typing to search files and symbols")
                .size(theme::SZ_MICRO)
                .style(|_| iced::widget::text::Style { color: Some(theme::TEXT_3) }),
        )
        .padding(iced::Padding {
            top: theme::P_MD,
            right: theme::P_MD,
            bottom: theme::P_MD,
            left: theme::P_MD,
        })
        .width(Length::Fill)
        .into()
    } else {
        let hits = mock_search_hits(&state.sidebar_search_query);
        if hits.is_empty() {
            container(
                text("No results")
                    .size(theme::SZ_MICRO)
                    .style(|_| iced::widget::text::Style { color: Some(theme::TEXT_3) }),
            )
            .padding(theme::P_MD)
            .width(Length::Fill)
            .into()
        } else {
            let mut col = column![].spacing(0.0);
            for h in hits {
                col = col.push(hit_row(h));
            }
            col.width(Length::Fill).into()
        }
    };

    let body = column![search_wrap, results].width(Length::Fill);
    scrollable(body).width(Length::Fill).height(Length::Fill).into()
}

fn hit_row<'a>(h: SearchHit) -> Element<'a, Message> {
    let file = text(h.file)
        .size(theme::SZ_META)
        .style(|_| iced::widget::text::Style { color: Some(theme::TEXT_1) });

    let line = text(format!(":{}", h.line))
        .size(theme::SZ_MICRO)
        .style(|_| iced::widget::text::Style { color: Some(theme::TEXT_3) });

    let snippet = text(h.snippet)
        .size(theme::SZ_MICRO)
        .font(iced::Font::MONOSPACE)
        .style(|_| iced::widget::text::Style { color: Some(theme::TEXT_2) });

    let col = column![
        row![file, Space::new().width(Length::Fixed(4.0)).height(0.0), line]
            .align_y(iced::Alignment::Center),
        Space::new().width(0.0).height(Length::Fixed(4.0)),
        snippet,
    ]
    .spacing(0.0);

    container(col)
        .width(Length::Fill)
        .padding(iced::Padding {
            top: 8.0,
            right: theme::P_MD,
            bottom: 8.0,
            left: theme::P_MD,
        })
        .into()
}
