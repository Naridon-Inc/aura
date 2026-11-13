// StoryMarkdown — the prose of the change story: the ask, what the AI said as
// it worked, and the reason recorded against one changed piece.
//
// It is the chat's message typography (`ui-message-markdown`), not a theme of
// its own, so a prompt reads the same here as it did when it was sent. Compact
// is the same type a step smaller, for the lines that sit under a row. Links
// open in the system browser (a plain anchor does nothing in the app's web
// view); inline code is the library's code chip. No syntax highlighter: the
// story shows signatures and short identifiers, not large code blocks.

import ReactMarkdown, { type Components } from "react-markdown";
import remarkGfm from "remark-gfm";
import { onExternalAnchorClick } from "../../lib/openExternal";
import { cn } from "../../lib/utils";
import "../ui/chat-markdown.css";
import "../ui/intent-story.css";

type Props = {
  children: string;
  className?: string;
  /** A step smaller, for prose under a row (a per-piece reason, a said line). */
  compact?: boolean;
};

export function StoryMarkdown({ children, className, compact }: Props) {
  return (
    <div
      className={cn("ui-message-markdown ui-story-markdown", className)}
      data-compact={compact || undefined}
    >
      <ReactMarkdown remarkPlugins={[remarkGfm]} components={COMPONENTS}>
        {children}
      </ReactMarkdown>
    </div>
  );
}

const COMPONENTS: Components = {
  a({ href, children }) {
    return (
      <a href={href} target="_blank" rel="noreferrer" onClick={onExternalAnchorClick}>
        {children}
      </a>
    );
  },
};
