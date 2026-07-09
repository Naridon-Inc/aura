//! Data shapes for VS Code extension support. Kept free of I/O so the
//! command surface, the Open VSX client, the archive extractor, and the
//! install store can all share one vocabulary.

use serde::{Deserialize, Serialize};

/// How many of each declarative contribution kind an extension carries, plus
/// whether it ships runnable code (which Tier 0 never executes). Drives the
/// honest "3 themes · 1 language" summary the UI shows.
///
/// The fields fall into three honesty bands:
///   • **applied today** — `themes`/`languages`/`grammars`/`snippets`/
///     `icon_themes` (Tier 0) and `has_browser` (Tier 1) are things Aura wires
///     in right now.
///   • **detected but not yet runnable** — `is_language_server`, `views`,
///     `views_containers`, `custom_editors`, `webviews`, `debuggers` describe
///     the *other* VS Code extension kinds. We surface them so the UI can say
///     plainly "this adds a debugger, which Aura can't run yet" instead of
///     installing something that silently does nothing. Roadmap: Phases B–D.
///   • **host signal** — `has_main` (a Node `activate` entry) tells whether the
///     extension expects a Node host; combined with the kind flags it lets the
///     UI label "full program — not yet" vs "language support — coming soon".
///
/// New fields are `#[serde(default)]` so an older install index (written before
/// they existed) still deserialises — the missing kinds simply read as absent.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ContributesSummary {
    pub themes: usize,
    pub languages: usize,
    pub grammars: usize,
    pub snippets: usize,
    pub icon_themes: usize,
    pub commands: usize,
    /// Node entry (`main`) — a desktop-only extension wanting a Node host,
    /// which Tier 0 does not provide. Its declarative parts still apply.
    pub has_main: bool,
    /// Web entry (`browser`) — runnable in a Web-Worker host (Tier 1, later).
    pub has_browser: bool,

    // ── The other extension kinds — detected, honestly not-yet-runnable ──────
    /// Looks like a **language extension that needs a language server**: it has
    /// a Node `main` entry *and* declares languages or grammars. The `main`
    /// almost certainly spawns an LSP server we can't host yet (Phase B).
    #[serde(default)]
    pub is_language_server: bool,
    /// `contributes.views[]` entry count — tree/list views in a side panel.
    #[serde(default)]
    pub views: usize,
    /// `contributes.viewsContainers` (activity-bar / panel containers) present.
    #[serde(default)]
    pub views_containers: bool,
    /// `contributes.customEditors[]` count — custom document editors.
    #[serde(default)]
    pub custom_editors: usize,
    /// `contributes.webviews` present — webview panel contributions.
    #[serde(default)]
    pub webviews: bool,
    /// `contributes.debuggers[]` count — debug adapters (Phase: not yet).
    #[serde(default)]
    pub debuggers: usize,
}

/// One installed VS Code extension as Aura records it. Persisted in the
/// install index and returned to the frontend, which reads the referenced
/// asset files through `vsix_read_text` and applies them to Monaco.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct InstalledExtension {
    /// `<namespace>.<name>` — the canonical VS Code extension id.
    pub id: String,
    pub namespace: String,
    pub name: String,
    pub display_name: String,
    pub version: String,
    pub description: String,
    /// Absolute path to the extracted bundle root (which contains `extension/`).
    pub install_dir: String,
    /// When false, the contributes router skips this extension entirely.
    pub enabled: bool,
    pub contributes: ContributesSummary,
    /// Path (relative to the package root) to the extension's own icon, if any.
    pub icon: Option<String>,
    pub installed_at: u64,
}

/// A single Open VSX search hit — listing metadata only, never code. Open VSX
/// (Eclipse Foundation) is the only gallery a non-Microsoft product may use.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct OpenVsxHit {
    pub namespace: String,
    pub name: String,
    pub display_name: String,
    pub version: String,
    pub description: String,
    pub download_count: u64,
    pub average_rating: Option<f64>,
    pub icon_url: Option<String>,
    pub timestamp: Option<String>,
}
