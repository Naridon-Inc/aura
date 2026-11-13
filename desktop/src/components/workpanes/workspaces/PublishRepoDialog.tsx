// The no-repo gate.
//
// A folder that isn't tracked can't have history, can't have parallel copies,
// and can't have anything proved about it — so Aura can't do its job there.
// Rather than opening it into a dead app, we ask the one question that fixes
// it and then do the whole setup in a single step.
//
// It doesn't assume GitHub. Both GitHub and GitLab are offered, always, and each is shown with its real
// state read from the machine — installed, signed in, and which accounts and
// organisations you can actually create under. A host you can't use says why,
// phrased as the thing to do about it, instead of silently vanishing.
//
// Private is the default and stays the default. Publishing someone's work to
// the open internet is not a checkbox we tick for them.

import { useEffect, useMemo, useRef, useState } from "react";

import { Check } from "lucide-react";
import { Dialog } from "../../Dialog";
import { Alert, AlertDescription } from "../../ui/alert";
import { AsciiSpinner } from "../../ui/ascii-spinner";
import { Button } from "../../ui/button";
import { Checkbox } from "../../ui/checkbox";
import { Input } from "../../ui/input";
import { Select } from "../../ui/select";
import { api, type HostProvider, type RepoState } from "../../../lib/api";
import "../../ui/log-note.css";
import "../../ui/intent-edit.css";
import "../../ui/publish-repo.css";

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
          <Button variant="outline" onClick={onClose} disabled={busy}>
            Cancel
          </Button>
          <Button onClick={publish} disabled={!canPublish}>
            {busy ? "Setting up…" : "Create repository"}
          </Button>
        </>
      }
    >
      {loading ? (
        error ? (
          <Alert variant="destructive">
            <AlertDescription>{error}</AlertDescription>
          </Alert>
        ) : (
          <p className="ui-log-note-state" role="status">
            <AsciiSpinner />
            Checking this folder and your accounts…
          </p>
        )
      ) : (
        <div className="ui-publish-repo">
          <p className="ui-publish-repo-intro">
            {state.is_repo
              ? "This folder keeps its own history, but it has nowhere to send it. Aura will create a repository and upload what's here."
              : "Aura will start keeping this folder's history, create a repository for it, and upload what's here, so your work is backed up and you can run several copies of it side by side."}
          </p>

          {/* Host. Both are always listed: one of them being unavailable is
              information, not a reason to hide the choice. */}
          <section className="ui-form-field">
            <span id="publish-repo-where">Where</span>
            <ul
              className="ui-log-note-list ui-publish-repo-hosts"
              role="radiogroup"
              aria-labelledby="publish-repo-where"
            >
              {hosts.map((p) => {
                const usable = p.installed && p.signed_in;
                const active = p.id === providerId;
                return (
                  <li key={p.id}>
                    <button
                      type="button"
                      role="radio"
                      aria-checked={active}
                      data-unusable={usable ? undefined : ""}
                      className="ui-intent-edit-target"
                      onClick={() => {
                        setProviderId(p.id);
                        setOwner(p.account ?? p.owners[0]?.login ?? "");
                      }}
                    >
                      <Check aria-hidden />
                      <span>
                        <strong>{p.label}</strong>
                        <small>
                          {usable ? (p.account ?? "Signed in") : (p.hint ?? "Not available")}
                        </small>
                      </span>
                    </button>
                  </li>
                );
              })}
            </ul>
          </section>

          {/* Everything below only means something once a host can be used. */}
          {ready && provider && (
            <>
              <label className="ui-form-field">
                Owner
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
              </label>

              <label className="ui-form-field">
                Name
                <Input
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  prefix={owner ? `${owner}/` : undefined}
                  invalid={check.kind === "taken"}
                  spellCheck={false}
                  autoCapitalize="off"
                  autoCorrect="off"
                  className="ui-publish-repo-name"
                  onKeyDown={(e) => {
                    if (e.key === "Enter" && canPublish) void publish();
                  }}
                />
                <NameVerdict check={check} />
              </label>

              <label className="ui-check-label">
                <Checkbox
                  checked={isPrivate}
                  onCheckedChange={(v) => setIsPrivate(v === true)}
                />
                Private. Only you and people you invite can see it
              </label>
            </>
          )}

          {!ready && provider && (
            <p className="ui-publish-repo-help">
              {provider.hint ?? `${provider.label} isn't available on this machine yet.`}
            </p>
          )}

          {error && (
            <Alert variant="destructive">
              <AlertDescription>{error}</AlertDescription>
            </Alert>
          )}
        </div>
      )}
    </Dialog>
  );
}

/** What the host said about the name, under the field. Quiet until asked. */
function NameVerdict({ check }: { check: NameCheck }) {
  if (check.kind === "idle") return null;
  const text =
    check.kind === "checking"
      ? "Checking the name…"
      : check.kind === "free"
        ? "Available"
        : check.kind === "taken"
          ? "Already taken. Pick another name."
          : "Couldn’t check the name. You can still try.";
  return (
    <span
      className="ui-publish-repo-verdict"
      data-tone={check.kind}
      title={check.kind === "unknown" ? check.why : undefined}
    >
      {text}
    </span>
  );
}
