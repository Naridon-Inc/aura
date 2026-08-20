// Durable AST-level conflict resolver. Lists open ConflictedNode rows
// from `.aura/conflicts.jsonl` (jj-style: a conflict is a first-class
// persistent object, not a transient ribbon). Click a row → side-by-
// side ours/theirs editor → Resolve (ours / theirs / custom) writes
// the chosen body and stamps the row resolved_at + resolved_in_commit.

import { useCallback, useEffect, useMemo, useState } from "react";
import { Dialog } from "../Dialog";
import { AsciiSpinner } from "../ui/ascii-spinner";
import { Button } from "../ui/button";
import { api, type ConflictedNode } from "../../lib/api";
import { fetchAstConflicts, resolveAstConflict } from "../../lib/ambientCache";

type ConflictsDialogProps = {
  open: boolean;
  repoRoot: string;
  onClose: () => void;
};

type Strategy = "ours" | "theirs" | "custom";

export function ConflictsDialog({ open, repoRoot, onClose }: ConflictsDialogProps) {
  const [rows, setRows] = useState<ConflictedNode[]>([]);
  const [loading, setLoading] = useState(false);
  const [busy, setBusy] = useState(false);
  const [selected, setSelected] = useState<string | null>(null);
  const [strategy, setStrategy] = useState<Strategy>("ours");
  const [customBody, setCustomBody] = useState("");
  const [err, setErr] = useState<string | null>(null);
  const [showResolved, setShowResolved] = useState(false);

  const refresh = useCallback(async () => {
    if (!repoRoot) return;
    setLoading(true);
    setErr(null);
    try {
      const list = await fetchAstConflicts(repoRoot);
      setRows(list);
    } catch (e) {
      setErr(String(e));
    } finally {
      setLoading(false);
    }
  }, [repoRoot]);

  useEffect(() => {
    if (open) {
      setSelected(null);
      setStrategy("ours");
      setCustomBody("");
      setErr(null);
      void refresh();
    }
  }, [open, refresh]);

  const visibleRows = useMemo(
    () => rows.filter((r) => (showResolved ? true : r.resolved_at === null)),
    [rows, showResolved],
  );

  const target = useMemo(
    () => (selected ? rows.find((r) => r.id === selected) ?? null : null),
    [rows, selected],
  );

  // When the user picks a conflict, prefill the custom buffer with
  // whichever side they're already leaning toward so they can edit
  // a merged body without retyping.
  useEffect(() => {
    if (!target) {
      setCustomBody("");
      return;
    }
    setCustomBody(strategy === "theirs" ? target.theirs : target.ours);
  }, [target, strategy]);

  async function resolve() {
    if (!target) return;
    setBusy(true);
    setErr(null);
    try {
      const headSha = await api.gitShowHead(repoRoot, ".").catch(() => "");
      await resolveAstConflict(repoRoot, {
        conflict_id: target.id,
        strategy,
        custom_body: strategy === "custom" ? customBody : null,
        resolved_in_commit: headSha ? headSha.trim().split("\n")[0] : null,
      });
      setSelected(null);
      await refresh();
    } catch (e) {
      setErr(String(e));
    } finally {
      setBusy(false);
    }
  }

  const openCount = rows.filter((r) => r.resolved_at === null).length;

  return (
    <Dialog
      open={open}
      onClose={onClose}
      title={`Clashes to sort out (${openCount})`}
      width={780}
      footer={
        <>
          <label className="flex items-center gap-1.5 text-text-4 text-xs mr-auto select-none cursor-pointer">
            <input
              type="checkbox"
              checked={showResolved}
              onChange={(e) => setShowResolved(e.target.checked)}
            />
            Show resolved
          </label>
          <Button variant="ghost" size="xs" onClick={onClose}>
            Close
          </Button>
          <Button
            variant="default"
            size="xs"
            onClick={resolve}
            disabled={busy || !target}
            title={target ? strategyVerb(strategy) : "Pick a clash first"}
          >
            {busy ? "saving…" : target ? strategyVerb(strategy) : "Keep one"}
          </Button>
        </>
      }
    >
      <div className="space-y-2 text-sm">
        {err && <div role="alert" className="text-red text-xs">{err}</div>}
        {loading && rows.length === 0 && (
          <div className="flex items-center gap-1.5 text-text-4 text-xs">
            <AsciiSpinner className="text-xs leading-none" /> Looking for clashes…
          </div>
        )}
        {!loading && visibleRows.length === 0 && (
          <div className="text-text-4 text-xs">
            {showResolved ? "Nothing clashes." : "Nothing clashes right now."}
          </div>
        )}
        <div className="grid grid-cols-[260px_1fr] gap-2 max-h-[60vh]">
          <div className="overflow-y-auto border border-line-soft rounded">
            {visibleRows.map((row) => {
              const isSel = selected === row.id;
              const resolved = row.resolved_at !== null;
              return (
                <button
                  key={row.id}
                  type="button"
                  onClick={() => setSelected(isSel ? null : row.id)}
                  className={[
                    "w-full text-left px-2.5 py-1.5 border-b border-line-soft last:border-b-0 transition-colors",
                    isSel ? "bg-bg-3" : "hover:bg-state-hover",
                  ].join(" ")}
                >
                  <div className="flex items-center gap-1.5">
                    <span className="text-text-1 text-sm font-medium truncate flex-1">
                      {row.identifier}
                    </span>
                    {resolved && (
                      <span className="text-accent-green text-2xs">
                        ✓
                      </span>
                    )}
                  </div>
                  <div className="text-text-4 text-2xs truncate">{row.file}</div>
                  <div className="text-text-4 text-2xs truncate">
                    {row.ours_agent} vs {row.theirs_agent}
                  </div>
                </button>
              );
            })}
          </div>
          <div className="overflow-y-auto">
            {!target ? (
              <div className="text-text-4 text-xs p-2">
                Pick a clash on the left to sort out.
              </div>
            ) : (
              <div className="space-y-2">
                <div className="flex items-center gap-1.5">
                  <StrategyButton
                    cur={strategy}
                    val="ours"
                    label={`This one (${target.ours_agent})`}
                    onPick={setStrategy}
                  />
                  <StrategyButton
                    cur={strategy}
                    val="theirs"
                    label={`The other (${target.theirs_agent})`}
                    onPick={setStrategy}
                  />
                  <StrategyButton
                    cur={strategy}
                    val="custom"
                    label="Write my own"
                    onPick={setStrategy}
                  />
                </div>
                <div className="grid grid-cols-2 gap-2">
                  <Side label={`This one · ${target.ours_agent}`} body={target.ours} />
                  <Side label={`The other · ${target.theirs_agent}`} body={target.theirs} />
                </div>
                {strategy === "custom" && (
                  <div className="space-y-1">
                    <div className="section-label">
                      Your combined version
                    </div>
                    <textarea
                      value={customBody}
                      onChange={(e) => setCustomBody(e.target.value)}
                      rows={10}
                      className="w-full bg-bg-1 border border-line rounded px-2 py-1.5 text-text-1 text-xs font-mono outline-none focus:border-text-4 resize-y"
                    />
                  </div>
                )}
                <div className="text-text-4 text-2xs">
                  based on: <span className="font-mono">{target.base_hash || "(none)"}</span>
                  {target.resolved_in_commit && (
                    <>
                      {" · settled in: "}
                      <span className="font-mono">
                        {target.resolved_in_commit.slice(0, 8)}
                      </span>
                    </>
                  )}
                </div>
              </div>
            )}
          </div>
        </div>
      </div>
    </Dialog>
  );
}

// Plain action verb for the confirm button — non-engineers don't read
// "Resolve as ours/theirs/custom".
function strategyVerb(s: Strategy): string {
  if (s === "ours") return "Keep this one";
  if (s === "theirs") return "Keep the other";
  return "Use my version";
}

function StrategyButton({
  cur,
  val,
  label,
  onPick,
}: {
  cur: Strategy;
  val: Strategy;
  label: string;
  onPick: (s: Strategy) => void;
}) {
  const active = cur === val;
  return (
    <button
      type="button"
      onClick={() => onPick(val)}
      className={[
        "px-2 py-1 text-xs rounded border transition-colors",
        active
          ? "bg-bg-3 border-line text-text-1"
          : "bg-bg-1 border-line-soft text-text-3 hover:bg-state-hover",
      ].join(" ")}
    >
      {label}
    </button>
  );
}

function Side({ label, body }: { label: string; body: string }) {
  return (
    <div className="space-y-1">
      <div className="section-label">{label}</div>
      <pre className="bg-bg-1 border border-line-soft rounded p-1.5 max-h-48 overflow-auto text-xs font-mono text-text-3 whitespace-pre-wrap break-all">
        {body || "(empty)"}
      </pre>
    </div>
  );
}
