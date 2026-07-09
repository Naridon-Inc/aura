//! ⌘K command palette — the single place to find and run anything in Aura.
//!
//! Loads six item sources (MCP tools, skills, workflows, recent blocks, shallow
//! files, common commands) into one flat list, then scores them against the
//! user's query with `nucleo-matcher`. Rendering is a floating 560×480 card
//! stacked over the app body.
//!
//! Every item dispatches a real `Action`. No silent no-ops: if the host app
//! can't natively handle an `Action::OpenBlock` yet (scroll-to-block isn't
//! wired), the fallback prefills the prompt with a visible marker so the user
//! sees *something* happen.
//!
//! Keyboard is handled upstream in `app.rs`:
//!   * `⌘K`            → open
//!   * `Esc`           → close
//!   * `↑` / `↓`       → move selection
//!   * `Enter`         → dispatch the selected item's `Action`
//!   * any other char  → fed into the input's `on_input` callback, which
//!                       refilters via `State::set_query`.
//!
//! Heavier UX (fuzzy highlight, categorized sections, virtualized list) can
//! layer on top later — the current view is honest and dense, matching Warp /
//! Graphite / VS Code's ⌘K feel.

use std::path::{Path, PathBuf};

use aura_blocks::{Block, BlockId};
use iced::widget::{button, column, container, row, scrollable, text, text_input, Space};
use iced::{Alignment, Background, Border, Color, Element, Length, Padding, Shadow};
use nucleo_matcher::{
    pattern::{AtomKind, CaseMatching, Normalization, Pattern},
    Config, Matcher, Utf32Str,
};

use crate::theme as t;

/// Unique widget id for the palette's text input so `app.rs` can focus it on
/// open via `iced::widget::text_input::focus(...)`.
pub const INPUT_ID: &str = "palette-input";

// ── 29 MCP tool names, in the same order as the CLAUDE.md table.
// Hardcoded rather than parsed at runtime so the palette is deterministic and
// there's no I/O on startup; if the MCP tool list grows, update this array.
const MCP_TOOLS: &[&str] = &[
    "aura_status",
    "aura_log_intent",
    "aura_plan_discover",
    "aura_plan_lock",
    "aura_plan_next",
    "aura_prove",
    "aura_pr_review",
    "aura_rewind",
    "aura_handover",
    "aura_snapshot",
    "aura_snapshot_list",
    "aura_doctor",
    "aura_suggest_edit",
    "aura_orchestrate_status",
    "aura_session_resume",
    "aura_session_summarize",
    "aura_live_impacts",
    "aura_live_resolve",
    "aura_msg_send",
    "aura_msg_list",
    "aura_live_sync_push",
    "aura_live_sync_pull",
    "aura_live_sync_status",
    "aura_sentinel_send",
    "aura_sentinel_inbox",
    "aura_sentinel_agents",
    "aura_zone_claim",
    "aura_ask",
    "aura_memory_read",
];

// ── 8 useful prefill commands. Keep short and concrete.
const COMMON_COMMANDS: &[(&str, &str)] = &[
    ("new worktree", "git worktree add ../"),
    ("code review", "aura pr-review --base main"),
    ("aura status", "aura status"),
    ("aura doctor", "aura doctor"),
    ("aura prove", "aura prove \"\""),
    ("git status", "git status"),
    ("cargo check", "cargo check"),
    ("cargo test", "cargo test"),
];

// ─────────────────────────────────────────────────────────────────────────────

#[derive(Clone, Debug)]
pub enum Action {
    /// Run an MCP tool by name (prefills the prompt with `aura <tool>`).
    RunTool(String),
    /// Run a `.skill` file (prefills with `cat <path>`).
    RunSkill(PathBuf),
    /// Run a workflow markdown file (prefills with `cat <path>`).
    RunWorkflow(PathBuf),
    /// Scroll to / open a past block. Fallback below when scroll isn't wired.
    OpenBlock(BlockId),
    /// Open a file via the OS `open` command (same as sidebar file click).
    OpenFile(PathBuf),
    /// Drop a literal template string into the prompt input.
    Prefill(String),
    /// Switch the work surface to the named pane. Mirrors the rail tile
    /// clicks + ⌘1–⌘7 shortcuts so the palette is a keyboard-only path
    /// to any pane, including the ones that have no rail shortcut
    /// (Team / Orchestration / Conflict / Handover).
    SwitchPane(crate::app::Pane),
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ItemKind {
    Tool,
    Skill,
    Workflow,
    Block,
    File,
    Command,
}

impl ItemKind {
    fn tag(self) -> &'static str {
        match self {
            Self::Tool => "tool",
            Self::Skill => "skill",
            Self::Workflow => "flow",
            Self::Block => "block",
            Self::File => "file",
            Self::Command => "cmd",
        }
    }

    fn tag_color(self) -> Color {
        match self {
            Self::Tool => t::ACCENT,
            Self::Skill => t::VIOLET,
            Self::Workflow => t::VIOLET,
            Self::Block => t::TEXT_2,
            Self::File => t::TEXT_2,
            Self::Command => t::ACCENT,
        }
    }
}

#[derive(Clone, Debug)]
pub struct Item {
    pub kind: ItemKind,
    pub label: String,
    /// Right-aligned hint (kbd, path, tool tag). Rendered dim.
    pub hint: Option<String>,
    pub action: Action,
}

pub struct State {
    pub open: bool,
    pub query: String,
    pub selected: usize,
    /// Full source, unfiltered. Rebuilt via `reload` when blocks change.
    pub items: Vec<Item>,
    /// Indices into `items`, ranked by the current query.
    pub results: Vec<usize>,
}

impl Default for State {
    fn default() -> Self {
        Self {
            open: false,
            query: String::new(),
            selected: 0,
            items: Vec::new(),
            results: Vec::new(),
        }
    }
}

impl State {
    /// Build a fresh palette state by scanning `cwd` and reading recent
    /// `blocks`. Safe to call on every app boot; I/O is bounded (two levels
    /// of file walk, skill/workflow globs over well-known dirs).
    pub fn load(cwd: &Path, blocks: &[Block]) -> Self {
        let mut items = Vec::with_capacity(128);

        // 1. MCP tools — one Item per tool name.
        for tool in MCP_TOOLS {
            items.push(Item {
                kind: ItemKind::Tool,
                label: format!("Tool · {tool}"),
                hint: Some("MCP".to_string()),
                action: Action::RunTool((*tool).to_string()),
            });
        }

        // 2. Skills.
        for path in glob_skills(cwd) {
            let label = file_label(&path, "Skill");
            let hint = short_path(&path, cwd);
            items.push(Item {
                kind: ItemKind::Skill,
                label,
                hint: Some(hint),
                action: Action::RunSkill(path),
            });
        }

        // 3. Workflows.
        for path in glob_workflows(cwd) {
            let label = file_label(&path, "Workflow");
            let hint = short_path(&path, cwd);
            items.push(Item {
                kind: ItemKind::Workflow,
                label,
                hint: Some(hint),
                action: Action::RunWorkflow(path),
            });
        }

        // 4. Recent blocks (cap 50 for signal).
        for b in blocks.iter().take(50) {
            let summary = if b.intent.summary.is_empty() {
                match &b.payload {
                    aura_blocks::BlockPayload::Command { command, .. } => command.clone(),
                    _ => b.kind.wire().to_string(),
                }
            } else {
                b.intent.summary.clone()
            };
            let first = summary.lines().next().unwrap_or("").to_string();
            let ts = format!(
                "{:02}:{:02}",
                b.created_at.hour(),
                b.created_at.minute()
            );
            items.push(Item {
                kind: ItemKind::Block,
                label: format!("Block · {first}"),
                hint: Some(ts),
                action: Action::OpenBlock(b.id),
            });
        }

        // 5. Shallow file scan (depth 2).
        for path in shallow_files(cwd) {
            let label = file_label(&path, "File");
            let hint = short_path(&path, cwd);
            items.push(Item {
                kind: ItemKind::File,
                label,
                hint: Some(hint),
                action: Action::OpenFile(path),
            });
        }

        // 6. Common commands (prefill templates).
        for (label, template) in COMMON_COMMANDS {
            items.push(Item {
                kind: ItemKind::Command,
                label: format!("Run · {label}"),
                hint: Some("prefill".to_string()),
                action: Action::Prefill((*template).to_string()),
            });
        }

        // 7. Pane navigation — one entry per work-surface pane. Rail tiles
        // already cover Work/Plan/Impacts/Proof/Memory/Timeline/Doctor +
        // Orchestration/Conflict, but the palette also lists them so
        // keyboard-only users can type "doc" → Enter, "orch" → Enter,
        // etc. Team/Handover have no rail shortcut — palette is their
        // only kb-only path.
        use crate::app::Pane;
        for (pane, label, hint) in [
            (Pane::Work, "Pane · Work", Some("⌘1")),
            (Pane::Plan, "Pane · Plan", Some("⌘2")),
            (Pane::Impacts, "Pane · Impacts", Some("⌘3")),
            (Pane::Proof, "Pane · Proof", Some("⌘4")),
            (Pane::Memory, "Pane · Memory", Some("⌘5")),
            (Pane::Timeline, "Pane · Timeline", Some("⌘6")),
            (Pane::Doctor, "Pane · Doctor", Some("⌘7")),
            (Pane::Orchestration, "Pane · Orchestration", None),
            (Pane::Conflict, "Pane · Conflicts", None),
            (Pane::Team, "Pane · Team", None),
            (Pane::Handover, "Pane · Handover", Some("⇧⌘H")),
        ] {
            items.push(Item {
                kind: ItemKind::Command,
                label: label.to_string(),
                hint: hint.map(String::from),
                action: Action::SwitchPane(pane),
            });
        }

        let mut state = Self {
            open: false,
            query: String::new(),
            selected: 0,
            items,
            results: Vec::new(),
        };
        state.filter();
        state
    }

    pub fn set_query(&mut self, q: String) {
        self.query = q;
        self.selected = 0;
        self.filter();
    }

    pub fn move_selection(&mut self, delta: i32) {
        if self.results.is_empty() {
            self.selected = 0;
            return;
        }
        let len = self.results.len() as i32;
        let mut s = self.selected as i32 + delta;
        if s < 0 {
            s = 0;
        }
        if s >= len {
            s = len - 1;
        }
        self.selected = s as usize;
    }

    /// Returns the `Action` under the current selection, if any.
    pub fn current_action(&self) -> Option<Action> {
        let idx = *self.results.get(self.selected)?;
        self.items.get(idx).map(|it| it.action.clone())
    }

    pub fn filter(&mut self) {
        if self.query.trim().is_empty() {
            self.results = (0..self.items.len()).collect();
            if self.selected >= self.results.len() {
                self.selected = 0;
            }
            return;
        }

        let mut matcher = Matcher::new(Config::DEFAULT);
        let pattern = Pattern::new(
            self.query.trim(),
            CaseMatching::Smart,
            Normalization::Smart,
            AtomKind::Fuzzy,
        );

        let mut scored: Vec<(usize, u32)> = Vec::with_capacity(self.items.len());
        let mut buf = Vec::new();
        for (i, item) in self.items.iter().enumerate() {
            buf.clear();
            let hay = Utf32Str::new(&item.label, &mut buf);
            if let Some(score) = pattern.score(hay, &mut matcher) {
                if score > 0 {
                    scored.push((i, score));
                }
            }
        }
        scored.sort_by(|a, b| b.1.cmp(&a.1));
        self.results = scored.into_iter().map(|(i, _)| i).collect();
        if self.selected >= self.results.len() {
            self.selected = 0;
        }
    }
}

// ── view ─────────────────────────────────────────────────────────────────────

pub fn view<'a, M>(
    state: &'a State,
    on_query: impl Fn(String) -> M + 'a,
    on_submit: M,
    on_click: impl Fn(usize) -> M + 'a,
) -> Element<'a, M>
where
    M: 'a + Clone,
{
    let input = text_input("Type to search tools, skills, blocks…", &state.query)
        .id(iced::widget::Id::new(INPUT_ID))
        .on_input(on_query)
        .on_submit(on_submit)
        .size(t::SZ_BODY)
        .padding(Padding::from([10.0, 12.0]))
        .style(palette_input_style);

    // Body: one row per matching Item. Selected row uses ACCENT_SOFT bg.
    let mut list = column![].spacing(0);
    if state.results.is_empty() {
        list = list.push(
            container(
                text("No matches").size(t::SZ_META).color(t::TEXT_DIM),
            )
            .padding(Padding::from([t::P_MD, t::P_MD])),
        );
    } else {
        let on_click_ref = &on_click;
        for (display_row, &idx) in state.results.iter().enumerate().take(80) {
            if let Some(item) = state.items.get(idx) {
                let selected = display_row == state.selected;
                list = list.push(row_view(item, selected, display_row, on_click_ref));
            }
        }
    }

    let scrolled = scrollable(list).height(Length::Fixed(420.0));

    let body = column![
        container(input).width(Length::Fill),
        Space::new().height(Length::Fixed(1.0)),
        container(scrolled).width(Length::Fill),
    ]
    .spacing(0);

    let card = container(body)
        .width(Length::Fixed(560.0))
        .padding(Padding::from([t::P_SM, t::P_SM]))
        .style(palette_card_style);

    // Top-center overlay: a thin strip on top, then center the card, then
    // fill. This floats the palette ~80px from the top without eating the
    // whole screen.
    let overlay = column![
        Space::new().height(Length::Fixed(80.0)),
        row![
            Space::new().width(Length::Fill),
            card,
            Space::new().width(Length::Fill),
        ]
        .align_y(Alignment::Start),
        Space::new().height(Length::Fill),
    ];

    container(overlay)
        .width(Length::Fill)
        .height(Length::Fill)
        .into()
}

fn row_view<'a, M>(
    item: &'a Item,
    selected: bool,
    index: usize,
    on_click: &(impl Fn(usize) -> M + 'a),
) -> Element<'a, M>
where
    M: 'a + Clone,
{
    let tag = container(
        text(item.kind.tag())
            .size(t::SZ_MICRO)
            .color(item.kind.tag_color())
            .font(t::MONO_MED),
    )
    .padding(Padding::from([2.0, 6.0]))
    .width(Length::Fixed(52.0))
    .center_x(Length::Fixed(52.0))
    .style(palette_chip_style);

    let label = text(item.label.clone())
        .size(t::SZ_BODY)
        .color(if selected { t::TEXT } else { t::TEXT_MUTED });

    let hint_el: Element<'a, M> = match &item.hint {
        Some(h) => text(h.clone())
            .size(t::SZ_MICRO)
            .color(t::TEXT_DIM)
            .font(t::MONO)
            .into(),
        None => Space::new().width(Length::Fixed(0.0)).into(),
    };

    let content = row![
        tag,
        Space::new().width(Length::Fixed(10.0)),
        label,
        Space::new().width(Length::Fill),
        hint_el,
    ]
    .align_y(Alignment::Center)
    .padding(Padding::from([6.0, 10.0]));

    let btn = button(content)
        .padding(0)
        .on_press((on_click)(index))
        .style(move |_, _| palette_row_style(selected))
        .width(Length::Fill)
        .height(Length::Fixed(32.0));

    btn.into()
}

// ── inline styles ────────────────────────────────────────────────────────────

fn palette_card_style(_theme: &iced::Theme) -> iced::widget::container::Style {
    iced::widget::container::Style {
        background: Some(Background::Color(t::BG_1)),
        border: Border {
            color: t::LINE,
            width: 1.0,
            radius: 12.0.into(),
        },
        shadow: Shadow {
            color: Color { r: 0.0, g: 0.0, b: 0.0, a: 0.55 },
            offset: iced::Vector { x: 0.0, y: 16.0 },
            blur_radius: 40.0,
        },
        ..Default::default()
    }
}

fn palette_chip_style(_theme: &iced::Theme) -> iced::widget::container::Style {
    iced::widget::container::Style {
        background: Some(Background::Color(t::BG_2)),
        border: Border {
            color: t::LINE_SOFT,
            width: 1.0,
            radius: 4.0.into(),
        },
        ..Default::default()
    }
}

fn palette_row_style(selected: bool) -> iced::widget::button::Style {
    let bg = if selected { t::BG_2 } else { Color::TRANSPARENT };
    iced::widget::button::Style {
        background: Some(Background::Color(bg)),
        text_color: t::TEXT_1,
        border: Border {
            color: Color::TRANSPARENT,
            width: 0.0,
            radius: 6.0.into(),
        },
        shadow: Shadow::default(),
        snap: false,
    }
}

fn palette_input_style(
    _theme: &iced::Theme,
    _status: iced::widget::text_input::Status,
) -> iced::widget::text_input::Style {
    iced::widget::text_input::Style {
        background: Background::Color(t::BG_0),
        border: Border {
            color: t::LINE,
            width: 1.0,
            radius: 8.0.into(),
        },
        icon: t::TEXT_3,
        placeholder: t::TEXT_3,
        value: t::TEXT_1,
        selection: t::ACCENT_SOFT,
    }
}

// ── scanning helpers ─────────────────────────────────────────────────────────

/// Skills: `.claude/skills/**/*.skill`, `.aura/skills/**/*.skill`,
/// `integrations/**/*.skill`. Non-recursive per-subdir walker (shallow 3-deep
/// so we don't crawl node_modules clones inside integrations).
fn glob_skills(cwd: &Path) -> Vec<PathBuf> {
    let mut out = Vec::new();
    for root in [
        cwd.join(".claude").join("skills"),
        cwd.join(".aura").join("skills"),
        cwd.join("integrations"),
    ] {
        walk_with_ext(&root, "skill", 4, &mut out);
    }
    out
}

/// Workflows: `.claude/commands/*.md`, `.aura/workflows/**/*.md`.
fn glob_workflows(cwd: &Path) -> Vec<PathBuf> {
    let mut out = Vec::new();
    walk_with_ext(&cwd.join(".claude").join("commands"), "md", 3, &mut out);
    walk_with_ext(&cwd.join(".aura").join("workflows"), "md", 4, &mut out);
    out
}

/// Shallow file scan: top 2 levels of cwd, skipping heavy dirs. Capped at 200
/// entries so the palette doesn't turn into a file tree.
fn shallow_files(cwd: &Path) -> Vec<PathBuf> {
    const SKIP: &[&str] = &[
        "node_modules",
        "target",
        ".git",
        ".DS_Store",
        "dist",
        "build",
        ".next",
        ".cache",
    ];
    let mut out = Vec::new();

    let push_dir = |dir: &Path, out: &mut Vec<PathBuf>| {
        let Ok(iter) = std::fs::read_dir(dir) else { return };
        for entry in iter.flatten() {
            let name = entry.file_name().to_string_lossy().into_owned();
            if SKIP.iter().any(|s| s == &name) || name.starts_with('.') {
                continue;
            }
            let p = entry.path();
            let is_dir = entry.file_type().map(|ft| ft.is_dir()).unwrap_or(false);
            if is_dir {
                // Note the dir itself so users can prefill `open <dir>`.
                out.push(p.clone());
            } else {
                out.push(p);
            }
            if out.len() >= 200 {
                break;
            }
        }
    };

    push_dir(cwd, &mut out);
    if out.len() >= 200 {
        return out;
    }

    // Depth 2 — descend one level.
    let snapshot = out.clone();
    for p in snapshot.iter() {
        if out.len() >= 200 {
            break;
        }
        if p.is_dir() {
            push_dir(p, &mut out);
        }
    }

    out
}

fn walk_with_ext(root: &Path, ext: &str, depth: u32, out: &mut Vec<PathBuf>) {
    if depth == 0 {
        return;
    }
    let Ok(iter) = std::fs::read_dir(root) else { return };
    for entry in iter.flatten() {
        let p = entry.path();
        let name = entry.file_name().to_string_lossy().into_owned();
        if name.starts_with('.') && !name.starts_with(".aura") && !name.starts_with(".claude") {
            continue;
        }
        match entry.file_type() {
            Ok(ft) if ft.is_dir() => walk_with_ext(&p, ext, depth - 1, out),
            Ok(ft) if ft.is_file() => {
                if p.extension().and_then(|e| e.to_str()) == Some(ext) {
                    out.push(p);
                }
            }
            _ => {}
        }
    }
}

fn file_label(path: &Path, kind_word: &str) -> String {
    let name = path
        .file_stem()
        .and_then(|s| s.to_str())
        .unwrap_or_else(|| path.file_name().and_then(|s| s.to_str()).unwrap_or("?"));
    format!("{kind_word} · {name}")
}

fn short_path(path: &Path, cwd: &Path) -> String {
    match path.strip_prefix(cwd) {
        Ok(rel) => rel.to_string_lossy().into_owned(),
        Err(_) => path.to_string_lossy().into_owned(),
    }
}

// ── tests ───────────────────────────────────────────────────────────────────
//
// These exercise the pure-logic surface (load, filter, move_selection). The
// iced `view` function is not covered here — it's a thin render helper and
// would need a full app harness to drive.

#[cfg(test)]
mod tests {
    use super::*;

    fn load_empty() -> State {
        // Use a throwaway tmp dir so the file scan finds nothing predictable.
        let tmp = std::env::temp_dir().join("aura-palette-test-empty");
        let _ = std::fs::create_dir_all(&tmp);
        State::load(&tmp, &[])
    }

    #[test]
    fn load_populates_tools_and_commands() {
        let s = load_empty();
        // 29 MCP tools + 8 common commands + 11 pane-switch entries at
        // minimum (all tagged ItemKind::Command). No skills/workflows/
        // files/blocks in the empty fixture.
        assert!(s.items.iter().filter(|i| i.kind == ItemKind::Tool).count() >= 29);
        assert!(s.items.iter().filter(|i| i.kind == ItemKind::Command).count() == 8 + 11);
    }

    #[test]
    fn empty_query_returns_all_results() {
        let s = load_empty();
        assert_eq!(s.results.len(), s.items.len());
    }

    #[test]
    fn fuzzy_query_matches_tool_name() {
        let mut s = load_empty();
        s.set_query("status".into());
        // At least one result, and the top-ranked one should mention "status".
        assert!(!s.results.is_empty());
        let top = &s.items[s.results[0]];
        assert!(
            top.label.to_lowercase().contains("status"),
            "top hit {:?} doesn't contain 'status'",
            top.label
        );
    }

    #[test]
    fn nonsense_query_returns_empty() {
        let mut s = load_empty();
        s.set_query("zzzzzzzqqqqqnotarealthing".into());
        assert!(s.results.is_empty());
    }

    #[test]
    fn move_selection_clamps() {
        let mut s = load_empty();
        s.selected = 0;
        s.move_selection(-1);
        assert_eq!(s.selected, 0);
        s.move_selection(10_000);
        assert_eq!(s.selected, s.results.len().saturating_sub(1));
    }

    #[test]
    fn current_action_follows_selection() {
        let mut s = load_empty();
        // `plan_discover` is unique to the MCP tool list — no pane item,
        // no common command, no prefill template contains that token.
        s.set_query("plan_discover".into());
        let action = s.current_action();
        assert!(action.is_some(), "no action under selection");
        match action.unwrap() {
            Action::RunTool(name) => assert!(
                name.contains("plan_discover"),
                "expected tool name to contain 'plan_discover', got {name}"
            ),
            other => panic!("expected RunTool, got {other:?}"),
        }
    }
}
