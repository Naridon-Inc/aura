//! Glyph atlas — rasterize terminal glyphs once via cosmic-text/swash and
//! pack them into a single-channel (R8, coverage) CPU bitmap that the renderer
//! uploads to a wgpu texture. New glyphs are appended with a shelf allocator;
//! the atlas grows its height (doubling) when a shelf overflows.
//!
//! cosmic-text gives us font discovery + per-glyph fallback for free (CJK,
//! box-drawing, etc.), which is the whole reason we lean on it instead of
//! hand-rolling glyph loading. Rasterization is pure CPU work, so this module
//! is unit-tested headless — no GPU required.

use std::collections::HashMap;

use cosmic_text::{
    Attrs, Buffer, Family, FontSystem, Metrics, Shaping, SwashCache, SwashContent, Weight,
};

/// Where a rasterized glyph lives in the atlas, plus its placement relative to
/// the cell's top-left pen origin.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct GlyphInfo {
    /// Atlas pixel rect.
    pub x: u32,
    pub y: u32,
    pub w: u32,
    pub h: u32,
    /// Offset from the pen origin to the top-left of the bitmap. `left` is
    /// added to the cell x; `top` is measured down from the baseline, so the
    /// renderer places the bitmap at `baseline_y - top`.
    pub left: i32,
    pub top: i32,
}

/// A growable coverage atlas keyed by `char`.
pub struct Atlas {
    font_system: FontSystem,
    cache: SwashCache,
    font_size: f32,
    line_height: f32,

    width: u32,
    height: u32,
    data: Vec<u8>,

    // Shelf packer cursor.
    shelf_x: u32,
    shelf_y: u32,
    shelf_h: u32,

    // Keyed by (codepoint, bold). `None` marks a glyph with no ink (space,
    // control chars). Bold is a distinct rasterization, not a color trick.
    glyphs: HashMap<(char, bool), Option<GlyphInfo>>,
    dirty: bool,

    cell_w: f32,
    cell_h: f32,
    ascent: f32,
}

/// Padding between packed glyphs so bilinear sampling never bleeds a neighbor.
const PAD: u32 = 1;

impl Atlas {
    /// Build an atlas for a monospace face at `font_size` px. `dim` is the
    /// initial square atlas edge (e.g. 512 or 1024).
    pub fn new(font_size: f32, dim: u32) -> Self {
        let mut font_system = FontSystem::new();
        let cache = SwashCache::new();
        let line_height = (font_size * 1.3).ceil();

        let (cell_w, ascent) =
            measure_cell(&mut font_system, font_size, line_height);

        Self {
            font_system,
            cache,
            font_size,
            line_height,
            width: dim.max(64),
            height: dim.max(64),
            data: vec![0u8; (dim.max(64) * dim.max(64)) as usize],
            shelf_x: PAD,
            shelf_y: PAD,
            shelf_h: 0,
            glyphs: HashMap::new(),
            dirty: true,
            cell_w,
            cell_h: line_height,
            ascent,
        }
    }

    /// Cell size in pixels (advance width, line height). The terminal grid and
    /// the render layout use this to size cells.
    pub fn cell_metrics(&self) -> (f32, f32) {
        (self.cell_w, self.cell_h)
    }

    /// Distance from the cell top to the text baseline, in pixels.
    pub fn ascent(&self) -> f32 {
        self.ascent
    }

    pub fn dims(&self) -> (u32, u32) {
        (self.width, self.height)
    }

    pub fn data(&self) -> &[u8] {
        &self.data
    }

    /// True if the atlas bitmap changed since the last [`Atlas::clear_dirty`].
    /// The renderer re-uploads the texture only when dirty.
    pub fn is_dirty(&self) -> bool {
        self.dirty
    }

    pub fn clear_dirty(&mut self) {
        self.dirty = false;
    }

    /// Look up (rasterizing + packing on first sight) the atlas entry for a
    /// codepoint at the given weight. Returns `None` for glyphs with no ink.
    pub fn glyph(&mut self, ch: char, bold: bool) -> Option<GlyphInfo> {
        if let Some(hit) = self.glyphs.get(&(ch, bold)) {
            return *hit;
        }
        let info = self.rasterize(ch, bold);
        self.glyphs.insert((ch, bold), info);
        info
    }

    fn rasterize(&mut self, ch: char, bold: bool) -> Option<GlyphInfo> {
        // Control chars and space never have ink.
        if ch == ' ' || ch == '\0' || ch.is_control() {
            return None;
        }

        let metrics = Metrics::new(self.font_size, self.line_height);
        let mut buffer = Buffer::new(&mut self.font_system, metrics);
        let mut s = [0u8; 4];
        let text = ch.encode_utf8(&mut s);
        let weight = if bold { Weight::BOLD } else { Weight::NORMAL };
        let attrs = Attrs::new().family(Family::Monospace).weight(weight);
        buffer.set_text(&mut self.font_system, text, &attrs, Shaping::Advanced, None);
        buffer.shape_until_scroll(&mut self.font_system, false);

        // Pull the first laid-out glyph and rasterize it.
        let mut found: Option<(cosmic_text::SwashImage,)> = None;
        for run in buffer.layout_runs() {
            for glyph in run.glyphs.iter() {
                let physical = glyph.physical((0.0, 0.0), 1.0);
                if let Some(img) =
                    self.cache.get_image(&mut self.font_system, physical.cache_key)
                {
                    found = Some((img.clone(),));
                    break;
                }
            }
            if found.is_some() {
                break;
            }
        }

        let (img,) = found?;
        let gw = img.placement.width;
        let gh = img.placement.height;
        if gw == 0 || gh == 0 {
            return None;
        }

        // Coverage buffer: Mask = 1 byte/px; Color (emoji) = 4 bytes/px, take
        // the alpha channel so a color glyph still shows its silhouette.
        let coverage: Vec<u8> = match img.content {
            SwashContent::Mask | SwashContent::SubpixelMask => img.data.clone(),
            SwashContent::Color => img.data.iter().skip(3).step_by(4).copied().collect(),
        };
        if coverage.len() < (gw * gh) as usize {
            return None;
        }

        let (ax, ay) = self.pack(gw, gh);
        for row in 0..gh {
            let src = (row * gw) as usize;
            let dst = ((ay + row) * self.width + ax) as usize;
            self.data[dst..dst + gw as usize]
                .copy_from_slice(&coverage[src..src + gw as usize]);
        }
        self.dirty = true;

        Some(GlyphInfo {
            x: ax,
            y: ay,
            w: gw,
            h: gh,
            left: img.placement.left,
            top: img.placement.top,
        })
    }

    /// Reserve a `w`x`h` slot, advancing the shelf cursor and growing the
    /// atlas height if the current shelves are full. Returns the top-left.
    fn pack(&mut self, w: u32, h: u32) -> (u32, u32) {
        if self.shelf_x + w + PAD > self.width {
            // New shelf.
            self.shelf_y += self.shelf_h + PAD;
            self.shelf_x = PAD;
            self.shelf_h = 0;
        }
        while self.shelf_y + h + PAD > self.height {
            self.grow_height();
        }
        let x = self.shelf_x;
        let y = self.shelf_y;
        self.shelf_x += w + PAD;
        self.shelf_h = self.shelf_h.max(h);
        (x, y)
    }

    fn grow_height(&mut self) {
        let new_h = self.height * 2;
        let mut new_data = vec![0u8; (self.width * new_h) as usize];
        new_data[..self.data.len()].copy_from_slice(&self.data);
        self.data = new_data;
        self.height = new_h;
        self.dirty = true;
    }
}

/// Derive cell width + ascent from the monospace face by shaping a
/// representative glyph. Width is the glyph advance; ascent is the run's
/// baseline offset from the top of the line box.
fn measure_cell(font_system: &mut FontSystem, font_size: f32, line_height: f32) -> (f32, f32) {
    let metrics = Metrics::new(font_size, line_height);
    let mut buffer = Buffer::new(font_system, metrics);
    let attrs = Attrs::new().family(Family::Monospace);
    buffer.set_text(font_system, "M", &attrs, Shaping::Advanced, None);
    buffer.shape_until_scroll(font_system, false);

    let mut advance = font_size * 0.6; // sane fallback if shaping is empty
    let mut ascent = font_size; // fallback baseline
    for run in buffer.layout_runs() {
        ascent = run.line_y;
        if let Some(g) = run.glyphs.first() {
            advance = g.w;
        }
        break;
    }
    (advance.ceil().max(1.0), ascent.ceil().max(1.0))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn cell_metrics_are_positive() {
        let atlas = Atlas::new(16.0, 256);
        let (w, h) = atlas.cell_metrics();
        assert!(w > 0.0 && h > 0.0, "cell metrics must be positive: {w}x{h}");
        assert!(atlas.ascent() > 0.0);
    }

    #[test]
    fn ascii_glyph_has_ink_and_packs() {
        let mut atlas = Atlas::new(16.0, 256);
        let info = atlas.glyph('A', false).expect("'A' should rasterize with ink");
        assert!(info.w > 0 && info.h > 0);
        // The packed region should contain some non-zero coverage.
        let mut ink = 0u64;
        for row in 0..info.h {
            let base = ((info.y + row) * atlas.width + info.x) as usize;
            for px in 0..info.w as usize {
                ink += atlas.data[base + px] as u64;
            }
        }
        assert!(ink > 0, "rasterized 'A' had no coverage");
    }

    #[test]
    fn space_has_no_ink() {
        let mut atlas = Atlas::new(16.0, 256);
        assert_eq!(atlas.glyph(' ', false), None);
    }

    #[test]
    fn glyph_lookup_is_cached() {
        let mut atlas = Atlas::new(16.0, 256);
        let first = atlas.glyph('Q', false).expect("Q inks");
        let second = atlas.glyph('Q', false).expect("Q inks");
        assert_eq!(first, second, "same char must map to the same atlas slot");
    }

    #[test]
    fn bold_is_a_distinct_slot() {
        let mut atlas = Atlas::new(16.0, 256);
        let regular = atlas.glyph('W', false).expect("W inks");
        let bold = atlas.glyph('W', true).expect("bold W inks");
        assert_ne!(
            (regular.x, regular.y),
            (bold.x, bold.y),
            "bold must pack to its own slot, not alias the regular glyph"
        );
    }

    #[test]
    fn many_glyphs_pack_without_overlap() {
        // Fill several rows worth of glyphs and confirm rects stay in-bounds
        // and don't overlap (shelf packer invariant).
        let mut atlas = Atlas::new(16.0, 128);
        let mut rects: Vec<GlyphInfo> = Vec::new();
        for ch in ('!'..='~').chain('À'..='ÿ') {
            if let Some(info) = atlas.glyph(ch, false) {
                let (aw, ah) = atlas.dims();
                assert!(info.x + info.w <= aw, "glyph overruns atlas width");
                assert!(info.y + info.h <= ah, "glyph overruns atlas height");
                rects.push(info);
            }
        }
        for (i, a) in rects.iter().enumerate() {
            for b in &rects[i + 1..] {
                let disjoint = a.x + a.w <= b.x
                    || b.x + b.w <= a.x
                    || a.y + a.h <= b.y
                    || b.y + b.h <= a.y;
                assert!(disjoint, "packed glyphs overlap: {a:?} vs {b:?}");
            }
        }
    }
}
