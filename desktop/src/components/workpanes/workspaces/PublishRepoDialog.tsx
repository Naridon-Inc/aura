// The no-repo gate.
//
// A folder that isn't tracked can't have history, can't have parallel copies,
// and can't have anything proved about it — so Aura can't do its job there.
// Rather than opening it into a dead app, we ask the one question that fixes
// it and then do the whole setup in a single step.
//
// Where this differs from the tool we're following: it doesn't assume GitHub.
// Both GitHub and GitLab are offered, always, and each is shown with its real
// state read from the machine — installed, signed in, and which accounts and
// organisations you can actually create under. A host you can't use says why,
// phrased as the thing to do about it, instead of silently vanishing.
//
// Private is the default and stays the default. Publishing someone's work to
// the open internet is not a checkbox we tick for them.

import { useEffect, useMemo, useRef, useState } from "react";

import { Dialog } from "../../Dialog";
import { Button } from "../../ui/button";
import { Select } from "../../ui/select";
import { Checkbox } from "../../ui/checkbox";
import { AsciiSpinner } from "../../AsciiSpinner";
import { api, type HostProvider, type RepoState } from "../../../lib/api";

type Props = {
  /** Folder being set up. */
  dir: string;
  onClose: () => void;
  onPublished: () => void;
};

/** Availability of the chosen name on the chosen host. */
type NameCheck =
  | { kind: "idle" }
  | { kind: "checking" }
  | { kind: "free" }
  | { kind: "taken" }
  | { kind: "unknown"; why: string };

const CHECK_DEBOUNCE_MS = 450;

export function PublishRepoDialog({ dir, onClose, onPublished }: Props) {
  const [state, setState] = useState<RepoState | null>(null);
  const [hosts, setHosts] = useState<HostProvider[] | null>(null);
  const [providerId, setProviderId] = useState("");
  const [owner, setOwner] = useState("");
  const [name, setName] = useState("");
  const [isPrivate, setIsPrivate] = useState(true);
  const [check, setCheck] = useState<NameCheck>({ kind: "idle" });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const [s, h] = await Promise.all([api.repoState(dir), api.repoHosts(dir)]);
        if (cancelled) return;
        setState(s);
        setHosts(h);
        setName(s.suggested_name);
        // Default to a host that can actually be used right now, so the
        // common case needs no choice at all.
        const usable = h.find((p) => p.installed && p.signed_in) ?? h[0];
        if (usable) {
          setProviderId(usable.id);
          setOwner(usable.account ?? usable.owners[0]?.login ?? "");
        }
      } catch (e) {
        if (!cancelled) setError(String(e));
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [dir]);

  const provider = useMemo(
    () => hosts?.find((p) => p.id === providerId) ?? null,
    [hosts, providerId],
  );
  const ready = Boolean(provider?.installed && provider?.signed_in);

  // Name availability. Debounced, and every reply is matched against the
  // request that is still current — otherwise a slow answer for a name the
  // user already retyped lands on screen as the verdict for the new one.
  const inFlight = useRef("");
  useEffect(() => {
    const trimmed = name.trim();
    if (!ready || !provider || !owner || !trimmed) {
      setCheck({ kind: "idle" });
      return;
    }
    const key = `${provider.id}/${owner}/${trimmed}`;
    inFlight.current = key;
    setCheck({ kind: "checking" });
    const timer = setTimeout(async () => {
      try {
        const free = await api.repoNameFree(provider.id, owner, trimmed);
        if (inFlight.current !== key) return;
        setCheck({ kind: free ? "free" : "taken" });
      } catch (e) {
        if (inFlight.current !== key) return;
        // A failed lookup is not a failed name — say so rather than
        // blocking someone on a network blip.
        setCheck({ kind: "unknown", why: String(e) });
      }
    }, CHECK_DEBOUNCE_MS);
    return () => clearTimeout(timer);
  }, [name, owner, provider, ready]);

  async function publish() {
    const trimmed = name.trim();
    if (!provider || !owner || !trimmed || busy) return;
    setBusy(true);
    setError(null);
    try {
      await api.repoPublish(dir, provider.id, owner, trimmed, isPrivate);
      onPublished();
    } catch (e) {
      setError(String(e));
      setBusy(false);
    }
  }

  const loading = !state || !hosts;
  const canPublish = ready && Boolean(owner) && Boolean(name.trim()) && check.kind !== "taken" && !busy;

  return (
    <Dialog
      open
      width={480}
      title="Set up a repository"
      onClose={onClose}
      footer={
        <>
          <Button variant="ghost" size="xs" onClick={onClose} disabled={busy}>
            Cancel
          </Button>
          <Button size="xs" onClick={publish} disabled={!canPublish}>
            {busy ? "Setting up…" : "Create repository"}
          </Button>
        </>
      }
    >
      {loading ? (
        <div className="flex items-center gap-2 py-6 text-sm" style={{ color: "var(--color-text-4)" }}>
          <AsciiSpinner /> Checking this folder and your accounts…
        </div>
      ) : (
        <div className="flex flex-col gap-3.5">
          <p className="text-base leading-relaxed" style={{ color: "var(--color-text-2)" }}>
            {state.is_repo
              ? "This folder keeps its own history, but it has nowhere to send it. Aura will create a repository and upload what's here."
              : "Aura will start keeping this folder's history, create a repository for it, and upload what's here, so your work is backed up and you can run several copies of it side by side."}
          </p>

          {/* Host. Both are always listed: one of them being unavailable is
              information, not a reason to hide the choice. */}
          <Field label="Where">
            <div className="flex gap-1.5">
              {hosts.map((p) => {
                const usable = p.installed && p.signed_in;
                const active = p.id === providerId;
                return (
                  <button
                    key={p.id}
                    type="button"
                    onClick={() => {
                      setProviderId(p.id);
                      setOwner(p.account ?? p.owners[0]?.login ?? "");
                    }}
                    className="flex flex-1 flex-col items-start gap-0.5 rounded-sm px-2.5 py-1.5 text-left transition-colors"
                    style={{
                      background: active ? "var(--color-accent-soft)" : "var(--color-bg-2)",
                      border: `1px solid ${active ? "var(--color-accent)" : "var(--color-line-soft)"}`,
                      opacity: usable ? 1 : 0.65,
                    }}
                  >
                    <span
                      className="text-sm font-medium"
                      style={{ color: active ? "var(--color-accent)" : "var(--color-text-2)" }}
                    >
                      {p.label}
                    </span>
                    <span className="truncate text-xs" style={{ color: "var(--color-text-4)" }}>
                      {usable ? (p.account ?? "signed in") : (p.hint ?? "not available")}
                    </span>
                  </button>
                );
              })}
            </div>
          </Field>

          {/* Everything below only means something once a host can be used. */}
          {ready && provider && (
            <>
              <Field label="Owner">
                <Select
                  value={owner}
                  onChange={setOwner}
                  aria-label="Owner"
                  options={provider.owners.map((o) => ({
                    value: o.login,
                    label: o.kind === "user" ? o.login : `${o.login} (${o.kind})`,
                  }))}
                  placeholder={provider.owners.length ? "Choose an owner" : "No accounts found"}
                  disabled={provider.owners.length === 0}
                />
              </Field>

              <Field label="Name">
                <input
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  spellCheck={false}
                  autoCapitalize="off"
                  autoCorrect="off"
                  className="w-full rounded-sm px-2 py-1 font-mono text-sm outline-none"
                  style={{
                    background: "var(--color-bg-2)",
                    color: "var(--color-text-1)",
                    border: `1px solid ${check.kind === "taken" ? "var(--color-red)" : "var(--color-line-soft)"}`,
                  }}
                />
                <div className="mt-1 flex items-center gap-1.5 text-xs">
                  <span className="font-mono" style={{ color: "var(--color-text-4)" }}>
                    {owner}/{name.trim() || "…"}
                  </span>
                  <NameVerdict check={check} />
                </div>
              </Field>

              <label className="flex cursor-pointer items-center gap-2">
                <Checkbox
                  checked={isPrivate}
                  onCheckedChange={(v) => setIsPrivate(v === true)}
                  aria-label="Keep this repository private"
                />
                <span className="text-sm" style={{ color: "var(--color-text-2)" }}>
                  Private. Only you and people you invite can see it
                </span>
              </label>
            </>
          )}

          {!ready && provider && (
            <p className="text-sm leading-relaxed" style={{ color: "var(--color-text-3)" }}>
              {provider.hint ?? `${provider.label} isn't available on this machine yet.`}
            </p>
          )}

          {error && (
            <p className="text-sm leading-relaxed" style={{ color: "var(--color-red)" }}>
              {error}
            </p>
          )}
        </div>
      )}
    </Dialog>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex flex-col gap-1">
      <span
        className="section-label"
        style={{ color: "var(--color-text-4)" }}
      >
        {label}
      </span>
      {children}
    </div>
  );
}

function NameVerdict({ check }: { check: NameCheck }) {
  if (check.kind === "checking")
    return <span style={{ color: "var(--color-text-5)" }}>checking…</span>;
  if (check.kind === "free")
    return <span style={{ color: "var(--color-text-3)" }}>available</span>;
  if (check.kind === "taken")
    return <span style={{ color: "var(--color-red)" }}>already taken</span>;
  if (check.kind === "unknown")
    return <span style={{ color: "var(--color-text-5)" }}>couldn&rsquo;t check</span>;
  return null;
}
