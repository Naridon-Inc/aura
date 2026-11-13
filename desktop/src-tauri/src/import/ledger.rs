//! What has already been brought over, so a second import adds nothing twice.
//!
//! `~/.aura/imports/ledger.json` maps `<source>/<item key>` to where the item
//! landed in Aura. An entry only counts while that place still exists: a chat
//! the person has since deleted from Aura can be imported again, rather than
//! being reported as done forever.

use std::collections::BTreeMap;
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};

use super::model::ItemKind;

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
pub struct Entry {
    pub kind: ItemKind,
    /// Session id for a chat, a path for a repo/workspace/scripts/rules
    /// item, the server name for MCP.
    pub aura_ref: String,
    /// Epoch seconds of the import.
    pub at: u64,
}

#[derive(Serialize, Deserialize, Clone, Debug, Default)]
pub struct Ledger {
    #[serde(default)]
    pub entries: BTreeMap<String, Entry>,
}

pub fn imports_dir() -> Option<PathBuf> {
    std::env::var_os("HOME").map(|h| PathBuf::from(h).join(".aura").join("imports"))
}

fn ledger_path() -> Option<PathBuf> {
    imports_dir().map(|d| d.join("ledger.json"))
}

fn id(source: &str, key: &str) -> String {
    format!("{source}/{key}")
}

/// Does the place an entry points at still exist?
fn still_there(entry: &Entry) -> bool {
    match entry.kind {
        ItemKind::Chat => std::env::var_os("HOME")
            .map(|h| {
                PathBuf::from(h)
                    .join(".aura")
                    .join("manager-sessions")
                    .join(format!("{}.json", entry.aura_ref))
                    .is_file()
            })
            .unwrap_or(false),
        ItemKind::Mcp => std::env::var_os("HOME")
            .map(|h| {
                PathBuf::from(h)
                    .join(".aura")
                    .join("mcp")
                    .join(format!("{}.json", entry.aura_ref))
                    .is_file()
            })
            .unwrap_or(false),
        ItemKind::Scripts => Path::new(&entry.aura_ref).join(".aura").join("settings.toml").is_file(),
        ItemKind::Rules => Path::new(&entry.aura_ref).join("AGENTS.md").is_file(),
        ItemKind::Repo | ItemKind::Workspace => Path::new(&entry.aura_ref).exists(),
    }
}

impl Ledger {
    pub fn load() -> Self {
        ledger_path()
            .and_then(|p| std::fs::read_to_string(p).ok())
            .and_then(|t| serde_json::from_str(&t).ok())
            .unwrap_or_default()
    }

    /// The entry for this item, if it is still in Aura.
    pub fn done(&self, source: &str, key: &str) -> Option<&Entry> {
        self.entries.get(&id(source, key)).filter(|e| still_there(e))
    }

    /// How many of a source's items are still in Aura. The promo card uses
    /// this: once anything has come over, it stops offering.
    pub fn count(&self, source: &str) -> usize {
        let prefix = format!("{source}/");
        self.entries
            .iter()
            .filter(|(k, e)| k.starts_with(&prefix) && still_there(e))
            .count()
    }

    pub fn record(&mut self, source: &str, key: &str, kind: ItemKind, aura_ref: &str) {
        let at = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_secs())
            .unwrap_or(0);
        self.entries.insert(
            id(source, key),
            Entry {
                kind,
                aura_ref: aura_ref.to_string(),
                at,
            },
        );
    }

    /// Write atomically: a crash mid-save leaves the previous ledger, never a
    /// half-written one that would make every import look new.
    pub fn save(&self) -> Result<(), String> {
        let path = ledger_path().ok_or("HOME not set")?;
        let dir = path.parent().ok_or("no parent")?;
        std::fs::create_dir_all(dir).map_err(|e| format!("create {}: {e}", dir.display()))?;
        let text = serde_json::to_string_pretty(self).map_err(|e| format!("serialize ledger: {e}"))?;
        let tmp = tempfile::NamedTempFile::new_in(dir).map_err(|e| format!("tempfile: {e}"))?;
        std::fs::write(tmp.path(), text).map_err(|e| format!("write ledger: {e}"))?;
        tmp.persist(&path).map_err(|e| format!("save ledger: {e}"))?;
        Ok(())
    }
}
