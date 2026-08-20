// Spin-off OS windows ("popouts"). A popout is a real second Tauri window
// that loads the same `index.html` with a `?popout=<kind>&root=<repo>` query
// string (plus a per-item discriminator for single-item kinds). `main.tsx`
// reads that query at boot (via `readPopoutParams`) and mounts `PopoutRoot`
// instead of the full `App`, so a popout renders just one surface — a whole
// Tasks board, a single task, or a single PR — without spinning up the whole
// ADE shell. Each detached item "feels like another Aura window with just
// that".
//
// Permissions: `core:webview:allow-create-webview-window` lets the main window
// spawn these; the `popout-*` glob in capabilities/default.json grants each
// popout the same command set (invoke for `tasks_*`, events, drag, close,
// set-always-on-top) as the main window.

import { WebviewWindow } from "@tauri-apps/api/webviewWindow";

import { localPlace, placeRepoRoot, type PlaceRef } from "./placeRef";
import {
  placeFromPopoutQuery,
  placeToPopoutQuery,
  popoutPlaceParts,
} from "./popoutPlace";

// `tasks` = the whole board (a floating portrait list). `task` / `pr` = a
// single item detached into its own window — the granularity the user wants
// ("an individual task, or a PR … not an entire page"). `agent` = a single
// live Claude/agent terminal tab pulled out of its workspace; the PTY lives
// in the Rust backend keyed by session id, so the detached window attaches to
// the same `agent-pty:<sid>` stream (app-global emit) and the in-app tab is
// closed — the session "moves" into its own Aura window. `browser` = a single
// in-app browser tab popped out; the SAME native webview is `reparent`ed under
// the new window (live page intact), and the rail forgets the tab.
// `manager` = a native Aura chat session (orchestrator chat) detached into
// its own window; the session lives in the Rust ManagerRuntime keyed by id,
// so the window hydrates from `manager:<sid>` snapshots exactly like the
// in-app view. Used by "Fork to new workspace".
// `workspace` = a WHOLE PLACE detached into its own OS window. Unlike the
// single-surface kinds above (which mount `PopoutRoot` with one pane), a
// workspace popout boots the FULL Aura shell (`App`) standing in that place —
// it's a second, complete window, with its own tab strip, panes, sidebar and
// chat. `main.tsx` reads `popout=workspace` and mounts `App` with boot
// overrides instead of `PopoutRoot`. The window doesn't touch
// `aura.lastWorkspace`, so closing it leaves the main window where it was.
//
// The place is EITHER of the two kinds (lib/placeRef): this laptop's checkout
// at `root`, or a machine somewhere else — a box you are working on, or a cloud
// conversation that hasn't resolved one yet. A remote place opens a window that
// comes up standing IN that machine, with that machine's own tabs, rather than
// in the local copy of the same repo. `lib/popoutPlace` is the codec both the
// URL and the window label go through.
//
// The parent window KEEPS its copy. Popping out a place is not the hand-over
// that `agent` and `browser` are — those reparent one live thing (a PTY, a
// native webview) that cannot exist in two windows at once, so the in-app tab is
// closed on the way out. A place is not one live thing: the sessions run on the
// box and outlive every window that ever attached, and a second window gets its
// own module scope and therefore its own copy of every store the first one has.
// So nothing is taken from the window you clicked in — it is still standing
// where it was when the new window appears.
export type PopoutKind =
  | "tasks"
  | "task"
  | "pr"
  | "agent"
  | "browser"
  | "manager"
  | "terminal"
  | "workspace";

export interface PopoutSpec {
  kind: PopoutKind;
  /** Repo root the surface is scoped to (data is loaded off disk by root). */
  root: string;
  /** Native window title (also the OS taskbar/Mission-Control label). */
  title?: string;
  /** For kind `task` — the task id to render standalone. */
  taskId?: string;
  /** For kind `pr` — the PR number to render standalone. */
  prNumber?: number;
  /** For kind `agent` — the live PTY session id to attach to. For kind
   *  `manager` — the Manager chat session id to hydrate. */
  sessionId?: string;
  /** For kind `agent` — agent brand id (claude/gemini/…) for the window icon. */
  agentId?: string;
  /** For kind `agent` — friendly agent label for the window chrome. */
  label?: string;
  /** For kind `browser` — the browser tab id whose native webview is reparented. */
  browserId?: string;
  /** For kind `browser` — current URL, so the popout shows the address instantly. */
  url?: string;
  /** For kind `terminal` — the working directory the standalone shell
   *  opens in. Falls back to the repo root when absent. */
  cwd?: string;
  /** For kind `terminal` — a daemon session id to reconnect to (live
   *  process survives), else the window spawns a fresh shell in `cwd`. */
  reconnectId?: string;
  /** For kind `workspace` — WHERE the new window will stand, when that is not
   *  simply this laptop's checkout at `root`. Absent means `localPlace(root)`,
   *  which is what every caller meant before places existed. */
  place?: PlaceRef;
}

/** The place a whole-window popout stands on. One reading of the spec, used by
 *  both the window label and the query string, because two spellings of one
 *  identity is how a window ends up filed under a place it isn't in. Null for
 *  every other kind — they detach a surface, not a place. */
function specPlace(spec: PopoutSpec): PlaceRef | null {
  if (spec.kind !== "workspace") return null;
  return spec.place ?? (spec.root ? localPlace(spec.root) : null);
}

export interface PopoutParams {
  kind: PopoutKind;
  root: string;
  /** Present for kind `task`. */
  taskId?: string;
  /** Present for kind `pr`. */
  prNumber?: number;
  /** Present for kind `agent` (PTY session) and `manager` (chat session). */
  sessionId?: string;
  agentId?: string;
  label?: string;
  /** Present for kind `browser`. */
  browserId?: string;
  url?: string;
  /** Present for kind `terminal`. */
  cwd?: string;
  reconnectId?: string;
  /** Present for kind `workspace` — the place this window stands in. Always
   *  set for that kind (a workspace popout that names nowhere doesn't parse),
   *  and never for any other. */
  place?: PlaceRef;
}

// Portrait for the board (a tall floating list); a single task is a readable
// doc; a PR detail is a wide multi-column diff surface and needs the room.
const DIMS: Record<
  PopoutKind,
  { width: number; height: number; minWidth: number; minHeight: number }
> = {
  tasks: { width: 460, height: 820, minWidth: 360, minHeight: 480 },
  task: { width: 720, height: 800, minWidth: 480, minHeight: 520 },
  pr: { width: 1100, height: 760, minWidth: 720, minHeight: 480 },
  agent: { width: 900, height: 640, minWidth: 480, minHeight: 360 },
  browser: { width: 1100, height: 760, minWidth: 640, minHeight: 420 },
  manager: { width: 820, height: 760, minWidth: 520, minHeight: 480 },
  terminal: { width: 820, height: 520, minWidth: 480, minHeight: 280 },
  // A whole second ADE window — sized like the main shell, not a panel.
  workspace: { width: 1280, height: 820, minWidth: 720, minHeight: 480 },
};

const DEFAULT_TITLE: Record<PopoutKind, string> = {
  tasks: "Aura. Tasks",
  task: "Aura. Task",
  pr: "Aura. PR",
  agent: "Aura. Agent",
  browser: "Aura. Browser",
  manager: "Aura. Chat",
  terminal: "Aura. Terminal",
  workspace: "Aura",
};

/** Reduce arbitrary text to the safe label charset (`[a-z0-9-]`). */
function slugify(s: string, max: number): string {
  return (
    s
      .replace(/[^a-zA-Z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .toLowerCase()
      .slice(-max) || "x"
  );
}

/** The OS window `spec` opens in.
 *
 *  One window per (kind, root, item): re-invoking focuses the existing popout
 *  rather than stacking duplicates, while distinct items each get their own
 *  window. Labels are restricted to a safe charset and must match the
 *  `popout-*` capability glob.
 *
 *  Exported because it is a rule, not an implementation detail: two places that
 *  share a label are one window pretending to be two, and that is worth a test
 *  rather than a comment. */
export function popoutWindowLabel(spec: PopoutSpec): string {
  const place = specPlace(spec);
  // A workspace popout is labelled off its PLACE, not off whatever the caller
  // happened to pass as `root` — a remote place may name no local checkout at
  // all, and the two halves of its identity have to land in the same label the
  // query string is built from.
  const root = slugify(place ? (placeRepoRoot(place) ?? "") : spec.root, 40);
  let item = "";
  if (spec.kind === "task" && spec.taskId) item = `-${slugify(spec.taskId, 24)}`;
  else if (spec.kind === "pr" && spec.prNumber != null) item = `-${spec.prNumber}`;
  else if (spec.kind === "agent" && spec.sessionId) {
    item = `-${slugify(spec.sessionId, 24)}`;
  } else if (spec.kind === "manager" && spec.sessionId) {
    item = `-${slugify(spec.sessionId, 24)}`;
  } else if (spec.kind === "browser" && spec.browserId) {
    item = `-${slugify(spec.browserId, 24)}`;
  } else if (spec.kind === "terminal") {
    // Reconnect targets a specific live session → one window per session.
    // A fresh shell is keyed by its cwd so re-invoking "New Terminal Window"
    // from the same workspace dir focuses the existing one rather than
    // stacking duplicates.
    const disc = spec.reconnectId ?? spec.cwd ?? spec.root;
    item = `-${slugify(disc, 24)}`;
  } else if (place) {
    // Which computer. The project half is already the `root` segment above, so
    // this only has to separate one box from another — and a box from a
    // conversation, which is what the tag is for. Local places add nothing:
    // their root IS their identity, so the label they get is the label every
    // "Open in new window" has always produced.
    const parts = popoutPlaceParts(place);
    if (parts) item = `-${parts.tag}-${slugify(parts.id, 28)}`;
  }
  return `popout-${spec.kind}-${root}${item}`;
}

/** What the new window is told about itself, on its own URL.
 *
 *  Exported for the same reason the label is: the round trip through here and
 *  back out of `readPopoutParams` is the whole of "the window carries its own
 *  place", and it is testable without a webview. */
export function popoutQuery(spec: PopoutSpec): URLSearchParams {
  const params = new URLSearchParams({ popout: spec.kind, root: spec.root });
  if (spec.kind === "task" && spec.taskId) params.set("taskId", spec.taskId);
  if (spec.kind === "pr" && spec.prNumber != null) {
    params.set("prNumber", String(spec.prNumber));
  }
  if (spec.kind === "agent" && spec.sessionId) {
    params.set("sessionId", spec.sessionId);
    if (spec.agentId) params.set("agentId", spec.agentId);
    if (spec.label) params.set("label", spec.label);
  }
  if (spec.kind === "manager" && spec.sessionId) {
    params.set("sessionId", spec.sessionId);
    if (spec.label) params.set("label", spec.label);
  }
  if (spec.kind === "browser" && spec.browserId) {
    params.set("browserId", spec.browserId);
    if (spec.url) params.set("url", spec.url);
  }
  if (spec.kind === "terminal") {
    if (spec.cwd) params.set("cwd", spec.cwd);
    if (spec.reconnectId) params.set("reconnectId", spec.reconnectId);
    if (spec.label) params.set("label", spec.label);
  }
  // The place, last, so its `root` is the one that survives: a workspace popout
  // is defined by where it stands, and a caller that passed a root and a place
  // that disagree gets the place. (They agree for every local caller — the
  // place IS `localPlace(root)`.)
  const place = specPlace(spec);
  if (place) {
    for (const [k, v] of Object.entries(placeToPopoutQuery(place))) {
      params.set(k, v);
    }
  }
  return params;
}

export async function openPopout(spec: PopoutSpec): Promise<void> {
  const label = popoutWindowLabel(spec);

  const existing = await WebviewWindow.getByLabel(label);
  if (existing) {
    await existing.setFocus().catch(() => {});
    return;
  }

  const dims = DIMS[spec.kind];
  const params = popoutQuery(spec);

  const win = new WebviewWindow(label, {
    url: `index.html?${params.toString()}`,
    title: spec.title ?? DEFAULT_TITLE[spec.kind],
    width: dims.width,
    height: dims.height,
    minWidth: dims.minWidth,
    minHeight: dims.minHeight,
    resizable: true,
    focus: true,
    // Match the main window's chrome: native traffic lights overlaid on a
    // hidden title bar, app draws its own slim popout-bar underneath.
    titleBarStyle: "overlay",
    hiddenTitle: true,
  });

  win.once("tauri://error", (e) => {
    // Surface failures in the console rather than swallowing them — a missing
    // permission or bad label is the likely cause.
    console.error(`[popout] failed to open ${label}:`, e.payload);
  });
}

/** Parse the popout query off the current window's URL. Returns null for the
 *  main window (no `?popout=` param), which is the signal to mount `App`. */
export function readPopoutParams(): PopoutParams | null {
  try {
    const q = new URLSearchParams(window.location.search);
    const kind = q.get("popout");
    // A whole-workspace popout carries a PLACE, and a place is not always a
    // path: a machine entered from the fleet or from a cloud conversation has
    // no local checkout to name. So this kind is read before the shared `root`
    // guard below — which every other kind still needs, because they load their
    // data off disk by root and have nothing to show without one.
    if (kind === "workspace") {
      const place = placeFromPopoutQuery(q);
      if (!place) return null;
      return { kind, root: placeRepoRoot(place) ?? "", place };
    }
    const root = q.get("root");
    if (!root) return null;
    if (kind === "tasks") return { kind, root };
    if (kind === "task") {
      const taskId = q.get("taskId");
      if (taskId) return { kind, root, taskId };
      return null;
    }
    if (kind === "pr") {
      const raw = q.get("prNumber");
      const prNumber = raw != null ? Number(raw) : NaN;
      if (Number.isFinite(prNumber)) return { kind, root, prNumber };
      return null;
    }
    if (kind === "agent") {
      const sessionId = q.get("sessionId");
      if (sessionId) {
        return {
          kind,
          root,
          sessionId,
          agentId: q.get("agentId") ?? undefined,
          label: q.get("label") ?? undefined,
        };
      }
      return null;
    }
    if (kind === "manager") {
      const sessionId = q.get("sessionId");
      if (sessionId) {
        return { kind, root, sessionId, label: q.get("label") ?? undefined };
      }
      return null;
    }
    if (kind === "browser") {
      const browserId = q.get("browserId");
      if (browserId) {
        return { kind, root, browserId, url: q.get("url") ?? undefined };
      }
      return null;
    }
    if (kind === "terminal") {
      return {
        kind,
        root,
        cwd: q.get("cwd") ?? undefined,
        reconnectId: q.get("reconnectId") ?? undefined,
        label: q.get("label") ?? undefined,
      };
    }
    return null;
  } catch {
    return null;
  }
}
