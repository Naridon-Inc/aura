//! Safely turn a `.vsix` (OPC/ZIP) into files on disk and read its manifest.
//!
//! A `.vsix` nests everything under `extension/`; the real VS Code manifest is
//! `extension/package.json`. We extract with hard ceilings (zip-bomb defence)
//! and refuse any entry whose path would escape the destination. We never run
//! any of the extracted code — only its declarative `contributes` is consumed
//! later, on the frontend.

use std::fs;
use std::io::Read;
use std::path::Path;

use super::model::ContributesSummary;

// Runaway / zip-bomb guards, independent of any caller.
const MAX_ENTRIES: usize = 20_000;
const MAX_TOTAL_UNCOMPRESSED: u64 = 256 * 1024 * 1024; // across the whole bundle
const MAX_FILE_UNCOMPRESSED: u64 = 64 * 1024 * 1024; // any single file

/// Extract a `.vsix` into `dest`, refusing path-escaping entries and enforcing
/// size ceilings. Returns the number of files written.
pub fn extract_vsix(vsix_bytes: &[u8], dest: &Path) -> Result<usize, String> {
    let reader = std::io::Cursor::new(vsix_bytes);
    let mut zip = zip::ZipArchive::new(reader).map_err(|e| format!("open vsix: {e}"))?;
    if zip.len() > MAX_ENTRIES {
        return Err(format!("vsix has too many entries ({})", zip.len()));
    }
    fs::create_dir_all(dest).map_err(|e| format!("mkdir {}: {e}", dest.display()))?;
    let mut total: u64 = 0;
    let mut written = 0usize;
    for i in 0..zip.len() {
        let mut entry = zip.by_index(i).map_err(|e| format!("read entry {i}: {e}"))?;
        // `enclosed_name` returns None for any path that would escape the root
        // (absolute, `..`, drive-relative) — the zip crate's traversal guard.
        let rel = match entry.enclosed_name() {
            Some(p) => p.to_path_buf(),
            None => return Err(format!("unsafe path in vsix: {}", entry.name())),
        };
        if entry.is_dir() {
            continue;
        }
        let size = entry.size();
        if size > MAX_FILE_UNCOMPRESSED {
            return Err(format!(
                "vsix entry too large: {} ({} bytes)",
                rel.display(),
                size
            ));
        }
        total = total.saturating_add(size);
        if total > MAX_TOTAL_UNCOMPRESSED {
            return Err("vsix uncompressed size exceeds limit".into());
        }
        let out_path = dest.join(&rel);
        if let Some(parent) = out_path.parent() {
            fs::create_dir_all(parent).map_err(|e| format!("mkdir {}: {e}", parent.display()))?;
        }
        let mut buf = Vec::with_capacity(size as usize);
        entry
            .read_to_end(&mut buf)
            .map_err(|e| format!("inflate {}: {e}", rel.display()))?;
        fs::write(&out_path, &buf).map_err(|e| format!("write {}: {e}", out_path.display()))?;
        written += 1;
    }
    Ok(written)
}

/// The fields we lift out of `extension/package.json` to record an install.
pub struct ParsedManifest {
    pub id: String,
    pub namespace: String,
    pub name: String,
    pub display_name: String,
    pub version: String,
    pub description: String,
    pub icon: Option<String>,
    pub contributes: ContributesSummary,
}

/// Read and summarise `extension/package.json` from an extracted bundle root.
/// `fallback_namespace` (from Open VSX) fills in when the manifest omits
/// `publisher`, as some bundles do.
pub fn parse_manifest(
    bundle_root: &Path,
    fallback_namespace: Option<&str>,
) -> Result<ParsedManifest, String> {
    let pkg_path = bundle_root.join("extension").join("package.json");
    let raw = fs::read_to_string(&pkg_path)
        .map_err(|e| format!("read manifest {}: {e}", pkg_path.display()))?;
    let v: serde_json::Value =
        serde_json::from_str(&raw).map_err(|e| format!("parse manifest: {e}"))?;

    let name = v
        .get("name")
        .and_then(|x| x.as_str())
        .unwrap_or("")
        .to_string();
    if name.is_empty() {
        return Err("manifest has no \"name\"".into());
    }
    let namespace = v
        .get("publisher")
        .and_then(|x| x.as_str())
        .filter(|s| !s.trim().is_empty())
        .map(|s| s.to_string())
        .or_else(|| fallback_namespace.map(|s| s.to_string()))
        .unwrap_or_else(|| "unknown".to_string());
    let version = v
        .get("version")
        .and_then(|x| x.as_str())
        .unwrap_or("0.0.0")
        .to_string();
    let display_name = v
        .get("displayName")
        .and_then(|x| x.as_str())
        .filter(|s| !s.trim().is_empty())
        .unwrap_or(&name)
        .to_string();
    let description = v
        .get("description")
        .and_then(|x| x.as_str())
        .unwrap_or("")
        .to_string();
    let icon = v
        .get("icon")
        .and_then(|x| x.as_str())
        .filter(|s| !s.trim().is_empty())
        .map(|s| s.to_string());

    Ok(ParsedManifest {
        id: format!("{namespace}.{name}"),
        namespace,
        name,
        display_name,
        version,
        description,
        icon,
        contributes: summarize_contributes(&v),
    })
}

fn arr_len(v: &serde_json::Value, key: &str) -> usize {
    v.get("contributes")
        .and_then(|c| c.get(key))
        .and_then(|x| x.as_array())
        .map(|a| a.len())
        .unwrap_or(0)
}

/// Count the views across every `contributes.views` container. `views` is an
/// object keyed by container id (`{ "explorer": [ … ], "myContainer": [ … ] }`),
/// so we sum the array lengths of all values rather than treating it as one
/// array.
fn views_total(v: &serde_json::Value) -> usize {
    v.get("contributes")
        .and_then(|c| c.get("views"))
        .and_then(|x| x.as_object())
        .map(|map| {
            map.values()
                .filter_map(|val| val.as_array())
                .map(|a| a.len())
                .sum()
        })
        .unwrap_or(0)
}

/// Whether a `contributes.<key>` is present and non-empty (object or array).
/// Used for shape-flexible kinds like `viewsContainers` (object of arrays) and
/// `webviews` (array), where we only need "is there any of this?".
fn contributes_present(v: &serde_json::Value, key: &str) -> bool {
    match v.get("contributes").and_then(|c| c.get(key)) {
        Some(serde_json::Value::Array(a)) => !a.is_empty(),
        Some(serde_json::Value::Object(o)) => !o.is_empty(),
        _ => false,
    }
}

fn has_str(v: &serde_json::Value, key: &str) -> bool {
    v.get(key)
        .and_then(|x| x.as_str())
        .map(|s| !s.trim().is_empty())
        .unwrap_or(false)
}

/// Summarise a parsed `package.json` value's declarative `contributes`. Shared
/// so the Open VSX preview path can classify an extension from its fetched
/// manifest — the same way an installed bundle is classified — without ever
/// downloading or extracting the `.vsix`.
///
/// Beyond the Tier-0/Tier-1 counts, this detects the *other* extension kinds
/// (language servers, panels/views, custom editors, debuggers) so the UI can
/// label them honestly as detected-but-not-yet-runnable. Detection is
/// declarative only — we never read or run the extension's `main`/`browser`
/// JavaScript; we only inspect what its manifest declares.
pub(crate) fn summarize_contributes(v: &serde_json::Value) -> ContributesSummary {
    let has_main = has_str(v, "main");
    let languages = arr_len(v, "languages");
    let grammars = arr_len(v, "grammars");
    // A Node `main` paired with language/grammar declarations is the classic
    // shape of a language extension that boots an LSP server in `activate` —
    // the highest-value "other kind" Aura can't host yet (Phase B).
    let is_language_server = has_main && (languages > 0 || grammars > 0);

    ContributesSummary {
        themes: arr_len(v, "themes"),
        languages,
        grammars,
        snippets: arr_len(v, "snippets"),
        icon_themes: arr_len(v, "iconThemes"),
        commands: arr_len(v, "commands"),
        has_main,
        has_browser: has_str(v, "browser"),
        is_language_server,
        views: views_total(v),
        views_containers: contributes_present(v, "viewsContainers"),
        custom_editors: arr_len(v, "customEditors"),
        webviews: contributes_present(v, "webviews"),
        debuggers: arr_len(v, "debuggers"),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write;

    fn build_vsix(files: &[(&str, &str)]) -> Vec<u8> {
        let mut buf = Vec::new();
        {
            let mut w = zip::ZipWriter::new(std::io::Cursor::new(&mut buf));
            let opts = zip::write::SimpleFileOptions::default()
                .compression_method(zip::CompressionMethod::Deflated);
            for (name, content) in files {
                w.start_file(*name, opts).unwrap();
                w.write_all(content.as_bytes()).unwrap();
            }
            w.finish().unwrap();
        }
        buf
    }

    fn scratch(prefix: &str) -> std::path::PathBuf {
        std::env::temp_dir().join(format!("{prefix}_{}", uuid::Uuid::new_v4().simple()))
    }

    #[test]
    fn extract_and_parse_minimal_theme_vsix() {
        let manifest = r#"{
            "name": "cooltheme",
            "publisher": "acme",
            "version": "1.2.3",
            "displayName": "Cool Theme",
            "description": "A cool theme",
            "contributes": {
                "themes": [
                    { "label": "Cool", "uiTheme": "vs-dark", "path": "./themes/cool.json" }
                ]
            }
        }"#;
        let theme = r##"{ "colors": { "editor.background": "#000000" } }"##;
        let vsix = build_vsix(&[
            ("extension/package.json", manifest),
            ("extension/themes/cool.json", theme),
            ("[Content_Types].xml", "<Types/>"),
        ]);
        let dir = scratch("aura_vsix_ok");
        let n = extract_vsix(&vsix, &dir).unwrap();
        assert!(n >= 2, "wrote at least the manifest + theme");

        let parsed = parse_manifest(&dir, Some("acme")).unwrap();
        assert_eq!(parsed.id, "acme.cooltheme");
        assert_eq!(parsed.version, "1.2.3");
        assert_eq!(parsed.display_name, "Cool Theme");
        assert_eq!(parsed.contributes.themes, 1);
        assert!(!parsed.contributes.has_main);
        assert!(!parsed.contributes.has_browser);

        let read = fs::read_to_string(dir.join("extension/themes/cool.json")).unwrap();
        assert!(read.contains("editor.background"));
        fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn fallback_namespace_when_manifest_omits_publisher() {
        let manifest = r#"{ "name": "nopub", "version": "0.1.0" }"#;
        let vsix = build_vsix(&[("extension/package.json", manifest)]);
        let dir = scratch("aura_vsix_nopub");
        extract_vsix(&vsix, &dir).unwrap();
        let parsed = parse_manifest(&dir, Some("fromgallery")).unwrap();
        assert_eq!(parsed.id, "fromgallery.nopub");
        assert_eq!(parsed.display_name, "nopub"); // falls back to name
        fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn detects_language_server_shape() {
        // Node `main` + declared languages/grammars = needs an LSP server.
        let v: serde_json::Value = serde_json::from_str(
            r#"{
                "name": "rust-analyzer",
                "main": "./out/main.js",
                "contributes": {
                    "languages": [{ "id": "rust", "extensions": [".rs"] }],
                    "grammars": [{ "language": "rust", "scopeName": "source.rust", "path": "x" }]
                }
            }"#,
        )
        .unwrap();
        let c = summarize_contributes(&v);
        assert!(c.has_main);
        assert!(c.is_language_server, "main + languages → language server");
        assert_eq!(c.languages, 1);
        assert_eq!(c.grammars, 1);
        assert!(!c.has_browser);
    }

    #[test]
    fn detects_panels_debuggers_and_views() {
        // `views` is keyed by container; `viewsContainers`/`webviews` are
        // presence flags; `debuggers`/`customEditors` are arrays.
        let v: serde_json::Value = serde_json::from_str(
            r#"{
                "name": "big-ext",
                "main": "./out/ext.js",
                "contributes": {
                    "viewsContainers": { "activitybar": [{ "id": "x", "title": "X", "icon": "i" }] },
                    "views": {
                        "x": [{ "id": "v1", "name": "One" }, { "id": "v2", "name": "Two" }]
                    },
                    "customEditors": [{ "viewType": "ce", "displayName": "CE", "selector": [] }],
                    "debuggers": [{ "type": "node", "label": "Node" }]
                }
            }"#,
        )
        .unwrap();
        let c = summarize_contributes(&v);
        assert!(c.views_containers);
        assert_eq!(c.views, 2, "two views across one container");
        assert_eq!(c.custom_editors, 1);
        assert_eq!(c.debuggers, 1);
        // No languages/grammars here, so it's a full program, not an LSP.
        assert!(!c.is_language_server);
        assert!(c.has_main);
    }

    #[test]
    fn plain_theme_reports_no_other_kinds() {
        let v: serde_json::Value = serde_json::from_str(
            r#"{ "name": "t", "contributes": { "themes": [{ "label": "T", "path": "p" }] } }"#,
        )
        .unwrap();
        let c = summarize_contributes(&v);
        assert_eq!(c.themes, 1);
        assert!(!c.is_language_server);
        assert_eq!(c.views, 0);
        assert!(!c.views_containers);
        assert_eq!(c.debuggers, 0);
        assert!(!c.webviews);
        assert!(!c.has_main);
    }

    #[test]
    fn rejects_path_traversal_entry() {
        // A malicious entry that tries to climb out of the destination dir.
        let vsix = build_vsix(&[
            ("../escape.txt", "pwned"),
            ("extension/package.json", "{\"name\":\"x\"}"),
        ]);
        let base = scratch("aura_vsix_evil");
        let dir = base.join("nested");
        let _ = extract_vsix(&vsix, &dir);
        // The real security property: nothing was written outside the dest.
        assert!(
            !base.join("escape.txt").exists(),
            "path traversal escaped the destination directory"
        );
        fs::remove_dir_all(&base).ok();
    }
}
