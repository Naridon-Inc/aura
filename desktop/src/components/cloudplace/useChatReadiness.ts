// Whether a chat started now would be answered, kept fresh while it is asked.

import { useEffect, useState } from "react";

import { chatReadiness, type ChatReadiness, type ReadinessNote } from "../../lib/cloudChatPlace";
import { openCloudAgents } from "./CloudAgentsHost";

/** Where things stand, asked each time `ask` turns true, and again when your
 *  agents change. Null until the board answers. `web`: asked from a browser,
 *  where only the org's Aura computer can answer. */
export function useChatReadiness(ask: boolean, hasAgent: boolean, web = false): ChatReadiness | null {
  const [readiness, setReadiness] = useState<ChatReadiness | null>(null);
  useEffect(() => {
    if (!ask) return;
    let live = true;
    void chatReadiness(hasAgent, web).then((r) => live && setReadiness(r));
    return () => {
      live = false;
    };
  }, [ask, hasAgent, web]);
  return ask ? readiness : null;
}

/** Do the one thing a note says fixes it. */
export function fixReadiness(fix: ReadinessNote["fix"]): void {
  if (fix === "agent") openCloudAgents();
  if (fix === "computer")
    window.dispatchEvent(new CustomEvent("aura:open-settings", { detail: { pane: "computer" } }));
}
