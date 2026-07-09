//! Capability ACL.
//!
//! Each manifest declares a flat list of capability strings shaped
//! `family:verb[:scope]`. The bridge (W1.1) calls
//! `CapabilitySet::allows()` before dispatching any host method, so the
//! ACL needs to be cheap to query (hot path on every plugin RPC).
//!
//! Scope matching uses fnmatch-style glob:
//!   `*` matches any run of characters (including `.`)
//!   `?` matches exactly one character
//!   anything else is a literal
//!
//! A capability with no scope segment grants the verb unconditionally —
//! the caller passes `None` for `target` and we accept. A capability
//! *with* a scope can still be queried with `None`; we treat that as a
//! deny since the caller didn't justify the request.

use std::collections::HashSet;
use std::fmt;

/// One parsed capability declaration.
#[derive(Debug, Clone, PartialEq, Eq, Hash)]
pub struct Capability {
    pub family: String,
    pub verb: String,
    /// Scope glob, e.g. `*.linear.app` or `api.linear.app`. None means
    /// the verb is unconstrained (rare — most capabilities scope down).
    pub scope: Option<String>,
}

impl Capability {
    /// Parse a `family:verb[:scope...]` string. Extra colons after the
    /// second one collapse back into the scope segment so authors can
    /// write `aura:tasks:read:plan` style sub-scopes if a future verb
    /// wants them.
    pub fn parse(raw: &str) -> Result<Self, CapabilityError> {
        let raw = raw.trim();
        if raw.is_empty() {
            return Err(CapabilityError::Empty);
        }
        let mut parts = raw.splitn(3, ':');
        let family = parts.next().unwrap_or("").trim();
        let verb = parts.next().unwrap_or("").trim();
        if family.is_empty() || verb.is_empty() {
            return Err(CapabilityError::Malformed(raw.to_string()));
        }
        let scope = parts.next().map(|s| s.trim().to_string()).filter(|s| !s.is_empty());
        Ok(Self {
            family: family.to_string(),
            verb: verb.to_string(),
            scope,
        })
    }

    /// True iff this capability declaration covers a request for the
    /// given family + verb + target scope.
    pub fn allows(&self, family: &str, verb: &str, target: Option<&str>) -> bool {
        if self.family != family || self.verb != verb {
            return false;
        }
        match (&self.scope, target) {
            // Capability is unscoped → permits any target (or no target).
            (None, _) => true,
            // Capability has a scope but the caller didn't supply one →
            // we refuse to make assumptions. Deny.
            (Some(_), None) => false,
            (Some(pat), Some(t)) => glob_match(pat, t),
        }
    }
}

impl fmt::Display for Capability {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match &self.scope {
            Some(s) => write!(f, "{}:{}:{}", self.family, self.verb, s),
            None => write!(f, "{}:{}", self.family, self.verb),
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum CapabilityError {
    Empty,
    Malformed(String),
}

impl fmt::Display for CapabilityError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            CapabilityError::Empty => f.write_str("capability string is empty"),
            CapabilityError::Malformed(s) => write!(f, "malformed capability `{s}`"),
        }
    }
}

impl std::error::Error for CapabilityError {}

/// Collection of parsed capabilities — what a single plugin holds.
#[derive(Debug, Clone, Default)]
pub struct CapabilitySet {
    caps: HashSet<Capability>,
}

impl CapabilitySet {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn len(&self) -> usize {
        self.caps.len()
    }

    pub fn is_empty(&self) -> bool {
        self.caps.is_empty()
    }

    pub fn iter(&self) -> impl Iterator<Item = &Capability> {
        self.caps.iter()
    }

    /// Build from the raw capability strings in a manifest. Returns
    /// the first parse error; the registry treats this as plugin
    /// rejection.
    pub fn from_manifest_strings(raws: &[String]) -> Result<Self, CapabilityError> {
        let mut set = Self::new();
        for raw in raws {
            set.caps.insert(Capability::parse(raw)?);
        }
        Ok(set)
    }

    /// Hot-path check for the bridge: does this plugin's capability
    /// set grant `family:verb[:target]`?
    pub fn allows(&self, family: &str, verb: &str, target: Option<&str>) -> bool {
        self.caps
            .iter()
            .any(|c| c.allows(family, verb, target))
    }
}

// ─── glob ────────────────────────────────────────────────────────────

/// Tiny fnmatch-style matcher. `*` matches zero+ of any char, `?` exactly
/// one. No escaping (intentional — capability scopes don't carry literal
/// `*` in any real example). Iterative two-pointer with backtracking, so
/// it stays O(N*M) worst case but doesn't allocate.
///
/// Public so the net.fetch proxy can match a `netAuth` binding's host
/// glob against a request host with the exact same semantics the
/// capability ACL uses — one matcher, no drift.
pub fn glob_match(pattern: &str, target: &str) -> bool {
    let p: Vec<char> = pattern.chars().collect();
    let t: Vec<char> = target.chars().collect();
    let (mut pi, mut ti) = (0usize, 0usize);
    let (mut star_pi, mut star_ti): (Option<usize>, usize) = (None, 0);

    while ti < t.len() {
        if pi < p.len() && (p[pi] == '?' || p[pi] == t[ti]) {
            pi += 1;
            ti += 1;
        } else if pi < p.len() && p[pi] == '*' {
            star_pi = Some(pi);
            star_ti = ti;
            pi += 1;
        } else if let Some(sp) = star_pi {
            pi = sp + 1;
            star_ti += 1;
            ti = star_ti;
        } else {
            return false;
        }
    }
    while pi < p.len() && p[pi] == '*' {
        pi += 1;
    }
    pi == p.len()
}

// ─── tests ───────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_simple_capability() {
        let c = Capability::parse("net:fetch").unwrap();
        assert_eq!(c.family, "net");
        assert_eq!(c.verb, "fetch");
        assert_eq!(c.scope, None);
    }

    #[test]
    fn parses_scoped_capability() {
        let c = Capability::parse("net:fetch:*.linear.app").unwrap();
        assert_eq!(c.family, "net");
        assert_eq!(c.verb, "fetch");
        assert_eq!(c.scope.as_deref(), Some("*.linear.app"));
    }

    #[test]
    fn parses_sub_scoped_capability() {
        // The third splitn segment keeps remaining colons intact.
        let c = Capability::parse("aura:tasks:read:plan").unwrap();
        assert_eq!(c.scope.as_deref(), Some("read:plan"));
    }

    #[test]
    fn rejects_empty_and_malformed() {
        assert!(matches!(Capability::parse(""), Err(CapabilityError::Empty)));
        assert!(matches!(Capability::parse("net"), Err(CapabilityError::Malformed(_))));
        assert!(matches!(Capability::parse("net:"), Err(CapabilityError::Malformed(_))));
        assert!(matches!(Capability::parse(":fetch"), Err(CapabilityError::Malformed(_))));
    }

    #[test]
    fn unscoped_capability_allows_any_target() {
        let c = Capability::parse("net:fetch").unwrap();
        assert!(c.allows("net", "fetch", Some("api.linear.app")));
        assert!(c.allows("net", "fetch", None));
        assert!(!c.allows("net", "send", Some("api.linear.app")));
        assert!(!c.allows("fs", "fetch", None));
    }

    #[test]
    fn scoped_capability_requires_explicit_target() {
        let c = Capability::parse("net:fetch:api.linear.app").unwrap();
        assert!(c.allows("net", "fetch", Some("api.linear.app")));
        assert!(!c.allows("net", "fetch", Some("api.evil.com")));
        // No target supplied → deny (can't assume scope match).
        assert!(!c.allows("net", "fetch", None));
    }

    #[test]
    fn glob_matches_wildcard_subdomain() {
        let c = Capability::parse("net:fetch:*.linear.app").unwrap();
        assert!(c.allows("net", "fetch", Some("api.linear.app")));
        assert!(c.allows("net", "fetch", Some("webhook.linear.app")));
        assert!(!c.allows("net", "fetch", Some("linear.app"))); // * requires at least one char
        assert!(!c.allows("net", "fetch", Some("api.evil.com")));
    }

    #[test]
    fn glob_matches_bare_asterisk() {
        assert!(glob_match("*", ""));
        assert!(glob_match("*", "anything"));
        assert!(glob_match("*.*", "a.b"));
        assert!(!glob_match("*.*", "ab"));
    }

    #[test]
    fn glob_handles_question_mark() {
        assert!(glob_match("a?c", "abc"));
        assert!(!glob_match("a?c", "ac"));
        assert!(!glob_match("a?c", "abcd"));
    }

    #[test]
    fn capability_set_dispatches_to_any_match() {
        let raws = vec![
            "net:fetch:*.linear.app".to_string(),
            "aura:intent:read".to_string(),
            "ui:slash-command".to_string(),
        ];
        let set = CapabilitySet::from_manifest_strings(&raws).unwrap();
        assert_eq!(set.len(), 3);
        assert!(set.allows("aura", "intent", Some("read")));
        assert!(set.allows("net", "fetch", Some("api.linear.app")));
        assert!(set.allows("ui", "slash-command", None));
        assert!(!set.allows("net", "fetch", Some("api.evil.com")));
        assert!(!set.allows("fs", "read", None));
    }

    #[test]
    fn capability_set_rejects_first_bad_string() {
        let raws = vec!["net:fetch:*.linear.app".to_string(), "garbage".to_string()];
        let err = CapabilitySet::from_manifest_strings(&raws).unwrap_err();
        assert!(matches!(err, CapabilityError::Malformed(_)));
    }
}
