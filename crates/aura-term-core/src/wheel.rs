//! What a scroll wheel means to a terminal.
//!
//! It means three different things, and which one depends entirely on what the
//! child program is doing:
//!
//! * At a shell prompt the wheel belongs to the *terminal*: it moves a viewport
//!   over the scrollback, and the child never hears about it.
//! * Inside a full-screen program — an editor, a pager, an agent CLI — there is
//!   no scrollback to move. The alternate screen is exactly one screen tall, so
//!   a viewport offset has nowhere to go and scrolling it is a silent no-op.
//!   The wheel belongs to the *program* there, and the terminal's job is to
//!   translate it into something the program understands: arrow keys (DECSET
//!   1007, `ALTERNATE_SCROLL`, which is on by default) or, if the program asked
//!   for mouse reporting, wheel buttons.
//!
//! Getting this wrong is invisible in a shell and total in a TUI, which is the
//! shape of the bug this module exists to kill: a wheel that moved an offset
//! the alternate screen clamps straight back to zero looks, to the person
//! holding the trackpad, exactly like a terminal that cannot scroll.
//!
//! The decision is kept here, away from platform event plumbing, because it is
//! the part worth testing: the AppKit and DOM sides are a handful of lines that
//! read a delta off an event, and everything that can be reasoned about is
//! below.

/// Lines moved per notch of a notched (non-precise) wheel.
///
/// Both platform paths multiply by this so a notch feels the same whether the
/// event arrived through AppKit or the DOM.
pub const LINES_PER_NOTCH: i32 = 3;

/// Upper bound on keys or reports synthesised from a single wheel event.
///
/// A fling on a trackpad can accumulate a large jump; a program that is being
/// sent one arrow key per line does not need two hundred of them in one go,
/// and a runaway count is how an input path turns into a hang.
const MAX_SYNTHETIC: i32 = 16;

/// Which way the wheel moved, in whatever units the platform handed us.
#[derive(Debug, Clone, Copy, PartialEq)]
pub enum WheelInput {
    /// A trackpad or precise wheel: a distance in pixels. Positive moves the
    /// viewport toward *older* output.
    ///
    /// That is AppKit's `scrollingDeltaY` convention. The DOM's `wheel.deltaY`
    /// is its negation, so the web side flips the sign before it gets here.
    Pixels(f64),
    /// A notched wheel, already counted in lines. Positive = older.
    Lines(i32),
}

/// The terminal modes that change what a wheel event should do.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub struct WheelModes {
    /// The alternate screen is active: there is no scrollback to move.
    pub alt_screen: bool,
    /// The program asked for mouse reporting (any of the mouse modes).
    pub mouse_report: bool,
    /// Mouse reports should use the SGR encoding (DECSET 1006).
    pub sgr_mouse: bool,
    /// Cursor keys should be sent in application mode (DECCKM): `ESC O A`
    /// rather than `ESC [ A`. Pagers and editors routinely turn this on.
    pub app_cursor: bool,
    /// Wheel events may be translated to cursor keys on the alternate screen
    /// (DECSET 1007). On by default, which is why a pager responds to a wheel
    /// at all.
    pub alternate_scroll: bool,
}

/// What the terminal should do with a wheel event.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum WheelAction {
    /// Nothing to do: no movement crossed a line boundary, or the program is
    /// on the alternate screen and has asked for neither translation.
    None,
    /// Move the viewport within the scrollback. Positive = toward older.
    Scroll(i32),
    /// Send these bytes to the child program.
    Send(Vec<u8>),
}

/// Accumulates sub-line pixel deltas for one terminal.
///
/// A trackpad reports a few pixels at a time, far less than a line. Rounding
/// each event on its own throws all of it away and the view never moves; the
/// remainder has to live between events, which is why this is a value the
/// caller keeps rather than a free function.
#[derive(Debug, Default, Clone)]
pub struct WheelAccum {
    rest: f64,
}

impl WheelAccum {
    pub fn new() -> Self {
        Self::default()
    }

    /// Convert one wheel event into whole lines, carrying the remainder.
    ///
    /// `cell_h` is the line height in the same pixels the delta is measured in.
    pub fn lines(&mut self, input: WheelInput, cell_h: f64) -> i32 {
        match input {
            WheelInput::Lines(n) => {
                // A notch is a discrete thing; a pending fraction of a
                // trackpad gesture has nothing to do with it.
                self.rest = 0.0;
                n
            }
            WheelInput::Pixels(px) => {
                if px == 0.0 || !px.is_finite() {
                    return 0;
                }
                let h = if cell_h.is_finite() && cell_h >= 1.0 { cell_h } else { 1.0 };
                // Reversing direction mid-gesture abandons what was pending,
                // so a flick back does not have to pay off the old remainder
                // before it moves.
                if self.rest != 0.0 && self.rest.signum() != px.signum() {
                    self.rest = 0.0;
                }
                self.rest += px;
                let lines = (self.rest / h).trunc();
                self.rest -= lines * h;
                lines as i32
            }
        }
    }
}

/// Where in a view a point falls, as a 0..1 fraction of its size.
///
/// A platform's wheel event carries a position in that platform's pixels; the
/// part of the engine that knows how big a cell is works in fractions, because
/// a fraction survives a backing-scale or font change that a pixel count would
/// not.
pub fn frac_in_view(point: (f64, f64), size: (f64, f64)) -> (f32, f32) {
    let fx = if size.0 > 0.0 { point.0 / size.0 } else { 0.0 };
    let fy = if size.1 > 0.0 { point.1 / size.1 } else { 0.0 };
    (fx.clamp(0.0, 1.0) as f32, fy.clamp(0.0, 1.0) as f32)
}

/// Decide what a wheel movement of `lines` should do.
///
/// `at` is the cell the pointer is over, zero-based, used only for mouse
/// reports (which carry a position whether or not the program reads it).
pub fn action(lines: i32, modes: WheelModes, at: (u16, u16)) -> WheelAction {
    if lines == 0 {
        return WheelAction::None;
    }

    // The normal screen has scrollback, and reaching it is the whole point of
    // a wheel. Mouse reporting does not take that away: a program that turns
    // on mouse tracking without leaving the normal screen does not thereby own
    // the user's history.
    if !modes.alt_screen {
        return WheelAction::Scroll(lines);
    }

    let up = lines > 0;
    let count = lines.abs().min(MAX_SYNTHETIC) as usize;

    if modes.mouse_report {
        return WheelAction::Send(wheel_reports(up, count, at, modes.sgr_mouse));
    }
    if modes.alternate_scroll {
        return WheelAction::Send(cursor_keys(up, count, modes.app_cursor));
    }
    // A full-screen program that wants neither gets nothing — swallowing the
    // wheel is correct here, and inventing keys for it would be worse.
    WheelAction::None
}

/// `count` cursor keys, up or down, in the encoding the program asked for.
fn cursor_keys(up: bool, count: usize, app_cursor: bool) -> Vec<u8> {
    let key: &[u8] = match (app_cursor, up) {
        (false, true) => b"\x1b[A",
        (false, false) => b"\x1b[B",
        (true, true) => b"\x1bOA",
        (true, false) => b"\x1bOB",
    };
    let mut out = Vec::with_capacity(key.len() * count);
    for _ in 0..count {
        out.extend_from_slice(key);
    }
    out
}

/// `count` wheel-button reports at `at`.
///
/// Wheel up is button 64, wheel down 65 — the codes every mouse-aware program
/// already listens for.
fn wheel_reports(up: bool, count: usize, at: (u16, u16), sgr: bool) -> Vec<u8> {
    let button: u8 = if up { 64 } else { 65 };
    // Reports are one-based.
    let col = at.0.saturating_add(1);
    let row = at.1.saturating_add(1);
    let mut out = Vec::new();
    for _ in 0..count {
        if sgr {
            out.extend_from_slice(format!("\x1b[<{button};{col};{row}M").as_bytes());
        } else {
            // X10: three bytes biased by 32, which caps the reportable
            // position at 223. Past that the position is meaningless but the
            // button still is, so clamp rather than drop the report.
            out.extend_from_slice(b"\x1b[M");
            out.push(32u8.saturating_add(button));
            out.push(32u8.saturating_add(col.min(223) as u8));
            out.push(32u8.saturating_add(row.min(223) as u8));
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    fn normal() -> WheelModes {
        WheelModes { alternate_scroll: true, ..WheelModes::default() }
    }

    fn alt() -> WheelModes {
        WheelModes { alt_screen: true, alternate_scroll: true, ..WheelModes::default() }
    }

    // Part of the defect this module was written for: a wheel handler that
    // branched on `delta < 0 ? up : down` turned every zero-delta event — and
    // macOS sends one at the start and end of every trackpad gesture — into a
    // scroll *down*. A short flick up, which is begin, one small movement and
    // end, therefore netted downward.
    #[test]
    fn zero_delta_does_nothing_in_either_direction() {
        let mut accum = WheelAccum::new();
        assert_eq!(accum.lines(WheelInput::Pixels(0.0), 16.0), 0);
        assert_eq!(accum.lines(WheelInput::Lines(0), 16.0), 0);
        assert_eq!(action(0, normal(), (0, 0)), WheelAction::None);
    }

    #[test]
    fn sub_line_pixel_deltas_accumulate_into_a_line() {
        let mut accum = WheelAccum::new();
        // Four 5px nudges with a 16px line: nothing, nothing, nothing, one line.
        assert_eq!(accum.lines(WheelInput::Pixels(5.0), 16.0), 0);
        assert_eq!(accum.lines(WheelInput::Pixels(5.0), 16.0), 0);
        assert_eq!(accum.lines(WheelInput::Pixels(5.0), 16.0), 0);
        assert_eq!(accum.lines(WheelInput::Pixels(5.0), 16.0), 1);
        // And the remainder carries rather than being lost.
        assert_eq!(accum.lines(WheelInput::Pixels(12.0), 16.0), 1);
    }

    #[test]
    fn pixel_magnitude_is_respected() {
        let mut accum = WheelAccum::new();
        assert_eq!(accum.lines(WheelInput::Pixels(160.0), 16.0), 10);
        assert_eq!(accum.lines(WheelInput::Pixels(-160.0), 16.0), -10);
    }

    #[test]
    fn reversing_direction_drops_the_pending_remainder() {
        let mut accum = WheelAccum::new();
        assert_eq!(accum.lines(WheelInput::Pixels(12.0), 16.0), 0);
        // Without the reset this would owe 12px before moving down at all.
        assert_eq!(accum.lines(WheelInput::Pixels(-16.0), 16.0), -1);
    }

    #[test]
    fn degenerate_cell_height_cannot_divide_by_zero() {
        let mut accum = WheelAccum::new();
        assert_eq!(accum.lines(WheelInput::Pixels(4.0), 0.0), 4);
        let mut accum = WheelAccum::new();
        assert_eq!(accum.lines(WheelInput::Pixels(4.0), f64::NAN), 4);
    }

    #[test]
    fn normal_screen_scrolls_the_scrollback() {
        assert_eq!(action(3, normal(), (0, 0)), WheelAction::Scroll(3));
        assert_eq!(action(-3, normal(), (0, 0)), WheelAction::Scroll(-3));
    }

    // A mouse-tracking program on the normal screen does not own the history.
    #[test]
    fn normal_screen_scrolls_even_with_mouse_reporting_on() {
        let modes = WheelModes { mouse_report: true, ..normal() };
        assert_eq!(action(3, modes, (0, 0)), WheelAction::Scroll(3));
    }

    // The alternate screen is one screen tall: scrolling it moves nothing, so
    // the wheel has to reach the program instead.
    #[test]
    fn alt_screen_sends_cursor_keys() {
        assert_eq!(action(2, alt(), (0, 0)), WheelAction::Send(b"\x1b[A\x1b[A".to_vec()));
        assert_eq!(action(-2, alt(), (0, 0)), WheelAction::Send(b"\x1b[B\x1b[B".to_vec()));
    }

    #[test]
    fn alt_screen_honours_application_cursor_mode() {
        let modes = WheelModes { app_cursor: true, ..alt() };
        assert_eq!(action(1, modes, (0, 0)), WheelAction::Send(b"\x1bOA".to_vec()));
    }

    #[test]
    fn alt_screen_sends_sgr_wheel_reports_when_asked() {
        let modes = WheelModes { mouse_report: true, sgr_mouse: true, ..alt() };
        // Cell (4, 9) zero-based reports as column 5, row 10.
        assert_eq!(action(1, modes, (4, 9)), WheelAction::Send(b"\x1b[<64;5;10M".to_vec()));
        assert_eq!(action(-1, modes, (4, 9)), WheelAction::Send(b"\x1b[<65;5;10M".to_vec()));
    }

    #[test]
    fn alt_screen_sends_x10_wheel_reports_without_sgr() {
        let modes = WheelModes { mouse_report: true, ..alt() };
        assert_eq!(
            action(1, modes, (0, 0)),
            WheelAction::Send(vec![0x1b, b'[', b'M', 32 + 64, 33, 33])
        );
    }

    #[test]
    fn alt_screen_without_alternate_scroll_swallows_the_wheel() {
        let modes = WheelModes { alt_screen: true, ..WheelModes::default() };
        assert_eq!(action(5, modes, (0, 0)), WheelAction::None);
    }

    #[test]
    fn frac_in_view_maps_the_middle_to_a_half() {
        assert_eq!(frac_in_view((400.0, 150.0), (800.0, 300.0)), (0.5, 0.5));
    }

    #[test]
    fn frac_in_view_clamps_points_outside_the_view() {
        assert_eq!(frac_in_view((-10.0, 400.0), (800.0, 300.0)), (0.0, 1.0));
    }

    // A surface parked offscreen at 1x1, or caught mid-teardown, must not
    // divide by zero on its way to a crash.
    #[test]
    fn frac_in_view_survives_a_degenerate_size() {
        assert_eq!(frac_in_view((5.0, 5.0), (0.0, 0.0)), (0.0, 0.0));
    }

    #[test]
    fn synthetic_keys_are_capped() {
        let keys = match action(1000, alt(), (0, 0)) {
            WheelAction::Send(b) => b,
            other => panic!("expected keys, got {other:?}"),
        };
        assert_eq!(keys.len(), MAX_SYNTHETIC as usize * 3);
    }
}
