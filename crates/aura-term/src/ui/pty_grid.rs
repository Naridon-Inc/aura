//! PTY grid renderer — paints an `alacritty_terminal::Term` to an
//! `iced::canvas::Canvas`. Phase 4 W-I foundation.
//!
//! Keystroke forwarding is intentionally out of scope in this wave — this
//! module only owns the terminal state machine and renders its cell grid.
//! See `aura-term/src/pty.rs` for byte-stream input plumbing.
//!
//! Rendering model: bytes fed via [`GridCanvas::apply_output`] are parsed by
//! a `vte::ansi::Processor` which drives a `Term<VoidListener>`. On each
//! paint we take a cheap snapshot of the grid (char + fg + bg + flags per
//! cell) and hand it to the canvas `Program`. This keeps the paint path
//! lock-free relative to the PTY read thread.
//!
//! Metrics are hard-coded at `char_w = 8.0`, `char_h = 16.0` for v1. Will
//! be replaced with real font metrics in a later wave.

use std::sync::{Arc, Mutex};

use alacritty_terminal::Term;
use alacritty_terminal::event::VoidListener;
use alacritty_terminal::grid::{Dimensions, Scroll};
use alacritty_terminal::term::Config as TermConfig;
use alacritty_terminal::term::cell::Flags;
use alacritty_terminal::vte::ansi::{Color as AColor, NamedColor, Processor, Rgb};
use iced::widget::canvas::{self, Canvas, Frame, Geometry, Text};
use iced::{Color, Element, Length, Pixels, Point, Rectangle, Renderer, Size, Theme, mouse};

use crate::theme;

/// Fixed cell metrics for v1 — tuned later against real font extents.
pub const CHAR_W: f32 = 8.0;
pub const CHAR_H: f32 = 16.0;

/// Default dimensions when the caller does not specify a size up front.
const DEFAULT_COLS: u16 = 80;
const DEFAULT_ROWS: u16 = 24;

/// History we retain for scrollback. Not scrolled in v1 but keeps the
/// `Term` behaving naturally if an app emits alt-screen transitions.
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

/// One painted cell — enough state for a single paint pass.
#[derive(Clone, Copy, Debug)]
pub struct RenderCell {
    pub ch: char,
    pub fg: Color,
    pub bg: Color,
    pub bold: bool,
    pub faint: bool,
}

impl RenderCell {
    fn blank() -> Self {
        Self {
            ch: ' ',
            fg: default_fg(),
            bg: default_bg(),
            bold: false,
            faint: false,
        }
    }
}

/// Immutable snapshot of the grid + cursor used for a single paint pass.
#[derive(Clone, Debug)]
pub struct GridSnapshot {
    pub cols: u16,
    pub rows: u16,
    pub cells: Vec<Vec<RenderCell>>,
    pub cursor_col: u16,
    pub cursor_row: u16,
}

impl GridSnapshot {
    /// Build a blank snapshot of the given dimensions. Used as a fallback
    /// when the state mutex is poisoned.
    #[allow(dead_code)]
    pub fn empty(cols: u16, rows: u16) -> Self {
        let cells = (0..rows)
            .map(|_| vec![RenderCell::blank(); cols as usize])
            .collect();
        Self {
            cols,
            rows,
            cells,
            cursor_col: 0,
            cursor_row: 0,
        }
    }
}

/// Holder for the alacritty parser + terminal state. Lives behind an
/// `Arc<Mutex<_>>` so apply_output (called from UI / bridge) and snapshot
/// (called from paint) don't race.
struct TermState {
    term: Term<VoidListener>,
    parser: Processor,
    cols: u16,
    rows: u16,
}

impl TermState {
    fn new(cols: u16, rows: u16) -> Self {
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
        let mut cells = vec![vec![RenderCell::blank(); cols as usize]; rows as usize];

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

            let mut fg = alacritty_color_to_iced(cell.fg, true);
            let mut bg = alacritty_color_to_iced(cell.bg, false);
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
        // Cursor only paints when the viewport includes the live bottom
        // row. When scrolled back, hide it — drawing a cursor in history
        // would be misleading.
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

/// Owns a terminal + parser and exposes a paintable canvas view.
pub struct GridCanvas {
    state: Arc<Mutex<TermState>>,
    focused: bool,
}

impl GridCanvas {
    /// Create a default 80x24 grid.
    pub fn new() -> Self {
        Self::with_size(DEFAULT_COLS, DEFAULT_ROWS)
    }

    pub fn with_size(cols: u16, rows: u16) -> Self {
        let cols = cols.max(2);
        let rows = rows.max(1);
        Self {
            state: Arc::new(Mutex::new(TermState::new(cols, rows))),
            focused: false,
        }
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

    /// Take a snapshot of the current grid (called from paint, also used
    /// by tests).
    pub fn snapshot(&self) -> GridSnapshot {
        match self.state.lock() {
            Ok(state) => state.snapshot(),
            Err(poisoned) => poisoned.into_inner().snapshot(),
        }
    }

    /// Tell the canvas whether the work surface believes it owns focus.
    /// Currently controls cursor rendering; keystroke dispatch lands in a
    /// later wave.
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

    /// Scroll the viewport relative to the current offset. Positive
    /// `lines` moves toward older history; negative moves toward the live
    /// bottom. Clamped by alacritty's own scroll limit internally.
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
        self.state
            .lock()
            .map(|s| s.display_offset())
            .unwrap_or(0)
    }

    /// Extract the currently visible viewport as plain text. Each row is
    /// trimmed of trailing whitespace (terminals pad with blanks) and
    /// joined with `\n`. Used by Cmd+C when no explicit selection exists;
    /// this keeps the copy path useful before mouse-drag selection lands.
    pub fn visible_text(&self) -> String {
        let snap = self.snapshot();
        snapshot_to_text(&snap)
    }
}

/// Pull plain text out of a grid snapshot. Pure fn so the copy path can
/// be tested without a live PTY or canvas.
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
    // Drop trailing blank rows so we don't copy a viewport full of
    // empty lines when the user only has a short shell prompt on
    // screen.
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

impl Default for GridCanvas {
    fn default() -> Self {
        Self::new()
    }
}

/// Build an iced `Element` that paints the grid.
pub fn view<'a, M: 'a>(state: &'a GridCanvas) -> Element<'a, M> {
    let program = GridProgram {
        snapshot: state.snapshot(),
        focused: state.focused,
    };
    Canvas::new(program)
        .width(Length::Fill)
        .height(Length::Fill)
        .into()
}

/// The canvas `Program` that actually paints cells. Holds the snapshot by
/// value so the paint pass does not need to grab the state mutex again.
struct GridProgram {
    snapshot: GridSnapshot,
    focused: bool,
}

impl<M> canvas::Program<M> for GridProgram {
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
        paint_snapshot(&mut frame, &self.snapshot, self.focused);
        vec![frame.into_geometry()]
    }
}

fn paint_snapshot(frame: &mut Frame<Renderer>, snap: &GridSnapshot, focused: bool) {
    // First pass: backgrounds. Contiguous cells sharing a bg get merged
    // into a single fill_rectangle — halves the draw calls for typical
    // TUI output which has long default-bg runs.
    for (row_idx, row) in snap.cells.iter().enumerate() {
        let mut col = 0usize;
        while col < row.len() {
            let bg = row[col].bg;
            let mut run_end = col + 1;
            while run_end < row.len() && color_eq(row[run_end].bg, bg) {
                run_end += 1;
            }
            if !color_eq(bg, default_bg()) {
                let x = col as f32 * CHAR_W;
                let y = row_idx as f32 * CHAR_H;
                let w = (run_end - col) as f32 * CHAR_W;
                frame.fill_rectangle(
                    Point::new(x, y),
                    Size::new(w, CHAR_H),
                    bg,
                );
            }
            col = run_end;
        }
    }

    // Cursor — drawn behind the glyph so the character shows through
    // inverted. Only rendered when the canvas owns focus, per spec.
    if focused && (snap.cursor_row as usize) < snap.cells.len() {
        let x = snap.cursor_col as f32 * CHAR_W;
        let y = snap.cursor_row as f32 * CHAR_H;
        frame.fill_rectangle(
            Point::new(x, y),
            Size::new(CHAR_W, CHAR_H),
            theme::ACCENT,
        );
    }

    // Second pass: glyphs. Skip blank spaces on default bg; no-op anyway.
    for (row_idx, row) in snap.cells.iter().enumerate() {
        for (col_idx, cell) in row.iter().enumerate() {
            if cell.ch == ' ' || cell.ch == '\0' {
                continue;
            }
            // If this is the cursor cell and we're focused, flip the fg
            // so the glyph contrasts with the accent background.
            let is_cursor_cell = focused
                && (col_idx as u16) == snap.cursor_col
                && (row_idx as u16) == snap.cursor_row;
            let color = if is_cursor_cell { theme::BG } else { cell.fg };

            let font = if cell.bold { theme::MONO_MED } else { theme::MONO };
            let text = Text {
                content: cell.ch.to_string(),
                position: Point::new(col_idx as f32 * CHAR_W, row_idx as f32 * CHAR_H),
                color,
                size: Pixels(CHAR_H - 2.0),
                font,
                ..Default::default()
            };
            frame.fill_text(text);
        }
    }
}

// ─────────────────────────────────────────────────────────────────────────
// color helpers
// ─────────────────────────────────────────────────────────────────────────

fn color_eq(a: Color, b: Color) -> bool {
    (a.r - b.r).abs() < f32::EPSILON
        && (a.g - b.g).abs() < f32::EPSILON
        && (a.b - b.b).abs() < f32::EPSILON
        && (a.a - b.a).abs() < f32::EPSILON
}

fn blend(a: Color, b: Color, t: f32) -> Color {
    let t = t.clamp(0.0, 1.0);
    Color {
        r: a.r * (1.0 - t) + b.r * t,
        g: a.g * (1.0 - t) + b.g * t,
        b: a.b * (1.0 - t) + b.b * t,
        a: 1.0,
    }
}

const fn rgb(r: u8, g: u8, b: u8) -> Color {
    Color::from_rgba(r as f32 / 255.0, g as f32 / 255.0, b as f32 / 255.0, 1.0)
}

fn default_fg() -> Color {
    theme::TEXT
}

fn default_bg() -> Color {
    theme::CONTENT
}

/// Convert an alacritty `Color` into an iced `Color`. `is_fg` picks the
/// right default when the cell references the named foreground or
/// background slot.
pub fn alacritty_color_to_iced(color: AColor, is_fg: bool) -> Color {
    match color {
        AColor::Spec(rgb) => rgb_to_iced(rgb),
        AColor::Named(named) => named_to_iced(named, is_fg),
        AColor::Indexed(idx) => indexed_to_iced(idx, is_fg),
    }
}

fn rgb_to_iced(c: Rgb) -> Color {
    Color::from_rgba(
        c.r as f32 / 255.0,
        c.g as f32 / 255.0,
        c.b as f32 / 255.0,
        1.0,
    )
}

/// Standard xterm 16-color palette. Indices 0..=7 = normal, 8..=15 = bright.
const PALETTE_16: [Color; 16] = [
    rgb(0x00, 0x00, 0x00), // black
    rgb(0xcd, 0x31, 0x31), // red
    rgb(0x0d, 0xbc, 0x79), // green
    rgb(0xe5, 0xe5, 0x10), // yellow
    rgb(0x24, 0x72, 0xc8), // blue
    rgb(0xbc, 0x3f, 0xbc), // magenta
    rgb(0x11, 0xa8, 0xcd), // cyan
    rgb(0xe5, 0xe5, 0xe5), // white
    rgb(0x66, 0x66, 0x66), // bright black
    rgb(0xf1, 0x4c, 0x4c), // bright red
    rgb(0x23, 0xd1, 0x8b), // bright green
    rgb(0xf5, 0xf5, 0x43), // bright yellow
    rgb(0x3b, 0x8e, 0xea), // bright blue
    rgb(0xd6, 0x70, 0xd6), // bright magenta
    rgb(0x29, 0xb8, 0xdb), // bright cyan
    rgb(0xff, 0xff, 0xff), // bright white
];

fn named_to_iced(n: NamedColor, is_fg: bool) -> Color {
    use NamedColor::*;
    match n {
        Black => PALETTE_16[0],
        Red => PALETTE_16[1],
        Green => PALETTE_16[2],
        Yellow => PALETTE_16[3],
        Blue => PALETTE_16[4],
        Magenta => PALETTE_16[5],
        Cyan => PALETTE_16[6],
        White => PALETTE_16[7],
        BrightBlack => PALETTE_16[8],
        BrightRed => PALETTE_16[9],
        BrightGreen => PALETTE_16[10],
        BrightYellow => PALETTE_16[11],
        BrightBlue => PALETTE_16[12],
        BrightMagenta => PALETTE_16[13],
        BrightCyan => PALETTE_16[14],
        BrightWhite => PALETTE_16[15],
        DimBlack => blend(PALETTE_16[0], default_bg(), 0.5),
        DimRed => blend(PALETTE_16[1], default_bg(), 0.5),
        DimGreen => blend(PALETTE_16[2], default_bg(), 0.5),
        DimYellow => blend(PALETTE_16[3], default_bg(), 0.5),
        DimBlue => blend(PALETTE_16[4], default_bg(), 0.5),
        DimMagenta => blend(PALETTE_16[5], default_bg(), 0.5),
        DimCyan => blend(PALETTE_16[6], default_bg(), 0.5),
        DimWhite => blend(PALETTE_16[7], default_bg(), 0.5),
        Foreground | BrightForeground => {
            if is_fg {
                default_fg()
            } else {
                default_fg()
            }
        }
        DimForeground => blend(default_fg(), default_bg(), 0.5),
        Background => default_bg(),
        Cursor => theme::ACCENT,
    }
}

fn indexed_to_iced(idx: u8, is_fg: bool) -> Color {
    if (idx as usize) < PALETTE_16.len() {
        return PALETTE_16[idx as usize];
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
        return Color::from_rgba(to_c(r), to_c(g), to_c(b), 1.0);
    }
    if idx >= 232 {
        // Grayscale ramp: 24 steps from near-black to near-white.
        let level = 8 + (idx - 232) as u16 * 10;
        let l = level.min(255) as f32 / 255.0;
        return Color::from_rgba(l, l, l, 1.0);
    }
    if is_fg { default_fg() } else { default_bg() }
}

// ─────────────────────────────────────────────────────────────────────────
// tests
// ─────────────────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::Instant;

    #[test]
    fn feeds_plain_text_into_row_zero() {
        let mut canvas = GridCanvas::new();
        canvas.apply_output(b"hello\r\n");

        let snap = canvas.snapshot();
        let row0 = &snap.cells[0];
        let chars: String = row0.iter().take(5).map(|c| c.ch).collect();
        assert_eq!(chars, "hello");
        for c in row0.iter().take(5) {
            assert!(
                color_eq(c.fg, default_fg()),
                "expected default fg for unstyled text, got {:?}",
                c.fg
            );
        }
    }

    #[test]
    fn ansi_red_sgr_sets_red_foreground() {
        let mut canvas = GridCanvas::new();
        canvas.apply_output(b"\x1b[31mred\x1b[0m");

        let snap = canvas.snapshot();
        let row0 = &snap.cells[0];
        let red = PALETTE_16[1];
        for (i, ch) in ['r', 'e', 'd'].iter().enumerate() {
            assert_eq!(row0[i].ch, *ch, "char mismatch at col {i}");
            assert!(
                color_eq(row0[i].fg, red),
                "expected red fg at col {i}, got {:?}",
                row0[i].fg
            );
        }
        // The fourth cell should remain default (blank space, default fg).
        assert_eq!(row0[3].ch, ' ');
    }

    #[test]
    fn resize_updates_dimensions() {
        let mut canvas = GridCanvas::with_size(80, 24);
        canvas.resize(40, 12);
        let (c, r) = canvas.dims();
        assert_eq!((c, r), (40, 12));
        let snap = canvas.snapshot();
        assert_eq!(snap.cols, 40);
        assert_eq!(snap.rows, 12);
        assert_eq!(snap.cells.len(), 12);
        assert_eq!(snap.cells[0].len(), 40);
    }

    #[test]
    fn snapshot_timing_is_cheap_at_80x24() {
        // Not a hard assertion — just a breadcrumb for perf tracking.
        // Populate every cell with a colored character, then time N
        // snapshots.
        let mut canvas = GridCanvas::with_size(80, 24);
        let mut bytes = Vec::new();
        for _ in 0..24 {
            bytes.extend_from_slice(b"\x1b[31m");
            for _ in 0..80 {
                bytes.push(b'x');
            }
            bytes.extend_from_slice(b"\x1b[0m\r\n");
        }
        canvas.apply_output(&bytes);

        let iters = 50;
        let start = Instant::now();
        for _ in 0..iters {
            let _ = canvas.snapshot();
        }
        let elapsed = start.elapsed();
        let per = elapsed / iters;
        eprintln!(
            "pty_grid snapshot 80x24: total={:?} per={:?}",
            elapsed, per
        );
        // Sanity: a single snapshot should complete in well under 50ms on
        // any dev machine. Anything slower likely indicates a regression.
        assert!(per.as_millis() < 50);
    }

    #[test]
    fn visible_text_captures_shell_output_without_trailing_blanks() {
        let mut canvas = GridCanvas::with_size(40, 6);
        canvas.apply_output(b"aura-term> cargo test\r\nrunning 65 tests\r\n");
        let text = canvas.visible_text();
        assert!(text.contains("aura-term> cargo test"), "got: {text:?}");
        assert!(text.contains("running 65 tests"), "got: {text:?}");
        // No runs of empty trailing lines — the viewport had 6 rows but
        // only 2 were populated.
        let trailing_blanks = text
            .lines()
            .rev()
            .take_while(|l| l.is_empty())
            .count();
        assert_eq!(trailing_blanks, 0, "expected trimmed trailing blanks");
    }

    #[test]
    fn snapshot_to_text_empty_snapshot_is_empty_string() {
        let snap = GridSnapshot::empty(10, 4);
        assert_eq!(snapshot_to_text(&snap), "");
    }

    #[test]
    fn scrollback_shows_older_lines_when_scrolled_up() {
        // 10-row viewport; feed 40 distinct lines. Before scroll, only the
        // last 10 are visible. After scroll_page_up * several pages, the
        // top of the buffer comes into view.
        let mut canvas = GridCanvas::with_size(20, 10);
        let mut bytes = Vec::new();
        for i in 0..40 {
            bytes.extend_from_slice(format!("line-{i:02}\r\n").as_bytes());
        }
        canvas.apply_output(&bytes);

        // At the live bottom: last visible line should be roughly "line-39"
        // (last visible row before cursor — depends on trailing CRLF).
        assert_eq!(canvas.display_offset(), 0);
        let live = canvas.snapshot();
        let last_text: String = live.cells[live.cells.len() - 2]
            .iter()
            .map(|c| c.ch)
            .collect();
        assert!(
            last_text.starts_with("line-39"),
            "expected bottom row to be line-39, got {last_text:?}"
        );

        // Scroll up by multiple pages — we fed 40 lines into 10 rows, so
        // 30 lines of history exist. Step up 40 deltas to land at top.
        canvas.scroll_lines(40);
        assert!(canvas.display_offset() > 0);

        let scrolled = canvas.snapshot();
        // The top row of the viewport should now be the oldest row in
        // scrollback, which is "line-00".
        let top_text: String = scrolled.cells[0].iter().map(|c| c.ch).collect();
        assert!(
            top_text.starts_with("line-00"),
            "expected top row to be line-00 after scroll_to_top, got {top_text:?}"
        );

        // Cursor must be hidden in scrollback (sentinel u16::MAX outside range).
        assert!((scrolled.cursor_row as usize) >= scrolled.cells.len());

        // Returning to bottom restores live view.
        canvas.scroll_to_bottom();
        assert_eq!(canvas.display_offset(), 0);
        let live2 = canvas.snapshot();
        let last2: String = live2.cells[live2.cells.len() - 2]
            .iter()
            .map(|c| c.ch)
            .collect();
        assert!(last2.starts_with("line-39"));
    }
}
