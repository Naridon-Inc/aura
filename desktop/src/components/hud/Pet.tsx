// The HUD desk-pet — a tiny companion that perches on top of the glass pill and
// mirrors the live agent status. It's a pure sprite-sheet animation: one WebP,
// `background-position` stepped through the frames of the row that matches the
// current mood. See `petSprites.ts` for the format + attribution.
//
// A rAF loop (not CSS keyframes) drives it, because the frame count, row and
// duration all change with the mood — the loop just reads the current status
// each tick and only writes to the DOM when the visible frame actually changes,
// so an idle pet costs a couple of style writes a second.

import { useEffect, useRef } from "react";

import type { HudStatusKind } from "../../lib/hud";
import {
  PET_SHEET,
  PET_STATES,
  STATUS_TO_PET,
  type PetStateName,
  type SpriteState,
} from "./petSprites";
import petSheet from "./assets/pet-default.webp";

/** On-screen height, px. Kept under the HUD's 48px top gutter so the pet lives
 *  in the shadow room above the pill without clipping at the window edge. */
const DISPLAY_H = 52;
const SCALE = DISPLAY_H / PET_SHEET.frameHeight;
const FRAME_W = PET_SHEET.frameWidth * SCALE;
const FRAME_H = PET_SHEET.frameHeight * SCALE;

/** A transient interaction reaction (hover → wave, click → jump). It overrides
 *  the status mood while it plays, then the pet drops back to its live status. */
type Reaction = { name: PetStateName; startedAt: number } | null;

/** Re-greet at most this often, so sweeping the cursor across the pet doesn't
 *  spam the wave. Matches Codex's hover cooldown. */
const HOVER_COOLDOWN_MS = 3200;

export function Pet({ status }: { status: HudStatusKind }) {
  const spriteRef = useRef<HTMLDivElement | null>(null);
  // The rAF loop reads these from refs so neither a status change nor an
  // interaction re-subscribes the animation frame (the effect runs once).
  const statusRef = useRef(status);
  statusRef.current = status;
  const reactionRef = useRef<Reaction>(null);
  const hoverCooldownRef = useRef(0);

  useEffect(() => {
    const el = spriteRef.current;
    if (!el) return;

    let raf = 0;
    // The mood currently on screen + when it started. Distinct from the
    // external target so a finite reaction (celebrate/slump) can finish, then
    // settle to idle, even while the external status still reads "done"/"error".
    let playing: PetStateName = "idle";
    let playStart = 0;
    let lastTarget: PetStateName | null = null;
    let lastFrame = -1;
    let lastRow = -1;

    const tick = (ts: number) => {
      raf = requestAnimationFrame(tick);

      let def: SpriteState = PET_STATES.idle;
      let elapsed = 0;
      let handled = false;

      const reaction = reactionRef.current;
      if (reaction) {
        const rdef: SpriteState = PET_STATES[reaction.name];
        const full = rdef.durationMs * (rdef.iterations ?? 1);
        if (ts - reaction.startedAt < full) {
          // A hover/click reaction is playing — it wins over the status mood.
          def = rdef;
          elapsed = ts - reaction.startedAt;
          // Force the base mood to restart cleanly once the reaction ends.
          lastTarget = null;
          handled = true;
        } else {
          reactionRef.current = null;
        }
      }

      if (!handled) {
        // Base: the live status mood.
        const target = STATUS_TO_PET[statusRef.current] ?? "idle";
        // A genuine mood change (re)starts that animation from frame 0. Re-reading
        // the SAME target does not retrigger — so a lingering "done" celebrates
        // twice, then relaxes, instead of hopping forever.
        if (target !== lastTarget) {
          lastTarget = target;
          playing = target;
          playStart = ts;
        }
        def = PET_STATES[playing];
        elapsed = ts - playStart;
        if (
          def.iterations &&
          playing !== "idle" &&
          elapsed >= def.durationMs * def.iterations
        ) {
          // Finite reaction done → hold idle until the status changes again.
          playing = "idle";
          playStart = ts;
          def = PET_STATES.idle;
          elapsed = 0;
        }
      }

      const frame = Math.floor(elapsed / (def.durationMs / def.frames)) % def.frames;
      if (frame !== lastFrame || def.row !== lastRow) {
        el.style.backgroundPositionX = `${-(frame * FRAME_W)}px`;
        el.style.backgroundPositionY = `${-(def.row * FRAME_H)}px`;
        lastFrame = frame;
        lastRow = def.row;
      }
    };

    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, []);

  const greet = () => {
    const now = performance.now();
    if (now < hoverCooldownRef.current) return;
    hoverCooldownRef.current = now + HOVER_COOLDOWN_MS;
    reactionRef.current = { name: "waving", startedAt: now };
  };
  const celebrate = () => {
    reactionRef.current = { name: "jumping", startedAt: performance.now() };
  };

  return (
    <div className="hud-pet" aria-hidden>
      <div
        ref={spriteRef}
        className="hud-pet-sprite"
        style={{
          width: `${FRAME_W}px`,
          height: `${FRAME_H}px`,
          backgroundImage: `url(${petSheet})`,
          backgroundSize: `${PET_SHEET.columns * FRAME_W}px ${PET_SHEET.rows * FRAME_H}px`,
        }}
        onPointerEnter={greet}
        onClick={celebrate}
      />
    </div>
  );
}
