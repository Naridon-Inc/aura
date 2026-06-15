//! Schema migration registry.
//!
//! I5: "Schema evolves via semver + open `extensions`. Breaking changes are
//! major-version bumps and require a registered migration."
//!
//! The [`Migration`] trait + [`MigrationRegistry`] give I5 teeth. Migrations
//! operate on `serde_json::Value` so they can reshape historical envelopes
//! that don't fit the current Rust types. The registry is empty in v1; the
//! pattern is the commitment.

use serde_json::Value;

use crate::{BlockError, SchemaVersion};

/// A single migration that reshapes a [`crate::Block`] envelope from one
/// schema version to another.
pub trait Migration: Send + Sync {
    fn from_version(&self) -> SchemaVersion;
    fn to_version(&self) -> SchemaVersion;
    fn apply(&self, v: Value) -> Result<Value, BlockError>;
}

/// Ordered collection of migrations. Empty in v1. When a v2 ships, a
/// migration `1.x.y → 2.0.0` is registered here; the supervisor calls
/// [`MigrationRegistry::migrate`] before deserializing into the current
/// Rust `Block` type.
pub struct MigrationRegistry {
    migrations: Vec<Box<dyn Migration>>,
}

impl MigrationRegistry {
    pub const fn empty() -> Self {
        Self {
            migrations: Vec::new(),
        }
    }

    pub fn register(&mut self, m: Box<dyn Migration>) {
        self.migrations.push(m);
    }

    /// Apply every migration whose `from_version` matches, in registry
    /// order, until the value is at `target`. Returns an error if there is
    /// no path.
    pub fn migrate(&self, mut v: Value, from: SchemaVersion, target: SchemaVersion) -> Result<Value, BlockError> {
        let mut current = from;
        while current != target {
            let next = self
                .migrations
                .iter()
                .find(|m| m.from_version() == current);
            match next {
                Some(m) => {
                    v = m.apply(v)?;
                    current = m.to_version();
                }
                None => {
                    return Err(BlockError::NoMigrationPath {
                        from: current,
                        to: target,
                    });
                }
            }
        }
        Ok(v)
    }
}

impl Default for MigrationRegistry {
    fn default() -> Self {
        Self::empty()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn empty_registry_noop_when_versions_match() {
        let reg = MigrationRegistry::empty();
        let v = serde_json::json!({"k": 1});
        let out = reg
            .migrate(
                v.clone(),
                SchemaVersion {
                    major: 1,
                    minor: 0,
                    patch: 0,
                },
                SchemaVersion {
                    major: 1,
                    minor: 0,
                    patch: 0,
                },
            )
            .unwrap();
        assert_eq!(out, v);
    }

    #[test]
    fn empty_registry_errors_when_versions_differ() {
        let reg = MigrationRegistry::empty();
        let err = reg
            .migrate(
                serde_json::json!({}),
                SchemaVersion {
                    major: 1,
                    minor: 0,
                    patch: 0,
                },
                SchemaVersion {
                    major: 2,
                    minor: 0,
                    patch: 0,
                },
            )
            .unwrap_err();
        assert!(matches!(err, BlockError::NoMigrationPath { .. }));
    }
}
