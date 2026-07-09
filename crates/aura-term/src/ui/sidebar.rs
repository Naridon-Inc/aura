use iced::widget::{column, container, row, text, Space};
use iced::{Border, Element, Length};

use crate::{
    theme,
    ui::{
        components, icons, project_header, sidebar_tab_files, sidebar_tab_git,
        sidebar_tab_search, sidebar_tab_semantic, sidebar_tab_sessions, sidebar_tab_team,
    },
    App, Message, SidebarTab,
};

pub fn view<'a>(state: &'a App) -> Element<'a, Message> {
    if let Some(ws) = state.current_workspace.as_ref() {
        let body: Element<'a, Message> = match state.sidebar_tab {
            SidebarTab::Files => sidebar_tab_files::view(state),
            SidebarTab::Git => sidebar_tab_git::view(state),
            SidebarTab::Sessions => sidebar_tab_sessions::view(state),
            SidebarTab::Search => sidebar_tab_search::view(state),
            SidebarTab::Semantic => sidebar_tab_semantic::view(state),
            SidebarTab::Team => sidebar_tab_team::view(state),
        };

        let header_wrap = container(project_header::view(ws))
            .padding(iced::Padding {
                top: theme::P_SM,
                right: theme::P_MD,
                bottom: theme::P_XS,
                left: theme::P_MD,
            });

        let inner = column![
            header_wrap,
            components::divider_h(),
            container(body).width(Length::Fill).height(Length::Fill),
        ]
        .width(Length::Fill)
        .height(Length::Fill);

        return container(inner).width(Length::Fill).height(Length::Fill).into();
    }

    let title = text("No projects open")
        .size(theme::SZ_TITLE)
        .style(|_| iced::widget::text::Style { color: Some(theme::TEXT_1) });

    let subtitle = text("Open a project to get started")
        .size(theme::SZ_BODY)
        .style(|_| iced::widget::text::Style { color: Some(theme::TEXT_3) });

    let open_cta = container(
        row![
            icons::folder(12.0),
            text("Open project")
                .size(13.0)
                .style(|_| iced::widget::text::Style { color: Some(theme::TEXT_1) }),
        ]
        .spacing(8.0)
        .align_y(iced::Alignment::Center),
    )
    .padding([8.0, 14.0])
    .style(|_| {
        iced::widget::container::Style::default()
            .background(theme::BG_2)
            .border(Border {
                radius: 6.0.into(),
                width: 1.0,
                color: theme::LINE,
            })
    });

    let inner = column![
        title,
        Space::new().width(0.0).height(8.0),
        subtitle,
        Space::new().width(0.0).height(20.0),
        open_cta,
    ]
    .align_x(iced::Alignment::Center);

    container(inner)
        .width(Length::Fill)
        .height(Length::Fill)
        .center_x(Length::Fill)
        .center_y(Length::Fill)
        .into()
}

