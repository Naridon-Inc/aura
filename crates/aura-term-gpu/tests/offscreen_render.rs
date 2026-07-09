//! End-to-end GPU verification: build a real wgpu device, render a
//! `RenderList` into an offscreen texture, read the pixels back, and assert the
//! solid + glyph pipelines actually drew. This is the one test that needs a
//! GPU, so it degrades to a graceful skip when no adapter is available (CI
//! without Metal/Vulkan) instead of failing.
//!
//! On a machine with a GPU this proves far more than the headless unit tests:
//! that the WGSL compiles on the driver, the pixel→NDC mapping is right, alpha
//! blending composites glyphs over backgrounds, and the atlas texture samples
//! correctly.

use aura_term_core::{BgRect, GlyphQuad, RenderList, Rgba};
use aura_term_gpu::Renderer;

const W: u32 = 64;
const H: u32 = 64;
const BYTES_PER_ROW: u32 = W * 4; // rgba8 == 256, already 256-aligned

fn pixel(data: &[u8], x: u32, y: u32) -> [u8; 4] {
    let o = (y * BYTES_PER_ROW + x * 4) as usize;
    [data[o], data[o + 1], data[o + 2], data[o + 3]]
}

#[test]
fn offscreen_draws_background_and_glyph() {
    let instance = wgpu::Instance::default();
    let adapter = match pollster::block_on(instance.request_adapter(&wgpu::RequestAdapterOptions {
        power_preference: wgpu::PowerPreference::default(),
        force_fallback_adapter: false,
        compatible_surface: None,
    })) {
        Ok(a) => a,
        Err(_) => {
            eprintln!("no GPU adapter available — skipping offscreen render test");
            return;
        }
    };
    let (device, queue) = pollster::block_on(
        adapter.request_device(&wgpu::DeviceDescriptor {
            label: Some("aura-term-gpu-test"),
            ..Default::default()
        }),
    )
    .expect("request device");

    let format = wgpu::TextureFormat::Rgba8Unorm;
    let mut renderer = Renderer::new(&device, &queue, format, 24.0);

    let target = device.create_texture(&wgpu::TextureDescriptor {
        label: Some("offscreen-target"),
        size: wgpu::Extent3d { width: W, height: H, depth_or_array_layers: 1 },
        mip_level_count: 1,
        sample_count: 1,
        dimension: wgpu::TextureDimension::D2,
        format,
        usage: wgpu::TextureUsages::RENDER_ATTACHMENT | wgpu::TextureUsages::COPY_SRC,
        view_formats: &[],
    });
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

    // Copy the rendered texture into a mappable buffer and read it back.
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
            texture: &target,
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
        .poll(wgpu::PollType::Wait {
            submission_index: None,
            timeout: None,
        })
        .expect("poll");
    let data = slice.get_mapped_range().to_vec();

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
