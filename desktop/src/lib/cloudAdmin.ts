// The org's own settings over the desktop's signed-in token: API keys, the
// plan's checkout and billing portal, and making an organization. Each call is
// one Tauri command (cmd_cloud_admin.rs); a refusal is the server's sentence.

import { invoke } from "@tauri-apps/api/core";

/** One API key as `GET /orgs/{slug}/api-keys` lists it. */
export type CloudApiKey = {
  id: string;
  label: string;
  key_prefix?: string | null;
  scopes: string[];
  created_by?: { login?: string | null; name?: string | null } | null;
  created_at?: string | null;
  last_used_at?: string | null;
  revoked_at?: string | null;
  revocable?: boolean;
};

/** What a key may do, in the server's words (aura-cloud `ALL_SCOPES`). */
export const API_SCOPES: { id: string; label: string }[] = [
  { id: "repo:read", label: "Read repositories" },
  { id: "intent:write", label: "Record change reasons" },
  { id: "repo:push", label: "Push to repositories" },
  { id: "crew:claim", label: "Claim crew tasks" },
  { id: "sync:push", label: "Push live sync" },
  { id: "places:run", label: "Run on cloud computers" },
  { id: "billing:read", label: "Read billing" },
];

export const listApiKeys = () => invoke<CloudApiKey[]>("cloud_api_keys");

export const createApiKey = (label: string, scopes: string[]) =>
  invoke<{ key: CloudApiKey; token: string }>("cloud_api_key_create", { label, scopes });

export const revokeApiKey = (id: string) => invoke<void>("cloud_api_key_revoke", { id });

/** A Stripe checkout link for Pro or Team, cloud computer included.
 *  `returnTo` is where Stripe comes back; `size` asks for a bigger computer
 *  on Teams. */
export const billingCheckout = (plan: "pro" | "team", seats: number | null, returnTo: string, size?: string | null) =>
  invoke<string>("cloud_billing_checkout", { plan, seats, returnTo, size: size ?? null });

export const billingPortal = (returnTo: string) => invoke<string>("cloud_billing_portal", { returnTo });

export type CreatedOrg = { id: string; slug: string; name: string };

export const createOrg = (name: string, slug: string) =>
  invoke<CreatedOrg>("cloud_org_create", { name, slug });

/** An organization's web address from its name: lowercase words joined by dashes. */
export function slugOf(name: string): string {
  return name
    .normalize("NFKD")
    .replace(/\p{M}/gu, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40)
    .replace(/-+$/g, "");
}

export function slugOk(slug: string): boolean {
  return /^[a-z0-9](?:[a-z0-9-]{0,38}[a-z0-9])$/.test(slug);
}

/** Which keys are still live, newest use first; revoked keys drop out. */
export function liveKeys(keys: CloudApiKey[]): CloudApiKey[] {
  return keys.filter((k) => !k.revoked_at);
}

/** "Created 3 Nov · aura_ab12…" — the line under a key's name. */
export function keyLine(key: CloudApiKey, now = Date.now()): string {
  const parts: string[] = [];
  if (key.created_at) parts.push(`Created ${dayOf(key.created_at, now)}`);
  if (key.last_used_at) parts.push(`used ${dayOf(key.last_used_at, now)}`);
  else parts.push("never used");
  if (key.key_prefix) parts.push(`${key.key_prefix}…`);
  return parts.join(" · ");
}

function dayOf(iso: string, now: number): string {
  const at = new Date(iso);
  if (Number.isNaN(at.getTime())) return "earlier";
  const days = Math.floor((now - at.getTime()) / 86_400_000);
  if (days <= 0) return "today";
  if (days === 1) return "yesterday";
  return at.toLocaleDateString(undefined, { day: "numeric", month: "short" });
}
