// Picker rendered inside an empty split pane. Replaces the auto-spawn
// behaviour that used to make Split duplicate the source. Lists every
// open agent / terminal / manager / file across all workspaces so the
// user can drop any of them into the empty slot — including foreign-
// workspace tabs (a Claude from project A next to a Gemini from
// project B). Also offers a "spawn new" shortcut for the common case.

import { useEffect, useMemo, useRef, useState } from "react";
import { treeLeaves, useEditorStore } from "../lib/editorStore";
import type { WorkPaneRef } from "../lib/editorStore";
import { AgentIcon } from "./agent/AgentIcon";
import { api, type AgentProfile, type Lane, type OpenAiCompatProfile } from "../lib/api";
import { LaneSwitcher } from "./agent/LaneSwitcher";
import { Input } from "./ui/input";

type Props = {
  paneIndex: number;
  /** Current workspace root — used to label foreign tabs ("Project A"). */
  currentRepoRoot: string;
  onClosePane: () => void;
};

type Section = "all" | "agents" | "terminals" | "managers" | "files";

export function EmptyPanePicker({ paneIndex, currentRepoRoot, onClosePane }: Props) {
  const store = useEditorStore();
  const [section, setSection] = useState<Section>("all");
  const [filter, setFilter] = useState("");

  const candidates = useMemo(() => {
    const layoutRefs = store.splitLayout ? treeLeaves(store.splitLayout) : [];
    const inSplit = (ref: WorkPaneRef) =>
      layoutRefs.some((p) => {
        if (p.kind !== ref.kind) return false;
        if (p.kind === "file" && ref.kind === "file") return p.path === ref.path;
        if (p.kind !== "file" && ref.kind !== "file") return p.id === ref.id;
        return false;
      });

    type Row = {
      key: string;
      kind: "agent" | "terminal" | "manager" | "file";
      label: string;
      sub: string;
      foreign: boolean;
      ref: WorkPaneRef;
      iconAgent?: string;
    };
    const rows: Row[] = [];

    for (const t of store.agentTabs) {
      const ref: WorkPaneRef = { kind: "agent", id: t.sessionId };
      if (inSplit(ref)) continue;
      const foreign = t.repoRoot !== currentRepoRoot;
      rows.push({
        key: `a:${t.sessionId}`,
        kind: "agent",
        label: t.agentLabel,
        // Subtitle is the project this run lives in — NOT the raw session
        // hash. A vibecoder picking which open thing to add reads "myproject",
        // not "a1b2c3d4" (the key already keeps rows unique internally).
        sub: shortRoot(t.repoRoot),
        foreign,
        ref,
        iconAgent: t.agentId,
      });
    }
    for (const t of store.terminalTabs) {
      const ref: WorkPaneRef = { kind: "terminal", id: t.termId };
      if (inSplit(ref)) continue;
      const foreign = t.cwd !== currentRepoRoot;
      rows.push({
        key: `t:${t.termId}`,
        kind: "terminal",
        label: t.label ?? "Terminal",
        sub: shortRoot(t.cwd),
        foreign,
        ref,
      });
    }
    for (const t of store.managerTabs) {
      const ref: WorkPaneRef = { kind: "manager", id: t.sessionId };
      if (inSplit(ref)) continue;
      rows.push({
        key: `m:${t.sessionId}`,
        kind: "manager",
        label: t.label || "Manager",
        // A plain descriptor, never the raw session hash.
        sub: "Aura chat",
        foreign: false,
        ref,
        iconAgent: "aura-manager",
      });
    }
    for (const f of store.files) {
      const ref: WorkPaneRef = { kind: "file", path: f.path };
      if (inSplit(ref)) continue;
      rows.push({
        key: `f:${f.path}`,
        kind: "file",
        label: baseName(f.path),
        sub: dirName(f.path),
        foreign: false,
        ref,
      });
    }

    const q = filter.trim().toLowerCase();
    return rows.filter((r) => {
      if (section !== "all" && r.kind !== sectionToKind(section)) return false;
      if (!q) return true;
      return (
        r.label.toLowerCase().includes(q) ||
        r.sub.toLowerCase().includes(q)
      );
    });
  }, [
    store.agentTabs,
    store.terminalTabs,
    store.managerTabs,
    store.files,
    store.splitLayout,
    currentRepoRoot,
    section,
    filter,
  ]);

  function pick(ref: WorkPaneRef) {
    store.replaceSplitPaneAt(paneIndex, ref);
  }

  function spawnTerminal() {
    const id = store.openTerminal(currentRepoRoot, { label: "Terminal" });
    store.replaceSplitPaneAt(paneIndex, { kind: "terminal", id });
  }

  async function spawnAgent(agentId: string, label: string, profileName?: string) {
    try {
      const handle = await api.agentPtyOpen(
        agentId,
        currentRepoRoot,
        80,
        24,
        undefined,
        true,
        profileName,
      );
      const decoratedLabel = profileName ? `${label} · ${profileName}` : label;
      store.openAgent({
        sessionId: handle.id,
        agentId,
        agentLabel: decoratedLabel,
        agentMonogram: label.charAt(0).toUpperCase(),
        repoRoot: currentRepoRoot,
        mode: "pty",
      });
      store.replaceSplitPaneAt(paneIndex, { kind: "agent", id: handle.id });
    } catch (e) {
      console.warn("[empty-pane] spawn agent failed:", e);
    }
  }

  // openai-compat = HTTP chat-completions adapter (Ollama / HF / Together
  // / Groq / OpenRouter / vLLM). Each saved profile becomes its own
  // launch option. Unlike the PTY agents these don't spawn a process —
  // we mint a session id locally and open a chat tab against it.
  function spawnOpenAiCompat(profile: OpenAiCompatProfile) {
    // Synthesise a stable session id from (profile, repo) so re-opening
    // an existing tab focuses instead of opening a duplicate. Includes
    // a short random suffix on first open so two splits can hold the
    // same profile side-by-side if the user genuinely wants that.
    const sessionId = `oai-compat:${profile.name}:${currentRepoRoot}:${Math.random()
      .toString(36)
      .slice(2, 8)}`;
    store.openAgent({
      sessionId,
      agentId: "openai-compat",
      agentLabel: profile.name,
      agentMonogram: profile.name.charAt(0).toUpperCase(),
      repoRoot: currentRepoRoot,
      mode: "chat",
      openaiCompatProfile: profile.name,
    });
    store.replaceSplitPaneAt(paneIndex, { kind: "agent", id: sessionId });
  }

  // A lane is an isolated worktree with its own agent PTY (AURA-81). The
  // LaneSwitcher already created/focused the lane; we just drop its live
  // agent into this empty pane. Crucially the tab's repoRoot is the lane's
  // own worktree path, so the agent's stream channels + git status stay
  // scoped to the lane and never collide with the main checkout. A paused
  // lane (no live PTY) has nothing to open — the switcher shows its state.
  function openLaneAgent(lane: Lane) {
    if (!lane.termId) return;
    const label = lane.label || `${capitalize(lane.agent)} lane`;
    store.openAgent({
      sessionId: lane.termId,
      agentId: lane.agent,
      agentLabel: label,
      agentMonogram: label.charAt(0).toUpperCase(),
      repoRoot: lane.path,
      mode: "pty",
    });
    store.replaceSplitPaneAt(paneIndex, { kind: "agent", id: lane.termId });
  }

  return (
    <div className="h-full w-full flex flex-col bg-bg-content text-text-1">
      <div className="flex items-center gap-2 h-10 px-3 border-b border-line-soft bg-bg-chrome">
        <span className="text-text-3 text-[11px] uppercase tracking-wider">
          Empty Pane
        </span>
        <span className="text-text-5 text-[10.5px] font-mono">
          pick something to put here
        </span>
        <button
          type="button"
          onClick={onClosePane}
          className="ml-auto px-2 h-6 rounded text-[11px] text-text-3 hover:text-text-1 hover:bg-bg-2 transition-colors"
          title="Close this pane"
        >
          Close
        </button>
      </div>

      <div className="px-4 pt-4 pb-2 flex flex-col gap-3">
        <Input
          autoFocus
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
          placeholder="Filter open tabs across all workspaces…"
          className="h-9"
        />
        <div className="flex items-center gap-1.5 text-[11px]">
          {(["all", "agents", "terminals", "managers", "files"] as Section[]).map(
            (s) => (
              <button
                key={s}
                type="button"
                onClick={() => setSection(s)}
                className={`px-2 h-6 rounded transition-colors capitalize ${
                  section === s
                    ? "bg-bg-3 text-text-1"
                    : "text-text-3 hover:text-text-1 hover:bg-bg-2"
                }`}
              >
                {s}
              </button>
            ),
          )}
        </div>
      </div>

      <div className="flex-1 min-h-0 overflow-y-auto px-3 pb-3">
        {candidates.length === 0 ? (
          <div className="px-2 py-6 text-center text-text-4 text-[12px]">
            Nothing matches. Spawn a new agent or terminal below.
          </div>
        ) : (
          <ul className="flex flex-col gap-1">
            {candidates.map((row) => (
              <li key={row.key}>
                <button
                  type="button"
                  onClick={() => pick(row.ref)}
                  className="group w-full flex items-center gap-2.5 px-2 h-9 rounded hover:bg-bg-2 text-left transition-colors"
                >
                  <span className="w-5 h-5 flex items-center justify-center flex-shrink-0">
                    {row.iconAgent ? (
                      <AgentIcon agentId={row.iconAgent} size={14} />
                    ) : row.kind === "terminal" ? (
                      <TerminalGlyph />
                    ) : (
                      <FileGlyph />
                    )}
                  </span>
                  <span className="text-[12.5px] text-text-1 truncate">
                    {row.label}
                  </span>
                  <span className="text-[10.5px] text-text-5 font-mono truncate">
                    {row.sub}
                  </span>
                  {row.foreign && (
                    <span className="ml-auto text-[10px] uppercase tracking-wider text-text-4 px-1.5 py-0.5 rounded bg-bg-2 border border-line-soft">
                      foreign
                    </span>
                  )}
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>

      <div className="border-t border-line-soft px-4 py-3 flex items-center gap-2 flex-wrap">
        <span className="text-[11px] uppercase tracking-wider text-text-4 mr-1">
          Spawn new
        </span>
        <SpawnPill label="Claude" onClick={() => spawnAgent("claude", "Claude")} />
        <SpawnPill label="Gemini" onClick={() => spawnAgent("gemini", "Gemini")} />
        <SpawnPill label="Codex" onClick={() => spawnAgent("codex", "Codex")} />
        <SpawnPill label="Cursor" onClick={() => spawnAgent("cursor", "Cursor")} />
        <SpawnPill label="Terminal" onClick={spawnTerminal} />
        <LocalModelsSpawnMenu onSpawn={spawnOpenAiCompat} />
        <IsolatedSpawnMenu onSpawn={spawnAgent} />
        <LaneSpawnMenu repoRoot={currentRepoRoot} onFocusLane={openLaneAgent} />
      </div>
    </div>
  );
}

// Local & Custom Models launcher. Lists every openai-compat profile the
// user has wired up in Settings; clicking one opens a chat tab against
// that endpoint. Empty state nudges the user toward the Settings flow
// so they know where to add Ollama / HF / Together / etc.
function LocalModelsSpawnMenu({
  onSpawn,
}: {
  onSpawn: (profile: OpenAiCompatProfile) => void;
}) {
  const [open, setOpen] = useState(false);
  const [profiles, setProfiles] = useState<OpenAiCompatProfile[]>([]);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    void api
      .openaiCompatProfilesList()
      .then(setProfiles)
      .catch(() => setProfiles([]));
  }, [open]);

  useEffect(() => {
    if (!open) return;
    function onDoc(e: MouseEvent) {
      const t = e.target as Node | null;
      if (ref.current && t && !ref.current.contains(t)) setOpen(false);
    }
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") setOpen(false);
    }
    document.addEventListener("mousedown", onDoc);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDoc);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  return (
    <div className="relative" ref={ref}>
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="px-2.5 h-7 rounded text-[11.5px] font-medium text-text-2 bg-bg-2 hover:bg-bg-3 hover:text-text-1 border border-line-soft transition-colors flex items-center gap-1"
        title="Spawn a chat tab against an Ollama / HuggingFace / Together / Groq / OpenRouter / vLLM endpoint"
      >
        <span aria-hidden>▸</span>
        <span>Local model…</span>
      </button>
      {open && (
        <div
          className="absolute bottom-9 right-0 z-30 w-[280px] rounded-md py-2 shadow-lg"
          style={{
            background: "var(--color-bg-3)",
            border: "1px solid var(--color-line-soft)",
          }}
        >
          <div className="px-3 pb-2 text-[11px] text-text-3 uppercase tracking-wider">
            Profiles
          </div>
          {profiles.length === 0 ? (
            <div className="px-3 py-2 text-[11.5px] text-text-4">
              No openai-compat profiles yet. Open Settings →{" "}
              <span className="text-text-2">Local &amp; Custom Models</span> to
              add Ollama, HuggingFace, Together, Groq, OpenRouter, or any
              endpoint speaking <code>/v1/chat/completions</code>.
            </div>
          ) : (
            <div className="px-2 pb-2 flex flex-col gap-1 max-h-[260px] overflow-auto">
              {profiles.map((p) => (
                <button
                  key={p.name}
                  type="button"
                  onClick={() => {
                    onSpawn(p);
                    setOpen(false);
                  }}
                  className="w-full text-left px-2 py-1.5 rounded text-[12px] text-text-2 hover:bg-bg-2 hover:text-text-1"
                >
                  <div className="font-medium">{p.name}</div>
                  <div className="text-text-4 text-[10.5px] font-mono truncate">
                    {p.model} · {shortHost(p.base_url)}
                  </div>
                </button>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function shortHost(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
}

// Inline launcher for "Isolated session…" — picks an agent profile
// (named ~/.aura/agent-profiles/<name>/ HOME swap) then which agent CLI
// to spawn under it. New profiles are created inline so the user
// doesn't have to bounce to Settings just to add one.
function IsolatedSpawnMenu({
  onSpawn,
}: {
  onSpawn: (agentId: string, label: string, profileName?: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const [profiles, setProfiles] = useState<AgentProfile[]>([]);
  const [picked, setPicked] = useState<string | null>(null);
  const [newName, setNewName] = useState("");
  const [creating, setCreating] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    void api.agentProfileList().then((list) => {
      setProfiles(list);
      if (!picked && list.length > 0) setPicked(list[0].name);
    });
  }, [open, picked]);

  useEffect(() => {
    if (!open) return;
    function onDoc(e: MouseEvent) {
      const t = e.target as Node | null;
      if (ref.current && t && !ref.current.contains(t)) setOpen(false);
    }
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") setOpen(false);
    }
    document.addEventListener("mousedown", onDoc);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDoc);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  async function createProfile() {
    const name = newName.trim();
    if (!name || creating) return;
    setCreating(true);
    try {
      const p = await api.agentProfileCreate(name);
      setProfiles((prev) => [...prev.filter((x) => x.name !== p.name), p].sort((a, b) => a.name.localeCompare(b.name)));
      setPicked(p.name);
      setNewName("");
    } catch (e) {
      console.warn("[isolated] create profile failed:", e);
    } finally {
      setCreating(false);
    }
  }

  function launch(agentId: string, label: string) {
    if (!picked) return;
    onSpawn(agentId, label, picked);
    setOpen(false);
  }

  return (
    <div className="relative" ref={ref}>
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="px-2.5 h-7 rounded text-[11.5px] font-medium text-text-2 bg-bg-2 hover:bg-bg-3 hover:text-text-1 border border-line-soft transition-colors flex items-center gap-1"
        title="Spawn an agent with an isolated HOME — fresh login state per profile"
      >
        <span aria-hidden>↪</span>
        <span>Isolated…</span>
      </button>
      {open && (
        <div
          className="absolute bottom-9 right-0 z-30 w-[280px] rounded-md py-2 shadow-lg"
          style={{
            background: "var(--color-bg-3)",
            border: "1px solid var(--color-line-soft)",
          }}
        >
          <div className="px-3 pb-2 text-[11px] text-text-3 uppercase tracking-wider">
            Profile
          </div>
          <div className="px-2 pb-2 flex flex-col gap-1 max-h-[140px] overflow-auto">
            {profiles.length === 0 && (
              <div className="px-2 py-1 text-[11px] text-text-4">
                No profiles yet — create one below.
              </div>
            )}
            {profiles.map((p) => (
              <button
                key={p.name}
                type="button"
                onClick={() => setPicked(p.name)}
                className={`w-full text-left px-2 py-1 rounded text-[12px] flex items-center gap-2 ${
                  picked === p.name ? "bg-bg-2 text-text-1" : "text-text-2 hover:bg-bg-2"
                }`}
              >
                <span className="font-medium">{p.label ?? p.name}</span>
                <span className="text-text-4 text-[10.5px]">~/.aura/agent-profiles/{p.name}</span>
                {picked === p.name && (
                  <span className="ml-auto text-accent text-[12px]">✓</span>
                )}
              </button>
            ))}
          </div>
          <div className="px-2 pb-2 flex items-center gap-1.5">
            <Input
              value={newName}
              onChange={(e) => setNewName(e.target.value)}
              placeholder="new-profile-name"
              className="flex-1 h-7 text-[11.5px]"
              onKeyDown={(e) => {
                if (e.key === "Enter") void createProfile();
              }}
            />
            <button
              type="button"
              onClick={() => void createProfile()}
              disabled={!newName.trim() || creating}
              className="h-7 px-2 rounded text-[11.5px] bg-bg-2 hover:bg-bg-1 border border-line-soft text-text-1 disabled:opacity-50"
            >
              + Add
            </button>
          </div>
          <div className="border-t border-line-soft mx-2 mb-2" />
          <div className="px-3 pb-1 text-[11px] text-text-3 uppercase tracking-wider">
            Launch agent
          </div>
          <div className="px-2 pb-2 flex flex-wrap gap-1.5">
            {[
              ["claude", "Claude"],
              ["gemini", "Gemini"],
              ["codex", "Codex"],
              ["cursor", "Cursor"],
            ].map(([id, label]) => (
              <button
                key={id}
                type="button"
                disabled={!picked}
                onClick={() => launch(id, label)}
                className="px-2 h-7 rounded text-[11.5px] font-medium text-text-2 bg-bg-2 hover:bg-bg-1 hover:text-text-1 border border-line-soft transition-colors disabled:opacity-50"
                title={picked ? `Launch ${label} under profile ${picked}` : "Pick a profile first"}
              >
                {label}
              </button>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

// Lanes launcher (AURA-81) — sits beside "Isolated…" because it's the
// stronger form of the same idea: don't just isolate the agent's login
// state, give it a whole isolated copy of the project so two agents can
// run in parallel without ever overwriting each other. The dropdown hosts
// the self-contained LaneSwitcher; focusing/starting a lane drops its
// live agent into this pane via onFocusLane.
function LaneSpawnMenu({
  repoRoot,
  onFocusLane,
}: {
  repoRoot: string;
  onFocusLane: (lane: Lane) => void;
}) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    function onDoc(e: MouseEvent) {
      const t = e.target as Node | null;
      if (ref.current && t && !ref.current.contains(t)) setOpen(false);
    }
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") setOpen(false);
    }
    document.addEventListener("mousedown", onDoc);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDoc);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  return (
    <div className="relative" ref={ref}>
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="px-2.5 h-7 rounded text-[11.5px] font-medium text-text-2 bg-bg-2 hover:bg-bg-3 hover:text-text-1 border border-line-soft transition-colors flex items-center gap-1"
        title="Run another AI in its own isolated copy of the project — no copies to juggle, no branch switching"
      >
        <span aria-hidden>⊞</span>
        <span>New lane…</span>
      </button>
      {open && (
        <div className="absolute bottom-9 right-0 z-30">
          <LaneSwitcher
            repoRoot={repoRoot}
            onFocusLane={(lane) => {
              onFocusLane(lane);
              if (lane.termId) setOpen(false);
            }}
          />
        </div>
      )}
    </div>
  );
}

function capitalize(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}

function SpawnPill({ label, onClick }: { label: string; onClick: () => void }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="px-2.5 h-7 rounded text-[11.5px] font-medium text-text-2 bg-bg-2 hover:bg-bg-3 hover:text-text-1 border border-line-soft transition-colors"
    >
      {label}
    </button>
  );
}

function TerminalGlyph() {
  return (
    <svg width="13" height="13" viewBox="0 0 16 16" fill="none">
      <rect x="1.5" y="2.5" width="13" height="11" rx="1.5" stroke="currentColor" strokeWidth="1.2" />
      <path d="M4 6l2.5 2L4 10M8 10h4" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

function FileGlyph() {
  return (
    <svg width="13" height="13" viewBox="0 0 16 16" fill="none">
      <path d="M4 2.5h5l3 3V13a.5.5 0 0 1-.5.5h-7.5a.5.5 0 0 1-.5-.5V3a.5.5 0 0 1 .5-.5z" stroke="currentColor" strokeWidth="1.2" strokeLinejoin="round" />
      <path d="M9 2.5V6h3" stroke="currentColor" strokeWidth="1.2" strokeLinejoin="round" />
    </svg>
  );
}

function sectionToKind(s: Section): "agent" | "terminal" | "manager" | "file" {
  if (s === "agents") return "agent";
  if (s === "terminals") return "terminal";
  if (s === "managers") return "manager";
  return "file";
}

function shortRoot(root: string): string {
  const parts = root.split("/").filter(Boolean);
  if (parts.length <= 2) return root;
  return ".../" + parts.slice(-2).join("/");
}

function baseName(path: string): string {
  const i = path.lastIndexOf("/");
  return i === -1 ? path : path.slice(i + 1);
}

function dirName(path: string): string {
  const i = path.lastIndexOf("/");
  return i === -1 ? "" : path.slice(0, i);
}
