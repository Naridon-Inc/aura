//! Cross-agent session continuity.
//!
//! When a coding session hits a wall (usage limit, a better model for the
//! task) the user swaps the brain — Claude → Gemini → Kimi — and needs to
//! resume at the *exact* point. This module assembles Aura's own semantic
//! record (signed intent log, AST checkpoints, session, memory, working
//! tree) into an [`AuraCarryover`] the next brain reads to continue the
//! work rather than restart the conversation.
//!
//! Two consumers share one assembler:
//!   - **In-app brain swap** (aura-shell): `aura carryover --json` is shelled
//!     by `cmd_carryover.rs`; the renderer prepends the result to the next
//!     turn's context so the new brain inherits full state.
//!   - **Portable CLI handoff**: `aura carryover --inject --agent gemini`
//!     writes the markdown into the target CLI's startup-context file.

pub mod assemble;
pub mod model;
pub mod redact;
pub mod render;

pub use model::{AuraCarryover, CarryoverMode};

/// Knobs for [`assemble::assemble`]. Defaults live in [`AssembleOpts::for_mode`].
pub struct AssembleOpts {
    pub mode: CarryoverMode,
    pub target_agent: Option<String>,
    /// Intent-log lookback window in hours (≤0 disables the cutoff).
    pub since_hours: i64,
    /// Max intent rows embedded.
    pub intent_limit: usize,
    /// How many recent checkpoints to walk for touched nodes.
    pub checkpoint_limit: usize,
    /// Hard cap on embedded touched nodes.
    pub node_cap: usize,
}

impl AssembleOpts {
    pub fn for_mode(mode: CarryoverMode, target_agent: Option<String>, since_hours: i64) -> Self {
        Self {
            mode,
            target_agent,
            since_hours,
            intent_limit: 25,
            checkpoint_limit: 8,
            node_cap: 40,
        }
    }
}

/// CLI entry for `aura carryover`. Chdir to `repo` (one-shot process),
/// assemble the payload, then emit it as JSON, inject it into an agent's
/// context file, or print the markdown.
pub fn run_carryover(
    repo: &str,
    mode_str: &str,
    agent: Option<String>,
    since_hours: i64,
    json: bool,
    do_inject: bool,
    no_redact: bool,
) -> Result<(), Box<dyn std::error::Error>> {
    if repo != "." && !repo.is_empty() {
        let abs = std::fs::canonicalize(repo)
            .map_err(|e| format!("--repo {repo}: {e}"))?;
        std::env::set_current_dir(&abs).map_err(|e| format!("chdir {}: {e}", abs.display()))?;
    }

    let mode = CarryoverMode::parse(mode_str)
        .ok_or_else(|| format!("--mode must be `full` or `semantic`, got `{mode_str}`"))?;

    let opts = AssembleOpts::for_mode(mode, agent.clone(), since_hours);
    let mut carryover = assemble::assemble(&opts);

    // Secret redaction runs by default in every path (the payload may
    // leave the box to an external agent). `--no-redact` is the local-
    // only escape hatch for the in-app brain-swap that wants full
    // fidelity and never ships the carryover off-machine.
    if !no_redact {
        redact::redact_carryover(&mut carryover);
    }

    if do_inject {
        let agent = agent.ok_or("--inject requires --agent <name>")?;
        let repo_root = std::env::current_dir()?;
        let result = render::inject(&carryover, &agent, &repo_root)?;
        if json {
            println!("{}", serde_json::to_string_pretty(&result)?);
        } else {
            let verb = if result.created { "created" } else { "updated" };
            println!("✓ {verb} {} (AURA:RESUME section for {agent})", result.path);
            // Carry the "how to actually run me" footer so a handoff to an
            // un-signed-in CLI fails forward with the one action that fixes it,
            // instead of dead-ending in a provider 402 inside the target.
            println!("  → launch:  `{}`  (resumes from the injected context)", result.launch);
            println!("  → auth:    {}", result.auth);
            if !result.on_path {
                println!("  ⚠ `{}` not found on PATH — install it before launching", result.launch);
            }
        }
        return Ok(());
    }

    if json {
        println!("{}", serde_json::to_string_pretty(&carryover)?);
    } else {
        print!("{}", render::to_markdown(&carryover));
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::model::*;
    use super::render;
    use std::path::Path;

    fn sample() -> AuraCarryover {
        AuraCarryover {
            version: 1,
            mode: "semantic".into(),
            generated_at: 1_700_000_000,
            repo: "/tmp/demo".into(),
            branch: Some("feat/auth".into()),
            target_agent: Some("gemini".into()),
            session: Some(SessionDigest {
                session_id: "s1".into(),
                agent_id: "Claude".into(),
                model: Some("claude-opus".into()),
                branch: Some("feat/auth".into()),
                base_commit: Some("abc1234".into()),
                started_at: 1_699_000_000,
                last_activity: 1_700_000_000,
                files_touched: vec!["src/auth.rs".into()],
                first_prompt: Some("add oauth".into()),
                summary: Some(SessionSummaryBrief {
                    intent: "Add OAuth login".into(),
                    outcome: "token exchange wired".into(),
                    open_items: vec!["refresh-token rotation".into()],
                    learnings: vec![],
                }),
            }),
            intents: vec![IntentBrief {
                timestamp: 1_700_000_000,
                agent_id: "Claude".into(),
                intent: "Wire OAuth token exchange".into(),
                intent_type: Some("FeatureAdd".into()),
                signed_block_id: Some("blk-9".into()),
            }],
            touched_nodes: vec![NodeState {
                node_id: "fn::authenticate@src/auth.rs:42".into(),
                identifier: Some("authenticate".into()),
                kind: "function_definition".into(),
                file_path: Some("src/auth.rs".into()),
                start_line: Some(42),
                end_line: Some(88),
                signature: Some("fn authenticate(req: Req) -> Result<Token>".into()),
                is_stub: true,
                intent: "Wire OAuth token exchange".into(),
                at: 1_700_000_000,
            }],
            working_tree: WorkingTreeDiff {
                files_changed: 1,
                insertions: 30,
                deletions: 4,
                files: vec![FileDiffStat {
                    path: "src/auth.rs".into(),
                    status: "M".into(),
                }],
            },
            memory: None,
            recent_turns: vec![TurnBrief {
                role: "user".into(),
                text: "continue the oauth work".into(),
                at: 1_700_000_000,
            }],
        }
    }

    #[test]
    fn mode_parse_roundtrip() {
        assert_eq!(CarryoverMode::parse("full"), Some(CarryoverMode::Full));
        assert_eq!(CarryoverMode::parse("SEMANTIC"), Some(CarryoverMode::Semantic));
        assert_eq!(CarryoverMode::parse("compact"), Some(CarryoverMode::Semantic));
        assert_eq!(CarryoverMode::parse("nope"), None);
        assert!(CarryoverMode::Full.turn_cap() > CarryoverMode::Semantic.turn_cap());
    }

    #[test]
    fn markdown_surfaces_function_level_intent() {
        let md = render::to_markdown(&sample());
        assert!(md.contains("Aura carryover → gemini"));
        assert!(md.contains("authenticate"));
        assert!(md.contains("STUB")); // is_stub surfaced as unfinished work
        assert!(md.contains("aura attest verify blk-9")); // signed intent verifiable
        assert!(md.contains("OAuth"));
    }

    #[test]
    fn xml_surfaces_same_state_as_markdown() {
        let xml = render::to_xml(&sample());
        // Well-formed root with the handover attributes.
        assert!(xml.starts_with("<aura_semantic_context"));
        assert!(xml.contains("for=\"gemini\""));
        assert!(xml.trim_end().ends_with("</aura_semantic_context>"));
        // Function-level intent + stub flag survive into the XML face.
        assert!(xml.contains("name=\"authenticate\""));
        assert!(xml.contains("stub=\"true\""));
        // Signed intent is verifiable downstream.
        assert!(xml.contains("signed=\"blk-9\""));
        // Working tree + a changed file render as elements.
        assert!(xml.contains("<working_tree"));
        assert!(xml.contains("src/auth.rs"));
    }

    #[test]
    fn xml_escapes_markup_in_content() {
        let mut c = sample();
        c.intents[0].intent = "guard <script> & \"quotes\"".into();
        let xml = render::to_xml(&c);
        assert!(xml.contains("&lt;script&gt;"));
        assert!(xml.contains("&amp;"));
        // Raw angle brackets from content must not leak into the markup.
        assert!(!xml.contains("<script>"));
    }

    #[test]
    fn inject_is_idempotent() {
        let dir = tempfile::tempdir().unwrap();
        let c = sample();

        let r1 = render::inject(&c, "gemini", dir.path()).unwrap();
        assert!(r1.created);
        assert!(Path::new(&r1.path).ends_with("GEMINI.md"));
        let after1 = std::fs::read_to_string(&r1.path).unwrap();

        let r2 = render::inject(&c, "gemini", dir.path()).unwrap();
        assert!(!r2.created);
        let after2 = std::fs::read_to_string(&r2.path).unwrap();

        // Exactly one marker pair, and the second write is stable.
        assert_eq!(after2.matches("<!-- AURA:RESUME:START -->").count(), 1);
        assert_eq!(after1, after2);
    }

    #[test]
    fn inject_preserves_surrounding_content() {
        let dir = tempfile::tempdir().unwrap();
        std::fs::write(dir.path().join("CLAUDE.md"), "# My rules\n\nkeep me\n").unwrap();
        let c = sample();
        let r = render::inject(&c, "claude", dir.path()).unwrap();
        assert!(!r.created);
        let body = std::fs::read_to_string(&r.path).unwrap();
        assert!(body.contains("keep me"));
        assert!(body.contains("AURA:RESUME"));
    }

    #[test]
    fn find_resume_blocks_detects_injected_carryover() {
        let dir = tempfile::tempdir().unwrap();
        let c = sample();
        render::inject(&c, "gemini", dir.path()).unwrap();

        let blocks = render::find_resume_blocks(dir.path());
        assert_eq!(blocks.len(), 1);
        // Filename → agent inference, and the carryover body survives.
        assert_eq!(blocks[0].agent, "gemini");
        assert!(blocks[0].path.ends_with("GEMINI.md"));
        assert!(blocks[0].body.contains("Aura carryover → gemini"));
        // The marker comments themselves are stripped from the body.
        assert!(!blocks[0].body.contains("AURA:RESUME"));
    }

    #[test]
    fn kimi_injects_into_agents_md_not_kimi_md() {
        // Kimi auto-loads AGENTS.md (the cross-vendor standard), never a
        // "KIMI.md" — verified live. The mapping must route kimi there so the
        // injected carryover actually reaches Kimi's startup context.
        let dir = tempfile::tempdir().unwrap();
        let r = render::inject(&sample(), "kimi", dir.path()).unwrap();
        assert!(r.path.ends_with("AGENTS.md"), "kimi must inject into AGENTS.md, got {}", r.path);
        assert!(!Path::new(&r.path).exists() || !r.path.ends_with("KIMI.md"));
        // And the round-trip detector still finds the block in AGENTS.md.
        let blocks = render::find_resume_blocks(dir.path());
        assert_eq!(blocks.len(), 1);
        assert!(blocks[0].path.ends_with("AGENTS.md"));
        assert!(blocks[0].body.contains("Aura carryover"));
    }

    #[test]
    fn consume_clears_block_and_preserves_surroundings() {
        let dir = tempfile::tempdir().unwrap();
        std::fs::write(dir.path().join("CLAUDE.md"), "# My rules\n\nkeep me\n").unwrap();
        let c = sample();
        let r = render::inject(&c, "claude", dir.path()).unwrap();

        // Consume returns the carryover body and removes the marker.
        // (Body reflects the carryover's own target_agent, not the file
        // it was injected into — assert on agent-independent content.)
        let body = render::consume(Path::new(&r.path)).unwrap();
        assert!(body.contains("Aura carryover"));
        assert!(body.contains("authenticate"));

        let after = std::fs::read_to_string(&r.path).unwrap();
        assert!(!after.contains("AURA:RESUME"));
        // Surrounding human content is untouched.
        assert!(after.contains("# My rules"));
        assert!(after.contains("keep me"));

        // Second consume has nothing to take — no block left.
        assert!(render::find_resume_blocks(dir.path()).is_empty());
        assert!(render::consume(Path::new(&r.path)).is_err());
    }
}
