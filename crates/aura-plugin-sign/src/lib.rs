//! aura-plugin-sign — bundle digest + ed25519 signing/verification +
//! publisher trust store for Aura plugin bundles.
//!
//! This crate is the SINGLE source of truth for what a plugin-bundle
//! signature covers. Both consumers depend on it so the bytes can never
//! drift:
//!
//!   - `aura-shell/src-tauri` verifies at registry-scan time and
//!     rejects tampered bundles (fail closed);
//!   - `aura-cli` signs (`aura plugin sign`), verifies
//!     (`aura plugin verify`), and manages the trust store
//!     (`aura plugin keygen` / `trust`).
//!
//! ## Digest v1 (`aura-plugin-digest-v1`)
//!
//! ```text
//! sha256(
//!   "aura-plugin-digest-v1\n"
//!   "manifest\0" + canonical_json(aura.plugin.json minus /signature) + "\0"
//!   for each file, sorted by relpath ('/' separators, byte order):
//!     relpath + "\0" + hex(sha256(file bytes)) + "\0"
//! )
//! ```
//!
//! The file walk covers every regular file under the bundle directory
//! recursively, EXCLUDING `aura.plugin.json` itself (it is covered by
//! the canonical-manifest leg so the embedded signature can't be
//! circular), any path component starting with `.` (`.git`,
//! `.DS_Store`, …), and symlinks (a link pointing outside the bundle
//! must never extend the signed surface). Everything else — worker
//! scripts, panels, `aura.mcp.json`, `aura.skill.json`, vendored deps —
//! is covered, so editing ANY executable byte of a signed bundle
//! invalidates it.
//!
//! The ed25519 signature is over the 32-byte digest. Key generation,
//! key ids (`did:aura:key/<b64url-first-8>`), and 0600 keyfiles come
//! from `aura-attestation` — the same primitives Aura uses for block
//! provenance.

pub mod bundle;
pub mod canonical;
pub mod digest;
pub mod trust;

pub use bundle::{sign_bundle, verify_bundle, SignError, SignatureStatus, ED25519_ALGORITHM};
pub use canonical::canonical_json;
pub use digest::{bundle_digest, DIGEST_VERSION};
pub use trust::{TrustStore, TrustedKey};
