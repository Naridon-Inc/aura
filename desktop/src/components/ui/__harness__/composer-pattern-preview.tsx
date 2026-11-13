import { useState } from "react";
import { Composer, type ComposerAttachment } from "../composer";
import { ModelPicker, type ModelOption, type ModelSelection } from "../model-picker";
import { MessageQueue, type QueueEntry } from "../message-queue";
import {
  ContextUsageIndicator,
  McpStatusMenu,
  ComposerAddMenu,
  AutoAcceptControl,
  TerminalCommandNotice,
} from "../composer-tools";
import { Button } from "../button";
import { Select } from "../select";
const initialModels: ModelOption[] = [
  {
    id: "opus",
    name: "Opus 4.8",
    provider: "Claude",
    efforts: ["Low", "Medium", "High", "Max"],
    newChat: true,
  },
  {
    id: "sol",
    name: "GPT-5.6 Sol",
    provider: "OpenAI",
    efforts: ["Low", "Medium", "High"],
    shortcut: "⌃ ⌘ 2",
  },
  {
    id: "astra",
    name: "GPT-6 Astra",
    provider: "OpenAI",
    efforts: ["Low", "Medium", "High", "Extra high"],
    fast: true,
  },
  { id: "sonnet", name: "Sonnet 4.6", provider: "Claude", efforts: ["Low", "Medium", "High"] },
];
export function ComposerPatternPreview() {
  const [models, setModels] = useState(initialModels),
    [visible, setVisible] = useState(["opus", "sol", "astra"]);
  const [selection, setSelection] = useState<ModelSelection>({ model: "astra", effort: "High" });
  const [draft, setDraft] = useState(""),
    [queue, setQueue] = useState<QueueEntry[]>([
      { id: "first", text: "Check the keyboard navigation." },
      { id: "second", text: "Then review the changed files." },
    ]);
  const [mode, setMode] = useState<"send" | "queue" | "edit">("queue"),
    [running, setRunning] = useState(true);
  const [minimized, setMinimized] = useState(false),
    [attachments, setAttachments] = useState<ComposerAttachment[]>([]);
  const [accept, setAccept] = useState(false),
    [notice, setNotice] = useState(""),
    [terminal, setTerminal] = useState(true);
  const [paused, setPaused] = useState(false),
    [recording, setRecording] = useState(false),
    [sendKey, setSendKey] = useState<"enter" | "mod-enter">("enter");
  const addContext = (name: string, kind: ComposerAttachment["kind"]) =>
    setAttachments((all) => [...all, { id: crypto.randomUUID(), name, kind }]);
  return (
    <div className="lab-pattern-stack">
      <div className="lab-pattern-controls">
        <Select
          aria-label="Composer action"
          value={mode}
          onChange={(next) => setMode(next as typeof mode)}
          options={[
            { value: "send", label: "Send" },
            { value: "queue", label: "Queue" },
            { value: "edit", label: "Edit" },
          ]}
        />
        <Button size="sm" variant="outline" onClick={() => setRunning(!running)}>
          {running ? "Running" : "Idle"}
        </Button>
        <Select
          aria-label="Send shortcut"
          value={sendKey}
          onChange={(key) => setSendKey(key as typeof sendKey)}
          options={[
            { value: "enter", label: "Enter to send" },
            { value: "mod-enter", label: "⌘ Enter to send" },
          ]}
        />
        <AutoAcceptControl value={accept} onChange={setAccept} />
      </div>
      <Composer
        value={draft}
        onChange={setDraft}
        mode={mode}
        running={running}
        minimized={minimized}
        onMinimizedChange={setMinimized}
        sendKey={sendKey}
        recording={recording}
        onVoiceToggle={() => {
          setRecording(!recording);
          setNotice(
            recording
              ? "Voice input stopped in preview."
              : "Voice input state preview; microphone is not accessed.",
          );
        }}
        onStop={() => {
          setRunning(false);
          setNotice("Response stopped in the preview.");
        }}
        onSend={() => {
          if (mode === "queue")
            setQueue([
              ...queue,
              {
                id: crypto.randomUUID(),
                text: draft || attachments.map((file) => file.name).join(", "),
              },
            ]);
          else
            setNotice(
              mode === "edit"
                ? "Message edit saved in the preview."
                : "Message sent in the preview.",
            );
          setDraft("");
          setAttachments([]);
        }}
        onCancelEdit={() => {
          setMode("send");
          setDraft("");
        }}
        attachments={attachments}
        onRemoveAttachment={(id) => setAttachments(attachments.filter((item) => item.id !== id))}
        onAttach={(files) =>
          setAttachments([
            ...attachments,
            ...files.map((file) => ({
              id: crypto.randomUUID(),
              name: file.name,
              kind: "file" as const,
            })),
          ])
        }
        suggestions={[
          {
            id: "file",
            label: "src/App.tsx",
            detail: "File",
            kind: "mention",
            insertText: "@src/App.tsx",
          },
          {
            id: "folder",
            label: "src/components",
            detail: "Directory",
            kind: "mention",
            insertText: "@src/components",
          },
          {
            id: "review",
            label: "/review",
            detail: "Review workspace changes",
            kind: "command",
            insertText: "/review",
          },
          {
            id: "compact",
            label: "/compact",
            detail: "Summarize this conversation",
            kind: "command",
            insertText: "/compact",
          },
        ]}
        queue={
          <MessageQueue
            items={queue}
            onChange={setQueue}
            paused={paused}
            onPausedChange={setPaused}
            onSteer={(item) => {
              setQueue(queue.filter((entry) => entry.id !== item.id));
              setNotice(`Sent now: ${item.text}`);
            }}
          />
        }
        footer={
          <ModelPicker
            models={models}
            value={selection}
            onChange={setSelection}
            visibleIds={visible}
            onVisibleChange={setVisible}
            onReorder={(ids) =>
              setModels(ids.map((id) => models.find((model) => model.id === id)!))
            }
          />
        }
        actions={
          <>
            <ContextUsageIndicator
              usage={{ used: 42000, total: 200000, input: 32000, output: 10000, cached: 24000 }}
            />
            <McpStatusMenu
              servers={[
                { id: "files", name: "Workspace files", status: "connected" },
                { id: "design", name: "Design tools", status: "error" },
              ]}
              onRetry={(id) => setNotice(`Retry requested for ${id}.`)}
              onConfigure={() =>
                setNotice("Open the MCP configuration in the consuming application.")
              }
            />
            <ComposerAddMenu
              onWorkspace={() => addContext("Design workspace", "workspace")}
              onDirectory={() => addContext("src/components", "file")}
              onIssue={() => addContext("Issue #42", "issue")}
              onSnippet={() => addContext("Review checklist", "snippet")}
            />
          </>
        }
      />
      <p className="lab-pattern-help">
        Type @ for files or / for commands. Queue handles support Alt + ↑ / ↓. Model rows support
        dragging and Alt + ↑ / ↓.
      </p>
      {terminal && (
        <TerminalCommandNotice
          command="bun run typecheck"
          status="done"
          output="Type check completed with no errors."
          onOpen={() => setNotice("Terminal action selected.")}
          onRefresh={() => setNotice("Configuration refresh requested.")}
          onDismiss={() => setTerminal(false)}
        />
      )}
      <output className="lab-pattern-output" aria-live="polite">
        {notice || "Interactions affect local preview data."}
      </output>
    </div>
  );
}
