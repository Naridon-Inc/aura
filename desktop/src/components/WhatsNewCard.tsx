// The small "you just updated" notice, shown once after every update. Quiet by
// design — the version and the single top highlight, and an × to wave it away.
// Dismissing marks the version seen upstream, so it never returns.
//
// It wears the shared notice, the same one the update and tracking notices
// use at the foot of the sidebar: one look for everything the app has to say
// from that corner.

import { ShellNotice } from "./ui/shell-notice";
import type { ReleaseNote } from "../lib/releaseNotes";

type Props = {
  note: ReleaseNote;
  onDismiss: () => void;
  /** The notice dismisses itself, then acts. */
  onCta?: (kind: NonNullable<ReleaseNote["cta"]>["kind"]) => void;
};

export function WhatsNewCard({ note, onDismiss, onCta }: Props) {
  const lead = note.highlights[0] ?? note.title;
  const cta = note.cta;
  return (
    <ShellNotice
      tone="ok"
      // The release's action is the one thing it asks you to do. There is no
      // second action on purpose: the alternative to acting is closing the
      // notice, and the × already does that.
      action={
        cta && onCta
          ? {
              label: cta.label,
              onClick: () => {
                onDismiss();
                onCta(cta.kind);
              },
            }
          : undefined
      }
      onDismiss={onDismiss}
      dismissLabel="Dismiss what's new"
    >
      <strong>Updated to {note.version}.</strong> {lead}
    </ShellNotice>
  );
}
