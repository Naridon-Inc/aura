use iced::widget::Id;
use iced::{Element, Subscription, Task, Theme, window};
use std::env;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, LazyLock, Mutex as StdMutex};

/// Shared between the App update loop and the keyboard-dispatch
/// subscription. `dispatch_key_event` reads this synchronously to decide
/// whether to emit `Message::PtyInput` — a plain field on App can't be
/// read from a static subscription closure, and a per-Message flag races
/// with the widget's own `on_input` callback (PtyInput is queued before
/// `Message::Composer(TextChanged)`, so a post-hoc guard flip arrives
/// too late). Atomic is flipped OFF on every Composer message and ON
/// only when the user clicks the PTY grid.
static PTY_CAPTURES_KEYS: AtomicBool = AtomicBool::new(false);

use aura_blocks::Block;
use aura_blockstore::{BlockFilter, BlockStore};

use crate::bridge::Bridge;

pub static SEARCH_INPUT_ID: LazyLock<Id> = LazyLock::new(Id::unique);
pub static SIDEBAR_SEARCH_INPUT_ID: LazyLock<Id> = LazyLock::new(Id::unique);
pub static COMMIT_MESSAGE_INPUT_ID: LazyLock<Id> = LazyLock::new(Id::unique);

use crate::{agents, completion, config, fixtures, pty, pty_sub, shell_integration, theme, ui};

pub fn title(_state: &App) -> String {
    String::from("AURA")
}

const PROJECT_ACCENTS: &[(u8, u8, u8)] = &[
    (0x7c, 0x3a, 0xed), // violet
    (0x22, 0x9a, 0xff), // blue
    (0x10, 0xb9, 0x81), // emerald
    (0xf4, 0x74, 0x3b), // orange
    (0xef, 0x44, 0x4b), // red
    (0xd4, 0x7d, 0xff), // lilac
    (0xf2, 0xbf, 0x3b), // amber
];

fn workspace_from_path(path: &std::path::Path) -> fixtures::Workspace {
    let path_str = path.to_string_lossy().into_owned();
    let name = path
        .file_name()
        .map(|s| s.to_string_lossy().into_owned())
        .filter(|s| !s.is_empty())
        .unwrap_or_else(|| path_str.clone());
    let letter = name
        .chars()
        .find(|c| c.is_alphanumeric())
        .unwrap_or('?')
        .to_ascii_uppercase();
    let hash: u64 = path_str.bytes().fold(0u64, |a, b| a.wrapping_mul(31).wrapping_add(b as u64));
    let (r, g, b) = PROJECT_ACCENTS[(hash as usize) % PROJECT_ACCENTS.len()];
    let accent = iced::Color::from_rgb8(r, g, b);
    let last_opened = time::OffsetDateTime::now_utc().unix_timestamp() as u64;
    fixtures::Workspace {
        id: path_str.clone(),
        name,
        path: path_str,
        avatar_letter: letter,
        last_opened,
        accent,
    }
}

fn load_blocks(store: &BlockStore, limit: u32) -> Vec<(Block, Vec<u8>)> {
    let filter = BlockFilter {
        limit: Some(limit),
        ..Default::default()
    };
    let blocks = store.list_blocks(&filter).unwrap_or_default();
    let rings = store.rings();
    let mut out = Vec::with_capacity(blocks.len());
    for block in blocks.into_iter().rev() {
        let output = rings
            .get(block.id)
            .map(|ring| {
                ring.read_since(0)
                    .into_iter()
                    .flat_map(|chunk| chunk.bytes)
                    .collect::<Vec<_>>()
            })
            .unwrap_or_default();
        out.push((block, output));
    }
    out
}

/// Refresh in-memory output for the currently-running block from its ring
/// buffer, without re-querying SQLite. Called on every PTY Output event so
/// the live block card streams in near real time.
fn refresh_running_block_output(state: &mut App) {
    let (Some(store), Some(bridge)) = (state.store.as_ref(), state.bridge.as_ref()) else {
        return;
    };
    let cur_id = match bridge.lock() {
        Ok(g) => g.current_block(),
        Err(_) => None,
    };
    let Some(cur_id) = cur_id else { return };
    let Some(ring) = store.rings().get(cur_id) else { return };
    let bytes: Vec<u8> = ring
        .read_since(0)
        .into_iter()
        .flat_map(|c| c.bytes)
        .collect();
    for (b, out) in state.blocks.iter_mut() {
        if b.id == cur_id {
            *out = bytes;
            return;
        }
    }
}

/// Render the thin bottom status bar under the ribbon. Shows daemon
/// connectivity, active worktree (branch + cwd basename), block count, and
/// the log-output toggle state (⌘⇧L). Always mounted on non-Empty screens —
/// no settings-gated visibility, per the wave's "optional thin strip"
/// simplification.
/// Ephemeral chip data the live-sync producer writes to
/// `.aura/live_sync_status.json`. The file lives per-worktree and is
/// updated by the `aura live-sync-*` CLI paths. Missing file = no
/// active sync → chip hides. Malformed file = same (silent-fail).
#[derive(Debug, Clone, Default, serde::Deserialize)]
struct LiveSyncSnapshot {
    #[serde(default)]
    pushing: bool,
    #[serde(default)]
    pending: u32,
    #[serde(default)]
    last_event: Option<LiveSyncEvent>,
}

#[derive(Debug, Clone, serde::Deserialize)]
struct LiveSyncEvent {
    #[serde(default)]
    kind: String, // "msg" | "impact" | "pulled" | "pushing"
    #[serde(default)]
    detail: String,
}

fn read_live_sync(cwd: &std::path::Path) -> Option<LiveSyncSnapshot> {
    let path = cwd.join(".aura").join("live_sync_status.json");
    let text = std::fs::read_to_string(&path).ok()?;
    serde_json::from_str::<LiveSyncSnapshot>(&text).ok()
}

fn mini_statusbar(state: &App) -> Element<'_, Message> {
    use iced::widget::{container, row, text, Space};
    use iced::{Alignment, Length, Padding};

    let daemon_label = if state.daemon.is_some() {
        "daemon ● connected"
    } else {
        "daemon ○ offline"
    };
    let daemon_color = if state.daemon.is_some() {
        theme::GREEN
    } else {
        theme::TEXT_3
    };

    let branch = state
        .git_branch
        .as_deref()
        .unwrap_or("(no branch)")
        .to_string();
    let cwd_leaf = state
        .cwd
        .file_name()
        .and_then(|s| s.to_str())
        .unwrap_or("")
        .to_string();
    let worktree_label = if cwd_leaf.is_empty() {
        branch.clone()
    } else {
        format!("{cwd_leaf} · {branch}")
    };

    let block_label = format!("{} blocks", state.blocks.len());
    let log_label = if state.show_log_output {
        "log ●"
    } else {
        "log ○"
    };

    let mode_label = if state.fullscreen_terminal {
        "⛶ fullscreen · ⌘⇧↵ exit"
    } else {
        "⌘⇧↵ fullscreen"
    };

    // Live-sync chip slot: rendered only when the CLI-written snapshot
    // exists. Keeps the statusbar quiet for single-developer repos
    // while surfacing pushing/pulling + recent wire events when the
    // mothership path is active. Per the IA doc's Q4, this is the
    // terminal's UI for live-sync visibility.
    let sync_snapshot = read_live_sync(&state.cwd);
    let sync_chip: Element<'_, Message> = if let Some(s) = sync_snapshot.as_ref() {
        let (label, color) = if s.pushing {
            ("sync ● pushing".to_string(), theme::AMBER)
        } else if let Some(ev) = s.last_event.as_ref() {
            let kind = match ev.kind.as_str() {
                "msg" => "msg",
                "impact" => "impact",
                "pulled" => "pulled",
                "pushing" => "pushing",
                other => other,
            };
            let detail = if ev.detail.is_empty() {
                String::new()
            } else {
                format!(" · {}", ev.detail)
            };
            (format!("sync · {kind}{detail}"), theme::ACCENT_GREEN)
        } else if s.pending > 0 {
            (format!("sync · {} pending", s.pending), theme::TEXT_3)
        } else {
            ("sync · idle".to_string(), theme::TEXT_3)
        };
        row![
            text(label).size(theme::SZ_MICRO).color(color),
            Space::new().width(Length::Fixed(theme::P_MD)),
        ]
        .align_y(Alignment::Center)
        .into()
    } else {
        Space::new().width(Length::Fixed(0.0)).height(0.0).into()
    };

    let content = row![
        text(daemon_label).size(theme::SZ_MICRO).color(daemon_color),
        Space::new().width(Length::Fixed(theme::P_MD)),
        text(worktree_label)
            .size(theme::SZ_MICRO)
            .color(theme::TEXT_3),
        Space::new().width(Length::Fixed(theme::P_MD)),
        text(block_label)
            .size(theme::SZ_MICRO)
            .color(theme::TEXT_3),
        Space::new().width(Length::Fixed(theme::P_MD)),
        sync_chip,
        Space::new().width(Length::Fill),
        text(mode_label).size(theme::SZ_MICRO).color(theme::TEXT_3),
        Space::new().width(Length::Fixed(theme::P_MD)),
        text(log_label).size(theme::SZ_MICRO).color(theme::TEXT_3),
    ]
    .align_y(Alignment::Center)
    .padding(Padding::from([0, 12]));

    container(content)
        .width(Length::Fill)
        .height(Length::Fixed(22.0))
        .style(|_| iced::widget::container::Style::default().background(theme::BG_DEEP))
        .into()
}

/// Shell out to `aura handover --agent claude` and capture stdout. Called
/// from `Message::HandoverAction(Open)` so the modal renders "Generating
/// payload…" while the subprocess runs; the result is delivered as
/// `Message::HandoverPayload`.
async fn run_handover(cwd: std::path::PathBuf) -> Result<String, String> {
    tokio::task::spawn_blocking(move || {
        let output = std::process::Command::new("aura")
            .arg("handover")
            .arg("--agent")
            .arg("claude")
            .current_dir(&cwd)
            .output()
            .map_err(|e| format!("failed to spawn aura: {e}"))?;
        if !output.status.success() {
            let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();
            return Err(if stderr.is_empty() {
                format!("aura handover exited {}", output.status)
            } else {
                stderr
            });
        }
        Ok(String::from_utf8_lossy(&output.stdout).into_owned())
    })
    .await
    .map_err(|e| format!("join error: {e}"))?
}

fn dispatch_key_event(
    event: iced::Event,
    status: iced::event::Status,
    _window: iced::window::Id,
) -> Option<Message> {
    let iced::Event::Keyboard(iced::keyboard::Event::KeyPressed {
        key,
        modifiers,
        text,
        ..
    }) = event
    else {
        return None;
    };

    // App shortcuts. On macOS the Command-menu accelerators listed in
    // `macmenu` (⌘K palette, ⇧⌘H handover, ⇧⌘L log toggle, ⇧⌘↵
    // fullscreen, ⌘+/-/0 zoom, ⌘O open folder, ⌘F find) fire through
    // NSMenu and never reach this point — we only handle the keys the
    // menu doesn't claim. Non-macOS builds (no muda) still need the
    // full set below, hence the cfg-gated branches.
    if modifiers.command() {
        if let iced::keyboard::Key::Character(ref c) = key {
            return match c.as_str() {
                // PTY clipboard: only fires when no widget captured the
                // event. For composer text_input the native path handles
                // paste/copy; for the PTY canvas we intercept here.
                "v" if !matches!(status, iced::event::Status::Captured) => {
                    Some(Message::Paste)
                }
                "c" if !matches!(status, iced::event::Status::Captured) => {
                    Some(Message::CopySelection)
                }
                // Fallback keybinds for non-macOS (or if muda failed to
                // install). The mac menu accelerator supersedes these
                // when present.
                #[cfg(not(target_os = "macos"))]
                "k" => Some(Message::PaletteOpen),
                #[cfg(not(target_os = "macos"))]
                "f" => Some(Message::FocusSearch),
                #[cfg(not(target_os = "macos"))]
                "h" if modifiers.shift() => {
                    Some(Message::HandoverAction(ui::handover::Action::Open))
                }
                #[cfg(not(target_os = "macos"))]
                "l" if modifiers.shift() => Some(Message::ToggleLogOutput),
                #[cfg(not(target_os = "macos"))]
                "=" | "+" => Some(Message::ScaleUp),
                #[cfg(not(target_os = "macos"))]
                "-" | "_" => Some(Message::ScaleDown),
                #[cfg(not(target_os = "macos"))]
                "0" => Some(Message::ScaleReset),
                #[cfg(not(target_os = "macos"))]
                "o" => Some(Message::OpenFolderDialog),
                // ⌘1–⌘7 pane shortcuts (non-macOS; on macOS the NSMenu
                // accelerator fires before we see the event). Keep the
                // order identical to the rail tile cluster so muscle
                // memory transfers between platforms.
                #[cfg(not(target_os = "macos"))]
                "1" => Some(Message::SelectPane(Pane::Work)),
                #[cfg(not(target_os = "macos"))]
                "2" => Some(Message::SelectPane(Pane::Plan)),
                #[cfg(not(target_os = "macos"))]
                "3" => Some(Message::SelectPane(Pane::Impacts)),
                #[cfg(not(target_os = "macos"))]
                "4" => Some(Message::SelectPane(Pane::Proof)),
                #[cfg(not(target_os = "macos"))]
                "5" => Some(Message::SelectPane(Pane::Memory)),
                #[cfg(not(target_os = "macos"))]
                "6" => Some(Message::SelectPane(Pane::Timeline)),
                #[cfg(not(target_os = "macos"))]
                "7" => Some(Message::SelectPane(Pane::Doctor)),
                _ => None,
            };
        }
        // Fullscreen terminal — fallback for non-macOS; the mac menu
        // registers this as ⇧⌘↵.
        #[cfg(not(target_os = "macos"))]
        {
            if let iced::keyboard::Key::Named(iced::keyboard::key::Named::Enter) = key {
                if modifiers.shift() {
                    return Some(Message::ToggleFullscreenTerminal);
                }
            }
        }
        return None;
    }

    // Shift+PageUp / Shift+PageDown scroll the PTY viewport through
    // scrollback without touching the alt-screen. 10 lines per hit matches
    // what iTerm2/Terminal.app ship with.
    if modifiers.shift() && !modifiers.command() && !modifiers.control() {
        if let iced::keyboard::Key::Named(named) = &key {
            match named {
                iced::keyboard::key::Named::PageUp => {
                    return Some(Message::PtyScrollLines(10));
                }
                iced::keyboard::key::Named::PageDown => {
                    return Some(Message::PtyScrollLines(-10));
                }
                _ => {}
            }
        }
    }

    // Completion popup: Tab cycles, Shift+Tab cycles back. Intercepted
    // before the composer sees it so these keys drive the popup rather
    // than the text_input's defaults. Esc is handled below via EscapeKey
    // so the palette + completion + server-menu all share one precedence
    // ladder in the update handler.
    if let iced::keyboard::Key::Named(named) = &key {
        match named {
            iced::keyboard::key::Named::Tab if !modifiers.command() && !modifiers.control() => {
                // Tab applies the current (top or selected) completion.
                // Shift+Tab cycles backward in case the user wants a
                // different candidate before applying.
                if modifiers.shift() {
                    return Some(Message::CompletionCycle(-1));
                }
                return Some(Message::CompletionApply);
            }
            iced::keyboard::key::Named::Escape if modifiers.is_empty() => {
                return Some(Message::EscapeKey);
            }
            _ => {}
        }
    }

    // ArrowUp / ArrowDown route through a generic ArrowKey so the update
    // handler can steer them: palette selection when open, composer prompt
    // history otherwise. We take precedence over text_input's default
    // capture of these keys (which for a single-line input is a no-op
    // anyway).
    if modifiers.is_empty() {
        if let iced::keyboard::Key::Named(named) = &key {
            match named {
                iced::keyboard::key::Named::ArrowUp => {
                    return Some(Message::ArrowKey(-1));
                }
                iced::keyboard::key::Named::ArrowDown => {
                    return Some(Message::ArrowKey(1));
                }
                _ => {}
            }
        }
    }

    // If the composer (or any other widget) already consumed the event,
    // don't echo it into the PTY — otherwise typing the prompt would also
    // execute in the shell.
    if matches!(status, iced::event::Status::Captured) {
        return None;
    }

    // Authoritative gate: PTY only sees keystrokes when the user has
    // explicitly clicked the terminal. A composer keystroke flips this
    // off synchronously before the text_input even emits its on_input
    // callback, so there's no race where the first character leaks into
    // the shell.
    if !PTY_CAPTURES_KEYS.load(Ordering::Relaxed) {
        return None;
    }
    let text_str = text.as_ref().map(|s| s.as_str());
    pty_sub::key_to_pty_bytes(&key, modifiers, text_str).map(Message::PtyInput)
}

pub fn theme(_state: &App) -> Theme {
    Theme::Dark
}

pub fn scale_factor(state: &App) -> f32 {
    state.ui_scale
}

/// iced entry point wired from `main.rs` — parses the same `--screen X` CLI
/// flag proto's binary exposed and yields the initial `App`.
pub fn init() -> (App, Task<Message>) {
    let args: Vec<String> = env::args().collect();
    let mut initial_screen = Screen::Empty;

    if let Some(pos) = args.iter().position(|a| a == "--screen") {
        if pos + 1 < args.len() {
            match args[pos + 1].as_str() {
                "empty" => initial_screen = Screen::Empty,
                "active" => initial_screen = Screen::Active,
                "palette" => initial_screen = Screen::Palette,
                "settings" => initial_screen = Screen::Settings,
                _ => {}
            }
        }
    }

    // Deferring native menu installation through a Task guarantees it
    // runs after iced's winit event loop has booted NSApplication —
    // calling `init_for_nsapp` eagerly from here would find no NSApp
    // and silently no-op (or crash depending on muda version).
    (App::new(initial_screen), Task::done(Message::InstallMenu))
}

pub fn update(state: &mut App, message: Message) -> Task<Message> {
    state.update(message)
}

pub fn view(state: &App) -> Element<'_, Message> {
    state.view()
}

pub fn subscription(state: &App) -> Subscription<Message> {
    state.subscription()
}

#[derive(Clone, Copy, Debug, PartialEq)]
pub enum Screen {
    Empty,
    Active,
    Collapsed,
    Palette,
    Settings,
}

#[derive(Clone, Copy, Debug, PartialEq)]
pub enum ResizeTarget {
    Sidebar,
    Terminal,
    Review,
    RightSidebar,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum SidebarTab {
    Files,
    Git,
    Sessions,
    Search,
    Semantic,
    Team,
}

impl Default for SidebarTab {
    fn default() -> Self {
        SidebarTab::Files
    }
}

/// Which work-pane body fills the main surface when no file is open. Drives
/// the empty-state body routing (M6). The variants mirror term's existing
/// `ui::panes::*` modules (still orphan at M2 — wired in M6).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Pane {
    Work,
    Plan,
    Impacts,
    Team,
    Proof,
    Memory,
    Timeline,
    Doctor,
    Orchestration,
    Conflict,
    Handover,
}

impl Default for Pane {
    fn default() -> Self {
        Pane::Work
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum RightSidebarTab {
    Blocks,
    Activity,
    Orchestration,
}

impl Default for RightSidebarTab {
    fn default() -> Self {
        RightSidebarTab::Blocks
    }
}

/// Which surface last received keyboard input from the user — the
/// composer prompt or the PTY grid. Used as the authoritative guard on
/// `Message::PtyInput`: when the user is typing in the composer, any
/// stray `terminal_focus = true` (e.g. from a hover-driven mouse_area
/// glitch) is overridden and PTY writes are suppressed.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum InputSurface {
    Composer,
    Pty,
}

impl Default for InputSurface {
    fn default() -> Self {
        InputSurface::Composer
    }
}

/// Composer tab-completion popup state. Driven by the `completion` engine
/// off the composer text on every keystroke; cycled by Tab; applied by
/// Enter; dismissed by Esc or a non-matching edit.
#[derive(Debug, Clone, Default)]
pub struct CompletionUi {
    pub candidates: Vec<completion::Candidate>,
    pub selected: usize,
}

impl CompletionUi {
    pub fn is_open(&self) -> bool {
        !self.candidates.is_empty()
    }
}

#[derive(Debug, Clone)]
pub enum Message {
    None,
    ToggleSidebar,
    NewSession,
    NavBack,
    NavForward,
    StartDrag,
    ResizeStart(ResizeTarget),
    ResizeMove { x: f32, y: f32 },
    ResizeEnd,
    WindowResized(iced::Size),
    OpenProject(String),
    CloseWorkspace,
    ToggleTerminal,
    /// Pin the terminal panel to the whole work surface, hiding the
    /// composer, sidebars, and pane picker. Aura instrumentation keeps
    /// running; palette/handover/composer keybinds remain active.
    ToggleFullscreenTerminal,
    /// Mouse-wheel scroll over the PTY grid — positive y scrolls the
    /// viewport toward older history; negative y scrolls back toward the
    /// live bottom.
    PtyScroll(iced::mouse::ScrollDelta),
    /// Keyboard scrollback (Shift+PgUp / Shift+PgDn). Positive `lines`
    /// moves toward older history, negative toward the live bottom.
    PtyScrollLines(i32),
    ToggleReview,
    ToggleRightSidebar,
    ToggleServerMenu,
    DismissOverlays,
    SearchInput(String),
    SearchSubmit,
    FocusSearch,
    SelectSidebarTab(SidebarTab),
    SidebarSearchInput(String),
    GitCommitMessageInput(String),
    GitCommitSubmit,
    GitToggleStaged,
    GitToggleChanges,
    ScaleUp,
    ScaleDown,
    ScaleReset,
    Composer(ui::composer::ComposerMessage),
    Submit(ui::composer::Submission),
    CompletionCycle(i32),
    CompletionApply,
    CompletionDismiss,
    PaletteOpen,
    PaletteClose,
    PaletteQuery(String),
    PaletteMove(i32),
    PaletteSubmit,
    PaletteClick(usize),
    ArrowKey(i32),
    EscapeKey,
    SelectPane(Pane),
    SelectRightSidebarTab(RightSidebarTab),
    ActivityFilter(ui::activity::Filter),
    HandoverAction(ui::handover::Action),
    HandoverPayload(Result<String, String>),
    HandoverCopy,
    ToggleLogOutput,
    OpenSettings,
    CloseSettings,
    PtyEvent(pty::PtyEvent),
    PtyInput(bytes::Bytes),
    TerminalFocus(bool),
    Paste,
    PasteReceived(String),
    CopySelection,
    RunAura(&'static str),
    SwitchWorktree(std::path::PathBuf),
    OpenFolderDialog,
    FolderPicked(Option<std::path::PathBuf>),
    ToggleNewWorktree,
    NewWorktreeInput(String),
    NewWorktreeSubmit,
    CancelNewWorktree,
    ToggleFileTreeDir(std::path::PathBuf),
    SelectFile(std::path::PathBuf),
    /// Close an open editor tab. Skips dirty-check for now — Cmd+S first.
    CloseEditorTab(std::path::PathBuf),
    /// Forwarded from `text_editor::on_action` — applied to the active
    /// file's `Content` and toggles `editor_dirty` if the action mutates.
    EditorAction(iced::widget::text_editor::Action),
    /// Persist the active editor buffer back to disk. Bound to ⌘S /
    /// MenuCommand::Save. No-op if no file is active or the buffer is clean.
    SaveActiveFile,
    /// Flip the editor's diff toggle. When turning on (or already on
    /// while switching files), the diff buffer is recomputed from
    /// `git diff -- <active_file>` so the side panel reflects the
    /// current working-tree state.
    ToggleEditorDiff,
    /// No-op event handler for the read-only diff text_editor — swallows
    /// keyboard actions so the user can scroll/select but not type into it.
    DiffEditorAction(iced::widget::text_editor::Action),
    RefreshGitStatus,
    /// Install the native macOS menubar. Fired once from the startup
    /// Task returned by `init()`; `macmenu::install` is idempotent so a
    /// stray re-fire is harmless.
    InstallMenu,
    /// Native menu item clicked or accelerator fired. Dispatched back to
    /// the matching app-level `Message` in the update handler so the
    /// menu is strictly an alternate input — never holds its own state.
    MenuCommand(crate::macmenu::MenuCommand),
}

pub struct App {
    pub screen: Screen,
    pub sidebar_open: bool,
    pub sidebar_width: f32,
    pub terminal_open: bool,
    pub terminal_height: f32,
    pub review_open: bool,
    pub review_width: f32,
    pub right_sidebar_open: bool,
    pub right_sidebar_width: f32,
    pub server_menu_open: bool,
    pub resizing: Option<ResizeTarget>,
    pub window_size: iced::Size,
    pub current_workspace: Option<fixtures::Workspace>,
    pub workspaces: Vec<fixtures::Workspace>,
    pub sessions: Vec<fixtures::Session>,
    pub composer: ui::composer::Composer,
    pub search_query: String,
    pub sidebar_tab: SidebarTab,
    pub sidebar_search_query: String,
    pub git_commit_message: String,
    pub git_staged_expanded: bool,
    pub git_changes_expanded: bool,
    pub current_file: Option<fixtures::OpenFile>,
    /// Per-file editable text buffers backing the modern code editor.
    /// Stored separately from `current_file` because `text_editor::Content`
    /// owns mutable buffer state that `OpenFile` (a snapshot view model)
    /// can't represent. Inserted lazily on first SelectFile and reused on
    /// subsequent tab switches so the cursor + undo history persist.
    pub editor_buffers: std::collections::HashMap<std::path::PathBuf, iced::widget::text_editor::Content>,
    /// Files with unsaved buffer changes — rendered as a • dot in the tab
    /// strip and gates the discard-on-close confirmation.
    pub editor_dirty: std::collections::HashSet<std::path::PathBuf>,
    /// Toggled by the editor toolbar's Diff button. When true the editor
    /// surface splits in two (editor | unified diff) so the user can review
    /// pending changes vs HEAD without leaving the file.
    pub editor_show_diff: bool,
    /// Cached `git diff` content for the currently-displayed diff pane,
    /// stored as a `text_editor::Content` so it gets the same monospace
    /// renderer + selection/copy as the editor itself. Refreshed every
    /// time the diff is opened or the active file changes while open.
    pub editor_diff_buffer: Option<iced::widget::text_editor::Content>,
    pub ui_scale: f32,
    pub prev_screen: Option<Screen>,
    pub pty_session: Option<Arc<pty::PtySession>>,
    pub pty_grid: ui::pty_grid::GridCanvas,
    pub terminal_focus: bool,
    /// Most recent surface the user interacted with — composer vs PTY.
    /// Authoritative override for the PTY-keystroke guard: even if
    /// `terminal_focus` was accidentally set true by a stray mouse_area
    /// click, if the user has been typing in the composer more recently
    /// than they clicked the PTY, their keystrokes stay in the composer.
    pub last_input_surface: InputSurface,
    pub status: String,
    pub store: Option<Arc<BlockStore>>,
    pub bridge: Option<Arc<StdMutex<Bridge>>>,
    pub blocks: Vec<(Block, Vec<u8>)>,
    pub cwd: std::path::PathBuf,
    pub shell: String,
    pub git_branch: Option<String>,
    pub worktrees: Vec<config::WorktreeInfo>,
    /// `Some("")` = inline input is open (the "+ New worktree…" row swaps
    /// into a text input); `None` = button mode. Submit runs
    /// `git worktree add` + switches to the new worktree.
    pub new_worktree_input: Option<String>,
    /// Expanded directories in the Files sidebar. Root (= `cwd`) is always
    /// expanded implicitly.
    pub file_tree_expanded: std::collections::HashSet<std::path::PathBuf>,
    /// Last file clicked in the file tree. Drives the selection bar/fill in
    /// the tree row and is the handle the editor area will read.
    pub selected_file: Option<std::path::PathBuf>,
    /// LRU of recently-opened files. The editor renders these as tabs (most
    /// recent first). Capped to keep the tab strip readable.
    pub recent_files: Vec<std::path::PathBuf>,
    /// Porcelain git-status snapshot keyed by absolute path. Refreshed on
    /// cwd change, folder-picked, worktree-switched, and after aura actions.
    pub git_status: std::collections::HashMap<std::path::PathBuf, char>,

    // --- term-feature fields (populated wave-by-wave) -----------------------
    /// Embedded aura-daemon (M3) — serves the same `Arc<BlockStore>` and
    /// PTY session list over the Unix socket so external clients
    /// (aura-cli, IDE plugins) can drive the terminal. Drop = graceful
    /// shutdown. `None` if spawn failed (logged; UI degrades to "no IPC").
    pub daemon: Option<crate::daemon::EmbeddedDaemon>,
    /// Which pane body fills the work surface when no file is open (M6).
    pub active_pane: Pane,
    /// Pane data (M6) — plan / impacts / team / timeline / proof / memory
    /// / doctor / orchestration models loaded off repo state at startup.
    pub panes: ui::panes::Panes,
    /// Right-sidebar active tab (M7): Blocks / Activity / Orchestration.
    pub right_sidebar_tab: RightSidebarTab,
    /// Activity feed filter (M7).
    pub activity_filter: ui::activity::Filter,
    /// ⌘K command-palette overlay (M5). `open=true` → render overlay.
    pub palette: ui::palette::State,
    /// Composer inline completion popup (M4). Non-empty candidate list =
    /// popup open; cycled via Tab, applied via Enter, dismissed via Esc.
    pub completion: CompletionUi,
    /// Handover overlay state (M8) — modal visibility + captured payload.
    pub handover: ui::handover::State,
    /// Extra log-output tail toggle in the terminal panel (M8).
    pub show_log_output: bool,
    /// Fullscreen-terminal toggle — when true, `view()` short-circuits to
    /// paint only the topbar + terminal panel. Users invoke agents
    /// directly (`claude`, `gemini`, …) as bare commands while the
    /// underlying PTY keeps feeding aura's block capture. Keybinds for
    /// palette / handover / fullscreen-exit remain live.
    pub fullscreen_terminal: bool,
}

impl App {
    pub fn accent(&self) -> iced::Color {
        self.current_workspace
            .as_ref()
            .map(|w| w.accent)
            .unwrap_or(theme::ACCENT)
    }

    /// Resolve the currently-selected palette item into an effect. Tools,
    /// skills, workflows, blocks, files, and commands all converge on the
    /// composer prompt — the palette prefills a deterministic invocation
    /// and closes, so the user can still edit before hitting Enter.
    fn dispatch_palette_action(&mut self) -> Task<Message> {
        use ui::palette::Action;

        let Some(action) = self.palette.current_action() else {
            return Task::none();
        };

        // `aura_handover` is special-cased: rather than prefilling the
        // composer, it opens the modal overlay directly so the user doesn't
        // have to hit Enter a second time.
        if let Action::RunTool(name) = &action {
            if name == "aura_handover" || name == "handover" {
                self.palette.open = false;
                self.handover.open_empty();
                let cwd = self.cwd.clone();
                return Task::perform(
                    async move { run_handover(cwd).await },
                    Message::HandoverPayload,
                );
            }
        }

        // Pane switches bypass the prefill path — the palette doesn't
        // have anything to place into the composer, it just closes
        // and dispatches the same Message the rail tile would fire.
        if let Action::SwitchPane(pane) = action {
            self.palette.open = false;
            // Handover has overlay semantics, not a pane body; route to
            // its open handler so ⌘K "Pane · Handover" matches ⇧⌘H.
            if pane == Pane::Handover {
                self.handover.open_empty();
                let cwd = self.cwd.clone();
                return Task::perform(
                    async move { run_handover(cwd).await },
                    Message::HandoverPayload,
                );
            }
            return Task::done(Message::SelectPane(pane));
        }

        let prefill = match action {
            Action::RunTool(name) => format!("aura {name}"),
            Action::RunSkill(path) | Action::RunWorkflow(path) | Action::OpenFile(path) => {
                format!("cat {}", path.display())
            }
            Action::OpenBlock(id) => format!("# block {}", id.0),
            Action::Prefill(s) => s,
            Action::SwitchPane(_) => unreachable!("handled above"),
        };

        self.composer.text = prefill;
        self.palette.open = false;
        Task::none()
    }
}

const UI_SCALE_MIN: f32 = 0.6;
const UI_SCALE_MAX: f32 = 2.0;
const UI_SCALE_STEP: f32 = 0.1;
const UI_SCALE_DEFAULT: f32 = 1.0;

const SIDEBAR_MIN: f32 = 260.0;
const SIDEBAR_MAX: f32 = 640.0;
const TERMINAL_MIN: f32 = 120.0;
const REVIEW_MIN: f32 = 280.0;
const REVIEW_MAX: f32 = 720.0;
const RIGHT_SIDEBAR_MIN: f32 = 240.0;
const RIGHT_SIDEBAR_MAX: f32 = 720.0;

impl App {
    fn new(screen: Screen) -> Self {
        let cwd = config::resolve_initial_cwd();
        let shell = std::env::var("SHELL").unwrap_or_else(|_| "/bin/zsh".to_string());
        let git_branch = config::git_branch(&cwd);
        let worktrees = config::git_worktrees(&cwd);

        // Load persisted projects. Seed with the resolved cwd if the list
        // is empty or doesn't already contain it. Rail renders from this
        // list; `current_workspace` is whichever one matches `cwd` today.
        let mut project_paths = config::load_projects();
        if !project_paths.iter().any(|p| p == &cwd) {
            project_paths.insert(0, cwd.clone());
            let _ = config::save_projects(&project_paths);
        }
        let workspaces: Vec<fixtures::Workspace> = project_paths
            .iter()
            .map(|p| workspace_from_path(p))
            .collect();
        let current_workspace = workspaces
            .iter()
            .find(|w| std::path::Path::new(&w.path) == cwd)
            .cloned();

        // If the caller asked for the Empty screen but we've resolved a real
        // project under cwd (or from the persisted project list), skip the
        // empty state and land directly in the active workspace — that's the
        // behavior users expect on relaunch.
        let screen = if matches!(screen, Screen::Empty) && current_workspace.is_some() {
            Screen::Active
        } else {
            screen
        };
        let sidebar_open = matches!(screen, Screen::Active);

        let sessions: Vec<fixtures::Session> = Vec::new();

        let (store, bridge, blocks) = if matches!(screen, Screen::Active) {
            match config::db_path().and_then(|p| {
                BlockStore::open(&p).map_err(crate::error::TermError::from)
            }) {
                Ok(s) => {
                    let store_arc = Arc::new(s);
                    let br = Arc::new(StdMutex::new(Bridge::new(
                        store_arc.clone(),
                        aura_blocks::AgentRef("did:aura:user/local".into()),
                        config::hostname(),
                        cwd.clone(),
                        shell.clone(),
                    )));
                    let loaded = load_blocks(&store_arc, 100);
                    (Some(store_arc), Some(br), loaded)
                }
                Err(e) => {
                    tracing::warn!(error = %e, "block store open failed — running without persistence");
                    (None, None, Vec::new())
                }
            }
        } else {
            (None, None, Vec::new())
        };

        let (pty_session, pty_grid, terminal_open) = if matches!(screen, Screen::Active) {
            let shell_args = config::login_shell_args(&shell);
            let mut extra_env: Vec<(String, String)> = Vec::new();
            if shell_integration::is_zsh(&shell) {
                match shell_integration::prepare_zsh_zdotdir() {
                    Ok(zdotdir) => {
                        extra_env.push((
                            "ZDOTDIR".to_string(),
                            zdotdir.to_string_lossy().into_owned(),
                        ));
                    }
                    Err(e) => {
                        tracing::warn!(error = %e, "zsh shell integration disabled");
                    }
                }
            }
            match pty::spawn(pty::PtyConfig {
                cwd: &cwd,
                shell: &shell,
                shell_args: &shell_args,
                size: pty::default_window_size(),
                extra_env,
            }) {
                Ok(mut session) => {
                    if let Some(rx) = session.take_events() {
                        pty_sub::install_receiver(rx);
                    }
                    (
                        Some(Arc::new(session)),
                        ui::pty_grid::GridCanvas::with_size(80, 24),
                        true,
                    )
                }
                Err(e) => {
                    tracing::warn!(error = %e, "pty spawn failed — terminal panel will show empty grid");
                    (None, ui::pty_grid::GridCanvas::new(), true)
                }
            }
        } else {
            (None, ui::pty_grid::GridCanvas::new(), false)
        };

        // Start with terminal focus OFF so keystrokes go to the composer
        // by default. The PTY grid has a mouse_area that sets focus=true
        // on click; clicking back in the composer clears it (see the
        // Message::Composer handler).
        let terminal_focus = false;
        let mut grid = pty_grid;
        grid.set_focused(terminal_focus);
        let git_status = config::git_status_map(&cwd);

        // Embedded aura-daemon: same `Arc<BlockStore>` as the UI, exposed
        // over a Unix socket so external clients (aura-cli, IDE plugins)
        // observe the terminal's live state. Spawn is best-effort —
        // failure leaves `daemon: None` and logs a warning. Once up, we
        // register the primary PTY session against the daemon's router
        // and spin a forwarder thread that pipes SubmitInput bytes into
        // the PTY writer.
        let daemon = if matches!(screen, Screen::Active) {
            if let Some(store_ref) = store.as_ref() {
                match crate::daemon::EmbeddedDaemon::spawn_default(
                    store_ref.clone(),
                    format!("aura-term/{}", crate::VERSION),
                ) {
                    Ok(d) => Some(d),
                    Err(e) => {
                        tracing::warn!(
                            error = %e,
                            "embedded aura-daemon failed to start; IPC surface unavailable",
                        );
                        None
                    }
                }
            } else {
                None
            }
        } else {
            None
        };

        if let (Some(daemon_ref), Some(pty_ref)) = (daemon.as_ref(), pty_session.as_ref()) {
            match daemon_ref
                .state()
                .open_session(cwd.clone(), Some("aura-term".into()))
            {
                Ok(sid) => {
                    let mut rx = daemon_ref.router().register(sid);
                    let pty_for_input = pty_ref.clone();
                    let spawn_result = std::thread::Builder::new()
                        .name("aura-term-input-forward".into())
                        .spawn(move || {
                            while let Some(bytes) = rx.blocking_recv() {
                                if let Err(e) = pty_for_input.write(&bytes) {
                                    tracing::warn!(
                                        error = %e,
                                        "submit_input pty write failed; dropping sink",
                                    );
                                    break;
                                }
                            }
                        });
                    match spawn_result {
                        Ok(_) => {
                            tracing::info!(
                                session = %sid.0,
                                "SubmitInput forwarder attached to PTY",
                            );
                        }
                        Err(e) => {
                            tracing::warn!(
                                error = %e,
                                "could not spawn submit-input forwarder thread",
                            );
                        }
                    }
                }
                Err(e) => {
                    tracing::warn!(
                        error = %e,
                        "could not register primary session; SubmitInput will return NotFound",
                    );
                }
            }
        }

        // Build the palette index from cwd + the initial block list. Load
        // scans well-known skill/workflow/file dirs bounded at 200 entries
        // total, so this is cheap enough to run during App::new.
        let block_refs: Vec<Block> = blocks.iter().map(|(b, _)| b.clone()).collect();
        let palette_state = ui::palette::State::load(&cwd, &block_refs);

        // Pane data — plan / impacts / team / timeline / doctor are loaded
        // off repo disk state. Cheap bounded fs scans; safe at startup.
        let panes = ui::panes::Panes::load(&cwd);

        Self {
            screen,
            sidebar_open,
            sidebar_width: theme::SESSION_SIDEBAR_W,
            terminal_open,
            terminal_height: theme::TERMINAL_H_DEFAULT,
            review_open: matches!(screen, Screen::Active),
            review_width: theme::REVIEW_W_DEFAULT,
            right_sidebar_open: false,
            right_sidebar_width: theme::RIGHT_SIDEBAR_W_DEFAULT,
            server_menu_open: false,
            resizing: None,
            window_size: iced::Size::new(1200.0, 800.0),
            current_workspace,
            workspaces,
            sessions,
            composer: ui::composer::Composer::default(),
            search_query: String::new(),
            // Sessions are now surfaced as per-worktree glyphs at the bottom
            // of nav_rail, not as a top-level sidebar tab. Land on Files by
            // default so the sidebar body shows the project tree.
            sidebar_tab: SidebarTab::default(),
            sidebar_search_query: String::new(),
            git_commit_message: String::new(),
            git_staged_expanded: true,
            git_changes_expanded: true,
            // Editor stays empty until the user clicks a file in the tree —
            // the welcome hero fills the work surface in the meantime.
            current_file: None,
            editor_buffers: std::collections::HashMap::new(),
            editor_dirty: std::collections::HashSet::new(),
            editor_show_diff: false,
            editor_diff_buffer: None,
            ui_scale: UI_SCALE_DEFAULT,
            prev_screen: None,
            pty_session,
            pty_grid: grid,
            terminal_focus,
            last_input_surface: InputSurface::default(),
            status: String::new(),
            store,
            bridge,
            blocks,
            cwd,
            shell,
            git_branch,
            worktrees,
            new_worktree_input: None,
            file_tree_expanded: std::collections::HashSet::new(),
            selected_file: None,
            recent_files: Vec::new(),
            git_status,

            daemon,
            active_pane: Pane::default(),
            panes,
            right_sidebar_tab: RightSidebarTab::default(),
            activity_filter: ui::activity::Filter::All,
            palette: palette_state,
            completion: CompletionUi::default(),
            handover: ui::handover::State::default(),
            show_log_output: false,
            fullscreen_terminal: false,
        }
    }

    fn update(&mut self, message: Message) -> Task<Message> {
        match message {
            Message::None | Message::NewSession | Message::NavBack | Message::NavForward => {
                Task::none()
            }
            Message::ToggleSidebar => {
                self.sidebar_open = !self.sidebar_open;
                Task::none()
            }
            Message::StartDrag => window::latest().and_then(window::drag),
            Message::ResizeStart(target) => {
                self.resizing = Some(target);
                Task::none()
            }
            Message::ResizeMove { x, y } => {
                if let Some(target) = self.resizing {
                    match target {
                        ResizeTarget::Sidebar => {
                            let raw = x - theme::WORKSPACE_RAIL_W;
                            self.sidebar_width = raw.clamp(SIDEBAR_MIN, SIDEBAR_MAX);
                        }
                        ResizeTarget::Review => {
                            let raw = self.window_size.width - x;
                            self.review_width = raw.clamp(REVIEW_MIN, REVIEW_MAX);
                        }
                        ResizeTarget::Terminal => {
                            let max = (self.window_size.height * 0.7).max(TERMINAL_MIN);
                            let raw = self.window_size.height - theme::TOPBAR_H - y;
                            self.terminal_height = raw.clamp(TERMINAL_MIN, max);
                        }
                        ResizeTarget::RightSidebar => {
                            let raw = self.window_size.width - x;
                            self.right_sidebar_width =
                                raw.clamp(RIGHT_SIDEBAR_MIN, RIGHT_SIDEBAR_MAX);
                        }
                    }
                }
                Task::none()
            }
            Message::ResizeEnd => {
                self.resizing = None;
                Task::none()
            }
            Message::WindowResized(size) => {
                self.window_size = size;
                Task::none()
            }
            Message::OpenProject(id) => {
                // Rail tile → switch to that project: resolve its main
                // worktree, cd the live PTY there, refresh worktrees and
                // the branch pill. `id` is the stored path.
                let Some(ws) = self.workspaces.iter().find(|w| w.id == id).cloned() else {
                    return Task::none();
                };
                let raw = std::path::PathBuf::from(&ws.path);
                let target = config::git_main_worktree(&raw)
                    .filter(|p| p.is_dir())
                    .unwrap_or(raw);
                if !target.is_dir() {
                    self.status = format!("project missing: {}", target.display());
                    return Task::none();
                }
                if let Some(pty) = &self.pty_session {
                    let cmd = format!("cd {:?}\n", target);
                    if let Err(e) = pty.write(cmd.as_bytes()) {
                        self.status = format!("pty cd: {e}");
                    }
                }
                self.cwd = target;
                self.git_branch = config::git_branch(&self.cwd);
                self.worktrees = config::git_worktrees(&self.cwd);
                self.current_workspace = Some(ws);
                self.screen = Screen::Active;
                self.sidebar_open = true;
                Task::none()
            }
            Message::CloseWorkspace => {
                self.current_workspace = None;
                self.screen = Screen::Empty;
                Task::none()
            }
            Message::ToggleTerminal => {
                self.terminal_open = !self.terminal_open;
                Task::none()
            }
            Message::ToggleFullscreenTerminal => {
                self.fullscreen_terminal = !self.fullscreen_terminal;
                // When entering fullscreen ensure the PTY panel is
                // actually visible — previously `terminal_open` could be
                // false and we'd render a blank surface.
                if self.fullscreen_terminal {
                    self.terminal_open = true;
                }
                Task::none()
            }
            Message::PtyScroll(delta) => {
                // Mouse wheel: y is lines or pixels depending on device.
                // Treat +y (wheel up) as "move toward older history"
                // which in alacritty's API is positive `lines`.
                let lines = match delta {
                    iced::mouse::ScrollDelta::Lines { y, .. } => y.round() as i32,
                    iced::mouse::ScrollDelta::Pixels { y, .. } => {
                        // ~16px per line is a reasonable default across
                        // macOS/Win/Linux trackpads.
                        (y / 16.0).round() as i32
                    }
                };
                if lines != 0 {
                    self.pty_grid.scroll_lines(lines);
                }
                Task::none()
            }
            Message::PtyScrollLines(lines) => {
                self.pty_grid.scroll_lines(lines);
                Task::none()
            }
            Message::ToggleReview => {
                self.review_open = !self.review_open;
                Task::none()
            }
            Message::ToggleRightSidebar => {
                self.right_sidebar_open = !self.right_sidebar_open;
                Task::none()
            }
            Message::ToggleServerMenu => {
                self.server_menu_open = !self.server_menu_open;
                Task::none()
            }
            Message::DismissOverlays => {
                self.server_menu_open = false;
                Task::none()
            }
            Message::SearchInput(q) => {
                self.search_query = q;
                Task::none()
            }
            Message::SearchSubmit => Task::none(),
            Message::FocusSearch => iced::widget::operation::focus(SEARCH_INPUT_ID.clone()),
            Message::SelectSidebarTab(tab) => {
                self.sidebar_tab = tab;
                Task::none()
            }
            Message::SidebarSearchInput(q) => {
                self.sidebar_search_query = q;
                Task::none()
            }
            Message::GitCommitMessageInput(s) => {
                self.git_commit_message = s;
                Task::none()
            }
            Message::GitCommitSubmit => {
                // Visual-only proto: clear the field, pretend the commit landed.
                self.git_commit_message.clear();
                Task::none()
            }
            Message::GitToggleStaged => {
                self.git_staged_expanded = !self.git_staged_expanded;
                Task::none()
            }
            Message::GitToggleChanges => {
                self.git_changes_expanded = !self.git_changes_expanded;
                Task::none()
            }
            Message::ScaleUp => {
                self.ui_scale =
                    (self.ui_scale + UI_SCALE_STEP).clamp(UI_SCALE_MIN, UI_SCALE_MAX);
                Task::none()
            }
            Message::ScaleDown => {
                self.ui_scale =
                    (self.ui_scale - UI_SCALE_STEP).clamp(UI_SCALE_MIN, UI_SCALE_MAX);
                Task::none()
            }
            Message::ScaleReset => {
                self.ui_scale = UI_SCALE_DEFAULT;
                Task::none()
            }
            Message::Composer(cm) => {
                // Any composer activity means the user is interacting with
                // the prompt, not the terminal — steal focus so keystrokes
                // don't also echo into the PTY below.
                self.last_input_surface = InputSurface::Composer;
                PTY_CAPTURES_KEYS.store(false, Ordering::Relaxed);
                if self.terminal_focus {
                    self.terminal_focus = false;
                    self.pty_grid.set_focused(false);
                }
                // Enter always submits — Tab is the completion-apply key.
                // Earlier we hijacked Enter when the popup was open, but
                // that silently replaced user-typed prompts with the
                // top candidate (e.g., "hi" → "hidutil"), which broke
                // the submit-on-Enter contract users expect.
                let tick_completion =
                    matches!(cm, ui::composer::ComposerMessage::TextChanged(_));
                if let Some(sub) = self.composer.update(cm) {
                    // Submit clears composer text — also clear any open popup.
                    self.completion = CompletionUi::default();
                    return Task::done(Message::Submit(sub));
                }
                if tick_completion {
                    let text = self.composer.text.clone();
                    if text.trim().is_empty() {
                        self.completion = CompletionUi::default();
                    } else {
                        let cands = completion::complete(&text, &self.cwd);
                        self.completion = CompletionUi {
                            candidates: cands,
                            selected: 0,
                        };
                    }
                }
                Task::none()
            }
            Message::CompletionCycle(delta) => {
                let n = self.completion.candidates.len();
                if n == 0 {
                    return Task::none();
                }
                let cur = self.completion.selected as i32;
                let next = ((cur + delta).rem_euclid(n as i32)) as usize;
                self.completion.selected = next;
                Task::none()
            }
            Message::CompletionApply => {
                let n = self.completion.candidates.len();
                if n == 0 {
                    return Task::none();
                }
                let idx = self.completion.selected.min(n - 1);
                let cand = self.completion.candidates[idx].clone();
                let new_text = completion::apply(&self.composer.text, &cand);
                self.composer.text = new_text;
                self.completion = CompletionUi::default();
                Task::none()
            }
            Message::CompletionDismiss => {
                self.completion = CompletionUi::default();
                Task::none()
            }
            Message::PaletteOpen => {
                self.palette.open = true;
                self.palette.set_query(String::new());
                iced::widget::operation::focus(iced::widget::Id::new(
                    ui::palette::INPUT_ID,
                ))
            }
            Message::PaletteClose => {
                self.palette.open = false;
                Task::none()
            }
            Message::PaletteQuery(q) => {
                self.palette.set_query(q);
                Task::none()
            }
            Message::PaletteMove(delta) => {
                self.palette.move_selection(delta);
                Task::none()
            }
            Message::PaletteClick(idx) => {
                self.palette.selected = idx;
                self.dispatch_palette_action()
            }
            Message::PaletteSubmit => self.dispatch_palette_action(),
            Message::ArrowKey(delta) => {
                if self.palette.open {
                    self.palette.move_selection(delta);
                } else {
                    let msg = if delta < 0 {
                        ui::composer::ComposerMessage::HistoryUp
                    } else {
                        ui::composer::ComposerMessage::HistoryDown
                    };
                    self.composer.update(msg);
                }
                Task::none()
            }
            Message::SelectPane(pane) => {
                self.active_pane = pane;
                Task::none()
            }
            Message::SelectRightSidebarTab(tab) => {
                self.right_sidebar_tab = tab;
                Task::none()
            }
            Message::ActivityFilter(f) => {
                self.activity_filter = f;
                Task::none()
            }
            Message::HandoverAction(action) => match action {
                ui::handover::Action::Open => {
                    self.handover.open_empty();
                    let cwd = self.cwd.clone();
                    Task::perform(
                        async move { run_handover(cwd).await },
                        Message::HandoverPayload,
                    )
                }
                ui::handover::Action::Close => {
                    self.handover.close();
                    Task::none()
                }
                ui::handover::Action::Copy => {
                    let payload = self.handover.payload.clone();
                    if payload.is_empty() {
                        Task::none()
                    } else {
                        iced::clipboard::write(payload)
                    }
                }
            },
            Message::HandoverPayload(result) => {
                match result {
                    Ok(xml) => self.handover.set_payload(xml),
                    Err(err) => self.handover.set_error(err),
                }
                Task::none()
            }
            Message::HandoverCopy => {
                let payload = self.handover.payload.clone();
                if payload.is_empty() {
                    Task::none()
                } else {
                    iced::clipboard::write(payload)
                }
            }
            Message::ToggleLogOutput => {
                self.show_log_output = !self.show_log_output;
                Task::none()
            }
            Message::EscapeKey => {
                // Precedence: handover overlay → palette → completion popup
                // → server menu → settings screen.
                if self.handover.open {
                    self.handover.close();
                } else if self.palette.open {
                    self.palette.open = false;
                } else if self.completion.is_open() {
                    self.completion = CompletionUi::default();
                } else if self.server_menu_open {
                    self.server_menu_open = false;
                } else if self.screen == Screen::Settings {
                    if let Some(prev) = self.prev_screen.take() {
                        self.screen = prev;
                    }
                }
                Task::none()
            }
            Message::Submit(sub) => {
                let prompt = sub.text.trim().to_string();
                if prompt.is_empty() {
                    return Task::none();
                }

                let (display_cmd, fallback_intent) =
                    if let Some(spec) = agents::resolve_model(sub.model) {
                        (
                            agents::build_invocation(spec, &prompt),
                            format!("{}: {prompt}", spec.id),
                        )
                    } else {
                        (prompt.clone(), format!("user: {prompt}"))
                    };

                // Chip intent wins when set; fallback derives intent from
                // the prompt so every block still carries something useful.
                let intent = if sub.intent.is_empty() {
                    fallback_intent
                } else {
                    sub.intent.clone()
                };

                if let Some(br) = self.bridge.as_ref() {
                    if let Ok(mut guard) = br.lock() {
                        if let Err(e) = guard.start_command(display_cmd.clone(), intent) {
                            self.status = format!("bridge error: {e}");
                        }
                    }
                }
                if let Some(pty) = &self.pty_session {
                    // Wrap command with OSC 133;C + 133;D;$? so the bridge
                    // auto-closes the block on completion even without a
                    // shell-integration plugin installed.
                    let wrapped = format!(
                        "printf '\\033]133;C\\007'; {display_cmd}; __aura_ec=$?; printf '\\033]133;D;%d\\007' $__aura_ec\n",
                    );
                    if let Err(e) = pty.write(wrapped.as_bytes()) {
                        self.status = format!("pty write: {e}");
                    }
                }
                if let Some(s) = self.store.as_ref() {
                    self.blocks = load_blocks(s, 100);
                }
                Task::none()
            }
            Message::OpenSettings => {
                if self.screen != Screen::Settings {
                    self.prev_screen = Some(self.screen);
                    self.screen = Screen::Settings;
                }
                Task::none()
            }
            Message::CloseSettings => {
                self.screen = self.prev_screen.take().unwrap_or(Screen::Empty);
                Task::none()
            }
            Message::PtyEvent(ev) => {
                if let pty::PtyEvent::Output(ref bytes) = ev {
                    self.pty_grid.apply_output(bytes);
                }
                let should_full_refresh = matches!(
                    &ev,
                    pty::PtyEvent::Marker(pty::Osc133::CommandExec)
                        | pty::PtyEvent::Marker(pty::Osc133::CommandEnd { .. })
                        | pty::PtyEvent::Closed
                );
                let is_output = matches!(&ev, pty::PtyEvent::Output(_));
                if let Some(br) = self.bridge.as_ref() {
                    if let Ok(mut guard) = br.lock() {
                        if let Err(e) = guard.on_pty_event(ev.clone()) {
                            tracing::warn!(error = %e, "bridge rejected pty event");
                        }
                    }
                }
                if let pty::PtyEvent::Closed = ev {
                    self.pty_session = None;
                    self.terminal_focus = false;
                    self.pty_grid.set_focused(false);
                    self.status = "shell exited".into();
                }
                if should_full_refresh {
                    if let Some(s) = self.store.as_ref() {
                        self.blocks = load_blocks(s, 100);
                    }
                } else if is_output {
                    refresh_running_block_output(self);
                }
                Task::none()
            }
            Message::PtyInput(bytes) => {
                // Authoritative guard: writes only land in the PTY if the
                // most recent surface the user touched was the PTY grid.
                // `terminal_focus` on its own is too easy to flip on by a
                // stray mouse event mid-typing.
                if self.terminal_focus && self.last_input_surface == InputSurface::Pty {
                    if let Some(pty) = &self.pty_session {
                        if let Err(e) = pty.write(&bytes) {
                            self.status = format!("pty write: {e}");
                        }
                    }
                }
                Task::none()
            }
            Message::TerminalFocus(focused) => {
                self.terminal_focus = focused;
                self.pty_grid.set_focused(focused);
                PTY_CAPTURES_KEYS.store(focused, Ordering::Relaxed);
                if focused {
                    self.last_input_surface = InputSurface::Pty;
                }
                Task::none()
            }
            Message::Paste => {
                // Read clipboard asynchronously; the PasteReceived handler
                // wraps the payload in OSC 200~/201~ and writes it to the
                // PTY so bracketed-paste-aware shells treat it as inert.
                iced::clipboard::read().map(|opt| {
                    Message::PasteReceived(opt.unwrap_or_default())
                })
            }
            Message::PasteReceived(payload) => {
                if payload.is_empty() {
                    return Task::none();
                }
                if let Some(pty) = &self.pty_session {
                    // Bracketed paste: ESC [ 200 ~ … ESC [ 201 ~. Shells
                    // that support it treat the content as literal input
                    // even if it contains newlines; shells that don't fall
                    // back gracefully (markers print as bytes but the text
                    // still arrives).
                    let wrapped = format!("\x1b[200~{}\x1b[201~", payload);
                    if let Err(e) = pty.write(wrapped.as_bytes()) {
                        self.status = format!("pty paste: {e}");
                    }
                }
                Task::none()
            }
            Message::CopySelection => {
                // Grid selection isn't modeled yet — copy is a stub that
                // no-ops until pty_grid tracks a selected range. Handled
                // here (rather than ignored at dispatch) so future work
                // plugs in without touching the shortcut table.
                Task::none()
            }
            Message::OpenFolderDialog => {
                // Native folder picker. The async handle resolves on a
                // tokio thread; iced drives it via Task::perform.
                Task::perform(
                    async {
                        rfd::AsyncFileDialog::new()
                            .set_title("Open Folder — aura-proto")
                            .pick_folder()
                            .await
                            .map(|h| h.path().to_path_buf())
                    },
                    Message::FolderPicked,
                )
            }
            Message::FolderPicked(opt) => {
                let Some(path) = opt else {
                    return Task::none();
                };
                if !path.is_dir() {
                    self.status = format!("not a directory: {}", path.display());
                    return Task::none();
                }
                // Prefer the repo's main worktree if the picked folder sits
                // inside a git tree — keeps the rail entry stable across
                // worktrees rather than piling one tile per worktree.
                let root = config::git_main_worktree(&path)
                    .filter(|p| p.is_dir())
                    .unwrap_or(path);

                if let Some(pty) = &self.pty_session {
                    let cmd = format!("cd {:?}\n", root);
                    if let Err(e) = pty.write(cmd.as_bytes()) {
                        self.status = format!("pty cd: {e}");
                    }
                }
                self.cwd = root.clone();
                self.git_branch = config::git_branch(&self.cwd);
                self.git_status = config::git_status_map(&self.cwd);
                self.selected_file = None;
                self.file_tree_expanded.clear();
                self.worktrees = config::git_worktrees(&self.cwd);

                // Add a new rail tile if this project isn't already there.
                // Otherwise just promote it to current.
                let id = root.to_string_lossy().into_owned();
                if !self.workspaces.iter().any(|w| w.id == id) {
                    let ws = workspace_from_path(&root);
                    self.workspaces.insert(0, ws.clone());
                    self.current_workspace = Some(ws);
                    let paths: Vec<std::path::PathBuf> = self
                        .workspaces
                        .iter()
                        .map(|w| std::path::PathBuf::from(&w.path))
                        .collect();
                    if let Err(e) = config::save_projects(&paths) {
                        self.status = format!("save projects: {e}");
                    }
                } else {
                    self.current_workspace = self
                        .workspaces
                        .iter()
                        .find(|w| w.id == id)
                        .cloned();
                }
                self.screen = Screen::Active;
                self.sidebar_open = true;
                Task::none()
            }
            Message::SwitchWorktree(path) => {
                // Keep the shell alive; `cd` into the target worktree and
                // let the PTY handle env updates. Topbar pill + sidebar
                // highlight re-compute from the new cwd.
                if !path.is_dir() {
                    self.status = format!("worktree missing: {}", path.display());
                    return Task::none();
                }
                if let Some(pty) = &self.pty_session {
                    let cmd = format!("cd {:?}\n", path);
                    if let Err(e) = pty.write(cmd.as_bytes()) {
                        self.status = format!("pty cd: {e}");
                    }
                }
                self.cwd = path;
                self.git_branch = config::git_branch(&self.cwd);
                self.git_status = config::git_status_map(&self.cwd);
                self.selected_file = None;
                self.file_tree_expanded.clear();
                for w in self.worktrees.iter_mut() {
                    w.is_current = self.cwd.starts_with(&w.path);
                }
                Task::none()
            }
            Message::ToggleNewWorktree => {
                self.new_worktree_input = match self.new_worktree_input {
                    Some(_) => None,
                    None => Some(String::new()),
                };
                Task::none()
            }
            Message::NewWorktreeInput(s) => {
                if self.new_worktree_input.is_some() {
                    self.new_worktree_input = Some(s);
                }
                Task::none()
            }
            Message::CancelNewWorktree => {
                self.new_worktree_input = None;
                Task::none()
            }
            Message::ToggleFileTreeDir(p) => {
                if self.file_tree_expanded.contains(&p) {
                    self.file_tree_expanded.remove(&p);
                } else {
                    self.file_tree_expanded.insert(p);
                }
                Task::none()
            }
            Message::SelectFile(p) => {
                // Load the file's real contents into the editor surface.
                // Failure modes (too-large / binary / I/O error) render as a
                // single notice line so the editor never goes blank — and the
                // file still becomes the "selected" + recent-tab entry so the
                // tree highlight + tab strip stay consistent with the click.
                use crate::code_loader::{self, LoadResult};
                let open = match code_loader::load(&p) {
                    LoadResult::Ok(f) => f,
                    LoadResult::TooLarge(sz) => code_loader::notice(
                        &p,
                        &format!("File is {} bytes — too large to preview.", sz),
                    ),
                    LoadResult::Binary => code_loader::notice(&p, "Binary file — preview suppressed."),
                    LoadResult::Error(msg) => code_loader::notice(&p, &format!("Could not open file: {}", msg)),
                };
                // Lazily seed an editable Content with the on-disk text on first
                // open. Subsequent re-selections keep the existing buffer (cursor,
                // undo history, unsaved edits all preserved across tab switches).
                if !self.editor_buffers.contains_key(&p) {
                    let text = std::fs::read_to_string(&p).unwrap_or_default();
                    self.editor_buffers.insert(
                        p.clone(),
                        iced::widget::text_editor::Content::with_text(&text),
                    );
                }
                code_loader::push_recent(&mut self.recent_files, &p, 8);
                self.current_file = Some(open);
                self.selected_file = Some(p.clone());
                self.active_pane = Pane::Work;
                // Keep the side-by-side diff in sync with the freshly-opened
                // file so flipping between files stays "show me this file's
                // diff" instead of stale prior-file diff text.
                if self.editor_show_diff {
                    let diff = config::git_file_diff(&self.cwd, &p);
                    let body = if diff.trim().is_empty() {
                        "(no changes vs HEAD)".to_string()
                    } else {
                        diff
                    };
                    self.editor_diff_buffer =
                        Some(iced::widget::text_editor::Content::with_text(&body));
                }
                Task::none()
            }
            Message::CloseEditorTab(p) => {
                self.editor_buffers.remove(&p);
                self.editor_dirty.remove(&p);
                self.recent_files.retain(|q| q != &p);
                if self.selected_file.as_ref() == Some(&p) {
                    // Switch focus to the next remaining tab, if any.
                    if let Some(next) = self.recent_files.first().cloned() {
                        return Task::done(Message::SelectFile(next));
                    }
                    self.selected_file = None;
                    self.current_file = None;
                }
                Task::none()
            }
            Message::EditorAction(action) => {
                let Some(path) = self.selected_file.clone() else {
                    return Task::none();
                };
                let is_edit = action.is_edit();
                if let Some(buf) = self.editor_buffers.get_mut(&path) {
                    buf.perform(action);
                }
                if is_edit {
                    self.editor_dirty.insert(path);
                }
                Task::none()
            }
            Message::ToggleEditorDiff => {
                self.editor_show_diff = !self.editor_show_diff;
                if self.editor_show_diff {
                    if let Some(path) = self.selected_file.as_ref() {
                        let diff = config::git_file_diff(&self.cwd, path);
                        let body = if diff.trim().is_empty() {
                            "(no changes vs HEAD)".to_string()
                        } else {
                            diff
                        };
                        self.editor_diff_buffer =
                            Some(iced::widget::text_editor::Content::with_text(&body));
                    }
                } else {
                    self.editor_diff_buffer = None;
                }
                Task::none()
            }
            Message::DiffEditorAction(action) => {
                // Allow scroll + cursor movement + selection (so users can
                // copy diff hunks); drop edit actions so the buffer stays
                // a faithful read-only mirror of `git diff` output.
                if !action.is_edit() {
                    if let Some(buf) = self.editor_diff_buffer.as_mut() {
                        buf.perform(action);
                    }
                }
                Task::none()
            }
            Message::SaveActiveFile => {
                let Some(path) = self.selected_file.clone() else {
                    return Task::none();
                };
                if !self.editor_dirty.contains(&path) {
                    return Task::none();
                }
                let Some(buf) = self.editor_buffers.get(&path) else {
                    return Task::none();
                };
                let text = buf.text();
                match std::fs::write(&path, text) {
                    Ok(()) => {
                        self.editor_dirty.remove(&path);
                        self.status = format!("saved {}", path.display());
                        // Refresh git status so the modified marker disappears
                        // from the tree if save matches HEAD again.
                        self.git_status = config::git_status_map(&self.cwd);
                        // The diff against HEAD just changed under our feet —
                        // refresh the side panel if it's open so the user
                        // sees the post-save delta immediately.
                        if self.editor_show_diff {
                            let diff = config::git_file_diff(&self.cwd, &path);
                            let body = if diff.trim().is_empty() {
                                "(no changes vs HEAD)".to_string()
                            } else {
                                diff
                            };
                            self.editor_diff_buffer =
                                Some(iced::widget::text_editor::Content::with_text(&body));
                        }
                    }
                    Err(e) => {
                        self.status = format!("save failed: {}", e);
                    }
                }
                Task::none()
            }
            Message::RefreshGitStatus => {
                self.git_status = config::git_status_map(&self.cwd);
                Task::none()
            }
            Message::NewWorktreeSubmit => {
                let Some(raw) = self.new_worktree_input.take() else {
                    return Task::none();
                };
                let branch = raw.trim().to_string();
                if branch.is_empty() {
                    return Task::none();
                }
                // Resolve the repo root we're operating on. Prefer the
                // current workspace, fall back to the resolved cwd.
                let repo_root = self
                    .current_workspace
                    .as_ref()
                    .map(|w| std::path::PathBuf::from(&w.path))
                    .unwrap_or_else(|| self.cwd.clone());
                match config::git_worktree_add(&repo_root, &branch) {
                    Ok(new_path) => {
                        self.status = format!("worktree created at {}", new_path.display());
                        self.worktrees = config::git_worktrees(&repo_root);
                        return Task::done(Message::SwitchWorktree(new_path));
                    }
                    Err(e) => {
                        self.status = format!("worktree add failed: {e}");
                        self.new_worktree_input = Some(branch);
                    }
                }
                Task::none()
            }
            Message::RunAura(subcmd) => {
                let display_cmd = format!("aura {subcmd}");
                let intent = format!("aura-cli: {display_cmd}");
                if let Some(br) = self.bridge.as_ref() {
                    if let Ok(mut guard) = br.lock() {
                        if let Err(e) = guard.start_command(display_cmd.clone(), intent) {
                            self.status = format!("bridge error: {e}");
                        }
                    }
                }
                if let Some(pty) = &self.pty_session {
                    let wrapped = format!(
                        "printf '\\033]133;C\\007'; {display_cmd}; __aura_ec=$?; printf '\\033]133;D;%d\\007' $__aura_ec\n",
                    );
                    if let Err(e) = pty.write(wrapped.as_bytes()) {
                        self.status = format!("pty write: {e}");
                    }
                }
                if let Some(s) = self.store.as_ref() {
                    self.blocks = load_blocks(s, 100);
                }
                Task::none()
            }
            Message::InstallMenu => {
                // Idempotent — only the first call installs the NSMenu;
                // subsequent calls return immediately. Runs on the
                // iced/main cocoa thread because `update` always does.
                crate::macmenu::install();
                Task::none()
            }
            Message::MenuCommand(cmd) => {
                use crate::macmenu::MenuCommand as C;
                // Route each menu click / accelerator to the matching
                // app-level Message. Keep this arm a pure dispatcher —
                // no state changes here — so keybinds and menu clicks
                // always exercise the same code path.
                let next = match cmd {
                    C::OpenFolder => Message::OpenFolderDialog,
                    C::Save => Message::SaveActiveFile,
                    C::ToggleTerminal => Message::ToggleTerminal,
                    C::ToggleReview => Message::ToggleReview,
                    C::ToggleRightSidebar => Message::ToggleRightSidebar,
                    C::ToggleLogOutput => Message::ToggleLogOutput,
                    C::ToggleFullscreenTerminal => Message::ToggleFullscreenTerminal,
                    C::ZoomIn => Message::ScaleUp,
                    C::ZoomOut => Message::ScaleDown,
                    C::ZoomReset => Message::ScaleReset,
                    C::CommandPalette => Message::PaletteOpen,
                    C::Handover => Message::HandoverAction(ui::handover::Action::Open),
                    C::FocusSearch => Message::FocusSearch,
                    C::SelectPane(pane) => Message::SelectPane(pane),
                };
                Task::done(next)
            }
        }
    }

    fn subscription(&self) -> Subscription<Message> {
        let resize_sub = if self.resizing.is_some() {
            iced::event::listen_with(|event, _status, _window| match event {
                iced::Event::Mouse(iced::mouse::Event::CursorMoved { position }) => {
                    Some(Message::ResizeMove {
                        x: position.x,
                        y: position.y,
                    })
                }
                iced::Event::Mouse(iced::mouse::Event::ButtonReleased(_)) => {
                    Some(Message::ResizeEnd)
                }
                _ => None,
            })
        } else {
            Subscription::none()
        };

        let window_sub = iced::event::listen_with(|event, _status, _window| match event {
            iced::Event::Window(iced::window::Event::Resized(size)) => {
                Some(Message::WindowResized(size))
            }
            _ => None,
        });

        let keyboard_sub = iced::event::listen_with(dispatch_key_event);

        let pty_events = Subscription::run(pty_sub::pty_event_stream);

        // Native menubar events (macOS only; no-op otherwise). The
        // stream resolves to `MenuCommand`; we map to
        // `Message::MenuCommand` here so the subscription's type matches
        // the batch.
        let menu_events = Subscription::run(crate::macmenu::menu_event_stream)
            .map(Message::MenuCommand);

        Subscription::batch([resize_sub, window_sub, keyboard_sub, pty_events, menu_events])
    }

    fn view(&self) -> Element<'_, Message> {
        use iced::widget::{column, container, mouse_area, row, stack, Space};
        use iced::Length;

        if self.screen == Screen::Settings {
            return ui::settings::view(self);
        }

        let content: Element<'_, Message> = match self.screen {
            Screen::Empty => ui::empty_state::view(),
            _ => {
                if let Some(ws) = self.current_workspace.as_ref() {
                    ui::active::view(self, ws)
                } else {
                    ui::empty_state::view()
                }
            }
        };

        let main_body: Element<'_, Message> = container(content)
            .width(Length::Fill)
            .height(Length::Fill)
            .into();

        let mut main_inner: Element<'_, Message> = main_body;

        if self.terminal_open {
            let terminal_divider_line =
                container(Space::new().width(Length::Fill).height(Length::Fixed(1.0)))
                    .width(Length::Fill)
                    .height(Length::Fixed(1.0))
                    .style(|_| iced::widget::container::Style::default().background(theme::LINE));

            let terminal_divider: Element<'_, Message> = mouse_area(
                container(terminal_divider_line)
                    .width(Length::Fill)
                    .height(Length::Fixed(7.0))
                    .center_y(Length::Fixed(7.0)),
            )
            .interaction(iced::mouse::Interaction::ResizingVertically)
            .on_press(Message::ResizeStart(ResizeTarget::Terminal))
            .on_release(Message::ResizeEnd)
            .into();

            let terminal = container(ui::terminal_panel::view(self))
                .width(Length::Fill)
                .height(Length::Fixed(self.terminal_height))
                .style(|_| {
                    iced::widget::container::Style::default().border(iced::Border {
                        color: theme::LINE,
                        width: 1.0,
                        radius: 0.0.into(),
                    })
                });

            main_inner = column![
                container(main_inner)
                    .width(Length::Fill)
                    .height(Length::Fill),
                terminal_divider,
                terminal,
            ]
            .width(Length::Fill)
            .height(Length::Fill)
            .into();
        }

        let main_panel: Element<'_, Message> = if self.review_open {
            let review_divider_line =
                container(Space::new().width(Length::Fixed(1.0)).height(Length::Fill))
                    .width(Length::Fixed(1.0))
                    .height(Length::Fill)
                    .style(|_| iced::widget::container::Style::default().background(theme::LINE));

            let review_divider: Element<'_, Message> = mouse_area(
                container(review_divider_line)
                    .width(Length::Fixed(7.0))
                    .height(Length::Fill)
                    .center_x(Length::Fixed(7.0)),
            )
            .interaction(iced::mouse::Interaction::ResizingHorizontally)
            .on_press(Message::ResizeStart(ResizeTarget::Review))
            .on_release(Message::ResizeEnd)
            .into();

            let review = container(ui::review_panel::view(self))
                .width(Length::Fixed(self.review_width))
                .height(Length::Fill)
                .style(|_| {
                    iced::widget::container::Style::default().border(iced::Border {
                        color: theme::LINE,
                        width: 1.0,
                        radius: 0.0.into(),
                    })
                });

            row![main_inner, review_divider, review]
                .width(Length::Fill)
                .height(Length::Fill)
                .into()
        } else {
            main_inner
        };

        // Invisible divider — the sidebar_body's own right-edge border already
        // paints the seam; a second LINE stacked on top of it reads as a
        // spurious drag handle. Keep the 7px mouse_area so the resize
        // affordance still works, but don't draw a second visible line.
        let divider_line =
            container(Space::new().width(Length::Fixed(1.0)).height(Length::Fill))
                .width(Length::Fixed(1.0))
                .height(Length::Fill);

        let divider_handle: Element<'_, Message> = mouse_area(
            container(divider_line)
                .width(Length::Fixed(7.0))
                .height(Length::Fill)
                .center_x(Length::Fixed(7.0)),
        )
        .interaction(iced::mouse::Interaction::ResizingHorizontally)
        .on_press(Message::ResizeStart(ResizeTarget::Sidebar))
        .on_release(Message::ResizeEnd)
        .into();

        let nav_rail_panel: Element<'_, Message> = ui::nav_rail::view(self);

        let sidebar_body: Element<'_, Message> = container(ui::sidebar::view(self))
            .width(Length::Fixed(self.sidebar_width - theme::NAV_RAIL_W))
            .height(Length::Fill)
            .clip(true)
            .style(|_| {
                iced::widget::container::Style::default()
                    .background(theme::BG_CHROME)
                    .border(iced::Border {
                        color: theme::LINE,
                        width: 1.0,
                        radius: iced::border::Radius {
                            top_left: theme::R_PANEL,
                            top_right: 0.0,
                            bottom_right: 0.0,
                            bottom_left: theme::R_PANEL,
                        },
                    })
            })
            .into();

        // Top hairline inside sidebar_panel — restores the nav_rail's top edge
        // against the titlebar. The card's own top border is hidden here by
        // the nav_rail's BG_DEEP, so we paint it back explicitly at y=0 of
        // sidebar_panel. Indented by (R_PANEL - 1) so the card's rounded
        // top-left arc remains visible and merges the horizontal top edge
        // into the vertical project-rail→nav-rail seam, matching the look
        // when the sidebar is closed.
        let sidebar_top_seam_row = row![
            Space::new()
                .width(Length::Fixed(theme::R_PANEL - 1.0))
                .height(Length::Fixed(1.0)),
            container(Space::new().width(Length::Fill).height(Length::Fixed(1.0)))
                .width(Length::Fill)
                .height(Length::Fixed(1.0))
                .style(|_| iced::widget::container::Style::default().background(theme::LINE)),
        ]
        .width(Length::Fill)
        .height(Length::Fixed(1.0));

        let sidebar_panel: Element<'_, Message> = container(
            column![
                sidebar_top_seam_row,
                row![nav_rail_panel, sidebar_body]
                    .width(Length::Fixed(self.sidebar_width))
                    .height(Length::Fill),
            ]
            .width(Length::Fixed(self.sidebar_width))
            .height(Length::Fill),
        )
        .width(Length::Fixed(self.sidebar_width))
        .height(Length::Fill)
        .style(|_| iced::widget::container::Style::default().background(theme::BG_DEEP))
        .into();

        let right_section: Option<Element<'_, Message>> = if self.right_sidebar_open {
            let right_divider_line =
                container(Space::new().width(Length::Fixed(1.0)).height(Length::Fill))
                    .width(Length::Fixed(1.0))
                    .height(Length::Fill)
                    .style(|_| iced::widget::container::Style::default().background(theme::LINE));

            let right_divider: Element<'_, Message> = mouse_area(
                container(right_divider_line)
                    .width(Length::Fixed(7.0))
                    .height(Length::Fill)
                    .center_x(Length::Fixed(7.0)),
            )
            .interaction(iced::mouse::Interaction::ResizingHorizontally)
            .on_press(Message::ResizeStart(ResizeTarget::RightSidebar))
            .on_release(Message::ResizeEnd)
            .into();

            let right_panel = container(ui::right_sidebar::view(self))
                .width(Length::Fixed(self.right_sidebar_width))
                .height(Length::Fill)
                .style(|_| {
                    iced::widget::container::Style::default()
                        .background(theme::BG_CHROME)
                        .border(iced::Border {
                            color: theme::LINE,
                            width: 1.0,
                            radius: 0.0.into(),
                        })
                });

            let _ = &right_divider;
            Some(
                row![right_panel]
                    .width(Length::Shrink)
                    .height(Length::Fill)
                    .into(),
            )
        } else {
            None
        };

        // divider_handle is retained only as an invisible mouse_area for resize
        // affordance; its 7px width added a visible gap between sidebar and
        // main, so we drop it from the row and let the panels sit flush.
        let _ = &divider_handle;

        // 1px LINE flush to the card's left edge. Needed because the
        // sidebar_panel's BG_DEEP bg covers the card's own left border below
        // the rounded corner, which would otherwise hide the project-rail →
        // nav-rail seam. Starts R_PANEL below the card top so it meets the
        // curve's tangent point cleanly and doesn't paint over the rounded-
        // inner-corner arc.
        let card_left_seam = |_state: &App| -> Element<'_, Message> {
            column![
                Space::new()
                    .width(Length::Fixed(1.0))
                    .height(Length::Fixed(theme::R_PANEL)),
                container(Space::new().width(Length::Fixed(1.0)).height(Length::Fill))
                    .width(Length::Fixed(1.0))
                    .height(Length::Fill)
                    .style(|_| iced::widget::container::Style::default().background(theme::LINE)),
            ]
            .width(Length::Fixed(1.0))
            .height(Length::Fill)
            .into()
        };

        let card_row: Element<'_, Message> = match (self.sidebar_open, right_section) {
            (true, Some(right)) => row![card_left_seam(self), sidebar_panel, main_panel, right]
                .width(Length::Fill)
                .height(Length::Fill)
                .into(),
            (true, None) => row![card_left_seam(self), sidebar_panel, main_panel]
                .width(Length::Fill)
                .height(Length::Fill)
                .into(),
            (false, Some(right)) => row![main_panel, right]
                .width(Length::Fill)
                .height(Length::Fill)
                .into(),
            (false, None) => main_panel,
        };

        // Card's top-left corner sits at (WORKSPACE_RAIL_W, TOPBAR_H) — the
        // inside corner of the shell L. Giving it top_left radius = R_PANEL
        // curves that corner inward, and the LINE-colored border traces a
        // hairline around the whole card (left edge = project-rail→nav-rail
        // seam, top edge = titlebar→workarea seam, rounded where they meet).
        // The uniform-all-sides border also paints right/bottom hairlines,
        // which frame the work area against the ribbon and window edge.
        let card: Element<'_, Message> = container(card_row)
            .width(Length::Fill)
            .height(Length::Fill)
            .clip(true)
            .style(|_| {
                iced::widget::container::Style::default()
                    .background(theme::BG_0)
                    .border(iced::Border {
                        color: theme::LINE,
                        width: 1.0,
                        radius: iced::border::Radius {
                            top_left: theme::R_PANEL,
                            top_right: 10.0,
                            bottom_right: 0.0,
                            bottom_left: 0.0,
                        },
                    })
            })
            .into();

        let rail_and_card: Element<'_, Message> = row![ui::rail::view(self), card]
            .width(Length::Fill)
            .height(Length::Fill)
            .into();


        let body: Element<'_, Message> = if self.server_menu_open {
            let overlay_row: Element<'_, Message> = container(ui::server_menu::view())
                .width(Length::Fill)
                .align_x(iced::alignment::Horizontal::Right)
                .padding(iced::Padding {
                    top: 0.0,
                    right: theme::SERVER_POPOVER_RIGHT_OFFSET,
                    bottom: 0.0,
                    left: 0.0,
                })
                .into();

            let overlay = column![
                Space::new().width(Length::Fill).height(Length::Fixed(4.0)),
                overlay_row,
                Space::new().width(Length::Fill).height(Length::Fill),
            ]
            .width(Length::Fill)
            .height(Length::Fill);

            let dismiss_layer = mouse_area(
                container(Space::new().width(Length::Fill).height(Length::Fill))
                    .width(Length::Fill)
                    .height(Length::Fill),
            )
            .on_press(Message::DismissOverlays);

            stack![rail_and_card, dismiss_layer, overlay]
                .width(Length::Fill)
                .height(Length::Fill)
                .into()
        } else {
            rail_and_card
        };

        let hline = || -> Element<'_, Message> {
            container(Space::new().width(Length::Fill).height(Length::Fixed(1.0)))
                .width(Length::Fill)
                .height(Length::Fixed(1.0))
                .style(|_| iced::widget::container::Style::default().background(theme::LINE))
                .into()
        };

        let outer: Element<'_, Message> = if self.fullscreen_terminal {
            // Fullscreen: sidebar + ribbon + pane picker fold away, PTY
            // takes the card area. Topbar + workspace rail + mini
            // statusbar stay pinned so the user never loses the app
            // chrome. Aura instrumentation keeps running; ⌘K palette /
            // ⌘⇧H handover / ⌘⇧↵ exit stay live.
            // The PTY card's container has a 1px border, but in
            // practice it reads as invisible because tabs_row inside
            // terminal_panel paints BG_1 edge-to-edge — same shade
            // as topbar — and the rail's bg abuts the card's left.
            // Fix: paint hand-painted 1px LINE hairlines INSIDE the
            // card, as the first row/column of content. This mirrors
            // the non-fullscreen `card_left_seam` trick without
            // shifting any outer offsets (so the arc overlay stays
            // aligned at WORKSPACE_RAIL_W, TOPBAR_H).
            // Top seam runs across the card's top edge but has to
            // stop R_PANEL in from the left so it doesn't paint
            // across the rounded inner-L corner (which the arc
            // overlay handles).
            let top_seam: Element<'_, Message> = row![
                Space::new()
                    .width(Length::Fixed(theme::R_PANEL))
                    .height(Length::Fixed(1.0)),
                container(Space::new().width(Length::Fill).height(Length::Fixed(1.0)))
                    .width(Length::Fill)
                    .height(Length::Fixed(1.0))
                    .style(|_| iced::widget::container::Style::default().background(theme::LINE)),
            ]
            .width(Length::Fill)
            .height(Length::Fixed(1.0))
            .into();
            let left_seam: Element<'_, Message> = column![
                // Clear the R_PANEL arc on top-left so the seam
                // doesn't paint over the rounded corner.
                Space::new()
                    .width(Length::Fixed(1.0))
                    .height(Length::Fixed(theme::R_PANEL)),
                container(Space::new().width(Length::Fixed(1.0)).height(Length::Fill))
                    .width(Length::Fixed(1.0))
                    .height(Length::Fill)
                    .style(|_| iced::widget::container::Style::default().background(theme::LINE)),
            ]
            .width(Length::Fixed(1.0))
            .height(Length::Fill)
            .into();
            let pty_with_seams: Element<'_, Message> = column![
                top_seam,
                row![left_seam, ui::terminal_panel::view(self)]
                    .width(Length::Fill)
                    .height(Length::Fill),
            ]
            .width(Length::Fill)
            .height(Length::Fill)
            .into();
            let pty_card: Element<'_, Message> = container(pty_with_seams)
                .width(Length::Fill)
                .height(Length::Fill)
                .clip(true)
                .style(|_| {
                    iced::widget::container::Style::default()
                        .background(theme::BG_0)
                        .border(iced::Border {
                            color: theme::LINE,
                            width: 1.0,
                            radius: iced::border::Radius {
                                top_left: theme::R_PANEL,
                                top_right: 10.0,
                                bottom_right: 0.0,
                                bottom_left: 0.0,
                            },
                        })
                })
                .into();
            let rail_and_pty: Element<'_, Message> = row![ui::rail::view(self), pty_card]
                .width(Length::Fill)
                .height(Length::Fill)
                .into();
            // Bottom hline matches the non-fullscreen card→ribbon
            // separator so the card's bottom hairline reads against
            // the mini statusbar. No top hline here — the card's
            // internal top_seam + arc overlay handle the top edge,
            // and inserting an extra hline would shift the arc
            // overlay's TOPBAR_H offset by 1px.
            column![
                ui::topbar::view(self),
                rail_and_pty,
                hline(),
                mini_statusbar(self),
            ]
            .width(Length::Fill)
            .height(Length::Fill)
            .into()
        } else if self.screen == Screen::Empty {
            column![ui::topbar::view(self), body]
                .width(Length::Fill)
                .height(Length::Fill)
                .into()
        } else {
            column![
                ui::topbar::view(self),
                body,
                hline(),
                ui::ribbon::view(self),
                mini_statusbar(self),
            ]
            .width(Length::Fill)
            .height(Length::Fill)
            .into()
        };

        // Inner-L corner arc overlay — draws a curved 1px LINE hairline that
        // bridges the card's vertical left seam (card_left_seam, starts at
        // y=TOPBAR_H+R_PANEL) and the horizontal sidebar top seam (starts at
        // x=WORKSPACE_RAIL_W+R_PANEL). iced's container border only clips the
        // bg to the radius; it doesn't stroke the arc, so without this overlay
        // the inner corner reads as a gap between two straight segments.
        let arc_overlay: Element<'_, Message> = if self.sidebar_open || self.fullscreen_terminal {
            column![
                Space::new()
                    .width(Length::Fill)
                    .height(Length::Fixed(theme::TOPBAR_H)),
                row![
                    Space::new()
                        .width(Length::Fixed(theme::WORKSPACE_RAIL_W))
                        .height(Length::Fixed(theme::R_PANEL)),
                    ui::icons::inner_l_arc(theme::R_PANEL),
                    Space::new().width(Length::Fill).height(Length::Fixed(theme::R_PANEL)),
                ]
                .width(Length::Fill)
                .height(Length::Fixed(theme::R_PANEL)),
                Space::new().width(Length::Fill).height(Length::Fill),
            ]
            .width(Length::Fill)
            .height(Length::Fill)
            .into()
        } else {
            Space::new().width(Length::Fill).height(Length::Fill).into()
        };

        let base_stack: Element<'_, Message> = stack![outer, arc_overlay].into();

        let framed: Element<'_, Message> = if self.palette.open {
            let scrim = mouse_area(
                container(Space::new().width(Length::Fill).height(Length::Fill))
                    .width(Length::Fill)
                    .height(Length::Fill)
                    .style(|_| {
                        iced::widget::container::Style::default().background(iced::Color {
                            r: 0.0,
                            g: 0.0,
                            b: 0.0,
                            a: 0.45,
                        })
                    }),
            )
            .on_press(Message::PaletteClose);

            let palette_view = ui::palette::view(
                &self.palette,
                Message::PaletteQuery,
                Message::PaletteSubmit,
                Message::PaletteClick,
            );

            stack![base_stack, scrim, palette_view].into()
        } else {
            base_stack
        };

        // Handover overlay stacks on top of everything (including the
        // palette, so ⌘H always wins even if ⌘K is open).
        let with_handover: Element<'_, Message> =
            if let Some(overlay) = ui::handover::view(&self.handover, Message::HandoverAction) {
                stack![framed, overlay].into()
            } else {
                framed
            };

        container(with_handover)
            .width(Length::Fill)
            .height(Length::Fill)
            .style(|_| iced::widget::container::Style::default().background(theme::BG_DEEP))
            .into()
    }
}

