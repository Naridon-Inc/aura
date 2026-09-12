// bringBack — what the "Bring this back" button asks the engine, and how it
// reads the answer.
//
// The button used to run `aura rewind <symbol> <file>` and call it a success
// if the process exited 0. Three things were wrong with that, and they are
// the reason this file exists:
//
//   · There was no preview. The one verb whose whole job is undoing a change
//     you did not want was the one verb you had to run blind — the dialog
//     could offer a name and a filename and ask you to trust it.
//   · A name can mean two things in one file (a struct and its impl block,
//     two methods on different classes). The engine took whichever it found
//     first, so the button could rewrite something nobody chose.
//   · Exit 0 was treated as proof. The engine printed "Rewind aborted —
//     nothing was written" and then returned success, so the banner painted
//     green over a file nothing had happened to.
//
// The engine now answers in JSON and exits non-zero when it declines. This
// module keeps the shell honest about reading that: nothing counts as a
// recovery unless the engine says `ok` **and** `applied`.
//
// Kept free of React and Tauri so it can be tested as what it is — a parser.

/** A run of the CLI, as `api.auraCli` hands it back. */
export type CliRun = { stdout: string; stderr: string; status: number };

/** What one recovery would change, worked out but not done. */
export type BringBackPlan = {
  symbol: string;
  file: string;
  /** The piece is not in the file at all right now, so this puts it back. */
  deleted: boolean;
  /** Where the version being brought back came from, in plain words. */
  origin: string;
  /** The piece as it stands. Absent when it was deleted. */
  current: string | null;
  /** The piece as it would stand. */
  restored: string;
  /** True when this is undoing an earlier recovery rather than making one. */
  undo: boolean;
};

/** Either something to show a person, or the reason there is nothing to do. */
export type PlanResult =
  | { ok: true; plan: BringBackPlan }
  | { ok: false; message: string };

export type ApplyResult =
  | { ok: true; origin: string }
  | { ok: false; message: string };

/** Ask what would happen. Writes nothing. */
export function previewArgs(symbol: string, file: string, undo = false): string[] {
  const args = ["rewind", symbol, file, "--preview", "--json"];
  return undo ? [...args, "--undo"] : args;
}

/** Do it. */
export function applyArgs(symbol: string, file: string, undo = false): string[] {
  const args = ["rewind", symbol, file, "--json"];
  return undo ? [...args, "--undo"] : args;
}

function firstMeaningfulLine(s: string): string {
  for (const line of (s ?? "").split("\n")) {
    const t = line.trim();
    if (t) return t;
  }
  return "";
}

/** An engine that predates the preview says so in a way clap wrote, not us. */
function looksLikeAnOldEngine(res: CliRun): boolean {
  return /unexpected argument|unrecognized (?:option|argument)|--preview/i.test(
    res.stderr ?? "",
  );
}

const OLD_ENGINE =
  "This needs a newer version of the Aura engine — it can't show you what would change before doing it. Update Aura, then try again.";

function parse(res: CliRun): Record<string, unknown> | null {
  const text = (res.stdout ?? "").trim();
  if (!text) return null;
  try {
    const v = JSON.parse(text);
    return v && typeof v === "object" ? (v as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

function str(v: unknown): string {
  return typeof v === "string" ? v : "";
}

/**
 * Read a `--preview --json` run into something to show, or into the sentence
 * that explains why there is nothing to show. Every refusal the engine can
 * make — the name means two things, nothing was ever saved, this file's
 * language isn't understood — arrives here as `ok: false` with the engine's
 * own words, which are written for the person reading them.
 */
export function readPreview(res: CliRun, symbol: string, file: string): PlanResult {
  const body = parse(res);
  if (!body) {
    if (looksLikeAnOldEngine(res)) return { ok: false, message: OLD_ENGINE };
    return {
      ok: false,
      message:
        firstMeaningfulLine(res.stderr) ||
        `Aura couldn't work out what bringing "${symbol}" back would change.`,
    };
  }
  if (body.ok !== true) {
    return {
      ok: false,
      message:
        str(body.message) ||
        `Aura can't bring "${symbol}" back in ${file}.`,
    };
  }
  // The engine worked it out and it comes to nothing. Saying "brought back"
  // over an unchanged file is the same lie as reporting exit 0 was.
  if (body.no_change === true) {
    return {
      ok: false,
      message: `"${symbol}" is already the same as its saved version, so there's nothing to bring back.`,
    };
  }
  const restored = str(body.restored);
  if (!restored) {
    return {
      ok: false,
      message: `Aura found a saved version of "${symbol}" but couldn't read it back.`,
    };
  }
  return {
    ok: true,
    plan: {
      symbol: str(body.identifier) || symbol,
      file: str(body.file) || file,
      deleted: body.deleted === true,
      origin: str(body.origin_plain) || str(body.origin),
      current: typeof body.current === "string" ? body.current : null,
      restored,
      undo: body.undo === true,
    },
  };
}

/**
 * Read the run that actually writes. `applied` has to be true in the engine's
 * own answer: an exit code is a claim about a process, not about a file.
 */
export function readApply(res: CliRun, symbol: string): ApplyResult {
  const body = parse(res);
  if (!body) {
    if (looksLikeAnOldEngine(res)) return { ok: false, message: OLD_ENGINE };
    return {
      ok: false,
      message:
        firstMeaningfulLine(res.stderr) ||
        `Aura exited with ${res.status} and didn't say what happened to "${symbol}".`,
    };
  }
  if (body.ok !== true || body.applied !== true) {
    return {
      ok: false,
      message: str(body.message) || `"${symbol}" was not changed.`,
    };
  }
  return { ok: true, origin: str(body.origin_plain) || str(body.origin) };
}
