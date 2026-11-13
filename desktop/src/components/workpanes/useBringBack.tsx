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
// Changes tab. One hook, one confirm copy, one result — used in both.
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

import { useCallback, useMemo, useState, type ReactNode } from "react";
import { api } from "../../lib/api";
import { diffText, foldContext } from "../../lib/diff";
import { AsciiSpinner } from "../ui/ascii-spinner";
import { Button } from "../ui/button";
import { TraceItem, TraceLine } from "../ui/trace-report";
import { FileDiff } from "../ui/workspace-patterns";
import {
  applyArgs,
  previewArgs,
  readApply,
  readPreview,
  type BringBackPlan,
} from "./bringBack";
import "../trace/bring-back.css";

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

/** The piece as it stands against how it would stand, drawn as the shared
 *  file diff so it reads like every other change in the app. */
function PieceDiff({ symbol, current, restored }: { symbol: string; current: string | null; restored: string }) {
  const lines = useMemo(() => foldContext(diffText(current ?? "", restored)), [current, restored]);
  return (
    <div className="ui-bringback-diff">
      <FileDiff name={symbol} lines={lines} />
    </div>
  );
}

function Waiting({ children }: { children: ReactNode }) {
  return (
    <p className="ui-trace-line ui-bringback-wait" role="status">
      <AsciiSpinner />
      <span>{children}</span>
    </p>
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
      <Waiting>
        Working out what would change for <code className="ui-bringback-code">{state.symbol}</code>…
      </Waiting>
    );
  }

  if (state.kind === "busy") {
    return (
      <Waiting>
        Bringing <code className="ui-bringback-code">{state.symbol}</code> back…
      </Waiting>
    );
  }

  if (state.kind === "plan") {
    const { plan } = state;
    return (
      <div className="ui-bringback">
        <TraceItem
          // Nothing has happened yet: the open circle is "waiting on you".
          tone="muted"
          title={plan.undo ? "Undo this recovery?" : plan.deleted ? "Put this piece back?" : "Bring this back?"}
          actions={
            <>
              <Button type="button" size="sm" onClick={onConfirm}>
                {plan.undo ? "Undo it" : plan.deleted ? "Put it back" : "Bring it back"}
              </Button>
              <Button type="button" variant="ghost" size="sm" onClick={onDismiss}>
                Cancel
              </Button>
            </>
          }
        >
          <TraceLine>
            <code className="ui-bringback-code">{plan.symbol}</code> in{" "}
            <code className="ui-bringback-code">{plan.file}</code> goes back to{" "}
            {plan.origin || "an earlier saved version"}. Nothing else in the file changes, and Aura
            keeps a copy of the current code first.
          </TraceLine>
          <TraceLine tone="note">
            {plan.current === null
              ? "It isn't in the file now, so every line below would be added."
              : "Red is the piece as it stands, green is how it would read."}
          </TraceLine>
          <PieceDiff symbol={plan.symbol} current={plan.current} restored={plan.restored} />
        </TraceItem>
      </div>
    );
  }

  const ok = state.kind === "ok";
  return (
    <div className="ui-bringback">
      <TraceItem
        tone={ok ? "good" : "bad"}
        title={
          state.kind === "ok"
            ? state.undone
              ? "Recovery undone"
              : "Brought back to its safe version"
            : "Couldn't bring it back"
        }
        actions={
          <>
            {state.kind === "ok" && (
              // The safety snapshot always existed; nothing ever offered it back,
              // so "this is undoable too" was a sentence rather than a button.
              <Button
                type="button"
                variant="secondary"
                size="sm"
                onClick={() => onUndo(state.symbol, state.file)}
              >
                {state.undone ? "Bring it back again" : "Undo this recovery"}
              </Button>
            )}
            <Button type="button" variant="ghost" size="sm" onClick={onDismiss}>
              Dismiss
            </Button>
          </>
        }
      >
        {state.kind === "ok" ? (
          <TraceLine>
            <code className="ui-bringback-code">{state.symbol}</code> in{" "}
            <code className="ui-bringback-code">{state.file}</code>{" "}
            {state.undone
              ? "is back to what it was before Aura brought it back."
              : "is back to its previous saved version."}{" "}
            The rest of your work is untouched.
          </TraceLine>
        ) : (
          state.kind === "err" &&
          state.message && <p className="ui-trace-line ui-bringback-error">{state.message}</p>
        )}
      </TraceItem>
    </div>
  );
}
