// FileMentionNode — an inline atom chip for an `@file` mention in the Tiptap
// composer.
//
// When the user picks a file from the `@`-mention popup, we insert ONE atomic
// inline node (not loose text) that renders as a rounded pill carrying the
// file's path. Being atomic, it deletes whole on a single Backspace and
// survives copy-paste: ProseMirror serializes it back to plain `@path` text
// (see the `markdown` storage) so a pasted draft round-trips, and the brain
// receives exactly `@path/to/file` — the same `@mention` convention the legacy
// textarea composer appended for path drops, so the backend resolver is
// unchanged.
//
// Mirrors the project's existing custom-node idioms (notes/tiptap/Callout.ts):
// `Node.create` + `mergeAttributes`, an inline `markdown` storage serializer,
// and token-only styling via a class the composer's CSS hooks. Sibling of
// `SlashCommandNode` — same shape, different verb glyph.

import { Node, mergeAttributes } from "@tiptap/core";
import { basename } from "../../../lib/paths";

export type FileMentionAttrs = {
  /** Full repo-relative (or absolute) path the chip carries, e.g.
   *  "aura-shell/src/lib/api.ts". The chip's visible label is the basename;
   *  the serialized `@path` carries the whole thing for the backend resolver. */
  path: string;
};

/** Build the `@file` atom node. A factory (not a bare const) so the caller
 *  site reads symmetrically with `createSlashCommandNode()` and leaves room
 *  for per-instance options later without a breaking signature change. */
export function createFileMentionNode() {
  return Node.create({
    name: "fileMention",
    group: "inline",
    inline: true,
    atom: true,
    selectable: true,

    addAttributes() {
      return {
        path: {
          default: "",
          parseHTML: (el) => el.getAttribute("data-path") || "",
          renderHTML: (attrs) => ({ "data-path": String(attrs.path ?? "") }),
        },
      };
    },

    parseHTML() {
      return [{ tag: 'span[data-type="file-mention"]' }];
    },

    renderHTML({ HTMLAttributes, node }) {
      const path = String(node.attrs.path ?? "");
      return [
        "span",
        mergeAttributes(HTMLAttributes, {
          "data-type": "file-mention",
          class: "composer-atom composer-atom-mention",
          title: path,
        }),
        `@${basename(path)}`,
      ];
    },

    // The brain receives the FULL path, not just the basename — the chip is a
    // display convenience, the `@path` token is the payload.
    renderText({ node }) {
      return `@${String(node.attrs.path ?? "")}`;
    },

    addStorage() {
      return {
        markdown: {
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          serialize(state: any, node: any) {
            state.write(`@${String(node.attrs.path ?? "")}`);
          },
          parse: {},
        },
      };
    },
  });
}
