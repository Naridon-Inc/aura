//! The shapes the importer hands the Settings → Import page.
//!
//! Everything here is metadata about another app's data — names, paths,
//! branches, counts and dates. No message text ever rides in a scan: a chat
//! is listed by its title and how many messages it holds, and its body is
//! only read when the person asks for it to be brought over.

use serde::{Deserialize, Serialize};

/// What kind of thing an [`Item`] is, which decides where it lands in Aura.
#[derive(Serialize, Deserialize, Clone, Copy, Debug, PartialEq, Eq, Hash)]
#[serde(rename_all = "lowercase")]
pub enum ItemKind {
    /// A repository → Aura's project list.
    Repo,
    /// A worktree the other app made → shown under its project with its name.
    Workspace,
    /// A conversation → an Aura chat in that project.
    Chat,
    /// Setup / run / archive scripts and review/PR/conflict prompts →
    /// the repo's `.aura/settings.toml`.
    Scripts,
    /// Rule files (`.cursorrules`, `.cursor/rules/*.mdc`, …) → AGENTS.md.
    Rules,
    /// An MCP server → `~/.aura/mcp/<name>.json`.
    Mcp,
}

/// Whether an item can still be brought over.
#[derive(Serialize, Deserialize, Clone, Copy, Debug, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum ItemState {
    /// Can be imported now.
    Ready,
    /// Already in Aura (an earlier import, or it was there anyway).
    Done,
    /// Can't be imported; `reason` says why.
    Unavailable,
}

/// One thing a source holds that maps onto Aura.
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Item {
    /// Stable within its source (`repo:<id>`, `chat:<id>`, `mcp:<name>`, …).
    /// The ledger and the run request both use it.
    pub key: String,
    pub kind: ItemKind,
    pub title: String,
    /// One short line under the title: a branch, a count, a path.
    pub detail: String,
    /// Last activity, epoch milliseconds, when the source records one.
    pub when: Option<i64>,
    pub state: ItemState,
    pub reason: Option<String>,
    /// The folder this item belongs to in Aura (the project or workspace it
    /// lands in). None for user-wide items such as an MCP server.
    pub root: Option<String>,
}

impl Item {
    pub fn new(key: impl Into<String>, kind: ItemKind, title: impl Into<String>) -> Self {
        Self {
            key: key.into(),
            kind,
            title: title.into(),
            detail: String::new(),
            when: None,
            state: ItemState::Ready,
            reason: None,
            root: None,
        }
    }

    pub fn detail(mut self, detail: impl Into<String>) -> Self {
        self.detail = detail.into();
        self
    }

    pub fn when(mut self, when: Option<i64>) -> Self {
        self.when = when;
        self
    }

    pub fn root(mut self, root: impl Into<String>) -> Self {
        self.root = Some(root.into());
        self
    }

    pub fn done(mut self, reason: impl Into<String>) -> Self {
        self.state = ItemState::Done;
        self.reason = Some(reason.into());
        self
    }

    pub fn unavailable(mut self, reason: impl Into<String>) -> Self {
        self.state = ItemState::Unavailable;
        self.reason = Some(reason.into());
        self
    }
}

/// A source as the page first sees it: cheap, no database opened.
#[derive(Serialize, Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct Detected {
    pub id: String,
    pub name: String,
    /// The app itself is on this Mac.
    pub installed: bool,
    /// Its data is on this Mac (the app may have been removed since).
    pub found: bool,
    /// How many of its items an earlier import already brought over.
    pub imported: usize,
}

/// Everything one source holds, as items.
#[derive(Serialize, Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct SourceScan {
    pub id: String,
    pub name: String,
    pub installed: bool,
    pub found: bool,
    pub items: Vec<Item>,
    /// Plain sentences about what this source holds that Aura can't bring
    /// over, and why — shown under the list so nothing is silently missing.
    pub notes: Vec<String>,
}

#[derive(Serialize, Deserialize, Clone, Copy, Debug, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum OutcomeStatus {
    Imported,
    Skipped,
    Failed,
}

/// What happened to one requested item.
#[derive(Serialize, Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct Outcome {
    pub key: String,
    pub kind: ItemKind,
    pub title: String,
    pub status: OutcomeStatus,
    pub reason: Option<String>,
    /// Where it landed: a session id, a path, a server name.
    pub aura_ref: Option<String>,
}

impl Outcome {
    pub fn imported(item: &Item, aura_ref: impl Into<String>, reason: Option<String>) -> Self {
        Self::of(item, OutcomeStatus::Imported, reason, Some(aura_ref.into()))
    }

    pub fn skipped(item: &Item, reason: impl Into<String>) -> Self {
        Self::of(item, OutcomeStatus::Skipped, Some(reason.into()), None)
    }

    pub fn failed(item: &Item, reason: impl Into<String>) -> Self {
        Self::of(item, OutcomeStatus::Failed, Some(reason.into()), None)
    }

    fn of(item: &Item, status: OutcomeStatus, reason: Option<String>, aura_ref: Option<String>) -> Self {
        Self {
            key: item.key.clone(),
            kind: item.kind,
            title: item.title.clone(),
            status,
            reason,
            aura_ref,
        }
    }
}

/// A folder the page should add to Aura's project list (or name, for a
/// worktree). The project list lives in the window, so the window applies it.
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Adopt {
    pub root: String,
    /// The name the other app showed for it, kept as the workspace name.
    pub name: Option<String>,
    pub pinned: bool,
    /// True for a repository (goes in the project list); false for a
    /// worktree of one (named and pinned only — it shows under its repo).
    pub project: bool,
}

#[derive(Serialize, Deserialize, Clone, Debug, Default)]
#[serde(rename_all = "camelCase")]
pub struct RunReport {
    pub outcomes: Vec<Outcome>,
    pub adopt: Vec<Adopt>,
}

/// One tick of a running import, sent to the page as `import:progress`.
#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct Progress {
    pub source: String,
    pub done: usize,
    pub total: usize,
    pub title: String,
}
