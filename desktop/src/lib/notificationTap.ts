// Which handler a response to an OS notification belongs to.
//
// A notification that should take you somewhere when tapped carries
// `extra.kind`; the app registers one handler per kind. Kept apart from
// `notifications.ts` so the rule is testable without the Tauri plugins.

/** Kinds whose responses are handled elsewhere: `chat` carries an inline
 *  Reply and is owned by `onChatReply`. */
const OWNED_ELSEWHERE = new Set(["chat"]);

/** The kind a response asks to open, or null when it isn't a plain tap on a
 *  notification some handler here may own.
 *
 *  macOS answers a tap with `com.apple.UNNotificationDefaultActionIdentifier`
 *  and a swipe-away with `…DismissActionIdentifier`; the plugin's other
 *  backends send no action id for a tap. Anything else is a button or an
 *  inline reply, which belongs to whoever registered it. */
export function tappedKind(actionId: string | null | undefined, extra: unknown): string | null {
  if (actionId && !actionId.endsWith("DefaultActionIdentifier")) return null;
  if (!extra || typeof extra !== "object") return null;
  const kind = (extra as Record<string, unknown>)["kind"];
  if (typeof kind !== "string" || !kind || OWNED_ELSEWHERE.has(kind)) return null;
  return kind;
}
