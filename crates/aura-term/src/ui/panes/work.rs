//! Work pane — minimal block list. One row per block: state dot · intent
//! summary · HH:MM. No card chrome here; that's `block_card` territory on
//! the main surface. The pane is a lightweight index into the blocks the
//! user can jump to.
//!
//! Reads blocks from the caller (the app already pre-loads them via
//! `BlockStore::list_blocks` every tick), so this module stays pure UI.

use std::rc::Rc;

use aura_blocks::{Block, BlockId, BlockPayload, BlockState};
use iced::widget::{button, column, container, row, scrollable, text, Space};
use iced::{Alignment, Element, Length, Padding};

use crate::ui::style;
use crate::theme as t;

#[derive(Debug, Clone)]
pub enum Action {
    Select(BlockId),
}

pub fn view<'a, M: 'a + Clone>(
    blocks: &'a [(Block, Vec<u8>)],
    on_action: impl Fn(Action) -> M + 'a,
) -> Element<'a, M> {
    // The rows are built in a loop that mints one `Action::Select(id)` per
    // block, so we wrap the caller-supplied closure in `Rc` and clone it
    // cheaply into each row. Lifetime-wise this keeps the closure owned by
    // `view` while letting every row own its own message.
    let on_action: Rc<dyn Fn(Action) -> M + 'a> = Rc::new(on_action);

    let header = text("Work")
        .size(t::SZ_BODY_LG)
        .color(t::TEXT)
        .font(t::UI_MED);

    let body: Element<'a, M> = if blocks.is_empty() {
        empty_state()
    } else {
        let mut col = column![].spacing(2);
        for (block, _output) in blocks.iter().take(200) {
            let id = block.id;
            let on_press = (on_action)(Action::Select(id));
            col = col.push(row_view(block, on_press));
        }
        scrollable(container(col).width(Length::Fill))
            .height(Length::Fill)
            .width(Length::Fill)
            .style(style::scroller)
            .into()
    };

    let content = column![header, Space::new().height(Length::Fixed(t::P_SM)), body]
        .padding(Padding::from([t::P_MD, t::P_MD]));

    container(content)
        .width(Length::Fill)
        .height(Length::Fill)
        .style(style::pane)
        .into()
}

fn row_view<'a, M: 'a + Clone>(block: &'a Block, on_press: M) -> Element<'a, M> {
    let state_color = t::state_color(block.state);
    let dot = container(
        Space::new()
            .width(Length::Fixed(6.0))
            .height(Length::Fixed(6.0)),
    )
    .style(style::dot(state_color));

    let summary = summarize(block);
    let preview = truncate(&summary, 52);
    let ts = format!(
        "{:02}:{:02}",
        block.created_at.hour(),
        block.created_at.minute()
    );

    let inner = row![
        Space::new().width(Length::Fixed(6.0)),
        dot,
        Space::new().width(Length::Fixed(10.0)),
        text(preview)
            .size(t::SZ_META)
            .color(if is_terminal(block.state) {
                t::TEXT_MUTED
            } else {
                t::TEXT
            }),
        Space::new().width(Length::Fill),
        text(ts)
            .size(t::SZ_TINY)
            .color(t::TEXT_FAINT)
            .font(t::MONO),
        Space::new().width(Length::Fixed(6.0)),
    ]
    .align_y(Alignment::Center)
    .padding(Padding::from([6, 4]));

    button(inner)
        .padding(0)
        .on_press(on_press)
        .style(style::row_button(false))
        .width(Length::Fill)
        .into()
}

fn summarize(block: &Block) -> String {
    if !block.intent.summary.is_empty() {
        return block.intent.summary.clone();
    }
    match &block.payload {
        BlockPayload::Command { command, .. } => command.clone(),
        _ => block.kind.wire().to_string(),
    }
}

fn is_terminal(state: BlockState) -> bool {
    matches!(
        state,
        BlockState::Completed
            | BlockState::Failed
            | BlockState::RolledBack
            | BlockState::Superseded
    )
}

fn empty_state<'a, M: 'a>() -> Element<'a, M> {
    column![
        Space::new().height(Length::Fixed(24.0)),
        container(
            text("no work yet")
                .size(t::SZ_BODY)
                .color(t::TEXT_MUTED)
                .font(t::UI_MED),
        )
        .width(Length::Fill)
        .align_x(Alignment::Center),
        Space::new().height(Length::Fixed(4.0)),
        container(
            text("run a command to create a block")
                .size(t::SZ_META)
                .color(t::TEXT_DIM),
        )
        .width(Length::Fill)
        .align_x(Alignment::Center),
    ]
    .into()
}

fn truncate(s: &str, n: usize) -> String {
    let first = s.lines().next().unwrap_or("");
    if first.len() > n {
        format!("{}…", &first[..n.saturating_sub(1)])
    } else {
        first.to_string()
    }
}
