// Notion-style block extensions for the Pages editor (v0.2.38 "Notionless UX").
//
// Every block here round-trips through tiptap-markdown so it survives Aura's
// notes_* markdown save path and the collab Y.Doc:
//   • Highlight  → `==text==`   (vendored markdown-it-mark inline rule)
//   • Details    → `<details>`  (HTML island)
//   • Columns    → `<div data-type="columns">` (HTML island)
//   • Callout    → `> [!type]`  (Obsidian admonition, see Callout.ts)
//   • Table      → GFM pipe table (tiptap-markdown ships the serializer; markdown-it
//                  parses tables natively — no extra wiring)
//
// The editor must run `Markdown.configure({ html: true })` for the island blocks
// to parse back; the caller (TiptapEditor) owns that flag.
import type { AnyExtension } from "@tiptap/core";
import { Highlight } from "@tiptap/extension-highlight";
import {
  Details,
  DetailsSummary,
  DetailsContent,
} from "@tiptap/extension-details";
import { TableKit } from "@tiptap/extension-table";
import { Callout } from "./Callout";
import { ColumnList, Column } from "./Columns";
import { serializeHtmlIsland } from "./htmlIsland";

// ── markdown-it `==mark==` rule (vendored from markdown-it-mark, MIT) ──────────
// Produces mark_open/mark_close tokens with tag "mark"; markdown-it's default
// renderer emits <mark>…</mark>, which Highlight.parseHTML matches.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function markdownItMark(md: any): void {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  function tokenize(state: any, silent: boolean): boolean {
    const start = state.pos;
    const marker = state.src.charCodeAt(start);
    if (silent) return false;
    if (marker !== 0x3d /* = */) return false;
    const scanned = state.scanDelims(state.pos, true);
    let len = scanned.length;
    const ch = String.fromCharCode(marker);
    if (len < 2) return false;
    let token;
    if (len % 2) {
      token = state.push("text", "", 0);
      token.content = ch;
      len--;
    }
    for (let i = 0; i < len; i += 2) {
      token = state.push("text", "", 0);
      token.content = ch + ch;
      state.delimiters.push({
        marker,
        length: 0,
        jump: i,
        token: state.tokens.length - 1,
        end: -1,
        open: scanned.can_open,
        close: scanned.can_close,
      });
    }
    state.pos += scanned.length;
    return true;
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  function postProcess(state: any, delimiters: any[]): void {
    const loneMarkers: number[] = [];
    const max = delimiters.length;
    for (let i = 0; i < max; i++) {
      const startDelim = delimiters[i];
      if (startDelim.marker !== 0x3d /* = */) continue;
      if (startDelim.end === -1) continue;
      const endDelim = delimiters[startDelim.end];
      let token = state.tokens[startDelim.token];
      token.type = "mark_open";
      token.tag = "mark";
      token.nesting = 1;
      token.markup = "==";
      token.content = "";
      token = state.tokens[endDelim.token];
      token.type = "mark_close";
      token.tag = "mark";
      token.nesting = -1;
      token.markup = "==";
      token.content = "";
      if (
        state.tokens[endDelim.token - 1].type === "text" &&
        state.tokens[endDelim.token - 1].content === "="
      ) {
        loneMarkers.push(endDelim.token - 1);
      }
    }
    while (loneMarkers.length) {
      const i = loneMarkers.pop() as number;
      let j = i + 1;
      while (j < state.tokens.length && state.tokens[j].type === "mark_close") {
        j++;
      }
      j--;
      if (i !== j) {
        const token = state.tokens[j];
        state.tokens[j] = state.tokens[i];
        state.tokens[i] = token;
      }
    }
  }

  md.inline.ruler.before("emphasis", "mark", tokenize);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  md.inline.ruler2.after("emphasis", "mark", function (state: any) {
    const tokensMeta = state.tokens_meta;
    const max = (state.tokens_meta || []).length;
    postProcess(state, state.delimiters);
    for (let curr = 0; curr < max; curr++) {
      if (tokensMeta[curr] && tokensMeta[curr].delimiters) {
        postProcess(state, tokensMeta[curr].delimiters);
      }
    }
  });
}

// Single-colour highlight so `==text==` is a lossless round-trip (a colour
// attribute has nowhere to live in `==` syntax). Built-in input rule turns
// `==x==` into a highlight as you type.
const HighlightMd = Highlight.extend({
  addStorage() {
    return {
      ...this.parent?.(),
      markdown: {
        serialize: {
          open: "==",
          close: "==",
          mixable: true,
          expelEnclosingWhitespace: true,
        },
        parse: {
          setup: markdownItMark,
        },
      },
    };
  },
});

// Toggle / collapsible. persist:false keeps open/closed ephemeral (view-only),
// so toggles always reload collapsed and the serialized HTML stays stable.
const DetailsMd = Details.extend({
  addStorage() {
    return {
      ...this.parent?.(),
      markdown: { serialize: serializeHtmlIsland, parse: {} },
    };
  },
});

export function blockExtensions(): AnyExtension[] {
  return [
    HighlightMd.configure({ multicolor: false }),
    DetailsMd.configure({ persist: false, HTMLAttributes: { class: "toggle" } }),
    DetailsSummary,
    DetailsContent,
    TableKit.configure({
      table: { resizable: true, HTMLAttributes: { class: "tiptap-table" } },
    }),
    Callout,
    ColumnList,
    Column,
  ];
}
