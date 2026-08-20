//! What a place can be asked, expressed as values rather than as two APIs.
//!
//! `Place` began as four verbs — read, list, run a command, run `aura` — because
//! that was all a chat's tools needed. Everything *else* about a machine grew up
//! somewhere else: the terminal builds its own ssh lines, the picker asks its own
//! question about which agents are installed, the session list is a set of
//! `box_*` commands, and whether a box is reachable is answered wherever someone
//! last needed to know.
//!
//! That is how a second way of getting a machine drifts from the first. Each of
//! those surfaces reaches for a machine in its own words, so a capability added
//! to one is simply absent from the other, and nobody finds out until a user
//! does. The fix is not discipline, it is arity: give the seam every question a
//! surface actually asks, and there is nowhere else to ask it.
//!
//! So these are the answers, as plain data:
//!
//! | Question | Type |
//! |---|---|
//! | How do I get a terminal here? | [`Open`] → [`Shell`] |
//! | What can this place run? | [`Capabilities`] |
//! | Who is the work running as? | [`Identity`] |
//! | Is this place there, and can it be torn down? | [`Lifecycle`] |
//! | Who gets the bill, and for what? | [`Meter`] |
//!
//! Sessions get no type of their own: a session on a box and a session on this
//! laptop are the same tmux session, so they keep [`crate::cloudbox::domain`]'s
//! `BoxSession` rather than gaining a parallel spelling of it.
//!
//! Everything here is `Serialize` because the same contract has to reach the
//! frontend eventually, and a type the UI has to restate is a type that can
//! disagree with this one.

use serde::{Deserialize, Serialize};

use crate::cloudbox::script::word;

/// A terminal, as something to spawn — never as a command line.
///
/// `program` plus `args` rather than one string is the whole safety of this
/// type. A remote shell needs a key path, a login and a host in it, and at
/// least one of those comes from a file a person can hand-edit; assembled into
/// a line and handed to a shell, a space in a key path splits an argument and a
/// backtick runs a command. Passed as argv, they are only ever what they are.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Shell {
    pub program: String,
    pub args: Vec<String>,
    /// Where to start it. `None` for a remote shell — the directory is the
    /// box's business, and it is already inside the command.
    pub cwd: Option<String>,
    /// What to put into the process's environment before it starts.
    ///
    /// Always empty for a remote shell, and that asymmetry is the point: the
    /// only thing this ever carries is a member's brokered secrets
    /// ([`super::place_secrets`]), and setting those on the local `ssh` process
    /// would achieve nothing except making a copy of them somewhere new. A box
    /// loads its own, from a file in the member's own home, inside the command.
    ///
    /// `serde(skip)` — the one field on this contract that does not travel.
    /// Everything else here is `Serialize` so a surface can be handed a terminal
    /// to open; these pairs are values, and a value that reached a renderer
    /// would be a value in a devtools panel, a screenshot and a bug report. They
    /// are spent on a `CommandBuilder` in this process and go no further.
    #[serde(skip)]
    pub env: Vec<(String, String)>,
}

impl Shell {
    /// The same terminal, as one line to type into a pty that is already open.
    ///
    /// A pty is not always ours to spawn. The workspace's terminals and the
    /// connect wizard's both start as a shell on this laptop — the user's own
    /// zsh, with their prompt and their profile — and the only way into one is
    /// to type. So there has to be a line, and the only question is who writes
    /// it.
    ///
    /// It used to be the frontend, in TypeScript, from three fields off a
    /// machine row: `remoteShell.ts::sshLine`. That is a second transport with
    /// none of what this one has — no multiplexed connection, no `BatchMode`
    /// distinction, its own copy of the quoting — and, being reached by a
    /// different route, it is exactly where a second way of *getting* a machine
    /// silently ends up with fewer features than the first.
    ///
    /// So the argv above stays the truth, and the line is *derived* from it,
    /// here, once. Nothing assembles one from parts. [`word`] leaves the plain
    /// words alone so what appears on screen is the command a person would have
    /// typed, and quotes everything else exactly as the far side is quoted.
    pub fn line(&self) -> String {
        std::iter::once(&self.program)
            .chain(self.args.iter())
            .map(|a| word(a))
            .collect::<Vec<_>>()
            .join(" ")
    }
}

/// A place named by where it is, rather than by a row in the machine book.
///
/// One caller, and it is not an oversight: the connect wizard opens a terminal
/// on a box *before* the book has heard of it. That order is deliberate —
/// the shell answering is the proof the address works, so a mistyped host
/// leaves no row behind — and it means the wizard cannot name a machine id
/// because there isn't one yet.
///
/// Everything else about it is an ordinary place: the same command body, the
/// same transport, the same refusal of an address that isn't one.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Address {
    pub user: String,
    pub host: String,
    /// Where the private key lives ON THIS LAPTOP — a path, never key material.
    pub key_path: String,
    /// `mine`, `shared`, `managed`. Carried because it is one of the four
    /// things a place is allowed to differ on, and the wizard already knows it.
    pub kind: String,
    /// May this box use the ssh agent on this laptop while it is connected?
    ///
    /// Defaulted because the wizard has no reason to send it and every reason
    /// for its silence to mean no. It is here at all so the one route that
    /// reaches a place without a book row is not the one route that could never
    /// be opted in — a feature reachable by three ways of naming a place and
    /// absent from the fourth is the same drift this contract exists to stop.
    #[serde(default)]
    pub forward_agent: bool,
}

/// What to open here.
///
/// Three cases because there are three things a person does with a machine:
/// start a shell, start an agent, or sit down in front of something already
/// running. The third is the one that makes a box worth having — the work was
/// begun by yesterday's laptop, by the CLI, or by a teammate, and joining it is
/// not the same act as starting it.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "what", rename_all = "snake_case")]
pub enum Open {
    /// A login shell in the root.
    Shell {
        /// Hold it under this tmux name so it outlives the connection. `None`
        /// gives a plain shell that ends when the window does.
        session: Option<String>,
    },
    /// A coding-agent CLI in the root.
    Agent {
        bin: String,
        /// The flags the CLI is started with — `--model`, `--permission-mode`,
        /// `--resume`, whatever the provider built for this launch.
        ///
        /// Carried rather than folded into `bin` because they are argv, and the
        /// place is what decides whether argv stays argv (this laptop) or has to
        /// survive being written into a line for a shell on the other side of an
        /// ssh connection. An agent started on a box with its flags dropped is
        /// the worst kind of parity bug: it runs, it answers, and it is on the
        /// wrong model.
        args: Vec<String>,
        /// The first thing to say to it. `None` leaves it at its own prompt.
        prompt: Option<String>,
        session: Option<String>,
    },
    /// Join a session that is already running.
    Attach {
        session: String,
        /// Watch without taking the keyboard — how two people follow one agent
        /// without typing over each other.
        read_only: bool,
    },
}

/// What a place needs beyond an agent for any of this to work: somewhere to
/// clone from, something to hold a session, and — optionally — Aura itself.
///
/// Probed alongside the agents rather than in a call of its own, because it is
/// the same `command -v` loop and a round trip to a box across an ocean is the
/// expensive part, not the work.
///
/// It lives on the contract rather than beside the probe because two different
/// things need to agree about it and they are on opposite sides of the app. The
/// probe reads these off a machine; the provisioner has to PUT them on one it
/// just made. A second list in the provisioner would be a second opinion about
/// what a place is asked for, and the first tool added to one and not the other
/// is a machine Aura built that answers its own question with "no".
pub const TOOLS: [&str; 3] = ["git", "tmux", "aura"];

/// What this place can actually run.
///
/// The picker used to offer every agent this laptop had heard of and find out
/// which ones the box lacked one failed session at a time. A capability is a
/// property of the place, so it is read off the place.
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
pub struct Capabilities {
    /// The subset of the candidate binaries that are present, in the order
    /// asked.
    pub agents: Vec<String>,
    pub git: bool,
    /// Without tmux nothing here can outlive its connection: no durable
    /// sessions, no attaching, no coming back tomorrow.
    pub tmux: bool,
    /// A box is allowed to have never heard of Aura. This says whether it has.
    pub aura: bool,
}

/// Who the work runs as, and where that is.
///
/// Deliberately says *nothing* about this laptop's host or address. A local
/// place has no address to dial and no key to hold, and inventing a plausible
/// one ("localhost") would be a value some surface later tries to ssh to.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Identity {
    /// The login the work runs under.
    pub user: String,
    /// The host it runs on, when the place is somewhere you dial.
    pub host: Option<String>,
    /// Where the private key lives ON THIS LAPTOP — a path, never key
    /// material, and `None` when no key is involved.
    pub key_path: Option<String>,
    /// `here` for this laptop; otherwise the machine's own kind — `mine`,
    /// `shared`, `managed`.
    pub kind: String,
    /// The book's key for this place, for a surface that needs to name it back
    /// to the machine book.
    pub address: Option<String>,
    /// Is the work here reaching back to the ssh agent on this laptop?
    ///
    /// It belongs to identity rather than to capabilities because it is not a
    /// thing the place can *do* — it is a fact about *whose key* the work runs
    /// with. False for this laptop, and that is not a missing feature: the work
    /// is already running beside your agent, so there is nothing to forward.
    pub forward_agent: bool,
}

/// Whether the place is there, and whether it is ours to end.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Lifecycle {
    pub reachable: bool,
    /// Why not, when not — in the machine's own words rather than a guess.
    /// "Connection refused" and "Permission denied (publickey)" each say what
    /// to do next; "check your credentials" sends someone to the wrong file.
    pub detail: String,
    /// Can this place be torn down or detached? Never true for this laptop:
    /// the app does not get to delete the computer it is running on.
    pub can_teardown: bool,
    /// Unix seconds, from the machine book. Zero for a place that was never
    /// added to it.
    pub added_at: i64,
    pub last_used_at: i64,
}

/// Who gets the bill, and what has been used here.
///
/// The unit is session-seconds because that is the thing this seam can count
/// honestly on both sides: a tmux session's own `created_at` is read back off
/// the machine, so the number is the machine's, not a timer we kept and hoped
/// stayed true across a laptop being closed.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Meter {
    /// Whose bill this lands on, in words a person can act on.
    pub payer: String,
    /// Does Aura charge for time here? False for your own laptop and for a box
    /// you brought — those bills exist, they are just not ours to send.
    pub metered: bool,
    pub live_sessions: u32,
    /// Total seconds across every session running here right now.
    pub session_seconds: i64,
    /// Unix seconds of the oldest live session; zero when nothing is running.
    pub since: i64,
}
