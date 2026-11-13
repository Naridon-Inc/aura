// What a cloud computer really holds, for the Cloud computer page.
//
// The page used to list the machine book's rows and nothing else — one per
// repository this laptop connected the box for — so a box carrying a team's
// work read as carrying the one repository somebody here set it up with. This
// asks the box (the same `box_projects` read the machine's own page makes),
// joins the answer to the book, and keeps it in the window's resource cache so
// coming back to the page paints the last answer instead of waiting on ssh.
//
// After a clone is started from the page it asks again on a short beat until
// the new folder turns up, or gives up after a couple of minutes and leaves
// the next visit to find it.

import { useCallback, useEffect, useMemo, useState } from "react";

import { api, type PlaceProjects } from "../../lib/api";
import { useCachedResource } from "../../lib/useCachedResource";
import { computerRepos, type Computer, type ComputerRepo } from "./cloudComputer";

/** How often to look for a clone that was just started, and for how long. */
const LAND_EVERY_MS = 15_000;
const LAND_FOR_MS = 2 * 60_000;

export type ComputerRepos = {
  repos: ComputerRepo[];
  /** Still waiting on the box's first answer, with nothing cached to show. */
  asking: boolean;
  /** The sentence under "Repositories" about what the box said, or null. */
  note: string | null;
  /** A clone started from this page that hasn't turned up yet. */
  landing: boolean;
  /** Call when a clone was started, so the list watches for it. */
  cloneStarted: () => void;
};

export function useComputerRepos(computer: Computer | null): ComputerRepos {
  const machineId = computer?.repos[0]?.row.id ?? null;
  const load = useCallback(
    () => (machineId ? api.boxProjects(machineId) : Promise.reject(new Error("no machine"))),
    [machineId],
  );
  const held = useCachedResource<PlaceProjects>(machineId ? `box-projects:${machineId}` : null, load);
  const projects = held.data?.projects ?? null;

  const repos = useMemo(
    () => (computer ? computerRepos(computer, projects) : []),
    [computer, projects],
  );

  const [landing, setLanding] = useState<{ before: number; until: number } | null>(null);
  useEffect(() => setLanding(null), [machineId]);
  const { reload } = held;
  useEffect(() => {
    if (!landing) return;
    const t = setInterval(() => {
      if (Date.now() > landing.until) setLanding(null);
      else void reload();
    }, LAND_EVERY_MS);
    return () => clearInterval(t);
  }, [landing, reload]);
  useEffect(() => {
    if (landing && (projects?.length ?? 0) > landing.before) setLanding(null);
  }, [landing, projects]);
  const cloneStarted = useCallback(() => {
    setLanding({ before: projects?.length ?? 0, until: Date.now() + LAND_FOR_MS });
  }, [projects]);

  const name = computer?.name ?? "the computer";
  const note = held.staleError
    ? projects
      ? `This is what ${name} held last time — it didn’t answer just now.`
      : `Couldn’t ask ${name} what it holds, so this lists only what this laptop connected it for.`
    : held.data?.notice?.trim() || null;

  return { repos, asking: held.loading, note, landing: landing !== null, cloneStarted };
}
