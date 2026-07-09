//! Team pane — mothership presence + recent messages.
//!
//! Reads:
//!   * `.aura/mothership.json`  — JSON `{ "host": "...", "peers": [{...}] }`
//!   * `.aura/messages.jsonl`   — one JSON message per line, most-recent last
//!
//! Peer rows render a presence dot (green = online, dim = stale/offline),
//! the peer name, and "last seen N min ago". Below, a short list of the
//! most recent messages with `{sender · body · time}`.

use std::fs;
use std::path::Path;

use iced::widget::{column, container, row, scrollable, text, Space};
use iced::{Alignment, Color, Element, Length, Padding};
use serde::Deserialize;

use crate::ui::style;
use crate::theme as t;

#[derive(Debug, Clone)]
pub enum Action {
    /// Compose + send is a later wave; the rail-pane layer reserves the
    /// action shape so the call site can plug in without churn.
    NewMessage,
}

pub struct Model {
    pub host: Option<String>,
    pub peers: Vec<Peer>,
    pub messages: Vec<Message>,
    pub configured: bool,
}

#[derive(Debug, Clone, Deserialize)]
pub struct Peer {
    #[serde(default)]
    pub name: String,
    #[serde(default)]
    pub did: Option<String>,
    /// Epoch seconds; preserved so the UI can compute "last seen".
    #[serde(default, alias = "last_seen_s", alias = "lastSeen")]
    pub last_seen: Option<i64>,
    #[serde(default)]
    pub online: Option<bool>,
}

#[derive(Debug, Clone, Deserialize)]
pub struct Message {
    #[serde(default, alias = "from")]
    pub sender: String,
    #[serde(default, alias = "text")]
    pub body: String,
    #[serde(default, alias = "ts")]
    pub at: Option<i64>,
}

#[derive(Debug, Clone, Deserialize)]
struct MothershipFile {
    #[serde(default)]
    host: Option<String>,
    #[serde(default)]
    peers: Vec<Peer>,
}

impl Model {
    pub fn load(root: &Path) -> Self {
        let mothership = root.join(".aura").join("mothership.json");
        let (host, peers, configured) = match fs::read_to_string(&mothership) {
            Ok(s) => match serde_json::from_str::<MothershipFile>(&s) {
                Ok(f) => (f.host, f.peers, true),
                Err(_) => (None, Vec::new(), true),
            },
            Err(_) => (None, Vec::new(), false),
        };

        let messages_path = root.join(".aura").join("messages.jsonl");
        let mut messages = Vec::new();
        if let Ok(contents) = fs::read_to_string(&messages_path) {
            for line in contents.lines() {
                let trimmed = line.trim();
                if trimmed.is_empty() {
                    continue;
                }
                if let Ok(m) = serde_json::from_str::<Message>(trimmed) {
                    messages.push(m);
                }
            }
        }

        Self {
            host,
            peers,
            messages,
            configured,
        }
    }
}

pub fn view<'a, M: 'a + Clone>(
    model: &'a Model,
    _on_action: impl Fn(Action) -> M + 'a,
) -> Element<'a, M> {
    let header = text("Team")
        .size(t::SZ_BODY_LG)
        .color(t::TEXT)
        .font(t::UI_MED);

    if !model.configured {
        let body = empty_state();
        let content = column![header, Space::new().height(Length::Fixed(t::P_SM)), body]
            .padding(Padding::from([t::P_MD, t::P_MD]));
        return container(content)
            .width(Length::Fill)
            .height(Length::Fill)
            .style(style::pane)
            .into();
    }

    let host_label: Element<'a, M> = match model.host.as_deref() {
        Some(h) if !h.is_empty() => container(
            row![
                text("host").size(t::SZ_TINY).color(t::TEXT_DIM).font(t::UI_MED),
                Space::new().width(Length::Fixed(6.0)),
                text(h.to_string()).size(t::SZ_META).color(t::TEXT_MUTED).font(t::MONO),
            ]
            .align_y(Alignment::Center),
        )
        .into(),
        _ => text("host not set")
            .size(t::SZ_TINY)
            .color(t::TEXT_DIM)
            .into(),
    };

    let peers_header = text(format!("peers · {}", model.peers.len()))
        .size(t::SZ_TINY)
        .color(t::TEXT_DIM)
        .font(t::UI_MED);

    let peers_col: Element<'a, M> = if model.peers.is_empty() {
        text("— no peers discovered —")
            .size(t::SZ_META)
            .color(t::TEXT_DIM)
            .into()
    } else {
        let mut col = column![].spacing(2);
        for peer in &model.peers {
            col = col.push(peer_row(peer));
        }
        col.into()
    };

    let msgs_header = text(format!("messages · {}", model.messages.len()))
        .size(t::SZ_TINY)
        .color(t::TEXT_DIM)
        .font(t::UI_MED);

    let msgs_col: Element<'a, M> = if model.messages.is_empty() {
        text("— no recent messages —")
            .size(t::SZ_META)
            .color(t::TEXT_DIM)
            .into()
    } else {
        let mut col = column![].spacing(4);
        // Show the most recent 20 messages.
        for msg in model.messages.iter().rev().take(20) {
            col = col.push(message_row(msg));
        }
        col.into()
    };

    let content = column![
        header,
        Space::new().height(Length::Fixed(4.0)),
        host_label,
        Space::new().height(Length::Fixed(t::P_MD)),
        peers_header,
        Space::new().height(Length::Fixed(4.0)),
        peers_col,
        Space::new().height(Length::Fixed(t::P_MD)),
        msgs_header,
        Space::new().height(Length::Fixed(4.0)),
        msgs_col,
    ]
    .padding(Padding::from([t::P_MD, t::P_MD]));

    let scrolled = scrollable(container(content).width(Length::Fill))
        .height(Length::Fill)
        .width(Length::Fill)
        .style(style::scroller);

    container(scrolled)
        .width(Length::Fill)
        .height(Length::Fill)
        .style(style::pane)
        .into()
}

fn peer_row<'a, M: 'a>(peer: &'a Peer) -> Element<'a, M> {
    let online = peer.online.unwrap_or_else(|| {
        // If `online` isn't stored explicitly, infer from last_seen: anything
        // within 120s counts as online.
        peer.last_seen
            .map(|ts| {
                let now = time::OffsetDateTime::now_utc().unix_timestamp();
                (now - ts).abs() < 120
            })
            .unwrap_or(false)
    });
    let dot_color: Color = if online { t::S_COMPLETED } else { t::TEXT_FAINT };
    let dot = container(
        Space::new()
            .width(Length::Fixed(6.0))
            .height(Length::Fixed(6.0)),
    )
    .style(style::dot(dot_color));

    let name = if peer.name.is_empty() {
        peer.did.clone().unwrap_or_else(|| "unknown".to_string())
    } else {
        peer.name.clone()
    };

    let seen = match peer.last_seen {
        Some(ts) => format_since(ts),
        None => "—".to_string(),
    };

    row![
        dot,
        Space::new().width(Length::Fixed(8.0)),
        text(name).size(t::SZ_META).color(t::TEXT),
        Space::new().width(Length::Fill),
        text(seen)
            .size(t::SZ_TINY)
            .color(t::TEXT_DIM)
            .font(t::MONO),
    ]
    .align_y(Alignment::Center)
    .padding(Padding::from([4, 4]))
    .into()
}

fn message_row<'a, M: 'a>(msg: &'a Message) -> Element<'a, M> {
    let sender = if msg.sender.is_empty() {
        "—".to_string()
    } else {
        msg.sender.clone()
    };
    let body = truncate(&msg.body, 80);
    let when = msg.at.map(format_since).unwrap_or_else(|| "—".to_string());

    column![
        row![
            text(sender)
                .size(t::SZ_TINY)
                .color(t::TEXT_MUTED)
                .font(t::UI_MED),
            Space::new().width(Length::Fixed(8.0)),
            text(when)
                .size(t::SZ_TINY)
                .color(t::TEXT_DIM)
                .font(t::MONO),
        ]
        .align_y(Alignment::Center),
        text(body).size(t::SZ_META).color(t::TEXT),
    ]
    .spacing(2)
    .padding(Padding::from([4, 4]))
    .into()
}

fn empty_state<'a, M: 'a>() -> Element<'a, M> {
    column![
        Space::new().height(Length::Fixed(24.0)),
        container(
            text("offline")
                .size(t::SZ_BODY)
                .color(t::TEXT_MUTED)
                .font(t::UI_MED),
        )
        .width(Length::Fill)
        .align_x(Alignment::Center),
        Space::new().height(Length::Fixed(4.0)),
        container(
            text("no mothership configured")
                .size(t::SZ_META)
                .color(t::TEXT_DIM),
        )
        .width(Length::Fill)
        .align_x(Alignment::Center),
        Space::new().height(Length::Fixed(4.0)),
        container(
            text("run: aura team init")
                .size(t::SZ_TINY)
                .color(t::TEXT_DIM)
                .font(t::MONO),
        )
        .width(Length::Fill)
        .align_x(Alignment::Center),
    ]
    .into()
}

fn format_since(ts_sec: i64) -> String {
    let now = time::OffsetDateTime::now_utc().unix_timestamp();
    let dt = now - ts_sec;
    if dt < 0 {
        return "future".into();
    }
    if dt < 60 {
        format!("{dt}s")
    } else if dt < 3600 {
        format!("{}m", dt / 60)
    } else if dt < 86_400 {
        format!("{}h", dt / 3600)
    } else {
        format!("{}d", dt / 86_400)
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
    fn loads_mothership_and_messages() {
        let dir = TempDir::new().unwrap();
        let aura = dir.path().join(".aura");
        fs::create_dir_all(&aura).unwrap();
        fs::write(
            aura.join("mothership.json"),
            r#"{"host":"localhost:7777","peers":[{"name":"ash","last_seen":1700000000,"online":true}]}"#,
        )
        .unwrap();
        fs::write(
            aura.join("messages.jsonl"),
            r#"{"from":"ash","text":"hi","ts":1700000001}
{"sender":"bot","body":"hello","at":1700000002}
"#,
        )
        .unwrap();
        let m = Model::load(dir.path());
        assert!(m.configured);
        assert_eq!(m.host.as_deref(), Some("localhost:7777"));
        assert_eq!(m.peers.len(), 1);
        assert_eq!(m.peers[0].name, "ash");
        assert_eq!(m.messages.len(), 2);
    }

    #[test]
    fn unconfigured_when_file_missing() {
        let dir = TempDir::new().unwrap();
        let m = Model::load(dir.path());
        assert!(!m.configured);
    }
}
