//! Bundled portable-skill definitions.
//!
//! Each [`SkillDef`] is one capability of the Aura engine packaged so a
//! third-party coding agent (Claude Code, Codex, Gemini, Cursor) can
//! discover it and shell out to the real `aura` CLI. The catalog is the
//! *content* layer (what each skill is + which command it drives);
//! [`super::render`] turns a def into an agent-specific file and
//! [`super::mod`](super) handles list/emit/install.
//!
//! The seed set mirrors entire.io's portable `skills` repo but each entry
//! maps onto a capability Aura already ships as a CLI subcommand — no new
//! engine code, just distribution. Adding a skill = appending one literal
//! here; the format/install plumbing never changes.

/// One worked invocation of a skill's underlying `aura` command.
pub struct UsageExample {
    /// Short human label for what this invocation does.
    pub label: &'static str,
    /// The exact shell line the agent runs. Always a real `aura …`
    /// command — these are copied verbatim into the rendered SKILL.md.
    pub command: &'static str,
}

/// A single portable skill: metadata + the command(s) it teaches an
/// agent to run. All fields are `&'static str` so the whole catalog is a
/// compile-time constant with no allocation until rendered.
pub struct SkillDef {
    /// Kebab-case identifier. Doubles as the skill directory name
    /// (`<name>/SKILL.md`) and the YAML `name:` frontmatter field.
    pub name: &'static str,
    /// Human-readable heading for the rendered body.
    pub title: &'static str,
    /// Frontmatter `description:` — this is what the host agent reads to
    /// decide *whether to invoke the skill*, so it leads with the trigger
    /// ("Use when …") and names the command it runs. Keep it one dense
    /// sentence or two.
    pub description: &'static str,
    /// Prose for the "When to use" section of the body.
    pub when_to_use: &'static str,
    /// The command(s) the skill drives, with labels.
    pub usage: &'static [UsageExample],
    /// Extra guidance appended after the usage block. May be empty.
    pub notes: &'static str,
}

/// The bundled seed catalog. Order here is the order `aura skills list`
/// prints and `--all` emits.
pub fn catalog() -> Vec<SkillDef> {
    vec![
        SkillDef {
            name: "aura-search",
            title: "Search recent work (Aura)",
            description: "Use when the user asks what changed recently, \
to summarize the last work session, or to catch up on a repo's history. \
Produces a deterministic prose summary of recent Aura blocks (commands, \
commits, messages) by running `aura recall narrate-blocks` — no cloud \
round-trip, reproducible from the local `.aura/blocks/`.",
            when_to_use: "Reach for this when you need to orient in a repo \
before editing — \"what happened here recently?\", \"summarize the last \
session\", or \"what was I working on?\". The narration is generated from \
local blocks with no LLM, so it is fast and identical run-to-run.",
            usage: &[
                UsageExample {
                    label: "Summarize the last 24 hours of work",
                    command: "aura recall narrate-blocks --since-hours 24",
                },
                UsageExample {
                    label: "Widen the window to a week",
                    command: "aura recall narrate-blocks --since-hours 168",
                },
            ],
            notes: "Runs entirely against the local `.aura/` directory. If \
the repo has no blocks yet the summary is empty — that is expected, not an \
error.",
        },
        SkillDef {
            name: "aura-explain",
            title: "Explain code provenance (Aura)",
            description: "Use when the user asks why a function exists, who \
or what wrote it, or what the original intent behind a piece of code was. \
Traces an identifier back to the AI conversation and intent that created \
it by running `aura explain <identifier> <file>`.",
            when_to_use: "Reach for this before changing unfamiliar code — \
\"why is this here?\", \"what was this function for?\", \"was this \
AI-written?\". Aura links each symbol to the logged intent behind it, so \
you can recover the reasoning instead of guessing from the diff.",
            usage: &[
                UsageExample {
                    label: "Explain a function in a file",
                    command: "aura explain retry_with_backoff src/net/client.rs",
                },
                UsageExample {
                    label: "Query typed intents for a path (air-gapped)",
                    command: "aura intents query --focus-file src/net/client.rs",
                },
            ],
            notes: "`aura explain` reads the intent ledger for the named \
symbol; `aura intents query` filters the local typed-intent log and never \
touches the cloud.",
        },
        SkillDef {
            name: "aura-handover",
            title: "Hand off context to another agent (Aura)",
            description: "Use when a session is getting long, when the user \
wants to switch agents (e.g. Claude → Gemini), or when context is about to \
be lost. Produces a dense XML payload capturing the full semantic state by \
running `aura handover <agent>`, so the next agent resumes with the same \
memory at a fraction of the token cost.",
            when_to_use: "Reach for this when the conversation is large \
(>50K tokens) or the user says \"hand this off\", \"continue in another \
tool\", or \"start fresh but keep the context\". Paste the emitted payload \
as the first message to the next agent.",
            usage: &[
                UsageExample {
                    label: "Emit a handover payload for the next agent",
                    command: "aura handover claude",
                },
                UsageExample {
                    label: "Target a different agent",
                    command: "aura handover gemini",
                },
            ],
            notes: "The payload is XML on stdout — capture it and start the \
next conversation with it. Saves roughly 90% of the context tokens versus \
re-reading the codebase.",
        },
        SkillDef {
            name: "aura-prove",
            title: "Prove a behavioral goal (Aura)",
            description: "Use when the user wants to verify that a feature \
actually works end-to-end, or to find gaps before claiming something is \
done. Mathematically traces whether the logic paths for a goal exist and \
are wired by running `aura goal-trace --goal \"<goal>\"` (alias `aura \
prove`) — reports which nodes exist, which connections are missing.",
            when_to_use: "Reach for this after implementing a feature, or \
when the user asks \"does X actually work?\" / \"is this fully wired?\". It \
verifies the implementation against the stated behavior at the AST level, \
not by running tests.",
            usage: &[
                UsageExample {
                    label: "Prove a user-facing behavior is implemented",
                    command: "aura goal-trace --goal \"users can log in via Google OAuth\"",
                },
                UsageExample {
                    label: "Same, using the short alias",
                    command: "aura prove --goal \"rate limiting blocks the 11th request\"",
                },
            ],
            notes: "Phrase the goal as an observable behavior, not an \
implementation detail. Gaps in the trace are the work that remains.",
        },
        SkillDef {
            name: "aura-review",
            title: "Semantic PR review (Aura)",
            description: "Use when the user asks for a code review, wants to \
check a branch before merging, or to catch bugs, security issues, layer \
violations and accidental deletions. Runs Aura's AST-level review over the \
diff against a base branch via `aura pr-review --base <branch>`.",
            when_to_use: "Reach for this before opening or merging a PR, or \
when the user says \"review my changes\", \"is this safe to merge?\", or \
\"did I break anything?\". The review reasons over the semantic diff, so it \
catches deletions and architectural drift a line diff misses.",
            usage: &[
                UsageExample {
                    label: "Review the current branch against main",
                    command: "aura pr-review --base main",
                },
                UsageExample {
                    label: "Machine-readable report for further processing",
                    command: "aura pr-review --base main --json",
                },
            ],
            notes: "Fix the reported violations before committing. `--json` \
emits a structured report you can parse; the default output is for humans.",
        },
        SkillDef {
            name: "aura-recall-cloud",
            title: "Recall cross-machine history (Aura)",
            description: "Use when the user asks what a teammate or another \
machine did, to review activity across the team, or to reconstruct a \
session timeline beyond the local repo. Queries the cloud event ledger via \
`aura recall events` and per-agent session arcs via `aura recall arc`.",
            when_to_use: "Reach for this for team-wide or cross-device \
questions — \"what did <agent> change today?\", \"show the timeline for \
this file across machines\", \"what happened on the other branch?\". Unlike \
`aura-search` (local, air-gapped) this reads the shared cloud timeline.",
            usage: &[
                UsageExample {
                    label: "Recent events touching a file",
                    command: "aura recall events --focus-file src/auth.rs --window-hours 168",
                },
                UsageExample {
                    label: "Session arc for one agent",
                    command: "aura recall arc --agent claude --window-hours 72",
                },
            ],
            notes: "Requires cloud sign-in (`aura login`). When signed out \
this errors — fall back to `aura-search` for local-only history.",
        },
    ]
}

/// Look up one skill by name. Returns `None` if no bundled skill matches.
pub fn find(name: &str) -> Option<SkillDef> {
    catalog().into_iter().find(|s| s.name == name)
}
