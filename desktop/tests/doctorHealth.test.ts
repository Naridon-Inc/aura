// "Your project's in good shape" — over problems the engine had already found.
//
//   bun test
//
// The health headline was:
//
//     const attention = items.filter((i) => i.severity === "attention").length;
//     attention > 0 ? "A couple of things to set up"
//                   : "Your project's in good shape"
//
// `items` came from a fold that read four of the report's ten fields, and only
// two of them could ever produce an "attention" item. The engine counts SEVEN
// sources into `issues_found` — and `issues_found` itself, `cloud_rotation`,
// `shadow` and `plugins_loaded` were never read by this screen at all. So a
// diverged record chain, or a signing probe returning a status this build
// doesn't recognise, rendered as green, under the words "Nothing needs your
// attention", with the engine's own count sitting unread in the same object.
//
// The load-bearing test here is the reconciliation: every item declares how
// many of `issues_found` it accounts for, and the green arm is unreachable
// while any go unaccounted. That holds even for a probe nobody has written
// yet — which is the point, because the last one wasn't written when this
// screen was.

import { describe, expect, test } from "bun:test";

import {
  buildHealthItems,
  healthHeadline,
  type HealthItem,
} from "../src/lib/doctorHealth";
import { stripComments as code } from "./support/code";
import type { DoctorReport } from "../src/lib/api";

/** A perfectly healthy project: hooks on, key signed, nothing stale, nothing
 *  drifted, and an engine that agrees there's nothing wrong. */
const OK = (over: Partial<DoctorReport> = {}): DoctorReport =>
  ({
    stuck_sessions: [],
    snapshots: { total: 12, orphaned: 0, approx_kb: 40, oversized: false },
    hooks_installed: true,
    shadow: { exists: true, checkpoints: 4 },
    plugins_loaded: 0,
    signing: { status: "ok", key_id: "k1" },
    cloud_rotation: { status: "ok", local_only: [], cloud_only: [] },
    skill_ledger: {
      present: true,
      readable: true,
      recorded: 10,
      dirty: 0,
      total_cells: 3,
      min_samples: 5,
      immature_cells: [],
    },
    replay_orphans: [],
    issues_found: 0,
    ...over,
  }) as DoctorReport;

const verdictOf = (r: DoctorReport) => healthHeadline(buildHealthItems(r), r);
const accounted = (items: HealthItem[]) =>
  items.reduce((n, i) => n + i.counts, 0);

describe("the all-clear can't outrun the engine's own count", () => {
  test("a clean report is allowed to say so", () => {
    const v = verdictOf(OK());
    expect(v.tone).toBe("good");
    expect(v.text).toBe("Your project's in good shape");
    expect(v.chips).toEqual(["Nothing needs your attention"]);
  });

  test("a problem this screen doesn't draw still blocks the all-clear", () => {
    // The shape of the future: the engine counted something no arm below
    // knows how to render. Before, this was silently green.
    const v = verdictOf(OK({ issues_found: 1 }));
    expect(v.tone).toBe("unknown");
    expect(v.text).not.toContain("good shape");
    expect(v.chips.join(" ")).toContain("can't explain");
  });

  test("every issue the engine counts is accounted for by an item", () => {
    // One report per issue source the engine has today. If `buildHealthItems`
    // stops covering one, the sum stops matching and this fails — which is
    // also exactly what stops the headline going green in the app.
    const cases: Array<[string, DoctorReport]> = [
      [
        "stuck sessions",
        OK({
          stuck_sessions: [
            { session_id: "s1", agent_id: "claude", files_touched: 2, reason: "idle" },
            { session_id: "s2", agent_id: "codex", files_touched: 1, reason: "idle" },
          ],
          issues_found: 2,
        } as Partial<DoctorReport>),
      ],
      [
        "orphaned backups",
        OK({
          snapshots: { total: 9, orphaned: 3, approx_kb: 10, oversized: false },
          issues_found: 3,
        } as Partial<DoctorReport>),
      ],
      ["hooks missing", OK({ hooks_installed: false, issues_found: 1 })],
      [
        "signing unreadable",
        OK({ signing: { status: "unreadable" }, issues_found: 1 }),
      ],
      ["signing no_path", OK({ signing: { status: "no_path" }, issues_found: 1 })],
      [
        "signing status nobody recognises",
        OK({ signing: { status: "wat", error: "probe blew up" }, issues_found: 1 }),
      ],
      [
        "signing probe returned nothing at all",
        OK({ signing: {}, issues_found: 1 }),
      ],
      [
        "entries only on this computer",
        OK({
          cloud_rotation: { status: "ok", local_only: ["a"], cloud_only: [] },
          issues_found: 1,
        }),
      ],
      [
        "entries only in the cloud",
        OK({
          cloud_rotation: { status: "ok", local_only: [], cloud_only: ["b"] },
          issues_found: 1,
        }),
      ],
      [
        "drift in both directions",
        OK({
          cloud_rotation: { status: "ok", local_only: ["a"], cloud_only: ["b", "c"] },
          issues_found: 2,
        }),
      ],
      [
        "the comparison errored",
        OK({ cloud_rotation: { status: "error", error: "no network" }, issues_found: 1 }),
      ],
      [
        "the comparison came back unrecognisable",
        OK({ cloud_rotation: { status: "??" }, issues_found: 1 }),
      ],
    ];
    for (const [name, r] of cases) {
      const items = buildHealthItems(r);
      expect(`${name}: ${accounted(items)}`).toBe(`${name}: ${r.issues_found}`);
      // …and none of them may render as "nothing to see here". Two of the
      // engine's sources — old sessions, orphaned backups — are deliberately
      // shown as harmless tidy-ups rather than in amber, so the invariant
      // isn't "never green", it's that the screen never claims the engine
      // found nothing when the engine found something. Those cases keep the
      // calm headline AND carry a chip that says what was found.
      const chips = healthHeadline(items, r).chips.join(" · ");
      expect(`${name}: ${chips}`).not.toBe(
        `${name}: Nothing needs your attention`,
      );
      expect(`${name}: ${chips.length > 0}`).toBe(`${name}: true`);
    }
  });

  test("several sources at once still add up", () => {
    const r = OK({
      hooks_installed: false,
      signing: { status: "unreadable" },
      cloud_rotation: { status: "ok", local_only: ["a", "b"], cloud_only: ["c"] },
      stuck_sessions: [
        { session_id: "s1", agent_id: "claude", files_touched: 1, reason: "idle" },
      ],
      snapshots: { total: 4, orphaned: 2, approx_kb: 1, oversized: false },
      issues_found: 1 + 1 + 2 + 1 + 2,
    } as Partial<DoctorReport>);
    const items = buildHealthItems(r);
    expect(accounted(items)).toBe(r.issues_found);
    expect(healthHeadline(items, r).tone).toBe("attention");
  });

  test("the engine counting FEWER than we found never invents a problem", () => {
    // Defensive: `Math.max(0, …)`. A negative difference is not a finding.
    const r = OK({ hooks_installed: false, issues_found: 0 });
    const v = verdictOf(r);
    expect(v.tone).toBe("attention");
    expect(v.chips.join(" ")).not.toContain("can't explain");
  });
});

describe("every probe in the report is answered for", () => {
  test("the signing probe is never silently dropped", () => {
    // "missing" is the one genuinely quiet case — Aura mints a key when it
    // first needs one, and the engine doesn't count it either.
    expect(
      buildHealthItems(OK({ signing: { status: "missing" } })).some(
        (i) => i.key === "signing",
      ),
    ).toBe(false);
    for (const status of ["unreadable", "no_path", "wat", ""]) {
      const items = buildHealthItems(OK({ signing: { status } }));
      const it = items.find((i) => i.key === "signing");
      expect(`${status}: ${it?.severity}`).toBe(`${status}: attention`);
    }
  });

  test("the cloud comparison is quiet only when there is nothing to compare", () => {
    // "skipped" = not signed in. Nothing drifted because nothing was checked,
    // and the engine agrees: it counts nothing for it.
    const skipped = buildHealthItems(OK({ cloud_rotation: { status: "skipped" } }));
    expect(skipped.some((i) => i.key === "record-drift")).toBe(false);
    const clean = buildHealthItems(OK());
    expect(clean.some((i) => i.key === "record-drift")).toBe(false);
  });

  test("a learning ledger Aura can't read is said out loud", () => {
    const r = OK({
      skill_ledger: {
        present: true,
        readable: false,
        recorded: 0,
        dirty: 0,
        total_cells: 0,
        min_samples: 5,
        immature_cells: [],
      },
    } as Partial<DoctorReport>);
    const it = buildHealthItems(r).find((i) => i.key === "skill-unreadable");
    expect(it?.severity).toBe("attention");
    expect(verdictOf(r).tone).toBe("attention");
  });

  test("restore points are reported, and their absence isn't a fault", () => {
    expect(
      buildHealthItems(OK()).find((i) => i.key === "restore-points")?.severity,
    ).toBe("ok");
    expect(
      buildHealthItems(OK({ shadow: { exists: false, checkpoints: 0 } })).some(
        (i) => i.key === "restore-points",
      ),
    ).toBe(false);
    // A checkpoint branch that exists but holds nothing is the same non-event.
    expect(
      buildHealthItems(OK({ shadow: { exists: true, checkpoints: 0 } })).some(
        (i) => i.key === "restore-points",
      ),
    ).toBe(false);
  });

  test("no item is left without a plain-language title", () => {
    const busy = OK({
      hooks_installed: false,
      signing: { status: "no_path" },
      cloud_rotation: { status: "error" },
      stuck_sessions: [
        { session_id: "s", agent_id: "", files_touched: 0, reason: "idle" },
      ],
      snapshots: { total: 500, orphaned: 0, approx_kb: 9, oversized: true },
      replay_orphans: [{ branch: "b", path: "/p" }],
      issues_found: 4,
    } as Partial<DoctorReport>);
    for (const it of buildHealthItems(busy)) {
      expect(it.title.length).toBeGreaterThan(0);
      expect(it.counts).toBeGreaterThanOrEqual(0);
      // No engineering vocabulary on a screen written for people who didn't
      // write the code.
      for (const word of ["AST", "Merkle", "worktree", "hook", "snapshot", "SHA"]) {
        expect(`${it.key}: ${it.title.includes(word)}`).toBe(`${it.key}: false`);
      }
    }
  });

  test("every field of the report is named by the fold", async () => {
    // Crude on purpose. The defect was a probe nobody looked at; the cheapest
    // durable guard is that adding a field upstream and not touching this file
    // fails here.
    const src = code(
      await Bun.file(`${import.meta.dir}/../src/lib/doctorHealth.ts`).text(),
    );
    for (const field of [
      "stuck_sessions",
      "snapshots",
      "hooks_installed",
      "shadow",
      "plugins_loaded",
      "signing",
      "cloud_rotation",
      "skill_ledger",
      "replay_orphans",
      "issues_found",
    ]) {
      expect(`${field}: ${src.includes(field)}`).toBe(`${field}: true`);
    }
  });
});

describe("the dialog draws the verdict the fold computed", () => {
  const read = async (rel: string) =>
    code(await Bun.file(`${import.meta.dir}/../src/${rel}`).text());

  test("the headline is the fold, fed the report", async () => {
    const src = await read("components/dialogs/DoctorDialog.tsx");
    expect(src).toContain("healthHeadline(items, report)");
    expect(src).toContain("buildHealthItems(report)");
    expect(src).toContain("<HealthHeadline items={items} report={report} />");
    // Not one verdict of its own left behind.
    expect(src).not.toContain('"Your project\'s in good shape"');
    expect(src).not.toContain("Nothing needs your attention");
    expect(src).not.toContain('i.severity === "attention"');
    expect(src).not.toContain("function buildItems");
  });

  test("all three tones can actually be painted", async () => {
    const src = await read("components/dialogs/DoctorDialog.tsx");
    for (const tone of ["attention", "good", "unknown"]) {
      expect(`${tone}: ${src.includes(tone + ":")}`).toBe(`${tone}: true`);
    }
    expect(src).toContain("VERDICT_FG[verdict.tone]");
  });
});
