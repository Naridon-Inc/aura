use iced::widget::canvas::{self, Canvas, Frame, Geometry, Path, Stroke};
use iced::widget::{column, container, row as row_widget, text, Space};
use iced::{Color, Element, Length, Padding, Point, Rectangle, Renderer, Theme};

use crate::{
    fixtures::{graph_lane_colors, GitGraph, GitGraphRow, GitTag, GitTagKind},
    theme, Message,
};

pub const ROW_H: f32 = 26.0;
pub const LANE_W: f32 = 14.0;
pub const GUTTER_LEFT: f32 = 12.0;
pub const GUTTER_RIGHT: f32 = 8.0;
pub const DOT_R: f32 = 4.5;
pub const DOT_INNER_R: f32 = 2.0;
pub const STROKE_W: f32 = 1.8;

/// Full railway view, taking ownership of the graph so the returned `Element`
/// has no borrow against the caller. The canvas program keeps its own clone.
pub fn view_owned<'a>(graph: GitGraph) -> Element<'a, Message> {
    let gutter_w = GUTTER_LEFT + (graph.lane_count as f32) * LANE_W + GUTTER_RIGHT;
    let total_h = ROW_H * (graph.rows.len() as f32);

    // Text column first — borrows the owned graph's rows before we hand it to
    // the canvas program.
    let mut rows_col = column![].spacing(0.0);
    for r in graph.rows.iter() {
        rows_col = rows_col.push(text_row_owned(r.clone()));
    }

    let gutter = Canvas::new(GraphProgram { graph })
        .width(Length::Fixed(gutter_w))
        .height(Length::Fixed(total_h));

    row_widget![
        gutter,
        container(rows_col).width(Length::Fill).height(Length::Fixed(total_h)),
    ]
    .into()
}

fn text_row_owned<'a>(r: GitGraphRow) -> Element<'a, Message> {
    let subject = text(r.subject)
        .size(theme::SZ_META)
        .style(|_| iced::widget::text::Style { color: Some(theme::TEXT_1) });

    let mut line = row_widget![subject].align_y(iced::Alignment::Center);

    if let Some(tag) = r.tag {
        line = line.push(Space::new().width(Length::Fixed(8.0)).height(0.0));
        line = line.push(tag_pill_owned(tag));
    }

    container(line)
        .width(Length::Fill)
        .height(Length::Fixed(ROW_H))
        .padding(Padding { top: 0.0, right: theme::P_SM, bottom: 0.0, left: 0.0 })
        .align_y(iced::alignment::Vertical::Center)
        .into()
}

fn tag_pill_owned<'a>(tag: GitTag) -> Element<'a, Message> {
    let (bg, fg, border_color, border_w) = match tag.kind {
        GitTagKind::Remote => (
            Color { r: 0.55, g: 0.35, b: 0.75, a: 0.35 },
            theme::TEXT_1,
            theme::VIOLET,
            1.0,
        ),
        GitTagKind::Branch => (Color::TRANSPARENT, theme::TEXT_2, theme::LINE_SOFT, 1.0),
    };

    container(
        text(tag.label)
            .size(theme::SZ_MICRO)
            .style(move |_| iced::widget::text::Style { color: Some(fg) }),
    )
    .padding(Padding::from([1.0, 6.0]))
    .style(move |_| {
        iced::widget::container::Style::default()
            .background(bg)
            .border(iced::Border { color: border_color, width: border_w, radius: 7.0.into() })
    })
    .into()
}

// ─── Canvas program ─────────────────────────────────────────────────────────

struct GraphProgram {
    graph: GitGraph,
}

impl canvas::Program<Message> for GraphProgram {
    type State = ();

    fn draw(
        &self,
        _state: &Self::State,
        renderer: &Renderer,
        _theme: &Theme,
        bounds: Rectangle,
        _cursor: iced::mouse::Cursor,
    ) -> Vec<Geometry> {
        let mut frame = Frame::new(renderer, bounds.size());
        let colors = graph_lane_colors();

        // ─── Edges ──────────────────────────────────────────────────────────
        for edge in &self.graph.edges {
            let color = colors
                .get(edge.color_idx as usize)
                .copied()
                .unwrap_or(theme::TEXT_3);

            let from_center = row_center(edge.from_row, edge.from_lane);
            let to_center = row_center(edge.to_row, edge.to_lane);

            // We draw from the commit BELOW (from_row — parent, higher row idx)
            // upward to the commit ABOVE (to_row — child). Visually the path
            // starts at the parent's dot and ends at the child's dot.
            let path = Path::new(|p| {
                p.move_to(from_center);
                if edge.from_lane == edge.to_lane {
                    p.line_to(to_center);
                } else {
                    // Smooth S-curve between the two lanes. Halfway up, bend
                    // horizontally toward the child's lane.
                    let mid_y = (from_center.y + to_center.y) / 2.0;
                    let c1 = Point::new(from_center.x, mid_y);
                    let c2 = Point::new(to_center.x, mid_y);
                    p.bezier_curve_to(c1, c2, to_center);
                }
            });
            frame.stroke(
                &path,
                Stroke::default()
                    .with_color(color)
                    .with_width(STROKE_W)
                    .with_line_cap(canvas::LineCap::Round),
            );
        }

        // ─── Dots ───────────────────────────────────────────────────────────
        for (i, r) in self.graph.rows.iter().enumerate() {
            let c = row_center(i, r.dot_lane);
            let color = colors
                .get(r.color_idx as usize)
                .copied()
                .unwrap_or(theme::TEXT_3);

            if r.is_merge {
                // Hollow ring + inner dot: `◉` glyph.
                frame.fill(&Path::circle(c, DOT_R + 1.0), canvas::Fill::from(theme::BG_CHROME));
                frame.stroke(
                    &Path::circle(c, DOT_R),
                    Stroke::default().with_color(color).with_width(STROKE_W),
                );
                frame.fill(&Path::circle(c, DOT_INNER_R), canvas::Fill::from(color));
            } else {
                // Punch through edges beneath the dot with the background fill.
                frame.fill(&Path::circle(c, DOT_R + 0.5), canvas::Fill::from(theme::BG_CHROME));
                frame.fill(&Path::circle(c, DOT_R), canvas::Fill::from(color));
            }
        }

        vec![frame.into_geometry()]
    }
}

fn row_center(row_idx: usize, lane: u8) -> Point {
    Point::new(
        GUTTER_LEFT + (lane as f32) * LANE_W + LANE_W / 2.0,
        (row_idx as f32) * ROW_H + ROW_H / 2.0,
    )
}
