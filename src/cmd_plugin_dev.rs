//! `aura plugin <new|link|keygen|sign|verify|trust>` — developer-side
//! plugin tooling. Scaffolding, dev-install via symlink, and the
//! ed25519 signing workflow backed by `aura-plugin-sign` (the SAME
//! crate the desktop shell verifies with, so a bundle that verifies
//! here verifies there byte-for-byte).
//!
//! Split from `cmd_plugin_marketplace.rs` deliberately: that file is
//! the read/toggle side every user touches; this one is the publisher
//! side. Keeping them apart keeps both small.
//!
//! Key material:
//! - signing key:  `~/.aura/plugin-signing.key` (0600, auto-created by
//!   `keygen`; same keyfile format as aura-attestation block keys)
//! - trust store:  `~/.aura/plugin-trust.json` — OUTSIDE the plugin
//!   install root so a bundle install can never smuggle a key into the
//!   store it is judged against.

use std::path::{Path, PathBuf};

use aura_attestation::keyfile;
use aura_attestation::keys::VerifyingKey;
use aura_plugin_sign::{sign_bundle, verify_bundle, SignatureStatus, TrustStore};
use base64::Engine;
use colored::Colorize;

// ─── paths ──────────────────────────────────────────────────────────

fn signing_key_path() -> PathBuf {
    if let Ok(home) = std::env::var("HOME") {
        return PathBuf::from(home).join(".aura").join("plugin-signing.key");
    }
    PathBuf::from(".aura/plugin-signing.key")
}

// ─── keygen / trust ─────────────────────────────────────────────────

/// `aura plugin keygen --publisher <label>` — create (or reuse) the dev
/// signing key and register its public half in the local trust store so
/// your own bundles show as Verified in your own shell.
pub fn keygen(publisher: &str) -> Result<(), Box<dyn std::error::Error>> {
    let path = signing_key_path();
    let existed = path.exists();
    let key = keyfile::load_or_create(&path)?;

    let trust_path = TrustStore::default_path();
    let mut store = TrustStore::load(&trust_path)?;
    let entry = store.add_key(&key.verifying_key(), publisher);
    store.save(&trust_path)?;

    let verb = if existed { "reusing" } else { "generated" };
    println!("{} signing key at {}", verb.bold(), path.display());
    println!("  key id:     {}", entry.key_id.cyan());
    println!("  publisher:  {publisher}");
    println!("  public key: {}", entry.public_key_b64);
    println!(
        "{}",
        "trusted locally — your signed bundles verify on this machine.".dimmed()
    );
    println!(
        "{}",
        "share the key id + public key with teammates: aura plugin trust --publisher <you> --public-key <b64>"
            .dimmed()
    );
    Ok(())
}

/// `aura plugin trust --publisher <label> --public-key <b64>` — add a
/// teammate's (or marketplace's) public key to the local trust store.
pub fn trust(publisher: &str, public_key_b64: &str) -> Result<(), Box<dyn std::error::Error>> {
    let bytes = base64::engine::general_purpose::STANDARD
        .decode(public_key_b64)
        .map_err(|e| format!("public key is not valid base64: {e}"))?;
    let arr: [u8; 32] = bytes
        .try_into()
        .map_err(|_| "public key must decode to exactly 32 bytes (ed25519)")?;
    let key = VerifyingKey::from_bytes(&arr).map_err(|e| format!("invalid ed25519 key: {e}"))?;

    let trust_path = TrustStore::default_path();
    let mut store = TrustStore::load(&trust_path)?;
    let entry = store.add_key(&key, publisher);
    store.save(&trust_path)?;

    println!(
        "{} {} ({})",
        "trusted".bold().green(),
        publisher,
        entry.key_id.cyan()
    );
    Ok(())
}

// ─── sign / verify ──────────────────────────────────────────────────

/// `aura plugin sign <dir>` — digest the bundle and embed an ed25519
/// signature into its aura.plugin.json. Requires a prior `keygen`.
pub fn sign(dir: &Path) -> Result<(), Box<dyn std::error::Error>> {
    let key_path = signing_key_path();
    if !key_path.exists() {
        return Err(format!(
            "no signing key at {} — run `aura plugin keygen --publisher <you>` first",
            key_path.display()
        )
        .into());
    }
    let key = keyfile::load_or_create(&key_path)?;
    sign_bundle(dir, &key)?;
    println!(
        "{} {} ({})",
        "signed".bold().green(),
        dir.display(),
        key.key_id().cyan()
    );
    Ok(())
}

/// `aura plugin verify <dir>` — verify a bundle exactly the way the
/// desktop shell will at scan time. Exits non-zero on `Invalid` so CI
/// can gate on it.
pub fn verify(dir: &Path) -> Result<(), Box<dyn std::error::Error>> {
    let store = TrustStore::load(&TrustStore::default_path())?;
    match verify_bundle(dir, &store) {
        SignatureStatus::Verified {
            publisher,
            publisher_key_id,
        } => {
            println!(
                "{} signed by {} ({})",
                "verified".bold().green(),
                publisher.bold(),
                publisher_key_id.cyan()
            );
            Ok(())
        }
        SignatureStatus::UnknownKey { publisher_key_id } => {
            println!(
                "{} signed with {} — key not in this machine's trust store",
                "unverified".bold().yellow(),
                publisher_key_id.cyan()
            );
            println!(
                "{}",
                "add it with: aura plugin trust --publisher <name> --public-key <b64>".dimmed()
            );
            Ok(())
        }
        SignatureStatus::Unsigned => {
            println!("{} bundle carries no signature", "unsigned".bold().yellow());
            Ok(())
        }
        SignatureStatus::Invalid { reason } => {
            Err(format!("signature INVALID: {reason} — the shell will refuse to load this bundle").into())
        }
    }
}

// ─── new (scaffold) ─────────────────────────────────────────────────

/// `aura plugin new @scope/name` — scaffold a minimal working bundle in
/// `./name`: manifest + raw-bridge worker + README. Mirrors the
/// shape of `aura-shell/examples/plugins/@aura/hello-world`.
pub fn scaffold(id: &str) -> Result<(), Box<dyn std::error::Error>> {
    let (scope, name) = split_id(id)?;
    let dir = PathBuf::from(name);
    if dir.exists() {
        return Err(format!("./{name} already exists — refusing to overwrite").into());
    }
    std::fs::create_dir_all(&dir)?;

    let manifest = format!(
        r#"{{
  "schema": "https://aura.dev/schemas/plugin@1",
  "id": "{id}",
  "name": "{title}",
  "version": "0.1.0",
  "publisher": "{publisher}",
  "engines": {{ "aura": ">=0.17.0" }},
  "description": "Describe what {id} does.",
  "entry": "worker.js",
  "capabilities": ["ui:toast"],
  "activationEvents": ["onStartup"],
  "contributes": {{
    "slashCommands": [
      {{
        "id": "{name}",
        "title": "{title}",
        "description": "Say hello from {id}"
      }}
    ]
  }}
}}
"#,
        title = humanize(name),
        publisher = scope.trim_start_matches('@'),
    );
    std::fs::write(dir.join("aura.plugin.json"), manifest)?;

    let worker = format!(
        r#"// {id} — logic sandbox (the manifest `entry`).
//
// Runs as a blob Worker against the raw Aura bridge protocol: no DOM,
// no Tauri IPC — postMessage to the host is the only channel, and
// every call is checked against the capabilities in aura.plugin.json.

const V = 1; // BRIDGE_PROTOCOL_VERSION

let nextId = 1;
const pending = new Map();

function call(method, args, target) {{
  return new Promise((resolve, reject) => {{
    const id = String(nextId++);
    pending.set(id, {{ resolve, reject }});
    self.postMessage({{ v: V, kind: "call", id, method, target, args }});
  }});
}}

self.onmessage = (ev) => {{
  const env = ev.data;
  if (!env || typeof env !== "object") return;

  if (env.kind === "handshake/hello") {{
    self.postMessage({{
      v: V,
      kind: "handshake/ready",
      pluginId: "{id}",
      sdkVersion: "0.1.0-raw",
    }});
    return;
  }}

  if (env.kind === "result") {{
    const p = pending.get(env.id);
    if (!p) return;
    pending.delete(env.id);
    if (env.ok) p.resolve(env.value);
    else p.reject(new Error(env.error?.message ?? "call failed"));
    return;
  }}

  if (env.kind === "event" && env.event === "slash/{name}") {{
    call("ui.toast", {{ message: "Hello from {id}!" }}).catch(() => {{}});
  }}
}};
"#
    );
    std::fs::write(dir.join("worker.js"), worker)?;

    let readme = format!(
        r#"# {title}

An Aura plugin. Scaffolded by `aura plugin new {id}`.

## Develop

```sh
aura plugin link .          # symlink into ~/.aura/plugins for live testing
aura plugin list            # confirm it scanned
```

Then toggle it on under Settings → Plugins in the Aura desktop app
(or just relaunch — new plugins default to enabled).

## Ship

```sh
aura plugin keygen --publisher {publisher}   # once per machine
aura plugin sign .                           # embeds the signature in aura.plugin.json
aura plugin verify .                         # what the shell will conclude at scan
```

Capabilities are declared in `aura.plugin.json` and enforced by the
host — the worker can only do what it declares. The signature covers
every file in the bundle, so any post-sign edit (including capability
changes) invalidates it.
"#,
        title = humanize(name),
        publisher = scope.trim_start_matches('@'),
    );
    std::fs::write(dir.join("README.md"), readme)?;

    println!("{} ./{name}", "scaffolded".bold().green());
    println!("  {}", dir.join("aura.plugin.json").display());
    println!("  {}", dir.join("worker.js").display());
    println!("  {}", dir.join("README.md").display());
    println!(
        "{}",
        format!("next: cd {name} && aura plugin link .").dimmed()
    );
    Ok(())
}

// ─── link (dev install) ─────────────────────────────────────────────

/// `aura plugin link <dir>` — symlink a working tree into the install
/// root (`~/.aura/plugins/<scope>/<name>`) so the shell scans it live.
/// Edits in the source dir show up on the next rescan — no copying.
pub fn link(dir: &Path, install_root: &Path) -> Result<(), Box<dyn std::error::Error>> {
    let src = dir
        .canonicalize()
        .map_err(|e| format!("{}: {e}", dir.display()))?;
    let id = read_bundle_id(&src)?;
    let (scope, name) = split_id(&id)?;

    let scope_dir = install_root.join(scope);
    std::fs::create_dir_all(&scope_dir)?;
    let dest = scope_dir.join(name);

    match std::fs::symlink_metadata(&dest) {
        Ok(meta) if meta.file_type().is_symlink() => {
            let current = std::fs::read_link(&dest)?;
            if current == src {
                println!("{} already linked → {}", "ok".bold().green(), src.display());
                return Ok(());
            }
            // Re-point an existing dev link; never touch a real install.
            std::fs::remove_file(&dest)?;
        }
        Ok(_) => {
            return Err(format!(
                "{} exists and is not a symlink — a real install lives there; uninstall it first",
                dest.display()
            )
            .into());
        }
        Err(_) => {}
    }

    #[cfg(unix)]
    std::os::unix::fs::symlink(&src, &dest)?;
    #[cfg(not(unix))]
    return Err("plugin link requires a unix-like OS (symlinks)".into());

    println!(
        "{} {} → {}",
        "linked".bold().green(),
        dest.display(),
        src.display()
    );
    println!("{}", "the shell picks it up on next launch or rescan".dimmed());
    Ok(())
}

// ─── helpers ────────────────────────────────────────────────────────

/// Pull the bundle id out of whichever manifest the dir carries —
/// plugin first, then skill, then MCP (same precedence as the shell).
fn read_bundle_id(dir: &Path) -> Result<String, Box<dyn std::error::Error>> {
    for filename in ["aura.plugin.json", "aura.skill.json", "aura.mcp.json"] {
        let path = dir.join(filename);
        let Ok(raw) = std::fs::read_to_string(&path) else {
            continue;
        };
        let v: serde_json::Value =
            serde_json::from_str(&raw).map_err(|e| format!("{}: {e}", path.display()))?;
        if let Some(id) = v.get("id").and_then(|i| i.as_str()) {
            return Ok(id.to_string());
        }
    }
    Err(format!(
        "no aura.plugin.json / aura.skill.json / aura.mcp.json with an `id` under {}",
        dir.display()
    )
    .into())
}

/// `@scope/name` → ("@scope", "name"). The install layout and the
/// secrets namespace both key off this shape, so enforce it early.
fn split_id(id: &str) -> Result<(&str, &str), Box<dyn std::error::Error>> {
    let Some((scope, name)) = id.split_once('/') else {
        return Err(format!("plugin id `{id}` must look like @scope/name").into());
    };
    if !scope.starts_with('@') || scope.len() < 2 {
        return Err(format!("plugin id `{id}` must start with an @scope").into());
    }
    if name.is_empty()
        || !name
            .chars()
            .all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '-')
    {
        return Err(format!(
            "plugin name `{name}` must be lowercase kebab-case (a-z, 0-9, -)"
        )
        .into());
    }
    Ok((scope, name))
}

fn humanize(name: &str) -> String {
    name.split('-')
        .map(|w| {
            let mut c = w.chars();
            match c.next() {
                Some(f) => f.to_uppercase().collect::<String>() + c.as_str(),
                None => String::new(),
            }
        })
        .collect::<Vec<_>>()
        .join(" ")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn split_id_accepts_scoped_kebab() {
        assert_eq!(split_id("@acme/my-tool").unwrap(), ("@acme", "my-tool"));
    }

    #[test]
    fn split_id_rejects_unscoped_and_bad_names() {
        assert!(split_id("acme/tool").is_err());
        assert!(split_id("@acme").is_err());
        assert!(split_id("@acme/Tool").is_err());
        assert!(split_id("@acme/").is_err());
    }

    #[test]
    fn humanize_title_cases_kebab() {
        assert_eq!(humanize("my-cool-tool"), "My Cool Tool");
    }

    #[test]
    fn scaffold_manifest_parses_and_signs() {
        let tmp = tempfile::tempdir().unwrap();
        let cwd = std::env::current_dir().unwrap();
        std::env::set_current_dir(tmp.path()).unwrap();
        let result = scaffold("@test/scaffolded");
        std::env::set_current_dir(cwd).unwrap();
        result.unwrap();

        let dir = tmp.path().join("scaffolded");
        let raw = std::fs::read_to_string(dir.join("aura.plugin.json")).unwrap();
        let v: serde_json::Value = serde_json::from_str(&raw).unwrap();
        assert_eq!(v["id"], "@test/scaffolded");
        assert_eq!(v["entry"], "worker.js");

        // The scaffold must be signable + verifiable out of the box.
        let key = aura_attestation::keys::SigningKey::generate();
        sign_bundle(&dir, &key).unwrap();
        let mut store = TrustStore::default();
        store.add_key(&key.verifying_key(), "test");
        assert!(matches!(
            verify_bundle(&dir, &store),
            SignatureStatus::Verified { .. }
        ));
    }

    #[test]
    fn link_refuses_real_directory_install() {
        let tmp = tempfile::tempdir().unwrap();
        let src = tmp.path().join("src");
        std::fs::create_dir_all(&src).unwrap();
        std::fs::write(
            src.join("aura.plugin.json"),
            r#"{"id": "@t/x", "version": "0.1.0", "entry": "worker.js"}"#,
        )
        .unwrap();
        let root = tmp.path().join("root");
        // Simulate a REAL (non-symlink) install at the destination.
        std::fs::create_dir_all(root.join("@t").join("x")).unwrap();
        assert!(link(&src, &root).is_err());
    }

    #[test]
    fn link_creates_and_repoints_symlink() {
        let tmp = tempfile::tempdir().unwrap();
        let src = tmp.path().join("src");
        std::fs::create_dir_all(&src).unwrap();
        std::fs::write(
            src.join("aura.plugin.json"),
            r#"{"id": "@t/x", "version": "0.1.0", "entry": "worker.js"}"#,
        )
        .unwrap();
        let root = tmp.path().join("root");
        link(&src, &root).unwrap();
        let dest = root.join("@t").join("x");
        assert_eq!(std::fs::read_link(&dest).unwrap(), src.canonicalize().unwrap());
        // Idempotent re-link.
        link(&src, &root).unwrap();
    }
}
