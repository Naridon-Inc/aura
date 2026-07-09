//! Memory pane — user-scope agent memory index.
//!
//! Reads `~/.claude/projects/<encoded-cwd>/memory/MEMORY.md` (or the first
//! `MEMORY.md` we can find under any `~/.claude/projects/*/memory/`) and
//! renders its sections/bullets as rows. We purposefully don't parse the
//! markdown deeply — the file is user-maintained and varies — so we just
//! classify each non-empty line as a "header" (`#` / `##` / …), a "bullet"
//! (`- ` / `* `), or a plain paragraph line.
//!
//! No stubs: if the file doesn't exist we show an empty state with a
//! concrete next step. If the file exists but is blank, we show a
//! dedicated "memory file is empty" message so the user knows it's wired.

use std::fs;
use std::path::{Path, PathBuf};

use iced::widget::{column, container, row, scrollable, text, Space};
use iced::{Alignment, Element, Length, Padding};

use crate::ui::style;
use crate::theme as t;

#[derive(Debug, Clone)]
pub enum Action {
    /// Reserved for a later wave — opening the file in `$EDITOR`.
    Open,
}

pub struct Model {
    pub path: Option<PathBuf>,
    pub lines: Vec<Entry>,
    pub is_empty_file: bool,
}

#[derive(Debug, Clone)]
pub enum Entry {
    Heading(u8, String),
    Bullet(String),
    Paragraph(String),
}

impl Model {
    pub fn load() -> Self {
        let path = resolve_memory_path();
        let mut lines = Vec::new();
        let mut is_empty_file = false;

        if let Some(p) = &path {
            match fs::read_to_string(p) {
                Ok(content) => {
                    let has_any = content.lines().any(|l| !l.trim().is_empty());
                    if !has_any {
                        is_empty_file = true;
                    } else {
                        for raw in content.lines() {
                            let line = raw.trim_end();
                            if line.trim().is_empty() {
                                continue;
                            }
                            lines.push(classify(line));
                        }
                    }
                }
                Err(_) => {}
            }
        }

        Self {
            path,
            lines,
            is_empty_file,
        }
    }
}

fn classify(line: &str) -> Entry {
    let trimmed = line.trim_start();
    // Heading: `#`, `##`, `###` …
    let mut hashes = 0u8;
    for c in trimmed.chars() {
        if c == '#' {
            hashes += 1;
        } else {
            break;
        }
    }
    if hashes > 0 && hashes < 7 && trimmed.chars().nth(hashes as usize) == Some(' ') {
        let body = trimmed[hashes as usize + 1..].trim().to_string();
        return Entry::Heading(hashes, body);
    }
    // Bullet: `- ` / `* ` / `+ `
    if let Some(rest) = trimmed
        .strip_prefix("- ")
        .or_else(|| trimmed.strip_prefix("* "))
        .or_else(|| trimmed.strip_prefix("+ "))
    {
        return Entry::Bullet(rest.trim().to_string());
    }
    Entry::Paragraph(trimmed.to_string())
}

/// Find the most promising MEMORY.md. We first try the exact path encoding
/// Claude Code uses for the current working directory; if that fails, we
/// fall back to any sibling project directory under `~/.claude/projects/`.
fn resolve_memory_path() -> Option<PathBuf> {
    let home = std::env::var_os("HOME").map(PathBuf::from)?;
    let base = home.join(".claude").join("projects");
    if !base.is_dir() {
        return None;
    }

    // Preferred: encoded-cwd project.
    let cwd = std::env::current_dir().ok()?;
    let encoded = encode_project_dir(&cwd);
    let pref = base.join(&encoded).join("memory").join("MEMORY.md");
    if pref.is_file() {
        return Some(pref);
    }

    // Fallback: any project's MEMORY.md.
    if let Ok(rd) = fs::read_dir(&base) {
        for entry in rd.filter_map(|e| e.ok()) {
            let candidate = entry.path().join("memory").join("MEMORY.md");
            if candidate.is_file() {
                return Some(candidate);
            }
        }
    }
    None
}

fn encode_project_dir(path: &Path) -> String {
    // Claude Code encodes project dirs by replacing `/` with `-` and
    // stripping the leading slash, so `/Users/owner/Dev` → `-Users-owner-Dev`.
    // We mirror that here. Spaces become literal `-` too based on the
    // example path in CLAUDE.md (`-Users-you-Documents-New-Git`).
    let s = path.to_string_lossy().into_owned();
    let replaced: String = s
        .chars()
        .map(|c| if c == '/' || c == ' ' { '-' } else { c })
        .collect();
    if replaced.starts_with('-') {
        replaced
    } else {
        format!("-{}", replaced)
    }
}

pub fn view<'a, M: 'a + Clone>(
    model: &'a Model,
    _on_action: impl Fn(Action) -> M + 'a,
) -> Element<'a, M> {
    let header = row![
        text("Memory")
            .size(t::SZ_BODY_LG)
            .color(t::TEXT)
            .font(t::UI_MED),
        Space::new().width(Length::Fill),
        text(
            model
                .path
                .as_ref()
                .and_then(|p| p.file_name())
                .and_then(|s| s.to_str())
                .unwrap_or("—")
                .to_string()
        )
        .size(t::SZ_TINY)
        .color(t::TEXT_DIM)
        .font(t::MONO),
    ]
    .align_y(Alignment::Center);

    let body: Element<'a, M> = if model.path.is_none() {
        empty_missing()
    } else if model.is_empty_file {
        empty_blank()
    } else if model.lines.is_empty() {
        empty_blank()
    } else {
        let mut col = column![].spacing(2);
        for entry in &model.lines {
            col = col.push(entry_row(entry));
        }
        scrollable(container(col).width(Length::Fill))
            .height(Length::Fill)
            .width(Length::Fill)
            .style(style::scroller)
            .into()
    };

    let content = column![header, Space::new().height(Length::Fixed(t::P_SM)), body]
        .padding(Padding::from([t::P_MD, t::P_MD]));

    container(content)
        .width(Length::Fill)
        .height(Length::Fill)
        .style(style::pane)
        .into()
}

fn entry_row<'a, M: 'a>(entry: &'a Entry) -> Element<'a, M> {
    match entry {
        Entry::Heading(level, body) => {
            let (size, color) = match level {
                1 => (t::SZ_BODY_LG, t::TEXT),
                2 => (t::SZ_BODY, t::TEXT),
                _ => (t::SZ_META, t::TEXT_MUTED),
            };
            container(
                text(body.clone())
                    .size(size)
                    .color(color)
                    .font(t::UI_MED),
            )
            .padding(Padding::from([6, 4]))
            .into()
        }
        Entry::Bullet(body) => row![
            Space::new().width(Length::Fixed(8.0)),
            text("•").size(t::SZ_META).color(t::TEXT_DIM),
            Space::new().width(Length::Fixed(6.0)),
            text(body.clone()).size(t::SZ_META).color(t::TEXT_MUTED),
        ]
        .align_y(Alignment::Start)
        .padding(Padding::from([2, 4]))
        .into(),
        Entry::Paragraph(body) => text(body.clone())
            .size(t::SZ_META)
            .color(t::TEXT_MUTED)
            .into(),
    }
}

fn empty_missing<'a, M: 'a>() -> Element<'a, M> {
    column![
        Space::new().height(Length::Fixed(24.0)),
        container(
            text("no memories yet")
                .size(t::SZ_BODY)
                .color(t::TEXT_MUTED)
                .font(t::UI_MED),
        )
        .width(Length::Fill)
        .align_x(Alignment::Center),
        Space::new().height(Length::Fixed(4.0)),
        container(
            text("~/.claude/projects/<cwd>/memory/MEMORY.md is missing")
                .size(t::SZ_META)
                .color(t::TEXT_DIM),
        )
        .width(Length::Fill)
        .align_x(Alignment::Center),
    ]
    .into()
}

fn empty_blank<'a, M: 'a>() -> Element<'a, M> {
    column![
        Space::new().height(Length::Fixed(24.0)),
        container(
            text("memory file is empty")
                .size(t::SZ_BODY)
                .color(t::TEXT_MUTED)
                .font(t::UI_MED),
        )
        .width(Length::Fill)
        .align_x(Alignment::Center),
        Space::new().height(Length::Fixed(4.0)),
        container(
            text("tell an agent: /memory add …")
                .size(t::SZ_META)
                .color(t::TEXT_DIM),
        )
        .width(Length::Fill)
        .align_x(Alignment::Center),
    ]
    .into()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn classifies_headings_and_bullets() {
        assert!(matches!(classify("# Title"), Entry::Heading(1, _)));
        assert!(matches!(classify("### Sub"), Entry::Heading(3, _)));
        assert!(matches!(classify("- item"), Entry::Bullet(_)));
        assert!(matches!(classify("* item"), Entry::Bullet(_)));
        assert!(matches!(classify("plain line"), Entry::Paragraph(_)));
    }

    #[test]
    fn encodes_project_dir_like_claude() {
        let p = Path::new("/Users/you/Documents/New Git");
        assert_eq!(
            encode_project_dir(p),
            "-Users-you-Documents-New-Git".to_string()
        );
    }
}
