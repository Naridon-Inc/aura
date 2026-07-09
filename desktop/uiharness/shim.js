// Tauri IPC shim — runs in the PAGE context (injected via addInitScript) BEFORE
// the app bundle loads, so `@tauri-apps/api/core`'s `invoke` resolves through us
// instead of throwing "window.__TAURI_INTERNALS__ is undefined".
//
// The real aura-shell talks to Rust over `window.__TAURI_INTERNALS__.invoke`.
// In a plain browser that object doesn't exist. We provide a faithful-enough
// stand-in: per-command handlers for the surfaces under test (search, Crew),
// fed from `window.__AURA_DATA__` fixtures, plus a permissive default so the
// rest of the app still boots. Unmocked commands are recorded on
// `window.__AURA_INVOKE_LOG__` so we can see what to add next.
//
// This is UI/flow testing — the backend is mocked. Real backend correctness
// (e.g. the git-grep symbol search) is verified separately at the shell.
(function () {
  const D = () => window.__AURA_DATA__ || {};
  const lc = (s) => String(s == null ? "" : s).toLowerCase();

  // ── callback registry (transformCallback / channels / events) ────────────
  let nextId = 1;
  const callbacks = new Map();
  function transformCallback(cb, once) {
    const id = nextId++;
    callbacks.set(id, { cb, once: !!once });
    return id;
  }
  function runCallback(id, payload) {
    const e = callbacks.get(id);
    if (!e) return;
    e.cb(payload);
    if (e.once) callbacks.delete(id);
  }

  // ── per-command handlers (the surfaces we drive) ─────────────────────────
  const handlers = {
    current_dir: () => D().repoRoot || "/",
    home_dir: () => D().home || "/Users/you",
    aura_status: () => D().auraStatus || { ok: true },
    git_status: () => D().gitStatus || {},
    git_branch: () => D().branch || "feat/commons-platform",

    fs_find_files: () => D().files || [],

    fs_grep_symbol: (p) => {
      const q = lc(p && p.name);
      if (!q) return [];
      return (D().symbols || []).filter((s) => lc(s.name).includes(q));
    },

    fs_grep_content: (p) => {
      const q = lc(p && p.query);
      const all = D().contentHits || [];
      const hits = q
        ? all.filter((h) => lc(h.preview).includes(q) || lc(h.path).includes(q))
        : [];
      return { hits: hits.slice(0, 200), truncated: hits.length > 200 };
    },

    aura_intent_recent: () => D().intents || [],

    loop_ready_view: () => D().readyView || emptyReadyView(),
    loop_review: () => D().loopReview || [],
    loop_sync_board: () => ({ created: 0, updated: 0, synced: 0, edges: 0 }),
    loop_run_native: () => ({ wave_id: "wave-mock", dispatched: [], ready_remaining: 0 }),
    loop_set_status: (p) => ({ id: (p && p.nodeId) || "n", status: (p && p.status) || "submitted" }),

    read_atlas: () => D().atlas || null,
    tasks_list: () => D().tasks || [],
    aura_cli: (p) => ({ status: 0, stdout: cliStub(p), stderr: "" }),

    // ── boot-path commands (shapes the app destructures) ───────────────────
    plugin_contributes: () => [], // rows: PluginContributesRow[] — .flatMap needs an array
    settings_prefs_load: () => D().settings || {},
    settings_prefs_save: () => null,
    vsix_list: () => [],
    agent_discover: () => D().agents || [],
    app_bundle_location: () => ({ translocated: false, in_applications: true, writable: true }),
    remote_set_snapshot: () => null,
    aura_cli_version_check: () => ({ current: "0.18.0", latest: "0.18.0", update_available: false }),
    git_last_commit_age: () => null,
    projects_register: () => null,
    team_load: () => ({
      team_id: "local",
      repo_root: D().repoRoot || "/",
      created_at: 1781400000,
      members: [
        { email: "mo@example.com", handle: "owner", name: "Owner", claimed: true, admin: true },
      ],
      channels: ["#aura"],
      channel_meta: [],
    }),
    team_identity: () => ({
      email: "mo@example.com",
      handle: "owner",
      name: "Owner",
      in_team: true,
      claimed: true,
      admin: true,
    }),
    cloud_auth_status: () => ({ signed_in: false }),
    aura_usage_summary: () => ({ today: 0, total: 0 }),
    aura_strict_mode: () => ({ enabled: false, locked: false }),
    aura_capture_status: () => ({ enabled: false }),
    // Returns the FULL manifest and supersedes team_load in useTeamChat — must
    // be a TeamManifest, not [], or setManifest([]) crashes TeamHeader.
    team_sync_collaborators: () => handlers.team_load(),
  };

  function emptyReadyView() {
    return {
      ready: [], blocked: [], working: [], done: [], other: [],
      counts: { ready: 0, blocked: 0, working: 0, done: 0, other: 0 },
    };
  }
  function cliStub(p) {
    const args = (p && p.args) || [];
    if (args[0] === "goals" && args[1] === "list") return JSON.stringify(D().goals || []);
    return "";
  }

  // Unknown commands default to an empty ARRAY: most boot-time consumers do
  // .map/.filter/.flatMap on the result, and `[]` also yields `undefined` for
  // any field access (safe) and stringifies to "". Object-shaped commands that
  // actually crash get an explicit handler above.
  function defaultFor() {
    return [];
  }

  // Resolve on a MACROTASK, never the same microtask tick. Real Tauri IPC has
  // sub-ms latency, so app code that polls in an `await` loop
  // (`while (running) { await invoke(...) }`) yields to the event loop each
  // iteration. An instant-resolving mock turns that into a tight synchronous
  // MICROTASK spin that pins the renderer main thread — no paint, no error,
  // screenshots/evaluate hang forever. A 1ms setTimeout defers to a fresh task
  // so paint/raf/other work interleaves, exactly like the real bridge.
  function deferred(value) {
    return new Promise((resolve) => setTimeout(() => resolve(value), 1));
  }

  function answer(cmd, payload) {
    if (cmd === "plugin:event|listen") return nextId++;
    if (cmd === "plugin:event|unlisten") return undefined;
    if (cmd === "plugin:event|emit" || cmd === "plugin:event|emit_to") return undefined;
    if (cmd.startsWith("plugin:")) {
      if (cmd.includes("is_permission_granted")) return true;
      if (cmd.includes("permission")) return "granted";
      return null;
    }
    if (Object.prototype.hasOwnProperty.call(handlers, cmd)) {
      try {
        return handlers[cmd](payload || {});
      } catch (e) {
        (window.__AURA_INVOKE_ERR__ = window.__AURA_INVOKE_ERR__ || []).push(cmd + ": " + e);
        return defaultFor(cmd);
      }
    }
    return defaultFor(cmd);
  }

  function invoke(cmd, payload) {
    (window.__AURA_INVOKE_LOG__ = window.__AURA_INVOKE_LOG__ || []).push(cmd);
    return deferred(answer(cmd, payload || {}));
  }

  window.__TAURI_INTERNALS__ = {
    invoke,
    transformCallback,
    unregisterCallback: (id) => callbacks.delete(id),
    runCallback,
    convertFileSrc: (p) => p,
    metadata: {
      currentWindow: { label: "main" },
      currentWebview: { label: "main", windowLabel: "main" },
    },
    plugins: {},
  };
  window.__TAURI__ = window.__TAURI__ || {};
  // Event plugin internals — the unlisten path reads this directly (not via
  // invoke), so a missing object throws on every component cleanup.
  window.__TAURI_EVENT_PLUGIN_INTERNALS__ = {
    unregisterListener: () => {},
  };
  window.__AURA_SHIM_READY__ = true;
})();
