// ShareSurface, wired to the session plane.
//
// The panels take everything as props and reach for nothing, which is what
// makes them photographable and testable; this is the piece that reaches. It is
// also, until now, the missing door: every one of these surfaces existed and
// was mounted nowhere, so no session in this app could actually be shared and
// the people rail could never fill with anybody.
//
// Three questions it answers, in the order it answers them:
//
//  1. **Is this session already shared?** Asked on open, through a read that
//     cannot mint a share. A surface that assumed "no link in memory" meant
//     "private" would tell a host their session is closed when it is open —
//     and the fix for that must never be "POST and see", because POST shares
//     it.
//  2. **Who is in, and what may they do?** Straight off the live state; the
//     server's next `presence` is always the authority, so nothing here caches
//     a roster of its own.
//  3. **Where do the ports go?** Re-read from the desktop rather than
//     remembered, because a tunnel dies with the socket that opened it and
//     nobody sends a frame to say so.

import { useCallback, useEffect, useState, type JSX } from "react";

import { api } from "../../../lib/api";
import { useEditorStore } from "../../../lib/editorStore";
import {
  fetchJoinPreview,
  type SessionJoinPreview,
} from "../../../lib/sessionLive";
import {
  changeParticipantAccess,
  closeSessionTunnel,
  createShare,
  joinSession,
  leaveSession,
  noteSessionHostMachine,
  openSessionTunnel,
  readShareStatus,
  refreshSessionTunnels,
  revokeShare,
  useSessionLive,
} from "../../../lib/sessionLiveStore";
import { ShareSurface, type ShareSurfaceTab } from "./ShareSurface";
import {
  tunnelReach,
  type AccessLevel,
  type JoinFailure,
  type JoinPreview,
  type SharedSession,
} from "./shareTypes";

export type ShareSurfaceMountProps = {
  /** The session being shared. For a session this desktop hosts it is both the
   *  local agent id and the external id — the two are the same string, set
   *  when the share is created (`cmd_session_live/session.rs`). */
  sessionId: string;
  /** The project it belongs to. Names who can join, and nothing else. */
  repoRoot: string;
  /** What the session is about, in the words already on its tab. */
  title: string;
  onClose: () => void;
  initialTab?: ShareSurfaceTab;
};

/** `/Users/x/code/aura-sovereign` → `aura-sovereign`. The repo is what the
 *  server actually gates on, so its name is what the copy names. */
function repoLabel(repoRoot: string): string {
  const parts = repoRoot.split("/").filter(Boolean);
  return parts[parts.length - 1] ?? repoRoot;
}

/** The wire preview, in the words the panel speaks. `repoName` is left out on
 *  purpose: the preview endpoint says whose machine it is and who is in there,
 *  and nothing about the repo — filling it in with whatever project the guest
 *  happens to have open would name the wrong one with total confidence. */
function toJoinPreview(p: SessionJoinPreview): JoinPreview {
  return {
    externalId: p.external_id,
    title: p.title,
    hostName: p.host.name,
    hostMachine: p.host.machine,
    hostOnline: p.host_online,
    participants: p.participants,
    yourAccess: p.your_access,
  };
}

export function ShareSurfaceMount({
  sessionId,
  repoRoot,
  title,
  onClose,
  initialTab = "share",
}: ShareSurfaceMountProps): JSX.Element {
  const live = useSessionLive(sessionId);
  const repoName = repoLabel(repoRoot);
  // Module-scope action, so its identity is stable and `onJoin` isn't rebuilt
  // on every render of a panel that re-renders on every frame off the wire.
  const { openLiveSession } = useEditorStore();

  // ── Share ──────────────────────────────────────────────────────────────
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [savingIds, setSavingIds] = useState<string[]>([]);
  const [machine, setMachine] = useState("this machine");
  const [hostName, setHostName] = useState("You");

  const load = useCallback(async () => {
    setLoading(true);
    const ok = await readShareStatus(sessionId);
    // The store carries the reason; showing the raw sentence beats inventing a
    // friendlier one that hides which half failed.
    setError(ok ? null : "Couldn’t check whether this session is shared.");
    setLoading(false);
  }, [sessionId]);

  useEffect(() => {
    void load();
  }, [load]);

  useEffect(() => {
    let alive = true;
    void api
      .deviceIdentity()
      .then((d) => {
        if (!alive) return;
        const name = d.display_name?.trim();
        if (name) {
          setMachine(name);
          setHostName(name);
        }
      })
      .catch(() => {
        // A machine with no name is still a machine you can share from.
      });
    return () => {
      alive = false;
    };
  }, []);

  // Tunnels are the desktop's to know. Re-read on open, and again whenever the
  // socket comes back, since everything it opened died with the old one.
  useEffect(() => {
    void refreshSessionTunnels(sessionId);
  }, [sessionId, live.connection]);

  const session: SharedSession | null = live.share
    ? {
        externalId: sessionId,
        title,
        hostMachine: machine,
        hostName: live.participants.find((p) => p.role === "host")?.name ?? hostName,
        repoName,
        link: live.share.link,
        code: live.share.code,
        defaultAccess: live.share.default_access,
        participants: live.participants,
        // Straight off the participants the server stamped. Not a second
        // source: `access` is resolved server-side on every presence, so the
        // moment this map disagreed with the list it would be this map that
        // was wrong.
        access: Object.fromEntries(
          live.participants.map((p) => [p.id, p.access]),
        ),
      }
    : null;

  const onShare = useCallback(
    async (level: AccessLevel) => {
      const share = await createShare(sessionId, level);
      if (!share) throw new Error(live.lastError ?? "Couldn’t share this session.");
    },
    [sessionId, live.lastError],
  );

  const onStopSharing = useCallback(async () => {
    const ok = await revokeShare(sessionId);
    if (!ok) throw new Error(live.lastError ?? "Couldn’t stop sharing.");
    // The door is closed; the room is not emptied. Leaving the socket here as
    // well would drop the people already inside, which is a different decision
    // than the one the host just made.
  }, [sessionId, live.lastError]);

  const onDefaultAccessChange = useCallback(
    (level: AccessLevel) => {
      // Re-minting is how the default is changed: the cloud's POST /share is a
      // read-or-write on one row, so it returns the SAME code with the new
      // default rather than handing out a second link.
      void createShare(sessionId, level);
    },
    [sessionId],
  );

  const onAccessChange = useCallback(
    (participantId: string, level: AccessLevel) => {
      setSavingIds((ids) =>
        ids.includes(participantId) ? ids : [...ids, participantId],
      );
      void changeParticipantAccess(sessionId, participantId, level).finally(() => {
        setSavingIds((ids) => ids.filter((id) => id !== participantId));
      });
    },
    [sessionId],
  );

  // ── Join ───────────────────────────────────────────────────────────────
  const [preview, setPreview] = useState<JoinPreview | null>(null);
  const [looking, setLooking] = useState(false);
  const [failure, setFailure] = useState<JoinFailure | null>(null);

  const onLookup = useCallback(async (code: string) => {
    setLooking(true);
    setFailure(null);
    let reason = "";
    const found = await fetchJoinPreview(code, (m: string) => {
      reason = m;
    });
    setLooking(false);
    if (found) {
      setPreview(toJoinPreview(found));
      return;
    }
    setPreview(null);
    // The cloud answers 404 for a code that does not exist AND for one
    // belonging to a repo you are not on — deliberately indistinguishable — so
    // this cannot claim to know which. Anything else is reported as itself.
    const notMember = /not a member|not on this repo/i.test(reason);
    setFailure({
      kind: notMember ? "not-a-member" : reason ? "unknown" : "not-found",
      detail: reason || undefined,
    });
  }, []);

  const onJoin = useCallback(
    async (externalId: string) => {
      const info = await joinSession(externalId);
      if (!info) throw new Error("Couldn’t join that session.");
      // The socket is open; put the room on screen. Without this the join
      // succeeded into nothing — the panel closed, the participant list filled
      // on someone else's machine, and this side had no surface showing it.
      //
      // Machine name first, because only the preview ever carries it. No live
      // frame does, so a session joined from a pasted code with no preview
      // behind it leaves the guest's banner saying "their machine" rather than
      // naming the wrong computer with confidence.
      noteSessionHostMachine(externalId, preview?.hostMachine);
      openLiveSession(externalId);
      onClose();
    },
    [onClose, openLiveSession, preview?.hostMachine],
  );

  const onReset = useCallback(() => {
    setPreview(null);
    setFailure(null);
  }, []);

  // ── Ports ──────────────────────────────────────────────────────────────
  const onOpenTunnel = useCallback(
    async (port: number, label: string) => {
      const tunnel = await openSessionTunnel(sessionId, port, label);
      if (!tunnel) {
        throw new Error(
          live.lastError ??
            "Couldn’t open that port. The session has to be live before anyone can reach it.",
        );
      }
    },
    [sessionId, live.lastError],
  );

  const onStopTunnel = useCallback(
    async (code: string) => {
      const ok = await closeSessionTunnel(sessionId, code);
      if (!ok) throw new Error(live.lastError ?? "Couldn’t close that port.");
    },
    [sessionId, live.lastError],
  );

  return (
    <ShareSurface
      onClose={onClose}
      initialTab={initialTab}
      share={{
        session,
        repoName,
        loading,
        error,
        onRetry: () => void load(),
        onShare,
        onStopSharing,
        onDefaultAccessChange,
        onAccessChange,
        youId: live.you?.id ?? "",
        savingIds,
      }}
      join={{ preview, looking, failure, onLookup, onJoin, onReset }}
      tunnels={{
        tunnels: live.tunnels,
        reachableBy: tunnelReach(live.participants),
        loading: live.tunnels === null,
        error: null,
        onRetry: () => void refreshSessionTunnels(sessionId),
        onOpen: onOpenTunnel,
        onStop: onStopTunnel,
        sessionShared: session !== null,
      }}
    />
  );
}

/** Close a session's socket when the surface that owned it is done with it.
 *  Exported for the tab that opens a joined session — leaving is a decision,
 *  not a side effect of unmounting a panel. */
export function leaveSharedSession(sessionId: string): void {
  void leaveSession(sessionId);
}
