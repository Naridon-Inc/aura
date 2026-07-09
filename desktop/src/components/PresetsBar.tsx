// Horizontal agent-pill bar pinned above WorkSurface. Mirrors Superset's
// PresetsBar: ⚙ menu lets the user pin/unpin which agents show as
// always-visible pills; clicking a pill spawns that agent in a new PTY
// tab. The picker in the EmptyState/Composer still shows the full
// available list — this bar is the one-tap launcher for the four or so
// CLIs the user actually reaches for.

import { useEffect, useMemo, useState } from "react";
import { useAgents, type Agent, MANAGER_AGENT } from "../lib/agents";
import { AgentIcon } from "./agent/AgentIcon";
import {
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuCheckboxItem,
} from "./ui/dropdown-menu";
import { Tooltip, TooltipTrigger, TooltipContent } from "./ui/tooltip";

const SHOW_KEY = "aura.presetsBar.show";
const PINNED_KEY = "aura.presetsBar.pinned";

// Default pin state: every available CLI agent is pinned on first run. Aura
// Manager — the native in-app agent — rides this bar too, pinned by default
// (it shows unless the user explicitly turns it off via the ⚙ menu), so the
// native agent is always one tap away alongside the CLIs.
function loadPinned(): Record<string, boolean> | null {
  try {
    const raw = localStorage.getItem(PINNED_KEY);
    if (!raw) return null;
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

function savePinned(map: Record<string, boolean>) {
  try {
    localStorage.setItem(PINNED_KEY, JSON.stringify(map));
  } catch {
    /* quota — ignore, in-memory state still works */
  }
}

function loadShow(): boolean {
  return localStorage.getItem(SHOW_KEY) !== "0";
}

type PresetsBarProps = {
  onLaunchAgent: (agentId: string, label: string) => void;
};

export function PresetsBar({ onLaunchAgent }: PresetsBarProps) {
  const { agents } = useAgents();
  const [show, setShow] = useState(loadShow);
  const [pinned, setPinned] = useState<Record<string, boolean>>(
    () => loadPinned() ?? {},
  );

  // First-run: when discovery returns and the user has no saved pin
  // state, pin every available CLI agent. Manager is skipped here — it has
  // no stored flag, and isPinnedOf treats "no flag" as pinned, so it shows
  // by default without an explicit seed.
  useEffect(() => {
    if (loadPinned() !== null) return;
    if (agents.length === 0) return;
    const seed: Record<string, boolean> = {};
    for (const a of agents) {
      if (a.id === MANAGER_AGENT.id) continue;
      if (a.available) seed[a.id] = true;
    }
    setPinned(seed);
    savePinned(seed);
  }, [agents]);

  function togglePin(agentId: string) {
    setPinned((prev) => {
      const next = { ...prev, [agentId]: !prev[agentId] };
      savePinned(next);
      return next;
    });
  }

  function toggleShow(next: boolean) {
    setShow(next);
    localStorage.setItem(SHOW_KEY, next ? "1" : "0");
  }

  // Aura Manager is the native agent — it rides this bar as a peer of the CLI
  // agents, pinned by default (shown unless the user explicitly turns it off),
  // so the in-app agent is always one tap away on the surface. CLI agents stay
  // off-by-default until the first-run seed pins the installed ones.
  const isPinnedOf = (a: Agent) =>
    a.id === MANAGER_AGENT.id ? pinned[a.id] !== false : !!pinned[a.id];

  const pinnedAgents = useMemo(
    () => agents.filter((a) => a.available && isPinnedOf(a)),
    [agents, pinned],
  );

  // Hidden mode: render a thin sliver with just the gear, so the user
  // can re-enable the bar without digging into Settings.
  if (!show) {
    return (
      <div className="flex items-center h-6 px-2 border-b border-line-soft bg-bg-chrome">
        <PresetsManageMenu
          agents={agents}
          pinned={pinned}
          show={show}
          onTogglePin={togglePin}
          onToggleShow={toggleShow}
        />
      </div>
    );
  }

  return (
    <div className="flex items-center h-8 px-2 gap-0.5 border-b border-line-soft bg-bg-chrome shrink-0 overflow-x-auto">
      <PresetsManageMenu
        agents={agents}
        pinned={pinned}
        show={show}
        onTogglePin={togglePin}
        onToggleShow={toggleShow}
      />
      <div className="h-4 w-px bg-line-soft mx-1 shrink-0" />
      {pinnedAgents.length === 0 ? (
        <span className="text-text-4 text-[11px] px-2">
          no agents pinned · click ⚙ to add
        </span>
      ) : (
        pinnedAgents.map((a) => (
          <PresetPill
            key={a.id}
            agent={a}
            onClick={() => onLaunchAgent(a.id, a.label)}
          />
        ))
      )}
    </div>
  );
}

function PresetsManageMenu({
  agents,
  pinned,
  show,
  onTogglePin,
  onToggleShow,
}: {
  agents: Agent[];
  pinned: Record<string, boolean>;
  show: boolean;
  onTogglePin: (id: string) => void;
  onToggleShow: (next: boolean) => void;
}) {
  // Aura Manager rides the top of the menu as the native agent, separated
  // from the discovered CLI agents below. Its pin defaults to on (no stored
  // flag === pinned), so the toggle reads "pinned" until the user turns it off.
  const manager = agents.find((a) => a.id === MANAGER_AGENT.id);
  const cliAgents = agents.filter((a) => a.id !== MANAGER_AGENT.id);
  const managerPinned = pinned[MANAGER_AGENT.id] !== false;
  return (
    <DropdownMenu>
      <Tooltip>
        <TooltipTrigger asChild>
          <DropdownMenuTrigger asChild>
            <button
              type="button"
              className="size-6 rounded flex items-center justify-center text-text-3 hover:text-text-1 hover:bg-bg-2 transition-colors shrink-0"
            >
              <svg width="13" height="13" viewBox="0 0 16 16" fill="none">
                <circle cx="8" cy="8" r="2" stroke="currentColor" strokeWidth="1.3" />
                <path
                  d="M8 1.5v2M8 12.5v2M14.5 8h-2M3.5 8h-2M12.6 3.4l-1.4 1.4M4.8 11.2l-1.4 1.4M12.6 12.6l-1.4-1.4M4.8 4.8L3.4 3.4"
                  stroke="currentColor"
                  strokeWidth="1.3"
                  strokeLinecap="round"
                />
              </svg>
            </button>
          </DropdownMenuTrigger>
        </TooltipTrigger>
        <TooltipContent side="bottom">Manage presets</TooltipContent>
      </Tooltip>
      <DropdownMenuContent align="start" className="w-56">
        {manager ? (
          <>
            <DropdownMenuItem
              onSelect={(e) => {
                e.preventDefault();
                onTogglePin(manager.id);
              }}
              className="gap-2"
            >
              <AgentIcon
                agentId={manager.id}
                label={manager.monogram ?? manager.label}
                size={14}
              />
              <span className="flex-1 truncate">{manager.label}</span>
              <span className="ml-auto text-text-4">
                {managerPinned ? <PinFilledIcon /> : <PinOutlineIcon />}
              </span>
            </DropdownMenuItem>
            <DropdownMenuSeparator />
          </>
        ) : null}
        {cliAgents.length === 0 ? (
          <DropdownMenuItem disabled>No agent CLIs detected</DropdownMenuItem>
        ) : (
          cliAgents.map((a) => {
            const isPinned = !!pinned[a.id];
            return (
              <DropdownMenuItem
                key={a.id}
                disabled={!a.available}
                onSelect={(e) => {
                  e.preventDefault();
                  if (!a.available) return;
                  onTogglePin(a.id);
                }}
                className="gap-2"
              >
                <AgentIcon agentId={a.id} label={a.monogram ?? a.label} size={14} />
                <span className="flex-1 truncate">{a.label}</span>
                <span className="ml-auto text-text-4">
                  {a.available ? (
                    isPinned ? (
                      <PinFilledIcon />
                    ) : (
                      <PinOutlineIcon />
                    )
                  ) : (
                    <span className="text-[10px]">missing</span>
                  )}
                </span>
              </DropdownMenuItem>
            );
          })
        )}
        <DropdownMenuSeparator />
        <DropdownMenuCheckboxItem
          checked={show}
          onCheckedChange={(c) => onToggleShow(!!c)}
          onSelect={(e) => e.preventDefault()}
        >
          Show preset bar
        </DropdownMenuCheckboxItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

function PresetPill({
  agent,
  onClick,
}: {
  agent: Agent;
  onClick: () => void;
}) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <button
          type="button"
          onClick={onClick}
          className="h-6 px-2 rounded-md flex items-center gap-1.5 text-[11px] text-text-2 hover:text-text-1 hover:bg-bg-2 transition-colors shrink-0"
        >
          <AgentIcon agentId={agent.id} label={agent.monogram ?? agent.label} size={14} />
          <span className="truncate max-w-[80px]">{agent.label}</span>
        </button>
      </TooltipTrigger>
      <TooltipContent side="bottom">
        Launch {agent.label} {agent.description ? `· ${agent.description}` : ""}
      </TooltipContent>
    </Tooltip>
  );
}

function PinFilledIcon() {
  return (
    <svg width="12" height="12" viewBox="0 0 16 16" fill="currentColor">
      <path d="M9.5 1.5l5 5-3 .8-2.6 4.4L7 9.7l-3.5 4.4-.4-.4 4.4-3.5-2-2 4.4-2.6.6-3.1z" />
    </svg>
  );
}

function PinOutlineIcon() {
  return (
    <svg width="12" height="12" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.2">
      <path d="M9.5 1.5l5 5-3 .8-2.6 4.4L7 9.7l-3.5 4.4-.4-.4 4.4-3.5-2-2 4.4-2.6.6-3.1z" />
    </svg>
  );
}
