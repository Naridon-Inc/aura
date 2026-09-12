// S2-TI / doc 16: typed intent schema.
//
// Pure helpers for reading the local intent log (.aura/intent_log.jsonl)
// and filtering by canonical intent_type + lookback window. Lives in its
// own module so the MCP handler stays thin and the parsing/filter logic
// is easy to unit-test without touching the JSON-RPC envelope.

use serde_json::{json, Value};
use std::path::Path;

/// The closed set of canonical intent types (doc 16, P3). Custom types
/// are deferred to a Cedar-policy gate; for now any value not in this
/// list is rejected at every capture boundary — `aura_log_intent` over
/// MCP, and `aura log-intent --type` / `aura sign-intent --type` on the
/// CLI. The CLI half of that sentence was untrue for a long time: it
/// wrote whatever it was handed, which is how 13 `UXChange` and one
/// `ProductFix` row came to sit in a field every reader treats as an
/// enum, in buckets no histogram or `--type` filter can reach.
pub const CANONICAL_INTENT_TYPES: &[&str] = &[
    "FeatureAdd",
    "BugFix",
    "Refactor",
    "Revert",
    "Performance",
    "Docs",
    "Deps",
];

pub fn is_canonical_intent_type(s: &str) -> bool {
    CANONICAL_INTENT_TYPES.iter().any(|t| *t == s)
}

/// The canonical spelling of what somebody typed, or `None` if it names
/// no type at all.
///
/// Case and surrounding space are typos, not different classifications:
/// `bugfix`, ` BugFix ` and `BUGFIX` all mean the one bucket, and a
/// caller who reached for `--type` clearly meant to file the entry.
/// Repairing those is the difference between an entry that appears in
/// the histogram and one that silently does not. Anything genuinely
/// outside the set still fails, because widening the enum here would
/// fragment every query that reads it.
pub fn canonicalize_intent_type(s: &str) -> Option<&'static str> {
    let want = s.trim();
    CANONICAL_INTENT_TYPES
        .iter()
        .copied()
        .find(|t| t.eq_ignore_ascii_case(want))
}

/// The line to print when a caller states a type nothing can render.
pub fn invalid_intent_type_message(got: &str) -> String {
    format!(
        "unknown intent type '{}' — dropped. Use one of: {}",
        got.trim(),
        CANONICAL_INTENT_TYPES.join(", "),
    )
}

/// The line to print when a caller states no type at all.
///
/// Not an error: an untyped entry is still a logged intent, and the text
/// is the part that binds to the AST. But 91 of 413 rows in this repo's
/// own log carry a type, so every classification view is mostly dark —
/// and the reason is that nothing ever said so at the point of writing.
pub const UNTYPED_INTENT_HINT: &str =
    "no --type given, so this entry joins no classification view. \
One of: FeatureAdd, BugFix, Refactor, Revert, Performance, Docs, Deps";

/// One row from the intent log, normalised to the fields we care about
/// for querying. We keep the original `raw` so callers can surface fields
/// we don't model explicitly (e.g. rekor_url) without re-reading the file.
#[derive(Debug, Clone, PartialEq)]
pub struct IntentRow {
    pub timestamp: u64,
    pub agent_id: String,
    pub intent: String,
    pub intent_type: Option<String>,
    pub signed_block_id: Option<String>,
    pub key_id: Option<String>,
    /// Where the `intent` text came from, when the mutation guard wrote this
    /// row rather than an agent calling `log-intent`: `session_prompt`,
    /// `brain_inferred` or `guard_auto_stub` (see the desktop shell's
    /// `agent_mutation_guard`). `None` means somebody stated it.
    ///
    /// Modelled here because `intent-vs-actual` judges the intent text against
    /// the AST, and a `brain_inferred` line was written *from* that AST — it
    /// agrees with the diff by construction, and the check reported "aligned"
    /// with no way for a caller to know the two sides weren't independent.
    pub source: Option<String>,
    /// Repo-relative path the mutation touched, when the row came from a hook
    /// that knew which file was being edited. Written by `log-intent --file`.
    ///
    /// Modelled here because `aura why` answers *"why is this line the way it
    /// is"* — a question that starts from a path. Without it every lookup has
    /// to fall back to the commit's time window, which is a guess rather than
    /// a statement.
    pub file: Option<String>,
    /// The agent conversation this intent was stated in — a Claude/Codex/Kimi
    /// session id, written by `log-intent --session`.
    ///
    /// This is the join key from *what the agent said it was doing* to *what
    /// the person actually asked for*, which lives in the agent's own
    /// transcript (see `crate::history`). It is the whole reason the field is
    /// carried through rather than left in the raw JSON.
    pub session_id: Option<String>,
    /// When the reason in `intent` was stated, if it was stated at all.
    ///
    /// The mutation guard writes a row for every edit, and it writes one
    /// whether or not anybody said why. When somebody did — `aura
    /// snapshot-file --why`, or a `log-intent` that preceded the edit — the
    /// hook stamps the moment the sentence was written, and `intent` carries
    /// that sentence. When nobody did, `intent` carries the hook's own
    /// description of the edit and this is `None`.
    ///
    /// Both rows have the same `source`, so `source` alone cannot separate
    /// them. Reading this field is the difference between "no reason was
    /// written about this file" and finding the reason that was.
    pub stated_at: Option<u64>,
    /// The hook's mechanical description of the edit — *"running Edit on
    /// build_verify.rs"*. Present alongside a stated reason, and equal to
    /// `intent` when there was none to state.
    pub change: Option<String>,
    /// The tool call the hook was writing about — `Edit`, `Write`, `Bash`.
    ///
    /// Only a hook sets it, and it is what separates the two rows that
    /// otherwise look alike: a row with a `tool` and no `change` is the
    /// hook's own sentence about a tool call (*"Claude Edit on
    /// intent_query.rs"*), while a row with both carries somebody's reason
    /// with the mechanical description kept beside it. Modelled here
    /// because `is_stated_reason` cannot tell them apart without it — the
    /// desktop's reader has always had this field and answered correctly
    /// where this one did not.
    pub tool: Option<String>,
}

/// The stub a hook writes for a file edit nobody gave a reason for. It is a
/// sentence about the absence of a reason, not a reason. In full the hook
/// writes *"Automatic pre-Edit snapshot; no reason was stated by the agent."*
///
/// Named the same as `recorded_reason::NO_REASON_STUB` in the desktop shell,
/// which reads the same log and has always rejected this text.
const NO_REASON_STUB: &str = "no reason was stated";

/// Is this intent text the hook's stub rather than somebody's sentence?
///
/// The phrase has to *end* the text. Matching it anywhere — which is what the
/// shell does — throws out a real reason that quotes the stub while explaining
/// it, and that is not hypothetical: the reason written for this very change
/// quoted the sentence, was discarded, and the commit gate then reported the
/// file as carrying no reason at all. A gate that rejects the explanation of
/// itself is worse than no gate.
fn is_no_reason_stub(intent: &str) -> bool {
    let lowered = intent.trim().to_lowercase();
    let tail = lowered
        .trim_end_matches('.')
        .trim_end()
        .trim_end_matches("by the agent")
        .trim_end();
    tail.ends_with(NO_REASON_STUB)
}

impl IntentRow {
    /// Did somebody state this reason, or is the text the change restated?
    ///
    /// A row that names a file perfectly and explains nothing is still a
    /// record worth finding, but it must never be served ahead of the sentence
    /// somebody actually wrote about that file.
    pub fn is_stated_reason(&self) -> bool {
        // Checked before `stated_at`, and this order is the whole point. The
        // hook stamps `why_stated_at` on rows whose text is the stub itself,
        // so trusting the timestamp first declared the absence of a reason to
        // be a reason — and every caller here believed it while the shell,
        // reading the same rows, did not.
        if is_no_reason_stub(&self.intent) {
            return false;
        }
        // A hook wrote this about a tool call and nothing displaced its
        // sentence. Checked before `stated_at` for the same reason the stub
        // is: the hook stamps a time on its own text too.
        //
        // This clause was missing, and it is the commonest row in the log —
        // `{"intent": "Claude Edit on aura-cli/src/intent_query.rs", "tool":
        // "Edit"}`, no `change`, no `why_stated_at`. It fell through to the
        // final `None => true` and was served as a reason somebody wrote.
        // The desktop's `recorded_reason::is_stated_reason` has always had
        // this clause; the two readers of one log disagreed, and which
        // answer you got depended on which surface you were looking at.
        if self.tool.is_some() && self.change.is_none() {
            return false;
        }
        if self.stated_at.is_some() {
            return true;
        }
        match &self.change {
            Some(c) => c.trim() != self.intent.trim(),
            None => true,
        }
    }
}

impl IntentRow {
    pub fn to_json(&self) -> Value {
        let mut v = json!({
            "timestamp": self.timestamp,
            "agent_id": self.agent_id,
            "intent": self.intent,
        });
        if let Some(t) = &self.intent_type {
            v["intent_type"] = json!(t);
        }
        if let Some(bid) = &self.signed_block_id {
            v["signed_block_id"] = json!(bid);
        }
        if let Some(kid) = &self.key_id {
            v["key_id"] = json!(kid);
        }
        if let Some(src) = &self.source {
            v["source"] = json!(src);
        }
        if let Some(f) = &self.file {
            v["file"] = json!(f);
        }
        if let Some(sid) = &self.session_id {
            v["session_id"] = json!(sid);
        }
        if let Some(at) = self.stated_at {
            v["why_stated_at"] = json!(at);
        }
        if let Some(t) = &self.tool {
            v["tool"] = json!(t);
        }
        if let Some(c) = &self.change {
            v["change"] = json!(c);
        }
        v["stated_reason"] = json!(self.is_stated_reason());
        v
    }
}

/// Parse one JSONL line into an IntentRow. Returns None for blank lines or
/// rows that don't carry the minimum {intent, timestamp} we expect — older
/// schema variants (pre-S1) sometimes wrote partial entries.
pub fn parse_intent_line(line: &str) -> Option<IntentRow> {
    let line = line.trim();
    if line.is_empty() {
        return None;
    }
    let v: Value = serde_json::from_str(line).ok()?;
    let intent = v.get("intent")?.as_str()?.to_string();
    let timestamp = v.get("timestamp").and_then(|t| t.as_u64()).unwrap_or(0);
    let agent_id = v
        .get("agent_id")
        .and_then(|a| a.as_str())
        .unwrap_or("unknown")
        .to_string();
    let intent_type = v
        .get("intent_type")
        .and_then(|t| t.as_str())
        .map(|s| s.to_string());
    let signed_block_id = v
        .get("signed_block_id")
        .and_then(|t| t.as_str())
        .map(|s| s.to_string());
    let key_id = v
        .get("key_id")
        .and_then(|t| t.as_str())
        .map(|s| s.to_string());
    // Written by the mutation guard, nested under the changeset it wrote. A
    // top-level `source` is accepted too so a re-serialised row (`to_json`
    // above) round-trips.
    let source = v
        .get("changeset")
        .and_then(|c| c.get("source"))
        .or_else(|| v.get("source"))
        .and_then(|t| t.as_str())
        .map(|s| s.to_string());
    let file = v
        .get("file")
        .and_then(|f| f.as_str())
        .map(|s| s.to_string())
        .filter(|s| !s.is_empty());
    let session_id = v
        .get("session_id")
        .and_then(|s| s.as_str())
        .map(|s| s.to_string())
        .filter(|s| !s.is_empty());
    let stated_at = v
        .get("why_stated_at")
        .and_then(|t| t.as_u64())
        .filter(|t| *t > 0);
    let change = v
        .get("change")
        .and_then(|c| c.as_str())
        .map(|s| s.to_string())
        .filter(|s| !s.is_empty());
    let tool = v
        .get("tool")
        .and_then(|t| t.as_str())
        .map(|s| s.to_string())
        .filter(|s| !s.is_empty());
    Some(IntentRow {
        timestamp,
        agent_id,
        intent,
        intent_type,
        signed_block_id,
        key_id,
        source,
        file,
        session_id,
        stated_at,
        change,
        tool,
    })
}

/// Read every parseable row from .aura/intent_log.jsonl (or another path).
/// Missing file returns an empty Vec so callers don't need a separate
/// "is the log present yet" branch.
pub fn read_all_rows(path: &Path) -> Vec<IntentRow> {
    let text = match std::fs::read_to_string(path) {
        Ok(t) => t,
        Err(_) => return Vec::new(),
    };
    text.lines().filter_map(parse_intent_line).collect()
}

/// Result of a query call. Carries unbounded `total_matches` separately
/// from the `entries` slice so a caller paginating with `limit` knows
/// whether more rows exist.
#[derive(Debug, Clone)]
pub struct IntentQueryResult {
    pub since_hours: i64,
    pub intent_type: Option<String>,
    pub total_matches: usize,
    pub entries: Vec<IntentRow>,
}

impl IntentQueryResult {
    pub fn to_json(&self) -> Value {
        let entries: Vec<Value> = self.entries.iter().map(|r| r.to_json()).collect();
        let mut v = json!({
            "since_hours": self.since_hours,
            "total_matches": self.total_matches,
            "returned": self.entries.len(),
            "entries": entries,
        });
        if let Some(t) = &self.intent_type {
            v["intent_type"] = json!(t);
        }
        v
    }
}

/// Run the actual filter + sort + cap. Pulled out of the MCP handler so
/// the unit tests can hit it directly without spinning up a fake jsonl
/// fixture every time.
pub fn query_rows(
    rows: Vec<IntentRow>,
    intent_type: Option<&str>,
    since_hours: i64,
    limit: usize,
    now_unix_secs: u64,
) -> IntentQueryResult {
    // since_hours <= 0 disables the cutoff (doc 16: '0 returns the
    // entire log'). i64 here so a caller can pass negative values
    // without underflow on the multiplication.
    let cutoff: u64 = if since_hours <= 0 {
        0
    } else {
        let window_secs = (since_hours as u64).saturating_mul(3600);
        now_unix_secs.saturating_sub(window_secs)
    };

    // Pair each surviving row with its original on-disk index so we can
    // break timestamp ties deterministically: same-second entries (rapid
    // back-to-back log_intent calls land in the same `as_secs()` bucket)
    // resolve to "latest line in the file wins", which matches the
    // intuitive "newest" semantics callers expect.
    let mut indexed: Vec<(usize, IntentRow)> = rows
        .into_iter()
        .enumerate()
        .filter(|(_, r)| {
            // Window: rows with timestamp == 0 are legacy entries with no
            // recorded ts — keep them only when the cutoff is also 0
            // (otherwise they'd silently dominate every windowed query).
            if cutoff > 0 && r.timestamp < cutoff {
                return false;
            }
            if let Some(t) = intent_type {
                if r.intent_type.as_deref() != Some(t) {
                    return false;
                }
            }
            true
        })
        .collect();

    // Primary: timestamp desc. Secondary: line index desc (newest-on-disk
    // wins on a tie).
    indexed.sort_by(|a, b| b.1.timestamp.cmp(&a.1.timestamp).then_with(|| b.0.cmp(&a.0)));
    let mut filtered: Vec<IntentRow> = indexed.into_iter().map(|(_, r)| r).collect();

    let total_matches = filtered.len();
    if filtered.len() > limit {
        filtered.truncate(limit);
    }

    IntentQueryResult {
        since_hours,
        intent_type: intent_type.map(|s| s.to_string()),
        total_matches,
        entries: filtered,
    }
}

/// Structured form of the typed-intent summary, separated from the
/// prose renderer so MCP and CLI --json callers can consume the same
/// numbers a human sees in the prose form. Always reflects the same
/// bucketing/sorting rules — the prose is built from this struct.
#[derive(Debug, Clone)]
pub struct TypedIntentSummary {
    pub since_hours: i64,
    pub typed_total: usize,
    pub untyped: usize,
    /// Bucketed by intent_type, count desc / name asc. Each bucket
    /// carries up to `sample_per_type` newest-first sample intents
    /// (truncated to 80 chars to keep the payload terse).
    pub buckets: Vec<TypedIntentBucket>,
}

#[derive(Debug, Clone)]
pub struct TypedIntentBucket {
    pub intent_type: String,
    pub count: usize,
    pub samples: Vec<String>,
}

impl TypedIntentSummary {
    pub fn to_json(&self) -> Value {
        let buckets: Vec<Value> = self
            .buckets
            .iter()
            .map(|b| {
                json!({
                    "intent_type": b.intent_type,
                    "count": b.count,
                    "samples": b.samples,
                })
            })
            .collect();
        json!({
            "since_hours": self.since_hours,
            "typed_total": self.typed_total,
            "untyped": self.untyped,
            "type_count": self.buckets.len(),
            "buckets": buckets,
        })
    }
}

/// One sample line, capped at 80 bytes. The cut walks back to a char
/// boundary — `truncate(77)` on a raw byte offset panics the moment byte 77
/// lands inside a multi-byte character, and intents are free-form prose.
fn sample_line(intent: &str) -> String {
    if intent.len() <= 80 {
        return intent.to_string();
    }
    let mut end = 77;
    while end > 0 && !intent.is_char_boundary(end) {
        end -= 1;
    }
    format!("{}...", &intent[..end])
}

/// Compute the structured typed-intent summary for the given log path.
/// Returns None on the same conditions as narrate_typed_intents_prose:
/// missing/empty log, or zero typed rows in the window. Both renderers
/// share this builder so JSON and prose can never disagree.
pub fn build_typed_intent_summary(
    path: &Path,
    since_hours: i64,
    sample_per_type: usize,
) -> Option<TypedIntentSummary> {
    use std::collections::BTreeMap;

    let now_unix_secs = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0);
    let rows = read_all_rows(path);
    if rows.is_empty() {
        return None;
    }
    let q = query_rows(rows, None, since_hours, usize::MAX, now_unix_secs);
    if q.entries.is_empty() {
        return None;
    }

    let mut by_type: BTreeMap<String, Vec<&IntentRow>> = BTreeMap::new();
    let mut typed_total: usize = 0;
    for row in &q.entries {
        if let Some(t) = &row.intent_type {
            by_type.entry(t.clone()).or_default().push(row);
            typed_total += 1;
        }
    }
    if typed_total == 0 {
        return None;
    }

    let mut by_type_vec: Vec<(String, Vec<&IntentRow>)> = by_type.into_iter().collect();
    by_type_vec.sort_by(|a, b| b.1.len().cmp(&a.1.len()).then_with(|| a.0.cmp(&b.0)));

    let untyped = q.entries.len().saturating_sub(typed_total);
    let buckets: Vec<TypedIntentBucket> = by_type_vec
        .into_iter()
        .map(|(t, rows)| {
            let n = rows.len().min(sample_per_type);
            let samples: Vec<String> = if sample_per_type == 0 {
                Vec::new()
            } else {
                rows[..n]
                    .iter()
                    .map(|r| sample_line(&r.intent))
                    .collect()
            };
            TypedIntentBucket {
                intent_type: t,
                count: rows.len(),
                samples,
            }
        })
        .collect();

    Some(TypedIntentSummary {
        since_hours,
        typed_total,
        untyped,
        buckets,
    })
}

/// One-shot wrapper that reads the intent log, groups recent typed
/// entries by intent_type, and renders a deterministic prose summary
/// suitable for embedding in handover XML or any other agent-facing
/// payload. Returns None when the log is missing/empty OR when no rows
/// in the window carry an intent_type — both cases mean "nothing useful
/// to say" and the caller should suppress the section entirely rather
/// than emit an empty header.
///
/// The prose is intentionally one paragraph + N bullet lines so it
/// CDATA-embeds cleanly. Counts sort by descending count then by
/// canonical-name ascending for tie-breaks (deterministic across runs).
pub fn narrate_typed_intents_prose(
    path: &Path,
    since_hours: i64,
    sample_per_type: usize,
) -> Option<String> {
    let summary = build_typed_intent_summary(path, since_hours, sample_per_type)?;
    let mut out = String::new();
    out.push_str(&format!(
        "Typed intent summary (last {}h): {} typed across {} type(s); {} untyped.\n",
        summary.since_hours,
        summary.typed_total,
        summary.buckets.len(),
        summary.untyped,
    ));
    for bucket in &summary.buckets {
        out.push_str(&format!("  - {} ×{}", bucket.intent_type, bucket.count));
        if !bucket.samples.is_empty() {
            out.push_str(&format!(
                " — latest: \"{}\"",
                bucket.samples.join("\" / \"")
            ));
        }
        out.push('\n');
    }
    Some(out)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn row(ts: u64, t: Option<&str>, intent: &str) -> IntentRow {
        IntentRow {
            timestamp: ts,
            agent_id: "test".into(),
            intent: intent.into(),
            intent_type: t.map(|s| s.into()),
            signed_block_id: None,
            key_id: None,
            source: None,
            file: None,
            session_id: None,
            stated_at: None,
            change: None,
            tool: None,
        }
    }

    #[test]
    fn the_hooks_stub_is_not_a_reason_even_with_a_time_stamped_on_it() {
        // The shape every real hook row has. Trusting `stated_at` first made
        // the absence of a reason read as a reason, and every gate that asks
        // "is this file explained" answered yes for a file nobody explained.
        let mut r = row(200, None, "Automatic pre-Edit snapshot; no reason was stated by the agent.");
        r.stated_at = Some(199);
        r.change = Some("Claude Edit on a.rs".into());
        assert!(!r.is_stated_reason());
    }

    #[test]
    fn a_reason_that_quotes_the_stub_while_explaining_it_survives() {
        // Caught on real data: the reason written for the fix above quoted
        // the hook sentence, a `contains` test discarded it, and the commit
        // gate then reported that file as carrying no reason at all.
        let mut r = row(
            200,
            None,
            "The hook writes 'no reason was stated by the agent' even when somebody did, \
             so the reader believed the stub and hid the sentence underneath it.",
        );
        r.stated_at = Some(199);
        assert!(r.is_stated_reason());
    }

    #[test]
    fn the_hooks_own_sentence_about_a_tool_call_is_not_a_reason() {
        // The commonest row in a real log: the hook naming the tool it ran
        // and the file it ran on, with nobody's words anywhere in it. It
        // has no `change` to be compared against and no stamped time, so
        // it fell all the way through to the permissive tail and was
        // served as a reason. The desktop reader, on the same row, said no.
        let mut r = row(200, None, "Claude Edit on aura-cli/src/intent_query.rs");
        r.tool = Some("Edit".into());
        assert!(!r.is_stated_reason());
    }

    #[test]
    fn a_reason_stated_over_a_tool_call_still_counts() {
        // Same hook, but somebody said why first: the sentence is theirs and
        // the mechanical description is kept beside it in `change`. Rejecting
        // this would throw away every reason written the way Aura asks for.
        let mut r = row(200, None, "switch retry to exponential backoff so we stop tripping the rate limit");
        r.tool = Some("Edit".into());
        r.change = Some("Claude Edit on retry.rs".into());
        assert!(r.is_stated_reason());
    }

    #[test]
    fn canonical_set_is_closed() {
        for t in CANONICAL_INTENT_TYPES {
            assert!(is_canonical_intent_type(t));
        }
        assert!(!is_canonical_intent_type("BugFx"));
        assert!(!is_canonical_intent_type("bugfix"));
        assert!(!is_canonical_intent_type(""));
    }

    #[test]
    fn case_and_space_are_typos_not_classifications() {
        // Somebody who typed `--type bugfix` filed the entry. Refusing it
        // would leave the row untyped, which is the state this whole change
        // exists to reduce.
        assert_eq!(canonicalize_intent_type("bugfix"), Some("BugFix"));
        assert_eq!(canonicalize_intent_type("BUGFIX"), Some("BugFix"));
        assert_eq!(canonicalize_intent_type("  Refactor \n"), Some("Refactor"));
        for t in CANONICAL_INTENT_TYPES {
            assert_eq!(canonicalize_intent_type(t), Some(*t));
        }
    }

    #[test]
    fn a_type_outside_the_set_stays_outside_it() {
        // `UXChange` and `ProductFix` are the two that actually got into
        // this repo's log through the unvalidated CLI path. Widening the
        // enum to admit them would fragment every histogram that reads it.
        for bad in ["UXChange", "ProductFix", "BugFx", "Chore", "Test", ""] {
            assert_eq!(canonicalize_intent_type(bad), None, "{bad} should not canonicalize");
        }
    }

    #[test]
    fn the_rejection_message_names_the_alternatives() {
        // A message that only says "invalid" leaves the caller guessing at
        // a closed set of seven they cannot see.
        let msg = invalid_intent_type_message(" UXChange ");
        assert!(msg.contains("'UXChange'"), "{msg}");
        for t in CANONICAL_INTENT_TYPES {
            assert!(msg.contains(t), "{msg} should name {t}");
        }
    }

    #[test]
    fn parse_reads_the_guards_source_off_the_changeset() {
        // The shape `agent_mutation_guard` writes: the tag lives inside the
        // changeset, not at the top level. Nothing read it for a long time,
        // which is how a line Aura's own model wrote from the diff came to be
        // compared against that diff and reported as "aligned".
        let line = r#"{"agent_id":"a","intent":"tightened retries","timestamp":100,"changeset":{"files":[],"source":"brain_inferred"}}"#;
        let r = parse_intent_line(line).unwrap();
        assert_eq!(r.source.as_deref(), Some("brain_inferred"));
    }

    #[test]
    fn a_stated_reason_has_no_source() {
        let line = r#"{"agent_id":"a","intent":"x","timestamp":100,"changeset":{"files":[]}}"#;
        assert_eq!(parse_intent_line(line).unwrap().source, None);
        let bare = r#"{"agent_id":"a","intent":"x","timestamp":100}"#;
        assert_eq!(parse_intent_line(bare).unwrap().source, None);
    }

    #[test]
    fn source_survives_a_round_trip_through_to_json() {
        // `meta_bundle` re-emits rows through `to_json`; a row that loses its
        // source on the way out comes back looking like somebody stated it.
        let mut r = row(100, None, "x");
        r.source = Some("guard_auto_stub".into());
        let line = serde_json::to_string(&r.to_json()).unwrap();
        assert_eq!(
            parse_intent_line(&line).unwrap().source.as_deref(),
            Some("guard_auto_stub")
        );
    }

    #[test]
    fn parse_extracts_intent_type_when_present() {
        let line = r#"{"agent_id":"a","intent":"x","timestamp":100,"intent_type":"BugFix"}"#;
        let r = parse_intent_line(line).unwrap();
        assert_eq!(r.intent_type.as_deref(), Some("BugFix"));
        assert_eq!(r.timestamp, 100);
    }

    #[test]
    fn parse_handles_legacy_no_type_row() {
        let line = r#"{"agent_id":"a","intent":"x","timestamp":100}"#;
        let r = parse_intent_line(line).unwrap();
        assert_eq!(r.intent_type, None);
    }

    #[test]
    fn parse_skips_blank_and_invalid_lines() {
        assert!(parse_intent_line("").is_none());
        assert!(parse_intent_line("   ").is_none());
        assert!(parse_intent_line("not json").is_none());
        // Missing required intent field
        assert!(parse_intent_line(r#"{"agent_id":"a","timestamp":1}"#).is_none());
    }

    #[test]
    fn sample_line_survives_multibyte_at_the_cut() {
        // 76 ascii bytes then a 4-byte emoji: byte 77 is mid-codepoint, so the
        // old `truncate(77)` panicked here. The cut must walk back instead.
        let intent = format!("{}🚀🚀", "a".repeat(76));
        let s = sample_line(&intent);
        assert!(s.ends_with("..."));
        assert!(s.len() <= 80);

        // Pure CJK: every byte offset except multiples of 3 is mid-codepoint.
        let cjk = "语".repeat(40);
        let s = sample_line(&cjk);
        assert!(s.ends_with("..."));
    }

    #[test]
    fn sample_line_leaves_short_intents_alone() {
        assert_eq!(sample_line("héllo"), "héllo");
        // Exactly 80 bytes: untouched, no ellipsis.
        let exact = "a".repeat(80);
        assert_eq!(sample_line(&exact), exact);
    }

    #[test]
    fn query_filters_by_type() {
        let rows = vec![
            row(100, Some("BugFix"), "a"),
            row(101, Some("Refactor"), "b"),
            row(102, Some("BugFix"), "c"),
            row(103, None, "d"),
        ];
        let r = query_rows(rows, Some("BugFix"), 0, 100, 200);
        assert_eq!(r.total_matches, 2);
        assert_eq!(r.entries.len(), 2);
        // Sorted newest-first
        assert_eq!(r.entries[0].timestamp, 102);
        assert_eq!(r.entries[1].timestamp, 100);
    }

    #[test]
    fn query_window_drops_old_rows() {
        let now: u64 = 1_000_000;
        let rows = vec![
            row(now - 3600, None, "1h ago"),       // in window
            row(now - 7200, None, "2h ago"),       // in window
            row(now - 7200 - 1, None, "just out"), // out — > 2h ago
            row(now - 86400, None, "1d ago"),      // out
        ];
        let r = query_rows(rows, None, 2, 100, now);
        assert_eq!(r.total_matches, 2);
        assert_eq!(r.entries[0].intent, "1h ago");
        assert_eq!(r.entries[1].intent, "2h ago");
    }

    #[test]
    fn query_zero_window_disables_cutoff() {
        let rows = vec![
            row(1, None, "ancient"),
            row(0, None, "no-ts legacy"),
            row(9_000, None, "recent"),
        ];
        let r = query_rows(rows, None, 0, 100, 10_000);
        assert_eq!(r.total_matches, 3);
        // Newest-first ordering still applies.
        assert_eq!(r.entries[0].intent, "recent");
    }

    #[test]
    fn query_limit_caps_returned_but_total_unbounded() {
        let rows = (0..10).map(|i| row(100 + i, Some("Docs"), "x")).collect();
        let r = query_rows(rows, Some("Docs"), 0, 3, 200);
        assert_eq!(r.total_matches, 10);
        assert_eq!(r.entries.len(), 3);
        // Newest 3
        assert_eq!(r.entries[0].timestamp, 109);
        assert_eq!(r.entries[2].timestamp, 107);
    }

    #[test]
    fn query_window_keeps_legacy_zero_ts_only_when_cutoff_disabled() {
        // ts=0 row is legacy — should be filtered when a real window is
        // active so it doesn't pollute every "last N hours" query.
        let rows = vec![row(0, Some("BugFix"), "legacy"), row(9_500, Some("BugFix"), "fresh")];
        let r = query_rows(rows.clone(), Some("BugFix"), 1, 100, 10_000);
        assert_eq!(r.total_matches, 1);
        assert_eq!(r.entries[0].intent, "fresh");

        // With cutoff disabled (since_hours=0) the legacy row comes back.
        let r = query_rows(rows, Some("BugFix"), 0, 100, 10_000);
        assert_eq!(r.total_matches, 2);
    }

    #[test]
    fn read_all_rows_returns_empty_for_missing_file() {
        let p = Path::new("/nonexistent/path/intent_log.jsonl");
        assert!(read_all_rows(p).is_empty());
    }

    #[test]
    fn read_all_rows_parses_real_jsonl() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("intent_log.jsonl");
        let body = concat!(
            r#"{"agent_id":"a","intent":"one","timestamp":100,"intent_type":"BugFix"}"#,
            "\n",
            "\n", // blank line tolerated
            r#"{"agent_id":"b","intent":"two","timestamp":200}"#,
            "\n",
        );
        std::fs::write(&path, body).unwrap();
        let rows = read_all_rows(&path);
        assert_eq!(rows.len(), 2);
        assert_eq!(rows[0].intent_type.as_deref(), Some("BugFix"));
        assert_eq!(rows[1].intent_type, None);
    }

    #[test]
    fn narrate_typed_returns_none_for_missing_file() {
        let p = Path::new("/nonexistent/intent_log.jsonl");
        assert!(narrate_typed_intents_prose(p, 24, 1).is_none());
    }

    #[test]
    fn narrate_typed_returns_none_when_no_typed_rows() {
        // File exists, has rows, but none carry intent_type — caller
        // should suppress the section entirely rather than render
        // "0 typed across 0 type(s)".
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("intent_log.jsonl");
        let now = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_secs();
        let body = format!(
            r#"{{"agent_id":"a","intent":"untyped","timestamp":{}}}"#,
            now,
        );
        std::fs::write(&path, body).unwrap();
        assert!(narrate_typed_intents_prose(&path, 24, 1).is_none());
    }

    #[test]
    fn narrate_typed_groups_and_orders_by_count_then_name() {
        // 3 BugFix, 1 Refactor, 2 untyped. Expect BugFix first
        // (higher count), then Refactor.
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("intent_log.jsonl");
        let now = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_secs();
        let lines = vec![
            format!(r#"{{"agent_id":"a","intent":"fix1","timestamp":{},"intent_type":"BugFix"}}"#, now - 10),
            format!(r#"{{"agent_id":"a","intent":"fix2","timestamp":{},"intent_type":"BugFix"}}"#, now - 20),
            format!(r#"{{"agent_id":"a","intent":"fix3 newest","timestamp":{},"intent_type":"BugFix"}}"#, now),
            format!(r#"{{"agent_id":"a","intent":"ref1","timestamp":{},"intent_type":"Refactor"}}"#, now - 5),
            format!(r#"{{"agent_id":"a","intent":"untyped1","timestamp":{}}}"#, now - 30),
            format!(r#"{{"agent_id":"a","intent":"untyped2","timestamp":{}}}"#, now - 40),
        ];
        std::fs::write(&path, lines.join("\n")).unwrap();

        let prose = narrate_typed_intents_prose(&path, 24, 1).expect("expected typed prose");
        // Header line accuracy
        assert!(prose.contains("4 typed across 2 type(s); 2 untyped"), "header: {}", prose);
        // BugFix appears before Refactor (by count)
        let bug_idx = prose.find("BugFix").expect("BugFix in prose");
        let ref_idx = prose.find("Refactor").expect("Refactor in prose");
        assert!(bug_idx < ref_idx, "BugFix must appear before Refactor:\n{}", prose);
        // Counts present
        assert!(prose.contains("BugFix ×3"));
        assert!(prose.contains("Refactor ×1"));
        // Sample is the newest BugFix intent
        assert!(prose.contains("fix3 newest"), "sample missing: {}", prose);
    }

    #[test]
    fn narrate_typed_window_filter_drops_old_typed_rows() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("intent_log.jsonl");
        let now = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_secs();
        // One typed row 2 days ago — outside a 24h window — and zero
        // typed rows in the window.
        let body = format!(
            r#"{{"agent_id":"a","intent":"old","timestamp":{},"intent_type":"BugFix"}}"#,
            now.saturating_sub(2 * 86400),
        );
        std::fs::write(&path, body).unwrap();
        assert!(narrate_typed_intents_prose(&path, 24, 1).is_none());
    }

    #[test]
    fn query_rows_breaks_timestamp_ties_by_newest_on_disk() {
        // Rapid log_intent calls land in the same `as_secs()` bucket,
        // so the tiebreaker has to resolve to "later in file wins" or
        // the "newest sample" surfaced by build_typed_intent_summary
        // would be the OLDEST same-second entry — exactly the bug
        // S2-TIS hit in e2e.
        let rows = vec![
            row(100, Some("BugFix"), "first written"),
            row(100, Some("BugFix"), "second written"),
            row(100, Some("BugFix"), "third written"),
        ];
        let q = query_rows(rows, Some("BugFix"), 0, 10, 200);
        assert_eq!(q.entries.len(), 3);
        assert_eq!(q.entries[0].intent, "third written");
        assert_eq!(q.entries[1].intent, "second written");
        assert_eq!(q.entries[2].intent, "first written");
    }

    #[test]
    fn build_typed_intent_summary_carries_buckets_and_counts() {
        // S2-TIS: structured summary must mirror the prose form's
        // bucketing and ordering. Same fixture as the prose test so the
        // two renderers stay in lockstep.
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("intent_log.jsonl");
        let now = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_secs();
        let lines = vec![
            format!(r#"{{"agent_id":"a","intent":"fix1","timestamp":{},"intent_type":"BugFix"}}"#, now - 10),
            format!(r#"{{"agent_id":"a","intent":"fix2","timestamp":{},"intent_type":"BugFix"}}"#, now - 20),
            format!(r#"{{"agent_id":"a","intent":"fix3 newest","timestamp":{},"intent_type":"BugFix"}}"#, now),
            format!(r#"{{"agent_id":"a","intent":"ref1","timestamp":{},"intent_type":"Refactor"}}"#, now - 5),
            format!(r#"{{"agent_id":"a","intent":"untyped1","timestamp":{}}}"#, now - 30),
        ];
        std::fs::write(&path, lines.join("\n")).unwrap();
        let summary = build_typed_intent_summary(&path, 24, 2).expect("Some");
        assert_eq!(summary.typed_total, 4);
        assert_eq!(summary.untyped, 1);
        assert_eq!(summary.buckets.len(), 2);
        assert_eq!(summary.buckets[0].intent_type, "BugFix");
        assert_eq!(summary.buckets[0].count, 3);
        assert_eq!(summary.buckets[0].samples.len(), 2);
        assert_eq!(summary.buckets[0].samples[0], "fix3 newest");
        assert_eq!(summary.buckets[1].intent_type, "Refactor");
        assert_eq!(summary.buckets[1].count, 1);
        // JSON envelope shape
        let v = summary.to_json();
        assert_eq!(v["typed_total"], 4);
        assert_eq!(v["untyped"], 1);
        assert_eq!(v["type_count"], 2);
        assert_eq!(v["buckets"][0]["intent_type"], "BugFix");
        assert_eq!(v["buckets"][0]["count"], 3);
        assert_eq!(v["buckets"][0]["samples"][0], "fix3 newest");
    }

    #[test]
    fn build_typed_intent_summary_returns_none_when_only_untyped() {
        // Same suppression contract as the prose form: no typed rows in
        // the window → None so callers can skip the section entirely.
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("intent_log.jsonl");
        let now = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_secs();
        let body = format!(
            r#"{{"agent_id":"a","intent":"untyped only","timestamp":{}}}"#,
            now,
        );
        std::fs::write(&path, body).unwrap();
        assert!(build_typed_intent_summary(&path, 24, 1).is_none());
    }

    #[test]
    fn intent_query_result_to_json_shape() {
        let r = IntentQueryResult {
            since_hours: 24,
            intent_type: Some("BugFix".into()),
            total_matches: 1,
            entries: vec![row(100, Some("BugFix"), "fix")],
        };
        let v = r.to_json();
        assert_eq!(v["since_hours"], 24);
        assert_eq!(v["total_matches"], 1);
        assert_eq!(v["returned"], 1);
        assert_eq!(v["intent_type"], "BugFix");
        assert_eq!(v["entries"][0]["intent_type"], "BugFix");
    }
}
