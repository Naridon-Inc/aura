// The ⌘/ keyboard-shortcuts cheat-sheet.
//
// A calm, centred overlay you summon from anywhere with ⌘/ (or the command
// palette) to remember the keys — the thing Conductor pops on the same
// shortcut. It reads straight from the shared SHORTCUT_GROUPS map, so it can
// never drift from what the app actually binds. No search, no state, no
// backend — just a two-column reference you glance at and dismiss with Esc.
//
// It is also the ONLY one now. The tasks board used to open a second sheet of
// its own on `?`, listing ten card keys this one had never heard of, so the
// entry reading "Show all shortcuts" was showing about two thirds of them.
// The board's keys are a scoped group in the shared map and `?` opens this
// dialog — which is why groups can carry a `note`: a key that only works on
// a focused task card has to say so.

import { useEffect } from "react";

import { SHORTCUT_GROUPS, comboKeys } from "../../lib/shortcuts";
import { Kbd } from "../ui/kbd";
import {
  MODAL_BACKDROP,
  MODAL_BODY,
  MODAL_FOOTER,
  MODAL_HEADER,
  MODAL_PANEL,
  MODAL_TITLE,
} from "../ui/modalSurface";
import { cn } from "../../lib/utils";

export function ShortcutsDialog({
  open,
  onClose,
}: {
  open: boolean;
  onClose: () => void;
}) {
  // Esc closes — matches the command palette so the two feel like one family.
  useEffect(() => {
    if (!open) return;
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") {
        e.preventDefault();
        onClose();
      }
    }
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [open, onClose]);

  if (!open) return null;

  return (
    <div
      className={cn(MODAL_BACKDROP, "z-50 flex items-start justify-center pt-[12vh]")}
      onMouseDown={onClose}
      role="dialog"
      aria-modal="true"
      aria-label="Keyboard shortcuts"
    >
      <div
        className={cn(MODAL_PANEL, "max-w-[620px]")}
        onMouseDown={(e) => e.stopPropagation()}
      >
        <div className={cn(MODAL_HEADER, "justify-between")}>
          <span className={MODAL_TITLE}>Keyboard shortcuts</span>
          <Kbd>esc</Kbd>
        </div>

        <div
          className={cn(
            MODAL_BODY,
            "max-h-[70vh] overflow-y-auto",
            "grid grid-cols-1 gap-x-8 gap-y-4 sm:grid-cols-2",
          )}
        >
          {SHORTCUT_GROUPS.map((group) => (
            <section key={group.title} className="flex flex-col gap-1.5">
              <h3 className="section-label pb-0.5">
                {group.title}
              </h3>
              {/* Where a scoped group applies. Without it these read as global
                  and fail on the wrong screen, which is worse than not
                  listing them — and not listing them is what the app used to
                  do. */}
              {group.note ? (
                <p className="-mt-1 pb-0.5 text-xs text-text-4">{group.note}</p>
              ) : null}
              {group.items.map((s) => (
                // Keyed by label, not by combo: Enter and Esc each mean two
                // different things on two different surfaces now.
                <div
                  key={s.label}
                  className="flex items-center justify-between gap-4 py-0.5"
                >
                  <span className="text-base text-text-2">{s.label}</span>
                  <span className="flex shrink-0 items-center gap-0.5">
                    {comboKeys(s.keys).map((cap, i) => (
                      <Kbd key={i}>{cap}</Kbd>
                    ))}
                  </span>
                </div>
              ))}
            </section>
          ))}
        </div>

        <div className={cn(MODAL_FOOTER, "justify-start text-xs text-text-4")}>
          Press <span className="font-medium text-text-3">⌘/</span> anytime to bring this back.
        </div>
      </div>
    </div>
  );
}
