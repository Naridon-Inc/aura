//! Native GPU terminal — the wgpu-rendered replacement for the xterm.js
//! terminal, wired into the ADE shell behind a flag.
//!
//! Each terminal spawns its own shell through `aura_term_core` (PTY +
//! `alacritty_terminal` grid model), renders the grid with `aura_term_gpu`
//! (wgpu), and paints into a native child surface
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
//! Spawning is not baked into the renderer, though. The loop only ever reads
//! output from a channel and sends input back through [`sink::TerminalSink`],
//! so a pane can render a PTY something else already owns — an agent session,
//! say — without the loop knowing the difference.
//!
//! The engine (PTY, grid, renderer) is 100% platform-neutral; only [`surface`]
//! is per-OS. So the same render loop drives Metal on macOS and Vulkan on
//! Linux without change.

pub mod appearance;
pub mod attach;
pub mod clip;
pub mod sink;
pub mod surface;
pub mod wheel;

use std::collections::HashMap;
use std::sync::mpsc::{Receiver, RecvTimeoutError, Sender};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use aura_term_core::{
    spawn as pty_spawn, CellMetrics, GridTerminal, Palette, PtyConfig, PtyEvent, Selection,
};
use serde::Serialize;
use tauri::{AppHandle, Emitter, Manager, State};

use clip::{ClipPx, ClipRect};
use sink::TerminalSink;
use surface::RectPx;

const MAIN_WINDOW: &str = "main";
/// Frame budget — the render thread wakes at least this often to service input
/// and repaints only when the grid is dirty.
const FRAME_MS: u64 = 16;

/// Control messages sent from Tauri commands to a terminal's render thread.
enum Ctrl {
    /// New hole size in physical pixels (from a bounds reconcile), plus how
    /// much of that hole the surface is currently allowed to paint.
    ///
    /// The two are deliberately separate. `px_w`/`px_h` are the hole and they
    /// are what sizes the grid and the shell; `clip` is what an open overlay
    /// has left uncovered and it only ever sizes the swapchain. A menu opening
    /// over a pane changes the second and not the first, which is the whole
    /// point — the terminal keeps its columns while a menu is on top of it.
    Resize {
        px_w: u32,
        px_h: u32,
        clip: ClipPx,
    },
    /// Keystrokes / paste bytes to write to the shell.
    Write(Vec<u8>),
    /// Scroll the viewport by N lines. Positive goes back into scrollback,
    /// negative returns toward the live prompt — `Grid::scroll_lines`'s sign.
    ///
    /// Sent by the DOM hole's wheel handler, which is the path every platform
    /// without a native wheel route still uses, and by keyboard scrolling.
    Scroll(i32),
    /// A wheel event the GPU surface took directly (macOS), with the pointer
    /// at a normalized position over the surface.
    ///
    /// Separate from [`Ctrl::Scroll`] because the delta arrives in pixels and
    /// only the render thread knows how tall a line is.
    Wheel {
        input: aura_term_core::WheelInput,
        fx: f32,
        fy: f32,
    },
    /// Focus gained/lost (drives cursor block vs hollow).
    Focus(bool),
    /// Begin a mouse selection at a normalized (0..1) position over the hole.
    /// Fractions are scale-independent; the render thread maps them to cells.
    SelectStart { fx: f32, fy: f32 },
    /// Extend the in-flight selection head to a new normalized position.
    SelectUpdate { fx: f32, fy: f32 },
    /// Drop the current selection.
    SelectClear,
    /// Theme or text size changed. `raster_font_px` is already multiplied by
    /// the device scale, because the command side knows the scale and the
    /// render thread does not keep it.
    Appearance {
        raster_font_px: f32,
        palette: Palette,
    },
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
    /// Set only for a pane attached to a PTY it does not own. That pane reads
    /// its bytes off a tap on a helper thread, and a tap goes quiet rather
    /// than closing when the pane is done with it — nothing disconnects the
    /// channel, so the thread would park on `recv` for the life of the app.
    /// Closing raises this and the bridge stops at its next poll.
    tap_stop: Option<Arc<std::sync::atomic::AtomicBool>>,
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
    /// Colors and font size, as the frontend last resolved them. Kept here
    /// rather than threaded through `open` because the theme changes on its own
    /// schedule — a terminal opened after a theme switch must come up already
    /// wearing it, with no first frame in the old colors.
    appearance: appearance::AppearanceStore,
}

impl NativeTermManager {
    pub fn new() -> Self {
        Self {
            gpu: Mutex::new(None),
            terms: Mutex::new(HashMap::new()),
            appearance: appearance::AppearanceStore::new(),
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

/// A configured surface and the renderer that paints it, plus the grid shape
/// the two agree on. Everything here is independent of where the terminal's
/// bytes come from, which is the point: [`native_term_open`] spawns a shell
/// behind it, [`attach::native_term_attach`] points it at a PTY that
/// `cmd_agent_pty` already owns.
pub(crate) struct Prepared {
    pub(crate) surface: wgpu::Surface<'static>,
    /// Opaque native view pointer (UI-thread only).
    pub(crate) view: usize,
    pub(crate) config: wgpu::SurfaceConfiguration,
    pub(crate) renderer: aura_term_gpu::Renderer,
    /// Raster size `renderer` was built at, carried so the render thread can
    /// later tell a font change from a recolor.
    pub(crate) font_px: f32,
    pub(crate) device: Arc<wgpu::Device>,
    pub(crate) queue: Arc<wgpu::Queue>,
    pub(crate) cols: u16,
    pub(crate) rows: u16,
    pub(crate) cell_w: f32,
    pub(crate) cell_h: f32,
}

/// Attach a native child surface over the hole at `rect`, configure it, and
/// build the renderer for it. The caller supplies the bytes.
#[allow(clippy::too_many_arguments)]
pub(crate) async fn prepare(
    app: &AppHandle,
    manager: &NativeTermManager,
    x: f64,
    y: f64,
    width: f64,
    height: f64,
    scale: f64,
) -> Result<Prepared, String> {
    let ctx = ensure_gpu(manager).await?;
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

    let font_px = manager.appearance.get().raster_font_px(scale);
    let renderer = aura_term_gpu::Renderer::new(&ctx.device, &ctx.queue, format, font_px);
    let (cell_w, cell_h) = renderer.cell_metrics();
    let cols = ((px_w as f32 / cell_w).floor() as u16).max(1);
    let rows = ((px_h as f32 / cell_h).floor() as u16).max(1);

    Ok(Prepared {
        surface: attached.surface,
        view: attached.view,
        config,
        renderer,
        font_px,
        device: ctx.device.clone(),
        queue: ctx.queue.clone(),
        cols,
        rows,
        cell_w,
        cell_h,
    })
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
    // Idempotent: an existing terminal just gets repositioned. No clip — open
    // carries the hole only, and the reconcile that called it follows up with
    // the current clip in its own `set_bounds`.
    if manager.terms.lock().unwrap().contains_key(&term_id) {
        native_term_set_bounds(app, manager, term_id, x, y, width, height, scale, None)?;
        return Ok(());
    }

    let prepared = prepare(&app, &manager, x, y, width, height, scale).await?;
    let Prepared {
        surface: term_surface,
        view,
        config,
        renderer,
        font_px,
        device,
        queue,
        cols,
        rows,
        cell_w,
        cell_h,
    } = prepared;

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

    let mut grid = GridTerminal::with_palette(cols, rows, manager.appearance.get().palette);
    grid.set_focused(true);

    let (ctrl_tx, ctrl_rx) = std::sync::mpsc::channel::<Ctrl>();

    let thread_app = app.clone();
    let thread_id = term_id.clone();
    std::thread::Builder::new()
        .name(format!("aura-term-{term_id}"))
        .spawn(move || {
            render_loop(
                thread_app,
                thread_id,
                term_surface,
                device,
                queue,
                renderer,
                font_px,
                grid,
                Box::new(pty),
                events,
                ctrl_rx,
                config,
            );
        })
        .map_err(|e| e.to_string())?;

    // The surface takes the scroll wheel itself, so it needs a way back to
    // this render thread.
    #[cfg(target_os = "macos")]
    wheel::register(view, ctrl_tx.clone());

    let displaced = manager.terms.lock().unwrap().insert(
        term_id,
        TermControl {
            ctrl: ctrl_tx,
            view,
            tap_stop: None,
        },
    );
    // A concurrent open for the same id got here first; its surface is still
    // in the window and nothing else will ever remove it.
    if let Some(old) = displaced {
        retire(&app, old);
    }
    Ok(())
}

/// Act on a wheel movement of `lines`, whichever path it arrived by.
///
/// A terminal has two different things a wheel can mean and only the grid's
/// current modes say which: at a prompt it moves the viewport over the
/// scrollback, and inside a full-screen program it has to become input for that
/// program, because the alternate screen keeps no history to move. `at` is the
/// cell under the pointer, which only mouse reports use.
fn apply_wheel(
    grid: &mut GridTerminal,
    pty: &mut dyn TerminalSink,
    lines: i32,
    at: (u16, u16),
    dirty: &mut bool,
) {
    match grid.apply_wheel(lines, at) {
        aura_term_core::WheelAction::Scroll(_) => *dirty = true,
        aura_term_core::WheelAction::Send(bytes) => pty.write(&bytes),
        aura_term_core::WheelAction::None => {}
    }
}

/// Configure the swapchain at the clip's size rather than the hole's.
///
/// `config` is the hole throughout the render loop, because the hole is what
/// decides how many columns the shell has. The drawable, though, has to match
/// the native view, and the view is the clip — hand wgpu a drawable bigger
/// than its view and Metal rejects the frame outright. So every configure in
/// this file goes through here, and the hole's width and height are the two
/// fields that get overridden on the way.
fn configure_clipped(
    surface: &wgpu::Surface<'static>,
    device: &wgpu::Device,
    config: &wgpu::SurfaceConfiguration,
    clip: ClipPx,
) {
    let mut c = config.clone();
    c.width = clip.w.max(1);
    c.height = clip.h.max(1);
    surface.configure(device, &c);
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
    // Raster size the renderer above was built at. Tracked so an appearance
    // change can tell a font resize (needs a new atlas) from a recolor (does
    // not), since the renderer does not report the size it was made with.
    mut renderer_font_px: f32,
    mut grid: GridTerminal,
    mut pty: Box<dyn TerminalSink>,
    events: Receiver<PtyEvent>,
    ctrl: Receiver<Ctrl>,
    mut config: wgpu::SurfaceConfiguration,
) {
    // How much of the hole is currently paintable. A terminal is born with all
    // of it and only an overlay over the pane ever narrows it.
    let mut clip = ClipPx::full(config.width, config.height);
    configure_clipped(&surface, &device, &config, clip);
    let mut dirty = true;
    let mut closed = false;
    // Anchor cell of an in-flight mouse selection (set on SelectStart, cleared
    // on SelectClear / a keystroke). The head follows on each SelectUpdate.
    let mut sel_anchor: Option<(u16, u16)> = None;
    // Carries the fraction of a line a trackpad gesture has moved but not yet
    // spent. Without it every sub-line delta rounds to zero and a slow scroll
    // never moves at all.
    let mut wheel_accum = aura_term_core::WheelAccum::new();

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
                    pty.write(&b);
                }
                Ctrl::Resize { px_w, px_h, clip: next } => {
                    let hole_changed =
                        config.width != px_w.max(1) || config.height != px_h.max(1);
                    config.width = px_w.max(1);
                    config.height = px_h.max(1);
                    clip = next;
                    configure_clipped(&surface, &device, &config, clip);
                    // The grid and the shell only hear about a change to the
                    // HOLE. This guard is the difference between a menu click
                    // and a window resize: a clip-only message reconfigures
                    // the drawable and stops, so no `SIGWINCH` reaches the
                    // program in the pane and no scrollback is reflowed for
                    // something as transient as an open context menu.
                    if hole_changed {
                        let (cw, ch) = renderer.cell_metrics();
                        let cols = ((config.width as f32 / cw).floor() as u16).max(1);
                        let rows = ((config.height as f32 / ch).floor() as u16).max(1);
                        grid.resize(cols, rows);
                        pty.resize(cols, rows, config.width as u16, config.height as u16);
                    }
                    dirty = true;
                }
                Ctrl::Appearance { raster_font_px, palette } => {
                    grid.set_palette(palette);
                    // Font size is baked into the glyph atlas at construction,
                    // so a size change means a new renderer. Rebuild only when
                    // the size actually moved: a theme switch alone must not
                    // throw away a warm atlas, and this message arrives on
                    // every theme change.
                    let (old_cw, old_ch) = renderer.cell_metrics();
                    if (renderer_font_px - raster_font_px).abs() > 0.01 {
                        renderer = aura_term_gpu::Renderer::new(
                            &device,
                            &queue,
                            config.format,
                            raster_font_px,
                        );
                        renderer_font_px = raster_font_px;
                        // Bigger glyphs mean fewer cells in the same pixels, so
                        // the grid and the shell both have to be told — skip
                        // this and the shell keeps writing 80 columns into a
                        // window that now holds 60.
                        let (cw, ch) = renderer.cell_metrics();
                        if (cw - old_cw).abs() > 0.01 || (ch - old_ch).abs() > 0.01 {
                            let cols = ((config.width as f32 / cw).floor() as u16).max(1);
                            let rows = ((config.height as f32 / ch).floor() as u16).max(1);
                            grid.resize(cols, rows);
                            pty.resize(cols, rows, config.width as u16, config.height as u16);
                        }
                    }
                    dirty = true;
                }
                Ctrl::Scroll(lines) => {
                    // Routed through the same decision as a native wheel: on
                    // the alternate screen there is no scrollback to move, and
                    // moving it anyway is the silent no-op that made this look
                    // like a terminal that cannot scroll.
                    apply_wheel(&mut grid, &mut *pty, lines, (0, 0), &mut dirty);
                }
                Ctrl::Wheel { input, fx, fy } => {
                    let (_, cell_h) = renderer.cell_metrics();
                    let lines = wheel_accum.lines(input, cell_h as f64);
                    // `scrollWheel:` measured the pointer against the view's
                    // own bounds, and the view is the clip — so while an
                    // overlay is open those fractions describe a sub-rect of
                    // the grid, not the grid. Re-base them before asking for a
                    // cell, or alt-screen mouse reporting tells a full-screen
                    // program the wheel turned on the wrong line.
                    let (hx, hy) = clip.to_hole_frac(fx, fy, config.width, config.height);
                    let at = frac_to_cell(&renderer, &config, hx, hy);
                    apply_wheel(&mut grid, &mut *pty, lines, at, &mut dirty);
                }
                Ctrl::Focus(f) => {
                    grid.set_focused(f);
                    dirty = true;
                }
                Ctrl::SelectStart { fx, fy } => {
                    // No clip re-basing here, unlike the wheel above: these
                    // fractions were measured in JS against the DOM hole,
                    // which keeps its full size whatever the clip is doing, so
                    // they are already fractions of the whole grid.
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
                let mut list = grid.render_list(CellMetrics { cell_w: cw, cell_h: ch });
                // The grid is always laid out from the hole's origin, because
                // that is the only frame in which a cell has a stable address.
                // When the view has been clipped to a band of that hole, the
                // whole frame slides the other way so the band shows the rows
                // it is actually over; the rest falls outside the drawable and
                // the scissor drops it, per pixel, so a glyph straddling the
                // boundary is cut rather than lost.
                let (dx, dy) = clip.geometry_offset();
                aura_term_core::translate(&mut list, dx, dy);
                let bg = grid.palette().background;
                renderer.render(
                    &device,
                    &queue,
                    &view,
                    (clip.w as f32, clip.h as f32),
                    &list,
                    bg,
                );
                frame.present();
                dirty = false;
            }
            Err(wgpu::SurfaceError::Outdated) | Err(wgpu::SurfaceError::Lost) => {
                configure_clipped(&surface, &device, &config, clip);
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
///
/// `x`/`y`/`width`/`height` are the **hole**: the whole rectangle the pane has
/// set aside for this terminal, in window points. That is what decides how
/// many columns the shell gets, and it changes only when the pane itself
/// changes shape.
///
/// `clip` is the part of that hole no open overlay is sitting on, in the same
/// space. It is what the native view is actually given as its frame, so a menu
/// over the pane shrinks the painted surface to the band beside or below it
/// and leaves the terminal running at full size underneath. Omit it — as the
/// internal callers that have no overlay to worry about do — and the view gets
/// the whole hole, which is the state a terminal spends almost all its life
/// in.
///
/// Note the asymmetry this creates and that [`clip`] exists to manage: after
/// this call the view and the hole are different rectangles, so anything that
/// measures a pointer against the *view* needs re-basing, while anything
/// measured against the *DOM hole* does not.
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
    clip: Option<ClipRect>,
) -> Result<(), String> {
    let scale = if scale <= 0.0 { 1.0 } else { scale };
    let view = match manager.terms.lock().unwrap().get(&term_id) {
        Some(t) => t.view,
        None => return Ok(()), // teardown race — silent no-op
    };

    let px_w = (width * scale).round().max(1.0) as u32;
    let px_h = (height * scale).round().max(1.0) as u32;
    let clip_px = ClipPx::resolve(clip, x, y, px_w, px_h, scale);

    if let Some(window) = app.get_window(MAIN_WINDOW) {
        // The view gets the CLIP, not the hole. Derived back from the resolved
        // pixel rect rather than taken from the incoming floats so the frame
        // and the drawable cannot disagree by a rounding step — a view one
        // pixel off its swapchain is a seam at the edge of the terminal.
        let rect = RectPx {
            x: x + clip_px.x as f64 / scale,
            y: y + clip_px.y as f64 / scale,
            w: clip_px.w as f64 / scale,
            h: clip_px.h as f64 / scale,
        };
        let move_window = window.clone();
        let _ = app.run_on_main_thread(move || {
            surface::set_frame(&move_window, view, rect, scale);
        });
    }

    if let Some(t) = manager.terms.lock().unwrap().get(&term_id) {
        let _ = t.ctrl.send(Ctrl::Resize {
            px_w,
            px_h,
            clip: clip_px,
        });
    }
    Ok(())
}

/// Tell the native terminals what the theme and text-size settings now are.
///
/// Called once per theme or setting change, not once per terminal: the resolved
/// appearance is stored on the manager so terminals opened afterwards come up
/// already wearing it, and every live terminal is sent the change so its
/// existing scrollback recolors too.
///
/// Returns the number of live terminals told, which is what makes this
/// testable from the frontend — a theme change that reports 0 while a terminal
/// is open is a wiring bug, and silence would hide it.
#[tauri::command]
pub fn native_term_set_appearance(
    manager: State<'_, NativeTermManager>,
    appearance: appearance::AppearanceInput,
    scale: f64,
) -> Result<usize, String> {
    let resolved = manager.appearance.merge(&appearance);
    let raster_font_px = resolved.raster_font_px(scale);

    let terms = manager.terms.lock().unwrap();
    let mut told = 0usize;
    for t in terms.values() {
        // A send failure means that render thread is already gone; its entry is
        // cleaned up elsewhere, so it is not this call's problem to report.
        if t.ctrl
            .send(Ctrl::Appearance {
                raster_font_px,
                palette: resolved.palette,
            })
            .is_ok()
        {
            told += 1;
        }
    }
    Ok(told)
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

/// Scroll the viewport by `lines`. POSITIVE moves back into scrollback and
/// negative returns toward the live prompt, which is `Grid::scroll_lines`'s
/// convention (`grid.rs`) and alacritty's underneath it. The comment here used
/// to claim the opposite; the callers were always right and the prose was not.
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

/// Shut a control down: stop its tap bridge and render thread, and take its
/// view out of the window.
///
/// Used for a deliberate close and for a control that a later open displaces.
/// That second case is not hypothetical: `open` and `attach` test for an
/// existing id and then `await` the GPU surface before inserting, so two calls
/// for the same pane can both pass the test and both build a surface. Dropping
/// the loser would leave its render thread running and its NSView still in the
/// window, painting forever at whatever frame it last had — which is what put
/// a stale rectangle over the sidebar when a pane re-opened on every render.
pub(crate) fn retire(app: &AppHandle, old: TermControl) {
    // An attached pane's output comes off a tap on a helper thread. The tap
    // goes quiet rather than disconnecting when the pane is done with it, so
    // that thread has to be told; the render thread's `Ctrl::Close` does not
    // reach it.
    if let Some(stop) = old.tap_stop {
        stop.store(true, std::sync::atomic::Ordering::Relaxed);
    }
    let _ = old.ctrl.send(Ctrl::Close);
    let view = old.view;
    // Before the view goes, drop its wheel route — an entry left behind would
    // name a dead render thread and a freed view.
    #[cfg(target_os = "macos")]
    wheel::unregister(view);
    let _ = app.run_on_main_thread(move || surface::destroy(view));
}

/// Close the terminal: stop the render thread and remove the native view on the
/// UI thread.
#[tauri::command]
pub fn native_term_close(
    app: AppHandle,
    manager: State<'_, NativeTermManager>,
    term_id: String,
) -> Result<(), String> {
    let gone = manager.terms.lock().unwrap().remove(&term_id);
    if let Some(t) = gone {
        retire(&app, t);
    }
    Ok(())
}
