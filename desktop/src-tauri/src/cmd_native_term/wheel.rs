//! Getting a scroll wheel from the window to a terminal's render thread.
//!
//! Every other input a native terminal takes arrives through the DOM: the
//! transparent hole in the webview has the keyboard focus, takes key, paste and
//! pointer events, and forwards them over IPC. That works because the webview
//! is a real view in the window and those events are delivered to it.
//!
//! The wheel is the one input that could not be made to survive that trip
//! reliably. The GPU surface is a sibling of the webview, stacked above it, so
//! anything about the stack — which view AppKit hit-tests first, what the page
//! happens to paint over the hole, whether WebKit decides a gesture belongs to
//! its own scrolling machinery — sits between the user's fingers and the
//! terminal, and every one of those is a place for the event to disappear.
//! There is no need to run that gauntlet: the surface is already the view under
//! the pointer, so it can take the wheel itself.
//!
//! What that needs is a way back from a view to its terminal. The view is an
//! AppKit object with no Rust state of its own, so this module keeps the map:
//! the view pointer the surface was created with is the key, and the value is
//! the channel its render thread is listening on. `scrollWheel:` looks itself
//! up here and posts a [`super::Ctrl::Wheel`].

#[cfg(target_os = "macos")]
use std::collections::HashMap;
#[cfg(target_os = "macos")]
use std::sync::OnceLock;
#[cfg(target_os = "macos")]
use std::sync::mpsc::Sender;
#[cfg(target_os = "macos")]
use std::sync::Mutex;

#[cfg(target_os = "macos")]
use super::Ctrl;

/// Map of native view pointer -> that terminal's control channel.
#[cfg(target_os = "macos")]
fn targets() -> &'static Mutex<HashMap<usize, Sender<Ctrl>>> {
    static TARGETS: OnceLock<Mutex<HashMap<usize, Sender<Ctrl>>>> = OnceLock::new();
    TARGETS.get_or_init(|| Mutex::new(HashMap::new()))
}

/// Start routing wheel events on `view` to `ctrl`.
#[cfg(target_os = "macos")]
pub(crate) fn register(view: usize, ctrl: Sender<Ctrl>) {
    if let Ok(mut map) = targets().lock() {
        map.insert(view, ctrl);
    }
}

/// Stop routing wheel events on `view`. Called from the one teardown funnel,
/// so a retired surface cannot leave an entry behind holding a dead channel.
#[cfg(target_os = "macos")]
pub(crate) fn unregister(view: usize) {
    if let Ok(mut map) = targets().lock() {
        map.remove(&view);
    }
}

/// Hand a wheel event to the terminal that owns `view`.
///
/// Answers whether anything took it, which is what tells `scrollWheel:` to
/// swallow the event rather than pass it up the responder chain.
#[cfg(target_os = "macos")]
pub(crate) fn dispatch(
    view: usize,
    input: aura_term_core::WheelInput,
    fx: f32,
    fy: f32,
) -> bool {
    let Ok(map) = targets().lock() else {
        return false;
    };
    match map.get(&view) {
        // A send failure means the render thread is gone; there is nothing to
        // scroll and the event should fall through.
        Some(ctrl) => ctrl.send(Ctrl::Wheel { input, fx, fy }).is_ok(),
        None => false,
    }
}
