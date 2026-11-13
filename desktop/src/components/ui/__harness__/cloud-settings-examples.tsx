// The harness's org settings, with the example data the parts no longer
// carry themselves: a sample plan ladder, a sample organization, sample keys.
import { useState } from "react";
import { Select } from "../select";
import { SettingsRow } from "../settings-row";
import { Switch } from "../switch";
import { CloudOrganizationSettings, CloudPlanSettings, type CloudPlan, type CloudPlanTier } from "../cloud-organization";
import { CloudApiSettings, type CloudApiKeyRow } from "../cloud-services";

const FEATURES: Record<CloudPlanTier["plan"], string[]> = {
  Pro: ["Cloud workspaces", "Shared workspaces", "Mobile access", "API access"],
  Teams: ["Everything in Pro", "Organization multiplayer", "Centralized billing", "Member roles"],
  Enterprise: ["Everything in Teams", "Automated provisioning", "Advanced security", "Dedicated support"],
};

export function ExamplePlanSettings({ plan, onPreviewPlan }: { plan: CloudPlan; onPreviewPlan: (plan: CloudPlan) => void }) {
  return (
    <CloudPlanSettings
      plan={plan}
      summary={`${plan} · Local plan preview`}
      note="These are reference plan interfaces. Selecting a plan changes this local example; it does not purchase a subscription."
      tiers={(["Pro", "Teams", "Enterprise"] as const).map((p) => ({
        plan: p,
        features: FEATURES[p],
        action: plan === p ? "Current example" : "Preview " + p,
      }))}
      onSelect={onPreviewPlan}
    >
      <SettingsRow
        title="Enterprise data privacy"
        description="Available in local workspaces only. This setting cannot be enabled in cloud workspaces."
        control={<Switch checked={false} aria-label="Enterprise data privacy" disabled />}
      />
    </CloudPlanSettings>
  );
}

const ACCESS = [
  { value: "disabled", label: "Disabled" },
  { value: "enabled", label: "Enabled" },
  { value: "suggested", label: "Suggested" },
];

export function ExampleOrganizationSettings() {
  const [name, setName] = useState("Studio"),
    [api, setApi] = useState("suggested"),
    [sso, setSso] = useState(false);
  return (
    <CloudOrganizationSettings name={name} onRename={setName} note="Organization settings affect only this preview.">
      <SettingsRow
        title="API access"
        description="Control whether members can use workspace-scoped API tokens."
        control={<Select aria-label="API access" value={api} onChange={setApi} options={ACCESS} />}
      />
      <SettingsRow
        title="Single sign-on"
        description="Example organization sign-in policy."
        control={<Switch aria-label="Single sign-on" checked={sso} onCheckedChange={setSso} />}
      />
    </CloudOrganizationSettings>
  );
}

export function ExampleApiSettings() {
  const [keys, setKeys] = useState<CloudApiKeyRow[]>([
      { id: "example-1", name: "Development", detail: "Created Today · demo_••••••••" },
    ]),
    [access, setAccess] = useState("suggested");
  return (
    <CloudApiSettings
      intro={
        <>
          <p>Manage access from tools and integrations.</p>
          <SettingsRow
            title="Workspace API access"
            description="Choose access for new workspaces. Existing workspaces keep their current setting."
            control={<Select value={access} onChange={setAccess} aria-label="Workspace API access" options={ACCESS} />}
          />
        </>
      }
      keys={keys}
      copy={{
        create: "Create example key",
        submit: "Create example",
        revoke: "Revoke example",
        createdTitle: "Example key created",
        createdDescription: "Copy this sample before closing. It cannot authenticate any request.",
        createDescription: "Name this local API key example.",
        copy: "Copy example key",
      }}
      onCreate={async (name) => {
        const id = crypto.randomUUID();
        setKeys((ks) => [...ks, { id, name, detail: "Created Just now · demo_••••••••" }]);
        return "demo_inactive_" + id;
      }}
      onRevoke={(id) => setKeys((ks) => ks.filter((k) => k.id !== id))}
    >
      <h3 style={{ marginTop: 28 }}>Connect with MCP</h3>
      <p>Use an MCP client to create workspaces, send prompts, and read agent replies.</p>
      <code className="ui-cloud-path">https://api.example.test/mcp</code>
      <p className="ui-cloud-note">Key and service URL examples are inactive. No credentials are issued.</p>
    </CloudApiSettings>
  );
}
