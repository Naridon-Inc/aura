//! The wgpu side of the renderer. Owns two instanced pipelines — solid quads
//! (backgrounds + cursor) and textured quads (glyphs sampled from the coverage
//! atlas) — and draws one [`RenderList`] per frame onto a caller-supplied
//! `TextureView`.
//!
//! The host owns the surface: it creates the `Device`/`Queue` (usually from a
//! native child layer composited over the webview) and passes the swapchain
//! view in each frame. This type never touches windowing — which is why the
//! quad math in [`crate::geometry`] and the glyph raster in [`crate::atlas`]
//! are unit-tested with no GPU, and only the pipeline wiring here needs a real
//! device to exercise.

use aura_term_core::{RenderList, Rgba};
use bytemuck::{Pod, Zeroable};
use wgpu::util::DeviceExt;

use crate::atlas::Atlas;
use crate::geometry::build_instances;

/// Screen size handed to the vertex shader to map pixel space → NDC.
#[repr(C)]
#[derive(Clone, Copy, Pod, Zeroable)]
struct Uniforms {
    screen: [f32; 2],
    _pad: [f32; 2],
}

/// A unit quad (two triangles) expanded per-instance by the vertex shader.
const UNIT_QUAD: [[f32; 2]; 6] = [
    [0.0, 0.0],
    [1.0, 0.0],
    [0.0, 1.0],
    [0.0, 1.0],
    [1.0, 0.0],
    [1.0, 1.0],
];

const SOLID_WGSL: &str = r#"
struct Uniforms { screen: vec2<f32>, pad: vec2<f32> };
@group(0) @binding(0) var<uniform> u: Uniforms;

struct VsOut {
    @builtin(position) pos: vec4<f32>,
    @location(0) color: vec4<f32>,
};

@vertex
fn vs(@location(0) unit: vec2<f32>,
      @location(1) rect: vec4<f32>,
      @location(2) color: vec4<f32>) -> VsOut {
    let px = rect.xy + unit * rect.zw;
    let ndc = vec2<f32>(px.x / u.screen.x * 2.0 - 1.0, 1.0 - px.y / u.screen.y * 2.0);
    var out: VsOut;
    out.pos = vec4<f32>(ndc, 0.0, 1.0);
    out.color = color;
    return out;
}

@fragment
fn fs(in: VsOut) -> @location(0) vec4<f32> {
    return in.color;
}
"#;

const GLYPH_WGSL: &str = r#"
struct Uniforms { screen: vec2<f32>, pad: vec2<f32> };
@group(0) @binding(0) var<uniform> u: Uniforms;
@group(0) @binding(1) var atlas_tex: texture_2d<f32>;
@group(0) @binding(2) var atlas_samp: sampler;

struct VsOut {
    @builtin(position) pos: vec4<f32>,
    @location(0) uv: vec2<f32>,
    @location(1) color: vec4<f32>,
};

@vertex
fn vs(@location(0) unit: vec2<f32>,
      @location(1) rect: vec4<f32>,
      @location(2) uv: vec4<f32>,
      @location(3) color: vec4<f32>) -> VsOut {
    let px = rect.xy + unit * rect.zw;
    let ndc = vec2<f32>(px.x / u.screen.x * 2.0 - 1.0, 1.0 - px.y / u.screen.y * 2.0);
    var out: VsOut;
    out.pos = vec4<f32>(ndc, 0.0, 1.0);
    out.uv = uv.xy + unit * uv.zw;
    out.color = color;
    return out;
}

@fragment
fn fs(in: VsOut) -> @location(0) vec4<f32> {
    let cov = textureSample(atlas_tex, atlas_samp, in.uv).r;
    return vec4<f32>(in.color.rgb, in.color.a * cov);
}
"#;

/// Draws terminal frames with wgpu. Construct once per surface; call
/// [`Renderer::render`] each frame.
pub struct Renderer {
    atlas: Atlas,

    uniform_buf: wgpu::Buffer,
    unit_quad: wgpu::Buffer,

    solid_pipeline: wgpu::RenderPipeline,
    solid_bind: wgpu::BindGroup,

    glyph_pipeline: wgpu::RenderPipeline,
    glyph_bind_layout: wgpu::BindGroupLayout,
    glyph_bind: wgpu::BindGroup,

    sampler: wgpu::Sampler,
    atlas_tex: wgpu::Texture,
    atlas_dims: (u32, u32),
}

impl Renderer {
    /// Build the pipelines and upload the initial (empty) glyph atlas.
    /// `font_size` is in physical pixels (multiply logical size by the device
    /// scale factor before calling). `format` is the surface's texture format.
    pub fn new(
        device: &wgpu::Device,
        queue: &wgpu::Queue,
        format: wgpu::TextureFormat,
        font_size: f32,
    ) -> Self {
        let atlas = Atlas::new(font_size, 1024);
        let (aw, ah) = atlas.dims();

        let uniform_buf = device.create_buffer(&wgpu::BufferDescriptor {
            label: Some("aura-term-uniforms"),
            size: std::mem::size_of::<Uniforms>() as u64,
            usage: wgpu::BufferUsages::UNIFORM | wgpu::BufferUsages::COPY_DST,
            mapped_at_creation: false,
        });

        let unit_quad = device.create_buffer_init(&wgpu::util::BufferInitDescriptor {
            label: Some("aura-term-unit-quad"),
            contents: bytemuck::cast_slice(&UNIT_QUAD),
            usage: wgpu::BufferUsages::VERTEX,
        });

        let sampler = device.create_sampler(&wgpu::SamplerDescriptor {
            label: Some("aura-term-atlas-sampler"),
            address_mode_u: wgpu::AddressMode::ClampToEdge,
            address_mode_v: wgpu::AddressMode::ClampToEdge,
            address_mode_w: wgpu::AddressMode::ClampToEdge,
            mag_filter: wgpu::FilterMode::Linear,
            min_filter: wgpu::FilterMode::Linear,
            mipmap_filter: wgpu::FilterMode::Nearest,
            ..Default::default()
        });

        let atlas_tex = create_atlas_texture(device, aw, ah);
        upload_atlas(queue, &atlas_tex, atlas.data(), aw, ah);

        // --- Solid pipeline (backgrounds + cursor) ---
        let solid_bind_layout =
            device.create_bind_group_layout(&wgpu::BindGroupLayoutDescriptor {
                label: Some("aura-term-solid-bgl"),
                entries: &[uniform_entry(0)],
            });
        let solid_bind = device.create_bind_group(&wgpu::BindGroupDescriptor {
            label: Some("aura-term-solid-bg"),
            layout: &solid_bind_layout,
            entries: &[wgpu::BindGroupEntry {
                binding: 0,
                resource: uniform_buf.as_entire_binding(),
            }],
        });
        let solid_shader = device.create_shader_module(wgpu::ShaderModuleDescriptor {
            label: Some("aura-term-solid-shader"),
            source: wgpu::ShaderSource::Wgsl(SOLID_WGSL.into()),
        });
        let solid_layout = device.create_pipeline_layout(&wgpu::PipelineLayoutDescriptor {
            label: Some("aura-term-solid-pl"),
            bind_group_layouts: &[&solid_bind_layout],
            push_constant_ranges: &[],
        });
        let unit_attrs = wgpu::vertex_attr_array![0 => Float32x2];
        let solid_inst_attrs = wgpu::vertex_attr_array![1 => Float32x4, 2 => Float32x4];
        let solid_pipeline = device.create_render_pipeline(&wgpu::RenderPipelineDescriptor {
            label: Some("aura-term-solid-pipe"),
            layout: Some(&solid_layout),
            vertex: wgpu::VertexState {
                module: &solid_shader,
                entry_point: Some("vs"),
                compilation_options: Default::default(),
                buffers: &[
                    quad_layout(&unit_attrs),
                    wgpu::VertexBufferLayout {
                        array_stride: std::mem::size_of::<[f32; 8]>() as u64,
                        step_mode: wgpu::VertexStepMode::Instance,
                        attributes: &solid_inst_attrs,
                    },
                ],
            },
            primitive: wgpu::PrimitiveState::default(),
            depth_stencil: None,
            multisample: wgpu::MultisampleState::default(),
            fragment: Some(wgpu::FragmentState {
                module: &solid_shader,
                entry_point: Some("fs"),
                compilation_options: Default::default(),
                targets: &[Some(blend_target(format))],
            }),
            multiview: None,
            cache: None,
        });

        // --- Glyph pipeline (textured coverage quads) ---
        let glyph_bind_layout =
            device.create_bind_group_layout(&wgpu::BindGroupLayoutDescriptor {
                label: Some("aura-term-glyph-bgl"),
                entries: &[
                    uniform_entry(0),
                    wgpu::BindGroupLayoutEntry {
                        binding: 1,
                        visibility: wgpu::ShaderStages::FRAGMENT,
                        ty: wgpu::BindingType::Texture {
                            sample_type: wgpu::TextureSampleType::Float { filterable: true },
                            view_dimension: wgpu::TextureViewDimension::D2,
                            multisampled: false,
                        },
                        count: None,
                    },
                    wgpu::BindGroupLayoutEntry {
                        binding: 2,
                        visibility: wgpu::ShaderStages::FRAGMENT,
                        ty: wgpu::BindingType::Sampler(wgpu::SamplerBindingType::Filtering),
                        count: None,
                    },
                ],
            });
        let glyph_bind = make_glyph_bind(
            device,
            &glyph_bind_layout,
            &uniform_buf,
            &atlas_tex,
            &sampler,
        );
        let glyph_shader = device.create_shader_module(wgpu::ShaderModuleDescriptor {
            label: Some("aura-term-glyph-shader"),
            source: wgpu::ShaderSource::Wgsl(GLYPH_WGSL.into()),
        });
        let glyph_layout = device.create_pipeline_layout(&wgpu::PipelineLayoutDescriptor {
            label: Some("aura-term-glyph-pl"),
            bind_group_layouts: &[&glyph_bind_layout],
            push_constant_ranges: &[],
        });
        let glyph_inst_attrs =
            wgpu::vertex_attr_array![1 => Float32x4, 2 => Float32x4, 3 => Float32x4];
        let glyph_pipeline = device.create_render_pipeline(&wgpu::RenderPipelineDescriptor {
            label: Some("aura-term-glyph-pipe"),
            layout: Some(&glyph_layout),
            vertex: wgpu::VertexState {
                module: &glyph_shader,
                entry_point: Some("vs"),
                compilation_options: Default::default(),
                buffers: &[
                    quad_layout(&unit_attrs),
                    wgpu::VertexBufferLayout {
                        array_stride: std::mem::size_of::<[f32; 12]>() as u64,
                        step_mode: wgpu::VertexStepMode::Instance,
                        attributes: &glyph_inst_attrs,
                    },
                ],
            },
            primitive: wgpu::PrimitiveState::default(),
            depth_stencil: None,
            multisample: wgpu::MultisampleState::default(),
            fragment: Some(wgpu::FragmentState {
                module: &glyph_shader,
                entry_point: Some("fs"),
                compilation_options: Default::default(),
                targets: &[Some(blend_target(format))],
            }),
            multiview: None,
            cache: None,
        });

        Self {
            atlas,
            uniform_buf,
            unit_quad,
            solid_pipeline,
            solid_bind,
            glyph_pipeline,
            glyph_bind_layout,
            glyph_bind,
            sampler,
            atlas_tex,
            atlas_dims: (aw, ah),
        }
    }

    /// Cell size in physical pixels — the host uses this to compute the grid
    /// dimensions (cols/rows) for a given surface size.
    pub fn cell_metrics(&self) -> (f32, f32) {
        self.atlas.cell_metrics()
    }

    /// Draw one frame. `screen` is the target size in physical pixels; `clear`
    /// is the background fill (usually the palette background).
    pub fn render(
        &mut self,
        device: &wgpu::Device,
        queue: &wgpu::Queue,
        target: &wgpu::TextureView,
        screen: (f32, f32),
        list: &RenderList,
        clear: Rgba,
    ) {
        let (solids, glyphs) = build_instances(list, &mut self.atlas);
        self.sync_atlas(device, queue);

        queue.write_buffer(
            &self.uniform_buf,
            0,
            bytemuck::bytes_of(&Uniforms {
                screen: [screen.0, screen.1],
                _pad: [0.0, 0.0],
            }),
        );

        let solid_buf = device.create_buffer_init(&wgpu::util::BufferInitDescriptor {
            label: Some("aura-term-solid-inst"),
            contents: bytemuck::cast_slice(&solids),
            usage: wgpu::BufferUsages::VERTEX,
        });
        let glyph_buf = device.create_buffer_init(&wgpu::util::BufferInitDescriptor {
            label: Some("aura-term-glyph-inst"),
            contents: bytemuck::cast_slice(&glyphs),
            usage: wgpu::BufferUsages::VERTEX,
        });

        let mut encoder =
            device.create_command_encoder(&wgpu::CommandEncoderDescriptor {
                label: Some("aura-term-encoder"),
            });
        {
            let mut pass = encoder.begin_render_pass(&wgpu::RenderPassDescriptor {
                label: Some("aura-term-pass"),
                color_attachments: &[Some(wgpu::RenderPassColorAttachment {
                    view: target,
                    resolve_target: None,
                    depth_slice: None,
                    ops: wgpu::Operations {
                        load: wgpu::LoadOp::Clear(wgpu::Color {
                            r: clear.r as f64,
                            g: clear.g as f64,
                            b: clear.b as f64,
                            a: clear.a as f64,
                        }),
                        store: wgpu::StoreOp::Store,
                    },
                })],
                depth_stencil_attachment: None,
                timestamp_writes: None,
                occlusion_query_set: None,
            });

            if !solids.is_empty() {
                pass.set_pipeline(&self.solid_pipeline);
                pass.set_bind_group(0, &self.solid_bind, &[]);
                pass.set_vertex_buffer(0, self.unit_quad.slice(..));
                pass.set_vertex_buffer(1, solid_buf.slice(..));
                pass.draw(0..6, 0..solids.len() as u32);
            }
            if !glyphs.is_empty() {
                pass.set_pipeline(&self.glyph_pipeline);
                pass.set_bind_group(0, &self.glyph_bind, &[]);
                pass.set_vertex_buffer(0, self.unit_quad.slice(..));
                pass.set_vertex_buffer(1, glyph_buf.slice(..));
                pass.draw(0..6, 0..glyphs.len() as u32);
            }
        }
        queue.submit(std::iter::once(encoder.finish()));
    }

    /// Re-upload the atlas texture when new glyphs were rasterized. If the
    /// atlas grew, recreate the texture + glyph bind group at the new size.
    fn sync_atlas(&mut self, device: &wgpu::Device, queue: &wgpu::Queue) {
        let (aw, ah) = self.atlas.dims();
        if (aw, ah) != self.atlas_dims {
            self.atlas_tex = create_atlas_texture(device, aw, ah);
            self.atlas_dims = (aw, ah);
            self.glyph_bind = make_glyph_bind(
                device,
                &self.glyph_bind_layout,
                &self.uniform_buf,
                &self.atlas_tex,
                &self.sampler,
            );
            upload_atlas(queue, &self.atlas_tex, self.atlas.data(), aw, ah);
            self.atlas.clear_dirty();
        } else if self.atlas.is_dirty() {
            upload_atlas(queue, &self.atlas_tex, self.atlas.data(), aw, ah);
            self.atlas.clear_dirty();
        }
    }
}

fn uniform_entry(binding: u32) -> wgpu::BindGroupLayoutEntry {
    wgpu::BindGroupLayoutEntry {
        binding,
        visibility: wgpu::ShaderStages::VERTEX,
        ty: wgpu::BindingType::Buffer {
            ty: wgpu::BufferBindingType::Uniform,
            has_dynamic_offset: false,
            min_binding_size: None,
        },
        count: None,
    }
}

fn quad_layout(attrs: &[wgpu::VertexAttribute]) -> wgpu::VertexBufferLayout<'_> {
    wgpu::VertexBufferLayout {
        array_stride: std::mem::size_of::<[f32; 2]>() as u64,
        step_mode: wgpu::VertexStepMode::Vertex,
        attributes: attrs,
    }
}

fn blend_target(format: wgpu::TextureFormat) -> wgpu::ColorTargetState {
    wgpu::ColorTargetState {
        format,
        blend: Some(wgpu::BlendState::ALPHA_BLENDING),
        write_mask: wgpu::ColorWrites::ALL,
    }
}

fn create_atlas_texture(device: &wgpu::Device, w: u32, h: u32) -> wgpu::Texture {
    device.create_texture(&wgpu::TextureDescriptor {
        label: Some("aura-term-atlas"),
        size: wgpu::Extent3d {
            width: w,
            height: h,
            depth_or_array_layers: 1,
        },
        mip_level_count: 1,
        sample_count: 1,
        dimension: wgpu::TextureDimension::D2,
        format: wgpu::TextureFormat::R8Unorm,
        usage: wgpu::TextureUsages::TEXTURE_BINDING | wgpu::TextureUsages::COPY_DST,
        view_formats: &[],
    })
}

fn upload_atlas(queue: &wgpu::Queue, tex: &wgpu::Texture, data: &[u8], w: u32, h: u32) {
    queue.write_texture(
        wgpu::TexelCopyTextureInfo {
            texture: tex,
            mip_level: 0,
            origin: wgpu::Origin3d::ZERO,
            aspect: wgpu::TextureAspect::All,
        },
        data,
        wgpu::TexelCopyBufferLayout {
            offset: 0,
            bytes_per_row: Some(w),
            rows_per_image: Some(h),
        },
        wgpu::Extent3d {
            width: w,
            height: h,
            depth_or_array_layers: 1,
        },
    );
}

fn make_glyph_bind(
    device: &wgpu::Device,
    layout: &wgpu::BindGroupLayout,
    uniform: &wgpu::Buffer,
    atlas_tex: &wgpu::Texture,
    sampler: &wgpu::Sampler,
) -> wgpu::BindGroup {
    let view = atlas_tex.create_view(&wgpu::TextureViewDescriptor::default());
    device.create_bind_group(&wgpu::BindGroupDescriptor {
        label: Some("aura-term-glyph-bg"),
        layout,
        entries: &[
            wgpu::BindGroupEntry {
                binding: 0,
                resource: uniform.as_entire_binding(),
            },
            wgpu::BindGroupEntry {
                binding: 1,
                resource: wgpu::BindingResource::TextureView(&view),
            },
            wgpu::BindGroupEntry {
                binding: 2,
                resource: wgpu::BindingResource::Sampler(sampler),
            },
        ],
    })
}
