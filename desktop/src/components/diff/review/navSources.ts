// Where a diff's commented lines sit, for the previous / next comment
// buttons: one reader for the unified table (rows in a scrolling element) and
// one for a Monaco diff (lines in an editor that scrolls itself).

import type { Monaco } from "@monaco-editor/react";
import type { editor } from "monaco-editor";

import { anchorLine, type ReviewComment } from "../../../lib/diffReview/reviewComments";
import type { NavSource } from "./CommentNav";

function onScreen(el: HTMLElement | null): boolean {
  return !!el && el.isConnected && el.getClientRects().length > 0;
}

/** The unified table: each row carries `data-review-old` / `data-review-new`
 *  with its line numbers, set by `useUnifiedReview`. */
export function tableNavSource(scroller: HTMLElement): NavSource {
  return {
    scrollTop: () => scroller.scrollTop,
    viewportHeight: () => scroller.clientHeight,
    lineBox: (c: ReviewComment) => {
      const attr = c.side === "deletions" ? "data-review-old" : "data-review-new";
      const row = scroller.querySelector<HTMLElement>(`tr[${attr}="${anchorLine(c)}"]`);
      if (!row) return null;
      const top = row.getBoundingClientRect().top - scroller.getBoundingClientRect().top + scroller.scrollTop;
      return { top, height: row.offsetHeight };
    },
    scrollTo: (top) => scroller.scrollTo({ top, behavior: "smooth" }),
    watch: (cb) => {
      scroller.addEventListener("scroll", cb, { passive: true });
      const ro = new ResizeObserver(cb);
      ro.observe(scroller);
      const table = scroller.firstElementChild;
      if (table) ro.observe(table);
      return () => {
        scroller.removeEventListener("scroll", cb);
        ro.disconnect();
      };
    },
    visible: () => onScreen(scroller),
  };
}

/** A Monaco diff. Both sides scroll together, so the current side's scroll
 *  stands for both. `origAt` / `modAt` map buffer lines to the file's real
 *  lines when the buffers were rebuilt from a patch. */
export function monacoNavSource(
  diff: editor.IStandaloneDiffEditor,
  monaco: Monaco,
  origAt?: number[] | null,
  modAt?: number[] | null,
): NavSource {
  const mod = diff.getModifiedEditor();
  const orig = diff.getOriginalEditor();
  const lineHeight = () => mod.getOption(monaco.editor.EditorOption.lineHeight);
  return {
    scrollTop: () => mod.getScrollTop(),
    viewportHeight: () => mod.getLayoutInfo().height,
    lineBox: (c: ReviewComment) => {
      const pane = c.side === "deletions" ? orig : mod;
      const map = c.side === "deletions" ? origAt : modAt;
      const real = anchorLine(c);
      const at = map ? map.indexOf(real) + 1 : real;
      const model = pane.getModel();
      if (at < 1 || !model || at > model.getLineCount()) return null;
      return { top: pane.getTopForLineNumber(at), height: lineHeight() };
    },
    scrollTo: (top) => mod.setScrollTop(top, monaco.editor.ScrollType.Smooth),
    watch: (cb) => {
      const subs = [
        mod.onDidScrollChange(cb),
        mod.onDidLayoutChange(cb),
        mod.onDidContentSizeChange(cb),
        orig.onDidContentSizeChange(cb),
        diff.onDidUpdateDiff(cb),
      ];
      return () => subs.forEach((s) => s.dispose());
    },
    visible: () => onScreen(diff.getContainerDomNode()),
  };
}
