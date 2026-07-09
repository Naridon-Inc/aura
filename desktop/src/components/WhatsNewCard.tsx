// The small "you just updated" card shown at the top of the sidebar after a
// MINOR update. Quiet by design — a headline + the single top highlight, and an
// × to wave it away. Dismissing marks the version seen upstream, so it never
// returns. (Major updates use the WhatsNewModal instead.)

import { Sparkles, X } from "lucide-react";

import type { ReleaseNote } from "../lib/releaseNotes";

type Props = {
  note: ReleaseNote;
  onDismiss: () => void;
};

export function WhatsNewCard({ note, onDismiss }: Props) {
  const lead = note.highlights[0] ?? note.title;
  return (
    <div
      className="mx-3 mt-3 rounded-lg border p-2.5 text-xs"
      style={{
        background: "var(--color-bg-elevated, #1a1a1a)",
        borderColor: "var(--color-border, #2a2a2a)",
        borderLeft: "3px solid var(--color-accent, #5aa9e6)",
      }}
    >
      <div className="flex items-start gap-2">
        <Sparkles
          className="mt-px h-3.5 w-3.5 shrink-0"
          style={{ color: "var(--color-accent, #5aa9e6)" }}
          aria-hidden="true"
        />
        <div className="min-w-0 flex-1">
          <div className="font-medium text-text-1">
            Updated to {note.version}
          </div>
          <div className="mt-0.5 leading-snug text-text-3">{lead}</div>
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
