//! "Open the chat history" as an event, addressed to one chat.
//!
//! Several chats can be mounted at once — a workspace's chat tab and Aura's
//! panel on Home, say — and each has its own history menu listening. An
//! un-addressed event opened all of them, stacking two dropdowns over each
//! other. A request now names the conversation it came from; one that can't
//! (an older caller) only reaches a menu whose button is actually on screen.

export const OPEN_HISTORY_EVENT = "aura:manager:open-history";

export type OpenHistoryDetail = { sessionId?: string | null };

/** Ask the history menu of `sessionId`'s chat to open. */
export function openChatHistory(sessionId?: string | null): void {
  window.dispatchEvent(
    new CustomEvent<OpenHistoryDetail>(OPEN_HISTORY_EVENT, {
      detail: { sessionId: sessionId ?? null },
    }),
  );
}

/** Whether a history menu should answer this request. */
export function historyRequestIsFor(
  detail: unknown,
  currentSessionId: string | null,
  triggerOnScreen: boolean,
): boolean {
  const sid =
    detail && typeof detail === "object"
      ? (detail as OpenHistoryDetail).sessionId
      : undefined;
  if (sid) return sid === currentSessionId;
  return triggerOnScreen;
}

/** Whether an element is laid out and visible — not inside a hidden tab, a
 *  collapsed panel or a page that isn't showing. */
export function isOnScreen(el: Element | null): boolean {
  if (!el) return false;
  const check = (el as Element & { checkVisibility?: () => boolean }).checkVisibility;
  if (typeof check === "function") return check.call(el);
  return el.getClientRects().length > 0;
}
