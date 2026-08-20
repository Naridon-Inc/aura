// The Where row: which computer this new work runs on.
//
// One control, mounted wherever new work starts, so a new chat and a new
// workspace ask the question the same way. That is not tidiness — the two used
// to answer it differently, and the difference was invisible: a workspace was
// always made on this laptop and a chat could be pointed at a machine only by
// walking into the machine first. Two doors onto one question, each with its
// own answer, is how a person ends up believing their box can't do something it
// has been able to do all along.
//
// The rows come from `whereOptions`, which is where the two product rules live
// (a project's cloud only where there is one; a personal box everywhere). This
// file is only the flyout, so nothing about which places are offered can be
// decided twice.

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Laptop } from "lucide-react";

import { api, type PlaceRoster } from "../../lib/api";
import {
  HERE,
  chosenWhere,
  whereOptions,
  type WhereOption,
} from "../../lib/place";
import { ChipButton } from "../ui/chip";
import { CloudGlyph } from "../ui/cloud-glyph";
import { useDismiss } from "../../lib/useDismiss";

/** The choice, remembered per project.
 *
 *  Per project rather than globally: "run this on the big box" is a habit about
 *  a body of code, not about the person. Remembering it globally would send the
 *  next project's work to a machine that has never held it. */
const REMEMBERED = (repoRoot: string | null) =>
  `aura.newwork.where.${repoRoot ?? "none"}`;

/** Everything a surface needs to ask the question and act on the answer. */
export type WherePlaces = {
  options: WhereOption[];
  /** The option in force right now — never null, because this laptop is always
   *  on the list and is always a true answer. */
  chosen: WhereOption;
  choose: (id: string) => void;
  /** The list is still being read. The chip shows this laptop meanwhile, which
   *  is what it would have shown before any of this existed. */
  loading: boolean;
};

/**
 * Read the one list, and hold the choice.
 *
 * The roster is re-read whenever the project changes, because which rows are
 * offered depends on the project — that is rule 1 — and a list carried over
 * from the last project would show its cloud under this one's name.
 */
export function useWherePlaces(
  repoRoot: string | null,
  projectName: string,
): WherePlaces {
  const [roster, setRoster] = useState<PlaceRoster | null>(null);
  const [loading, setLoading] = useState(false);
  const [id, setId] = useState<string>(HERE);

  useEffect(() => {
    let alive = true;
    setLoading(true);
    void api
      .placesList()
      .then((r) => {
        if (alive) setRoster(r);
      })
      .catch(() => {
        // `places_list` never throws for the cloud's sake, so this is a real
        // failure to read the book. This laptop is still an answer, and it is
        // the one the dialog falls back to.
        if (alive) setRoster(null);
      })
      .finally(() => {
        if (alive) setLoading(false);
      });
    return () => {
      alive = false;
    };
  }, [repoRoot]);

  const options = useMemo(
    () => whereOptions(roster, repoRoot, projectName),
    [roster, repoRoot, projectName],
  );

  // Restore the habit for THIS project, once the list it has to be valid
  // against exists. A remembered box that has since been forgotten resolves to
  // this laptop rather than to an id nobody can dial.
  useEffect(() => {
    try {
      setId(localStorage.getItem(REMEMBERED(repoRoot)) ?? HERE);
    } catch {
      setId(HERE);
    }
  }, [repoRoot]);

  const choose = useCallback(
    (next: string) => {
      setId(next);
      try {
        localStorage.setItem(REMEMBERED(repoRoot), next);
      } catch {
        /* quota — the choice just won't stick */
      }
    },
    [repoRoot],
  );

  return { options, chosen: chosenWhere(options, id), choose, loading };
}

/** The chip and its list. Always rendered with at least one row — this laptop —
 *  so there is never a disabled control or an empty menu to explain. */
export function WherePicker({
  places,
  disabled,
  className,
}: {
  places: WherePlaces;
  disabled?: boolean;
  className?: string;
}) {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  useDismiss(open, () => setOpen(false), rootRef);

  const { options, chosen, choose } = places;
  const remote = chosen.machineId !== null;

  return (
    <div className={`relative ${className ?? ""}`} ref={rootRef}>
      <ChipButton
        onClick={() => setOpen((v) => !v)}
        disabled={disabled}
        active={remote}
      >
        <WhereGlyph option={chosen} />
        <span className="max-w-[160px] truncate">{chosen.label}</span>
      </ChipButton>
      {open && (
        <div
          className="absolute left-0 top-8 z-40 max-h-[40vh] w-[280px] overflow-y-auto rounded-lg py-1 shadow-xl"
          style={{
            background: "var(--color-bg-1)",
            border: "1px solid var(--color-line)",
          }}
        >
          <div className="px-3 pb-1 pt-1.5 text-xs font-medium text-text-4">
            Where this runs
          </div>
          {options.map((option) => (
            <button
              key={option.id}
              type="button"
              onClick={() => {
                choose(option.id);
                setOpen(false);
              }}
              className="flex w-full items-start gap-2 px-3 py-1.5 text-left transition-colors hover:bg-state-hover"
            >
              <span className="mt-[3px] shrink-0">
                <WhereGlyph option={option} />
              </span>
              <span className="min-w-0 flex-1">
                <span
                  className={`block truncate text-sm ${
                    option.id === chosen.id ? "text-text-1" : "text-text-2"
                  }`}
                >
                  {option.label}
                </span>
                <span className="block truncate text-2xs text-text-5">
                  {option.detail}
                </span>
              </span>
              {option.id === chosen.id && (
                <span className="mt-[2px] shrink-0 text-sm text-accent">✓</span>
              )}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

/** This laptop wears a laptop; anywhere else wears the app's cloud mark. Two
 *  marks, because the distinction the person cares about is "here" versus "not
 *  here" — not which of three ways a box came to be theirs. */
function WhereGlyph({ option }: { option: WhereOption }) {
  return option.machineId === null ? (
    <Laptop size={13} className="text-text-4" />
  ) : (
    <CloudGlyph size={13} className="text-accent" />
  );
}
