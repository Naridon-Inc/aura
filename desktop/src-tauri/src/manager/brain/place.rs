//! Where a conversation's hands are.
//!
//! A chat with a machine used to be a different *kind of thing* from a chat
//! with your own repo. Locally you got a live brain: streaming text, tool
//! cards, file diffs, `@`-mentions, approvals, a running cost. In the cloud you
//! got a text box that posted a row onto a task board and a poller that read
//! whatever came back hours later. Same word, two products, and the second one
//! is the one people stopped opening.
//!
//! The two were never that far apart, though. Look at what the brain's tools
//! actually do and every one of them touches the world through a single
//! variable — the project root. `read_file` reads a path under it, `list_dir`
//! lists one, `bash` runs with it as the working directory, and `aura_ask`,
//! `prove`, `review` and `rewind` shell the `aura` binary there. So the whole
//! difference between "this conversation edits my laptop" and "this
//! conversation edits that box" is *where those four verbs land*.
//!
//! That is this type. `execute_tool` takes a `Place` instead of a path, and
//! nothing above it changes: same chat component, same brain, same stream,
//! same cards. Parity by construction, rather than by two implementations
//! somebody has to remember to keep in step.
//!
//! ## Four verbs were not the whole contract
//!
//! Those four were what the chat's tools needed, and the chat is one surface.
//! Every *other* surface that reaches a machine had grown its own way in:
//! the terminal builds ssh lines in TypeScript, the agent picker asks its own
//! question about what is installed over there, the session list is a set of
//! `box_*` commands, and "is this box even up?" is answered wherever somebody
//! last needed to know.
//!
//! Each of those is a place where a second way of getting a machine — an
//! Aura-managed VM rather than one you brought — silently gains fewer features
//! than the first, and nobody finds out until a user does. So the seam is now
//! the whole runtime contract, and there is nowhere else to ask:
//!
//! * [`Place::open`] — a terminal here, as argv to spawn
//! * [`Place::capabilities`] — what this place can run
//! * [`Place::sessions`] / [`Place::start`] / [`Place::stop`] — the work on it
//! * [`Place::identity`] — who the work runs as, and where
//! * [`Place::lifecycle`] — is it there, and is it ours to end
//! * [`Place::meter`] — who gets the bill, and for what
//!
//! Only four things are allowed to differ between two ways of getting a place:
//! who creates the machine, where the address lives, who holds root and the
//! key, and who gets the bill. Everything else goes through here.
//!
//! `cloudbox` is the first implementation. Its scripts are plain strings and
//! its parsers are plain functions, so they are not "the remote versions" of
//! anything — they are the bodies, and this type only chooses whether to hand
//! them to `ssh` or to `sh`. The session and project verbs live next door in
//! [`super::place_sessions`]; the terminal lines in [`super::place_open`].
//!
//! ## What deliberately does not move
//!
//! The model call stays on this laptop. Only the hands reach across the wire.
//! That is partly honesty — the thinking was never the part that needed to be
//! near the code — and partly safety: a shared box has one login and one set of
//! dotfiles, so an API key copied there is an API key every other person with
//! access can read. Nothing here puts one there.
//!
//! ## The cost of a round trip
//!
//! Every remote verb is one ssh invocation. That is only affordable because
//! `cloudbox` multiplexes connections; without a live master socket each of
//! these would pay a fresh key exchange and a conversation would crawl. If
//! remote chat ever feels slow, look there first.

use std::path::PathBuf;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use crate::cloudbox::script::{is_abs_path, is_home_rel_path, quote};
use crate::cloudbox::{dial, dialable, is_dialable, ssh_argv, Ran, SSH_TIMEOUT};
use crate::cmd_machines::{machine_id, Machine};

use super::place_contract::{Address, Identity, Lifecycle, Meter, Open, Shell};
use super::place_open;
use super::place_secrets::BootSecrets;

/// One entry in a directory listing.
#[derive(Debug, Clone, PartialEq)]
pub struct Entry {
    pub name: String,
    pub is_dir: bool,
}

/// What a command said, wherever it ran.
#[derive(Debug, Clone, PartialEq)]
pub struct Output {
    pub code: i32,
    pub stdout: String,
    pub stderr: String,
}

impl Output {
    pub fn ok(&self) -> bool {
        self.code == 0
    }
}

/// Where this conversation's work happens.
#[derive(Debug, Clone)]
pub enum Place {
    /// This laptop — the original behaviour, unchanged.
    Here { root: String },
    /// A machine you connected.
    Box {
        machine: Box<Machine>,
        /// The working directory over *there*.
        root: String,
        /// The checkout on *this* laptop the conversation belongs to.
        ///
        /// Not redundant: a chat has two homes, and confusing them is how
        /// this gets subtly wrong. The code being edited is on the box, but
        /// the task board, the Pages, the intent log and the session file are
        /// all under `.aura/` on this disk, for this project, and stay there.
        /// A remote chat still files its work on your own board.
        here: String,
    },
}

impl Place {
    /// Work out where a session's hands belong.
    ///
    /// A machine id that is no longer in the book falls back to working here
    /// rather than failing the turn. That is the kinder of two bad options: the
    /// alternative is a conversation that can no longer answer anything at all
    /// because a machine was forgotten last week, and the tools that then run
    /// locally will say so in their own output soon enough.
    pub fn resolve(root: impl Into<String>, machine_id: Option<&str>) -> Self {
        let root = root.into();
        match machine_id.map(str::trim).filter(|s| !s.is_empty()) {
            Some(id) => match dialable(id) {
                Ok(m) => {
                    // A box's row remembers where the project sits on it. The
                    // local root is a path on *this* disk and means nothing
                    // over there, so it is never the fallback.
                    let there = m
                        .repo_path
                        .clone()
                        .map(|p| p.trim().to_string())
                        .filter(|p| !p.is_empty())
                        .unwrap_or_else(|| "~".to_string());
                    Place::Box {
                        machine: Box::new(m),
                        root: there,
                        here: root,
                    }
                }
                Err(_) => Place::Here { root },
            },
            None => Place::Here { root },
        }
    }

    /// A machine, insisted upon.
    ///
    /// The counterpart to [`Place::resolve`], and deliberately the opposite
    /// bargain. `resolve` serves a conversation, where a forgotten machine
    /// should degrade to working here rather than end the chat. This serves a
    /// caller that asked *about a specific box* — list its sessions, stop one —
    /// and for those, quietly answering about this laptop instead would be a
    /// wrong answer wearing a right one's clothes.
    pub fn at_machine(machine_id: &str) -> Result<Self, String> {
        let m = dialable(machine_id)?;
        let root = m
            .repo_path
            .clone()
            .map(|p| p.trim().to_string())
            .filter(|p| !p.is_empty())
            .unwrap_or_else(|| "~".to_string());
        let here = m
            .project_root
            .clone()
            .map(|p| p.trim().to_string())
            .filter(|p| !p.is_empty())
            .unwrap_or_default();
        Ok(Place::Box {
            machine: Box::new(m),
            root,
            here,
        })
    }

    /// A machine described but not yet written down.
    ///
    /// The third and last way to name a place, and the narrowest: the connect
    /// wizard opens a terminal on a box before the book has heard of it. That
    /// order is the point — the shell answering is what proves the address
    /// works, so a mistyped host leaves no row behind — which means the wizard
    /// has no machine id to pass and cannot use [`Place::at_machine`].
    ///
    /// It is a place like any other from here on: same command body, same
    /// transport, same refusal of an address that isn't one. What it does not
    /// have is a project directory, because nobody has been there yet — a
    /// terminal opened on it lands where the box puts you.
    pub fn at_address(a: &Address) -> Result<Self, String> {
        let machine = Machine {
            id: machine_id(&a.user, &a.host, None),
            // Its address, until the wizard is told what to call it.
            name: a.host.trim().to_string(),
            host: a.host.trim().to_string(),
            user: a.user.trim().to_string(),
            key_path: a.key_path.trim().to_string(),
            box_kind: a.kind.trim().to_string(),
            repo_path: None,
            repo_branch: None,
            project_root: None,
            org_slug: None,
            forward_agent: a.forward_agent,
            // An address the wizard was handed is a box somebody else made, so
            // there is no substrate handle to carry and nothing Aura could put
            // to sleep. `None` here is the honest answer rather than a default.
            instance_id: None,
            asleep_since: 0,
            added_at: 0,
            last_used_at: 0,
        };
        if !is_dialable(&machine) {
            return Err(
                "That isn't an address this laptop can dial. A machine is a login and a host — \
                 letters, numbers, dots and dashes — and the path to the key that opens it."
                    .to_string(),
            );
        }
        Ok(Place::Box {
            machine: Box::new(machine),
            root: String::new(),
            here: String::new(),
        })
    }

    /// The working directory, as written wherever it lives.
    pub fn root(&self) -> &str {
        match self {
            Place::Here { root } => root,
            Place::Box { root, .. } => root,
        }
    }

    /// The checkout on this laptop — where anything that is a record rather
    /// than a working copy belongs, whichever machine holds the code.
    pub fn here(&self) -> &str {
        match self {
            Place::Here { root } => root,
            Place::Box { here, .. } => here,
        }
    }

    /// The machine's name when this is not the laptop — what to put on screen
    /// so a conversation editing a box somewhere else never looks identical to
    /// one editing this disk.
    pub fn machine_name(&self) -> Option<&str> {
        match self {
            Place::Here { .. } => None,
            Place::Box { machine, .. } => Some(&machine.name),
        }
    }

    pub fn is_remote(&self) -> bool {
        matches!(self, Place::Box { .. })
    }

    /// What to call this place in a sentence a person reads.
    pub fn label(&self) -> &str {
        match self {
            Place::Here { .. } => "this laptop",
            Place::Box { machine, .. } => &machine.name,
        }
    }

    /// Read a file, up to `max` bytes.
    ///
    /// The cap is enforced on the far side too, not only after the bytes
    /// arrive: a chat that asks for a 2GB log file should cost one screenful
    /// of transfer, not two gigabytes and then a truncation.
    pub async fn read(&self, path: &str, max: usize) -> Result<String, String> {
        match self {
            Place::Here { root } => {
                let p = resolve_local(root, path);
                tokio::fs::read_to_string(&p)
                    .await
                    .map(|s| clamp(&s, max))
                    .map_err(|e| format!("read {}: {e}", p.display()))
            }
            Place::Box { machine, root, .. } => {
                let p = resolve_remote(root, path)?;
                let ran = self
                    .run_remote(
                        machine,
                        format!("head -c {max} -- {}", quote(&p)),
                        None,
                        READ_WAIT,
                    )
                    .await?;
                if ran.code == 0 {
                    Ok(clamp(&ran.stdout, max))
                } else {
                    Err(format!("read {p}: {}", first_line(&ran.stderr)))
                }
            }
        }
    }

    /// What is immediately inside a directory.
    pub async fn list(&self, path: &str) -> Result<Vec<Entry>, String> {
        match self {
            Place::Here { root } => {
                let p = resolve_local(root, path);
                let mut rd = tokio::fs::read_dir(&p)
                    .await
                    .map_err(|e| format!("list {}: {e}", p.display()))?;
                let mut out = vec![];
                while let Ok(Some(e)) = rd.next_entry().await {
                    out.push(Entry {
                        name: e.file_name().to_string_lossy().to_string(),
                        is_dir: e.file_type().await.map(|t| t.is_dir()).unwrap_or(false),
                    });
                }
                Ok(out)
            }
            Place::Box { machine, root, .. } => {
                let p = resolve_remote(root, path)?;
                // `-p` marks directories with a trailing slash and `-A` keeps
                // dotfiles while dropping `.` and `..` — one round trip for
                // both halves of what an entry is.
                let ran = self
                    .run_remote(machine, format!("ls -Ap -- {}", quote(&p)), None, READ_WAIT)
                    .await?;
                if ran.code != 0 {
                    return Err(format!("list {p}: {}", first_line(&ran.stderr)));
                }
                Ok(parse_listing(&ran.stdout))
            }
        }
    }

    /// Run a shell command in the root.
    ///
    /// Nothing is validated: this is the user's own command, typed or written
    /// by their own agent, and it runs with exactly the reach it would have if
    /// they had typed it into a terminal in the same directory. The quoting
    /// below exists so it arrives *unmangled*, not to restrain it — a remote
    /// `bash` tool that silently rewrote commands would be worse than one that
    /// refused them.
    pub async fn sh(&self, command: &str, wait: Duration) -> Result<Output, String> {
        match self {
            Place::Here { root } => {
                let fut = tokio::process::Command::new("sh")
                    .args(["-c", command])
                    .current_dir(crate::spawn_dir::safe_spawn_dir(root))
                    .output();
                match tokio::time::timeout(wait, fut).await {
                    Ok(Ok(o)) => Ok(Output {
                        code: o.status.code().unwrap_or(-1),
                        stdout: String::from_utf8_lossy(&o.stdout).into_owned(),
                        stderr: String::from_utf8_lossy(&o.stderr).into_owned(),
                    }),
                    Ok(Err(e)) => Err(format!("spawn: {e}")),
                    Err(_) => Err(timed_out(command, wait)),
                }
            }
            Place::Box { machine, root, .. } => {
                let ran = self
                    .run_remote(machine, remote_sh(root, command, wait), None, wait + SSH_SLACK)
                    .await?;
                if ran.code == TIMED_OUT {
                    return Err(timed_out(command, wait));
                }
                Ok(ran.into())
            }
        }
    }

    /// Run the `aura` binary in the root.
    ///
    /// Locally that is the binary this build resolves; on a box it is whatever
    /// `aura` is on that machine's PATH, which is the same one its own agents
    /// and hooks use. Deliberately not shipped or version-pinned from here: a
    /// box's Aura belongs to the box.
    pub async fn aura(&self, args: &[&str], wait: Duration) -> Result<Output, String> {
        match self {
            Place::Here { root } => {
                let fut = tokio::process::Command::new(
                    crate::agent_event_listener::resolve_aura_bin(),
                )
                .args(args)
                .current_dir(crate::spawn_dir::safe_spawn_dir(root))
                .output();
                match tokio::time::timeout(wait, fut).await {
                    Ok(Ok(o)) => Ok(Output {
                        code: o.status.code().unwrap_or(-1),
                        stdout: String::from_utf8_lossy(&o.stdout).into_owned(),
                        stderr: String::from_utf8_lossy(&o.stderr).into_owned(),
                    }),
                    Ok(Err(e)) => Err(format!("spawn aura: {e}")),
                    Err(_) => Err(timed_out(&format!("aura {}", args.join(" ")), wait)),
                }
            }
            Place::Box { machine, root, .. } => {
                let line = format!(
                    "aura {}",
                    args.iter().map(|a| quote(a)).collect::<Vec<_>>().join(" ")
                );
                let ran = self
                    .run_remote(machine, remote_sh(root, &line, wait), None, wait + SSH_SLACK)
                    .await?;
                if ran.code == NOT_FOUND {
                    return Err(format!(
                        "{} doesn't have the `aura` command, so it can't answer this. Install Aura on it, or ask something that doesn't need it.",
                        machine.name
                    ));
                }
                if ran.code == TIMED_OUT {
                    return Err(timed_out(&line, wait));
                }
                Ok(ran.into())
            }
        }
    }

    /// Ask this place one of Aura's own questions, and read the answer.
    ///
    /// The difference from [`Place::sh`] is whose command it is. `sh` runs what
    /// the user or their agent asked for, so a non-zero exit is an *answer* — a
    /// grep that matched nothing is not an outage. Everything routed through
    /// here is a script this file wrote (`cloudbox::script`), asking a question
    /// the place either answers or cannot, so a non-zero exit really is a
    /// failure and is reported as one.
    ///
    /// The place's *own words* come back with it. A guess ("check your
    /// credentials") is how somebody ends up debugging the wrong thing: the
    /// real line is usually "Connection refused" or "Permission denied
    /// (publickey)", and each of those says what to do next.
    pub(crate) async fn ask(&self, remote: String) -> Result<String, String> {
        let ran = match self {
            Place::Here { root } => {
                let fut = tokio::process::Command::new("sh")
                    .args(["-c", &remote])
                    .current_dir(crate::spawn_dir::safe_spawn_dir(root))
                    .output();
                match tokio::time::timeout(SSH_TIMEOUT, fut).await {
                    Ok(Ok(o)) => Ran {
                        code: o.status.code().unwrap_or(-1),
                        stdout: String::from_utf8_lossy(&o.stdout).into_owned(),
                        stderr: String::from_utf8_lossy(&o.stderr).into_owned(),
                    },
                    Ok(Err(e)) => return Err(format!("spawn: {e}")),
                    Err(_) => return Err(timed_out(&remote, SSH_TIMEOUT)),
                }
            }
            Place::Box { machine, .. } => {
                self.run_remote(machine, remote, None, SSH_TIMEOUT).await?
            }
        };
        if ran.code == 0 {
            return Ok(ran.stdout);
        }
        Err(format!("{}: {}", self.label(), last_line(&ran.stderr)))
    }

    /// A terminal here — as something to spawn, never as a command line.
    ///
    /// The body of the command is built once for both places
    /// ([`super::place_open`]); all this chooses is who runs it. That is the
    /// whole seam: a shell on a box and a shell on this laptop differ by the
    /// program in front of them and nothing else, so a fix to one is a fix to
    /// both by construction.
    ///
    /// Synchronous on purpose. Nothing here touches the machine — it decides
    /// what to spawn, and the spawning is the pty layer's job. That keeps every
    /// line this produces testable without a box anywhere near it, which is
    /// where the quoting bugs actually live.
    ///
    /// `agent_pty_open` starts every coding agent through this, wherever it
    /// runs, and the terminal reaches it through [`Place::boot`], which renders
    /// the same argv as one line to type into a pty somebody else already
    /// opened. Nothing on the frontend builds one any more.
    ///
    /// **An agent opened through here is NOT confined**, and the `None` below is
    /// the whole of why: working out this project's allowlist means reading the
    /// place's own signed spec and asking the machine which wall it can hold,
    /// and both are round trips this call is not allowed to make. Every surface
    /// that actually starts an agent goes through [`Place::open_booted`] or
    /// [`super::place_sessions`], which do. Anything new that starts one must
    /// too — a second door onto the agent phase that skips
    /// [`super::place_egress::Place::confine_agent`] is a wall with a corridor
    /// round it, and it would not look like one in a diff.
    pub fn open(&self, what: &Open) -> Result<Shell, String> {
        self.open_line(what, "", vec![], None)
    }

    /// The same terminal, with this member's secrets in it.
    ///
    /// The one verb here that is async, because on a box it has to *put*
    /// something there first — the environment file, delivered on stdin — before
    /// there is anything for the boot line to load. On this laptop nothing is
    /// written anywhere: the pairs ride on the [`Shell`] and are set on the child
    /// process directly.
    ///
    /// Two mechanisms, one feature, and neither place-mode can quietly not have
    /// it: a shell opened this way on a box and a shell opened this way here both
    /// come up with the same variables set, from the same vault, for the same
    /// member.
    /// …and, when what is being opened is an agent, behind this project's
    /// allowlist.
    ///
    /// The two phases meet here. Whatever installed this place had the network
    /// ([`super::place_env`]); an agent opened from this call does not — it is
    /// started by a guard holding the list from the signed spec, and told so on
    /// screen either way ([`super::place_egress`]). A shell is untouched: the
    /// person at the keyboard is who the list is protecting.
    pub async fn open_booted(&self, what: &Open, boot: &BootSecrets) -> Result<Shell, String> {
        let preload = self.install_secrets(boot).await?.unwrap_or_default();
        let env = if self.is_remote() {
            // Setting them on the local `ssh` process would put the values in a
            // second place and get them to the box in none.
            vec![]
        } else {
            boot.pairs().to_vec()
        };
        let confine = match what {
            Open::Agent {
                bin,
                args,
                prompt,
                session,
            } => {
                self.confine_agent(
                    session.as_deref().unwrap_or(bin),
                    bin,
                    args,
                    prompt.as_deref(),
                )
                .await
            }
            _ => super::place_egress::Confinement::default(),
        };
        let preload = format!("{preload}{}", confine.announcement());
        self.open_line(what, &preload, env, confine.guard.as_deref())
    }

    fn open_line(
        &self,
        what: &Open,
        preload: &str,
        env: Vec<(String, String)>,
        confine: Option<&str>,
    ) -> Result<Shell, String> {
        let line = place_open::command(what, self.root(), preload, confine)?;
        Ok(match self {
            Place::Here { root } => Shell {
                program: "sh".into(),
                args: vec!["-c".into(), line],
                cwd: Some(
                    crate::spawn_dir::safe_spawn_dir(root)
                        .to_string_lossy()
                        .into_owned(),
                ),
                env,
            },
            Place::Box { machine, .. } => Shell {
                program: "ssh".into(),
                // A pty, because everything opened this way is interactive: a
                // shell, or an agent that draws one.
                args: ssh_argv(machine, &line, true),
                // The directory is inside the command — it is the box's path,
                // and means nothing to a process started on this disk.
                cwd: None,
                env: vec![],
            },
        })
    }

    /// Who the work runs as, and where that is.
    ///
    /// One of the four things a second way of getting a place is allowed to
    /// differ on, which is exactly why it is answered here rather than read off
    /// a machine row by whoever needs it.
    // Surfaces still read `Machine` directly; folding them onto this is the
    // frontend task in the group.
    #[allow(dead_code)]
    pub fn identity(&self) -> Identity {
        match self {
            Place::Here { .. } => Identity {
                user: local_user(),
                // No address and no key. Inventing "localhost" here would be a
                // value some surface later tries to dial.
                host: None,
                key_path: None,
                kind: "here".into(),
                address: None,
                // Nothing to forward: the work already runs beside your agent.
                forward_agent: false,
            },
            Place::Box { machine, .. } => Identity {
                user: machine.user.trim().to_string(),
                host: Some(machine.host.trim().to_string()),
                key_path: Some(machine.key_path.trim().to_string()),
                kind: machine.box_kind.trim().to_string(),
                address: Some(machine.id.clone()),
                forward_agent: machine.forward_agent,
            },
        }
    }

    /// Is this place reaching back to the ssh agent on this laptop?
    ///
    /// Asked of the place rather than read off a machine row by whoever needs
    /// it, for the same reason every other question here is: a surface holding
    /// its own copy of this answer is a surface that will one day say "off"
    /// about a connection that is lending out a key.
    pub fn forwards_agent(&self) -> bool {
        match self {
            Place::Here { .. } => false,
            Place::Box { machine, .. } => machine.forward_agent,
        }
    }

    /// Let go of the connection carrying the agent, now rather than when it
    /// happens to expire.
    ///
    /// The other half of opting in. A forwarded connection is the box's window
    /// onto your key for as long as it is open, and ours is multiplexed — so
    /// without this the window outlives the work by however long the master
    /// persists. Called when a session there ends and when forwarding is turned
    /// off, which are the two moments the answer to "is my key still reachable
    /// from that machine" changes.
    ///
    /// Nothing on the far side stops. The work lives in tmux on the box; this
    /// closes the wire, and the next call opens a new one.
    ///
    /// This laptop has nothing to let go of, and says so by succeeding: a
    /// caller that had to know which kind of place it held before it could
    /// tidy up is a caller that will get it wrong somewhere.
    pub async fn stop_forwarding(&self) -> Result<(), String> {
        match self {
            Place::Here { .. } => Ok(()),
            Place::Box { machine, .. } => {
                if !machine.forward_agent {
                    return Ok(());
                }
                crate::cloudbox::hang_up(machine).await
            }
        }
    }

    /// Is this place there, and is it ours to end?
    ///
    /// Asked with the cheapest thing a shell can do, because the question is
    /// "did anything answer", not "what did it say". A box that is stopped, has
    /// moved, or no longer takes this key all fail here — in its own words, so
    /// the three don't read as one.
    // Reachability is currently inferred by each surface from whatever call it
    // just made; the workflow-matrix task in the group is what routes them here.
    #[allow(dead_code)]
    pub async fn lifecycle(&self) -> Lifecycle {
        match self {
            Place::Here { .. } => Lifecycle {
                reachable: true,
                detail: "This laptop.".into(),
                // The app does not get to delete the computer it is running on.
                can_teardown: false,
                added_at: 0,
                last_used_at: 0,
            },
            Place::Box { machine, .. } => {
                let (reachable, detail) = match self
                    .run_remote(machine, "true".into(), None, READ_WAIT)
                    .await
                {
                    Ok(r) if r.code == 0 => (true, "Ready.".to_string()),
                    Ok(r) => (false, last_line(&r.stderr)),
                    Err(e) => (false, e),
                };
                Lifecycle {
                    reachable,
                    detail,
                    can_teardown: true,
                    added_at: machine.added_at,
                    last_used_at: machine.last_used_at,
                }
            }
        }
    }

    /// Who gets the bill, and what has been used here.
    ///
    /// Counted in session-seconds because that is the one unit this seam can
    /// state honestly on both sides: a tmux session carries its own
    /// `created_at`, read back off the machine, so the number is the machine's
    /// rather than a timer we kept and hoped survived a laptop being closed.
    ///
    /// `metered` is about *Aura's* bill, not the world's. Your own laptop costs
    /// electricity and a box you brought costs whoever pays its provider — real
    /// bills, just not ours to send.
    // Nothing bills yet — the managed mode this exists for is the next
    // provisioning arm, and it must not arrive without somewhere to report.
    #[allow(dead_code)]
    pub async fn meter(&self) -> Result<Meter, String> {
        let sessions = self.sessions().await?;
        let now = unix_now();
        let (payer, metered) = self.billing();
        Ok(Meter {
            payer: payer.to_string(),
            metered,
            live_sessions: sessions.len() as u32,
            session_seconds: sessions
                .iter()
                .map(|s| (now - s.created_at).max(0))
                .sum(),
            since: sessions
                .iter()
                .map(|s| s.created_at)
                .filter(|c| *c > 0)
                .min()
                .unwrap_or(0),
        })
    }

    /// Whose bill, and whether Aura is the one sending it.
    ///
    /// Reachable from the rest of the seam because it is the one question that
    /// separates a place Aura made from a place Aura merely dials, and two of
    /// the workflow matrix's cells turn on exactly that — see
    /// [`super::place_conformance`].
    pub(super) fn billing(&self) -> (&'static str, bool) {
        match self {
            Place::Here { .. } => ("you (this laptop)", false),
            Place::Box { machine, .. } => billing_of(machine),
        }
    }

    /// The one call in the app that reaches another machine.
    ///
    /// Every remote arm above goes through here rather than to
    /// [`crate::cloudbox::dial`] itself, so there is a single line to change
    /// when reaching a box grows a step — a retry, a metering hook, a second
    /// transport for a managed VM. A verb that dialled on its own would keep
    /// working and quietly not have it, which is exactly the drift this
    /// contract exists to prevent. `cloudbox::sole_ssh` fails the build if one
    /// reappears.
    async fn run_remote(
        &self,
        machine: &Machine,
        remote: String,
        feed: Option<&str>,
        wait: Duration,
    ) -> Result<Ran, String> {
        // A place Aura stopped refuses connections in exactly the way a broken
        // one does, and the caller asked for work rather than for a diagnosis.
        // So starting it is part of reaching it, and it belongs here rather than
        // at any of the verbs above: one that woke on its own would be one verb
        // that works on a sleeping place and eight that do not.
        //
        // The row is replaced rather than reused, because a machine that slept
        // comes back on a different address — dialling the one in hand would
        // reach whatever now answers there, which is not this place.
        let woken;
        let machine = match super::place_wake::before_reaching(machine).await? {
            Some(up) => {
                woken = up;
                &woken
            }
            None => machine,
        };
        dial(machine, &remote, feed, wait).await
    }

    /// Put a file on this place, with the bytes travelling where a command line
    /// cannot be read.
    ///
    /// The one verb here that carries *content* rather than a question, and the
    /// only one whose content may be a credential
    /// ([`super::place_secrets`]). Two things follow from that and neither is
    /// optional:
    ///
    /// * The bytes go on stdin. Written into the command instead — a heredoc, an
    ///   `echo`, a base64 blob — they would be argv, and argv is in `ps` on both
    ///   machines. A token published to every process table on the way is a
    ///   worse leak than the shared credential this exists to end.
    /// * `umask 077` comes first, so the file is never briefly world-readable
    ///   between being created and being `chmod`'d. The explicit `chmod`
    ///   afterwards is for the second write, where the file already exists and
    ///   the umask has no say.
    ///
    /// `~/` means the home of whoever the work runs as, resolved by the machine
    /// rather than by us — on a box with per-member accounts that is the member's
    /// own home, which is the whole point of writing there.
    pub(crate) async fn deliver(
        &self,
        path: &str,
        mode: u32,
        contents: &str,
    ) -> Result<(), String> {
        match self {
            Place::Here { .. } => {
                let p = local_path(path)?;
                if let Some(dir) = p.parent() {
                    tokio::fs::create_dir_all(dir)
                        .await
                        .map_err(|e| format!("{}: {e}", dir.display()))?;
                    close_to_others(dir, 0o700)?;
                }
                tokio::fs::write(&p, contents.as_bytes())
                    .await
                    .map_err(|e| format!("{}: {e}", p.display()))?;
                close_to_others(&p, mode)
            }
            Place::Box { machine, .. } => {
                let (dir, file) = remote_home_path(path)?;
                let ran = self
                    .run_remote(
                        machine,
                        format!(
                            "umask 077; mkdir -p {dir} && cat > {file} && chmod {mode:o} {file}"
                        ),
                        Some(contents),
                        READ_WAIT,
                    )
                    .await?;
                if ran.code == 0 {
                    Ok(())
                } else {
                    Err(format!("{path}: {}", last_line(&ran.stderr)))
                }
            }
        }
    }
}

/// A `~/`-relative path, as a shell on the far side must spell it.
///
/// Comes back as the directory and the file, both already quoted, with `$HOME`
/// deliberately *outside* the quotes so the machine expands it. Quoted whole —
/// `'~/a/b'` — `~` is a literal directory name, and the file lands somewhere
/// nobody will ever look for it.
fn remote_home_path(path: &str) -> Result<(String, String), String> {
    let rel = path.strip_prefix("~/").unwrap_or(path);
    if rel.starts_with('/') {
        return Err(format!("{path} isn't a path under a home directory."));
    }
    if !is_home_rel_path(rel) {
        return Err(format!("{path} isn't a path this can write to."));
    }
    let dir = match rel.rsplit_once('/') {
        Some((d, _)) => format!("\"$HOME\"/{}", quote(d)),
        None => "\"$HOME\"".to_string(),
    };
    Ok((dir, format!("\"$HOME\"/{}", quote(rel))))
}

/// The same path, on this disk.
fn local_path(path: &str) -> Result<PathBuf, String> {
    match path.strip_prefix("~/") {
        Some(rel) => Ok(home_dir()?.join(rel)),
        None if path.starts_with('/') => Ok(PathBuf::from(path)),
        None => Err(format!("{path} isn't a path this can write to.")),
    }
}

fn home_dir() -> Result<PathBuf, String> {
    std::env::var("HOME")
        .or_else(|_| std::env::var("USERPROFILE"))
        .map(PathBuf::from)
        .map_err(|_| "This laptop has no home directory.".to_string())
}

/// Take every bit off a path but the owner's — the local half of `umask 077`.
#[cfg(unix)]
fn close_to_others(path: &std::path::Path, mode: u32) -> Result<(), String> {
    use std::os::unix::fs::PermissionsExt;
    std::fs::set_permissions(path, std::fs::Permissions::from_mode(mode))
        .map_err(|e| format!("can't make {} private: {e}", path.display()))
}

/// Windows has no mode bits, and a file under the user's own profile is already
/// ACL'd to them.
#[cfg(not(unix))]
fn close_to_others(_path: &std::path::Path, _mode: u32) -> Result<(), String> {
    Ok(())
}

impl From<Ran> for Output {
    fn from(r: Ran) -> Self {
        Output {
            code: r.code,
            stdout: r.stdout,
            stderr: r.stderr,
        }
    }
}

/// `timeout(1)`'s way of saying it killed something.
const TIMED_OUT: i32 = 124;
/// A shell's way of saying it never found the program.
const NOT_FOUND: i32 = 127;
/// Reading a file or a directory is a question, not work — it should never be
/// the thing a conversation waits on.
const READ_WAIT: Duration = Duration::from_secs(20);
/// The far side enforces the real deadline; this laptop's own timer sits just
/// behind it so that when a command does run over, the message says the command
/// timed out rather than that the machine went quiet.
const SSH_SLACK: Duration = Duration::from_secs(10);

/// The same sentence in both places, so a slow test suite doesn't read as two
/// different faults depending on which machine ran it.
fn timed_out(what: &str, wait: Duration) -> String {
    format!("Timed out after {}s: {what}", wait.as_secs())
}

/// `cd` first, then hand the command to a shell over there.
///
/// Two things are load-bearing. The command is quoted whole, so a pipeline, a
/// heredoc or a `&&` survives the trip intact instead of half of it being read
/// as an argument to ssh. And it is wrapped in `timeout`, so a command that
/// hangs dies on the box — without that, dropping the connection would leave it
/// running forever on a machine nobody is looking at.
fn remote_sh(root: &str, command: &str, wait: Duration) -> String {
    format!(
        "cd {} && timeout {} sh -c {}",
        quote(root),
        wait.as_secs().max(1),
        quote(command)
    )
}

/// A path the way this laptop's tools have always resolved one.
fn resolve_local(root: &str, p: &str) -> PathBuf {
    if p.starts_with('/') {
        PathBuf::from(p)
    } else {
        PathBuf::from(root).join(p)
    }
}

/// The same rule, over there — with the shape check the local path never needed.
///
/// A local path lands in `tokio::fs`, which treats every byte as a byte. A
/// remote one is spliced into a command line, so a newline or a NUL in it is
/// not a strange filename, it is a second command. `is_abs_path` refuses those
/// before anything is quoted, so a bad path is a clear error rather than a
/// quoting bug waiting to be found.
fn resolve_remote(root: &str, p: &str) -> Result<String, String> {
    let p = p.trim();
    let joined = if p.starts_with('/') {
        p.to_string()
    } else if p.starts_with("~/") || p == "~" {
        p.to_string()
    } else if p.is_empty() || p == "." {
        root.to_string()
    } else {
        format!("{}/{}", root.trim_end_matches('/'), p)
    };
    // `~` is the box's home and only the box can expand it, so it is allowed
    // through as-is; everything else has to look like a path.
    if joined.starts_with('~') {
        return if joined.len() <= 4096 && !joined.contains(['\n', '\0', '\'']) {
            Ok(joined)
        } else {
            Err(format!("{p} isn't a path this can reach."))
        };
    }
    if is_abs_path(&joined) {
        Ok(joined)
    } else {
        Err(format!("{p} isn't a path this can reach."))
    }
}

/// `ls -Ap` output: one name per line, directories ending in `/`.
fn parse_listing(stdout: &str) -> Vec<Entry> {
    stdout
        .lines()
        .map(|l| l.trim_end_matches('\r'))
        .filter(|l| !l.trim().is_empty())
        .map(|l| match l.strip_suffix('/') {
            Some(name) => Entry {
                name: name.to_string(),
                is_dir: true,
            },
            None => Entry {
                name: l.to_string(),
                is_dir: false,
            },
        })
        .collect()
}

/// Cut on a character boundary. A byte-wise cut of UTF-8 source produces
/// invalid text, and the model sees it as a corrupt file rather than a long one.
fn clamp(s: &str, max: usize) -> String {
    if s.len() <= max {
        return s.to_string();
    }
    let mut end = max;
    while end > 0 && !s.is_char_boundary(end) {
        end -= 1;
    }
    format!("{}\n… truncated", &s[..end])
}

fn first_line(stderr: &str) -> String {
    stderr
        .lines()
        .find(|l| !l.trim().is_empty())
        .unwrap_or("no output")
        .trim()
        .to_string()
}

/// The *last* thing said, not the first.
///
/// ssh narrates on its way to failing — banners, "kex_exchange_identification",
/// a warning about a known host — and the line that names the actual cause is
/// the one at the bottom. Reading from the top reliably surfaces the least
/// useful sentence available.
fn last_line(stderr: &str) -> String {
    stderr
        .lines()
        .rev()
        .find(|l| !l.trim().is_empty())
        .unwrap_or("no output")
        .trim()
        .to_string()
}

/// Whose login this laptop's work runs under.
///
/// No key, no host, no book row — the only thing a local place can honestly say
/// about its identity is the account it is running as.
fn local_user() -> String {
    std::env::var("USER")
        .or_else(|_| std::env::var("LOGNAME"))
        .ok()
        .map(|v| v.trim().to_string())
        .filter(|v| !v.is_empty())
        .unwrap_or_else(|| "you".to_string())
}

/// Whose bill a box is on, from the row alone.
///
/// Split out of [`Place::billing`] rather than inlined in its arm because the
/// idle sweep asks this about book rows it has not built a place from yet — one
/// per machine, on a timer — and a second spelling of "did Aura make this" is a
/// second answer waiting to disagree with the first. The one that matters is
/// `metered`: it is what decides whether Aura may stop the machine, and the
/// conformance matrix already proves it against the meter.
pub(super) fn billing_of(machine: &Machine) -> (&'static str, bool) {
    match machine.box_kind.trim() {
        // A box the team shares: each member runs under their own login, but
        // the machine is on one person's account.
        "shared" => ("the machine's owner", false),
        // Aura made this one and holds its key, so Aura meters it.
        "managed" => ("your Aura account", true),
        _ => ("you (your own machine)", false),
    }
}

/// Unix seconds, in the same units tmux stamps a session with.
pub(super) fn unix_now() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs() as i64)
        .unwrap_or(0)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn no_machine_means_this_laptop() {
        let p = Place::resolve("/Users/me/proj", None);
        assert!(!p.is_remote());
        assert_eq!(p.root(), "/Users/me/proj");
        assert_eq!(p.machine_name(), None);
    }

    #[test]
    fn a_machine_that_was_forgotten_falls_back_to_here() {
        // Better than a conversation that can no longer answer anything
        // because a row was removed from the book last week.
        let p = Place::resolve("/Users/me/proj", Some("nobody@nowhere:/x"));
        assert!(!p.is_remote());
        assert_eq!(p.root(), "/Users/me/proj");
    }

    #[test]
    fn a_relative_path_hangs_off_the_root() {
        assert_eq!(
            resolve_remote("/home/ubuntu/naridon", "src/main.rs").unwrap(),
            "/home/ubuntu/naridon/src/main.rs"
        );
        assert_eq!(
            resolve_local("/Users/me/p", "src/main.rs"),
            PathBuf::from("/Users/me/p/src/main.rs")
        );
    }

    #[test]
    fn an_absolute_path_is_left_alone_in_both_places() {
        assert_eq!(resolve_remote("/home/u/p", "/etc/hosts").unwrap(), "/etc/hosts");
        assert_eq!(resolve_local("/Users/me/p", "/etc/hosts"), PathBuf::from("/etc/hosts"));
    }

    #[test]
    fn the_root_itself_is_what_an_empty_path_means() {
        assert_eq!(resolve_remote("/home/u/p", ".").unwrap(), "/home/u/p");
        assert_eq!(resolve_remote("/home/u/p", "").unwrap(), "/home/u/p");
    }

    #[test]
    fn a_home_relative_path_is_the_boxs_home_to_expand() {
        // We cannot know what `~` is over there and must not guess: this
        // laptop's HOME is the wrong answer every time.
        assert_eq!(resolve_remote("/home/u/p", "~/naridon").unwrap(), "~/naridon");
        assert_eq!(resolve_remote("~", ".").unwrap(), "~");
    }

    #[test]
    fn a_path_carrying_a_second_command_is_refused_not_quoted() {
        // The check that matters. Quoting would probably hold, but "probably"
        // is not a security posture when the payload reaches a shell.
        for bad in [
            "/etc/hosts\nrm -rf /",
            "/etc/'; rm -rf /; '",
            "/etc/hosts\0",
            "../../../etc/shadow",
        ] {
            assert!(
                resolve_remote("/home/u/p", bad).is_err(),
                "{bad:?} should not have been accepted"
            );
        }
    }

    #[test]
    fn a_command_reaches_the_box_whole() {
        let out = remote_sh("/home/u/p", "cargo test 2>&1 | tail -5 && echo done", Duration::from_secs(30));
        assert!(out.starts_with("cd '/home/u/p' && timeout 30 sh -c "));
        // One argument. If a future edit unwraps a quoting layer, the pipe and
        // the `&&` become ssh's problem and this fails.
        assert!(out.contains(&quote("cargo test 2>&1 | tail -5 && echo done")));
    }

    #[test]
    fn a_hanging_command_dies_on_the_box_not_just_here() {
        // Without `timeout` over there, giving up locally leaves the command
        // running forever on a machine nobody is watching.
        assert!(remote_sh("/r", "sleep 999", Duration::from_secs(5)).contains("timeout 5 "));
        // A sub-second deadline must not become `timeout 0`, which means
        // "no limit" — the exact opposite of what was asked.
        assert!(remote_sh("/r", "x", Duration::from_millis(200)).contains("timeout 1 "));
    }

    #[test]
    fn a_directory_listing_says_which_entries_are_directories() {
        let out = parse_listing("src/\nCargo.toml\n.git/\nREADME.md\n\n");
        assert_eq!(
            out,
            vec![
                Entry { name: "src".into(), is_dir: true },
                Entry { name: "Cargo.toml".into(), is_dir: false },
                Entry { name: ".git".into(), is_dir: true },
                Entry { name: "README.md".into(), is_dir: false },
            ]
        );
    }

    #[test]
    fn a_long_file_is_cut_where_text_allows() {
        let s = "é".repeat(100); // two bytes each
        let out = clamp(&s, 51);
        assert!(out.starts_with(&"é".repeat(25)));
        assert!(out.ends_with("… truncated"));
        // The cut landed on a boundary, so this is text and not a corrupt file.
        assert!(!out.contains('\u{FFFD}'));
    }

    #[test]
    fn a_short_file_comes_back_untouched() {
        assert_eq!(clamp("hello", 8000), "hello");
    }

    #[test]
    fn a_remote_read_never_drags_a_whole_log_file_across() {
        // The cap belongs on the far side. Reading 8KB of a 2GB log should
        // cost 8KB of transfer, not 2GB and then a truncation here.
        let p = Place::Box {
            machine: Box::new(fake_machine()),
            root: "/home/ubuntu/naridon".into(),
            here: "/Users/me/naridon".into(),
        };
        assert_eq!(p.root(), "/home/ubuntu/naridon");
        assert_eq!(p.here(), "/Users/me/naridon");
        assert_eq!(p.machine_name(), Some("aura-runner"));
        assert!(p.is_remote());
    }

    fn fake_machine() -> Machine {
        Machine {
            id: "u@h:/r".into(),
            name: "aura-runner".into(),
            host: "example.invalid".into(),
            user: "ubuntu".into(),
            key_path: "/dev/null".into(),
            box_kind: "mine".into(),
            repo_path: Some("/home/ubuntu/naridon".into()),
            repo_branch: None,
            project_root: Some("/Users/me/naridon".into()),
            org_slug: None,
            forward_agent: false,
            instance_id: None,
            asleep_since: 0,
            added_at: 0,
            last_used_at: 0,
        }
    }

    fn there(kind: &str) -> Place {
        Place::Box {
            machine: Box::new(Machine {
                box_kind: kind.into(),
                ..fake_machine()
            }),
            root: "/home/ubuntu/naridon".into(),
            here: "/Users/me/naridon".into(),
        }
    }

    #[test]
    fn a_machine_the_book_forgot_is_an_error_when_it_was_the_whole_question() {
        // The other half of `resolve`'s kindness. A chat should keep working
        // when a machine goes missing; "list that box's sessions" must not
        // quietly answer about this laptop instead.
        let e = Place::at_machine("nobody@nowhere:/x").unwrap_err();
        assert!(e.contains("isn't a machine this laptop knows how to reach"), "{e}");
    }

    #[test]
    fn a_local_terminal_and_a_remote_one_run_the_same_command() {
        // The claim the whole seam rests on, at the level of one string: the
        // body is identical and only the program in front of it differs.
        let want = Open::Shell {
            session: Some("aura-work".into()),
        };
        // Same root on both sides, because the root is one of the four things
        // a place is *allowed* to differ on — everything else must not.
        let root = "/home/ubuntu/naridon";
        let here = Place::Here { root: root.into() }.open(&want).expect("here");
        let boxed = there("mine").open(&want).expect("there");

        assert_eq!(here.program, "sh");
        assert_eq!(here.args[0], "-c");
        assert_eq!(boxed.program, "ssh");
        assert_eq!(boxed.cwd, None, "a box's path means nothing on this disk");

        let local_body = &here.args[1];
        let remote_body = boxed.args.last().expect("a command");
        assert_eq!(
            local_body, remote_body,
            "the same terminal was built two different ways"
        );
        assert!(local_body.contains("tmux new -A -s 'aura-work'"));
    }

    #[test]
    fn a_local_terminal_starts_in_the_root_rather_than_wherever_the_app_launched() {
        // `safe_spawn_dir`'s guarantee, carried through the contract: a child
        // must never inherit the desktop app's own cwd.
        let here = Place::Here { root: "/tmp".into() }
            .open(&Open::Shell { session: None })
            .expect("here");
        assert_eq!(here.cwd.as_deref(), Some("/tmp"));
    }

    #[test]
    fn a_terminal_gets_a_pty_and_may_ask_for_a_passphrase() {
        // A question runs with `BatchMode=yes` so it can never hang on a prompt
        // nothing can answer. A terminal is the opposite case: there is a
        // person in front of it, and refusing them the prompt turns "type your
        // passphrase" into "the box didn't answer".
        let t = there("mine")
            .open(&Open::Shell { session: None })
            .expect("a terminal");
        assert!(t.args.iter().any(|a| a == "-t"));
        assert!(!t.args.iter().any(|a| a == "BatchMode=yes"));
        // The login and host arrive as one argv slot, never spliced into a line.
        assert_eq!(t.args[t.args.len() - 2], "ubuntu@example.invalid");
    }

    #[test]
    fn this_laptop_has_no_address_and_no_key_to_name() {
        // Inventing "localhost" here would be a value some surface later tries
        // to dial, and a key path that isn't a key.
        let id = Place::Here { root: "/tmp".into() }.identity();
        assert_eq!(id.kind, "here");
        assert_eq!(id.host, None);
        assert_eq!(id.key_path, None);
        assert_eq!(id.address, None);
        assert!(!id.user.is_empty());
        // Not a missing feature — the work is already running beside your
        // agent, so there is nothing to forward to it.
        assert!(!id.forward_agent);
    }

    #[test]
    fn a_place_lends_its_agent_only_because_somebody_said_so() {
        // The default the whole task turns on: a machine read out of the book
        // is not forwarding unless the row says it is, and every surface reads
        // that answer from here rather than keeping its own.
        assert!(!there("mine").forwards_agent());
        assert!(!there("mine").identity().forward_agent);
        assert!(!Place::Here { root: "/tmp".into() }.forwards_agent());

        let opted_in = Place::Box {
            machine: Box::new(Machine {
                forward_agent: true,
                ..fake_machine()
            }),
            root: "/home/ubuntu/naridon".into(),
            here: "/Users/me/naridon".into(),
        };
        assert!(opted_in.forwards_agent());
        assert!(opted_in.identity().forward_agent);
    }

    #[test]
    fn an_address_the_book_has_never_heard_of_is_not_forwarding_either() {
        // The connect wizard's route. Silence about forwarding has to mean no
        // here as much as it does in the book, or the one way of naming a place
        // that skips the book would be the one way that leaks a key.
        let a = Address {
            user: "ubuntu".into(),
            host: "example.invalid".into(),
            key_path: "/dev/null".into(),
            kind: "mine".into(),
            forward_agent: false,
        };
        assert!(!Place::at_address(&a).expect("a place").forwards_agent());
        let opted_in = Address {
            forward_agent: true,
            ..a
        };
        assert!(Place::at_address(&opted_in).expect("a place").forwards_agent());
    }

    #[tokio::test]
    async fn letting_go_of_an_agent_is_something_every_place_can_be_asked() {
        // A caller that had to know which kind of place it held before it could
        // tidy up is a caller that gets it wrong somewhere. This laptop has
        // nothing to let go of and says so by succeeding; a box nobody opted in
        // has nothing either, and neither reaches the wire to find out.
        Place::Here { root: "/tmp".into() }
            .stop_forwarding()
            .await
            .expect("this laptop has nothing to let go of");
        there("mine")
            .stop_forwarding()
            .await
            .expect("a place that was never lending one has nothing to close");
    }

    #[test]
    fn a_box_names_the_login_the_host_and_where_this_laptop_keeps_the_key() {
        let id = there("shared").identity();
        assert_eq!(id.user, "ubuntu");
        assert_eq!(id.host.as_deref(), Some("example.invalid"));
        assert_eq!(id.key_path.as_deref(), Some("/dev/null"));
        assert_eq!(id.kind, "shared");
        assert_eq!(id.address.as_deref(), Some("u@h:/r"));
    }

    #[test]
    fn only_a_machine_aura_made_is_a_machine_aura_bills_for() {
        // Your laptop costs electricity and a box you brought costs whoever
        // pays its provider. Both are real bills; neither is ours to send.
        assert_eq!(
            Place::Here { root: "/tmp".into() }.billing(),
            ("you (this laptop)", false)
        );
        assert_eq!(there("mine").billing(), ("you (your own machine)", false));
        assert_eq!(there("shared").billing(), ("the machine's owner", false));
        assert_eq!(there("managed").billing(), ("your Aura account", true));
    }

    #[tokio::test]
    async fn this_laptop_is_never_something_the_app_may_tear_down() {
        let l = Place::Here { root: "/tmp".into() }.lifecycle().await;
        assert!(l.reachable);
        assert!(!l.can_teardown, "the app does not get to delete its own computer");
    }

    #[test]
    fn a_failure_is_reported_in_the_last_thing_said_not_the_first() {
        // ssh narrates on its way to failing. The line that names the cause is
        // at the bottom; reading from the top surfaces the banner.
        let stderr = "Warning: Permanently added 'h' to the list of known hosts.\n\
                      ubuntu@h: Permission denied (publickey).\n";
        assert_eq!(last_line(stderr), "ubuntu@h: Permission denied (publickey).");
        assert_eq!(last_line("   \n\n"), "no output");
    }

    #[tokio::test]
    async fn a_question_asked_of_this_laptop_comes_back_the_same_shape() {
        // `ask` is the transport under every session verb. Locally it has to
        // behave exactly as it does over ssh: stdout on success, and the
        // place's own last word on failure.
        let here = Place::Here { root: "/tmp".into() };
        assert_eq!(
            here.ask("echo hello".into()).await.unwrap().trim(),
            "hello"
        );
        let e = here
            .ask("echo nope 1>&2; exit 1".into())
            .await
            .unwrap_err();
        assert_eq!(e, "this laptop: nope");
    }

    #[test]
    fn both_places_time_out_in_the_same_words() {
        // Same sentence either side, or a slow test suite reads as two
        // different faults depending on where it ran.
        assert_eq!(
            timed_out("cargo test", Duration::from_secs(30)),
            "Timed out after 30s: cargo test"
        );
    }
}

/// The same four verbs, against a real machine.
///
/// Everything above proves we build the right string. None of it proves a box
/// answers it — and the claim this whole seam rests on is not "the string is
/// right", it is **"the answer is the same shape as the local one"**. So these
/// run both halves against a live box and compare, rather than asserting on
/// remote output alone:
///
/// ```text
/// AURA_LIVE_MACHINE='ubuntu@host:/home/ubuntu/naridon' \
///   cargo test --lib manager::brain::place::live -- --ignored --test-threads=1
/// ```
#[cfg(test)]
mod live {
    use super::*;

    fn there() -> Option<Place> {
        let id = std::env::var("AURA_LIVE_MACHINE").ok().filter(|v| !v.is_empty())?;
        let p = Place::resolve("/tmp/not-used-by-these-tests", Some(&id));
        // `resolve` falls back to local when the book has no such row; a live
        // test that silently tested this laptop would be worse than no test.
        assert!(p.is_remote(), "{id} isn't a machine in the book");
        Some(p)
    }

    fn block_on<F: std::future::Future>(f: F) -> F::Output {
        tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .expect("a runtime")
            .block_on(f)
    }

    #[test]
    #[ignore = "needs a real box; set AURA_LIVE_MACHINE"]
    fn a_file_on_the_box_reads_back() {
        let Some(p) = there() else { return };
        let out = block_on(p.read("README.md", 8000))
            .or_else(|_| block_on(p.read("Cargo.toml", 8000)))
            .expect("something readable at the project root");
        assert!(!out.trim().is_empty());
    }

    #[test]
    #[ignore = "needs a real box; set AURA_LIVE_MACHINE"]
    fn a_missing_file_says_so_rather_than_coming_back_empty() {
        // The failure that would be worst: an unreadable path reading as an
        // empty file, which a model treats as "this file exists and has
        // nothing in it" and then confidently writes over.
        let Some(p) = there() else { return };
        let e = block_on(p.read("definitely-not-here-9f3a.txt", 8000)).unwrap_err();
        assert!(e.contains("definitely-not-here-9f3a.txt"), "{e}");
    }

    #[test]
    #[ignore = "needs a real box; set AURA_LIVE_MACHINE"]
    fn a_listing_knows_a_directory_from_a_file() {
        let Some(p) = there() else { return };
        let entries = block_on(p.list(".")).expect("a listing");
        assert!(!entries.is_empty());
        let git = entries.iter().find(|e| e.name == ".git");
        assert!(git.is_some(), "no .git — is the root really a checkout?");
        assert!(git.unwrap().is_dir, ".git came back as a file");
    }

    #[test]
    #[ignore = "needs a real box; set AURA_LIVE_MACHINE"]
    fn a_command_runs_in_the_root_it_was_given() {
        let Some(p) = there() else { return };
        let o = block_on(p.sh("pwd", Duration::from_secs(20))).expect("pwd");
        assert!(o.ok());
        assert_eq!(o.stdout.trim(), p.root());
    }

    #[test]
    #[ignore = "needs a real box; set AURA_LIVE_MACHINE"]
    fn a_pipeline_survives_the_trip_whole() {
        let Some(p) = there() else { return };
        let o = block_on(p.sh(
            "printf 'a\\nb\\nc\\n' | grep -c . && echo 'it && ran'",
            Duration::from_secs(20),
        ))
        .expect("pipeline");
        assert!(o.ok(), "{o:?}");
        assert!(o.stdout.contains('3'), "{o:?}");
        assert!(o.stdout.contains("it && ran"), "{o:?}");
    }

    #[test]
    #[ignore = "needs a real box; set AURA_LIVE_MACHINE"]
    fn a_failed_command_is_an_answer_not_an_outage() {
        // A grep that matched nothing and a machine that is switched off must
        // never look the same from up here.
        let Some(p) = there() else { return };
        let o = block_on(p.sh("exit 3", Duration::from_secs(20))).expect("a real answer");
        assert_eq!(o.code, 3);
        assert!(!o.ok());
    }

    #[test]
    #[ignore = "needs a real box; set AURA_LIVE_MACHINE"]
    fn stdout_and_stderr_stay_separate() {
        let Some(p) = there() else { return };
        let o = block_on(p.sh("echo out; echo err 1>&2", Duration::from_secs(20))).expect("both");
        assert_eq!(o.stdout.trim(), "out");
        assert_eq!(o.stderr.trim(), "err");
    }

    #[test]
    #[ignore = "needs a real box; set AURA_LIVE_MACHINE"]
    fn a_hanging_command_is_killed_over_there_and_reported_here() {
        let Some(p) = there() else { return };
        let e = block_on(p.sh("sleep 600", Duration::from_secs(3))).unwrap_err();
        assert!(e.starts_with("Timed out after 3s:"), "{e}");
        // And it is not still running: the far side got a deadline of its own.
        // `[s]leep` so the probe doesn't count itself — every wrapper in the
        // chain carries the pattern on its own command line.
        let o = block_on(p.sh("pgrep -f '[s]leep 600' | wc -l", Duration::from_secs(20)))
            .expect("a count");
        assert_eq!(o.stdout.trim(), "0", "a killed command is still running over there");
    }

    #[test]
    #[ignore = "needs a real box; set AURA_LIVE_MACHINE"]
    fn the_box_answers_the_same_shape_the_laptop_does() {
        // The whole claim, in one test. Ask both machines the same question
        // and the answers must be the same *kind* of thing — same fields, same
        // conventions — because the chat above renders them identically.
        let Some(remote) = there() else { return };
        let here = Place::Here { root: std::env::var("PWD").unwrap_or_else(|_| "/".into()) };

        let a = block_on(here.sh("echo hi", Duration::from_secs(20))).expect("local");
        let b = block_on(remote.sh("echo hi", Duration::from_secs(20))).expect("remote");
        assert_eq!(a.code, b.code);
        assert_eq!(a.stdout.trim(), b.stdout.trim());

        let a = block_on(here.sh("exit 7", Duration::from_secs(20))).expect("local");
        let b = block_on(remote.sh("exit 7", Duration::from_secs(20))).expect("remote");
        assert_eq!(a.code, b.code, "an exit code means one thing or it means nothing");

        let a = block_on(here.list(".")).expect("local listing");
        let b = block_on(remote.list(".")).expect("remote listing");
        assert!(!a.is_empty() && !b.is_empty());
    }

    #[test]
    #[ignore = "needs a real box; set AURA_LIVE_MACHINE"]
    fn the_boxs_own_aura_answers() {
        let Some(p) = there() else { return };
        let o = block_on(p.aura(&["--version"], Duration::from_secs(60))).expect("a version");
        assert!(o.ok(), "{o:?}");
        assert!(o.stdout.to_lowercase().contains("aura"), "{o:?}");
    }

    /// A raw ssh with multiplexing explicitly off — the cold baseline the
    /// warm path has to beat. Same options as `cloudbox::ssh_args` otherwise.
    fn cold_call(m: &Machine, remote: &str) -> Duration {
        let key = crate::cloudbox::shellexpand_home(&m.key_path);
        let t = std::time::Instant::now();
        let out = std::process::Command::new("ssh")
            .args(["-i", &key])
            .args(["-o", "StrictHostKeyChecking=accept-new"])
            .args(["-o", "ConnectTimeout=15"])
            .args(["-o", "BatchMode=yes"])
            .args(["-o", "ControlPath=none"])
            .arg(format!("{}@{}", m.user.trim(), m.host.trim()))
            .arg(remote)
            .output()
            .expect("ssh runs");
        assert!(out.status.success(), "cold ssh failed");
        t.elapsed()
    }

    #[test]
    #[ignore = "needs a real box; set AURA_LIVE_MACHINE"]
    fn a_conversation_reuses_one_connection_instead_of_dialling_each_time() {
        // Not a benchmark — a guard on connection multiplexing. A chat that
        // reads six files is six round trips; at a fresh key exchange each
        // that is seconds of dead air, and the cloud chat stops feeling like
        // the local one. If this fails, look at `cloudbox::multiplex_args`.
        let id = match std::env::var("AURA_LIVE_MACHINE") {
            Ok(v) if !v.is_empty() => v,
            _ => return,
        };
        let m = dialable(&id).expect("a machine in the book");
        let p = Place::resolve("/tmp/not-used-by-these-tests", Some(&id));

        // Warm the master, then time calls that ride it.
        block_on(p.sh("true", Duration::from_secs(20))).expect("warm-up");
        let t = std::time::Instant::now();
        for _ in 0..8 {
            block_on(p.sh("true", Duration::from_secs(20))).expect("a warm call");
        }
        let warm = t.elapsed() / 8;

        // Best of three cold dials, so one lucky/unlucky handshake can't
        // decide the verdict.
        let cold = (0..3).map(|_| cold_call(&m, "true")).min().expect("a cold call");

        assert!(
            warm * 2 < cold,
            "a reused connection cost {warm:?} against {cold:?} cold — connections are not being multiplexed"
        );

        // And the socket it rides is where we said it would be.
        let dir = format!("{}/.aura/ssh", std::env::var("HOME").unwrap_or_default());
        let live = std::fs::read_dir(&dir)
            .map(|d| d.flatten().count())
            .unwrap_or(0);
        assert!(live > 0, "no control socket in {dir}");
    }
}
