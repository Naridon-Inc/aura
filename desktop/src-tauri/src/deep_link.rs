//! `aura://` links arriving from outside the app.
//!
//! The console can show any session in the org, but it cannot carry one on:
//! the checkout, the transcript and the agent all live on one machine. So
//! its Session detail offers "Resume in app", which asks the operating
//! system to open `aura://session/<id>`.
//!
//! Nothing on this side ever claimed that scheme. macOS looked for a handler,
//! found none, and the click did nothing — no app, no error, no explanation
//! for the reader that the link they were given is not a link at all. This
//! module is the missing half: the bundle registers `aura` (see
//! `tauri.conf.json` → plugins.deep-link.desktop.schemes) and every URL the
//! OS hands over is parked here for the window to read.
//!
//! Parked rather than delivered, because a cold launch delivers the URL
//! before there is a webview to hear it. The event is a nudge for the window
//! that is already up; the pending list is what a window drains on mount.
//! Whichever runs first, `deep_link_take` empties it, so one link opens one
//! session exactly once. The same shape `lib/traceNav.ts` uses on the
//! frontend for the same reason.
//!
//! One platform difference worth stating rather than discovering: only macOS
//! delivers the URL to a running app. Windows and Linux start a second
//! instance of Aura with the link on its command line, which the plugin puts
//! in `get_current()` — so the session does open, in a new window rather than
//! the one already on screen. Folding those into one window is what the
//! `single-instance` plugin is for, and it changes how every launch of the
//! app behaves, so it is not smuggled in with this.

use std::sync::Mutex;

use tauri::{AppHandle, Emitter, Manager};
use tauri_plugin_deep_link::DeepLinkExt;

/// Fired when a URL arrives while the app is already running.
pub const EVENT: &str = "aura://open-url";

/// URLs handed over but not yet read by a window.
#[derive(Default)]
pub struct Pending(Mutex<Vec<String>>);

impl Pending {
    fn push(&self, urls: Vec<String>) {
        if let Ok(mut held) = self.0.lock() {
            for url in urls {
                let url = url.trim().to_string();
                // A double-click that repeats the same link should not open
                // the session twice, and the OS does repeat on relaunch.
                if !url.is_empty() && !held.contains(&url) {
                    held.push(url);
                }
            }
        }
    }
}

/// Claim the scheme and start collecting.
///
/// Best-effort throughout: a machine where the handler cannot be installed
/// still runs the whole app, it just cannot be sent a link. That is the state
/// every build before this one shipped in, so it is not a reason to fail
/// startup.
pub fn install(app: &AppHandle) {
    // A launch caused BY the link — the URL is already waiting before any
    // window exists.
    if let Ok(Some(urls)) = app.deep_link().get_current() {
        app.state::<Pending>()
            .push(urls.iter().map(|u| u.to_string()).collect());
    }

    // Dev builds run from `target/debug` with no Info.plist, so macOS has
    // nothing to associate; this is what makes the scheme testable on Linux
    // and Windows without a bundle. On macOS it is a no-op and the bundled
    // app carries the registration instead.
    #[cfg(any(target_os = "linux", target_os = "windows"))]
    if let Err(e) = app.deep_link().register("aura") {
        tracing::warn!(error = %e, "could not register the aura:// scheme");
    }

    let handle = app.clone();
    app.deep_link().on_open_url(move |event| {
        let urls: Vec<String> = event.urls().iter().map(|u| u.to_string()).collect();
        tracing::info!(count = urls.len(), "aura:// link opened");
        handle.state::<Pending>().push(urls);
        // A link is a request to look at something, so the window comes
        // forward. Without this the session opens behind whatever the reader
        // clicked the link in, which reads exactly like nothing happening.
        if let Some(win) = handle.get_webview_window("main") {
            let _ = win.show();
            let _ = win.unminimize();
            let _ = win.set_focus();
        }
        let _ = handle.emit(EVENT, ());
    });
}

/// Take every URL waiting, leaving none behind.
#[tauri::command]
pub fn deep_link_take(state: tauri::State<'_, Pending>) -> Vec<String> {
    state
        .0
        .lock()
        .map(|mut held| std::mem::take(&mut *held))
        .unwrap_or_default()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_link_waits_until_a_window_asks_for_it() {
        let pending = Pending::default();
        pending.push(vec!["aura://session/abc".into()]);
        assert_eq!(
            deep_link_take_inner(&pending),
            vec!["aura://session/abc".to_string()]
        );
        // Drained, so a window that mounts after the event does not reopen it.
        assert!(deep_link_take_inner(&pending).is_empty());
    }

    #[test]
    fn the_same_link_twice_is_one_request() {
        // Clicking a link in a chat client while the app is already up sends
        // the URL again; the reader asked once.
        let pending = Pending::default();
        pending.push(vec!["aura://session/abc".into()]);
        pending.push(vec![" aura://session/abc ".into()]);
        assert_eq!(deep_link_take_inner(&pending).len(), 1);
    }

    #[test]
    fn an_empty_url_is_not_a_request() {
        let pending = Pending::default();
        pending.push(vec!["".into(), "   ".into()]);
        assert!(deep_link_take_inner(&pending).is_empty());
    }

    /// The command's body, minus Tauri's `State` wrapper, which cannot be
    /// built outside a running app.
    fn deep_link_take_inner(pending: &Pending) -> Vec<String> {
        pending
            .0
            .lock()
            .map(|mut held| std::mem::take(&mut *held))
            .unwrap_or_default()
    }
}
