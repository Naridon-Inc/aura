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

/// The view class the terminal surface uses on macOS: an `NSView` that paints,
/// declines almost every event, and keeps the scroll wheel.
///
/// A subview added to the window's `contentView` sits above the WebKit view in
/// BOTH orders that matter — it paints on top, which is the point, and it is
/// hit-tested first, which mostly is not. AppKit's default `hitTest:` answers
/// with the view for any point inside its frame, so the surface claimed every
/// mouse event over the terminal and, implementing none of them, passed them up
/// the responder chain to the window. They never reached the webview, so the
/// DOM hole's handlers never ran.
///
/// Returning nil fixes that for everything the hole is supposed to own — the
/// keyboard, paste, clicks and drag-selection all belong to the hole, which
/// forwards them over IPC. The wheel is the exception, and it is the exception
/// for a reason: it is the one input whose delivery to the hole depends on
/// things outside this file. The webview has to be the view WebKit routes the
/// gesture into, nothing in the page may be painted over the hole, and WebKit
/// must dispatch the event to the DOM rather than keeping it for its own
/// scrolling. Each of those is a place for a scroll to disappear with no
/// symptom but a terminal that will not move, and none of them can be checked
/// from here.
///
/// So the surface keeps the wheel — and *only* the wheel, and only over
/// itself. It is already the view directly under the pointer, which makes it
/// the shortest honest path: `hitTest:` answers with self for a scroll-wheel
/// event at a point it actually contains and nil for everything else, and
/// `scrollWheel:` hands the delta to the render thread. Nothing in the webview,
/// the page or WebKit's gesture handling sits in between any more.
///
/// The "at a point it actually contains" is not pedantry; see `hit_test` below
/// for the window-wide wheel theft that answering without reading the point
/// caused.
#[cfg(target_os = "macos")]
fn surface_view_class() -> *const objc::runtime::Class {
    use std::sync::Once;

    use objc::declare::ClassDecl;
    use objc::runtime::{Class, Object, Sel};
    use objc::{class, msg_send, sel, sel_impl};

    /// `NSEventTypeScrollWheel`.
    const NS_EVENT_TYPE_SCROLL_WHEEL: u64 = 22;

    static mut CLASS: *const Class = std::ptr::null();
    static INIT: Once = Once::new();
    INIT.call_once(|| {
        // `hitTest:` takes an NSPoint and answers the view that should receive
        // the event. nil means "not me, keep looking underneath" — which is
        // the answer for everything except a wheel inside this view's own
        // rectangle.
        //
        // Both halves of that sentence are load-bearing, and leaving the
        // second one out is how a fix for the terminal's wheel took the wheel
        // away from everything else in the window.
        //
        // The point is not a formality. A superview asks EVERY one of its
        // subviews, front to back, whether it wants a point — including points
        // nowhere near that subview — and deciding that is the subview's own
        // job: `NSView`'s implementation starts by testing the point against
        // its frame, and the first subview to answer with something other than
        // nil ends the search. An override that never reads the point
        // therefore does not claim the terminal's rectangle, it claims the
        // window, and it claims it ahead of the webview because it was added
        // to the content view later.
        //
        // Which is worst exactly where the terminal is not: a surface whose
        // pane went to the readable transcript is parked 1×1 at
        // (-100000,-100000) — see `nativeSurfacePlacement.ts` — and still
        // answered for a wheel in the middle of the chat, which then never
        // reached WebKit and the transcript sat still. Two panes in a split
        // were the same bug twice: the topmost surface took both halves, so a
        // wheel over the left pane scrolled the right one's scrollback.
        //
        // So the containment question goes back to `NSView`, which is the
        // thing that knows the answer — frame, hidden flag, clipping and all —
        // and this override only ever narrows it: of the points NSView would
        // have taken, keep the scrolls and decline the rest.
        extern "C" fn hit_test(
            this: &Object,
            _: Sel,
            point: cocoa::foundation::NSPoint,
        ) -> *mut Object {
            let inside = unsafe {
                let hit: *mut Object = msg_send![super(this, class!(NSView)), hitTest: point];
                !hit.is_null()
            };
            if !inside {
                return std::ptr::null_mut();
            }
            // Which event is being routed is not an argument to `hitTest:`,
            // but AppKit runs the hit test while dispatching it, so the
            // application's current event is that event.
            let is_scroll = unsafe {
                let app: cocoa::base::id = msg_send![class!(NSApplication), sharedApplication];
                if app.is_null() {
                    false
                } else {
                    let event: cocoa::base::id = msg_send![app, currentEvent];
                    if event.is_null() {
                        false
                    } else {
                        let kind: u64 = msg_send![event, type];
                        kind == NS_EVENT_TYPE_SCROLL_WHEEL
                    }
                }
            };
            if is_scroll {
                this as *const Object as *mut Object
            } else {
                std::ptr::null_mut()
            }
        }

        extern "C" fn scroll_wheel(this: &Object, _: Sel, event: cocoa::base::id) {
            unsafe {
                if event.is_null() {
                    return;
                }
                let bounds: cocoa::foundation::NSRect = msg_send![this, bounds];
                let window_point: cocoa::foundation::NSPoint = msg_send![event, locationInWindow];
                let local: cocoa::foundation::NSPoint =
                    msg_send![this, convertPoint: window_point fromView: cocoa::base::nil];
                // AppKit measures an unflipped view from its bottom-left; the
                // grid counts rows from the top.
                let from_top = bounds.size.height - local.y;
                let (fx, fy) = aura_term_core::wheel::frac_in_view(
                    (local.x, from_top),
                    (bounds.size.width, bounds.size.height),
                );

                let precise: objc::runtime::BOOL = msg_send![event, hasPreciseScrollingDeltas];
                let delta_y: f64 = msg_send![event, scrollingDeltaY];
                let input = if precise == objc::runtime::YES {
                    // A precise delta is in points, and the grid's line height
                    // is in backing pixels.
                    let window: cocoa::base::id = msg_send![this, window];
                    let scale: f64 = if window.is_null() {
                        1.0
                    } else {
                        msg_send![window, backingScaleFactor]
                    };
                    aura_term_core::WheelInput::Pixels(delta_y * scale)
                } else {
                    // A notched wheel counts in lines already.
                    aura_term_core::WheelInput::Lines(
                        (delta_y.round() as i32) * aura_term_core::LINES_PER_NOTCH,
                    )
                };

                let view = this as *const Object as usize;
                if !super::wheel::dispatch(view, input, fx, fy) {
                    // No terminal owns this surface any more. Letting the event
                    // continue up the responder chain is better than eating it.
                    let _: () = msg_send![super(this, class!(NSView)), scrollWheel: event];
                }
            }
        }

        let superclass = class!(NSView);
        let mut decl =
            ClassDecl::new("AuraTermSurfaceView", superclass).expect("AuraTermSurfaceView");
        unsafe {
            decl.add_method(
                sel!(hitTest:),
                hit_test as extern "C" fn(&Object, Sel, cocoa::foundation::NSPoint) -> *mut Object,
            );
            decl.add_method(
                sel!(scrollWheel:),
                scroll_wheel as extern "C" fn(&Object, Sel, cocoa::base::id),
            );
            CLASS = decl.register();
        }
    });
    unsafe { CLASS }
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
        // Not `NSView` — see `surface_view_class`. The only difference is in
        // what it answers a hit test with: a wheel over its own rectangle it
        // takes, and every other event it declines so the DOM hole underneath
        // gets it instead of the responder chain eating it.
        let view: id = msg_send![surface_view_class(), alloc];
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

    // AppKit's default is a bottom-left origin, but a host toolkit is free to
    // hand back a flipped contentView, and the mapping is upside down if it
    // does. Ask rather than assume.
    // Compare against YES rather than coercing: objc's BOOL is `bool` on
    // aarch64 but `signed char` on x86_64, so assigning the result straight
    // into a `bool` only compiles on Apple silicon.
    let flipped: bool = {
        use objc::runtime::{BOOL, YES};
        let f: BOOL = msg_send![content, isFlipped];
        f == YES
    };

    let (origin_x, origin_y) = map_dom_rect(rect, base_x, base_y, wv_h, flipped);

    // The flip above assumes the contentView has AppKit's default bottom-left
    // origin. If tao ever hands us a flipped contentView the subtraction is
    // upside down, and the surface lands somewhere that looks plausible but is
    // wrong — so report the assumption rather than trusting it.
    if std::env::var("AURA_TERM_DEBUG").is_ok() {
        let cb: NSRect = msg_send![content, bounds];
        eprintln!(
            "[native-term] ns_frame: content={:.0}x{:.0} flipped={} wv={} \
wv_frame=({:.0},{:.0} h={:.0}) rect=({:.0},{:.0} {:.0}x{:.0}) -> origin=({:.0},{:.0})",
            cb.size.width,
            cb.size.height,
            flipped,
            wv != nil,
            base_x,
            base_y,
            wv_h,
            rect.x,
            rect.y,
            rect.w,
            rect.h,
            origin_x,
            origin_y,
        );
    }

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

/// Map a DOM rect (top-left origin, measured inside the WKWebView) onto an
/// AppKit frame origin in the contentView's coordinate space.
///
/// `wv_x`/`wv_y` are the webview's own origin within the contentView and
/// `wv_h` its height, both in that same space. `flipped` is the contentView's
/// `isFlipped`: AppKit's default is `false` (origin bottom-left, y upward),
/// where a DOM y has to be flipped against the webview's height and the rect's
/// own height, because an `NSRect` origin is its *bottom* edge. A flipped
/// superview already agrees with the DOM — origin is top-left and y grows
/// downward — so the rect maps straight through.
///
/// Kept free of objc so the arithmetic can be tested without a window; the
/// unsafe caller supplies the four measurements.
fn map_dom_rect(rect: RectPx, wv_x: f64, wv_y: f64, wv_h: f64, flipped: bool) -> (f64, f64) {
    let x = wv_x + rect.x;
    let y = if flipped {
        wv_y + rect.y
    } else {
        wv_y + (wv_h - rect.y - rect.h)
    };
    (x, y)
}

#[cfg(test)]
mod tests {
    use super::*;

    const WV: (f64, f64, f64) = (0.0, 0.0, 800.0);

    fn rect(x: f64, y: f64, w: f64, h: f64) -> RectPx {
        RectPx { x, y, w, h }
    }

    #[test]
    fn an_unflipped_superview_measures_from_the_rects_bottom_edge() {
        // A 200-tall hole 100 down from the webview top leaves 800-100-200=500
        // between the window bottom and the hole's bottom edge.
        let (x, y) = map_dom_rect(rect(40.0, 100.0, 300.0, 200.0), WV.0, WV.1, WV.2, false);
        assert_eq!((x, y), (40.0, 500.0));
    }

    #[test]
    fn a_flipped_superview_takes_the_dom_rect_unchanged() {
        // Flipped means top-left origin and y downward, which is what the DOM
        // already gives us, so the hole's own y is the answer.
        let (x, y) = map_dom_rect(rect(40.0, 100.0, 300.0, 200.0), WV.0, WV.1, WV.2, true);
        assert_eq!((x, y), (40.0, 100.0));
    }

    #[test]
    fn the_webviews_inset_within_the_window_is_carried_through() {
        // A title-bar strip leaves the webview shorter than and offset within
        // the contentView. Flipping against the contentView instead of the
        // webview is what floated the terminal one strip too high.
        let (x, y) = map_dom_rect(rect(0.0, 0.0, 300.0, 200.0), 12.0, 30.0, 700.0, false);
        assert_eq!((x, y), (12.0, 30.0 + 700.0 - 200.0));
    }

    #[test]
    fn a_hole_filling_the_webview_lands_on_the_webview_origin() {
        // The whole-pane case: the surface should cover the webview exactly,
        // under either convention.
        let full = rect(0.0, 0.0, 1200.0, 800.0);
        assert_eq!(map_dom_rect(full, 0.0, 0.0, 800.0, false), (0.0, 0.0));
        assert_eq!(map_dom_rect(full, 0.0, 0.0, 800.0, true), (0.0, 0.0));
    }

    #[test]
    fn the_two_conventions_agree_only_when_the_hole_is_vertically_centred() {
        // Sanity on the asymmetry itself: they coincide exactly when the space
        // above the hole equals the space below it. Anywhere else, picking the
        // wrong one misplaces the surface — which is the bug this guards.
        let centred = rect(0.0, 300.0, 100.0, 200.0);
        assert_eq!(
            map_dom_rect(centred, 0.0, 0.0, 800.0, false),
            map_dom_rect(centred, 0.0, 0.0, 800.0, true),
        );
        let high = rect(0.0, 10.0, 100.0, 200.0);
        assert_ne!(
            map_dom_rect(high, 0.0, 0.0, 800.0, false),
            map_dom_rect(high, 0.0, 0.0, 800.0, true),
        );
    }
}
