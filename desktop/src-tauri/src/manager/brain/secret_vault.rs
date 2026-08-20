//! Where a member's secrets for one project are held, and nowhere else.
//!
//! The tenth question in the runtime contract, and the only one whose answer is
//! deliberately never shown to anybody: **what does the work need to have, that
//! nobody is allowed to read?**
//!
//! ## The invariant, and why it is about storage rather than about prompts
//!
//! A model cannot echo a secret it never saw. That sentence is the whole design,
//! and it is a claim about *where a value can get to* rather than about how
//! carefully a prompt is written. Redaction is a filter, and a filter is a list
//! of the shapes somebody thought of; the day a token is base64'd into a tool
//! result, the filter is a comment. So the value never enters the graph that
//! reaches a model at all: it goes from this file into a process environment and
//! stops.
//!
//! Everything in here follows from that:
//!
//! * [`Held`] carries a value and is not `Serialize`. There is no derive that
//!   could put one on a wire by accident, and its [`std::fmt::Debug`] prints a
//!   fingerprint rather than the value, so a stray `dbg!` in a panic handler is
//!   not a disclosure.
//! * [`SecretRef`] is what every surface gets — a name, when it arrived, and
//!   eight hex characters of digest so a person can tell two tokens apart
//!   without being shown either.
//! * The file is `0600` inside a `0700` directory, written through a temp file
//!   and renamed, and it lives under `~/.aura` rather than in the checkout. A
//!   secret in the repo is a secret in everyone's clone.
//!
//! ## Why (member, project) and not (member) or (project)
//!
//! Scoped to the member alone, one box's team shares one token and every push is
//! whoever provisioned the machine — which is the bug
//! [`super::place_git`] exists about, moved one layer down.
//!
//! Scoped to the project alone, a secret is the *project's*, so anyone who opens
//! that project anywhere gets it, and "revoke Ana's access" means rotating a
//! credential for everybody.
//!
//! Scoped to both, a secret is one person's reach into one piece of work, which
//! is the only shape that revokes cleanly. `org_member_keys` (migration 016)
//! already binds a per-member secret to org membership on the server side; this
//! is the same binding on the side of the wire where the value actually gets
//! spent, with the project added because a place holds many.
//!
//! ## What this is not
//!
//! Not a memory-hygiene story. A value read out of here lives in this process's
//! heap until the allocator reuses it, and pretending otherwise with a `Drop`
//! that overwrites one `String` while `serde` still holds three copies would be
//! a gesture rather than a guarantee. The guarantee made here is the one that
//! can actually be kept and tested: it does not reach a prompt, a transcript, a
//! radar event, an argv, or the frontend.

use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

use super::place_forge::Forge;

/// The directory under `~/.aura` that holds every member's vaults.
pub const VAULT_DIR: &str = "secrets";

/// The on-disk format. Bumped if the shape of a vault file ever changes, so an
/// older build meets a newer file and says so rather than reading it wrong.
const FORMAT: u32 = 1;

/// A name is exported into a shell on somebody's machine, so it is held to what
/// an environment variable can be rather than quoted and hoped for.
const MAX_NAME: usize = 64;

/// Who a secret belongs to, and which project it is good for.
///
/// Both halves are required and neither has a default. A scope that fell back to
/// "the current user" or "the current project" would hand a value to whoever
/// happened to be asking, which is exactly the failure this type exists to make
/// impossible.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct SecretScope {
    /// The member, as the login their work runs as — not the machine.
    pub member: String,
    /// The checkout on *this* laptop the work belongs to.
    ///
    /// Deliberately the local root even when the code is on a box: a chat has
    /// two homes ([`super::place::Place`]), and the record side — the board, the
    /// intent log, the session file — is always here. Keying on the remote path
    /// would give one project two vaults the moment it was opened on a second
    /// machine, which is how a member ends up with a token in one place and not
    /// the other.
    pub project: String,
}

impl SecretScope {
    /// A scope, with both halves insisted upon.
    pub fn new(member: &str, project: &str) -> Result<Self, String> {
        let member = member.trim().to_string();
        if member.is_empty() {
            return Err("Nobody is named, so there is no vault to open.".into());
        }
        if !is_login(&member) {
            return Err(format!("{member} isn't a login a vault can be filed under."));
        }
        let project = normalise_root(project);
        if project.is_empty() {
            return Err("No project is named, so there is no vault to open.".into());
        }
        Ok(SecretScope { member, project })
    }

    /// A stable filename for this project.
    ///
    /// SHA-256 rather than [`std::collections::hash_map::DefaultHasher`], which
    /// the rest of the app uses for project ids. That hasher is explicitly not
    /// stable across Rust releases, and an id that changes under a toolchain
    /// upgrade would silently orphan every secret a member had put here — a
    /// failure that looks like "my token stopped working" and is very hard to
    /// read backwards.
    pub fn project_key(&self) -> String {
        let mut h = Sha256::new();
        h.update(self.project.as_bytes());
        format!("p-{}", &hex::encode(h.finalize())[..16])
    }

    /// The directory this member's vaults live in, under a given home.
    pub fn dir_under(&self, home: &Path) -> PathBuf {
        home.join(".aura").join(VAULT_DIR).join(&self.member)
    }

    /// This scope's own file.
    pub fn file_under(&self, home: &Path) -> PathBuf {
        self.dir_under(home)
            .join(format!("{}.json", self.project_key()))
    }
}

/// One secret, as it is held — the only type in the app that carries a value.
///
/// Not `Serialize`: the on-disk form is [`Stored`], written by this module and
/// read by this module. Anything that wanted to put a `Held` on a wire would
/// have to write the serializer by hand, which is the point.
#[derive(Clone, PartialEq, Eq, Deserialize)]
pub struct Held {
    pub name: String,
    pub value: String,
    /// Unix seconds.
    pub added_at: i64,
    /// When this is a git credential: the host it is good for. A secret with a
    /// host is what [`super::place_git`]'s brokered source offers.
    #[serde(default)]
    pub git_host: Option<String>,
    /// The username half of that credential. Every forge spends the token in
    /// the password half and none of them agree on this one — GitHub wants
    /// `x-access-token`, GitLab `oauth2`, Bitbucket `x-token-auth`, and a
    /// self-hosted Gitea wants the person's own account name. Resolved from
    /// `git_forge` when nobody says otherwise; see [`Held::for_git_on`].
    #[serde(default)]
    pub git_user: Option<String>,
    /// Which service answers at that host — [`Forge::id`].
    ///
    /// Recorded rather than re-derived, because the host does not always give
    /// it away: `git.acme.internal` is as likely to be a GitLab as a Gitea, and
    /// the difference is whether a push authenticates as `oauth2` or as the
    /// member. Absent in a vault written before this existed, which
    /// [`super::place_git::Brokered::from_ref`] repairs from the host.
    #[serde(default)]
    pub git_forge: Option<String>,
}

/// Prints what a person needs to tell two secrets apart, and nothing that could
/// spend either.
impl std::fmt::Debug for Held {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("Held")
            .field("name", &self.name)
            .field("value", &"<held>")
            .field("fingerprint", &fingerprint(&self.value))
            .field("git_host", &self.git_host)
            .field("git_forge", &self.git_forge)
            .finish()
    }
}

impl Held {
    /// A secret, checked as far as it can be checked before it is kept.
    pub fn new(name: &str, value: &str, now: i64) -> Result<Self, String> {
        let name = name.trim().to_string();
        if !is_env_name(&name) {
            return Err(format!(
                "{name:?} isn't a name this can export — use letters, digits and underscores, \
                 starting with a letter or an underscore."
            ));
        }
        // Not trimmed. A value is bytes somebody was given, and a token with a
        // trailing newline that we quietly repaired here would be a token that
        // works in Aura and fails in every other tool they paste it into.
        if value.is_empty() {
            return Err(format!("{name} has no value to keep."));
        }
        Ok(Held {
            name,
            value: value.to_string(),
            added_at: now,
            git_host: None,
            git_user: None,
            git_forge: None,
        })
    }

    /// Mark this as the credential a push to `host` should spend, with the
    /// service read off the host.
    ///
    /// The ordinary case, and the only one that works without asking anybody
    /// anything: `gitlab.com` is a GitLab and `gitlab.acme.com` almost certainly
    /// is too. Use [`Held::for_git_on`] for a host whose name gives nothing
    /// away.
    pub fn for_git(self, host: &str, user: Option<&str>) -> Result<Self, String> {
        self.for_git_on(host, None, user)
    }

    /// The same, with the service named.
    ///
    /// `forge` is what makes this work for every remote the GitHub App cannot
    /// reach. The host alone cannot tell a self-hosted GitLab at
    /// `git.acme.internal` from a Gitea at the same address, and the two need
    /// different usernames — so a credential for one of those is stored with the
    /// service beside it, and a service nobody names and no host gives away
    /// needs `user` to say whose account the token is. That is a refusal rather
    /// than a default, because the default GitHub's spelling would have handed
    /// back is a `401` at the first push.
    pub fn for_git_on(
        mut self,
        host: &str,
        forge: Option<&str>,
        user: Option<&str>,
    ) -> Result<Self, String> {
        let host = host.trim().to_ascii_lowercase();
        if host.is_empty() {
            return Err("A git credential needs the host it is good for.".into());
        }
        if !is_host(&host) {
            return Err(format!("{host} isn't a host a credential can be keyed by."));
        }
        let forge = Forge::named_or_of_host(forge, &host)?;
        let user = forge.username(user).ok_or_else(|| {
            format!(
                "Nothing here can tell what {host} expects as a username, so a token for it needs \
                 the account name it belongs to."
            )
        })?;
        self.git_user = Some(user);
        self.git_forge = Some(forge.id().to_string());
        self.git_host = Some(host);
        Ok(self)
    }

    /// What every surface is allowed to see.
    pub fn as_ref(&self) -> SecretRef {
        SecretRef {
            name: self.name.clone(),
            added_at: self.added_at,
            git_host: self.git_host.clone(),
            git_user: self.git_user.clone(),
            git_forge: self.git_forge.clone(),
            fingerprint: fingerprint(&self.value),
        }
    }
}

/// A secret as anything outside this module may know it.
///
/// This is the type that crosses to the frontend, and it has no value field —
/// not a redacted one, not an `Option`, none. A surface cannot render what it
/// was never sent, and a bug cannot leak a field that does not exist.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct SecretRef {
    pub name: String,
    pub added_at: i64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub git_host: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub git_user: Option<String>,
    /// Which service answers at `git_host` — `github`, `gitlab`, `bitbucket`,
    /// `gitea`, or `unknown` for a self-hosted one nothing can place. A surface
    /// shows it so a person can see the credential was filed as what they meant.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub git_forge: Option<String>,
    /// Eight hex characters of `sha256(value)`. Enough to say "that is the same
    /// token I put on the other machine" or "no, that one is older", and far too
    /// little to be worth attacking.
    pub fingerprint: String,
}

/// The on-disk shape. Private: the file is this module's business.
#[derive(Serialize, Deserialize)]
struct Stored {
    format: u32,
    member: String,
    project: String,
    #[serde(default)]
    secrets: Vec<StoredSecret>,
}

/// [`Held`], with a serializer — the one place a value is written down, and it
/// is written to a `0600` file under the member's own home.
#[derive(Serialize, Deserialize)]
struct StoredSecret {
    name: String,
    value: String,
    added_at: i64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    git_host: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    git_user: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    git_forge: Option<String>,
}

/// One member's secrets for one project.
#[derive(Debug)]
pub struct Vault {
    scope: SecretScope,
    path: PathBuf,
    held: Vec<Held>,
}

impl Vault {
    /// Open this scope's vault under this laptop's home.
    pub fn open(scope: SecretScope) -> Result<Self, String> {
        let home = home_dir()?;
        Self::open_under(&home, scope)
    }

    /// Open it under a given home — how the tests get a real vault without one
    /// of them writing into the person running them.
    pub fn open_under(home: &Path, scope: SecretScope) -> Result<Self, String> {
        let path = scope.file_under(home);
        let held = match std::fs::read_to_string(&path) {
            Ok(text) => read_stored(&text, &path)?,
            // A vault that has never been written is an empty one, not an
            // error: every project starts here.
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => vec![],
            Err(e) => return Err(format!("{} can't be read: {e}", path.display())),
        };
        Ok(Vault { scope, path, held })
    }

    pub fn scope(&self) -> &SecretScope {
        &self.scope
    }

    pub fn is_empty(&self) -> bool {
        self.held.is_empty()
    }

    /// Every secret in it, as the outside world may know them, oldest first.
    pub fn list(&self) -> Vec<SecretRef> {
        self.held.iter().map(Held::as_ref).collect()
    }

    /// The pairs to put into a process's environment.
    pub fn env_pairs(&self) -> Vec<(String, String)> {
        self.held
            .iter()
            .map(|h| (h.name.clone(), h.value.clone()))
            .collect()
    }

    /// The secret this member holds for pushing to `host`, if any.
    ///
    /// Newest wins when two are held for one host: rotating a token means
    /// putting the new one in, and a member who has done that should not go on
    /// pushing with the old one because it happens to be earlier in the file.
    pub fn git_for(&self, host: &str) -> Option<&Held> {
        let want = host.trim().to_ascii_lowercase();
        self.held
            .iter()
            .filter(|h| h.git_host.as_deref() == Some(want.as_str()))
            .max_by_key(|h| h.added_at)
    }

    /// Keep a secret, replacing one of the same name.
    ///
    /// Replacing rather than refusing is the right bargain for a credential:
    /// rotation is the common case, and a `put` that errored on an existing name
    /// would teach people to `forget` first, which leaves a window where the
    /// work has no credential at all.
    pub fn put(&mut self, secret: Held) -> Result<(), String> {
        self.held.retain(|h| h.name != secret.name);
        self.held.push(secret);
        self.save()
    }

    /// Drop a secret. `false` when there was nothing by that name.
    pub fn forget(&mut self, name: &str) -> Result<bool, String> {
        let before = self.held.len();
        self.held.retain(|h| h.name != name.trim());
        let removed = self.held.len() != before;
        if removed {
            self.save()?;
        }
        Ok(removed)
    }

    /// Write the file, private before it has anything in it.
    ///
    /// The order matters and is the reason this is not four lines: the temp file
    /// is created, *then* closed to everyone but its owner, *then* written, then
    /// renamed over the target. Written first and chmod'd after, there is a
    /// window — short, real, and on a shared machine long enough — where the
    /// token is on disk and world-readable.
    fn save(&self) -> Result<(), String> {
        let dir = self
            .path
            .parent()
            .ok_or_else(|| format!("{} has no directory", self.path.display()))?;
        std::fs::create_dir_all(dir).map_err(|e| format!("{}: {e}", dir.display()))?;
        close_to_others(dir, 0o700)?;

        let stored = Stored {
            format: FORMAT,
            member: self.scope.member.clone(),
            project: self.scope.project.clone(),
            secrets: self
                .held
                .iter()
                .map(|h| StoredSecret {
                    name: h.name.clone(),
                    value: h.value.clone(),
                    added_at: h.added_at,
                    git_host: h.git_host.clone(),
                    git_user: h.git_user.clone(),
                    git_forge: h.git_forge.clone(),
                })
                .collect(),
        };
        let body = serde_json::to_string_pretty(&stored)
            .map_err(|e| format!("can't write the vault: {e}"))?;

        let tmp = self.path.with_extension(format!("tmp-{}", std::process::id()));
        std::fs::write(&tmp, b"").map_err(|e| format!("{}: {e}", tmp.display()))?;
        close_to_others(&tmp, 0o600)?;
        std::fs::write(&tmp, body.as_bytes()).map_err(|e| format!("{}: {e}", tmp.display()))?;
        std::fs::rename(&tmp, &self.path).map_err(|e| {
            let _ = std::fs::remove_file(&tmp);
            format!("{}: {e}", self.path.display())
        })
    }
}

fn read_stored(text: &str, path: &Path) -> Result<Vec<Held>, String> {
    let stored: Stored = serde_json::from_str(text)
        .map_err(|e| format!("{} isn't a vault this can read: {e}", path.display()))?;
    if stored.format > FORMAT {
        return Err(format!(
            "{} was written by a newer Aura (format {}). Update rather than risk reading it wrong.",
            path.display(),
            stored.format
        ));
    }
    Ok(stored
        .secrets
        .into_iter()
        .map(|s| Held {
            name: s.name,
            value: s.value,
            added_at: s.added_at,
            git_host: s.git_host,
            git_user: s.git_user,
            git_forge: s.git_forge,
        })
        .collect())
}

/// Take every bit off a path but the owner's.
#[cfg(unix)]
fn close_to_others(path: &Path, mode: u32) -> Result<(), String> {
    use std::os::unix::fs::PermissionsExt;
    std::fs::set_permissions(path, std::fs::Permissions::from_mode(mode))
        .map_err(|e| format!("can't make {} private: {e}", path.display()))
}

/// Windows has no mode bits to set, and a file under the user's own profile is
/// already ACL'd to them. Saying so rather than silently doing nothing, because
/// "the permissions were applied" is not a thing to be vague about.
#[cfg(not(unix))]
fn close_to_others(_path: &Path, _mode: u32) -> Result<(), String> {
    Ok(())
}

fn home_dir() -> Result<PathBuf, String> {
    std::env::var("HOME")
        .or_else(|_| std::env::var("USERPROFILE"))
        .map(PathBuf::from)
        .map_err(|_| "This laptop has no home directory to keep secrets in.".to_string())
}

/// Eight hex characters of the digest — enough to recognise, not enough to use.
pub fn fingerprint(value: &str) -> String {
    let mut h = Sha256::new();
    h.update(value.as_bytes());
    hex::encode(h.finalize())[..8].to_string()
}

/// Is this a name a shell will accept after `export`?
pub fn is_env_name(name: &str) -> bool {
    let b = name.as_bytes();
    !name.is_empty()
        && name.len() <= MAX_NAME
        && (b[0].is_ascii_alphabetic() || b[0] == b'_')
        && b.iter().all(|c| c.is_ascii_alphanumeric() || *c == b'_')
}

/// A login is a path component and a shell word before it is anything else.
fn is_login(login: &str) -> bool {
    !login.is_empty()
        && login.len() <= 64
        && login
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || matches!(c, '.' | '-' | '_'))
}

fn is_host(host: &str) -> bool {
    !host.is_empty()
        && host.len() <= 255
        && host
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || matches!(c, '.' | '-' | '_'))
}

/// One spelling of a root, so `/a/b` and `/a/b/` are one project rather than
/// two vaults.
fn normalise_root(root: &str) -> String {
    let r = root.trim();
    let trimmed = r.trim_end_matches('/');
    // A bare `/` trims to nothing, and nothing is not a project.
    if trimmed.is_empty() {
        r.to_string()
    } else {
        trimmed.to_string()
    }
}

/// Unix seconds, for an `added_at`.
pub fn now() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs() as i64)
        .unwrap_or_default()
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A scratch home nothing else is using. The pid matters for the same
    /// reason it does in `place_env`: a fixed name under `$TMPDIR` is shared
    /// with every other `cargo test` on this machine, including this suite in a
    /// second worktree.
    struct Home(PathBuf);

    impl Home {
        fn new(tag: &str) -> Self {
            let dir = std::env::temp_dir()
                .join(format!("aura-vault-{tag}-{}", std::process::id()));
            let _ = std::fs::remove_dir_all(&dir);
            std::fs::create_dir_all(&dir).unwrap();
            Home(dir)
        }
        fn vault(&self, member: &str, project: &str) -> Vault {
            Vault::open_under(&self.0, SecretScope::new(member, project).unwrap()).unwrap()
        }
    }

    impl Drop for Home {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.0);
        }
    }

    fn token(name: &str, value: &str) -> Held {
        Held::new(name, value, 1_700_000_000).unwrap()
    }

    #[test]
    fn a_scope_needs_both_halves() {
        assert!(SecretScope::new("", "/p").is_err());
        assert!(SecretScope::new("mo", "  ").is_err());
        assert!(SecretScope::new("mo; rm -rf ~", "/p").is_err());
        assert!(SecretScope::new("mo", "/p").is_ok());
    }

    #[test]
    fn one_project_spelled_two_ways_is_one_vault() {
        let a = SecretScope::new("mo", "/Users/mo/naridon").unwrap();
        let b = SecretScope::new("mo", "/Users/mo/naridon/").unwrap();
        assert_eq!(a.project_key(), b.project_key());
        assert_eq!(a, b);
    }

    #[test]
    fn two_members_on_one_project_are_two_vaults() {
        let home = Home::new("two-members");
        let mut mine = home.vault("mo", "/w/naridon");
        mine.put(token("GITHUB_TOKEN", "ghp_mine")).unwrap();

        // Ana, same project, same laptop. She has her own file and it is empty.
        let hers = home.vault("ana", "/w/naridon");
        assert!(hers.is_empty(), "Ana can see mo's vault");
        assert_ne!(
            SecretScope::new("mo", "/w/naridon").unwrap().dir_under(&home.0),
            SecretScope::new("ana", "/w/naridon").unwrap().dir_under(&home.0),
        );
    }

    #[test]
    fn two_projects_for_one_member_are_two_vaults() {
        let home = Home::new("two-projects");
        let mut here = home.vault("mo", "/w/naridon");
        here.put(token("DEPLOY_KEY", "one")).unwrap();

        let there = home.vault("mo", "/w/other");
        assert!(there.is_empty(), "a secret leaked across projects");
        assert_eq!(here.list().len(), 1);
    }

    #[test]
    fn a_secret_survives_being_written_and_read_back() {
        let home = Home::new("roundtrip");
        {
            let mut v = home.vault("mo", "/w/naridon");
            v.put(token("NPM_TOKEN", "npm_abc123")).unwrap();
        }
        let again = home.vault("mo", "/w/naridon");
        assert_eq!(again.list().len(), 1);
        assert_eq!(again.env_pairs(), vec![("NPM_TOKEN".into(), "npm_abc123".into())]);
    }

    #[test]
    fn putting_the_same_name_twice_rotates_rather_than_doubles() {
        let home = Home::new("rotate");
        let mut v = home.vault("mo", "/w/naridon");
        v.put(token("GITHUB_TOKEN", "old")).unwrap();
        v.put(token("GITHUB_TOKEN", "new")).unwrap();
        assert_eq!(v.list().len(), 1);
        assert_eq!(v.env_pairs()[0].1, "new");
    }

    #[test]
    fn forgetting_says_whether_there_was_anything_to_forget() {
        let home = Home::new("forget");
        let mut v = home.vault("mo", "/w/naridon");
        v.put(token("A", "1")).unwrap();
        assert!(v.forget("A").unwrap());
        assert!(!v.forget("A").unwrap());
        assert!(v.is_empty());
        // And it really went from the file, not only from memory.
        assert!(home.vault("mo", "/w/naridon").is_empty());
    }

    #[test]
    fn a_git_credential_is_found_by_host_and_the_newest_wins() {
        let home = Home::new("git-host");
        let mut v = home.vault("mo", "/w/naridon");
        v.put(
            Held::new("OLD_GH", "ghp_old", 1_000)
                .unwrap()
                .for_git("github.com", None)
                .unwrap(),
        )
        .unwrap();
        v.put(
            Held::new("NEW_GH", "ghp_new", 2_000)
                .unwrap()
                .for_git("GitHub.com", Some("mo"))
                .unwrap(),
        )
        .unwrap();
        v.put(token("UNRELATED", "x")).unwrap();

        let chosen = v.git_for("github.com").expect("a credential");
        assert_eq!(chosen.name, "NEW_GH");
        assert_eq!(chosen.git_user.as_deref(), Some("mo"));
        // Host matching is case-insensitive on both sides, and unrelated hosts
        // get nothing rather than the first token in the file.
        assert!(v.git_for("gitlab.com").is_none());
        assert!(v.git_for("GITHUB.COM").is_some());
        // A username defaults to what GitHub's own tooling sends.
        assert_eq!(
            v.git_for("github.com").unwrap().git_host.as_deref(),
            Some("github.com")
        );
    }

    #[test]
    fn a_credential_remembers_which_service_it_is_for() {
        // The vault is what carries the answer from the moment a person adds a
        // token to the moment a push spends it. If it forgets the service, the
        // push has to guess, and a guess here is a 401 that reads like a bad
        // token rather than like a wrong username.
        let home = Home::new("forges");
        let mut v = home.vault("mo", "/w/naridon");
        for (name, host, forge, user, sends) in [
            ("GITHUB_TOKEN", "github.com", None, None, "x-access-token"),
            ("GITLAB_TOKEN", "gitlab.com", None, None, "oauth2"),
            ("BITBUCKET_TOKEN", "bitbucket.org", None, None, "x-token-auth"),
            ("GIT_TOKEN", "git.acme.internal", Some("gitea"), Some("mo"), "mo"),
        ] {
            v.put(
                Held::new(name, "tok_supersecret_value", 1_700_000_000)
                    .unwrap()
                    .for_git_on(host, forge, user)
                    .unwrap(),
            )
            .unwrap();
            let found = v.git_for(host).unwrap_or_else(|| panic!("nothing for {host}"));
            assert_eq!(found.name, name);
            assert_eq!(found.git_user.as_deref(), Some(sends), "{host}");
            assert!(found.git_forge.is_some(), "{host} was filed under no service");
        }

        // It survives the file, because that is where it has to survive.
        let again = home.vault("mo", "/w/naridon");
        assert_eq!(again.git_for("gitlab.com").unwrap().git_user.as_deref(), Some("oauth2"));
        assert_eq!(again.git_for("git.acme.internal").unwrap().git_forge.as_deref(), Some("gitea"));

        // And none of the four put a value on the surface that carries them.
        let json = serde_json::to_string(&again.list()).unwrap();
        assert!(!json.contains("tok_supersecret_value"), "{json}");
    }

    #[test]
    fn a_host_nothing_can_place_needs_the_account_name_rather_than_a_guess() {
        // A self-hosted forge authenticates the person. Defaulting the username
        // to GitHub's spelling would be a credential that looks stored and does
        // not work.
        let err = token("GIT_TOKEN", "tok")
            .for_git("git.acme.internal", None)
            .expect_err("nobody can know the account name");
        assert!(err.contains("account name"), "{err}");
        assert!(token("GIT_TOKEN", "tok").for_git("git.acme.internal", Some("mo")).is_ok());

        // A misspelled service is refused too — quietly reading it off the host
        // instead would file the token under something the person did not mean.
        let typo = token("GIT_TOKEN", "tok")
            .for_git_on("gitlab.com", Some("gitlub"), None)
            .expect_err("a typo");
        assert!(typo.contains("gitlub"), "{typo}");
    }

    #[test]
    fn a_name_that_isnt_an_env_name_is_refused_rather_than_quoted() {
        // These reach `export` in a shell on somebody else's machine. Quoting
        // would probably hold; "probably" is not a posture for that.
        for bad in ["", "9LIVES", "A-B", "A B", "A;rm -rf ~", "A$B", "A\nB"] {
            assert!(
                Held::new(bad, "v", 0).is_err(),
                "{bad:?} should not have been accepted"
            );
        }
        for good in ["A", "_a", "GITHUB_TOKEN", "npm_config_token", "X9"] {
            assert!(Held::new(good, "v", 0).is_ok(), "{good:?} was refused");
        }
        assert!(Held::new("A", "", 0).is_err(), "an empty value was kept");
    }

    #[test]
    fn a_value_is_kept_exactly_as_it_was_given() {
        // A token with trailing whitespace that we quietly repaired here would
        // work in Aura and fail everywhere else the person pastes it.
        let h = Held::new("T", " tok\n", 0).unwrap();
        assert_eq!(h.value, " tok\n");
    }

    #[test]
    fn the_reference_a_surface_gets_carries_no_value() {
        let h = token("GITHUB_TOKEN", "ghp_supersecret");
        let json = serde_json::to_string(&h.as_ref()).unwrap();
        assert!(!json.contains("ghp_supersecret"), "{json}");
        assert!(!json.contains("value"), "{json}");
        assert!(json.contains("GITHUB_TOKEN"));
        assert_eq!(h.as_ref().fingerprint, fingerprint("ghp_supersecret"));
        assert_eq!(h.as_ref().fingerprint.len(), 8);
    }

    #[test]
    fn debugging_a_held_secret_prints_a_fingerprint_not_a_token() {
        // A `dbg!` in a panic handler is not supposed to be a disclosure.
        let out = format!("{:?}", token("GITHUB_TOKEN", "ghp_supersecret"));
        assert!(!out.contains("ghp_supersecret"), "{out}");
        assert!(out.contains("<held>"), "{out}");
        assert!(out.contains(&fingerprint("ghp_supersecret")), "{out}");
    }

    #[cfg(unix)]
    #[test]
    fn the_file_and_its_directory_are_closed_to_everyone_else() {
        use std::os::unix::fs::PermissionsExt;
        let home = Home::new("modes");
        let mut v = home.vault("mo", "/w/naridon");
        v.put(token("GITHUB_TOKEN", "ghp_x")).unwrap();

        let scope = SecretScope::new("mo", "/w/naridon").unwrap();
        let file = scope.file_under(&home.0);
        let dir = scope.dir_under(&home.0);
        let mode = |p: &Path| {
            std::fs::metadata(p).unwrap().permissions().mode() & 0o777
        };
        assert_eq!(mode(&file), 0o600, "the vault is readable by others");
        assert_eq!(mode(&dir), 0o700, "the vault's directory is open");
        // And nothing was left lying around at the temp name.
        let leftovers: Vec<_> = std::fs::read_dir(&dir)
            .unwrap()
            .filter_map(|e| e.ok())
            .map(|e| e.file_name().to_string_lossy().into_owned())
            .filter(|n| n.contains("tmp-"))
            .collect();
        assert!(leftovers.is_empty(), "{leftovers:?}");
    }

    #[test]
    fn a_vault_from_a_newer_aura_is_refused_rather_than_read_wrong() {
        let home = Home::new("newer");
        let scope = SecretScope::new("mo", "/w/naridon").unwrap();
        std::fs::create_dir_all(scope.dir_under(&home.0)).unwrap();
        std::fs::write(
            scope.file_under(&home.0),
            r#"{"format":99,"member":"mo","project":"/w/naridon","secrets":[]}"#,
        )
        .unwrap();
        let err = Vault::open_under(&home.0, scope).unwrap_err();
        assert!(err.contains("newer Aura"), "{err}");
    }

    #[test]
    fn a_project_that_was_never_given_a_secret_opens_empty() {
        let home = Home::new("bare");
        let v = home.vault("mo", "/w/never-used");
        assert!(v.is_empty());
        assert!(v.list().is_empty());
        assert!(v.env_pairs().is_empty());
    }
}
