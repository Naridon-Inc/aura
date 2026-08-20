// The small "you just updated" notice, shown once after every update. Quiet by
// design — a headline + the single top highlight, and an × to wave it away.
// Dismissing marks the version seen upstream, so it never returns. Big
// releases used to interrupt with a full-screen modal instead; this card says
// the same thing from the corner and waits.
//
// It wears the sidebar's announcement shell rather than a look of its own:
// this is the rail's announcement slot, and a second card style in the same
// 8px-wide corner would read as two unrelated things shouting at once. The
// shell also pins it to the FOOT of the rail, which is why the projects no
// longer shuffle down the page every time we ship a release.

import { SidebarAnnouncement } from "./SidebarAnnouncement";
import type { ReleaseNote } from "../lib/releaseNotes";

type Props = {
  note: ReleaseNote;
  onDismiss: () => void;
  /** Same contract as the modal: the card dismisses itself, then acts. */
  onCta?: (kind: NonNullable<ReleaseNote["cta"]>["kind"]) => void;
};

export function WhatsNewCard({ note, onDismiss, onCta }: Props) {
  const lead = note.highlights[0] ?? note.title;
  const cta = note.cta;
  return (
    <SidebarAnnouncement
      badge="New"
      title={`Updated to ${note.version}`}
      body={lead}
      // A release note's action is the one thing the release asks you to do,
      // so it gets the button rather than the link it used to get. There is no
      // second action here on purpose: the alternative to acting is closing the
      // card, and the × already does that — a "Got it" beside it would be the
      // same choice offered twice.
      actions={
        cta && onCta
          ? [
              {
                label: cta.label,
                kind: "primary",
                onClick: () => {
                  onDismiss();
                  onCta(cta.kind);
                },
              },
            ]
          : undefined
      }
      onDismiss={onDismiss}
    />
  );
}
