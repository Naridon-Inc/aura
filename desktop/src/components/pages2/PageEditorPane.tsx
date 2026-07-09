import { useEffect, useMemo, useRef, type ReactNode, type RefObject } from "react";
import type { Editor } from "@tiptap/react";
import {
  Archive,
  Blocks,
  Check,
  Code2,
  Eye,
  EyeOff,
  Globe,
  Lock,
  MoreVertical,
  PanelRight,
  Unlock,
  Users,
} from "lucide-react";
import { cn } from "../../lib/utils";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "../ui/dropdown-menu";
import { TiptapEditor } from "../notes/TiptapEditor";
import { MarkdownView } from "../MarkdownView";
import { PageComments } from "./PageComments";
import type { Note } from "./pagesApi";
import type { MentionItem, MentionSources } from "./mentionSources";
import type { PagesProvider } from "../../lib/pages_collab";

export type PageView = "blocks" | "source" | "preview";
export type SaveState = "saved" | "saving" | "dirty";

type Props = {
  note: Note;
  repoRoot: string;
  authorHandle?: string;
  body: string;
  title: string;
  saveState: SaveState;
  view: PageView;
  mentionSources?: MentionSources;
  collab?: PagesProvider | null;
  railOpen: boolean;
  onTitleChange: (title: string) => void;
  onBodyChange: (markdown: string) => void;
  onViewChange: (view: PageView) => void;
  onToggleLock: () => void;
  onSetVisibility: (v: string) => void;
  onArchive: () => void;
  onToggleRail: () => void;
  onOpenByTitle: (title: string) => void;
  onResolveMention?: (item: MentionItem) => void;
  editorRef?: RefObject<Editor | null>;
};

const COLUMN = "mx-auto w-full max-w-[640px] px-5 sm:px-8 py-5";
const COMMENT_COLUMN = "mx-auto w-full max-w-[640px] px-5 sm:px-8 pb-8";

const VIEW_OPTIONS: {
  value: PageView;
  label: string;
  icon: ReactNode;
}[] = [
  { value: "blocks", label: "Blocks", icon: <Blocks className="size-3.5" strokeWidth={1.6} /> },
  { value: "source", label: "Source", icon: <Code2 className="size-3.5" strokeWidth={1.6} /> },
  { value: "preview", label: "Preview", icon: <Eye className="size-3.5" strokeWidth={1.6} /> },
];

const VISIBILITY_OPTIONS: {
  value: string;
  label: string;
  desc: string;
  icon: ReactNode;
}[] = [
  {
    value: "private",
    label: "Private",
    desc: "Only you",
    icon: <EyeOff className="size-3.5" strokeWidth={1.6} />,
  },
  {
    value: "team",
    label: "Team",
    desc: "Repo team",
    icon: <Users className="size-3.5" strokeWidth={1.6} />,
  },
  {
    value: "shared",
    label: "Shared",
    desc: "Live rail sync",
    icon: <Globe className="size-3.5" strokeWidth={1.6} />,
  },
];

function visibilityLabel(v?: string | null): string {
  return VISIBILITY_OPTIONS.find((o) => o.value === v)?.label ?? "Shared";
}

export function PageEditorPane({
  note,
  repoRoot,
  authorHandle,
  body,
  title,
  saveState,
  view,
  mentionSources,
  collab,
  railOpen,
  onTitleChange,
  onBodyChange,
  onViewChange,
  onToggleLock,
  onSetVisibility,
  onArchive,
  onToggleRail,
  onOpenByTitle,
  onResolveMention,
  editorRef,
}: Props) {
  const locked = !!note.frontmatter.locked;
  const visibility = note.frontmatter.visibility ?? "shared";
  const titleRef = useRef<HTMLTextAreaElement | null>(null);

  const collabBinding = useMemo(
    () => (collab ? { provider: collab } : undefined),
    [collab],
  );

  useEffect(() => {
    const el = titleRef.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${el.scrollHeight}px`;
  }, [title]);

  const handleLinkClick = (href: string): boolean => {
    if (href.startsWith("aura-wiki:")) {
      onOpenByTitle(decodeURIComponent(href.slice("aura-wiki:".length)));
      return true;
    }
    if (href.startsWith("aura://task/")) {
      window.dispatchEvent(
        new CustomEvent("aura:open-task", {
          detail: { id: href.slice("aura://task/".length) },
        }),
      );
      return true;
    }
    return false;
  };

  return (
    <div className="pages-doc flex min-w-0 flex-1 flex-col bg-bg-content">
      <div className="flex min-h-10 items-center justify-between gap-3 border-b border-line-soft px-3.5 py-1.5">
        <textarea
          ref={titleRef}
          value={title}
          onChange={(e) => onTitleChange(e.target.value.replace(/\n/g, ""))}
          placeholder="Untitled"
          rows={1}
          readOnly={locked}
          spellCheck={false}
          className={cn(
            "min-w-0 flex-1 resize-none truncate border-0 bg-transparent p-0 outline-none",
            "text-[13px] font-medium leading-[18px] tracking-[-0.005em] text-text-1",
            "placeholder:text-text-5",
          )}
        />
        <div className="flex shrink-0 items-center gap-1">
          <SaveDot state={saveState} />
          <PageKebab
            view={view}
            locked={locked}
            visibility={visibility}
            railOpen={railOpen}
            onViewChange={onViewChange}
            onToggleLock={onToggleLock}
            onSetVisibility={onSetVisibility}
            onArchive={onArchive}
            onToggleRail={onToggleRail}
          />
        </div>
      </div>

      <div className="min-h-0 flex-1 overflow-hidden">
        {view === "blocks" && (
          <div className="h-full overflow-auto">
            <TiptapEditor
              key={note.id}
              value={body}
              onChange={onBodyChange}
              onLinkClick={handleLinkClick}
              editable={!locked}
              documentPadding
              editorRef={editorRef}
              mentionSources={mentionSources}
              onResolveMention={onResolveMention}
              collab={collabBinding}
              className="h-auto"
            />
            <div className={COMMENT_COLUMN}>
              <PageComments
                repoRoot={repoRoot}
                scope={note.scope}
                bucket={note.bucket}
                id={note.id}
                authorHandle={authorHandle}
              />
            </div>
          </div>
        )}
        {view === "source" && (
          <div className="h-full overflow-auto">
            <textarea
              value={body}
              onChange={(e) => onBodyChange(e.target.value)}
              readOnly={locked}
              spellCheck={false}
              className={cn(
                COLUMN,
                "block min-h-full resize-none border-0 bg-bg-content font-mono text-[12px] leading-[1.65] text-text-1 outline-none",
              )}
            />
          </div>
        )}
        {view === "preview" && (
          <div className="h-full overflow-auto">
            <div className={COLUMN}>
              <MarkdownView source={body} />
            </div>
            <div className={COMMENT_COLUMN}>
              <PageComments
                repoRoot={repoRoot}
                scope={note.scope}
                bucket={note.bucket}
                id={note.id}
                authorHandle={authorHandle}
              />
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

function PageKebab({
  view,
  locked,
  visibility,
  railOpen,
  onViewChange,
  onToggleLock,
  onSetVisibility,
  onArchive,
  onToggleRail,
}: {
  view: PageView;
  locked: boolean;
  visibility: string;
  railOpen: boolean;
  onViewChange: (view: PageView) => void;
  onToggleLock: () => void;
  onSetVisibility: (v: string) => void;
  onArchive: () => void;
  onToggleRail: () => void;
}) {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button
          type="button"
          aria-label="Page menu"
          title="Page menu"
          className={cn(
            "grid size-7 place-items-center rounded-md outline-none transition-colors",
            "text-text-3 hover:bg-bg-2 hover:text-text-1",
            "data-[state=open]:bg-bg-2 data-[state=open]:text-text-1",
          )}
        >
          <MoreVertical className="size-4" strokeWidth={1.6} />
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-[238px] p-1.5">
        <DropdownMenuLabel className="px-2 py-1 text-[10px] uppercase tracking-[0.12em] text-text-5">
          View
        </DropdownMenuLabel>
        {VIEW_OPTIONS.map((opt) => (
          <CompactMenuItem
            key={opt.value}
            active={view === opt.value}
            icon={opt.icon}
            label={opt.label}
            onSelect={() => onViewChange(opt.value)}
          />
        ))}

        <DropdownMenuSeparator className="my-1" />
        <DropdownMenuLabel className="px-2 py-1 text-[10px] uppercase tracking-[0.12em] text-text-5">
          Sharing · {visibilityLabel(visibility)}
        </DropdownMenuLabel>
        {VISIBILITY_OPTIONS.map((opt) => (
          <CompactMenuItem
            key={opt.value}
            active={visibility === opt.value}
            icon={opt.icon}
            label={opt.label}
            detail={opt.desc}
            onSelect={() => onSetVisibility(opt.value)}
          />
        ))}

        <DropdownMenuSeparator className="my-1" />
        <CompactMenuItem
          icon={locked ? <Unlock className="size-3.5" strokeWidth={1.6} /> : <Lock className="size-3.5" strokeWidth={1.6} />}
          label={locked ? "Unlock page" : "Lock page"}
          onSelect={onToggleLock}
        />
        <CompactMenuItem
          icon={<PanelRight className="size-3.5" strokeWidth={1.6} />}
          label={railOpen ? "Hide outline" : "Show outline"}
          onSelect={onToggleRail}
        />
        <CompactMenuItem
          icon={<Archive className="size-3.5" strokeWidth={1.6} />}
          label="Archive page"
          onSelect={onArchive}
        />
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

function CompactMenuItem({
  icon,
  label,
  detail,
  active,
  onSelect,
}: {
  icon: ReactNode;
  label: string;
  detail?: string;
  active?: boolean;
  onSelect: () => void;
}) {
  return (
    <DropdownMenuItem
      onSelect={onSelect}
      className={cn(
        "gap-2 rounded-md px-2 py-1.5 text-[12px]",
        active && "bg-bg-2 text-text-1",
      )}
    >
      <span className="grid size-4 place-items-center text-text-4">{icon}</span>
      <span className="min-w-0 flex-1">
        <span className="block truncate font-medium">{label}</span>
        {detail && <span className="block truncate text-[10.5px] leading-4 text-text-4">{detail}</span>}
      </span>
      {active && <Check className="size-3.5 shrink-0 text-accent" strokeWidth={2} />}
    </DropdownMenuItem>
  );
}

function SaveDot({ state }: { state: SaveState }) {
  const text = state === "saving" ? "Saving" : state === "dirty" ? "Unsaved" : "Saved";
  const color = state === "saving" ? "text-text-4" : state === "dirty" ? "text-amber" : "text-accent-green";
  return (
    <span className={cn("flex items-center gap-1 text-[11px]", color)} aria-live="polite">
      <span
        className={cn(
          "size-1.5 rounded-full",
          state === "saving" ? "bg-text-4" : state === "dirty" ? "bg-amber" : "bg-accent-green",
        )}
        aria-hidden
      />
      {text}
    </span>
  );
}
