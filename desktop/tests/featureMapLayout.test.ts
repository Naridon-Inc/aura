// Feature Map — the geometry and the words, checked without a DOM.
//
//   bun test tests/featureMapLayout.test.ts
//
// The map is a single canvas that unfolds in place: open a feature and its
// flow rows push the features below it down; open a flow and its diagram
// widens that column so the next area column slides right. If either of
// those stops holding, blocks overlap and the reader sees text on text —
// the exact "overflowing, AI slop" complaint the redesign answered. So the
// invariants are pinned here, along with the status rule (a flow is only
// "proved" or "stops short" when a prover run said so) and the copy that
// non-engineers read.

import { describe, expect, test } from "bun:test";

import type { KgFeatureMap, KgFlow, KgFlowMap, KgFlowStep } from "../src/lib/api";
import {
  COL_W,
  G,
  T,
  fitScale,
  layoutFlow,
  layoutTree,
  rounded,
  wrap,
} from "../src/components/workpanes/featureMap/layout";
import {
  buildModel,
  flowStatus,
  needsALook,
  relativeTime,
  statusCopy,
  tallyChips,
  whereLabel,
} from "../src/components/workpanes/featureMap/model";

const NOW = 1_800_000_000;
const DAY = 86_400;

function step(over: Partial<KgFlowStep> = {}): KgFlowStep {
  return {
    node_id: "n",
    name: "send_turn",
    text: "Send the turn to the brain",
    file: "aura-shell/src-tauri/src/chat.rs",
    line: 42,
    where: "engine",
    doc: null,
    canonical: true,
    also_calls: [],
    also_calls_total: 0,
    changed: null,
    feature: null,
    ...over,
  };
}

function flow(id: string, feature: string, over: Partial<KgFlow> = {}): KgFlow {
  return {
    id,
    feature,
    name: `Flow ${id}`,
    trigger: { kind: "you", text: "When you send a message" },
    steps: [step(), step({ name: "stream", text: "Stream the reply back" })],
    outcome: { kind: "see", text: "The reply appears in the chat" },
    verdict: "traced",
    goal: null,
    changed: null,
    reach: 12,
    ...over,
  };
}

function featureMap(): KgFeatureMap {
  const feat = (id: string, area: string, symbols: number) => ({
    id,
    name: id.split("/")[1],
    area,
    path: id,
    symbols,
    files: 3,
    top_symbols: [],
    sample_files: [],
  });
  return {
    features: [
      feat("Shell/Chat", "Shell", 300),
      feat("Shell/Files", "Shell", 120),
      feat("Cloud/Sync", "Cloud", 200),
      feat("Cli/Prove", "Cli", 50),
    ],
    links: [],
    folded: 0,
    stats: {
      symbols: 670,
      files: 12,
      communities: 3,
      gods: 1,
      edges: 900,
      canonical: 600,
    } as KgFeatureMap["stats"],
    built_at: NOW - 600,
    head_sha: "abc",
  };
}

function flowMap(flows: KgFlow[]): KgFlowMap {
  return {
    flows,
    features: [{ feature: "Shell/Chat", entries: 9, shown: 2, blurb: "Talk to the agent." }],
    tally: {
      traced: flows.filter((f) => f.verdict === "traced").length,
      seen: flows.filter((f) => f.verdict === "seen").length,
      proved: flows.filter((f) => f.goal?.verdict === "verified").length,
      gaps: flows.filter((f) => f.goal && f.goal.verdict !== "verified").length,
      changed: flows.filter((f) => f.changed).length,
    },
    change_window_days: 14,
    built_at: NOW - 600,
    head_sha: "abc",
    graph_version: "v",
    canonical_symbols: 600,
    symbols: 670,
  };
}

function overlaps(a: { x: number; y: number; w: number; h: number }, b: typeof a) {
  return a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;
}

describe("wrap", () => {
  test("keeps short text on one line", () => {
    expect(wrap("Send the turn", 33)).toEqual(["Send the turn"]);
  });
  test("breaks at word boundaries and never past two lines", () => {
    const lines = wrap(
      "Send the message to the agent terminal and wait for the streamed reply to finish",
      33,
    );
    expect(lines.length).toBe(2);
    for (const l of lines) expect(l.length).toBeLessThanOrEqual(33);
    expect(lines[1].endsWith("…")).toBe(true);
  });
  test("two full lines with nothing left over get no ellipsis", () => {
    const lines = wrap("one two three four", 10);
    expect(lines).toEqual(["one two", "three four"]);
    // A single word longer than the line is clipped, never dropped.
    expect(wrap("supercalifragilistic", 10)).toEqual(["supercali…"]);
  });
});

describe("rounded", () => {
  test("two points make a straight line", () => {
    expect(rounded([{ x: 0, y: 0 }, { x: 0, y: 40 }])).toBe("M0 0 L0 40");
  });
  test("a corner becomes a quadratic curve", () => {
    const d = rounded([{ x: 0, y: 0 }, { x: 0, y: 40 }, { x: 60, y: 40 }]);
    expect(d.startsWith("M0 0")).toBe(true);
    expect(d).toContain("Q0 40");
    expect(d.endsWith("L60 40")).toBe(true);
  });
});

describe("fitScale", () => {
  test("never zooms in past 1:1 and never below a quarter", () => {
    expect(fitScale(100, 100, 2000, 2000)).toBe(1);
    expect(fitScale(10_000, 10_000, 400, 400)).toBe(0.25);
  });
});

describe("layoutFlow", () => {
  test("steps stack down a spine with no overlap and the outcome sits under the bus", () => {
    const g = layoutFlow(flow("f", "Shell/Chat"));
    expect(g.trigger.y).toBe(0);
    for (let i = 1; i < g.steps.length; i++) {
      expect(g.steps[i].y).toBeGreaterThanOrEqual(g.steps[i - 1].y + g.steps[i - 1].h);
    }
    const last = g.steps[g.steps.length - 1];
    expect(g.busY).toBeGreaterThan(last.y + last.h);
    expect(g.outcomes[0].y).toBeGreaterThan(g.busY);
    expect(g.height).toBe(g.outcomes[0].y + G.OH);
    expect(g.width).toBe(G.NW);
  });

  test("also-calls lean out to the right and widen the diagram", () => {
    const f = flow("f", "Shell/Chat", {
      steps: [
        step({
          also_calls: [
            { name: "resolve_many", file: "a.rs", line: 1 },
            { name: "resolve_one", file: "a.rs", line: 2 },
            { name: "tool_session_read", file: "b.rs", line: 3 },
          ],
          also_calls_total: 5,
        }),
        step(),
      ],
    });
    const g = layoutFlow(f);
    expect(g.branches.length).toBe(3);
    for (const b of g.branches) {
      expect(b.x).toBeGreaterThanOrEqual(G.NW + G.LANE);
      expect(overlaps(b, g.steps[0])).toBe(false);
    }
    expect(g.more.get(0)).toBe(2);
    expect(g.width).toBe(G.NW + G.LANE + G.BW);
    // The step grew to hold its three branches.
    expect(g.steps[0].h).toBeGreaterThanOrEqual(3 * (G.BH + G.BGAP) - G.BGAP + 12);
  });

  test("a goal adds a second box under the bus without leaving the canvas", () => {
    const g = layoutFlow(
      flow("f", "Shell/Chat", {
        goal: { id: "g1", text: "Chat works", verdict: "partial", ok: 2, total: 3, at: NOW },
      }),
    );
    expect(g.outcomes.length).toBe(2);
    expect(g.outcomes[1].kind).toBe("goal");
    expect(g.outcomes[1].title).toBe("Stops short");
    for (const o of g.outcomes) expect(o.x).toBeGreaterThanOrEqual(0);
    expect(g.width).toBeGreaterThanOrEqual(g.outcomes[1].x + g.outcomes[1].w);
  });
});

describe("layoutTree", () => {
  const model = buildModel(featureMap(), flowMap([flow("a", "Shell/Chat"), flow("b", "Shell/Chat")]));

  test("areas become columns, largest first, and nothing overlaps at rest", () => {
    const t = layoutTree(model, { featureId: null, flowId: null }, null);
    expect(t.areas.map((a) => a.area.name)).toEqual(["Shell", "Cloud", "Cli"]);
    expect(t.areas[1].x - t.areas[0].x).toBe(COL_W + T.COL_GAP);
    const boxes = [...t.areas, ...t.features];
    for (let i = 0; i < boxes.length; i++) {
      for (let j = i + 1; j < boxes.length; j++) {
        expect(overlaps(boxes[i], boxes[j])).toBe(false);
      }
    }
    expect(t.flowRows.length).toBe(0);
    expect(t.diagramAt).toBeNull();
    // Root is centred over the tree.
    expect(Math.abs(t.root.x + t.root.w / 2 - t.width / 2)).toBeLessThan(1);
  });

  test("opening a feature unfolds its flows and pushes the next feature down", () => {
    const closed = layoutTree(model, { featureId: null, flowId: null }, null);
    const open = layoutTree(model, { featureId: "Shell/Chat", flowId: null }, null);
    const filesClosed = closed.features.find((f) => f.feature.id === "Shell/Files")!;
    const filesOpen = open.features.find((f) => f.feature.id === "Shell/Files")!;
    expect(open.flowRows.length).toBe(2);
    expect(filesOpen.y).toBeGreaterThan(filesClosed.y);
    const chat = open.features.find((f) => f.feature.id === "Shell/Chat")!;
    for (const r of open.flowRows) {
      expect(r.y).toBeGreaterThan(chat.y + chat.h);
      expect(r.y + r.h).toBeLessThanOrEqual(filesOpen.y);
      expect(r.x).toBeGreaterThan(chat.x);
    }
    // Other columns did not move: nothing widened.
    expect(open.areas[1].x).toBe(closed.areas[1].x);
  });

  test("opening a flow draws its diagram in place and slides later columns right", () => {
    const f = model.flowById.get("a")!;
    const geom = layoutFlow(f);
    const t = layoutTree(model, { featureId: "Shell/Chat", flowId: "a" }, geom);
    const closed = layoutTree(model, { featureId: "Shell/Chat", flowId: null }, null);
    expect(t.diagramAt).not.toBeNull();
    const row = t.flowRows.find((r) => r.flow.id === "a")!;
    expect(t.diagramAt!.y).toBeGreaterThan(row.y + row.h);
    expect(t.diagramAt!.x).toBe(row.x);
    // Diagram is wider than the column, so Cloud moves right by the overhang.
    const overhang = row.x - t.areas[0].x + geom.width - COL_W;
    expect(t.areas[1].x - closed.areas[1].x).toBe(overhang);
    // The second flow row sits below the diagram, not on it.
    const rowB = t.flowRows.find((r) => r.flow.id === "b")!;
    expect(rowB.y).toBeGreaterThanOrEqual(t.diagramAt!.y + geom.height);
    const diagramRect = { x: t.diagramAt!.x, y: t.diagramAt!.y, w: geom.width, h: geom.height };
    for (const box of [...t.features, ...t.areas]) {
      expect(overlaps(box, diagramRect)).toBe(false);
    }
    expect(t.width).toBeGreaterThanOrEqual(t.areas[2].x + t.areas[2].w + T.PAD);
  });
});

describe("status and copy", () => {
  test("a flow is only proved or a gap when a prover run says so", () => {
    expect(flowStatus(flow("a", "x"))).toBe("traced");
    expect(flowStatus(flow("a", "x", { verdict: "seen" }))).toBe("seen");
    expect(
      flowStatus(
        flow("a", "x", { goal: { id: "g", text: "t", verdict: "verified", ok: 3, total: 3, at: NOW } }),
      ),
    ).toBe("proved");
    expect(
      flowStatus(
        flow("a", "x", { goal: { id: "g", text: "t", verdict: "not_wired", ok: 0, total: 3, at: NOW } }),
      ),
    ).toBe("gap");
    // A goal with an unknown verdict attaches nothing.
    expect(
      flowStatus(
        flow("a", "x", { goal: { id: "g", text: "t", verdict: "unknown", ok: 0, total: 0, at: 0 } }),
      ),
    ).toBe("traced");
  });

  test("status copy names its evidence", () => {
    const traced = statusCopy(flow("a", "x"), NOW - 120, NOW);
    expect(traced).toBe("traced from the code · read 2 min ago");
    const gap = statusCopy(
      flow("a", "x", { goal: { id: "g", text: "t", verdict: "partial", ok: 1, total: 4, at: NOW - DAY } }),
      NOW,
      NOW,
    );
    expect(gap).toBe("stops short · 1 of 4 checks passed · yesterday");
  });

  test("relative time reads like a person said it", () => {
    expect(relativeTime(NOW - 10, NOW)).toBe("just now");
    expect(relativeTime(NOW - 5 * 60, NOW)).toBe("5 min ago");
    expect(relativeTime(NOW - 3 * 3600, NOW)).toBe("3 h ago");
    expect(relativeTime(NOW - DAY, NOW)).toBe("yesterday");
    expect(relativeTime(NOW - 6 * DAY, NOW)).toBe("6 days ago");
    expect(relativeTime(NOW - 90 * DAY, NOW).startsWith("on ")).toBe(true);
    expect(relativeTime(0, NOW)).toBe("at an unknown time");
  });

  test("where labels never say 'other'", () => {
    expect(whereLabel("engine", "Shell")).toBe("in the app's engine");
    expect(whereLabel("app", "Shell")).toBe("in the app window");
    expect(whereLabel("server", "Shell")).toBe("on the server");
    expect(whereLabel("cli", "Shell")).toBe("in the terminal");
    expect(whereLabel("other", "Shell")).toBe("in Shell");
    expect(whereLabel("other", "")).toBe("in the code");
  });

  test("needs-a-look lists gaps and recent changes, newest first", () => {
    const flows = [
      flow("old", "x", { changed: { when: NOW - 30 * DAY, who: "mo", why: "old" } }),
      flow("new", "x", { changed: { when: NOW - DAY, who: "mo", why: "new" } }),
      flow("newer", "x", { changed: { when: NOW - 3600, who: "mo", why: "newer" } }),
      flow("gap", "x", { goal: { id: "g", text: "t", verdict: "partial", ok: 0, total: 1, at: NOW } }),
    ];
    const look = needsALook(flows, NOW, 14);
    expect(look.gaps.map((f) => f.id)).toEqual(["gap"]);
    expect(look.changed.map((f) => f.id)).toEqual(["newer", "new"]);
  });

  test("tally chips only speak of what is non-zero", () => {
    const quiet = tallyChips(flowMap([flow("a", "x"), flow("b", "x")]));
    expect(quiet.map((c) => c.label)).toEqual(["2 flows"]);
    const loud = tallyChips(
      flowMap([
        flow("a", "x", { goal: { id: "g", text: "t", verdict: "verified", ok: 1, total: 1, at: NOW } }),
        flow("b", "x", { goal: { id: "g", text: "t", verdict: "partial", ok: 0, total: 1, at: NOW } }),
        flow("c", "x", { changed: { when: NOW, who: "mo", why: "w" } }),
      ]),
    );
    expect(loud.map((c) => c.label)).toEqual([
      "3 flows",
      "1 stop short",
      "1 proved",
      "1 changed in 14 days",
    ]);
    expect(loud.map((c) => c.tone)).toEqual(["neutral", "red", "green", "amber"]);
    expect(tallyChips(null)).toEqual([]);
  });
});

describe("buildModel", () => {
  test("hangs flows and blurbs on their features and orders by size", () => {
    const m = buildModel(featureMap(), flowMap([flow("a", "Shell/Chat")]));
    const chat = m.featureById.get("Shell/Chat")!;
    expect(chat.flows.map((f) => f.id)).toEqual(["a"]);
    expect(chat.blurb).toBe("Talk to the agent.");
    expect(chat.entries).toBe(9);
    expect(m.areas[0].features.map((f) => f.id)).toEqual(["Shell/Chat", "Shell/Files"]);
    expect(m.areaOf.get("Cloud/Sync")).toBe("Cloud");
    // No flows at all still yields a model.
    const bare = buildModel(featureMap(), null);
    expect(bare.flowById.size).toBe(0);
    expect(bare.featureById.get("Shell/Chat")!.flows).toEqual([]);
  });
});
