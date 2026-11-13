/** The picker's Edit row: the loadout and the standing model defaults live in
 *  Settings → Models (or Local & Custom Models for an endpoint tab). With no
 *  agent set up at all, Settings → Agents, where one is signed in or keyed. */
export function openModelSettings(
  pane: "models" | "local-models" | "agents" = "models",
): void {
  window.dispatchEvent(new CustomEvent("aura:open-settings", { detail: { pane } }));
}
