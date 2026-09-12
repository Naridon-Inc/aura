// One line of "What Aura did".
//
// A line stands for one action, which may be several recorded steps (ten files
// filed under one reason is one action). It reads top to bottom: what happened,
// then the reason in the person's own words, then the files it happened to.
// Opening a line shows every file in full rather than the raw undo payload it
// used to print — that payload is the engine's data structure, and nobody
// opening this window is asking to read JSON.

import { outsideCount, type OpFile, type OpStory } from "./describe";

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

function FileList({ files }: { files: readonly OpFile[] }) {
  return (
    <ul className="mt-1 space-y-0.5">
      {files.map((f) => (
        <li key={f.path} className="text-2xs text-text-3 truncate" title={f.path}>
          <span className="text-text-2">{f.name}</span>
          {f.outside && <span className="text-text-4"> · outside this project</span>}
        </li>
      ))}
    </ul>
  );
}

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
    <button
      type="button"
      onClick={onToggle}
      disabled={inert}
      className={[
        "w-full text-left px-2.5 py-2 border-b border-line-soft last:border-b-0 transition-colors",
        inert
          ? "opacity-50 cursor-not-allowed"
          : selected
            ? "bg-bg-3"
            : isUndoTarget
              ? "bg-bg-2 hover:bg-bg-3"
              : "hover:bg-state-hover",
      ].join(" ")}
    >
      <div className="flex items-baseline gap-2">
        <span className="text-text-1 text-sm flex-1 truncate">{story.title}</span>
        <span className="text-text-4 text-2xs shrink-0">{age}</span>
        {undone ? (
          <span className="section-label shrink-0">undone</span>
        ) : !reversible ? (
          <span className="section-label shrink-0">can’t be undone</span>
        ) : null}
      </div>

      {story.reason && (
        <div className="mt-1 border-l-2 border-line pl-2 text-xs text-text-3 line-clamp-2">
          {story.reason}
        </div>
      )}

      {story.note && <div className="mt-1 text-xs text-text-3 truncate">{story.note}</div>}

      {story.files.length > 0 &&
        (selected ? (
          <FileList files={story.files} />
        ) : (
          <div className="mt-1 text-2xs text-text-4 truncate">
            {inline.map((f) => f.name).join(" · ")}
            {rest > 0 && ` +${rest} more`}
          </div>
        ))}

      {selected && outside > 0 && (
        <div className="mt-1 text-2xs text-text-4">
          {outside === story.files.length
            ? outside === 1
              ? "This file isn’t in this project — it’s a scratch or notes file the step was recorded against."
              : "None of these are in this project — they’re scratch or notes files the steps were recorded against."
            : `${outside} of these aren’t in this project.`}
        </div>
      )}

      {selected && story.steps > 1 && (
        <div className="mt-1 text-2xs text-text-4">
          Aura recorded this as {story.steps} steps. Undo takes back the most recent one.
        </div>
      )}
    </button>
  );
}
