// Mounts once at app start. Keeps the `aura` CLI in lockstep with the
// desktop app: on launch it checks the on-PATH CLI version, and when the
// shipped release bundles a newer matching binary, it installs that binary
// in place (atomic, signature-preserving — see `cmd_doctor_cli.rs`) and
// surfaces a small, auto-dismissing toast. Zero-click: the CLI is "tagged"
// to whatever desktop version the user just updated to.
//
// Degrades to nothing in dev: the backend only bundles/installs from a
// release build, so `auraCliInstallBundled` rejects with a "dev build"
// message that we treat as a silent no-op.

import { useEffect, useRef, useState } from "react";
import { api } from "../lib/api";
import { AsciiSpinner } from "./ui/ascii-spinner";
import { ToastActionButton, ToastCard, ToastStack, type ToastTone } from "./ui/toast";

/** What the version check / install returns. Mirrors the Rust struct. */
type CliCheck = {
  installed: string | null;
  expected: string;
  path: string | null;
  status: "ok" | "outdated" | "missing" | "unknown";
  raw: string | null;
};

/** Toast phases. `null` renders nothing — the common case. */
type Phase =
  | { kind: "updating"; to: string }
  | { kind: "done"; version: string }
  | { kind: "needs-auth"; to: string }
  | { kind: "failed"; message: string };

/** A reject whose message says there's nothing to install (dev build, or no
 *  bundled binary). Treated as a silent no-op, never a failure toast. */
function isNoBundleError(err: unknown): boolean {
  const m = String(err).toLowerCase();
  return m.includes("dev build") || m.includes("no bundled");
}

/** The silent auto-install refused to touch a root-owned install dir
 *  (e.g. /usr/local/bin) — the backend marks that case so we can offer an
 *  explicit Authorize button instead of failing mutely. */
function isNeedsAuthError(err: unknown): boolean {
  return String(err).toLowerCase().includes("needs authorization");
}

/** Parse a semver-ish "X.Y.Z" (tolerating a leading `v` and a `-rc`
 *  suffix) to its [major, minor] tuple, or null. Mirrors the Rust
 *  `major_minor` in cmd_doctor_cli.rs. */
function parseMajorMinor(v: string | null | undefined): [number, number] | null {
  if (!v) return null;
  const head = v.replace(/^v/, "").split("-")[0];
  const [maj, min] = head.split(".").map(Number);
  if (!Number.isFinite(maj) || !Number.isFinite(min)) return null;
  return [maj, min];
}

/** True when the installed CLI is the same or NEWER than `expected` on
 *  major.minor — installing the bundled binary would then be a no-op or a
 *  DOWNGRADE, so we must skip it. Defends against a forever-spinning
 *  "Updating…" pill when a newer CLI is on PATH than the running desktop
 *  build bundles. (The backend now classifies this as "ok" too, but a
 *  stale backend in an already-running build wouldn't.) */
function installedIsAtLeast(installed: string | null, expected: string): boolean {
  const i = parseMajorMinor(installed);
  const e = parseMajorMinor(expected);
  if (!i || !e) return false;
  return i[0] > e[0] || (i[0] === e[0] && i[1] >= e[1]);
}

/** How long to wait for a silent install before we stop showing the
 *  spinner. The invoke can't be cancelled, but the UI must not lie — a
 *  pill that spins forever reads as a hang. */
const INSTALL_TIMEOUT_MS = 60_000;

// ── Per-version auto-attempt guard ──────────────────────────────────────
// The toast auto-installs the bundled CLI when the on-PATH version lags the
// running desktop build. But if that attempt is dismissed, fails, or simply
// can't take effect (PATH doesn't pick the new binary up), the next version
// check still reads "outdated" — and without a memory we'd re-pin the
// "Updating…" pill on every launch / HMR remount. We stamp the outcome per
// expected-version in localStorage and refuse to AUTO-attempt the same
// version again within a cooldown. (The footer chip still triggers it
// manually — this only gates the unprompted pop.)
const GUARD_KEY = "aura.cliUpdate.guard";
type GuardOutcome = "attempting" | "done" | "dismissed" | "failed";
type GuardRec = { version: string; outcome: GuardOutcome; ts: number };

function readGuard(): GuardRec | null {
  try {
    const raw = localStorage.getItem(GUARD_KEY);
    if (!raw) return null;
    const r = JSON.parse(raw) as GuardRec;
    if (typeof r?.version === "string" && typeof r?.ts === "number") return r;
  } catch {
    /* ignore malformed */
  }
  return null;
}

function writeGuard(version: string, outcome: GuardOutcome): void {
  try {
    localStorage.setItem(
      GUARD_KEY,
      JSON.stringify({ version, outcome, ts: Date.now() } satisfies GuardRec),
    );
  } catch {
    /* storage unavailable — degrade to no guard */
  }
}

/** Should we SKIP an unprompted install attempt for `expected`? True when we
 *  already settled this exact version (done forever; dismissed/failed within
 *  a cooldown) or another instance is mid-attempt. */
function shouldSkipAuto(expected: string): boolean {
  const rec = readGuard();
  if (!rec || rec.version !== expected) return false; // new version → allow
  const age = Date.now() - rec.ts;
  switch (rec.outcome) {
    case "done":
      return true; // already updated to this version — never re-pop
    case "dismissed":
      return age < 12 * 60 * 60 * 1000; // user said not now — quiet 12h
    case "failed":
      return age < 6 * 60 * 60 * 1000; // back off 6h (chip still manual)
    case "attempting":
      return age < 90_000; // another mount/instance is mid-install
    default:
      return false;
  }
}

export function CliUpdateToast({
  onInstalled,
}: {
  /** Called with the post-install version check so the caller (App) can
   *  refresh its footer chip without a second round-trip. */
  onInstalled?: (check: CliCheck) => void;
}) {
  const [phase, setPhase] = useState<Phase | null>(null);
  // Guard against React StrictMode's double-mount kicking off two installs.
  const startedRef = useRef(false);
  // Once the user dismisses, suppress any late async setPhase from re-popping
  // the toast (the install invoke can't be cancelled and may still resolve).
  const dismissedRef = useRef(false);
  // The version this toast is acting on — so dismiss can stamp the guard.
  const targetRef = useRef<string>("");

  useEffect(() => {
    if (startedRef.current) return;
    startedRef.current = true;

    let cancelled = false;
    const live = () => !cancelled && !dismissedRef.current;
    (async () => {
      let check: CliCheck;
      try {
        check = await api.auraCliVersionCheck();
      } catch {
        return; // version check failed — stay silent, chip handles its own state
      }
      if (!live() || check.status === "ok" || check.status === "unknown") {
        // "unknown" means a binary exists but didn't parse — don't clobber it.
        return;
      }
      targetRef.current = check.expected;
      // Already settled this exact version (done / recently dismissed or
      // failed)? Stay silent so we don't re-pin the pill every launch.
      if (shouldSkipAuto(check.expected)) return;

      // Never downgrade. If the on-PATH CLI is already the same or newer
      // than what this build bundles, do nothing — installing would either
      // be a no-op or replace a newer binary with an older one, and the
      // next version check would read the (still-newer) installed version
      // as a mismatch again, pinning the "Updating…" pill in a loop. The
      // backend now classifies this as "ok"; this guards a stale backend.
      if (
        check.status === "outdated" &&
        installedIsAtLeast(check.installed, check.expected)
      ) {
        return;
      }

      // Outdated or missing → install the bundled binary. Race against a
      // timeout so a hung invoke can't spin the pill forever.
      writeGuard(check.expected, "attempting");
      setPhase({ kind: "updating", to: check.expected });
      const TIMEOUT = Symbol("install-timeout");
      try {
        const res = await Promise.race([
          api.auraCliInstallBundled(),
          new Promise<typeof TIMEOUT>((resolve) =>
            window.setTimeout(() => resolve(TIMEOUT), INSTALL_TIMEOUT_MS),
          ),
        ]);
        if (!live()) return;
        if (res === TIMEOUT) {
          // Don't keep retrying a hung install on the next launch.
          writeGuard(check.expected, "failed");
          setPhase({
            kind: "failed",
            message:
              "Aura CLI update is taking longer than expected — it may still finish in the background.",
          });
          return;
        }
        onInstalled?.(res);
        if (res.status === "ok") {
          writeGuard(res.installed ?? res.expected, "done");
          setPhase({ kind: "done", version: res.installed ?? res.expected });
          window.setTimeout(() => {
            if (live()) setPhase(null);
          }, 6000);
        } else {
          // Installed, but the on-PATH resolver still doesn't see it — most
          // likely the install dir (~/.local/bin) isn't on PATH. Mark failed
          // so we don't re-attempt the same no-op every launch.
          writeGuard(check.expected, "failed");
          setPhase({
            kind: "failed",
            message:
              "Aura CLI installed, but its directory may not be on your PATH.",
          });
        }
      } catch (err) {
        if (!live()) return;
        if (isNoBundleError(err)) {
          setPhase(null); // dev build / nothing bundled — silent
          return;
        }
        if (isNeedsAuthError(err)) {
          // Root-owned install dir — never pop a password dialog unprompted;
          // park on an Authorize button the user can click.
          setPhase({ kind: "needs-auth", to: check.expected });
          return;
        }
        writeGuard(check.expected, "failed");
        setPhase({ kind: "failed", message: String(err) });
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [onInstalled]);

  // User dismissed the toast. Suppress any late async re-pop and remember the
  // choice per-version so it doesn't auto-reappear next launch. The install
  // (if mid-flight) continues in the background — we just stop narrating it.
  const dismiss = () => {
    dismissedRef.current = true;
    const v = targetRef.current || (phase && "to" in phase ? phase.to : "");
    if (v) writeGuard(v, "dismissed");
    setPhase(null);
  };

  // Explicit user click — authorized to show the macOS admin prompt when
  // the install dir (e.g. /usr/local/bin) is root-owned.
  const authorize = async () => {
    dismissedRef.current = false; // explicit user action re-arms the toast
    const to = phase?.kind === "needs-auth" ? phase.to : "";
    setPhase({ kind: "updating", to });
    try {
      const res = await api.auraCliInstallBundled(true);
      onInstalled?.(res);
      if (res.status === "ok") {
        writeGuard(res.installed ?? res.expected, "done");
        setPhase({ kind: "done", version: res.installed ?? res.expected });
        window.setTimeout(() => {
          if (!dismissedRef.current) setPhase(null);
        }, 6000);
      } else {
        writeGuard(to, "failed");
        setPhase({
          kind: "failed",
          message:
            "Aura CLI installed, but its directory may not be on your PATH.",
        });
      }
    } catch (err) {
      writeGuard(to, "failed");
      setPhase({ kind: "failed", message: String(err) });
    }
  };

  if (!phase) return null;

  const tone: ToastTone =
    phase.kind === "done"
      ? "success"
      : phase.kind === "failed" || phase.kind === "needs-auth"
        ? "warning"
        : "info";

  return (
    <ToastStack zIndex={9998}>
      {phase.kind === "updating" && (
        <ToastCard
          tone={tone}
          icon={<AsciiSpinner className="mt-px shrink-0 text-[12px] leading-none" />}
          title={`Updating the Aura command line tool to ${phase.to}…`}
          onDismiss={dismiss}
          dismissTitle="Dismiss — the update keeps running in the background"
        />
      )}
      {phase.kind === "done" && (
        <ToastCard
          tone={tone}
          title={`Aura command line tool updated to ${phase.version}`}
          onDismiss={dismiss}
        />
      )}
      {phase.kind === "needs-auth" && (
        <ToastCard
          tone={tone}
          title="One more step to finish the update"
          message={`Aura command line tool ${phase.to} is ready, but the folder it installs into needs your administrator password.`}
          onDismiss={dismiss}
          actions={
            <>
              <ToastActionButton onClick={dismiss}>Later</ToastActionButton>
              <ToastActionButton variant="primary" onClick={() => void authorize()}>
                Enter password
              </ToastActionButton>
            </>
          }
        />
      )}
      {phase.kind === "failed" && (
        <ToastCard
          tone={tone}
          role="alert"
          title="The Aura command line tool didn't update"
          message={phase.message}
          onDismiss={dismiss}
        />
      )}
    </ToastStack>
  );
}
