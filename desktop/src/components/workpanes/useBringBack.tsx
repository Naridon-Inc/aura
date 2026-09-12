// useBringBack — the shared surgical "Bring this back" action.
//
// Restores ONE piece (a single function/class/struct, by symbol name) in one
// file to its previous saved version via `aura rewind <symbol> <file>`. Aura
// snapshots the current code first, so the undo is itself undoable, and nothing
// else in the file moves. This is the only recovery verb we surface to
// non-engineers — framed as "undo this one change", never a whole-repo reset.
//
// It lives here (not inside TimeMachinePane) because the recovery action now
// belongs wherever you can SEE what changed: the Time machine AND a session's
// Changes tab. One hook, one confirm copy, one result card — used in both.
//
// Asking first. The click no longer runs the recovery: it asks the engine what
// the recovery would do and shows it — this piece as it stands, as it would
// stand, and where the saved version came from — with the button under it.
// A dialog that can only say the name of the thing it is about to overwrite is
// not a question anybody can answer, and "bring back" is the one verb people
// press when they are already having a bad day.
//
// Three claims this surface used to make and could not support:
//   · that it knew which piece you meant — a name can belong to a struct and
//     its impl block, and the engine took whichever it reached first;
//   · that the recovery happened — exit 0 was treated as proof, and the engine
//     exited 0 after printing that it had aborted;
//   · that it was undoable — true of the safety snapshot, false of the
//     interface, which offered no way back.
// The parsing that keeps those honest is in `bringBack.ts`, under test.

import { useCallback, useState } from "react";
import { api } from "../../lib/api";
import { Button } from "../ui/button";
import {
  applyArgs,
  previewArgs,
  readApply,
  readPreview,
  type BringBackPlan,
} from "./bringBack";

export type BringBackState =
  | { kind: "idle" }
  /** Asking the engine what would change. Writes nothing. */
  | { kind: "checking"; symbol: string }
  /** Answered, and waiting for a person to say yes. */
  | { kind: "plan"; plan: BringBackPlan }
  | { kind: "busy"; symbol: string }
  | { kind: "ok"; symbol: string; file: string; origin: string; undone: boolean }
  | { kind: "err"; symbol: string; message: string };

/** Drive a surgical bring-back for `repoRoot`. `run(symbol, relFile)` asks
 *  what would change and stops; `confirm()` is what actually writes; `undo()`
 *  puts back what the last recovery displaced. `busySymbol` disables the row
 *  button while any of it is in flight. */
export function useBringBack(repoRoot: string) {
  const [state, setState] = useState<BringBackState>({ kind: "idle" });

  // Work out what would happen, and show it. Used for a recovery and for
  // undoing one — the same question, asked of a different saved version.
  const ask = useCallback(
    async (symbol: string, relFile: string, undo: boolean) => {
      setState({ kind: "checking", symbol });
      try {
        const res = await api.auraCli(repoRoot, previewArgs(symbol, relFile, undo));
        const out = readPreview(res, symbol, relFile);
        if (out.ok) setState({ kind: "plan", plan: out.plan });
        else setState({ kind: "err", symbol, message: out.message });
      } catch (e) {
        setState({ kind: "err", symbol, message: String(e) });
      }
    },
    [repoRoot],
  );

  const run = useCallback(
    (symbol: string, relFile: string) => ask(symbol, relFile, false),
    [ask],
  );

  /** Ask what undoing the last recovery of this piece would do. */
  const undo = useCallback(
    (symbol: string, relFile: string) => ask(symbol, relFile, true),
    [ask],
  );

  /** Do the thing that was previewed, and nothing else. */
  const confirm = useCallback(async () => {
    if (state.kind !== "plan") return;
    const { symbol, file, undo: undoing } = state.plan;
    setState({ kind: "busy", symbol });
    try {
      const res = await api.auraCli(repoRoot, applyArgs(symbol, file, undoing));
      const out = readApply(res, symbol);
      if (out.ok) {
        setState({ kind: "ok", symbol, file, origin: out.origin, undone: undoing });
      } else {
        setState({ kind: "err", symbol, message: out.message });
      }
    } catch (e) {
      setState({ kind: "err", symbol, message: String(e) });
    }
  }, [repoRoot, state]);

  const reset = useCallback(() => setState({ kind: "idle" }), []);
  const busySymbol =
    state.kind === "busy" || state.kind === "checking"
      ? state.symbol
      : state.kind === "plan"
        ? state.plan.symbol
        : null;

  return { state, run, confirm, undo, reset, busySymbol };
}

function CodeBlock({ label, code }: { label: string; code: string }) {
  return (
    <div className="min-w-0 flex-1">
      <div className="section-label mb-1">{label}</div>
      <pre className="max-h-40 overflow-auto whitespace-pre rounded-md border border-line-soft bg-bg-0 px-2.5 py-2 font-mono text-[11px] leading-snug text-text-2">
        {code.replace(/\s+$/, "")}
      </pre>
    </div>
  );
}

/** The bring-back surface: what it would do (awaiting a yes), what it is
 *  doing, and what it did. Shared so the Time machine and Session detail
 *  report recovery identically. */
export function BringBackResult({
  state,
  onConfirm,
  onUndo,
  onDismiss,
}: {
  state: BringBackState;
  /** Approve the previewed change. */
  onConfirm: () => void;
  /** Undo the recovery that just happened. */
  onUndo: (symbol: string, file: string) => void;
  onDismiss: () => void;
}) {
  if (state.kind === "idle") return null;

  if (state.kind === "checking") {
    return (
      <div className="mt-3 rounded-lg border border-line-soft bg-bg-1 px-3.5 py-2.5 text-sm text-text-3">
        Working out what would change for{" "}
        <span className="font-mono text-text-1">{state.symbol}</span>…
      </div>
    );
  }

  if (state.kind === "busy") {
    return (
      <div className="mt-3 rounded-lg border border-line-soft bg-bg-1 px-3.5 py-2.5 text-sm text-text-3">
        Bringing <span className="font-mono text-text-1">{state.symbol}</span> back…
      </div>
    );
  }

  if (state.kind === "plan") {
    const { plan } = state;
    return (
      <div className="mt-3 rounded-lg border border-line-soft bg-bg-1 px-3.5 py-3">
        <div className="flex items-center gap-2.5">
          <span className="text-base font-semibold text-text-1">
            {plan.undo
              ? "Undo this recovery?"
              : plan.deleted
                ? "Put this piece back?"
                : "Bring this back?"}
          </span>
          <Button
            type="button"
            variant="ghost"
            size="xs"
            onClick={onDismiss}
            className="ml-auto text-xs text-text-4 hover:text-text-1"
          >
            Cancel
          </Button>
        </div>
        <div className="mt-1.5 break-words text-sm leading-snug text-text-2">
          <span className="font-mono text-text-1">{plan.symbol}</span> in{" "}
          <span className="font-mono text-text-1">{plan.file}</span> goes back to{" "}
          {plan.origin || "an earlier saved version"}. Nothing else in the file changes,
          and Aura keeps a copy of the current code first.
        </div>
        <div className="mt-2.5 flex flex-col gap-2.5 sm:flex-row">
          {plan.current !== null && <CodeBlock label="Now" code={plan.current} />}
          <CodeBlock label={plan.current === null ? "Would be put back" : "After"} code={plan.restored} />
        </div>
        <div className="mt-3">
          <Button type="button" variant="accentSoft" size="sm" onClick={onConfirm}>
            {plan.undo ? "Undo it" : plan.deleted ? "Put it back" : "Bring it back"}
          </Button>
        </div>
      </div>
    );
  }

  const ok = state.kind === "ok";
  const fg = ok ? "var(--color-accent-green)" : "var(--color-red)";
  return (
    <div className="mt-3 rounded-lg border border-line-soft bg-bg-1 px-3.5 py-3">
      <div className="flex items-center gap-2.5">
        <span aria-hidden className="shrink-0 text-sm leading-none" style={{ color: fg }}>
          {ok ? "✓" : "✗"}
        </span>
        <span className="text-base font-semibold text-text-1">
          {state.kind === "ok"
            ? state.undone
              ? "Recovery undone"
              : "Brought back to its safe version"
            : "Couldn't bring it back"}
        </span>
        <Button
          type="button"
          variant="ghost"
          size="xs"
          onClick={onDismiss}
          className="ml-auto text-xs text-text-4 hover:text-text-1"
        >
          Dismiss
        </Button>
      </div>
      <div className="mt-1.5 whitespace-pre-line break-words text-sm leading-snug text-text-2">
        {state.kind === "ok" ? (
          <>
            <span className="font-mono text-text-1">{state.symbol}</span> in{" "}
            <span className="font-mono text-text-1">{state.file}</span>{" "}
            {state.undone
              ? "is back to what it was before Aura brought it back."
              : "is back to its previous saved version."}{" "}
            The rest of your work is untouched.
          </>
        ) : (
          state.kind === "err" && state.message
        )}
      </div>
      {state.kind === "ok" && (
        // The safety snapshot always existed; nothing ever offered it back,
        // so "this is undoable too" was a sentence rather than a button.
        <div className="mt-2.5">
          <Button
            type="button"
            variant="subtle"
            size="xs"
            onClick={() => onUndo(state.symbol, state.file)}
          >
            {state.undone ? "Bring it back again" : "Undo this recovery"}
          </Button>
        </div>
      )}
    </div>
  );
}
