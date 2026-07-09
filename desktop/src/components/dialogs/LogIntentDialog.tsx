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
import { Button } from "../ui/button";
import { api, type GitStatusEntry, type IntentChangesetFile } from "../../lib/api";

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

function shortName(p: string): string {
  const i = p.lastIndexOf("/");
  return i >= 0 ? p.slice(i + 1) : p;
}
function dirNameOf(p: string): string {
  const i = p.lastIndexOf("/");
  return i > 0 ? p.slice(0, i) : "";
}

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
          <Button variant="ghost" size="xs" onClick={onClose}>
            Cancel
          </Button>
          <Button
            variant="default"
            size="xs"
            onClick={save}
            disabled={busy || !text.trim() || done}
          >
            {done
              ? "saved ✓"
              : busy
                ? "saving…"
                : `Add note${picked.size ? ` · ${picked.size} file${picked.size === 1 ? "" : "s"}` : ""}`}
          </Button>
        </>
      }
    >
      <div className="space-y-3 text-[11.5px]">
        <div>
          <div className="text-text-4 text-[10.5px] uppercase tracking-wider mb-1">
            What changed, and why?
          </div>
          <textarea
            value={text}
            onChange={(e) => setText(e.target.value)}
            placeholder="Added a dark-mode toggle to the settings page so it's easier on the eyes at night"
            disabled={busy || done}
            rows={4}
            autoFocus
            onKeyDown={(e) => {
              if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) save();
            }}
            className="w-full bg-bg-1 border border-line rounded px-2 py-1.5 text-text-1 text-[12px] outline-none focus:border-text-4 resize-y leading-relaxed"
            style={{ minHeight: 96 }}
          />
        </div>

        <div>
          <div className="flex items-center mb-1">
            <span className="text-text-4 text-[10.5px] uppercase tracking-wider">
              Files this note covers · {picked.size} of {dirty.length}
            </span>
            <div className="ml-auto flex items-center gap-1">
              <button
                type="button"
                onClick={pickAll}
                disabled={dirty.length === 0 || busy || done}
                className="text-[10.5px] text-text-3 hover:text-text-1 disabled:opacity-40"
              >
                all
              </button>
              <span className="text-text-5">·</span>
              <button
                type="button"
                onClick={pickNone}
                disabled={dirty.length === 0 || busy || done}
                className="text-[10.5px] text-text-3 hover:text-text-1 disabled:opacity-40"
              >
                none
              </button>
            </div>
          </div>
          <div className="border border-line-soft rounded bg-bg-0 max-h-[180px] overflow-y-auto">
            {loadingDirty ? (
              <div className="px-2 py-3 text-text-4 text-[11px]">scanning…</div>
            ) : dirty.length === 0 ? (
              <div className="px-2 py-3 text-text-4 text-[11px]">no changes to cover right now</div>
            ) : (
              dirty.map((e) => {
                const checked = picked.has(e.path);
                const tag = (e.index || e.worktree || " ").trim() || "•";
                return (
                  <label
                    key={e.path}
                    className={`flex items-center gap-2 px-2 py-1 text-[11.5px] cursor-pointer hover:bg-bg-2 ${
                      checked ? "" : "opacity-55"
                    }`}
                  >
                    <input
                      type="checkbox"
                      checked={checked}
                      onChange={() => toggle(e.path)}
                      disabled={busy || done}
                      className="accent-accent-green"
                    />
                    <span className="w-3 text-[10px] font-mono text-text-4">{tag}</span>
                    <span className="text-text-1 truncate" title={e.path}>
                      {shortName(e.path)}
                    </span>
                    <span className="ml-auto text-text-5 text-[10.5px] font-mono truncate">
                      {dirNameOf(e.path)}
                    </span>
                  </label>
                );
              })
            )}
          </div>
          <div className="text-text-5 text-[10.5px] mt-1">
            The files you tick are the ones this note covers. Saving a version needs every changed
            file to have a note.
          </div>
        </div>

        <div className="text-text-5 text-[10.5px]">
          Press ⌘↵ to save this note
        </div>
        {err && <div className="text-red text-[11px]">{err}</div>}
      </div>
    </Dialog>
  );
}
