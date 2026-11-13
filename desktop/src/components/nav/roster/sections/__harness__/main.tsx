// The sidebar's workspace list, rendered on its own, so making a section can
// be watched from the "My workspaces" menu to the heading it draws.
//
// Dev-server only — reached at /sections-harness.html, never bundled. The list
// is the real one; only the desktop's commands are stood in for, and every one
// this page doesn't know answers with nothing. Sections live in this page's
// own storage, cleared on every load so each run starts with none; with
// ?seed=1 it starts with one empty section, "Review", to drag into.

import { StrictMode } from "react";
import ReactDOM from "react-dom/client";

import "../../../../../styles.css";
import type { Workspace } from "../../../../../lib/workspaceRef";

const params = new URLSearchParams(location.search);
if (params.get("theme") === "light") document.documentElement.classList.add("light");
try {
  localStorage.removeItem("aura.roster.sections");
  if (params.get("seed") === "1") {
    localStorage.setItem(
      "aura.roster.sections",
      JSON.stringify([{ id: "review", name: "Review", emoji: "👀", paths: [] }]),
    );
  }
} catch {
  /* no storage — the page still draws */
}

const missed = new Set<string>();
(window as unknown as { __harnessMissed: Set<string> }).__harnessMissed = missed;
(window as unknown as { __TAURI_INTERNALS__: unknown }).__TAURI_INTERNALS__ = {
  invoke: async (cmd: string) => {
    missed.add(cmd);
    return null;
  },
  transformCallback: () => 0,
};

const ROOT = "/Users/you/code/aura";
const now = Math.floor(Date.now() / 1000);
const workspaces: Workspace[] = [
  {
    id: ROOT,
    letter: "A",
    active: true,
    worktrees: [
      { path: ROOT, branch: "main", head: "e937539", is_main: true, locked: false, head_committed_at: now - 600 },
      {
        path: `${ROOT}-copies/checks-one-pr`,
        branch: "checks-one-pr",
        head: "c2fe0ae",
        is_main: false,
        locked: false,
        head_committed_at: now - 3600,
        created_at: now - 7200,
      },
    ],
  },
  // Two more repositories, so one can be dragged whole into a section by its
  // header while another stays under "My workspaces".
  ...["webapp", "site"].map(
    (name, i): Workspace => ({
      id: `/Users/you/code/${name}`,
      letter: name[0].toUpperCase(),
      active: false,
      worktrees: [
        {
          path: `/Users/you/code/${name}`,
          branch: "main",
          head: "a1b2c3d",
          is_main: true,
          locked: false,
          head_committed_at: now - 900 * (i + 2),
        },
        {
          path: `/Users/you/code/${name}-copies/fix-${name}`,
          branch: `fix-${name}`,
          head: "d4e5f6a",
          is_main: false,
          locked: false,
          head_committed_at: now - 1800 * (i + 1),
          created_at: now - 3600 * (i + 1),
        },
      ],
    }),
  ),
];

async function mount() {
  const [{ WorkspaceRoster }, { TooltipProvider }] = await Promise.all([
    import("../../../../WorkspaceRoster"),
    import("../../../../ui/tooltip"),
  ]);
  ReactDOM.createRoot(document.getElementById("sections-harness")!).render(
    <StrictMode>
      <TooltipProvider>
        <div style={{ height: "100vh", width: 300 }} className="bg-bg-1">
          <WorkspaceRoster workspaces={workspaces} activePath={ROOT} onAddProject={() => undefined} />
        </div>
      </TooltipProvider>
    </StrictMode>,
  );
  document.body.dataset.ready = "yes";
}

void mount();
