// Columns — multi-column layout (2–4 side-by-side block stacks), the Notion
// "columns" block. A `columnList` holds N `column` nodes, each a `block+`
// stack.
//
// Persistence: serialized as an HTML island (see htmlIsland.ts). markdown-it
// (html: true) passes the <div data-type="columns">…</div> through verbatim and
// ProseMirror reconstructs columnList → column → blocks via parseHTML. Inner
// content is HTML rather than markdown — acceptable for a structural island the
// user edits visually rather than in source.
import { Node, mergeAttributes } from "@tiptap/core";
import { serializeHtmlIsland } from "./htmlIsland";

declare module "@tiptap/core" {
  interface Commands<ReturnType> {
    columns: {
      setColumns: (count?: number) => ReturnType;
    };
  }
}

export const Column = Node.create({
  name: "column",
  group: "column",
  content: "block+",
  isolating: true,

  parseHTML() {
    return [{ tag: 'div[data-type="column"]' }];
  },

  renderHTML({ HTMLAttributes }) {
    return [
      "div",
      mergeAttributes(HTMLAttributes, {
        "data-type": "column",
        class: "column",
      }),
      0,
    ];
  },
});

export const ColumnList = Node.create({
  name: "columnList",
  group: "block",
  content: "column{2,}",

  parseHTML() {
    return [{ tag: 'div[data-type="columns"]' }];
  },

  renderHTML({ HTMLAttributes }) {
    return [
      "div",
      mergeAttributes(HTMLAttributes, {
        "data-type": "columns",
        class: "columns",
      }),
      0,
    ];
  },

  addCommands() {
    return {
      setColumns:
        (count = 2) =>
        ({ chain }) => {
          const cols = Math.max(2, Math.min(4, count));
          const content = Array.from({ length: cols }, () => ({
            type: "column",
            content: [{ type: "paragraph" }],
          }));
          return chain()
            .insertContent({ type: "columnList", content })
            .run();
        },
    };
  },

  addStorage() {
    return {
      markdown: {
        // The whole subtree is written as one HTML block; children are never
        // visited individually, so `column` needs no markdown spec of its own.
        serialize: serializeHtmlIsland,
        parse: {},
      },
    };
  },
});
