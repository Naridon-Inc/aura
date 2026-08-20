/** Build-time feature flags for in-progress or quarantined UI surfaces.
 *
 *  Flip a flag and every gated entry point + render path turns on/off in
 *  lockstep — no half-wired states. */

/** Code Map (the semantic graph pane, `SemanticGraphPane`).
 *
 *  Disabled: opening it freezes the app on real-world repos — the pane builds
 *  the full project graph eagerly with no virtualization. Gating this flag
 *  hides the sidebar row, the menu item, and the `/graph` command, and short
 *  -circuits every store opener + the WorkSurface render so a stale persisted
 *  "graph was open" snapshot can't re-mount it on launch.
 *
 *  Flip to `true` to re-enable once the pane is made incremental. */
export const CODE_MAP_ENABLED = false;

/** Trace v2 — the calm, entire.io-style Trace surface.
 *
 *  Reshapes the Trace section's left rail around a Sessions spine (a
 *  per-run list backed by the real intent log) and opens a calm session
 *  detail (Summary + Changes from the run's own changeset) instead of the
 *  old wall-of-text panes. Additive: the classic Trace rows (Intent↔AST,
 *  Review, Prove, Rewind, Attestations…) stay reachable; this only swaps
 *  in the Sessions entry + detail pane and the reshaped grouping.
 *
 *  Gates: the Sessions rail row, the `sessions`/`session_detail` panes in
 *  WorkSurface, and the store openers — so a stale "sessions was open"
 *  snapshot can't re-mount the pane when the flag is off.
 *
 *  Flip to `true` to turn the new surface on. */
export const TRACE_V2 = true;

/** Team activity feed (the cross-developer intent listing) + the Overview
 *  "Right now" presence ticker.
 *
 *  Enabled, but self-explaining: the feed populates only when the team's
 *  `.aura/` activity ledger actually reaches teammates, which is gated on Aura
 *  sign-in (logged-in ⇒ the ledger syncs over the live plane regardless of repo
 *  gitignore; logged-out ⇒ stays on this machine, the privacy default). Rather
 *  than hide the surface when it's empty — which read as broken — TeamActivity-
 *  Feed now DETECTS why it's thin (signed out / live-sync off / waiting for
 *  teammates) and shows a plain-language empty state + notice with the one real
 *  action that fixes it (Sign in, or Turn on live sync). The Overview ticker
 *  stays silent when solo+idle, so it never reads broken either.
 *
 *  Gates: the "Team activity" rail row + its Trace pane, and the Overview live
 *  ticker. (Flip to `false` only to fully remove the surface again.) */
export const TEAM_ACTIVITY_ENABLED = true;

/** Memory surface (`MemoryDialog` — Aura's project-memory store).
 *
 *  Disabled: adding a fact is wired to `auraMemoryWriteEntry` but the surface
 *  doesn't reflect the write back, so it reads as a no-op. Hidden until it
 *  either works end to end or is folded into the agent-customizations surface
 *  where per-agent memory already lives.
 *
 *  Gates: the "Memory" rail row (v2 + legacy) and the TopBar overflow item. */
export const MEMORY_SURFACE_ENABLED = false;

/** Aura Manager — the native in-app orchestrator chat ("Aura" agent).
 *
 *  Disabled: we're focusing on the external CLI coding agents (Claude Code,
 *  Gemini, Codex, …) for now, so the native chat surface is hidden rather
 *  than half-shown. Gating this flag drops the synthetic `MANAGER_AGENT`
 *  from agent discovery (so it leaves the PresetsBar pill and every picker),
 *  hides the right-rail "Aura" tab + panel, short-circuits `openManager`,
 *  and drops any persisted manager workpane tabs on restore — so a stale
 *  layout snapshot can't re-mount the chat when the flag is off.
 *
 *  Flip to `true` to bring the native Aura Manager back. */
export const AURA_MANAGER_ENABLED = true;

/** Onboarding v2 — the calm Superset-style first-run flow.
 *
 *  Replaces the heavy 9-step `OnboardingDialog` with a four-screen flow:
 *  Sign in (GitHub / GitLab / Google + Skip) -> optional Connect Agent ->
 *  Open Project (drop-zone + recents) -> New Project (Empty / Clone /
 *  Template). Full-bleed, references-grade, built on Aura tokens. Both
 *  share the `aura.onboarding.complete` gate + `aura:open-onboarding`
 *  re-open event, so exactly one first-run surface mounts.
 *
 *  Flip to `false` to fall back to the legacy OnboardingDialog. */
export const ONBOARDING_V2 = true;

/** Live Sync — the git-alternative collaboration layer, folded into the
 *  right-rail Source Control (Changes) panel.
 *
 *  Adds a "Go Live" band under the SOURCE CONTROL header plus, while a
 *  session is running, Incoming (teammates' inbound changes) and Conflicts
 *  (the M1 ConflictedNode store) sections above the local git tree. Go Live
 *  starts the whole-file CRDT engine (`aura live start --collab`) so the
 *  working tree syncs conflict-free without a git push; git stays available
 *  as a snapshot. No new tab or sidebar — it lives in the panel that is
 *  already "what's changing".
 *
 *  Gating this flag hides the Go Live band + the live sections and skips
 *  the status poll entirely, so the Changes panel is byte-for-byte the
 *  plain git surface when off.
 *
 *  Flip to `false` to ship the Changes panel without the live layer. */
export const AURA_SYNC_ENABLED = true;

/** Commons — the worldwide "community" platform: the Activity lounge
 *  (presence + ship log + reactions), the Apps launcher (first-party builtins
 *  like Reddit / Hacker News + the worldwide app catalog), and the Plugin
 *  Exchange. It surfaces as a right-rail tab, a full-width center tab (via the
 *  rail's expand button), and the Lounge / Plugins tabs inside the Team
 *  context panel.
 *
 *  Disabled: the community surface over-complicates the product for now, so
 *  it's hidden as a whole rather than half-shown. Gating this flag drops the
 *  Commons rail tab + its expand opener, the Lounge + Plugins tabs in the Team
 *  context panel, and short-circuits `openCommons` / `openApp` plus the
 *  `commons` / `app` workpane restore — so a stale layout snapshot can't
 *  re-mount any Commons surface when the flag is off. All the code (apps,
 *  exchange, lounge) stays in place, ready to switch back on.
 *
 *  Flip to `true` to bring the Commons / community platform back. */
export const COMMONS_ENABLED = false;

/** Trace IA v3 — collapse the "timeline triplet" into one Sessions spine.
 *
 *  Trace's redundancy is three rail rows that are three lenses on one file
 *  (`.aura/intent_log.jsonl`): Overview + Sessions are literally the same pane
 *  kind toggled by a sub-view param, and Intent↔AST is a third per-commit lens
 *  whose detail (the asked→said→did→aligned verdict + per-symbol rewind) is
 *  exactly what Session Detail lacks. The genuine *tools* (Prove, Review,
 *  Impacts, Rewind, Attestations, Doctor, Memory) are distinct and stay.
 *
 *  This flag turns on the consolidation, lockstep:
 *   - Session Detail gains an "Alignment" tab (Summary · Alignment · Changes ·
 *     Transcript) that mounts the shared IntentStory keyed off the session's
 *     own commit sha — so the verdict lives on the thing it judges.
 *   - (Subsequent waves) the Overview/Sessions double-row collapses to one
 *     rail row with an Overview masthead, and the Intent↔AST + Provenance
 *     Replay rail rows retire (their panes stay deep-linkable until verified).
 *
 *  Additive + reversible: with the flag off, Session Detail is the byte-for
 *  -byte Summary · Transcript · Changes set and the rail is unchanged.
 *
 *  Flip to `false` to ship Trace without the IA-v3 consolidation. */
export const TRACE_IA_V3 = true;

/** Goals v2 — "your asks, and whether they're really done."
 *
 *  Reframes Goals from a query-you-type into the list of the things you
 *  actually asked the AI to build. Goals are auto-born from each coding
 *  session's opening prompt (`ClaudeSession.first_prompt`), so the page fills
 *  itself instead of starting at an empty textbox. Each goal carries its
 *  original wording, links to the session(s)/task/changes that worked it, and
 *  a plain-language status (Done / Almost / Not yet) translated from
 *  `aura prove --json` — the AST detail moves behind a "show how you know"
 *  disclosure. Manual goals stay possible but secondary.
 *
 *  Gating this flag swaps the ProvePane body for the list-first GoalsPane and
 *  turns on the session-detail "What you asked here" read-first card; with the
 *  flag off, Goals is byte-for-byte the old input-first ProvePane and the
 *  session "Set a goal for this run" composer.
 *
 *  Flip to `false` to fall back to the legacy input-first Goals surface. */
export const GOALS_V2 = true;

/** Project Timeline — the full-screen "relive how this project came to be"
 *  wizard.
 *
 *  Folds the real intent log (the same feed Sessions reads) into a time-ordered
 *  narrative and plays it back: a churn-sparkline scrubber along the bottom you
 *  drag like a film reel, a left rail of chapters (sessions/runs), and a center
 *  detail of the moment the playhead is parked on — its reason ("why"), the
 *  code it touched, and how far the build had come by that point. Summoned from
 *  the Trace rail's "Project timeline" row (and anywhere via
 *  `aura:open-timeline`); it owns the whole window, no inline/squeezed view.
 *
 *  Gating this flag hides the Trace rail row + the `aura:open-timeline` mount,
 *  so the surface is fully dormant when off.
 *
 *  Flip to `false` to hide the Project Timeline. */
export const TIMELINE_V2 = true;

/** Team Radar — the awareness-plane panel in the right rail.
 *
 *  A pull surface over `.aura/awareness` (the signed who-is-editing-/intends-
 *  /just-committed-which-symbol feed the git + agent hooks emit automatically):
 *  an ambient activity feed plus the *reasoned* collisions scored against your
 *  own in-flight work (the CLI does all the noise-damping — self-skip, recency
 *  window, supersession, dedup — so this only shows what a teammate would
 *  actually lean over and tell you). Reads via the `aura_radar` Tauri command
 *  driving the `aura radar` CLI; no MCP required.
 *
 *  Gating this flag hides the panel + its right-rail entry and skips the poll
 *  entirely, so the rail is byte-for-byte unchanged when off.
 *
 *  Surfaced as a resizable bottom dock in the Source Control (Changes) panel —
 *  mirrors the Checks→PR split via `useVerticalSplit`. Quiet by construction:
 *  the dock only takes its share of the split when there's live team activity,
 *  a clash, or a zone. With none of those it shrinks to one fixed row that says
 *  so in plain words — an idle radar shouldn't read as a broken one — and the
 *  file list keeps the rest of the panel. */
export const AURA_RADAR_ENABLED = true;
