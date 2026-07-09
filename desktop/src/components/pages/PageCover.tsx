// PageCover — Plane-style 200px gradient strip at the top of a page.
//
// The note model doesn't carry a `cover` column yet, so we persist
// the user's choice in localStorage keyed by the page tuple. When
// the backend gains a `cover` frontmatter field, swap the storage
// hooks for an `api.notesWrite` call — see the TODO at the bottom
// of this file.
//
// Five preset gradients shipped — enough variety without becoming a
// design-system zoo. The picker is a Radix Popover with a 5×1 grid.

import { useEffect, useState } from "react";
import { ImagePlus, X } from "lucide-react";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "../ui/popover";
import { cn } from "../../lib/utils";

const COVER_PRESETS: { id: string; label: string; css: string }[] = [
  {
    id: "indigo-pink",
    label: "Indigo → Pink",
    css: "linear-gradient(135deg, #6366f1 0%, #ec4899 100%)",
  },
  {
    id: "emerald-cyan",
    label: "Emerald → Cyan",
    css: "linear-gradient(135deg, #10b981 0%, #06b6d4 100%)",
  },
  {
    id: "amber-rose",
    label: "Amber → Rose",
    css: "linear-gradient(135deg, #f59e0b 0%, #f43f5e 100%)",
  },
  {
    id: "slate",
    label: "Slate",
    css: "linear-gradient(135deg, #475569 0%, #1e293b 100%)",
  },
  {
    id: "violet-orange",
    label: "Violet → Orange",
    css: "linear-gradient(135deg, #8b5cf6 0%, #f97316 100%)",
  },
  {
    id: "teal-violet",
    label: "Teal → Violet",
    css: "linear-gradient(135deg, #14b8a6 0%, #7c3aed 100%)",
  },
];

const COVER_KEY_PREFIX = "aura.page.cover.";

function readCover(pageKey: string): string | null {
  try {
    return localStorage.getItem(COVER_KEY_PREFIX + pageKey);
  } catch {
    return null;
  }
}

function writeCover(pageKey: string, coverId: string | null) {
  try {
    if (coverId == null) {
      localStorage.removeItem(COVER_KEY_PREFIX + pageKey);
    } else {
      localStorage.setItem(COVER_KEY_PREFIX + pageKey, coverId);
    }
  } catch {
    /* localStorage denied — UI still updates for the session */
  }
  // TODO(backend): when `NoteFrontmatter.cover_id` lands, replace the
  // two localStorage calls above with:
  //   await api.notesWrite({ repoRoot, scope, bucket, id, body, cover_id: coverId })
  // and read it back via `activeNote.frontmatter.cover_id`. Storage
  // path: aura-cli/src/notes.rs `NoteFrontmatter` struct + Tauri
  // `notes_write` arg pass-through.
}

type Props = {
  pageKey: string;
  className?: string;
};

export function PageCover({ pageKey, className }: Props) {
  const [coverId, setCoverId] = useState<string | null>(() => readCover(pageKey));
  const [open, setOpen] = useState(false);

  useEffect(() => {
    setCoverId(readCover(pageKey));
  }, [pageKey]);

  const preset = coverId
    ? COVER_PRESETS.find((p) => p.id === coverId) ?? null
    : null;

  // When no cover is set, render nothing — the parent's PageDocHead
  // row handles the inline "Add cover" affordance so we don't waste
  // a full row of vertical space on every page.
  if (!preset) return null;

  return (
    <div className={cn("relative w-full", className)}>
      <div
        className="w-full h-[200px]"
        style={{ background: preset.css }}
        aria-label={`Cover: ${preset.label}`}
        role="img"
      />
      <div className="absolute right-3 bottom-3 flex items-center gap-1">
        <Popover open={open} onOpenChange={setOpen}>
          <PopoverTrigger asChild>
            <button
              type="button"
              className="h-7 px-2 inline-flex items-center gap-1.5 text-[11.5px] text-text-1 bg-black/40 hover:bg-black/60 rounded-md backdrop-blur-sm transition-colors"
            >
              <ImagePlus
                className="w-3.5 h-3.5"
                strokeWidth={1.5}
                aria-hidden
              />
              Change cover
            </button>
          </PopoverTrigger>
          <PopoverContent
            align="end"
            className="w-[280px] p-2 bg-bg-chrome border border-line-soft"
          >
            <CoverPicker
              activeId={preset.id}
              onPick={(id) => {
                setCoverId(id);
                writeCover(pageKey, id);
                setOpen(false);
              }}
            />
          </PopoverContent>
        </Popover>
        <button
          type="button"
          onClick={() => {
            setCoverId(null);
            writeCover(pageKey, null);
          }}
          title="Remove cover"
          className="w-7 h-7 grid place-items-center text-text-1 bg-black/40 hover:bg-black/60 rounded-md backdrop-blur-sm transition-colors"
        >
          <X className="w-3.5 h-3.5" strokeWidth={1.5} aria-hidden />
        </button>
      </div>
    </div>
  );
}

function CoverPicker({
  activeId,
  onPick,
}: {
  activeId?: string;
  onPick: (id: string) => void;
}) {
  return (
    <div>
      <div className="text-[10.5px] uppercase tracking-wider text-text-5 mb-2 px-1">
        Gradient covers
      </div>
      <div className="grid grid-cols-3 gap-2">
        {COVER_PRESETS.map((p) => (
          <button
            key={p.id}
            type="button"
            onClick={() => onPick(p.id)}
            title={p.label}
            className={cn(
              "h-12 rounded-md border transition-all",
              activeId === p.id
                ? "border-accent ring-1 ring-accent"
                : "border-line-soft hover:border-text-4",
            )}
            style={{ background: p.css }}
            aria-label={p.label}
          />
        ))}
      </div>
    </div>
  );
}
