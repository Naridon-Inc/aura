//! What a remote *is* — the host it lives on, whether it can be reached in the
//! clear, and which service answers there.
//!
//! Split out of [`super::place_git`] rather than added to it, because they
//! answer different questions and only one of them is about credentials.
//! `place_git` decides *whose* token a push spends; this decides *what a token
//! has to look like on the wire* to be spent at all.
//!
//! ## Why the service has to be a fact and not an assumption
//!
//! Git's HTTP credential protocol has two halves, a username and a password,
//! and every forge spends the token in the password half. What none of them
//! agree on is the username:
//!
//! | | what git must send |
//! |---|---|
//! | GitHub | `x-access-token` |
//! | GitLab | `oauth2` |
//! | Bitbucket | `x-token-auth` |
//! | Gitea / Forgejo / anything self-hosted | the person's own account name |
//!
//! A token sent under the wrong username is not a smaller credential, it is a
//! `401` — and a `401` from a remote that worked yesterday reads to everybody
//! downstream as "the token is bad", which sends a member off to mint another
//! one that will fail in exactly the same way. So the username is derived from
//! the service, the service is recorded next to the secret
//! ([`super::secret_vault::Held::for_git_on`]), and a host nobody can place is
//! asked about rather than guessed at.
//!
//! ## Why the host heuristic is a default and never a decision
//!
//! [`Forge::of_host`] knows the three public hosts and reads a self-hosted one
//! off its own name — `gitlab.acme.com` is a GitLab, and saying so saves the
//! ninety percent of installs that are spelled that way from having to be told.
//! A name it cannot place is [`Forge::Unknown`], which is honest: it means "ask
//! the member", not "assume GitHub". Anything explicit always wins, because the
//! person adding the credential knows what they are pointing at and this file
//! only ever guesses.

use serde::{Deserialize, Serialize};

/// Longest remote this will look at. A git remote is a URL; anything past this
/// is not one, and parsing it would only ever fail slower.
const REMOTE_MAX_LEN: usize = 512;

/// Which service answers at a host.
///
/// A closed set on purpose. [`Unknown`](Forge::Unknown) is a real member of it
/// rather than an error case — most self-hosted git servers are some fork of
/// something, and the only thing this file needs from them is that they take
/// the account name as the username, which is what `Unknown` says.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Forge {
    GitHub,
    GitLab,
    Bitbucket,
    /// Gitea and Forgejo, which is a fork of it and authenticates the same way.
    Gitea,
    /// A git server nothing here can place. Not a failure — a question.
    Unknown,
}

impl Forge {
    /// The stable id. What goes in a vault file, in a `SecretRef`, and over the
    /// wire to the frontend.
    pub fn id(&self) -> &'static str {
        match self {
            Forge::GitHub => "github",
            Forge::GitLab => "gitlab",
            Forge::Bitbucket => "bitbucket",
            Forge::Gitea => "gitea",
            Forge::Unknown => "unknown",
        }
    }

    /// What to call it in a sentence a person reads.
    pub fn label(&self) -> &'static str {
        match self {
            Forge::GitHub => "GitHub",
            Forge::GitLab => "GitLab",
            Forge::Bitbucket => "Bitbucket",
            Forge::Gitea => "Gitea",
            Forge::Unknown => "a self-hosted git server",
        }
    }

    /// The service's name when it has one, for a sentence that reads badly with
    /// "a self-hosted git server" dropped into the middle of it.
    pub fn named(&self) -> Option<&'static str> {
        match self {
            Forge::Unknown => None,
            other => Some(other.label()),
        }
    }

    /// The username git must send, when the service fixes it.
    ///
    /// `None` means the service authenticates the *person*, so the username is
    /// their account name and nothing here can know it.
    pub fn fixed_user(&self) -> Option<&'static str> {
        match self {
            Forge::GitHub => Some("x-access-token"),
            Forge::GitLab => Some("oauth2"),
            Forge::Bitbucket => Some("x-token-auth"),
            Forge::Gitea | Forge::Unknown => None,
        }
    }

    /// Does storing a credential for this service need somebody to say which
    /// account it belongs to?
    pub fn needs_account_name(&self) -> bool {
        self.fixed_user().is_none()
    }

    /// The username to send, given what was asked for.
    ///
    /// The order is the whole rule: what a person said, then what the service
    /// insists on, then nothing — and "nothing" is a question for the caller
    /// rather than a default this file invents.
    pub fn username(&self, explicit: Option<&str>) -> Option<String> {
        explicit
            .map(str::trim)
            .filter(|u| !u.is_empty())
            .map(str::to_string)
            .or_else(|| self.fixed_user().map(str::to_string))
    }

    /// A variable name that will read as the right one in a boot line. Only ever
    /// a suggestion — a member may call their token whatever they like.
    pub fn suggested_env_name(&self) -> &'static str {
        match self {
            Forge::GitHub => "GITHUB_TOKEN",
            Forge::GitLab => "GITLAB_TOKEN",
            Forge::Bitbucket => "BITBUCKET_TOKEN",
            Forge::Gitea => "GITEA_TOKEN",
            Forge::Unknown => "GIT_TOKEN",
        }
    }

    /// A service named by its id, or by one of the spellings people actually
    /// type. `None` for anything else — a misspelled service is not `Unknown`,
    /// it is a typo, and treating it as "self-hosted" would silently send the
    /// account name where `oauth2` was meant.
    pub fn parse(name: &str) -> Option<Self> {
        match name.trim().to_ascii_lowercase().replace(['-', ' '], "_").as_str() {
            "github" | "github_enterprise" | "ghes" => Some(Forge::GitHub),
            "gitlab" | "gitlab_ce" | "gitlab_ee" => Some(Forge::GitLab),
            "bitbucket" | "bitbucket_server" | "bitbucket_cloud" => Some(Forge::Bitbucket),
            "gitea" | "forgejo" | "codeberg" => Some(Forge::Gitea),
            "unknown" | "self_hosted" | "generic" | "other" => Some(Forge::Unknown),
            _ => None,
        }
    }

    /// The service a host is, as far as its name gives it away.
    ///
    /// The three public hosts by name, and a self-hosted one by any label in it
    /// being the service's own name — `gitlab.acme.com`, `git.gitea.acme.io`.
    /// `mygitlab.acme.com` is deliberately NOT a match: a label that merely
    /// contains the word is somebody else's host as often as it is a forge, and
    /// a wrong guess here is a `401` nobody can read backwards.
    pub fn of_host(host: &str) -> Self {
        let h = host.trim().trim_end_matches('.').to_ascii_lowercase();
        match h.as_str() {
            "github.com" | "www.github.com" => return Forge::GitHub,
            "gitlab.com" | "www.gitlab.com" => return Forge::GitLab,
            "bitbucket.org" | "www.bitbucket.org" => return Forge::Bitbucket,
            // Forgejo's own flagship, and the one self-hosted instance common
            // enough to be worth knowing by name.
            "codeberg.org" => return Forge::Gitea,
            _ => {}
        }
        for label in h.split('.') {
            match label {
                "github" => return Forge::GitHub,
                "gitlab" => return Forge::GitLab,
                "bitbucket" => return Forge::Bitbucket,
                "gitea" | "forgejo" => return Forge::Gitea,
                _ => {}
            }
        }
        Forge::Unknown
    }

    /// The service somebody named, or the one the host gives away.
    ///
    /// An unreadable name is an error rather than a fallback to the host: a
    /// caller who bothered to say which service this is has an expectation, and
    /// quietly using a different answer than the one they typed is how a
    /// credential ends up spent under the wrong username.
    pub fn named_or_of_host(named: Option<&str>, host: &str) -> Result<Self, String> {
        match named.map(str::trim).filter(|n| !n.is_empty()) {
            Some(n) => Forge::parse(n).ok_or_else(|| {
                format!("{n:?} isn't a git service this knows — try github, gitlab, bitbucket, gitea, or leave it out.")
            }),
            None => Ok(Forge::of_host(host)),
        }
    }
}

/// The host a remote lives on — what a credential is keyed by.
///
/// Three spellings, because git takes three: `https://host/a/b`,
/// `ssh://git@host:22/a/b` and `git@host:a/b`. Userinfo is dropped rather than
/// parsed: `https://x-access-token:ghp_…@github.com/a/b` is a URL with a secret
/// in it, and the secret is not part of the host.
pub fn remote_host(remote: &str) -> Option<String> {
    let r = remote.trim();
    if r.is_empty() || r.len() > REMOTE_MAX_LEN {
        return None;
    }
    let rest = match r.split_once("://") {
        Some((_, rest)) => rest,
        // `git@github.com:you/repo.git` — scp syntax, no scheme.
        None => {
            let (before, _) = r.split_once(':')?;
            let host = before.rsplit('@').next().unwrap_or(before);
            return valid_host(host);
        }
    };
    let authority = rest.split(['/', '?', '#']).next().unwrap_or("");
    let host = authority.rsplit('@').next().unwrap_or(authority);
    // A port is not part of the identity of the host we hold a credential for.
    let host = host.split(':').next().unwrap_or(host);
    valid_host(host)
}

/// Does an ssh remote push here? Then there is no helper to choose.
pub fn is_ssh_remote(remote: &str) -> bool {
    let r = remote.trim();
    r.starts_with("ssh://") || (!r.contains("://") && r.contains(':'))
}

/// Would a credential sent to this remote cross the wire readable?
///
/// `http://` and `git://` both would. This matters most for exactly the remotes
/// this module exists for: a self-hosted forge on an internal network is the one
/// people leave on plain http, and it is also the one whose token Aura is now
/// holding on their behalf. Handing a member's own credential to a cleartext
/// remote would be this feature spending a secret worse than the shared box
/// credential it replaces.
pub fn is_plaintext(remote: &str) -> bool {
    let r = remote.trim().to_ascii_lowercase();
    r.starts_with("http://") || r.starts_with("git://")
}

fn valid_host(host: &str) -> Option<String> {
    let h = host.trim().trim_end_matches('.');
    let ok = !h.is_empty()
        && h.len() <= 255
        && h.chars()
            .all(|c| c.is_ascii_alphanumeric() || matches!(c, '.' | '-' | '_'));
    ok.then(|| h.to_ascii_lowercase())
}

/// What a surface needs to know before somebody types a token in.
///
/// One round trip that answers "what is this remote, and what will git call me
/// there", so the frontend never has to keep its own copy of the table at the
/// top of this file. A copy would agree until the day one of the forges changed
/// its mind.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct ForgeAdvice {
    /// The remote as it was asked about.
    pub remote: String,
    /// The host a credential for it is keyed by.
    pub host: String,
    /// See [`Forge::id`].
    pub forge: String,
    /// See [`Forge::label`].
    pub label: String,
    /// The username git will send, when the service fixes it. `None` means the
    /// member's own account name is used, and a surface should ask for it.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub git_user: Option<String>,
    /// Does this need somebody to say which account the token belongs to?
    pub needs_account_name: bool,
    /// A variable name that will read right in a boot line.
    pub suggested_name: String,
    /// Would a push here send the credential in the clear? Then no brokered
    /// credential is offered for it — see [`is_plaintext`].
    pub plaintext: bool,
    /// Does this remote authenticate with a key rather than a stored
    /// credential? Then there is nothing to keep.
    pub ssh: bool,
}

/// Read a remote for everything the credential surfaces need from it.
pub fn advise(remote: &str) -> Result<ForgeAdvice, String> {
    let host = remote_host(remote)
        .ok_or_else(|| format!("{} isn't a git remote.", remote.trim()))?;
    let forge = Forge::of_host(&host);
    Ok(ForgeAdvice {
        remote: remote.trim().to_string(),
        forge: forge.id().to_string(),
        label: forge.label().to_string(),
        git_user: forge.fixed_user().map(str::to_string),
        needs_account_name: forge.needs_account_name(),
        suggested_name: forge.suggested_env_name().to_string(),
        plaintext: is_plaintext(remote),
        ssh: is_ssh_remote(remote),
        host,
    })
}

/// What service a remote is, and what git will call the member there.
///
/// Asked before a member is shown a field to type a token into, so the surface
/// can say "GitLab — this will be sent as `oauth2`" rather than taking a token
/// and finding out at the first push.
#[tauri::command]
pub fn place_git_forge(remote: String) -> Result<ForgeAdvice, String> {
    advise(&remote)
}

#[cfg(test)]
mod tests {
    use super::*;

    // -- the host -----------------------------------------------------------

    #[test]
    fn a_remote_names_the_host_a_credential_is_keyed_by() {
        assert_eq!(remote_host("https://github.com/a/b.git").unwrap(), "github.com");
        assert_eq!(remote_host("git@github.com:a/b.git").unwrap(), "github.com");
        assert_eq!(remote_host("ssh://git@git.example.com:22/a/b").unwrap(), "git.example.com");
        // A secret in the URL is not part of the host.
        assert_eq!(
            remote_host("https://x-access-token:ghp_secret@github.com/a/b").unwrap(),
            "github.com"
        );
        assert_eq!(remote_host("HTTPS://GitHub.com/a/b"), Some("github.com".into()));
        // A self-hosted forge on a port is still one host, not two.
        assert_eq!(
            remote_host("https://git.acme.internal:8443/team/app.git").unwrap(),
            "git.acme.internal"
        );
    }

    #[test]
    fn a_host_that_could_carry_a_command_is_not_a_host() {
        assert!(remote_host("https://a b/c").is_none());
        assert!(remote_host("https://$(id)/c").is_none());
        assert!(remote_host("rm -rf /").is_none());
        assert!(remote_host("").is_none());
        assert!(remote_host(&format!("https://{}/a/b", "h".repeat(600))).is_none());
    }

    #[test]
    fn a_remote_that_goes_in_the_clear_says_so() {
        assert!(is_plaintext("http://git.acme.internal/team/app.git"));
        assert!(is_plaintext("GIT://git.acme.internal/team/app.git"));
        assert!(!is_plaintext("https://git.acme.internal/team/app.git"));
        assert!(!is_plaintext("git@git.acme.internal:team/app.git"));
    }

    // -- the service --------------------------------------------------------

    #[test]
    fn the_three_public_forges_are_known_by_name() {
        assert_eq!(Forge::of_host("github.com"), Forge::GitHub);
        assert_eq!(Forge::of_host("GitLab.com"), Forge::GitLab);
        assert_eq!(Forge::of_host("bitbucket.org"), Forge::Bitbucket);
        assert_eq!(Forge::of_host("codeberg.org"), Forge::Gitea);
    }

    #[test]
    fn a_self_hosted_forge_is_read_off_its_own_name() {
        // The ninety percent of installs that are spelled the obvious way.
        assert_eq!(Forge::of_host("gitlab.acme.com"), Forge::GitLab);
        assert_eq!(Forge::of_host("bitbucket.acme.co.uk"), Forge::Bitbucket);
        assert_eq!(Forge::of_host("gitea.internal"), Forge::Gitea);
        assert_eq!(Forge::of_host("git.forgejo.acme.io"), Forge::Gitea);
        assert_eq!(Forge::of_host("github.acme.com"), Forge::GitHub);
    }

    #[test]
    fn a_host_nobody_can_place_is_a_question_rather_than_a_guess() {
        // The failure this avoids: assuming GitHub, sending `x-access-token`,
        // and getting a 401 that reads like a bad token.
        assert_eq!(Forge::of_host("git.acme.internal"), Forge::Unknown);
        assert_eq!(Forge::of_host("code.example.org"), Forge::Unknown);
        // A label that merely contains the word is somebody else's host.
        assert_eq!(Forge::of_host("mygitlab.acme.com"), Forge::Unknown);
        assert!(Forge::Unknown.needs_account_name());
        assert!(Forge::Unknown.named().is_none());
    }

    #[test]
    fn every_forge_says_what_git_must_call_you() {
        // The whole reason this module exists. A token under the wrong username
        // is a 401, not a smaller credential.
        assert_eq!(Forge::GitHub.fixed_user(), Some("x-access-token"));
        assert_eq!(Forge::GitLab.fixed_user(), Some("oauth2"));
        assert_eq!(Forge::Bitbucket.fixed_user(), Some("x-token-auth"));
        // Gitea authenticates the person, so only they can say.
        assert_eq!(Forge::Gitea.fixed_user(), None);
        assert!(Forge::Gitea.needs_account_name());
        assert!(!Forge::GitLab.needs_account_name());
    }

    #[test]
    fn what_somebody_said_beats_what_the_service_prefers() {
        assert_eq!(Forge::GitLab.username(Some("mo")).unwrap(), "mo");
        assert_eq!(Forge::GitLab.username(Some("   ")).unwrap(), "oauth2");
        assert_eq!(Forge::GitLab.username(None).unwrap(), "oauth2");
        assert_eq!(Forge::Unknown.username(None), None);
        assert_eq!(Forge::Unknown.username(Some("mo")).unwrap(), "mo");
    }

    #[test]
    fn a_named_service_wins_and_a_misspelled_one_is_refused() {
        // `git.acme.internal` is unplaceable, so naming it is the only way a
        // self-hosted GitLab gets `oauth2` instead of an account name.
        let forge = Forge::named_or_of_host(Some("gitlab"), "git.acme.internal").unwrap();
        assert_eq!(forge, Forge::GitLab);
        assert_eq!(forge.fixed_user(), Some("oauth2"));
        // Spelling variants people actually type.
        assert_eq!(Forge::parse("GitHub Enterprise"), Some(Forge::GitHub));
        assert_eq!(Forge::parse("bitbucket-server"), Some(Forge::Bitbucket));
        assert_eq!(Forge::parse("forgejo"), Some(Forge::Gitea));
        // And a typo is an error rather than a quiet fallback to the host,
        // which would spend the credential under a username nobody chose.
        let err = Forge::named_or_of_host(Some("gitlub"), "gitlab.com").unwrap_err();
        assert!(err.contains("gitlub"), "{err}");
        assert_eq!(Forge::named_or_of_host(None, "gitlab.com").unwrap(), Forge::GitLab);
    }

    // -- the advice ---------------------------------------------------------

    #[test]
    fn a_surface_is_told_what_a_remote_will_call_the_member() {
        let gl = advise("https://gitlab.com/team/app.git").expect("advice");
        assert_eq!(gl.host, "gitlab.com");
        assert_eq!(gl.forge, "gitlab");
        assert_eq!(gl.label, "GitLab");
        assert_eq!(gl.git_user.as_deref(), Some("oauth2"));
        assert!(!gl.needs_account_name);
        assert_eq!(gl.suggested_name, "GITLAB_TOKEN");
        assert!(!gl.plaintext && !gl.ssh);

        let bb = advise("https://bitbucket.org/team/app.git").expect("advice");
        assert_eq!(bb.git_user.as_deref(), Some("x-token-auth"));
        assert_eq!(bb.suggested_name, "BITBUCKET_TOKEN");

        // A self-hosted one asks rather than assumes.
        let own = advise("https://git.acme.internal/team/app.git").expect("advice");
        assert_eq!(own.forge, "unknown");
        assert!(own.needs_account_name);
        assert_eq!(own.git_user, None);

        // And the two shapes a credential must not be typed into at all.
        assert!(advise("http://git.acme.internal/team/app.git").unwrap().plaintext);
        assert!(advise("git@git.acme.internal:team/app.git").unwrap().ssh);
        assert!(advise("rm -rf /").is_err());
    }

    #[test]
    fn the_advice_carries_no_secret_because_it_never_had_one() {
        let json = serde_json::to_string(&advise("https://gitlab.com/a/b").unwrap()).unwrap();
        assert!(!json.contains("token="), "{json}");
        assert!(json.contains("oauth2"), "{json}");
    }

    /// The governing rule of this programme, made structural rather than
    /// remembered: no feature may land in one place-mode only. Nothing in here
    /// can tell a box you brought from one Aura provisioned, because there is
    /// nothing in here to tell it with.
    #[test]
    fn reading_a_remote_never_asks_what_kind_of_place_this_is() {
        let src = include_str!("place_forge.rs");
        let code = src
            .lines()
            .take_while(|l| !l.starts_with("#[cfg(test)]"))
            .filter(|l| !l.trim_start().starts_with("//") && !l.trim_start().starts_with("//!"))
            .collect::<Vec<_>>()
            .join("\n");
        for asked in ["box_kind", "managed", "provisioning_mode", "is_byoc"] {
            assert!(
                !code.contains(asked),
                "place_forge branches on `{asked}` — one place-mode is about to get a \
                 credential arrangement the other doesn't"
            );
        }
    }
}
