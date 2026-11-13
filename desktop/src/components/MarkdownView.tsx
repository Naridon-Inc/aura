// Markdown read as a document — a README in its file tab, a pull request's
// description, a reply in the menubar companion. All of it is the same
// rendered markdown a chat reply uses: the shared message typography, its
// code blocks (language header + copy), tables that scroll inside the column,
// math, callouts, and links that open in the real browser. Only the frame
// differs: `MarkdownView` is a scrolling page with a reading width, and
// `MarkdownInline` is bare prose for a surface that owns its own column.
import { memo } from "react";
import { MarkdownBody } from "./manager/chat/Markdown";
import { ChatRepoRootContext } from "./manager/chat/context";
import { cn } from "../lib/utils";
import "./ui/file-tab.css";

export function MarkdownView({
  source,
  repoRoot,
}: {
  /** Source markdown — usually the open file's live buffer. */
  source: string;
  /** Resolves relative file paths named in the prose, so they open. */
  repoRoot?: string;
}) {
  return (
    <ChatRepoRootContext.Provider value={repoRoot ?? null}>
      <div className="ui-file-markdown">
        <MarkdownBody source={source} />
      </div>
    </ChatRepoRootContext.Provider>
  );
}

export const MarkdownInline = memo(function MarkdownInline({
  source,
  className,
}: {
  source: string;
  /** Extra classes on the prose wrapper (a tighter size, a muted color). */
  className?: string;
}) {
  return (
    <div className={cn("ui-markdown-inline", className)}>
      <MarkdownBody source={source} />
    </div>
  );
});
