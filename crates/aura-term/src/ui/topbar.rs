use iced::widget::{button, container, mouse_area, row, stack, text, text_input, Space};
use iced::{Border, Color, Element, Length, Shadow};

use crate::{theme, ui::components, ui::icons, App, Message, SEARCH_INPUT_ID};

pub fn view<'a>(state: &'a App) -> Element<'a, Message> {
    let toggle = components::ghost_icon_btn(icons::sidebar().into(), Message::ToggleSidebar);
    let back_btn = components::ghost_icon_btn(icons::chevron_left().into(), Message::NavBack);
    let fwd_btn = components::ghost_icon_btn(icons::chevron_right().into(), Message::NavForward);

    let traffic_spacer = container(Space::new().width(0.0).height(theme::TOPBAR_H))
        .width(Length::Fixed(theme::MAC_TRAFFIC_LEFT))
        .height(theme::TOPBAR_H);

    let left_cluster: Element<'a, Message> = row![
        traffic_spacer,
        toggle,
        Space::new().width(Length::Fixed(theme::P_XS)).height(theme::TOPBAR_H),
        back_btn,
        Space::new().width(Length::Fixed(2.0)).height(theme::TOPBAR_H),
        fwd_btn,
    ]
    .align_y(iced::Alignment::Center)
    .into();

    let inner: Element<'a, Message> = if let Some(ws) = state.current_workspace.as_ref() {
        let search = search_box(&ws.name, &state.search_query);

        let agent_btn = button(
            container(
                row![
                    icons::agent_square::<Message>(theme::AGENT_CLAUDE, 16.0),
                    Space::new().width(Length::Fixed(3.0)).height(0.0),
                    icons::chevron_down(),
                ]
                .align_y(iced::Alignment::Center),
            )
            .padding(iced::Padding { top: 4.0, right: 5.0, bottom: 4.0, left: 5.0 }),
        )
        .on_press(Message::None)
        .padding(0)
        .style(components::ghost_btn_style);

        let server_btn = server_button();
        let terminal_btn = components::ghost_icon_btn(icons::terminal().into(), Message::ToggleTerminal);
        let diff_btn = components::ghost_icon_btn(icons::git_compare().into(), Message::ToggleReview);
        let folder_btn = components::ghost_icon_btn(icons::folder(16.0).into(), Message::None);
        let right_panel_btn =
            components::ghost_icon_btn(icons::panel_right().into(), Message::ToggleRightSidebar);

        let right_cluster = row![
            agent_btn,
            Space::new().width(Length::Fixed(theme::P_XS)).height(theme::TOPBAR_H),
            server_btn,
            Space::new().width(Length::Fixed(2.0)).height(theme::TOPBAR_H),
            terminal_btn,
            Space::new().width(Length::Fixed(2.0)).height(theme::TOPBAR_H),
            diff_btn,
            Space::new().width(Length::Fixed(2.0)).height(theme::TOPBAR_H),
            folder_btn,
            Space::new().width(Length::Fixed(2.0)).height(theme::TOPBAR_H),
            right_panel_btn,
        ]
        .align_y(iced::Alignment::Center);

        let drag_left = mouse_area(
            container(Space::new().width(Length::Fill).height(theme::TOPBAR_H))
                .width(Length::Fill)
                .height(theme::TOPBAR_H),
        )
        .on_press(Message::StartDrag);
        let drag_right = mouse_area(
            container(Space::new().width(Length::Fill).height(theme::TOPBAR_H))
                .width(Length::Fill)
                .height(theme::TOPBAR_H),
        )
        .on_press(Message::StartDrag);

        row![
            left_cluster,
            drag_left,
            search,
            drag_right,
            right_cluster,
            Space::new().width(Length::Fixed(theme::P_MD)).height(theme::TOPBAR_H),
        ]
        .width(Length::Fill)
        .align_y(iced::Alignment::Center)
        .into()
    } else {
        let drag_filler = mouse_area(
            container(Space::new().width(Length::Fill).height(theme::TOPBAR_H))
                .width(Length::Fill)
                .height(theme::TOPBAR_H),
        )
        .on_press(Message::StartDrag);

        row![left_cluster, drag_filler]
            .width(Length::Fill)
            .align_y(iced::Alignment::Center)
            .into()
    };

    container(inner)
        .width(Length::Fill)
        .height(theme::TOPBAR_H)
        .align_y(iced::alignment::Vertical::Center)
        .style(|_| iced::widget::container::Style::default().background(theme::BG_DEEP))
        .into()
}

fn search_box<'a>(ws_name: &'a str, query: &'a str) -> Element<'a, Message> {
    let placeholder = format!("Search {}", ws_name);

    let input = text_input(&placeholder, query)
        .id(SEARCH_INPUT_ID.clone())
        .on_input(Message::SearchInput)
        .on_submit(Message::SearchSubmit)
        .size(theme::SZ_META)
        .padding(iced::Padding { top: 0.0, right: 0.0, bottom: 0.0, left: 0.0 })
        .style(|_, _status| {
            let border = Border {
                color: Color::TRANSPARENT,
                width: 0.0,
                radius: 0.0.into(),
            };
            iced::widget::text_input::Style {
                background: Color::TRANSPARENT.into(),
                border,
                icon: theme::TEXT_3,
                placeholder: theme::TEXT_3,
                value: theme::TEXT_1,
                selection: theme::LINE,
            }
        });

    let kbd_pill = container(
        text("⌘K")
            .size(theme::SZ_MICRO)
            .style(|_| iced::widget::text::Style { color: Some(theme::TEXT_4) }),
    )
    .padding(iced::Padding { top: 1.0, right: 6.0, bottom: 1.0, left: 6.0 })
    .style(|_| {
        iced::widget::container::Style::default()
            .background(theme::BG_CARD)
            .border(Border {
                color: theme::LINE,
                width: 1.0,
                radius: theme::R_SM.into(),
            })
    });

    container(
        row![
            icons::search(),
            Space::new().width(Length::Fixed(8.0)).height(0.0),
            container(input).width(Length::Fill),
            Space::new().width(Length::Fixed(6.0)).height(0.0),
            kbd_pill,
        ]
        .align_y(iced::Alignment::Center),
    )
    .padding(iced::Padding { top: 6.0, right: 8.0, bottom: 6.0, left: 10.0 })
    .width(Length::Fixed(340.0))
    .style(|_| {
        iced::widget::container::Style::default()
            .background(theme::BG_CONTENT)
            .border(Border {
                color: theme::LINE,
                width: 1.0,
                radius: theme::R_MD.into(),
            })
    })
    .into()
}

fn server_button<'a>() -> Element<'a, Message> {
    let icon = icons::server();

    let dot = icons::dot::<Message>(theme::TEXT_3, 5.0);
    let dot_holder = container(dot)
        .padding(iced::Padding { top: 2.0, right: 2.0, bottom: 0.0, left: 0.0 })
        .align_x(iced::alignment::Horizontal::Right)
        .align_y(iced::alignment::Vertical::Top)
        .width(Length::Fixed(26.0))
        .height(Length::Fixed(26.0));

    let stacked = stack![
        container(icon)
            .width(Length::Fixed(26.0))
            .height(Length::Fixed(26.0))
            .center_x(Length::Fixed(26.0))
            .center_y(Length::Fixed(26.0)),
        dot_holder,
    ];

    button(container(stacked).padding(0))
        .on_press(Message::ToggleServerMenu)
        .padding(0)
        .style(|_, status| iced::widget::button::Style {
            background: match status {
                iced::widget::button::Status::Hovered => Some(theme::BG_HOVER.into()),
                iced::widget::button::Status::Pressed => Some(theme::BG_HOVER.into()),
                _ => None,
            },
            text_color: theme::TEXT_2,
            border: Border {
                color: Color::TRANSPARENT,
                width: 0.0,
                radius: theme::R_MD.into(),
            },
            shadow: Shadow::default(),
            snap: false,
        })
        .into()
}
