import { ChatViewSwitcher } from "../chat/ChatHeader";
import { useEffect, useRef, useState } from "react";
import { ChatModelPicker, promptForChatMode, type ChatMode } from "../chat/ChatComposer";
import { QuestionFlow } from "../chat/QuestionFlow";
import { Terminal } from "lucide-react";
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
        <ChatPermission key={p.prompt_id} prompt={p} docked={i === prompts.length - 1} />
      ))}

    </>
  );
  return (
    <NormalizedTranscript
      viewSwitcher={<ChatViewSwitcher value="chat" disabled={running} onChange={view => { if (view === "terminal") void openTerminal(); }} />}
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
      modelControl={<ChatModelPicker value={model} disabled={running} onChange={value => { setModel(value); try { localStorage.setItem(`${key}.model`, value); } catch {} }} />}
      composerOptions={<>
        {!running && lastPrompt?.kind === "user_prompt" && (
          <button
            type="button"
            onClick={() =>
              void send(lastPrompt.text).catch((e) => setError(String(e)))
            }
          >
            Retry last message
          </button>
        )}
        <button
          type="button"
          disabled={running}
          onClick={() => void openTerminal()}
        >
          <Terminal size={13} />
          Continue in Terminal
        </button>
      </>}
      onRespondInTerminal={() => void openTerminal()}
    />
  );
}

function ChatPermission({ prompt, docked }: { prompt: PermissionPrompt; docked: boolean }) {
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
  const rawOptions = (prompt.input as { _acp_options?: unknown } | null)?._acp_options;
  const nativeOptions = Array.isArray(rawOptions) && rawOptions.every(o => o && typeof o.optionId === "string" && typeof o.name === "string" && typeof o.kind === "string") ? rawOptions as { optionId: string; name: string; kind: string }[] : undefined;
  const options = nativeOptions ?? [{ optionId: "deny", name: "Deny", kind: "reject_once" }, { optionId: "allow", name: "Allow once", kind: "allow_once" }];
  return <div className="chat-controls">
    <details className="px-3 py-2 text-xs text-text-3"><summary>Requested action</summary><pre className="max-h-48 overflow-auto whitespace-pre-wrap">{JSON.stringify(nativeOptions ? (prompt.input as any).action : prompt.input, null, 2)}</pre></details>
    <QuestionFlow key={prompt.prompt_id} docked={docked} title="Permission" allowSkip={false} submitLabel="Confirm"
      questions={[{ id: prompt.prompt_id, prompt: prompt.tool_name, options: options.map(o => ({ id: o.optionId, label: o.name })) }]}
      onSubmit={async answers => { const option = options.find(o => o.optionId === answers[0].selected[0]); if (!option) throw new Error("Select a permission option."); await decidePrompt(prompt.prompt_id, option.kind.startsWith("allow") ? "allow" : "deny", nativeOptions ? { _acp_option_id: option.optionId } : undefined); }} />
  </div>;
}
