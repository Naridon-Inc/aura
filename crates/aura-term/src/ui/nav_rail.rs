//! Secondary navigation rail — a vertical icon strip that sits between the
//! project rail and the sidebar body. Top of the rail swaps what the sidebar
//! lists (files / git / search / …) without reshuffling the rest of the
//! chrome. Bottom of the rail hosts the *session tiles*: one glyph per
//! worktree, with a hover popover that shows live status (branch, HEAD,
//! dirty state). Clicking a session tile switches to that worktree.

use iced::widget::{button, column, container, row, text, tooltip, Space};
use iced::{Border, Color, Element, Length, Padding, Shadow};

use crate::{
    app::Pane,
    config::{self, WorktreeInfo},
    theme,
    ui::{icons, panes::plan::PlanStatus},
    App, Message, SidebarTab,
};

/// Ambient signal shown on a rail tile. Dots signal presence / health;
/// counts surface unresolved items that want the user's attention.
#[derive(Clone, Copy)]
enum Badge {
    None,
    Dot(Color),
    Count(usize),
}

const GLYPH_SIZE: f32 = 28.0;
const STATUS_DOT: f32 = 8.0;

pub fn view<'a>(state: &'a App) -> Element<'a, Message> {
    let active_tab = state.sidebar_tab;
    let active_pane = state.active_pane;

    // Ambient badges derive from the same pane models the bodies
    // render — no new subscriptions, no new IPC. A refresh on the
    // pane model (reload_volatile) already propagates here.
    let plan_active = state
        .panes
        .plan
        .plans
        .iter()
        .any(|p| p.status == PlanStatus::Active);
    let impacts_count = state.panes.impacts.alerts.len();
    let git_dirty = config::git_is_dirty(&state.cwd);
    let proof_run_count = state.panes.proof.history.len();
    let orch_running = state
        .panes
        .orchestration_tiles
        .iter()
        .any(|t| matches!(t.status, crate::ui::orchestration::TileStatus::Running));
    let peers_online = state
        .panes
        .team
        .peers
        .iter()
        .filter(|p| p.online == Some(true))
        .count();
    let conflict_count = state.panes.conflict.items.len();

    let plan_badge = if plan_active {
        Badge::Dot(theme::ACCENT_GREEN)
    } else {
        Badge::None
    };
    let impacts_badge = if impacts_count > 0 {
        Badge::Count(impacts_count)
    } else {
        Badge::None
    };
    let git_badge = if git_dirty {
        Badge::Dot(theme::AMBER)
    } else {
        Badge::None
    };
    let proof_badge = if proof_run_count > 0 {
        Badge::Dot(theme::ACCENT_GREEN)
    } else {
        Badge::None
    };
    let orch_badge = if orch_running {
        Badge::Dot(theme::ACCENT_GREEN)
    } else {
        Badge::None
    };
    let team_badge = if peers_online > 0 {
        Badge::Dot(theme::ACCENT_GREEN)
    } else {
        Badge::None
    };
    let conflict_badge = if conflict_count > 0 {
        Badge::Count(conflict_count)
    } else {
        Badge::None
    };

    // Top stack: pane tiles (Work / Plan / Impacts / Proof / Memory /
    // Timeline / Doctor) — drives `active_pane`, which selects what
    // the empty-state body renders when no file is open. These used
    // to be hidden behind a horizontal segmented picker above the
    // body; moving them to the rail restores term's pre-merge shape
    // and frees the empty-state body from its own chrome strip.
    //
    // Orchestration / Handover stay off the rail because they have
    // first-class keybinds (⌘K palette + ⌘⇧H) and overlay semantics.
    // Team is left in the sidebar-tab cluster since it shares the
    // sidebar body pattern with Files/Git/Search.
    let mut col = column![Space::new().width(0.0).height(Length::Fixed(theme::P_LG))]
        .spacing(2.0)
        .width(Length::Fill)
        .align_x(iced::Alignment::Center);

    for (pane, icon_bytes, badge) in [
        (Pane::Work, icons::TERMINAL, Badge::None),
        (Pane::Plan, icons::PLAN, plan_badge),
        (Pane::Impacts, icons::IMPACTS, impacts_badge),
        (Pane::Proof, icons::PROOF, proof_badge),
        (Pane::Memory, icons::MEMORY, Badge::None),
        (Pane::Timeline, icons::TIMELINE, Badge::None),
        (Pane::Doctor, icons::DOCTOR, Badge::None),
    ] {
        col = col.push(pane_tile(pane, icon_bytes, active_pane, badge));
    }

    // Collab cluster: per the IA doc, Orchestration + Conflict surface
    // multi-agent state that wants a first-class rail tile. Kept visually
    // distinct from the Work cluster by a group divider above and below.
    col = col.push(group_divider());
    for (pane, icon_bytes, badge) in [
        (Pane::Orchestration, icons::WORKFLOW, orch_badge),
        (Pane::Conflict, icons::IMPACTS, conflict_badge),
    ] {
        col = col.push(pane_tile(pane, icon_bytes, active_pane, badge));
    }

    // Thin divider between pane tiles and sidebar-tab tiles so the
    // two clusters read as distinct groups rather than one long list.
    col = col.push(group_divider());

    for (tab, icon_bytes, badge) in [
        (SidebarTab::Files,    icons::FOLDER,     Badge::None),
        (SidebarTab::Git,      icons::GIT_BRANCH, git_badge),
        (SidebarTab::Search,   icons::SEARCH,     Badge::None),
        (SidebarTab::Semantic, icons::WORKFLOW,   Badge::None),
        (SidebarTab::Team,     icons::USERS,      team_badge),
    ] {
        col = col.push(tile(tab, icon_bytes, active_tab, badge));
    }

    // Spacer pushes everything below it to the bottom of the rail.
    col = col.push(Space::new().width(Length::Shrink).height(Length::Fill));

    // Bottom stack: session tiles for every worktree, then a small bottom
    // inset to match the top.
    col = col.push(session_divider());
    for w in state.worktrees.iter() {
        col = col.push(session_tile(w));
    }
    col = col.push(Space::new().width(0.0).height(Length::Fixed(theme::P_SM)));

    container(col)
        .width(Length::Fixed(theme::NAV_RAIL_W))
        .height(Length::Fill)
        .style(|_| iced::widget::container::Style::default().background(theme::BG_DEEP))
        .into()
}

fn tile<'a>(
    tab: SidebarTab,
    icon_bytes: &'static [u8],
    active: SidebarTab,
    badge: Badge,
) -> Element<'a, Message> {
    let is_active = tab == active;
    let icon_color = if is_active { theme::TEXT_1 } else { theme::TEXT_3 };
    let icon = icons::tinted(icon_bytes, 18.0, icon_color);

    let btn = button(
        container(icon)
            .width(Length::Fixed(theme::NAV_TILE))
            .height(Length::Fixed(theme::NAV_TILE))
            .center_x(Length::Fixed(theme::NAV_TILE))
            .center_y(Length::Fixed(theme::NAV_TILE)),
    )
    .on_press(Message::SelectSidebarTab(tab))
    .padding(0)
    .width(Length::Fixed(theme::NAV_TILE))
    .height(Length::Fixed(theme::NAV_TILE))
    .style(move |_, status| {
        let hover = matches!(
            status,
            iced::widget::button::Status::Hovered | iced::widget::button::Status::Pressed,
        );
        let bg = if is_active {
            theme::BG_HOVER
        } else if hover {
            tint(theme::BG_HOVER, 0.6)
        } else {
            Color::TRANSPARENT
        };
        iced::widget::button::Style {
            background: Some(bg.into()),
            text_color: theme::TEXT_1,
            border: Border {
                color: if is_active { theme::LINE } else { Color::TRANSPARENT },
                width: if is_active { 1.0 } else { 0.0 },
                radius: theme::R_LG.into(),
            },
            shadow: Shadow::default(),
            snap: false,
        }
    });

    badge_wrap(btn.into(), badge)
}

/// Same button shape as `tile`, but wired to `Message::SelectPane`.
/// Compares against `active_pane` so the current pane highlights
/// identically to the current sidebar tab.
fn pane_tile<'a>(
    pane: Pane,
    icon_bytes: &'static [u8],
    active: Pane,
    badge: Badge,
) -> Element<'a, Message> {
    let is_active = pane == active;
    let icon_color = if is_active { theme::TEXT_1 } else { theme::TEXT_3 };
    let icon = icons::tinted(icon_bytes, 18.0, icon_color);

    let btn = button(
        container(icon)
            .width(Length::Fixed(theme::NAV_TILE))
            .height(Length::Fixed(theme::NAV_TILE))
            .center_x(Length::Fixed(theme::NAV_TILE))
            .center_y(Length::Fixed(theme::NAV_TILE)),
    )
    .on_press(Message::SelectPane(pane))
    .padding(0)
    .width(Length::Fixed(theme::NAV_TILE))
    .height(Length::Fixed(theme::NAV_TILE))
    .style(move |_, status| {
        let hover = matches!(
            status,
            iced::widget::button::Status::Hovered | iced::widget::button::Status::Pressed,
        );
        let bg = if is_active {
            theme::BG_HOVER
        } else if hover {
            tint(theme::BG_HOVER, 0.6)
        } else {
            Color::TRANSPARENT
        };
        iced::widget::button::Style {
            background: Some(bg.into()),
            text_color: theme::TEXT_1,
            border: Border {
                color: if is_active { theme::LINE } else { Color::TRANSPARENT },
                width: if is_active { 1.0 } else { 0.0 },
                radius: theme::R_LG.into(),
            },
            shadow: Shadow::default(),
            snap: false,
        }
    });

    badge_wrap(btn.into(), badge)
}

/// Wrap a tile button in a NAV_RAIL_W × NAV_TILE container, overlaying
/// a small badge (dot or numeric pill) at the upper-right when set.
/// Without a badge this is the same centered wrapper the tile code
/// used to produce inline, so layout is untouched for the common case.
fn badge_wrap<'a>(btn: Element<'a, Message>, badge: Badge) -> Element<'a, Message> {
    let wrapped = container(btn)
        .width(Length::Fixed(theme::NAV_RAIL_W))
        .height(Length::Fixed(theme::NAV_TILE))
        .center_x(Length::Fixed(theme::NAV_RAIL_W))
        .center_y(Length::Fixed(theme::NAV_TILE));

    let badge_el: Option<Element<'a, Message>> = match badge {
        Badge::None => None,
        Badge::Dot(color) => {
            const DOT: f32 = 7.0;
            const RING: f32 = DOT + 3.0;
            Some(
                container(icons::dot::<Message>(color, DOT))
                    .width(Length::Fixed(RING))
                    .height(Length::Fixed(RING))
                    .center_x(Length::Fixed(RING))
                    .center_y(Length::Fixed(RING))
                    .style(|_| {
                        iced::widget::container::Style::default()
                            .background(theme::BG_DEEP)
                            .border(Border {
                                color: Color::TRANSPARENT,
                                width: 0.0,
                                radius: (RING / 2.0).into(),
                            })
                    })
                    .into(),
            )
        }
        Badge::Count(n) => {
            // Cap rendered digits at 99+; pill height tracks NAV tile so
            // it never wraps the icon vertically.
            let label = if n > 99 { "99+".to_string() } else { n.to_string() };
            Some(
                container(
                    text(label)
                        .size(10.0)
                        .font(theme::FONT_SANS_MEDIUM)
                        .style(|_: &iced::Theme| iced::widget::text::Style {
                            color: Some(theme::TEXT_1),
                        }),
                )
                .padding(Padding::from([1.0, 5.0]))
                .style(|_| {
                    iced::widget::container::Style::default()
                        .background(theme::RED)
                        .border(Border {
                            color: theme::BG_DEEP,
                            width: 1.0,
                            radius: 8.0.into(),
                        })
                })
                .into(),
            )
        }
    };

    let Some(badge_el) = badge_el else {
        return wrapped.into();
    };

    // Upper-right anchor: row pushes the badge to the right, column
    // holds it at the top. Inset 6px from each edge so the pill/dot
    // hugs the tile's rounded corner without clipping.
    let overlay_row = row![
        Space::new().width(Length::Fill).height(0.0),
        badge_el,
        Space::new().width(Length::Fixed(6.0)).height(0.0),
    ]
    .align_y(iced::Alignment::Center);
    let overlay_col = column![
        Space::new().width(0.0).height(Length::Fixed(4.0)),
        overlay_row,
        Space::new().width(0.0).height(Length::Fill),
    ];
    let overlay = container(overlay_col)
        .width(Length::Fixed(theme::NAV_RAIL_W))
        .height(Length::Fixed(theme::NAV_TILE));

    iced::widget::stack![wrapped, overlay]
        .width(Length::Fixed(theme::NAV_RAIL_W))
        .height(Length::Fixed(theme::NAV_TILE))
        .into()
}

/// Thin 1px LINE_SOFT stub between the pane tiles (top) and sidebar-tab
/// tiles (middle). Same geometry as `session_divider` so the two
/// separators read consistently.
fn group_divider<'a>() -> Element<'a, Message> {
    container(
        container(Space::new().width(Length::Fixed(20.0)).height(Length::Fixed(1.0)))
            .width(Length::Fixed(20.0))
            .height(Length::Fixed(1.0))
            .style(|_| iced::widget::container::Style::default().background(theme::LINE_SOFT)),
    )
    .width(Length::Fill)
    .height(Length::Fixed(9.0))
    .center_x(Length::Fill)
    .center_y(Length::Fixed(9.0))
    .padding(Padding {
        top: 4.0,
        right: 0.0,
        bottom: 4.0,
        left: 0.0,
    })
    .into()
}

/// Thin label-less hairline divider between the sidebar-tab tiles (top) and
/// the session tiles (bottom). A 20px centered LINE_SOFT stub — minimal
/// visual weight, but tells the eye the two groups are distinct.
fn session_divider<'a>() -> Element<'a, Message> {
    container(Space::new().width(Length::Fixed(20.0)).height(Length::Fixed(1.0)))
        .width(Length::Fill)
        .height(Length::Fixed(9.0))
        .center_x(Length::Fill)
        .center_y(Length::Fixed(9.0))
        .padding(Padding {
            top: 4.0,
            right: 0.0,
            bottom: 4.0,
            left: 0.0,
        })
        .style(|_| {
            iced::widget::container::Style {
                background: Some(Color::TRANSPARENT.into()),
                ..Default::default()
            }
        })
        .into()
}

fn session_tile<'a>(w: &'a WorktreeInfo) -> Element<'a, Message> {
    let is_current = w.is_current;
    let dirty = config::git_is_dirty(&w.path);

    let letter = w
        .branch
        .as_deref()
        .and_then(|b| b.chars().find(|c| c.is_alphanumeric()))
        .unwrap_or('?')
        .to_ascii_uppercase();

    let tile_bg = if is_current { theme::BG_CARD } else { theme::BG_2 };
    let label_color = if is_current { theme::TEXT_1 } else { theme::TEXT_2 };

    // The glyph tile: rounded square with a letter and a status-dot badge.
    let letter_el = container(
        text(letter.to_string())
            .size(14.0)
            .font(theme::FONT_SANS_MEDIUM)
            .style(move |_: &iced::Theme| iced::widget::text::Style {
                color: Some(label_color),
            }),
    )
    .width(Length::Fixed(GLYPH_SIZE))
    .height(Length::Fixed(GLYPH_SIZE))
    .center_x(Length::Fixed(GLYPH_SIZE))
    .center_y(Length::Fixed(GLYPH_SIZE))
    .style(move |_| {
        iced::widget::container::Style::default()
            .background(tile_bg)
            .border(Border {
                color: theme::LINE_SOFT,
                width: 1.0,
                radius: theme::R_SM.into(),
            })
    });

    let dot_color = if dirty { theme::AMBER } else { theme::ACCENT_GREEN };
    const DOT_RING: f32 = STATUS_DOT + 4.0;
    let dot = container(icons::dot::<Message>(dot_color, STATUS_DOT))
        .width(Length::Fixed(DOT_RING))
        .height(Length::Fixed(DOT_RING))
        .center_x(Length::Fixed(DOT_RING))
        .center_y(Length::Fixed(DOT_RING))
        .style(|_| {
            iced::widget::container::Style::default()
                .background(theme::BG_DEEP)
                .border(Border {
                    color: Color::TRANSPARENT,
                    width: 0.0,
                    radius: (DOT_RING / 2.0).into(),
                })
        });

    // Pin the dot badge to the tile's bottom-right corner by layering a
    // bottom-aligned row inside a matching-size container on top.
    let overlay_row = row![Space::new().width(Length::Fill).height(0.0), dot]
        .align_y(iced::Alignment::Center);
    let overlay_col = column![
        Space::new().width(0.0).height(Length::Fill),
        overlay_row,
    ];
    let badge = container(overlay_col)
        .width(Length::Fixed(GLYPH_SIZE))
        .height(Length::Fixed(GLYPH_SIZE));

    let stacked = iced::widget::stack![letter_el, badge]
        .width(Length::Fixed(GLYPH_SIZE))
        .height(Length::Fixed(GLYPH_SIZE));

    // Click = switch worktree. Whole tile is the hit target.
    let btn = button(
        container(stacked)
            .width(Length::Fixed(theme::NAV_TILE))
            .height(Length::Fixed(theme::NAV_TILE))
            .center_x(Length::Fixed(theme::NAV_TILE))
            .center_y(Length::Fixed(theme::NAV_TILE)),
    )
    .on_press(Message::SwitchWorktree(w.path.clone()))
    .padding(0)
    .style(move |_, status| iced::widget::button::Style {
        background: match status {
            iced::widget::button::Status::Hovered
            | iced::widget::button::Status::Pressed => Some(theme::BG_HOVER.into()),
            _ => None,
        },
        text_color: theme::TEXT_1,
        border: Border {
            color: Color::TRANSPARENT,
            width: 0.0,
            radius: theme::R_LG.into(),
        },
        shadow: Shadow::default(),
        snap: false,
    });

    // Wrap in a tooltip — hovering the tile floats the rich status card to
    // the right (at the rail boundary), matching the sketch.
    let card = session_popover_card(w, dirty);
    let wrapped = container(btn)
        .width(Length::Fixed(theme::NAV_RAIL_W))
        .height(Length::Fixed(theme::NAV_TILE))
        .center_x(Length::Fixed(theme::NAV_RAIL_W))
        .center_y(Length::Fixed(theme::NAV_TILE));

    tooltip(wrapped, card, tooltip::Position::Right)
        .gap(8.0)
        .padding(0.0)
        .snap_within_viewport(true)
        .style(|_| iced::widget::container::Style {
            background: None,
            border: Border {
                color: Color::TRANSPARENT,
                width: 0.0,
                radius: 0.0.into(),
            },
            ..Default::default()
        })
        .into()
}

fn session_popover_card<'a>(w: &'a WorktreeInfo, dirty: bool) -> Element<'a, Message> {
    let branch_label = w.branch.clone().unwrap_or_else(|| "detached".to_string());
    let path_label = config::cwd_label(&w.path);
    let head_label = w.head.clone().unwrap_or_default();

    let pill_color = if dirty { theme::AMBER } else { theme::ACCENT_GREEN };
    let pill_bg = Color { a: 0.14, ..pill_color };
    let pill_text = if dirty { "Dirty" } else { "Clean" };

    let pill = container(
        row![
            icons::dot::<Message>(pill_color, 6.0),
            Space::new().width(Length::Fixed(6.0)).height(0.0),
            text(pill_text)
                .size(theme::SZ_MICRO)
                .style(move |_: &iced::Theme| iced::widget::text::Style {
                    color: Some(pill_color),
                }),
        ]
        .align_y(iced::Alignment::Center),
    )
    .padding(Padding::from([3.0, 8.0]))
    .style(move |_| {
        iced::widget::container::Style::default()
            .background(pill_bg)
            .border(Border {
                color: Color::TRANSPARENT,
                width: 0.0,
                radius: 10.0.into(),
            })
    });

    let path_line = text(path_label)
        .size(theme::SZ_META)
        .style(|_: &iced::Theme| iced::widget::text::Style {
            color: Some(theme::TEXT_2),
        });

    let branch_line = row![
        icons::git_branch(11.0),
        Space::new().width(Length::Fixed(6.0)).height(0.0),
        text(branch_label)
            .size(theme::SZ_MICRO)
            .style(|_: &iced::Theme| iced::widget::text::Style {
                color: Some(theme::TEXT_3),
            }),
    ]
    .align_y(iced::Alignment::Center);

    let head_line = text(format!("HEAD {}", head_label))
        .size(theme::SZ_MICRO)
        .font(iced::Font::MONOSPACE)
        .style(|_: &iced::Theme| iced::widget::text::Style {
            color: Some(theme::TEXT_4),
        });

    let body = column![
        pill,
        Space::new().width(0.0).height(Length::Fixed(10.0)),
        path_line,
        Space::new().width(0.0).height(Length::Fixed(4.0)),
        branch_line,
        Space::new().width(0.0).height(Length::Fixed(2.0)),
        head_line,
    ]
    .spacing(0.0);

    container(body)
        .width(Length::Fixed(280.0))
        .padding(Padding {
            top: theme::P_MD,
            right: theme::P_MD,
            bottom: theme::P_MD,
            left: theme::P_MD,
        })
        .style(|_| {
            iced::widget::container::Style::default()
                .background(theme::POPOVER_BG)
                .border(Border {
                    color: theme::POPOVER_BORDER,
                    width: 1.0,
                    radius: 10.0.into(),
                })
        })
        .into()
}

fn tint(c: Color, factor: f32) -> Color {
    Color { a: c.a * factor, ..c }
}
