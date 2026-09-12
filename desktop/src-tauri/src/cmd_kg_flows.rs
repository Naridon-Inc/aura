//! Feature flows — the "how does this actually work?" layer of the Code Map.
//!
//! A feature block says WHERE code lives; a flow says WHAT HAPPENS, in order:
//! an entry point (a command the window sends the engine, a screen, a CLI
//! verb, a function nothing else calls) followed by the chain of functions it
//! calls, one hop at a time, until the chain runs out. Every hop is an AST
//! `calls` edge from the checkpoint export — the same edge `aura graph` and
//! rewind trust — so a step is never a guess. Names, doc comments, file
//! paths, the intent log and the goals ledger supply the words. Nothing here
//! is narrated by a model; anything the code does not say is left blank
//! rather than invented.
//!
//! Pure core (`select_flows`) + thin IO shell (`aura_kg_flows`), same shape
//! as the feature projection next door.

use serde::{Deserialize, Serialize};
use std::collections::{HashMap, HashSet, VecDeque};
use std::path::{Path, PathBuf};

use crate::cmd_kg::{KgEdge, KgGraph, KgNode};
use crate::cmd_kg_features::{humanize, select_features_with_assignment, KgFeature};

/// Ceilings so the IPC payload stays small on any repo.
pub const FLOWS_PER_FEATURE: usize = 3;
pub const FLOW_CAP: usize = 120;
/// A flow is a story, not a stack trace — seven hops is already a long read.
pub const MAX_STEPS: usize = 7;
const ALSO_CALLS_SHOWN: usize = 3;
/// How far back "changed recently" looks in the intent log.
pub const CHANGE_WINDOW_DAYS: u64 = 14;
const CHANGE_WINDOW_SECS: u64 = CHANGE_WINDOW_DAYS * 24 * 3600;
const REACH_HOPS: usize = 6;
const REACH_CAP: usize = 200;
/// Candidates per feature that get their source context read for ranking.
const CLASSIFY_PER_FEATURE: usize = 40;
const DOC_MAX_CHARS: usize = 160;
/// Lines of source read above a symbol: enough for a doc block + attributes.
pub const CONTEXT_LINES: usize = 24;
/// A callee this many other places call is plumbing, not a step worth
/// following (`cn`, `invoke`, `format_err`, …). It is still counted.
const UTILITY_IN_DEGREE: usize = 40;
/// Names that say nothing on their own; followed only when nothing else is.
const GENERIC_NAMES: &[&str] = &[
    "new", "default", "from", "into", "fmt", "clone", "get", "set", "run", "call", "apply",
    "map", "eq", "hash", "drop", "deref", "as_ref", "to_string", "len", "is_empty", "cn",
];

// ─── payload ──────────────────────────────────────────────────────────────

#[derive(Serialize, Clone, Debug, PartialEq)]
pub struct KgFlowChange {
    /// Unix seconds.
    pub when: u64,
    pub who: String,
    pub why: String,
}

#[derive(Serialize, Clone, Debug)]
pub struct KgFlowGoal {
    pub id: String,
    pub text: String,
    /// `verified` | `partial` | `not_wired` | `unknown` — the goals ledger's
    /// own words, untouched.
    pub verdict: String,
    pub ok: u32,
    pub total: u32,
    /// Unix seconds of the run this verdict came from.
    pub at: u64,
}

#[derive(Serialize, Clone, Debug)]
pub struct KgFlowTrigger {
    /// `you` | `agent` | `app` | `cli` | `server` | `start` | `code`.
    pub kind: String,
    pub text: String,
}

#[derive(Serialize, Clone, Debug)]
pub struct KgFlowCallee {
    pub name: String,
    pub file: String,
    pub line: u32,
}

#[derive(Serialize, Clone, Debug)]
pub struct KgFlowStep {
    pub node_id: String,
    /// Raw identifier — the evidence.
    pub name: String,
    /// The identifier as a short sentence: `send_turn` → "Send turn".
    pub text: String,
    pub file: String,
    pub line: u32,
    /// `app` | `engine` | `server` | `browser` | `cli` | `mobile` | `shared` | `other`.
    #[serde(rename = "where")]
    pub where_: String,
    /// First sentence of the doc comment above the symbol, when there is one.
    pub doc: Option<String>,
    /// Identity comes from the checkpoint export (rename-proof).
    pub canonical: bool,
    /// Other functions this step calls that the story did not follow.
    pub also_calls: Vec<KgFlowCallee>,
    pub also_calls_total: usize,
    pub changed: Option<KgFlowChange>,
    /// Feature this step's file belongs to — differs from the flow's feature
    /// when the story crosses into another part of the product.
    pub feature: Option<String>,
}

#[derive(Serialize, Clone, Debug)]
pub struct KgFlowOutcome {
    /// `save` | `see` | `end` — picked from the last step's name.
    pub kind: String,
    pub text: String,
}

#[derive(Serialize, Clone, Debug)]
pub struct KgFlow {
    /// The entry node id — stable across rebuilds when canonical.
    pub id: String,
    pub feature: String,
    pub name: String,
    pub trigger: KgFlowTrigger,
    pub steps: Vec<KgFlowStep>,
    pub outcome: KgFlowOutcome,
    /// `traced` when every hop is a checkpoint `calls` edge between canonical
    /// symbols; `seen` when any endpoint is an outline-only guess.
    pub verdict: String,
    pub goal: Option<KgFlowGoal>,
    /// Most recent change across the steps.
    pub changed: Option<KgFlowChange>,
    /// Distinct functions reachable from the entry within a few hops —
    /// how much of the product this one entry pulls on.
    pub reach: usize,
}

#[derive(Serialize, Clone, Debug)]
pub struct KgFlowFeatureSummary {
    pub feature: String,
    /// Entry points found in this feature (call-graph roots).
    pub entries: usize,
    pub shown: usize,
    /// First sentence of the module doc at the feature's front door
    /// (`mod.rs`, `index.ts`, `README.md`), when there is one.
    pub blurb: Option<String>,
}

#[derive(Serialize, Clone, Debug, Default)]
pub struct KgFlowTally {
    pub traced: usize,
    pub seen: usize,
    pub proved: usize,
    pub gaps: usize,
    pub changed: usize,
}

#[derive(Serialize, Clone, Debug, Default)]
pub struct KgFlowMap {
    pub flows: Vec<KgFlow>,
    pub features: Vec<KgFlowFeatureSummary>,
    pub tally: KgFlowTally,
    pub change_window_days: u64,
    pub built_at: u64,
    pub head_sha: String,
    pub graph_version: String,
    pub canonical_symbols: usize,
    pub symbols: usize,
}

// ─── inputs (pure core never touches disk) ────────────────────────────────

#[derive(Clone, Debug, Default)]
pub struct ChangeIn {
    pub when: u64,
    pub who: String,
    pub why: String,
    pub files: Vec<String>,
}

#[derive(Clone, Debug, Default)]
pub struct GoalRunIn {
    pub verdict: String,
    pub ok: u32,
    pub total: u32,
    pub at: u64,
}

#[derive(Clone, Debug, Default)]
pub struct GoalIn {
    pub id: String,
    pub text: String,
    /// Requirement node names from the decomposition.
    pub requirements: Vec<String>,
    /// Newest run, if the goal has ever been proved.
    pub run: Option<GoalRunIn>,
}

/// What the working tree says at a symbol's address: up to `CONTEXT_LINES`
/// lines directly above it (oldest first) and the line itself plus the two
/// after it. `at` left empty means the reader chose not to verify the
/// address (tests); the real reader always fills it.
#[derive(Clone, Debug, Default, PartialEq)]
pub struct SourceWindow {
    pub above: Vec<String>,
    pub at: Vec<String>,
}

/// `None` when the file is not there or the line is past its end — a symbol
/// the checkpoint remembers but the tree no longer has. Such a ghost is never
/// shown: an evidence link that opens the wrong line is worse than none.
/// Injected so the core stays pure in tests.
pub type SourceLines<'a> = dyn FnMut(&str, u32) -> Option<SourceWindow> + 'a;

/// A symbol is present when its file is readable and its name sits on the
/// line the graph claims (or one of the two after it, for decorators and
/// `export default` splits).
fn present(n: &KgNode, w: &Option<SourceWindow>) -> bool {
    match w {
        None => false,
        Some(w) => w.at.is_empty() || w.at.iter().any(|l| l.contains(n.name.as_str())),
    }
}

// ─── words ────────────────────────────────────────────────────────────────

fn is_acronym(w: &str) -> bool {
    !w.is_empty() && w.len() <= 5 && w.chars().all(|c| c.is_uppercase() || c.is_ascii_digit())
}

/// `send_turn` → "Send turn", `aura_kg_flows` → "Kg flows", `HandleGoogleCallback`
/// → "Handle google callback". Acronyms keep their caps.
pub fn sentence(name: &str) -> String {
    let stripped = ["aura_", "cmd_"]
        .iter()
        .find_map(|p| name.strip_prefix(p).filter(|r| !r.is_empty()))
        .unwrap_or(name);
    let words = humanize(stripped);
    let mut out = String::new();
    for (i, w) in words.split(' ').enumerate() {
        if i > 0 {
            out.push(' ');
        }
        if i == 0 || is_acronym(w) {
            out.push_str(w);
        } else {
            out.push_str(&w.to_lowercase());
        }
    }
    out
}

fn lower_first(s: &str) -> String {
    let mut cs = s.chars();
    match cs.next() {
        Some(f) if !is_acronym(s.split(' ').next().unwrap_or("")) => {
            f.to_lowercase().collect::<String>() + cs.as_str()
        }
        _ => s.to_string(),
    }
}

/// Where a file's code runs, from its path. Unknown → `other` (the UI falls
/// back to the area name).
pub fn where_of(file: &str) -> &'static str {
    let f = file.replace('\\', "/").to_lowercase();
    let has = |needle: &str| f.contains(needle);
    if has("src-tauri") || has("aura-core") || has("aura-engine") || has("/native/") {
        "engine"
    } else if has("aura-shell/") || has("/desktop/") {
        "app"
    } else if has("aura-cli") || has("/cli/") {
        "cli"
    } else if has("aura-cloud") || has("aura-billing") || has("aura-server") || has("/server/")
        || has("/backend/") || has("/api/")
    {
        "server"
    } else if has("aura-console") || has("aura-web") || has("/console/") || has("/frontend/")
        || has("/web/")
    {
        "browser"
    } else if has("aura-mobile") || has("/mobile/") || has("/ios/") || has("/android/") {
        "mobile"
    } else if has("aura-shared") || has("/shared/") {
        "shared"
    } else {
        "other"
    }
}

/// Paths whose functions are checks, not product behaviour.
pub fn is_test_path(file: &str) -> bool {
    let f = file.replace('\\', "/").to_lowercase();
    let name = f.rsplit('/').next().unwrap_or(&f);
    f.contains("/tests/") || f.contains("/__tests__/") || f.contains("/test/") || f.contains("/benches/")
        || f.contains("/fixtures/") || f.contains("/e2e/")
        || name.contains(".test.") || name.contains(".spec.") || name.ends_with("_test.rs")
        || name.ends_with("_tests.rs") || name.starts_with("test_")
}

fn is_generic_name(name: &str) -> bool {
    GENERIC_NAMES.iter().any(|g| name.eq_ignore_ascii_case(g))
}

fn outcome_kind(name: &str) -> &'static str {
    let n = name.to_lowercase();
    const SAVE: &[&str] = &[
        "write", "save", "persist", "store", "insert", "append", "commit", "flush", "upsert", "record",
        "log_", "snapshot",
    ];
    const SEE: &[&str] = &[
        "render", "show", "display", "emit", "send", "notify", "print", "toast", "open", "dispatch",
        "reply", "respond", "publish",
    ];
    if SAVE.iter().any(|k| n.contains(k)) {
        "save"
    } else if SEE.iter().any(|k| n.contains(k)) {
        "see"
    } else {
        "end"
    }
}

// ─── source context: attributes + doc comment above a symbol ──────────────

#[derive(Debug, Default, Clone, PartialEq)]
pub struct Context {
    /// Attribute / decorator lines directly above the symbol, trimmed.
    pub attrs: Vec<String>,
    pub doc: Option<String>,
}

fn hash_comments(file: &str) -> bool {
    let f = file.to_lowercase();
    [".py", ".sh", ".rb", ".toml", ".yaml", ".yml", ".zsh", ".bash"].iter().any(|e| f.ends_with(e))
}

fn strip_comment_marker<'a>(t: &'a str, file: &str) -> Option<&'a str> {
    for m in ["///", "//!", "/**", "/*", "//", "*/"] {
        if let Some(r) = t.strip_prefix(m) {
            return Some(r.trim_end_matches("*/").trim());
        }
    }
    if let Some(r) = t.strip_prefix('*') {
        return Some(r.trim_end_matches("*/").trim());
    }
    if hash_comments(file) {
        if let Some(r) = t.strip_prefix('#') {
            return Some(r.trim());
        }
    }
    None
}

fn is_directive(s: &str) -> bool {
    let l = s.to_lowercase();
    ["eslint", "@ts-", "prettier", "biome-", "noqa", "type:", "safety:", "allow(", "todo", "fixme", "!"]
        .iter()
        .any(|p| l.starts_with(p))
}

fn is_banner(s: &str) -> bool {
    let total = s.chars().filter(|c| !c.is_whitespace()).count();
    if total == 0 {
        return true;
    }
    let alnum = s.chars().filter(|c| c.is_alphanumeric()).count();
    alnum * 2 < total
}

fn first_sentence(text: &str) -> String {
    let t = text.replace('`', "");
    let t = t.split_whitespace().collect::<Vec<_>>().join(" ");
    let mut cut = t.len();
    let bytes = t.as_bytes();
    for (i, ch) in t.char_indices() {
        if matches!(ch, '.' | '!' | '?') {
            let next = bytes.get(i + 1).copied();
            let prev_digit = i > 0 && bytes[i - 1].is_ascii_digit();
            if next.map_or(true, |b| b == b' ') && !prev_digit {
                cut = i + 1;
                break;
            }
        }
    }
    let mut s = t[..cut].trim().to_string();
    if s.chars().count() > DOC_MAX_CHARS {
        let mut end = 0;
        for (i, _) in s.char_indices() {
            if i > DOC_MAX_CHARS {
                break;
            }
            if s.as_bytes()[i] == b' ' {
                end = i;
            }
        }
        if end > 0 {
            s.truncate(end);
            s.push('…');
        }
    }
    s
}

/// Read the attribute block and the doc comment sitting directly above a
/// symbol out of the lines above it. Stops at the first blank or code line.
pub fn read_context(lines_above: &[String], file: &str) -> Context {
    let mut attrs: Vec<String> = Vec::new();
    let mut doc_lines: Vec<String> = Vec::new();
    let mut open_brackets: i32 = 0; // `]` seen minus `[` seen, scanning upward
    let mut in_docs = false;
    // Did we reach the top of the doc block (a blank, a code line, a `/*`
    // opener)? If the window ran out first, the block's first sentence is
    // above what we read, and a mid-paragraph fragment must not pose as it.
    let mut terminated = false;
    for raw in lines_above.iter().rev() {
        let t = raw.trim();
        if !in_docs {
            let closes = t.matches(']').count() as i32 - t.matches('[').count() as i32;
            let is_attr = t.starts_with("#[") || t.starts_with('@') || open_brackets > 0;
            if is_attr {
                open_brackets = (open_brackets + closes).max(0);
                attrs.push(t.to_string());
                continue;
            }
            if t.is_empty() {
                terminated = true;
                break;
            }
            in_docs = true;
        }
        let opener = t.starts_with("/*");
        match strip_comment_marker(t, file) {
            Some(body) => {
                if body.starts_with('@') {
                    // JSDoc tag: the summary is above it, keep reading.
                    doc_lines.clear();
                } else if !(body.is_empty() || is_directive(body) || is_banner(body)) {
                    doc_lines.push(body.to_string());
                }
                if opener {
                    terminated = true;
                    break;
                }
            }
            None => {
                terminated = true;
                break;
            }
        }
    }
    if in_docs && !terminated && lines_above.len() >= CONTEXT_LINES {
        doc_lines.clear();
    }
    attrs.reverse();
    doc_lines.reverse();
    let doc = if doc_lines.is_empty() {
        None
    } else {
        let s = first_sentence(&doc_lines.join(" "));
        if s.is_empty() { None } else { Some(s) }
    };
    Context { attrs, doc }
}

fn attrs_say_test(attrs: &[String]) -> bool {
    attrs.iter().any(|a| {
        a.starts_with("#[test") || a.starts_with("#[tokio::test") || a.starts_with("#[cfg(test")
            || a.starts_with("#[bench") || a.starts_with("#[rstest")
    })
}

fn trigger_for(n: &KgNode, ctx: &Context, where_: &str, area: &str) -> KgFlowTrigger {
    let name = n.name.as_str();
    let file = n.file.to_lowercase();
    let said = sentence(name);
    let mk = |kind: &str, text: String| KgFlowTrigger { kind: kind.to_string(), text };
    if ctx.attrs.iter().any(|a| a.starts_with("#[tauri::command")) {
        return mk("app", format!("The app window asks the engine to {}", lower_first(&said)));
    }
    if name == "main" {
        return mk("start", "The program starts".to_string());
    }
    if ctx.attrs.iter().any(|a| {
        a.starts_with("#[get(") || a.starts_with("#[post(") || a.starts_with("#[put(")
            || a.starts_with("#[delete(") || a.starts_with("#[axum") || a.starts_with("#[handler")
            || a.starts_with("@app.route") || a.starts_with("@router.")
    }) {
        return mk("server", format!("A request reaches the server: {}", lower_first(&said)));
    }
    let after = |prefix: &str| -> Option<String> {
        let rest = name.strip_prefix(prefix)?;
        let first = rest.chars().next()?;
        if !first.is_uppercase() && first != '_' {
            return None;
        }
        let rest = rest.trim_start_matches('_');
        if rest.is_empty() { None } else { Some(lower_first(&sentence(rest))) }
    };
    if let Some(what) = after("handle").or_else(|| after("on")) {
        return mk("you", format!("When you {what}"));
    }
    if let Some(what) = after("use") {
        return mk("app", format!("The screen needs {what}"));
    }
    if (file.ends_with(".tsx") || file.ends_with(".jsx") || file.ends_with(".vue") || file.ends_with(".svelte"))
        && name.chars().next().map_or(false, char::is_uppercase)
    {
        return mk("you", format!("You see {} on screen", humanize(name)));
    }
    if where_ == "cli"
        && (name == "run" || name == "execute" || name.starts_with("run_") || name.starts_with("cmd_")
            || name.starts_with("exec_"))
    {
        return mk("cli", format!("You run a command in the terminal: {}", lower_first(&said)));
    }
    if name.starts_with("spawn") || name.starts_with("start_") || name.starts_with("launch") {
        return mk("agent", format!("Something starts {}", lower_first(&said)));
    }
    let place = if area.is_empty() { "the code".to_string() } else { area.to_string() };
    mk(
        "code",
        format!("{said} starts here — nothing else in {place} calls it first"),
    )
}

// ─── the projection ───────────────────────────────────────────────────────

struct CallGraph {
    idx: HashMap<String, usize>,
    out: Vec<Vec<usize>>,
    in_deg: Vec<usize>,
}

/// Only an edge the exporter resolved to a definition counts as a hop. A
/// "name-only" edge (a bare identifier match — nine in ten of them) or an
/// unlabeled one is a guess, and a guess is never drawn as a step.
fn edge_is_fact(e: &KgEdge) -> bool {
    match e.label.as_deref() {
        Some("exact") | Some("import-resolved") => true,
        Some(_) => false,
        None => e.confidence.map_or(false, |c| c >= 0.75),
    }
}

fn call_graph(g: &KgGraph) -> CallGraph {
    let idx: HashMap<String, usize> = g
        .nodes
        .iter()
        .enumerate()
        .filter(|(_, n)| n.kind == "fn")
        .map(|(i, n)| (n.id.clone(), i))
        .collect();
    let mut out: Vec<Vec<usize>> = vec![Vec::new(); g.nodes.len()];
    let mut in_deg = vec![0usize; g.nodes.len()];
    let mut seen: HashSet<(usize, usize)> = HashSet::new();
    for e in &g.edges {
        if e.kind != "calls" || !edge_is_fact(e) {
            continue;
        }
        let (Some(&a), Some(&b)) = (idx.get(e.from.as_str()), idx.get(e.to.as_str())) else {
            continue;
        };
        if a == b || !seen.insert((a, b)) {
            continue;
        }
        out[a].push(b);
        in_deg[b] += 1;
    }
    CallGraph { idx, out, in_deg }
}

fn reach_of(cg: &CallGraph, start: usize) -> usize {
    let mut seen: HashSet<usize> = HashSet::from([start]);
    let mut q: VecDeque<(usize, usize)> = VecDeque::from([(start, 0)]);
    while let Some((n, d)) = q.pop_front() {
        if d >= REACH_HOPS {
            continue;
        }
        for &m in &cg.out[n] {
            if seen.len() >= REACH_CAP {
                return seen.len() - 1;
            }
            if seen.insert(m) {
                q.push_back((m, d + 1));
            }
        }
    }
    seen.len() - 1
}

/// Rank a callee as the next step: real product code beats plumbing, a
/// function that keeps the story going beats a leaf, and a name that says
/// something beats `new`.
fn callee_score(g: &KgGraph, cg: &CallGraph, i: usize) -> (i32, i32, usize) {
    let n = &g.nodes[i];
    let utility = n.god || cg.in_deg[i] >= UTILITY_IN_DEGREE || is_test_path(&n.file);
    let generic = is_generic_name(&n.name);
    let tier = if utility { 0 } else if generic { 1 } else { 2 };
    (tier, cg.out[i].len() as i32, usize::MAX - n.degree)
}

fn same_file(claimed: &str, step_file: &str) -> bool {
    let c = claimed.replace('\\', "/");
    let c = c.trim();
    if c.is_empty() {
        return false;
    }
    c == step_file
        || c.ends_with(&format!("/{step_file}"))
        || (c.contains('/') && step_file.ends_with(&format!("/{c}")))
}

/// Entries a person can name come first: a command the window sends, a CLI
/// verb, a request handler, `main`, and the screen a file is named after. A
/// helper component inside someone else's file is a screen too, but a lesser
/// one; a bare function nobody calls comes last.
fn trigger_rank(kind: &str, n: &KgNode) -> usize {
    let stem = n.file.rsplit('/').next().and_then(|b| b.split('.').next()).unwrap_or("");
    match kind {
        "app" | "cli" | "server" | "start" => 0,
        "you" if stem == n.name => 0,
        "you" => 1,
        "agent" => 2,
        _ => 3,
    }
}

/// Pure projection: graph + ledgers in, flows out. `now` is unix seconds.
pub fn select_flows(
    g: &KgGraph,
    changes: &[ChangeIn],
    goals: &[GoalIn],
    now: u64,
    source: &mut SourceLines<'_>,
) -> KgFlowMap {
    let (fmap, node_feature) = select_features_with_assignment(g);
    let feature_by_id: HashMap<&str, &KgFeature> =
        fmap.features.iter().map(|f| (f.id.as_str(), f)).collect();
    let cg = call_graph(g);

    // 1. Entry candidates: call-graph roots per feature, ranked by how much
    //    they pull on. Test code never starts a story.
    let mut roots_by_feature: HashMap<&str, Vec<(usize, usize)>> = HashMap::new();
    for (id, &i) in &cg.idx {
        if cg.in_deg[i] != 0 || cg.out[i].is_empty() {
            continue;
        }
        let n = &g.nodes[i];
        if is_test_path(&n.file) || n.name.starts_with("test_") {
            continue;
        }
        let Some(fid) = node_feature.get(id.as_str()) else { continue };
        roots_by_feature.entry(fid.as_str()).or_default().push((i, reach_of(&cg, i)));
    }

    // 2. Pick FLOWS_PER_FEATURE entries per feature: read their context once,
    //    drop ghosts and `#[test]`s, prefer entries a person can name (a
    //    command, a screen, a verb), then the ones that reach furthest.
    let mut probe_cache: HashMap<usize, (Context, bool)> = HashMap::new();
    let mut probe = |i: usize, cache: &mut HashMap<usize, (Context, bool)>| -> (Context, bool) {
        if let Some(c) = cache.get(&i) {
            return c.clone();
        }
        let n = &g.nodes[i];
        let window = if n.line > 0 { source(&n.file, n.line) } else { None };
        let here = present(n, &window);
        let ctx = read_context(&window.map(|w| w.above).unwrap_or_default(), &n.file);
        cache.insert(i, (ctx.clone(), here));
        (ctx, here)
    };
    struct Pick {
        node: usize,
        reach: usize,
        trigger: KgFlowTrigger,
        ctx: Context,
    }
    let mut picks: Vec<(String, Pick)> = Vec::new();
    let mut summaries: Vec<KgFlowFeatureSummary> = Vec::with_capacity(fmap.features.len());
    for f in &fmap.features {
        let mut roots = roots_by_feature.remove(f.id.as_str()).unwrap_or_default();
        roots.sort_by(|a, b| b.1.cmp(&a.1).then_with(|| g.nodes[a.0].name.cmp(&g.nodes[b.0].name)));
        let entries = roots.len();
        let mut ranked: Vec<Pick> = Vec::new();
        for &(i, reach) in roots.iter().take(CLASSIFY_PER_FEATURE) {
            let (ctx, here) = probe(i, &mut probe_cache);
            if !here || attrs_say_test(&ctx.attrs) {
                continue;
            }
            let n = &g.nodes[i];
            let trigger = trigger_for(n, &ctx, where_of(&n.file), &f.area);
            ranked.push(Pick { node: i, reach, trigger, ctx });
        }
        ranked.sort_by(|a, b| {
            trigger_rank(&a.trigger.kind, &g.nodes[a.node])
                .cmp(&trigger_rank(&b.trigger.kind, &g.nodes[b.node]))
                .then_with(|| b.reach.cmp(&a.reach))
                .then_with(|| g.nodes[a.node].name.cmp(&g.nodes[b.node].name))
        });
        ranked.truncate(FLOWS_PER_FEATURE);
        for p in ranked {
            picks.push((f.id.clone(), p));
        }
        summaries.push(KgFlowFeatureSummary { feature: f.id.clone(), entries, shown: 0, blurb: None });
    }
    picks.truncate(FLOW_CAP);

    // 3. Walk each entry: one callee at a time, never revisiting, until the
    //    chain runs out or the story is long enough.
    let mut flows: Vec<KgFlow> = Vec::with_capacity(picks.len());
    for (fid, p) in picks {
        let mut visited: HashSet<usize> = HashSet::from([p.node]);
        let mut path: Vec<usize> = vec![p.node];
        let mut cur = p.node;
        while path.len() < MAX_STEPS {
            let mut cands: Vec<usize> = cg.out[cur].iter().copied().filter(|c| !visited.contains(c)).collect();
            cands.sort_by(|&a, &b| callee_score(g, &cg, b).cmp(&callee_score(g, &cg, a)));
            let Some(&next) = cands.iter().find(|&&c| probe(c, &mut probe_cache).1) else {
                break;
            };
            visited.insert(next);
            path.push(next);
            cur = next;
        }
        if path.len() < 2 {
            continue; // an entry that leads nowhere the tree can show is not a story
        }
        let mut steps: Vec<KgFlowStep> = Vec::with_capacity(path.len());
        for (k, &i) in path.iter().enumerate() {
            let n = &g.nodes[i];
            let ctx = if k == 0 { p.ctx.clone() } else { probe(i, &mut probe_cache).0 };
            let followed = path.get(k + 1).copied();
            let mut others: Vec<usize> = cg.out[i]
                .iter()
                .copied()
                .filter(|&c| Some(c) != followed && !path.contains(&c) && probe(c, &mut probe_cache).1)
                .collect();
            others.sort_by(|&a, &b| callee_score(g, &cg, b).cmp(&callee_score(g, &cg, a)));
            let also_calls_total = others.len();
            let also_calls = others
                .iter()
                .take(ALSO_CALLS_SHOWN)
                .map(|&c| KgFlowCallee {
                    name: g.nodes[c].name.clone(),
                    file: g.nodes[c].file.clone(),
                    line: g.nodes[c].line,
                })
                .collect();
            steps.push(KgFlowStep {
                node_id: n.id.clone(),
                name: n.name.clone(),
                text: sentence(&n.name),
                file: n.file.clone(),
                line: n.line,
                where_: where_of(&n.file).to_string(),
                doc: ctx.doc,
                canonical: n.provenance == "checkpoint",
                also_calls,
                also_calls_total,
                changed: None,
                feature: node_feature.get(n.id.as_str()).cloned(),
            });
        }
        let last = steps.last().expect("a flow has at least its entry");
        let outcome = KgFlowOutcome { kind: outcome_kind(&last.name).to_string(), text: last.text.clone() };
        let verdict = if steps.iter().all(|s| s.canonical) { "traced" } else { "seen" };
        flows.push(KgFlow {
            id: g.nodes[p.node].id.clone(),
            feature: fid,
            name: sentence(&g.nodes[p.node].name),
            trigger: p.trigger,
            steps,
            outcome,
            verdict: verdict.to_string(),
            goal: None,
            changed: None,
            reach: p.reach,
        });
    }

    for s in &mut summaries {
        s.shown = flows.iter().filter(|f| f.feature == s.feature).count();
    }

    // 4. Recent change reasons: newest intent row per step file, in window.
    let step_files: HashSet<String> =
        flows.iter().flat_map(|f| f.steps.iter().map(|s| s.file.clone())).collect();
    let since = now.saturating_sub(CHANGE_WINDOW_SECS);
    let mut latest_by_file: HashMap<String, KgFlowChange> = HashMap::new();
    for c in changes {
        if c.when < since || c.when > now.saturating_add(3600) || c.why.trim().is_empty() {
            continue;
        }
        for claimed in &c.files {
            for sf in &step_files {
                if !same_file(claimed, sf) {
                    continue;
                }
                let newer = latest_by_file.get(sf.as_str()).map_or(true, |prev| c.when > prev.when);
                if newer {
                    latest_by_file.insert(
                        sf.clone(),
                        KgFlowChange { when: c.when, who: c.who.clone(), why: c.why.trim().to_string() },
                    );
                }
            }
        }
    }
    for f in &mut flows {
        for s in &mut f.steps {
            s.changed = latest_by_file.get(s.file.as_str()).cloned();
        }
        f.changed = f.steps.iter().filter_map(|s| s.changed.clone()).max_by_key(|c| c.when);
    }

    // 5. Goal verdicts: a goal joins a flow when its requirements name the
    //    flow's steps. File overlap alone is too loose to claim a verdict.
    for f in &mut flows {
        let mut best: Option<(usize, &GoalIn)> = None;
        for goal in goals.iter().filter(|g| g.run.is_some()) {
            let overlap = f.steps.iter().filter(|s| goal.requirements.iter().any(|r| r == &s.name)).count();
            if overlap == 0 {
                continue;
            }
            if best.map_or(true, |(o, _)| overlap > o) {
                best = Some((overlap, goal));
            }
        }
        if let Some((_, goal)) = best {
            let run = goal.run.as_ref().expect("filtered on run");
            f.goal = Some(KgFlowGoal {
                id: goal.id.clone(),
                text: goal.text.clone(),
                verdict: run.verdict.clone(),
                ok: run.ok,
                total: run.total,
                at: run.at,
            });
        }
    }

    // 6. Feature blurbs from the module doc at each feature's front door.
    let mut front_doors: HashMap<&str, Vec<&str>> = HashMap::new();
    for n in g.nodes.iter().filter(|n| n.kind == "file") {
        let Some(fid) = node_feature.get(n.id.as_str()) else { continue };
        let base = n.file.rsplit('/').next().unwrap_or(&n.file);
        if matches!(base, "mod.rs" | "lib.rs" | "main.rs" | "index.ts" | "index.tsx" | "README.md" | "__init__.py") {
            front_doors.entry(fid.as_str()).or_default().push(n.file.as_str());
        }
    }
    for s in &mut summaries {
        let Some(doors) = front_doors.get(s.feature.as_str()) else { continue };
        let mut doors = doors.clone();
        doors.sort();
        for door in doors {
            let head = source(door, (CONTEXT_LINES + 1) as u32).map(|w| w.above).unwrap_or_default();
            // A module doc is the first comment block in the file — feed it in
            // as if a symbol sat right under it.
            let mut block: Vec<String> = Vec::new();
            for l in &head {
                let t = l.trim();
                if t.is_empty() && block.is_empty() {
                    continue;
                }
                if strip_comment_marker(t, door).is_none() && !t.starts_with("# ") {
                    break;
                }
                block.push(l.clone());
            }
            let blurb = if door.ends_with(".md") {
                block
                    .iter()
                    .map(|l| l.trim().trim_start_matches('#').trim().to_string())
                    .find(|l| !l.is_empty() && !is_banner(l))
                    .map(|l| first_sentence(&l))
            } else {
                // The top of the file is a real boundary: mark it so a long
                // module doc is not mistaken for one that ran off the window.
                block.insert(0, String::new());
                read_context(&block, door).doc
            };
            if let Some(b) = blurb.filter(|b| !b.is_empty()) {
                s.blurb = Some(b);
                break;
            }
        }
    }
    let _ = &feature_by_id;

    // 7. Tally.
    let mut tally = KgFlowTally::default();
    for f in &flows {
        match f.goal.as_ref().map(|g| g.verdict.as_str()) {
            Some("partial") | Some("not_wired") => tally.gaps += 1,
            Some("verified") => tally.proved += 1,
            _ => {}
        }
        if f.verdict == "traced" { tally.traced += 1 } else { tally.seen += 1 }
        if f.changed.is_some() {
            tally.changed += 1;
        }
    }

    KgFlowMap {
        flows,
        features: summaries,
        tally,
        change_window_days: CHANGE_WINDOW_DAYS,
        built_at: g.built_at,
        head_sha: g.head_sha.clone(),
        graph_version: g.graph_version.clone(),
        canonical_symbols: g.stats.canonical,
        symbols: g.stats.symbols,
    }
}

// ─── IO shell ─────────────────────────────────────────────────────────────

fn now_secs() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0)
}

/// Ledgers mix seconds and milliseconds; normalise to seconds.
fn as_secs(t: u64) -> u64 {
    if t > 100_000_000_000 { t / 1000 } else { t }
}

fn load_changes(root: &str) -> Vec<ChangeIn> {
    let rows = crate::cmd_aura::read_intent_rows(root).unwrap_or_default();
    rows.into_iter()
        .filter_map(|r| {
            let files: Vec<String> = r
                .changeset
                .as_ref()
                .map(|c| c.files.iter().map(|f| f.path.clone()).collect())
                .unwrap_or_default();
            if files.is_empty() || r.intent.trim().is_empty() {
                return None;
            }
            let who = r
                .developer_handle
                .clone()
                .or_else(|| r.developer.clone())
                .filter(|s| !s.trim().is_empty())
                .unwrap_or_else(|| r.agent_id.clone());
            Some(ChangeIn { when: as_secs(r.timestamp), who, why: r.intent.clone(), files })
        })
        .collect()
}

#[derive(Deserialize)]
struct GoalLine {
    #[serde(default)]
    id: String,
    #[serde(default)]
    text: String,
    #[serde(default)]
    decomposition: Option<GoalDecompLine>,
    #[serde(default)]
    runs: Vec<GoalRunLine>,
}

#[derive(Deserialize)]
struct GoalDecompLine {
    #[serde(default)]
    requirements: Vec<GoalReqLine>,
}

#[derive(Deserialize)]
struct GoalReqLine {
    #[serde(default)]
    node_name: String,
}

#[derive(Deserialize)]
struct GoalRunLine {
    #[serde(default)]
    verdict: String,
    #[serde(default)]
    ok: u32,
    #[serde(default)]
    total: u32,
    #[serde(default)]
    at: u64,
}

/// `.aura/goals.jsonl` → the pure input. Runs are newest-first in the ledger
/// (same convention `cmd_mission::load_proofs` relies on). Missing or
/// malformed lines are skipped, never fatal.
fn load_goals(root: &str) -> Vec<GoalIn> {
    let path = Path::new(root).join(".aura").join("goals.jsonl");
    let Ok(text) = std::fs::read_to_string(&path) else { return Vec::new() };
    text.lines()
        .filter(|l| !l.trim().is_empty())
        .filter_map(|l| serde_json::from_str::<GoalLine>(l).ok())
        .map(|g| GoalIn {
            id: g.id,
            text: g.text,
            requirements: g
                .decomposition
                .map(|d| d.requirements.into_iter().map(|r| r.node_name).filter(|n| !n.is_empty()).collect())
                .unwrap_or_default(),
            run: g.runs.into_iter().next().map(|r| GoalRunIn {
                verdict: r.verdict,
                ok: r.ok,
                total: r.total,
                at: as_secs(r.at),
            }),
        })
        .collect()
}

const SOURCE_MAX_BYTES: u64 = 2 * 1024 * 1024;

/// Reads each source file at most once per build; oversized or unreadable
/// files yield no context rather than an error.
struct FsSource {
    root: PathBuf,
    cache: HashMap<String, Option<Vec<String>>>,
}

impl FsSource {
    fn new(root: &str) -> Self {
        Self { root: PathBuf::from(root), cache: HashMap::new() }
    }

    fn window(&mut self, file: &str, line: u32) -> Option<SourceWindow> {
        if !self.cache.contains_key(file) {
            let p = if Path::new(file).is_absolute() { PathBuf::from(file) } else { self.root.join(file) };
            let ok_size = std::fs::metadata(&p).map(|m| m.len() <= SOURCE_MAX_BYTES).unwrap_or(false);
            let lines = if ok_size {
                std::fs::read_to_string(&p).ok().map(|s| s.lines().map(str::to_string).collect::<Vec<_>>())
            } else {
                None
            };
            self.cache.insert(file.to_string(), lines);
        }
        let lines = self.cache.get(file)?.as_ref()?;
        let at = line.checked_sub(1)? as usize;
        if at >= lines.len() {
            return None; // the tree's file is shorter than the checkpoint remembers
        }
        let above_start = at.saturating_sub(CONTEXT_LINES);
        let at_end = (at + 3).min(lines.len());
        Some(SourceWindow { above: lines[above_start..at].to_vec(), at: lines[at..at_end].to_vec() })
    }
}

/// Same contract as `aura_kg_features`: `None` means "no graph yet — call
/// ensure, then ask again". The walk plus the bounded source reads run on the
/// blocking pool so the window never waits on disk.
#[tauri::command]
pub async fn aura_kg_flows(repo_root: String) -> Result<Option<KgFlowMap>, String> {
    let Some(g) = crate::cmd_kg::load_graph_cached(&repo_root)? else {
        return Ok(None);
    };
    let root = repo_root.clone();
    let map = crate::blocking::run(move || {
        let changes = load_changes(&root);
        let goals = load_goals(&root);
        let mut src = FsSource::new(&root);
        select_flows(&g, &changes, &goals, now_secs(), &mut |f, l| src.window(f, l))
    })
    .await;
    Ok(Some(map))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::cmd_kg::{KgEdge, KgGraph, KgNode};

    fn node(id: &str, name: &str, file: &str, line: u32) -> KgNode {
        KgNode {
            id: id.into(),
            kind: "fn".into(),
            name: name.into(),
            file: file.into(),
            line,
            degree: 1,
            community_id: 0,
            god: false,
            provenance: "checkpoint".into(),
            content_hash: Some("h".into()),
        }
    }

    fn file(path: &str) -> KgNode {
        KgNode {
            id: format!("file:{path}"),
            kind: "file".into(),
            name: path.rsplit('/').next().unwrap().into(),
            file: path.into(),
            line: 0,
            degree: 0,
            community_id: 0,
            god: false,
            provenance: "outline".into(),
            content_hash: None,
        }
    }

    /// An edge the exporter resolved to a definition — the only kind a story follows.
    fn calls(a: &str, b: &str) -> KgEdge {
        KgEdge {
            from: a.into(),
            to: b.into(),
            kind: "calls".into(),
            surprise: false,
            label: Some("exact".into()),
            confidence: Some(0.95),
        }
    }

    /// The reader vouches for the file but does not check the line.
    fn ok() -> Option<SourceWindow> {
        Some(SourceWindow::default())
    }

    fn above(lines: &[&str]) -> Option<SourceWindow> {
        Some(SourceWindow { above: lines.iter().map(|s| s.to_string()).collect(), at: vec![] })
    }

    /// chat/send.rs: send_turn → write_turn → append_row; plus a fourth
    /// function nobody calls and that calls nobody (no flow).
    fn chat_graph() -> KgGraph {
        KgGraph {
            nodes: vec![
                file("chat/send.rs"),
                node("n:send", "send_turn", "chat/send.rs", 10),
                node("n:write", "write_turn", "chat/send.rs", 30),
                node("n:append", "append_row", "chat/send.rs", 50),
                node("n:lonely", "lonely", "chat/send.rs", 70),
            ],
            edges: vec![calls("n:send", "n:write"), calls("n:write", "n:append")],
            built_at: 1_700_000_000,
            ..Default::default()
        }
    }

    fn no_source() -> Box<SourceLines<'static>> {
        Box::new(|_: &str, _: u32| ok())
    }

    #[test]
    fn a_root_walks_its_calls_into_a_story() {
        let g = chat_graph();
        let m = select_flows(&g, &[], &[], 1_700_000_000, &mut *no_source());
        assert_eq!(m.flows.len(), 1, "only the root with callees starts a flow");
        let f = &m.flows[0];
        assert_eq!(f.name, "Send turn");
        let names: Vec<&str> = f.steps.iter().map(|s| s.name.as_str()).collect();
        assert_eq!(names, vec!["send_turn", "write_turn", "append_row"]);
        assert_eq!(f.verdict, "traced");
        assert_eq!(f.outcome.kind, "save");
        assert_eq!(f.trigger.kind, "code");
        assert_eq!(m.tally.traced, 1);
        assert_eq!(m.features[0].entries, 1);
    }

    #[test]
    fn an_outline_guess_anywhere_on_the_path_downgrades_to_seen() {
        let mut g = chat_graph();
        g.nodes[2].provenance = "outline".into();
        let m = select_flows(&g, &[], &[], 1_700_000_000, &mut *no_source());
        assert_eq!(m.flows[0].verdict, "seen");
        assert_eq!(m.tally.seen, 1);
    }

    #[test]
    fn tests_never_start_a_story() {
        let mut g = chat_graph();
        g.nodes.push(node("n:t", "checks_send", "chat/tests/send_test.rs", 5));
        g.edges.push(calls("n:t", "n:write"));
        let mut src = |_: &str, _: u32| above(&["#[test]"]);
        let m = select_flows(&g, &[], &[], 1_700_000_000, &mut src);
        assert!(m.flows.iter().all(|f| f.name != "Checks send"));
        // and a `#[test]` in product code is dropped by its attribute
        let mut g2 = chat_graph();
        g2.nodes.push(node("n:t2", "checks_send", "chat/send.rs", 90));
        g2.edges.push(calls("n:t2", "n:write"));
        let mut src2 = |_: &str, line: u32| if line == 90 { above(&["#[test]"]) } else { ok() };
        let m2 = select_flows(&g2, &[], &[], 1_700_000_000, &mut src2);
        assert!(m2.flows.iter().all(|f| f.name != "Checks send"));
    }

    #[test]
    fn a_tauri_command_reads_as_the_window_asking_the_engine() {
        let g = chat_graph();
        let mut src = |_: &str, line: u32| {
            if line == 10 {
                above(&["/// Hand the message to the agent's terminal. Retries once.", "#[tauri::command]"])
            } else {
                ok()
            }
        };
        let m = select_flows(&g, &[], &[], 1_700_000_000, &mut src);
        let f = &m.flows[0];
        assert_eq!(f.trigger.kind, "app");
        assert_eq!(f.trigger.text, "The app window asks the engine to send turn");
        assert_eq!(f.steps[0].doc.as_deref(), Some("Hand the message to the agent's terminal."));
    }

    #[test]
    fn doc_context_survives_attributes_directives_and_jsdoc_tags() {
        let lines: Vec<String> = [
            "/**",
            " * Copies the file exactly as it is now. Nothing is diffed.",
            " * @param path the file",
            " */",
            "@Injectable()",
        ]
        .iter()
        .map(|s| s.to_string())
        .collect();
        let c = read_context(&lines, "a/b.ts");
        assert_eq!(c.attrs, vec!["@Injectable()".to_string()]);
        assert_eq!(c.doc.as_deref(), Some("Copies the file exactly as it is now."));

        let rust: Vec<String> = [
            "// ─── Proof (goals.jsonl) ────────",
            "",
            "/// Load every goal record's NEWEST run that has a commit.",
            "/// Missing ledger → empty.",
            "#[allow(dead_code)]",
        ]
        .iter()
        .map(|s| s.to_string())
        .collect();
        let c = read_context(&rust, "a/b.rs");
        assert_eq!(c.doc.as_deref(), Some("Load every goal record's NEWEST run that has a commit."));

        let code_above: Vec<String> = ["    let x = 1;".to_string()].to_vec();
        assert_eq!(read_context(&code_above, "a.rs").doc, None);
    }

    #[test]
    fn recent_change_reasons_land_on_the_step_and_the_flow() {
        let g = chat_graph();
        let now = 1_700_000_000;
        let changes = vec![
            ChangeIn {
                when: now - 3600,
                who: "mo".into(),
                why: "retry the turn when the terminal dies".into(),
                files: vec!["/Users/x/repo/chat/send.rs".into()],
            },
            ChangeIn {
                when: now - 40 * 24 * 3600,
                who: "old".into(),
                why: "ancient history".into(),
                files: vec!["chat/send.rs".into()],
            },
        ];
        let m = select_flows(&g, &changes, &[], now, &mut *no_source());
        let f = &m.flows[0];
        assert_eq!(f.changed.as_ref().map(|c| c.who.as_str()), Some("mo"));
        assert!(f.steps.iter().all(|s| s.changed.as_ref().map(|c| c.why.as_str()) == Some("retry the turn when the terminal dies")));
        assert_eq!(m.tally.changed, 1);
    }

    #[test]
    fn goal_verdicts_join_only_by_requirement_names() {
        let g = chat_graph();
        let goals = vec![
            GoalIn {
                id: "g1".into(),
                text: "A turn is recorded".into(),
                requirements: vec!["write_turn".into()],
                run: Some(GoalRunIn { verdict: "partial".into(), ok: 1, total: 2, at: 5 }),
            },
            GoalIn {
                id: "g2".into(),
                text: "never proved".into(),
                requirements: vec!["send_turn".into()],
                run: None,
            },
            GoalIn {
                id: "g3".into(),
                text: "files only".into(),
                requirements: vec!["something_else".into()],
                run: Some(GoalRunIn { verdict: "verified".into(), ok: 2, total: 2, at: 5 }),
            },
        ];
        let m = select_flows(&g, &[], &goals, 1_700_000_000, &mut *no_source());
        let goal = m.flows[0].goal.as_ref().expect("g1 joins by name");
        assert_eq!(goal.id, "g1");
        assert_eq!(goal.verdict, "partial");
        assert_eq!(m.tally.gaps, 1);
        assert_eq!(m.tally.proved, 0);
    }

    #[test]
    fn plumbing_is_counted_but_not_followed() {
        // entry → {cn (called by 50 others), real_work}; the story follows
        // real_work and reports cn as "also calls".
        let mut nodes = vec![
            file("ui/a.ts"),
            node("n:entry", "openPanel", "ui/a.ts", 1),
            node("n:cn", "cn", "ui/a.ts", 2),
            node("n:work", "loadPanelData", "ui/a.ts", 3),
        ];
        let mut edges = vec![calls("n:entry", "n:cn"), calls("n:entry", "n:work")];
        for i in 0..UTILITY_IN_DEGREE {
            let id = format!("n:u{i}");
            nodes.push(node(&id, &format!("u{i}"), "ui/b.ts", 10 + i as u32));
            edges.push(calls(&id, "n:cn"));
        }
        let g = KgGraph { nodes, edges, ..Default::default() };
        let m = select_flows(&g, &[], &[], 1_700_000_000, &mut *no_source());
        let f = m.flows.iter().find(|f| f.steps[0].name == "openPanel").expect("entry flow");
        assert_eq!(f.steps[1].name, "loadPanelData");
        assert_eq!(f.steps[0].also_calls_total, 1);
        assert_eq!(f.steps[0].also_calls[0].name, "cn");
        assert_eq!(f.trigger.kind, "code");
    }

    #[test]
    fn per_feature_cap_prefers_nameable_entries_then_reach() {
        // Five roots in one feature: one Tauri command with tiny reach must
        // still come first; then the deepest reaches; cap at 3.
        let mut nodes = vec![file("eng/x.rs")];
        let mut edges = vec![];
        for r in 0..5 {
            let id = format!("n:root{r}");
            nodes.push(node(&id, &format!("root_{r}"), "eng/x.rs", 100 + r as u32));
            // root r reaches r+1 callees in a chain
            let mut prev = id.clone();
            for k in 0..=r {
                let cid = format!("n:c{r}_{k}");
                nodes.push(node(&cid, &format!("c{r}_{k}"), "eng/x.rs", 200 + (r * 10 + k) as u32));
                edges.push(calls(&prev, &cid));
                prev = cid;
            }
        }
        let g = KgGraph { nodes, edges, ..Default::default() };
        let mut src = |_: &str, line: u32| if line == 100 { above(&["#[tauri::command]"]) } else { ok() };
        let m = select_flows(&g, &[], &[], 1_700_000_000, &mut src);
        assert_eq!(m.flows.len(), FLOWS_PER_FEATURE);
        assert_eq!(m.flows[0].steps[0].name, "root_0", "the command leads");
        assert_eq!(m.flows[1].steps[0].name, "root_4", "then the furthest reach");
        assert_eq!(m.flows[2].steps[0].name, "root_3");
        assert_eq!(m.features[0].entries, 5);
        assert_eq!(m.features[0].shown, 3);
    }

    #[test]
    fn words_read_like_a_person_wrote_them() {
        assert_eq!(sentence("send_turn"), "Send turn");
        assert_eq!(sentence("aura_kg_flows"), "Kg flows");
        assert_eq!(sentence("HandleGoogleCallback"), "Handle google callback");
        assert_eq!(sentence("parseHTTPHeader"), "Parse HTTP header");
        assert_eq!(where_of("aura-shell/src-tauri/src/cmd_kg.rs"), "engine");
        assert_eq!(where_of("aura-shell/src/components/Pane.tsx"), "app");
        assert_eq!(where_of("aura-cloud/src/api/sessions.rs"), "server");
        assert_eq!(where_of("aura-cli/src/main.rs"), "cli");
        assert_eq!(where_of("lib/util.go"), "other");
        assert!(is_test_path("aura-shell/tests/branchState.test.ts"));
        assert!(!is_test_path("aura-shell/src/lib/api.ts"));
    }

    #[test]
    fn a_step_that_crosses_features_says_so() {
        let g = KgGraph {
            nodes: vec![
                file("chat/a.rs"),
                file("storage/b.rs"),
                node("n:a1", "send_turn", "chat/a.rs", 1),
                node("n:a2", "prepare", "chat/a.rs", 2),
                node("n:a3", "finish", "chat/a.rs", 3),
                node("n:b1", "persist_turn", "storage/b.rs", 1),
                node("n:b2", "open_db", "storage/b.rs", 2),
                node("n:b3", "close_db", "storage/b.rs", 3),
            ],
            edges: vec![calls("n:a1", "n:a2"), calls("n:a2", "n:b1"), calls("n:b1", "n:b2")],
            ..Default::default()
        };
        let m = select_flows(&g, &[], &[], 1_700_000_000, &mut *no_source());
        let f = m.flows.iter().find(|f| f.steps[0].name == "send_turn").unwrap();
        assert_eq!(f.feature, "chat/chat");
        assert_eq!(f.steps[2].feature.as_deref(), Some("storage/storage"));
    }

    #[test]
    fn a_name_only_match_is_never_a_step() {
        let mut g = chat_graph();
        // send → write stays resolved; write → append becomes a bare name match
        g.edges[1].label = Some("name-only".into());
        g.edges[1].confidence = Some(0.5);
        let m = select_flows(&g, &[], &[], 1_700_000_000, &mut *no_source());
        let names: Vec<&str> = m.flows[0].steps.iter().map(|s| s.name.as_str()).collect();
        assert_eq!(names, vec!["send_turn", "write_turn"]);
        assert_eq!(m.flows[0].steps[1].also_calls_total, 0, "a guess is not even counted");
        // an unlabeled edge from an old cache is a guess too
        g.edges[0].label = None;
        g.edges[0].confidence = None;
        let m = select_flows(&g, &[], &[], 1_700_000_000, &mut *no_source());
        assert!(m.flows.is_empty());
    }

    #[test]
    fn a_symbol_the_tree_no_longer_has_is_never_shown() {
        let g = chat_graph();
        // the file is shorter than the checkpoint remembers: write_turn's line is gone
        let mut src = |_: &str, line: u32| if line == 30 { None } else { ok() };
        let m = select_flows(&g, &[], &[], 1_700_000_000, &mut src);
        assert!(m.flows.is_empty(), "the story would have been one lonely step");
        // a line that now holds a different function is a ghost too
        let mut src2 = |_: &str, line: u32| {
            let at = if line == 50 { vec!["fn something_else() {".to_string()] } else { vec![] };
            Some(SourceWindow { above: vec![], at })
        };
        let m2 = select_flows(&g, &[], &[], 1_700_000_000, &mut src2);
        let names: Vec<&str> = m2.flows[0].steps.iter().map(|s| s.name.as_str()).collect();
        assert_eq!(names, vec!["send_turn", "write_turn"]);
        assert_eq!(m2.features[0].shown, 1);
    }

    /// Real-repo smoke: `AURA_KG_SMOKE_ROOT=/path cargo test -p aura-shell
    /// smoke_real_repo -- --ignored --nocapture`. Builds the graph (needs the
    /// `aura` CLI for the canonical export) and prints the first flows.
    #[test]
    #[ignore]
    fn smoke_real_repo() {
        let Ok(root) = std::env::var("AURA_KG_SMOKE_ROOT") else { return };
        let rt = tokio::runtime::Runtime::new().unwrap();
        let g = rt.block_on(crate::cmd_kg::aura_kg_build(root.clone(), true)).expect("graph builds");
        let t0 = std::time::Instant::now();
        let changes = load_changes(&root);
        let goals = load_goals(&root);
        let mut src = FsSource::new(&root);
        let m = select_flows(&g, &changes, &goals, now_secs(), &mut |f, l| src.window(f, l));
        eprintln!(
            "flows {} features {} tally {:?} in {:?} (nodes {} edges {} canonical {})",
            m.flows.len(),
            m.features.len(),
            m.tally,
            t0.elapsed(),
            g.nodes.len(),
            g.edges.len(),
            g.stats.canonical
        );
        for f in m.flows.iter().take(40) {
            eprintln!("\n[{}] {} — {} ({}) reach {}", f.feature, f.name, f.trigger.text, f.trigger.kind, f.reach);
            for s in &f.steps {
                eprintln!(
                    "   → {:<32} {:<8} {}:{}  {}{}",
                    s.text,
                    s.where_,
                    s.file,
                    s.line,
                    s.doc.as_deref().unwrap_or("—"),
                    s.changed.as_ref().map(|c| format!("  [changed by {}]", c.who)).unwrap_or_default()
                );
            }
        }
        let json = serde_json::to_vec(&m).unwrap();
        eprintln!("payload {} KB", json.len() / 1024);
    }
}
