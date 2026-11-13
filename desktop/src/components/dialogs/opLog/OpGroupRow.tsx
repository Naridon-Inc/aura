// One line of "What Aura did".
//
// A line stands for one action, which may be several recorded steps (ten files
// filed under one reason is one action). It reads top to bottom: what happened,
// then the reason in the person's own words, then the files it happened to.
// Opening a line shows every file in full rather than the raw undo payload it
// used to print — that payload is the engine's data structure, and nobody
// opening this window is asking to read JSON.

import { TraceMark } from "../../ui/trace-list";
import { TraceTimelineEntry } from "../../ui/trace-timeline";
import { outsideCount, type OpFile, type OpStory } from "./describe";
import "../../ui/op-log.css";

/** Names shown inline before the row is opened. */
const FILES_INLINE = 3;

type Props = {
  story: OpStory;
  age: string;
  /** Nothing about this line can be reversed (already undone, or a kind the
   *  engine has no inverse for). */
  inert: boolean;
  undone: boolean;
  reversible: boolean;
  selected: boolean;
  /** This is what the button would undo if pressed right now. */
  isUndoTarget: boolean;
  onToggle: () => void;
};

// Spans, not a list: the whole moment is one button, and a button can only
// hold inline content.
function FileList({ files }: { files: readonly OpFile[] }) {
  return (
    <span className="ui-op-log-line ui-op-log-files">
      {files.map((f) => (
        <span key={f.path} title={f.path}>
          <span className="ui-op-log-file">{f.name}</span>
          {f.outside && " · outside this repository"}
        </span>
      ))}
    </span>
  );
}

/** One moment on the timeline. The moment the Undo button would act on — the
 *  one you opened, or the newest reversible one when you haven't — carries the
 *  filled marker. */
export function OpGroupRow({
  story,
  age,
  inert,
  undone,
  reversible,
  selected,
  isUndoTarget,
  onToggle,
}: Props) {
  const inline = story.files.slice(0, FILES_INLINE);
  const rest = story.files.length - inline.length;
  const outside = outsideCount(story.files);
  return (
    <TraceTimelineEntry
      title={story.title}
      active={selected || isUndoTarget}
      disabled={inert}
      onSelect={onToggle}
      detail={
        <>
          <span>{age}</span>
          {undone ? (
            <TraceMark>undone</TraceMark>
          ) : !reversible ? (
            <TraceMark>can’t be undone</TraceMark>
          ) : null}

          {story.reason && (
            <span className="ui-op-log-line ui-op-log-reason">{story.reason}</span>
          )}

          {story.note && <span className="ui-op-log-line ui-op-log-clip">{story.note}</span>}

          {story.files.length > 0 &&
            (selected ? (
              <FileList files={story.files} />
            ) : (
              <span className="ui-op-log-line ui-op-log-clip">
                {inline.map((f) => f.name).join(" · ")}
                {rest > 0 && ` +${rest} more`}
              </span>
            ))}

          {selected && outside > 0 && (
            <span className="ui-op-log-line">
              {outside === story.files.length
                ? outside === 1
                  ? "This file isn’t in this repository — it’s a scratch or notes file the step was recorded against."
                  : "None of these are in this repository — they’re scratch or notes files the steps were recorded against."
                : `${outside} of these ${outside === 1 ? "isn’t" : "aren’t"} in this repository.`}
            </span>
          )}

          {selected && story.steps > 1 && (
            <span className="ui-op-log-line">
              Aura recorded this as {story.steps} steps. Undo takes back the most recent one.
            </span>
          )}
        </>
      }
    />
  );
}
