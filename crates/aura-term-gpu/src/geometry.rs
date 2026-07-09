//! Turn a backend-neutral [`RenderList`] into GPU instance data. This is the
//! CPU half of the renderer: it resolves each glyph against the [`Atlas`],
//! computes pixel-space quads + atlas UVs, and packs them into POD instance
//! buffers. No wgpu here — it's pure arithmetic, so the layout math is
//! unit-tested headless.
//!
//! Coordinates are top-left-origin pixels; the vertex shader converts to NDC
//! using the frame's screen size. Blending assumes background quads are drawn
//! first (opaque), then the cursor block, then glyph quads over the top.

use aura_term_core::{RenderList, Rgba};
use bytemuck::{Pod, Zeroable};

use crate::atlas::Atlas;

/// One solid-color quad (background cell run or cursor block).
///
/// `rect` is `[x, y, w, h]` in pixels; `color` is straight RGBA in 0..1.
#[repr(C)]
#[derive(Clone, Copy, Debug, PartialEq, Pod, Zeroable)]
pub struct SolidInstance {
    pub rect: [f32; 4],
    pub color: [f32; 4],
}

/// One textured glyph quad sampled from the coverage atlas.
///
/// `rect` is the destination `[x, y, w, h]` in pixels; `uv` is the atlas
/// sub-rect `[u, v, du, dv]` in 0..1; `color` tints the coverage.
#[repr(C)]
#[derive(Clone, Copy, Debug, PartialEq, Pod, Zeroable)]
pub struct GlyphInstance {
    pub rect: [f32; 4],
    pub uv: [f32; 4],
    pub color: [f32; 4],
}

const fn rgba(c: Rgba) -> [f32; 4] {
    [c.r, c.g, c.b, c.a]
}

/// Build the solid + glyph instance lists for one frame.
///
/// Glyphs are resolved (and rasterized on first sight) against `atlas`, which
/// may grow its texture. We ensure every glyph is present first, then read the
/// final atlas dimensions once so every UV is normalized against the same size
/// — otherwise a mid-build grow would leave earlier glyphs with stale UVs.
pub fn build_instances(
    list: &RenderList,
    atlas: &mut Atlas,
) -> (Vec<SolidInstance>, Vec<GlyphInstance>) {
    // Solids: background runs first, then the cursor block on top of them but
    // under the glyphs (the cursor cell's glyph is pre-flipped to the bg color
    // by the core so it stays legible).
    let mut solids = Vec::with_capacity(list.bg_rects.len() + 1);
    for r in &list.bg_rects {
        solids.push(SolidInstance {
            rect: [r.x, r.y, r.w, r.h],
            color: rgba(r.color),
        });
    }
    if let Some(c) = &list.cursor {
        solids.push(SolidInstance {
            rect: [c.x, c.y, c.w, c.h],
            color: rgba(c.color),
        });
    }

    // Pass 1: make sure the atlas holds every glyph (may trigger growth).
    for g in &list.glyphs {
        atlas.glyph(g.ch, g.bold);
    }
    let (aw, ah) = atlas.dims();
    let (aw_f, ah_f) = (aw as f32, ah as f32);
    let ascent = atlas.ascent();

    // Pass 2: emit quads against the now-stable atlas size.
    let mut glyphs = Vec::with_capacity(list.glyphs.len());
    for g in &list.glyphs {
        let Some(info) = atlas.glyph(g.ch, g.bold) else {
            continue; // no ink (space / control) — nothing to draw
        };
        let baseline = g.y + ascent;
        let dx = g.x + info.left as f32;
        let dy = baseline - info.top as f32;
        glyphs.push(GlyphInstance {
            rect: [dx, dy, info.w as f32, info.h as f32],
            uv: [
                info.x as f32 / aw_f,
                info.y as f32 / ah_f,
                info.w as f32 / aw_f,
                info.h as f32 / ah_f,
            ],
            color: rgba(g.color),
        });
    }

    (solids, glyphs)
}

#[cfg(test)]
mod tests {
    use super::*;
    use aura_term_core::{BgRect, CursorRect, GlyphQuad};

    fn white() -> Rgba {
        Rgba::new(1.0, 1.0, 1.0, 1.0)
    }

    #[test]
    fn bg_and_cursor_become_solids_in_order() {
        let list = RenderList {
            bg_rects: vec![BgRect { x: 0.0, y: 0.0, w: 10.0, h: 20.0, color: white() }],
            glyphs: vec![],
            cursor: Some(CursorRect { x: 30.0, y: 0.0, w: 10.0, h: 20.0, color: white() }),
        };
        let mut atlas = Atlas::new(16.0, 256);
        let (solids, glyphs) = build_instances(&list, &mut atlas);
        assert_eq!(solids.len(), 2, "one bg run + one cursor");
        assert_eq!(solids[0].rect, [0.0, 0.0, 10.0, 20.0]);
        assert_eq!(solids[1].rect, [30.0, 0.0, 10.0, 20.0], "cursor after bg");
        assert!(glyphs.is_empty());
    }

    #[test]
    fn inked_glyph_emits_quad_with_normalized_uv() {
        let list = RenderList {
            bg_rects: vec![],
            glyphs: vec![GlyphQuad { x: 8.0, y: 0.0, ch: 'A', color: white(), bold: false }],
            cursor: None,
        };
        let mut atlas = Atlas::new(16.0, 256);
        let (_, glyphs) = build_instances(&list, &mut atlas);
        assert_eq!(glyphs.len(), 1);
        let q = glyphs[0];
        // UVs are normalized 0..1 sub-rects.
        for v in q.uv {
            assert!((0.0..=1.0).contains(&v), "uv out of range: {v}");
        }
        // Destination quad has real extent.
        assert!(q.rect[2] > 0.0 && q.rect[3] > 0.0);
        // Quad sits at/after the cell x (plus glyph left bearing).
        assert!(q.rect[0] >= 8.0 - 4.0);
    }

    #[test]
    fn blank_glyph_emits_nothing() {
        let list = RenderList {
            bg_rects: vec![],
            glyphs: vec![GlyphQuad { x: 0.0, y: 0.0, ch: ' ', color: white(), bold: false }],
            cursor: None,
        };
        let mut atlas = Atlas::new(16.0, 256);
        let (_, glyphs) = build_instances(&list, &mut atlas);
        assert!(glyphs.is_empty(), "space has no ink → no quad");
    }

    #[test]
    fn uvs_stay_consistent_after_atlas_growth() {
        // Force growth by using a tiny atlas + many glyphs, then confirm every
        // emitted UV is normalized against the final (grown) dimensions.
        let glyphs: Vec<GlyphQuad> = ('!'..='~')
            .enumerate()
            .map(|(i, ch)| GlyphQuad { x: i as f32 * 8.0, y: 0.0, ch, color: white(), bold: false })
            .collect();
        let list = RenderList { bg_rects: vec![], glyphs, cursor: None };
        let mut atlas = Atlas::new(16.0, 64); // small → will grow
        let (_, out) = build_instances(&list, &mut atlas);
        let (aw, ah) = atlas.dims();
        assert!(ah > 64, "atlas should have grown");
        for q in &out {
            // Reconstruct the pixel rect from the normalized UV and confirm it
            // lands inside the final atlas bounds.
            let px = q.uv[0] * aw as f32;
            let py = q.uv[1] * ah as f32;
            assert!(px >= 0.0 && px < aw as f32);
            assert!(py >= 0.0 && py < ah as f32);
        }
    }
}
