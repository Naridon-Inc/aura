//! Tauri commands for the plugin secrets broker.
//!
//! The renderer can SET and CLEAR secrets and ask which keys are set —
//! it can never read a value back. Values go straight from the
//! Settings input into the OS keychain (`plugin_host::secrets`) and
//! only resurface inside `interpolate_env` when an MCP child process
//! spawns.
//!
//! Every command validates that `bundle` names a real install bundle
//! in the registry, so a compromised renderer can't use this surface
//! as an arbitrary keychain read/write oracle — writes land only under
//! `aura-plugin-secrets/<known-bundle>/<key>` accounts.

use serde::Serialize;
use tauri::State;

use crate::cmd_plugin::PluginHostState;
use crate::plugin_host::{secrets, Manifest};

/// One secret the Settings UI shows for a bundle.
#[derive(Debug, Serialize)]
pub struct PluginSecretRow {
    pub key: String,
    /// Human label from the native manifest's `secrets` declaration.
    /// None when the key is only referenced from MCP env (synthesized
    /// row) — the UI falls back to the key itself.
    pub title: Option<String>,
    /// Provider token page from the declaration, when present.
    pub url: Option<String>,
    /// True iff the keychain currently holds a value.
    pub set: bool,
    /// "declared" (native manifest secrets list) or "referenced"
    /// (found in MCP env `${secrets:…}` with no declaration).
    pub source: String,
}

/// True iff some registry entry lives in this bundle directory.
fn bundle_exists(state: &PluginHostState, bundle: &str) -> bool {
    state.registry.list().iter().any(|e| {
        secrets::bundle_id_from_install_dir(&e.install_dir).as_deref() == Some(bundle)
    })
}

#[tauri::command]
pub fn plugin_secrets_status(
    state: State<'_, PluginHostState>,
    bundle: String,
) -> Result<Vec<PluginSecretRow>, String> {
    let entries: Vec<_> = state
        .registry
        .list()
        .into_iter()
        .filter(|e| {
            secrets::bundle_id_from_install_dir(&e.install_dir).as_deref()
                == Some(bundle.as_str())
        })
        .collect();
    if entries.is_empty() {
        return Err(format!("no installed bundle matches `{bundle}`"));
    }

    let mut rows: Vec<PluginSecretRow> = Vec::new();
    let mut have = std::collections::HashSet::new();

    // Declared secrets first — they carry titles + token-page URLs.
    for e in &entries {
        if let Manifest::Plugin(p) = &e.manifest {
            for decl in &p.secrets {
                if !secrets::valid_secret_key(&decl.id) || !have.insert(decl.id.clone()) {
                    continue;
                }
                rows.push(PluginSecretRow {
                    key: decl.id.clone(),
                    title: Some(decl.title.clone()),
                    url: decl.url.clone(),
                    set: secrets::secret_exists(&bundle, &decl.id)?,
                    source: "declared".into(),
                });
            }
        }
    }

    // Then keys referenced from MCP env that nothing declared — the
    // server can't spawn without them, so the UI must show them too.
    for e in &entries {
        if let Manifest::Mcp(m) = &e.manifest {
            for value in m.env.values() {
                for key in secrets::find_secret_refs(value)? {
                    if !have.insert(key.clone()) {
                        continue;
                    }
                    rows.push(PluginSecretRow {
                        set: secrets::secret_exists(&bundle, &key)?,
                        key,
                        title: None,
                        url: None,
                        source: "referenced".into(),
                    });
                }
            }
        }
    }

    rows.sort_by(|a, b| a.key.cmp(&b.key));
    Ok(rows)
}

#[tauri::command]
pub fn plugin_secret_set(
    state: State<'_, PluginHostState>,
    bundle: String,
    key: String,
    value: String,
) -> Result<(), String> {
    if !bundle_exists(&state, &bundle) {
        return Err(format!("no installed bundle matches `{bundle}`"));
    }
    secrets::secret_set(&bundle, &key, &value)
}

#[tauri::command]
pub fn plugin_secret_clear(
    state: State<'_, PluginHostState>,
    bundle: String,
    key: String,
) -> Result<(), String> {
    if !bundle_exists(&state, &bundle) {
        return Err(format!("no installed bundle matches `{bundle}`"));
    }
    secrets::secret_delete(&bundle, &key)
}
