// The cloud org roster, manageable without leaving the desktop.
//
// A different population from the git-derived list above it: these are the
// people in your Aura Cloud org — the ones invites, billing seats and cloud
// entitlements are about. Until now the desktop could only ever ADD to this
// list (CloudInviteRow); seeing it, changing a role, or removing someone
// meant the web console. This block closes that.
//
// The authority model is the server's (aura-cloud orgs.rs); rosterPowers is
// its client mirror, so no control is offered that the API would refuse. The
// one refusal that still reaches here — the last owner demoting or removing
// themselves — arrives as a sentence and is shown verbatim.

import { useCallback, useEffect, useState } from "react";
import { Cloud, UserMinus } from "lucide-react";

import { api, type CloudOrgMember } from "../../lib/api";
import { myRosterRole, rosterPowers } from "../../lib/orgRosterPowers";
import { AsciiSpinner } from "../ui/ascii-spinner";
import { Select } from "../ui/select";
import { askConfirm } from "../ui/ask";
import { toast } from "../../lib/toast";
import { Avatar } from "../team/presentation/Avatar";

const ROLE_LABEL: Record<string, string> = {
  owner: "Owner",
  admin: "Admin",
  member: "Member",
};

export function CloudOrgRoster() {
  const [orgName, setOrgName] = useState<string | null>(null);
  const [myLogin, setMyLogin] = useState<string | null>(null);
  const [members, setMembers] = useState<CloudOrgMember[] | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const s = await api.cloudAuthStatus();
      if (!s.connected || !s.org_slug) {
        setOrgName(null);
        setMembers(null);
        return;
      }
      setOrgName(s.org_name ?? s.org_slug);
      setMyLogin(s.user ?? null);
      setMembers(await api.cloudOrgMembers());
      setErr(null);
    } catch (e) {
      setErr(String(e));
    }
  }, []);

  useEffect(() => {
    void load();
    const onChange = () => void load();
    window.addEventListener("aura:cloud-auth-changed", onChange);
    return () => window.removeEventListener("aura:cloud-auth-changed", onChange);
  }, [load]);

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

  // Signed out, or no org: nothing to manage — stay out of the way, the same
  // contract CloudInviteRow keeps.
  if (!orgName) return null;

  const myRole = members ? myRosterRole(members, myLogin) : null;

  return (
    <div className="space-y-1 pt-1">
      <div className="flex items-center gap-1.5 text-xs font-medium text-text-4">
        <Cloud size={12} aria-hidden />
        <span>
          {orgName} on Aura Cloud
          {members ? ` · ${members.length} member${members.length !== 1 ? "s" : ""}` : ""}
        </span>
      </div>

      {err && (
        <div
          role="alert"
          className="text-xs rounded px-2 py-1 leading-snug"
          style={{
            color: "var(--color-red)",
            background: "color-mix(in srgb, var(--color-red) 12%, transparent)",
            border: "1px solid color-mix(in srgb, var(--color-red) 30%, transparent)",
          }}
        >
          {err}
        </div>
      )}

      {!members && !err && (
        <div className="flex items-center gap-2 text-xs text-text-4 py-1">
          <AsciiSpinner /> Loading the org roster…
        </div>
      )}

      {members?.map((m) => {
        const isSelf =
          !!myLogin && m.github_login.toLowerCase() === myLogin.toLowerCase();
        const powers = rosterPowers(myRole, m.role.toLowerCase(), isSelf);
        const busy = busyId === m.user_id;
        const label = m.display_name || m.github_login;
        const roleOptions = ["owner", "admin", "member"].map((r) => ({
          value: r,
          label: ROLE_LABEL[r],
          // The server would refuse an admin minting an owner; don't offer it.
          disabled: r === "owner" && !powers.offerOwner,
        }));
        return (
          <div key={m.user_id} className="flex items-center gap-2 py-1">
            <Avatar name={label} size={24} />
            <span className="min-w-0 flex-1 truncate text-xs text-text-2">
              {label}
              {isSelf && <span className="text-text-5"> · you</span>}
              {m.display_name && m.display_name !== m.github_login && (
                <span className="text-text-5"> · {m.github_login}</span>
              )}
            </span>
            {powers.changeRole ? (
              <div className="w-28 shrink-0">
                <Select
                  value={m.role.toLowerCase()}
                  onChange={(r) => void setRole(m, r)}
                  options={roleOptions}
                  disabled={busy}
                  aria-label={`Role for ${m.github_login}`}
                />
              </div>
            ) : (
              <span className="shrink-0 text-[11px] text-text-4">
                {ROLE_LABEL[m.role.toLowerCase()] ?? m.role}
              </span>
            )}
            {powers.remove && (
              <button
                type="button"
                disabled={busy}
                onClick={() => void remove(m, isSelf)}
                aria-label={
                  isSelf ? "Leave this organization" : `Remove ${m.github_login}`
                }
                title={isSelf ? "Leave this organization" : "Remove from org"}
                className="shrink-0 rounded p-1 text-text-4 transition-colors hover:text-[var(--color-red)] disabled:opacity-50"
              >
                {busy ? <AsciiSpinner size={12} /> : <UserMinus size={12} />}
              </button>
            )}
          </div>
        );
      })}
    </div>
  );
}
