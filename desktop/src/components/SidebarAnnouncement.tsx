// The sidebar's one announcement card — pinned to the bottom of the rail,
// with your projects scrolling behind it.
//
// The bottom is where an announcement belongs. At the top it displaced the
// thing the rail is for: the projects moved down the moment we had something
// to say, so the app rearranged the user's index to make room for our news.
// Pinned at the foot it costs the list nothing — the list keeps its whole
// column and simply passes underneath, dissolving into the card through the
// fade above it rather than being cut off by a hard edge.
//
// Compact by construction: a badge, a line, a line, a link. It is a notice,
// not a panel, and it sits in the calmest corner of the app — anything that
// needs more room than this needs a surface, not a card in a rail.

import { X } from "lucide-react";

/** One thing the announcement offers to do.
 *
 *  `kind` is about weight, not colour: `primary` is the thing we're actually
 *  asking for and reads as a button, `link` is the way out of the card for
 *  people who want the detail before they commit. */
export type AnnouncementAction = {
  label: string;
  onClick: () => void;
  kind?: "primary" | "link";
};

type Props = {
  /** Short marker — "New", "Beta". Omit for a plain notice. */
  badge?: string;
  /** One line. The announcement itself. */
  title: string;
  /** One more line of plain language: what it does for you. */
  body?: string;
  /** What you can do about it. Two at most — see the note on the row below. */
  actions?: AnnouncementAction[];
  /** Waving it away is always available, and always sticks. */
  onDismiss?: () => void;
};

/** A notice that offers three choices is not a notice, it's a dialog that
 *  forgot to open. Past two the row also stops fitting the 232px rail without
 *  wrapping, and a wrapped button row in the calmest corner of the app reads as
 *  a panel. Extra actions are dropped rather than wrapped. */
const MAX_ACTIONS = 2;

export function SidebarAnnouncement({
  badge,
  title,
  body,
  actions,
  onDismiss,
}: Props) {
  const acts = (actions ?? []).slice(0, MAX_ACTIONS);
  return (
    <div className="ade-announce" role="note">
      {onDismiss && (
        <button
          type="button"
          onClick={onDismiss}
          aria-label="Dismiss"
          className="ade-announce-x"
        >
          <X size={12} strokeWidth={2} />
        </button>
      )}
      {badge && <span className="ade-announce-badge">{badge}</span>}
      <div className="ade-announce-title">{title}</div>
      {body && <div className="ade-announce-body">{body}</div>}
      {acts.length > 0 && (
        <div className="ade-announce-acts">
          {acts.map((a) => {
            // A link keeps the arrow it always had — the arrow is what says
            // "this takes you somewhere else". A primary action doesn't get
            // one: it does the thing here, and an arrow would promise a
            // journey it isn't making.
            const link = a.kind !== "primary";
            return (
              <button
                key={a.label}
                type="button"
                onClick={a.onClick}
                className={link ? "ade-announce-cta" : "ade-announce-btn"}
              >
                {a.label}
                {link && <span aria-hidden> →</span>}
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}
