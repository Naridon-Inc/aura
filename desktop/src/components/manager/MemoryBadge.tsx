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

export function MemoryBadge({ repoRoot, headless = false }: Props) {
  const [view, setView] = useState<MemoryView | null>(null);
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
      return;
    }
    try {
      const v = await api.auraMemoryView(repoRoot);
      setView(v);
    } catch {
      // best-effort — missing file returns empty view from backend
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

  useEffect(() => {
    if (!open) return;
    function onDoc(e: MouseEvent) {
      const t = e.target as Node | null;
      if (ref.current && t && !ref.current.contains(t)) {
        setOpen(false);
        setAddOpen(false);
      }
    }
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") {
        setOpen(false);
        setAddOpen(false);
      }
    }
    document.addEventListener("mousedown", onDoc);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDoc);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  if (!repoRoot) return null;

  const total =
    view?.sections.reduce((acc, s) => acc + s.entries.length, 0) ?? 0;
  const loaded = total > 0;
  const tone = loaded
    ? { color: "var(--color-text-1)" }
    : { color: "var(--color-text-3)" };

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
          title={
            loaded
              ? `${total} memory entries loaded — click to view or add`
              : "No memory entries yet — click to add one"
          }
          className="chip"
          style={tone}
        >
          <span aria-hidden style={{ fontSize: 10 }}>
            {loaded ? "✓" : "○"}
          </span>
          <span>Memory</span>
          <span className="text-text-3">·</span>
          <span>{total}</span>
        </button>
      )}
      {open && (
        <div
          className="absolute right-0 top-7 z-30 min-w-[260px] rounded-md py-1 shadow-lg text-[12px]"
          style={{
            background: "var(--color-bg-3)",
            border: "1px solid var(--color-line-soft)",
          }}
        >
          <div className="px-2.5 py-1.5 border-b border-line-soft text-[10px] uppercase tracking-wider text-text-3">
            Memory bank
          </div>
          {view && view.identity && (
            <div className="px-2.5 py-1 text-text-2 text-[11px]">
              {view.identity}
            </div>
          )}
          {view && view.stack.length > 0 && (
            <div className="px-2.5 pb-1 text-text-3 text-[10.5px] truncate">
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
                  className="bg-bg-1 border border-line-soft rounded px-1.5 py-1 text-[11.5px] resize-none"
                />
                {err && (
                  <div className="text-[10.5px] text-red" role="alert">
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
                    className="px-2 py-0.5 text-[11px] text-text-3 hover:text-text-1"
                  >
                    Cancel
                  </button>
                  <button
                    type="button"
                    disabled={saving || !draft.trim()}
                    onClick={() => void save()}
                    className="px-2 py-0.5 text-[11px] rounded bg-accent text-bg-0 disabled:opacity-40"
                  >
                    {saving ? "Saving…" : "Save"}
                  </button>
                </div>
              </div>
            ) : (
              <button
                type="button"
                onClick={() => setAddOpen(true)}
                className="w-full text-left px-1.5 py-1 text-text-2 hover:bg-bg-2 rounded text-[11.5px]"
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
