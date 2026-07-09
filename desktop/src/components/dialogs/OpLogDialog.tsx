// jj-style operation log + undo. Lists the most recent engine ops
// (intent log appends, snapshots, intent attribute/split/merge, zone
// claims). Click a row → inverse-op preview → confirm → backend
// reverses it and stamps `undone_at` on the entry. The most recent
// un-undone op is highlighted as the ⌘Z target so the keymap (W1.4)
// stays consistent with the dialog.

import { useCallback, useEffect, useMemo, useState } from "react";
import { Dialog } from "../Dialog";
import { Button } from "../ui/button";
import { api, type OpEntry } from "../../lib/api";

type OpLogDialogProps = {
  open: boolean;
  repoRoot: string;
  onClose: () => void;
};

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

  const target = useMemo(() => {
    if (selected) return ops.find((o) => o.op_id === selected) ?? null;
    return ops.find((o) => o.undone_at === null) ?? null;
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

  return (
    <Dialog
      open={open}
      onClose={onClose}
      title="Operation log"
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
            title={target ? `Undo op ${target.op_id.slice(0, 8)}` : "Nothing to undo"}
          >
            {busy ? "undoing…" : target ? `Undo: ${target.kind}` : "Nothing to undo"}
          </Button>
        </>
      }
    >
      <div className="space-y-2 text-[11.5px]">
        {err && <div className="text-red text-[11px]">{err}</div>}
        {result && (
          <div className="text-emerald-400 text-[11px] bg-bg-2 border border-line-soft rounded px-2 py-1.5">
            {result}
          </div>
        )}
        {loading && ops.length === 0 && (
          <div className="text-text-4 text-[11px]">Loading…</div>
        )}
        {!loading && ops.length === 0 && (
          <div className="text-text-4 text-[11px]">No operations recorded yet.</div>
        )}
        <div className="max-h-[55vh] overflow-y-auto border border-line-soft rounded">
          {ops.map((op) => {
            const isSelected = selected === op.op_id;
            const isUndoTarget = !selected && target?.op_id === op.op_id;
            const undone = op.undone_at !== null;
            return (
              <button
                key={op.op_id}
                type="button"
                onClick={() => setSelected(isSelected ? null : op.op_id)}
                disabled={undone}
                className={[
                  "w-full text-left px-2.5 py-1.5 border-b border-line-soft last:border-b-0 transition-colors",
                  undone
                    ? "opacity-50 cursor-not-allowed"
                    : isSelected
                    ? "bg-bg-3"
                    : isUndoTarget
                    ? "bg-bg-2 hover:bg-bg-3"
                    : "hover:bg-bg-2",
                ].join(" ")}
              >
                <div className="flex items-center gap-2">
                  <span className="text-text-4 text-[10px] font-mono w-12 shrink-0">
                    {op.op_id.slice(0, 8)}
                  </span>
                  <span
                    className={[
                      "text-[10px] uppercase tracking-wider px-1.5 py-0.5 rounded shrink-0",
                      kindColor(op.kind),
                    ].join(" ")}
                  >
                    {op.kind}
                  </span>
                  <span className="text-text-1 text-[11.5px] truncate flex-1">
                    {op.summary}
                  </span>
                  <span className="text-text-4 text-[10px] shrink-0">
                    {formatAge(op.ts)}
                  </span>
                  {undone && (
                    <span className="text-text-4 text-[10px] uppercase shrink-0">
                      undone
                    </span>
                  )}
                </div>
                {isSelected && (
                  <pre className="mt-1.5 text-[10px] font-mono text-text-3 bg-bg-1 border border-line-soft rounded p-1.5 max-h-32 overflow-auto whitespace-pre-wrap break-all">
                    {JSON.stringify(op.undo_payload, null, 2)}
                  </pre>
                )}
              </button>
            );
          })}
        </div>
        <div className="text-text-4 text-[10px]">
          {selected
            ? "Selected op will be undone."
            : "Defaults to undoing the most recent un-undone op (also bound to ⌘Z outside editor focus)."}
        </div>
      </div>
    </Dialog>
  );
}

function kindColor(kind: string): string {
  switch (kind) {
    case "log_intent":
      return "bg-sky-900/40 text-sky-300";
    case "snapshot":
      return "bg-emerald-900/40 text-emerald-300";
    case "intent_attribute":
      return "bg-amber-900/40 text-amber-300";
    case "intent_split":
      return "bg-violet-900/40 text-violet-300";
    case "intent_merge":
      return "bg-fuchsia-900/40 text-fuchsia-300";
    case "zone_claim":
      return "bg-rose-900/40 text-rose-300";
    default:
      return "bg-bg-3 text-text-3";
  }
}

function formatAge(ts: number): string {
  const ms = Date.now() - ts * 1000;
  if (ms < 0) return "now";
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h`;
  const d = Math.floor(h / 24);
  return `${d}d`;
}
