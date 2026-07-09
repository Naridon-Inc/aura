//! The floating, always-on-top **HUD** — a small glanceable bar that
//! mirrors the active chat's status + last messages and lets you fire a
//! quick reply without opening the full Aura window. Think "movie-bar":
//! summon it with ⌘⇧A (or the menu-bar icon) while something else is
//! fullscreen, glance at where the agent is, optionally reply, dismiss.
//!
//! The window loads the same `index.html` with a `?hud=1` marker; the
//! React side (`components/hud/HudApp.tsx`) renders the bar and subscribes
//! to the app-global `hud:state` event the *main* window publishes (each
//! OS window has its own JS heap, so the HUD cannot read the main window's
//! stores directly — it listens on the backend event bus instead). Sends
//! travel back the other way as a `hud:send` event the main window routes
//! through its existing dispatcher.

use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, AtomicI8, Ordering};
use std::sync::Mutex;

use tauri::{
    AppHandle, LogicalPosition, Manager, PhysicalPosition, WebviewUrl, WebviewWindow,
    WebviewWindowBuilder, Wry,
};

/// Window label. It deliberately matches the `popout-*` capability glob in
/// `capabilities/default.json` so the HUD inherits the same window/webview/
/// event permissions as the existing popout windows — no new capability
/// file is required.
pub const HUD_LABEL: &str = "popout-hud";

const HUD_WIDTH: f64 = 700.0;
/// Transparent gutter around the pill on EVERY side. It does double duty: it
/// holds the capsule's soft drop shadow so the shadow can't clip at the window
/// edge (which read as an ugly hard rectangle), and it's the inset the native
/// frost is laid out to, so the frost sits exactly behind the CSS pill. Kept in
/// sync with `.hud-pill`'s margin in CSS.
const HUD_GUTTER: f64 = 48.0;
/// Collapsed pill height — a single glance row. Expanded heights are measured on
/// the React side (the pill is content-sized) and pushed via `hud_resize`.
const HUD_PILL_COLLAPSED: f64 = 52.0;
/// The frost inset = the gutter (same on the sides and the bottom). Named for
/// the `apply_vibrancy`/`resize` call sites that lay out the frost rect.
const HUD_CAPSULE_INSET_X: f64 = HUD_GUTTER;
const HUD_CAPSULE_INSET_BOTTOM: f64 = HUD_GUTTER;
/// Collapsed window height = top gutter + pill + bottom gutter.
const HUD_COLLAPSED_H: f64 = HUD_GUTTER + HUD_PILL_COLLAPSED + HUD_GUTTER;
/// Corner radius of the frosted pill — kept in sync with `.hud-pill` in CSS.
const CORNER_RADIUS: f64 = 22.0;
/// Gap from the bottom edge of the monitor's visible area — keeps the bar
/// clear of the Dock while sitting low enough to read at a glance.
const BOTTOM_MARGIN: f64 = 72.0;

/// Visible width of the floating sidebar panel — narrower than the capsule so
/// the docked window doesn't capture clicks across half the screen.
const HUD_SIDEBAR_WIDTH: f64 = 320.0;
/// Sidebar window width = the panel plus the shadow gutters on both sides.
const HUD_SIDEBAR_WIN_W: f64 = HUD_SIDEBAR_WIDTH + 2.0 * HUD_GUTTER;
/// Gap from the screen's right edge when docked as a sidebar.
const HUD_SIDEBAR_MARGIN: f64 = 24.0;
/// Below this window width, the sidebar is collapsed to its circular FAB (nub
/// ≈ 56 + gutters ≈ 152); the expanded panel is always ≥ 240 + gutters = 336.
/// The collapsed FAB floats freely (drag-to-move), so `resize` keeps its origin
/// rather than re-docking it to the right edge.
const HUD_SIDEBAR_FAB_MAX_W: f64 = 250.0;

/// Ambient window width — a wide, immersive bottom-centre surface (the
/// Gemini-style glow + greeting + composer). Bigger than the capsule so the
/// edge glow + bottom gradient have room to breathe; the height grows with the
/// measured content like the capsule (bottom pinned, grows upward).
const HUD_AMBIENT_W: f64 = 880.0;

/// Which shape the HUD wears. User-chosen in Settings (`hud.mode`) and applied
/// live on the one persistent window — no recreation. `Capsule` = the
/// bottom-centre green-glass pill (default); `Sidebar` = a floating right-edge
/// panel summoned by a FAB; `Minimal` = a tiny frost-less "nerd" overlay;
/// `Ambient` = a wide immersive glow surface (greeting + bottom-gradient).
#[derive(Clone, Copy, PartialEq, Eq)]
pub enum Mode {
    Capsule,
    Sidebar,
    Minimal,
    Ambient,
}

/// 0 = capsule · 1 = sidebar · 2 = minimal. An atomic (like the overlay's
/// `LAST_THEME`) so the off-main-thread commands and the main-thread Cocoa code
/// agree on the shape without locking.
static CURRENT_MODE: AtomicI8 = AtomicI8::new(0);

fn current_mode() -> Mode {
    match CURRENT_MODE.load(Ordering::Relaxed) {
        1 => Mode::Sidebar,
        2 => Mode::Minimal,
        3 => Mode::Ambient,
        _ => Mode::Capsule,
    }
}

fn store_mode(mode: Mode) {
    CURRENT_MODE.store(
        match mode {
            Mode::Capsule => 0,
            Mode::Sidebar => 1,
            Mode::Minimal => 2,
            Mode::Ambient => 3,
        },
        Ordering::Relaxed,
    );
}

/// Master on/off for the floating HUD — a persistent Settings switch
/// (`hud.enabled`, default on). When off, ⌘⇧A, the menu-bar tray, and every
/// programmatic summon are no-ops, so the HUD never appears. Seeded from the
/// saved TOML at startup (`seed_enabled`) and flipped live from Settings
/// (`hud_set_enabled`); an atomic so the global-shortcut handler and the IPC
/// commands agree without taking a lock.
static HUD_ENABLED: AtomicBool = AtomicBool::new(true);

/// Whether the HUD is currently allowed to appear (the persisted master switch).
pub fn is_enabled() -> bool {
    HUD_ENABLED.load(Ordering::Relaxed)
}

/// Seed the master switch from persisted settings at startup. Touches no
/// window — the HUD is summon-only, so there's nothing on screen to hide yet.
pub fn seed_enabled(enabled: bool) {
    HUD_ENABLED.store(enabled, Ordering::Relaxed);
}

fn mode_from_str(s: &str) -> Mode {
    match s {
        "sidebar" => Mode::Sidebar,
        "minimal" => Mode::Minimal,
        "ambient" => Mode::Ambient,
        _ => Mode::Capsule,
    }
}

/// Full window width for a mode — capsule/minimal keep the wide bar; sidebar is
/// the narrow docked panel; ambient is the wide immersive surface.
#[cfg_attr(not(target_os = "macos"), allow(dead_code))]
fn mode_win_width(mode: Mode) -> f64 {
    match mode {
        Mode::Sidebar => HUD_SIDEBAR_WIN_W,
        Mode::Ambient => HUD_AMBIENT_W,
        _ => HUD_WIDTH,
    }
}

/// `⌘⇧A` / tray-left-click entry point: show the HUD if hidden, hide it if
/// already on screen.
pub fn toggle(app: &AppHandle<Wry>) {
    if !is_enabled() {
        eprintln!("[HUD] toggle: HUD disabled in Settings — ignoring");
        return;
    }
    if let Some(win) = app.get_webview_window(HUD_LABEL) {
        let visible = win.is_visible();
        eprintln!("[HUD] toggle: window exists, visible={visible:?}");
        if matches!(visible, Ok(true)) {
            eprintln!("[HUD] toggle: hiding");
            overlay::set_visible(&win, false);
            let _ = win.hide();
        } else {
            eprintln!("[HUD] toggle: revealing");
            reveal(&win);
        }
    } else {
        eprintln!("[HUD] toggle: no window yet, creating");
        if let Err(e) = create(app) {
            eprintln!("[HUD] create failed: {e}");
        }
    }
}

/// Bring the HUD up (tray "Show HUD" / programmatic show). Honors the master
/// switch — a no-op when the HUD is disabled in Settings.
pub fn show(app: &AppHandle<Wry>) {
    if !is_enabled() {
        return;
    }
    if let Some(win) = app.get_webview_window(HUD_LABEL) {
        reveal(&win);
    } else if let Err(e) = create(app) {
        tracing::warn!(error = %e, "failed to create HUD window");
    }
}

/// Hide the HUD without destroying it (so it re-summons instantly and the
/// React side keeps its `hud:state` subscription warm).
pub fn hide(app: &AppHandle<Wry>) {
    if let Some(win) = app.get_webview_window(HUD_LABEL) {
        overlay::set_visible(&win, false);
        let _ = win.hide();
    }
}

fn reveal(win: &WebviewWindow<Wry>) {
    // Re-assert the overlay level + Spaces behaviour (the runtime can reset the
    // window level across hides), then place it. On macOS `overlay::place`
    // opens on the monitor *under the cursor* — restoring a remembered drag
    // only when it falls on that same monitor, otherwise bottom-centring there.
    // Off macOS we restore the physical position (or bottom-centre) in Rust.
    overlay::make_overlay(win);
    // Only the capsule honours a remembered drag; sidebar/minimal each have a
    // fixed mode anchor (right-edge / bottom-centre), so a stale capsule spot
    // wouldn't make sense for them.
    let saved = if matches!(current_mode(), Mode::Capsule) {
        load_saved_pos()
    } else {
        None
    };
    let placed = overlay::place(win, saved, BOTTOM_MARGIN);
    eprintln!("[HUD] reveal: saved={saved:?} placed={placed}");
    if !placed {
        match saved {
            Some((x, y)) => {
                let _ = win.set_position(PhysicalPosition::new(x as i32, y as i32));
            }
            None => position_bottom_center(win),
        }
    }
    let show = win.show();
    // Surface on the current Space without activating the app (activation
    // would pull the user out of a full-screen Space back to the desktop).
    overlay::order_front(win);
    // Bar is composited on-screen now: start realtime backdrop adaptation (an
    // immediate sample + a background loop that keeps the glass matched as the
    // scene changes). The "below window" capture reliably excludes the HUD only
    // once it's ordered in.
    overlay::set_visible(win, true);
    let vis = win.is_visible();
    let pos = win.outer_position();
    eprintln!("[HUD] reveal shown: show={show:?} is_visible={vis:?} outer_position={pos:?}");
}

fn create(app: &AppHandle<Wry>) -> tauri::Result<()> {
    let win = WebviewWindowBuilder::new(app, HUD_LABEL, WebviewUrl::App("index.html?hud=1".into()))
        .title("Aura HUD")
        .inner_size(HUD_WIDTH, HUD_COLLAPSED_H)
        .resizable(false)
        .minimizable(false)
        .maximizable(false)
        // No native chrome — the bar paints its own rounded surface over a
        // transparent window (requires `macOSPrivateApi` in tauri.conf.json).
        .decorations(false)
        .transparent(true)
        .always_on_top(true)
        // Stay out of the Dock/⌘-Tab switcher; the menu-bar icon is the
        // app's anchor while the main window is hidden.
        .skip_taskbar(true)
        // Follow the user across Spaces so it's reachable from a maximized
        // movie/browser window.
        .visible_on_all_workspaces(true)
        .focused(true)
        .build()?;
    // Reclass to a non-activating NSPanel FIRST (so it can float over other
    // apps' full-screen Spaces), then paint the frosted background. Both are
    // one-time; overlay level + Spaces behaviour + positioning are re-asserted
    // on every `reveal`.
    overlay::make_panel(&win);
    overlay::apply_vibrancy(&win, CORNER_RADIUS, HUD_PILL_COLLAPSED);
    reveal(&win);
    Ok(())
}

/// Park the window centred horizontally and near the bottom of whatever
/// monitor it currently lives on (falling back to the primary monitor for
/// a brand-new window that hasn't been placed yet).
fn position_bottom_center(win: &WebviewWindow<Wry>) {
    let monitor = match win.current_monitor() {
        Ok(Some(m)) => Some(m),
        _ => win.primary_monitor().ok().flatten(),
    };
    let Some(monitor) = monitor else { return };
    let scale = monitor.scale_factor();
    let size = monitor.size().to_logical::<f64>(scale);
    let origin = monitor.position().to_logical::<f64>(scale);
    let x = origin.x + (size.width - HUD_WIDTH) / 2.0;
    let y = origin.y + size.height - HUD_COLLAPSED_H - BOTTOM_MARGIN;
    let _ = win.set_position(LogicalPosition::new(x, y));
}

// ── Remembered position ─────────────────────────────────────────────────
// The HUD is a normal draggable window (its header strip is the drag handle).
// We persist wherever the user drags it so it reopens there next summon — and
// across restarts. `reveal` only restores it when the saved spot lands on the
// monitor under the cursor, so summoning on a different screen still bottom-
// centres there. Stored as f64: Cocoa point origin on macOS (bottom-left),
// physical top-left pixels elsewhere — both consistent within one machine.

static SAVED_POS: Mutex<Option<(f64, f64)>> = Mutex::new(None);

fn pos_file() -> Option<PathBuf> {
    dirs::home_dir().map(|h| h.join(".aura").join("hud-pos.json"))
}

fn remember_save(x: f64, y: f64) {
    if let Ok(mut g) = SAVED_POS.lock() {
        *g = Some((x, y));
    }
    if let Some(path) = pos_file() {
        if let Some(parent) = path.parent() {
            let _ = std::fs::create_dir_all(parent);
        }
        let _ = std::fs::write(path, format!("{{\"x\":{x},\"y\":{y}}}"));
    }
}

fn load_saved_pos() -> Option<(f64, f64)> {
    if let Some(p) = SAVED_POS.lock().ok().and_then(|g| *g) {
        return Some(p);
    }
    let txt = std::fs::read_to_string(pos_file()?).ok()?;
    let v: serde_json::Value = serde_json::from_str(&txt).ok()?;
    Some((v.get("x")?.as_f64()?, v.get("y")?.as_f64()?))
}

/// `lib.rs`'s `on_window_event` calls this on every HUD `Moved` event. macOS
/// reads the live Cocoa frame origin (points); other platforms fall back to
/// the physical outer position.
pub fn on_hud_moved(window: &tauri::Window<Wry>) {
    if let Some(webview) = window.app_handle().get_webview_window(HUD_LABEL) {
        if let Some((x, y)) = overlay::frame_origin(&webview) {
            remember_save(x, y);
            return;
        }
    }
    if let Ok(pos) = window.outer_position() {
        remember_save(pos.x as f64, pos.y as f64);
    }
}

// ── Native overlay (macOS) ──────────────────────────────────────────────
// Make the HUD behave like a true system overlay: float ABOVE full-screen
// apps (reachable mid-movie), follow the cursor across Spaces + monitors, and
// wear a frosted-glass NSVisualEffect background. Every entry point is a
// no-op off macOS so the rest of `hud.rs` stays platform-agnostic.
/// Give the MAIN app window a full-bleed frosted backing so the (transparent)
/// sidebar column reads as live desktop-blur glass. Content panes paint solid
/// backgrounds, so only the deliberately-translucent sidebar shows the frost.
/// Paired with `document.documentElement.classList.add('vibrancy')` on the
/// React side (main.tsx), which punches the ADE shell wrappers transparent.
/// Safe no-op off macOS.
pub fn apply_main_window_vibrancy(win: &WebviewWindow<Wry>) {
    overlay::apply_window_vibrancy(win);
}

mod overlay {
    use tauri::{WebviewWindow, Wry};

    #[cfg(target_os = "macos")]
    use cocoa::base::{id, nil};
    #[cfg(target_os = "macos")]
    use cocoa::foundation::{NSPoint, NSRect, NSSize, NSString};
    #[cfg(target_os = "macos")]
    use objc::declare::ClassDecl;
    #[cfg(target_os = "macos")]
    use objc::runtime::{Class, Object, Sel, BOOL, NO, YES};
    #[cfg(target_os = "macos")]
    use objc::{class, msg_send, sel, sel_impl};
    #[cfg(target_os = "macos")]
    use std::sync::atomic::{AtomicBool, AtomicI8, Ordering};
    #[cfg(target_os = "macos")]
    use std::sync::Once;
    #[cfg(target_os = "macos")]
    use std::time::Duration;

    // Realtime backdrop adaptation: a background thread re-samples while the HUD
    // is visible so the glass tracks a changing scene (a movie cuts dark→bright)
    // — not just at summon. `HUD_VISIBLE` gates the loop; `LAST_THEME` is the
    // applied light/dark decision (-2 uninit · -1 system · 0 dark · 1 light) used
    // to skip redundant work and to apply brightness HYSTERESIS so a backdrop
    // hovering near the threshold can't strobe.
    #[cfg(target_os = "macos")]
    static HUD_VISIBLE: AtomicBool = AtomicBool::new(false);
    #[cfg(target_os = "macos")]
    static LAST_THEME: AtomicI8 = AtomicI8::new(-2);
    #[cfg(target_os = "macos")]
    static ADAPT_THREAD: Once = Once::new();

    #[cfg(target_os = "macos")]
    extern "C" {
        fn object_setClass(obj: id, cls: *const Class) -> *const Class;
        // Screen Recording permission gates CGWindowListCreateImage on 10.15+:
        // without it the capture silently returns only the desktop wallpaper, so
        // the backdrop sample would be wrong. Preflight checks status without a
        // prompt; Request shows the one-time system prompt (the grant lands on a
        // later summon — it can't be awaited here).
        fn CGPreflightScreenCaptureAccess() -> bool;
        fn CGRequestScreenCaptureAccess() -> bool;
    }

    // NSWindowCollectionBehavior bits.
    #[cfg(target_os = "macos")]
    const CAN_JOIN_ALL_SPACES: u64 = 1 << 0;
    #[cfg(target_os = "macos")]
    const FULLSCREEN_AUXILIARY: u64 = 1 << 8;
    // NSWindowStyleMaskNonactivatingPanel — a panel that never activates the app
    // when shown/clicked, so summoning it can't pull the user out of a full-screen
    // Space. Only meaningful once the window is reclassed to an NSPanel.
    #[cfg(target_os = "macos")]
    const NONACTIVATING_PANEL: u64 = 1 << 7;
    // NSPopUpMenuWindowLevel — floats above a full-screen app's window.
    #[cfg(target_os = "macos")]
    const POPUP_MENU_WINDOW_LEVEL: i64 = 101;
    // The frost material is chosen per-backdrop by `adapt_to_backdrop` for the
    // glassiest read each way:
    //   • HUDWindow (13) over DARK scenes — the most translucent, see-through
    //     dark glass macOS has (it's what the system volume/brightness HUDs
    //     use). Locked dark, which is exactly what we want over a movie.
    //   • Popover (6) over BRIGHT scenes — an appearance-adaptive light frost
    //     (light-frosted under an Aqua appearance).
    // Setting the window appearance (Aqua/DarkAqua) alongside also flips the
    // WKWebView's `prefers-color-scheme`, so the CSS theme tracks in lockstep.
    // Behind-window blend, active state.
    #[cfg(target_os = "macos")]
    const MATERIAL_HUD_WINDOW: i64 = 13;
    /// NSVisualEffectMaterialSidebar — the light source-list frost macOS uses
    /// behind Finder/Mail sidebars. The right texture for a translucent app
    /// sidebar (vs the darker HUD glass).
    #[cfg(target_os = "macos")]
    const MATERIAL_SIDEBAR: i64 = 7;
    #[cfg(target_os = "macos")]
    const MATERIAL_POPOVER: i64 = 6;
    #[cfg(target_os = "macos")]
    const BLENDING_BEHIND_WINDOW: i64 = 0;
    #[cfg(target_os = "macos")]
    const STATE_ACTIVE: i64 = 1;
    // NSViewWidthSizable (2, track the window width) | NSViewMaxYMargin (32,
    // flexible TOP margin → pinned to the bottom edge with a fixed height).
    // `resize` owns the height explicitly; this just keeps the frost glued to
    // the bottom of the window between resizes.
    #[cfg(target_os = "macos")]
    const FROST_AUTORESIZE: u64 = 2 | 32;
    // Main-app-window frost must fill the WHOLE window and keep filling it as
    // the window grows — NSViewWidthSizable (2) | NSViewHeightSizable (16).
    // Unlike the HUD frost (bottom-pinned, height owned by `resize`), nothing
    // re-fits this one, so a fixed-height mask left it covering only the top of
    // the window (the "glass breaks after a point" bug). Width+height sizable
    // lets AppKit stretch it edge-to-edge automatically.
    #[cfg(target_os = "macos")]
    const WINDOW_FROST_FILL: u64 = 2 | 16;
    #[cfg(target_os = "macos")]
    const WINDOW_BELOW: i64 = -1;

    #[cfg(target_os = "macos")]
    fn ns(win: &WebviewWindow<Wry>) -> Option<id> {
        win.ns_window().ok().map(|p| p as id)
    }

    /// A borderless `NSWindow` from a regular app will NOT float over *another*
    /// app's full-screen Space, even with `CanJoinAllSpaces` — showing it just
    /// bounces the user back to the desktop Space. The fix the Spotlight/Alfred/
    /// Raycast-class apps use: make the overlay a NON-ACTIVATING `NSPanel`. A
    /// non-activating panel surfaces on whatever Space is showing (full-screen
    /// included) without activating the app. We can't ask Tauri for an NSPanel,
    /// so we reclass the live window to a tiny NSPanel subclass at runtime.
    #[cfg(target_os = "macos")]
    fn hud_panel_class() -> *const Class {
        static mut CLASS: *const Class = std::ptr::null();
        static INIT: Once = Once::new();
        INIT.call_once(|| {
            // canBecomeKeyWindow → YES so the bar can take keystrokes for the
            // quick-reply composer without the app ever activating.
            extern "C" fn yes(_: &Object, _: Sel) -> BOOL {
                YES
            }
            extern "C" fn no(_: &Object, _: Sel) -> BOOL {
                NO
            }
            let superclass = class!(NSPanel);
            let mut decl =
                ClassDecl::new("AuraHudPanel", superclass).expect("AuraHudPanel ClassDecl");
            unsafe {
                decl.add_method(
                    sel!(canBecomeKeyWindow),
                    yes as extern "C" fn(&Object, Sel) -> BOOL,
                );
                decl.add_method(
                    sel!(canBecomeMainWindow),
                    no as extern "C" fn(&Object, Sel) -> BOOL,
                );
                decl.add_method(
                    sel!(isFloatingPanel),
                    yes as extern "C" fn(&Object, Sel) -> BOOL,
                );
                CLASS = decl.register();
            }
        });
        unsafe { CLASS }
    }

    /// Reclass the window to the non-activating panel and flag it as such.
    /// Idempotent — calling twice is harmless (already the panel class).
    pub fn make_panel(win: &WebviewWindow<Wry>) {
        #[cfg(target_os = "macos")]
        if let Some(w) = ns(win) {
            unsafe {
                object_setClass(w, hud_panel_class());
                let mask: u64 = msg_send![w, styleMask];
                let _: () = msg_send![w, setStyleMask: mask | NONACTIVATING_PANEL];
            }
            eprintln!("[HUD] reclassed window to AuraHudPanel (non-activating)");
        }
        #[cfg(not(target_os = "macos"))]
        let _ = win;
    }

    /// Promote the window to a Spaces-joining, full-screen-auxiliary panel that
    /// sits above normal (and full-screen) windows. Cheap; re-asserted on every
    /// reveal in case the runtime resets the level.
    pub fn make_overlay(win: &WebviewWindow<Wry>) {
        #[cfg(target_os = "macos")]
        if let Some(w) = ns(win) {
            unsafe {
                let behavior = CAN_JOIN_ALL_SPACES | FULLSCREEN_AUXILIARY;
                let _: () = msg_send![w, setCollectionBehavior: behavior];
                let _: () = msg_send![w, setLevel: POPUP_MENU_WINDOW_LEVEL];
            }
        }
        #[cfg(not(target_os = "macos"))]
        let _ = win;
    }

    /// Sample the screen *behind* the HUD and pin the window to a light or dark
    /// appearance to match — so the frost AND the WKWebView's
    /// `prefers-color-scheme` (which drives the CSS theme, hud.css) both track
    /// the actual backdrop rather than the system Dark/Light setting: light
    /// glass over a light page, dark glass over a movie. Re-run on every reveal.
    /// Needs Screen Recording permission; if it's missing or the capture fails
    /// we clear the override and fall back to the system appearance.
    /// Mark the HUD shown/hidden. Showing kicks the realtime sampler thread
    /// (once) and forces an immediate adapt; hiding stops the sampling and clears
    /// the cached decision so the next summon re-applies from scratch.
    pub fn set_visible(win: &WebviewWindow<Wry>, visible: bool) {
        #[cfg(target_os = "macos")]
        {
            HUD_VISIBLE.store(visible, Ordering::Relaxed);
            if visible {
                ensure_adaptive_thread(win);
                LAST_THEME.store(-2, Ordering::Relaxed); // force a fresh apply
                adapt_to_backdrop(win);
            }
        }
        #[cfg(not(target_os = "macos"))]
        let _ = (win, visible);
    }

    /// Spawn (once) the background loop that re-samples the backdrop every ~600ms
    /// while the HUD is visible, so the glass tracks a changing scene in realtime
    /// rather than only at summon. The Cocoa work hops to the main thread.
    #[cfg(target_os = "macos")]
    fn ensure_adaptive_thread(win: &WebviewWindow<Wry>) {
        let win = win.clone();
        ADAPT_THREAD.call_once(move || {
            std::thread::spawn(move || loop {
                if HUD_VISIBLE.load(Ordering::Relaxed) {
                    let w = win.clone();
                    let _ = win.run_on_main_thread(move || adapt_to_backdrop(&w));
                    std::thread::sleep(Duration::from_millis(600));
                } else {
                    std::thread::sleep(Duration::from_millis(250));
                }
            });
        });
    }

    /// Sample the backdrop's brightness and, IF the light/dark verdict changed
    /// (with hysteresis), pin the window appearance + frost material to match.
    /// Must run on the main thread (it touches Cocoa); both callers honour that.
    pub fn adapt_to_backdrop(win: &WebviewWindow<Wry>) {
        #[cfg(target_os = "macos")]
        if let Some(w) = ns(win) {
            ensure_capture_access();
            let avg = unsafe { sample_backdrop_luminance(w) };
            let prev = LAST_THEME.load(Ordering::Relaxed);
            // Verdict with hysteresis: once light, hold light until clearly dark
            // (<111); once dark, hold dark until clearly bright (>145); from cold,
            // split at the midpoint. Keeps a near-threshold scene from strobing.
            let code: i8 = match avg {
                None => -1, // couldn't sample → follow the system
                Some(v) => {
                    let light = match prev {
                        1 => v > 111.0,
                        0 => v > 145.0,
                        _ => v > 128.0,
                    };
                    if light {
                        1
                    } else {
                        0
                    }
                }
            };
            if code != prev {
                unsafe { apply_theme(w, code) };
                LAST_THEME.store(code, Ordering::Relaxed);
                eprintln!("[HUD] adapt: avg={avg:?} → theme={code} (was {prev})");
            }
        }
        #[cfg(not(target_os = "macos"))]
        let _ = win;
    }

    /// The HUD's frost view (the `WINDOW_BELOW` NSVisualEffectView we inserted in
    /// `apply_vibrancy`), or `nil` if it isn't there yet.
    #[cfg(target_os = "macos")]
    unsafe fn frost_view(w: id) -> id {
        let content: id = msg_send![w, contentView];
        if content.is_null() {
            return nil;
        }
        let subviews: id = msg_send![content, subviews];
        let count: u64 = msg_send![subviews, count];
        let vev: *const Class = class!(NSVisualEffectView);
        let mut i: u64 = 0;
        while i < count {
            let v: id = msg_send![subviews, objectAtIndex: i];
            let is_vev: BOOL = msg_send![v, isKindOfClass: vev];
            if is_vev == YES {
                return v;
            }
            i += 1;
        }
        nil
    }

    /// One-time Screen Recording permission prompt. No-op once the user has
    /// answered (granted or denied); the grant takes effect on a later summon.
    #[cfg(target_os = "macos")]
    fn ensure_capture_access() {
        static REQ: Once = Once::new();
        REQ.call_once(|| unsafe {
            if !CGPreflightScreenCaptureAccess() {
                let _ = CGRequestScreenCaptureAccess();
            }
        });
    }

    /// Capture what's on screen below the HUD's rect and return whether the
    /// average luminance reads as "light". `None` when the capture is
    /// unavailable (no permission yet, off-screen, empty) so the caller can fall
    /// back to the system appearance.
    #[cfg(target_os = "macos")]
    unsafe fn sample_backdrop_luminance(w: id) -> Option<f64> {
        use core_graphics::display::CGDisplay;
        use core_graphics::geometry::{CGPoint, CGRect, CGSize};
        use core_graphics::window::{
            kCGWindowImageNominalResolution, kCGWindowListOptionOnScreenBelowWindow,
        };

        // HUD frame in Cocoa global points (bottom-left origin) + its window id.
        let frame: NSRect = msg_send![w, frame];
        let win_num: i64 = msg_send![w, windowNumber];
        // Flip to CoreGraphics global coords (top-left origin). The flip
        // reference is the PRIMARY display height (the screen at the global
        // origin / index 0).
        let screens: id = msg_send![class!(NSScreen), screens];
        if screens.is_null() {
            return None;
        }
        let primary: id = msg_send![screens, objectAtIndex: 0u64];
        if primary.is_null() {
            return None;
        }
        let pf: NSRect = msg_send![primary, frame];
        let cg_y = pf.size.height - (frame.origin.y + frame.size.height);
        let bounds = CGRect::new(
            &CGPoint::new(frame.origin.x, cg_y),
            &CGSize::new(frame.size.width, frame.size.height),
        );
        // Composite ONLY the windows below the HUD in that rect → never the HUD
        // itself. Nominal resolution keeps the image small (1× points) — plenty
        // for a brightness read and fast.
        let img = CGDisplay::screenshot(
            bounds,
            kCGWindowListOptionOnScreenBelowWindow,
            win_num as u32,
            kCGWindowImageNominalResolution,
        )?;
        let data = img.data();
        let bytes: &[u8] = data.bytes();
        let bpr = img.bytes_per_row();
        let bpp = (img.bits_per_pixel() / 8).max(1);
        let w_px = img.width();
        let h_px = img.height();
        if w_px == 0 || h_px == 0 || bytes.len() < bpr.saturating_mul(h_px) {
            return None;
        }
        // Average luminance over a sparse ~40×40 grid.
        let step_x = (w_px / 40).max(1);
        let step_y = (h_px / 40).max(1);
        let mut sum = 0.0f64;
        let mut n = 0.0f64;
        let mut y = 0;
        while y < h_px {
            let row = y * bpr;
            let mut x = 0;
            while x < w_px {
                let i = row + x * bpp;
                if i + 2 < bytes.len() {
                    // Window-server images are BGRA (little-endian ARGB).
                    let b = bytes[i] as f64;
                    let g = bytes[i + 1] as f64;
                    let r = bytes[i + 2] as f64;
                    sum += 0.299 * r + 0.587 * g + 0.114 * b;
                    n += 1.0;
                }
                x += step_x;
            }
            y += step_y;
        }
        if n == 0.0 {
            return None;
        }
        Some(sum / n) // average luminance, 0..255
    }

    /// Apply a theme verdict (`1` light · `0` dark · `-1` system) to the window:
    /// pin the appearance (Aqua/DarkAqua/nil) AND swap the frost to the glassiest
    /// material for it — the light popover frost over bright scenes, the
    /// translucent dark HUDWindow glass otherwise. Setting the appearance flips
    /// both the frost and the WKWebView's `prefers-color-scheme`, so the CSS
    /// theme follows for free.
    #[cfg(target_os = "macos")]
    unsafe fn apply_theme(w: id, code: i8) {
        match code {
            -1 => {
                let _: () = msg_send![w, setAppearance: nil];
            }
            _ => {
                let name = if code == 1 {
                    "NSAppearanceNameAqua"
                } else {
                    "NSAppearanceNameDarkAqua"
                };
                let ns_name: id = NSString::alloc(nil).init_str(name);
                let appearance: id = msg_send![class!(NSAppearance), appearanceNamed: ns_name];
                if !appearance.is_null() {
                    let _: () = msg_send![w, setAppearance: appearance];
                }
            }
        }
        let v = frost_view(w);
        if v != nil {
            let mat = if code == 1 {
                MATERIAL_POPOVER
            } else {
                MATERIAL_HUD_WINDOW
            };
            let _: () = msg_send![v, setMaterial: mat];
        }
    }

    /// Insert a rounded NSVisualEffectView behind the (transparent) web content
    /// so the pill reads as frosted glass over whatever's on screen. The frost is
    /// inset by `HUD_GUTTER` on the sides and bottom to sit exactly behind the
    /// CSS `.hud-pill`; the surrounding gutter stays clear so the pill's soft
    /// drop shadow can't clip. `resize` re-fits this frame as the HUD expands.
    pub fn apply_vibrancy(win: &WebviewWindow<Wry>, radius: f64, capsule_h: f64) {
        #[cfg(target_os = "macos")]
        if let Some(w) = ns(win) {
            unsafe {
                let content: id = msg_send![w, contentView];
                if content.is_null() {
                    return;
                }
                let bounds: NSRect = msg_send![content, bounds];
                // Bottom-anchored, inset capsule rect (Cocoa origin is
                // bottom-left) — matches the CSS `.hud-capsule` box exactly so
                // the native frost doesn't ghost out past it.
                let inset_x = super::HUD_CAPSULE_INSET_X;
                let inset_b = super::HUD_CAPSULE_INSET_BOTTOM;
                let capsule = NSRect::new(
                    NSPoint::new(inset_x, inset_b),
                    NSSize::new((bounds.size.width - 2.0 * inset_x).max(0.0), capsule_h),
                );
                let effect: id = msg_send![class!(NSVisualEffectView), alloc];
                let effect: id = msg_send![effect, initWithFrame: capsule];
                // Glassy dark default; `adapt_to_backdrop` overrides per summon.
                let _: () = msg_send![effect, setMaterial: MATERIAL_HUD_WINDOW];
                let _: () = msg_send![effect, setBlendingMode: BLENDING_BEHIND_WINDOW];
                let _: () = msg_send![effect, setState: STATE_ACTIVE];
                let _: () = msg_send![effect, setAutoresizingMask: FROST_AUTORESIZE];
                let _: () = msg_send![effect, setWantsLayer: true];
                let layer: id = msg_send![effect, layer];
                if !layer.is_null() {
                    let _: () = msg_send![layer, setCornerRadius: radius];
                    let _: () = msg_send![layer, setMasksToBounds: true];
                }
                let _: () = msg_send![content, addSubview: effect positioned: WINDOW_BELOW relativeTo: nil];
                let _: () = msg_send![w, setOpaque: false];
                let clear: id = msg_send![class!(NSColor), clearColor];
                let _: () = msg_send![w, setBackgroundColor: clear];
                // No native window shadow: it traces the silhouette of EVERY
                // opaque island (both floating chips + the capsule) and joins
                // them into one ugly outline blob. Each element carries its own
                // CSS drop shadow instead, so they read as separate floaters.
                let _: () = msg_send![w, setHasShadow: false];
            }
        }
        #[cfg(not(target_os = "macos"))]
        let _ = (win, radius, capsule_h);
    }

    /// Full-window frost for the MAIN app window: a single NSVisualEffectView
    /// sized to the content view and autoresized to fill, inserted BELOW the
    /// web content. Any transparent region of the page (the sidebar column)
    /// then reads as live desktop-blur; opaque content islands cover the rest.
    /// Uses the Sidebar material — the light source-list frost macOS itself
    /// uses behind Finder/Mail sidebars.
    pub fn apply_window_vibrancy(win: &WebviewWindow<Wry>) {
        #[cfg(target_os = "macos")]
        if let Some(w) = ns(win) {
            unsafe {
                let content: id = msg_send![w, contentView];
                if content.is_null() {
                    return;
                }
                let bounds: NSRect = msg_send![content, bounds];
                let effect: id = msg_send![class!(NSVisualEffectView), alloc];
                let effect: id = msg_send![effect, initWithFrame: bounds];
                let _: () = msg_send![effect, setMaterial: MATERIAL_SIDEBAR];
                let _: () = msg_send![effect, setBlendingMode: BLENDING_BEHIND_WINDOW];
                let _: () = msg_send![effect, setState: STATE_ACTIVE];
                let _: () = msg_send![effect, setAutoresizingMask: WINDOW_FROST_FILL];
                let _: () =
                    msg_send![content, addSubview: effect positioned: WINDOW_BELOW relativeTo: nil];
                let _: () = msg_send![w, setOpaque: false];
                let clear: id = msg_send![class!(NSColor), clearColor];
                let _: () = msg_send![w, setBackgroundColor: clear];
            }
        }
        #[cfg(not(target_os = "macos"))]
        let _ = win;
    }

    /// Re-fit (and show/hide) the frost view for a mode. Capsule = the
    /// bottom-anchored inset pill rect (height `capsule_h`); Sidebar / Minimal /
    /// Ambient hide the frost entirely (Sidebar is an opaque light "paper" panel
    /// painted in CSS; Minimal/Ambient are the chromeless text-over-screen looks).
    #[cfg(target_os = "macos")]
    unsafe fn fit_frost_for(w: id, mode: super::Mode, win_w: f64, win_h: f64, capsule_h: f64) {
        let v = frost_view(w);
        if v == nil {
            return;
        }
        let _ = win_h; // only Capsule sizes by height (capsule_h); others hide.
        match mode {
            // Sidebar + Minimal + Ambient paint their look entirely in CSS — a
            // solid panel, NOT frosted glass (glass reads badly at panel size).
            // Hide the vibrancy view so no blur bleeds behind the opaque panel.
            super::Mode::Sidebar | super::Mode::Minimal | super::Mode::Ambient => {
                let _: () = msg_send![v, setHidden: YES];
            }
            super::Mode::Capsule => {
                let _: () = msg_send![v, setHidden: NO];
                let inset_x = super::HUD_CAPSULE_INSET_X;
                let inset_b = super::HUD_CAPSULE_INSET_BOTTOM;
                let rect = NSRect::new(
                    NSPoint::new(inset_x, inset_b),
                    NSSize::new((win_w - 2.0 * inset_x).max(0.0), capsule_h),
                );
                let _: () = msg_send![v, setFrame: rect];
            }
        }
    }

    /// Grow/shrink the HUD window as the React side expands. `win_h` is the
    /// full window height; `capsule_h` is the frosted pill height (capsule mode).
    /// `req_width` lets the sidebar size its window to the measured content (a
    /// slim FAB when collapsed, the full panel when expanded); capsule/minimal
    /// ignore it and keep the wide bar. Capsule/minimal keep their bottom-left
    /// origin so the window grows **upward** (the bottom edge stays pinned); the
    /// **sidebar** instead keeps its right edge + vertical centre as the content
    /// size changes. The frost is re-fitted per mode (or hidden, in minimal).
    ///
    /// Cocoa must be touched on the main thread; `#[tauri::command]`s run off
    /// it, so this hops over via `run_on_main_thread`.
    pub fn resize(win: &WebviewWindow<Wry>, win_h: f64, capsule_h: f64, req_width: Option<f64>) {
        #[cfg(target_os = "macos")]
        {
            // Clone for the closure; call `run_on_main_thread` on the borrowed
            // param so we don't move and borrow the same handle at once.
            let win_main = win.clone();
            let _ = win.run_on_main_thread(move || {
                if let Some(w) = ns(&win_main) {
                    unsafe {
                        let mode = super::current_mode();
                        let mut frame: NSRect = msg_send![w, frame];
                        match mode {
                            super::Mode::Sidebar => {
                                // Width tracks the measured content (FAB ↔ panel),
                                // falling back to the panel width.
                                let width = req_width
                                    .unwrap_or_else(|| super::mode_win_width(mode));
                                // The expanded panel re-docks to the right edge and
                                // re-centres vertically. The collapsed FAB floats —
                                // keep its current origin so a dragged position
                                // sticks (a content tick mustn't yank it back to the
                                // edge). Bottom-left pin: the small square grows/
                                // shrinks in place.
                                if width >= super::HUD_SIDEBAR_FAB_MAX_W {
                                    let screen: id = msg_send![w, screen];
                                    if screen != nil {
                                        let vf: NSRect = msg_send![screen, visibleFrame];
                                        frame.origin.x = vf.origin.x + vf.size.width
                                            - width
                                            - super::HUD_SIDEBAR_MARGIN;
                                        frame.origin.y =
                                            vf.origin.y + (vf.size.height - win_h) / 2.0;
                                    }
                                }
                                frame.size.width = width;
                                frame.size.height = win_h;
                            }
                            _ => {
                                // Keep origin (bottom-left) → the window grows up.
                                frame.size.height = win_h;
                            }
                        }
                        let _: () = msg_send![w, setFrame: frame display: YES];
                        let content: id = msg_send![w, contentView];
                        if content.is_null() {
                            return;
                        }
                        let cb: NSRect = msg_send![content, bounds];
                        fit_frost_for(w, mode, cb.size.width, cb.size.height, capsule_h);
                    }
                }
            });
        }
        #[cfg(not(target_os = "macos"))]
        let _ = (win, win_h, capsule_h, req_width);
    }

    /// Apply a freshly-chosen presentation mode to the live window: re-anchor +
    /// re-size to the mode's width and re-fit/show-or-hide the frost. Uses the
    /// current frame height; the imminent React `resize` (the CSS reflow fires
    /// the HUD's `ResizeObserver`) refines the height + pill frost right after.
    pub fn apply_mode(win: &WebviewWindow<Wry>) {
        #[cfg(target_os = "macos")]
        {
            let win_main = win.clone();
            let _ = win.run_on_main_thread(move || {
                if let Some(w) = ns(&win_main) {
                    unsafe {
                        let mode = super::current_mode();
                        let width = super::mode_win_width(mode);
                        let mut frame: NSRect = msg_send![w, frame];
                        match mode {
                            super::Mode::Sidebar => {
                                let screen: id = msg_send![w, screen];
                                if screen != nil {
                                    let vf: NSRect = msg_send![screen, visibleFrame];
                                    frame.origin.x = vf.origin.x + vf.size.width
                                        - width
                                        - super::HUD_SIDEBAR_MARGIN;
                                    frame.origin.y = vf.origin.y
                                        + (vf.size.height - frame.size.height) / 2.0;
                                }
                            }
                            // Ambient is bottom-centred — re-centre horizontally
                            // since it's wider than the bar it switched from.
                            super::Mode::Ambient => {
                                let screen: id = msg_send![w, screen];
                                if screen != nil {
                                    let vf: NSRect = msg_send![screen, visibleFrame];
                                    frame.origin.x =
                                        vf.origin.x + (vf.size.width - width) / 2.0;
                                    frame.origin.y = vf.origin.y + super::BOTTOM_MARGIN;
                                }
                            }
                            // Capsule/minimal: re-centre horizontally so returning
                            // from the wider ambient (or sidebar) doesn't leave the
                            // bar shifted (a fresh reveal restores any saved drag).
                            _ => {
                                let screen: id = msg_send![w, screen];
                                if screen != nil {
                                    let vf: NSRect = msg_send![screen, visibleFrame];
                                    frame.origin.x =
                                        vf.origin.x + (vf.size.width - width) / 2.0;
                                }
                            }
                        }
                        frame.size.width = width;
                        let _: () = msg_send![w, setFrame: frame display: YES];
                        let content: id = msg_send![w, contentView];
                        if content.is_null() {
                            return;
                        }
                        let cb: NSRect = msg_send![content, bounds];
                        // Approximate capsule height; the follow-up `resize` from
                        // the CSS reflow re-fits with the measured pill height.
                        let capsule_h = (cb.size.height - 2.0 * super::HUD_GUTTER).max(0.0);
                        fit_frost_for(w, mode, cb.size.width, cb.size.height, capsule_h);
                    }
                }
            });
        }
        #[cfg(not(target_os = "macos"))]
        let _ = win;
    }

    /// Uniform window opacity (the Settings tuning knob). One `setAlphaValue`
    /// on the main thread; clamped so the HUD never becomes invisible/unclickable.
    pub fn set_opacity(win: &WebviewWindow<Wry>, opacity: f64) {
        #[cfg(target_os = "macos")]
        {
            let win_main = win.clone();
            let a = opacity.clamp(0.2, 1.0);
            let _ = win.run_on_main_thread(move || {
                if let Some(w) = ns(&win_main) {
                    unsafe {
                        let _: () = msg_send![w, setAlphaValue: a];
                    }
                }
            });
        }
        #[cfg(not(target_os = "macos"))]
        let _ = (win, opacity);
    }

    /// Place on the cursor's monitor (bottom-centre), restoring `saved` only
    /// when it lands on that monitor. Returns `false` off macOS so the caller
    /// falls back to its own positioning.
    pub fn place(win: &WebviewWindow<Wry>, saved: Option<(f64, f64)>, margin: f64) -> bool {
        #[cfg(target_os = "macos")]
        {
            if let Some(w) = ns(win) {
                unsafe {
                    let screen = cursor_screen();
                    if screen.is_null() {
                        eprintln!("[HUD] place: cursor_screen is null");
                        return false;
                    }
                    let vf: NSRect = msg_send![screen, visibleFrame];
                    let frame: NSRect = msg_send![w, frame];
                    let mode = super::current_mode();
                    // Mode owns the width: sidebar is the narrow docked panel,
                    // capsule/minimal keep the wide bar.
                    let width = super::mode_win_width(mode);
                    let origin = match mode {
                        // Sidebar: pinned to the right edge, vertically centred.
                        super::Mode::Sidebar => NSPoint::new(
                            vf.origin.x + vf.size.width - width - super::HUD_SIDEBAR_MARGIN,
                            vf.origin.y + (vf.size.height - frame.size.height) / 2.0,
                        ),
                        // Ambient: always bottom-centred (an immersive surface
                        // isn't a draggable bar — ignore any remembered drag).
                        super::Mode::Ambient => NSPoint::new(
                            vf.origin.x + (vf.size.width - width) / 2.0,
                            vf.origin.y + margin,
                        ),
                        // Capsule/minimal: remembered drag if it lands here, else
                        // bottom-centre.
                        _ => match saved {
                            Some((x, y)) if within(vf, x, y) => NSPoint::new(x, y),
                            _ => NSPoint::new(
                                vf.origin.x + (vf.size.width - width) / 2.0,
                                vf.origin.y + margin,
                            ),
                        },
                    };
                    eprintln!(
                        "[HUD] place: visibleFrame=({:.0},{:.0} {:.0}x{:.0}) origin=({:.0},{:.0}) w={:.0}",
                        vf.origin.x, vf.origin.y, vf.size.width, vf.size.height, origin.x, origin.y, width
                    );
                    // Set the full frame (origin + the mode's width); height is
                    // refined by the React-driven `resize` once the pill measures.
                    let new_frame = NSRect::new(origin, NSSize::new(width, frame.size.height));
                    let _: () = msg_send![w, setFrame: new_frame display: YES];
                }
                return true;
            }
            eprintln!("[HUD] place: ns_window unavailable");
            false
        }
        #[cfg(not(target_os = "macos"))]
        {
            let _ = (win, saved, margin);
            false
        }
    }

    /// Order the window onto the CURRENT Space and to the front WITHOUT
    /// activating the app. Activation (what `set_focus` does) makes macOS
    /// switch the user back to the desktop Space to show the window there;
    /// `orderFrontRegardless` instead lets a CanJoinAllSpaces window surface
    /// right on whatever Space is showing — including another app's
    /// full-screen Space (movie / fullscreen Chrome).
    pub fn order_front(win: &WebviewWindow<Wry>) {
        #[cfg(target_os = "macos")]
        if let Some(w) = ns(win) {
            unsafe {
                let _: () = msg_send![w, orderFrontRegardless];
                // Safe for a non-activating panel: takes keyboard focus for the
                // composer WITHOUT activating the app (so no Space switch).
                let _: () = msg_send![w, makeKeyWindow];
            }
        }
        #[cfg(not(target_os = "macos"))]
        let _ = win;
    }

    /// Live window origin in Cocoa points (for persistence). `None` off macOS.
    pub fn frame_origin(win: &WebviewWindow<Wry>) -> Option<(f64, f64)> {
        #[cfg(target_os = "macos")]
        {
            if let Some(w) = ns(win) {
                unsafe {
                    let frame: NSRect = msg_send![w, frame];
                    return Some((frame.origin.x, frame.origin.y));
                }
            }
            None
        }
        #[cfg(not(target_os = "macos"))]
        {
            let _ = win;
            None
        }
    }

    #[cfg(target_os = "macos")]
    fn within(frame: NSRect, x: f64, y: f64) -> bool {
        x >= frame.origin.x
            && x <= frame.origin.x + frame.size.width
            && y >= frame.origin.y
            && y <= frame.origin.y + frame.size.height
    }

    /// The NSScreen whose frame contains the mouse, else the main screen.
    #[cfg(target_os = "macos")]
    unsafe fn cursor_screen() -> id {
        let mouse: NSPoint = msg_send![class!(NSEvent), mouseLocation];
        let screens: id = msg_send![class!(NSScreen), screens];
        let count: u64 = msg_send![screens, count];
        let mut i: u64 = 0;
        while i < count {
            let scr: id = msg_send![screens, objectAtIndex: i];
            let f: NSRect = msg_send![scr, frame];
            if within(f, mouse.x, mouse.y) {
                return scr;
            }
            i += 1;
        }
        msg_send![class!(NSScreen), mainScreen]
    }
}

// ── Global shortcut ────────────────────────────────────────────────────
// Registered from Rust (not JS) so ⌘⇧A works even while the main window is
// hidden in the menu bar. Registering here also means the global-shortcut
// plugin needs no JS-side capability entry.

use tauri_plugin_global_shortcut::{Code, GlobalShortcutExt, Modifiers, Shortcut, ShortcutState};

/// Default summon chord: ⌘⇧A ("A for Aura"). Rebindable later from Settings.
pub fn register_shortcut(app: &tauri::App<Wry>) {
    let accel = Shortcut::new(Some(Modifiers::SUPER | Modifiers::SHIFT), Code::KeyA);
    let for_handler = accel;
    let plugin = tauri_plugin_global_shortcut::Builder::new()
        .with_handler(move |app, shortcut, event| {
            eprintln!("[HUD] shortcut handler fired: state={:?}", event.state());
            if shortcut == &for_handler && event.state() == ShortcutState::Pressed {
                toggle(app);
            }
        })
        .build();
    if let Err(e) = app.handle().plugin(plugin) {
        eprintln!("[HUD] global-shortcut plugin failed to init: {e}");
        return;
    }
    match app.global_shortcut().register(accel) {
        Ok(()) => eprintln!("[HUD] ⌘⇧A registered"),
        Err(e) => eprintln!("[HUD] failed to register ⌘⇧A: {e}"),
    }
}

// ── IPC commands (used by the HUD's React side) ─────────────────────────

#[tauri::command]
pub fn hud_toggle(app: AppHandle<Wry>) {
    toggle(&app);
}

#[tauri::command]
pub fn hud_show(app: AppHandle<Wry>) {
    show(&app);
}

/// Esc / "collapse" in the HUD calls this instead of `getCurrentWindow().hide()`
/// so we don't have to grant the JS `core:window:allow-hide` permission.
#[tauri::command]
pub fn hud_hide(app: AppHandle<Wry>) {
    hide(&app);
}

/// Grow/shrink the HUD as the React side expands — hovering/focusing the pill
/// reveals the exchange + composer, opening the workspace dropdown adds headroom
/// above. `height` is the full window height (measured pill + gutters + menu
/// headroom); `capsule` is the frosted pill height the frost is re-fitted to.
#[tauri::command]
pub fn hud_resize(app: AppHandle<Wry>, height: f64, capsule: f64, width: Option<f64>) {
    if let Some(win) = app.get_webview_window(HUD_LABEL) {
        overlay::resize(&win, height, capsule, width);
    }
}

/// Switch the HUD's presentation shape live ("capsule" · "sidebar" · "minimal").
/// Stores the mode (so a later summon places correctly) and re-anchors/re-frosts
/// the window now if it's already up. The HUD's React side drives the matching
/// CSS via `document.documentElement.dataset.hudMode`.
#[tauri::command]
pub fn hud_set_mode(app: AppHandle<Wry>, mode: String) {
    store_mode(mode_from_str(&mode));
    if let Some(win) = app.get_webview_window(HUD_LABEL) {
        overlay::apply_mode(&win);
    }
}

/// Set the HUD window's uniform opacity (Settings tuning knob, 0.2–1.0).
#[tauri::command]
pub fn hud_set_opacity(app: AppHandle<Wry>, opacity: f64) {
    if let Some(win) = app.get_webview_window(HUD_LABEL) {
        overlay::set_opacity(&win, opacity);
    }
}

/// Flip the persistent HUD master switch live from Settings. Stores the flag so
/// ⌘⇧A, the tray, and programmatic summons honor it immediately, and hides the
/// HUD now if it's on screen when turned off. Turning it back on does NOT force
/// the HUD up — it stays summon-only; the user brings it back with ⌘⇧A.
#[tauri::command]
pub fn hud_set_enabled(app: AppHandle<Wry>, enabled: bool) {
    HUD_ENABLED.store(enabled, Ordering::Relaxed);
    if !enabled {
        hide(&app);
    }
}

/// One worktree copy inside a project, as the workspace menu renders it.
#[derive(serde::Deserialize)]
pub struct HudMenuInstance {
    label: String,
    /// Absolute root path — also the menu-item id (`hudws:<root>`).
    root: String,
    /// Whether this is the instance the HUD is currently pointed at.
    checked: bool,
    /// Live agent count, surfaced as a trailing "N running" on the row.
    running: u32,
}

/// One distinct project in the workspace menu.
#[derive(serde::Deserialize)]
pub struct HudMenuProject {
    label: String,
    /// The active project is listed inline; others nest in a submenu.
    active: bool,
    running: u32,
    instances: Vec<HudMenuInstance>,
}

/// Pop the project / instance switcher as a **native system menu** rather than
/// an in-webview dropdown. A Radix menu is clipped to the (tiny) HUD window and
/// can't extend past it; an NSMenu floats over fullscreen, self-positions, and
/// flips up near the screen edge for free. The React side owns the project model
/// (the `git worktree list` data) and hands it down; `x`/`y` are the trigger's
/// top-left in window coords. Selecting a row routes back through the same
/// `hud:select-project` event the old dropdown used (see `menu::install_handler`).
#[tauri::command]
pub fn hud_workspace_menu(app: AppHandle<Wry>, projects: Vec<HudMenuProject>, x: f64, y: f64) {
    let Some(win) = app.get_webview_window(HUD_LABEL) else {
        return;
    };
    // NSMenu construction + popup must run on the main thread; commands run off
    // it, so hop over and build there.
    let win_main = win.clone();
    let _ = win.run_on_main_thread(move || {
        if let Err(e) = build_workspace_menu(&win_main, &projects, x, y) {
            eprintln!("[HUD] workspace menu failed: {e}");
        }
    });
}

#[cfg(target_os = "macos")]
fn build_workspace_menu(
    win: &WebviewWindow<Wry>,
    projects: &[HudMenuProject],
    x: f64,
    y: f64,
) -> tauri::Result<()> {
    use tauri::menu::{
        CheckMenuItemBuilder, ContextMenu, MenuBuilder, MenuItemBuilder, SubmenuBuilder,
    };

    // "<label>    N running" — the live count rides on the row text since a
    // native menu has no room for a colored badge.
    let with_count = |label: &str, n: u32| -> String {
        if n > 0 {
            format!("{label}    {n} running")
        } else {
            label.to_string()
        }
    };

    let mut menu = MenuBuilder::new(win);
    for (i, p) in projects.iter().enumerate() {
        if i > 0 {
            menu = menu.separator();
        }
        if p.active {
            // Active project: a disabled header, then its instances inline with a
            // checkmark on the one the HUD is pointed at.
            let header = MenuItemBuilder::with_id(format!("hudhdr:{i}"), with_count(&p.label, p.running))
                .enabled(false)
                .build(win)?;
            menu = menu.item(&header);
            for inst in &p.instances {
                let item = CheckMenuItemBuilder::with_id(
                    format!("hudws:{}", inst.root),
                    with_count(&inst.label, inst.running),
                )
                .checked(inst.checked)
                .build(win)?;
                menu = menu.item(&item);
            }
        } else {
            // Other projects nest their instances in a submenu.
            let mut sub = SubmenuBuilder::new(win, with_count(&p.label, p.running));
            for inst in &p.instances {
                let item = CheckMenuItemBuilder::with_id(
                    format!("hudws:{}", inst.root),
                    with_count(&inst.label, inst.running),
                )
                .checked(inst.checked)
                .build(win)?;
                sub = sub.item(&item);
            }
            menu = menu.item(&sub.build()?);
        }
    }
    let menu = menu.build()?;
    menu.popup_at(
        win.as_ref().window(),
        tauri::Position::Logical(LogicalPosition::new(x, y)),
    )
}

#[cfg(not(target_os = "macos"))]
fn build_workspace_menu(
    _win: &WebviewWindow<Wry>,
    _projects: &[HudMenuProject],
    _x: f64,
    _y: f64,
) -> tauri::Result<()> {
    Ok(())
}

/// One agent/session in the active project's fleet, as the agents menu renders it.
#[derive(serde::Deserialize)]
pub struct HudMenuAgent {
    /// Roster key — the menu-item id (`hudagent:<key>`) and the value echoed back.
    key: String,
    label: String,
    /// HUD status kind: idle / thinking / running / awaiting_input / done / error.
    status: String,
    /// True for the entry the glance is currently showing.
    checked: bool,
}

/// Pop the fleet switcher as a **native system menu** — agents grouped by what
/// they need ("Needs you" first), each row clickable to point the glance at it.
/// Same reasons as `hud_workspace_menu`: an NSMenu floats over fullscreen and
/// isn't clipped to the tiny HUD window. Selecting a row routes back through the
/// `hud:focus-agent` event (see `menu::install_handler`).
#[tauri::command]
pub fn hud_agents_menu(app: AppHandle<Wry>, agents: Vec<HudMenuAgent>, x: f64, y: f64) {
    let Some(win) = app.get_webview_window(HUD_LABEL) else {
        return;
    };
    let win_main = win.clone();
    let _ = win.run_on_main_thread(move || {
        if let Err(e) = build_agents_menu(&win_main, &agents, x, y) {
            eprintln!("[HUD] agents menu failed: {e}");
        }
    });
}

#[cfg(target_os = "macos")]
fn build_agents_menu(
    win: &WebviewWindow<Wry>,
    agents: &[HudMenuAgent],
    x: f64,
    y: f64,
) -> tauri::Result<()> {
    use tauri::menu::{CheckMenuItemBuilder, ContextMenu, MenuBuilder, MenuItemBuilder};

    // Grouped by what each agent needs from you — "Needs you" leads so the row
    // you most likely want is at the top.
    let order: [(&str, &[&str]); 5] = [
        ("Needs you", &["awaiting_input"]),
        ("Errored", &["error"]),
        ("Working", &["thinking", "running"]),
        ("Done", &["done"]),
        ("Idle", &["idle"]),
    ];

    let mut menu = MenuBuilder::new(win);
    let mut first = true;
    for (gi, &(glabel, kinds)) in order.iter().enumerate() {
        let members: Vec<&HudMenuAgent> = agents
            .iter()
            .filter(|a| kinds.contains(&a.status.as_str()))
            .collect();
        if members.is_empty() {
            continue;
        }
        if !first {
            menu = menu.separator();
        }
        first = false;
        let header =
            MenuItemBuilder::with_id(format!("hudagrp:{gi}"), format!("{glabel}    {}", members.len()))
                .enabled(false)
                .build(win)?;
        menu = menu.item(&header);
        for a in members {
            let item = CheckMenuItemBuilder::with_id(format!("hudagent:{}", a.key), &a.label)
                .checked(a.checked)
                .build(win)?;
            menu = menu.item(&item);
        }
    }
    let menu = menu.build()?;
    menu.popup_at(
        win.as_ref().window(),
        tauri::Position::Logical(LogicalPosition::new(x, y)),
    )
}

#[cfg(not(target_os = "macos"))]
fn build_agents_menu(
    _win: &WebviewWindow<Wry>,
    _agents: &[HudMenuAgent],
    _x: f64,
    _y: f64,
) -> tauri::Result<()> {
    Ok(())
}

/// One row in a generic HUD composer dropdown (mode / effort / approvals /
/// brain·model). `id` is the value echoed back; `children` give one level of
/// submenu (used by the brain picker to nest each engine's models).
#[derive(serde::Deserialize)]
pub struct HudMenuRow {
    /// The value routed back via `hud:menu-pick { kind, id }`. Empty → a
    /// non-selectable header/separator label.
    id: String,
    label: String,
    #[serde(default)]
    checked: bool,
    #[serde(default)]
    disabled: bool,
    #[serde(default)]
    children: Vec<HudMenuRow>,
}

/// Pop a **native system menu** for one of the HUD composer's enum pickers
/// (`kind` = "mode" | "effort" | "approval" | "brain" …). Same rationale as the
/// workspace/agents menus: an NSMenu floats over fullscreen and isn't clipped to
/// the tiny HUD window — the right surface for a click-dropdown the composer
/// chips need. A pick routes back through `hud:menu-pick` (see
/// `menu::install_handler`), carrying both the `kind` and the chosen `id` so the
/// HUD knows which chip changed.
#[tauri::command]
pub fn hud_menu(app: AppHandle<Wry>, kind: String, items: Vec<HudMenuRow>, x: f64, y: f64) {
    let Some(win) = app.get_webview_window(HUD_LABEL) else {
        return;
    };
    let win_main = win.clone();
    let _ = win.run_on_main_thread(move || {
        if let Err(e) = build_generic_menu(&win_main, &kind, &items, x, y) {
            eprintln!("[HUD] {kind} menu failed: {e}");
        }
    });
}

/// The `\x1f` (unit separator) joins `kind` and `id` in a menu-item id so the
/// router can split them apart unambiguously — neither a picker kind nor any of
/// the ids we mint (effort tokens, brain ids, model ids) contains it, unlike
/// `:` which appears in some model ids.
#[cfg(target_os = "macos")]
const HUD_MENU_SEP: char = '\u{1f}';

#[cfg(target_os = "macos")]
fn build_generic_menu(
    win: &WebviewWindow<Wry>,
    kind: &str,
    items: &[HudMenuRow],
    x: f64,
    y: f64,
) -> tauri::Result<()> {
    use tauri::menu::{CheckMenuItemBuilder, ContextMenu, MenuBuilder, MenuItemBuilder, SubmenuBuilder};

    // A row's full menu-item id: `hudmenu:<kind>\x1f<id>`. Headers/separators
    // (empty id) get a stable disabled id so two of them never collide.
    let row_id = |id: &str| format!("hudmenu:{kind}{HUD_MENU_SEP}{id}");

    let mut menu = MenuBuilder::new(win);
    for (i, row) in items.iter().enumerate() {
        if row.id.is_empty() && row.children.is_empty() {
            // A bare label → a disabled section header.
            let header = MenuItemBuilder::with_id(format!("hudmenuhdr:{kind}:{i}"), &row.label)
                .enabled(false)
                .build(win)?;
            menu = menu.item(&header);
            continue;
        }
        if !row.children.is_empty() {
            // Nested engine → its models as a submenu.
            let mut sub = SubmenuBuilder::new(win, &row.label);
            for child in &row.children {
                let item = CheckMenuItemBuilder::with_id(row_id(&child.id), &child.label)
                    .checked(child.checked)
                    .enabled(!child.disabled)
                    .build(win)?;
                sub = sub.item(&item);
            }
            menu = menu.item(&sub.build()?);
            continue;
        }
        let item = CheckMenuItemBuilder::with_id(row_id(&row.id), &row.label)
            .checked(row.checked)
            .enabled(!row.disabled)
            .build(win)?;
        menu = menu.item(&item);
    }
    let menu = menu.build()?;
    menu.popup_at(
        win.as_ref().window(),
        tauri::Position::Logical(LogicalPosition::new(x, y)),
    )
}

#[cfg(not(target_os = "macos"))]
fn build_generic_menu(
    _win: &WebviewWindow<Wry>,
    _kind: &str,
    _items: &[HudMenuRow],
    _x: f64,
    _y: f64,
) -> tauri::Result<()> {
    Ok(())
}
