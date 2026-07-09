//! Timeline pane — snapshot history, grouped by day.
//!
//! Scans `.aura/snapshots/` for entries (flat or nested) and groups them by
//! the calendar date of the file's modification time. Each row shows the
//! snapshot's file path (relative to the repo), the `HH:MM` timestamp, and
//! a `rewind` button that dispatches `Action::Rewind(path)` — the app wires
//! this into its real rewind path in a follow-up wave; here we only surface
//! the UI affordance and dispatch the message.

use std::fs;
use std::path::{Path, PathBuf};
use std::rc::Rc;

use iced::widget::{button, column, container, row, scrollable, text, Space};
use iced::{Alignment, Element, Length, Padding};
use time::{format_description::well_known::Rfc3339, OffsetDateTime};

use crate::ui::style;
use crate::theme as t;

#[derive(Debug, Clone)]
pub enum Action {
    Rewind(PathBuf),
}

pub struct Model {
    pub root: PathBuf,
    pub groups: Vec<DayGroup>,
    pub total: usize,
}

#[derive(Debug, Clone)]
pub struct DayGroup {
    pub label: String,
    pub snapshots: Vec<Snapshot>,
}

#[derive(Debug, Clone)]
pub struct Snapshot {
    pub path: PathBuf,
    pub relative: String,
    pub ts: Option<OffsetDateTime>,
}

impl Model {
    pub fn load(root: &Path) -> Self {
        let snap_root = root.join(".aura").join("snapshots");
        let mut entries: Vec<Snapshot> = Vec::new();
        walk(&snap_root, &snap_root, &mut entries);
        // Newest first.
        entries.sort_by(|a, b| b.ts.cmp(&a.ts));

        let mut groups: Vec<DayGroup> = Vec::new();
        for snap in entries.iter() {
            let label = snap
                .ts
                .map(|d| format!("{:04}-{:02}-{:02}", d.year(), d.month() as u8, d.day()))
                .unwrap_or_else(|| "unknown".to_string());
            if groups.last().map(|g| g.label.as_str()) != Some(label.as_str()) {
                groups.push(DayGroup {
                    label,
                    snapshots: Vec::new(),
                });
            }
            if let Some(g) = groups.last_mut() {
                g.snapshots.push(snap.clone());
            }
        }

        Self {
            root: root.to_path_buf(),
            total: entries.len(),
            groups,
        }
    }
}

fn walk(base: &Path, dir: &Path, out: &mut Vec<Snapshot>) {
    let Ok(rd) = fs::read_dir(dir) else {
        return;
    };
    for entry in rd.filter_map(|e| e.ok()) {
        let path = entry.path();
        let Ok(md) = entry.metadata() else { continue };
        if md.is_dir() {
            walk(base, &path, out);
            continue;
        }
        let rel = path
            .strip_prefix(base)
            .map(|p| p.to_string_lossy().into_owned())
            .unwrap_or_else(|_| path.to_string_lossy().into_owned());
        let ts = md
            .modified()
            .ok()
            .and_then(|t| OffsetDateTime::from(t).checked_to_offset(time::UtcOffset::UTC));
        // If `checked_to_offset` fails we still include it with `ts: None`.
        let ts = ts.or_else(|| md.modified().ok().map(OffsetDateTime::from));
        out.push(Snapshot {
            path,
            relative: rel,
            ts,
        });
    }
}

pub fn view<'a, M: 'a + Clone>(
    model: &'a Model,
    on_action: impl Fn(Action) -> M + 'a,
) -> Element<'a, M> {
    let on_action: Rc<dyn Fn(Action) -> M + 'a> = Rc::new(on_action);

    let header = row![
        text("Timeline")
            .size(t::SZ_BODY_LG)
            .color(t::TEXT)
            .font(t::UI_MED),
        Space::new().width(Length::Fill),
        text(format!("{} snapshots", model.total))
            .size(t::SZ_TINY)
            .color(t::TEXT_DIM)
            .font(t::MONO),
    ]
    .align_y(Alignment::Center);

    let body: Element<'a, M> = if model.groups.is_empty() {
        empty_state()
    } else {
        let mut col = column![].spacing(8);
        for group in &model.groups {
            col = col.push(
                text(group.label.clone())
                    .size(t::SZ_TINY)
                    .color(t::TEXT_DIM)
                    .font(t::UI_MED),
            );
            let mut inner = column![].spacing(2);
            for snap in &group.snapshots {
                let on_press = (on_action)(Action::Rewind(snap.path.clone()));
                inner = inner.push(snap_row(snap, on_press));
            }
            col = col.push(inner);
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

fn snap_row<'a, M: 'a + Clone>(
    snap: &'a Snapshot,
    on_press: M,
) -> Element<'a, M> {
    let when = snap
        .ts
        .map(|d| format!("{:02}:{:02}", d.hour(), d.minute()))
        .unwrap_or_else(|| "—".to_string());

    let rewind = button(
        container(
            text("rewind")
                .size(t::SZ_TINY)
                .color(t::TEXT)
                .font(t::UI_MED),
        )
        .padding(Padding::from([3, 8])),
    )
    .padding(0)
    .on_press(on_press)
    .style(style::primary_action);

    row![
        text(when)
            .size(t::SZ_TINY)
            .color(t::TEXT_FAINT)
            .font(t::MONO),
        Space::new().width(Length::Fixed(8.0)),
        text(snap.relative.clone())
            .size(t::SZ_META)
            .color(t::TEXT_MUTED)
            .font(t::MONO),
        Space::new().width(Length::Fill),
        rewind,
    ]
    .align_y(Alignment::Center)
    .padding(Padding::from([3, 4]))
    .into()
}

fn empty_state<'a, M: 'a>() -> Element<'a, M> {
    column![
        Space::new().height(Length::Fixed(24.0)),
        container(
            text("no snapshots yet")
                .size(t::SZ_BODY)
                .color(t::TEXT_MUTED)
                .font(t::UI_MED),
        )
        .width(Length::Fill)
        .align_x(Alignment::Center),
        Space::new().height(Length::Fixed(4.0)),
        container(
            text("snapshots appear here when you call aura_snapshot")
                .size(t::SZ_META)
                .color(t::TEXT_DIM),
        )
        .width(Length::Fill)
        .align_x(Alignment::Center),
    ]
    .into()
}

// Expose this for tests and callers that want to re-format a snapshot.
#[allow(dead_code)]
pub fn format_iso(d: OffsetDateTime) -> String {
    d.format(&Rfc3339).unwrap_or_else(|_| "—".into())
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::TempDir;

    #[test]
    fn walks_snapshots_and_groups_by_day() {
        let dir = TempDir::new().unwrap();
        let snaps = dir.path().join(".aura").join("snapshots").join("2026-01-02");
        fs::create_dir_all(&snaps).unwrap();
        fs::write(snaps.join("one.snap"), b"x").unwrap();
        fs::write(snaps.join("two.snap"), b"y").unwrap();
        let m = Model::load(dir.path());
        assert_eq!(m.total, 2);
        assert!(!m.groups.is_empty());
    }

    #[test]
    fn missing_dir_is_empty() {
        let dir = TempDir::new().unwrap();
        let m = Model::load(dir.path());
        assert_eq!(m.total, 0);
        assert!(m.groups.is_empty());
    }
}
