use iced::widget::{button, column, container, stack, text, Space};
use iced::{Border, Color, Element, Length, Shadow};

use crate::{theme, ui::icons, App, Message};

pub fn view<'a>(state: &'a App) -> Element<'a, Message> {
    // Top inset = P_LG so the first workspace tile sits clear of the titlebar,
    // giving the project rail a consistent breathing room against the traffic-
    // lights cluster and the nav rail top seam.
    let mut items = column![Space::new().width(0.0).height(theme::P_LG)]
        .spacing(theme::P_SM)
        .width(Length::Fill)
        .align_x(iced::Alignment::Center);

    for ws in state.workspaces.iter() {
        let is_active = state
            .current_workspace
            .as_ref()
            .map(|cw| cw.id == ws.id)
            .unwrap_or(false);
        items = items.push(workspace_tile(
            ws.id.clone(),
            ws.avatar_letter,
            is_active,
            ws.accent,
        ));
    }

    items = items.push(Space::new().width(0.0).height(2.0));
    items = items.push(
        button(
            container(
                icons::plus_sized(14.0)
                    .width(Length::Fixed(14.0))
                    .height(Length::Fixed(14.0)),
            )
            .width(Length::Fixed(theme::AVATAR_SIZE))
            .height(Length::Fixed(theme::AVATAR_SIZE))
            .center_x(Length::Fixed(theme::AVATAR_SIZE))
            .center_y(Length::Fixed(theme::AVATAR_SIZE)),
        )
        .on_press(Message::OpenFolderDialog)
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
                radius: theme::R_LG.into(),
            },
            shadow: Shadow::default(),
            snap: false,
        }),
    );

    items = items.push(Space::new().width(Length::Shrink).height(Length::Fill));

    items = items.push(user_avatar_tile());
    items = items.push(Space::new().width(0.0).height(theme::P_SM));

    items = items.push(
        button(
            container(
                icons::settings()
                    .width(Length::Fixed(16.0))
                    .height(Length::Fixed(16.0)),
            )
            .width(Length::Fill)
            .height(Length::Fixed(28.0))
            .center_x(Length::Fill)
            .center_y(Length::Fixed(28.0)),
        )
        .on_press(Message::OpenSettings)
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
        }),
    );
    items = items.push(Space::new().width(0.0).height(theme::P_XS));
    items = items.push(
        container(
            icons::help()
                .width(Length::Fixed(16.0))
                .height(Length::Fixed(16.0)),
        )
        .width(Length::Fill)
        .height(Length::Fixed(28.0))
        .center_x(Length::Fill)
        .center_y(Length::Fixed(28.0)),
    );
    items = items.push(Space::new().width(0.0).height(theme::P_SM));

    container(items)
        .width(theme::WORKSPACE_RAIL_W)
        .height(Length::Fill)
        .style(|_| iced::widget::container::Style::default().background(theme::BG_DEEP))
        .into()
}

fn user_avatar_tile<'a>() -> Element<'a, Message> {
    let bg = container(
        icons::user_avatar(theme::AVATAR_SIZE)
            .width(Length::Fixed(theme::AVATAR_SIZE))
            .height(Length::Fixed(theme::AVATAR_SIZE)),
    )
    .width(Length::Fixed(theme::AVATAR_SIZE))
    .height(Length::Fixed(theme::AVATAR_SIZE));

    let letter = container(
        text("M")
            .size(15.0)
            .font(theme::FONT_SANS_MEDIUM)
            .style(|_| iced::widget::text::Style { color: Some(Color::WHITE) }),
    )
    .width(Length::Fixed(theme::AVATAR_SIZE))
    .height(Length::Fixed(theme::AVATAR_SIZE))
    .center_x(Length::Fixed(theme::AVATAR_SIZE))
    .center_y(Length::Fixed(theme::AVATAR_SIZE));

    stack![bg, letter].into()
}

fn workspace_tile<'a>(
    id: String,
    letter: char,
    active: bool,
    accent: Color,
) -> Element<'a, Message> {
    let avatar_btn: iced::widget::Button<'a, Message> = {
        let inner = container(
            text(letter.to_string())
                .size(15.0)
                .font(theme::FONT_SANS_MEDIUM)
                .style(move |_| iced::widget::text::Style {
                    color: Some(if active { theme::AVATAR_FG } else { theme::TEXT_2 }),
                }),
        )
        .width(Length::Fixed(theme::AVATAR_SIZE))
        .height(Length::Fixed(theme::AVATAR_SIZE))
        .center_x(Length::Fixed(theme::AVATAR_SIZE))
        .center_y(Length::Fixed(theme::AVATAR_SIZE));

        let tile_bg = if active {
            Color {
                a: 0.28,
                ..accent
            }
        } else {
            theme::BG_CARD
        };

        button(inner)
            .on_press(Message::OpenProject(id))
            .padding(0)
            .style(move |_, status| iced::widget::button::Style {
                background: Some(
                    match status {
                        iced::widget::button::Status::Hovered if !active => theme::BG_HOVER,
                        _ => tile_bg,
                    }
                    .into(),
                ),
                text_color: theme::TEXT_1,
                border: Border {
                    color: if active { Color::TRANSPARENT } else { theme::LINE_SOFT },
                    width: if active { 0.0 } else { 1.0 },
                    radius: theme::R_LG.into(),
                },
                shadow: Shadow::default(),
                snap: false,
            })
    };

    if active {
        container(avatar_btn)
            .padding(3.0)
            .style(move |_| {
                iced::widget::container::Style::default().border(Border {
                    color: accent,
                    width: 1.5,
                    radius: (theme::R_LG + 3.0).into(),
                })
            })
            .into()
    } else {
        avatar_btn.into()
    }
}
