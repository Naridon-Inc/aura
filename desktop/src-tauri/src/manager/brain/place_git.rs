//! Which credential a place pushes with, and who chose it.
//!
//! The ninth question in the runtime contract, and the one nobody was asking:
//! **when this member pushes to this remote from this place, whose token goes
//! over the wire?**
//!
//! ## What "inherit whatever the box has" actually meant
//!
//! `aura-runner/aws/provision.sh` pipes the operator's own `gh auth token` into
//! `~/.git-credentials` on the box and runs `git config --global
//! credential.helper store`. One token, one file, one OS user, for the whole
//! machine — and [`Place::clone_project`] ran a bare `git clone` that named no
//! credential at all, so it silently used that one. Two consequences, both
//! quiet: every push from that box is attributed to whoever provisioned it, and
//! a member who *does* have a credential of their own has no way to say so.
//!
//! That shared credential is not being removed. It is impl zero
//! ([`PlaceDefault`]) — it keeps working exactly as it did, it is just no longer
//! the *silent* default. It answers last, it is labelled as what it is, and
//! every surface that spends it can now say whose it is before it does.
//!
//! ## Why a seam before a mechanism
//!
//! There are at least four sources a push credential can come from: the token
//! already on the box, a per-member store in a member's own home, a credential
//! Aura mints for a managed place, and whatever an org's SSO hands out. Written
//! as four call sites, the fourth is a redesign. Written against
//! [`CredentialSource`], the fourth is one `impl` and one line in [`sources`].
//!
//! So this file is a contract first:
//!
//! * the ask — [`CredentialAsk`], `(member, remote)`
//! * the answer — [`GitCredential`], and how git is told about it
//! * the named failure — [`NoCredential`], never a bare string
//! * the chain — [`sources`], with last-resort sources forced to the end by
//!   [`choose`] rather than by whoever edits the list next
//!
//! ## Why the sources are pure
//!
//! Every source decides from [`PlaceGitFacts`] — one survey, one round trip,
//! read off the place through [`Place::ask`] like every other verb here. A
//! source that reached the place itself would be a second door to the wire (see
//! [`crate::cloudbox::sole_ssh`]) and would also cost a round trip each, on a
//! box across an ocean. A future source whose material comes from somewhere
//! else entirely — a minted token, a keychain on this laptop — is handed that
//! material at construction time, in [`sources`], where the asking is allowed to
//! happen.

use serde::{Deserialize, Serialize};

use super::place::Place;
use super::place_account::is_bootstrap_login;
use super::place_forge::{is_plaintext, is_ssh_remote, Forge};
use crate::cloudbox::script::quote;

/// Reading a remote — what host it names, and what service answers there —
/// lives in [`super::place_forge`]. Re-exported because every caller of this
/// module that has a remote wants the host it is keyed by, and a second import
/// for one function would only invite a second implementation of it.
pub use super::place_forge::remote_host;

/// Marks the start of the survey the script prints. Split in the rendered
/// script for the same reason [`super::place_account`] splits its own: a line
/// that contains its own marker matches itself.
const SURVEY: &str = "___AURA_GITCRED___";

/// Who is pushing, and where to.
///
/// Two fields because a credential is only ever meaningful as a pair. A token
/// without a remote is a secret looking for somewhere to be spent; a remote
/// without a member is the bug this whole file is about.
#[derive(Debug, Clone, PartialEq)]
pub struct CredentialAsk {
    /// The login the work runs as here — the member, not the machine.
    pub member: String,
    /// The remote as git would be given it.
    pub remote: String,
    /// The host that remote lives on, which is what a credential is keyed by.
    pub host: String,
    /// Would a credential sent here cross the wire readable? A fact about the
    /// remote rather than a judgement about it, so a source that is willing to
    /// answer anyway still can — see [`super::place_forge::is_plaintext`].
    pub plaintext: bool,
    /// Does git reach this remote over ssh?
    ///
    /// The one fact that splits the sources cleanly in two, and it is on the
    /// ask rather than re-derived by each of them. A stored credential is
    /// consulted for `https://` and never for ssh; a key in an agent is the
    /// reverse. Without this every source would have to know the rule, and the
    /// first one to get it wrong would offer a token to a push that cannot
    /// spend it — which reads on screen as "you are pushing as yourself" while
    /// the box's own key goes over the wire.
    pub ssh: bool,
}

impl CredentialAsk {
    /// The ask, with the host worked out from the remote.
    pub fn new(member: &str, remote: &str) -> Result<Self, NoCredential> {
        let member = member.trim().to_string();
        if member.is_empty() {
            return Err(NoCredential::NoMember);
        }
        let remote = remote.trim().to_string();
        let host = remote_host(&remote).ok_or_else(|| NoCredential::NotARemote {
            remote: remote.clone(),
        })?;
        Ok(CredentialAsk {
            plaintext: is_plaintext(&remote),
            ssh: is_ssh_remote(&remote),
            member,
            remote,
            host,
        })
    }

    /// The service that answers at this host, as far as its name gives it away.
    pub fn forge(&self) -> Forge {
        Forge::of_host(&self.host)
    }
}

/// What a place will push with.
///
/// `helper` is the whole mechanism, deliberately: git's credential helpers are
/// already the seam the rest of the world uses, so a source that has a token in
/// a file, a token in a keychain, or a program that mints one on demand all
/// describe themselves in one field, and nothing here has to grow a case for
/// them. What this type adds is the two facts git has no opinion about — whose
/// credential it is, and whether it was the only one left.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct GitCredential {
    /// Which implementation answered.
    pub source: String,
    /// What to put on screen before spending it.
    pub label: String,
    /// The value for `credential.helper`, as git spells one.
    pub helper: String,
    /// Where it came from, in the place's own words.
    pub detail: String,
    /// The host it is good for.
    pub host: String,
    /// Is this credential everybody-on-this-place's rather than this member's?
    pub shared: bool,
    /// Was this only reached because nothing else answered?
    pub last_resort: bool,
}

impl GitCredential {
    /// How to tell one `git` invocation to use this and nothing else.
    ///
    /// The empty helper first is the point of the whole file. `credential.helper`
    /// is a *list*, and a value appended to it is consulted after whatever the
    /// box already configured — so naming ours without clearing first would let
    /// the shared box credential answer first anyway, and we would have changed
    /// nothing except the amount of code. An empty value resets the list; ours
    /// is then the only one git asks.
    ///
    /// A credential with no helper — a key in an ssh agent — configures nothing,
    /// because there is nothing for git to configure: the key is spent by ssh,
    /// not by a helper. Clearing `credential.helper` for it would be worse than
    /// doing nothing, since a repository with both an ssh remote and an https
    /// one would lose the credential for the second.
    pub fn git_config_args(&self) -> Vec<String> {
        if self.helper.trim().is_empty() {
            return vec![];
        }
        vec![
            "-c".into(),
            "credential.helper=".into(),
            "-c".into(),
            format!("credential.helper={}", self.helper),
        ]
    }
}

/// Why this place has no credential for this ask.
///
/// A named failure rather than a string, because two of these are not failures
/// at all in the sense a caller cares about: an ssh remote pushes with a key and
/// wants no helper, and a place with nothing configured needs a person to go and
/// configure one. A caller that could only see `Err(String)` would render all
/// four as "something went wrong".
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "gap", rename_all = "snake_case")]
pub enum NoCredential {
    /// Nobody was named. A credential is per person or it is the bug this file
    /// exists about.
    NoMember,
    /// Not something git would push to.
    NotARemote { remote: String },
    /// An ssh remote authenticates with a key, not a stored credential — and no
    /// key of this member's was reachable from this place, so the push spends
    /// whatever key the place itself has. Nothing broken; just not yours.
    PushesWithAnSshKey { host: String },
    /// Every source was asked and none of them holds one.
    NoneHeld {
        host: String,
        /// Which sources were asked, so the answer names what was tried rather
        /// than implying there is only one way to have a credential.
        tried: Vec<String>,
    },
}

impl std::fmt::Display for NoCredential {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            NoCredential::NoMember => write!(
                f,
                "Nobody is named as the one pushing, so there is no credential to look for."
            ),
            NoCredential::NotARemote { remote } => {
                write!(f, "{remote} isn't a git remote this can find a credential for.")
            }
            NoCredential::PushesWithAnSshKey { host } => write!(
                f,
                "A push to {host} goes over ssh, and no key of yours is reachable from this \
                 place — so it uses the place's own ssh key rather than yours."
            ),
            NoCredential::NoneHeld { host, tried } => write!(
                f,
                "Nothing here holds a credential for {host} — asked: {}.",
                tried.join(", ")
            ),
        }
    }
}

/// What the place said about itself, once, for every source to read.
///
/// Facts, not judgements: whether a file exists and who owns it is the place's
/// business, whether that makes the credential *yours* is a source's. Keeping
/// the two apart is what lets a source be tested without a machine and a survey
/// be trusted without reading the sources.
#[derive(Debug, Clone, Default, PartialEq)]
pub struct PlaceGitFacts {
    /// What to call this place in a sentence — "this laptop", or the box's name.
    pub place: String,
    /// The login the survey ran as.
    pub you: String,
    /// Does the member have an account here at all?
    pub member_present: bool,
    /// The member's own credential store, as this place spells the path.
    pub member_store: StoreFile,
    /// `credential.helper` as this place has it configured, raw. Empty when
    /// none is set.
    pub helper: String,
    /// Where that setting came from — `git config --show-origin`'s first field.
    /// Empty when there is no helper.
    pub helper_origin: String,
    /// The file that helper reads, when it is a `store` helper. Absent
    /// otherwise: a keychain helper has no file, and inventing a path for it
    /// would be a lie a later surface would try to open.
    pub default_store: StoreFile,
    /// The ssh agent this place can reach, if any.
    pub agent: AgentFacts,
}

/// The ssh agent reachable from the place, as the place found it.
///
/// A fact, not a setting — which is the whole reason forwarding is served here
/// rather than by reading the machine book. On this laptop this is your own
/// agent, sitting where it always was. On a box it is your agent *only* because
/// the connection carrying this very survey forwarded it, which is the same
/// thing observed from the other end. Neither arm has to be told which it is,
/// and neither can be right about one and wrong about the other.
#[derive(Debug, Clone, Default, PartialEq)]
pub struct AgentFacts {
    /// The socket `SSH_AUTH_SOCK` pointed at. Empty when there was none.
    pub socket: String,
    /// Did the agent answer when asked what it holds? A socket that is there
    /// but dead is the ordinary shape of a stale forwarding, and it must not
    /// read as a working one.
    pub reachable: bool,
    /// How many keys it offered. Zero with `reachable` is an agent running with
    /// nothing loaded — real, and no use for a push.
    pub keys: usize,
    /// The fingerprints of those keys, as `ssh-add -l` prints them.
    ///
    /// Not decoration. An agent reachable from a box is *usually* the member's,
    /// forwarded — but a box can run an agent of its own, and a push signed by
    /// that one would go out under whatever key the machine holds while every
    /// surface said "your own key". A fingerprint is the only thing that can
    /// tell the two apart, and it is public: it identifies a key without being
    /// one, so it crosses the wire the way a name does and not the way a secret
    /// does.
    pub fingerprints: Vec<String>,
    /// Is at least one of those keys one this laptop's own agent holds?
    ///
    /// Filled in by [`Place::push_credential`] rather than by the survey, because
    /// it is the one fact that cannot be read from a single end of a connection:
    /// it is the comparison between the two.
    pub mine: bool,
}

impl AgentFacts {
    /// Could a push actually be signed by it?
    pub fn usable(&self) -> bool {
        self.reachable && self.keys > 0 && !self.socket.is_empty()
    }

    /// Do these two agents hold a key in common?
    pub fn shares_a_key_with(&self, other: &[String]) -> bool {
        self.fingerprints
            .iter()
            .any(|fp| other.iter().any(|mine| mine == fp))
    }
}

/// One credential-store file, as the place found it.
#[derive(Debug, Clone, Default, PartialEq)]
pub struct StoreFile {
    /// Empty when there is no such candidate at all.
    pub path: String,
    /// Is the file there? `false` also covers "there, but we are not allowed to
    /// look" — which [`holds`] distinguishes.
    pub exists: bool,
    /// Does it hold a line for the host we asked about? `None` is "we could not
    /// read it", which is a different answer from "no" and must not be rounded
    /// down to one — a member's own store is 0600 in a 0700 home, so a survey
    /// run as somebody else *should* land here.
    pub holds: Option<bool>,
    /// `ls -l`'s first field, e.g. `-rw-------`.
    pub mode: String,
    /// The login that owns it.
    pub owner: String,
}

impl StoreFile {
    /// Only the owner can read it — which is what makes a credential one
    /// person's rather than the box's.
    pub fn private(&self) -> bool {
        let m = self.mode.as_bytes();
        // `-rw-------`: everything past the owner's three bits is off.
        m.len() >= 10 && m[4..10].iter().all(|c| *c == b'-')
    }

    /// It is there and it holds a line for the host we asked about.
    pub fn usable(&self) -> bool {
        self.exists && self.holds == Some(true)
    }

    /// How git is told to read this particular file.
    pub fn helper(&self) -> String {
        format!("store --file={}", self.path)
    }
}

/// One way of having a credential.
///
/// Sources are pure and synchronous on purpose — see the module docs. A source
/// answers from what the place already said, or says why it cannot, and the
/// "why" is shown to the person rather than swallowed: "there is no account for
/// you on this box yet" and "your store has nothing for github.com" send someone
/// to two different places.
pub trait CredentialSource: Send + Sync {
    /// Stable id, used in reports and in the failure's `tried` list.
    fn id(&self) -> &'static str;

    /// Is this a credential of last resort — one that works, but only because
    /// there is nothing more specific? [`choose`] moves these to the end
    /// whatever order [`sources`] happens to list them in.
    fn last_resort(&self) -> bool {
        false
    }

    /// The credential, or the reason there isn't one.
    fn offer(&self, ask: &CredentialAsk, facts: &PlaceGitFacts) -> Result<GitCredential, String>;
}

/// The member's own key, held by an agent, never written down here.
///
/// The one source whose material is not on the place at all. An agent answers
/// "sign this" and nothing else — it will not hand over the key, so a push can
/// be made *as the member* without the member's key ever existing as bytes on a
/// machine they share, or on a machine they do not own.
///
/// It is not a place-mode feature. On this laptop the agent is simply there; on
/// a box it is there because the member opted that box into forwarding, and the
/// connection carrying this survey is the one carrying the agent. Both arms
/// discover it the same way — by asking — so neither can grow the ability
/// separately, and a box that was never opted in reports no agent and this
/// source declines. That is the off-by-default, observed rather than trusted.
pub struct ForwardedAgent;

impl CredentialSource for ForwardedAgent {
    fn id(&self) -> &'static str {
        "ssh-agent"
    }

    fn offer(&self, ask: &CredentialAsk, facts: &PlaceGitFacts) -> Result<GitCredential, String> {
        if !ask.ssh {
            return Err(format!(
                "a push to {} goes over https, which spends a credential rather than a key.",
                ask.host
            ));
        }
        let agent = &facts.agent;
        if agent.socket.is_empty() {
            return Err(format!(
                "no ssh agent of yours reaches {} — the push would use the key {} itself has.",
                facts.place, facts.place
            ));
        }
        if !agent.reachable {
            return Err(format!(
                "there is an agent socket on {} but nothing is answering on it, so no key of \
                 yours can sign this push.",
                facts.place
            ));
        }
        if agent.keys == 0 {
            return Err(format!(
                "the agent reaching {} is holding no keys — run `ssh-add` on this laptop and \
                 ask again.",
                facts.place
            ));
        }
        if !agent.mine {
            // A box running an agent of its own. It would sign, and the push
            // would land under the machine's key while this said it was the
            // member's — which is the bug this whole file exists about, wearing
            // a fix's clothes.
            return Err(format!(
                "the agent on {} holds no key this laptop holds, so it is the machine's key \
                 rather than yours.",
                facts.place
            ));
        }
        Ok(GitCredential {
            source: self.id().into(),
            label: format!(
                "{}'s own ssh key, offered by an agent rather than stored on {}",
                ask.member, facts.place
            ),
            // Nothing for git to configure: ssh spends the key, and a helper
            // would only get in the way of the https remotes in the same repo.
            helper: String::new(),
            detail: format!(
                "{} — {} key(s), and the key itself is never written to {}",
                agent.socket, agent.keys, facts.place
            ),
            host: ask.host.clone(),
            shared: false,
            last_resort: false,
        })
    }
}

/// The member's own credential, in their own home, readable by nobody else.
///
/// The answer a shared box is supposed to give once each member has an account
/// on it (`place_account`). It is deliberately strict about what counts as
/// "own": the file has to be the member's, closed to everyone else, and the
/// login has to be a *person's* rather than the one the image came with. A
/// credential in `ubuntu`'s home is not ubuntu's — it is everybody's, and
/// calling it a member's own would be this whole bug wearing a fix's clothes.
pub struct MemberStore;

impl CredentialSource for MemberStore {
    fn id(&self) -> &'static str {
        "member-store"
    }

    fn offer(&self, ask: &CredentialAsk, facts: &PlaceGitFacts) -> Result<GitCredential, String> {
        if ask.ssh {
            return Err(format!(
                "a push to {} goes over ssh, which spends a key rather than a stored credential.",
                ask.host
            ));
        }
        if is_bootstrap_login(&ask.member) {
            return Err(format!(
                "{} is the login this place came with, so anything in its home is everybody's \
                 rather than one member's.",
                ask.member
            ));
        }
        if !facts.member_present {
            return Err(format!(
                "{} has no account of their own on {} yet.",
                ask.member, facts.place
            ));
        }
        let store = &facts.member_store;
        if !store.exists {
            return Err(format!(
                "{} holds no credential file of their own here.",
                ask.member
            ));
        }
        if store.holds.is_none() {
            return Err(format!(
                "{}'s own credential file can't be read from this login — sign in as {} to use it.",
                ask.member, ask.member
            ));
        }
        if store.holds == Some(false) {
            return Err(format!(
                "{}'s own credential file has nothing for {}.",
                ask.member, ask.host
            ));
        }
        if !store.owner.is_empty() && store.owner != ask.member {
            return Err(format!(
                "{} is owned by {}, so it isn't {}'s to push with.",
                store.path, store.owner, ask.member
            ));
        }
        if !store.private() {
            return Err(format!(
                "{} is readable by others on this place, so it is not one member's credential.",
                store.path
            ));
        }
        Ok(GitCredential {
            source: self.id().into(),
            label: format!("{}'s own credential on {}", ask.member, facts.place),
            helper: store.helper(),
            detail: format!("{}, readable only by {}", store.path, ask.member),
            host: ask.host.clone(),
            shared: false,
            last_resort: false,
        })
    }
}

/// The member's own token, held by Aura and handed to the work as environment.
///
/// The source the module docs were written for: its material comes from
/// somewhere else entirely — [`super::secret_vault`], on this laptop — so it is
/// constructed with what it needs and, like every other source, asks the place
/// nothing.
///
/// ## What is in this struct, and what deliberately is not
///
/// The **name** of an environment variable, not a token. That is the whole
/// invariant carried into the credential seam: a `PushPlan` crosses to the
/// frontend, is rendered on screen, and may end up in a log or a screenshot, so
/// what it must carry is `$GITHUB_TOKEN` and never what `$GITHUB_TOKEN` is.
///
/// git makes that possible without any cleverness. A `credential.helper`
/// beginning with `!` is a shell snippet, so the helper *describes how to
/// produce* the credential — read this variable — instead of *being* it. The
/// value is put into the process's environment at boot
/// ([`super::place_secrets`]) and the snippet reads it there, in a process the
/// model is not in.
///
/// ## Every remote the GitHub App cannot reach
///
/// This is the source that covers GitLab, Bitbucket and a self-hosted forge.
/// Aura's own GitHub App can mint a scoped token for a GitHub repo and nothing
/// else — it is an app installed on one service — so for every other remote the
/// only per-member credential that exists is one the member gave us. What makes
/// that safe to hold is the same thing that makes the GitHub path safe: the
/// value goes vault → process environment and the helper below names it rather
/// than carrying it.
///
/// What differs per service is one field: the username git must send alongside
/// the token. GitLab wants `oauth2`, Bitbucket wants `x-token-auth`, a
/// self-hosted Gitea wants the person's own account name, and GitHub wants
/// `x-access-token`. Send the wrong one and the push is a `401` that reads like
/// a bad token. So it is recorded with the secret and resolved through
/// [`super::place_forge::Forge`] rather than defaulted to GitHub's spelling.
pub struct Brokered {
    /// The environment variable the token arrives as.
    pub name: String,
    /// The username half, as this service spells it.
    pub user: String,
    /// The host this is good for.
    pub host: String,
    /// Which service answers there. Decides nothing at push time — the username
    /// above already carries that decision — and is kept so the answer can say
    /// "your own GitLab token" rather than "your own token".
    pub forge: Forge,
    /// Eight hex characters of the token's digest, so a person can tell which
    /// one is about to be spent without being shown it.
    pub fingerprint: String,
}

impl Brokered {
    /// The source for what this member holds for this host, if anything.
    ///
    /// Takes a [`super::secret_vault::SecretRef`] rather than a `Held` — the
    /// type with no value field — so this constructor could not carry a token
    /// even if a later edit wanted it to.
    ///
    /// The username is repaired rather than trusted: a vault entry written
    /// before services were recorded has no `git_forge`, and one written for
    /// `gitlab.com` before that carried `x-access-token`. Reading the service
    /// off the host and taking its own spelling turns those into a push that
    /// works, instead of a `401` on a credential the member added correctly.
    pub fn from_ref(held: &super::secret_vault::SecretRef) -> Option<Self> {
        let host = held.git_host.clone()?;
        let forge = held
            .git_forge
            .as_deref()
            .and_then(Forge::parse)
            .unwrap_or_else(|| Forge::of_host(&host));
        Some(Brokered {
            name: held.name.clone(),
            user: forge
                .username(held.git_user.as_deref())
                // Only reachable for a self-hosted host stored before there was
                // anywhere to put the account name. GitHub's spelling is the
                // one every forge that does not care about the username still
                // accepts, so it is the least-wrong last answer.
                .unwrap_or_else(|| "x-access-token".into()),
            host,
            forge,
            fingerprint: held.fingerprint.clone(),
        })
    }

    /// The helper git runs, which reads the token out of the environment.
    ///
    /// Three details are load-bearing:
    ///
    /// * `test "$1" = get` — git also calls a helper to `store` and `erase`
    ///   credentials. Without the guard, an erase would print the token again
    ///   on a code path nobody is looking at.
    /// * `printf` rather than `echo` — `echo` mangles a value that begins with
    ///   `-` or contains a backslash on some shells, and a token is arbitrary
    ///   bytes.
    /// * The variable is *named*, not expanded, here. This string is a config
    ///   value passed as one argv element; the only shell that ever expands it
    ///   is the one git starts, in the process that holds the environment.
    pub fn helper(&self) -> String {
        format!(
            "!f() {{ test \"$1\" = get && printf 'username=%s\\npassword=%s\\n' {} \"${}\"; }}; f",
            quote(&self.user),
            self.name
        )
    }
}

impl CredentialSource for Brokered {
    fn id(&self) -> &'static str {
        "brokered"
    }

    fn offer(&self, ask: &CredentialAsk, facts: &PlaceGitFacts) -> Result<GitCredential, String> {
        if !self.host.eq_ignore_ascii_case(&ask.host) {
            return Err(format!(
                "Aura holds a token of {}'s for {}, not for {}.",
                ask.member, self.host, ask.host
            ));
        }
        // A member's own token is the one credential here Aura was *given* and
        // is now spending on their behalf, so it does not go out in the clear.
        // The box's own credential may still answer for such a remote — that is
        // a choice its operator already made — but this one is not ours to make
        // for somebody.
        if ask.plaintext {
            return Err(format!(
                "{} would be sent to {} unencrypted — Aura won't spend {}'s own token on an \
                 http:// remote. Use https and it will.",
                self.name, ask.host, ask.member
            ));
        }
        let whose = match self.forge.named() {
            Some(service) => format!("{}'s own {service} token", ask.member),
            None => format!("{}'s own token", ask.member),
        };
        Ok(GitCredential {
            source: self.id().into(),
            label: format!("{whose} for {}, held by Aura", ask.host),
            helper: self.helper(),
            detail: format!(
                "kept on this laptop and given to the work on {} as ${} ({}…), sent as {}",
                facts.place, self.name, self.fingerprint, self.user
            ),
            host: ask.host.clone(),
            shared: false,
            last_resort: false,
        })
    }
}

/// Implementation zero: whatever this place already has.
///
/// This is the credential a bare `git clone` on the box has always used — the
/// one `provision.sh` writes, or the keychain helper on a laptop, or whatever an
/// admin configured. Nothing about it changes except its standing: it answers
/// last, it says whose it is, and a surface about to spend it can name it first.
///
/// It stands down when the place's default *is* the member's own file, so the
/// same credential is never offered twice under two names.
pub struct PlaceDefault;

impl CredentialSource for PlaceDefault {
    fn id(&self) -> &'static str {
        "place-default"
    }

    fn last_resort(&self) -> bool {
        true
    }

    fn offer(&self, ask: &CredentialAsk, facts: &PlaceGitFacts) -> Result<GitCredential, String> {
        if ask.ssh {
            return Err(format!(
                "a push to {} goes over ssh, which spends a key rather than a stored credential.",
                ask.host
            ));
        }
        if facts.helper.trim().is_empty() {
            return Err(format!("{} has no git credential helper configured.", facts.place));
        }
        let store = &facts.default_store;
        // A `store` helper is a file we can look at, so we say what is in it
        // rather than promising a push will work.
        if !store.path.is_empty() {
            if !store.exists {
                return Err(format!(
                    "{} is set to read {}, and that file isn't there.",
                    facts.place, store.path
                ));
            }
            if store.holds == Some(false) {
                return Err(format!("{} has nothing for {}.", store.path, ask.host));
            }
            let is_the_members_own = store.path == facts.member_store.path
                && !is_bootstrap_login(&ask.member)
                && store.owner == ask.member
                && store.private();
            if is_the_members_own {
                return Err(format!(
                    "the default here is {}'s own credential file, which is not a shared one.",
                    ask.member
                ));
            }
        }
        let shared = self.is_shared(ask, facts);
        Ok(GitCredential {
            source: self.id().into(),
            label: if shared {
                format!(
                    "the shared credential on {} — everyone here pushes as this",
                    facts.place
                )
            } else {
                format!("the credential {} is configured with", facts.place)
            },
            helper: if store.path.is_empty() {
                facts.helper.trim().to_string()
            } else {
                store.helper()
            },
            detail: self.detail(facts),
            host: ask.host.clone(),
            shared,
            last_resort: true,
        })
    }
}

impl PlaceDefault {
    /// Is what this place is configured with everybody's, rather than the
    /// asking member's?
    ///
    /// Three ways it can be, and each is a fact off the survey: it lives in the
    /// home of the login the image came with, it is owned by somebody else, or
    /// it is a file other accounts on this place can read.
    fn is_shared(&self, ask: &CredentialAsk, facts: &PlaceGitFacts) -> bool {
        if is_bootstrap_login(&facts.you) || is_bootstrap_login(&ask.member) {
            return true;
        }
        let store = &facts.default_store;
        if store.path.is_empty() {
            // No file to look at — a helper set for the whole machine is the
            // machine's; one set in an account is that account's.
            return facts.helper_origin.contains("/etc/");
        }
        (!store.owner.is_empty() && store.owner != ask.member) || !store.private()
    }

    fn detail(&self, facts: &PlaceGitFacts) -> String {
        let store = &facts.default_store;
        let where_from = if facts.helper_origin.is_empty() {
            String::new()
        } else {
            format!(" (set in {})", facts.helper_origin)
        };
        if store.path.is_empty() {
            format!("`{}`{where_from}", facts.helper.trim())
        } else {
            format!("{}{where_from}", store.path)
        }
    }
}

/// Every way of having a credential here, in the order they are asked.
///
/// Adding a fifth source is one line here and one `impl` above — which is the
/// whole reason the seam landed before any of the mechanisms did. [`ForwardedAgent`]
/// was the first to arrive that way, and nothing above it was edited to let it in.
///
/// `brokered` is the material that cannot be surveyed off a place: what the
/// member holds for this host in their own vault on this laptop. `None` is the
/// ordinary case — nobody has to keep a token in Aura — and the chain then
/// behaves exactly as it did before there was a broker.
///
/// It is asked first, and not because it is listed first. A brokered token is
/// the one credential a member *said* was theirs and this one's, and it is the
/// only one that works on a box before they have an account on it at all.
pub fn sources(brokered: Option<Brokered>) -> Vec<Box<dyn CredentialSource>> {
    let mut all: Vec<Box<dyn CredentialSource>> = vec![];
    if let Some(b) = brokered {
        all.push(Box::new(b));
    }
    all.push(Box::new(ForwardedAgent));
    all.push(Box::new(MemberStore));
    all.push(Box::new(PlaceDefault));
    all
}

/// What a push would actually use, and what else was asked on the way.
///
/// `considered` is not debugging output. When the answer is the shared box
/// credential, the only useful thing a person can be told is *why* — "you have
/// no account here yet" and "your store has nothing for github.com" lead to two
/// different next steps, and neither is guessable from the answer alone.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct PushPlan {
    pub member: String,
    pub remote: String,
    pub host: String,
    /// What to call the place, so a surface can say it without asking again.
    pub place: String,
    /// The credential a push would spend. `None` means [`PushPlan::gap`] says
    /// why.
    pub credential: Option<GitCredential>,
    pub gap: Option<NoCredential>,
    pub considered: Vec<Considered>,
}

/// One source, asked.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Considered {
    pub source: String,
    /// Did it have one?
    pub held: bool,
    /// Its label when it held one, its reason when it did not.
    pub why: String,
    pub last_resort: bool,
}

/// Last-resort sources at the end, whatever order a list happens to hold them in.
///
/// The rule that keeps an everybody's-credential from being the default: a
/// source that only works because nothing more specific answered is asked last,
/// and it is asked last because *this function* puts it there rather than
/// because whoever wrote the list remembered to. Stable within each group, so
/// the order a list does express — most specific first — is kept.
///
/// Shared rather than repeated: [`super::place_agent_key`] chooses an agent's
/// credential the same way, and the day the two disagreed about this, one of
/// them would silently be spending somebody else's key first.
pub fn last_resort_last<T>(sources: Vec<T>, last_resort: impl Fn(&T) -> bool) -> Vec<T> {
    let (last, first): (Vec<T>, Vec<T>) = sources.into_iter().partition(|s| last_resort(s));
    let mut ordered = Vec::with_capacity(first.len() + last.len());
    ordered.extend(first);
    ordered.extend(last);
    ordered
}

/// Ask every source, in order, and take the first that answers.
///
/// Last-resort sources are moved to the end by [`last_resort_last`] rather than
/// being *listed* last, so a future edit to [`sources`] cannot quietly promote
/// the shared box credential back to first by putting it at the top of a list.
/// That is the one property this task exists to guarantee, so it is enforced by
/// the code that chooses rather than by the order of a literal.
pub fn choose(
    ask: &CredentialAsk,
    facts: &PlaceGitFacts,
    sources: Vec<Box<dyn CredentialSource>>,
) -> PushPlan {
    let ordered = last_resort_last(sources, |s| s.last_resort());

    let mut considered = vec![];
    let mut chosen: Option<GitCredential> = None;
    for source in &ordered {
        match source.offer(ask, facts) {
            Ok(cred) => {
                considered.push(Considered {
                    source: source.id().into(),
                    held: true,
                    why: cred.label.clone(),
                    last_resort: source.last_resort(),
                });
                if chosen.is_none() {
                    chosen = Some(cred);
                }
            }
            Err(why) => considered.push(Considered {
                source: source.id().into(),
                held: false,
                why,
                last_resort: source.last_resort(),
            }),
        }
    }

    let gap = chosen.is_none().then(|| NoCredential::NoneHeld {
        host: ask.host.clone(),
        tried: ordered.iter().map(|s| s.id().to_string()).collect(),
    });
    PushPlan {
        member: ask.member.clone(),
        remote: ask.remote.clone(),
        host: ask.host.clone(),
        place: facts.place.clone(),
        credential: chosen,
        gap,
        considered,
    }
}

/// Ask the place everything the sources need, in one round trip.
///
/// POSIX `sh`, not bash: the same script runs under `ssh` on a distro whose
/// `/bin/sh` is dash and under `sh -c` on this laptop, and there is exactly one
/// of it for both — a second spelling for the local arm would agree for as long
/// as nobody fixed anything.
pub fn survey_script(login: &str, host: &str) -> String {
    let login = quote(login);
    let host = quote(host);
    format!(
        r#"set -u
LOGIN={login}
HOST={host}
ME=$(id -un 2>/dev/null || echo "$USER")

# Where the member's own things live. Asked rather than assumed: /home/<login>
# is wrong on macOS, on a box with a custom layout, and on every account whose
# name is not its directory.
MEMBER=absent
if [ "$ME" = "$LOGIN" ]; then
  MEMBER=present
  MEMBER_HOME="$HOME"
else
  MEMBER_HOME=$(getent passwd "$LOGIN" 2>/dev/null | cut -d: -f6)
  [ -n "$MEMBER_HOME" ] && MEMBER=present
fi
[ "$MEMBER" = present ] || MEMBER_HOME=""

# git's own answer about what it would use, and where that setting came from.
HELPER=$(git config --get credential.helper 2>/dev/null || true)
ORIGIN=$(git config --show-origin --get credential.helper 2>/dev/null | cut -f1 || true)

# A `store` helper reads a file we can go and look at. Anything else — a
# keychain, a program that mints one — has no file, and we say so rather than
# inventing a path some later surface would try to open.
DEFAULT_STORE=""
case "$HELPER" in
  *store*)
    DEFAULT_STORE=$(printf '%s' "$HELPER" | sed -n 's/.*--file=\([^ ]*\).*/\1/p')
    [ -n "$DEFAULT_STORE" ] || DEFAULT_STORE="$HOME/.git-credentials"
    ;;
esac

MEMBER_STORE=""
[ -n "$MEMBER_HOME" ] && MEMBER_STORE="$MEMBER_HOME/.git-credentials"

# The agent this session can reach. On a box this exists only when the member
# opted the box into forwarding, so it is asked rather than assumed — the answer
# is about the connection actually in hand, not about what a setting says.
#
# `ssh-add -l` is the only honest test: a socket can be there and dead, which is
# what a stale forwarding looks like. Its exit status is 0 with keys, 1 for an
# agent holding none, 2 when nothing answers.
AGENT_SOCK="${{SSH_AUTH_SOCK:-}}"
AGENT=absent
AGENT_KEYS=0
AGENT_FPS=""
if [ -n "$AGENT_SOCK" ] && [ -S "$AGENT_SOCK" ]; then
  if AGENT_LIST=$(ssh-add -l 2>/dev/null); then
    AGENT=reachable
    AGENT_KEYS=$(printf '%s\n' "$AGENT_LIST" | grep -c . || true)
    # The fingerprint only, never the key and never the comment on it — a
    # comment is usually a person's email and none of a box's business.
    AGENT_FPS=$(printf '%s\n' "$AGENT_LIST" | awk '{{print $2}}' | tr '\n' ',')
  elif [ $? = 1 ]; then
    AGENT=reachable
  fi
fi

# A store line is `https://user:token@host`. Two fixed-string greps rather than
# one pattern: a host is full of dots, and a regex would match hosts that merely
# look like this one.
holds() {{
  [ -e "$1" ] || {{ printf 'missing'; return; }}
  [ -r "$1" ] || {{ printf 'unreadable'; return; }}
  if grep -qF "@$HOST" "$1" 2>/dev/null || grep -qF "//$HOST" "$1" 2>/dev/null
  then printf 'yes'; else printf 'no'; fi
}}
# `ls -l` rather than `stat`: the flags for that differ between GNU and BSD, and
# this script has to read the same on both.
mode_of() {{ ls -ld "$1" 2>/dev/null | cut -c1-10; }}
owner_of() {{ ls -ld "$1" 2>/dev/null | tr -s ' ' | cut -d' ' -f3; }}

echo "___AURA""_GITCRED___"
echo "you=$ME"
echo "member=$MEMBER"
echo "member_store=$MEMBER_STORE"
echo "member_store_holds=$([ -n "$MEMBER_STORE" ] && holds "$MEMBER_STORE" || printf 'missing')"
echo "member_store_mode=$([ -n "$MEMBER_STORE" ] && mode_of "$MEMBER_STORE")"
echo "member_store_owner=$([ -n "$MEMBER_STORE" ] && owner_of "$MEMBER_STORE")"
echo "helper=$HELPER"
echo "helper_origin=$ORIGIN"
echo "default_store=$DEFAULT_STORE"
echo "default_store_holds=$([ -n "$DEFAULT_STORE" ] && holds "$DEFAULT_STORE" || printf 'missing')"
echo "default_store_mode=$([ -n "$DEFAULT_STORE" ] && mode_of "$DEFAULT_STORE")"
echo "default_store_owner=$([ -n "$DEFAULT_STORE" ] && owner_of "$DEFAULT_STORE")"
echo "agent=$AGENT"
echo "agent_socket=$AGENT_SOCK"
echo "agent_keys=$AGENT_KEYS"
echo "agent_fingerprints=$AGENT_FPS"
"#
    )
}

/// Read the survey back.
///
/// Everything before the marker is the place's own noise — a MOTD, a sudo
/// lecture, whatever a profile prints — and is dropped rather than parsed
/// around.
pub fn parse_survey(place: &str, out: &str) -> Result<PlaceGitFacts, String> {
    let body = out
        .split_once(SURVEY)
        .map(|(_, rest)| rest)
        .ok_or_else(|| "the place didn't say what credentials it holds".to_string())?;
    let f = |k: &str| -> String {
        body.lines()
            .filter_map(|l| l.trim().split_once('='))
            .find(|(key, _)| *key == k)
            .map(|(_, v)| v.trim().to_string())
            .unwrap_or_default()
    };
    let store = |prefix: &str| -> StoreFile {
        let path = f(prefix);
        let state = f(&format!("{prefix}_holds"));
        StoreFile {
            exists: !path.is_empty() && state != "missing",
            holds: match state.as_str() {
                "yes" => Some(true),
                "no" => Some(false),
                _ => None,
            },
            mode: f(&format!("{prefix}_mode")),
            owner: f(&format!("{prefix}_owner")),
            path,
        }
    };
    let you = f("you");
    if you.is_empty() {
        return Err("the place didn't say which login it answered as".into());
    }
    Ok(PlaceGitFacts {
        place: place.to_string(),
        you,
        member_present: f("member") == "present",
        member_store: store("member_store"),
        helper: f("helper"),
        helper_origin: f("helper_origin"),
        default_store: store("default_store"),
        agent: AgentFacts {
            socket: f("agent_socket"),
            reachable: f("agent") == "reachable",
            keys: f("agent_keys").parse().unwrap_or(0),
            fingerprints: f("agent_fingerprints")
                .split(',')
                .map(str::trim)
                .filter(|fp| !fp.is_empty())
                .map(str::to_string)
                .collect(),
            // Whose they are is not something one end can see. See
            // [`Place::push_credential`].
            mine: false,
        },
    })
}

/// The fingerprints of the keys the agent on THIS laptop is holding.
///
/// The same survey, asked of here — one spelling of the question rather than a
/// second one that would agree with the first for as long as nobody fixed
/// anything. Never an error: a laptop with no agent holds no keys, which is an
/// answer, and it is the answer that makes a forwarded box decline rather than
/// claim a key nobody can name.
async fn my_own_keys(ask: &CredentialAsk) -> Vec<String> {
    let here = Place::Here {
        root: std::env::temp_dir().display().to_string(),
    };
    match here.ask(survey_script(&ask.member, &ask.host)).await {
        Ok(out) => parse_survey("this laptop", &out)
            .map(|f| f.agent.fingerprints)
            .unwrap_or_default(),
        Err(_) => vec![],
    }
}

impl Place {
    /// Which credential a push from here, by this member, to this remote would
    /// spend.
    ///
    /// One call for both place-modes, because it is a `Place` method and the
    /// survey is one script through [`Place::ask`]: this laptop answers it about
    /// its own git config, a box answers it about the box's, and neither has an
    /// implementation the other lacks.
    pub async fn push_credential(
        &self,
        member: &str,
        remote: &str,
    ) -> Result<PushPlan, NoCredential> {
        let ask = CredentialAsk::new(member, remote)?;
        let out = self
            .ask(survey_script(&ask.member, &ask.host))
            .await
            .map_err(|detail| NoCredential::NoneHeld {
                host: ask.host.clone(),
                tried: vec![format!("couldn't ask this place: {detail}")],
            })?;
        let mut facts = parse_survey(self.label(), &out).map_err(|detail| {
            NoCredential::NoneHeld {
                host: ask.host.clone(),
                tried: vec![detail],
            }
        })?;
        // The one thing the place cannot tell us about itself. An agent
        // reachable from there is only *yours* if this laptop's agent holds one
        // of the same keys — which is what makes "forwarded" different from "the
        // machine runs an agent of its own", and it is a comparison between two
        // ends rather than a fact at either.
        //
        // Asked of this laptop with the same script the place answered, so there
        // is one spelling of the question and the two answers are comparable by
        // construction.
        if facts.agent.reachable {
            facts.agent.mine = facts.agent.shares_a_key_with(&my_own_keys(&ask).await);
        }
        let mut plan = choose(&ask, &facts, sources(self.brokered_for(&ask)));
        // An ssh remote that found no key of the member's is not "nothing here
        // holds a credential" — there is nothing here that *could*. It pushes
        // with the place's own key, which is a different sentence and a
        // different next step, so it keeps its own name.
        //
        // Asked rather than assumed, which is the change: this used to be
        // returned before the place was ever consulted, so a member whose key
        // was right there was still told the box's key would be used. Asking
        // costs the round trip the https arm already paid, and it buys the
        // `considered` list — which is the only thing that can tell someone
        // their agent is reachable but empty rather than absent.
        if plan.credential.is_none() && ask.ssh {
            plan.gap = Some(NoCredential::PushesWithAnSshKey { host: ask.host });
        }
        Ok(plan)
    }

    /// What this member holds for this host in their vault on this laptop.
    ///
    /// Read here rather than surveyed off the place, because the value is not on
    /// the place and must not be: sending it there to ask whether it is there
    /// would be the leak this seam exists to close. `None` for every reason
    /// there could be — nobody signed in, nothing held for this host, no
    /// project — since a member without a brokered token is the ordinary case
    /// and not a failure to report.
    fn brokered_for(&self, ask: &CredentialAsk) -> Option<Brokered> {
        let scope = super::secret_vault::SecretScope::new(&ask.member, self.here()).ok()?;
        let vault = super::secret_vault::Vault::open(scope).ok()?;
        Brokered::from_ref(&vault.git_for(&ask.host)?.as_ref())
    }

    /// The credential a push from here would use, as arguments to one `git`
    /// call — and nothing at all when there is none.
    ///
    /// Empty is deliberate rather than an error. A public clone needs no
    /// credential, and an ssh remote needs a key; passing `credential.helper=`
    /// in either case would clear a working configuration to prove a point. The
    /// rule is only that the shared credential stops being *silent*, not that
    /// git stops being git.
    pub async fn git_credential_args(&self, member: &str, remote: &str) -> (Vec<String>, String) {
        match self.push_credential(member, remote).await {
            Ok(plan) => match plan.credential {
                Some(cred) => (cred.git_config_args(), cred.label),
                None => (
                    vec![],
                    plan.gap.map(|g| g.to_string()).unwrap_or_default(),
                ),
            },
            Err(gap) => (vec![], gap.to_string()),
        }
    }
}

/// The login this member owns here, without asking the place anything.
///
/// A given name wins — a member may already have an account on a box under
/// another one. Otherwise the Aura account they are signed in as, and failing
/// that the login this place is already reached with, which is the honest last
/// answer: it is who the work would run as. Never an error, because "who is
/// pushing" always has an answer even when nobody is signed in.
pub async fn member_for(place: &Place, given: Option<&str>) -> String {
    if let Some(g) = given.map(str::trim).filter(|g| !g.is_empty()) {
        return g.to_string();
    }
    // The same answer the account wizard shows, rather than a second derivation
    // of it — a member whose account here is `mo` must not be looked up as
    // `mo-1` by the credential seam.
    if let Ok(login) = super::place_account::member_account_login().await {
        return login;
    }
    place.identity().user
}

/// Which credential a push from a place would use, before it happens.
///
/// `machine_id` names a box; omit it and the answer is about this laptop, in
/// `root`. One command for both, so the day a managed place exists it is asked
/// this in the same words — and an unknown machine id is an error rather than a
/// quiet answer about the wrong computer, because "whose token is about to be
/// spent" answered about somewhere else is worse than unanswered.
#[tauri::command]
pub async fn place_push_credential(
    root: Option<String>,
    machine_id: Option<String>,
    remote: String,
    member: Option<String>,
) -> Result<PushPlan, String> {
    let place = match machine_id.as_deref().map(str::trim).filter(|id| !id.is_empty()) {
        Some(id) => Place::at_machine(id)?,
        None => Place::resolve(root.unwrap_or_default(), None),
    };
    let member = member_for(&place, member.as_deref()).await;
    match place.push_credential(&member, &remote).await {
        Ok(plan) => Ok(plan),
        // A gap is an answer about this place, not a failure of the call. The
        // surface has to be able to say "a push to github.com goes over ssh"
        // without rendering it as an error.
        Err(gap) => Ok(PushPlan {
            member,
            remote: remote.trim().to_string(),
            host: remote_host(&remote).unwrap_or_default(),
            place: place.label().to_string(),
            credential: None,
            gap: Some(gap),
            considered: vec![],
        }),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn facts() -> PlaceGitFacts {
        PlaceGitFacts {
            place: "aura-runner".into(),
            you: "mo".into(),
            member_present: true,
            member_store: StoreFile {
                path: "/home/mo/.git-credentials".into(),
                exists: true,
                holds: Some(true),
                mode: "-rw-------".into(),
                owner: "mo".into(),
            },
            helper: "store".into(),
            helper_origin: "file:/home/mo/.gitconfig".into(),
            default_store: StoreFile {
                path: "/home/mo/.git-credentials".into(),
                exists: true,
                holds: Some(true),
                mode: "-rw-------".into(),
                owner: "mo".into(),
            },
            // Nobody opted this place into forwarding, which is what every
            // place looks like until somebody does.
            agent: AgentFacts::default(),
        }
    }

    /// The same box with the member's own agent reaching it — which on a box
    /// only happens because the member opted it into forwarding.
    fn lending() -> PlaceGitFacts {
        PlaceGitFacts {
            agent: AgentFacts {
                socket: "/tmp/ssh-XXXX/agent.4242".into(),
                reachable: true,
                keys: 2,
                fingerprints: vec![MY_KEY.into(), "SHA256:second".into()],
                mine: true,
            },
            ..facts()
        }
    }

    /// A key this laptop's agent holds, as `ssh-add -l` prints one.
    const MY_KEY: &str = "SHA256:6dK8oZ1Yb0xQ2Xn4wV7t9c3LmPqR5sTuWxYzA1BcDeF";

    /// The box as `provision.sh` leaves it: one token in the bootstrap login's
    /// home, and every member is that login.
    fn shared_box() -> PlaceGitFacts {
        PlaceGitFacts {
            place: "aura-runner".into(),
            you: "ubuntu".into(),
            member_present: true,
            member_store: StoreFile {
                path: "/home/ubuntu/.git-credentials".into(),
                exists: true,
                holds: Some(true),
                mode: "-rw-------".into(),
                owner: "ubuntu".into(),
            },
            helper: "store".into(),
            helper_origin: "file:/home/ubuntu/.gitconfig".into(),
            default_store: StoreFile {
                path: "/home/ubuntu/.git-credentials".into(),
                exists: true,
                holds: Some(true),
                mode: "-rw-------".into(),
                owner: "ubuntu".into(),
            },
            agent: AgentFacts::default(),
        }
    }

    fn ask(member: &str) -> CredentialAsk {
        CredentialAsk::new(member, "https://github.com/Uniskool/naridon.git").expect("an ask")
    }

    /// The same member, pushing to the same repository over ssh.
    fn ssh_ask(member: &str) -> CredentialAsk {
        CredentialAsk::new(member, "git@github.com:Uniskool/naridon.git").expect("an ask")
    }

    // -- the ask ------------------------------------------------------------
    //
    // What a remote *is* — its host, its service, whether it goes in the clear —
    // is [`super::super::place_forge`]'s question and is tested there. What this
    // module answers is whose token a push to it spends.

    #[test]
    fn something_that_is_not_a_remote_is_a_named_failure() {
        // Not a string: a caller has to be able to tell "you typed nonsense"
        // from "nothing here holds one".
        let e = CredentialAsk::new("mo", "rm -rf /").unwrap_err();
        assert!(matches!(e, NoCredential::NotARemote { .. }), "{e:?}");
        assert!(matches!(
            CredentialAsk::new("  ", "https://github.com/a/b").unwrap_err(),
            NoCredential::NoMember
        ));
    }

    // -- the answer ---------------------------------------------------------

    #[test]
    fn the_chosen_credential_clears_whatever_the_place_already_had() {
        // The line the whole task turns on. `credential.helper` is a list, so
        // appending ours without clearing first leaves the box's own token
        // answering first — and nothing would have changed.
        let cred = MemberStore.offer(&ask("mo"), &facts()).expect("mo's own");
        let args = cred.git_config_args();
        assert_eq!(
            args,
            vec![
                "-c".to_string(),
                "credential.helper=".to_string(),
                "-c".to_string(),
                "credential.helper=store --file=/home/mo/.git-credentials".to_string(),
            ]
        );
        assert_eq!(args[1], "credential.helper=", "the inherited helper is not cleared");
    }

    // -- impl zero ----------------------------------------------------------

    #[test]
    fn the_shared_box_credential_still_works_and_says_what_it_is() {
        // It must keep working — it is the only credential most boxes have.
        // What changes is that it is named, and that it is last.
        let plan = choose(&ask("ubuntu"), &shared_box(), sources(None));
        let cred = plan.credential.expect("the box's own token still answers");
        assert_eq!(cred.source, "place-default");
        assert!(cred.shared, "a token in the bootstrap login's home is everybody's");
        assert!(cred.last_resort);
        assert!(
            cred.label.contains("everyone here pushes as this"),
            "the shared credential is not labelled as shared: {}",
            cred.label
        );
        assert!(cred.detail.contains("/home/ubuntu/.git-credentials"));
    }

    #[test]
    fn a_member_with_their_own_credential_does_not_get_the_boxs() {
        let plan = choose(&ask("mo"), &facts(), sources(None));
        let cred = plan.credential.expect("mo's own");
        assert_eq!(cred.source, "member-store");
        assert!(!cred.shared && !cred.last_resort);
        assert_eq!(cred.helper, "store --file=/home/mo/.git-credentials");
    }

    #[test]
    fn one_credential_is_never_offered_twice_under_two_names() {
        // When the place's default IS the member's own file, the last-resort
        // source stands down rather than describing the same file as shared.
        let plan = choose(&ask("mo"), &facts(), sources(None));
        let dflt = plan
            .considered
            .iter()
            .find(|c| c.source == "place-default")
            .expect("it was asked");
        assert!(!dflt.held, "the same file was offered twice");
        assert!(dflt.why.contains("own credential file"), "{}", dflt.why);
    }

    #[test]
    fn a_credential_in_the_login_the_image_came_with_is_never_a_members_own() {
        // The bug this file exists about: everybody signs in as `ubuntu`, so a
        // token in ubuntu's home looks personal and is not.
        let why = MemberStore
            .offer(&ask("ubuntu"), &shared_box())
            .expect_err("ubuntu is not a member");
        assert!(why.contains("everybody's"), "{why}");
    }

    #[test]
    fn a_store_other_accounts_can_read_is_not_one_members_own() {
        let mut f = facts();
        f.member_store.mode = "-rw-r--r--".into();
        f.default_store.mode = "-rw-r--r--".into();
        let why = MemberStore.offer(&ask("mo"), &f).expect_err("world-readable");
        assert!(why.contains("readable by others"), "{why}");
        // And the one that does answer says it is shared, because it is.
        let cred = PlaceDefault.offer(&ask("mo"), &f).expect("the default holds");
        assert!(cred.shared);
    }

    #[test]
    fn a_members_own_store_that_this_login_cannot_read_says_so() {
        // Exactly what a 0600 file in a 0700 home should look like from
        // somebody else's session — and it must not read as "there is none".
        let mut f = shared_box();
        f.member_present = true;
        f.member_store = StoreFile {
            path: "/home/mo/.git-credentials".into(),
            exists: true,
            holds: None,
            mode: String::new(),
            owner: String::new(),
        };
        let why = MemberStore.offer(&ask("mo"), &f).expect_err("unreadable");
        assert!(why.contains("can't be read from this login"), "{why}");
        // The push still happens — on the shared credential, labelled.
        let plan = choose(&ask("mo"), &f, sources(None));
        let cred = plan.credential.expect("the box's own token");
        assert!(cred.shared && cred.last_resort);
    }

    #[test]
    fn a_member_with_no_account_here_is_told_that_rather_than_nothing() {
        let mut f = shared_box();
        f.member_present = false;
        f.member_store = StoreFile::default();
        let why = MemberStore.offer(&ask("mo"), &f).expect_err("no account");
        assert!(why.contains("no account of their own"), "{why}");
    }

    #[test]
    fn a_keychain_helper_is_a_credential_too_and_is_not_a_file() {
        // A laptop's `osxkeychain`, or `!gh auth git-credential`. It has no
        // store file, and inventing a path for it would be a lie.
        let f = PlaceGitFacts {
            place: "this laptop".into(),
            you: "muhammed".into(),
            member_present: true,
            member_store: StoreFile::default(),
            helper: "osxkeychain".into(),
            helper_origin: "file:/Users/muhammed/.gitconfig".into(),
            default_store: StoreFile::default(),
            agent: AgentFacts::default(),
        };
        let cred = PlaceDefault.offer(&ask("muhammed"), &f).expect("the keychain");
        assert_eq!(cred.helper, "osxkeychain");
        assert!(!cred.shared, "one person's login is not a shared box");
        assert!(cred.last_resort, "it is still what the place happened to have");
    }

    #[test]
    fn a_helper_set_for_the_whole_machine_is_the_machines_and_not_yours() {
        let f = PlaceGitFacts {
            helper_origin: "file:/etc/gitconfig".into(),
            ..PlaceGitFacts {
                place: "aura-runner".into(),
                you: "mo".into(),
                member_present: true,
                member_store: StoreFile::default(),
                helper: "!aura-credential".into(),
                helper_origin: String::new(),
                default_store: StoreFile::default(),
                agent: AgentFacts::default(),
            }
        };
        assert!(PlaceDefault.offer(&ask("mo"), &f).expect("it holds").shared);
    }

    #[test]
    fn a_place_with_nothing_configured_is_a_named_failure_not_an_empty_answer() {
        let f = PlaceGitFacts {
            place: "aura-runner".into(),
            you: "mo".into(),
            member_present: true,
            member_store: StoreFile::default(),
            helper: String::new(),
            helper_origin: String::new(),
            default_store: StoreFile::default(),
            agent: AgentFacts::default(),
        };
        let plan = choose(&ask("mo"), &f, sources(None));
        assert!(plan.credential.is_none());
        match plan.gap.expect("a named gap") {
            NoCredential::NoneHeld { host, tried } => {
                assert_eq!(host, "github.com");
                // It names what was asked, rather than implying there is only
                // one way to have a credential.
                assert_eq!(tried, vec!["ssh-agent", "member-store", "place-default"]);
            }
            other => panic!("wrong gap: {other:?}"),
        }
    }

    // -- the brokered token -------------------------------------------------

    const TOKEN: &str = "ghp_a1b2c3d4e5f6g7h8i9j0klmnopqrstuvwxyz";

    /// What the member's vault on this laptop holds, reduced to what the
    /// credential seam is allowed to see. Built through `SecretRef` on purpose:
    /// this is the only shape a brokered source can be constructed from, so a
    /// test cannot accidentally prove something about a value the real path
    /// never has.
    fn brokered_for(name: &str, host: &str, forge: Option<&str>, user: Option<&str>) -> Brokered {
        let held = super::super::secret_vault::Held::new(name, TOKEN, 1_700_000_000)
            .expect("a secret")
            .for_git_on(host, forge, user)
            .expect("a git credential");
        Brokered::from_ref(&held.as_ref()).expect("a brokered source")
    }

    fn brokered(host: &str) -> Brokered {
        brokered_for("GITHUB_TOKEN", host, None, None)
    }

    fn ask_at(member: &str, host: &str) -> CredentialAsk {
        CredentialAsk::new(member, &format!("https://{host}/Uniskool/naridon.git")).expect("an ask")
    }

    #[test]
    fn a_members_own_token_beats_the_box_the_whole_team_shares() {
        // The point of the broker on a BYOC box: `provision.sh` left one token
        // in `ubuntu`'s home and every member is `ubuntu`, so without this the
        // work pushes as whoever set the box up.
        let plan = choose(&ask("mo"), &shared_box(), sources(Some(brokered("github.com"))));
        let cred = plan.credential.expect("the brokered token answers");
        assert_eq!(cred.source, "brokered");
        assert!(!cred.shared, "a member's own token is not everybody's");
        assert!(!cred.last_resort);
        // And it says which of mo's tokens, because a person with one per
        // service needs to know which one is about to be spent.
        assert!(cred.label.contains("mo's own GitHub token"), "{}", cred.label);
        // The fingerprint is how a person tells which token is about to be
        // spent. Eight hex characters of it, and none of the token.
        assert!(cred.detail.contains("$GITHUB_TOKEN"), "{}", cred.detail);
        assert!(!cred.detail.contains(TOKEN));
        assert!(
            plan.considered.iter().any(|c| c.source == "brokered" && c.held),
            "the brokered source is not named in what was considered: {:?}",
            plan.considered
        );
    }

    #[test]
    fn a_token_for_another_host_stands_down_and_says_so() {
        // Holding a GitLab token must not silently answer a push to GitHub —
        // that is a credential spent on the wrong service.
        let plan = choose(&ask("mo"), &shared_box(), sources(Some(brokered("gitlab.com"))));
        let cred = plan.credential.expect("the box's own token still answers");
        assert_eq!(cred.source, "place-default", "a gitlab token answered a github push");
        let why = &plan
            .considered
            .iter()
            .find(|c| c.source == "brokered")
            .expect("the brokered source was asked")
            .why;
        assert!(why.contains("gitlab.com") && why.contains("github.com"), "{why}");
    }

    #[test]
    fn the_helper_names_the_variable_rather_than_holding_the_token() {
        let helper = brokered("github.com").helper();
        assert!(!helper.contains(TOKEN), "the helper carries the token itself: {helper}");
        assert!(helper.contains("$GITHUB_TOKEN"), "{helper}");
        // git also calls a helper to store and to erase. Without the guard, an
        // erase prints the token again where nobody is looking.
        assert!(helper.contains(r#"test "$1" = get"#), "{helper}");
        assert!(helper.contains("printf"), "echo mangles arbitrary bytes: {helper}");
        assert!(helper.starts_with('!'), "git only runs a helper as a shell snippet with `!`");

        // And nothing that crosses to a surface carries it either.
        let plan = choose(&ask("mo"), &shared_box(), sources(Some(brokered("github.com"))));
        let json = serde_json::to_string(&plan).expect("a plan serialises");
        assert!(!json.contains(TOKEN), "a token reached the frontend contract");
        assert!(json.contains("GITHUB_TOKEN"), "the plan cannot say which token it means");
    }

    #[test]
    fn a_brokered_token_clears_the_places_own_helper_first() {
        // Same property the whole task turns on, on the new source: git's
        // `credential.helper` is a list, and the box's token answers first
        // unless the list is reset.
        let cred = brokered("github.com").offer(&ask("mo"), &shared_box()).expect("offered");
        let args = cred.git_config_args();
        assert_eq!(args[0], "-c");
        assert_eq!(args[1], "credential.helper=", "the box's own helper is not cleared");
        assert!(args[3].starts_with("credential.helper=!f()"), "{}", args[3]);
        assert!(!args.iter().any(|a| a.contains(TOKEN)));
    }

    // -- every remote the GitHub App cannot reach ---------------------------

    /// The acceptance criterion, per service.
    ///
    /// Aura's GitHub App can mint a token for a GitHub repo and nothing else, so
    /// for GitLab, Bitbucket and a self-hosted forge the broker is the *only*
    /// per-member credential there is. Each of the three is followed all the way
    /// to the arguments git is handed, and the token is in none of them.
    #[test]
    fn gitlab_bitbucket_and_a_self_hosted_remote_each_push_as_the_member() {
        // (variable, host, service as stored, account name, what git must send)
        let services: [(&str, &str, Option<&str>, Option<&str>, &str); 3] = [
            ("GITLAB_TOKEN", "gitlab.com", None, None, "oauth2"),
            ("BITBUCKET_TOKEN", "bitbucket.org", None, None, "x-token-auth"),
            // Nothing about `git.acme.internal` says what runs there, so the
            // service is named and the account is the member's own.
            ("GIT_TOKEN", "git.acme.internal", Some("gitea"), Some("mo"), "mo"),
        ];

        for (name, host, forge, user, sends) in services {
            let ask = ask_at("mo", host);
            let plan = choose(
                &ask,
                &shared_box(),
                sources(Some(brokered_for(name, host, forge, user))),
            );
            let cred = plan
                .credential
                .clone()
                .unwrap_or_else(|| panic!("{host} got no credential at all"));

            // It is the member's, not the one `provision.sh` left in ubuntu's home.
            assert_eq!(cred.source, "brokered", "{host} pushed as the box");
            assert!(!cred.shared && !cred.last_resort, "{host}");
            assert!(cred.label.contains("mo's own"), "{host}: {}", cred.label);

            // The username half — the field that differs per service, and the
            // reason a token that is perfectly good returns 401 when it is wrong.
            assert!(
                cred.helper.contains(&format!("'{sends}'")),
                "{host} sends the wrong username: {}",
                cred.helper
            );
            assert!(cred.detail.contains(&format!("sent as {sends}")), "{}", cred.detail);

            // And the token itself is nowhere: not in the helper, not in the
            // arguments, not in what crosses to the frontend.
            let args = cred.git_config_args();
            assert_eq!(args[1], "credential.helper=", "{host} left the box's helper first");
            assert!(args[3].contains(&format!("${name}")), "{}", args[3]);
            let json = serde_json::to_string(&plan).expect("json");
            for text in [&cred.helper, &cred.detail, &args.join(" "), &json] {
                assert!(!text.contains(TOKEN), "{host} carried the token: {text}");
            }
        }
    }

    #[test]
    fn a_self_hosted_forge_needs_an_account_name_rather_than_a_guess() {
        // GitHub, GitLab and Bitbucket each publish the username a token is sent
        // under. A self-hosted Gitea authenticates the person, so there is
        // nothing to infer — and inferring anyway would be a 401 that reads like
        // a bad token.
        let why = super::super::secret_vault::Held::new("GIT_TOKEN", TOKEN, 0)
            .expect("a secret")
            .for_git_on("git.acme.internal", Some("gitea"), None)
            .expect_err("nobody can know the account name");
        assert!(why.contains("account name"), "{why}");
        assert!(!why.contains(TOKEN), "{why}");
    }

    #[test]
    fn a_members_own_token_is_not_spent_on_a_remote_that_goes_in_the_clear() {
        // The box's own credential may still answer for an `http://` remote —
        // its operator made that choice. Spending a token somebody handed Aura
        // is not a choice Aura gets to make for them.
        let ask = CredentialAsk::new("mo", "http://git.acme.internal/a/b.git").expect("an ask");
        assert!(ask.plaintext);
        let why = brokered_for("GIT_TOKEN", "git.acme.internal", Some("gitea"), Some("mo"))
            .offer(&ask, &shared_box())
            .expect_err("plaintext");
        assert!(why.contains("unencrypted"), "{why}");
        assert!(!why.contains(TOKEN), "{why}");

        // It stands down rather than failing the push, and says why.
        let plan = choose(
            &ask,
            &shared_box(),
            sources(Some(brokered_for(
                "GIT_TOKEN",
                "git.acme.internal",
                Some("gitea"),
                Some("mo"),
            ))),
        );
        assert_eq!(plan.credential.expect("the box's own").source, "place-default");
    }

    #[test]
    fn a_token_stored_before_services_were_recorded_still_pushes_as_the_right_user() {
        // A vault written by an earlier Aura has no `git_forge`, and a GitLab
        // entry in it carries GitHub's spelling of the username. Reading the
        // service back off the host repairs that instead of sending `oauth2`'s
        // job to `x-access-token`.
        let old = super::super::secret_vault::SecretRef {
            name: "GITLAB_TOKEN".into(),
            fingerprint: "0123abcd".into(),
            added_at: 1_700_000_000,
            git_host: Some("gitlab.com".into()),
            git_user: None,
            git_forge: None,
        };
        let cred = Brokered::from_ref(&old)
            .expect("a brokered source")
            .offer(&ask_at("mo", "gitlab.com"), &shared_box())
            .expect("offered");
        assert!(cred.helper.contains("'oauth2'"), "{}", cred.helper);
        assert!(cred.label.contains("GitLab"), "{}", cred.label);
    }

    // -- the seam itself ----------------------------------------------------

    /// A source that is neither of the two shipped ones — the proof that a
    /// fifth way of having a credential is one `impl` rather than a redesign.
    struct StubMint {
        answers: bool,
    }

    impl CredentialSource for StubMint {
        fn id(&self) -> &'static str {
            "stub-mint"
        }
        fn offer(&self, ask: &CredentialAsk, _: &PlaceGitFacts) -> Result<GitCredential, String> {
            if !self.answers {
                return Err("the mint declined".into());
            }
            Ok(GitCredential {
                source: self.id().into(),
                label: format!("a freshly minted token for {}", ask.member),
                helper: "!aura-mint".into(),
                detail: "minted for this push".into(),
                host: ask.host.clone(),
                shared: false,
                last_resort: false,
            })
        }
    }

    #[test]
    fn a_new_source_wins_over_the_shared_box_credential_by_being_added() {
        // Nothing about `PlaceDefault` is edited for this to happen. That is
        // the seam: a fifth credential source is one impl and one line.
        let plan = choose(
            &ask("ubuntu"),
            &shared_box(),
            vec![Box::new(StubMint { answers: true }), Box::new(PlaceDefault)],
        );
        let cred = plan.credential.expect("the mint");
        assert_eq!(cred.source, "stub-mint");
        assert!(!cred.last_resort);
        // And the box's own token is still there, still working, just not used.
        let dflt = plan
            .considered
            .iter()
            .find(|c| c.source == "place-default")
            .expect("still asked");
        assert!(dflt.held, "impl zero stopped working");
    }

    #[test]
    fn a_source_that_declines_falls_through_to_the_labelled_last_resort() {
        let plan = choose(
            &ask("ubuntu"),
            &shared_box(),
            vec![Box::new(StubMint { answers: false }), Box::new(PlaceDefault)],
        );
        let cred = plan.credential.expect("the fallback");
        assert_eq!(cred.source, "place-default");
        assert!(cred.last_resort && cred.shared);
        assert_eq!(plan.considered[0].why, "the mint declined");
    }

    #[test]
    fn the_shared_credential_is_last_however_the_list_is_written() {
        // The guarantee this task exists for, and it cannot be undone by
        // reordering `sources()`: a last-resort source is moved to the end by
        // the code that chooses.
        let plan = choose(
            &ask("ubuntu"),
            &shared_box(),
            vec![Box::new(PlaceDefault), Box::new(StubMint { answers: true })],
        );
        assert_eq!(
            plan.credential.expect("one").source,
            "stub-mint",
            "a last-resort source was consulted first because it was listed first"
        );
        assert_eq!(plan.considered.last().expect("asked").source, "place-default");
    }

    #[test]
    fn every_source_is_asked_so_the_answer_can_say_why_it_was_reached() {
        // A person told "we used the shared box credential" can do nothing with
        // that. Told "you have no account here yet", they can.
        let mut f = shared_box();
        f.member_present = false;
        let plan = choose(&ask("mo"), &f, sources(None));
        assert_eq!(plan.considered.len(), 3);
        let store = &plan.considered[1];
        assert!(!store.held && store.source == "member-store");
        assert!(store.why.contains("no account of their own"));
        assert!(plan.considered[2].held && plan.considered[2].last_resort);
    }

    // -- the survey ---------------------------------------------------------

    #[test]
    fn the_survey_reads_back_as_facts_about_the_place() {
        let out = "Welcome to Ubuntu 24.04\n___AURA_GITCRED___\nyou=mo\nmember=present\n\
                   member_store=/home/mo/.git-credentials\nmember_store_holds=yes\n\
                   member_store_mode=-rw-------\nmember_store_owner=mo\nhelper=store\n\
                   helper_origin=file:/home/mo/.gitconfig\n\
                   default_store=/home/mo/.git-credentials\ndefault_store_holds=yes\n\
                   default_store_mode=-rw-------\ndefault_store_owner=mo\n";
        let f = parse_survey("aura-runner", out).expect("facts");
        assert_eq!(f, facts());
        assert!(f.member_store.private() && f.member_store.usable());
    }

    #[test]
    fn a_file_this_login_may_not_read_is_not_a_file_that_says_no() {
        // The distinction the whole member arm rests on. Rounding "unreadable"
        // down to "no" would tell a member their own credential doesn't exist.
        let out = "___AURA_GITCRED___\nyou=ubuntu\nmember=present\n\
                   member_store=/home/mo/.git-credentials\nmember_store_holds=unreadable\n\
                   helper=store\ndefault_store=/home/ubuntu/.git-credentials\n\
                   default_store_holds=yes\ndefault_store_mode=-rw-------\n\
                   default_store_owner=ubuntu\n";
        let f = parse_survey("aura-runner", out).expect("facts");
        assert_eq!(f.member_store.holds, None);
        assert!(f.member_store.exists, "unreadable is not missing");
        assert!(!f.member_store.usable());
    }

    #[test]
    fn a_missing_store_is_missing_rather_than_empty() {
        let out = "___AURA_GITCRED___\nyou=mo\nmember=present\n\
                   member_store=/home/mo/.git-credentials\nmember_store_holds=missing\n\
                   helper=\ndefault_store=\ndefault_store_holds=missing\n";
        let f = parse_survey("this laptop", out).expect("facts");
        assert!(!f.member_store.exists);
        assert!(f.default_store.path.is_empty());
        assert!(f.helper.is_empty());
    }

    #[test]
    fn output_without_a_survey_is_not_a_set_of_facts() {
        assert!(parse_survey("aura-runner", "sh: git: not found\n").is_err());
        assert!(parse_survey("aura-runner", "___AURA_GITCRED___\nhelper=store\n").is_err());
    }

    #[test]
    fn the_script_never_contains_the_marker_it_prints() {
        assert!(!survey_script("mo", "github.com").contains(SURVEY));
    }

    #[test]
    fn nothing_the_caller_names_can_become_a_second_command() {
        // A login and a host both reach a real `sh`. They are narrowed before
        // they get here and quoted anyway — the two rules are worth having
        // separately, because only one of them is in front of a user.
        let s = survey_script("mo", "github.com");
        assert!(s.contains("LOGIN='mo'"));
        assert!(s.contains("HOST='github.com'"));
        let nasty = survey_script("a'; rm -rf ~; '", "h");
        assert!(nasty.contains(r"'a'\''; rm -rf ~; '\'''"));
        // And a host that could carry one never reaches the script at all.
        assert!(remote_host("https://a b/c").is_none());
        assert!(remote_host("https://$(id)/c").is_none());
    }

    // -- both place-modes ---------------------------------------------------

    #[tokio::test]
    async fn this_laptop_answers_the_question_for_real() {
        // Not a string test: the survey script runs through the local arm of
        // `Place::ask` and comes back through this file's own parser. Whether
        // this machine happens to hold a credential is nobody's business, so
        // the assertion is on the shape of the answer, not its content.
        let here = Place::Here {
            root: std::env::temp_dir().display().to_string(),
        };
        let me = std::env::var("USER")
            .or_else(|_| std::env::var("LOGNAME"))
            .unwrap_or_default();
        if me.trim().is_empty() {
            return;
        }
        let plan = here
            .push_credential(me.trim(), "https://github.com/Uniskool/naridon.git")
            .await
            .expect("this laptop must be able to answer who it would push as");
        assert_eq!(plan.host, "github.com");
        assert_eq!(plan.place, "this laptop");
        // Every source was asked, and it either held one or said why not.
        assert_eq!(plan.considered.len(), 3);
        assert!(plan.credential.is_some() || plan.gap.is_some());
        for c in &plan.considered {
            assert!(!c.why.trim().is_empty(), "{} said nothing", c.source);
        }
    }

    #[tokio::test]
    async fn this_laptop_reports_its_own_agent_because_it_was_asked() {
        // The local arm of the same discovery a forwarded box goes through:
        // whatever this laptop's agent is doing, it is READ rather than assumed,
        // and the answer is shaped the same either way. Whether the machine
        // running the tests happens to have keys loaded is nobody's business.
        let here = Place::Here {
            root: std::env::temp_dir().display().to_string(),
        };
        let out = here
            .ask(survey_script("nobody", "github.com"))
            .await
            .expect("this laptop must answer its own survey");
        let facts = parse_survey("this laptop", &out).expect("facts");
        if facts.agent.socket.is_empty() {
            assert!(!facts.agent.reachable, "no socket, but something answered on it");
            assert_eq!(facts.agent.keys, 0);
        }
        assert!(!facts.agent.usable() || facts.agent.reachable);
    }

    #[tokio::test]
    async fn an_ssh_remote_nobody_lent_a_key_to_says_whose_key_it_uses() {
        // Nothing is forced onto git for an ssh push, and the reason names the
        // thing a person can act on: the place's key, not theirs.
        let here = Place::Here {
            root: std::env::temp_dir().display().to_string(),
        };
        let (args, why) = here
            .git_credential_args("mo", "git@github.com:Uniskool/naridon.git")
            .await;
        assert!(args.is_empty(), "an ssh clone was given a credential helper");
        assert!(
            why.contains("ssh") || why.contains("key"),
            "an ssh push must say it spends a key: {why}"
        );
    }

    // -- a key that never lands on the place --------------------------------

    #[test]
    fn a_place_with_no_agent_pushes_with_its_own_key_and_says_so() {
        // The default, and the one that must never quietly look like the
        // member's own key: nobody opted this place in, so nothing of theirs
        // reaches it.
        let plan = choose(&ssh_ask("mo"), &facts(), sources(None));
        assert!(plan.credential.is_none(), "a key appeared that nobody lent");
        let agent = &plan.considered[0];
        assert_eq!(agent.source, "ssh-agent");
        assert!(!agent.held);
        assert!(agent.why.contains("no ssh agent of yours"), "{}", agent.why);
    }

    #[tokio::test]
    async fn an_ssh_push_still_reports_what_was_asked_and_why_it_declined() {
        // The reason a gap is not returned as an error: a member told "it uses
        // the place's key" needs to know whether their agent was absent, dead,
        // or simply empty — and only the list of what was asked says which.
        let here = Place::Here {
            root: std::env::temp_dir().display().to_string(),
        };
        let plan = here
            .push_credential("mo", "git@github.com:Uniskool/naridon.git")
            .await
            .expect("the place answered");
        assert_eq!(plan.host, "github.com");
        assert_eq!(plan.considered.len(), 3);
        if plan.credential.is_none() {
            assert!(
                matches!(plan.gap, Some(NoCredential::PushesWithAnSshKey { .. })),
                "{:?}",
                plan.gap
            );
        }
        for c in plan.considered.iter().filter(|c| c.source != "ssh-agent") {
            assert!(!c.held, "{} offered a stored credential to an ssh push", c.source);
            assert!(c.why.contains("spends a key"), "{}", c.why);
        }
    }

    #[test]
    fn a_lent_agent_pushes_as_the_member_without_the_key_landing_there() {
        let plan = choose(&ssh_ask("mo"), &lending(), sources(None));
        let cred = plan.credential.expect("the member's own key");
        assert_eq!(cred.source, "ssh-agent");
        assert!(!cred.shared, "a key in your own agent is not everybody's");
        assert!(!cred.last_resort);
        // The whole point, in the sentence a person reads.
        assert!(cred.label.contains("mo's own ssh key"), "{}", cred.label);
        assert!(
            cred.detail.contains("never written to aura-runner"),
            "{}",
            cred.detail
        );
        // And git is configured with nothing at all: ssh spends the key, and
        // clearing `credential.helper` would break the https remotes beside it.
        assert!(cred.helper.is_empty());
        assert!(cred.git_config_args().is_empty());
    }

    #[test]
    fn a_socket_with_nothing_answering_is_not_a_working_agent() {
        // What a stale forwarding looks like — and it must not read as a live
        // one, or a push fails after claiming it would go out as the member.
        let mut f = lending();
        f.agent.reachable = false;
        let why = ForwardedAgent
            .offer(&ssh_ask("mo"), &f)
            .expect_err("a dead socket is not an agent");
        assert!(why.contains("nothing is answering"), "{why}");

        let mut empty = lending();
        empty.agent.keys = 0;
        let why = ForwardedAgent
            .offer(&ssh_ask("mo"), &empty)
            .expect_err("an agent with no keys signs nothing");
        assert!(why.contains("ssh-add"), "{why}");
    }

    #[test]
    fn an_agent_the_machine_runs_itself_is_not_the_members_key() {
        // The one way "a key in an agent" could still be the old bug: a box with
        // an agent of its own would sign happily, and every surface would say
        // the push went out as the member. Fingerprints are what tell them apart.
        let mut theirs = lending();
        theirs.agent.fingerprints = vec!["SHA256:a-key-this-laptop-has-never-held".into()];
        theirs.agent.mine = theirs.agent.shares_a_key_with(&[MY_KEY.to_string()]);
        assert!(!theirs.agent.mine);
        let why = ForwardedAgent
            .offer(&ssh_ask("mo"), &theirs)
            .expect_err("the machine's own agent is not the member's");
        assert!(why.contains("the machine's key rather than yours"), "{why}");

        // And the same agent, holding a key this laptop holds, is.
        let mut ours = theirs.clone();
        ours.agent.fingerprints.push(MY_KEY.into());
        ours.agent.mine = ours.agent.shares_a_key_with(&[MY_KEY.to_string()]);
        assert!(ForwardedAgent.offer(&ssh_ask("mo"), &ours).is_ok());
    }

    #[test]
    fn a_key_and_a_stored_credential_are_never_offered_for_the_same_push() {
        // Each kind of remote is answered by the sources that can actually be
        // spent on it, so nothing ever reports "you are pushing as yourself"
        // while the other kind of secret goes over the wire.
        let over_ssh = choose(&ssh_ask("mo"), &lending(), sources(None));
        assert_eq!(over_ssh.credential.expect("a key").source, "ssh-agent");
        for c in over_ssh.considered.iter().filter(|c| c.source != "ssh-agent") {
            assert!(!c.held, "{} offered a stored credential to an ssh push", c.source);
        }

        let over_https = choose(&ask("mo"), &lending(), sources(None));
        assert_eq!(
            over_https.credential.expect("a credential").source,
            "member-store"
        );
        let agent = over_https
            .considered
            .iter()
            .find(|c| c.source == "ssh-agent")
            .expect("still asked");
        assert!(!agent.held, "a key was offered to an https push");
    }

    #[test]
    fn the_survey_reads_an_agent_back_as_a_fact_about_the_place() {
        let out = "___AURA_GITCRED___\nyou=mo\nmember=present\nhelper=\ndefault_store=\n\
                   agent=reachable\nagent_socket=/tmp/ssh-abc/agent.7\nagent_keys=3\n\
                   agent_fingerprints=SHA256:one,SHA256:two,SHA256:three,\n";
        let f = parse_survey("aura-runner", out).expect("facts");
        assert!(f.agent.usable());
        assert_eq!(f.agent.keys, 3);
        assert_eq!(f.agent.socket, "/tmp/ssh-abc/agent.7");
        assert_eq!(f.agent.fingerprints, ["SHA256:one", "SHA256:two", "SHA256:three"]);
        // Whose they are is not something one end of a connection can see, so
        // the survey never claims it.
        assert!(!f.agent.mine);
        assert!(f.agent.shares_a_key_with(&["SHA256:two".to_string()]));
        assert!(!f.agent.shares_a_key_with(&["SHA256:four".to_string()]));

        // A place nobody opted in says so plainly rather than by omission.
        let none = "___AURA_GITCRED___\nyou=mo\nmember=present\nhelper=\ndefault_store=\n\
                    agent=absent\nagent_socket=\nagent_keys=0\n";
        let f = parse_survey("aura-runner", none).expect("facts");
        assert!(!f.agent.usable() && !f.agent.reachable);
    }

    /// The parity rule, for this source specifically: it is chosen from facts
    /// the place reported, so the same `impl` answers for this laptop and for a
    /// box, and neither could be given the ability without the other.
    #[test]
    fn the_agent_source_reads_the_same_facts_whatever_kind_of_place_it_is() {
        let here = PlaceGitFacts {
            place: "this laptop".into(),
            agent: AgentFacts {
                socket: "/private/tmp/com.apple.launchd.X/Listeners".into(),
                reachable: true,
                keys: 1,
                fingerprints: vec![MY_KEY.into()],
                mine: true,
            },
            ..PlaceGitFacts::default()
        };
        let on_a_box = PlaceGitFacts {
            place: "aura-runner".into(),
            ..here.clone()
        };
        assert_eq!(
            ForwardedAgent.offer(&ssh_ask("mo"), &here).expect("here").source,
            ForwardedAgent
                .offer(&ssh_ask("mo"), &on_a_box)
                .expect("there")
                .source
        );
    }

    /// The governing rule of this programme, made structural rather than
    /// remembered: no feature may land in one place-mode only.
    ///
    /// Nothing here can tell a box you brought from one Aura provisioned,
    /// because there is nothing here to tell it WITH — a machine's `box_kind`
    /// never reaches this module. So the day the managed arm exists, it cannot
    /// arrive with a credential arrangement BYOC does not have, or without one.
    #[test]
    fn choosing_a_credential_never_asks_what_kind_of_place_this_is() {
        let src = include_str!("place_git.rs");
        let code = src
            .lines()
            .take_while(|l| !l.starts_with("#[cfg(test)]"))
            .filter(|l| !l.trim_start().starts_with("//"))
            .collect::<Vec<_>>()
            .join("\n");
        for asked in ["box_kind", "managed", "provisioning_mode", "is_byoc"] {
            assert!(
                !code.contains(asked),
                "place_git branches on `{asked}` — one place-mode is about to get a \
                 credential arrangement the other doesn't"
            );
        }
    }
}
