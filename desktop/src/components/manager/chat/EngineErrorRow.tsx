// A turn whose engine failed before it answered. The engine's own error event
// is not shown: the row says what happened in plain words and offers the one
// thing that fixes it — sign the engine in again, or choose another one —
// both of which live in Settings › Agents.

import { TriangleAlert } from "lucide-react";

import { type EngineErrorEvent, engineErrorSentence } from "../../../lib/engineErrorEvent";
import { Alert } from "../../ui/alert";
import { Button } from "../../ui/button";
import "../../ui/chat-turn-error.css";

function openAgentSettings() {
  window.dispatchEvent(new CustomEvent("aura:open-settings", { detail: { pane: "agents" } }));
}

export function EngineErrorRow({ event, engine }: { event: EngineErrorEvent; engine?: string | null }) {
  return (
    <Alert className="ui-chat-engine-error" title={event.detail || undefined}>
      <TriangleAlert aria-hidden />
      <p>{engineErrorSentence(event, engine)}</p>
      <Button variant="ghost" size="xs" onClick={openAgentSettings}>
        Sign in or switch engine
      </Button>
    </Alert>
  );
}
