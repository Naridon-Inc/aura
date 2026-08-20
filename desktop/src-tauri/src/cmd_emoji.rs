// Summon the operating system's own emoji / character picker.
//
// There is no web API to open the native emoji palette, so the roster's
// "Change icon" affordance goes through AppKit: `-[NSApplication
// orderFrontCharacterPalette:]` fronts the macOS Character Viewer (the same
// panel ⌃⌘Space opens). The glyph the user double-clicks is inserted into
// whatever text field is first responder in the webview — the roster focuses a
// tiny capture input just before calling this, reads the inserted character,
// and persists it as the workspace's icon.
//
// Non-macOS is a no-op (returns Ok): the roster still focuses its capture
// input, so the user's own OS shortcut (Win+. / the IBus picker) lands in the
// same field.

/// Open the system emoji picker, attached to the window that asked for it.
/// macOS fronts the Character Viewer; other platforms are a graceful no-op
/// (the capture input is already focused).
#[tauri::command]
pub fn open_system_emoji_picker(window: tauri::WebviewWindow) -> Result<(), String> {
    #[cfg(target_os = "macos")]
    {
        use cocoa::base::{id, nil, YES};
        use objc::{class, msg_send, sel, sel_impl};

        // The palette follows the KEY window, and this app has more than one:
        // the menu-bar HUD is its own panel, and a popped-out pane is its own
        // window. Whichever of them was last key is where the Character Viewer
        // appeared — over there, inserting into a field that isn't the capture
        // input, while the roster you clicked sat waiting for a glyph that was
        // never coming. So make the caller key first, and mean it: a panel that
        // is still frontmost outranks a window that is merely ordered front.
        let ns_window = window.ns_window().map_err(|e| e.to_string())? as id;
        unsafe {
            let app: id = msg_send![class!(NSApplication), sharedApplication];
            if app == nil {
                return Err("NSApplication is unavailable".to_string());
            }
            if ns_window != nil {
                let _: () = msg_send![app, activateIgnoringOtherApps: YES];
                let _: () = msg_send![ns_window, makeKeyAndOrderFront: nil];
            }
            let _: () = msg_send![app, orderFrontCharacterPalette: nil];
        }
    }
    #[cfg(not(target_os = "macos"))]
    {
        let _ = &window;
    }
    Ok(())
}
