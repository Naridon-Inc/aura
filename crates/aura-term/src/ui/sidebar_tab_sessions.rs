//! Worktrees sidebar — Slack-style sectioned list.
//!
//! Layout:
//!   ┌────────────────────────────────────┐
//!   │ STARRED                            │
//!   │ │ main                 ● abc1234   │
//!   │                                    │
//!   │ ACTIVE                             │
//!   │   feat/extract-tier1     abc2345   │
//!   │ │ feat/aura-terminal   ● abc3456   │   ← current (left accent bar)
//!   │   fix/pty-buffer       • abc4567   │   ← • amber = dirty
//!   │                                    │
//!   │                                    │
//!   │ [  + New worktree…              ]  │   ← pinned footer
//!   └────────────────────────────────────┘
//!
//! A row is 30px tall. The current worktree gets a 3×22 accent bar on the
//! left, BG_CARD fill, and TEXT_1 bold label. Every other row is 30px flat,
//! label TEXT_2, hover BG_HOVER. Dirty state surfaces as an amber dot on the
//! right; 7-char HEAD trails in TEXT_4.

use iced::widget::{button, column, container, row, scrollable, text, text_input, Space};
use iced::{Border, Color, Element, Length, Shadow};

use crate::{
    config::{self, WorktreeInfo},
    theme,
    ui::icons,
    App, Message,
};

const STARRED_BRANCHES: &[&str] = &["main", "master", "trunk", "develop", "dev"];

pub fn view<'a>(state: &'a App) -> Element<'a, Message> {
    if state.worktrees.is_empty() {
        return empty_state();
    }

    let (starred, active): (Vec<&WorktreeInfo>, Vec<&WorktreeInfo>) = state
        .worktrees
        .iter()
        .partition(|w| is_starred(w));

    let mut body = column![].spacing(0.0).width(Length::Fill);

    if !starred.is_empty() {
        body = body.push(section_header("Starred"));
        for w in starred {
            body = body.push(worktree_row(w));
        }
        body = body.push(Space::new().width(0.0).height(Length::Fixed(theme::P_SM)));
    }

    if !active.is_empty() {
        body = body.push(section_header("Active"));
        for w in active {
            body = body.push(worktree_row(w));
        }
    }

    let scroll_area = scrollable(body)
        .width(Length::Fill)
        .height(Length::Fill);

    let footer = footer_view(state);

    column![
        container(scroll_area).width(Length::Fill).height(Length::Fill),
        footer,
    ]
    .width(Length::Fill)
    .height(Length::Fill)
    .into()
}

fn is_starred(w: &WorktreeInfo) -> bool {
    w.branch
        .as_deref()
        .map(|b| STARRED_BRANCHES.contains(&b))
        .unwrap_or(false)
}

fn section_header<'a>(label: &'a str) -> Element<'a, Message> {
    container(
        text(label.to_uppercase())
            .size(theme::SZ_MICRO)
            .style(|_: &iced::Theme| iced::widget::text::Style {
                color: Some(theme::TEXT_4),
            }),
    )
    .width(Length::Fill)
    .padding(iced::Padding {
        top: 10.0,
        right: theme::P_MD,
        bottom: 4.0,
        left: theme::P_MD,
    })
    .into()
}

fn worktree_row<'a>(w: &'a WorktreeInfo) -> Element<'a, Message> {
    let is_current = w.is_current;
    let dirty = config::git_is_dirty(&w.path);

    // Left accent bar — 3px wide, 22px tall for current; transparent spacer
    // of identical footprint for others so the label column stays aligned.
    let bar: Element<'a, Message> = if is_current {
        container(Space::new().width(Length::Fixed(3.0)).height(Length::Fixed(22.0)))
            .style(|_| {
                iced::widget::container::Style::default()
                    .background(theme::ACCENT)
                    .border(Border {
                        color: Color::TRANSPARENT,
                        width: 0.0,
                        radius: 1.5.into(),
                    })
            })
            .into()
    } else {
        Space::new()
            .width(Length::Fixed(3.0))
            .height(Length::Fixed(22.0))
            .into()
    };

    let label_color = if is_current { theme::TEXT_1 } else { theme::TEXT_2 };
    let label_font = if is_current {
        theme::FONT_SANS_MEDIUM
    } else {
        theme::FONT_SANS
    };
    let label_text = w
        .branch
        .clone()
        .unwrap_or_else(|| w.path.file_name()
            .map(|n| n.to_string_lossy().into_owned())
            .unwrap_or_else(|| "detached".to_string()));

    let label: Element<'a, Message> = text(label_text)
        .size(theme::SZ_META)
        .font(label_font)
        .style(move |_: &iced::Theme| iced::widget::text::Style { color: Some(label_color) })
        .into();

    // Right side: dirty amber dot + 7-char head.
    let dirty_badge: Element<'a, Message> = if dirty {
        container(icons::dot::<Message>(theme::AMBER, 6.0))
            .width(Length::Fixed(10.0))
            .height(Length::Fixed(10.0))
            .center_x(Length::Fixed(10.0))
            .center_y(Length::Fixed(10.0))
            .into()
    } else {
        Space::new().width(Length::Fixed(0.0)).height(Length::Fixed(0.0)).into()
    };

    let head_text = w.head.clone().unwrap_or_default();
    let head: Element<'a, Message> = text(head_text)
        .size(theme::SZ_MICRO)
        .font(iced::Font::MONOSPACE)
        .style(|_: &iced::Theme| iced::widget::text::Style { color: Some(theme::TEXT_4) })
        .into();

    let inner = row![
        bar,
        Space::new().width(Length::Fixed(10.0)).height(0.0),
        container(label).width(Length::Fill),
        dirty_badge,
        Space::new().width(Length::Fixed(6.0)).height(0.0),
        head,
    ]
    .align_y(iced::Alignment::Center)
    .spacing(0.0);

    let row_container = container(inner)
        .width(Length::Fill)
        .height(Length::Fixed(theme::SIDEBAR_ROW_H))
        .padding(iced::Padding {
            top: 0.0,
            right: theme::P_MD,
            bottom: 0.0,
            left: theme::P_SM,
        });

    let is_current_for_style = is_current;
    button(row_container)
        .on_press(Message::SwitchWorktree(w.path.clone()))
        .padding(0)
        .style(move |_, status| {
            let bg = match (is_current_for_style, status) {
                (true, _) => Some(theme::BG_CARD.into()),
                (_, iced::widget::button::Status::Hovered)
                | (_, iced::widget::button::Status::Pressed) => Some(theme::BG_HOVER.into()),
                _ => None,
            };
            iced::widget::button::Style {
                background: bg,
                text_color: theme::TEXT_1,
                border: Border {
                    color: Color::TRANSPARENT,
                    width: 0.0,
                    radius: 0.0.into(),
                },
                shadow: Shadow::default(),
                snap: false,
            }
        })
        .width(Length::Fill)
        .into()
}

fn footer_view<'a>(state: &'a App) -> Element<'a, Message> {
    let inner: Element<'a, Message> = match state.new_worktree_input.as_ref() {
        Some(value) => new_worktree_input_box(value),
        None => new_worktree_button(),
    };

    container(inner)
        .width(Length::Fill)
        .padding(iced::Padding {
            top: theme::P_SM,
            right: theme::P_MD,
            bottom: theme::P_MD,
            left: theme::P_MD,
        })
        .style(|_| {
            iced::widget::container::Style::default()
                .background(theme::BG_CHROME)
                .border(Border {
                    color: theme::LINE_SOFT,
                    width: 1.0,
                    radius: 0.0.into(),
                })
        })
        .into()
}

fn new_worktree_button<'a>() -> Element<'a, Message> {
    let inner = row![
        icons::plus_sized(12.0),
        Space::new().width(Length::Fixed(8.0)).height(0.0),
        text("New worktree")
            .size(theme::SZ_META)
            .style(|_: &iced::Theme| iced::widget::text::Style { color: Some(theme::TEXT_2) }),
    ]
    .align_y(iced::Alignment::Center);

    let body = container(inner)
        .width(Length::Fill)
        .height(Length::Fixed(30.0))
        .padding(iced::Padding {
            top: 0.0,
            right: theme::P_SM,
            bottom: 0.0,
            left: theme::P_SM,
        })
        .center_y(Length::Fixed(30.0));

    button(body)
        .on_press(Message::ToggleNewWorktree)
        .padding(0)
        .style(|_, status| iced::widget::button::Style {
            background: match status {
                iced::widget::button::Status::Hovered
                | iced::widget::button::Status::Pressed => Some(theme::BG_HOVER.into()),
                _ => Some(theme::BG_CARD.into()),
            },
            text_color: theme::TEXT_1,
            border: Border {
                color: theme::LINE_SOFT,
                width: 1.0,
                radius: theme::R_MD.into(),
            },
            shadow: Shadow::default(),
            snap: false,
        })
        .width(Length::Fill)
        .into()
}

fn new_worktree_input_box<'a>(value: &'a str) -> Element<'a, Message> {
    let input = text_input("branch-name…", value)
        .on_input(Message::NewWorktreeInput)
        .on_submit(Message::NewWorktreeSubmit)
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
            placeholder: theme::TEXT_4,
            value: theme::TEXT_1,
            selection: theme::LINE,
        });

    let cancel_btn = button(
        container(icons::close_x(12.0))
            .width(Length::Fixed(20.0))
            .height(Length::Fixed(20.0))
            .center_x(Length::Fixed(20.0))
            .center_y(Length::Fixed(20.0)),
    )
    .on_press(Message::CancelNewWorktree)
    .padding(0)
    .style(|_, status| iced::widget::button::Style {
        background: match status {
            iced::widget::button::Status::Hovered
            | iced::widget::button::Status::Pressed => Some(theme::BG_HOVER.into()),
            _ => None,
        },
        text_color: theme::TEXT_3,
        border: Border {
            color: Color::TRANSPARENT,
            width: 0.0,
            radius: theme::R_SM.into(),
        },
        shadow: Shadow::default(),
        snap: false,
    });

    let row_el = row![
        icons::git_branch(12.0),
        Space::new().width(Length::Fixed(8.0)).height(0.0),
        container(input).width(Length::Fill),
        cancel_btn,
    ]
    .align_y(iced::Alignment::Center);

    container(row_el)
        .width(Length::Fill)
        .height(Length::Fixed(30.0))
        .padding(iced::Padding {
            top: 0.0,
            right: theme::P_XS,
            bottom: 0.0,
            left: theme::P_SM,
        })
        .center_y(Length::Fixed(30.0))
        .style(|_| {
            iced::widget::container::Style::default()
                .background(theme::COMPOSER_BG)
                .border(Border {
                    color: theme::COMPOSER_BORDER_FOCUS,
                    width: 1.0,
                    radius: theme::R_MD.into(),
                })
        })
        .into()
}

fn empty_state<'a>() -> Element<'a, Message> {
    container(
        column![
            text("No worktrees")
                .size(theme::SZ_BODY)
                .style(|_: &iced::Theme| iced::widget::text::Style { color: Some(theme::TEXT_2) }),
            Space::new().width(Length::Fixed(0.0)).height(Length::Fixed(4.0)),
            text("Open a git repository to see its worktrees here.")
                .size(theme::SZ_MICRO)
                .style(|_: &iced::Theme| iced::widget::text::Style { color: Some(theme::TEXT_3) }),
        ]
        .align_x(iced::Alignment::Center),
    )
    .width(Length::Fill)
    .height(Length::Fill)
    .center_x(Length::Fill)
    .center_y(Length::Fill)
    .into()
}
