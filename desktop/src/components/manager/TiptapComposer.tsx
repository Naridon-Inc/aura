// TiptapComposer — the rich-text input that replaces the Manager composer's
// plain textarea.
//
// Why a ProseMirror editor instead of a `<textarea>`: slash commands and
// `@file` mentions become real inline ATOM chips (rounded pills) rather than
// loose text. A chip deletes whole on one Backspace, can't be half-edited into
// a broken token, and survives copy-paste — on the way out the editor
// serializes each chip back to plain `/cmd` / `@path` (via the nodes' markdown
// storage), so the message the brain receives is byte-identical to what the
// old textarea produced. Everything else (Enter=send, Shift+Enter=newline,
// auto-grow, draft text) keeps the textarea's behavior.
//
// The editor is UNCONTROLLED past first mount (a controlled ProseMirror would
// fight the cursor on every keystroke). The parent owns the *markdown string*:
// we lift it on every change via `onChange`, restore an initial draft once,
// and expose an imperative `clear()` through a ref so a successful send can
// reset the doc without a controlled round-trip.
//
// Slash + mention menus are driven from editor state (the live token under the
// caret), NOT the `@tiptap/suggestion` plugin — same approach the legacy
// textarea used, so the menu UI and matching logic stay shared and simple.

import {
  forwardRef,
  useCallback,
  useEffect,
  useImperativeHandle,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { EditorContent, useEditor } from "@tiptap/react";
import { StarterKit } from "@tiptap/starter-kit";
import { Placeholder } from "@tiptap/extension-placeholder";
import { Markdown } from "tiptap-markdown";

import { createSlashCommandNode } from "./nodes/SlashCommandNode";
import { createFileMentionNode } from "./nodes/FileMentionNode";
import { matchManagerCommands } from "../../lib/managerCommands";
import {
  cachedClaudeCommands,
  primeClaudeCommands,
  type ClaudeCommand,
} from "../../lib/claudeCommands";
import { api } from "../../lib/api";

/** One row in the slash menu — either a native Aura verb (`source: "aura"`) or
 *  one of Claude Code's own custom commands (`source: "claude"`, which run on
 *  Claude's CLI regardless of the active brain). Both carry a `name` + summary;
 *  only Aura verbs carry an `args` hint, only Claude rows carry a `scope`. */
type SlashItem = {
  name: string;
  summary: string;
  args?: string;
  source: "aura" | "claude";
  scope?: "project" | "user";
};

/** Imperative handle the parent uses to reset / focus the editor without a
 *  controlled value round-trip. */
export type TiptapComposerHandle = {
  /** Empty the document (after a successful send). */
  clear: () => void;
  focus: () => void;
  /** Append text at the end + focus — used by the external-context bridge
   *  (browser Agentation), which grows the draft. */
  appendText: (text: string) => void;
  /** Replace the whole document with raw markdown, then place the caret at
   *  `caret` (default "end"). Used by dictation (rewrites the tail from a
   *  captured base) and by message-history recall — recall passes "start" when
   *  stepping to an OLDER message so the next ArrowUp is already at doc-start
   *  and walks further back, instead of getting stuck one message in. */
  setMarkdown: (markdown: string, caret?: "start" | "end") => void;
};

/** One `@file` candidate surfaced in the mention popup. `isDir` rows descend
 *  into the directory instead of inserting a chip. */
type FileEntry = { name: string; path: string; isDir: boolean };

type Props = {
  /** Working directory — the root the `@file` mention popup lists from. */
  repoRoot: string | null;
  /** Restored once on mount; the editor is uncontrolled afterward. */
  initialMarkdown: string;
  busy: boolean;
  placeholder: string;
  /** Lifts the live markdown on every edit so the parent can persist the
   *  per-session draft + know when there's content to send. */
  onChange: (markdown: string) => void;
  /** Enter with no modifier (and no open popup) — the parent reads the
   *  current markdown off its own `onChange` mirror and submits. */
  onSubmit: () => void;
  /** Esc while busy — the parent maps this to Stop. */
  onEscapeWhileBusy?: () => void;
  /** Image files pulled out of a clipboard paste *inside* the editor.
   *  ProseMirror intercepts `paste` (preventDefault) before the window-level
   *  listener can read the clipboard, so a Cmd-V'd screenshot would silently
   *  vanish; we surface the image bytes here so the parent attaches them. */
  onImageFiles?: (files: File[]) => void;
  /** True when the parent's per-session message-history ring has something to
   *  recall — gates the shell-style Up/Down recall so we only claim the arrow
   *  keys (at the doc start/end boundary) when there's actually history to
   *  walk. The parent applies the recalled text via the `setMarkdown` handle in
   *  response to the `aura:composer:history-move` event we dispatch. */
  canRecallHistory?: boolean;
};

// Pull the markdown serialization tiptap-markdown bolts onto editor storage.
function readMarkdown(
  editor: { storage: unknown } | null | undefined,
): string {
  if (!editor) return "";
  const storage = editor.storage as {
    markdown?: { getMarkdown?: () => string };
  };
  return storage.markdown?.getMarkdown?.() ?? "";
}

export const TiptapComposer = forwardRef<TiptapComposerHandle, Props>(
  function TiptapComposer(
    {
      repoRoot,
      initialMarkdown,
      busy,
      placeholder,
      onChange,
      onSubmit,
      onEscapeWhileBusy,
      onImageFiles,
      canRecallHistory = false,
    },
    ref,
  ) {
    // Popup state — the live token under the caret. `slashQuery` is the verb
    // after a bare `/`; `mentionQuery` is the path fragment after an `@`. Only
    // one is ever non-null. `null` = no popup.
    const [slashQuery, setSlashQuery] = useState<string | null>(null);
    const [mentionQuery, setMentionQuery] = useState<string | null>(null);
    const [sel, setSel] = useState(0);
    const [fileEntries, setFileEntries] = useState<FileEntry[]>([]);
    // Claude Code's own custom slash commands (`.claude/commands/*.md`) — shown
    // in the menu alongside Aura's verbs so they're reachable from this chat
    // whatever the active brain. Primed off the cache on mount/repo change.
    const [claudeCmds, setClaudeCmds] = useState<ClaudeCommand[]>(
      repoRoot ? cachedClaudeCommands(repoRoot) : [],
    );

    // Stable callbacks so the editor's `handleKeyDown` (created once) always
    // reaches the latest popup state without re-instantiating the editor.
    const stateRef = useRef({ slashQuery, mentionQuery, sel });
    stateRef.current = { slashQuery, mentionQuery, sel };

    // Submit / Escape handlers + the history-recall gate are read through a ref
    // for the same reason — so `handleKeyDown` (created once) always sees the
    // latest values without re-instantiating the editor.
    const handlersRef = useRef({ onSubmit, onEscapeWhileBusy, busy, canRecallHistory, onImageFiles });
    handlersRef.current = { onSubmit, onEscapeWhileBusy, busy, canRecallHistory, onImageFiles };

    // Menu rows = Aura's native verbs first, then Claude's custom commands
    // whose name isn't already an Aura verb (so a collision shows once, as the
    // native one). Empty query lists everything.
    const slashMatches = useMemo<SlashItem[]>(() => {
      if (slashQuery === null) return [];
      const q = slashQuery;
      const aura: SlashItem[] = matchManagerCommands(q).map((c) => ({
        name: c.name,
        summary: c.summary,
        args: c.args,
        source: "aura",
      }));
      const auraNames = new Set(aura.map((a) => a.name.toLowerCase()));
      const claude: SlashItem[] = claudeCmds
        .filter(
          (c) =>
            (!q || c.name.toLowerCase().startsWith(q)) &&
            !auraNames.has(c.name.toLowerCase()),
        )
        .map((c) => ({
          name: c.name,
          summary: c.summary,
          source: "claude",
          scope: c.scope,
        }));
      return [...aura, ...claude];
    }, [slashQuery, claudeCmds]);
    const slashOpen = slashQuery !== null && slashMatches.length > 0;

    // Mention matches: filter the fetched directory listing by the trailing
    // segment of the query (the part after the last `/`).
    const mentionMatches = useMemo(() => {
      if (mentionQuery === null) return [];
      const lastSlash = mentionQuery.lastIndexOf("/");
      const frag = (lastSlash >= 0 ? mentionQuery.slice(lastSlash + 1) : mentionQuery).toLowerCase();
      return fileEntries
        .filter((e) => e.name.toLowerCase().includes(frag))
        .slice(0, 8);
    }, [mentionQuery, fileEntries]);
    const mentionOpen = mentionQuery !== null && mentionMatches.length > 0;

    const popupCount = slashOpen
      ? slashMatches.length
      : mentionOpen
        ? mentionMatches.length
        : 0;

    // ── Token detection ──────────────────────────────────────────────────
    // Read the text immediately before the caret to find an active `/verb`
    // (at the very start of a block) or `@path` token. Runs on every editor
    // update so the popup tracks typing without a suggestion plugin.
    const detectToken = useCallback(
      (editor: NonNullable<ReturnType<typeof useEditor>>) => {
        const { state } = editor;
        const { from, empty } = state.selection;
        if (!empty) {
          setSlashQuery(null);
          setMentionQuery(null);
          return;
        }
        // Text from the start of the current text block up to the caret.
        const $from = state.selection.$from;
        const blockStart = $from.start();
        const before = state.doc.textBetween(blockStart, from, "\n", "\0");

        // Slash: a bare `/verb` that IS the whole block so far (no leading
        // text) — mirrors the textarea's `^\/([a-zA-Z?]*)$` gate.
        const slashM = before.match(/^\/([a-zA-Z?]*)$/);
        if (slashM) {
          setSlashQuery(slashM[1].toLowerCase());
          setMentionQuery(null);
          return;
        }
        setSlashQuery(null);

        // Mention: an `@frag` token at the caret, bounded by whitespace on the
        // left. Allow path chars (`/`, `.`, `-`, `_`) so subdir descent works.
        const mentionM = before.match(/(?:^|\s)@([\w./-]*)$/);
        if (mentionM) {
          setMentionQuery(mentionM[1]);
        } else {
          setMentionQuery(null);
        }
      },
      [],
    );

    const editor = useEditor({
      extensions: [
        StarterKit.configure({
          // The composer is single-message prose; drop block furniture that
          // would let the user build a document inside the input.
          heading: false,
          horizontalRule: false,
          blockquote: false,
          codeBlock: false,
        }),
        Placeholder.configure({ placeholder }),
        Markdown.configure({ html: false, transformPastedText: true }),
        createSlashCommandNode(),
        createFileMentionNode(),
      ],
      content: initialMarkdown,
      editorProps: {
        attributes: {
          class: "tiptap-composer-input no-scrollbar",
        },
        handleKeyDown: (_view, event) => {
          const { slashQuery: sq, mentionQuery: mq, sel: curSel } = stateRef.current;
          const open = sq !== null || mq !== null;
          // The popup owns navigation keys while it's open. We read the live
          // match count off the DOM-independent refs via a custom event below;
          // here we only need to know SOMETHING is open to claim the keys.
          if (open) {
            if (event.key === "ArrowDown" || event.key === "ArrowUp") {
              event.preventDefault();
              const dir = event.key === "ArrowDown" ? 1 : -1;
              window.dispatchEvent(
                new CustomEvent("aura:composer:popup-move", { detail: dir }),
              );
              return true;
            }
            if (event.key === "Enter" || event.key === "Tab") {
              event.preventDefault();
              window.dispatchEvent(new CustomEvent("aura:composer:popup-pick"));
              return true;
            }
            if (event.key === "Escape") {
              event.preventDefault();
              window.dispatchEvent(new CustomEvent("aura:composer:popup-close"));
              return true;
            }
            void curSel;
          }
          // Shell-style message-history recall (popup closed only). Up at the
          // very START of the doc walks back through the user's own sent
          // messages; Down at the very END walks forward toward the newest and
          // — past it — restores the in-progress draft. We claim the key ONLY at
          // the true start/end boundary so normal multi-line cursor navigation
          // keeps working, and only when the parent says there's history to
          // recall. Plain arrows (no modifiers) — leave option/cmd combos to
          // ProseMirror's word/line motion.
          if (
            !open &&
            handlersRef.current.canRecallHistory &&
            (event.key === "ArrowUp" || event.key === "ArrowDown") &&
            !event.shiftKey &&
            !event.metaKey &&
            !event.ctrlKey &&
            !event.altKey
          ) {
            const { state } = _view;
            const { selection } = state;
            // doc positions are 1-indexed: start = 1, end of a single block =
            // content.size - 1. Require an empty selection (a caret, not a
            // range) sitting exactly on the boundary. Empty-doc => both true.
            const docStart = 1;
            const docEnd = state.doc.content.size - 1;
            const atStart = selection.empty && selection.from <= docStart;
            const atEnd = selection.empty && selection.to >= docEnd;
            if (
              (event.key === "ArrowUp" && atStart) ||
              (event.key === "ArrowDown" && atEnd)
            ) {
              event.preventDefault();
              window.dispatchEvent(
                new CustomEvent("aura:composer:history-move", {
                  detail: { dir: event.key === "ArrowUp" ? "up" : "down" },
                }),
              );
              return true;
            }
          }
          if (event.key === "Escape" && handlersRef.current.busy) {
            event.preventDefault();
            handlersRef.current.onEscapeWhileBusy?.();
            return true;
          }
          // Enter (no shift, no popup) submits; Shift+Enter falls through to
          // ProseMirror's hard-break.
          if (event.key === "Enter" && !event.shiftKey && !open) {
            event.preventDefault();
            handlersRef.current.onSubmit();
            return true;
          }
          return false;
        },
        // Cmd-V of a screenshot lands here first — ProseMirror would otherwise
        // drop image bytes on the floor (it has no image node). Pull any image
        // items out of the clipboard and hand them up to be attached; let text
        // paste fall through to ProseMirror's default by returning false.
        handlePaste: (_view, event) => {
          const items = event.clipboardData?.items;
          if (!items || items.length === 0) return false;
          const files: File[] = [];
          for (let i = 0; i < items.length; i++) {
            const it = items[i];
            if (it.kind === "file" && it.type.startsWith("image/")) {
              const f = it.getAsFile();
              if (f) files.push(f);
            }
          }
          if (files.length === 0) return false;
          event.preventDefault();
          handlersRef.current.onImageFiles?.(files);
          return true;
        },
      },
      onUpdate: ({ editor }) => {
        onChange(readMarkdown(editor));
        detectToken(editor);
      },
      onSelectionUpdate: ({ editor }) => {
        detectToken(editor);
      },
    });

    // ── Imperative handle ────────────────────────────────────────────────
    useImperativeHandle(
      ref,
      () => ({
        clear: () => {
          editor?.commands.clearContent(true);
          setSlashQuery(null);
          setMentionQuery(null);
          onChange("");
        },
        focus: () => editor?.commands.focus("end"),
        appendText: (text: string) => {
          const add = text.trim();
          if (!add || !editor) return;
          const sep = editor.getText().trim() ? "\n\n" : "";
          editor.chain().focus("end").insertContent(`${sep}${add}`).run();
        },
        setMarkdown: (markdown: string, caret: "start" | "end" = "end") => {
          if (!editor) return;
          editor.commands.setContent(markdown, { emitUpdate: false });
          // Park the caret + focus at the requested boundary in one shot.
          // "start" is what history-recall-up needs so a held ArrowUp keeps
          // stepping back through every earlier message.
          editor.commands.focus(caret);
          onChange(readMarkdown(editor));
        },
      }),
      [editor, onChange],
    );

    // Disable the editor while busy (the send path is blocked anyway, and a
    // disabled field reads as "wait").
    useEffect(() => {
      editor?.setEditable(!busy);
    }, [editor, busy]);

    // Reset the selection highlight whenever the active query changes so the
    // popup always opens on its first row.
    useEffect(() => {
      setSel(0);
    }, [slashQuery, mentionQuery]);

    // Discover Claude Code's custom commands for this repo — once on mount/repo
    // change, and again each time the slash menu opens, so a command file added
    // mid-session shows up without a reload. Cache-backed, so the synchronous
    // menu render always has the last-known list.
    useEffect(() => {
      if (!repoRoot) {
        setClaudeCmds([]);
        return;
      }
      if (slashQuery === null) return;
      let alive = true;
      void primeClaudeCommands(repoRoot).then((list) => {
        if (alive) setClaudeCmds(list);
      });
      return () => {
        alive = false;
      };
    }, [repoRoot, slashQuery !== null]);

    // Fetch the directory listing for the active mention query. The portion
    // before the last `/` is the directory to list; we re-fetch only when that
    // directory changes (not on every keystroke within the same folder).
    const mentionDir = useMemo(() => {
      if (mentionQuery === null || repoRoot === null) return null;
      const lastSlash = mentionQuery.lastIndexOf("/");
      return lastSlash >= 0 ? mentionQuery.slice(0, lastSlash) : "";
    }, [mentionQuery, repoRoot]);

    useEffect(() => {
      if (mentionDir === null || repoRoot === null) {
        setFileEntries([]);
        return;
      }
      let alive = true;
      const dirPath = mentionDir ? `${repoRoot}/${mentionDir}` : repoRoot;
      void api
        .listDir(dirPath)
        .then((entries) => {
          if (!alive) return;
          setFileEntries(
            entries
              // Hide VCS/dependency noise that would drown real files.
              .filter((e) => e.name !== ".git" && e.name !== "node_modules" && e.name !== "target")
              .map((e) => ({
                name: e.name,
                // Re-root the path to be repo-relative for the chip / `@token`.
                path: mentionDir ? `${mentionDir}/${e.name}` : e.name,
                isDir: e.is_dir,
              })),
          );
        })
        .catch(() => {
          if (alive) setFileEntries([]);
        });
      return () => {
        alive = false;
      };
    }, [mentionDir, repoRoot]);

    // ── Insertion ────────────────────────────────────────────────────────
    // Replace the active `/verb` token with a slashCommand chip + trailing
    // space, ready for args.
    const insertSlash = useCallback(
      (cmd: SlashItem) => {
        if (!editor) return;
        const { state } = editor;
        const { from } = state.selection;
        const $from = state.selection.$from;
        const blockStart = $from.start();
        // The token spans from the `/` (block start, since the gate requires
        // it to lead the block) to the caret.
        editor
          .chain()
          .focus()
          .deleteRange({ from: blockStart, to: from })
          .insertContent([
            { type: "slashCommand", attrs: { name: cmd.name } },
            { type: "text", text: " " },
          ])
          .run();
        setSlashQuery(null);
      },
      [editor],
    );

    // Insert (or descend into) a mention candidate. Directories rewrite the
    // query to that folder + a trailing slash so the next listing descends;
    // files insert a fileMention chip + trailing space.
    const insertMention = useCallback(
      (entry: FileEntry) => {
        if (!editor) return;
        const { state } = editor;
        const { from } = state.selection;
        const $from = state.selection.$from;
        const blockStart = $from.start();
        const before = state.doc.textBetween(blockStart, from, "\n", "\0");
        const at = before.match(/@([\w./-]*)$/);
        if (!at) return;
        const tokenStart = from - at[1].length; // position right after `@`

        if (entry.isDir) {
          // Rewrite the path fragment to "<dir>/" so the popup descends.
          editor
            .chain()
            .focus()
            .deleteRange({ from: tokenStart, to: from })
            .insertContent(`${entry.path}/`)
            .run();
          // Token detection re-runs on the resulting selection update.
          return;
        }

        // Replace `@frag` (including the leading `@`, one char before
        // tokenStart) with a fileMention chip + trailing space.
        editor
          .chain()
          .focus()
          .deleteRange({ from: tokenStart - 1, to: from })
          .insertContent([
            { type: "fileMention", attrs: { path: entry.path } },
            { type: "text", text: " " },
          ])
          .run();
        setMentionQuery(null);
      },
      [editor],
    );

    // ── Popup keyboard bridge ────────────────────────────────────────────
    // The editor's `handleKeyDown` fires window events (it can't see React
    // state directly); these listeners apply them against the live matches.
    useEffect(() => {
      function onMove(e: Event) {
        const dir = (e as CustomEvent<number>).detail;
        if (popupCount === 0) return;
        setSel((i) => (i + dir + popupCount) % popupCount);
      }
      function onPick() {
        if (slashOpen) {
          insertSlash(slashMatches[Math.min(stateRef.current.sel, slashMatches.length - 1)]);
        } else if (mentionOpen) {
          insertMention(mentionMatches[Math.min(stateRef.current.sel, mentionMatches.length - 1)]);
        }
      }
      function onClose() {
        setSlashQuery(null);
        setMentionQuery(null);
      }
      window.addEventListener("aura:composer:popup-move", onMove);
      window.addEventListener("aura:composer:popup-pick", onPick);
      window.addEventListener("aura:composer:popup-close", onClose);
      return () => {
        window.removeEventListener("aura:composer:popup-move", onMove);
        window.removeEventListener("aura:composer:popup-pick", onPick);
        window.removeEventListener("aura:composer:popup-close", onClose);
      };
    }, [popupCount, slashOpen, mentionOpen, slashMatches, mentionMatches, insertSlash, insertMention]);

    return (
      <div className="relative">
        {slashOpen && (
          <PopupShell heading="Commands" footer="↑↓ to move · ⏎ to pick · esc to dismiss">
            {slashMatches.map((cmd, i) => (
              <button
                key={`${cmd.source}:${cmd.name}`}
                type="button"
                onMouseDown={(e) => {
                  e.preventDefault();
                  insertSlash(cmd);
                }}
                onMouseEnter={() => setSel(i)}
                className={`w-full flex items-baseline gap-2 px-2.5 py-1.5 text-left transition-colors ${
                  i === sel ? "bg-bg-2" : "hover:bg-bg-2"
                }`}
              >
                <span className="font-mono text-[12px] text-text-1 whitespace-nowrap">
                  /{cmd.name}
                  {cmd.args ? <span className="text-text-4"> {cmd.args}</span> : null}
                </span>
                <span className="flex-1 truncate text-[11px] text-text-3">{cmd.summary}</span>
                {cmd.source === "claude" ? (
                  <span className="shrink-0 rounded px-1 py-px text-[9.5px] uppercase tracking-wide text-text-4 bg-bg-1 border border-line-soft">
                    Claude
                  </span>
                ) : null}
              </button>
            ))}
          </PopupShell>
        )}

        {mentionOpen && (
          <PopupShell heading="Files" footer="↑↓ to move · ⏎ to pick · esc to dismiss">
            {mentionMatches.map((entry, i) => (
              <button
                key={entry.path}
                type="button"
                onMouseDown={(e) => {
                  e.preventDefault();
                  insertMention(entry);
                }}
                onMouseEnter={() => setSel(i)}
                className={`w-full flex items-center gap-2 px-2.5 py-1.5 text-left transition-colors ${
                  i === sel ? "bg-bg-2" : "hover:bg-bg-2"
                }`}
              >
                <svg className="ico-12 shrink-0 text-text-4">
                  <use href={entry.isDir ? "#i-folder" : "#i-file"} />
                </svg>
                <span className="font-mono text-[12px] text-text-1 truncate">
                  {entry.name}
                  {entry.isDir ? "/" : ""}
                </span>
                <span className="flex-1 truncate text-[10.5px] text-text-4 text-right">
                  {entry.path}
                </span>
              </button>
            ))}
          </PopupShell>
        )}

        <EditorContent editor={editor} />
      </div>
    );
  },
);

/** Shared popup chrome for the slash + mention menus — pops above the
 *  composer, token-styled. */
function PopupShell({
  heading,
  footer,
  children,
}: {
  heading: string;
  footer: string;
  children: ReactNode;
}) {
  return (
    <div
      className="absolute left-0 right-0 bottom-full mb-1.5 z-40 max-h-[280px] overflow-auto rounded-lg py-1 shadow-xl"
      style={{
        background: "var(--color-bg-3)",
        border: "1px solid var(--color-line-soft)",
      }}
    >
      <div className="px-2.5 py-1 text-[10px] uppercase tracking-wider text-text-4">{heading}</div>
      {children}
      <div className="px-2.5 pt-1 pb-0.5 text-[10px] text-text-4 border-t border-line-soft mt-1">
        {footer}
      </div>
    </div>
  );
}
