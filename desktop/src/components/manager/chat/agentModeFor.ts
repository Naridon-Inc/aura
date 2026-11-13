import type { AgentMode } from "../../../lib/api";
import type { ComposerMode } from "./composerTypes";

/** Which of the agent's own modes an Aura mode means.
 *
 * Aura's chip is four positions and an agent's is usually two, so this is
 * a narrowing, not a mapping: everything that promises not to edit
 * (`plan`, `ask`) asks for the agent's plan mode, and everything that
 * expects work done takes whatever else it offers. Matching on the id
 * rather than a per-agent table means an agent with modes we have never
 * heard of still gets the read-only half right. */
export function agentModeFor(
  mode: ComposerMode,
  modes: AgentMode[],
): string | null {
  if (modes.length === 0) return null;
  const readOnly = mode === "plan" || mode === "ask";
  const planLike = modes.find((m) => /plan/i.test(m.id) || /plan/i.test(m.name));
  if (readOnly) return planLike?.id ?? null;
  return (modes.find((m) => m !== planLike) ?? modes[0]).id;
}
