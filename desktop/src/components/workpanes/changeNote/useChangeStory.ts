// What the diff header reads, beyond the change note it is handed: the Code
// Atlas meanings, the model-written story of the change (used to / now / why),
// each piece's own model line, and which piece the reader picked. The header
// paints at once from the grounded change note; each of these upgrades it in
// place when it lands, with no spinner the reader notices.

import { useEffect, useState } from "react";

import type { ChangedSymbol, FileChangeNote } from "../../../lib/api";
import { loadAtlasIndex, lookupEntry, type AtlasIndex } from "../../../lib/atlasHover";
import {
  forgetExplanation,
  loadExplanation,
  loadSymbolExplanations,
  type ChangeExplanation,
  type SymbolMeanings,
} from "../../../lib/changeExplain";
import { onSide, pieceLine, pieceTitle } from "./changeWords";
import type { ChangeSideName } from "./ChangeSides";

/** The piece the reader clicked, handed up so the diff below can highlight its
 *  lines and carry its plain-language line down there with it. Re-sent whenever
 *  the model finishes writing that line, so the caption upgrades in place
 *  exactly as the piece above does. */
export type FocusPick = {
  side: ChangeSideName;
  symbol: ChangedSymbol;
  title: string;
  meaning: string;
};

/** The Code Atlas meaning index for this repo (one shared read per repo).
 *  Null until it lands, or when there is none — the pieces then fall back to
 *  humanised identifiers. */
export function useAtlasIndex(repoRoot: string): AtlasIndex | null {
  const [index, setIndex] = useState<AtlasIndex | null>(null);
  useEffect(() => {
    let alive = true;
    loadAtlasIndex(repoRoot).then((idx) => {
      if (alive) setIndex(idx);
    });
    return () => {
      alive = false;
    };
  }, [repoRoot]);
  return index;
}

/** The model-written story of one file's change, cached, plus a retry for a
 *  request that failed. Retry touches nothing else: the picked piece, whether
 *  the pieces are open and the diff's scroll stay where the reader put them. */
export function useChangeExplanation(
  repoRoot: string,
  file: string,
  commit: string | null | undefined,
): [ChangeExplanation | null, () => void] {
  const [exp, setExp] = useState<ChangeExplanation | null>(null);
  const [retry, setRetry] = useState(0);
  useEffect(() => {
    let alive = true;
    setExp(null);
    loadExplanation(repoRoot, file, commit).then((e) => {
      if (alive) setExp(e);
    });
    return () => {
      alive = false;
    };
  }, [repoRoot, file, commit, retry]);
  const again = () => {
    forgetExplanation(repoRoot, file, commit);
    setRetry((n) => n + 1);
  };
  return [exp, again];
}

const EMPTY_MEANINGS = (): SymbolMeanings => ({
  now: new Map(),
  before: new Map(),
  complete: true,
});

/** How many times to look again while the model is still writing per-piece
 *  lines. A cold agent-CLI spawn is ~20s each, so this is a generous window;
 *  a later reopen finishes whatever is left. */
const MEANING_TRIES = 10;
const MEANING_POLL_MS = 3500;

/** What EACH changed piece does now and used to do, in plain words — always
 *  model-written, never a mined variable name. The file-level line can't be
 *  split across several pieces, so this is what makes every piece say
 *  something real. Polled while the model is still writing, so the words swap
 *  in live without the change being reopened. */
export function useSymbolMeanings(
  repoRoot: string,
  note: FileChangeNote,
  commit: string | null | undefined,
): SymbolMeanings {
  const [meanings, setMeanings] = useState<SymbolMeanings>(EMPTY_MEANINGS);
  useEffect(() => {
    let alive = true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    setMeanings(EMPTY_MEANINGS());
    let tries = 0;
    const poll = () => {
      loadSymbolExplanations(repoRoot, note.file, note.symbols, commit).then((m) => {
        if (!alive) return;
        setMeanings(m);
        if (!m.complete && tries < MEANING_TRIES) {
          tries += 1;
          timer = setTimeout(poll, MEANING_POLL_MS);
        }
      });
    };
    poll();
    return () => {
      alive = false;
      if (timer) clearTimeout(timer);
    };
  }, [repoRoot, note.file, commit, note.symbols]);
  return meanings;
}

type Pick = { side: ChangeSideName; identifier: string };

/** Which piece the reader picked, published to the diff below and republished
 *  as its words improve. Returns the pick and a chooser per side; choosing the
 *  picked piece again clears it, so the diff goes back to plain. */
export function usePiecePick({
  note,
  commit,
  index,
  meanings,
  exp,
  onFocusPiece,
}: {
  note: FileChangeNote;
  commit: string | null | undefined;
  index: AtlasIndex | null;
  meanings: SymbolMeanings;
  exp: ChangeExplanation | null;
  onFocusPiece?: (pick: FocusPick | null) => void;
}): [Pick | null, (side: ChangeSideName) => (identifier: string) => void] {
  const [pick, setPick] = useState<Pick | null>(null);
  // A different file (or another commit's version of it) is a different set of
  // pieces; carrying a pick across would light up a name nobody chose.
  useEffect(() => {
    setPick(null);
  }, [note.file, commit]);

  useEffect(() => {
    if (!onFocusPiece) return;
    if (!pick) {
      onFocusPiece(null);
      return;
    }
    const sideSymbols = note.symbols.filter((x) => onSide(x, pick.side));
    const picked = sideSymbols.find((x) => x.identifier === pick.identifier);
    if (!picked) {
      onFocusPiece(null);
      return;
    }
    const entry = index ? lookupEntry(index, picked.identifier, note.file) : undefined;
    const sideMap = pick.side === "previous" ? meanings.before : meanings.now;
    // The file-level line only speaks for a piece when it is the ONLY one that
    // changed on that side — the same rule the list applies.
    const override =
      sideSymbols.length === 1
        ? (pick.side === "previous" ? exp?.before : exp?.what) || undefined
        : undefined;
    onFocusPiece({
      side: pick.side,
      symbol: picked,
      title: pieceTitle(picked, entry),
      meaning: pieceLine(picked, sideMap.get(picked.identifier), override, entry),
    });
  }, [pick, note.symbols, note.file, index, meanings, exp, onFocusPiece]);

  const choose = (side: ChangeSideName) => (identifier: string) =>
    setPick((prev) =>
      prev && prev.side === side && prev.identifier === identifier ? null : { side, identifier },
    );
  return [pick, choose];
}
