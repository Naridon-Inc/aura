// Find in a conversation (⌘F): the library search bar over the transcript.
// Every message on screen is a place to land; Enter and the arrows step
// between the ones that contain the words, each brought to the middle of the
// view, and every occurrence of the words is marked where it stands.

import { useEffect, useState, type RefObject } from "react";
import { TranscriptSearch } from "../../ui/transcript-patterns";
import "../../ui/chat-find.css";

const MARK = "aura-chat-find";
const CURRENT = "aura-chat-find-current";

type HighlightRegistry = { set(name: string, h: unknown): void; delete(name: string): void };
type HighlightCtor = new (...ranges: Range[]) => unknown;

function registry(): { reg: HighlightRegistry; Highlight: HighlightCtor } | null {
  const css = (globalThis as { CSS?: { highlights?: HighlightRegistry } }).CSS;
  const Highlight = (globalThis as { Highlight?: HighlightCtor }).Highlight;
  return css?.highlights && Highlight ? { reg: css.highlights, Highlight } : null;
}

/** Every case-insensitive occurrence of `query` in the text under `root`. */
export function rangesOf(root: Node, query: string): Range[] {
  const needle = query.trim().toLocaleLowerCase();
  if (!needle) return [];
  const out: Range[] = [];
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    const text = (node.nodeValue ?? "").toLocaleLowerCase();
    for (let at = text.indexOf(needle); at !== -1; at = text.indexOf(needle, at + needle.length)) {
      const r = document.createRange();
      r.setStart(node, at);
      r.setEnd(node, at + needle.length);
      out.push(r);
    }
  }
  return out;
}

/** The messages of the conversation, as the search bar's places to land. */
function entriesOf(measure: Element | null): { id: string; text: string }[] {
  if (!measure) return [];
  return Array.from(measure.children).flatMap((el, i) => {
    const text = (el as HTMLElement).innerText?.trim() ?? el.textContent?.trim() ?? "";
    return text ? [{ id: String(i), text }] : [];
  });
}

export function ChatFind({
  scrollRef,
  revision,
  onClose,
}: {
  /** The conversation's scroller (ChatTranscript's ref). */
  scrollRef: RefObject<HTMLDivElement | null>;
  /** Changes whenever the conversation does, so the places are re-read. */
  revision: unknown;
  onClose: () => void;
}) {
  const [entries, setEntries] = useState<{ id: string; text: string }[]>([]);
  const [query, setQuery] = useState("");
  const [current, setCurrent] = useState<string | null>(null);
  const measure = () => scrollRef.current?.querySelector(".ui-chat-transcript-inner") ?? null;

  // Read after the whole commit: the transcript's ref is attached after this
  // bar's own layout effects run, since the bar comes first in the tree.
  useEffect(() => {
    setEntries(entriesOf(measure()));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [revision]);

  useEffect(() => {
    const hl = registry();
    const root = measure();
    if (!hl || !root) return;
    hl.reg.set(MARK, new hl.Highlight(...rangesOf(root, query)));
    const here = current !== null ? root.children[Number(current)] : null;
    if (here) hl.reg.set(CURRENT, new hl.Highlight(...rangesOf(here, query)));
    else hl.reg.delete(CURRENT);
    return () => {
      hl.reg.delete(MARK);
      hl.reg.delete(CURRENT);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [query, current, entries]);

  return (
    <div
      className="ui-chat-find"
      onInput={(e) => {
        const value = (e.target as HTMLInputElement).value ?? "";
        setQuery(value);
        if (!value.trim()) setCurrent(null);
      }}
    >
      <TranscriptSearch
        entries={entries}
        onClose={onClose}
        onNavigate={(id) => {
          setCurrent(id);
          measure()?.children[Number(id)]?.scrollIntoView({ block: "center", behavior: "smooth" });
        }}
      />
    </div>
  );
}
