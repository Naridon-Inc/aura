//! Answering "why is this the way it is" from what this repository recorded.
//!
//! `aura ask` used to search one store — the checkpoint notes — and rank the
//! results by embedding distance alone. That has two failure modes a person
//! hits immediately. Asked *why did `build_verify.rs` change*, it returned the
//! newest goal-proof checkpoint, because nothing in the ranking knew that a
//! record naming that exact file is a better answer than a record whose prose
//! merely drifts near the question. And when it matched nothing it said the
//! repository had just been initialised, which in a repo with four hundred
//! logged intents is not a hedge, it is a false statement about the user's own
//! history.
//!
//! So the ranking here is tiered rather than scalar, and the tier is reported
//! rather than hidden. A record that names the file being asked about is
//! evidence. A record that names a symbol from the question is evidence. Word
//! overlap is a lead. Embedding proximity is a guess, and a guess can never
//! outrank evidence however new it is — recency only breaks ties inside a
//! tier. That single rule is what stops an unrelated newest checkpoint from
//! being served as the answer.
//!
//! Both stores are searched, because they record different things: the intent
//! log is what an agent said it was doing, and the checkpoints are the AST it
//! actually touched. A question about a file usually has an answer in one and
//! corroboration in the other.

use serde_json::{json, Value};

use crate::checkpoint::CheckpointData;
use crate::intent_query::IntentRow;

/// How strong a match is. Ordered, and the order is the whole point: nothing
/// in a weaker tier can be ranked above something in a stronger one.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord)]
pub enum Tier {
    /// Word overlap between the question and the record's prose. A lead.
    Words = 1,
    /// The record names a symbol the question named. Evidence.
    Symbol = 2,
    /// The record is about the file the question named. Evidence.
    Path = 3,
}

impl Tier {
    pub fn label(self) -> &'static str {
        match self {
            Tier::Path => "names the file",
            Tier::Symbol => "names the symbol",
            Tier::Words => "mentions the words",
        }
    }
}

/// Which store a hit came from.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Store {
    /// `.aura/intent_log.jsonl` — what somebody said they were doing.
    Intent,
    /// The checkpoint notes — the AST that actually changed.
    Checkpoint,
}

impl Store {
    pub fn label(self) -> &'static str {
        match self {
            Store::Intent => "intent",
            Store::Checkpoint => "checkpoint",
        }
    }
}

/// One record that answers, or partly answers, the question.
#[derive(Debug, Clone)]
pub struct Hit {
    pub tier: Tier,
    /// How well it matched inside its tier. Never compared across tiers.
    pub score: f32,
    /// Seconds since the epoch. Both stores are normalised to seconds here;
    /// checkpoints are written in milliseconds.
    pub when: u64,
    pub who: String,
    pub what: String,
    /// The file this record is about, when it names one.
    pub file: Option<String>,
    pub store: Store,
}

impl Hit {
    pub fn to_json(&self) -> Value {
        let mut v = json!({
            "tier": self.tier.label(),
            "score": self.score,
            "when": self.when,
            "who": self.who,
            "what": self.what,
            "store": self.store.label(),
        });
        if let Some(f) = &self.file {
            v["file"] = json!(f);
        }
        v
    }
}

/// What was actually searched. Carried on every answer so the empty case can
/// say something true instead of guessing why it is empty.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub struct Corpus {
    pub intents: usize,
    pub checkpoints: usize,
}

impl Corpus {
    pub fn is_empty(self) -> bool {
        self.intents == 0 && self.checkpoints == 0
    }
}

/// Why an answer has no hits — the distinction the old code collapsed.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Verdict {
    /// Records were found and ranked.
    Found,
    /// There is history, and none of it is about this question.
    NoMatch,
    /// There is no history at all yet. Only now is the onboarding text true.
    NothingRecorded,
}

#[derive(Debug, Clone)]
pub struct Answer {
    pub question: String,
    pub hits: Vec<Hit>,
    pub corpus: Corpus,
}

impl Answer {
    pub fn verdict(&self) -> Verdict {
        if !self.hits.is_empty() {
            Verdict::Found
        } else if self.corpus.is_empty() {
            Verdict::NothingRecorded
        } else {
            Verdict::NoMatch
        }
    }

    /// The one line to print when nothing matched. Never claims the repository
    /// is new unless it genuinely has no record of anything.
    pub fn empty_line(&self) -> String {
        match self.verdict() {
            Verdict::Found => String::new(),
            Verdict::NothingRecorded => {
                "Nothing has been recorded in this repository yet — no intents, no checkpoints."
                    .to_string()
            }
            Verdict::NoMatch => format!(
                "Searched {} intent{} and {} checkpoint{}. None of them is about that.",
                self.corpus.intents,
                if self.corpus.intents == 1 { "" } else { "s" },
                self.corpus.checkpoints,
                if self.corpus.checkpoints == 1 { "" } else { "s" },
            ),
        }
    }

    pub fn to_json(&self) -> Value {
        json!({
            "question": self.question,
            "verdict": match self.verdict() {
                Verdict::Found => "found",
                Verdict::NoMatch => "no_match",
                Verdict::NothingRecorded => "nothing_recorded",
            },
            "searched": {
                "intents": self.corpus.intents,
                "checkpoints": self.corpus.checkpoints,
            },
            "hits": self.hits.iter().map(Hit::to_json).collect::<Vec<_>>(),
        })
    }
}

/// A question broken into the three kinds of thing it can name.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct Query {
    /// Tokens that look like a file: they carry a separator or a source
    /// extension. `build_verify.rs`, `aura-cli/src/why.rs`.
    pub paths: Vec<String>,
    /// Tokens that look like code: snake_case, CamelCase, `a::b`, `f()`.
    pub symbols: Vec<String>,
    /// Everything else worth matching on, lowercased.
    pub words: Vec<String>,
}

impl Query {
    pub fn is_empty(&self) -> bool {
        self.paths.is_empty() && self.symbols.is_empty() && self.words.is_empty()
    }
}

/// Words that appear in almost every question and so distinguish nothing.
/// Deliberately short: over-pruning turns a real question into an empty one.
const STOPWORDS: &[&str] = &[
    "a", "about", "an", "and", "any", "are", "aura", "be", "but", "by", "can",
    "change", "changed", "changes", "code", "did", "do", "does", "file", "for", "from", "get",
    "had", "has", "have", "here", "how", "i", "in", "is", "it", "its", "me", "not", "of", "on",
    "or", "show", "so", "that", "the", "their", "then", "there", "these", "they", "this", "to",
    "was", "we", "were", "what", "when", "where", "which", "who", "why", "with", "you", "your",
];

/// Extensions that make a bare token a filename rather than a word.
const SOURCE_EXTENSIONS: &[&str] = &[
    "rs", "ts", "tsx", "js", "jsx", "py", "go", "java", "kt", "swift", "rb", "c", "h", "cc",
    "cpp", "hpp", "cs", "php", "sh", "sql", "toml", "yaml", "yml", "json", "md", "css", "html",
];

fn strip_punctuation(raw: &str) -> &str {
    raw.trim_matches(|c: char| {
        matches!(c, '"' | '\'' | '`' | ',' | ';' | ':' | '?' | '!' | '(' | ')' | '[' | ']' | '<' | '>')
    })
    .trim_end_matches('.')
    .trim_start_matches('.')
}

fn looks_like_path(tok: &str) -> bool {
    if tok.contains('/') || tok.contains('\\') {
        return true;
    }
    match tok.rsplit_once('.') {
        Some((stem, ext)) if !stem.is_empty() => {
            SOURCE_EXTENSIONS.iter().any(|e| e.eq_ignore_ascii_case(ext))
        }
        _ => false,
    }
}

fn looks_like_symbol(tok: &str) -> bool {
    let core = tok.trim_end_matches("()");
    if core.len() < 3 {
        return false;
    }
    if core.contains("::") {
        return true;
    }
    // snake_case or SCREAMING_SNAKE, but not a hyphenated English phrase.
    if core.contains('_') && core.chars().all(|c| c.is_ascii_alphanumeric() || c == '_') {
        return true;
    }
    // CamelCase: an inner capital after a lowercase.
    let bytes: Vec<char> = core.chars().collect();
    bytes.windows(2).any(|w| w[0].is_lowercase() && w[1].is_uppercase())
        && core.chars().all(|c| c.is_ascii_alphanumeric())
}

/// Split a question into paths, symbols and plain words.
///
/// A token is classified once, into the most specific kind it fits, so a path
/// never also counts as a word and inflate the weakest tier.
pub fn parse_question(question: &str) -> Query {
    let mut q = Query::default();
    for raw in question.split_whitespace() {
        let tok = strip_punctuation(raw);
        if tok.is_empty() {
            continue;
        }
        if looks_like_path(tok) {
            // `src/main.rs:120` is the form `aura why` takes, and a reader
            // who copies it here means the file, not a file named ":120".
            let t = match tok.rsplit_once(':') {
                Some((path, line)) if !line.is_empty() && line.chars().all(|c| c.is_ascii_digit()) => {
                    path.to_string()
                }
                _ => tok.to_string(),
            };
            if !q.paths.contains(&t) {
                q.paths.push(t);
            }
            continue;
        }
        if looks_like_symbol(tok) {
            let t = tok.trim_end_matches("()").to_string();
            if !q.symbols.contains(&t) {
                q.symbols.push(t);
            }
            continue;
        }
        let w = tok.to_lowercase();
        if w.len() < 3 || STOPWORDS.contains(&w.as_str()) {
            continue;
        }
        if !q.words.contains(&w) {
            q.words.push(w);
        }
    }
    q
}

/// The last path segment, which is what a person usually types.
fn basename(p: &str) -> &str {
    p.rsplit(['/', '\\']).next().unwrap_or(p)
}

/// Does this record's prose or path mention the asked-for file?
///
/// Compared by basename as well as by whole path, because a reader knows the
/// file by its name and a record was written with whatever path the writer
/// happened to hold.
fn mentions_path(text: &str, recorded_file: Option<&str>, asked: &str) -> bool {
    if let Some(rec) = recorded_file {
        if crate::why::paths_match(rec, asked) {
            return true;
        }
    }
    let base = basename(asked);
    base.len() >= 3 && text.to_lowercase().contains(&base.to_lowercase())
}

fn mentions_symbol(text: &str, symbol: &str) -> bool {
    // Word-ish boundary: a symbol inside a longer identifier is a different
    // symbol, and matching it would put an unrelated record in an evidence
    // tier — exactly what this module exists to prevent.
    let hay = text.to_lowercase();
    let needle = symbol.to_lowercase();
    let mut from = 0usize;
    while let Some(at) = hay[from..].find(&needle) {
        let start = from + at;
        let end = start + needle.len();
        let before_ok = start == 0
            || !hay[..start]
                .chars()
                .next_back()
                .map(|c| c.is_ascii_alphanumeric() || c == '_')
                .unwrap_or(false);
        let after_ok = end >= hay.len()
            || !hay[end..]
                .chars()
                .next()
                .map(|c| c.is_ascii_alphanumeric() || c == '_')
                .unwrap_or(false);
        if before_ok && after_ok {
            return true;
        }
        from = end;
    }
    false
}

/// How much to take off a record that restates the change instead of
/// explaining it. Large enough to lose to any stated reason in the same tier,
/// small enough that it still beats a weaker tier.
const RESTATEMENT_PENALTY: f32 = 0.75;

/// The verbs the mutation guard uses when it writes its own description of an
/// edit. They carry no reason: they name the tool that ran.
const TOOL_VERBS: &[&str] = &[
    "running", "ran", "edit", "edits", "edited", "editing", "write", "wrote", "writing",
    "multiedit", "notebookedit", "apply", "applied", "patch", "patched", "update", "updated",
    "create", "created", "delete", "deleted", "bash", "tool", "call", "agent",
];

/// Is this text the change restated rather than a reason for it?
///
/// The mutation guard writes a row for every edit whether or not anybody said
/// why, and when nobody did the text it writes is *"Claude Edit on
/// aura-cli/src/build_verify.rs"* — the file's own name, the tool that touched
/// it, and nothing else. Older rows carry no `change` field to compare
/// against, so the test has to be structural: strip the file it names, the
/// agent that wrote it and the hook's verbs, and see whether anything is left.
/// If nothing is, nothing was said.
pub fn is_restatement(text: &str, file: Option<&str>, agent: &str) -> bool {
    let base = file.map(basename).unwrap_or("").to_lowercase();
    let agent = agent.to_lowercase();
    let mut substantive = 0usize;
    for raw in text.split_whitespace() {
        let tok = strip_punctuation(raw).to_lowercase();
        if tok.is_empty() || tok.len() < 3 {
            continue;
        }
        if tok == agent || STOPWORDS.contains(&tok.as_str()) || TOOL_VERBS.contains(&tok.as_str())
        {
            continue;
        }
        // The file the row is about, by full path or by name.
        if !base.is_empty() && (tok == base || basename(&tok) == base) {
            continue;
        }
        if let Some(f) = file {
            if crate::why::paths_match(f, &tok) {
                continue;
            }
        }
        substantive += 1;
    }
    substantive == 0
}

/// Does this row explain anything, or does it only record that a change
/// happened? Combines what the writer recorded with what the text actually
/// says, because the older rows recorded neither field.
pub fn says_why(row: &IntentRow) -> bool {
    row.is_stated_reason()
        && !is_restatement(&row.intent, row.file.as_deref(), &row.agent_id)
}

/// Score one intent row against the question, or `None` if it says nothing
/// about it.
pub fn score_intent(row: &IntentRow, q: &Query) -> Option<Hit> {
    let text = &row.intent;
    let file = row.file.clone();

    let path_hits = q
        .paths
        .iter()
        .filter(|p| mentions_path(text, file.as_deref(), p))
        .count();
    if path_hits > 0 {
        // A row whose own `file` field names the path is stronger than one
        // that merely mentions it in prose: the field was written by whatever
        // knew which file was being edited.
        let stated = file
            .as_deref()
            .map(|f| q.paths.iter().any(|p| crate::why::paths_match(f, p)))
            .unwrap_or(false);
        return Some(Hit {
            tier: Tier::Path,
            score: path_hits as f32 + if stated { 1.0 } else { 0.0 }
                - if says_why(row) { 0.0 } else { RESTATEMENT_PENALTY },
            when: row.timestamp,
            who: row.agent_id.clone(),
            what: text.clone(),
            file,
            store: Store::Intent,
        });
    }

    let sym_hits = q.symbols.iter().filter(|s| mentions_symbol(text, s)).count();
    if sym_hits > 0 {
        return Some(Hit {
            tier: Tier::Symbol,
            score: sym_hits as f32
                - if says_why(row) { 0.0 } else { RESTATEMENT_PENALTY },
            when: row.timestamp,
            who: row.agent_id.clone(),
            what: text.clone(),
            file,
            store: Store::Intent,
        });
    }

    let lower = text.to_lowercase();
    let word_hits = q.words.iter().filter(|w| lower.contains(w.as_str())).count();
    if word_hits > 0 {
        return Some(Hit {
            tier: Tier::Words,
            score: word_hits as f32
                - if says_why(row) { 0.0 } else { RESTATEMENT_PENALTY },
            when: row.timestamp,
            who: row.agent_id.clone(),
            what: text.clone(),
            file,
            store: Store::Intent,
        });
    }
    None
}

/// How much of a checkpoint is about one file.
///
/// A checkpoint that captured one file is a statement about that file. A
/// goal-proof pass that snapshotted nine hundred is a statement about none of
/// them, and it names every file in the repository perfectly. Weighting by
/// specificity is what stops that snapshot from being returned as the answer
/// to every question — the exact behaviour the audit caught.
pub fn specificity(cp: &CheckpointData) -> f32 {
    let mut files: Vec<&str> = cp
        .ast_nodes
        .iter()
        .filter_map(|n| n.file_path.as_deref())
        .collect();
    files.sort_unstable();
    files.dedup();
    if files.is_empty() {
        0.0
    } else {
        1.0 / files.len() as f32
    }
}

/// Score one checkpoint. Its AST nodes carry the files and symbols it touched,
/// which is stronger evidence than its prose and is checked first.
pub fn score_checkpoint(cp: &CheckpointData, q: &Query) -> Option<Hit> {
    let when = cp.written_at_ms() / 1000;
    let text = &cp.intent;
    let focus = specificity(cp);

    let mut touched_file: Option<String> = None;
    let mut path_hits = 0usize;
    for asked in &q.paths {
        let node_match = cp.ast_nodes.iter().find(|n| {
            n.file_path
                .as_deref()
                .map(|f| crate::why::paths_match(f, asked))
                .unwrap_or(false)
        });
        if let Some(n) = node_match {
            path_hits += 1;
            if touched_file.is_none() {
                touched_file = n.file_path.clone();
            }
        } else if mentions_path(text, None, asked) {
            path_hits += 1;
        }
    }
    if path_hits > 0 {
        return Some(Hit {
            tier: Tier::Path,
            score: path_hits as f32 + if touched_file.is_some() { focus } else { 0.0 },
            when,
            who: cp.agent_id.clone(),
            what: text.clone(),
            file: touched_file,
            store: Store::Checkpoint,
        });
    }

    let mut sym_hits = 0usize;
    let mut sym_file: Option<String> = None;
    for asked in &q.symbols {
        let node_match = cp.ast_nodes.iter().find(|n| {
            n.identifier
                .as_deref()
                .map(|i| i.eq_ignore_ascii_case(asked))
                .unwrap_or(false)
        });
        if let Some(n) = node_match {
            sym_hits += 1;
            if sym_file.is_none() {
                sym_file = n.file_path.clone();
            }
        } else if mentions_symbol(text, asked) {
            sym_hits += 1;
        }
    }
    if sym_hits > 0 {
        return Some(Hit {
            tier: Tier::Symbol,
            score: sym_hits as f32 + if sym_file.is_some() { focus } else { 0.0 },
            when,
            who: cp.agent_id.clone(),
            what: text.clone(),
            file: sym_file,
            store: Store::Checkpoint,
        });
    }

    let lower = text.to_lowercase();
    let word_hits = q.words.iter().filter(|w| lower.contains(w.as_str())).count();
    if word_hits > 0 {
        return Some(Hit {
            tier: Tier::Words,
            score: word_hits as f32,
            when,
            who: cp.agent_id.clone(),
            what: text.clone(),
            file: None,
            store: Store::Checkpoint,
        });
    }
    None
}

/// Strongest first: tier, then score inside the tier, then recency.
///
/// Recency is the last key on purpose. It was the only key before, which is
/// how the newest unrelated checkpoint kept being returned as the answer to a
/// question about a specific file.
pub fn rank(mut hits: Vec<Hit>) -> Vec<Hit> {
    hits.sort_by(|a, b| {
        b.tier
            .cmp(&a.tier)
            .then_with(|| {
                b.score
                    .partial_cmp(&a.score)
                    .unwrap_or(std::cmp::Ordering::Equal)
            })
            .then_with(|| b.when.cmp(&a.when))
    });
    hits
}

/// The newest records from both stores, for a caller who asked for "recent"
/// rather than about anything in particular.
fn most_recent(rows: &[IntentRow], checkpoints: &[CheckpointData], limit: usize) -> Vec<Hit> {
    let mut hits: Vec<Hit> = rows
        .iter()
        .map(|r| Hit {
            tier: Tier::Words,
            score: 0.0,
            when: r.timestamp,
            who: r.agent_id.clone(),
            what: r.intent.clone(),
            file: r.file.clone(),
            store: Store::Intent,
        })
        .chain(checkpoints.iter().map(|c| Hit {
            tier: Tier::Words,
            score: 0.0,
            when: c.written_at_ms() / 1000,
            who: c.agent_id.clone(),
            what: c.intent.clone(),
            file: None,
            store: Store::Checkpoint,
        }))
        .collect();
    hits.sort_by(|a, b| b.when.cmp(&a.when));
    hits.truncate(limit);
    hits
}

/// Answer a question from both local stores.
///
/// Pure: the caller reads the stores and hands them in, so the whole ranking
/// is testable without a repository on disk.
pub fn answer(
    question: &str,
    rows: &[IntentRow],
    checkpoints: &[CheckpointData],
    limit: usize,
) -> Answer {
    let corpus = Corpus {
        intents: rows.len(),
        checkpoints: checkpoints.len(),
    };
    let q = parse_question(question);

    // "recent" is not a question about anything, it is a request for the tail
    // of the log — and answering it by word-matching the word "recent" would
    // return whichever record happened to use it.
    let asked_for_recent = question.trim().eq_ignore_ascii_case("recent");
    let hits = if asked_for_recent || q.is_empty() {
        most_recent(rows, checkpoints, limit)
    } else {
        let mut all: Vec<Hit> = rows.iter().filter_map(|r| score_intent(r, &q)).collect();
        all.extend(checkpoints.iter().filter_map(|c| score_checkpoint(c, &q)));
        let mut ranked = rank(all);
        ranked.truncate(limit);
        ranked
    };

    Answer {
        question: question.to_string(),
        hits,
        corpus,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::models::AstNode;

    fn intent(ts: u64, text: &str, file: Option<&str>) -> IntentRow {
        IntentRow {
            timestamp: ts,
            agent_id: "claude".into(),
            intent: text.into(),
            intent_type: None,
            signed_block_id: None,
            key_id: None,
            source: None,
            file: file.map(|s| s.to_string()),
            session_id: None,
            stated_at: None,
            change: None,
            tool: None,
        }
    }

    /// A row a hook wrote from the diff: names the file, explains nothing.
    /// `change` equals `intent` and nobody stated a reason, which is exactly
    /// how these rows look on disk.
    fn hook_stub(ts: u64, text: &str, file: &str) -> IntentRow {
        IntentRow {
            source: Some("hook_auto".into()),
            change: Some(text.into()),
            tool: None,
            ..intent(ts, text, Some(file))
        }
    }

    /// A row the same hook wrote, but where somebody had said why first.
    fn stated(ts: u64, why: &str, change: &str, file: &str) -> IntentRow {
        IntentRow {
            source: Some("hook_auto".into()),
            change: Some(change.into()),
            tool: None,
            stated_at: Some(ts - 1),
            ..intent(ts, why, Some(file))
        }
    }

    fn node(file: &str, ident: &str) -> AstNode {
        AstNode {
            node_id: format!("n:{ident}"),
            kind: "function_definition".into(),
            identifier: Some(ident.into()),
            content_hash: String::new(),
            children: vec![],
            dependencies: vec![],
            contains_secret: false,
            is_stub: false,
            derived_from: None,
            confidence: 1.0,
            file_path: Some(file.into()),
            start_line: Some(1),
            end_line: Some(9),
            signature: None,
            doc_comment: None,
            top_level: true,
        }
    }

    fn checkpoint(ms: u64, text: &str, nodes: Vec<AstNode>) -> CheckpointData {
        CheckpointData {
            id: format!("cp-{ms}"),
            agent_id: "claude".into(),
            intent: text.into(),
            ast_nodes: nodes,
            timestamp: ms,
            intent_vector: None,
            intent_vector_model: None,
            env_fingerprint: None,
            file_oids: Default::default(),
            scope: None,
        }
    }

    #[test]
    fn a_question_names_files_symbols_and_words_apart() {
        let q = parse_question("why did aura-cli/src/build_verify.rs change parse_tree?");
        assert_eq!(q.paths, vec!["aura-cli/src/build_verify.rs".to_string()]);
        assert_eq!(q.symbols, vec!["parse_tree".to_string()]);
        assert!(q.words.is_empty(), "why/did/change carry no signal: {:?}", q.words);
    }

    #[test]
    fn a_bare_filename_is_a_path_not_a_word() {
        let q = parse_question("why did build_verify.rs change");
        assert_eq!(q.paths, vec!["build_verify.rs".to_string()]);
        assert!(q.symbols.is_empty(), "a filename must not also be filed as a symbol");
    }

    #[test]
    fn the_newest_unrelated_record_never_outranks_the_one_naming_the_file() {
        // The exact shape of the reported bug: ask why one file changed, and
        // the answer was the newest checkpoint, which was about something else.
        let rows = vec![intent(
            1_000,
            "fix the release build so the verifier stops failing on a clean tree",
            Some("aura-cli/src/build_verify.rs"),
        )];
        let cps = vec![checkpoint(
            9_000_000,
            "goal proof run for the RBAC spine",
            vec![node("aura-cloud/src/rbac.rs", "enforce_scope")],
        )];

        let a = answer("why did build_verify.rs change", &rows, &cps, 5);
        assert_eq!(a.verdict(), Verdict::Found);
        let top = &a.hits[0];
        assert_eq!(top.tier, Tier::Path);
        assert_eq!(top.store, Store::Intent);
        assert!(
            top.what.contains("release build"),
            "the recorded reason must win, got {:?}",
            top.what
        );
    }

    #[test]
    fn a_symbol_match_beats_word_overlap_however_new_the_words_are() {
        let rows = vec![
            intent(1_000, "rewrite parse_tree so a .tsx file gets its own grammar", None),
            intent(9_000, "grammar work on the release notes", None),
        ];
        let a = answer("what happened to parse_tree", &rows, &[], 5);
        assert_eq!(a.hits[0].tier, Tier::Symbol);
        assert!(a.hits[0].what.contains("own grammar"));
    }

    #[test]
    fn a_symbol_inside_a_longer_identifier_is_a_different_symbol() {
        let rows = vec![intent(1, "reworked parse_tree_cache eviction", None)];
        let a = answer("why parse_tree", &rows, &[], 5);
        assert!(
            a.hits.is_empty(),
            "parse_tree_cache is not parse_tree: {:?}",
            a.hits
        );
        assert_eq!(a.verdict(), Verdict::NoMatch);
    }

    #[test]
    fn a_checkpoint_that_touched_the_file_is_evidence_even_when_its_prose_is_not() {
        let cps = vec![checkpoint(
            5_000,
            "wave 3",
            vec![node("aura-cli/src/build_verify.rs", "verify_release")],
        )];
        let a = answer("why did build_verify.rs change", &[], &cps, 5);
        assert_eq!(a.hits[0].tier, Tier::Path);
        assert_eq!(a.hits[0].file.as_deref(), Some("aura-cli/src/build_verify.rs"));
    }

    #[test]
    fn a_stated_file_outscores_a_passing_mention_of_it() {
        let rows = vec![
            intent(2_000, "touched build_verify.rs while chasing something else", None),
            intent(1_000, "make the verifier tolerate a clean tree", Some("aura-cli/src/build_verify.rs")),
        ];
        let a = answer("why did build_verify.rs change", &rows, &[], 5);
        assert_eq!(a.hits[0].tier, Tier::Path);
        assert!(
            a.hits[0].what.contains("tolerate a clean tree"),
            "the row that names the file in its own field wins, got {:?}",
            a.hits[0].what
        );
    }

    #[test]
    fn an_empty_result_never_claims_the_repository_is_new_when_it_is_not() {
        let rows = vec![intent(1, "something else entirely", None)];
        let a = answer("why did nothing_here.rs change", &rows, &[], 5);
        assert_eq!(a.verdict(), Verdict::NoMatch);
        let line = a.empty_line();
        assert!(line.contains("Searched 1 intent"), "{line}");
        assert!(
            !line.to_lowercase().contains("just initialized")
                && !line.to_lowercase().contains("initialised"),
            "{line}"
        );
    }

    #[test]
    fn a_genuinely_empty_repository_says_so() {
        let a = answer("why did anything change", &[], &[], 5);
        assert_eq!(a.verdict(), Verdict::NothingRecorded);
        assert!(a.empty_line().contains("Nothing has been recorded"));
    }

    #[test]
    fn recent_returns_the_tail_of_both_stores_newest_first() {
        // Real epoch values: the two stores keep different units, and
        // `written_at_ms` only knows which is which above its floor.
        const BASE: u64 = 1_767_225_600;
        let rows = vec![
            intent(BASE + 10, "older intent", None),
            intent(BASE + 30, "newer intent", None),
        ];
        let cps = vec![checkpoint(
            (BASE + 20) * 1000,
            "a checkpoint between them",
            vec![],
        )];
        let a = answer("recent", &rows, &cps, 5);
        let order: Vec<u64> = a.hits.iter().map(|h| h.when).collect();
        assert_eq!(order, vec![BASE + 30, BASE + 20, BASE + 10]);
        assert_eq!(a.hits[1].store, Store::Checkpoint);
    }

    #[test]
    fn a_hook_stub_never_outranks_the_reason_somebody_wrote() {
        // The audit's "no reason was written about this file": the reasons
        // were there, buried under newer rows that only restated the edit.
        let rows = vec![
            stated(
                1_000,
                "make the verifier tolerate a clean tree so release builds stop failing",
                "running Edit on build_verify.rs",
                "aura-cli/src/build_verify.rs",
            ),
            hook_stub(
                9_000,
                "Claude Edit on aura-cli/src/build_verify.rs",
                "aura-cli/src/build_verify.rs",
            ),
        ];
        let a = answer("why did build_verify.rs change", &rows, &[], 5);
        assert!(
            a.hits[0].what.contains("tolerate a clean tree"),
            "the stated reason must come first, got {:?}",
            a.hits[0].what
        );
        assert_eq!(a.hits.len(), 2, "the stub is still findable, just not first");
    }

    #[test]
    fn a_hook_row_that_only_names_the_file_says_nothing() {
        // The two phrasings actually on disk in this repo's log.
        assert!(is_restatement(
            "Claude Edit on aura-cli/src/build_verify.rs",
            Some("aura-cli/src/build_verify.rs"),
            "Claude"
        ));
        assert!(is_restatement(
            "running Edit on build_verify.rs",
            Some("/abs/path/aura-cli/src/build_verify.rs"),
            "claude"
        ));
        // And a real sentence about the same file is not swept up with them.
        assert!(!is_restatement(
            "timeout arm must SIGKILL the child so wait threads unwind",
            Some("aura-cli/src/build_verify.rs"),
            "claude"
        ));
    }

    #[test]
    fn an_older_hook_row_with_no_change_field_is_still_recognised() {
        // Rows written before the guard recorded `change` carry neither field,
        // so only the text can tell them apart. This is the shape that made
        // every answer read "no reason was written about this file".
        let bare = IntentRow {
            agent_id: "Claude".into(),
            ..intent(
                9_000,
                "Claude Edit on aura-cli/src/build_verify.rs",
                Some("aura-cli/src/build_verify.rs"),
            )
        };
        assert!(bare.is_stated_reason(), "the record itself claims nothing either way");
        assert!(!says_why(&bare), "but the text says nothing");

        let real = intent(
            1_000,
            "timeout arm must SIGKILL the child so wait threads unwind",
            Some("aura-cli/src/build_verify.rs"),
        );
        let a = answer("why did build_verify.rs change", &[bare, real], &[], 5);
        assert!(
            a.hits[0].what.contains("SIGKILL"),
            "the sentence wins over the newer stub, got {:?}",
            a.hits[0].what
        );
    }

    #[test]
    fn a_whole_repo_snapshot_does_not_answer_a_question_about_one_file() {
        // A goal-proof pass captures every file, so it names the asked-for one
        // as exactly as a targeted record does. Specificity is what separates
        // them, and it must beat recency.
        let mut everything = Vec::new();
        for i in 0..400 {
            everything.push(node(&format!("src/f{i}.rs"), &format!("f{i}")));
        }
        everything.push(node("aura-cli/src/build_verify.rs", "verify_release"));
        let cps = vec![
            checkpoint(9_000_000_000, "goal proof pass, no source edited", everything),
            checkpoint(
                1_000_000_000,
                "stop the verifier failing on a clean tree",
                vec![node("aura-cli/src/build_verify.rs", "verify_release")],
            ),
        ];
        let a = answer("why did build_verify.rs change", &[], &cps, 5);
        assert!(
            a.hits[0].what.contains("clean tree"),
            "the focused checkpoint must win over the newer snapshot, got {:?}",
            a.hits[0].what
        );
    }

    #[test]
    fn specificity_falls_off_with_the_number_of_files_touched() {
        let one = checkpoint(1, "x", vec![node("a.rs", "a")]);
        let many = checkpoint(
            1,
            "x",
            (0..10).map(|i| node(&format!("f{i}.rs"), "a")).collect(),
        );
        assert_eq!(specificity(&one), 1.0);
        assert!(specificity(&many) < specificity(&one));
        assert_eq!(specificity(&checkpoint(1, "x", vec![])), 0.0);
    }

    #[test]
    fn ranking_is_stable_across_stores_at_the_same_tier() {
        let rows = vec![intent(100, "parse_tree fix", None)];
        let cps = vec![checkpoint(
            50_000,
            "unrelated",
            vec![node("src/p.rs", "parse_tree")],
        )];
        let a = answer("parse_tree", &rows, &cps, 5);
        assert!(a.hits.iter().all(|h| h.tier == Tier::Symbol));
        // The checkpoint carries the node, so it scores higher inside the tier
        // even though both are evidence.
        assert_eq!(a.hits[0].store, Store::Checkpoint);
    }
}

// ---------------------------------------------------------------------------
// Reading the stores, and rendering. Kept below the pure half so the ranking
// above stays testable without a repository on disk.
// ---------------------------------------------------------------------------

/// Read both local stores. Either one being unreadable is not an error — a
/// repo with no checkpoints still has intents, and saying so is the point.
pub fn read_stores() -> (Vec<IntentRow>, Vec<CheckpointData>) {
    let root = crate::goals::discover_repo_root();
    let log = root
        .clone()
        .map(|r| r.join(".aura/intent_log.jsonl"))
        .unwrap_or_else(|| std::path::PathBuf::from(".aura/intent_log.jsonl"));
    let rows = crate::intent_query::read_all_rows(&log);

    let checkpoints = root
        .as_deref()
        .and_then(|r| git2::Repository::discover(r).ok())
        .or_else(|| git2::Repository::discover(".").ok())
        .and_then(|repo| crate::checkpoint::CheckpointStore::get_all_checkpoints(&repo).ok())
        .unwrap_or_default();

    (rows, checkpoints)
}

fn ago(when: u64, now: u64) -> String {
    if when == 0 {
        return "unknown".into();
    }
    let d = now.saturating_sub(when);
    if d < 90 {
        return "just now".into();
    }
    let mins = d / 60;
    if mins < 90 {
        return format!("{mins}m ago");
    }
    let hours = mins / 60;
    if hours < 48 {
        return format!("{hours}h ago");
    }
    format!("{}d ago", hours / 24)
}

/// `aura ask` — answer a question from this repository's own record.
pub fn run(question: &str, json: bool, limit: usize) -> i32 {
    use colored::Colorize;

    let (rows, checkpoints) = read_stores();
    let a = answer(question, &rows, &checkpoints, limit);

    if json {
        println!("{}", a.to_json());
        return if a.hits.is_empty() { 1 } else { 0 };
    }

    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0);

    println!();
    if a.hits.is_empty() {
        println!("  {}", a.empty_line());
        if a.verdict() == Verdict::NothingRecorded {
            println!(
                "  {}",
                "Aura records a reason when you commit, or when an agent calls log-intent.".dimmed()
            );
        } else {
            println!(
                "  {}",
                "Try the file's path, or a symbol name — those are matched exactly.".dimmed()
            );
        }
        println!();
        return 1;
    }

    println!(
        "  {} {}",
        "Asked:".dimmed(),
        a.question.trim().italic()
    );
    println!(
        "  {} {} intents, {} checkpoints\n",
        "Searched:".dimmed(),
        a.corpus.intents,
        a.corpus.checkpoints
    );

    for hit in &a.hits {
        let where_ = hit.file.as_deref().unwrap_or("—");
        println!(
            "  {}  {}",
            format!("[{}]", hit.tier.label()).green().bold(),
            where_.cyan()
        );
        for line in textwrap::wrap(&hit.what, 76) {
            println!("      {line}");
        }
        println!(
            "      {}\n",
            format!(
                "{} · {} · {}",
                hit.store.label(),
                hit.who,
                ago(hit.when, now)
            )
            .dimmed()
        );
    }
    0
}
