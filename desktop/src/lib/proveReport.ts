// Reading `aura prove`'s report — the one answer this product exists to give.
//
// You asked for something, an agent said it was done, and Aura went and
// checked. The app printed the answer in green:
//
//     ✓ Reached      3/3 in place
//     Everything this needs is in place — the AI actually built it.
//     ❌ Goal 'X' is NOT PROVEN (3 of 5 semantic links verified).
//
// That last line is the engine's own verdict, rendered in the smallest grey
// type on the card, directly under a green claim that contradicts it. Four
// separate faults in one parser put it there, and every one of them fails in
// the same direction — towards "it's built":
//
//  1. A stub was dropped on the floor. The report marks a symbol that exists
//     but is empty with `⚠️`, and the parser only ever collected lines
//     starting `✓` or `✗`. A goal with three real parts and two placeholders
//     parsed as three checks, all passing — 3/3, green — while the engine
//     said 3 of 5. A stub is the single thing Aura exists to catch: code that
//     looks finished and quietly does nothing.
//
//  2. Built-but-not-wired counted as built. The engine prints the symbol on a
//     `✓` line and the failure on the indented line below it
//     (`↳ ✗ NOT wired to 'chargeCard'`). The parser read the first and skipped
//     the second, so a step nothing ever calls counted as in place.
//
//  3. The engine's "proven" line was never recognised. It emits
//     `🛡️  Goal 'X' is MATHEMATICALLY PROVEN!`; the parser tested for
//     `/^✅|^Goal .* PROVEN|is PROVEN/`, none of which match it. So the
//     verdict came from counting the checks the parser managed to collect —
//     the very counts faults 1 and 2 had already inflated — and the engine's
//     own contradicting verdict, which WAS parsed, was used for nothing but
//     that small grey summary line.
//
//  4. An engine error was rendered as a verdict about your code. When the
//     proof can't run the CLI prints one line and stops — `✗ Not a git
//     repository.`, `✗ No snapshot of the code to check against yet.` That
//     line starts with `✗`, so it was collected as a failed check: one check,
//     zero passing, and the surface said "Not reached — none of what this
//     needs is working yet" in red about code nobody had looked at. Worse,
//     both of these are written to the durable goal record, so a verdict
//     invented from an error message follows the goal onto the task board.
//
// Underneath all four: `aura_cli` ferries the process's exit status back and
// nothing on this side ever read it.
//
// The rules this module holds to:
//   • A verdict the engine stated wins over any verdict we could compute. We
//     only count when it didn't say.
//   • A check that didn't run is `unknown`, never `fail`. "We couldn't look"
//     and "we looked and it isn't there" are different sentences and the
//     second one is an accusation.
//   • Every line shape the report emits is either understood or the report is
//     treated as unread. Silently skipping a shape is how 3 of 5 became 3/3.
//
// Pure: no imports, so the whole fold is testable without a Tauri bridge.

/** One thing Aura looked for. */
export type Check = {
  /** Built, substantive, and wired to whatever it must call. */
  ok: boolean;
  /** Present in the code but empty — the placeholder case. Not `ok`, and not
   *  the same as missing: it's the one a reader most needs told about, because
   *  it's the one that looks done. */
  stub: boolean;
  /** Built and substantive, but nothing calls it — so the step never runs. */
  unwired: boolean;
  /** The report's own line, for display when we couldn't structure it. */
  line: string;
  /** Best-effort kind ("Class" / "Function" / …). */
  kind: string | null;
  /** Best-effort identifier (between single quotes). */
  identifier: string | null;
};

export type ProveResult = {
  /** False when no proof report was produced — the CLI failed, the binary is
   *  too old, there's no snapshot to read against. Never a verdict. */
  ran: boolean;
  /** Why it couldn't run, in the engine's own words where it gave them.
   *  Null whenever `ran` is true. */
  blocked: string | null;
  checks: Check[];
  /** The engine's own verdict, when it printed one. `null` means it didn't
   *  say — only then do the counts get to decide. */
  stated: boolean | null;
  /** The verdict as this report should be read: the engine's if it stated one,
   *  otherwise every collected check passing. False while `ran` is false. */
  proven: boolean;
  /** The engine's closing line, for display. */
  summary: string;
  /** Raw stdout+stderr, for the "show me" disclosure. */
  raw: string;
};

/** `unknown` is "we couldn't check", and is not a shade of failure. */
export type ProveTone = "ok" | "partial" | "fail" | "unknown";

/** The banner the report prints before its first check. Its presence is what
 *  tells us a report was rendered at all rather than an error line. */
const REPORT_BANNER = "SEMANTIC PROOF REPORT";

// The report is written with `colored`, which emits escapes whenever it thinks
// it's attached to a terminal. Through the app's pipe it usually doesn't — but
// "usually" decides whether `line.startsWith("✓")` matches, so we don't leave
// it to chance.
const ANSI = /\[[0-9;]*m/g;

/** True for the engine's own closing verdict lines, which we must not confuse
 *  with a check. It prints `🛡️  Goal 'X' is MATHEMATICALLY PROVEN!` when
 *  everything passed and `❌ Goal 'X' is NOT PROVEN (3 of 5 …)` otherwise. */
function statedVerdict(line: string): boolean | null {
  if (/NOT\s+PROVEN/i.test(line)) return false;
  if (/\bPROVEN\b/i.test(line)) return true;
  return null;
}

export function parseProveOutput(text: string, status = 0): ProveResult {
  const raw = text.trim();
  const lines = text
    .split("\n")
    .map((l) => l.replace(ANSI, "").trim())
    .filter((l) => l.length > 0);

  const checks: Check[] = [];
  let stated: boolean | null = null;
  let summary = "";
  let sawBanner = false;
  // The first `✗` line, kept aside: it's a failed check inside a report and
  // the whole message when the proof couldn't run.
  let firstCross = "";

  for (const line of lines) {
    if (line.includes(REPORT_BANNER)) {
      sawBanner = true;
      continue;
    }

    const verdict = statedVerdict(line);
    if (verdict !== null) {
      stated = verdict;
      summary = line.replace(/^[^\p{L}\p{N}]+/u, "").trim();
      continue;
    }

    // `↳ ✗ NOT wired to 'chargeCard'` — a failure belonging to the check above
    // it, which the engine printed on a passing-looking `✓` line.
    if (line.startsWith("↳")) {
      const prev = checks[checks.length - 1];
      if (prev && /NOT wired/i.test(line)) {
        prev.ok = false;
        prev.unwired = true;
        prev.line = `${prev.line} · ${line.replace(/^↳\s*✗?\s*/, "")}`;
      }
      continue;
    }

    const missing = line.startsWith("✗");
    const stub = line.startsWith("⚠");
    const built = line.startsWith("✓");
    if (!missing && !stub && !built) continue;
    if (missing && !firstCross) firstCross = line.replace(/^✗\s*/, "").trim();

    const body = line.replace(/^(?:✗|⚠️?|✓)\s*/, "").trim();
    const m = /^(\w+)\s+'([^']+)'/.exec(body);
    checks.push({
      ok: built,
      stub,
      unwired: false,
      line: body,
      kind: m?.[1] ?? null,
      identifier: m?.[2] ?? null,
    });
  }

  // Did a proof actually happen? The banner is the direct evidence. Without it
  // we'll still accept a stated verdict, or a check line that names a symbol —
  // an older engine formatting its report differently has still told us
  // something. What we won't accept is a bare `✗` sentence: that's the error
  // branch, which prints its reason and returns before the banner. The two are
  // told apart by the quoted identifier every real check carries
  // (`Function 'chargeCard' is missing from the AST!`) and no error line does
  // (`Not a git repository.`).
  const named = checks.some((c) => c.identifier !== null || c.ok || c.stub);
  const ran = status === 0 && (sawBanner || stated !== null || named);

  if (!ran) {
    const reason =
      firstCross ||
      (status !== 0 ? lines[lines.length - 1] : "") ||
      "Aura didn’t return a result for this check.";
    return {
      ran: false,
      blocked: reason,
      checks: [],
      stated: null,
      proven: false,
      summary: "",
      raw,
    };
  }

  // The engine's word is the verdict. We count only when it didn't say — and
  // a report with no checks in it has proven nothing.
  const proven =
    stated !== null ? stated : checks.length > 0 && checks.every((c) => c.ok);

  return { ran: true, blocked: null, checks, stated, proven, summary, raw };
}

/** Reduce a report to a tone plus the in-place/total counts.
 *
 *  `ok` requires the engine to have said so, or — where it didn't say — every
 *  check it printed to have passed. It can no longer be reached by a count the
 *  parser inflated. */
export function verdictOf(result: ProveResult): {
  tone: ProveTone;
  ok: number;
  total: number;
} {
  if (!result.ran) return { tone: "unknown", ok: 0, total: 0 };

  const ok = result.checks.filter((c) => c.ok).length;
  const total = result.checks.length;

  // A report that ran but listed nothing has found nothing either way.
  if (total === 0) {
    return { tone: result.stated === true ? "ok" : "unknown", ok, total };
  }
  if (result.proven) return { tone: "ok", ok, total };
  return { tone: ok === 0 ? "fail" : "partial", ok, total };
}

/** What's still in the way, worst first, for a surface with room for a few.
 *  Stubs lead: a placeholder reads as finished everywhere else in the app. */
export function gaps(result: ProveResult): Check[] {
  const rank = (c: Check) => (c.stub ? 0 : c.unwired ? 1 : 2);
  return result.checks.filter((c) => !c.ok).sort((a, b) => rank(a) - rank(b));
}

/** Why a check isn't passing, in words that carry the difference between
 *  "missing", "a placeholder" and "never called". */
export function gapKind(c: Check): string {
  if (c.stub) return "started, but still empty";
  if (c.unwired) return "built, but nothing calls it";
  return "not built yet";
}
