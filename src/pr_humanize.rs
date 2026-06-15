//! Human-readable review surface.
//!
//! Aura's engine produces precise but developer-flavoured findings —
//! `Forbidden Call: Node 'load_card_for' calls 'unsafe_exec' (p.rs:16)`,
//! raw blast-radius symbol lists, one "graph-neighborhood overlap" line per
//! branch. Dumped verbatim that reads as noise, and only to a developer.
//!
//! This module folds those raw strings into plain-language *cards* anyone can
//! act on (what it is, why it matters, where, how bad, what to do — with
//! repetition rolled into a single `count`), and pairs each changed file with
//! the *intent* Aura captured for it (the what / why / where / when / who a
//! non-developer needs to approve or ask for changes with confidence).
//!
//! Everything here is additive: `HumanFinding` / `ChangeIntent` / the summary
//! string ride alongside the legacy `string[]` arrays in the review JSON, so
//! older app builds keep working while the surface gets humanised.

use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;
use std::path::Path;

/// A single plain-language issue card. Repetition is folded into `count`, so
/// eighteen identical "overlap" lines become one card that says "×18".
#[derive(Debug, Serialize, Deserialize, Clone, PartialEq)]
pub struct HumanFinding {
    /// `critical` | `warning` | `advisory` | `info` — orders the list and
    /// drives the badge colour in the app.
    pub severity: String,
    /// `security` | `architecture` | `style` | `impact` — groups the cards.
    pub category: String,
    /// Plain-language headline a non-developer understands at a glance.
    pub title: String,
    /// One or two sentences: what it is, and why it's worth a look.
    pub detail: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub file: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub line: Option<u32>,
    /// The symbol (function / class) involved, if the finding names one.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub symbol: Option<String>,
    /// How many raw findings folded into this card (≥ 1).
    pub count: usize,
    /// Plain-language next step, if there is an obvious one.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub suggestion: Option<String>,
}

/// One symbol that changed inside a file.
#[derive(Debug, Serialize, Deserialize, Clone, PartialEq)]
pub struct ChangedSymbol {
    pub name: String,
    /// `added` | `modified` | `deleted` | `renamed`.
    pub action: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub line: Option<u32>,
    /// Humanised node kind — "function", "class", … (best effort).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub kind: Option<String>,
}

/// The intent behind the changes to one file: the *why* git never recorded,
/// plus what / where / when / who, so a reader can decide without reading code.
#[derive(Debug, Serialize, Deserialize, Clone, PartialEq)]
pub struct ChangeIntent {
    pub file: String,
    /// Plain one-liner: "2 functions changed, 1 added".
    pub what: String,
    pub symbols: Vec<ChangedSymbol>,
    /// The captured intent prose explaining *why* this file changed.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub why: Option<String>,
    /// Unix seconds the intent was recorded.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub when: Option<u64>,
    /// Who recorded it (agent id / author).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub who: Option<String>,
}

/// Where an intent candidate came from. Local rows are authoritative;
/// notes rows (mirrored onto `refs/notes/aura-intent` by `aura meta push`)
/// only fill in when no local row explains a change — the reviewer who
/// didn't author the branch and so has an empty `.aura/intent_log.jsonl`.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum IntentOrigin {
    /// `.aura/intent_log.jsonl` in the local working copy.
    Local,
    /// `refs/notes/aura-intent` rows on commits in the review range.
    Notes,
}

/// One parsed line of `.aura/intent_log.jsonl` (or a notes row standing in
/// for it — see `IntentOrigin`).
#[derive(Debug, Clone, PartialEq)]
pub struct IntentRecord {
    pub intent: String,
    pub agent_id: Option<String>,
    pub timestamp: Option<u64>,
    /// Task (goal) this reasoning served, stamped by the goal-alignment spine.
    pub task_id: Option<String>,
    /// `AURA-<n>` sequence for display without a task fetch.
    pub task_seq: Option<u64>,
    pub origin: IntentOrigin,
}

// ---------------------------------------------------------------------------
// Findings
// ---------------------------------------------------------------------------

/// Fold every raw finding stream into plain-language cards, deduped and sorted
/// worst-first. `blast_radius` and `conflicts` are *rolled up* into a single
/// card each rather than one line per symbol/branch.
pub fn humanize_findings(
    invariant_violations: &[String],
    taste_findings: &[String],
    blast_radius: &[String],
    conflicts: &[String],
) -> Vec<HumanFinding> {
    let mut out: Vec<HumanFinding> = Vec::new();

    // Invariant violations — one card each, identical ones folded by count.
    for raw in invariant_violations {
        let card = humanize_invariant(raw);
        merge_or_push(&mut out, card);
    }

    // Taste — grouped into one card per rule template.
    out.extend(humanize_taste(taste_findings));

    // Blast radius — one rolled-up "ripples outward" card.
    if let Some(card) = rollup_blast_radius(blast_radius) {
        out.push(card);
    }

    // Cross-branch overlap — one rolled-up card (kills the ×18 dump if a
    // stale engine ever emits it again).
    if let Some(card) = rollup_conflicts(conflicts) {
        out.push(card);
    }

    out.sort_by_key(|f| severity_rank(&f.severity));
    out
}

fn severity_rank(sev: &str) -> u8 {
    match sev {
        "critical" => 0,
        "warning" => 1,
        "advisory" => 2,
        "info" => 3,
        _ => 4,
    }
}

/// Fold a card into an existing identical one (same category/title/symbol/loc)
/// by bumping its count, else append it.
fn merge_or_push(out: &mut Vec<HumanFinding>, card: HumanFinding) {
    if let Some(existing) = out.iter_mut().find(|f| {
        f.category == card.category
            && f.title == card.title
            && f.symbol == card.symbol
            && f.file == card.file
            && f.line == card.line
    }) {
        existing.count += card.count;
    } else {
        out.push(card);
    }
}

/// Split a trailing ` (path)` or ` (path:line)` location token off a raw
/// finding string. Returns the cleaned text plus the parsed location.
fn split_location(raw: &str) -> (String, Option<String>, Option<u32>) {
    let trimmed = raw.trim_end();
    if let (Some(open), true) = (trimmed.rfind(" ("), trimmed.ends_with(')')) {
        let inner = &trimmed[open + 2..trimmed.len() - 1];
        // Reject anything that doesn't look like a path token (avoid eating
        // a real parenthetical like "(3 hops)").
        let looks_like_path = inner.contains('/')
            || inner.contains('.')
            || inner.contains(':');
        if looks_like_path && !inner.contains(' ') {
            let (file, line) = match inner.rsplit_once(':') {
                Some((f, l)) if l.chars().all(|c| c.is_ascii_digit()) && !l.is_empty() => {
                    (f.to_string(), l.parse::<u32>().ok())
                }
                _ => (inner.to_string(), None),
            };
            let head = trimmed[..open].trim_end().to_string();
            return (head, Some(file), line);
        }
    }
    (trimmed.to_string(), None, None)
}

/// Pull the text between the first two single quotes, then the next two, …
fn quoted(s: &str) -> Vec<String> {
    let mut parts = Vec::new();
    let mut it = s.char_indices().filter(|(_, c)| *c == '\'').map(|(i, _)| i);
    while let (Some(a), Some(b)) = (it.next(), it.next()) {
        parts.push(s[a + 1..b].to_string());
    }
    parts
}

/// Turn one raw invariant-violation string into a plain-language card.
fn humanize_invariant(raw: &str) -> HumanFinding {
    let (text, file, line) = split_location(raw);
    let names = quoted(&text);

    if text.starts_with("Forbidden Call") {
        let node = names.first().cloned();
        let call = names.get(1).cloned().unwrap_or_else(|| "a blocked function".into());
        return HumanFinding {
            severity: "critical".into(),
            category: "security".into(),
            title: format!("Unsafe call to `{call}`"),
            detail: format!(
                "{} uses `{call}`, which the project's rules forbid — calls like this are a \
                 common source of security holes (for example, building a command or database \
                 query out of raw text invites injection attacks).",
                node.as_deref().map(|n| format!("`{n}`")).unwrap_or_else(|| "This code".into()),
            ),
            file,
            line,
            symbol: node,
            count: 1,
            suggestion: Some(format!(
                "Replace `{call}` with a safe, parameterised alternative, or remove the raw call."
            )),
        };
    }

    if text.starts_with("Layer Violation") {
        // 'from' layer node 'ident' eventually calls 'cannot'
        let from = names.first().cloned().unwrap_or_else(|| "one".into());
        let node = names.get(1).cloned();
        let cannot = names.get(2).cloned().unwrap_or_else(|| "another area".into());
        return HumanFinding {
            severity: "warning".into(),
            category: "architecture".into(),
            title: "Crosses an architecture boundary".into(),
            detail: format!(
                "Code in the {from} layer ({}) reaches into `{cannot}`, which that layer is meant \
                 to stay away from. Keeping these areas separated is what keeps the app safe to \
                 change later.",
                node.as_deref().map(|n| format!("`{n}`")).unwrap_or_else(|| "a function".into()),
            ),
            file,
            line,
            symbol: node,
            count: 1,
            suggestion: Some(format!(
                "Go through the layer that's allowed to talk to `{cannot}` instead of calling it directly."
            )),
        };
    }

    if text.starts_with("Protected Node Deleted") {
        let node = names.first().cloned();
        return HumanFinding {
            severity: "critical".into(),
            category: "security".into(),
            title: format!(
                "Sensitive code was removed{}",
                node.as_deref().map(|n| format!(": `{n}`")).unwrap_or_default()
            ),
            detail: format!(
                "{} was marked protected because it handles something security-sensitive, and it \
                 has been removed. Make sure nothing relied on it.",
                node.as_deref().map(|n| format!("`{n}`")).unwrap_or_else(|| "A protected block".into()),
            ),
            file,
            line,
            symbol: node,
            count: 1,
            suggestion: Some("Confirm this removal is intentional and nothing depended on it.".into()),
        };
    }

    if text.starts_with("Protected Node Modified") {
        let node = names.first().cloned();
        return HumanFinding {
            severity: "warning".into(),
            category: "security".into(),
            title: format!(
                "Sensitive code was changed{}",
                node.as_deref().map(|n| format!(": `{n}`")).unwrap_or_default()
            ),
            detail: format!(
                "{} is marked protected because it handles something security-sensitive (like \
                 sign-in or password hashing). The change may be perfectly fine — it just \
                 deserves a careful second look.",
                node.as_deref().map(|n| format!("`{n}`")).unwrap_or_else(|| "This block".into()),
            ),
            file,
            line,
            symbol: node,
            count: 1,
            suggestion: Some("Double-check the change keeps the original safety guarantees.".into()),
        };
    }

    // Unknown invariant shape — keep the text but present it calmly.
    HumanFinding {
        severity: "warning".into(),
        category: "architecture".into(),
        title: "Policy check flagged this change".into(),
        detail: text,
        file,
        line,
        symbol: names.first().cloned(),
        count: 1,
        suggestion: None,
    }
}

/// Group taste findings (`file: reason (rule: template, confidence x)`) into one
/// advisory card per rule template.
fn humanize_taste(taste: &[String]) -> Vec<HumanFinding> {
    // template -> (reason, count)
    let mut groups: BTreeMap<String, (String, usize)> = BTreeMap::new();
    for raw in taste {
        let (template, reason) = parse_taste(raw);
        let entry = groups.entry(template).or_insert_with(|| (reason.clone(), 0));
        entry.1 += 1;
        if entry.0.is_empty() {
            entry.0 = reason;
        }
    }

    groups
        .into_iter()
        .map(|(template, (reason, count))| {
            let title = if reason.is_empty() {
                "Doesn't match the project's usual style".to_string()
            } else {
                capitalize_first(&reason)
            };
            let where_str = if count == 1 {
                "1 place".to_string()
            } else {
                format!("{count} places")
            };
            HumanFinding {
                severity: "advisory".into(),
                category: "style".into(),
                title,
                detail: format!(
                    "{where_str} don't follow the project's usual style{}. This is advisory — \
                     nothing is broken, it's about staying consistent with the rest of the code.",
                    if template.is_empty() { String::new() } else { format!(" ({template})") },
                ),
                file: None,
                line: None,
                symbol: None,
                count,
                suggestion: Some("Optional — align with the house style; run `aura taste check` for the full list.".into()),
            }
        })
        .collect()
}

/// Parse `file: reason (rule: template, confidence 0.91)` → (template, reason).
fn parse_taste(raw: &str) -> (String, String) {
    // reason sits between the first ": " and the " (rule:" marker.
    let after_file = raw.splitn(2, ": ").nth(1).unwrap_or(raw);
    let reason = after_file
        .split(" (rule:")
        .next()
        .unwrap_or(after_file)
        .trim()
        .to_string();
    let template = raw
        .split("(rule:")
        .nth(1)
        .and_then(|s| s.split(',').next())
        .map(|s| s.trim().to_string())
        .unwrap_or_default();
    (template, reason)
}

/// Roll a blast-radius symbol list into one "this ripples outward" card.
fn rollup_blast_radius(symbols: &[String]) -> Option<HumanFinding> {
    if symbols.is_empty() {
        return None;
    }
    let n = symbols.len();
    let sample = sample_names(symbols, 4);
    Some(HumanFinding {
        severity: "info".into(),
        category: "impact".into(),
        title: format!("This change ripples into {n} other place{}", plural(n)),
        detail: format!(
            "Editing these functions affects {n} other part{} of the code that call or depend on \
             them ({sample}). That's usually fine — it's just worth a glance to be sure nothing \
             downstream breaks.",
            plural(n),
        ),
        file: None,
        line: None,
        symbol: None,
        count: n,
        suggestion: None,
    })
}

/// Roll cross-branch overlap lines into one card (folds the ×18 dump).
fn rollup_conflicts(conflicts: &[String]) -> Option<HumanFinding> {
    if conflicts.is_empty() {
        return None;
    }
    let n = conflicts.len();
    Some(HumanFinding {
        severity: "warning".into(),
        category: "impact".into(),
        title: format!("Overlaps with {n} other branch{}", if n == 1 { "" } else { "es" }),
        detail: format!(
            "Some of these changes touch code that {n} other in-progress branch{} {} also editing. \
             Coordinate before merging so you don't overwrite each other's work.",
            if n == 1 { "" } else { "es" },
            if n == 1 { "is" } else { "are" },
        ),
        file: None,
        line: None,
        symbol: None,
        count: n,
        suggestion: Some("Sync with whoever owns the overlapping branches before merging.".into()),
    })
}

/// "`a`, `b`, `c` and 5 more" — a calm sample of a long symbol list.
fn sample_names(names: &[String], take: usize) -> String {
    let shown: Vec<String> = names.iter().take(take).map(|s| format!("`{s}`")).collect();
    let rest = names.len().saturating_sub(shown.len());
    if rest == 0 {
        shown.join(", ")
    } else {
        format!("{} and {rest} more", shown.join(", "))
    }
}

fn plural(n: usize) -> &'static str {
    if n == 1 { "" } else { "s" }
}

fn capitalize_first(s: &str) -> String {
    let mut chars = s.chars();
    match chars.next() {
        Some(c) => c.to_uppercase().collect::<String>() + chars.as_str(),
        None => String::new(),
    }
}

// ---------------------------------------------------------------------------
// Intent per change
// ---------------------------------------------------------------------------

/// Read `.aura/intent_log.jsonl` under `repo_root`. Best effort: a missing or
/// malformed file yields an empty list, never an error.
pub fn load_intent_log(repo_root: &Path) -> Vec<IntentRecord> {
    let path = repo_root.join(".aura").join("intent_log.jsonl");
    let body = match std::fs::read_to_string(&path) {
        Ok(b) => b,
        Err(_) => return Vec::new(),
    };
    body.lines()
        .filter_map(|line| {
            let v: serde_json::Value = serde_json::from_str(line).ok()?;
            let intent = v.get("intent")?.as_str()?.to_string();
            if intent.trim().is_empty() {
                return None;
            }
            Some(IntentRecord {
                intent,
                agent_id: v.get("agent_id").and_then(|x| x.as_str()).map(String::from),
                timestamp: v.get("timestamp").and_then(|x| x.as_u64()),
                task_id: v.get("task_id").and_then(|x| x.as_str()).map(String::from),
                task_seq: v.get("task_seq").and_then(|x| x.as_u64()),
                origin: IntentOrigin::Local,
            })
        })
        .collect()
}

/// Read intent rows from git notes (`refs/notes/aura-intent`) on the
/// commits in `base..head` — the meaning plane a teammate published with
/// `aura meta push`. This is the reviewer's fallback: someone who didn't
/// author the branch has an empty local intent log, but the notes travel
/// with the repo through any remote. Best effort: a repo without the ref
/// (or any git failure) yields an empty list, never an error. Rows are
/// tagged `IntentOrigin::Notes` so scoring keeps local rows authoritative
/// and the rendered WHO can say where the reason came from.
pub fn load_notes_intents(
    repo: &git2::Repository,
    base: git2::Oid,
    head: git2::Oid,
) -> Vec<IntentRecord> {
    let mut out = Vec::new();
    let Ok(mut walk) = repo.revwalk() else {
        return out;
    };
    if walk.push(head).is_err() || walk.hide(base).is_err() {
        return out;
    }
    for oid in walk.flatten() {
        let Some(body) =
            crate::meta_refs::notes::note_body(repo, crate::meta_refs::NOTES_REF, oid)
        else {
            continue;
        };
        for line in body.lines() {
            let Some(row) = crate::meta_refs::notes::parse_note_line(line) else {
                continue;
            };
            out.push(IntentRecord {
                intent: row.intent,
                agent_id: if row.agent_id.trim().is_empty() {
                    None
                } else {
                    Some(row.agent_id)
                },
                timestamp: if row.ts > 0 { Some(row.ts) } else { None },
                task_id: None,
                task_seq: None,
                origin: IntentOrigin::Notes,
            });
        }
    }
    out
}

/// Build a per-file "what changed and why" record for every changed file.
///
/// * `changes`  — `(file, symbol, action)` triples (the engine's `total_changes`).
/// * `kinds`    — `(file, symbol) -> (line, kind)` for symbols we parsed.
/// * `intents`  — parsed intent log, newest-relevant wins.
/// * `fallback` — the active checkpoint's `(intent, when, who)` used when no
///   logged intent mentions the file or its symbols.
pub fn build_change_intents(
    changes: &[(String, String, String)],
    kinds: &[(String, crate::models::AstNode)],
    intents: &[IntentRecord],
    fallback: Option<(&str, u64, &str)>,
) -> Vec<ChangeIntent> {
    // Group changed symbols by file, preserving first-seen file order.
    let mut order: Vec<String> = Vec::new();
    let mut by_file: BTreeMap<String, Vec<ChangedSymbol>> = BTreeMap::new();
    for (file, symbol, action) in changes {
        if !by_file.contains_key(file) {
            order.push(file.clone());
        }
        let (line, kind) = kinds
            .iter()
            .find(|(f, n)| f == file && n.identifier.as_deref() == Some(symbol.as_str()))
            .map(|(_, n)| (n.start_line, Some(humanize_kind(&n.kind))))
            .unwrap_or((None, None));
        by_file.entry(file.clone()).or_default().push(ChangedSymbol {
            name: symbol.clone(),
            action: action.clone(),
            line,
            kind,
        });
    }

    order
        .into_iter()
        .map(|file| {
            let symbols = by_file.remove(&file).unwrap_or_default();
            let (why, when, who) = best_intent_for(&file, &symbols, intents, fallback);
            ChangeIntent {
                what: describe_changes(&symbols),
                symbols,
                why,
                when,
                who,
                file,
            }
        })
        .collect()
}

/// Pick the intent that best explains a file's changes. Scores each logged
/// intent by how many of the file's name/symbols its prose mentions; the
/// highest score (newest on a tie) wins. Local rows always beat notes rows:
/// notes only fill in when no local intent scores at all. Falls back to the
/// active checkpoint intent, then to nothing — never fabricates a reason.
fn best_intent_for(
    file: &str,
    symbols: &[ChangedSymbol],
    intents: &[IntentRecord],
    fallback: Option<(&str, u64, &str)>,
) -> (Option<String>, Option<u64>, Option<String>) {
    let stem = Path::new(file)
        .file_stem()
        .and_then(|s| s.to_str())
        .unwrap_or(file)
        .to_lowercase();

    let best = best_scored(&stem, symbols, intents, IntentOrigin::Local)
        .or_else(|| best_scored(&stem, symbols, intents, IntentOrigin::Notes));

    if let Some(rec) = best {
        // Provenance in the rendered WHO: a reviewer should be able to
        // tell a reason that came over the wire (git notes) from one
        // recorded on this machine.
        let who = match rec.origin {
            IntentOrigin::Local => rec.agent_id.clone(),
            IntentOrigin::Notes => Some(match rec.agent_id.as_deref() {
                Some(a) if !a.trim().is_empty() => format!("{a} · via notes"),
                _ => "via notes".to_string(),
            }),
        };
        return (Some(summarize_intent(&rec.intent)), rec.timestamp, who);
    }

    if let Some((intent, when, who)) = fallback {
        if !intent.trim().is_empty() {
            return (
                Some(summarize_intent(intent)),
                Some(when),
                Some(who.to_string()),
            );
        }
    }

    (None, None, None)
}

/// Highest-scoring record among `intents` restricted to one origin —
/// mention of the file stem scores 2, each mentioned symbol scores 1,
/// newest wins a tie. `None` when nothing scores above zero.
/// pub(crate): `distill` groups dirty files by the same scoring so review
/// and distill always agree on which intent owns a change.
pub(crate) fn best_scored<'a>(
    stem: &str,
    symbols: &[ChangedSymbol],
    intents: &'a [IntentRecord],
    origin: IntentOrigin,
) -> Option<&'a IntentRecord> {
    let mut best: Option<(usize, &IntentRecord)> = None;
    for rec in intents.iter().filter(|r| r.origin == origin) {
        let hay = rec.intent.to_lowercase();
        let mut score = 0usize;
        if stem.len() >= 3 && hay.contains(stem) {
            score += 2;
        }
        for sym in symbols {
            if sym.name.len() >= 3 && hay.contains(&sym.name.to_lowercase()) {
                score += 1;
            }
        }
        if score == 0 {
            continue;
        }
        match best {
            Some((bs, _)) if bs > score => {}
            Some((bs, br)) if bs == score && br.timestamp >= rec.timestamp => {}
            _ => best = Some((score, rec)),
        }
    }
    best.map(|(_, rec)| rec)
}

/// Intent prose can be a paragraph. Keep the first sentence (or ~240 chars) so
/// the card stays readable; the full text lives in the intent log.
fn summarize_intent(intent: &str) -> String {
    let trimmed = intent.trim();
    // First sentence boundary.
    if let Some(idx) = trimmed.find(". ") {
        if idx + 1 >= 24 {
            return trimmed[..=idx].trim().to_string();
        }
    }
    if trimmed.chars().count() > 240 {
        let cut: String = trimmed.chars().take(237).collect();
        format!("{}…", cut.trim_end())
    } else {
        trimmed.to_string()
    }
}

/// Plain one-liner summarising what changed in a file: "2 functions changed, 1 added".
fn describe_changes(symbols: &[ChangedSymbol]) -> String {
    let mut added = 0usize;
    let mut modified = 0usize;
    let mut deleted = 0usize;
    let mut renamed = 0usize;
    for s in symbols {
        match s.action.as_str() {
            "added" => added += 1,
            "modified" => modified += 1,
            "deleted" => deleted += 1,
            "renamed" => renamed += 1,
            _ => modified += 1,
        }
    }
    let noun = |n: usize| if n == 1 { "block" } else { "blocks" };
    let mut parts = Vec::new();
    if modified > 0 {
        parts.push(format!("{modified} {} changed", noun(modified)));
    }
    if added > 0 {
        parts.push(format!("{added} added"));
    }
    if deleted > 0 {
        parts.push(format!("{deleted} removed"));
    }
    if renamed > 0 {
        parts.push(format!("{renamed} renamed"));
    }
    if parts.is_empty() {
        "updated".to_string()
    } else {
        parts.join(", ")
    }
}

/// "function_definition" -> "function", "class_definition" -> "class", …
fn humanize_kind(kind: &str) -> String {
    let base = kind
        .trim_end_matches("_definition")
        .trim_end_matches("_declaration")
        .trim_end_matches("_item");
    match base {
        "function" | "fn" | "method" => "function",
        "class" => "class",
        "struct" => "struct",
        "enum" => "enum",
        "interface" => "interface",
        "impl" => "implementation",
        "trait" => "trait",
        other if other.is_empty() => "block",
        other => other,
    }
    .to_string()
}

// ---------------------------------------------------------------------------
// Top-level summary
// ---------------------------------------------------------------------------

/// A calm one-paragraph overview a non-developer reads first.
pub fn build_summary(
    file_count: usize,
    total_blocks: usize,
    risk_label: &str,
    findings: &[HumanFinding],
) -> String {
    let files = if file_count == 1 { "1 file".to_string() } else { format!("{file_count} files") };
    let blocks = if total_blocks == 1 {
        "1 code block".to_string()
    } else {
        format!("{total_blocks} code blocks")
    };

    let risk_sentence = match risk_label {
        "CRITICAL" => "Some changes need attention before this is merged.",
        "MODERATE" => "A few things here are worth a careful look.",
        _ => "Nothing here looks risky.",
    };

    let critical = findings.iter().filter(|f| f.severity == "critical").count();
    let warning = findings.iter().filter(|f| f.severity == "warning").count();
    let advisory = findings.iter().filter(|f| f.severity == "advisory").count();

    let mut breakdown = Vec::new();
    if critical > 0 {
        breakdown.push(format!("{critical} need{} attention", plural_verb(critical)));
    }
    if warning > 0 {
        breakdown.push(format!("{warning} to review"));
    }
    if advisory > 0 {
        breakdown.push(format!("{advisory} style suggestion{}", plural(advisory)));
    }

    let tail = if breakdown.is_empty() {
        "No issues found.".to_string()
    } else {
        format!("Things to look at: {}.", breakdown.join(", "))
    };

    format!("This update changes {files} ({blocks} in all). {risk_sentence} {tail}")
}

/// "1 need**s**" vs "2 need" — subject-verb agreement for the count.
fn plural_verb(n: usize) -> &'static str {
    if n == 1 { "s" } else { "" }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::models::AstNode;

    fn node(ident: &str, kind: &str, line: u32) -> AstNode {
        AstNode {
            node_id: ident.into(),
            kind: kind.into(),
            identifier: Some(ident.into()),
            content_hash: String::new(),
            children: vec![],
            dependencies: vec![],
            contains_secret: false,
            is_stub: false,
            derived_from: None,
            confidence: 0.0,
            file_path: None,
            start_line: Some(line),
            end_line: None,
            signature: None,
            doc_comment: None,
            top_level: true,
        }
    }

    #[test]
    fn forbidden_call_becomes_plain_security_card() {
        let raw = "Forbidden Call: Node 'load_card_for' calls 'unsafe_exec' (review-demo/payment_flow.rs:16)";
        let cards = humanize_findings(&[raw.into()], &[], &[], &[]);
        assert_eq!(cards.len(), 1);
        let c = &cards[0];
        assert_eq!(c.severity, "critical");
        assert_eq!(c.category, "security");
        assert_eq!(c.symbol.as_deref(), Some("load_card_for"));
        assert_eq!(c.file.as_deref(), Some("review-demo/payment_flow.rs"));
        assert_eq!(c.line, Some(16));
        assert!(c.title.contains("unsafe_exec"));
        assert!(c.suggestion.is_some());
        // No leftover raw "(path:line)" token in the human detail.
        assert!(!c.detail.contains(":16)"));
    }

    #[test]
    fn protected_node_modified_is_a_warning_not_critical() {
        let raw = "Protected Node Modified: 'hash_password' is a sensitive logic block. (review-demo/payment_flow.rs:25)";
        let cards = humanize_findings(&[raw.into()], &[], &[], &[]);
        assert_eq!(cards[0].severity, "warning");
        assert_eq!(cards[0].symbol.as_deref(), Some("hash_password"));
        assert_eq!(cards[0].line, Some(25));
    }

    #[test]
    fn layer_violation_does_not_eat_the_hops_paren() {
        let raw = "Layer Violation: 'ui' layer node 'render' eventually calls 'database' (3 hops) (src/ui.rs:9)";
        let cards = humanize_findings(&[raw.into()], &[], &[], &[]);
        let c = &cards[0];
        assert_eq!(c.category, "architecture");
        assert_eq!(c.symbol.as_deref(), Some("render"));
        // Location parsed from the trailing path token, not the "(3 hops)".
        assert_eq!(c.file.as_deref(), Some("src/ui.rs"));
        assert_eq!(c.line, Some(9));
    }

    #[test]
    fn identical_invariants_fold_into_one_card_with_count() {
        let raw = "Protected Node Modified: 'authenticate' is a sensitive logic block. (a.rs:3)";
        let cards = humanize_findings(&[raw.into(), raw.into(), raw.into()], &[], &[], &[]);
        assert_eq!(cards.len(), 1);
        assert_eq!(cards[0].count, 3);
    }

    #[test]
    fn eighteen_overlap_lines_roll_into_one_card() {
        let conflicts: Vec<String> = (0..18)
            .map(|i| format!("Graph-neighborhood overlap detected with branch aura/snapshot/{i}"))
            .collect();
        let cards = humanize_findings(&[], &[], &[], &conflicts);
        let overlap: Vec<_> = cards.iter().filter(|c| c.category == "impact").collect();
        assert_eq!(overlap.len(), 1);
        assert_eq!(overlap[0].count, 18);
        assert!(overlap[0].title.contains("18"));
    }

    #[test]
    fn blast_radius_rolls_up_and_samples() {
        let symbols: Vec<String> = (0..10).map(|i| format!("fn_{i}")).collect();
        let cards = humanize_findings(&[], &[], &symbols, &[]);
        let card = cards.iter().find(|c| c.category == "impact").unwrap();
        assert_eq!(card.severity, "info");
        assert_eq!(card.count, 10);
        assert!(card.detail.contains("and 6 more"));
    }

    #[test]
    fn taste_groups_by_template() {
        let taste = vec![
            "src/a.rs: prefer named import (rule: ts-named-imports, confidence 0.91)".to_string(),
            "src/b.rs: prefer named import (rule: ts-named-imports, confidence 0.88)".to_string(),
            "src/c.rs: avoid default export (rule: ts-no-default, confidence 0.90)".to_string(),
        ];
        let cards = humanize_findings(&[], &taste, &[], &[]);
        let style: Vec<_> = cards.iter().filter(|c| c.category == "style").collect();
        assert_eq!(style.len(), 2);
        let named = style.iter().find(|c| c.detail.contains("ts-named-imports")).unwrap();
        assert_eq!(named.count, 2);
        assert_eq!(named.severity, "advisory");
    }

    #[test]
    fn findings_sorted_worst_first() {
        let inv = vec![
            "Protected Node Modified: 'x' is a sensitive logic block. (a.rs:1)".to_string(), // warning
            "Forbidden Call: Node 'y' calls 'eval' (a.rs:2)".to_string(),                    // critical
        ];
        let taste = vec!["a.rs: nit (rule: r, confidence 0.9)".to_string()]; // advisory
        let cards = humanize_findings(&inv, &taste, &["z".into()], &[]);
        // critical, warning, advisory, info(blast)
        assert_eq!(cards[0].severity, "critical");
        assert_eq!(cards[1].severity, "warning");
        assert_eq!(cards[2].severity, "advisory");
        assert_eq!(cards[3].severity, "info");
    }

    #[test]
    fn change_intent_matches_by_symbol_name() {
        let changes = vec![
            ("src/auth.rs".to_string(), "login".to_string(), "modified".to_string()),
            ("src/auth.rs".to_string(), "logout".to_string(), "added".to_string()),
        ];
        let kinds = vec![("src/auth.rs".to_string(), node("login", "function_definition", 12))];
        let intents = vec![IntentRecord {
            intent: "Rework the login flow to support OAuth refresh tokens.".into(),
            agent_id: Some("claude".into()),
            timestamp: Some(1000),
            task_id: None,
            task_seq: None,
            origin: IntentOrigin::Local,
        }];
        let out = build_change_intents(&changes, &kinds, &intents, None);
        assert_eq!(out.len(), 1);
        let ci = &out[0];
        assert_eq!(ci.file, "src/auth.rs");
        assert_eq!(ci.symbols.len(), 2);
        assert_eq!(ci.what, "1 block changed, 1 added");
        assert!(ci.why.as_deref().unwrap().contains("login flow"));
        assert_eq!(ci.who.as_deref(), Some("claude"));
        assert_eq!(ci.when, Some(1000));
        // login's line/kind lifted from the parsed node.
        let login = ci.symbols.iter().find(|s| s.name == "login").unwrap();
        assert_eq!(login.line, Some(12));
        assert_eq!(login.kind.as_deref(), Some("function"));
    }

    #[test]
    fn change_intent_falls_back_to_checkpoint_when_no_match() {
        let changes = vec![("src/util.rs".to_string(), "helper".to_string(), "modified".to_string())];
        let intents = vec![IntentRecord {
            intent: "Totally unrelated work on the billing page.".into(),
            agent_id: Some("a".into()),
            timestamp: Some(5),
            task_id: None,
            task_seq: None,
            origin: IntentOrigin::Local,
        }];
        let out = build_change_intents(&changes, &[], &intents, Some(("Active checkpoint intent.", 42, "cp")));
        assert_eq!(out[0].why.as_deref(), Some("Active checkpoint intent."));
        assert_eq!(out[0].who.as_deref(), Some("cp"));
        assert_eq!(out[0].when, Some(42));
    }

    #[test]
    fn change_intent_never_fabricates_a_reason() {
        let changes = vec![("src/util.rs".to_string(), "helper".to_string(), "modified".to_string())];
        let out = build_change_intents(&changes, &[], &[], None);
        assert!(out[0].why.is_none());
        assert!(out[0].who.is_none());
    }

    #[test]
    fn notes_intent_fills_in_when_local_log_is_empty() {
        // The reviewer case: no local intent log at all, but the review
        // range's commits carry notes rows pushed by a teammate.
        let changes = vec![(
            "src/auth.rs".to_string(),
            "login".to_string(),
            "modified".to_string(),
        )];
        let intents = vec![IntentRecord {
            intent: "Rework the login flow to support OAuth refresh tokens.".into(),
            agent_id: Some("teammate".into()),
            timestamp: Some(900),
            origin: IntentOrigin::Notes,
            task_id: None,
            task_seq: None,
        }];
        let out = build_change_intents(&changes, &[], &intents, None);
        assert!(out[0].why.as_deref().unwrap().contains("login flow"));
        assert_eq!(out[0].who.as_deref(), Some("teammate · via notes"));
        assert_eq!(out[0].when, Some(900));
    }

    #[test]
    fn local_intent_beats_notes_when_both_match() {
        let changes = vec![(
            "src/auth.rs".to_string(),
            "login".to_string(),
            "modified".to_string(),
        )];
        // The notes row scores HIGHER (stem + symbol mention) and is newer —
        // the local row must still win: local is authoritative, notes only
        // fill an absence.
        let intents = vec![
            IntentRecord {
                intent: "Tighten login validation.".into(),
                agent_id: Some("me".into()),
                timestamp: Some(100),
                origin: IntentOrigin::Local,
                task_id: None,
                task_seq: None,
            },
            IntentRecord {
                intent: "Rework auth so login uses refresh tokens.".into(),
                agent_id: Some("peer".into()),
                timestamp: Some(999),
                origin: IntentOrigin::Notes,
                task_id: None,
                task_seq: None,
            },
        ];
        let out = build_change_intents(&changes, &[], &intents, None);
        assert_eq!(out[0].why.as_deref(), Some("Tighten login validation."));
        assert_eq!(out[0].who.as_deref(), Some("me"));
        assert_eq!(out[0].when, Some(100));
    }

    #[test]
    fn notes_intent_preferred_over_checkpoint_fallback() {
        // A scored notes match explains the file; the blanket checkpoint
        // fallback should not override it.
        let changes = vec![(
            "src/auth.rs".to_string(),
            "login".to_string(),
            "modified".to_string(),
        )];
        let intents = vec![IntentRecord {
            intent: "Harden the login path against replay.".into(),
            agent_id: Some("peer".into()),
            timestamp: Some(700),
            origin: IntentOrigin::Notes,
            task_id: None,
            task_seq: None,
        }];
        let out = build_change_intents(
            &changes,
            &[],
            &intents,
            Some(("Active checkpoint intent.", 42, "cp")),
        );
        assert!(out[0].why.as_deref().unwrap().contains("login path"));
        assert_eq!(out[0].who.as_deref(), Some("peer · via notes"));
    }

    #[test]
    fn unrelated_notes_rows_never_fabricate_a_reason() {
        // A notes row that mentions neither the file stem nor any changed
        // symbol must not attach — absent stays absent (modulo fallback).
        let changes = vec![(
            "src/util.rs".to_string(),
            "helper".to_string(),
            "modified".to_string(),
        )];
        let intents = vec![IntentRecord {
            intent: "Totally unrelated work on the billing page.".into(),
            agent_id: Some("peer".into()),
            timestamp: Some(5),
            origin: IntentOrigin::Notes,
            task_id: None,
            task_seq: None,
        }];
        let out = build_change_intents(&changes, &[], &intents, None);
        assert!(out[0].why.is_none());
        assert!(out[0].who.is_none());
    }

    #[test]
    fn notes_rows_load_from_review_range_and_tag_origin() {
        use crate::meta_refs::notes::{render_note_line, NoteLine, NOTES_REF};

        // Hermetic repo: base commit (noted) + head commit (noted). Only
        // the head commit is inside base..head, so only its row loads.
        let dir = tempfile::tempdir().unwrap();
        let repo = git2::Repository::init(dir.path()).unwrap();
        let sig = git2::Signature::now("t", "t@example.com").unwrap();
        let empty_tree = {
            let mut index = repo.index().unwrap();
            let id = index.write_tree().unwrap();
            repo.find_tree(id).unwrap()
        };
        let base = repo
            .commit(Some("HEAD"), &sig, &sig, "base", &empty_tree, &[])
            .unwrap();
        let base_commit = repo.find_commit(base).unwrap();
        let head = repo
            .commit(Some("HEAD"), &sig, &sig, "head", &empty_tree, &[&base_commit])
            .unwrap();

        let base_line = render_note_line(&NoteLine {
            ts: 100,
            agent_id: "old".into(),
            intent: "Old work already on the base branch.".into(),
            intent_type: None,
            key_id: None,
            signed_block_id: None,
        });
        repo.note(&sig, &sig, Some(NOTES_REF), base, &base_line, true)
            .unwrap();
        let head_line = render_note_line(&NoteLine {
            ts: 900,
            agent_id: "teammate".into(),
            intent: "Rework the login flow to support OAuth refresh tokens.".into(),
            intent_type: Some("Feature".into()),
            key_id: None,
            signed_block_id: None,
        });
        repo.note(&sig, &sig, Some(NOTES_REF), head, &head_line, true)
            .unwrap();

        let rows = load_notes_intents(&repo, base, head);
        assert_eq!(rows.len(), 1);
        assert_eq!(rows[0].origin, IntentOrigin::Notes);
        assert_eq!(rows[0].agent_id.as_deref(), Some("teammate"));
        assert_eq!(rows[0].timestamp, Some(900));
        assert!(rows[0].intent.contains("login flow"));

        // A repo without the notes ref yields an empty pool, never an error.
        let bare_dir = tempfile::tempdir().unwrap();
        let bare = git2::Repository::init(bare_dir.path()).unwrap();
        let b1 = bare
            .commit(Some("HEAD"), &sig, &sig, "only", &{
                let mut index = bare.index().unwrap();
                let id = index.write_tree().unwrap();
                bare.find_tree(id).unwrap()
            }, &[])
            .unwrap();
        assert!(load_notes_intents(&bare, b1, b1).is_empty());
    }

    #[test]
    fn summary_reads_in_plain_language() {
        let cards = vec![HumanFinding {
            severity: "critical".into(),
            category: "security".into(),
            title: "x".into(),
            detail: "y".into(),
            file: None,
            line: None,
            symbol: None,
            count: 1,
            suggestion: None,
        }];
        let s = build_summary(2, 5, "CRITICAL", &cards);
        assert!(s.contains("2 files"));
        assert!(s.contains("5 code blocks"));
        assert!(s.contains("need"));
        assert!(s.contains("attention"));
    }

    #[test]
    fn summary_clean_when_no_findings() {
        let s = build_summary(1, 1, "LOW", &[]);
        assert!(s.contains("1 file"));
        assert!(s.contains("1 code block"));
        assert!(s.contains("No issues found."));
    }
}
