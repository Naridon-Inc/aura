//! UI-agnostic color model for the terminal grid.
//!
//! The engine speaks in [`Rgba`] (0..=1 f32 channels) so it stays free of any
//! GUI toolkit. Consumers convert at the paint boundary: the iced work
//! surface maps `Rgba` -> `iced::Color`, the Tauri shell's wgpu renderer
//! uploads `Rgba` straight into a vertex buffer.
//!
//! A [`Palette`] resolves alacritty's `Color` (spec / named / indexed) into a
//! concrete `Rgba`. Callers can supply their own palette to theme the grid;
//! [`Palette::default`] is the standard xterm 16-color set on a neutral dark
//! ground.

use alacritty_terminal::vte::ansi::{Color as AColor, NamedColor, Rgb};

/// A straight (non-premultiplied) RGBA color, channels in `0.0..=1.0`.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Rgba {
    pub r: f32,
    pub g: f32,
    pub b: f32,
    pub a: f32,
}

impl Rgba {
    pub const fn new(r: f32, g: f32, b: f32, a: f32) -> Self {
        Self { r, g, b, a }
    }

    /// Build from 8-bit channels, fully opaque.
    pub const fn rgb8(r: u8, g: u8, b: u8) -> Self {
        Self {
            r: r as f32 / 255.0,
            g: g as f32 / 255.0,
            b: b as f32 / 255.0,
            a: 1.0,
        }
    }

    /// Epsilon compare — grids are built from a small fixed palette, so exact
    /// float equality is unreliable but values are always near-identical.
    pub fn approx_eq(self, o: Rgba) -> bool {
        (self.r - o.r).abs() < f32::EPSILON
            && (self.g - o.g).abs() < f32::EPSILON
            && (self.b - o.b).abs() < f32::EPSILON
            && (self.a - o.a).abs() < f32::EPSILON
    }
}

/// Linear interpolation between two colors, clamped. Used for faint/dim text
/// (blend the fg toward the bg).
pub fn blend(a: Rgba, b: Rgba, t: f32) -> Rgba {
    let t = t.clamp(0.0, 1.0);
    Rgba {
        r: a.r * (1.0 - t) + b.r * t,
        g: a.g * (1.0 - t) + b.g * t,
        b: a.b * (1.0 - t) + b.b * t,
        a: 1.0,
    }
}

/// Standard xterm 16-color palette. Indices 0..=7 = normal, 8..=15 = bright.
pub const ANSI_16: [Rgba; 16] = [
    Rgba::rgb8(0x00, 0x00, 0x00), // black
    Rgba::rgb8(0xcd, 0x31, 0x31), // red
    Rgba::rgb8(0x0d, 0xbc, 0x79), // green
    Rgba::rgb8(0xe5, 0xe5, 0x10), // yellow
    Rgba::rgb8(0x24, 0x72, 0xc8), // blue
    Rgba::rgb8(0xbc, 0x3f, 0xbc), // magenta
    Rgba::rgb8(0x11, 0xa8, 0xcd), // cyan
    Rgba::rgb8(0xe5, 0xe5, 0xe5), // white
    Rgba::rgb8(0x66, 0x66, 0x66), // bright black
    Rgba::rgb8(0xf1, 0x4c, 0x4c), // bright red
    Rgba::rgb8(0x23, 0xd1, 0x8b), // bright green
    Rgba::rgb8(0xf5, 0xf5, 0x43), // bright yellow
    Rgba::rgb8(0x3b, 0x8e, 0xea), // bright blue
    Rgba::rgb8(0xd6, 0x70, 0xd6), // bright magenta
    Rgba::rgb8(0x29, 0xb8, 0xdb), // bright cyan
    Rgba::rgb8(0xff, 0xff, 0xff), // bright white
];

/// A resolved terminal color scheme. Named/default slots (`foreground`,
/// `background`, `cursor`) plus the 16 ANSI entries. The 256-color cube and
/// grayscale ramp are computed on demand from `Indexed` values.
#[derive(Clone, Copy, Debug)]
pub struct Palette {
    pub foreground: Rgba,
    pub background: Rgba,
    pub cursor: Rgba,
    /// Fill drawn behind selected cells. Translucent so the glyphs underneath
    /// still read — the renderer alpha-blends it over the cell background.
    pub selection: Rgba,
    pub ansi: [Rgba; 16],
}

impl Default for Palette {
    fn default() -> Self {
        Self {
            foreground: Rgba::rgb8(0xe5, 0xe5, 0xe5),
            background: Rgba::rgb8(0x0a, 0x0a, 0x0a),
            // Arctic-blue accent (Aura primary affordance color).
            cursor: Rgba::rgb8(0x6a, 0xa5, 0xff),
            // Same arctic blue at low opacity for the selection wash.
            selection: Rgba::new(0x6a as f32 / 255.0, 0xa5 as f32 / 255.0, 1.0, 0.35),
            ansi: ANSI_16,
        }
    }
}

impl Palette {
    /// Resolve any alacritty cell color into a concrete `Rgba`. `is_fg` picks
    /// the right default when the cell references the named foreground or
    /// background slot.
    pub fn resolve(&self, color: AColor, is_fg: bool) -> Rgba {
        match color {
            AColor::Spec(rgb) => rgb_to_rgba(rgb),
            AColor::Named(named) => self.named(named, is_fg),
            AColor::Indexed(idx) => self.indexed(idx, is_fg),
        }
    }

    fn named(&self, n: NamedColor, is_fg: bool) -> Rgba {
        use NamedColor::*;
        match n {
            Black => self.ansi[0],
            Red => self.ansi[1],
            Green => self.ansi[2],
            Yellow => self.ansi[3],
            Blue => self.ansi[4],
            Magenta => self.ansi[5],
            Cyan => self.ansi[6],
            White => self.ansi[7],
            BrightBlack => self.ansi[8],
            BrightRed => self.ansi[9],
            BrightGreen => self.ansi[10],
            BrightYellow => self.ansi[11],
            BrightBlue => self.ansi[12],
            BrightMagenta => self.ansi[13],
            BrightCyan => self.ansi[14],
            BrightWhite => self.ansi[15],
            DimBlack => blend(self.ansi[0], self.background, 0.5),
            DimRed => blend(self.ansi[1], self.background, 0.5),
            DimGreen => blend(self.ansi[2], self.background, 0.5),
            DimYellow => blend(self.ansi[3], self.background, 0.5),
            DimBlue => blend(self.ansi[4], self.background, 0.5),
            DimMagenta => blend(self.ansi[5], self.background, 0.5),
            DimCyan => blend(self.ansi[6], self.background, 0.5),
            DimWhite => blend(self.ansi[7], self.background, 0.5),
            Foreground | BrightForeground => {
                let _ = is_fg;
                self.foreground
            }
            DimForeground => blend(self.foreground, self.background, 0.5),
            Background => self.background,
            Cursor => self.cursor,
        }
    }

    fn indexed(&self, idx: u8, is_fg: bool) -> Rgba {
        if (idx as usize) < self.ansi.len() {
            return self.ansi[idx as usize];
        }
        if (16..=231).contains(&idx) {
            // 6x6x6 color cube.
            let i = idx - 16;
            let r = i / 36;
            let g = (i % 36) / 6;
            let b = i % 6;
            let to_c = |c: u8| -> f32 {
                if c == 0 {
                    0.0
                } else {
                    (55 + (c as u16 * 40)) as f32 / 255.0
                }
            };
            return Rgba::new(to_c(r), to_c(g), to_c(b), 1.0);
        }
        if idx >= 232 {
            // Grayscale ramp: 24 steps from near-black to near-white.
            let level = 8 + (idx - 232) as u16 * 10;
            let l = level.min(255) as f32 / 255.0;
            return Rgba::new(l, l, l, 1.0);
        }
        if is_fg {
            self.foreground
        } else {
            self.background
        }
    }
}

fn rgb_to_rgba(c: Rgb) -> Rgba {
    Rgba::new(
        c.r as f32 / 255.0,
        c.g as f32 / 255.0,
        c.b as f32 / 255.0,
        1.0,
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn indexed_low_range_maps_to_ansi() {
        let p = Palette::default();
        assert!(p.indexed(1, true).approx_eq(ANSI_16[1]));
        assert!(p.indexed(15, true).approx_eq(ANSI_16[15]));
    }

    #[test]
    fn indexed_cube_and_grayscale_are_in_range() {
        let p = Palette::default();
        let cube = p.indexed(200, true);
        for ch in [cube.r, cube.g, cube.b] {
            assert!((0.0..=1.0).contains(&ch));
        }
        let gray = p.indexed(240, true);
        // Grayscale ramp is achromatic.
        assert!(gray.r.approx_eq_f(gray.g) && gray.g.approx_eq_f(gray.b));
    }

    #[test]
    fn named_foreground_resolves_to_palette_fg() {
        let p = Palette::default();
        let fg = p.named(NamedColor::Foreground, true);
        assert!(fg.approx_eq(p.foreground));
    }

    #[test]
    fn blend_midpoint_is_average() {
        let a = Rgba::new(0.0, 0.0, 0.0, 1.0);
        let b = Rgba::new(1.0, 1.0, 1.0, 1.0);
        let mid = blend(a, b, 0.5);
        assert!(mid.approx_eq(Rgba::new(0.5, 0.5, 0.5, 1.0)));
    }

    // Small helper so the test above can compare bare channels.
    trait ApproxF {
        fn approx_eq_f(self, o: f32) -> bool;
    }
    impl ApproxF for f32 {
        fn approx_eq_f(self, o: f32) -> bool {
            (self - o).abs() < f32::EPSILON
        }
    }
}
