//! Impacts pane — lists cross-branch impact alerts from `.aura/impacts.jsonl`.
//! Each line of the JSONL is one alert. We expect fields:
//!   * `id`        — string — stable alert id (used to resolve)
//!   * `severity`  — "low" | "med" | "high" | "crit"
//!   * `summary`   — string — human-readable one-liner
//!   * `function`  — string — optional, rendered as a chip if present
//!
//! Unknown fields are ignored; malformed lines are skipped (tracked as
//! parse errors in the model so the UI can surface a tiny footer count).

use std::fs;
use std::path::Path;
use std::rc::Rc;

use iced::widget::{button, column, container, row, scrollable, text, Space};
use iced::{Alignment, Color, Element, Length, Padding};
use serde::Deserialize;

use crate::ui::style;
use crate::theme as t;

#[derive(Debug, Clone)]
pub enum Action {
    Resolve(String),
}

pub struct Model {
    pub alerts: Vec<Alert>,
    pub parse_errors: usize,
}

#[derive(Debug, Clone, Deserialize)]
pub struct Alert {
    pub id: String,
    #[serde(default)]
    pub severity: String,
    #[serde(default)]
    pub summary: String,
    #[serde(default)]
    pub function: Option<String>,
}

impl Model {
    pub fn load(root: &Path) -> Self {
        let path = root.join(".aura").join("impacts.jsonl");
        let mut alerts = Vec::new();
        let mut parse_errors = 0usize;
        if let Ok(contents) = fs::read_to_string(&path) {
            for line in contents.lines() {
                let trimmed = line.trim();
                if trimmed.is_empty() {
                    continue;
                }
                match serde_json::from_str::<Alert>(trimmed) {
                    Ok(a) if !a.id.is_empty() => alerts.push(a),
                    Ok(_) => parse_errors += 1,
                    Err(_) => parse_errors += 1,
                }
            }
        }
        Self {
            alerts,
            parse_errors,
        }
    }
}

pub fn view<'a, M: 'a + Clone>(
    model: &'a Model,
    on_action: impl Fn(Action) -> M + 'a,
) -> Element<'a, M> {
    let on_action: Rc<dyn Fn(Action) -> M + 'a> = Rc::new(on_action);

    let header = row![
        text("Impacts")
            .size(t::SZ_BODY_LG)
            .color(t::TEXT)
            .font(t::UI_MED),
        Space::new().width(Length::Fill),
        text(format!("{} open", model.alerts.len()))
            .size(t::SZ_TINY)
            .color(t::TEXT_DIM)
            .font(t::MONO),
    ]
    .align_y(Alignment::Center);

    let body: Element<'a, M> = if model.alerts.is_empty() {
        empty_state(model.parse_errors)
    } else {
        let mut col = column![].spacing(6);
        for alert in &model.alerts {
            let on_resolve = (on_action)(Action::Resolve(alert.id.clone()));
            col = col.push(alert_row(alert, on_resolve));
        }
        if model.parse_errors > 0 {
            col = col.push(
                text(format!(
                    "note: {} line(s) in .aura/impacts.jsonl could not be parsed",
                    model.parse_errors
                ))
                .size(t::SZ_TINY)
                .color(t::TEXT_DIM),
            );
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

fn alert_row<'a, M: 'a + Clone>(
    alert: &'a Alert,
    on_resolve: M,
) -> Element<'a, M> {
    let (sev_color, sev_label) = severity_style(&alert.severity);

    let pill = container(
        text(sev_label.to_string())
            .size(t::SZ_TINY)
            .color(t::TEXT)
            .font(t::UI_MED),
    )
    .padding(Padding::from([1, 6]))
    .style(style::chip_flat(sev_color, t::TEXT));

    let summary = if alert.summary.is_empty() {
        alert.id.clone()
    } else {
        alert.summary.clone()
    };

    let mut top = row![
        pill,
        Space::new().width(Length::Fixed(8.0)),
        text(truncate(&summary, 64))
            .size(t::SZ_META)
            .color(t::TEXT),
    ]
    .align_y(Alignment::Center);

    if let Some(func) = alert.function.as_deref() {
        top = top.push(Space::new().width(Length::Fixed(8.0)));
        top = top.push(
            container(
                text(func.to_string())
                    .size(t::SZ_TINY)
                    .color(t::TEXT_MUTED)
                    .font(t::MONO),
            )
            .padding(Padding::from([1, 6]))
            .style(style::stat_chip),
        );
    }

    let resolve_btn = button(
        container(
            text("resolve")
                .size(t::SZ_TINY)
                .color(t::TEXT)
                .font(t::UI_MED),
        )
        .padding(Padding::from([4, 10])),
    )
    .padding(0)
    .on_press(on_resolve)
    .style(style::primary_action);

    let bottom = row![Space::new().width(Length::Fill), resolve_btn].align_y(Alignment::Center);

    let card = column![top, Space::new().height(Length::Fixed(6.0)), bottom]
        .spacing(0)
        .padding(Padding::from([8, 10]));

    container(card)
        .width(Length::Fill)
        .style(style::card)
        .into()
}

fn empty_state<'a, M: 'a>(parse_errors: usize) -> Element<'a, M> {
    let hint = if parse_errors > 0 {
        format!("({parse_errors} malformed line(s) in .aura/impacts.jsonl)")
    } else {
        "all clear".into()
    };
    column![
        Space::new().height(Length::Fixed(24.0)),
        container(
            text("no cross-branch impacts")
                .size(t::SZ_BODY)
                .color(t::TEXT_MUTED)
                .font(t::UI_MED),
        )
        .width(Length::Fill)
        .align_x(Alignment::Center),
        Space::new().height(Length::Fixed(4.0)),
        container(
            text(hint)
                .size(t::SZ_META)
                .color(t::TEXT_DIM),
        )
        .width(Length::Fill)
        .align_x(Alignment::Center),
    ]
    .into()
}

fn severity_style(sev: &str) -> (Color, &'static str) {
    match sev.to_ascii_lowercase().as_str() {
        "crit" | "critical" | "high" => (t::S_FAILED, "high"),
        "med" | "medium" | "warn" => (t::S_RUNNING, "med"),
        "low" | "info" => (t::INFO, "low"),
        "" => (t::TEXT_DIM, "—"),
        _ => (t::TEXT_DIM, "?"),
    }
}

fn truncate(s: &str, n: usize) -> String {
    let first = s.lines().next().unwrap_or("");
    if first.len() > n {
        format!("{}…", &first[..n.saturating_sub(1)])
    } else {
        first.to_string()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::TempDir;

    #[test]
    fn loads_jsonl_and_skips_bad_lines() {
        let dir = TempDir::new().unwrap();
        let aura = dir.path().join(".aura");
        fs::create_dir_all(&aura).unwrap();
        let jsonl = aura.join("impacts.jsonl");
        fs::write(
            &jsonl,
            r#"{"id":"a1","severity":"high","summary":"deleted fn foo","function":"foo"}
oops not json
{"id":"a2","severity":"med","summary":"changed fn bar"}
"#,
        )
        .unwrap();
        let m = Model::load(dir.path());
        assert_eq!(m.alerts.len(), 2);
        assert_eq!(m.alerts[0].id, "a1");
        assert_eq!(m.parse_errors, 1);
    }

    #[test]
    fn missing_file_is_empty() {
        let dir = TempDir::new().unwrap();
        let m = Model::load(dir.path());
        assert!(m.alerts.is_empty());
        assert_eq!(m.parse_errors, 0);
    }
}
