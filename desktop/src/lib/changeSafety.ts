// "Nothing here looks risky — no unfinished code, no deletions, no secrets."
//
// That sentence is the safety line on a session's Alignment card. It is read
// by someone who did not write the code and cannot check it themselves, which
// makes it the most consequential claim in the app. It was computed like this:
//
//     const nodes = deriveNodes(report);
//     const secrets = nodes.filter((n) => n.contains_secret).length;
//     const stubs   = nodes.filter((n) => n.is_stub).length;
//
// and `deriveNodes` falls back, when `report.nodes` is absent, to synthesising
// node records out of the flat `modified_nodes` / `added_nodes` /
// `deleted_nodes` string arrays. Those synthesised records carry no
// `contains_secret` and no `is_stub` — the fields are `undefined`, the filters
// return nothing, and the card announces that there are no secrets, having
// never looked for one.
//
// It is not a rare path. The CLI emits the flat arrays unconditionally and the
// structured nodes only for symbols it could resolve back to a parsed AST
// node (`intent_vs_actual.rs`: `added.insert(ident)` always, `if let Some(n) =
// find_node(…)` for the node record) — and `nodes` is dropped entirely when
// that list comes out empty. So the scan can be missing altogether, or it can
// cover a strict subset while the card reports on all of it.
//
// Everything here therefore travels with its coverage. A scan that did not run
// is not a scan that found nothing.

export type SafetyTone = "risk" | "attention" | "calm";

export type SafetyLine =
  | { kind: "secrets"; tone: "risk"; text: string }
  | { kind: "worth"; tone: "attention"; text: string }
  | { kind: "partial"; tone: "attention"; text: string }
  | { kind: "unscanned"; tone: "calm"; text: string }
  | { kind: "clean"; tone: "calm"; text: string }
  | { kind: "none" };

/** The counts the safety line is computed from, and — the point of this
 *  module — how many of the changed symbols the scan actually covered. */
export type ChangeCounts = {
  /** Distinct changed symbols, from the flat arrays the CLI always emits. */
  total: number;
  /** Symbols carrying a real scan result. `report.nodes`, when present. */
  scanned: number;
  secrets: number;
  stubs: number;
  deletions: number;
  /** Files the run touched. */
  files: number;
};

/** The shape of an alignment report this module needs. Structural on purpose:
 *  the report type lives with the component that loads it, and a lib reaching
 *  back into a component is the wrong direction. */
export type SafetyReportLike = {
  modified_nodes: string[];
  added_nodes: string[];
  deleted_nodes: string[];
  changed_files: string[];
  nodes?: Array<{
    change: string;
    is_stub?: boolean;
    contains_secret?: boolean;
  }>;
};

export function changeCounts(report: SafetyReportLike): ChangeCounts {
  const flat =
    report.modified_nodes.length +
    report.added_nodes.length +
    report.deleted_nodes.length;
  const nodes = report.nodes ?? [];
  return {
    // The flat arrays are the authoritative set of what changed. The card used
    // to count `nodes.length`, which is the *scanned* set — so a partial scan
    // also under-reported how much the AI had changed.
    total: Math.max(flat, nodes.length),
    scanned: nodes.length,
    secrets: nodes.filter((n) => n.contains_secret === true).length,
    stubs: nodes.filter((n) => n.is_stub === true).length,
    // Deletions come from the flat array, which is always emitted — the one
    // signal of the three that never depended on the scan.
    deletions: report.deleted_nodes.length,
    files: report.changed_files.length,
  };
}

function list(parts: string[]): string {
  if (parts.length === 1) return parts[0];
  if (parts.length === 2) return `${parts[0]} and ${parts[1]}`;
  return `${parts.slice(0, -1).join(", ")}, and ${parts[parts.length - 1]}`;
}

/** How much of this run Aura actually inspected, in plain words — `null` when
 *  it inspected all of it. */
export function coverageCaveat(c: ChangeCounts): string | null {
  if (c.total === 0 || c.scanned >= c.total) return null;
  if (c.scanned === 0)
    return "Aura couldn’t look inside this run’s changes, so it can’t tell you whether there are secrets or unfinished code in them.";
  return `Aura could only look inside ${c.scanned} of the ${c.total} things that changed, so this doesn’t cover all of it.`;
}

export function safetyLine(c: ChangeCounts): SafetyLine {
  const caveat = coverageCaveat(c);

  // A found secret is a found secret, whatever else went unscanned.
  if (c.secrets > 0) {
    const base = `Heads up · ${c.secrets} ${
      c.secrets === 1 ? "spot looks" : "spots look"
    } like a password or key written straight into the code. Worth checking before this goes anywhere.`;
    return { kind: "secrets", tone: "risk", text: caveat ? `${base} ${caveat}` : base };
  }

  const worth: string[] = [];
  if (c.stubs > 0)
    worth.push(
      `${c.stubs} unfinished ${c.stubs === 1 ? "bit" : "bits"} (a TODO/placeholder)`,
    );
  if (c.deletions > 0)
    worth.push(`${c.deletions} ${c.deletions === 1 ? "deletion" : "deletions"}`);

  if (worth.length > 0) {
    const base = `Worth a look: ${list(worth)}.`;
    return {
      kind: "worth",
      tone: "attention",
      // The old copy ended "Nothing else here looks risky." — a second claim,
      // about everything it hadn't named, from the same unscanned set.
      text: caveat ? `${base} ${caveat}` : `${base} Nothing else here looks risky.`,
    };
  }

  if (c.total === 0 && c.files === 0) return { kind: "none" };

  // Nothing found — but only "clean" if there was nothing left unlooked-at.
  if (caveat) {
    // Nothing was looked at vs. some of it was looked at are different
    // admissions, and only the second is worth an amber.
    return c.scanned === 0
      ? { kind: "unscanned", tone: "calm", text: caveat }
      : { kind: "partial", tone: "attention", text: caveat };
  }
  if (c.total === 0) return { kind: "none" };
  return {
    kind: "clean",
    tone: "calm",
    text: "Nothing here looks risky. No unfinished code, no deletions, no secrets.",
  };
}

/** The "how much changed" line. Counts the authoritative flat set, not the
 *  subset the scan resolved. */
export function changeSummary(c: ChangeCounts): string {
  if (c.total > 0) {
    const things = `${c.total} ${c.total === 1 ? "thing" : "things"}`;
    const where =
      c.files > 0 ? ` across ${c.files} ${c.files === 1 ? "file" : "files"}` : "";
    return `The AI changed ${things}${where}.`;
  }
  if (c.files > 0) {
    return `The AI touched ${c.files} ${
      c.files === 1 ? "file" : "files"
    }. Settings or data, not code Aura breaks down piece by piece.`;
  }
  return "No file changes were recorded for this run.";
}
