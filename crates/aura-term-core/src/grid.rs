//! Terminal grid model — owns an `alacritty_terminal::Term` driven by a
//! `vte::ansi::Processor`, and produces an immutable [`GridSnapshot`] for a
//! renderer to paint.
//!
//! This is the UI-agnostic half of the engine: it knows nothing about iced,
//! wgpu, or any window system. Bytes go in via [`GridTerminal::apply_output`];
//! a cheap cell snapshot (char + fg + bg + flags per cell, plus cursor) comes
//! out via [`GridTerminal::snapshot`]. The snapshot is taken by value so the
//! paint path never holds the state mutex — the PTY read thread can keep
//! feeding bytes while a frame renders.
//!
//! Colors are resolved into UI-agnostic [`Rgba`] through a [`Palette`]; the
//! renderer converts to its own color type at the paint boundary.

use std::sync::{Arc, Mutex};

use alacritty_terminal::Term;
use alacritty_terminal::event::VoidListener;
use alacritty_terminal::grid::{Dimensions, Scroll};
use alacritty_terminal::term::Config as TermConfig;
use alacritty_terminal::term::cell::Flags;
use alacritty_terminal::vte::ansi::Processor;

use crate::color::{Palette, Rgba, blend};

/// Default dimensions when the caller does not specify a size up front.
const DEFAULT_COLS: u16 = 80;
const DEFAULT_ROWS: u16 = 24;

/// History retained for scrollback.
const SCROLLBACK: usize = 1000;

/// Size wrapper implementing alacritty's `Dimensions` trait.
#[derive(Copy, Clone, Debug)]
struct Dims {
    cols: usize,
    rows: usize,
}

impl Dimensions for Dims {
    fn total_lines(&self) -> usize {
        self.rows
    }

    fn screen_lines(&self) -> usize {
        self.rows
    }

    fn columns(&self) -> usize {
        self.cols
    }
}

/// One rendered cell — enough state for a single paint pass.
#[derive(Clone, Copy, Debug)]
pub struct RenderCell {
    pub ch: char,
    pub fg: Rgba,
    pub bg: Rgba,
    pub bold: bool,
    pub faint: bool,
}

impl RenderCell {
    fn blank(palette: &Palette) -> Self {
        Self {
            ch: ' ',
            fg: palette.foreground,
            bg: palette.background,
            bold: false,
            faint: false,
        }
    }
}

/// Immutable snapshot of the grid + cursor for a single paint pass.
///
/// `cursor_col`/`cursor_row` are `u16::MAX` when the cursor should not paint
/// (e.g. the viewport is scrolled back into history).
#[derive(Clone, Debug)]
pub struct GridSnapshot {
    pub cols: u16,
    pub rows: u16,
    pub cells: Vec<Vec<RenderCell>>,
    pub cursor_col: u16,
    pub cursor_row: u16,
}

impl GridSnapshot {
    /// Build a blank snapshot of the given dimensions on the default palette.
    /// Used as a fallback when the state mutex is poisoned and by tests.
    pub fn empty(cols: u16, rows: u16) -> Self {
        let palette = Palette::default();
        let cells = (0..rows)
            .map(|_| vec![RenderCell::blank(&palette); cols as usize])
            .collect();
        Self {
            cols,
            rows,
            cells,
            cursor_col: 0,
            cursor_row: 0,
        }
    }

    /// True when the cursor is hidden (scrolled into history).
    pub fn cursor_hidden(&self) -> bool {
        self.cursor_row == u16::MAX || self.cursor_col == u16::MAX
    }
}

/// A rectangular-by-reading-order text selection over the visible viewport.
/// `anchor` is where the drag began; `head` follows the pointer. Both are
/// `(col, row)` in viewport space (row 0 = top visible line). The `head` cell
/// is inclusive, matching how terminals copy the cell under the pointer.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Selection {
    pub anchor: (u16, u16),
    pub head: (u16, u16),
}

impl Selection {
    pub fn new(anchor: (u16, u16), head: (u16, u16)) -> Self {
        Self { anchor, head }
    }

    /// Return `(start, end)` ordered in reading order (top-to-bottom,
    /// left-to-right on the same row) so extraction and rect emission can walk
    /// forward regardless of drag direction.
    pub fn ordered(&self) -> ((u16, u16), (u16, u16)) {
        let (ac, ar) = self.anchor;
        let (hc, hr) = self.head;
        if (ar, ac) <= (hr, hc) {
            (self.anchor, self.head)
        } else {
            (self.head, self.anchor)
        }
    }

    /// True when the selection covers no cells (anchor == head is still one
    /// cell, so this is only ever false here — kept for call-site clarity).
    pub fn is_empty(&self) -> bool {
        false
    }
}

/// Holder for the alacritty parser + terminal state. Lives behind an
/// `Arc<Mutex<_>>` so `apply_output` (called from the PTY bridge) and
/// `snapshot` (called from paint) don't race.
struct TermState {
    term: Term<VoidListener>,
    parser: Processor,
    palette: Palette,
    cols: u16,
    rows: u16,
}

impl TermState {
    fn new(cols: u16, rows: u16, palette: Palette) -> Self {
        let dims = Dims {
            cols: cols as usize,
            rows: rows as usize,
        };
        let config = TermConfig {
            scrolling_history: SCROLLBACK,
            ..TermConfig::default()
        };
        let term = Term::new(config, &dims, VoidListener);
        Self {
            term,
            parser: Processor::new(),
            palette,
            cols,
            rows,
        }
    }

    fn apply(&mut self, bytes: &[u8]) {
        self.parser.advance(&mut self.term, bytes);
    }

    fn resize(&mut self, cols: u16, rows: u16) {
        if cols == self.cols && rows == self.rows {
            return;
        }
        let dims = Dims {
            cols: cols as usize,
            rows: rows as usize,
        };
        self.term.resize(dims);
        self.cols = cols;
        self.rows = rows;
    }

    fn snapshot(&self) -> GridSnapshot {
        let grid = self.term.grid();
        let cols = self.cols;
        let rows = self.rows;
        let mut cells =
            vec![vec![RenderCell::blank(&self.palette); cols as usize]; rows as usize];

        // When scrolled back, `display_iter` yields cells with negative
        // absolute line numbers (scrollback region). Compute the row
        // relative to the top of the viewport so both states paint.
        let display_offset = grid.display_offset() as i32;
        let viewport_top = -display_offset;
        for indexed in grid.display_iter() {
            let line = indexed.point.line.0;
            let relative = line - viewport_top;
            if relative < 0 || relative >= rows as i32 {
                continue;
            }
            let row = relative as usize;
            let col = indexed.point.column.0;
            if col >= cols as usize {
                continue;
            }
            let cell = indexed.cell;
            let flags = cell.flags;
            let inverse = flags.contains(Flags::INVERSE);
            let bold = flags.contains(Flags::BOLD);
            let faint = flags.contains(Flags::DIM);

            let mut fg = self.palette.resolve(cell.fg, true);
            let mut bg = self.palette.resolve(cell.bg, false);
            if inverse {
                std::mem::swap(&mut fg, &mut bg);
            }
            if faint {
                fg = blend(fg, bg, 0.5);
            }

            cells[row][col] = RenderCell {
                ch: cell.c,
                fg,
                bg,
                bold,
                faint,
            };
        }

        let cursor_point = grid.cursor.point;
        // Cursor only paints when the viewport includes the live bottom row.
        // When scrolled back, hide it — drawing a cursor in history would be
        // misleading.
        let (cursor_col, cursor_row) = if display_offset == 0 {
            (
                cursor_point.column.0 as u16,
                cursor_point.line.0.max(0) as u16,
            )
        } else {
            (u16::MAX, u16::MAX)
        };

        GridSnapshot {
            cols,
            rows,
            cells,
            cursor_col,
            cursor_row,
        }
    }

    fn scroll(&mut self, scroll: Scroll) {
        self.term.scroll_display(scroll);
    }

    fn display_offset(&self) -> usize {
        self.term.grid().display_offset()
    }
}

/// Owns a terminal + parser and exposes byte-in / snapshot-out. UI-agnostic:
/// a renderer (iced, wgpu, …) drives it and paints the snapshots.
pub struct GridTerminal {
    state: Arc<Mutex<TermState>>,
    /// A copy of the palette so the render-list path can read it without
    /// taking the state lock. The authoritative copy lives in `TermState`.
    palette: Palette,
    focused: bool,
    /// Active mouse selection over the viewport, if any.
    selection: Option<Selection>,
}

impl GridTerminal {
    /// Create a default 80x24 grid on the default palette.
    pub fn new() -> Self {
        Self::with_size(DEFAULT_COLS, DEFAULT_ROWS)
    }

    pub fn with_size(cols: u16, rows: u16) -> Self {
        Self::with_palette(cols, rows, Palette::default())
    }

    pub fn with_palette(cols: u16, rows: u16, palette: Palette) -> Self {
        let cols = cols.max(2);
        let rows = rows.max(1);
        Self {
            state: Arc::new(Mutex::new(TermState::new(cols, rows, palette))),
            palette,
            focused: false,
            selection: None,
        }
    }

    /// The palette this terminal resolves colors against.
    pub fn palette(&self) -> Palette {
        self.palette
    }

    /// Snapshot the grid and lower it into a backend-neutral draw list in one
    /// step. The renderer supplies cell metrics from its font; focus state and
    /// palette come from this terminal. When a selection is active its wash
    /// rects are appended so the same solid-quad pass paints them.
    pub fn render_list(&self, metrics: crate::render::CellMetrics) -> crate::render::RenderList {
        let snap = self.snapshot();
        let mut list =
            crate::render::build_render_list(&snap, metrics, &self.palette, self.focused);
        if let Some(sel) = self.selection {
            crate::render::append_selection_rects(
                &mut list,
                &snap,
                &sel,
                metrics,
                self.palette.selection,
            );
        }
        list
    }

    /// Begin/replace the selection anchor+head, or clear it. Coordinates are
    /// viewport cells; callers map pointer pixels to cells before calling.
    pub fn set_selection(&mut self, selection: Option<Selection>) {
        self.selection = selection;
    }

    /// Drop any active selection (e.g. on a fresh keystroke).
    pub fn clear_selection(&mut self) {
        self.selection = None;
    }

    pub fn has_selection(&self) -> bool {
        self.selection.is_some()
    }

    /// Plain text of the current selection, or `None` when nothing is selected.
    /// Trailing padding is trimmed per line and rows join with `\n`.
    pub fn selected_text(&self) -> Option<String> {
        let sel = self.selection?;
        Some(snapshot_selection_text(&self.snapshot(), &sel))
    }

    /// Feed raw PTY bytes into the terminal parser.
    pub fn apply_output(&mut self, bytes: &[u8]) {
        if bytes.is_empty() {
            return;
        }
        if let Ok(mut state) = self.state.lock() {
            state.apply(bytes);
        }
    }

    /// Resize the terminal to the given cell grid.
    pub fn resize(&mut self, cols: u16, rows: u16) {
        let cols = cols.max(2);
        let rows = rows.max(1);
        if let Ok(mut state) = self.state.lock() {
            state.resize(cols, rows);
        }
    }

    /// Take a snapshot of the current grid (called from paint, also used by
    /// tests). Recovers from a poisoned mutex — a render must never panic.
    pub fn snapshot(&self) -> GridSnapshot {
        match self.state.lock() {
            Ok(state) => state.snapshot(),
            Err(poisoned) => poisoned.into_inner().snapshot(),
        }
    }

    /// Tell the engine whether the renderer believes it owns focus. The
    /// renderer typically only paints a cursor when focused.
    pub fn set_focused(&mut self, focused: bool) {
        self.focused = focused;
    }

    pub fn is_focused(&self) -> bool {
        self.focused
    }

    pub fn dims(&self) -> (u16, u16) {
        self.state
            .lock()
            .map(|s| (s.cols, s.rows))
            .unwrap_or((DEFAULT_COLS, DEFAULT_ROWS))
    }

    /// Scroll the viewport relative to the current offset. Positive `lines`
    /// moves toward older history; negative moves toward the live bottom.
    /// Clamped by alacritty's own scroll limit internally.
    pub fn scroll_lines(&mut self, lines: i32) {
        if lines == 0 {
            return;
        }
        if let Ok(mut state) = self.state.lock() {
            state.scroll(Scroll::Delta(lines));
        }
    }

    pub fn scroll_page_up(&mut self) {
        if let Ok(mut state) = self.state.lock() {
            state.scroll(Scroll::PageUp);
        }
    }

    pub fn scroll_page_down(&mut self) {
        if let Ok(mut state) = self.state.lock() {
            state.scroll(Scroll::PageDown);
        }
    }

    pub fn scroll_to_top(&mut self) {
        if let Ok(mut state) = self.state.lock() {
            state.scroll(Scroll::Top);
        }
    }

    pub fn scroll_to_bottom(&mut self) {
        if let Ok(mut state) = self.state.lock() {
            state.scroll(Scroll::Bottom);
        }
    }

    /// Distance above the live bottom, in lines. `0` = live.
    pub fn display_offset(&self) -> usize {
        self.state.lock().map(|s| s.display_offset()).unwrap_or(0)
    }

    /// Extract the currently visible viewport as plain text. Each row is
    /// trimmed of trailing whitespace (terminals pad with blanks) and joined
    /// with `\n`. Used by copy-without-selection so the copy path is useful
    /// before mouse-drag selection lands.
    pub fn visible_text(&self) -> String {
        snapshot_to_text(&self.snapshot())
    }
}

/// Pull plain text out of a grid snapshot. Pure fn so the copy path can be
/// tested without a live PTY or renderer.
pub fn snapshot_to_text(snap: &GridSnapshot) -> String {
    let mut out = String::new();
    let mut lines: Vec<String> = snap
        .cells
        .iter()
        .map(|row| {
            let line: String = row.iter().map(|c| c.ch).collect();
            line.trim_end().to_string()
        })
        .collect();
    // Drop trailing blank rows so we don't copy a viewport full of empty
    // lines when the user only has a short shell prompt on screen.
    while matches!(lines.last(), Some(l) if l.is_empty()) {
        lines.pop();
    }
    for line in lines {
        out.push_str(&line);
        out.push('\n');
    }
    // Final newline is preserved so pastes into code editors work
    // predictably; strip only if empty.
    if out == "\n" {
        out.clear();
    }
    out
}

/// Extract the text covered by `sel` from a snapshot. Walks reading-order from
/// the ordered start to the ordered end; the first/last rows honor the start/
/// end columns, interior rows take the full width. Each row is `trim_end`ed
/// (terminals pad with blanks) and rows join with `\n`. Pure so the copy path
/// is unit-testable without a live PTY.
pub fn snapshot_selection_text(snap: &GridSnapshot, sel: &Selection) -> String {
    let (start, end) = sel.ordered();
    let (start_col, start_row) = start;
    let (end_col, end_row) = end;
    let rows = snap.cells.len();
    if rows == 0 {
        return String::new();
    }
    let last_row = (rows - 1) as u16;
    let start_row = start_row.min(last_row);
    let end_row = end_row.min(last_row);

    let mut lines: Vec<String> = Vec::new();
    for row in start_row..=end_row {
        let cells = &snap.cells[row as usize];
        let width = cells.len();
        if width == 0 {
            lines.push(String::new());
            continue;
        }
        let last_col = (width - 1) as u16;
        let c0 = if row == start_row { start_col.min(last_col) } else { 0 };
        // `head` cell is inclusive, so the end column is +1 (saturating at
        // the row width).
        let c1 = if row == end_row {
            (end_col.min(last_col) as usize) + 1
        } else {
            width
        };
        let c0 = c0 as usize;
        if c0 >= c1 {
            lines.push(String::new());
            continue;
        }
        let line: String = cells[c0..c1].iter().map(|c| c.ch).collect();
        lines.push(line.trim_end().to_string());
    }
    lines.join("\n")
}

impl Default for GridTerminal {
    fn default() -> Self {
        Self::new()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::color::ANSI_16;
    use std::time::Instant;

    #[test]
    fn feeds_plain_text_into_row_zero() {
        let mut term = GridTerminal::new();
        term.apply_output(b"hello\r\n");

        let snap = term.snapshot();
        let row0 = &snap.cells[0];
        let chars: String = row0.iter().take(5).map(|c| c.ch).collect();
        assert_eq!(chars, "hello");
        let default_fg = Palette::default().foreground;
        for c in row0.iter().take(5) {
            assert!(
                c.fg.approx_eq(default_fg),
                "expected default fg for unstyled text, got {:?}",
                c.fg
            );
        }
    }

    #[test]
    fn ansi_red_sgr_sets_red_foreground() {
        let mut term = GridTerminal::new();
        term.apply_output(b"\x1b[31mred\x1b[0m");

        let snap = term.snapshot();
        let row0 = &snap.cells[0];
        let red = ANSI_16[1];
        for (i, ch) in ['r', 'e', 'd'].iter().enumerate() {
            assert_eq!(row0[i].ch, *ch, "char mismatch at col {i}");
            assert!(
                row0[i].fg.approx_eq(red),
                "expected red fg at col {i}, got {:?}",
                row0[i].fg
            );
        }
        // The fourth cell should remain default (blank space).
        assert_eq!(row0[3].ch, ' ');
    }

    #[test]
    fn resize_updates_dimensions() {
        let mut term = GridTerminal::with_size(80, 24);
        term.resize(40, 12);
        let (c, r) = term.dims();
        assert_eq!((c, r), (40, 12));
        let snap = term.snapshot();
        assert_eq!(snap.cols, 40);
        assert_eq!(snap.rows, 12);
        assert_eq!(snap.cells.len(), 12);
        assert_eq!(snap.cells[0].len(), 40);
    }

    #[test]
    fn snapshot_timing_is_cheap_at_80x24() {
        // Not a hard assertion — a breadcrumb for perf tracking. Populate
        // every cell with a colored character, then time N snapshots.
        let mut term = GridTerminal::with_size(80, 24);
        let mut bytes = Vec::new();
        for _ in 0..24 {
            bytes.extend_from_slice(b"\x1b[31m");
            for _ in 0..80 {
                bytes.push(b'x');
            }
            bytes.extend_from_slice(b"\x1b[0m\r\n");
        }
        term.apply_output(&bytes);

        let iters = 50;
        let start = Instant::now();
        for _ in 0..iters {
            let _ = term.snapshot();
        }
        let per = start.elapsed() / iters;
        eprintln!("grid snapshot 80x24: per={per:?}");
        assert!(per.as_millis() < 50);
    }

    #[test]
    fn visible_text_captures_shell_output_without_trailing_blanks() {
        let mut term = GridTerminal::with_size(40, 6);
        term.apply_output(b"aura-term> cargo test\r\nrunning 65 tests\r\n");
        let text = term.visible_text();
        assert!(text.contains("aura-term> cargo test"), "got: {text:?}");
        assert!(text.contains("running 65 tests"), "got: {text:?}");
        let trailing_blanks = text.lines().rev().take_while(|l| l.is_empty()).count();
        assert_eq!(trailing_blanks, 0, "expected trimmed trailing blanks");
    }

    #[test]
    fn snapshot_to_text_empty_snapshot_is_empty_string() {
        let snap = GridSnapshot::empty(10, 4);
        assert_eq!(snapshot_to_text(&snap), "");
    }

    #[test]
    fn selection_single_row_copies_exact_span() {
        let mut term = GridTerminal::with_size(20, 3);
        term.apply_output(b"hello world");
        let snap = term.snapshot();
        // Select "world" — cols 6..=10 on row 0 (head inclusive).
        let sel = Selection::new((6, 0), (10, 0));
        assert_eq!(snapshot_selection_text(&snap, &sel), "world");
    }

    #[test]
    fn selection_is_direction_agnostic() {
        let mut term = GridTerminal::with_size(20, 3);
        term.apply_output(b"hello world");
        let snap = term.snapshot();
        // Anchor after head (dragged right-to-left) yields the same text.
        let sel = Selection::new((10, 0), (6, 0));
        assert_eq!(snapshot_selection_text(&snap, &sel), "world");
    }

    #[test]
    fn selection_multi_row_joins_with_newlines_and_trims() {
        let mut term = GridTerminal::with_size(20, 4);
        term.apply_output(b"first line\r\nsecond line\r\nthird");
        let snap = term.snapshot();
        // From col 6 of row 0 ("line") through col 5 of row 1 ("second").
        let sel = Selection::new((6, 0), (5, 1));
        assert_eq!(snapshot_selection_text(&snap, &sel), "line\nsecond");
    }

    #[test]
    fn selection_rects_emit_one_per_row() {
        let mut term = GridTerminal::with_size(20, 4);
        term.apply_output(b"aaaa\r\nbbbb");
        term.set_selection(Some(Selection::new((0, 0), (3, 1))));
        let list = term.render_list(crate::render::CellMetrics::new(8.0, 16.0));
        // Two selected rows → two selection rects (over any glyph bg rects,
        // of which plain text on default ground has none).
        let sel_color = term.palette().selection;
        let sel_rects: Vec<_> = list
            .bg_rects
            .iter()
            .filter(|r| r.color.approx_eq(sel_color))
            .collect();
        assert_eq!(sel_rects.len(), 2, "one wash rect per selected row");
        assert_eq!(sel_rects[0].y, 0.0);
        assert_eq!(sel_rects[1].y, 16.0);
    }

    #[test]
    fn clearing_selection_removes_wash() {
        let mut term = GridTerminal::with_size(10, 2);
        term.apply_output(b"hi");
        term.set_selection(Some(Selection::new((0, 0), (1, 0))));
        assert!(term.has_selection());
        term.clear_selection();
        assert!(!term.has_selection());
        assert!(term.selected_text().is_none());
    }

    #[test]
    fn scrollback_shows_older_lines_when_scrolled_up() {
        // 10-row viewport; feed 40 distinct lines. Before scroll, only the
        // last 10 are visible. After scrolling up, the top of the buffer
        // comes into view and the cursor hides.
        let mut term = GridTerminal::with_size(20, 10);
        let mut bytes = Vec::new();
        for i in 0..40 {
            bytes.extend_from_slice(format!("line-{i:02}\r\n").as_bytes());
        }
        term.apply_output(&bytes);

        assert_eq!(term.display_offset(), 0);
        let live = term.snapshot();
        let last_text: String = live.cells[live.cells.len() - 2]
            .iter()
            .map(|c| c.ch)
            .collect();
        assert!(
            last_text.starts_with("line-39"),
            "expected bottom row to be line-39, got {last_text:?}"
        );

        // Scroll up past all history to land at the top.
        term.scroll_lines(40);
        assert!(term.display_offset() > 0);

        let scrolled = term.snapshot();
        let top_text: String = scrolled.cells[0].iter().map(|c| c.ch).collect();
        assert!(
            top_text.starts_with("line-00"),
            "expected top row to be line-00 after scroll, got {top_text:?}"
        );

        // Cursor must be hidden in scrollback.
        assert!(scrolled.cursor_hidden());

        // Returning to bottom restores the live view.
        term.scroll_to_bottom();
        assert_eq!(term.display_offset(), 0);
        let live2 = term.snapshot();
        let last2: String = live2.cells[live2.cells.len() - 2]
            .iter()
            .map(|c| c.ch)
            .collect();
        assert!(last2.starts_with("line-39"));
    }
}
