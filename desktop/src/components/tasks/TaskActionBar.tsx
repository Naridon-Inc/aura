// TaskActionBar — RR.5. Right-cluster of icon actions for the task
// detail surfaces (TaskDetailSidePanel, TaskDetailPane).
//
// Plane's `.page-doc-actions` ordering is
//   Publish · Lock · Move · CopyLink · Favorite · Share · Side · More
//
// We ship the subset whose actions exist in the Aura task model
// today (CopyLink → AURA-N to clipboard; Side → close panel; More
// → kebab popover w/ Delete). Favorite/Share/Lock/Move/Publish are
// intentionally omitted rather than stubbed; they land when their
// backend fields land. The visual treatment matches Plane: 28×28
// iconbtns with rounded-md and a thin `.sep-v` divider between the
// primary action group and the surface toggles.

import { useEffect, useRef, useState } from "react";
import { Link2, Eye, MoreHorizontal, Trash2 } from "lucide-react";
import { cn } from "../../lib/utils";
import { MENU_PANEL } from "../ui/menuSurface";
import { Button } from "../ui/button";

type Props = {
  /** Human handle copied to clipboard from the link button.
   *  Typically `AURA-{sequence_id}`. */
  copyText: string;
  /** Toggles the parent surface — for the side panel this means
   *  "close"; for the detail pane it can mean "fold to side". */
  onClose: () => void;
  /** Kebab → Delete. Fires after user confirms via the parent's
   *  existing flow (no confirmation dialog inside the bar). */
  onDelete: () => void;
  className?: string;
};

export function TaskActionBar({
  copyText,
  onClose,
  onDelete,
  className,
}: Props) {
  const [copied, setCopied] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);
  const menuRef = useRef<HTMLDivElement | null>(null);

  // Outside-click dismisses the kebab popover. The bar lives inside
  // a header that can scroll, so we listen on document rather than
  // wrap in a Popover primitive (which would re-anchor unnecessarily).
  useEffect(() => {
    if (!menuOpen) return;
    function onDoc(e: MouseEvent) {
      if (!menuRef.current?.contains(e.target as Node)) {
        setMenuOpen(false);
      }
    }
    document.addEventListener("mousedown", onDoc);
    return () => document.removeEventListener("mousedown", onDoc);
  }, [menuOpen]);

  async function copy() {
    try {
      await navigator.clipboard.writeText(copyText);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1500);
    } catch {
      // Clipboard API can fail when the surface isn't focused (e.g.
      // some webview contexts). Silent — user can copy via the
      // TaskIdChip in the header as a fallback.
    }
  }

  return (
    <div className={cn("inline-flex items-center gap-0.5", className)}>
      <IconBtn
        onClick={copy}
        title={copied ? "Copied!" : `Copy ${copyText}`}
        ariaLabel="Copy task link"
      >
        <Link2 className="w-3.5 h-3.5" strokeWidth={1.75} aria-hidden />
      </IconBtn>
      <Sep />
      <IconBtn onClick={onClose} title="Close panel" ariaLabel="Close panel">
        <Eye className="w-3.5 h-3.5" strokeWidth={1.75} aria-hidden />
      </IconBtn>
      <div className="relative" ref={menuRef}>
        <IconBtn
          onClick={() => setMenuOpen((v) => !v)}
          title="More actions"
          ariaLabel="More actions"
          active={menuOpen}
        >
          <MoreHorizontal className="w-3.5 h-3.5" strokeWidth={1.75} aria-hidden />
        </IconBtn>
        {menuOpen && (
          <div
            role="menu"
            className={cn(MENU_PANEL, "absolute right-0 top-full mt-1 w-[160px]")}
          >
            <Button
              type="button"
              variant="ghost"
              size="xs"
              onClick={() => {
                setMenuOpen(false);
                onDelete();
              }}
              className="w-full justify-start gap-2.5 rounded-md px-2 py-1.5 h-auto text-[13px] text-red hover:bg-red/10 hover:text-red"
            >
              <Trash2 className="w-3.5 h-3.5" strokeWidth={1.75} aria-hidden />
              Delete task
            </Button>
          </div>
        )}
      </div>
    </div>
  );
}

function IconBtn({
  onClick,
  title,
  ariaLabel,
  active = false,
  children,
}: {
  onClick: () => void;
  title: string;
  ariaLabel: string;
  active?: boolean;
  children: React.ReactNode;
}) {
  return (
    <Button
      type="button"
      variant="ghost"
      size="icon"
      onClick={onClick}
      title={title}
      aria-label={ariaLabel}
      aria-pressed={active || undefined}
      className={cn(
        "rounded-md",
        active
          ? "bg-bg-2 text-text-1"
          : "text-text-4 hover:bg-bg-2 hover:text-text-1",
      )}
    >
      {children}
    </Button>
  );
}

function Sep() {
  return (
    <span
      aria-hidden
      className="inline-block w-px h-3.5 bg-line-soft mx-0.5"
    />
  );
}
