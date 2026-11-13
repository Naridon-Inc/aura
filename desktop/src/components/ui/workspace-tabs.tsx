import { useEffect, useId, useRef, useState, type PointerEvent, type ReactNode } from "react";
import { Plus, X, ChevronLeft, ChevronRight } from "lucide-react";
import { Button } from "./button";
import {
  ContextMenu,
  ContextMenuTrigger,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
} from "./context-menu";
import { FileMenuItems, type FileActions } from "./file-actions-menu";
import { AsciiSpinner } from "./ascii-spinner";
import { RevealMark, TitleReveal } from "./title-reveal";
import { usePointerDrag } from "./use-pointer-drag";
import "./new-tab.css";
export interface WorkspaceTab {
  id: string;
  label: string;
  icon?: ReactNode;
  dirty?: boolean;
  running?: boolean;
  closeable?: boolean;
  kind?: "chat" | "file" | "view";
  unread?: boolean;
  /** What this tab IS, across renders. Given one, a new `label` arrives
   *  through the pixel reveal; without one it just changes. */
  revealKey?: string;
  /** A word for which `icon` this is. Given with `revealKey`, a new one builds
   *  in on the same beat as the name. */
  markKey?: string;
}
/** A press on a tab's label is passed on as a press on the whole tab, so the
 *  tab, close button and all, is what lifts and follows the pointer. */
function asTabPress(event: PointerEvent<HTMLElement>): PointerEvent<HTMLElement> | undefined {
  const tab = event.currentTarget.closest<HTMLElement>(".ui-workspace-tab");
  return tab ? { ...event, currentTarget: tab, target: tab } : undefined;
}
export function WorkspaceTabs({
  tabs,
  value,
  onChange,
  onClose,
  onNew,
  onRename,
  onReorder,
  onMarkUnread,
  onFork,
  onCopyTranscript,
  onCopyLink,
  fileActions,
}: {
  tabs: WorkspaceTab[];
  value: string;
  onChange: (id: string) => void;
  onClose: (id: string) => void;
  onNew?: () => void;
  onRename?: (id: string) => void;
  onReorder?: (ids: string[]) => void;
  onMarkUnread?: (id: string, unread: boolean) => void;
  onFork?: (id: string) => void;
  onCopyTranscript?: (id: string, full: boolean) => void;
  onCopyLink?: (id: string) => void;
  fileActions?: (tab: WorkspaceTab) => FileActions;
}) {
  const strip = useRef<HTMLDivElement>(null);
  // Pointer-driven: the desktop app's web view never delivers an HTML5 drop.
  // A press that does not travel is still a click, so it opens the tab.
  const drag = usePointerDrag<string>((dragged, onto) => {
    const ids = tabs.map((item) => item.id);
    const origin = ids.indexOf(dragged);
    const index = ids.indexOf(onto);
    if (dragged === onto || origin < 0 || index < 0) return;
    ids.splice(origin, 1);
    ids.splice(index, 0, dragged);
    onReorder?.(ids);
  });
  const id = useId();
  const pendingDialog = useRef<(() => void) | undefined>(undefined);
  const [overflow, setOverflow] = useState({ left: false, right: false });
  useEffect(() => {
    const element = strip.current;
    if (!element) return;
    const update = () =>
      setOverflow({
        left: element.scrollLeft > 1,
        right: element.scrollLeft + element.clientWidth < element.scrollWidth - 1,
      });
    const observer = new ResizeObserver(update);
    observer.observe(element);
    element.addEventListener("scroll", update);
    update();
    return () => {
      observer.disconnect();
      element.removeEventListener("scroll", update);
    };
  }, [tabs]);
  const focusTab = (index: number) => {
    const next = tabs[(index + tabs.length) % tabs.length];
    if (next) {
      onChange(next.id);
      strip.current
        ?.querySelector<HTMLButtonElement>(`[data-tab-index="${tabs.indexOf(next)}"]`)
        ?.focus();
    }
  };
  return (
    <div className="ui-workspace-tabs">
      {overflow.left && (
        <Button
          size="iconXs"
          variant="ghost"
          aria-label="Scroll tabs left"
          onClick={() => strip.current?.scrollBy({ left: -240, behavior: "smooth" })}
        >
          <ChevronLeft />
        </Button>
      )}
      <div
        className="ui-workspace-tab-scroll"
        ref={strip}
        role="tablist"
        aria-label="Open workspace views"
      >
        {tabs.map((tab, index) => (
          <ContextMenu key={tab.id}>
            <ContextMenuTrigger asChild>
              <div
                className="ui-workspace-tab"
                data-selected={value === tab.id}
                {...(onReorder ? drag.target(tab.id) : {})}
              >
                <button
                  role="tab"
                  id={`${id}-${tab.id}`}
                  data-tab-index={index}
                  aria-selected={tab.id === value}
                  tabIndex={tab.id === value ? 0 : -1}
                  onPointerDown={(event) => {
                    const press = onReorder && asTabPress(event);
                    if (press) drag.source(tab.id).onPointerDown(press);
                  }}
                  onClick={() => onChange(tab.id)}
                  onKeyDown={(event) => {
                    if (["ArrowRight", "ArrowLeft", "Home", "End"].includes(event.key)) {
                      event.preventDefault();
                      focusTab(
                        event.key === "Home"
                          ? 0
                          : event.key === "End"
                            ? tabs.length - 1
                            : index + (event.key === "ArrowRight" ? 1 : -1),
                      );
                    }
                    if (event.key === "Delete" && tab.closeable !== false) {
                      event.preventDefault();
                      onClose(tab.id);
                      focusTab(Math.max(0, index - 1));
                    }
                  }}
                >
                  {tab.running ? (
                    <AsciiSpinner />
                  ) : tab.markKey !== undefined ? (
                    <RevealMark revealKey={tab.revealKey} markKey={tab.markKey}>
                      {tab.icon}
                    </RevealMark>
                  ) : (
                    tab.icon
                  )}
                  <span>
                    <TitleReveal revealKey={tab.revealKey} text={tab.label} />
                  </span>
                  {tab.unread && <span className="ui-tab-unread" aria-label="Unread" />}
                  {tab.dirty && <span className="ui-tab-dirty" aria-label="Unsaved changes" />}
                </button>
                {tab.closeable !== false && (
                  <button
                    className="ui-tab-close"
                    aria-label={`Close ${tab.label}`}
                    onClick={() => onClose(tab.id)}
                  >
                    <X size={12} />
                  </button>
                )}
              </div>
            </ContextMenuTrigger>
            <ContextMenuContent
              className="ui-tab-menu"
              onCloseAutoFocus={(event) => {
                if (pendingDialog.current) {
                  event.preventDefault();
                  const action = pendingDialog.current;
                  pendingDialog.current = undefined;
                  requestAnimationFrame(action);
                }
              }}
            >
              {(tab.kind ?? "chat") === "chat" && (
                <>
                  {onMarkUnread && (
                    <ContextMenuItem onSelect={() => onMarkUnread(tab.id, !tab.unread)}>
                      Mark as {tab.unread ? "read" : "unread"}
                    </ContextMenuItem>
                  )}
                  {onRename && (
                    <ContextMenuItem
                      onSelect={() => {
                        pendingDialog.current = () => onRename(tab.id);
                      }}
                    >
                      Rename chat
                    </ContextMenuItem>
                  )}
                  {onFork && (
                    <ContextMenuItem onSelect={() => onFork(tab.id)}>
                      Fork to new tab <span className="ui-menu-shortcut">⌘⌥↵</span>
                    </ContextMenuItem>
                  )}
                  {(onCopyTranscript || onCopyLink) && <ContextMenuSeparator />}
                  {onCopyTranscript && (
                    <>
                      <ContextMenuItem onSelect={() => onCopyTranscript(tab.id, false)}>
                        Copy concise transcript <span className="ui-menu-shortcut">⌘⌥C</span>
                      </ContextMenuItem>
                      <ContextMenuItem onSelect={() => onCopyTranscript(tab.id, true)}>
                        Copy full transcript
                      </ContextMenuItem>
                    </>
                  )}
                  {onCopyLink && (
                    <ContextMenuItem onSelect={() => onCopyLink(tab.id)}>Copy link</ContextMenuItem>
                  )}
                </>
              )}
              {tab.kind === "file" && fileActions && <FileMenuItems {...fileActions(tab)} />}
              <ContextMenuSeparator />
              <ContextMenuItem disabled={tab.closeable === false} onSelect={() => onClose(tab.id)}>
                Close tab <span className="ui-menu-shortcut">⌘W</span>
              </ContextMenuItem>
              <ContextMenuItem
                disabled={tabs.length < 2}
                onSelect={() =>
                  tabs
                    .filter((item) => item.id !== tab.id && item.closeable !== false)
                    .forEach((item) => onClose(item.id))
                }
              >
                Close others
              </ContextMenuItem>
            </ContextMenuContent>
          </ContextMenu>
        ))}
      </div>
      {overflow.right && (
        <Button
          size="iconXs"
          variant="ghost"
          aria-label="Scroll tabs right"
          onClick={() => strip.current?.scrollBy({ left: 240, behavior: "smooth" })}
        >
          <ChevronRight />
        </Button>
      )}
      {onNew && (
        <Button size="iconXs" variant="ghost" aria-label="New chat" onClick={onNew}>
          <Plus />
        </Button>
      )}
    </div>
  );
}
