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

import { useCallback, useState } from "react";
import { api } from "../../lib/api";
import { Button } from "../ui/button";

export type BringBackState =
  | { kind: "idle" }
  | { kind: "busy"; symbol: string }
  | { kind: "ok"; symbol: string; file: string }
  | { kind: "err"; symbol: string; message: string };

function firstMeaningfulLine(s: string): string {
  for (const line of s.split("\n")) {
    const t = line.trim();
    if (t) return t;
  }
  return "";
}

/** Drive a surgical bring-back for `repoRoot`. Returns the current state, the
 *  `run(symbol, relFile)` action (which asks for confirmation first), a `reset`
 *  to dismiss the result, and `busySymbol` for disabling the button mid-run. */
export function useBringBack(repoRoot: string) {
  const [state, setState] = useState<BringBackState>({ kind: "idle" });

  const run = useCallback(
    async (symbol: string, relFile: string) => {
      if (
        !window.confirm(
          `Bring "${symbol}" in ${relFile} back to its previous saved version?\n\nOnly this one piece changes — the rest of your work stays exactly as it is. Aura saves a copy of the current code first, so you can undo this too.`,
        )
      ) {
        return;
      }
      setState({ kind: "busy", symbol });
      try {
        const res = await api.auraCli(repoRoot, ["rewind", symbol, relFile]);
        if (res.status === 0) {
          setState({ kind: "ok", symbol, file: relFile });
        } else {
          setState({
            kind: "err",
            symbol,
            message:
              firstMeaningfulLine(res.stderr) ||
              `aura rewind exited with ${res.status}`,
          });
        }
      } catch (e) {
        setState({ kind: "err", symbol, message: String(e) });
      }
    },
    [repoRoot],
  );

  const reset = useCallback(() => setState({ kind: "idle" }), []);
  const busySymbol = state.kind === "busy" ? state.symbol : null;

  return { state, run, reset, busySymbol };
}

/** The result banner for a bring-back (busy / brought-back / couldn't). Shared
 *  so the Time machine and Session detail report recovery identically. */
export function BringBackResult({
  state,
  onDismiss,
}: {
  state: BringBackState;
  onDismiss: () => void;
}) {
  if (state.kind === "idle") return null;
  if (state.kind === "busy") {
    return (
      <div className="mt-3 rounded-lg border border-line-soft bg-bg-1 px-3.5 py-2.5 text-[12px] text-text-3">
        Bringing <span className="font-mono text-text-1">{state.symbol}</span> back…
      </div>
    );
  }
  const ok = state.kind === "ok";
  const fg = ok ? "var(--color-accent-green)" : "var(--color-red)";
  return (
    <div className="mt-3 rounded-lg border border-line-soft bg-bg-1 px-3.5 py-3">
      <div className="flex items-center gap-2.5">
        <span aria-hidden className="shrink-0 text-[12px] leading-none" style={{ color: fg }}>
          {ok ? "✓" : "✗"}
        </span>
        <span className="text-[13px] font-semibold text-text-1">
          {ok ? "Brought back to its safe version" : "Couldn't bring it back"}
        </span>
        <Button
          type="button"
          variant="ghost"
          size="xs"
          onClick={onDismiss}
          className="ml-auto text-[11px] text-text-4 hover:text-text-1"
        >
          Dismiss
        </Button>
      </div>
      <div className="mt-1.5 break-words text-[12px] leading-snug text-text-2">
        {state.kind === "ok" ? (
          <>
            <span className="font-mono text-text-1">{state.symbol}</span> in{" "}
            <span className="font-mono text-text-1">{state.file}</span> is back to its previous saved
            version. The rest of your work is untouched, and this is undoable too.
          </>
        ) : (
          state.kind === "err" && state.message
        )}
      </div>
    </div>
  );
}
