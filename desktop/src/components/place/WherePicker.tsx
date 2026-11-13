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

import { useCallback, useEffect, useMemo, useState } from "react";
import { Check, ChevronDown, Laptop } from "lucide-react";

import { api, type PlaceRoster } from "../../lib/api";
import {
  HERE,
  chosenWhere,
  whereOptions,
  type WhereOption,
} from "../../lib/place";
import { cn } from "../../lib/utils";
import { Button } from "../ui/button";
import { CloudGlyph } from "../ui/cloud-glyph";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuTrigger,
} from "../ui/dropdown-menu";
import "../ui/launcher.css";

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

/** The button and its menu. Always rendered with at least one row — this
 *  laptop — so there is never a disabled control or an empty menu to explain. */
export function WherePicker({
  places,
  disabled,
  className,
}: {
  places: WherePlaces;
  disabled?: boolean;
  className?: string;
}) {
  const { options, chosen, choose } = places;
  const remote = chosen.machineId !== null;

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          variant="ghost"
          size="sm"
          disabled={disabled}
          className={cn("ui-where-trigger", className)}
          data-remote={remote ? "" : undefined}
          aria-label={`Where this runs: ${chosen.label}`}
          title="Choose which computer new work runs on"
        >
          <WhereGlyph option={chosen} />
          <span className="ui-where-label">{chosen.label}</span>
          <ChevronDown className="ui-where-chevron" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="ui-where-menu">
        <DropdownMenuLabel>Where this runs</DropdownMenuLabel>
        {options.map((option) => (
          <DropdownMenuItem
            key={option.id}
            className="ui-where-row"
            data-current={option.id === chosen.id ? "" : undefined}
            onSelect={() => choose(option.id)}
          >
            <WhereGlyph option={option} />
            <span className="ui-where-row-text">
              <span>{option.label}</span>
              <small>{option.detail}</small>
            </span>
            {option.id === chosen.id && <Check className="ui-where-check" />}
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

/** This laptop wears a laptop; anywhere else wears the app's cloud mark. Two
 *  marks, because the distinction the person cares about is "here" versus "not
 *  here" — not which of three ways a box came to be theirs. */
function WhereGlyph({ option }: { option: WhereOption }) {
  return option.machineId === null ? (
    <Laptop size={13} className="ui-where-glyph" />
  ) : (
    <CloudGlyph size={13} className="ui-where-glyph ui-where-glyph-remote" />
  );
}
