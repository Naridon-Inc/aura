// Floating inline composer for the code editor.
//
// When a file is open in the editor pane, this bar floats bottom-center over
// the Monaco view so you can ask for a change to the file you're
// looking at without leaving the editor. It is the shared composer box the
// chat mounts, with the chat's `@file` and `/command` lists, and it hands
// the instruction to a coding agent pinned to this repo via the existing
// `aura:hand-task-to-agent` bridge (the same one the "Hand to agent" button and
// the worktree Create-PR/commit actions use). The open file rides along as
// context so the agent knows what you meant by "this".

import { useCallback, useEffect, useRef, useState } from "react";

import { Composer, type ComposerSuggestion } from "../ui/composer";
import { ComposerAddMenu } from "../ui/composer-tools";
import { Kbd } from "../ui/kbd";
import { ComposerTurnMenu, TURN_MODES } from "../chat/composer/ComposerTurnMenu";
import { useComposerSuggestions } from "../chat/composer/useComposerSuggestions";
import type { ComposerMode } from "../manager/chat/composerTypes";

type Mode = ComposerMode;

// Same key + event the main chat composer uses, so the two stay in lockstep.
const MODE_KEY = "aura.manager.mode";

function isMode(v: unknown): v is Mode {
  return v === "auto" || v === "build" || v === "plan" || v === "ask";
}

function readMode(): Mode {
  try {
    const v = localStorage.getItem(MODE_KEY);
    if (isMode(v)) return v;
  } catch {
    /* ignore */
  }
  return "build";
}

/** Turn the selected mode into a leading directive for the coding agent. Build
 *  needs none (the agent edits by default); Plan/Ask constrain it. */
function modeDirective(mode: Mode): string {
  switch (mode) {
    case "plan":
      return "First propose a short plan before editing anything.\n\n";
    case "ask":
      return "Answer the question about this file. Do NOT edit any files.\n\n";
    default:
      return "";
  }
}

export function EditorInlineComposer({
  repoRoot,
  filePath,
  fileLabel,
}: {
  repoRoot: string;
  filePath: string;
  fileLabel: string;
}) {
  const fieldRef = useRef<HTMLTextAreaElement>(null);
  const [mode, setMode] = useState<Mode>(() => readMode());
  const [draft, setDraft] = useState("");
  // The mode Plan toggles back to, so ⇧Tab out of Plan lands where you were.
  const lastActModeRef = useRef<Mode>(mode === "plan" ? "build" : mode);

  // Keep the mode in sync when the main chat composer changes it.
  useEffect(() => {
    const onSetMode = (e: Event) => {
      const next = (e as CustomEvent<{ mode?: Mode }>).detail?.mode;
      if (isMode(next)) setMode(next);
    };
    window.addEventListener("aura:composer:set-mode", onSetMode);
    return () => window.removeEventListener("aura:composer:set-mode", onSetMode);
  }, []);

  const changeMode = useCallback((next: Mode) => {
    if (next !== "plan") lastActModeRef.current = next;
    setMode(next);
    try {
      localStorage.setItem(MODE_KEY, next);
    } catch {
      /* ignore */
    }
    window.dispatchEvent(
      new CustomEvent("aura:composer:set-mode", { detail: { mode: next } }),
    );
  }, []);

  const send = useCallback(() => {
    const text = draft.trim();
    if (!text) return;
    const prompt =
      modeDirective(mode) +
      `Working in \`${fileLabel}\` (${filePath}).\n\n${text}`;
    window.dispatchEvent(
      new CustomEvent("aura:hand-task-to-agent", {
        detail: { agent: "claude", label: fileLabel, prompt, cwd: repoRoot },
      }),
    );
    setDraft("");
  }, [draft, mode, fileLabel, filePath, repoRoot]);

  // The `@` and `/` lists, the same rows the chat composer offers.
  const caret = fieldRef.current?.selectionStart ?? draft.length;
  const { suggestions, resolvePick } = useComposerSuggestions({
    repoRoot,
    before: draft.slice(0, caret),
  });
  const onSuggestionSelect = (pick: ComposerSuggestion) => {
    setDraft((prev) => resolvePick(pick, prev) ?? prev);
  };

  // ⌘L focuses the inline bar — but ONLY while the editor itself has focus, so
  // it never steals the shortcut from the chat composer (which binds a global
  // ⌘L to focus itself). Capture-phase + stopImmediatePropagation preempts that
  // listener when the user is actually looking at a file.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!e.metaKey || e.altKey || e.ctrlKey || e.key.toLowerCase() !== "l") return;
      const ae = document.activeElement as HTMLElement | null;
      if (!ae?.closest?.(".monaco-editor")) return;
      e.preventDefault();
      e.stopImmediatePropagation();
      fieldRef.current?.focus();
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, []);

  const empty = draft.trim().length === 0;
  const modeLabel = TURN_MODES.find((m) => m.value === mode)?.label ?? "Agent";

  return (
    // Placement only: the bar floats bottom-centre over the Monaco view; the
    // box itself is the shared composer, drawn as the chat draws it.
    <div className="absolute bottom-3 left-1/2 z-20 w-[min(680px,92%)] -translate-x-1/2">
      <Composer
        value={draft}
        onChange={setDraft}
        onSend={send}
        textareaRef={fieldRef}
        ariaLabel={`Ask about ${fileLabel}`}
        suggestions={suggestions}
        onSuggestionSelect={onSuggestionSelect}
        planMode={mode === "plan"}
        onPlanModeChange={(on) => changeMode(on ? "plan" : lastActModeRef.current)}
        context={
          <span title={filePath}>
            Sending to {modeLabel} in {fileLabel}
            {empty && (
              <>
                {" · "}
                <Kbd>⌘L</Kbd> to focus
              </>
            )}
          </span>
        }
        renderAddMenu={() => (
          <ComposerAddMenu
            onPlan={() => changeMode(mode === "plan" ? lastActModeRef.current : "plan")}
            planMode={mode === "plan"}
          >
            <ComposerTurnMenu mode={mode} onModeChange={changeMode} />
          </ComposerAddMenu>
        )}
      />
    </div>
  );
}
