//! The clip — how much of a terminal's hole the native surface is actually
//! allowed to paint right now.
//!
//! A native terminal is an NSView that is a *sibling* of the webview, added
//! last to the window's `contentView`, so it paints above every z-index the
//! page can produce. That is fine until the page opens something over it: a
//! menu, a popover, a sheet. There is no in-page way to win that fight, and
//! for a while the shell dealt with it by taking the surface away entirely
//! while an overlay was open — which turned a menu click into a black pane.
//!
//! The clip is the third answer. The frontend measures the largest
//! sub-rectangle of the hole that no open overlay is sitting on (see
//! `nativeSurfacePlacement.ts`), and the surface is moved and sized to *that*
//! while the hole — and therefore the grid, the PTY's window size, and the
//! shell's idea of how many columns it has — stays exactly as it was. A menu
//! hides the part of the terminal it is physically on and nothing else. No
//! reflow, no `SIGWINCH`, no reflowed scrollback, no TUI redrawing itself
//! because someone opened a context menu.
//!
//! Two coordinate systems meet here and keeping them apart is the whole job:
//!
//! * The command boundary speaks **window points** (`ClipRect`), the same
//!   space the hole's `x/y/width/height` arrive in, because that is what
//!   AppKit wants for a view frame.
//! * The render thread speaks **physical pixels relative to the hole's own
//!   origin** (`ClipPx`), because that is the space the glyph geometry is
//!   built in and the space the swapchain is sized in.
//!
//! `ClipPx` is also the only thing that can repair a wheel event. The view's
//! `scrollWheel:` reports the pointer as a fraction of the *view's* bounds,
//! which under a clip is a fraction of the clip — but the cell it means has to
//! be found against the full grid. [`ClipPx::to_hole_frac`] is that
//! conversion, and it is why this module is pure arithmetic with tests
//! instead of three lines inlined in the render loop.

use serde::Deserialize;

/// The clip as it arrives from the frontend: absolute window points, the same
/// space as the hole's own bounds. `None` on the command means "no overlay is
/// in the way", which the render loop reads as the full hole.
#[derive(Clone, Copy, Debug, Deserialize)]
pub struct ClipRect {
    pub x: f64,
    pub y: f64,
    pub w: f64,
    pub h: f64,
}

/// The clip in physical pixels, measured from the hole's top-left corner.
///
/// Invariant maintained by [`ClipPx::resolve`]: the rect is non-empty and lies
/// inside `hole_w` x `hole_h`. The render loop depends on that — it sizes the
/// swapchain from `w`/`h` and would hand wgpu a zero or oversized drawable
/// otherwise.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct ClipPx {
    pub x: u32,
    pub y: u32,
    pub w: u32,
    pub h: u32,
}

impl ClipPx {
    /// The clip that covers an entire hole — the state every terminal is born
    /// in and returns to when the last overlay closes.
    pub fn full(hole_w: u32, hole_h: u32) -> Self {
        Self {
            x: 0,
            y: 0,
            w: hole_w.max(1),
            h: hole_h.max(1),
        }
    }

    /// Turn a frontend `ClipRect` in window points into a hole-relative pixel
    /// rect, clamped into the hole.
    ///
    /// Clamping rather than rejecting is deliberate. The two rects are
    /// measured in the same DOM frame but they arrive as separate floats
    /// through a JSON boundary and get scaled by the device ratio, so a clip
    /// that is mathematically flush with the hole's right edge can land a
    /// fraction of a pixel outside it. A frame drawn one pixel narrow is
    /// invisible; a swapchain larger than its view is a Metal validation
    /// failure.
    pub fn resolve(
        clip: Option<ClipRect>,
        hole_x: f64,
        hole_y: f64,
        hole_w: u32,
        hole_h: u32,
        scale: f64,
    ) -> Self {
        let hole_w = hole_w.max(1);
        let hole_h = hole_h.max(1);
        let Some(c) = clip else {
            return Self::full(hole_w, hole_h);
        };
        let scale = if scale <= 0.0 { 1.0 } else { scale };

        let x = (((c.x - hole_x) * scale).round().max(0.0) as u32).min(hole_w - 1);
        let y = (((c.y - hole_y) * scale).round().max(0.0) as u32).min(hole_h - 1);
        let w = ((c.w * scale).round().max(1.0) as u32).min(hole_w - x);
        let h = ((c.h * scale).round().max(1.0) as u32).min(hole_h - y);
        Self { x, y, w, h }
    }

    /// The offset to shift a frame's geometry by so the grid still appears at
    /// the hole's origin after the view has moved to the clip.
    ///
    /// Negative by construction: the view's own origin now sits somewhere down
    /// inside the terminal, so row 0 has to be pushed back up above the top
    /// edge, where the scissor discards it.
    pub fn geometry_offset(&self) -> (f32, f32) {
        (-(self.x as f32), -(self.y as f32))
    }

    /// Re-base a fraction of the *clip* into a fraction of the *hole*.
    ///
    /// This is the wheel's repair. `scrollWheel:` on the surface view reports
    /// the pointer against the view's bounds, and the view is the clip, so a
    /// pointer halfway down a clip that starts two thirds of the way down the
    /// hole is nowhere near the middle row. Mouse reporting on the alternate
    /// screen sends that cell to the program, so getting it wrong means a
    /// full-screen app being told the wheel turned on the wrong line.
    ///
    /// Selection does *not* come through here: those fractions are measured in
    /// JS against the DOM hole, which keeps its full size whatever the clip is
    /// doing, so they are already in the right space.
    pub fn to_hole_frac(&self, fx: f32, fy: f32, hole_w: u32, hole_h: u32) -> (f32, f32) {
        let hole_w = hole_w.max(1) as f32;
        let hole_h = hole_h.max(1) as f32;
        let hx = (self.x as f32 + frac(fx) * self.w as f32) / hole_w;
        let hy = (self.y as f32 + frac(fy) * self.h as f32) / hole_h;
        (frac(hx), frac(hy))
    }
}

/// Clamp an incoming fraction into 0..1, reading anything non-finite as the
/// near edge. `f32::clamp` propagates NaN rather than clamping it, and a NaN
/// here would reach a cell index — so it is caught at the door instead.
fn frac(v: f32) -> f32 {
    if v.is_finite() {
        v.clamp(0.0, 1.0)
    } else {
        0.0
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const SCALE: f64 = 2.0;

    #[test]
    fn no_clip_is_the_whole_hole() {
        let c = ClipPx::resolve(None, 280.0, 100.0, 1680, 1542, SCALE);
        assert_eq!(c, ClipPx::full(1680, 1542));
        assert_eq!(c.geometry_offset(), (0.0, 0.0));
    }

    #[test]
    fn a_launcher_over_the_top_clips_to_the_band_below_it() {
        // The measured case: an 840x771pt hole at (280,100) with the new-tab
        // launcher over its top-right. The frontend hands back the full-width
        // band under the popover, starting 233.8pt down the hole.
        let clip = ClipRect { x: 280.0, y: 333.8, w: 840.0, h: 537.2 };
        let c = ClipPx::resolve(Some(clip), 280.0, 100.0, 1680, 1542, SCALE);
        assert_eq!(c.x, 0, "the band is flush with the hole's left edge");
        assert_eq!(c.y, 468, "233.8pt at 2x");
        assert_eq!(c.w, 1680);
        assert_eq!(c.h, 1074);
        assert_ne!(c, ClipPx::full(1680, 1542));
        assert_eq!(c.geometry_offset(), (0.0, -468.0));
    }

    #[test]
    fn a_roster_menu_on_the_left_clips_to_the_column_beside_it() {
        // The sidebar menu overlaps the hole's left edge, so the clip starts
        // 134pt in and the geometry shifts sideways instead of up.
        let clip = ClipRect { x: 414.0, y: 100.0, w: 706.0, h: 771.0 };
        let c = ClipPx::resolve(Some(clip), 280.0, 100.0, 1680, 1542, SCALE);
        assert_eq!(c, ClipPx { x: 268, y: 0, w: 1412, h: 1542 });
        assert_eq!(c.geometry_offset(), (-268.0, 0.0));
    }

    #[test]
    fn a_clip_wider_than_its_hole_is_cut_to_fit() {
        // A clip is never allowed to describe a drawable bigger than the view
        // it is about to be given: wgpu treats that as a validation failure,
        // not as something to letterbox.
        let clip = ClipRect { x: 270.0, y: 90.0, w: 900.0, h: 900.0 };
        let c = ClipPx::resolve(Some(clip), 280.0, 100.0, 1680, 1542, SCALE);
        assert_eq!(c.x, 0, "a negative offset clamps to the hole's origin");
        assert_eq!(c.y, 0);
        assert_eq!(c.w, 1680, "cut to the hole, not the 1800px it asked for");
        assert_eq!(c.h, 1542);
    }

    #[test]
    fn a_degenerate_clip_still_has_a_pixel_to_paint() {
        let clip = ClipRect { x: 280.0, y: 100.0, w: 0.0, h: 0.0 };
        let c = ClipPx::resolve(Some(clip), 280.0, 100.0, 1680, 1542, SCALE);
        assert_eq!(c.w, 1, "a zero-size swapchain is not configurable");
        assert_eq!(c.h, 1);
    }

    #[test]
    fn a_nonsense_scale_falls_back_to_one() {
        let clip = ClipRect { x: 280.0, y: 300.0, w: 840.0, h: 571.0 };
        let c = ClipPx::resolve(Some(clip), 280.0, 100.0, 840, 771, 0.0);
        assert_eq!(c, ClipPx { x: 0, y: 200, w: 840, h: 571 });
    }

    #[test]
    fn the_full_clip_leaves_a_wheel_fraction_alone() {
        let c = ClipPx::full(1680, 1542);
        let (fx, fy) = c.to_hole_frac(0.25, 0.75, 1680, 1542);
        assert!((fx - 0.25).abs() < 1e-6);
        assert!((fy - 0.75).abs() < 1e-6);
    }

    #[test]
    fn a_wheel_in_a_clipped_band_names_the_cell_it_is_over() {
        // The band below the launcher: the view's own midpoint is 468 +
        // 1074/2 = 1005px down a 1542px hole, which is 0.6517 of the grid —
        // not the 0.5 the raw view fraction claims.
        let c = ClipPx { x: 0, y: 468, w: 1680, h: 1074 };
        let (_, fy) = c.to_hole_frac(0.5, 0.5, 1680, 1542);
        assert!((fy - 0.6517).abs() < 1e-3, "got {fy}");

        // The top of the band is the top of what is visible, never row 0.
        let (_, top) = c.to_hole_frac(0.5, 0.0, 1680, 1542);
        assert!((top - 0.3035).abs() < 1e-3, "got {top}");

        // The bottom of the band is still the bottom of the grid.
        let (_, bot) = c.to_hole_frac(0.5, 1.0, 1680, 1542);
        assert!((bot - 1.0).abs() < 1e-6, "got {bot}");
    }

    #[test]
    fn a_wheel_fraction_never_escapes_the_hole() {
        let c = ClipPx { x: 268, y: 0, w: 1412, h: 1542 };
        for (fx, fy) in [(-5.0f32, -5.0f32), (5.0, 5.0), (f32::NAN, 0.5)] {
            let (hx, hy) = c.to_hole_frac(fx, fy, 1680, 1542);
            assert!((0.0..=1.0).contains(&hx), "fx {fx} → {hx}");
            assert!((0.0..=1.0).contains(&hy), "fy {fy} → {hy}");
        }
    }
}
