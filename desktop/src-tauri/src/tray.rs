//! Menu-bar (system-tray) presence. Keeps Aura resident in the macOS menu
//! bar so the always-on-top HUD (see `hud.rs`) can be summoned with ⌘⇧A
//! even when the main window is hidden.
//!
//! Interaction model (chosen by the user):
//!   • left-click the menu-bar icon → toggle the floating HUD
//!   • right-click → a small menu: Open Aura / Show HUD / Quit Aura
//!
//! "Quit Aura" is the *real* exit — it flips the quit flag in `lib.rs` so
//! the main window's close handler stops intercepting and the app exits.

use tauri::{
    menu::{Menu, MenuBuilder, MenuItemBuilder},
    tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent},
    App, AppHandle, Manager, Wry,
};

use crate::hud;

pub const TRAY_ID: &str = "aura-tray";

pub fn build(app: &App<Wry>) -> tauri::Result<()> {
    let menu = tray_menu(app.handle())?;

    let mut builder = TrayIconBuilder::with_id(TRAY_ID)
        .tooltip("Aura")
        .menu(&menu)
        // Left-click is reserved for toggling the HUD, so don't pop the
        // menu on it — the menu is right-click only.
        .show_menu_on_left_click(false)
        .on_menu_event(|app, event| match event.id().0.as_str() {
            "tray_open" => show_main(app),
            "tray_hud" => hud::show(app),
            "tray_quit" => crate::request_quit(app),
            _ => {}
        })
        .on_tray_icon_event(|tray, event| {
            if let TrayIconEvent::Click {
                button: MouseButton::Left,
                button_state: MouseButtonState::Up,
                ..
            } = event
            {
                hud::toggle(tray.app_handle());
            }
        });

    // Reuse the app's bundle icon for the menu bar. (A dedicated monochrome
    // template glyph can replace this later; the colored mark is on-brand
    // and avoids shipping a new asset for v1.)
    if let Some(icon) = app.default_window_icon().cloned() {
        builder = builder.icon(icon);
    }

    builder.build(app)?;
    Ok(())
}

fn tray_menu(h: &AppHandle<Wry>) -> tauri::Result<Menu<Wry>> {
    MenuBuilder::new(h)
        .item(&MenuItemBuilder::with_id("tray_open", "Open Aura").build(h)?)
        .item(&MenuItemBuilder::with_id("tray_hud", "Show HUD  ⌘⇧A").build(h)?)
        .separator()
        .item(&MenuItemBuilder::with_id("tray_quit", "Quit Aura").build(h)?)
        .build()
}

/// Bring the hidden-to-menu-bar main window back to the foreground.
pub fn show_main(app: &AppHandle<Wry>) {
    if let Some(win) = app.get_webview_window("main") {
        let _ = win.show();
        let _ = win.unminimize();
        let _ = win.set_focus();
    }
}
