//! Proof that scrolling up actually shows earlier output.
//!
//! Everything in this test is the engine the app runs: a real
//! `aura_term_core::GridTerminal` parsing real bytes, the real wheel decision,
//! and the real `aura_term_gpu::Renderer` drawing into a GPU texture with the
//! same calls the render thread makes. Only the surface is different — an
//! offscreen texture instead of a `CAMetalLayer` — because a window cannot be
//! driven from a test.
//!
//! The assertions are at two levels, because each one alone can lie. The text
//! of the viewport says the right rows were chosen; the pixels say those rows
//! were actually drawn, which is the part a viewport offset moving correctly in
//! memory would not prove. Both frames are written out as PNGs so the claim can
//! be checked by eye rather than taken on trust.
//!
//! Needs a GPU, so it skips rather than fails where there is no adapter.

use std::io::BufWriter;
use std::path::PathBuf;

use aura_term_core::{CellMetrics, GridTerminal, WheelAction};
use aura_term_gpu::Renderer;

const COLS: u16 = 60;
const ROWS: u16 = 20;
const FONT_PX: f32 = 16.0;
const TOTAL_LINES: usize = 200;
/// How far up the wheel goes, in lines.
const SCROLL_LINES: i32 = 60;

/// Two hundred numbered lines, each with a bar as long as its own number is
/// wide, the way a build log or a test run fills a terminal.
fn numbered_lines() -> Vec<u8> {
    let mut bytes = Vec::new();
    for i in 0..TOTAL_LINES {
        let bar = "#".repeat(i % 31);
        bytes.extend_from_slice(format!("line-{i:03} {bar}\r\n").as_bytes());
    }
    bytes
}

/// Where the proof frames land. Ignored by git, next to the UI harness shots.
fn shots_dir() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../aura-shell/uiharness/shots")
}

fn write_png(path: &PathBuf, rgba: &[u8], w: u32, h: u32) {
    let file = std::fs::File::create(path).expect("create png");
    let mut encoder = png::Encoder::new(BufWriter::new(file), w, h);
    encoder.set_color(png::ColorType::Rgba);
    encoder.set_depth(png::BitDepth::Eight);
    encoder
        .write_header()
        .expect("png header")
        .write_image_data(rgba)
        .expect("png data");
}

#[test]
fn scrolling_up_puts_earlier_lines_back_on_screen() {
    let instance = wgpu::Instance::default();
    let adapter = match pollster::block_on(instance.request_adapter(&wgpu::RequestAdapterOptions {
        power_preference: wgpu::PowerPreference::default(),
        force_fallback_adapter: false,
        compatible_surface: None,
    })) {
        Ok(a) => a,
        Err(_) => {
            eprintln!("no GPU adapter available — skipping scrollback render proof");
            return;
        }
    };
    let (device, queue) = pollster::block_on(adapter.request_device(&wgpu::DeviceDescriptor {
        label: Some("aura-term-gpu-scrollback"),
        ..Default::default()
    }))
    .expect("request device");

    let format = wgpu::TextureFormat::Rgba8Unorm;
    let mut renderer = Renderer::new(&device, &queue, format, FONT_PX);
    let (cell_w, cell_h) = renderer.cell_metrics();

    // `copy_texture_to_buffer` wants rows aligned to 256 bytes, which at 4
    // bytes a pixel means a width that is a multiple of 64. Rounding up keeps
    // the readback unpadded, so the buffer is already a valid image.
    let width = (((cell_w * COLS as f32).ceil() as u32).div_ceil(64)) * 64;
    let height = (cell_h * ROWS as f32).ceil() as u32;
    let bytes_per_row = width * 4;

    let target = device.create_texture(&wgpu::TextureDescriptor {
        label: Some("scrollback-target"),
        size: wgpu::Extent3d { width, height, depth_or_array_layers: 1 },
        mip_level_count: 1,
        sample_count: 1,
        dimension: wgpu::TextureDimension::D2,
        format,
        usage: wgpu::TextureUsages::RENDER_ATTACHMENT | wgpu::TextureUsages::COPY_SRC,
        view_formats: &[],
    });
    let target_view = target.create_view(&wgpu::TextureViewDescriptor::default());

    // One frame, drawn and read back exactly the way the render thread draws
    // it: render list from the live grid, clear to the palette background.
    let frame = |renderer: &mut Renderer, grid: &GridTerminal| -> Vec<u8> {
        let (cw, ch) = renderer.cell_metrics();
        let list = grid.render_list(CellMetrics { cell_w: cw, cell_h: ch });
        renderer.render(
            &device,
            &queue,
            &target_view,
            (width as f32, height as f32),
            &list,
            grid.palette().background,
        );

        let readback = device.create_buffer(&wgpu::BufferDescriptor {
            label: Some("scrollback-readback"),
            size: (bytes_per_row * height) as u64,
            usage: wgpu::BufferUsages::MAP_READ | wgpu::BufferUsages::COPY_DST,
            mapped_at_creation: false,
        });
        let mut encoder =
            device.create_command_encoder(&wgpu::CommandEncoderDescriptor { label: None });
        encoder.copy_texture_to_buffer(
            wgpu::TexelCopyTextureInfo {
                texture: &target,
                mip_level: 0,
                origin: wgpu::Origin3d::ZERO,
                aspect: wgpu::TextureAspect::All,
            },
            wgpu::TexelCopyBufferInfo {
                buffer: &readback,
                layout: wgpu::TexelCopyBufferLayout {
                    offset: 0,
                    bytes_per_row: Some(bytes_per_row),
                    rows_per_image: Some(height),
                },
            },
            wgpu::Extent3d { width, height, depth_or_array_layers: 1 },
        );
        queue.submit(std::iter::once(encoder.finish()));
        let slice = readback.slice(..);
        slice.map_async(wgpu::MapMode::Read, |_| {});
        device
            .poll(wgpu::PollType::Wait { submission_index: None, timeout: None })
            .expect("poll");
        slice.get_mapped_range().to_vec()
    };

    // A shell printing two hundred numbered lines: far more than the twenty
    // rows on screen, so the rest is only reachable through the scrollback.
    // Each line carries a bar whose length comes from its number, so a frame
    // from one part of the history cannot be mistaken for a frame from
    // another — by a pixel comparison or by eye.
    let mut grid = GridTerminal::with_size(COLS, ROWS);
    grid.apply_output(&numbered_lines());

    let live_text = grid.visible_text();
    assert!(
        live_text.contains("line-199"),
        "the newest line should be on screen before scrolling, got:\n{live_text}"
    );
    assert!(
        !live_text.contains("line-121"),
        "line-121 is history and must not be on screen yet, got:\n{live_text}"
    );
    let live_pixels = frame(&mut renderer, &grid);

    // The wheel, through the same decision the render thread makes.
    let action = grid.apply_wheel(SCROLL_LINES, (0, 0));
    assert_eq!(
        action,
        WheelAction::Scroll(SCROLL_LINES),
        "a shell at a prompt is not on the alternate screen, so the wheel moves the viewport"
    );
    assert_eq!(grid.display_offset(), SCROLL_LINES as usize);

    let scrolled_text = grid.visible_text();
    assert!(
        scrolled_text.contains("line-121"),
        "after scrolling up {SCROLL_LINES} lines, line-121 should be the top row, got:\n{scrolled_text}"
    );
    assert!(
        !scrolled_text.contains("line-199"),
        "the live bottom should have scrolled off, got:\n{scrolled_text}"
    );
    let scrolled_pixels = frame(&mut renderer, &grid);

    // The rows were not only chosen differently, they were drawn differently.
    let differing = live_pixels
        .chunks_exact(4)
        .zip(scrolled_pixels.chunks_exact(4))
        .filter(|(a, b)| a != b)
        .count();
    let total = (width * height) as usize;
    assert!(
        differing * 100 > total,
        "expected the two frames to differ over more than 1% of pixels, only {differing} of {total} differ"
    );

    // Leave the evidence somewhere a person can look at it.
    let dir = shots_dir();
    std::fs::create_dir_all(&dir).expect("create shots dir");
    let live_path = dir.join("native-term-scroll-live.png");
    let scrolled_path = dir.join("native-term-scroll-up.png");
    write_png(&live_path, &live_pixels, width, height);
    write_png(&scrolled_path, &scrolled_pixels, width, height);
    eprintln!("live frame (newest output):   {}", live_path.display());
    eprintln!("scrolled frame (60 lines up): {}", scrolled_path.display());
}

/// The same wheel inside a full-screen program: nothing to scroll, so the
/// wheel has to reach the program, and the frame must not change.
#[test]
fn scrolling_inside_a_full_screen_program_sends_keys_instead() {
    let mut grid = GridTerminal::with_size(COLS, ROWS);
    grid.apply_output(&numbered_lines());
    // DECSET 1049, which is how a pager or an editor opens.
    grid.apply_output(b"\x1b[?1049h");

    let before = grid.visible_text();
    let action = grid.apply_wheel(SCROLL_LINES, (0, 0));
    assert!(
        matches!(action, WheelAction::Send(_)),
        "a full-screen program should be sent input, got {action:?}"
    );
    assert_eq!(grid.display_offset(), 0, "the alternate screen has no history to move");
    assert_eq!(before, grid.visible_text(), "the terminal must not redraw itself here");
}
