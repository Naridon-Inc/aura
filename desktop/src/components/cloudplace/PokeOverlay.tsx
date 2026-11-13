// The moment a poke lands while Aura is in front: amber dots run in from the
// edges of the window and a card in the middle says who, then it all fades.
// It never takes a click — the toast underneath carries "Poke back".

import { useEffect, useMemo, type CSSProperties } from "react";
import { createPortal } from "react-dom";

import "./cloud-poke.css";
import { OVERLAY_MS, pokeShown, useShownPoke } from "./cloudPokes";

/** "!" on a 3×7 grid of dots. */
const MARK = ["010", "010", "010", "010", "010", "000", "010"].join("");

type Dot = { style: CSSProperties };

/** Dots spaced along all four edges, each heading a little way inward. */
export function edgeDots(perSide: number): Dot[] {
  const dots: Dot[] = [];
  for (let side = 0; side < 4; side++) {
    for (let i = 0; i < perSide; i++) {
      const along = ((i + 0.5) / perSide) * 100;
      const reach = 28 + ((i * 37 + side * 11) % 5) * 14;
      const delay = ((i * 7 + side * 3) % 10) * 60;
      const at: CSSProperties =
        side === 0
          ? { top: -6, left: `${along}%` }
          : side === 1
            ? { right: -6, top: `${along}%` }
            : side === 2
              ? { bottom: -6, left: `${along}%` }
              : { left: -6, top: `${along}%` };
      const [dx, dy] = side === 0 ? [0, reach] : side === 1 ? [-reach, 0] : side === 2 ? [0, -reach] : [reach, 0];
      dots.push({
        style: {
          ...at,
          animationDelay: `${delay}ms`,
          ["--poke-dx" as string]: `${dx}px`,
          ["--poke-dy" as string]: `${dy}px`,
        },
      });
    }
  }
  return dots;
}

export function PokeOverlay() {
  const poke = useShownPoke();
  const dots = useMemo(() => edgeDots(9), []);
  useEffect(() => {
    if (!poke) return;
    const t = setTimeout(() => pokeShown(poke.id), OVERLAY_MS);
    return () => clearTimeout(t);
  }, [poke]);
  if (!poke) return null;
  return createPortal(
    <div className="ui-poke-overlay" aria-live="polite" key={poke.id}>
      {dots.map((d, i) => (
        <span key={i} className="ui-poke-dot" style={d.style} />
      ))}
      <div className="ui-poke-card" role="status">
        <div className="ui-poke-mark" aria-hidden>
          {[...MARK].map((on, i) => (
            <span key={i} data-on={on === "1" || undefined} />
          ))}
        </div>
        <strong>{poke.name} poked you</strong>
      </div>
    </div>,
    document.body,
  );
}
