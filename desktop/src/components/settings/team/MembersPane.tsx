import { useCloudOrgs, orgLabel } from "../../../lib/cloudOrgs";
import { humanizeWorkspaceName } from "../../../lib/workspaceLabel";
import { AsciiSpinner } from "../../ui/ascii-spinner";
import { Button } from "../../ui/button";
import { SettingsEmpty, SettingsError } from "../../ui/settings-blocks";
import { SettingsMemberList } from "../../ui/settings-team-members";
import { CloudGitIdentityRow } from "../CloudGitIdentityRow";
import { CloudOrgRoster } from "../CloudOrgRoster";
import { rosterCountLine, rosterSourceNote } from "../teamRoster";
import { DuplicateReview } from "./DuplicateReview";
import { MemberRow } from "./MemberRow";
import { useTeamRoster } from "./useTeamRoster";
import { WhoAmINote } from "./WhoAmINote";

/** Settings → Team → Members: everyone who has worked in this project, from
 *  its own history, and — when signed in — the Aura Cloud organization it
 *  belongs to. */
export function MembersPane({ repoRoot }: { repoRoot: string }) {
  // Cheap: the org list is cached and shared. Used for one sentence, and for
  // nothing else.
  const { orgs } = useCloudOrgs(true);
  const roster = useTeamRoster(repoRoot);
  const { members, identity, err, actionErr } = roster;

  if (err) {
    return (
      <>
        <SettingsError>Couldn’t load your team. {err}</SettingsError>
        <Button variant="outline" size="sm" onClick={roster.reload}>
          Try again
        </Button>
      </>
    );
  }
  if (!members) {
    return (
      <p className="ui-settings-status" role="status">
        <AsciiSpinner /> Loading your team…
      </p>
    );
  }

  // Signed in to a cloud org, you can adopt your account identity and invite
  // ahead of the first commit; both render nothing when signed out.
  const cloud = (
    <>
      <CloudGitIdentityRow repoRoot={repoRoot} />
      <CloudOrgRoster />
    </>
  );

  if (members.length === 0) {
    return (
      <>
        <SettingsEmpty>
          No one has worked here yet. Aura fills this in from the repository’s own history: commit
          once and whoever authored it appears here. Nobody has to be invited first.
        </SettingsEmpty>
        {cloud}
      </>
    );
  }

  const iAmAdmin = identity?.admin ?? false;
  const myEmail = (identity?.email ?? "").toLowerCase();
  const adminCount = members.filter((m) => m.admin).length;
  const hasAdmin = adminCount > 0;
  // Named only so the note can explain the other number the reader may be
  // holding — the organization's member list, which is a different
  // population. Signed out there is no other number, and this is null.
  const currentOrg = orgs.find((o) => o.current) ?? null;

  return (
    <>
      <WhoAmINote identity={identity} />
      {actionErr && <SettingsError>{actionErr}</SettingsError>}
      <SettingsMemberList
        label={rosterCountLine(members.length, adminCount)}
        action={
          !hasAdmin && (
            <Button
              variant="secondary"
              size="sm"
              disabled={roster.busyEmail !== null}
              onClick={() => void roster.claimAdmin(myEmail)}
              title="No admin yet. Claim the admin seat for this team"
            >
              Claim admin
            </Button>
          )
        }
        note={
          // Which people these are. The count used to sit beside an
          // organization list reporting a different number — two true counts
          // over two populations, with nothing on screen saying so.
          <>
            {rosterSourceNote(
              humanizeWorkspaceName(repoRoot),
              currentOrg ? orgLabel(currentOrg) : null,
            )}
            {!hasAdmin &&
              " This team has no admin yet. Any member can claim it; the admin can later transfer the role or promote others."}
          </>
        }
      >
        {members.map((m) => (
          <MemberRow
            key={m.email}
            member={m}
            members={members}
            roster={roster}
            isMe={m.email.toLowerCase() === myEmail}
            iAmAdmin={iAmAdmin}
          />
        ))}
      </SettingsMemberList>
      <DuplicateReview
        suggestions={roster.dups}
        onConfirm={roster.confirmDup}
        onReject={roster.rejectDup}
      />
      {cloud}
    </>
  );
}
