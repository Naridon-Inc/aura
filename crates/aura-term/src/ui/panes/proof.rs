//! Proof pane — input field for a behavioral goal ("Prove: ___").
//!
//! Submitting dispatches `Action::Submit`; the text field dispatches
//! `Action::InputChanged(_)` per keystroke. The app will later run the real
//! prover and plumb results into `Model::history`. We deliberately render
//! no stubbed results — if the user hasn't proven anything yet we show the
//! empty state with a concrete hint.

use iced::widget::{button, column, container, row, scrollable, text, text_input, Space};
use iced::{Alignment, Element, Length, Padding};

use crate::ui::style;
use crate::theme as t;

#[derive(Debug, Clone)]
pub enum Action {
    InputChanged(String),
    Submit,
}

#[derive(Debug, Default)]
pub struct Model {
    pub query: String,
    pub history: Vec<String>,
}

pub fn view<'a, M: 'a + Clone>(
    model: &'a Model,
    on_action: impl Fn(Action) -> M + 'a,
) -> Element<'a, M> {
    // Wrap the caller-supplied closure in a shared `Box` so both the text
    // input (which needs `Fn(String) -> M`) and the Submit button (which
    // needs `M`) can mint messages without moving the Fn twice.
    let on_action: std::rc::Rc<dyn Fn(Action) -> M + 'a> = std::rc::Rc::new(on_action);

    let header = text("Proof")
        .size(t::SZ_BODY_LG)
        .color(t::TEXT)
        .font(t::UI_MED);

    let on_change = {
        let on_action = on_action.clone();
        move |s: String| (on_action)(Action::InputChanged(s))
    };
    let on_submit = (on_action)(Action::Submit);
    let on_click = (on_action)(Action::Submit);

    let input = text_input("Prove: user can authenticate via OAuth", &model.query)
        .on_input(on_change)
        .on_submit(on_submit)
        .size(t::SZ_META)
        .padding(Padding::from([8, 10]))
        .style(style::input_primary);

    let prove_btn = button(
        container(
            text("prove")
                .size(t::SZ_TINY)
                .color(t::TEXT)
                .font(t::UI_MED),
        )
        .padding(Padding::from([4, 10])),
    )
    .padding(0)
    .on_press(on_click)
    .style(style::primary_action);

    let row_el = row![
        container(input).width(Length::Fill),
        Space::new().width(Length::Fixed(6.0)),
        prove_btn,
    ]
    .align_y(Alignment::Center);

    let body: Element<'a, M> = if model.history.is_empty() {
        empty_state()
    } else {
        let mut col = column![].spacing(4);
        for q in model.history.iter().rev().take(20) {
            col = col.push(
                container(
                    row![
                        text("✓")
                            .size(t::SZ_TINY)
                            .color(t::S_COMPLETED)
                            .font(t::UI_MED),
                        Space::new().width(Length::Fixed(8.0)),
                        text(q.clone()).size(t::SZ_META).color(t::TEXT_MUTED),
                    ]
                    .align_y(Alignment::Center),
                )
                .padding(Padding::from([4, 6])),
            );
        }
        scrollable(container(col).width(Length::Fill))
            .height(Length::Fill)
            .width(Length::Fill)
            .style(style::scroller)
            .into()
    };

    let content = column![
        header,
        Space::new().height(Length::Fixed(t::P_SM)),
        row_el,
        Space::new().height(Length::Fixed(t::P_MD)),
        body,
    ]
    .padding(Padding::from([t::P_MD, t::P_MD]));

    container(content)
        .width(Length::Fill)
        .height(Length::Fill)
        .style(style::pane)
        .into()
}

fn empty_state<'a, M: 'a>() -> Element<'a, M> {
    column![
        Space::new().height(Length::Fixed(24.0)),
        container(
            text("type a behavioral goal and press Enter")
                .size(t::SZ_META)
                .color(t::TEXT_MUTED),
        )
        .width(Length::Fill)
        .align_x(Alignment::Center),
        Space::new().height(Length::Fixed(4.0)),
        container(
            text("example: \"user can authenticate via OAuth\"")
                .size(t::SZ_TINY)
                .color(t::TEXT_DIM)
                .font(t::MONO),
        )
        .width(Length::Fill)
        .align_x(Alignment::Center),
    ]
    .into()
}
