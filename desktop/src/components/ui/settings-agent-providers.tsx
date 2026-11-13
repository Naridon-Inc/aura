// The agents settings page: one tab per coding agent, the sign-in method
// cards, the live sign-in line, the executable that runs and the agent's own
// config file. Same markup and classes as `ProviderSettings`, but every
// value and action comes from the caller, so the page can show what this
// machine really has instead of a fixed list of four.

import { useEffect, useState, type ReactNode } from "react";
import { Check, Folder, KeyRound, Play, Terminal } from "lucide-react";

import { AgentIcon } from "./agent-icon";
import { AsciiSpinner } from "./ascii-spinner";
import { Button } from "./button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "./dropdown-menu";
import { Input } from "./input";
import { SettingsRow } from "./settings-row";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "./tab-panels";
import "./settings-agent-providers.css";

export interface AgentProviderTab {
  id: string;
  label: string;
  icon: ReactNode;
  /** Longer facts about the agent, read on hover. */
  title?: string;
  content: ReactNode;
}

export function AgentProviderTabs({
  tabs,
  value,
  onValueChange,
}: {
  tabs: AgentProviderTab[];
  value: string;
  onValueChange: (id: string) => void;
}) {
  return (
    <Tabs value={value} onValueChange={onValueChange} className="ui-provider-settings">
      <TabsList aria-label="Agent providers" className="ui-provider-tabs ui-agent-provider-tabs">
        {tabs.map((tab) => (
          <TabsTrigger key={tab.id} value={tab.id} title={tab.title}>
            {tab.icon}
            {tab.label}
          </TabsTrigger>
        ))}
      </TabsList>
      {tabs.map((tab) => (
        <TabsContent key={tab.id} value={tab.id}>
          {tab.content}
        </TabsContent>
      ))}
    </Tabs>
  );
}

export interface AgentAuthMethod {
  id: string;
  label: string;
  icon: "cli" | "key" | "chatgpt";
  recommended?: boolean;
}

export function AgentAuthSection({
  name,
  methods,
  method,
  onMethodChange,
  status,
  children,
}: {
  name: string;
  methods: AgentAuthMethod[];
  method: string;
  onMethodChange: (id: string) => void;
  /** The live sign-in line, drawn by the caller with its refresh action. */
  status: ReactNode;
  /** What the chosen method does: a sign-in button or a key field. */
  children: ReactNode;
}) {
  return (
    <section className="ui-provider-auth">
      <h2>Authentication</h2>
      <div className="ui-provider-methods" role="group" aria-label={`${name} authentication`}>
        {methods.map((choice) => (
          <button
            key={choice.id}
            type="button"
            aria-pressed={method === choice.id}
            onClick={() => onMethodChange(choice.id)}
          >
            {method === choice.id && <Check size={16} className="ui-provider-method-check" />}
            {choice.icon === "key" ? (
              <KeyRound size={24} />
            ) : choice.icon === "chatgpt" ? (
              <AgentIcon provider="Codex" size={24} />
            ) : (
              <Terminal size={24} />
            )}
            <span>
              {choice.label}
              {choice.recommended && (
                <small style={{ display: "block", color: "var(--ui-muted-fg)" }}>
                  Recommended
                </small>
              )}
            </span>
          </button>
        ))}
      </div>
      {status}
      {children}
    </section>
  );
}

/** The sign-in button under the method cards. A sign-in waits on the
 *  browser, so the button holds a loader until the agent's CLI returns. */
export function AgentLoginButton({
  label,
  running,
  disabled,
  onClick,
}: {
  label: string;
  running?: boolean;
  disabled?: boolean;
  onClick: () => void;
}) {
  return (
    <Button variant="outline" size="sm" disabled={disabled || running} onClick={onClick}>
      {running ? <AsciiSpinner /> : <Play />}
      {label}
    </Button>
  );
}

export function AgentApiKeyField({
  name,
  saving,
  onSave,
}: {
  name: string;
  saving?: boolean;
  /** Resolves true once the key is stored, which clears the field. */
  onSave: (key: string) => Promise<boolean>;
}) {
  const [key, setKey] = useState("");
  return (
    <div className="ui-provider-api-field" style={{ display: "flex", gap: 8 }}>
      <Input
        type="password"
        aria-label={`${name} API key`}
        placeholder={`${name} API key`}
        autoComplete="off"
        value={key}
        onChange={(event) => setKey(event.target.value)}
      />
      <Button
        size="sm"
        variant="outline"
        disabled={saving || !key.trim()}
        onClick={async () => {
          if (await onSave(key.trim())) setKey("");
        }}
      >
        {saving && <AsciiSpinner />}
        Save
      </Button>
    </div>
  );
}

/** Which binary the agent starts. Editable when the caller can store a new
 *  one (`onCommit`); otherwise it reports the copy that runs, and the folder
 *  button shows that copy on disk. */
export function AgentExecutableRow({
  name,
  description,
  value,
  placeholder,
  onCommit,
  onBrowse,
  browseLabel,
}: {
  name: string;
  description: ReactNode;
  value: string;
  placeholder: string;
  onCommit?: (value: string) => void;
  onBrowse?: () => void;
  browseLabel: string;
}) {
  const [draft, setDraft] = useState(value);
  useEffect(() => setDraft(value), [value]);
  const commit = () => {
    if (onCommit && draft.trim() && draft.trim() !== value) onCommit(draft.trim());
  };
  return (
    <SettingsRow
      title={`${name} executable path`}
      description={description}
      control={
        <div style={{ display: "flex", gap: 8 }}>
          <Input
            aria-label={`${name} executable path`}
            placeholder={placeholder}
            value={draft}
            readOnly={!onCommit}
            title={value || undefined}
            onChange={(event) => setDraft(event.target.value)}
            onBlur={commit}
            onKeyDown={(event) => {
              if (event.key === "Enter") commit();
              if (event.key === "Escape" && draft !== value) {
                // The edit is cancelled here; Settings stays open. With
                // nothing to cancel, Escape closes Settings as usual.
                event.preventDefault();
                setDraft(value);
              }
            }}
          />
          <Button
            size="iconSm"
            variant="outline"
            aria-label={browseLabel}
            title={browseLabel}
            disabled={!onBrowse}
            onClick={() => onBrowse?.()}
          >
            <Folder />
          </Button>
        </div>
      }
    />
  );
}

export interface AgentEditorChoice {
  id: string;
  name: string;
}

/** A config file the agent reads, opened in an editor of the reader's
 *  choice. The menu lists only editors this machine can launch. */
export function AgentConfigFileRow({
  title,
  path,
  editors,
  onMenuOpen,
  onOpen,
}: {
  title: string;
  path: string;
  editors: AgentEditorChoice[] | null;
  onMenuOpen: () => void;
  onOpen: (editorId: string) => void;
}) {
  return (
    <SettingsRow
      title={title}
      description={path}
      control={
        <DropdownMenu onOpenChange={(open) => open && onMenuOpen()}>
          <DropdownMenuTrigger asChild>
            <Button size="sm" variant="outline">
              <Folder />
              Open in
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end">
            {editors === null ? (
              <DropdownMenuItem disabled>
                <AsciiSpinner />
                Finding editors
              </DropdownMenuItem>
            ) : (
              editors.map((editor) => (
                <DropdownMenuItem key={editor.id} onSelect={() => onOpen(editor.id)}>
                  {editor.name}
                </DropdownMenuItem>
              ))
            )}
          </DropdownMenuContent>
        </DropdownMenu>
      }
    />
  );
}
