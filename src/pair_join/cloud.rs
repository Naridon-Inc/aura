//! The three calls a joined computer makes about itself: spend a code, ask
//! whether it is still connected, and take itself off.
//!
//! None of them follows a redirect. The code and the claim go in a POST body
//! and the token in a header; a redirect is how either could end up at a host
//! nobody chose.

use std::time::Duration;

use serde::Deserialize;

use super::machine::Machine;

const TIMEOUT: Duration = Duration::from_secs(30);

pub fn client() -> Result<reqwest::blocking::Client, String> {
    reqwest::blocking::Client::builder()
        .timeout(TIMEOUT)
        .connect_timeout(Duration::from_secs(10))
        .redirect(reqwest::redirect::Policy::none())
        .user_agent(concat!("aura-cli/", env!("CARGO_PKG_VERSION"), " (join)"))
        .build()
        .map_err(|e| format!("couldn't start a connection: {e}"))
}

/// The cloud this computer joins: HTTPS, or plain HTTP only to this machine
/// itself (a local test server). Anything else is refused before a code or a
/// token is sent to it.
pub fn checked_base(raw: &str) -> Result<String, String> {
    let base = raw.trim().trim_end_matches('/').to_string();
    let url = reqwest::Url::parse(&base).map_err(|_| format!("{base} isn't a web address"))?;
    let loopback = matches!(url.host_str(), Some("localhost" | "127.0.0.1" | "[::1]" | "::1"));
    match url.scheme() {
        "https" => {}
        "http" if loopback => {}
        _ => return Err(format!("Aura only connects over HTTPS, and {base} isn't.")),
    }
    if url.username() != "" || url.password().is_some() || url.query().is_some() || url.fragment().is_some() {
        return Err(format!("{base} isn't a plain web address."));
    }
    Ok(base)
}

#[derive(Deserialize)]
pub struct Redeemed {
    pub runner_token: String,
    pub place_id: String,
    pub org_name: String,
    pub scope: String,
    pub name: String,
}

pub enum RedeemError {
    /// The cloud said no: wrong, used, expired, or not allowed. Its own words.
    Refused(String),
    /// Couldn't ask, or the cloud couldn't answer. Trying again may work.
    Unreachable(String),
}

pub fn redeem(
    client: &reqwest::blocking::Client,
    base: &str,
    code: &str,
    claim: &str,
    machine: &Machine,
) -> Result<Redeemed, RedeemError> {
    let body = serde_json::json!({
        "code": code,
        "claim": claim,
        "name": machine.name,
        "os": machine.os,
        "arch": machine.arch,
        "cpus": machine.cpus,
        "memory_mb": machine.memory_mb,
    });
    let resp = client
        .post(format!("{base}/api/v2/places/pair/redeem"))
        .json(&body)
        .send()
        .map_err(|_| RedeemError::Unreachable(offline(base)))?;
    let status = resp.status();
    if status.is_success() {
        return resp
            .json::<Redeemed>()
            .map_err(|_| RedeemError::Unreachable("Aura answered with something this version doesn't understand. Update Aura and try again.".into()));
    }
    let said = error_text(resp);
    match status.as_u16() {
        400 | 403 | 404 | 410 | 422 => Err(RedeemError::Refused(
            said.unwrap_or_else(|| "This code can't be used. Ask for a new one in Aura.".into()),
        )),
        429 => Err(RedeemError::Unreachable(
            said.unwrap_or_else(|| "Too many tries. Wait a few minutes and try again.".into()),
        )),
        _ => Err(RedeemError::Unreachable(
            said.unwrap_or_else(|| "Aura couldn't connect this computer just now. Try again in a moment.".into()),
        )),
    }
}

/// Is the token this computer holds still a live one?
pub enum Alive {
    Yes,
    /// Removed in the app, or never was: the token opens nothing.
    Gone,
    Unknown(String),
}

pub fn still_connected(client: &reqwest::blocking::Client, base: &str, token: &str) -> Alive {
    match client
        .get(format!("{base}/api/v2/runners/self"))
        .bearer_auth(token)
        .send()
    {
        Ok(r) if r.status().is_success() => Alive::Yes,
        Ok(r) if r.status().as_u16() == 401 => Alive::Gone,
        Ok(r) => Alive::Unknown(format!("Aura answered {}", r.status().as_u16())),
        Err(_) => Alive::Unknown(offline(base)),
    }
}

pub enum Removed {
    Done,
    /// Already removed in the app.
    AlreadyGone,
    /// Not a computer that joined with a code — removed in the app instead.
    NotOurs,
    Failed(String),
}

pub fn remove_self(client: &reqwest::blocking::Client, base: &str, token: &str) -> Removed {
    match client
        .delete(format!("{base}/api/v2/runners/self"))
        .bearer_auth(token)
        .send()
    {
        Ok(r) if r.status().is_success() => Removed::Done,
        Ok(r) if r.status().as_u16() == 401 => Removed::AlreadyGone,
        Ok(r) if r.status().as_u16() == 403 => Removed::NotOurs,
        Ok(r) => Removed::Failed(format!("Aura answered {}", r.status().as_u16())),
        Err(_) => Removed::Failed(offline(base)),
    }
}

fn offline(base: &str) -> String {
    let host = reqwest::Url::parse(base)
        .ok()
        .and_then(|u| u.host_str().map(str::to_string))
        .unwrap_or_else(|| base.to_string());
    format!("Couldn't reach Aura ({host}). Check this computer's internet connection and try again.")
}

/// The cloud's `{"error": "…"}`, when it sent one short enough to show.
fn error_text(resp: reqwest::blocking::Response) -> Option<String> {
    let v: serde_json::Value = resp.json().ok()?;
    let s = v.get("error")?.as_str()?.trim();
    (!s.is_empty() && s.len() <= 300 && !s.chars().any(char::is_control)).then(|| s.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn only_https_or_this_machine_is_trusted_with_a_code() {
        assert_eq!(checked_base("https://api.auravcs.com/").unwrap(), "https://api.auravcs.com");
        assert!(checked_base("http://localhost:3001").is_ok());
        assert!(checked_base("http://127.0.0.1:3001").is_ok());
        for bad in [
            "http://api.auravcs.com",
            "http://localhost.evil.com",
            "ftp://api.auravcs.com",
            "https://user:pw@api.auravcs.com",
            "https://api.auravcs.com/?x=1",
            "api.auravcs.com",
        ] {
            assert!(checked_base(bad).is_err(), "{bad} should be refused");
        }
    }
}
