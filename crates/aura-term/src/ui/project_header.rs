use iced::alignment::Horizontal;
use iced::widget::{button, column, container, row, text, Space};
use iced::{Border, Element, Length, Padding, Shadow};

use crate::{fixtures::Workspace, theme, ui::components, ui::icons, Message};

pub fn view<'a>(ws: &'a Workspace) -> Element<'a, Message> {
    let meta = column![
        text(ws.name.clone())
            .size(theme::SZ_BODY)
            .font(theme::FONT_SANS_MEDIUM)
            .line_height(iced::widget::text::LineHeight::Absolute(iced::Pixels(18.0)))
            .style(|_| iced::widget::text::Style { color: Some(theme::TEXT_1) }),
        Space::new().width(0.0).height(5.0),
        text(ws.path.clone())
            .size(theme::SZ_META)
            .line_height(iced::widget::text::LineHeight::Absolute(iced::Pixels(14.0)))
            .style(|_| iced::widget::text::Style { color: Some(theme::TEXT_3) }),
    ]
    .width(Length::Shrink);

    let ellipsis = components::ghost_icon_btn(icons::more_horizontal().into(), Message::None);

    let header = row![
        container(meta).width(Length::Shrink),
        container(ellipsis)
            .width(Length::Fill)
            .align_x(Horizontal::Right),
    ]
    .align_y(iced::Alignment::Center)
    .width(Length::Fill);

    let new_session_btn = button(
        container(
            row![
                icons::new_session(),
                Space::new().width(Length::Fixed(theme::P_SM)).height(0.0),
                text("New session")
                    .size(theme::SZ_BODY)
                    .style(|_| iced::widget::text::Style { color: Some(theme::TEXT_1) }),
            ]
            .align_y(iced::Alignment::Center),
        )
        .padding(iced::Padding { top: 11.0, right: 12.0, bottom: 11.0, left: 12.0 })
        .width(Length::Fill)
        .center_x(Length::Fill),
    )
    .on_press(Message::NewSession)
    .width(Length::Fill)
    .padding(0)
    .style(|_, status| iced::widget::button::Style {
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
    });

    let body = column![
        header,
        Space::new().width(0.0).height(theme::P_3XL + theme::P_MD),
        new_session_btn,
        Space::new().width(0.0).height(Length::Fill),
    ]
    .width(Length::Fill);

    container(body)
        .padding(Padding {
            top: theme::P_SM,
            right: theme::P_SM,
            bottom: 0.0,
            left: theme::P_SM,
        })
        .width(Length::Fill)
        .into()
}
