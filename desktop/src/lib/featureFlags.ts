/** Build-time feature flags for in-progress or quarantined UI surfaces.
 *
 *  Flip a flag and every gated entry point + render path turns on/off in
 *  lockstep — no half-wired states. */

/** Code Map (the semantic graph pane, `SemanticGraphPane`).
 *
 *  Enabled: the pane is incremental now. The full graph never crosses IPC —
 *  the backend serves bounded, ranked views (`aura_kg_view`, capped at 350
 *  nodes / 900 edges per response) plus on-demand `aura_kg_explain` /
 *  `aura_kg_path`, all cached in-process behind an `aura_kg_ensure`
 *  handshake that returns stats only. Stress-tested against a synthetic
 *  20k-node / 78k-edge graph (`cmd_kg.rs::view_tests`) — selection, search,
 *  focus, path and explain all stay well inside the budget.
 *
 *  Disabled anyway: it is not a question anyone came to Trace to ask. A map of
 *  what-touches-what is a thing you go looking for on a particular day, and it
 *  sat on the strip next to the two surfaces people read constantly.
 *
 *  Hidden rather than deleted, because the machinery under it is substantial
 *  and shared: `SemanticGraphPane`, the feature map, and the Rust knowledge-
 *  graph commands with their own `view_tests` — none of which is dead weight,
 *  and all of which would have to be unpicked to remove a cell from a strip.
 *
 *  Off, this hides the Trace cell, and short-circuits every store opener + the
 *  WorkSurface render so a stale persisted "graph was open" snapshot can't
 *  re-mount it on launch. `{ kind: "graph" }` stays addressable, so a saved
 *  link still resolves.
 *
 *  Flip to `true` to put Code Map back on the strip. */
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

/** Project health (`DoctorDialog` — the plain-language `aura doctor` reading).
 *
 *  Disabled: it is a diagnostic, and a diagnostic belongs where you go when
 *  something is wrong, not on the strip of a surface you read to see what
 *  happened. It was one of three utilities crowding out the two views that
 *  earn the space.
 *
 *  Hidden rather than deleted. The reading itself is real work — `DoctorDialog`
 *  over `lib/doctorHealth`, which turns the engine's report into sentences a
 *  non-engineer can act on, with its own test suite — and the same report is
 *  still one keystroke away as `/doctor`, which runs the CLI and prints it.
 *
 *  Off, this hides the Trace cell; `{ kind: "tool", tool: "doctor" }` stays
 *  addressable, so a saved link still resolves.
 *
 *  Flip to `true` to put Project health back on the strip. */
export const PROJECT_HEALTH_ENABLED = false;

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

/** The Tasks strip's Graph lens — the crew dependency map (`CrewSurface`).
 *
 *  Disabled: Tasks is List and Board. Those are the two drawings people
 *  actually read, and the third cell asked every visitor to decide between a
 *  backlog and a dependency map before they had looked at either.
 *
 *  Hidden rather than deleted, because the map is not a leaf. `CrewSurface`
 *  only answers to this lens, but the tree under and around it does not:
 *  `crewControl` drives the rail's pause/resume, `crewShared` + `crewProof`
 *  draw a task's crew activity, `crewActivity` + `CrewLiveTranscript` feed the
 *  manager chat's composer, and the machine wizards and runner panel are
 *  reached from Workspaces and Settings. Ripping the map out would mean
 *  picking those apart for no gain the user asked for.
 *
 *  Gating this flag drops the Graph cell from `WORK_LENSES` — which shrinks
 *  `WORK_LENS_VALUES`, so `readWorkLens` migrates anyone whose last lens was
 *  the map back to the list — makes `isCrewLens` answer no, which is the one
 *  predicate both the host and the two surfaces branch on, and hides the
 *  second door in the Tasks rail's Goals group. The lens value stays in the
 *  `WorkLens` union so the surface still typechecks.
 *
 *  Flip to `true` to put the map back on the strip. */
export const CREW_GRAPH_LENS_ENABLED = false;
