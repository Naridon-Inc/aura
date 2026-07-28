//! Native GPU terminal — the wgpu-rendered replacement for the xterm.js
//! terminal, wired into the ADE shell behind a flag.
//!
//! Each terminal is fully self-contained: it spawns its own shell through
//! `aura_term_core` (PTY + `alacritty_terminal` grid model), renders the grid
//! with `aura_term_gpu` (wgpu), and paints into a native child surface
//! ([`surface`]) positioned over a transparent DOM hole — exactly the hole +
//! `set_bounds` choreography the in-app browser already uses.
//!
//! Threading:
//! * Surface attach / reposition / teardown run on the UI thread (AppKit/GTK
//!   requirement) via `run_on_main_thread`.
//! * Each terminal owns a dedicated render thread that reads PTY output, drives
//!   the grid, and presents frames. The `wgpu::Surface` is `Send`, so it lives
//!   entirely on that thread after attach; the UI thread only ever touches the
//!   opaque view handle.
//!
//! The engine (PTY, grid, renderer) is 100% platform-neutral; only [`surface`]
//! is per-OS. So the same render loop drives Metal on macOS and Vulkan on
//! Linux without change.

pub mod surface;

use std::collections::HashMap;
use std::sync::mpsc::{Receiver, RecvTimeoutError, Sender};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use aura_term_core::{
    spawn as pty_spawn, CellMetrics, GridTerminal, Palette, PtyConfig, PtyEvent, Selection,
};
use serde::Serialize;
use tauri::{AppHandle, Emitter, Manager, State};

use surface::RectPx;

const MAIN_WINDOW: &str = "main";
/// Logical font size in CSS px; multiplied by the device scale for raster.
const FONT_PX: f32 = 13.0;
/// Frame budget — the render thread wakes at least this often to service input
/// and repaints only when the grid is dirty.
const FRAME_MS: u64 = 16;

/// Control messages sent from Tauri commands to a terminal's render thread.
enum Ctrl {
    /// New surface size in physical pixels (from a bounds reconcile).
    Resize { px_w: u32, px_h: u32 },
    /// Keystrokes / paste bytes to write to the shell.
    Write(Vec<u8>),
    /// Scroll the viewport by N lines (negative = up into scrollback).
    Scroll(i32),
    /// Focus gained/lost (drives cursor block vs hollow).
    Focus(bool),
    /// Begin a mouse selection at a normalized (0..1) position over the hole.
    /// Fractions are scale-independent; the render thread maps them to cells.
    SelectStart { fx: f32, fy: f32 },
    /// Extend the in-flight selection head to a new normalized position.
    SelectUpdate { fx: f32, fy: f32 },
    /// Drop the current selection.
    SelectClear,
    /// Copy the selected text back over the oneshot channel (empty if none).
    Copy(Sender<String>),
    /// Return recent visible grid text for an `@terminal` chat mention.
    Context {
        max_lines: usize,
        reply: Sender<String>,
    },
    /// Tear the render thread down.
    Close,
}

/// Per-terminal handle held by the manager.
struct TermControl {
    ctrl: Sender<Ctrl>,
    /// Opaque native view pointer (UI-thread only).
    view: usize,
}

/// Shared GPU context — one adapter/device/queue for every terminal.
struct GpuContext {
    instance: wgpu::Instance,
    adapter: wgpu::Adapter,
    device: Arc<wgpu::Device>,
    queue: Arc<wgpu::Queue>,
}

/// Managed Tauri state for the native terminal subsystem.
pub struct NativeTermManager {
    gpu: Mutex<Option<Arc<GpuContext>>>,
    terms: Mutex<HashMap<String, TermControl>>,
}

impl NativeTermManager {
    pub fn new() -> Self {
        Self {
            gpu: Mutex::new(None),
            terms: Mutex::new(HashMap::new()),
        }
    }
}

impl Default for NativeTermManager {
    fn default() -> Self {
        Self::new()
    }
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
struct ClosedEvent {
    term_id: String,
}

/// Get-or-create the shared GPU context. Adapter/device requests are async;
/// this runs inside the async `native_term_open` command.
async fn ensure_gpu(manager: &NativeTermManager) -> Result<Arc<GpuContext>, String> {
    if let Some(ctx) = manager.gpu.lock().unwrap().as_ref() {
        return Ok(ctx.clone());
    }

    let instance = wgpu::Instance::new(&wgpu::InstanceDescriptor::default());
    let adapter = instance
        .request_adapter(&wgpu::RequestAdapterOptions {
            power_preference: wgpu::PowerPreference::HighPerformance,
            force_fallback_adapter: false,
            compatible_surface: None,
        })
        .await
        .map_err(|e| format!("no GPU adapter: {e}"))?;
    let (device, queue) = adapter
        .request_device(&wgpu::DeviceDescriptor {
            label: Some("aura-native-term"),
            ..Default::default()
        })
        .await
        .map_err(|e| format!("no GPU device: {e}"))?;

    let ctx = Arc::new(GpuContext {
        instance,
        adapter,
        device: Arc::new(device),
        queue: Arc::new(queue),
    });
    *manager.gpu.lock().unwrap() = Some(ctx.clone());
    Ok(ctx)
}

/// Pick a non-sRGB 8-bit format when available so the renderer's straight
/// colors present without a gamma shift (matches the offscreen-verified path).
fn choose_format(caps: &wgpu::SurfaceCapabilities) -> wgpu::TextureFormat {
    let prefer = [
        wgpu::TextureFormat::Bgra8Unorm,
        wgpu::TextureFormat::Rgba8Unorm,
    ];
    for f in prefer {
        if caps.formats.contains(&f) {
            return f;
        }
    }
    caps.formats
        .first()
        .copied()
        .unwrap_or(wgpu::TextureFormat::Bgra8Unorm)
}

/// Open (or re-target) a native terminal over the hole at `rect`. Spawns the
/// shell, attaches the GPU surface on the UI thread, and starts the render
/// thread.
#[tauri::command]
pub async fn native_term_open(
    app: AppHandle,
    manager: State<'_, NativeTermManager>,
    term_id: String,
    cwd: Option<String>,
    x: f64,
    y: f64,
    width: f64,
    height: f64,
    scale: f64,
) -> Result<(), String> {
    // Idempotent: an existing terminal just gets repositioned.
    if manager.terms.lock().unwrap().contains_key(&term_id) {
        native_term_set_bounds(app, manager, term_id, x, y, width, height, scale)?;
        return Ok(());
    }

    let ctx = ensure_gpu(&manager).await?;
    let scale = if scale <= 0.0 { 1.0 } else { scale };
    let rect = RectPx { x, y, w: width, h: height };

    let window = app
        .get_window(MAIN_WINDOW)
        .ok_or_else(|| "main window not found".to_string())?;

    // Attach the native child surface on the UI thread and ferry the (Send)
    // surface + view handle back.
    let (tx, rx) = std::sync::mpsc::channel();
    let attach_instance = ctx.instance.clone();
    let attach_window = window.clone();
    app.run_on_main_thread(move || {
        let res = surface::attach(&attach_instance, &attach_window, rect, scale);
        let _ = tx.send(res);
    })
    .map_err(|e| e.to_string())?;
    let attached = rx
        .recv()
        .map_err(|_| "surface attach did not report back".to_string())??;

    // Configure the surface + build the renderer.
    let px_w = (width * scale).round().max(1.0) as u32;
    let px_h = (height * scale).round().max(1.0) as u32;
    let caps = attached.surface.get_capabilities(&ctx.adapter);
    let format = choose_format(&caps);
    let alpha_mode = caps
        .alpha_modes
        .iter()
        .copied()
        .find(|m| *m == wgpu::CompositeAlphaMode::Opaque)
        .unwrap_or(caps.alpha_modes[0]);
    let config = wgpu::SurfaceConfiguration {
        usage: wgpu::TextureUsages::RENDER_ATTACHMENT,
        format,
        width: px_w,
        height: px_h,
        present_mode: wgpu::PresentMode::Fifo,
        desired_maximum_frame_latency: 2,
        alpha_mode,
        view_formats: vec![],
    };

    let renderer =
        aura_term_gpu::Renderer::new(&ctx.device, &ctx.queue, format, FONT_PX * scale as f32);
    let (cell_w, cell_h) = renderer.cell_metrics();
    let cols = ((px_w as f32 / cell_w).floor() as u16).max(1);
    let rows = ((px_h as f32 / cell_h).floor() as u16).max(1);

    // Spawn the shell. `cwd`/`shell` must outlive the spawn call, so bind them
    // first. We launch the user's login shell ($SHELL) in the requested cwd;
    // OSC-133 prompt marks (shell integration) are a later wave — the grid
    // renders correctly without them.
    let cwd_path: std::path::PathBuf = cwd
        .as_deref()
        .map(std::path::PathBuf::from)
        .unwrap_or_else(|| std::env::current_dir().unwrap_or_else(|_| std::path::PathBuf::from(".")));
    let shell = std::env::var("SHELL").unwrap_or_else(|_| "/bin/zsh".to_string());
    let mut pty = pty_spawn(PtyConfig {
        cwd: &cwd_path,
        shell: &shell,
        shell_args: &[],
        size: aura_term_core::WindowSize {
            num_lines: rows,
            num_cols: cols,
            cell_width: cell_w.max(1.0) as u16,
            cell_height: cell_h.max(1.0) as u16,
        },
        extra_env: Vec::new(),
    })
    .map_err(|e| format!("spawn shell: {e}"))?;

    // The core delivers PTY output on a tokio channel; bridge it to a std
    // channel the (sync) render thread can `recv_timeout` on. The forwarder
    // runs in the tauri runtime and exits when the shell closes.
    let mut tok_events = pty
        .take_events()
        .ok_or_else(|| "pty events already taken".to_string())?;
    let (evt_tx, events) = std::sync::mpsc::channel::<PtyEvent>();
    tauri::async_runtime::spawn(async move {
        while let Some(ev) = tok_events.recv().await {
            if evt_tx.send(ev).is_err() {
                break;
            }
        }
    });

    let mut grid = GridTerminal::with_palette(cols, rows, Palette::default());
    grid.set_focused(true);

    let (ctrl_tx, ctrl_rx) = std::sync::mpsc::channel::<Ctrl>();

    let thread_app = app.clone();
    let thread_id = term_id.clone();
    let device = ctx.device.clone();
    let queue = ctx.queue.clone();
    std::thread::Builder::new()
        .name(format!("aura-term-{term_id}"))
        .spawn(move || {
            render_loop(
                thread_app,
                thread_id,
                attached.surface,
                device,
                queue,
                renderer,
                grid,
                pty,
                events,
                ctrl_rx,
                config,
            );
        })
        .map_err(|e| e.to_string())?;

    manager.terms.lock().unwrap().insert(
        term_id,
        TermControl {
            ctrl: ctrl_tx,
            view: attached.view,
        },
    );
    Ok(())
}

/// The per-terminal render thread: own the surface, pump PTY output into the
/// grid, service control messages, and present a frame whenever the grid is
/// dirty.
#[allow(clippy::too_many_arguments)]
fn render_loop(
    app: AppHandle,
    term_id: String,
    surface: wgpu::Surface<'static>,
    device: Arc<wgpu::Device>,
    queue: Arc<wgpu::Queue>,
    mut renderer: aura_term_gpu::Renderer,
    mut grid: GridTerminal,
    pty: aura_term_core::PtySession,
    events: Receiver<PtyEvent>,
    ctrl: Receiver<Ctrl>,
    mut config: wgpu::SurfaceConfiguration,
) {
    surface.configure(&device, &config);
    let mut dirty = true;
    let mut closed = false;
    // Anchor cell of an in-flight mouse selection (set on SelectStart, cleared
    // on SelectClear / a keystroke). The head follows on each SelectUpdate.
    let mut sel_anchor: Option<(u16, u16)> = None;

    // Map a normalized (0..1) hole position to a viewport cell using the live
    // grid dimensions (recomputed from the surface config + font metrics, the
    // same way resize does).
    let frac_to_cell =
        |renderer: &aura_term_gpu::Renderer, cfg: &wgpu::SurfaceConfiguration, fx: f32, fy: f32| {
            let (cw, ch) = renderer.cell_metrics();
            let cols = ((cfg.width as f32 / cw).floor() as u16).max(1);
            let rows = ((cfg.height as f32 / ch).floor() as u16).max(1);
            let c = (fx.clamp(0.0, 1.0) * cols as f32).floor() as u16;
            let r = (fy.clamp(0.0, 1.0) * rows as f32).floor() as u16;
            (c.min(cols - 1), r.min(rows - 1))
        };

    loop {
        // Block briefly on PTY output so idle terminals cost ~nothing.
        match events.recv_timeout(Duration::from_millis(FRAME_MS)) {
            Ok(PtyEvent::Output(bytes)) => {
                grid.apply_output(&bytes);
                dirty = true;
            }
            Ok(PtyEvent::Marker(_)) => {}
            Ok(PtyEvent::Closed) => closed = true,
            Err(RecvTimeoutError::Timeout) => {}
            Err(RecvTimeoutError::Disconnected) => closed = true,
        }
        // Drain any backlog without blocking.
        while let Ok(ev) = events.try_recv() {
            match ev {
                PtyEvent::Output(bytes) => {
                    grid.apply_output(&bytes);
                    dirty = true;
                }
                PtyEvent::Closed => closed = true,
                PtyEvent::Marker(_) => {}
            }
        }

        // Service control messages.
        while let Ok(msg) = ctrl.try_recv() {
            match msg {
                Ctrl::Write(b) => {
                    // A fresh keystroke dismisses any selection, matching how
                    // every terminal behaves.
                    if grid.has_selection() {
                        grid.clear_selection();
                        sel_anchor = None;
                        dirty = true;
                    }
                    let _ = pty.write(&b);
                }
                Ctrl::Resize { px_w, px_h } => {
                    config.width = px_w.max(1);
                    config.height = px_h.max(1);
                    surface.configure(&device, &config);
                    let (cw, ch) = renderer.cell_metrics();
                    let cols = ((px_w as f32 / cw).floor() as u16).max(1);
                    let rows = ((px_h as f32 / ch).floor() as u16).max(1);
                    grid.resize(cols, rows);
                    let _ = pty.resize(cols, rows, px_w as u16, px_h as u16);
                    dirty = true;
                }
                Ctrl::Scroll(lines) => {
                    grid.scroll_lines(lines);
                    dirty = true;
                }
                Ctrl::Focus(f) => {
                    grid.set_focused(f);
                    dirty = true;
                }
                Ctrl::SelectStart { fx, fy } => {
                    let cell = frac_to_cell(&renderer, &config, fx, fy);
                    sel_anchor = Some(cell);
                    grid.set_selection(Some(Selection::new(cell, cell)));
                    dirty = true;
                }
                Ctrl::SelectUpdate { fx, fy } => {
                    if let Some(anchor) = sel_anchor {
                        let head = frac_to_cell(&renderer, &config, fx, fy);
                        grid.set_selection(Some(Selection::new(anchor, head)));
                        dirty = true;
                    }
                }
                Ctrl::SelectClear => {
                    if grid.has_selection() {
                        grid.clear_selection();
                        sel_anchor = None;
                        dirty = true;
                    }
                }
                Ctrl::Copy(reply) => {
                    let _ = reply.send(grid.selected_text().unwrap_or_default());
                }
                Ctrl::Context { max_lines, reply } => {
                    let text = grid.visible_text();
                    let lines: Vec<&str> = text.lines().collect();
                    let start = lines.len().saturating_sub(max_lines);
                    let _ = reply.send(lines[start..].join("\n"));
                }
                Ctrl::Close => return,
            }
        }

        if closed {
            break;
        }
        if !dirty {
            continue;
        }

        match surface.get_current_texture() {
            Ok(frame) => {
                let view = frame
                    .texture
                    .create_view(&wgpu::TextureViewDescriptor::default());
                let (cw, ch) = renderer.cell_metrics();
                let list = grid.render_list(CellMetrics { cell_w: cw, cell_h: ch });
                let bg = grid.palette().background;
                renderer.render(
                    &device,
                    &queue,
                    &view,
                    (config.width as f32, config.height as f32),
                    &list,
                    bg,
                );
                frame.present();
                dirty = false;
            }
            Err(wgpu::SurfaceError::Outdated) | Err(wgpu::SurfaceError::Lost) => {
                surface.configure(&device, &config);
            }
            Err(wgpu::SurfaceError::Timeout) => {}
            Err(e) => {
                tracing::warn!("native term {term_id} surface error: {e:?}");
            }
        }
    }

    // Shell exited on its own — tell the frontend so it can drop the hole +
    // call native_term_close for teardown.
    let _ = app.emit(
        "native-term:closed",
        ClosedEvent {
            term_id: term_id.clone(),
        },
    );
}

/// Reposition/resize the terminal to track its DOM hole. Moves the native view
/// on the UI thread and tells the render thread to reconfigure the surface.
#[tauri::command]
pub fn native_term_set_bounds(
    app: AppHandle,
    manager: State<'_, NativeTermManager>,
    term_id: String,
    x: f64,
    y: f64,
    width: f64,
    height: f64,
    scale: f64,
) -> Result<(), String> {
    let scale = if scale <= 0.0 { 1.0 } else { scale };
    let view = match manager.terms.lock().unwrap().get(&term_id) {
        Some(t) => t.view,
        None => return Ok(()), // teardown race — silent no-op
    };

    if let Some(window) = app.get_window(MAIN_WINDOW) {
        let rect = RectPx { x, y, w: width, h: height };
        let move_window = window.clone();
        let _ = app.run_on_main_thread(move || {
            surface::set_frame(&move_window, view, rect, scale);
        });
    }

    let px_w = (width * scale).round().max(1.0) as u32;
    let px_h = (height * scale).round().max(1.0) as u32;
    if let Some(t) = manager.terms.lock().unwrap().get(&term_id) {
        let _ = t.ctrl.send(Ctrl::Resize { px_w, px_h });
    }
    Ok(())
}

/// Send keystrokes / paste bytes to the terminal's shell.
#[tauri::command]
pub fn native_term_write(
    manager: State<'_, NativeTermManager>,
    term_id: String,
    data: Vec<u8>,
) -> Result<(), String> {
    if let Some(t) = manager.terms.lock().unwrap().get(&term_id) {
        t.ctrl.send(Ctrl::Write(data)).map_err(|e| e.to_string())?;
    }
    Ok(())
}

/// Scroll the viewport by `lines` (negative scrolls up into scrollback).
#[tauri::command]
pub fn native_term_scroll(
    manager: State<'_, NativeTermManager>,
    term_id: String,
    lines: i32,
) -> Result<(), String> {
    if let Some(t) = manager.terms.lock().unwrap().get(&term_id) {
        let _ = t.ctrl.send(Ctrl::Scroll(lines));
    }
    Ok(())
}

/// Focus gained/lost — drives the cursor block/hollow state.
#[tauri::command]
pub fn native_term_focus(
    manager: State<'_, NativeTermManager>,
    term_id: String,
    focused: bool,
) -> Result<(), String> {
    if let Some(t) = manager.terms.lock().unwrap().get(&term_id) {
        let _ = t.ctrl.send(Ctrl::Focus(focused));
    }
    Ok(())
}

/// Drive a mouse selection. `phase` is `"start"` (anchor + head at fx,fy),
/// `"move"` (extend head to fx,fy), or `"clear"` (drop the selection). `fx`/`fy`
/// are normalized 0..1 positions over the hole — scale-independent so the render
/// thread maps them to cells against the live grid size.
#[tauri::command]
pub fn native_term_select(
    manager: State<'_, NativeTermManager>,
    term_id: String,
    phase: String,
    fx: f64,
    fy: f64,
) -> Result<(), String> {
    let msg = match phase.as_str() {
        "start" => Ctrl::SelectStart { fx: fx as f32, fy: fy as f32 },
        "move" => Ctrl::SelectUpdate { fx: fx as f32, fy: fy as f32 },
        "clear" => Ctrl::SelectClear,
        other => return Err(format!("unknown select phase: {other}")),
    };
    if let Some(t) = manager.terms.lock().unwrap().get(&term_id) {
        let _ = t.ctrl.send(msg);
    }
    Ok(())
}

/// Return the currently-selected text (empty string when nothing is selected).
/// Round-trips through the render thread over a oneshot channel so it reads the
/// same grid the frames are drawn from.
#[tauri::command]
pub fn native_term_copy(
    manager: State<'_, NativeTermManager>,
    term_id: String,
) -> Result<String, String> {
    let ctrl = match manager.terms.lock().unwrap().get(&term_id) {
        Some(t) => t.ctrl.clone(),
        None => return Ok(String::new()),
    };
    let (tx, rx) = std::sync::mpsc::channel::<String>();
    ctrl.send(Ctrl::Copy(tx)).map_err(|e| e.to_string())?;
    // The render thread services ctrl every ≤16ms; a short timeout is ample and
    // keeps a dead thread from hanging the command.
    rx.recv_timeout(Duration::from_millis(500))
        .map_err(|_| "copy timed out".to_string())
}

/// Return recent visible terminal text for the Manager's `@terminal` context
/// mention. Like copy, this round-trips through the render thread so the text
/// is read from the exact grid the user sees.
#[tauri::command]
pub fn native_term_context(
    manager: State<'_, NativeTermManager>,
    term_id: String,
    max_lines: Option<usize>,
) -> Result<String, String> {
    let ctrl = match manager.terms.lock().unwrap().get(&term_id) {
        Some(t) => t.ctrl.clone(),
        None => return Ok(String::new()),
    };
    let (tx, rx) = std::sync::mpsc::channel::<String>();
    ctrl.send(Ctrl::Context {
        max_lines: max_lines.unwrap_or(200).clamp(1, 1000),
        reply: tx,
    })
    .map_err(|e| e.to_string())?;
    rx.recv_timeout(Duration::from_millis(500))
        .map_err(|_| "terminal context read timed out".to_string())
}

/// Close the terminal: stop the render thread and remove the native view on the
/// UI thread.
#[tauri::command]
pub fn native_term_close(
    app: AppHandle,
    manager: State<'_, NativeTermManager>,
    term_id: String,
) -> Result<(), String> {
    if let Some(t) = manager.terms.lock().unwrap().remove(&term_id) {
        let _ = t.ctrl.send(Ctrl::Close);
        let view = t.view;
        let _ = app.run_on_main_thread(move || surface::destroy(view));
    }
    Ok(())
}
