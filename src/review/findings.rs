//! The aggregated finding model shared by every reviewer.
//!
//! Aura's deterministic engine emits structured findings (invariant
//! violations, taste hits, blast radius); agent reviewers emit free text.
//! This module normalises both into one [`Finding`] shape, ranks them by
//! [`Severity`], and de-duplicates near-identical lines so a panel of
//! reviewers that all flag the same issue collapses to one row.

use serde::{Deserialize, Serialize};

/// How serious a finding is. Ordered: `Critical` is worst.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Serialize, Deserialize)]
pub enum Severity {
    Info,
    Advisory,
    Moderate,
    High,
    Critical,
}

impl Severity {
    pub fn label(&self) -> &'static str {
        match self {
            Severity::Critical => "CRITICAL",
            Severity::High => "HIGH",
            Severity::Moderate => "MODERATE",
            Severity::Advisory => "ADVISORY",
            Severity::Info => "INFO",
        }
    }

    /// Map an explicit severity word (from a structured JSON finding) onto the
    /// engine's 5-level scale. The specialist prompts emit
    /// `critical|high|medium|low|nit`; older agents may say `moderate`/`advisory`.
    pub fn from_label(s: &str) -> Severity {
        match s.trim().to_ascii_lowercase().as_str() {
            "critical" | "crit" | "blocker" => Severity::Critical,
            "high" | "major" => Severity::High,
            "medium" | "moderate" | "warn" | "warning" => Severity::Moderate,
            "low" | "minor" | "advisory" => Severity::Advisory,
            "nit" | "nitpick" | "info" | "trivial" | "style" => Severity::Info,
            _ => Severity::Moderate,
        }
    }

    /// Best-effort severity from a free-text reviewer line.
    pub fn from_text(line: &str) -> Severity {
        let l = line.to_ascii_lowercase();
        if l.contains("critical") || l.contains("vulnerab") || l.contains("security")
            || l.contains("data loss") || l.contains("must fix")
        {
            Severity::Critical
        } else if l.contains("bug") || l.contains("error") || l.contains("incorrect")
            || l.contains("broken") || l.contains("race") || l.contains("panic")
        {
            Severity::High
        } else if l.contains("should") || l.contains("consider") || l.contains("warning") {
            Severity::Moderate
        } else if l.contains("nit") || l.contains("style") || l.contains("typo") {
            Severity::Advisory
        } else {
            Severity::Moderate
        }
    }
}

/// One normalised review finding.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Finding {
    /// Which reviewer produced it ("aura", "claude", "gemini", …).
    pub source: String,
    pub severity: Severity,
    /// One-line human-readable summary.
    pub title: String,
    /// Optional file the finding points at.
    pub file: Option<String>,
    /// 1-based line in the file's NEW (post-change) side the finding anchors
    /// to. For a multi-line span this is the LAST line. Drives inline GitHub
    /// review comments; `None` keeps the finding file-level / summary-only.
    #[serde(default)]
    pub line: Option<u32>,
    /// 1-based FIRST line of a multi-line anchor (`line` is the last). `None`
    /// → single-line comment at `line`.
    #[serde(default)]
    pub start_line: Option<u32>,
    /// Diff side the anchor refers to: "RIGHT" (added/context lines, the
    /// default for inline comments) or "LEFT" (removed). `None` when there is
    /// no line anchor.
    #[serde(default)]
    pub side: Option<String>,
    /// Which specialist pass raised it ("security", "performance", …). `None`
    /// for the deterministic engine's own findings and legacy line-parsed ones.
    #[serde(default)]
    pub dimension: Option<String>,
    /// The reviewer's self-reported probability (0–1) that this is a true
    /// positive, adjusted by the verifier. Drives the keep/drop threshold and
    /// the display order within a severity band.
    #[serde(default)]
    pub confidence: Option<f32>,
    /// Why it's wrong + the concrete trigger scenario (the structured
    /// `rationale` from a JSON finding). Posted as the inline comment body.
    #[serde(default)]
    pub rationale: Option<String>,
    /// The minimal suggested fix, when the reviewer was confident enough to
    /// offer one. Rendered as a GitHub ```suggestion block downstream.
    #[serde(default)]
    pub suggestion: Option<String>,
    /// How many independent reviewers flagged the same issue (1 = a single
    /// pass). Bumped during [`aggregate`]; a higher count is corroboration.
    #[serde(default = "one")]
    pub agreement: u8,
}

/// serde default for `agreement` — a fresh finding was seen exactly once.
fn one() -> u8 {
    1
}

impl Finding {
    pub fn new(source: &str, severity: Severity, title: impl Into<String>) -> Self {
        Self {
            source: source.to_string(),
            severity,
            title: title.into(),
            file: None,
            line: None,
            start_line: None,
            side: None,
            dimension: None,
            confidence: None,
            rationale: None,
            suggestion: None,
            agreement: 1,
        }
    }

    /// Tag the specialist dimension that raised this finding (builder).
    pub fn with_dimension(mut self, dim: impl Into<String>) -> Self {
        self.dimension = Some(dim.into());
        self
    }

    /// Anchor this finding to an exact 1-based line span on the new side of the
    /// diff — the deterministic path Aura's engine uses (an `AstNode` carries
    /// `start_line`/`end_line`, so its findings can be line-anchored with no
    /// LLM). A single-line span (`start == end`) drops `start_line`.
    pub fn with_span(mut self, file: impl Into<String>, start: u32, end: u32) -> Self {
        self.file = Some(file.into());
        let (sl, ln, side) = anchor_fields(Some(start), Some(end));
        self.start_line = sl;
        self.line = ln;
        self.side = side;
        self
    }

    /// Anchor to a single 1-based line.
    pub fn with_line(self, file: impl Into<String>, line: u32) -> Self {
        self.with_span(file, line, line)
    }

    /// Build a finding from a deterministic-engine line, lifting any trailing
    /// `(path:line)` / `(path:start-end)` location the engine appended into a
    /// real anchor. Aura's engine knows the exact `AstNode` span of every
    /// changed symbol, so its findings can be line-anchored with no LLM.
    pub fn from_engine(source: &str, severity: Severity, text: impl Into<String>) -> Self {
        let text = text.into();
        let (file, start, end) = extract_anchor(&text);
        let (start_line, line, side) = anchor_fields(start, end);
        Self {
            source: source.to_string(),
            severity,
            title: clip(&text, 200),
            file,
            line,
            start_line,
            side,
            dimension: None,
            confidence: None,
            rationale: None,
            suggestion: None,
            agreement: 1,
        }
    }

    /// Key used to collapse duplicate findings across reviewers.
    fn dedup_key(&self) -> String {
        normalize(&self.title)
    }
}

/// Strip a reviewer line to its semantic core for de-duplication.
fn normalize(s: &str) -> String {
    s.chars()
        .filter(|c| c.is_ascii_alphanumeric() || c.is_whitespace())
        .collect::<String>()
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ")
        .to_ascii_lowercase()
}

/// Parse an agent reviewer's free-text output into findings.
///
/// Accepts the common shapes agents emit: markdown bullets (`- …`,
/// `* …`), numbered lists (`1. …`), and `SEVERITY: …` prefixes. Lines
/// that are clearly prose (headings, empty, fences) are dropped.
pub fn parse_agent_output(source: &str, text: &str) -> Vec<Finding> {
    let mut out = Vec::new();
    for raw in text.lines() {
        let line = raw.trim();
        if line.is_empty() || line.starts_with("```") || line.starts_with('#') {
            continue;
        }
        let body = strip_bullet(line);
        if body.len() < 6 {
            continue;
        }
        // Explicit "CRITICAL: …" / "HIGH - …" prefixes win over heuristics.
        let (sev, title) = split_severity_prefix(body).unwrap_or_else(|| {
            (Severity::from_text(body), body.to_string())
        });
        let (file, start, end) = extract_anchor(&title);
        let (start_line, line, side) = anchor_fields(start, end);
        out.push(Finding {
            source: source.to_string(),
            severity: sev,
            file,
            title: clip(&title, 200),
            line,
            start_line,
            side,
            dimension: None,
            confidence: None,
            rationale: None,
            suggestion: None,
            agreement: 1,
        });
    }
    out
}

/// One finding as a specialist emits it in the structured JSON contract (see
/// [`super::dimensions::build_prompt`]). Every field but `file`/`line`/`title`
/// is optional, so a terse reviewer still parses.
#[derive(Debug, Deserialize)]
struct JsonFinding {
    #[serde(default)]
    file: Option<String>,
    #[serde(default)]
    line: Option<u32>,
    #[serde(default)]
    start_line: Option<u32>,
    #[serde(default)]
    quoted_line: Option<String>,
    #[serde(default)]
    severity: Option<String>,
    #[serde(default)]
    confidence: Option<f32>,
    #[serde(default)]
    title: Option<String>,
    #[serde(default)]
    rationale: Option<String>,
    #[serde(default)]
    suggested_fix: Option<String>,
}

#[derive(Debug, Deserialize)]
struct JsonFindings {
    findings: Vec<JsonFinding>,
}

/// Parse a specialist's structured-JSON output into findings, tagged with the
/// `dimension` that produced them.
///
/// Agents wrap their JSON in stray prose or a ```json fence, so we locate the
/// first balanced `{...}` object that contains a `"findings"` key and parse
/// that. If no such object is present (a misbehaving agent emitted bullets
/// instead), we fall back to the line-based [`parse_agent_output`] so a useful
/// reviewer is never silently dropped.
pub fn parse_json_findings(source: &str, dimension: &str, text: &str) -> Vec<Finding> {
    let Some(block) = extract_json_block(text) else {
        return parse_agent_output(source, text)
            .into_iter()
            .map(|f| f.with_dimension(dimension))
            .collect();
    };
    let parsed: JsonFindings = match serde_json::from_str(&block) {
        Ok(p) => p,
        Err(_) => {
            return parse_agent_output(source, text)
                .into_iter()
                .map(|f| f.with_dimension(dimension))
                .collect()
        }
    };

    let mut out = Vec::new();
    for jf in parsed.findings {
        let title = jf
            .title
            .as_deref()
            .map(str::trim)
            .filter(|t| !t.is_empty())
            .map(|t| clip(t, 200))
            .unwrap_or_else(|| {
                // No title — synthesise one from the rationale's first clause.
                jf.rationale
                    .as_deref()
                    .map(|r| clip(r, 120))
                    .unwrap_or_else(|| "finding".to_string())
            });
        let severity = jf
            .severity
            .as_deref()
            .map(Severity::from_label)
            .unwrap_or(Severity::Moderate);

        // Anchor: trust an explicit numeric line over text-scraping. A
        // start/end pair becomes a span; a lone line is single-line.
        let (start_line, line, side) = match (jf.start_line, jf.line) {
            (Some(s), Some(e)) => anchor_fields(Some(s), Some(e)),
            (None, Some(e)) => anchor_fields(Some(e), Some(e)),
            _ => (None, None, None),
        };
        let file = jf.file.map(|f| f.trim().to_string()).filter(|f| !f.is_empty());

        out.push(Finding {
            source: source.to_string(),
            severity,
            title,
            file,
            line,
            start_line,
            side,
            dimension: Some(dimension.to_string()),
            confidence: jf.confidence.map(|c| c.clamp(0.0, 1.0)),
            rationale: jf.rationale.map(|r| clip(&r, 600)).filter(|r| !r.is_empty()),
            suggestion: jf
                .suggested_fix
                .map(|s| clip(&s, 600))
                .filter(|s| !s.is_empty()),
            agreement: 1,
        });
        // `quoted_line` is advisory context; the numeric anchor drives posting.
        let _ = &jf.quoted_line;
    }
    out
}

/// Find the first balanced `{...}` substring that mentions `"findings"`.
/// Brace-counts so a nested object inside a rationale doesn't end it early;
/// ignores braces inside double-quoted strings (with escape handling).
fn extract_json_block(text: &str) -> Option<String> {
    let bytes = text.as_bytes();
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] == b'{' {
            if let Some(end) = balanced_end(bytes, i) {
                let slice = &text[i..=end];
                if slice.contains("\"findings\"") {
                    return Some(slice.to_string());
                }
                i = end + 1;
                continue;
            }
        }
        i += 1;
    }
    None
}

/// Index of the `}` that closes the `{` at `open`, or `None` if unbalanced.
fn balanced_end(bytes: &[u8], open: usize) -> Option<usize> {
    let mut depth = 0i32;
    let mut in_str = false;
    let mut escaped = false;
    let mut i = open;
    while i < bytes.len() {
        let c = bytes[i];
        if in_str {
            if escaped {
                escaped = false;
            } else if c == b'\\' {
                escaped = true;
            } else if c == b'"' {
                in_str = false;
            }
        } else {
            match c {
                b'"' => in_str = true,
                b'{' => depth += 1,
                b'}' => {
                    depth -= 1;
                    if depth == 0 {
                        return Some(i);
                    }
                }
                _ => {}
            }
        }
        i += 1;
    }
    None
}

/// Drop a leading list marker (`- `, `* `, `1. `, `2) `) from a line.
fn strip_bullet(line: &str) -> &str {
    let t = line.trim_start_matches(['-', '*', '•']).trim_start();
    // numbered: "12. foo" / "3) foo"
    if let Some(pos) = t.find(['.', ')']) {
        if pos <= 3 && t[..pos].chars().all(|c| c.is_ascii_digit()) {
            return t[pos + 1..].trim_start();
        }
    }
    t
}

/// Recognise an explicit `SEVERITY:` / `SEVERITY -` prefix.
fn split_severity_prefix(body: &str) -> Option<(Severity, String)> {
    let upper_head: String = body.chars().take_while(|c| c.is_ascii_alphabetic()).collect();
    let sev = match upper_head.to_ascii_uppercase().as_str() {
        "CRITICAL" => Severity::Critical,
        "HIGH" => Severity::High,
        "MODERATE" | "MEDIUM" | "WARN" | "WARNING" => Severity::Moderate,
        "LOW" | "NIT" | "STYLE" | "ADVISORY" => Severity::Advisory,
        "INFO" => Severity::Info,
        _ => return None,
    };
    let rest = body[upper_head.len()..].trim_start_matches([':', '-', ' ']).trim();
    if rest.is_empty() {
        None
    } else {
        Some((sev, rest.to_string()))
    }
}

/// Pull a file anchor out of a finding title. Recognises three shapes a
/// reviewer (human or agent) commonly writes:
///   * `path/to/file.ext:42`        → single line
///   * `path/to/file.ext:42-50`     → a line span
///   * `path/to/file.ext`           → file only, no line
/// Returns `(file, start_line, end_line)` with `start == end` for a single
/// line and `None` lines for the file-only case. The `:line` suffix is what
/// turns a finding into an inline GitHub comment downstream.
fn extract_anchor(title: &str) -> (Option<String>, Option<u32>, Option<u32>) {
    for raw in title.split_whitespace() {
        // Strip wrapping backticks/quotes/parens and any trailing sentence
        // punctuation, but NOT a ':' — that delimits the line suffix.
        let tok = raw.trim_matches(|c: char| matches!(c, '`' | '"' | '\'' | '(' | ')' | ',' | ';' | '.'));
        if tok.is_empty() {
            continue;
        }
        // Try `path:line` / `path:start-end` first — the colon is the strong
        // signal, so we can accept a path with no '/' (e.g. `Cargo.toml:3`).
        if let Some((path, spec)) = tok.rsplit_once(':') {
            if looks_like_path(path) {
                if let Some((s, e)) = parse_line_spec(spec) {
                    return (Some(path.to_string()), Some(s), Some(e));
                }
            }
        }
        // File-only fallback: require a '/' so we don't grab `parse()` or a
        // bare `0.24.0` version string. Strip a trailing ':' left by a
        // `path: reason` prose form (e.g. taste findings).
        let bare = tok.trim_end_matches(':');
        if bare.contains('/') && looks_like_path(bare) {
            return (Some(bare.to_string()), None, None);
        }
    }
    (None, None, None)
}

/// A token that plausibly names a source file: has an extension dot, no
/// whitespace, and at least one path/name char before the dot.
fn looks_like_path(tok: &str) -> bool {
    !tok.is_empty()
        && !tok.contains(char::is_whitespace)
        && tok.contains('.')
        && !tok.ends_with('.')
        && tok.chars().all(|c| c.is_ascii_graphic())
}

/// Parse the `:` suffix: a single line `42` or an inclusive span `42-50`.
/// 1-based; `0` and reversed/garbage specs are rejected (returns `None`).
fn parse_line_spec(spec: &str) -> Option<(u32, u32)> {
    if let Some((a, b)) = spec.split_once('-') {
        let a: u32 = a.parse().ok()?;
        let b: u32 = b.parse().ok()?;
        if a == 0 || b == 0 {
            return None;
        }
        Some((a.min(b), a.max(b)))
    } else {
        let n: u32 = spec.parse().ok()?;
        (n != 0).then_some((n, n))
    }
}

/// Collapse an (optional) `start`/`end` span into the GitHub-comment triple
/// `(start_line, line, side)`. A single-line span drops `start_line`; absence
/// of an end line yields no anchor at all. Inline comments target the new
/// ("RIGHT") side of the diff.
fn anchor_fields(start: Option<u32>, end: Option<u32>) -> (Option<u32>, Option<u32>, Option<String>) {
    match (start, end) {
        (Some(s), Some(e)) if s < e => (Some(s), Some(e), Some("RIGHT".to_string())),
        (_, Some(e)) => (None, Some(e), Some("RIGHT".to_string())),
        _ => (None, None, None),
    }
}

fn clip(s: &str, n: usize) -> String {
    if s.chars().count() <= n {
        s.to_string()
    } else {
        let mut out: String = s.chars().take(n.saturating_sub(1)).collect();
        out.push('…');
        out
    }
}

/// Merge findings from all reviewers: collapse duplicates (keeping the
/// highest severity and recording every reviewer that flagged it), then
/// sort worst-first.
pub fn aggregate(mut all: Vec<Finding>) -> Vec<Finding> {
    // Stable order in, so dedup keeps the first-seen title casing.
    let mut merged: Vec<Finding> = Vec::new();
    for f in all.drain(..) {
        let key = f.dedup_key();
        if let Some(existing) = merged.iter_mut().find(|e| e.dedup_key() == key) {
            if f.severity > existing.severity {
                existing.severity = f.severity;
            }
            if !existing.source.split(", ").any(|s| s == f.source) {
                existing.source = format!("{}, {}", existing.source, f.source);
                // Two independent reviewers on the same issue is corroboration.
                existing.agreement = existing.agreement.saturating_add(1);
                // Keep the higher confidence — corroboration raises trust.
                existing.confidence = max_opt(existing.confidence, f.confidence);
            }
            // Record every distinct specialist that flagged it.
            existing.dimension = merge_dimension(existing.dimension.take(), f.dimension);
            // Adopt the first concrete line anchor any reviewer supplies — a
            // line-anchored duplicate is strictly more useful than a
            // file-level or anchorless one for posting an inline comment.
            if existing.line.is_none() && f.line.is_some() {
                existing.line = f.line;
                existing.start_line = f.start_line;
                existing.side = f.side;
                if existing.file.is_none() {
                    existing.file = f.file;
                }
            } else if existing.file.is_none() {
                existing.file = f.file;
            }
            // Keep the richer rationale / suggestion if we didn't have one.
            if existing.rationale.is_none() {
                existing.rationale = f.rationale;
            }
            if existing.suggestion.is_none() {
                existing.suggestion = f.suggestion;
            }
        } else {
            merged.push(f);
        }
    }
    // Sort worst-first, then by corroboration, then by confidence — so the most
    // serious, most-agreed, most-confident findings lead.
    merged.sort_by(|a, b| {
        b.severity
            .cmp(&a.severity)
            .then(b.agreement.cmp(&a.agreement))
            .then(
                b.confidence
                    .unwrap_or(0.0)
                    .partial_cmp(&a.confidence.unwrap_or(0.0))
                    .unwrap_or(std::cmp::Ordering::Equal),
            )
    });
    merged
}

/// The larger of two optional confidences (either-or when one is absent).
fn max_opt(a: Option<f32>, b: Option<f32>) -> Option<f32> {
    match (a, b) {
        (Some(x), Some(y)) => Some(x.max(y)),
        (x, None) => x,
        (None, y) => y,
    }
}

/// Union two comma-joined dimension tags without duplicates.
fn merge_dimension(a: Option<String>, b: Option<String>) -> Option<String> {
    match (a, b) {
        (Some(x), Some(y)) => {
            if x.split(", ").any(|d| d == y) {
                Some(x)
            } else {
                Some(format!("{x}, {y}"))
            }
        }
        (x, None) => x,
        (None, y) => y,
    }
}

/// True when a path points at non-production code (tests, fixtures, mocks,
/// examples, generated). A serious finding here is far less urgent than the
/// same one on a live path, so calibration downgrades it.
fn is_non_prod_path(path: &str) -> bool {
    let p = path.to_ascii_lowercase();
    p.contains("/test")
        || p.contains("test/")
        || p.ends_with("_test.rs")
        || p.ends_with(".test.ts")
        || p.ends_with(".test.tsx")
        || p.ends_with(".spec.ts")
        || p.ends_with(".spec.tsx")
        || p.contains("/tests/")
        || p.contains("/__tests__/")
        || p.contains("fixture")
        || p.contains("/mocks/")
        || p.contains("__mocks__")
        || p.contains("/examples/")
        || p.ends_with(".snap")
}

/// True when a path is on a security-/safety-critical surface, where a finding
/// deserves a severity *bump* rather than a downgrade.
fn is_critical_path(path: &str) -> bool {
    let p = path.to_ascii_lowercase();
    p.contains("auth")
        || p.contains("login")
        || p.contains("session")
        || p.contains("token")
        || p.contains("secret")
        || p.contains("crypt")
        || p.contains("password")
        || p.contains("payment")
        || p.contains("billing")
        || p.contains("permission")
}

fn downgrade(s: Severity) -> Severity {
    match s {
        Severity::Critical => Severity::High,
        Severity::High => Severity::Moderate,
        Severity::Moderate => Severity::Advisory,
        Severity::Advisory => Severity::Info,
        Severity::Info => Severity::Info,
    }
}

fn upgrade(s: Severity) -> Severity {
    match s {
        Severity::Info => Severity::Advisory,
        Severity::Advisory => Severity::Moderate,
        Severity::Moderate => Severity::High,
        Severity::High => Severity::Critical,
        Severity::Critical => Severity::Critical,
    }
}

/// Calibrate severity by context: a finding in test/fixture/example code drops
/// one level (it can't break production); a finding on an auth/crypto/payment
/// path climbs one (blast radius). Engine findings (no `file`) pass through.
/// Returns the calibrated, re-sorted list.
pub fn calibrate(findings: Vec<Finding>) -> Vec<Finding> {
    let mut out: Vec<Finding> = findings
        .into_iter()
        .map(|mut f| {
            if let Some(path) = f.file.clone() {
                if is_non_prod_path(&path) {
                    f.severity = downgrade(f.severity);
                } else if is_critical_path(&path) && f.severity < Severity::Critical {
                    f.severity = upgrade(f.severity);
                }
            }
            f
        })
        .collect();
    out.sort_by(|a, b| {
        b.severity
            .cmp(&a.severity)
            .then(b.agreement.cmp(&a.agreement))
            .then(
                b.confidence
                    .unwrap_or(0.0)
                    .partial_cmp(&a.confidence.unwrap_or(0.0))
                    .unwrap_or(std::cmp::Ordering::Equal),
            )
    });
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_bullets_and_numbers() {
        let text = "- The retry loop never backs off\n2. Missing null check in parse()\n";
        let f = parse_agent_output("claude", text);
        assert_eq!(f.len(), 2);
        assert_eq!(f[0].title, "The retry loop never backs off");
        assert_eq!(f[1].title, "Missing null check in parse()");
    }

    #[test]
    fn explicit_severity_prefix_wins() {
        let f = parse_agent_output("gemini", "CRITICAL: SQL injection in user query");
        assert_eq!(f[0].severity, Severity::Critical);
        assert_eq!(f[0].title, "SQL injection in user query");
    }

    #[test]
    fn drops_headings_and_fences() {
        let f = parse_agent_output("codex", "# Review\n```\ncode\n```\n- real finding here");
        assert_eq!(f.len(), 1);
        assert_eq!(f[0].title, "real finding here");
    }

    #[test]
    fn aggregate_dedups_and_keeps_sources() {
        let a = Finding::new("aura", Severity::Moderate, "Missing null check in parse");
        let b = Finding::new("claude", Severity::High, "missing null check in  parse!");
        let merged = aggregate(vec![a, b]);
        assert_eq!(merged.len(), 1);
        assert_eq!(merged[0].severity, Severity::High);
        assert!(merged[0].source.contains("aura"));
        assert!(merged[0].source.contains("claude"));
    }

    #[test]
    fn aggregate_sorts_worst_first() {
        let merged = aggregate(vec![
            Finding::new("a", Severity::Advisory, "nit one"),
            Finding::new("b", Severity::Critical, "boom"),
            Finding::new("c", Severity::Moderate, "meh"),
        ]);
        assert_eq!(merged[0].severity, Severity::Critical);
        assert_eq!(merged[2].severity, Severity::Advisory);
    }

    #[test]
    fn extracts_file_token() {
        let (file, s, e) = extract_anchor("Bug in src/auth/login.rs near line 40");
        assert_eq!(file.as_deref(), Some("src/auth/login.rs"));
        // "line 40" is prose, not a `file:line` token — no anchor.
        assert_eq!((s, e), (None, None));
    }

    #[test]
    fn extracts_single_line_anchor() {
        let (file, s, e) = extract_anchor("Null deref at src/auth/login.rs:42 on the token path");
        assert_eq!(file.as_deref(), Some("src/auth/login.rs"));
        assert_eq!((s, e), (Some(42), Some(42)));
    }

    #[test]
    fn extracts_line_span_anchor() {
        let (file, s, e) = extract_anchor("Unchecked loop `src/net/retry.rs:88-94`");
        assert_eq!(file.as_deref(), Some("src/net/retry.rs"));
        assert_eq!((s, e), (Some(88), Some(94)));
    }

    #[test]
    fn anchor_token_allows_bare_filename_with_line() {
        // No '/', but the `:line` suffix is a strong enough signal.
        let (file, s, e) = extract_anchor("Cargo.toml:3 pins the wrong version");
        assert_eq!(file.as_deref(), Some("Cargo.toml"));
        assert_eq!((s, e), (Some(3), Some(3)));
    }

    #[test]
    fn version_string_is_not_an_anchor() {
        // `0.24.0` has dots but no '/', and no `:line` — must not be a file.
        let (file, _, _) = extract_anchor("Bump tree-sitter to 0.24.0 for parity");
        assert_eq!(file, None);
    }

    #[test]
    fn parse_agent_output_threads_anchor_into_finding() {
        let f = parse_agent_output("claude", "- HIGH: race in src/sync/loop.rs:120-130 drops events");
        assert_eq!(f.len(), 1);
        assert_eq!(f[0].file.as_deref(), Some("src/sync/loop.rs"));
        assert_eq!(f[0].start_line, Some(120));
        assert_eq!(f[0].line, Some(130));
        assert_eq!(f[0].side.as_deref(), Some("RIGHT"));
    }

    #[test]
    fn with_span_single_line_drops_start() {
        let f = Finding::new("aura", Severity::High, "stub left in place").with_line("src/a.rs", 7);
        assert_eq!(f.file.as_deref(), Some("src/a.rs"));
        assert_eq!(f.line, Some(7));
        assert_eq!(f.start_line, None);
        assert_eq!(f.side.as_deref(), Some("RIGHT"));
    }

    #[test]
    fn aggregate_adopts_line_anchor_from_any_reviewer() {
        // Same issue: aura flags it file-level, claude pins the exact line.
        let a = Finding::new("aura", Severity::Moderate, "missing null check in parse");
        let b = Finding::new("claude", Severity::High, "Missing null check in parse")
            .with_line("src/p.rs", 12);
        let merged = aggregate(vec![a, b]);
        assert_eq!(merged.len(), 1);
        assert_eq!(merged[0].line, Some(12));
        assert_eq!(merged[0].file.as_deref(), Some("src/p.rs"));
    }
}
