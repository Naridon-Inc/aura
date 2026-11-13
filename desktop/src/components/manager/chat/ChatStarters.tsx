// Three things to ask for, above the composer of someone's first chat in a
// project, and the way to the docs. Picking one sends it as the first message.

import { ExternalLink } from "lucide-react";
import { openExternal } from "../../../lib/openExternal";
import { Button } from "../../ui/button";
import { usePriorChats } from "./chatStartSources";

export const CHAT_STARTERS: ReadonlyArray<{ label: string; prompt: string }> = [
  {
    label: "Review recent PRs",
    prompt:
      "Review the last 10 merged PRs for security risks. Check them one at a time and report findings only after reviewing all 10. Do not edit code.",
  },
  {
    label: "Improve agent instructions",
    prompt: "Create or update the agent instructions for this repo.",
  },
  {
    label: "Fix a TODO",
    prompt: "Find a small commented TODO and implement it.",
  },
];

const DOCS_URL = "https://auravcs.com/docs";

/** Shown only while nobody has talked to Aura in this project yet: once there
 *  are earlier chats, the new chat offers those instead. */
export function ChatStarters({
  onPick,
  repoRoot,
  sessionId,
}: {
  onPick: (prompt: string) => void;
  repoRoot?: string | null;
  sessionId?: string;
}) {
  const prior = usePriorChats(repoRoot, sessionId);
  if (prior === null || prior.length > 0) return null;
  return (
    <div className="ui-chat-starters">
      {CHAT_STARTERS.map((s) => (
        <Button
          key={s.label}
          variant="ghost"
          size="sm"
          className="ui-chat-starter"
          onClick={() => onPick(s.prompt)}
        >
          {s.label}
        </Button>
      ))}
      <Button
        variant="ghost"
        size="sm"
        className="ui-chat-starter"
        onClick={() => void openExternal(DOCS_URL)}
      >
        Read the docs
        <ExternalLink className="ui-chat-starter-out" />
      </Button>
    </div>
  );
}
