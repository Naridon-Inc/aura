import { useState, type ReactNode } from "react";
import { Cloud, Lock, Plus, Check, ArrowUpRight } from "lucide-react";
import { Button } from "./button";
import { Input } from "./input";
import { Select } from "./select";
import {
  Dialog,
  DialogContent,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from "./dialog";
import { AgentIcon } from "./agent-icon";
import { AsciiSpinner } from "./ascii-spinner";
import { SettingsRow } from "./settings-row";
import { MemberAvatar, type CloudMember } from "./cloud-workspace";
export type CloudPlan = "Free" | "Pro" | "Teams" | "Enterprise";
export interface CloudGateCopy {
  title: string;
  body: string;
  /** The button's words; the button is left out when there is nothing to do. */
  action?: string | null;
}
export function CloudFeatureGate({
  plan,
  feature,
  onPlans,
  copy,
  children,
}: {
  /** Null when the plan couldn't be read: the gate stays shut and `copy` says why. */
  plan: CloudPlan | null;
  feature: "cloud" | "team" | "enterprise";
  onPlans: () => void;
  /** Overrides the plan words, for a gate that is shut for another reason. */
  copy?: CloudGateCopy;
  children: ReactNode;
}) {
  const allowed =
    plan !== null &&
    (feature === "enterprise"
      ? plan === "Enterprise"
      : feature === "team"
        ? ["Teams", "Enterprise"].includes(plan)
        : plan !== "Free");
  const action = copy ? copy.action : "View plans";
  return allowed ? (
    <>{children}</>
  ) : (
    <div className="ui-cloud-gate">
      <Cloud size={32} />
      <h2>
        {copy
          ? copy.title
          : feature === "cloud"
            ? "Run workspaces in the cloud"
            : feature === "team"
              ? "Work together with your team"
              : "Enterprise controls"}
      </h2>
      <p>
        {copy
          ? copy.body
          : feature === "cloud"
            ? "Shared workspaces, mobile access, and the API are included with Pro."
            : feature === "team"
              ? "Organization administration and centralized billing are part of Teams."
              : "Advanced security and provisioning are part of Enterprise."}
      </p>
      {action && <Button onClick={onPlans}>{action}</Button>}
    </div>
  );
}
export interface CloudPlanTier {
  plan: Exclude<CloudPlan, "Free">;
  features: string[];
  /** What it costs, as the pricing page says it: "$10". */
  price?: string;
  /** What the price is per: "a month", "a seat a month". */
  per?: string;
  /** The button's words; null leaves the button out. */
  action: string | null;
}
export function CloudPlanSettings({
  plan,
  summary,
  note,
  tiers,
  busy,
  onSelect,
  children,
}: {
  /** Null while the plan is unread: the badge stays empty. */
  plan: CloudPlan | null;
  /** The Plan row's second line. */
  summary: ReactNode;
  note?: ReactNode;
  tiers: CloudPlanTier[];
  /** The tier whose button is working. */
  busy?: CloudPlan | null;
  onSelect: (plan: CloudPlanTier["plan"]) => void;
  /** Rows under the plans. */
  children?: ReactNode;
}) {
  return (
    <div className="ui-cloud-settings">
      <SettingsRow
        title="Plan"
        description={summary}
        control={plan && <span className="ui-cloud-badge">{plan}</span>}
      />
      {note && <p className="ui-cloud-note">{note}</p>}
      <div className="ui-cloud-plans">
        {tiers.map((t) => (
          <section key={t.plan}>
            <h3>{t.plan}</h3>
            {t.price && (
              <p className="ui-cloud-price">
                <strong>{t.price}</strong>
                {t.per && <span> {t.per}</span>}
              </p>
            )}
            <ul>
              {t.features.map((f) => (
                <li key={f}>
                  <Check size={13} />
                  {f}
                </li>
              ))}
            </ul>
            {t.action && (
              <Button
                variant={plan === t.plan ? "ghost" : "secondary"}
                size="sm"
                disabled={!!busy}
                onClick={() => onSelect(t.plan)}
              >
                {busy === t.plan && <AsciiSpinner size={11} />}
                {t.action}
              </Button>
            )}
          </section>
        ))}
      </div>
      {children}
    </div>
  );
}
export function CloudMembersSettings({
  members,
  onInvite,
  onRoleChange,
}: {
  members: CloudMember[];
  onInvite: (email: string, role: "Admin" | "Member") => void;
  onRoleChange: (id: string, role: "Admin" | "Member") => void;
}) {
  const [invite, setInvite] = useState(false),
    [email, setEmail] = useState(""),
    [role, setRole] = useState<"Admin" | "Member">("Member"),
    [error, setError] = useState("");
  return (
    <div className="ui-cloud-settings">
      <header className="ui-cloud-row">
        <p>People in Studio</p>
        <Button size="sm" variant="secondary" onClick={() => setInvite(true)}>
          <Plus />
          Invite member
        </Button>
      </header>
      {members.map((m) => (
        <div className="ui-cloud-member-row" key={m.id}>
          <MemberAvatar member={m} />
          <span>
            <strong>{m.name}</strong>
            <small>
              {m.id.startsWith("invite-")
                ? "Invitation pending"
                : m.active
                  ? "Active now"
                  : "Member"}
            </small>
          </span>
          <Select
            aria-label={`Role for ${m.name}`}
            value={m.role}
            disabled={m.id === "you"}
            onChange={(v) => onRoleChange(m.id, v as "Admin" | "Member")}
            options={[
              { value: "Admin", label: "Admin" },
              { value: "Member", label: "Member" },
            ]}
          />
        </div>
      ))}
      <Dialog open={invite} onOpenChange={setInvite}>
        <DialogContent>
          <DialogTitle>Invite to Studio</DialogTitle>
          <DialogDescription>
            Add a sample member. No invitation will be sent from this preview.
          </DialogDescription>
          <form
            onSubmit={(e) => {
              e.preventDefault();
              if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
                setError("Enter a valid email address.");
                return;
              }
              onInvite(email, role);
              setEmail("");
              setError("");
              setInvite(false);
            }}
          >
            <Input
              type="email"
              required
              aria-label="Invite email"
              placeholder="teammate@example.test"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
            />
            <Select
              aria-label="Invite role"
              value={role}
              onChange={(v) => setRole(v as "Admin" | "Member")}
              options={[
                { value: "Member", label: "Member" },
                { value: "Admin", label: "Admin" },
              ]}
            />
            {error && <p role="alert">{error}</p>}
            <DialogFooter>
              <Button variant="ghost" onClick={() => setInvite(false)}>
                Cancel
              </Button>
              <Button type="submit">Add example member</Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>
    </div>
  );
}
export function CloudOrganizationSettings({
  name,
  onRename,
  note,
  children,
}: {
  name: string;
  /** Leave out where a name can't be changed: the name is shown, not edited. */
  onRename?: (name: string) => void;
  note?: ReactNode;
  /** The organization's other rows. */
  children?: ReactNode;
}) {
  return (
    <div className="ui-cloud-settings">
      <SettingsRow
        title="Organization name"
        control={
          onRename ? (
            <Input aria-label="Organization name" value={name} onChange={(e) => onRename(e.target.value)} />
          ) : (
            <strong>{name}</strong>
          )
        }
      />
      {children}
      {note && (
        <p className="ui-cloud-note">
          <Lock size={13} /> {note}
        </p>
      )}
    </div>
  );
}
export function CloudAgentSettings() {
  const [scope, setScope] = useState("Personal"),
    [connected, setConnected] = useState<string[]>(["Personal:Codex"]),
    [agent, setAgent] = useState<string>(),
    [method, setMethod] = useState("Subscription"),
    [sample, setSample] = useState(""),
    [baseUrl, setBaseUrl] = useState(""),
    [error, setError] = useState("");
  const close = () => {
    setAgent(undefined);
    setSample("");
    setBaseUrl("");
    setError("");
  };
  const connect = () => {
    if (method !== "Subscription" && !sample.trim()) {
      setError("Enter a sample credential.");
      return;
    }
    if (method === "Custom provider" && !/^https?:\/\//.test(baseUrl)) {
      setError("Enter a valid provider URL.");
      return;
    }
    setConnected((cs) => [...new Set([...cs, scope + ":" + agent])]);
    close();
  };
  return (
    <div className="ui-cloud-settings">
      <div className="ui-cloud-segments">
        {["Personal", "Shared"].map((s) => (
          <button
            key={s}
            aria-pressed={scope === s}
            onClick={() => setScope(s)}
          >
            {s}
          </button>
        ))}
      </div>
      <p>
        {scope === "Shared"
          ? "Manage agent credentials shared by your organization."
          : "Connect your subscriptions and API keys for cloud workspaces."}
      </p>
      {["Claude Code", "Codex", "Cursor", "OpenCode"].map((name) => {
        const key = scope + ":" + name;
        return (
          <SettingsRow
            key={key}
            title={
              <span className="ui-cloud-inline">
                <AgentIcon provider={name} />
                {name}
              </span>
            }
            description={
              connected.includes(key)
                ? "Connected · Example credential"
                : "Not connected"
            }
            control={
              <div className="ui-cloud-inline">
                {connected.includes(key) && (
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={() =>
                      setConnected((cs) => cs.filter((k) => k !== key))
                    }
                  >
                    Disconnect
                  </Button>
                )}
                <Button
                  variant="secondary"
                  size="sm"
                  onClick={() => {
                    setAgent(name);
                    setMethod(scope === "Shared" ? "API key" : "Subscription");
                    setError("");
                  }}
                >
                  {connected.includes(key) ? "Manage" : "Connect"}
                  <ArrowUpRight />
                </Button>
              </div>
            }
          />
        );
      })}
      <Dialog open={!!agent} onOpenChange={(open) => !open && close()}>
        <DialogContent>
          <DialogTitle>Connect {agent}</DialogTitle>
          <DialogDescription>
            {scope} credentials for cloud workspaces. Use sample values in this
            local preview.
          </DialogDescription>
          <div className="ui-cloud-segments">
            {(scope === "Shared"
              ? ["API key", "Custom provider"]
              : ["Subscription", "API key", "Custom provider"]
            ).map((m) => (
              <button
                key={m}
                aria-pressed={method === m}
                onClick={() => {
                  setMethod(m);
                  setError("");
                }}
              >
                {m}
              </button>
            ))}
          </div>
          {method === "Subscription" ? (
            <>
              <p>Import your {agent} subscription from this computer.</p>
              {agent === "Claude Code" && (
                <code className="ui-cloud-setup-command">
                  claude setup-token
                </code>
              )}
            </>
          ) : (
            <>
              <Input
                type="password"
                aria-label="Example agent API key"
                placeholder="Sample credential"
                value={sample}
                onChange={(e) => setSample(e.target.value)}
              />
              {method === "Custom provider" && (
                <Input
                  aria-label="Provider base URL"
                  placeholder="https://api.example.test/v1"
                  value={baseUrl}
                  onChange={(e) => setBaseUrl(e.target.value)}
                />
              )}
            </>
          )}
          {error && <p role="alert">{error}</p>}
          <DialogFooter>
            <Button variant="ghost" onClick={close}>
              Cancel
            </Button>
            <Button onClick={connect}>
              {method === "Subscription"
                ? "Import example credential"
                : "Save example credential"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
