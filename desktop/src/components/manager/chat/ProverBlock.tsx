import { accentTint } from "../../../lib/agentIdentity";
import { percent } from "../../../lib/percent";

// ─── Aura Prover formatting ───────────────────────────────────────────
// `aura prove` dumps a colored terminal report — header, analyzing
// bullets, "SEMANTIC PROOF REPORT" section, per-requirement lines.
// When it lands in agent prose it's a wall of mojibake-looking text.
// Parse it into a structured report so we can render a proper card.

type ProverCheckStatus = "passed" | "stub" | "missing" | "unwired";
type ProverCheck = {
  status: ProverCheckStatus;
  node_type: string;
  node_name: string;
  /** Optional wiring detail line, e.g. "Properly wired to bar". */
  wiring?: { status: "passed" | "missing"; target: string };
};
export type ProverReport = {
  goal: string;
  checks: ProverCheck[];
  passed: number;
  total: number;
};

/** Pull a contiguous Aura Prover block out of `source`. Returns the
 *  stripped source (with the block removed) plus the parsed report. */
export function extractProverBlock(source: string): {
  stripped: string;
  prover: ProverReport | null;
} {
  const headerRe = /(?:🧪|🪄)\s*Aura Prover:\s*Verifying Goal Achievement:\s*(.+)/;
  const hm = source.match(headerRe);
  if (!hm) return { stripped: source, prover: null };
  const startIdx = source.indexOf(hm[0]);
  // Block ends at next blank line *after* we've seen the report
  // section, or at EOF. We greedily consume lines until a blank line
  // following a "SEMANTIC PROOF REPORT" marker is reached.
  const tail = source.slice(startIdx);
  const lines = tail.split("\n");
  let endLine = lines.length;
  let seenReport = false;
  for (let i = 0; i < lines.length; i++) {
    if (/SEMANTIC PROOF REPORT/.test(lines[i])) {
      seenReport = true;
      continue;
    }
    if (seenReport && lines[i].trim() === "") {
      endLine = i;
      break;
    }
  }
  const block = lines.slice(0, endLine).join("\n");
  const stripped = source.slice(0, startIdx) + source.slice(startIdx + block.length);
  const prover = parseProverBlock(block, hm[1].trim());
  return { stripped, prover };
}

function parseProverBlock(block: string, goal: string): ProverReport {
  const checks: ProverCheck[] = [];
  const lines = block.split("\n");
  let last: ProverCheck | null = null;
  for (const raw of lines) {
    const line = raw.replace(/\s+$/, "");
    // Top-level requirement line: "✓ Function 'foo' exists and is substantive."
    const ok = line.match(/^[\s]*✓\s+(\w+)\s+'([^']+)'\s+exists/);
    if (ok) {
      last = { status: "passed", node_type: ok[1], node_name: ok[2] };
      checks.push(last);
      continue;
    }
    const stub = line.match(
      /^[\s]*(?:⚠️|⚠)\s+(\w+)\s+'([^']+)'\s+exists but is a STUB/i,
    );
    if (stub) {
      last = { status: "stub", node_type: stub[1], node_name: stub[2] };
      checks.push(last);
      continue;
    }
    const missing = line.match(
      /^[\s]*✗\s+(\w+)\s+'([^']+)'\s+(MISSING|not found)/i,
    );
    if (missing) {
      last = {
        status: "missing",
        node_type: missing[1],
        node_name: missing[2],
      };
      checks.push(last);
      continue;
    }
    // Wiring sub-line: "  ↳ Properly wired to 'bar'" / "  ↳ ✗ NOT wired to 'bar'"
    const wiredOk = line.match(/↳\s+Properly wired to\s+'?([^'\s]+)'?/);
    if (wiredOk && last) {
      last.wiring = { status: "passed", target: wiredOk[1] };
      continue;
    }
    const wiredBad = line.match(/↳\s+✗?\s*NOT wired to\s+'?([^'\s]+)'?/);
    if (wiredBad && last) {
      last.wiring = { status: "missing", target: wiredBad[1] };
      if (last.status === "passed") last.status = "unwired";
      continue;
    }
  }
  const passed = checks.filter(
    (c) => c.status === "passed" && c.wiring?.status !== "missing",
  ).length;
  return { goal, checks, passed, total: checks.length };
}

export function ProverBlock({ report }: { report: ProverReport }) {
  const pct = percent(report.passed, report.total);
  return (
    <div
      className="aura-block flex flex-col"
      style={{ background: "var(--color-bg-1)" }}
    >
      <div
        className="flex items-center justify-between gap-2 px-2.5 py-1.5"
        style={{ borderBottom: "1px solid var(--color-line-soft)" }}
      >
        <div className="flex items-center gap-2 min-w-0">
          <span className="aura-block-label">AURA PROVER</span>
          <span
            className="truncate text-sm"
            style={{ color: "var(--color-text-2)" }}
            title={report.goal}
          >
            {report.goal}
          </span>
        </div>
        <span
          className="shrink-0"
          style={{
            fontFamily: "var(--font-mono)",
            fontSize: "10.5px",
            // Green off the counts, never off the percent. A rounded 100
            // on 199 of 200 painted this line green and called it all passed.
            color:
              report.total > 0 && report.passed === report.total
                ? "var(--color-accent-green)"
                : "var(--color-text-3)",
            letterSpacing: "0.04em",
          }}
        >
          {report.passed}/{report.total} PASSED · {pct}%
        </span>
      </div>
      <div className="flex flex-col">
        {report.checks.map((c, i) => (
          <ProverCheckRow key={i} check={c} />
        ))}
      </div>
    </div>
  );
}

function ProverCheckRow({ check }: { check: ProverCheck }) {
  const palette: Record<ProverCheckStatus, { color: string; label: string; mark: string }> = {
    passed: { color: "var(--color-accent-green)", label: "PASS", mark: "✓" },
    stub: { color: "var(--color-amber)", label: "STUB", mark: "!" },
    missing: { color: "var(--color-red)", label: "MISSING", mark: "✗" },
    unwired: { color: "var(--color-red)", label: "UNWIRED", mark: "✗" },
  };
  const p = palette[check.status];
  return (
    <div
      className="flex items-center gap-2 px-2.5 py-1.5"
      style={{ borderTop: "1px solid var(--color-line-soft)" }}
    >
      <span
        className="shrink-0 inline-flex items-center justify-center"
        style={{
          width: 14,
          height: 14,
          borderRadius: 3,
          background: accentTint(p.color, 18),
          color: p.color,
          fontFamily: "var(--font-mono)",
          fontSize: "10.5px",
          fontWeight: 600,
        }}
      >
        {p.mark}
      </span>
      <span
        className="shrink-0"
        style={{
          fontFamily: "var(--font-mono)",
          fontSize: "10.5px",
          letterSpacing: "0.04em",
          color: p.color,
          minWidth: 64,
        }}
      >
        {p.label}
      </span>
      <span
        className="shrink-0 px-1 py-[1px]"
        style={{
          fontFamily: "var(--font-mono)",
          fontSize: "10px",
          color: "var(--color-text-3)",
          border: "1px solid var(--color-line-soft)",
          borderRadius: 3,
        }}
      >
        {check.node_type}
      </span>
      <span
        className="min-w-0 truncate"
        style={{
          fontFamily: "var(--font-mono)",
          fontSize: "12px",
          color: "var(--color-text-1)",
        }}
      >
        {check.node_name}
      </span>
      {check.wiring && (
        <span
          className="ml-auto shrink-0 text-xs"
          style={{
            color:
              check.wiring.status === "passed"
                ? "var(--color-text-3)"
                : "var(--color-red)",
            fontFamily: "var(--font-mono)",
          }}
        >
          {check.wiring.status === "passed" ? "→ " : "⚠ NOT → "}
          {check.wiring.target}
        </span>
      )}
    </div>
  );
}
