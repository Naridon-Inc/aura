//! CAP-04: transactional surgical rewind.
//!
//! A rewind is all-or-nothing. Before this module, both rewind surfaces
//! (the CLI command and the MCP tool) truncated the target file in place
//! and treated the pre-rewind safety snapshot as optional — a snapshot
//! failure was a warning on one surface and silently discarded on the
//! other, and a crash between truncate and write destroyed the file the
//! rewind was supposed to save.
//!
//! `apply_rewind` gives both surfaces one contract:
//!
//! 1. the file on disk must still match the source the caller analyzed
//!    (a concurrent edit aborts the rewind instead of being overwritten),
//! 2. the spliced result must still parse and carry the restored node
//!    verbatim before anything touches the disk,
//! 3. the safety snapshot must exist — no snapshot, no rewind,
//! 4. the write lands via tmp + fsync + rename in the target's own
//!    directory, so a crash at any point leaves either the old file or
//!    the new file, never a truncated one.

use crate::parser::SemanticParser;
use std::fs;
use std::io::Write;
use std::ops::Range;
use std::path::Path;

#[derive(Debug)]
pub struct RewindApplied {
    /// Filename of the mandatory pre-rewind safety snapshot.
    pub safety_snapshot: String,
}

/// Restore `identifier` in `file_path` from `past_node_source`,
/// transactionally.
///
/// `node_range` is `Some` when the node is still in the file — the ordinary
/// "an agent rewrote this" case, spliced by byte range. It is `None` when the
/// node was **deleted**, which is precisely the damage a pre-edit snapshot
/// exists for; then `past_file_source` (the whole file the old version came
/// from) places it back beside its nearest surviving neighbour. Every
/// guarantee below — re-read check, verified splice, mandatory snapshot,
/// atomic apply — holds identically in both cases.
///
/// `take_snapshot` is the caller's safety snapshot (injected so each surface
/// keeps its own trigger/agent labels and so tests can observe or fail it);
/// it runs only after verification passes, and its failure aborts the rewind.
pub fn apply_rewind(
    parser: &mut SemanticParser,
    file_path: &str,
    ext: &str,
    identifier: &str,
    analyzed_source: &str,
    node_range: Option<Range<usize>>,
    past_node_source: &str,
    past_file_source: Option<&str>,
    take_snapshot: impl FnOnce() -> Result<String, String>,
) -> Result<RewindApplied, String> {
    let new_source = plan_rewind(
        parser,
        file_path,
        ext,
        identifier,
        analyzed_source,
        node_range,
        past_node_source,
        past_file_source,
    )?;

    // 3. The safety net is mandatory: no snapshot, no rewind.
    let safety_snapshot = take_snapshot().map_err(|e| {
        format!(
            "pre-rewind snapshot failed ({}) — rewind aborted, nothing was written",
            e
        )
    })?;

    // 4. Atomic apply: tmp in the same directory (same filesystem, so the
    //    rename is atomic), fsync before rename, permissions preserved.
    let target = Path::new(file_path);
    let dir = target
        .parent()
        .filter(|p| !p.as_os_str().is_empty())
        .unwrap_or_else(|| Path::new("."));
    let tmp = dir.join(format!(
        ".{}.aura-rewind.{}.tmp",
        target
            .file_name()
            .and_then(|n| n.to_str())
            .unwrap_or("file"),
        std::process::id()
    ));
    let write_result = (|| -> std::io::Result<()> {
        let mut f = fs::File::create(&tmp)?;
        f.write_all(new_source.as_bytes())?;
        f.sync_all()?;
        if let Ok(meta) = fs::metadata(target) {
            let _ = fs::set_permissions(&tmp, meta.permissions());
        }
        fs::rename(&tmp, target)
    })();
    if let Err(e) = write_result {
        let _ = fs::remove_file(&tmp);
        return Err(format!(
            "atomic write failed ({}) — {} was not modified",
            e, file_path
        ));
    }

    Ok(RewindApplied { safety_snapshot })
}

/// The whole file a rewind would write, worked out without writing it.
///
/// Steps 0–2 of [`apply_rewind`] — the ones that decide and verify — with the
/// snapshot and the disk left alone. Split out because a person has to be able
/// to see what a recovery will do to their file before it does it, and a
/// preview that re-implements the splice is a preview of something other than
/// what will happen. Every refusal below is a refusal `apply_rewind` would
/// have made, in the same words.
#[allow(clippy::too_many_arguments)]
pub fn plan_rewind(
    parser: &mut SemanticParser,
    file_path: &str,
    ext: &str,
    identifier: &str,
    analyzed_source: &str,
    node_range: Option<Range<usize>>,
    past_node_source: &str,
    past_file_source: Option<&str>,
) -> Result<String, String> {
    // 0. The analysis must still describe the file on disk. Anything else
    //    means a concurrent edit landed after the caller parsed — applying
    //    old offsets would silently discard it.
    let on_disk = fs::read_to_string(file_path)
        .map_err(|e| format!("cannot re-read {}: {}", file_path, e))?;
    if on_disk != analyzed_source {
        return Err(format!(
            "{} changed on disk after it was analyzed — nothing was written; re-run the rewind",
            file_path
        ));
    }

    // 1. Splice in memory — by range when the node survives, by neighbour
    //    when it was deleted.
    let new_source = match node_range {
        Some(range) => {
            // A broken caller must produce an error, not a panic inside
            // replace_range.
            if range.end > analyzed_source.len()
                || range.start > range.end
                || !analyzed_source.is_char_boundary(range.start)
                || !analyzed_source.is_char_boundary(range.end)
            {
                return Err(
                    "node range does not fit the analyzed source — nothing was written".to_string(),
                );
            }
            let mut s = analyzed_source.to_string();
            s.replace_range(range, past_node_source);
            s
        }
        None => {
            let past_file = past_file_source.unwrap_or("");
            match parser.splice_node_back(analyzed_source, past_file, ext, identifier) {
                Ok(Some(s)) => s,
                Ok(None) => {
                    return Err(format!(
                        "couldn't work out where '{}' belongs in {} — nothing was written",
                        identifier, file_path
                    ));
                }
                Err(e) => {
                    return Err(format!(
                        "couldn't place '{}' back in {} ({}) — nothing was written",
                        identifier, file_path, e
                    ));
                }
            }
        }
    };

    // 2. Verify the spliced file still parses to the node, verbatim.
    // Trailing whitespace is the splicer's to own — it re-indents the node
    // into its new neighbourhood — so the body, not the padding, is what has
    // to come back verbatim.
    match parser.retrieve_node_source(&new_source, ext, identifier) {
        Ok(Some((restored, _))) if restored.trim_end() == past_node_source.trim_end() => {}
        Ok(_) => {
            return Err(format!(
                "verification failed: after splicing, {} no longer carries '{}' with the restored body — nothing was written",
                file_path, identifier
            ));
        }
        Err(e) => {
            return Err(format!(
                "verification failed: spliced {} does not parse ({}) — nothing was written",
                file_path, e
            ));
        }
    }

    Ok(new_source)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::cell::Cell;

    const TWO_FNS: &str = "fn keep(x: i32) -> i32 { x * 2 }\n\nfn broken(x: i32) -> i32 { x + 999 }\n";
    const PAST_BROKEN: &str = "fn broken(x: i32) -> i32 { x + 1 }";
    /// The whole file as it stood back then — `broken` still good, sitting
    /// under `keep`. The splicer reads the node out of *this*, so its body has
    /// to be the same one `PAST_BROKEN` names or verification rightly refuses.
    const PAST_TWO_FNS: &str =
        "fn keep(x: i32) -> i32 { x * 2 }\n\nfn broken(x: i32) -> i32 { x + 1 }\n";

    struct Fixture {
        dir: std::path::PathBuf,
        file: std::path::PathBuf,
    }

    impl Fixture {
        fn new(content: &str) -> Self {
            let dir = std::env::temp_dir().join(format!(
                "aura-rewind-txn-{}-{}",
                std::process::id(),
                uuid::Uuid::new_v4()
            ));
            fs::create_dir_all(&dir).unwrap();
            let file = dir.join("target.rs");
            fs::write(&file, content).unwrap();
            Fixture { dir, file }
        }

        fn path(&self) -> &str {
            self.file.to_str().unwrap()
        }
    }

    impl Drop for Fixture {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.dir);
        }
    }

    fn range_of(parser: &mut SemanticParser, source: &str, ident: &str) -> Range<usize> {
        parser
            .retrieve_node_source(source, "rs", ident)
            .unwrap()
            .expect("node present")
            .1
    }

    #[test]
    fn rewind_replaces_the_node_and_leaves_the_rest() {
        let fx = Fixture::new(TWO_FNS);
        let mut parser = SemanticParser::new().unwrap();
        let range = range_of(&mut parser, TWO_FNS, "broken");

        let applied = apply_rewind(
            &mut parser,
            fx.path(),
            "rs",
            "broken",
            TWO_FNS,
            Some(range),
            PAST_BROKEN,
            None,
            || Ok("snap-1".to_string()),
        )
        .expect("rewind applies");

        assert_eq!(applied.safety_snapshot, "snap-1");
        let after = fs::read_to_string(fx.path()).unwrap();
        assert!(after.contains("x + 1"), "restored body present");
        assert!(!after.contains("x + 999"), "hallucinated body gone");
        assert!(after.contains("fn keep(x: i32) -> i32 { x * 2 }"), "untouched neighbor intact");
        // No stray tmp file left behind.
        let leftovers: Vec<_> = fs::read_dir(&fx.dir)
            .unwrap()
            .filter_map(|e| e.ok())
            .filter(|e| e.file_name().to_string_lossy().contains(".aura-rewind."))
            .collect();
        assert!(leftovers.is_empty(), "tmp files must not survive: {:?}", leftovers);
    }

    #[test]
    fn a_concurrent_edit_aborts_instead_of_being_overwritten() {
        let fx = Fixture::new(TWO_FNS);
        let mut parser = SemanticParser::new().unwrap();
        let range = range_of(&mut parser, TWO_FNS, "broken");

        // Someone else writes the file after our analysis.
        let concurrent = TWO_FNS.replace("keep", "kept");
        fs::write(&fx.file, &concurrent).unwrap();

        let err = apply_rewind(
            &mut parser,
            fx.path(),
            "rs",
            "broken",
            TWO_FNS,
            Some(range),
            PAST_BROKEN,
            None,
            || Ok("snap".to_string()),
        )
        .expect_err("must refuse");
        assert!(err.contains("changed on disk"), "got: {err}");
        assert_eq!(fs::read_to_string(fx.path()).unwrap(), concurrent, "their edit survives");
    }

    #[test]
    fn snapshot_failure_aborts_with_the_file_untouched() {
        let fx = Fixture::new(TWO_FNS);
        let mut parser = SemanticParser::new().unwrap();
        let range = range_of(&mut parser, TWO_FNS, "broken");

        let err = apply_rewind(
            &mut parser,
            fx.path(),
            "rs",
            "broken",
            TWO_FNS,
            Some(range),
            PAST_BROKEN,
            None,
            || Err("disk full".to_string()),
        )
        .expect_err("no snapshot, no rewind");
        assert!(err.contains("pre-rewind snapshot failed"), "got: {err}");
        assert_eq!(fs::read_to_string(fx.path()).unwrap(), TWO_FNS, "file untouched");
    }

    #[test]
    fn failed_verification_never_snapshots_and_never_writes() {
        let fx = Fixture::new(TWO_FNS);
        let mut parser = SemanticParser::new().unwrap();
        let range = range_of(&mut parser, TWO_FNS, "broken");

        let snapshot_taken = Cell::new(false);
        // Garbage that cannot parse back to a `broken` function.
        let err = apply_rewind(
            &mut parser,
            fx.path(),
            "rs",
            "broken",
            TWO_FNS,
            Some(range),
            "}} not a function {{",
            None,
            || {
                snapshot_taken.set(true);
                Ok("snap".to_string())
            },
        )
        .expect_err("verification must refuse garbage");
        assert!(err.contains("verification failed"), "got: {err}");
        assert!(!snapshot_taken.get(), "no junk snapshot on a refused rewind");
        assert_eq!(fs::read_to_string(fx.path()).unwrap(), TWO_FNS, "file untouched");
    }

    #[test]
    fn a_broken_range_errors_instead_of_panicking() {
        let fx = Fixture::new(TWO_FNS);
        let mut parser = SemanticParser::new().unwrap();

        let err = apply_rewind(
            &mut parser,
            fx.path(),
            "rs",
            "broken",
            TWO_FNS,
            Some(0..TWO_FNS.len() + 40),
            PAST_BROKEN,
            None,
            || Ok("snap".to_string()),
        )
        .expect_err("out-of-bounds range must error");
        assert!(err.contains("node range"), "got: {err}");
        assert_eq!(fs::read_to_string(fx.path()).unwrap(), TWO_FNS);
    }

    /// Deletion is the damage a pre-edit snapshot exists for, and the damage
    /// the deletion guard halts a commit over — so "bring it back" has to work
    /// when there is no range left to replace. The node is placed beside its
    /// nearest surviving neighbour, and every transactional guarantee above
    /// still holds.
    #[test]
    fn a_deleted_node_is_spliced_back_beside_its_neighbour() {
        const DELETED: &str = "fn keep(x: i32) -> i32 { x * 2 }\n";
        let fx = Fixture::new(DELETED);
        let mut parser = SemanticParser::new().unwrap();

        let applied = apply_rewind(
            &mut parser,
            fx.path(),
            "rs",
            "broken",
            DELETED,
            None,
            PAST_BROKEN,
            Some(PAST_TWO_FNS),
            || Ok("snap-del".to_string()),
        )
        .expect("a deleted node is recoverable");

        assert_eq!(applied.safety_snapshot, "snap-del");
        let after = fs::read_to_string(fx.path()).unwrap();
        assert!(after.contains("x + 1"), "restored body present: {after}");
        assert!(
            after.contains("fn keep(x: i32) -> i32 { x * 2 }"),
            "surviving neighbour intact: {after}"
        );
    }

    /// With no file to place it from, the rewind refuses rather than writing
    /// the file unchanged and reporting success.
    #[test]
    fn a_deleted_node_with_nowhere_to_put_it_refuses() {
        const DELETED: &str = "fn keep(x: i32) -> i32 { x * 2 }\n";
        let fx = Fixture::new(DELETED);
        let mut parser = SemanticParser::new().unwrap();

        let err = apply_rewind(
            &mut parser,
            fx.path(),
            "rs",
            "broken",
            DELETED,
            None,
            PAST_BROKEN,
            None,
            || Ok("snap".to_string()),
        )
        .expect_err("nothing to place it from");
        assert!(err.contains("couldn't work out where"), "got: {err}");
        assert_eq!(fs::read_to_string(fx.path()).unwrap(), DELETED, "file untouched");
    }
}
