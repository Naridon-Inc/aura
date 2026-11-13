// Brains the app once offered and no longer does.
//
// A choice saved while one of these existed — a session's model chip, a
// loadout slot, a slot's effort — reads as "nothing chosen", so the next turn
// runs on the first agent or key the user has set up. The backend keeps the
// same list (`manager/brain/settings.rs`) for the settings it owns.
//
// `aura_pro` was a managed brain that answered through Aura's cloud on Aura's
// own key. People now pick a real model from the agents and keys they have
// connected.

/** Ids of the brains no longer offered. */
export const RETIRED_BRAIN_IDS: ReadonlySet<string> = new Set(["aura_pro"]);

/** Whether `id` names a brain this app no longer offers. */
export function isRetiredBrain(id: string | null | undefined): boolean {
  return !!id && RETIRED_BRAIN_IDS.has(id);
}

/** Whether a loadout / favourites key (`<brainId>::<modelKey>`) belongs to a
 *  retired brain. */
export function isRetiredRowKey(key: string): boolean {
  const cut = key.indexOf("::");
  return isRetiredBrain(cut < 0 ? key : key.slice(0, cut));
}
