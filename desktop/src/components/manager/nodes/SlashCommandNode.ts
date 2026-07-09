// SlashCommandNode — an inline atom chip for a `/command` in the Tiptap
// composer.
//
// When the user picks a slash command from the suggestion popup, we insert ONE
// atomic inline node (not loose text) that renders as a rounded pill carrying
// the command name. Being atomic, it deletes whole on a single Backspace and
// survives copy-paste: ProseMirror serializes it back to plain `/name` text
// (see the `markdown` storage) so a pasted draft round-trips, and the brain
// receives exactly `/name …` the same as if it had been typed.
//
// Mirrors the project's existing custom-node idioms (notes/tiptap/Callout.ts):
// `Node.create` + `mergeAttributes`, an inline `markdown` storage serializer,
// and token-only styling via a class the composer's CSS hooks.

import { Node, mergeAttributes } from "@tiptap/core";

export type SlashCommandAttrs = {
  /** Command verb without the leading slash (e.g. "search"). */
  name: string;
};

/** Build the `/command` atom node. A factory (not a bare const) so the caller
 *  site reads symmetrically with `createFileMentionNode()` and leaves room for
 *  per-instance options later without a breaking signature change. */
export function createSlashCommandNode() {
  return Node.create({
    name: "slashCommand",
    group: "inline",
    inline: true,
    atom: true,
    selectable: true,

    addAttributes() {
      return {
        name: {
          default: "",
          parseHTML: (el) => el.getAttribute("data-command") || "",
          renderHTML: (attrs) => ({ "data-command": String(attrs.name ?? "") }),
        },
      };
    },

    parseHTML() {
      return [{ tag: 'span[data-type="slash-command"]' }];
    },

    renderHTML({ HTMLAttributes, node }) {
      return [
        "span",
        mergeAttributes(HTMLAttributes, {
          "data-type": "slash-command",
          class: "composer-atom composer-atom-slash",
        }),
        `/${node.attrs.name}`,
      ];
    },

    renderText({ node }) {
      return `/${node.attrs.name}`;
    },

    addStorage() {
      return {
        markdown: {
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          serialize(state: any, node: any) {
            state.write(`/${node.attrs.name}`);
          },
          parse: {},
        },
      };
    },
  });
}
