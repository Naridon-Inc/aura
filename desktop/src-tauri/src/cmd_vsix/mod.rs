//! VS Code extension support — Tier 0: install declarative content from the
//! Open VSX gallery and serve it to the frontend, which applies the themes,
//! language-configuration, snippets, and grammars to Monaco. **No extension
//! code is ever executed here.**
//!
//! A `.vsix` is an OPC/ZIP archive whose real manifest is
//! `extension/package.json`. We resolve a download URL via the Open VSX API
//! (host-pinned to open-vsx.org), extract jailed and size-capped under
//! `~/.aura/vscode-extensions/<id>-<version>/`, summarise the manifest's
//! `contributes`, and record it in an install index. The frontend then reads
//! the referenced asset files through `vsix_read_text`.
//!
//! Why Open VSX only: the Microsoft Marketplace Terms of Use forbid non-MS
//! products from installing or using its offerings (enforced in 2025). Open VSX
//! (Eclipse Foundation) is the only gallery we may legally use.

mod archive;
mod model;
mod openvsx;
mod store;

pub use model::{ContributesSummary, InstalledExtension, OpenVsxHit};

use std::path::PathBuf;

/// Search the Open VSX gallery. Listing metadata only — no code is fetched.
#[tauri::command]
pub async fn vsix_search(query: String, size: Option<u32>) -> Result<Vec<OpenVsxHit>, String> {
    let q = query.trim();
    if q.is_empty() {
        return Ok(Vec::new());
    }
    openvsx::search(q, size.unwrap_or(24)).await
}

/// Browse the gallery without a search term — curated rows by category and
/// popularity for the Discover grid. `category` is an Open VSX category name
/// ("Themes", "Programming Languages", "Snippets", …) or None for "all";
/// `sort` is one of "downloads" | "rating" | "updated" | "relevance". Listing
/// metadata only — no code is fetched.
#[tauri::command]
pub async fn vsix_browse(
    category: Option<String>,
    sort: Option<String>,
    size: Option<u32>,
) -> Result<Vec<OpenVsxHit>, String> {
    openvsx::browse(
        category.as_deref(),
        sort.as_deref().unwrap_or("downloads"),
        size.unwrap_or(24),
    )
    .await
}

/// Preview what an extension would actually contribute — its color themes,
/// language rules, and snippets — read straight from the gallery manifest
/// without downloading or extracting the `.vsix`. Lets the Discover view be
/// honest *before* the user installs (e.g. "runs its own program — not
/// supported yet"). Listing/manifest metadata only; no code is fetched or run.
#[tauri::command]
pub async fn vsix_preview_contributes(
    namespace: String,
    name: String,
) -> Result<ContributesSummary, String> {
    openvsx::preview_contributes(&namespace, &name).await
}

/// Install an extension from Open VSX by namespace + name (+ optional version).
/// New installs are enabled by default — the user explicitly chose to add it.
#[tauri::command]
pub async fn vsix_install(
    namespace: String,
    name: String,
    version: Option<String>,
) -> Result<InstalledExtension, String> {
    let resolved = openvsx::resolve(&namespace, &name, version.as_deref()).await?;
    let bytes = openvsx::download(&resolved.download_url).await?;
    install_bytes(&bytes, Some(&namespace))
}

/// Install from a local `.vsix` file the user picked from disk.
#[tauri::command]
pub fn vsix_install_file(path: String) -> Result<InstalledExtension, String> {
    let bytes = std::fs::read(&path).map_err(|e| format!("read {path}: {e}"))?;
    install_bytes(&bytes, None)
}

/// Every installed extension Aura currently knows about.
#[tauri::command]
pub fn vsix_list() -> Result<Vec<InstalledExtension>, String> {
    Ok(store::list())
}

/// Read a UTF-8 asset (the manifest, or a theme/grammar/snippet file it points
/// at) from an installed extension's package root — jailed and size-capped.
#[tauri::command]
pub fn vsix_read_text(id: String, rel: String) -> Result<String, String> {
    store::read_text(&id, &rel)
}

/// Enable or disable an installed extension. Disabling makes the contributes
/// router skip it on the next editor mount.
#[tauri::command]
pub fn vsix_set_enabled(id: String, enabled: bool) -> Result<(), String> {
    store::set_enabled(&id, enabled)
}

/// Uninstall: drop the index entry and delete the bundle from disk.
#[tauri::command]
pub fn vsix_remove(id: String) -> Result<(), String> {
    store::remove(&id)
}

/// Shared install path: extract to a staging dir, read the manifest, atomically
/// move into its final `<id>-<version>` home, clean up any prior bundle for the
/// same id, and record it. Staging is always removed, success or failure.
fn install_bytes(
    bytes: &[u8],
    namespace_hint: Option<&str>,
) -> Result<InstalledExtension, String> {
    let root = store::extensions_root()?;
    let staging = root.join(format!(".staging-{}", uuid::Uuid::new_v4().simple()));

    let result = (|| {
        archive::extract_vsix(bytes, &staging)?;
        let parsed = archive::parse_manifest(&staging, namespace_hint)?;
        let final_dir = root.join(format!("{}-{}", parsed.id, parsed.version));

        // Remove any bundle already sitting at this exact id+version slot.
        if final_dir.exists() {
            std::fs::remove_dir_all(&final_dir)
                .map_err(|e| format!("clear existing {}: {e}", final_dir.display()))?;
        }
        std::fs::rename(&staging, &final_dir).map_err(|e| format!("move into place: {e}"))?;

        // If a different version of the same id was installed, GC its old dir.
        if let Some(prev) = store::get(&parsed.id) {
            let prev_dir = PathBuf::from(&prev.install_dir);
            if prev_dir != final_dir && prev_dir.starts_with(&root) && prev_dir.is_dir() {
                let _ = std::fs::remove_dir_all(&prev_dir);
            }
        }

        let ext = InstalledExtension {
            id: parsed.id,
            namespace: parsed.namespace,
            name: parsed.name,
            display_name: parsed.display_name,
            version: parsed.version,
            description: parsed.description,
            install_dir: final_dir.to_string_lossy().to_string(),
            enabled: true,
            contributes: parsed.contributes,
            icon: parsed.icon,
            installed_at: store::now_millis(),
        };
        store::upsert(ext)
    })();

    if staging.exists() {
        let _ = std::fs::remove_dir_all(&staging);
    }
    result
}
