//! Which cloud this app is talking to, and with whose token — resolved in ONE
//! place so a staging run can't half-apply.
//!
//! Both facts used to be read straight out of `~/.aura/credentials.json`, in
//! two independently-written copies. That made testing against anything other
//! than production a destructive act: to point the dev app at a staging server
//! you edited the same file the production app signs in with, and if you forgot
//! to put it back, the next real session wrote to the wrong place. "Test it
//! without touching prod" was not something the app could actually offer.
//!
//! So the two values also read from the environment, which the CLI has always
//! done for the URL (`AURA_CLOUD_URL`):
//!
//! ```text
//! AURA_CLOUD_URL=http://localhost:3011 AURA_CLOUD_TOKEN=<staging token> <launch the app>
//! ```
//!
//! The signed-in credentials file is not read, not written and not disturbed:
//! close that shell and the app is back on production exactly as it was. The
//! env wins over the file on purpose — an override you had to type is a
//! deliberate act, and it should not be silently outvoted by a stale field.
//!
//! Order for both values: environment, then `credentials.json`, then (for the
//! origin) the public default the caller names.

use serde_json::{Map, Value};

/// Env var naming the cloud to talk to. Same name the CLI already honours, so
/// one exported variable moves the CLI and the app together.
pub(crate) const URL_ENV: &str = "AURA_CLOUD_URL";
/// Env var carrying the bearer for that cloud. A staging server has its own
/// database, so a production token means nothing there — the URL alone is not
/// enough to move an app.
pub(crate) const TOKEN_ENV: &str = "AURA_CLOUD_TOKEN";

/// The cloud origin to call, with no trailing slash. `default_origin` is the
/// caller's own public fallback — the surfaces disagree about it (the apex host
/// for rooms, the API host for sync), and that disagreement is deliberate.
pub(crate) fn origin(map: &Map<String, Value>, default_origin: &str) -> String {
    from_env(URL_ENV)
        .or_else(|| {
            map.get("cloud_url")
                .and_then(|v| v.as_str())
                .map(str::trim)
                .filter(|s| !s.is_empty())
                .map(str::to_string)
        })
        .unwrap_or_else(|| default_origin.to_string())
        .trim_end_matches('/')
        .to_string()
}

/// The bearer for that cloud, or `None` when there isn't one to send.
///
/// A redirected app never falls back to the signed-in token. The token in
/// `credentials.json` was issued by production and means nothing to another
/// server's database — but it is still a live production credential, and
/// sending it to whatever host the environment named would hand it to a machine
/// the user never signed in to. An overridden destination gets an explicitly
/// provided credential or none at all.
pub(crate) fn token(map: &Map<String, Value>) -> Option<String> {
    if let Some(explicit) = from_env(TOKEN_ENV) {
        return Some(explicit);
    }
    if from_env(URL_ENV).is_some() {
        return None;
    }
    map.get("cloud_api_token")
        .and_then(|v| v.as_str())
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(str::to_string)
}

/// Is this app pointed somewhere other than where it is signed in? Surfaces use
/// it to say so out loud — a staging run that looks identical to production is
/// how you end up trusting the wrong numbers.
pub(crate) fn is_overridden() -> bool {
    from_env(URL_ENV).is_some() || from_env(TOKEN_ENV).is_some()
}

/// An env var set to whitespace is set by accident — treat it as unset rather
/// than as an instruction to call the empty host.
fn from_env(name: &str) -> Option<String> {
    std::env::var(name)
        .ok()
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn creds(url: &str, token: &str) -> Map<String, Value> {
        let mut m = Map::new();
        if !url.is_empty() {
            m.insert("cloud_url".into(), Value::String(url.into()));
        }
        if !token.is_empty() {
            m.insert("cloud_api_token".into(), Value::String(token.into()));
        }
        m
    }

    // These tests mutate process env, so they share one lock rather than
    // racing each other under the test harness's threads.
    fn env_lock() -> std::sync::MutexGuard<'static, ()> {
        static LOCK: std::sync::OnceLock<std::sync::Mutex<()>> = std::sync::OnceLock::new();
        LOCK.get_or_init(|| std::sync::Mutex::new(()))
            .lock()
            .unwrap_or_else(|e| e.into_inner())
    }

    struct EnvGuard(&'static str);
    impl Drop for EnvGuard {
        fn drop(&mut self) {
            unsafe { std::env::remove_var(self.0) };
        }
    }
    fn set(name: &'static str, value: &str) -> EnvGuard {
        unsafe { std::env::set_var(name, value) };
        EnvGuard(name)
    }

    #[test]
    fn signed_in_credentials_are_what_we_use_by_default() {
        let _l = env_lock();
        let m = creds("https://api.auravcs.com", "aura_live");
        assert_eq!(origin(&m, "https://auravcs.com"), "https://api.auravcs.com");
        assert_eq!(token(&m).as_deref(), Some("aura_live"));
        assert!(!is_overridden());
    }

    #[test]
    fn an_empty_credentials_file_falls_back_to_the_callers_own_default() {
        let _l = env_lock();
        let m = Map::new();
        assert_eq!(origin(&m, "https://auravcs.com"), "https://auravcs.com");
        assert_eq!(token(&m), None);
    }

    #[test]
    fn the_environment_points_the_app_elsewhere_without_touching_the_file() {
        let _l = env_lock();
        let m = creds("https://api.auravcs.com", "aura_live");
        let _u = set(URL_ENV, "http://localhost:3011");
        let _t = set(TOKEN_ENV, "aura_staging");
        assert_eq!(origin(&m, "https://auravcs.com"), "http://localhost:3011");
        assert_eq!(token(&m).as_deref(), Some("aura_staging"));
        assert!(is_overridden(), "the app must be able to say it is elsewhere");
    }

    #[test]
    fn a_trailing_slash_never_becomes_a_double_slash_in_a_url() {
        let _l = env_lock();
        let _u = set(URL_ENV, "http://localhost:3011/");
        assert_eq!(origin(&Map::new(), "https://auravcs.com"), "http://localhost:3011");
    }

    #[test]
    fn a_blank_override_is_an_accident_not_an_instruction() {
        let _l = env_lock();
        let m = creds("https://api.auravcs.com", "aura_live");
        let _u = set(URL_ENV, "   ");
        let _t = set(TOKEN_ENV, "");
        assert_eq!(origin(&m, "https://auravcs.com"), "https://api.auravcs.com");
        assert_eq!(token(&m).as_deref(), Some("aura_live"));
        assert!(!is_overridden());
    }

    #[test]
    fn pointing_at_another_cloud_never_sends_the_production_token() {
        // The signed-in bearer is a live production credential. Handing it to
        // whatever host the environment named would give it to a machine the
        // user never signed in to — so a redirected app sends nothing unless a
        // token was named for that destination too.
        let _l = env_lock();
        let m = creds("https://api.auravcs.com", "aura_live");
        let _u = set(URL_ENV, "http://localhost:3011");
        assert_eq!(origin(&m, "https://auravcs.com"), "http://localhost:3011");
        assert_eq!(token(&m), None, "must not leak the production bearer");
        assert!(is_overridden());
    }
}
