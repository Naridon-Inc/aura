import { useState } from "react";
import { WORKSPACE_STATUS_LABELS } from "../workspace-status";
import { WorkspaceTabs, type WorkspaceTab } from "../workspace-tabs";
import {
  WorkspaceActivityBadge,
  WorkspaceActionsMenu,
  WorkspaceEmpty,
  ChangeScopeToolbar,
  FileDiff,
  CheckRunList,
  BackgroundTask,
  Participants,
  type WorkspaceActivity,
  type CheckRun,
} from "../workspace-patterns";
import { SidebarGroup, SidebarItem, DiffCount } from "../sidebar";
import { NavigationPatternPreview } from "./navigation-pattern-preview";
import { TaskPatternPreview } from "./task-pattern-preview";
import { WorkspacePanels, TerminalPanel } from "../workspace-panels";
import { FileTree } from "../file-tree";
import { Button } from "../button";
export function WorkspacePatternPreview() {
  const [tabs, setTabs] = useState<WorkspaceTab[]>([
    { id: "chat", label: "Build command menu" },
    { id: "review", label: "Review changes", running: true },
    { id: "file", label: "App.tsx", dirty: true },
  ]);
  const [selected, setSelected] = useState("chat"),
    [pinned, setPinned] = useState(false),
    [notice, setNotice] = useState("");
  const [scope, setScope] = useState("all"),
    [query, setQuery] = useState(""),
    [running, setRunning] = useState(true);
  const [startedAt] = useState(Date.now() - 65000);
  const [checks, setChecks] = useState<CheckRun[]>([
    { id: "types", title: "Type check", status: "passed", detail: "Completed in 12 seconds" },
    { id: "tests", title: "Unit tests", status: "failed", detail: "One check needs attention" },
    { id: "build", title: "Production build", status: "pending" },
  ]);
  const [panel, setPanel] = useState("changes"),
    [capability, setCapability] = useState(true),
    [terminal, setTerminal] = useState("terminal"),
    [commandRunning, setCommandRunning] = useState(false);
  return (
    <div className="lab-pattern-stack">
      <WorkspaceTabs
        tabs={tabs}
        value={selected}
        onChange={setSelected}
        onClose={(id) => {
          setTabs((all) => all.filter((tab) => tab.id !== id));
          if (selected === id) setSelected(tabs.find((tab) => tab.id !== id)?.id ?? "");
        }}
        onNew={() => {
          const id = crypto.randomUUID();
          setTabs([...tabs, { id, label: "New chat" }]);
          setSelected(id);
        }}
        onReorder={(ids) => setTabs(ids.map((id) => tabs.find((tab) => tab.id === id)!))}
        onRename={(id) =>
          setTabs(
            tabs.map((tab) => (tab.id === id ? { ...tab, label: `${tab.label} renamed` } : tab)),
          )
        }
      />
      <div className="lab-pattern-two-columns">
        <section className="lab-sidebar-specimen">
          <SidebarGroup
            title={pinned ? "Pinned" : "My workspaces"}
            action={
              <WorkspaceActionsMenu
                name="Command menu"
                pinned={pinned}
                onPin={() => setPinned(!pinned)}
                onRename={() => setNotice("Rename selected.")}
                onArchive={() => setNotice("Archive selected.")}
                onCopyBranch={() => {
                  navigator.clipboard.writeText("feat/command-menu").then(
                    () => setNotice("Branch copied."),
                    () => setNotice("Copy unavailable."),
                  );
                }}
                sections={[
                  { id: "personal", label: "Personal" },
                  { id: "team", label: "Team" },
                ]}
                onMove={(section) => setNotice(`Moved to ${section}.`)}
              />
            }
          >
            <SidebarItem
              label="Workspace command menu"
              selected
              unread
              status="review"
              trailing={<DiffCount added={128} removed={24} />}
              onClick={() => setNotice("Workspace selected.")}
            />
            <SidebarItem
              label="Draft workspace"
              status="idle"
              onClick={() => setNotice("Draft selected.")}
            />
          </SidebarGroup>
          <Participants names={["You", "Review agent"]} />
        </section>
        <div className="lab-pattern-status-grid">
          {(Object.keys(WORKSPACE_STATUS_LABELS) as WorkspaceActivity[]).map((state) => (
            <WorkspaceActivityBadge key={state} state={state} />
          ))}
        </div>
      </div>
      <ChangeScopeToolbar
        scope={scope}
        onScopeChange={setScope}
        query={query}
        onQueryChange={setQuery}
        branches={[
          { value: "all", label: "All changes" },
          { value: "uncommitted", label: "Uncommitted" },
          { value: "main", label: "Against main" },
        ]}
      />
      {"src/App.tsx".toLowerCase().includes(query.toLowerCase()) ? (
        <FileDiff
          name="src/App.tsx"
          lines={[
            { type: "hunk", content: "@@ -12,3 +12,4 @@" },
            { type: "context", oldLine: 12, newLine: 12, content: "export function App() {" },
            { type: "removed", oldLine: 13, content: "  return <Workspace />;" },
            {
              type: "added",
              newLine: 13,
              content: "  return <Workspace onKeyDown={handleKey} />;",
            },
            { type: "context", oldLine: 14, newLine: 14, content: "}" },
          ]}
        />
      ) : (
        <WorkspaceEmpty type="changes" />
      )}
      <CheckRunList
        checks={checks}
        onRetry={(id) =>
          setChecks(
            checks.map((check) =>
              check.id === id ? { ...check, status: "running", detail: "Running again" } : check,
            ),
          )
        }
      />
      <NavigationPatternPreview />
      <Button size="sm" variant="outline" onClick={() => setCapability(!capability)}>
        {capability ? "Disable desktop and chat panels" : "Enable desktop and chat panels"}
      </Button>
      <WorkspacePanels
        value={panel}
        onChange={setPanel}
        panels={[
          { id: "changes", label: "Changes", content: <WorkspaceEmpty type="changes" /> },
          {
            id: "files",
            label: "Files",
            content: (
              <FileTree
                nodes={[{ id: "src", name: "src", children: [{ id: "app", name: "App.tsx" }] }]}
                onSelect={(file) => setNotice(`Opened ${file.name}`)}
              />
            ),
          },
          {
            id: "artifacts",
            label: "Artifacts",
            content: <p className="ui-pattern-empty">Artifacts appear here.</p>,
          },
          { id: "checks", label: "Checks", content: <CheckRunList checks={checks} /> },
          {
            id: "desktop",
            label: "Desktop",
            available: capability,
            content: (
              <p className="ui-pattern-empty">Desktop view supplied by the connected workspace.</p>
            ),
          },
          {
            id: "chat",
            label: "Chat",
            available: capability,
            content: <p className="ui-pattern-empty">Shared workspace chat.</p>,
          },
        ]}
      />
      <TerminalPanel
        value={terminal}
        onChange={setTerminal}
        sessions={[
          { id: "setup", label: "Setup", output: "", empty: "No setup command configured." },
          {
            id: "run",
            label: "Run",
            output: commandRunning ? "Preview command running…" : "Command complete.",
            running: commandRunning,
          },
          { id: "terminal", label: "Terminal", output: "~/workspace ❯\nLocal output specimen" },
        ]}
        onRun={() => {
          setTerminal("run");
          setCommandRunning(true);
        }}
        onStop={() => setCommandRunning(false)}
      />
      <TaskPatternPreview />
      <BackgroundTask
        title="Reviewing workspace"
        startedAt={startedAt}
        status={running ? "running" : "done"}
        onStop={() => setRunning(false)}
      >
        Waiting for the review agent.
      </BackgroundTask>
      {!running && (
        <Button size="sm" variant="outline" onClick={() => setRunning(true)}>
          Restart preview task
        </Button>
      )}
      <output className="lab-pattern-output" aria-live="polite">
        {notice || `Selected tab: ${selected}`}
      </output>
    </div>
  );
}
