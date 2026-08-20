// PrLabelsCard — Stage 8D. Right-rail labels card with read + write.
//
// Reads the current PR's labels from `PrSummary.labels` (so it shares
// the prList round-trip — no extra round-trip per render) and the
// repo-wide universe of labels via `pr_labels_list` lazily on the
// first picker open. Writes go through `pr_labels_set` which diffs
// against current via gh and emits add/remove subcommands.
//
// Color rendering uses the GitHub-supplied hex (no `#` prefix). When
// missing or malformed we fall back to a neutral chip.

import { useEffect, useRef, useState } from "react";
import { api, type PrLabel } from "../../lib/api";
import { invalidatePrList, patchCachedPr } from "../../lib/prsCache";
import { invalidatePrDetail } from "../../lib/prDetailCache";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { AsciiSpinner } from "../ui/ascii-spinner";
import { useDismiss } from "../../lib/useDismiss";

type Props = {
  repoRoot: string;
  prNumber: number;
  initial: PrLabel[];
  /** Called after a successful labels set so the parent can refresh
   *  its PrSummary (and thus `initial`). */
  onChanged?: () => void;
};

export function PrLabelsCard({
  repoRoot,
  prNumber,
  initial,
  onChanged,
}: Props) {
  const [labels, setLabels] = useState<PrLabel[]>(initial);
  const [pickerOpen, setPickerOpen] = useState(false);
  const [collapsed, setCollapsed] = useState(false);

  useEffect(() => {
    setLabels(initial);
  }, [initial]);

  const onSet = async (names: string[]) => {
    try {
      await api.prLabelsSet(repoRoot, prNumber, names);
      // Optimistic update so the chip list reflects the picker's
      // selection while the parent's prList re-fetches.
      const next = (() => {
        const byName = new Map<string, PrLabel>();
        for (const l of labels) byName.set(l.name, l);
        return names.map(
          (n) => byName.get(n) ?? { name: n, color: "", description: "" },
        );
      })();
      setLabels(next);
      // Patch the cached PR list so other panes see the new labels
      // without a fresh `gh pr list` round-trip.
      patchCachedPr(repoRoot, prNumber, { labels: next });
      void invalidatePrList(repoRoot);
      void invalidatePrDetail(repoRoot, prNumber);
      onChanged?.();
    } catch (e) {
      console.error("pr_labels_set failed", e);
    } finally {
      setPickerOpen(false);
    }
  };

  return (
    <div className="rounded-lg border border-line-soft bg-bg-content overflow-visible relative">
      <div className="flex items-center gap-2 px-3.5 h-10 border-b border-line-soft/50">
        <button
          type="button"
          onClick={() => setCollapsed(!collapsed)}
          className="text-text-4 hover:text-text-1 flex items-center"
        >
          <svg
            width="11"
            height="11"
            viewBox="0 0 10 10"
            className={`transition-transform ${collapsed ? "-rotate-90" : ""}`}
          >
            <path
              d="M2 4l3 3 3-3"
              stroke="currentColor"
              strokeWidth="1.4"
              fill="none"
            />
          </svg>
        </button>
        <span className="text-base font-semibold text-text-1">Labels</span>
        <span className="text-sm text-text-4 tabular-nums">
          {labels.length}
        </span>
        <Button
          variant="ghost"
          size="icon-sm"
          onClick={() => setPickerOpen(true)}
          className="ml-auto w-5 h-5 text-text-4 hover:text-text-1 text-sm"
          title="Add label"
        >
          +
        </Button>
      </div>
      {!collapsed && (
        <div className="px-3.5 py-3">
          {labels.length === 0 ? (
            <Button
              variant="link"
              size="xs"
              onClick={() => setPickerOpen(true)}
              className="h-auto px-0 text-sm text-text-4 hover:text-text-1 no-underline hover:no-underline"
            >
              add a label
            </Button>
          ) : (
            <div className="flex flex-wrap gap-1.5">
              {labels.map((l) => (
                <LabelChip key={l.name} label={l} />
              ))}
            </div>
          )}
        </div>
      )}
      {pickerOpen && (
        <LabelPicker
          repoRoot={repoRoot}
          selected={labels.map((l) => l.name)}
          onApply={onSet}
          onClose={() => setPickerOpen(false)}
        />
      )}
    </div>
  );
}

export function LabelChip({ label }: { label: PrLabel }) {
  const bg = labelColor(label.color, 0.18);
  const fg = labelColor(label.color, 1.0);
  return (
    <span
      className="inline-flex items-center gap-1 px-2 h-5 rounded-full text-xs font-medium border"
      style={{
        backgroundColor: bg,
        borderColor: bg,
        color: fg,
      }}
      title={label.description || label.name}
    >
      <span
        className="w-1.5 h-1.5 rounded-full"
        style={{ backgroundColor: fg }}
      />
      {label.name}
    </span>
  );
}

function LabelPicker({
  repoRoot,
  selected,
  onApply,
  onClose,
}: {
  repoRoot: string;
  selected: string[];
  onApply: (names: string[]) => void;
  onClose: () => void;
}) {
  const [all, setAll] = useState<PrLabel[]>([]);
  const [filter, setFilter] = useState("");
  const [draft, setDraft] = useState<Set<string>>(new Set(selected));
  const [loading, setLoading] = useState(true);
  const ref = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    let cancelled = false;
    api
      .prLabelsList(repoRoot)
      .then((list) => {
        if (!cancelled) setAll(list);
      })
      .catch(() => {})
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [repoRoot]);

  // Click-outside to close.
  useDismiss(true, onClose, ref);

  const matches = all.filter((l) =>
    l.name.toLowerCase().includes(filter.toLowerCase()),
  );

  const toggle = (name: string) => {
    const next = new Set(draft);
    if (next.has(name)) next.delete(name);
    else next.add(name);
    setDraft(next);
  };

  return (
    <div
      ref={ref}
      className="absolute right-2 top-9 w-72 rounded-lg border border-line bg-bg-1 shadow-sm z-50 overflow-hidden"
    >
      <div className="p-2 border-b border-line-soft">
        <Input
          type="text"
          autoFocus
          placeholder="Filter labels…"
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
          className="h-7 text-sm"
        />
      </div>
      <div className="max-h-64 overflow-y-auto">
        {loading ? (
          <div className="flex items-center gap-1.5 text-text-4 text-sm px-3 py-3">
            <AsciiSpinner className="text-2xs" />
            <span>Loading labels…</span>
          </div>
        ) : matches.length === 0 ? (
          <div className="text-text-4 text-sm px-3 py-3">
            No labels match that.
          </div>
        ) : (
          matches.map((l) => (
            <button
              key={l.name}
              type="button"
              onClick={() => toggle(l.name)}
              className="w-full flex items-center gap-2 px-3 py-1.5 text-left hover:bg-state-hover transition-colors"
            >
              <input
                type="checkbox"
                checked={draft.has(l.name)}
                readOnly
                style={{ accentColor: "var(--color-accent)" }}
              />
              <LabelChip label={l} />
              {l.description && (
                <span className="ml-auto text-xs text-text-4 truncate max-w-[120px]">
                  {l.description}
                </span>
              )}
            </button>
          ))
        )}
      </div>
      <div className="flex items-center justify-end gap-1 p-2 border-t border-line-soft bg-bg-content">
        <Button variant="ghost" size="xs" onClick={onClose}>
          Cancel
        </Button>
        <Button
          variant="secondary"
          size="xs"
          onClick={() => onApply(Array.from(draft))}
        >
          Apply
        </Button>
      </div>
    </div>
  );
}

// ── helpers ────────────────────────────────────────────────────────

function labelColor(hex: string, alpha: number): string {
  const m = /^([0-9a-f]{6})$/i.exec(hex.trim());
  if (!m) return alpha === 1.0 ? "var(--color-text-2)" : "var(--color-bg-2)";
  const r = parseInt(m[1].slice(0, 2), 16);
  const g = parseInt(m[1].slice(2, 4), 16);
  const b = parseInt(m[1].slice(4, 6), 16);
  return `rgba(${r}, ${g}, ${b}, ${alpha})`;
}
