// Capture user-supplied intent text + claim a set of dirty files as the
// changeset that intent owns. Persists to `.aura/intent_log.jsonl` (with
// the `.aura/.intent_logged` marker) so the next commit passes the
// pre-commit Intent Verification gate, and so the History sidebar can
// answer "which intent owns the change to file X?" without guessing by
// timestamp. Mirrors the on-disk shape the MCP `aura_log_intent` tool
// would write — we just don't need a daemon roundtrip from inside the
// shell.

import { useEffect, useMemo, useState } from "react";
import { Dialog } from "../Dialog";
import { Alert, AlertDescription } from "../ui/alert";
import { AsciiSpinner } from "../ui/ascii-spinner";
import { Button } from "../ui/button";
import { Checkbox } from "../ui/checkbox";
import { Textarea } from "../ui/textarea";
import "../ui/log-note.css";
import { api, type GitStatusEntry, type IntentChangesetFile } from "../../lib/api";
import { basename, dirname } from "../../lib/paths";

type LogIntentDialogProps = {
  open: boolean;
  repoRoot: string;
  onClose: () => void;
  /** Optional starter text — used by the AuraWatch nudge bubble + the
   *  watchdog warning to pre-fill the textarea with a file reference so
   *  the user only has to type the *why*. */
  defaultText?: string;
  /** Source label written to the changeset record so the History sidebar
   *  can render the right tag (manual / save_sync_gate / agent_prompt). */
  source?: string;
  /** Optional pre-selected dirty paths. The Save & Sync gate passes the
   *  orphan list so the user only has to confirm coverage. */
  defaultPaths?: string[];
  /** Optional agent block id this intent originated from (option 2 path). */
  blockId?: string;
};

export function LogIntentDialog({
  open,
  repoRoot,
  onClose,
  defaultText,
  source,
  defaultPaths,
  blockId,
}: LogIntentDialogProps) {
  const [text, setText] = useState(defaultText ?? "");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [done, setDone] = useState(false);
  const [dirty, setDirty] = useState<GitStatusEntry[]>([]);
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const [loadingDirty, setLoadingDirty] = useState(false);

  useEffect(() => {
    if (!open) return;
    setText(defaultText ?? "");
    setErr(null);
    setBusy(false);
    setDone(false);
    setLoadingDirty(true);
    api
      .gitStatusV2(repoRoot)
      .then((entries) => {
        setDirty(entries);
        // Default selection: caller-supplied orphan list when present,
        // otherwise every dirty file. Either way the user can untick.
        const initial = new Set<string>();
        const seed = defaultPaths && defaultPaths.length > 0
          ? entries.filter((e) => defaultPaths.includes(e.path))
          : entries;
        seed.forEach((e) => initial.add(e.path));
        setPicked(initial);
      })
      .catch((e) => setErr(String(e)))
      .finally(() => setLoadingDirty(false));
  }, [open, defaultText, defaultPaths, repoRoot]);

  function toggle(path: string) {
    setPicked((prev) => {
      const next = new Set(prev);
      if (next.has(path)) next.delete(path);
      else next.add(path);
      return next;
    });
  }
  function pickAll() {
    setPicked(new Set(dirty.map((e) => e.path)));
  }
  function pickNone() {
    setPicked(new Set());
  }

  const changesetFiles: IntentChangesetFile[] = useMemo(
    () =>
      dirty
        .filter((e) => picked.has(e.path))
        .map((e) => ({
          path: e.path,
          status: (e.index || e.worktree || "M").trim() || "M",
        })),
    [dirty, picked],
  );

  async function save() {
    if (!text.trim()) return;
    setBusy(true);
    setErr(null);
    try {
      await api.auraLogIntent(repoRoot, text.trim(), "aura-shell", {
        files: changesetFiles,
        block_id: blockId ?? null,
        source: source ?? "manual",
      });
      setDone(true);
      window.dispatchEvent(new CustomEvent("aura:intent-logged", { detail: { repoRoot } }));
      setTimeout(() => onClose(), 600);
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
      title="Add a note"
      footer={
        <>
          <Button variant="outline" onClick={onClose}>
            Cancel
          </Button>
          <Button onClick={save} disabled={busy || !text.trim() || done}>
            {done
              ? "Saved"
              : busy
                ? "Saving…"
                : `Add note${picked.size ? ` · ${picked.size} file${picked.size === 1 ? "" : "s"}` : ""}`}
          </Button>
        </>
      }
    >
      <label className="ui-form-field">
        What changed, and why?
        <Textarea
          value={text}
          onChange={(e) => setText(e.target.value)}
          placeholder="Added a dark-mode toggle to the settings page so it's easier on the eyes at night"
          disabled={busy || done}
          rows={4}
          autoFocus
          onKeyDown={(e) => {
            if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) save();
          }}
        />
      </label>

      <section className="ui-log-note-files" aria-label="Files this note covers">
        <div className="ui-log-note-files-head">
          <span>Files this note covers</span>
          <span className="ui-log-note-count">
            {picked.size} of {dirty.length}
          </span>
          <Button
            variant="ghost"
            size="xs"
            onClick={pickAll}
            disabled={dirty.length === 0 || busy || done}
          >
            All
          </Button>
          <Button
            variant="ghost"
            size="xs"
            onClick={pickNone}
            disabled={dirty.length === 0 || busy || done}
          >
            None
          </Button>
        </div>
        <ul className="ui-log-note-list">
          {loadingDirty ? (
            <li className="ui-log-note-state" role="status">
              <AsciiSpinner />
              Looking for changes…
            </li>
          ) : dirty.length === 0 ? (
            <li className="ui-log-note-state">No changes to cover right now.</li>
          ) : (
            dirty.map((e) => {
              const checked = picked.has(e.path);
              const tag = (e.index || e.worktree || " ").trim() || "•";
              return (
                <li key={e.path}>
                  <label className="ui-check-label" data-unpicked={checked ? undefined : ""}>
                    <Checkbox
                      checked={checked}
                      onCheckedChange={() => toggle(e.path)}
                      disabled={busy || done}
                    />
                    <span className="ui-log-note-tag">{tag}</span>
                    <span className="ui-log-note-name" title={e.path}>
                      {basename(e.path)}
                    </span>
                    <span className="ui-log-note-dir">{dirname(e.path)}</span>
                  </label>
                </li>
              );
            })
          )}
        </ul>
        <p className="ui-log-note-help">
          The files you tick are the ones this note covers. Saving a version needs every changed
          file to have a note. Press ⌘↵ to save.
        </p>
      </section>

      {err && (
        <Alert variant="destructive">
          <AlertDescription>{err}</AlertDescription>
        </Alert>
      )}
    </Dialog>
  );
}
