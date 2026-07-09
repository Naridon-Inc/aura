// PageIcon — 64×64 emoji button under the cover, picker on click.
//
// Backend doesn't store an icon yet (no `NoteFrontmatter.icon`), so
// the picker writes through localStorage keyed by the page tuple.
// See the TODO at writeIcon() for the backend swap.
//
// No external emoji-mart dependency: we ship a curated grid of ~60
// common emojis grouped into 5 sections (Tip / Status / Faces /
// Symbols / Objects). For users who want a specific emoji not in
// the grid, the input on the picker accepts pasted emoji — anything
// they type/paste replaces the icon.

import { useEffect, useState } from "react";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "../ui/popover";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { cn } from "../../lib/utils";

const ICON_KEY_PREFIX = "aura.page.icon.";

const EMOJI_GROUPS: { label: string; emojis: string[] }[] = [
  {
    label: "Tip",
    emojis: ["💡", "📝", "📌", "📍", "🎯", "🔥", "⭐", "🚀", "✨", "🏁"],
  },
  {
    label: "Status",
    emojis: ["✅", "⚠️", "🛑", "❌", "🟢", "🟡", "🔴", "⏳", "🔒", "🔓"],
  },
  {
    label: "Faces",
    emojis: ["😀", "🙂", "🤔", "🧠", "😴", "🤯", "🥳", "😎", "🤖", "👀"],
  },
  {
    label: "Symbols",
    emojis: ["📚", "📖", "🗂️", "🗃️", "📦", "🧩", "🧪", "⚙️", "🔧", "🔍"],
  },
  {
    label: "Things",
    emojis: ["💻", "🖥️", "📱", "🌐", "📊", "📈", "💬", "🎨", "🎵", "🍕"],
  },
];

function readIcon(pageKey: string): string | null {
  try {
    return localStorage.getItem(ICON_KEY_PREFIX + pageKey);
  } catch {
    return null;
  }
}

function writeIcon(pageKey: string, icon: string | null) {
  try {
    if (icon == null) {
      localStorage.removeItem(ICON_KEY_PREFIX + pageKey);
    } else {
      localStorage.setItem(ICON_KEY_PREFIX + pageKey, icon);
    }
  } catch {
    /* localStorage denied; UI state still flips for the session */
  }
  // TODO(backend): replace localStorage with a write through
  // `api.notesWrite({ ..., icon })` when `NoteFrontmatter.icon` is
  // added. Storage: aura-cli/src/notes.rs.
}

type Props = {
  pageKey: string;
  /** Visual nudge — when a cover is present we negative-margin the
   *  icon so it overlaps the cover/title break, like Notion. */
  hasCover?: boolean;
  className?: string;
};

export function PageIcon({ pageKey, hasCover = false, className }: Props) {
  const [icon, setIcon] = useState<string | null>(() => readIcon(pageKey));
  const [open, setOpen] = useState(false);

  useEffect(() => {
    setIcon(readIcon(pageKey));
  }, [pageKey]);

  // No icon set — render nothing. The PageDocHead row above the
  // title carries the inline "Add icon" affordance so we don't
  // waste a row of vertical space on every page.
  if (!icon) return null;

  return (
    <div
      className={cn(
        hasCover ? "-mt-8 relative z-[1]" : "",
        className,
      )}
    >
      <Popover open={open} onOpenChange={setOpen}>
        <PopoverTrigger asChild>
          <button
            type="button"
            className={cn(
              "w-16 h-16 flex items-center justify-center text-[44px] leading-none",
              "rounded-md hover:bg-bg-2 transition-colors",
              hasCover && "bg-bg-content shadow-sm",
            )}
            title="Change icon"
          >
            <span aria-hidden>{icon}</span>
          </button>
        </PopoverTrigger>
        <PopoverContent
          align="start"
          className="w-[300px] p-2 bg-bg-chrome border border-line-soft"
        >
          <EmojiPicker
            activeIcon={icon}
            onClear={() => {
              setIcon(null);
              writeIcon(pageKey, null);
              setOpen(false);
            }}
            onPick={(e) => {
              setIcon(e);
              writeIcon(pageKey, e);
              setOpen(false);
            }}
          />
        </PopoverContent>
      </Popover>
    </div>
  );
}

function EmojiPicker({
  activeIcon,
  onPick,
  onClear,
}: {
  activeIcon?: string;
  onPick: (emoji: string) => void;
  onClear?: () => void;
}) {
  const [custom, setCustom] = useState("");
  return (
    <div className="space-y-3">
      <div className="flex items-center gap-2">
        <Input
          type="text"
          value={custom}
          onChange={(e) => setCustom(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && custom.trim()) {
              onPick(custom.trim());
              setCustom("");
            }
          }}
          placeholder="Paste any emoji"
          maxLength={4}
          className="flex-1 h-7 text-[12px]"
        />
        {onClear && (
          <Button
            variant="ghost"
            onClick={onClear}
            className="h-7 px-2 text-[11px] text-text-4 hover:text-text-1"
          >
            Remove
          </Button>
        )}
      </div>
      <div className="max-h-[260px] overflow-y-auto pr-1 space-y-3">
        {EMOJI_GROUPS.map((g) => (
          <div key={g.label}>
            <div className="text-[10px] uppercase tracking-wider text-text-5 mb-1.5 px-0.5">
              {g.label}
            </div>
            <div className="grid grid-cols-10 gap-0.5">
              {g.emojis.map((e) => (
                <button
                  key={e}
                  type="button"
                  onClick={() => onPick(e)}
                  className={cn(
                    "w-6 h-6 grid place-items-center text-[16px] rounded transition-colors",
                    e === activeIcon
                      ? "bg-accent/20 ring-1 ring-accent"
                      : "hover:bg-bg-2",
                  )}
                  title={e}
                >
                  <span aria-hidden>{e}</span>
                </button>
              ))}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
