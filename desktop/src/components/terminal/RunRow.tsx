// The Run row — the reserved first row of the terminal side-list.
//
// It is pinned above the terminals you opened yourself because it is not one
// of them: there is exactly one Run per project, it always means the same
// thing, and it is where you look for the thing you are building. A terminal
// you opened is a place you went; Run is a place that is always there.
//
// It shows the command BEFORE you press it. That is the whole difference
// between a Run button and a magic button: you can see that we read
// `package.json` and picked `bun run dev`, and disagree in one click. When
// the repo justified nothing, the row says so and asks — it does not offer a
// hopeful `npm run dev` that fails on the first keystroke and reads like the
// project's fault.

import { useCallback, useEffect, useRef, useState } from "react";
import { Pencil, Play, RotateCw, Square } from "lucide-react";
import {
  RUN_LABEL,
  detectRun,
  resolveRunCommand,
  runCommandOverride,
} from "../../lib/runPane";
import { RUN_COMMAND_CHANGED, promptForRunCommand } from "./runPrompt";

type Props = {
  repoRoot: string;
  /** True when Run is open and is the panel's focused terminal. */
  active: boolean;
  /** True when a Run terminal exists at all (focused or not). */
  open: boolean;
  /** Start, or restart if already open. */
  onRun: () => void;
  /** Focus the existing Run terminal without restarting it. */
  onFocus: () => void;
  onStop: () => void;
};

export function RunRow({ repoRoot, active, open, onRun, onFocus, onStop }: Props) {
  const [command, setCommand] = useState<string | null>(null);
  const [source, setSource] = useState<string | null>(null);

  // `resolveRunCommand` reads through a shared cache, so the two panels that
  // can be showing this row at once cost one backend read between them.
  const alive = useRef(true);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);

  const refresh = useCallback(async () => {
    const cmd = await resolveRunCommand(repoRoot);
    if (!alive.current) return;
    setCommand(cmd);
    // The evidence line is only meaningful for a command we detected — a
    // pinned one came from the person reading this, not from a file.
    if (runCommandOverride(repoRoot)) {
      setSource(null);
      return;
    }
    const found = await detectRun(repoRoot).catch(() => null);
    if (!alive.current) return;
    setSource(found?.candidates[0]?.source ?? null);
  }, [repoRoot]);

  // Resolve on mount and whenever the project changes, and again whenever the
  // command is changed anywhere — the pencil here, or ⌘R on a project we
  // couldn't read one out of. Both write through the same place.
  useEffect(() => {
    void refresh();
    function onChanged(e: Event) {
      const detail = (e as CustomEvent<{ repoRoot?: string }>).detail;
      if (detail?.repoRoot && detail.repoRoot !== repoRoot) return;
      void refresh();
    }
    window.addEventListener(RUN_COMMAND_CHANGED, onChanged);
    return () => window.removeEventListener(RUN_COMMAND_CHANGED, onChanged);
  }, [repoRoot, refresh]);

  async function editCommand() {
    await promptForRunCommand(repoRoot);
    // The prompt fires RUN_COMMAND_CHANGED on save, which re-reads this row.
    // Cancelling changes nothing, so there is nothing to undo here.
  }

  const subtitle = command ?? "Set a command…";
  const hint = command
    ? source
      ? `${command}, from ${source}`
      : command
    : "No dev command found in this project. Click to set one.";

  return (
    <div
      role="button"
      tabIndex={0}
      title={hint}
      onMouseDown={(e) => {
        if (e.button !== 0) return;
        // Open → go to it. Closed → start it. Either way the row does the one
        // thing its state implies, and the play button is the explicit
        // "(re)start" for when Run is already open and focused.
        if (!command) void editCommand();
        else if (open) onFocus();
        else onRun();
      }}
      onKeyDown={(e) => {
        if (e.key !== "Enter" && e.key !== " ") return;
        e.preventDefault();
        if (!command) void editCommand();
        else if (open) onFocus();
        else onRun();
      }}
      className={[
        "group relative flex items-center gap-1.5 min-w-0 py-1 pl-2 pr-1 cursor-pointer select-none transition-colors border-b border-line-soft",
        active
          ? "bg-accent/10 text-text-1 hover:bg-accent/15"
          : "text-text-3 hover:bg-state-hover hover:text-text-2",
      ].join(" ")}
    >
      {active && <span className="absolute left-0 top-0 bottom-0 w-0.5 bg-accent" />}
      <Play className="h-3 w-3 flex-shrink-0" />
      <div className="min-w-0 flex-1 leading-tight">
        <div className="text-xs truncate">{RUN_LABEL}</div>
        <div
          className={[
            "font-mono text-[10px] truncate",
            command ? "text-text-5" : "text-text-5 italic",
          ].join(" ")}
        >
          {subtitle}
        </div>
      </div>
      <div className="flex items-center gap-0.5 flex-shrink-0 opacity-0 transition-opacity group-hover:opacity-100">
        {open && (
          <button
            type="button"
            title="Stop"
            onMouseDown={(e) => e.stopPropagation()}
            onClick={(e) => {
              e.stopPropagation();
              onStop();
            }}
            className="h-4 w-4 grid place-items-center rounded text-text-4 transition-colors hover:text-text-2 hover:bg-state-hover"
          >
            <Square className="h-2.5 w-2.5" />
          </button>
        )}
        {command && (
          <button
            type="button"
            title={open ? "Restart" : "Run"}
            onMouseDown={(e) => e.stopPropagation()}
            onClick={(e) => {
              e.stopPropagation();
              onRun();
            }}
            className="h-4 w-4 grid place-items-center rounded text-text-4 transition-colors hover:text-text-2 hover:bg-state-hover"
          >
            {open ? <RotateCw className="h-2.5 w-2.5" /> : <Play className="h-2.5 w-2.5" />}
          </button>
        )}
        <button
          type="button"
          title="Change run command"
          onMouseDown={(e) => e.stopPropagation()}
          onClick={(e) => {
            e.stopPropagation();
            void editCommand();
          }}
          className="h-4 w-4 grid place-items-center rounded text-text-4 transition-colors hover:text-text-2 hover:bg-state-hover"
        >
          <Pencil className="h-2.5 w-2.5" />
        </button>
      </div>
    </div>
  );
}
