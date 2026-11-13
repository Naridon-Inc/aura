// Put a project on the box that isn't on it yet.
//
// Without this, a machine can only ever work on whatever happened to be
// cloned there by hand — which makes "run several of my projects on one box"
// a thing you do over ssh in another window and then come back to. Collapsed
// by default, because it is the thing you do once per project and the panel
// above it is the thing you do every day.

import { useCallback, useEffect, useMemo, useState, type KeyboardEvent } from "react";
import { Plus } from "lucide-react";

import { api, type BoxSession } from "../../lib/api";
import {
  askPushCredential,
  credentialSentence,
  credentialTone,
  placeAddress,
  whyNotMine,
  type Place,
  type PushPlan,
} from "../../lib/place";
import { AsciiSpinner } from "../ui/ascii-spinner";
import { Button } from "../ui/button";
import { Input } from "../ui/input";

export function AddProject({
  place,
  onStarted,
  onError,
}: {
  place: Place;
  onStarted: (s: BoxSession) => void;
  onError: (msg: string | null) => void;
}) {
  const [open, setOpen] = useState(false);
  const [url, setUrl] = useState("");
  const [cloning, setCloning] = useState(false);

  // What the folder ends up called, unless you say otherwise. Nobody wants to
  // type the repo's name twice, and `naridon.git` is not what it should be
  // called on disk.
  const [dir, setDir] = useState("");
  const suggested = useMemo(() => repoFolderName(url), [url]);
  const folder = dir.trim() || suggested;
  const machineId = placeAddress(place);

  const clone = useCallback(async () => {
    if (!url.trim() || !folder) return;
    setCloning(true);
    onError(null);
    try {
      const s = await api.boxClone(machineId, url.trim(), folder);
      setUrl("");
      setDir("");
      setOpen(false);
      // A clone is minutes of output on a big repo, so it comes back as a
      // session you can watch rather than a spinner you have to sit in front
      // of — and it keeps going if you close the window.
      onStarted(s);
    } catch (e) {
      onError(e instanceof Error ? e.message : String(e));
    } finally {
      setCloning(false);
    }
  }, [machineId, url, folder, onStarted, onError]);

  if (!open) {
    return (
      <Button
        variant="ghost"
        size="sm"
        className="ui-box-add"
        onClick={() => setOpen(true)}
      >
        <Plus /> Put another project on this machine
      </Button>
    );
  }

  const keys = (e: KeyboardEvent) => {
    if (e.key === "Enter" && !cloning) void clone();
    if (e.key === "Escape") setOpen(false);
  };

  return (
    // Escape here closes this form, not the whole panel — the panel reads
    // the mark and stays open.
    <div className="ui-box-form">
      <div className="ui-cloud-row">
        <strong>Put a repository on this machine</strong>
      </div>
      <Input
        value={url}
        onChange={(e) => setUrl(e.target.value)}
        onKeyDown={keys}
        placeholder="https://github.com/you/repo.git"
        aria-label="Repository address to clone"
        className="ui-box-mono"
        autoFocus
      />
      <Input
        value={dir}
        onChange={(e) => setDir(e.target.value)}
        onKeyDown={keys}
        placeholder={suggested ? `Folder name (${suggested})` : "Folder name"}
        aria-label="Folder name on the machine"
        className="ui-box-mono"
      />
      {/* Where it lands is the machine's answer, not ours — this laptop has
          no idea where that box keeps things, and a guess would put someone's
          project somewhere they never chose. */}
      <p className="ui-cloud-note">
        It goes in the machine’s home directory, and the clone runs there — you
        can close this window while it finishes.
      </p>
      {/* Whose token this clone will spend, said before it is spent. */}
      <PushCredentialLine place={place} remote={url} />
      <div className="ui-cloud-inline">
        <Button
          size="sm"
          disabled={!url.trim() || !folder || cloning}
          onClick={() => void clone()}
        >
          {cloning ? (
            <>
              <AsciiSpinner size={10} /> Starting the clone…
            </>
          ) : (
            "Clone it there"
          )}
        </Button>
        <Button variant="ghost" size="sm" onClick={() => setOpen(false)}>
          Cancel
        </Button>
      </div>
    </div>
  );
}

/** Which credential this place will spend on a remote, before it spends it.
 *
 *  A clone is the first push credential a project ever uses, and on a shared
 *  box it is one token belonging to whoever provisioned it. That still works —
 *  it is the only credential most boxes have — but it is no longer allowed to
 *  be silent, because the first anyone learned whose it was used to be a commit
 *  on GitHub with the wrong name against it.
 *
 *  Takes a `Place`, not a machine id: this laptop is asked the same question in
 *  the same words. */
function PushCredentialLine({ place, remote }: { place: Place; remote: string }) {
  const [plan, setPlan] = useState<PushPlan | null>(null);

  useEffect(() => {
    const url = remote.trim();
    if (!url) {
      setPlan(null);
      return;
    }
    let live = true;
    // Typing a URL is a keystroke at a time, and each one would otherwise be a
    // round trip to a box across an ocean.
    const t = setTimeout(() => {
      askPushCredential(place, url)
        .then((p) => live && setPlan(p))
        // A place we can't reach has no answer about credentials, and guessing
        // one here would be a sentence about somebody's identity that nothing
        // checked. The clone itself still says what it did.
        .catch(() => live && setPlan(null));
    }, 400);
    return () => {
      live = false;
      clearTimeout(t);
    };
  }, [place, remote]);

  if (!plan) return null;
  const tone = credentialTone(plan);
  return (
    <p
      className="ui-box-credential"
      data-tone={tone === "shared" ? "warn" : undefined}
    >
      {credentialSentence(plan)}
      {/* Only when it is somebody else's: these are the reasons, which are also
          the instructions for having your own. */}
      {tone === "shared" &&
        whyNotMine(plan).map((why) => <span key={why}>{why}</span>)}
    </p>
  );
}

/** The folder a clone URL would naturally become. Pure, and exported-adjacent
 *  only through its own tests: `…/project.git` and `…/project` and a trailing
 *  slash all mean the same folder. */
export function repoFolderName(url: string): string {
  const cleaned = url.trim().replace(/\/+$/, "");
  if (!cleaned) return "";
  const last = cleaned.slice(cleaned.lastIndexOf("/") + 1);
  // `git@github.com:you/project.git` has no slash before the repo when someone
  // pastes only the scp-style half of it.
  const afterColon = last.slice(last.lastIndexOf(":") + 1);
  return afterColon.replace(/\.git$/i, "");
}
