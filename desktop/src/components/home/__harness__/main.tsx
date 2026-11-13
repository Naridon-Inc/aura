// Aura's panel beside Home, rendered on its own.
//
// Dev-server only — reached at /home-aura-harness.html?scene=<name>, never
// bundled. The layout, the panel, cloud Home and the history menu are the
// real ones; only the desktop's `manager_list` command is stood in for,
// answering with a fixed set of conversations. Nothing is read or saved.
//
// Scenes:
//   cloud-closed  cloud Home with the Aura switch after Create, panel folded
//   cloud-open    the same page with the panel docked open
//   history       a workspace tab's history menu and the panel's, side by
//                 side; a request names the panel's conversation, so only the
//                 panel's opens — listing every conversation with its projects
//
// Add `&theme=light` for the light palette.

import { StrictMode, useState } from "react";
import ReactDOM from "react-dom/client";

import type { ManagerSummary } from "../../../lib/api";
import { openChatHistory } from "../../../lib/chatHistoryEvent";
import { CloudHome } from "../../ui/cloud-home";
import type { CloudMember } from "../../ui/cloud-workspace";
import { workflowWorkspaces } from "../../ui/__harness__/workflow-fixtures";
import { ChatHistoryMenu } from "../../manager/chat/ChatHistoryMenu";
import { ChatHostProvider, type ChatHost } from "../../manager/chat/chatHost";
import { HomeAuraLayout } from "../HomeAuraLayout";
import { AuraPanelToggle, HomeAuraPanel } from "../HomeAuraPanel";
import "../../../styles.css";
// The app loads the cloud surfaces' shared rows and segments globally.
import "../../ui/cloud-patterns.css";

const now = Math.floor(Date.now() / 1000);
const chat = (
  id: string,
  objective: string,
  ageSecs: number,
  bound: Partial<Pick<ManagerSummary, "repo_root" | "project_count" | "projects">>,
): ManagerSummary => ({
  id,
  objective,
  status: "completed",
  created_at: now - ageSecs - 600,
  updated_at: now - ageSecs,
  task_count: 0,
  done_count: 0,
  repo_root: bound.projects?.[0] ?? bound.repo_root ?? null,
  ...bound,
});

const CONVERSATIONS: ManagerSummary[] = [
  chat("s-panel", "Ship cloud sign-in on desktop and web", 120, {
    projects: ["/Users/sam/code/aura", "/Users/sam/code/aura-web"],
    project_count: 2,
  }),
  chat("s-recipes", "Tidy the recipe box import", 3_600, { projects: ["/Users/sam/code/recipe-box"], project_count: 1 }),
  chat("s-older", "Release notes for the spring cut", 90_000, {
    repo_root: "/Users/sam/code/aura",
    project_count: 3,
  }),
  chat("s-scratch", "What changed in the billing plan?", 700_000, { repo_root: null, project_count: 0 }),
];

const members: CloudMember[] = [
  { id: "sam", name: "Sam Rivera", initials: "SR", color: "#4dc1a4", role: "Admin", active: true },
  { id: "ada", name: "Ada Park", initials: "AP", color: "#7c8cf8", role: "Member" },
];

const answers: Record<string, () => unknown> = {
  manager_list: () => CONVERSATIONS,
};

(window as unknown as { __TAURI_INTERNALS__: unknown }).__TAURI_INTERNALS__ = {
  invoke: async (cmd: string) => {
    const answer = answers[cmd];
    if (!answer) throw new Error(`command ${cmd} not found`);
    return answer();
  },
  transformCallback: () => 0,
};

const params = new URLSearchParams(location.search);
const sceneName = params.get("scene") ?? "cloud-closed";
if (params.get("theme") === "light") document.documentElement.classList.add("light");

const auraHost: ChatHost = { openSession: () => undefined, scope: "aura" };

function CloudHomeWithAura({ startOpen }: { startOpen: boolean }) {
  const [shown, setShown] = useState(startOpen);
  const [width, setWidth] = useState(380);
  const [who, setWho] = useState<string[]>([]);
  return (
    <div style={{ display: "flex", height: "100vh" }}>
      <HomeAuraLayout
        shown={shown}
        width={width}
        onResize={setWidth}
        home={
          <CloudHome
            workspaces={workflowWorkspaces}
            members={members}
            ownerByWorkspace={{}}
            pinnedIds={[]}
            selectedOwners={who}
            onOwnersChange={setWho}
            onOpen={() => undefined}
            onCreate={() => undefined}
            onProfile={() => undefined}
            trailing={<AuraPanelToggle shown={shown} onToggle={() => setShown((s) => !s)} />}
          />
        }
        panel={
          <HomeAuraPanel
            sessionId={null}
            resolving={false}
            hasAnchor={false}
            focusNonce={0}
            onNewChat={() => undefined}
            onOpenSession={() => undefined}
            onCollapse={() => setShown(false)}
            onOpenProject={() => undefined}
          />
        }
      />
    </div>
  );
}

/** A history trigger sat at the foot of a column, where the composer puts it. */
function HistoryColumn({ label, sessionId, host }: { label: string; sessionId: string; host: ChatHost | null }) {
  const menu = <ChatHistoryMenu currentSessionId={sessionId} repoRoot="/Users/sam/code/aura" />;
  return (
    <section
      data-column={sessionId}
      style={{
        flex: 1,
        display: "flex",
        flexDirection: "column",
        justifyContent: "space-between",
        padding: 16,
        borderLeft: "1px solid var(--ui-border)",
        color: "var(--ui-muted-fg)",
        font: "13px var(--font-sans)",
      }}
    >
      <span>{label}</span>
      <div style={{ display: "flex", justifyContent: "flex-end" }}>
        {host ? <ChatHostProvider host={host}>{menu}</ChatHostProvider> : menu}
      </div>
    </section>
  );
}

function Scene() {
  if (sceneName === "cloud-open") return <CloudHomeWithAura startOpen />;
  if (sceneName === "history") {
    return (
      <div style={{ display: "flex", height: "100vh", background: "var(--ui-bg)" }}>
        <HistoryColumn label="A workspace chat tab" sessionId="s-recipes" host={null} />
        <HistoryColumn label="Aura's panel on Home" sessionId="s-panel" host={auraHost} />
      </div>
    );
  }
  return <CloudHomeWithAura startOpen={false} />;
}

ReactDOM.createRoot(document.getElementById("home-aura-harness")!).render(
  <StrictMode>
    <Scene />
  </StrictMode>,
);

// The history scenes open a menu the way `/resume` and "Chat history" do:
// addressed to the panel's conversation, so the tab's menu stays shut.
if (sceneName === "history") {
  window.setTimeout(() => {
    openChatHistory("s-panel");
    document.body.dataset.pressed = "yes";
  }, 150);
} else document.body.dataset.pressed = "yes";
