// Surgically edit an existing intent: split it by partitioning its
// claimed files into a new intent, or merge it with another recent intent
// so the changesets unite. The History sidebar pops this from a
// right-click on any intent row.

import { useEffect, useMemo, useState } from "react";
import { Check } from "lucide-react";
import { Dialog } from "../Dialog";
import { Alert, AlertDescription } from "../ui/alert";
import { Button } from "../ui/button";
import { Checkbox } from "../ui/checkbox";
import { Textarea } from "../ui/textarea";
import { ToggleGroup, ToggleGroupItem } from "../ui/toggle-group";
import "../ui/log-note.css";
import "../ui/intent-edit.css";
import { api, type IntentRow } from "../../lib/api";
import { fetchIntentRows } from "../../lib/intentCache";
import { basename, dirname } from "../../lib/paths";

type Mode = "split" | "merge";

type Props = {
  open: boolean;
  repoRoot: string;
  /** Timestamp of the intent the user right-clicked. Acts as the primary
   *  key into `.aura/intent_log.jsonl`. */
  intentTs: number | null;
  onClose: () => void;
};
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
    fetchIntentRows(repoRoot, 50)
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
      setErr("Pick at least one file to move into the new reason.");
      return;
    }
    if (!newIntent.trim()) {
      setErr("Type the new reason.");
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
          <Button variant="outline" onClick={onClose}>
            Cancel
          </Button>
          {mode === "split" ? (
            <Button
              onClick={runSplit}
              disabled={busy || !target || moveSet.size === 0 || !newIntent.trim()}
            >
              {busy ? "Splitting…" : `Split · ${moveSet.size} file${moveSet.size === 1 ? "" : "s"}`}
            </Button>
          ) : (
            <Button onClick={runMerge} disabled={busy || !target || mergeWithTs === null}>
              {busy ? "Merging…" : "Merge"}
            </Button>
          )}
        </>
      }
    >
      {!target ? (
        <p className="ui-log-note-state">No reason selected.</p>
      ) : (
        <>
          <section className="ui-intent-edit-original" aria-label="Original reason">
            <h3>Original reason</h3>
            <p>{target.intent}</p>
            <small>
              {targetFiles.length} file{targetFiles.length === 1 ? "" : "s"} · {target.agent_id}
            </small>
          </section>

          <ToggleGroup
            type="single"
            variant="outline"
            size="sm"
            className="ui-intent-edit-mode"
            aria-label="Split or merge this reason"
            value={mode}
            // A single group reports "" when the pressed choice is pressed
            // again; one mode is always chosen.
            onValueChange={(next) => {
              if (next === "split" || next === "merge") setMode(next);
            }}
          >
            <ToggleGroupItem value="split">Split</ToggleGroupItem>
            <ToggleGroupItem value="merge">Merge</ToggleGroupItem>
          </ToggleGroup>

          {mode === "split" ? (
            <>
              <section className="ui-log-note-files" aria-label="Files to move">
                <div className="ui-log-note-files-head">
                  <span>Move these files into a new reason</span>
                  <span className="ui-log-note-count">
                    {moveSet.size} of {targetFiles.length}
                  </span>
                </div>
                <ul className="ui-log-note-list">
                  {targetFiles.length === 0 ? (
                    <li className="ui-log-note-state">This reason covers no files.</li>
                  ) : (
                    targetFiles.map((f) => {
                      const checked = moveSet.has(f.path);
                      return (
                        <li key={f.path}>
                          <label
                            className="ui-check-label"
                            data-unpicked={checked ? undefined : ""}
                          >
                            <Checkbox
                              checked={checked}
                              onCheckedChange={() => toggleMove(f.path)}
                              disabled={busy}
                            />
                            <span className="ui-log-note-tag">{(f.status || "M").trim()}</span>
                            <span className="ui-log-note-name" title={f.path}>
                              {basename(f.path)}
                            </span>
                            <span className="ui-log-note-dir">{dirname(f.path)}</span>
                          </label>
                        </li>
                      );
                    })
                  )}
                </ul>
              </section>
              <label className="ui-form-field ui-intent-edit-field">
                New reason
                <Textarea
                  value={newIntent}
                  onChange={(e) => setNewIntent(e.target.value)}
                  placeholder="What were these files actually for?"
                  disabled={busy}
                  rows={3}
                />
              </label>
            </>
          ) : (
            <section className="ui-log-note-files" aria-label="Merge with">
              <div className="ui-log-note-files-head">
                <span id="intent-merge-with">Merge with</span>
              </div>
              <ul
                className="ui-log-note-list ui-intent-edit-targets"
                role="radiogroup"
                aria-labelledby="intent-merge-with"
              >
                {otherIntents.length === 0 ? (
                  <li className="ui-log-note-state">No other reasons to merge with.</li>
                ) : (
                  otherIntents.map((r) => {
                    const checked = mergeWithTs === r.timestamp;
                    const fc = r.changeset?.files?.length ?? 0;
                    return (
                      <li key={r.timestamp}>
                        <button
                          type="button"
                          role="radio"
                          aria-checked={checked}
                          className="ui-intent-edit-target"
                          onClick={() => setMergeWithTs(r.timestamp)}
                          disabled={busy}
                        >
                          <Check aria-hidden />
                          <span>
                            <strong>{r.intent}</strong>
                            <small>
                              {fc} file{fc === 1 ? "" : "s"} · {r.agent_id}
                            </small>
                          </span>
                        </button>
                      </li>
                    );
                  })
                )}
              </ul>
              <p className="ui-log-note-help">
                The older reason is dropped; the newer one stays, with both texts joined.
              </p>
            </section>
          )}
        </>
      )}
      {err && (
        <Alert variant="destructive" className="ui-intent-edit-alert">
          <AlertDescription>{err}</AlertDescription>
        </Alert>
      )}
    </Dialog>
  );
}
