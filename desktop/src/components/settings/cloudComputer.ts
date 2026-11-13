// The pure half of the Cloud computer page: which connected machines are one
// computer, what each repository on it declares it needs, and how a base
// build reads as a row in the build list.
//
// The machine book keeps one row per repository on a box (`user@host:/repo`),
// so a box carrying three repositories is three rows. The page is about the
// box, so the rows are folded back into computers here, and each repository
// keeps its own row underneath.
//
// The book only knows the repositories this laptop connected the box for. The
// box holds more: whatever a teammate cloned, whatever was put there from the
// machine's page, whatever the runner cloned for cloud work. So the list the
// page shows is the box's own answer (`computerRepos`), with the book's rows
// attached where they name the same folder.

import type { BoxProject, Machine } from "../../lib/api";
import { placeOfMachine, type Place } from "../../lib/place";
import type { BaseBuild, TeamBase } from "../../lib/place/teamBase";
import { baseWarning, warmSentence, warmShortfall } from "../../lib/place/teamBase";
import type { CloudBuild } from "../ui/cloud-computer";
import { stepWord } from "./PlaceEnvSpecSection";
import { repoName } from "./nav";

/** One repository on a computer, under the name the page shows it by. */
export type ComputerRepo = {
  label: string;
  /** The book row the box is reached through. For a repository the book has
   *  no row of its own for, it is another row on the same box — same login,
   *  same key — and `path` says which folder over there is meant. */
  row: Machine;
  /** Where it sits on the box, when anything has said. */
  path: string | null;
  /** What is checked out there, last anybody looked. */
  branch: string | null;
  /** This laptop's book has a row for it, so its own folder here (if the row
   *  names one) is the same project. False for one only the box knows about. */
  booked: boolean;
};

/** One box, with every repository the book has on it. */
export type Computer = {
  /** `user@host` — the part of the row id every repository on the box shares. */
  key: string;
  name: string;
  shared: boolean;
  repos: ComputerRepo[];
};

/** `user@host`, the address the rows on one box share. */
export function computerKey(m: Machine): string {
  return `${m.user}@${m.host}`;
}

/** Fold the book's rows into computers, shared ones first, each computer's
 *  repositories named by their folder and kept apart when two share a name. */
export function groupComputers(rows: Machine[]): Computer[] {
  const byKey = new Map<string, Computer>();
  for (const row of rows) {
    const key = computerKey(row);
    let c = byKey.get(key);
    if (!c) {
      c = { key, name: row.name || key, shared: false, repos: [] };
      byKey.set(key, c);
    }
    if (row.box_kind === "shared") c.shared = true;
    const where = row.repo_path ?? row.project_root ?? row.id;
    const label = freeLabel(c.repos, repoName(where), where, row.id);
    c.repos.push({ label, row, path: row.repo_path ?? null, branch: row.repo_branch ?? null, booked: true });
  }
  return [...byKey.values()].sort((a, b) => Number(b.shared) - Number(a.shared));
}

/** The first of the names no repository on the list already goes by. */
function freeLabel(taken: ComputerRepo[], ...names: string[]): string {
  return names.find((n) => !taken.some((r) => r.label === n)) ?? names[names.length - 1];
}

const samePath = (a: string | null | undefined, b: string | null | undefined) =>
  !!a && !!b && a.replace(/\/+$/, "") === b.replace(/\/+$/, "");

/** Every repository on the computer: what the box says it holds, each joined
 *  to the book row that names the same folder, then any book row the box did
 *  not mention.
 *
 *  `held` is null while the box hasn't answered (or couldn't be reached), and
 *  the list is then the book's alone — which is what this page used to show
 *  always, and why a box holding six repositories read as holding one. A book
 *  row the box doesn't list is kept, not dropped: the folder may be gone, but
 *  the row is still how this laptop reaches the box, and hiding it would hide
 *  the one thing a person could act on. */
export function computerRepos(computer: Computer, held: BoxProject[] | null): ComputerRepo[] {
  if (!held || computer.repos.length === 0) return computer.repos;
  const via = computer.repos[0].row;
  const out: ComputerRepo[] = [];
  for (const p of held) {
    const booked = computer.repos.find((r) => samePath(r.path, p.path));
    const label = freeLabel(out, p.name, p.path);
    out.push(
      booked
        ? { ...booked, label, path: p.path, branch: p.branch ?? booked.branch }
        : { label, row: via, path: p.path, branch: p.branch, booked: false },
    );
  }
  for (const r of computer.repos) {
    if (out.some((o) => o.booked && o.row.id === r.row.id)) continue;
    out.push({ ...r, label: freeLabel(out, r.label, r.path ?? r.row.id, r.row.id) });
  }
  return out;
}

/** The place a repository on the computer is read and built at: its own book
 *  row, or — for one only the box knows about — another row on the same box,
 *  pointed at the folder the box said it holds. It has no folder on this
 *  laptop, so nothing local stands in for it. */
export function placeOfRepo(repo: ComputerRepo): Place {
  const place = placeOfMachine(repo.row);
  if (repo.booked) return place;
  return { ...place, project: { root: null, path: repo.path, branch: repo.branch } };
}

/** Whether a TOML header names the environment table or one under it. */
function isEnvHeader(line: string): boolean {
  const t = line.trim();
  if (!t.startsWith("[")) return false;
  const name = t
    .split("#")[0]
    .trim()
    .replace(/^\[+/, "")
    .replace(/\]+$/, "")
    .trim();
  return name === "env" || name.startsWith("env.");
}

/** The `[env]` part of a `.aura/settings.toml`: the `[env]` table and every
 *  `[env.*]` / `[[env.*]]` table, as written, in order. Empty when the file
 *  declares no environment. */
export function envBlock(settingsToml: string): string {
  const out: string[] = [];
  let inEnv = false;
  for (const line of settingsToml.split("\n")) {
    if (line.trim().startsWith("[")) inEnv = isEnvHeader(line);
    if (inEnv) out.push(line);
  }
  return out.join("\n").trim();
}

/** The install script the page shows: each repository's declared environment
 *  under its own name, or a line saying it declares none. `text` undefined is
 *  a repository with no folder on this laptop to read it from — its block is
 *  read on the computer when it builds, and saying "declares none" about it
 *  would be a guess. */
export function installScript(blocks: { label: string; text: string | null | undefined }[]): string {
  return blocks
    .map(({ label, text }) =>
      text
        ? `# ${label}\n${text}`
        : text === undefined
          ? `# ${label}\n# only on the computer — its [env] block is read there when it builds`
          : `# ${label}\n# declares no [env] block in .aura/settings.toml yet`,
    )
    .join("\n\n");
}

/** "42s", "3m 05s". */
export function durationWord(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 60) return `${s}s`;
  return `${Math.floor(s / 60)}m ${String(s % 60).padStart(2, "0")}s`;
}

/** What one repository's base build said, as log lines. */
export function buildLog(label: string, build: BaseBuild): string[] {
  const lines = [`# ${label}`, warmSentence(build)];
  for (const s of build.report?.steps ?? []) {
    lines.push(`${stepWord(s.state)} · ${s.title}`);
    if (s.detail) lines.push(...s.detail.split("\n").map((l) => `    ${l}`));
  }
  const short = warmShortfall(build.start);
  if (short) lines.push(short);
  const warning = baseWarning(build.base);
  if (warning) lines.push(warning);
  return lines;
}

/** The build the computer already holds, as the machine reports it. The
 *  machine records which spec it was built to and not when, so the row says
 *  the spec and leaves the time blank rather than inventing one. */
export function baseEntry(
  bases: { label: string; base: TeamBase }[],
  script: string,
): CloudBuild | null {
  const built = bases.filter((b) => b.base.built_version > 0 && b.base.built_digest);
  if (built.length === 0) return null;
  const warning = bases.map((b) => baseWarning(b.base)).find(Boolean) ?? null;
  const version = Math.max(...built.map((b) => b.base.built_version));
  const logs = bases.flatMap(({ label, base }) => [
    `# ${label}`,
    base.built_version > 0
      ? `built to spec v${base.built_version} · ${base.built_digest.slice(0, 12)}`
      : "never built",
    base.holds.length === 0
      ? "holds nothing yet"
      : `holds ${base.holds.map((h) => h.holds || h.under).join(", ")}`,
  ]);
  return {
    version: 0,
    label: `Built to spec v${version}`,
    status: warning ? "failed" : "ready",
    active: true,
    time: "",
    duration: "",
    reason:
      warning ??
      `${built.length} of ${bases.length} ${bases.length === 1 ? "repository" : "repositories"} built`,
    logs: warning ? [warning, "", ...logs] : logs,
    repositories: built.map((b) => b.label),
    script,
  };
}
