// "Secrets & tools" — what an agent finds in its environment on a machine.
//
// Two halves that people conflate and the backend keeps apart. The top half
// is the vault: named values (API keys, tokens) kept in a 0600 file on this
// laptop and handed to the work's process environment at boot — never shown
// back, not even masked. The bottom half is the project's declared toolchain,
// checked and installed on the chosen machine in place.
//
// A KEY=VALUE paste box is the fast way in for someone holding a `.env` file:
// each line becomes one kept secret. That is what "environment" means to the
// person typing, and it is honest about where those lines go.

import { useCallback, useEffect, useState } from "react";
import { Plus } from "lucide-react";
import type { Place } from "../../lib/place/contract";
import {
  forgetSecret,
  keepSecret,
  listSecrets,
  type SecretRef,
} from "../../lib/place/secrets";
import { AsciiSpinner } from "../ui/ascii-spinner";
import { askConfirm } from "../ui/ask";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { Textarea } from "../ui/textarea";
import { ErrorNote, LoadingState } from "../ui/state";
import { Field, PaneIntro, Row, Section } from "./kit";
import { PlaceEnvSpecSection } from "./PlaceEnvSpecSection";
import { PlacePicker, useProjectPlaces } from "./PlacePicker";
import { PlaceSecretRow } from "./PlaceSecretRow";

/** `KEY=VALUE` lines → pairs. Blank lines and `#` comments are skipped, an
 *  optional leading `export ` is dropped, and one layer of matching quotes
 *  around the value comes off — the three things a real `.env` has in it. */
export function parseEnvLines(text: string): Array<{ name: string; value: string }> {
  const out: Array<{ name: string; value: string }> = [];
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const body = line.startsWith("export ") ? line.slice(7).trim() : line;
    const eq = body.indexOf("=");
    if (eq <= 0) continue;
    const name = body.slice(0, eq).trim();
    let value = body.slice(eq + 1).trim();
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) continue;
    if (
      value.length >= 2 &&
      ((value.startsWith('"') && value.endsWith('"')) ||
        (value.startsWith("'") && value.endsWith("'")))
    ) {
      value = value.slice(1, -1);
    }
    out.push({ name, value });
  }
  return out;
}

export function PlaceEnvPane({ repoRoot }: { repoRoot: string }) {
  const places = useProjectPlaces(repoRoot);
  const [place, setPlace] = useState<Place>(places[0]);
  // The place object is rebuilt when the machine list changes; keep the
  // selection by id rather than by reference.
  useEffect(() => {
    const kept = places.find((p) => p.machineId === place.machineId);
    if (!kept) setPlace(places[0]);
    else if (kept !== place) setPlace(kept);
  }, [places, place]);

  const [secrets, setSecrets] = useState<SecretRef[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [busyName, setBusyName] = useState<string | null>(null);

  const [name, setName] = useState("");
  const [value, setValue] = useState("");
  const [gitHost, setGitHost] = useState("");
  const [adding, setAdding] = useState(false);

  const [bulk, setBulk] = useState("");
  const [bulkBusy, setBulkBusy] = useState(false);
  const [bulkNote, setBulkNote] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      setSecrets(await listSecrets(repoRoot));
    } catch (e) {
      setError(String(e));
    } finally {
      setLoading(false);
    }
  }, [repoRoot]);

  useEffect(() => {
    void load();
  }, [load]);

  const add = async () => {
    const n = name.trim();
    if (!n || !value) return;
    setAdding(true);
    setError(null);
    try {
      const host = gitHost.trim();
      setSecrets(await keepSecret(repoRoot, n, value, host ? { gitHost: host } : undefined));
      setName("");
      setValue("");
      setGitHost("");
    } catch (e) {
      setError(String(e));
    } finally {
      setAdding(false);
    }
  };

  const addMany = async () => {
    const pairs = parseEnvLines(bulk);
    if (pairs.length === 0) {
      setBulkNote("Nothing to add — lines need to look like NAME=value.");
      return;
    }
    setBulkBusy(true);
    setBulkNote(null);
    setError(null);
    try {
      let last: SecretRef[] = secrets;
      for (const p of pairs) last = await keepSecret(repoRoot, p.name, p.value);
      setSecrets(last);
      setBulk("");
      setBulkNote(pairs.length === 1 ? "Kept 1 secret." : `Kept ${pairs.length} secrets.`);
    } catch (e) {
      setError(String(e));
      void load();
    } finally {
      setBulkBusy(false);
    }
  };

  const forget = async (s: SecretRef) => {
    const ok = await askConfirm({
      title: `Forget ${s.name}?`,
      body: "Work you start after this will not have it. Anything already running keeps it until it finishes.",
      confirmLabel: "Forget",
      tone: "danger",
    });
    if (!ok) return;
    setBusyName(s.name);
    setError(null);
    try {
      setSecrets(await forgetSecret(repoRoot, s.name));
    } catch (e) {
      setError(String(e));
    } finally {
      setBusyName(null);
    }
  };

  const exists = secrets.some((s) => s.name === name.trim());

  return (
    <div>
      <PaneIntro text="Secrets your agents can use on this machine — API keys and tokens, kept on this laptop and handed to the work when it starts. Nothing here is ever shown back or sent to a model. Below that, the tools the project says a machine needs." />

      <Row
        label="Machine"
        description="Secrets are kept once for the project and reach whichever machine the work runs on. The tools list below is checked per machine."
      >
        <PlacePicker places={places} value={place} onChange={setPlace} />
      </Row>

      <Section title="Secrets">
        {error && <ErrorNote className="mb-3">{error}</ErrorNote>}
        {loading ? (
          <LoadingState label="Reading the vault…" />
        ) : secrets.length === 0 ? (
          <p className="py-2 text-[13px] text-text-3">
            Nothing kept for this project yet. Add one below, or paste a whole set at once.
          </p>
        ) : (
          <div>
            {secrets.map((s) => (
              <PlaceSecretRow
                key={s.name}
                secret={s}
                busy={busyName === s.name}
                onForget={() => void forget(s)}
              />
            ))}
          </div>
        )}
      </Section>

      <Section title="Add or replace one">
        <Field label="Name" hint="The variable it arrives as, e.g. OPENAI_API_KEY. Using a name that is already kept replaces its value.">
          <Input
            value={name}
            onChange={(e) => setName(e.target.value.toUpperCase().replace(/[^A-Z0-9_]/g, "_"))}
            placeholder="OPENAI_API_KEY"
            spellCheck={false}
            className="font-mono"
          />
        </Field>
        <Field label="Value" hint="Kept on this laptop only. You will not be able to read it back from here.">
          <Input
            type="password"
            value={value}
            onChange={(e) => setValue(e.target.value)}
            placeholder="paste the secret"
            autoComplete="off"
            spellCheck={false}
          />
        </Field>
        <Field label="Pushes to (optional)" hint="Fill this in for a Git token, so pushes to that host go out under your name: github.com, gitlab.com, or your own host.">
          <Input
            value={gitHost}
            onChange={(e) => setGitHost(e.target.value)}
            placeholder="github.com"
            spellCheck={false}
          />
        </Field>
        <div className="flex items-center gap-2 py-2">
          <Button size="sm" onClick={() => void add()} disabled={adding || !name.trim() || !value}>
            {adding ? <AsciiSpinner /> : <Plus />}
            {exists ? "Replace" : "Keep secret"}
          </Button>
        </div>
      </Section>

      <Section title="Add several at once">
        <Field label="Lines" hint="One per line, like a .env file: NAME=value. Comments and blank lines are ignored. Each line becomes one kept secret.">
          <Textarea
            value={bulk}
            onChange={(e) => setBulk(e.target.value)}
            rows={5}
            placeholder={"ANTHROPIC_API_KEY=sk-…\nDATABASE_URL=postgres://…"}
            spellCheck={false}
            className="font-mono text-xs"
          />
        </Field>
        <div className="flex items-center gap-3 py-2">
          <Button size="sm" variant="secondary" onClick={() => void addMany()} disabled={bulkBusy || !bulk.trim()}>
            {bulkBusy ? <AsciiSpinner /> : <Plus />}
            Keep all
          </Button>
          {bulkNote && <span className="text-xs text-text-3">{bulkNote}</span>}
        </div>
      </Section>

      <PlaceEnvSpecSection place={place} />
    </div>
  );
}
