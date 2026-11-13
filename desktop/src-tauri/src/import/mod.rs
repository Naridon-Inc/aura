//! Bring work over from other agent apps.
//!
//! Someone switching to Aura has repos, worktrees, conversations, scripts,
//! rules and MCP servers sitting in the app they used before. Each source
//! module reads one app's files (read-only, see [`sqlite_ro`]) and lists what
//! it holds as [`model::Item`]s; this module lands the chosen ones in Aura and
//! records them in the [`ledger::Ledger`] so a second import adds nothing
//! twice.
//!
//! Three commands back the Settings → Import page:
//!
//! * `import_sources_detect` — which apps' data is on this Mac. Cheap: it
//!   only checks paths, so the promo card can ask on every launch.
//! * `import_source_scan` — everything one app holds, with counts, as items.
//! * `import_run` — import the chosen items, with `import:progress` ticks.

pub mod apply;
pub mod conductor;
pub mod cursor;
pub mod ledger;
pub mod model;
pub mod sqlite_ro;
pub mod superset;
pub mod void;
pub mod vscode_folders;
pub mod windsurf;
pub mod zed;

#[cfg(test)]
mod tests;

use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};

use tauri::{AppHandle, Emitter};

use crate::cmd_mcp_servers::DiscoveredMcp;
use apply::Scripts;
use ledger::Ledger;
use model::{Adopt, Detected, Item, ItemKind, ItemState, Outcome, Progress, RunReport, SourceScan};

/// How Aura brings one item over, worked out while scanning.
pub enum Plan {
    Repo { root: PathBuf },
    Workspace { path: PathBuf, name: Option<String>, pinned: bool, repo: PathBuf },
    Chat(ChatPlan),
    Scripts { root: PathBuf, scripts: Scripts },
    Rules { root: PathBuf },
    Mcp { entry: DiscoveredMcp },
}

/// Where a conversation's messages are, per source.
pub enum ChatPlan {
    Conductor(conductor::ChatRef),
    Cursor(cursor::ChatRef),
    Void(void::ChatRef),
    Zed(zed::ChatRef),
}

/// A source's items plus how to import each one.
pub struct Scanned {
    pub scan: SourceScan,
    pub plans: HashMap<String, Plan>,
}

impl Scanned {
    pub fn new(id: &str, name: &str, installed: bool, found: bool) -> Self {
        Self {
            scan: SourceScan {
                id: id.to_string(),
                name: name.to_string(),
                installed,
                found,
                items: Vec::new(),
                notes: Vec::new(),
            },
            plans: HashMap::new(),
        }
    }

    /// Add an item, unless one with the same key is already listed (two
    /// tables naming one repo, say).
    pub fn push(&mut self, item: Item, plan: Plan) {
        if self.plans.contains_key(&item.key) {
            return;
        }
        self.plans.insert(item.key.clone(), plan);
        self.scan.items.push(item);
    }

    pub fn note(&mut self, text: impl Into<String>) {
        self.scan.notes.push(text.into());
    }
}

/// What every scan needs to know about Aura's side.
pub struct Ctx {
    pub home: PathBuf,
    /// Folders already in Aura's project list, canonicalized.
    known: HashSet<PathBuf>,
    pub ledger: Ledger,
}

fn canon(p: &Path) -> PathBuf {
    std::fs::canonicalize(p).unwrap_or_else(|_| p.to_path_buf())
}

impl Ctx {
    pub fn new(home: PathBuf, known_roots: &[String], ledger: Ledger) -> Self {
        let known = known_roots.iter().map(|r| canon(Path::new(r))).collect();
        Self { home, known, ledger }
    }

    pub fn is_known(&self, p: &Path) -> bool {
        self.known.contains(&canon(p))
    }

    fn mark_known(&mut self, p: &Path) {
        self.known.insert(canon(p));
    }
}

pub fn path_str(p: &Path) -> String {
    p.to_string_lossy().into_owned()
}

fn folder_name(p: &Path) -> String {
    p.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_else(|| path_str(p))
}

/// `~/x/y` for display: shorter, and the same thing.
pub fn tilde(home: &Path, p: &Path) -> String {
    match p.strip_prefix(home) {
        Ok(rest) => format!("~/{}", rest.display()),
        Err(_) => path_str(p),
    }
}

/// A repository item. Only git repositories are offered: a project in Aura is
/// a repo, and its worktrees and history hang off git.
pub fn repo_item(ctx: &Ctx, key: String, path: &Path, name: Option<&str>, detail: String) -> Item {
    let title = name.map(str::to_string).filter(|n| !n.trim().is_empty()).unwrap_or_else(|| folder_name(path));
    let item = Item::new(key, ItemKind::Repo, title).detail(detail).root(path_str(path));
    if !path.is_dir() {
        item.unavailable(format!("{} isn't on this Mac any more", tilde(&ctx.home, path)))
    } else if !vscode_folders::is_git(path) {
        item.unavailable("Not a git repository")
    } else if ctx.is_known(path) {
        item.done("Already in Aura")
    } else {
        item
    }
}

/// A "rules" item for a repo that holds rule files AGENTS.md doesn't have yet.
pub fn rules_item(ctx: &Ctx, source: &str, root: &Path) -> Option<Item> {
    if !root.is_dir() {
        return None;
    }
    let files = apply::rule_files(root);
    if files.is_empty() {
        return None;
    }
    let key = format!("rules:{}", path_str(root));
    let detail = format!(
        "{} → AGENTS.md",
        if files.len() == 1 { files[0].clone() } else { format!("{} rule files", files.len()) }
    );
    let item = Item::new(key.clone(), ItemKind::Rules, format!("Rules in {}", folder_name(root)))
        .detail(detail)
        .root(path_str(root));
    Some(match ctx.ledger.done(source, &key) {
        Some(_) => item.done("Already in AGENTS.md"),
        None => item,
    })
}

/// MCP servers another app configured, found by the same discovery the MCP
/// settings page uses. `labels` are that discovery's source names
/// ("Cursor", "Cursor (project)", "Windsurf", "Zed"). Env values never leave
/// Rust: the item shows the command and how many variables it sets.
pub fn mcp_items(scanned: &mut Scanned, labels: &[&str], roots: &[PathBuf]) {
    let mut found: Vec<DiscoveredMcp> = Vec::new();
    let mut scopes: Vec<Option<String>> = vec![None];
    scopes.extend(roots.iter().filter(|r| r.is_dir()).map(|r| Some(path_str(r))));
    for scope in scopes {
        let is_project = scope.is_some();
        for entry in crate::cmd_mcp_servers::mcp_servers_discover_agents(scope).unwrap_or_default() {
            let wanted = labels.contains(&entry.source.as_str());
            let project_label = entry.source.ends_with("(project)");
            if wanted && project_label == is_project {
                found.push(entry);
            }
        }
    }
    for entry in found {
        let key = format!("mcp:{}:{}", entry.source, entry.name);
        let mut detail = if let Some(url) = &entry.server_url {
            url.clone()
        } else {
            std::iter::once(entry.command.as_str())
                .chain(entry.args.iter().map(String::as_str))
                .collect::<Vec<_>>()
                .join(" ")
        };
        if detail.chars().count() > 90 {
            detail = format!("{}…", detail.chars().take(89).collect::<String>());
        }
        if !entry.env.is_empty() {
            detail.push_str(&format!(
                " · {} env {}",
                entry.env.len(),
                if entry.env.len() == 1 { "variable" } else { "variables" }
            ));
        }
        let mut item = Item::new(key, ItemKind::Mcp, entry.name.clone()).detail(detail);
        if let Some(root) = &entry.source_root {
            item = item.root(root.clone());
        }
        if entry.already_imported {
            item = item.done("Already in Aura's MCP servers");
        }
        scanned.push(item, Plan::Mcp { entry });
    }
}

pub const SOURCES: &[(&str, &str)] = &[
    ("conductor", "Conductor"),
    ("superset", "Superset"),
    ("cursor", "Cursor"),
    ("windsurf", "Windsurf"),
    ("void", "Void"),
    ("zed", "Zed"),
];

fn app_installed(home: &Path, bundle: &str) -> bool {
    if cfg!(target_os = "macos") {
        Path::new("/Applications").join(bundle).exists() || home.join("Applications").join(bundle).exists()
    } else {
        false
    }
}

/// (installed, found) for one source, from paths alone.
pub fn presence(id: &str, home: &Path) -> (bool, bool) {
    match id {
        "conductor" => (app_installed(home, "Conductor.app"), conductor::db_path(home).is_file()),
        "superset" => (app_installed(home, "Superset.app"), superset::found(home)),
        "cursor" => (app_installed(home, "Cursor.app"), cursor::found(home)),
        "windsurf" => (app_installed(home, "Windsurf.app"), windsurf::found(home)),
        "void" => (app_installed(home, "Void.app"), void::db_path(home).is_file()),
        "zed" => (app_installed(home, "Zed.app"), zed::found(home)),
        _ => (false, false),
    }
}

pub fn detect(home: &Path, ledger: &Ledger) -> Vec<Detected> {
    SOURCES
        .iter()
        .map(|(id, name)| {
            let (installed, found) = presence(id, home);
            Detected {
                id: id.to_string(),
                name: name.to_string(),
                installed,
                found,
                imported: ledger.count(id),
            }
        })
        .collect()
}

pub fn scan(id: &str, ctx: &Ctx) -> Result<Scanned, String> {
    let name = SOURCES
        .iter()
        .find(|(s, _)| *s == id)
        .map(|(_, n)| *n)
        .ok_or_else(|| format!("Aura doesn't know an app called {id}"))?;
    let (installed, found) = presence(id, &ctx.home);
    let mut scanned = Scanned::new(id, name, installed, found);
    if !found {
        return Ok(scanned);
    }
    match id {
        "conductor" => conductor::scan(ctx, &mut scanned),
        "superset" => superset::scan(ctx, &mut scanned),
        "cursor" => cursor::scan(ctx, &mut scanned),
        "windsurf" => windsurf::scan(ctx, &mut scanned),
        "void" => void::scan(ctx, &mut scanned),
        "zed" => zed::scan(ctx, &mut scanned),
        _ => {}
    }
    // Ready first, then by most recent activity; what is done or can't come
    // over sinks to the bottom of each kind.
    scanned.scan.items.sort_by(|a, b| {
        let rank = |s: ItemState| match s {
            ItemState::Ready => 0,
            ItemState::Done => 1,
            ItemState::Unavailable => 2,
        };
        rank(a.state).cmp(&rank(b.state)).then(b.when.cmp(&a.when))
    });
    Ok(scanned)
}

/// The project list holds this many folders; past it the oldest are dropped,
/// which an import must never cause. Mirrors `RECENTS_MAX` in the window.
pub const PROJECT_LIST_MAX: usize = 40;

fn list_full_reason() -> String {
    format!(
        "Aura's project list is full ({PROJECT_LIST_MAX} projects). Remove one you no longer use, then import again."
    )
}

/// Import the items of `source` whose keys are in `keys`. `project_room` is
/// how many more folders the project list can take without dropping one.
pub fn run(
    source: &str,
    ctx: &mut Ctx,
    keys: &[String],
    mut project_room: usize,
    progress: &mut dyn FnMut(Progress),
) -> Result<RunReport, String> {
    let mut scanned = scan(source, ctx)?;
    let mut report = RunReport::default();
    // Repos first, then the workspaces under them, then everything that
    // lands inside a project — so a workspace or chat finds its project
    // already added, and a full project list stops at the repo it can't take.
    let rank = |k: &String| match scanned.plans.get(k) {
        Some(Plan::Repo { .. }) => 0,
        Some(Plan::Workspace { .. }) => 1,
        _ => 2,
    };
    let mut wanted: Vec<&String> = keys.iter().filter(|k| scanned.plans.contains_key(*k)).collect();
    wanted.sort_by_key(|k| rank(k));
    let total = wanted.len();
    let source_name = scanned.scan.name.clone();

    // Repos the run adds, so a workspace whose repo also came in this run
    // doesn't spend a second slot.
    let adopt_project = |ctx: &mut Ctx, report: &mut RunReport, root: &Path, room: &mut usize| -> Result<bool, String> {
        if ctx.is_known(root) {
            return Ok(false);
        }
        if *room == 0 {
            return Err(list_full_reason());
        }
        *room -= 1;
        ctx.mark_known(root);
        report.adopt.push(Adopt { root: path_str(root), name: None, pinned: false, project: true });
        Ok(true)
    };

    for (n, key) in wanted.into_iter().enumerate() {
        let Some(item) = scanned.scan.items.iter().find(|i| &i.key == key).cloned() else {
            continue;
        };
        progress(Progress { source: source.to_string(), done: n, total, title: item.title.clone() });
        let outcome = match item.state {
            ItemState::Done => Outcome::skipped(&item, item.reason.clone().unwrap_or_else(|| "Already in Aura".into())),
            ItemState::Unavailable => Outcome::skipped(&item, item.reason.clone().unwrap_or_else(|| "Can't be imported".into())),
            ItemState::Ready => match scanned.plans.remove(key) {
                None => Outcome::failed(&item, "It changed while importing — scan again"),
                Some(Plan::Repo { root }) => match adopt_project(ctx, &mut report, &root, &mut project_room) {
                    Ok(true) => Outcome::imported(&item, path_str(&root), None),
                    Ok(false) => Outcome::skipped(&item, "Already in Aura"),
                    Err(why) => Outcome::skipped(&item, why),
                },
                Some(Plan::Workspace { path, name, pinned, repo }) => {
                    match adopt_project(ctx, &mut report, &repo, &mut project_room) {
                        Err(why) => Outcome::skipped(&item, why),
                        Ok(added_repo) => {
                            report.adopt.push(Adopt { root: path_str(&path), name, pinned, project: false });
                            ctx.ledger.record(source, key, ItemKind::Workspace, &path_str(&path));
                            Outcome::imported(
                                &item,
                                path_str(&path),
                                added_repo.then(|| format!("Added {} to your projects too", folder_name(&repo))),
                            )
                        }
                    }
                }
                Some(Plan::Chat(chat)) => {
                    let loaded = match chat {
                        ChatPlan::Conductor(r) => conductor::load_chat(&r),
                        ChatPlan::Cursor(r) => cursor::load_chat(&r),
                        ChatPlan::Void(r) => void::load_chat(&r),
                        ChatPlan::Zed(r) => zed::load_chat(&r),
                    };
                    match loaded.and_then(apply::save_chat) {
                        Ok(session_id) => {
                            ctx.ledger.record(source, key, ItemKind::Chat, &session_id);
                            Outcome::imported(&item, session_id, None)
                        }
                        Err(why) => Outcome::failed(&item, why),
                    }
                }
                Some(Plan::Scripts { root, scripts }) => match apply::merge_scripts(&root, &scripts) {
                    Ok(wrote) if wrote.is_empty() => {
                        Outcome::skipped(&item, "Aura already has its own scripts set for this repo")
                    }
                    Ok(wrote) => {
                        ctx.ledger.record(source, key, ItemKind::Scripts, &path_str(&root));
                        Outcome::imported(&item, path_str(&root), Some(format!("Set {}", wrote.join(", "))))
                    }
                    Err(why) => Outcome::failed(&item, why),
                },
                Some(Plan::Rules { root }) => match apply::migrate_rules(&root) {
                    Ok(m) => {
                        ctx.ledger.record(source, key, ItemKind::Rules, &path_str(&root));
                        if m.wrote {
                            Outcome::imported(&item, path_str(&root.join("AGENTS.md")), None)
                        } else {
                            Outcome::skipped(&item, "AGENTS.md already has these rules")
                        }
                    }
                    Err(why) => Outcome::failed(&item, why),
                },
                Some(Plan::Mcp { entry }) => {
                    let name = entry.name.clone();
                    match crate::cmd_mcp_servers::mcp_servers_import_discovered(vec![entry]) {
                        Ok(written) if written.iter().any(|w| w.name == name) => {
                            ctx.ledger.record(source, key, ItemKind::Mcp, &name);
                            Outcome::imported(&item, name, None)
                        }
                        Ok(_) => Outcome::skipped(&item, "Aura already has an MCP server with this name"),
                        Err(why) => Outcome::failed(&item, why),
                    }
                }
            },
        };
        report.outcomes.push(outcome);
        // Saved after every item, so an import cut short still remembers
        // what it did.
        if let Err(e) = ctx.ledger.save() {
            tracing::warn!("import ledger not saved: {e}");
        }
    }
    progress(Progress { source: source.to_string(), done: total, total, title: source_name });
    Ok(report)
}

fn home() -> Result<PathBuf, String> {
    std::env::var_os("HOME").map(PathBuf::from).ok_or_else(|| "HOME not set".to_string())
}

#[tauri::command]
pub async fn import_sources_detect() -> Result<Vec<Detected>, String> {
    crate::blocking::run(move || Ok(detect(&home()?, &Ledger::load()))).await
}

#[tauri::command]
pub async fn import_source_scan(source: String, known_roots: Vec<String>) -> Result<SourceScan, String> {
    crate::blocking::run(move || {
        let ctx = Ctx::new(home()?, &known_roots, Ledger::load());
        scan(&source, &ctx).map(|s| s.scan)
    })
    .await
}

#[tauri::command]
pub async fn import_run(
    app: AppHandle,
    source: String,
    keys: Vec<String>,
    known_roots: Vec<String>,
    project_room: usize,
) -> Result<RunReport, String> {
    crate::blocking::run(move || {
        let mut ctx = Ctx::new(home()?, &known_roots, Ledger::load());
        let mut tick = |p: Progress| {
            let _ = app.emit("import:progress", &p);
        };
        run(&source, &mut ctx, &keys, project_room, &mut tick)
    })
    .await
}
