//! Render model — turn a [`GridSnapshot`] into a flat, backend-neutral draw
//! list a GPU renderer can upload directly.
//!
//! This is the CPU half of the native renderer. It knows nothing about wgpu,
//! Metal, or iced: it emits plain geometry (`x/y/w/h` in pixels) tagged with
//! [`Rgba`]. The wgpu path turns [`BgRect`]/[`CursorRect`] into instanced
//! solid quads and [`GlyphQuad`] into textured quads via a glyph atlas; the
//! iced path can walk the same list. Because it is pure data with no window,
//! the layout is fully unit-testable behind the macOS synthetic-input wall.
//!
//! The algorithm mirrors the two-pass paint the iced surface already used:
//! merge contiguous same-background cells into one rect (TUI output has long
//! default-bg runs), draw the cursor block, then place one glyph per
//! non-blank cell. The cursor cell's glyph is recolored to contrast against
//! the cursor block.

use crate::color::{Palette, Rgba};
use crate::grid::{GridSnapshot, Selection};

/// Pixel size of one terminal cell. Supplied by the renderer from real font
/// metrics (advance width + line height).
#[derive(Clone, Copy, Debug)]
pub struct CellMetrics {
    pub cell_w: f32,
    pub cell_h: f32,
}

impl CellMetrics {
    pub fn new(cell_w: f32, cell_h: f32) -> Self {
        Self { cell_w, cell_h }
    }
}

/// A filled background span — one or more horizontally-contiguous cells that
/// share a non-default background color.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct BgRect {
    pub x: f32,
    pub y: f32,
    pub w: f32,
    pub h: f32,
    pub color: Rgba,
}

/// A single glyph to draw at a cell origin. The renderer resolves `ch` (+
/// `bold`) against its glyph atlas; `color` is the already-resolved fg.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct GlyphQuad {
    pub x: f32,
    pub y: f32,
    pub ch: char,
    pub color: Rgba,
    pub bold: bool,
}

/// The cursor block. Drawn behind the glyph so the character shows through.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct CursorRect {
    pub x: f32,
    pub y: f32,
    pub w: f32,
    pub h: f32,
    pub color: Rgba,
}

/// A full frame's worth of geometry, ready to upload.
#[derive(Clone, Debug, Default)]
pub struct RenderList {
    pub bg_rects: Vec<BgRect>,
    pub glyphs: Vec<GlyphQuad>,
    pub cursor: Option<CursorRect>,
}

/// Build the draw list for one frame.
///
/// `palette.background` is treated as the default ground and never emitted as
/// a `BgRect` (the renderer clears to it once). `focused` gates the cursor:
/// an unfocused terminal draws no cursor block, matching the iced surface.
pub fn build_render_list(
    snap: &GridSnapshot,
    metrics: CellMetrics,
    palette: &Palette,
    focused: bool,
) -> RenderList {
    let CellMetrics { cell_w, cell_h } = metrics;
    let mut list = RenderList::default();

    // Is the cursor visible this frame (focused, in range, not scrolled into
    // history)? Computed once and reused by both the block and the glyph
    // recolor below.
    let cursor_visible = focused
        && !snap.cursor_hidden()
        && (snap.cursor_row as usize) < snap.cells.len()
        && (snap.cursor_col as usize)
            < snap.cells.get(snap.cursor_row as usize).map_or(0, |r| r.len());

    // Pass 1: backgrounds. Merge horizontally-contiguous cells that share a
    // bg into a single rect, skipping runs on the default ground.
    for (row_idx, row) in snap.cells.iter().enumerate() {
        let mut col = 0usize;
        while col < row.len() {
            let bg = row[col].bg;
            let mut run_end = col + 1;
            while run_end < row.len() && row[run_end].bg.approx_eq(bg) {
                run_end += 1;
            }
            if !bg.approx_eq(palette.background) {
                list.bg_rects.push(BgRect {
                    x: col as f32 * cell_w,
                    y: row_idx as f32 * cell_h,
                    w: (run_end - col) as f32 * cell_w,
                    h: cell_h,
                    color: bg,
                });
            }
            col = run_end;
        }
    }

    // Cursor block.
    if cursor_visible {
        list.cursor = Some(CursorRect {
            x: snap.cursor_col as f32 * cell_w,
            y: snap.cursor_row as f32 * cell_h,
            w: cell_w,
            h: cell_h,
            color: palette.cursor,
        });
    }

    // Pass 2: glyphs. Skip blanks (nothing to draw over the ground/bg). The
    // cursor cell's glyph flips to the background color so it reads against
    // the cursor block.
    for (row_idx, row) in snap.cells.iter().enumerate() {
        for (col_idx, cell) in row.iter().enumerate() {
            if cell.ch == ' ' || cell.ch == '\0' {
                continue;
            }
            let is_cursor_cell = cursor_visible
                && col_idx == snap.cursor_col as usize
                && row_idx == snap.cursor_row as usize;
            let color = if is_cursor_cell {
                palette.background
            } else {
                cell.fg
            };
            list.glyphs.push(GlyphQuad {
                x: col_idx as f32 * cell_w,
                y: row_idx as f32 * cell_h,
                ch: cell.ch,
                color,
                bold: cell.bold,
            });
        }
    }

    list
}

/// Append one selection wash rect per selected row to `list.bg_rects`. Emitted
/// after the normal backgrounds so the (translucent) `color` blends over them
/// in the solid pass; glyphs, drawn in a later pass, still read on top. The
/// `head` cell is inclusive, matching [`crate::grid::snapshot_selection_text`].
pub fn append_selection_rects(
    list: &mut RenderList,
    snap: &GridSnapshot,
    sel: &Selection,
    metrics: CellMetrics,
    color: Rgba,
) {
    let CellMetrics { cell_w, cell_h } = metrics;
    let rows = snap.cells.len();
    if rows == 0 {
        return;
    }
    let (start, end) = sel.ordered();
    let (start_col, start_row) = start;
    let (end_col, end_row) = end;
    let last_row = (rows - 1) as u16;
    let start_row = start_row.min(last_row);
    let end_row = end_row.min(last_row);

    for row in start_row..=end_row {
        let width = snap.cells[row as usize].len();
        if width == 0 {
            continue;
        }
        let last_col = (width - 1) as u16;
        let c0 = if row == start_row { start_col.min(last_col) } else { 0 };
        // Inclusive end cell → +1 span, clamped to the row width.
        let c1 = if row == end_row {
            (end_col.min(last_col)) + 1
        } else {
            width as u16
        };
        if c0 >= c1 {
            continue;
        }
        list.bg_rects.push(BgRect {
            x: c0 as f32 * cell_w,
            y: row as f32 * cell_h,
            w: (c1 - c0) as f32 * cell_w,
            h: cell_h,
            color,
        });
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::grid::GridTerminal;

    const M: CellMetrics = CellMetrics {
        cell_w: 8.0,
        cell_h: 16.0,
    };

    #[test]
    fn blank_screen_emits_no_geometry() {
        let term = GridTerminal::with_size(20, 5);
        let list = build_render_list(&term.snapshot(), M, &Palette::default(), false);
        assert!(list.bg_rects.is_empty(), "default ground needs no bg rects");
        assert!(list.glyphs.is_empty(), "blank cells emit no glyphs");
        assert!(list.cursor.is_none(), "unfocused → no cursor");
    }

    #[test]
    fn plain_text_places_glyphs_at_cell_origins() {
        let mut term = GridTerminal::with_size(20, 3);
        term.apply_output(b"hi");
        let list = build_render_list(&term.snapshot(), M, &Palette::default(), false);
        assert_eq!(list.glyphs.len(), 2);
        assert_eq!(list.glyphs[0].ch, 'h');
        assert_eq!(list.glyphs[0].x, 0.0);
        assert_eq!(list.glyphs[0].y, 0.0);
        assert_eq!(list.glyphs[1].ch, 'i');
        assert_eq!(list.glyphs[1].x, 8.0);
    }

    #[test]
    fn contiguous_colored_background_merges_into_one_rect() {
        // Paint 4 cells on a red background, then reset. The 4 bg cells share
        // a color and should collapse to a single rect spanning 4 cells.
        let mut term = GridTerminal::with_size(20, 2);
        term.apply_output(b"\x1b[41mABCD\x1b[0m");
        let list = build_render_list(&term.snapshot(), M, &Palette::default(), false);
        let red = crate::color::ANSI_16[1];
        let reds: Vec<_> = list
            .bg_rects
            .iter()
            .filter(|r| r.color.approx_eq(red))
            .collect();
        assert_eq!(reds.len(), 1, "4 same-bg cells → 1 merged rect");
        assert_eq!(reds[0].x, 0.0);
        assert_eq!(reds[0].w, 4.0 * M.cell_w);
        assert_eq!(reds[0].h, M.cell_h);
    }

    #[test]
    fn cursor_block_only_when_focused() {
        let mut term = GridTerminal::with_size(10, 3);
        term.apply_output(b"x");
        let snap = term.snapshot();

        let unfocused = build_render_list(&snap, M, &Palette::default(), false);
        assert!(unfocused.cursor.is_none());

        let focused = build_render_list(&snap, M, &Palette::default(), true);
        let cur = focused.cursor.expect("focused → cursor block");
        // Cursor sits one cell to the right of the printed 'x'.
        assert_eq!(cur.x, M.cell_w);
        assert_eq!(cur.y, 0.0);
        assert!(cur.color.approx_eq(Palette::default().cursor));
    }

    #[test]
    fn cursor_cell_glyph_flips_to_background_for_contrast() {
        // Put the cursor ON a printed glyph via a carriage return so it lands
        // back on column 0, then confirm that glyph is recolored to the bg.
        let mut term = GridTerminal::with_size(10, 2);
        term.apply_output(b"A\r"); // print 'A', CR moves cursor back onto it
        let snap = term.snapshot();
        let list = build_render_list(&snap, M, &Palette::default(), true);
        let a = list
            .glyphs
            .iter()
            .find(|g| g.ch == 'A')
            .expect("glyph A present");
        assert!(
            a.color.approx_eq(Palette::default().background),
            "cursor-cell glyph should flip to bg, got {:?}",
            a.color
        );
    }

    #[test]
    fn no_cursor_when_scrolled_into_history() {
        let mut term = GridTerminal::with_size(10, 4);
        let mut bytes = Vec::new();
        for i in 0..30 {
            bytes.extend_from_slice(format!("l{i}\r\n").as_bytes());
        }
        term.apply_output(&bytes);
        term.scroll_lines(30);
        let snap = term.snapshot();
        assert!(snap.cursor_hidden());
        let list = build_render_list(&snap, M, &Palette::default(), true);
        assert!(list.cursor.is_none(), "scrolled-back frame hides the cursor");
    }
}
