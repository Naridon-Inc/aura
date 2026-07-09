//! Mode registry — the unified view the UI consumes.
//!
//! Merges three sources:
//!
//! 1. **Bundled defaults** — `architect.yaml`, `code.yaml`, `debug.yaml`
//!    embedded at compile time from `aura-shell/resources/modes/`. These
//!    are always present; uninstall is disabled in the UI.
//! 2. **User-installed YAMLs** — `~/.aura/modes/*.yaml`. Overrides
//!    bundled defaults when slugs collide (a user can ship their own
//!    `code.yaml` and the bundled one steps aside).
//! 3. **Disabled flags** — read from `<slug>.meta.json`. A disabled
//!    mode appears in the registry but `enabled=false` so the picker
//!    can hide it without losing the install.
//!
//! Callers (composer chip, marketplace pane, MCP `aura_modes_list`) get
//! a stable, sorted list of `ModeDescriptor` rows that mirror the YAML
//! schema 1:1 plus a few derived fields (`bundled`, `installed`).

use serde::Serialize;

use super::ModesError;
use super::schema::Mode;
use super::storage::{ModeMeta, list_slugs, load_meta, load_mode};
use super::validate::validate;

/// Bundled default — name + raw YAML bytes from `resources/modes/`.
/// Lives at compile time so an uninstall of `architect.yaml` from
/// `~/.aura/modes/` still leaves the default available.
struct Bundled {
    id: &'static str,
    yaml: &'static str,
}

const BUNDLED_MODES: &[Bundled] = &[
    Bundled {
        id: "architect",
        yaml: include_str!("../../../../resources/modes/architect.yaml"),
    },
    Bundled {
        id: "code",
        yaml: include_str!("../../../../resources/modes/code.yaml"),
    },
    Bundled {
        id: "debug",
        yaml: include_str!("../../../../resources/modes/debug.yaml"),
    },
];

/// UI-facing row. Adds `bundled` (cannot uninstall), `installed` (has
/// `<slug>.yaml` on disk), and lifts the `enabled`/`used` bits up from
/// the meta sidecar so the React picker doesn't need a second round-trip.
#[derive(Debug, Clone, Serialize)]
pub struct ModeDescriptor {
    #[serde(flatten)]
    pub mode: Mode,
    pub bundled: bool,
    pub installed: bool,
    pub enabled: bool,
    pub used: bool,
    /// Where the YAML came from. `bundled`, `local`, or the install URL.
    pub source: String,
    /// blake3 pin. Empty for bundled / local modes.
    pub pin_blake3: String,
    /// Unix timestamp of install. 0 for bundled.
    pub installed_at: u64,
}

/// Snapshot the registry. Sources are read fresh each call — the dataset
/// is small (≤dozens of modes) and writes are rare, so caching would
/// add invalidation complexity for negligible win.
pub fn descriptors() -> Result<Vec<ModeDescriptor>, ModesError> {
    let mut out: Vec<ModeDescriptor> = Vec::new();
    let mut seen: std::collections::HashSet<String> = std::collections::HashSet::new();

    // 1. installed modes — overrides bundled defaults of the same slug.
    let slugs = list_slugs().unwrap_or_default();
    for slug in &slugs {
        match load_mode(slug) {
            Ok(Some((mode, meta))) => {
                seen.insert(slug.clone());
                let bundled = is_bundled_slug(slug);
                let meta = meta.unwrap_or_else(|| ModeMeta::now("local", String::new()));
                out.push(ModeDescriptor {
                    mode,
                    bundled,
                    installed: true,
                    enabled: meta.enabled,
                    used: meta.used,
                    source: meta.source,
                    pin_blake3: meta.pin_blake3,
                    installed_at: meta.installed_at,
                });
            }
            Ok(None) => continue,
            Err(_) => {
                // Validation failure on disk — skip silently here; the
                // marketplace pane shows broken modes via a separate
                // surface so the picker doesn't render half-modes.
                continue;
            }
        }
    }

    // 2. bundled defaults the user hasn't overridden.
    for b in BUNDLED_MODES {
        if seen.contains(b.id) {
            continue;
        }
        let report = validate(b.yaml);
        let Some(mode) = report.mode else { continue };
        // Bundled meta is synthesised — `enabled` defaults to true,
        // `used` looks at any `<slug>.meta.json` on disk so a user who
        // disabled a bundled mode keeps that state.
        let (enabled, used) = match load_meta(b.id) {
            Ok(Some(m)) => (m.enabled, m.used),
            _ => (true, false),
        };
        out.push(ModeDescriptor {
            mode,
            bundled: true,
            installed: false,
            enabled,
            used,
            source: "bundled".into(),
            pin_blake3: String::new(),
            installed_at: 0,
        });
    }

    out.sort_by(|a, b| a.mode.id.cmp(&b.mode.id));
    Ok(out)
}

/// True when `slug` matches a `BUNDLED_MODES` entry.
pub fn is_bundled_slug(slug: &str) -> bool {
    BUNDLED_MODES.iter().any(|b| b.id == slug)
}

/// Return the bundled YAML bytes for a slug. Used by `modes_edit` when
/// the user clicks "Restore default".
pub fn bundled_yaml(slug: &str) -> Option<&'static str> {
    BUNDLED_MODES.iter().find(|b| b.id == slug).map(|b| b.yaml)
}

/// Find a single descriptor by slug. Convenience for `modes_get`-style
/// calls; bundled defaults resolve even without an on-disk install.
pub fn get(slug: &str) -> Result<Option<ModeDescriptor>, ModesError> {
    let all = descriptors()?;
    Ok(all.into_iter().find(|d| d.mode.id == slug))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn bundled_yaml_validates() {
        for b in BUNDLED_MODES {
            let r = validate(b.yaml);
            assert!(
                r.ok,
                "bundled mode `{}` failed validation: {:?}",
                b.id, r.issues
            );
            let m = r.mode.unwrap();
            assert_eq!(m.id, b.id, "bundled YAML id must match constant");
        }
    }
}
