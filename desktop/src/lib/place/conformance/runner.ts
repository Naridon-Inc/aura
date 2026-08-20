// Running the table, and saying which cell failed.
//
// Kept apart from both the table and the checks so neither imports the other:
// the checks read the table, the runner reads both, and nothing reads the
// runner except the test that asserts the whole thing is green.

import type { Mode, Workflow, WorkflowId } from "./matrix";
import { MODES, WORKFLOWS, caveatFor } from "./matrix";
import { CHECKS } from "./workflows";

/**
 * One cell: this mode, this workflow, against what the table said to expect.
 *
 * Four of the five outcomes are worth naming:
 *
 * - the floor broke — the contract answered something no table makes
 *   acceptable, and the cell is red whatever anybody declared;
 * - met and undeclared — green, the ordinary case;
 * - not promised and declared — amber, an honest asymmetry;
 * - **not promised and undeclared** — red. A mode that quietly stopped doing
 *   something is the failure this whole suite exists to catch;
 * - **met but declared not-promised** — also red, and this is the one that is
 *   easy to leave out. An expected-unsupported entry that has come true is a
 *   stale excuse, and left in place it is somewhere a real regression can sit
 *   for months wearing the word "expected".
 */
export async function cell(
  mode: Mode,
  workflow: Workflow,
): Promise<string | null> {
  const where = `${mode.id} × ${workflow.id} (${workflow.title})`;
  const caveat = caveatFor(mode, workflow.id);
  let outcome;
  try {
    outcome = await CHECKS[workflow.id](mode);
  } catch (e) {
    return `${where}: the contract broke — ${messageOf(e)}`;
  }
  if (outcome.kind === "met") {
    return caveat
      ? `${where}: the table says this mode does not promise it, but it does: ${outcome.note}. Take the entry out of the table — it currently reads: ${caveat}`
      : null;
  }
  return caveat
    ? null
    : `${where}: not promised, and nothing in the table says so — ${outcome.note}`;
}

/**
 * Every mode, every workflow, and the lines for the ones that did not hold.
 *
 * The product, with no way to opt a mode out of a column. An empty result is the
 * parity proof: a mode is not shipped until its column is green.
 */
export async function runMatrix(
  modes: readonly Mode[] = MODES,
  workflows: readonly Workflow[] = WORKFLOWS,
): Promise<string[]> {
  const failures: string[] = [];
  for (const mode of modes) {
    for (const workflow of workflows) {
      const failed = await cell(mode, workflow);
      if (failed) failures.push(failed);
    }
  }
  return failures;
}

/** How many questions the table asks — the number that must go up by the
 *  number of workflows when a mode is added, and by the number of modes when a
 *  workflow is. */
export function cellCount(
  modes: readonly Mode[] = MODES,
  workflows: readonly Workflow[] = WORKFLOWS,
): number {
  return modes.length * workflows.length;
}

/** Which workflows a mode has declared it does not promise. */
export function declaredAsymmetries(
  modes: readonly Mode[] = MODES,
): Array<[string, WorkflowId]> {
  return modes.flatMap((m) =>
    m.notPromised.map(([w]) => [m.id, w] as [string, WorkflowId]),
  );
}

/** A thrown thing as a sentence. Never `[object Object]`, and never empty — a
 *  blank failure line is indistinguishable from a passing cell. */
function messageOf(e: unknown): string {
  if (typeof e === "string" && e.trim()) return e.trim();
  if (e instanceof Error && e.message.trim()) return e.message.trim();
  return "the check failed without saying why";
}
