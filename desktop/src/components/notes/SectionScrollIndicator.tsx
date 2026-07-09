// SectionScrollIndicator — RR.6-retry. Dashed vertical rail with hollow
// dots fixed to the right edge of a scrollable container. Each dot maps
// to an h1/h2/h3 in viewport order; the dot whose section is currently
// most visible gets the filled `.on` style. Clicking a dot scrolls its
// section into view. Mirrors `docs/plane-app-examples.html` §5
// (.scroll-indicator, lines ~1828–1845).
//
// Real consumer: NotesWorkpane's PageDetail. The Tiptap editor renders
// headings as <h1>/<h2>/<h3> in its content area; this component finds
// them and tracks the active one via IntersectionObserver. Hides itself
// when fewer than 2 headings exist (no point on short pages).

import { useEffect, useRef, useState } from "react";

type Heading = {
  id: string;
  level: number;
  text: string;
  el: HTMLElement;
};

export function SectionScrollIndicator({
  containerRef,
}: {
  /** Scrollable container to observe. The component finds heading
   *  elements inside it on mount + on every mutation. */
  containerRef: React.RefObject<HTMLElement | null>;
}) {
  const [headings, setHeadings] = useState<Heading[]>([]);
  const [activeId, setActiveId] = useState<string | null>(null);
  const observerRef = useRef<IntersectionObserver | null>(null);

  // Scan + re-scan on mutation. Tiptap mutates the doc on every
  // keystroke, so we debounce the rescan.
  useEffect(() => {
    const root = containerRef.current;
    if (!root) return;
    let timer = 0;
    function rescan() {
      window.clearTimeout(timer);
      timer = window.setTimeout(() => {
        const nodes = Array.from(
          root!.querySelectorAll<HTMLElement>("h1, h2, h3"),
        );
        const next: Heading[] = nodes.map((el, i) => {
          let id = el.id;
          if (!id) {
            id = `h-${i}-${slug(el.textContent ?? "")}`;
            el.id = id;
          }
          return {
            id,
            level: Number(el.tagName.slice(1)),
            text: (el.textContent ?? "").slice(0, 80),
            el,
          };
        });
        setHeadings(next);
      }, 200);
    }
    rescan();
    const mo = new MutationObserver(rescan);
    mo.observe(root, { childList: true, subtree: true, characterData: true });
    return () => {
      mo.disconnect();
      window.clearTimeout(timer);
    };
  }, [containerRef]);

  // Active heading = the one nearest the top of the viewport that's
  // still visible. IntersectionObserver gives us "is visible" cheaply.
  useEffect(() => {
    const root = containerRef.current;
    if (!root || headings.length === 0) {
      setActiveId(null);
      return;
    }
    observerRef.current?.disconnect();
    const visible = new Set<string>();
    const io = new IntersectionObserver(
      (entries) => {
        for (const e of entries) {
          const id = (e.target as HTMLElement).id;
          if (e.isIntersecting) visible.add(id);
          else visible.delete(id);
        }
        // Pick the first heading (DOM order) that's currently visible.
        const first = headings.find((h) => visible.has(h.id));
        if (first) setActiveId(first.id);
      },
      {
        root,
        rootMargin: "0px 0px -60% 0px",
        threshold: 0,
      },
    );
    for (const h of headings) io.observe(h.el);
    observerRef.current = io;
    return () => io.disconnect();
  }, [headings, containerRef]);

  if (headings.length < 2) return null;

  return (
    <div
      className="absolute top-1/2 right-3 -translate-y-1/2 z-[8] flex flex-col items-center gap-1.5 py-2 pointer-events-auto"
      role="navigation"
      aria-label="Section navigation"
      style={{
        backgroundImage:
          "linear-gradient(to bottom, var(--line-soft, rgba(255,255,255,0.12)) 50%, transparent 50%)",
        backgroundSize: "1px 6px",
        backgroundRepeat: "repeat-y",
        backgroundPosition: "center",
      }}
    >
      {headings.map((h) => {
        const on = h.id === activeId;
        return (
          <button
            key={h.id}
            type="button"
            onClick={() => {
              h.el.scrollIntoView({ behavior: "smooth", block: "start" });
            }}
            aria-label={`Jump to ${h.text}`}
            title={h.text}
            className={`w-[7px] h-[7px] rounded-full transition-colors ${
              on
                ? "bg-text-2 outline outline-1 outline-text-3"
                : "bg-transparent outline outline-1 outline-text-5 hover:outline-text-3"
            }`}
            style={{
              marginLeft: h.level === 3 ? 6 : h.level === 2 ? 3 : 0,
            }}
          />
        );
      })}
    </div>
  );
}

function slug(s: string): string {
  return s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40);
}
