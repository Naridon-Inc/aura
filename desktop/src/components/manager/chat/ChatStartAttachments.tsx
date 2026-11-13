// The rows a new chat opens with once the project has history: earlier
// conversations and saved plans, each a chip that attaches it to the first
// message. Five fit on a row; past that the fifth place opens the rest.

import { useEffect, useState, useSyncExternalStore, type ReactNode } from "react";
import { ListChecks, MessagesSquare } from "lucide-react";
import type { NoteSummary } from "../../../lib/api";
import { api } from "../../../lib/api";
import { toast } from "../../../lib/toast";
import {
  attachToComposer,
  composerAttachmentKey,
  subscribeComposerAttachments,
} from "../../../lib/composerAttachments";
import { transcriptFileName } from "../../../lib/chatTranscriptMarkdown";
import { AsciiSpinner } from "../../ui/ascii-spinner";
import { Button } from "../../ui/button";
import { HoverCard, HoverCardContent, HoverCardTrigger } from "../../ui/hover-card";
import { Popover, PopoverContent, PopoverTrigger } from "../../ui/popover";
import { MarkdownView } from "../../MarkdownView";
import { planFile, planFileName, transcriptFile, type PriorChat } from "./chatStartSources";

const MAX_VISIBLE = 5;

/** The names already waiting in this chat's composer. */
function useAttachedNames(sessionId: string): Set<string> {
  const key = useSyncExternalStore(subscribeComposerAttachments, () =>
    composerAttachmentKey(sessionId),
  );
  return new Set(key ? key.split("\n") : []);
}

function ChipRow<T>({
  label,
  items,
  getKey,
  renderItem,
}: {
  label: string;
  items: T[];
  getKey: (item: T) => string;
  renderItem: (item: T) => ReactNode;
}) {
  const [open, setOpen] = useState(false);
  const shown = items.length <= MAX_VISIBLE ? items : items.slice(0, MAX_VISIBLE - 1);
  const rest = items.length <= MAX_VISIBLE ? [] : items.slice(MAX_VISIBLE - 1);
  return (
    <div className="ui-chat-start-group">
      <p className="ui-chat-start-label">{label}</p>
      <div className="ui-chat-start-chips">
        {shown.map((item) => (
          <span key={getKey(item)} className="ui-chat-start-slot">
            {renderItem(item)}
          </span>
        ))}
        {rest.length > 0 && (
          <Popover open={open} onOpenChange={setOpen}>
            <PopoverTrigger asChild>
              <Button variant="ghost" size="xs">
                +{rest.length} more
              </Button>
            </PopoverTrigger>
            <PopoverContent align="start" side="bottom" sideOffset={4} className="ui-chat-start-more">
              {rest.map((item) => (
                <span key={getKey(item)} className="ui-chat-start-slot">
                  {renderItem(item)}
                </span>
              ))}
            </PopoverContent>
          </Popover>
        )}
      </div>
    </div>
  );
}

function StartChip({
  icon,
  title,
  selected,
  importing,
  onClick,
  className,
}: {
  icon: ReactNode;
  title: string;
  selected: boolean;
  importing: boolean;
  onClick: () => void;
  className: string;
}) {
  return (
    <Button
      variant="outline"
      size="xs"
      title={title}
      disabled={importing}
      data-selected={selected || undefined}
      data-importing={importing || undefined}
      className={`ui-chat-start-chip ${className}`}
      onClick={onClick}
    >
      {importing ? <AsciiSpinner /> : icon}
      <span>{title}</span>
    </Button>
  );
}

/** "Add chat transcripts:" — earlier conversations in this project. */
export function TranscriptChips({ sessionId, chats }: { sessionId: string; chats: PriorChat[] }) {
  const attached = useAttachedNames(sessionId);
  const [importing, setImporting] = useState<string[]>([]);
  const add = async (chat: PriorChat) => {
    if (attached.has(transcriptFileName(chat.title))) return;
    setImporting((ids) => [...ids, chat.id]);
    try {
      const file = await transcriptFile(chat);
      if (!file) {
        toast.danger("No messages in this chat");
        return;
      }
      if (!attachToComposer(sessionId, file)) toast.danger("Failed to attach chat transcript");
    } catch {
      toast.danger("Failed to attach chat transcript");
    } finally {
      setImporting((ids) => ids.filter((id) => id !== chat.id));
    }
  };
  return (
    <ChipRow
      label="Add chat transcripts:"
      items={chats}
      getKey={(c) => c.id}
      renderItem={(c) => (
        <StartChip
          icon={<MessagesSquare />}
          title={c.title}
          className="ui-chat-start-chat"
          selected={attached.has(transcriptFileName(c.title))}
          importing={importing.includes(c.id)}
          onClick={() => void add(c)}
        />
      )}
    />
  );
}

/** "Add plans:" — plans saved as Pages, each previewed on hover. */
export function PlanChips({
  sessionId,
  repoRoot,
  plans,
}: {
  sessionId: string;
  repoRoot: string;
  plans: NoteSummary[];
}) {
  const attached = useAttachedNames(sessionId);
  const [importing, setImporting] = useState<string[]>([]);
  const add = async (plan: NoteSummary) => {
    if (attached.has(planFileName(plan))) return;
    setImporting((ids) => [...ids, plan.id]);
    try {
      if (!attachToComposer(sessionId, await planFile(repoRoot, plan))) {
        toast.danger("Failed to attach plan");
      }
    } catch {
      toast.danger("Failed to attach plan");
    } finally {
      setImporting((ids) => ids.filter((id) => id !== plan.id));
    }
  };
  return (
    <ChipRow
      label="Add plans:"
      items={plans}
      getKey={(p) => p.id}
      renderItem={(p) => (
        <HoverCard openDelay={150} closeDelay={100}>
          <HoverCardTrigger asChild>
            <span className="ui-chat-start-hover">
              <StartChip
                icon={<ListChecks />}
                title={p.title}
                className="ui-chat-start-plan"
                selected={attached.has(planFileName(p))}
                importing={importing.includes(p.id)}
                onClick={() => void add(p)}
              />
            </span>
          </HoverCardTrigger>
          <HoverCardContent side="top" align="start" sideOffset={8} className="ui-chat-start-preview">
            <PlanPreview repoRoot={repoRoot} plan={p} />
          </HoverCardContent>
        </HoverCard>
      )}
    />
  );
}

function PlanPreview({ repoRoot, plan }: { repoRoot: string; plan: NoteSummary }) {
  // Read when the preview opens: the card's content mounts only while shown.
  const [state, setState] = useState<{ body: string } | "loading" | "failed">("loading");
  useEffect(() => {
    let live = true;
    api
      .notesRead(repoRoot, plan.scope, plan.bucket, plan.id)
      .then((n) => live && setState({ body: n.body }))
      .catch(() => live && setState("failed"));
    return () => {
      live = false;
    };
  }, [repoRoot, plan.scope, plan.bucket, plan.id]);
  if (state === "loading") {
    return (
      <div className="ui-chat-start-preview-state">
        <AsciiSpinner />
      </div>
    );
  }
  if (state === "failed") {
    return <div className="ui-chat-start-preview-state">Failed to load plan preview.</div>;
  }
  return (
    <div className="ui-chat-start-preview-body">
      <MarkdownView source={state.body} repoRoot={repoRoot} />
    </div>
  );
}
