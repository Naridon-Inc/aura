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

/// Open the system emoji picker. macOS fronts the Character Viewer; other
/// platforms are a graceful no-op (the capture input is already focused).
#[tauri::command]
pub fn open_system_emoji_picker() -> Result<(), String> {
    #[cfg(target_os = "macos")]
    unsafe {
        use cocoa::base::{id, nil};
        use objc::{class, msg_send, sel, sel_impl};

        let app: id = msg_send![class!(NSApplication), sharedApplication];
        if app == nil {
            return Err("NSApplication is unavailable".to_string());
        }
        let _: () = msg_send![app, orderFrontCharacterPalette: nil];
    }
    Ok(())
}
