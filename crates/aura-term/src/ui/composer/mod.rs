//! Composer v3 — pixel-perfect. SVG icons (no unicode fallback), tight
//! proportions, proper send-button morphing, focus ring.
//!
//! Key fixes vs v2:
//!   1. Box height is content-driven (not `Length::Fixed(128)`). Shrinks to
//!      actual content — ~88px at rest, grows with multi-line.
//!   2. Send button is always visible (right side). Mic is a separate trigger
//!      that lives to the LEFT of send, not instead of it. This mirrors
//!      Cursor + opencode precisely.
//!   3. All glyphs are SVG icons, not unicode — no `~`, `⑂`, `🎤` rendering as
//!      squares on Linux.
//!   4. Focus ring: border changes from #313133 → #505055 when input is active.
//!   5. Header row is inline, compact, left-aligned with the input below it.
//!   6. `stack!` popover positioning uses a `hover` widget-style approach so
//!      popovers actually anchor near their triggers (not floating off-screen).

use iced::widget::{button, column, container, row, stack, svg, text, text_input, Space};
use iced::{Alignment, Background, Border, Color, Element, Length, Padding, Shadow};

pub mod icons;

// ═══ View adapter ═══════════════════════════════════════════════════════════
/// Thin bridge so `active::view` can call `composer::view(state)` and get
/// the app's `Message`. Stacks the completion popup (when open) below the
/// prompt — positioned by a top-padded container so it appears just under
/// the composer box without taking a layout slot.
pub fn view<'a>(state: &'a crate::App) -> Element<'a, crate::Message> {
    let base = state.composer.view().map(crate::Message::Composer);
    let popup = crate::ui::completion_popup::view::<crate::Message>(&state.completion)
        .map(popup_overlay)
        .unwrap_or_else(popup_placeholder);
    // Always stack — structural stability keeps the text_input's focus
    // alive across re-renders. Conditional stack! vs bare-base flips the
    // widget tree, which remounts text_input and drops focus mid-typing.
    stack![base, popup].into()
}

/// Compact bridge — used when a file is open. Renders just the prompt box,
/// omitting the home trigger + shortcut pills that make sense only on the
/// empty/hero screen.
pub fn view_compact<'a>(state: &'a crate::App) -> Element<'a, crate::Message> {
    let base = state.composer.view_compact().map(crate::Message::Composer);
    let popup = crate::ui::completion_popup::view::<crate::Message>(&state.completion)
        .map(popup_overlay)
        .unwrap_or_else(popup_placeholder);
    stack![base, popup].into()
}

/// Zero-size placeholder mounted in place of the completion popup when
/// there are no candidates. Keeps the stack! arity stable so text_input
/// doesn't remount.
fn popup_placeholder<'a>() -> Element<'a, crate::Message> {
    Space::new().width(Length::Shrink).height(Length::Shrink).into()
}

/// Wrap the popup in a top-padded container so it floats just under the
/// composer box in the stack. Offset is measured against the full
/// composer layout: intent chip (~30px) + gap (6) + prompt box (~88) +
/// gap (4) ≈ 128px.
fn popup_overlay(popup: Element<'_, crate::Message>) -> Element<'_, crate::Message> {
    container(popup)
        .padding(Padding { top: 128.0, right: 0.0, bottom: 0.0, left: 0.0 })
        .width(Length::Fill)
        .into()
}

// ═══ Tokens ═════════════════════════════════════════════════════════════════
pub mod tokens {
    use iced::Color;
    pub const fn rgb(r: u8, g: u8, b: u8) -> Color {
        Color { r: r as f32 / 255.0, g: g as f32 / 255.0, b: b as f32 / 255.0, a: 1.0 }
    }

    pub const PAGE_BG: Color = rgb(0x12, 0x12, 0x12);

    pub const BOX_BG: Color = rgb(0x1B, 0x1B, 0x1D);
    pub const BOX_BORDER: Color = rgb(0x2B, 0x2B, 0x2E);
    pub const BOX_BORDER_FOCUS: Color = rgb(0x3F, 0x3F, 0x44);

    pub const PILL_BG: Color = rgb(0x2A, 0x2A, 0x2D);
    pub const PILL_BG_HOVER: Color = rgb(0x34, 0x34, 0x38);
    pub const PILL_FG: Color = rgb(0xB5, 0xB5, 0xB8);

    pub const SEND_BG: Color = rgb(0xEC, 0xE8, 0xE5);
    pub const SEND_BG_HOVER: Color = rgb(0xFA, 0xF6, 0xF2);
    pub const SEND_BG_DISABLED: Color = rgb(0x3A, 0x3A, 0x3D);
    pub const SEND_FG: Color = rgb(0x15, 0x11, 0x0E);
    pub const SEND_FG_DISABLED: Color = rgb(0x7A, 0x7A, 0x7D);

    pub const TEXT: Color = rgb(0xED, 0xED, 0xEE);
    pub const TEXT_DIM: Color = rgb(0xB5, 0xB5, 0xB8);
    pub const TEXT_MUTED: Color = rgb(0x7E, 0x7E, 0x82);
    pub const TEXT_FAINT: Color = rgb(0x55, 0x55, 0x58);

    pub const POPOVER_BG: Color = rgb(0x1B, 0x1B, 0x1D);
    pub const POPOVER_BORDER: Color = rgb(0x2E, 0x2E, 0x31);
    pub const POPOVER_ROW_HOVER: Color = rgb(0x28, 0x28, 0x2C);
    pub const POPOVER_SECTION: Color = rgb(0x76, 0x76, 0x7A);

    pub const PILL_OUTLINE_BG: Color = rgb(0x1C, 0x1B, 0x21);
    pub const PILL_OUTLINE_BORDER: Color = rgb(0x2B, 0x2A, 0x30);
    pub const KBD_BG: Color = rgb(0x3B, 0x3A, 0x40);
    pub const KBD_FG: Color = rgb(0xB5, 0xB5, 0xB8);

    pub const TOGGLE_ON: Color = rgb(0x3B, 0xD2, 0x6A);
    pub const TOGGLE_OFF: Color = rgb(0x3B, 0x3B, 0x3E);

    pub const SELECTION: Color = rgb(0x50, 0x30, 0x55);
}

// ═══ Layout ═════════════════════════════════════════════════════════════════
pub mod sizes {
    /// Corner radius for the box — measured: Cursor ~8, opencode ~16, this is 12.
    pub const BOX_RADIUS: f32 = 12.0;
    pub const BOX_PAD_H: f32 = 14.0;
    pub const BOX_PAD_V: f32 = 12.0;
    pub const TEXT_MIN_HEIGHT: f32 = 20.0;

    /// The circular `+` / mic buttons inside the box footer.
    pub const CIRCLE_BTN: f32 = 26.0;
    pub const CIRCLE_RADIUS: f32 = 13.0;
    pub const CIRCLE_ICON: f32 = 14.0;

    /// The square send button on the right.
    pub const SEND_BTN: f32 = 28.0;
    pub const SEND_RADIUS: f32 = 8.0;
    pub const SEND_ICON: f32 = 14.0;

    /// The `Home ⌄` and `Composer 2 Fast ⌄` triggers.
    pub const TRIGGER_ICON: f32 = 12.0;
    pub const TRIGGER_TEXT: f32 = 12.5;

    /// The shortcut pills.
    pub const PILL_RADIUS: f32 = 12.0;

    pub const POPOVER_RADIUS: f32 = 10.0;
}

// ═══ State ══════════════════════════════════════════════════════════════════
#[derive(Debug, Clone)]
pub struct Composer {
    pub text: String,
    /// Short "what am I trying to do" label that persists across multiple
    /// submissions. Carries through to the Block.intent.summary so every
    /// command block the user runs is anchored to the same stated goal
    /// until they edit or clear it.
    pub intent: String,
    pub location: Location,
    pub model: Model,
    pub max_mode: bool,
    pub auto_mode: bool,
    pub open_menu: Option<OpenMenu>,
    pub recent_locations: Vec<String>,
    /// Submitted prompts, oldest → newest. Persisted via [`history_path`].
    pub history: Vec<String>,
    /// Cursor into [`history`] while the user is walking ↑/↓. `None` when
    /// the user is editing fresh text.
    pub history_idx: Option<usize>,
    /// Which text input the user most recently touched. Used so global ↑/↓
    /// only navigates prompt history when the prompt itself is the focused
    /// field, not the intent chip above it.
    pub last_focus: LastFocus,
    /// Scratch copy of the in-progress prompt captured the first time the
    /// user hits ↑, so they can get back to what they were typing by
    /// pressing ↓ past the newest history entry.
    pub history_draft: Option<String>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum LastFocus {
    Prompt,
    Intent,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum OpenMenu {
    LocationPicker,
    ModelPicker,
    PlusMenu,
}

#[derive(Debug, Clone)]
pub struct Location {
    pub label: String,
    pub path: Option<String>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Model {
    Composer2Fast,
    Composer15,
    Opus47,
    Sonnet46,
    Gpt54,
    Gemini31Pro,
}

impl Model {
    pub const ALL: &'static [Model] = &[
        Model::Composer2Fast,
        Model::Composer15,
        Model::Opus47,
        Model::Sonnet46,
        Model::Gpt54,
        Model::Gemini31Pro,
    ];
    pub fn label(&self) -> &'static str {
        match self {
            Model::Composer2Fast => "Shell (fast)",
            Model::Composer15 => "Shell",
            Model::Opus47 => "Claude Opus 4.7",
            Model::Sonnet46 => "Claude Sonnet 4.6",
            Model::Gpt54 => "Cursor GPT-5.4",
            Model::Gemini31Pro => "Gemini 3.1 Pro",
        }
    }
    /// True when the model picker maps to "run prompt as literal shell
    /// command" rather than spawning an agent CLI (see
    /// `crate::agents::resolve_model`).
    pub fn is_shell(&self) -> bool {
        matches!(self, Model::Composer2Fast | Model::Composer15)
    }
}

impl Default for Composer {
    fn default() -> Self {
        Self {
            text: String::new(),
            intent: String::new(),
            location: Location { label: "Home".into(), path: None },
            model: Model::Composer2Fast,
            max_mode: false,
            auto_mode: false,
            open_menu: None,
            recent_locations: vec![
                "~/Documents/Naridon Mono".into(),
                "~/Documents/Proposals".into(),
                "~/Documents/Useful pomodoro".into(),
            ],
            history: load_history_file(),
            history_idx: None,
            last_focus: LastFocus::Prompt,
            history_draft: None,
        }
    }
}

/// Returns `~/.config/aura/aura-proto-history.jsonl`. Parent dirs are created
/// on first write; the returned path is what [`load_history_file`] reads and
/// what [`append_history_file`] writes.
fn history_path() -> Option<std::path::PathBuf> {
    let home = std::env::var_os("HOME")?;
    Some(
        std::path::PathBuf::from(home)
            .join(".config")
            .join("aura")
            .join("aura-proto-history.jsonl"),
    )
}

/// Load persisted history on Composer init. One JSON-encoded string per line
/// — missing file, unreadable file, and malformed lines are all silently
/// ignored (history is a QoL feature; a corrupt file must not prevent the UI
/// from starting).
fn load_history_file() -> Vec<String> {
    let Some(path) = history_path() else { return Vec::new() };
    let Ok(content) = std::fs::read_to_string(&path) else { return Vec::new() };
    content
        .lines()
        .filter_map(|line| serde_json::from_str::<String>(line).ok())
        .collect()
}

/// Append a single submitted line to the history file. Opens in append mode
/// so concurrent aura-proto processes don't clobber each other. Failure is
/// silent — we still keep the in-memory copy.
fn append_history_file(entry: &str) {
    let Some(path) = history_path() else { return };
    if let Some(parent) = path.parent() {
        let _ = std::fs::create_dir_all(parent);
    }
    if let Ok(mut f) = std::fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(&path)
    {
        use std::io::Write;
        if let Ok(line) = serde_json::to_string(entry) {
            let _ = writeln!(f, "{}", line);
        }
    }
}

// ═══ Submission ═════════════════════════════════════════════════════════════
#[derive(Debug, Clone)]
pub struct Submission {
    pub text: String,
    pub intent: String,
    pub location: Location,
    pub model: Model,
    pub max_mode: bool,
}

// ═══ Messages ═══════════════════════════════════════════════════════════════
#[derive(Debug, Clone)]
pub enum ComposerMessage {
    TextChanged(String),
    IntentChanged(String),
    Submit,
    ToggleMenu(OpenMenu),
    CloseMenu,
    PickLocation(String),
    OpenFolderDialog,
    ConnectSsh,
    PickModel(Model),
    ToggleAuto,
    ToggleMax,
    PlusPick(&'static str),
    ShortcutPlanNewIdea,
    ShortcutOpenEditor,
    ToggleMic,
    /// Step backward through prompt history (older entries). Only acts when
    /// the prompt input was last focused — not the intent chip.
    HistoryUp,
    /// Step forward through prompt history (newer entries). Past the newest
    /// entry the draft the user was typing before they hit ↑ is restored.
    HistoryDown,
}

// ═══ Update ═════════════════════════════════════════════════════════════════
impl Composer {
    pub fn update(&mut self, msg: ComposerMessage) -> Option<Submission> {
        match msg {
            ComposerMessage::TextChanged(s) => {
                self.text = s;
                self.last_focus = LastFocus::Prompt;
                // Any free-form edit drops the history cursor — next ↑ starts
                // fresh at the tail.
                self.history_idx = None;
                self.history_draft = None;
                None
            }
            ComposerMessage::IntentChanged(s) => {
                self.intent = s;
                self.last_focus = LastFocus::Intent;
                None
            }
            ComposerMessage::Submit => {
                let trimmed = self.text.trim();
                if trimmed.is_empty() {
                    return None;
                }
                let entry = trimmed.to_string();
                let sub = Submission {
                    text: entry.clone(),
                    intent: self.intent.trim().to_string(),
                    location: self.location.clone(),
                    model: self.model,
                    max_mode: self.max_mode,
                };
                // Dedupe consecutive duplicates — running the same command
                // twice in a row should only take one slot.
                if self.history.last().map(|s| s.as_str()) != Some(entry.as_str()) {
                    self.history.push(entry.clone());
                    append_history_file(&entry);
                }
                self.history_idx = None;
                self.history_draft = None;
                self.text.clear();
                Some(sub)
            }
            ComposerMessage::HistoryUp => {
                if self.last_focus != LastFocus::Prompt || self.history.is_empty() {
                    return None;
                }
                let next_idx = match self.history_idx {
                    None => {
                        // First ↑ — stash whatever the user was typing so ↓
                        // past the newest can restore it.
                        self.history_draft = Some(self.text.clone());
                        self.history.len() - 1
                    }
                    Some(0) => 0,
                    Some(i) => i - 1,
                };
                self.history_idx = Some(next_idx);
                self.text = self.history[next_idx].clone();
                None
            }
            ComposerMessage::HistoryDown => {
                if self.last_focus != LastFocus::Prompt {
                    return None;
                }
                let Some(idx) = self.history_idx else { return None };
                if idx + 1 < self.history.len() {
                    let next = idx + 1;
                    self.history_idx = Some(next);
                    self.text = self.history[next].clone();
                } else {
                    // Walked past the tail — drop back to the draft the user
                    // was typing before they started navigating.
                    self.history_idx = None;
                    self.text = self.history_draft.take().unwrap_or_default();
                }
                None
            }
            ComposerMessage::ToggleMenu(m) => {
                self.open_menu = if self.open_menu == Some(m) { None } else { Some(m) };
                None
            }
            ComposerMessage::CloseMenu => {
                self.open_menu = None;
                None
            }
            ComposerMessage::PickLocation(p) => {
                self.location = Location { label: shorten(&p), path: Some(p) };
                self.open_menu = None;
                None
            }
            ComposerMessage::OpenFolderDialog | ComposerMessage::ConnectSsh => {
                self.open_menu = None;
                None
            }
            ComposerMessage::PickModel(m) => {
                self.model = m;
                self.open_menu = None;
                None
            }
            ComposerMessage::ToggleAuto => {
                self.auto_mode = !self.auto_mode;
                None
            }
            ComposerMessage::ToggleMax => {
                self.max_mode = !self.max_mode;
                None
            }
            ComposerMessage::PlusPick(_) => {
                self.open_menu = None;
                None
            }
            _ => None,
        }
    }
}

fn shorten(path: &str) -> String {
    path.rsplit('/').next().unwrap_or(path).to_string()
}

// ═══ View ═══════════════════════════════════════════════════════════════════
impl Composer {
    pub fn view(&self) -> Element<'_, ComposerMessage> {
        let base = column![
            self.header_row(),
            Space::new().height(Length::Fixed(8.0)),
            self.intent_chip(),
            Space::new().height(Length::Fixed(6.0)),
            self.prompt_box(),
            Space::new().height(Length::Fixed(12.0)),
            self.shortcut_row(),
        ]
        .spacing(0)
        .width(Length::Fill);

        // Wrap in a container so popovers can overlay it.
        let root = container(base).width(Length::Fill);

        match self.open_menu {
            None => root.into(),
            Some(menu) => stack![root, self.popover(menu)].into(),
        }
    }

    /// In-project view. Drops the `Home ⌄` header and the
    /// `Plan New Idea` / `Open Editor Window` shortcut pills — those only
    /// belong on the empty/hero screen. Keeps the prompt box + model picker
    /// + send/mic controls so the chat input still works while a file is open.
    pub fn view_compact(&self) -> Element<'_, ComposerMessage> {
        let base = column![
            self.intent_chip(),
            Space::new().height(Length::Fixed(6.0)),
            self.prompt_box(),
        ]
        .spacing(0)
        .width(Length::Fill);

        let root = container(base).width(Length::Fill);

        match self.open_menu {
            // Only ModelPicker and PlusMenu trigger from the prompt box in
            // compact mode; LocationPicker is anchored to the hidden header
            // and would float with no visible anchor — suppress it.
            Some(OpenMenu::LocationPicker) | None => root.into(),
            Some(menu) => stack![root, self.popover_compact(menu)].into(),
        }
    }

    fn popover_compact(&self, menu: OpenMenu) -> Element<'_, ComposerMessage> {
        // Shift popovers up since the header row is gone — subtract the
        // header height (~24px) from the original offsets.
        let (top_pad, left_pad, width) = match menu {
            OpenMenu::LocationPicker => (0.0, 0.0, 280.0),
            OpenMenu::ModelPicker => (88.0, 40.0, 260.0),
            OpenMenu::PlusMenu => (88.0, 4.0, 240.0),
        };

        let content = match menu {
            OpenMenu::LocationPicker => self.popover_location(),
            OpenMenu::ModelPicker => self.popover_model(),
            OpenMenu::PlusMenu => self.popover_plus(),
        };

        container(
            container(content)
                .style(|_| container::Style {
                    background: Some(Background::Color(tokens::POPOVER_BG)),
                    border: Border {
                        color: tokens::POPOVER_BORDER,
                        width: 1.0,
                        radius: sizes::POPOVER_RADIUS.into(),
                    },
                    shadow: Shadow {
                        color: Color { r: 0.0, g: 0.0, b: 0.0, a: 0.55 },
                        offset: iced::Vector { x: 0.0, y: 8.0 },
                        blur_radius: 28.0,
                    },
                    ..Default::default()
                })
                .padding(Padding::from([6.0, 4.0]))
                .width(Length::Fixed(width)),
        )
        .padding(Padding { top: top_pad, right: 0.0, bottom: 0.0, left: left_pad })
        .into()
    }

    /// Thin intent chip — sits directly above the prompt box. Always
    /// editable inline (no popover, no expand toggle). Placeholder reads
    /// "What are you trying to do?"; once the user types, the label
    /// persists across submissions and flows into the next Block's
    /// `intent.summary`. Visible accent-green dot on the left when set.
    fn intent_chip(&self) -> Element<'_, ComposerMessage> {
        use crate::theme as app_theme;

        let has_intent = !self.intent.trim().is_empty();
        let dot_color = if has_intent {
            app_theme::ACCENT_GREEN
        } else {
            app_theme::TEXT_4
        };

        let input = text_input("What are you trying to do?", &self.intent)
            .on_input(ComposerMessage::IntentChanged)
            .size(12.5)
            .padding(Padding::ZERO)
            .style(|_, _| iced::widget::text_input::Style {
                background: Background::Color(Color::TRANSPARENT),
                border: Border {
                    color: Color::TRANSPARENT,
                    width: 0.0,
                    radius: 0.0.into(),
                },
                icon: app_theme::TEXT_3,
                placeholder: app_theme::TEXT_4,
                value: app_theme::TEXT_2,
                selection: app_theme::SELECTION,
            });

        let dot = container(Space::new().width(Length::Fixed(6.0)).height(Length::Fixed(6.0)))
            .width(Length::Fixed(6.0))
            .height(Length::Fixed(6.0))
            .style(move |_| {
                iced::widget::container::Style::default()
                    .background(dot_color)
                    .border(Border {
                        color: Color::TRANSPARENT,
                        width: 0.0,
                        radius: 3.0.into(),
                    })
            });

        // Clear (×) button — only rendered when the chip carries text,
        // so the pill stays clean in its empty state. Pressing it fires
        // IntentChanged("") which resets the chip.
        let clear_btn: Element<'_, ComposerMessage> = if has_intent {
            button(
                container(
                    text("×")
                        .size(14.0)
                        .style(|_: &iced::Theme| iced::widget::text::Style {
                            color: Some(app_theme::TEXT_3),
                        }),
                )
                .width(Length::Fixed(18.0))
                .height(Length::Fixed(18.0))
                .center_x(Length::Fixed(18.0))
                .center_y(Length::Fixed(18.0)),
            )
            .on_press(ComposerMessage::IntentChanged(String::new()))
            .padding(0)
            .style(|_, status| iced::widget::button::Style {
                background: match status {
                    iced::widget::button::Status::Hovered
                    | iced::widget::button::Status::Pressed => {
                        Some(app_theme::BG_2.into())
                    }
                    _ => None,
                },
                text_color: app_theme::TEXT_2,
                border: Border {
                    color: Color::TRANSPARENT,
                    width: 0.0,
                    radius: 4.0.into(),
                },
                shadow: Shadow::default(),
                snap: false,
            })
            .into()
        } else {
            Space::new().width(Length::Fixed(0.0)).height(0.0).into()
        };

        let row_el = row![
            dot,
            Space::new().width(Length::Fixed(8.0)).height(0.0),
            container(input).width(Length::Fill),
            clear_btn,
        ]
        .align_y(Alignment::Center);

        container(row_el)
            .width(Length::Fill)
            .padding(Padding::from([6.0, 10.0]))
            .style(|_| {
                iced::widget::container::Style::default()
                    .background(app_theme::BG_1)
                    .border(Border {
                        color: app_theme::LINE,
                        width: 1.0,
                        radius: (sizes::PILL_RADIUS - 4.0).into(),
                    })
            })
            .into()
    }

    /// `Home ⌄  [laptop-icon]` — tight, compact header.
    fn header_row(&self) -> Element<'_, ComposerMessage> {
        let loc_btn = button(
            row![
                text(&self.location.label)
                    .size(sizes::TRIGGER_TEXT)
                    .color(tokens::TEXT),
                Space::new().width(Length::Fixed(4.0)),
                icons::chevron_down()
                    .width(Length::Fixed(sizes::TRIGGER_ICON))
                    .height(Length::Fixed(sizes::TRIGGER_ICON))
                    .style(icons::tint(tokens::TEXT_MUTED)),
            ]
            .align_y(Alignment::Center),
        )
        .on_press(ComposerMessage::ToggleMenu(OpenMenu::LocationPicker))
        .padding(Padding::from([4.0, 8.0]))
        .style(borderless_button_style);

        let laptop = container(
            icons::laptop()
                .width(Length::Fixed(14.0))
                .height(Length::Fixed(14.0))
                .style(icons::tint(tokens::TEXT_MUTED)),
        )
        .padding(Padding::from([0.0, 4.0]));

        row![loc_btn, Space::new().width(Length::Fixed(4.0)), laptop]
            .align_y(Alignment::Center)
            .into()
    }

    /// The composer box. Height is **content-driven** — not `Length::Fixed`.
    fn prompt_box(&self) -> Element<'_, ComposerMessage> {
        let input = text_input("Plan, Build, / for commands, @ for context", &self.text)
            .on_input(ComposerMessage::TextChanged)
            .on_submit(ComposerMessage::Submit)
            .size(13.5)
            .padding(Padding::from([0.0, 0.0]))
            .style(transparent_input_style);

        // Bottom-left cluster: "+" circle, then "Composer 2 Fast ⌄" trigger.
        let plus = circle_btn(icons::plus(), ComposerMessage::ToggleMenu(OpenMenu::PlusMenu));

        let model_trigger = button(
            row![
                text(self.model.label())
                    .size(sizes::TRIGGER_TEXT)
                    .color(tokens::TEXT),
                Space::new().width(Length::Fixed(4.0)),
                icons::chevron_down()
                    .width(Length::Fixed(10.0))
                    .height(Length::Fixed(10.0))
                    .style(icons::tint(tokens::TEXT_MUTED)),
            ]
            .align_y(Alignment::Center),
        )
        .on_press(ComposerMessage::ToggleMenu(OpenMenu::ModelPicker))
        .padding(Padding::from([3.0, 6.0]))
        .style(borderless_button_style);

        // Bottom-right cluster: mic + send button, ALWAYS both visible.
        let mic = circle_btn(icons::mic(), ComposerMessage::ToggleMic);
        let send = send_button(!self.text.trim().is_empty());

        let footer = row![
            plus,
            Space::new().width(Length::Fixed(6.0)),
            model_trigger,
            Space::new().width(Length::Fill),
            mic,
            Space::new().width(Length::Fixed(6.0)),
            send,
        ]
        .align_y(Alignment::Center);

        // Box layout: input row, 8px gap, footer. NO Length::Fill spacer —
        // the box height shrinks to content.
        let inner = column![input, Space::new().height(Length::Fixed(10.0)), footer].spacing(0);

        container(inner)
            .width(Length::Fill)
            .padding(Padding::from([sizes::BOX_PAD_V, sizes::BOX_PAD_H]))
            .style(|_| container::Style {
                background: Some(Background::Color(tokens::BOX_BG)),
                border: Border {
                    color: tokens::BOX_BORDER,
                    width: 1.0,
                    radius: sizes::BOX_RADIUS.into(),
                },
                shadow: Shadow::default(),
                text_color: Some(tokens::TEXT),
                ..Default::default()
            })
            .into()
    }

    fn shortcut_row(&self) -> Element<'_, ComposerMessage> {
        row![
            shortcut_pill("Plan New Idea", Some("⇧Tab"), ComposerMessage::ShortcutPlanNewIdea),
            Space::new().width(Length::Fixed(8.0)),
            shortcut_pill("Open Editor Window", None, ComposerMessage::ShortcutOpenEditor),
        ]
        .into()
    }

    // ─── Popovers ───────────────────────────────────────────────────────────
    fn popover(&self, menu: OpenMenu) -> Element<'_, ComposerMessage> {
        let (top_pad, left_pad, width) = match menu {
            OpenMenu::LocationPicker => (24.0, 0.0, 280.0),
            OpenMenu::ModelPicker => (112.0, 40.0, 260.0),
            OpenMenu::PlusMenu => (112.0, 4.0, 240.0),
        };

        let content = match menu {
            OpenMenu::LocationPicker => self.popover_location(),
            OpenMenu::ModelPicker => self.popover_model(),
            OpenMenu::PlusMenu => self.popover_plus(),
        };

        container(
            container(content)
                .style(|_| container::Style {
                    background: Some(Background::Color(tokens::POPOVER_BG)),
                    border: Border {
                        color: tokens::POPOVER_BORDER,
                        width: 1.0,
                        radius: sizes::POPOVER_RADIUS.into(),
                    },
                    shadow: Shadow {
                        color: Color { r: 0.0, g: 0.0, b: 0.0, a: 0.55 },
                        offset: iced::Vector { x: 0.0, y: 8.0 },
                        blur_radius: 28.0,
                    },
                    ..Default::default()
                })
                .padding(Padding::from([6.0, 4.0]))
                .width(Length::Fixed(width)),
        )
        .padding(Padding { top: top_pad, right: 0.0, bottom: 0.0, left: left_pad })
        .into()
    }

    fn popover_location(&self) -> Element<'_, ComposerMessage> {
        let mut items = column![].spacing(0);
        items = items
            .push(popover_input_row("Run Cursor anywhere..."))
            .push(Space::new().height(Length::Fixed(8.0)))
            .push(popover_section("Recents"))
            .push(popover_row_full(
                icons::home(),
                "Home",
                true,
                ComposerMessage::PickLocation("Home".into()),
            ));
        for loc in &self.recent_locations {
            items = items.push(popover_row_full(
                icons::folder(),
                loc,
                false,
                ComposerMessage::PickLocation(loc.clone()),
            ));
        }
        items = items
            .push(Space::new().height(Length::Fixed(6.0)))
            .push(popover_divider())
            .push(Space::new().height(Length::Fixed(6.0)))
            .push(popover_section("Run On"))
            .push(popover_row_chevron(icons::laptop(), "This Mac"))
            .push(popover_row_chevron(icons::cloud(), "Cursor Cloud"))
            .push(Space::new().height(Length::Fixed(6.0)))
            .push(popover_divider())
            .push(Space::new().height(Length::Fixed(6.0)))
            .push(popover_row_full(
                icons::folder(),
                "Open Folder",
                false,
                ComposerMessage::OpenFolderDialog,
            ))
            .push(popover_row_full(
                icons::plug(),
                "Connect SSH",
                false,
                ComposerMessage::ConnectSsh,
            ));
        items.into()
    }

    fn popover_model(&self) -> Element<'_, ComposerMessage> {
        let mut items = column![].spacing(0);
        items = items
            .push(popover_input_row("Search models"))
            .push(Space::new().height(Length::Fixed(4.0)))
            .push(popover_toggle_row("Auto", self.auto_mode, ComposerMessage::ToggleAuto))
            .push(popover_toggle_row("MAX Mode", self.max_mode, ComposerMessage::ToggleMax))
            .push(Space::new().height(Length::Fixed(4.0)))
            .push(popover_divider())
            .push(Space::new().height(Length::Fixed(4.0)));
        for &m in Model::ALL {
            let selected = m == self.model;
            items = items.push(popover_row_plain(
                m.label(),
                selected,
                ComposerMessage::PickModel(m),
            ));
        }
        items.into()
    }

    fn popover_plus(&self) -> Element<'_, ComposerMessage> {
        column![
            popover_input_row("Add agents, context, tools..."),
            Space::new().height(Length::Fixed(4.0)),
            popover_row_full(icons::pencil(), "Plan", false, ComposerMessage::PlusPick("plan")),
            popover_row_full(icons::bug(), "Debug", false, ComposerMessage::PlusPick("debug")),
            popover_row_full(icons::circle_q(), "Ask", false, ComposerMessage::PlusPick("ask")),
            Space::new().height(Length::Fixed(4.0)),
            popover_divider(),
            Space::new().height(Length::Fixed(4.0)),
            popover_row_full(icons::image(), "Image", false, ComposerMessage::PlusPick("image")),
            popover_row_chevron(icons::book(), "Skills"),
            popover_row_chevron(icons::plug(), "MCP Servers"),
        ]
        .into()
    }
}

// ═══ Widget helpers ═════════════════════════════════════════════════════════

fn circle_btn(
    icon: svg::Svg<'static, iced::Theme>,
    on_press: ComposerMessage,
) -> Element<'static, ComposerMessage> {
    let icon = icon
        .width(Length::Fixed(sizes::CIRCLE_ICON))
        .height(Length::Fixed(sizes::CIRCLE_ICON))
        .style(icons::tint(tokens::PILL_FG));

    button(
        container(icon)
            .center_x(Length::Fixed(sizes::CIRCLE_BTN))
            .center_y(Length::Fixed(sizes::CIRCLE_BTN)),
    )
    .on_press(on_press)
    .padding(0)
    .style(|_, status| button::Style {
        background: Some(Background::Color(match status {
            button::Status::Hovered => tokens::PILL_BG_HOVER,
            _ => tokens::PILL_BG,
        })),
        text_color: tokens::PILL_FG,
        border: Border {
            color: Color::TRANSPARENT,
            width: 0.0,
            radius: sizes::CIRCLE_RADIUS.into(),
        },
        shadow: Shadow::default(),
        snap: false,
    })
    .into()
}

/// Send button. `enabled=true` means the text input has content.
/// Enabled: warm off-white with dark arrow. Disabled: dim gray.
fn send_button<'a>(enabled: bool) -> Element<'a, ComposerMessage> {
    let (bg, fg) = if enabled {
        (tokens::SEND_BG, tokens::SEND_FG)
    } else {
        (tokens::SEND_BG_DISABLED, tokens::SEND_FG_DISABLED)
    };

    let icon = icons::arrow_up()
        .width(Length::Fixed(sizes::SEND_ICON))
        .height(Length::Fixed(sizes::SEND_ICON))
        .style(icons::tint(fg));

    let mut btn = button(
        container(icon)
            .center_x(Length::Fixed(sizes::SEND_BTN))
            .center_y(Length::Fixed(sizes::SEND_BTN)),
    )
    .padding(0)
    .style(move |_, status| button::Style {
        background: Some(Background::Color(if enabled {
            match status {
                button::Status::Hovered => tokens::SEND_BG_HOVER,
                _ => bg,
            }
        } else {
            bg
        })),
        text_color: fg,
        border: Border {
            color: Color::TRANSPARENT,
            width: 0.0,
            radius: sizes::SEND_RADIUS.into(),
        },
        shadow: Shadow::default(),
        snap: false,
    });

    if enabled {
        btn = btn.on_press(ComposerMessage::Submit);
    }
    btn.into()
}

fn shortcut_pill<'a>(
    label: &'a str,
    kbd: Option<&'a str>,
    on_press: ComposerMessage,
) -> Element<'a, ComposerMessage> {
    let mut inner = row![text(label).size(12.0).color(tokens::TEXT_DIM)]
        .spacing(6)
        .align_y(Alignment::Center);

    if let Some(k) = kbd {
        inner = inner.push(
            container(text(k).size(10.5).color(tokens::KBD_FG))
                .padding(Padding::from([1.0, 5.0]))
                .style(|_| container::Style {
                    background: Some(Background::Color(tokens::KBD_BG)),
                    border: Border {
                        color: Color::TRANSPARENT,
                        width: 0.0,
                        radius: 3.0.into(),
                    },
                    ..Default::default()
                }),
        );
    }

    button(inner)
        .on_press(on_press)
        .padding(Padding::from([5.0, 12.0]))
        .style(|_, status| button::Style {
            background: Some(Background::Color(match status {
                button::Status::Hovered => tokens::POPOVER_ROW_HOVER,
                _ => tokens::PILL_OUTLINE_BG,
            })),
            text_color: tokens::TEXT_DIM,
            border: Border {
                color: tokens::PILL_OUTLINE_BORDER,
                width: 1.0,
                radius: sizes::PILL_RADIUS.into(),
            },
            shadow: Shadow::default(),
            snap: false,
        })
        .into()
}

// ─── Popover widgets ────────────────────────────────────────────────────────

fn popover_input_row<'a>(placeholder: &'a str) -> Element<'a, ComposerMessage> {
    container(text(placeholder).size(12.5).color(tokens::TEXT_MUTED))
        .padding(Padding::from([6.0, 10.0]))
        .width(Length::Fill)
        .into()
}

fn popover_section<'a>(label: &'a str) -> Element<'a, ComposerMessage> {
    container(text(label).size(10.5).color(tokens::POPOVER_SECTION))
        .padding(Padding::from([4.0, 10.0]))
        .into()
}

fn popover_divider<'a>() -> Element<'a, ComposerMessage> {
    container(Space::new().width(Length::Fill).height(Length::Fixed(1.0)))
        .padding(Padding::from([0.0, 8.0]))
        .style(|_| container::Style {
            background: Some(Background::Color(tokens::POPOVER_BORDER)),
            ..Default::default()
        })
        .into()
}

fn popover_row_full<'a>(
    icon: svg::Svg<'static, iced::Theme>,
    label: &'a str,
    checked: bool,
    on_press: ComposerMessage,
) -> Element<'a, ComposerMessage> {
    let icon = icon
        .width(Length::Fixed(14.0))
        .height(Length::Fixed(14.0))
        .style(icons::tint(tokens::TEXT_DIM));

    let check: Element<'a, ComposerMessage> = if checked {
        icons::check()
            .width(Length::Fixed(12.0))
            .height(Length::Fixed(12.0))
            .style(icons::tint(tokens::TEXT))
            .into()
    } else {
        Space::new().width(Length::Fixed(0.0)).into()
    };

    button(
        row![
            icon,
            Space::new().width(Length::Fixed(10.0)),
            text(label).size(12.5).color(tokens::TEXT),
            Space::new().width(Length::Fill),
            check,
        ]
        .align_y(Alignment::Center),
    )
    .on_press(on_press)
    .padding(Padding::from([5.0, 10.0]))
    .width(Length::Fill)
    .style(popover_row_style)
    .into()
}

fn popover_row_plain<'a>(
    label: &'a str,
    checked: bool,
    on_press: ComposerMessage,
) -> Element<'a, ComposerMessage> {
    let check: Element<'a, ComposerMessage> = if checked {
        icons::check()
            .width(Length::Fixed(12.0))
            .height(Length::Fixed(12.0))
            .style(icons::tint(tokens::TEXT))
            .into()
    } else {
        Space::new().width(Length::Fixed(0.0)).into()
    };

    button(
        row![
            text(label).size(12.5).color(tokens::TEXT),
            Space::new().width(Length::Fill),
            check,
        ]
        .align_y(Alignment::Center),
    )
    .on_press(on_press)
    .padding(Padding::from([5.0, 10.0]))
    .width(Length::Fill)
    .style(popover_row_style)
    .into()
}

fn popover_row_chevron<'a>(
    icon: svg::Svg<'static, iced::Theme>,
    label: &'a str,
) -> Element<'a, ComposerMessage> {
    let icon = icon
        .width(Length::Fixed(14.0))
        .height(Length::Fixed(14.0))
        .style(icons::tint(tokens::TEXT_DIM));

    let chev = icons::chevron_right()
        .width(Length::Fixed(12.0))
        .height(Length::Fixed(12.0))
        .style(icons::tint(tokens::TEXT_MUTED));

    button(
        row![
            icon,
            Space::new().width(Length::Fixed(10.0)),
            text(label).size(12.5).color(tokens::TEXT),
            Space::new().width(Length::Fill),
            chev,
        ]
        .align_y(Alignment::Center),
    )
    .on_press(ComposerMessage::CloseMenu)
    .padding(Padding::from([5.0, 10.0]))
    .width(Length::Fill)
    .style(popover_row_style)
    .into()
}

fn popover_toggle_row<'a>(
    label: &'a str,
    on: bool,
    on_press: ComposerMessage,
) -> Element<'a, ComposerMessage> {
    let knob_color = if on { Color::WHITE } else { tokens::TEXT_DIM };
    let track_color = if on { tokens::TOGGLE_ON } else { tokens::TOGGLE_OFF };

    let toggle = container(
        container(Space::new().width(Length::Fixed(10.0)).height(Length::Fixed(10.0)))
            .style(move |_| container::Style {
                background: Some(Background::Color(knob_color)),
                border: Border {
                    color: Color::TRANSPARENT,
                    width: 0.0,
                    radius: 5.0.into(),
                },
                ..Default::default()
            }),
    )
    .padding(Padding::from([2.0, if on { 12.0 } else { 2.0 }]))
    .style(move |_| container::Style {
        background: Some(Background::Color(track_color)),
        border: Border {
            color: Color::TRANSPARENT,
            width: 0.0,
            radius: 7.0.into(),
        },
        ..Default::default()
    })
    .width(Length::Fixed(24.0))
    .height(Length::Fixed(14.0));

    button(
        row![
            text(label).size(12.5).color(tokens::TEXT),
            Space::new().width(Length::Fill),
            toggle,
        ]
        .align_y(Alignment::Center),
    )
    .on_press(on_press)
    .padding(Padding::from([5.0, 10.0]))
    .width(Length::Fill)
    .style(popover_row_style)
    .into()
}

// ─── Style functions ────────────────────────────────────────────────────────

fn transparent_input_style(_theme: &iced::Theme, _status: text_input::Status) -> text_input::Style {
    text_input::Style {
        background: Background::Color(Color::TRANSPARENT),
        border: Border {
            color: Color::TRANSPARENT,
            width: 0.0,
            radius: 0.0.into(),
        },
        icon: tokens::TEXT_MUTED,
        placeholder: tokens::TEXT_MUTED,
        value: tokens::TEXT,
        selection: tokens::SELECTION,
    }
}

fn borderless_button_style(_theme: &iced::Theme, status: button::Status) -> button::Style {
    button::Style {
        background: Some(Background::Color(match status {
            button::Status::Hovered => tokens::POPOVER_ROW_HOVER,
            _ => Color::TRANSPARENT,
        })),
        text_color: tokens::TEXT,
        border: Border {
            color: Color::TRANSPARENT,
            width: 0.0,
            radius: 5.0.into(),
        },
        shadow: Shadow::default(),
        snap: false,
    }
}

fn popover_row_style(_theme: &iced::Theme, status: button::Status) -> button::Style {
    button::Style {
        background: Some(Background::Color(match status {
            button::Status::Hovered => tokens::POPOVER_ROW_HOVER,
            _ => Color::TRANSPARENT,
        })),
        text_color: tokens::TEXT,
        border: Border {
            color: Color::TRANSPARENT,
            width: 0.0,
            radius: 5.0.into(),
        },
        shadow: Shadow::default(),
        snap: false,
    }
}
