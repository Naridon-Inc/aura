// Review comments on one Monaco editor — a side of a split diff, or the whole
// file. Hovering the gutter shows a ＋ on the line; clicking it opens a
// comment there, and dragging down the gutter opens one on the run of lines
// dragged over. Each comment sits under the last line it covers, in a view
// zone the editor makes room for, sized to whatever the comment needs.
//
// A diff's buffers may be rebuilt from the patch, so their line numbers are
// not the file's. `lineAt` maps each buffer line to its real line; comments
// are stored against real lines and placed back through it.

import { useEffect, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import type { Monaco } from "@monaco-editor/react";
import type { editor } from "monaco-editor";

import {
  anchorLine,
  type CommentSide,
  type ReviewComment,
} from "../../../lib/diffReview/reviewComments";
import { DiffComment } from "./DiffComment";

export type ReviewHost = {
  comments: ReviewComment[];
  /** Open a draft on real file lines, with the code they hold. */
  onAdd: (side: CommentSide, line: number, end: number | undefined, code: string) => void;
  repoRoot?: string;
};

type Zone = { key: string; zoneId: string; zone: editor.IViewZone; inner: HTMLElement; ro: ResizeObserver };

// Inside a zone, pointer presses and keys stay with the comment: the editor
// would otherwise take focus away from the text box, or read typing as its
// own shortcuts.
const KEPT = ["mousedown", "pointerdown", "keydown", "keyup", "keypress"];

export function useMonacoReview(
  pane: editor.ICodeEditor | null,
  monaco: Monaco | null,
  side: CommentSide,
  host: ReviewHost | null,
  lineAt?: number[] | null,
): ReactNode {
  const hostRef = useRef(host);
  hostRef.current = host;
  const on = !!host;

  // ── the ＋ and the drag ────────────────────────────────────────────────
  useEffect(() => {
    if (!pane || !monaco || !on) return;
    const T = monaco.editor.MouseTargetType;
    const inGutter = (t: editor.IMouseTarget) =>
      t.type === T.GUTTER_GLYPH_MARGIN || t.type === T.GUTTER_LINE_NUMBERS;
    const hover = pane.createDecorationsCollection([]);
    const pick = pane.createDecorationsCollection([]);
    let hovered = 0;
    let drag: { from: number; to: number } | null = null;

    const setHover = (line: number) => {
      if (line === hovered) return;
      hovered = line;
      hover.set(
        line
          ? [{ range: new monaco.Range(line, 1, line, 1), options: { glyphMarginClassName: "ui-diff-review-add" } }]
          : [],
      );
    };
    const paint = () => {
      if (!drag) return pick.set([]);
      const a = Math.min(drag.from, drag.to);
      const b = Math.max(drag.from, drag.to);
      pick.set([
        {
          range: new monaco.Range(a, 1, b, 1),
          options: { isWholeLine: true, className: "ui-diff-review-picked", marginClassName: "ui-diff-review-picked" },
        },
      ]);
    };
    const move = (ev: MouseEvent) => {
      const line = pane.getTargetAtClientPoint(ev.clientX, ev.clientY)?.position?.lineNumber;
      if (drag && line && line !== drag.to) {
        drag.to = line;
        paint();
      }
    };
    const up = () => {
      window.removeEventListener("mousemove", move, true);
      window.removeEventListener("mouseup", up, true);
      if (!drag) return;
      const a = Math.min(drag.from, drag.to);
      const b = Math.max(drag.from, drag.to);
      drag = null;
      paint();
      const model = pane.getModel();
      const h = hostRef.current;
      if (!model || !h) return;
      const real = (l: number) => (lineAt ? lineAt[l - 1] : l);
      const start = real(a);
      const end = real(b);
      if (!start || !end) return;
      const code: string[] = [];
      for (let l = a; l <= b && l <= model.getLineCount(); l++) code.push(model.getLineContent(l));
      h.onAdd(side, start, end !== start ? end : undefined, code.join("\n"));
    };
    const subs = [
      pane.onMouseMove((e) => setHover(inGutter(e.target) ? (e.target.position?.lineNumber ?? 0) : 0)),
      pane.onMouseLeave(() => setHover(0)),
      pane.onMouseDown((e) => {
        if (!e.event.leftButton || !inGutter(e.target) || !e.target.position) return;
        const line = e.target.position.lineNumber;
        drag = { from: line, to: line };
        paint();
        window.addEventListener("mousemove", move, true);
        window.addEventListener("mouseup", up, true);
      }),
    ];
    return () => {
      for (const s of subs) s.dispose();
      window.removeEventListener("mousemove", move, true);
      window.removeEventListener("mouseup", up, true);
      hover.clear();
      pick.clear();
    };
  }, [pane, monaco, on, side, lineAt]);

  // ── the comments, in view zones ─────────────────────────────────────────
  const zones = useRef(new Map<string, Zone>());
  const [placed, setPlaced] = useState<{ id: string; inner: HTMLElement }[]>([]);
  const mine = (host?.comments ?? []).filter((c) => c.side === side);
  const want = new Map<string, number>();
  for (const c of mine) {
    const real = anchorLine(c);
    const at = lineAt ? lineAt.indexOf(real) + 1 : real;
    if (at > 0) want.set(c.id, at);
  }
  const wantKey = [...want].map(([id, at]) => `${id}@${at}`).join(",");

  useEffect(() => {
    if (!pane) return;
    const have = zones.current;
    const width = () => {
      const info = pane.getLayoutInfo();
      return `${Math.max(240, info.contentWidth - info.verticalScrollbarWidth - 8)}px`;
    };
    pane.changeViewZones((acc) => {
      for (const [id, z] of have) {
        if (want.get(id) !== undefined && z.key === `${id}@${want.get(id)}`) continue;
        acc.removeZone(z.zoneId);
        z.ro.disconnect();
        have.delete(id);
      }
      for (const [id, at] of want) {
        if (have.has(id)) continue;
        const dom = document.createElement("div");
        dom.className = "ui-diff-review-zone";
        for (const type of KEPT) dom.addEventListener(type, (e) => e.stopPropagation());
        const inner = document.createElement("div");
        inner.className = "ui-diff-review-zone-inner";
        inner.style.width = width();
        dom.appendChild(inner);
        const zone: editor.IViewZone = { afterLineNumber: at, heightInPx: 120, domNode: dom };
        const zoneId = acc.addZone(zone);
        const ro = new ResizeObserver(() => {
          const h = Math.ceil(inner.offsetHeight);
          if (!h || h === zone.heightInPx) return;
          zone.heightInPx = h;
          pane.changeViewZones((a) => a.layoutZone(zoneId));
        });
        ro.observe(inner);
        have.set(id, { key: `${id}@${at}`, zoneId, zone, inner, ro });
      }
    });
    setPlaced([...have].map(([id, z]) => ({ id, inner: z.inner })));
    const layout = pane.onDidLayoutChange(() => {
      for (const z of have.values()) z.inner.style.width = width();
    });
    return () => layout.dispose();
    // `want` is read through its key, which changes whenever it does.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pane, wantKey]);

  useEffect(
    () => () => {
      const have = zones.current;
      if (!pane) return;
      try {
        pane.changeViewZones((acc) => {
          for (const z of have.values()) acc.removeZone(z.zoneId);
        });
      } catch {
        /* editor already gone */
      }
      for (const z of have.values()) z.ro.disconnect();
      have.clear();
    },
    [pane],
  );

  if (!host) return null;
  const byId = new Map(mine.map((c) => [c.id, c]));
  return (
    <>
      {placed.map(({ id, inner }) => {
        const c = byId.get(id);
        return c ? createPortal(<DiffComment comment={c} repoRoot={host.repoRoot} />, inner, id) : null;
      })}
    </>
  );
}
