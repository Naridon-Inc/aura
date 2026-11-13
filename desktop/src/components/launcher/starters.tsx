// The four controls that sit around the launcher's "start something new" list:
// which project a new tab opens in, and the three ways of starting an agent
// that need a choice made first (a local endpoint, an isolated login, a lane).
//
// They lived inside EmptyPanePicker, which meant the "+" picker on a tab strip
// — the other half of the same question — simply didn't have them. Moving them
// here is what lets one launcher serve both.

import { useEffect, useMemo, useState } from "react";
import { Check, ChevronDown, Columns2, Cpu, FolderOpen, IdCard, Plus } from "lucide-react";

import {
  api,
  type AgentProfile,
  type Lane,
  type OpenAiCompatProfile,
  type ProjectEntry,
} from "../../lib/api";
import { toast } from "../../lib/toast";
import { LaneSwitcher } from "../agent/LaneSwitcher";
import { Button } from "../ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuTrigger,
} from "../ui/dropdown-menu";
import { Input } from "../ui/input";
import { Popover, PopoverContent, PopoverTrigger } from "../ui/popover";
import "../ui/launcher.css";

/** Which repository new tabs open in. Quiet while it is this pane's own; it
 *  turns outlined when it points somewhere else, so a start that lands in
 *  another repository is never a surprise. */
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
  const ordered = useMemo(() => {
    const seen = new Set<string>();
    const out: { root: string; label: string }[] = [];
    const push = (root: string, label: string) => {
      if (root && !seen.has(root)) {
        seen.add(root);
        out.push({ root, label });
      }
    };
    // The pane's own repository first, then the rest by when they were last
    // opened — the one you came from is the one you most likely want back.
    push(currentRepoRoot, projectLabelFor(projects, currentRepoRoot));
    [...projects]
      .sort((a, b) => b.last_opened_at - a.last_opened_at)
      .forEach((p) => push(p.root, p.label || baseName(p.root)));
    return out;
  }, [projects, currentRepoRoot]);

  const isForeign = value !== currentRepoRoot;
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          variant={isForeign ? "outline" : "ghost"}
          size="sm"
          className="ui-where-trigger"
          title="Choose which repository new tabs open in"
        >
          <FolderOpen className="ui-where-glyph" />
          <span className="ui-where-label">{projectLabelFor(projects, value)}</span>
          <ChevronDown className="ui-where-chevron" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="ui-where-menu">
        <DropdownMenuLabel>Open new tabs in</DropdownMenuLabel>
        {ordered.map((p) => (
          <DropdownMenuItem
            key={p.root}
            className="ui-where-row"
            data-current={p.root === value ? "" : undefined}
            onSelect={() => onChange(p.root)}
          >
            <span className="ui-where-row-text">
              <span>{p.label}</span>
              {p.root === currentRepoRoot && <small>This pane&apos;s repository</small>}
            </span>
            {p.root === value && <Check className="ui-where-check" />}
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

/** A chat tab against an endpoint that speaks the OpenAI chat API — a model on
 *  this machine, or a hosted one under the person's own key. */
export function LocalModelsSpawnMenu({
  onSpawn,
}: {
  onSpawn: (profile: OpenAiCompatProfile) => void;
}) {
  const [open, setOpen] = useState(false);
  const [profiles, setProfiles] = useState<OpenAiCompatProfile[]>([]);

  useEffect(() => {
    if (!open) return;
    void api
      .openaiCompatProfilesList()
      .then(setProfiles)
      .catch(() => setProfiles([]));
  }, [open]);

  return (
    <DropdownMenu open={open} onOpenChange={setOpen}>
      <DropdownMenuTrigger asChild>
        <Button
          variant="outline"
          size="xs"
          title="Open a chat tab against an Ollama / HuggingFace / Together / Groq / OpenRouter / vLLM endpoint"
        >
          <Cpu />
          Local model…
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent side="bottom" align="start" className="ui-launcher-menu">
        <DropdownMenuLabel>Profiles</DropdownMenuLabel>
        {profiles.length === 0 ? (
          <p className="ui-launcher-menu-note">
            No profiles yet. Settings ▸ Local &amp; Custom Models adds Ollama,
            HuggingFace, Together, Groq, OpenRouter, or any endpoint speaking{" "}
            <code>/v1/chat/completions</code>.
          </p>
        ) : (
          profiles.map((p) => (
            <DropdownMenuItem key={p.name} className="ui-where-row" onSelect={() => onSpawn(p)}>
              <span className="ui-where-row-text">
                <span>{p.name}</span>
                <small className="ui-launcher-mono">
                  {p.model} · {shortHost(p.base_url)}
                </small>
              </span>
            </DropdownMenuItem>
          ))
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

/** An agent under its own HOME — a separate login per profile, so a second
 *  account never shares the first one's credentials. */
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
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button
          variant="outline"
          size="xs"
          title="Start an agent with an isolated HOME. A fresh login per profile"
        >
          <IdCard />
          Isolated…
        </Button>
      </PopoverTrigger>
      <PopoverContent side="bottom" align="start" className="ui-launcher-pop">
        <div className="ui-launcher-pop-label">Profile</div>
        <div className="ui-launcher-pop-list">
          {profiles.length === 0 && (
            <p className="ui-launcher-menu-note">No profiles yet. Create one below.</p>
          )}
          {profiles.map((p) => (
            <button
              key={p.name}
              type="button"
              className="ui-menu-row ui-where-row"
              data-current={picked === p.name ? "" : undefined}
              onClick={() => setPicked(p.name)}
            >
              <span className="ui-where-row-text">
                <span>{p.label ?? p.name}</span>
                <small className="ui-launcher-mono">~/.aura/agent-profiles/{p.name}</small>
              </span>
              {picked === p.name && <Check className="ui-where-check" />}
            </button>
          ))}
        </div>
        <div className="ui-launcher-pop-add">
          <Input
            value={newName}
            onChange={(e) => setNewName(e.target.value)}
            placeholder="new-profile-name"
            size="small"
            onKeyDown={(e) => {
              if (e.key === "Enter") void createProfile();
            }}
          />
          <Button
            variant="outline"
            size="sm"
            onClick={() => void createProfile()}
            disabled={!newName.trim() || creating}
          >
            <Plus />
            Add
          </Button>
        </div>
        <div className="ui-menu-separator" />
        <div className="ui-launcher-pop-label">Start agent</div>
        <div className="ui-launcher-pop-agents">
          {[
            ["claude", "Claude"],
            ["gemini", "Gemini"],
            ["codex", "Codex"],
            ["cursor", "Cursor"],
          ].map(([id, label]) => (
            <Button
              key={id}
              variant="outline"
              size="sm"
              disabled={!picked}
              onClick={() => launch(id, label)}
              title={picked ? `Start ${label} under profile ${picked}` : "Pick a profile first"}
            >
              {label}
            </Button>
          ))}
        </div>
      </PopoverContent>
    </Popover>
  );
}

// Lanes (AURA-81) — the stronger form of the same idea as "Isolated…": don't
// just isolate the agent's login, give it a whole isolated copy of the repository
// so two agents can run in parallel without overwriting each other. The popover
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

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button
          variant="outline"
          size="xs"
          title="Run another AI in its own isolated copy of the repository. No copies to juggle, no branch switching"
        >
          <Columns2 />
          New lane…
        </Button>
      </PopoverTrigger>
      <PopoverContent side="bottom" align="start" className="ui-launcher-pop ui-lanes-pop">
        <LaneSwitcher
          repoRoot={repoRoot}
          onFocusLane={(lane) => {
            onFocusLane(lane);
            if (lane.termId) setOpen(false);
          }}
        />
      </PopoverContent>
    </Popover>
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
