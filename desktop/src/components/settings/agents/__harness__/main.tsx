// Settings → Agents → Agent registry, rendered on its own.
//
// Dev-server only — reached at /acp-agents-harness.html, never bundled. The
// section and the settings layout around it are the real ones; only the
// desktop's commands are stood in for, answering with a fixed registry. No
// agent is installed, started or signed in, and nothing is saved anywhere.
//
// Each scene is pressed into its state the way a person would get there: a
// tab chosen, an agent opened, its earlier chats asked for, an install begun.

import { StrictMode, useEffect, useRef } from "react";
import type { JSX } from "react";
import ReactDOM from "react-dom/client";

import type { AcpAgentRow, AcpListedSession } from "../../../../lib/acpAgents";
import { SettingsLayout } from "../../../ui/settings-layout";
import { TooltipProvider } from "../../../ui/tooltip";
import { navigationGroups } from "../../nav";
import { AcpAgentsSection } from "../AcpAgentsSection";
import "../../../../styles.css";

const home = "/Users/sam/.aura/acp/agents";

const row = (more: Partial<AcpAgentRow> & Pick<AcpAgentRow, "id" | "name" | "version">): AcpAgentRow => ({
  aura_id: more.id,
  description: null,
  website: null,
  license: null,
  icon: null,
  state: "ready",
  source: null,
  program: null,
  install_method: null,
  unverified: false,
  reason: null,
  signed_in_with: null,
  ...more,
});

const ROWS: AcpAgentRow[] = [
  row({
    id: "fast-agent",
    name: "fast-agent",
    version: "0.10.1",
    source: { kind: "uvx" },
    program: "/opt/homebrew/bin/uvx",
  }),
  row({
    id: "gemini",
    name: "Gemini CLI",
    version: "0.67.0",
    source: { kind: "installed", version: "0.67.0" },
    program: `${home}/gemini/0.67.0/node_modules/.bin/gemini`,
    signed_in_with: "oauth-personal",
  }),
  row({
    id: "opencode",
    name: "OpenCode",
    version: "2.2.6",
    source: { kind: "path" },
    program: "/opt/homebrew/bin/opencode",
  }),
  row({
    id: "qwen-code",
    aura_id: "qwen",
    name: "Qwen Code",
    version: "0.27.1",
    source: { kind: "installed", version: "0.26.0" },
    program: `${home}/qwen-code/0.26.0/node_modules/.bin/qwen`,
  }),
  row({ id: "amp-acp", name: "Amp", version: "0.12.0", state: "installable", install_method: "binary", unverified: true }),
  row({ id: "cline", name: "Cline", version: "3.0.74", state: "installable", install_method: "npm" }),
  row({ id: "goose", name: "goose", version: "1.58.1", state: "installable", install_method: "binary" }),
  row({ id: "kimi-code", name: "Kimi Code", version: "2.5.2", state: "installable", install_method: "npm" }),
  row({
    id: "kiro",
    name: "Kiro CLI",
    version: "3.0.0",
    state: "unavailable",
    reason: "Kiro CLI has no build for this machine",
  }),
];

const ago = (minutes: number) => new Date(Date.now() - minutes * 60_000).toISOString();
const SESSIONS: AcpListedSession[] = [
  { session_id: "g-3", cwd: "/Users/sam/work/recipe-box", title: "Fix the off-by-one in the sum", updated_at: ago(12) },
  { session_id: "g-2", cwd: "/Users/sam/work/recipe-box", title: "Add a search box to the recipe list", updated_at: ago(60 * 5) },
  { session_id: "g-1", cwd: "/Users/sam/work/recipe-box", title: null, updated_at: ago(60 * 24 * 3) },
];

const answers: Record<string, (args: Record<string, unknown>) => unknown> = {
  acp_agents_list: () => ROWS,
  acp_agent_sessions: () => SESSIONS,
  // An install that is still running, so the row holds its loader.
  acp_agent_install: () => new Promise(() => undefined),
  acp_agent_uninstall: () => null,
  acp_agent_forget_sign_in: () => null,
};

(window as unknown as { __TAURI_INTERNALS__: unknown }).__TAURI_INTERNALS__ = {
  invoke: async (cmd: string, args: Record<string, unknown> = {}) => answers[cmd]?.(args) ?? null,
  transformCallback: () => 0,
};

/** A control to press: by the text it starts with, inside the agent row
 *  `within` names when there is one, a tab when `how` says so. */
type Step = { press: string; within?: string; how?: "click" | "tab" };

/** `height` is the frame's, for a scene whose page runs longer. */
const SCENES: { id: string; steps: Step[]; height?: number }[] = [
  { id: "registry-on-this-computer", steps: [] },
  {
    id: "registry-sign-in-and-chats",
    // Gemini, which signed in before, so the card shows the remembered method.
    steps: [{ press: "Sign-in and chats", within: "Gemini CLI" }, { press: "Show earlier chats" }],
    height: 1500,
  },
  { id: "registry-available", steps: [{ press: "Available", how: "tab" }] },
  // Cline, not the first row: Amp publishes no checksum, so its Install asks first.
  {
    id: "registry-installing",
    steps: [{ press: "Available", how: "tab" }, { press: "Install", within: "Cline" }],
  },
];

/** Press each step's control inside the scene, waiting for it to appear. */
function usePresses(root: React.RefObject<HTMLDivElement | null>, steps: Step[]) {
  useEffect(() => {
    let i = 0;
    let timer = 0;
    const next = () => {
      const el = root.current;
      const step = steps[i];
      if (!el) return;
      if (!step) {
        el.dataset.ready = "yes";
        return;
      }
      const scope = step.within
        ? [...el.querySelectorAll<HTMLElement>(".ui-acp-agent")].find((r) =>
            r.querySelector(".ui-acp-agent-title")?.textContent?.trim() === step.within,
          )
        : el;
      const target = [...(scope?.querySelectorAll<HTMLElement>("button, [role=tab]") ?? [])].find((b) =>
        b.textContent?.trim().startsWith(step.press),
      );
      if (!target) {
        timer = window.setTimeout(next, 50);
        return;
      }
      if (step.how === "tab") target.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, button: 0 }));
      else target.click();
      i += 1;
      timer = window.setTimeout(next, 120);
    };
    timer = window.setTimeout(next, 120);
    return () => window.clearTimeout(timer);
  }, [root, steps]);
}

function Scene({ id, steps, height = 860 }: { id: string; steps: Step[]; height?: number }): JSX.Element {
  const root = useRef<HTMLDivElement>(null);
  usePresses(root, steps);
  return (
    <div ref={root} data-scene={id} data-ready="no" style={{ height, marginBottom: 24, position: "relative" }}>
      <SettingsLayout
        title="Agents"
        groups={navigationGroups([], "")}
        selected="agents"
        onSelect={() => undefined}
        onBack={() => undefined}
        query=""
        onQueryChange={() => undefined}
      >
        <AcpAgentsSection repoRoot="/Users/sam/work/recipe-box" />
      </SettingsLayout>
    </div>
  );
}

ReactDOM.createRoot(document.getElementById("acp-agents-harness")!).render(
  <StrictMode>
    <TooltipProvider>
      {SCENES.map((s) => (
        <Scene key={s.id} id={s.id} steps={s.steps} height={s.height} />
      ))}
    </TooltipProvider>
  </StrictMode>,
);
