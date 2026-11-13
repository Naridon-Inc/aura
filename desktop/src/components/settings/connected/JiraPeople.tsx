// Matching Jira accounts to the people on this Aura team, so an issue
// assigned over there lands on the right person over here.

import { useCallback, useEffect, useMemo, useState } from "react";
import { CheckCircle2, LinkIcon, RotateCw, Sparkles } from "lucide-react";

import { AsciiSpinner } from "../../ui/ascii-spinner";
import { Button } from "../../ui/button";
import { Select } from "../../ui/select";
import { SettingsActions, SettingsEmpty, SettingsError } from "../../ui/settings-blocks";
import { SettingsRow, SettingsSection } from "../../ui/settings-row";
import { isDeviceIdentity } from "../../../lib/memberIdentity";
import { fetchTeam } from "../../../lib/teamCache";
import { type TeamMember } from "../../../lib/api";
import {
  integrationsApi,
  type JiraUserLink,
  type ReconcileSuggestion,
} from "../../../lib/integrationsApi";

const MATCHED_BY: Record<string, string> = {
  email: "Matched by email",
  brain: "Matched by Aura",
};

// People matching — every imported Jira card carries whoever it's assigned to
// on Jira. Their name rarely lines up with your teammates by itself, so this
// section ties each Jira person to a real teammate: ones with a matching email
// link themselves, and for the rest Aura suggests the most likely teammate
// which you confirm with one click. Nothing is merged automatically — picking
// the wrong person is painful to undo, so the human always says yes.
export function PeopleSection({ repoRoot }: { repoRoot: string }) {
  const [links, setLinks] = useState<JiraUserLink[]>([]);
  const [members, setMembers] = useState<TeamMember[]>([]);
  const [suggestions, setSuggestions] = useState<Record<string, ReconcileSuggestion>>({});
  const [manualPick, setManualPick] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState<string | null>(null);
  const [reconciling, setReconciling] = useState(false);
  const [note, setNote] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  // A read that failed is not a read that came back empty. Without
  // this, a broken list call fell through to the "nothing imported
  // yet" copy below and told the user their Jira cards have no people
  // on them — an answer we never got.
  const [failed, setFailed] = useState(false);

  const load = useCallback(async () => {
    setFailed(false);
    try {
      const [rows, team] = await Promise.all([
        integrationsApi.jiraUsersList(repoRoot),
        fetchTeam(repoRoot).catch(() => null),
      ]);
      setLinks(rows);
      setMembers(team?.members ?? []);
    } catch (e) {
      setFailed(true);
      setError(String(e));
    } finally {
      setLoading(false);
    }
  }, [repoRoot]);

  useEffect(() => {
    void load();
  }, [load]);

  const unresolved = useMemo(() => links.filter((l) => l.status === "unresolved"), [links]);
  const resolved = useMemo(() => links.filter((l) => l.status === "resolved"), [links]);

  const pickableMembers = useMemo(
    () => members.filter((m) => m.handle.trim().length > 0),
    [members],
  );
  const nameForHandle = useCallback(
    (handle?: string | null) => {
      if (!handle) return null;
      const m = pickableMembers.find((x) => x.handle === handle);
      return m?.name?.trim() || handle;
    },
    [pickableMembers],
  );
  const teammateOptions = useMemo(
    () =>
      pickableMembers.map((m) => ({
        value: m.handle,
        // A device-keyed placeholder adds nothing to a picker label — the
        // name is what you recognise, and the UUID would only make two rows
        // look like different people.
        label: `${m.name?.trim() || m.handle}${
          m.email && !isDeviceIdentity(m.email) ? ` · ${m.email}` : ""
        }`,
      })),
    [pickableMembers],
  );

  const runReconcile = useCallback(async () => {
    setReconciling(true);
    setNote(null);
    setError(null);
    try {
      const rows = await integrationsApi.jiraUsersReconcile(repoRoot);
      const map: Record<string, ReconcileSuggestion> = {};
      for (const r of rows) map[r.account_id] = r;
      setSuggestions(map);
    } catch (e) {
      setError(String(e));
    } finally {
      setReconciling(false);
    }
  }, [repoRoot]);

  const link = useCallback(
    async (accountId: string, handle: string) => {
      if (!handle) return;
      setBusy(`link:${accountId}`);
      setNote(null);
      setError(null);
      try {
        const result = await integrationsApi.jiraUsersLink({ repoRoot, accountId, handle });
        const drop = <T,>(prev: Record<string, T>) => {
          const next = { ...prev };
          delete next[accountId];
          return next;
        };
        setSuggestions(drop);
        setManualPick(drop);
        const who = nameForHandle(handle) ?? handle;
        setNote(
          result.tasks_updated > 0
            ? `Matched to ${who} · updated ${result.tasks_updated} card${
                result.tasks_updated === 1 ? "" : "s"
              }.`
            : `Matched to ${who}.`,
        );
        await load();
      } catch (e) {
        setError(String(e));
      } finally {
        setBusy(null);
      }
    },
    [repoRoot, load, nameForHandle],
  );

  const unlink = useCallback(
    async (accountId: string) => {
      setBusy(`unlink:${accountId}`);
      setNote(null);
      setError(null);
      try {
        await integrationsApi.jiraUsersUnlink({ repoRoot, accountId });
        await load();
      } catch (e) {
        setError(String(e));
      } finally {
        setBusy(null);
      }
    },
    [repoRoot, load],
  );

  let body;
  if (loading) {
    body = (
      <p className="ui-settings-status" role="status">
        <AsciiSpinner /> Loading people…
      </p>
    );
  } else if (failed) {
    body = (
      <SettingsRow
        title="Aura couldn't read who's on your Jira cards."
        description={error}
        control={
          <Button variant="outline" size="sm" onClick={() => void load()}>
            <RotateCw />
            Try again
          </Button>
        }
      />
    );
  } else if (links.length === 0) {
    // Nothing imported yet — say what will show up here, rather than an empty box.
    body = (
      <SettingsEmpty>
        Once you sync a project, the people assigned on those Jira cards show up
        here so you can match them to your teammates.
      </SettingsEmpty>
    );
  } else {
    body = (
      <>
        <SettingsRow
          title={`${resolved.length}/${links.length} matched`}
          description={
            unresolved.length > 0
              ? `${unresolved.length} Jira ${
                  unresolved.length === 1 ? "person isn't" : "people aren't"
                } matched to a teammate yet. Until then their Jira name shows on the card.`
              : "Everyone on your Jira cards is matched to a teammate."
          }
          control={
            unresolved.length > 0 ? (
              <Button
                variant="outline"
                size="sm"
                onClick={() => void runReconcile()}
                disabled={reconciling}
                title="Let Aura suggest the most likely teammate for each unmatched Jira person. You confirm each one."
              >
                {reconciling ? <AsciiSpinner /> : <Sparkles />}
                {reconciling ? "Asking Aura…" : "Match with Aura"}
              </Button>
            ) : null
          }
        />

        {unresolved.map((l) => {
          const s = suggestions[l.account_id];
          // Aura's suggestion fills the picker, so accepting it is one click;
          // picking someone else by hand overrides it.
          const picked = manualPick[l.account_id] ?? s?.suggested_handle ?? "";
          const linkBusy = busy === `link:${l.account_id}`;
          const hint = s?.suggested_handle
            ? `Looks like ${nameForHandle(s.suggested_handle) ?? s.suggested_handle} · ${Math.round(
                (s.confidence ?? 0) * 100,
              )}% sure`
            : s?.reason;
          return (
            <SettingsRow
              key={l.account_id}
              title={l.display_name || l.account_id}
              description={[l.email, hint].filter(Boolean).join(" · ") || "Not matched yet"}
              control={
                <SettingsActions>
                  <Select
                    aria-label={`Teammate for ${l.display_name || l.account_id}`}
                    value={picked}
                    onChange={(v) => setManualPick((prev) => ({ ...prev, [l.account_id]: v }))}
                    placeholder="Pick a teammate…"
                    options={teammateOptions}
                  />
                  <Button
                    size="sm"
                    onClick={() => void link(l.account_id, picked)}
                    disabled={!picked || linkBusy}
                  >
                    {linkBusy ? <AsciiSpinner /> : <LinkIcon />}
                    Match
                  </Button>
                </SettingsActions>
              }
            />
          );
        })}

        {resolved.map((l) => {
          const unlinkBusy = busy === `unlink:${l.account_id}`;
          return (
            <SettingsRow
              key={l.account_id}
              title={`${l.display_name || l.account_id} → ${nameForHandle(l.handle) ?? l.handle}`}
              description={MATCHED_BY[l.via ?? ""] ?? "Matched by you"}
              control={
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => void unlink(l.account_id)}
                  disabled={unlinkBusy}
                  title="Unmatch. Sends this Jira person back to the unmatched list"
                >
                  {unlinkBusy && <AsciiSpinner />}
                  Unmatch
                </Button>
              }
            />
          );
        })}

        {note && (
          <p className="ui-settings-status" role="status">
            <CheckCircle2 size={14} aria-hidden /> {note}
          </p>
        )}
        {error && <SettingsError>{error}</SettingsError>}
      </>
    );
  }

  return <SettingsSection title="Jira people">{body}</SettingsSection>;
}
