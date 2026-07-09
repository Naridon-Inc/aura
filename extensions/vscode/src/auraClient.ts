// Thin wrapper around the `aura` CLI. Mirrors the subset of
// aura-shell/src/lib/api.ts that the VS Code extension needs.
//
// Two execution paths:
//   • runJson<T>(...args)   — runs `aura ... --json`, parses stdout as JSON.
//   • runText(...args)      — runs `aura ...`, returns combined stdout/stderr.
//
// All commands are scoped to a `cwd`. The activation event tries to use
// the active workspace folder, but multi-root workspaces can pass an
// explicit folder via `cwd`.
//
// Discovery: prefers `aura.binPath` setting; falls back to PATH lookup
// extended with the same dirs aura-agents/src/kimi_coder.rs probes (macOS
// GUI launchd PATH problem).

import { spawn } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import * as vscode from "vscode";

let cachedBin: string | null | undefined;

const FALLBACK_DIRS = [
  "/opt/homebrew/bin",
  "/usr/local/bin",
];

function homeDirs(): string[] {
  const home = os.homedir();
  if (!home) return [];
  return [
    path.join(home, ".cargo/bin"),
    path.join(home, ".local/bin"),
    path.join(home, ".npm-global/bin"),
    path.join(home, "bin"),
  ];
}

function probePath(): string | null {
  const PATH = process.env.PATH ?? "";
  const extra = [...FALLBACK_DIRS, ...homeDirs()];
  const all = [...PATH.split(path.delimiter), ...extra].filter(Boolean);
  for (const dir of all) {
    const p = path.join(dir, "aura");
    try {
      if (fs.statSync(p).isFile()) return p;
    } catch {
      /* keep looking */
    }
  }
  return null;
}

export function resolveAuraBin(): string | null {
  if (cachedBin !== undefined) return cachedBin;
  const fromCfg = vscode.workspace.getConfiguration("aura").get<string>("binPath");
  if (fromCfg && fromCfg.trim().length > 0) {
    cachedBin = fromCfg;
    return cachedBin;
  }
  cachedBin = probePath();
  return cachedBin;
}

export function clearAuraBinCache() {
  cachedBin = undefined;
}

export class AuraNotFoundError extends Error {
  constructor() {
    super("`aura` binary not found on PATH. Set `aura.binPath` in settings or install Aura.");
  }
}

export interface RunOptions {
  cwd: string;
  /** Hard timeout in ms. Default 30s. */
  timeoutMs?: number;
  /** Override binary path. Default = resolveAuraBin(). */
  bin?: string;
  /** Extra env on top of process.env. */
  env?: Record<string, string>;
}

interface RunResult {
  code: number;
  stdout: string;
  stderr: string;
}

function runRaw(args: string[], opts: RunOptions): Promise<RunResult> {
  const bin = opts.bin ?? resolveAuraBin();
  if (!bin) return Promise.reject(new AuraNotFoundError());
  return new Promise((resolve, reject) => {
    const child = spawn(bin, args, {
      cwd: opts.cwd,
      env: { ...process.env, ...(opts.env ?? {}) },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    const timeout = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error(`aura ${args.join(" ")} timed out after ${opts.timeoutMs ?? 30000}ms`));
    }, opts.timeoutMs ?? 30000);
    child.stdout.on("data", (b) => { stdout += b.toString("utf8"); });
    child.stderr.on("data", (b) => { stderr += b.toString("utf8"); });
    child.on("error", (err) => { clearTimeout(timeout); reject(err); });
    child.on("close", (code) => {
      clearTimeout(timeout);
      resolve({ code: code ?? -1, stdout, stderr });
    });
  });
}

export class AuraSubcommandMissingError extends Error {
  constructor(public readonly args: string[]) {
    super(`Aura CLI does not support: aura ${args.join(" ")}`);
  }
}

function classifyFailure(args: string[], code: number, stderr: string, stdout: string): Error {
  const both = (stderr || "") + "\n" + (stdout || "");
  if (/unrecognized subcommand|unknown subcommand|invalid subcommand|unrecognized argument/i.test(both)) {
    return new AuraSubcommandMissingError(args);
  }
  return new Error(`aura ${args.join(" ")} exited ${code}: ${stderr || stdout}`);
}

export async function runText(args: string[], opts: RunOptions): Promise<string> {
  const r = await runRaw(args, opts);
  if (r.code !== 0) throw classifyFailure(args, r.code, r.stderr, r.stdout);
  return r.stdout;
}

export async function runJson<T>(args: string[], opts: RunOptions): Promise<T> {
  // Append --json only if the caller didn't already include it. The CLI
  // is permissive about the flag's position, so we put it at the end.
  const withJson = args.includes("--json") ? args : [...args, "--json"];
  const r = await runRaw(withJson, opts);
  if (r.code !== 0) throw classifyFailure(withJson, r.code, r.stderr, r.stdout);
  const trimmed = r.stdout.trim();
  if (!trimmed) throw new Error(`aura ${withJson.join(" ")} returned empty output`);
  try {
    return JSON.parse(trimmed) as T;
  } catch (err) {
    throw new Error(`aura ${withJson.join(" ")}: invalid JSON — ${(err as Error).message}\n${trimmed.slice(0, 500)}`);
  }
}

// ---------- Typed surfaces (mirror aura-shell/src/lib/api.ts) ----------

export interface AuraStatus {
  repo_root: string;
  logic_nodes: number;
  active_session?: string | null;
  checkpoints: number;
  strict_mode: boolean;
  strict_mode_locked: boolean;
}

export async function status(cwd: string): Promise<AuraStatus> {
  return runJson<AuraStatus>(["status"], { cwd });
}

export interface IntentCount {
  count: number;
  since_iso: string;
}

export async function intentsToday(cwd: string): Promise<IntentCount> {
  // Re-uses the count endpoint added in Stage 1 of aura-shell perf work.
  return runJson<IntentCount>(["intent", "count-today"], { cwd });
}

export interface UsageSummary {
  total_input_tokens: number;
  total_output_tokens: number;
  total_cost_usd: number;
}

export async function usageToday(cwd: string): Promise<UsageSummary> {
  return runJson<UsageSummary>(["usage", "today"], { cwd });
}

export interface LiveSyncStatus {
  pending_outbound: number;
  pending_inbound: number;
  active_pushers: number;
}

export async function liveSyncStatus(cwd: string): Promise<LiveSyncStatus> {
  return runJson<LiveSyncStatus>(["live-sync", "status"], { cwd });
}

export interface AuditUnacked {
  count: number;
}

export async function auditUnacked(cwd: string): Promise<AuditUnacked> {
  return runJson<AuditUnacked>(["audit", "unacked-count"], { cwd });
}

export async function logIntent(cwd: string, message: string): Promise<void> {
  await runText(["log-intent", message], { cwd });
}

export async function snapshotFile(cwd: string, filePath: string): Promise<void> {
  await runText(["snapshot", filePath], { cwd });
}

export async function prove(cwd: string, goal: string): Promise<unknown> {
  return runJson<unknown>(["prove", goal], { cwd });
}

export async function rewindNode(cwd: string, node: string): Promise<void> {
  await runText(["rewind", node], { cwd });
}

// ---------- Frictionless capture (no-MCP drop-in) ----------

/** `aura enable` — turn on passive semantic capture for `cwd` (installs the
 *  git hooks; no MCP server). Idempotent; returns the CLI's summary text. */
export async function enable(cwd: string): Promise<string> {
  return runText(["enable"], { cwd });
}

/** `aura disable` — remove Aura's capture hooks (history in git is preserved). */
export async function disable(cwd: string): Promise<string> {
  return runText(["disable"], { cwd });
}

/** Resolve the git hooks directory for `cwd`, handling both a normal checkout
 *  (`.git/` directory) and a linked worktree (`.git` file → `gitdir:` pointer,
 *  whose hooks live in the shared common dir, not the per-worktree dir).
 *  Returns null when `cwd` isn't a git repo. Pure filesystem — no CLI call. */
export function hooksDir(cwd: string): string | null {
  const dotgit = path.join(cwd, ".git");
  try {
    const st = fs.statSync(dotgit);
    if (st.isDirectory()) return path.join(dotgit, "hooks");
    if (st.isFile()) {
      const m = fs.readFileSync(dotgit, "utf8").trim().match(/^gitdir:\s*(.+)$/);
      if (m) {
        // ".../.git/worktrees/<name>" → strip back to the common ".../.git".
        const common = m[1].replace(/[/\\]worktrees[/\\][^/\\]+$/, "");
        return path.join(common, "hooks");
      }
    }
  } catch {
    /* no .git here */
  }
  return null;
}

/** Whether Aura's capture hooks are installed in `cwd` — a fast filesystem
 *  probe of the pre-commit hook for Aura's marker, no CLI roundtrip. Used to
 *  decide whether to offer the one-click `aura enable` gate. */
export function isCaptureEnabled(cwd: string): boolean {
  const dir = hooksDir(cwd);
  if (!dir) return false;
  try {
    const body = fs.readFileSync(path.join(dir, "pre-commit"), "utf8");
    return body.includes("AURA SEMANTIC ENGINE") || body.includes("aura capture-context");
  } catch {
    return false;
  }
}
