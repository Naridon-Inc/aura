// Which org the app is acting as, on the renderer side.
//
// An Aura account is not one team. Every signup already owns an org, joining a
// company's adds a second, a contractor's a third — and personal is simply an
// org of one. Until now the desktop knew this and did nothing with it: the slug
// the pairing exchange wrote was printed under your name and never sent
// anywhere, so changing which org you were acting as meant signing out.
//
// The choice itself lives on disk next to the token (`cloud_org_slug` in
// `~/.aura/credentials.json`), written by `cloud_org_switch` and read by every
// cloud call through the `X-Aura-Org` header. That makes it survive a restart,
// and makes the CLI and the app agree on who you are without either telling the
// other. This module is the renderer's half: fetch the list, make the switch,
// and tell every surface that what it is showing just stopped being true.
//
// ## Why one event and not a store
//
// The lists that follow the org — projects, jobs, machines, runners — are each
// already fetched by the surface that shows them, from the backend, filtered
// there. None of them wants a copy of the org in renderer state; they want to
// know when to ask again. So the switch broadcasts, exactly like sign-in
// already does, and every list re-reads itself. A surface added tomorrow gets
// this for free by listening, with nothing to wire up here.

import { useCallback, useEffect, useRef, useState } from "react";

import { api, type CloudOrg } from "./api";
import { forgetMachineNames } from "./machineName";

/** Broadcast after the acting org changes. Anything showing org-scoped rows —
 *  projects, places, jobs, runners — should re-read on this. */
export const ORG_CHANGED_EVENT = "aura:cloud-org-changed";

/** Re-read on an org switch *or* a sign-in/out, since both change who you are.
 *  Returns the unsubscribe, so an effect can `return onOrgChanged(fn)`. */
export function onOrgChanged(fn: () => void): () => void {
  window.addEventListener(ORG_CHANGED_EVENT, fn);
  window.addEventListener("aura:cloud-auth-changed", fn);
  return () => {
    window.removeEventListener(ORG_CHANGED_EVENT, fn);
    window.removeEventListener("aura:cloud-auth-changed", fn);
  };
}

/** Act as `slug`, and keep acting as it after a restart.
 *
 *  Clears the machine-name cache before announcing, so a surface that redraws
 *  on the event resolves names against the new org's book rather than the one
 *  we just left. Returns the refreshed list; throws the backend's own message
 *  (not signed in / unreachable / not one of your orgs) unchanged. */
export async function switchOrg(slug: string): Promise<CloudOrg[]> {
  const orgs = await api.cloudOrgSwitch(slug);
  forgetMachineNames();
  window.dispatchEvent(new CustomEvent(ORG_CHANGED_EVENT, { detail: { slug } }));
  // Auth did not change, but "who am I acting as" did, and every surface that
  // already listens for the first question is asking the second one.
  window.dispatchEvent(new CustomEvent("aura:cloud-auth-changed"));
  return orgs;
}

/** What the switcher knows right now.
 *
 *  `error` and an empty `orgs` are different states on purpose. "We could not
 *  ask" must never render as "you belong to no orgs", which cannot happen:
 *  every account owns at least its own. */
export type OrgsState = {
  orgs: CloudOrg[];
  loading: boolean;
  error: string | null;
  /** Whether anything has come back yet — an empty list before the first
   *  answer is not the same as an empty list after it. */
  loaded: boolean;
  reload: () => void;
};

/** The account's orgs, fetched when `active` first turns true.
 *
 *  Gated rather than fetched on mount because the list costs a round trip to
 *  `/api/v2/repos` and is only ever looked at inside an open menu. Signed out,
 *  pass `false` and nothing is asked at all. */
export function useCloudOrgs(active: boolean): OrgsState {
  const [orgs, setOrgs] = useState<CloudOrg[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [nonce, setNonce] = useState(0);
  // Stops a slow first read from overwriting a newer one — the menu can be
  // closed and reopened, and a switch reloads while a fetch is still out.
  const generation = useRef(0);

  const reload = useCallback(() => setNonce((n) => n + 1), []);

  useEffect(() => {
    if (!active) return;
    const mine = ++generation.current;
    setLoading(true);
    setError(null);
    void api
      .cloudOrgs()
      .then((list) => {
        if (generation.current !== mine) return;
        setOrgs(list);
        setLoaded(true);
        setLoading(false);
      })
      .catch((e: unknown) => {
        if (generation.current !== mine) return;
        setError(messageOf(e));
        setLoading(false);
      });
  }, [active, nonce]);

  useEffect(() => onOrgChanged(reload), [reload]);

  return { orgs, loading, error, loaded, reload };
}

/** A backend error as a sentence a person can act on.
 *
 *  Tauri hands back a plain string; the rest is defence against whatever else
 *  reaches a catch block. Never `[object Object]`, and never empty — a blank
 *  error state is indistinguishable from a working one that found nothing. */
export function messageOf(e: unknown): string {
  if (typeof e === "string" && e.trim()) return e.trim();
  if (e instanceof Error && e.message.trim()) return e.message.trim();
  return "Could not reach Aura Cloud.";
}

/** What to print for an org — its name, or the slug when the server had none.
 *  A row nobody can read is a row nobody can pick. */
export function orgLabel(org: CloudOrg): string {
  return org.name.trim() || org.slug;
}

/** How many projects switching to it would show you, in words.
 *
 *  Zero is a real, common answer — an org you were invited to and hold nothing
 *  in yet — and it should read as an invitation rather than as a fault. */
export function orgSubtitle(org: CloudOrg): string {
  if (org.repo_count === 1) return "1 project";
  if (org.repo_count === 0) return "No projects yet";
  return `${org.repo_count} projects`;
}
