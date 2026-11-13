// Who the app is signed in to Aura Cloud as, shared by the surfaces that show it.
//
// The read itself is cheap (it is the credentials file, not the network), but
// each surface asking on its own open meant each one painted empty first and
// each one carried its own `aura:cloud-auth-changed` listener. Under the
// shared cache the answer is on screen at once, and because the key is
// account-scoped (`cloud:`), a sign-in, sign-out or org switch drops it and
// every surface showing it re-reads; nothing paints the previous account.

import { api } from "./api";
import { useCachedResource } from "./useCachedResource";

export const CLOUD_AUTH_KEY = "cloud:auth-status";

const read = () => api.cloudAuthStatus();

export function useCloudAuthStatus() {
  return useCachedResource(CLOUD_AUTH_KEY, read);
}
