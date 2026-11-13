// A workspace's conversation as a viewer reads it: the message list once,
// then the live socket. The list is read again whenever the socket comes
// back, and every few seconds only while it is away.
//
// The list is kept for the window (useKeptView): opening the workspace again
// shows the conversation as it was left at once, and the read brings it up
// to date behind it, instead of starting from an empty page each time.

import { useCallback, useEffect, useRef, useState } from "react";

import {
  EMPTY_LIVE,
  followWorkspace,
  liveStep,
  withMessage,
  withRead,
  type LiveState,
} from "../../lib/cloudWorkspaceLive";
import { cloudApi, cloudProblem, type CloudMessageRow } from "../../lib/cloudWorkspacesApi";
import { viewKey } from "./cloudPlaceKeep";
import { useKeptView } from "./useKeptView";

const POLL_MS = 5_000;

export function useWorkspaceLive(
  id: string,
  { enabled, running }: { enabled: boolean; running: boolean },
) {
  const [messages, keepMessages] = useKeptView<CloudMessageRow[] | null>(viewKey("messages", id), null);
  const [failed, setFailed] = useState<string | null>(null);
  const [live, setLive] = useState<LiveState>(EMPTY_LIVE);
  const up = useRef(false);

  const read = useCallback(async () => {
    try {
      const fresh = await cloudApi.messages(id);
      keepMessages((list) => withRead(list, fresh));
      setFailed(null);
    } catch (e) {
      setFailed(cloudProblem(e).message);
    }
  }, [id, keepMessages]);

  useEffect(() => {
    setLive(EMPTY_LIVE);
    up.current = false;
    if (!enabled) return;
    void read();
    let stop: (() => void) | null = null;
    let gone = false;
    void followWorkspace(id, (frame) => {
      if (gone) return;
      if (frame.kind === "message") keepMessages((list) => withMessage(list, frame.message));
      if (frame.kind === "ready" && !up.current) void read();
      if (frame.kind === "ready") up.current = true;
      if (frame.kind === "down") up.current = false;
      setLive((s) => liveStep(s, frame));
    }).then((s) => {
      if (gone) s();
      else stop = s;
    });
    return () => {
      gone = true;
      stop?.();
    };
  }, [id, enabled, read, keepMessages]);

  useEffect(() => {
    if (!enabled || !running || live.up) return;
    const t = setInterval(() => void read(), POLL_MS);
    return () => clearInterval(t);
  }, [enabled, running, live.up, read]);

  // A chat driven from this laptop reads its conversation elsewhere.
  return { messages: enabled ? messages : null, failed, live, read };
}
