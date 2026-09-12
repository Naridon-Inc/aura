// Matching Jira accounts to the people on this Aura team, so an issue
// assigned over there lands on the right person over here.

import { useCallback, useEffect, useMemo, useState } from "react";
import { CheckCircle2, LinkIcon, Sparkles, Unlink, Users } from "lucide-react";

import { AsciiSpinner } from "../../ui/ascii-spinner";
import { Button } from "../../ui/button";
import { Select } from "../../ui/select";
import { ErrorNote } from "../../ui/state";
import { isDeviceIdentity } from "../../../lib/memberIdentity";
import { fetchTeam } from "../../../lib/teamCache";
import { type TeamMember } from "../../../lib/api";
import {
  integrationsApi,
  type JiraUserLink,
  type ReconcileSuggestion,
} from "../../../lib/integrationsApi";

// People matching — every imported Jira card carries whoever it's assigned to
// on Jira. Their name rarely lines up with your teammates by itself, so this
// section ties each Jira person to a real teammate: ones with a matching email
// link themselves, and for the rest Aura suggests the most likely teammate
// which you confirm with one click. Nothing is merged automatically — picking
// the wrong person is painful to undo, so the human always says yes.
export function PeopleSection({
  repoRoot,
  onError,
}: {
  repoRoot: string;
  onError: (msg: string | null) => void;
}) {
  const [links, setLinks] = useState<JiraUserLink[]>([]);
  const [members, setMembers] = useState<TeamMember[]>([]);
  const [suggestions, setSuggestions] = useState<
    Record<string, ReconcileSuggestion>
  >({});
  const [manualPick, setManualPick] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState<string | null>(null);
  const [reconciling, setReconciling] = useState(false);
  const [note, setNote] = useState<string | null>(null);
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
      onError(String(e));
    } finally {
      setLoading(false);
    }
  }, [repoRoot, onError]);

  useEffect(() => {
    void load();
  }, [load]);

  const unresolved = useMemo(
    () => links.filter((l) => l.status === "unresolved"),
    [links],
  );
  const resolved = useMemo(
    () => links.filter((l) => l.status === "resolved"),
    [links],
  );

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

  const runReconcile = useCallback(async () => {
    setReconciling(true);
    setNote(null);
    onError(null);
    try {
      const rows = await integrationsApi.jiraUsersReconcile(repoRoot);
      const map: Record<string, ReconcileSuggestion> = {};
      for (const r of rows) map[r.account_id] = r;
      setSuggestions(map);
    } catch (e) {
      onError(String(e));
    } finally {
      setReconciling(false);
    }
  }, [repoRoot, onError]);

  const link = useCallback(
    async (accountId: string, handle: string) => {
      if (!handle) return;
      setBusy(`link:${accountId}`);
      setNote(null);
      onError(null);
      try {
        const result = await integrationsApi.jiraUsersLink({
          repoRoot,
          accountId,
          handle,
        });
        setSuggestions((prev) => {
          const next = { ...prev };
          delete next[accountId];
          return next;
        });
        setManualPick((prev) => {
          const next = { ...prev };
          delete next[accountId];
          return next;
        });
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
        onError(String(e));
      } finally {
        setBusy(null);
      }
    },
    [repoRoot, onError, load, nameForHandle],
  );

  const unlink = useCallback(
    async (accountId: string) => {
      setBusy(`unlink:${accountId}`);
      setNote(null);
      onError(null);
      try {
        await integrationsApi.jiraUsersUnlink({ repoRoot, accountId });
        await load();
      } catch (e) {
        onError(String(e));
      } finally {
        setBusy(null);
      }
    },
    [repoRoot, onError, load],
  );

  if (loading) {
    return (
      <div className="pt-2 text-xs text-text-4 flex items-center gap-2">
        <AsciiSpinner /> Loading people…
      </div>
    );
  }

  if (failed) {
    return (
      <div className="pt-2">
        <div className="flex items-center gap-2 text-text-4 text-xs font-medium mb-1">
          <Users className="w-3 h-3" /> People
        </div>
        <ErrorNote className="text-xs">
          Aura couldn't read who's on your Jira cards.{" "}
          <button
            type="button"
            onClick={() => void load()}
            className="underline underline-offset-2 hover:text-text-2"
          >
            Try again
          </button>
        </ErrorNote>
      </div>
    );
  }

  // Nothing imported yet — keep the section quiet rather than show an empty box.
  if (links.length === 0) {
    return (
      <div className="pt-2">
        <div className="flex items-center gap-2 text-text-4 text-xs font-medium mb-1">
          <Users className="w-3 h-3" /> People
        </div>
        <p className="text-xs text-text-4">
          Once you sync a project, the people assigned on those Jira cards show
          up here so you can match them to your teammates.
        </p>
      </div>
    );
  }

  return (
    <div className="pt-2 space-y-2.5">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2 text-text-4 text-xs font-medium">
          <Users className="w-3 h-3" /> People ({resolved.length}/{links.length}{" "}
          matched)
        </div>
        {unresolved.length > 0 && (
          <button
            type="button"
            onClick={runReconcile}
            disabled={reconciling}
            className="inline-flex items-center gap-1.5 text-xs px-2 py-0.5 rounded border border-line text-text-2 hover:text-text-1 hover:bg-state-hover disabled:opacity-50"
            title="Let Aura suggest the most likely teammate for each unmatched Jira person. You confirm each one."
          >
            {reconciling ? (
              <AsciiSpinner className="text-xs leading-none" />
            ) : (
              <Sparkles className="w-3 h-3" />
            )}
            {reconciling ? "Asking Aura…" : "Match with Aura"}
          </button>
        )}
      </div>

      {unresolved.length > 0 && (
        <p className="text-xs text-text-4">
          {unresolved.length} Jira{" "}
          {unresolved.length === 1 ? "person isn't" : "people aren't"} matched to
          a teammate yet. Until then their Jira name shows on the card.
        </p>
      )}

      {unresolved.length > 0 && (
        <ul className="space-y-1.5">
          {unresolved.map((l) => {
            const s = suggestions[l.account_id];
            const picked = manualPick[l.account_id] ?? "";
            const linkBusy = busy === `link:${l.account_id}`;
            const suggestedName =
              s?.suggested_handle != null
                ? nameForHandle(s.suggested_handle)
                : null;
            return (
              <li
                key={l.account_id}
                className="rounded border border-line-soft/60 bg-bg-2/40 px-2.5 py-2 text-sm space-y-1.5"
              >
                <div className="flex items-center gap-2 min-w-0">
                  <span className="px-1.5 py-0.5 rounded bg-[#2684FF]/15 text-[#2684FF] text-2xs">
                    Jira
                  </span>
                  <span className="text-text-1 truncate">
                    {l.display_name || l.account_id}
                  </span>
                  {l.email && (
                    <span className="text-text-5 text-xs truncate">
                      {l.email}
                    </span>
                  )}
                </div>

                {s?.suggested_handle && (
                  <div className="flex items-center gap-2 flex-wrap">
                    <span className="text-text-3">
                      Looks like{" "}
                      <span className="text-text-1">
                        {suggestedName ?? s.suggested_handle}
                      </span>
                      <span className="text-text-5">
                        {" "}
                        · {Math.round((s.confidence ?? 0) * 100)}% sure
                      </span>
                    </span>
                    <Button
                      size="xs"
                      onClick={() => link(l.account_id, s.suggested_handle!)}
                      disabled={linkBusy}
                    >
                      {linkBusy ? (
                        <AsciiSpinner className="text-xs leading-none" />
                      ) : (
                        <LinkIcon className="w-3 h-3" />
                      )}
                      Match
                    </Button>
                  </div>
                )}

                {s && !s.suggested_handle && (
                  <div className="text-xs text-text-4">{s.reason}</div>
                )}

                <div className="flex items-center gap-2">
                  <Select
                    value={picked}
                    onChange={(v) =>
                      setManualPick((prev) => ({
                        ...prev,
                        [l.account_id]: v,
                      }))
                    }
                    placeholder="Pick a teammate by hand…"
                    options={pickableMembers.map((m) => ({
                      value: m.handle,
                      // A device-keyed placeholder adds nothing to a picker
                      // label — the name is what you recognise, and the UUID
                      // would only make two rows look like different people.
                      label: `${m.name?.trim() || m.handle}${
                        m.email && !isDeviceIdentity(m.email)
                          ? ` · ${m.email}`
                          : ""
                      }`,
                    }))}
                    className="flex-1 text-sm"
                  />
                  <Button
                    variant="secondary"
                    size="xs"
                    onClick={() => link(l.account_id, picked)}
                    disabled={!picked || linkBusy}
                  >
                    {linkBusy ? (
                      <AsciiSpinner className="text-xs leading-none" />
                    ) : (
                      <LinkIcon className="w-3 h-3" />
                    )}
                    Match
                  </Button>
                </div>
              </li>
            );
          })}
        </ul>
      )}

      {resolved.length > 0 && (
        <ul className="space-y-1">
          {resolved.map((l) => {
            const unlinkBusy = busy === `unlink:${l.account_id}`;
            return (
              <li
                key={l.account_id}
                className="flex items-center gap-2 text-sm px-2 py-1"
              >
                <CheckCircle2 className="w-3 h-3 text-accent-green flex-shrink-0" />
                <span className="text-text-2 truncate">
                  {l.display_name || l.account_id}
                </span>
                <span className="text-text-5">→</span>
                <span className="text-text-1 truncate">
                  {nameForHandle(l.handle) ?? l.handle}
                </span>
                <span className="text-text-5 text-xs flex-1">
                  {l.via === "email"
                    ? "matched by email"
                    : l.via === "brain"
                      ? "matched by Aura"
                      : "matched by you"}
                </span>
                <Button
                  type="button"
                  variant="ghost"
                  size="icon-sm"
                  onClick={() => unlink(l.account_id)}
                  disabled={unlinkBusy}
                  className="text-text-4 hover:text-red"
                  title="Unmatch. Sends this Jira person back to the list above"
                >
                  {unlinkBusy ? (
                    <AsciiSpinner className="text-xs leading-none" />
                  ) : (
                    <Unlink className="w-3 h-3" />
                  )}
                </Button>
              </li>
            );
          })}
        </ul>
      )}

      {note && (
        <div className="text-xs text-accent-green flex items-center gap-1.5">
          <CheckCircle2 className="w-3 h-3" /> {note}
        </div>
      )}
    </div>
  );
}
