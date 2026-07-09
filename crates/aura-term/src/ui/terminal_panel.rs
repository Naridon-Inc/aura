use iced::widget::{button, column, container, mouse_area, row, scrollable, text, Space};
use iced::{Border, Color, Element, Length, Shadow};

use crate::{theme, ui::icons, ui::pty_grid, App, Message};

pub fn view<'a>(state: &'a App) -> Element<'a, Message> {
    let active_tab = container(
        row![
            text("Terminal 1")
                .size(theme::SZ_META)
                .style(|_| iced::widget::text::Style { color: Some(theme::TEXT_1) }),
            Space::new().width(Length::Fixed(8.0)).height(0.0),
            button(container(icons::close_x(12.0)).padding(2.0))
                .on_press(Message::ToggleTerminal)
                .padding(0.0)
                .style(|_, status| iced::widget::button::Style {
                    background: match status {
                        iced::widget::button::Status::Hovered => Some(theme::BG_3.into()),
                        _ => None,
                    },
                    text_color: theme::TEXT_3,
                    border: Border {
                        color: Color::TRANSPARENT,
                        width: 0.0,
                        radius: 3.0.into(),
                    },
                    shadow: Shadow::default(),
                    snap: false,
                }),
        ]
        .align_y(iced::Alignment::Center),
    )
    .padding([8.0, 10.0])
    .style(|_| {
        iced::widget::container::Style::default().border(Border {
            color: theme::ACCENT,
            width: 0.0,
            radius: 0.0.into(),
        })
    });

    let new_tab_btn = button(container(icons::plus_sized(14.0)).padding(4.0))
        .on_press(Message::None)
        .padding(0.0)
        .style(|_, status| iced::widget::button::Style {
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
        });

    let active_tab_underline = container(Space::new().width(Length::Fixed(80.0)).height(Length::Fixed(2.0)))
        .width(Length::Fixed(80.0))
        .height(Length::Fixed(2.0))
        .style(|_| iced::widget::container::Style::default().background(theme::ACCENT));

    let tabs_row = container(
        column![
            row![active_tab, new_tab_btn]
                .spacing(4.0)
                .align_y(iced::Alignment::Center),
            active_tab_underline,
        ]
        .spacing(0.0),
    )
    .padding(iced::Padding { top: 4.0, right: 8.0, bottom: 0.0, left: 10.0 })
    .width(Length::Fill)
    .style(|_| {
        iced::widget::container::Style::default()
            .background(theme::BG_1)
            .border(Border {
                color: theme::LINE_SOFT,
                width: 0.0,
                radius: 0.0.into(),
            })
    });

    let grid_el: Element<'a, Message> = container(pty_grid::view::<Message>(&state.pty_grid))
        .padding([8.0, 10.0])
        .width(Length::Fill)
        .height(Length::Fill)
        .style(|_| iced::widget::container::Style::default().background(theme::BG_0))
        .into();

    let body_inner: Element<'a, Message> = if state.show_log_output {
        // 30/70 split: daemon log tail above, PTY grid below. Toggle via
        // ⌘⇧L. The log tail is fed from running-block rings so it reflects
        // what the daemon is capturing without needing a second stream.
        let log = log_tail(state);
        column![
            container(log)
                .width(Length::Fill)
                .height(Length::FillPortion(3))
                .style(|_| iced::widget::container::Style::default().background(theme::BG_1)),
            container(grid_el)
                .width(Length::Fill)
                .height(Length::FillPortion(7)),
        ]
        .width(Length::Fill)
        .height(Length::Fill)
        .into()
    } else {
        grid_el
    };

    // `on_scroll` drives alacritty scrollback; `on_press` claims PTY
    // keyboard focus so future keystrokes route through the sub rather
    // than the composer's text_input.
    let body: Element<'a, Message> = mouse_area(body_inner)
        .on_press(Message::TerminalFocus(true))
        .on_scroll(Message::PtyScroll)
        .into();

    column![tabs_row, body]
        .width(Length::Fill)
        .height(Length::Fill)
        .into()
}

/// Render the last ~200 lines of the most recent block's output as a
/// monospace log tail. Called when `state.show_log_output` is true.
fn log_tail<'a>(state: &'a App) -> Element<'a, Message> {
    let label = text("daemon log tail")
        .size(theme::SZ_MICRO)
        .color(theme::TEXT_3);

    let recent_output: String = state
        .blocks
        .last()
        .map(|(_, out)| String::from_utf8_lossy(out).into_owned())
        .unwrap_or_default();

    let trimmed: String = recent_output
        .lines()
        .rev()
        .take(200)
        .collect::<Vec<_>>()
        .into_iter()
        .rev()
        .collect::<Vec<_>>()
        .join("\n");

    let body = text(if trimmed.is_empty() {
        "(no output yet)".to_string()
    } else {
        trimmed
    })
    .size(theme::SZ_META)
    .color(theme::TEXT_2);

    let col = column![label, Space::new().width(0.0).height(Length::Fixed(4.0)), body]
        .width(Length::Fill);

    container(
        scrollable(col).width(Length::Fill).height(Length::Fill),
    )
    .padding([6.0, 10.0])
    .width(Length::Fill)
    .height(Length::Fill)
    .into()
}
