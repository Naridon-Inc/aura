//! Reasoned conflict detection over the awareness plane.
//!
//! The radar *feed* ([`super::render::print_feed`]) is ambient — you pull it
//! when you want it, and it shows everyone. This module is the *other* half: the
//! reasoned layer that answers the only question worth interrupting someone over
//! — "is anyone working where **I** am, right now, in a way that will collide?"
//!
//! It is built to stay quiet. A teammate editing some random file you never
//! touch produces NOTHING here. A collision only surfaces when another actor's
//! in-flight work intersects *your own current focus* (the files you have dirty
//! plus the symbols you've announced). Every result is the kind of thing a human
//! teammate would actually lean over and tell you — not a per-keystroke firehose.
//!
//! Noise dampers, all applied here so callers (CLI feed banner, pre-commit hook,
//! desktop card) inherit them for free:
//!   1. Computed only against *your* focus — unrelated files can't surface.
//!   2. Your own events never collide with you (`as_actor`/git user is skipped).
//!   3. Recency window — stale signal (default 45 min) is dropped.
//!   4. Supersession — only the *latest* event per (peer, target) counts, so a
//!      later `committed`/`paused`/`abandoned` resolves the in-flight collision.
//!   5. Dedup — one row per (peer, target); 50 "editing" pings collapse to one.
//!   6. Only same-symbol / same-file / zone-glob overlaps qualify. "Same folder"
//!      is deliberately NOT a collision — that's the noise we refuse to emit.

use git2::{Repository, StatusOptions};

use super::model::{AwarenessEvent, AwarenessKind};
use crate::live_events;

/// How recent another actor's event must be to count as live, in-flight work.
const DEFAULT_WINDOW_MS: u64 = 45 * 60 * 1000;

/// How loudly a collision should be surfaced. Only [`Severity::Direct`] and
/// [`Severity::Likely`] are shown by default; [`Severity::Possible`] is reserved
/// for the callgraph-dependency deepening (AURA-14) and shown behind `--all`.
#[derive(Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord)]
pub enum Severity {
    /// A weaker, indirect overlap (e.g. transitive dependency). Off by default.
    Possible,
    /// Real overlap risk — same file, a landed change under you, a zone claim.
    Likely,
    /// A head-on collision — same symbol, both in flight.
    Direct,
}

impl Severity {
    pub fn label(&self) -> &'static str {
        match self {
            Self::Direct => "direct",
            Self::Likely => "likely",
            Self::Possible => "possible",
        }
    }
}

/// One reasoned collision between *your* focus and another actor's work.
#[derive(Clone, Debug)]
pub struct Collision {
    pub severity: Severity,
    pub peer: String,
    pub peer_is_agent: bool,
    /// Plain-language explanation, phrased the way a teammate would say it.
    pub reason: String,
    /// What of *yours* it touches (a symbol name or a file path).
    pub mine: String,
    pub their_file: Option<String>,
    pub their_symbol: Option<String>,
    pub their_intent: Option<String>,
    pub their_branch: String,
    pub same_branch: bool,
    pub age_ms: u64,
    /// The source event's id — lets a push surface ack a collision once instead
    /// of re-alerting on it.
    pub event_id: String,
}

/// One forward call edge out of my focus: my symbol `mine` calls `callee`. When
/// a peer edits `callee`, their change can ripple into `mine` even though we're
/// not on the same symbol or file — the basis for the [`Severity::Possible`]
/// tier (M3b callgraph deepening).
#[derive(Clone, Debug)]
pub struct DepEdge {
    /// The symbol my code calls (bare name).
    pub callee: String,
    /// The focus symbol of mine that calls it.
    pub mine: String,
}

/// What you are currently working on. Conflicts are always relative to this.
#[derive(Clone, Debug, Default)]
pub struct Focus {
    pub files: Vec<String>,
    pub symbols: Vec<String>,
    /// Lowercased actor identities that are "me" and must never self-collide.
    pub me: Vec<String>,
    /// Forward call edges out of my focus symbols (callee → my symbol). Empty by
    /// default, so the Possible tier is purely additive and silent until the
    /// callgraph is available.
    pub dep_edges: Vec<DepEdge>,
}

impl Focus {
    fn is_empty(&self) -> bool {
        self.files.is_empty() && self.symbols.is_empty()
    }
}

/// Normalize a path for forgiving comparison: lowercase, forward slashes, no
/// leading `./`.
fn norm(p: &str) -> String {
    p.trim()
        .trim_start_matches("./")
        .replace('\\', "/")
        .to_ascii_lowercase()
}

/// Do two paths refer to the same file? Equal, or one is a path-suffix of the
/// other (e.g. `payments.rs` vs `src/payments.rs`). A bare basename match is
/// allowed only when it is a full trailing path segment, so `auth.rs` does not
/// spuriously match `oauth.rs`.
fn path_overlap(a: &str, b: &str) -> bool {
    let (a, b) = (norm(a), norm(b));
    if a.is_empty() || b.is_empty() {
        return false;
    }
    a == b || a.ends_with(&format!("/{b}")) || b.ends_with(&format!("/{a}"))
}

/// Match a file against a simple glob (`*` within a segment, e.g.
/// `src/auth/*.rs`). Translated to: starts-with the pre-`*` prefix, ends-with
/// the post-`*` suffix, with any middle literals appearing in order.
fn glob_matches(glob: &str, file: &str) -> bool {
    let (glob, file) = (norm(glob), norm(file));
    if !glob.contains('*') {
        return path_overlap(&glob, &file);
    }
    let parts: Vec<&str> = glob.split('*').collect();
    let mut cursor = 0usize;
    for (i, part) in parts.iter().enumerate() {
        if part.is_empty() {
            continue;
        }
        if i == 0 {
            if !file.starts_with(part) {
                return false;
            }
            cursor = part.len();
        } else if i == parts.len() - 1 {
            if !file[cursor..].ends_with(part) {
                return false;
            }
        } else if let Some(idx) = file[cursor..].find(part) {
            cursor += idx + part.len();
        } else {
            return false;
        }
    }
    true
}

/// Build the default focus: the files you have dirty in git (staged or not) plus
/// any symbols/files you've recently announced yourself. This is the
/// "humanly realistic" part — collisions are judged against what you are
/// *actually* touching, not against the whole repo.
///
/// This is the hot path — every `aura radar` run, every desktop poll, every
/// `aura_team_radar` MCP call — so it deliberately does NOT build the callgraph
/// ripple edges. Use [`focus_from_repo_opts`] when you actually want the weak
/// [`Severity::Possible`] tier.
pub fn focus_from_repo(as_actor: Option<&str>) -> Focus {
    focus_from_repo_opts(as_actor, false)
}

/// As [`focus_from_repo`], but `with_dep_edges` also builds the forward call
/// edges that power the [`Severity::Possible`] ripple tier.
///
/// Building those edges is **expensive**: [`dep_edges_for_focus`] deserializes
/// every checkpoint note in the repository just to reach the newest one. On a
/// long-lived repo that is gigabytes of JSON per call. It used to run
/// unconditionally, including on the default paths that then *discard* every
/// Possible collision — so the ambient feed paid multi-GB, multi-minute cost for
/// a tier it never showed. Behind the desktop's 6-second radar poll that meant
/// `aura radar show --json` processes piling up, none ever returning, and a feed
/// frozen on whatever it last managed to read. The ripple tier is now opt-in,
/// taken only by `radar conflicts --all` / `include_possible`.
pub fn focus_from_repo_opts(as_actor: Option<&str>, with_dep_edges: bool) -> Focus {
    let mut me: Vec<String> = vec![live_events::git_user().to_ascii_lowercase()];
    if let Some(a) = as_actor {
        me.push(a.to_ascii_lowercase());
    }

    let mut files: Vec<String> = git_dirty_files();

    // Fold in what *I* have announced — an agent may be mid-edit before the file
    // is dirty on disk, and should still see who else is on that symbol.
    let mut symbols: Vec<String> = Vec::new();
    for ev in super::store::read_all() {
        if !me.contains(&ev.actor.to_ascii_lowercase()) {
            continue;
        }
        if matches!(
            ev.kind,
            AwarenessKind::Abandoned | AwarenessKind::Paused | AwarenessKind::Committed
        ) {
            continue;
        }
        if let Some(s) = &ev.symbol {
            push_unique(&mut symbols, s.clone());
        }
        if let Some(f) = &ev.file {
            push_unique(&mut files, f.clone());
        }
    }

    let dep_edges = if with_dep_edges {
        dep_edges_for_focus(&files, &symbols)
    } else {
        Vec::new()
    };
    Focus { files, symbols, me, dep_edges }
}

/// Bare callee name from a dependency string: drop any module path
/// (`crate::auth::verify` / `obj.verify`) and call parens (`verify(x)`), keep the
/// final identifier. Lowercased comparison happens at match time.
fn bare(name: &str) -> String {
    let n = name.trim();
    let n = n.split('(').next().unwrap_or(n);
    let n = n.rsplit("::").next().unwrap_or(n);
    let n = n.rsplit('.').next().unwrap_or(n);
    n.trim().to_string()
}

/// Build forward call edges out of my focus by reading the latest checkpoint's
/// AST nodes. For every node that is *part of my focus* (its identifier is one of
/// my focus symbols, or it lives in one of my dirty files), record an edge from
/// each symbol it calls back to that focus symbol. Best-effort: if there is no
/// checkpoint yet, the callgraph deepening is simply silent.
fn dep_edges_for_focus(files: &[String], symbols: &[String]) -> Vec<DepEdge> {
    let Ok(repo) = Repository::discover(".") else {
        return Vec::new();
    };
    let checkpoint = crate::checkpoint::CheckpointStore::latest_checkpoint(&repo).unwrap_or_default();
    let Some(latest) = checkpoint.as_ref() else {
        return Vec::new();
    };

    let mut edges: Vec<DepEdge> = Vec::new();
    for node in &latest.ast_nodes {
        let Some(ident) = node.identifier.as_deref() else { continue };
        if ident.is_empty() {
            continue;
        }
        // Is this node mine? Either I named the symbol, or it's in a file I'm in.
        let mine_by_symbol = symbols.iter().any(|s| s.eq_ignore_ascii_case(ident));
        let mine_by_file = node
            .file_path
            .as_deref()
            .map(|f| files.iter().any(|mine| path_overlap(mine, f)))
            .unwrap_or(false);
        if !mine_by_symbol && !mine_by_file {
            continue;
        }
        for dep in &node.dependencies {
            let callee = bare(&dep.name);
            // A symbol calling itself, or an empty/own-name edge, isn't a useful
            // ripple signal.
            if callee.is_empty() || callee.eq_ignore_ascii_case(ident) {
                continue;
            }
            if !edges
                .iter()
                .any(|e| e.callee.eq_ignore_ascii_case(&callee) && e.mine.eq_ignore_ascii_case(ident))
            {
                edges.push(DepEdge { callee, mine: ident.to_string() });
            }
        }
    }
    edges
}

fn push_unique(v: &mut Vec<String>, s: String) {
    if !v.iter().any(|x| x.eq_ignore_ascii_case(&s)) {
        v.push(s);
    }
}

/// Files with working-tree or index changes — what you're touching right now.
fn git_dirty_files() -> Vec<String> {
    let Ok(repo) = Repository::discover(".") else {
        return Vec::new();
    };
    let mut opts = StatusOptions::new();
    opts.include_untracked(true).include_ignored(false);
    let Ok(statuses) = repo.statuses(Some(&mut opts)) else {
        return Vec::new();
    };
    let mut out = Vec::new();
    for entry in statuses.iter() {
        if let Some(p) = entry.path() {
            push_unique(&mut out, p.to_string());
        }
    }
    out
}

/// Collapse to the single latest event per (actor, target) so supersession and
/// dedup happen together: a later `paused`/`committed` on the same target is the
/// one that counts, and N rapid `editing` pings become one row.
fn latest_per_target(events: &[AwarenessEvent]) -> Vec<&AwarenessEvent> {
    // (actor_lower, target_key) -> index of newest event seen.
    let mut best: std::collections::HashMap<(String, String), usize> =
        std::collections::HashMap::new();
    for (i, ev) in events.iter().enumerate() {
        let target = ev
            .symbol
            .as_deref()
            .map(norm)
            .or_else(|| ev.file.as_deref().map(norm))
            .unwrap_or_default();
        if target.is_empty() {
            continue;
        }
        let key = (ev.actor.to_ascii_lowercase(), target);
        match best.get(&key) {
            Some(&j) if events[j].ts >= ev.ts => {}
            _ => {
                best.insert(key, i);
            }
        }
    }
    best.into_values().map(|i| &events[i]).collect()
}

/// Detect collisions between `focus` and the awareness `events`, newest-first,
/// using `now_ms` as the clock and `window_ms` as the recency cutoff.
pub fn detect(
    focus: &Focus,
    events: &[AwarenessEvent],
    now_ms: u64,
    window_ms: u64,
) -> Vec<Collision> {
    if focus.is_empty() {
        return Vec::new();
    }
    let my_branch = live_events::current_branch();
    let mut out: Vec<Collision> = Vec::new();

    for ev in latest_per_target(events) {
        // (2) never collide with myself.
        if focus.me.iter().any(|m| m.eq_ignore_ascii_case(&ev.actor)) {
            continue;
        }
        // (4) supersession: a paused/abandoned latest event means they stopped.
        if matches!(ev.kind, AwarenessKind::Paused | AwarenessKind::Abandoned) {
            continue;
        }
        // (3) recency window.
        let age = now_ms.saturating_sub(ev.ts);
        if age > window_ms {
            continue;
        }

        if let Some(c) = classify(focus, ev, &my_branch, age) {
            out.push(c);
        }
    }

    // Rank: Direct first, then newest.
    out.sort_by(|a, b| b.severity.cmp(&a.severity).then(a.age_ms.cmp(&b.age_ms)));
    out
}

/// Decide whether (and how loudly) a single event collides with the focus.
fn classify(focus: &Focus, ev: &AwarenessEvent, my_branch: &str, age: u64) -> Option<Collision> {
    let same_branch = ev.branch.eq_ignore_ascii_case(my_branch);
    let mk = |severity: Severity, reason: String, mine: String| Collision {
        severity,
        peer: ev.actor.clone(),
        peer_is_agent: ev.is_agent,
        reason,
        mine,
        their_file: ev.file.clone(),
        their_symbol: ev.symbol.clone(),
        their_intent: ev.intent.clone(),
        their_branch: ev.branch.clone(),
        same_branch,
        age_ms: age,
        event_id: ev.id.clone(),
    };

    // Highest signal: same symbol as something I'm touching.
    if let Some(sym) = &ev.symbol {
        if let Some(mine) = focus
            .symbols
            .iter()
            .find(|s| s.eq_ignore_ascii_case(sym))
            .cloned()
        {
            // A landed change is a "rebase before you push", not a live race.
            if ev.kind == AwarenessKind::Committed {
                return Some(mk(
                    Severity::Likely,
                    format!("just committed `{sym}` — pull before you push"),
                    mine,
                ));
            }
            return Some(mk(
                Severity::Direct,
                format!("also working on `{sym}` right now"),
                mine,
            ));
        }
    }

    // Zone claim covering one of my files.
    if ev.kind == AwarenessKind::Zone {
        if let Some(glob) = &ev.file {
            if let Some(mine) = focus.files.iter().find(|f| glob_matches(glob, f)).cloned() {
                return Some(mk(
                    Severity::Likely,
                    format!("claimed zone `{glob}` covering your `{mine}`"),
                    mine,
                ));
            }
        }
    }

    // Same file, different (or unknown) symbol — you'll meet in the same file.
    if let Some(their_file) = &ev.file {
        if let Some(mine) = focus
            .files
            .iter()
            .find(|f| path_overlap(f, their_file))
            .cloned()
        {
            let what = ev
                .symbol
                .as_deref()
                .map(|s| format!(" (`{s}`)"))
                .unwrap_or_default();
            let verb = if ev.kind == AwarenessKind::Committed {
                "just committed in"
            } else {
                "also editing"
            };
            return Some(mk(
                Severity::Likely,
                format!("{verb} `{mine}`{what}"),
                mine,
            ));
        }
    }

    // Callgraph deepening (M3b): the peer edited a symbol that one of my focus
    // symbols *calls*. Not the same symbol, not the same file — but a change to a
    // callee can ripple into my caller, so it's worth a quiet heads-up. This is
    // the weakest tier and is filtered out of the ambient feed by default; it
    // surfaces only via `aura radar conflicts --all` / `include_possible`.
    if let Some(sym) = &ev.symbol {
        if let Some(edge) = focus
            .dep_edges
            .iter()
            .find(|e| e.callee.eq_ignore_ascii_case(sym))
        {
            let verb = if ev.kind == AwarenessKind::Committed {
                "committed"
            } else {
                "editing"
            };
            return Some(mk(
                Severity::Possible,
                format!("{verb} `{sym}`, which your `{}` calls — may ripple into you", edge.mine),
                edge.mine.clone(),
            ));
        }
    }

    None
}

#[cfg(test)]
mod tests {
    use super::*;

    fn ev(actor: &str, kind: AwarenessKind, file: Option<&str>, symbol: Option<&str>, ts: u64) -> AwarenessEvent {
        AwarenessEvent {
            id: format!("{actor}-{ts}"),
            actor: actor.into(),
            is_agent: actor.contains('@'),
            kind,
            repo: "demo/repo".into(),
            branch: "main".into(),
            file: file.map(String::from),
            symbol: symbol.map(String::from),
            intent: None,
            impact: None,
            ts,
            key_id: None,
            sig: None,
            pubkey: None,
            worktree: None,
        }
    }

    fn focus(files: &[&str], symbols: &[&str]) -> Focus {
        Focus {
            files: files.iter().map(|s| s.to_string()).collect(),
            symbols: symbols.iter().map(|s| s.to_string()).collect(),
            me: vec!["ashiq".into()],
            dep_edges: Vec::new(),
        }
    }

    #[test]
    fn same_symbol_is_direct() {
        let f = focus(&["src/payments.rs"], &["charge_card"]);
        let evs = vec![ev("claude@cursor", AwarenessKind::Editing, Some("src/payments.rs"), Some("charge_card"), 100)];
        let c = detect(&f, &evs, 200, DEFAULT_WINDOW_MS);
        assert_eq!(c.len(), 1);
        assert_eq!(c[0].severity, Severity::Direct);
    }

    #[test]
    fn unrelated_file_is_silent() {
        // The exact noise we refuse to emit: someone edits a random file.
        let f = focus(&["src/payments.rs"], &["charge_card"]);
        let evs = vec![ev("bob", AwarenessKind::Editing, Some("docs/readme.md"), Some("intro"), 100)];
        assert!(detect(&f, &evs, 200, DEFAULT_WINDOW_MS).is_empty());
    }

    #[test]
    fn same_file_other_symbol_is_likely() {
        let f = focus(&["src/payments.rs"], &["charge_card"]);
        let evs = vec![ev("gemini@cli", AwarenessKind::Editing, Some("src/payments.rs"), Some("refund"), 100)];
        let c = detect(&f, &evs, 200, DEFAULT_WINDOW_MS);
        assert_eq!(c.len(), 1);
        assert_eq!(c[0].severity, Severity::Likely);
    }

    #[test]
    fn own_events_never_collide() {
        let f = focus(&["src/payments.rs"], &["charge_card"]);
        let evs = vec![ev("Ashiq", AwarenessKind::Editing, Some("src/payments.rs"), Some("charge_card"), 100)];
        assert!(detect(&f, &evs, 200, DEFAULT_WINDOW_MS).is_empty());
    }

    #[test]
    fn paused_supersedes_editing() {
        let f = focus(&["src/payments.rs"], &["charge_card"]);
        let evs = vec![
            ev("claude@cursor", AwarenessKind::Editing, Some("src/payments.rs"), Some("charge_card"), 100),
            ev("claude@cursor", AwarenessKind::Paused, Some("src/payments.rs"), Some("charge_card"), 150),
        ];
        assert!(detect(&f, &evs, 200, DEFAULT_WINDOW_MS).is_empty());
    }

    #[test]
    fn stale_event_drops_out() {
        let f = focus(&["src/payments.rs"], &["charge_card"]);
        let evs = vec![ev("claude@cursor", AwarenessKind::Editing, Some("src/payments.rs"), Some("charge_card"), 0)];
        // now is well past the window.
        assert!(detect(&f, &evs, DEFAULT_WINDOW_MS + 10_000, DEFAULT_WINDOW_MS).is_empty());
    }

    #[test]
    fn dedup_collapses_repeated_editing() {
        let f = focus(&[], &["charge_card"]);
        let evs = vec![
            ev("claude@cursor", AwarenessKind::Editing, Some("src/payments.rs"), Some("charge_card"), 100),
            ev("claude@cursor", AwarenessKind::Editing, Some("src/payments.rs"), Some("charge_card"), 110),
            ev("claude@cursor", AwarenessKind::Editing, Some("src/payments.rs"), Some("charge_card"), 120),
        ];
        assert_eq!(detect(&f, &evs, 200, DEFAULT_WINDOW_MS).len(), 1);
    }

    #[test]
    fn committed_same_symbol_is_likely_rebase() {
        let f = focus(&[], &["charge_card"]);
        let evs = vec![ev("gemini@cli", AwarenessKind::Committed, Some("src/payments.rs"), Some("charge_card"), 100)];
        let c = detect(&f, &evs, 200, DEFAULT_WINDOW_MS);
        assert_eq!(c.len(), 1);
        assert_eq!(c[0].severity, Severity::Likely);
        assert!(c[0].reason.contains("pull before you push"));
    }

    #[test]
    fn zone_glob_covers_my_file() {
        let f = focus(&["src/auth/login.rs"], &[]);
        let evs = vec![ev("codex@vscode", AwarenessKind::Zone, Some("src/auth/*.rs"), None, 100)];
        let c = detect(&f, &evs, 200, DEFAULT_WINDOW_MS);
        assert_eq!(c.len(), 1);
        assert_eq!(c[0].severity, Severity::Likely);
    }

    #[test]
    fn empty_focus_yields_nothing() {
        let evs = vec![ev("claude@cursor", AwarenessKind::Editing, Some("src/payments.rs"), Some("charge_card"), 100)];
        assert!(detect(&Focus::default(), &evs, 200, DEFAULT_WINDOW_MS).is_empty());
    }

    #[test]
    fn glob_does_not_overmatch() {
        assert!(glob_matches("src/auth/*.rs", "src/auth/login.rs"));
        assert!(!glob_matches("src/auth/*.rs", "src/payments.rs"));
        assert!(!path_overlap("auth.rs", "oauth.rs"));
        assert!(path_overlap("payments.rs", "src/payments.rs"));
    }

    #[test]
    fn dependency_ripple_is_possible() {
        // My `charge_card` calls `verify_token`. A peer edits `verify_token`
        // (different symbol, different file) → a quiet Possible ripple, not silence.
        let mut f = focus(&["src/payments.rs"], &["charge_card"]);
        f.dep_edges = vec![DepEdge { callee: "verify_token".into(), mine: "charge_card".into() }];
        let evs = vec![ev("claude@cursor", AwarenessKind::Editing, Some("src/auth.rs"), Some("verify_token"), 100)];
        let c = detect(&f, &evs, 200, DEFAULT_WINDOW_MS);
        assert_eq!(c.len(), 1);
        assert_eq!(c[0].severity, Severity::Possible);
        assert_eq!(c[0].mine, "charge_card");
        assert!(c[0].reason.contains("ripple"));
    }

    #[test]
    fn dependency_ripple_yields_to_direct() {
        // If the peer's symbol is BOTH something I call AND something I'm on,
        // the head-on (Direct) reading wins — the ripple never downgrades it.
        let mut f = focus(&[], &["verify_token"]);
        f.dep_edges = vec![DepEdge { callee: "verify_token".into(), mine: "charge_card".into() }];
        let evs = vec![ev("claude@cursor", AwarenessKind::Editing, Some("src/auth.rs"), Some("verify_token"), 100)];
        let c = detect(&f, &evs, 200, DEFAULT_WINDOW_MS);
        assert_eq!(c.len(), 1);
        assert_eq!(c[0].severity, Severity::Direct);
    }

    #[test]
    fn bare_strips_paths_and_parens() {
        assert_eq!(bare("crate::auth::verify_token"), "verify_token");
        assert_eq!(bare("self.verify_token(tok)"), "verify_token");
        assert_eq!(bare("verify_token"), "verify_token");
    }
}
