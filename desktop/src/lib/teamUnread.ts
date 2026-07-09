// Team unread bridge — CommsPanel (the one mounted chat panel) is the
// source of truth for unread message counts; the sidebar's Team segment
// button needs the same number to draw its badge. Rather than thread a
// callback through App's render (CommsPanel mounts in two spots, never
// both at once) we publish a tiny summary on a window event +
// localStorage, and the sidebar subscribes.
//
// localStorage carries the last value across a remount (so the badge is
// correct on first paint before any new event fires); the event carries
// live updates while mounted.

export type TeamUnreadSummary = {
  /** Total unread messages across every conversation. */
  total: number;
};

const KEY = "aura.team.unread";
const EVENT = "aura:team-unread";

const EMPTY: TeamUnreadSummary = { total: 0 };

// Skip re-dispatching an identical summary so the chat poll (which fires
// every few seconds) doesn't re-render every subscriber when nothing
// actually changed.
let lastSerialized = "";

export function publishTeamUnread(summary: TeamUnreadSummary): void {
  const serialized = JSON.stringify(summary);
  if (serialized === lastSerialized) return;
  lastSerialized = serialized;
  try {
    localStorage.setItem(KEY, serialized);
  } catch {
    /* private mode — event still fires for live subscribers */
  }
  try {
    window.dispatchEvent(
      new CustomEvent<TeamUnreadSummary>(EVENT, { detail: summary }),
    );
  } catch {
    /* non-DOM env (tests) — no-op */
  }
}

export function readTeamUnread(): TeamUnreadSummary {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return EMPTY;
    const v = JSON.parse(raw) as TeamUnreadSummary;
    if (v && typeof v.total === "number") return v;
  } catch {
    /* malformed / private mode */
  }
  return EMPTY;
}

export function subscribeTeamUnread(
  cb: (summary: TeamUnreadSummary) => void,
): () => void {
  const handler = (e: Event) => cb((e as CustomEvent<TeamUnreadSummary>).detail);
  window.addEventListener(EVENT, handler as EventListener);
  return () => window.removeEventListener(EVENT, handler as EventListener);
}
