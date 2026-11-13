// Aura-aware metadata for the currently open file — everything the "What
// changed" block over the editor's diff draws, gathered from the streams the
// user otherwise has to chase across separate panels:
//   1. the file's diff against the last commit (which lines moved)
//   2. the semantic outline → which pieces the edit added, removed or reworked
//      (see workingPieces), and for each one the model-written plain line
//   3. for a data file (JSON / TOML / YAML), both versions read as data and
//      compared structurally (see dataDiff) — what was added, dropped, changed
//   4. the file-level "used to / now" account and the reason recorded for it
//   5. the intent-log notes bound to this file — the "why", in the writer's
//      own words — with their time normalised to milliseconds as they enter
//   6. how many recoverable snapshots exist for it
//
// Polled lightly (8s) so the block stays in sync with terminal-driven
// `aura snapshot` / `aura log-intent` invocations without flooding the bridge.
// The model-written words are re-asked a few times while they are still being
// written, then left alone.

import { useEffect, useMemo, useState } from "react";
import { api, type ChangedSymbol, type IntentEntry, type OutlineNode } from "./api";
import {
  loadExplanation,
  loadSymbolExplanations,
  type ChangeExplanation,
  type SymbolMeanings,
} from "./changeExplain";
import { describeDataChange, type DataChangeRow } from "./dataDiff";
import { dataFormatOf } from "./dataParse";
import { noteFromAskHit, noteFromIntent, rankNotes, type InsightNote } from "./insightNotes";
import { useDocumentVisibility } from "./useDocumentVisibility";
import { workingPieces } from "./workingPieces";

const POLL_MS = 8000;
/** How long to keep looking while the model writes the plain words. A cold
 *  agent-CLI spawn is ~20s per line, so this is a generous window. */
const WORDS_TRIES = 10;
const WORDS_POLL_MS = 3500;

export type FileInsight = {
  /** True until the first read of the diff lands. */
  loading: boolean;
  /** +/- line counts vs the last commit for the whole file. */
  additions: number;
  deletions: number;
  /** Code pieces this edit added, removed or reworked, in file order. */
  pieces: ChangedSymbol[];
  /** Per-piece plain lines (model-written), keyed by identifier. */
  meanings: SymbolMeanings;
  /** A data file's structural change; null for code, or when either version
   *  does not read as data. */
  dataRows: DataChangeRow[] | null;
  /** The file-level used-to / now / why account; null until it lands. */
  explanation: ChangeExplanation | null;
  /** True while the model may still be writing any of the words above. */
  writing: boolean;
  /** Notes bound to this file, stated reasons first. Times in milliseconds. */
  notes: InsightNote[];
  /** The newest note anywhere in the repo — the session's stated reason, for
   *  when nothing is bound to this file. */
  sessionNote: InsightNote | null;
  snapshotCount: number;
};

const NO_MEANINGS: SymbolMeanings = { now: new Map(), before: new Map(), complete: true };

export function useFileInsight(
  repoRoot: string | null | undefined,
  absPath: string | null | undefined,
): FileInsight {
  const [loading, setLoading] = useState<boolean>(!!absPath);
  const [diffText, setDiffText] = useState<string>("");
  const [outline, setOutline] = useState<OutlineNode[]>([]);
  const [boundNotes, setBoundNotes] = useState<InsightNote[]>([]);
  const [askNotes, setAskNotes] = useState<InsightNote[]>([]);
  const [sessionNote, setSessionNote] = useState<InsightNote | null>(null);
  const [snapshotCount, setSnapshotCount] = useState<number>(0);
  const [dataRows, setDataRows] = useState<DataChangeRow[] | null>(null);
  const [explanation, setExplanation] = useState<ChangeExplanation | null>(null);
  const [explaining, setExplaining] = useState(false);
  const [meanings, setMeanings] = useState<SymbolMeanings>(NO_MEANINGS);
  const visible = useDocumentVisibility();

  const relPath = useMemo(() => {
    if (!repoRoot || !absPath) return null;
    if (absPath.startsWith(repoRoot + "/")) return absPath.slice(repoRoot.length + 1);
    return absPath;
  }, [repoRoot, absPath]);

  const basename = useMemo(() => {
    if (!relPath) return null;
    return relPath.split("/").pop() ?? relPath;
  }, [relPath]);

  // The bound-changeset pass below only sees the newest fifty rows, and the
  // mutation guard writes one per agent tool call — on a busy repo that is
  // minutes of history. This asks the whole log through the same ranking
  // `aura ask` uses, so a stated reason from last week still shows. Keyed on
  // the path rather than the poll: the answer for a file does not change
  // between two ticks.
  useEffect(() => {
    if (!repoRoot || !relPath) {
      setAskNotes([]);
      return;
    }
    let cancelled = false;
    void api
      .auraAsk(repoRoot, relPath, 5)
      .then((answer) => {
        if (!cancelled) setAskNotes(answer.hits.map((h, i) => noteFromAskHit(h, relPath, i)));
      })
      .catch(() => {
        if (!cancelled) setAskNotes([]);
      });
    return () => {
      cancelled = true;
    };
  }, [repoRoot, relPath]);

  useEffect(() => {
    if (!repoRoot || !absPath || !relPath) return;
    let cancelled = false;
    async function tick() {
      try {
        const [diff, out, page, snaps] = await Promise.all([
          api.gitDiff(repoRoot!, relPath!).catch(() => ""),
          api.auraSemanticOutline(repoRoot!, absPath!).catch(() => [] as OutlineNode[]),
          api.auraReadIntentLogV2(repoRoot!, 50).catch(() => null),
          api.auraListSnapshots(repoRoot!).catch(() => []),
        ]);
        if (cancelled) return;
        setDiffText(diff);
        setOutline((prev) => (sameOutline(prev, out) ? prev : out));
        if (page) {
          // A note belongs to this file by its BOUND CHANGESET when it has one
          // — authoritative, whatever its prose names. Legacy rows written
          // before changeset binding fall back to naming the file in the text.
          const matches = page.entries.filter((e) => touchesFile(e, relPath!, basename!));
          setBoundNotes(matches.slice(0, 5).map(noteFromIntent));
          setSessionNote(page.entries[0] ? noteFromIntent(page.entries[0]) : null);
        }
        // Snapshots don't always store an absolute path — match by suffix.
        setSnapshotCount(
          snaps.filter((s) => s.file === absPath || s.file.endsWith("/" + relPath!)).length,
        );
      } finally {
        if (!cancelled) setLoading(false);
      }
    }
    void tick();
    if (!visible) return () => {
      cancelled = true;
    };
    const id = window.setInterval(tick, POLL_MS);
    return () => {
      cancelled = true;
      window.clearInterval(id);
    };
  }, [repoRoot, absPath, relPath, basename, visible]);

  // A data file: read the last commit's version and the one on disk, and
  // compare them as data. Keyed on the diff, so it only reruns when the file
  // actually changes.
  useEffect(() => {
    if (!repoRoot || !absPath || !relPath || !dataFormatOf(relPath) || !diffText.trim()) {
      setDataRows(null);
      return;
    }
    let cancelled = false;
    const isNewFile = /^(new file mode|--- \/dev\/null)/m.test(diffText);
    void Promise.all([
      api.gitShowHead(repoRoot, relPath).catch(() => (isNewFile ? "" : null)),
      api.readFile(absPath).catch(() => null),
    ]).then(([before, after]) => {
      if (cancelled) return;
      if (before === null || !after || after.status !== "ok") {
        setDataRows(null);
        return;
      }
      setDataRows(describeDataChange(relPath, before, after.text));
    });
    return () => {
      cancelled = true;
    };
  }, [repoRoot, absPath, relPath, diffText]);

  // The file-level used-to / now / why. The backend answers instantly (cached
  // model words, or lines mined from the diff) and writes the model's words
  // off the request path, so this looks again a few times until they land.
  useEffect(() => {
    if (!repoRoot || !relPath || !diffText.trim()) {
      setExplanation(null);
      setExplaining(false);
      return;
    }
    let alive = true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let tries = 0;
    setExplaining(true);
    const poll = () => {
      void loadExplanation(repoRoot, relPath).then((e) => {
        if (!alive) return;
        setExplanation(e);
        const stillWriting = e.source === "fallback" || e.source === "mixed";
        if (stillWriting && tries < WORDS_TRIES) {
          tries += 1;
          timer = setTimeout(poll, WORDS_POLL_MS);
        } else {
          setExplaining(false);
        }
      });
    };
    poll();
    return () => {
      alive = false;
      if (timer) clearTimeout(timer);
    };
  }, [repoRoot, relPath, diffText]);

  const { additions, deletions } = useMemo(() => countLines(diffText), [diffText]);

  // Code pieces only — a data file is told by `dataRows` instead.
  const pieces = useMemo(
    () => (relPath && dataFormatOf(relPath) ? [] : workingPieces(diffText, outline)),
    [diffText, outline, relPath],
  );
  const piecesKey = pieces.map((p) => `${p.change}:${p.identifier}`).join("|");

  // Each piece's own plain line, model-written; re-asked while it's written.
  useEffect(() => {
    if (!repoRoot || !relPath || !pieces.length) {
      setMeanings(NO_MEANINGS);
      return;
    }
    let alive = true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let tries = 0;
    const poll = () => {
      void loadSymbolExplanations(repoRoot, relPath, pieces).then((m) => {
        if (!alive) return;
        setMeanings(m);
        if (!m.complete && tries < WORDS_TRIES) {
          tries += 1;
          timer = setTimeout(poll, WORDS_POLL_MS);
        }
      });
    };
    poll();
    return () => {
      alive = false;
      if (timer) clearTimeout(timer);
    };
    // `pieces` is read through its key: a poll that finds the same pieces must
    // not restart the wait for their words.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [repoRoot, relPath, piecesKey, diffText]);

  return {
    loading,
    additions,
    deletions,
    pieces,
    meanings,
    dataRows,
    explanation,
    writing: explaining || (pieces.length > 0 && !meanings.complete),
    // The bound-changeset match is authoritative when it finds anything; the
    // ranked answer covers everything older than the window it can see.
    notes: rankNotes(boundNotes.length > 0 ? boundNotes : askNotes),
    sessionNote,
    snapshotCount,
  };
}

function touchesFile(e: IntentEntry, relPath: string, basename: string): boolean {
  const files = e.changeset?.files;
  if (files && files.length > 0) {
    return files.some((f) => f.path === relPath || f.path.endsWith("/" + relPath));
  }
  return e.intent.includes(basename) || e.intent.includes(relPath);
}

function sameOutline(a: OutlineNode[], b: OutlineNode[]): boolean {
  return (
    a.length === b.length &&
    a.every((n, i) => n.name === b[i].name && n.line === b[i].line && n.kind === b[i].kind)
  );
}

/** Per-file +/- from the diff, skipping the `+++` / `---` header lines. */
function countLines(diff: string): { additions: number; deletions: number } {
  let additions = 0;
  let deletions = 0;
  for (const line of diff.split("\n")) {
    if (line.startsWith("+++") || line.startsWith("---")) continue;
    if (line.startsWith("+")) additions++;
    else if (line.startsWith("-")) deletions++;
  }
  return { additions, deletions };
}
