//! Native macOS menubar.
//!
//! On macOS we install a real NSMenu via the `muda` crate so
//! File/View/Go/Window items live at the top of the screen the way
//! users expect from a cocoa app. Menu clicks + accelerators fire
//! [`MenuCommand`] values through an unbounded channel, which the
//! iced runtime consumes via a subscription (see [`menu_event_stream`])
//! and dispatches as `Message::MenuCommand(cmd)` back into the update
//! loop — so every menu item ends up calling the same code path an
//! in-app keybind would.
//!
//! Non-macOS builds compile the enum + stubs so callers can sit on a
//! stable API; the install / stream are no-ops there. The parent crate
//! still ships the keyboard shortcuts via `dispatch_key_event`, so
//! nothing breaks on Linux/Windows.

use std::sync::{Mutex, OnceLock};

use tokio::sync::mpsc::{unbounded_channel, UnboundedReceiver, UnboundedSender};

#[cfg(target_os = "macos")]
use muda::{
    accelerator::{Accelerator, Code, Modifiers},
    AboutMetadata, Menu, MenuEvent, MenuId, MenuItem, PredefinedMenuItem, Submenu,
};

use crate::app::Pane;

/// High-level command the menu can emit. Each variant corresponds to an
/// app-level `Message` the update loop already knows how to handle; the
/// menu is purely a second input channel, never an independent state.
#[derive(Debug, Clone, Copy)]
pub enum MenuCommand {
    OpenFolder,
    /// ⌘S — persist the active editor buffer to disk.
    Save,
    ToggleTerminal,
    ToggleReview,
    ToggleRightSidebar,
    ToggleLogOutput,
    ToggleFullscreenTerminal,
    ZoomIn,
    ZoomOut,
    ZoomReset,
    CommandPalette,
    Handover,
    FocusSearch,
    /// Rail pane shortcuts (⌘1–⌘7). Parameterised by Pane so one arm in
    /// the update handler can route every pane select without a switch
    /// of its own.
    SelectPane(Pane),
}

impl MenuCommand {
    /// String id used both by the NSMenu item registration and by the
    /// `MenuEvent::set_event_handler` round-trip. Keeping it in one
    /// place avoids the classic typo-drift where a new item works from
    /// the menu but the handler ignores it.
    fn id(self) -> &'static str {
        match self {
            Self::OpenFolder => "open_folder",
            Self::Save => "save_active_file",
            Self::ToggleTerminal => "toggle_terminal",
            Self::ToggleReview => "toggle_review",
            Self::ToggleRightSidebar => "toggle_right_sidebar",
            Self::ToggleLogOutput => "toggle_log_output",
            Self::ToggleFullscreenTerminal => "toggle_fullscreen_terminal",
            Self::ZoomIn => "zoom_in",
            Self::ZoomOut => "zoom_out",
            Self::ZoomReset => "zoom_reset",
            Self::CommandPalette => "command_palette",
            Self::Handover => "handover",
            Self::FocusSearch => "focus_search",
            Self::SelectPane(p) => pane_id(p),
        }
    }

    fn from_id(s: &str) -> Option<Self> {
        Some(match s {
            "open_folder" => Self::OpenFolder,
            "save_active_file" => Self::Save,
            "toggle_terminal" => Self::ToggleTerminal,
            "toggle_review" => Self::ToggleReview,
            "toggle_right_sidebar" => Self::ToggleRightSidebar,
            "toggle_log_output" => Self::ToggleLogOutput,
            "toggle_fullscreen_terminal" => Self::ToggleFullscreenTerminal,
            "zoom_in" => Self::ZoomIn,
            "zoom_out" => Self::ZoomOut,
            "zoom_reset" => Self::ZoomReset,
            "command_palette" => Self::CommandPalette,
            "handover" => Self::Handover,
            "focus_search" => Self::FocusSearch,
            other => {
                if let Some(p) = pane_from_id(other) {
                    Self::SelectPane(p)
                } else {
                    return None;
                }
            }
        })
    }
}

/// Stable menu-id string per pane. Kept as a free fn rather than inlined
/// into `MenuCommand::id` so `from_id` can share the same mapping.
fn pane_id(p: Pane) -> &'static str {
    match p {
        Pane::Work => "select_pane_work",
        Pane::Plan => "select_pane_plan",
        Pane::Impacts => "select_pane_impacts",
        Pane::Proof => "select_pane_proof",
        Pane::Memory => "select_pane_memory",
        Pane::Timeline => "select_pane_timeline",
        Pane::Doctor => "select_pane_doctor",
        // Team / Orchestration / Conflict / Handover are not rail
        // shortcuts — the menu never emits an id for them, so this
        // branch is dead but kept exhaustive so a new Pane variant
        // fails closed.
        Pane::Team => "select_pane_team",
        Pane::Orchestration => "select_pane_orchestration",
        Pane::Conflict => "select_pane_conflict",
        Pane::Handover => "select_pane_handover",
    }
}

fn pane_from_id(s: &str) -> Option<Pane> {
    Some(match s {
        "select_pane_work" => Pane::Work,
        "select_pane_plan" => Pane::Plan,
        "select_pane_impacts" => Pane::Impacts,
        "select_pane_proof" => Pane::Proof,
        "select_pane_memory" => Pane::Memory,
        "select_pane_timeline" => Pane::Timeline,
        "select_pane_doctor" => Pane::Doctor,
        _ => return None,
    })
}

// ═══ Event plumbing ═════════════════════════════════════════════════════════
// muda fires events on the main thread (NSResponder chain). We push into an
// unbounded tokio mpsc so the iced subscription — which runs on a tokio worker
// — can consume them asynchronously without blocking the UI thread.

// The menu event channel is lazily constructed by `channel_state()` —
// called from both `install()` (producer side) and
// `menu_event_stream()` (consumer side). Doing it lazily means the
// subscription doesn't need to race `install()`: whichever side
// touches the channel first creates it, and the other side sees the
// same pair. Previously install() created the channel and the
// subscription sometimes ran first, grabbing `None` and idling.
struct ChannelState {
    sender: UnboundedSender<MenuCommand>,
    receiver: Mutex<Option<UnboundedReceiver<MenuCommand>>>,
}

fn channel_state() -> &'static ChannelState {
    static CHANNEL: OnceLock<ChannelState> = OnceLock::new();
    CHANNEL.get_or_init(|| {
        let (sender, receiver) = unbounded_channel();
        ChannelState {
            sender,
            receiver: Mutex::new(Some(receiver)),
        }
    })
}

// Guard against double-install. muda::Menu holds an Rc so it isn't
// `Send` — we can't put the menu itself in a static, but we can flag
// that it has been created. The menu stays alive via `Box::leak` in
// `install` since cocoa retains the NSMenu pointer internally.
static MENU_INSTALLED: OnceLock<()> = OnceLock::new();

/// Install the NSMenu. Must be called on the main thread *after* NSApp is
/// alive — in iced that means from inside the `update()` handler, which
/// is the first point where we're guaranteed to be running on the cocoa
/// main thread with an initialized NSApplication. Safe to call multiple
/// times: only the first invocation does work.
pub fn install() {
    #[cfg(target_os = "macos")]
    {
        if MENU_INSTALLED.get().is_some() {
            return;
        }
        // Force the channel into existence before muda can fire. The
        // subscription may already have called `channel_state()` and
        // taken ownership of the receiver; that's fine — we just need
        // the sender side, which is shared.
        let _ = channel_state();

        let menu = match build_menu() {
            Ok(m) => m,
            Err(e) => {
                tracing::warn!(error = %e, "macmenu: build failed; keybinds still work");
                return;
            }
        };
        menu.init_for_nsapp();

        MenuEvent::set_event_handler(Some(|ev: MenuEvent| {
            let id_string = ev.id().as_ref().to_string();
            if let Some(cmd) = MenuCommand::from_id(&id_string) {
                let _ = channel_state().sender.send(cmd);
            }
        }));

        // Intentionally leak: cocoa now holds the NSMenu; dropping the
        // rust-side wrapper would unregister it. One-shot per process.
        Box::leak(Box::new(menu));
        let _ = MENU_INSTALLED.set(());
    }
    #[cfg(not(target_os = "macos"))]
    {
        // No-op on non-macOS; the iced keybinds are the sole input path.
    }
}

/// Take ownership of the receiver side of the menu-event channel. Called
/// exactly once by the iced subscription — a second call returns `None`.
pub fn take_receiver() -> Option<UnboundedReceiver<MenuCommand>> {
    channel_state().receiver.lock().ok()?.take()
}

/// Stream function suitable for `iced::Subscription::run`. Produces each
/// `MenuCommand` the native menu emits, one at a time.
pub fn menu_event_stream() -> impl futures::Stream<Item = MenuCommand> {
    use futures::SinkExt;
    iced::stream::channel(
        32,
        async |mut output: futures::channel::mpsc::Sender<MenuCommand>| {
            let Some(mut rx) = take_receiver() else {
                // Receiver already claimed (e.g. subscription got
                // re-registered on a hot reload). Idle forever so the
                // stream stays alive but emits nothing.
                std::future::pending::<()>().await;
                return;
            };
            while let Some(cmd) = rx.recv().await {
                if output.send(cmd).await.is_err() {
                    break;
                }
            }
        },
    )
}

// ═══ Menu construction ═════════════════════════════════════════════════════
#[cfg(target_os = "macos")]
fn build_menu() -> muda::Result<Menu> {
    let menu = Menu::new();

    // App menu — cocoa convention: the first submenu's name is
    // overridden by NSApplication, so the first item row will actually
    // show "aura-term" with the real app name.
    let app_menu = Submenu::new("aura-term", true);
    app_menu.append_items(&[
        &PredefinedMenuItem::about(
            Some("About aura-term"),
            Some(AboutMetadata {
                name: Some("aura-term".into()),
                version: Some(env!("CARGO_PKG_VERSION").into()),
                copyright: Some("Aura".into()),
                ..Default::default()
            }),
        ),
        &PredefinedMenuItem::separator(),
        &PredefinedMenuItem::services(None),
        &PredefinedMenuItem::separator(),
        &PredefinedMenuItem::hide(None),
        &PredefinedMenuItem::hide_others(None),
        &PredefinedMenuItem::show_all(None),
        &PredefinedMenuItem::separator(),
        &PredefinedMenuItem::quit(None),
    ])?;
    menu.append(&app_menu)?;

    // File — minimal for now. Open Folder drives the same folder-picker
    // rfd dialog the composer already spawns.
    let file_menu = Submenu::new("File", true);
    let open_folder = MenuItem::with_id(
        MenuId::new(MenuCommand::OpenFolder.id()),
        "Open Folder…",
        true,
        Some(Accelerator::new(Some(Modifiers::SUPER), Code::KeyO)),
    );
    let save_file = MenuItem::with_id(
        MenuId::new(MenuCommand::Save.id()),
        "Save",
        true,
        Some(Accelerator::new(Some(Modifiers::SUPER), Code::KeyS)),
    );
    file_menu.append_items(&[
        &open_folder,
        &PredefinedMenuItem::separator(),
        &save_file,
        &PredefinedMenuItem::separator(),
        &PredefinedMenuItem::close_window(None),
    ])?;
    menu.append(&file_menu)?;

    // Edit — predefined items only, so they route through the cocoa
    // responder chain and hit the focused text_input natively. We do NOT
    // add a custom Paste for the PTY here — ⌘V into the terminal still
    // flows via `dispatch_key_event` → `Message::Paste` so the bracketed-
    // paste wrapper can kick in.
    let edit_menu = Submenu::new("Edit", true);
    edit_menu.append_items(&[
        &PredefinedMenuItem::undo(None),
        &PredefinedMenuItem::redo(None),
        &PredefinedMenuItem::separator(),
        &PredefinedMenuItem::cut(None),
        &PredefinedMenuItem::copy(None),
        &PredefinedMenuItem::paste(None),
        &PredefinedMenuItem::select_all(None),
        &PredefinedMenuItem::separator(),
        &MenuItem::with_id(
            MenuId::new(MenuCommand::FocusSearch.id()),
            "Find in Topbar",
            true,
            Some(Accelerator::new(Some(Modifiers::SUPER), Code::KeyF)),
        ),
    ])?;
    menu.append(&edit_menu)?;

    // View.
    let view_menu = Submenu::new("View", true);
    let t_terminal = MenuItem::with_id(
        MenuId::new(MenuCommand::ToggleTerminal.id()),
        "Toggle Terminal Panel",
        true,
        None,
    );
    let t_review = MenuItem::with_id(
        MenuId::new(MenuCommand::ToggleReview.id()),
        "Toggle Review Panel",
        true,
        None,
    );
    let t_rs = MenuItem::with_id(
        MenuId::new(MenuCommand::ToggleRightSidebar.id()),
        "Toggle Right Sidebar",
        true,
        None,
    );
    let t_log = MenuItem::with_id(
        MenuId::new(MenuCommand::ToggleLogOutput.id()),
        "Toggle Log Output",
        true,
        Some(Accelerator::new(
            Some(Modifiers::SUPER | Modifiers::SHIFT),
            Code::KeyL,
        )),
    );
    let t_full = MenuItem::with_id(
        MenuId::new(MenuCommand::ToggleFullscreenTerminal.id()),
        "Fullscreen Terminal",
        true,
        Some(Accelerator::new(
            Some(Modifiers::SUPER | Modifiers::SHIFT),
            Code::Enter,
        )),
    );
    let zoom_in = MenuItem::with_id(
        MenuId::new(MenuCommand::ZoomIn.id()),
        "Zoom In",
        true,
        Some(Accelerator::new(Some(Modifiers::SUPER), Code::Equal)),
    );
    let zoom_out = MenuItem::with_id(
        MenuId::new(MenuCommand::ZoomOut.id()),
        "Zoom Out",
        true,
        Some(Accelerator::new(Some(Modifiers::SUPER), Code::Minus)),
    );
    let zoom_reset = MenuItem::with_id(
        MenuId::new(MenuCommand::ZoomReset.id()),
        "Actual Size",
        true,
        Some(Accelerator::new(Some(Modifiers::SUPER), Code::Digit0)),
    );
    view_menu.append_items(&[
        &t_terminal,
        &t_review,
        &t_rs,
        &PredefinedMenuItem::separator(),
        &t_log,
        &t_full,
        &PredefinedMenuItem::separator(),
        &zoom_in,
        &zoom_out,
        &zoom_reset,
    ])?;
    menu.append(&view_menu)?;

    // Go — aura-specific navigation commands.
    let go_menu = Submenu::new("Go", true);
    let palette = MenuItem::with_id(
        MenuId::new(MenuCommand::CommandPalette.id()),
        "Command Palette…",
        true,
        Some(Accelerator::new(Some(Modifiers::SUPER), Code::KeyK)),
    );
    // ⌘H is reserved by cocoa for "Hide aura-term", so handover uses
    // ⇧⌘H. dispatch_key_event's prior ⌘H binding is removed to avoid a
    // double-fire when muda swallows the event.
    let handover = MenuItem::with_id(
        MenuId::new(MenuCommand::Handover.id()),
        "Handover",
        true,
        Some(Accelerator::new(
            Some(Modifiers::SUPER | Modifiers::SHIFT),
            Code::KeyH,
        )),
    );

    // Rail pane shortcuts — ⌘1..⌘7 mirror the 7 pane tiles in the nav
    // rail, so users can switch the work surface without reaching for
    // the mouse. Order intentionally matches the rail cluster
    // top-to-bottom so muscle memory transfers between the two.
    let pane_items: Vec<MenuItem> = [
        (Pane::Work, "Work", Code::Digit1),
        (Pane::Plan, "Plan", Code::Digit2),
        (Pane::Impacts, "Impacts", Code::Digit3),
        (Pane::Proof, "Proof", Code::Digit4),
        (Pane::Memory, "Memory", Code::Digit5),
        (Pane::Timeline, "Timeline", Code::Digit6),
        (Pane::Doctor, "Doctor", Code::Digit7),
    ]
    .into_iter()
    .map(|(pane, label, code)| {
        MenuItem::with_id(
            MenuId::new(MenuCommand::SelectPane(pane).id()),
            label,
            true,
            Some(Accelerator::new(Some(Modifiers::SUPER), code)),
        )
    })
    .collect();

    go_menu.append_items(&[&palette, &handover, &PredefinedMenuItem::separator()])?;
    for item in &pane_items {
        go_menu.append(item)?;
    }
    menu.append(&go_menu)?;

    // Window — predefined so macOS manages them.
    let window_menu = Submenu::new("Window", true);
    window_menu.append_items(&[
        &PredefinedMenuItem::minimize(None),
        &PredefinedMenuItem::maximize(None),
        &PredefinedMenuItem::separator(),
        &PredefinedMenuItem::bring_all_to_front(None),
    ])?;
    menu.append(&window_menu)?;

    Ok(menu)
}
