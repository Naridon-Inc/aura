//! Doctor pane — quick repo health checks, rendered as a list of rows with
//! an `ok`/`warn`/`fail` pill. All checks run synchronously at load time
//! (they're all cheap — fs stat + one `git rev-list --count`).
//!
//! Checks:
//!   a) `.aura/` directory exists
//!   b) `aura` binary on PATH (`which aura`)
//!   c) current branch has commits ahead of main (`git rev-list --count main..HEAD`)
//!   d) blockstore opens (tries to open the db file if it exists)

use std::path::{Path, PathBuf};
use std::process::Command;

use aura_blockstore::BlockStore;
use iced::widget::{button, column, container, row, scrollable, text, Space};
use iced::{Alignment, Color, Element, Length, Padding};

use crate::config;
use crate::ui::style;
use crate::theme as t;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Verdict {
    Ok,
    Warn,
    Fail,
}

#[derive(Debug, Clone)]
pub struct Check {
    pub name: String,
    pub detail: String,
    pub verdict: Verdict,
}

#[derive(Debug, Clone)]
pub enum Action {
    /// Re-run the checks. Reserved for a manual "refresh" button.
    Rerun,
}

pub struct Model {
    pub checks: Vec<Check>,
}

impl Model {
    pub fn load(root: &Path) -> Self {
        let checks = vec![
            check_aura_dir(root),
            check_aura_binary(),
            check_commits_ahead(root),
            check_blockstore(),
        ];
        Self { checks }
    }
}

fn check_aura_dir(root: &Path) -> Check {
    let p = root.join(".aura");
    if p.is_dir() {
        Check {
            name: ".aura/ directory".into(),
            detail: p.display().to_string(),
            verdict: Verdict::Ok,
        }
    } else {
        Check {
            name: ".aura/ directory".into(),
            detail: "missing — run `aura init`".into(),
            verdict: Verdict::Warn,
        }
    }
}

fn check_aura_binary() -> Check {
    match which_on_path("aura") {
        Some(path) => Check {
            name: "aura on PATH".into(),
            detail: path.display().to_string(),
            verdict: Verdict::Ok,
        },
        None => Check {
            name: "aura on PATH".into(),
            detail: "not found — add aura-cli to PATH".into(),
            verdict: Verdict::Fail,
        },
    }
}

fn check_commits_ahead(root: &Path) -> Check {
    let output = Command::new("git")
        .args(["rev-list", "--count", "main..HEAD"])
        .current_dir(root)
        .output();
    match output {
        Ok(o) if o.status.success() => {
            let n = String::from_utf8_lossy(&o.stdout).trim().to_string();
            let count: u32 = n.parse().unwrap_or(0);
            let verdict = if count == 0 {
                Verdict::Ok
            } else {
                Verdict::Warn
            };
            Check {
                name: "ahead of main".into(),
                detail: format!("{count} commit(s) ahead of main"),
                verdict,
            }
        }
        _ => Check {
            name: "ahead of main".into(),
            detail: "git unavailable or main branch not found".into(),
            verdict: Verdict::Warn,
        },
    }
}

fn check_blockstore() -> Check {
    let db_path = match config::db_path() {
        Ok(p) => p,
        Err(e) => {
            return Check {
                name: "blockstore".into(),
                detail: format!("config error: {e}"),
                verdict: Verdict::Fail,
            };
        }
    };
    match BlockStore::open(&db_path) {
        Ok(_) => Check {
            name: "blockstore".into(),
            detail: db_path.display().to_string(),
            verdict: Verdict::Ok,
        },
        Err(e) => Check {
            name: "blockstore".into(),
            detail: format!("open failed: {e}"),
            verdict: Verdict::Fail,
        },
    }
}

fn which_on_path(name: &str) -> Option<PathBuf> {
    let path = std::env::var_os("PATH")?;
    for dir in std::env::split_paths(&path) {
        let candidate = dir.join(name);
        if is_executable(&candidate) {
            return Some(candidate);
        }
    }
    None
}

#[cfg(unix)]
fn is_executable(p: &Path) -> bool {
    use std::os::unix::fs::PermissionsExt;
    match std::fs::metadata(p) {
        Ok(md) => md.is_file() && md.permissions().mode() & 0o111 != 0,
        Err(_) => false,
    }
}

#[cfg(not(unix))]
fn is_executable(p: &Path) -> bool {
    p.is_file()
}

pub fn view<'a, M: 'a + Clone>(
    model: &'a Model,
    on_action: impl Fn(Action) -> M + 'a,
) -> Element<'a, M> {
    let header = row![
        text("Doctor")
            .size(t::SZ_BODY_LG)
            .color(t::TEXT)
            .font(t::UI_MED),
        Space::new().width(Length::Fill),
        button(
            container(
                text("rerun")
                    .size(t::SZ_TINY)
                    .color(t::TEXT)
                    .font(t::UI_MED),
            )
            .padding(Padding::from([3, 8])),
        )
        .padding(0)
        .on_press((on_action)(Action::Rerun))
        .style(style::primary_action),
    ]
    .align_y(Alignment::Center);

    let mut col = column![].spacing(6);
    for check in &model.checks {
        col = col.push(check_row(check));
    }

    let scrolled = scrollable(container(col).width(Length::Fill))
        .height(Length::Fill)
        .width(Length::Fill)
        .style(style::scroller);

    let content = column![header, Space::new().height(Length::Fixed(t::P_SM)), scrolled]
        .padding(Padding::from([t::P_MD, t::P_MD]));

    container(content)
        .width(Length::Fill)
        .height(Length::Fill)
        .style(style::pane)
        .into()
}

fn check_row<'a, M: 'a>(check: &'a Check) -> Element<'a, M> {
    let (bg, label, fg) = verdict_style(check.verdict);
    let pill = container(
        text(label.to_string())
            .size(t::SZ_TINY)
            .color(fg)
            .font(t::UI_MED),
    )
    .padding(Padding::from([1, 6]))
    .style(style::chip_flat(bg, fg));

    let body = column![
        row![
            pill,
            Space::new().width(Length::Fixed(8.0)),
            text(check.name.clone())
                .size(t::SZ_META)
                .color(t::TEXT)
                .font(t::UI_MED),
        ]
        .align_y(Alignment::Center),
        text(check.detail.clone())
            .size(t::SZ_TINY)
            .color(t::TEXT_DIM)
            .font(t::MONO),
    ]
    .spacing(2)
    .padding(Padding::from([8, 10]));

    container(body)
        .width(Length::Fill)
        .style(style::card)
        .into()
}

fn verdict_style(verdict: Verdict) -> (Color, &'static str, Color) {
    match verdict {
        Verdict::Ok => (t::S_COMPLETED, "ok", t::BG),
        Verdict::Warn => (t::S_GATED, "warn", t::BG),
        Verdict::Fail => (t::S_FAILED, "fail", t::TEXT),
    }
}
