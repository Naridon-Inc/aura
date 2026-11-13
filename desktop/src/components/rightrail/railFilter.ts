// The rail's file filter, as typed into the search box under its tab strip.
// Bodies that list files read it; an empty string means "no filter".

import { createContext, useContext } from "react";

export const RailFilterContext = createContext("");

export function useRailFilter(): string {
  return useContext(RailFilterContext);
}

/** Whether `path` matches the filter: every space-separated word must appear,
 *  case-insensitively, somewhere in the path. */
export function matchesRailFilter(path: string, filter: string): boolean {
  const words = filter.toLowerCase().split(/\s+/).filter(Boolean);
  if (words.length === 0) return true;
  const hay = path.toLowerCase();
  return words.every((w) => hay.includes(w));
}
