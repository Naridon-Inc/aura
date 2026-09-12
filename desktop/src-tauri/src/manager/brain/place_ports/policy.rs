//! Whether a place gets its new ports brought over without being asked.
//!
//! Off unless the member turned it on for THIS place. It is recorded per
//! machine, beside the machine book, because it is a decision about one
//! machine: a box running a database and three services is not one whose
//! every port a person wants opening on their Mac, and a box running one dev
//! server is. The book itself is not touched — its rows are an address, a
//! login and a key, and a row that grows a field for every preference is a
//! row every surface has to be taught about.

use std::collections::BTreeMap;
use std::path::PathBuf;

use serde::{Deserialize, Serialize};

/// What a place has asked for.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize, Deserialize)]
pub struct PortsPolicy {
    /// Bring a port over the first time it is seen listening.
    #[serde(default)]
    pub auto_forward: bool,
}

/// Beside the machine book, under the same home.
fn path() -> Result<PathBuf, String> {
    Ok(crate::cloud_session_sync::aura_dir()?.join("machine-ports.json"))
}

fn read_all() -> BTreeMap<String, PortsPolicy> {
    let Ok(p) = path() else {
        return BTreeMap::new();
    };
    let Ok(raw) = std::fs::read_to_string(p) else {
        return BTreeMap::new();
    };
    // A file we cannot read is a file we do not have; the next write rewrites
    // it cleanly, and until then every place is off, which is the default.
    serde_json::from_str(&raw).unwrap_or_default()
}

fn write_all(all: &BTreeMap<String, PortsPolicy>) -> Result<(), String> {
    let p = path()?;
    if let Some(dir) = p.parent() {
        std::fs::create_dir_all(dir).map_err(|e| format!("create {}: {e}", dir.display()))?;
    }
    let body = serde_json::to_string_pretty(all).map_err(|e| e.to_string())?;
    std::fs::write(&p, body).map_err(|e| format!("write {}: {e}", p.display()))
}

/// What this place asked for. Off for a place nobody has said anything about.
pub fn read(machine_id: &str) -> PortsPolicy {
    read_all()
        .get(machine_id.trim())
        .copied()
        .unwrap_or_default()
}

/// Record what this place asked for, and answer with it as now written.
pub fn write(machine_id: &str, policy: PortsPolicy) -> Result<PortsPolicy, String> {
    let mut all = read_all();
    let all = settle(&mut all, machine_id, policy);
    write_all(all)?;
    Ok(policy)
}

/// The one rule about the file's contents: a place at the default is not
/// written down, so the file only ever names places that differ from it.
fn settle<'a>(
    all: &'a mut BTreeMap<String, PortsPolicy>,
    machine_id: &str,
    policy: PortsPolicy,
) -> &'a BTreeMap<String, PortsPolicy> {
    let id = machine_id.trim().to_string();
    if policy == PortsPolicy::default() {
        all.remove(&id);
    } else {
        all.insert(id, policy);
    }
    all
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_place_nobody_mentioned_is_off() {
        let all: BTreeMap<String, PortsPolicy> = BTreeMap::new();
        assert_eq!(
            all.get("ubuntu@box").copied().unwrap_or_default(),
            PortsPolicy { auto_forward: false }
        );
    }

    #[test]
    fn turning_it_on_names_the_place_and_turning_it_off_forgets_it() {
        let mut all = BTreeMap::new();
        settle(&mut all, " ubuntu@box ", PortsPolicy { auto_forward: true });
        assert_eq!(
            all.get("ubuntu@box"),
            Some(&PortsPolicy { auto_forward: true })
        );
        settle(&mut all, "ubuntu@box", PortsPolicy { auto_forward: false });
        assert!(all.is_empty(), "the default is not worth a row");
    }

    #[test]
    fn a_file_written_before_the_field_reads_as_off() {
        let all: BTreeMap<String, PortsPolicy> =
            serde_json::from_str(r#"{"ubuntu@box":{}}"#).unwrap();
        assert!(!all["ubuntu@box"].auto_forward);
    }
}
