// "Reached — everything this needs is in place", over the engine's own
// NOT PROVEN.
//
//   bun test
//
// The report reader had four faults and every one of them failed towards
// "it's built". Each `describe` below reintroduces one and shows it caught.
//
// The fixtures are the real thing: `render_prove_report` in
// `aura-cli/src/gsd.rs` writes exactly these lines, to stderr, and the last
// describe pins the parser to that source so a change on either side fails
// here rather than in front of a user.

import { describe, expect, test } from "bun:test";

import {
  gapKind,
  gaps,
  parseProveOutput,
  verdictOf,
} from "../src/lib/proveReport";
import { stripComments as code } from "./support/code";

const BANNER = "------------------ SEMANTIC PROOF REPORT -------------------";
const END = "----------------------- END REPORT ------------------------";

const head = (goal: string) =>
  [
    `🧪 Aura Prover: Verifying Goal Achievement: ${goal}`,
    "  ↳ Analyzing behavioral requirements via local context...",
    "  ↳ Scanning Merkle-Graph for logic nodes and wiring...",
    "",
  ].join("\n");

const report = (goal: string, body: string[], verdict: string) =>
  [head(goal), BANNER, ...body, END, "", verdict].join("\n");

const BUILT = (n: string) => `✓ Function '${n}' exists and is substantive.`;
const STUB = (n: string) => `⚠️ Function '${n}' exists but is a STUB!`;
const MISSING = (n: string) => `✗ Class '${n}' is missing from the AST!`;
const PROVEN = (g: string) => `🛡️  Goal '${g}' is MATHEMATICALLY PROVEN!`;
const NOT_PROVEN = (g: string, ok: number, total: number) =>
  `❌ Goal '${g}' is NOT PROVEN (${ok} of ${total} semantic links verified).`;

describe("a placeholder is not a thing that's in place", () => {
  // The shipped shape. Three real symbols, two stubs. The old parser only ever
  // collected lines starting `✓` or `✗`, so the stubs vanished — three checks,
  // all passing, "3/3 in place" in green, beside the engine's "3 of 5".
  const OUT = report(
    "users can sign in with Google",
    [
      BUILT("handleGoogleCallback"),
      BUILT("createSession"),
      BUILT("storeRefreshToken"),
      STUB("refreshGoogleToken"),
      STUB("revokeGoogleGrant"),
    ],
    NOT_PROVEN("users can sign in with Google", 3, 5),
  );

  test("stubs are counted, and they count against the verdict", () => {
    const r = parseProveOutput(OUT);
    expect(r.checks.length).toBe(5);
    const { tone, ok, total } = verdictOf(r);
    expect(total).toBe(5);
    expect(ok).toBe(3);
    expect(tone).toBe("partial");
    expect(tone).not.toBe("ok");
  });

  test("the count the app prints is the engine's count", () => {
    const { ok, total } = verdictOf(parseProveOutput(OUT));
    // The engine said "3 of 5 semantic links verified" in the same output.
    expect(`${ok} of ${total}`).toBe("3 of 5");
  });

  test("a stub is described as a stub, not as missing", () => {
    const g = gaps(parseProveOutput(OUT));
    expect(g.length).toBe(2);
    // Stubs lead: a placeholder reads as finished everywhere else.
    expect(g[0]!.stub).toBe(true);
    expect(gapKind(g[0]!)).toBe("started, but still empty");
    expect(gapKind(g[0]!)).not.toContain("not built");
  });
});

describe("built, but nothing calls it, is not built", () => {
  // The engine prints the symbol on a passing `✓` line and the failure on the
  // indented line beneath it. The parser read the first and skipped the second.
  const OUT = report(
    "cards get charged",
    [
      BUILT("submitOrder"),
      "  ↳ ✗ NOT wired to 'chargeCard'",
      BUILT("chargeCard"),
      "  ↳ Properly wired to 'stripeClient'",
    ],
    NOT_PROVEN("cards get charged", 1, 2),
  );

  test("the sub-line demotes the check above it", () => {
    const r = parseProveOutput(OUT);
    expect(r.checks.length).toBe(2);
    expect(r.checks[0]!.ok).toBe(false);
    expect(r.checks[0]!.unwired).toBe(true);
    expect(r.checks[1]!.ok).toBe(true);
    expect(verdictOf(r).tone).toBe("partial");
  });

  test("a properly-wired sub-line demotes nothing", () => {
    const r = parseProveOutput(
      report("x", [BUILT("a"), "  ↳ Properly wired to 'b'"], PROVEN("x")),
    );
    expect(r.checks[0]!.ok).toBe(true);
    expect(verdictOf(r).tone).toBe("ok");
  });

  test("it says nothing calls it, rather than that it isn't built", () => {
    const g = gaps(parseProveOutput(OUT));
    expect(gapKind(g[0]!)).toBe("built, but nothing calls it");
  });
});

describe("the engine's verdict is the verdict", () => {
  test("MATHEMATICALLY PROVEN is recognised", () => {
    // The old test was `/^✅|^Goal .* PROVEN|is PROVEN/` against a line reading
    // `🛡️  Goal 'x' is MATHEMATICALLY PROVEN!`. None of the three match it, so
    // `proven` was never once set true by the real CLI.
    const r = parseProveOutput(report("x", [BUILT("a")], PROVEN("x")));
    expect(r.stated).toBe(true);
    expect(r.proven).toBe(true);
    expect(verdictOf(r).tone).toBe("ok");
  });

  test("NOT PROVEN outranks checks that all look fine", () => {
    // Every line the parser understood passed, and the engine still said no —
    // which is what happens when the report holds a shape we don't parse. The
    // counts must not be allowed to overrule it.
    const r = parseProveOutput(
      report("x", [BUILT("a"), BUILT("b")], NOT_PROVEN("x", 2, 4)),
    );
    expect(r.stated).toBe(false);
    expect(r.proven).toBe(false);
    expect(verdictOf(r).tone).not.toBe("ok");
  });

  test("with no verdict line, every check must pass to earn green", () => {
    const all = parseProveOutput(report("x", [BUILT("a"), BUILT("b")], ""));
    expect(all.stated).toBeNull();
    expect(verdictOf(all).tone).toBe("ok");

    const some = parseProveOutput(report("x", [BUILT("a"), MISSING("B")], ""));
    expect(verdictOf(some).tone).toBe("partial");
  });

  test("a report listing nothing has proven nothing", () => {
    const r = parseProveOutput(report("x", [], ""));
    expect(r.ran).toBe(true);
    expect(r.proven).toBe(false);
    expect(verdictOf(r).tone).toBe("unknown");
  });
});

describe("a check that couldn't run says nothing about the code", () => {
  // `render_prove_report` prints one line and returns, before the banner.
  const blocked = (msg: string) => `${head("x")}✗ ${msg}`;

  test("an engine error is not a failed check", () => {
    const r = parseProveOutput(blocked("Not a git repository."));
    expect(r.ran).toBe(false);
    expect(r.checks).toEqual([]);
    expect(r.blocked).toBe("Not a git repository.");
    const { tone, total } = verdictOf(r);
    // The old parser made this one failed check, zero passing — "Not reached",
    // in red, about code nobody had opened. And wrote it to the goal record.
    expect(tone).toBe("unknown");
    expect(tone).not.toBe("fail");
    expect(total).toBe(0);
  });

  test("every error the engine can print lands the same way", () => {
    for (const msg of [
      "Not a git repository.",
      "No snapshot of the code to check against yet.",
      "No snapshot of the code at that point to check against.",
      "Couldn't work out what this goal needs yet.",
    ]) {
      const r = parseProveOutput(blocked(msg));
      expect(`${msg} → ${verdictOf(r).tone}`).toBe(`${msg} → unknown`);
      expect(r.blocked).toBe(msg);
    }
  });

  test("a non-zero exit is never a verdict, however good the output looks", () => {
    // `aura prove` exits 0 whether or not a goal is proven, so a non-zero
    // status means the command itself failed. `aura_cli` has always ferried it
    // back and nothing on this side read it.
    const perfect = report("x", [BUILT("a"), BUILT("b")], PROVEN("x"));
    expect(verdictOf(parseProveOutput(perfect, 0)).tone).toBe("ok");
    const r = parseProveOutput(perfect, 1);
    expect(r.ran).toBe(false);
    expect(verdictOf(r).tone).toBe("unknown");
  });

  test("a binary too old for --json doesn't read as an empty answer", () => {
    const r = parseProveOutput(
      "error: unexpected argument '--json' found\n\nUsage: aura prove --goal <GOAL>",
      2,
    );
    expect(r.ran).toBe(false);
    expect(r.blocked).toBeTruthy();
    expect(verdictOf(r).tone).toBe("unknown");
  });

  test("nothing at all is not good news", () => {
    const r = parseProveOutput("");
    expect(r.ran).toBe(false);
    expect(verdictOf(r).tone).toBe("unknown");
  });
});

describe("the report is read as written", () => {
  test("colour escapes don't hide the glyphs", () => {
    // `colored` emits escapes whenever it thinks it's on a terminal, and
    // `line.startsWith("✓")` is false the moment one lands in front.
    const esc = (s: string) => `[32m${s}[0m`;
    const r = parseProveOutput(
      [
        `[1m[34m${BANNER}[0m`,
        `${esc("✓")} Function 'a' exists and is substantive.`,
        `[33m⚠️[0m Function 'b' exists but is a STUB!`,
        END,
        NOT_PROVEN("x", 1, 2),
      ].join("\n"),
    );
    expect(r.checks.length).toBe(2);
    expect(r.checks[0]!.ok).toBe(true);
    expect(r.checks[1]!.stub).toBe(true);
  });

  test("the identifier and kind survive", () => {
    const r = parseProveOutput(report("x", [MISSING("GoogleOAuthClient")], ""));
    expect(r.checks[0]!.kind).toBe("Class");
    expect(r.checks[0]!.identifier).toBe("GoogleOAuthClient");
  });

  test("the closing line is kept for display, not for the verdict", () => {
    const r = parseProveOutput(
      report("x", [BUILT("a"), STUB("b")], NOT_PROVEN("x", 1, 2)),
    );
    expect(r.summary).toContain("NOT PROVEN");
    expect(r.summary).toContain("1 of 2 semantic links verified");
  });
});

describe("no surface computes its own verdict", () => {
  const read = async (rel: string) =>
    code(await Bun.file(`${import.meta.dir}/../src/${rel}`).text());

  test("the expression that inflated the counts is gone from src", async () => {
    for (const f of ["lib/prove.ts", "components/workpanes/ProvePane.tsx"]) {
      const src = (await read(f)).replace(/\s+/g, "");
      expect(`${f}: ${src.includes("result.proven||(total>0&&ok===total)")}`).toBe(
        `${f}: false`,
      );
    }
  });

  test("the pane asks the fold", async () => {
    const src = (await read("components/workpanes/ProvePane.tsx")).replace(
      /\s+/g,
      "",
    );
    expect(src).toContain("verdictOf(result)");
    // …and has somewhere to put the fourth state.
    expect(src).toContain('tone==="unknown"');
  });

  test("the exit status reaches the parser", async () => {
    const src = (await read("lib/prove.ts")).replace(/\s+/g, "");
    // Both bridges, not just the one.
    expect(src.split("res.status").length - 1).toBeGreaterThanOrEqual(2);
  });
});

describe("the parser is keyed to what the engine actually prints", () => {
  // The whole defect was a parser looking for text the CLI never emitted. If
  // either side moves, this fails here rather than in a green banner.
  const rust = async () =>
    code(await Bun.file(`${import.meta.dir}/../../aura-cli/src/gsd.rs`).text());

  const renderFn = async () => {
    const src = await rust();
    const i = src.indexOf("fn render_prove_report");
    expect(i).toBeGreaterThan(-1);
    const j = src.indexOf("\n    }", i);
    return src.slice(i, j === -1 ? undefined : j);
  };

  test("every line shape the report emits is one the parser knows", async () => {
    const body = await renderFn();
    for (const lit of [
      "SEMANTIC PROOF REPORT",
      "MATHEMATICALLY PROVEN",
      "NOT PROVEN",
      "NOT wired",
      "is missing from the AST!",
      "exists but is a",
      "exists and is substantive.",
    ]) {
      expect(`${lit}: ${body.includes(lit)}`).toBe(`${lit}: true`);
    }
  });

  test("the three glyphs are the three the parser branches on", async () => {
    const body = await renderFn();
    expect(body).toContain('"✓"');
    expect(body).toContain('"✗"');
    expect(body).toContain('"⚠️"');
  });

  test("the error branch still returns before the banner", async () => {
    // What makes "a lone ✗ is not a check" true.
    const body = (await renderFn()).replace(/\s+/g, "");
    const err = body.indexOf('outcome["error"].as_str()');
    const banner = body.indexOf("SEMANTICPROOFREPORT");
    expect(err).toBeGreaterThan(-1);
    expect(banner).toBeGreaterThan(err);
    expect(body.slice(err, banner)).toContain("return;");
  });

  test("prove still exits 0 either way, so non-zero means failure", async () => {
    const main = code(
      await Bun.file(`${import.meta.dir}/../../aura-cli/src/main.rs`).text(),
    );
    const i = main.indexOf("Commands::GoalTrace");
    expect(i).toBeGreaterThan(-1);
    const arm = main.slice(i, main.indexOf("Commands::", i + 10));
    expect(arm).not.toContain("process::exit");
  });
});
