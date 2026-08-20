// TunnelManager — share what you're running, not just the code that runs it.
//
// This is the thing people reach for ngrok to do, with the one difference that
// matters: an ngrok URL is a public address and anyone who has it is inside.
// Here the relay checks the same team membership the session does on every
// single request, so a leaked address opens nothing on its own.
//
// That difference is the feature, so the panel says it out loud in three plain
// sentences (`SecurityModel` below) instead of a padlock icon. The three claims
// come straight from `docs/collab/SESSION_LIVE_PROTOCOL.md` and each is a rule
// the transport actually enforces:
//
//   • org-scoped and auth'd — `/t/{code}` requires the same session membership
//     as the session that opened it;
//   • only `127.0.0.1:<port>`, and only a port explicitly opened — the host
//     never proxies to an arbitrary address;
//   • tunnels die with the socket that opened them.
//
// If any of those ever stops being true, the sentence here has to change with
// it. Copy that overstates what a transport does is worse than no copy.

import { useMemo, useState, type JSX } from "react";
import { Cable, Plug } from "lucide-react";

import { Button } from "../../ui/button";
import { Input } from "../../ui/input";
import { AsciiSpinner } from "../../ui/ascii-spinner";
import { EmptyState, ErrorState, LoadingState } from "../../ui/state";
import { TunnelRow } from "./TunnelRow";
import { TunnelSecurityNotes } from "./SecurityNotes";
import { auraDisplayUrl, type SessionTunnel } from "./shareTypes";

export type TunnelManagerProps = {
  /** Every port currently shared. `null` = we haven't managed to read them yet,
   *  which is not the same as "none open" — one is a question, the other is an
   *  answer, and the panel says something different for each. */
  tunnels: SessionTunnel[] | null;
  /** The names of the people who can reach them — the session roster, once,
   *  rather than a copy on every row. */
  reachableBy: string[];
  loading: boolean;
  error: string | null;
  onRetry: () => void;
  /** Open a port. Resolves once the relay has a code for it. */
  onOpen: (port: number, label: string) => Promise<void> | void;
  /** Close one. */
  onStop: (code: string) => Promise<void> | void;
  /** False while the session isn't shared with anyone. A tunnel with nobody in
   *  the session to reach it is a port opened for an audience of zero, so the
   *  panel says so rather than pretending it did something useful. */
  sessionShared: boolean;
};

export function TunnelManager({
  tunnels,
  reachableBy,
  loading,
  error,
  onRetry,
  onOpen,
  onStop,
  sessionShared,
}: TunnelManagerProps): JSX.Element {
  const [port, setPort] = useState("");
  const [label, setLabel] = useState("");
  const [opening, setOpening] = useState(false);
  const [openError, setOpenError] = useState<string | null>(null);

  const parsed = Number(port.trim());
  const portValid =
    port.trim() !== "" &&
    Number.isInteger(parsed) &&
    parsed >= 1 &&
    parsed <= 65535;
  const already = useMemo(
    () => (tunnels ?? []).some((t) => t.port === parsed),
    [tunnels, parsed],
  );

  async function open() {
    if (!portValid || already || opening) return;
    setOpening(true);
    setOpenError(null);
    try {
      await onOpen(parsed, label.trim() || `port ${parsed}`);
      setPort("");
      setLabel("");
    } catch (e) {
      setOpenError(e instanceof Error ? e.message : String(e));
    } finally {
      setOpening(false);
    }
  }

  return (
    <div className="flex flex-col gap-5">
      <header className="flex items-start gap-3">
        <span className="mt-0.5 grid size-8 shrink-0 place-items-center rounded-[8px] bg-accent-soft text-accent">
          <Cable size={17} />
        </span>
        <div className="min-w-0">
          <h2 className="text-md font-semibold text-text-1">
            Let them open what you&apos;re running
          </h2>
          <p className="mt-1 text-sm leading-snug text-text-4">
            Share the address of something running on this machine (your dev
            site, an API, a preview) and the people in this session can open it
            in their own browser.
          </p>
        </div>
      </header>

      {/* Open one. Two fields on one line: the number, and what it is. */}
      <form
        className="flex flex-col gap-2"
        onSubmit={(e) => {
          e.preventDefault();
          void open();
        }}
      >
        <div className="flex items-end gap-2">
          <label className="flex w-[110px] shrink-0 flex-col gap-1.5">
            <span className="text-xs font-medium text-text-4">Port</span>
            <Input
              value={port}
              onChange={(e) => setPort(e.target.value.replace(/[^0-9]/g, ""))}
              placeholder="3000"
              inputMode="numeric"
              aria-label="Port on this machine"
              invalid={port.trim() !== "" && (!portValid || already)}
              className="font-mono text-base"
            />
          </label>
          <label className="flex min-w-0 flex-1 flex-col gap-1.5">
            <span className="text-xs font-medium text-text-4">
              What is it{" "}
              <span className="font-normal text-text-5">(optional)</span>
            </span>
            <Input
              value={label}
              onChange={(e) => setLabel(e.target.value)}
              placeholder="the web app"
              aria-label="What is running on this port"
              className="text-base"
            />
          </label>
          <Button
            type="submit"
            variant="accentSoft"
            disabled={!portValid || already || opening}
            className="shrink-0"
          >
            {opening ? <AsciiSpinner size={12} /> : <Plug size={13} />}
            Share it
          </Button>
        </div>

        {port.trim() !== "" && !portValid ? (
          <p className="text-xs text-red">
            A port is a number between 1 and 65535.
          </p>
        ) : already ? (
          <p className="text-xs text-text-4">
            {auraDisplayUrl(parsed)} is already shared. It&apos;s in the list
            below.
          </p>
        ) : portValid ? (
          <p className="text-xs text-text-4">
            Teammates will see it as{" "}
            <span className="font-mono text-text-3">
              {auraDisplayUrl(parsed)}
            </span>
            .
          </p>
        ) : null}

        {openError && (
          <p role="alert" className="text-xs leading-snug text-red">
            {openError}
          </p>
        )}
      </form>

      {!sessionShared && (
        <p className="text-xs leading-snug text-amber">
          Nobody else is in this session yet, so nothing you share here is
          reachable by anyone. Open the session up first and these come alive
          for whoever joins.
        </p>
      )}

      <TunnelSecurityNotes />

      <section className="flex flex-col gap-1 border-t border-line-soft pt-4">
        <h3 className="text-xs font-medium text-text-4">Shared right now</h3>

        {loading ? (
          <LoadingState label="Checking what's shared…" />
        ) : error ? (
          <ErrorState
            title="Couldn't read your shared ports"
            message={error}
            onRetry={onRetry}
            size="sm"
          />
        ) : tunnels === null ? (
          <LoadingState label="Checking what's shared…" />
        ) : tunnels.length === 0 ? (
          <EmptyState
            icon={Plug}
            title="Nothing shared yet"
            body="Add the port your app runs on above (3000, 5173, 8080) and it shows up here."
            size="sm"
          />
        ) : (
          <ul className="flex flex-col">
            {tunnels.map((t) => (
              <TunnelRow
                key={t.code}
                tunnel={t}
                reachableBy={reachableBy}
                onStop={onStop}
              />
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}
