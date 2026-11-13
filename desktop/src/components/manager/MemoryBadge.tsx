// Memory Bank UX signal for the Manager tab (KK.5).
//
// Renders a small "✓ Memory · N" pill in the ManagerSurface tab strip
// showing total memory entries loaded for the current repo, plus a
// popover with a section breakdown and an inline "Save to memory"
// affordance. Pulls from the existing `aura_memory_view` Tauri command
// (Stage 5D) — no new backend.
//
// Why a UX signal: the memory store is only useful if the user can *see*
// that memory is loaded. This indicator is the proof.

import { useCallback, useEffect, useState } from "react";
import { listen } from "@tauri-apps/api/event";
import { Plus } from "lucide-react";
import { api, type MemoryView } from "../../lib/api";
import { Button } from "../ui/button";
import { Popover, PopoverAnchor, PopoverContent, PopoverTrigger } from "../ui/popover";
import { Select } from "../ui/select";
import { ErrorNote } from "../ui/state";
import { Textarea } from "../ui/textarea";
import "../ui/memory-badge.css";

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
      title: "Checking what Aura remembers about this repository…",
    };
  if (!view)
    return {
      glyph: "·",
      count: null,
      title:
        "Aura couldn't read what it remembers about this repository just now. Click to try again.",
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

  // Stay live: every memory mutation emits `memory:changed` with the repo
  // root (see cmd_memory.rs), whether it came from this badge, the Memory
  // dialog, or an agent writing over the CLI. Without this the pill kept
  // claiming whatever it read when the pane mounted.
  useEffect(() => {
    const un = listen<string>("memory:changed", (e) => {
      if (!repoRoot || !e.payload || e.payload === repoRoot) void reload();
    });
    return () => {
      un.then((u) => u()).catch(() => {});
    };
  }, [repoRoot, reload]);

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

  // Outside click and Esc close it through the popover; closing also folds
  // the add form away, as it always has.
  const onOpenChange = (next: boolean) => {
    setOpen(next);
    if (!next) setAddOpen(false);
  };

  if (!repoRoot) return null;

  const pill = memoryPill(view, checked);

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
    <Popover open={open} onOpenChange={onOpenChange}>
      {headless ? (
        // No pill to anchor to: the panel opens from the chat tab's menu and
        // sits at the surface's top-right.
        <PopoverAnchor className="ui-memory-anchor" />
      ) : (
        <PopoverTrigger asChild>
          <Button
            type="button"
            variant="ghost"
            size="xs"
            className="ui-memory-pill"
            title={pill.title}
            data-empty={pill.count ? undefined : ""}
          >
            <span
              className="ui-status-dot"
              data-status={pill.count ? "review" : undefined}
              aria-hidden
            />
            Memory
            <span className="ui-memory-count">{pill.count ?? "—"}</span>
          </Button>
        </PopoverTrigger>
      )}
      <PopoverContent align="end" className="ui-memory">
        <header>
          <strong>Memory bank</strong>
        </header>
        {view && view.identity && <p className="ui-memory-identity">{view.identity}</p>}
        {view && view.stack.length > 0 && (
          <p className="ui-memory-stack" title={view.stack.join(" · ")}>
            {view.stack.join(" · ")}
          </p>
        )}
        <dl className="ui-memory-sections">
          {SECTIONS.map((name) => {
            const sec = view?.sections.find((s) => s.name === name);
            const count = sec?.entries.length ?? 0;
            return (
              <div key={name} data-empty={count > 0 ? undefined : ""}>
                <dt>{name.replace("_", " ")}</dt>
                <dd>{count}</dd>
              </div>
            );
          })}
        </dl>
        <div className="ui-memory-add">
          {addOpen ? (
            <>
              <Select
                value={section}
                onChange={setSection}
                aria-label="Memory section"
                options={SECTIONS.map((s) => ({
                  value: s,
                  label: s.replace("_", " "),
                }))}
              />
              <Textarea
                value={draft}
                onChange={(e) => setDraft(e.target.value)}
                placeholder="Add a fact, decision, or gotcha…"
                aria-label="Memory entry"
                rows={3}
              />
              {err && <ErrorNote>{err}</ErrorNote>}
              <div className="ui-pattern-actions">
                <Button
                  type="button"
                  variant="ghost"
                  size="xs"
                  onClick={() => {
                    setAddOpen(false);
                    setDraft("");
                    setErr(null);
                  }}
                >
                  Cancel
                </Button>
                <Button
                  type="button"
                  size="xs"
                  disabled={saving || !draft.trim()}
                  onClick={() => void save()}
                >
                  {saving ? "Saving…" : "Save"}
                </Button>
              </div>
            </>
          ) : (
            <Button
              type="button"
              variant="ghost"
              size="sm"
              className="ui-memory-add-open"
              onClick={() => setAddOpen(true)}
            >
              <Plus />
              Add to memory…
            </Button>
          )}
        </div>
      </PopoverContent>
    </Popover>
  );
}
