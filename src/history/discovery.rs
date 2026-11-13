//! What is in `~/.aura/dialects/`, and which kind of thing each file is.
//!
//! The directory holds one JSON file per agent Aura was not compiled to know
//! about. Two shapes live there, and they answer the same trait:
//!
//! * a **manifest** — "my transcript is JSONL, here is how to read it" — read
//!   by [`super::manifest`];
//! * a **program** — "ask my program, it will answer in JSON" — run by
//!   [`super::external`].
//!
//! The second shape exists because the first one cannot be stretched to cover
//! it. A manifest describes rows in a file; an agent that keeps its history in
//! SQLite, in Protobuf, or spread across several files that have to be joined
//! has nothing a glob and a dotted path can read, and until now the answer was
//! to patch Aura and wait for a release. A program is the same contract moved
//! out of process: three verbs, JSON in, JSON out.
//!
//! Discovery stays here rather than in either module because the choice
//! between them is a property of the directory, not of either shape, and
//! because both halves of the answer — what loaded, and what did not and why —
//! have to come back together. A dialect that silently fails to appear is
//! indistinguishable from one that appeared and found nothing.
//!
//! Note what is *not* here: no scan of `PATH`, no magic filename prefix. A
//! binary landing on a machine cannot make itself part of Aura; a file in this
//! directory is a sentence someone wrote down.

use std::path::{Path, PathBuf};

use super::external::{ExternalDialect, ExternalSpec};
use super::home;
use super::manifest::{Manifest, ManifestDialect};
use super::History;

/// One dialect loaded off disk, and which kind of file described it.
///
/// `kind` is carried alongside rather than asked of the dialect because it is a
/// fact about where the dialect came from, not about what it can do — the whole
/// point of the trait is that a caller reading history cannot tell the
/// difference. `aura dialects` is the one place that has to.
pub struct Discovered {
    pub dialect: Box<dyn History>,
    /// `"manifest"` or `"program"`.
    pub kind: &'static str,
}

/// Where dialect files live. `AURA_DIALECTS_DIR` overrides it, which is how the
/// tests get a tree of their own instead of the developer's real one.
pub fn dialects_dir() -> Option<PathBuf> {
    if let Some(dir) = std::env::var_os("AURA_DIALECTS_DIR") {
        return Some(PathBuf::from(dir));
    }
    Some(home()?.join(".aura").join("dialects"))
}

/// Every usable dialect file on disk, and every one that isn't, with the reason.
pub fn discover() -> (Vec<Discovered>, Vec<String>) {
    match dialects_dir() {
        Some(dir) => discover_in(&dir),
        None => (Vec::new(), Vec::new()),
    }
}

/// [`discover`], against a named directory. Split out so the tests get a tree
/// of their own rather than the developer's real one.
pub fn discover_in(dir: &Path) -> (Vec<Discovered>, Vec<String>) {
    let mut ok: Vec<Discovered> = Vec::new();
    let mut bad: Vec<String> = Vec::new();
    let Ok(entries) = std::fs::read_dir(dir) else {
        return (ok, bad);
    };
    let mut paths: Vec<PathBuf> = entries
        .filter_map(Result::ok)
        .map(|e| e.path())
        .filter(|p| p.extension().is_some_and(|e| e == "json"))
        .collect();
    // Stable order so output is stable, whatever the filesystem hands back.
    paths.sort();

    let builtin: Vec<&str> = super::builtin().iter().map(|d| d.id()).collect();
    for p in paths {
        match load(&p) {
            Ok(d) => {
                let id = d.dialect.id();
                if builtin.contains(&id) {
                    // Refusing rather than overriding: a file that shadows a
                    // compiled dialect would change what `aura why` answers
                    // with no sign that it had, and the compiled one is the
                    // one with the agent's edge cases in it.
                    bad.push(format!(
                        "{}: `{id}` is a built-in dialect and cannot be replaced",
                        p.display()
                    ));
                    continue;
                }
                if ok.iter().any(|e| e.dialect.id() == id) {
                    bad.push(format!("{}: duplicate dialect id `{id}`", p.display()));
                    continue;
                }
                ok.push(d);
            }
            Err(e) => bad.push(e),
        }
    }
    (ok, bad)
}

/// Read one file, whichever shape it is.
///
/// The `program` key is what tells them apart, and it is read before either
/// shape is parsed in full — so a program file missing a field it needs is told
/// what a program needs, rather than being told it is a malformed manifest.
/// Errors carry the path because these files are hand-written by someone who is
/// not us, and "invalid dialect" without a filename is not a message anyone can
/// act on.
fn load(path: &Path) -> Result<Discovered, String> {
    let text = std::fs::read_to_string(path).map_err(|e| format!("{}: {e}", path.display()))?;
    let raw: serde_json::Value =
        serde_json::from_str(&text).map_err(|e| format!("{}: {e}", path.display()))?;

    if raw.get("program").is_some() {
        let spec: ExternalSpec =
            serde_json::from_value(raw).map_err(|e| format!("{}: {e}", path.display()))?;
        spec.check().map_err(|e| format!("{}: {e}", path.display()))?;
        return Ok(Discovered { dialect: Box::new(ExternalDialect::new(spec)), kind: "program" });
    }

    let m = Manifest::parse(raw).map_err(|e| format!("{}: {e}", path.display()))?;
    Ok(Discovered { dialect: Box::new(ManifestDialect::new(m)), kind: "manifest" })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn write(path: &Path, body: &str) {
        std::fs::create_dir_all(path.parent().unwrap()).unwrap();
        std::fs::write(path, body).unwrap();
    }

    const MANIFEST: &str = r#"{"id":"amp","display":"Amp","root":"~/.amp",
        "sessions":{"glob":"*.jsonl"},
        "prompt":{"when":{"role":"user"},"text":"content"}}"#;

    #[test]
    fn a_dialect_file_cannot_shadow_a_compiled_dialect() {
        // Overriding one silently would change what `aura why` answers, and
        // the compiled dialect is the one with the agent's edge cases in it.
        let dir = tempfile::tempdir().unwrap();
        write(
            &dir.path().join("claude.json"),
            r#"{"id":"claude","display":"Mine","root":"~/.x",
                "sessions":{"glob":"*.jsonl"},
                "prompt":{"when":{"role":"user"},"text":"content"}}"#,
        );
        write(&dir.path().join("amp.json"), MANIFEST);

        let (ok, bad) = discover_in(dir.path());
        assert_eq!(ok.iter().map(|d| d.dialect.id()).collect::<Vec<_>>(), vec!["amp"]);
        assert_eq!(bad.len(), 1);
        assert!(bad[0].contains("built-in"));
    }

    #[test]
    fn a_file_that_does_not_parse_says_which_file() {
        // These are hand-written by someone who is not us; "invalid dialect"
        // with no filename is not a message anyone can act on.
        let dir = tempfile::tempdir().unwrap();
        write(&dir.path().join("broken.json"), "{ not json");
        let (ok, bad) = discover_in(dir.path());
        assert!(ok.is_empty());
        assert_eq!(bad.len(), 1);
        assert!(bad[0].contains("broken.json"));
    }

    #[test]
    fn the_program_key_decides_which_shape_a_file_is() {
        // One directory, two shapes, one trait. The `program` key is the whole
        // signal — a program file carries no glob and a manifest carries no
        // program, and neither should be read as a broken copy of the other.
        let dir = tempfile::tempdir().unwrap();
        write(&dir.path().join("amp.json"), MANIFEST);
        write(
            &dir.path().join("zed.json"),
            r#"{"id":"zed","display":"Zed","program":"/usr/local/bin/aura-dialect-zed"}"#,
        );

        let (ok, bad) = discover_in(dir.path());
        assert!(bad.is_empty(), "{bad:?}");
        let got: Vec<(&str, &str)> =
            ok.iter().map(|d| (d.dialect.id(), d.kind)).collect();
        assert_eq!(got, vec![("amp", "manifest"), ("zed", "program")]);
    }

    #[test]
    fn a_program_file_is_judged_as_a_program() {
        // Not as a manifest missing a glob. Someone writing their first one
        // has to be told what a program needs, not what the other shape needs.
        let dir = tempfile::tempdir().unwrap();
        write(&dir.path().join("zed.json"), r#"{"id":"zed","display":"","program":"x"}"#);
        let (ok, bad) = discover_in(dir.path());
        assert!(ok.is_empty());
        assert_eq!(bad.len(), 1);
        assert!(bad[0].contains("`display` is empty"), "{}", bad[0]);
    }

    #[test]
    fn two_files_claiming_one_id_keep_the_first_and_say_so() {
        let dir = tempfile::tempdir().unwrap();
        write(&dir.path().join("a-amp.json"), MANIFEST);
        write(&dir.path().join("b-amp.json"), r#"{"id":"amp","display":"Amp","program":"x"}"#);

        let (ok, bad) = discover_in(dir.path());
        assert_eq!(ok.len(), 1);
        assert_eq!(ok[0].kind, "manifest");
        assert_eq!(bad.len(), 1);
        assert!(bad[0].contains("duplicate"));
    }
}
