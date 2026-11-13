// The Changes tab's right column for one file: a bar naming the file and
// holding the code controls, then MEANING FIRST — the recorded plain-words
// before/after — and the code second, behind a quiet reveal.
//
// The side-by-side and editable views stay the Monaco editor (syntax colour,
// in-place editing, ⌘S); the unified read is the shared file diff.

import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { ArrowLeft } from "lucide-react";
import type { IntentChangesetFile } from "../../../lib/api";
import { materializeSides, symbolSpan, type DiffFocus } from "../../../lib/diffSides";
import {
  getDiffView,
  getEditableDiffs,
  setDiffView,
  setEditableDiffs,
  subscribeDiffView,
  subscribeEditableDiffs,
  type DiffView,
} from "../../../lib/diffViewPref";
import {
  getIgnoreWhitespace,
  setIgnoreWhitespace,
  subscribeIgnoreWhitespace,
} from "../../../lib/ignoreWhitespacePref";
import { reverseApplyDiff } from "../../../lib/reverseApplyDiff";
import { DiskChangedNotice, EditToggle, UnsavedMark } from "../../diff/DiffSaveState";
import { SplitDiff } from "../../diff/SplitDiff";
import { useEditableDiff } from "../../diff/useEditableDiff";
import { Button } from "../../ui/button";
import { DiffCount } from "../../ui/sidebar";
import { Toggle } from "../../ui/toggle";
import { ToggleGroup, ToggleGroupItem } from "../../ui/toggle-group";
import { ChangeNoteCard } from "../../workpanes/ChangeNoteCard";
import { SplitDiffHeader, SPLIT_INLINE_PX, type FocusPick } from "../../workpanes/SplitDiffHeader";
import { CodeReveal, CodeState, PieceDiff, RemoteChangeSummary } from "./ChangeCode";
import { changeStatus, fileChurn } from "./changeTree";
import { useChangeDiff } from "./useChangeDiff";

const VIEWS: { value: DiffView; label: string; title: string }[] = [
  { value: "split", label: "Split", title: "Side-by-side diff" },
  { value: "unified", label: "Unified", title: "Unified (inline) diff" },
];

/** One shared, persisted preference, re-read whenever any pane flips it. */
function usePref<T>(get: () => T, subscribe: (fn: (v: T) => void) => () => void): T {
  const [value, setValue] = useState<T>(get);
  useEffect(() => subscribe(setValue), [subscribe]);
  return value;
}

export function ChangeDiffPane({
  repoRoot,
  file,
  narrow,
  sinceBase,
  onBack,
  onBringBack,
  busySymbol,
  renderReasons,
  onDirtyChange,
}: {
  repoRoot: string;
  file: IntentChangesetFile;
  /** When narrow the tab is one column, and this pane offers a way back. */
  narrow: boolean;
  sinceBase: boolean;
  onBack: () => void;
  /** When set, the header offers per-piece "Bring this back" (surgical undo)
   *  right beside each changed piece. */
  onBringBack?: (symbol: string, relFile: string) => void;
  busySymbol?: string | null;
  /** Leads the pane with whatever the host can say about *why* this file
   *  changed, when the recorded change-note cannot be computed here. The
   *  desktop leaves it unset; the console passes the sentences their authors
   *  wrote. */
  renderReasons?: (file: IntentChangesetFile) => ReactNode;
  /** Tells the host when this pane holds unsaved edits, so switching files
   *  can ask before dropping them. */
  onDirtyChange?: (dirty: boolean) => void;
}) {
  const mode = usePref(getDiffView, subscribeDiffView);
  const ignoreWs = usePref(getIgnoreWhitespace, subscribeIgnoreWhitespace);
  const editPref = usePref(getEditableDiffs, subscribeEditableDiffs);
  const { diff, loading, error, diskText, absPath, refresh, note, when, author } =
    useChangeDiff(repoRoot, file, sinceBase);

  // Below SPLIT_INLINE_PX Monaco folds its split into one inline column, so
  // the header's two side columns stack to stay honest.
  const bodyRef = useRef<HTMLDivElement | null>(null);
  const [bodyNarrow, setBodyNarrow] = useState(false);
  useLayoutEffect(() => {
    const el = bodyRef.current;
    if (!el) return;
    const ro = new ResizeObserver((entries) => {
      for (const e of entries) setBodyNarrow(e.contentRect.width < SPLIT_INLINE_PX);
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  // The code is shown by default so it's right there to read; "Hide the code"
  // demotes it for anyone who wants only the meaning. Each file starts open.
  const [showCode, setShowCode] = useState(true);
  // The piece the reader clicked in the header. Held here because both the
  // header and the code have to agree on it: one shows it picked, the other
  // shows its lines under its caption.
  const [pick, setPick] = useState<FocusPick | null>(null);
  useEffect(() => {
    setShowCode(true);
    setPick(null);
  }, [file.path, file.commit]);
  const onFocusPiece = useCallback((p: FocusPick | null) => {
    setPick(p);
    // Picking a piece is asking to see code, so reveal it.
    if (p) setShowCode(true);
  }, []);
  const clearPick = useCallback(() => setPick(null), []);

  // The original side of an editable diff, rebuilt by walking the patch
  // backwards over the file on disk. Null when there is nothing to edit, or
  // when the two no longer describe each other — the pane then shows the
  // read-only diff, and the next refresh brings the editable one back.
  const editOriginal = useMemo(
    () => (diskText != null && diff != null ? reverseApplyDiff(diff, diskText) : null),
    [diskText, diff],
  );
  const edit = useEditableDiff({ absPath, diskText, onSaved: refresh, onDiskChanged: refresh });
  useEffect(() => {
    onDirtyChange?.(edit.dirty);
  }, [edit.dirty, onDirtyChange]);
  useEffect(() => () => onDirtyChange?.(false), [onDirtyChange]);

  const status = changeStatus(file.status);
  const churn = fileChurn(file);
  const hasDiff = !!diff && diff.trim().length > 0;
  // Split needs two sides; a one-sided (new/deleted) file reads unified so
  // the toggle never lands on a visually broken split.
  const sides = useMemo(() => (hasDiff ? materializeSides(diff as string) : null), [hasDiff, diff]);
  const splitDisabled = narrow || (sides?.oneSided ?? false);
  const view: DiffView = splitDisabled ? "unified" : mode;
  // Editable needs the whole file on both sides. Once there are unsaved edits
  // the editor stays up even if the reader flips to "Read only" — the switch
  // locks the text, it never discards it.
  const canEdit = hasDiff && editOriginal != null;
  const useEditor = canEdit && (editPref || edit.dirty);
  // Only the editor honours the whitespace preference, so the control shows
  // only while one is on screen.
  const monaco = useEditor || view === "split";

  // The picked piece, resolved to the lines it occupies on its side of THIS
  // diff. A null span is a real answer — the piece's lines were trimmed out of
  // the patch — and the code says so instead of pointing at a neighbour.
  const focus: DiffFocus | null = useMemo(() => {
    if (!pick || !sides) return null;
    const side = pick.side === "previous" ? "original" : "modified";
    return {
      span: symbolSpan(sides, pick.symbol, side),
      title: pick.title,
      identifier: pick.symbol.identifier,
      meaning: pick.meaning,
    };
  }, [pick, sides]);

  const mark = status.word === "renamed" ? "R" : status.status[0].toUpperCase();

  return (
    <div className="ui-changes-pane">
      <div className="ui-changes-bar">
        {narrow ? (
          <Button variant="ghost" size="xs" onClick={onBack}>
            <ArrowLeft size={12} aria-hidden />
            Files
          </Button>
        ) : null}
        <span className="ui-changes-status" data-status={status.status} title={status.word}>
          {mark}
        </span>
        <span className="ui-changes-path" dir="rtl" title={file.path}>
          {file.path}
        </span>
        <UnsavedMark edit={edit} />
        {churn ? <DiffCount added={churn.adds} removed={churn.dels} /> : null}
        <DiskChangedNotice edit={edit} />
        {showCode && hasDiff ? (
          <span className="ui-changes-tools">
            {canEdit ? <EditToggle on={editPref} onChange={setEditableDiffs} /> : null}
            {!splitDisabled ? (
              <ToggleGroup
                type="single"
                size="sm"
                aria-label="How the diff is laid out"
                value={view}
                onValueChange={(v) => v && setDiffView(v as DiffView)}
              >
                {VIEWS.map((o) => (
                  <ToggleGroupItem key={o.value} value={o.value} title={o.title}>
                    {o.label}
                  </ToggleGroupItem>
                ))}
              </ToggleGroup>
            ) : null}
            {monaco ? (
              <Toggle
                size="sm"
                pressed={ignoreWs}
                onPressedChange={setIgnoreWhitespace}
                title={
                  ignoreWs ? "Whitespace-only changes hidden" : "Hide whitespace-only changes"
                }
              >
                Hide whitespace
              </Toggle>
            ) : null}
          </span>
        ) : null}
      </div>

      <div ref={bodyRef} className="ui-changes-body">
        {renderReasons?.(file)}
        {note ? (
          <SplitDiffHeader
            note={note}
            when={when}
            author={author}
            repoRoot={repoRoot}
            commit={file.commit}
            stacked={bodyNarrow}
            onBringBack={onBringBack}
            busySymbol={busySymbol}
            onFocusPiece={onFocusPiece}
          />
        ) : file.commit ? (
          <ChangeNoteCard repoRoot={repoRoot} commit={file.commit} path={file.path} />
        ) : null}

        {file.remote_only ? (
          <RemoteChangeSummary file={file} />
        ) : loading ? (
          <CodeState kind="loading" />
        ) : error ? (
          <CodeState kind="error" error={error} />
        ) : !hasDiff ? (
          <CodeState kind="empty" committed={Boolean(file.commit)} />
        ) : (
          <CodeReveal
            show={showCode}
            onToggle={() => setShowCode((v) => !v)}
            adds={churn?.adds ?? 0}
            dels={churn?.dels ?? 0}
            keepMounted={edit.dirty}
          >
            {useEditor ? (
              // The working-tree file, whole, with the current side open to
              // typing; ⌘S saves. Inline when the reader prefers unified — it
              // has to stay an editor to be editable.
              <SplitDiff
                diff={diff as string}
                path={file.path}
                focus={focus}
                onClearFocus={clearPick}
                sides={{ original: editOriginal as string, modified: edit.modified }}
                inline={view === "unified"}
                edit={{ readOnly: !editPref, attach: edit.attach }}
              />
            ) : view === "split" ? (
              <SplitDiff
                diff={diff as string}
                path={file.path}
                focus={focus}
                onClearFocus={clearPick}
              />
            ) : (
              <PieceDiff diff={diff as string} path={file.path} focus={focus} onClearFocus={clearPick} />
            )}
          </CodeReveal>
        )}
      </div>
    </div>
  );
}
