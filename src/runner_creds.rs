//! `aura runner creds` — give the box an agent it can actually run.
//!
//! The wizard signs Claude in interactively: it runs `claude setup-token` on
//! the box and opens the resulting URL in your browser. That is the right
//! default — you approve with your own account and no key is ever typed into a
//! machine. But it is a *person* flow, and an always-on box has two cases it
//! doesn't cover:
//!
//!   * You pay per token rather than by subscription, so what you have is an
//!     API key, not a login.
//!   * The box was built by hand, or rebuilt, and nobody is sitting in front of
//!     a browser to re-approve it.
//!
//! Both end the same way: the runner comes up, claims a task, and the agent
//! exits with "Not logged in". The work fails for a reason that has nothing to
//! do with the work.
//!
//! So credentials get their own file, separate from the runner token, written
//! `0600`, and loaded by the unit as an optional `EnvironmentFile`. Separate
//! because they have different blast radii: the runner token only lets a box
//! heartbeat itself, while an API key can spend money.
//!
//! Nothing here ever prints a key back. `list` reports which agents are
//! configured and the last four characters, which is enough to tell two keys
//! apart and not enough to use one.

use std::collections::BTreeMap;
use std::path::PathBuf;

/// The two ways an agent CLI can be authenticated on a box, per agent.
///
/// `var` is the environment variable the CLI already reads — we populate the
/// environment it looks at rather than inventing a scheme. `login_file` and
/// `login_cmd` are the other half: signing in interactively on the box writes
/// no key at all, and a check that only knew about keys would call a perfectly
/// healthy runner broken.
struct AgentAuthWays {
    agent: &'static str,
    var: &'static str,
    /// Where the CLI's own login lands, relative to `$HOME`.
    login_file: &'static str,
    /// What a human runs on the box to create that file.
    login_cmd: &'static str,
}

const AGENTS: &[AgentAuthWays] = &[
    AgentAuthWays {
        agent: "claude",
        var: "ANTHROPIC_API_KEY",
        login_file: ".claude/.credentials.json",
        login_cmd: "claude setup-token",
    },
    AgentAuthWays {
        agent: "codex",
        var: "OPENAI_API_KEY",
        login_file: ".codex/auth.json",
        login_cmd: "codex login",
    },
    AgentAuthWays {
        agent: "gemini",
        var: "GEMINI_API_KEY",
        login_file: ".gemini/oauth_creds.json",
        login_cmd: "gemini",
    },
];

fn ways_for(agent: &str) -> Option<&'static AgentAuthWays> {
    let a = agent.trim().to_ascii_lowercase();
    AGENTS.iter().find(|w| w.agent == a)
}

/// Map an agent name to the env var it authenticates with.
pub fn env_var_for(agent: &str) -> Option<&'static str> {
    ways_for(agent).map(|w| w.var)
}

/// Every agent name we accept, for error messages.
pub fn known_agents() -> String {
    AGENTS
        .iter()
        .map(|w| w.agent)
        .collect::<Vec<_>>()
        .join(", ")
}

/// What this box has to authenticate one agent with.
///
/// Three answers, not two, because "we found nothing" and "we can't tell" are
/// different facts and only one of them is worth shouting about. A runner that
/// warns on a box which is signed in perfectly well teaches its operator to
/// ignore the warning, which costs more than never having printed it.
pub enum AgentAuth {
    /// Found something, and where it came from.
    Ready(String),
    /// Looked in every place this platform keeps them, and there was nothing.
    Missing,
    /// Can't answer: either we don't know how this agent signs in, or the
    /// platform keeps logins somewhere that reading would prompt a human.
    Undetermined(String),
}

/// A variable set to nothing is what `FOO=` in an env file leaves behind, and
/// it authenticates against nothing — so it must not read as a credential.
fn usable(value: Option<String>) -> Option<String> {
    value.filter(|v| !v.trim().is_empty())
}

/// Where an agent's interactive login lands on this box.
fn login_path(w: &AgentAuthWays) -> Option<PathBuf> {
    let home = std::env::var("HOME").ok()?;
    Some(PathBuf::from(home).join(w.login_file))
}

/// Can this box run `agent` at all?
///
/// Asked once by `aura runner serve` before it starts claiming work. The
/// failure this exists to name is a quiet one: an unauthenticated runner comes
/// up clean, heartbeats `idle`, and then fails every task it claims with "Not
/// logged in · Please run /login" — a message that reaches the task row and
/// nowhere else, so the board shows a healthy machine above a pile of broken
/// work.
pub fn auth_for(agent: &str) -> AgentAuth {
    let Some(w) = ways_for(agent) else {
        return AgentAuth::Undetermined(format!(
            "Aura doesn't know how '{}' signs in — known agents: {}",
            agent.trim(),
            known_agents()
        ));
    };

    if usable(std::env::var(w.var).ok()).is_some() {
        return AgentAuth::Ready(format!("{} is set in this runner's environment", w.var));
    }

    // A key `creds set` wrote. `list` reads the same file the unit loads, so
    // agreeing with it here is what keeps "creds list shows my key" and "the
    // runner can use my key" from being two different questions.
    if list().is_ok_and(|c| c.iter().any(|s| s.agent == w.agent)) {
        return AgentAuth::Ready(format!(
            "a key stored by `aura runner creds set` ({})",
            w.var
        ));
    }

    if let Some(path) = login_path(w) {
        if path.exists() {
            return AgentAuth::Ready(format!("this box is signed in to {} ({})", w.agent, path.display()));
        }
    }

    // macOS keeps agent logins in the Keychain, and reading one would pop a
    // dialog on a machine nobody is sitting at. Saying "missing" there would be
    // a guess dressed as a finding.
    if cfg!(target_os = "macos") {
        return AgentAuth::Undetermined(format!(
            "no key on disk for {}, and macOS keeps logins in the Keychain, which we won't prompt to read",
            w.agent
        ));
    }

    AgentAuth::Missing
}

/// The two commands that fix a box which can't authenticate `agent`, in the
/// order most operators want them: the unattended one first, because a runner
/// is by definition a machine nobody is sitting in front of.
pub fn fix_hint(agent: &str) -> String {
    match ways_for(agent) {
        Some(w) => [
            format!(
                "  aura runner creds set --agent {} --key-stdin   — paste an API key",
                w.agent
            ),
            format!("  {}   — or sign in on this box", w.login_cmd),
        ]
        .join("\n"),
        None => format!("  known agents: {}", known_agents()),
    }
}

/// Where agent keys live: a separate *file* from the runner token, in the same
/// *directory*.
///
/// Separate file because the two have different blast radii. Same directory
/// because that is where the unit loads it from — and a box provisioned by hand
/// keeps its config in `/etc/aura-runner/`, not under `$HOME`. Writing to the
/// wrong one of those is the worst kind of bug: the key lands on disk, `creds
/// list` reports it, and the agent still exits "Not logged in" because the unit
/// was reading a different directory the whole time.
pub fn creds_path() -> Result<PathBuf, String> {
    let home = std::env::var("HOME")
        .map_err(|_| "HOME isn't set, so there's nowhere to store credentials".to_string())?;
    let home = PathBuf::from(home);
    // Follow the runner token if this box already has one; otherwise fall back
    // to the layout the wizard creates, so `creds set` works before `install`.
    // System scope: follow whichever layout this box actually uses. A per-user
    // box still resolves to the member's own file, because that candidate is
    // checked first — so this stays correct on a shared box without needing to
    // know which shape was installed.
    match crate::runner_service::discover_runner_env(
        &home,
        None,
        crate::runner_service::Scope::System,
    ) {
        Ok(env) => Ok(crate::runner_service::agent_env_beside(&env)),
        Err(_) => Ok(home.join(".config/aura/agent.env")),
    }
}

/// Parse `KEY=value` lines, ignoring blanks and `#` comments. Values are taken
/// verbatim after the first `=` so a key containing `=` survives a round trip.
fn parse_env(body: &str) -> BTreeMap<String, String> {
    let mut out = BTreeMap::new();
    for line in body.lines() {
        let line = line.trim();
        if line.is_empty() || line.starts_with('#') {
            continue;
        }
        if let Some((k, v)) = line.split_once('=') {
            let k = k.trim();
            if !k.is_empty() {
                out.insert(k.to_string(), v.to_string());
            }
        }
    }
    out
}

fn render_env(vars: &BTreeMap<String, String>) -> String {
    let mut s = String::from(
        "# Agent credentials for this Aura runner.\n\
         # Written by `aura runner creds set`. Mode 0600 — keep it that way.\n",
    );
    for (k, v) in vars {
        s.push_str(&format!("{k}={v}\n"));
    }
    s
}

/// Store `key` as the credential for `agent`, replacing any previous value.
///
/// Returns the path written, never the key.
pub fn set(agent: &str, key: &str) -> Result<PathBuf, String> {
    let var = env_var_for(agent).ok_or_else(|| {
        format!(
            "don't know how to authenticate '{agent}'. Known agents: {}",
            known_agents()
        )
    })?;
    let key = key.trim();
    if key.is_empty() {
        return Err("that key is empty".to_string());
    }
    // A pasted key that still carries its shell quoting authenticates against
    // nothing and produces a 401 that reads like a bad key.
    if (key.starts_with('"') && key.ends_with('"'))
        || (key.starts_with('\'') && key.ends_with('\''))
    {
        return Err(
            "that key still has its surrounding quotes — paste the key itself".to_string(),
        );
    }
    if key.contains('\n') {
        return Err("that key contains a newline".to_string());
    }

    let path = creds_path()?;
    if let Some(dir) = path.parent() {
        std::fs::create_dir_all(dir).map_err(|e| perm_hint(dir, e, "create"))?;
    }
    let mut vars = match std::fs::read_to_string(&path) {
        Ok(body) => parse_env(&body),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => BTreeMap::new(),
        // Overwriting a file we couldn't read would drop every other agent's
        // key on this box. Stop and say why instead.
        Err(e) => return Err(perm_hint(&path, e, "read")),
    };
    vars.insert(var.to_string(), key.to_string());
    std::fs::write(&path, render_env(&vars)).map_err(|e| perm_hint(&path, e, "write"))?;
    restrict(&path)?;
    Ok(path)
}

/// Forget the credential for `agent`.
pub fn clear(agent: &str) -> Result<bool, String> {
    let var = env_var_for(agent).ok_or_else(|| {
        format!(
            "don't know how to authenticate '{agent}'. Known agents: {}",
            known_agents()
        )
    })?;
    let path = creds_path()?;
    let body = match std::fs::read_to_string(&path) {
        Ok(b) => b,
        // Nothing stored is genuinely nothing to forget.
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(false),
        // A file we can't read is NOT an absent key. Reporting "nothing to
        // forget" here tells someone their key is gone while it sits on the
        // box still authenticating agents — the one answer this command must
        // never give wrongly.
        Err(e) => return Err(perm_hint(&path, e, "read")),
    };
    let mut vars = parse_env(&body);
    let existed = vars.remove(var).is_some();
    if existed {
        std::fs::write(&path, render_env(&vars)).map_err(|e| perm_hint(&path, e, "write"))?;
        restrict(&path)?;
    }
    Ok(existed)
}

/// One configured agent, as `list` reports it.
pub struct CredSummary {
    pub agent: &'static str,
    pub var: &'static str,
    /// Last four characters, for telling two keys apart. Never the whole key.
    pub tail: String,
}

/// Which agents this box can authenticate, without revealing how.
pub fn list() -> Result<Vec<CredSummary>, String> {
    let path = creds_path()?;
    let body = match std::fs::read_to_string(&path) {
        Ok(b) => b,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(Vec::new()),
        // An unreadable file is not an empty one. Listing nothing here reads
        // as "this box has no credentials", which sends you off to set a key
        // that is already sitting there.
        Err(e) => return Err(perm_hint(&path, e, "read")),
    };
    let vars = parse_env(&body);
    Ok(AGENTS
        .iter()
        .filter_map(|w| {
            vars.get(w.var)
                .filter(|v| !v.trim().is_empty())
                .map(|v| CredSummary {
                    agent: w.agent,
                    var: w.var,
                    tail: mask(v),
                })
        })
        .collect())
}

/// Turn a bare permission error into the next thing to type.
///
/// A box provisioned by hand keeps its runner config in `/etc/aura-runner/`,
/// which is root-owned and 0600 — so the natural first attempt fails, and it
/// fails for *reads* as readily as for writes. `creds list` on such a box hit
/// "Permission denied (os error 13)", which is true and useless: it reads as
/// "this is broken" when the answer is one word away.
///
/// `action` is the verb the caller was attempting, so the sentence names what
/// actually failed rather than guessing.
fn perm_hint(path: &std::path::Path, e: std::io::Error, action: &str) -> String {
    if e.kind() == std::io::ErrorKind::PermissionDenied {
        format!(
            "can't {action} {} — it belongs to root on this box.\n\
             Re-run the same command with sudo:  sudo -E aura runner creds …",
            path.display()
        )
    } else {
        format!("couldn't {action} {}: {e}", path.display())
    }
}

/// Show only the last four characters of a secret.
fn mask(v: &str) -> String {
    let n = v.chars().count();
    if n <= 4 {
        return "…".to_string();
    }
    format!("…{}", v.chars().skip(n - 4).collect::<String>())
}

/// Tighten the file to owner-only. On a shared box this is the difference
/// between "my key" and "the box's key".
fn restrict(path: &std::path::Path) -> Result<(), String> {
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o600))
            .map_err(|e| format!("couldn't restrict {}: {e}", path.display()))?;
    }
    let _ = path;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn each_agent_maps_to_the_variable_its_own_cli_reads() {
        assert_eq!(env_var_for("claude"), Some("ANTHROPIC_API_KEY"));
        assert_eq!(env_var_for("Codex"), Some("OPENAI_API_KEY"));
        assert_eq!(env_var_for("gemini"), Some("GEMINI_API_KEY"));
        assert_eq!(env_var_for("cursor"), None);
    }

    #[test]
    fn a_value_containing_equals_survives_a_round_trip() {
        let mut v = BTreeMap::new();
        v.insert("ANTHROPIC_API_KEY".to_string(), "sk-a=b=c".to_string());
        let parsed = parse_env(&render_env(&v));
        assert_eq!(parsed.get("ANTHROPIC_API_KEY").unwrap(), "sk-a=b=c");
    }

    #[test]
    fn comments_and_blank_lines_are_not_credentials() {
        let parsed = parse_env("# a note\n\n  \nFOO=1\n");
        assert_eq!(parsed.len(), 1);
        assert_eq!(parsed.get("FOO").unwrap(), "1");
    }

    #[test]
    fn masking_never_reveals_more_than_the_tail() {
        assert_eq!(mask("sk-ant-0123456789abcd"), "…abcd");
        // Too short to mask meaningfully — show nothing rather than most of it.
        assert_eq!(mask("abcd"), "…");
        assert_eq!(mask("ab"), "…");
    }

    #[test]
    fn a_still_quoted_paste_is_refused_because_it_would_401_confusingly() {
        assert!(set("claude", "\"sk-ant-xyz\"").is_err());
        assert!(set("claude", "'sk-ant-xyz'").is_err());
    }

    #[test]
    fn an_unknown_agent_is_named_along_with_the_ones_we_do_know() {
        let err = set("cursor", "sk-whatever").unwrap_err();
        assert!(err.contains("cursor"));
        assert!(err.contains("claude"));
    }

    /// A box whose unit exports the key directly is authenticated — but `FOO=`
    /// in that unit's env file exports an empty string, which authenticates
    /// against nothing and must not read as a credential. (Tested on the
    /// predicate rather than by setting the variable: mutating the process
    /// environment races every other test in the binary.)
    #[test]
    fn an_exported_key_counts_but_an_empty_one_does_not() {
        assert_eq!(usable(Some("sk-from-the-unit".into())).as_deref(), Some("sk-from-the-unit"));
        assert!(usable(Some("   ".into())).is_none());
        assert!(usable(Some(String::new())).is_none());
        assert!(usable(None).is_none());
    }

    /// "We don't know" must not render as "you have nothing" — the whole point
    /// of the third state is that only a real absence is worth shouting about.
    #[test]
    fn an_agent_we_dont_know_how_to_authenticate_is_undetermined_not_missing() {
        match auth_for("cursor") {
            AgentAuth::Undetermined(why) => {
                assert!(why.contains("cursor"));
                assert!(why.contains("claude"), "it should name the ones we do know");
            }
            _ => panic!("an unknown agent can't be a confident verdict"),
        }
    }

    /// The hint is the whole value of the warning: a runner operator who is
    /// told only that something is wrong still has to go and find out what.
    #[test]
    fn the_fix_names_both_ways_in_to_the_box() {
        let hint = fix_hint("claude");
        assert!(hint.contains("aura runner creds set --agent claude"));
        assert!(hint.contains("claude setup-token"));
    }

    /// The failure a hand-provisioned box actually produces. `/etc/aura-runner/`
    /// is root-owned and 0600, so `creds list` as the runner's own user is
    /// denied — and "Permission denied (os error 13)" reads as a broken install
    /// rather than a missing `sudo`.
    #[test]
    fn a_denied_read_names_sudo_not_the_errno() {
        let denied = std::io::Error::from(std::io::ErrorKind::PermissionDenied);
        let hint = perm_hint(
            std::path::Path::new("/etc/aura-runner/agent.env"),
            denied,
            "read",
        );
        assert!(hint.contains("sudo"), "the fix is the point: {hint}");
        assert!(hint.contains("/etc/aura-runner/agent.env"));
        assert!(hint.contains("read"), "it should name what failed: {hint}");
    }

    /// Anything that isn't a permission problem still has to say what went
    /// wrong — swallowing the cause behind "try sudo" would send someone to
    /// re-run a command that was never going to work.
    #[test]
    fn other_failures_keep_their_own_reason() {
        let broken = std::io::Error::from(std::io::ErrorKind::InvalidData);
        let msg = perm_hint(std::path::Path::new("/etc/aura-runner/agent.env"), broken, "read");
        assert!(!msg.contains("sudo"), "not a permission problem: {msg}");
        assert!(msg.contains("couldn't read"));
    }
}
