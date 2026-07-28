// The small "you just updated" card shown at the top of the sidebar after a
// MINOR update. Quiet by design — a headline + the single top highlight, and an
// × to wave it away. Dismissing marks the version seen upstream, so it never
// returns. (Major updates use the WhatsNewModal instead.)

import { Sparkles, X } from "lucide-react";

import type { ReleaseNote } from "../lib/releaseNotes";

type Props = {
  note: ReleaseNote;
  onDismiss: () => void;
  /** Same contract as the modal: the card dismisses itself, then acts. */
  onCta?: (kind: NonNullable<ReleaseNote["cta"]>["kind"]) => void;
};

export function WhatsNewCard({ note, onDismiss, onCta }: Props) {
  const lead = note.highlights[0] ?? note.title;
  return (
    <div
      className="mx-3 mt-3 rounded-lg border p-2.5 text-xs"
      // `--color-bg-elevated` is defined by no pack, so this card was painted
      // by its fallbacks — a cold grey box with a blue edge, frozen against
      // every theme. `--color-bg-3` is the real elevated surface. The accent
      // stays: a left edge + the spark are the "something new landed" mark,
      // which is exactly what the accent slot is for.
      style={{
        background: "var(--color-bg-3)",
        borderColor: "var(--color-line)",
        borderLeft: "3px solid var(--color-accent)",
      }}
    >
      <div className="flex items-start gap-2">
        <Sparkles
          className="mt-px h-3.5 w-3.5 shrink-0"
          style={{ color: "var(--color-accent)" }}
          aria-hidden="true"
        />
        <div className="min-w-0 flex-1">
          <div className="font-medium text-text-1">
            Updated to {note.version}
          </div>
          <div className="mt-0.5 leading-snug text-text-3">{lead}</div>
          {note.cta && onCta && (
            <button
              type="button"
              onClick={() => {
                const { kind } = note.cta!;
                onDismiss();
                onCta(kind);
              }}
              className="mt-1.5 font-medium underline-offset-2 hover:underline"
              style={{ color: "var(--color-accent)" }}
            >
              {note.cta.label}
            </button>
          )}
        </div>
        <button
          type="button"
          onClick={onDismiss}
          aria-label="Dismiss"
          className="-mr-0.5 -mt-0.5 shrink-0 rounded p-0.5 text-text-4 hover:bg-white/5 hover:text-text-1"
        >
          <X className="h-3.5 w-3.5" />
        </button>
      </div>
    </div>
  );
}
