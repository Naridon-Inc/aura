import { useEffect, useState } from "react";
import {
  ChevronDown,
  Keyboard,
  Palette,
  SlidersHorizontal,
  Terminal,
  GitBranch,
  UserCircle,
  Cpu,
  KeyRound,
  Router,
  FlaskConical,
  Cog,
  Folder,
} from "lucide-react";
import { Button } from "../button";
import { ModelLoadout } from "../model-loadout";
import { type ModelOption } from "../model-picker";
import { SettingsExtraPreview } from "./settings-extra-preview";
import {
  SettingsLayout,
  type SettingsNavigationGroup,
} from "../settings-layout";
import { SettingsRow } from "../settings-row";
import { Select } from "../select";
import { Switch } from "../switch";
import { Slider } from "../slider";
import { Input } from "../input";
import { Kbd } from "../kbd";
import { Avatar, AvatarFallback } from "../avatar";
import { Table, TableBody, TableRow, TableCell } from "../table";
const groups: SettingsNavigationGroup[] = [
  {
    label: "Personal",
    items: [
      {
        id: "general",
        label: "General",
        icon: <SlidersHorizontal size={16} />,
      },
      { id: "account", label: "Account", icon: <UserCircle size={16} /> },
      { id: "appearance", label: "Appearance", icon: <Palette size={16} /> },
      {
        id: "shortcuts",
        label: "Keyboard shortcuts",
        icon: <Keyboard size={16} />,
      },
      { id: "models", label: "Default models", icon: <Cpu size={16} /> },
      { id: "git", label: "Git", icon: <GitBranch size={16} /> },
    ],
  },
  {
    label: "Agents & environment",
    items: [
      { id: "agents", label: "Agents", icon: <Router size={16} /> },
      { id: "environment", label: "Environment", icon: <KeyRound size={16} /> },
    ],
  },
  {
    label: "Repositories",
    items: [
      {
        id: "repository",
        label: "interface-system",
        icon: <Folder size={16} />,
      },
    ],
  },
  {
    label: "More",
    items: [
      {
        id: "experimental",
        label: "Experimental",
        icon: <FlaskConical size={16} />,
      },
      { id: "advanced", label: "Advanced", icon: <Cog size={16} /> },
      { id: "terminal", label: "Big terminal", icon: <Terminal size={16} /> },
    ],
  },
];
type Preferences = Record<string, string | boolean | number>;
const defaults: Preferences = {
  theme: "dark",
  lowContrast: false,
  fontSize: 12,
  font: "",
  mono: "Geist Mono",
  send: "enter",
  follow: "queue",
  stripFlattery: false,
  restartOnUpdate: false,
  notifications: true,
  mentions: true,
  sound: "chime",
  manual: false,
  paste: true,
  context: false,
  caffeinate: false,
  artifacts: true,
  tools: false,
  sidebarDiffs: false,
  ligatures: true,
  branch: "main",
  gitName: "",
  gitEmail: "",
  shell: "System default",
  scrollback: 10000,
  displayName: "My workspace",
  personality: "pragmatic",
  outputStyle: "default",
  defaultPlan: false,
  reviewModel: "opus",
  agent: "codex",
  autoApprove: false,
  syncConfigs: false,
  environment: "local",
  terminalIntegration: true,
  clonePath: "~/Projects",
  branchPrefix: "",
  setupCommand: "",
  runCommand: "",
  compactTools: true,
  experimentalPreview: false,
  diagnostics: false,
};
function readPreferences(): Preferences {
  try {
    return {
      ...defaults,
      ...JSON.parse(localStorage.getItem("ui-library.preferences") ?? "{}"),
    };
  } catch {
    return defaults;
  }
}
export function SettingsPreview({
  onBack,
  onCloud,
  initialPage = "general",
  models,
  favorites,
  onFavoritesChange,
}: {
  onBack: () => void;
  onCloud?: () => void;
  initialPage?: string;
  models: ModelOption[];
  favorites: string[];
  onFavoritesChange: (ids: string[]) => void;
}) {
  const [page, setPage] = useState(initialPage);
  const [provider, setProvider] = useState("Claude Code");
  const [query, setQuery] = useState("");
  const [prefs, setPrefs] = useState(readPreferences);
  const change = (id: string, value: string | boolean | number) =>
    setPrefs((previous) => ({ ...previous, [id]: value }));
  useEffect(() => {
    try {
      localStorage.setItem("ui-library.preferences", JSON.stringify(prefs));
    } catch {
      /* Storage can be unavailable in private browsing. */
    }
  }, [prefs]);
  useEffect(() => {
    const media = matchMedia("(prefers-color-scheme: dark)");
    const apply = () => {
      const dark =
        prefs.theme === "dark" || (prefs.theme === "system" && media.matches);
      document.documentElement.classList.toggle("dark", dark);
      document.documentElement.classList.toggle("light", !dark);
      document.documentElement.classList.toggle(
        "contrast-low",
        dark && !!prefs.lowContrast,
      );
    };
    apply();
    media.addEventListener("change", apply);
    return () => media.removeEventListener("change", apply);
  }, [prefs.theme, prefs.lowContrast]);
  const matches = (title: string, description = "") =>
    !query ||
    `${title} ${description}`.toLowerCase().includes(query.toLowerCase());
  const toggle = (id: string, title: string, description?: string) =>
    matches(title, description) && (
      <SettingsRow
        key={id}
        title={title}
        description={description}
        htmlFor={`setting-${id}`}
        control={
          <Switch
            id={`setting-${id}`}
            checked={!!prefs[id]}
            onCheckedChange={(value) => change(id, value)}
          />
        }
      />
    );
  const select = (
    id: string,
    title: string,
    choices: [string, string][],
    description?: string,
  ) =>
    matches(title, description) && (
      <SettingsRow
        key={id}
        title={title}
        description={description}
        htmlFor={`setting-${id}`}
        control={
          <Select
            id={`setting-${id}`}
            aria-label={title}
            value={String(prefs[id])}
            onChange={(value) => change(id, value)}
            options={choices.map(([value, label]) => ({ value, label }))}
          />
        }
      />
    );
  const title =
    groups.flatMap((group) => group.items).find((item) => item.id === page)
      ?.label ?? "Settings";
  return (
    <SettingsLayout
      title={query ? "Search settings" : title}
      groups={groups}
      selected={page}
      onSelect={(id) => {
        setPage(id);
        setQuery("");
      }}
      onBack={onBack}
      query={query}
      onQueryChange={setQuery}
      account={
        <>
          <Avatar style={{ width: 20, height: 20 }}>
            <AvatarFallback>M</AvatarFallback>
          </Avatar>
          <span style={{ flex: 1 }}>My workspace</span>
          <ChevronDown size={14} />
        </>
      }
      toolbar={
        <span className="lab-dim" style={{ fontSize: 12 }}>
          Local interface preview
        </span>
      }
    >
      {page === "models" && (
        <>
          <ModelLoadout
            models={models}
            favorites={favorites}
            onChange={onFavoritesChange}
            onConfigure={(name) => {
              setProvider(name);
              setPage("agents");
            }}
          />
          {select("personality", "Codex personality", [
            ["pragmatic", "Pragmatic (default)"],
            ["friendly", "Friendly"],
          ])}
          {select(
            "outputStyle",
            "Claude output style",
            [
              ["default", "Default"],
              ["explanatory", "Explanatory"],
              ["learning", "Learning"],
            ],
            "Choose which output style to apply to new chats. Existing chats do not change.",
          )}
          {select(
            "reviewModel",
            "Review model",
            models.map((model) => [model.id, model.name]),
            "Model used to review code changes.",
          )}
          {toggle("defaultPlan", "Default to plan mode in new chats")}
        </>
      )}
      {page === "account" && (
        <>
          <SettingsRow
            title="Display name"
            description="Name displayed in this local preview."
            control={
              <Input
                aria-label="Display name"
                value={String(prefs.displayName)}
                onChange={(event) => change("displayName", event.target.value)}
              />
            }
          />
          <SettingsRow
            title="Workspace"
            description="My workspace"
            control={<span className="lab-plan-badge">Free</span>}
          />
        </>
      )}
      {page === "account" && onCloud && (
        <SettingsRow
          title="Cloud and collaboration"
          description="Explore shared workspaces, Cloud Computer, member administration, and plan interfaces."
          control={
            <Button size="sm" variant="secondary" onClick={onCloud}>
              Open cloud example
            </Button>
          }
        />
      )}
      <SettingsExtraPreview page={page} initialProvider={provider} />
      {page === "repository" && (
        <>
          {[
            ["clonePath", "Repository directory"],
            ["branchPrefix", "Branch prefix"],
            ["setupCommand", "Setup command"],
            ["runCommand", "Run command"],
          ].map(([id, title]) => (
            <SettingsRow
              key={id}
              title={title}
              control={
                <Input
                  aria-label={title}
                  value={String(prefs[id])}
                  onChange={(event) => change(id, event.target.value)}
                />
              }
            />
          ))}
        </>
      )}
      {(page === "general" || query) && (
        <>
          {select(
            "send",
            "Send messages with",
            [
              ["enter", "Enter"],
              ["mod-enter", "⌘ Enter"],
            ],
            "Choose which key combination sends messages",
          )}
          {select(
            "follow",
            "Follow-up behavior",
            [
              ["queue", "Queue"],
              ["steer", "Steer"],
            ],
            "Queue messages after the agent finishes, or steer the current turn.",
          )}
          {toggle(
            "notifications",
            "Agent notifications",
            "Get notified when an agent finishes working.",
          )}
          {toggle(
            "mentions",
            "@ notifications",
            "Get notified when a teammate mentions you.",
          )}
          {select(
            "sound",
            "Completion sound",
            [
              ["chime", "Chime"],
              ["bell", "Bell"],
              ["none", "None"],
            ],
            "Choose the sound for completed work.",
          )}
          {matches("Full disk access permissions") && (
            <SettingsRow
              title="Full disk access permissions"
              description="To let agents work without repeated folder permission prompts."
              control={
                <Button size="sm" variant="outline" disabled>
                  Open System Settings
                </Button>
              }
            />
          )}
          {toggle("manual", "Arrange workspaces manually")}
          {toggle(
            "paste",
            "Auto-convert long text",
            "Convert pasted text over 5000 characters into text attachments.",
          )}
          {toggle(
            "stripFlattery",
            "I'm not absolutely right, thank you very much",
            'Strip "You’re absolutely right!" from AI messages',
          )}
          {toggle(
            "context",
            "Always show context usage",
            "Keep the context usage indicator visible.",
          )}
          {toggle(
            "caffeinate",
            "Caffeinate while agents are running",
            "Keep your Mac awake while an agent is working.",
          )}
          {toggle(
            "restartOnUpdate",
            "Restart automatically on update",
            "Restart when idle after downloading an update.",
          )}
          {toggle("artifacts", "Show Artifacts tab")}
          {toggle(
            "tools",
            "Don't collapse tool calls (Garry Mode)",
            "Show all tool calls expanded by default instead of collapsed. Toggle with ⌃ O.",
          )}
          {matches("Sync agent configs") && (
            <SettingsRow
              title="Sync agent configs"
              description="Copy skills, slash commands, and MCP servers between Claude Code and Codex."
              control={
                <Button size="sm" variant="outline" disabled>
                  Sync
                </Button>
              }
            />
          )}
        </>
      )}
      {(page === "appearance" || query) && (
        <>
          {select(
            "theme",
            "Theme",
            [
              ["system", "System"],
              ["light", "Light"],
              ["dark", "Dark"],
            ],
            "Choose your preferred appearance.",
          )}
          {toggle("lowContrast", "Low-contrast dark mode")}
          {toggle(
            "sidebarDiffs",
            "Colored sidebar diffs",
            "Show line-change colors for unselected workspaces.",
          )}
          {select(
            "mono",
            "Mono Font",
            [
              ["Geist Mono", "Geist Mono"],
              ["SFMono-Regular", "SF Mono"],
              ["Menlo", "Menlo"],
            ],
            "Font used for code and diffs",
          )}
          {matches("Mono Font") && (
            <pre
              className="ui-settings-preview"
              style={{ fontFamily: String(prefs.mono) }}
            >
              {
                '// Preview\nconst greeting = "Hello, World!";\nfunction sum(a, b) { return a + b; }'
              }
            </pre>
          )}
          {toggle(
            "ligatures",
            "Code ligatures",
            "Use font ligatures in file editors and diffs.",
          )}
          {matches("Terminal Font") && (
            <SettingsRow
              title="Terminal Font"
              htmlFor="terminal-font"
              description="Enter a font installed on your computer."
              control={
                <Input
                  id="terminal-font"
                  value={String(prefs.font)}
                  onChange={(event) => change("font", event.target.value)}
                  placeholder="Leave empty for default"
                />
              }
            />
          )}
          {matches("Terminal Font Size") && (
            <SettingsRow
              title="Terminal Font Size"
              description={`${prefs.fontSize}px`}
              control={
                <Slider
                  aria-label="Terminal font size"
                  min={10}
                  max={24}
                  step={1}
                  value={[Number(prefs.fontSize)]}
                  onValueChange={([value]) => change("fontSize", value)}
                />
              }
            >
              <pre
                style={{
                  fontSize: Number(prefs.fontSize),
                  fontFamily: String(prefs.font || prefs.mono),
                }}
              >
                {"~/project main ±3 ?2 ❯ npm test\n✓ All tests passed!"}
              </pre>
            </SettingsRow>
          )}
        </>
      )}
      {(page === "shortcuts" || query) && (
        <Table>
          <TableBody>
            {[
              ["Open command menu", "⌘ K"],
              ["Open settings", "⌘ ,"],
              ["Toggle left sidebar", "⌘ B"],
              ["New chat", "⌘ N"],
              ["Send message", "Enter"],
              ["New line", "⇧ Enter"],
              ["Close menu", "Escape"],
            ]
              .filter(([label]) => matches(label))
              .map(([label, keys]) => (
                <TableRow key={label}>
                  <TableCell>{label}</TableCell>
                  <TableCell style={{ textAlign: "right" }}>
                    <Kbd>{keys}</Kbd>
                  </TableCell>
                </TableRow>
              ))}
          </TableBody>
        </Table>
      )}
      {(page === "git" || query) && (
        <>
          {[
            ["branch", "Default branch"],
            ["gitName", "Git author name"],
            ["gitEmail", "Git author email"],
          ]
            .filter(([, label]) => matches(label))
            .map(([id, label]) => (
              <SettingsRow
                key={id}
                title={label}
                htmlFor={id}
                control={
                  <Input
                    id={id}
                    value={String(prefs[id])}
                    onChange={(event) => change(id, event.target.value)}
                  />
                }
              />
            ))}
        </>
      )}
      {(page === "terminal" || query) && (
        <>
          {select("shell", "Default shell", [
            ["System default", "System default"],
            ["zsh", "zsh"],
            ["bash", "bash"],
          ])}
          {matches("Scrollback") && (
            <SettingsRow
              title="Scrollback"
              description="Number of lines retained in terminal history."
              htmlFor="scrollback"
              control={
                <Input
                  id="scrollback"
                  type="number"
                  min={1000}
                  max={100000}
                  step={1000}
                  value={Number(prefs.scrollback)}
                  onChange={(event) =>
                    change(
                      "scrollback",
                      Math.max(
                        1000,
                        Math.min(100000, Number(event.target.value)),
                      ),
                    )
                  }
                />
              }
            />
          )}
        </>
      )}
    </SettingsLayout>
  );
}
