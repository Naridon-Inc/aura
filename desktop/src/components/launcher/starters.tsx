// The four controls that sit around the launcher's "start something new" list:
// which project a new tab opens in, and the three ways of starting an agent
// that need a choice made first (a local endpoint, an isolated login, a lane).
//
// They lived inside EmptyPanePicker, which meant the "+" picker on a tab strip
// — the other half of the same question — simply didn't have them. Moving them
// here is what lets one launcher serve both.

import { useEffect, useMemo, useRef, useState } from "react";

import {
  api,
  type AgentProfile,
  type Lane,
  type OpenAiCompatProfile,
  type ProjectEntry,
} from "../../lib/api";
import { LaneSwitcher } from "../agent/LaneSwitcher";
import { Input } from "../ui/input";
import { useDismiss } from "../../lib/useDismiss";
import { toast } from "../../lib/toast";

/** One shared look for the three "needs a choice first" starters, so they read
 *  as three of a kind rather than three buttons that happen to be adjacent. */
const STARTER_BUTTON =
  "px-2 h-6 rounded text-xs font-medium text-text-3 bg-bg-2 hover:bg-bg-3 hover:text-text-1 border border-line-soft transition-colors flex items-center gap-1";

/** One shared look for their flyouts. */
const FLYOUT_STYLE = {
  background: "var(--color-bg-3)",
  border: "1px solid var(--color-line-soft)",
} as const;

// Which project new tabs open in — this workspace by default, any other known
// project on demand, so a split can hold a Claude from project B beside project
// A. Only interactive surfaces are retargeted; files aren't, because a foreign
// file's git context would resolve against this workspace. Hidden entirely when
// there's only one project.
export function ProjectSpawnTarget({
  projects,
  value,
  currentRepoRoot,
  onChange,
}: {
  projects: ProjectEntry[];
  value: string;
  currentRepoRoot: string;
  onChange: (root: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useDismiss(open, () => setOpen(false), ref);

  // Current workspace first, then the rest most-recently-opened first. De-dup
  // by root so a project that's also the current one isn't listed twice.
  const ordered = useMemo(() => {
    const seen = new Set<string>();
    const out: { root: string; label: string }[] = [];
    const push = (root: string, label: string) => {
      if (root && !seen.has(root)) {
        seen.add(root);
        out.push({ root, label });
      }
    };
    push(currentRepoRoot, projectLabelFor(projects, currentRepoRoot));
    [...projects]
      .sort((a, b) => b.last_opened_at - a.last_opened_at)
      .forEach((p) => push(p.root, p.label || baseName(p.root)));
    return out;
  }, [projects, currentRepoRoot]);

  const isForeign = value !== currentRepoRoot;
  return (
    <div className="relative" ref={ref}>
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className={`flex items-center gap-1 h-6 px-1.5 rounded text-xs border transition-colors ${
          isForeign
            ? "text-accent border-accent bg-bg-2"
            : "text-text-3 border-transparent hover:text-text-1 hover:bg-state-hover hover:border-line-soft"
        }`}
        title="Choose which project new tabs open in"
      >
        <FolderGlyph />
        <span className="truncate max-w-[150px]">
          {projectLabelFor(projects, value)}
        </span>
        <span className="text-text-5">
          <ChevronGlyph />
        </span>
      </button>
      {open && (
        <div
          className="absolute top-8 right-0 z-30 w-[240px] rounded-md py-1.5 shadow-lg"
          style={FLYOUT_STYLE}
        >
          <div className="px-3 pb-1 text-xs font-medium text-text-4">
            Open new tabs in
          </div>
          <div className="px-1.5 flex flex-col gap-0.5 max-h-[240px] overflow-auto">
            {ordered.map((p) => (
              <button
                key={p.root}
                type="button"
                onClick={() => {
                  onChange(p.root);
                  setOpen(false);
                }}
                className={`w-full text-left px-2 py-1.5 rounded text-sm flex items-center gap-2 ${
                  p.root === value
                    ? "bg-bg-2 text-text-1"
                    : "text-text-2 hover:bg-state-hover hover:text-text-1"
                }`}
              >
                <span className="truncate flex-1">{p.label}</span>
                {p.root === currentRepoRoot && (
                  <span className="text-xs text-text-5">current</span>
                )}
                {p.root === value && (
                  <span className="text-accent text-sm">✓</span>
                )}
              </button>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

// Local & Custom Models launcher. Lists every openai-compat profile the user
// has wired up in Settings; picking one opens a chat tab against that endpoint.
// The empty state points at the Settings flow so they know where to add Ollama
// / HF / Together / etc.
export function LocalModelsSpawnMenu({
  onSpawn,
}: {
  onSpawn: (profile: OpenAiCompatProfile) => void;
}) {
  const [open, setOpen] = useState(false);
  const [profiles, setProfiles] = useState<OpenAiCompatProfile[]>([]);
  const ref = useRef<HTMLDivElement>(null);
  useDismiss(open, () => setOpen(false), ref);

  useEffect(() => {
    if (!open) return;
    void api
      .openaiCompatProfilesList()
      .then(setProfiles)
      .catch(() => setProfiles([]));
  }, [open]);

  return (
    <div className="relative" ref={ref}>
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className={STARTER_BUTTON}
        title="Open a chat tab against an Ollama / HuggingFace / Together / Groq / OpenRouter / vLLM endpoint"
      >
        <ChipGlyph />
        <span>Local model…</span>
      </button>
      {open && (
        <div
          className="absolute bottom-8 left-0 z-30 w-[280px] rounded-md py-2 shadow-lg"
          style={FLYOUT_STYLE}
        >
          <div className="px-3 pb-2 text-xs font-medium text-text-4">
            Profiles
          </div>
          {profiles.length === 0 ? (
            <div className="px-3 py-2 text-sm text-text-4">
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
                  className="w-full text-left px-2 py-1.5 rounded text-sm text-text-2 hover:bg-state-hover hover:text-text-1"
                >
                  <div className="font-medium">{p.name}</div>
                  <div className="text-text-4 text-xs font-mono truncate">
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

// "Isolated session…" — pick an agent profile (a named ~/.aura/agent-profiles/
// HOME swap) and then which agent CLI to run under it, so two logins of the
// same tool can run side by side. New profiles are created inline rather than
// sending the reader to Settings to add one.
export function IsolatedSpawnMenu({
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
  useDismiss(open, () => setOpen(false), ref);

  useEffect(() => {
    if (!open) return;
    void api.agentProfileList().then((list) => {
      setProfiles(list);
      if (!picked && list.length > 0) setPicked(list[0].name);
    });
  }, [open, picked]);

  async function createProfile() {
    const name = newName.trim();
    if (!name || creating) return;
    setCreating(true);
    try {
      const p = await api.agentProfileCreate(name);
      setProfiles((prev) =>
        [...prev.filter((x) => x.name !== p.name), p].sort((a, b) =>
          a.name.localeCompare(b.name),
        ),
      );
      setPicked(p.name);
      setNewName("");
    } catch (e) {
      toast.danger(`Couldn't create the "${name}" profile`, String(e));
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
        className={STARTER_BUTTON}
        title="Start an agent with an isolated HOME. A fresh login per profile"
      >
        <BadgeGlyph />
        <span>Isolated…</span>
      </button>
      {open && (
        <div
          className="absolute bottom-8 left-0 z-30 w-[280px] rounded-md py-2 shadow-lg"
          style={FLYOUT_STYLE}
        >
          <div className="px-3 pb-2 text-xs font-medium text-text-4">
            Profile
          </div>
          <div className="px-2 pb-2 flex flex-col gap-1 max-h-[140px] overflow-auto">
            {profiles.length === 0 && (
              <div className="px-2 py-1 text-xs text-text-4">
                No profiles yet. Create one below.
              </div>
            )}
            {profiles.map((p) => (
              <button
                key={p.name}
                type="button"
                onClick={() => setPicked(p.name)}
                className={`w-full text-left px-2 py-1 rounded text-sm flex items-center gap-2 ${
                  picked === p.name
                    ? "bg-bg-2 text-text-1"
                    : "text-text-2 hover:bg-state-hover"
                }`}
              >
                <span className="font-medium">{p.label ?? p.name}</span>
                <span className="text-text-4 text-xs">
                  ~/.aura/agent-profiles/{p.name}
                </span>
                {picked === p.name && (
                  <span className="ml-auto text-accent text-sm">✓</span>
                )}
              </button>
            ))}
          </div>
          <div className="px-2 pb-2 flex items-center gap-1.5">
            <Input
              value={newName}
              onChange={(e) => setNewName(e.target.value)}
              placeholder="new-profile-name"
              className="flex-1 h-7 text-sm"
              onKeyDown={(e) => {
                if (e.key === "Enter") void createProfile();
              }}
            />
            <button
              type="button"
              onClick={() => void createProfile()}
              disabled={!newName.trim() || creating}
              className="h-7 px-2 rounded text-sm bg-bg-2 hover:bg-bg-3 border border-line-soft text-text-1 disabled:opacity-50"
            >
              + Add
            </button>
          </div>
          <div className="border-t border-line-soft mx-2 mb-2" />
          <div className="px-3 pb-1 text-xs font-medium text-text-4">
            Start agent
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
                className="px-2 h-7 rounded text-sm font-medium text-text-2 bg-bg-2 hover:bg-bg-3 hover:text-text-1 border border-line-soft transition-colors disabled:opacity-50"
                title={
                  picked
                    ? `Start ${label} under profile ${picked}`
                    : "Pick a profile first"
                }
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

// Lanes (AURA-81) — the stronger form of the same idea as "Isolated…": don't
// just isolate the agent's login, give it a whole isolated copy of the project
// so two agents can run in parallel without overwriting each other. The flyout
// hosts the self-contained LaneSwitcher; focusing or starting a lane hands its
// live agent back through onFocusLane.
export function LaneSpawnMenu({
  repoRoot,
  onFocusLane,
}: {
  repoRoot: string;
  onFocusLane: (lane: Lane) => void;
}) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useDismiss(open, () => setOpen(false), ref);

  return (
    <div className="relative" ref={ref}>
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className={STARTER_BUTTON}
        title="Run another AI in its own isolated copy of the project. No copies to juggle, no branch switching"
      >
        <LanesGlyph />
        <span>New lane…</span>
      </button>
      {open && (
        <div className="absolute bottom-8 left-0 z-30">
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

export function projectLabelFor(projects: ProjectEntry[], root: string): string {
  const p = projects.find((x) => x.root === root);
  return p?.label || baseName(root) || root;
}

function shortHost(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
}

function baseName(path: string): string {
  const i = path.lastIndexOf("/");
  return i === -1 ? path : path.slice(i + 1);
}

// The three starters used to be labelled with bare typographic characters —
// ▸ for a local model, ↪ for an isolated session, ⊞ for a lane — sitting one
// row under real icons. A `↪` is the glyph for "reply"; nothing about it says
// "a second login of the same tool", and at 12px beside a Claude mark it just
// read as debris. Three drawn marks now, on the same 16-grid and 1.2px stroke
// as the rest of the icon set.

/** A model running on your own machine — a chip. */
function ChipGlyph() {
  return (
    <svg width="12" height="12" viewBox="0 0 16 16" fill="none" aria-hidden>
      <rect
        x="4.5"
        y="4.5"
        width="7"
        height="7"
        rx="1.2"
        stroke="currentColor"
        strokeWidth="1.2"
      />
      <path
        d="M6.5 2v2.5M9.5 2v2.5M6.5 11.5V14M9.5 11.5V14M2 6.5h2.5M2 9.5h2.5M11.5 6.5H14M11.5 9.5H14"
        stroke="currentColor"
        strokeWidth="1.2"
        strokeLinecap="round"
      />
    </svg>
  );
}

/** A separate login — an ID badge: one identity, held apart from the rest. */
function BadgeGlyph() {
  return (
    <svg width="12" height="12" viewBox="0 0 16 16" fill="none" aria-hidden>
      <rect
        x="2.5"
        y="3.5"
        width="11"
        height="10"
        rx="1.5"
        stroke="currentColor"
        strokeWidth="1.2"
      />
      <path d="M6 3.5v-1h4v1" stroke="currentColor" strokeWidth="1.2" strokeLinejoin="round" />
      <circle cx="8" cy="7.6" r="1.6" stroke="currentColor" strokeWidth="1.2" />
      <path
        d="M5.6 11.6c.5-1.1 1.4-1.6 2.4-1.6s1.9.5 2.4 1.6"
        stroke="currentColor"
        strokeWidth="1.2"
        strokeLinecap="round"
      />
    </svg>
  );
}

/** A lane — two parallel tracks of the same project, running side by side. */
function LanesGlyph() {
  return (
    <svg width="12" height="12" viewBox="0 0 16 16" fill="none" aria-hidden>
      <path
        d="M3.5 2.5v11M12.5 2.5v11"
        stroke="currentColor"
        strokeWidth="1.2"
        strokeLinecap="round"
      />
      <path
        d="M8 3v2.2M8 6.9v2.2M8 10.8V13"
        stroke="currentColor"
        strokeWidth="1.2"
        strokeLinecap="round"
      />
    </svg>
  );
}

function FolderGlyph() {
  return (
    <svg width="12" height="12" viewBox="0 0 16 16" fill="none">
      <path
        d="M1.75 4.25c0-.55.45-1 1-1h3.1c.3 0 .58.13.77.36l.76.9c.19.23.47.36.77.36h5.33c.55 0 1 .45 1 1v6.02c0 .55-.45 1-1 1H2.75c-.55 0-1-.45-1-1V4.25z"
        stroke="currentColor"
        strokeWidth="1.2"
        strokeLinejoin="round"
      />
    </svg>
  );
}

/** The chevron on the project button. Was a `▾` glyph, which the system font
 *  draws at its own weight and baseline — always a shade too heavy, never
 *  aligned with the folder beside it. */
function ChevronGlyph() {
  return (
    <svg width="10" height="10" viewBox="0 0 16 16" fill="none" aria-hidden>
      <path
        d="M4.5 6.5 8 10l3.5-3.5"
        stroke="currentColor"
        strokeWidth="1.4"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

/** Leads the launcher's field, so the box reads as a search before it is
 *  typed in rather than as an anonymous input with a long sentence in it. */
export function SearchGlyph() {
  return (
    <svg width="12" height="12" viewBox="0 0 16 16" fill="none" aria-hidden>
      <circle cx="7" cy="7" r="4.5" stroke="currentColor" strokeWidth="1.2" />
      <path
        d="M10.5 10.5 14 14"
        stroke="currentColor"
        strokeWidth="1.2"
        strokeLinecap="round"
      />
    </svg>
  );
}
