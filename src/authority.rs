//! What Aura will actually stop, and who can lift it.
//!
//! `aura status` used to answer the authority question with one line —
//! `Gatekeeper Strict Mode: ON (Blocking)` — which is true about a config
//! flag and says nothing a person can act on. It does not say whether a
//! human locked the flag or a machine can flip it back; it does not name
//! one thing strict mode actually blocks; it never mentions that delete,
//! hard reset and force-push need a signed human grant that no logged
//! intent can substitute for; and it reports "Blocking" in a repository
//! whose pre-commit hook was never installed, where the answer is that
//! nothing is blocked at all.
//!
//! This module reads the four places the real answer lives — the config
//! flags, the passcode lock, the installed hook, and the pending grant
//! store — and states them together. It reports the escape hatches too.
//! A gate you can step around is still worth having; one whose escape
//! hatch is undocumented is a gate you think you have.
//!
//! Every sentence here is derived, never asserted: the commit-time list
//! is filtered by the flags that actually disable each check (dev mode
//! turns the secret guard off; the house-style gate needs its own
//! opt-in), and the hook facts come from parsing the hook file this
//! repository will really run.

use std::path::{Path, PathBuf};

use crate::grants::{self, HumanGrant, ProtectedOp};

/// Everything needed to describe this repository's authority posture.
/// Passed in rather than read from globals so the whole thing is
/// testable against a temporary directory.
pub struct Inputs<'a> {
    pub repo_root: &'a Path,
    /// Where git will really run hooks from (`git rev-parse --git-path
    /// hooks`), which in a worktree is not `.git/hooks`.
    pub hooks_dir: &'a Path,
    pub strict: bool,
    pub locked: bool,
    pub dev_mode: bool,
    pub taste_strict: bool,
}

/// The answer to "what will Aura stop, and who can lift it".
pub struct Authority {
    pub strict: bool,
    pub locked: bool,
    pub commit_gate: CommitGate,
    pub tool_gate: ToolGate,
    /// Commit-time checks that are armed right now, in plain words.
    pub blocks: Vec<String>,
    /// Checks that exist but will not fire here, each with the reason.
    pub allows: Vec<(String, String)>,
    /// Grants sitting in `.aura/grants/pending`, newest last.
    pub grants: Vec<GrantState>,
}

/// What the installed pre-commit hook really does. `installed: false`
/// is the important case: strict mode is a flag, the hook is the thing
/// that enforces it, and without one every commit-time check below is
/// off no matter what the flag says.
pub struct CommitGate {
    pub installed: bool,
    pub path: PathBuf,
    /// Environment variable that makes the hook exit before it checks
    /// anything, when the hook honours one.
    pub skip_env: Option<String>,
    /// Seconds after which the hook gives up and lets the commit
    /// through, when it is written to do that.
    pub timeout_secs: Option<u64>,
}

/// Whether anything stands between an agent's tool call and the file
/// system, and whether that thing is the one that enforces grants.
///
/// The grant rule lives in `aura validate-tool`, wired as a PreToolUse
/// hook by `aura enable`. Where it is not wired, delete / reset /
/// force-push are not refused and no grant is looked for — so a screen
/// that states the rule unconditionally is describing a product, not
/// this repository. Both `settings.json` (checked in, shared) and
/// `settings.local.json` (this machine only) count: a hook in either
/// one really runs.
pub struct ToolGate {
    /// `aura validate-tool` runs before each tool call here.
    pub grants_enforced: bool,
    /// Some other PreToolUse hook is wired — including Aura's own app
    /// gatekeeper, which gates by its own rules and knows nothing about
    /// grants.
    pub other_hook: bool,
}

/// One pending grant, judged the same way `aura grant list` judges it so
/// the two can never disagree.
pub struct GrantState {
    pub id: String,
    pub operation: String,
    pub target: String,
    pub issued_by: String,
    /// Seconds until it expires; negative once it has.
    pub expires_in: i64,
    /// `None` when the grant would be accepted, otherwise why it would
    /// not be.
    pub problem: Option<String>,
}

impl GrantState {
    pub fn live(&self) -> bool {
        self.problem.is_none() && self.expires_in > 0
    }
}

/// The three operations no agent can authorize for itself.
pub const PROTECTED: [ProtectedOp; 3] = [
    ProtectedOp::Delete,
    ProtectedOp::Reset,
    ProtectedOp::ForcePush,
];

pub fn read(i: Inputs) -> Authority {
    let commit_gate = read_commit_gate(i.hooks_dir);
    let (blocks, allows) = commit_checks(&i, &commit_gate);
    Authority {
        strict: i.strict,
        locked: i.locked,
        tool_gate: read_tool_gate(i.repo_root),
        commit_gate,
        blocks,
        allows,
        grants: read_grants(i.repo_root),
    }
}

const VALIDATE_TOOL: &str = "aura validate-tool";

fn read_tool_gate(repo_root: &Path) -> ToolGate {
    let mut gate = ToolGate { grants_enforced: false, other_hook: false };
    for name in ["settings.json", "settings.local.json"] {
        let path = repo_root.join(".claude").join(name);
        let Ok(raw) = std::fs::read_to_string(&path) else { continue };
        let Ok(v) = serde_json::from_str::<serde_json::Value>(&raw) else { continue };
        let Some(entries) = v
            .get("hooks")
            .and_then(|h| h.get("PreToolUse"))
            .and_then(|p| p.as_array())
        else {
            continue;
        };
        for cmd in entries
            .iter()
            .filter_map(|e| e.get("hooks").and_then(|h| h.as_array()))
            .flatten()
            .filter_map(|h| h.get("command").and_then(|c| c.as_str()))
        {
            if cmd.contains(VALIDATE_TOOL) {
                gate.grants_enforced = true;
            } else {
                gate.other_hook = true;
            }
        }
    }
    gate
}

fn read_commit_gate(hooks_dir: &Path) -> CommitGate {
    let path = hooks_dir.join("pre-commit");
    let Ok(text) = std::fs::read_to_string(&path) else {
        return CommitGate { installed: false, path, skip_env: None, timeout_secs: None };
    };
    // `capture-context` is the marker `HookInstaller::enable` writes and
    // the command that runs every commit-time check. A pre-commit hook
    // that belongs to something else entirely is not Aura's gate.
    let installed = text.contains("capture-context");
    let skip_env = if text.contains("AURA_SKIP") { Some("AURA_SKIP".to_string()) } else { None };
    CommitGate { installed, path, skip_env, timeout_secs: hook_timeout(&text) }
}

/// The seconds in `timeout <n> aura …`, but only when the hook also
/// treats a timeout as success. A hook that times out and then aborts
/// the commit is strict; one that times out and proceeds has a time
/// limit on its own guarantee, and that is what is worth saying.
///
/// The pair has to be found rather than taken from the first `timeout`
/// word: real hooks probe for the GNU binary first (`command -v gtimeout
/// >/dev/null`), so the first match is followed by a redirect, not a
/// number.
fn hook_timeout(text: &str) -> Option<u64> {
    if !(text.contains("124") && text.contains("exit 0")) {
        return None;
    }
    let words: Vec<&str> = text.split_whitespace().collect();
    words.windows(2).find_map(|w| {
        (w[0].ends_with("timeout"))
            .then(|| w[1].parse::<u64>().ok())
            .flatten()
    })
}

/// The commit-time checks, split into the ones that will fire here and
/// the ones that will not. Each line names a consequence a person can
/// picture, not the gate that produces it.
fn commit_checks(i: &Inputs, gate: &CommitGate) -> (Vec<String>, Vec<(String, String)>) {
    let mut blocks = Vec::new();
    let mut allows = Vec::new();

    if !i.strict {
        allows.push((
            "every check below".to_string(),
            "strict mode is off, so Aura reports these and lets the commit through".to_string(),
        ));
        return (blocks, allows);
    }
    if !gate.installed {
        allows.push((
            "every check below".to_string(),
            "no Aura pre-commit hook is installed in this repository — run `aura enable`"
                .to_string(),
        ));
        return (blocks, allows);
    }

    blocks.push("a function or class disappears with no reason on record".to_string());
    blocks.push("a changed file has no intent explaining it".to_string());
    blocks.push("the commit touches files the intent never declared".to_string());
    blocks.push("the stated intent does not name what actually changed".to_string());
    blocks.push(
        "a security-relevant call is dropped from a function that stayed".to_string(),
    );

    if i.dev_mode {
        allows.push((
            "a hard-coded secret".to_string(),
            "dev mode is on, which turns the secret check off".to_string(),
        ));
    } else {
        blocks.push("a hard-coded secret in the staged code".to_string());
    }

    if i.dev_mode {
        allows.push((
            "house-style violations".to_string(),
            "dev mode is on, which skips the style check".to_string(),
        ));
    } else if i.taste_strict {
        blocks.push("a change that breaks this project's own house style".to_string());
    } else {
        allows.push((
            "house-style violations".to_string(),
            "reported but not enforced until `taste_strict` is turned on".to_string(),
        ));
    }

    (blocks, allows)
}

fn read_grants(repo_root: &Path) -> Vec<GrantState> {
    let now = now_secs() as i64;
    grants::list_pending(repo_root)
        .into_iter()
        .map(|g| judge(repo_root, g, now))
        .collect()
}

fn judge(repo_root: &Path, g: HumanGrant, now: i64) -> GrantState {
    let targets = vec![g.target.clone()];
    let problem = match ProtectedOp::parse(&g.operation) {
        None => Some(format!("unknown operation `{}`", g.operation)),
        Some(op) => grants::check_grant(repo_root, &g, op, &targets).err(),
    };
    GrantState {
        id: g.grant_id,
        operation: g.operation,
        target: g.target,
        issued_by: g.issued_by,
        expires_in: g.expires_at as i64 - now,
        problem,
    }
}

fn now_secs() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0)
}

/// The authority picture as plain lines, ready to print under a heading.
/// Indentation is the caller's business; colour is nobody's — these are
/// sentences, and they are the same sentences the JSON and the desktop
/// carry.
pub fn lines(a: &Authority) -> Vec<String> {
    let mut out = Vec::new();

    out.push(match (a.strict, a.locked) {
        (true, true) => {
            "Strict mode is on and passcode-locked — nothing on this machine, agent \
             included, can turn it off."
                .to_string()
        }
        (true, false) => {
            "Strict mode is on, but not locked — anything on this machine can turn it \
             off. `aura config set strict-mode true` from a terminal locks it behind a \
             passcode."
                .to_string()
        }
        (false, _) => {
            "Strict mode is off — Aura watches and records, and stops nothing."
                .to_string()
        }
    });

    if !a.commit_gate.installed {
        out.push(format!(
            "No Aura pre-commit hook at {} — nothing runs when you commit. `aura enable` \
             installs it.",
            a.commit_gate.path.display()
        ));
    }

    if !a.blocks.is_empty() {
        out.push(format!("Stops a commit when: {}.", join_clauses(&a.blocks)));
    }
    for (what, why) in &a.allows {
        out.push(format!("Lets through: {what} — {why}."));
    }

    if let Some(env) = &a.commit_gate.skip_env {
        out.push(format!(
            "Escape hatch: setting {env} skips every commit-time check above.",
        ));
    }
    if let Some(secs) = a.commit_gate.timeout_secs {
        out.push(format!(
            "Escape hatch: the hook gives up after {secs}s and lets the commit through.",
        ));
    }

    let trio = join_clauses(
        &PROTECTED
            .iter()
            .map(|op| op.as_str().to_string())
            .collect::<Vec<_>>(),
    );
    if a.tool_gate.grants_enforced {
        out.push(format!(
            "Never on an agent's say-so: {trio}. A human runs `aura grant issue` at a \
             terminal first — a logged intent records who meant to do it and authorizes \
             nothing.",
        ));
    } else if a.tool_gate.other_hook {
        out.push(format!(
            "{trio} are NOT held to a human grant here: another hook checks this agent's \
             tool calls, and the rule that demands a grant is `aura validate-tool`, which \
             is not wired. `aura enable` wires it.",
        ));
    } else {
        out.push(format!(
            "Nothing checks an agent's tool calls here, so {trio} go straight through. \
             `aura enable` puts `aura validate-tool` in front of every call — that is what \
             makes those three need a human grant.",
        ));
    }

    let live: Vec<&GrantState> = a.grants.iter().filter(|g| g.live()).collect();
    if live.is_empty() {
        out.push("No grant is standing right now.".to_string());
    } else {
        for g in live {
            out.push(format!(
                "Standing grant: {} `{}`, issued by {}, {} — one use, then it is gone.",
                g.operation,
                g.target,
                g.issued_by,
                remaining(g.expires_in),
            ));
        }
    }
    let stale = a.grants.len() - a.grants.iter().filter(|g| g.live()).count();
    if stale > 0 {
        out.push(format!(
            "{stale} grant file{} in .aura/grants/pending no longer authorizes anything \
             (expired or void). `aura grant list` says why.",
            if stale == 1 { "" } else { "s" }
        ));
    }

    out
}

/// "12 minutes left" / "40 seconds left" — the unit a person would use
/// for the size of the number, because a grant's whole point is that it
/// is about to stop existing.
pub fn remaining(secs: i64) -> String {
    if secs <= 0 {
        return "expired".to_string();
    }
    if secs < 90 {
        return format!("{secs} seconds left");
    }
    let mins = secs / 60;
    if mins < 90 {
        return format!("{mins} minutes left");
    }
    format!("{} hours left", mins / 60)
}

fn join_clauses(items: &[String]) -> String {
    match items.len() {
        0 => String::new(),
        1 => items[0].clone(),
        _ => {
            let head = items[..items.len() - 1].join(", ");
            format!("{head}, or {}", items[items.len() - 1])
        }
    }
}

/// The same picture as JSON, for the desktop's policy pane and anything
/// else that would otherwise re-derive it and drift.
pub fn to_json(a: &Authority) -> serde_json::Value {
    serde_json::json!({
        "strict": a.strict,
        "locked": a.locked,
        "commit_gate": {
            "installed": a.commit_gate.installed,
            "path": a.commit_gate.path.to_string_lossy(),
            "skip_env": a.commit_gate.skip_env,
            "timeout_secs": a.commit_gate.timeout_secs,
        },
        "blocks": a.blocks,
        "allows": a.allows.iter().map(|(w, y)| serde_json::json!({ "what": w, "why": y }))
            .collect::<Vec<_>>(),
        "tool_gate": {
            "grants_enforced": a.tool_gate.grants_enforced,
            "other_hook": a.tool_gate.other_hook,
        },
        "protected_ops": PROTECTED.iter().map(|op| op.as_str()).collect::<Vec<_>>(),
        "grants": a.grants.iter().map(|g| serde_json::json!({
            "id": g.id,
            "operation": g.operation,
            "target": g.target,
            "issued_by": g.issued_by,
            "expires_in": g.expires_in,
            "live": g.live(),
            "problem": g.problem,
        })).collect::<Vec<_>>(),
        "lines": lines(a),
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn tmp(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("aura-authority-{name}-{}", std::process::id()));
        let _ = std::fs::create_dir_all(&dir);
        dir
    }

    fn inputs<'a>(root: &'a Path, hooks: &'a Path) -> Inputs<'a> {
        Inputs {
            repo_root: root,
            hooks_dir: hooks,
            strict: true,
            locked: true,
            dev_mode: false,
            taste_strict: false,
        }
    }

    #[test]
    fn a_repo_with_no_hook_is_not_described_as_blocking() {
        let root = tmp("nohook");
        let a = read(inputs(&root, &root));
        assert!(a.blocks.is_empty(), "nothing can be blocked with no hook installed");
        let said = lines(&a).join("\n");
        assert!(said.contains("No Aura pre-commit hook"), "{said}");
        assert!(said.contains("aura enable"), "{said}");
    }

    #[test]
    fn strict_off_says_it_stops_nothing() {
        let root = tmp("stricoff");
        let mut i = inputs(&root, &root);
        i.strict = false;
        let a = read(i);
        assert!(a.blocks.is_empty());
        assert!(lines(&a)[0].contains("stops nothing"));
    }

    #[test]
    fn an_unlocked_strict_mode_says_a_machine_can_turn_it_off() {
        let root = tmp("unlocked");
        let mut i = inputs(&root, &root);
        i.locked = false;
        let a = read(i);
        assert!(lines(&a)[0].contains("not locked"));
    }

    #[test]
    fn dev_mode_admits_the_secret_check_is_off() {
        let root = tmp("dev");
        let hooks = tmp("dev-hooks");
        std::fs::write(hooks.join("pre-commit"), "aura capture-context\n").unwrap();
        let mut i = inputs(&root, &hooks);
        i.dev_mode = true;
        let a = read(i);
        assert!(!a.blocks.iter().any(|b| b.contains("secret")));
        assert!(a
            .allows
            .iter()
            .any(|(w, y)| w.contains("secret") && y.contains("dev mode")));
    }

    #[test]
    fn house_style_is_reported_as_unenforced_until_opted_in() {
        let root = tmp("taste");
        let hooks = tmp("taste-hooks");
        std::fs::write(hooks.join("pre-commit"), "aura capture-context\n").unwrap();
        let a = read(inputs(&root, &hooks));
        assert!(a
            .allows
            .iter()
            .any(|(w, _)| w.contains("house-style")));

        let mut i = inputs(&root, &hooks);
        i.taste_strict = true;
        let a = read(i);
        assert!(a.blocks.iter().any(|b| b.contains("house style")));
    }

    #[test]
    fn the_hooks_own_escape_hatches_are_read_out_of_the_hook() {
        let hooks = tmp("escape");
        std::fs::write(
            hooks.join("pre-commit"),
            "#!/bin/sh\nif [ -n \"$AURA_SKIP\" ]; then exit 0; fi\n\
             if command -v gtimeout >/dev/null 2>&1; then\n\
             gtimeout 30 aura capture-context\nelse\n\
             timeout 30 aura capture-context\nfi\nSTATUS=$?\n\
             if [ $STATUS -eq 124 ]; then exit 0; fi\n",
        )
        .unwrap();
        let root = tmp("escape-root");
        let a = read(inputs(&root, &hooks));
        assert_eq!(a.commit_gate.skip_env.as_deref(), Some("AURA_SKIP"));
        assert_eq!(a.commit_gate.timeout_secs, Some(30));
        let said = lines(&a).join("\n");
        assert!(said.contains("setting AURA_SKIP skips"), "{said}");
        assert!(said.contains("gives up after 30s"), "{said}");
    }

    #[test]
    fn a_hook_that_aborts_on_timeout_advertises_no_time_limit() {
        let hooks = tmp("hardtimeout");
        std::fs::write(
            hooks.join("pre-commit"),
            "timeout 30 aura capture-context\nif [ $? -ne 0 ]; then exit 1; fi\n",
        )
        .unwrap();
        let root = tmp("hardtimeout-root");
        let a = read(inputs(&root, &hooks));
        assert_eq!(a.commit_gate.timeout_secs, None);
    }

    /// Writes a `.claude/<name>` settings file carrying one PreToolUse
    /// command, the way a wired repository really looks.
    fn wire(root: &Path, name: &str, command: &str) {
        let dir = root.join(".claude");
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(
            dir.join(name),
            serde_json::json!({
                "hooks": { "PreToolUse": [
                    { "matcher": "*", "hooks": [ { "type": "command", "command": command } ] }
                ]}
            })
            .to_string(),
        )
        .unwrap();
    }

    #[test]
    fn the_protected_trio_is_named_with_its_grant_command_where_the_gate_runs() {
        let root = tmp("trio");
        wire(&root, "settings.json", "aura validate-tool");
        let said = lines(&read(inputs(&root, &root))).join("\n");
        for op in ["delete", "reset", "force-push"] {
            assert!(said.contains(op), "{op} missing from: {said}");
        }
        assert!(said.contains("aura grant issue"), "{said}");
        assert!(said.contains("authorizes nothing"), "{said}");
    }

    #[test]
    fn a_machine_local_settings_file_counts_as_wiring() {
        // `settings.local.json` is not checked in, and it runs exactly the
        // same. Reading only the shared file would report an unguarded
        // repository that is in fact guarded.
        let root = tmp("wirelocal");
        wire(&root, "settings.local.json", "aura validate-tool");
        assert!(read(inputs(&root, &root)).tool_gate.grants_enforced);
    }

    #[test]
    fn an_unwired_repo_is_not_told_the_grant_rule_protects_it() {
        let root = tmp("unwired");
        let a = read(inputs(&root, &root));
        assert!(!a.tool_gate.grants_enforced);
        let said = lines(&a).join("\n");
        assert!(said.contains("Nothing checks an agent's tool calls here"), "{said}");
        assert!(!said.contains("Never on an agent's say-so"), "{said}");
    }

    #[test]
    fn someone_elses_pre_tool_hook_is_not_mistaken_for_the_grant_gate() {
        // This is the real shape of the repository Aura is built in: a
        // PreToolUse hook is wired, it just is not the one that reads
        // grants. Counting it would have turned the honest new line into
        // a new lie.
        let root = tmp("otherhook");
        wire(&root, "settings.local.json", "/opt/some/on-pre-tool-use.sh");
        let a = read(inputs(&root, &root));
        assert!(!a.tool_gate.grants_enforced);
        assert!(a.tool_gate.other_hook);
        let said = lines(&a).join("\n");
        assert!(said.contains("NOT held to a human grant here"), "{said}");
        assert!(said.contains("aura validate-tool"), "{said}");
    }

    #[test]
    fn no_pending_grants_is_said_out_loud_rather_than_left_blank() {
        let root = tmp("nogrants");
        let said = lines(&read(inputs(&root, &root))).join("\n");
        assert!(said.contains("No grant is standing"), "{said}");
    }

    /// `lines` is tested against a hand-built posture rather than a
    /// scratch repo because minting a *valid* grant needs the repo
    /// identity key, and judging one is `grants::check_grant`'s job and
    /// its own tests. What belongs here is the sentence a person reads.
    fn posture(grants: Vec<GrantState>) -> Authority {
        Authority {
            strict: true,
            locked: true,
            tool_gate: ToolGate { grants_enforced: true, other_hook: false },
            commit_gate: CommitGate {
                installed: true,
                path: PathBuf::from(".git/hooks/pre-commit"),
                skip_env: None,
                timeout_secs: None,
            },
            blocks: vec!["a function disappears".to_string()],
            allows: vec![],
            grants,
        }
    }

    fn grant(op: &str, target: &str, expires_in: i64, problem: Option<&str>) -> GrantState {
        GrantState {
            id: "abcdef01".to_string(),
            operation: op.to_string(),
            target: target.to_string(),
            issued_by: "Ashiq".to_string(),
            expires_in,
            problem: problem.map(String::from),
        }
    }

    #[test]
    fn a_standing_grant_is_named_with_who_issued_it_and_how_long_it_lasts() {
        let said = lines(&posture(vec![grant("delete", "build/out.js", 12 * 60, None)])).join("\n");
        assert!(said.contains("Standing grant: delete `build/out.js`"), "{said}");
        assert!(said.contains("issued by Ashiq"), "{said}");
        assert!(said.contains("12 minutes left"), "{said}");
        assert!(said.contains("one use"), "{said}");
        assert!(!said.contains("No grant is standing"), "{said}");
    }

    #[test]
    fn a_grant_that_would_be_refused_is_never_counted_as_authority() {
        // Expired, and void for a second reason — either alone must keep
        // it out of the standing list, or the screen would tell a person
        // an action is authorized when the gate would refuse it.
        let said = lines(&posture(vec![
            grant("reset", "git reset --hard", -30, None),
            grant("delete", "src/a.rs", 600, Some("file changed since it was issued")),
        ]))
        .join("\n");
        assert!(said.contains("No grant is standing"), "{said}");
        assert!(said.contains("2 grant files"), "{said}");
        assert!(said.contains("aura grant list"), "{said}");
    }

    #[test]
    fn remaining_speaks_in_the_unit_the_number_deserves() {
        assert_eq!(remaining(-4), "expired");
        assert_eq!(remaining(0), "expired");
        assert_eq!(remaining(45), "45 seconds left");
        assert_eq!(remaining(14 * 60), "14 minutes left");
        assert_eq!(remaining(4 * 3600), "4 hours left");
    }

    #[test]
    fn clauses_read_as_a_sentence_not_a_list() {
        assert_eq!(join_clauses(&["a".into()]), "a");
        assert_eq!(join_clauses(&["a".into(), "b".into()]), "a, or b");
        assert_eq!(
            join_clauses(&["a".into(), "b".into(), "c".into()]),
            "a, b, or c"
        );
    }
}
