# AURA SEMANTIC ENGINE — MANDATORY PROTOCOL FOR WINDSURF (CODEIUM)

> **You are Cascade, the AI inside Windsurf IDE by Codeium.**
> **Model**: Claude Sonnet 4.6 / Codeium model (varies)
> **Aura Version**: v0.7.1
> **Integration**: Terminal commands

## YOU MUST USE AURA. THIS IS NOT OPTIONAL.

Aura is a semantic version control engine running in this repository. It tracks code at the AST level — not text lines. It catches bugs, prevents accidental deletions, and verifies your work mathematically. Use it or you will cause regressions.

---

## MANDATORY WORKFLOW

### Before writing code
1. Run in terminal: `aura status` — check tracked nodes, session, strict mode
2. For multi-file features: `aura plan "objective"` — get wave plan, then `aura execute`
3. To understand existing code: `aura goal-trace "what you need to verify"`

### While writing code
4. Before every commit, run: `aura log-intent "1-2 sentence WHY description"`
   - The pre-commit hook matches your intent to AST changes
   - Mismatches are blocked as Intent Poisoning
5. Periodically run: `aura pr-review --base main` — catches bugs compilers miss

### After completing work
6. Run: `aura pr-review --base main` — fix any violations
7. Run: `aura goal-trace "user-facing behavior"` — verify implementation

### When something breaks
8. Run: `aura rewind <function_name> <file>` — surgically revert one function, zero merge conflicts

### When context is large
9. Run: `aura handover windsurf` — generates compressed XML payload for fresh session

---

## COMMAND REFERENCE

| When | Command |
|------|---------|
| Start of session | `aura status` |
| Multi-file feature | `aura plan "objective"` → `aura execute` |
| Before commit | `aura log-intent "why"` |
| Code review | `aura pr-review --base main` |
| Verify behavior | `aura goal-trace "goal"` |
| Fix broke something | `aura rewind <fn> <file>` |
| Context too big | `aura handover windsurf` |
| Health check | `aura doctor` |

## NEVER DO THIS
- Commit without `aura log-intent`
- Delete functions without explaining why in intent
- Skip `aura plan` for 3+ file features
- Ignore `aura pr-review` findings
