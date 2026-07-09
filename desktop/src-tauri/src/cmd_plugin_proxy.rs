//! Rust-side enforcement for plugin host calls (defense in depth).
//!
//! The renderer's `PluginBridge` already ACL-checks every plugin call
//! against the manifest's `CapabilitySet` — but the renderer is the
//! same process that runs plugin iframes/workers, so a renderer
//! compromise must not be able to mint filesystem or network access.
//! Every command here therefore RE-derives the plugin's capabilities
//! from the registry (Tauri managed state, fed only by manifest scan)
//! and re-checks the request before touching the OS. The renderer
//! never passes capability strings in — only the plugin id.
//!
//! Surface:
//!   • `plugin_asset_read`   — host loading the plugin's own code
//!     (worker entry, panel html). No capability needed, but path is
//!     jailed to the plugin's install dir.
//!   • `plugin_proxy_fs_read` — `fs:read:<glob>` against the open repo.
//!   • `plugin_proxy_net_fetch` — `net:fetch:<host>` HTTP(S) proxy.
//!   • `plugin_kv_get/set`   — `storage:kv` per-plugin persisted KV.

use std::path::{Component, Path, PathBuf};

use serde::{Deserialize, Serialize};
use tauri::State;

use crate::cmd_plugin::PluginHostState;
use crate::plugin_host::secrets::bundle_id_from_install_dir;
use crate::plugin_host::{glob_match, resolve_injected_secret, Manifest, ManifestKind, RegistryEntry};

/// Hard ceilings, independent of capability grants.
const ASSET_MAX_BYTES: u64 = 5 * 1024 * 1024; // plugin's own bundle files
const FS_READ_MAX_BYTES: u64 = 2 * 1024 * 1024; // repo files served to plugins
const NET_BODY_MAX_BYTES: usize = 2 * 1024 * 1024; // proxied response bodies
const KV_MAX_BYTES: usize = 256 * 1024; // per-plugin KV store

/// Look up an *enabled native plugin* by id. Disabled plugins lose all
/// host access instantly — the bridge may still be draining calls when
/// the user flips the toggle, and those must fail here. Shared with
/// `cmd_plugin_realtime`, which enforces the same registry-derived
/// capability model.
pub(crate) fn enabled_plugin(
    state: &PluginHostState,
    plugin_id: &str,
) -> Result<RegistryEntry, String> {
    let entry = state
        .registry
        .get(ManifestKind::NativePlugin, plugin_id)
        .ok_or_else(|| format!("unknown plugin: {plugin_id}"))?;
    if !entry.enabled {
        return Err(format!("plugin {plugin_id} is disabled"));
    }
    Ok(entry)
}

/// Reject any relative path that could climb out of its jail. We check
/// the *lexical* components before touching the fs so a non-existent
/// `../` path can't be probed, then canonicalize and re-check the
/// prefix to also defeat symlink hops.
fn jail_join(root: &Path, rel: &str) -> Result<PathBuf, String> {
    let rel_path = Path::new(rel);
    if rel_path.is_absolute() {
        return Err("absolute paths are not allowed".into());
    }
    for c in rel_path.components() {
        match c {
            Component::Normal(_) | Component::CurDir => {}
            _ => return Err(format!("path escapes plugin root: {rel}")),
        }
    }
    let joined = root.join(rel_path);
    let canon = joined
        .canonicalize()
        .map_err(|e| format!("read {rel}: {e}"))?;
    let canon_root = root
        .canonicalize()
        .map_err(|e| format!("plugin root unavailable: {e}"))?;
    if !canon.starts_with(&canon_root) {
        return Err(format!("path escapes plugin root: {rel}"));
    }
    Ok(canon)
}

// ── plugin assets (the host loading plugin code) ─────────────────────

#[derive(Debug, Serialize)]
pub struct AssetPayload {
    pub body: String,
}

/// Read a file from the plugin's own install dir — the worker entry or
/// a panel html the host is about to mount. Not a plugin-callable
/// capability: this is the *host* loading the code it already decided
/// to run. Jailed to install_dir, capped, UTF-8 only.
#[tauri::command]
pub fn plugin_asset_read(
    state: State<'_, PluginHostState>,
    plugin_id: String,
    path: String,
) -> Result<AssetPayload, String> {
    let entry = enabled_plugin(&state, &plugin_id)?;
    let full = jail_join(&entry.install_dir, &path)?;
    let meta = std::fs::metadata(&full).map_err(|e| format!("stat {path}: {e}"))?;
    if !meta.is_file() {
        return Err(format!("not a file: {path}"));
    }
    if meta.len() > ASSET_MAX_BYTES {
        return Err(format!(
            "asset {path} exceeds {} byte cap",
            ASSET_MAX_BYTES
        ));
    }
    let body = std::fs::read_to_string(&full).map_err(|e| format!("read {path}: {e}"))?;
    Ok(AssetPayload { body })
}

// ── fs:read against the open repo ────────────────────────────────────

/// Repo paths no capability grant can reach. `.git` internals can hold
/// credentials (remote URLs, hooks); dot-env files are secrets by
/// convention. Matched on any path segment, case-insensitive.
fn fs_denylisted(rel: &str) -> bool {
    rel.split(['/', '\\']).any(|seg| {
        let s = seg.to_ascii_lowercase();
        s == ".git" || s.starts_with(".env") || s == "id_rsa" || s == "id_ed25519"
    })
}

#[tauri::command]
pub fn plugin_proxy_fs_read(
    state: State<'_, PluginHostState>,
    plugin_id: String,
    repo_root: String,
    path: String,
) -> Result<String, String> {
    let entry = enabled_plugin(&state, &plugin_id)?;
    // The capability scope is matched against the repo-relative path,
    // exactly like the renderer-side check — `fs:read:src/**` grants
    // src only; bare `fs:read` (unscoped) grants the whole repo.
    let rel = path.trim_start_matches(['/', '\\']);
    if fs_denylisted(rel) {
        return Err(format!("path is denylisted for plugins: {rel}"));
    }
    if !entry.capabilities.allows("fs", "read", Some(rel)) {
        return Err(format!(
            "plugin {plugin_id} lacks capability fs:read for {rel}"
        ));
    }
    let root = PathBuf::from(&repo_root);
    if !root.is_dir() {
        return Err(format!("repo root not found: {repo_root}"));
    }
    let full = jail_join(&root, rel)?;
    let meta = std::fs::metadata(&full).map_err(|e| format!("stat {rel}: {e}"))?;
    if !meta.is_file() {
        return Err(format!("not a file: {rel}"));
    }
    if meta.len() > FS_READ_MAX_BYTES {
        return Err(format!("file {rel} exceeds {} byte cap", FS_READ_MAX_BYTES));
    }
    std::fs::read_to_string(&full).map_err(|e| format!("read {rel}: {e}"))
}

// ── net:fetch proxy ──────────────────────────────────────────────────

#[derive(Debug, Deserialize)]
pub struct NetFetchRequest {
    pub url: String,
    /// GET | POST | PUT | PATCH | DELETE | HEAD. Anything else rejects.
    #[serde(default)]
    pub method: Option<String>,
    #[serde(default)]
    pub headers: Vec<(String, String)>,
    #[serde(default)]
    pub body: Option<String>,
}

#[derive(Debug, Serialize)]
pub struct NetFetchResponse {
    pub status: u16,
    pub headers: Vec<(String, String)>,
    pub body: String,
    pub truncated: bool,
}

/// Proxy an HTTP(S) request on behalf of a plugin. The capability scope
/// is the HOST — `net:fetch:api.linear.app` allows exactly that host
/// (or a glob like `*.linear.app`). The proxy never attaches host-app
/// credentials; whatever auth the plugin needs rides in its own
/// explicit headers.
#[tauri::command]
pub async fn plugin_proxy_net_fetch(
    state: State<'_, PluginHostState>,
    plugin_id: String,
    req: NetFetchRequest,
) -> Result<NetFetchResponse, String> {
    let entry = enabled_plugin(&state, &plugin_id)?;

    let mut url = reqwest::Url::parse(&req.url).map_err(|e| format!("bad url: {e}"))?;
    let host = url.host_str().ok_or("url has no host")?.to_string();
    match url.scheme() {
        "https" => {}
        // Plain http only for loopback dev servers.
        "http" if host == "localhost" || host == "127.0.0.1" || host == "[::1]" => {}
        s => return Err(format!("scheme {s} not allowed (https only)")),
    }
    if !entry.capabilities.allows("net", "fetch", Some(&host)) {
        return Err(format!(
            "plugin {plugin_id} lacks capability net:fetch for {host}"
        ));
    }

    // ── host-side credential injection (the mini-app seam) ──────────────
    // The bridge already proved `net:fetch` for this host. If the manifest
    // also declares a `netAuth` binding whose host matches, resolve the
    // secret from the keychain and attach it — as a request header or a
    // query param — so the sandbox can call an authenticated API WITHOUT
    // ever holding the credential. Injection additionally requires the
    // `secrets:<id>` grant (re-checked in `resolve_injected_secret`); a
    // secret that isn't set fails the call rather than sending it
    // unauthenticated. Resolved values are attached below and never cross
    // back into the response or any log line.
    let mut header_injections: Vec<(String, String)> = Vec::new();
    if let Manifest::Plugin(p) = &entry.manifest {
        if !p.net_auth.is_empty() {
            let bundle = bundle_id_from_install_dir(&entry.install_dir)
                .ok_or("plugin bundle id unavailable for credential injection")?;
            let mut query_injections: Vec<(String, String)> = Vec::new();
            for b in &p.net_auth {
                if !glob_match(&b.host, &host) {
                    continue;
                }
                let secret = resolve_injected_secret(&bundle, &entry.capabilities, &b.secret)?;
                let filled = b.inject.template.replace("${secret}", &secret);
                match b.inject.kind.as_str() {
                    "header" => header_injections.push((b.inject.name.clone(), filled)),
                    "query" => query_injections.push((b.inject.name.clone(), filled)),
                    // kind validated to header|query at scan; ignore others.
                    _ => {}
                }
            }
            if !query_injections.is_empty() {
                let mut qp = url.query_pairs_mut();
                for (k, v) in &query_injections {
                    qp.append_pair(k, v);
                }
            }
        }
    }

    let method_raw = req.method.as_deref().unwrap_or("GET").to_ascii_uppercase();
    let method = match method_raw.as_str() {
        "GET" | "POST" | "PUT" | "PATCH" | "DELETE" | "HEAD" => {
            reqwest::Method::from_bytes(method_raw.as_bytes()).map_err(|e| e.to_string())?
        }
        m => return Err(format!("method {m} not allowed")),
    };

    // A cross-host redirect can carry a host-injected credential header to a
    // different host: reqwest only strips its own fixed sensitive-header set
    // (Authorization, Cookie, …) on a cross-host hop, NOT a custom-named
    // injected header like `X-Api-Key`. So when we're about to attach a
    // credential header, refuse to auto-follow redirects — the plugin gets
    // the 3xx response and can follow it itself, which re-runs the
    // `net:fetch:<new-host>` capability check for the new host. Query-injected
    // secrets are safe (the Location replaces the query), and uncredentialed
    // fetches keep the normal bounded redirect behavior.
    let redirect_policy = if header_injections.is_empty() {
        reqwest::redirect::Policy::limited(5)
    } else {
        reqwest::redirect::Policy::none()
    };
    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(20))
        .redirect(redirect_policy)
        .build()
        .map_err(|e| e.to_string())?;

    let mut builder = client.request(method, url);
    for (k, v) in &req.headers {
        // Host/connection management stays ours; everything else is the
        // plugin's business (its own API tokens etc.).
        let kl = k.to_ascii_lowercase();
        if kl == "host" || kl == "connection" || kl == "content-length" || kl == "cookie" {
            continue;
        }
        builder = builder.header(k, v);
    }
    // Host-injected credentials go on AFTER the plugin's own headers so a
    // plugin can't pre-set the auth header to a value of its choosing and
    // have it survive. reqwest rejects control chars in header values, so
    // a malformed secret fails the call closed rather than smuggling a
    // newline-injected header.
    for (k, v) in &header_injections {
        builder = builder.header(k, v);
    }
    if let Some(b) = req.body {
        builder = builder.body(b);
    }

    let resp = builder.send().await.map_err(|e| format!("fetch: {e}"))?;
    let status = resp.status().as_u16();
    let headers = resp
        .headers()
        .iter()
        .filter_map(|(k, v)| v.to_str().ok().map(|vs| (k.to_string(), vs.to_string())))
        .collect();
    let bytes = resp.bytes().await.map_err(|e| format!("read body: {e}"))?;
    let truncated = bytes.len() > NET_BODY_MAX_BYTES;
    let slice = &bytes[..bytes.len().min(NET_BODY_MAX_BYTES)];
    let body = String::from_utf8_lossy(slice).into_owned();
    Ok(NetFetchResponse {
        status,
        headers,
        body,
        truncated,
    })
}

// ── storage:kv (per-plugin persisted state) ──────────────────────────

/// One JSON object per plugin under `<install_root>/.kv/`. The plugin
/// id is sanitized into a filename (`@scope/name` → `@scope__name`);
/// ids come from the registry so they're already validated, this just
/// keeps the path flat.
fn kv_path(state: &PluginHostState, plugin_id: &str) -> PathBuf {
    let safe = plugin_id.replace('/', "__");
    state.install_root.join(".kv").join(format!("{safe}.json"))
}

fn kv_load(path: &Path) -> serde_json::Map<String, serde_json::Value> {
    std::fs::read(path)
        .ok()
        .and_then(|b| serde_json::from_slice(&b).ok())
        .unwrap_or_default()
}

#[tauri::command]
pub fn plugin_kv_get(
    state: State<'_, PluginHostState>,
    plugin_id: String,
    key: String,
) -> Result<Option<serde_json::Value>, String> {
    let entry = enabled_plugin(&state, &plugin_id)?;
    if !entry.capabilities.allows("storage", "kv", None) {
        return Err(format!("plugin {plugin_id} lacks capability storage:kv"));
    }
    Ok(kv_load(&kv_path(&state, &plugin_id)).get(&key).cloned())
}

/// Set a key in the plugin's KV store. A `null` value deletes the key.
#[tauri::command]
pub fn plugin_kv_set(
    state: State<'_, PluginHostState>,
    plugin_id: String,
    key: String,
    value: serde_json::Value,
) -> Result<(), String> {
    let entry = enabled_plugin(&state, &plugin_id)?;
    if !entry.capabilities.allows("storage", "kv", None) {
        return Err(format!("plugin {plugin_id} lacks capability storage:kv"));
    }
    let path = kv_path(&state, &plugin_id);
    let mut map = kv_load(&path);
    if value.is_null() {
        map.remove(&key);
    } else {
        map.insert(key, value);
    }
    let body = serde_json::to_vec(&map).map_err(|e| e.to_string())?;
    if body.len() > KV_MAX_BYTES {
        return Err(format!(
            "plugin KV store exceeds {} byte cap",
            KV_MAX_BYTES
        ));
    }
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    // Atomic tmp+rename, mirroring the registry state file pattern.
    let tmp = path.with_extension("json.tmp");
    std::fs::write(&tmp, &body).map_err(|e| e.to_string())?;
    std::fs::rename(&tmp, &path).map_err(|e| e.to_string())?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn jail_join_blocks_escapes() {
        let tmp = tempfile::tempdir().unwrap();
        std::fs::write(tmp.path().join("ok.txt"), "hi").unwrap();
        // Normal relative path resolves.
        assert!(jail_join(tmp.path(), "ok.txt").is_ok());
        // Parent-dir traversal rejects lexically (file need not exist).
        assert!(jail_join(tmp.path(), "../etc/passwd").is_err());
        assert!(jail_join(tmp.path(), "a/../../b").is_err());
        // Absolute paths reject.
        assert!(jail_join(tmp.path(), "/etc/passwd").is_err());
    }

    #[test]
    fn jail_join_defeats_symlink_hops() {
        let tmp = tempfile::tempdir().unwrap();
        let outside = tempfile::tempdir().unwrap();
        std::fs::write(outside.path().join("secret.txt"), "s").unwrap();
        #[cfg(unix)]
        {
            std::os::unix::fs::symlink(outside.path(), tmp.path().join("link")).unwrap();
            // Lexically fine (`link/secret.txt`), but canonicalization
            // lands outside the jail → reject.
            assert!(jail_join(tmp.path(), "link/secret.txt").is_err());
        }
    }

    #[test]
    fn fs_denylist_blocks_secret_paths() {
        assert!(fs_denylisted(".git/config"));
        assert!(fs_denylisted("sub/.git/HEAD"));
        assert!(fs_denylisted(".env"));
        assert!(fs_denylisted("config/.env.local"));
        assert!(fs_denylisted("keys/id_rsa"));
        assert!(!fs_denylisted("src/main.rs"));
        assert!(!fs_denylisted("environment.ts")); // not a dot-env
    }
}
