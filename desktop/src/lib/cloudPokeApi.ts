// Pokes, through the desktop's proxy, the way `cloudTeamApi` reaches presence
// and mentions.

import { invoke } from "@tauri-apps/api/core";

export type PokeSentDto = { id: string; delivered: boolean };

export type PokeDto = {
  id: string;
  from_user_id: string;
  from_name: string;
  created_at: string;
};

export type PokeSettingsDto = { enabled: boolean };

export const cloudPokeApi = {
  poke: (userId: string) => invoke<PokeSentDto>("cloud_member_poke", { userId }),
  pokes: () => invoke<PokeDto[]>("cloud_pokes"),
  pokeSettings: () => invoke<PokeSettingsDto>("cloud_poke_settings"),
  setPokeSettings: (enabled: boolean) => invoke<PokeSettingsDto>("cloud_poke_settings_set", { enabled }),
};

/** The sentence a refused call carried (`{"error": "…"}`), when it carried one. */
export function serverSentence(e: unknown): string | null {
  const raw = e instanceof Error ? e.message : typeof e === "string" ? e : "";
  if (!/^HTTP 4\d\d\b/.test(raw)) return null;
  const start = raw.indexOf("{");
  const end = raw.lastIndexOf("}");
  if (start < 0 || end <= start) return null;
  try {
    const body: unknown = JSON.parse(raw.slice(start, end + 1));
    const said = body && typeof body === "object" ? (body as { error?: unknown }).error : undefined;
    return typeof said === "string" && said.trim() && !/^[a-z_]+$/.test(said) ? said.trim() : null;
  } catch {
    return null;
  }
}
