//! Runtime reposition of the macOS native window buttons (traffic lights).
//! Tauri's `trafficLightPosition` is create-time only; FullscreenOverlay needs
//! to drop the lights below its top bar while open and restore them on close,
//! so we move the three standard window buttons' frame origins on demand.

/// Move the close/miniaturize/zoom buttons so the close button's top-left sits
/// at (x, y) measured from the window's top-left, with the other two laid out
/// to its right at the live button pitch. Best-effort: no-op off macOS.
#[tauri::command]
pub fn window_set_traffic_light_position(
    window: tauri::WebviewWindow,
    x: f64,
    y: f64,
) -> Result<(), String> {
    #[cfg(target_os = "macos")]
    {
        let ns_window = window.ns_window().map_err(|e| e.to_string())?;
        // Defer one runloop tick so AppKit's own button layout (which runs after
        // the command returns) doesn't immediately stomp our frame change.
        unsafe { reposition_traffic_lights(ns_window as cocoa::base::id, x, y) };
    }
    #[cfg(not(target_os = "macos"))]
    {
        let _ = (&window, x, y);
    }
    Ok(())
}

/// Show or hide the three native window buttons. While a FullscreenOverlay is
/// up it owns the whole window and supplies its own Esc/close chip, so the
/// native lights are hidden for the duration and restored on close — cleaner
/// than parking them in the content area. Best-effort: no-op off macOS.
#[tauri::command]
pub fn window_set_traffic_lights_hidden(
    window: tauri::WebviewWindow,
    hidden: bool,
) -> Result<(), String> {
    #[cfg(target_os = "macos")]
    {
        let ns_window = window.ns_window().map_err(|e| e.to_string())?;
        unsafe { set_traffic_lights_hidden(ns_window as cocoa::base::id, hidden) };
    }
    #[cfg(not(target_os = "macos"))]
    {
        let _ = (&window, hidden);
    }
    Ok(())
}

#[cfg(target_os = "macos")]
unsafe fn set_traffic_lights_hidden(ns_window: cocoa::base::id, hidden: bool) {
    use cocoa::appkit::{NSWindow, NSWindowButton};
    use cocoa::base::{NO, YES};
    use objc::{msg_send, sel, sel_impl};

    let flag = if hidden { YES } else { NO };
    for kind in [
        NSWindowButton::NSWindowCloseButton,
        NSWindowButton::NSWindowMiniaturizeButton,
        NSWindowButton::NSWindowZoomButton,
    ] {
        let btn = ns_window.standardWindowButton_(kind);
        if !btn.is_null() {
            let _: () = msg_send![btn, setHidden: flag];
        }
    }
}

#[cfg(target_os = "macos")]
unsafe fn reposition_traffic_lights(ns_window: cocoa::base::id, x: f64, y: f64) {
    use cocoa::appkit::{NSWindow, NSWindowButton};
    use cocoa::foundation::NSPoint;
    use objc::{msg_send, sel, sel_impl};

    let close = ns_window.standardWindowButton_(NSWindowButton::NSWindowCloseButton);
    let mini = ns_window.standardWindowButton_(NSWindowButton::NSWindowMiniaturizeButton);
    let zoom = ns_window.standardWindowButton_(NSWindowButton::NSWindowZoomButton);
    if close.is_null() {
        return;
    }

    // The buttons live in a titlebar container view that uses AppKit's
    // bottom-left origin. Flip our top-relative y into that space.
    let superview: cocoa::base::id = msg_send![close, superview];
    let container: cocoa::foundation::NSRect = msg_send![superview, frame];
    let close_frame: cocoa::foundation::NSRect = msg_send![close, frame];
    let mini_frame: cocoa::foundation::NSRect = msg_send![mini, frame];
    let bh = close_frame.size.height;
    // Live horizontal pitch between buttons (don't hardcode 20px).
    let pitch = mini_frame.origin.x - close_frame.origin.x;
    let top_y = container.size.height - y - bh;

    for (i, &btn) in [close, mini, zoom].iter().enumerate() {
        let origin = NSPoint::new(x + pitch * i as f64, top_y);
        let _: () = msg_send![btn, setFrameOrigin: origin];
    }
}
