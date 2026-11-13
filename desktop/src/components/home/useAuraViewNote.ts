// Keeps Aura told which place the person is in.
//
// In the cloud, the conversation beside Home is sent the organization's work
// (see `cloudViewNote`) so "what's running?" is answered about the cloud, not
// the laptop project the conversation is filed under. Back on the laptop the
// note is cleared. A note is sent only when it changes, and a conversation the
// panel moves off is cleared so it doesn't keep answering about the cloud.

import { useEffect, useMemo, useRef } from "react";

import { api } from "../../lib/api";
import { cloudViewNote } from "../../lib/auraViewNote";
import { useCloudPlaceSnapshot } from "../cloudplace/cloudPlaceStore";

export function useAuraViewNote(sessionId: string | null, inCloud: boolean): void {
  const place = useCloudPlaceSnapshot();
  const note = useMemo(() => {
    if (!inCloud) return null;
    return cloudViewNote({
      orgName: place.orgName,
      me: place.userId,
      members: place.members.state === "ready" ? place.members.value : [],
      repos: place.repos.state === "ready" ? place.repos.value : [],
      workspaces: place.workspaces,
    });
  }, [inCloud, place.orgName, place.userId, place.members, place.repos, place.workspaces]);

  // What each conversation was last sent, so a repeat poll sends nothing.
  const sent = useRef(new Map<string, string | null>());

  useEffect(() => {
    if (!sessionId) return;
    if (sent.current.has(sessionId) && sent.current.get(sessionId) === note) return;
    sent.current.set(sessionId, note);
    void api.managerSetView(sessionId, note).catch(() => {
      // An app without the command, or a conversation that ended: the next
      // change tries again rather than believing this one landed.
      sent.current.delete(sessionId);
    });
  }, [sessionId, note]);

  // Moving to another conversation clears the one left behind.
  useEffect(() => {
    if (!sessionId) return;
    const left = sessionId;
    return () => {
      if (sent.current.get(left) == null) return;
      sent.current.delete(left);
      void api.managerSetView(left, null).catch(() => undefined);
    };
  }, [sessionId]);
}
