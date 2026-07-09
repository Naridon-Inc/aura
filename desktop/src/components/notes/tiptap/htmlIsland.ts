// Shared markdown serializer for structural "island" blocks (toggles,
// columns) whose children are best persisted as inline HTML rather than
// markdown. The Pages editor runs tiptap-markdown with `html: true`, so on the
// way back in markdown-it passes the <div>/<details> block through verbatim and
// ProseMirror's DOMParser reconstructs the node tree from each node's
// parseHTML rules. We collapse newlines so the whole subtree stays a single
// markdown-it HTML block (these terminate at the next blank line) — otherwise an
// internal blank line would split the island into two unparseable halves.
import { getHTMLFromFragment } from "@tiptap/core";
import { Fragment } from "@tiptap/pm/model";

// `state` is a prosemirror-markdown MarkdownSerializerState and `node` a PM
// node; tiptap-markdown types both loosely, so we accept `any` here to match.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function serializeHtmlIsland(state: any, node: any): void {
  const schema = node.type.schema;
  const html = getHTMLFromFragment(Fragment.from(node), schema).replace(
    /\n/g,
    "",
  );
  state.write(html);
  state.closeBlock(node);
}
