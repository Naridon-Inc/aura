//! `aura dialects` — which agent CLIs Aura can read, and why one is missing.
//!
//! Every history-reading command — `aura why`, `aura import`, `aura recap`,
//! `aura dispatch` — silently reads whatever dialects are available. That is
//! the right behaviour for those commands and the wrong one for the person who
//! has just written their first manifest and cannot tell whether it was loaded,
//! loaded and found nothing, or thrown out for a missing comma. This command
//! exists so the answer is one line away.
//!
//! It reads. It does not install, register or phone anything.

use crate::history::{self, manifest, History};

/// Print the dialect table. Returns a process exit code: non-zero when a
/// manifest on disk could not be used, because a config error that prints a
/// note and exits 0 is a config error that gets scrolled past in CI.
pub fn cli(json: bool) -> i32 {
    let (extra, bad) = manifest::discover();
    let builtin = history::builtin();

    if json {
        let rows: Vec<serde_json::Value> = builtin
            .iter()
            .map(|d| row(d.as_ref(), "builtin"))
            .chain(extra.iter().map(|d| row(d, "manifest")))
            .collect();
        let out = serde_json::json!({
            "dialects": rows,
            "errors": bad,
            "manifest_dir": manifest::dialects_dir().map(|p| p.to_string_lossy().to_string()),
        });
        println!("{}", serde_json::to_string_pretty(&out).unwrap_or_default());
        return if bad.is_empty() { 0 } else { 1 };
    }

    println!("\x1b[1mAgent histories Aura can read\x1b[0m\n");
    for d in &builtin {
        print_one(d.as_ref(), "built in");
    }
    for d in &extra {
        print_one(d, "manifest");
    }

    let dir = manifest::dialects_dir();
    if extra.is_empty() && bad.is_empty() {
        println!(
            "\n\x1b[2mAdd an agent Aura has never heard of by dropping a manifest in\n  {}\nSee docs/AGENT_PLUGINS.md.\x1b[0m",
            dir.as_ref().map(|p| p.to_string_lossy().to_string()).unwrap_or_else(|| "~/.aura/dialects".into())
        );
    }

    if !bad.is_empty() {
        println!("\n\x1b[31mManifests that could not be used\x1b[0m");
        for e in &bad {
            println!("  {e}");
        }
        return 1;
    }
    0
}

fn row(d: &dyn History, kind: &str) -> serde_json::Value {
    serde_json::json!({
        "id": d.id(),
        "display": d.display(),
        "kind": kind,
        // Absent, not false: "not installed" and "installed and empty" are
        // different answers and the caller may want to tell them apart.
        "root": d.root().map(|p| p.to_string_lossy().to_string()),
        "installed": d.root().is_some(),
    })
}

fn print_one(d: &dyn History, kind: &str) {
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
