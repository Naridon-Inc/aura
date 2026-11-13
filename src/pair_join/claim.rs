//! This machine's claim on a code it is spending.
//!
//! A join can be cut off after the cloud has spent the code but before the
//! answer arrives — a dropped connection, a closed terminal. Running the same
//! line again must then finish the join rather than fail on a code that is
//! already used. So the first try makes 32 random bytes, keeps them here, and
//! sends them along with the code; the cloud stores only their hash. A second
//! try sends the same bytes, and the cloud hands this machine a fresh token for
//! the computer it already made — which it does only until that computer has
//! checked in, and only to the holder of the claim, never to someone who
//! merely saw the code.

use std::path::{Path, PathBuf};
use std::time::{Duration, SystemTime};

use rand::RngCore;

/// How long an unfinished claim is worth keeping: past the code's own ten
/// minutes, the claim can't buy anything.
const KEEP: Duration = Duration::from_secs(60 * 60);

fn file(pending: &Path, lookup: &str) -> PathBuf {
    pending.join(format!("{lookup}.claim"))
}

/// The claim for `lookup`: the one made by an earlier try, or a new one.
pub fn claim_for(pending: &Path, lookup: &str, owner: Option<(u32, u32)>) -> Result<String, String> {
    forget_stale(pending);
    let path = file(pending, lookup);
    if let Ok(text) = std::fs::read_to_string(&path) {
        let t = text.trim();
        if is_claim(t) {
            return Ok(t.to_ascii_lowercase());
        }
    }
    let mut bytes = [0u8; 32];
    rand::rngs::OsRng.fill_bytes(&mut bytes);
    let claim = hex::encode(bytes);
    super::conf::write_private(&path, claim.as_bytes(), owner)?;
    Ok(claim)
}

/// The join finished, or the code is dead: the claim is worth nothing now.
pub fn forget(pending: &Path, lookup: &str) {
    let _ = std::fs::remove_file(file(pending, lookup));
}

fn forget_stale(pending: &Path) {
    let Ok(entries) = std::fs::read_dir(pending) else { return };
    let now = SystemTime::now();
    for e in entries.flatten() {
        let old = e
            .metadata()
            .and_then(|m| m.modified())
            .ok()
            .and_then(|t| now.duration_since(t).ok())
            .is_some_and(|age| age > KEEP);
        if old && e.file_name().to_string_lossy().ends_with(".claim") {
            let _ = std::fs::remove_file(e.path());
        }
    }
}

fn is_claim(s: &str) -> bool {
    s.len() == 64 && s.bytes().all(|b| b.is_ascii_hexdigit())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_second_try_sends_the_same_claim_and_a_finished_join_forgets_it() {
        let dir = tempfile::tempdir().unwrap();
        let pending = dir.path().join("pending");
        let first = claim_for(&pending, "K7QM", None).unwrap();
        assert!(is_claim(&first));
        assert_eq!(claim_for(&pending, "K7QM", None).unwrap(), first);
        assert_ne!(claim_for(&pending, "B4RT", None).unwrap(), first);
        forget(&pending, "K7QM");
        assert_ne!(claim_for(&pending, "K7QM", None).unwrap(), first);
    }

    #[test]
    fn a_damaged_claim_is_replaced() {
        let dir = tempfile::tempdir().unwrap();
        std::fs::write(file(dir.path(), "K7QM"), "not a claim").unwrap();
        assert!(is_claim(&claim_for(dir.path(), "K7QM", None).unwrap()));
    }
}
