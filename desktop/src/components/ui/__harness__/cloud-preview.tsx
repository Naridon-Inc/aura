import { ExampleApiSettings, ExampleOrganizationSettings, ExamplePlanSettings } from "./cloud-settings-examples";
import { CloudHome } from "../cloud-home";
import { CloudRunPanel } from "../cloud-run-panel";
import { CloudWorkspaceCreateDialog } from "../cloud-workspace-create";
import { ContextLinkPicker } from "../context-link-picker";
import { CloudOnboarding, type CloudSetupResult } from "../cloud-onboarding";
import { WorkspaceShare, type WorkspaceAccess } from "../cloud-sharing";
import {
  CloudRoutines,
  type CloudRoutine,
  type RoutineNavigationGuard,
} from "../cloud-routines";
import {
  CloudRepositorySettings,
  CloudPortsSettings,
  CloudSecuritySettings,
  CloudMobilePreview,
} from "../cloud-services";
import { FileDiff } from "../workspace-patterns";
import { FileActionsMenu } from "../file-actions-menu";
import { type GitWorkflowAction, type GitWorkflowState } from "../git-workflow";
// No pictures of the computer ship with the harness: the parts draw their own
// art when a colour has no image, as they do in the app.
const computerImages: Record<"bondi" | "tangerine" | "grape" | "lime" | "strawberry" | "graphite", string> = {
  bondi: "",
  tangerine: "",
  grape: "",
  lime: "",
  strawberry: "",
  graphite: "",
};
import { useCallback, useEffect, useRef, useState } from "react";
import {
  Cloud,
  ChevronDown,
  Folder,
  Grid2X2,
  Home,
  Plus,
  Search,
  Settings,
  Users,
  CreditCard,
  KeyRound,
  PanelLeft,
  PanelRight,
  Terminal,
  Link,
  Check,
  Monitor,
  ArrowLeft,
  ArrowRight,
  Play,
  CircleHelp,
} from "lucide-react";
import { Button } from "../button";
import {
  Sidebar,
  SidebarHeader,
  SidebarContent,
  SidebarGroup,
  SidebarItem,
  SidebarFooter,
} from "../sidebar";
import {
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuCheckboxItem,
} from "../dropdown-menu";
import {
  Dialog,
  DialogContent,
  DialogTitle,
  DialogDescription,
} from "../dialog";
import { Input } from "../input";
import { SettingsLayout } from "../settings-layout";
import {
  CloudWorkspaceDetails,
  CloudWorkspaceGlyph,
  CloudOrganizationGlyph,
  CloudWorkspaceActions,
  CloudWorkspaceContext,
  CloudPortForwarding,
  CloudStatus,
  CollaboratorPresence,
  CollaboratorTyping,
  SharedChatAttribution,
  type CloudSession,
  type CloudSessionState,
  type CloudSessionAction,
  type CloudMember,
  type ForwardedPort,
} from "../cloud-workspace";
import {
  CloudComputerSettings,
  CloudEnvironmentSettings,
  type CloudBuild,
  type CloudComputerConfig,
  type CloudEnvironmentEntry,
} from "../cloud-computer";
import {
  CloudFeatureGate,
  CloudMembersSettings,
  CloudAgentSettings,
  type CloudPlan,
} from "../cloud-organization";
import { WorkspaceDashboard } from "../workspace-dashboard";
import { WorkspaceHoverPreview } from "../workspace-preview-card";
import { WorkspaceTabs, type WorkspaceTab } from "../workspace-tabs";
import { Composer, type ComposerAttachment } from "../composer";
import { ModelPicker, type ModelSelection } from "../model-picker";
import { ComposerAddMenu } from "../composer-tools";
import { Message, MessageBody, ToolCall } from "../message";
import { GitWorkflowToolbar, GitChangeScope } from "../git-workflow";
import { FileTree } from "../file-tree";
import { FilePreview } from "../file-preview";
import { PullRequestView } from "../pull-request-view";
import { workflowWorkspaces, previewPullRequest } from "./workflow-fixtures";
import { previewModels } from "./model-fixtures";
import "../cloud-patterns.css";
const initialMembers: CloudMember[] = [
  {
    id: "you",
    name: "You",
    initials: "M",
    color: "#73594d",
    active: true,
    role: "Admin",
  },
  {
    id: "maya",
    name: "Maya Chen",
    initials: "MC",
    color: "#596d84",
    active: true,
    role: "Member",
  },
  {
    id: "leo",
    name: "Leo Park",
    initials: "LP",
    color: "#71617b",
    active: false,
    role: "Member",
  },
];
const initialConfig: CloudComputerConfig = {
  repositories: ["studio/interface-system", "studio/design-system"],
  installScript:
    "# Prepare shared dependencies\ncd interface-system\npnpm install --frozen-lockfile\npnpm build",
};
const buildHistory: CloudBuild[] = [
  {
    version: 24,
    status: "ready",
    active: true,
    time: "12 minutes ago",
    duration: "1m 42s",
    logs: [
      "Cloning 2 repositories",
      "✓ studio/interface-system @ 4c8e12a",
      "✓ studio/design-system @ 9af318c",
      "Running install software",
      "Packages: +248",
      "Build complete. Computer is active.",
    ],
    repositories: initialConfig.repositories,
    script: initialConfig.installScript,
  },
  {
    version: 23,
    status: "failed",
    time: "Yesterday",
    duration: "38s",
    reason: "Install software exited with code 1",
    logs: [
      "Cloning repositories",
      "Running install software",
      "ERR_PNPM_OUTDATED_LOCKFILE",
      "Install software exited with code 1",
    ],
    repositories: initialConfig.repositories,
    script: "pnpm install --frozen-lockfile",
  },
  {
    version: 22,
    status: "ready",
    time: "2 days ago",
    duration: "1m 38s",
    logs: ["Repositories cloned", "Dependencies installed", "Build complete"],
    repositories: initialConfig.repositories,
    script: initialConfig.installScript,
  },
];
const settingGroups = [
  {
    label: "Organization",
    items: [
      { id: "organization", label: "General", icon: <Settings size={16} /> },
      { id: "members", label: "Members", icon: <Users size={16} /> },
      { id: "billing", label: "Billing", icon: <CreditCard size={16} /> },
    ],
  },
  {
    label: "Cloud",
    items: [
      { id: "computer", label: "Cloud computer", icon: <Cloud size={16} /> },
      { id: "environment", label: "Environment", icon: <KeyRound size={16} /> },
      { id: "agents", label: "Agents", icon: <Users size={16} /> },
    ],
  },
  {
    label: "Services",
    items: [
      { id: "api", label: "API access", icon: <KeyRound size={16} /> },
      { id: "repositories", label: "Repositories", icon: <Folder size={16} /> },
      { id: "ports", label: "Ports and file sync", icon: <Cloud size={16} /> },
      { id: "security", label: "Security", icon: <KeyRound size={16} /> },
      { id: "mobile", label: "Mobile", icon: <Users size={16} /> },
    ],
  },
  {
    label: "Examples",
    items: [
      { id: "onboarding", label: "Cloud setup", icon: <Plus size={16} /> },
      {
        id: "workspace",
        label: "Shared workspace",
        icon: <Folder size={16} />,
      },
    ],
  },
];
export function CloudPreview({
  onBack,
  initialPage = "workspace",
}: {
  onBack: () => void;
  initialPage?: string;
}) {
  const [linkPicker, setLinkPicker] = useState<"issue" | "workspace">();
  const [accessByWorkspace, setAccessByWorkspace] = useState<
      Record<string, WorkspaceAccess>
    >({}),
    [attachments, setAttachments] = useState<ComposerAttachment[]>([]),
    [targetBranch, setTargetBranch] = useState("main"),
    [routines, setRoutines] = useState<CloudRoutine[]>([
      {
        id: "daily",
        name: "Daily standup",
        prompt:
          "Summarize yesterday's pull requests, blockers, and work in progress.",
        repository: "interface-system",
        model: { model: "astra", effort: "High" },
        enabled: true,
        triggers: [
          {
            id: "schedule",
            type: "Scheduled",
            schedule: "Every weekday",
            time: "09:00",
            event: "",
            filter: "",
          },
        ],
        runs: [
          {
            id: "command",
            title: "Daily standup · Today",
            status: "Completed",
            time: "2 hours ago",
          },
        ],
        versions: [
          {
            name: "Daily standup",
            prompt: "Summarize recent changes and open pull requests.",
            time: "Yesterday",
          },
        ],
      },
    ]);
  const [page, setPageDirect] = useState(initialPage),
    [left, setLeft] = useState(true),
    [right, setRight] = useState(true),
    [plan, setPlan] = useState<CloudPlan>("Teams"),
    [appearance, setAppearance] = useState(
      document.documentElement.classList.contains("light") ? "light" : "dark",
    ),
    [members, setMembers] = useState(initialMembers),
    [who, setWho] = useState<string[]>([]),
    [workspaceId, setWorkspaceId] = useState("command"),
    [workspaces, setWorkspaces] = useState(workflowWorkspaces),
    [owners, setOwners] = useState<Record<string, string>>(() =>
      Object.fromEntries(
        workflowWorkspaces.map((w, i) => [
          w.id,
          w.id === "command" ? "maya" : ["you", "maya", "leo"][i % 3],
        ]),
      ),
    ),
    [followedIds, setFollowedIds] = useState<string[]>(["command"]),
    [machine, setMachine] = useState<CloudSessionState>("running"),
    [sync, setSync] = useState<CloudSession["sync"]>("off"),
    [ports, setPorts] = useState<ForwardedPort[]>([
      { remote: 3000, local: 52143, process: "node · vite" },
    ]),
    [forwarding, setForwarding] = useState(false),
    [dialog, setDialog] = useState<
      "connection-details" | "transfer" | "create" | "preview"
    >(),
    [query, setQuery] = useState(""),
    [notice, setNotice] = useState(""),
    [draft, setDraft] = useState(""),
    [messagesByWorkspace, setMessagesByWorkspace] = useState<
      Record<string, { author: string; text: string }[]>
    >({}),
    [typing, setTyping] = useState(true),
    [model, setModel] = useState<ModelSelection>({
      model: "astra",
      effort: "High",
    }),
    [planMode, setPlanMode] = useState(false),
    [tabs, setTabs] = useState<WorkspaceTab[]>([
      { id: "chat", label: "Chat", kind: "chat" },
      { id: "review", label: "Review changes", kind: "view" },
    ]),
    [tab, setTab] = useState("chat"),
    [computerColor, setComputerColor] =
      useState<keyof typeof computerImages>("bondi"),
    [sessionBuilds, setSessionBuilds] = useState<Record<string, number>>({}),
    [config, setConfig] = useState(initialConfig),
    [savedConfig, setSavedConfig] = useState(initialConfig),
    [builds, setBuilds] = useState(buildHistory),
    [environment, setEnvironment] = useState<CloudEnvironmentEntry[]>([
      { name: "API_URL", scope: "Shared" },
      { name: "EDITOR", scope: "Personal" },
    ]),
    [rightTab, setRightTab] = useState("Changes"),
    [scope, setScope] = useState("uncommitted"),
    [file, setFile] = useState<{ name: string; content: string }>(),
    [pr, setPr] = useState(previewPullRequest);
  const routineNavigation = useRef<RoutineNavigationGuard | undefined>(
    undefined,
  );
  const registerRoutineGuard = useCallback(
    (guard: RoutineNavigationGuard | undefined) => {
      routineNavigation.current = guard;
    },
    [],
  );
  const setPage = (next: string) => {
    const proceed = () => setPageDirect(next);
    if (page === "routines" && next !== page && routineNavigation.current)
      routineNavigation.current(proceed);
    else proceed();
  };
  // A teammate's avatar opens Home narrowed to their workspaces.
  const showWork = (m: CloudMember) => {
    setWho([m.id]);
    setPage("home");
  };
  const current = workspaces.find((w) => w.id === workspaceId) ?? workspaces[0];
  const access = accessByWorkspace[workspaceId] ?? {
    general: "organization" as const,
    grants: [
      { memberId: "you", level: "Write" as const },
      { memberId: "maya", level: "Write" as const },
    ],
  };
  const setAccess = (value: WorkspaceAccess) =>
    setAccessByWorkspace((all) => ({ ...all, [workspaceId]: value }));
  const assignee = owners[workspaceId] ?? "you";
  const following = followedIds.includes(workspaceId);
  const setFollowing = (value: boolean | ((old: boolean) => boolean)) =>
    setFollowedIds((ids) => {
      const next =
        typeof value === "function" ? value(ids.includes(workspaceId)) : value;
      return next
        ? [...new Set([...ids, workspaceId])]
        : ids.filter((id) => id !== workspaceId);
    });
  const messages = messagesByWorkspace[workspaceId] ?? [];
  const setMessages = (
    value:
      | { author: string; text: string }[]
      | ((
          old: { author: string; text: string }[],
        ) => { author: string; text: string }[]),
  ) =>
    setMessagesByWorkspace((all) => ({
      ...all,
      [workspaceId]:
        typeof value === "function" ? value(all[workspaceId] ?? []) : value,
    }));
  const session: CloudSession = {
    id: "W-104",
    title: current.title,
    repository: current.project,
    branch: current.branch,
    state: machine,
    cpu: 8,
    memory: 16,
    build: sessionBuilds[workspaceId] ?? 24,
    cost: "12¢",
    createdBy: members.find((m) => m.id === assignee)?.name ?? "You",
    createdAt: current.timeLabel,
    disk: 64,
    usage: { cpu: 0.2, memory: 9.6, disk: 41.1 },
    sync,
    folder: "~/Cloud/Studio/interface-system/W-104",
  };
  const nextBuild = useRef(25);
  const dirty = JSON.stringify(config) !== JSON.stringify(savedConfig);
  const settings = [
    "computer",
    "members",
    "billing",
    "environment",
    "organization",
    "agents",
    "api",
    "repositories",
    "ports",
    "security",
    "mobile",
  ].includes(page);
  useEffect(() => {
    if (machine !== "starting" && machine !== "reconnecting") return;
    const timer = setTimeout(() => setMachine("running"), 1000);
    return () => clearTimeout(timer);
  }, [machine]);
  useEffect(() => {
    if (sync !== "syncing") return;
    const timer = setTimeout(() => setSync("synced"), 900);
    return () => clearTimeout(timer);
  }, [sync]);
  useEffect(() => {
    if (builds[0].status !== "building") return;
    const version = builds[0].version;
    const timer = setTimeout(() => {
      setBuilds((bs) =>
        bs.map((b) =>
          b.version === version
            ? {
                ...b,
                status: "ready",
                active: true,
                duration: "1m 42s",
                logs: [
                  ...b.logs,
                  "Dependencies installed",
                  "Build complete. Computer is active.",
                ],
              }
            : { ...b, active: false },
        ),
      );
      setSavedConfig({
        repositories: [...builds[0].repositories],
        installScript: builds[0].script,
      });
    }, 1400);
    return () => clearTimeout(timer);
  }, [builds]);
  useEffect(() => {
    if (!routines.some((r) => r.runs.some((run) => run.status === "Running")))
      return;
    const timer = setTimeout(
      () =>
        setRoutines((rs) =>
          rs.map((r) => ({
            ...r,
            runs: r.runs.map((run) =>
              run.status === "Running"
                ? { ...run, status: "Completed" as const }
                : run,
            ),
          })),
        ),
      1200,
    );
    return () => clearTimeout(timer);
  }, [routines]);
  useEffect(() => {
    document.documentElement.classList.toggle("light", appearance === "light");
    document.documentElement.classList.toggle("dark", appearance === "dark");
  }, [appearance]);
  const copy = async (text: string) => {
    try {
      await navigator.clipboard.writeText(text);
      setNotice("Copied to clipboard.");
    } catch {
      setNotice("Clipboard unavailable. " + text);
    }
  };
  useEffect(() => {
    history.replaceState(null, "", location.pathname + "#cloud/" + page);
  }, [page]);
  const cloudLink = () => location.origin + location.pathname + "#cloud";
  const action = (a: CloudSessionAction, targetId = workspaceId) => {
    const target = workspaces.find((w) => w.id === targetId) ?? current;
    if (a === "copy-directory") {
      void copy(session.folder ?? "");
      return;
    }
    if (a === "wake" || a === "restart") {
      setMachine("starting");
      return;
    }
    if (a === "sync") {
      setSync(sync === "off" ? "syncing" : "off");
      return;
    }
    if (a === "copy-link") {
      void copy(cloudLink() + "/workspace/" + targetId);
      return;
    }
    if (a === "copy-info") {
      void copy(
        `${session.id} · ${session.title} · ${session.repository} · ${session.branch}`,
      );
      return;
    }
    if (a === "archive") {
      setWorkspaces((ws) =>
        ws.map((w) => (w.id === targetId ? { ...w, archived: true } : w)),
      );
      if (targetId === workspaceId) setMachine("archived");
      setNotice("Workspace archived in this example.");
      return;
    }
    if (a === "transfer") setNotice(`Transfer preview for ${target.title}`);
    if (a === "move-local") {
      setNotice(`Move to this computer preview for ${target.title}`);
      return;
    }
    setDialog(a);
  };
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (
        (e.metaKey || e.ctrlKey) &&
        e.shiftKey &&
        e.key.toLowerCase() === "c"
      ) {
        e.preventDefault();
        void copy(cloudLink());
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);
  const openWorkspace = (id: string) => {
    setWorkspaceId(id);
    setPage("workspace");
    const chatId = messagesByWorkspace[id] ? "chat-2" : "chat";
    setTabs([
      { id: chatId, label: "Chat", kind: "chat" },
      { id: "review", label: "Review changes", kind: "view" },
    ]);
    setTab(chatId);
    setMachine(
      workspaces.find((w) => w.id === id)?.archived ? "archived" : "running",
    );
  };
  const addTab = (id: string, label: string) => {
    setTabs((ts) =>
      ts.some((t) => t.id === id)
        ? ts
        : [...ts, { id, label, kind: id === "file" ? "file" : "view" }],
    );
    setTab(id);
  };
  const follow = () => setFollowing((v) => !v);
  const reassign = (id: string, targetId = workspaceId) => {
    setOwners((all) => ({ ...all, [targetId]: id }));
    if (id === "you")
      setFollowedIds((ids) => ids.filter((value) => value !== targetId));
    setNotice(
      `Workspace assigned to ${members.find((m) => m.id === id)?.name}.`,
    );
  };
  const build = () => {
    setBuilds((bs) => [
      {
        version: nextBuild.current++,
        status: "building",
        time: "Just now",
        duration: "0s",
        logs: [
          "Creating isolated build environment",
          "Cloning repositories",
          "Running install software…",
        ],
        repositories: [...config.repositories],
        script: config.installScript,
      },
      ...bs.map((b) =>
        b.status === "building" ? { ...b, status: "canceled" as const } : b,
      ),
    ]);
  };
  const finishSetup = (result: CloudSetupResult) => {
    setComputerColor(result.color as keyof typeof computerImages);
    setBuilds((bs) =>
      bs.map((b) =>
        b.active ? { ...b, repositories: result.repositories } : b,
      ),
    );
    setConfig((c) => ({ ...c, repositories: result.repositories }));
    setSavedConfig((c) => ({ ...c, repositories: result.repositories }));
    setPage("workspace");
    setWorkspaces((ws) => [
      {
        ...ws[0],
        id: "admin",
        title: "Admin",
        branch: "computer-setup",
        timeLabel: "Now",
        workflow: { ...ws[0].workflow, state: "no-pr", prNumber: undefined },
      },
      ...ws.filter((w) => w.id !== "admin"),
    ]);
    setWorkspaceId("admin");
    setTab("chat-2");
    setTabs((ts) => [
      ...ts.filter((t) => t.id !== "chat-2"),
      { id: "chat-2", label: "Set up computer", kind: "chat" },
    ]);
    setDraft(
      "Set up this computer for development. Check that tests and applications run in all repositories.",
    );
    setNotice(
      "Admin workspace example · " + result.agents.join(", ") + " connected.",
    );
  };
  const gitAction = (a: GitWorkflowAction) => {
    if (a === "open-pr") {
      addTab("pr", "PR #42");
      return;
    }
    if (a === "archive") {
      action("archive");
      return;
    }
    const next: Partial<Record<GitWorkflowAction, GitWorkflowState>> = {
      "commit-push": "checks-pending",
      "create-pr": "review-required",
      "create-draft-pr": "draft",
      merge: "merged",
      "ready-for-review": "review-required",
      "approve-pr": "ready",
      pull: "ready",
      push: "checks-pending",
    };
    setWorkspaces((ws) =>
      ws.map((w) =>
        w.id === workspaceId
          ? {
              ...w,
              workflow: {
                ...w.workflow,
                state: next[a] ?? w.workflow.state,
                autoMergeEnabled:
                  a === "enable-auto-merge"
                    ? true
                    : a === "disable-auto-merge"
                      ? false
                      : w.workflow.autoMergeEnabled,
              },
            }
          : w,
      ),
    );
    setNotice("Git workflow updated locally.");
  };
  const send = () => {
    if (!draft.trim() || machine !== "running") return;
    setMessages((ms) => [...ms, { author: "you", text: draft.trim() }]);
    setDraft("");
    setAttachments([]);
    setNotice(
      "Message added to the shared-chat example. No agent request was sent.",
    );
  };
  const portControls = (
    <CloudPortForwarding
      ports={ports}
      enabled={forwarding}
      onEnabledChange={setForwarding}
      onAdd={(remote) =>
        setPorts((ps) => [
          ...ps,
          { remote, local: 52144 + ps.length, process: "custom server" },
        ])
      }
      onRemove={(remote) =>
        setPorts((ps) => ps.filter((p) => p.remote !== remote))
      }
      onOpen={() => setDialog("preview")}
    />
  );
  const exampleControls = (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button variant="ghost" size="xs">
          Local cloud example <ChevronDown />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start">
        <DropdownMenuItem disabled>Session state</DropdownMenuItem>
        {(
          [
            "running",
            "sleeping",
            "starting",
            "reconnecting",
            "unresponsive",
            "archived",
          ] as const
        ).map((s) => (
          <DropdownMenuCheckboxItem
            key={s}
            checked={machine === s}
            onCheckedChange={() => setMachine(s)}
          >
            {s.charAt(0).toUpperCase() + s.slice(1)}
          </DropdownMenuCheckboxItem>
        ))}
        <DropdownMenuSeparator />
        <DropdownMenuCheckboxItem checked={typing} onCheckedChange={setTyping}>
          Teammate typing
        </DropdownMenuCheckboxItem>
        <DropdownMenuItem
          onSelect={() => {
            setMessages((ms) => [
              ...ms,
              {
                author: "maya",
                text: "The preview looks good. I added the keyboard checks to this shared workspace.",
              },
            ]);
            setTyping(false);
          }}
        >
          Receive example teammate message
        </DropdownMenuItem>
        <DropdownMenuSeparator />
        {(["Free", "Pro", "Teams", "Enterprise"] as const).map((p) => (
          <DropdownMenuCheckboxItem
            key={p}
            checked={plan === p}
            onCheckedChange={() => setPlan(p)}
          >
            {p} plan
          </DropdownMenuCheckboxItem>
        ))}
        <DropdownMenuItem onSelect={() => setPage("onboarding")}>
          Cloud setup
        </DropdownMenuItem>
        <DropdownMenuSeparator />
        {["light", "dark"].map((t) => (
          <DropdownMenuCheckboxItem
            key={t}
            checked={appearance === t}
            onCheckedChange={() => setAppearance(t)}
          >
            {t === "light" ? "Light appearance" : "Dark appearance"}
          </DropdownMenuCheckboxItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
  const account = (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button className="lab-account">
          <CloudOrganizationGlyph size={18} />
          <strong>Studio</strong>
          <ChevronDown size={13} />
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start">
        <DropdownMenuItem onSelect={onBack}>
          <Monitor />
          My workspace <span>Local</span>
        </DropdownMenuItem>
        <DropdownMenuItem>
          <Cloud />
          Studio <Check />
        </DropdownMenuItem>
        <DropdownMenuSeparator />
        <DropdownMenuItem onSelect={() => setPage("computer")}>
          Cloud computer
        </DropdownMenuItem>
        <DropdownMenuItem onSelect={() => setPage("members")}>
          Members
        </DropdownMenuItem>
        <DropdownMenuItem onSelect={() => setPage("billing")}>
          Billing
        </DropdownMenuItem>
        <DropdownMenuItem onSelect={() => setPage("onboarding")}>
          Create organization…
        </DropdownMenuItem>
        <DropdownMenuSeparator />
        <div className="ui-cloud-example-controls">{exampleControls}</div>
      </DropdownMenuContent>
    </DropdownMenu>
  );
  if (page === "onboarding")
    return (
      <div className="ui-cloud-onboarding-frame">
        <header>
          <Button
            variant="ghost"
            size="sm"
            onClick={() => setPage("workspace")}
          >
            <ArrowLeft />
            Back
          </Button>
          <span>Studio · Cloud setup</span>
        </header>
        <CloudOnboarding images={computerImages} onFinish={finishSetup} />
      </div>
    );
  const feature = (
    children: React.ReactNode,
    kind: "cloud" | "team" | "enterprise" = "cloud",
  ) => (
    <CloudFeatureGate
      plan={plan}
      feature={kind}
      onPlans={() => setPage("billing")}
    >
      {children}
    </CloudFeatureGate>
  );
  if (settings)
    return (
      <SettingsLayout
        title={
          settingGroups.flatMap((g) => g.items).find((i) => i.id === page)
            ?.label ?? "Settings"
        }
        groups={settingGroups.map((g) => ({
          ...g,
          items: g.items.filter((i) =>
            i.label.toLowerCase().includes(query.toLowerCase()),
          ),
        }))}
        selected={page}
        onSelect={setPage}
        onBack={() => setPage("workspace")}
        query={query}
        onQueryChange={setQuery}
        account={account}
        toolbar={exampleControls}
      >
        {page === "computer" &&
          feature(
            <CloudComputerSettings
              config={config}
              image={computerImages[computerColor]}
              builds={builds}
              dirty={dirty}
              onChange={setConfig}
              onBuild={build}
              onCancel={() =>
                setBuilds((bs) =>
                  bs.map((b, i) =>
                    i === 0 ? { ...b, status: "canceled" } : b,
                  ),
                )
              }
              onDiscard={() => setConfig(savedConfig)}
              onActivate={(version) =>
                setBuilds((bs) =>
                  bs.map((b) => ({ ...b, active: b.version === version })),
                )
              }
              onConfigure={() => {
                setPage("workspace");
                setDraft(
                  "Set up this computer for development. Check repositories, install dependencies, and run tests.",
                );
                setNotice(
                  "Admin workspace example. Changes to shared computer settings are restricted to admins.",
                );
              }}
            />,
          )}
        {page === "environment" &&
          feature(
            <CloudEnvironmentSettings
              entries={environment}
              onSave={(entries) =>
                setEnvironment((es) => [
                  ...es.filter(
                    (e) =>
                      !entries.some(
                        (n) => n.name === e.name && n.scope === e.scope,
                      ),
                  ),
                  ...entries,
                ])
              }
              onRemove={(name, scope) =>
                setEnvironment((es) =>
                  es.filter((e) => e.name !== name || e.scope !== scope),
                )
              }
            />,
          )}
        {page === "members" &&
          feature(
            <CloudMembersSettings
              members={members}
              onInvite={(email, role) =>
                setMembers((ms) => [
                  ...ms,
                  {
                    id: "invite-" + crypto.randomUUID(),
                    name: email,
                    initials: email.slice(0, 2).toUpperCase(),
                    color: "#5d6862",
                    role,
                  },
                ])
              }
              onRoleChange={(id, role) =>
                setMembers((ms) =>
                  ms.map((m) => (m.id === id ? { ...m, role } : m)),
                )
              }
            />,
            "team",
          )}
        {page === "organization" &&
          feature(<ExampleOrganizationSettings />, "team")}
        {page === "agents" && feature(<CloudAgentSettings />)}
        {page === "api" && feature(<ExampleApiSettings />)}
        {page === "repositories" && feature(<CloudRepositorySettings />)}
        {page === "ports" && feature(<CloudPortsSettings />)}
        {page === "security" &&
          feature(<CloudSecuritySettings />, "enterprise")}
        {page === "mobile" &&
          feature(
            <CloudMobilePreview
              onOpenWorkspace={() => openWorkspace("command")}
            />,
          )}
        {page === "billing" && (
          <ExamplePlanSettings plan={plan} onPreviewPlan={setPlan} />
        )}
      </SettingsLayout>
    );
  return (
    <div className="lab-app ui-cloud-app">
      {left && (
        <Sidebar
          defaultWidth={282}
          resizable
          aria-label="Cloud workspace sidebar"
        >
          <SidebarHeader>
            <Button
              variant="ghost"
              size="iconSm"
              aria-label="Hide sidebar"
              onClick={() => setLeft(false)}
            >
              <PanelLeft />
            </Button>
            <span style={{ flex: 1 }} />

            <Button
              variant="ghost"
              size="iconXs"
              onClick={() => setPage("home")}
              aria-label="Back to Home"
            >
              <ArrowLeft />
            </Button>
            <Button
              variant="ghost"
              size="iconXs"
              onClick={() => setPage("workspace")}
              aria-label="Forward to workspace"
            >
              <ArrowRight />
            </Button>
          </SidebarHeader>
          {account}
          <nav className="lab-primary-navigation">
            <SidebarItem
              label="Dashboard"
              icon={<Grid2X2 size={14} />}
              selected={page === "dashboard"}
              onClick={() => setPage("dashboard")}
            />
            <SidebarItem
              label="Home"
              icon={<Home size={14} />}
              trailing={
                <span className="ui-cloud-home-avatars">
                  {members.slice(0, 3).map((m) => (
                    <span
                      key={m.id}
                      className="ui-cloud-avatar ui-cloud-avatar-static"
                      style={{ background: m.color }}
                      data-active={m.active}
                      role="img"
                      aria-label={m.name}
                    >
                      {m.initials}
                    </span>
                  ))}
                </span>
              }
              selected={page === "home"}
              onClick={() => setPage("home")}
            />
            <SidebarItem
              label="Create"
              icon={<Plus size={14} />}
              onClick={() => setDialog("create")}
            />
            <SidebarItem
              label="Routines"
              icon={<Play size={14} />}
              selected={page === "routines"}
              onClick={() => setPage("routines")}
            />
            <SidebarItem
              label="Search"
              icon={<Search size={14} />}
              onClick={() => {
                setPage("home");
                setQuery("");
              }}
            />
          </nav>
          <SidebarContent>
            {[
              { label: "Pinned", ids: ["command"] },
              {
                label: "My workspaces",
                ids: workspaces
                  .filter(
                    (w) => (owners[w.id] ?? "you") === "you" && !w.archived,
                  )
                  .map((w) => w.id),
              },
              { label: "Following", ids: followedIds },
            ].map((group) => (
              <SidebarGroup key={group.label} title={group.label}>
                {group.ids.map((id) => {
                  const w = workspaces.find((w) => w.id === id);
                  return (
                    w && (
                      <CloudWorkspaceContext
                        key={id}
                        members={members}
                        following={followedIds.includes(id)}
                        onFollow={() =>
                          setFollowedIds((ids) =>
                            ids.includes(id)
                              ? ids.filter((value) => value !== id)
                              : [...ids, id],
                          )
                        }
                        onReassign={(memberId) => reassign(memberId, id)}
                        onAction={(value) => action(value, id)}
                      >
                        <div>
                          <WorkspaceHoverPreview workspace={w}>
                            <div>
                              <SidebarItem
                                label={w.title}
                                icon={
                                  <CloudWorkspaceGlyph
                                    state={
                                      w.workflow.state === "merged"
                                        ? "done"
                                        : "idle"
                                    }
                                  />
                                }
                                trailing={
                                  <span className="ui-cloud-sidebar-time">
                                    {w.timeLabel}
                                  </span>
                                }
                                selected={
                                  page === "workspace" && workspaceId === id
                                }
                                onClick={() => openWorkspace(id)}
                              />
                            </div>
                          </WorkspaceHoverPreview>
                        </div>
                      </CloudWorkspaceContext>
                    )
                  );
                })}
              </SidebarGroup>
            ))}
            <SidebarGroup title="Team">
              {members.map((m) => (
                <SidebarItem
                  key={m.id}
                  label={m.name}
                  icon={
                    <span
                      className="ui-cloud-avatar ui-cloud-avatar-static ui-cloud-team-avatar"
                      style={{ background: m.color }}
                      data-active={m.active}
                      role="img"
                      aria-label={m.name}
                    >
                      {m.initials}
                    </span>
                  }
                  onClick={() => {
                    setWho([m.id]);
                    setPage("home");
                  }}
                />
              ))}
            </SidebarGroup>
          </SidebarContent>
          <SidebarFooter className="ui-cloud-footer">
            <button
              className="ui-cloud-plan-badge"
              data-free={plan === "Free"}
              onClick={() => setPage("billing")}
              aria-label={plan + " plan"}
            >
              {plan === "Teams" ? "TEAM" : plan.toUpperCase()}
            </button>
            <span style={{ flex: 1 }} />
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button variant="ghost" size="iconXs" aria-label="Help">
                  <CircleHelp />
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent side="top" align="end">
                <DropdownMenuItem onSelect={() => setPage("onboarding")}>
                  Getting started
                </DropdownMenuItem>
                <DropdownMenuItem onSelect={() => setPage("computer")}>
                  Cloud computer
                </DropdownMenuItem>
                <DropdownMenuSeparator />
                <div className="ui-cloud-example-controls">
                  {exampleControls}
                </div>
              </DropdownMenuContent>
            </DropdownMenu>
            <Button
              variant="ghost"
              size="iconSm"
              aria-label="Cloud settings"
              onClick={() => setPage("computer")}
            >
              <Settings />
            </Button>
          </SidebarFooter>
        </Sidebar>
      )}
      <main className="lab-main">
        {page === "routines"
          ? feature(
              <CloudRoutines
                routines={routines}
                onNavigationGuard={registerRoutineGuard}
                models={previewModels}
                onChange={setRoutines}
                onRun={(routine) => {
                  const id = crypto.randomUUID();
                  setOwners((all) => ({ ...all, [id]: "you" }));
                  setRoutines((rs) =>
                    rs.map((r) =>
                      r.id === routine.id
                        ? {
                            ...r,
                            runs: [
                              {
                                id,
                                title: r.name + " · Just now",
                                status: "Running",
                                time: "Now",
                              },
                              ...r.runs,
                            ],
                          }
                        : r,
                    ),
                  );
                  setWorkspaces((ws) => [
                    {
                      ...ws[0],
                      id,
                      title: routine.name,
                      branch: "routine/example",
                      timeLabel: "Now",
                    },
                    ...ws,
                  ]);
                  setNotice(
                    "Routine started. Its workspace is available in Runs.",
                  );
                }}
                onOpenWorkspace={openWorkspace}
              />,
            )
          : page === "home"
            ? feature(
                <CloudHome
                  workspaces={workspaces}
                  members={members}
                  selectedOwners={who}
                  onOwnersChange={setWho}
                  routineIds={routines.flatMap((r) =>
                    r.runs.map((run) => run.id),
                  )}
                  ownerByWorkspace={owners}
                  pinnedIds={["command"]}
                  onOpen={openWorkspace}
                  onCreate={() => setDialog("create")}
                  onProfile={showWork}
                  leading={
                    !left && (
                      <Button
                        variant="ghost"
                        size="iconSm"
                        aria-label="Show sidebar"
                        onClick={() => setLeft(true)}
                      >
                        <PanelLeft />
                      </Button>
                    )
                  }
                />,
              )
            : page === "dashboard"
              ? feature(
                  <WorkspaceDashboard
                    workspaces={workspaces}
                    onOpen={openWorkspace}
                    onMove={(id, stage) =>
                      setWorkspaces((ws) =>
                        ws.map((w) => (w.id === id ? { ...w, stage } : w)),
                      )
                    }
                    onAction={(id) => openWorkspace(id)}
                    onCreate={() => setDialog("create")}
                    onArchive={(id) =>
                      setWorkspaces((ws) =>
                        ws.map((w) =>
                          w.id === id ? { ...w, archived: true } : w,
                        ),
                      )
                    }
                  />,
                )
              : feature(
                  <>
                    <header className="lab-header ui-cloud-header">
                      {!left && (
                        <Button
                          aria-label="Show sidebar"
                          variant="ghost"
                          size="iconSm"
                          onClick={() => setLeft(true)}
                        >
                          <PanelLeft />
                        </Button>
                      )}
                      <CloudWorkspaceDetails
                        session={session}
                        onRename={(title) =>
                          setWorkspaces((ws) =>
                            ws.map((w) =>
                              w.id === workspaceId ? { ...w, title } : w,
                            ),
                          )
                        }
                        onAction={action}
                      >
                        {portControls}
                      </CloudWorkspaceDetails>
                      <span style={{ flex: 1 }} />
                      <WorkspaceShare
                        value={access}
                        members={members}
                        onSave={setAccess}
                        onCopyLink={() => action("copy-link")}
                      />
                      <CollaboratorPresence
                        members={members.filter(
                          (m) =>
                            (access.general === "organization" ||
                              access.grants.some((g) => g.memberId === m.id)) &&
                            (m.id === assignee || m.active),
                        )}
                        onProfile={showWork}
                      />
                      <CloudWorkspaceActions
                        members={members}
                        assignee={assignee}
                        following={following}
                        onFollow={follow}
                        onReassign={reassign}
                        onAction={action}
                      />
                      <Button
                        variant="ghost"
                        size="iconSm"
                        aria-label="Toggle right sidebar"
                        onClick={() => setRight(!right)}
                      >
                        <PanelRight />
                      </Button>
                    </header>
                    <div className="ui-cloud-tab-row">
                      <WorkspaceTabs
                        fileActions={() => ({
                          onAttach: () =>
                            setAttachments((a) => [
                              ...a,
                              {
                                id: crypto.randomUUID(),
                                name: file?.name ?? "CommandMenu.tsx",
                              },
                            ]),
                          onCopyPath: () =>
                            void copy(
                              "/home/user/interface-system/src/components/" +
                                (file?.name ?? "CommandMenu.tsx"),
                            ),
                          onCopyRelativePath: () =>
                            void copy(
                              "src/components/" +
                                (file?.name ?? "CommandMenu.tsx"),
                            ),
                        })}
                        tabs={tabs}
                        value={tab}
                        onChange={setTab}
                        onClose={(id) => {
                          setTabs((ts) => ts.filter((t) => t.id !== id));
                          setTab("chat");
                        }}
                        onCopyLink={() => void copy(cloudLink())}
                      />
                      <DropdownMenu>
                        <DropdownMenuTrigger asChild>
                          <Button
                            variant="ghost"
                            size="iconSm"
                            aria-label="New cloud tab"
                          >
                            <Plus />
                          </Button>
                        </DropdownMenuTrigger>
                        <DropdownMenuContent align="end">
                          <DropdownMenuItem
                            onSelect={() => addTab("chat-2", "New chat")}
                          >
                            New chat
                          </DropdownMenuItem>
                          <DropdownMenuItem
                            onSelect={() =>
                              addTab("cloud-terminal", "Cloud terminal")
                            }
                          >
                            <Terminal />
                            Cloud terminal
                          </DropdownMenuItem>
                          <DropdownMenuItem
                            disabled={sync !== "synced"}
                            onSelect={() =>
                              addTab("local-terminal", "Local terminal")
                            }
                          >
                            <Terminal />
                            Local terminal
                          </DropdownMenuItem>
                          <DropdownMenuItem
                            onSelect={() => addTab("desktop", "Desktop")}
                          >
                            <Monitor />
                            Desktop
                          </DropdownMenuItem>
                        </DropdownMenuContent>
                      </DropdownMenu>
                    </div>
                    {machine !== "running" && (
                      <div className="ui-cloud-session-banner" role="status">
                        <CloudStatus state={machine} />
                        <span>
                          {machine === "sleeping"
                            ? "Chat history is available while this workspace sleeps."
                            : machine === "unresponsive"
                              ? "The workspace is unreachable. Restart to reconnect."
                              : machine === "archived"
                                ? "Archived workspace. Cached chat and files are available."
                                : "Connecting to the cloud computer…"}
                        </span>
                        {["sleeping", "unresponsive", "archived"].includes(
                          machine,
                        ) && (
                          <Button
                            size="xs"
                            variant="secondary"
                            onClick={() => action("wake")}
                          >
                            {machine === "sleeping"
                              ? "Wake workspace"
                              : "Restart"}
                          </Button>
                        )}
                      </div>
                    )}
                    {tab === "pr" ? (
                      <PullRequestView
                        request={pr}
                        onChange={setPr}
                        workflow={current.workflow}
                        onAction={gitAction}
                        composer={
                          <Button
                            variant="secondary"
                            size="sm"
                            onClick={() => {
                              setTab("chat");
                              setDraft(
                                "Review the pull request comments and address any requested changes.",
                              );
                            }}
                          >
                            Send comments to chat
                          </Button>
                        }
                      />
                    ) : tab === "file" && file ? (
                      <FilePreview
                        kind="text"
                        name={file.name}
                        content={file.content}
                        onClose={() => setTab("chat")}
                      />
                    ) : tab === "review" ? (
                      <div className="lab-transcript">
                        <FileDiff
                          name="src/components/CommandMenu.tsx"
                          lines={[
                            { type: "hunk", content: "@@ -1,2 +1,3 @@" },
                            {
                              type: "context",
                              content: "export function CommandMenu() {",
                              oldLine: 1,
                              newLine: 1,
                            },
                            {
                              type: "added",
                              content:
                                '  const [query, setQuery] = useState("");',
                              newLine: 2,
                            },
                            {
                              type: "context",
                              content: "}",
                              oldLine: 2,
                              newLine: 3,
                            },
                          ]}
                        />
                      </div>
                    ) : tab.includes("terminal") ? (
                      <div className="ui-cloud-terminal">
                        <header>
                          <Terminal size={14} />
                          {tab === "cloud-terminal"
                            ? "Cloud terminal · Amazon Linux 2023"
                            : "Local terminal · Synced directory"}
                          <CloudStatus state={machine} />
                        </header>
                        <pre>
                          {machine === "running"
                            ? "$ pwd\n/home/user/interface-system\n\n$ pnpm dev\nVITE ready in 224 ms\n➜ Local: http://localhost:3000/"
                            : "Terminal is read only while the workspace is unavailable."}
                        </pre>
                        {machine === "running" && (
                          <p>Terminal output example</p>
                        )}
                      </div>
                    ) : tab === "desktop" ? (
                      <div className="ui-cloud-desktop">
                        <Monitor size={44} />
                        <h2>Workspace desktop</h2>
                        <p>
                          Browser and desktop sessions share this workspace's
                          cloud computer.
                        </p>
                        <Button
                          size="sm"
                          variant="secondary"
                          onClick={() => setDialog("preview")}
                        >
                          Open browser preview
                        </Button>
                      </div>
                    ) : (
                      <>
                        <div className="lab-transcript ui-cloud-transcript">
                          {tab !== "chat-2" && (
                            <>
                              <SharedChatAttribution
                                member={members[1]}
                                time="10:24 AM"
                              >
                                <MessageBody tone="user">
                                  Build the workspace command menu. I'll check
                                  the preview while you work on keyboard
                                  navigation.
                                </MessageBody>
                              </SharedChatAttribution>
                              <ToolCall title="Read src/components/Workspace.tsx" />
                              <Message role="assistant">
                                <MessageBody>
                                  The command menu is ready. Search works across
                                  files and workspace actions, with keyboard
                                  navigation and restored focus.
                                </MessageBody>
                              </Message>
                              <SharedChatAttribution
                                member={members[0]}
                                time="10:27 AM"
                              >
                                <MessageBody tone="user">
                                  @Maya the preview is running on port 3000. Can
                                  you check the empty state?
                                </MessageBody>
                              </SharedChatAttribution>
                              <ToolCall title="Started development server on port 3000" />
                              <div className="ui-cloud-preview-card">
                                <Cloud size={16} />
                                <div>
                                  <strong>Workspace command menu</strong>
                                  <small>node · Port 3000</small>
                                </div>
                                <Button
                                  variant="secondary"
                                  size="sm"
                                  onClick={() => {
                                    setForwarding(true);
                                    setDialog("preview");
                                  }}
                                >
                                  Open <Link />
                                </Button>
                              </div>
                            </>
                          )}
                          {messages.map((m, i) => (
                            <SharedChatAttribution
                              key={i}
                              member={
                                members.find((p) => p.id === m.author) ??
                                members[0]
                              }
                              time="Now"
                            >
                              <MessageBody tone="user">{m.text}</MessageBody>
                            </SharedChatAttribution>
                          ))}
                        </div>
                        <div className="ui-cloud-composer">
                          <CollaboratorTyping names={typing ? ["Maya"] : []} />
                          <Composer
                            onAttach={(files) =>
                              setAttachments((a) => [
                                ...a,
                                ...files.map((f) => ({
                                  id: crypto.randomUUID(),
                                  name: f.name,
                                })),
                              ])
                            }
                            attachments={attachments}
                            onRemoveAttachment={(id) =>
                              setAttachments((a) =>
                                a.filter((x) => x.id !== id),
                              )
                            }
                            suggestions={members
                              .filter((m) => m.id !== "you")
                              .map((m) => ({
                                id: m.id,
                                label: m.name,
                                kind: "mention" as const,
                                insertText: "@" + m.name + " ",
                              }))}
                            value={draft}
                            onChange={setDraft}
                            onSend={send}
                            disabled={machine !== "running"}
                            placeholder="Ask to make changes, @mention teammates or files…"
                            planMode={planMode}
                            onPlanModeChange={setPlanMode}
                            renderAddMenu={(openFileDialog) => (
                              <ComposerAddMenu
                                onAttach={openFileDialog}
                                onIssue={() => setLinkPicker("issue")}
                                onWorkspace={() => setLinkPicker("workspace")}
                                onPlan={() => setPlanMode(!planMode)}
                                planMode={planMode}
                              />
                            )}
                            footer={
                              <ModelPicker
                                models={previewModels}
                                value={model}
                                onChange={setModel}
                              />
                            }
                          />
                        </div>
                      </>
                    )}
                  </>,
                )}
        {notice && (
          <div className="ui-cloud-notice" role="status">
            {notice}
            <button aria-label="Dismiss notice" onClick={() => setNotice("")}>
              ×
            </button>
          </div>
        )}
      </main>
      {page === "workspace" && right && plan !== "Free" && (
        <aside className="ui-cloud-right">
          <GitWorkflowToolbar
            workflow={current.workflow}
            onAction={gitAction}
            onOpenPr={() => addTab("pr", "PR #42")}
          />
          <nav>
            {["Artifacts", "All files", "Changes"].map((t) => (
              <button
                key={t}
                data-selected={rightTab === t}
                onClick={() => setRightTab(t)}
              >
                {t}
              </button>
            ))}
          </nav>
          <div className="ui-cloud-right-files">
            {rightTab === "Changes" && (
              <GitChangeScope
                scope={scope}
                onScopeChange={setScope}
                branch={current.branch}
                targetBranch={targetBranch}
                branches={["main", "develop"]}
                onTargetBranchChange={setTargetBranch}
                commits={[]}
                changedFiles={2}
              />
            )}
            <FileTree
              wrapRow={(node, row) => (
                <FileActionsMenu
                  onView={() => {
                    setFile({
                      name: node.name,
                      content: "// Shared workspace file preview",
                    });
                    addTab("file", node.name);
                  }}
                  onAttach={() =>
                    setAttachments((a) => [
                      ...a,
                      { id: crypto.randomUUID(), name: node.name },
                    ])
                  }
                  onCopyPath={() =>
                    void copy("/home/user/interface-system/src/" + node.name)
                  }
                  onCopyRelativePath={() => void copy("src/" + node.name)}
                >
                  {row}
                </FileActionsMenu>
              )}
              nodes={
                rightTab === "Artifacts"
                  ? [{ id: "preview", name: "Command menu preview" }]
                  : [
                      {
                        id: "src",
                        name: "src",
                        children: [
                          {
                            id: "command",
                            name: "CommandMenu.tsx",
                            added: 96,
                            removed: 0,
                            status: "added",
                          },
                          {
                            id: "workspace",
                            name: "Workspace.tsx",
                            added: 24,
                            removed: 18,
                            status: "modified",
                          },
                        ],
                      },
                    ]
              }
              onSelect={(node) => {
                setFile({
                  name: node.name,
                  content:
                    "// Shared workspace example\nexport const commandMenu = { searchable: true, keyboard: true };",
                });
                addTab("file", node.name);
              }}
            />
          </div>
          <CloudRunPanel
            available={machine === "running"}
            onRun={() => setForwarding(true)}
          >
            {portControls}
          </CloudRunPanel>
        </aside>
      )}
      <CloudWorkspaceCreateDialog
        open={dialog === "create"}
        onOpenChange={(open) => !open && setDialog(undefined)}
        repositories={config.repositories}
        models={previewModels}
        model={model}
        onCreate={(value) => {
          const id = crypto.randomUUID();
          setWorkspaces((ws) => [
            {
              ...ws[0],
              id,
              title: value.prompt.slice(0, 72),
              project: value.repository.split("/").pop() ?? value.repository,
              branch: value.branch,
              timeLabel: "Now",
              workflow: {
                ...ws[0].workflow,
                state: "uncommitted",
                prNumber: undefined,
              },
            },
            ...ws,
          ]);
          setSessionBuilds((bs) => ({
            ...bs,
            [id]: builds.find((b) => b.active)?.version ?? 24,
          }));
          setWorkspaceId(id);
          setModel(value.model);
          setAccessByWorkspace((all) => ({
            ...all,
            [id]: {
              general: value.access,
              grants: [{ memberId: "you", level: "Write" }],
            },
          }));
          setOwners((all) => ({ ...all, [id]: "you" }));
          setTyping(false);
          setMessagesByWorkspace((all) => ({
            ...all,
            [id]: [{ author: "you", text: value.prompt }],
          }));
          setDraft("");
          setAttachments(
            value.attachments.map((name) => ({
              id: crypto.randomUUID(),
              name,
            })),
          );
          setMachine("starting");
          setPage("workspace");
          setTab("chat-2");
          setTabs([
            { id: "chat-2", label: "Chat", kind: "chat" },
            { id: "review", label: "Review changes", kind: "view" },
          ]);
        }}
      />
      <ContextLinkPicker
        kind={linkPicker ?? "workspace"}
        open={!!linkPicker}
        onOpenChange={(open) => !open && setLinkPicker(undefined)}
        onCloseAutoFocus={(event) => {
          event.preventDefault();
          document
            .querySelector<HTMLTextAreaElement>(".ui-composer textarea")
            ?.focus();
        }}
        items={
          linkPicker === "issue"
            ? [
                {
                  id: "issue-128",
                  title: "UI-128 Refine shared workspace navigation",
                  group: "Linear",
                },
                {
                  id: "issue-42",
                  title: "#42 Keyboard shortcuts",
                  group: "GitHub",
                },
              ]
            : workspaces
                .filter((w) => w.id !== workspaceId)
                .map((w) => ({
                  id: w.id,
                  title: w.title,
                  group: w.project,
                  linked: attachments.some((a) => a.id === w.id),
                }))
        }
        onSelect={(item) =>
          setAttachments((a) => [
            ...a,
            { id: item.id, name: item.title, kind: linkPicker },
          ])
        }
      />
      <Dialog
        open={!!dialog && dialog !== "create"}
        onOpenChange={(open) => !open && setDialog(undefined)}
      >
        <DialogContent>
          <DialogTitle>
            {dialog === "connection-details"
              ? "Open via SSH"
              : dialog === "transfer"
                ? "Transfer to local"
                : "Workspace preview"}
          </DialogTitle>
          <DialogDescription>
            {dialog === "connection-details"
              ? "Connect an editor or terminal to this cloud computer."
              : dialog === "transfer"
                ? "Bring the workspace and its chats to your Mac."
                : "Local example of the server running inside the cloud workspace."}
          </DialogDescription>
          {dialog === "connection-details" ? (
            <>
              <Input
                readOnly
                aria-label="SSH command"
                value="ssh example@w-104.example.test"
              />
              <Button
                variant="secondary"
                onClick={() => void copy("ssh example@w-104.example.test")}
              >
                Copy example SSH command
              </Button>
              <p className="ui-cloud-note">
                Example host. No remote connection will be opened.
              </p>
            </>
          ) : dialog === "transfer" ? (
            <>
              <Input
                aria-label="Local destination"
                defaultValue="~/Projects/interface-system"
              />
              <p>Chats and repository files are included.</p>
              <Button
                onClick={() => {
                  setNotice("Transfer preview complete. No files were copied.");
                  setDialog(undefined);
                }}
              >
                Preview transfer
              </Button>
            </>
          ) : (
            <div className="ui-cloud-browser-preview">
              <Input
                placeholder="Search files and commands…"
                aria-label="Preview command search"
              />
              <Button
                variant="ghost"
                onClick={() =>
                  setNotice("Command selected in the local preview.")
                }
              >
                <Plus />
                Create workspace
              </Button>
              <small>Cloud server preview · Example content</small>
            </div>
          )}
        </DialogContent>
      </Dialog>
    </div>
  );
}
