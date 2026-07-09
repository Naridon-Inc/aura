use aura_term::{VERSION, app, theme};
use iced::Size;
use iced::window;
use tracing_subscriber::EnvFilter;

fn main() -> iced::Result {
    tracing_subscriber::fmt()
        .with_env_filter(
            EnvFilter::try_from_env("AURA_TERM_LOG")
                .unwrap_or_else(|_| EnvFilter::new("aura_term=info,aura_blockstore=warn")),
        )
        .init();

    tracing::info!(version = VERSION, "aura-term booting");

    iced::application(app::init, app::update, app::view)
        .subscription(app::subscription)
        .scale_factor(app::scale_factor)
        .theme(app::theme)
        .title(app::title)
        .font(include_bytes!("../assets/AlbraGroteskTRIAL-Regular.otf").as_slice())
        .font(include_bytes!("../assets/AlbraGroteskTRIAL-Medium.otf").as_slice())
        .font(include_bytes!("../assets/AlbraGroteskTRIAL-Bold.otf").as_slice())
        .default_font(theme::FONT_SANS)
        .window(window::Settings {
            size: Size::new(1200.0, 800.0),
            platform_specific: macos_chrome(),
            ..window::Settings::default()
        })
        .run()
}

#[cfg(target_os = "macos")]
fn macos_chrome() -> window::settings::PlatformSpecific {
    window::settings::PlatformSpecific {
        title_hidden: true,
        titlebar_transparent: true,
        fullsize_content_view: true,
    }
}

#[cfg(not(target_os = "macos"))]
fn macos_chrome() -> window::settings::PlatformSpecific {
    window::settings::PlatformSpecific::default()
}
