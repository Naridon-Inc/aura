//! Getting a member's secrets into a place's environment, and nowhere near a
//! model.
//!
//! [`super::secret_vault`] answers *what is held and for whom*. This answers the
//! other half: **how does it get there, on both kinds of place, without passing
//! through the agent on the way?**
//!
//! ## The one rule
//!
//! A model cannot echo a secret it never saw. So the value's whole journey is
//! vault → process environment, and every step of that journey is chosen for
//! being somewhere a prompt cannot reach:
//!
//! | | This laptop | A box |
//! |---|---|---|
//! | How it arrives | the child process's env, set before `exec` | a `0600` file in the member's own home, sourced by the boot line |
//! | How it crosses the wire | it doesn't | on ssh's **stdin**, never in argv |
//! | What the agent is told | nothing | nothing |
//!
//! The stdin part is the one worth defending. A command handed to `ssh` is
//! argv — it shows up in `ps` on this laptop, in `ps` on the box while sshd
//! execs it, and in any `-v` output somebody pastes into a bug report. A token
//! written into a heredoc inside that command would be a token published to
//! every process table it passes through, which is a worse leak than the shared
//! credential this feature exists to replace. So [`super::place::Place::deliver`]
//! pipes the bytes instead, and the command itself is just `cat > file`.
//!
//! ## Why the preamble is `set -a` and not `export`
//!
//! The remote boot line has to load the file without the *names* becoming a
//! second thing that can be got wrong. `set -a; . file; set +a` exports whatever
//! the file assigns and stops; an `export A B C` line would have to restate
//! every name, and a name restated in two places is a name that will eventually
//! disagree with itself.
//!
//! ## What "never in a transcript" is enforced by, not merely intended by
//!
//! [`BootSecrets`] is not `Serialize` — there is no derive that could put one on
//! the wire to the frontend — and its [`std::fmt::Debug`] prints names only. The
//! commands here hand back [`super::secret_vault::SecretRef`], which has no
//! value field at all. And [`BootSecrets::redact`] is applied to the one path
//! where text an agent already wrote comes *back* as context: the pre-roll
//! reader in [`crate::cmd_agent_history`], which re-feeds a CLI's own transcript
//! into an Aura chat. Nothing puts a secret there — but that path is the only
//! one where a value that somehow reached a log would become a value inside a
//! prompt, so it is scrubbed rather than trusted.

use serde::{Deserialize, Serialize};

use super::place::Place;
use super::place_forge::Forge;
use super::secret_vault::{now, Held, SecretRef, SecretScope, Vault};
use crate::cloudbox::script::quote;

/// Where a member's environment file lives on a place they are a guest on.
///
/// Under the member's own home rather than anywhere shared, because after
/// [`super::place_account`] a box has one home per member and that home is
/// `0700`. A file in `/tmp` — or in the bootstrap login's home — would be
/// readable by everyone else with a shell there, which is this whole feature's
/// starting bug.
const REMOTE_ENV_DIR: &str = ".config/aura/env";

/// What a place's environment gets at boot.
///
/// Deliberately not `Serialize`, not `Clone`, and printed by name only. The type
/// system is doing the work here: a surface that wanted to render one of these
/// would have to write the serializer itself.
pub struct BootSecrets {
    scope: SecretScope,
    pairs: Vec<(String, String)>,
}

impl std::fmt::Debug for BootSecrets {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("BootSecrets")
            .field("member", &self.scope.member)
            .field("project", &self.scope.project)
            .field("names", &self.names())
            .finish()
    }
}

impl BootSecrets {
    /// Everything this member holds for this project.
    pub fn open(scope: SecretScope) -> Result<Self, String> {
        let vault = Vault::open(scope)?;
        Ok(BootSecrets {
            pairs: vault.env_pairs(),
            scope: vault.scope().clone(),
        })
    }

    /// The same, under a given home — how this is tested without writing into
    /// the person running the tests.
    pub fn open_under(home: &std::path::Path, scope: SecretScope) -> Result<Self, String> {
        let vault = Vault::open_under(home, scope)?;
        Ok(BootSecrets {
            pairs: vault.env_pairs(),
            scope: vault.scope().clone(),
        })
    }

    /// Nothing held — the case every project starts in and most stay in.
    pub fn none(scope: SecretScope) -> Self {
        BootSecrets {
            scope,
            pairs: vec![],
        }
    }

    pub fn is_empty(&self) -> bool {
        self.pairs.is_empty()
    }

    pub fn scope(&self) -> &SecretScope {
        &self.scope
    }

    /// The names, which are safe to say out loud — they are what a person needs
    /// to see to know their work will find its token.
    pub fn names(&self) -> Vec<String> {
        self.pairs.iter().map(|(k, _)| k.clone()).collect()
    }

    /// The pairs to put on a process. The only accessor that hands out values,
    /// and its one production caller sets them on a `CommandBuilder`.
    pub fn pairs(&self) -> &[(String, String)] {
        &self.pairs
    }

    /// The body of the environment file a box sources at boot.
    ///
    /// Values go through the same `quote` every other string bound for a remote
    /// shell does, so a token containing a quote, a backtick or a newline is
    /// still exactly itself on the other side.
    pub fn env_file(&self) -> String {
        let mut out = String::from("# Written by Aura at boot. Do not edit; do not commit.\n");
        for (k, v) in &self.pairs {
            out.push_str(&format!("{k}={}\n", quote(v)));
        }
        out
    }

    /// Take every held value out of a piece of text.
    ///
    /// Longest first, so a token that contains a shorter one does not leave the
    /// shorter one's tail behind. Defence in depth rather than the mechanism:
    /// nothing in Aura puts a value into text in the first place, and a filter
    /// that was the *only* thing standing between a secret and a prompt would be
    /// a list of the shapes somebody happened to think of.
    pub fn redact(&self, text: &str) -> String {
        if self.pairs.is_empty() || text.is_empty() {
            return text.to_string();
        }
        let mut values: Vec<&(String, String)> = self.pairs.iter().collect();
        values.sort_by_key(|(_, v)| std::cmp::Reverse(v.len()));
        let mut out = text.to_string();
        for (name, value) in values {
            // A one-character "secret" would turn a page of prose into
            // redaction markers. Real credentials are not that, and refusing to
            // scrub for a value that short is more honest than pretending the
            // result is readable.
            if value.len() < 8 || !out.contains(value.as_str()) {
                continue;
            }
            out = out.replace(value.as_str(), &format!("«{name} — held by Aura»"));
        }
        out
    }

    /// The same, through every string in a piece of JSON.
    ///
    /// A CLI's transcript keeps its tool calls as JSON — the arguments it was
    /// given and the output it got back — and that is where an echoed value
    /// would actually be, not in prose. Walked in place rather than
    /// re-serialised so a transcript that holds nothing costs one traversal and
    /// no allocation.
    pub fn redact_json(&self, value: &mut serde_json::Value) {
        if self.pairs.is_empty() {
            return;
        }
        match value {
            serde_json::Value::String(s) => {
                let clean = self.redact(s);
                if clean != *s {
                    *s = clean;
                }
            }
            serde_json::Value::Array(items) => {
                for item in items {
                    self.redact_json(item);
                }
            }
            serde_json::Value::Object(map) => {
                for (_, v) in map.iter_mut() {
                    self.redact_json(v);
                }
            }
            _ => {}
        }
    }
}

/// Where this member's environment file goes on a place, relative to their home.
fn env_path(scope: &SecretScope) -> String {
    format!("~/{REMOTE_ENV_DIR}/{}.env", scope.project_key())
}

impl Place {
    /// What this member holds for the project this place is working on.
    ///
    /// The project is [`Place::here`] — the checkout on *this* laptop — in both
    /// place-modes, so one vault answers for a chat editing this disk and for
    /// the same chat editing a box. Keyed on the remote path instead, opening a
    /// project on a second machine would silently produce a second, empty vault.
    pub fn boot_secrets(&self, member: &str) -> Result<BootSecrets, String> {
        let scope = SecretScope::new(member, self.here())?;
        BootSecrets::open(scope)
    }

    /// Put this member's secrets where the work will find them, and hand back
    /// the line that loads them.
    ///
    /// `None` for this laptop: a local process is given its environment
    /// directly, so there is nothing to load and nothing written to disk. That
    /// asymmetry is the honest one — a file on this machine would be a copy of
    /// the vault sitting next to the vault.
    pub async fn install_secrets(&self, boot: &BootSecrets) -> Result<Option<String>, String> {
        if boot.is_empty() || !self.is_remote() {
            return Ok(None);
        }
        let path = env_path(&boot.scope);
        self.deliver(&path, 0o600, &boot.env_file()).await?;
        Ok(Some(preamble(&path)))
    }

    /// The same thing for work started **under tmux**, which needs a file in
    /// both place-modes.
    ///
    /// The difference from [`Place::install_secrets`] is not local-versus-remote,
    /// it is *how the work is started* — and getting that wrong is a silent
    /// failure rather than a loud one. A process this app spawns is handed its
    /// environment directly, so on this laptop there is nothing to write. A tmux
    /// session is not that: `tmux new-session` talks to a server that is already
    /// running, and the new session takes its environment from that server's,
    /// not from the shell that asked for it. Exporting around the command would
    /// reach nothing, on either kind of place.
    ///
    /// So the mechanism is the file either side: `0600`, in the member's own
    /// home, loaded inside the session's own process. On this laptop that is a
    /// second copy of values the vault already holds — worth it, because the
    /// alternative is `tmux -e NAME=value`, and that is argv, and argv is in
    /// `ps`.
    ///
    /// Empty string when there is nothing to load, which is most sessions.
    /// Never an error for "nobody is signed in": a member with no secrets must
    /// not be a member who cannot start a session.
    pub async fn install_session_secrets(&self, member: &str) -> Result<String, String> {
        let Ok(boot) = self.boot_secrets(member) else {
            return Ok(String::new());
        };
        if boot.is_empty() {
            return Ok(String::new());
        }
        let path = env_path(&boot.scope);
        self.deliver(&path, 0o600, &boot.env_file()).await?;
        Ok(preamble(&path))
    }

    /// Take this member's environment file off a place.
    ///
    /// Wanted when a member's access ends: the account may survive (it holds
    /// their history), but the token in it must not. Best-effort in the same
    /// sense [`Place::teardown_env`] is — a place that cannot be reached is not
    /// a reason to report the rest undone.
    pub async fn forget_secrets_here(&self, scope: &SecretScope) -> Result<bool, String> {
        if !self.is_remote() {
            return Ok(false);
        }
        let path = env_path(scope);
        let out = self
            .sh(
                &format!("rm -f {}", quote(&path.replace('~', "$HOME"))),
                std::time::Duration::from_secs(60),
            )
            .await?;
        Ok(out.ok())
    }
}

/// The line that loads an environment file, wherever it is.
///
/// `2>/dev/null || true` because a boot that *fails* over a missing environment
/// file is a boot that strands somebody in front of nothing. The file being
/// absent means no secrets, which is the ordinary case.
fn preamble(path: &str) -> String {
    let p = path.strip_prefix("~/").unwrap_or(path);
    format!("set -a; . \"$HOME\"/{} 2>/dev/null || true; set +a; ", quote(p))
}

/// Who this laptop is acting as, without asking anything or anyone.
///
/// The same answer [`super::place_account::member_account_login`] gives, because
/// it is the same function — a member whose account on a box is `mo` must not be
/// looked up in the vault as `mo-1`.
pub fn member_here() -> Result<String, String> {
    super::place_account::member_login_here()
}

/// A scope for the work happening in a checkout on this laptop, for the member
/// signed in here.
///
/// `Err` when nobody is signed in, which is a real state and not an error worth
/// failing a boot over — every caller treats it as "no secrets".
pub fn scope_here(root: &str) -> Result<SecretScope, String> {
    SecretScope::new(&member_here()?, root)
}

/// Everything the signed-in member holds for a checkout on this laptop.
///
/// Never fails: a boot that refused to start because nobody was signed in would
/// be a regression for every person who has no secrets at all, which is most of
/// them.
pub fn boot_here(root: &str) -> BootSecrets {
    match scope_here(root).and_then(BootSecrets::open) {
        Ok(boot) => boot,
        Err(_) => BootSecrets::none(SecretScope {
            member: String::new(),
            project: root.to_string(),
        }),
    }
}

/// What a surface is told about a place's secrets.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct SecretBoot {
    /// The place, in words for a person.
    pub place: String,
    pub member: String,
    /// The names that will be in the environment. Names only — the values are
    /// the one thing this whole module exists to keep out of here.
    pub names: Vec<String>,
    /// Did anything have to be written to the place? False for this laptop,
    /// where the environment is handed to the process directly.
    pub installed: bool,
    /// Where it was written, when it was. A path, never contents.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub at: Option<String>,
    /// The line a terminal on that place must run before the work, so the
    /// variables are in the *pane's* process rather than in whichever shell
    /// happened to start it.
    ///
    /// A path and two `set` commands — nothing here is a value, which is why it
    /// is allowed to cross to a surface at all. `None` for this laptop, where a
    /// process is handed its environment directly and there is nothing to load.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub preload: Option<String>,
}

/// What this member holds for this project.
///
/// The vault is on this laptop whichever place the work runs on, so this names
/// no machine — asking a box what secrets a member has would be asking the
/// wrong computer, and asking it over ssh would be sending them there to find
/// out.
#[tauri::command]
pub fn place_secret_list(root: String, member: Option<String>) -> Result<Vec<SecretRef>, String> {
    Ok(Vault::open(scope_for(&root, member.as_deref())?)?.list())
}

/// Keep a secret for this member and this project.
///
/// `value` comes in and never goes out: there is no command that reads one
/// back. That is not an omission — a "reveal" verb is a value on an IPC channel,
/// in a renderer's memory, and one `console.log` from a screenshot.
///
/// `git_host` is what turns a variable into a credential: with it set, a push to
/// that host spends this token. `git_forge` names the service when the host does
/// not give it away, and `git_user` overrides the username that service expects.
///
/// The account-name fallback is this command's own, and it belongs here rather
/// than in the vault: a self-hosted forge authenticates the *person*, and the
/// person is the member whose vault this is. So somebody adding a token for
/// `git.acme.internal` gets their own login sent as the username without having
/// to type it, while the vault itself still refuses to guess when nobody knows
/// who is asking.
#[tauri::command]
pub fn place_secret_put(
    root: String,
    member: Option<String>,
    name: String,
    value: String,
    git_host: Option<String>,
    git_user: Option<String>,
    git_forge: Option<String>,
) -> Result<Vec<SecretRef>, String> {
    let scope = scope_for(&root, member.as_deref())?;
    let mut vault = Vault::open(scope.clone())?;
    let mut held = Held::new(&name, &value, now())?;
    if let Some(host) = git_host.as_deref().map(str::trim).filter(|h| !h.is_empty()) {
        let forge = Forge::named_or_of_host(git_forge.as_deref(), host)?;
        let account = git_user
            .as_deref()
            .map(str::trim)
            .filter(|u| !u.is_empty())
            .or_else(|| forge.needs_account_name().then_some(scope.member.as_str()));
        held = held.for_git_on(host, Some(forge.id()), account)?;
    }
    vault.put(held)?;
    Ok(vault.list())
}

/// Drop a secret. What is already in a running process's environment stays
/// there — a boot is a boot, and this is about the next one.
#[tauri::command]
pub fn place_secret_forget(
    root: String,
    member: Option<String>,
    name: String,
) -> Result<Vec<SecretRef>, String> {
    let mut vault = Vault::open(scope_for(&root, member.as_deref())?)?;
    vault.forget(&name)?;
    Ok(vault.list())
}

/// Put this member's secrets where a place's next boot will find them.
///
/// `machine_id` names a box; omit it and the answer is about this laptop, in
/// `root`. One command for both modes — and an unknown machine id is an error
/// rather than a quiet answer about the wrong computer, because "where did my
/// token go" answered about somewhere else is worse than unanswered.
#[tauri::command]
pub async fn place_secret_boot(
    root: Option<String>,
    machine_id: Option<String>,
    member: Option<String>,
) -> Result<SecretBoot, String> {
    let here = root.unwrap_or_default();
    let place = match machine_id.as_deref().map(str::trim).filter(|id| !id.is_empty()) {
        Some(id) => Place::at_machine(id)?,
        None => Place::resolve(here.clone(), None),
    };
    // The project is always the checkout on this laptop, whichever place the
    // work runs on. A box that has never been told its local project falls back
    // to the root the caller named.
    let project = if place.here().trim().is_empty() {
        here
    } else {
        place.here().to_string()
    };
    let scope = SecretScope::new(&resolved_member(member.as_deref())?, &project)?;
    let boot = BootSecrets::open(scope)?;
    let preload = place.install_secrets(&boot).await?;
    Ok(SecretBoot {
        place: place.label().to_string(),
        member: boot.scope().member.clone(),
        names: boot.names(),
        installed: preload.is_some(),
        at: preload.is_some().then(|| env_path(boot.scope())),
        preload,
    })
}

fn scope_for(root: &str, member: Option<&str>) -> Result<SecretScope, String> {
    SecretScope::new(&resolved_member(member)?, root)
}

/// A named member wins; otherwise whoever is signed in here.
fn resolved_member(given: Option<&str>) -> Result<String, String> {
    match given.map(str::trim).filter(|m| !m.is_empty()) {
        Some(m) => Ok(m.to_string()),
        None => member_here(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::cmd_machines::Machine;

    fn block_on<F: std::future::Future>(f: F) -> F::Output {
        tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .expect("runtime")
            .block_on(f)
    }

    struct Home(std::path::PathBuf);

    impl Home {
        fn new(tag: &str) -> Self {
            let dir = std::env::temp_dir()
                .join(format!("aura-boot-secrets-{tag}-{}", std::process::id()));
            let _ = std::fs::remove_dir_all(&dir);
            std::fs::create_dir_all(&dir).unwrap();
            Home(dir)
        }

        /// A vault with one real-looking token in it.
        fn with(&self, member: &str, project: &str, name: &str, value: &str) -> BootSecrets {
            let scope = SecretScope::new(member, project).unwrap();
            let mut v = Vault::open_under(&self.0, scope.clone()).unwrap();
            v.put(
                Held::new(name, value, now())
                    .unwrap()
                    .for_git("github.com", None)
                    .unwrap(),
            )
            .unwrap();
            BootSecrets::open_under(&self.0, scope).unwrap()
        }
    }

    impl Drop for Home {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.0);
        }
    }

    fn a_box() -> Place {
        Place::Box {
            machine: Box::new(Machine {
                id: "mo@box:/home/mo/naridon".into(),
                name: "aura-runner".into(),
                host: "example.invalid".into(),
                user: "mo".into(),
                key_path: "/dev/null".into(),
                box_kind: "mine".into(),
                repo_path: Some("/home/mo/naridon".into()),
                repo_branch: None,
                project_root: Some("/w/naridon".into()),
                org_slug: None,
                added_at: 0,
                last_used_at: 0,
                forward_agent: false,
                instance_id: None,
                asleep_since: 0,
            }),
            root: "/home/mo/naridon".into(),
            here: "/w/naridon".into(),
        }
    }

    #[test]
    fn a_boot_carries_names_and_prints_no_values() {
        let home = Home::new("names");
        let boot = home.with("mo", "/w/naridon", "GITHUB_TOKEN", "ghp_supersecret_value");
        assert_eq!(boot.names(), vec!["GITHUB_TOKEN".to_string()]);
        let printed = format!("{boot:?}");
        assert!(!printed.contains("ghp_supersecret_value"), "{printed}");
        assert!(printed.contains("GITHUB_TOKEN"), "{printed}");
    }

    #[test]
    fn the_pairs_are_the_only_place_a_value_comes_out() {
        let home = Home::new("pairs");
        let boot = home.with("mo", "/w/naridon", "GITHUB_TOKEN", "ghp_supersecret_value");
        assert_eq!(
            boot.pairs(),
            [("GITHUB_TOKEN".to_string(), "ghp_supersecret_value".to_string())]
        );
    }

    #[test]
    fn an_env_file_survives_a_token_that_contains_shell() {
        let home = Home::new("quoting");
        let nasty = "gh'p; rm -rf ~ `whoami` $HOME";
        let boot = home.with("mo", "/w/naridon", "T", nasty);
        let file = boot.env_file();
        // Quoted, so the value is a value rather than four commands.
        assert!(file.contains(&format!("T={}", quote(nasty))), "{file}");
        assert!(!file.contains("T=gh'p; rm"), "{file}");
    }

    #[test]
    fn a_local_place_writes_nothing_and_loads_nothing() {
        let home = Home::new("local");
        let boot = home.with("mo", "/w/naridon", "GITHUB_TOKEN", "ghp_x_abcdefgh");
        let here = Place::Here {
            root: "/w/naridon".into(),
        };
        // A file on this machine would be a copy of the vault next to the vault.
        assert_eq!(block_on(here.install_secrets(&boot)).unwrap(), None);
    }

    #[test]
    fn a_tmux_session_gets_a_file_even_on_this_laptop() {
        // The one place the two mechanisms differ, and it is not
        // local-versus-remote: a process this app spawns is handed its
        // environment, but `tmux new-session` takes the tmux SERVER's, so a
        // session needs the file either side or it comes up with nothing.
        let home = Home::new("session-file");
        let boot = home.with("mo", "/w/naridon", "GITHUB_TOKEN", "ghp_x_abcdefghij");
        let here = Place::Here {
            root: "/w/naridon".into(),
        };
        let path = home.0.join("env-for-a-session.env");
        block_on(here.deliver(&path.to_string_lossy(), 0o600, &boot.env_file()))
            .expect("delivered");

        let written = std::fs::read_to_string(&path).expect("the file");
        assert!(written.contains("GITHUB_TOKEN='ghp_x_abcdefghij'"), "{written}");
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let mode = std::fs::metadata(&path).unwrap().permissions().mode() & 0o777;
            assert_eq!(mode, 0o600, "a token readable by anyone else on this laptop");
        }
        // And the line that loads it names the file rather than its contents.
        let line = preamble(&env_path(boot.scope()));
        assert!(!line.contains("ghp_"), "{line}");
    }

    #[test]
    fn a_session_for_a_member_holding_nothing_loads_nothing() {
        // Most sessions. It must not fail, and it must not write — a person with
        // no secrets is not a person who cannot start a shell.
        let here = Place::Here {
            root: "/w/definitely-not-a-project-anybody-has".into(),
        };
        let preload =
            block_on(here.install_session_secrets("nobody-who-could-have-a-vault")).unwrap();
        assert_eq!(preload, "");
    }

    #[test]
    fn a_member_with_nothing_held_installs_nothing_on_a_box() {
        let home = Home::new("empty");
        let boot =
            BootSecrets::open_under(&home.0, SecretScope::new("mo", "/w/naridon").unwrap())
                .unwrap();
        assert!(boot.is_empty());
        // No secrets means no round trip at all — this must not dial.
        assert_eq!(block_on(a_box().install_secrets(&boot)).unwrap(), None);
    }

    #[test]
    fn the_boot_line_loads_the_members_own_file_out_of_their_own_home() {
        let scope = SecretScope::new("mo", "/w/naridon").unwrap();
        let path = env_path(&scope);
        assert_eq!(path, format!("~/.config/aura/env/{}.env", scope.project_key()));

        let line = preamble(&path);
        // `$HOME` unquoted so the box resolves it, the rest quoted so the path
        // is a path. Two members on one box therefore load two different files
        // without either being named in the other's boot.
        assert!(line.starts_with("set -a; . \"$HOME\"/"), "{line}");
        assert!(line.ends_with("; set +a; "), "{line}");
        assert!(line.contains("|| true"), "a missing file must not fail a boot");
        assert!(line.contains(&scope.project_key()), "{line}");
    }

    #[test]
    fn two_projects_on_one_box_load_two_files() {
        let a = env_path(&SecretScope::new("mo", "/w/naridon").unwrap());
        let b = env_path(&SecretScope::new("mo", "/w/other").unwrap());
        assert_ne!(a, b);
    }

    #[test]
    fn redaction_takes_the_longest_match_first() {
        let home = Home::new("redact");
        let scope = SecretScope::new("mo", "/w/naridon").unwrap();
        let mut v = Vault::open_under(&home.0, scope.clone()).unwrap();
        v.put(Held::new("SHORT", "abcdefghij", now()).unwrap()).unwrap();
        v.put(Held::new("LONG", "abcdefghijklmnop", now()).unwrap())
            .unwrap();
        let boot = BootSecrets::open_under(&home.0, scope).unwrap();

        let out = boot.redact("the token is abcdefghijklmnop, use it");
        assert!(!out.contains("abcdefghij"), "a tail was left behind: {out}");
        assert!(out.contains("«LONG — held by Aura»"), "{out}");
    }

    #[test]
    fn redaction_leaves_ordinary_text_alone() {
        let home = Home::new("redact-noop");
        let boot = home.with("mo", "/w/naridon", "T", "ghp_supersecret_value");
        let prose = "I pushed the branch and CI went green.";
        assert_eq!(boot.redact(prose), prose);
        // And a vault with nothing in it is a no-op rather than a scan.
        let empty =
            BootSecrets::open_under(&home.0, SecretScope::new("ana", "/w/naridon").unwrap())
                .unwrap();
        assert_eq!(empty.redact("abcdefghijklmnop"), "abcdefghijklmnop");
    }

    #[test]
    fn a_short_value_is_not_scrubbed_into_unreadability() {
        let home = Home::new("short");
        let boot = home.with("mo", "/w/naridon", "T", "yes");
        // Otherwise every "yes" in a page of prose becomes a redaction marker,
        // and the result is less useful than the original was dangerous.
        assert_eq!(boot.redact("yes, that is right"), "yes, that is right");
    }

    /// The whole task, as one assertion.
    ///
    /// A brokered secret is followed through every surface that could carry it
    /// towards a model — the terminal that starts the agent, the boot line that
    /// runs on a box, the push plan the frontend renders, the list a settings
    /// pane shows, a panic's `Debug`, and a transcript replayed back as context —
    /// and it must be in none of them. Then the one place it *is*: the pairs
    /// handed to the process that does the work.
    ///
    /// Written as one test on purpose. Six separate ones would each pass while
    /// somebody added a seventh surface; this one is a list of everywhere a value
    /// is allowed to be, and the list has one entry.
    #[test]
    fn a_brokered_secret_never_appears_in_the_agents_context() {
        const TOKEN: &str = "ghp_a1b2c3d4e5f6g7h8i9j0klmnopqrstuvwxyz";
        let home = Home::new("never-in-context");
        let scope = SecretScope::new("mo", "/w/naridon").unwrap();
        let boot = home.with("mo", "/w/naridon", "GITHUB_TOKEN", TOKEN);

        // Everywhere it must not be, and what each one is.
        let mut surfaces: Vec<(&str, String)> = vec![];

        // 1. The terminal this laptop opens for an agent — argv and all.
        let here = Place::Here {
            root: "/w/naridon".into(),
        };
        let opened = block_on(here.open_booted(
            &crate::manager::brain::place_contract::Open::Agent {
                bin: "claude".into(),
                args: vec![],
                prompt: Some("fix the login redirect".into()),
                session: Some("aura-fix".into()),
            },
            &boot,
        ))
        .expect("a shell");
        surfaces.push(("the command line", opened.args.join(" ")));
        // 2. That same terminal on its way to a surface. `env` is `serde(skip)`,
        //    so what crosses carries no values even though the struct holds them.
        surfaces.push((
            "the terminal as it crosses to the frontend",
            serde_json::to_string(&opened).expect("json"),
        ));

        // 3. The line a box runs at boot, and the file's own path.
        let path = env_path(&scope);
        let line = crate::manager::brain::place_open::command(
            &crate::manager::brain::place_contract::Open::Shell {
                session: Some("aura-work".into()),
            },
            "/home/mo/naridon",
            &preamble(&path),
            None,
        )
        .expect("a boot line");
        surfaces.push(("the boot line", line.clone()));

        // 4. The push plan — rendered on screen before a token is spent.
        let held = Held::new("GITHUB_TOKEN", TOKEN, now())
            .unwrap()
            .for_git("github.com", None)
            .unwrap();
        let brokered =
            crate::manager::brain::place_git::Brokered::from_ref(&held.as_ref()).expect("brokered");
        let ask =
            crate::manager::brain::place_git::CredentialAsk::new("mo", "https://github.com/a/b")
                .expect("an ask");
        let plan = crate::manager::brain::place_git::choose(
            &ask,
            &Default::default(),
            crate::manager::brain::place_git::sources(Some(brokered)),
        );
        surfaces.push((
            "the push plan",
            serde_json::to_string(&plan).expect("json"),
        ));
        surfaces.push((
            "the git arguments",
            plan.credential
                .as_ref()
                .expect("a brokered credential")
                .git_config_args()
                .join(" "),
        ));

        // 5. The list a settings pane is given.
        surfaces.push((
            "the list of secrets",
            serde_json::to_string(&Vault::open_under(&home.0, scope.clone()).unwrap().list())
                .expect("json"),
        ));

        // 6. What a panic or a stray `dbg!` would print.
        surfaces.push(("a debug print", format!("{boot:?} {held:?}")));

        // 7. A transcript replayed back into a chat as context.
        surfaces.push((
            "a replayed transcript",
            boot.redact(&format!(
                "I ran `git push` and it worked. The token was {TOKEN}, by the way."
            )),
        ));

        for (what, text) in &surfaces {
            assert!(
                !text.contains(TOKEN),
                "the token reached {what}: {text}"
            );
        }

        // And the one place it is allowed to be: the environment of the process
        // doing the work. Everything above is the same secret, so a test that
        // passed because the vault was empty would fail here.
        assert_eq!(
            opened.env,
            [("GITHUB_TOKEN".to_string(), TOKEN.to_string())]
        );
        // The box gets it by loading its own file, named but not read here.
        assert!(line.contains(&scope.project_key()), "{line}");
        // And what the agent's own tooling is told is a variable, not a value.
        assert!(
            plan.credential.expect("cred").helper.contains("$GITHUB_TOKEN"),
            "the helper should name the variable"
        );
    }

    /// The acceptance criterion, run rather than asserted about.
    ///
    /// Three tokens — GitLab, Bitbucket and a self-hosted forge, the remotes the
    /// GitHub App cannot reach — go into a member's vault, out to a real `0600`
    /// file, and are loaded by the real boot line into a real `sh`. Then the
    /// credential helper git would run is run *in that shell*, and what it prints
    /// is what git would have been given.
    ///
    /// So this proves both halves of the claim at once: the credential arrives at
    /// boot, spelled the way each service needs it — and every surface a model
    /// can read, up to and including the command that started the shell, carries
    /// the name and never the value.
    #[test]
    fn every_forge_gets_a_per_member_credential_at_boot_the_agent_never_sees() {
        // Distinct values, so a surface carrying the wrong one still fails.
        let services: [(&str, &str, &str, Option<&str>, Option<&str>, &str); 3] = [
            (
                "GITLAB_TOKEN",
                "glpat_a1b2c3d4e5f6g7h8i9j0",
                "gitlab.com",
                None,
                None,
                "oauth2",
            ),
            (
                "BITBUCKET_TOKEN",
                "atbb_z9y8x7w6v5u4t3s2r1q0",
                "bitbucket.org",
                None,
                None,
                "x-token-auth",
            ),
            (
                "GIT_TOKEN",
                "gto_m1n2o3p4q5r6s7t8u9v0",
                "git.acme.internal",
                Some("gitea"),
                Some("mo"),
                "mo",
            ),
        ];

        let home = Home::new("every-forge");
        let scope = SecretScope::new("mo", "/w/naridon").unwrap();
        let mut vault = Vault::open_under(&home.0, scope.clone()).unwrap();
        for (name, value, host, forge, user, _) in services {
            vault.put(
                Held::new(name, value, now())
                    .unwrap()
                    .for_git_on(host, forge, user)
                    .unwrap(),
            )
            .unwrap();
        }
        let boot = BootSecrets::open_under(&home.0, scope.clone()).unwrap();

        // The file, written where a boot would write it — under this test's own
        // home rather than the developer's, and with the mode a token needs.
        let here = Place::Here {
            root: std::env::temp_dir().display().to_string(),
        };
        let path = env_path(&scope);
        let on_disk = home.0.join(path.strip_prefix("~/").expect("a home-relative path"));
        block_on(here.deliver(&on_disk.to_string_lossy(), 0o600, &boot.env_file()))
            .expect("delivered");
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let mode = std::fs::metadata(&on_disk).unwrap().permissions().mode() & 0o777;
            assert_eq!(mode, 0o600, "a member's tokens are readable by other accounts");
        }

        // The real boot line, with `$HOME` pointed at this test's home so the
        // line itself is the shipped one, character for character.
        let load = format!("HOME={}; {}", quote(&home.0.to_string_lossy()), preamble(&path));

        for (name, value, host, _, _, sends) in services {
            let reopened = Vault::open_under(&home.0, scope.clone()).unwrap();
            let held = reopened
                .git_for(host)
                .unwrap_or_else(|| panic!("nothing held for {host}"));
            let brokered = crate::manager::brain::place_git::Brokered::from_ref(&held.as_ref())
                .expect("a brokered source");
            let ask = crate::manager::brain::place_git::CredentialAsk::new(
                "mo",
                &format!("https://{host}/Uniskool/naridon.git"),
            )
            .expect("an ask");
            let plan = crate::manager::brain::place_git::choose(
                &ask,
                &Default::default(),
                crate::manager::brain::place_git::sources(Some(brokered)),
            );
            let cred = plan
                .credential
                .clone()
                .unwrap_or_else(|| panic!("{host} got no credential"));
            assert_eq!(cred.source, "brokered", "{host}");

            // The live run: git's own helper, in a shell that booted from the
            // file. `f` is the function the snippet defines; `get` is the verb
            // git calls it with.
            let answered = block_on(here.ask(format!(
                "{load}{} get",
                cred.helper.trim_start_matches('!')
            )))
            .unwrap_or_else(|e| panic!("{host}: the helper did not run: {e}"));
            assert!(
                answered.contains(&format!("username={sends}")),
                "{host} sent the wrong username: {answered}"
            );
            assert!(
                answered.contains(&format!("password={value}")),
                "{host}: the credential did not reach the process that pushes"
            );

            // And the same token, in everything a model can read. The helper it
            // was produced from is in this list: what git runs names `$NAME`, and
            // an agent reading the command line learns the name and nothing else.
            let terminal = block_on(here.open_booted(
                &crate::manager::brain::place_contract::Open::Agent {
                    bin: "claude".into(),
                    args: vec![],
                    prompt: Some(format!("push the branch to {host}")),
                    session: Some("aura-fix".into()),
                },
                &boot,
            ))
            .expect("a shell");
            let surfaces: [(&str, String); 7] = [
                ("the command line", terminal.args.join(" ")),
                ("the terminal on its way to a surface", serde_json::to_string(&terminal).unwrap()),
                ("the boot line", load.clone()),
                ("the credential helper", cred.helper.clone()),
                ("the git arguments", cred.git_config_args().join(" ")),
                ("the push plan", serde_json::to_string(&plan).unwrap()),
                (
                    "a replayed transcript",
                    boot.redact(&format!("I pushed to {host}. The token was {value}.")),
                ),
            ];
            for (what, text) in &surfaces {
                assert!(!text.contains(value), "{host}: the token reached {what}: {text}");
            }
            assert!(
                cred.helper.contains(&format!("${name}")),
                "{host}: the helper cannot say which variable it means"
            );
            // The one place it is: the environment of the process doing the work.
            assert!(
                terminal.env.iter().any(|(k, v)| k == name && v == value),
                "{host}: the work was started without the credential"
            );
        }
    }

    #[test]
    fn a_boot_for_a_project_nobody_is_signed_in_for_is_empty_rather_than_an_error() {
        // Most people have no secrets and some are not signed in. Neither is a
        // reason to refuse to start an agent.
        let boot = boot_here("/w/definitely-not-a-project-anybody-has");
        assert!(boot.is_empty());
        assert!(boot.names().is_empty());
    }
}
