//! Activity pane — filters, morning-brief stats, recent feed, composer.
//! Tight spacing, mono timestamps, state dots colored per block.

use aura_blocks::Block;
use iced::widget::{button, column, container, row, scrollable, text, text_input, Space};
use iced::{Alignment, Element, Length, Padding};

use crate::ui::icon;
use crate::ui::style;
use crate::theme as t;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Filter {
    All,
    Mentions,
    Gates,
    Sentinel,
    Threads,
}

impl Filter {
    pub fn label(self) -> &'static str {
        match self {
            Self::All => "All",
            Self::Mentions => "Mentions",
            Self::Gates => "Gates",
            Self::Sentinel => "Sentinel",
            Self::Threads => "Threads",
        }
    }
}

pub struct Model<'a> {
    pub filter: Filter,
    pub composer: &'a str,
    pub blocks: &'a [(Block, Vec<u8>)],
}

pub fn view<'a, M: 'a + Clone>(
    model: Model<'a>,
    on_filter: impl Fn(Filter) -> M + 'a,
    on_composer: impl Fn(String) -> M + 'a,
    on_submit: M,
) -> Element<'a, M> {
    let header = row![
        icon::svg_colored(icon::Icon::History, t::SZ_UI, t::TEXT_DIM),
        Space::new().width(Length::Fixed(8.0)),
        text("Activity")
            .size(t::SZ_UI)
            .color(t::TEXT)
            .font(t::UI_MED),
        Space::new().width(Length::Fill),
        icon::svg_colored(icon::Icon::Refresh, t::SZ_UI, t::TEXT_DIM),
        Space::new().width(Length::Fixed(10.0)),
        icon::svg_colored(icon::Icon::Overflow, t::SZ_UI, t::TEXT_DIM),
    ]
    .align_y(Alignment::Center);

    let filters = filter_row(model.filter, &on_filter);
    let brief = morning_brief(model.blocks);
    let feed_title = text("Recent")
        .size(t::SZ_TINY)
        .color(t::TEXT_DIM)
        .font(t::UI_MED);
    let feed = feed_list(model.blocks);

    let body = column![
        header,
        filters,
        divider(),
        brief,
        divider(),
        feed_title,
        feed,
    ]
    .spacing(t::P_SM);

    let scrolled = scrollable(
        container(body).padding(Padding::from([t::P_MD, t::P_MD]))
            .width(Length::Fill),
    )
    .height(Length::Fill)
    .width(Length::Fill)
    .style(style::scroller);

    let composer = composer_row(model.composer, on_composer, on_submit);

    container(column![scrolled, composer])
        .width(Length::Fill)
        .height(Length::Fill)
        .style(style::pane)
        .into()
}

fn filter_row<'a, M: 'a + Clone>(
    current: Filter,
    on_filter: &(impl Fn(Filter) -> M + 'a),
) -> Element<'a, M> {
    let mut r = row![].spacing(t::P_XS).align_y(Alignment::Center);
    for f in [
        Filter::All,
        Filter::Mentions,
        Filter::Gates,
        Filter::Sentinel,
        Filter::Threads,
    ] {
        let active = f == current;
        let btn = button(
            text(f.label())
                .size(t::SZ_TINY)
                .color(if active { t::TEXT } else { t::TEXT_MUTED }),
        )
        .padding(Padding::from([3, 10]))
        .on_press(on_filter(f))
        .style(style::chip_button(active));
        r = r.push(btn);
    }
    r.into()
}

fn morning_brief<'a, M: 'a>(blocks: &[(Block, Vec<u8>)]) -> Element<'a, M> {
    let total = blocks.len();
    let running = blocks
        .iter()
        .filter(|(b, _)| matches!(b.state, aura_blocks::BlockState::Running))
        .count();
    let failed = blocks
        .iter()
        .filter(|(b, _)| matches!(b.state, aura_blocks::BlockState::Failed))
        .count();

    let caption = text("MORNING BRIEF")
        .size(t::SZ_MICRO)
        .color(t::TEXT_DIM)
        .font(t::UI_MED);

    let stats = row![
        stat(total, "blocks"),
        Space::new().width(Length::Fixed(t::P_LG)),
        stat(running, "running"),
        Space::new().width(Length::Fixed(t::P_LG)),
        stat(failed, "failed"),
    ];

    let tail = text("no gates awaiting you · sentinel quiet")
        .size(t::SZ_META)
        .color(t::TEXT_MUTED);

    container(
        column![caption, stats, tail]
            .spacing(t::P_XS)
            .padding(Padding::from([t::P_MD, t::P_MD])),
    )
    .width(Length::Fill)
    .style(style::card)
    .into()
}

fn stat<'a, M: 'a>(value: usize, label: &str) -> Element<'a, M> {
    column![
        text(value.to_string())
            .size(t::SZ_HEADING)
            .color(t::TEXT)
            .font(t::MONO_MED),
        text(label.to_string()).size(t::SZ_TINY).color(t::TEXT_DIM),
    ]
    .spacing(0)
    .align_x(Alignment::Start)
    .into()
}

fn feed_list<'a, M: 'a>(blocks: &[(Block, Vec<u8>)]) -> Element<'a, M> {
    if blocks.is_empty() {
        return text("— no activity yet —")
            .size(t::SZ_META)
            .color(t::TEXT_DIM)
            .into();
    }
    let mut col = column![].spacing(6);
    for (b, _) in blocks.iter().take(20) {
        let ts = format!(
            "{:02}:{:02}",
            b.created_at.hour(),
            b.created_at.minute()
        );
        let summary = if b.intent.summary.is_empty() {
            match &b.payload {
                aura_blocks::BlockPayload::Command { command, .. } => command.clone(),
                _ => b.kind.wire().to_string(),
            }
        } else {
            b.intent.summary.clone()
        };
        let first = summary.lines().next().unwrap_or("").to_string();
        let trimmed = if first.len() > 52 {
            format!("{}…", &first[..51])
        } else {
            first
        };
        let dot = container(
            Space::new()
                .width(Length::Fixed(6.0))
                .height(Length::Fixed(6.0)),
        )
        .style(style::dot(t::state_color(b.state)));
        col = col.push(
            row![
                text(ts).size(t::SZ_TINY).color(t::TEXT_FAINT).font(t::MONO),
                Space::new().width(Length::Fixed(10.0)),
                dot,
                Space::new().width(Length::Fixed(10.0)),
                text(trimmed).size(t::SZ_META).color(t::TEXT_MUTED),
            ]
            .align_y(Alignment::Center),
        );
    }
    col.into()
}

fn composer_row<'a, M: 'a + Clone>(
    value: &'a str,
    on_composer: impl Fn(String) -> M + 'a,
    on_submit: M,
) -> Element<'a, M> {
    let anchor = container(
        row![
            text("@").size(t::SZ_META).color(t::ACCENT),
            Space::new().width(Length::Fixed(2.0)),
            text("anchor")
                .size(t::SZ_META)
                .color(t::TEXT_MUTED),
        ]
        .align_y(Alignment::Center),
    )
    .padding(Padding::from([3, 10]))
    .style(style::chip_soft(t::PANE_ALT, t::TEXT_MUTED));

    let input = text_input("message the team…", value)
        .on_input(on_composer)
        .on_submit(on_submit)
        .size(t::SZ_META)
        .padding(Padding::from([8, 10]))
        .style(style::input_primary)
        .width(Length::Fill);

    let inner = row![
        anchor,
        Space::new().width(Length::Fixed(t::P_SM)),
        input,
    ]
    .align_y(Alignment::Center);

    container(inner)
        .width(Length::Fill)
        .padding(Padding::from([t::P_SM, t::P_MD]))
        .style(style::pane)
        .into()
}

fn divider<'a, M: 'a>() -> Element<'a, M> {
    container(
        Space::new()
            .width(Length::Fill)
            .height(Length::Fixed(1.0)),
    )
    .style(style::divider)
    .into()
}
