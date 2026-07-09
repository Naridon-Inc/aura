# @aura/tic-tac-toe

Multiplayer tic-tac-toe in a plugin panel — the reference example for the
`realtime:channel` capability. Open the panel on two teammates' machines
(same Aura team room) and play across the rail; open it solo and you play
both seats through the host's loopback echo.

## What it demonstrates

| Piece | Shows |
|---|---|
| `aura.plugin.json` | `realtime:channel:tictactoe` — capability scoped to ONE topic; the plugin cannot send or receive on any other topic |
| `panel.html` | `realtime.channel` sends (envelope `target` must equal the topic), event intake, and a convergent game protocol on an ephemeral transport |
| `worker.js` | Background presence — subscribes to the same events and toasts when a peer joins, even with the panel closed |

## The transport, honestly

`realtime:channel` is **ephemeral, at-least-once, ~2 second** messaging
piggybacked on the team rail:

- Messages are NOT history: a panel that mounts late sees nothing until
  peers re-send (that's what `join`/`sync` below are for).
- Your own sends echo back instantly via host loopback with `self: true`;
  peers receive them on the next ~2s poll tick with `self: false`.
- Payloads are capped at 8 KiB serialized; topics are `[a-z0-9-]`, ≤64
  chars; sends are rate-limited to 30 per 10s per plugin.
- Solo workspaces (no team room) skip the rail entirely — loopback only,
  which is why single-player works offline.

Turn-based games fit this envelope perfectly. Don't build a 60fps shooter
on it.

## The convergence protocol

State is `epoch` (bumped by each "New game") plus an ordered `moves` array
`{n, cell, sid, name}`. The board is a pure projection — even `n` is X,
odd is O; whoever made move 0 owns X, move 1 owns O. Four rules make every
replica converge:

1. **Single receive path.** Clicking a cell only *sends* the move. It is
   applied when the loopback echo arrives — the same code path as a
   peer's move. No optimistic state, nothing to reconcile.
2. **Deterministic conflict.** Two peers can both claim turn `n` within
   the same poll window. First writer wins unless the rival's `sid`
   (random 8-char session id) is lexicographically lower — then it
   replaces `moves[n]` and everything after is truncated. Same rule on
   every replica ⇒ same history everywhere.
3. **Gap repair.** A move arriving with `n > moves.length` is buffered
   and a `join` is broadcast. Any peer holding state answers `sync`
   (full moves array) after 0–400 ms jitter — squelched only if another
   holder already answered with state at least as new as its own (a
   stale sync must not silence a needed reply). A replica adopts a sync
   only if it is strictly newer (higher epoch, or same epoch with more
   moves).
4. **Reset = new epoch.** `{t:"reset", epoch+1}` clears the board;
   anything stamped with an older epoch is dropped on arrival.

Wire messages (all on topic `tictactoe`):

```jsonc
{ "t": "join",  "sid": "k3f9x2ma" }                       // mounted / lost sync
{ "t": "sync",  "epoch": 2, "moves": [...], "sid": "…" }  // state answer
{ "t": "move",  "epoch": 2, "n": 4, "cell": 6, "sid": "…" }
{ "t": "reset", "epoch": 3 }
```

## Try it

```sh
aura plugin link aura-shell/examples/plugins/@aura/tic-tac-toe
```

Enable it in **Settings → Plugins**, click the ⭕ rail tile, and play.
With a teammate in the same team room, both of you open the panel — the
later arrival's `join` pulls the in-flight game via `sync`. To share the
bundle with the team without a registry, publish it on the Plugin
Exchange from the Plugins browser.

Like `@aura/hello-world`, this bundle is written against the raw bridge
protocol with no build step, and being link-installed it runs unsigned
under your local trust.
