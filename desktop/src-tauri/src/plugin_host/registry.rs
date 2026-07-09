//! Plugin registry — scans the on-disk plugin install root and keeps
//! an in-memory cache of every installed plugin/skill/MCP manifest.
//!
//! Install layout (per the platform plan §14):
//!
//! ```text
//! ~/.aura/plugins/
//! ├─ @aura-demo/
//! │  └─ linear/
//! │     ├─ aura.plugin.json   ← native plugin
//! │     ├─ aura.skill.json    ← bundled skill (optional)
//! │     └─ aura.mcp.json      ← bundled MCP server (optional)
//! └─ @acme/
//!    └─ datadog/
//!       └─ aura.plugin.json
//! ```
//!
//! Each `<scope>/<name>/` directory may carry one of each kind — so the
//! same logical plugin can ship a skill + MCP + native plugin in one
//! bundle. The registry keys entries by (`kind`, `id`) so the three
//! kinds never collide on the same id.
//!
//! `watch()` wires `notify` against the install root so external
//! installers (`aura plugin pull`, `aura plugin dev`, mothership pull)
//! get reflected without a shell restart. The watcher debounces and
//! re-runs the full scan; given the install root is small (tens of
//! directories), a full rescan is cheaper than diff-tracking events.

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::{Arc, RwLock};
use std::time::{Duration, Instant};

use aura_plugin_sign::{verify_bundle, SignatureStatus, TrustStore};
use notify::{RecommendedWatcher, RecursiveMode, Watcher};

use super::capability::{CapabilityError, CapabilitySet};
use super::manifest::{parse_from_path, Manifest, ManifestError, ManifestKind};

/// Default install root: `~/.aura/plugins`. Falls back to `./.aura/plugins`
/// when the home dir is undiscoverable (CI / sandbox environments).
pub fn default_install_root() -> PathBuf {
    if let Some(home) = dirs_home() {
        home.join(".aura").join("plugins")
    } else {
        PathBuf::from(".aura").join("plugins")
    }
}

fn dirs_home() -> Option<PathBuf> {
    // Avoid pulling in the `dirs` crate for one call — read $HOME directly.
    std::env::var_os("HOME").map(PathBuf::from)
}

/// One installed item the registry tracks.
#[derive(Debug, Clone)]
pub struct RegistryEntry {
    pub id: String,
    pub kind: ManifestKind,
    pub version: String,
    pub install_dir: PathBuf,
    pub manifest: Manifest,
    pub capabilities: CapabilitySet,
    pub enabled: bool,
    /// Bundle-level signature verdict, shared by every manifest in the
    /// same install dir (the signature covers ALL bundle files,
    /// including `aura.mcp.json` / `aura.skill.json`). `Invalid`
    /// bundles never reach the cache — they are rejected in
    /// `ingest_leaf` — so consumers only ever see the other three
    /// states.
    pub signature: SignatureStatus,
}

/// Why a manifest was skipped during scan. The CLI's `aura plugin list`
/// can surface these so the user knows their plugin didn't load.
#[derive(Debug, Clone)]
pub struct ScanRejection {
    pub path: PathBuf,
    pub reason: String,
}

#[derive(Debug, Clone, Default)]
pub struct ScanReport {
    pub loaded: usize,
    pub rejections: Vec<ScanRejection>,
}

/// In-memory cache keyed by `(kind, id)`. Shared across the host via
/// `Arc<Registry>`; reads grab the RwLock briefly, scans take it for
/// the duration of the update.
#[derive(Debug, Default)]
pub struct Registry {
    entries: RwLock<HashMap<(ManifestKind, String), RegistryEntry>>,
    /// Hold the watcher to keep it alive; dropping it cancels the
    /// background notify thread.
    _watcher: RwLock<Option<RecommendedWatcher>>,
}

impl Registry {
    pub fn new() -> Self {
        Self::default()
    }

    /// Walk the install root, parse every manifest, replace the cache
    /// with the new set. Returns a report describing which manifests
    /// loaded and which were rejected.
    pub fn scan(&self, root: &Path) -> ScanReport {
        // Load the publisher trust store once per scan. A corrupt store
        // degrades every signed bundle to UnknownKey rather than
        // blocking the scan — surfaced as a rejection row so the user
        // knows verification is impaired.
        let mut pre_rejections = Vec::new();
        let trust = match TrustStore::load(&TrustStore::default_path()) {
            Ok(t) => t,
            Err(e) => {
                pre_rejections.push(ScanRejection {
                    path: TrustStore::default_path(),
                    reason: format!("plugin trust store unreadable ({e}) — signatures cannot be verified this scan"),
                });
                TrustStore::default()
            }
        };
        self.scan_with_trust(root, &trust, pre_rejections)
    }

    /// `scan` with an explicit trust store — the testable core, and the
    /// hook a future marketplace sync can use to verify against a
    /// freshly fetched key set without touching disk.
    pub fn scan_with_trust(
        &self,
        root: &Path,
        trust: &TrustStore,
        pre_rejections: Vec<ScanRejection>,
    ) -> ScanReport {
        let mut report = ScanReport {
            loaded: 0,
            rejections: pre_rejections,
        };
        let mut next: HashMap<(ManifestKind, String), RegistryEntry> = HashMap::new();

        if !root.exists() {
            // Empty root is fine — first run after install.
            self.replace_entries(next);
            return report;
        }

        // Two-level walk: <scope>/<name>/ — each leaf may carry one of
        // each manifest kind. We don't recurse deeper.
        let scope_dirs = match std::fs::read_dir(root) {
            Ok(rd) => rd,
            Err(e) => {
                report.rejections.push(ScanRejection {
                    path: root.to_path_buf(),
                    reason: format!("read install root: {e}"),
                });
                self.replace_entries(next);
                return report;
            }
        };

        for scope_entry in scope_dirs.flatten() {
            let scope_path = scope_entry.path();
            if !scope_path.is_dir() {
                continue;
            }
            let leaf_dirs = match std::fs::read_dir(&scope_path) {
                Ok(rd) => rd,
                Err(e) => {
                    report.rejections.push(ScanRejection {
                        path: scope_path.clone(),
                        reason: format!("read scope dir: {e}"),
                    });
                    continue;
                }
            };
            for leaf_entry in leaf_dirs.flatten() {
                let leaf_path = leaf_entry.path();
                if !leaf_path.is_dir() {
                    continue;
                }
                ingest_leaf(&leaf_path, trust, &mut next, &mut report);
            }
        }

        self.replace_entries(next);
        report
    }

    fn replace_entries(&self, next: HashMap<(ManifestKind, String), RegistryEntry>) {
        let mut w = self.entries.write().expect("registry write lock poisoned");
        *w = next;
    }

    /// Set up filesystem watching on the install root. Re-runs `scan`
    /// on every change after a 250ms debounce window. The handle that
    /// the watcher owns is stored on `self` so dropping the Registry
    /// also tears down the watcher.
    pub fn watch(self: &Arc<Self>, root: &Path) -> Result<(), notify::Error> {
        // Ensure the root exists so notify doesn't immediately error.
        if let Err(e) = std::fs::create_dir_all(root) {
            return Err(notify::Error::generic(&format!(
                "create install root {}: {e}",
                root.display()
            )));
        }

        let registry = Arc::clone(self);
        let root_buf = root.to_path_buf();
        let last_fire = Arc::new(RwLock::new(Instant::now() - Duration::from_secs(60)));

        let mut watcher = notify::recommended_watcher(move |res: notify::Result<notify::Event>| {
            // Cheap manual debounce — notify 6 doesn't ship a debounced
            // watcher by default and we don't want to pull in
            // notify-debouncer-* just for this. Coalesce events within
            // a 250ms window.
            if let Ok(event) = res {
                if event.kind.is_access() {
                    return;
                }
                let now = Instant::now();
                let should_fire = {
                    let mut lf = match last_fire.write() {
                        Ok(g) => g,
                        Err(_) => return,
                    };
                    if now.duration_since(*lf) < Duration::from_millis(250) {
                        false
                    } else {
                        *lf = now;
                        true
                    }
                };
                if should_fire {
                    registry.scan(&root_buf);
                }
            }
        })?;
        watcher.watch(root, RecursiveMode::Recursive)?;
        // Hold the watcher so it doesn't get dropped + cancelled.
        *self._watcher.write().expect("watcher slot") = Some(watcher);
        Ok(())
    }

    /// Snapshot of every loaded entry, sorted by (kind, id).
    pub fn list(&self) -> Vec<RegistryEntry> {
        let r = self.entries.read().expect("registry read lock poisoned");
        let mut v: Vec<RegistryEntry> = r.values().cloned().collect();
        v.sort_by(|a, b| {
            (a.kind as u8, a.id.as_str()).cmp(&(b.kind as u8, b.id.as_str()))
        });
        v
    }

    pub fn get(&self, kind: ManifestKind, id: &str) -> Option<RegistryEntry> {
        let r = self.entries.read().expect("registry read lock poisoned");
        r.get(&(kind, id.to_string())).cloned()
    }

    pub fn set_enabled(&self, kind: ManifestKind, id: &str, enabled: bool) -> bool {
        let mut w = self.entries.write().expect("registry write lock poisoned");
        if let Some(entry) = w.get_mut(&(kind, id.to_string())) {
            entry.enabled = enabled;
            true
        } else {
            false
        }
    }

    pub fn count(&self) -> usize {
        self.entries.read().expect("registry read lock poisoned").len()
    }
}

fn ingest_leaf(
    dir: &Path,
    trust: &TrustStore,
    next: &mut HashMap<(ManifestKind, String), RegistryEntry>,
    report: &mut ScanReport,
) {
    // One verification per bundle — the signature in aura.plugin.json
    // covers every file in the install dir, so the verdict applies to
    // all manifests found here. Tampered bundles are rejected outright:
    // a signature from a KNOWN publisher that doesn't match the bytes
    // means the bundle is not what the publisher shipped. Unsigned and
    // unknown-key bundles still load (badged in the UI) — local dev
    // and not-yet-trusted publishers are normal states.
    let signature = verify_bundle(dir, trust);
    if let SignatureStatus::Invalid { reason } = &signature {
        report.rejections.push(ScanRejection {
            path: dir.join(ManifestKind::NativePlugin.filename()),
            reason: format!("signature verification failed: {reason} — bundle not loaded"),
        });
        return;
    }

    for kind in [
        ManifestKind::NativePlugin,
        ManifestKind::Skill,
        ManifestKind::Mcp,
    ] {
        let path = dir.join(kind.filename());
        if !path.exists() {
            continue;
        }
        match load_one(&path, kind, signature.clone()) {
            Ok(entry) => {
                let key = (entry.kind, entry.id.clone());
                if next.contains_key(&key) {
                    report.rejections.push(ScanRejection {
                        path,
                        reason: format!(
                            "duplicate {kind:?} id `{}` — keeping the first one scanned",
                            entry.id
                        ),
                    });
                    continue;
                }
                report.loaded += 1;
                next.insert(key, entry);
            }
            Err(reason) => {
                report.rejections.push(ScanRejection { path, reason });
            }
        }
    }
}

fn load_one(
    path: &Path,
    expected: ManifestKind,
    signature: SignatureStatus,
) -> Result<RegistryEntry, String> {
    let manifest = parse_from_path(path).map_err(|e| match e {
        ManifestError::UnknownKind => "unknown manifest filename".to_string(),
        ManifestError::Io(s) => format!("io: {s}"),
        ManifestError::Parse { pointer, message } => format!("parse at {pointer}: {message}"),
        ManifestError::Structural { pointer, message } => {
            format!("invalid at {pointer}: {message}")
        }
    })?;
    if manifest.kind() != expected {
        return Err(format!(
            "manifest kind {:?} does not match filename {:?}",
            manifest.kind(),
            expected
        ));
    }
    let caps = match &manifest {
        Manifest::Plugin(p) => CapabilitySet::from_manifest_strings(&p.capabilities),
        Manifest::Mcp(m) => CapabilitySet::from_manifest_strings(&m.capabilities),
        // Skills don't currently declare capabilities — they ship as
        // pure markdown shipped to agents. Reserve a key for future
        // skill-level grants (e.g. agent restrictions) without
        // breaking the schema.
        Manifest::Skill(_) => Ok(CapabilitySet::new()),
    }
    .map_err(|e: CapabilityError| format!("capability: {e}"))?;
    let install_dir = path
        .parent()
        .map(Path::to_path_buf)
        .unwrap_or_else(|| PathBuf::from("."));
    Ok(RegistryEntry {
        id: manifest.id().to_string(),
        kind: manifest.kind(),
        version: manifest.version().to_string(),
        install_dir,
        capabilities: caps,
        manifest,
        enabled: true,
        signature,
    })
}

// ManifestKind needs to participate in sort + map keys; the enum is
// trivially copyable so derive isn't a regression.
impl ManifestKind {
    const _ORD: () = ();
}

// Make ManifestKind ordering deterministic for tests + list output.
impl From<ManifestKind> for u8 {
    fn from(k: ManifestKind) -> Self {
        k as u8
    }
}

// ─── tests ───────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;
    use std::sync::atomic::{AtomicUsize, Ordering};

    static TMPDIR_COUNTER: AtomicUsize = AtomicUsize::new(0);

    fn fresh_tmp() -> PathBuf {
        let n = TMPDIR_COUNTER.fetch_add(1, Ordering::SeqCst);
        let pid = std::process::id();
        let path =
            std::env::temp_dir().join(format!("aura-plugin-registry-test-{pid}-{n}"));
        let _ = fs::remove_dir_all(&path);
        fs::create_dir_all(&path).unwrap();
        path
    }

    fn write_plugin(root: &Path, scope: &str, name: &str) {
        let dir = root.join(scope).join(name);
        fs::create_dir_all(&dir).unwrap();
        fs::write(
            dir.join("aura.plugin.json"),
            format!(
                r#"{{
                    "schema": "https://aura.dev/schemas/plugin@1",
                    "id": "@{scope}/{name}",
                    "name": "{name}",
                    "version": "0.1.0",
                    "publisher": "{scope}",
                    "engines": {{ "aura": ">=0.12.0" }},
                    "description": "fixture",
                    "entry": "dist/plugin.js",
                    "capabilities": ["net:fetch:*.{name}.app"]
                }}"#
            ),
        )
        .unwrap();
    }

    fn write_bundle(root: &Path, scope: &str, name: &str) {
        let dir = root.join(scope).join(name);
        fs::create_dir_all(&dir).unwrap();
        fs::write(
            dir.join("aura.plugin.json"),
            format!(
                r#"{{
                    "schema": "https://aura.dev/schemas/plugin@1",
                    "id": "@{scope}/{name}",
                    "name": "{name}",
                    "version": "0.2.0",
                    "publisher": "{scope}",
                    "engines": {{ "aura": ">=0.12.0" }},
                    "description": "fixture bundle",
                    "entry": "dist/plugin.js"
                }}"#
            ),
        )
        .unwrap();
        fs::write(
            dir.join("aura.skill.json"),
            format!(
                r#"{{
                    "schema": "https://aura.dev/schemas/skill@1",
                    "id": "@{scope}/{name}-skill",
                    "version": "0.2.0",
                    "engines": {{ "aura": ">=0.12.0" }},
                    "description": "fixture skill",
                    "body": "skill.md"
                }}"#
            ),
        )
        .unwrap();
        fs::write(
            dir.join("aura.mcp.json"),
            format!(
                r#"{{
                    "schema": "https://aura.dev/schemas/mcp@1",
                    "id": "@{scope}/{name}-mcp",
                    "version": "0.2.0",
                    "engines": {{ "aura": ">=0.12.0" }},
                    "command": "node",
                    "tools": ["t1"]
                }}"#
            ),
        )
        .unwrap();
    }

    #[test]
    fn empty_root_yields_empty_report() {
        let root = fresh_tmp();
        let reg = Registry::new();
        let report = reg.scan(&root);
        assert_eq!(report.loaded, 0);
        assert!(report.rejections.is_empty());
        assert_eq!(reg.count(), 0);
    }

    #[test]
    fn missing_root_does_not_panic() {
        let reg = Registry::new();
        let report = reg.scan(Path::new("/nonexistent/aura-test-path"));
        assert_eq!(report.loaded, 0);
        assert!(report.rejections.is_empty());
    }

    #[test]
    fn scans_single_plugin() {
        let root = fresh_tmp();
        write_plugin(&root, "acme", "datadog");
        let reg = Registry::new();
        let report = reg.scan(&root);
        assert_eq!(report.loaded, 1);
        assert!(report.rejections.is_empty(), "{:?}", report.rejections);
        let list = reg.list();
        assert_eq!(list.len(), 1);
        assert_eq!(list[0].id, "@acme/datadog");
        assert_eq!(list[0].kind, ManifestKind::NativePlugin);
        assert!(list[0].capabilities.allows("net", "fetch", Some("api.datadog.app")));
    }

    #[test]
    fn scans_full_bundle_all_three_kinds() {
        let root = fresh_tmp();
        write_bundle(&root, "aura-demo", "linear");
        let reg = Registry::new();
        let report = reg.scan(&root);
        assert_eq!(report.loaded, 3, "loaded one of each kind");
        assert!(report.rejections.is_empty(), "{:?}", report.rejections);
        let list = reg.list();
        let kinds: Vec<_> = list.iter().map(|e| e.kind).collect();
        assert!(kinds.contains(&ManifestKind::NativePlugin));
        assert!(kinds.contains(&ManifestKind::Skill));
        assert!(kinds.contains(&ManifestKind::Mcp));
        // Three kinds at three distinct ids.
        assert_eq!(reg.count(), 3);
    }

    #[test]
    fn rejects_malformed_manifest_with_reason() {
        let root = fresh_tmp();
        let dir = root.join("acme").join("broken");
        fs::create_dir_all(&dir).unwrap();
        fs::write(
            dir.join("aura.plugin.json"),
            r#"{"id": "no-scope", "version": "0.1.0"}"#,
        )
        .unwrap();
        let reg = Registry::new();
        let report = reg.scan(&root);
        assert_eq!(report.loaded, 0);
        assert_eq!(report.rejections.len(), 1);
        assert!(report.rejections[0].reason.contains("parse")
            || report.rejections[0].reason.contains("invalid"));
    }

    #[test]
    fn rescan_replaces_cache_atomically() {
        let root = fresh_tmp();
        let reg = Registry::new();
        write_plugin(&root, "acme", "first");
        assert_eq!(reg.scan(&root).loaded, 1);
        assert!(reg.get(ManifestKind::NativePlugin, "@acme/first").is_some());

        // Remove the first plugin, install a second one — cache should
        // forget the old + learn the new.
        fs::remove_dir_all(root.join("acme").join("first")).unwrap();
        write_plugin(&root, "acme", "second");
        let report = reg.scan(&root);
        assert_eq!(report.loaded, 1);
        assert!(reg.get(ManifestKind::NativePlugin, "@acme/first").is_none());
        assert!(reg.get(ManifestKind::NativePlugin, "@acme/second").is_some());
    }

    #[test]
    fn set_enabled_toggles_flag_for_known_entry() {
        let root = fresh_tmp();
        write_plugin(&root, "acme", "x");
        let reg = Registry::new();
        reg.scan(&root);
        assert!(reg.set_enabled(ManifestKind::NativePlugin, "@acme/x", false));
        assert!(!reg.get(ManifestKind::NativePlugin, "@acme/x").unwrap().enabled);
        assert!(reg.set_enabled(ManifestKind::NativePlugin, "@acme/x", true));
        assert!(reg.get(ManifestKind::NativePlugin, "@acme/x").unwrap().enabled);
    }

    #[test]
    fn set_enabled_returns_false_for_unknown() {
        let reg = Registry::new();
        assert!(!reg.set_enabled(ManifestKind::NativePlugin, "@nope/none", false));
    }

    // ─── signature policy ────────────────────────────────────────────

    use aura_plugin_sign::{sign_bundle, SignatureStatus, TrustStore};

    #[test]
    fn unsigned_bundle_loads_with_unsigned_status() {
        let root = fresh_tmp();
        write_plugin(&root, "acme", "plain");
        let reg = Registry::new();
        let report = reg.scan_with_trust(&root, &TrustStore::default(), Vec::new());
        assert_eq!(report.loaded, 1);
        let entry = reg.get(ManifestKind::NativePlugin, "@acme/plain").unwrap();
        assert_eq!(entry.signature, SignatureStatus::Unsigned);
    }

    #[test]
    fn signed_bundle_verifies_and_status_reaches_all_kinds() {
        let root = fresh_tmp();
        write_bundle(&root, "aura-demo", "linear");
        let key = aura_attestation::SigningKey::generate();
        sign_bundle(&root.join("aura-demo").join("linear"), &key).unwrap();
        let mut trust = TrustStore::default();
        trust.add_key(&key.verifying_key(), "aura-demo");

        let reg = Registry::new();
        let report = reg.scan_with_trust(&root, &trust, Vec::new());
        assert_eq!(report.loaded, 3, "{:?}", report.rejections);
        // The bundle signature covers all three manifests in the leaf.
        for (kind, id) in [
            (ManifestKind::NativePlugin, "@aura-demo/linear"),
            (ManifestKind::Skill, "@aura-demo/linear-skill"),
            (ManifestKind::Mcp, "@aura-demo/linear-mcp"),
        ] {
            let entry = reg.get(kind, id).unwrap();
            assert!(
                matches!(&entry.signature, SignatureStatus::Verified { publisher, .. } if publisher == "aura-demo"),
                "{id}: {:?}",
                entry.signature
            );
        }
    }

    #[test]
    fn tampered_signed_bundle_is_rejected_entirely() {
        let root = fresh_tmp();
        write_bundle(&root, "aura-demo", "linear");
        let leaf = root.join("aura-demo").join("linear");
        let key = aura_attestation::SigningKey::generate();
        sign_bundle(&leaf, &key).unwrap();
        let mut trust = TrustStore::default();
        trust.add_key(&key.verifying_key(), "aura-demo");
        // Tamper with the bundled MCP manifest post-signing.
        fs::write(
            leaf.join("aura.mcp.json"),
            r#"{
                "schema": "https://aura.dev/schemas/mcp@1",
                "id": "@aura-demo/linear-mcp",
                "version": "0.2.0",
                "engines": { "aura": ">=0.12.0" },
                "command": "curl",
                "tools": ["t1"]
            }"#,
        )
        .unwrap();

        let reg = Registry::new();
        let report = reg.scan_with_trust(&root, &trust, Vec::new());
        assert_eq!(report.loaded, 0, "no manifest from a tampered bundle may load");
        assert_eq!(report.rejections.len(), 1);
        assert!(report.rejections[0].reason.contains("signature"));
        assert_eq!(reg.count(), 0);
    }

    #[test]
    fn signed_bundle_with_unknown_key_loads_badged() {
        let root = fresh_tmp();
        write_plugin(&root, "acme", "stranger");
        let key = aura_attestation::SigningKey::generate();
        sign_bundle(&root.join("acme").join("stranger"), &key).unwrap();

        let reg = Registry::new();
        // Empty trust store — the key is unknown, not wrong.
        let report = reg.scan_with_trust(&root, &TrustStore::default(), Vec::new());
        assert_eq!(report.loaded, 1, "{:?}", report.rejections);
        let entry = reg.get(ManifestKind::NativePlugin, "@acme/stranger").unwrap();
        assert!(matches!(entry.signature, SignatureStatus::UnknownKey { .. }));
    }
}
