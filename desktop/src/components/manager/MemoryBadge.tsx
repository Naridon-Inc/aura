// Memory Bank UX signal for the Manager tab (KK.5).
//
// Renders a small "✓ Memory · N" pill in the ManagerSurface tab strip
// showing total memory entries loaded for the current repo, plus a
// popover with a section breakdown and an inline "Save to memory"
// affordance. Pulls from the existing `aura_memory_view` Tauri command
// (Stage 5D) — no new backend.
//
// Why a UX signal: aura_memory_* is more capable than competitor
// "Memory Banks" but the user has no way to *see* that memory is
// loaded. This indicator is the proof.

import { useCallback, useEffect, useRef, useState } from "react";
import { api, type MemoryView } from "../../lib/api";
import { Select } from "../ui/select";
import { useDismiss } from "../../lib/useDismiss";

const SECTIONS = [
  "architecture",
  "decisions",
  "conventions",
  "gotchas",
  "context",
  "active_work",
];

type Props = {
  repoRoot: string | null;
  /** When true, render no pill trigger — the popover opens purely from the
   *  `aura:manager:open-memory` event (the chat-tab right-click menu),
   *  anchored top-right. Used when the surface has no own header bar. */
  headless?: boolean;
};

/** What the pill is entitled to claim.
 *
 *  This chip exists to be *proof* that memory is loaded — that's the whole
 *  argument in the header comment above. It read its count as
 *  `view?.sections… ?? 0`, so before the first read returned — and permanently
 *  after one threw, since the catch below is silent — it rendered "○ Memory ·
 *  0" and said "No memory entries yet". A pill whose job is to prove something
 *  was reporting the opposite from never having looked. `null` is the third
 *  state and it now has one. */
export function memoryPill(
  view: MemoryView | null,
  checked: boolean,
): { glyph: string; count: number | null; title: string } {
  if (!checked)
    return {
      glyph: "·",
      count: null,
      title: "Checking what Aura remembers about this project…",
    };
  if (!view)
    return {
      glyph: "·",
      count: null,
      title:
        "Aura couldn't read what it remembers about this project just now. Click to try again.",
    };
  const count = view.sections.reduce((acc, s) => acc + s.entries.length, 0);
  return count > 0
    ? {
        glyph: "✓",
        count,
        title: `${count} memory entries loaded. Click to view or add`,
      }
    : {
        glyph: "○",
        count: 0,
        title: "No memory entries yet. Click to add one",
      };
}

export function MemoryBadge({ repoRoot, headless = false }: Props) {
  const [view, setView] = useState<MemoryView | null>(null);
  /** Whether a read has completed at all — without it, "not yet" and "none"
   *  are the same value. */
  const [checked, setChecked] = useState(false);
  const [open, setOpen] = useState(false);
  const [addOpen, setAddOpen] = useState(false);
  const [section, setSection] = useState<string>("decisions");
  const [draft, setDraft] = useState("");
  const [saving, setSaving] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const ref = useRef<HTMLDivElement | null>(null);

  const reload = useCallback(async () => {
    if (!repoRoot) {
      setView(null);
      setChecked(false);
      return;
    }
    try {
      const v = await api.auraMemoryView(repoRoot);
      setView(v);
    } catch {
      // A missing memory file returns an empty view rather than throwing, so
      // reaching here means the read itself failed. Leave `view` null and let
      // `checked` mark that we looked — the pill says "couldn't read" instead
      // of standing in for "nothing remembered".
      setView(null);
    } finally {
      setChecked(true);
    }
  }, [repoRoot]);

  useEffect(() => {
    void reload();
  }, [reload]);

  // Headless mode opens from the chat-tab right-click menu, which fires this
  // event (the surface carries no own pill to click).
  useEffect(() => {
    function onOpen() {
      setOpen(true);
      void reload();
    }
    window.addEventListener("aura:manager:open-memory", onOpen);
    return () => window.removeEventListener("aura:manager:open-memory", onOpen);
  }, [reload]);

  useDismiss(
    open,
    () => {
      setOpen(false);
      setAddOpen(false);
    },
    ref,
  );

  if (!repoRoot) return null;

  const pill = memoryPill(view, checked);
  const tone =
    pill.count === null || pill.count === 0
      ? { color: "var(--color-text-3)" }
      : { color: "var(--color-text-1)" };

  async function save() {
    if (!repoRoot || !draft.trim() || !section) return;
    setSaving(true);
    setErr(null);
    try {
      await api.auraMemoryWriteEntry(repoRoot, section, draft.trim(), []);
      setDraft("");
      setAddOpen(false);
      await reload();
    } catch (e) {
      setErr(String(e));
    } finally {
      setSaving(false);
    }
  }

  return (
    <div
      ref={ref}
      className={headless ? "fixed top-11 right-3 z-40" : "relative"}
    >
      {!headless && (
        <button
          type="button"
          onClick={() => setOpen((v) => !v)}
          title={pill.title}
          className="chip"
          style={tone}
        >
          <span aria-hidden style={{ fontSize: 10 }}>
            {pill.glyph}
          </span>
          <span>Memory</span>
          <span className="text-text-3">·</span>
          <span className="tabular-nums">{pill.count ?? "—"}</span>
        </button>
      )}
      {open && (
        <div
          className="absolute right-0 top-7 z-30 min-w-[260px] rounded-md py-1 shadow-lg text-sm"
          style={{
            background: "var(--color-bg-3)",
            border: "1px solid var(--color-line-soft)",
          }}
        >
          <div className="section-label px-2.5 py-1.5 border-b border-line-soft">
            Memory bank
          </div>
          {view && view.identity && (
            <div className="px-2.5 py-1 text-text-2 text-xs">
              {view.identity}
            </div>
          )}
          {view && view.stack.length > 0 && (
            <div className="px-2.5 pb-1 text-text-3 text-xs truncate">
              {view.stack.join(" · ")}
            </div>
          )}
          <div className="px-2.5 py-1">
            {SECTIONS.map((name) => {
              const sec = view?.sections.find((s) => s.name === name);
              const count = sec?.entries.length ?? 0;
              return (
                <div
                  key={name}
                  className="flex items-center justify-between py-0.5"
                >
                  <span className="text-text-2 capitalize">
                    {name.replace("_", " ")}
                  </span>
                  <span
                    className={count > 0 ? "text-text-1" : "text-text-4"}
                    style={{ fontVariantNumeric: "tabular-nums" }}
                  >
                    {count}
                  </span>
                </div>
              );
            })}
          </div>
          <div className="border-t border-line-soft mt-1 px-1.5 py-1 flex flex-col gap-1">
            {addOpen ? (
              <div className="flex flex-col gap-1.5 p-1">
                <Select
                  value={section}
                  onChange={setSection}
                  aria-label="Memory section"
                  options={SECTIONS.map((s) => ({
                    value: s,
                    label: s.replace("_", " "),
                  }))}
                />
                <textarea
                  value={draft}
                  onChange={(e) => setDraft(e.target.value)}
                  placeholder="Add a fact, decision, or gotcha…"
                  rows={3}
                  className="bg-bg-1 border border-line-soft rounded px-1.5 py-1 text-sm resize-none"
                />
                {err && (
                  <div className="text-xs text-red" role="alert">
                    {err}
                  </div>
                )}
                <div className="flex justify-end gap-1">
                  <button
                    type="button"
                    onClick={() => {
                      setAddOpen(false);
                      setDraft("");
                      setErr(null);
                    }}
                    className="px-2 py-0.5 text-xs text-text-3 hover:text-text-1"
                  >
                    Cancel
                  </button>
                  <button
                    type="button"
                    disabled={saving || !draft.trim()}
                    onClick={() => void save()}
                    className="px-2 py-0.5 text-xs rounded bg-accent text-bg-0 disabled:opacity-40"
                  >
                    {saving ? "Saving…" : "Save"}
                  </button>
                </div>
              </div>
            ) : (
              <button
                type="button"
                onClick={() => setAddOpen(true)}
                className="w-full text-left px-1.5 py-1 text-text-2 hover:bg-state-hover rounded text-sm"
              >
                + Add to memory…
              </button>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
