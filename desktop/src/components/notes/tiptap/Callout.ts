// Callout — Notion/Obsidian-style admonition block. A coloured, icon-prefixed
// container for asides (info / note / tip / warning / danger / success).
//
// Persistence: round-trips as an Obsidian admonition inside a blockquote —
//
//   > [!info]
//   > body markdown…
//
// so the source stays portable plain-markdown (GitHub + Obsidian render it too)
// and survives Aura's notes_* markdown save path AND the collab Y.Doc. On the
// way in, a markdown-it post-pass (`parse.updateDOM`) rewrites any blockquote
// whose first line is `[!type]` into the callout div the node's parseHTML
// matches; on the way out we wrap the content in `> ` and prepend the marker.
import { Node, mergeAttributes } from "@tiptap/core";

export type CalloutType =
  | "info"
  | "note"
  | "tip"
  | "warning"
  | "danger"
  | "success";

const CALLOUT_TYPES = new Set<string>([
  "info",
  "note",
  "tip",
  "warning",
  "danger",
  "success",
]);

// Emoji glyphs rendered via CSS `::before { content: attr(data-icon) }` — the
// icon is derived from `type`, never persisted on its own.
const CALLOUT_ICON: Record<CalloutType, string> = {
  info: "ℹ️",
  note: "📝",
  tip: "💡",
  warning: "⚠️",
  danger: "🛑",
  success: "✅",
};

function iconFor(type: string): string {
  return CALLOUT_ICON[(CALLOUT_TYPES.has(type) ? type : "info") as CalloutType];
}

declare module "@tiptap/core" {
  interface Commands<ReturnType> {
    callout: {
      setCallout: (attrs?: { type?: CalloutType }) => ReturnType;
      toggleCallout: (attrs?: { type?: CalloutType }) => ReturnType;
    };
  }
}

export const Callout = Node.create({
  name: "callout",
  group: "block",
  content: "block+",
  defining: true,

  addAttributes() {
    return {
      type: {
        default: "info",
        parseHTML: (el) => el.getAttribute("data-callout-type") || "info",
        // One logical attribute that renders both the type hook (read back on
        // parse) and the derived icon glyph (CSS-only, ignored on parse).
        renderHTML: (attrs) => ({
          "data-callout-type": attrs.type,
          "data-icon": iconFor(attrs.type),
        }),
      },
    };
  },

  parseHTML() {
    return [{ tag: 'div[data-type="callout"]' }];
  },

  renderHTML({ HTMLAttributes }) {
    return [
      "div",
      mergeAttributes(HTMLAttributes, {
        "data-type": "callout",
        class: "callout",
      }),
      0,
    ];
  },

  addCommands() {
    return {
      setCallout:
        (attrs) =>
        ({ commands }) =>
          commands.wrapIn(this.name, { type: attrs?.type ?? "info" }),
      toggleCallout:
        (attrs) =>
        ({ commands }) =>
          commands.toggleWrap(this.name, { type: attrs?.type ?? "info" }),
    };
  },

  addStorage() {
    return {
      markdown: {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        serialize(state: any, node: any) {
          // wrapBlock prefixes every emitted line with "> "; the first line is
          // the `[!type]` admonition marker, the rest is the rendered body.
          state.wrapBlock("> ", null, node, () => {
            state.write(`[!${node.attrs.type || "info"}]`);
            state.ensureNewLine();
            state.renderContent(node);
          });
        },
        parse: {
          updateDOM(element: HTMLElement) {
            element.querySelectorAll("blockquote").forEach((bq) => {
              const firstP = bq.querySelector("p");
              if (!firstP) return;
              const text = firstP.textContent ?? "";
              const m = text.match(/^\s*\[!(\w+)\]/);
              if (!m) return;
              const type = CALLOUT_TYPES.has(m[1].toLowerCase())
                ? m[1].toLowerCase()
                : "info";
              // Strip the marker (and the soft-break that follows it) from the
              // first paragraph; drop the paragraph entirely if nothing remains.
              firstP.textContent = text.replace(/^\s*\[!\w+\][ \t]*\n?/, "");
              if (!firstP.textContent.trim()) firstP.remove();
              const div = element.ownerDocument.createElement("div");
              div.setAttribute("data-type", "callout");
              div.setAttribute("data-callout-type", type);
              div.setAttribute("data-icon", iconFor(type));
              div.className = "callout";
              while (bq.firstChild) div.appendChild(bq.firstChild);
              bq.replaceWith(div);
            });
          },
        },
      },
    };
  },
});
