//! Aura logo — two concentric circles, matches `aura-web/public/aura.svg`.
//! Rendered via `iced::widget::canvas` so it is crisp at any DPI and needs
//! no asset loading.

use iced::mouse;
use iced::widget::canvas::{self, Canvas, Frame, Geometry, Path, Stroke};
use iced::{Color, Element, Length, Point, Rectangle, Renderer, Theme, Vector};

pub struct Logo {
    pub size: f32,
    pub tint: Color,
}

impl Logo {
    pub fn new(size: f32, tint: Color) -> Self {
        Self { size, tint }
    }
}

pub fn view<'a, M: 'a>(size: f32, tint: Color) -> Element<'a, M> {
    Canvas::new(Logo::new(size, tint))
        .width(Length::Fixed(size))
        .height(Length::Fixed(size))
        .into()
}

impl<M> canvas::Program<M> for Logo {
    type State = ();

    fn draw(
        &self,
        _state: &Self::State,
        renderer: &Renderer,
        _theme: &Theme,
        bounds: Rectangle,
        _cursor: mouse::Cursor,
    ) -> Vec<Geometry<Renderer>> {
        let mut frame = Frame::new(renderer, bounds.size());
        let center = Point::new(bounds.width / 2.0, bounds.height / 2.0);
        let radius = (bounds.width.min(bounds.height) / 2.0) - 2.0;

        let ring = Path::circle(center, radius);
        frame.stroke(
            &ring,
            Stroke::default()
                .with_color(self.tint)
                .with_width((bounds.width * 0.08).max(1.5)),
        );

        let dot = Path::circle(center, radius * 0.32);
        frame.fill(&dot, self.tint);

        let _ = Vector::new(0.0, 0.0); // keep Vector import used for future hover
        vec![frame.into_geometry()]
    }
}
