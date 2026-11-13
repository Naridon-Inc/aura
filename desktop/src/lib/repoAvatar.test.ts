import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";

import {
  REPO_ICON_PATHS,
  chooseRepoIcon,
  chosenRepoIcon,
  githubOwnerOf,
  isRepoIconChoice,
  iconMediaType,
  ownerAvatarUrl,
  repoPictureFor,
  requestRepoPicture,
  resetRepoAvatars,
  setRepoAvatarTransport,
  subscribeRepoAvatars,
  type RepoAvatarTransport,
} from "./repoAvatar";

describe("githubOwnerOf", () => {
  test("reads the owner from every spelling git writes for github.com", () => {
    for (const url of [
      "https://github.com/Naridon-Inc/aura.git",
      "https://github.com/Naridon-Inc/aura",
      "https://github.com/Naridon-Inc/aura/",
      "https://x-access-token:secret@github.com/Naridon-Inc/aura.git",
      "git@github.com:Naridon-Inc/aura.git",
      "git@github.com:Naridon-Inc/aura",
      "ssh://git@github.com/Naridon-Inc/aura.git",
      "ssh://git@github.com:22/Naridon-Inc/aura.git",
      "github.com/Naridon-Inc/aura",
      "  https://GitHub.com/Naridon-Inc/aura.git\n",
    ]) {
      expect(githubOwnerOf(url)).toBe("Naridon-Inc");
    }
  });

  test("has no owner off github.com", () => {
    for (const url of [
      "https://gitlab.com/group/repo.git",
      "git@bitbucket.org:team/repo.git",
      "https://github.com.example.net/o/r.git",
      "https://example.net/github.com/o/r",
      "git@github.example.com:o/r.git",
      "/Users/me/src/repo",
      "../sibling",
    ]) {
      expect(githubOwnerOf(url)).toBeNull();
    }
  });

  test("has no owner for a URL that is not a repository", () => {
    for (const url of [
      "",
      "   ",
      "https://github.com/",
      "https://github.com/onlyowner",
      "https://github.com/o/r/tree/main",
      "https://github.com/-bad/r",
      "https://github.com/bad--/r",
    ]) {
      expect(githubOwnerOf(url)).toBeNull();
    }
  });

  test("reads nothing out of a value that is not a string", () => {
    for (const v of [undefined, null, 42, [], {}]) {
      expect(githubOwnerOf(v)).toBeNull();
    }
  });
});

describe("ownerAvatarUrl / iconMediaType", () => {
  test("asks GitHub for a 64px face", () => {
    expect(ownerAvatarUrl("MHASK")).toBe("https://github.com/MHASK.png?size=64");
  });

  test("names the image type by extension", () => {
    expect(iconMediaType("public/favicon.svg")).toBe("image/svg+xml");
    expect(iconMediaType("favicon.ico")).toBe("image/x-icon");
    expect(iconMediaType("logo.PNG")).toBe("image/png");
    expect(iconMediaType("a.jpeg")).toBe("image/jpeg");
    expect(iconMediaType("a.webp")).toBe("image/webp");
    expect(iconMediaType("a.gif")).toBe("image/gif");
    expect(iconMediaType("no-extension")).toBe("image/png");
  });

  test("looks in the conventional places, apple-touch-icon first", () => {
    expect(REPO_ICON_PATHS[0]).toBe("public/apple-touch-icon.png");
    expect(REPO_ICON_PATHS).toContain("src-tauri/icons/icon.png");
    expect(REPO_ICON_PATHS.length).toBe(28);
    expect(new Set(REPO_ICON_PATHS).size).toBe(REPO_ICON_PATHS.length);
  });
});

type Fake = RepoAvatarTransport & { reads: string[]; origins: string[] };

function fake(opts: {
  origin?: string;
  files?: Record<string, string>;
  remote?: boolean;
}): Fake {
  const reads: string[] = [];
  const origins: string[] = [];
  return {
    reads,
    origins,
    origin: async (root) => {
      origins.push(root);
      return opts.origin ?? "";
    },
    readBase64: async (path) => {
      reads.push(path);
      const hit = opts.files?.[path];
      if (hit === undefined) throw new Error("No such file or directory");
      return hit;
    },
    isRemote: () => opts.remote ?? false,
    scope: (root) => root,
  };
}

async function settle(): Promise<void> {
  for (let i = 0; i < 40; i++) await Promise.resolve();
}

// The store remembers owners and picked icons in localStorage. Another test
// file may have installed one for the whole run, so these tests bring their
// own empty one for every case and put the original back afterwards.
class MemoryStorage {
  private items = new Map<string, string>();
  getItem(key: string): string | null {
    return this.items.get(key) ?? null;
  }
  setItem(key: string, value: string): void {
    this.items.set(key, String(value));
  }
  removeItem(key: string): void {
    this.items.delete(key);
  }
  clear(): void {
    this.items.clear();
  }
}

const original = Object.getOwnPropertyDescriptor(globalThis, "localStorage");
let storage = new MemoryStorage();

beforeAll(() => {
  Object.defineProperty(globalThis, "localStorage", {
    configurable: true,
    get: () => storage,
  });
});

afterAll(() => {
  if (original) Object.defineProperty(globalThis, "localStorage", original);
  else delete (globalThis as { localStorage?: unknown }).localStorage;
  setRepoAvatarTransport(null);
  resetRepoAvatars();
});

beforeEach(() => {
  storage = new MemoryStorage();
  setRepoAvatarTransport(null);
  resetRepoAvatars();
});

describe("the repository picture store", () => {
  afterEach(() => setRepoAvatarTransport(null));

  test("knows nothing before anyone asks", () => {
    expect(repoPictureFor("/r")).toEqual({ icon: null, avatar: null });
    expect(repoPictureFor(null)).toEqual({ icon: null, avatar: null });
  });

  test("finds the owner's face and the first icon file that exists", async () => {
    const t = fake({
      origin: "git@github.com:MHASK/aura-sovereign.git",
      files: { "/r/logo.svg": "PHN2Zz4=", "/r/icon.png": "iVBOR" },
    });
    setRepoAvatarTransport(t);
    let heard = 0;
    const off = subscribeRepoAvatars(() => heard++);
    requestRepoPicture("/r/");
    await settle();
    off();
    const pic = repoPictureFor("/r/");
    expect(pic.avatar).toBe("https://github.com/MHASK.png?size=64");
    expect(pic.icon).toBe("data:image/svg+xml;base64,PHN2Zz4=");
    // It stopped at the first hit, in the listed order.
    expect(t.reads.at(-1)).toBe("/r/logo.svg");
    expect(t.reads).toEqual(
      REPO_ICON_PATHS.slice(0, REPO_ICON_PATHS.indexOf("logo.svg") + 1).map((p) => `/r/${p}`),
    );
    expect(heard).toBeGreaterThan(0);
  });

  test("asks once per repository however many rows ask", async () => {
    const t = fake({ origin: "https://github.com/o/r" });
    setRepoAvatarTransport(t);
    for (let i = 0; i < 5; i++) requestRepoPicture("/r");
    await settle();
    requestRepoPicture("/r");
    await settle();
    expect(t.origins).toEqual(["/r"]);
    expect(t.reads.length).toBe(REPO_ICON_PATHS.length);
  });

  test("a repository with no GitHub remote and no icon stays empty", async () => {
    const t = fake({ origin: "https://gitlab.com/g/r.git" });
    setRepoAvatarTransport(t);
    requestRepoPicture("/r");
    await settle();
    expect(repoPictureFor("/r")).toEqual({ icon: null, avatar: null });
  });

  test("a checkout on another machine is not scanned from here", async () => {
    const t = fake({ origin: "https://github.com/o/r", remote: true });
    setRepoAvatarTransport(t);
    requestRepoPicture("/r");
    await settle();
    expect(t.reads).toEqual([]);
    expect(repoPictureFor("/r").avatar).toBe("https://github.com/o.png?size=64");
  });

  test("a git that cannot answer leaves the fallback in place", async () => {
    setRepoAvatarTransport({
      origin: async () => {
        throw new Error("not a git repository");
      },
      readBase64: async () => null,
      isRemote: () => false,
      scope: (root) => root,
    });
    requestRepoPicture("/r");
    await settle();
    expect(repoPictureFor("/r")).toEqual({ icon: null, avatar: null });
  });

  test("the same answer is the same object, so readers do not re-render", async () => {
    setRepoAvatarTransport(fake({ origin: "https://github.com/o/r" }));
    requestRepoPicture("/r");
    await settle();
    expect(repoPictureFor("/r")).toBe(repoPictureFor("/r"));
  });

  test("asks nothing without a transport or a root", async () => {
    requestRepoPicture("/r");
    requestRepoPicture(null);
    await settle();
    expect(repoPictureFor("/r")).toEqual({ icon: null, avatar: null });
  });
});

describe("remembered owners", () => {
  test("a known owner paints on the first frame after a restart", async () => {
    setRepoAvatarTransport(fake({ origin: "https://github.com/o/r" }));
    requestRepoPicture("/r");
    await settle();
    // A new run: memory gone, storage kept.
    setRepoAvatarTransport(null);
    resetRepoAvatars();
    expect(repoPictureFor("/r").avatar).toBe("https://github.com/o.png?size=64");
  });
});

describe("the picked icon", () => {
  test("keeps a named icon or an image, and forgets on null", () => {
    let heard = 0;
    const off = subscribeRepoAvatars(() => heard++);
    expect(chosenRepoIcon("/r")).toBeNull();
    expect(chooseRepoIcon("/r", "rocket")).toBe(true);
    expect(chosenRepoIcon("/r")).toBe("rocket");
    expect(chooseRepoIcon("/r", "data:image/png;base64,iVBOR")).toBe(true);
    expect(chosenRepoIcon("/r")).toBe("data:image/png;base64,iVBOR");
    expect(chooseRepoIcon("/r", null)).toBe(true);
    expect(chosenRepoIcon("/r")).toBeNull();
    off();
    expect(heard).toBe(3);
  });

  test("survives a restart", () => {
    chooseRepoIcon("/r", "anchor");
    resetRepoAvatars();
    expect(chosenRepoIcon("/r")).toBe("anchor");
  });

  test("refuses what is not an icon", () => {
    for (const v of ["", "Rocket", "../x", "javascript:alert(1)", "data:text/html,<b>", 7, null]) {
      expect(isRepoIconChoice(v)).toBe(false);
    }
    expect(isRepoIconChoice(`data:image/png;base64,${"A".repeat(600 * 1024)}`)).toBe(false);
    expect(chooseRepoIcon("/r", "Not A Name")).toBe(false);
    expect(chosenRepoIcon("/r")).toBeNull();
  });
});
