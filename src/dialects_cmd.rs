//! `aura dialects` — which agent CLIs Aura can read, and why one is missing.
//!
//! Every history-reading command — `aura why`, `aura import`, `aura recap`,
//! `aura dispatch` — silently reads whatever dialects are available. That is
//! the right behaviour for those commands and the wrong one for the person who
//! has just added their first agent and cannot tell whether it was loaded,
//! loaded and found nothing, or thrown out for a missing comma. This command
//! exists so the answer is one line away.
//!
//! For a dialect that is a program rather than a directory, "was it loaded" is
//! not the whole question — the file can be perfect and the program still
//! missing, unrunnable or printing prose. So this is also the one command that
//! calls [`History::probe`], which asks each one the cheapest real question and
//! reports what came back. That costs a subprocess per program dialect, which
//! is why it happens here and not on the path of `aura why`.
//!
//! It reads. It does not install, register or phone anything.

use crate::history::{self, discovery, History};

/// Print the dialect table. Returns a process exit code: non-zero when a file
/// in the dialects directory could not be used, or a program dialect could not
/// answer — because a config error that prints a note and exits 0 is a config
/// error that gets scrolled past in CI.
pub fn cli(json: bool) -> i32 {
    let (extra, bad) = discovery::discover();
    let builtin = history::builtin();

    // One probe per discovered dialect, paired back up with it. A built-in
    // reads a directory and cannot fail in a way worth reporting, so it is not
    // asked.
    //
    // A probe failure is shown on the dialect's own row rather than repeated in
    // the footer: the footer is for files that could not be *read*, which have
    // no row to be shown on. Both count towards the exit code.
    let probed: Vec<(&discovery::Discovered, Option<String>)> =
        extra.iter().map(|d| (d, d.dialect.probe().err())).collect();
    let unusable = bad.len() + probed.iter().filter(|(_, e)| e.is_some()).count();

    if json {
        let rows: Vec<serde_json::Value> = builtin
            .iter()
            .map(|d| row(d.as_ref(), "builtin", None))
            .chain(
                probed
                    .iter()
                    .map(|(d, err)| row(d.dialect.as_ref(), d.kind, err.as_deref())),
            )
            .collect();
        let out = serde_json::json!({
            "dialects": rows,
            "errors": bad,
            "dialects_dir": discovery::dialects_dir().map(|p| p.to_string_lossy().to_string()),
        });
        println!("{}", serde_json::to_string_pretty(&out).unwrap_or_default());
        return if unusable == 0 { 0 } else { 1 };
    }

    println!("\x1b[1mAgent histories Aura can read\x1b[0m\n");
    for d in &builtin {
        print_one(d.as_ref(), "built in", None);
    }
    for (d, err) in &probed {
        print_one(d.dialect.as_ref(), d.kind, err.as_deref());
    }

    let dir = discovery::dialects_dir();
    if extra.is_empty() && bad.is_empty() {
        println!(
            "\n\x1b[2mAdd an agent Aura has never heard of by dropping a file in\n  {}\n— a manifest if it writes a JSONL transcript, a program if it keeps its\nhistory somewhere only it can read. See docs/AGENT_PLUGINS.md.\x1b[0m",
            dir.as_ref().map(|p| p.to_string_lossy().to_string()).unwrap_or_else(|| "~/.aura/dialects".into())
        );
    }

    if !bad.is_empty() {
        println!("\n\x1b[31mFiles that could not be read\x1b[0m");
        for e in &bad {
            println!("  {e}");
        }
    }
    if unusable == 0 { 0 } else { 1 }
}

fn row(d: &dyn History, kind: &str, err: Option<&str>) -> serde_json::Value {
    serde_json::json!({
        "id": d.id(),
        "display": d.display(),
        "kind": kind,
        // Absent, not false: "not installed" and "installed and empty" are
        // different answers and the caller may want to tell them apart.
        "root": d.root().map(|p| p.to_string_lossy().to_string()),
        "installed": d.root().is_some(),
        // Absent when nothing was wrong, so a caller can test the key rather
        // than compare against an empty string.
        "error": err,
    })
}

fn print_one(d: &dyn History, kind: &str, err: Option<&str>) {
    // A dialect that is there and cannot answer is the one case worth colouring
    // red: the person meant it to work, and it does not.
    if let Some(e) = err {
        println!("  \x1b[31m●\x1b[0m {:<22} \x1b[2m{kind} · \x1b[0m\x1b[31m{e}\x1b[0m", d.display());
        return;
    }
    match d.root() {
        Some(root) => println!(
            "  \x1b[32m●\x1b[0m {:<22} \x1b[2m{kind} · {}\x1b[0m",
            d.display(),
            root.display()
        ),
        // Not an error and not a warning: an agent you do not use is simply
        // not on this machine, and colouring that red would train people to
        // ignore the colour.
        None => println!(
            "  \x1b[2m○ {:<22} {kind} · not installed here\x1b[0m",
            d.display()
        ),
    }
}
