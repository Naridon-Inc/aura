import { ChatViewSwitcher } from "../chat/ChatViewSwitcher";
import { useEffect, useMemo, useRef, useState } from "react";
import { promptForChatMode, type ChatMode } from "../chat/composer/chatMode";
import { AgentTurnModelPicker } from "../chat/model/AgentModelPickers";
import { QuestionFlow } from "../chat/QuestionFlow";
import { PermissionRequest } from "../ui/chat-decisions";
import { RotateCcw, Terminal } from "lucide-react";
import { DropdownMenuItem, DropdownMenuSeparator } from "../ui/dropdown-menu";
import { api, type PermissionPrompt } from "../../lib/api";
import { type AgentTab, useEditorStore } from "../../lib/editorStore";
import {
  bindChannelMeta,
  configureChatHistory,
  getChannelEvents,
  getResumeSession,
  markTurnStarted,
  pushEvent,
  setResumedHistory,
  streamChannel,
  useAgentStream,
  waitForAgentStream,
} from "../../lib/agentStreamStore";
import { readChatHistory } from "../../lib/chatHistory";
import { usePermissionPrompts, decidePrompt } from "../../lib/permissionStore";
import { NormalizedTranscript } from "./normalized/NormalizedTranscript";
import { ACP_PROMPT_TOOLS, AcpPrompt } from "./AcpPrompts";
import { acpModels, acpSessionState } from "../../lib/agentProtocol/adapters/acp";
import { manifestFor } from "../../lib/agentProtocol/manifest";
import type { SlashItem } from "../chat/composer/useComposerSuggestions";

export function StreamChatView({ tab }: { tab: AgentTab }) {
  const channel = `${streamChannel(tab.agentId, tab.repoRoot)}_${tab.sessionId.replace(/[^A-Za-z0-9_-]/g, "_")}`;
  const key = `aura.structured-chat.${tab.sessionId}`;
  const store = useEditorStore();
  const { events, running, sessionId, storageError } = useAgentStream(channel);
  const [model, setModel] = useState(() => {
    try {
      return localStorage.getItem(`${key}.model`) ?? "";
    } catch {
      return "";
    }
  });
  const [error, setError] = useState("");
  const busy = useRef(false);
  const restored = useRef(false);
  const historyReady = useRef<Promise<void>>(Promise.resolve());
  const prompts = usePermissionPrompts(channel);
  // What the agent's own ACP session offers: its commands and its models.
  const acp = useMemo(() => acpSessionState(events), [events]);
  const agentCommands = useMemo<SlashItem[] | undefined>(() => {
    const label = manifestFor(tab.agentId).label;
    return acp?.commands.map(c => ({ name: c.name, summary: c.description, args: c.hint, source: "agent", badge: label }));
  }, [acp, tab.agentId]);
  const offeredModels = useMemo(() => acpModels(acp), [acp]);
  useEffect(() => {
    bindChannelMeta(channel, { agentId: tab.agentId, repoRoot: tab.repoRoot });
    configureChatHistory(channel, key);
    if (!restored.current) {
      restored.current = true;
      historyReady.current = (async () => {
        if (getChannelEvents(channel).length) return;
        try {
          let valid = await readChatHistory(key);
          if (!valid.length) {
            const legacy = JSON.parse(localStorage.getItem(key) ?? "[]");
            if (Array.isArray(legacy)) valid = legacy;
          }
          valid = valid.filter(
            (e) =>
              e && typeof e.kind === "string" && typeof e.turn_id === "string",
          );
          const last = valid[valid.length - 1];
          if (
            last &&
            last.kind !== "result" &&
            !(
              last.kind === "content_block" &&
              (last.payload as any)?.type === "turn_cancelled"
            )
          )
            valid.push({
              kind: "result",
              success: false,
              duration_ms: 0,
              cost_usd: null,
              total_tokens: null,
              message:
                "Response interrupted when the app closed. You can continue this conversation.",
              turn_id: last.turn_id,
            });
          if (!getChannelEvents(channel).length)
            setResumedHistory(channel, valid);
        } catch {
          setError(
            "Saved history could not be loaded. Your agent's native history is still available in Terminal.",
          );
        }
      })();
    }
  }, [channel, key, tab.agentId, tab.repoRoot]);
  useEffect(() => {
    if (sessionId) store.bindAgentResumeSession(tab.sessionId, sessionId);
  }, [sessionId, tab.sessionId]);
  async function send(text: string, mode: ChatMode = "build") {
    if (busy.current || running)
      throw new Error("A response is already running.");
    busy.current = true;
    const turnId = `turn-${crypto.randomUUID()}`;
    try {
      await historyReady.current;
      await waitForAgentStream(channel);
      setError("");
      // Native IDs are per chat; never use a workspace-wide “latest” resume.
      const resume = getResumeSession(channel) ?? tab.resumeSessionId ?? null;
      await api.auraLogIntent(tab.repoRoot, text, tab.agentId, {
        files: [],
        source: "agent_prompt",
      });
      markTurnStarted(channel);
      pushEvent(channel, {
        kind: "user_prompt",
        text,
        turn_id: turnId,
        ts: Math.floor(Date.now() / 1000),
      });
      await api.agentStreamSend(
        tab.agentId,
        tab.repoRoot,
        promptForChatMode(text, mode),
        resume,
        undefined,
        mode === "plan" || mode === "ask" ? "plan" : undefined,
        undefined,
        undefined,
        { channel, clientTurnId: turnId, model: model.trim() || undefined },
      );
    } catch (e) {
      pushEvent(channel, {
        kind: "result",
        success: false,
        duration_ms: 0,
        cost_usd: null,
        total_tokens: null,
        message: String(e),
        turn_id: turnId,
      });
      throw e;
    } finally {
      busy.current = false;
    }
  }
  async function openTerminal() {
    if (running || busy.current) {
      setError("Stop the response before continuing this session in Terminal.");
      return;
    }
    try {
      const handle = await api.agentPtyOpen(
        tab.agentId,
        tab.repoRoot,
        100,
        30,
        getResumeSession(channel) ?? tab.resumeSessionId ?? undefined,
        true,
      );
      store.replaceAgent(tab.sessionId, {
        ...tab,
        sessionId: handle.id,
        mode: "pty",
        view: "terminal",
        dormant: false,
        resumeSessionId: getResumeSession(channel),
      });
    } catch (e) {
      setError(String(e));
    }
  }
  const lastPrompt = [...events]
    .reverse()
    .find((e) => e.kind === "user_prompt");
  const controls = (
    <>
      {storageError && (
        <div role="alert" className="chat-notice">
          {storageError}
        </div>
      )}
      {error && (
        <div role="alert" className="chat-notice">
          {error}
        </div>
      )}
      {prompts.map((p, i) => (
        <ChatPermission key={p.prompt_id} prompt={p} docked={i === prompts.length - 1} repoRoot={tab.repoRoot} />
      ))}

    </>
  );
  return (
    <NormalizedTranscript
      viewSwitcher={<ChatViewSwitcher value="chat" disabled={running} disabledTitle="Open the CLI once this turn finishes" onChange={view => { if (view === "terminal") void openTerminal(); }} />}
      channel={channel}
      agentId={tab.agentId}
      repoRoot={tab.repoRoot}
      ptySessionId={tab.sessionId}
      onSend={send}
      onStop={async () => {
        await api.agentStreamInterrupt(channel);
      }}
      controls={controls}
      composerDocked={prompts.length > 0}
      agentCommands={agentCommands}
      modelControl={<AgentTurnModelPicker agentId={tab.agentId} value={model} disabled={running} offered={offeredModels} onChange={value => { setModel(value); try { localStorage.setItem(`${key}.model`, value); } catch {} }} />}
      composerOptions={<>
        <DropdownMenuSeparator />
        {!running && lastPrompt?.kind === "user_prompt" && (
          <DropdownMenuItem
            onSelect={() =>
              void send(lastPrompt.text).catch((e) => setError(String(e)))
            }
          >
            <RotateCcw />
            Retry last message
          </DropdownMenuItem>
        )}
        <DropdownMenuItem disabled={running} onSelect={() => void openTerminal()}>
          <Terminal />
          Continue in Terminal
        </DropdownMenuItem>
      </>}
      onRespondInTerminal={() => void openTerminal()}
    />
  );
}

function ChatPermission({ prompt, docked, repoRoot }: { prompt: PermissionPrompt; docked: boolean; repoRoot: string }) {
  if (ACP_PROMPT_TOOLS.has(prompt.tool_name)) return <AcpPrompt prompt={prompt} docked={docked} repoRoot={repoRoot} />;
  type NativeQuestion = { question: string; header?: string; multiSelect?: boolean; options?: { label: string; description?: string }[] };
  const rawQuestions = (prompt.input as { questions?: unknown } | null)?.questions;
  const questions = Array.isArray(rawQuestions) && rawQuestions.every(q => q && typeof q.question === "string" && (q.options == null || (Array.isArray(q.options) && q.options.every((o: any) => o && typeof o.label === "string")))) ? rawQuestions as NativeQuestion[] : undefined;
  if (prompt.tool_name === "AskUserQuestion" && questions?.length) {
    return <div className="chat-controls"><QuestionFlow key={prompt.prompt_id} docked={docked} allowSkip={false}
      questions={questions.map((q, i) => ({ id: String(i), prompt: q.question, multiple: q.multiSelect, freeText: true, options: (q.options ?? []).map((o, n) => ({ id: String(n), label: o.label, description: o.description })) }))}
      onSubmit={async replies => {
        const answers = Object.fromEntries(questions.map((q, i) => [q.question, replies[i].text.trim() || replies[i].selected.map(id => q.options?.[Number(id)]?.label ?? "").join(", ")]));
        await decidePrompt(prompt.prompt_id, "allow", { ...(prompt.input as object), answers });
      }} /></div>;
  }
  return <ChatPermissionRequest key={prompt.prompt_id} prompt={prompt} docked={docked} />;
}

/** Any other permission, as the shared permission request: one answer per
 *  option the engine offered, the first allowing one leading. */
function ChatPermissionRequest({ prompt, docked }: { prompt: PermissionPrompt; docked: boolean }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const rawOptions = (prompt.input as { _acp_options?: unknown } | null)?._acp_options;
  const nativeOptions = Array.isArray(rawOptions) && rawOptions.every(o => o && typeof o.optionId === "string" && typeof o.name === "string" && typeof o.kind === "string") ? rawOptions as { optionId: string; name: string; kind: string }[] : undefined;
  const options = nativeOptions ?? [{ optionId: "deny", name: "Deny", kind: "reject_once" }, { optionId: "allow", name: "Allow once", kind: "allow_once" }];
  const lead = options.find(o => o.kind.startsWith("allow"))?.optionId;
  const choose = async (id: string) => {
    const option = options.find(o => o.optionId === id);
    if (!option || busy) return;
    setBusy(true);
    setError(null);
    try {
      await decidePrompt(prompt.prompt_id, option.kind.startsWith("allow") ? "allow" : "deny", nativeOptions ? { _acp_option_id: option.optionId } : undefined);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setBusy(false);
    }
  };
  return <div className="chat-controls">
    <PermissionRequest className={docked ? "chat-question-request is-docked" : undefined} title={prompt.tool_name} pending={busy}
      command={JSON.stringify(nativeOptions ? (prompt.input as any).action : prompt.input, null, 2)}
      choices={options.map(o => ({ id: o.optionId, label: o.name, primary: o.optionId === lead }))}
      onChoose={id => void choose(id)}>
      {error && <p role="alert" className="chat-question-error">{error}</p>}
    </PermissionRequest>
  </div>;
}
