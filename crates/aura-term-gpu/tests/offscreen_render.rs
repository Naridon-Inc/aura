//! End-to-end GPU verification: build a real wgpu device, render a
//! `RenderList` into an offscreen texture, read the pixels back, and assert the
//! solid + glyph pipelines actually drew. These are the tests that need a GPU,
//! so they degrade to a graceful skip when no adapter is available (CI without
//! Metal/Vulkan) instead of failing.
//!
//! On a machine with a GPU this proves far more than the headless unit tests:
//! that the WGSL compiles on the driver, the pixel→NDC mapping is right, alpha
//! blending composites glyphs over backgrounds, and the atlas texture samples
//! correctly — and, in the clipped case below, that a frame drawn into a
//! smaller target really does show the band of the grid it is supposed to.

use aura_term_core::{BgRect, GlyphQuad, RenderList, Rgba, translate};
use aura_term_gpu::Renderer;

/// A square target is enough for the pipelines; the clip test uses the same
/// size as its (smaller) view and a taller grid behind it.
const W: u32 = 64;
const H: u32 = 64;
const BYTES_PER_ROW: u32 = W * 4; // rgba8 == 256, already 256-aligned

fn pixel(data: &[u8], x: u32, y: u32) -> [u8; 4] {
    let o = (y * BYTES_PER_ROW + x * 4) as usize;
    [data[o], data[o + 1], data[o + 2], data[o + 3]]
}

/// A real device, or `None` on a machine with no usable adapter.
fn gpu() -> Option<(wgpu::Device, wgpu::Queue)> {
    let instance = wgpu::Instance::default();
    let adapter = match pollster::block_on(instance.request_adapter(&wgpu::RequestAdapterOptions {
        power_preference: wgpu::PowerPreference::default(),
        force_fallback_adapter: false,
        compatible_surface: None,
    })) {
        Ok(a) => a,
        Err(_) => {
            eprintln!("no GPU adapter available — skipping offscreen render test");
            return None;
        }
    };
    let (device, queue) = pollster::block_on(adapter.request_device(&wgpu::DeviceDescriptor {
        label: Some("aura-term-gpu-test"),
        ..Default::default()
    }))
    .expect("request device");
    Some((device, queue))
}

fn make_target(device: &wgpu::Device, format: wgpu::TextureFormat) -> wgpu::Texture {
    device.create_texture(&wgpu::TextureDescriptor {
        label: Some("offscreen-target"),
        size: wgpu::Extent3d { width: W, height: H, depth_or_array_layers: 1 },
        mip_level_count: 1,
        sample_count: 1,
        dimension: wgpu::TextureDimension::D2,
        format,
        usage: wgpu::TextureUsages::RENDER_ATTACHMENT | wgpu::TextureUsages::COPY_SRC,
        view_formats: &[],
    })
}

/// Copy the rendered texture into a mappable buffer and read it back.
fn read_back(device: &wgpu::Device, queue: &wgpu::Queue, target: &wgpu::Texture) -> Vec<u8> {
    let readback = device.create_buffer(&wgpu::BufferDescriptor {
        label: Some("offscreen-readback"),
        size: (BYTES_PER_ROW * H) as u64,
        usage: wgpu::BufferUsages::MAP_READ | wgpu::BufferUsages::COPY_DST,
        mapped_at_creation: false,
    });
    let mut encoder =
        device.create_command_encoder(&wgpu::CommandEncoderDescriptor { label: None });
    encoder.copy_texture_to_buffer(
        wgpu::TexelCopyTextureInfo {
            texture: target,
            mip_level: 0,
            origin: wgpu::Origin3d::ZERO,
            aspect: wgpu::TextureAspect::All,
        },
        wgpu::TexelCopyBufferInfo {
            buffer: &readback,
            layout: wgpu::TexelCopyBufferLayout {
                offset: 0,
                bytes_per_row: Some(BYTES_PER_ROW),
                rows_per_image: Some(H),
            },
        },
        wgpu::Extent3d { width: W, height: H, depth_or_array_layers: 1 },
    );
    queue.submit(std::iter::once(encoder.finish()));

    let slice = readback.slice(..);
    slice.map_async(wgpu::MapMode::Read, |_| {});
    device
        .poll(wgpu::PollType::Wait { submission_index: None, timeout: None })
        .expect("poll");
    slice.get_mapped_range().to_vec()
}

#[test]
fn offscreen_draws_background_and_glyph() {
    let Some((device, queue)) = gpu() else { return };

    let format = wgpu::TextureFormat::Rgba8Unorm;
    let mut renderer = Renderer::new(&device, &queue, format, 24.0);
    let target = make_target(&device, format);
    let view = target.create_view(&wgpu::TextureViewDescriptor::default());

    // Full-screen red background + a white 'A' glyph in the top-left.
    let list = RenderList {
        bg_rects: vec![BgRect {
            x: 0.0,
            y: 0.0,
            w: W as f32,
            h: H as f32,
            color: Rgba::new(1.0, 0.0, 0.0, 1.0),
        }],
        glyphs: vec![GlyphQuad {
            x: 0.0,
            y: 0.0,
            ch: 'A',
            color: Rgba::new(1.0, 1.0, 1.0, 1.0),
            bold: false,
        }],
        cursor: None,
    };

    renderer.render(
        &device,
        &queue,
        &view,
        (W as f32, H as f32),
        &list,
        Rgba::new(0.0, 0.0, 0.0, 1.0), // black clear
    );

    let data = read_back(&device, &queue, &target);

    // 1) The background rect drew: the center pixel is red.
    let c = pixel(&data, W / 2, H / 2);
    assert!(
        c[0] > 200 && c[1] < 60 && c[2] < 60,
        "center should be red from the bg rect, got {c:?}"
    );

    // 2) The glyph drew: somewhere in the top-left the white 'A' composited
    //    over the red, so green/blue coverage is non-zero (pure bg has g=b=0).
    let glyph_drew = (0..H / 2).any(|y| {
        (0..W / 2).any(|x| {
            let p = pixel(&data, x, y);
            p[1] > 40 && p[2] > 40
        })
    });
    assert!(glyph_drew, "expected the white 'A' glyph to composite over the red bg");
}

#[test]
fn a_clipped_view_draws_the_band_of_the_grid_it_covers() {
    // This is the clipped native surface, reduced to pixels. The grid is twice
    // as tall as the view: a 64x128 hole, red on top and blue underneath. An
    // overlay is covering the top half, so the view has been given the bottom
    // half — a 64x64 clip at y=64 — and the frame is shifted up by 64 to suit.
    //
    // What must come back is a wholly BLUE image. Blue means the translate put
    // the right rows under the view; any red would mean the surface is showing
    // the part of the terminal the overlay is on, which is the bug this whole
    // mechanism exists to avoid. It also proves the render pass discards the
    // geometry that moved above the top edge rather than wrapping or clamping
    // it, which is the assumption `translate` is written on.
    let Some((device, queue)) = gpu() else { return };

    let format = wgpu::TextureFormat::Rgba8Unorm;
    let mut renderer = Renderer::new(&device, &queue, format, 24.0);
    let target = make_target(&device, format);
    let view = target.create_view(&wgpu::TextureViewDescriptor::default());

    let hole_h = H * 2;
    let red = Rgba::new(1.0, 0.0, 0.0, 1.0);
    let blue = Rgba::new(0.0, 0.0, 1.0, 1.0);
    let mut list = RenderList {
        bg_rects: vec![
            BgRect { x: 0.0, y: 0.0, w: W as f32, h: H as f32, color: red },
            BgRect { x: 0.0, y: H as f32, w: W as f32, h: H as f32, color: blue },
        ],
        // A glyph on the first row of the lower (blue) half. After the shift it
        // belongs at the very top of the view.
        glyphs: vec![GlyphQuad {
            x: 0.0,
            y: H as f32,
            ch: 'A',
            color: Rgba::new(1.0, 1.0, 1.0, 1.0),
            bold: false,
        }],
        cursor: None,
    };
    assert_eq!(hole_h, 128, "the grid is twice the view's height");

    // The clip is at y=64 in the hole, so the frame moves up by 64.
    translate(&mut list, 0.0, -(H as f32));

    renderer.render(
        &device,
        &queue,
        &view,
        (W as f32, H as f32), // the CLIP's size, not the hole's
        &list,
        Rgba::new(0.0, 0.0, 0.0, 1.0),
    );

    let data = read_back(&device, &queue, &target);

    // Every corner and the centre are blue, not red: the view is over the
    // lower half of the grid and shows only that.
    for (x, y) in [(1, 1), (W - 2, 1), (1, H - 2), (W - 2, H - 2), (W / 2, H / 2)] {
        let p = pixel(&data, x, y);
        assert!(
            p[2] > 200 && p[0] < 60,
            "({x},{y}) should be blue from the lower half, got {p:?}"
        );
    }
    // And nowhere in the image is the red half visible at all. Red-DOMINANT,
    // not merely red-channel-bright: the white glyph below has r=255 too, and
    // an earlier version of this assertion caught the glyph instead of the bug
    // it was looking for.
    let any_red = (0..H).any(|y| {
        (0..W).any(|x| {
            let p = pixel(&data, x, y);
            p[0] > 150 && p[1] < 80 && p[2] < 80
        })
    });
    assert!(!any_red, "the overlaid half of the grid must not reach the clip");

    // The glyph that was on the grid's row 64 landed in the view's top rows,
    // which is what says the shift moved glyphs and backgrounds together.
    let glyph_at_top = (0..H / 3).any(|y| {
        (0..W / 2).any(|x| {
            let p = pixel(&data, x, y);
            // White over blue → red and green channels light up.
            p[0] > 40 && p[1] > 40
        })
    });
    assert!(glyph_at_top, "expected the shifted glyph at the top of the clip");
}
