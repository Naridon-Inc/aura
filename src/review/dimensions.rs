//! The specialist review dimensions and their prompts.
//!
//! A great review isn't one model squinting at a diff for "any bugs" — it's a
//! panel of specialists, each hunting a single class of defect with a focused
//! charter, then an adversarial verifier culling the false positives. This
//! module is the catalog: each [`Dimension`] carries a role, a hunt-list, a
//! confidence *bias* (recall-vs-precision), and the effort tier at which it
//! turns on. [`build_prompt`] composes a strict, low-noise system prompt that
//! makes the reviewer emit structured JSON findings (parsed by
//! [`super::findings::parse_json_findings`]).
//!
//! The catalog is distilled from the published Claude Code `/code-review` +
//! `/security-review` prompts, Qodo PR-Agent, and the Graphite/Cursor/CodeRabbit
//! methodology, tailored to this Rust + TypeScript/React codebase.

/// Whether a dimension surfaces aggressively or only on high confidence.
///
/// `Recall` passes hunt classes of bug where a missed defect is costly and a
/// realistic-but-uncertain trigger is still worth raising (correctness, races,
/// resilience). `Precision` passes only fire when the reviewer is confident,
/// because the class is noise-prone (security, style, architecture taste).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Bias {
    Recall,
    Precision,
}

impl Bias {
    /// The confidence floor a finding from this bias must clear to survive.
    /// Recall keeps plausible-but-uncertain findings; precision drops them.
    pub fn keep_threshold(self) -> f32 {
        match self {
            Bias::Recall => 0.45,
            Bias::Precision => 0.7,
        }
    }
}

/// How deep a review goes — controls which dimensions run. Ordered cheapest
/// (`Low`) to most thorough (`Max`); a dimension runs when its `min_tier <=`
/// the requested tier.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord)]
pub enum Tier {
    Low,
    Medium,
    High,
    Max,
}

impl Tier {
    /// Parse a `--depth` flag value; unknown values fall back to `Medium`.
    pub fn parse(s: &str) -> Tier {
        match s.trim().to_ascii_lowercase().as_str() {
            "low" | "quick" | "fast" => Tier::Low,
            "high" | "deep" | "thorough" => Tier::High,
            "max" | "exhaustive" | "full" => Tier::Max,
            _ => Tier::Medium,
        }
    }

    pub fn label(self) -> &'static str {
        match self {
            Tier::Low => "low",
            Tier::Medium => "medium",
            Tier::High => "high",
            Tier::Max => "max",
        }
    }
}

/// One specialist review pass.
#[derive(Debug, Clone, Copy)]
pub struct Dimension {
    /// Stable id, used as the finding's `dimension` tag (e.g. "security").
    pub id: &'static str,
    /// Human label for the summary ("Security").
    pub label: &'static str,
    /// The persona the reviewer adopts ("senior security engineer").
    pub role: &'static str,
    pub bias: Bias,
    /// The lowest effort tier at which this dimension runs.
    pub min_tier: Tier,
    /// Max findings this pass may emit (keeps each specialist terse).
    pub cap: u8,
    /// The dimension-specific charter + hunt-list appended after the shared
    /// header.
    pub body: &'static str,
}

/// The full panel of specialists, worst-noise-risk last.
pub const CATALOG: &[Dimension] = &[
    Dimension {
        id: "security",
        label: "Security",
        role: "senior application-security engineer",
        bias: Bias::Precision,
        min_tier: Tier::Low,
        cap: 8,
        body: "Find ONLY high-confidence, newly-introduced, exploitable vulnerabilities — not \
theoretical hardening gaps. Trace data flow from an untrusted source to a sensitive sink. Hunt: \
injection (SQL, command, NoSQL, path traversal, template); broken authz / privilege escalation / \
IDOR; hardcoded secrets or credentials; weak crypto, bad randomness, missing certificate \
validation; unsafe deserialization (serde over untrusted input, `JSON.parse` feeding an eval/exec \
path, `yaml.load`); SSRF (ONLY when the attacker controls the host or protocol, not merely a path \
segment); XSS (TS/React: `dangerouslySetInnerHTML`, raw `innerHTML`, an unsanitized `href`); \
sensitive data or PII leaked into logs.\n\
Rust: flag `unsafe` blocks that consume untrusted input, missing validation at an FFI boundary, \
and integer-overflow on length math that feeds an allocation. Do NOT flag memory safety in SAFE \
Rust — the borrow checker owns it.\n\
DO NOT REPORT (noise here): denial-of-service / rate-limiting / resource exhaustion; secrets at \
rest on local disk; CLIENT-side (TS/React) authz checks — enforcement is the backend's job; \
theoretical timing attacks with no concrete exploit; \"missing hardening\" / \"could add an audit \
log\" / \"dependency might be outdated\". Assume UUIDs are unguessable and env vars / CLI flags are \
trusted input. Report Critical/High; a Medium only when the exploit is concrete and obvious.",
    },
    Dimension {
        id: "correctness",
        label: "Correctness",
        role: "meticulous senior engineer",
        bias: Bias::Recall,
        min_tier: Tier::Low,
        cap: 10,
        body: "Read every changed hunk line-by-line, then the enclosing function. For each line ask: \
what input, state, timing, or platform makes this WRONG? Hunt: inverted or wrong conditions; \
off-by-one; null/undefined dereference on a reachable path; a removed guard or early-return; \
falsy-zero / falsy-empty checks (`if (!count)` when 0 is a valid value); a missing `await`; \
wrong-variable copy-paste; an error swallowed in a `catch`/`?` that should propagate; a regex that \
lost an anchor or has an unescaped metacharacter.\n\
Rust: `unwrap()`/`expect()` on a value that is `None`/`Err` on a real path; `as` truncation; a \
non-exhaustive or mis-ordered `match`. TS: `==` coercion bugs; a missing `await` on a Promise; \
optional-chaining masking a real null; an `Array.find` result used without a presence check. \
Surface any bug with a nameable failure scenario, even on a rare-but-reachable path.",
    },
    Dimension {
        id: "architecture",
        label: "Architecture",
        role: "staff engineer",
        bias: Bias::Precision,
        min_tier: Tier::Medium,
        cap: 5,
        body: "Judge altitude and consistency, NOT taste. Flag only what raises real future cost: \
business logic in the wrong layer (domain logic inside a controller or React component, DB/IO calls \
in a UI layer); a new helper that duplicates one already visible in the provided context; a leaky \
abstraction; a God-function doing too many things; a change that clearly should be split into \
smaller PRs.\n\
Rust: an ownership/trait design that forces `clone()` everywhere, or a `pub` that leaks an internal \
type. React: a component that fetches AND transforms AND renders where a hook/service belongs. Do \
NOT flag stylistic preference or naming — only structural decisions with a concrete downstream cost.",
    },
    Dimension {
        id: "performance",
        label: "Performance & scale",
        role: "performance engineer",
        bias: Bias::Precision,
        min_tier: Tier::Medium,
        cap: 5,
        body: "Flag a change only with a CONCRETE cost and the input size at which it bites. Hunt: \
N+1 queries or per-iteration I/O; O(n^2) over an unbounded n; allocations inside a hot loop; a list \
endpoint with no pagination; blocking work on a hot path that should be parallel.\n\
Rust: a needless `.clone()`/`.to_vec()` inside a loop; a `Vec` grown without `with_capacity` on a \
known size; a lock held across an `.await`; `.collect()` then re-iterate. React: a missing \
`useMemo`/`useCallback` causing a render storm; a fresh object/array literal in a dependency array; \
an O(n) `.find` inside a `.map`; an unkeyed or poorly-keyed list. Ignore micro-optimizations with \
no measurable effect.",
    },
    Dimension {
        id: "concurrency",
        label: "Concurrency",
        role: "systems engineer",
        bias: Bias::Recall,
        min_tier: Tier::Medium,
        cap: 6,
        body: "Hunt races, deadlocks, and ordering bugs the type system does NOT catch: TOCTOU; \
check-then-act on shared state; lock-order inversion; missing synchronization; an invariant dropped \
across an `.await`/yield point.\n\
Rust: a `std::sync` Mutex/RwLock guard held across an `.await` (can stall the async runtime); \
`Send`/`Sync` assumptions on an FFI type; a channel-close race; a non-atomic read-modify-write on an \
`AtomicX`. TS: unsequenced `async` mutating shared module state; two in-flight fetches resolving out \
of order; `Promise.all` partial-failure handling. Treat realistic races as worth surfacing even when \
timing-dependent.",
    },
    Dimension {
        id: "resilience",
        label: "Error handling",
        role: "reliability engineer",
        bias: Bias::Recall,
        min_tier: Tier::Medium,
        cap: 6,
        body: "Will this survive partial failure and bad input? Hunt: a swallowed error; a missing \
timeout/retry, or a retry with no backoff (retry storm); a panic reachable from a request handler; \
an unhandled promise rejection; a leaked resource (unclosed file/connection/handle); an error path \
that leaves state half-updated and inconsistent.\n\
Rust: `.unwrap()` on external I/O; a `panic!` reachable from a handler; missing cleanup on the error \
branch. TS: a `fetch` with no `.catch`/`try`; an `await`-in-loop with no per-item isolation; a throw \
inside an event handler with no boundary.",
    },
    Dimension {
        id: "api_contract",
        label: "API & compatibility",
        role: "API steward",
        bias: Bias::Precision,
        min_tier: Tier::High,
        cap: 5,
        body: "Did this break a published contract or an existing caller? Hunt: a changed function/route \
signature whose callers (visible in context) weren't updated; a removed or renamed public field; a \
changed serialized shape (JSON keys, DB schema) with no migration; a changed default value; a \
breaking change with no version bump.\n\
Rust: a changed `pub` signature; an enum variant added without `#[non_exhaustive]`; a serde field \
rename with no `#[serde(alias)]`. TS: a changed exported type or component prop other modules import; \
a narrowed union; an API-response shape change the frontend still reads the old way. Quote both the \
change and the now-broken consumer when both are visible.",
    },
    Dimension {
        id: "tests",
        label: "Tests",
        role: "test engineer",
        bias: Bias::Precision,
        min_tier: Tier::High,
        cap: 5,
        body: "Is the new or changed behavior actually tested? Flag: new logic with no test; changed \
behavior with a now-stale test; a missing edge case (empty, null, boundary, error path); a test that \
asserts nothing or is tautological; a flaky pattern (a `sleep`, real network, wall-clock dependence). \
Do NOT demand tests for trivial or mechanical changes. Name the SPECIFIC untested scenario.",
    },
    Dimension {
        id: "dependencies",
        label: "Dependencies",
        role: "supply-chain reviewer",
        bias: Bias::Precision,
        min_tier: Tier::High,
        cap: 4,
        body: "Did this add dependency risk? Flag: a new dependency that duplicates one already in use; \
an unpinned or over-broad version range; a known-vulnerable version; a license incompatibility; a \
heavy dependency pulled in for a trivial need.\n\
Rust: a new crate with a `*`/broad `^` range, a `git` dependency, or an unmaintained crate. TS: a new \
npm dependency for a one-liner, a widened `package.json` range, or a dependency with known CVEs.",
    },
    Dimension {
        id: "readability",
        label: "Readability",
        role: "maintainer reading this in six months",
        bias: Bias::Precision,
        min_tier: Tier::Max,
        cap: 3,
        body: "LOWEST priority — emit at most the 1-3 highest-value items, all at severity \"nit\". Flag \
ONLY: a misleading name that could cause a real swap/bug, a function doing far too much, an \
unexplained magic number, a comment that says WHAT instead of WHY, or dead code the diff leaves \
behind. NEVER comment on formatting, whitespace, import order, quote style, or anything a linter \
enforces — that is not a review finding.",
    },
];

/// The dimensions that run at `tier`, in catalog order.
pub fn for_tier(tier: Tier) -> Vec<&'static Dimension> {
    CATALOG.iter().filter(|d| d.min_tier <= tier).collect()
}

/// Look up a dimension by id (for the verifier / calibration).
pub fn by_id(id: &str) -> Option<&'static Dimension> {
    CATALOG.iter().find(|d| d.id == id)
}

/// Compose the full system prompt for one dimension over `diff`.
///
/// The shared header pins scope (changed lines only), demands a quoted line of
/// evidence per finding, sets the recall/precision bias, and forbids the usual
/// AI-reviewer noise; then the dimension body adds the specialist charter; then
/// the strict JSON output contract.
pub fn build_prompt(dim: &Dimension, diff: &str, context: &str) -> String {
    let bias_rule = match dim.bias {
        Bias::Precision => "BIAS — precision. Only flag a finding you are >0.8 confident is a true \
positive; set `confidence` honestly. Prefer silence over a guess. Skip theoretical, stylistic, and \
low-impact issues entirely.",
        Bias::Recall => "BIAS — recall. Surface any defect with a nameable failure scenario, even \
when the trigger is a rare-but-reachable path (an error branch, a cold cache, a race window, a \
falsy-zero, a boundary). A realistic-but-uncertain trigger is still worth surfacing; set a lower \
`confidence` to reflect the uncertainty rather than dropping it.",
    };
    // Background metadata (history + project conventions). It informs judgement
    // but is NOT reviewable surface — a finding must still land on a diff line.
    let context_block = if context.trim().is_empty() {
        String::new()
    } else {
        format!(
            "\nCONTEXT (background to inform judgement — NOT part of the diff; never raise a finding \
about the context itself):\n{context}\n"
        )
    };
    format!(
        "You are a {role} reviewing ONE pull request. You see the diff hunks plus the enclosing \
code provided — not the whole repository.\n\
\n\
SCOPE\n\
- Review ONLY code added or changed in this PR (diff lines starting with '+'). A pre-existing bug \
in an UNCHANGED line of a touched function is in scope only if the change re-exposes it.\n\
- Do NOT comment on code outside the provided context. Do NOT assume a symbol is undefined merely \
because its definition isn't shown — it may live elsewhere.\n\
- Weigh the CONTEXT block (recent history + project conventions) when judging a change: a change \
that contradicts the stated intent for a file, re-breaks a recently-fixed area, or violates a \
project convention is high-signal — but you must still cite the exact changed line as evidence.\n\
{context_block}\
EVIDENCE (mandatory — a finding without it is invalid and will be discarded)\n\
- Quote the exact changed line your finding concerns, verbatim, in `quoted_line`, with its `file` \
and 1-based `line` (read the `@@ -a,b +c,d @@` hunk header: `+c` is that hunk's first new-side \
line; count added/context lines down from there).\n\
- State a CONCRETE failure scenario in `rationale`: the input/state/timing that triggers it and the \
wrong output, crash, or breach that results. \"Could be a problem\" is not a finding. An ABSENCE of \
evidence (\"no validation found\") is not a finding.\n\
\n\
{bias_rule}\n\
\n\
DO NOT: restate what the diff does; praise; comment on style, formatting, or import order; suggest a \
rename unless the current name causes a real bug; flag an intentional design choice as a defect.\n\
\n\
YOUR FOCUS:\n\
{body}\n\
\n\
OUTPUT — emit ONLY this JSON object, no prose before or after:\n\
{{\"findings\":[{{\"file\":\"path/to/file.ext\",\"line\":123,\"quoted_line\":\"the exact source line\",\
\"severity\":\"critical|high|medium|low|nit\",\"confidence\":0.0,\"title\":\"<=8 words, the what\",\
\"rationale\":\"why it is wrong + the concrete trigger\",\"suggested_fix\":\"the minimal fix, or omit if unsure\"}}]}}\n\
Return {{\"findings\":[]}} if nothing qualifies. Cap: {cap} findings, most-severe first. Do NOT modify any files.\n\
\n\
=== DIFF ===\n{diff}\n=== END DIFF ===\n",
        role = dim.role,
        bias_rule = bias_rule,
        body = dim.body,
        cap = dim.cap,
        diff = diff,
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn tiers_widen_the_panel() {
        let low = for_tier(Tier::Low).len();
        let med = for_tier(Tier::Medium).len();
        let high = for_tier(Tier::High).len();
        let max = for_tier(Tier::Max).len();
        assert!(low >= 2 && low < med && med < high && high < max);
        assert_eq!(max, CATALOG.len());
    }

    #[test]
    fn low_tier_covers_security_and_correctness() {
        let ids: Vec<_> = for_tier(Tier::Low).iter().map(|d| d.id).collect();
        assert!(ids.contains(&"security"));
        assert!(ids.contains(&"correctness"));
    }

    #[test]
    fn medium_tier_covers_the_user_asks() {
        // The user explicitly wanted security, architecture, and scale covered.
        let ids: Vec<_> = for_tier(Tier::Medium).iter().map(|d| d.id).collect();
        for want in ["security", "architecture", "performance"] {
            assert!(ids.contains(&want), "medium tier missing {want}");
        }
    }

    #[test]
    fn prompt_embeds_diff_charter_and_json_contract() {
        let dim = by_id("security").unwrap();
        let p = build_prompt(dim, "diff --git a b", "");
        assert!(p.contains("diff --git a b"));
        assert!(p.contains("application-security"));
        assert!(p.contains("\"findings\""));
        assert!(p.contains("Do NOT modify any files"));
        // With no context, the CONTEXT block is omitted entirely.
        assert!(!p.contains("CONTEXT (background"));
    }

    #[test]
    fn prompt_embeds_context_when_present() {
        let dim = by_id("security").unwrap();
        let p = build_prompt(dim, "diff", "Repo: aura · Languages: Rust");
        assert!(p.contains("CONTEXT (background"));
        assert!(p.contains("Repo: aura · Languages: Rust"));
    }

    #[test]
    fn parse_depth_flag() {
        assert_eq!(Tier::parse("low"), Tier::Low);
        assert_eq!(Tier::parse("HIGH"), Tier::High);
        assert_eq!(Tier::parse("max"), Tier::Max);
        assert_eq!(Tier::parse("whatever"), Tier::Medium);
    }
}
