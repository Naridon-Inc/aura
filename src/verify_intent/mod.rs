//! **Staged intent verification** — the gate that compares what an agent was
//! asked to do against what it actually did, while the work is still staged.
//!
//! The existing `intent-vs-actual` inspector scores a *commit* after the fact,
//! and the pre-commit CI path skips the intent gate outright because it has no
//! commit to score. That is the gap this closes: an approved contract recorded
//! before the agent starts, compared against the git index, enforced with a
//! non-zero exit before the commit exists.
//!
//! ```text
//!   approved baseline tree        git index
//!            \                       /
//!             \                     /
//!              +--> symbol delta <-+
//!                       |
//!                   verdict.rs  ──> exit 1 blocks the commit
//! ```
//!
//! Layout: [`contract`] is the approved statement, [`scan`] reads the two
//! trees, [`verdict`] judges (pure, unit-tested), [`restore`] repairs.

pub mod contract;
pub mod dependents;
pub mod restore;
pub mod scan;
pub mod verdict;

use colored::Colorize;
use contract::IntentContract;
use git2::Repository;
use std::path::{Path, PathBuf};
use verdict::{Finding, Severity, Verdict};

/// Repo root for the repository `repo` points at.
fn root_of(repo: &Repository) -> PathBuf {
    repo.workdir().unwrap_or_else(|| repo.path()).to_path_buf()
}

/// AST kinds read as jargon on camera. "function", not "function_declaration".
fn plain_kind(kind: &str) -> &str {
    if kind.contains("class") {
        "class"
    } else if kind.contains("method") {
        "method"
    } else if kind.contains("struct") {
        "struct"
    } else if kind.contains("interface") {
        "interface"
    } else if kind.contains("function") || kind.contains("arrow") || kind.contains("declarator") {
        "function"
    } else {
        "symbol"
    }
}

/// A test result someone else recorded, if they recorded one.
///
/// The gate does not run your test suite and will not claim a number it did
/// not see. `.aura/test_result.json` is written by whoever actually ran the
/// tests (`{"summary": "18 passed"}`); absent, the line is simply not printed.
fn recorded_tests(repo_root: &Path) -> Option<String> {
    let raw = std::fs::read_to_string(repo_root.join(".aura/test_result.json")).ok()?;
    let value: serde_json::Value = serde_json::from_str(&raw).ok()?;
    value
        .get("summary")
        .and_then(|s| s.as_str())
        .map(str::to_string)
}

// ---------------------------------------------------------------------------
// approve / show / amend
// ---------------------------------------------------------------------------

/// Record the approved contract for the work about to happen.
#[allow(clippy::too_many_arguments)]
pub fn run_approve(
    goal: &str,
    allow: &[String],
    protect: &[String],
    paths: &[String],
    agent: &str,
    session: &str,
    worktree: &str,
    baseline: Option<&str>,
    no_hook: bool,
    json: bool,
) -> i32 {
    let Ok(repo) = Repository::open(".") else {
        eprintln!("{} not a git repository.", "✗".red());
        return 1;
    };
    let root = root_of(&repo);

    let baseline = match baseline {
        Some(b) => b.to_string(),
        None => match repo.head().ok().and_then(|h| h.target()) {
            Some(oid) => oid.to_string(),
            None => {
                eprintln!("{} no HEAD to take a baseline from — make one commit first.", "✗".red());
                return 1;
            }
        },
    };

    let contract = IntentContract {
        goal: goal.to_string(),
        allowed_symbols: allow.to_vec(),
        protected_symbols: protect.to_vec(),
        allowed_paths: paths.to_vec(),
        approved_removals: Vec::new(),
        baseline,
        agent: agent.to_string(),
        session: session.to_string(),
        worktree: worktree.to_string(),
        approved_at: chrono::Utc::now().to_rfc3339(),
    };

    if let Err(e) = contract::save(&root, &contract) {
        eprintln!("{} could not write the contract: {e}", "✗".red());
        return 1;
    }

    // Approving a contract is someone saying "hold the agent to this". A
    // promise that only takes effect after a separate setup step is not a
    // promise, so the gate arms here — printed, never silent, and skippable.
    let mut gate_error: Option<String> = None;
    if !no_hook {
        if let Err(e) = crate::hook::HookInstaller::arm_intent_gate() {
            gate_error = Some(e.to_string());
        }
    }

    if json {
        let mut payload = serde_json::to_value(&contract).unwrap_or(serde_json::Value::Null);
        if let Some(obj) = payload.as_object_mut() {
            obj.insert(
                "gate_armed".into(),
                serde_json::Value::Bool(!no_hook && gate_error.is_none()),
            );
            if let Some(e) = &gate_error {
                obj.insert("gate_error".into(), serde_json::Value::String(e.clone()));
            }
        }
        println!("{}", serde_json::to_string_pretty(&payload).unwrap_or_default());
        return 0;
    }

    println!("\n{}", "INTENT APPROVED".green().bold());
    println!("{:<34}{}", "Goal", contract.goal);
    if !contract.allowed_symbols.is_empty() {
        println!("{:<34}{}", "Allowed to change", contract.allowed_symbols.join(", "));
    }
    if !contract.protected_symbols.is_empty() {
        println!("{:<34}{}", "Must preserve", contract.protected_symbols.join(", "));
    }
    if !contract.allowed_paths.is_empty() {
        println!("{:<34}{}", "Scope", contract.allowed_paths.join(", "));
    }
    println!("{:<34}{}", "Agent", contract.agent);
    println!("{:<34}{}", "Baseline", &contract.baseline[..12.min(contract.baseline.len())]);
    match (&gate_error, no_hook) {
        (Some(e), _) => println!("{:<34}{}", "Commit gate", format!("not armed — {e}").red()),
        (None, true) => println!(
            "{:<34}{}",
            "Commit gate",
            "not armed (--no-hook) — run `aura verify-intent --staged` yourself".dimmed()
        ),
        (None, false) => println!("{:<34}{}", "Commit gate", "armed on pre-commit".green()),
    }
    println!();
    0
}

/// Print the approved contract.
pub fn run_show(json: bool) -> i32 {
    let Ok(repo) = Repository::open(".") else {
        eprintln!("{} not a git repository.", "✗".red());
        return 1;
    };
    let Some(contract) = contract::load(&root_of(&repo)) else {
        if json {
            println!("null");
        } else {
            println!("{} no approved intent on record for this repository.", "—".dimmed());
        }
        return 1;
    };
    if json {
        println!("{}", serde_json::to_string_pretty(&contract).unwrap_or_default());
    } else {
        println!("\n{}", "APPROVED INTENT".bold());
        println!("{:<34}{}", "Goal", contract.goal);
        // A contract has two halves and this screen used to print one. Without
        // the scope, "must preserve" reads as the whole agreement, and a reader
        // has no way to tell an approved edit from an unapproved one — which is
        // the distinction every later screen turns on. Both halves, or neither.
        if !contract.allowed_symbols.is_empty() {
            println!("{:<34}{}", "May change", contract.allowed_symbols.join(", "));
        }
        if !contract.allowed_paths.is_empty() {
            println!("{:<34}{}", "Within", contract.allowed_paths.join(", "));
        }
        println!("{:<34}{}", "Must preserve", contract.protected_symbols.join(", "));
        if !contract.approved_removals.is_empty() {
            println!("{:<34}{}", "Removal approved", contract.approved_removals.join(", "));
        }
        println!("{:<34}{}", "Agent", contract.agent);
        println!("{:<34}{}", "Approved", contract.approved_at);
        println!();
    }
    0
}

/// Deliberately widen the contract — the honest alternative to bypassing the
/// gate. The amendment is recorded in the contract, so "we decided to allow
/// this" stays visible next to the code forever.
pub fn run_amend(approve_removal: &[String], json: bool) -> i32 {
    let Ok(repo) = Repository::open(".") else {
        eprintln!("{} not a git repository.", "✗".red());
        return 1;
    };
    let root = root_of(&repo);
    let Some(mut contract) = contract::load(&root) else {
        eprintln!("{} no approved intent to amend.", "✗".red());
        return 1;
    };
    for symbol in approve_removal {
        if !contract.approved_removals.contains(symbol) {
            contract.approved_removals.push(symbol.clone());
        }
    }
    if let Err(e) = contract::save(&root, &contract) {
        eprintln!("{} could not write the contract: {e}", "✗".red());
        return 1;
    }
    if json {
        println!("{}", serde_json::to_string_pretty(&contract).unwrap_or_default());
    } else {
        println!(
            "\n{} removal approved for: {}\n",
            "INTENT AMENDED".yellow().bold(),
            approve_removal.join(", ")
        );
    }
    0
}

// ---------------------------------------------------------------------------
// verify
// ---------------------------------------------------------------------------

/// The gate. Returns the process exit code — non-zero blocks the commit.
pub fn run_verify(json: bool) -> i32 {
    let Ok(repo) = Repository::open(".") else {
        eprintln!("{} not a git repository.", "✗".red());
        return 1;
    };
    let root = root_of(&repo);

    let Some(contract) = contract::load(&root) else {
        // No approval on record is not a failure — it is an absence. Say so
        // and get out of the way rather than inventing a verdict.
        if json {
            println!("{{\"status\":\"no_contract\"}}");
        } else {
            println!("{} no approved intent on record — nothing to verify against.", "—".dimmed());
        }
        return 0;
    };

    let baseline = match scan::scan_tree(&repo, &contract.baseline) {
        Ok(b) => b,
        Err(e) => {
            eprintln!("{} could not read the approved baseline: {e}", "✗".red());
            return 1;
        }
    };
    let staged = match scan::scan_index(&repo) {
        Ok(s) => s,
        Err(e) => {
            eprintln!("{} could not read the git index: {e}", "✗".red());
            return 1;
        }
    };

    let v = verdict::evaluate(&contract, &baseline, &staged);

    if json {
        let payload = verdict_json(&repo, &contract, &v, &baseline, &staged);
        println!("{}", serde_json::to_string_pretty(&payload).unwrap_or_default());
        return v.exit_code();
    }

    if v.passed() {
        print_verified(&root, &v);
    } else {
        print_failed(&repo, &contract, &v, &baseline, &staged);
    }
    v.exit_code()
}

/// The whole verdict as one JSON object.
///
/// Its own function because two commands emit it and a caller has to be able
/// to parse the result of either. `restore-symbol --json` used to print its
/// own object and then let `run_verify` print a second one after it — two
/// documents back to back, which is not JSON and which no client could read.
fn verdict_json(
    repo: &Repository,
    contract: &IntentContract,
    v: &Verdict,
    baseline: &std::collections::BTreeMap<String, scan::SymbolFacts>,
    staged: &std::collections::BTreeMap<String, scan::SymbolFacts>,
) -> serde_json::Value {
    let mut payload = serde_json::to_value(v).unwrap_or(serde_json::Value::Null);
    if let Some(obj) = payload.as_object_mut() {
        obj.insert("passed".into(), serde_json::Value::Bool(v.passed()));
        obj.insert(
            "dependents".into(),
            dependents_json(repo, contract, v, baseline, staged),
        );
    }
    payload
}

/// Reverse-dependency evidence for every blocked removal, as JSON.
fn dependents_json(
    repo: &Repository,
    contract: &IntentContract,
    v: &Verdict,
    baseline: &std::collections::BTreeMap<String, scan::SymbolFacts>,
    staged: &std::collections::BTreeMap<String, scan::SymbolFacts>,
) -> serde_json::Value {
    let mut out = serde_json::Map::new();
    for symbol in &v.protected_removed {
        let Some(facts) = baseline.get(symbol) else { continue };
        let chain =
            dependents::dependents_of(repo, &contract.baseline, symbol, &facts.file, staged);
        let rows: Vec<serde_json::Value> = chain
            .iter()
            .map(|d| {
                serde_json::json!({
                    "symbol": d.symbol,
                    "file": d.file,
                    "depth": d.depth,
                    "certain": d.is_certain(),
                })
            })
            .collect();
        out.insert(
            symbol.clone(),
            serde_json::json!({
                "defined_in": facts.file,
                "dependents": rows,
            }),
        );
    }
    serde_json::Value::Object(out)
}

fn print_verified(root: &Path, v: &Verdict) {
    println!("\n{}", "INTENT VERIFIED".green().bold());
    println!("{:<34}{}", "Requested functions changed", v.requested_changed.len());
    println!("{:<34}{}", "Unexpected functions changed", v.unexpected_changed.len());
    println!("{:<34}{}", "Protected exports removed", v.protected_removed.len());
    if let Some(tests) = recorded_tests(root) {
        println!("{:<34}{}", "Tests", tests);
    }
    if !v.agent.is_empty() {
        println!("{:<34}{}", "Agent", v.agent);
    }
    if !v.worktree.is_empty() {
        println!("{:<34}{}", "Worktree", v.worktree);
    }

    // A pass is not the same as "nothing to look at". A count of 1 next to
    // "Unexpected" tells a reader something happened and refuses to say what;
    // anything named on the preserve list gets spelled out.
    let preserved_but_changed: Vec<_> = v
        .violations
        .iter()
        .filter(|x| x.finding == Finding::ProtectedSymbolChanged)
        .collect();
    if !preserved_but_changed.is_empty() {
        println!("\n{}", "You asked to preserve these, and they changed".bold());
        for x in &preserved_but_changed {
            println!("  {}   {}", format!("{}()", x.symbol).yellow(), x.file.dimmed());
        }
        println!(
            "  {}",
            "Still present, so nothing is broken — read the diff before you ship it.".dimmed()
        );
    }

    println!("\n{}\n", "Commit allowed".green());
}

fn print_failed(
    repo: &Repository,
    contract: &IntentContract,
    v: &Verdict,
    baseline: &std::collections::BTreeMap<String, scan::SymbolFacts>,
    staged: &std::collections::BTreeMap<String, scan::SymbolFacts>,
) {
    println!("\n{}", "INTENT VERIFICATION FAILED".red().bold());

    println!("\n{}", "Requested".bold());
    println!("  {}", v.goal);

    let blocking: Vec<_> = v
        .violations
        .iter()
        .filter(|x| x.severity == Severity::Blocking)
        .collect();

    println!("\n{}", "Unexpected semantic change".bold());
    for x in &blocking {
        let visibility = if x.exported { "exported " } else { "" };
        println!("  Deleted {visibility}{}:", plain_kind(&x.kind));
        println!("  {}", format!("{}()", x.symbol).yellow().bold());
    }

    // Where the removed code is still used — the reason this matters. Without
    // this block the screen says only "a rule was broken"; with it, it says
    // which code stops working.
    for x in &blocking {
        let Some(facts) = baseline.get(&x.symbol) else { continue };
        let chain =
            dependents::dependents_of(repo, &contract.baseline, &x.symbol, &facts.file, staged);
        if chain.is_empty() {
            continue;
        }
        println!("\n{}", "Affected code".bold());
        println!("  {}", format!("{}()", x.symbol).yellow());
        for (indent, symbol, file) in dependents::tree_lines(&chain) {
            println!("{indent}  {}   {}", symbol, file.dimmed());
        }
        let unsure = chain.iter().filter(|d| !d.is_certain()).count();
        if unsure > 0 {
            println!(
                "  {}",
                format!("{unsure} of these matched on name alone — check them by hand.").dimmed()
            );
        }
    }

    println!("\n{}", "Reason".bold());
    for x in &blocking {
        println!("  {}", x.reason);
    }

    let advisories: Vec<_> = v
        .violations
        .iter()
        .filter(|x| x.severity == Severity::Advisory)
        .collect();
    if !advisories.is_empty() {
        println!("\n{}", "Also worth knowing".dimmed());
        for x in advisories.iter().take(6) {
            let tag = match x.finding {
                Finding::OutOfScopeFile => "out of scope",
                Finding::ProtectedSymbolChanged => "asked to preserve",
                _ => "not requested",
            };
            println!("  {} {}", format!("[{tag}]").dimmed(), x.symbol);
        }
    }

    println!("\n{}", "What you can do".bold());
    for x in &blocking {
        println!(
            "  {}  {}",
            format!("aura restore-symbol {}", x.symbol).green(),
            "put it back from the approved baseline".dimmed()
        );
    }
    println!(
        "  {}  {}",
        "aura intent-contract amend --approve-removal <name>".green(),
        "approve it deliberately".dimmed()
    );
    println!("\n{}\n", "Commit blocked.".red().bold());
}

// ---------------------------------------------------------------------------
// restore
// ---------------------------------------------------------------------------

/// Put one symbol back from the approved baseline and re-run the gate.
pub fn run_restore(symbol: &str, json: bool) -> i32 {
    let Ok(repo) = Repository::open(".") else {
        eprintln!("{} not a git repository.", "✗".red());
        return 1;
    };
    let root = root_of(&repo);
    let Some(contract) = contract::load(&root) else {
        eprintln!("{} no approved intent on record — nothing to restore from.", "✗".red());
        return 1;
    };
    let baseline = match scan::scan_tree(&repo, &contract.baseline) {
        Ok(b) => b,
        Err(e) => {
            eprintln!("{} could not read the approved baseline: {e}", "✗".red());
            return 1;
        }
    };

    match restore::restore_symbol(&repo, &root, &contract.baseline, &baseline, symbol) {
        Ok(outcome) => {
            if json {
                // One document, not two. The restore and the verdict it
                // produced belong to the same answer, and a caller needs both:
                // what came back, and whether the commit is allowed now.
                let staged = match scan::scan_index(&repo) {
                    Ok(s) => s,
                    Err(e) => {
                        eprintln!("{} could not read the git index: {e}", "✗".red());
                        return 1;
                    }
                };
                let v = verdict::evaluate(&contract, &baseline, &staged);
                let payload = serde_json::json!({
                    "restored": outcome.symbol,
                    "file": outcome.file,
                    "line": outcome.inserted_at_line,
                    "anchoredAfter": outcome.anchored_after,
                    "importsRestored": outcome.imports_restored,
                    "verdict": verdict_json(&repo, &contract, &v, &baseline, &staged),
                });
                println!("{}", serde_json::to_string_pretty(&payload).unwrap_or_default());
                return v.exit_code();
            } else {
                println!("\n{}", "SYMBOL RESTORED".green().bold());
                println!("{:<34}{}", "Function", outcome.symbol);
                println!("{:<34}{}:{}", "Back in", outcome.file, outcome.inserted_at_line);
                if let Some(after) = &outcome.anchored_after {
                    println!("{:<34}{}", "Reinserted after", after);
                }
                if !outcome.imports_restored.is_empty() {
                    println!("{:<34}{}", "Imports restored", outcome.imports_restored.join(", "));
                }
                println!("{:<34}{}", "Staged", "yes");
                println!("\n{}", "Re-verifying…".dimmed());
            }
            run_verify(false)
        }
        Err(e) => {
            eprintln!("\n{} {e}", "COULD NOT RESTORE".red().bold());
            eprintln!(
                "{}",
                "  Hand the finding to the agent instead — `aura verify-intent --staged --json`\n  is the exact payload to give it.".dimmed()
            );
            1
        }
    }
}
