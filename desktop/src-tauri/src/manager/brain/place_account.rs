//! Giving each member their own account on a place they share.
//!
//! The eighth question in the runtime contract, and the one a *shared* place
//! cannot be honest without: **who am I here, and is that somebody else too?**
//!
//! ## Why a per-user systemd unit was only half of it
//!
//! `aura runner install --user` already installs one runner per Unix account,
//! reading that account's own token, and [`crate::cloudbox`] already knows a
//! `shared` box from one of your own. What nothing did was create the account.
//! So a team pointed the wizard at one box, every member signed in as the login
//! the image came with — `ubuntu`, `ec2-user`, `admin` — and the per-user unit
//! dutifully installed one runner per *box*, under one home directory, holding
//! one Claude sign-in and one runner token. Everybody's work checked in as
//! whoever connected first, and everybody's credentials sat in a directory
//! everybody else could read. The isolation was a flag with nothing behind it.
//!
//! So the account is made here, before anything is written into it: a real Unix
//! user, its own home at `0700`, its own `~/.ssh/authorized_keys` holding the
//! member's own public key, its own `~/.config/aura` at `0700`, `umask 077` in
//! its profile, and `loginctl enable-linger` so its runner starts at boot
//! without anyone logged in.
//!
//! ## Why it lives on `Place` rather than in the wizard
//!
//! Because a wizard is one way of getting a machine. The moment Aura provisions
//! a place itself, the second way needs the same accounts — and written as a
//! second implementation over the same ssh, it would drift on the first fix.
//! That is the one thing this programme is not allowed to ship. So the judgement
//! is one script ([`provision_script`]), one parser ([`parse_report`]), and
//! [`Place::ask`] supplies the only thing they cannot: somewhere to run.
//!
//! ## What this laptop answers
//!
//! Honestly, and without inventing an account: you are already your own user
//! here. A local place reports the login it is running as and creates nothing —
//! making Unix accounts on the computer somebody is sitting at is not Aura's
//! business, and pretending otherwise would put a `useradd` behind a button
//! whose whole point is *shared* hardware.

use serde::{Deserialize, Serialize};

use super::place::Place;
use crate::cloudbox::script::quote;

/// Marks the start of the machine-readable report the script prints. Split in
/// the rendered script with `""` for the same reason the wizard's probes are —
/// a line that contains its own marker matches itself.
const REPORT: &str = "___AURA_ACCOUNT___";

/// The longest login Linux will accept (`useradd` refuses past 32, and 32 is
/// itself rejected by some `adduser` policies).
const MAX_LOGIN: usize = 31;

/// Logins that already mean something on a box. Silently mangling one would
/// hand a member an account that is not theirs — or, for `root`, one that is
/// everybody's.
///
/// `aura-base` is the last of them and the one Aura itself added: it is the
/// account the team's shared environment is built in (see
/// [`super::place_base`]), it deliberately belongs to nobody, and a member
/// handed it would own the thing everyone else starts from.
const RESERVED: [&str; 15] = [
    "root", "daemon", "bin", "sys", "sync", "games", "man", "news", "nobody", "admin", "adm",
    "ubuntu", "ec2-user", "debian", "aura-base",
];

/// A member's account on a place, as it stands after we have asked for it.
///
/// Every field is what the machine said, not what we asked for: `created` is
/// whether *this* call made the account, `key` is what the box's
/// `authorized_keys` holds now. A surface that reported our intentions back to
/// the user would be reporting a wish.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct MemberAccount {
    /// The Unix login the member owns here.
    pub login: String,
    /// Its home directory, as the box spells it.
    pub home: String,
    /// Did this call create the account?
    pub created: bool,
    /// `installed` — we just added the member's key; `present` — it was already
    /// there; `absent` — no key was offered, so this account can only be
    /// reached by whoever can already become it.
    pub key: String,
    /// `on` — the account's units start at boot with nobody logged in;
    /// `off` — lingering was refused (no root); `unavailable` — no `loginctl`,
    /// so this box has no user units at all.
    pub linger: String,
    /// Is the home directory closed to the other members (`0700`)?
    pub private: bool,
    /// Does the account's profile set `umask 077`, so files it creates later are
    /// its own too?
    pub umask: bool,
    /// Is the member's toolchain scoped to their own home — their own
    /// `GH_CONFIG_DIR`, `CARGO_HOME`, `RUSTUP_HOME` and npm prefix?
    ///
    /// A separate promise from [`Self::private`], and the two fail differently.
    /// A private home stops a teammate READING this member's things; a scoped
    /// toolchain stops their `npm install -g` OVERWRITING them. `0700` alone
    /// leaves npm's prefix at `/usr/local`, which is everybody's however locked
    /// down the homes are. See [`super::place_toolchain`].
    pub scoped: bool,
    /// Has this box got somewhere to swap to? `present` — it already had swap;
    /// `added` — this call made a swapfile and turned it on; `none` — it has
    /// none and could not be given any; `unavailable` — we could not tell,
    /// which is what this laptop answers.
    ///
    /// A property of the machine rather than of the account, reported here
    /// because provisioning is the one step that runs with root on every kind
    /// of place. It is the other half of the per-member `MemoryMax` the runner
    /// installs: the ceiling is what stops one member taking the whole box, and
    /// swap is what makes reaching that ceiling a slow build rather than a
    /// killed one. See [`super::place_swap`].
    pub swap: String,
    /// The login the provisioning ran AS. When this differs from `login`, the
    /// session that asked is somebody else and has to become the member — see
    /// the wizard's `sudo -n -iu`.
    pub you: String,
    /// Is the member the one already sitting in this session?
    ///
    /// A field rather than a comparison the caller makes, because the caller is
    /// a wizard deciding whether to hand the shell over to somebody else, and a
    /// second spelling of "am I them" is a second place for it to be wrong.
    pub is_you: bool,
}

/// What to make, and what to let in with.
#[derive(Debug, Clone, PartialEq)]
pub struct AccountPlan {
    /// The login to own, already through [`member_login`].
    pub login: String,
    /// The member's SSH public key, so they can reach their own account
    /// directly rather than through whoever bootstrapped the box. `None` still
    /// creates the account — an admin may be making it on someone's behalf —
    /// but that account has no door of its own yet.
    pub public_key: Option<String>,
    /// May this call *change* the machine — create the account, close its home,
    /// install the key, turn lingering on?
    ///
    /// False makes the whole script a read-out: it reports what is there and
    /// touches nothing. That is what this laptop always gets (the answer to
    /// "who am I here" is never `useradd`, and closing somebody's own home
    /// directory to `0700` behind a button about *shared* hardware would be a
    /// change to the computer they are sitting at), and it is also how any
    /// place can be asked "is my account still mine alone?" without provisioning
    /// anything.
    pub may_provision: bool,
}

/// Turn who somebody IS into a login a Unix box will accept.
///
/// The input is an Aura account handle (`mhask`), and sometimes an email,
/// because that is what a signed-in member reliably carries. The output has to
/// survive `useradd`, `chown`, an `authorized_keys` path and a systemd unit
/// name, so it is narrowed hard: lowercase, `[a-z][a-z0-9_-]*`, and short.
///
/// Reserved names are an error rather than a nudge to something adjacent.
/// Answering "you asked for `root`, so I made you `root-1`" is how a member
/// ends up owning an account they cannot recognise as theirs, and answering it
/// silently is worse.
pub fn member_login(raw: &str) -> Result<String, String> {
    // An email is a handle with a domain glued on. `mo@naridon.com` is `mo`.
    let head = raw.trim().split('@').next().unwrap_or("").trim();
    if head.is_empty() {
        return Err("Sign in to Aura first — a per-member account needs a member.".into());
    }
    let mut out = String::new();
    let mut dash = false;
    for c in head.chars().flat_map(|c| c.to_lowercase()) {
        if c.is_ascii_alphanumeric() || c == '_' {
            out.push(c);
            dash = false;
        } else if !out.is_empty() && !dash {
            out.push('-');
            dash = true;
        }
    }
    // A login must start with a letter: `chown 3-mo` is read as a uid, and a
    // leading dash is read as an option by half the tools that touch it.
    while out
        .chars()
        .next()
        .is_some_and(|c| !c.is_ascii_lowercase())
    {
        out.remove(0);
    }
    while out.ends_with('-') || out.ends_with('_') {
        out.pop();
    }
    out.truncate(MAX_LOGIN);
    while out.ends_with('-') || out.ends_with('_') {
        out.pop();
    }
    if out.is_empty() {
        return Err(format!(
            "\"{}\" has no letters in it, so there is no Unix login to make from it. Pick a \
             name for your account on this machine.",
            raw.trim()
        ));
    }
    if RESERVED.contains(&out.as_str()) {
        return Err(format!(
            "\"{out}\" is a login this machine already uses for something else. Pick another \
             name for your account on it."
        ));
    }
    Ok(out)
}

/// Is this login the one the machine came with, rather than a person's?
///
/// The same list [`member_login`] refuses to hand out, asked the other way
/// round: given a login that already exists, is it one nobody owns? `ubuntu` on
/// an AWS image and `ec2-user` on an Amazon one are the logins every member of a
/// shared box arrives as, so anything sitting in their home — a credential, a
/// key — belongs to the box rather than to whoever is typing.
///
/// One list, asked from both directions, because two lists would agree until the
/// day somebody added `azureuser` to one of them.
pub fn is_bootstrap_login(login: &str) -> bool {
    let l = login.trim().to_ascii_lowercase();
    !l.is_empty() && RESERVED.contains(&l.as_str())
}

/// The script that makes it so, run once per member per place.
///
/// Idempotent on purpose, and in the specific sense that matters: running it
/// against an account that already exists must be how a member *verifies* their
/// place is still their own, not a second attempt at creating it. So every step
/// asks before it acts, and every step reports what it found rather than what
/// it did.
///
/// It is POSIX `sh`, not bash — the same script has to run under `ssh` on a
/// distro whose `/bin/sh` is dash, and under `sh -c` on this laptop.
pub fn provision_script(plan: &AccountPlan) -> String {
    let login = quote(&plan.login);
    // The key is split into the part that identifies it (`type base64`) and the
    // whole line. Matching on the body means re-running with a re-commented key
    // doesn't append a duplicate, which is how `authorized_keys` files grow
    // three copies of one key and nobody dares delete any of them.
    let (key_line, key_body) = match plan.public_key.as_deref().map(str::trim) {
        Some(k) if !k.is_empty() => {
            let body = k.split_whitespace().take(2).collect::<Vec<_>>().join(" ");
            (quote(k), quote(&body))
        }
        _ => ("''".to_string(), "''".to_string()),
    };
    let may_provision = if plan.may_provision { "yes" } else { "no" };

    format!(
        r#"set -u
LOGIN={login}
KEY_LINE={key_line}
KEY_BODY={key_body}
PROVISION={may_provision}
# The toolchain block, named before it is used and never inlined into a
# double-quoted command: its `$HOME` belongs to the member who will READ the
# profile, not to whoever is running this. See `place_toolchain`.
{toolchain_assign}
ME=$(id -un)

# What we can do here, decided once. `sudo -n` never prompts: a question asked
# down a pipe with nobody in front of it is a hang, not a question.
if [ "$(id -u)" -eq 0 ]; then PRIV=root
elif sudo -n true >/dev/null 2>&1; then PRIV=sudo
else PRIV=none
fi
as_root() {{
  [ "$PROVISION" = yes ] || return 1
  case "$PRIV" in
    root) "$@" ;;
    sudo) sudo -n "$@" ;;
    *) return 1 ;;
  esac
}}
# Enough rights to touch the member's own home: being root will do, and so will
# being the member. Refuses outright when we were asked to change nothing.
priv_sh() {{
  [ "$PROVISION" = yes ] || return 1
  if [ "$ME" = "$LOGIN" ]; then sh -c "$1"; else as_root sh -c "$1"; fi
}}

CREATED=no
if ! id -u "$LOGIN" >/dev/null 2>&1; then
  if [ "$PROVISION" != yes ]; then
    echo "there is no account called $LOGIN here, and this place does not make them" >&2
    exit 4
  fi
  if [ "$PRIV" = none ]; then
    echo "making an account on this machine needs root. Ask whoever administers it to run: sudo useradd -m -s /bin/bash $LOGIN" >&2
    exit 2
  fi
  as_root useradd --create-home --shell /bin/bash "$LOGIN" >&2 || exit 3
  CREATED=yes
fi

# Ask the box where the account lives rather than assuming /home/<login>: it is
# wrong on macOS, wrong on a box with a non-standard layout, and wrong for every
# account whose name is not its directory.
if [ "$ME" = "$LOGIN" ]; then HOME_DIR="$HOME"
else HOME_DIR=$(getent passwd "$LOGIN" 2>/dev/null | cut -d: -f6); fi
[ -n "$HOME_DIR" ] || HOME_DIR=$(eval printf '%s' "~$LOGIN" 2>/dev/null)
case "$HOME_DIR" in ""|"~"*) HOME_DIR="/home/$LOGIN" ;; esac

# The home directory is the whole promise: 0700 is what stops one member
# reading another's checkout, their agent's transcripts and their tokens.
priv_sh "chmod 700 '$HOME_DIR'" >/dev/null 2>&1 || true
PRIVATE=no
case "$(ls -ld "$HOME_DIR" 2>/dev/null | cut -c1-10)" in
  drwx------*) PRIVATE=yes ;;
esac

# Aura's own directory, before anything writes a token into it.
priv_sh "mkdir -p '$HOME_DIR/.config/aura' && chmod 700 '$HOME_DIR/.config' '$HOME_DIR/.config/aura'" >/dev/null 2>&1 || true
# Owner only, never `owner:group`: a distro that does not give each user a group
# of their own would fail the whole chown, and an .ssh directory left owned by
# root is a key the member cannot use and sshd will not read.
as_root chown -R "$LOGIN" "$HOME_DIR/.config" >/dev/null 2>&1 || true

KEY=absent
if [ -n "$KEY_LINE" ]; then
  priv_sh "mkdir -p '$HOME_DIR/.ssh' && chmod 700 '$HOME_DIR/.ssh' && touch '$HOME_DIR/.ssh/authorized_keys' && chmod 600 '$HOME_DIR/.ssh/authorized_keys'" >/dev/null 2>&1 || true
  if priv_sh "grep -qF \"$KEY_BODY\" '$HOME_DIR/.ssh/authorized_keys'" >/dev/null 2>&1; then
    KEY=present
  elif priv_sh "printf '%s\n' \"$KEY_LINE\" >> '$HOME_DIR/.ssh/authorized_keys'" >/dev/null 2>&1; then
    KEY=installed
  fi
  as_root chown -R "$LOGIN" "$HOME_DIR/.ssh" >/dev/null 2>&1 || true
fi

# A login shell reads one of these. `umask 077` there is what keeps the files
# the member makes LATER to themselves; the runner's own unit carries the same
# umask, because systemd reads neither of them.
#
# The second block is the other half of not treading on a teammate: a private
# home stops them READING your things, and scoping the toolchain stops their
# `npm install -g` OVERWRITING them. Rendered by `place_toolchain` rather than
# spelled out here, so the list of tools has one home.
UMASK=no
SCOPED=no
for RC in .profile .bash_profile; do
  [ "$RC" = .profile ] || [ -f "$HOME_DIR/$RC" ] || continue
  if grep -q 'aura: keep this account to itself' "$HOME_DIR/$RC" 2>/dev/null; then
    UMASK=yes
  elif priv_sh "printf '\n# aura: keep this account to itself\numask 077\n' >> '$HOME_DIR/$RC'" >/dev/null 2>&1; then
    UMASK=yes
  fi
  {toolchain}
done
as_root chown "$LOGIN" "$HOME_DIR/.profile" >/dev/null 2>&1 || true
# The directories those variables name, made now and owned by the member. A
# prefix pointing at a directory that does not exist sends npm back to
# /usr/local on the first install, which is the collision this exists to stop.
priv_sh "mkdir -p {dirs_inner}" >/dev/null 2>&1 || true
as_root chown -R "$LOGIN" {dirs} >/dev/null 2>&1 || true

# Without lingering, a per-member runner is only "runs while someone is SSH'd
# in" — the unit installs, looks healthy, and dies with the session.
LINGER=unavailable
if command -v loginctl >/dev/null 2>&1; then
  LINGER=off
  as_root loginctl enable-linger "$LOGIN" >/dev/null 2>&1 || true
  case "$(loginctl show-user "$LOGIN" -p Linger 2>/dev/null)" in
    *Linger=yes*) LINGER=on ;;
  esac
fi

{swap}
echo "___AURA""_ACCOUNT___"
echo "login=$LOGIN"
echo "home=$HOME_DIR"
echo "created=$CREATED"
echo "key=$KEY"
echo "linger=$LINGER"
echo "private=$PRIVATE"
echo "umask=$UMASK"
echo "scoped=$SCOPED"
echo "swap=$SWAP"
echo "you=$ME"
"#,
        toolchain_assign = super::place_toolchain::provision_assign(),
        toolchain = super::place_toolchain::provision_snippet(),
        dirs = super::place_toolchain::provision_dirs(),
        dirs_inner = super::place_toolchain::provision_dirs_within_priv_sh(),
        swap = super::place_swap::provision_snippet(),
    )
}

/// Read the report back.
///
/// Everything before the marker is the box's own noise — a MOTD, a sudo lecture,
/// whatever the profile prints — and is dropped rather than parsed around.
pub fn parse_report(out: &str) -> Result<MemberAccount, String> {
    let body = match out.split_once(REPORT) {
        Some((_, rest)) => rest,
        // No marker means the script did not reach its last lines. Its own
        // stderr has already been raised by `Place::ask`; this is the case
        // where it exited 0 without finishing, which should be impossible and
        // must not be reported as an account that exists.
        None => return Err("the machine did not say what account it made".into()),
    };
    let f = |k: &str| -> String {
        body.lines()
            .filter_map(|l| l.trim().split_once('='))
            .find(|(key, _)| *key == k)
            .map(|(_, v)| v.trim().to_string())
            .unwrap_or_default()
    };
    let login = f("login");
    if login.is_empty() {
        return Err("the machine did not name the account".into());
    }
    let home = f("home");
    // Blank means the box never told us, which for this one question reads as
    // "the session is already the member" — the case where nothing has to be
    // handed over.
    let you = match f("you") {
        y if y.is_empty() => login.clone(),
        y => y,
    };
    Ok(MemberAccount {
        home: if home.is_empty() {
            format!("/home/{login}")
        } else {
            home
        },
        created: f("created") == "yes",
        key: match f("key").as_str() {
            "installed" => "installed".into(),
            "present" => "present".into(),
            _ => "absent".into(),
        },
        linger: match f("linger").as_str() {
            "on" => "on".into(),
            "off" => "off".into(),
            _ => "unavailable".into(),
        },
        private: f("private") == "yes",
        umask: f("umask") == "yes",
        scoped: f("scoped") == "yes",
        // Narrowed rather than taken at face value: an unrecognised answer is
        // "we could not tell", never "this box has no swap". The two send an
        // operator to different places.
        swap: super::place_swap::state_of(&f("swap")),
        is_you: you == login,
        you,
        login,
    })
}

impl Place {
    /// Make sure the member owns an account of their own here, and report what
    /// this place actually holds.
    ///
    /// The whole point of a shared place: two members are two Unix users, two
    /// homes, two sign-ins and two runner tokens, and neither can read the
    /// other's. On a place that is one person's, this is a no-op that tells you
    /// the account you already have — which is the right answer, not a refusal,
    /// because "is my login mine alone" is a fair question on any box.
    pub async fn member_account(&self, plan: &AccountPlan) -> Result<MemberAccount, String> {
        let out = self.ask(provision_script(&self.account_plan(plan))).await?;
        parse_report(&out)
    }

    /// What this place will actually do when asked for a member's account.
    ///
    /// Split out from [`Place::member_account`] because it is the whole of the
    /// mode-dependence and none of the machine: it decides, and reaches
    /// nothing. That makes it answerable about a box nobody can dial — which is
    /// what the workflow matrix needs to ask both places the same question
    /// without a live machine on the other end of one of them.
    ///
    /// This laptop is not a machine to be given accounts. It has exactly one
    /// member — the person typing — and `useradd` behind a button meant for
    /// shared hardware is not a feature, it is an accident waiting for a caller
    /// that passed the wrong login. So a local place answers the question and
    /// changes nothing.
    pub(super) fn account_plan(&self, plan: &AccountPlan) -> AccountPlan {
        match self {
            Place::Here { .. } => AccountPlan {
                login: plan.login.clone(),
                public_key: None,
                may_provision: false,
            },
            Place::Box { .. } => plan.clone(),
        }
    }
}

/// The login this member should own on a machine, derived from the account they
/// are signed in to Aura with.
///
/// Not a machine command: it reaches nothing, and asking a box who you are
/// would be asking the wrong computer. The wizard shows it before anything is
/// created, so the member can change it — they may already have an account on
/// that box under another name.
#[tauri::command]
pub async fn member_account_login() -> Result<String, String> {
    member_login_here()
}

/// The same answer, without an `await`.
///
/// [`super::place_secrets`] needs it from a synchronous path — deciding whose
/// vault a boot reads happens while a pty is being assembled, not in a runtime —
/// and this is the body rather than a second derivation of it. Two functions
/// that each worked out a member's login would agree right up until one of them
/// learned about a rename.
pub fn member_login_here() -> Result<String, String> {
    let creds = crate::cloud_session_sync::read_credentials().unwrap_or_default();
    let handle = creds
        .get("cloud_user")
        .and_then(|v| v.as_str())
        .map(str::trim)
        .unwrap_or_default();
    member_login(handle)
}

/// Give this member their own account on a machine.
///
/// `machine_id` is insisted upon rather than optional: "make me an account" is a
/// question about a specific box, and quietly answering it about this laptop
/// would be a wrong answer wearing a right one's clothes.
///
/// `key_path` defaults to the key the machine is already dialled with, which is
/// the honest default — it is the key in the member's hands right now. The
/// public half is read HERE, from this laptop, and only ever the public half.
#[tauri::command]
pub async fn place_member_account(
    machine_id: String,
    login: Option<String>,
    key_path: Option<String>,
) -> Result<MemberAccount, String> {
    let place = Place::at_machine(&machine_id)?;
    let login = match login.as_deref().map(str::trim).filter(|s| !s.is_empty()) {
        Some(l) => member_login(l)?,
        None => member_account_login().await?,
    };
    let key = key_path
        .as_deref()
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(str::to_string)
        .or_else(|| match place.identity().key_path {
            Some(k) if !k.trim().is_empty() => Some(k),
            _ => None,
        });
    let public_key = match key {
        Some(path) => Some(public_key_for(&path)?),
        None => None,
    };
    place
        .member_account(&AccountPlan {
            login,
            public_key,
            may_provision: true,
        })
        .await
}

/// The public half of a private key on THIS laptop.
///
/// Two ways, in the order that costs least: the `.pub` file `ssh-keygen` writes
/// beside every key it generates, then `ssh-keygen -y`, which derives it from
/// the private key. The second needs the key to be passphrase-free — with no
/// terminal to prompt on it simply fails, which is the right failure, said in
/// words the member can act on.
fn public_key_for(key_path: &str) -> Result<String, String> {
    let path = expand_home(key_path);
    let beside = format!("{path}.pub");
    if let Ok(text) = std::fs::read_to_string(&beside) {
        if let Some(line) = first_key_line(&text) {
            return Ok(line);
        }
    }
    let out = std::process::Command::new("ssh-keygen")
        .args(["-y", "-f", &path])
        .output()
        .map_err(|e| format!("couldn't run ssh-keygen to read {path}: {e}"))?;
    if out.status.success() {
        if let Some(line) = first_key_line(&String::from_utf8_lossy(&out.stdout)) {
            return Ok(line);
        }
    }
    Err(format!(
        "Aura couldn't read the public half of {path}, so it has no key to let you into your own \
         account with. Put {beside} beside it (ssh-keygen writes one), or use a key without a \
         passphrase, then try again."
    ))
}

/// The first line of a file that actually looks like an SSH public key.
fn first_key_line(text: &str) -> Option<String> {
    text.lines()
        .map(str::trim)
        .find(|l| {
            let mut parts = l.split_whitespace();
            let kind = parts.next().unwrap_or("");
            let body = parts.next().unwrap_or("");
            !body.is_empty()
                && (kind.starts_with("ssh-") || kind.starts_with("ecdsa-") || kind.starts_with("sk-"))
        })
        .map(str::to_string)
}

/// `~/x` is this laptop's own shorthand and no `std::fs` call expands it.
fn expand_home(path: &str) -> String {
    let p = path.trim();
    match p.strip_prefix("~/") {
        Some(rest) => match std::env::var("HOME") {
            Ok(home) => format!("{}/{rest}", home.trim_end_matches('/')),
            Err(_) => p.to_string(),
        },
        None => p.to_string(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn block_on<F: std::future::Future>(f: F) -> F::Output {
        tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .expect("runtime")
            .block_on(f)
    }

    #[test]
    fn a_handle_becomes_a_login_a_box_will_accept() {
        assert_eq!(member_login("mhask").unwrap(), "mhask");
        assert_eq!(member_login("  MHask  ").unwrap(), "mhask");
        assert_eq!(member_login("Mo Ashiq").unwrap(), "mo-ashiq");
        assert_eq!(member_login("mo.ashiq+aura").unwrap(), "mo-ashiq-aura");
    }

    /// A member reliably carries a handle; some carry an email. The domain is
    /// not part of who they are on one box.
    #[test]
    fn an_email_is_a_handle_with_a_domain_glued_on() {
        assert_eq!(member_login("mo@naridon.com").unwrap(), "mo");
    }

    /// `useradd 3things` and `chown -mo` are two different kinds of wrong. A
    /// login starts with a letter or it isn't one.
    #[test]
    fn a_login_starts_with_a_letter() {
        assert_eq!(member_login("42-mo").unwrap(), "mo");
        assert_eq!(member_login("--mo--").unwrap(), "mo");
        assert!(member_login("42").is_err());
        assert!(member_login("   ").is_err());
    }

    /// Taking `root` and handing back `root-1` would give somebody an account
    /// they cannot recognise as theirs. Taking it and handing back `root` would
    /// give them everybody's.
    #[test]
    fn a_name_the_box_already_uses_is_refused_rather_than_nudged() {
        assert!(member_login("root").is_err());
        assert!(member_login("ubuntu").is_err());
        assert!(member_login("ec2-user").is_err());
        // Refused by name, not by resemblance: a real member called `admino`
        // keeps their own login.
        assert_eq!(member_login("admino").unwrap(), "admino");
    }

    #[test]
    fn a_long_handle_is_cut_to_something_useradd_takes() {
        let long = "a".repeat(64);
        let got = member_login(&long).unwrap();
        assert_eq!(got.len(), MAX_LOGIN);
        assert!(!got.ends_with('-'));
    }

    /// Everything a member types reaches a real `sh`. A login is narrowed before
    /// it gets there, but the script quotes it anyway — the two rules are worth
    /// having separately, because only one of them is in front of the user.
    #[test]
    fn nothing_a_member_types_can_become_a_second_command() {
        let plan = AccountPlan {
            login: "mo".into(),
            public_key: Some("ssh-ed25519 AAAAC3Nz mo@laptop".into()),
            may_provision: true,
        };
        let s = provision_script(&plan);
        assert!(s.contains("LOGIN='mo'"));
        assert!(s.contains("KEY_LINE='ssh-ed25519 AAAAC3Nz mo@laptop'"));
        // Matched on the key's own bytes, not on its comment, so re-running
        // with a re-commented key doesn't append a second copy.
        assert!(s.contains("KEY_BODY='ssh-ed25519 AAAAC3Nz'"));
    }

    /// The script is real POSIX `sh`, checked by a real shell.
    ///
    /// Everything else in this module asserts that some substring is present,
    /// which is exactly the test that keeps passing while the script has stopped
    /// parsing. And an unparseable script does not degrade — `sh` refuses the
    /// whole file, so a stray brace in one block takes the account provisioning
    /// with it, on somebody's box, in the middle of a wizard.
    ///
    /// `sh -n` rather than `bash -n`: the rendered script runs under whatever
    /// `/bin/sh` the far box has, which on Debian and Ubuntu is dash, and dash
    /// rejects several things bash accepts.
    #[test]
    fn the_rendered_script_parses_as_posix_sh() {
        use std::io::Write;
        for may_provision in [true, false] {
            let s = provision_script(&AccountPlan {
                login: "mo".into(),
                public_key: Some("ssh-ed25519 AAAAC3Nz mo@laptop".into()),
                may_provision,
            });
            let dir = std::env::temp_dir().join(format!("aura-acct-{may_provision}.sh"));
            let mut f = std::fs::File::create(&dir).expect("write the script out");
            f.write_all(s.as_bytes()).expect("write the script out");
            drop(f);
            let out = std::process::Command::new("sh")
                .arg("-n")
                .arg(&dir)
                .output()
                .expect("run sh -n");
            let _ = std::fs::remove_file(&dir);
            assert!(
                out.status.success(),
                "the provisioning script does not parse (may_provision={may_provision}):\n{}",
                String::from_utf8_lossy(&out.stderr)
            );
        }
    }

    /// The report's own marker must not appear in the line that prints it, or
    /// a terminal echoing the script would look like the script's answer.
    #[test]
    fn the_script_never_contains_the_marker_it_prints() {
        let s = provision_script(&AccountPlan {
            login: "mo".into(),
            public_key: None,
            may_provision: true,
        });
        assert!(!s.contains(REPORT));
    }

    /// The four things a shared box has to get right, read back off the box
    /// rather than assumed from what we asked for.
    #[test]
    fn the_report_is_what_the_machine_says_it_did() {
        let out = "Welcome to Ubuntu 24.04\n___AURA_ACCOUNT___\nlogin=mo\nhome=/home/mo\n\
                   created=yes\nkey=installed\nlinger=on\nprivate=yes\numask=yes\nyou=ubuntu\n";
        let a = parse_report(out).unwrap();
        assert_eq!(a.login, "mo");
        assert_eq!(a.home, "/home/mo");
        assert!(a.created);
        assert_eq!(a.key, "installed");
        assert_eq!(a.linger, "on");
        assert!(a.private && a.umask);
        // The session that asked is somebody else — so it has to become the
        // member before anything is written into their home.
        assert_eq!(a.you, "ubuntu");
        assert!(!a.is_you);
    }

    #[test]
    fn an_account_that_was_already_there_is_not_reported_as_new() {
        let out = "___AURA_ACCOUNT___\nlogin=mo\nhome=/home/mo\ncreated=no\nkey=present\n\
                   linger=on\nprivate=yes\numask=yes\nyou=mo\n";
        let a = parse_report(out).unwrap();
        assert!(!a.created);
        assert_eq!(a.key, "present");
        assert!(a.is_you);
    }

    /// A box that answered with something other than the report has not made an
    /// account, and must never be rendered as though it had.
    #[test]
    fn output_without_a_report_is_not_an_account() {
        assert!(parse_report("bash: useradd: command not found\n").is_err());
        assert!(parse_report("___AURA_ACCOUNT___\nhome=/home/mo\n").is_err());
    }

    /// A box that has no `loginctl` has no user units at all — which is a
    /// different thing from lingering being refused, and the member needs to
    /// know which one they got.
    #[test]
    fn a_box_with_no_user_units_says_so_rather_than_reporting_failure() {
        let out = "___AURA_ACCOUNT___\nlogin=mo\nhome=/home/mo\ncreated=no\nkey=absent\n\
                   linger=unavailable\nprivate=yes\numask=yes\nyou=mo\n";
        assert_eq!(parse_report(out).unwrap().linger, "unavailable");
    }

    /// The claim this whole file exists for, exercised end to end on the one
    /// place a test can safely run it: this laptop is already the member's own
    /// account, it reports the login it is running as, and it creates nothing.
    #[test]
    fn this_laptop_reports_the_account_it_runs_as_and_makes_none() {
        let me = std::env::var("USER")
            .or_else(|_| std::env::var("LOGNAME"))
            .unwrap_or_default();
        if me.trim().is_empty() {
            return;
        }
        let place = Place::Here {
            root: std::env::temp_dir().display().to_string(),
        };
        let got = block_on(place.member_account(&AccountPlan {
            login: me.trim().to_string(),
            // Both are ignored here on purpose — a local place is given no key
            // and is never allowed to create.
            public_key: Some("ssh-ed25519 AAAAC3Nz nobody@nowhere".into()),
            may_provision: true,
        }))
        .expect("this laptop must be able to answer who it runs as");
        assert_eq!(got.login, me.trim());
        assert!(!got.created, "a local place must never create an account");
        assert_eq!(got.key, "absent", "no key is installed on this laptop");
        assert!(got.is_you);
    }

    /// A login this laptop does NOT run as cannot be conjured into existence by
    /// asking a local place for it.
    #[test]
    fn a_local_place_refuses_to_invent_an_account() {
        let place = Place::Here {
            root: std::env::temp_dir().display().to_string(),
        };
        let err = block_on(place.member_account(&AccountPlan {
            login: "nobody-aura-would-make".into(),
            public_key: None,
            may_provision: true,
        }))
        .expect_err("a local place has no accounts to hand out");
        assert!(
            err.contains("does not make them"),
            "unexpected refusal: {err}"
        );
    }

    /// The governing rule of this programme, made structural rather than
    /// remembered: no feature may land in one place-mode only.
    ///
    /// Nothing here can tell a box you brought from one Aura provisioned,
    /// because there is nothing here to tell it WITH — a machine's `box_kind`
    /// never reaches this module. So the day the managed arm exists, it cannot
    /// arrive with accounts that differ from BYOC's, or without them.
    #[test]
    fn making_an_account_never_asks_what_kind_of_place_this_is() {
        let src = include_str!("place_account.rs");
        // Prose is allowed to name the modes — it is explaining them. Code is
        // not, so the comments come out before we look.
        let code = src
            .lines()
            .take_while(|l| !l.starts_with("#[cfg(test)]"))
            .filter(|l| !l.trim_start().starts_with("//"))
            .collect::<Vec<_>>()
            .join("\n");
        for asked in ["box_kind", "managed", "provisioning_mode", "is_byoc"] {
            assert!(
                !code.contains(asked),
                "place_account branches on `{asked}` — one place-mode is about to get an \
                 account arrangement the other doesn't"
            );
        }
    }

    /// Two members, one machine, and neither can read the other. The acceptance
    /// criterion itself, run rather than argued.
    ///
    /// It needs a real Linux — macOS has no `useradd`, and a test that only ever
    /// ran against this laptop would be pinning the read-only arm and calling it
    /// proof. So it runs the actual script, twice, in a container, and then goes
    /// and looks: home directories, ownership, keys, umask, and one member
    /// trying to read the other's.
    ///
    /// Off unless `AURA_LIVE_DOCKER=1`, because a build must not fail on a
    /// laptop with no docker over a test about somebody else's box.
    #[test]
    fn two_members_on_one_machine_cannot_read_each_other() {
        if std::env::var("AURA_LIVE_DOCKER").as_deref() != Ok("1") {
            eprintln!("skipped: set AURA_LIVE_DOCKER=1 (and have docker) to run this for real");
            return;
        }
        let script = |login: &str, key: &str| {
            provision_script(&AccountPlan {
                login: login.into(),
                public_key: Some(key.into()),
                may_provision: true,
            })
        };
        let mo = script("mo", "ssh-ed25519 AAAAmomomo mo@laptop");
        let ana = script("ana", "ssh-ed25519 AAAAanaana ana@laptop");
        // What we go and look at afterwards, from root's vantage point and from
        // one member's. `su - mo` is a login shell, so it reads the profile the
        // script wrote — which is the only honest way to check the umask.
        let look = "echo \"___AURA\"\"_CHECK___\"\n\
             echo \"mo_mode=$(stat -c %a /home/mo)\"\n\
             echo \"ana_mode=$(stat -c %a /home/ana)\"\n\
             echo \"mo_owner=$(stat -c %U /home/mo)\"\n\
             echo \"ana_owner=$(stat -c %U /home/ana)\"\n\
             echo \"mo_key_owner=$(stat -c %U /home/mo/.ssh/authorized_keys)\"\n\
             echo \"mo_key_mode=$(stat -c %a /home/mo/.ssh/authorized_keys)\"\n\
             echo \"mo_key=$(cat /home/mo/.ssh/authorized_keys)\"\n\
             echo \"ana_key=$(cat /home/ana/.ssh/authorized_keys)\"\n\
             echo \"mo_umask=$(su - mo -c umask)\"\n\
             echo \"mo_lists_ana=$(su - mo -c 'ls /home/ana' 2>&1 | head -1)\"\n\
             echo \"mo_reads_ana_key=$(su - mo -c 'cat /home/ana/.ssh/authorized_keys' 2>&1 | head -1)\"\n";
        let program = format!("{mo}\n{ana}\n{look}");

        let mut child = std::process::Command::new("docker")
            .args(["run", "--rm", "-i", "ubuntu:24.04", "sh", "-s"])
            .stdin(std::process::Stdio::piped())
            .stdout(std::process::Stdio::piped())
            .stderr(std::process::Stdio::piped())
            .spawn()
            .expect("docker must be runnable when AURA_LIVE_DOCKER=1");
        {
            use std::io::Write;
            child
                .stdin
                .as_mut()
                .expect("stdin")
                .write_all(program.as_bytes())
                .expect("write the script to the container's shell");
        }
        let out = child.wait_with_output().expect("container run");
        let text = String::from_utf8_lossy(&out.stdout).to_string();
        assert!(
            out.status.success(),
            "the container refused the script: {}\n{text}",
            String::from_utf8_lossy(&out.stderr)
        );

        // Both members were made, and each report says so before we go looking.
        let mo_said = parse_report(&text).expect("mo's report");
        assert_eq!(mo_said.login, "mo");
        assert!(mo_said.created, "mo's account was made by this run");
        assert!(mo_said.private, "mo's home must be closed");
        assert_eq!(mo_said.key, "installed");

        let seen = text
            .split_once("___AURA_CHECK___")
            .map(|(_, rest)| rest.to_string())
            .expect("the container must have reached the checks");
        let f = |k: &str| -> String {
            seen.lines()
                .filter_map(|l| l.trim().split_once('='))
                .find(|(key, _)| *key == k)
                .map(|(_, v)| v.trim().to_string())
                .unwrap_or_default()
        };
        assert_eq!(f("mo_mode"), "700", "mo's home is open to the box");
        assert_eq!(f("ana_mode"), "700", "ana's home is open to the box");
        assert_eq!(f("mo_owner"), "mo");
        assert_eq!(f("ana_owner"), "ana");
        assert_eq!(f("mo_key_owner"), "mo", "sshd will not read a key it can't own");
        assert_eq!(f("mo_key_mode"), "600");
        // Each member's own key, and only their own.
        assert!(f("mo_key").contains("AAAAmomomo"));
        assert!(!f("mo_key").contains("AAAAanaana"));
        assert!(f("ana_key").contains("AAAAanaana"));
        assert_eq!(f("mo_umask"), "0077", "what mo writes later must be mo's");
        // The whole point, stated by the machine: one member, standing in their
        // own account, cannot see into another's.
        assert!(
            f("mo_lists_ana").contains("Permission denied"),
            "mo can read ana's home: {}",
            f("mo_lists_ana")
        );
        assert!(
            f("mo_reads_ana_key").contains("Permission denied"),
            "mo can read ana's key: {}",
            f("mo_reads_ana_key")
        );
    }
}
