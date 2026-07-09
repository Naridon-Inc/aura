use iced::widget::{column, container, row, text, Space};
use iced::{Border, Color, Element, Font, Length};

use crate::{fixtures::Workspace, theme, ui::icons, Message};

pub fn view<'a>(ws: &'a Workspace) -> Element<'a, Message> {
    let (prefix, last) = split_path(&ws.path_abs());

    column![
        pixel_icon(),
        Space::new().width(0.0).height(theme::P_2XL),
        text("Build anything")
            .size(theme::SZ_DISPLAY)
            .line_height(iced::widget::text::LineHeight::Absolute(iced::Pixels(32.0)))
            .font(theme::FONT_SANS_MEDIUM)
            .style(|_| iced::widget::text::Style { color: Some(theme::TEXT_1) }),
        Space::new().width(0.0).height(theme::P_XL + theme::P_XS),
        row![
            text(prefix)
                .size(theme::SZ_BODY)
                .font(Font::MONOSPACE)
                .style(|_| iced::widget::text::Style { color: Some(theme::TEXT_3) }),
            text(last)
                .size(theme::SZ_BODY)
                .font(Font::MONOSPACE)
                .style(|_| iced::widget::text::Style { color: Some(theme::TEXT_1) }),
        ]
        .align_y(iced::Alignment::Center),
        Space::new().width(0.0).height(theme::P_LG + theme::P_XS),
        row![
            icons::git_branch(14.0),
            Space::new().width(Length::Fixed(theme::P_SM)).height(0.0),
            text("Main branch (master)")
                .size(theme::SZ_BODY)
                .style(|_| iced::widget::text::Style { color: Some(theme::TEXT_3) }),
        ]
        .align_y(iced::Alignment::Center),
        Space::new().width(0.0).height(theme::P_LG),
        row![
            text("Last modified")
                .size(theme::SZ_BODY)
                .style(|_| iced::widget::text::Style { color: Some(theme::TEXT_3) }),
            Space::new().width(Length::Fixed(theme::P_SM)).height(0.0),
            text("56 minutes ago")
                .size(theme::SZ_BODY)
                .style(|_| iced::widget::text::Style { color: Some(theme::TEXT_1) }),
        ]
        .align_y(iced::Alignment::Center),
    ]
    .align_x(iced::Alignment::Center)
    .into()
}

fn pixel_icon<'a>() -> Element<'a, Message> {
    let body = container(Space::new().width(0.0).height(0.0))
        .width(Length::Fixed(22.0))
        .height(Length::Fixed(28.0))
        .style(|_| {
            iced::widget::container::Style::default()
                .background(theme::TEXT_1)
                .border(Border {
                    color: Color::TRANSPARENT,
                    width: 0.0,
                    radius: 2.0.into(),
                })
        });

    let notch = container(Space::new().width(0.0).height(0.0))
        .width(Length::Fixed(8.0))
        .height(Length::Fixed(6.0))
        .style(|_| {
            iced::widget::container::Style::default()
                .background(theme::BG_CONTENT)
                .border(Border {
                    color: Color::TRANSPARENT,
                    width: 0.0,
                    radius: 1.0.into(),
                })
        });

    let body_with_notch = iced::widget::stack![
        container(body)
            .center_x(Length::Fixed(48.0))
            .center_y(Length::Fixed(56.0))
            .width(Length::Fixed(48.0))
            .height(Length::Fixed(56.0)),
        container(notch)
            .padding(iced::Padding { top: 10.0, right: 14.0, bottom: 0.0, left: 0.0 })
            .align_x(iced::alignment::Horizontal::Right)
            .align_y(iced::alignment::Vertical::Top)
            .width(Length::Fixed(48.0))
            .height(Length::Fixed(56.0)),
    ];

    container(body_with_notch)
        .width(Length::Fixed(48.0))
        .height(Length::Fixed(56.0))
        .style(|_| {
            iced::widget::container::Style::default()
                .background(theme::BG_CARD)
                .border(Border {
                    color: theme::LINE,
                    width: 1.0,
                    radius: theme::R_XL.into(),
                })
        })
        .into()
}

fn split_path(path: &str) -> (String, String) {
    if let Some(idx) = path.rfind('/') {
        let (prefix, last) = path.split_at(idx);
        let prefix_with_slash = format!("{}/", prefix);
        (prefix_with_slash, last.trim_start_matches('/').to_string())
    } else {
        (String::new(), path.to_string())
    }
}

trait WorkspacePath {
    fn path_abs(&self) -> String;
}

impl WorkspacePath for Workspace {
    fn path_abs(&self) -> String {
        if let Some(rest) = self.path.strip_prefix("~/") {
            format!("/Users/you/{}", rest)
        } else {
            self.path.clone()
        }
    }
}
