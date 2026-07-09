// Resolved at module load time so a missing/empty env var falls back to
// the production default once. `import.meta.env` is the standard Vite
// surface; the `typeof import.meta !== "undefined"` guard keeps this
// safe under environments that don't define it (older test runners).
//
// To override locally, set `VITE_LIVEKIT_URL=wss://livekit.dev.local`
// in `aura-shell/.env.local` before running `bun run dev`.
export const LIVEKIT_URL: string =
  (typeof import.meta !== "undefined" &&
    (import.meta as unknown as { env?: { VITE_LIVEKIT_URL?: string } }).env
      ?.VITE_LIVEKIT_URL) ||
  "wss://livekit.auravcs.com";
