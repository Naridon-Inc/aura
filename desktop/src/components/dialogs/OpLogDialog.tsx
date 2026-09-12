// jj-style operation log + undo. Lists the most recent engine ops
// (intent log appends, snapshots, intent attribute/split/merge, zone
// claims). Click a row → confirm → backend reverses it and stamps
// `undone_at` on the entry. The most recent un-undone op that CAN be reversed
// is highlighted as the ⌘Z target so the keymap (W1.4) stays consistent with
// the dialog.
//
// "that CAN be reversed" is load-bearing. This used to target the most recent
// un-undone op of any kind, and three of the eight kinds the engine records —
// conflict_open, conflict_resolve, guard_revert — have no arm in `apply_undo`
// (op_log.rs:147-155). Settle a merge conflict and the newest row is a
// conflict_resolve: the button lit up, read "Undo: conflict_resolve", and
// answered the press with the engine's own "no inverse implemented for op kind
// 'conflict_resolve'". Whether a thing can be undone is knowable before you
// press it, so it's said before you press it. See lib/opKinds.
//
// What the rows SAY lives in ./opLog/describe — the engine's summary strings
// ("Attributed 1 path(s) to intent #1788769912") are written for a log file
// and were going straight onto the screen. One action recorded as ten steps is
// now one line, and the reason is looked up from the intent log by the
// timestamp the payload already carries, so it reads in full instead of as an
// id. Undo is untouched by that folding: a line selects its newest step, which
// is the same op the same click selected when every step had its own row.

import { useCallback, useEffect, useMemo, useState } from "react";
import { Undo2 } from "lucide-react";
import { Dialog } from "../Dialog";
import { relativeAgeFromSecs } from "../../lib/relativeTime";
import { isUndoable } from "../../lib/opKinds";
import { Button } from "../ui/button";
import { EmptyState, ErrorNote, LoadingState } from "../ui/state";
import { api, type IntentRow, type OpEntry } from "../../lib/api";
import { refreshIntentRows } from "../../lib/intentCache";
import { describeGroup, groupOps } from "./opLog/describe";
import { OpGroupRow } from "./opLog/OpGroupRow";

type OpLogDialogProps = {
  open: boolean;
  repoRoot: string;
  onClose: () => void;
};

/** How far back to read the intent log for the reasons the ops point at. The
 *  op list is capped at 50, and each op names at most one intent. */
const INTENT_LOOKBACK = 200;

/** What the footer may claim, given how much of the list it has actually read.
 *
 *  The list itself has a loading state and an empty state. The footer and the
 *  button had neither: `target` is null while the read is in flight and null
 *  again if it throws, and both cases fell into the same arm as a list that was
 *  genuinely read and held nothing reversible — so the dialog opened saying
 *  "Nothing in this list can be reversed." before it had looked, and kept
 *  saying it after a failure. Somebody opens this when they're frightened of
 *  what an agent just did; that sentence is the worst possible wrong answer at
 *  the worst possible moment. */
export function undoCopy(s: {
  loading: boolean;
  failed: boolean;
  hasTarget: boolean;
  selected: boolean;
  busy: boolean;
  /** Recorded steps behind the selected line. A line can stand for several —
   *  ten files filed under one reason is ten steps — and undo still takes back
   *  one. Saying which one is the difference between a promise kept and a
   *  person thinking all ten came back. */
  steps?: number;
}): { footnote: string; label: string; title: string } {
  if (s.loading)
    return {
      footnote: "Reading what Aura has done…",
      label: s.busy ? "undoing…" : "Undo the last step",
      title: "Still reading what Aura has done",
    };
  if (s.failed)
    return {
      footnote:
        "Aura couldn't read this list just now, so it can't tell you what's reversible. Reopen this window to try again.",
      label: s.busy ? "undoing…" : "Undo the last step",
      title: "Aura couldn't read this list just now",
    };
  if (!s.hasTarget)
    return {
      footnote: "Nothing in this list can be reversed.",
      label: s.busy ? "undoing…" : "Nothing to undo",
      title: "Nothing here can be undone",
    };
  const steps = s.steps ?? 1;
  return {
    footnote: s.selected
      ? steps > 1
        ? `The most recent of those ${steps} steps will be undone.`
        : "The step you picked will be undone."
      : "Undoes the most recent step that can be reversed.",
    label: s.busy ? "undoing…" : s.selected ? "Undo this step" : "Undo the last step",
    title: "",
  };
}

export function OpLogDialog({ open, repoRoot, onClose }: OpLogDialogProps) {
  const [ops, setOps] = useState<OpEntry[]>([]);
  const [intents, setIntents] = useState<IntentRow[]>([]);
  const [loading, setLoading] = useState(false);
  const [busy, setBusy] = useState(false);
  const [selected, setSelected] = useState<string | null>(null);
  const [result, setResult] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    if (!repoRoot) return;
    setLoading(true);
    setErr(null);
    try {
      // The reasons are a nicety on top of the list, so they're read alongside
      // it and never allowed to fail it: no intents just means the rows quote
      // the shorter copy each op recorded for itself.
      const [rows, reasons] = await Promise.all([
        api.auraOpRecent(repoRoot, 50),
        // Through the shared cache, not `api` directly: every surface that
        // reads this log reads it once between them. Past the freshness
        // window, because this window opens right after the steps it lists
        // were recorded and an intent logged a moment ago has to be joinable.
        refreshIntentRows(repoRoot, INTENT_LOOKBACK).catch(
          (): IntentRow[] => [],
        ),
      ]);
      setOps(rows);
      setIntents(reasons);
    } catch (e) {
      setErr(String(e));
    } finally {
      setLoading(false);
    }
  }, [repoRoot]);

  useEffect(() => {
    if (open) {
      setSelected(null);
      setResult(null);
      setErr(null);
      void refresh();
    }
  }, [open, refresh]);

  // `intent_ts` on an op payload is the `timestamp` of the intent row it
  // belongs to — the same number, which is what makes the join exact rather
  // than a time-window guess.
  const reasonByTs = useMemo(() => {
    const m = new Map<number, string>();
    for (const r of intents) {
      if (typeof r.timestamp === "number" && typeof r.intent === "string") {
        m.set(r.timestamp, r.intent);
      }
    }
    return m;
  }, [intents]);

  const groups = useMemo(() => groupOps(ops), [ops]);

  // A row you can't press is a row you can't select, so `selected` is already
  // reversible by construction — the `isUndoable` guard here is belt and braces
  // for a list that refreshed under a stale selection.
  const target = useMemo(() => {
    const reversible = (o: OpEntry) => o.undone_at === null && isUndoable(o.kind);
    if (selected) {
      const picked = ops.find((o) => o.op_id === selected);
      return picked && reversible(picked) ? picked : null;
    }
    return ops.find(reversible) ?? null;
  }, [ops, selected]);

  const selectedGroup = useMemo(
    () => (selected ? (groups.find((g) => g.lead.op_id === selected) ?? null) : null),
    [groups, selected],
  );

  async function undo() {
    if (!target) return;
    setBusy(true);
    setErr(null);
    setResult(null);
    try {
      const msg = await api.auraUndoLast(repoRoot, target.op_id);
      setResult(msg);
      setSelected(null);
      await refresh();
    } catch (e) {
      setErr(String(e));
    } finally {
      setBusy(false);
    }
  }

  const copy = undoCopy({
    loading,
    failed: err !== null && ops.length === 0,
    hasTarget: target !== null,
    selected: selected !== null,
    busy,
    steps: selectedGroup?.ops.length ?? 1,
  });

  // The hover named the step by its engine tag and its id — "Undo op
  // 5f3a1c04" — neither of which is a thing anybody recognises. When there IS
  // a target the line's own words beat any generic sentence.
  const targetTitle = useMemo(() => {
    if (!target) return copy.title;
    const g = groups.find((x) => x.ops.some((o) => o.op_id === target.op_id));
    return g ? `Undo: ${describeGroup(g, repoRoot, reasonByTs).title}` : copy.title;
  }, [target, groups, repoRoot, reasonByTs, copy.title]);

  return (
    <Dialog
      open={open}
      onClose={onClose}
      title="What Aura did"
      width={680}
      footer={
        <>
          <Button variant="ghost" size="xs" onClick={onClose}>
            Close
          </Button>
          <Button
            variant="default"
            size="xs"
            onClick={undo}
            disabled={busy || !target}
            title={targetTitle}
          >
            {copy.label}
          </Button>
        </>
      }
    >
      <div className="space-y-2 text-sm">
        {/* Eight things reach this list and not one of them is an agent editing
            your code. Someone frightened by what an AI just did to their files
            would otherwise read these rows as the edits themselves. */}
        <div className="text-text-4 text-2xs">
          Aura's own record: the reasons it wrote down, the copies it kept, the clashes it
          settled. Your agents' edits to your files aren't in this list.
        </div>
        {err && <ErrorNote className="text-xs">{err}</ErrorNote>}
        {result && (
          <div className="text-text-2 text-xs bg-bg-2 border border-line-soft rounded px-2 py-1.5">
            {result}
          </div>
        )}
        {loading && ops.length === 0 && (
          <LoadingState label="Reading what Aura has done…" />
        )}
        {!loading && ops.length === 0 && (
          <EmptyState
            icon={Undo2}
            title="Nothing to undo yet"
            body="Aura's own record shows up here (reasons it logged, copies it kept, clashes it settled) each with a way to reverse it. Your agents' edits to your files aren't in this list. Nothing yet."
            size="sm"
          />
        )}
        {ops.length > 0 && (
          <div className="max-h-[55vh] overflow-y-auto border border-line-soft rounded">
            {groups.map((g) => {
              const lead = g.lead;
              const isSelected = selected === lead.op_id;
              const isUndoTarget = !selected && target?.op_id === lead.op_id;
              const undone = lead.undone_at !== null;
              // Three of the eight kinds have no inverse. Those lines are
              // history to read, not history to arm the button with — so
              // they're dimmed and inert exactly like an already-undone line,
              // and say why.
              const reversible = isUndoable(lead.kind);
              return (
                <OpGroupRow
                  key={g.id}
                  story={describeGroup(g, repoRoot, reasonByTs)}
                  age={formatAge(lead.ts)}
                  inert={undone || !reversible}
                  undone={undone}
                  reversible={reversible}
                  selected={isSelected}
                  isUndoTarget={isUndoTarget}
                  onToggle={() => setSelected(isSelected ? null : lead.op_id)}
                />
              );
            })}
          </div>
        )}
        <div className="text-text-4 text-2xs">
          {/* Said "the most recent un-undone op", which was both the engine's
              words and a description of the bug — it targeted the newest row
              whether or not that row could be reversed.

              The replacement first read "⌘Z does the same when you're not
              typing in a file". It doesn't: ⌘Z fires `aura:open-op-log`
              (App.tsx:1030) and OPENS this list. Naming a shortcut is a claim
              about what it's bound to, and it's checkable — which is the whole
              point of the two commits either side of this one.

              Every arm now comes from `undoCopy`, which knows whether the list
              has been read at all — see the note on that function. */}
          {copy.footnote}
        </div>
      </div>
    </Dialog>
  );
}

function formatAge(ts: number): string {
  // One ladder for the whole app — see lib/relativeTime. This copy stopped at
  // days, so an operation from a year ago read "412d". Prose, not compact:
  // "1d ago" is a time, "1d" is a token.
  return relativeAgeFromSecs(ts, { style: "prose" });
}
