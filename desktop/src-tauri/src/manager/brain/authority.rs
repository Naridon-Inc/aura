//! What an agent run is allowed to do — decided before anyone is asked.
//!
//! [`gate`](super::gate) answers "does the human say yes". This answers the
//! prior question: "is this even on the table". The two compose in that
//! order and the order is the point — a capability the project refused is
//! not something a tired person can click past at 2am, and a capability the
//! project allowed outright does not need a card at all.
//!
//! # Why this is not roles
//!
//! Classic RBAC assigns durable roles to durable subjects: this person is a
//! senior engineer for the next two years. An agent has no career. It has a
//! task, and it is trustworthy *for that task*, for the twenty minutes the
//! task takes. So the subject here is the **run**, not the agent brand, and
//! a grant expires with the run that carried it rather than sitting in a
//! table until someone remembers to revoke it.
//!
//! The second reason is blunter: an agent runs *as you*. It holds your
//! shell, your keys, your git credential. Giving it a "role" while it holds
//! your credential writes a label, not a boundary. What can actually be
//! bounded is the specific act — and the acts worth bounding are the ones
//! only Aura can recognise.
//!
//! # The three capabilities, and why these three
//!
//! Each one is enforceable *today* because the machinery it needs already
//! exists in this codebase. Nothing here is aspirational:
//!
//!   - [`Capability::DeleteExportedSymbol`] — a write that removes a
//!     symbol other code could be calling. This is the one no other tool
//!     can do: GitHub cannot say "don't delete an exported function"
//!     because it does not know what a function is. Aura does.
//!   - [`Capability::WriteOutsideClaimedZone`] — a write into a path a
//!     *different* live session claimed through the sentinel. Zones already
//!     exist, already expire with their owner, and already have a
//!     `Warn`/`Block` mode; this makes an agent honour them.
//!   - [`Capability::DispatchToMachine`] — placing work on a box that is
//!     not this one. The most consequential thing in the tool set and,
//!     until now, the only one with no gate in front of it at all.
//!
//! Deliberately *not* here: network egress, which `aura-egress` already
//! enforces at the place boundary with real nftables/pf rules, and a spend
//! ceiling, which needs `token_usage` to have a writer first. Adding a
//! second, weaker copy of egress here would be theatre.
//!
//! # Where the rules live
//!
//! `.aura/settings.toml`, under `[authority]` — the same committed,
//! reviewable file that already carries `[worktree]` and `[env]`. A rule is
//! a line in a diff someone approved, not a row in a database nobody reads.
//! Missing file, missing section and unparseable section all mean the same
//! thing: [`Stance::Ask`] on everything, which is the behaviour that
//! shipped before this module existed.

use std::collections::BTreeMap;
use std::path::{Path, PathBuf};

/// An act an agent might attempt that is worth deciding about separately.
///
/// Kept small on purpose. Every variant here must be (a) recognisable from
/// what the agent actually asked to do, and (b) enforceable at a real choke
/// point. A capability nobody can detect is a promise, not a control.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord)]
pub enum Capability {
    /// A write whose new content drops a top-level symbol that the old
    /// content exported.
    DeleteExportedSymbol,
    /// A write into a path claimed by a different live sentinel session.
    WriteOutsideClaimedZone,
    /// Placing work on a machine other than this one.
    DispatchToMachine,
}

impl Capability {
    /// The key this capability is spelled with in `[authority]`.
    pub fn key(self) -> &'static str {
        match self {
            Self::DeleteExportedSymbol => "delete_exported_symbol",
            Self::WriteOutsideClaimedZone => "write_outside_claimed_zone",
            Self::DispatchToMachine => "dispatch_to_machine",
        }
    }

    /// Every capability, so a caller can round-trip the whole set without
    /// this list drifting out of sync with the enum.
    pub fn all() -> [Capability; 3] {
        [
            Self::DeleteExportedSymbol,
            Self::WriteOutsideClaimedZone,
            Self::DispatchToMachine,
        ]
    }

    /// How to describe the act to the person being asked, in the second
    /// person, without jargon. This string ends up in front of someone who
    /// did not read this file.
    pub fn describe(self) -> &'static str {
        match self {
            Self::DeleteExportedSymbol => {
                "delete something other code may be calling"
            }
            Self::WriteOutsideClaimedZone => {
                "edit a file a teammate is holding"
            }
            Self::DispatchToMachine => "send work to another machine",
        }
    }
}

/// What the project has decided about a capability, ahead of time.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub enum Stance {
    /// Permitted without a prompt.
    Allow,
    /// Defer to the human. The default, and what the app did before
    /// `[authority]` existed.
    #[default]
    Ask,
    /// Refused. No prompt is shown, because there is no answer that would
    /// let it through — offering a card the user cannot say yes to is worse
    /// than saying no plainly.
    Refuse,
}

impl Stance {
    fn parse(raw: &str) -> Option<Stance> {
        match raw.trim().trim_matches(['"', '\'']).to_ascii_lowercase().as_str() {
            "allow" => Some(Stance::Allow),
            "ask" => Some(Stance::Ask),
            "refuse" | "deny" => Some(Stance::Refuse),
            _ => None,
        }
    }
}

/// The project's standing decisions, as read from `[authority]`.
///
/// Absent keys are [`Stance::Ask`], so a project that writes one rule gets
/// exactly one behaviour change rather than opting into all three.
#[derive(Debug, Clone, Default)]
pub struct Rules {
    stances: BTreeMap<&'static str, Stance>,
}

impl Rules {
    /// What the project says about this capability.
    pub fn stance(&self, cap: Capability) -> Stance {
        self.stances.get(cap.key()).copied().unwrap_or_default()
    }

    /// Read `<repo_root>/.aura/settings.toml`.
    ///
    /// Every failure — no file, no section, a key nobody recognises, a
    /// value that isn't one of the three words — lands on `Ask`. This
    /// parses one flat section rather than pulling in a TOML dependency the
    /// crate does not otherwise carry, and it is deliberately forgiving in
    /// the same way `worktree_scripts` is forgiving about a bare
    /// `[worktree]`: a typo in a config file must not silently *widen* what
    /// an agent may do, and `Ask` is the narrow answer.
    pub fn load(repo_root: &Path) -> Rules {
        let path = repo_root.join(".aura").join("settings.toml");
        let Ok(body) = std::fs::read_to_string(path) else {
            return Rules::default();
        };
        Rules::from_toml(&body)
    }

    /// [`Rules::load`] without the disk — the same parser, given the file's
    /// text. Public so the gate's own tests can pin the composition of
    /// rules and prompts without writing a settings file first.
    pub fn from_toml(body: &str) -> Rules {
        let mut stances = BTreeMap::new();
        let mut in_section = false;
        for line in body.lines() {
            let line = line.trim();
            if line.starts_with('[') {
                in_section = line.starts_with("[authority]");
                continue;
            }
            if !in_section || line.is_empty() || line.starts_with('#') {
                continue;
            }
            let Some((key, value)) = line.split_once('=') else {
                continue;
            };
            // Strip a trailing `# comment` the way the loose `[worktree]`
            // parser does, so `ask # for now` is not read as a value.
            let value = value.split('#').next().unwrap_or("");
            let key = key.trim();
            let Some(cap) = Capability::all().into_iter().find(|c| c.key() == key) else {
                continue;
            };
            if let Some(stance) = Stance::parse(value) {
                stances.insert(cap.key(), stance);
            }
        }
        Rules { stances }
    }
}

/// The outcome of asking the authority layer about one attempted act.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Verdict {
    /// Nothing to decide — this act needs no capability.
    NotGoverned,
    /// The project permits it outright; do not prompt.
    Allow,
    /// The project defers; ask the human, then honour the answer.
    Ask(Capability),
    /// The project refuses. Carry the sentence to the agent verbatim.
    Refuse(String),
}

/// Decide about one act.
///
/// `detail` is the concrete thing that triggered the capability — the
/// symbol name, the teammate's session, the machine — and is folded into
/// the refusal so the agent's transcript says *what* was refused rather
/// than only that something was.
pub fn decide(rules: &Rules, cap: Capability, detail: &str) -> Verdict {
    match rules.stance(cap) {
        Stance::Allow => Verdict::Allow,
        Stance::Ask => Verdict::Ask(cap),
        Stance::Refuse => Verdict::Refuse(format!(
            "Refused: this project does not let an agent {} ({detail}). \
             The rule is `{} = \"refuse\"` under `[authority]` in \
             .aura/settings.toml — change it there, in a commit someone \
             can review, rather than here.",
            cap.describe(),
            cap.key(),
        )),
    }
}

// ─── Recognising the acts ──────────────────────────────────────────────────

/// Top-level exported symbol names in a source file.
///
/// A deliberately shallow reader, and worth being honest about why: the
/// full AST index lives in the `aura` binary and shelling out to it on
/// every keystroke-speed write would make edits feel broken. What matters
/// at this choke point is not a perfect symbol table but a *conservative*
/// one — a name found here is genuinely exported, so a deletion it flags is
/// a real deletion. Names it misses fall through to the commit-time
/// deletion guard, which does have the full index.
///
/// Only column-zero declarations count. An indented `fn` is a method or a
/// closure; deleting one is refactoring, and prompting on it would train
/// people to click through the prompt that matters.
pub fn exported_symbols(source: &str) -> Vec<String> {
    let mut out = Vec::new();
    for line in source.lines() {
        // Column zero only.
        if line.starts_with([' ', '\t']) || line.is_empty() {
            continue;
        }
        let Some(name) = exported_name(line) else {
            continue;
        };
        if !out.iter().any(|n: &String| n == name) {
            out.push(name.to_string());
        }
    }
    out
}

/// The exported name a single top-level line declares, if it declares one.
fn exported_name(line: &str) -> Option<&str> {
    // Rust and TypeScript both mark the export in the leading tokens, so
    // one pass over the prefix words covers both without a per-language
    // branch. `def`/`class` are unprefixed in Python, where a leading
    // underscore is the convention for "not public".
    let mut words = line.split_whitespace().peekable();
    let mut exported = false;
    let mut python = false;

    while let Some(word) = words.next() {
        match word {
            // `pub`, `pub(crate)` — anything that starts a visibility.
            w if w == "pub" || w.starts_with("pub(") => exported = true,
            "export" => exported = true,
            // Modifiers that can sit between the export and the keyword.
            "default" | "async" | "unsafe" | "extern" | "declare" => {}
            // `const` is both, and which one depends on what follows it.
            // `pub const fn alpha()` declares a function and `const` is a
            // modifier; `pub const ALPHA: u8` and `export const beta = 1`
            // declare the symbol themselves. Look rather than guess — the
            // guess is what made a TypeScript `export const` invisible.
            "const" => {
                if !matches!(words.peek(), Some(&"fn") | Some(&"unsafe") | Some(&"extern")) {
                    return exported.then(|| ident(words.next()?)).flatten();
                }
            }
            "fn" | "struct" | "enum" | "trait" | "type" | "union" => {
                return exported.then(|| ident(words.next()?)).flatten();
            }
            "function" | "class" | "interface" => {
                return exported.then(|| ident(words.next()?)).flatten();
            }
            // `static` never appears at column zero in TypeScript — it is a
            // class member there, and a class member is indented.
            "let" | "var" | "static" => {
                return exported.then(|| ident(words.next()?)).flatten();
            }
            "def" => {
                python = true;
                let name = ident(words.next()?)?;
                // `_private` by convention; `__init__` is a method, and at
                // column zero it would not be one anyway.
                return (!name.starts_with('_')).then_some(name);
            }
            _ => {
                if python {
                    return None;
                }
                // An unrecognised leading word before any keyword means
                // this is not a declaration line we understand. Bail rather
                // than guess — a false positive here blocks a legitimate
                // edit, which is the expensive mistake.
                if !exported {
                    return None;
                }
            }
        }
    }
    None
}

/// The bare identifier at the head of a declaration token, minus the
/// punctuation a declaration can carry: `foo(`, `Foo<T>`, `foo:`, `foo{`.
fn ident(token: &str) -> Option<&str> {
    let end = token
        .find(|c: char| !(c.is_alphanumeric() || c == '_'))
        .unwrap_or(token.len());
    let name = &token[..end];
    (!name.is_empty()).then_some(name)
}

/// Exported symbols present in `before` and gone from `after`.
///
/// Empty when the file is new, when nothing was exported, or when the write
/// only adds — the common case, which must cost nothing.
pub fn symbols_dropped(before: &str, after: &str) -> Vec<String> {
    let kept = exported_symbols(after);
    exported_symbols(before)
        .into_iter()
        .filter(|name| !kept.contains(name))
        .collect()
}

/// A live zone claimed by a session other than `session_id` that covers
/// this path, if there is one.
///
/// Mirrors the CLI's own matcher exactly — zone patterns are repo-relative
/// prefixes, with a trailing `*` stripped — because two implementations
/// that disagree about what a zone covers is worse than no zone at all.
/// Liveness is the sentinel's business and is already enforced by pruning:
/// a zone whose owner died is removed from disk, so a file that is here is
/// a claim that still binds.
pub fn zone_holder(repo_root: &Path, session_id: &str, path: &Path) -> Option<ZoneHolder> {
    let rel = path
        .strip_prefix(repo_root)
        .unwrap_or(path)
        .to_string_lossy()
        .replace('\\', "/");

    let dir = repo_root
        .join(".aura")
        .join("sentinel")
        .join("zones");
    let entries = std::fs::read_dir(dir).ok()?;

    for entry in entries.filter_map(|e| e.ok()) {
        let file = entry.path();
        if file.extension().and_then(|s| s.to_str()) != Some("json") {
            continue;
        }
        let Ok(body) = std::fs::read_to_string(&file) else {
            continue;
        };
        let Ok(zone) = serde_json::from_str::<serde_json::Value>(&body) else {
            continue;
        };
        let owner = zone.get("session_id").and_then(|v| v.as_str()).unwrap_or("");
        if owner.is_empty() || owner == session_id {
            continue; // Own zone, or a record too broken to attribute.
        }
        let patterns = zone
            .get("patterns")
            .and_then(|v| v.as_array())
            .map(|a| a.iter().filter_map(|v| v.as_str()).collect::<Vec<_>>())
            .unwrap_or_default();
        for pattern in patterns {
            if rel.starts_with(pattern.trim_end_matches('*')) {
                return Some(ZoneHolder {
                    session_id: owner.to_string(),
                    label: zone
                        .get("label")
                        .and_then(|v| v.as_str())
                        .map(str::to_string),
                });
            }
        }
    }
    None
}

/// Who is holding a path, for the sentence shown to whoever is asked.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ZoneHolder {
    pub session_id: String,
    pub label: Option<String>,
}

impl ZoneHolder {
    /// How to name the holder in a prompt: their stated purpose if they
    /// gave one, otherwise the session id, which is at least real.
    pub fn describe(&self) -> String {
        match &self.label {
            Some(label) => format!("{} ({})", label, self.session_id),
            None => self.session_id.clone(),
        }
    }
}

/// Nearest ancestor holding a `.git` — the repo or worktree a file belongs
/// to. `.git` is a directory in a clone and a file in a worktree, so both
/// count. Rules are per-project, and a worktree is its own project here for
/// the same reason its snapshots are its own.
pub fn repo_root_for(path: &Path) -> Option<PathBuf> {
    let start = if path.is_dir() { path } else { path.parent()? };
    start
        .ancestors()
        .find(|dir| dir.join(".git").exists())
        .map(Path::to_path_buf)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn an_absent_section_asks_about_everything() {
        // The pre-`[authority]` behaviour, which is what a project that
        // never opts in must keep getting.
        let rules = Rules::from_toml("[worktree]\nsetup = \"npm install\"\n");
        for cap in Capability::all() {
            assert_eq!(rules.stance(cap), Stance::Ask, "{}", cap.key());
        }
    }

    #[test]
    fn one_rule_changes_one_capability() {
        let rules = Rules::from_toml("[authority]\ndispatch_to_machine = \"refuse\"\n");
        assert_eq!(rules.stance(Capability::DispatchToMachine), Stance::Refuse);
        assert_eq!(
            rules.stance(Capability::DeleteExportedSymbol),
            Stance::Ask,
            "writing one rule must not opt the project into the other two"
        );
    }

    #[test]
    fn keys_outside_the_section_are_not_authority_rules() {
        // A `[worktree]` key that happens to share a name must not be read
        // as a stance — sections are the only scoping this format has.
        let rules = Rules::from_toml(
            "[authority]\ndelete_exported_symbol = \"allow\"\n\
             [worktree]\ndispatch_to_machine = \"allow\"\n",
        );
        assert_eq!(rules.stance(Capability::DeleteExportedSymbol), Stance::Allow);
        assert_eq!(rules.stance(Capability::DispatchToMachine), Stance::Ask);
    }

    #[test]
    fn an_unreadable_value_narrows_rather_than_widens() {
        // A typo must never be the reason an agent got a capability.
        let rules = Rules::from_toml("[authority]\ndispatch_to_machine = \"allwo\"\n");
        assert_eq!(rules.stance(Capability::DispatchToMachine), Stance::Ask);
    }

    #[test]
    fn a_trailing_comment_is_not_part_of_the_value() {
        let rules = Rules::from_toml("[authority]\ndispatch_to_machine = allow # for the demo\n");
        assert_eq!(rules.stance(Capability::DispatchToMachine), Stance::Allow);
    }

    #[test]
    fn a_refusal_names_the_rule_that_caused_it() {
        let rules = Rules::from_toml("[authority]\ndispatch_to_machine = \"refuse\"\n");
        let Verdict::Refuse(msg) = decide(&rules, Capability::DispatchToMachine, "build-box-1")
        else {
            panic!("a refuse stance must produce a refusal");
        };
        // The agent shows this to the user. It has to say what was refused
        // and where to change it, or it reads as a malfunction.
        assert!(msg.contains("build-box-1"), "{msg}");
        assert!(msg.contains("dispatch_to_machine"), "{msg}");
        assert!(msg.contains("settings.toml"), "{msg}");
    }

    #[test]
    fn exported_symbols_are_found_across_the_languages_we_ship() {
        let rust = exported_symbols("pub fn alpha() {}\npub(crate) struct Beta;\nfn private() {}");
        assert_eq!(rust, vec!["alpha", "Beta"]);

        let ts = exported_symbols(
            "export function alpha() {}\nexport const beta = 1\nfunction hidden() {}",
        );
        assert_eq!(ts, vec!["alpha", "beta"]);

        let py = exported_symbols("def alpha():\n    pass\ndef _hidden():\n    pass");
        assert_eq!(py, vec!["alpha"]);
    }

    #[test]
    fn const_is_read_as_a_modifier_or_a_declaration_by_what_follows_it() {
        // The same word, two meanings. Reading it as a modifier everywhere
        // made `export const` invisible; reading it as a declaration
        // everywhere would name a Rust const fn "fn".
        assert_eq!(exported_symbols("pub const fn alpha() {}"), vec!["alpha"]);
        assert_eq!(exported_symbols("pub const ALPHA: u8 = 1;"), vec!["ALPHA"]);
        assert_eq!(exported_symbols("pub static REGISTRY: u8 = 1;"), vec!["REGISTRY"]);
    }

    #[test]
    fn an_indented_declaration_is_not_a_top_level_export() {
        // Methods and closures are refactoring surface. Prompting on them
        // would bury the prompt that matters.
        assert!(exported_symbols("impl T {\n    pub fn method() {}\n}").is_empty());
    }

    #[test]
    fn adding_code_drops_nothing() {
        let before = "pub fn alpha() {}\n";
        let after = "pub fn alpha() {}\npub fn beta() {}\n";
        assert!(
            symbols_dropped(before, after).is_empty(),
            "the common case — a write that only adds — must cost nothing"
        );
    }

    #[test]
    fn removing_an_export_is_seen_but_renaming_the_body_is_not() {
        let before = "pub fn alpha() { one() }\npub fn beta() {}\n";
        let after = "pub fn beta() {}\n";
        assert_eq!(symbols_dropped(before, after), vec!["alpha"]);

        let edited = "pub fn alpha() { two() }\npub fn beta() {}\n";
        assert!(
            symbols_dropped(before, edited).is_empty(),
            "changing what a function does is not deleting it"
        );
    }

    #[test]
    fn dropping_a_private_function_is_not_governed() {
        let before = "fn helper() {}\npub fn alpha() {}\n";
        let after = "pub fn alpha() {}\n";
        assert!(
            symbols_dropped(before, after).is_empty(),
            "nothing outside the file could have been calling it"
        );
    }

    #[test]
    fn a_zone_claimed_by_someone_else_holds_the_path() {
        let tmp = std::env::temp_dir().join(format!("aura-authority-zone-{}", std::process::id()));
        let zones = tmp.join(".aura").join("sentinel").join("zones");
        std::fs::create_dir_all(&zones).unwrap();
        std::fs::write(
            zones.join("zone-abc.json"),
            r#"{"zone_id":"zone-abc","session_id":"other","patterns":["src/auth"],"mode":"Block","label":"auth refactor"}"#,
        )
        .unwrap();

        let held = zone_holder(&tmp, "mine", &tmp.join("src/auth/login.rs"));
        assert_eq!(held.as_ref().map(|h| h.session_id.as_str()), Some("other"));
        assert!(held.unwrap().describe().contains("auth refactor"));

        assert!(
            zone_holder(&tmp, "mine", &tmp.join("src/billing/mod.rs")).is_none(),
            "a zone must not reach past the prefix it claimed"
        );
        assert!(
            zone_holder(&tmp, "other", &tmp.join("src/auth/login.rs")).is_none(),
            "your own zone never blocks you"
        );
        let _ = std::fs::remove_dir_all(&tmp);
    }

    #[test]
    fn no_zones_directory_holds_nothing() {
        let tmp = std::env::temp_dir().join(format!("aura-authority-nozone-{}", std::process::id()));
        std::fs::create_dir_all(&tmp).unwrap();
        assert!(zone_holder(&tmp, "mine", &tmp.join("src/main.rs")).is_none());
        let _ = std::fs::remove_dir_all(&tmp);
    }
}
