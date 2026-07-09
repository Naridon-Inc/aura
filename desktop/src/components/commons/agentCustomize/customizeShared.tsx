// Shared kit for the Agent Customizations surface — the nav model, the one
// data hook every pane reads from, and the small UI atoms (intro, card,
// toggle row, deep-link, empty hint) the panes compose. Kept in one place so
// the seven panes stay tiny and consistent, and so a non-engineer reads the
// same calm language everywhere: plain "what this is / why you'd touch it",
// arctic-blue for the one primary action, no jargon walls.

import { useCallback, useEffect, useState, type ReactNode } from "react";
import { Loader2 } from "lucide-react";

import {
  api,
  type CaptureStatus,
  type McpServerEntry,
  type MemoryView,
  type PluginRow,
} from "../../../lib/api";

// ── Navigation model ───────────────────────────────────────────────────────
// Left rail order matches the reference (Overview first, then the things you
// actually tune). Each item carries a plain-language blurb shown under its
// title so the surface explains itself without a manual.

export type CustomizeViewId =
  | "overview"
  | "agents"
  | "skills"
  | "instructions"
  | "memory"
  | "hooks"
  | "mcp"
  | "addons"
  // `plugins`/`extensions` are kept as deep-link aliases: a rail row or ⌘K
  // entry can land straight on the Add-ons surface's right sub-tab. The
  // sidebar shows a single "Add-ons" row; these route into it.
  | "plugins"
  | "extensions";

export type CustomizeNavItem = {
  id: CustomizeViewId;
  /** Title in the rail + pane heading. */
  label: string;
  /** One plain-language line — what it is, in human terms. */
  blurb: string;
  icon: ReactNode;
};

// ── The single data hook ───────────────────────────────────────────────────
// One mount fetches everything repo-scoped (plugins, MCP servers, memory,
// hooks) so the Overview cards show live counts and each pane shares the same
// snapshot. `refresh()` re-pulls after any mutation. Agents come from the
// separate module-cached `useAgents()` the shell owns, so they're not here.

export type CustomizeStores = {
  plugins: PluginRow[];
  mcp: McpServerEntry[];
  memory: MemoryView | null;
  capture: CaptureStatus | null;
  loading: boolean;
  /** Re-pull every store. Panes call this after enabling/removing something. */
  refresh: () => void;
};

export function useCustomizeStores(repoRoot: string): CustomizeStores {
  const [plugins, setPlugins] = useState<PluginRow[]>([]);
  const [mcp, setMcp] = useState<McpServerEntry[]>([]);
  const [memory, setMemory] = useState<MemoryView | null>(null);
  const [capture, setCapture] = useState<CaptureStatus | null>(null);
  const [loading, setLoading] = useState(true);

  const refresh = useCallback(() => {
    let live = true;
    setLoading(true);
    // Each store is independent — one failing (e.g. memory in a fresh repo)
    // must not blank the others, so we settle them individually.
    api
      .pluginList()
      .then((r) => live && setPlugins(r))
      .catch(() => live && setPlugins([]));
    api
      .mcpServersList()
      .then((r) => live && setMcp(r))
      .catch(() => live && setMcp([]));
    api
      .auraMemoryView(repoRoot)
      .then((r) => live && setMemory(r))
      .catch(() => live && setMemory(null));
    api
      .captureStatus(repoRoot)
      .then((r) => live && setCapture(r))
      .catch(() => live && setCapture(null))
      .finally(() => live && setLoading(false));
    return () => {
      live = false;
    };
  }, [repoRoot]);

  useEffect(() => {
    const cancel = refresh();
    return cancel;
  }, [refresh]);

  return { plugins, mcp, memory, capture, loading, refresh };
}

/** Total instructions = every entry across every memory section. */
export function instructionCount(memory: MemoryView | null): number {
  if (!memory) return 0;
  return memory.sections.reduce((sum, s) => sum + s.entries.length, 0);
}

// ── UI atoms ────────────────────────────────────────────────────────────────

/** The scroll body every pane lives in — centered, comfortable reading width. */
export function PaneScroll({ children }: { children: ReactNode }) {
  return (
    <div className="h-full overflow-y-auto">
      <div className="mx-auto max-w-3xl px-8 py-7">{children}</div>
    </div>
  );
}

/** Pane heading + plain-language subtitle. No jargon — say what it does. */
export function PaneIntro({
  title,
  blurb,
  action,
}: {
  title: string;
  blurb: string;
  action?: ReactNode;
}) {
  return (
    <div className="mb-5 flex items-start justify-between gap-4">
      <div className="min-w-0">
        <h2 className="text-[16px] font-semibold text-text-1">{title}</h2>
        <p className="mt-1 text-[12.5px] leading-relaxed text-text-3">{blurb}</p>
      </div>
      {action ? <div className="shrink-0">{action}</div> : null}
    </div>
  );
}

/** A bordered surface for a row/group of related controls. */
export function Card({
  children,
  className = "",
}: {
  children: ReactNode;
  className?: string;
}) {
  return (
    <div
      className={`rounded-lg border border-line-soft bg-bg-0 shadow-[var(--shadow-card)] ${className}`}
    >
      {children}
    </div>
  );
}

/** A calm count chip (e.g. "3 installed"). Neutral by default. */
export function CountPill({ children }: { children: ReactNode }) {
  return (
    <span className="rounded-full bg-bg-2 px-2 py-0.5 text-[10.5px] font-medium text-text-3">
      {children}
    </span>
  );
}

/** Centered empty/loading state — icon, line, optional supporting text. */
export function EmptyHint({
  icon,
  title,
  body,
  action,
}: {
  icon?: ReactNode;
  title: string;
  body?: string;
  action?: ReactNode;
}) {
  return (
    <div className="flex flex-col items-center justify-center gap-2 rounded-lg border border-dashed border-line-soft px-6 py-10 text-center">
      {icon ? <div className="text-text-4">{icon}</div> : null}
      <div className="text-[13px] font-medium text-text-2">{title}</div>
      {body ? (
        <div className="max-w-sm text-[12px] leading-relaxed text-text-4">
          {body}
        </div>
      ) : null}
      {action ? <div className="mt-1">{action}</div> : null}
    </div>
  );
}

/** Small inline spinner reused across panes while a store loads. */
export function PaneSpinner({ label = "Loading…" }: { label?: string }) {
  return (
    <div className="flex items-center gap-2 px-1 py-6 text-[12px] text-text-4">
      <Loader2 size={14} className="animate-spin" />
      {label}
    </div>
  );
}
