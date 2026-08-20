//! What a box holds: projects to work in, and sessions doing the work.

use serde::{Deserialize, Serialize};

/// One live session on a box.
///
/// This is not a record we keep — it is read back off the machine every time,
/// because the machine is the only thing that knows. A session we believe in
/// that died an hour ago is worse than no list at all: you click it, a terminal
/// opens on nothing, and the app looks like it lied.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct BoxSession {
    /// The tmux session name. Also the handle for attaching and killing.
    pub name: String,
    /// Absolute path of the directory it works in — a project, or a worktree
    /// of one. Empty for a session started before any of this existed, which
    /// we still list rather than hide.
    pub project: String,
    /// `shell` | `agent` | `clone`. Unknown sessions read as `shell`, which is
    /// what they behave like when you attach.
    pub kind: String,
    /// Which CLI is running, when one is.
    pub agent: Option<String>,
    /// The branch it was given, when it was given its own.
    pub branch: Option<String>,
    /// What it's for, in the words of whoever started it.
    pub title: String,
    /// Unix seconds.
    pub created_at: i64,
    /// Unix seconds of the last activity tmux saw. How you tell a session that
    /// is thinking from one that has been sitting at a prompt since Tuesday.
    pub activity_at: i64,
    /// How many clients are looking at it right now. More than one means
    /// someone else is in here with you.
    pub attached: u32,
}

/// A project the box has a copy of.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct BoxProject {
    /// Absolute path on the box.
    pub path: String,
    /// The directory's own name — what to call it in a list.
    pub name: String,
    /// Where it came from, when it has a remote. A project with none can still
    /// be worked in; it just can't be pushed anywhere.
    pub remote: Option<String>,
    pub branch: Option<String>,
    /// How many files are modified or untracked. Non-zero means somebody left
    /// work here.
    pub dirty: u32,
}

/// What to start. The desktop fills this in; the box never invents one.
#[derive(Debug, Clone, Deserialize)]
pub struct NewSession {
    /// Absolute path of the project to work in.
    pub project: String,
    /// `shell` or `agent`.
    pub kind: String,
    /// The CLI to run, for an agent session. `claude`, `codex`, `gemini`, …
    pub agent: Option<String>,
    /// What this session is for. Shown in the list; also what the box records
    /// on the session itself.
    pub title: Option<String>,
    /// Give it its own branch, in its own worktree, so two sessions on one
    /// project can't edit the same files underneath each other.
    pub branch: Option<String>,
    /// The first thing to say to the agent. Absent leaves it at its own prompt.
    pub prompt: Option<String>,
}
