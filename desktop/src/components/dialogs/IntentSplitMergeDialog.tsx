// Surgically edit an existing intent: split it by partitioning its
// claimed files into a new intent, or merge it with another recent intent
// so the changesets unite. The History sidebar pops this from a
// right-click on any intent row.

import { useEffect, useMemo, useState } from "react";
import { Dialog } from "../Dialog";
import { Button } from "../ui/button";
import { api, type IntentRow } from "../../lib/api";

type Mode = "split" | "merge";

type Props = {
  open: boolean;
  repoRoot: string;
  /** Timestamp of the intent the user right-clicked. Acts as the primary
   *  key into `.aura/intent_log.jsonl`. */
  intentTs: number | null;
  onClose: () => void;
};

function shortName(p: string): string {
  const i = p.lastIndexOf("/");
  return i >= 0 ? p.slice(i + 1) : p;
}

export function IntentSplitMergeDialog({ open, repoRoot, intentTs, onClose }: Props) {
  const [mode, setMode] = useState<Mode>("split");
  const [rows, setRows] = useState<IntentRow[]>([]);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [moveSet, setMoveSet] = useState<Set<string>>(new Set());
  const [newIntent, setNewIntent] = useState("");
  const [mergeWithTs, setMergeWithTs] = useState<number | null>(null);

  useEffect(() => {
    if (!open) return;
    setMode("split");
    setBusy(false);
    setErr(null);
    setMoveSet(new Set());
    setNewIntent("");
    setMergeWithTs(null);
    api
      .auraIntentRecent(repoRoot, 50)
      .then(setRows)
      .catch((e) => setErr(String(e)));
  }, [open, repoRoot]);

  const target: IntentRow | undefined = useMemo(
    () => rows.find((r) => r.timestamp === intentTs),
    [rows, intentTs],
  );
  const targetFiles = target?.changeset?.files ?? [];
  const otherIntents = useMemo(
    () => rows.filter((r) => r.timestamp !== intentTs),
    [rows, intentTs],
  );

  function toggleMove(path: string) {
    setMoveSet((prev) => {
      const next = new Set(prev);
      if (next.has(path)) next.delete(path);
      else next.add(path);
      return next;
    });
  }

  async function runSplit() {
    if (!target) return;
    if (moveSet.size === 0) {
      setErr("pick at least one file to move into the new reason");
      return;
    }
    if (!newIntent.trim()) {
      setErr("type the new reason");
      return;
    }
    const allPaths = targetFiles.map((f) => f.path);
    const move = allPaths.filter((p) => moveSet.has(p));
    const keep = allPaths.filter((p) => !moveSet.has(p));
    setBusy(true);
    setErr(null);
    try {
      await api.auraIntentSplit(
        repoRoot,
        target.timestamp,
        keep,
        move,
        newIntent.trim(),
      );
      window.dispatchEvent(new CustomEvent("aura:intent-logged", { detail: { repoRoot } }));
      onClose();
    } catch (e) {
      setErr(String(e));
    } finally {
      setBusy(false);
    }
  }

  async function runMerge() {
    if (!target || mergeWithTs === null) return;
    setBusy(true);
    setErr(null);
    try {
      await api.auraIntentMerge(repoRoot, target.timestamp, mergeWithTs);
      window.dispatchEvent(new CustomEvent("aura:intent-logged", { detail: { repoRoot } }));
      onClose();
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
      title="Edit reason"
      footer={
        <>
          <Button variant="ghost" size="xs" onClick={onClose}>
            Cancel
          </Button>
          {mode === "split" ? (
            <Button
              variant="default"
              size="xs"
              onClick={runSplit}
              disabled={busy || !target || moveSet.size === 0 || !newIntent.trim()}
            >
              {busy ? "splitting…" : `Split · ${moveSet.size} file${moveSet.size === 1 ? "" : "s"}`}
            </Button>
          ) : (
            <Button
              variant="default"
              size="xs"
              onClick={runMerge}
              disabled={busy || !target || mergeWithTs === null}
            >
              {busy ? "merging…" : "Merge"}
            </Button>
          )}
        </>
      }
    >
      <div className="space-y-3 text-[11.5px]">
        {!target ? (
          <div className="text-text-4">no reason selected</div>
        ) : (
          <>
            <div className="border border-line-soft rounded bg-bg-0 px-2 py-1.5">
              <div className="text-text-3 text-[10.5px] uppercase tracking-wider">
                Original reason
              </div>
              <div className="text-text-1 text-[12px] leading-snug">{target.intent}</div>
              <div className="text-text-5 text-[10.5px] mt-0.5">
                {targetFiles.length} file{targetFiles.length === 1 ? "" : "s"} ·{" "}
                {target.agent_id}
              </div>
            </div>

            <div className="flex items-center gap-1">
              <ModeChip current={mode} id="split" onClick={setMode}>
                Split
              </ModeChip>
              <ModeChip current={mode} id="merge" onClick={setMode}>
                Merge
              </ModeChip>
            </div>

            {mode === "split" ? (
              <>
                <div>
                  <div className="text-text-4 text-[10.5px] uppercase tracking-wider mb-1">
                    Move these files into a new reason
                  </div>
                  <div className="border border-line-soft rounded bg-bg-0 max-h-[160px] overflow-y-auto">
                    {targetFiles.length === 0 ? (
                      <div className="px-2 py-3 text-text-4 text-[11px]">
                        this reason covers no files
                      </div>
                    ) : (
                      targetFiles.map((f) => {
                        const checked = moveSet.has(f.path);
                        return (
                          <label
                            key={f.path}
                            className={`flex items-center gap-2 px-2 py-1 text-[11.5px] cursor-pointer hover:bg-bg-2 ${
                              checked ? "" : "opacity-55"
                            }`}
                          >
                            <input
                              type="checkbox"
                              checked={checked}
                              onChange={() => toggleMove(f.path)}
                              disabled={busy}
                              className="accent-accent-green"
                            />
                            <span className="w-3 text-[10px] font-mono text-text-4">
                              {(f.status || "M").trim()}
                            </span>
                            <span className="text-text-1 truncate" title={f.path}>
                              {shortName(f.path)}
                            </span>
                            <span className="ml-auto text-text-5 text-[10.5px] font-mono truncate">
                              {f.path}
                            </span>
                          </label>
                        );
                      })
                    )}
                  </div>
                </div>
                <div>
                  <div className="text-text-4 text-[10.5px] uppercase tracking-wider mb-1">
                    New reason
                  </div>
                  <textarea
                    value={newIntent}
                    onChange={(e) => setNewIntent(e.target.value)}
                    placeholder="What were these files actually for?"
                    disabled={busy}
                    rows={3}
                    className="w-full bg-bg-1 border border-line rounded px-2 py-1.5 text-text-1 text-[12px] outline-none focus:border-text-4 resize-y leading-relaxed"
                  />
                </div>
              </>
            ) : (
              <div>
                <div className="text-text-4 text-[10.5px] uppercase tracking-wider mb-1">
                  Merge with
                </div>
                <div className="border border-line-soft rounded bg-bg-0 max-h-[220px] overflow-y-auto">
                  {otherIntents.length === 0 ? (
                    <div className="px-2 py-3 text-text-4 text-[11px]">
                      no other reasons to merge with
                    </div>
                  ) : (
                    otherIntents.map((r) => {
                      const checked = mergeWithTs === r.timestamp;
                      const fc = r.changeset?.files?.length ?? 0;
                      return (
                        <label
                          key={r.timestamp}
                          className={`flex items-start gap-2 px-2 py-1.5 text-[11.5px] cursor-pointer hover:bg-bg-2 ${
                            checked ? "bg-bg-2" : ""
                          }`}
                        >
                          <input
                            type="radio"
                            name="merge-target"
                            checked={checked}
                            onChange={() => setMergeWithTs(r.timestamp)}
                            disabled={busy}
                            className="mt-0.5 accent-accent-green"
                          />
                          <div className="flex-1 min-w-0">
                            <div className="text-text-1 truncate">{r.intent}</div>
                            <div className="text-text-5 text-[10.5px]">
                              {fc} file{fc === 1 ? "" : "s"} · {r.agent_id}
                            </div>
                          </div>
                        </label>
                      );
                    })
                  )}
                </div>
                <div className="text-text-5 text-[10.5px] mt-1">
                  The older reason is dropped; the newer one stays, with both texts joined.
                </div>
              </div>
            )}
          </>
        )}
        {err && <div role="alert" className="text-red text-[11px]">{err}</div>}
      </div>
    </Dialog>
  );
}

function ModeChip({
  id,
  current,
  onClick,
  children,
}: {
  id: Mode;
  current: Mode;
  onClick: (m: Mode) => void;
  children: React.ReactNode;
}) {
  const active = id === current;
  return (
    <button
      type="button"
      onClick={() => onClick(id)}
      className={`px-2 h-6 rounded text-[11px] uppercase tracking-wider ${
        active ? "bg-bg-2 text-text-1" : "text-text-4 hover:text-text-2"
      }`}
    >
      {children}
    </button>
  );
}
