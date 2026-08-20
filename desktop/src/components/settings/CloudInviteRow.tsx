// "Invite through Aura" — bringing a teammate onto a signed-in team by handing
// Aura Cloud their GitHub username, instead of editing git-remote permissions.
//
// Only shows when you're signed in to an Aura Cloud org (that's what an invite
// targets, and the server enforces that you're allowed to). Signed out, or in a
// personal account with no org, it renders nothing — the team is still derived
// from git history, exactly as before, so nothing regresses for solo users.

import { useCallback, useEffect, useState } from "react";
import { UserPlus } from "lucide-react";

import { api } from "../../lib/api";
import { AsciiSpinner } from "../ui/ascii-spinner";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { toast } from "../../lib/toast";

export function CloudInviteRow() {
  const [orgSlug, setOrgSlug] = useState<string | null>(null);
  const [username, setUsername] = useState("");
  const [busy, setBusy] = useState(false);

  // Learn whether there's an org to invite into. Re-checks on the same
  // sign-in-changed event the rest of the app listens for.
  useEffect(() => {
    let alive = true;
    const refresh = async () => {
      try {
        const s = await api.cloudAuthStatus();
        if (alive) setOrgSlug(s.connected ? s.org_slug ?? null : null);
      } catch {
        if (alive) setOrgSlug(null);
      }
    };
    void refresh();
    const onChange = () => void refresh();
    window.addEventListener("aura:cloud-auth-changed", onChange);
    return () => {
      alive = false;
      window.removeEventListener("aura:cloud-auth-changed", onChange);
    };
  }, []);

  const invite = useCallback(async () => {
    const who = username.trim();
    if (!who || busy) return;
    setBusy(true);
    try {
      await api.cloudOrgInvite(who);
      setUsername("");
      toast.success("Invite sent", `${who} was invited to your team on Aura Cloud.`);
    } catch (e) {
      toast.danger("Couldn't send the invite", String(e));
    } finally {
      setBusy(false);
    }
  }, [username, busy]);

  // No org signed in → nothing to invite into; stay out of the way.
  if (!orgSlug) return null;

  return (
    <div className="mb-3 rounded-lg border border-line-soft bg-bg-2/40 p-3">
      <div className="mb-1.5 flex items-center gap-1.5 text-sm text-text-2">
        <UserPlus size={14} strokeWidth={1.75} aria-hidden />
        <span className="font-medium">Invite a teammate</span>
      </div>
      <p className="mb-2 text-xs text-text-4">
        Signed in to Aura Cloud, you add people through Aura — no git permissions
        to hand out. Enter their GitHub username.
      </p>
      <div className="flex items-center gap-1.5">
        <Input
          value={username}
          onChange={(e) => setUsername(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !busy) void invite();
          }}
          placeholder="github-username"
          className="h-7 flex-1 font-mono text-xs"
          disabled={busy}
          aria-label="GitHub username to invite"
        />
        <Button
          variant="accentSoft"
          size="sm"
          disabled={!username.trim() || busy}
          onClick={() => void invite()}
        >
          {busy ? (
            <>
              <AsciiSpinner /> Inviting…
            </>
          ) : (
            "Invite"
          )}
        </Button>
      </div>
    </div>
  );
}
