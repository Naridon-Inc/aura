// What a session did while you were away — a strip above its terminal.
//
// A session on a machine keeps running when this laptop closes. Until now the
// only way to read it was a live pty attach, which shows the screen from the
// moment you sat down and nothing of the hour before: the agent finished, or
// failed, or asked a question, and the evidence scrolled off. So when a session
// tab is opened after long enough away, its scrollback is read off the machine
// and shown here, collapsible, until the person says they've seen it.
//
// What "long enough" means, where "seen" is kept, and how the text is trimmed
// are all in `lib/place/catchUp` and tested there. This is the part that draws.

import { useEffect, useMemo, useState } from "react";

import { api } from "../../lib/api";
import {
  awayLabel,
  lineCount,
  markSeen,
  readSeen,
  shouldCatchUp,
  trimTrailingBlank,
} from "../../lib/place/catchUp";
import { AsciiSpinner } from "../ui/ascii-spinner";

/** localStorage, when the page has one. A preview or a locked-down browser
 *  throws on the accessor itself, and that has to read as "no store" rather
 *  than take the terminal down with it. */
function seenStore(): Storage | null {
  try {
    return typeof localStorage === "undefined" ? null : localStorage;
  } catch {
    return null;
  }
}

type Fetch =
  | { state: "reading" }
  | { state: "read"; text: string; capturedAt: number }
  | { state: "failed"; why: string };

export function SessionCatchUp({
  machineId,
  session,
}: {
  machineId: string;
  session: string;
}) {
  const store = useMemo(seenStore, []);
  // Decided once, when the tab opens. Re-deciding on every render would make
  // the strip vanish the moment Dismiss wrote the marker, which is what
  // Dismiss is for — but it would also hide it under a re-render that had
  // nothing to do with the person.
  const [wanted] = useState(() =>
    store ? shouldCatchUp(store, machineId, session, Date.now()) : true,
  );
  const [seenAt] = useState(() =>
    store ? readSeen(store, machineId, session) : null,
  );
  const [fetch, setFetch] = useState<Fetch>({ state: "reading" });
  const [open, setOpen] = useState(true);
  const [dismissed, setDismissed] = useState(false);

  useEffect(() => {
    if (!wanted) return;
    let alive = true;
    setFetch({ state: "reading" });
    api
      .placeSessionCapture(machineId, session)
      .then((c) => {
        if (!alive) return;
        setFetch({
          state: "read",
          text: trimTrailingBlank(c.text),
          capturedAt: c.captured_at,
        });
      })
      .catch((e: unknown) => {
        if (!alive) return;
        setFetch({
          state: "failed",
          why: e instanceof Error ? e.message : String(e),
        });
      });
    return () => {
      alive = false;
    };
  }, [wanted, machineId, session]);

  // Leaving the tab is the last time you looked at it, whether or not Dismiss
  // was pressed — so coming back an hour later catches up from *here*, not
  // from whenever the marker was last set by hand.
  useEffect(() => {
    return () => {
      if (store) markSeen(store, machineId, session, Date.now());
    };
  }, [store, machineId, session]);

  if (!wanted || dismissed) return null;

  const dismiss = () => {
    if (store) markSeen(store, machineId, session, Date.now());
    setDismissed(true);
  };

  if (fetch.state === "reading") {
    return (
      <div className="flex items-center gap-2 border-b border-line-soft bg-bg-1 px-3 py-1.5 text-xs text-text-5">
        <AsciiSpinner size={12} />
        Reading what {session} did while you were away…
      </div>
    );
  }

  if (fetch.state === "failed") {
    // Said, not hidden: a strip that quietly wasn't there would read as
    // "nothing happened", which is the one thing this must never claim.
    return (
      <div className="flex items-center justify-between gap-3 border-b border-line-soft bg-bg-1 px-3 py-1.5 text-xs text-text-5">
        <span className="min-w-0 truncate">
          Couldn't read what happened while you were away. {fetch.why}
        </span>
        <button
          type="button"
          onClick={dismiss}
          className="shrink-0 rounded px-1.5 py-0.5 font-medium text-text-4 hover:bg-state-hover hover:text-text-2"
        >
          Dismiss
        </button>
      </div>
    );
  }

  const lines = lineCount(fetch.text);

  return (
    <div className="border-b border-line-soft bg-bg-1 text-xs">
      <div className="flex items-center justify-between gap-3 px-3 py-1.5">
        <button
          type="button"
          onClick={() => setOpen((o) => !o)}
          aria-expanded={open}
          className="flex min-w-0 items-center gap-2 text-left text-text-3 hover:text-text-2"
        >
          <span className="w-3 shrink-0 font-mono text-text-5">
            {open ? "▾" : "▸"}
          </span>
          <span className="font-medium">While you were away</span>
          <span className="truncate text-text-5">
            · {awayLabel(seenAt, fetch.capturedAt * 1000)} ·{" "}
            {lines === 0
              ? "nothing printed"
              : `${lines} line${lines === 1 ? "" : "s"}`}
          </span>
        </button>
        <button
          type="button"
          onClick={dismiss}
          className="shrink-0 rounded px-1.5 py-0.5 font-medium text-accent hover:bg-state-hover"
        >
          Dismiss
        </button>
      </div>
      {open && lines > 0 && (
        <pre className="max-h-56 overflow-auto whitespace-pre-wrap break-words border-t border-line-soft px-3 py-2 font-mono text-[11px] leading-[1.45] text-text-3">
          {fetch.text}
        </pre>
      )}
    </div>
  );
}
