import { useState, type ReactNode } from "react";
import {
  Plus,
  Copy,
  Smartphone,
  ShieldCheck,
  KeyRound,
  ArrowUpRight,
} from "lucide-react";
import { Button } from "./button";
import { Input } from "./input";
import { Textarea } from "./textarea";
import { Switch } from "./switch";
import { Select } from "./select";
import { SettingsRow } from "./settings-row";
import { Checkbox } from "./checkbox";
import { AsciiSpinner } from "./ascii-spinner";
import {
  Dialog,
  DialogContent,
  DialogTitle,
  DialogDescription,
} from "./dialog";
export interface CloudApiKeyRow {
  id: string;
  name: string;
  /** The line under the name: when it was made, its prefix. */
  detail: string;
  revocable?: boolean;
}
export interface CloudApiScope {
  id: string;
  label: string;
}
export interface CloudApiCopy {
  create: string;
  submit: string;
  revoke: string;
  createdTitle: string;
  createdDescription: string;
  createDescription: string;
  copy: string;
}
export function CloudApiSettings({
  intro,
  keys,
  empty,
  error,
  scopes,
  defaultScopes = [],
  copy,
  revoking,
  onCreate,
  onRevoke,
  children,
}: {
  /** Rows above the keys, starting with the page's own line. */
  intro: ReactNode;
  keys: CloudApiKeyRow[];
  /** Said in place of the list when there are no keys. */
  empty?: ReactNode;
  error?: string | null;
  /** What a new key may do; left out, a key is only named. */
  scopes?: CloudApiScope[];
  defaultScopes?: string[];
  copy: CloudApiCopy;
  /** The key whose revoke is out. */
  revoking?: string | null;
  /** Makes the key and answers its secret, shown once. */
  onCreate: (name: string, scopes: string[]) => Promise<string>;
  onRevoke: (id: string) => void;
  /** Sections under the keys. */
  children?: ReactNode;
}) {
  const [name, setName] = useState(""),
    [picked, setPicked] = useState<string[]>(defaultScopes),
    [open, setOpen] = useState(false),
    [token, setToken] = useState(""),
    [notice, setNotice] = useState(""),
    [busy, setBusy] = useState(false),
    [failed, setFailed] = useState("");
  const close = (v: boolean) => {
    setOpen(v);
    if (!v) {
      setToken("");
      setNotice("");
      setFailed("");
      setPicked(defaultScopes);
    }
  };
  return (
    <div className="ui-cloud-settings">
      {intro}
      <h3>API keys</h3>
      {error && <p role="alert">{error}</p>}
      {!keys.length && empty}
      {keys.map((k) => (
        <div className="ui-cloud-member-row" key={k.id}>
          <KeyRound size={16} />
          <span>
            <strong>{k.name}</strong>
            <small>{k.detail}</small>
          </span>
          {k.revocable !== false && (
            <Button variant="ghost" size="sm" disabled={revoking === k.id} onClick={() => onRevoke(k.id)}>
              {revoking === k.id && <AsciiSpinner size={11} />}
              {copy.revoke}
            </Button>
          )}
        </div>
      ))}
      <Button size="sm" variant="secondary" onClick={() => setOpen(true)}>
        <Plus />
        {copy.create}
      </Button>
      {children}
      <Dialog open={open} onOpenChange={close}>
        <DialogContent>
          <DialogTitle>{token ? copy.createdTitle : copy.create}</DialogTitle>
          <DialogDescription>{token ? copy.createdDescription : copy.createDescription}</DialogDescription>
          {token ? (
            <>
              <Input readOnly aria-label="New API key" value={token} />
              <Button
                onClick={async () => {
                  try {
                    await navigator.clipboard.writeText(token);
                    setNotice("Copied");
                  } catch {
                    setNotice("Clipboard unavailable");
                  }
                }}
              >
                <Copy />
                {copy.copy}
              </Button>
              <p role="status">{notice}</p>
            </>
          ) : (
            <form
              onSubmit={(e) => {
                e.preventDefault();
                if (!name.trim() || busy || (scopes && !picked.length)) return;
                setBusy(true);
                setFailed("");
                onCreate(name.trim(), picked)
                  .then((secret) => {
                    setToken(secret);
                    setName("");
                  })
                  .catch((err: unknown) => setFailed(err instanceof Error ? err.message : String(err)))
                  .finally(() => setBusy(false));
              }}
            >
              <Input
                required
                aria-label="API key name"
                placeholder="Key name"
                value={name}
                onChange={(e) => setName(e.target.value)}
              />
              {scopes && (
                <fieldset className="ui-cloud-scopes" aria-label="What the key may do">
                  {scopes.map((scope) => (
                    <label key={scope.id} className="ui-cloud-inline">
                      <Checkbox
                        checked={picked.includes(scope.id)}
                        onCheckedChange={(on) =>
                          setPicked((ps) => (on === true ? [...ps, scope.id] : ps.filter((x) => x !== scope.id)))
                        }
                      />
                      {scope.label}
                    </label>
                  ))}
                </fieldset>
              )}
              {failed && <p role="alert">{failed}</p>}
              <Button type="submit" disabled={busy || (!!scopes && !picked.length)}>
                {busy && <AsciiSpinner size={11} />}
                {copy.submit}
              </Button>
            </form>
          )}
        </DialogContent>
      </Dialog>
    </div>
  );
}
export function CloudRepositorySettings() {
  const [repo, setRepo] = useState("interface-system"),
    [scripts, setScripts] = useState<Record<string, string>>({
      "interface-system": "pnpm install --frozen-lockfile",
      "design-system": "pnpm install",
    }),
    [saved, setSaved] = useState(false);
  return (
    <div className="ui-cloud-settings">
      <Select
        aria-label="Repository settings"
        value={repo}
        onChange={(v) => {
          setRepo(v);
          setSaved(false);
        }}
        options={["interface-system", "design-system"].map((v) => ({
          value: v,
          label: v,
        }))}
      />
      <h3 style={{ marginTop: 24 }}>Setup script</h3>
      <p>
        Runs for each new workspace. Saving applies to the next workspace and
        does not require rebuilding the computer.
      </p>
      <Textarea
        className="ui-cloud-script"
        aria-label="Repository setup script"
        value={scripts[repo]}
        onChange={(e) => {
          setScripts((s) => ({ ...s, [repo]: e.target.value }));
          setSaved(false);
        }}
      />
      <Button size="sm" onClick={() => setSaved(true)}>
        {saved ? "Saved" : "Save"}
      </Button>
      <h3 style={{ marginTop: 28 }}>Custom actions</h3>
      <SettingsRow
        title="Development server"
        description="pnpm dev --host 0.0.0.0 --port 3000"
        control={
          <Button size="sm" variant="secondary" onClick={() => setSaved(true)}>
            Save action
          </Button>
        }
      />
    </div>
  );
}
export function CloudPortsSettings() {
  const [exclusive, setExclusive] = useState(false),
    [sync, setSync] = useState(false),
    [approvals, setApprovals] = useState(true);
  return (
    <>
      <SettingsRow
        title="Exclusive port forwarding"
        description="Starting forwarding in one workspace stops it in other workspaces."
        control={
          <Switch
            aria-label="Exclusive port forwarding"
            checked={exclusive}
            onCheckedChange={setExclusive}
          />
        }
      />
      <SettingsRow
        title="Enable file sync in new cloud workspaces"
        description="Mirror cloud files to a local directory for tools on this Mac."
        control={
          <Switch
            aria-label="Enable file sync in new cloud workspaces"
            checked={sync}
            onCheckedChange={setSync}
          />
        }
      />
      <SettingsRow
        title="Require approval for local commands"
        description="Review local tool access from cloud agents."
        control={
          <Switch
            aria-label="Require approval for local commands"
            checked={approvals}
            onCheckedChange={setApprovals}
          />
        }
      />
    </>
  );
}
export function CloudSecuritySettings() {
  const [saml, setSaml] = useState(false),
    [scim, setScim] = useState(false);
  return (
    <div className="ui-cloud-settings">
      <p>
        Enterprise administration example. External admin portal styling has not
        been verified against a signed-in Enterprise account.
      </p>
      <SettingsRow
        title="SAML single sign-on"
        control={
          <Switch
            aria-label="SAML single sign-on"
            checked={saml}
            onCheckedChange={setSaml}
          />
        }
      />
      {saml && (
        <>
          <Input
            aria-label="SSO sign-in URL"
            placeholder="https://idp.example.test/sso"
          />
          <Input aria-label="SSO entity ID" placeholder="Entity ID" />
        </>
      )}
      <SettingsRow
        title="SCIM provisioning"
        control={
          <Switch
            aria-label="SCIM provisioning"
            checked={scim}
            onCheckedChange={setScim}
          />
        }
      />
      {scim && (
        <p className="ui-cloud-note">
          Provisioning enabled for this example. No identity provider is
          connected.
        </p>
      )}
      <SettingsRow
        title="Data processing agreement"
        control={
          <span className="ui-cloud-badge">
            <ShieldCheck size={12} />
            Enterprise
          </span>
        }
      />
      <SettingsRow
        control={<span className="ui-cloud-badge">Enterprise</span>}
        title="Purchase-order billing"
        description="Available through your organization agreement."
      />
      <SettingsRow
        control={<span className="ui-cloud-badge">SLA</span>}
        title="Dedicated support"
        description="Service-level agreement and dedicated support channels."
      />
    </div>
  );
}
export function CloudMobilePreview({
  onOpenWorkspace,
}: {
  onOpenWorkspace: () => void;
}) {
  return (
    <div className="ui-cloud-settings">
      <p>
        Continue cloud work from a mobile device. This compact view demonstrates
        the shared workspace flow.
      </p>
      <div className="ui-cloud-mobile">
        <header>
          <Smartphone size={18} />
          Studio <span>Cloud</span>
        </header>
        <h3>My workspaces</h3>
        {[
          "Workspace command menu",
          "Polish onboarding flow",
          "Keyboard shortcuts",
        ].map((t, i) => (
          <button key={t} onClick={onOpenWorkspace}>
            <span>
              {t}
              <small>
                {i === 0
                  ? "Maya is active · Ready for review"
                  : "Updated recently"}
              </small>
            </span>
            <ArrowUpRight size={14} />
          </button>
        ))}
        <footer>
          <Button size="sm" variant="secondary" onClick={onOpenWorkspace}>
            <Plus />
            New workspace
          </Button>
        </footer>
      </div>
      <p className="ui-cloud-note">
        Companion layout example; native mobile screens are not in the installed
        desktop bundle.
      </p>
    </div>
  );
}
