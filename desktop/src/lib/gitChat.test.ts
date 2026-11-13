import { describe, expect, test } from "bun:test";

import { isGitChatSending, startGitChat, type GitChatDeps } from "./gitChat";
import { gitChatFor } from "./gitChatPrompts";

function deps(over: Partial<GitChatDeps> = {}) {
  const calls: string[] = [];
  const d: GitChatDeps = {
    start: async (_root, title) => {
      calls.push(`start:${title}`);
      return "s1";
    },
    open: (sid, label) => calls.push(`open:${sid}:${label}`),
    send: async (_root, text, sid) => {
      calls.push(`send:${sid}:${text}`);
    },
    fail: (title, detail) => calls.push(`fail:${title}:${detail}`),
    ...over,
  };
  return { d, calls };
}

describe("startGitChat", () => {
  test("opens a new chat titled for the action, then sends its message there", async () => {
    const { d, calls } = deps();
    const chat = gitChatFor({ action: "commit-push" });
    const sid = await startGitChat({ repoRoot: "/r", id: "commit", chat }, d);
    expect(sid).toBe("s1");
    expect(calls).toEqual([
      "start:Commit and push all changes",
      "open:s1:Commit and push all changes",
      "send:s1:Commit and push all changes",
    ]);
  });

  test("busy while the message goes out; a second press does nothing", async () => {
    let release: () => void = () => {};
    const gate = new Promise<void>((r) => (release = r));
    const { d, calls } = deps({ send: () => gate });
    const chat = gitChatFor({ action: "resolve-incompatible" });
    const first = startGitChat({ repoRoot: "/r", id: "incompatible", chat }, d);
    await Promise.resolve();
    await Promise.resolve();
    expect(isGitChatSending("/r", "incompatible")).toBe(true);
    expect(await startGitChat({ repoRoot: "/r", id: "incompatible", chat }, d)).toBeNull();
    release();
    await first;
    expect(isGitChatSending("/r", "incompatible")).toBe(false);
    expect(calls.filter((c) => c.startsWith("start:"))).toHaveLength(1);
  });

  test("a failed send says so in the action's words", async () => {
    const { d, calls } = deps({
      send: async () => {
        throw new Error("no brain");
      },
    });
    const chat = gitChatFor({ action: "create-pr", branch: "b", remote: "origin", target: "main", draft: false });
    expect(await startGitChat({ repoRoot: "/r", id: "create-pr", chat }, d)).toBeNull();
    expect(calls.at(-1)).toBe("fail:Failed to create PR:no brain");
    expect(isGitChatSending("/r", "create-pr")).toBe(false);
  });
});

describe("a chat built when pressed", () => {
  test("is built once, after the busy flag is up", async () => {
    const { d, calls } = deps();
    let built = 0;
    const chat = async () => {
      built += 1;
      return gitChatFor({ action: "resolve-incompatible" });
    };
    const first = startGitChat({ repoRoot: "/r", id: "built", chat }, d);
    const second = await startGitChat({ repoRoot: "/r", id: "built", chat }, d);
    expect(second).toBeNull();
    expect(await first).toBe("s1");
    expect(built).toBe(1);
    expect(calls[0]).toBe("start:Resolve branch incompatibility with remote");
  });

  test("a build that fails says so and frees the button", async () => {
    const { d, calls } = deps();
    const chat = async () => Promise.reject(new Error("settings unreadable"));
    expect(await startGitChat({ repoRoot: "/r", id: "broken", chat }, d)).toBeNull();
    expect(calls).toEqual(["fail:Couldn't start the chat:settings unreadable"]);
    expect(isGitChatSending("/r", "broken")).toBe(false);
  });
});
