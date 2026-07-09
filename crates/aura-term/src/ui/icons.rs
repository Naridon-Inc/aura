use iced::widget::svg::{self, Svg};
use iced::widget::{container, Space};
use iced::{Border, Color, Element, Length};

use crate::theme;

const SIDEBAR: &[u8] = br##"<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="#ffffff" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round"><rect width="18" height="18" x="3" y="3" rx="2"/><path d="M9 3v18"/></svg>"##;

const NEW_SESSION: &[u8] = br##"<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="#ffffff" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round"><path d="M12 3H5a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/><path d="M18.375 2.625a1 1 0 0 1 3 3l-9.013 9.014a2 2 0 0 1-.853.505l-2.873.84a.5.5 0 0 1-.62-.62l.84-2.873a2 2 0 0 1 .506-.852z"/></svg>"##;

const CHEVRON_LEFT: &[u8] = br##"<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="#ffffff" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="m15 18-6-6 6-6"/></svg>"##;

pub const CHEVRON_RIGHT: &[u8] = br##"<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="#ffffff" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="m9 18 6-6-6-6"/></svg>"##;

pub const CHEVRON_DOWN: &[u8] = br##"<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="#ffffff" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="m6 9 6 6 6-6"/></svg>"##;

pub const PLUS: &[u8] = br##"<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="#ffffff" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round"><path d="M5 12h14"/><path d="M12 5v14"/></svg>"##;

pub const MINUS: &[u8] = br##"<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="#ffffff" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round"><path d="M5 12h14"/></svg>"##;

pub const REFRESH: &[u8] = br##"<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="#ffffff" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round"><path d="M3 12a9 9 0 0 1 9-9 9.75 9.75 0 0 1 6.74 2.74L21 8"/><path d="M21 3v5h-5"/><path d="M21 12a9 9 0 0 1-9 9 9.75 9.75 0 0 1-6.74-2.74L3 16"/><path d="M8 16H3v5"/></svg>"##;

pub const DISCARD: &[u8] = br##"<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="#ffffff" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round"><path d="M3 6h18"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6"/><path d="M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/></svg>"##;

const SETTINGS: &[u8] = br##"<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="#ffffff" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round"><path d="M12.22 2h-.44a2 2 0 0 0-2 2v.18a2 2 0 0 1-1 1.73l-.43.25a2 2 0 0 1-2 0l-.15-.08a2 2 0 0 0-2.73.73l-.22.38a2 2 0 0 0 .73 2.73l.15.1a2 2 0 0 1 1 1.72v.51a2 2 0 0 1-1 1.74l-.15.09a2 2 0 0 0-.73 2.73l.22.38a2 2 0 0 0 2.73.73l.15-.08a2 2 0 0 1 2 0l.43.25a2 2 0 0 1 1 1.73V20a2 2 0 0 0 2 2h.44a2 2 0 0 0 2-2v-.18a2 2 0 0 1 1-1.73l.43-.25a2 2 0 0 1 2 0l.15.08a2 2 0 0 0 2.73-.73l.22-.39a2 2 0 0 0-.73-2.73l-.15-.08a2 2 0 0 1-1-1.74v-.5a2 2 0 0 1 1-1.74l.15-.09a2 2 0 0 0 .73-2.73l-.22-.38a2 2 0 0 0-2.73-.73l-.15.08a2 2 0 0 1-2 0l-.43-.25a2 2 0 0 1-1-1.73V4a2 2 0 0 0-2-2z"/><circle cx="12" cy="12" r="3"/></svg>"##;

const HELP: &[u8] = br##"<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="#ffffff" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><path d="M9.09 9a3 3 0 0 1 5.83 1c0 2-3 3-3 3"/><path d="M12 17h.01"/></svg>"##;

pub const TERMINAL: &[u8] = br##"<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="#ffffff" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round"><path d="m7 11 2-2-2-2"/><path d="M11 13h4"/><rect width="18" height="18" x="3" y="3" rx="2"/></svg>"##;

const GIT_COMPARE: &[u8] = br##"<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="#ffffff" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round"><circle cx="5" cy="6" r="3"/><path d="M12 6h5a2 2 0 0 1 2 2v7"/><path d="m15 9-3-3 3-3"/><circle cx="19" cy="18" r="3"/><path d="M12 18H7a2 2 0 0 1-2-2V9"/><path d="m9 15 3 3-3 3"/></svg>"##;

pub const FOLDER: &[u8] = br##"<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="#ffffff" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round"><path d="M20 20a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-7.9a2 2 0 0 1-1.69-.9L9.6 3.9A2 2 0 0 0 7.93 3H4a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2Z"/></svg>"##;

const PANEL_RIGHT: &[u8] = br##"<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="#ffffff" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round"><rect width="18" height="18" x="3" y="3" rx="2"/><path d="M15 3v18"/></svg>"##;

const PANEL_BOTTOM: &[u8] = br##"<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="#ffffff" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round"><rect width="18" height="18" x="3" y="3" rx="2"/><path d="M3 15h18"/></svg>"##;

const SERVER: &[u8] = br##"<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="#ffffff" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round"><rect width="20" height="8" x="2" y="2" rx="2" ry="2"/><rect width="20" height="8" x="2" y="14" rx="2" ry="2"/><line x1="6" x2="6.01" y1="6" y2="6"/><line x1="6" x2="6.01" y1="18" y2="18"/></svg>"##;

const MORE_HORIZONTAL: &[u8] = br##"<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="#ffffff" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="1"/><circle cx="19" cy="12" r="1"/><circle cx="5" cy="12" r="1"/></svg>"##;

const CLOSE_X: &[u8] = br##"<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="#ffffff" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round"><path d="M18 6 6 18"/><path d="m6 6 12 12"/></svg>"##;

pub const GIT_BRANCH: &[u8] = br##"<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="#ffffff" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round"><line x1="6" x2="6" y1="3" y2="15"/><circle cx="18" cy="6" r="3"/><circle cx="6" cy="18" r="3"/><path d="M18 9a9 9 0 0 1-9 9"/></svg>"##;

const ARROW_UP: &[u8] = br##"<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="#ffffff" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="m5 12 7-7 7 7"/><path d="M12 19V5"/></svg>"##;

pub const SEARCH: &[u8] = br##"<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="#ffffff" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round"><circle cx="11" cy="11" r="8"/><path d="m21 21-4.3-4.3"/></svg>"##;

pub const FILE: &[u8] = br##"<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="#ffffff" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round"><path d="M15 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7Z"/><path d="M14 2v4a2 2 0 0 0 2 2h4"/></svg>"##;

pub const USERS: &[u8] = br##"<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="#ffffff" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round"><path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M22 21v-2a4 4 0 0 0-3-3.87"/><path d="M16 3.13a4 4 0 0 1 0 7.75"/></svg>"##;

pub const WORKFLOW: &[u8] = br##"<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="#ffffff" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round"><rect width="8" height="8" x="3" y="3" rx="2"/><path d="M7 11v4a2 2 0 0 0 2 2h4"/><rect width="8" height="8" x="13" y="13" rx="2"/></svg>"##;

// Pane-rail glyphs (Plan / Impacts / Proof / Memory / Timeline / Doctor).
// Lucide 0.473 tracings at 24px / 1.75 stroke. Rendered through `tinted()`
// the same way the other icons are, so they respect theme::TEXT_1 / TEXT_3.
pub const PLAN: &[u8] = br##"<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="#ffffff" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round"><rect width="8" height="4" x="8" y="2" rx="1"/><path d="M16 4h2a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2h2"/><path d="M12 11h4"/><path d="M12 16h4"/><path d="M8 11h.01"/><path d="M8 16h.01"/></svg>"##;

pub const IMPACTS: &[u8] = br##"<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="#ffffff" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round"><path d="m21.73 18-8-14a2 2 0 0 0-3.48 0l-8 14A2 2 0 0 0 4 21h16a2 2 0 0 0 1.73-3Z"/><path d="M12 9v4"/><path d="M12 17h.01"/></svg>"##;

pub const PROOF: &[u8] = br##"<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="#ffffff" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round"><path d="M20 13c0 5-3.5 7.5-7.66 8.95a1 1 0 0 1-.67-.01C7.5 20.5 4 18 4 13V6a1 1 0 0 1 1-1c2 0 4.5-1.2 6.24-2.72a1.17 1.17 0 0 1 1.52 0C14.51 3.81 17 5 19 5a1 1 0 0 1 1 1z"/><path d="m9 12 2 2 4-4"/></svg>"##;

pub const MEMORY: &[u8] = br##"<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="#ffffff" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round"><ellipse cx="12" cy="5" rx="9" ry="3"/><path d="M3 5v14a9 3 0 0 0 18 0V5"/><path d="M3 12a9 3 0 0 0 18 0"/></svg>"##;

pub const TIMELINE: &[u8] = br##"<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="#ffffff" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/></svg>"##;

pub const DOCTOR: &[u8] = br##"<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="#ffffff" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round"><path d="M19 14c1.49-1.46 3-3.21 3-5.5A5.5 5.5 0 0 0 16.5 3c-1.76 0-3 .5-4.5 2-1.5-1.5-2.74-2-4.5-2A5.5 5.5 0 0 0 2 8.5c0 2.3 1.5 4.05 3 5.5l7 7Z"/><path d="M3.22 12H9.5l.5-1 2 4.5 2-7 1.5 3.5h5.27"/></svg>"##;

const USER_AVATAR: &[u8] = br##"<svg xmlns="http://www.w3.org/2000/svg" width="64" height="64" viewBox="0 0 64 64"><defs><linearGradient id="g" x1="0%" y1="0%" x2="100%" y2="100%"><stop offset="0%" stop-color="#e89ad9"/><stop offset="100%" stop-color="#4f1b41"/></linearGradient></defs><circle cx="32" cy="32" r="32" fill="url(#g)"/></svg>"##;

pub fn tinted(bytes: &'static [u8], size: f32, color: Color) -> Svg<'static> {
    Svg::new(svg::Handle::from_memory(bytes))
        .width(Length::Fixed(size))
        .height(Length::Fixed(size))
        .style(move |_, _| svg::Style { color: Some(color) })
}

// Inner-L hairline arc — a 12×12 quarter-arc whose endpoints sit at (0,12) and
// (12,0), curving into the top-left quadrant. Used at the shell L's inside
// corner to bridge the vertical project-rail→nav-rail seam with the horizontal
// titlebar→workarea seam, since iced's container border doesn't actually
// stroke the radius arc (it only uses radius to clip the background fill).
const INNER_L_ARC: &[u8] = br##"<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 12 12" width="12" height="12" fill="none" stroke="#ffffff" stroke-width="1"><path d="M 0 12 A 12 12 0 0 1 12 0"/></svg>"##;

pub fn inner_l_arc(size: f32) -> Svg<'static> {
    tinted(INNER_L_ARC, size, theme::LINE)
}

pub fn sidebar() -> Svg<'static> {
    tinted(SIDEBAR, 16.0, theme::TEXT_2)
}

pub fn new_session() -> Svg<'static> {
    tinted(NEW_SESSION, 16.0, theme::TEXT_2)
}

pub fn chevron_left() -> Svg<'static> {
    tinted(CHEVRON_LEFT, 14.0, theme::TEXT_3)
}

pub fn chevron_right() -> Svg<'static> {
    tinted(CHEVRON_RIGHT, 14.0, theme::TEXT_3)
}

pub fn chevron_down() -> Svg<'static> {
    tinted(CHEVRON_DOWN, 12.0, theme::TEXT_3)
}

pub fn plus() -> Svg<'static> {
    tinted(PLUS, 18.0, theme::TEXT_2)
}

pub fn plus_sized(size: f32) -> Svg<'static> {
    tinted(PLUS, size, theme::TEXT_2)
}

pub fn settings() -> Svg<'static> {
    tinted(SETTINGS, 16.0, theme::TEXT_3)
}

pub fn help() -> Svg<'static> {
    tinted(HELP, 16.0, theme::TEXT_3)
}

pub fn terminal() -> Svg<'static> {
    tinted(TERMINAL, 16.0, theme::TEXT_2)
}

pub fn git_compare() -> Svg<'static> {
    tinted(GIT_COMPARE, 16.0, theme::TEXT_2)
}

pub fn folder(size: f32) -> Svg<'static> {
    tinted(FOLDER, size, theme::TEXT_2)
}

pub fn folder_tinted(size: f32, color: Color) -> Svg<'static> {
    tinted(FOLDER, size, color)
}

pub fn file_tinted(size: f32, color: Color) -> Svg<'static> {
    tinted(FILE, size, color)
}

pub fn chevron_right_sized(size: f32, color: Color) -> Svg<'static> {
    tinted(CHEVRON_RIGHT, size, color)
}

pub fn chevron_down_sized(size: f32, color: Color) -> Svg<'static> {
    tinted(CHEVRON_DOWN, size, color)
}

pub fn panel_right() -> Svg<'static> {
    tinted(PANEL_RIGHT, 16.0, theme::TEXT_2)
}

pub fn panel_bottom() -> Svg<'static> {
    tinted(PANEL_BOTTOM, 16.0, theme::TEXT_2)
}

pub fn server() -> Svg<'static> {
    tinted(SERVER, 16.0, theme::TEXT_2)
}

pub fn more_horizontal() -> Svg<'static> {
    tinted(MORE_HORIZONTAL, 16.0, theme::TEXT_3)
}

pub fn close_x(size: f32) -> Svg<'static> {
    tinted(CLOSE_X, size, theme::TEXT_3)
}

pub fn git_branch(size: f32) -> Svg<'static> {
    tinted(GIT_BRANCH, size, theme::TEXT_3)
}

pub fn arrow_up(size: f32, color: Color) -> Svg<'static> {
    tinted(ARROW_UP, size, color)
}

pub fn search() -> Svg<'static> {
    tinted(SEARCH, 14.0, theme::TEXT_3)
}

pub fn file(size: f32) -> Svg<'static> {
    tinted(FILE, size, theme::TEXT_2)
}

pub fn users(size: f32) -> Svg<'static> {
    tinted(USERS, size, theme::TEXT_2)
}

pub fn workflow(size: f32) -> Svg<'static> {
    tinted(WORKFLOW, size, theme::TEXT_2)
}

pub fn user_avatar(size: f32) -> Svg<'static> {
    Svg::new(svg::Handle::from_memory(USER_AVATAR))
        .width(Length::Fixed(size))
        .height(Length::Fixed(size))
}

pub fn dot<M: 'static>(color: Color, size: f32) -> Element<'static, M> {
    container(Space::new().width(Length::Fixed(0.0)).height(Length::Fixed(0.0)))
        .width(Length::Fixed(size))
        .height(Length::Fixed(size))
        .style(move |_| {
            iced::widget::container::Style::default()
                .background(color)
                .border(Border {
                    color: Color::TRANSPARENT,
                    width: 0.0,
                    radius: (size / 2.0).into(),
                })
        })
        .into()
}

pub fn agent_square<M: 'static>(color: Color, size: f32) -> Element<'static, M> {
    container(Space::new().width(Length::Fixed(0.0)).height(Length::Fixed(0.0)))
        .width(Length::Fixed(size))
        .height(Length::Fixed(size))
        .style(move |_| {
            iced::widget::container::Style::default()
                .background(color)
                .border(Border {
                    color: Color::TRANSPARENT,
                    width: 0.0,
                    radius: 3.0.into(),
                })
        })
        .into()
}
