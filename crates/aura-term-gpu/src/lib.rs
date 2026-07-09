//! `aura-term-gpu` — a wgpu renderer for [`aura_term_core`].
//!
//! Given a [`aura_term_core::RenderList`] (background quads + glyph quads +
//! cursor) it draws one frame onto any wgpu target the host provides. It is
//! deliberately windowing-agnostic: the host (the Tauri shell) owns the
//! `wgpu::Surface`/`Device`/`Queue` — usually created from a native child view
//! composited over the webview — and hands this renderer a `TextureView` per
//! frame. That keeps the platform-specific surface plumbing out of here and
//! lets the glyph/geometry logic be unit-tested with no GPU.

pub mod atlas;
pub mod geometry;
pub mod renderer;

pub use atlas::{Atlas, GlyphInfo};
pub use geometry::{build_instances, GlyphInstance, SolidInstance};
pub use renderer::Renderer;
