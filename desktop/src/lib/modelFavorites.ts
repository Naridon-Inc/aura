// Starred models, shared by every model picker in the app.
//
// The Aura chat's picker has always persisted its stars; the agent chat's
// picker kept them in component state, so a star vanished the moment the popup
// closed. One key, one reader, one writer — a model starred in either chat is
// starred in both, and survives a reload.

export const MODEL_FAVORITES_KEY = "aura.manager.modelFavorites";

/** The stored stars (`rowKey(brainId, model)` strings). Empty when storage is
 *  unavailable or holds something that isn't a string list. */
export function loadModelFavorites(): string[] {
  try {
    const raw = localStorage.getItem(MODEL_FAVORITES_KEY);
    if (!raw) return [];
    const arr = JSON.parse(raw) as unknown;
    return Array.isArray(arr)
      ? arr.filter((x): x is string => typeof x === "string")
      : [];
  } catch {
    return [];
  }
}

/** Write the stars back. An empty list removes the key rather than storing
 *  `[]`. Storage failures are swallowed — stars are a convenience. */
export function saveModelFavorites(next: string[]): void {
  try {
    if (next.length === 0) localStorage.removeItem(MODEL_FAVORITES_KEY);
    else localStorage.setItem(MODEL_FAVORITES_KEY, JSON.stringify(next));
  } catch {
    /* storage full / disabled — favorites are a convenience, not critical */
  }
}

/** `key` starred if it wasn't, unstarred if it was. Order is kept so the
 *  Favorites group lists models in the order they were starred. */
export function toggleModelFavorite(favorites: string[], key: string): string[] {
  return favorites.includes(key)
    ? favorites.filter((k) => k !== key)
    : [...favorites, key];
}
