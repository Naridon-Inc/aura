//! `aura repo-id` — mint and inspect this repo's Aura-native identity.
//!
//! A repo's cloud identity (its `room_id`) has historically been derived from
//! the GitHub origin URL, which chains the repo to a GitHub name. `aura repo-id
//! init` mints a stable, self-signed **UUID** for the repo and writes it to a
//! committed `.aura/repo.json`; from then on the repo's identity travels with
//! the repo regardless of where it is hosted (GitHub, GitLab, a self-hosted
//! `aura` node, or nowhere at all).
//!
//! The `room_id` is derived from the UUID — `hex(sha256("aura://repo/" + uuid))`
//! — so it stays a plain 64-hex value that the cloud and desktop already
//! accept, but is now anchored to the Aura UUID instead of the forge name. The
//! whole manifest is signed by the repo-local Ed25519 identity (the same key
//! that signs radar events and `aura refs`), so it is tamper-evident and
//! verifiable by anyone holding only the file. See
//! `aura_attestation::repo_identity` for the manifest + verification.

use aura_attestation::{RepoIdentityManifest, ROOM_ID_DOMAIN};
use clap::Subcommand;
use colored::Colorize;
use git2::Repository;
use sha2::{Digest, Sha256};

use crate::refs_sign::identity_key_path;

#[derive(Subcommand)]
pub enum RepoIdSubcommands {
    /// Mint this repo's Aura-native identity and write it to
    /// `.aura/repo.json`. Idempotent: an already-initialized, verifying repo
    /// is left untouched unless `--force` re-mints a fresh UUID.
    Init {
        /// Re-mint a brand-new UUID even if a valid manifest already exists.
        /// Changes the repo's room_id — the team must re-pull the new file.
        #[arg(long)]
        force: bool,
        #[arg(long)]
        json: bool,
    },
    /// Show and verify this repo's Aura-native identity.
    Show {
        #[arg(long)]
        json: bool,
    },
}

pub fn run(sub: &RepoIdSubcommands) -> Result<(), Box<dyn std::error::Error>> {
    match sub {
        RepoIdSubcommands::Init { force, json } => run_init(*force, *json),
        RepoIdSubcommands::Show { json } => run_show(*json),
    }
}

/// Derive the cloud `room_id` from a repo UUID. Kept identical to the
/// desktop shell's derivation (`aura_attestation::ROOM_ID_DOMAIN`) so a repo
/// resolves to the same room from the CLI and the app.
pub fn room_id_for_uuid(uuid: &str) -> String {
    let mut hasher = Sha256::new();
    hasher.update(ROOM_ID_DOMAIN.as_bytes());
    hasher.update(uuid.as_bytes());
    hex::encode(hasher.finalize())
}

/// Open the repo at the current directory (walking up to the work tree root).
fn open_repo() -> Result<Repository, Box<dyn std::error::Error>> {
    Repository::discover(".").map_err(|e| {
        format!("not inside a git repository ({e}) — `aura repo-id` needs a git work tree").into()
    })
}

fn workdir(repo: &Repository) -> Result<std::path::PathBuf, Box<dyn std::error::Error>> {
    repo.workdir()
        .map(|w| w.to_path_buf())
        .ok_or_else(|| "bare repositories have no work tree to hold .aura/repo.json".into())
}

fn run_init(force: bool, json: bool) -> Result<(), Box<dyn std::error::Error>> {
    let repo = open_repo()?;
    let root = workdir(&repo)?;

    // Idempotency: a valid, signed manifest is left alone unless --force.
    if !force {
        if let Some(existing) = RepoIdentityManifest::read(&root)? {
            if existing.is_signed() {
                match existing.verify() {
                    Ok(_) => {
                        emit_manifest("already-initialized", &existing, json);
                        return Ok(());
                    }
                    Err(e) => {
                        // A present-but-broken manifest is a real problem; don't
                        // silently overwrite it — make the operator choose.
                        return Err(format!(
                            "existing .aura/repo.json fails verification: {e}. \
                             Re-mint with `aura repo-id init --force` (changes the room_id) \
                             or restore the correct file.",
                        )
                        .into());
                    }
                }
            }
            // A legacy room_id-only manifest: adopt it by upgrading in place —
            // keep its room_id, but a signed UUID cannot be back-derived from a
            // bare room_id, so we mint a fresh UUID and re-point the room_id.
            // (Communicated below so the operator knows the room changes.)
        }
    }

    // The repo-local Ed25519 identity signs the manifest. Reuse the same key
    // `aura identity` / radar / `aura refs` use; create it on first init so
    // `aura repo-id init` works standalone.
    let key_path = identity_key_path(&repo);
    let key = aura_attestation::load_or_create(&key_path)
        .map_err(|e| format!("could not load or create repo identity at {}: {e}", key_path.display()))?;

    let uuid = uuid::Uuid::now_v7().to_string();
    let room_id = room_id_for_uuid(&uuid);
    let created_at = chrono::Utc::now().to_rfc3339();
    let manifest = RepoIdentityManifest::sign_new(&uuid, &room_id, &created_at, &key);
    // Verify what we just wrote before persisting it.
    manifest.verify()?;
    manifest.write(&root)?;

    emit_manifest("initialized", &manifest, json);
    if !json {
        println!(
            "  {} commit {} so your whole team shares this identity.",
            "→".dimmed(),
            ".aura/repo.json".cyan()
        );
    }
    Ok(())
}

fn run_show(json: bool) -> Result<(), Box<dyn std::error::Error>> {
    let repo = open_repo()?;
    let root = workdir(&repo)?;
    let manifest = match RepoIdentityManifest::read(&root)? {
        Some(m) => m,
        None => {
            if json {
                println!("{}", serde_json::json!({"initialized": false}));
            } else {
                println!(
                    "{} no Aura repo identity yet — run {} to mint one.",
                    "•".yellow(),
                    "aura repo-id init".cyan()
                );
            }
            return Ok(());
        }
    };

    if !manifest.is_signed() {
        if json {
            println!(
                "{}",
                serde_json::json!({
                    "initialized": true,
                    "signed": false,
                    "room_id": manifest.room_id,
                })
            );
        } else {
            println!(
                "{} legacy room_id-only override (no signed UUID):",
                "•".yellow()
            );
            println!("    room_id: {}", manifest.room_id);
            println!(
                "  {} run {} to upgrade it to a signed Aura identity.",
                "→".dimmed(),
                "aura repo-id init".cyan()
            );
        }
        return Ok(());
    }

    let verified = manifest.verify();
    emit_verified(&manifest, &verified, json);
    match verified {
        Ok(_) => Ok(()),
        Err(e) => Err(format!("repo identity failed verification: {e}").into()),
    }
}

fn emit_manifest(state: &str, m: &RepoIdentityManifest, json: bool) {
    if json {
        println!(
            "{}",
            serde_json::json!({
                "state": state,
                "repo_uuid": m.repo_uuid,
                "room_id": m.room_id,
                "signer": m.signer,
                "created_at": m.created_at,
            })
        );
        return;
    }
    let verb = if state == "initialized" {
        "Minted".green().bold()
    } else {
        "Repo identity".cyan().bold()
    };
    println!("{} Aura repo identity ({}):", verb, state.dimmed());
    println!("    uuid:    {}", m.repo_uuid.bold());
    println!("    room_id: {}", m.room_id);
    println!("    signer:  {}", m.signer.dimmed());
    if !m.created_at.is_empty() {
        println!("    minted:  {}", m.created_at.dimmed());
    }
}

fn emit_verified(
    m: &RepoIdentityManifest,
    verified: &Result<aura_attestation::VerifyingKey, aura_attestation::RepoIdentityError>,
    json: bool,
) {
    let ok = verified.is_ok();
    if json {
        println!(
            "{}",
            serde_json::json!({
                "initialized": true,
                "signed": true,
                "verified": ok,
                "repo_uuid": m.repo_uuid,
                "room_id": m.room_id,
                "signer": m.signer,
                "created_at": m.created_at,
            })
        );
        return;
    }
    let badge = if ok {
        "✓ verified".green().bold()
    } else {
        "✗ INVALID".red().bold()
    };
    println!("Aura repo identity  {}", badge);
    println!("    uuid:    {}", m.repo_uuid.bold());
    println!("    room_id: {}", m.room_id);
    println!("    signer:  {}", m.signer.dimmed());
    if !m.created_at.is_empty() {
        println!("    minted:  {}", m.created_at.dimmed());
    }
}
