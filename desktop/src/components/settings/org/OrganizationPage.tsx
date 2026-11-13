// Settings → Organization: the org you're acting as — its name, address,
// repositories, the GitHub accounts connected to it and its plan — and making
// another. Switching between orgs is the
// account menu's; renaming one happens where it was made.

import { useState } from "react";
import { Building2, Plus } from "lucide-react";

import { orgLabel, useCloudOrgs } from "../../../lib/cloudOrgs";
import { useCloudPlan } from "../../../lib/useCloudPlan";
import { Button } from "../../ui/button";
import { CloudOrganizationSettings } from "../../ui/cloud-organization";
import { SettingsRow } from "../../ui/settings-row";
import { EmptyState, ErrorNote, LoadingState } from "../../ui/state";
import type { SettingsLink } from "../nav";
import { ConnectedGithub } from "./ConnectedGithub";
import { CreateOrgDialog } from "./CreateOrgDialog";
import { SignedOutCloud } from "./SignedOutCloud";
import "../../ui/cloud-patterns.css";

export function OrganizationPage({ go }: { go: (link: SettingsLink) => void }) {
  const read = useCloudPlan();
  const signedIn = read.state !== "signed_out";
  const { orgs, loaded, error } = useCloudOrgs(signedIn);
  const [creating, setCreating] = useState(false);
  const dialog = <CreateOrgDialog open={creating} onOpenChange={setCreating} />;

  if (!signedIn) return <SignedOutCloud what="see and make organizations" onSignIn={() => go("account")} />;
  if (!loaded && !error) return <LoadingState label="Reading your organization…" />;
  const org = orgs.find((o) => o.current);
  if (!org) {
    return (
      <>
        <EmptyState
          icon={Building2}
          title="No organization yet"
          body={error ?? "An organization holds your team, its cloud computers and its plan."}
          action={{ label: "Create organization", onClick: () => setCreating(true) }}
        />
        {dialog}
      </>
    );
  }

  return (
    <>
      <CloudOrganizationSettings name={orgLabel(org)}>
        {error && <ErrorNote>{error}</ErrorNote>}
        <SettingsRow title="Address" description="How the server and links name it." control={<code>{org.slug}</code>} />
        <SettingsRow
          title="Repositories"
          description="The ones in it you can see."
          control={<span>{org.repo_count}</span>}
        />
        <SettingsRow
          title="Plan"
          description={read.plan ? `${read.plan}` : "Reading the plan…"}
          control={
            <Button size="sm" variant="secondary" onClick={() => go("billing")}>
              Billing
            </Button>
          }
        />
        <SettingsRow
          title="Members"
          description="Who is in it, and their roles."
          control={
            <Button size="sm" variant="secondary" onClick={() => go("team")}>
              Members
            </Button>
          }
        />
        <SettingsRow
          title="Another organization"
          description={orgs.length > 1 ? `You’re in ${orgs.length}. Switch between them from the account menu.` : "For another team, or a project of its own."}
          control={
            <Button size="sm" variant="secondary" onClick={() => setCreating(true)}>
              <Plus />
              Create organization…
            </Button>
          }
        />
        {dialog}
      </CloudOrganizationSettings>
      <ConnectedGithub />
    </>
  );
}
