// Opening a session somebody sent you.
//
// The console can show any session in the org; only this machine can carry
// one on. So a reader presses "Resume in app" over there and an
// `aura://session/<id>` link arrives over here (see `src-tauri/deep_link.rs`
// for how the OS hands it over). This module turns that id back into the row
// the Sessions list would have opened.
//
// The link can also arrive at a machine that has never seen the session — it
// ran on a colleague's laptop, or in a project not cloned here. That is an
// ordinary outcome, not a fault, and the honest answers are different enough
// to be worth telling apart: the project is missing, or the project is here
// and this session is not. Both beat an app that opens something adjacent and
// lets the reader believe it is the thing they clicked.

import { checkoutForLink, type SessionLink } from "@shared/sessionLink";
import type { IntentRow } from "./api";
import { isAutoStub, statedSessionId } from "./sessionMeta";

/** The window event `deep_link.rs` fires when a URL arrives while the app is
 *  already running. The name is spelled there too; both spellings are one
 *  string, so keep them together. */
export const DEEP_LINK_EVENT = "aura://open-url";

/** What a link resolved to, or why it did not. */
export type Handoff =
  | { kind: "open"; root: string; row: IntentRow; rewind: string | null }
  | { kind: "no-project"; repo: string }
  | { kind: "no-session"; root: string; sessionId: string };

/**
 * The row that stands for a session.
 *
 * A session is many rows — one per note, most of them written by a hook —
 * and the list shows one entry for the lot. Which one represents it matters:
 * a hook capture's text is the command it ran, so opening the session on one
 * of those titles it with a shell line, while a row somebody actually wrote
 * carries the request. So a stated intent wins, and among rows of the same
 * kind the earliest does — the first thing said about a session is what it
 * set out to do, and the last is wherever it ended up.
 */
export function rowForSession(rows: readonly IntentRow[], sessionId: string): IntentRow | null {
  const wanted = sessionId.trim();
  if (!wanted) return null;
  let best: IntentRow | null = null;
  for (const row of rows) {
    const id = statedSessionId(row) || (row.manager_session_id ?? "").trim();
    if (id !== wanted) continue;
    if (!best) {
      best = row;
      continue;
    }
    const bestIsStub = isAutoStub(best);
    const rowIsStub = isAutoStub(row);
    if (bestIsStub !== rowIsStub) {
      if (bestIsStub) best = row;
      continue;
    }
    if (row.timestamp < best.timestamp) best = row;
  }
  return best;
}

/**
 * Where a link lands, given what this machine actually has.
 *
 * `rowsIn` is asked for one checkout only, and only once the checkout is
 * settled — reading every project's log to find a session would be slow, and
 * would happily open a same-named session out of the wrong repository.
 */
export async function resolveHandoff(
  link: SessionLink,
  known: { roots: readonly string[]; standingIn: string | null },
  rowsIn: (root: string) => Promise<readonly IntentRow[]>,
): Promise<Handoff> {
  const root = checkoutForLink(link, known.roots, known.standingIn);
  if (!root) return { kind: "no-project", repo: link.repo ?? "" };
  let rows: readonly IntentRow[] = [];
  try {
    rows = await rowsIn(root);
  } catch {
    // An unreadable log is the same outcome for the reader as an empty one:
    // this machine cannot show them the session. Saying so beats a thrown
    // error nobody sees, which is how the link came to do nothing at all.
    rows = [];
  }
  const row = rowForSession(rows, link.sessionId);
  if (!row) return { kind: "no-session", root, sessionId: link.sessionId };
  return { kind: "open", root, row, rewind: link.rewind };
}

/** The rewind target as the tool wants it: an absolute path. A link carries a
 *  repo-relative one, because that is the only form that survives the trip
 *  between two machines. */
export function rewindPath(root: string, rewind: string): string {
  if (rewind.startsWith("/")) return rewind;
  return `${root.replace(/\/+$/, "")}/${rewind.replace(/^\/+/, "")}`;
}

/** What to tell the reader when the link could not be opened.
 *
 *  One sentence, naming the thing that is missing. "Nothing happened" was the
 *  old answer and it is the one thing a person cannot act on. */
export function handoffProblem(h: Handoff): string {
  if (h.kind === "open") return "";
  if (h.kind === "no-project") {
    const named = h.repo ? `The ${folderName(h.repo)} project` : "That project";
    return `${named} is not open on this machine, so the session cannot be opened here. Open it and follow the link again.`;
  }
  return `This machine has no record of that session in ${folderName(h.root)}. It was most likely run on another computer — the console still holds the whole of it.`;
}

function folderName(path: string): string {
  const trimmed = path.replace(/\/+$/, "");
  return trimmed.slice(trimmed.lastIndexOf("/") + 1) || trimmed;
}
