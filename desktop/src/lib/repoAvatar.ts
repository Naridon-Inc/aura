// The picture a repository wears in the list, the header, the pickers and the
// palette, in place of a folder.
//
// Two pictures can be found for a repository, and a caller shows the first one
// that loads:
//   1. the repository's own icon, a file in the checkout (an apple-touch-icon,
//      a favicon, a logo, the desktop app's icon) read once and held as a
//      `data:` URL;
//   2. the face of whoever owns it on GitHub, `https://github.com/<owner>.png`,
//      which GitHub serves for people and organisations alike with no login.
// A user-picked emoji outranks both, and the folder stays as the last resort;
// that ordering lives in `components/ui/repo-avatar.tsx`.
//
// This file decides *when* to look, and is free of React and Tauri so its
// rules can be tested directly:
//   - one look per repository per run, however many rows ask at once;
//   - nothing blocks a paint: a reader gets what is known this instant;
//   - a checkout standing in another machine is not scanned from here, only
//     its origin is read (through the same place-aware call every other git
//     question uses).
// The owner is also kept in localStorage, so a known repository shows its
// face on the first frame after a restart while the run re-checks it.

/** Where the store gets its answers. Injected so tests can count calls and so
 *  nothing in this file reaches git or the disk by itself. */
export type RepoAvatarTransport = {
  /** The repository's `origin` URL, or "" when it has none. */
  origin: (root: string) => Promise<string>;
  /** The file's bytes as standard base64, or null when there is no such file. */
  readBase64: (path: string) => Promise<string | null>;
  /** True when this root is a checkout on another machine right now. */
  isRemote: (root: string) => boolean;
  /** The cache key for this root: one root is a different checkout on each
   *  machine it is opened on. */
  scope: (root: string) => string;
};

export type RepoPicture = {
  /** The repository's own icon file, as a `data:` URL. */
  icon: string | null;
  /** The GitHub owner's avatar URL. */
  avatar: string | null;
};

/** Where a repository usually keeps its icon, best first. The first file that
 *  exists wins. */
export const REPO_ICON_PATHS: readonly string[] = [
  "public/apple-touch-icon.png",
  "apple-touch-icon.png",
  "public/favicon.svg",
  "public/logo.svg",
  "favicon.svg",
  "logo.svg",
  "icon.svg",
  "public/favicon.png",
  "public/icon.png",
  "public/logo.png",
  "favicon.png",
  "logo.png",
  "icon.png",
  "app/icon.png",
  "src/app/icon.png",
  ".github/logo.png",
  ".github/logo.svg",
  "public/favicon.ico",
  "favicon.ico",
  "app/favicon.ico",
  "static/favicon.ico",
  "static/favicon.png",
  "static/favicon.svg",
  "assets/favicon.ico",
  "assets/favicon.png",
  "assets/icon.png",
  "src-tauri/icons/icon.png",
  "src/assets/icon.png",
];

/** The image type for an icon file, by its extension. */
export function iconMediaType(path: string): string {
  const ext = (/\.([A-Za-z0-9]+)$/.exec(path)?.[1] ?? "").toLowerCase();
  switch (ext) {
    case "png":
      return "image/png";
    case "jpg":
    case "jpeg":
      return "image/jpeg";
    case "svg":
      return "image/svg+xml";
    case "ico":
      return "image/x-icon";
    case "gif":
      return "image/gif";
    case "webp":
      return "image/webp";
    default:
      return "image/png";
  }
}

/** One GitHub login: letters, digits and single hyphens, never at the ends. */
const LOGIN = /^[A-Za-z0-9](?:[A-Za-z0-9]|-(?=[A-Za-z0-9])){0,38}$/;

/** The GitHub owner an `origin` URL points at, or null when the remote is not
 *  on github.com. Reads every spelling git writes (`https://`, `ssh://`,
 *  `git@github.com:owner/repo`, with or without `.git` or a login in the URL).
 *  The host must be github.com itself; a look-alike host or another forge has
 *  no avatar at that address. */
export function githubOwnerOf(url: unknown): string | null {
  if (typeof url !== "string") return null;
  const text = url.trim();
  if (!text) return null;
  let host: string;
  let path: string;
  const scheme = /^[A-Za-z][A-Za-z0-9+.-]*:\/\/(?:[^/@\s]*@)?([^/:\s]+)(?::\d+)?\/(.*)$/.exec(text);
  const scp = /^(?:[^/@\s]+@)?([^/:\s]+):(?!\/)(.*)$/.exec(text);
  const bare = /^([^/\s:@]+)\/(.*)$/.exec(text);
  if (scheme) {
    host = scheme[1] ?? "";
    path = scheme[2] ?? "";
  } else if (scp) {
    host = scp[1] ?? "";
    path = scp[2] ?? "";
  } else if (bare) {
    host = bare[1] ?? "";
    path = bare[2] ?? "";
  } else {
    return null;
  }
  const h = host.toLowerCase();
  if (h !== "github.com" && h !== "www.github.com") return null;
  const parts = path.replace(/\/+$/, "").split("/");
  if (parts.length !== 2) return null;
  const owner = parts[0] ?? "";
  const repo = (parts[1] ?? "").replace(/\.git$/, "");
  if (!LOGIN.test(owner) || !repo) return null;
  return owner;
}

/** The owner's avatar. 64px covers a 16–32px slot at 2x. */
export function ownerAvatarUrl(owner: string): string {
  return `https://github.com/${encodeURIComponent(owner)}.png?size=64`;
}

// ---- remembered owners (one device, survives a restart) -------------------

const OWNERS_KEY = "aura.repoAvatars";

type OwnerBook = Record<string, { owner: string | null }>;

function readOwners(): OwnerBook {
  try {
    const raw = globalThis.localStorage?.getItem(OWNERS_KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw) as unknown;
    return parsed && typeof parsed === "object" ? (parsed as OwnerBook) : {};
  } catch {
    return {};
  }
}

function writeOwner(key: string, owner: string | null): void {
  try {
    const book = readOwners();
    if ((book[key]?.owner ?? null) === owner && key in book) return;
    book[key] = { owner };
    globalThis.localStorage?.setItem(OWNERS_KEY, JSON.stringify(book));
  } catch {
    /* storage blocked or full: the run still has it in memory */
  }
}

// ---- the icon a person picked (one device) ---------------------------------
//
// A picked icon outranks the repository's file and its owner's face. It is
// either one of the named icons (`components/repo-icon/repoIconSet.ts`) or an
// uploaded image already shrunk to icon size, as a `data:image/` URL. A picked
// emoji is not kept here: it lives with the rest of a repository's look in
// `workspaceCustomization.ts`, which the sidebar already reads.

const CHOSEN_KEY = "aura.repoIcons";
/** An uploaded icon is shrunk to 128px before it is kept; anything far past
 *  that is not an icon and would crowd out the rest of local storage. */
const MAX_CHOSEN_IMAGE = 512 * 1024;
const NAMED = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

/** Whether a value is something the picker can keep: a named icon or an image
 *  `data:` URL of icon size. */
export function isRepoIconChoice(value: unknown): value is string {
  if (typeof value !== "string") return false;
  if (value.startsWith("data:image/")) return value.length <= MAX_CHOSEN_IMAGE;
  return NAMED.test(value);
}

let chosen: Record<string, string> | null = null;

function chosenBook(): Record<string, string> {
  if (chosen) return chosen;
  const book: Record<string, string> = {};
  try {
    const raw = globalThis.localStorage?.getItem(CHOSEN_KEY);
    const parsed = raw ? (JSON.parse(raw) as unknown) : null;
    if (parsed && typeof parsed === "object") {
      for (const [root, value] of Object.entries(parsed as Record<string, unknown>)) {
        if (isRepoIconChoice(value)) book[root] = value;
      }
    }
  } catch {
    /* unreadable: start empty */
  }
  chosen = book;
  return book;
}

/** The icon picked for this repository root, or null for "automatic". */
export function chosenRepoIcon(root: string | null | undefined): string | null {
  if (!root) return null;
  return chosenBook()[root] ?? null;
}

/** Keep (or with null, forget) the icon picked for this repository root.
 *  Returns false when the value is not one the picker can keep, or storage
 *  refused it; nothing changes then. */
export function chooseRepoIcon(root: string, value: string | null): boolean {
  if (!root) return false;
  if (value !== null && !isRepoIconChoice(value)) return false;
  const next = { ...chosenBook() };
  if (value === null) delete next[root];
  else next[root] = value;
  try {
    globalThis.localStorage?.setItem(CHOSEN_KEY, JSON.stringify(next));
  } catch {
    return false;
  }
  chosen = next;
  emit();
  return true;
}

// ---- the store ------------------------------------------------------------

const EMPTY: RepoPicture = Object.freeze({ icon: null, avatar: null });

/** Scope -> what is known. Each value is replaced, never mutated, so a reader
 *  comparing snapshots sees a change exactly when something arrived. */
const pictures = new Map<string, RepoPicture>();
/** Scopes looked at (or being looked at) this run. Never asked again. */
const asked = new Set<string>();
const listeners = new Set<() => void>();
let transport: RepoAvatarTransport | null = null;
let seeded = false;

/** Point the store at git and the disk. Called once by the React binding;
 *  tests pass a fake. */
export function setRepoAvatarTransport(next: RepoAvatarTransport | null): void {
  transport = next;
}

/** Forget everything learned this run. Tests only. */
export function resetRepoAvatars(): void {
  pictures.clear();
  asked.clear();
  seeded = false;
  chosen = null;
  emit();
}

function emit(): void {
  for (const fn of listeners) fn();
}

/** Watch for pictures arriving. Returns the unsubscribe. */
export function subscribeRepoAvatars(fn: () => void): () => void {
  listeners.add(fn);
  return () => {
    listeners.delete(fn);
  };
}

function seedOnce(): void {
  if (seeded) return;
  seeded = true;
  for (const [key, entry] of Object.entries(readOwners())) {
    const owner = typeof entry?.owner === "string" ? entry.owner : null;
    if (owner && LOGIN.test(owner) && !pictures.has(key)) {
      pictures.set(key, { icon: null, avatar: ownerAvatarUrl(owner) });
    }
  }
}

function patch(key: string, next: Partial<RepoPicture>): void {
  const prev = pictures.get(key) ?? EMPTY;
  const icon = next.icon === undefined ? prev.icon : next.icon;
  const avatar = next.avatar === undefined ? prev.avatar : next.avatar;
  if (icon === prev.icon && avatar === prev.avatar) return;
  pictures.set(key, { icon, avatar });
  emit();
}

/** The cache key for a root, through the transport when one is bound. */
export function repoAvatarKey(root: string): string {
  return transport ? transport.scope(root) : root;
}

/** What is known for this root right now. Synchronous; the same object comes
 *  back until something new arrives. */
export function repoPictureFor(root: string | null | undefined): RepoPicture {
  if (!root) return EMPTY;
  seedOnce();
  return pictures.get(repoAvatarKey(root)) ?? EMPTY;
}

function joinPath(root: string, rel: string): string {
  return `${root.replace(/[\\/]+$/, "")}/${rel}`;
}

async function findIcon(root: string, source: RepoAvatarTransport): Promise<string | null> {
  for (const rel of REPO_ICON_PATHS) {
    let data: string | null = null;
    try {
      data = await source.readBase64(joinPath(root, rel));
    } catch {
      data = null;
    }
    if (typeof data === "string" && data.length > 0) {
      return `data:${iconMediaType(rel)};base64,${data}`;
    }
  }
  return null;
}

async function findOwner(root: string, source: RepoAvatarTransport): Promise<string | null> {
  try {
    return githubOwnerOf(await source.origin(root));
  } catch {
    return null;
  }
}

/** Look for this root's pictures, if nobody has yet this run. Returns at once;
 *  the answers land through `subscribeRepoAvatars`. */
export function requestRepoPicture(root: string | null | undefined): void {
  if (!root) return;
  const source = transport;
  if (!source) return;
  seedOnce();
  const key = source.scope(root);
  if (asked.has(key)) return;
  asked.add(key);

  void findOwner(root, source).then((owner) => {
    writeOwner(key, owner);
    patch(key, { avatar: owner ? ownerAvatarUrl(owner) : null });
  });
  if (!source.isRemote(root)) {
    void findIcon(root, source).then((icon) => patch(key, { icon }));
  }
}
