import { CloudPreview } from "./cloud-preview";
import {
  Box,
  ChevronDown,
  ChevronRight,
  Folder,
  PanelLeft,
  PanelRight,
} from "lucide-react";
import { useEffect, useState } from "react";
import "../../../styles.css";
import { ArtifactView } from "../artifact";
import { Button } from "../button";
import {
  CommandDialog,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from "../command";
import { Composer, type ComposerAttachment } from "../composer";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "../dropdown-menu";
import {
  ChatStatus,
  Message,
  MessageBody,
  ThinkingMessage,
  ToolCall,
} from "../message";
import { TaskPanel, type TaskItem } from "../tasks";
import { ControlGallery } from "./control-gallery";
import { DetailsPreview } from "./details-preview";
import "./library.css";
import { SettingsPreview } from "./settings-preview";
import { PatternGallery } from "./pattern-gallery";
import { ModelPicker, type ModelSelection } from "../model-picker";
import { WorkspaceTabs, type WorkspaceTab } from "../workspace-tabs";
import { MessageQueue, type QueueEntry } from "../message-queue";
import { PermissionRequest, PlanReview } from "../chat-decisions";
import { ChatRecovery, CompactionSummary } from "../chat-recovery";
import { WorkspaceNavigation } from "./workspace-navigation";
import { previewModels } from "./model-fixtures";
import { WorkspaceDashboard } from "../workspace-dashboard";
import { WorkspaceHome } from "../workspace-home";
import { PullRequestView } from "../pull-request-view";
import { ContextLinkPicker } from "../context-link-picker";
import {
  Dialog,
  DialogContent,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from "../dialog";
import { Input } from "../input";
import { type GitWorkflowAction, type GitWorkflowState } from "../git-workflow";
import { workflowWorkspaces, previewPullRequest } from "./workflow-fixtures";
import { ComposerAddMenu, McpStatusMenu } from "../composer-tools";
import { FileDiff } from "../workspace-patterns";
import { FilePreview } from "../file-preview";
import { ToolGroup, TurnFooter, ResetChatDialog } from "../transcript-patterns";
const previewHtml =
  '<!doctype html><html><body style="margin:0;background:#141110;color:#eae8e6;font:14px system-ui;display:grid;place-items:center;height:100vh"><div style="width:80%;max-width:360px;border:1px solid #ffffff1a;border-radius:8px;background:#2c2826"><input id="query" placeholder="Search files and commands…" style="box-sizing:border-box;width:100%;padding:14px;background:none;border:0;border-bottom:1px solid #ffffff1a;color:inherit;outline:none"><div id="items" style="padding:8px"><button style="width:100%;text-align:left;background:#ffffff0d;border:0;color:inherit;padding:10px;border-radius:4px" onclick="this.textContent=\'Workspace created\'">＋ Create workspace</button><p style="padding:0 10px;color:#a5a09c;font-size:12px">An interactive artifact</p></div></div></body></html>';
const versions = [{ label: "Version 1", content: previewHtml }];
export function Library() {
  const [page, setPage] = useState(() =>
    window.location.hash.startsWith("#cloud") ? "cloud" : "workspace",
  );
  const [workspaces, setWorkspaces] = useState(workflowWorkspaces);
  const [workspaceId, setWorkspaceId] = useState("command");
  const currentWorkspace =
    workspaces.find((w) => w.id === workspaceId) ?? workspaces[0];
  const [pullRequest, setPullRequest] = useState(previewPullRequest);
  const [prChat, setPrChat] = useState("chat");
  const [planMode, setPlanMode] = useState(false);
  const [linkPicker, setLinkPicker] = useState<"issue" | "workspace">();
  const [rename, setRename] = useState<{ id: string; name: string }>();
  const overview = page === "dashboard" || page === "home";
  const [right, setRight] = useState("Changes");
  const [leftOpen, setLeftOpen] = useState(true);
  const [rightOpen, setRightOpen] = useState(() => window.innerWidth >= 1000);
  useEffect(() => {
    const media = window.matchMedia("(max-width: 999px)");
    const collapse = () => {
      if (media.matches) setRightOpen(false);
    };
    media.addEventListener("change", collapse);
    return () => media.removeEventListener("change", collapse);
  }, []);
  const [state, setState] = useState("Ready");
  const [draft, setDraft] = useState("");
  const [attachments, setAttachments] = useState<ComposerAttachment[]>([]);
  const [messages, setMessages] = useState<string[]>([]);
  const [command, setCommand] = useState(false);
  const [reset, setReset] = useState(false);
  const [model, setModel] = useState<ModelSelection>({
    model: "astra",
    effort: "High",
  });
  const [workspaceTabs, setWorkspaceTabs] = useState<WorkspaceTab[]>([
    { id: "chat", label: "Chat", kind: "chat" },
    { id: "review", label: "Review changes", kind: "view" },
  ]);
  const [activeTab, setActiveTab] = useState("chat");
  useEffect(() => {
    if (!workspaceTabs.some((tab) => tab.id === activeTab))
      setActiveTab(workspaceTabs[0]?.id ?? "");
  }, [activeTab, workspaceTabs]);
  const [queue, setQueue] = useState<QueueEntry[]>([]);
  const [paused, setPaused] = useState(false);
  const [minimized] = useState(false);
  const [notice, setNotice] = useState("");
  const [modelOrder, setModelOrder] = useState(
    previewModels.map((item) => item.id),
  );
  const [favorites, setFavorites] = useState(["opus", "sol"]);
  const [settingsPage, setSettingsPage] = useState("general");
  const [openFiles, setOpenFiles] = useState<
    Record<string, { name: string; path: string; content: string }>
  >({});
  const activeFile = openFiles[activeTab];
  const openFile = (file: { id: string; name: string }, content: string) => {
    const id = `file-${file.id}`;
    setOpenFiles((files) => ({
      ...files,
      [id]: {
        name: file.name,
        path:
          (
            {
              menu: "src/components/CommandMenu.tsx",
              workspace: "src/components/Workspace.tsx",
              theme: "src/styles/theme.css",
            } as Record<string, string>
          )[file.id] ?? file.name,
        content,
      },
    }));
    setWorkspaceTabs((tabs) =>
      tabs.some((tab) => tab.id === id)
        ? tabs
        : [...tabs, { id, label: file.name, kind: "file" }],
    );
    setActiveTab(id);
    setPage("workspace");
  };
  const openWorkspace = (id: string) => {
    setWorkspaceId(id);
    setPage("workspace");
    setActiveTab("chat");
    setWorkspaceTabs((tabs) =>
      tabs.some((t) => t.id === "chat")
        ? tabs
        : [{ id: "chat", label: "Chat", kind: "chat" }, ...tabs],
    );
    setState(id === "onboarding" ? "Empty" : "Ready");
  };
  const openPr = (id = workspaceId) => {
    const workspace = workspaces.find((w) => w.id === id);
    if (!workspace) return;
    setWorkspaceId(id);
    setPullRequest({
      ...previewPullRequest,
      number: workspace.workflow.prNumber ?? 43,
      title: workspace.title,
      branch: workspace.branch,
      added: workspace.added ?? 0,
      removed: workspace.removed ?? 0,
    });
    setWorkspaceTabs((tabs) =>
      tabs.some((t) => t.id === "pr")
        ? tabs.map((t) =>
            t.id === "pr"
              ? { ...t, label: `PR #${workspace.workflow.prNumber ?? 43}` }
              : t,
          )
        : [
            ...tabs,
            {
              id: "pr",
              label: `PR #${workspace.workflow.prNumber ?? 43}`,
              kind: "view",
            },
          ],
    );
    setActiveTab("pr");
    setPage("workspace");
  };
  const workflowAction = (id: string, action: GitWorkflowAction) => {
    if (action === "view-checks" || action === "view-logs") {
      setRight("Checks");
      setRightOpen(true);
      setPage("workspace");
      return;
    }
    if (action === "open-pr") {
      openPr(id);
      return;
    }
    if (action === "continue") {
      openWorkspace(id);
      setDraft("Continue on a new branch from main: ");
      return;
    }
    if (action === "archive") {
      setWorkspaces((items) =>
        items.map((w) => (w.id === id ? { ...w, archived: true } : w)),
      );
      setNotice("Workspace archived in this preview.");
      return;
    }
    const next: Partial<Record<GitWorkflowAction, GitWorkflowState>> = {
      "create-pr": "review-required",
      "create-draft-pr": "draft",
      "create-pr-manually": "draft",
      "commit-push": "checks-pending",
      push: "checks-pending",
      pull: "ready",
      sync: "ready",
      "resolve-conflicts": "working",
      "ready-for-review": "review-required",
      "fix-checks": "working",
      "address-comments": "working",
      review: "ready",
      "approve-pr": "ready",
      "enable-auto-merge": "checks-pending",
      "disable-auto-merge": "checks-pending",
      merge: "merged",
      "cancel-merge": "ready",
    };
    setWorkspaces((items) =>
      items.map((w) =>
        w.id === id
          ? {
              ...w,
              stage: action === "merge" ? "done" : w.stage,
              workflow: {
                ...w.workflow,
                state: next[action] ?? w.workflow.state,
                autoMergeEnabled:
                  action === "enable-auto-merge"
                    ? true
                    : action === "disable-auto-merge"
                      ? false
                      : w.workflow.autoMergeEnabled,
                canAutoMerge: true,
                prNumber: action.startsWith("create-")
                  ? 43
                  : w.workflow.prNumber,
              },
            }
          : w,
      ),
    );
    setNotice(
      "Preview workflow updated locally. No repository or remote service was changed.",
    );
    if (action === "create-pr-manually") openPr(id);
  };
  const copyText = async (text: string) => {
    try {
      await navigator.clipboard.writeText(text);
      setNotice("Copied to clipboard");
    } catch {
      setNotice("Clipboard access is unavailable in this browser.");
    }
  };
  const attachFile = (name: string) => {
    setAttachments((items) => [
      ...items,
      { id: crypto.randomUUID(), name, kind: "file" },
    ]);
    setActiveTab("chat");
    setPage("workspace");
  };
  const createWorkspace = () => {
    setState("Empty");
    setPage("workspace");
    setActiveTab("chat");
  };
  const [tasks, setTasks] = useState<TaskItem[]>([
    {
      id: "1",
      subject: "Review navigation and shortcuts",
      status: "completed",
    },
    { id: "2", subject: "Build the command menu", status: "completed" },
    {
      id: "3",
      subject: "Verify focus and dismissal",
      description: "Keyboard navigation, Escape, and restored focus.",
      status: "in_progress",
    },
  ]);
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (!event.metaKey && !event.ctrlKey) return;
      if (event.key.toLowerCase() === "k") {
        event.preventDefault();
        setPage("workspace");
        setCommand(true);
      }
      if (event.key.toLowerCase() === "i") {
        event.preventDefault();
        setLinkPicker("issue");
      }
      if (event.shiftKey && event.key.toLowerCase() === "h") {
        event.preventDefault();
        setPage("home");
      }
      if (event.key === ",") {
        event.preventDefault();
        setPage("settings");
      }
      if (event.key.toLowerCase() === "b") {
        event.preventDefault();
        if (event.altKey) {
          setRightOpen((open) => !open);
          if (window.innerWidth < 1000) setLeftOpen(false);
        } else {
          setLeftOpen((open) => !open);
          if (window.innerWidth < 1000) setRightOpen(false);
        }
      }
      if (event.key.toLowerCase() === "n") {
        event.preventDefault();
        setPage("workspace");
        setMessages([]);
        setState("Empty");
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);
  const select = (value: string) => {
    setPage(value);
    setCommand(false);
  };
  const send = () => {
    if (!draft.trim() && !attachments.length) return;
    const text =
      draft || attachments.map((attachment) => attachment.name).join(", ");
    if (state === "Working")
      setQueue((items) => [...items, { id: crypto.randomUUID(), text }]);
    else setMessages((previous) => [...previous, text]);
    setDraft("");
    setAttachments([]);
    setNotice("Message added to this preview. No agent request was sent.");
  };
  if (page === "cloud")
    return (
      <CloudPreview
        initialPage={location.hash.split("/")[1] || "workspace"}
        onBack={() => {
          history.replaceState(null, "", location.pathname);
          setPage("workspace");
        }}
      />
    );
  if (page === "settings")
    return (
      <SettingsPreview
        onCloud={() => setPage("cloud")}
        initialPage={settingsPage}
        models={previewModels}
        favorites={favorites}
        onFavoritesChange={setFavorites}
        onBack={() => {
          setSettingsPage("general");
          select("workspace");
        }}
      />
    );
  return (
    <div className="lab-app">
      {leftOpen && (
        <WorkspaceNavigation
          page={page}
          workspaces={workspaces}
          onOpenWorkspace={openWorkspace}
          onWorkflowAction={workflowAction}
          activity={state}
          onSelect={select}
          onCreate={() => {
            setState("Empty");
            select("workspace");
          }}
          onSearch={() => setCommand(true)}
          onHide={() => setLeftOpen(false)}
          onState={setState}
        />
      )}
      <main className="lab-main">
        {page !== "home" && (
          <header className="lab-header">
            {!leftOpen && (
              <Button
                variant="ghost"
                size="icon-sm"
                aria-label="Show sidebar"
                onClick={() => {
                  setLeftOpen(true);
                  if (window.innerWidth < 1000) setRightOpen(false);
                }}
              >
                <PanelLeft />
              </Button>
            )}
            {!overview && (
              <>
                <Folder size={16} />
                <span className="lab-dim">interface-system</span>
                <ChevronRight size={14} />
              </>
            )}
            <span>
              {page === "workspace"
                ? currentWorkspace.title
                : page.charAt(0).toUpperCase() + page.slice(1)}
            </span>
            <div style={{ flex: 1 }} />
            {!overview && (
              <>
                <DropdownMenu>
                  <DropdownMenuTrigger asChild>
                    <Button variant="ghost" size="sm">
                      {state}
                      <ChevronDown />
                    </Button>
                  </DropdownMenuTrigger>
                  <DropdownMenuContent align="end">
                    {[
                      "Ready",
                      "Empty",
                      "Working",
                      "Permission",
                      "Plan",
                      "Error",
                      "Compacted",
                    ].map((item) => (
                      <DropdownMenuItem
                        key={item}
                        onSelect={() => {
                          setState(item);
                          select("workspace");
                        }}
                      >
                        {item}
                      </DropdownMenuItem>
                    ))}
                  </DropdownMenuContent>
                </DropdownMenu>
                <Button
                  variant="ghost"
                  size="icon-sm"
                  aria-label="Toggle right sidebar"
                  onClick={() => {
                    setRightOpen(!rightOpen);
                    if (window.innerWidth < 1000) setLeftOpen(false);
                  }}
                >
                  <PanelRight />
                </Button>
              </>
            )}
          </header>
        )}
        {page === "workspace" && (
          <>
            <WorkspaceTabs
              tabs={workspaceTabs}
              value={activeTab}
              onChange={(id) => {
                setActiveTab(id);
                if (id === "review") {
                  setRight("Changes");
                  setRightOpen(true);
                  if (window.innerWidth < 1000) setLeftOpen(false);
                }
              }}
              onRename={(id) =>
                setRename({
                  id,
                  name: workspaceTabs.find((t) => t.id === id)?.label ?? "Chat",
                })
              }
              onMarkUnread={(id, unread) =>
                setWorkspaceTabs((tabs) =>
                  tabs.map((t) => (t.id === id ? { ...t, unread } : t)),
                )
              }
              onFork={(id) => {
                const next = crypto.randomUUID();
                setWorkspaceTabs((tabs) => [
                  ...tabs,
                  {
                    id: next,
                    label: `${tabs.find((t) => t.id === id)?.label ?? "Chat"} · fork`,
                    kind: "chat",
                  },
                ]);
                setActiveTab(next);
              }}
              onCopyTranscript={(_id, full) =>
                copyText(
                  `${full ? "User: Build a command menu for the workspace.\n\nTool: Read Workspace.tsx\nTool: Edited CommandMenu.tsx\n\n" : ""}Assistant: The command menu is ready. Fuzzy search, keyboard navigation, and shared surface tokens.\n${messages.join("\n")}`,
                )
              }
              onCopyLink={(id) =>
                copyText(
                  `${location.origin}${location.pathname}#chat=${encodeURIComponent(id)}`,
                )
              }
              fileActions={(tab) => ({
                onAttach: () =>
                  attachFile(openFiles[tab.id]?.path ?? tab.label),
                onCopyPath: () =>
                  copyText(
                    `/interface-system/${openFiles[tab.id]?.path ?? tab.label}`,
                  ),
                onCopyRelativePath: () =>
                  copyText(openFiles[tab.id]?.path ?? tab.label),
              })}
              onClose={(id) => {
                setWorkspaceTabs((tabs) => tabs.filter((tab) => tab.id !== id));
              }}
              onNew={() => {
                const id = crypto.randomUUID();
                setWorkspaceTabs((tabs) => [
                  ...tabs,
                  { id, label: "New chat" },
                ]);
                setActiveTab(id);
                setState("Empty");
                setMessages([]);
              }}
              onReorder={(ids) =>
                setWorkspaceTabs(
                  ids.map((id) => workspaceTabs.find((tab) => tab.id === id)!),
                )
              }
            />
            {activeTab === "pr" ? (
              <PullRequestView
                request={pullRequest}
                workflow={currentWorkspace.workflow}
                onChange={setPullRequest}
                onAction={(action) => workflowAction(workspaceId, action)}
                availableReviewers={["Design team", "Frontend team"]}
                composer={
                  <>
                    <div className="lab-pr-sending">
                      Sending to{" "}
                      <DropdownMenu>
                        <DropdownMenuTrigger asChild>
                          <Button size="xs" variant="ghost">
                            {workspaceTabs.find((tab) => tab.id === prChat)
                              ?.label ?? "Chat"}
                            <ChevronDown />
                          </Button>
                        </DropdownMenuTrigger>
                        <DropdownMenuContent side="top" align="start">
                          {workspaceTabs
                            .filter((tab) => !tab.kind || tab.kind === "chat")
                            .map((tab) => (
                              <DropdownMenuItem
                                key={tab.id}
                                onSelect={() => setPrChat(tab.id)}
                              >
                                {tab.label}
                              </DropdownMenuItem>
                            ))}
                        </DropdownMenuContent>
                      </DropdownMenu>
                    </div>
                    <Composer value={draft} onChange={setDraft} onSend={send} />
                  </>
                }
              />
            ) : activeTab === "review" ? (
              <div className="lab-transcript">
                <FileDiff
                  name="src/components/CommandMenu.tsx"
                  lines={[
                    { type: "hunk", content: "@@ -1,3 +1,5 @@" },
                    {
                      type: "context",
                      oldLine: 1,
                      newLine: 1,
                      content: 'import { useState } from "react";',
                    },
                    {
                      type: "added",
                      newLine: 2,
                      content: 'const [query, setQuery] = useState("");',
                    },
                    {
                      type: "added",
                      newLine: 3,
                      content:
                        "const results = filterCommands(commands, query);",
                    },
                  ]}
                />
              </div>
            ) : activeFile ? (
              <FilePreview
                name={activeFile.name}
                kind="text"
                content={activeFile.content}
                onClose={() => {
                  setWorkspaceTabs((tabs) =>
                    tabs.filter((tab) => tab.id !== activeTab),
                  );
                  setActiveTab("chat");
                }}
              />
            ) : (
              <>
                <div className="lab-transcript">
                  <div className="lab-transcript-inner">
                    {state === "Empty" ? (
                      <div className="lab-empty">
                        <h1>What would you like to build?</h1>
                        <p>Start a conversation in this workspace.</p>
                      </div>
                    ) : (
                      <>
                        <Message role="user">
                          <MessageBody tone="user">
                            Build a command menu for the workspace. It should
                            support fuzzy search, keyboard navigation, and quick
                            actions for opening files.
                          </MessageBody>
                        </Message>
                        <ThinkingMessage duration="8s">
                          I’ll review the existing workspace navigation and
                          keyboard handling, then add a command menu using the
                          shared components.
                        </ThinkingMessage>
                        <Message role="assistant">
                          <MessageBody>
                            I’ll check how navigation and shortcuts are wired
                            up, then add the command menu.
                          </MessageBody>
                        </Message>
                        <ToolGroup count={2}>
                          <ToolCall title="Read src/components/Workspace.tsx">
                            Read the workspace layout and existing keyboard
                            shortcuts.
                          </ToolCall>
                          <ToolCall title="Edited src/components/CommandMenu.tsx">
                            Added command filtering and keyboard navigation.
                          </ToolCall>
                        </ToolGroup>
                        <Message role="assistant">
                          <MessageBody>
                            <p>The command menu is ready. It includes:</p>
                            <ul>
                              <li>
                                <strong>Fuzzy search</strong> across files and
                                workspace actions
                              </li>
                              <li>
                                <strong>Keyboard navigation</strong> with ↑ / ↓,
                                Enter, and Escape
                              </li>
                              <li>
                                A compact menu using the shared surface colors
                                and spacing
                              </li>
                            </ul>
                            <button
                              className="lab-inline-artifact"
                              onClick={() => select("artifacts")}
                            >
                              <Box size={14} />
                              <span>Workspace command menu</span>
                              <ChevronRight size={12} />
                            </button>
                            <TurnFooter
                              duration="8s"
                              timestamp="Today"
                              text="The command menu is ready."
                              usage={{
                                model: "GPT-6 Astra",
                                input: 4210,
                                output: 920,
                              }}
                              onFork={() => {
                                const id = crypto.randomUUID();
                                setWorkspaceTabs((tabs) => [
                                  ...tabs,
                                  { id, label: "Command menu · fork" },
                                ]);
                                setActiveTab(id);
                              }}
                              onReset={() => setReset(true)}
                              onFeedback={(positive) =>
                                setNotice(
                                  positive
                                    ? "Feedback saved: good response"
                                    : "Feedback saved: needs improvement",
                                )
                              }
                            />
                          </MessageBody>
                        </Message>
                      </>
                    )}
                    {messages.map((message, i) => (
                      <Message role="user" key={i}>
                        <MessageBody tone="user">{message}</MessageBody>
                      </Message>
                    ))}
                    {state === "Working" && (
                      <ChatStatus
                        state="working"
                        action={
                          <Button
                            size="xs"
                            variant="outline"
                            onClick={() => setState("Ready")}
                          >
                            Stop
                          </Button>
                        }
                      >
                        Working…
                      </ChatStatus>
                    )}
                    {state === "Permission" && (
                      <PermissionRequest
                        title="Run the workspace tests?"
                        command="bun test"
                        choices={[
                          { id: "once", label: "Allow once", primary: true },
                          { id: "session", label: "Allow for this session" },
                          { id: "deny", label: "Deny" },
                        ]}
                        onChoose={(choice) => {
                          setState("Ready");
                          setNotice(`Preview permission: ${choice}`);
                        }}
                      />
                    )}
                    {state === "Error" && (
                      <ChatRecovery
                        kind="generic"
                        onRetry={() => setState("Ready")}
                      />
                    )}
                    {state === "Plan" && (
                      <PlanReview
                        text="Review navigation, build the menu, verify keyboard interaction."
                        onExecute={() => setState("Working")}
                        onRevise={() => setDraft("Revise the plan: ")}
                      >
                        <TaskPanel
                          tasks={tasks}
                          onStatusChange={(id, status) =>
                            setTasks(
                              tasks.map((task) =>
                                task.id === id ? { ...task, status } : task,
                              ),
                            )
                          }
                        />
                      </PlanReview>
                    )}
                    {state === "Compacted" && (
                      <CompactionSummary>
                        Earlier context was summarized. Your conversation
                        continues here.
                      </CompactionSummary>
                    )}
                  </div>
                </div>
                <div className="lab-composer-area">
                  <Composer
                    value={draft}
                    onChange={setDraft}
                    onSend={send}
                    mode={state === "Working" ? "queue" : "send"}
                    minimized={minimized}
                    suggestions={[
                      {
                        id: "workspace",
                        label: "src/Workspace.tsx",
                        kind: "mention",
                        insertText: "@src/Workspace.tsx",
                      },
                      {
                        id: "review",
                        label: "/review",
                        kind: "command",
                        insertText: "/review",
                      },
                    ]}
                    queue={
                      <MessageQueue
                        items={queue}
                        onChange={setQueue}
                        paused={paused}
                        onPausedChange={setPaused}
                        onSteer={(item) => {
                          setMessages((messages) => [...messages, item.text]);
                          setQueue((items) =>
                            items.filter((queued) => queued.id !== item.id),
                          );
                        }}
                      />
                    }
                    running={state === "Working"}
                    onStop={() => setState("Ready")}
                    attachments={attachments}
                    onRemoveAttachment={(id) =>
                      setAttachments((previous) =>
                        previous.filter((file) => file.id !== id),
                      )
                    }
                    onAttach={(files) =>
                      setAttachments((previous) => [
                        ...previous,
                        ...files.map((file) => ({
                          id: crypto.randomUUID(),
                          name: file.name,
                        })),
                      ])
                    }
                    planMode={planMode}
                    onPlanModeChange={setPlanMode}
                    renderAddMenu={(openFileDialog) => (
                      <ComposerAddMenu
                        onAttach={openFileDialog}
                        onWorkspace={() => setLinkPicker("workspace")}
                        onIssue={() => setLinkPicker("issue")}
                        onPlan={() => setPlanMode(!planMode)}
                        planMode={planMode}
                      />
                    )}
                    actions={
                      <McpStatusMenu
                        servers={[]}
                        onConfigure={() => {
                          setSettingsPage("agents");
                          select("settings");
                        }}
                      />
                    }
                    footer={
                      <ModelPicker
                        shortcuts
                        models={modelOrder.map(
                          (id) => previewModels.find((item) => item.id === id)!,
                        )}
                        value={model}
                        onChange={setModel}
                        visibleIds={favorites}
                        onReorder={setModelOrder}
                        onEdit={() => {
                          setSettingsPage("models");
                          select("settings");
                        }}
                      />
                    }
                  />
                  {notice && (
                    <div role="status" className="lab-notice">
                      {notice}
                      <button
                        onClick={() => setNotice("")}
                        aria-label="Dismiss notice"
                      >
                        ×
                      </button>
                    </div>
                  )}
                </div>
              </>
            )}
          </>
        )}
        {page === "components" && (
          <ControlGallery
            tasks={tasks}
            setTasks={setTasks}
            setCommand={setCommand}
          />
        )}
        {page === "patterns" && <PatternGallery />}
        {page === "artifacts" && (
          <ArtifactView title="Workspace command menu" versions={versions} />
        )}
        {page === "dashboard" && (
          <WorkspaceDashboard
            workspaces={workspaces}
            onOpen={openWorkspace}
            onMove={(id, stage) =>
              setWorkspaces((items) =>
                items.map((w) => (w.id === id ? { ...w, stage } : w)),
              )
            }
            onAction={workflowAction}
            onCreate={createWorkspace}
            onArchive={(id) => workflowAction(id, "archive")}
          />
        )}
        {page === "home" && (
          <WorkspaceHome
            leading={
              !leftOpen && (
                <Button
                  variant="ghost"
                  size="iconSm"
                  aria-label="Show sidebar"
                  onClick={() => setLeftOpen(true)}
                >
                  <PanelLeft />
                </Button>
              )
            }
            workspaces={workspaces}
            onOpen={openWorkspace}
            onCreate={createWorkspace}
            onAction={workflowAction}
          />
        )}
      </main>
      {rightOpen && !overview && (
        <DetailsPreview
          workflow={currentWorkspace.workflow}
          onWorkflowAction={(action) => workflowAction(workspaceId, action)}
          onOpenPr={() => openPr()}
          onAttachFile={attachFile}
          onCopy={copyText}
          tab={right}
          onTabChange={setRight}
          tasks={tasks}
          onTaskChange={(id, status) =>
            setTasks((previous) =>
              previous.map((task) =>
                task.id === id ? { ...task, status } : task,
              ),
            )
          }
          onOpenFile={openFile}
          onArtifact={() => select("artifacts")}
        />
      )}
      <ContextLinkPicker
        onCloseAutoFocus={(event) => {
          event.preventDefault();
          document
            .querySelector<HTMLTextAreaElement>(".ui-composer textarea")
            ?.focus();
        }}
        kind={linkPicker ?? "workspace"}
        open={!!linkPicker}
        onOpenChange={(open) => {
          if (!open) setLinkPicker(undefined);
        }}
        items={
          linkPicker === "issue"
            ? [
                {
                  id: "issue-12",
                  title: "UI-12 Refine workspace navigation",
                  group: "Linear",
                  detail: "In progress",
                },
                {
                  id: "issue-28",
                  title: "#28 Keyboard shortcuts",
                  group: "GitHub",
                  detail: "interface-system",
                },
              ]
            : workspaces
                .filter((w) => w.id !== workspaceId)
                .map((w) => ({
                  id: w.id,
                  title: w.title,
                  detail: w.branch,
                  group: w.project,
                  linked: attachments.some((a) => a.id === w.id),
                }))
        }
        onSelect={(item) =>
          setAttachments((items) => [
            ...items,
            { id: item.id, name: item.title, kind: linkPicker },
          ])
        }
        onBrowse={
          linkPicker === "workspace"
            ? () => {
                setLinkPicker(undefined);
                setNotice(
                  "Directory linking requires a host folder picker. Workspace links are available in this preview.",
                );
              }
            : undefined
        }
      />
      <Dialog
        open={!!rename}
        onOpenChange={(open) => {
          if (!open) setRename(undefined);
        }}
      >
        <DialogContent
          onCloseAutoFocus={(event) => {
            event.preventDefault();
            requestAnimationFrame(() =>
              document
                .querySelector<HTMLButtonElement>(
                  '.ui-workspace-tab [aria-selected="true"]',
                )
                ?.focus(),
            );
          }}
        >
          <DialogTitle>Rename chat</DialogTitle>
          <DialogDescription>Choose a name for this chat.</DialogDescription>
          <Input
            autoFocus
            aria-label="Chat name"
            value={rename?.name ?? ""}
            onChange={(e) =>
              setRename(
                rename ? { ...rename, name: e.target.value } : undefined,
              )
            }
            onKeyDown={(e) => {
              if (e.key === "Enter" && rename?.name.trim()) {
                setWorkspaceTabs((tabs) =>
                  tabs.map((t) =>
                    t.id === rename.id
                      ? { ...t, label: rename.name.trim() }
                      : t,
                  ),
                );
                setRename(undefined);
              }
            }}
          />
          <DialogFooter>
            <Button variant="ghost" onClick={() => setRename(undefined)}>
              Cancel
            </Button>
            <Button
              disabled={!rename?.name.trim()}
              onClick={() => {
                if (rename)
                  setWorkspaceTabs((tabs) =>
                    tabs.map((t) =>
                      t.id === rename.id
                        ? { ...t, label: rename.name.trim() }
                        : t,
                    ),
                  );
                setRename(undefined);
              }}
            >
              Save
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
      <ResetChatDialog
        open={reset}
        onOpenChange={setReset}
        onReset={() => {
          setMessages([]);
          setState("Ready");
          setReset(false);
        }}
      />
      <CommandDialog open={command} onOpenChange={setCommand}>
        <CommandInput placeholder="Search files and commands…" />
        <CommandList>
          <CommandEmpty>No results found.</CommandEmpty>
          <CommandGroup heading="Navigate">
            {[
              "workspace",
              "home",
              "dashboard",
              "components",
              "patterns",
              "artifacts",
              "settings",
            ].map((item) => (
              <CommandItem key={item} onSelect={() => select(item)}>
                {item.charAt(0).toUpperCase() + item.slice(1)}
              </CommandItem>
            ))}
          </CommandGroup>
        </CommandList>
      </CommandDialog>
    </div>
  );
}
