//! Bottom status bar — Warp-signature row of compact chips: cwd, branch,
//! changed files, task progress, model selector, mic/image actions. Hovers
//! over everything else; stays at 32px.

use iced::widget::{button, container, row, text, Space};
use iced::{Alignment, Element, Length, Padding};

use crate::ui::icon;
use crate::ui::style;
use crate::theme as t;

pub struct Model<'a> {
    pub cwd: &'a str,
    pub branch: &'a str,
    pub changed_files: u32,
    pub diff_added: u32,
    pub diff_removed: u32,
    pub task_done: u32,
    pub task_total: u32,
    pub model_label: &'a str,
}

pub fn view<'a, M: 'a + Clone>(model: Model<'a>) -> Element<'a, M> {
    let cwd_chip = chip(icon::Icon::Folder, model.cwd.to_string(), t::TEXT_MUTED);
    let branch_chip = chip(icon::Icon::Branch, model.branch.to_string(), t::TEXT_MUTED);

    let diff_label = format!(
        "{}  +{} -{}",
        model.changed_files, model.diff_added, model.diff_removed
    );
    let diff_chip = chip_multi(icon::Icon::File, diff_label, (t::DIFF_ADD, t::DIFF_REM));

    let tasks_chip = chip(
        icon::Icon::List,
        format!("{}/{}", model.task_done, model.task_total),
        t::TEXT_MUTED,
    );

    let model_selector = button(
        row![
            text(model.model_label.to_string())
                .size(t::SZ_META)
                .color(t::TEXT_MUTED),
            Space::new().width(Length::Fixed(6.0)),
            icon::svg_colored(icon::Icon::ChevronDown, t::SZ_META, t::TEXT_DIM),
        ]
        .align_y(Alignment::Center),
    )
    .padding(Padding::from([3, 10]))
    .style(style::chip_button(false));

    let mic = small_icon_btn(icon::Icon::Mic);
    let image = small_icon_btn(icon::Icon::Image);

    let content = row![
        cwd_chip,
        sep(),
        branch_chip,
        sep(),
        diff_chip,
        sep(),
        tasks_chip,
        Space::new().width(Length::Fill),
        model_selector,
        Space::new().width(Length::Fixed(t::P_SM)),
        mic,
        Space::new().width(Length::Fixed(t::P_XS)),
        image,
    ]
    .align_y(Alignment::Center)
    .padding(Padding::from([0, 12]));

    container(content)
        .width(Length::Fill)
        .height(Length::Fixed(t::STATUSBAR_H))
        .style(style::statusbar)
        .into()
}

fn chip<'a, M: 'a>(
    glyph: icon::Icon,
    label: String,
    color: iced::Color,
) -> Element<'a, M> {
    let inner = row![
        icon::svg_colored(glyph, t::SZ_META, t::TEXT_DIM),
        Space::new().width(Length::Fixed(6.0)),
        text(label).size(t::SZ_META).color(color),
    ]
    .align_y(Alignment::Center);
    container(inner)
        .padding(Padding::from([4, 8]))
        .style(style::chip_soft(t::PANE_ALT, color))
        .into()
}

fn chip_multi<'a, M: 'a>(
    glyph: icon::Icon,
    label: String,
    (add, rem): (iced::Color, iced::Color),
) -> Element<'a, M> {
    let mut segs = row![
        icon::svg_colored(glyph, t::SZ_META, t::TEXT_DIM),
        Space::new().width(Length::Fixed(6.0)),
    ]
    .align_y(Alignment::Center);

    // "N  +X -Y" — color the +/- spans. Keep the count neutral.
    let mut parts = label.splitn(2, ' ');
    let count = parts.next().unwrap_or("").to_string();
    let rest = parts.next().unwrap_or("").to_string();
    segs = segs.push(text(count).size(t::SZ_META).color(t::TEXT_MUTED));

    if let Some((plus, minus)) = split_diff(&rest) {
        segs = segs.push(Space::new().width(Length::Fixed(6.0)));
        segs = segs.push(text(plus).size(t::SZ_META).color(add));
        segs = segs.push(Space::new().width(Length::Fixed(4.0)));
        segs = segs.push(text(minus).size(t::SZ_META).color(rem));
    }

    container(segs)
        .padding(Padding::from([4, 8]))
        .style(style::chip_soft(t::PANE_ALT, t::TEXT_MUTED))
        .into()
}

fn split_diff(s: &str) -> Option<(String, String)> {
    let parts: Vec<&str> = s.split_whitespace().collect();
    if parts.len() >= 2 {
        Some((parts[0].to_string(), parts[1].to_string()))
    } else {
        None
    }
}

fn sep<'a, M: 'a>() -> Element<'a, M> {
    Space::new().width(Length::Fixed(t::P_SM)).into()
}

fn small_icon_btn<'a, M: 'a>(glyph: icon::Icon) -> Element<'a, M> {
    container(icon::svg_colored(glyph, t::SZ_BODY, t::TEXT_DIM))
        .padding(Padding::from([4, 6]))
        .style(style::chip_flat(t::PANE_ALT, t::TEXT_DIM))
        .into()
}
