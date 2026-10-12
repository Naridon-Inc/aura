//! What the engine can actually swallow, in MB/s.
//!
//! The whole case for a native terminal is that the in-page one stalls under
//! fast output, and that claim was unmeasured for as long as this engine has
//! existed. This measures the half that competes: taking PTY bytes apart and
//! turning the result into a draw list. It does not measure GPU submit, and it
//! does not measure anyone else's terminal — see the note printed at the end
//! for the one command that compares this against the terminal you use now.
//!
//! Run it:
//!
//! ```text
//! cargo run --release --example throughput -p aura-term-core
//! ```
//!
//! Release matters. A debug build of a byte-at-a-time parser measures the
//! absence of optimization, not the engine.

use std::time::{Duration, Instant};

use aura_term_core::{CellMetrics, GridTerminal};

/// Cells of the grid everything is measured against — a full-screen terminal
/// on a large display, which is the expensive case and the one a user with an
/// agent running actually has open.
const COLS: u16 = 212;
const ROWS: u16 = 56;

/// PTY reads arrive in chunks, and chunk size changes the answer: the parser
/// is called once per chunk but works a byte at a time, so a tiny chunk
/// measures call overhead and a huge one measures a buffer no PTY delivers.
/// 64 KiB is what a fast producer on a pipe this size actually hands over.
const CHUNK: usize = 64 * 1024;

/// Enough bytes that one slow frame cannot dominate the average, and few
/// enough that the whole run stays interactive.
const BYTES_PER_CASE: usize = 48 * 1024 * 1024;

fn main() {
    println!("aura-term-core throughput — {COLS}x{ROWS} grid, {} KiB chunks", CHUNK / 1024);
    println!("{}", "-".repeat(78));

    let cases: Vec<(&str, &str, Vec<u8>)> = vec![
        (
            "plain text",
            "`cat` of a big file: no escapes, just lines and scrolling",
            plain_text(),
        ),
        (
            "colored log",
            "a build log or `ls --color`: an SGR change every few words",
            colored_log(),
        ),
        (
            "full repaints",
            "an agent TUI in alt-screen: absolute cursor moves, whole screen rewritten",
            full_repaints(),
        ),
    ];

    let mut parsed_rows = Vec::new();

    for (name, shape, corpus) in &cases {
        let r = measure_parse(corpus);
        println!();
        println!("{name}  — {shape}");
        println!(
            "  parse + grid : {:>8.1} MB/s   ({:.1} ns/byte, {} over {:.2}s)",
            r.mb_per_s,
            r.ns_per_byte,
            human_bytes(r.bytes),
            r.elapsed.as_secs_f64(),
        );
        parsed_rows.push((*name, r.mb_per_s));
    }

    // The per-frame cost, which is the other half of "does it keep up". Output
    // throughput only matters if a frame can still be built between chunks.
    println!();
    let f = measure_frame_build(&cases[2].2);
    println!("frame build  — lowering the grid into a draw list, after a full repaint");
    println!(
        "  render_list  : {:>8.3} ms/frame  ({:.0} frames/s ceiling, {} bg rects + {} glyphs)",
        f.ms_per_frame,
        1000.0 / f.ms_per_frame,
        f.bg_rects,
        f.glyphs,
    );

    println!();
    println!("{}", "-".repeat(78));
    let worst = parsed_rows
        .iter()
        .min_by(|a, b| a.1.partial_cmp(&b.1).unwrap())
        .expect("three cases measured");
    println!(
        "Worst case is `{}` at {:.1} MB/s. What this does NOT say: nothing here",
        worst.0, worst.1
    );
    println!("touches the GPU, and nothing here measures another terminal.");
    println!();
    println!("To compare against the terminal you use now, run this in both and time it:");
    println!("  yes 'the quick brown fox jumps over the lazy dog' | head -2000000");
    println!();
}

/// Byte counts at the scale this runs at, so the line reads as a quantity
/// rather than a number to count digits in.
fn human_bytes(n: usize) -> String {
    const MIB: f64 = 1024.0 * 1024.0;
    format!("{:.0} MiB", n as f64 / MIB)
}

struct ParseResult {
    bytes: usize,
    elapsed: Duration,
    mb_per_s: f64,
    ns_per_byte: f64,
}

/// Feed a corpus through the parser in PTY-sized chunks until `BYTES_PER_CASE`
/// have gone through, timing only the parse.
fn measure_parse(corpus: &[u8]) -> ParseResult {
    let mut term = GridTerminal::with_size(COLS, ROWS);

    // Warm the grid's scrollback allocation so the first chunk is not paying
    // for everything the rest of the run reuses.
    term.apply_output(&corpus[..corpus.len().min(CHUNK)]);

    let mut fed = 0usize;
    let mut at = 0usize;
    let start = Instant::now();
    while fed < BYTES_PER_CASE {
        let end = (at + CHUNK).min(corpus.len());
        term.apply_output(&corpus[at..end]);
        fed += end - at;
        at = if end == corpus.len() { 0 } else { end };
    }
    let elapsed = start.elapsed();

    let secs = elapsed.as_secs_f64();
    ParseResult {
        bytes: fed,
        elapsed,
        mb_per_s: (fed as f64 / (1024.0 * 1024.0)) / secs,
        ns_per_byte: (secs * 1e9) / fed as f64,
    }
}

struct FrameResult {
    ms_per_frame: f64,
    bg_rects: usize,
    glyphs: usize,
}

/// Time `render_list` on a grid that has just been fully repainted — the state
/// a renderer is in when it has the most to draw.
fn measure_frame_build(corpus: &[u8]) -> FrameResult {
    let mut term = GridTerminal::with_size(COLS, ROWS);
    term.apply_output(&corpus[..corpus.len().min(CHUNK * 4)]);
    let metrics = CellMetrics::new(8.0, 17.0);

    let list = term.render_list(metrics);
    let (bg_rects, glyphs) = (list.bg_rects.len(), list.glyphs.len());

    let frames = 600;
    let start = Instant::now();
    for _ in 0..frames {
        let l = term.render_list(metrics);
        // Touch the result so the whole thing cannot be optimized away.
        std::hint::black_box(l.glyphs.len());
    }
    let elapsed = start.elapsed();

    FrameResult {
        ms_per_frame: (elapsed.as_secs_f64() * 1000.0) / frames as f64,
        bg_rects,
        glyphs,
    }
}

/// Lines of prose with no escape sequences at all. Every byte is a glyph and
/// every row scrolls the grid.
fn plain_text() -> Vec<u8> {
    let mut out = Vec::with_capacity(4 * 1024 * 1024);
    let line = b"the quick brown fox jumps over the lazy dog 0123456789 \
                 and keeps going until the line is about as wide as a window\r\n";
    while out.len() < 4 * 1024 * 1024 {
        out.extend_from_slice(line);
    }
    out
}

/// A build log: short runs of text separated by SGR colour changes, which is
/// where a parser that is slow about escapes shows it.
fn colored_log() -> Vec<u8> {
    let mut out = Vec::with_capacity(4 * 1024 * 1024);
    let colors: [&[u8]; 6] = [
        b"\x1b[32m", b"\x1b[31m", b"\x1b[33m", b"\x1b[36m", b"\x1b[1;35m", b"\x1b[0m",
    ];
    let words: [&[u8]; 5] = [
        b"Compiling ", b"aura-term-core ", b"v0.1.0 ", b"(/Volumes/T9/aura) ", b"warning: ",
    ];
    let mut i = 0usize;
    while out.len() < 4 * 1024 * 1024 {
        for w in words {
            out.extend_from_slice(colors[i % colors.len()]);
            out.extend_from_slice(w);
            i += 1;
        }
        out.extend_from_slice(b"\x1b[0m\r\n");
    }
    out
}

/// What an agent CLI does: switch to the alternate screen, then repaint the
/// whole viewport with absolute cursor addressing rather than scrolling. This
/// is the case the native engine exists for.
fn full_repaints() -> Vec<u8> {
    let mut out = Vec::with_capacity(4 * 1024 * 1024);
    out.extend_from_slice(b"\x1b[?1049h"); // alternate screen
    while out.len() < 4 * 1024 * 1024 {
        out.extend_from_slice(b"\x1b[2J"); // clear
        for row in 1..=ROWS {
            // Absolute position, then a row with a little colour in it — the
            // shape of a transcript line with a prefix and a body.
            out.extend_from_slice(format!("\x1b[{row};1H").as_bytes());
            out.extend_from_slice(b"\x1b[36m| \x1b[0m");
            out.extend_from_slice(
                b"streaming a line of agent output that fills most of the width here",
            );
        }
    }
    out
}
