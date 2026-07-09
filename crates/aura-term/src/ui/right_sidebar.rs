//! Right sidebar — tabbed feed: Blocks / Activity / Orchestration.
//!
//! Blocks (default) shows the live block-card column; Activity embeds
//! term's filtered feed; Orchestration shows the multi-agent grid loaded
//! from `aura/waves.xml` state.

use iced::widget::{button, column, container, row, scrollable, text, Space};
use iced::{Alignment, Background, Border, Color, Element, Length, Padding, Shadow};

use crate::{
    app::RightSidebarTab,
    theme,
    ui::{activity, block_card, orchestration as orch},
    App, Message,
};

pub fn view<'a>(state: &'a App) -> Element<'a, Message> {
    let tabs = tab_strip(state.right_sidebar_tab);

    let body: Element<'a, Message> = match state.right_sidebar_tab {
        RightSidebarTab::Blocks => blocks_body(state),
        RightSidebarTab::Activity => activity::view(
            activity::Model {
                filter: state.activity_filter,
                composer: state.composer.text.as_str(),
                blocks: state.blocks.as_slice(),
            },
            Message::ActivityFilter,
            |_| Message::None,
            Message::None,
        ),
        RightSidebarTab::Orchestration => orchestration_body(state),
    };

    column![
        tabs,
        container(body).width(Length::Fill).height(Length::Fill),
    ]
    .width(Length::Fill)
    .height(Length::Fill)
    .into()
}

fn tab_strip<'a>(active: RightSidebarTab) -> Element<'a, Message> {
    let items = [
        (RightSidebarTab::Blocks, "Blocks"),
        (RightSidebarTab::Activity, "Activity"),
        (RightSidebarTab::Orchestration, "Orchestration"),
    ];
    let mut seg = row![].spacing(2);
    for (tab, label) in items {
        seg = seg.push(tab_button(label, tab == active, tab));
    }
    container(seg)
        .width(Length::Fill)
        .padding(Padding::from([theme::P_SM, theme::P_SM]))
        .style(|_| {
            iced::widget::container::Style::default().border(Border {
                color: theme::LINE_SOFT,
                width: 0.0,
                radius: 0.0.into(),
            })
        })
        .into()
}

fn tab_button<'a>(label: &'a str, active: bool, tab: RightSidebarTab) -> Element<'a, Message> {
    let fg = if active { theme::TEXT_1 } else { theme::TEXT_3 };
    let bg = if active { theme::BG_2 } else { Color::TRANSPARENT };
    button(
        container(text(label).size(theme::SZ_META).color(fg))
            .padding(Padding::from([4.0, 10.0])),
    )
    .on_press(Message::SelectRightSidebarTab(tab))
    .padding(0)
    .style(move |_, status| iced::widget::button::Style {
        background: Some(Background::Color(match status {
            iced::widget::button::Status::Hovered => theme::BG_2,
            _ => bg,
        })),
        text_color: fg,
        border: Border {
            color: Color::TRANSPARENT,
            width: 0.0,
            radius: 6.0.into(),
        },
        shadow: Shadow::default(),
        snap: false,
    })
    .into()
}

fn orchestration_body<'a>(state: &'a App) -> Element<'a, Message> {
    let tiles = state.panes.orchestration_tiles.as_slice();
    let plan = state.panes.orchestration_plan.as_deref();

    let header: Element<'a, Message> = {
        let label = plan.unwrap_or("no active plan");
        container(
            text(label)
                .size(theme::SZ_META)
                .color(theme::TEXT_3),
        )
        .padding(Padding::from([theme::P_SM, theme::P_MD]))
        .width(Length::Fill)
        .into()
    };

    let body: Element<'a, Message> = if tiles.is_empty() {
        orch::empty_state::<Message>()
    } else {
        orch::grid::<Message>(tiles, |_| Message::None)
    };

    let col = column![
        header,
        container(body)
            .width(Length::Fill)
            .padding(Padding::from([0.0, theme::P_MD])),
    ]
    .spacing(theme::P_SM)
    .width(Length::Fill);

    scrollable(col).width(Length::Fill).height(Length::Fill).into()
}

fn blocks_body<'a>(state: &'a App) -> Element<'a, Message> {
    if state.blocks.is_empty() {
        return empty_hint();
    }
    let mut col = column![].spacing(theme::P_SM).width(Length::Fill);
    for (block, output) in state.blocks.iter() {
        col = col.push(
            container(block_card::view::<Message>(block, output, false))
                .width(Length::Fill)
                .padding(Padding {
                    top: 0.0,
                    right: theme::P_MD,
                    bottom: 0.0,
                    left: theme::P_MD,
                }),
        );
    }
    col = col.push(Space::new().width(0.0).height(Length::Fixed(theme::P_MD)));
    scrollable(col).width(Length::Fill).height(Length::Fill).into()
}

fn empty_hint<'a>() -> Element<'a, Message> {
    container(
        column![
            text("No blocks yet")
                .size(theme::SZ_META)
                .color(theme::TEXT_2),
            Space::new().width(0.0).height(Length::Fixed(4.0)),
            text("Run a command in the terminal to see the first block.")
                .size(theme::SZ_MICRO)
                .color(theme::TEXT_3),
        ]
        .align_x(Alignment::Center),
    )
    .width(Length::Fill)
    .height(Length::Fill)
    .center_x(Length::Fill)
    .padding(Padding {
        top: theme::P_XL,
        right: theme::P_MD,
        bottom: theme::P_XL,
        left: theme::P_MD,
    })
    .into()
}
