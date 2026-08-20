// How a detached window spells the place it stands on.
//
// A whole-workspace popout is a second, complete Aura window onto a project
// (lib/popout, kind `workspace`). It used to carry one thing — `root=<path>` —
// which is a fine description of a place right up until the place isn't on this
// laptop. A machine is a box AND a project; a cloud conversation is a place that
// hasn't resolved a box yet and may name no local checkout at all. Neither fits
// in a path, so "open this in its own window" was a local-only gesture: exactly
// the shape of feature this programme exists to stop shipping.
//
// So the URL carries a `PlaceRef`, and this is the codec. Three jobs, and they
// have to agree with each other or two windows end up standing in one place
// while claiming to be different (or worse, in two places while sharing a
// window label):
//
//   • what goes ON the query string (`placeToPopoutQuery`)
//   • what comes back OFF it (`placeFromPopoutQuery`)
//   • what tells two places apart inside a window LABEL (`popoutPlaceParts`)
//
// Pure and Tauri-free on purpose. `lib/popout` imports `WebviewWindow`, which
// cannot be loaded under `bun test`; the rule about which window a place opens
// in is exactly the rule worth running rather than source-scanning.
//
// `root` is shared with every other popout kind rather than given a name of its
// own: it means the same thing here as it does there — the repo this surface's
// data is filed under — and a remote place carries that same local root (see
// lib/placeRef). The only thing a path cannot say is WHICH COMPUTER, so that is
// all the remote spelling adds.

import { parsePlaceRef, placeRepoRoot, type PlaceRef } from "./placeRef";

/** The query fields that spell `place` in a popout window's URL.
 *
 *  A local place spells itself entirely in `root`, so it adds nothing — which
 *  also means every URL written before places existed still parses as the local
 *  place it always was. */
export function placeToPopoutQuery(place: PlaceRef): Record<string, string> {
  const out: Record<string, string> = { root: placeRepoRoot(place) ?? "" };
  if (place.kind === "local") return out;
  out.place = "remote";
  if (place.machineId) out.machineId = place.machineId;
  if (place.threadKey) out.threadKey = place.threadKey;
  return out;
}

/** Read the place back off a popout window's URL.
 *
 *  Null for anything that names nowhere — a remote entry with no box, no
 *  conversation and no project would key as the same wildcard place as every
 *  other such entry, and a window that opens on "whichever machine was used
 *  last" is a window that lies about which one it is. Parsing goes through
 *  `parsePlaceRef` rather than a second hand-rolled reader so a query string and
 *  a club member off disk are held to the one rule. */
export function placeFromPopoutQuery(q: URLSearchParams): PlaceRef | null {
  const root = q.get("root") ?? "";
  if (q.get("place") !== "remote") return parsePlaceRef(root);
  return parsePlaceRef({
    kind: "remote",
    machineId: q.get("machineId") ?? "",
    threadKey: q.get("threadKey") ?? "",
    repoRoot: root,
  });
}

/** What tells two places apart inside a window label, split so the caller can
 *  slug the id without eating the tag.
 *
 *  Null for a local place: its root IS its identity, and the label already
 *  carries the root. A remote place needs the computer as well — one box holding
 *  two projects are two places (that half is the root), and two boxes holding
 *  the same project are also two places (this half). `tag` separates the two key
 *  spaces so a machine called `x` and a conversation called `x` don't collapse
 *  into one window. */
export function popoutPlaceParts(
  place: PlaceRef,
): { tag: "m" | "t"; id: string } | null {
  if (place.kind === "local") return null;
  const machineId = place.machineId?.trim();
  if (machineId) return { tag: "m", id: machineId };
  const threadKey = place.threadKey?.trim();
  if (threadKey) return { tag: "t", id: threadKey };
  // A remote place that names only a project. `parsePlaceRef` lets this
  // through (it can be re-opened — "my machine, for this repo"), so the label
  // has to have a spelling for it rather than silently sharing the local
  // window's.
  return { tag: "m", id: "any" };
}
