// cloud_endpoint — which cloud this CLI talks to, and whose token it sends.
//
// One rule, in one place: the environment wins over the signed-in config, and
// a token never follows a URL it was not issued for.
//
// `AURA_CLOUD_URL` points the CLI at a different cloud — the local staging
// stack (`scripts/staging.sh`), a self-hosted server, a colleague's box.
// Before this module, every call site read `config.cloud_url` FIRST and treated
// the environment as a fallback, so on a signed-in laptop the override did
// nothing at all: `aura` went on pushing intents, usage and checkpoints to
// production while the app and console beside it were pointed at staging. An
// override you have to sign out to use is not an override.
//
// The second rule is the one that matters for safety. When `AURA_CLOUD_URL`
// names another cloud, the signed-in `cloud_api_token` is NOT sent. That bearer
// belongs to production; a staging or self-hosted server has no business
// seeing it, and neither does whoever runs one. An override brings its own
// token via `AURA_CLOUD_TOKEN`, or the call runs unauthenticated and the caller
// reports "no cloud token" exactly as it does when signed out.
//
// This is the same contract the desktop app enforces in
// `aura-shell/src-tauri/src/cloud_endpoint.rs`, so a laptop cannot end up
// half-pointed at two servers.

/// Names the cloud to talk to. Overrides the signed-in `cloud_url`.
pub const URL_ENV: &str = "AURA_CLOUD_URL";
/// The bearer to send. Required when `AURA_CLOUD_URL` names another cloud.
pub const TOKEN_ENV: &str = "AURA_CLOUD_TOKEN";

/// The cloud to call: the environment first, then what this machine signed in
/// to. Trailing slashes are trimmed so callers can always `format!("{url}/…")`.
/// `None` means neither is set — the caller's own "not connected" case.
pub fn origin(config_url: Option<&str>) -> Option<String> {
    from_env(URL_ENV)
        .or_else(|| clean(config_url))
        .map(|u| u.trim_end_matches('/').to_string())
}

/// The same, with the caller's own fallback for when neither is set. Call
/// sites disagree about that fallback — some reach the API host, some the apex
/// — so each keeps the one it had rather than being quietly re-pointed.
pub fn origin_or(config_url: Option<&str>, default: &str) -> String {
    origin(config_url).unwrap_or_else(|| default.trim_end_matches('/').to_string())
}

/// The same, falling back to the public cloud — for the paths that are meant
/// to work before anyone has signed in.
pub fn origin_or_public(config_url: Option<&str>) -> String {
    origin_or(config_url, "https://api.auravcs.com")
}

/// The bearer to send to `origin()`.
///
/// An explicit `AURA_CLOUD_TOKEN` always wins. Failing that, the signed-in
/// token is used ONLY when no URL override is in play — pointing at another
/// cloud without naming a token means running unauthenticated, never handing
/// production's bearer to whatever host the environment named.
pub fn token(config_token: Option<&str>) -> Option<String> {
    if let Some(explicit) = from_env(TOKEN_ENV) {
        return Some(explicit);
    }
    if from_env(URL_ENV).is_some() {
        return None;
    }
    clean(config_token)
}

/// True when this process is pointed somewhere other than what it signed in to
/// — for diagnostics that would otherwise report the wrong server.
pub fn is_overridden() -> bool {
    from_env(URL_ENV).is_some() || from_env(TOKEN_ENV).is_some()
}

/// An environment variable that is set but blank counts as unset — an empty
/// `AURA_CLOUD_URL=` in a shell profile should not silently disconnect the CLI.
fn from_env(name: &str) -> Option<String> {
    clean(std::env::var(name).ok().as_deref())
}

fn clean(value: Option<&str>) -> Option<String> {
    value
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(str::to_string)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::{Mutex, OnceLock};

    // The process environment is global; these tests write it.
    fn env_lock() -> &'static Mutex<()> {
        static LOCK: OnceLock<Mutex<()>> = OnceLock::new();
        LOCK.get_or_init(|| Mutex::new(()))
    }

    struct EnvGuard(&'static str);
    impl EnvGuard {
        fn set(name: &'static str, value: &str) -> Self {
            unsafe { std::env::set_var(name, value) };
            EnvGuard(name)
        }
        fn clear(name: &'static str) -> Self {
            unsafe { std::env::remove_var(name) };
            EnvGuard(name)
        }
    }
    impl Drop for EnvGuard {
        fn drop(&mut self) {
            unsafe { std::env::remove_var(self.0) };
        }
    }

    #[test]
    fn signed_in_config_is_used_when_nothing_is_overridden() {
        let _g = env_lock().lock().unwrap();
        let _u = EnvGuard::clear(URL_ENV);
        let _t = EnvGuard::clear(TOKEN_ENV);
        assert_eq!(
            origin(Some("https://api.auravcs.com/")).as_deref(),
            Some("https://api.auravcs.com")
        );
        assert_eq!(token(Some("aura_prod")).as_deref(), Some("aura_prod"));
    }

    #[test]
    fn the_environment_beats_the_signed_in_url() {
        let _g = env_lock().lock().unwrap();
        let _u = EnvGuard::set(URL_ENV, "http://localhost:3011/");
        let _t = EnvGuard::clear(TOKEN_ENV);
        // The whole point: on a signed-in laptop the override still wins.
        assert_eq!(origin(Some("https://api.auravcs.com")).as_deref(), Some("http://localhost:3011"));
    }

    #[test]
    fn pointing_at_another_cloud_never_sends_the_production_token() {
        let _g = env_lock().lock().unwrap();
        let _u = EnvGuard::set(URL_ENV, "http://localhost:3011");
        let _t = EnvGuard::clear(TOKEN_ENV);
        assert_eq!(token(Some("aura_prod")), None);
    }

    #[test]
    fn an_override_may_bring_its_own_token() {
        let _g = env_lock().lock().unwrap();
        let _u = EnvGuard::set(URL_ENV, "http://localhost:3011");
        let _t = EnvGuard::set(TOKEN_ENV, "aura_staging");
        assert_eq!(token(Some("aura_prod")).as_deref(), Some("aura_staging"));
    }

    #[test]
    fn a_blank_override_is_not_an_override() {
        let _g = env_lock().lock().unwrap();
        let _u = EnvGuard::set(URL_ENV, "   ");
        let _t = EnvGuard::set(TOKEN_ENV, "");
        assert_eq!(origin(Some("https://api.auravcs.com")).as_deref(), Some("https://api.auravcs.com"));
        assert_eq!(token(Some("aura_prod")).as_deref(), Some("aura_prod"));
        assert!(!is_overridden());
    }

    #[test]
    fn nothing_configured_and_nothing_overridden_is_the_public_cloud() {
        let _g = env_lock().lock().unwrap();
        let _u = EnvGuard::clear(URL_ENV);
        let _t = EnvGuard::clear(TOKEN_ENV);
        assert_eq!(origin(None), None);
        assert_eq!(origin_or_public(None), "https://api.auravcs.com");
        assert_eq!(token(None), None);
    }
}
