//! The rectangle a terminal is laid out for, and the difference between
//! putting a terminal away and making it smaller.
//!
//! A pane that is not on screen — a workspace you switched away from, a tab
//! behind another, an agent whose chat view is up — is *parked*: the frontend
//! moves its surface far offscreen at 1×1 points (`PARKED` in
//! `lib/nativeSurfacePlacement.ts`). That used to arrive here as an ordinary
//! resize, so the grid was reflowed to one column and the program in the pane
//! got a `SIGWINCH` saying its window was 1×1. For an agent that is the real
//! agent PTY: Claude Code redrew its whole TUI into a single column on every
//! switch away, and again at full width on every switch back — two full
//! reflows and two bursts of output per pane per switch, multiplied by every
//! agent in every workspace that was open.
//!
//! Parking is not a size. The hole a terminal was laid out for survives a
//! park, so coming back at the same size tells nobody anything, and only a
//! pane that genuinely changed shape while it was away is resized.

/// True when a bounds update is a park rather than a real hole.
///
/// No pane is ever a point wide, so anything at or under 1×1 points can only
/// be the parked rectangle.
pub(super) fn is_park(width: f64, height: f64) -> bool {
    width <= 1.0 && height <= 1.0
}

/// What the render thread knows about where it is drawing.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(super) struct Hole {
    /// The hole the grid and the program were last sized for, in physical
    /// pixels. Kept across a park.
    w: u32,
    h: u32,
    parked: bool,
}

impl Hole {
    pub(super) fn new(w: u32, h: u32) -> Self {
        Self {
            w: w.max(1),
            h: h.max(1),
            parked: false,
        }
    }

    pub(super) fn is_parked(&self) -> bool {
        self.parked
    }

    /// Put the terminal away. Never changes the hole, so it can never be the
    /// reason the grid or the program is resized.
    pub(super) fn park(&mut self) {
        self.parked = true;
    }

    /// Show the terminal over a real hole of `w`×`h` pixels. Returns true only
    /// when that differs from the hole the grid was laid out for — the one case
    /// the grid and the program in the pane must be told.
    pub(super) fn place(&mut self, w: u32, h: u32) -> bool {
        let (w, h) = (w.max(1), h.max(1));
        self.parked = false;
        let changed = (w, h) != (self.w, self.h);
        self.w = w;
        self.h = h;
        changed
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_parked_rectangle_is_a_park_and_no_real_pane_is() {
        assert!(is_park(1.0, 1.0));
        assert!(is_park(0.0, 0.0));
        assert!(!is_park(1.0, 400.0));
        assert!(!is_park(640.0, 1.0));
        assert!(!is_park(800.0, 600.0));
    }

    #[test]
    fn park_then_return_at_the_same_size_resizes_nothing() {
        let mut hole = Hole::new(1600, 1000);
        hole.park();
        assert!(hole.is_parked());
        assert!(!hole.place(1600, 1000), "a switch back must not SIGWINCH the pane");
        assert!(!hole.is_parked());
    }

    #[test]
    fn a_pane_that_changed_shape_while_away_is_resized_once() {
        let mut hole = Hole::new(1600, 1000);
        hole.park();
        assert!(hole.place(1200, 1000));
        assert!(!hole.place(1200, 1000));
    }

    #[test]
    fn parking_twice_keeps_the_hole() {
        let mut hole = Hole::new(800, 600);
        hole.park();
        hole.park();
        assert!(!hole.place(800, 600));
    }
}
