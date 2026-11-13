//! The OS pasteboard, read and written from Rust.
//!
//! The webview cannot be this app's clipboard. WKWebView gates
//! `navigator.clipboard.readText()` behind a paste gesture it grants only to
//! its own editing machinery — a Tauri window never gets one — and it rejects
//! `writeText()` once the keydown's user gesture has been spent, which any
//! intervening `await invoke(...)` spends. Both failures looked identical from
//! the outside: ⌘V in a terminal did nothing at all, and a ⌘C that had to ask
//! Rust for the selection first put nothing on the pasteboard.
//!
//! `arboard` talks to the pasteboard directly, with no gesture to spend, so
//! every clipboard path in the app comes through here. Images keep their own
//! route in [`crate::cmd_clips`]: a PTY carries bytes, so a screenshot is
//! handed to a child process rather than pasted.

/// The pasteboard's text, or an empty string when it holds none.
///
/// Infallible on purpose. Every caller treats "no text" and "could not read
/// the pasteboard" the same way — there is nothing to paste — and an error
/// would only make each one write the same `catch`.
#[tauri::command]
pub fn clipboard_read_text() -> String {
    arboard::Clipboard::new()
        .and_then(|mut c| c.get_text())
        .unwrap_or_default()
}

/// Put `text` on the pasteboard.
///
/// Fallible, unlike the read: a caller that flashed "Copied" on a write that
/// silently failed would be lying about where the user's text went.
#[tauri::command]
pub fn clipboard_write_text(text: String) -> Result<(), String> {
    let mut clipboard = arboard::Clipboard::new().map_err(|e| format!("clipboard: {e}"))?;
    clipboard
        .set_text(text)
        .map_err(|e| format!("set_text: {e}"))
}
