import { useCallback, useEffect, useState } from "react";

import {
  api,
  type DuplicateSuggestion,
  type TeamIdentity,
  type TeamManifest,
  type TeamMember,
} from "../../../lib/api";
import { pickPath } from "../../../lib/nativeDialog";
import { peekCache, writeCache } from "../../../lib/resourceCache";
import { fetchIdentity, refreshIdentity, refreshTeam } from "../../../lib/teamCache";

// The roster + identity + duplicate hunches, cached per repo so reopening
// Settings → Team paints instantly instead of flashing a loader. SWR-style:
// seed from the cache, refetch in the background, write the fresh bundle back.
type CachedTeam = {
  members: TeamMember[];
  identity: TeamIdentity | null;
  dups: DuplicateSuggestion[];
  /** Self-picked profile photos, email→data-URL. Resolved ahead of the GitHub
   *  avatar and the animal monogram. */
  avatars: Record<string, string>;
};

// Strip Rust's "Err(...)" wrapper noise so the pane surfaces just the
// human-readable reason a role change was refused.
export function humanizeErr(e: unknown): string {
  const s = String((e as { message?: string })?.message ?? e ?? "").trim();
  return s.replace(/^Error:\s*/i, "") || "Something went wrong";
}

/** Everything the Members pane reads and every change it can make.
 *
 *  Team roles are built on Aura's own git-derived roster: the `admin` flag in
 *  team.json is advisory (git gives everyone equal write access), so it gates
 *  the in-app affordances rather than git itself. A vacant admin seat can be
 *  claimed by any member; an existing admin can promote others or transfer
 *  the role and step down. */
export function useTeamRoster(repoRoot: string) {
  const cacheKey = `settings-team-members:${repoRoot}`;
  const [members, setMembers] = useState<TeamMember[] | null>(
    () => peekCache<CachedTeam>(cacheKey)?.members ?? null,
  );
  const [identity, setIdentity] = useState<TeamIdentity | null>(
    () => peekCache<CachedTeam>(cacheKey)?.identity ?? null,
  );
  const [dups, setDups] = useState<DuplicateSuggestion[]>(
    () => peekCache<CachedTeam>(cacheKey)?.dups ?? [],
  );
  const [avatars, setAvatars] = useState<Record<string, string>>(
    () => peekCache<CachedTeam>(cacheKey)?.avatars ?? {},
  );
  const [err, setErr] = useState<string | null>(null);
  const [actionErr, setActionErr] = useState<string | null>(null);
  // Email currently mid-mutation — disables that row's controls.
  const [busyEmail, setBusyEmail] = useState<string | null>(null);

  const load = useCallback(async () => {
    setErr(null);
    const [t, id, d, av] = await Promise.all([
      refreshTeam(repoRoot),
      fetchIdentity(repoRoot).catch(() => null),
      api.teamIdentitySuggestDuplicates(repoRoot).catch(() => []),
      api.identityAvatarsGet().catch(() => ({}) as Record<string, string>),
    ]);
    const nextMembers = t?.members ?? [];
    setMembers(nextMembers);
    setIdentity(id);
    setDups(d);
    setAvatars(av);
    writeCache<CachedTeam>(cacheKey, {
      members: nextMembers,
      identity: id,
      dups: d,
      avatars: av,
    });
  }, [repoRoot, cacheKey]);

  const reload = useCallback(() => {
    load().catch((e) => setErr(String(e)));
  }, [load]);

  useEffect(() => {
    let cancelled = false;
    // Paint instantly from the last load for this repo (no null flash), then
    // refresh in the background. On a cold cache these seed to the empty
    // defaults and the loader shows once.
    const cached = peekCache<CachedTeam>(cacheKey);
    setMembers(cached?.members ?? null);
    setIdentity(cached?.identity ?? null);
    setDups(cached?.dups ?? []);
    setAvatars(cached?.avatars ?? {});
    setActionErr(null);
    load().catch((e) => {
      if (!cancelled) setErr(String(e));
    });
    return () => {
      cancelled = true;
    };
  }, [repoRoot, load, cacheKey]);

  /** Run one role change against the roster and regate on who you are now. */
  const run = useCallback(
    async (email: string, fn: () => Promise<TeamManifest>) => {
      setBusyEmail(email);
      setActionErr(null);
      try {
        const m = await fn();
        setMembers(m?.members ?? []);
        // Admin status of the local user may have changed (e.g. transfer
        // step-down) — refresh identity so the controls regate.
        const id = await refreshIdentity(repoRoot).catch(() => null);
        setIdentity(id);
      } catch (e) {
        setActionErr(humanizeErr(e));
      } finally {
        setBusyEmail(null);
      }
    },
    [repoRoot],
  );

  const claimAdmin = useCallback(
    (myEmail: string) => run(myEmail || "self", () => api.teamClaim(repoRoot)),
    [run, repoRoot],
  );
  const setAdmin = useCallback(
    (email: string, admin: boolean) =>
      run(email, () => api.teamSetAdmin(repoRoot, email, admin)),
    [run, repoRoot],
  );
  const transferAdmin = useCallback(
    (email: string) => run(email, () => api.teamTransferAdmin(repoRoot, email)),
    [run, repoRoot],
  );

  // Merge / keep-separate for the duplicate hunches. Both fold aliases through
  // the shared identity backend; a full reload after picks up the new roster.
  const confirmDup = useCallback(
    async (survivorEmail: string, mergedEmails: string[]) => {
      await api.teamIdentityConfirmDuplicate(repoRoot, survivorEmail, mergedEmails);
      await load();
    },
    [repoRoot, load],
  );
  const rejectDup = useCallback(
    async (emailA: string, emailB: string) => {
      await api.teamIdentityRejectDuplicate(repoRoot, emailA, emailB);
      await load();
    },
    [repoRoot, load],
  );

  // Split a folded-in identity back out into its own person — the inverse of
  // "Same person". We drop the alias off this member; the email re-derives as
  // its own row from git log on reload. Only offered on your own row or, for
  // an admin, on anyone's — the backend enforces the same rule.
  const separateAlias = useCallback(
    async (targetHandle: string, aliasEmail: string) => {
      setBusyEmail(aliasEmail);
      setActionErr(null);
      try {
        const m = await api.teamAliasRemove(repoRoot, targetHandle, aliasEmail);
        setMembers(m?.members ?? []);
        await load();
      } catch (e) {
        setActionErr(humanizeErr(e));
      } finally {
        setBusyEmail(null);
      }
    },
    [repoRoot, load],
  );

  // Manually declare two people the same — the escape hatch for when the
  // suggester never proposed the pair (a GitHub-handle committer and a personal
  // address with nothing textually in common). `identity_merges` on the backend
  // makes the decision stick across every git re-derive.
  const mergeWith = useCallback(
    async (survivorEmail: string, mergedEmail: string) => {
      setBusyEmail(survivorEmail);
      setActionErr(null);
      try {
        const mani = await api.teamIdentityConfirmDuplicate(repoRoot, survivorEmail, [
          mergedEmail,
        ]);
        setMembers(mani?.members ?? []);
        await load();
      } catch (e) {
        setActionErr(humanizeErr(e));
      } finally {
        setBusyEmail(null);
      }
    },
    [repoRoot, load],
  );

  // Pick a profile photo and store it locally (email-keyed). The map updates
  // in place so the new face shows the instant the picker returns.
  const pickPhoto = useCallback(async (email: string) => {
    setActionErr(null);
    let path: string | string[] | null;
    try {
      path = await pickPath({ title: "Choose a profile photo" });
    } catch (e) {
      setActionErr(humanizeErr(e));
      return;
    }
    if (!path || Array.isArray(path)) return; // cancelled
    setBusyEmail(email);
    try {
      const dataUrl = await api.identityAvatarSetFromPath(email, path);
      setAvatars((prev) => ({ ...prev, [email.toLowerCase()]: dataUrl }));
    } catch (e) {
      setActionErr(humanizeErr(e));
    } finally {
      setBusyEmail(null);
    }
  }, []);

  const clearPhoto = useCallback(async (email: string) => {
    setBusyEmail(email);
    setActionErr(null);
    try {
      await api.identityAvatarClear(email);
      setAvatars((prev) => {
        const next = { ...prev };
        delete next[email.toLowerCase()];
        return next;
      });
    } catch (e) {
      setActionErr(humanizeErr(e));
    } finally {
      setBusyEmail(null);
    }
  }, []);

  return {
    members,
    identity,
    dups,
    avatars,
    err,
    actionErr,
    busyEmail,
    reload,
    claimAdmin,
    setAdmin,
    transferAdmin,
    confirmDup,
    rejectDup,
    separateAlias,
    mergeWith,
    pickPhoto,
    clearPhoto,
  };
}

export type TeamRoster = ReturnType<typeof useTeamRoster>;
