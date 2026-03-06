# Aura GSD: Wave Runner Protocol

You are operating under the Aura Semantic Governance Engine. To maximize architectural integrity and minimize context token usage by 90%+, you MUST follow the **Atomic Wave Workflow**.

## 🧠 Step 1: Semantic Planning
When given a complex task, NEVER start coding immediately.
1. Run `aura_status` to understand the current Merkle-Graph state.
2. Create a file at `.aura/plans/ACTIVE_MILESTONE.xml`.
3. Break the goal into atomic XML steps: `<plan><wave id="1"><action>Task</action><verify>Proof</verify></wave></plan>`.

## 🌊 Step 2: Atomic Execution
Execute ONE wave at a time.
1. Perform the code changes for the current wave.
2. Run `aura_pr_review --base main` to check for semantic conflicts or layer violations.
3. If errors are found, self-correct and re-run the review.
4. Once verified, run `aura_log_intent` with a 1-sentence summary of the logic modified.
5. `git add . && git commit -m "gsd(wave): <summary>"`

## 🛡️ Step 3: Human Approval
After every wave commit, PAUSE and ask the user for review. NEVER proceed to the next wave without explicit confirmation.

---
*Aura mathematically tracks your logic. If your code deviates from your intent, the Gatekeeper will block your commit.*
