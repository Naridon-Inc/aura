// Sprite-sheet data for the HUD desk-pet.
//
// The pet is an OpenPets sprite (github.com/alvinunreal/openpets, MIT — see
// `assets/OPENPETS-LICENSE.txt`). We vendor ONLY the sprite format + one MIT
// pet; none of OpenPets' Electron shell, IPC, plugin runtime or MCP server. A
// "pet" is just a WebP grid where each ROW is one animation state and each
// STATE plays the first N frames of its row on a loop.
//
// The magic is that our HUD already publishes a live agent status
// (`HudStatusKind`) that lines up with the moods OpenPets' artist drew — so the
// pet mirrors what the agent is actually doing (thinking → reviews, running →
// works, done → celebrates, error → slumps) with no new plumbing.

import type { HudStatusKind } from "../../lib/hud";

/** Geometry of the vendored `pet-default.webp` sheet (8 cols × 9 rows). */
export const PET_SHEET = {
  columns: 8,
  rows: 9,
  frameWidth: 192,
  frameHeight: 208,
} as const;

export interface SpriteState {
  /** 0-based row on the sheet — the strip the artist drew for this mood. */
  readonly row: number;
  /** How many frames of that row to play. */
  readonly frames: number;
  /** One full cycle, ms. */
  readonly durationMs: number;
  /** Finite reactions play this many times, then the pet settles to idle.
   *  Omitted = loop forever while the mood holds. */
  readonly iterations?: number;
}

/** Only the states the HUD drives. Row/frames/durationMs copied verbatim from
 *  OpenPets' `defaultPetSprite`, so they line up with the sheet frame-for-frame. */
export const PET_STATES = {
  idle: { row: 0, frames: 6, durationMs: 5500 },
  running: { row: 7, frames: 6, durationMs: 820 },
  review: { row: 8, frames: 6, durationMs: 1030 },
  waiting: { row: 6, frames: 6, durationMs: 1010 },
  jumping: { row: 4, frames: 5, durationMs: 840, iterations: 2 },
  failed: { row: 5, frames: 8, durationMs: 1220, iterations: 2 },
  // Interaction-only reactions (not mapped from any status): hover greets,
  // click celebrates. Both finite → they play, then the pet returns to whatever
  // its live status was.
  waving: { row: 3, frames: 4, durationMs: 700, iterations: 2 },
} as const satisfies Record<string, SpriteState>;

export type PetStateName = keyof typeof PET_STATES;

/** Aura's live HUD status → the sprite mood its artist drew for it. Mirrors
 *  OpenPets' own reaction→animation defaults (thinking→review, working→running,
 *  success→jumping, error→failed, blocked→waiting). */
export const STATUS_TO_PET: Record<HudStatusKind, PetStateName> = {
  idle: "idle",
  thinking: "review",
  running: "running",
  awaiting_input: "waiting",
  done: "jumping",
  error: "failed",
};
