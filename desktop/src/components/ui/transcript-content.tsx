import { memo, useEffect, useRef, useState, type ReactNode } from "react";
import Markdown, { type Components, type Options } from "react-markdown";
import remarkGfm from "remark-gfm";
import { ArrowDown, Check, Copy, FileQuestion } from "lucide-react";
import { Button } from "./button";
import { AsciiSpinner } from "./ascii-spinner";
import { onExternalAnchorClick } from "../../lib/openExternal";
type PluggableList = NonNullable<Options["remarkPlugins"]>;
const MESSAGE_PLUGINS: PluggableList = [remarkGfm];
const MESSAGE_COMPONENTS: Components = {
  a: ({ node: _node, ...props }) => (
    <a {...props} target="_blank" rel="noopener noreferrer" onClick={onExternalAnchorClick} />
  ),
  pre: ({ children }) => <CodeMessage>{children}</CodeMessage>,
};
/** One run of markdown, parsed once for as long as its text stays the same. */
const MarkdownRun = memo(function MarkdownRun({
  source,
  components,
  remarkPlugins,
  rehypePlugins,
  skipHtml,
}: {
  source: string;
  components: Components;
  remarkPlugins: PluggableList;
  rehypePlugins?: PluggableList;
  skipHtml: boolean;
}) {
  return (
    <Markdown
      remarkPlugins={remarkPlugins}
      rehypePlugins={rehypePlugins}
      skipHtml={skipHtml}
      components={components}
    >
      {source}
    </Markdown>
  );
});
export function MessageMarkdown({
  content,
  components = MESSAGE_COMPONENTS,
  remarkPlugins = MESSAGE_PLUGINS,
  rehypePlugins,
  skipHtml = true,
  settledAt = -1,
  children,
}: {
  content: string;
  /** The surface's own elements, in place of the default link and code block.
   *  Pass a stable object: the settled text is only kept while it is. */
  components?: Components;
  remarkPlugins?: PluggableList;
  rehypePlugins?: PluggableList;
  /** Drop raw HTML. Off shows it as the text it is. */
  skipHtml?: boolean;
  /** While a reply streams, where the text that can no longer change ends.
   *  Everything before it is parsed once; only the rest is parsed per token. */
  settledAt?: number;
  /** After the text: a typing cursor. */
  children?: ReactNode;
}) {
  const head = settledAt > 0 ? content.slice(0, settledAt) : content;
  const tail = settledAt > 0 ? content.slice(settledAt) : "";
  const run = { components, remarkPlugins, rehypePlugins, skipHtml };
  return (
    <div className="ui-message-markdown">
      <MarkdownRun source={head} {...run} />
      {tail ? <MarkdownRun source={tail} {...run} /> : null}
      {children}
    </div>
  );
}
export function CodeMessage({ children, language }: { children: ReactNode; language?: string }) {
  const text = useRef<HTMLPreElement>(null),
    [copied, setCopied] = useState(false),
    [error, setError] = useState(false);
  return (
    <div className="ui-code-message">
      <header>
        <span>{language ?? "Code"}</span>
        <Button
          size="iconXs"
          variant="ghost"
          aria-label="Copy code"
          onClick={async () => {
            try {
              await navigator.clipboard.writeText(text.current?.textContent ?? "");
              setCopied(true);
              setError(false);
            } catch {
              setError(true);
            }
          }}
        >
          {copied ? <Check /> : <Copy />}
        </Button>
      </header>
      <pre ref={text}>{children}</pre>
      {error && <small role="status">Copy unavailable</small>}
    </div>
  );
}
export function UnsupportedMessage({
  type,
  raw,
  children,
}: {
  type: string;
  raw?: string;
  /** Under the content: a way to see the rest of a long payload. */
  children?: ReactNode;
}) {
  return (
    <details className="ui-unsupported-message">
      <summary>
        <FileQuestion size={14} />
        Unsupported message: {type}
      </summary>
      <pre>{raw ?? "No readable content is available for this message."}</pre>
      {children}
    </details>
  );
}
export function ConversationView({
  state = "ready",
  error,
  onRetry,
  children,
  revision,
  emptyTitle = "What would you like to build?",
  emptyActions,
}: {
  state?: "loading" | "initializing" | "ready" | "empty" | "error";
  error?: string;
  onRetry?: () => void;
  children?: ReactNode;
  revision?: string | number;
  emptyTitle?: string;
  emptyActions?: ReactNode;
}) {
  const viewport = useRef<HTMLDivElement>(null),
    following = useRef(true),
    [atBottom, setAtBottom] = useState(true);
  useEffect(() => {
    if (following.current && viewport.current)
      viewport.current.scrollTop = viewport.current.scrollHeight;
  }, [revision, state]);
  return (
    <section className="ui-conversation-view">
      <div
        ref={viewport}
        className="ui-conversation-scroll"
        aria-label="Conversation"
        aria-busy={state === "loading" || state === "initializing"}
        onScroll={(event) => {
          const element = event.currentTarget;
          const bottom = element.scrollHeight - element.clientHeight - element.scrollTop < 48;
          following.current = bottom;
          setAtBottom(bottom);
        }}
      >
        {state === "loading" || state === "initializing" ? (
          <div className="ui-conversation-empty" role="status">
            <AsciiSpinner />
            <p>{state === "loading" ? "Loading conversation…" : "Setting up workspace…"}</p>
          </div>
        ) : state === "error" ? (
          <div className="ui-conversation-empty" role="alert">
            <p>{error ?? "Could not load this conversation."}</p>
            {onRetry && (
              <Button size="sm" variant="outline" onClick={onRetry}>
                Try again
              </Button>
            )}
          </div>
        ) : state === "empty" ? (
          <div className="ui-conversation-empty">
            <h2>{emptyTitle}</h2>
            {emptyActions}
          </div>
        ) : (
          children
        )}
      </div>
      {!atBottom && state === "ready" && (
        <Button
          className="ui-conversation-bottom"
          size="sm"
          variant="secondary"
          onClick={() => {
            following.current = true;
            if (viewport.current) viewport.current.scrollTop = viewport.current.scrollHeight;
            setAtBottom(true);
          }}
        >
          <ArrowDown />
          Jump to latest
        </Button>
      )}
    </section>
  );
}
