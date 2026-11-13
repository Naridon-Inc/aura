// A workspace's comments, kept current while it is open: one read, then the
// live socket, with a read from the last cursor every so often in case a
// frame went missing (more often while the socket is away).
//
// It follows the workspace on its own, so the member driving a machine chat
// (who reads the conversation through the chat, not the socket) still sees
// what teammates add. A comment shows once the server has it.
//
// What it read is kept for the window with the cursor it was read up to
// (useKeptView), so a workspace opened again shows its comments at once and
// reads only what changed since.

import { useCallback, useEffect, useRef, useState } from "react";

import { feedbackApi, feedbackProblem } from "../../lib/cloudFeedbackApi";
import { setCloudNotice } from "../../lib/cloudPlace";
import { followWorkspace } from "../../lib/cloudWorkspaceLive";
import {
  EMPTY_FEEDBACK,
  readGate,
  withComment,
  withFrame,
  withPage,
  type FeedbackState,
} from "./cloudFeedback";
import { viewKey } from "./cloudPlaceKeep";
import { useKeptView } from "./useKeptView";

/** How often the cursor is read while the socket is up, and while it isn't. */
const CHECK_UP_MS = 45_000;
const CHECK_DOWN_MS = 12_000;
/** A read follows `more` this many times before waiting for the next check. */
const MOST_PAGES = 10;

export type FeedbackActions = {
  /** Start a thread on a turn (or on the workspace, with no turn), or reply. */
  comment: (to: { messageId?: string | null; parentId?: string | null }, body: string) => Promise<boolean>;
  edit: (commentId: string, body: string) => Promise<boolean>;
  remove: (commentId: string) => Promise<boolean>;
  resolve: (commentId: string) => Promise<boolean>;
  reopen: (commentId: string) => Promise<boolean>;
};

/** The feedback shown, and the cursor it was read up to. */
type KeptFeedback = { feedback: FeedbackState; cursor: string | null };
const NOTHING_KEPT: KeptFeedback = { feedback: EMPTY_FEEDBACK, cursor: null };

const newKey = () =>
  typeof crypto !== "undefined" && "randomUUID" in crypto
    ? crypto.randomUUID()
    : `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;

export function useWorkspaceFeedback(
  id: string,
  { enabled = true }: { enabled?: boolean } = {},
): { feedback: FeedbackState; failed: string | null; actions: FeedbackActions } {
  const [kept, keep] = useKeptView(viewKey("feedback", id), NOTHING_KEPT);
  const feedback = kept.feedback;
  const setFeedback = useCallback(
    (step: (s: FeedbackState) => FeedbackState) => keep((k) => ({ ...k, feedback: step(k.feedback) })),
    [keep],
  );
  const keptCursor = useRef(kept.cursor);
  keptCursor.current = kept.cursor;
  const [failed, setFailed] = useState<string | null>(null);
  const [up, setUp] = useState(false);
  const cursor = useRef<string | null>(null);
  const reading = useRef(readGate());
  // Bumped each time the workspace (re)opens; a read from before drops its
  // answer.
  const live = useRef(0);

  const pull = useCallback(async () => {
    const mine = live.current;
    if (!reading.current.begin(mine)) return;
    try {
      for (let page = 0; page < MOST_PAGES; page += 1) {
        const read = await feedbackApi.read(id, cursor.current);
        if (mine !== live.current) return;
        cursor.current = read.as_of ?? cursor.current;
        keep((k) => ({ feedback: withPage(k.feedback, read), cursor: read.as_of ?? k.cursor }));
        if (!read.more) break;
      }
      setFailed(null);
    } catch (e) {
      if (mine === live.current) setFailed(feedbackProblem(e));
    } finally {
      reading.current.end(mine);
    }
  }, [id, keep]);

  useEffect(() => {
    live.current += 1;
    // Read on from where the kept feedback was read up to.
    cursor.current = keptCursor.current;
    setFailed(null);
    setUp(false);
    if (!enabled) return;
    void pull();
    let stop: (() => void) | null = null;
    let gone = false;
    void followWorkspace(id, (frame) => {
      if (gone) return;
      if (frame.kind === "feedback") setFeedback((s) => withFrame(s, frame));
      if (frame.kind === "ready") {
        setUp(true);
        // Whatever changed while the socket was away is behind the cursor.
        void pull();
      }
      if (frame.kind === "down") setUp(false);
    }).then((s) => {
      if (gone) s();
      else stop = s;
    });
    return () => {
      gone = true;
      stop?.();
    };
  }, [id, enabled, pull, setFeedback]);

  useEffect(() => {
    if (!enabled) return;
    const t = setInterval(() => {
      if (document.visibilityState === "visible") void pull();
    }, up ? CHECK_UP_MS : CHECK_DOWN_MS);
    return () => clearInterval(t);
  }, [enabled, up, pull]);

  const write = useCallback(
    async (call: () => Promise<Parameters<typeof withComment>[1]>) => {
      try {
        const c = await call();
        setFeedback((s) => withComment(s, c));
        return true;
      } catch (e) {
        setCloudNotice(feedbackProblem(e));
        return false;
      }
    },
    [setFeedback],
  );

  const actions: FeedbackActions = {
    comment: (to, body) => write(() => feedbackApi.comment(id, to, body, newKey())),
    edit: (commentId, body) => write(() => feedbackApi.edit(id, commentId, body)),
    remove: (commentId) => write(() => feedbackApi.remove(id, commentId)),
    resolve: (commentId) => write(() => feedbackApi.resolve(id, commentId)),
    reopen: (commentId) => write(() => feedbackApi.reopen(id, commentId)),
  };

  return { feedback, failed, actions };
}

/** How often the member driving a machine chat re-reads which of its turns
 *  the relay has copied up. */
const KEPT_EVERY_MS = 30_000;
const keptStore = (id: string) => `aura.cloud.keptTurns.${id}`;

function readKept(id: string): Record<string, string> {
  try {
    const raw = localStorage.getItem(keptStore(id));
    const v: unknown = raw ? JSON.parse(raw) : null;
    if (!v || typeof v !== "object" || Array.isArray(v)) return {};
    return Object.fromEntries(
      Object.entries(v as Record<string, unknown>).filter(
        (e): e is [string, string] => typeof e[1] === "string" && !!e[1],
      ),
    );
  } catch {
    return {};
  }
}

/** For the member driving a machine chat: turn key → the id of the copy the
 *  relay kept on the cloud, so a turn on this laptop finds the comments on its
 *  copy. Remembered per workspace so a reopened chat has them
 *  before the first read comes back. */
export function useKeptTurnIds(id: string, enabled: boolean): Readonly<Record<string, string>> {
  const [kept, setKept] = useState<Record<string, string>>(() => (enabled ? readKept(id) : {}));
  useEffect(() => {
    if (!enabled) {
      setKept({});
      return;
    }
    setKept(readKept(id));
    let gone = false;
    const read = () =>
      void feedbackApi.keptTurnIds(id).then((next) => {
        if (gone || !Object.keys(next).length) return;
        setKept((was) => {
          const merged = { ...was, ...next };
          const same =
            Object.keys(merged).length === Object.keys(was).length &&
            Object.entries(merged).every(([k, v]) => was[k] === v);
          if (same) return was;
          try {
            localStorage.setItem(keptStore(id), JSON.stringify(merged));
          } catch {
            // Remembering is only a head start; the next read finds them again.
          }
          return merged;
        });
      });
    read();
    const t = setInterval(() => {
      if (document.visibilityState === "visible") read();
    }, KEPT_EVERY_MS);
    return () => {
      gone = true;
      clearInterval(t);
    };
  }, [id, enabled]);
  return kept;
}
