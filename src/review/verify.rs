//! Adversarial verification — the false-positive cull.
//!
//! A panel of specialists biased toward recall will surface plenty of
//! plausible-but-wrong findings. Before any of them reach a human (or a GitHub
//! comment) we run a single fresh reviewer whose ONLY job is to *refute* each
//! claim: it re-reads the cited line against the diff and, defaulting to
//! skepticism, drops anything the change doesn't actually substantiate. This is
//! the precision half of the recall/precision split — the specialists cast a
//! wide net, the verifier tightens it.
//!
//! Verification is best-effort and never destructive: with no agent available,
//! or on any parse/timeout failure, every finding passes through unchanged. We
//! would rather show a false positive than silently swallow a real defect
//! because the verifier was flaky.

use std::time::Duration;

use serde::Deserialize;

use super::findings::{Finding, Severity};
use super::reviewer::run_agent_prompt;

/// The verifier's call on one finding.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Verdict {
    /// The diff clearly substantiates a real defect at the cited location.
    Confirmed,
    /// Could be real, but the diff doesn't fully prove it — keep, flagged.
    Plausible,
    /// False positive — not substantiated, misreads the code, hypothetical,
    /// or out of scope. Dropped.
    Refuted,
}

impl Verdict {
    fn parse(s: &str) -> Verdict {
        match s.trim().to_ascii_lowercase().as_str() {
            "confirmed" | "confirm" | "true" | "real" | "valid" | "verified" => Verdict::Confirmed,
            "refuted" | "refute" | "false" | "rejected" | "invalid" | "wrong" | "fp" => {
                Verdict::Refuted
            }
            // Unknown / "plausible" / "uncertain" → keep but don't claim proof.
            _ => Verdict::Plausible,
        }
    }
}

/// Bound the verifier prompt: verify at most the N most-severe candidates; any
/// remainder passes through kept-but-unverified rather than being dropped.
const MAX_VERIFY: usize = 40;

#[derive(Debug, Deserialize)]
struct JsonVerdict {
    index: usize,
    #[serde(default)]
    verdict: Option<String>,
    #[serde(default)]
    adjusted_severity: Option<String>,
    #[serde(default)]
    confidence: Option<f32>,
    #[serde(default)]
    reason: Option<String>,
}

#[derive(Debug, Deserialize)]
struct JsonVerdicts {
    verdicts: Vec<JsonVerdict>,
}

/// The result of a verify pass.
pub struct VerifyOutcome {
    /// The surviving findings (protected + confirmed/plausible), worst-first.
    pub findings: Vec<Finding>,
    /// How many candidate findings the verifier refuted and dropped.
    pub refuted: usize,
    /// How many it confirmed (the diff clearly substantiates them).
    pub confirmed: usize,
    /// Which agent verified, or `None` when the pass was skipped.
    pub verifier: Option<String>,
    /// A short human note when verification was skipped or only partial.
    pub note: Option<String>,
}

/// True when a finding is already ground truth and must not be culled: Aura's
/// deterministic engine produced (or corroborated) it. Engine findings carry no
/// `dimension`, and an engine-corroborated one lists "aura" among its sources.
fn is_protected(f: &Finding) -> bool {
    f.dimension.is_none() || f.source.split(", ").any(|s| s == "aura")
}

/// Run the adversarial verifier over aggregated findings.
///
/// LLM-specialist findings are partitioned from engine ground truth; only the
/// former are put to the verifier. Refuted ones are dropped; confirmed/plausible
/// ones survive (adopting the verifier's adjusted severity/confidence when it
/// offered one). Protected findings always pass through untouched. The returned
/// list is re-sorted worst-first.
pub fn verify(
    agent_id: Option<&str>,
    findings: Vec<Finding>,
    diff: &str,
    timeout: Duration,
) -> VerifyOutcome {
    // Split ground truth from the findings we're willing to cull.
    let (protected, candidates): (Vec<Finding>, Vec<Finding>) =
        findings.into_iter().partition(is_protected);

    let Some(agent_id) = agent_id else {
        return passthrough(protected, candidates, Some("no verifier agent configured"));
    };
    if candidates.is_empty() {
        return passthrough(protected, candidates, None);
    }

    // Verify the most-severe candidates first; keep any overflow unverified.
    let mut candidates = candidates;
    candidates.sort_by(|a, b| b.severity.cmp(&a.severity));
    let verify_n = candidates.len().min(MAX_VERIFY);
    let prompt = build_verify_prompt(&candidates[..verify_n], diff);

    let run = match run_agent_prompt(agent_id, &prompt, timeout) {
        Ok(r) => r,
        Err(reason) => {
            return passthrough(protected, candidates, Some(&format!("verifier skipped: {reason}")))
        }
    };
    let Some(verdicts) = parse_verdicts(&run.output) else {
        return passthrough(
            protected,
            candidates,
            Some("verifier output unparseable — findings kept unverified"),
        );
    };

    // Index → verdict. Findings the verifier didn't mention are kept as-is.
    let mut refuted = 0usize;
    let mut confirmed = 0usize;
    let mut kept: Vec<Finding> = protected;
    for (i, mut f) in candidates.into_iter().enumerate() {
        let Some(jv) = verdicts.iter().find(|v| v.index == i) else {
            // Unjudged (verifier forgot, or beyond verify_n) → keep, don't drop.
            kept.push(f);
            continue;
        };
        let verdict = jv.verdict.as_deref().map(Verdict::parse).unwrap_or(Verdict::Plausible);
        match verdict {
            Verdict::Refuted => {
                refuted += 1;
                continue;
            }
            Verdict::Confirmed => confirmed += 1,
            Verdict::Plausible => {}
        }
        // Adopt the verifier's recalibrated severity / confidence when present.
        if let Some(sev) = jv.adjusted_severity.as_deref() {
            f.severity = Severity::from_label(sev);
        }
        if let Some(c) = jv.confidence {
            f.confidence = Some(c.clamp(0.0, 1.0));
        }
        kept.push(f);
    }

    kept.sort_by(severity_then_strength);
    VerifyOutcome {
        findings: kept,
        refuted,
        confirmed,
        verifier: Some(agent_id.to_string()),
        note: None,
    }
}

/// Keep everything unchanged (verification skipped or unavailable).
fn passthrough(
    protected: Vec<Finding>,
    candidates: Vec<Finding>,
    note: Option<&str>,
) -> VerifyOutcome {
    let mut all = protected;
    all.extend(candidates);
    all.sort_by(severity_then_strength);
    VerifyOutcome {
        findings: all,
        refuted: 0,
        confirmed: 0,
        verifier: None,
        note: note.map(|s| s.to_string()),
    }
}

/// Worst-first, then most-corroborated, then most-confident.
fn severity_then_strength(a: &Finding, b: &Finding) -> std::cmp::Ordering {
    b.severity
        .cmp(&a.severity)
        .then(b.agreement.cmp(&a.agreement))
        .then(
            b.confidence
                .unwrap_or(0.0)
                .partial_cmp(&a.confidence.unwrap_or(0.0))
                .unwrap_or(std::cmp::Ordering::Equal),
        )
}

/// Compose the verifier prompt: the skeptic's charter + the numbered findings +
/// the diff, demanding a strict JSON verdict array back.
fn build_verify_prompt(findings: &[Finding], diff: &str) -> String {
    let mut list = String::new();
    for (i, f) in findings.iter().enumerate() {
        let loc = match (&f.file, f.line) {
            (Some(file), Some(line)) => format!("{file}:{line}"),
            (Some(file), None) => file.clone(),
            _ => "(no location)".to_string(),
        };
        let dim = f.dimension.as_deref().unwrap_or("review");
        list.push_str(&format!(
            "[{i}] ({sev}, {dim}) {loc} — {title}\n",
            sev = f.severity.label(),
            title = f.title,
        ));
        if let Some(r) = &f.rationale {
            list.push_str(&format!("    claim: {r}\n"));
        }
    }

    format!(
        "You are a staff engineer doing a SKEPTICAL second pass. Another panel of AI reviewers \
produced the findings below over the diff at the end. AI reviewers frequently hallucinate defects, \
misread which line does what, or flag correct code — your single job is to REFUTE each finding \
unless the diff itself clearly substantiates it.\n\
\n\
For EACH finding, judge it against the diff and assign a verdict:\n\
- \"confirmed\": the cited line, read in context, clearly contains the claimed defect; a concrete \
input or state would trigger the described failure.\n\
- \"plausible\": might be real, but the diff doesn't fully prove it (e.g. the triggering path isn't \
shown). Keep it, but it is not proven.\n\
- \"refuted\": a false positive. Default here when ANY of: the evidence is absent, the cited line \
doesn't say what the finding claims, the code is actually correct, the concern is purely \
hypothetical, or it is out of scope for this diff. When in doubt, refute.\n\
\n\
Be decisive and skeptical: it is better to drop a weak finding than to forward a wrong one. You may \
also correct an over- or under-stated severity via `adjusted_severity`.\n\
\n\
FINDINGS TO JUDGE:\n\
{list}\n\
OUTPUT — emit ONLY this JSON object, no prose:\n\
{{\"verdicts\":[{{\"index\":0,\"verdict\":\"confirmed|plausible|refuted\",\
\"adjusted_severity\":\"critical|high|medium|low|nit\",\"confidence\":0.0,\
\"reason\":\"one clause citing the diff\"}}]}}\n\
Include one entry per finding index above. Do NOT modify any files.\n\
\n\
=== DIFF ===\n{diff}\n=== END DIFF ===\n"
    )
}

/// Locate and parse the verifier's `{"verdicts":[...]}` object, tolerating
/// stray prose or a ```json fence around it.
fn parse_verdicts(text: &str) -> Option<Vec<JsonVerdict>> {
    let block = extract_verdicts_block(text)?;
    let parsed: JsonVerdicts = serde_json::from_str(&block).ok()?;
    Some(parsed.verdicts)
}

/// First balanced `{...}` substring that mentions `"verdicts"`.
fn extract_verdicts_block(text: &str) -> Option<String> {
    let bytes = text.as_bytes();
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] == b'{' {
            if let Some(end) = balanced_end(bytes, i) {
                let slice = &text[i..=end];
                if slice.contains("\"verdicts\"") {
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

/// Index of the `}` closing the `{` at `open`, brace-counting and ignoring
/// braces inside double-quoted strings.
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

#[cfg(test)]
mod tests {
    use super::*;
    use crate::review::findings::Finding;

    fn dim_finding(title: &str, sev: Severity) -> Finding {
        Finding::new("claude", sev, title)
            .with_line("src/a.rs", 10)
            .with_dimension("security")
    }

    #[test]
    fn verdict_parsing_defaults_to_plausible() {
        assert_eq!(Verdict::parse("confirmed"), Verdict::Confirmed);
        assert_eq!(Verdict::parse("REFUTED"), Verdict::Refuted);
        assert_eq!(Verdict::parse("false"), Verdict::Refuted);
        assert_eq!(Verdict::parse("dunno"), Verdict::Plausible);
    }

    #[test]
    fn engine_findings_are_protected() {
        let engine = Finding::new("aura", Severity::Critical, "invariant violation");
        assert!(is_protected(&engine));
        let specialist = dim_finding("sql injection", Severity::High);
        assert!(!is_protected(&specialist));
    }

    #[test]
    fn no_agent_passes_everything_through() {
        let f = vec![
            Finding::new("aura", Severity::Critical, "engine"),
            dim_finding("specialist", Severity::High),
        ];
        let out = verify(None, f, "diff", Duration::from_secs(1));
        assert_eq!(out.findings.len(), 2);
        assert_eq!(out.refuted, 0);
        assert!(out.verifier.is_none());
        assert!(out.note.is_some());
    }

    #[test]
    fn parse_verdicts_extracts_from_noisy_output() {
        let text = "Here are my verdicts:\n```json\n{\"verdicts\":[{\"index\":0,\
\"verdict\":\"refuted\",\"reason\":\"line is correct\"}]}\n```\nDone.";
        let v = parse_verdicts(text).expect("should parse");
        assert_eq!(v.len(), 1);
        assert_eq!(v[0].index, 0);
        assert_eq!(Verdict::parse(v[0].verdict.as_deref().unwrap()), Verdict::Refuted);
    }

    #[test]
    fn verify_prompt_lists_findings_and_demands_json() {
        let f = vec![dim_finding("null deref on token", Severity::High)];
        let p = build_verify_prompt(&f, "diff --git a b");
        assert!(p.contains("[0]"));
        assert!(p.contains("null deref on token"));
        assert!(p.contains("\"verdicts\""));
        assert!(p.contains("diff --git a b"));
        assert!(p.contains("REFUTE"));
    }
}
