// `aura validate-tool` — a real, fire-and-forget gatekeeper for AI agent
// tool calls. Reads a single JSON object describing the tool the agent is
// about to run, classifies whether the action is destructive, and emits a
// single-line JSON verdict the shell backend (or a Claude Code PreToolUse
// hook) renders in a gate dialog.
//
// The verdict is the contract:
//   {"decision":"allow"|"ask"|"deny",
//    "severity":"info"|"warn"|"danger",
//    "title":"<short>","reason":"<human-readable why/what>",
//    "details":{...}}
//
// Design:
//   - Reuse `aura_policy::evaluate` for the PathWrite / CommandPattern
//     matchers so the gate verdict lines up with the daemon's policy engine
//     (same policy.toml, same most-restrictive resolution).
//   - For destructive ops, read `.aura/intent_log.jsonl`: a recent logged
//     intent that names the file/symbol/command downgrades "ask" → "allow".
//   - Strict mode (config.strict_gatekeeper_mode + a passcode lock) turns an
//     uncovered destructive op into a hard "deny"; soft strict → "ask".
//
// Never panics, never blocks on missing input — a malformed payload yields a
// conservative "ask" so the human still sees something, and the command
// still exits 0 (it is called from a hook).

use std::collections::BTreeMap;
use std::io::Read;
use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};

use aura_blocks::{
    AgentRef, AnchorRef, Attestations, Block, BlockId, BlockPayload, BlockState, CapabilityGrade,
    DeclaredImpacts, Intent, Provenance, SCHEMA_VERSION,
};
use aura_policy::context::WindowKey;
use aura_policy::schema::TrustTier;
use aura_policy::{evaluate, load_from_str, CompiledPolicy, EvalContext, RateState};
use serde_json::{json, Value};
use time::OffsetDateTime;

use crate::intent_query::read_all_rows;
use crate::parser::SemanticParser;

/// The bundled default policy — used when no `.aura/policy.toml` is present
/// in the repo. Identical to the one the daemon compiles, so verdicts match.
const DEFAULT_POLICY_TOML: &str = include_str!("../crates/aura-policy/policy.toml");

/// How far back (seconds) a logged intent is allowed to be and still "cover"
/// a destructive action. One hour mirrors the intent_vs_actual window and is
/// generous enough for the log-intent-then-act flow the hook drives.
const INTENT_COVERAGE_WINDOW_SECS: u64 = 3600;

/// Parsed shape of the tool-call payload on STDIN. Every field is optional
/// because hooks from different surfaces (shell, Claude Code PreToolUse,
/// Gemini) populate slightly different subsets — we degrade gracefully.
#[derive(Debug, Default, Clone)]
struct ToolInvocation {
    tool_name: String,
    tool_input: Value,
    #[allow(dead_code)]
    session_id: Option<String>,
    cwd: Option<String>,
    #[allow(dead_code)]
    agent_id: Option<String>,
}

/// What kind of destructive action (if any) the tool call represents. Carries
/// the human-facing specifics (file path / symbol / command) so the verdict
/// `title` + `reason` can name the actual thing being gated.
#[derive(Debug)]
enum Action {
    /// Non-destructive — read, search, a plain edit, an in-repo create, etc.
    Safe { summary: String },
    /// A file is being deleted outright.
    FileDelete { path: String },
    /// A shell command matched a destructive pattern (rm -rf, mv, git reset
    /// --hard, git push --force, …). `command` is the literal command line.
    DestructiveCommand { command: String, label: String },
    /// A Write/Edit overwrites an existing file wholesale (truncating write)
    /// or removes named symbols from it (function/class deletion).
    OverwriteOrSymbolDelete {
        path: String,
        removed_symbols: Vec<String>,
        truncating: bool,
    },
}

/// Final verdict emitted to STDOUT.
struct Verdict {
    decision: &'static str, // "allow" | "ask" | "deny"
    severity: &'static str, // "info" | "warn" | "danger"
    title: String,
    reason: String,
    details: Value,
}

impl Verdict {
    /// Serialize to the shape Claude Code's PreToolUse hook protocol accepts.
    ///
    /// Claude Code validates hook stdout against a strict schema: a PreToolUse
    /// hook may print ONLY the modern `hookSpecificOutput` envelope (or nothing
    /// + exit 0). The legacy top-level `decision` key — and our internal
    /// gate-card fields (severity/title/details) — fail that validation at the
    /// root ("(root): Invalid input"), which Claude Code surfaces as a hook
    /// error on every tool call. We map our verdict 1:1 onto the envelope:
    /// `decision` ("allow"|"ask"|"deny") is already the exact `permissionDecision`
    /// enum, and `reason` becomes `permissionDecisionReason`. The richer
    /// gate-card fields still reach the desktop via the parked-card path, not
    /// stdout.
    fn to_hook_stdout(&self) -> Value {
        json!({
            "hookSpecificOutput": {
                "hookEventName": "PreToolUse",
                "permissionDecision": self.decision,
                "permissionDecisionReason": self.reason,
            },
        })
    }
}

/// Entry point for `aura validate-tool`. Reads STDIN, decides, prints one
/// JSON line to STDOUT. Always returns `Ok(())` — the caller exits 0.
pub fn run() -> Result<(), Box<dyn std::error::Error>> {
    let mut raw = String::new();
    // Best-effort read; an empty/closed STDIN is treated as a malformed
    // payload (conservative "ask") rather than an error.
    let _ = std::io::stdin().read_to_string(&mut raw);

    let parsed = parse_invocation(&raw);
    let verdict = match &parsed {
        Some(inv) => decide(inv.clone()),
        None => Verdict {
            decision: "ask",
            severity: "warn",
            title: "Unrecognized tool call".to_string(),
            reason:
                "validate-tool received no parseable tool payload on stdin, so it cannot classify \
                 the action — confirm manually before proceeding."
                    .to_string(),
            details: json!({ "raw_len": raw.len() }),
        },
    };

    println!("{}", verdict.to_hook_stdout());

    // Awareness auto-emit (M3c): once we've allowed an edit, announce it on the
    // Team Radar so teammates/agents see it BEFORE the commit. Throttled and
    // best-effort — never affects the gate verdict above.
    if verdict.decision == "allow" {
        if let Some(inv) = &parsed {
            auto_emit_editing(inv);
        }
    }
    Ok(())
}

/// Best-effort: emit a throttled `editing` awareness event for an allowed
/// Write/Edit so the Team Radar reflects in-flight work automatically. Silent on
/// any failure — this must never disturb the agent's tool call.
fn auto_emit_editing(inv: &ToolInvocation) {
    let tool = inv.tool_name.to_lowercase();
    if !matches!(tool.as_str(), "edit" | "write" | "multiedit" | "notebookedit") {
        return;
    }
    let Some(path) = inv.tool_input.get("file_path").and_then(|p| p.as_str()) else {
        return;
    };

    // The awareness store is cwd-relative; operate from the repo root so the
    // event lands in the right repo. The hook process is ephemeral, so a
    // one-way chdir is safe.
    let root = resolve_repo_root(inv.cwd.as_deref());
    if std::env::set_current_dir(&root).is_err() {
        return;
    }
    let rel = path
        .strip_prefix(&format!("{}/", root.display()))
        .unwrap_or(path)
        .to_string();

    let agent = inv
        .agent_id
        .clone()
        .or_else(|| std::env::var("AURA_AGENT").ok())
        .unwrap_or_else(|| "claude".to_string());

    let _ = crate::awareness::emit::emit_throttled(
        crate::awareness::emit::EmitInput {
            kind: crate::awareness::model::AwarenessKind::Editing,
            file: Some(rel),
            symbol: None,
            intent: None,
            impact: None,
            agent: Some(agent),
        },
        90_000,
    );
}

fn parse_invocation(raw: &str) -> Option<ToolInvocation> {
    let v: Value = serde_json::from_str(raw.trim()).ok()?;
    let tool_name = v
        .get("tool_name")
        .and_then(|t| t.as_str())
        .unwrap_or("")
        .to_string();
    if tool_name.is_empty() {
        return None;
    }
    Some(ToolInvocation {
        tool_name,
        tool_input: v.get("tool_input").cloned().unwrap_or(Value::Null),
        session_id: v
            .get("session_id")
            .and_then(|s| s.as_str())
            .map(String::from),
        cwd: v.get("cwd").and_then(|s| s.as_str()).map(String::from),
        agent_id: v
            .get("agent_id")
            .and_then(|s| s.as_str())
            .map(String::from),
    })
}

/// Core decision pipeline: classify → policy-evaluate → intent-coverage →
/// strict-mode escalation.
fn decide(inv: ToolInvocation) -> Verdict {
    let repo_root = resolve_repo_root(inv.cwd.as_deref());
    let action = classify(&inv, &repo_root);

    match &action {
        Action::Safe { summary } => Verdict {
            decision: "allow",
            severity: "info",
            title: "Safe operation".to_string(),
            reason: format!("Allowed: {summary}"),
            details: json!({ "tool": inv.tool_name, "action": "safe" }),
        },
        Action::FileDelete { path } => {
            gate_destructive(&repo_root, &inv, &action, DestructiveFacts {
                title: format!("Delete file `{}`", file_label(path)),
                what: format!("delete the file `{path}`"),
                policy_command: Some(format!("rm {path}")),
                policy_writes: vec![path.clone()],
                covered_terms: delete_terms(path, &[]),
                danger: true,
            })
        }
        Action::DestructiveCommand { command, label } => {
            gate_destructive(&repo_root, &inv, &action, DestructiveFacts {
                title: format!("{label}"),
                what: format!("run `{}`", truncate(command, 200)),
                policy_command: Some(command.clone()),
                policy_writes: vec![],
                covered_terms: command_terms(command),
                danger: true,
            })
        }
        Action::OverwriteOrSymbolDelete {
            path,
            removed_symbols,
            truncating,
        } => {
            let (title, what, danger) = if !removed_symbols.is_empty() {
                let list = removed_symbols.join("`, `");
                (
                    format!("Remove `{}`", removed_symbols.join("`, `")),
                    format!("remove symbol(s) `{list}` from `{}`", file_label(path)),
                    true,
                )
            } else {
                (
                    format!("Overwrite `{}`", file_label(path)),
                    format!("overwrite the existing file `{path}` wholesale"),
                    *truncating,
                )
            };
            gate_destructive(&repo_root, &inv, &action, DestructiveFacts {
                title,
                what,
                policy_command: None,
                policy_writes: vec![path.clone()],
                covered_terms: delete_terms(path, removed_symbols),
                danger,
            })
        }
    }
}

/// Inputs to the shared destructive-op gate. Built per action variant so the
/// verdict text names the concrete file/symbol/command.
struct DestructiveFacts {
    /// Short verdict title, e.g. "Delete `compute_tick`".
    title: String,
    /// Verb phrase for the reason, e.g. "remove function `compute_tick`…".
    what: String,
    /// Command line to evaluate against CommandPattern rules, if this is a
    /// shell op.
    policy_command: Option<String>,
    /// Paths to evaluate against PathWrite rules.
    policy_writes: Vec<String>,
    /// Lowercased terms (file stem, symbol names, command head) whose presence
    /// in a recent intent counts as "covered".
    covered_terms: Vec<String>,
    /// Whether this rates "danger" vs "warn" severity when gated.
    danger: bool,
}

fn gate_destructive(
    repo_root: &Path,
    inv: &ToolInvocation,
    action: &Action,
    facts: DestructiveFacts,
) -> Verdict {
    // ── 1. Policy engine cross-check (PathWrite / CommandPattern) ──
    // A Deny from policy (e.g. .aura/ sanctity, untrusted network) is
    // terminal regardless of intent coverage.
    let policy_verdict = evaluate_with_policy(
        repo_root,
        facts.policy_command.as_deref(),
        &facts.policy_writes,
    );

    if let Some((CapabilityGrade::Deny, rule_reason)) = &policy_verdict {
        return Verdict {
            decision: "deny",
            severity: "danger",
            title: facts.title,
            reason: format!(
                "Policy denies this: agent is about to {what}, but {rule_reason}",
                what = facts.what,
                rule_reason = lower_first(rule_reason),
            ),
            details: json!({
                "tool": inv.tool_name,
                "policy_verdict": "deny",
                "policy_reason": rule_reason,
            }),
        };
    }

    // ── 2. Intent coverage ──
    let coverage = recent_intent_covers(repo_root, &facts.covered_terms);

    if let Some(matched) = &coverage {
        return Verdict {
            decision: "allow",
            severity: "info",
            title: facts.title,
            reason: format!(
                "Agent is about to {what} — a recent logged intent covers this: \"{}\".",
                truncate(&matched.intent, 160),
                what = facts.what,
            ),
            details: json!({
                "tool": inv.tool_name,
                "covered_by_intent": true,
                "intent_timestamp": matched.timestamp,
                "intent_agent": matched.agent_id,
            }),
        };
    }

    // ── 3. Strict mode escalation ──
    let config = crate::config::ConfigManager::load();
    let strict = config.strict_gatekeeper_mode;
    let locked = crate::config::ConfigManager::is_strict_mode_locked(&config);

    let policy_summary = policy_verdict
        .as_ref()
        .map(|(g, r)| format!("{:?}: {}", g, r))
        .unwrap_or_else(|| "no matching policy rule".to_string());

    if strict && locked {
        Verdict {
            decision: "deny",
            severity: "danger",
            title: facts.title,
            reason: format!(
                "Strict gatekeeper mode is LOCKED. Agent is about to {what}, but no logged intent \
                 mentions it. Log intent first (`aura log-intent \"…\"`) or have a human unlock \
                 strict mode.",
                what = facts.what,
            ),
            details: json!({
                "tool": inv.tool_name,
                "covered_by_intent": false,
                "strict_mode": "locked",
                "policy": policy_summary,
            }),
        }
    } else {
        // Only the `ask` path parks a human gate card, so this is the one
        // verdict where the feature-impact analysis is actually seen — compute
        // it here and nowhere else, keeping the ~1s graph walk off the
        // allow/deny fast paths.
        let impact = compute_impact(repo_root, action);
        Verdict {
            decision: "ask",
            severity: if facts.danger { "danger" } else { "warn" },
            title: facts.title,
            reason: format!(
                "Agent is about to {what}, but no logged intent mentions it — confirm this is \
                 intended.",
                what = facts.what,
            ),
            details: json!({
                "tool": inv.tool_name,
                "covered_by_intent": false,
                "strict_mode": if strict { "soft" } else { "off" },
                "policy": policy_summary,
                "impact": impact.unwrap_or(Value::Null),
            }),
        }
    }
}

/// Compute the user-facing delete-impact JSON for a destructive action, if it
/// is a symbol/file deletion we can analyze. Returns `None` for command-based
/// destructive ops (no symbol set) and unparseable targets. Only called on the
/// `ask` path — the one verdict a human actually sees — so the graph walk never
/// taxes the allow/deny fast paths.
fn compute_impact(repo_root: &Path, action: &Action) -> Option<Value> {
    let di = match action {
        Action::FileDelete { path } => {
            let abs = abs_path(repo_root, path);
            let symbols = symbols_in_file(&abs);
            if symbols.is_empty() {
                return None;
            }
            crate::impact::analyze_deletion(repo_root, path, &symbols)
        }
        Action::OverwriteOrSymbolDelete {
            path,
            removed_symbols,
            ..
        } if !removed_symbols.is_empty() => {
            crate::impact::analyze_deletion(repo_root, path, removed_symbols)
        }
        _ => return None,
    };
    Some(crate::impact::to_json(&di))
}

/// Parse a file on disk and return its top-level definition identifiers — the
/// BFS roots for a whole-file delete. Best-effort; empty on any failure.
fn symbols_in_file(abs: &Path) -> Vec<String> {
    let ext = match ext_of(abs) {
        Some(e) => e,
        None => return Vec::new(),
    };
    let src = match std::fs::read_to_string(abs) {
        Ok(s) => s,
        Err(_) => return Vec::new(),
    };
    let mut parser = match SemanticParser::new() {
        Ok(p) => p,
        Err(_) => return Vec::new(),
    };
    let nodes = match parser.parse_file(&src, &ext) {
        Ok(n) => n,
        Err(_) => return Vec::new(),
    };
    let mut out: Vec<String> = nodes
        .iter()
        .filter_map(|n| n.identifier.clone())
        .filter(|id| !id.is_empty() && id != "anonymous" && !id.starts_with("__"))
        .collect();
    out.sort();
    out.dedup();
    out
}

/// Classify the tool call into a destructive/safe `Action`. Handles the four
/// surface shapes named in the spec: file delete, destructive Bash command,
/// truncating/overwriting write, and symbol/function deletion via AST diff.
fn classify(inv: &ToolInvocation, repo_root: &Path) -> Action {
    let tool = inv.tool_name.to_lowercase();
    let input = &inv.tool_input;

    // Bash / shell commands → command-pattern classification.
    if tool == "bash" || tool == "shell" || tool == "run" || tool == "terminal" {
        if let Some(cmd) = input
            .get("command")
            .and_then(|c| c.as_str())
            .filter(|c| !c.is_empty())
        {
            return classify_command(cmd);
        }
    }

    // Explicit delete/remove tools.
    if tool.contains("delete") || tool == "rm" || tool == "remove" {
        if let Some(p) = first_path_field(input) {
            return Action::FileDelete { path: p };
        }
    }

    // Write / Edit / MultiEdit / NotebookEdit → could be an overwrite or a
    // symbol delete.
    if tool == "write"
        || tool == "edit"
        || tool == "multiedit"
        || tool == "create"
        || tool == "notebookedit"
    {
        if let Some(p) = first_path_field(input) {
            return classify_write(&p, input, repo_root, &tool);
        }
    }

    // Anything else (Read, Grep, Glob, ls, search, …) is non-destructive.
    Action::Safe {
        summary: format!("{} is a non-destructive operation", inv.tool_name),
    }
}

/// Classify a shell command string against the destructive patterns the spec
/// calls out: `rm`/`rm -rf`, `mv`, truncating redirects, `git reset --hard`,
/// `git push --force`.
fn classify_command(cmd: &str) -> Action {
    let trimmed = cmd.trim();
    let lower = trimmed.to_lowercase();

    // git push --force / -f / +ref
    if lower.contains("git push")
        && (lower.contains("--force") || lower.contains("-f ") || lower.contains("--force-with-lease"))
    {
        return Action::DestructiveCommand {
            command: trimmed.to_string(),
            label: "Force-push to remote".to_string(),
        };
    }
    // git reset --hard
    if lower.contains("git reset") && lower.contains("--hard") {
        return Action::DestructiveCommand {
            command: trimmed.to_string(),
            label: "Hard git reset (discards changes)".to_string(),
        };
    }
    // rm -rf / rm -r / rm -f / rm <path>
    if is_rm_command(&lower) {
        return Action::DestructiveCommand {
            command: trimmed.to_string(),
            label: "Recursive/forced delete".to_string(),
        };
    }
    // mv (can clobber / move tracked paths out of the way)
    if starts_with_word(&lower, "mv") {
        return Action::DestructiveCommand {
            command: trimmed.to_string(),
            label: "Move/rename (overwrites destination)".to_string(),
        };
    }
    // Truncating overwrite redirect: `> file` (but not `>>` append). We scan
    // for a single `>` that is not part of `>>` and not `2>`/`&>` stderr
    // redirects to a discard.
    if has_truncating_redirect(trimmed) {
        return Action::DestructiveCommand {
            command: trimmed.to_string(),
            label: "Truncating overwrite (`>` redirect)".to_string(),
        };
    }

    Action::Safe {
        summary: format!("command `{}` is not on the destructive list", truncate(trimmed, 80)),
    }
}

/// Classify a Write/Edit/MultiEdit. A `Write` to an existing file is a
/// wholesale overwrite (truncating). An `Edit`/`MultiEdit` is applied to the
/// on-disk source to reconstruct the proposed new body, which is then parsed
/// to see whether any previously-defined symbol disappears.
fn classify_write(path: &str, input: &Value, repo_root: &Path, tool: &str) -> Action {
    let abs = abs_path(repo_root, path);
    let existed = abs.exists();

    // New file → in-repo create, reversible, safe.
    if !existed {
        return Action::Safe {
            summary: format!("creating new file `{}`", file_label(path)),
        };
    }

    // Read the on-disk source once. It is both the AST-diff baseline and the
    // text an Edit/MultiEdit is applied over to reconstruct the new body.
    let old_src = std::fs::read_to_string(&abs).ok();

    // Reconstruct the full proposed new source from the payload:
    //   • Write  → `content` is the entire new file.
    //   • Edit   → apply `old_string`→`new_string` over the on-disk text.
    //   • MultiEdit → apply each `edits[]` entry in order.
    // This is the fix for the silent hole where Edit/MultiEdit payloads (which
    // never carry `content`) skipped symbol-deletion analysis entirely and
    // were waved through as "scoped edit".
    let new_src = old_src
        .as_deref()
        .and_then(|src| proposed_new_source(input, src, tool));

    // Symbol-deletion check: only meaningful when we have both the old body
    // and the full new body and the file is a language we parse. Mirrors the
    // deletion-guard / intent_vs_actual approach: parse both sides, diff_nodes,
    // collect names that vanished.
    if let (Some(old_src), Some(new_src)) = (old_src.as_deref(), new_src.as_deref()) {
        if let Some(removed) = removed_symbols(&abs, old_src, new_src) {
            if !removed.is_empty() {
                return Action::OverwriteOrSymbolDelete {
                    path: path.to_string(),
                    removed_symbols: removed,
                    // A `Write` replaces the whole file; an Edit is scoped.
                    truncating: tool == "write" || tool == "create",
                };
            }
            // Full new body reconstructed, no symbols lost → safe in-place edit.
            return Action::Safe {
                summary: format!("editing `{}` without removing any symbol", file_label(path)),
            };
        }
        // Parseable payload but a non-code file (no AST) — fall through.
    }

    // A `Write` (not `Edit`) to an existing file with no parseable content is
    // a wholesale truncating overwrite — gate it.
    if tool == "write" || tool == "create" {
        return Action::OverwriteOrSymbolDelete {
            path: path.to_string(),
            removed_symbols: vec![],
            truncating: true,
        };
    }

    // A scoped Edit on a non-code file (or one whose old_string didn't match)
    // is reversible.
    Action::Safe {
        summary: format!("scoped edit of `{}`", file_label(path)),
    }
}

/// Reconstruct the full proposed new source for a Write/Edit/MultiEdit payload
/// so symbol-deletion analysis can diff old vs new. Returns `None` when the
/// payload doesn't carry enough to reconstruct a new body (e.g. an Edit whose
/// `old_string` isn't present in the on-disk source).
fn proposed_new_source(input: &Value, old_src: &str, _tool: &str) -> Option<String> {
    // Write tools pass the entire new file as `content`.
    if let Some(content) = input.get("content").and_then(|c| c.as_str()) {
        return Some(content.to_string());
    }

    // MultiEdit: an ordered array of {old_string,new_string[,replace_all]}.
    if let Some(edits) = input.get("edits").and_then(|e| e.as_array()) {
        let mut cur = old_src.to_string();
        let mut applied = false;
        for e in edits {
            let old = e.get("old_string").and_then(|s| s.as_str()).unwrap_or("");
            let new = e.get("new_string").and_then(|s| s.as_str()).unwrap_or("");
            let all = e
                .get("replace_all")
                .and_then(|b| b.as_bool())
                .unwrap_or(false);
            if old.is_empty() || !cur.contains(old) {
                continue;
            }
            cur = if all {
                cur.replace(old, new)
            } else {
                cur.replacen(old, new, 1)
            };
            applied = true;
        }
        return applied.then_some(cur);
    }

    // Single Edit: `old_string`/`new_string` (with `old_str`/`new_str` aliases
    // for surfaces that use the short form). Apply over the on-disk text.
    let old = input
        .get("old_string")
        .or_else(|| input.get("old_str"))
        .and_then(|s| s.as_str());
    if let Some(old) = old.filter(|o| !o.is_empty()) {
        if old_src.contains(old) {
            let new = input
                .get("new_string")
                .or_else(|| input.get("new_str"))
                .and_then(|s| s.as_str())
                .unwrap_or("");
            let all = input
                .get("replace_all")
                .and_then(|b| b.as_bool())
                .unwrap_or(false);
            return Some(if all {
                old_src.replace(old, new)
            } else {
                old_src.replacen(old, new, 1)
            });
        }
    }

    None
}

/// Parse the on-disk source and the proposed new source, returning the set of
/// named symbols that exist in the old body but are absent in the new one.
/// Returns `None` when the file isn't a parseable language (so the caller can
/// fall back to the truncating-overwrite path).
fn removed_symbols(abs: &Path, old_src: &str, new_src: &str) -> Option<Vec<String>> {
    let ext = ext_of(abs)?;
    let mut parser = SemanticParser::new().ok()?;
    let old_nodes = parser.parse_file(old_src, &ext).ok()?;
    let new_nodes = parser.parse_file(new_src, &ext).ok()?;

    let mut removed = Vec::new();
    for (ident, action) in SemanticParser::diff_nodes(&old_nodes, &new_nodes) {
        if action != "deleted" {
            continue;
        }
        // Same exclusion list the deletion-guard and intent_vs_actual use.
        if ident.is_empty() || ident == "anonymous" || ident.starts_with("__") {
            continue;
        }
        removed.push(ident);
    }
    removed.sort();
    removed.dedup();
    Some(removed)
}

// ─────────────────────────────────────────────────────────────────────────────
// Policy engine bridge
// ─────────────────────────────────────────────────────────────────────────────

/// Build a Proposed Command/FileWrite block and run it through
/// `aura_policy::evaluate`. Returns the (verdict, reason) when a rule (or the
/// structural default) produced a non-Auto result worth surfacing; `None` on
/// Auto or when the policy can't be compiled.
fn evaluate_with_policy(
    repo_root: &Path,
    command: Option<&str>,
    writes: &[String],
) -> Option<(CapabilityGrade, String)> {
    let policy = load_policy(repo_root)?;

    let now = OffsetDateTime::from_unix_timestamp(now_secs() as i64)
        .unwrap_or(OffsetDateTime::UNIX_EPOCH);

    let declared_impacts = DeclaredImpacts {
        writes_paths: writes.to_vec(),
        ..Default::default()
    };

    let payload = match command {
        Some(cmd) => BlockPayload::Command {
            command: cmd.to_string(),
            shell: None,
            cwd: repo_root.to_string_lossy().to_string(),
        },
        None => BlockPayload::Command {
            command: String::new(),
            shell: None,
            cwd: repo_root.to_string_lossy().to_string(),
        },
    };

    // The actor DID matches the `claude-code` grant in policy.toml so the
    // standard trust tier and in-repo-write allowances apply.
    let actor = AgentRef("did:aura:agent/claude-code/validate-tool".to_string());

    let block = Block {
        id: BlockId::new(),
        schema_version: SCHEMA_VERSION,
        kind: aura_blocks::BlockKind::Command,
        parent_id: None,
        prior_sibling_id: None,
        supersedes_id: None,
        anchor: AnchorRef::None,
        intent: Intent {
            summary: "validate-tool policy probe".to_string(),
            detail: None,
            parent_intent: None,
        },
        declared_impacts,
        actual_impacts: None,
        payload,
        state: BlockState::Proposed,
        policy: None,
        provenance: Provenance {
            actor: actor.clone(),
            on_behalf_of: None,
            origin_host: "validate-tool".to_string(),
            signature: None,
        },
        attestations: Attestations::default(),
        created_at: now,
        updated_at: now,
        extensions: BTreeMap::new(),
    };

    let ctx = EvalContext {
        repo_root: repo_root.to_path_buf(),
        cwd: repo_root.to_path_buf(),
        branch: None,
        now,
        local_offset_hours: 0,
        origin_host: "validate-tool".to_string(),
        actor,
        actor_trust_tier: TrustTier::Standard,
        zone_claims: std::collections::HashMap::new(),
        network_allowlist: std::collections::HashSet::new(),
    };

    let mut rate = RateState::new();
    let decision = evaluate(&policy, &block, &ctx, &mut rate);
    // Touch WindowKey so the rate-state import is load-bearing and the
    // evaluator's window machinery is wired even when no rate rule fires.
    let _ = std::mem::size_of::<WindowKey>();

    match decision.verdict {
        CapabilityGrade::Auto => None,
        v => Some((v, decision.reason)),
    }
}

/// Load `.aura/policy.toml` if present, else the bundled default. Returns
/// `None` only if even the bundled default fails to compile (should never
/// happen — it is the same file the policy crate tests compile).
fn load_policy(repo_root: &Path) -> Option<CompiledPolicy> {
    let local = repo_root.join(".aura").join("policy.toml");
    if local.exists() {
        if let Ok(s) = std::fs::read_to_string(&local) {
            if let Ok(p) = load_from_str(&s) {
                return Some(p);
            }
        }
    }
    load_from_str(DEFAULT_POLICY_TOML).ok()
}

// ─────────────────────────────────────────────────────────────────────────────
// Intent coverage
// ─────────────────────────────────────────────────────────────────────────────

struct CoveringIntent {
    timestamp: u64,
    agent_id: String,
    intent: String,
}

/// Scan the recent intent log for a row that (a) lands inside the coverage
/// window and (b) mentions a deletion keyword AND one of the action-specific
/// terms (file stem, symbol name, command head). Mirrors the
/// deletion-guard's "intent_mentions_deletion && intent_mentions_specific"
/// rule so the gate agrees with the pre-commit hook.
fn recent_intent_covers(repo_root: &Path, terms: &[String]) -> Option<CoveringIntent> {
    if terms.is_empty() {
        return None;
    }
    let log_path = repo_root.join(".aura").join("intent_log.jsonl");
    let rows = read_all_rows(&log_path);
    if rows.is_empty() {
        return None;
    }
    let now = now_secs();
    let lo = now.saturating_sub(INTENT_COVERAGE_WINDOW_SECS);

    // Walk newest-first so the most recent covering intent wins.
    let mut recent: Vec<_> = rows
        .into_iter()
        .filter(|r| r.timestamp >= lo && r.timestamp <= now.saturating_add(60))
        .collect();
    recent.sort_by_key(|r| std::cmp::Reverse(r.timestamp));

    for row in recent {
        let hay = row.intent.to_lowercase();
        let mentions_deletion = ["remov", "delet", "deprecat", "drop", "strip", "clean", "rewrite"]
            .iter()
            .any(|kw| hay.contains(kw));
        if !mentions_deletion {
            continue;
        }
        let mentions_specific = terms.iter().any(|t| !t.is_empty() && hay.contains(t));
        if mentions_specific {
            return Some(CoveringIntent {
                timestamp: row.timestamp,
                agent_id: row.agent_id,
                intent: row.intent,
            });
        }
    }
    None
}

/// Terms that, if present in an intent, count as "naming" a file delete or
/// symbol removal: the file stem/parent dir parts plus each removed symbol.
fn delete_terms(path: &str, symbols: &[String]) -> Vec<String> {
    let mut out: Vec<String> = Vec::new();
    let lower = path.to_lowercase();
    // File stem (e.g. "cmd_manager" from "src/cmd_manager.rs").
    if let Some(stem) = Path::new(&lower)
        .file_stem()
        .and_then(|s| s.to_str())
        .filter(|s| s.len() > 2)
    {
        out.push(stem.to_string());
    }
    // Path components long enough to be meaningful (skip "src", "/", "..").
    for part in lower.split('/') {
        if part.len() > 2 {
            out.push(part.to_string());
        }
    }
    for s in symbols {
        let s = s.to_lowercase();
        if !s.is_empty() {
            out.push(s);
        }
    }
    out.sort();
    out.dedup();
    out
}

/// Terms for command coverage: the head binary plus any path-like tokens
/// (so an intent that names the directory being `rm -rf`'d covers it).
fn command_terms(cmd: &str) -> Vec<String> {
    let lower = cmd.to_lowercase();
    let mut out: Vec<String> = Vec::new();
    for tok in lower.split_whitespace() {
        let tok = tok.trim_matches(|c| c == '"' || c == '\'');
        // Skip pure flags.
        if tok.starts_with('-') || tok.is_empty() {
            continue;
        }
        if tok.len() > 2 {
            out.push(tok.to_string());
        }
        // Also push the last path component for path-like tokens.
        if tok.contains('/') {
            if let Some(last) = tok.rsplit('/').find(|p| p.len() > 2) {
                out.push(last.to_string());
            }
        }
    }
    out.sort();
    out.dedup();
    out
}

// ─────────────────────────────────────────────────────────────────────────────
// Small helpers
// ─────────────────────────────────────────────────────────────────────────────

/// Resolve the repo root: prefer the payload `cwd`, walk up for a `.git` /
/// `.aura` marker, else fall back to the process cwd.
pub(crate) fn resolve_repo_root(cwd: Option<&str>) -> PathBuf {
    let start = cwd
        .map(PathBuf::from)
        .filter(|p| p.exists())
        .or_else(|| std::env::current_dir().ok())
        .unwrap_or_else(|| PathBuf::from("."));

    let mut cur = start.as_path();
    loop {
        if cur.join(".git").exists() || cur.join(".aura").exists() {
            return cur.to_path_buf();
        }
        match cur.parent() {
            Some(p) => cur = p,
            None => break,
        }
    }
    start
}

fn abs_path(repo_root: &Path, path: &str) -> PathBuf {
    let p = Path::new(path);
    if p.is_absolute() {
        p.to_path_buf()
    } else {
        repo_root.join(p)
    }
}

/// First path-ish field from a tool_input object: file_path | path | file |
/// notebook_path.
fn first_path_field(input: &Value) -> Option<String> {
    for key in ["file_path", "path", "file", "notebook_path", "target"] {
        if let Some(s) = input.get(key).and_then(|v| v.as_str()) {
            if !s.is_empty() {
                return Some(s.to_string());
            }
        }
    }
    None
}

fn ext_of(p: &Path) -> Option<String> {
    let e = p.extension()?.to_str()?.to_lowercase();
    match e.as_str() {
        "rs" | "py" | "ts" | "tsx" | "js" | "jsx" | "go" | "java" | "cs" | "rb" | "cpp" | "cc"
        | "cxx" | "hpp" | "c" | "h" | "php" | "swift" | "kt" | "kts" => Some(e),
        _ => None,
    }
}

fn file_label(path: &str) -> String {
    Path::new(path)
        .file_name()
        .and_then(|s| s.to_str())
        .map(String::from)
        .unwrap_or_else(|| path.to_string())
}

/// True if the command is an `rm` invocation (with or without flags).
fn is_rm_command(lower: &str) -> bool {
    starts_with_word(lower, "rm") || lower.contains("&& rm ") || lower.contains("| rm ")
}

/// True if `s` begins with `word` as a whole token (followed by space/end).
fn starts_with_word(s: &str, word: &str) -> bool {
    if let Some(rest) = s.strip_prefix(word) {
        rest.is_empty() || rest.starts_with(char::is_whitespace)
    } else {
        false
    }
}

/// Detect a truncating `>` redirect (not `>>`, not `2>`, not `&>`).
fn has_truncating_redirect(cmd: &str) -> bool {
    let bytes = cmd.as_bytes();
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] == b'>' {
            let prev = if i > 0 { bytes[i - 1] } else { b' ' };
            let next = if i + 1 < bytes.len() { bytes[i + 1] } else { b' ' };
            // Skip `>>` (append) and the second char of one.
            if next == b'>' || prev == b'>' {
                i += 1;
                continue;
            }
            // Skip fd redirects like `2>` and `&>` pointed at /dev/null —
            // those don't truncate a project file.
            if prev == b'2' || prev == b'&' || prev == b'1' {
                // Could still truncate a real file (e.g. `2>log`), but the
                // common case is stderr discard; treat as non-destructive to
                // avoid noise. A real overwrite uses a bare `>`.
                i += 1;
                continue;
            }
            return true;
        }
        i += 1;
    }
    false
}

fn truncate(s: &str, max: usize) -> String {
    if s.chars().count() <= max {
        s.to_string()
    } else {
        let mut out: String = s.chars().take(max).collect();
        out.push('…');
        out
    }
}

/// Lowercase the first character of a sentence so it can follow "but".
fn lower_first(s: &str) -> String {
    let mut chars = s.chars();
    match chars.next() {
        Some(c) => c.to_lowercase().collect::<String>() + chars.as_str(),
        None => String::new(),
    }
}

fn now_secs() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0)
}
