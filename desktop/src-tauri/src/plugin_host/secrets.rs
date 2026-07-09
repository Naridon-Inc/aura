//! Plugin secrets broker.
//!
//! Plugins never see secret values. A manifest declares the secrets it
//! needs (`secrets: [{id, title, url}]` on the native plugin manifest)
//! and *references* them from MCP env values as `${secrets:<key>}`.
//! The user supplies values once in Settings → Plugins; we store them
//! in the OS keychain and interpolate them into the child's environment
//! at spawn time — values live in memory only, never on disk, and never
//! cross the bridge to a renderer or a plugin sandbox.
//!
//! Scoping: secrets belong to the *install bundle* (the
//! `~/.aura/plugins/<scope>/<name>/` directory), not to a single
//! manifest id. A bundle may ship `aura.plugin.json` (which declares
//! the secrets for the Settings UI) plus `aura.mcp.json` (which
//! references them from env) under different ids — both resolve
//! against the same bundle namespace, and no bundle can ever name
//! another bundle's keychain entries.
//!
//! Defense in depth: interpolating `${secrets:foo}` additionally
//! requires the *referencing manifest* to declare the capability
//! `secrets:foo`. A tampered env value reaching for a key the manifest
//! never declared fails closed before the keychain is consulted.

use std::collections::{BTreeMap, HashMap};
use std::path::Path;

use super::capability::CapabilitySet;

const KEYCHAIN_SERVICE: &str = "aura-plugin-secrets";

/// Hard cap on stored secret values. Keychain backends get unhappy with
/// large blobs; nothing shaped like an API credential comes close.
const MAX_SECRET_LEN: usize = 8 * 1024;

// ─── bundle identity ─────────────────────────────────────────────────

/// Derive the bundle id (`@scope/name`) from a registry entry's
/// install dir (`…/plugins/@scope/name`). Returns None when the path
/// is too shallow to carry both components.
pub fn bundle_id_from_install_dir(dir: &Path) -> Option<String> {
    let name = dir.file_name()?.to_str()?;
    let scope = dir.parent()?.file_name()?.to_str()?;
    if name.is_empty() || scope.is_empty() {
        return None;
    }
    Some(format!("{scope}/{name}"))
}

/// Secret keys are snake-case identifiers: they appear inside
/// `${secrets:…}` references, in capability strings, and as keychain
/// account components — keep the alphabet small so all three agree.
pub fn valid_secret_key(key: &str) -> bool {
    !key.is_empty()
        && key.len() <= 64
        && key
            .chars()
            .all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '_' || c == '-')
}

fn keychain_account(bundle: &str, key: &str) -> String {
    format!("{bundle}/{key}")
}

// ─── keychain CRUD ───────────────────────────────────────────────────

pub fn secret_set(bundle: &str, key: &str, value: &str) -> Result<(), String> {
    if !valid_secret_key(key) {
        return Err(format!("invalid secret key `{key}`"));
    }
    if value.is_empty() {
        return Err("secret value is empty".into());
    }
    if value.len() > MAX_SECRET_LEN {
        return Err(format!("secret value exceeds {MAX_SECRET_LEN} bytes"));
    }
    crate::secret_store::set(KEYCHAIN_SERVICE, &keychain_account(bundle, key), value)
}

pub fn secret_exists(bundle: &str, key: &str) -> Result<bool, String> {
    Ok(secret_load(bundle, key)?.is_some())
}

pub fn secret_delete(bundle: &str, key: &str) -> Result<(), String> {
    // Idempotent — `secret_store::delete` no-ops on an absent slot.
    crate::secret_store::delete(KEYCHAIN_SERVICE, &keychain_account(bundle, key))
}

/// Crate-private on purpose: the only consumers are the interpolators
/// below. Nothing outside this module should hold a secret value.
fn secret_load(bundle: &str, key: &str) -> Result<Option<String>, String> {
    crate::secret_store::get(KEYCHAIN_SERVICE, &keychain_account(bundle, key))
}

/// Resolve a single secret value for host-side injection — the
/// `net.fetch` credential seam. Same fail-closed contract as env
/// interpolation: the manifest must grant `secrets:<key>` or this errors
/// before the keychain is consulted. The returned value is attached to
/// an outbound request HOST-SIDE and is never returned across the bridge
/// to the sandbox. `secret_load` stays crate-private; this is the one
/// sanctioned door the network proxy uses.
pub fn resolve_injected_secret(
    bundle: &str,
    caps: &CapabilitySet,
    key: &str,
) -> Result<String, String> {
    if !valid_secret_key(key) {
        return Err(format!("invalid secret key `{key}`"));
    }
    if !caps.allows("secrets", key, None) {
        return Err(format!(
            "manifest does not declare capability `secrets:{key}`"
        ));
    }
    match secret_load(bundle, key)? {
        Some(val) => Ok(val),
        None => Err(format!(
            "secret `{key}` for {bundle} is not set — add it in Settings → Plugins"
        )),
    }
}

// ─── reference parsing + interpolation ───────────────────────────────

/// Collect every `${secrets:<key>}` reference inside a single env
/// value. Malformed references (unterminated, bad key alphabet) are
/// errors — fail closed rather than spawn a child with a literal
/// `${secrets:…}` in its environment.
pub fn find_secret_refs(value: &str) -> Result<Vec<String>, String> {
    let mut out = Vec::new();
    let mut rest = value;
    while let Some(start) = rest.find("${secrets:") {
        let after = &rest[start + "${secrets:".len()..];
        let Some(end) = after.find('}') else {
            return Err("unterminated ${secrets:…} reference".into());
        };
        let key = &after[..end];
        if !valid_secret_key(key) {
            return Err(format!("invalid secret key in reference: `{key}`"));
        }
        out.push(key.to_string());
        rest = &after[end + 1..];
    }
    Ok(out)
}

/// Replace every `${secrets:<key>}` in `value` using `resolve`. Pure —
/// the keychain enters only via the closure, so tests don't touch the
/// OS credential store.
pub fn interpolate_value(
    value: &str,
    resolve: &mut impl FnMut(&str) -> Result<String, String>,
) -> Result<String, String> {
    let mut out = String::with_capacity(value.len());
    let mut rest = value;
    while let Some(start) = rest.find("${secrets:") {
        out.push_str(&rest[..start]);
        let after = &rest[start + "${secrets:".len()..];
        let Some(end) = after.find('}') else {
            return Err("unterminated ${secrets:…} reference".into());
        };
        let key = &after[..end];
        if !valid_secret_key(key) {
            return Err(format!("invalid secret key in reference: `{key}`"));
        }
        out.push_str(&resolve(key)?);
        rest = &after[end + 1..];
    }
    out.push_str(rest);
    Ok(out)
}

/// Resolve a full env map for spawning: every `${secrets:<key>}`
/// reference must (a) be covered by the manifest capability
/// `secrets:<key>` and (b) have a value in the keychain under this
/// bundle. Either failure aborts the spawn with an error naming the
/// key — never spawn with silently-empty credentials.
pub fn interpolate_env(
    bundle: &str,
    caps: &CapabilitySet,
    env: &BTreeMap<String, String>,
) -> Result<HashMap<String, String>, String> {
    let mut cache: HashMap<String, String> = HashMap::new();
    let mut out = HashMap::with_capacity(env.len());
    for (k, v) in env {
        let mut resolve = |key: &str| -> Result<String, String> {
            if !caps.allows("secrets", key, None) {
                return Err(format!(
                    "env references ${{secrets:{key}}} but the manifest does not declare capability `secrets:{key}`"
                ));
            }
            if let Some(hit) = cache.get(key) {
                return Ok(hit.clone());
            }
            match secret_load(bundle, key)? {
                Some(val) => {
                    cache.insert(key.to_string(), val.clone());
                    Ok(val)
                }
                None => Err(format!(
                    "secret `{key}` for {bundle} is not set — add it in Settings → Plugins"
                )),
            }
        };
        out.insert(k.clone(), interpolate_value(v, &mut resolve)?);
    }
    Ok(out)
}

// ─── tests ───────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::PathBuf;

    #[test]
    fn bundle_id_takes_last_two_components() {
        let p = PathBuf::from("/Users/x/.aura/plugins/@aura-demo/linear");
        assert_eq!(
            bundle_id_from_install_dir(&p).as_deref(),
            Some("@aura-demo/linear")
        );
        assert_eq!(bundle_id_from_install_dir(Path::new("/")), None);
    }

    #[test]
    fn secret_key_alphabet() {
        assert!(valid_secret_key("linear_api_token"));
        assert!(valid_secret_key("token-2"));
        assert!(!valid_secret_key(""));
        assert!(!valid_secret_key("UPPER"));
        assert!(!valid_secret_key("has space"));
        assert!(!valid_secret_key("dotted.key"));
        assert!(!valid_secret_key(&"x".repeat(65)));
    }

    #[test]
    fn finds_all_refs() {
        let refs = find_secret_refs("a ${secrets:one} b ${secrets:two}").unwrap();
        assert_eq!(refs, vec!["one".to_string(), "two".to_string()]);
        assert!(find_secret_refs("plain value").unwrap().is_empty());
    }

    #[test]
    fn rejects_malformed_refs() {
        assert!(find_secret_refs("${secrets:open").is_err());
        assert!(find_secret_refs("${secrets:BAD}").is_err());
        assert!(find_secret_refs("${secrets:}").is_err());
    }

    #[test]
    fn interpolates_with_resolver() {
        let mut resolve =
            |key: &str| -> Result<String, String> { Ok(format!("<{key}>")) };
        let got =
            interpolate_value("Bearer ${secrets:tok} end", &mut resolve).unwrap();
        assert_eq!(got, "Bearer <tok> end");
        // No refs → passthrough untouched.
        assert_eq!(
            interpolate_value("plain", &mut resolve).unwrap(),
            "plain"
        );
    }

    #[test]
    fn interpolation_propagates_resolver_error() {
        let mut resolve =
            |_: &str| -> Result<String, String> { Err("missing".into()) };
        assert!(interpolate_value("${secrets:tok}", &mut resolve).is_err());
    }

    #[test]
    fn env_interpolation_requires_capability() {
        let caps = CapabilitySet::from_manifest_strings(&[
            "net:fetch:api.linear.app".to_string(),
        ])
        .unwrap();
        let mut env = BTreeMap::new();
        env.insert("TOKEN".to_string(), "${secrets:linear_token}".to_string());
        let err = interpolate_env("@a/b", &caps, &env).unwrap_err();
        assert!(err.contains("secrets:linear_token"), "{err}");
    }

    #[test]
    fn env_without_refs_skips_keychain_entirely() {
        // No capability needed, no keychain hit — plain values pass.
        let caps = CapabilitySet::new();
        let mut env = BTreeMap::new();
        env.insert("MODE".to_string(), "production".to_string());
        let got = interpolate_env("@a/b", &caps, &env).unwrap();
        assert_eq!(got.get("MODE").map(String::as_str), Some("production"));
    }
}
