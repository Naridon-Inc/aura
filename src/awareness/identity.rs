//! Per-actor signing identity for awareness events (M3a). Reuses the
//! `aura-attestation` Ed25519 primitives. The 32-byte seed lives at
//! `.aura/awareness/identity.key` (written 0600 on unix by aura-attestation);
//! losing the seed loses the identity. The public `key_id`
//! (`did:aura:key/...`) is the stable, shareable handle for this actor — the
//! same primitive that will later anchor sovereign canonical refs (M4).

use std::path::PathBuf;

use aura_attestation::SigningKey;
use colored::Colorize;

fn key_path() -> PathBuf {
    PathBuf::from(".aura").join("awareness").join("identity.key")
}

/// `aura identity` — show the repo-local signing identity used to sign awareness
/// events. Creates one on first call (same as the emit path), so a fresh repo
/// gets a stable handle immediately.
pub fn run_show(json: bool) {
    let path = key_path();
    let kid = key_id();

    if json {
        let data = serde_json::json!({
            "key_id": kid,
            "key_path": path.display().to_string(),
            "exists": kid.is_some(),
        });
        println!("{}", data);
        return;
    }

    println!();
    println!("  {}", "🔑 Awareness Identity".bold());
    println!("  {}", "─".repeat(46).dimmed());
    match kid {
        Some(k) => {
            println!("  {}  {}", "id  ".dimmed(), k.green().bold());
            println!("  {}  {}", "key ".dimmed(), path.display().to_string().dimmed());
            println!(
                "  {}",
                "signs every `aura radar emit` so events can't be spoofed".dimmed()
            );
        }
        None => {
            println!(
                "  {}  {}",
                "✗".red(),
                "no identity — keystore could not be created".red()
            );
            println!(
                "  {}",
                "events still emit, just unsigned (awareness degrades gracefully)".dimmed()
            );
        }
    }
    println!();
}

/// Load the repo-local signing identity, creating one on first use. Returns
/// `None` if the keystore can't be read or created — in that case events are
/// still emitted, just unsigned, so awareness degrades gracefully.
pub fn load() -> Option<SigningKey> {
    aura_attestation::load_or_create(&key_path()).ok()
}

/// The stable identity string for this repo-local key (`did:aura:key/...`),
/// or `None` if no identity is available.
pub fn key_id() -> Option<String> {
    load().map(|k| k.key_id())
}
