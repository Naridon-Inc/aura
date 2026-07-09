//! Tab-completion popup — inline dropdown rendered above the composer
//! prompt when a completion cycle is active. The engine in
//! [`crate::completion`] produces a ranked list of candidates; this
//! module paints them and is otherwise stateless.

use iced::widget::{column, container, row, text, Space};
use iced::{Alignment, Background, Border, Color, Element, Length, Padding, Shadow};

use crate::app::CompletionUi;
use crate::completion::{Candidate, Source};
use crate::theme as t;

/// Render the popup. Returns `None` if the popup isn't active so the
/// caller can skip the layout slot entirely.
pub fn view<'a, M: 'a + Clone>(ui: &'a CompletionUi) -> Option<Element<'a, M>> {
    if ui.candidates.is_empty() {
        return None;
    }

    let mut col = column![].spacing(0.0);
    for (i, cand) in ui.candidates.iter().enumerate() {
        col = col.push(row_view::<M>(cand, i == ui.selected));
    }

    let hint = row![
        text("Tab").size(t::SZ_MICRO).color(t::TEXT_3).font(t::MONO_MED),
        Space::new().width(Length::Fixed(6.0)),
        text("apply").size(t::SZ_MICRO).color(t::TEXT_3),
        Space::new().width(Length::Fixed(12.0)),
        text("⇧Tab").size(t::SZ_MICRO).color(t::TEXT_3).font(t::MONO_MED),
        Space::new().width(Length::Fixed(6.0)),
        text("cycle").size(t::SZ_MICRO).color(t::TEXT_3),
        Space::new().width(Length::Fixed(12.0)),
        text("Enter").size(t::SZ_MICRO).color(t::TEXT_3).font(t::MONO_MED),
        Space::new().width(Length::Fixed(6.0)),
        text("submit").size(t::SZ_MICRO).color(t::TEXT_3),
        Space::new().width(Length::Fixed(12.0)),
        text("Esc").size(t::SZ_MICRO).color(t::TEXT_3).font(t::MONO_MED),
        Space::new().width(Length::Fixed(6.0)),
        text("dismiss").size(t::SZ_MICRO).color(t::TEXT_3),
    ]
    .align_y(Alignment::Center);

    let inner = column![col, Space::new().height(Length::Fixed(4.0)), hint]
        .padding(Padding::from([t::P_SM, t::P_SM]));

    Some(
        container(inner)
            .width(Length::Fill)
            .style(popover_style)
            .into(),
    )
}

fn row_view<'a, M: 'a>(cand: &'a Candidate, selected: bool) -> Element<'a, M> {
    let tag = source_tag(cand.source);
    let tag_color = source_color(cand.source);

    let tag_el = container(
        text(tag).size(t::SZ_MICRO).color(tag_color).font(t::MONO_MED),
    )
    .padding(Padding::from([2.0, 6.0]))
    .style(kbd_chip_style);

    let display_color = if selected { t::TEXT_1 } else { t::TEXT_2 };

    let row_inner = row![
        tag_el,
        Space::new().width(Length::Fixed(10.0)),
        text(cand.display.clone())
            .size(t::SZ_META)
            .color(display_color)
            .font(t::MONO),
    ]
    .align_y(Alignment::Center);

    container(row_inner)
        .padding(Padding::from([6.0, 8.0]))
        .width(Length::Fill)
        .style(move |_| row_style(selected))
        .into()
}

fn source_tag(source: Source) -> &'static str {
    match source {
        Source::Command => "cmd",
        Source::File => "file",
        Source::Branch => "git",
    }
}

fn source_color(source: Source) -> iced::Color {
    match source {
        Source::Command => t::ACCENT,
        Source::File => t::TEXT_2,
        Source::Branch => t::VIOLET,
    }
}

fn popover_style(_theme: &iced::Theme) -> iced::widget::container::Style {
    iced::widget::container::Style {
        background: Some(Background::Color(t::BG_1)),
        border: Border {
            color: t::LINE,
            width: 1.0,
            radius: 10.0.into(),
        },
        shadow: Shadow {
            color: Color { r: 0.0, g: 0.0, b: 0.0, a: 0.55 },
            offset: iced::Vector { x: 0.0, y: 8.0 },
            blur_radius: 28.0,
        },
        ..Default::default()
    }
}

fn kbd_chip_style(_theme: &iced::Theme) -> iced::widget::container::Style {
    iced::widget::container::Style {
        background: Some(Background::Color(t::BG_2)),
        border: Border {
            color: t::LINE,
            width: 1.0,
            radius: 4.0.into(),
        },
        ..Default::default()
    }
}

fn row_style(selected: bool) -> iced::widget::container::Style {
    let bg = if selected { t::BG_2 } else { Color::TRANSPARENT };
    iced::widget::container::Style {
        background: Some(Background::Color(bg)),
        border: Border {
            color: Color::TRANSPARENT,
            width: 0.0,
            radius: 6.0.into(),
        },
        ..Default::default()
    }
}
