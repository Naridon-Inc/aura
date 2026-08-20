//! Native macOS menubar. Each item with an accelerator emits a Tauri
//! event the React side listens to, so menu and keyboard shortcuts
//! stay in lockstep with in-app handlers without needing to thread
//! a fresh callback into every component.
//!
//! Event ids follow `menu:<verb>` so React's listener can switch on
//! a single channel.
//!
//! macOS ONLY, and the cfg is the whole point — see [`install`].

#[cfg(target_os = "macos")]
use tauri::menu::{
    AboutMetadata, Menu, MenuBuilder, MenuItemBuilder, PredefinedMenuItem, SubmenuBuilder,
};
use tauri::{App, AppHandle, Emitter, Wry};

/// Attach the menubar (macOS) and the `menu:<id>` event router (everywhere).
///
/// The router is unconditional: the HUD builds its own native popup menus at
/// runtime (`hud::hud_menu`, `hud_workspace_menu`, `hud_agents_menu`) and their
/// picks come back through this same `on_menu_event` channel on every platform.
///
/// The MENUBAR is macOS-only, and skipping it elsewhere is a bug fix, not a
/// feature cut. `AppHandle::set_menu` is app-wide on macOS — it lands in the
/// system menu bar at the top of the SCREEN. On Linux and Windows the same call
/// falls through to a per-window menu (tauri `window/mod.rs`, `set_menu`), which
/// on Linux is a GtkMenuBar packed into the window's own vbox and on Windows a
/// Win32 menu bar in the frame. Either way it is a SECOND bar drawn inside our
/// window, under the desktop's title bar, above a UI that already carries its
/// own chrome strip (`TopBar`) — and on Linux the window is `transparent: true`
/// (macOS needs it for the overlay title bar), which makes the toplevel
/// app-paintable, so that strip has no opaque background of its own and its
/// labels composite straight over the page. Two bars, one of them see-through.
///
/// Nothing is stranded by leaving it off: every item is in the command palette
/// or the TopBar "More tools" menu, and each accelerator has an in-app twin in
/// `lib/keymap.ts`, which is the only thing that runs the shortcuts here.
pub fn install(app: &App<Wry>) -> tauri::Result<()> {
    #[cfg(target_os = "macos")]
    {
        let menu = build(app)?;
        app.set_menu(menu)?;
    }
    install_handler(app.handle());
    Ok(())
}

#[cfg(target_os = "macos")]
fn build(app: &App<Wry>) -> tauri::Result<Menu<Wry>> {
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
        // No "New File". Nothing in the app can create one — there is no
        // file-create command in the Tauri surface and no untitled-buffer
        // concept — so the item did nothing, and worse, its CmdOrCtrl+N was
        // swallowing the keystroke: AppKit resolves menu accelerators before
        // the webview sees them, so the ⌘N the shortcut sheet advertises as
        // "New chat" (App.tsx binds it to newSessionAction) never arrived.
        // Dropping the item hands ⌘N back. Opening a project is ⌘O, below.
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

    // ── Edit menu ──
    // Cut/copy/paste/select-all stay predefined: those selectors do reach the
    // focused field and work. Undo and redo cannot be. macOS runs an NSMenu key
    // equivalent before the webview sees the key, so `PredefinedMenuItem::undo`
    // swallowed ⌘Z and handed it to WKWebView's own undo manager — which knows
    // nothing about Monaco's model or ProseMirror's history, so ⌘Z did nothing
    // in the file editor or in Pages. These emit `menu:edit_undo` /
    // `menu:edit_redo` instead, and `undoRouter.ts` hands the operation to
    // whichever editor actually has focus.
    let edit_menu = SubmenuBuilder::new(h, "Edit")
        .item(
            &MenuItemBuilder::with_id("edit_undo", "Undo")
                .accelerator("CmdOrCtrl+Z")
                .build(h)?,
        )
        .item(
            &MenuItemBuilder::with_id("edit_redo", "Redo")
                .accelerator("CmdOrCtrl+Shift+Z")
                .build(h)?,
        )
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
        // No accelerator on purpose. A macOS menu key-equivalent is handled in
        // `performKeyEquivalent:`, before the responder chain — so an
        // accelerator here swallows ⌘B from the webview entirely, and ⌘B
        // collapsed the sidebar even while you were typing in the notes
        // editor, the chat composer or a PR review comment (all three of
        // which show a Bold button captioned "⌘B"). The in-app keymap owns
        // ⌘B instead and skips it when focus is in an editable surface.
        // The binding is still advertised in four places: both sidebar
        // tooltips, the command palette, and the ⌘/ cheat-sheet.
        .item(&MenuItemBuilder::with_id("toggle_sidebar", "Toggle Sidebar").build(h)?)
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
        // ⌘R runs the project, the way it does in every IDE — the app knows the
        // command because it read the repo, and Run is one reserved terminal in
        // the panel. Reload moves to ⌘⇧R: it is the escape hatch for a wedged
        // UI, which is rarer than running the thing you are building. The
        // Review-panel toggle keeps the R mnemonic on ⌘⌥R above.
        .item(
            &MenuItemBuilder::with_id("run_project", "Run Project")
                .accelerator("CmdOrCtrl+R")
                .build(h)?,
        )
        .item(
            &MenuItemBuilder::with_id("reload_app", "Reload App")
                .accelerator("CmdOrCtrl+Shift+R")
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
