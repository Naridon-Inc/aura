use iced::widget::{button, column, container, row, text, Space};
use iced::{Alignment, Background, Border, Color, Element, Length, Padding, Shadow};

use crate::{
    app::Pane,
    fixtures::Workspace,
    theme,
    ui::{code_editor, composer, hero, panes},
    App, Message,
};

pub fn view<'a>(state: &'a App, ws: &'a Workspace) -> Element<'a, Message> {
    // The rail's pane tile drives what fills the work surface. Only
    // Pane::Work falls through to the code editor / welcome hero;
    // every other pane (Plan / Impacts / Proof / Memory / Timeline /
    // Doctor / Orchestration / Handover) takes over the surface so
    // clicking a rail tile always visibly changes the body. The
    // underlying `current_file` is preserved — toggling back to
    // Pane::Work restores the editor exactly where the user left off.
    let on_work = state.active_pane == Pane::Work;
    let showing_file = on_work && state.current_file.is_some();

    let top: Element<'a, Message> = if showing_file {
        code_editor::view(state, state.current_file.as_ref().unwrap())
    } else {
        container(empty_body(state, ws))
            .width(Length::Fill)
            .height(Length::Fill)
            .into()
    };

    // Composer layout mirrors the body: compact inline composer when
    // the editor is live, wide centered composer for every pane body
    // (including Pane::Work hero).
    let composer_block = if showing_file {
        composer::view_compact(state)
    } else {
        composer::view(state)
    };

    let composer_wrap: Element<'a, Message> = if showing_file {
        container(composer_block)
            .width(Length::Fill)
            .padding(iced::Padding {
                top: theme::P_XS,
                right: theme::P_SM,
                bottom: theme::P_SM,
                left: theme::P_SM,
            })
            .into()
    } else {
        let composer_width = if state.composer.text.trim().is_empty() {
            theme::COMPOSER_W_EMPTY
        } else {
            theme::COMPOSER_W
        };
        container(
            container(composer_block)
                .width(Length::Fixed(composer_width))
                .max_width(composer_width),
        )
        .width(Length::Fill)
        .center_x(Length::Fill)
        .padding(iced::Padding {
            top: 0.0,
            right: theme::P_XL,
            bottom: theme::P_XL,
            left: theme::P_XL,
        })
        .into()
    };


    let main = column![
        container(top).width(Length::Fill).height(Length::Fill),
        composer_wrap,
    ]
    .width(Length::Fill)
    .height(Length::Fill);

    container(main)
        .width(Length::Fill)
        .height(Length::Fill)
        .into()
}

// ── empty-state body ─────────────────────────────────────────────────────────
// With no file open, the main surface becomes the pane router: a thin
// segmented picker (Work / Plan / Impacts / Team / Proof / Memory /
// Timeline / Doctor / Orchestration / Handover) above the selected pane's
// body. Pane::Work keeps proto's welcome hero so the default vista is
// unchanged for day-one users.

fn empty_body<'a>(state: &'a App, ws: &'a Workspace) -> Element<'a, Message> {
    // Pane picker moved to the nav_rail (icon tiles with Work / Plan /
    // Impacts / Proof / Memory / Timeline / Doctor). The empty-state
    // body now just renders the selected pane's content directly —
    // no chrome strip on top.
    let body: Element<'a, Message> = match state.active_pane {
        Pane::Work => container(hero::view(ws))
            .width(Length::Fill)
            .height(Length::Fill)
            .center_x(Length::Fill)
            .center_y(Length::Fill)
            .into(),
        Pane::Plan => panes::plan::view(&state.panes.plan, |_| Message::None),
        Pane::Impacts => panes::impacts::view(&state.panes.impacts, |_| Message::None),
        Pane::Team => panes::team::view(&state.panes.team, |_| Message::None),
        Pane::Proof => panes::proof::view(&state.panes.proof, |_| Message::None),
        Pane::Memory => panes::memory::view(&state.panes.memory, |_| Message::None),
        Pane::Timeline => panes::timeline::view(&state.panes.timeline, |_| Message::None),
        Pane::Doctor => panes::doctor::view(&state.panes.doctor, |_| Message::None),
        Pane::Orchestration => panes::orchestration::view(
            panes::orchestration::Model {
                tiles: &state.panes.orchestration_tiles,
                active_plan: state.panes.orchestration_plan.as_deref(),
            },
            |_| Message::None,
        ),
        Pane::Conflict => panes::conflict::view(&state.panes.conflict, |_| Message::None),
        Pane::Handover => container(
            text("Press ⌘H to open the handover overlay.")
                .size(theme::SZ_BODY)
                .color(theme::TEXT_2),
        )
        .width(Length::Fill)
        .height(Length::Fill)
        .center_x(Length::Fill)
        .center_y(Length::Fill)
        .into(),
    };

    body
}

#[allow(dead_code)]
fn pane_picker<'a>(current: Pane) -> Element<'a, Message> {
    let items: [(Pane, &'static str); 10] = [
        (Pane::Work, "Work"),
        (Pane::Plan, "Plan"),
        (Pane::Impacts, "Impacts"),
        (Pane::Team, "Team"),
        (Pane::Proof, "Proof"),
        (Pane::Memory, "Memory"),
        (Pane::Timeline, "Timeline"),
        (Pane::Doctor, "Doctor"),
        (Pane::Orchestration, "Orchestration"),
        (Pane::Handover, "Handover"),
    ];

    let mut segments = row![].spacing(2);
    for (pane, label) in items {
        let active = pane == current;
        segments = segments.push(pane_segment(label, active, pane));
    }

    container(segments)
        .padding(Padding::from([theme::P_XS, theme::P_SM]))
        .width(Length::Fill)
        .into()
}

fn pane_segment<'a>(label: &'a str, active: bool, pane: Pane) -> Element<'a, Message> {
    let fg = if active { theme::TEXT_1 } else { theme::TEXT_3 };
    let bg = if active { theme::BG_2 } else { Color::TRANSPARENT };
    button(
        container(text(label).size(theme::SZ_META).color(fg))
            .padding(Padding::from([4.0, 10.0]))
            .center_y(Length::Shrink),
    )
    .on_press(Message::SelectPane(pane))
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

// Keep `Space` in scope for future spacers.
#[allow(dead_code)]
fn _space_keeper() -> Space {
    Space::new().width(Length::Fixed(0.0)).height(Length::Fixed(0.0))
}

// `Alignment` unused alias kept for future clustering of header row.
#[allow(dead_code)]
fn _alignment_keeper() -> Alignment {
    Alignment::Start
}
