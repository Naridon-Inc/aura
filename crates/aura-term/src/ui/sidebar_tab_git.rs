use iced::widget::{button, column, container, row, scrollable, text, text_input, Space};
use iced::{Background, Border, Color, Element, Length, Padding, Shadow};

use crate::{
    fixtures::{
        current_branch, mock_git_changes, mock_git_graph, mock_git_staged, GitChange,
    },
    theme,
    ui::{components, git_graph, icons},
    App, Message, COMMIT_MESSAGE_INPUT_ID,
};

pub fn view<'a>(state: &'a App) -> Element<'a, Message> {
    let staged = mock_git_staged();
    let changes = mock_git_changes();
    let branch = current_branch();
    let staged_len = staged.len();
    let changes_len = changes.len();

    let body = column![
        branch_pill(branch),
        commit_composer(state, branch),
        components::divider_h(),
        section(
            "STAGED CHANGES",
            staged_len,
            state.git_staged_expanded,
            Message::GitToggleStaged,
            section_actions_staged(),
            staged,
            /*staged=*/ true,
        ),
        section(
            "CHANGES",
            changes_len,
            state.git_changes_expanded,
            Message::GitToggleChanges,
            section_actions_changes(),
            changes,
            /*staged=*/ false,
        ),
        components::divider_h(),
        graph_section(),
    ]
    .spacing(0.0);

    scrollable(body).width(Length::Fill).height(Length::Fill).into()
}

// ─── Branch pill ────────────────────────────────────────────────────────────

fn branch_pill<'a>(branch: &'a str) -> Element<'a, Message> {
    let pill = container(
        row![
            icons::git_branch(14.0),
            Space::new().width(Length::Fixed(8.0)).height(0.0),
            text(branch.to_string())
                .size(theme::SZ_META)
                .style(|_| iced::widget::text::Style { color: Some(theme::TEXT_1) }),
            Space::new().width(Length::Fill).height(0.0),
            icons::chevron_down(),
        ]
        .align_y(iced::Alignment::Center),
    )
    .padding(Padding { top: 6.0, right: 10.0, bottom: 6.0, left: 10.0 })
    .style(|_| {
        iced::widget::container::Style::default()
            .background(theme::BG_CARD)
            .border(Border {
                color: theme::LINE_SOFT,
                width: 1.0,
                radius: theme::R_MD.into(),
            })
    });

    container(pill)
        .padding(Padding { top: theme::P_SM, right: theme::P_MD, bottom: theme::P_SM, left: theme::P_MD })
        .width(Length::Fill)
        .into()
}

// ─── Commit composer ────────────────────────────────────────────────────────

fn commit_composer<'a>(state: &'a App, branch: &'a str) -> Element<'a, Message> {
    let placeholder = format!("Message (⌘↵ to commit on '{}')", branch);
    let input = text_input(&placeholder, &state.git_commit_message)
        .id(COMMIT_MESSAGE_INPUT_ID.clone())
        .on_input(Message::GitCommitMessageInput)
        .on_submit(Message::GitCommitSubmit)
        .size(theme::SZ_META)
        .padding(Padding { top: 8.0, right: 10.0, bottom: 8.0, left: 10.0 })
        .style(commit_input_style);

    let commit_btn = commit_button(!state.git_commit_message.trim().is_empty());

    column![
        container(input)
            .width(Length::Fill)
            .padding(Padding { top: 0.0, right: theme::P_MD, bottom: theme::P_XS, left: theme::P_MD }),
        container(commit_btn)
            .width(Length::Fill)
            .padding(Padding { top: 0.0, right: theme::P_MD, bottom: theme::P_SM, left: theme::P_MD }),
    ]
    .spacing(0.0)
    .into()
}

fn commit_button<'a>(enabled: bool) -> Element<'a, Message> {
    let label = text("Commit")
        .size(theme::SZ_META)
        .style(move |_| iced::widget::text::Style {
            color: Some(if enabled { theme::BG_DEEP } else { theme::TEXT_3 }),
        });

    let divider_color = if enabled {
        Color { a: 0.15, ..theme::BG_DEEP }
    } else {
        theme::LINE_SOFT
    };

    let main_label = container(label)
        .width(Length::Fill)
        .center_x(Length::Fill)
        .center_y(Length::Fixed(26.0))
        .padding(Padding { top: 0.0, right: 8.0, bottom: 0.0, left: 8.0 });

    let split_divider = container(Space::new().width(Length::Fixed(1.0)).height(Length::Fixed(16.0)))
        .width(Length::Fixed(1.0))
        .height(Length::Fixed(16.0))
        .center_y(Length::Fixed(26.0))
        .style(move |_| iced::widget::container::Style::default().background(divider_color));

    let chev_tint = if enabled { theme::BG_DEEP } else { theme::TEXT_3 };
    let chev = container(icons::tinted(icons::CHEVRON_DOWN, 12.0, chev_tint))
        .width(Length::Fixed(26.0))
        .height(Length::Fixed(26.0))
        .center_x(Length::Fixed(26.0))
        .center_y(Length::Fixed(26.0));

    let inner = row![main_label, split_divider, chev].align_y(iced::Alignment::Center);

    let mut btn = button(inner)
        .padding(0)
        .width(Length::Fill)
        .style(move |_, status| {
            let (bg, fg) = if enabled {
                let hovered = matches!(status, button::Status::Hovered);
                (
                    if hovered { Color { r: 1.0, g: 0.965, b: 0.949, a: 1.0 } } else { theme::SEND_BG },
                    theme::BG_DEEP,
                )
            } else {
                (theme::BG_CARD, theme::TEXT_3)
            };
            button::Style {
                background: Some(Background::Color(bg)),
                text_color: fg,
                border: Border {
                    color: if enabled { Color::TRANSPARENT } else { theme::LINE_SOFT },
                    width: if enabled { 0.0 } else { 1.0 },
                    radius: theme::R_MD.into(),
                },
                shadow: Shadow::default(),
                snap: false,
            }
        });

    if enabled {
        btn = btn.on_press(Message::GitCommitSubmit);
    }

    btn.into()
}

fn commit_input_style(_theme: &iced::Theme, status: text_input::Status) -> text_input::Style {
    let focused = matches!(status, text_input::Status::Focused { .. });
    text_input::Style {
        background: Background::Color(theme::BG_CARD),
        border: Border {
            color: if focused { theme::COMPOSER_BORDER_FOCUS } else { theme::LINE_SOFT },
            width: 1.0,
            radius: theme::R_MD.into(),
        },
        icon: theme::TEXT_3,
        placeholder: theme::TEXT_3,
        value: theme::TEXT_1,
        selection: theme::SELECTION,
    }
}

// ─── Section (Staged / Changes) ────────────────────────────────────────────

fn section<'a>(
    title: &'static str,
    count: usize,
    expanded: bool,
    on_toggle: Message,
    actions: Element<'a, Message>,
    items: Vec<GitChange>,
    is_staged: bool,
) -> Element<'a, Message> {
    let chev = if expanded { icons::CHEVRON_DOWN } else { icons::CHEVRON_RIGHT };
    let chev_icon = container(icons::tinted(chev, 10.0, theme::TEXT_3))
        .width(Length::Fixed(14.0))
        .height(Length::Fixed(14.0))
        .center_x(Length::Fixed(14.0))
        .center_y(Length::Fixed(14.0));

    let title_text = text(title)
        .size(theme::SZ_MICRO)
        .style(|_| iced::widget::text::Style { color: Some(theme::TEXT_2) });

    let count_badge = container(
        text(format!("{}", count))
            .size(theme::SZ_MICRO)
            .style(|_| iced::widget::text::Style { color: Some(theme::TEXT_2) }),
    )
    .padding(Padding::from([0.0, 6.0]))
    .height(Length::Fixed(14.0))
    .center_y(Length::Fixed(14.0))
    .style(|_| {
        iced::widget::container::Style::default()
            .background(theme::BG_CARD)
            .border(Border {
                color: theme::LINE_SOFT,
                width: 1.0,
                radius: 7.0.into(),
            })
    });

    let header_inner = row![
        chev_icon,
        Space::new().width(Length::Fixed(6.0)).height(0.0),
        title_text,
        Space::new().width(Length::Fixed(6.0)).height(0.0),
        count_badge,
        Space::new().width(Length::Fill).height(0.0),
        actions,
    ]
    .align_y(iced::Alignment::Center);

    let header = button(
        container(header_inner)
            .width(Length::Fill)
            .padding(Padding { top: 4.0, right: theme::P_MD, bottom: 4.0, left: 10.0 }),
    )
    .on_press(on_toggle)
    .padding(0)
    .width(Length::Fill)
    .style(section_header_btn_style);

    let mut col = column![header].spacing(0.0);

    if expanded {
        let mut rows = column![].spacing(0.0);
        for ch in items.into_iter() {
            rows = rows.push(change_row(ch, is_staged));
        }
        col = col.push(rows);
        col = col.push(Space::new().width(0.0).height(Length::Fixed(6.0)));
    }

    col.into()
}

fn section_header_btn_style(_t: &iced::Theme, status: button::Status) -> button::Style {
    let bg = match status {
        button::Status::Hovered => theme::BG_HOVER,
        _ => Color::TRANSPARENT,
    };
    button::Style {
        background: Some(Background::Color(bg)),
        text_color: theme::TEXT_2,
        border: Border::default(),
        shadow: Shadow::default(),
        snap: false,
    }
}

fn section_actions_staged<'a>() -> Element<'a, Message> {
    row![inline_icon_btn(icons::MINUS, "Unstage all", Message::None)].into()
}

fn section_actions_changes<'a>() -> Element<'a, Message> {
    row![
        inline_icon_btn(icons::REFRESH, "Refresh", Message::None),
        Space::new().width(Length::Fixed(2.0)).height(0.0),
        inline_icon_btn(icons::PLUS, "Stage all", Message::None),
    ]
    .into()
}

fn inline_icon_btn<'a>(
    icon_bytes: &'static [u8],
    _tooltip: &'static str,
    on_press: Message,
) -> Element<'a, Message> {
    let icon = container(icons::tinted(icon_bytes, 12.0, theme::TEXT_3))
        .width(Length::Fixed(18.0))
        .height(Length::Fixed(18.0))
        .center_x(Length::Fixed(18.0))
        .center_y(Length::Fixed(18.0));

    button(icon)
        .on_press(on_press)
        .padding(0)
        .style(|_, status| {
            let bg = match status {
                button::Status::Hovered => theme::BG_HOVER,
                _ => Color::TRANSPARENT,
            };
            button::Style {
                background: Some(Background::Color(bg)),
                text_color: theme::TEXT_2,
                border: Border {
                    color: Color::TRANSPARENT,
                    width: 0.0,
                    radius: theme::R_SM.into(),
                },
                shadow: Shadow::default(),
                snap: false,
            }
        })
        .into()
}

// ─── File rows ──────────────────────────────────────────────────────────────

fn change_row<'a>(ch: GitChange, is_staged: bool) -> Element<'a, Message> {
    let file_icon = container(icons::file(14.0))
        .width(Length::Fixed(16.0))
        .height(Length::Fixed(16.0))
        .center_x(Length::Fixed(16.0))
        .center_y(Length::Fixed(16.0));

    let status = ch.status;
    let name = text(ch.file)
        .size(theme::SZ_META)
        .style(|_| iced::widget::text::Style { color: Some(theme::TEXT_1) });

    let folder = text(ch.folder)
        .size(theme::SZ_MICRO)
        .style(|_| iced::widget::text::Style { color: Some(theme::TEXT_3) });

    let status_letter = text(status.letter())
        .size(theme::SZ_MICRO)
        .font(iced::Font::MONOSPACE)
        .style(move |_| iced::widget::text::Style { color: Some(status.color()) });

    let status_wrap = container(status_letter)
        .width(Length::Fixed(14.0))
        .height(Length::Fixed(16.0))
        .align_x(iced::alignment::Horizontal::Center)
        .center_y(Length::Fixed(16.0));

    // Action icon: `+` for unstaged, `−` for staged. No-op for the proto.
    let (action_bytes, _label) = if is_staged {
        (icons::MINUS, "Unstage")
    } else {
        (icons::PLUS, "Stage")
    };
    let action = inline_icon_btn(action_bytes, _label, Message::None);

    let inner = row![
        file_icon,
        Space::new().width(Length::Fixed(6.0)).height(0.0),
        name,
        Space::new().width(Length::Fixed(8.0)).height(0.0),
        folder,
        Space::new().width(Length::Fill).height(0.0),
        action,
        Space::new().width(Length::Fixed(4.0)).height(0.0),
        status_wrap,
    ]
    .align_y(iced::Alignment::Center);

    container(inner)
        .width(Length::Fill)
        .padding(Padding { top: 3.0, right: theme::P_MD, bottom: 3.0, left: theme::P_MD + 8.0 })
        .into()
}

// ─── Commits graph ─────────────────────────────────────────────────────────

fn graph_section<'a>() -> Element<'a, Message> {
    let header = container(
        row![
            text("GRAPH")
                .size(theme::SZ_MICRO)
                .style(|_| iced::widget::text::Style { color: Some(theme::TEXT_3) }),
            Space::new().width(Length::Fixed(8.0)).height(0.0),
            text(current_branch())
                .size(theme::SZ_MICRO)
                .style(|_| iced::widget::text::Style { color: Some(theme::TEXT_2) }),
            Space::new().width(Length::Fill).height(0.0),
            container(
                text("Auto")
                    .size(theme::SZ_MICRO)
                    .style(|_| iced::widget::text::Style { color: Some(theme::TEXT_2) }),
            )
            .padding(Padding::from([1.0, 6.0]))
            .style(|_| {
                iced::widget::container::Style::default()
                    .background(theme::BG_CARD)
                    .border(Border {
                        color: theme::LINE_SOFT,
                        width: 1.0,
                        radius: 7.0.into(),
                    })
            }),
        ]
        .align_y(iced::Alignment::Center),
    )
    .padding(Padding {
        top: theme::P_SM,
        right: theme::P_MD,
        bottom: 4.0,
        left: theme::P_MD,
    });

    let graph = mock_git_graph();

    column![
        header,
        container(git_graph::view_owned(graph))
            .padding(Padding { top: 2.0, right: 0.0, bottom: theme::P_SM, left: 0.0 })
            .width(Length::Fill),
    ]
    .spacing(0.0)
    .into()
}
