//! Orchestration pane — hosts the multi-agent grid view.
//!
//! Data sources (merged in order):
//!   1. `.aura/orchestrate/<plan>.json` — authoritative plan state written by
//!      `aura orchestrate`. Shape:
//!
//!      ```json
//!      {
//!        "agents": [
//!          {
//!            "actor": "did:aura:agent/claude-code",
//!            "role": "implementer",
//!            "current_task": "W3.T4 — apply_op roundtrip",
//!            "status": "running",
//!            "last_intent": "wired the reducer",
//!            "progress": 0.6
//!          }
//!        ]
//!      }
//!      ```
//!
//!   2. `.aura/sentinel/agents.json` — presence-only records written by
//!      `aura_sentinel_status`. Shape:
//!
//!      ```json
//!      { "agents": [ { "did": "did:aura:agent/claude-code",
//!                      "role": "implementer",
//!                      "last_seen": 1700000000 } ] }
//!      ```
//!
//!      These become tiles with `Idle` status and no current task.
//!
//! Parsing is defensive: any IO or serde error returns `Vec::new()` rather
//! than panicking — the grid widget already handles the empty case with a
//! clear empty-state panel.

use std::fs;
use std::path::Path;
use std::rc::Rc;

use iced::widget::{button, column, container, row, scrollable, text, Space};
use iced::{Alignment, Element, Length, Padding};
use serde::Deserialize;

use crate::ui::icon;
use crate::ui::orchestration::{Tile, TileStatus};
use crate::ui::style;
use crate::theme as t;

use aura_blocks::AgentRef;

// ── action enum + model ──────────────────────────────────────────────────

#[derive(Debug, Clone)]
pub enum Action {
    TileClicked(usize),
    Refresh,
}

/// Borrowed view model — the pane itself doesn't own any state; the app
/// passes in a slice of tiles and the active plan label.
pub struct Model<'a> {
    pub tiles: &'a [Tile],
    /// Stem of the active `.aura/waves/<name>.xml` plan, if any.
    pub active_plan: Option<&'a str>,
}

// ── view ────────────────────────────────────────────────────────────────

pub fn view<'a, M: 'a + Clone>(
    model: Model<'a>,
    on_action: impl Fn(Action) -> M + 'a,
) -> Element<'a, M> {
    let on_action: Rc<dyn Fn(Action) -> M + 'a> = Rc::new(on_action);

    // ── header: title · plan label · refresh button ─────────────────────
    let title = text("Orchestration")
        .size(t::SZ_BODY_LG)
        .color(t::TEXT)
        .font(t::UI_MED);

    let plan_label = match model.active_plan {
        Some(name) if !name.is_empty() => text(name.to_string())
            .size(t::SZ_META)
            .color(t::TEXT_DIM)
            .font(t::MONO),
        _ => text("—").size(t::SZ_META).color(t::TEXT_DIM).font(t::MONO),
    };

    let refresh_click = (on_action)(Action::Refresh);
    let refresh_btn = button(
        container(icon::svg_colored(icon::Icon::Refresh, t::SZ_UI, t::TEXT_DIM))
            .padding(Padding::from([t::P_XS, t::P_XS])),
    )
    .padding(0)
    .on_press(refresh_click)
    .style(style::icon_button);

    let header = row![
        title,
        Space::new().width(Length::Fixed(t::P_MD)),
        plan_label,
        Space::new().width(Length::Fill),
        refresh_btn,
    ]
    .align_y(Alignment::Center);

    // ── body: grid or empty state ───────────────────────────────────────
    let on_action_for_tile = on_action.clone();
    let body: Element<'a, M> = if model.tiles.is_empty() {
        crate::ui::orchestration::empty_state()
    } else {
        let grid = crate::ui::orchestration::grid(model.tiles, move |idx| {
            (on_action_for_tile)(Action::TileClicked(idx))
        });
        scrollable(container(grid).width(Length::Fill).padding(Padding::from([0.0, 0.0])))
            .height(Length::Fill)
            .width(Length::Fill)
            .style(style::scroller)
            .into()
    };

    let content = column![
        header,
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

// ── disk loading ─────────────────────────────────────────────────────────

/// Merge tiles from `.aura/orchestrate/<plan>.json` + `.aura/sentinel/agents.json`.
/// Returns an empty vec when neither file is present or both fail to parse.
pub fn load_tiles_from_disk(cwd: &Path) -> Vec<Tile> {
    let mut tiles = Vec::new();

    // (1) Orchestrate plan JSON — pick the first `*.json` under
    // `.aura/orchestrate/` (there's usually one active plan at a time).
    let orchestrate_dir = cwd.join(".aura").join("orchestrate");
    if let Ok(read) = fs::read_dir(&orchestrate_dir) {
        let mut plan_paths: Vec<_> = read
            .filter_map(|e| e.ok())
            .map(|e| e.path())
            .filter(|p| {
                p.extension()
                    .and_then(|s| s.to_str())
                    .map(|s| s.eq_ignore_ascii_case("json"))
                    .unwrap_or(false)
            })
            .collect();
        plan_paths.sort();
        for path in plan_paths {
            if let Ok(body) = fs::read_to_string(&path) {
                if let Ok(file) = serde_json::from_str::<OrchestrateFile>(&body) {
                    for a in file.agents {
                        tiles.push(a.into_tile());
                    }
                }
            }
        }
    }

    // (2) Sentinel presence JSON — only add agents we haven't already
    // represented in the orchestrate file (keyed by DID).
    let sentinel_path = cwd.join(".aura").join("sentinel").join("agents.json");
    if let Ok(body) = fs::read_to_string(&sentinel_path) {
        if let Ok(file) = serde_json::from_str::<SentinelFile>(&body) {
            for a in file.agents {
                if a.did.is_empty() {
                    continue;
                }
                let already_present = tiles.iter().any(|t| t.actor.0 == a.did);
                if already_present {
                    continue;
                }
                tiles.push(Tile {
                    actor: AgentRef(a.did),
                    role: a.role.unwrap_or_else(|| "agent".into()),
                    current_task: String::new(),
                    status: TileStatus::Idle,
                    last_intent: None,
                    progress: None,
                });
            }
        }
    }

    tiles
}

/// Pick the first `.json` stem under `.aura/orchestrate/` as the active plan
/// label; return `None` when nothing is present. Used as the header label
/// next to "Orchestration".
pub fn active_plan_name(cwd: &Path) -> Option<String> {
    let dir = cwd.join(".aura").join("orchestrate");
    let mut paths: Vec<_> = fs::read_dir(&dir)
        .ok()?
        .filter_map(|e| e.ok())
        .map(|e| e.path())
        .filter(|p| {
            p.extension()
                .and_then(|s| s.to_str())
                .map(|s| s.eq_ignore_ascii_case("json"))
                .unwrap_or(false)
        })
        .collect();
    paths.sort();
    paths
        .into_iter()
        .next()
        .and_then(|p| p.file_stem().and_then(|s| s.to_str()).map(|s| s.to_string()))
}

// ── wire types ──────────────────────────────────────────────────────────

#[derive(Debug, Deserialize)]
struct OrchestrateFile {
    #[serde(default)]
    agents: Vec<OrchestrateAgent>,
}

#[derive(Debug, Deserialize)]
struct OrchestrateAgent {
    #[serde(default)]
    actor: String,
    #[serde(default)]
    role: String,
    #[serde(default)]
    current_task: String,
    #[serde(default)]
    status: String,
    #[serde(default)]
    last_intent: Option<String>,
    #[serde(default)]
    progress: Option<f32>,
}

impl OrchestrateAgent {
    fn into_tile(self) -> Tile {
        Tile {
            actor: AgentRef(self.actor),
            role: if self.role.is_empty() {
                "agent".into()
            } else {
                self.role
            },
            current_task: self.current_task,
            status: parse_status(&self.status),
            last_intent: self.last_intent.filter(|s| !s.is_empty()),
            progress: self.progress,
        }
    }
}

#[derive(Debug, Deserialize)]
struct SentinelFile {
    #[serde(default)]
    agents: Vec<SentinelAgent>,
}

#[derive(Debug, Deserialize)]
struct SentinelAgent {
    #[serde(default)]
    did: String,
    #[serde(default)]
    role: Option<String>,
    #[serde(default, alias = "lastSeen")]
    #[allow(dead_code)]
    last_seen: Option<i64>,
}

fn parse_status(s: &str) -> TileStatus {
    match s.trim().to_ascii_lowercase().as_str() {
        "running" | "active" => TileStatus::Running,
        "gated" => TileStatus::Gated,
        "blocked" | "denied" => TileStatus::Blocked,
        "completed" | "done" => TileStatus::Completed,
        "failed" | "error" => TileStatus::Failed,
        _ => TileStatus::Idle,
    }
}

// ── tests ───────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::Path;
    use tempfile::TempDir;

    #[test]
    fn load_tiles_handles_missing_files() {
        let v = load_tiles_from_disk(Path::new("/nonexistent/xxyy"));
        assert!(v.is_empty());
    }

    #[test]
    fn load_tiles_parses_sentinel_agents() {
        let dir = TempDir::new().unwrap();
        let sentinel_dir = dir.path().join(".aura").join("sentinel");
        fs::create_dir_all(&sentinel_dir).unwrap();
        fs::write(
            sentinel_dir.join("agents.json"),
            r#"{"agents":[{"did":"did:aura:agent/claude-code","role":"implementer","last_seen":1700000000}]}"#,
        )
        .unwrap();

        let v = load_tiles_from_disk(dir.path());
        assert_eq!(v.len(), 1);
        assert_eq!(v[0].actor.0, "did:aura:agent/claude-code");
        assert_eq!(v[0].role, "implementer");
        assert_eq!(v[0].status, TileStatus::Idle);
        assert!(v[0].current_task.is_empty());
    }

    #[test]
    fn load_tiles_parses_orchestrate_plan() {
        let dir = TempDir::new().unwrap();
        let orchestrate_dir = dir.path().join(".aura").join("orchestrate");
        fs::create_dir_all(&orchestrate_dir).unwrap();
        fs::write(
            orchestrate_dir.join("w3.json"),
            r#"{
              "agents":[
                {"actor":"did:aura:agent/claude-code","role":"implementer","current_task":"W3.T4","status":"running","last_intent":"wired reducer","progress":0.5},
                {"actor":"did:aura:agent/review","role":"reviewer","current_task":"","status":"idle"}
              ]
            }"#,
        )
        .unwrap();

        let v = load_tiles_from_disk(dir.path());
        assert_eq!(v.len(), 2);
        assert_eq!(v[0].status, TileStatus::Running);
        assert_eq!(v[0].progress, Some(0.5));
        assert_eq!(v[1].status, TileStatus::Idle);
    }

    #[test]
    fn load_tiles_ignores_garbage_json() {
        let dir = TempDir::new().unwrap();
        let orchestrate_dir = dir.path().join(".aura").join("orchestrate");
        fs::create_dir_all(&orchestrate_dir).unwrap();
        fs::write(orchestrate_dir.join("bad.json"), "not json {{{").unwrap();

        // Should not panic — parse errors return an empty merge.
        let v = load_tiles_from_disk(dir.path());
        assert!(v.is_empty());
    }
}
