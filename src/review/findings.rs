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
        }
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
        });
    }
    out
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
            }
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
        } else {
            merged.push(f);
        }
    }
    merged.sort_by(|a, b| b.severity.cmp(&a.severity));
    merged
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
