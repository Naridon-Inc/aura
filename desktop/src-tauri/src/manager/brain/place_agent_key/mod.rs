//! Which credential an agent run spends, and whose it is.
//!
//! The tenth question in the runtime contract, and the one the ledger has been
//! unable to answer since there was a ledger: **when this member starts an agent
//! at this place, whose key pays for the tokens?**
//!
//! ## What "the org's key" actually meant
//!
//! `010_org_ai_keys.sql` put three columns on `organizations` —
//! `anthropic_api_key`, `openai_api_key`, `gemini_api_key` — and
//! `ai::generate_for_org` spends whichever one the provider picks, for every
//! member of that org, with the server's own environment behind it as a second
//! silent fallback. On a box it is the same shape one level down: `provision.sh`
//! writes `ANTHROPIC_API_KEY` into `/etc/aura-runner/agent.env`, systemd loads it
//! for the unit, and every agent any member starts there inherits it.
//!
//! One key, everyone, and every spend looking identical afterwards. The bill is
//! real and lands somewhere; what is missing is *whose run made it*, and a total
//! nobody can attribute is a total nobody can act on.
//!
//! That org key is not being removed. It is the last source in the chain
//! ([`OrgKey`]), and on a team that pays centrally it is the *right* answer — it
//! just stops being the silent one. It answers last, it says whose it is, and
//! every surface about to spend it can name it first.
//!
//! ## Why a seam before a mechanism
//!
//! There are at least five ways an agent run can be authenticated: the member's
//! own sign-in on the place, an API key in the member's own home, the key the
//! machine itself holds, the org's key, and — the day it exists — a key Aura
//! mints per member per run. Written as five call sites the fifth is a redesign.
//! Written against [`KeySource`] it is one `impl` and one line in [`sources`].
//!
//! So this file is a contract first:
//!
//! * the ask — [`AgentKeyAsk`], `(member, engine)`
//! * the answer — [`AgentKey`], and how a run is told about it ([`KeyLoad`])
//! * the named failure — [`NoAgentKey`], never a bare string
//! * the chain — [`sources`], with last-resort sources forced to the end by
//!   [`super::place_git::last_resort_last`] rather than by whoever edits the list
//!
//! It is deliberately the same shape as [`super::place_git`], which answers the
//! same question about pushes. Two credentials, two chains, one discipline — and
//! the ordering rule itself is shared code rather than a habit repeated twice.
//!
//! ## What never happens here
//!
//! **No key material is ever held, printed, or written.** The survey reports
//! whether a file *sets* the variable, never what it sets it to; [`AgentKey`]
//! carries the variable's NAME and a way to load it, never a value; and the org
//! read ([`org`]) keeps the server's mask and nothing else.
//!
//! **Nothing here writes a member's key anywhere, and least of all box-wide.**
//! The survey only reads and the run prefix only sources. A key the place reports
//! in a box-wide directory is never called a member's own, however it is owned —
//! see [`is_box_wide`] and [`MemberKey`]. A credential in `/etc` is the
//! machine's, and calling it one member's would be this whole bug wearing a
//! fix's clothes.
//!
//! ## Why the sources are pure
//!
//! Every source decides from [`PlaceKeyFacts`] — one survey, one round trip,
//! read off the place through [`Place::ask`] like every other verb here. A source
//! that reached the place itself would be a second door to the wire (see
//! [`crate::cloudbox::sole_ssh`]) and would cost a round trip each on a box
//! across an ocean. A source whose material lives somewhere else entirely — the
//! org's settings — is handed what it needs at construction time, in
//! [`sources`], where the asking is allowed to happen.

mod org;

use serde::{Deserialize, Serialize};

use super::place::Place;
use super::place_account::is_bootstrap_login;
use super::place_git::{last_resort_last, member_for, Considered, StoreFile};
use crate::cloudbox::script::quote;

pub use org::{org_keyring, OrgKeyring};

/// Marks the start of the survey the script prints. Split in the rendered script
/// for the same reason [`super::place_account`] splits its own: a line that
/// contains its own marker matches itself.
const SURVEY: &str = "___AURA_AGENTKEY___";

/// Where a machine keeps a credential for everybody on it.
///
/// What `aura runner creds set` writes and what the unit loads — one file, one
/// mode, every member. It is a real answer and it keeps working; it is simply
/// not anybody's own.
const PLACE_KEY_FILE: &str = "/etc/aura-runner/agent.env";

/// Where a member keeps one of their own, under their own home.
///
/// The same path `aura runner install --user` already writes a member's runner
/// token beside, at `0600` in a `0700` directory — so a place that has given its
/// members accounts ([`super::place_account`]) has somewhere private for this
/// without inventing a new location.
const MEMBER_KEY_FILE: &str = ".config/aura/agent.env";

/// How one agent CLI can be authenticated, and what its spend is called.
///
/// `var` is the environment variable the CLI already reads — we populate the
/// environment it looks at rather than inventing a scheme. `login_file` is the
/// other half: signing in interactively writes no key at all, and a chain that
/// only knew about keys would tell a perfectly authenticated member they have
/// nothing.
pub struct EngineAuth {
    /// The binary a person picks in the agent picker.
    pub engine: &'static str,
    /// Who the bill comes from, in the words on the invoice.
    pub provider: &'static str,
    pub var: &'static str,
    /// Where the CLI's own sign-in lands, relative to `$HOME`.
    pub login_file: &'static str,
    /// What a human runs, on the place, to create that file.
    pub login_cmd: &'static str,
    /// The field the org's settings hold this provider's key under — the JSON
    /// key of `GET /orgs/{slug}/ai-keys`, which is `organizations.<field>_api_key`
    /// on the other side of it.
    pub org_field: &'static str,
}

/// The three engines Aura knows how to authenticate.
///
/// A short list on purpose. An engine that is not here is not refused — the run
/// happens and spends whatever the place holds — it is only that nothing can be
/// *said* about whose credential that is, and saying so is better than implying
/// the member's own was chosen.
const ENGINES: [EngineAuth; 3] = [
    EngineAuth {
        engine: "claude",
        provider: "Anthropic",
        var: "ANTHROPIC_API_KEY",
        login_file: ".claude/.credentials.json",
        login_cmd: "claude setup-token",
        org_field: "anthropic",
    },
    EngineAuth {
        engine: "codex",
        provider: "OpenAI",
        var: "OPENAI_API_KEY",
        login_file: ".codex/auth.json",
        login_cmd: "codex login",
        org_field: "openai",
    },
    EngineAuth {
        engine: "gemini",
        provider: "Google",
        var: "GEMINI_API_KEY",
        login_file: ".gemini/oauth_creds.json",
        login_cmd: "gemini",
        org_field: "gemini",
    },
];

/// The ways of signing in this build knows, for an engine that isn't one of them.
pub fn known_engines() -> String {
    ENGINES
        .iter()
        .map(|e| e.engine)
        .collect::<Vec<_>>()
        .join(", ")
}

fn engine_auth(engine: &str) -> Option<&'static EngineAuth> {
    let e = engine.trim().to_ascii_lowercase();
    ENGINES.iter().find(|w| w.engine == e)
}

/// Who is running an agent, and which one.
///
/// Two fields because a credential is only meaningful as a pair. A key without
/// an engine is a secret looking for somewhere to be spent; an engine without a
/// member is the bug this whole file is about.
#[derive(Debug, Clone, PartialEq)]
pub struct AgentKeyAsk {
    /// The member the run is for — the person, not the machine.
    pub member: String,
    /// The engine, as its binary is spelled.
    pub engine: String,
    /// Whose invoice a spend on it appears on.
    pub provider: String,
    /// The variable the engine reads its key from.
    pub var: String,
    /// Where its own sign-in lands, relative to a home directory.
    pub login_file: String,
    /// The field the org's settings hold this provider's key under.
    pub org_field: String,
}

impl AgentKeyAsk {
    pub fn new(member: &str, engine: &str) -> Result<Self, NoAgentKey> {
        let member = member.trim().to_string();
        if member.is_empty() {
            return Err(NoAgentKey::NoMember);
        }
        let engine = engine.trim().to_ascii_lowercase();
        let auth = engine_auth(&engine).ok_or_else(|| NoAgentKey::UnknownEngine {
            engine: engine.clone(),
            known: known_engines(),
        })?;
        Ok(AgentKeyAsk {
            member,
            engine,
            provider: auth.provider.into(),
            var: auth.var.into(),
            login_file: auth.login_file.into(),
            org_field: auth.org_field.into(),
        })
    }
}

/// How a run comes to have the credential that was chosen for it.
///
/// Four cases because there are four honestly different mechanisms, and
/// flattening them into "a path" would lose the two that have no file at all. A
/// surface can render any of them; a run can only *load* the second.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "load", rename_all = "snake_case")]
pub enum KeyLoad {
    /// The engine reads its own sign-in from the member's home. Nothing to load
    /// and nothing to set: the CLI finds it where it left it.
    OwnLogin { path: String },
    /// A file holding `VAR=…` that the run sources before starting the engine.
    /// Only ever a file the resolver judged one member's own.
    EnvFile { path: String },
    /// The variable is already in the environment the work starts in — a systemd
    /// `EnvironmentFile`, a profile, whatever an admin set. Nothing to load
    /// because it is already loaded.
    AlreadyInEnv,
    /// The material is not at the place at all. Whoever spawns the run puts it in
    /// the environment under [`AgentKey::var`]; nothing is ever written down
    /// there.
    Injected,
}

impl KeyLoad {
    /// The shell fragment that puts this credential in front of one command.
    ///
    /// Empty for three of the four, and that is the point rather than an
    /// omission: a sign-in needs no variable, an inherited environment already
    /// has one, and an injected key is the caller's to place. Only a file is
    /// sourced — read, never written, and guarded to a readable one so a file
    /// that vanished between the survey and the run leaves the session working
    /// rather than printing an error nobody asked for.
    pub fn prefix(&self) -> String {
        match self {
            KeyLoad::EnvFile { path } => format!(
                "if [ -r {p} ]; then set -a; . {p}; set +a; fi; ",
                p = quote(path)
            ),
            _ => String::new(),
        }
    }
}

/// What an agent run at a place will spend.
///
/// Everything a surface needs to name it, and nothing a surface could leak. The
/// two facts the engine itself has no opinion about are the ones this type
/// exists to carry: whose credential it is, and whether it was the only one
/// left.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct AgentKey {
    /// Which implementation answered — `member-login`, `member-key`,
    /// `place-key`, `org-key`, or whatever is added next.
    pub source: String,
    /// What to put on screen before spending it. Written for a person, by the
    /// source that knows what it is.
    pub label: String,
    /// Where it came from, in the place's own words — a path, or the org's
    /// settings. Never a value.
    pub detail: String,
    pub engine: String,
    pub provider: String,
    /// The variable the engine reads it from. A NAME; there is no field on this
    /// type that could hold what it is set to.
    pub var: String,
    pub load: KeyLoad,
    /// Whose spend this run is, in words a person can check against a bill.
    pub spender: String,
    /// Is this everybody-here's rather than this member's? The one fact a
    /// surface must never round off: a shared key works fine and bills somebody
    /// else.
    pub shared: bool,
    /// Was this only reached because nothing more specific answered?
    pub last_resort: bool,
}

impl AgentKey {
    /// How to give one command this credential and nothing else.
    pub fn prefix(&self) -> String {
        self.load.prefix()
    }
}

/// Why this place has no credential for this ask.
///
/// A named failure rather than a string, because none of the three is "something
/// went wrong": nobody named, an engine Aura has never been taught to
/// authenticate, and a place where nothing holds a key for this provider are
/// three different next steps.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "gap", rename_all = "snake_case")]
pub enum NoAgentKey {
    /// Nobody was named. A credential is per person or it is the bug this file
    /// exists about.
    NoMember,
    /// An engine this build doesn't know how to authenticate. The run still
    /// happens — it just spends whatever the place holds, and nothing here can
    /// honestly say whose that is.
    UnknownEngine { engine: String, known: String },
    /// Every source was asked and none of them holds one.
    NoneHeld {
        engine: String,
        /// Which sources were asked, so the answer names what was tried rather
        /// than implying there is one way to have a key.
        tried: Vec<String>,
    },
}

impl std::fmt::Display for NoAgentKey {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            NoAgentKey::NoMember => write!(
                f,
                "Nobody is named as the one running this, so there is no credential to look for."
            ),
            NoAgentKey::UnknownEngine { engine, known } => write!(
                f,
                "Aura doesn't know how {engine} signs in, so this run spends whatever the place \
                 already holds — the engines it can say that about are {known}."
            ),
            NoAgentKey::NoneHeld { engine, tried } => write!(
                f,
                "Nothing here holds a key {engine} can use — asked: {}.",
                tried.join(", ")
            ),
        }
    }
}

/// What the place said about itself, once, for every source to read.
///
/// Facts, not judgements: whether a file exists, who owns it and whether it sets
/// the variable is the place's business; whether that makes the credential
/// *yours* is a source's. Keeping the two apart is what lets a source be tested
/// without a machine and a survey be trusted without reading the sources.
#[derive(Debug, Clone, Default, PartialEq)]
pub struct PlaceKeyFacts {
    /// What to call this place in a sentence — "this laptop", or the box's name.
    pub place: String,
    /// The login the survey ran as.
    pub you: String,
    /// Does the member have an account here at all?
    pub member_present: bool,
    /// The engine's own sign-in, in the member's home. `holds` is whether the
    /// file has anything in it — the contents are the CLI's business and none of
    /// ours.
    pub member_login: StoreFile,
    /// The member's own key file. `holds` is whether it sets the variable.
    pub member_key: StoreFile,
    /// The key this machine holds for everybody on it.
    pub place_key: StoreFile,
    /// Is the variable already set in the environment work starts in here?
    ///
    /// A fact about the machine, not about a member: it is what a systemd
    /// `EnvironmentFile` or a line in `/etc/profile` leaves behind, so it is
    /// everybody's by construction.
    pub env_holds: bool,
}

/// One way of having a credential for an agent.
///
/// Sources are pure and synchronous on purpose — see the module docs. A source
/// answers from what the place already said, or says why it cannot, and the
/// "why" is shown to the person rather than swallowed: "you have no account on
/// this box yet" and "your key file has no Anthropic key in it" send someone to
/// two different places.
pub trait KeySource: Send + Sync {
    /// Stable id, used in reports and in the failure's `tried` list.
    fn id(&self) -> &'static str;

    /// Is this a credential of last resort — one that works, but only because
    /// there is nothing more specific? Sources like this are moved to the end
    /// whatever order [`sources`] happens to list them in.
    fn last_resort(&self) -> bool {
        false
    }

    /// The credential, or the reason there isn't one.
    fn offer(&self, ask: &AgentKeyAsk, facts: &PlaceKeyFacts) -> Result<AgentKey, String>;
}

/// The member's own sign-in, made by the member, on the place.
///
/// The best answer of the four and the cheapest to arrange: `claude setup-token`
/// in the member's own account writes a credential only that account can read,
/// no key is typed into a machine, and the spend lands on the person who
/// approved it. It is the answer a shared box is *supposed* to give once its
/// members have accounts ([`super::place_account`]).
pub struct MemberLogin;

impl KeySource for MemberLogin {
    fn id(&self) -> &'static str {
        "member-login"
    }

    fn offer(&self, ask: &AgentKeyAsk, facts: &PlaceKeyFacts) -> Result<AgentKey, String> {
        if is_bootstrap_login(&ask.member) {
            return Err(format!(
                "{} is the login this place came with, so a sign-in in its home is everybody's \
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
        let file = &facts.member_login;
        if !file.exists {
            return Err(format!(
                "{} hasn't signed {} in on {} — one `{}` there and this run is on their own \
                 account.",
                ask.member,
                ask.engine,
                facts.place,
                login_cmd(&ask.engine)
            ));
        }
        if file.holds.is_none() {
            return Err(format!(
                "{}'s own {} sign-in can't be read from this login — sign in as {} to use it.",
                ask.member, ask.engine, ask.member
            ));
        }
        if file.holds == Some(false) {
            return Err(format!(
                "{}'s {} sign-in file is empty, so there is nothing in it to run on.",
                ask.member, ask.engine
            ));
        }
        if !file.owner.is_empty() && file.owner != ask.member {
            return Err(format!(
                "{} is owned by {}, so it isn't {}'s to run on.",
                file.path, file.owner, ask.member
            ));
        }
        if !file.private() {
            return Err(format!(
                "{} is readable by others on this place, so it is not one member's sign-in.",
                file.path
            ));
        }
        Ok(AgentKey {
            source: self.id().into(),
            label: format!("{}'s own {} sign-in on {}", ask.member, ask.engine, facts.place),
            detail: format!("{}, readable only by {}", file.path, ask.member),
            engine: ask.engine.clone(),
            provider: ask.provider.clone(),
            var: ask.var.clone(),
            // Nothing to set: the engine reads its own file, and exporting a
            // variable beside it would send the run to an API key that isn't
            // the one the member approved.
            load: KeyLoad::OwnLogin {
                path: file.path.clone(),
            },
            spender: ask.member.clone(),
            shared: false,
            last_resort: false,
        })
    }
}

/// The member's own API key, in their own home, readable by nobody else.
///
/// For the half of the world that pays per token rather than by subscription. It
/// is deliberately strict about what counts as "own": the file has to be the
/// member's, closed to everyone else, under a home rather than under the
/// machine, and the login has to be a *person's* rather than the one the image
/// came with.
pub struct MemberKey;

impl KeySource for MemberKey {
    fn id(&self) -> &'static str {
        "member-key"
    }

    fn offer(&self, ask: &AgentKeyAsk, facts: &PlaceKeyFacts) -> Result<AgentKey, String> {
        if is_bootstrap_login(&ask.member) {
            return Err(format!(
                "{} is the login this place came with, so a key in its home is everybody's \
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
        let file = &facts.member_key;
        // The rule this whole task is against, applied to the answer rather than
        // trusted from the question: a credential under a machine-wide directory
        // is the machine's however it is owned, and a home that resolves into
        // one is a misconfiguration, not a member.
        if is_box_wide(&file.path) {
            return Err(format!(
                "{} is a place the whole machine can be pointed at, so a key there is never one \
                 member's.",
                file.path
            ));
        }
        if !file.exists {
            return Err(format!(
                "{} holds no {} key of their own here.",
                ask.member, ask.provider
            ));
        }
        if file.holds.is_none() {
            return Err(format!(
                "{}'s own key file can't be read from this login — sign in as {} to use it.",
                ask.member, ask.member
            ));
        }
        if file.holds == Some(false) {
            return Err(format!(
                "{}'s own key file has no {} in it.",
                ask.member, ask.var
            ));
        }
        if !file.owner.is_empty() && file.owner != ask.member {
            return Err(format!(
                "{} is owned by {}, so it isn't {}'s to spend.",
                file.path, file.owner, ask.member
            ));
        }
        if !file.private() {
            return Err(format!(
                "{} is readable by others on this place, so it is not one member's key.",
                file.path
            ));
        }
        Ok(AgentKey {
            source: self.id().into(),
            label: format!("{}'s own {} key on {}", ask.member, ask.provider, facts.place),
            detail: format!("{}, readable only by {}", file.path, ask.member),
            engine: ask.engine.clone(),
            provider: ask.provider.clone(),
            var: ask.var.clone(),
            load: KeyLoad::EnvFile {
                path: file.path.clone(),
            },
            spender: ask.member.clone(),
            shared: false,
            last_resort: false,
        })
    }
}

/// Implementation zero, one level down: whatever key this machine already holds.
///
/// The credential every agent on a provisioned runner has always used — the one
/// `provision.sh` writes and the unit loads. Nothing about it changes except its
/// standing: it answers after the member's own, it says it is everybody's, and a
/// surface about to spend it can name it first.
pub struct PlaceKey;

impl KeySource for PlaceKey {
    fn id(&self) -> &'static str {
        "place-key"
    }

    fn last_resort(&self) -> bool {
        true
    }

    fn offer(&self, ask: &AgentKeyAsk, facts: &PlaceKeyFacts) -> Result<AgentKey, String> {
        let file = &facts.place_key;
        // A file we can look at, so we say what is in it rather than promising a
        // run will work.
        if file.usable() {
            return Ok(AgentKey {
                source: self.id().into(),
                label: format!(
                    "the {} key on {} — everyone here runs on this one",
                    ask.provider, facts.place
                ),
                detail: format!("{}, loaded for every agent this machine starts", file.path),
                engine: ask.engine.clone(),
                provider: ask.provider.clone(),
                var: ask.var.clone(),
                load: KeyLoad::EnvFile {
                    path: file.path.clone(),
                },
                spender: format!("whoever pays for {}", facts.place),
                shared: true,
                last_resort: true,
            });
        }
        if facts.env_holds {
            return Ok(AgentKey {
                source: self.id().into(),
                label: format!(
                    "the {} key {} already has in its environment — everyone here runs on this one",
                    ask.provider, facts.place
                ),
                detail: format!(
                    "{} is set for the work {} starts, wherever an admin set it",
                    ask.var, facts.place
                ),
                engine: ask.engine.clone(),
                provider: ask.provider.clone(),
                var: ask.var.clone(),
                // Already loaded. Sourcing anything on top would be a second
                // answer to a question that has one.
                load: KeyLoad::AlreadyInEnv,
                spender: format!("whoever pays for {}", facts.place),
                shared: true,
                last_resort: true,
            });
        }
        if file.exists && file.holds == Some(false) {
            return Err(format!("{} has no {} in it.", file.path, ask.var));
        }
        if file.exists && file.holds.is_none() {
            return Err(format!(
                "{} is there but can't be read as {} — it is root's, and this login isn't.",
                file.path, facts.you
            ));
        }
        Err(format!(
            "{} holds no {} key of its own.",
            facts.place, ask.provider
        ))
    }
}

/// The org's key, from the org's settings — the one this task demotes.
///
/// `organizations.{anthropic,openai,gemini}_api_key`, which is what every member
/// of an org has been spending without being told. It stays, because a team that
/// pays centrally wants exactly this; it is last, it is labelled, and it says out
/// loud that the bill lands on the org rather than on the person.
///
/// It is the one source whose material is not at the place at all, which is why
/// it is constructed with what it needs ([`OrgKeyring`]) rather than reading
/// anything itself.
pub struct OrgKey(pub OrgKeyring);

impl KeySource for OrgKey {
    fn id(&self) -> &'static str {
        "org-key"
    }

    fn last_resort(&self) -> bool {
        true
    }

    fn offer(&self, ask: &AgentKeyAsk, _facts: &PlaceKeyFacts) -> Result<AgentKey, String> {
        let ring = &self.0;
        if ring.org.trim().is_empty() {
            return Err(
                "you aren't acting as an org here, so there is no org key to fall back to.".into(),
            );
        }
        if let Some(masked) = ring.held(&ask.org_field) {
            return Ok(AgentKey {
                source: self.id().into(),
                label: format!(
                    "{}'s shared {} key — every member's runs spend it",
                    ring.org, ask.provider
                ),
                detail: format!(
                    "held in {}'s settings as {}_api_key ({masked}), not on this place",
                    ring.org, ask.org_field
                ),
                engine: ask.engine.clone(),
                provider: ask.provider.clone(),
                var: ask.var.clone(),
                // Never written to a machine. Whoever starts the run puts it in
                // the environment for that run and nowhere else.
                load: KeyLoad::Injected,
                spender: ring.org.clone(),
                shared: true,
                last_resort: true,
            });
        }
        if !ring.visible {
            return Err(format!(
                "whether {} holds a {} key can't be read from here — {}",
                ring.org, ask.provider, ring.reason
            ));
        }
        Err(format!(
            "{} has no {} key in its settings.",
            ring.org, ask.provider
        ))
    }
}

/// Every way of having a credential for an agent, in the order they are asked.
///
/// Adding a fifth is one line here and one `impl` above — which is the whole
/// reason the seam is worth more than the mechanisms in it.
pub fn sources(org: OrgKeyring) -> Vec<Box<dyn KeySource>> {
    vec![
        Box::new(MemberLogin),
        Box::new(MemberKey),
        Box::new(PlaceKey),
        Box::new(OrgKey(org)),
    ]
}

/// What an agent run would actually spend, and what else was asked on the way.
///
/// `considered` is not debugging output. When the answer is the org's key, the
/// only useful thing a person can be told is *why* — "you have no account on this
/// box" and "your key file has no Anthropic key in it" lead to two different next
/// steps, and neither is guessable from the answer alone.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct KeyPlan {
    pub member: String,
    pub engine: String,
    pub provider: String,
    pub var: String,
    /// What to call the place in a sentence, so a surface can say it without
    /// asking again.
    pub place: String,
    /// The credential a run would spend. `None` means [`KeyPlan::gap`] says why.
    pub key: Option<AgentKey>,
    pub gap: Option<NoAgentKey>,
    pub considered: Vec<Considered>,
}

impl KeyPlan {
    /// The shell fragment a run starts with. Empty is the ordinary answer.
    pub fn prefix(&self) -> String {
        self.key.as_ref().map(AgentKey::prefix).unwrap_or_default()
    }

    /// The one line the session announces before the engine takes the terminal.
    ///
    /// The session is where a person watching a run actually is, so this is
    /// where the fact belongs — the same bargain [`Place::clone_project`] makes
    /// for a clone. One phrasing, here, so every surface that spends a
    /// credential says it the same way.
    pub fn note(&self) -> String {
        match &self.key {
            Some(key) if key.shared => format!(
                "Running on {}. This is not {}'s own credential — the spend lands on {}.",
                key.label, self.member, key.spender
            ),
            Some(key) => format!("Running on {}.", key.label),
            None => self.gap.as_ref().map(NoAgentKey::to_string).unwrap_or_default(),
        }
    }
}

/// Ask every source, in order, and take the first that answers.
///
/// Last-resort sources are moved to the end by [`last_resort_last`] rather than
/// being *listed* last, so a future edit to [`sources`] cannot quietly promote
/// the org's key back to first by putting it at the top of a list. That is the
/// one property this task exists to guarantee, so it is enforced by the code
/// that chooses rather than by the order of a literal — and it is the same
/// function [`super::place_git::choose`] enforces it with, because it is the
/// same rule.
pub fn choose(
    ask: &AgentKeyAsk,
    facts: &PlaceKeyFacts,
    sources: Vec<Box<dyn KeySource>>,
) -> KeyPlan {
    let ordered = last_resort_last(sources, |s| s.last_resort());

    let mut considered = vec![];
    let mut chosen: Option<AgentKey> = None;
    for source in &ordered {
        match source.offer(ask, facts) {
            Ok(key) => {
                considered.push(Considered {
                    source: source.id().into(),
                    held: true,
                    why: key.label.clone(),
                    last_resort: source.last_resort(),
                });
                if chosen.is_none() {
                    chosen = Some(key);
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

    let gap = chosen.is_none().then(|| NoAgentKey::NoneHeld {
        engine: ask.engine.clone(),
        tried: ordered.iter().map(|s| s.id().to_string()).collect(),
    });
    KeyPlan {
        member: ask.member.clone(),
        engine: ask.engine.clone(),
        provider: ask.provider.clone(),
        var: ask.var.clone(),
        place: facts.place.clone(),
        key: chosen,
        gap,
        considered,
    }
}

/// Is this path the machine's rather than one member's?
///
/// Not a permission check — a location check, and the two are different. A file
/// in `/etc` can be `0600` and owned by a member and still be the machine's: it
/// is on the path an admin, an image, or `provision.sh` writes for everybody,
/// and the next run of any of those owns it. A member's own credential lives
/// under a member's own home or it is not one member's.
pub fn is_box_wide(path: &str) -> bool {
    let p = path.trim();
    ["/etc/", "/usr/", "/opt/", "/var/", "/srv/", "/tmp/"]
        .iter()
        .any(|dir| p.starts_with(dir))
}

/// What a member runs, at the place, to sign an engine in as themselves.
fn login_cmd(engine: &str) -> String {
    engine_auth(engine)
        .map(|a| a.login_cmd.to_string())
        .unwrap_or_else(|| engine.to_string())
}

/// Ask the place everything the sources need, in one round trip.
///
/// POSIX `sh`, not bash: the same script runs under `ssh` on a distro whose
/// `/bin/sh` is dash and under `sh -c` on this laptop, and there is exactly one
/// of it for both — a second spelling for the local arm would agree for as long
/// as nobody fixed anything.
///
/// It only ever READS. Nothing here creates a file, copies one, or changes a
/// mode, which is what makes "a member's credential is never written box-wide" a
/// property of the rendered script rather than a promise about the code around
/// it.
pub fn survey_script(ask: &AgentKeyAsk) -> String {
    let login = quote(&ask.member);
    let var = quote(&ask.var);
    let login_file = quote(&ask.login_file);
    let member_key = quote(MEMBER_KEY_FILE);
    let place_key = quote(PLACE_KEY_FILE);
    format!(
        r#"set -u
LOGIN={login}
VAR={var}
LOGIN_REL={login_file}
KEY_REL={member_key}
PLACE_KEY={place_key}
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

MEMBER_LOGIN=""
MEMBER_KEY=""
if [ -n "$MEMBER_HOME" ]; then
  MEMBER_LOGIN="$MEMBER_HOME/$LOGIN_REL"
  MEMBER_KEY="$MEMBER_HOME/$KEY_REL"
fi

# Is the variable already in the environment work starts in here? PRESENCE
# ONLY — the value is never read, never printed and never sent back. `eval` is
# how POSIX sh reads a variable whose name it holds in another variable, and the
# name comes from this file's own table rather than from anything a person typed.
eval "HELD=\${{$VAR:-}}"
ENV_HOLDS=no
[ -n "$HELD" ] && ENV_HOLDS=yes

# Does a file SET the variable? Two anchored greps rather than one loose match:
# `grep ANTHROPIC_API_KEY` also matches a comment about it, and a comment
# authenticates nothing.
sets() {{
  [ -e "$1" ] || {{ printf 'missing'; return; }}
  [ -r "$1" ] || {{ printf 'unreadable'; return; }}
  if grep -q "^$VAR=" "$1" 2>/dev/null || grep -q "^export $VAR=" "$1" 2>/dev/null
  then printf 'yes'; else printf 'no'; fi
}}
# A sign-in file is the engine's own format and none of our business. The only
# thing worth knowing is whether there is anything in it at all.
filled() {{
  [ -e "$1" ] || {{ printf 'missing'; return; }}
  [ -r "$1" ] || {{ printf 'unreadable'; return; }}
  if [ -s "$1" ]; then printf 'yes'; else printf 'no'; fi
}}
# `ls -l` rather than `stat`: the flags for that differ between GNU and BSD, and
# this script has to read the same on both.
mode_of() {{ ls -ld "$1" 2>/dev/null | cut -c1-10; }}
owner_of() {{ ls -ld "$1" 2>/dev/null | tr -s ' ' | cut -d' ' -f3; }}

echo "___AURA""_AGENTKEY___"
echo "you=$ME"
echo "member=$MEMBER"
echo "member_login=$MEMBER_LOGIN"
echo "member_login_holds=$([ -n "$MEMBER_LOGIN" ] && filled "$MEMBER_LOGIN" || printf 'missing')"
echo "member_login_mode=$([ -n "$MEMBER_LOGIN" ] && mode_of "$MEMBER_LOGIN")"
echo "member_login_owner=$([ -n "$MEMBER_LOGIN" ] && owner_of "$MEMBER_LOGIN")"
echo "member_key=$MEMBER_KEY"
echo "member_key_holds=$([ -n "$MEMBER_KEY" ] && sets "$MEMBER_KEY" || printf 'missing')"
echo "member_key_mode=$([ -n "$MEMBER_KEY" ] && mode_of "$MEMBER_KEY")"
echo "member_key_owner=$([ -n "$MEMBER_KEY" ] && owner_of "$MEMBER_KEY")"
echo "place_key=$PLACE_KEY"
echo "place_key_holds=$(sets "$PLACE_KEY")"
echo "place_key_mode=$(mode_of "$PLACE_KEY")"
echo "place_key_owner=$(owner_of "$PLACE_KEY")"
echo "env_holds=$ENV_HOLDS"
"#
    )
}

/// Read the survey back.
///
/// Everything before the marker is the place's own noise — a MOTD, a sudo
/// lecture, whatever a profile prints — and is dropped rather than parsed around.
pub fn parse_survey(place: &str, out: &str) -> Result<PlaceKeyFacts, String> {
    let body = out
        .split_once(SURVEY)
        .map(|(_, rest)| rest)
        .ok_or_else(|| "the place didn't say which keys it holds".to_string())?;
    let f = |k: &str| -> String {
        body.lines()
            .filter_map(|l| l.trim().split_once('='))
            .find(|(key, _)| *key == k)
            .map(|(_, v)| v.trim().to_string())
            .unwrap_or_default()
    };
    let file = |prefix: &str| -> StoreFile {
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
    Ok(PlaceKeyFacts {
        place: place.to_string(),
        you,
        member_present: f("member") == "present",
        member_login: file("member_login"),
        member_key: file("member_key"),
        place_key: file("place_key"),
        env_holds: f("env_holds") == "yes",
    })
}

impl Place {
    /// Which credential an agent run here, by this member, would spend.
    ///
    /// One call for both place-modes, because it is a `Place` method and the
    /// survey is one script through [`Place::ask`]: this laptop answers it about
    /// its own home, a box answers it about the box's, and neither has an
    /// implementation the other lacks.
    pub async fn agent_key(
        &self,
        member: &str,
        engine: &str,
        org: OrgKeyring,
    ) -> Result<KeyPlan, NoAgentKey> {
        let ask = AgentKeyAsk::new(member, engine)?;
        let out = self
            .ask(survey_script(&ask))
            .await
            .map_err(|detail| NoAgentKey::NoneHeld {
                engine: ask.engine.clone(),
                tried: vec![format!("couldn't ask this place: {detail}")],
            })?;
        let facts = parse_survey(self.label(), &out).map_err(|detail| NoAgentKey::NoneHeld {
            engine: ask.engine.clone(),
            tried: vec![detail],
        })?;
        Ok(choose(&ask, &facts, sources(org)))
    }

    /// What one agent run starts with, and what it says it is running on.
    ///
    /// Two strings rather than a plan because that is all the session needs: the
    /// fragment that puts the credential in front of the engine, and the
    /// sentence printed before it starts. Both empty is a real answer — an
    /// engine Aura can't speak for, a place that couldn't be asked — and it
    /// leaves the run exactly as it was before this file existed rather than
    /// refusing to start over a credential question.
    pub async fn agent_key_spend(&self, member: &str, engine: &str) -> (String, String) {
        match self.agent_key(member, engine, org_keyring().await).await {
            Ok(plan) => (plan.prefix(), plan.note()),
            Err(gap) => (String::new(), gap.to_string()),
        }
    }
}

/// Which credential an agent run at a place would spend, before it is spent.
///
/// `machine_id` names a box; omit it and the answer is about this laptop, in
/// `root`. One command for both, so the day a managed place exists it is asked
/// this in the same words — and an unknown machine id is an error rather than a
/// quiet answer about the wrong computer, because "whose key is about to be
/// spent" answered about somewhere else is worse than unanswered.
#[tauri::command]
pub async fn place_agent_key(
    root: Option<String>,
    machine_id: Option<String>,
    engine: String,
    member: Option<String>,
) -> Result<KeyPlan, String> {
    let place = match machine_id.as_deref().map(str::trim).filter(|id| !id.is_empty()) {
        Some(id) => Place::at_machine(id)?,
        None => Place::resolve(root.unwrap_or_default(), None),
    };
    let member = member_for(&place, member.as_deref()).await;
    let engine_name = engine.trim().to_ascii_lowercase();
    match place.agent_key(&member, &engine, org_keyring().await).await {
        Ok(plan) => Ok(plan),
        // A gap is an answer about this place, not a failure of the call. A
        // surface has to be able to say "nothing here holds an Anthropic key for
        // you" without rendering it as an error.
        Err(gap) => Ok(KeyPlan {
            member,
            provider: engine_auth(&engine_name)
                .map(|a| a.provider.to_string())
                .unwrap_or_default(),
            var: engine_auth(&engine_name)
                .map(|a| a.var.to_string())
                .unwrap_or_default(),
            engine: engine_name,
            place: place.label().to_string(),
            key: None,
            gap: Some(gap),
            considered: vec![],
        }),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const MEMBER: &str = "mo";
    const TEAMMATE: &str = "ana";

    fn ask(member: &str) -> AgentKeyAsk {
        AgentKeyAsk::new(member, "claude").expect("a known engine")
    }

    /// A key file of somebody's own: theirs, closed, under their own home.
    fn own_key(member: &str) -> StoreFile {
        StoreFile {
            path: format!("/home/{member}/{MEMBER_KEY_FILE}"),
            exists: true,
            holds: Some(true),
            mode: "-rw-------".into(),
            owner: member.into(),
        }
    }

    /// A place with a key for everybody on it — what `provision.sh` leaves — and
    /// nobody's own anything.
    fn shared_box() -> PlaceKeyFacts {
        PlaceKeyFacts {
            place: "aura-runner".into(),
            you: MEMBER.into(),
            member_present: true,
            member_login: StoreFile::default(),
            member_key: StoreFile::default(),
            place_key: StoreFile {
                path: PLACE_KEY_FILE.into(),
                exists: true,
                holds: Some(true),
                mode: "-rw-------".into(),
                owner: "root".into(),
            },
            env_holds: true,
        }
    }

    fn org() -> OrgKeyring {
        OrgKeyring::empty("Naridon").holding("anthropic", "sk-a••••wxyz")
    }

    #[test]
    fn a_members_own_key_is_the_one_that_is_spent() {
        let facts = PlaceKeyFacts {
            member_key: own_key(MEMBER),
            ..shared_box()
        };
        let plan = choose(&ask(MEMBER), &facts, sources(org()));
        let key = plan.key.expect("a member with a key of their own got nothing");
        assert_eq!(key.source, "member-key");
        assert!(!key.shared && !key.last_resort, "{key:?}");
        assert_eq!(key.spender, MEMBER);
        // The run loads it, and loading is all it does.
        assert!(key.prefix().contains(&format!("/home/{MEMBER}/{MEMBER_KEY_FILE}")));
    }

    /// The whole point of the task, as an assertion: two people, one box, two
    /// credentials, two bills. This is the same fact `place_conformance`'s W12
    /// asks of every place-mode; here it is asked of the chain directly.
    #[test]
    fn two_members_on_one_place_spend_two_different_keys() {
        let mine = PlaceKeyFacts {
            member_key: own_key(MEMBER),
            ..shared_box()
        };
        let theirs = PlaceKeyFacts {
            you: TEAMMATE.into(),
            member_key: own_key(TEAMMATE),
            ..shared_box()
        };
        let a = choose(&ask(MEMBER), &mine, sources(org())).key.expect("mine");
        let b = choose(&ask(TEAMMATE), &theirs, sources(org()))
            .key
            .expect("theirs");
        assert_ne!(a.detail, b.detail, "one credential wearing two names");
        assert_ne!(a.prefix(), b.prefix(), "both runs load the same file");
        assert_eq!((a.spender.as_str(), b.spender.as_str()), (MEMBER, TEAMMATE));
        assert!(!a.shared && !b.shared);
    }

    /// A member's own sign-in beats a key: it is the credential they approved,
    /// and exporting an API key beside it would send the run somewhere else.
    #[test]
    fn a_sign_in_of_their_own_beats_every_key() {
        let facts = PlaceKeyFacts {
            member_login: StoreFile {
                path: format!("/home/{MEMBER}/.claude/.credentials.json"),
                exists: true,
                holds: Some(true),
                mode: "-rw-------".into(),
                owner: MEMBER.into(),
            },
            member_key: own_key(MEMBER),
            ..shared_box()
        };
        let key = choose(&ask(MEMBER), &facts, sources(org())).key.expect("a key");
        assert_eq!(key.source, "member-login");
        assert_eq!(key.load, KeyLoad::OwnLogin { path: format!("/home/{MEMBER}/.claude/.credentials.json") });
        // Nothing is exported over a sign-in the member made.
        assert!(key.prefix().is_empty());
    }

    #[test]
    fn the_org_key_is_reached_only_when_nothing_of_the_members_answers() {
        let facts = PlaceKeyFacts {
            place_key: StoreFile::default(),
            env_holds: false,
            ..shared_box()
        };
        let plan = choose(&ask(MEMBER), &facts, sources(org()));
        let key = plan.key.expect("an org with a key offered nothing");
        assert_eq!(key.source, "org-key");
        assert!(key.shared, "the org's key did not admit it is everybody's");
        assert!(key.last_resort, "the org's key was not demoted");
        assert_eq!(key.spender, "Naridon");
        assert!(
            key.label.contains("Naridon") && key.label.contains("Anthropic"),
            "a shared key that doesn't say whose: {}",
            key.label
        );
        // And the person is told why they are on it, which is the actionable half.
        assert!(
            plan.considered.iter().any(|c| !c.held && c.why.contains("no account")
                || !c.held && c.why.contains("hasn't signed")),
            "nothing said why the member's own credential wasn't used: {:?}",
            plan.considered
        );
    }

    /// The property this file exists to guarantee, tested against the failure it
    /// is guarding: somebody puts the org key at the top of the list.
    #[test]
    fn the_org_key_cannot_be_promoted_by_reordering_the_list() {
        let facts = PlaceKeyFacts {
            member_key: own_key(MEMBER),
            ..shared_box()
        };
        let upside_down: Vec<Box<dyn KeySource>> = vec![
            Box::new(OrgKey(org())),
            Box::new(PlaceKey),
            Box::new(MemberKey),
            Box::new(MemberLogin),
        ];
        let key = choose(&ask(MEMBER), &facts, upside_down).key.expect("a key");
        assert_eq!(key.source, "member-key");
    }

    /// A box-wide file is the machine's however it is owned. `/etc` is written by
    /// images, by `provision.sh` and by whoever has root — the next run of any of
    /// them owns it.
    #[test]
    fn a_key_in_a_box_wide_directory_is_never_called_a_members_own() {
        let facts = PlaceKeyFacts {
            member_key: StoreFile {
                path: "/etc/aura-runner/agent.env".into(),
                exists: true,
                holds: Some(true),
                mode: "-rw-------".into(),
                owner: MEMBER.into(),
            },
            ..shared_box()
        };
        let plan = choose(&ask(MEMBER), &facts, sources(org()));
        let key = plan.key.expect("a place with a key offered nothing");
        assert_ne!(key.source, "member-key");
        assert!(key.shared, "a key in /etc was offered as one member's");
        assert!(is_box_wide("/etc/aura-runner/agent.env"));
        assert!(is_box_wide("/var/lib/aura/agent.env"));
        assert!(!is_box_wide(&format!("/home/{MEMBER}/{MEMBER_KEY_FILE}")));
        assert!(!is_box_wide("/Users/mo/.config/aura/agent.env"));
    }

    /// A credential in the home of the login the image came with is everybody's,
    /// because everybody who can reach the box is that login.
    #[test]
    fn the_bootstrap_logins_own_home_is_not_one_members() {
        let facts = PlaceKeyFacts {
            you: "ubuntu".into(),
            member_key: own_key("ubuntu"),
            ..shared_box()
        };
        let plan = choose(&AgentKeyAsk::new("ubuntu", "claude").unwrap(), &facts, sources(org()));
        let key = plan.key.expect("a key");
        assert!(key.shared, "ubuntu's home was treated as one member's");
    }

    #[test]
    fn a_member_whose_file_others_can_read_does_not_have_one_of_their_own() {
        let facts = PlaceKeyFacts {
            member_key: StoreFile {
                mode: "-rw-r--r--".into(),
                ..own_key(MEMBER)
            },
            ..shared_box()
        };
        let plan = choose(&ask(MEMBER), &facts, sources(org()));
        assert_eq!(plan.key.expect("a key").source, "place-key");
        assert!(plan
            .considered
            .iter()
            .any(|c| c.source == "member-key" && c.why.contains("readable by others")));
    }

    /// "We could not read it" is not "it has nothing in it". A member's own file
    /// is `0600` in a `0700` home, so a survey run as somebody else *should* land
    /// here — and it must send the person to sign in as themselves rather than
    /// telling them they have no key.
    #[test]
    fn a_file_we_cannot_read_says_so_rather_than_saying_empty() {
        let facts = PlaceKeyFacts {
            you: TEAMMATE.into(),
            member_key: StoreFile {
                holds: None,
                ..own_key(MEMBER)
            },
            ..shared_box()
        };
        let plan = choose(&ask(MEMBER), &facts, sources(org()));
        assert!(plan
            .considered
            .iter()
            .any(|c| c.source == "member-key" && c.why.contains(&format!("sign in as {MEMBER}"))));
    }

    #[test]
    fn an_environment_the_machine_carries_is_everybodys() {
        let facts = PlaceKeyFacts {
            place_key: StoreFile::default(),
            env_holds: true,
            ..shared_box()
        };
        let key = choose(&ask(MEMBER), &facts, sources(org())).key.expect("a key");
        assert_eq!(key.source, "place-key");
        assert_eq!(key.load, KeyLoad::AlreadyInEnv);
        // Already loaded: a second loader would be a second answer.
        assert!(key.prefix().is_empty());
        assert!(key.shared);
    }

    #[test]
    fn a_place_and_an_org_with_nothing_is_an_answer_with_its_reasons() {
        let facts = PlaceKeyFacts {
            place_key: StoreFile::default(),
            env_holds: false,
            ..shared_box()
        };
        let plan = choose(&ask(MEMBER), &facts, sources(OrgKeyring::default()));
        assert!(plan.key.is_none());
        match plan.gap.as_ref().expect("a named gap") {
            NoAgentKey::NoneHeld { engine, tried } => {
                assert_eq!(engine, "claude");
                assert_eq!(tried.len(), 4, "the answer didn't say what was asked");
            }
            other => panic!("{other:?}"),
        }
        assert!(plan.note().contains("Nothing here holds"), "{}", plan.note());
    }

    #[test]
    fn an_engine_aura_cannot_speak_for_is_named_rather_than_guessed_about() {
        let gap = AgentKeyAsk::new(MEMBER, "kimi").expect_err("kimi is not in the table");
        match &gap {
            NoAgentKey::UnknownEngine { engine, known } => {
                assert_eq!(engine, "kimi");
                assert!(known.contains("claude") && known.contains("gemini"));
            }
            other => panic!("{other:?}"),
        }
        // And what it says is what a person can act on, not an apology.
        assert!(gap.to_string().contains("spends whatever the place already holds"));
    }

    #[test]
    fn nobody_named_is_refused_before_a_place_is_asked_anything() {
        assert_eq!(
            AgentKeyAsk::new("   ", "claude").expect_err("a nameless ask"),
            NoAgentKey::NoMember
        );
    }

    /// A shared credential works. What it must never do is read as the member's.
    #[test]
    fn the_sentence_for_a_shared_key_says_whose_the_bill_is() {
        let facts = PlaceKeyFacts {
            place_key: StoreFile::default(),
            env_holds: false,
            ..shared_box()
        };
        let note = choose(&ask(MEMBER), &facts, sources(org())).note();
        assert!(note.contains("not mo's own credential"), "{note}");
        assert!(note.contains("Naridon"), "{note}");
    }

    #[test]
    fn the_sentence_for_a_members_own_key_is_one_line_and_names_them() {
        let facts = PlaceKeyFacts {
            member_key: own_key(MEMBER),
            ..shared_box()
        };
        let note = choose(&ask(MEMBER), &facts, sources(org())).note();
        assert_eq!(note, "Running on mo's own Anthropic key on aura-runner.");
    }

    #[test]
    fn the_survey_reads_and_never_writes() {
        // The rule "a member's credential is never written box-wide" is a
        // property of what we send, so it is asserted against what we send.
        let script = survey_script(&ask(MEMBER));
        for writes in ["tee ", "chmod", "chown", "mkdir", "cp ", "mv ", "> \"$", ">> "] {
            assert!(
                !script.contains(writes),
                "the survey does something other than read: {writes}"
            );
        }
        // And it never sends a value back, only whether there is one: the
        // variable holding the key is tested for emptiness and never printed.
        assert!(script.contains("ENV_HOLDS=yes"));
        for line in script.lines().filter(|l| l.trim_start().starts_with("echo ")) {
            assert!(
                !line.contains("HELD"),
                "the survey prints the key itself: {line}"
            );
        }
    }

    #[test]
    fn the_survey_asks_about_the_member_rather_than_the_login_it_runs_as() {
        let script = survey_script(&ask(MEMBER));
        assert!(script.contains("LOGIN='mo'"));
        assert!(script.contains("getent passwd"), "a member's home is guessed");
        assert!(script.contains("VAR='ANTHROPIC_API_KEY'"));
        assert!(script.contains("PLACE_KEY='/etc/aura-runner/agent.env'"));
    }

    /// The survey has to run where it is sent. `sh -n` is the only check that
    /// catches a quoting mistake in a heredoc-free script of this size.
    #[test]
    fn the_rendered_survey_parses_as_posix_sh() {
        for engine in ["claude", "codex", "gemini"] {
            let script = survey_script(&AgentKeyAsk::new("mo's account", engine).unwrap());
            let dir = std::env::temp_dir().join(format!("aura-agentkey-{engine}"));
            std::fs::create_dir_all(&dir).expect("a temp dir");
            let path = dir.join("survey.sh");
            std::fs::write(&path, &script).expect("write the script");
            let out = std::process::Command::new("sh")
                .arg("-n")
                .arg(&path)
                .output()
                .expect("run sh -n");
            assert!(
                out.status.success(),
                "{engine}: {}",
                String::from_utf8_lossy(&out.stderr)
            );
            let _ = std::fs::remove_file(&path);
        }
    }

    #[test]
    fn the_survey_reads_back_as_the_facts_it_reported() {
        let out = format!(
            "Welcome to Ubuntu 24.04\n{SURVEY}\n\
             you=mo\nmember=present\n\
             member_login=/home/mo/.claude/.credentials.json\nmember_login_holds=no\n\
             member_login_mode=-rw-------\nmember_login_owner=mo\n\
             member_key=/home/mo/.config/aura/agent.env\nmember_key_holds=yes\n\
             member_key_mode=-rw-------\nmember_key_owner=mo\n\
             place_key=/etc/aura-runner/agent.env\nplace_key_holds=unreadable\n\
             place_key_mode=-rw-------\nplace_key_owner=root\n\
             env_holds=no\n"
        );
        let facts = parse_survey("aura-runner", &out).expect("facts");
        assert_eq!(facts.you, "mo");
        assert!(facts.member_present);
        assert_eq!(facts.member_key.holds, Some(true));
        assert!(facts.member_key.private());
        // Empty is not missing, and unreadable is neither.
        assert_eq!(facts.member_login.holds, Some(false));
        assert!(facts.member_login.exists);
        assert_eq!(facts.place_key.holds, None);
        assert!(facts.place_key.exists);
        assert!(!facts.env_holds);

        // And that place, asked about mo, runs on mo's key.
        let key = choose(&ask(MEMBER), &facts, sources(org())).key.expect("a key");
        assert_eq!(key.source, "member-key");
    }

    #[test]
    fn a_place_that_says_nothing_is_a_failure_rather_than_an_empty_answer() {
        assert!(parse_survey("aura-runner", "Permission denied (publickey)").is_err());
        assert!(parse_survey("aura-runner", &format!("{SURVEY}\nmember=present\n")).is_err());
    }

    /// The loader is a `.`, once, guarded — never a write, and never a value on a
    /// command line where `ps` could read it.
    #[test]
    fn the_run_prefix_sources_a_file_and_does_nothing_else() {
        let load = KeyLoad::EnvFile {
            path: "/home/mo/.config/aura/agent.env".into(),
        };
        let prefix = load.prefix();
        assert_eq!(
            prefix,
            "if [ -r '/home/mo/.config/aura/agent.env' ]; then set -a; . '/home/mo/.config/aura/agent.env'; set +a; fi; "
        );
        assert!(!prefix.contains("export ANTHROPIC_API_KEY="));
        // A path with a space or a quote in it is one word or it is a command.
        let odd = KeyLoad::EnvFile {
            path: "/home/mo's box/agent.env".into(),
        };
        assert!(odd.prefix().contains(r"'/home/mo'\''s box/agent.env'"));
        for quiet in [KeyLoad::AlreadyInEnv, KeyLoad::Injected] {
            assert!(quiet.prefix().is_empty());
        }
    }

    /// Nothing in the chain may ask what kind of place it is holding. The moment
    /// one does, that is a credential a managed place gets and a box you brought
    /// does not — the failure this whole programme is arranged against.
    #[test]
    fn choosing_a_key_never_asks_what_kind_of_place_this_is() {
        let src = include_str!("mod.rs");
        let body = src
            .split_once("pub trait KeySource")
            .expect("the trait is still here")
            .1
            .split_once("#[cfg(test)]")
            .expect("the tests are still here")
            .0;
        for variant in ["Place::Here", "Place::Box", "kind ==", "\"managed\"", "\"shared\""] {
            assert!(
                !body.contains(variant),
                "a source branches on the kind of place ({variant})"
            );
        }
    }

    #[tokio::test]
    async fn this_laptop_answers_the_question_about_itself() {
        // Not a string test: the same survey, through the local arm, parsed by
        // the same parser. Whatever this machine holds, the answer has to be a
        // set of facts rather than an error — the local arm is a place-mode and
        // gets everything the box arm gets.
        let here = Place::Here {
            root: std::env::temp_dir().display().to_string(),
        };
        let plan = here
            .agent_key("nobody-by-this-name", "claude", OrgKeyring::default())
            .await
            .expect("this laptop answered the survey");
        assert_eq!(plan.member, "nobody-by-this-name");
        assert_eq!(plan.var, "ANTHROPIC_API_KEY");
        assert_eq!(plan.considered.len(), 4, "{:?}", plan.considered);
        // A login that doesn't exist has nothing of its own, wherever this runs.
        assert!(plan
            .considered
            .iter()
            .any(|c| c.source == "member-key" && !c.held));
    }
}
