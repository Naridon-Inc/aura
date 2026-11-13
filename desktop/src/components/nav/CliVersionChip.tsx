import { useState } from "react";
import {
  Activity,
  Check,
  Copy,
  FileText,
  FolderOpen,
  Package,
  RefreshCw,
  SquareTerminal,
  Target,
} from "lucide-react";

import { AURA_CLI_INSTALL_COMMAND, type AuraCliCheck } from "../../lib/api";
import { Alert, AlertDescription } from "../ui/alert";
import { AsciiSpinner } from "../ui/ascii-spinner";
import { Button } from "../ui/button";
import { Popover, PopoverContent, PopoverTrigger } from "../ui/popover";
import "../ui/cloud-patterns.css";
import "../ui/cli-version.css";

/** The check's state in the words a person would use. */
const STATUS_WORD: Record<string, string> = {
  ok: "Up to date",
  outdated: "Out of date",
  missing: "Not installed",
  unknown: "Couldn’t tell",
};

// Task #229 — footer chip for the `aura` CLI version drift check.
//
// Renders as a ghost button with a colored dot:
//   • green  → installed.major.minor == expected (status "ok")
//   • amber  → installed but on a different minor (status "outdated"), or
//              an older copy is ahead of ours on PATH (`info.shadowing`)
//   • red    → no `aura` at all ("missing"), or `--version` unparseable
//
// `info.installed` / `info.path` describe the binary the app RUNS. They used
// to describe whatever `which aura` answered first, which stopped being the
// same thing when the resolver learned to step over a stale PATH entry — so
// the chip reported `0.4.6-alpha` off a binary the app had already refused
// to use. `info.shadowing` is that other copy, said as its own fact: the app
// is fine, and the `aura` the user types in a terminal is not.
//
// Click opens the details popover above the button: the version strings,
// the resolved path, the raw `--version` line, the one-click update and the
// install command to copy. The refresh button re-checks after upgrading
// without restarting the app.
export function CliVersionChip({
  info,
  onRefresh,
  onUpdate,
}: {
  info: AuraCliCheck;
  onRefresh?: () => void;
  onUpdate?: () => Promise<void>;
}) {
  const [open, setOpen] = useState(false);
  const [copied, setCopied] = useState(false);
  const [updating, setUpdating] = useState(false);
  const [updateError, setUpdateError] = useState<string | null>(null);

  async function runUpdate() {
    if (!onUpdate || updating) return;
    setUpdating(true);
    setUpdateError(null);
    try {
      await onUpdate();
      // Success refreshes `info` via the parent; the popover re-renders
      // to the "ok" state (no install block). Close it after a beat.
      setOpen(false);
    } catch (e) {
      setUpdateError(e instanceof Error ? e.message : String(e));
    } finally {
      setUpdating(false);
    }
  }

  // The app's own CLI is fine and something older is winning on PATH. Its
  // own state, not a variant of "outdated" — nothing about the app is stale.
  const shadowed = info.status === "ok" && info.shadowing !== null;

  const dotTone: "green" | "amber" | "red" =
    info.status === "outdated" || shadowed
      ? "amber"
      : info.status === "ok"
        ? "green"
        : "red";
  const labelText = shadowed
    ? "old aura on PATH"
    : info.status === "ok"
      ? `aura ${info.installed ?? ""}`
      : info.status === "outdated"
        ? `aura ${info.installed ?? "?"} → ${info.expected}`
        : info.status === "missing"
          ? "aura missing"
          : "aura ?";
  const titleText = shadowed
    ? `Aura runs ${info.installed} from ${info.path}. A terminal finds ${info.shadowing?.installed} at ${info.shadowing?.path} first.`
    : info.status === "ok"
      ? `Aura CLI ${info.installed} matches expected ${info.expected}`
      : info.status === "outdated"
        ? `Aura CLI ${info.installed} is out of sync. Shell expects ${info.expected}. Click for install command.`
        : info.status === "missing"
          ? "No aura command found on this computer. Click for install command."
          : "Aura CLI version could not be determined. Click for details.";

  // Install command shown in the popover. Cargo path is the canonical
  // route today; the bundled installer also exists but isn't a one-line
  // copy-paste, so we surface cargo here and link the docs URL. Shared with
  // the "Aura off" strip, which offers the same escape hatch — one command,
  // said the same way wherever the user meets the problem.
  const installCmd = AURA_CLI_INSTALL_COMMAND;

  function copyInstall() {
    navigator.clipboard
      ?.writeText(installCmd)
      .then(() => {
        setCopied(true);
        window.setTimeout(() => setCopied(false), 1500);
      })
      .catch(() => {});
  }

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button variant="ghost" size="sm" className="ui-cli-chip" title={titleText}>
          <span className="ui-cli-dot" data-tone={dotTone} aria-hidden />
          {labelText}
        </Button>
      </PopoverTrigger>
      <PopoverContent
        side="top"
        align="start"
        collisionPadding={12}
        className="ui-cloud-details ui-cli-details"
      >
        <header>
          <strong>Aura CLI</strong>
          {onRefresh && (
            <Button
              variant="ghost"
              size="iconXs"
              aria-label="Check the version again"
              title="Check the version again"
              onClick={() => onRefresh()}
            >
              <RefreshCw />
            </Button>
          )}
        </header>
        <dl className="ui-cloud-resource-table">
          <dt>
            <Activity />
            Status
          </dt>
          <dd className="ui-cli-status" data-tone={dotTone}>
            {shadowed ? "Old copy on your PATH" : STATUS_WORD[info.status] ?? info.status}
          </dd>
          {/* "Aura uses", not "Installed" — with two aura binaries on the
              machine, which one this row is about is the whole question. */}
          <dt>
            <Package />
            Aura uses
          </dt>
          <dd className="ui-cli-mono">{info.installed ?? "—"}</dd>
          {/* Only worth a row when it differs. In the shadowing case the
              app's CLI already matches, and printing the same number twice
              invites the reader to hunt for a difference. */}
          {info.installed !== info.expected && (
            <>
              <dt>
                <Target />
                Expected
              </dt>
              <dd className="ui-cli-mono">{info.expected}</dd>
            </>
          )}
          {info.path && (
            <>
              <dt>
                <FolderOpen />
                Path
              </dt>
              <dd className="ui-cli-mono ui-cli-path" title={info.path}>
                <PathText path={info.path} />
              </dd>
            </>
          )}
          {info.shadowing && (
            <>
              <dt>
                <SquareTerminal />
                Terminal
              </dt>
              <dd
                className="ui-cli-mono ui-cli-path ui-cli-status"
                data-tone="amber"
                title={info.shadowing.path}
              >
                {info.shadowing.installed} · <PathText path={info.shadowing.path} />
              </dd>
            </>
          )}
          {info.raw && info.raw !== `aura ${info.installed}` && (
            <>
              <dt>
                <FileText />
                Raw
              </dt>
              <dd className="ui-cli-mono ui-cli-raw" title={info.raw}>
                {info.raw}
              </dd>
            </>
          )}
        </dl>
        {(info.status === "outdated" || info.status === "missing" || shadowed) && (
          <section className="ui-cli-fix">
            {shadowed && (
              // Say the consequence, not the mechanism. Nobody reads a footer
              // popover to learn about PATH precedence; they read it to find
              // out whether they have a problem and what fixes it.
              <p className="ui-cloud-note">
                Aura is fine — it runs the newer one. But an <code>aura</code> command you type
                yourself gets the old copy.{" "}
                {info.shadowing?.writable
                  ? "Update replaces it."
                  : "Replacing it needs your computer\u2019s password."}
              </p>
            )}
            {/* One-click update — installs the binary bundled with this
                release in place. No terminal, no compile. */}
            {onUpdate && (
              <Button
                className="ui-cli-update"
                onClick={() => void runUpdate()}
                disabled={updating}
                title="Install the CLI bundled with this app version"
              >
                {updating ? <AsciiSpinner size={12} /> : null}
                {updating
                  ? "Updating…"
                  : info.status === "missing"
                    ? `Install Aura CLI ${info.expected}`
                    : shadowed
                      ? `Replace the old copy with ${info.expected}`
                      : `Update to ${info.expected}`}
              </Button>
            )}
            {updateError && (
              <Alert variant="destructive">
                <AlertDescription>{updateError}</AlertDescription>
              </Alert>
            )}
            <p className="ui-cli-manual">Or install it yourself:</p>
            <div className="ui-cli-command">
              <code title={installCmd}>{installCmd}</code>
              <Button
                variant="ghost"
                size="icon-sm"
                aria-label={copied ? "Copied" : "Copy the install command"}
                title={copied ? "Copied" : "Copy the install command"}
                onClick={copyInstall}
              >
                {copied ? <Check /> : <Copy />}
              </Button>
            </div>
          </section>
        )}
      </PopoverContent>
    </Popover>
  );
}

/** A path that wraps at its slashes rather than in the middle of a name. */
function PathText({ path }: { path: string }) {
  const parts = path.split("/");
  return (
    <span>
      {parts.map((part, i) => (
        <span key={i}>
          {i > 0 && "/"}
          {i > 0 && <wbr />}
          {part}
        </span>
      ))}
    </span>
  );
}
