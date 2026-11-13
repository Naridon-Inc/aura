// The cloud org roster, manageable without leaving the desktop.
//
// A different population from the git-derived list above it: these are the
// people in your Aura Cloud org — the ones invites, billing seats and cloud
// entitlements are about. Seeing it, inviting to it, changing a role and
// removing someone all happen here, without the web console.
//
// The authority model is the server's (aura-cloud orgs.rs); rosterPowers is
// its client mirror, so no control is offered that the API would refuse. The
// one refusal that still reaches here — the last owner demoting or removing
// themselves — arrives as a sentence and is shown verbatim.
//
// The member list is a network read, and it used to run on every open behind
// a spinner. It now comes from the shared cache: a reopen paints the last
// list and refreshes behind it. The key carries the org, and like every
// `cloud:` key it is dropped on an org switch or sign-in change, so one org's
// people are never shown under another's name.

import { useCallback, useState } from "react";
import { UserMinus } from "lucide-react";

import { api, type CloudOrgMember } from "../../lib/api";
import { useCloudAuthStatus } from "../../lib/cloudAuthCache";
import { myRosterRole, rosterPowers } from "../../lib/orgRosterPowers";
import { toast } from "../../lib/toast";
import { useCachedResource } from "../../lib/useCachedResource";
import { Avatar } from "../team/presentation/Avatar";
import { AsciiSpinner } from "../ui/ascii-spinner";
import { askConfirm } from "../ui/ask";
import { Button } from "../ui/button";
import { Select } from "../ui/select";
import { SettingsError } from "../ui/settings-blocks";
import { SettingsMemberList, SettingsMemberRow } from "../ui/settings-team-members";
import { CloudInviteRow } from "./CloudInviteRow";

const ROLE_LABEL: Record<string, string> = {
  owner: "Owner",
  admin: "Admin",
  member: "Member",
};

const readMembers = () => api.cloudOrgMembers();

export function CloudOrgRoster() {
  const auth = useCloudAuthStatus();
  const status = auth.data;
  const orgSlug = status?.connected ? (status.org_slug ?? null) : null;
  const orgName = orgSlug ? (status?.org_name ?? orgSlug) : null;
  const myLogin = status?.user ?? null;
  const roster = useCachedResource<CloudOrgMember[]>(
    orgSlug ? `cloud:org-members:${orgSlug}` : null,
    readMembers,
  );
  const members = roster.data ?? null;
  const err = roster.staleError;
  const load = roster.reload;
  const [busyId, setBusyId] = useState<string | null>(null);

  const setRole = useCallback(
    async (m: CloudOrgMember, role: string) => {
      if (role === m.role) return;
      setBusyId(m.user_id);
      try {
        await api.cloudOrgMemberSetRole(m.user_id, role);
        await load();
      } catch (e) {
        // A 409 here is advice ("promote someone else to owner first"), not a
        // failure of the app — surface the server's sentence as-is.
        toast.danger("Couldn't change the role", String(e));
      } finally {
        setBusyId(null);
      }
    },
    [load],
  );

  const remove = useCallback(
    async (m: CloudOrgMember, isSelf: boolean) => {
      const ok = await askConfirm({
        title: isSelf
          ? "Leave this organization?"
          : `Remove ${m.github_login} from the org?`,
        body: isSelf
          ? "You lose access to its cloud places, repos and sessions until someone invites you back."
          : "Their cloud access and this org's repo grants go with them, in one step.",
        confirmLabel: isSelf ? "Leave" : "Remove",
        tone: "danger",
      });
      if (!ok) return;
      setBusyId(m.user_id);
      try {
        await api.cloudOrgMemberRemove(m.user_id);
        await load();
      } catch (e) {
        toast.danger(
          isSelf ? "Couldn't leave" : "Couldn't remove them",
          String(e),
        );
      } finally {
        setBusyId(null);
      }
    },
    [load],
  );

  // Signed out, or no org: nothing to manage — stay out of the way.
  if (!orgName) return null;

  const myRole = members ? myRosterRole(members, myLogin) : null;

  return (
    <SettingsMemberList
      label={`People in ${orgName}`}
      action={<CloudInviteRow orgName={orgName} />}
      note={
        members
          ? `${members.length} member${members.length !== 1 ? "s" : ""} of this organization on Aura Cloud. Invites, seats and cloud access are about these people.`
          : undefined
      }
    >
      {err && <SettingsError>{err}</SettingsError>}
      {!members && !err && (
        <p className="ui-settings-status" role="status">
          <AsciiSpinner /> Loading the organization’s members…
        </p>
      )}
      {members?.map((m) => {
        const isSelf = !!myLogin && m.github_login.toLowerCase() === myLogin.toLowerCase();
        const powers = rosterPowers(myRole, m.role.toLowerCase(), isSelf);
        const busy = busyId === m.user_id;
        const label = m.display_name || m.github_login;
        const roleOptions = ["owner", "admin", "member"].map((r) => ({
          value: r,
          label: ROLE_LABEL[r],
          // The server would refuse an admin minting an owner; don't offer it.
          disabled: r === "owner" && !powers.offerOwner,
        }));
        const detail = [
          isSelf ? "You" : null,
          m.display_name && m.display_name !== m.github_login ? `@${m.github_login}` : null,
          m.email || null,
        ]
          .filter(Boolean)
          .join(" · ");
        return (
          <SettingsMemberRow
            key={m.user_id}
            avatar={
              <Avatar
                name={label}
                identity={m.email || m.github_login}
                src={m.github_avatar}
                size={26}
                title={label}
              />
            }
            name={label}
            detail={detail || ROLE_LABEL[m.role.toLowerCase()] || m.role}
            control={
              <>
                {busy && <AsciiSpinner />}
                <Select
                  value={m.role.toLowerCase()}
                  onChange={(r) => void setRole(m, r)}
                  options={roleOptions}
                  disabled={!powers.changeRole || busy}
                  aria-label={`Role for ${m.github_login}`}
                />
                {powers.remove && (
                  <Button
                    variant="ghost"
                    size="iconSm"
                    disabled={busy}
                    onClick={() => void remove(m, isSelf)}
                    aria-label={isSelf ? "Leave this organization" : `Remove ${m.github_login}`}
                    title={isSelf ? "Leave this organization" : "Remove from the organization"}
                  >
                    <UserMinus />
                  </Button>
                )}
              </>
            }
          />
        );
      })}
    </SettingsMemberList>
  );
}
