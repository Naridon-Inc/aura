//! One door to the wire, and a test that keeps it that way.
//!
//! There were four ways to reach a box: the chat's tools, the `box_*` commands,
//! the terminal's own ssh line, and whatever the surface that needed to know
//! "is it up?" last wrote. Each was a place where a second way of *getting* a
//! machine — an Aura-managed VM rather than one you brought — could silently
//! gain fewer features than the first, and nobody would find out until a user
//! did.
//!
//! Collapsing them onto [`Place`](crate::manager::brain::place::Place) fixes
//! that once. Nothing stops it un-fixing itself: the next command that needs
//! something off a box is three lines away from calling [`dial`](super::dial)
//! itself, it will work perfectly, and the managed arm will simply not have
//! whatever it did. That is not a bug anyone reports — it is a feature that
//! quietly exists in one place-mode only, which is the one thing this
//! programme is not allowed to ship.
//!
//! So the invariant is a test rather than a line in a review checklist:
//!
//! * exactly one production line in the repo spawns `ssh` — [`super::dial`]
//! * exactly one production line calls it — `Place::run_remote`
//! * every `box_*` command is a `Place` call and reaches nothing itself
//!
//! The terminal's own ssh line — the third of those four ways — was the last to
//! go, and the odd one: it was never in Rust at all. `remoteShell.ts` built
//! `ssh -i … user@host "…"` out of three fields off a machine row, so this
//! guard could have been green while a whole transport lived across the wire in
//! TypeScript, with none of the multiplexing, none of the quoting agreement and
//! none of what the managed arm will need. `place_boot` is that line now, and
//! it is derived from the same argv as everything else here, which is why it is
//! listed below with the rest.
//!
//! ## Reading Rust with a mask rather than a parser
//!
//! The claim is about *production* code. This module's neighbours dial a real
//! box on purpose in their live tests, and both would fail a plain `grep`. So
//! each file is stripped of everything `#[cfg(test)]` gates before it is
//! searched — including this one, which is gated whole.
//!
//! Stripping needs to tell a `{` in code from the one inside
//! `"#{{pane_current_command}}"`, and a `;` in code from the one inside
//! `#[ignore = "needs a real box; set …"]`. [`kinds`] answers exactly that and
//! nothing more: whether a byte is code, the text of a literal, or a comment.
//! A real parser would be the wrong tool — it would have to keep up with the
//! language, where this only has to keep up with one habit.

#![cfg(test)]

use std::path::{Path, PathBuf};

/// Every command that answers *for* a named machine, and the file it lives in.
///
/// The `box_*` six were path B on their own. `place_env_*` was the second family
/// to arrive and `place_member_account` the third, which is where a list like
/// this earns its keep: whoever adds a fourth — next to any of these, or in a
/// file of its own — is adding a way to reach a machine, and it has to ask
/// `Place` which machine it is rather than deciding for itself. A command that
/// decides for itself works perfectly on the box you brought and does nothing at
/// all on a managed one. Per-member accounts are the sharpest case yet: a
/// managed place that missed them would put a whole team back on one login —
/// and `place_push_credential`, right behind it, decides whose token a push
/// spends, which is the same mistake with a name on the commit. `place_boot` is
/// the fifth family and the one that closes path C: the terminal asks for a
/// line instead of writing one; `place_secret_boot` is the sixth — the values a
/// member's work spends at a place, put onto the process and nowhere else.
/// `place_agent_key` is the seventh, and it is the one that costs money: it says
/// which credential an agent run at a place will spend, so a version of it that
/// found its own machine would be a bill attributed to the wrong one. And
/// `place_forward_*` is the eighth, the one with the most to lose by forking: it
/// decides whether a machine may use the key on this laptop, so a second way of
/// naming a machine here is a second way of deciding that, about a machine
/// nobody checked was the one on screen. `place_sleep*` is the ninth and the
/// bluntest: it STOPS a machine. A version of it that found its own would be a
/// box going down that nobody checked was the one on screen — and the sweep
/// behind it does that unattended, on a timer, to every row in the book.
/// `place_wak*` is the tenth and the other half of that one: it STARTS a
/// machine, which is the same blast radius with a bill on it. It is also the
/// family most likely to fork, because starting a box is a thing every surface
/// would rather do for itself than ask for — and a surface that woke its own
/// would be spending money on a machine nobody checked was the one on screen.
/// `place_team_base*` is the eleventh, and it is the one with a bill attached at
/// the other end: it decides which machine the team's shared environment gets
/// built on, and a version that found its own would spend somebody's minutes
/// installing a toolchain onto a box nobody chose. `place_grant_*` is the
/// twelfth, and it is where a machine GAINS the permission the ninth and tenth
/// act on: one of them writes onto a row that Aura may switch that box off, and
/// a version that found its own machine would hand that permission to a box
/// nobody checked was the one on screen — which is the same blast radius as
/// sleeping, granted rather than spent.
const MACHINE_COMMANDS: [(&str, &str); 25] = [
    (THE_DOOR, "box_sessions"),
    (THE_DOOR, "box_projects"),
    (THE_DOOR, "place_capabilities"),
    (THE_DOOR, "box_start"),
    (THE_DOOR, "box_stop"),
    (THE_DOOR, "box_clone"),
    (THE_ENVOY, "place_env_state"),
    (THE_ENVOY, "place_env_apply"),
    (THE_REGISTRAR, "place_member_account"),
    (THE_BANKER, "place_push_credential"),
    (THE_CASHIER, "place_agent_key"),
    (THE_USHER, "place_boot"),
    (THE_BROKER, "place_secret_boot"),
    (THE_LENDER, "place_forwarding"),
    (THE_LENDER, "place_forward_set"),
    (THE_LENDER, "place_forward_release"),
    (THE_WARDEN, "place_sleeping"),
    (THE_WARDEN, "place_sleep"),
    (THE_WARDEN, "places_sleep_idle"),
    (THE_ROUSER, "place_wake"),
    (THE_ROUSER, "place_waking"),
    (THE_QUARTERMASTER, "place_team_base"),
    (THE_QUARTERMASTER, "place_team_base_warm"),
    (THE_NOTARY, "place_grant_link"),
    (THE_NOTARY, "place_grant_unlink"),
];

/// The three ways a command is allowed to find out which place it is talking
/// about: by machine id, by an address not yet written down, or by an id that
/// may be absent and mean this laptop.
///
/// The middle one exists for exactly one caller — the connect wizard, which
/// opens a terminal on a box before the book has heard of it — and it is on
/// this list rather than beside it because it goes through the same dialability
/// check and hands back the same `Place`. A wizard that reached past this to
/// build its own line is precisely how the transport forked the first time.
const ASKING_PLACE: [&str; 3] = [
    "Place::at_machine",
    "Place::at_address",
    "Place::resolve",
];

/// The only file allowed to spawn `ssh`.
const THE_DOOR: &str = "aura-shell/src-tauri/src/cloudbox/mod.rs";

/// The only file allowed to walk through it.
const THE_DIALER: &str = "aura-shell/src-tauri/src/manager/brain/place.rs";

/// Where a place is brought to the environment its project declares.
const THE_ENVOY: &str = "aura-shell/src-tauri/src/manager/brain/place_env.rs";

/// Where a member is given their own account on a place they share.
const THE_REGISTRAR: &str = "aura-shell/src-tauri/src/manager/brain/place_account.rs";

/// Where it is decided whose credential a push from a place spends.
const THE_BANKER: &str = "aura-shell/src-tauri/src/manager/brain/place_git.rs";

/// Where it is decided which credential an agent run at a place spends — and,
/// because that is the same question, whose bill it lands on.
const THE_CASHIER: &str = "aura-shell/src-tauri/src/manager/brain/place_agent_key/mod.rs";

/// Where it is decided whether a place may use the key on this laptop.
const THE_LENDER: &str = "aura-shell/src-tauri/src/manager/brain/place_forward.rs";

/// Where a place nobody is using is stopped.
const THE_WARDEN: &str = "aura-shell/src-tauri/src/manager/brain/place_sleep/mod.rs";

/// Where a place Aura stopped is started again — on purpose, or on the way past
/// because something reached it.
const THE_ROUSER: &str = "aura-shell/src-tauri/src/manager/brain/place_wake/mod.rs";

/// Where the team's environment is built once, and where each member is started
/// from a copy of it rather than from nothing.
const THE_QUARTERMASTER: &str = "aura-shell/src-tauri/src/manager/brain/place_base/mod.rs";

/// Where a customer's own machine is recorded as one Aura has been given
/// permission to switch off — and where that permission is handed back.
const THE_NOTARY: &str = "aura-shell/src-tauri/src/manager/brain/place_grant.rs";

/// Where a terminal is shown to its place — the only line anything is allowed
/// to type into a pty it did not spawn.
const THE_USHER: &str = "aura-shell/src-tauri/src/manager/brain/place_open.rs";
/// Where a member's secrets are put into a place's environment at boot.
const THE_BROKER: &str = "aura-shell/src-tauri/src/manager/brain/place_secrets.rs";

/// How `ssh` actually gets run, as it is spelled in [`super::dial`].
const SPAWN: &str = r#"Command::new("ssh")"#;

#[test]
fn one_line_in_the_repo_spawns_ssh() {
    let files = corpus();
    let spawns: Vec<&str> = files
        .iter()
        .filter(|(_, src)| occurrences(src, SPAWN, Kind::Code) > 0)
        .map(|(p, _)| p.as_str())
        .collect();
    assert_eq!(
        spawns,
        vec![THE_DOOR],
        "something other than cloudbox::dial spawns ssh — every place-mode has to get \
         whatever it does, so it belongs behind Place"
    );
    assert_eq!(
        occurrences(source(&files, THE_DOOR), SPAWN, Kind::Code),
        1,
        "{THE_DOOR} grew a second spawn"
    );
}

#[test]
fn only_place_dials_a_machine() {
    let files = corpus();
    let callers: Vec<&str> = files
        .iter()
        .filter(|(_, src)| calls(src, "dial") > 0)
        .map(|(p, _)| p.as_str())
        .collect();
    assert_eq!(
        callers,
        vec![THE_DIALER],
        "a caller outside Place reaches a machine on its own"
    );
    assert_eq!(
        calls(source(&files, THE_DIALER), "dial"),
        1,
        "Place has more than one way out — a step added to run_remote (a retry, a \
         metering hook, a managed VM's transport) would skip the other one"
    );
}

#[test]
fn nothing_else_in_the_repo_writes_an_ssh_line() {
    // Not only the spawn. A surface that assembles its own `-i key user@host`
    // has forked the transport whether or not it runs it; `Place::open` is the
    // sanctioned answer, and it hands back argv for the pty layer to run.
    let files = corpus();
    let mut named: Vec<&str> = files
        .iter()
        .filter(|(_, src)| names_ssh_as_a_program(src))
        .map(|(p, _)| p.as_str())
        .collect();
    named.sort_unstable();
    assert_eq!(named, vec![THE_DOOR, THE_DIALER]);
}

#[test]
fn a_scheme_to_port_table_is_not_a_transport() {
    // The carve-out has to be narrow enough that the thing this test forbids
    // still trips it, or it is a hole rather than a distinction.
    assert!(!names_ssh_as_a_program(r#"let port = match scheme { "ssh" => 22 };"#));
    assert!(!names_ssh_as_a_program(r#"const PORTS = { "ssh": 22 };"#));
    assert!(names_ssh_as_a_program(r#"Command::new("ssh").arg("-i")"#));
    assert!(names_ssh_as_a_program(r#"let program = "ssh";"#));
    // A table entry is one occurrence, not a licence for the rest of the file.
    assert!(names_ssh_as_a_program(
        "let port = match scheme { \"ssh\" => 22 };\nCommand::new(\"ssh\")"
    ));
}

#[test]
fn every_command_that_names_a_machine_is_a_place_call() {
    // The end of path B. Each of them names a machine, asks `Place` which one it
    // is, and touches nothing that reaches a box itself — so the same answers
    // come back for a managed VM the day there is one, with none of them edited.
    let files = corpus();
    for (file, name) in MACHINE_COMMANDS {
        let src = source(&files, file);
        let body = body_of(src, &format!("pub async fn {name}("))
            .unwrap_or_else(|| panic!("{name} is not a command in {file} any more"));
        assert!(
            ASKING_PLACE.iter().any(|ask| body.contains(ask)),
            "{name} does not go through Place: {body}"
        );
        for reached_past in ["dial(", "ssh_arg", "Command::new"] {
            assert!(
                !body.contains(reached_past),
                "{name} reaches a machine itself via `{reached_past}`, so a second \
                 place-mode gets everything except this"
            );
        }
    }
}

#[test]
fn bringing_a_place_to_spec_reaches_it_only_through_place() {
    // The environment applier is the widest thing that ever runs on a box: it
    // installs toolchains, packages and services from whatever the project's
    // spec says. Precisely because it runs arbitrary declared commands, it is
    // the most tempting file in which to shell out "just this once" — and if it
    // did, a project would come up on the box you brought and not on a managed
    // one, which is the failure this whole programme exists to prevent.
    let files = corpus();
    let src = source(&files, THE_ENVOY);
    assert_eq!(
        occurrences(src, SPAWN, Kind::Code),
        0,
        "{THE_ENVOY} spawns ssh itself"
    );
    assert_eq!(calls(src, "dial"), 0, "{THE_ENVOY} dials a machine itself");
    assert_eq!(
        calls(src, "Command::new"),
        0,
        "{THE_ENVOY} runs a command outside Place, so it would run on this \
         laptop while claiming to have brought a box to spec"
    );
    assert!(
        calls(src, "self.sh") > 0,
        "{THE_ENVOY} no longer runs anything through Place::sh — the local and \
         remote arms have stopped sharing a transport"
    );
}

// ---------------------------------------------------------------------------
// Reading the repo
// ---------------------------------------------------------------------------

/// Every Rust file in the repo, with its test code removed.
///
/// Paths are repo-relative, so a failure names a file rather than somebody's
/// home directory and the constants above read the way a person would write
/// them.
fn corpus() -> Vec<(String, String)> {
    let root = repo_root();
    let mut files = vec![];
    walk(&root, &root, &mut files);
    files.sort_unstable_by(|a, b| a.0.cmp(&b.0));

    // A walk that found nothing would pass every assertion above in silence,
    // which is worse than having no guard at all.
    assert!(
        files.len() > 200,
        "only {} rust files under {} — the walk is not seeing the repo",
        files.len(),
        root.display()
    );
    for must in [THE_DOOR, THE_DIALER] {
        assert!(
            files.iter().any(|(p, _)| p == must),
            "{must} is missing from the walk"
        );
    }
    files
}

fn source<'a>(files: &'a [(String, String)], path: &str) -> &'a str {
    files
        .iter()
        .find(|(p, _)| p == path)
        .map(|(_, s)| s.as_str())
        .unwrap_or_else(|| panic!("{path} is not in the corpus"))
}

/// Upwards from this crate until something holds a `.git`.
///
/// A file, not only a directory: in a worktree — which is how this repo's
/// parallel work is done — `.git` is a one-line pointer at the real one.
fn repo_root() -> PathBuf {
    let mut dir = PathBuf::from(env!("CARGO_MANIFEST_DIR"));
    while !dir.join(".git").exists() {
        assert!(dir.pop(), "no .git above {}", env!("CARGO_MANIFEST_DIR"));
    }
    dir
}

/// Build output and dependencies are not this repo's habits, and `target`
/// alone holds more Rust than everything ever written here.
fn skipped(name: &str) -> bool {
    matches!(name, "target" | "node_modules") || name.starts_with('.')
}

fn walk(root: &Path, dir: &Path, out: &mut Vec<(String, String)>) {
    let Ok(entries) = std::fs::read_dir(dir) else {
        return;
    };
    for e in entries.flatten() {
        let path = e.path();
        let name = e.file_name().to_string_lossy().into_owned();
        if path.is_dir() {
            if !skipped(&name) {
                walk(root, &path, out);
            }
        } else if name.ends_with(".rs") {
            if let Ok(src) = std::fs::read_to_string(&path) {
                let rel = path
                    .strip_prefix(root)
                    .unwrap_or(&path)
                    .to_string_lossy()
                    .replace('\\', "/");
                out.push((rel, production_only(&src)));
            }
        }
    }
}

// ---------------------------------------------------------------------------
// Reading Rust
// ---------------------------------------------------------------------------

/// What a byte is doing, which is all any of this needs to know.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Kind {
    /// The compiler reads it.
    Code,
    /// Inside a string, raw string or char literal — including its quotes.
    Text,
    /// Inside a comment, doc comment included.
    Comment,
}

/// What each byte of a Rust file is doing.
fn kinds(src: &str) -> Vec<Kind> {
    let b = src.as_bytes();
    let mut out = vec![Kind::Code; b.len()];
    let mut i = 0;
    while i < b.len() {
        match b[i] {
            b'/' if b.get(i + 1) == Some(&b'/') => {
                while i < b.len() && b[i] != b'\n' {
                    out[i] = Kind::Comment;
                    i += 1;
                }
            }
            b'/' if b.get(i + 1) == Some(&b'*') => {
                // Counted, because Rust's block comments nest.
                let mut depth = 0usize;
                while i < b.len() {
                    if b[i] == b'/' && b.get(i + 1) == Some(&b'*') {
                        depth += 1;
                        out[i] = Kind::Comment;
                        out[i + 1] = Kind::Comment;
                        i += 2;
                    } else if b[i] == b'*' && b.get(i + 1) == Some(&b'/') {
                        depth -= 1;
                        out[i] = Kind::Comment;
                        out[i + 1] = Kind::Comment;
                        i += 2;
                        if depth == 0 {
                            break;
                        }
                    } else {
                        out[i] = Kind::Comment;
                        i += 1;
                    }
                }
            }
            b'r' if raw_hashes(b, i).is_some() => {
                let hashes = raw_hashes(b, i).unwrap_or(0);
                let close = format!("\"{}", "#".repeat(hashes));
                let from = i + hashes + 2;
                let end = src[from.min(b.len())..]
                    .find(&close)
                    .map(|o| from + o + close.len())
                    .unwrap_or(b.len());
                out[i..end].fill(Kind::Text);
                i = end;
            }
            b'"' => {
                out[i] = Kind::Text;
                i += 1;
                while i < b.len() {
                    out[i] = Kind::Text;
                    match b[i] {
                        b'\\' => {
                            if i + 1 < b.len() {
                                out[i + 1] = Kind::Text;
                            }
                            i += 2;
                        }
                        b'"' => {
                            i += 1;
                            break;
                        }
                        _ => i += 1,
                    }
                }
            }
            b'\'' if is_char_literal(src, b, i) => {
                out[i] = Kind::Text;
                i += 1;
                while i < b.len() {
                    out[i] = Kind::Text;
                    match b[i] {
                        b'\\' => {
                            if i + 1 < b.len() {
                                out[i + 1] = Kind::Text;
                            }
                            i += 2;
                        }
                        b'\'' => {
                            i += 1;
                            break;
                        }
                        _ => i += 1,
                    }
                }
            }
            _ => i += 1,
        }
    }
    out
}

/// `r"…"` or `r#"…"#` — and not the `r` in the middle of a word.
fn raw_hashes(b: &[u8], i: usize) -> Option<usize> {
    if b[i] != b'r' {
        return None;
    }
    if i > 0 && (b[i - 1].is_ascii_alphanumeric() || b[i - 1] == b'_') {
        return None;
    }
    let mut n = 0;
    while b.get(i + 1 + n) == Some(&b'#') {
        n += 1;
    }
    (b.get(i + 1 + n) == Some(&b'"')).then_some(n)
}

/// A quote that opens a character, not one that names a lifetime.
///
/// One `char`, then a closing quote. Measured in characters rather than bytes
/// because `'…'` is as valid as `'a'` and this file's neighbours are full of
/// them — read as a lifetime, its quote never closes and the rest of the file
/// is misread from there.
fn is_char_literal(src: &str, b: &[u8], i: usize) -> bool {
    match b.get(i + 1) {
        // `'\n'`, `'\''`, `'\u{1F}'` — an escape is only ever a literal.
        Some(&b'\\') => true,
        // The `'a` in `&'a str` has no closing quote after its one character.
        Some(_) => {
            let rest = &src[i + 1..];
            rest.chars()
                .next()
                .is_some_and(|c| rest.as_bytes().get(c.len_utf8()) == Some(&b'\''))
        }
        None => false,
    }
}

/// The same source with every `#[cfg(test)]` item cut out of it.
///
/// A file gated whole with an inner `#![cfg(test)]` — this one — comes back
/// empty, which is the honest reading: none of it is production code.
///
/// What is left is not valid Rust; an attribute stacked above a cut item is
/// left dangling. It does not need to be. It is something to search.
fn production_only(src: &str) -> String {
    let b = src.as_bytes();
    let kind = kinds(src);
    let mut keep = vec![true; b.len()];
    let mut i = 0;
    while i < b.len() {
        // A byte in the middle of a character is never the `#` of an attribute,
        // and slicing there would panic rather than fail an assertion.
        if kind[i] != Kind::Code || !src.is_char_boundary(i) {
            i += 1;
            continue;
        }
        let inner = src[i..].starts_with("#![cfg(");
        if !inner && !src[i..].starts_with("#[cfg(") {
            i += 1;
            continue;
        }
        let open = i + if inner { 2 } else { 1 };
        let Some(attr_end) = closed_by(b, &kind, open, b'[', b']') else {
            break;
        };
        // `not(test)` is the opposite claim. It appears nowhere in this repo
        // today; if it ever does it means "production", and must stay.
        let attr = &src[i..=attr_end];
        if !attr.contains("test") || attr.contains("not(test") {
            i = attr_end + 1;
            continue;
        }
        if inner {
            return String::new();
        }
        let Some(item_end) = end_of_item(b, &kind, attr_end + 1) else {
            break;
        };
        keep[i..=item_end].fill(false);
        i = item_end + 1;
    }
    // Every cut lands on an ASCII byte, so what is left is still text.
    String::from_utf8(
        b.iter()
            .zip(&keep)
            .filter(|(_, k)| **k)
            .map(|(c, _)| *c)
            .collect(),
    )
    .unwrap_or_default()
}

/// The index of the delimiter closing the one at `open`.
fn closed_by(b: &[u8], kind: &[Kind], open: usize, l: u8, r: u8) -> Option<usize> {
    let mut depth = 0usize;
    for i in open..b.len() {
        if kind[i] != Kind::Code {
            continue;
        }
        if b[i] == l {
            depth += 1;
        } else if b[i] == r {
            // Unbalanced is a file we cannot read, not a claim about it.
            depth = depth.checked_sub(1)?;
            if depth == 0 {
                return Some(i);
            }
        }
    }
    None
}

/// Where the item starting at `from` ends: its closing brace, or the semicolon
/// of one with no body (`#[cfg(test)] use super::*;`).
///
/// Brackets and parens are counted, so the `;` inside a `[u8; 4]` return type
/// is not mistaken for the end of the item.
fn end_of_item(b: &[u8], kind: &[Kind], from: usize) -> Option<usize> {
    let mut nested = 0usize;
    for i in from..b.len() {
        if kind[i] != Kind::Code {
            continue;
        }
        match b[i] {
            b'(' | b'[' => nested += 1,
            b')' | b']' => nested = nested.saturating_sub(1),
            b';' if nested == 0 => return Some(i),
            b'{' if nested == 0 => return closed_by(b, kind, i, b'{', b'}'),
            _ => {}
        }
    }
    None
}

/// How many times `needle` appears as the given kind of thing.
///
/// The kind is read at the first byte, which is what tells a spawn from a
/// comment describing one: `Command::new("ssh")` starts in code and
/// `// Command::new("ssh")` starts in a comment, even though both end in the
/// same string literal.
/// Whether this source names `ssh` as a program to run.
///
/// A quoted `"ssh"` mapped straight to a number is a scheme-to-port lookup —
/// `"ssh" => 22` next to `"https" => 443`. It names the protocol a URL is
/// written in, and there is nothing there to run: no argv, no host, no key.
/// `aura-egress` has one because it has to know which port a `git@host:repo`
/// remote will come back on before it decides whether to allow it.
///
/// Carved out of the rule rather than parked in a per-file allowlist, and
/// deliberately the same carve-out the TypeScript half makes
/// (`aura-shell/tests/support/soleSsh.ts`). An exemption would be per-path, so
/// the next port table written somewhere else fires the guard and earns a
/// second entry, and a list of files permitted to say `ssh` is precisely the
/// thing this test exists to stop growing.
fn names_ssh_as_a_program(src: &str) -> bool {
    let k = kinds(src);
    src.match_indices(r#""ssh""#)
        .filter(|(i, _)| k[*i] == Kind::Text)
        .any(|(i, _)| !maps_to_a_port(&src[i + r#""ssh""#.len()..]))
}

/// What follows a `"ssh"`, when what follows it is `=> 22` or `: 22`.
fn maps_to_a_port(after: &str) -> bool {
    let rest = after.trim_start();
    let rest = match rest.strip_prefix("=>").or_else(|| rest.strip_prefix(':')) {
        Some(rest) => rest,
        None => return false,
    };
    rest.trim_start()
        .chars()
        .next()
        .is_some_and(|c| c.is_ascii_digit())
}

fn occurrences(src: &str, needle: &str, kind: Kind) -> usize {
    let k = kinds(src);
    src.match_indices(needle).filter(|(i, _)| k[*i] == kind).count()
}

/// How many times this source *calls* `name`, ignoring where it defines it.
///
/// Word-bounded on the left, so `is_dialable` is not a call to `dial`; and an
/// import (`use …::{dial, dialable}`) is not one either, since it names the
/// function without reaching a machine.
fn calls(src: &str, name: &str) -> usize {
    let needle = format!("{name}(");
    let b = src.as_bytes();
    let k = kinds(src);
    src.match_indices(&needle)
        .filter(|(i, _)| k[*i] == Kind::Code)
        .filter(|(i, _)| *i == 0 || !(b[i - 1].is_ascii_alphanumeric() || b[i - 1] == b'_'))
        .filter(|(i, _)| !src[..*i].trim_end().ends_with("fn"))
        .count()
}

/// The body of a function, braces included, found by its signature's opening.
fn body_of(src: &str, signature: &str) -> Option<String> {
    let at = src.find(signature)?;
    let b = src.as_bytes();
    let kind = kinds(src);
    let open = (at..b.len()).find(|i| kind[*i] == Kind::Code && b[*i] == b'{')?;
    let close = closed_by(b, &kind, open, b'{', b'}')?;
    Some(src[open..=close].to_string())
}

// ---------------------------------------------------------------------------
// The reader itself
// ---------------------------------------------------------------------------

/// A guard that reads its corpus wrong passes for the wrong reason — the
/// quietest failure there is. So the reading is tested too.
mod reading {
    use super::*;

    #[test]
    fn test_code_is_cut_and_production_code_is_not() {
        let src = "pub fn real() { spawn(); }\n\
                   #[cfg(test)]\n\
                   mod tests {\n\
                       fn fake() { spawn(); }\n\
                   }\n\
                   pub fn also_real() {}";
        let out = production_only(src);
        assert!(out.contains("pub fn real"));
        assert!(out.contains("pub fn also_real"));
        assert!(!out.contains("mod tests"));
        assert!(!out.contains("fn fake"));
    }

    #[test]
    fn a_gated_function_goes_with_its_body() {
        // `cloudbox::ask` is exactly this shape: one `#[cfg(test)] async fn`
        // sitting among production ones.
        let src = "fn a() {}\n#[cfg(test)]\nasync fn gated() -> Result<(), ()> { reach() }\nfn b() {}";
        let out = production_only(src);
        assert!(out.contains("fn a()") && out.contains("fn b()"));
        assert!(!out.contains("gated") && !out.contains("reach"));
    }

    #[test]
    fn a_gated_import_ends_at_its_semicolon() {
        let src = "#[cfg(test)]\nuse super::*;\npub fn kept() {}";
        let out = production_only(src);
        assert!(!out.contains("use super"));
        assert!(out.contains("pub fn kept"));
    }

    #[test]
    fn a_file_gated_whole_is_no_production_code_at_all() {
        // This file. Without it the guard would police itself and fail on its
        // own fixtures.
        let src = "//! docs\n#![cfg(test)]\nfn f() { spawn(); }";
        assert_eq!(production_only(src), "");
    }

    #[test]
    fn a_brace_inside_a_string_does_not_end_an_item() {
        // The failure this is really about: tmux format strings are full of
        // unbalanced-looking braces, and one miscounted brace swallows the rest
        // of the file — after which every assertion above passes on nothing.
        let src = "#[cfg(test)]\n\
                   mod t {\n\
                       fn f() { let s = \"#{{pane_current_command}} } {\"; }\n\
                   }\n\
                   pub fn survives() { spawn(); }";
        let out = production_only(src);
        assert!(out.contains("pub fn survives"), "the file was swallowed: {out}");
        assert!(!out.contains("pane_current_command"));
    }

    #[test]
    fn a_semicolon_inside_an_attribute_string_does_not_end_an_item() {
        // `#[ignore = "needs a real box; set AURA_LIVE_MACHINE"]` sits between
        // the gate and the body of every live test in this module's neighbours.
        let src = "#[cfg(test)]\n\
                   #[ignore = \"needs a real box; set AURA_LIVE_MACHINE\"]\n\
                   fn live() { dial(m); }\n\
                   pub fn survives() {}";
        let out = production_only(src);
        assert!(out.contains("pub fn survives"));
        assert!(!out.contains("dial(m)"), "the body outlived its gate: {out}");
    }

    #[test]
    fn a_gate_that_is_not_about_tests_leaves_the_item_alone() {
        let src = "#[cfg(target_os = \"macos\")]\npub fn mac_only() { spawn(); }";
        assert!(production_only(src).contains("mac_only"));
    }

    #[test]
    fn an_and_gate_still_counts_as_a_test_gate() {
        // `#[cfg(all(test, debug_assertions))]` is already in this crate.
        let src = "#[cfg(all(test, debug_assertions))]\nmod t { fn f() {} }\npub fn kept() {}";
        let out = production_only(src);
        assert!(!out.contains("mod t"));
        assert!(out.contains("pub fn kept"));
    }

    #[test]
    fn a_character_that_is_not_one_byte_is_still_a_character() {
        // `'…'` read as a lifetime leaves a quote that never closes, and every
        // byte after it in the file is misread. This crate's prose is full of
        // them.
        let src = "fn f(c: char) -> bool { c == '…' || c == 'a' }\npub fn kept() {}";
        assert!(production_only(src).contains("pub fn kept"));
        let k = kinds(src);
        let at = src.find('…').expect("the char");
        assert_eq!(k[at], Kind::Text);
        assert_eq!(k[src.find("kept").expect("kept")], Kind::Code);
    }

    #[test]
    fn a_lifetime_is_not_an_unterminated_character() {
        // `&'a str` would otherwise open a char literal and read the rest of
        // the file as text — the same silent pass as the brace above.
        let src = "fn f<'a>(s: &'a str) -> &'a str { s }\npub fn kept() {}";
        assert!(production_only(src).contains("pub fn kept"));
        assert!(
            kinds(src).iter().all(|k| *k == Kind::Code),
            "a lifetime was read as text"
        );
    }

    #[test]
    fn a_raw_string_is_text_and_the_code_after_it_is_not() {
        let src = "let re = r#\"fn dial(\"#; pub fn kept() {}";
        assert_eq!(calls(src, "dial"), 0, "a call was found inside a raw string");
        let at = src.find("kept").expect("kept");
        assert_eq!(kinds(src)[at], Kind::Code, "the raw string never closed");
    }

    #[test]
    fn a_comment_is_not_a_call_and_a_comment_is_not_a_spawn() {
        let src = "// this used to dial(m, x) directly\n\
                   // Command::new(\"ssh\")\n\
                   fn f() { other(); }";
        assert_eq!(calls(src, "dial"), 0);
        assert_eq!(occurrences(src, SPAWN, Kind::Code), 0);
    }

    #[test]
    fn a_spawn_is_found_where_it_really_is() {
        let src = "fn dial() { Command::new(\"ssh\").args(a).output() }";
        assert_eq!(occurrences(src, SPAWN, Kind::Code), 1);
        assert_eq!(occurrences(src, "\"ssh\"", Kind::Text), 1);
    }

    #[test]
    fn defining_a_function_is_not_calling_it() {
        let src = "pub(crate) async fn dial(m: &Machine) -> Ran { run() }\nfn f() { dial(m); }";
        assert_eq!(calls(src, "dial"), 1);
    }

    #[test]
    fn a_longer_name_that_ends_in_the_short_one_is_not_it() {
        let src = "fn f() { is_dialable(m); redial(m); }";
        assert_eq!(calls(src, "dial"), 0);
    }

    #[test]
    fn importing_a_function_is_not_reaching_a_machine() {
        let src = "use crate::cloudbox::{dial, dialable, Ran};\npub fn f() {}";
        assert_eq!(calls(src, "dial"), 0);
    }

    #[test]
    fn a_body_is_read_to_its_own_closing_brace() {
        let src = "pub async fn box_stop(a: String) -> Result<(), String> {\n    \
                   Place::at_machine(&a)?.stop(&a).await\n}\npub fn after() {}";
        let body = body_of(src, "pub async fn box_stop(").expect("a body");
        assert!(body.starts_with('{') && body.ends_with('}'));
        assert!(body.contains("Place::at_machine"));
        assert!(!body.contains("after"));
    }
}
