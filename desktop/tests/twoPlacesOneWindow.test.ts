// Two chats, two places, one window.
//
//   bun test
//
// A window can now be in several places at once: this laptop, plus every
// machine you walked into. That was the previous change. This one is about the
// doors — ⌘N, the launcher, the HUD composer, `/launch`, a background job, an
// agent CLI — and the question none of them used to ask.
//
// The question is "where does this run?", and the old answer was always "here",
// silently. You could stand in a box with its files on screen, press ⌘N, and
// get a conversation about your laptop that looked identical to one about the
// machine: same rail, same title, same project name, tools quietly reading the
// wrong disk. Worse, the two chats fought over one pointer. `aura.ambient.<root>`
// is how six surfaces find "the chat about this project", and with a single
// slot per project the second chat evicted the first — so asking for the box's
// conversation handed back the laptop's, or the other way round, depending on
// which you had opened last.
//
// So the place became part of what a chat IS, in three places at once:
//
//   1. the pointer's name (`lib/ambientSession`) — one slot per place, and the
//      local slot keeps its historic spelling so pointers written before this
//      still resolve;
//   2. the birth of the session (`manager_chat_start` takes a machine and seeds
//      `session.machine_id`, and `ManagerSummary` reports it back);
//   3. the doors themselves, every one of which now reads
//      `placeForNewWork(root)` at the moment of the click.
//
// What is run here rather than pinned: `activeMachine` and `ambientSession` are
// pure modules, so the per-project answer and the per-place pointers are real
// behaviour under test. The doors import Tauri and React and cannot be loaded
// under bun, so they are pinned by source — which is the right shape anyway,
// since the bug this file guards against is a NEW door forgetting to ask.

import { afterEach, beforeAll, describe, expect, test } from "bun:test";

import { readSrc, stripComments } from "./support/code";

// `ambientSession` writes through `localStorage`, which the app has and this
// process does not. Installed before the module is imported, and complete
// rather than a two-method stub: bun runs every test file in ONE process, so a
// half-Storage here is read by whatever a later file imports.
if (typeof (globalThis as { localStorage?: unknown }).localStorage === "undefined") {
  const cells = new Map<string, string>();
  (globalThis as { localStorage: unknown }).localStorage = {
    get length() {
      return cells.size;
    },
    key: (i: number) => [...cells.keys()][i] ?? null,
    getItem: (k: string) => cells.get(k) ?? null,
    setItem: (k: string, v: string) => void cells.set(k, String(v)),
    removeItem: (k: string) => void cells.delete(k),
    clear: () => cells.clear(),
  };
}

const { clearMachines, machineIdForRoot, syncMachines } = await import(
  "../src/lib/activeMachine"
);
const {
  ambientKey,
  placeForNewWork,
  readAmbientSid,
  samePlace,
  writeAmbientSid,
} = await import("../src/lib/ambientSession");

/** The project, as it is spelled on THIS laptop. Both chats are filed here —
 *  the board, the transcript and the intent log stay on this disk whichever
 *  machine holds the code. */
const PROJECT = "/Users/me/projects/naridon";
/** A second project the same window has open. */
const OTHER_PROJECT = "/Users/me/projects/atlas";
const BOX = "ubuntu@18.196.118.42";
const OTHER_BOX = "ubuntu@3.122.52.150";

afterEach(() => {
  clearMachines();
  localStorage.clear();
});

describe("where a door starts work", () => {
  test("nothing entered means every door runs here", () => {
    expect(placeForNewWork(PROJECT)).toBeNull();
    expect(placeForNewWork(OTHER_PROJECT)).toBeNull();
  });

  test("standing in a box, a door on that project runs on the box", () => {
    syncMachines([{ key: "p1", machineId: BOX, repoRoot: PROJECT }], "p1");
    expect(placeForNewWork(PROJECT)).toBe(BOX);
  });

  test("the answer is per project, not per window", () => {
    // The whole reason this is a function of the root. Standing in a box that
    // holds project A says nothing about where work on project B should run —
    // and the HUD can fire a turn at B while A is what's on screen.
    syncMachines([{ key: "p1", machineId: BOX, repoRoot: PROJECT }], "p1");
    expect(placeForNewWork(PROJECT)).toBe(BOX);
    expect(placeForNewWork(OTHER_PROJECT)).toBeNull();
  });

  test("a place you are holding but not looking at does not claim your clicks", () => {
    // A box left open behind a Trace page is still one click away, but you are
    // not standing in it. Starting something while reading Trace starts it
    // here, which is the only reading that matches what is in front of you.
    syncMachines(
      [
        { key: "p1", machineId: BOX, repoRoot: PROJECT },
        { key: "p2", machineId: OTHER_BOX, repoRoot: OTHER_PROJECT },
      ],
      null,
    );
    expect(placeForNewWork(PROJECT)).toBeNull();
    expect(placeForNewWork(OTHER_PROJECT)).toBeNull();
  });

  test("two boxes, one window: the focused one answers for its own project", () => {
    syncMachines(
      [
        { key: "p1", machineId: BOX, repoRoot: PROJECT },
        { key: "p2", machineId: OTHER_BOX, repoRoot: OTHER_PROJECT },
      ],
      "p2",
    );
    expect(placeForNewWork(OTHER_PROJECT)).toBe(OTHER_BOX);
    // Not `BOX`: you are standing in the second box, and the first box's
    // project is not what this door was pressed on.
    expect(placeForNewWork(PROJECT)).toBeNull();
  });

  test("a trailing slash is the same project", () => {
    syncMachines([{ key: "p1", machineId: BOX, repoRoot: PROJECT }], "p1");
    expect(placeForNewWork(`${PROJECT}/`)).toBe(BOX);
  });
});

describe("two chats about one project, in two places", () => {
  test("each place gets its own pointer", () => {
    writeAmbientSid(PROJECT, null, "chat-on-this-laptop");
    writeAmbientSid(PROJECT, BOX, "chat-on-the-box");

    expect(readAmbientSid(PROJECT, null)).toBe("chat-on-this-laptop");
    expect(readAmbientSid(PROJECT, BOX)).toBe("chat-on-the-box");
  });

  test("starting the box's chat does not evict the laptop's", () => {
    // The bug, stated as a test. One slot per project meant the second chat
    // overwrote the first, so "the chat about this project" answered with
    // whichever you happened to open last.
    writeAmbientSid(PROJECT, null, "chat-on-this-laptop");
    writeAmbientSid(PROJECT, BOX, "chat-on-the-box");
    writeAmbientSid(PROJECT, OTHER_BOX, "chat-on-the-other-box");

    expect(readAmbientSid(PROJECT, null)).toBe("chat-on-this-laptop");
    expect(readAmbientSid(PROJECT, BOX)).toBe("chat-on-the-box");
    expect(readAmbientSid(PROJECT, OTHER_BOX)).toBe("chat-on-the-other-box");
  });

  test("a place with no chat yet has no chat, rather than borrowing one", () => {
    writeAmbientSid(PROJECT, null, "chat-on-this-laptop");
    expect(readAmbientSid(PROJECT, BOX)).toBeNull();
  });

  test("this laptop's pointer keeps the name it has always had", () => {
    // Everyone already has one of these in localStorage. Renaming the local
    // slot would silently lose every conversation in the app on upgrade.
    expect(ambientKey(PROJECT, null)).toBe(`aura.ambient.${PROJECT}`);
    expect(ambientKey(PROJECT, "  ")).toBe(`aura.ambient.${PROJECT}`);
    expect(ambientKey(PROJECT, BOX)).toBe(`aura.ambient.${PROJECT}#${BOX}`);
  });

  test("two projects on one box stay two conversations", () => {
    writeAmbientSid(PROJECT, BOX, "naridon-on-the-box");
    writeAmbientSid(OTHER_PROJECT, BOX, "atlas-on-the-box");
    expect(readAmbientSid(PROJECT, BOX)).toBe("naridon-on-the-box");
    expect(readAmbientSid(OTHER_PROJECT, BOX)).toBe("atlas-on-the-box");
  });

  test("no project is no pointer, not a pointer named undefined", () => {
    expect(readAmbientSid(null, BOX)).toBeNull();
    expect(readAmbientSid(undefined, null)).toBeNull();
  });

  test("no storage at all is a legal answer, not a crash on ⌘N", () => {
    // Private browsing, or a webview that refuses storage. A pointer is a
    // convenience — the door still has to open, with a new chat.
    //
    // Swapped and put back rather than deleted: bun runs every test file in one
    // process, and a global left missing is read by whatever runs next.
    const held = globalThis.localStorage;
    Object.defineProperty(globalThis, "localStorage", {
      configurable: true,
      get() {
        throw new Error("The operation is insecure.");
      },
    });
    try {
      expect(readAmbientSid(PROJECT, BOX)).toBeNull();
      expect(() => writeAmbientSid(PROJECT, BOX, "chat")).not.toThrow();
    } finally {
      Object.defineProperty(globalThis, "localStorage", {
        configurable: true,
        writable: true,
        value: held,
      });
    }
  });
});

describe("is this session still the chat for this place", () => {
  // The predicate `resolveAmbientSession` validates a found pointer with. A
  // pointer that outlived a change of place — same project, different machine —
  // has to be rejected, because the alternative is a chat whose tools edit a
  // different copy of the code than the one on screen.
  test("here is here, however it is spelled", () => {
    // Three spellings reach this: the window's `null`, a backend row that omits
    // `machine_id` entirely, and a form that carried an empty string.
    expect(samePlace(null, null)).toBe(true);
    expect(samePlace(undefined, null)).toBe(true);
    expect(samePlace("", null)).toBe(true);
    expect(samePlace("   ", undefined)).toBe(true);
  });

  test("a box is not this laptop, in either direction", () => {
    expect(samePlace(BOX, null)).toBe(false);
    expect(samePlace(null, BOX)).toBe(false);
  });

  test("one box is not another", () => {
    expect(samePlace(BOX, OTHER_BOX)).toBe(false);
    expect(samePlace(BOX, BOX)).toBe(true);
  });
});

// ── The doors ──────────────────────────────────────────────────────────────
//
// Pinned by source: every one of these imports Tauri or React and cannot be
// loaded in this process. The pin is the right shape regardless — what this
// guards is a door added later that forgets to ask where it runs, and that is
// a fact about the call site rather than about a value.

describe("every entry point names the place it runs in", () => {
  let sources: Record<string, string> = {};

  beforeAll(async () => {
    const files = [
      "App.tsx",
      "components/agent/AgentSurface.tsx",
      "components/cloud/MachineChat.tsx",
      "components/launcher/Launcher.tsx",
      "components/workspace/WorkspaceCreateComposer.tsx",
      "lib/auraJob.ts",
      "lib/chatSlashHandler.ts",
      "lib/focusManager.ts",
      "lib/hudPublisher.tsx",
      "lib/managerStore.ts",
      "lib/managerTurn.ts",
      "lib/orchestratorSession.ts",
      "lib/workspaceChatLaunch.ts",
    ];
    sources = Object.fromEntries(
      await Promise.all(files.map(async (f) => [f, await readSrc(f)] as const)),
    );
  });

  test("no chat is started without a place beside it", () => {
    // `managerChatStart(root, prompt)` — two arguments and nothing else — is
    // the old shape, and the one that always ran here.
    for (const [file, src] of Object.entries(sources)) {
      for (const call of src.match(/managerChatStart\([\s\S]{0,200}?\)/g) ?? []) {
        const args = call.slice("managerChatStart(".length, -1);
        expect(
          args.split(",").length,
          `${file} starts a chat without saying where it runs: ${call}`,
        ).toBeGreaterThanOrEqual(3);
      }
    }
  });

  test("the doors that follow the window read it at the click", () => {
    // Not a constant, and not read at module load: where the window is standing
    // is what the user was looking at when they pressed the key.
    for (const file of [
      "App.tsx",
      "components/launcher/Launcher.tsx",
      "lib/auraJob.ts",
      "lib/chatSlashHandler.ts",
    ]) {
      expect(sources[file], file).toContain("placeForNewWork(");
    }

    // The New-workspace dialog is the one door that does better than inferring:
    // it ASKS. Reading the window would be a downgrade there — you can be
    // standing on this laptop and want the copy made on a box — so the gate on
    // it is that the answer is carried, not that the window is read.
    const composer = sources["components/workspace/WorkspaceCreateComposer.tsx"]!;
    expect(composer).toContain("<WherePicker places={where} />");
    expect(composer).toContain("const machineId = where.chosen.machineId;");
  });

  test("the agent picker starts the CLI where the chat would have started", () => {
    // One door, two branches: pick Aura and you get a chat, pick Claude and you
    // get a CLI. They stand in the same place, so they have to ask the same
    // question — the branch that starts a process was the one still assuming
    // this laptop.
    const src = sources["App.tsx"]!;
    expect(src).toContain("const ptyPlace = placeForNewWork(root)");
    const call = src.match(/agentPtyOpen\([\s\S]*?ptyPlace,\n {10}\)/)?.[0] ?? "";
    expect(call, "the picker's CLI branch does not name its place").toContain(
      "ptyPlace",
    );
    // And the tab remembers it — an agent tab whose place is unrecorded is one
    // that Restart will move to another computer.
    expect(src).toContain("machineId: ptyPlace");
  });

  test("reopening an agent goes back to where it was, not to where you are", () => {
    // Resume a dead PTY, Restart, "Start all": every one of these hands the
    // agent a NEW session id for work that is already somewhere. Reading the
    // window there would answer a question nobody asked — and a session held
    // under tmux on a box is still running, still costing, and would be
    // abandoned rather than rejoined.
    const src = sources["components/agent/AgentSurface.tsx"]!;
    const opens = src.match(/agentPtyOpen\([\s\S]{0,400}?\n\s*\);/g) ?? [];
    expect(opens.length, "AgentSurface should still hold three respawn doors")
      .toBe(3);
    for (const call of opens) {
      expect(call, `a respawn door forgets its place: ${call}`).toMatch(
        /\b(tab|t)\.machineId\b/,
      );
    }
    // None of them may reach for the window — that is the whole distinction.
    expect(src).not.toContain("placeForNewWork");
  });

  test("the two doors that are deliberately local say so by name", () => {
    // A worktree is a directory on this laptop and `workspace_launch` only
    // makes them here; Aura's own control plane reads state on this disk. Both
    // are `null` on purpose, and a named constant is how that survives someone
    // later "fixing" the omission.
    expect(sources["lib/workspaceChatLaunch.ts"]).toContain("WORKTREE_RUNS_HERE");
    expect(sources["lib/orchestratorSession.ts"]).toContain("AURA_RUNS_HERE");
  });

  test("an agent CLI started from the launcher runs where the launcher is", () => {
    const launcher = sources["components/launcher/Launcher.tsx"];
    // The place is read at the click and then used twice — once for the spawn,
    // once for the tab it opens — so the two can't disagree if the user moves
    // between them. That is why this looks for the binding rather than the call
    // spelled inline.
    expect(launcher).toContain("const place = placeForNewWork(spawnRoot)");
    const call = launcher.match(/agentPtyOpen\([\s\S]*?\n {6}\)/)?.[0] ?? "";
    expect(call).toContain("place");
    expect(launcher).toContain("machineId: place");
  });

  test("a workspace carries the place it was asked for in", async () => {
    // It can't be honoured yet — a worktree is local — so the store refuses a
    // named machine in a sentence rather than making the copy on the wrong
    // computer and labelling it as the box's.
    const store = await readSrc("lib/workspaceCreateStore.ts");
    expect(store).toContain("machineId?: string | null");
    expect(store).toContain("req.machineId");
  });

  test("only ambientSession knows how the pointer is spelled", () => {
    // Six surfaces used to build `aura.ambient.<root>` by hand, which is why
    // adding the place to it had to be done in six places or in none. The scan
    // strips comments first: several of these files still describe the key in
    // prose, and an epitaph is not a call site.
    const offenders: string[] = [];
    for (const [file, src] of Object.entries(sources)) {
      if (src.includes("aura.ambient.")) offenders.push(file);
    }
    expect(offenders).toEqual([]);
  });

  test("a turn is resolved and filed at the same place", () => {
    // Read once and passed to both. Reading it twice could straddle a change of
    // focus and file the chat under a place it is not running in.
    const turn = sources["lib/managerTurn.ts"];
    expect(turn).toContain("opts.machineId ?? placeForNewWork(repoRoot)");
    expect(turn).toContain("resolveAmbientSession(repoRoot, trimmed, place)");
    expect(turn).toContain("focusAmbientManager(repoRoot, sid, place)");
    // And a pointer whose session turned out to be running somewhere else is
    // dropped rather than opened.
    expect(turn).toContain("samePlace(session.machine_id, machineId)");
  });
});

describe("the backend the doors are talking to", () => {
  const rust = async (rel: string) =>
    stripComments(await Bun.file(`${import.meta.dir}/../src-tauri/src/${rel}`).text());

  test("a chat is born at a place and reports it back", async () => {
    const src = await rust("cmd_manager.rs");
    expect(src).toContain("machine_id: Option<String>");
    // Without this on the summary, no surface can tell two chats about one
    // project apart, and the dashboard adopts whichever it finds first.
    expect(src).toContain("pub machine_id: Option<String>");
    expect(src).toContain("machine_id: s.machine_id.clone()");
  });

  test("an agent CLI is started at a place too, not only a chat", async () => {
    const src = await rust("cmd_agent_pty.rs");
    expect(src).toContain("machine_id: Option<String>");
    // The place is part of what a session IS, so it is part of the dedup key:
    // the same agent on the same project, one on the box and one here, are two
    // sessions with two sets of hands. Without this the second open re-attaches
    // to the first and the user types into the wrong computer.
    expect(src).toContain("{base_key}@@{m}");
    // Built through the one place contract rather than a second ssh line
    // written here — that is how the local and remote spawns can't drift.
    expect(src).toContain("p.open(&Open::Agent {");
    // And nothing that describes THIS laptop is stamped onto a process that
    // isn't on it: no local MCP config path, no hook scripts, no env.
    expect(src).toContain("if place.is_none() {");
  });

  test("a session can be seeded with more than one project", async () => {
    // Aura's own door spans every project you have open. A conversation that
    // carries one root has to be told about the others every time.
    const src = await rust("cmd_manager.rs");
    expect(src).toContain("projects: Option<Vec<String>>");
    expect(src).toContain("fn project_refs(");
    // The anchor still leads — it is the cwd the tools run in, and every
    // surface that reads `projects.first()` means exactly that.
    expect(src).toContain("std::iter::once(anchor.to_string()).chain(extra)");
  });
});
