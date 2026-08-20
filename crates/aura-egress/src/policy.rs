//! What the work may reach once the installing is over.

use serde::{Deserialize, Serialize};
use std::fmt;

/// One host and port the agent phase is allowed to reach.
///
/// A host, not a URL and not a pattern. `api.anthropic.com:443` is a machine to
/// dial; `https://api.anthropic.com/v1/*` is a *hope* about what will be sent
/// there, and nothing in this file could enforce it — the bytes inside a TLS
/// session are the model's business and ours to stay out of. Saying only what
/// can actually be held to is the difference between a policy and a comment.
#[derive(Debug, Clone, PartialEq, Eq, PartialOrd, Ord, Serialize, Deserialize)]
pub struct Endpoint {
    host: String,
    port: u16,
}

impl Endpoint {
    /// A host and port known at compile time or read off a machine row.
    ///
    /// The host is lowercased here rather than at every comparison: DNS is
    /// case-insensitive, and `API.anthropic.com` in a spec must not be a second
    /// entry that permits nothing.
    pub fn new(host: impl Into<String>, port: u16) -> Self {
        Endpoint {
            host: host.into().trim().to_ascii_lowercase(),
            port,
        }
    }

    /// Read one back from `host:port`.
    ///
    /// The strings this sees have already been through
    /// `aura_env::parse`, which is where a person editing `.aura/settings.toml`
    /// gets told *why* `https://example.com/x` is not an allowlist entry. This
    /// is the reader for what that produced, so it is short — but it still
    /// refuses rather than guesses, because the other caller is a command line
    /// and a silently-mangled entry would be a hole nobody could see.
    pub fn parse(raw: &str) -> Result<Self, String> {
        let text = raw.trim();
        if text.is_empty() {
            return Err("an empty host allows nothing".into());
        }
        let (host, port) = match text.rsplit_once(':') {
            Some((h, p)) => {
                let port: u16 = p
                    .trim()
                    .parse()
                    .map_err(|_| format!("`{p}` is not a port"))?;
                (h.trim(), port)
            }
            None => (text, 443),
        };
        if port == 0 {
            return Err("port 0 is not a port to reach".into());
        }
        if host.is_empty() {
            return Err(format!("`{text}` names a port but no host"));
        }
        if !host
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || matches!(c, '.' | '-' | '_'))
        {
            return Err(format!("`{host}` is not a hostname"));
        }
        Ok(Endpoint::new(host, port))
    }

    pub fn host(&self) -> &str {
        &self.host
    }

    pub fn port(&self) -> u16 {
        self.port
    }

    /// Is this the machine somebody just asked for?
    fn is(&self, host: &str, port: u16) -> bool {
        self.port == port && self.host.eq_ignore_ascii_case(host.trim())
    }
}

impl fmt::Display for Endpoint {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "{}:{}", self.host, self.port)
    }
}

/// Why an endpoint is on the list.
///
/// Kept with the entry rather than derived later, because the report a person
/// reads has to be able to say "you asked for this" and "the agent cannot start
/// without this" in different words. A flat list of hosts makes those two look
/// like the same decision, and only one of them is theirs.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Reason {
    /// The project asked for it, in `[env.network]` of its signed spec.
    Declared,
    /// The agent's own model API. Without it there is no agent, only a process.
    Model,
    /// Where this checkout came from and pushes back to.
    Remote,
}

impl Reason {
    /// The half-sentence a row is shown with.
    pub fn plainly(&self) -> &'static str {
        match self {
            Reason::Declared => "this project asked for it",
            Reason::Model => "the agent cannot answer without its own model",
            Reason::Remote => "this is where the code came from",
        }
    }
}

/// One line of the allowlist: a machine, and why it is on it.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Allowed {
    pub endpoint: Endpoint,
    pub reason: Reason,
}

/// Everywhere the agent phase may reach, and — by being a closed list —
/// everywhere it may not.
///
/// Two sources, and the difference between them is the whole security argument:
///
/// * The **declared** entries come out of `.aura/settings.toml`, inside the
///   signed [`aura_env::EnvSpec`]. Widening that list changes the spec digest
///   and breaks the seal, so an agent that has been talked into editing its own
///   allowlist has not widened anything it can use in the same run — it has
///   produced a spec its own place will refuse to apply.
/// * The **floor** is added here, in code, and is not editable from the
///   repository at all: the model API the agent is, and the remote the checkout
///   came from. A project that forgot to declare its model would otherwise
///   discover the feature by watching every agent fail.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct Egress {
    allow: Vec<Allowed>,
}

impl Egress {
    /// The list, from what the project declared and what the run cannot do
    /// without.
    ///
    /// Sorted and de-duplicated by endpoint, first reason winning, so the order
    /// two people wrote their hosts in is not a difference between two runs.
    /// Declared entries are offered first deliberately: if a project has already
    /// named its model API, the row says the project asked for it, which is the
    /// truer sentence.
    pub fn plan(declared: &[String], floor: Vec<Allowed>) -> Result<Self, String> {
        let mut allow: Vec<Allowed> = Vec::new();
        for raw in declared {
            allow.push(Allowed {
                endpoint: Endpoint::parse(raw)?,
                reason: Reason::Declared,
            });
        }
        allow.extend(floor);
        allow.sort_by(|a, b| a.endpoint.cmp(&b.endpoint));
        allow.dedup_by(|a, b| a.endpoint == b.endpoint);
        Ok(Egress { allow })
    }

    /// The list as the broker was handed it.
    pub fn of(allow: Vec<Allowed>) -> Self {
        Egress { allow }
    }

    /// May the work reach this machine?
    ///
    /// Exact host and exact port. No suffix matching, because `evil-github.com`
    /// ends with nothing dangerous and `x.github.com` is a machine nobody
    /// reviewed — and because a wildcard cannot be resolved before the work
    /// starts, which is the property this whole arrangement rests on.
    pub fn permits(&self, host: &str, port: u16) -> bool {
        self.allow.iter().any(|a| a.endpoint.is(host, port))
    }

    pub fn entries(&self) -> &[Allowed] {
        &self.allow
    }

    pub fn is_empty(&self) -> bool {
        self.allow.is_empty()
    }

    /// The list as one argument, for the command line the guard script runs.
    ///
    /// Comma-separated because it goes through a POSIX shell into a process
    /// table: one flag with a value nobody has to quote twice.
    pub fn as_arg(&self) -> String {
        self.allow
            .iter()
            .map(|a| a.endpoint.to_string())
            .collect::<Vec<_>>()
            .join(",")
    }

    /// The same list, read back off that command line.
    ///
    /// Reasons do not survive the trip and do not need to: the broker's job is
    /// to answer yes or no, and *why* an entry is on the list is a question for
    /// the surface that shows it, which has the spec in front of it.
    pub fn from_arg(arg: &str) -> Result<Self, String> {
        let mut allow = Vec::new();
        for part in arg.split(',').map(str::trim).filter(|p| !p.is_empty()) {
            allow.push(Allowed {
                endpoint: Endpoint::parse(part)?,
                reason: Reason::Declared,
            });
        }
        Ok(Egress { allow })
    }

    /// One line for a header.
    pub fn summary(&self) -> String {
        match self.allow.len() {
            0 => "nothing at all — the agent phase can reach no machine".to_string(),
            1 => format!("one machine: {}", self.allow[0].endpoint),
            n => format!(
                "{n} machines: {}",
                self.allow
                    .iter()
                    .map(|a| a.endpoint.to_string())
                    .collect::<Vec<_>>()
                    .join(", ")
            ),
        }
    }
}

/// What an agent cannot work without: the API its own model answers on.
///
/// A table rather than a probe, because it has to be right *before* the work
/// starts — after the wall is up there is no asking. It is deliberately short:
/// the login and inference hosts each agent will not run without, and nothing
/// else. Telemetry and update checks are not on it, and an agent that wanted one
/// says so in the journal rather than silently having it.
///
/// An agent nobody has written a row for gets no floor at all, which is honest
/// rather than convenient: it will be refused on its first call, the journal
/// will name the host it wanted, and adding that host to the project's spec is
/// one line. Guessing a hostname here would be worse — the guess that is wrong
/// is a hole, and the guess that is right is a host nobody reviewed.
pub fn model_endpoints(bin: &str) -> Vec<Endpoint> {
    let hosts: &[&str] = match bin.trim() {
        "claude" => &["api.anthropic.com", "console.anthropic.com"],
        "codex" => &["api.openai.com", "auth.openai.com", "chatgpt.com"],
        "gemini" => &[
            "generativelanguage.googleapis.com",
            "cloudcode-pa.googleapis.com",
            "oauth2.googleapis.com",
        ],
        "kimi" => &["api.moonshot.cn", "api.moonshot.ai"],
        _ => &[],
    };
    hosts.iter().map(|h| Endpoint::new(*h, 443)).collect()
}

/// The floor for one run: the agent's model, and the machine the code lives on.
///
/// `remote` is a git remote as written in `.git/config` — `https://github.com/…`
/// or `git@github.com:…`. Anything else it cannot make sense of is left out
/// rather than guessed at.
pub fn floor(bin: &str, remote: Option<&str>) -> Vec<Allowed> {
    let mut out: Vec<Allowed> = model_endpoints(bin)
        .into_iter()
        .map(|endpoint| Allowed {
            endpoint,
            reason: Reason::Model,
        })
        .collect();
    if let Some(endpoint) = remote.and_then(remote_endpoint) {
        out.push(Allowed {
            endpoint,
            reason: Reason::Remote,
        });
    }
    out
}

/// The machine a git remote names, and on which port git will reach it.
///
/// ssh remotes come back on 22 and https on 443 — the same host with a
/// different way in, and allowing one is not allowing the other. A fetch that
/// is refused says which, which is more use than a host with no port.
fn remote_endpoint(remote: &str) -> Option<Endpoint> {
    let text = remote.trim();
    if text.is_empty() {
        return None;
    }
    // scheme://[user@]host[:port]/path
    if let Some((scheme, rest)) = text.split_once("://") {
        let authority = rest.split('/').next().unwrap_or_default();
        let host_port = authority.rsplit('@').next().unwrap_or_default();
        let (host, port) = match host_port.rsplit_once(':') {
            Some((h, p)) => (h, p.parse().ok()?),
            None => (
                host_port,
                match scheme {
                    "ssh" => 22,
                    "git" => 9418,
                    _ => 443,
                },
            ),
        };
        return (!host.is_empty()).then(|| Endpoint::new(host, port));
    }
    // scp-style: [user@]host:path
    let (authority, _) = text.split_once(':')?;
    let host = authority.rsplit('@').next().unwrap_or_default();
    (!host.is_empty() && !host.contains('/')).then(|| Endpoint::new(host, 22))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_host_with_no_port_is_a_host_on_443() {
        let e = Endpoint::parse("api.anthropic.com").expect("an endpoint");
        assert_eq!(e.to_string(), "api.anthropic.com:443");
    }

    #[test]
    fn the_same_host_in_two_cases_is_one_machine() {
        // DNS does not care, so a second casing must not be a second entry that
        // permits nothing.
        let egress = Egress::plan(&["API.GitHub.com:443".into()], vec![]).expect("a plan");
        assert!(egress.permits("api.github.com", 443));
        assert!(egress.permits("API.GITHUB.COM", 443));
    }

    #[test]
    fn a_port_is_part_of_the_permission() {
        let egress = Egress::plan(&["github.com:443".into()], vec![]).expect("a plan");
        assert!(egress.permits("github.com", 443));
        // ssh to the same host is a different way in and was not allowed.
        assert!(!egress.permits("github.com", 22));
    }

    #[test]
    fn nothing_is_permitted_by_ending_with_something_that_was() {
        let egress = Egress::plan(&["github.com".into()], vec![]).expect("a plan");
        for near in ["evil-github.com", "github.com.evil.net", "x.github.com"] {
            assert!(!egress.permits(near, 443), "{near} was let through");
        }
    }

    #[test]
    fn an_agent_gets_its_own_model_without_anyone_declaring_it() {
        // Otherwise the first confined run of every project is a puzzle.
        let egress = Egress::plan(&[], floor("claude", None)).expect("a plan");
        assert!(egress.permits("api.anthropic.com", 443));
        assert!(!egress.permits("api.openai.com", 443));
    }

    #[test]
    fn an_agent_nobody_has_a_row_for_gets_no_floor_at_all() {
        // Refused-and-journalled is a fixable afternoon. A guessed hostname is
        // either a hole or a host nobody reviewed.
        assert!(model_endpoints("opencode").is_empty());
        assert!(Egress::plan(&[], floor("opencode", None))
            .expect("a plan")
            .is_empty());
    }

    #[test]
    fn a_declared_host_keeps_the_projects_own_reason_for_it() {
        let egress = Egress::plan(
            &["api.anthropic.com:443".into()],
            floor("claude", Some("https://github.com/naridon/aura.git")),
        )
        .expect("a plan");
        let anthropic = egress
            .entries()
            .iter()
            .find(|a| a.endpoint.host() == "api.anthropic.com")
            .expect("the model host");
        // Declared and floored at once: the project asked, so that is the row.
        assert_eq!(anthropic.reason, Reason::Declared);
        // …and it is one row, not two.
        assert_eq!(
            egress
                .entries()
                .iter()
                .filter(|a| a.endpoint.host() == "api.anthropic.com")
                .count(),
            1
        );
    }

    #[test]
    fn the_same_list_in_a_different_order_is_the_same_policy() {
        let one = Egress::plan(&["b.example:443".into(), "a.example:443".into()], vec![])
            .expect("a plan");
        let two = Egress::plan(&["a.example:443".into(), "b.example:443".into()], vec![])
            .expect("a plan");
        assert_eq!(one, two);
        assert_eq!(one.as_arg(), "a.example:443,b.example:443");
    }

    #[test]
    fn the_list_survives_the_command_line_it_is_handed_to() {
        let egress = Egress::plan(
            &["api.anthropic.com".into(), "github.com".into()],
            floor("claude", None),
        )
        .expect("a plan");
        let back = Egress::from_arg(&egress.as_arg()).expect("read back");
        for a in egress.entries() {
            assert!(
                back.permits(a.endpoint.host(), a.endpoint.port()),
                "{} did not survive",
                a.endpoint
            );
        }
        assert!(!back.permits("evil.example.com", 443));
    }

    #[test]
    fn a_git_remote_is_allowed_on_the_port_git_will_use() {
        let https = floor("pi", Some("https://github.com/naridon/aura.git"));
        assert_eq!(https[0].endpoint.to_string(), "github.com:443");
        assert_eq!(https[0].reason, Reason::Remote);

        let ssh = floor("pi", Some("git@github.com:naridon/aura.git"));
        assert_eq!(ssh[0].endpoint.to_string(), "github.com:22");

        let explicit = floor("pi", Some("ssh://git@git.example.com:2222/x/y.git"));
        assert_eq!(explicit[0].endpoint.to_string(), "git.example.com:2222");
    }

    #[test]
    fn a_remote_that_names_no_machine_adds_nothing() {
        // A local path is a remote too, and it reaches no network.
        for odd in ["", "   ", "/srv/mirrors/aura.git", "../sibling"] {
            assert!(floor("pi", Some(odd)).is_empty(), "{odd:?} allowed something");
        }
    }

    #[test]
    fn an_entry_that_is_not_a_host_is_refused_rather_than_mangled() {
        for bad in ["", "example.com:0", "example.com:notaport", ":443", "a b.com"] {
            assert!(Endpoint::parse(bad).is_err(), "{bad:?} was accepted");
        }
    }

    #[test]
    fn an_empty_list_permits_nothing_rather_than_everything() {
        // The failure that would make all of this decorative.
        let egress = Egress::default();
        assert!(!egress.permits("api.anthropic.com", 443));
        assert!(!egress.permits("127.0.0.1", 8080));
        assert_eq!(
            egress.summary(),
            "nothing at all — the agent phase can reach no machine"
        );
    }
}
