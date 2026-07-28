//! Native macOS menubar. Each item with an accelerator emits a Tauri
//! event the React side listens to, so menu and keyboard shortcuts
//! stay in lockstep with in-app handlers without needing to thread
//! a fresh callback into every component.
//!
//! Event ids follow `menu:<verb>` so React's listener can switch on
//! a single channel.

use tauri::menu::{
    AboutMetadata, Menu, MenuBuilder, MenuItemBuilder, PredefinedMenuItem, SubmenuBuilder,
};
use tauri::{App, AppHandle, Emitter, Wry};

pub fn build(app: &App<Wry>) -> tauri::Result<Menu<Wry>> {
    let h = app.handle();

    // ── App menu (macOS owns the leading position) ──
    let app_menu = SubmenuBuilder::new(h, "Aura")
        .item(&PredefinedMenuItem::about(
            h,
            None,
            Some(AboutMetadata {
                name: Some("Aura".into()),
                version: Some(env!("CARGO_PKG_VERSION").into()),
                ..Default::default()
            }),
        )?)
        .separator()
        // Manual update check. Emits `menu:check_for_updates`, which
        // UpdateBanner listens for directly — it runs a forced probe and
        // surfaces the result (update available / up to date / couldn't
        // check). This is the discoverable home for the check the footer
        // simplification removed.
        .item(&MenuItemBuilder::with_id("check_for_updates", "Check for Updates…").build(h)?)
        .separator()
        .item(
            &MenuItemBuilder::with_id("settings", "Settings…")
                .accelerator("CmdOrCtrl+,")
                .build(h)?,
        )
        .separator()
        .item(&PredefinedMenuItem::services(h, None)?)
        .separator()
        .item(&PredefinedMenuItem::hide(h, None)?)
        .item(&PredefinedMenuItem::hide_others(h, None)?)
        .item(&PredefinedMenuItem::show_all(h, None)?)
        .separator()
        .item(&PredefinedMenuItem::quit(h, None)?)
        .build()?;

    // ── File menu ──
    let file_menu = SubmenuBuilder::new(h, "File")
        .item(
            &MenuItemBuilder::with_id("new_file", "New File")
                .accelerator("CmdOrCtrl+N")
                .build(h)?,
        )
        .item(
            &MenuItemBuilder::with_id("open_file", "Open…")
                .accelerator("CmdOrCtrl+O")
                .build(h)?,
        )
        .separator()
        .item(
            &MenuItemBuilder::with_id("save", "Save")
                .accelerator("CmdOrCtrl+S")
                .build(h)?,
        )
        .item(
            &MenuItemBuilder::with_id("close_tab", "Close Tab")
                .accelerator("CmdOrCtrl+W")
                .build(h)?,
        )
        .build()?;

    // ── Edit menu (rely on system items so cut/copy/paste work natively) ──
    let edit_menu = SubmenuBuilder::new(h, "Edit")
        .item(&PredefinedMenuItem::undo(h, None)?)
        .item(&PredefinedMenuItem::redo(h, None)?)
        .separator()
        .item(&PredefinedMenuItem::cut(h, None)?)
        .item(&PredefinedMenuItem::copy(h, None)?)
        .item(&PredefinedMenuItem::paste(h, None)?)
        .item(&PredefinedMenuItem::select_all(h, None)?)
        .build()?;

    // ── View menu ──
    let view_menu = SubmenuBuilder::new(h, "View")
        .item(
            &MenuItemBuilder::with_id("palette", "Command Palette…")
                .accelerator("CmdOrCtrl+K")
                .build(h)?,
        )
        .separator()
        .item(
            &MenuItemBuilder::with_id("toggle_sidebar", "Toggle Sidebar")
                .accelerator("CmdOrCtrl+B")
                .build(h)?,
        )
        .item(
            &MenuItemBuilder::with_id("toggle_terminal", "Toggle Terminal")
                .accelerator("CmdOrCtrl+J")
                .build(h)?,
        )
        .item(
            &MenuItemBuilder::with_id("toggle_review", "Toggle Review Panel")
                .accelerator("CmdOrCtrl+Alt+R")
                .build(h)?,
        )
        .separator()
        // ⌘R reloads the webview — the universally-expected refresh, and the
        // escape hatch when a broken HMR update wedges the dev UI. Review-panel
        // toggle keeps the R mnemonic on ⌘⌥R above.
        .item(
            &MenuItemBuilder::with_id("reload_app", "Reload App")
                .accelerator("CmdOrCtrl+R")
                .build(h)?,
        )
        .build()?;

    // ── Go menu — jump to the app's main surfaces ──
    let go_menu = SubmenuBuilder::new(h, "Go")
        .item(&MenuItemBuilder::with_id("tasks_board", "Tasks Board").build(h)?)
        .item(&MenuItemBuilder::with_id("notes", "Pages").build(h)?)
        .item(&MenuItemBuilder::with_id("open_prs", "Pull Requests").build(h)?)
        .item(&MenuItemBuilder::with_id("extensions", "Extensions").build(h)?)
        .separator()
        .item(&MenuItemBuilder::with_id("project_timeline", "Project Timeline").build(h)?)
        .item(&MenuItemBuilder::with_id("time_machine", "Time Machine").build(h)?)
        .build()?;

    // ── Engine menu — semantic operations the Aura engine exposes ──
    let aura_menu = SubmenuBuilder::new(h, "Engine")
        .item(&MenuItemBuilder::with_id("aura_ask", "Ask Aura").build(h)?)
        .item(&MenuItemBuilder::with_id("aura_prove", "Prove a Goal…").build(h)?)
        .item(
            &MenuItemBuilder::with_id("plan_builder", "Plan Builder…")
                .accelerator("CmdOrCtrl+Shift+P")
                .build(h)?,
        )
        .item(&MenuItemBuilder::with_id("orchestrate", "Orchestrate…").build(h)?)
        .separator()
        .item(&MenuItemBuilder::with_id("aura_status", "Show Status").build(h)?)
        .item(&MenuItemBuilder::with_id("aura_doctor", "Run Doctor").build(h)?)
        .item(&MenuItemBuilder::with_id("aura_impacts", "Show Impacts").build(h)?)
        .item(&MenuItemBuilder::with_id("aura_pr_review", "PR Review").build(h)?)
        .separator()
        .item(&MenuItemBuilder::with_id("aura_snapshot", "Snapshot…").build(h)?)
        .item(&MenuItemBuilder::with_id("aura_rewind", "Rewind…").build(h)?)
        .item(&MenuItemBuilder::with_id("aura_undo", "Undo Last Op").build(h)?)
        .separator()
        .item(
            &MenuItemBuilder::with_id("aura_log_intent", "Log Intent…")
                .accelerator("CmdOrCtrl+Shift+I")
                .build(h)?,
        )
        .item(&MenuItemBuilder::with_id("aura_handover", "Generate Handover…").build(h)?)
        .build()?;

    // ── Window menu — standard macOS window controls ──
    let window_menu = SubmenuBuilder::new(h, "Window")
        .item(&PredefinedMenuItem::minimize(h, None)?)
        .item(&PredefinedMenuItem::maximize(h, Some("Zoom"))?)
        .separator()
        .item(&PredefinedMenuItem::fullscreen(h, None)?)
        .build()?;

    let menu = MenuBuilder::new(h)
        .items(&[
            &app_menu,
            &file_menu,
            &edit_menu,
            &view_menu,
            &go_menu,
            &aura_menu,
            &window_menu,
        ])
        .build()?;

    Ok(menu)
}

/// Wire up the menu's `on_event` handler — every click forwards as a
/// `menu:<id>` event so the React side can dispatch.
pub fn install_handler(app: &AppHandle<Wry>) {
    app.on_menu_event(|app, event| {
        let id = event.id().0.clone();
        // The HUD's native workspace menu (`hud::hud_workspace_menu`) tags its
        // rows `hudws:<root>`; route a pick back as the same `hud:select-project`
        // event the old in-webview dropdown used. Disabled headers (`hudhdr:*`)
        // never fire, so we don't filter them here.
        if let Some(root) = id.strip_prefix("hudws:") {
            let _ = app.emit("hud:select-project", serde_json::json!({ "root": root }));
            return;
        }
        // The HUD's native agents menu (`hud::hud_agents_menu`) tags its rows
        // `hudagent:<key>`; route a pick back as `hud:focus-agent` so the glance
        // points at it. Disabled group headers (`hudagrp:*`) never fire.
        if let Some(key) = id.strip_prefix("hudagent:") {
            let _ = app.emit("hud:focus-agent", serde_json::json!({ "key": key }));
            return;
        }
        // The HUD composer's enum pickers (`hud::hud_menu`) tag rows
        // `hudmenu:<kind>\x1f<id>` — split on the unit separator and route the
        // pick back as `hud:menu-pick { kind, id }` so the HUD knows which chip
        // changed and to what. Disabled headers (`hudmenuhdr:*`) never fire.
        if let Some(rest) = id.strip_prefix("hudmenu:") {
            if let Some((kind, value)) = rest.split_once('\u{1f}') {
                let _ = app.emit(
                    "hud:menu-pick",
                    serde_json::json!({ "kind": kind, "id": value }),
                );
            }
            return;
        }
        let _ = app.emit(&format!("menu:{}", id), ());
    });
}
