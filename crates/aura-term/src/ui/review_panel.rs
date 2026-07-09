use iced::widget::{button, column, container, row, scrollable, text, Space};
use iced::{Border, Color, Element, Length, Padding, Shadow};

use crate::{theme, ui::block_card, ui::icons, App, Message};

pub fn view<'a>(state: &'a App) -> Element<'a, Message> {
    let tab_row = tabs_row(state);
    let body: Element<'a, Message> = if state.blocks.is_empty() {
        empty_state()
    } else {
        blocks_stream(state)
    };

    column![tab_row, body]
        .width(Length::Fill)
        .height(Length::Fill)
        .into()
}

fn blocks_stream<'a>(state: &'a App) -> Element<'a, Message> {
    let mut col = column![].spacing(10).padding(Padding::from([10.0, 12.0]));
    for (i, (block, output)) in state.blocks.iter().enumerate() {
        let focused = i == 0;
        col = col.push(block_card::view::<Message>(block, output, focused));
    }
    scrollable(col)
        .width(Length::Fill)
        .height(Length::Fill)
        .into()
}

fn tabs_row<'a>(state: &'a App) -> Element<'a, Message> {
    let count = state.blocks.len();
    let title = if count == 0 {
        "Blocks".to_string()
    } else {
        format!("Blocks · {count}")
    };
    let active_tab = column![
        container(
            text(title)
                .size(theme::SZ_META)
                .style(|_| iced::widget::text::Style { color: Some(theme::TEXT_1) }),
        )
        .padding(iced::Padding { top: 7.0, right: 10.0, bottom: 7.0, left: 10.0 }),
        container(Space::new().width(Length::Fill).height(Length::Fixed(2.0)))
            .width(Length::Fill)
            .height(Length::Fixed(2.0))
            .style(|_| iced::widget::container::Style::default().background(theme::TEXT_1)),
    ]
    .spacing(0.0);

    let new_tab = button(container(icons::plus_sized(14.0)).padding(4.0))
        .on_press(Message::None)
        .padding(0.0)
        .style(ghost_btn_style());

    container(
        row![active_tab, new_tab]
            .spacing(4.0)
            .align_y(iced::Alignment::Center),
    )
    .padding(iced::Padding { top: 6.0, right: 10.0, bottom: 0.0, left: 12.0 })
    .width(Length::Fill)
    .style(|_| iced::widget::container::Style::default().background(theme::BG_CHROME))
    .into()
}

fn empty_state<'a>() -> Element<'a, Message> {
    container(
        column![
            text("No blocks yet")
                .size(theme::SZ_BODY)
                .style(|_| iced::widget::text::Style { color: Some(theme::TEXT_2) }),
            Space::new().width(Length::Fixed(0.0)).height(Length::Fixed(6.0)),
            text("Run a command in the terminal to see it land here")
                .size(theme::SZ_MICRO)
                .style(|_| iced::widget::text::Style { color: Some(theme::TEXT_3) }),
        ]
        .align_x(iced::Alignment::Center),
    )
    .width(Length::Fill)
    .height(Length::Fill)
    .center_x(Length::Fill)
    .center_y(Length::Fill)
    .into()
}


fn ghost_btn_style() -> impl Fn(&iced::Theme, iced::widget::button::Status) -> iced::widget::button::Style {
    |_, status| iced::widget::button::Style {
        background: match status {
            iced::widget::button::Status::Hovered => Some(theme::BG_3.into()),
            _ => None,
        },
        text_color: theme::TEXT_2,
        border: Border {
            color: Color::TRANSPARENT,
            width: 0.0,
            radius: 4.0.into(),
        },
        shadow: Shadow::default(),
        snap: false,
    }
}
