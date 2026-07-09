//! Native, crash-proof file/folder picker for macOS.
//!
//! `tauri-plugin-dialog` opens the native panel through `rfd`, which links
//! `objc2-app-kit 0.3` and calls `+[NSOpenPanel openPanel]` with a non-null
//! return type. When that selector returns `nil` — which AppKit does when the
//! panel is summoned while the process is NOT the active/foreground app (e.g.
//! an autonomous agent triggers a folder pick while the user is away) — objc2
//! unwraps the nil and the whole app **panics and dies**:
//!
//! ```text
//! unexpected NULL returned from +[NSOpenPanel openPanel]
//!   … objc2-app-kit-0.3.2/src/generated/NSOpenPanel.rs:127:5
//! ```
//!
//! We side-step rfd entirely on macOS: drive `NSOpenPanel` ourselves through the
//! raw `cocoa`/`objc` bindings the app already uses for the traffic lights. Two
//! things make this robust where rfd is not:
//!   1. We **activate the app** first, so the panel has a foreground context and
//!      AppKit returns a real panel instead of `nil` in the agent-triggered case.
//!   2. If the panel is `nil` anyway, we **return an empty selection** — a
//!      graceful "cancel" — instead of panicking. A missed pick is never worth a
//!      crashed editor.
//!
//! The panel is created and run on the **main thread** (AppKit's hard
//! requirement) via `run_on_main_thread`; the async command awaits the result
//! over a channel. Off macOS the command errors and the frontend falls back to
//! the plugin (the crash is macOS-only).

use serde::Deserialize;

/// Picker request. Mirrors the subset of `@tauri-apps/plugin-dialog`'s `open`
/// options the app actually uses. `camelCase` so the JS payload maps cleanly.
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PickArgs {
    /// Choose directories instead of files.
    #[serde(default)]
    pub directory: bool,
    /// Allow selecting more than one entry.
    #[serde(default)]
    pub multiple: bool,
    /// Optional prompt shown above the panel's file list.
    #[serde(default)]
    pub title: Option<String>,
    /// Optional starting directory (a filesystem path).
    #[serde(default)]
    pub default_path: Option<String>,
}

/// Open a native file/folder picker and return the selected absolute paths.
///
/// Returns an empty vec on cancel (or on any AppKit edge case) — never an error
/// on macOS, so the caller treats "nothing" and "cancelled" identically. The
/// frontend normalizes the vec back into the plugin's `string | string[] | null`
/// shape.
#[tauri::command]
pub async fn dialog_pick(
    app: tauri::AppHandle,
    args: PickArgs,
) -> Result<Vec<String>, String> {
    #[cfg(target_os = "macos")]
    {
        let (tx, rx) = std::sync::mpsc::channel::<Vec<String>>();
        app.run_on_main_thread(move || {
            let picked = unsafe { native_pick(&args) };
            let _ = tx.send(picked);
        })
        .map_err(|e| format!("failed to dispatch picker to main thread: {e}"))?;
        // Block a pool thread (not the async executor) until the modal returns.
        let picked = tauri::async_runtime::spawn_blocking(move || rx.recv().unwrap_or_default())
            .await
            .map_err(|e| format!("picker channel join failed: {e}"))?;
        Ok(picked)
    }
    #[cfg(not(target_os = "macos"))]
    {
        let _ = (&app, &args);
        Err("dialog_pick is implemented for macOS only".into())
    }
}

/// Drive `NSOpenPanel` on the main thread. Safe against a `nil` panel.
///
/// SAFETY: caller guarantees this runs on the main thread (AppKit requirement);
/// every Objective-C handle is null-checked before use and none escape the fn.
#[cfg(target_os = "macos")]
#[allow(deprecated)] // cocoa/objc 0.2 aliases; same path cmd_window.rs uses for traffic lights
unsafe fn native_pick(args: &PickArgs) -> Vec<String> {
    use cocoa::base::{id, nil, NO, YES};
    use cocoa::foundation::{NSInteger, NSString, NSUInteger};
    use objc::{class, msg_send, sel, sel_impl};

    // Bring the app to the foreground. Without this, a panel summoned while the
    // app is backgrounded (the agent-triggered case) is exactly when AppKit
    // hands back nil — which is the crash we're killing.
    let ns_app: id = msg_send![class!(NSApplication), sharedApplication];
    let _: () = msg_send![ns_app, activateIgnoringOtherApps: YES];

    let panel: id = msg_send![class!(NSOpenPanel), openPanel];
    if panel.is_null() {
        // The very condition rfd panics on — degrade to a clean cancel instead.
        return Vec::new();
    }

    let want_dirs = if args.directory { YES } else { NO };
    let want_files = if args.directory { NO } else { YES };
    let want_multi = if args.multiple { YES } else { NO };
    let _: () = msg_send![panel, setCanChooseDirectories: want_dirs];
    let _: () = msg_send![panel, setCanChooseFiles: want_files];
    let _: () = msg_send![panel, setAllowsMultipleSelection: want_multi];
    let _: () = msg_send![panel, setResolvesAliases: YES];
    // Show the panel's "New Folder" button so picking a folder to work in can
    // CREATE one on the spot — rfd/tauri-plugin-dialog leaves this off, which is
    // why the folder picker only let users open existing dirs. Directory mode
    // only; a file open has nothing to create.
    let _: () = msg_send![panel, setCanCreateDirectories: want_dirs];

    if let Some(title) = args.title.as_deref() {
        if !title.is_empty() {
            let msg = NSString::alloc(nil).init_str(title);
            let _: () = msg_send![panel, setMessage: msg];
        }
    }
    if let Some(path) = args.default_path.as_deref() {
        if !path.is_empty() {
            let s = NSString::alloc(nil).init_str(path);
            let url: id = msg_send![class!(NSURL), fileURLWithPath: s];
            if !url.is_null() {
                let _: () = msg_send![panel, setDirectoryURL: url];
            }
        }
    }

    // NSModalResponseOK == 1. Anything else (cancel/abort) → no selection.
    let response: NSInteger = msg_send![panel, runModal];
    if response != 1 {
        return Vec::new();
    }

    let urls: id = msg_send![panel, URLs];
    if urls.is_null() {
        return Vec::new();
    }
    let count: NSUInteger = msg_send![urls, count];
    let mut out: Vec<String> = Vec::with_capacity(count as usize);
    for i in 0..count {
        let url: id = msg_send![urls, objectAtIndex: i];
        if url.is_null() {
            continue;
        }
        let path: id = msg_send![url, path];
        if path.is_null() {
            continue;
        }
        let utf8: *const std::os::raw::c_char = msg_send![path, UTF8String];
        if utf8.is_null() {
            continue;
        }
        let s = std::ffi::CStr::from_ptr(utf8).to_string_lossy().into_owned();
        if !s.is_empty() {
            out.push(s);
        }
    }
    out
}
