// AgentCustomizations — "Agents & extensions", the single full-screen home for
// everything that shapes how your AI works on this project AND the editor
// add-ons it runs in. A grouped left sidebar (our wizard aesthetic) carries the
// sections; the chosen pane fills the rest. Every pane reads and writes real
// Aura state — installed agents, their real on-disk skills, signed plugins, MCP
// connections, project memory, the safety net, the VS-Code-compatible extension
// gallery — so nothing here is a mockup.
//
// One home, on purpose: the Build rail stays a single calm "Agents &
// extensions" row instead of a column of per-thing links. Plugins are the
// ADE-native add-on track; Extensions is the compatibility track for what VS
// Code supports — both live here, ADE-first.
//
// Grouped, not a flat tab strip: the sections are clustered by what they mean
// to you — who does the work (Agents), what your AI knows (Knowledge),
// add-ons & connections, and a de-emphasised Project group for the safety net.
// "Don't make them think": related things sit together, the loud stuff is up
// top, the housekeeping is quiet at the bottom. No title bar — the sidebar
// carries the context (see FullscreenOverlay). The surface is composition: each
// section is its own small file under ./agentCustomize so this shell stays a
// router.

import { useState, type ReactNode } from "react";
import {
  Blocks,
  BookOpen,
  Bot,
  Database,
  Plug,
  ShieldCheck,
  Sparkles,
  Zap,
} from "lucide-react";

import { useAgents } from "../../lib/agents";
import { FullscreenOverlay } from "../FullscreenOverlay";
import { MemoryDialog } from "../dialogs/MemoryDialog";
import {
  useCustomizeStores,
  type CustomizeNavItem,
  type CustomizeViewId,
} from "./agentCustomize/customizeShared";
import { OverviewPane } from "./agentCustomize/OverviewPane";
import { AgentsPane } from "./agentCustomize/AgentsPane";
import { SkillsPane } from "./agentCustomize/SkillsPane";
import { InstructionsPane } from "./agentCustomize/InstructionsPane";
import { HooksPane } from "./agentCustomize/HooksPane";
import { McpServersPane } from "./agentCustomize/McpServersPane";
import { AddOnsPane } from "./agentCustomize/AddOnsPane";

const NAV: CustomizeNavItem[] = [
  {
    id: "overview",
    label: "Overview",
    blurb: "Start here — describe a change, or set things up by hand.",
    icon: <Sparkles size={15} />,
  },
  {
    id: "agents",
    label: "Agents",
    blurb: "The assistants that read and change your code.",
    icon: <Bot size={15} />,
  },
  {
    id: "skills",
    label: "Skills",
    blurb: "Extra abilities your agent can run on demand.",
    icon: <Zap size={15} />,
  },
  {
    id: "instructions",
    label: "Instructions",
    blurb: "Standing rules every agent follows on your project.",
    icon: <BookOpen size={15} />,
  },
  {
    id: "memory",
    label: "Memory",
    blurb: "What your AI remembers about you and this project.",
    icon: <Database size={15} />,
  },
  {
    id: "mcp",
    label: "Connections",
    blurb: "Let your agent work in the tools you already use.",
    icon: <Plug size={15} />,
  },
  {
    id: "addons",
    label: "Add-ons",
    blurb:
      "Extend what Aura can do — plugins built for it, plus editor add-ons from the VS Code world.",
    icon: <Blocks size={15} />,
  },
  {
    id: "hooks",
    label: "Safety net",
    blurb: "Keep a recoverable record of every change.",
    icon: <ShieldCheck size={15} />,
  },
];

const NAV_BY_ID = Object.fromEntries(NAV.map((n) => [n.id, n])) as Record<
  CustomizeViewId,
  CustomizeNavItem
>;

// Grouped sidebar model — clusters by meaning, not a flat list. The top block
// (Overview + Agents) has no heading; the rest carry a quiet section label.
// "Project" is intentionally last and de-emphasised so the safety net stops
// competing with the things people actually tune.
type NavGroup = {
  heading?: string;
  items: CustomizeViewId[];
  muted?: boolean;
};

const GROUPS: NavGroup[] = [
  { items: ["overview", "agents"] },
  { heading: "Knowledge", items: ["skills", "instructions", "memory"] },
  { heading: "Add-ons & connections", items: ["addons", "mcp"] },
  { heading: "Project", items: ["hooks"], muted: true },
];

export function AgentCustomizations({
  repoRoot,
  initialView = "overview",
  onClose,
}: {
  repoRoot: string;
  /** Section to land on when opened. Lets a rail row deep-link straight to
   *  Skills / Instructions / Connections instead of the generic Overview the
   *  user would then have to navigate from. Defaults to "overview" (the
   *  account-menu / palette entry point). */
  initialView?: CustomizeViewId;
  onClose: () => void;
}) {
  const [view, setView] = useState<CustomizeViewId>(initialView);
  const { agents, loading: agentsLoading, refresh: refreshAgents } = useAgents();
  const stores = useCustomizeStores(repoRoot);

  const categories = NAV.filter((n) => n.id !== "overview");
  // The Add-ons row owns the `plugins`/`extensions` deep-link aliases, so it
  // stays highlighted whichever track is showing.
  const navView: CustomizeViewId =
    view === "plugins" || view === "extensions" ? "addons" : view;

  return (
    <FullscreenOverlay onClose={onClose}>
      <div className="flex h-full min-h-0">
        {/* Grouped sidebar — the wizard aesthetic. Sticky, own scroll. */}
        <nav className="w-56 shrink-0 overflow-y-auto border-r border-line-soft px-2.5 py-4">
          {GROUPS.map((group, gi) => (
            <div key={group.heading ?? `g-${gi}`} className={gi > 0 ? "mt-5" : ""}>
              {group.heading ? (
                <div
                  className={`mb-1.5 px-2 text-[10.5px] font-semibold uppercase tracking-wide ${
                    group.muted ? "text-text-5" : "text-text-4"
                  }`}
                >
                  {group.heading}
                </div>
              ) : null}
              <div className="space-y-0.5">
                {group.items.map((id) => {
                  const item = NAV_BY_ID[id];
                  return (
                    <SidebarRow
                      key={id}
                      icon={item.icon}
                      label={item.label}
                      active={navView === id}
                      muted={group.muted}
                      onClick={() => setView(id)}
                    />
                  );
                })}
              </div>
            </div>
          ))}
        </nav>

        {/* Active pane — each manages its own scroll. */}
        <div className="min-w-0 flex-1 overflow-hidden">
          {view === "overview" ? (
            <OverviewPane
              nav={categories}
              agents={agents}
              stores={stores}
              onNavigate={setView}
              onClose={onClose}
            />
          ) : view === "agents" ? (
            <AgentsPane
              agents={agents}
              loading={agentsLoading}
              refresh={refreshAgents}
              onClose={onClose}
            />
          ) : view === "skills" ? (
            <SkillsPane repoRoot={repoRoot} />
          ) : view === "instructions" ? (
            <InstructionsPane
              repoRoot={repoRoot}
              memory={stores.memory}
              loading={stores.loading}
              refresh={stores.refresh}
            />
          ) : view === "memory" ? (
            // The full Memory surface embedded as a pane (same component the
            // Trace memory row opens) — import-from-Claude-Code, facts, and
            // why-it-stuck all live here. Closing returns to Overview rather
            // than dismissing the whole surface.
            <MemoryDialog
              inline
              open
              repoRoot={repoRoot}
              onClose={() => setView("overview")}
            />
          ) : view === "hooks" ? (
            <HooksPane
              repoRoot={repoRoot}
              capture={stores.capture}
              loading={stores.loading}
              refresh={stores.refresh}
            />
          ) : view === "mcp" ? (
            <McpServersPane
              mcp={stores.mcp}
              loading={stores.loading}
              refresh={stores.refresh}
              onClose={onClose}
            />
          ) : (
            // Add-ons: Plugins (built for Aura) + Extensions (from VS Code)
            // clubbed behind one switch. `extensions`/`plugins` are deep-link
            // aliases that just pick the starting track.
            <AddOnsPane
              plugins={stores.plugins}
              loading={stores.loading}
              refresh={stores.refresh}
              initialTab={view === "extensions" ? "extensions" : "plugins"}
            />
          )}
        </div>
      </div>
    </FullscreenOverlay>
  );
}

function SidebarRow({
  icon,
  label,
  active,
  muted,
  onClick,
}: {
  icon: ReactNode;
  label: string;
  active: boolean;
  muted?: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`flex w-full items-center gap-2.5 rounded-md px-2 py-1.5 text-left text-[12.5px] transition-colors ${
        active
          ? "bg-[color-mix(in_srgb,var(--color-accent)_14%,transparent)] font-medium text-text-1"
          : muted
            ? "text-text-4 hover:bg-bg-2 hover:text-text-2"
            : "text-text-3 hover:bg-bg-2 hover:text-text-1"
      }`}
      style={active ? { color: "var(--color-accent)" } : undefined}
    >
      <span
        className="shrink-0"
        style={active ? { color: "var(--color-accent)" } : undefined}
      >
        {icon}
      </span>
      <span className="truncate">{label}</span>
    </button>
  );
}
