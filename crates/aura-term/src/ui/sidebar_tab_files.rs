//! Files tab — real filesystem tree rooted at `state.cwd`.
//!
//! Directories are lazy: the root's direct children always render; any other
//! directory shows its children only while it's in `state.file_tree_expanded`.
//! The row layout is a flat scrollable list with an indent-per-depth spacer —
//! cheap, and it keeps hover/selection highlights spanning the full sidebar
//! width (hierarchical nested containers chop those highlights at the indent
//! boundary, which reads as broken).
//!
//! Affordances:
//!   • click a folder → toggle expanded
//!   • click a file   → mark it as `selected_file` (editor area reads this)
//!   • hover: BG_HOVER; selected: BG_CARD + 2px accent bar on the far left
//!   • git status: M (amber) / A (green) / ? (grey) / D (red) badges, and
//!     collapsed folders containing changes show an amber M so you don't
//!     have to expand everything to hunt for the edit.
//!   • icons are tinted by file extension, folders by a single accent so
//!     the tree doesn't flatten into a grey column.
//!
//! No search/filter input in v1 — the Search tab already does fuzzy-find.
//! This view stays focused on hierarchy.

use std::collections::HashSet;
use std::path::{Path, PathBuf};

use iced::widget::{button, column, container, row, scrollable, text, Space};
use iced::{Border, Color, Element, Length, Shadow};

use crate::{config, theme, ui::icons, App, Message};

pub fn view<'a>(state: &'a App) -> Element<'a, Message> {
    let mut flat: Vec<Entry> = Vec::new();
    walk(&state.cwd, &state.file_tree_expanded, 0, &mut flat);

    if flat.is_empty() {
        return empty_state();
    }

    let header = header_view(&state.cwd);

    let mut col = column![].spacing(0.0).width(Length::Fill);
    for entry in flat {
        col = col.push(file_row(state, entry));
    }

    let body = scrollable(col).width(Length::Fill).height(Length::Fill);

    column![header, body]
        .width(Length::Fill)
        .height(Length::Fill)
        .into()
}

/// Flattened tree row.
struct Entry {
    path: PathBuf,
    name: String,
    depth: u32,
    is_dir: bool,
    expanded: bool,
}

fn walk(dir: &Path, expanded: &HashSet<PathBuf>, depth: u32, out: &mut Vec<Entry>) {
    for e in config::list_dir_sorted(dir) {
        let is_expanded = e.is_dir && expanded.contains(&e.path);
        let entry_path = e.path.clone();
        out.push(Entry {
            path: e.path,
            name: e.name,
            depth,
            is_dir: e.is_dir,
            expanded: is_expanded,
        });
        if is_expanded {
            walk(&entry_path, expanded, depth + 1, out);
        }
    }
}

fn header_view<'a>(cwd: &Path) -> Element<'a, Message> {
    let label = cwd
        .file_name()
        .map(|s| s.to_string_lossy().into_owned())
        .unwrap_or_else(|| cwd.to_string_lossy().into_owned());
    let title = text(label.to_uppercase())
        .size(theme::SZ_MICRO)
        .font(theme::FONT_SANS_MEDIUM)
        .style(|_: &iced::Theme| iced::widget::text::Style { color: Some(theme::TEXT_3) });

    container(title)
        .width(Length::Fill)
        .padding(iced::Padding {
            top: 10.0,
            right: theme::P_MD,
            bottom: 6.0,
            left: theme::P_MD,
        })
        .into()
}

fn file_row<'a>(state: &App, e: Entry) -> Element<'a, Message> {
    let is_selected = state.selected_file.as_ref() == Some(&e.path);
    // Depth-first indent: 22px per level. Wider than VS Code (8–12px) on
    // purpose — the sidebar is narrow, text density is low, and users need
    // to see "which level am I in" at a glance without squinting. Each level
    // also paints a 1px vertical guide line so the nesting reads even when
    // siblings are far apart on-screen.
    const PER_LEVEL: f32 = 22.0;
    const ROW_H: f32 = 26.0;

    // Chevron — only on directories; files get a matching-width spacer.
    let chevron: Element<'a, Message> = if e.is_dir {
        let col = theme::TEXT_3;
        if e.expanded {
            container(icons::chevron_down_sized(10.0, col))
                .width(Length::Fixed(12.0))
                .height(Length::Fixed(12.0))
                .center_x(Length::Fixed(12.0))
                .center_y(Length::Fixed(12.0))
                .into()
        } else {
            container(icons::chevron_right_sized(10.0, col))
                .width(Length::Fixed(12.0))
                .height(Length::Fixed(12.0))
                .center_x(Length::Fixed(12.0))
                .center_y(Length::Fixed(12.0))
                .into()
        }
    } else {
        Space::new()
            .width(Length::Fixed(12.0))
            .height(Length::Fixed(12.0))
            .into()
    };

    // Type-driven icon tint — folders stay on a single accent so the hierarchy
    // reads as structure; files get a muted syntax hue so you can spot a .rs
    // among .mds without reading names.
    let icon_color = if e.is_dir {
        theme::AMBER
    } else {
        file_color_for(&e.name)
    };
    let icon: Element<'a, Message> = if e.is_dir {
        icons::folder_tinted(13.0, icon_color).into()
    } else {
        icons::file_tinted(13.0, icon_color).into()
    };

    // Git status decorations — resolve once and use for both badge + name color.
    let status = state
        .git_status
        .get(&e.path)
        .copied()
        .or_else(|| {
            // Canonicalized-path fallback: walk looks at symlinks-resolved paths;
            // porcelain emits symlink paths. Match either spelling.
            e.path
                .canonicalize()
                .ok()
                .and_then(|canon| state.git_status.get(&canon).copied())
        });

    let name_color = if is_selected {
        theme::TEXT_1
    } else {
        match (e.is_dir, status) {
            (false, Some('?')) => theme::TEXT_3,
            (false, Some('D')) => theme::TEXT_3,
            (_, Some(_)) => theme::TEXT_1,
            _ => theme::TEXT_2,
        }
    };

    let name_font = if is_selected {
        theme::FONT_SANS_MEDIUM
    } else {
        theme::FONT_SANS
    };

    let name_text: Element<'a, Message> = text(e.name.clone())
        .size(theme::SZ_META)
        .font(name_font)
        .style(move |_: &iced::Theme| iced::widget::text::Style { color: Some(name_color) })
        .into();

    let badge: Element<'a, Message> = match status {
        Some('M') => status_badge("M", theme::AMBER),
        Some('A') => status_badge("A", theme::CHANGE_ADDED),
        Some('?') => status_badge("U", theme::TEXT_3),
        Some('D') => status_badge("D", theme::RED),
        _ => Space::new()
            .width(Length::Fixed(0.0))
            .height(Length::Fixed(0.0))
            .into(),
    };

    // Left accent bar for the selected row. Non-selected rows get a
    // transparent spacer of identical footprint so hover/unselect alignment
    // stays pixel-locked with select.
    let bar: Element<'a, Message> = if is_selected {
        container(Space::new().width(Length::Fixed(2.0)).height(Length::Fixed(18.0)))
            .style(|_| {
                iced::widget::container::Style::default()
                    .background(theme::ACCENT)
                    .border(Border {
                        color: Color::TRANSPARENT,
                        width: 0.0,
                        radius: 1.0.into(),
                    })
            })
            .into()
    } else {
        Space::new()
            .width(Length::Fixed(2.0))
            .height(Length::Fixed(18.0))
            .into()
    };

    let mut inner = iced::widget::Row::new().align_y(iced::Alignment::Center);
    inner = inner.push(bar);
    inner = inner.push(Space::new().width(Length::Fixed(8.0)).height(0.0));
    for _ in 0..e.depth {
        inner = inner.push(guide_cell(PER_LEVEL, ROW_H));
    }
    inner = inner.push(chevron);
    inner = inner.push(Space::new().width(Length::Fixed(4.0)).height(0.0));
    inner = inner.push(icon);
    inner = inner.push(Space::new().width(Length::Fixed(7.0)).height(0.0));
    inner = inner.push(container(name_text).width(Length::Fill));
    inner = inner.push(badge);

    let inner_padded = container(inner)
        .width(Length::Fill)
        .height(Length::Fixed(ROW_H))
        .padding(iced::Padding {
            top: 0.0,
            right: theme::P_MD,
            bottom: 0.0,
            left: 0.0,
        });

    let msg = if e.is_dir {
        Message::ToggleFileTreeDir(e.path.clone())
    } else {
        Message::SelectFile(e.path.clone())
    };

    button(inner_padded)
        .on_press(msg)
        .padding(0)
        .style(move |_, status| {
            let bg = match (is_selected, status) {
                (true, _) => Some(theme::BG_CARD.into()),
                (_, iced::widget::button::Status::Hovered)
                | (_, iced::widget::button::Status::Pressed) => Some(theme::BG_HOVER.into()),
                _ => None,
            };
            iced::widget::button::Style {
                background: bg,
                text_color: theme::TEXT_1,
                border: Border {
                    color: Color::TRANSPARENT,
                    width: 0.0,
                    radius: 0.0.into(),
                },
                shadow: Shadow::default(),
                snap: false,
            }
        })
        .width(Length::Fill)
        .into()
}

/// One indent "cell" for a depth level: a fixed-width box with a 1px vertical
/// guide line flush to the left. Stacking N of them gives a tree with N guides.
fn guide_cell<'a>(width: f32, height: f32) -> Element<'a, Message> {
    let guide = container(Space::new().width(Length::Fixed(1.0)).height(Length::Fill))
        .width(Length::Fixed(1.0))
        .height(Length::Fill)
        .style(|_| iced::widget::container::Style::default().background(theme::LINE_SOFT));
    container(row![guide, Space::new().width(Length::Fill).height(0.0)].align_y(iced::Alignment::Center))
        .width(Length::Fixed(width))
        .height(Length::Fixed(height))
        .into()
}

fn status_badge<'a>(label: &'a str, color: Color) -> Element<'a, Message> {
    container(
        text(label)
            .size(theme::SZ_MICRO)
            .font(theme::FONT_SANS_MEDIUM)
            .style(move |_: &iced::Theme| iced::widget::text::Style { color: Some(color) }),
    )
    .width(Length::Fixed(14.0))
    .height(Length::Fixed(14.0))
    .center_x(Length::Fixed(14.0))
    .center_y(Length::Fixed(14.0))
    .into()
}

/// Pick a muted palette tint for a filename based on its extension. Falls back
/// to TEXT_2 for unknown types so new languages don't look out of place.
fn file_color_for(name: &str) -> Color {
    let lower = name.to_lowercase();
    let ext = lower.rsplit_once('.').map(|(_, e)| e).unwrap_or("");
    match ext {
        "rs" => theme::CARET_ORANGE,
        "toml" => theme::SYN_KEYWORD,
        "md" | "mdx" | "txt" => theme::TEXT_2,
        "json" | "jsonc" | "yml" | "yaml" => theme::SYN_TYPE,
        "ts" | "tsx" | "js" | "jsx" => theme::SYN_FN,
        "html" | "svg" | "xml" => theme::SYN_STRING,
        "css" | "scss" | "sass" => theme::VIOLET,
        "sh" | "bash" | "zsh" | "fish" => theme::AGENT_CLAUDE,
        "py" => theme::SYN_TYPE,
        "go" => theme::SYN_FN,
        "lock" => theme::TEXT_4,
        "" => match lower.as_str() {
            "dockerfile" | "makefile" | "license" | "readme" => theme::TEXT_2,
            _ => theme::TEXT_3,
        },
        _ => theme::TEXT_2,
    }
}

fn empty_state<'a>() -> Element<'a, Message> {
    container(
        column![
            text("No files")
                .size(theme::SZ_BODY)
                .style(|_: &iced::Theme| iced::widget::text::Style { color: Some(theme::TEXT_2) }),
            Space::new().width(Length::Fixed(0.0)).height(Length::Fixed(4.0)),
            text("The current folder is empty or unreadable.")
                .size(theme::SZ_MICRO)
                .style(|_: &iced::Theme| iced::widget::text::Style { color: Some(theme::TEXT_3) }),
        ]
        .align_x(iced::Alignment::Center),
    )
    .width(Length::Fill)
    .height(Length::Fill)
    .center_x(Length::Fill)
    .center_y(Length::Fill)
    .into()
}
