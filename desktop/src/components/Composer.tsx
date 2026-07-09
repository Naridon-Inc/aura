// Bottom-of-surface prompt. Three layers stacked:
//
//   1. Optional slash palette — dropdown that opens when the textarea
//      starts with `/`; ↑/↓ navigate, ↵ inserts the command, esc closes.
//   2. The input row — attach +, multi-line textarea, send arrow.
//   3. Footer chips — agent picker (popover with role + description),
//      auto-context toggle, policy chip, send-hint.
//
// The agent and command identities are surfaced up via onSend(text,
// {agent, command}) so the host can route to the correct MCP tool /
// transport without re-parsing the buffer.

import {
  useEffect,
  useRef,
  useState,
  type ClipboardEvent,
  type DragEvent,
  type KeyboardEvent,
} from "react";
import { useAgents, findAgent, type Agent } from "../lib/agents";
import { filterSlashWithExtras, type SlashCommand } from "../lib/slashCommands";
import {
  dispatchPluginSlash,
  parsePluginSlashTarget,
} from "../lib/pluginRuntime";
import {
  pluginSlashCommands,
  usePluginContributes,
} from "../lib/pluginContributesStore";
import {
  filterMcpMentions,
  mcpMentionItems,
  mcpSlashCommands,
  refreshMcpTools,
  useMcpTools,
  type McpMentionItem,
} from "../lib/mcpToolsStore";
import { api, type ImageAttachment, type SavedPrompt } from "../lib/api";
import { AgentIcon, brandFor } from "./agent/AgentIcon";
import { Input } from "./ui/input";

export type ComposerAttachment = ImageAttachment & {
  /** Stable id for keying the thumbnail strip + remove handler. */
  id: string;
  /** Source filename when the user picked from disk; "pasted-image.png" for clipboard. */
  name: string;
  /** Local-only object URL for the thumbnail. We revoke on remove/unmount. */
  preview_url: string;
};

export type ComposerSubmit = {
  text: string;
  /** First selected agent — kept for back-compat with single-agent flows. */
  agent: Agent;
  /** Every agent the user wants this prompt fanned out to. Length ≥ 1.
   *  `agents[0] === agent`. Single-agent submits keep length 1. */
  agents: Agent[];
  command: SlashCommand | null;
  /** Image attachments riding with this prompt — empty when text-only. */
  attachments: ComposerAttachment[];
  /** Optional one-line "what are you trying to do?" — host persists into
   *  block.intent so the BlockCard can render it under the prompt. */
  intent: string;
};

type ComposerProps = {
  placeholder?: string;
  onSend?: (payload: ComposerSubmit) => void;
  /** Short label shown in the location pill, e.g. workspace name. */
  location?: string;
};

export function Composer({
  placeholder = "Build anything",
  onSend,
  location,
}: ComposerProps) {
  const [text, setText] = useState("");
  const [intent, setIntent] = useState("");
  const [intentEditing, setIntentEditing] = useState(false);
  const { agents, loading: agentsLoading } = useAgents();
  const [agentId, setAgentId] = useState<string>("");
  // Fan-out: when on, the picker shows checkboxes and Send dispatches the
  // same prompt to every selected agent (each gets its own PTY tab in
  // WorkSurface). Off keeps the single-agent path unchanged.
  const [fanOut, setFanOut] = useState(false);
  const [fanOutSet, setFanOutSet] = useState<Set<string>>(new Set());
  const [paletteIdx, setPaletteIdx] = useState(0);
  const [agentPickerOpen, setAgentPickerOpen] = useState(false);
  const [attachments, setAttachments] = useState<ComposerAttachment[]>([]);
  const [dragOver, setDragOver] = useState(false);
  const [savedPrompts, setSavedPrompts] = useState<SavedPrompt[]>([]);
  const [savePromptOpen, setSavePromptOpen] = useState(false);
  const [savePromptName, setSavePromptName] = useState("");
  const [savePromptDesc, setSavePromptDesc] = useState("");
  const taRef = useRef<HTMLTextAreaElement>(null);
  const agentBtnRef = useRef<HTMLButtonElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  // Revoke any leftover object URLs on unmount so we don't leak blob refs.
  useEffect(() => {
    return () => {
      for (const a of attachments) URL.revokeObjectURL(a.preview_url);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function ingestFile(file: File) {
    if (!file.type.startsWith("image/")) return;
    // 20MB cap — Anthropic's hard limit is 5MB per image after base64,
    // but we're lenient here and let the API surface the rejection so
    // the user sees a real error rather than a silent drop.
    if (file.size > 20 * 1024 * 1024) return;
    const data = await fileToBase64(file);
    const id = `att-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
    setAttachments((prev) => [
      ...prev,
      {
        id,
        name: file.name || "image",
        media_type: file.type,
        data,
        preview_url: URL.createObjectURL(file),
      },
    ]);
  }

  function removeAttachment(id: string) {
    setAttachments((prev) => {
      const target = prev.find((a) => a.id === id);
      if (target) URL.revokeObjectURL(target.preview_url);
      return prev.filter((a) => a.id !== id);
    });
  }

  function onPaste(e: ClipboardEvent<HTMLTextAreaElement>) {
    const items = e.clipboardData?.items;
    if (!items) return;
    for (let i = 0; i < items.length; i++) {
      const it = items[i];
      if (it.kind === "file" && it.type.startsWith("image/")) {
        const f = it.getAsFile();
        if (f) {
          e.preventDefault();
          void ingestFile(f);
        }
      }
    }
  }

  function onDrop(e: DragEvent<HTMLDivElement>) {
    e.preventDefault();
    setDragOver(false);
    const files = e.dataTransfer?.files;
    if (!files) return;
    for (let i = 0; i < files.length; i++) {
      void ingestFile(files[i]);
    }
  }

  // Once discovery resolves, lock the picker to the first *available*
  // agent. If nothing's installed we leave agentId empty and the chip
  // renders an "install …" hint instead of a pickable label.
  useEffect(() => {
    if (agentId) return;
    const first = agents.find((a) => a.available) ?? agents[0];
    if (first) setAgentId(first.id);
  }, [agents, agentId]);

  // Flipping fan-out on for the first time seeds the selection with the
  // currently-active agent so Send works without a second click.
  useEffect(() => {
    if (!fanOut) return;
    if (fanOutSet.size > 0) return;
    if (agentId) setFanOutSet(new Set([agentId]));
  }, [fanOut, fanOutSet, agentId]);

  const agent = findAgent(agentId, agents);

  // Saved prompts — refetch when the active agent changes so per-agent
  // pinned prompts surface in the slash palette. Backend filters by
  // agent and ranks by usage; we just adapt to SlashCommand shape.
  useEffect(() => {
    let alive = true;
    api
      .promptsList(agentId || undefined)
      .then((rows) => {
        if (alive) setSavedPrompts(rows);
      })
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, [agentId]);

  const savedPromptEntries: SlashCommand[] = savedPrompts.map((p) => ({
    name: `/p:${p.name}`,
    description: p.description || "Saved prompt",
    kind: "prompt",
    target: p.id,
    agent: p.agent ?? undefined,
    expansion: p.body,
  }));

  // Plugin-contributed slash commands flow through the same extras pipe
  // — surfaced by /-menu autocomplete and the send-time dispatcher.
  const pluginContribs = usePluginContributes();
  const pluginSlashEntries = pluginSlashCommands(pluginContribs.rows);

  // MCP tool catalogs — same shape, fed from `~/.aura/mcp/<name>.json`
  // configs. Refresh once on mount so the slash list is populated;
  // Settings forces a re-read whenever the user mutates a server.
  const mcpStore = useMcpTools();
  useEffect(() => {
    if (mcpStore.loadedAt === null && !mcpStore.loading) {
      void refreshMcpTools();
    }
  }, [mcpStore.loadedAt, mcpStore.loading]);
  const mcpSlashEntries = mcpSlashCommands(mcpStore.perServer);
  const mcpMentions = mcpMentionItems(mcpStore.perServer);

  const extras: SlashCommand[] = [
    ...savedPromptEntries,
    ...pluginSlashEntries,
    ...mcpSlashEntries,
  ];

  const slashHits = text.startsWith("/") && !text.includes(" ")
    ? filterSlashWithExtras(text, agentId || undefined, extras)
    : [];
  const showSlash = slashHits.length > 0;

  // `@server:tool` mention picker. We re-scan on every keystroke; the
  // grammar is tight (sigil + token, no spaces) so this is cheap.
  const mentionState = activeMcpMention(text);
  const mentionHits = mentionState
    ? filterMcpMentions(mentionState.query, mcpMentions)
    : [];
  const showMention = mentionState !== null && mentionHits.length > 0;
  const [mentionIdx, setMentionIdx] = useState(0);
  useEffect(() => {
    if (mentionIdx >= mentionHits.length) setMentionIdx(0);
  }, [mentionHits.length, mentionIdx]);

  // Keep the highlighted slash entry in range as the list shrinks.
  useEffect(() => {
    if (paletteIdx >= slashHits.length) setPaletteIdx(0);
  }, [slashHits.length, paletteIdx]);

  function autoresize() {
    const ta = taRef.current;
    if (!ta) return;
    ta.style.height = "auto";
    ta.style.height = Math.min(ta.scrollHeight, 240) + "px";
  }

  function send() {
    const trimmed = text.trim();
    if (!trimmed && attachments.length === 0) return;
    if (!agent) return;
    // Detect a leading slash command by token, e.g. "/plan refactor X"
    let command: SlashCommand | null = null;
    if (trimmed.startsWith("/")) {
      const head = trimmed.split(/\s+/)[0].toLowerCase();
      command = filterSlashWithExtras(head, agentId || undefined, extras).find((c) => c.name === head) ?? null;
    }
    // Plugin slash commands route through the bridge to the owning
    // plugin's sandboxes (`aura.ui.slash` event) — never to an agent.
    if (command?.target) {
      const pluginTarget = parsePluginSlashTarget(command.target);
      if (pluginTarget) {
        const delivered = dispatchPluginSlash(
          pluginTarget.pluginId,
          pluginTarget.commandId,
          trimmed,
        );
        if (!delivered) {
          window.dispatchEvent(
            new CustomEvent("aura:plugin-toast", {
              detail: {
                pluginId: pluginTarget.pluginId,
                message: `${command.name}: plugin is not running`,
                kind: "warn",
              },
            }),
          );
        }
        setText("");
        setAttachments([]);
        if (taRef.current) taRef.current.style.height = "auto";
        return;
      }
    }
    // Fan-out path: ship every selected (and available) agent. We always
    // put `agent` first so call sites that read .agent get a sensible
    // default. Slash commands ignore fan-out — they're single-shot by
    // construction.
    let dispatch: Agent[] = [agent];
    if (fanOut && command === null) {
      const picked = Array.from(fanOutSet)
        .map((id) => findAgent(id, agents))
        .filter((a): a is Agent => !!a && a.available);
      if (picked.length > 0) {
        // De-dupe + ensure the active agent is first if it's in the set.
        const seen = new Set<string>();
        const ordered: Agent[] = [];
        const head = picked.find((a) => a.id === agent.id) ?? picked[0];
        ordered.push(head);
        seen.add(head.id);
        for (const a of picked) {
          if (!seen.has(a.id)) {
            ordered.push(a);
            seen.add(a.id);
          }
        }
        dispatch = ordered;
      }
    }
    onSend?.({
      text: trimmed,
      agent: dispatch[0],
      agents: dispatch,
      command,
      attachments,
      intent: intent.trim(),
    });
    setText("");
    setAttachments([]);
    if (taRef.current) taRef.current.style.height = "auto";
  }

  function applySlashAt(idx: number) {
    const c = slashHits[idx];
    if (!c) return;
    if (c.kind === "prompt") {
      // Saved prompt: drop the body straight into the textarea so the
      // user can edit before sending. Bump usage so the picker promotes
      // it next time.
      setText(c.expansion ?? "");
      setPaletteIdx(0);
      api.promptsRecordUse(c.target).catch(() => {});
      requestAnimationFrame(() => {
        taRef.current?.focus();
        autoresize();
      });
      return;
    }
    setText(c.name + " ");
    setPaletteIdx(0);
    requestAnimationFrame(() => {
      taRef.current?.focus();
      autoresize();
    });
  }

  function applyMentionAt(idx: number) {
    const item = mentionHits[idx];
    if (!item || !mentionState) return;
    // Replace the @<query> token with the full `@server:tool ` form.
    const before = text.slice(0, mentionState.start);
    const after = text.slice(mentionState.end);
    const inserted = `@${item.label} `;
    const next = before + inserted + after;
    setText(next);
    setMentionIdx(0);
    const newCaret = mentionState.start + inserted.length;
    requestAnimationFrame(() => {
      const ta = taRef.current;
      if (ta) {
        ta.focus();
        ta.setSelectionRange(newCaret, newCaret);
      }
      autoresize();
    });
  }

  async function saveCurrentAsPrompt() {
    const body = text.trim();
    const name = savePromptName.trim();
    if (!body || !name) return;
    try {
      const saved = await api.promptsSave({
        name,
        description: savePromptDesc.trim() || undefined,
        body,
        agent: agentId || undefined,
      });
      setSavedPrompts((prev) => {
        const without = prev.filter((p) => p.id !== saved.id);
        return [saved, ...without];
      });
      setSavePromptOpen(false);
      setSavePromptName("");
      setSavePromptDesc("");
    } catch {
      // Backend already validates name/body; failure is ignored to keep
      // the popover behaviour predictable for the user.
    }
  }

  function onKey(e: KeyboardEvent<HTMLTextAreaElement>) {
    if (showMention) {
      if (e.key === "ArrowDown") {
        e.preventDefault();
        setMentionIdx((i) => Math.min(mentionHits.length - 1, i + 1));
        return;
      }
      if (e.key === "ArrowUp") {
        e.preventDefault();
        setMentionIdx((i) => Math.max(0, i - 1));
        return;
      }
      if (e.key === "Enter" || e.key === "Tab") {
        e.preventDefault();
        applyMentionAt(mentionIdx);
        return;
      }
      if (e.key === "Escape") {
        e.preventDefault();
        // Bail by stepping the caret past the @ token; keep buffer intact.
        const ta = taRef.current;
        if (ta && mentionState) ta.setSelectionRange(text.length, text.length);
        return;
      }
    }
    if (showSlash) {
      if (e.key === "ArrowDown") {
        e.preventDefault();
        setPaletteIdx((i) => Math.min(slashHits.length - 1, i + 1));
        return;
      }
      if (e.key === "ArrowUp") {
        e.preventDefault();
        setPaletteIdx((i) => Math.max(0, i - 1));
        return;
      }
      if (e.key === "Enter" && !e.shiftKey) {
        e.preventDefault();
        applySlashAt(paletteIdx);
        return;
      }
      if (e.key === "Escape") {
        e.preventDefault();
        setText("");
        return;
      }
    }
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      send();
    }
  }

  return (
    <div className="w-full flex justify-center px-6 py-3">
      <div className="w-full relative" style={{ maxWidth: 1100 }}>
        {showMention && (
          <McpMentionPalette
            hits={mentionHits}
            activeIdx={mentionIdx}
            onPick={applyMentionAt}
            onHover={(i) => setMentionIdx(i)}
          />
        )}
        {showSlash && !showMention && (
          <SlashPalette
            hits={slashHits}
            activeIdx={paletteIdx}
            onPick={applySlashAt}
            onHover={(i) => setPaletteIdx(i)}
          />
        )}

        <div
          className={`bg-bg-1 border rounded-lg flex flex-col gap-2 px-3 py-2.5 transition-colors ${
            dragOver
              ? "border-text-2 ring-1 ring-text-2/40"
              : "border-line focus-within:border-text-4"
          }`}
          onDragOver={(e) => {
            if (e.dataTransfer.types.includes("Files")) {
              e.preventDefault();
              setDragOver(true);
            }
          }}
          onDragLeave={() => setDragOver(false)}
          onDrop={onDrop}
        >
          <IntentChip
            value={intent}
            editing={intentEditing}
            onChange={setIntent}
            onEdit={() => setIntentEditing(true)}
            onCommit={() => setIntentEditing(false)}
          />

          {attachments.length > 0 && (
            <div className="flex flex-wrap gap-2 px-1 pt-1">
              {attachments.map((a) => (
                <AttachmentThumb
                  key={a.id}
                  attachment={a}
                  onRemove={() => removeAttachment(a.id)}
                />
              ))}
            </div>
          )}

          <input
            ref={fileInputRef}
            type="file"
            accept="image/png,image/jpeg,image/gif,image/webp"
            multiple
            hidden
            onChange={(e) => {
              const files = e.target.files;
              if (files) {
                for (let i = 0; i < files.length; i++) void ingestFile(files[i]);
              }
              // Reset so picking the same file twice still fires onChange.
              e.target.value = "";
            }}
          />

          <textarea
            ref={taRef}
            value={text}
            placeholder={placeholder}
            rows={1}
            wrap="soft"
            onChange={(e) => {
              setText(e.target.value);
              autoresize();
            }}
            onKeyDown={onKey}
            onPaste={onPaste}
            className="w-full min-w-0 bg-transparent resize-none outline-none text-text-1 text-[13.5px] px-1 py-1.5 leading-relaxed placeholder:text-text-4"
            style={{
              maxHeight: 240,
              overflowX: "hidden",
              overflowWrap: "anywhere",
              wordBreak: "break-word",
              whiteSpace: "pre-wrap",
            }}
          />

          <div className="relative">
            <ShortcutPills
              location={location}
              agentBtnRef={agentBtnRef}
              agent={agent}
              agents={agents}
              agentsLoading={agentsLoading}
              fanOut={fanOut}
              fanOutSet={fanOutSet}
              onAgentToggle={() => agents.length > 0 && setAgentPickerOpen((v) => !v)}
              onAttach={() => fileInputRef.current?.click()}
              onSend={send}
              sendEnabled={!!text.trim() || attachments.length > 0}
              onSavePrompt={() => setSavePromptOpen(true)}
              savePromptEnabled={!!text.trim()}
            />
            {savePromptOpen && (
              <SavePromptPopover
                name={savePromptName}
                description={savePromptDesc}
                onName={setSavePromptName}
                onDescription={setSavePromptDesc}
                onCancel={() => setSavePromptOpen(false)}
                onSave={() => void saveCurrentAsPrompt()}
                pinnedAgent={agent?.label}
              />
            )}
            {agentPickerOpen && (
              <AgentPicker
                agents={agents}
                activeId={agentId}
                fanOut={fanOut}
                fanOutSet={fanOutSet}
                onToggleFanOut={() => setFanOut((v) => !v)}
                onToggleAgent={(id) => {
                  setFanOutSet((prev) => {
                    const next = new Set(prev);
                    if (next.has(id)) next.delete(id);
                    else next.add(id);
                    return next;
                  });
                }}
                onPick={(id) => {
                  setAgentId(id);
                  setAgentPickerOpen(false);
                }}
                onDismiss={() => setAgentPickerOpen(false)}
              />
            )}
          </div>
        </div>

        <div className="flex items-center justify-end gap-2 mt-1.5 px-1 text-[10.5px] text-text-5">
          ↵ send {fanOut ? `→ ${Math.max(1, fanOutSet.size)} agents` : ""} · ⇧↵ newline
        </div>
      </div>
    </div>
  );
}

// Compact "what are you trying to do?" affordance above the textarea.
// Collapsed: a chip-sized button. Filled or editing: an inline input.
// On commit, the value rides into the next ComposerSubmit so the host
// can persist it into block.intent.
function IntentChip({
  value,
  editing,
  onChange,
  onEdit,
  onCommit,
}: {
  value: string;
  editing: boolean;
  onChange: (v: string) => void;
  onEdit: () => void;
  onCommit: () => void;
}) {
  const inputRef = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (editing) inputRef.current?.focus();
  }, [editing]);
  const filled = value.trim().length > 0;
  const expanded = editing || filled;
  return (
    <div className="px-1 pt-0.5 flex items-center">
      <span
        className="inline-block w-1.5 h-1.5 rounded-full mr-2 flex-shrink-0"
        style={{
          background: filled ? "var(--color-accent-green)" : "var(--color-text-5)",
        }}
      />
      {expanded ? (
        <input
          ref={inputRef}
          value={value}
          onChange={(e) => onChange(e.target.value)}
          onBlur={onCommit}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.preventDefault();
              onCommit();
            } else if (e.key === "Escape") {
              e.preventDefault();
              onChange("");
              onCommit();
            }
          }}
          placeholder="What are you trying to do?"
          className="flex-1 bg-transparent outline-none text-text-2 text-[11.5px] placeholder:text-text-4"
        />
      ) : (
        <button
          type="button"
          onClick={onEdit}
          className="text-[11.5px] text-text-4 hover:text-text-2 transition-colors"
        >
          What are you trying to do?
        </button>
      )}
    </div>
  );
}

// Five shortcut pills at the foot of the composer:
//   location · model (agent picker) · attach · save-prompt · send
// Each sits on --color-pill-bg with --color-composer-border, matching
// the aura-term composer footer.
function ShortcutPills({
  location,
  agentBtnRef,
  agent,
  agents,
  agentsLoading,
  fanOut,
  fanOutSet,
  onAgentToggle,
  onAttach,
  onSend,
  sendEnabled,
  onSavePrompt,
  savePromptEnabled,
}: {
  location?: string;
  agentBtnRef: React.RefObject<HTMLButtonElement | null>;
  agent: Agent | null | undefined;
  agents: Agent[];
  agentsLoading: boolean;
  fanOut: boolean;
  fanOutSet: Set<string>;
  onAgentToggle: () => void;
  onAttach: () => void;
  onSend: () => void;
  sendEnabled: boolean;
  onSavePrompt: () => void;
  savePromptEnabled: boolean;
}) {
  const brand = agent && !fanOut ? brandFor(agent.id) : null;
  const modelStyle: React.CSSProperties | undefined = brand
    ? { background: brand.bg, color: brand.fg, borderColor: brand.ring }
    : undefined;
  return (
    <div className="flex items-center gap-1.5 px-1 pt-1.5">
      <PillButton title={location || "no project"} disabled={!location}>
        <svg width="11" height="11" viewBox="0 0 16 16" fill="none">
          <path
            d="M3 6l5-3 5 3v6l-5 3-5-3V6z"
            stroke="currentColor"
            strokeWidth="1.4"
            strokeLinejoin="round"
          />
        </svg>
        <span className="truncate max-w-[140px]">{location || "no project"}</span>
      </PillButton>

      <button
        ref={agentBtnRef}
        type="button"
        onClick={onAgentToggle}
        title={
          fanOut
            ? `Fan-out to ${fanOutSet.size} agent${fanOutSet.size === 1 ? "" : "s"}`
            : agent?.description
        }
        className="inline-flex items-center gap-1.5 px-2 h-6 rounded-md text-[11px] transition-colors hover:opacity-90"
        style={{
          background: modelStyle?.background ?? "var(--color-pill-bg)",
          color: modelStyle?.color ?? "var(--color-text-2)",
          border: `1px solid ${modelStyle?.borderColor ?? "var(--color-composer-border)"}`,
        }}
      >
        {fanOut && fanOutSet.size > 0 ? (
          <>
            <FanOutIcons agents={agents} ids={fanOutSet} />
            <span>{fanOutSet.size} agents</span>
            <span className="text-text-5">▾</span>
          </>
        ) : agent ? (
          <>
            <AgentIcon agentId={agent.id} label={agent.label} active size={14} />
            <span>{agent.label}</span>
            <span style={{ opacity: 0.55 }}>▾</span>
          </>
        ) : agentsLoading ? (
          <span>discovering…</span>
        ) : (
          <span>install agent</span>
        )}
      </button>

      <PillButton title="Attach image (or paste / drag)" onClick={onAttach}>
        <svg width="11" height="11" viewBox="0 0 16 16" fill="none">
          <line x1="8" y1="3" x2="8" y2="13" stroke="currentColor" strokeWidth="1.4" />
          <line x1="3" y1="8" x2="13" y2="8" stroke="currentColor" strokeWidth="1.4" />
        </svg>
      </PillButton>

      <PillButton
        title="Save current text as a reusable prompt (/p:name)"
        onClick={onSavePrompt}
        disabled={!savePromptEnabled}
        className="ml-auto"
      >
        <svg width="11" height="11" viewBox="0 0 16 16" fill="none">
          <path
            d="M4 2h8v12l-4-3-4 3V2z"
            stroke="currentColor"
            strokeWidth="1.4"
            strokeLinejoin="round"
            fill="none"
          />
        </svg>
      </PillButton>

      <button
        type="button"
        onClick={onSend}
        disabled={!sendEnabled}
        title="Send (↵)"
        className="inline-flex items-center justify-center w-7 h-6 rounded-md transition-colors bg-text-1 text-bg-deep disabled:bg-bg-hover disabled:text-text-4"
      >
        <svg width="12" height="12" viewBox="0 0 16 16" fill="none">
          <path
            d="M8 13V3M4 7l4-4 4 4"
            stroke="currentColor"
            strokeWidth="1.6"
            fill="none"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        </svg>
      </button>
    </div>
  );
}

function PillButton({
  children,
  title,
  onClick,
  disabled,
  className,
}: {
  children: React.ReactNode;
  title?: string;
  onClick?: () => void;
  disabled?: boolean;
  className?: string;
}) {
  return (
    <button
      type="button"
      title={title}
      onClick={onClick}
      disabled={disabled}
      className={`inline-flex items-center gap-1.5 h-6 px-2 rounded-md text-[11px] text-text-3 hover:text-text-1 transition-colors disabled:opacity-50 disabled:cursor-not-allowed ${className ?? ""}`}
      style={{
        background: "var(--color-pill-bg)",
        border: "1px solid var(--color-composer-border)",
      }}
    >
      {children}
    </button>
  );
}

function SavePromptPopover({
  name,
  description,
  onName,
  onDescription,
  onCancel,
  onSave,
  pinnedAgent,
}: {
  name: string;
  description: string;
  onName: (v: string) => void;
  onDescription: (v: string) => void;
  onCancel: () => void;
  onSave: () => void;
  pinnedAgent?: string;
}) {
  return (
    <div
      className="absolute left-2 right-2 bottom-full mb-2 bg-bg-2 border border-line rounded-lg shadow-lg p-3 flex flex-col gap-2"
      role="dialog"
      aria-label="Save prompt"
    >
      <div className="flex items-center justify-between">
        <div className="text-[11px] uppercase tracking-wider text-text-4">
          Save prompt
          {pinnedAgent ? (
            <span className="ml-2 text-text-5 normal-case">pinned to {pinnedAgent}</span>
          ) : null}
        </div>
        <button
          type="button"
          onClick={onCancel}
          className="text-text-5 hover:text-text-2 text-[11px]"
          title="Cancel (esc)"
        >
          ✕
        </button>
      </div>
      <Input
        autoFocus
        value={name}
        onChange={(e) => onName(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Escape") onCancel();
          if (e.key === "Enter" && name.trim()) onSave();
        }}
        placeholder="name (used as /p:name)"
        className="text-[12px]"
      />
      <Input
        value={description}
        onChange={(e) => onDescription(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Escape") onCancel();
          if (e.key === "Enter" && name.trim()) onSave();
        }}
        placeholder="optional one-line description"
        className="text-[11.5px]"
      />
      <div className="flex justify-end gap-2 mt-1">
        <button
          type="button"
          onClick={onCancel}
          className="px-2 py-1 rounded-md text-[11px] text-text-3 hover:text-text-1"
        >
          Cancel
        </button>
        <button
          type="button"
          onClick={onSave}
          disabled={!name.trim()}
          className="px-2 py-1 rounded-md text-[11px] bg-text-1 text-bg-deep disabled:bg-bg-hover disabled:text-text-4"
        >
          Save
        </button>
      </div>
    </div>
  );
}

function SlashPalette({
  hits,
  activeIdx,
  onPick,
  onHover,
}: {
  hits: SlashCommand[];
  activeIdx: number;
  onPick: (i: number) => void;
  onHover: (i: number) => void;
}) {
  return (
    <div className="absolute left-0 right-0 bottom-full mb-2 bg-bg-2 border border-line rounded-lg shadow-lg overflow-hidden">
      <div className="px-3 py-1.5 text-[10.5px] uppercase tracking-wider text-text-4 border-b border-line-soft">
        Slash commands
      </div>
      <ul className="max-h-72 overflow-y-auto py-1">
        {hits.map((c, i) => (
          <li
            key={c.name}
            onMouseDown={(e) => {
              e.preventDefault();
              onPick(i);
            }}
            onMouseEnter={() => onHover(i)}
            className={`flex items-center gap-3 px-3 py-1.5 cursor-pointer text-[12.5px] ${
              i === activeIdx
                ? "bg-bg-card text-text-1"
                : "text-text-2 hover:bg-bg-hover"
            }`}
          >
            <span className="font-mono text-text-1" style={{ minWidth: 88 }}>
              {c.name}
            </span>
            <span className="text-text-3 truncate">{c.description}</span>
            <span className="ml-auto text-[10px] text-text-5 uppercase">
              {c.kind}
            </span>
          </li>
        ))}
      </ul>
    </div>
  );
}

function AgentPicker({
  agents,
  activeId,
  fanOut,
  fanOutSet,
  onToggleFanOut,
  onToggleAgent,
  onPick,
  onDismiss,
}: {
  agents: Agent[];
  activeId: string;
  fanOut: boolean;
  fanOutSet: Set<string>;
  onToggleFanOut: () => void;
  onToggleAgent: (id: string) => void;
  onPick: (id: string) => void;
  onDismiss: () => void;
}) {
  // Click-outside dismiss without a listener library — one capture-phase
  // mousedown on window is enough for this pop.
  useEffect(() => {
    function handler() {
      onDismiss();
    }
    // Defer registration so the click that opened us doesn't immediately
    // dismiss it.
    const t = setTimeout(() => {
      window.addEventListener("mousedown", handler);
    }, 0);
    return () => {
      clearTimeout(t);
      window.removeEventListener("mousedown", handler);
    };
  }, [onDismiss]);

  return (
    <div
      className="absolute left-0 bottom-full mb-1 bg-bg-2 border border-line rounded-lg shadow-lg overflow-hidden z-10"
      style={{ minWidth: 260 }}
      onMouseDown={(e) => e.stopPropagation()}
    >
      <button
        type="button"
        onClick={onToggleFanOut}
        className="w-full flex items-center gap-2 px-3 py-2 text-[11px] uppercase tracking-wider border-b border-line-soft bg-bg-1 hover:bg-bg-hover text-text-3"
      >
        <span
          className={`w-3 h-3 rounded-sm border ${
            fanOut ? "bg-accent border-accent" : "border-line"
          } flex-shrink-0`}
        />
        <span>Fan out — same prompt to many</span>
      </button>
      {agents.map((a) => {
        const checked = fanOutSet.has(a.id);
        const isActive = a.id === activeId;
        const brand = brandFor(a.id);
        // Selected row gets a brand-tinted background + a 2px brand bar
        // on the leading edge so the active agent is unmistakable.
        const rowStyle: React.CSSProperties =
          isActive && !fanOut
            ? {
                background: brand.bg,
                boxShadow: `inset 2px 0 0 0 ${brand.fg}`,
              }
            : {};
        return (
          <button
            key={a.id}
            type="button"
            onClick={() => {
              if (!a.available) return;
              if (fanOut) onToggleAgent(a.id);
              else onPick(a.id);
            }}
            disabled={!a.available}
            style={rowStyle}
            className={`w-full flex items-center gap-2.5 px-3 py-2 text-left text-[12px] ${
              isActive && !fanOut
                ? "text-text-1"
                : a.available
                  ? "text-text-2 hover:bg-bg-hover"
                  : "text-text-5 cursor-not-allowed"
            }`}
          >
            {fanOut && (
              <span
                className="w-3 h-3 rounded-sm border flex-shrink-0"
                style={
                  checked
                    ? { background: brand.fg, borderColor: brand.fg }
                    : { borderColor: "var(--color-line)" }
                }
              />
            )}
            <AgentIcon
              agentId={a.id}
              label={a.label}
              size={18}
              active={isActive && !fanOut}
            />
            <span className="flex flex-col">
              <span
                className={a.available ? "text-text-1" : "text-text-4"}
                style={isActive && !fanOut ? { color: brand.fg } : undefined}
              >
                {a.label}
              </span>
              <span className="text-text-4 text-[10.5px]">{a.description}</span>
            </span>
          </button>
        );
      })}
    </div>
  );
}

// Stacked brand icons shown on the chip when fan-out is on.
function FanOutIcons({ agents, ids }: { agents: Agent[]; ids: Set<string> }) {
  const picked = agents.filter((a) => ids.has(a.id)).slice(0, 3);
  return (
    <span className="inline-flex">
      {picked.map((a, i) => (
        <span
          key={a.id}
          style={{
            marginLeft: i === 0 ? 0 : -4,
            border: "1px solid var(--color-bg-1)",
            borderRadius: 4,
          }}
        >
          <AgentIcon agentId={a.id} label={a.label} size={16} />
        </span>
      ))}
    </span>
  );
}

function AttachmentThumb({
  attachment,
  onRemove,
}: {
  attachment: ComposerAttachment;
  onRemove: () => void;
}) {
  return (
    <div
      className="relative group w-14 h-14 rounded border border-line-soft overflow-hidden bg-bg-0"
      title={`${attachment.name} · ${attachment.media_type}`}
    >
      <img
        src={attachment.preview_url}
        alt={attachment.name}
        className="w-full h-full object-cover"
      />
      <button
        type="button"
        onClick={onRemove}
        title="Remove"
        className="absolute top-0.5 right-0.5 w-4 h-4 rounded-full bg-bg-deep/80 text-text-1 text-[10px] leading-none flex items-center justify-center opacity-0 group-hover:opacity-100 transition-opacity"
      >
        ×
      </button>
    </div>
  );
}

// Locate the active `@server:tool` mention token in the buffer based
// on caret-agnostic heuristics: we scan back from the end of the
// buffer to the most recent `@`, return the slice if it's separated
// from preceding text by whitespace (so emails don't trigger).
//
// The grammar is permissive — alnum + `-` + `_` + `:` — which matches
// every published MCP server's tool ids we've seen. Spaces close the
// token, mirroring how the slash palette dismisses on the first space.
type McpMentionState = {
  /** Index in the buffer of the `@` sigil. */
  start: number;
  /** Index one-past the last character of the token (caret falls here). */
  end: number;
  /** Token text without the leading `@`. */
  query: string;
};

function activeMcpMention(text: string): McpMentionState | null {
  if (!text.length) return null;
  // Find the last unescaped `@` preceded by start-of-buffer or whitespace.
  let at = -1;
  for (let i = text.length - 1; i >= 0; i--) {
    const ch = text[i];
    if (ch === "@") {
      const prev = i === 0 ? " " : text[i - 1];
      if (/\s/.test(prev)) {
        at = i;
        break;
      }
    }
    if (ch === " " || ch === "\n" || ch === "\t") {
      // Token closed before any `@` we'd anchor to.
      return null;
    }
  }
  if (at < 0) return null;
  // Validate the trailing token. Allow empty (`@` alone) so the picker
  // opens on the very first keystroke.
  const tail = text.slice(at + 1);
  if (!/^[A-Za-z0-9_\-:]*$/.test(tail)) return null;
  return { start: at, end: text.length, query: tail };
}

// MCP @-mention popover. Same visual rhythm as the slash palette so
// the two surfaces feel like the same affordance with a different
// sigil. Renders only when a token + at least one match exists.
function McpMentionPalette({
  hits,
  activeIdx,
  onPick,
  onHover,
}: {
  hits: McpMentionItem[];
  activeIdx: number;
  onPick: (i: number) => void;
  onHover: (i: number) => void;
}) {
  return (
    <div className="absolute left-0 right-0 bottom-full mb-2 bg-bg-2 border border-line rounded-lg shadow-lg overflow-hidden">
      <div className="px-3 py-1.5 text-[10.5px] uppercase tracking-wider text-text-4 border-b border-line-soft">
        MCP tools
      </div>
      <ul className="max-h-72 overflow-y-auto py-1">
        {hits.map((c, i) => (
          <li
            key={c.label}
            onMouseDown={(e) => {
              e.preventDefault();
              onPick(i);
            }}
            onMouseEnter={() => onHover(i)}
            className={`flex items-center gap-3 px-3 py-1.5 cursor-pointer text-[12.5px] ${
              i === activeIdx
                ? "bg-bg-card text-text-1"
                : "text-text-2 hover:bg-bg-hover"
            }`}
          >
            <span className="font-mono text-text-1 truncate" style={{ minWidth: 180 }}>
              @{c.label}
            </span>
            <span className="text-text-3 truncate">{c.description}</span>
            <span className="ml-auto text-[10px] text-text-5 uppercase">
              mcp
            </span>
          </li>
        ))}
      </ul>
    </div>
  );
}

// Read a File as base64 with the data: prefix stripped — the Anthropic
// content-block shape wants raw base64 in the `data` field.
function fileToBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const result = reader.result;
      if (typeof result !== "string") {
        reject(new Error("readAsDataURL returned non-string"));
        return;
      }
      const comma = result.indexOf(",");
      resolve(comma >= 0 ? result.slice(comma + 1) : result);
    };
    reader.onerror = () => reject(reader.error ?? new Error("read failed"));
    reader.readAsDataURL(file);
  });
}

