# AURA SEMANTIC ENGINE — MANDATORY PROTOCOL FOR GEMINI CLI

> **You are Gemini (Google), running inside Gemini CLI.**
> **Model**: Gemini 2.5 Pro
> **Aura Version**: v0.7.1
> **Integration**: Shell commands + .gemini/hooks

## YOU MUST USE AURA. THIS IS NOT OPTIONAL.

Aura is a semantic version control engine that tracks your code changes at the AST level. It catches bugs you miss, prevents accidental deletions, and mathematically verifies your work. Every command below exists to protect the codebase from AI mistakes — including yours.

---

## BEFORE WRITING ANY CODE

1. **Check semantic state**
   ```bash
   aura status
   ```
   Shows: logic nodes tracked, active session, checkpoints, strict mode status

2. **Plan multi-file features** (required when task touches 3+ files)
   ```bash
   aura plan "Your objective here"
   ```
   Reviews gray areas, then:
   ```bash
   aura execute
   ```
   Executes wave-by-wave with AST verification after each wave

3. **Verify existing logic paths**
   ```bash
   aura goal-trace "User can authenticate via OAuth"
   ```

---

## WHILE WRITING CODE

4. **Log intent before every commit**
   ```bash
   aura log-intent "Refactored retry_logic to use exponential backoff for rate limit compliance"
   ```
   The pre-commit hook compares your stated intent against actual AST changes. Mismatches are flagged as Intent Poisoning.

5. **Review periodically**
   ```bash
   aura pr-review --base main
   ```
   Catches: layer violations, security issues, architectural drift, accidental deletions

---

## AFTER COMPLETING WORK

6. **Final review**
   ```bash
   aura pr-review --base main --json
   ```
   Full semantic diff with AI-powered bug/security scanning. Fix violations before merging.

7. **Prove the goal**
   ```bash
   aura goal-trace "The feature the user requested"
   ```

---

## WHEN CONTEXT IS LARGE

8. **Generate handover**
   ```bash
   aura handover gemini
   ```
   Produces a dense XML payload with full semantic state. Start a new session with this payload — saves ~90% of context tokens.

---

## WHEN THINGS BREAK

9. **Surgical rewind** — revert a single function without merge conflicts
   ```bash
   aura rewind <function_name> <file_path>
   ```

10. **Diagnose issues**
    ```bash
    aura doctor
    ```

---

## COMMAND REFERENCE

| When | Command | What it does |
|------|---------|-------------|
| Start of session | `aura status` | Check semantic state, tracked nodes, session info |
| Before multi-file work | `aura plan "objective"` | Decompose into atomic waves |
| Execute plan | `aura execute` | Run waves with AST verification |
| Before every commit | `aura log-intent "why"` | Bind reasoning to AST changes |
| During/after work | `aura pr-review --base main` | Semantic diff + AI bug scan |
| Verify behavior | `aura goal-trace "goal"` | Mathematical proof via AST tracing |
| Something broke | `aura rewind <fn> <file>` | Surgical function-level revert |
| Context too big | `aura handover gemini` | Compress to XML handover payload |
| Health check | `aura doctor` | Find stuck sessions, orphaned data |
| Multi-agent work | `aura orchestrate` | Run Claude + Gemini in parallel |
| Linear issues | `aura symphony list-issues` | List team issues from Linear |

## WHAT YOU MUST NEVER DO

- Never commit without running `aura log-intent` first
- Never delete functions without explaining why in intent
- Never skip `aura plan` for features touching 3+ files
- Never ignore `aura pr-review` findings — fix them
- Never keep working past context limits — use `aura handover gemini` instead
