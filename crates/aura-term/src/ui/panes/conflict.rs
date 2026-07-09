//! Conflict pane — unified surface for multi-agent collisions, git merge
//! markers, and critical cross-branch impacts. The rail tile's count
//! badge is `items.len()`; clicking routes to this pane for the list.
//!
//! Sources (all filesystem polls — no new IPC):
//!
//!   * **Sentinel agent claims** (`.aura/sentinel/*.json`). Each file is
//!     one session's claim set. If two distinct sessions claim an
//!     identical path, that's a collision.
//!   * **Git merge markers** — `git diff --check` emits one line per
//!     conflict marker in the working tree; we shell out once on load.
//!   * **Critical impacts** (`.aura/impacts.jsonl` where `severity` is
//!     `crit` or `high`). Re-uses the impact parse path.
//!
//! Load failures are silent — an empty `items` list is the correct
//! "nothing wrong" state, and a mis-configured repo shouldn't noise
//! the rail with false positives.

use std::fs;
use std::path::Path;
use std::process::Command;
use std::rc::Rc;

use iced::widget::{column, container, row, scrollable, text, Space};
use iced::{Alignment, Element, Length, Padding};
use serde::Deserialize;

use crate::theme as t;
use crate::ui::style;

#[derive(Debug, Clone)]
pub enum Action {
    /// Placeholder — the pane surfaces a list; resolution handlers are
    /// wired when the producer sides stabilise.
    Open(String),
}

pub struct Model {
    pub items: Vec<Item>,
}

#[derive(Debug, Clone)]
pub struct Item {
    pub kind: ItemKind,
    pub title: String,
    pub detail: String,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ItemKind {
    SentinelCollision,
    GitMarker,
    CritImpact,
}

impl Model {
    pub fn load(root: &Path) -> Self {
        let mut items = Vec::new();
        items.extend(sentinel_collisions(root));
        items.extend(git_markers(root));
        items.extend(crit_impacts(root));
        Self { items }
    }
}

/// Two distinct sentinel session files claiming the same path indicate
/// a collision the user should know about. One session per file is
/// expected; sharing a path is not.
fn sentinel_collisions(root: &Path) -> Vec<Item> {
    let dir = root.join(".aura").join("sentinel");
    let Ok(read) = fs::read_dir(&dir) else {
        return Vec::new();
    };

    #[derive(Deserialize)]
    struct SentinelFile {
        #[serde(default)]
        session: Option<String>,
        #[serde(default)]
        claims: Vec<String>,
    }

    let mut claims_by_path: std::collections::HashMap<String, Vec<String>> =
        std::collections::HashMap::new();
    for entry in read.filter_map(|e| e.ok()) {
        let path = entry.path();
        if path.extension().and_then(|s| s.to_str()) != Some("json") {
            continue;
        }
        let Ok(text) = fs::read_to_string(&path) else {
            continue;
        };
        let Ok(file) = serde_json::from_str::<SentinelFile>(&text) else {
            continue;
        };
        let session = file
            .session
            .unwrap_or_else(|| path.file_stem().unwrap_or_default().to_string_lossy().into());
        for claim in file.claims {
            claims_by_path
                .entry(claim)
                .or_default()
                .push(session.clone());
        }
    }

    claims_by_path
        .into_iter()
        .filter(|(_, v)| v.len() > 1)
        .map(|(path, sessions)| Item {
            kind: ItemKind::SentinelCollision,
            title: path,
            detail: format!("claimed by: {}", sessions.join(", ")),
        })
        .collect()
}

/// `git diff --check` prints one line per leftover conflict marker in
/// the working tree. We treat each line as one item; the raw output is
/// stable enough for a passive readout.
fn git_markers(root: &Path) -> Vec<Item> {
    let out = Command::new("git")
        .args(["diff", "--check"])
        .current_dir(root)
        .output();
    let Ok(out) = out else {
        return Vec::new();
    };
    if out.status.success() {
        return Vec::new();
    }
    String::from_utf8_lossy(&out.stdout)
        .lines()
        .filter(|l| !l.trim().is_empty())
        .map(|line| Item {
            kind: ItemKind::GitMarker,
            title: line.to_string(),
            detail: "git conflict marker".into(),
        })
        .collect()
}

fn crit_impacts(root: &Path) -> Vec<Item> {
    let path = root.join(".aura").join("impacts.jsonl");
    let Ok(contents) = fs::read_to_string(&path) else {
        return Vec::new();
    };

    #[derive(Deserialize)]
    struct Alert {
        #[serde(default)]
        id: String,
        #[serde(default)]
        severity: String,
        #[serde(default)]
        summary: String,
    }

    contents
        .lines()
        .filter_map(|line| serde_json::from_str::<Alert>(line.trim()).ok())
        .filter(|a| matches!(a.severity.as_str(), "crit" | "critical" | "high"))
        .map(|a| Item {
            kind: ItemKind::CritImpact,
            title: a.summary,
            detail: format!("impact · {} · {}", a.severity, a.id),
        })
        .collect()
}

pub fn view<'a, M: 'a + Clone>(
    model: &'a Model,
    on_action: impl Fn(Action) -> M + 'a,
) -> Element<'a, M> {
    let on_action: Rc<dyn Fn(Action) -> M + 'a> = Rc::new(on_action);

    let header = text("Conflicts")
        .size(t::SZ_BODY_LG)
        .color(t::TEXT)
        .font(t::UI_MED);

    let subtitle = text("sentinel collisions · git markers · critical impacts")
        .size(t::SZ_TINY)
        .color(t::TEXT_DIM);

    let body: Element<'a, M> = if model.items.is_empty() {
        empty_state()
    } else {
        let mut col = column![].spacing(6);
        for item in &model.items {
            let chip_color = match item.kind {
                ItemKind::SentinelCollision => t::AMBER,
                ItemKind::GitMarker => t::RED,
                ItemKind::CritImpact => t::RED,
            };
            let chip_label = match item.kind {
                ItemKind::SentinelCollision => "sentinel",
                ItemKind::GitMarker => "git",
                ItemKind::CritImpact => "impact",
            };
            let key = item.title.clone();
            let on_action = on_action.clone();
            let row_el = row![
                container(
                    text(chip_label)
                        .size(t::SZ_TINY)
                        .color(chip_color)
                        .font(t::UI_MED),
                )
                .padding(Padding::from([2, 6]))
                .style(style::chip_soft(t::PANE_ALT, chip_color)),
                Space::new().width(Length::Fixed(10.0)),
                column![
                    text(item.title.clone()).size(t::SZ_META).color(t::TEXT),
                    text(item.detail.clone()).size(t::SZ_TINY).color(t::TEXT_DIM),
                ]
                .spacing(2),
            ]
            .align_y(Alignment::Center);

            col = col.push(
                iced::widget::button(container(row_el).padding(Padding::from([6, 8])))
                    .padding(0)
                    .on_press((on_action)(Action::Open(key)))
                    .style(style::chip_button(false)),
            );
        }
        scrollable(container(col).width(Length::Fill))
            .height(Length::Fill)
            .width(Length::Fill)
            .style(style::scroller)
            .into()
    };

    let content = column![
        header,
        Space::new().height(Length::Fixed(2.0)),
        subtitle,
        Space::new().height(Length::Fixed(t::P_MD)),
        body,
    ]
    .padding(Padding::from([t::P_MD, t::P_MD]));

    container(content)
        .width(Length::Fill)
        .height(Length::Fill)
        .style(style::pane)
        .into()
}

fn empty_state<'a, M: 'a>() -> Element<'a, M> {
    column![
        Space::new().height(Length::Fixed(24.0)),
        container(
            text("no conflicts")
                .size(t::SZ_META)
                .color(t::TEXT_MUTED),
        )
        .width(Length::Fill)
        .align_x(Alignment::Center),
        Space::new().height(Length::Fixed(4.0)),
        container(
            text("clean sentinel claims, no merge markers, no crit impacts")
                .size(t::SZ_TINY)
                .color(t::TEXT_DIM),
        )
        .width(Length::Fill)
        .align_x(Alignment::Center),
    ]
    .into()
}
