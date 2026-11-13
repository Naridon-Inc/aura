// Organization › Members.
//
// One page, top to bottom: everyone who has worked in this project
// (`team_load`), their roles and identities, and the Aura Cloud organization
// when signed in; then the team's activity, the per-member daily rollup; then
// usage, per-member token spend.

import { StandupView } from "../standup/StandupView";
import { SettingsSection } from "../ui/settings-row";
import "../ui/settings-team-members.css";
import { MembersPane } from "./team/MembersPane";
import { TeamUsagePane } from "./team/UsagePane";

export function TeamTab({ repoRoot }: { repoRoot: string }) {
  return (
    <>
      <MembersPane repoRoot={repoRoot} />
      <SettingsSection title="Activity">
        <StandupView repoRoot={repoRoot} />
      </SettingsSection>
      <SettingsSection title="Usage">
        <TeamUsagePane />
      </SettingsSection>
    </>
  );
}
