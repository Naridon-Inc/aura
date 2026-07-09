// TiptapToolbarPill — Plane's `.page-doc-toolbar` (lines ~1765–1798).
//
// 36px pill, 6px radius, 28×28 buttons inside, 16px lucide icons.
// Left edge: "Text" turn-into dropdown. Then B / I / U / S /
// inline-code. Then alignment + lists. Then link / image / table.
// Right edge stays empty — the parent overlays a PageActionBar
// cluster via `position: absolute` (see Plane mockup §5).
//
// This is purely visual scaffold + Tiptap command pass-through; the
// editor instance is passed in from NotesWorkpane via prop. We keep
// the API tight so other surfaces (task description editor) can
// reuse the pill if they want.

import { useState } from "react";
import type { Editor } from "@tiptap/react";
import {
  Type,
  Bold,
  Italic,
  Underline,
  Strikethrough,
  Code,
  List,
  ListOrdered,
  ListChecks,
  Link as LinkIcon,
  Image as ImageIcon,
  ChevronDown,
} from "lucide-react";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "../ui/dropdown-menu";
import { cn } from "../../lib/utils";

type Props = {
  editor: Editor | null;
  className?: string;
};

export function TiptapToolbarPill({ editor, className }: Props) {
  if (!editor) {
    return (
      <div
        className={cn(
          "h-9 px-1 inline-flex items-center rounded-md bg-bg-chrome border border-line-soft shadow-[0_4px_12px_rgba(0,0,0,0.18)]",
          className,
        )}
        aria-hidden
      />
    );
  }
  return (
    <div
      className={cn(
        "h-9 px-1 inline-flex items-center gap-[2px] rounded-md bg-bg-chrome border border-line-soft shadow-[0_4px_12px_rgba(0,0,0,0.18)]",
        className,
      )}
    >
      <TextTypeDropdown editor={editor} />
      <Sep />
      <ToolbarBtn
        active={editor.isActive("bold")}
        onClick={() => editor.chain().focus().toggleBold().run()}
        title="Bold (⌘B)"
      >
        <Bold className="w-4 h-4" strokeWidth={1.75} aria-hidden />
      </ToolbarBtn>
      <ToolbarBtn
        active={editor.isActive("italic")}
        onClick={() => editor.chain().focus().toggleItalic().run()}
        title="Italic (⌘I)"
      >
        <Italic className="w-4 h-4" strokeWidth={1.75} aria-hidden />
      </ToolbarBtn>
      <ToolbarBtn
        active={editor.isActive("underline")}
        onClick={() => editor.chain().focus().toggleUnderline?.().run()}
        title="Underline (⌘U)"
      >
        <Underline className="w-4 h-4" strokeWidth={1.75} aria-hidden />
      </ToolbarBtn>
      <ToolbarBtn
        active={editor.isActive("strike")}
        onClick={() => editor.chain().focus().toggleStrike().run()}
        title="Strikethrough"
      >
        <Strikethrough className="w-4 h-4" strokeWidth={1.75} aria-hidden />
      </ToolbarBtn>
      <ToolbarBtn
        active={editor.isActive("code")}
        onClick={() => editor.chain().focus().toggleCode().run()}
        title="Inline code"
      >
        <Code className="w-4 h-4" strokeWidth={1.75} aria-hidden />
      </ToolbarBtn>
      <Sep />
      <ToolbarBtn
        active={editor.isActive("bulletList")}
        onClick={() => editor.chain().focus().toggleBulletList().run()}
        title="Bullet list"
      >
        <List className="w-4 h-4" strokeWidth={1.75} aria-hidden />
      </ToolbarBtn>
      <ToolbarBtn
        active={editor.isActive("orderedList")}
        onClick={() => editor.chain().focus().toggleOrderedList().run()}
        title="Ordered list"
      >
        <ListOrdered className="w-4 h-4" strokeWidth={1.75} aria-hidden />
      </ToolbarBtn>
      <ToolbarBtn
        active={editor.isActive("taskList")}
        onClick={() => editor.chain().focus().toggleTaskList().run()}
        title="Todo list"
      >
        <ListChecks className="w-4 h-4" strokeWidth={1.75} aria-hidden />
      </ToolbarBtn>
      <Sep />
      <ToolbarBtn
        active={editor.isActive("link")}
        onClick={() => {
          const prev = editor.getAttributes("link").href as string | undefined;
          const url = window.prompt("Link URL", prev ?? "https://");
          if (url === null) return;
          if (url === "") {
            editor.chain().focus().unsetLink().run();
            return;
          }
          editor
            .chain()
            .focus()
            .extendMarkRange("link")
            .setLink({ href: url })
            .run();
        }}
        title="Link (⌘K)"
      >
        <LinkIcon className="w-4 h-4" strokeWidth={1.75} aria-hidden />
      </ToolbarBtn>
      <ToolbarBtn
        onClick={() => {
          const url = window.prompt("Image URL");
          if (!url) return;
          editor.chain().focus().insertContent({
            type: "image",
            attrs: { src: url, alt: "" },
          }).run();
        }}
        title="Image"
      >
        <ImageIcon className="w-4 h-4" strokeWidth={1.75} aria-hidden />
      </ToolbarBtn>
    </div>
  );
}

function TextTypeDropdown({ editor }: { editor: Editor }) {
  const [open, setOpen] = useState(false);
  const current = currentBlockLabel(editor);
  return (
    <DropdownMenu open={open} onOpenChange={setOpen}>
      <DropdownMenuTrigger asChild>
        <button
          type="button"
          title="Turn into"
          className="h-7 px-2 inline-flex items-center gap-1 text-[12px] text-text-3 hover:text-text-1 hover:bg-bg-2 rounded transition-colors min-w-[88px]"
        >
          <Type className="w-3.5 h-3.5" strokeWidth={1.75} aria-hidden />
          <span className="flex-1 text-left">{current}</span>
          <ChevronDown className="w-3 h-3" strokeWidth={1.75} aria-hidden />
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="min-w-[160px] text-[12px]">
        <DropdownMenuItem
          onSelect={() => editor.chain().focus().setParagraph().run()}
        >
          Text
        </DropdownMenuItem>
        <DropdownMenuItem
          onSelect={() =>
            editor.chain().focus().toggleHeading({ level: 1 }).run()
          }
        >
          Heading 1
        </DropdownMenuItem>
        <DropdownMenuItem
          onSelect={() =>
            editor.chain().focus().toggleHeading({ level: 2 }).run()
          }
        >
          Heading 2
        </DropdownMenuItem>
        <DropdownMenuItem
          onSelect={() =>
            editor.chain().focus().toggleHeading({ level: 3 }).run()
          }
        >
          Heading 3
        </DropdownMenuItem>
        <DropdownMenuItem
          onSelect={() => editor.chain().focus().toggleBlockquote().run()}
        >
          Quote
        </DropdownMenuItem>
        <DropdownMenuItem
          onSelect={() => editor.chain().focus().toggleCodeBlock().run()}
        >
          Code block
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

function currentBlockLabel(editor: Editor): string {
  if (editor.isActive("heading", { level: 1 })) return "Heading 1";
  if (editor.isActive("heading", { level: 2 })) return "Heading 2";
  if (editor.isActive("heading", { level: 3 })) return "Heading 3";
  if (editor.isActive("blockquote")) return "Quote";
  if (editor.isActive("codeBlock")) return "Code";
  if (editor.isActive("bulletList")) return "Bullet list";
  if (editor.isActive("orderedList")) return "Ordered list";
  return "Text";
}

function ToolbarBtn({
  active = false,
  onClick,
  title,
  children,
}: {
  active?: boolean;
  onClick?: () => void;
  title: string;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      title={title}
      aria-label={title}
      aria-pressed={active || undefined}
      className={cn(
        "inline-flex items-center justify-center w-7 h-7 rounded-sm transition-colors",
        active
          ? "bg-bg-2 text-text-1"
          : "bg-transparent text-text-4 hover:bg-bg-2 hover:text-text-1",
      )}
    >
      {children}
    </button>
  );
}

function Sep() {
  return (
    <span
      aria-hidden
      className="inline-block w-px h-5 bg-line-soft mx-[3px]"
    />
  );
}
