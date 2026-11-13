import {
  GitWorkflowToolbar,
  GitChangeScope,
  type GitWorkflow,
  type GitWorkflowAction,
} from "../git-workflow";
import { FileActionsMenu } from "../file-actions-menu";
import { useEffect, useRef, useState } from "react";
import { ChevronDown, ChevronLeft, ChevronRight, Eye, Search, Plus } from "lucide-react";
import { Sidebar, DiffCount } from "../sidebar";
import { FileTree, type FileTreeNode } from "../file-tree";
import { Tabs, TabsList, TabsTrigger, TabsContent } from "../tab-panels";
import { Button } from "../button";
import { TaskPanel, type TaskItem } from "../tasks";
import { WorkspaceArtifacts } from "../workspace-artifacts";
import { CheckRunList } from "../workspace-patterns";
import { Input } from "../input";

import { Dialog, DialogContent, DialogTitle, DialogDescription, DialogFooter } from "../dialog";
import { Checkbox } from "../checkbox";
const files: FileTreeNode[] = [
  {
    id: "src",
    name: "src",
    children: [
      {
        id: "components",
        name: "components",
        children: [
          { id: "menu", name: "CommandMenu.tsx", status: "added", added: 96, removed: 0 },
          { id: "workspace", name: "Workspace.tsx", status: "modified", added: 24, removed: 18 },
        ],
      },
      {
        id: "styles",
        name: "styles",
        children: [{ id: "theme", name: "theme.css", status: "modified", added: 8, removed: 6 }],
      },
    ],
  },
  { id: "package", name: "package.json" },
  { id: "readme", name: "README.md" },
];
const changedFiles = files[0].children!.flatMap((node) => node.children!);
const code: Record<string, string> = {
  menu: 'import { useEffect, useRef, useState } from "react";\n\nexport function CommandMenu() {\n  const [query, setQuery] = useState("");\n  return <input value={query} onChange={e => setQuery(e.target.value)} />;\n}',
  workspace: "export function Workspace() {\n  return <WorkspaceLayout />;\n}",
  theme: ":root {\n  --surface: #141110;\n  --foreground: #eae8e6;\n}",
  package: '{ "name": "interface-preview", "private": true }',
  readme: "# Workspace command menu\n\nInteractive interface preview.",
};
export function DetailsPreview({
  tab,
  onTabChange,
  tasks,
  onTaskChange,
  onArtifact,
  onOpenFile,
  workflow,
  onWorkflowAction,
  onOpenPr,
  onAttachFile,
  onCopy,
}: {
  workflow: GitWorkflow;
  onWorkflowAction: (action: GitWorkflowAction) => void;
  onOpenPr: () => void;
  onAttachFile: (name: string) => void;
  onCopy: (text: string) => void;
  tab: string;
  onTabChange: (tab: string) => void;
  tasks: TaskItem[];
  onTaskChange: (id: string, status: TaskItem["status"]) => void;
  onArtifact: () => void;
  onOpenFile?: (file: FileTreeNode, content: string) => void;
}) {
  const tabsRef = useRef<HTMLDivElement>(null);
  const [tabOverflow, setTabOverflow] = useState({ left: false, right: false });
  useEffect(() => {
    const element = tabsRef.current;
    if (!element) return;
    const update = () =>
      setTabOverflow({
        left: element.scrollLeft > 1,
        right: element.scrollLeft + element.clientWidth < element.scrollWidth - 1,
      });
    const observer = new ResizeObserver(update);
    observer.observe(element);
    element.addEventListener("scroll", update);
    update();
    return () => {
      observer.disconnect();
      element.removeEventListener("scroll", update);
    };
  }, []);
  const [searchOpen, setSearchOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [scope, setScope] = useState("uncommitted");
  const [targetBranch, setTargetBranch] = useState("main");
  const [discard, setDiscard] = useState<FileTreeNode>();
  const [discarded, setDiscarded] = useState<string[]>([]);
  const paths: Record<string, string> = {
    menu: "src/components/CommandMenu.tsx",
    workspace: "src/components/Workspace.tsx",
    theme: "src/styles/theme.css",
    package: "package.json",
    readme: "README.md",
  };
  const wrapFile = (file: FileTreeNode, row: React.ReactNode) => (
    <FileActionsMenu
      onView={file.children ? undefined : () => selectFile(file)}
      onAttach={file.children ? undefined : () => onAttachFile(paths[file.id] ?? file.name)}
      onCopyPath={() => onCopy(`/interface-system/${paths[file.id] ?? file.name}`)}
      onCopyRelativePath={() => onCopy(paths[file.id] ?? file.name)}
      onDiscard={file.status && !discarded.includes(file.id) ? () => setDiscard(file) : undefined}
    >
      {row}
    </FileActionsMenu>
  );
  const [terminals, setTerminals] = useState(["Terminal"]);
  const selectFile = (file: FileTreeNode) => {
    if (onOpenFile) onOpenFile(file, code[file.id] ?? "");
    else setSelected(file);
  };
  const filterFiles = (nodes: FileTreeNode[]): FileTreeNode[] =>
    nodes.flatMap((node) => {
      const children = node.children ? filterFiles(node.children) : undefined;
      return !query || node.name.toLowerCase().includes(query.toLowerCase()) || children?.length
        ? [{ ...node, children }]
        : [];
    });
  const [selected, setSelected] = useState<FileTreeNode>();
  const [terminal, setTerminal] = useState("Terminal");
  const [terminalOpen, setTerminalOpen] = useState(true);
  const [reviewed, setReviewed] = useState<string[]>([]);
  return (
    <Sidebar
      side="right"
      defaultWidth={360}
      minWidth={280}
      maxWidth={640}
      resizable
      aria-label="Workspace details"
    >
      <GitWorkflowToolbar workflow={workflow} onAction={onWorkflowAction} onOpenPr={onOpenPr} />
      <Tabs className="lab-details-body" value={tab} onValueChange={onTabChange}>
        <div className="lab-right-toolbar">
          {tabOverflow.left && (
            <Button
              size="iconXs"
              variant="ghost"
              aria-label="Scroll details tabs left"
              onClick={() => tabsRef.current?.scrollBy({ left: -120, behavior: "smooth" })}
            >
              <ChevronLeft />
            </Button>
          )}
          <TabsList ref={tabsRef} className="lab-right-tabs" aria-label="Workspace details tabs">
            {["Artifacts", "All files", "Changes", "Checks", "Tasks"].map((name) => (
              <TabsTrigger key={name} value={name}>
                {name}
                {name === "Changes" && <small>3</small>}
              </TabsTrigger>
            ))}
          </TabsList>
          {tabOverflow.right && (
            <Button
              size="iconXs"
              variant="ghost"
              aria-label="Scroll details tabs right"
              onClick={() => tabsRef.current?.scrollBy({ left: 120, behavior: "smooth" })}
            >
              <ChevronRight />
            </Button>
          )}
          <Button
            size="sm"
            variant="ghost"
            onClick={() => onTabChange("Review")}
            aria-pressed={tab === "Review"}
          >
            <Eye size={14} />
            Review
          </Button>
          <Button
            size="iconXs"
            variant="ghost"
            aria-label="Search files"
            onClick={() => setSearchOpen(!searchOpen)}
          >
            <Search />
          </Button>
        </div>
        {searchOpen && (
          <Input
            autoFocus
            className="lab-details-search"
            aria-label="Filter files"
            placeholder="Filter files…"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
          />
        )}
        <TabsContent value="Checks" className="lab-detail-panel">
          <CheckRunList
            checks={[
              {
                id: "types",
                title: "Type check",
                status: "passed",
                detail: "Completed successfully",
              },
              { id: "tests", title: "Unit tests", status: "passed", detail: "All checks passed" },
            ]}
          />
        </TabsContent>
        <TabsContent value="Tasks" className="lab-detail-panel">
          <TaskPanel tasks={tasks} onStatusChange={onTaskChange} />
        </TabsContent>
        <TabsContent value="Artifacts" className="lab-detail-panel">
          <WorkspaceArtifacts
            changes={{ added: 128, removed: 24, files: 3 }}
            onChanges={() => onTabChange("Changes")}
            items={[
              {
                id: "menu",
                title: "Workspace command menu",
                type: "HTML",
                preview: (
                  <pre>
                    {
                      "Command menu\n\nSearch files and commands…\n＋ Create workspace\n⌘ K  Open search"
                    }
                  </pre>
                ),
              },
              {
                id: "readme",
                title: "README.md",
                type: "MD",
                preview: (
                  <pre>
                    {
                      "# Workspace command menu\n\nFuzzy search, keyboard navigation,\nand quick workspace actions."
                    }
                  </pre>
                ),
              },
            ]}
            onOpen={(id) =>
              id === "menu" ? onArtifact() : selectFile({ id: "readme", name: "README.md" })
            }
          />
        </TabsContent>
        <TabsContent value="All files" className="lab-detail-panel">
          <FileTree
            nodes={filterFiles(files)}
            defaultExpanded={["src", "components", "styles"]}
            selected={selected?.id}
            onSelect={selectFile}
            wrapRow={wrapFile}
          />
        </TabsContent>
        <TabsContent value="Changes" className="lab-detail-panel">
          <div className="lab-change-scope">
            <GitChangeScope
              branch={workflow.branch ?? "workspace-command-menu"}
              targetBranch={targetBranch}
              branches={["main", "develop"]}
              scope={scope}
              onScopeChange={setScope}
              onTargetBranchChange={setTargetBranch}
              changedFiles={3 - discarded.length}
              commits={[
                {
                  id: "f13a2c7",
                  message: "Polish keyboard navigation",
                  author: "You",
                  date: "20m ago",
                },
                { id: "b82c9a1", message: "Add command menu", author: "You", date: "1h ago" },
              ]}
            />
            <DiffCount added={128} removed={24} />
          </div>
          <FileTree
            nodes={filterFiles(changedFiles.filter((file) => !discarded.includes(file.id)))}
            label="Changed files"
            selected={selected?.id}
            onSelect={selectFile}
            wrapRow={wrapFile}
          />
        </TabsContent>
        <TabsContent value="Review" className="lab-detail-panel">
          <div className="lab-section-caption">{reviewed.length} of 3 files reviewed</div>
          {changedFiles.map((file) => (
            <div className="lab-review-row" key={file.id}>
              <Checkbox
                aria-label={`Mark ${file.name} reviewed`}
                checked={reviewed.includes(file.id)}
                onCheckedChange={(value) =>
                  setReviewed((previous) =>
                    value ? [...previous, file.id] : previous.filter((id) => id !== file.id),
                  )
                }
              />
              <button onClick={() => selectFile(file)}>{file.name}</button>
              <DiffCount added={file.added ?? 0} removed={file.removed ?? 0} />
            </div>
          ))}
        </TabsContent>
      </Tabs>
      {selected && (
        <section className="lab-file-preview">
          <header>
            <span>{selected.name}</span>
            <Button variant="ghost" size="xs" onClick={() => setSelected(undefined)}>
              Close file
            </Button>
          </header>
          <pre>{code[selected.id]}</pre>
        </section>
      )}
      <section className="lab-terminal">
        <Tabs value={terminal} onValueChange={setTerminal}>
          <div className="lab-terminal-toolbar">
            <Button
              size="icon-sm"
              variant="ghost"
              aria-label={terminalOpen ? "Collapse terminal" : "Expand terminal"}
              aria-expanded={terminalOpen}
              onClick={() => setTerminalOpen(!terminalOpen)}
            >
              <ChevronDown style={{ transform: terminalOpen ? undefined : "rotate(-90deg)" }} />
            </Button>
            <TabsList aria-label="Terminal tabs">
              {["Setup", "Run", ...terminals].map((name) => (
                <TabsTrigger key={name} value={name}>
                  {name}
                </TabsTrigger>
              ))}
            </TabsList>
            <Button
              size="iconXs"
              variant="ghost"
              aria-label="New terminal"
              onClick={() => {
                const name = `Terminal ${terminals.length + 1}`;
                setTerminals([...terminals, name]);
                setTerminal(name);
              }}
            >
              <Plus />
            </Button>
          </div>
          {terminalOpen && (
            <>
              {terminals.map((name) => (
                <TabsContent value={name} key={name}>
                  <pre>
                    ~/interface-system ❯
                    <span className="lab-terminal-note">Terminal appearance preview</span>
                  </pre>
                </TabsContent>
              ))}
              <TabsContent value="Setup">
                <div className="lab-terminal-empty">No setup command configured.</div>
              </TabsContent>
              <TabsContent value="Run">
                <div className="lab-terminal-empty">No process running.</div>
              </TabsContent>
            </>
          )}
        </Tabs>
      </section>
      <Dialog
        open={!!discard}
        onOpenChange={(open) => {
          if (!open) setDiscard(undefined);
        }}
      >
        <DialogContent>
          <DialogTitle>Discard changes?</DialogTitle>
          <DialogDescription>
            Remove the changes to {discard?.name} from this preview.
          </DialogDescription>
          <DialogFooter>
            <Button variant="ghost" onClick={() => setDiscard(undefined)}>
              Cancel
            </Button>
            <Button
              variant="destructive"
              onClick={() => {
                if (discard) setDiscarded((items) => [...items, discard.id]);
                setDiscard(undefined);
              }}
            >
              Discard changes
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </Sidebar>
  );
}
