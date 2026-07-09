//! Code-editor surface — real editable buffer.
//!
//! Built on `iced::widget::text_editor` so the user gets full keyboard
//! editing, multi-line cursor, native selection, undo/redo, and (with the
//! `highlighter` feature) syntect-backed syntax coloring for free. The view
//! reads the active path's `Content` from `state.editor_buffers`; edits flow
//! back through `Message::EditorAction` and dirty state lights up the tab's
//! • dot. Tabs are clickable LRU; the × closes the tab.

use iced::highlighter;
use iced::widget::{button, column, container, mouse_area, row, text, text_editor, Space};
use iced::{Border, Color, Element, Length, Padding, Shadow};

use std::path::{Path, PathBuf};

use crate::{
    fixtures::OpenFile,
    theme,
    ui::{components, icons},
    App, Message,
};

pub fn view<'a>(state: &'a App, file: &'a OpenFile) -> Element<'a, Message> {
    // Borrow the active path off the OpenFile so it inherits `'a` and the
    // tabs row can hold &Path references that outlive this fn body.
    let active_path: &'a Path = Path::new(&file.path);
    let tabs = tabs_bar(state, active_path);

    // Pull the active editable buffer; if missing (shouldn't happen after
    // SelectFile, but guard for race) render the read-only notice surface
    // we used pre-text_editor wiring.
    let editor_el: Element<'a, Message> = match state.editor_buffers.get(active_path) {
        Some(content) => editor_body(content, &file.language),
        None => fallback_notice(file),
    };

    // Diff toggle splits the editor surface horizontally: editor on the
    // left, read-only `git diff` for the same file on the right. The split
    // is fixed 50/50 — a draggable inner divider would need its own
    // ResizeTarget, which we add later if users actually drag it.
    let body: Element<'a, Message> = if state.editor_show_diff {
        let diff_pane: Element<'a, Message> = match state.editor_diff_buffer.as_ref() {
            Some(diff) => diff_body(diff),
            None => container(
                text("(open the diff toggle again to refresh)")
                    .size(theme::SZ_META)
                    .style(|_| iced::widget::text::Style { color: Some(theme::TEXT_3) }),
            )
            .width(Length::Fill)
            .height(Length::Fill)
            .center_x(Length::Fill)
            .center_y(Length::Fill)
            .into(),
        };
        let split_divider = container(Space::new().width(Length::Fixed(1.0)).height(Length::Fill))
            .width(Length::Fixed(1.0))
            .height(Length::Fill)
            .style(|_| iced::widget::container::Style::default().background(theme::LINE));
        row![
            container(editor_el).width(Length::FillPortion(1)).height(Length::Fill),
            split_divider,
            container(diff_pane).width(Length::FillPortion(1)).height(Length::Fill),
        ]
        .width(Length::Fill)
        .height(Length::Fill)
        .into()
    } else {
        editor_el
    };

    column![
        tabs,
        components::divider_h(),
        container(body)
            .width(Length::Fill)
            .height(Length::Fill)
            .style(|_| iced::widget::container::Style::default().background(theme::BG_CONTENT)),
    ]
    .width(Length::Fill)
    .height(Length::Fill)
    .into()
}

fn diff_body<'a>(content: &'a text_editor::Content) -> Element<'a, Message> {
    let editor = text_editor(content)
        .height(Length::Fill)
        .padding(Padding { top: 8.0, right: 12.0, bottom: 8.0, left: 12.0 })
        .font(iced::Font::MONOSPACE)
        .size(12.0)
        .on_action(Message::DiffEditorAction)
        .highlight("diff", highlighter::Theme::Base16Mocha);
    container(editor)
        .width(Length::Fill)
        .height(Length::Fill)
        .style(|_| iced::widget::container::Style::default().background(theme::BG_2))
        .into()
}

// ── Tabs ────────────────────────────────────────────────────────────────────

fn tabs_bar<'a>(state: &'a App, active: &'a Path) -> Element<'a, Message> {
    let mut row_el = row![].spacing(0.0).align_y(iced::Alignment::Center);
    let recent = &state.recent_files;
    if recent.is_empty() {
        let name = active
            .file_name()
            .map(|s| s.to_string_lossy().into_owned())
            .unwrap_or_else(|| active.to_string_lossy().into_owned());
        row_el = row_el.push(tab(name, active.to_path_buf(), true, false));
    } else {
        for path in recent {
            let name = path
                .file_name()
                .map(|s| s.to_string_lossy().into_owned())
                .unwrap_or_else(|| path.to_string_lossy().into_owned());
            let is_active = path == active;
            let dirty = state.editor_dirty.contains(path);
            row_el = row_el.push(tab(name, path.clone(), is_active, dirty));
        }
    }

    // Right-aligned toolbar — currently just the Diff toggle. Sits in the
    // chrome strip alongside the tab list so it stays out of the editor body.
    let diff_label = if state.editor_show_diff { "Editing" } else { "Diff" };
    let diff_active = state.editor_show_diff;
    let diff_toggle = button(
        container(
            text(diff_label)
                .size(theme::SZ_META)
                .style(move |_| iced::widget::text::Style {
                    color: Some(if diff_active { theme::TEXT_1 } else { theme::TEXT_2 }),
                }),
        )
        .padding(Padding { top: 4.0, right: 10.0, bottom: 4.0, left: 10.0 })
        .center_y(Length::Fixed(24.0)),
    )
    .on_press(Message::ToggleEditorDiff)
    .padding(0)
    .style(move |_, status| iced::widget::button::Style {
        background: match (diff_active, status) {
            (true, _) => Some(theme::BG_2.into()),
            (_, iced::widget::button::Status::Hovered) => Some(theme::BG_HOVER.into()),
            _ => None,
        },
        text_color: theme::TEXT_1,
        border: Border {
            color: if diff_active { theme::ACCENT } else { theme::LINE_SOFT },
            width: 1.0,
            radius: 4.0.into(),
        },
        shadow: Shadow::default(),
        snap: false,
    });

    container(
        row![
            iced::widget::scrollable(row_el)
                .direction(iced::widget::scrollable::Direction::Horizontal(
                    iced::widget::scrollable::Scrollbar::new().width(0).scroller_width(0),
                ))
                .width(Length::Fill),
            container(diff_toggle)
                .padding(Padding { top: 5.0, right: 8.0, bottom: 5.0, left: 8.0 }),
        ]
        .align_y(iced::Alignment::Center)
        .width(Length::Fill),
    )
    .width(Length::Fill)
    .height(Length::Fixed(34.0))
    .style(|_| iced::widget::container::Style::default().background(theme::BG_CHROME))
    .into()
}

fn tab<'a>(name: String, path: PathBuf, is_active: bool, dirty: bool) -> Element<'a, Message> {
    // Proto's exact visual recipe: column of [tab_body container, underline
    // container], where tab_body owns the bg/border and underline is the
    // active-tab accent stripe. Click is layered on top via `mouse_area` so
    // we don't have to swap to a `button`, which would import default
    // padding/text-color overrides that break the proto rendering.
    let fg = if is_active { theme::TEXT_1 } else { theme::TEXT_3 };
    let bg = if is_active { theme::BG_CONTENT } else { theme::BG_CHROME };

    let label = text(name)
        .size(theme::SZ_META)
        .style(move |_| iced::widget::text::Style { color: Some(fg) });

    // Close affordance — • when dirty, × when clean. Wrapped in mouse_area
    // so clicking it fires CloseEditorTab without bubbling up to the parent
    // tab's SelectFile click.
    let close_glyph: Element<'a, Message> = if dirty {
        text("•")
            .size(14.0)
            .style(move |_| iced::widget::text::Style { color: Some(theme::AMBER) })
            .into()
    } else {
        icons::close_x(10.0).into()
    };
    let close: Element<'a, Message> = mouse_area(
        container(close_glyph)
            .width(Length::Fixed(14.0))
            .height(Length::Fixed(14.0))
            .center_x(Length::Fixed(14.0))
            .center_y(Length::Fixed(14.0)),
    )
    .interaction(iced::mouse::Interaction::Pointer)
    .on_press(Message::CloseEditorTab(path.clone()))
    .into();

    let inner = row![
        label,
        Space::new().width(Length::Fixed(8.0)).height(0.0),
        close,
    ]
    .align_y(iced::Alignment::Center);

    let underline_color = if is_active { theme::ACCENT } else { Color::TRANSPARENT };

    // The tab body — proto's exact container, no button wrapper. bg matches
    // editor (BG_CONTENT) when active so the active tab visually merges into
    // the editor surface (the classic browser-tab "raised" look); inactive
    // sits on BG_CHROME.
    let tab_body = container(inner)
        .padding(Padding { top: 0.0, right: 12.0, bottom: 0.0, left: 12.0 })
        .width(Length::Shrink)
        .height(Length::Fixed(32.0))
        .center_y(Length::Fixed(32.0))
        .style(move |_| {
            iced::widget::container::Style::default()
                .background(bg)
                .border(Border {
                    color: theme::LINE_SOFT,
                    width: 0.0,
                    radius: 0.0.into(),
                })
        });

    let underline = container(Space::new().width(Length::Fill).height(Length::Fixed(2.0)))
        .width(Length::Fill)
        .height(Length::Fixed(2.0))
        .style(move |_| iced::widget::container::Style::default().background(underline_color));

    let stack = container(column![tab_body, underline].spacing(0.0))
        .height(Length::Fixed(34.0));

    // Layer click on the whole stack via mouse_area — the underline + tab
    // body keep their proto rendering exactly. The close mouse_area above
    // sits in front in the layout tree, so its press handler fires first
    // and the parent SelectFile only triggers when the user clicks the
    // label area.
    mouse_area(stack)
        .interaction(iced::mouse::Interaction::Pointer)
        .on_press(Message::SelectFile(path))
        .into()
}

// ── Editor body ────────────────────────────────────────────────────────────

fn editor_body<'a>(content: &'a text_editor::Content, language: &'a str) -> Element<'a, Message> {
    // Map our `OpenFile.language` slug to syntect's token (extension key).
    // `iced_highlighter` looks up syntaxes by file extension internally —
    // pass the closest match so unknown languages just degrade to plain text.
    let token = match language {
        "rust" => "rs",
        "toml" => "toml",
        "markdown" => "md",
        "json" => "json",
        "yaml" => "yaml",
        "typescript" => "ts",
        "javascript" => "js",
        "python" => "py",
        "go" => "go",
        "shell" => "sh",
        "html" => "html",
        "css" => "css",
        _ => "txt",
    };

    let editor = text_editor(content)
        .height(Length::Fill)
        .padding(Padding { top: 8.0, right: 12.0, bottom: 8.0, left: 12.0 })
        .font(iced::Font::MONOSPACE)
        .size(13.0)
        .on_action(Message::EditorAction)
        .key_binding(|kp| {
            // Bind ⌘S → save without losing the default key map. text_editor's
            // default `Update` binding is what powers all keystroke editing —
            // returning None for Cmd+S falls back to nothing-happens for that
            // chord; emitting a custom `Binding::Custom(SaveActiveFile)` would
            // require a wrapper. Cmd+S is wired through the macmenu shortcut
            // path instead (see `MenuCommand::Save`), so here we just defer.
            text_editor::Binding::from_key_press(kp)
        })
        .highlight(token, highlighter::Theme::Base16Mocha);

    container(editor)
        .width(Length::Fill)
        .height(Length::Fill)
        .into()
}

fn fallback_notice<'a>(file: &'a OpenFile) -> Element<'a, Message> {
    container(
        text(format!("(no editable buffer for {})", file.name))
            .size(theme::SZ_META)
            .style(|_| iced::widget::text::Style { color: Some(theme::TEXT_3) }),
    )
    .width(Length::Fill)
    .height(Length::Fill)
    .center_x(Length::Fill)
    .center_y(Length::Fill)
    .into()
}
