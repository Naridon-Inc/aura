//! Reading what a pasted string names, and validating an access level.
//!
//! A person joining a session may have a share link, a bare share code, an
//! in-app deep link, or the session id the UI already knows. All four arrive
//! through the same argument, and telling them apart wrong means either a
//! pointless 15-second socket timeout or a preview request for something that
//! was never a code.

use super::protocol::ACCESS_LEVELS;

/// What a pasted string turned out to name.
#[derive(Debug, PartialEq, Eq)]
pub enum Target {
    /// A session's `external_id` — dial it directly.
    Id(String),
    /// A share code — has to be resolved through the preview endpoint first,
    /// which is also what tells the joiner whose machine they are about to act
    /// on.
    Code(String),
    /// A bare token that could be either. Resolved by trying the cheap preview
    /// GET before falling back to treating it as a session id, because a share
    /// code is the thing a person actually types and a session id is the thing
    /// the UI passes.
    Either(String),
}

impl Target {
    /// The session id, for a caller that can only act on one.
    pub fn as_session_id(&self) -> Result<String, String> {
        match self {
            Target::Id(s) | Target::Either(s) => Ok(s.clone()),
            Target::Code(c) => Err(format!(
                "{c} is a share code — join with it instead of sharing it"
            )),
        }
    }
}

/// The fallback link, used only when the cloud's `share` endpoint did not give
/// us one. It is an in-app deep link on purpose: a made-up web URL would be a
/// link that looks shareable and resolves to nothing.
pub fn fallback_share_url(external_id: &str) -> String {
    format!("aura://session/{external_id}")
}

/// Accept a session id, an `aura://` deep link, or a share URL, and say what it
/// names.
///
/// Deliberately lenient about the URL shape: the cloud owns the public route
/// and may move it, and a person pasting a link should not have to care which
/// path segment the product settled on. `/s/<code>` is the documented share
/// route and is read as a code; anything else falls back to "the last non-empty
/// segment is the id".
pub fn parse_target(input: &str) -> Result<Target, String> {
    let t = input.trim();
    if t.is_empty() {
        return Err("give a session id or a share link".into());
    }
    if let Some(rest) = t.strip_prefix("aura://session/") {
        return last_segment(rest)
            .map(Target::Id)
            .ok_or_else(|| format!("no session id in {t}"));
    }
    if let Some(rest) = t.strip_prefix("aura://join/") {
        return last_segment(rest)
            .map(Target::Code)
            .ok_or_else(|| format!("no share code in {t}"));
    }
    if t.starts_with("http://") || t.starts_with("https://") {
        let url = url::Url::parse(t).map_err(|e| format!("bad link {t}: {e}"))?;
        let segs: Vec<String> = url
            .path_segments()
            .map(|s| s.filter(|p| !p.is_empty()).map(str::to_string).collect())
            .unwrap_or_default();
        // `https://<cloud>/s/<code>` — the documented share link.
        if let Some(pos) = segs.iter().position(|s| s == "s") {
            if let Some(code) = segs.get(pos + 1) {
                return Ok(Target::Code(code.clone()));
            }
        }
        return segs
            .last()
            .cloned()
            .map(Target::Id)
            .ok_or_else(|| format!("no session id in {t}"));
    }
    if t.contains('/') || t.contains('?') || t.contains('#') {
        return Err(format!("{t} is not a session id or a share link"));
    }
    Ok(Target::Either(t.to_string()))
}

fn last_segment(s: &str) -> Option<String> {
    s.split('/')
        .filter(|p| !p.is_empty())
        .next_back()
        .map(|p| p.split('?').next().unwrap_or(p).to_string())
        .filter(|p| !p.is_empty())
}

/// Validate an access level, defaulting when the caller gave none.
///
/// Rejects anything unrecognised rather than falling back, because the fallback
/// a typo would land on is a decision about who may type into an agent.
pub fn normalise_access(raw: Option<String>, default: &str) -> Result<String, String> {
    let level = raw
        .map(|s| s.trim().to_lowercase())
        .filter(|s| !s.is_empty())
        .unwrap_or_else(|| default.to_string());
    if !ACCESS_LEVELS.contains(&level.as_str()) {
        return Err(format!(
            "unknown access {level} — expected one of {}",
            ACCESS_LEVELS.join(", ")
        ));
    }
    Ok(level)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::cmd_session_live::protocol::ACCESS_WATCH;

    #[test]
    fn a_bare_token_could_be_either() {
        assert_eq!(
            parse_target("  abc-123  ").unwrap(),
            Target::Either("abc-123".into())
        );
    }

    #[test]
    fn the_documented_share_route_reads_as_a_code() {
        assert_eq!(
            parse_target("https://auravcs.com/s/k3f9qa").unwrap(),
            Target::Code("k3f9qa".into())
        );
        // Trailing slash, and a cloud that mounts the app under a prefix.
        assert_eq!(
            parse_target("https://auravcs.com/app/s/k3f9qa/").unwrap(),
            Target::Code("k3f9qa".into())
        );
    }

    #[test]
    fn any_other_link_falls_back_to_the_last_segment_as_an_id() {
        assert_eq!(
            parse_target("https://auravcs.com/live/abc-123").unwrap(),
            Target::Id("abc-123".into())
        );
    }

    #[test]
    fn the_aura_scheme_distinguishes_a_session_from_a_code() {
        assert_eq!(
            parse_target("aura://session/abc-123").unwrap(),
            Target::Id("abc-123".into())
        );
        assert_eq!(
            parse_target("aura://join/k3f9qa").unwrap(),
            Target::Code("k3f9qa".into())
        );
    }

    #[test]
    fn a_path_shaped_non_link_is_refused_rather_than_guessed() {
        assert!(parse_target("some/thing").is_err());
        assert!(parse_target("").is_err());
    }

    #[test]
    fn sharing_a_code_is_refused_rather_than_dialled_as_an_id() {
        assert!(parse_target("https://auravcs.com/s/k3f9qa")
            .unwrap()
            .as_session_id()
            .is_err());
    }

    #[test]
    fn access_defaults_to_watch_and_rejects_anything_else() {
        assert_eq!(normalise_access(None, ACCESS_WATCH).unwrap(), "watch");
        assert_eq!(
            normalise_access(Some("  DRIVE ".into()), ACCESS_WATCH).unwrap(),
            "drive"
        );
        assert!(normalise_access(Some("admin".into()), ACCESS_WATCH).is_err());
    }
}
