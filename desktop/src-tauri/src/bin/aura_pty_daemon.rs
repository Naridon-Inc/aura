//! `aura-pty-daemon` — long-lived host for PTY children spawned by
//! Aura Shell. Opt-in companion process behind the
//! `AURA_USE_PTY_DAEMON=1` env var. See `pty_daemon` module docs in
//! the lib for the why.

use aura_shell_lib::pty_daemon;

#[tokio::main(flavor = "multi_thread", worker_threads = 4)]
async fn main() {
    eprintln!(
        "[aura-pty-daemon] {} starting (pid {})",
        env!("CARGO_PKG_VERSION"),
        std::process::id()
    );
    let reg = pty_daemon::server::Registry::new();
    if let Err(e) = pty_daemon::server::serve_forever(reg).await {
        eprintln!("[aura-pty-daemon] fatal: {e}");
        std::process::exit(1);
    }
}
