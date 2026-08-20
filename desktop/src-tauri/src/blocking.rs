//! Small bridge for synchronous work reached from async Tauri commands.

/// Run synchronous work on Tokio's blocking pool without changing the
/// command's result or error shape. Panics keep propagating as panics instead
/// of being translated into a new user-visible command error.
pub async fn run<F, T>(work: F) -> T
where
    F: FnOnce() -> T + Send + 'static,
    T: Send + 'static,
{
    match tokio::task::spawn_blocking(work).await {
        Ok(result) => result,
        Err(error) if error.is_panic() => std::panic::resume_unwind(error.into_panic()),
        Err(error) => panic!("blocking task was cancelled: {error}"),
    }
}
