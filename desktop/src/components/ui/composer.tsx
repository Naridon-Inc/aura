import {
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
  type ReactNode,
  type KeyboardEvent,
  type ChangeEvent,
  type Ref,
} from "react";
import {
  ArrowUp,
  Square,
  Plus,
  Paperclip,
  X,
  Check,
  CornerDownLeft,
  Mic,
  Maximize2,
  Minimize2,
  Upload,
} from "lucide-react";
import { Button } from "./button";
import { isLongPaste, longPasteFile } from "./composerPaste";
import {
  matchSuggestions,
  snippetForKeyword,
  SuggestionRow,
  type ComposerSuggestion,
  type SuggestionSigil,
} from "./composerSuggestions";
import { Kbd } from "./kbd";
import { Tooltip } from "./tooltip";
export interface ComposerAttachment {
  id: string;
  name: string;
  kind?: "file" | "image" | "issue" | "workspace" | "snippet";
  previewUrl?: string;
}
export type { ComposerSuggestion } from "./composerSuggestions";
export interface ComposerProps {
  value: string;
  onChange: (value: string) => void;
  onSend: () => void;
  onStop?: () => void;
  onAttach?: (files: File[]) => void;
  attachments?: ComposerAttachment[];
  onRemoveAttachment?: (id: string) => void;
  running?: boolean;
  disabled?: boolean;
  /** The field stays writable but nothing sends yet — a draft for later. */
  sendDisabled?: boolean;
  placeholder?: string;
  sendKey?: "enter" | "mod-enter";
  footer?: ReactNode;
  context?: ReactNode;
  queue?: ReactNode;
  className?: string;
  mode?: "send" | "queue" | "edit";
  onCancelEdit?: () => void;
  suggestions?: ComposerSuggestion[];
  onSuggestionSelect?: (suggestion: ComposerSuggestion) => void;
  minimized?: boolean;
  /** Whether a fold or unfold eases into place (200ms) or lands at once.
   *  Off by default; a host turns it on when the user's own gesture folded
   *  or opened the box, and leaves it off when the view under it changed. */
  animateResize?: boolean;
  /** A file is being dragged over the area that drops into this box (the
   *  host's own drop zone, which can be wider than the box); the box shows
   *  where it will land. Drags that reach the box itself show it anyway. */
  dragOver?: boolean;
  /** A paste past 90 lines or 5,000 characters is attached as a text file
   *  through `onAttach` instead of landing in the field. For hosts whose
   *  attachments reach the agent. */
  attachLongPaste?: boolean;
  onMinimizedChange?: (minimized: boolean) => void;
  recording?: boolean;
  onVoiceToggle?: () => void;
  actions?: ReactNode;
  renderAddMenu?: (openFileDialog: () => void) => ReactNode;
  planMode?: boolean;
  onPlanModeChange?: (value: boolean) => void;
  /** The message field itself, for a host that moves the caret or focus. */
  textareaRef?: Ref<HTMLTextAreaElement>;
  /** Runs after the suggestion list has had its keys and before Enter sends;
   *  calling `preventDefault` keeps the key from the composer. */
  onKeyDown?: (event: KeyboardEvent<HTMLTextAreaElement>) => void;
  /** The message field's accessible name. */
  ariaLabel?: string;
  /** The key that focuses this composer from anywhere ("⌘L"). Given, an
   *  empty composer that does not have focus says so in a small pill. */
  focusShortcut?: string;
}
function assignRef<T>(ref: Ref<T> | undefined, node: T | null) {
  if (typeof ref === "function") ref(node);
  else if (ref) (ref as { current: T | null }).current = node;
}
export function Composer({
  value,
  onChange,
  onSend,
  onStop,
  onAttach,
  attachments = [],
  onRemoveAttachment,
  running,
  disabled,
  sendDisabled,
  placeholder = "Ask to make changes, @mention files, run /commands",
  sendKey = "enter",
  footer,
  context,
  queue,
  className = "",
  mode = "send",
  onCancelEdit,
  suggestions = [],
  onSuggestionSelect,
  minimized = false,
  animateResize = false,
  dragOver = false,
  attachLongPaste = false,
  onMinimizedChange,
  recording,
  onVoiceToggle,
  actions,
  renderAddMenu,
  planMode,
  onPlanModeChange,
  textareaRef,
  onKeyDown,
  ariaLabel = "Message",
  focusShortcut,
}: ComposerProps) {
  const file = useRef<HTMLInputElement>(null);
  const editor = useRef<HTMLTextAreaElement>(null);
  const [cursor, setCursor] = useState(value.length);
  const [activeSuggestion, setActiveSuggestion] = useState(0);
  const [dismissed, setDismissed] = useState(false);
  const [focused, setFocused] = useState(false);
  const [dragging, setDragging] = useState(false);
  // The text this box last wrote itself; any other change (a host putting
  // ";" in, a draft coming back) reads the caret from the field.
  const ownValue = useRef(value);
  useLayoutEffect(() => {
    if (value === ownValue.current) return;
    ownValue.current = value;
    setCursor(editor.current?.selectionStart ?? value.length);
    setDismissed(false);
    setActiveSuggestion(0);
  }, [value]);
  const listId = useId();
  const before = value.slice(0, cursor);
  // "@" and "/" end at a space; ";" (snippets) runs to the line's end, or to
  // the next " ;", so a snippet's name can be typed with its spaces.
  const token =
    before.match(/(?:^|\s)([@/])([^\s]*)$/) ?? before.match(/(?:^|\s)(;)((?:(?!\s;)[^\n])*)$/);
  const matching =
    !dismissed && token ? matchSuggestions(suggestions, token[1] as SuggestionSigil, token[2]) : [];
  const activeIndex = Math.min(activeSuggestion, Math.max(0, matching.length - 1));
  // The row the keys move to stays in view as the list scrolls.
  const suggestionList = useRef<HTMLDivElement>(null);
  useEffect(() => {
    suggestionList.current
      ?.querySelector(`[data-list-index="${activeIndex}"]`)
      ?.scrollIntoView({ block: "nearest" });
  }, [activeIndex, matching.length]);
  const focusHint =
    !!focusShortcut && !focused && !disabled && !value && attachments.length === 0 ? (
      <span className="ui-composer-focus-hint">{focusShortcut} to focus</span>
    ) : null;
  const canSend = !disabled && !sendDisabled && (!!value.trim() || attachments.length > 0);
  const sendLabel =
    mode === "edit" ? "Save edit" : mode === "queue" ? "Queue message" : "Send message";
  const sendKeys = sendKey === "enter" ? "↵" : "⌘↵";
  const wasMinimized = useRef(minimized);
  useLayoutEffect(() => {
    const textarea = editor.current;
    if (!textarea) return;
    const floor = minimized ? 28 : 88;
    const folding = wasMinimized.current !== minimized;
    wasMinimized.current = minimized;
    // Folding or opening an empty box moves straight to the new floor, so the
    // stylesheet's transition (when there is one) eases between the two.
    if (folding && !value) {
      textarea.style.height = `${floor}px`;
      return;
    }
    // Typing measures the text, and the field follows it at once.
    const transition = textarea.style.transition;
    textarea.style.transition = "none";
    textarea.style.height = "0px";
    textarea.style.height = `${Math.max(floor, Math.min(188, textarea.scrollHeight))}px`;
    void textarea.offsetHeight;
    textarea.style.transition = transition;
  }, [value, minimized]);
  /** Puts `text` where `start`..`end` was and leaves the caret after it. */
  const replaceRange = (source: string, start: number, end: number, text: string) => {
    const next = source.slice(0, start) + text + source.slice(end);
    ownValue.current = next;
    onChange(next);
    setCursor(start + text.length);
    setDismissed(true);
    requestAnimationFrame(() => {
      editor.current?.focus();
      editor.current?.setSelectionRange(start + text.length, start + text.length);
    });
  };
  const pickSuggestion = (suggestion: ComposerSuggestion) => {
    if (!token) return;
    const start = cursor - token[2].length - 1;
    // A snippet's text goes in as written; a mention or command gets a space.
    const inserted =
      suggestion.kind === "snippet" ? suggestion.insertText : `${suggestion.insertText} `;
    replaceRange(value, start, cursor, inserted);
    onSuggestionSelect?.(suggestion);
  };
  const onKey = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.nativeEvent.isComposing) return;
    if (matching.length) {
      if (event.key === "ArrowDown" || event.key === "ArrowUp") {
        event.preventDefault();
        setActiveSuggestion(
          (activeIndex + (event.key === "ArrowDown" ? 1 : -1) + matching.length) % matching.length,
        );
        return;
      }
      if (event.key === "Escape") {
        event.preventDefault();
        event.stopPropagation();
        setDismissed(true);
        return;
      }
      if (event.key === "Enter" || event.key === "Tab") {
        event.preventDefault();
        pickSuggestion(matching[activeIndex]);
        return;
      }
    }
    onKeyDown?.(event);
    if (event.defaultPrevented) return;
    if (event.nativeEvent.isComposing || event.key !== "Enter" || event.shiftKey) return;
    const send =
      sendKey === "enter" ? !event.metaKey && !event.ctrlKey : event.metaKey || event.ctrlKey;
    if (send && canSend) {
      event.preventDefault();
      onSend();
    }
  };
  return (
    <div className={`ui-composer-wrap ${className}`} data-plan-mode={planMode || undefined}>
      {queue}
      <div
        className="ui-composer"
        data-disabled={disabled || undefined}
        data-plan-mode={planMode || undefined}
        data-composer-minimized={minimized}
        data-composer-resize-instant={animateResize ? undefined : true}
        data-focus-hint={focusHint ? true : undefined}
        onKeyDown={(event) => {
          // ⌘⇧⌫ stops the running turn from anywhere in the box.
          if (
            running &&
            onStop &&
            event.key === "Backspace" &&
            event.shiftKey &&
            (event.metaKey || event.ctrlKey)
          ) {
            event.preventDefault();
            onStop();
          }
        }}
        onDragOver={(event) => {
          if (onAttach && !disabled && event.dataTransfer.types.includes("Files")) {
            event.preventDefault();
            setDragging(true);
          }
        }}
        onDragLeave={(event) => {
          if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setDragging(false);
        }}
        onDrop={(event) => {
          setDragging(false);
          if (onAttach && !disabled && event.dataTransfer.files.length) {
            event.preventDefault();
            onAttach(Array.from(event.dataTransfer.files));
          }
        }}
      >
        {(dragOver || dragging) && !disabled && (
          <div className="ui-composer-drop" aria-hidden="true">
            <Upload />
          </div>
        )}
        {context && <div className="ui-composer-context">{context}</div>}
        {attachments.length > 0 && (
          <div className="ui-attachments">
            {attachments.map((a) => (
              <span key={a.id} className="ui-attachment">
                {a.previewUrl && a.kind === "image" ? (
                  <img src={a.previewUrl} alt="" />
                ) : (
                  <Paperclip size={12} />
                )}
                {a.name}
                {onRemoveAttachment && (
                  <button
                    type="button"
                    aria-label={`Remove ${a.name}`}
                    onClick={() => onRemoveAttachment(a.id)}
                  >
                    <X size={12} />
                  </button>
                )}
              </span>
            ))}
          </div>
        )}
        {matching.length > 0 && (
          <div
            ref={suggestionList}
            className="ui-composer-suggestions"
            role="listbox"
            id={listId}
            aria-label={
              token?.[1] === "@"
                ? "Mention suggestions"
                : token?.[1] === ";"
                  ? "Snippet suggestions"
                  : "Command suggestions"
            }
          >
            {matching.map((item, index) => (
              <button
                key={item.id}
                id={`${listId}-${index}`}
                type="button"
                role="option"
                data-kind={item.kind}
                data-list-index={index}
                aria-selected={index === activeIndex}
                onMouseDown={(event) => event.preventDefault()}
                // Moving the pointer picks the row it is on; a pointer that
                // happens to rest where the list opens doesn't.
                onMouseMove={() => index !== activeIndex && setActiveSuggestion(index)}
                onClick={() => pickSuggestion(item)}
              >
                <SuggestionRow item={item} query={token?.[2] ?? ""} />
              </button>
            ))}
          </div>
        )}
        <textarea
          ref={(node) => {
            editor.current = node;
            assignRef(textareaRef, node);
          }}
          aria-label={ariaLabel}
          onFocus={() => setFocused(true)}
          onBlur={() => setFocused(false)}
          aria-controls={matching.length ? listId : undefined}
          aria-activedescendant={matching.length ? `${listId}-${activeIndex}` : undefined}
          rows={3}
          value={value}
          disabled={disabled}
          placeholder={placeholder}
          onChange={(event: ChangeEvent<HTMLTextAreaElement>) => {
            // Typing the last letter of a snippet's keyword (";review") puts
            // the snippet in straight away, once no longer keyword starts
            // with what was typed.
            const typedAt = event.target.selectionStart;
            const typed = event.target.value;
            if ((event.nativeEvent as InputEvent).inputType === "insertText") {
              const keyword = typed.slice(0, typedAt).match(/(^|\s);(\S+)$/);
              const snippet = keyword ? snippetForKeyword(suggestions, keyword[2]) : undefined;
              if (keyword && snippet) {
                replaceRange(typed, typedAt - keyword[2].length - 1, typedAt, snippet.insertText);
                onSuggestionSelect?.(snippet);
                return;
              }
            }
            ownValue.current = event.target.value;
            onChange(event.target.value);
            setCursor(event.target.selectionStart);
            setDismissed(false);
            setActiveSuggestion(0);
          }}
          onSelect={(event) => setCursor(event.currentTarget.selectionStart)}
          onPaste={(event) => {
            const files = Array.from(event.clipboardData.files);
            if (files.length && onAttach) {
              event.preventDefault();
              onAttach(files);
              return;
            }
            const text = event.clipboardData.getData("text/plain");
            if (attachLongPaste && onAttach && isLongPaste(text)) {
              event.preventDefault();
              onAttach([longPasteFile(text)]);
            }
          }}
          onKeyDown={(event) => {
            if (event.key === "Tab" && event.shiftKey && onPlanModeChange) {
              event.preventDefault();
              onPlanModeChange(!planMode);
              return;
            }
            if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "u" && onAttach) {
              event.preventDefault();
              file.current?.click();
              return;
            }
            onKey(event);
          }}
        />
        {!minimized && focusHint}
        <div className="ui-composer-footer">
          <div className="ui-composer-options">{footer}</div>
          <div className="ui-composer-actions">
            {/* The host's tools and ＋ fade out of a folded box; the
                microphone, the stop and send buttons stay. */}
            <div className="ui-composer-tools">
              {actions}
              {mode === "edit" && onCancelEdit && (
                <Button size="xs" variant="ghost" onClick={onCancelEdit}>
                  Cancel
                </Button>
              )}
              {onAttach && (
                <input
                  type="file"
                  multiple
                  hidden
                  ref={file}
                  onChange={(event) => {
                    onAttach(Array.from(event.target.files || []));
                    event.target.value = "";
                  }}
                />
              )}
              {/* A host that takes no files can still hand over a menu of its
                  own turn options; the menu stands without the file picker. */}
              {renderAddMenu
                ? renderAddMenu(() => file.current?.click())
                : onAttach && (
                    <Button
                      variant="ghost"
                      size="icon-sm"
                      className="ui-composer-add"
                      aria-label="Attach files"
                      disabled={disabled}
                      onClick={() => file.current?.click()}
                    >
                      <Plus />
                    </Button>
                  )}
            </div>
            {minimized && focusHint}
            {/* ＋, then the microphone, then send. */}
            {onVoiceToggle && (
              <Button
                variant="ghost"
                size="iconXs"
                aria-label={recording ? "Stop voice input" : "Start voice input"}
                aria-pressed={!!recording}
                onClick={onVoiceToggle}
                disabled={disabled}
              >
                <Mic />
              </Button>
            )}
            {onMinimizedChange && (
              <Button
                variant="ghost"
                size="iconXs"
                aria-label={minimized ? "Expand composer" : "Minimize composer"}
                onClick={() => onMinimizedChange(!minimized)}
              >
                {minimized ? <Maximize2 /> : <Minimize2 />}
              </Button>
            )}
            {/* Stop is filled like send while the box is empty. Once there is
                text to send it steps back to an outlined button, so the one that
                commits the text is the one that stands out. */}
            {running && onStop && (
              <Tooltip
                content={
                  <span className="ui-composer-tip">
                    Cancel <Kbd>⌘⇧⌫</Kbd>
                  </span>
                }
              >
                <Button
                  size="icon-sm"
                  variant="ghost"
                  className="ui-composer-stop"
                  data-emphasis={canSend ? "secondary" : "primary"}
                  aria-label="Stop response"
                  onClick={onStop}
                >
                  <Square />
                </Button>
              </Tooltip>
            )}
            {(!running || canSend) && (
              <Tooltip
                content={
                  <span className="ui-composer-tip">
                    {sendLabel} <Kbd>{sendKeys}</Kbd>
                  </span>
                }
              >
                <Button
                  size="icon-sm"
                  variant="ghost"
                  className="ui-composer-send"
                  aria-label={sendLabel}
                  disabled={!canSend}
                  onClick={onSend}
                >
                  {mode === "edit" ? (
                    <Check strokeWidth={1.5} />
                  ) : mode === "queue" ? (
                    <CornerDownLeft strokeWidth={1.5} />
                  ) : (
                    <ArrowUp strokeWidth={1.5} />
                  )}
                </Button>
              </Tooltip>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
export function QueuedMessage({
  children,
  onEdit,
  onRemove,
}: {
  children: ReactNode;
  onEdit?: () => void;
  onRemove?: () => void;
}) {
  return (
    <div className="ui-queued-message">
      <span>{children}</span>
      {onEdit && (
        <Button variant="ghost" size="xs" onClick={onEdit}>
          Edit
        </Button>
      )}
      {onRemove && (
        <Button
          variant="ghost"
          size="icon-sm"
          aria-label="Remove queued message"
          onClick={onRemove}
        >
          <X />
        </Button>
      )}
    </div>
  );
}
