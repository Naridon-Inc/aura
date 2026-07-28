/** Team (chat) bounded context — conversation-list header + chat doctor.
 *
 *  The top-of-list team header (team id, member counts, "you:" line, the
 *  claim affordance, and the 🩺 diagnostics opener) plus the self-contained
 *  Chat Doctor cluster it owns: the modal, the read-only report table, and
 *  the identity-mismatch banner that lets a contributor whose git email
 *  isn't on the roster pin a per-repo override or add an alias. Lifted
 *  verbatim from the CommsPanel monolith — only the diagnostic dialog uses
 *  these, so they travel together as the header's private surface. */

import { useCallback, useEffect, useState } from "react";
import {
  api,
  type ChatDoctorReport,
  type TeamIdentity,
  type TeamManifest,
} from "../../../lib/api";
import { Button } from "../../ui/button";

export function TeamHeader({
  identity,
  manifest,
  onClaim,
  repoRoot,
  label = "Team",
}: {
  identity: TeamIdentity | null;
  manifest: TeamManifest | null;
  onClaim: () => void;
  repoRoot: string;
  label?: string;
}) {
  const [doctorOpen, setDoctorOpen] = useState(false);
  // Trace-style rail title — a glyph + "Team" header that matches the other
  // sections' own chrome (Trace's `.ade-rail-title`, Build's nav band) rather
  // than the earlier "+ New / 1·5 claimed" band. Channel-create lives in the
  // Channels group's own add button; the claim nudge only appears when the
  // local git identity genuinely needs claiming; a quiet trailing glyph opens
  // Chat Doctor. Same `.ade-rail-title` class → pixel-identical to Trace.
  const needsClaim = Boolean(
    manifest && identity && !identity.claimed && identity.email,
  );
  return (
    <>
      <div className="ade-rail-title flex-shrink-0">
        <MembersGlyph />
        <span>{label}</span>
        {needsClaim && (
          <Button
            variant="accentSoft"
            size="xs"
            className="ml-auto"
            onClick={onClaim}
            title={`Claim @${identity?.handle ?? ""} as you`}
            aria-label={`Claim @${identity?.handle ?? ""} as you`}
          >
            Claim
          </Button>
        )}
        {manifest && (
          <button
            type="button"
            onClick={() => setDoctorOpen(true)}
            className={`${needsClaim ? "" : "ml-auto"} flex h-6 w-6 flex-none items-center justify-center rounded-md text-text-3 transition-colors hover:bg-bg-2 hover:text-text-1`}
            title="Check chat health — connection, sync, and any unsent messages"
            aria-label="Chat diagnostics"
          >
            {/* inline width/color beat `.ade-rail-title svg` (14px accent) so
                this stays a neutral secondary action, not a primary accent one */}
            <svg
              viewBox="0 0 16 16"
              fill="none"
              aria-hidden
              style={{ width: 13, height: 13, color: "currentColor" }}
            >
              <path
                d="M1.75 8h2.5l1.4-3.4 2.6 7.3 1.5-3.9h4"
                stroke="currentColor"
                strokeWidth="1.3"
                strokeLinecap="round"
                strokeLinejoin="round"
              />
            </svg>
          </button>
        )}
      </div>
      {doctorOpen && (
        <ChatDoctorDialog repoRoot={repoRoot} onClose={() => setDoctorOpen(false)} />
      )}
    </>
  );
}

// ── rail-title glyph ─────────────────────────────────────────────────
// A two-person "team" mark. `.ade-rail-title svg` governs its 14px size +
// accent tint (same rule Trace's ShieldGlyph rides), so it matches the other
// section titles exactly.

function MembersGlyph() {
  return (
    <svg className="ade-bnav-glyph" viewBox="0 0 16 16" fill="none" aria-hidden>
      <path
        d="M6 7.75a2 2 0 1 0 0-4 2 2 0 0 0 0 4Z"
        stroke="currentColor"
        strokeWidth="1.3"
      />
      <path
        d="M1.75 12.5c0-1.7 1.9-2.75 4.25-2.75 1.02 0 1.96.2 2.72.55"
        stroke="currentColor"
        strokeWidth="1.3"
        strokeLinecap="round"
      />
      <path
        d="M11 8.25a1.6 1.6 0 1 0 0-3.2 1.6 1.6 0 0 0 0 3.2Z"
        stroke="currentColor"
        strokeWidth="1.2"
      />
      <path
        d="M9.9 10.1c2.02-.16 4.35.72 4.35 2.65"
        stroke="currentColor"
        strokeWidth="1.2"
        strokeLinecap="round"
      />
    </svg>
  );
}

// ── chat doctor dialog ───────────────────────────────────────────────
//
// Read-only diagnostic. Surfaces the values the chat substrate uses to
// deliver messages, so a disconnected teammate can paste the report
// into a shared channel for triage. Mismatched room_id between two
// teammates = they will never see each other's messages no matter what
// channel they're on, since the room is the membership boundary.

function ChatDoctorDialog({
  repoRoot,
  onClose,
}: {
  repoRoot: string;
  onClose: () => void;
}) {
  const [report, setReport] = useState<ChatDoctorReport | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(true);

  useEffect(() => {
    let cancelled = false;
    setBusy(true);
    api
      .chatDoctor(repoRoot)
      .then((r) => {
        if (cancelled) return;
        setReport(r);
        setErr(null);
      })
      .catch((e) => {
        if (cancelled) return;
        setErr(e instanceof Error ? e.message : String(e));
      })
      .finally(() => {
        if (!cancelled) setBusy(false);
      });
    return () => {
      cancelled = true;
    };
  }, [repoRoot]);

  const copyReport = useCallback(async () => {
    if (!report) return;
    try {
      await navigator.clipboard.writeText(JSON.stringify(report, null, 2));
    } catch {
      /* clipboard denied — fall back is the visible JSON */
    }
  }, [report]);

  return (
    <div
      className="fixed inset-0 z-[80] flex items-center justify-center bg-black/60 p-6"
      onClick={onClose}
      role="dialog"
      aria-label="Chat diagnostics"
    >
      <div
        className="flex max-h-[80vh] w-[560px] flex-col overflow-hidden rounded-md border border-line-1 bg-bg-1 shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between border-b border-line-soft px-3 py-2">
          <div className="text-[12px] font-medium text-text-1">Chat doctor</div>
          <Button
            variant="ghost"
            size="icon-sm"
            onClick={onClose}
            className="text-text-3 hover:text-text-1"
            aria-label="Close"
          >
            ✕
          </Button>
        </div>
        <div className="flex-1 overflow-y-auto px-3 py-3 text-[11.5px]">
          {busy && <div className="text-text-3">Probing…</div>}
          {err && (
            <div className="rounded border border-red/30 bg-red/10 px-2 py-1.5 text-red">
              {err}
            </div>
          )}
          {report && (
            <ChatDoctorReportBody
              report={report}
              repoRoot={repoRoot}
              onRefresh={async () => {
                try {
                  const next = await api.chatDoctor(repoRoot);
                  setReport(next);
                  // Bump the chat panel as well — selfHandle will
                  // re-derive on next render and the rail header
                  // avatar swaps over without a reload.
                  window.dispatchEvent(new CustomEvent("aura:identity-updated"));
                } catch {
                  /* keep the stale report; user can re-open */
                }
              }}
            />
          )}
        </div>
        <div className="flex items-center justify-between gap-2 border-t border-line-soft px-3 py-2 text-[11px]">
          <div className="text-text-4">
            Share this with a teammate to compare — if these don't match,
            you won't see each other's messages.
          </div>
          <Button
            variant="secondary"
            size="sm"
            onClick={copyReport}
            disabled={!report}
          >
            Copy JSON
          </Button>
        </div>
      </div>
    </div>
  );
}

function ChatDoctorReportBody({
  report,
  repoRoot,
  onRefresh,
}: {
  report: ChatDoctorReport;
  repoRoot: string;
  onRefresh: () => Promise<void> | void;
}) {
  const Row = ({ k, v, tone }: { k: string; v: React.ReactNode; tone?: "ok" | "warn" | "err" }) => (
    <tr>
      <td className="py-0.5 pr-3 align-top text-text-3">{k}</td>
      <td
        className={`py-0.5 align-top break-all ${
          tone === "ok" ? "text-[color:var(--color-green)]" : tone === "warn" ? "text-[color:var(--color-amber)]" : tone === "err" ? "text-[color:var(--color-red)]" : "text-text-1"
        }`}
      >
        {v}
      </td>
    </tr>
  );
  const cloudTone: "ok" | "err" = report.cloud_reachable ? "ok" : "err";
  const remoteSourceTone: "ok" | "warn" =
    report.room_id_source === "git-origin" ||
    report.room_id_source === "repo-override"
      ? "ok"
      : "warn";
  return (
    <>
      <IdentityMismatchBanner
        report={report}
        repoRoot={repoRoot}
        onRefresh={onRefresh}
      />
    <table className="w-full table-auto border-collapse">
      <tbody>
        <Row k="room_id" v={<code>{report.room_id}</code>} />
        <Row
          k="room_id source"
          v={report.room_id_source}
          tone={remoteSourceTone}
        />
        <Row
          k="origin url (raw)"
          v={report.origin_url_raw ?? <span className="text-text-4">— none —</span>}
        />
        <Row
          k="origin url (norm)"
          v={
            report.origin_url_normalised ?? (
              <span className="text-text-4">— none —</span>
            )
          }
        />
        <Row k="git email" v={report.git_email || "—"} />
        <Row k="git name" v={report.git_name || "—"} />
        <Row k="handle" v={`@${report.handle || "—"}`} />
        <Row k="device id" v={<code>{report.device_id || "—"}</code>} />
        <Row
          k="cloud_url (creds)"
          v={
            report.cloud_url_raw ?? (
              <span className="text-text-4">— unset (uses default) —</span>
            )
          }
          tone={
            report.cloud_url_raw &&
            !report.cloud_url_raw.includes("auravcs.com")
              ? "warn"
              : undefined
          }
        />
        <Row
          k="cloud token"
          v={report.cloud_token_present ? "present" : "absent (anon)"}
        />
        <Row k="http origin (POST)" v={report.cloud_origin} />
        <Row k="ws url (SUB)" v={report.ws_url} />
        <Row
          k="http/ws host match"
          v={
            report.http_ws_host_match
              ? "yes"
              : "NO — messages POST to a host the WS never hears"
          }
          tone={report.http_ws_host_match ? "ok" : "err"}
        />
        <Row
          k="cloud reachable"
          v={
            report.cloud_reachable
              ? `yes (HTTP ${report.cloud_status ?? ""})`
              : `no${report.cloud_error ? ` — ${report.cloud_error}` : ""}`
          }
          tone={cloudTone}
        />
        <Row
          k="channels (local)"
          v={
            report.channels.length === 0
              ? "(none)"
              : report.channels.join(", ")
          }
        />
        <Row
          k="local messages"
          v={String(report.local_message_count)}
        />
        <Row
          k="cloud msgs (#general)"
          v={
            report.cloud_message_count_general === null
              ? "(unknown — cloud unreachable)"
              : String(report.cloud_message_count_general)
          }
        />
        <Row
          k="outbox pending"
          v={String(report.outbox_pending)}
          tone={report.outbox_pending > 0 ? "warn" : undefined}
        />
        <Row
          k="outbox failed"
          v={String(report.outbox_failed)}
          tone={report.outbox_failed > 0 ? "err" : undefined}
        />
        {report.outbox_last_error && (
          <Row
            k="last error"
            v={<code className="break-all">{report.outbox_last_error}</code>}
            tone="err"
          />
        )}
      </tbody>
    </table>
    </>
  );
}

function IdentityMismatchBanner({
  report,
  repoRoot,
  onRefresh,
}: {
  report: ChatDoctorReport;
  repoRoot: string;
  onRefresh: () => Promise<void> | void;
}) {
  const [busy, setBusy] = useState<"override" | "alias" | null>(null);
  const [err, setErr] = useState<string | null>(null);

  const canonicalHandle = report.canonical_handle ?? null;
  const overrideActive = report.identity_override_active === true;
  const rosterMatch = report.roster_email_match === true;
  // Banner triggers when the local git email isn't on any roster
  // record but we know a canonical handle to route messages to (either
  // via an existing alias, or a per-repo override the user already
  // pinned). If neither, the user is genuinely a new contributor and
  // no banner is appropriate — the existing onboarding flow handles
  // that case via team_claim.
  if (rosterMatch && !overrideActive) return null;
  if (!canonicalHandle) return null;

  const useOverride = async () => {
    if (!canonicalHandle) return;
    setBusy("override");
    setErr(null);
    try {
      await api.identityOverrideSet(
        repoRoot,
        canonicalHandle,
        canonicalHandle, // name defaults to handle; user can edit roster later
        report.canonical_email ?? report.git_email,
      );
      await onRefresh();
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(null);
    }
  };

  const clearOverride = async () => {
    setBusy("override");
    setErr(null);
    try {
      await api.identityOverrideClear(repoRoot);
      await onRefresh();
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(null);
    }
  };

  const addAlias = async () => {
    if (!canonicalHandle || !report.git_email) return;
    setBusy("alias");
    setErr(null);
    try {
      await api.teamAliasAdd(repoRoot, canonicalHandle, report.git_email);
      await onRefresh();
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(null);
    }
  };

  return (
    <div className="mb-3 rounded-lg border border-line bg-bg-0 shadow-[var(--shadow-card)] px-3 py-2.5 text-[11.5px] text-text-2">
      <div className="font-medium" style={{ color: "var(--color-amber)" }}>
        {overrideActive
          ? `Sending as @${canonicalHandle} for this repo`
          : `Your git email isn't on the team roster`}
      </div>
      <div className="mt-1 text-text-3">
        Local git: <code className="font-mono">{report.git_email || "—"}</code>
        {report.canonical_email && (
          <>
            {" · "}roster: <code className="font-mono">@{canonicalHandle}</code>{" "}
            <span className="text-text-4">
              ({report.canonical_email})
            </span>
          </>
        )}
      </div>
      {err && (
        <div className="mt-1.5 text-red">{err}</div>
      )}
      <div className="mt-2 flex flex-wrap gap-2">
        {overrideActive ? (
          <Button
            variant="outline"
            size="sm"
            onClick={clearOverride}
            disabled={busy !== null}
            className="text-text-2"
          >
            {busy === "override" ? "Clearing…" : "Clear per-repo override"}
          </Button>
        ) : (
          <Button
            variant="outline"
            size="sm"
            onClick={useOverride}
            disabled={busy !== null || !canonicalHandle}
            className="text-text-2"
          >
            {busy === "override"
              ? "Switching…"
              : `Use @${canonicalHandle} for this repo`}
          </Button>
        )}
        <Button
          variant="secondary"
          size="sm"
          onClick={addAlias}
          disabled={busy !== null || !canonicalHandle || !report.git_email}
          title="Admins (or the handle owner) can link this email as an alias for everyone in the repo."
        >
          {busy === "alias" ? "Linking…" : "Add this email as an alias"}
        </Button>
      </div>
      {report.alias_emails && report.alias_emails.length > 0 && (
        <div className="mt-1.5 text-text-4">
          Existing aliases on @{canonicalHandle}:{" "}
          {report.alias_emails.join(", ")}
        </div>
      )}
    </div>
  );
}
