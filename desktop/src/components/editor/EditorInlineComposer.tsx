// Floating inline composer for the code editor.
//
// When a file is open in the editor pane, this bar floats bottom-center over
// the Monaco view (Cursor-style) so you can ask for a change to the file you're
// looking at without leaving the editor. It embeds the same `TiptapComposer`
// the chat uses — so `@file` mentions and `/commands` work here too — and hands
// the instruction to a coding agent pinned to this repo via the existing
// `aura:hand-task-to-agent` bridge (the same one the "Hand to agent" button and
// the worktree Create-PR/commit actions use). The open file rides along as
// context so the agent knows what you meant by "this".

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ArrowUp } from "lucide-react";

import { TiptapComposer, type TiptapComposerHandle } from "../manager/TiptapComposer";
import { ChipButton } from "../ui/chip";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "../ui/dropdown-menu";

type Mode = "auto" | "build" | "plan" | "ask";

const MODE_OPTIONS: { value: Mode; label: string; hint: string }[] = [
  { value: "auto", label: "Auto", hint: "Let Aura decide: plan or build" },
  { value: "build", label: "Build", hint: "Make the change now" },
  { value: "plan", label: "Plan", hint: "Draft a plan before editing" },
  { value: "ask", label: "Ask", hint: "Answer — don't edit files" },
];

// Same key + event the main chat composer uses, so the two stay in lockstep.
const MODE_KEY = "aura.manager.mode";

function readMode(): Mode {
  try {
    const v = localStorage.getItem(MODE_KEY);
    if (v === "auto" || v === "build" || v === "plan" || v === "ask") return v;
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
  const composerRef = useRef<TiptapComposerHandle>(null);
  const [mode, setMode] = useState<Mode>(() => readMode());
  const [draft, setDraft] = useState("");

  const activeMode = useMemo(
    () => MODE_OPTIONS.find((o) => o.value === mode) ?? MODE_OPTIONS[1],
    [mode],
  );

  // Keep the mode chip in sync when the main chat composer changes mode.
  useEffect(() => {
    const onSetMode = (e: Event) => {
      const next = (e as CustomEvent<{ mode?: Mode }>).detail?.mode;
      if (next === "auto" || next === "build" || next === "plan" || next === "ask") {
        setMode(next);
      }
    };
    window.addEventListener("aura:composer:set-mode", onSetMode);
    return () => window.removeEventListener("aura:composer:set-mode", onSetMode);
  }, []);

  const changeMode = useCallback((next: Mode) => {
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
    composerRef.current?.clear();
    setDraft("");
  }, [draft, mode, fileLabel, filePath, repoRoot]);

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
      composerRef.current?.focus();
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, []);

  const empty = draft.trim().length === 0;

  return (
    <div className="absolute bottom-3 left-1/2 z-20 w-[min(680px,92%)] -translate-x-1/2 rounded-xl border border-line-soft bg-bg-card/95 shadow-lg shadow-black/30 backdrop-blur">
      {/* Top row — target + open-file context + focus hint. */}
      <div className="flex items-center gap-2 px-3 pt-2 text-[11px] text-text-4">
        <span>Sending to</span>
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <ChipButton size="sm" chevron title={activeMode.hint}>
              {activeMode.label}
            </ChipButton>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="start" side="top">
            {MODE_OPTIONS.map((o) => (
              <DropdownMenuItem key={o.value} onSelect={() => changeMode(o.value)}>
                {o.label}
              </DropdownMenuItem>
            ))}
          </DropdownMenuContent>
        </DropdownMenu>
        <span className="truncate text-text-5" title={filePath}>
          in {fileLabel}
        </span>
        {empty && (
          <span className="ml-auto shrink-0">
            <kbd className="rounded border border-line-soft bg-bg-2 px-1 py-0.5 text-[10px] text-text-4">
              ⌘L
            </kbd>{" "}
            to focus
          </span>
        )}
      </div>

      {/* Input row — the shared Tiptap editor + a send button. */}
      <div className="flex items-end gap-2 px-2 pb-2 pt-1">
        <div className="min-w-0 flex-1">
          <TiptapComposer
            ref={composerRef}
            repoRoot={repoRoot}
            initialMarkdown=""
            busy={false}
            placeholder="Ask to make changes, @mention files, run /commands"
            onChange={setDraft}
            onSubmit={send}
          />
        </div>
        <button
          type="button"
          onClick={send}
          disabled={empty}
          title="Send (⌘↵)"
          className="grid h-7 w-7 shrink-0 place-items-center rounded-md bg-accent text-[color:var(--color-accent-foreground)] transition-opacity disabled:opacity-40"
        >
          <ArrowUp size={14} />
        </button>
      </div>
    </div>
  );
}
