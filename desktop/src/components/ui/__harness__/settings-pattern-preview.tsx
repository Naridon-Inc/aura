import { useState } from "react";
import {
  SettingsField,
  SettingsScopeSwitch,
  KeyboardShortcutEditor,
  type ShortcutBinding,
} from "../settings-controls";
import { SettingsSection } from "../settings-row";
const defaults: ShortcutBinding[] = [
  { id: "new", label: "New chat", group: "Workspace", keys: "Cmd+N", defaultKeys: "Cmd+N" },
  { id: "search", label: "Search", group: "Workspace", keys: "Cmd+K", defaultKeys: "Cmd+K" },
  {
    id: "left",
    label: "Toggle left sidebar",
    group: "Navigation",
    keys: "Cmd+B",
    defaultKeys: "Cmd+B",
  },
  {
    id: "right",
    label: "Toggle right sidebar",
    group: "Navigation",
    keys: "Cmd+Alt+B",
    defaultKeys: "Cmd+Alt+B",
  },
  { id: "send", label: "Send message", group: "Chat", keys: "Enter", defaultKeys: "Enter" },
];
export function SettingsPatternPreview() {
  const [scope, setScope] = useState("user"),
    [bindings, setBindings] = useState(defaults);
  const [values, setValues] = useState<Record<string, string | boolean | number>>({
    notifications: true,
    managed: true,
    font: "system",
    size: 14,
    command: "bun run dev",
    path: "~/Projects",
    secret: "preview-value",
    instructions: "Use the workspace conventions.",
  });
  const change = (key: string) => (value: string | boolean | number) =>
    setValues({ ...values, [key]: value });
  return (
    <div className="lab-pattern-stack">
      <SettingsScopeSwitch
        value={scope}
        onChange={setScope}
        scopes={[
          { value: "user", label: "Personal settings" },
          { value: "workspace", label: "Workspace settings" },
          { value: "organization", label: "Organization settings" },
        ]}
      />
      <SettingsSection
        title="Preferences"
        description="Settings inherit from the broader scope unless overridden."
      >
        <SettingsField
          title="Notifications"
          description="Notify when an agent needs your attention."
          type="switch"
          value={values.notifications}
          onChange={change("notifications")}
          inheritedFrom={scope === "workspace" ? "Personal settings" : undefined}
          onReset={() => change("notifications")(true)}
        />
        <SettingsField
          title="Interface font"
          type="select"
          value={values.font}
          onChange={change("font")}
          options={[
            { value: "system", label: "System" },
            { value: "mono", label: "Monospace" },
          ]}
        />
        <SettingsField
          title="Font size"
          type="number"
          value={values.size}
          onChange={change("size")}
          min={10}
          max={24}
          error={
            Number(values.size) < 10 || Number(values.size) > 24
              ? "Choose a size between 10 and 24."
              : undefined
          }
        />
        <SettingsField
          title="Run command"
          type="text"
          value={values.command}
          onChange={change("command")}
        />
        <SettingsField
          title="Workspace directory"
          type="path"
          value={values.path}
          onChange={change("path")}
          onBrowse={() => change("path")("~/Projects/workspace")}
        />
        <SettingsField
          title="Secret value"
          type="secret"
          value={values.secret}
          onChange={change("secret")}
          description="Example value stored only in this preview."
        />
        <SettingsField
          title="Agent instructions"
          type="textarea"
          value={values.instructions}
          onChange={change("instructions")}
        />
        <SettingsField
          title="Managed preference"
          type="switch"
          value={values.managed}
          onChange={change("managed")}
          managed
        />
      </SettingsSection>
      <KeyboardShortcutEditor
        bindings={bindings}
        onChange={(id, keys) =>
          setBindings(
            bindings.map((binding) => (binding.id === id ? { ...binding, keys } : binding)),
          )
        }
      />
    </div>
  );
}
