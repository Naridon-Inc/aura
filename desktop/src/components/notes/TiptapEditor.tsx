// TiptapEditor — RR.7. Notion-style block editor for Pages.
//
// Replaces the Monaco markdown surface in NotesWorkpane with a
// proper block editor:
//   • StarterKit gives p, h1-3, ul, ol, blockquote, code-block,
//     horizontal-rule, bold, italic, code, strike, plus the
//     markdown input rules that auto-convert `## `, `- `, `> `,
//     ```` ``` ````, `---`, etc. as the user types.
//   • TaskList + TaskItem render checkboxes via `- [ ]`.
//   • Link extension turns `[text](url)` into a real anchor with
//     a click handler that defers to the parent (so wikilinks
//     keep routing through NotesWorkpane).
//   • Placeholder renders the "Type / for blocks…" hint when the
//     doc is empty.
//   • tiptap-markdown plugs the markdown ↔ ProseMirror doc
//     serializer in, so the editor reads and writes the same
//     markdown the existing notes_* Tauri commands persist —
//     zero migration.
//
// SlashMenu is a thin custom Floating overlay (rendered when the
// active text block contains only `/`). Picks a block command and
// invokes it on the editor. Plane's `Bm` popover served as the UX
// reference but the implementation is from scratch — no AGPL
// transcription.

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { EditorContent, useEditor, type Editor } from "@tiptap/react";
import { BubbleMenu } from "@tiptap/react/menus";
import type { AnyExtension } from "@tiptap/core";
import { StarterKit } from "@tiptap/starter-kit";
import { Placeholder } from "@tiptap/extension-placeholder";
import { Link } from "@tiptap/extension-link";
import { TaskList } from "@tiptap/extension-task-list";
import { TaskItem } from "@tiptap/extension-task-item";
import { Underline } from "@tiptap/extension-underline";
import { TextAlign } from "@tiptap/extension-text-align";
import { Image } from "@tiptap/extension-image";
import { Collaboration } from "@tiptap/extension-collaboration";
import { CollaborationCaret } from "@tiptap/extension-collaboration-caret";
import { DragHandle } from "@tiptap/extension-drag-handle-react";
import { Markdown } from "tiptap-markdown";
import type { Node as PMNode } from "@tiptap/pm/model";
import type { PagesProvider } from "../../lib/pages_collab";
import {
  Heading1,
  Heading2,
  Heading3,
  List,
  ListOrdered,
  ListChecks,
  Quote,
  Code,
  GitBranch,
  Minus,
  Type,
  Info,
  ChevronRight,
  Table as TableIcon,
  Columns2,
  GripVertical,
  Plus,
  Copy,
  Trash2,
  Pilcrow,
  Bold,
  Italic,
  Strikethrough,
  Underline as UnderlineIcon,
  Highlighter,
  AlignLeft,
  AlignCenter,
  AlignRight,
  Image as ImageIcon,
  Link as LinkIcon,
  RemoveFormatting,
} from "lucide-react";
import { cn } from "../../lib/utils";
import { SectionScrollIndicator } from "./SectionScrollIndicator";
import { MermaidAwareCodeBlock } from "./MermaidCodeBlock";
import { CodeHighlight } from "./tiptap/codeHighlight";
import { blockExtensions } from "./tiptap/extensions";
import { registerUndoTarget } from "../../lib/undoRouter";
import { Avatar } from "../team/presentation/Avatar";
import {
  searchMentions,
  flattenMentionResults,
  mentionInsertText,
  type MentionSources,
  type MentionItem,
} from "../pages2/mentionSources";
import { useDismiss } from "../../lib/useDismiss";
import { askText } from "../ui/ask";

// Wikilink transform — tiptap-markdown uses markdown-it which doesn't
// know about `[[Title]]`, so we inflate to standard link syntax with a
// custom `aura-wiki:` scheme before parsing and deflate back on
// serialize. The Link extension renders the anchor; NotesWorkpane's
// onLinkClick intercepts the scheme and routes to the target note.
// `[[Label|Target]]` lets a wikilink display different text from its
// resolution target — mirrors Obsidian's pipe syntax.
function inflateWikilinks(md: string): string {
  return md.replace(/\[\[([^\]|]+?)(?:\|([^\]]+))?\]\]/g, (_, a, b) => {
    const label = (b ?? a).trim();
    const target = a.trim();
    return `[${label}](aura-wiki:${encodeURIComponent(target)})`;
  });
}

function deflateWikilinks(md: string): string {
  return md.replace(
    /\[([^\]]+)\]\(aura-wiki:([^)\s]+)\)/g,
    (_, label, target) => {
      const decoded = decodeURIComponent(target);
      return decoded === label ? `[[${label}]]` : `[[${decoded}|${label}]]`;
    },
  );
}

// Person mentions live as plain `@handle` text (so the Rust handle extractor
// + auto-DM fire). When a click lands inside the document, inspect the text of
// the block at that position and, if the click sits within a `@handle` token,
// return the handle so the caller can open a DM. Returns null otherwise.
function handleAtPos(
  view: { state: { doc: { resolve: (p: number) => { parent: { textContent: string }; start: () => number } } } },
  pos: number,
): string | null {
  try {
    const $pos = view.state.doc.resolve(pos);
    const text = $pos.parent.textContent;
    const offset = pos - $pos.start();
    if (offset < 0 || offset > text.length) return null;
    // Find every `@handle` in the block and test whether `offset` is inside.
    const re = /(^|[\s(\[{>])@([a-zA-Z0-9][a-zA-Z0-9._-]*)/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(text)) !== null) {
      const start = m.index + m[1].length; // position of `@`
      const end = start + 1 + m[2].length; // end of the handle
      if (offset >= start && offset <= end) return m[2];
    }
    return null;
  } catch {
    return null;
  }
}

type Props = {
  /** Markdown source of truth. The component is controlled — it
   *  serializes back to markdown on every change. */
  value: string;
  onChange: (markdown: string) => void;
  /** Optional placeholder shown when the doc is empty. */
  placeholder?: string;
  /** Click handler for inline link clicks. When provided we
   *  intercept before navigation so the parent can route
   *  `aura-wiki:` and other custom schemes. */
  onLinkClick?: (href: string) => boolean;
  className?: string;
  /** Compact mode for embedded surfaces (task descriptions, comment
   *  composers). Drops prose padding/font-size to fit inside a
   *  card without dominating it. */
  dense?: boolean;
  /** Seamless inline mode for canvases embedded in another surface (the Team
   *  channel canvas, plan notes). Like a lighter `dense` but with NO
   *  input-field chrome — no border, no card background — and NO hover block
   *  handle: you just click into the text and type. Approachable 13px body in
   *  the soft text tone rather than a heavy full-document 16px. */
  bare?: boolean;
  /** Auto-focus on mount (e.g. when entering edit mode). */
  autoFocus?: boolean;
  /** Render the dashed right-rail section indicator (h1/h2/h3 jump
   *  dots). Off by default; on for full-page Pages canvas. */
  showSectionIndicator?: boolean;
  /** Receives the live Editor instance once it mounts. Used by the
   *  page-doc layout to drive an external toolbar pill that sits
   *  outside the editor container. */
  editorRef?: React.RefObject<Editor | null>;
  /** Drop the editor's intrinsic px-8/py-6 padding when the parent
   *  wrapper already carries the page margins (page-doc layout). */
  noPadding?: boolean;
  /** Render the content in a centered reading column (≈760px) with
   *  generous horizontal + vertical padding — the document-style Pages
   *  layout. Off by default so legacy notes stay visually unchanged. */
  documentPadding?: boolean;
  /** Pages real-time collab binding (plan 20). When set, the editor
   *  swaps StarterKit's history for Y.Doc-backed history and adds
   *  Collaboration + CollaborationCursor extensions. `value` becomes a
   *  seed-only fallback used when the Y.Doc bootstraps empty (new page).
   *  After mount, the Y.Doc is the source of truth; markdown still
   *  serializes back via `onChange` for disk persistence. */
  collab?: { provider: PagesProvider };
  /** When false the editor is read-only (Lock toggle). Selection + scroll
   *  still work; typing and slash/block commands are blocked. Live-toggles
   *  via editor.setEditable so locking doesn't remount + lose collab state.
   *  Defaults to true. */
  editable?: boolean;
  /** Restricted mode for the Scribble surface: a freeform markdown editor
   *  limited to inline emphasis (bold/italic), checkboxes, plain lists and
   *  @mentions. Headings, quotes, code blocks, dividers, callouts, tables,
   *  columns and images are dropped from the schema — so `# `, `> `, ```` ``` ````,
   *  `---` no longer transform — and the bubble/slash menus only offer the
   *  allowed blocks, with no drag-handle "turn into". Defaults to false, so
   *  every other surface (Pages) is unaffected. */
  restricted?: boolean;
  /** Pages @-mention catalog. When provided, typing `@` opens a compact
   *  popover of people / tasks / pages; picking one inserts a stable
   *  markdown token (people → `@handle`, tasks → `aura://task` link, pages
   *  → page link). Absent ⇒ the editor behaves exactly as before (no @
   *  affordance), so embedded surfaces that don't want mentions opt out by
   *  simply not passing it. */
  mentionSources?: MentionSources;
  /** Fired when a mention is inserted (in addition to the markdown token
   *  round-tripping through onChange). Lets the parent eagerly record the
   *  reference. Optional. */
  onResolveMention?: (item: MentionItem) => void;
  /** Intercept a plain Enter (no Shift) key. When provided and it returns true,
   *  the editor suppresses its own newline — used by the Scribble block list to
   *  turn Enter into "start a new block" instead of a paragraph break. Shift+
   *  Enter still inserts a soft break. */
  onEnterKey?: () => boolean;
};

type SlashItem = {
  id: string;
  label: string;
  icon: React.ReactNode;
  /** Runs on the editor when the user picks the item. We pass the
   *  editor in to keep the items pure data. */
  command: (editor: Editor) => void;
};

const SLASH_ITEMS: SlashItem[] = [
  {
    id: "p",
    label: "Text",
    icon: <Type className="w-3.5 h-3.5" strokeWidth={1.5} />,
    command: (e) => e.chain().focus().setParagraph().run(),
  },
  {
    id: "h1",
    label: "Heading 1",
    icon: <Heading1 className="w-3.5 h-3.5" strokeWidth={1.5} />,
    command: (e) => e.chain().focus().toggleHeading({ level: 1 }).run(),
  },
  {
    id: "h2",
    label: "Heading 2",
    icon: <Heading2 className="w-3.5 h-3.5" strokeWidth={1.5} />,
    command: (e) => e.chain().focus().toggleHeading({ level: 2 }).run(),
  },
  {
    id: "h3",
    label: "Heading 3",
    icon: <Heading3 className="w-3.5 h-3.5" strokeWidth={1.5} />,
    command: (e) => e.chain().focus().toggleHeading({ level: 3 }).run(),
  },
  {
    id: "ul",
    label: "Bullet list",
    icon: <List className="w-3.5 h-3.5" strokeWidth={1.5} />,
    command: (e) => e.chain().focus().toggleBulletList().run(),
  },
  {
    id: "ol",
    label: "Ordered list",
    icon: <ListOrdered className="w-3.5 h-3.5" strokeWidth={1.5} />,
    command: (e) => e.chain().focus().toggleOrderedList().run(),
  },
  {
    id: "todo",
    label: "Todo list",
    icon: <ListChecks className="w-3.5 h-3.5" strokeWidth={1.5} />,
    command: (e) => e.chain().focus().toggleTaskList().run(),
  },
  {
    id: "quote",
    label: "Quote",
    icon: <Quote className="w-3.5 h-3.5" strokeWidth={1.5} />,
    command: (e) => e.chain().focus().toggleBlockquote().run(),
  },
  {
    id: "code",
    label: "Code block",
    icon: <Code className="w-3.5 h-3.5" strokeWidth={1.5} />,
    command: (e) => e.chain().focus().toggleCodeBlock().run(),
  },
  {
    id: "mermaid",
    label: "Diagram (mermaid)",
    icon: <GitBranch className="w-3.5 h-3.5" strokeWidth={1.5} />,
    command: (e) =>
      e
        .chain()
        .focus()
        .setCodeBlock({ language: "mermaid" })
        .insertContent("graph TD\n  A[Start] --> B{Decide}\n  B -->|Yes| C[Do it]\n  B -->|No| D[Skip]")
        .run(),
  },
  {
    id: "callout",
    label: "Callout",
    icon: <Info className="w-3.5 h-3.5" strokeWidth={1.5} />,
    command: (e) => e.chain().focus().toggleCallout({ type: "info" }).run(),
  },
  {
    id: "toggle",
    label: "Toggle list",
    icon: <ChevronRight className="w-3.5 h-3.5" strokeWidth={1.5} />,
    command: (e) => e.chain().focus().setDetails().run(),
  },
  {
    id: "table",
    label: "Table",
    icon: <TableIcon className="w-3.5 h-3.5" strokeWidth={1.5} />,
    command: (e) =>
      e
        .chain()
        .focus()
        .insertTable({ rows: 3, cols: 3, withHeaderRow: true })
        .run(),
  },
  {
    id: "columns",
    label: "Columns",
    icon: <Columns2 className="w-3.5 h-3.5" strokeWidth={1.5} />,
    command: (e) => e.chain().focus().setColumns(2).run(),
  },
  {
    id: "image",
    label: "Image",
    icon: <ImageIcon className="w-3.5 h-3.5" strokeWidth={1.5} />,
    command: (e) => {
      void (async () => {
        const url = await askText({
          title: "Add an image",
          label: "Image address",
          placeholder: "https://…",
          submitLabel: "Insert",
          required: true,
        });
        if (url && url.trim()) {
          e.chain().focus().setImage({ src: url.trim() }).run();
        }
      })();
    },
  },
  {
    id: "hr",
    label: "Divider",
    icon: <Minus className="w-3.5 h-3.5" strokeWidth={1.5} />,
    command: (e) => e.chain().focus().setHorizontalRule().run(),
  },
];

// Block-action menu (drag handle) — "turn into" targets. Each runs against the
// block the handle currently points at; we drop a text selection inside that
// block first so the structural command lands on the right node.
type TurnIntoItem = {
  id: string;
  label: string;
  icon: React.ReactNode;
  run: (editor: Editor) => void;
};

const TURN_INTO: TurnIntoItem[] = [
  {
    id: "p",
    label: "Text",
    icon: <Pilcrow className="w-3.5 h-3.5" strokeWidth={1.5} />,
    run: (e) => e.chain().focus().setParagraph().run(),
  },
  {
    id: "h1",
    label: "Heading 1",
    icon: <Heading1 className="w-3.5 h-3.5" strokeWidth={1.5} />,
    run: (e) => e.chain().focus().setHeading({ level: 1 }).run(),
  },
  {
    id: "h2",
    label: "Heading 2",
    icon: <Heading2 className="w-3.5 h-3.5" strokeWidth={1.5} />,
    run: (e) => e.chain().focus().setHeading({ level: 2 }).run(),
  },
  {
    id: "h3",
    label: "Heading 3",
    icon: <Heading3 className="w-3.5 h-3.5" strokeWidth={1.5} />,
    run: (e) => e.chain().focus().setHeading({ level: 3 }).run(),
  },
  {
    id: "ul",
    label: "Bullet list",
    icon: <List className="w-3.5 h-3.5" strokeWidth={1.5} />,
    run: (e) => e.chain().focus().toggleBulletList().run(),
  },
  {
    id: "todo",
    label: "Todo list",
    icon: <ListChecks className="w-3.5 h-3.5" strokeWidth={1.5} />,
    run: (e) => e.chain().focus().toggleTaskList().run(),
  },
  {
    id: "quote",
    label: "Quote",
    icon: <Quote className="w-3.5 h-3.5" strokeWidth={1.5} />,
    run: (e) => e.chain().focus().toggleBlockquote().run(),
  },
  {
    id: "callout",
    label: "Callout",
    icon: <Info className="w-3.5 h-3.5" strokeWidth={1.5} />,
    run: (e) => e.chain().focus().toggleCallout({ type: "info" }).run(),
  },
];

// Compact icon button for the selection toolbar (bubble menu). Active state
// uses a subtle filled chip — neutral chrome, no accent (accent is reserved
// for primary affordances). `onMouseDown` preventDefault keeps the editor
// selection alive while the command runs.
function ToolButton({
  icon,
  label,
  active,
  onRun,
}: {
  icon: React.ReactNode;
  label: string;
  active?: boolean;
  onRun: () => void;
}) {
  return (
    <button
      type="button"
      aria-label={label}
      aria-pressed={active}
      title={label}
      onMouseDown={(e) => {
        e.preventDefault();
        onRun();
      }}
      className={cn(
        "inline-flex items-center justify-center w-7 h-7 rounded",
        "transition-colors",
        active
          ? "bg-bg-2 text-text-1"
          : "text-text-3 hover:bg-state-hover hover:text-text-1",
      )}
    >
      {icon}
    </button>
  );
}

export function TiptapEditor({
  value,
  onChange,
  placeholder = "Type / for blocks…",
  onLinkClick,
  className,
  dense = false,
  bare = false,
  autoFocus = false,
  showSectionIndicator = false,
  editorRef,
  noPadding = false,
  documentPadding = false,
  collab,
  editable = true,
  restricted = false,
  mentionSources,
  onResolveMention,
  onEnterKey,
}: Props) {
  // Keep the Enter hook current for the editorProps closure (bound once at
  // mount) without rebuilding the editor.
  const onEnterKeyRef = useRef(onEnterKey);
  useEffect(() => {
    onEnterKeyRef.current = onEnterKey;
  }, [onEnterKey]);
  const [slashOpen, setSlashOpen] = useState(false);
  const [slashQuery, setSlashQuery] = useState("");
  const [slashPos, setSlashPos] = useState<{ top: number; left: number } | null>(
    null,
  );
  const [slashIndex, setSlashIndex] = useState(0);
  const containerRef = useRef<HTMLDivElement | null>(null);

  // ── @-mention popover state (Pages) ────────────────────────────────────
  // Mirrors the slash-menu mechanics: detect the in-progress `@query` token
  // at the caret, anchor a popover under it, filter the unified mention
  // catalog, and on pick replace the `@query` range with the mention's
  // markdown token. Only armed when `mentionSources` is provided.
  const [mentionOpen, setMentionOpen] = useState(false);
  const [mentionQuery, setMentionQuery] = useState("");
  const [mentionRange, setMentionRange] = useState<{ from: number; to: number } | null>(
    null,
  );
  const [mentionPos, setMentionPos] = useState<{ top: number; left: number } | null>(
    null,
  );
  const [mentionIndex, setMentionIndex] = useState(0);
  // Editor props are bound once at mount, so read `mentionSources` via a ref
  // to keep the click handler current after the catalog loads.
  const mentionSourcesRef = useRef<MentionSources | undefined>(mentionSources);
  useEffect(() => {
    mentionSourcesRef.current = mentionSources;
  }, [mentionSources]);

  // Drag-handle block menu (Notion ⠿). The handle reports the hovered block via
  // onNodeChange; clicking it opens a menu (turn-into / insert / duplicate /
  // delete) anchored to the handle. Only mounted on full-page surfaces.
  const [blockPos, setBlockPos] = useState<number>(-1);
  const [blockMenuOpen, setBlockMenuOpen] = useState(false);
  const [blockMenuPos, setBlockMenuPos] = useState<{
    top: number;
    left: number;
  } | null>(null);
  const [turnIntoOpen, setTurnIntoOpen] = useState(false);
  // No hover block handle in dense, seamless-bare, or restricted surfaces —
  // those are meant to read as plain text you click into, not a chrome-laden
  // document editor (and restricted has no "turn into" targets to offer).
  const showHandle = !dense && !bare && !restricted;
  // Freeze the handle's target block while its menu is open so moving the
  // mouse toward the menu doesn't re-point it at a different block.
  const blockMenuOpenRef = useRef(false);
  useEffect(() => {
    blockMenuOpenRef.current = blockMenuOpen;
  }, [blockMenuOpen]);

  // Memoize extensions so React doesn't re-build the editor on every
  // render — that would lose cursor + selection state. In collab mode
  // we also swap StarterKit history for Y.Doc-backed undo and add the
  // Collaboration + CollaborationCursor extensions.
  const extensions = useMemo<AnyExtension[]>(
    () => {
      // Disable StarterKit's codeBlock — we plug in a NodeView-extended
      // CodeBlock below so language="mermaid" can swap in a live SVG
      // preview while every other language falls through to <pre><code>.
      // Disable undoRedo in collab mode — Collaboration owns undo via
      // the Y.Doc op stack so the two histories don't fight.
      const starterOpts: Record<string, unknown> = { codeBlock: false };
      if (collab) starterOpts.undoRedo = false;
      if (restricted) {
        // Freeform but limited to a single paragraph of inline markdown: drop
        // headings / quotes / dividers / lists so their input rules (`# `,
        // `> `, `---`, `- `) don't transform. Each Scribble *block* is one such
        // paragraph; the checkbox + task state live on the block itself, not in
        // the editor — so bold / italic / gifs / @mentions are all that's left.
        starterOpts.heading = false;
        starterOpts.blockquote = false;
        starterOpts.horizontalRule = false;
        starterOpts.bulletList = false;
        starterOpts.orderedList = false;
      }
      const base: AnyExtension[] = [
        StarterKit.configure(starterOpts),
        // Code blocks: NodeView owns the shell (see MermaidCodeBlock), and
        // CodeHighlight paints Prism syntax tokens as inline decorations.
        // Omitted in restricted mode — Scribble has no code blocks.
        ...(restricted ? [] : [MermaidAwareCodeBlock, CodeHighlight]),
        Placeholder.configure({
          placeholder,
          emptyEditorClass:
            "before:content-[attr(data-placeholder)] before:text-text-5 before:float-left before:h-0 before:pointer-events-none",
        }),
        // Checkbox lists — full editor only. In restricted Scribble the checkbox
        // is a block-level control, so the editor stays single-paragraph.
        ...(restricted ? [] : [TaskList, TaskItem.configure({ nested: true })]),
        // Underline mark — serializes to `<u>…</u>` via tiptap-markdown's
        // HTMLMark fallback (html:true below), so it round-trips losslessly.
        Underline,
        // Images (incl. GIFs) — `![alt](src)` round-trips through
        // tiptap-markdown's native image serializer; paste/drag of a remote or
        // data-URI gif embeds it. Kept in restricted mode — Scribble supports
        // gifs.
        Image.configure({
          inline: false,
          allowBase64: true,
          HTMLAttributes: { class: "tiptap-image" },
        }),
        // Per-block text alignment for headings + paragraphs — full editor
        // only (no markdown syntax, degrades to left on reload).
        ...(restricted
          ? []
          : [
              TextAlign.configure({
                types: ["heading", "paragraph"],
                alignments: ["left", "center", "right"],
              }),
            ]),
        Link.configure({
          openOnClick: false,
          HTMLAttributes: { class: "text-accent underline hover:text-text-1" },
        }),
        // Notion-style blocks: callout, toggle, columns, highlight, table.
        // Each round-trips through markdown (see tiptap/extensions.ts).
        // Omitted in restricted mode.
        ...(restricted ? [] : blockExtensions()),
        Markdown.configure({
          // html:true lets the structural island blocks (toggle, columns)
          // round-trip — markdown-it passes their <div>/<details> through and
          // ProseMirror reconstructs them via parseHTML. Existing notes are
          // plain prose so this doesn't change their parse.
          html: true,
          linkify: true,
          breaks: false,
          transformPastedText: true,
        }),
      ];
      if (collab) {
        base.push(
          Collaboration.configure({ document: collab.provider.doc }),
          CollaborationCaret.configure({
            provider: { awareness: collab.provider.awareness } as never,
            user: {
              name: collab.provider.options.authorHandle,
              color: collab.provider.options.authorColor,
            },
          }),
        );
      }
      return base;
    },
    [placeholder, collab, restricted],
  );

  const editor = useEditor({
    extensions,
    editable,
    // In collab mode the Y.Doc seeds the editor. Empty Y.Doc + non-empty
    // local `value` is handled by the post-mount seed effect below.
    content: collab ? undefined : inflateWikilinks(value),
    autofocus: autoFocus ? "end" : false,
    editorProps: {
      attributes: {
        class: cn(
          "tiptap-pane prose prose-invert max-w-none",
          "min-h-full focus:outline-none",
          dense
            ? "px-2 py-1.5 text-base leading-5 text-text-1"
            : bare
              ? "px-4 py-3 text-base leading-[1.65] text-text-2"
              : noPadding
                ? "text-lg leading-[1.7] text-text-2"
                : "px-8 py-6 text-lg leading-[1.7] text-text-2",
        ),
      },
      handleKeyDown(_view, event) {
        // Scribble block list: a plain Enter starts a new block instead of a
        // paragraph break. Shift+Enter falls through to a soft break.
        if (
          event.key === "Enter" &&
          !event.shiftKey &&
          !event.metaKey &&
          !event.ctrlKey &&
          !event.altKey &&
          onEnterKeyRef.current
        ) {
          if (onEnterKeyRef.current()) {
            event.preventDefault();
            return true;
          }
        }
        return false;
      },
      handleClick(view, pos, event) {
        const target = event.target as HTMLElement | null;
        const anchor = target?.closest("a");
        const href = anchor?.getAttribute("href");
        if (href && onLinkClick && onLinkClick(href)) {
          event.preventDefault();
          return true;
        }
        // Person mention: `@handle` is plain text (so the backend handle
        // extractor + auto-DM fire). When a mention catalog is present we
        // detect a click that lands inside a known `@handle` word and
        // dispatch a DM-open event; the parent app wires the listener.
        if (mentionSourcesRef.current) {
          const handle = handleAtPos(view, pos);
          if (handle) {
            window.dispatchEvent(
              new CustomEvent("aura:open-dm", { detail: { handle } }),
            );
            event.preventDefault();
            return true;
          }
        }
        return false;
      },
    },
    onUpdate({ editor }) {
      // tiptap-markdown adds `storage.markdown.getMarkdown()` to the
      // editor instance. Serialize on every change so the parent's
      // `value` round-trips back through markdown — no HTML in the
      // notes_* persistence path.
      const md =
        (editor.storage as { markdown?: { getMarkdown: () => string } })
          .markdown?.getMarkdown() ?? "";
      onChange(deflateWikilinks(md));
    },
  });

  // Live-toggle read-only (Lock). setEditable flips the contenteditable +
  // blocks commands without remounting, so a locked page keeps its collab
  // binding, scroll position and selection.
  useEffect(() => {
    if (!editor) return;
    if (editor.isEditable !== editable) editor.setEditable(editable);
  }, [editor, editable]);

  // Claim ⌘Z while this page has focus. ProseMirror keeps undo as a stack of
  // transactions (a Y.js undo manager in collab mode), which the OS-level
  // `undo:` selector cannot reach — so a Page ignored ⌘Z entirely until the
  // Edit menu started routing through us.
  useEffect(() => {
    if (!editor) return;
    return registerUndoTarget({
      hasFocus: () => editor.isFocused,
      undo: () => editor.commands.undo(),
      redo: () => editor.commands.redo(),
    });
  }, [editor]);

  // Keep editor content in sync when `value` changes externally
  // (e.g. switching to another note). We compare against the
  // editor's deflated markdown so we don't fight live edits.
  // Skipped in collab mode — the Y.Doc is the source of truth, and
  // forcing setContent there would rewrite the shared doc out from
  // under remote peers.
  useEffect(() => {
    if (!editor || collab) return;
    const current = deflateWikilinks(
      (editor.storage as { markdown?: { getMarkdown: () => string } })
        .markdown?.getMarkdown() ?? "",
    );
    if (current === value) return;
    editor.commands.setContent(inflateWikilinks(value), { emitUpdate: false });
  }, [value, editor, collab]);

  // Collab seed-once: when a brand-new page's Y.Doc is genuinely empty AND the
  // parent has saved markdown for it, write that markdown into the doc so other
  // clients (and a reload) see the existing content instead of a blank page.
  //
  // Two hazards this guards against, both load-bearing for the click+type fix:
  //  1. Never seed BEFORE the provider has reconciled with the server. The
  //     editor binds Collaboration to a fresh empty Y.Doc on first mount, but
  //     the server snapshot/ops arrive a tick later (connect() is async). If we
  //     seeded immediately we'd double the content once bootstrap merges the
  //     server copy on top. So we wait for provider.onSynced() (bootstrap done,
  //     or solo) and only seed if the fragment is STILL empty then.
  //  2. Seed exactly once, and only into a still-empty shared fragment. We
  //     never setContent over a non-empty shared doc — that would clobber a
  //     peer's live edits and is what remapped the caret to the doc end before.
  //  setContent with emitUpdate:true funnels through ySyncPlugin as a normal
  //  transaction, so the caret stays valid and the seed is just an ordinary
  //  insert into an empty doc — no fighting the bind.
  useEffect(() => {
    if (!editor || !collab) return;
    const provider = collab.provider;
    const fragment = provider.doc.getXmlFragment("default");
    let seeded = false;
    const trySeed = () => {
      if (seeded || editor.isDestroyed) return;
      // A non-empty fragment means the server (or a peer) already has content
      // for this page — nothing to seed, and we must not overwrite it.
      if (fragment.length > 0) {
        seeded = true;
        return;
      }
      if (!value || value.trim().length === 0) {
        seeded = true;
        return;
      }
      editor.commands.setContent(inflateWikilinks(value), { emitUpdate: true });
      seeded = true;
    };
    // Gate on the provider being synced (bootstrap complete OR solo). onSynced
    // fires immediately if already synced — e.g. a re-render after connect.
    const off = provider.onSynced(trySeed);
    return () => {
      off();
    };
    // We deliberately do not depend on `value` — seed is a one-shot hydration
    // of the initial local content; later changes to `value` are ignored in
    // collab mode (the Y.Doc is the source of truth).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [editor, collab]);

  // Collab presence glue: feed the live selection (anchor/head) to the
  // provider on every selection change. CollaborationCaret's yCursorPlugin
  // already mirrors the caret into awareness for remote-caret rendering — this
  // hands the provider the same coordinates so it can carry a coarse
  // `selection` field for peer-list / "who's here" consumers. Behind the
  // `collab` guard so non-collab editors are untouched (no listener, no work).
  useEffect(() => {
    if (!editor || !collab) return;
    const provider = collab.provider;
    const push = () => {
      const { anchor, head } = editor.state.selection;
      provider.setLocalSelection(anchor, head);
    };
    push();
    editor.on("selectionUpdate", push);
    return () => {
      editor.off("selectionUpdate", push);
    };
  }, [editor, collab]);

  // Forward the editor instance to the parent's ref so external
  // toolbars (page-doc TiptapToolbarPill) can issue commands.
  useEffect(() => {
    if (!editorRef) return;
    editorRef.current = editor;
    return () => {
      if (editorRef) editorRef.current = null;
    };
  }, [editor, editorRef]);

  // Slash-menu detection: listen on the editor's selection. When the
  // text block is empty + the user types `/`, open the menu anchored
  // to the cursor's bounding rect. Subsequent chars filter; arrow
  // keys move; Enter picks; Esc dismisses.
  useEffect(() => {
    if (!editor || restricted) return; // no slash menu in restricted Scribble
    function onSelectionUpdate() {
      if (!editor) return;
      const { $from } = editor.state.selection;
      const block = $from.parent;
      const text = block.textContent;
      if (text.startsWith("/")) {
        const q = text.slice(1).toLowerCase();
        setSlashQuery(q);
        setSlashOpen(true);
        setSlashIndex(0);
        const coords = editor.view.coordsAtPos($from.pos);
        const containerRect = containerRef.current?.getBoundingClientRect();
        setSlashPos({
          top: coords.bottom - (containerRect?.top ?? 0) + 4,
          left: coords.left - (containerRect?.left ?? 0),
        });
      } else if (slashOpen) {
        setSlashOpen(false);
      }
    }
    editor.on("selectionUpdate", onSelectionUpdate);
    editor.on("transaction", onSelectionUpdate);
    return () => {
      editor.off("selectionUpdate", onSelectionUpdate);
      editor.off("transaction", onSelectionUpdate);
    };
  }, [editor, slashOpen, restricted]);

  const filteredItems = useMemo(() => {
    // Restricted Scribble offers only the blocks it allows: plain text, a
    // bullet list, and a checkbox todo. No headings / quote / code / table.
    const pool = restricted
      ? SLASH_ITEMS.filter((i) => i.id === "p" || i.id === "ul" || i.id === "todo")
      : SLASH_ITEMS;
    if (!slashQuery) return pool;
    return pool.filter((i) => i.label.toLowerCase().includes(slashQuery));
  }, [slashQuery, restricted]);

  const pickSlash = useCallback(
    (item: SlashItem) => {
      if (!editor) return;
      // Delete the `/query` prefix so the new block starts clean.
      const { $from } = editor.state.selection;
      const start = $from.before($from.depth) + 1;
      const end = $from.pos;
      editor.chain().focus().deleteRange({ from: start, to: end }).run();
      item.command(editor);
      setSlashOpen(false);
      setSlashQuery("");
    },
    [editor],
  );

  // Keyboard nav for the slash menu. Bound at the container so it
  // catches keys even when the editor's focus shifts to a Tiptap
  // command's transient state.
  useEffect(() => {
    if (!slashOpen) return;
    function onKey(e: KeyboardEvent) {
      if (e.key === "ArrowDown") {
        e.preventDefault();
        setSlashIndex((i) => Math.min(filteredItems.length - 1, i + 1));
      } else if (e.key === "ArrowUp") {
        e.preventDefault();
        setSlashIndex((i) => Math.max(0, i - 1));
      } else if (e.key === "Enter") {
        e.preventDefault();
        const pick = filteredItems[slashIndex];
        if (pick) pickSlash(pick);
      } else if (e.key === "Escape") {
        e.preventDefault();
        setSlashOpen(false);
      }
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [slashOpen, slashIndex, filteredItems, pickSlash]);

  // ── @-mention detection ─────────────────────────────────────────────────
  // Walk back from the caret within the current text block to find an
  // in-progress `@token` (no whitespace between the `@` and the caret). When
  // found, open the popover anchored under the `@` and record the doc range
  // [from,to] we'll replace on pick. Disarmed entirely when no mentionSources.
  useEffect(() => {
    if (!editor || !mentionSources) return;
    function detect() {
      if (!editor) return;
      const { $from, empty } = editor.state.selection;
      if (!empty) {
        if (mentionOpen) setMentionOpen(false);
        return;
      }
      const caret = $from.pos;
      const blockStart = $from.start();
      const before = editor.state.doc.textBetween(blockStart, caret, "\n", "\n");
      const at = before.lastIndexOf("@");
      if (at < 0) {
        if (mentionOpen) setMentionOpen(false);
        return;
      }
      const token = before.slice(at + 1);
      // A live mention token is handle-shaped (no whitespace). Anything else
      // (e.g. an email's local part already typed) dismisses the popover.
      if (!/^[a-zA-Z0-9._-]*$/.test(token)) {
        if (mentionOpen) setMentionOpen(false);
        return;
      }
      // The `@` must start a word — preceded by start-of-block or whitespace —
      // so `foo@bar` (email) doesn't trigger.
      const prevChar = at === 0 ? "" : before[at - 1];
      if (prevChar && !/\s/.test(prevChar)) {
        if (mentionOpen) setMentionOpen(false);
        return;
      }
      const from = blockStart + at;
      setMentionRange({ from, to: caret });
      setMentionQuery(token);
      setMentionIndex(0);
      setMentionOpen(true);
      const coords = editor.view.coordsAtPos(from);
      const c = containerRef.current?.getBoundingClientRect();
      setMentionPos({
        top: coords.bottom - (c?.top ?? 0) + 4,
        left: coords.left - (c?.left ?? 0),
      });
    }
    editor.on("selectionUpdate", detect);
    editor.on("transaction", detect);
    return () => {
      editor.off("selectionUpdate", detect);
      editor.off("transaction", detect);
    };
  }, [editor, mentionSources, mentionOpen]);

  const mentionResults = useMemo<MentionItem[]>(() => {
    if (!mentionSources || !mentionOpen) return [];
    return flattenMentionResults(searchMentions(mentionSources, mentionQuery));
  }, [mentionSources, mentionOpen, mentionQuery]);

  const pickMention = useCallback(
    (item: MentionItem) => {
      if (!editor || !mentionRange) return;
      editor
        .chain()
        .focus()
        .insertContentAt(
          { from: mentionRange.from, to: mentionRange.to },
          mentionInsertText(item),
        )
        .run();
      setMentionOpen(false);
      setMentionQuery("");
      setMentionRange(null);
      onResolveMention?.(item);
    },
    [editor, mentionRange, onResolveMention],
  );

  // Keyboard nav for the mention popover. Captured at the window so it wins
  // over the editor's own Enter handling while the popover is open.
  useEffect(() => {
    if (!mentionOpen || mentionResults.length === 0) return;
    function onKey(e: KeyboardEvent) {
      if (e.key === "ArrowDown") {
        e.preventDefault();
        setMentionIndex((i) => Math.min(mentionResults.length - 1, i + 1));
      } else if (e.key === "ArrowUp") {
        e.preventDefault();
        setMentionIndex((i) => Math.max(0, i - 1));
      } else if (e.key === "Enter" || e.key === "Tab") {
        e.preventDefault();
        const pick = mentionResults[mentionIndex];
        if (pick) pickMention(pick);
      } else if (e.key === "Escape") {
        e.preventDefault();
        setMentionOpen(false);
      }
    }
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [mentionOpen, mentionResults, mentionIndex, pickMention]);

  // ── Block-action menu helpers ───────────────────────────────────────────
  // All operate on `blockPos` (the top-level node the handle points at). We
  // re-read the node from the live doc at action time so positions stay valid.
  const closeBlockMenu = useCallback(() => {
    setBlockMenuOpen(false);
    setTurnIntoOpen(false);
  }, []);

  const blockNodeAt = useCallback((): PMNode | null => {
    if (!editor || blockPos < 0) return null;
    return editor.state.doc.nodeAt(blockPos);
  }, [editor, blockPos]);

  const turnInto = useCallback(
    (item: TurnIntoItem) => {
      if (!editor || blockPos < 0) return;
      // Drop a caret inside the target block first so the structural command
      // lands on it rather than the user's previous selection.
      editor.commands.setTextSelection(blockPos + 1);
      item.run(editor);
      closeBlockMenu();
    },
    [editor, blockPos, closeBlockMenu],
  );

  const duplicateBlock = useCallback(() => {
    if (!editor) return;
    const node = blockNodeAt();
    if (!node) return;
    editor
      .chain()
      .focus()
      .insertContentAt(blockPos + node.nodeSize, node.toJSON())
      .run();
    closeBlockMenu();
  }, [editor, blockPos, blockNodeAt, closeBlockMenu]);

  const deleteBlock = useCallback(() => {
    if (!editor) return;
    const node = blockNodeAt();
    if (!node) return;
    editor
      .chain()
      .focus()
      .deleteRange({ from: blockPos, to: blockPos + node.nodeSize })
      .run();
    closeBlockMenu();
  }, [editor, blockPos, blockNodeAt, closeBlockMenu]);

  const insertBelow = useCallback(() => {
    if (!editor) return;
    const node = blockNodeAt();
    if (!node) return;
    const at = blockPos + node.nodeSize;
    editor
      .chain()
      .focus()
      .insertContentAt(at, { type: "paragraph" })
      .setTextSelection(at + 1)
      .run();
    closeBlockMenu();
  }, [editor, blockPos, blockNodeAt, closeBlockMenu]);

  // Dismiss the block menu on outside click / Escape.
  useDismiss(blockMenuOpen, closeBlockMenu, [], {
    insideSelector: "[data-block-menu],[data-drag-handle]",
  });

  // ── Selection toolbar (bubble menu) ─────────────────────────────────────
  // Toggle the link mark. Reuses the already-configured Link extension
  // (openOnClick:false). Prefills the prompt with the existing href when a
  // link is active so the user edits rather than re-types; empty input unsets.
  const toggleLink = useCallback(async () => {
    if (!editor) return;
    const prev = (editor.getAttributes("link").href as string | undefined) ?? "";
    const url = await askText({
      title: prev ? "Edit this link" : "Add a link",
      label: "Link address",
      value: prev,
      placeholder: "https://…",
      body: prev ? "Clear the box to remove the link." : undefined,
      submitLabel: prev ? "Update link" : "Add link",
    });
    if (url === null) return; // cancelled
    if (url.trim() === "") {
      editor.chain().focus().extendMarkRange("link").unsetLink().run();
      return;
    }
    editor
      .chain()
      .focus()
      .extendMarkRange("link")
      .setLink({ href: url.trim() })
      .run();
  }, [editor]);

  return (
    <div
      ref={containerRef}
      className={cn(
        "relative w-full overflow-y-auto",
        dense
          ? "bg-bg-content border border-line-soft rounded"
          : bare
            ? "h-full bg-transparent"
            : "h-full bg-bg-content",
        className,
      )}
    >
      {editor && editor.isEditable && (
        <BubbleMenu
          editor={editor}
          className={cn(
            "z-50 flex items-center gap-0.5 p-1",
            "rounded-md bg-bg-1 border border-line shadow-lg",
          )}
          options={{ placement: "top", offset: 8 }}
          shouldShow={({ editor: ed, state, from, to }) => {
            // Hide for empty/collapsed selections, in read-only mode, and
            // inside code blocks (inline marks don't apply there).
            if (!ed.isEditable) return false;
            if (from === to) return false;
            const { empty } = state.selection;
            if (empty) return false;
            const text = state.doc.textBetween(from, to, "").trim();
            if (text.length === 0) return false;
            if (ed.isActive("codeBlock")) return false;
            return true;
          }}
        >
          <ToolButton
            label="Bold"
            active={editor.isActive("bold")}
            onRun={() => editor.chain().focus().toggleBold().run()}
            icon={<Bold className="w-3.5 h-3.5" strokeWidth={2} />}
          />
          <ToolButton
            label="Italic"
            active={editor.isActive("italic")}
            onRun={() => editor.chain().focus().toggleItalic().run()}
            icon={<Italic className="w-3.5 h-3.5" strokeWidth={2} />}
          />
          {/* Restricted Scribble stops here: bold to highlight + italic only. */}
          {!restricted && (
          <>
          <ToolButton
            label="Underline"
            active={editor.isActive("underline")}
            onRun={() => editor.chain().focus().toggleUnderline().run()}
            icon={<UnderlineIcon className="w-3.5 h-3.5" strokeWidth={2} />}
          />
          <ToolButton
            label="Strikethrough"
            active={editor.isActive("strike")}
            onRun={() => editor.chain().focus().toggleStrike().run()}
            icon={<Strikethrough className="w-3.5 h-3.5" strokeWidth={2} />}
          />
          <ToolButton
            label="Highlight"
            active={editor.isActive("highlight")}
            onRun={() => editor.chain().focus().toggleHighlight().run()}
            icon={<Highlighter className="w-3.5 h-3.5" strokeWidth={2} />}
          />
          <ToolButton
            label="Inline code"
            active={editor.isActive("code")}
            onRun={() => editor.chain().focus().toggleCode().run()}
            icon={<Code className="w-3.5 h-3.5" strokeWidth={2} />}
          />
          <ToolButton
            label="Link"
            active={editor.isActive("link")}
            onRun={toggleLink}
            icon={<LinkIcon className="w-3.5 h-3.5" strokeWidth={2} />}
          />
          <span className="w-px h-4 bg-line-soft mx-0.5" aria-hidden />
          <ToolButton
            label="Heading 1"
            active={editor.isActive("heading", { level: 1 })}
            onRun={() => editor.chain().focus().toggleHeading({ level: 1 }).run()}
            icon={<Heading1 className="w-3.5 h-3.5" strokeWidth={1.75} />}
          />
          <ToolButton
            label="Heading 2"
            active={editor.isActive("heading", { level: 2 })}
            onRun={() => editor.chain().focus().toggleHeading({ level: 2 }).run()}
            icon={<Heading2 className="w-3.5 h-3.5" strokeWidth={1.75} />}
          />
          <ToolButton
            label="Heading 3"
            active={editor.isActive("heading", { level: 3 })}
            onRun={() => editor.chain().focus().toggleHeading({ level: 3 }).run()}
            icon={<Heading3 className="w-3.5 h-3.5" strokeWidth={1.75} />}
          />
          <ToolButton
            label="Paragraph"
            active={editor.isActive("paragraph")}
            onRun={() => editor.chain().focus().setParagraph().run()}
            icon={<Pilcrow className="w-3.5 h-3.5" strokeWidth={1.75} />}
          />
          <span className="w-px h-4 bg-line-soft mx-0.5" aria-hidden />
          <ToolButton
            label="Bullet list"
            active={editor.isActive("bulletList")}
            onRun={() => editor.chain().focus().toggleBulletList().run()}
            icon={<List className="w-3.5 h-3.5" strokeWidth={1.75} />}
          />
          <ToolButton
            label="Ordered list"
            active={editor.isActive("orderedList")}
            onRun={() => editor.chain().focus().toggleOrderedList().run()}
            icon={<ListOrdered className="w-3.5 h-3.5" strokeWidth={1.75} />}
          />
          <ToolButton
            label="Blockquote"
            active={editor.isActive("blockquote")}
            onRun={() => editor.chain().focus().toggleBlockquote().run()}
            icon={<Quote className="w-3.5 h-3.5" strokeWidth={1.75} />}
          />
          {!documentPadding && (
            <>
              <span className="w-px h-4 bg-line-soft mx-0.5" aria-hidden />
              <ToolButton
                label="Align left"
                active={editor.isActive({ textAlign: "left" })}
                onRun={() => editor.chain().focus().setTextAlign("left").run()}
                icon={<AlignLeft className="w-3.5 h-3.5" strokeWidth={1.75} />}
              />
              <ToolButton
                label="Align center"
                active={editor.isActive({ textAlign: "center" })}
                onRun={() => editor.chain().focus().setTextAlign("center").run()}
                icon={<AlignCenter className="w-3.5 h-3.5" strokeWidth={1.75} />}
              />
              <ToolButton
                label="Align right"
                active={editor.isActive({ textAlign: "right" })}
                onRun={() => editor.chain().focus().setTextAlign("right").run()}
                icon={<AlignRight className="w-3.5 h-3.5" strokeWidth={1.75} />}
              />
            </>
          )}
          <span className="w-px h-4 bg-line-soft mx-0.5" aria-hidden />
          <ToolButton
            label="Clear formatting"
            onRun={() =>
              editor.chain().focus().unsetAllMarks().clearNodes().run()
            }
            icon={<RemoveFormatting className="w-3.5 h-3.5" strokeWidth={1.75} />}
          />
          </>
          )}
        </BubbleMenu>
      )}
      {documentPadding ? (
        // Full-width document canvas: readable blocks self-clamp to a centered
        // ~760px measure (CSS under `.pages-doc`), while wide blocks — tables,
        // code, images — get the full document width. Don't hard-clamp the
        // wrapper, or a wide table can never break past the text column.
        <div className="w-full px-5 py-5 sm:px-8">
          <EditorContent editor={editor} className="min-h-full" />
        </div>
      ) : (
        <EditorContent editor={editor} className="h-full" />
      )}
      {editor && showHandle && (
        <DragHandle
          editor={editor}
          className="tiptap-drag-handle-portal"
          onNodeChange={({ pos }) => {
            // Freeze the target while the menu is open (see ref above).
            if (blockMenuOpenRef.current) return;
            setBlockPos(pos);
          }}
        >
          <div className="tiptap-handle-wrap" data-drag-handle>
            <button
              type="button"
              className="tiptap-handle-add"
              aria-label="Insert block below"
              onClick={(e) => {
                e.preventDefault();
                e.stopPropagation();
                insertBelow();
              }}
            >
              <Plus className="w-4 h-4" strokeWidth={1.75} />
            </button>
            <button
              type="button"
              className="tiptap-handle-grip"
              aria-label="Block actions"
              onClick={(e) => {
                e.preventDefault();
                e.stopPropagation();
                // Anchor the menu in the container at the handle's location so
                // it doesn't ride the drag-handle portal as it re-positions.
                const rect = (
                  e.currentTarget as HTMLElement
                ).getBoundingClientRect();
                const c = containerRef.current?.getBoundingClientRect();
                setBlockMenuPos({
                  top: rect.bottom - (c?.top ?? 0) + 4,
                  left: rect.left - (c?.left ?? 0),
                });
                setTurnIntoOpen(false);
                setBlockMenuOpen((v) => !v);
              }}
            >
              <GripVertical className="w-4 h-4" strokeWidth={1.75} />
            </button>
          </div>
        </DragHandle>
      )}
      {blockMenuOpen && blockMenuPos && (
        <div
          data-block-menu
          role="menu"
          aria-label="Block actions"
          className={cn(
            "absolute z-40 w-[184px] p-1 rounded-lg",
            "bg-bg-1 border border-line-soft shadow-[var(--shadow-flyout)]",
          )}
          style={{ top: blockMenuPos.top, left: blockMenuPos.left }}
        >
          <button
            type="button"
            className="tiptap-menu-row"
            onMouseEnter={() => setTurnIntoOpen(true)}
            onClick={(e) => {
              e.preventDefault();
              setTurnIntoOpen((v) => !v);
            }}
          >
            <Type className="w-3.5 h-3.5" strokeWidth={1.5} />
            <span className="flex-1 text-left">Turn into</span>
            <ChevronRight className="w-3.5 h-3.5" strokeWidth={1.5} />
          </button>
          {turnIntoOpen && (
            <div
              data-block-menu
              className={cn(
                "absolute left-[180px] top-0 w-[176px] p-1 rounded-md",
                "bg-bg-1 border border-line-soft shadow-[var(--shadow-flyout)]",
                "max-h-[280px] overflow-y-auto",
              )}
            >
              {TURN_INTO.map((item) => (
                <button
                  key={item.id}
                  type="button"
                  className="tiptap-menu-row"
                  onClick={(e) => {
                    e.preventDefault();
                    turnInto(item);
                  }}
                >
                  <span className="text-text-5">{item.icon}</span>
                  <span className="flex-1 text-left">{item.label}</span>
                </button>
              ))}
            </div>
          )}
          <button
            type="button"
            className="tiptap-menu-row"
            onClick={(e) => {
              e.preventDefault();
              duplicateBlock();
            }}
          >
            <Copy className="w-3.5 h-3.5" strokeWidth={1.5} />
            <span className="flex-1 text-left">Duplicate</span>
          </button>
          <button
            type="button"
            className="tiptap-menu-row tiptap-menu-row-danger"
            onClick={(e) => {
              e.preventDefault();
              deleteBlock();
            }}
          >
            <Trash2 className="w-3.5 h-3.5" strokeWidth={1.5} />
            <span className="flex-1 text-left">Delete</span>
          </button>
        </div>
      )}
      {showSectionIndicator && (
        <SectionScrollIndicator containerRef={containerRef} />
      )}
      {slashOpen && slashPos && filteredItems.length > 0 && (
        <div
          role="menu"
          aria-label="Slash menu"
          className={cn(
            "absolute z-30 w-[200px] p-1 rounded-lg",
            "bg-bg-1 border border-line-soft shadow-[var(--shadow-flyout)]",
            "max-h-[260px] overflow-y-auto",
          )}
          style={{ top: slashPos.top, left: slashPos.left }}
        >
          {filteredItems.map((item, i) => (
            <button
              key={item.id}
              type="button"
              onMouseDown={(e) => {
                e.preventDefault();
                pickSlash(item);
              }}
              onMouseEnter={() => setSlashIndex(i)}
              className={cn(
                "w-full text-left px-2 py-1.5 text-sm rounded",
                "flex items-center gap-2",
                i === slashIndex
                  ? "bg-bg-2 text-text-1"
                  : "text-text-3 hover:bg-state-hover hover:text-text-1",
              )}
            >
              <span className="text-text-5">{item.icon}</span>
              {item.label}
            </button>
          ))}
        </div>
      )}
      {mentionOpen && mentionPos && mentionResults.length > 0 && (
        <div
          role="menu"
          aria-label="Mention"
          className={cn(
            "absolute z-40 w-[256px] p-1 rounded-lg",
            "bg-bg-1 border border-line-soft shadow-[var(--shadow-flyout)]",
            "max-h-[280px] overflow-y-auto",
          )}
          style={{ top: mentionPos.top, left: mentionPos.left }}
        >
          {mentionResults.map((item, i) => (
            <button
              key={`${item.kind}:${item.id}`}
              type="button"
              onMouseDown={(e) => {
                e.preventDefault();
                pickMention(item);
              }}
              onMouseEnter={() => setMentionIndex(i)}
              className={cn(
                "w-full text-left px-2 py-1.5 rounded flex items-center gap-2",
                i === mentionIndex
                  ? "bg-bg-2 text-text-1"
                  : "text-text-2 hover:bg-state-hover hover:text-text-1",
              )}
            >
              {item.kind === "person" ? (
                <Avatar name={item.avatarHandle || item.label} size={18} />
              ) : (
                <span
                  className={cn(
                    "inline-flex items-center justify-center w-[18px] h-[18px] rounded-sm text-2xs font-medium flex-shrink-0",
                    item.kind === "task"
                      ? "bg-bg-2 text-accent aura-ident"
                      : item.kind === "pr"
                        ? "bg-bg-2 text-violet"
                        : "bg-bg-2 text-text-3",
                  )}
                  aria-hidden
                >
                  {item.kind === "task" ? "#" : item.kind === "pr" ? "PR" : "¶"}
                </span>
              )}
              <span className="flex flex-col min-w-0 leading-tight">
                <span className="text-sm truncate">
                  {item.kind === "person" ? `@${item.label}` : item.label}
                </span>
                {item.sublabel && (
                  <span className="text-xs text-text-4 truncate">
                    {item.sublabel}
                  </span>
                )}
              </span>
              <span className="section-label ml-auto flex-shrink-0">
                {item.kind}
              </span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
