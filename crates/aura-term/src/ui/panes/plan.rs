//! Plan pane — lists any `.aura/waves/*.xml` files. Each file is one plan;
//! we surface the filename, the number of `<wave>` elements, and a status
//! derived from the first wave status attribute we can parse.
//!
//! Parsing is intentionally permissive — `.aura/waves` is a working-agent
//! directory whose schema evolves. We count top-level tags and look for a
//! `status="..."` attribute. If we can't tell, we show the file anyway
//! with an `unknown` status rather than hide it.

use std::fs;
use std::path::{Path, PathBuf};
use std::rc::Rc;

use iced::widget::{button, column, container, row, scrollable, text, Space};
use iced::{Alignment, Color, Element, Length, Padding};

use crate::ui::style;
use crate::theme as t;

#[derive(Debug, Clone)]
pub enum Action {
    Open(PathBuf),
}

pub struct Model {
    pub plans: Vec<PlanFile>,
}

#[derive(Debug, Clone)]
pub struct PlanFile {
    pub path: PathBuf,
    pub name: String,
    pub wave_count: usize,
    pub status: PlanStatus,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum PlanStatus {
    Locked,
    Active,
    Done,
    Unknown,
}

impl Model {
    pub fn load(root: &Path) -> Self {
        let dir = root.join(".aura").join("waves");
        let mut plans = Vec::new();
        if let Ok(rd) = fs::read_dir(&dir) {
            for entry in rd.filter_map(|e| e.ok()) {
                let path = entry.path();
                let is_xml = path
                    .extension()
                    .and_then(|s| s.to_str())
                    .map(|s| s.eq_ignore_ascii_case("xml"))
                    .unwrap_or(false);
                if !is_xml {
                    continue;
                }
                let name = path
                    .file_name()
                    .and_then(|s| s.to_str())
                    .unwrap_or("plan.xml")
                    .to_string();
                let content = fs::read_to_string(&path).unwrap_or_default();
                let wave_count = count_tag(&content, "wave");
                let status = parse_status(&content);
                plans.push(PlanFile {
                    path,
                    name,
                    wave_count,
                    status,
                });
            }
        }
        plans.sort_by(|a, b| a.name.cmp(&b.name));
        Self { plans }
    }
}

pub fn view<'a, M: 'a + Clone>(
    model: &'a Model,
    on_action: impl Fn(Action) -> M + 'a,
) -> Element<'a, M> {
    let on_action: Rc<dyn Fn(Action) -> M + 'a> = Rc::new(on_action);

    let header = text("Plan")
        .size(t::SZ_BODY_LG)
        .color(t::TEXT)
        .font(t::UI_MED);

    let body: Element<'a, M> = if model.plans.is_empty() {
        empty_state()
    } else {
        let mut col = column![].spacing(2);
        for plan in &model.plans {
            let on_press = (on_action)(Action::Open(plan.path.clone()));
            col = col.push(plan_row(plan, on_press));
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

fn plan_row<'a, M: 'a + Clone>(
    plan: &'a PlanFile,
    on_press: M,
) -> Element<'a, M> {
    let (status_color, status_label) = status_style(plan.status);
    let dot = container(
        Space::new()
            .width(Length::Fixed(6.0))
            .height(Length::Fixed(6.0)),
    )
    .style(style::dot(status_color));

    let inner = row![
        Space::new().width(Length::Fixed(6.0)),
        dot,
        Space::new().width(Length::Fixed(8.0)),
        text(plan.name.clone())
            .size(t::SZ_META)
            .color(t::TEXT),
        Space::new().width(Length::Fixed(10.0)),
        text(format!("{} waves", plan.wave_count))
            .size(t::SZ_TINY)
            .color(t::TEXT_DIM)
            .font(t::MONO),
        Space::new().width(Length::Fill),
        text(status_label.to_string())
            .size(t::SZ_TINY)
            .color(t::TEXT_MUTED)
            .font(t::UI_MED),
        Space::new().width(Length::Fixed(6.0)),
    ]
    .align_y(Alignment::Center)
    .padding(Padding::from([6, 4]));

    button(inner)
        .padding(0)
        .on_press(on_press)
        .style(style::row_button(false))
        .width(Length::Fill)
        .into()
}

fn empty_state<'a, M: 'a>() -> Element<'a, M> {
    column![
        Space::new().height(Length::Fixed(24.0)),
        container(
            text("no active plan")
                .size(t::SZ_BODY)
                .color(t::TEXT_MUTED)
                .font(t::UI_MED),
        )
        .width(Length::Fill)
        .align_x(Alignment::Center),
        Space::new().height(Length::Fixed(4.0)),
        container(
            text("type ⌘K plan to start")
                .size(t::SZ_META)
                .color(t::TEXT_DIM),
        )
        .width(Length::Fill)
        .align_x(Alignment::Center),
    ]
    .into()
}

fn status_style(status: PlanStatus) -> (Color, &'static str) {
    match status {
        PlanStatus::Locked => (t::S_GATED, "locked"),
        PlanStatus::Active => (t::S_RUNNING, "active"),
        PlanStatus::Done => (t::S_COMPLETED, "done"),
        PlanStatus::Unknown => (t::TEXT_DIM, "—"),
    }
}

fn count_tag(xml: &str, tag: &str) -> usize {
    let open = format!("<{tag}");
    xml.match_indices(&open)
        .filter(|(_, m)| {
            let end_byte = m.len();
            xml[m.len()..]
                .chars()
                .next()
                .map(|c| c.is_whitespace() || c == '>' || c == '/')
                .unwrap_or(false)
                || end_byte == 0
        })
        .count()
}

fn parse_status(xml: &str) -> PlanStatus {
    // Look for the first `status="..."` token. If we find multiple, the
    // first one reflects the highest-priority container (the `<plan>` tag
    // at the top of a well-formed waves file).
    let needle = "status=\"";
    if let Some(pos) = xml.find(needle) {
        let rest = &xml[pos + needle.len()..];
        if let Some(end) = rest.find('"') {
            let val = &rest[..end];
            return match val {
                "locked" => PlanStatus::Locked,
                "active" | "running" | "open" => PlanStatus::Active,
                "done" | "completed" | "closed" => PlanStatus::Done,
                _ => PlanStatus::Unknown,
            };
        }
    }
    PlanStatus::Unknown
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn counts_waves() {
        let xml = r#"<plan><wave id="1"/><wave id="2"></wave><wave/></plan>"#;
        assert_eq!(count_tag(xml, "wave"), 3);
    }

    #[test]
    fn parses_status_attr() {
        assert_eq!(parse_status(r#"<plan status="locked">"#), PlanStatus::Locked);
        assert_eq!(parse_status(r#"<plan status="active">"#), PlanStatus::Active);
        assert_eq!(parse_status(r#"<plan>"#), PlanStatus::Unknown);
    }
}
