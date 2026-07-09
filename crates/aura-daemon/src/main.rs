//! aura-daemon binary entrypoint. Thin — all logic lives in the library.

use std::process::ExitCode;

use aura_daemon::server::{serve, ServerConfig};
use aura_daemon::DAEMON_BUILD;
use aura_daemon_client::paths::DaemonPaths;
use tracing::{error, info};

#[tokio::main(flavor = "current_thread")]
async fn main() -> ExitCode {
    init_tracing();

    let paths = match DaemonPaths::platform_default() {
        Ok(p) => p,
        Err(e) => {
            eprintln!("aura-daemon: failed to resolve paths: {e}");
            return ExitCode::from(2);
        }
    };

    let cfg = match ServerConfig::with_default_blockstore(paths, DAEMON_BUILD.to_string()) {
        Ok(c) => c,
        Err(e) => {
            eprintln!("aura-daemon: {e}");
            return ExitCode::from(2);
        }
    };

    info!(
        dir = %cfg.paths.dir().display(),
        socket = %cfg.paths.socket().display(),
        "aura-daemon starting"
    );

    match serve(cfg, tokio::signal::ctrl_c()).await {
        Ok(()) => {
            info!("aura-daemon stopped cleanly");
            ExitCode::SUCCESS
        }
        Err(e) => {
            error!(error = %e, "aura-daemon exited with error");
            ExitCode::from(1)
        }
    }
}

fn init_tracing() {
    use tracing_subscriber::{fmt, EnvFilter};
    let filter = EnvFilter::try_from_default_env().unwrap_or_else(|_| EnvFilter::new("info"));
    let _ = fmt().with_env_filter(filter).try_init();
}
