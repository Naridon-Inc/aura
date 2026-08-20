// jj-style operation log + undo. Lists the most recent engine ops
// (intent log appends, snapshots, intent attribute/split/merge, zone
// claims). Click a row → inverse-op preview → confirm → backend
// reverses it and stamps `undone_at` on the entry. The most recent
// un-undone op that CAN be reversed is highlighted as the ⌘Z target so the
// keymap (W1.4) stays consistent with the dialog.
//
// "that CAN be reversed" is load-bearing. This used to target the most recent
// un-undone op of any kind, and three of the eight kinds the engine records —
// conflict_open, conflict_resolve, guard_revert — have no arm in `apply_undo`
// (op_log.rs:147-155). Settle a merge conflict and the newest row is a
// conflict_resolve: the button lit up, read "Undo: conflict_resolve", and
// answered the press with the engine's own "no inverse implemented for op kind
// 'conflict_resolve'". Whether a thing can be undone is knowable before you
// press it, so it's said before you press it. See lib/opKinds.

import { useCallback, useEffect, useMemo, useState } from "react";
import { Undo2 } from "lucide-react";
import { Dialog } from "../Dialog";
import { relativeAgeFromSecs } from "../../lib/relativeTime";
import { isUndoable, opKindLabel } from "../../lib/opKinds";
import { Button } from "../ui/button";
import { EmptyState, ErrorNote, LoadingState } from "../ui/state";
import { api, type OpEntry } from "../../lib/api";

type OpLogDialogProps = {
  open: boolean;
  repoRoot: string;
  onClose: () => void;
};

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
  return {
    footnote: s.selected
      ? "The step you picked will be undone."
      : "Undoes the most recent step that can be reversed.",
    label: s.busy ? "undoing…" : s.selected ? "Undo this step" : "Undo the last step",
    title: "",
  };
}

export function OpLogDialog({ open, repoRoot, onClose }: OpLogDialogProps) {
  const [ops, setOps] = useState<OpEntry[]>([]);
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
      const rows = await api.auraOpRecent(repoRoot, 50);
      setOps(rows);
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
  });

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
            // The hover named the step by its engine tag and its id — "Undo op
            // 5f3a1c04" — neither of which is a thing anybody recognises. When
            // there IS a target the step's own name beats any generic line.
            title={
              target
                ? `Undo "${opKindLabel(target.kind)}" · ${target.summary}`
                : copy.title
            }
          >
            {copy.label}
          </Button>
        </>
      }
    >
      <div className="space-y-2 text-sm">
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
            // Was "Every change Aura makes on your behalf is recorded here so
            // you can take it back." Eight things reach this list and not one of
            // them is an agent editing your code: snapshot, log_intent,
            // intent_attribute, intent_split, intent_merge, conflict_open,
            // conflict_resolve, guard_revert (the `record_op` call sites in
            // cmd_aura.rs, cmd_conflicts.rs and agent_mutation_guard.rs). They
            // are Aura's own bookkeeping. Someone frightened by what an AI did
            // to their files would open this on that sentence, find it empty,
            // and conclude nothing had happened.
            body="Aura's own bookkeeping shows up here (reasons it logged, backups it took, conflicts it settled) each with a way to reverse it. Your agents' edits to your files aren't in this list. Nothing yet."
            size="sm"
          />
        )}
        <div className="max-h-[55vh] overflow-y-auto border border-line-soft rounded">
          {ops.map((op) => {
            const isSelected = selected === op.op_id;
            const isUndoTarget = !selected && target?.op_id === op.op_id;
            const undone = op.undone_at !== null;
            // Three of the eight kinds have no inverse. Those rows are history
            // to read, not history to arm the button with — so they're dimmed
            // and inert exactly like an already-undone row, and say why.
            const reversible = isUndoable(op.kind);
            const inert = undone || !reversible;
            return (
              <button
                key={op.op_id}
                type="button"
                onClick={() => setSelected(isSelected ? null : op.op_id)}
                disabled={inert}
                className={[
                  "w-full text-left px-2.5 py-1.5 border-b border-line-soft last:border-b-0 transition-colors",
                  inert
                    ? "opacity-50 cursor-not-allowed"
                    : isSelected
                    ? "bg-bg-3"
                    : isUndoTarget
                    ? "bg-bg-2 hover:bg-bg-3"
                    : "hover:bg-state-hover",
                ].join(" ")}
              >
                <div className="flex items-center gap-2">
                  <span className="meta-tag shrink-0">{opKindLabel(op.kind)}</span>
                  <span className="text-text-1 text-sm truncate flex-1">
                    {op.summary}
                  </span>
                  <span className="text-text-4 text-2xs shrink-0">
                    {formatAge(op.ts)}
                  </span>
                  {undone ? (
                    <span className="section-label shrink-0">undone</span>
                  ) : !reversible ? (
                    <span className="section-label shrink-0">can’t be undone</span>
                  ) : null}
                </div>
                {isSelected && (
                  <pre className="mt-1.5 text-2xs font-mono text-text-3 bg-bg-1 border border-line-soft rounded p-1.5 max-h-32 overflow-auto whitespace-pre-wrap break-all">
                    {JSON.stringify(op.undo_payload, null, 2)}
                  </pre>
                )}
              </button>
            );
          })}
        </div>
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
  // days, so an operation from a year ago read "412d".
  return relativeAgeFromSecs(ts, { style: "compact" });
}
