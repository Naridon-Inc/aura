//! What the native terminal should look like, as the frontend sees it.
//!
//! The GPU terminal is the default path now, and until this module existed its
//! colors and font size were Rust constants: a `Palette::default()` and a
//! `const FONT_PX`. That made the one surface an agent user stares at the one
//! surface no theme and no setting could reach — switching theme recolored the
//! whole app except the terminal, and the terminal text-size setting moved
//! nothing at all.
//!
//! So appearance arrives from the frontend instead, which is the only side that
//! can resolve a CSS custom property. The shape here is deliberately all
//! `Option`: a theme that defines six of the sixteen ANSI slots should get six
//! themed colors and ten sane ones, not a panic or a black terminal. Anything
//! absent or unparseable falls back to [`Appearance::default`].
//!
//! Colors come in as whatever `getComputedStyle` returned, which is why both
//! hex and the `rgb()` / `rgba()` functional forms parse: the browser
//! normalizes most authored values to `rgb(…)`, but a token read straight off
//! `style` can still be `#rrggbb`, and a token that was never defined comes
//! back as an empty string.

use std::sync::Mutex;

use aura_term_core::{Palette, Rgba};
use serde::Deserialize;

/// Logical font size used when the frontend has not told us otherwise. Matches
/// the terminal default in the app's own settings so an unconfigured terminal
/// looks the way it always did.
pub const DEFAULT_FONT_PX: f32 = 13.0;

/// Smallest and largest logical font size worth rasterizing. A 0 would divide
/// by zero when the grid computes columns and a stray 400 would allocate a
/// glyph atlas big enough to matter, so both the setting and the zoomed product
/// are held inside this.
const FONT_PX_RANGE: std::ops::RangeInclusive<f32> = 4.0..=96.0;

/// A resolved appearance: what to actually build a terminal with.
#[derive(Clone, Copy, Debug)]
pub struct Appearance {
    /// Logical (CSS) px. The renderer wants raster px, so call sites multiply
    /// by the device scale — see [`Appearance::raster_font_px`].
    pub font_px: f32,
    /// The app's zoom level, as a multiplier on `font_px`.
    ///
    /// Kept apart from `font_px` rather than folded into it because the two
    /// come from different people: `font_px` is the Appearance setting, and
    /// this is ⌘+/⌘−. Folding them would mean each one overwrote the other's
    /// contribution on its next push — zoom in twice, open Settings, and the
    /// slider would read 19 and then reset the terminal to 13 on the next
    /// theme change.
    pub font_zoom: f32,
    pub palette: Palette,
}

impl Default for Appearance {
    fn default() -> Self {
        Self {
            font_px: DEFAULT_FONT_PX,
            font_zoom: 1.0,
            palette: Palette {
                // Aura's documented primary is the green; the cursor used to be
                // hardcoded to an arctic blue labelled "Aura primary", which
                // stopped being true some themes ago. This is only the fallback
                // — a theme that defines the tokens overrides all of it.
                cursor: Rgba::rgb8(0x4d, 0xc1, 0xa4),
                selection: Rgba::new(0x4d as f32 / 255.0, 0xc1 as f32 / 255.0, 0xa4 as f32 / 255.0, 0.30),
                ..Palette::default()
            },
        }
    }
}

impl Appearance {
    /// The logical font size actually in effect: the setting, zoomed.
    ///
    /// Clamped again after multiplying, because the two factors are each sane
    /// on their own and their product need not be — a 48px setting at 200%
    /// asks for 96, and the floor matters more: left unclamped, a small
    /// setting at 50% would fall under the renderer's minimum and get refused,
    /// so ⌘− would stop having any effect one step before the zoom floor and
    /// look like a dead key rather than a limit.
    pub fn logical_font_px(&self) -> f32 {
        let zoom = if self.font_zoom.is_finite() && self.font_zoom > 0.0 {
            self.font_zoom
        } else {
            1.0
        };
        (self.font_px * zoom).clamp(*FONT_PX_RANGE.start(), *FONT_PX_RANGE.end())
    }

    /// Font size in physical pixels for a surface at `scale`.
    pub fn raster_font_px(&self, scale: f64) -> f32 {
        let scale = if scale <= 0.0 { 1.0 } else { scale };
        self.logical_font_px() * scale as f32
    }
}

/// Appearance as the frontend sends it: every field optional, colors as strings.
#[derive(Deserialize, Debug, Default, Clone)]
#[serde(rename_all = "camelCase")]
pub struct AppearanceInput {
    pub font_px: Option<f32>,
    /// The app's zoom level. Absent means "no opinion", which leaves whatever
    /// the last push set — so a theme change does not quietly reset the zoom.
    pub zoom: Option<f32>,
    pub foreground: Option<String>,
    pub background: Option<String>,
    pub cursor: Option<String>,
    pub selection: Option<String>,
    /// The sixteen ANSI slots, normal 0..=7 then bright 8..=15. A shorter list
    /// fills what it covers and leaves the rest alone, so a theme can restyle
    /// just the normal eight.
    pub ansi: Option<Vec<String>>,
}

impl AppearanceInput {
    /// Fold this input over `base`, keeping `base` wherever a field is absent,
    /// blank or unparseable.
    ///
    /// Unparseable is treated exactly like absent on purpose. The alternative
    /// is refusing the whole update because one token was malformed, which
    /// would turn a typo in one theme into a terminal that silently ignores
    /// every other color the theme got right.
    pub fn apply_to(&self, base: Appearance) -> Appearance {
        let mut out = base;

        // A font size has to be positive and sane: a 0 would divide by zero
        // when the grid computes columns, and a stray 400 would allocate a
        // glyph atlas big enough to matter.
        if let Some(px) = self.font_px {
            if px.is_finite() && FONT_PX_RANGE.contains(&px) {
                out.font_px = px;
            }
        }

        // The zoom range the app itself allows (50%–200%), widened a little so
        // this is a sanity check and not a second policy to keep in step with
        // the frontend's clamp.
        if let Some(z) = self.zoom {
            if z.is_finite() && (0.1..=10.0).contains(&z) {
                out.font_zoom = z;
            }
        }

        if let Some(c) = self.foreground.as_deref().and_then(parse_css_color) {
            out.palette.foreground = c;
        }
        if let Some(c) = self.background.as_deref().and_then(parse_css_color) {
            out.palette.background = c;
        }
        if let Some(c) = self.cursor.as_deref().and_then(parse_css_color) {
            out.palette.cursor = c;
        }
        if let Some(c) = self.selection.as_deref().and_then(parse_css_color) {
            out.palette.selection = c;
        }
        if let Some(list) = &self.ansi {
            for (i, raw) in list.iter().take(16).enumerate() {
                if let Some(c) = parse_css_color(raw) {
                    out.palette.ansi[i] = c;
                }
            }
        }

        out
    }
}

/// Parse the color forms a browser actually hands back.
///
/// Accepts `#rgb`, `#rgba`, `#rrggbb`, `#rrggbbaa`, `rgb(r g b)`, `rgb(r,g,b)`
/// and `rgba(…)` with either separator and an optional `/ alpha`. Returns
/// `None` for anything else — including the empty string, which is what
/// `getPropertyValue` gives for a token nobody defined.
pub fn parse_css_color(raw: &str) -> Option<Rgba> {
    let s = raw.trim();
    if s.is_empty() {
        return None;
    }
    if let Some(hex) = s.strip_prefix('#') {
        return parse_hex(hex);
    }
    let lower = s.to_ascii_lowercase();
    if lower.starts_with("rgb") {
        return parse_rgb_fn(&lower);
    }
    None
}

fn parse_hex(hex: &str) -> Option<Rgba> {
    let h = hex.trim();
    if !h.chars().all(|c| c.is_ascii_hexdigit()) {
        return None;
    }
    // Shorthand doubles each nibble: #abc is #aabbcc, which is the rule the
    // CSS spec states rather than a scaling approximation.
    let expand = |c: u8| -> u8 { c * 17 };
    let nib = |i: usize| -> Option<u8> { h.as_bytes().get(i).and_then(|b| (*b as char).to_digit(16)).map(|d| d as u8) };
    let pair = |i: usize| -> Option<u8> { Some(nib(i)? * 16 + nib(i + 1)?) };

    match h.len() {
        3 => Some(Rgba::rgb8(expand(nib(0)?), expand(nib(1)?), expand(nib(2)?))),
        4 => {
            let a = expand(nib(3)?);
            Some(Rgba::new(
                expand(nib(0)?) as f32 / 255.0,
                expand(nib(1)?) as f32 / 255.0,
                expand(nib(2)?) as f32 / 255.0,
                a as f32 / 255.0,
            ))
        }
        6 => Some(Rgba::rgb8(pair(0)?, pair(2)?, pair(4)?)),
        8 => Some(Rgba::new(
            pair(0)? as f32 / 255.0,
            pair(2)? as f32 / 255.0,
            pair(4)? as f32 / 255.0,
            pair(6)? as f32 / 255.0,
        )),
        _ => None,
    }
}

fn parse_rgb_fn(lower: &str) -> Option<Rgba> {
    let open = lower.find('(')?;
    let close = lower.rfind(')')?;
    if close <= open {
        return None;
    }
    let inner = &lower[open + 1..close];
    // `rgb(0 0 0 / 50%)` and `rgba(0,0,0,0.5)` both reduce to four numbers once
    // the separators are flattened.
    let flat = inner.replace([',', '/'], " ");
    let parts: Vec<&str> = flat.split_whitespace().collect();
    if parts.len() < 3 {
        return None;
    }

    let channel = |t: &str| -> Option<f32> {
        if let Some(p) = t.strip_suffix('%') {
            Some(p.parse::<f32>().ok()?.clamp(0.0, 100.0) / 100.0)
        } else {
            Some(t.parse::<f32>().ok()?.clamp(0.0, 255.0) / 255.0)
        }
    };
    let r = channel(parts[0])?;
    let g = channel(parts[1])?;
    let b = channel(parts[2])?;
    let a = match parts.get(3) {
        Some(t) => {
            if let Some(p) = t.strip_suffix('%') {
                p.parse::<f32>().ok()?.clamp(0.0, 100.0) / 100.0
            } else {
                t.parse::<f32>().ok()?.clamp(0.0, 1.0)
            }
        }
        None => 1.0,
    };
    Some(Rgba::new(r, g, b, a))
}

/// The appearance new terminals are built with, and that live ones are told
/// about. Held on the manager rather than passed per `open` call because the
/// frontend sets it once per theme change, not once per terminal.
pub struct AppearanceStore(Mutex<Appearance>);

impl AppearanceStore {
    pub fn new() -> Self {
        Self(Mutex::new(Appearance::default()))
    }

    pub fn get(&self) -> Appearance {
        self.0.lock().map(|a| *a).unwrap_or_default()
    }

    /// Fold an input in and return what the resolved appearance now is.
    ///
    /// Folding over the *stored* value rather than over the default means a
    /// caller that only wants to change the font size can send only the font
    /// size without resetting sixteen colors to their fallbacks.
    pub fn merge(&self, input: &AppearanceInput) -> Appearance {
        let mut guard = match self.0.lock() {
            Ok(g) => g,
            Err(e) => e.into_inner(),
        };
        *guard = input.apply_to(*guard);
        *guard
    }
}

impl Default for AppearanceStore {
    fn default() -> Self {
        Self::new()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn approx(a: f32, b: f32) -> bool {
        (a - b).abs() < 0.005
    }

    #[test]
    fn a_six_digit_hex_round_trips() {
        let c = parse_css_color("#4dc1a4").expect("hex parses");
        assert!(approx(c.r, 0x4d as f32 / 255.0));
        assert!(approx(c.g, 0xc1 as f32 / 255.0));
        assert!(approx(c.b, 0xa4 as f32 / 255.0));
        assert!(approx(c.a, 1.0));
    }

    #[test]
    fn shorthand_hex_doubles_each_nibble_rather_than_scaling() {
        // #abc is #aabbcc per the CSS spec, not #a0b0c0.
        let short = parse_css_color("#abc").expect("short hex parses");
        let long = parse_css_color("#aabbcc").expect("long hex parses");
        assert!(approx(short.r, long.r) && approx(short.g, long.g) && approx(short.b, long.b));
    }

    #[test]
    fn computed_style_rgb_forms_parse_with_either_separator() {
        // getComputedStyle normalizes to rgb(); modern engines may use spaces.
        let comma = parse_css_color("rgb(77, 193, 164)").expect("comma form");
        let space = parse_css_color("rgb(77 193 164)").expect("space form");
        assert!(approx(comma.r, space.r) && approx(comma.g, space.g) && approx(comma.b, space.b));
        let alpha = parse_css_color("rgba(77, 193, 164, 0.3)").expect("alpha form");
        assert!(approx(alpha.a, 0.3));
        let slash = parse_css_color("rgb(77 193 164 / 30%)").expect("slash form");
        assert!(approx(slash.a, 0.3));
    }

    #[test]
    fn the_selection_wash_the_frontend_emits_parses_here() {
        // This exact string is what `selectionWash` in lib/terminalAppearance.ts
        // produces, and it is the one color the frontend composes rather than
        // reads: a CSS color-mix() over a theme variable gets constant-folded at
        // build time, which took that token out of the cascade, so the alpha is
        // applied in script after the color resolves. A decimal alpha behind a
        // slash is therefore a contract between the two languages, not a form
        // that merely happens to work — pinned so neither side drifts off it.
        let wash = parse_css_color("rgb(77 193 164 / 0.3)").expect("selection wash");
        assert!(approx(wash.a, 0.3));
        assert!(approx(wash.r, 77.0 / 255.0));
    }

    #[test]
    fn an_undefined_token_is_none_not_black() {
        // getPropertyValue returns "" for a custom property nobody defined.
        // Parsing that as a color would paint the terminal black and look like
        // a theme that deliberately chose black.
        assert!(parse_css_color("").is_none());
        assert!(parse_css_color("   ").is_none());
        assert!(parse_css_color("var(--nope)").is_none());
        assert!(parse_css_color("#12345").is_none());
        assert!(parse_css_color("#gggggg").is_none());
    }

    #[test]
    fn a_partial_theme_keeps_the_fallbacks_for_what_it_omits() {
        let base = Appearance::default();
        let input = AppearanceInput {
            ansi: Some(vec!["#000000".into(), "#ff0000".into()]),
            ..Default::default()
        };
        let out = input.apply_to(base);
        // The two it named moved, the rest did not.
        assert!(approx(out.palette.ansi[1].r, 1.0));
        assert!(out.palette.ansi[5].approx_eq(base.palette.ansi[5]));
        assert!(approx(out.font_px, base.font_px));
    }

    #[test]
    fn one_bad_color_does_not_discard_the_good_ones() {
        let base = Appearance::default();
        let input = AppearanceInput {
            foreground: Some("not a color".into()),
            background: Some("#101010".into()),
            ..Default::default()
        };
        let out = input.apply_to(base);
        assert!(out.palette.foreground.approx_eq(base.palette.foreground));
        assert!(approx(out.palette.background.r, 0x10 as f32 / 255.0));
    }

    #[test]
    fn an_absurd_font_size_is_refused_rather_than_rasterized() {
        let base = Appearance::default();
        for bad in [0.0f32, -3.0, 4000.0, f32::NAN] {
            let input = AppearanceInput { font_px: Some(bad), ..Default::default() };
            assert!(approx(input.apply_to(base).font_px, base.font_px), "{bad} should be refused");
        }
        let input = AppearanceInput { font_px: Some(16.5), ..Default::default() };
        assert!(approx(input.apply_to(base).font_px, 16.5));
    }

    #[test]
    fn a_later_update_keeps_what_an_earlier_one_set() {
        // The whole point of merging over the stored value: changing text size
        // must not reset the colors the theme just installed.
        let store = AppearanceStore::new();
        store.merge(&AppearanceInput {
            background: Some("#101010".into()),
            ..Default::default()
        });
        let after = store.merge(&AppearanceInput { font_px: Some(15.0), ..Default::default() });
        assert!(approx(after.font_px, 15.0));
        assert!(approx(after.palette.background.r, 0x10 as f32 / 255.0));
    }

    #[test]
    fn raster_size_follows_the_device_scale_and_survives_a_nonsense_one() {
        let a = Appearance { font_px: 13.0, font_zoom: 1.0, palette: Palette::default() };
        assert!(approx(a.raster_font_px(2.0), 26.0));
        assert!(approx(a.raster_font_px(0.0), 13.0));
        assert!(approx(a.raster_font_px(-1.0), 13.0));
    }

    #[test]
    fn zooming_in_grows_the_glyphs_and_not_only_the_hole() {
        // The bug this fixes: ⌘+ scaled the surface the terminal is painted
        // into — a sibling of the webview, positioned in window points — while
        // the font stayed where it was, so zooming bought more columns of the
        // same tiny text instead of bigger text.
        let a = Appearance { font_px: 13.0, font_zoom: 1.3, palette: Palette::default() };
        assert!(approx(a.logical_font_px(), 16.9));
        // Device scale still multiplies on top: zoom is logical, scale is raster.
        assert!(approx(a.raster_font_px(2.0), 33.8));
    }

    #[test]
    fn zoom_and_the_text_size_setting_do_not_overwrite_each_other() {
        // They arrive from two different places — the Appearance pane and the
        // keyboard — and each pushes only its own field. Folding zoom into
        // font_px would make whichever pushed last erase the other's share.
        let store = AppearanceStore::new();
        store.merge(&AppearanceInput { font_px: Some(16.0), ..Default::default() });
        let zoomed = store.merge(&AppearanceInput { zoom: Some(1.5), ..Default::default() });
        assert!(approx(zoomed.font_px, 16.0), "the setting survives a zoom");
        assert!(approx(zoomed.logical_font_px(), 24.0));
        // A theme change pushes colors and no zoom; the zoom has to stay.
        let themed = store.merge(&AppearanceInput {
            background: Some("#101010".into()),
            ..Default::default()
        });
        assert!(approx(themed.logical_font_px(), 24.0), "a theme push is not a zoom reset");
    }

    #[test]
    fn a_nonsense_zoom_leaves_the_text_size_alone() {
        let base = Appearance::default();
        for bad in [0.0f32, -1.0, f32::NAN, 1000.0] {
            let out = AppearanceInput { zoom: Some(bad), ..Default::default() }.apply_to(base);
            assert!(approx(out.logical_font_px(), base.font_px), "{bad} should be refused");
        }
    }

    #[test]
    fn the_zoomed_size_stays_inside_what_the_renderer_will_accept() {
        // Each factor is sane alone; the product need not be. The floor is the
        // one that bites: a size under the minimum would be refused outright,
        // so ⌘− would appear to stop working a step early instead of bottoming
        // out at the smallest readable size.
        let big = Appearance { font_px: 90.0, font_zoom: 2.0, palette: Palette::default() };
        assert!(approx(big.logical_font_px(), 96.0));
        let small = Appearance { font_px: 5.0, font_zoom: 0.5, palette: Palette::default() };
        assert!(approx(small.logical_font_px(), 4.0));
    }
}
