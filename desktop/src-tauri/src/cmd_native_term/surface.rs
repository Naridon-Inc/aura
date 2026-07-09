//! Per-OS surface attach — the ONLY platform-specific code in the native
//! terminal. Everything else (PTY, grid model, wgpu renderer) is shared.
//!
//! The job: create a small native child view over the transparent DOM "hole"
//! the React side leaves for the terminal, back it with a GPU layer, and build
//! a `wgpu::Surface` from its raw handle. This mirrors how the in-app browser
//! (`cmd_browser`) drops a native child webview over a hole — same choreography
//! (`getBoundingClientRect` → `set_bounds`), but the child is a GPU surface
//! instead of a WebKit view.
//!
//! View creation and frame changes MUST happen on the UI thread (AppKit/GTK
//! both require it), so the caller wraps every entry point here in
//! `run_on_main_thread`. The returned `wgpu::Surface` is `Send`, so it moves to
//! the per-terminal render thread; only the opaque view handle stays behind for
//! main-thread reposition/teardown.
//!
//! Platforms:
//! * macOS — `NSView` + `CAMetalLayer` child of the window `contentView`
//!   (verified building on this toolchain).
//! * Linux — `GtkDrawingArea` realized into an X11 child window (X11 only;
//!   Wayland returns a clear unsupported error). The shared engine above it is
//!   identical to macOS.
//! * Windows — not a release target yet; returns a clear unsupported error so
//!   the frontend keeps the classic terminal.

/// A logical-pixel rectangle (top-left origin, matching the DOM hole).
#[derive(Clone, Copy, Debug)]
pub struct RectPx {
    pub x: f64,
    pub y: f64,
    pub w: f64,
    pub h: f64,
}

/// A live native child surface. `surface` moves to the render thread; `view` is
/// the opaque native pointer (as `usize`) used only on the UI thread to
/// reposition or destroy the child view.
pub struct AttachedSurface {
    pub surface: wgpu::Surface<'static>,
    pub view: usize,
}

// ---------------------------------------------------------------------------
// macOS
// ---------------------------------------------------------------------------
#[cfg(target_os = "macos")]
pub fn attach(
    instance: &wgpu::Instance,
    window: &tauri::Window,
    rect: RectPx,
    scale: f64,
) -> Result<AttachedSurface, String> {
    use std::ptr::NonNull;

    use cocoa::base::{id, YES};
    use objc::{class, msg_send, sel, sel_impl};
    use raw_window_handle::{
        AppKitDisplayHandle, AppKitWindowHandle, RawDisplayHandle, RawWindowHandle,
    };

    let ns_window = window.ns_window().map_err(|e| e.to_string())? as id;

    unsafe {
        let content: id = msg_send![ns_window, contentView];
        if content.is_null() {
            return Err("main window has no contentView".into());
        }

        // A Metal-backed, layer-hosting NSView. addSubview puts it above the
        // WebKit view (last sibling paints on top), so it composites over the
        // webview at the hole rect.
        let layer: id = msg_send![class!(CAMetalLayer), layer];
        let _: () = msg_send![layer, setContentsScale: scale];

        let frame = ns_frame(content, rect);
        if std::env::var("AURA_TERM_DEBUG").is_ok() {
            use cocoa::foundation::NSRect;
            let cb: NSRect = msg_send![content, bounds];
            eprintln!(
                "[native-term] open: content.h={:.0} rect=({:.0},{:.0} {:.0}x{:.0}) -> frame.origin=({:.0},{:.0})",
                cb.size.height, rect.x, rect.y, rect.w, rect.h, frame.origin.x, frame.origin.y,
            );
        }
        let view: id = msg_send![class!(NSView), alloc];
        let view: id = msg_send![view, initWithFrame: frame];
        let _: () = msg_send![view, setWantsLayer: YES];
        let _: () = msg_send![view, setLayer: layer];
        // Don't let AppKit resize our frame from under us; we drive it via
        // set_frame on every reconcile.
        let _: () = msg_send![view, setAutoresizingMask: 0u64];
        let _: () = msg_send![content, addSubview: view];

        let handle = AppKitWindowHandle::new(
            NonNull::new(view as *mut std::ffi::c_void)
                .ok_or_else(|| "null NSView".to_string())?,
        );
        let surface = instance
            .create_surface_unsafe(wgpu::SurfaceTargetUnsafe::RawHandle {
                raw_display_handle: RawDisplayHandle::AppKit(AppKitDisplayHandle::new()),
                raw_window_handle: RawWindowHandle::AppKit(handle),
            })
            .map_err(|e| e.to_string())?;

        Ok(AttachedSurface {
            surface,
            view: view as usize,
        })
    }
}

/// Reposition/resize the macOS child view (UI thread). Flips Y from the DOM's
/// top-left origin to AppKit's bottom-left within the contentView.
#[cfg(target_os = "macos")]
pub fn set_frame(window: &tauri::Window, view: usize, rect: RectPx, scale: f64) {
    use cocoa::base::id;
    use objc::{msg_send, sel, sel_impl};

    let Ok(ns_window) = window.ns_window() else {
        return;
    };
    unsafe {
        let ns_window = ns_window as id;
        let content: id = msg_send![ns_window, contentView];
        if content.is_null() {
            return;
        }
        let view = view as id;
        let frame = ns_frame(content, rect);
        let _: () = msg_send![view, setFrame: frame];
        let layer: id = msg_send![view, layer];
        if !layer.is_null() {
            let _: () = msg_send![layer, setContentsScale: scale];
        }
    }
}

/// Remove + release the macOS child view (UI thread).
#[cfg(target_os = "macos")]
pub fn destroy(view: usize) {
    use cocoa::base::id;
    use objc::{msg_send, sel, sel_impl};
    if view == 0 {
        return;
    }
    unsafe {
        let view = view as id;
        let _: () = msg_send![view, removeFromSuperview];
    }
}

/// Build an AppKit frame (bottom-left origin, in the contentView's coordinate
/// space) from a DOM rect (top-left origin, measured inside the WKWebView).
///
/// The DOM `getBoundingClientRect` the frontend hands us is relative to the
/// **WKWebView**, which may be inset within the window's contentView (a
/// title-bar strip / traffic-light zone leaves the webview shorter than, and
/// offset within, the contentView). Flipping against the contentView height
/// alone mis-places the surface by exactly that inset — the terminal floated
/// one strip too high. So resolve the webview's own frame and map the rect
/// through it. When the webview fills the contentView (origin 0,0, equal
/// height) this reduces to the old `content.height - y - h`, so it can't
/// regress; it only corrects the inset case.
#[cfg(target_os = "macos")]
unsafe fn ns_frame(content: cocoa::base::id, rect: RectPx) -> cocoa::foundation::NSRect {
    use cocoa::base::nil;
    use cocoa::foundation::{NSPoint, NSRect, NSSize};
    use objc::{msg_send, sel, sel_impl};

    let wv = web_content_view(content);
    // (base_x, base_y) = webview origin within contentView (bottom-left);
    // wv_h = webview height. Fall back to the contentView box if we can't find
    // the webview (matches the pre-inset-fix behaviour exactly).
    let (base_x, base_y, wv_h) = if wv != nil {
        let f: NSRect = msg_send![wv, frame];
        (f.origin.x, f.origin.y, f.size.height)
    } else {
        let b: NSRect = msg_send![content, bounds];
        (0.0, 0.0, b.size.height)
    };

    let origin_x = base_x + rect.x;
    let origin_y = base_y + (wv_h - rect.y - rect.h);
    NSRect::new(
        NSPoint::new(origin_x, origin_y),
        NSSize::new(rect.w.max(0.0), rect.h.max(0.0)),
    )
}

/// Find the window's WKWebView by class, so we can map DOM coordinates through
/// its frame. Mirrors the subview walk in `hud.rs::frost_view`. wry usually
/// makes the WKWebView a direct child of the contentView, but check one level
/// deeper too in case it's wrapped in a container. Returns `nil` if absent.
#[cfg(target_os = "macos")]
unsafe fn web_content_view(content: cocoa::base::id) -> cocoa::base::id {
    use cocoa::base::{id, nil, YES};
    use objc::runtime::{Class, BOOL};
    use objc::{class, msg_send, sel, sel_impl};

    let wk: *const Class = class!(WKWebView);
    let subs: id = msg_send![content, subviews];
    if subs == nil {
        return nil;
    }
    let n: u64 = msg_send![subs, count];
    // Direct children first.
    let mut i: u64 = 0;
    while i < n {
        let v: id = msg_send![subs, objectAtIndex: i];
        let is_wk: BOOL = msg_send![v, isKindOfClass: wk];
        if is_wk == YES {
            return v;
        }
        i += 1;
    }
    // One level deeper.
    i = 0;
    while i < n {
        let v: id = msg_send![subs, objectAtIndex: i];
        let subs2: id = msg_send![v, subviews];
        if subs2 != nil {
            let n2: u64 = msg_send![subs2, count];
            let mut j: u64 = 0;
            while j < n2 {
                let v2: id = msg_send![subs2, objectAtIndex: j];
                let is_wk2: BOOL = msg_send![v2, isKindOfClass: wk];
                if is_wk2 == YES {
                    return v2;
                }
                j += 1;
            }
        }
        i += 1;
    }
    nil
}

// ---------------------------------------------------------------------------
// Linux (X11 via GTK) — the engine above is identical to macOS; only this
// surface-attach step is platform-specific.
// ---------------------------------------------------------------------------
#[cfg(target_os = "linux")]
pub fn attach(
    instance: &wgpu::Instance,
    window: &tauri::Window,
    rect: RectPx,
    _scale: f64,
) -> Result<AttachedSurface, String> {
    use std::ffi::c_ulong;
    use std::ptr::NonNull;

    use gdk::prelude::*;
    use gtk::prelude::*;
    use raw_window_handle::{
        RawDisplayHandle, RawWindowHandle, XlibDisplayHandle, XlibWindowHandle,
    };

    let gtk_window = window.gtk_window().map_err(|e| e.to_string())?;

    // A drawing area realized into its own X11 child window we can hand to
    // wgpu's Vulkan/GL backend.
    let area = gtk::DrawingArea::new();
    area.set_size_request(rect.w as i32, rect.h as i32);

    // The Tauri window's child is a vertical box; drop the area into an overlay
    // so it floats above the webview at an absolute position.
    let fixed = gtk::Fixed::new();
    fixed.put(&area, rect.x as i32, rect.y as i32);
    if let Some(child) = gtk_window.child() {
        if let Ok(overlay) = child.clone().downcast::<gtk::Overlay>() {
            overlay.add_overlay(&fixed);
        } else if let Ok(container) = child.downcast::<gtk::Container>() {
            container.add(&fixed);
        }
    }
    fixed.show_all();
    area.realize();

    let gdk_window = area
        .window()
        .ok_or_else(|| "drawing area has no gdk window".to_string())?;
    let xid: c_ulong = {
        // `X11Window::xid()` is an inherent method in gdkx11 0.18 — no Ext trait
        // (there is no `gdkx11::prelude`; the traits/types live at the crate root).
        let x11 = gdk_window
            .downcast::<gdkx11::X11Window>()
            .map_err(|_| "not an X11 window (Wayland not yet supported)".to_string())?;
        x11.xid()
    };

    let display = gdk::Display::default().ok_or_else(|| "no gdk display".to_string())?;
    let xdisplay = {
        // gdkx11 0.18's `X11Display` exposes no safe `xdisplay()` accessor, so we
        // reach the raw `Display*` through the sys FFI. `to_glib_none().0` hands
        // the underlying `*mut GdkX11Display` straight to the C getter.
        use gdkx11::glib::translate::ToGlibPtr;
        let x11 = display
            .downcast::<gdkx11::X11Display>()
            .map_err(|_| "not an X11 display".to_string())?;
        unsafe {
            gdkx11::ffi::gdk_x11_display_get_xdisplay(x11.to_glib_none().0)
                as *mut std::ffi::c_void
        }
    };

    let mut wh = XlibWindowHandle::new(xid);
    wh.visual_id = 0;
    let mut dh = XlibDisplayHandle::new(NonNull::new(xdisplay), 0);
    let _ = &mut dh;

    let surface = unsafe {
        instance
            .create_surface_unsafe(wgpu::SurfaceTargetUnsafe::RawHandle {
                raw_display_handle: RawDisplayHandle::Xlib(dh),
                raw_window_handle: RawWindowHandle::Xlib(wh),
            })
            .map_err(|e| e.to_string())?
    };

    // Leak the widgets' Rust wrappers into the view handle via the area's
    // pointer; GTK keeps them alive through the container. We only need the
    // area pointer for reposition/teardown.
    let view = area.as_ptr() as usize;
    std::mem::forget(fixed);
    std::mem::forget(area);
    Ok(AttachedSurface { surface, view })
}

#[cfg(target_os = "linux")]
pub fn set_frame(_window: &tauri::Window, view: usize, rect: RectPx, _scale: f64) {
    use gtk::prelude::*;
    if view == 0 {
        return;
    }
    unsafe {
        let ptr = view as *mut gtk::ffi::GtkDrawingArea;
        let area: gtk::DrawingArea = glib::translate::from_glib_none(ptr);
        area.set_size_request(rect.w as i32, rect.h as i32);
        if let Some(parent) = area.parent() {
            if let Ok(fixed) = parent.downcast::<gtk::Fixed>() {
                fixed.move_(&area, rect.x as i32, rect.y as i32);
            }
        }
        std::mem::forget(area);
    }
}

#[cfg(target_os = "linux")]
pub fn destroy(view: usize) {
    use gtk::prelude::*;
    if view == 0 {
        return;
    }
    unsafe {
        let ptr = view as *mut gtk::ffi::GtkDrawingArea;
        let area: gtk::DrawingArea = glib::translate::from_glib_none(ptr);
        if let Some(parent) = area.parent() {
            if let Ok(container) = parent.downcast::<gtk::Container>() {
                container.remove(&area);
            }
        }
        // Drop the reference we forgot at attach time.
    }
}

// ---------------------------------------------------------------------------
// Other platforms (Windows, etc.) — not a release target; keep the classic
// terminal by returning a clear error the frontend can fall back on.
// ---------------------------------------------------------------------------
#[cfg(not(any(target_os = "macos", target_os = "linux")))]
pub fn attach(
    _instance: &wgpu::Instance,
    _window: &tauri::Window,
    _rect: RectPx,
    _scale: f64,
) -> Result<AttachedSurface, String> {
    Err("native terminal is not available on this platform yet".into())
}

#[cfg(not(any(target_os = "macos", target_os = "linux")))]
pub fn set_frame(_window: &tauri::Window, _view: usize, _rect: RectPx, _scale: f64) {}

#[cfg(not(any(target_os = "macos", target_os = "linux")))]
pub fn destroy(_view: usize) {}
