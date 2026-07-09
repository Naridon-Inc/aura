# aura-zones

[![Crates.io](https://img.shields.io/crates/v/aura-zones.svg)](https://crates.io/crates/aura-zones)
[![docs.rs](https://docs.rs/aura-zones/badge.svg)](https://docs.rs/aura-zones)
[![License: Apache-2.0](https://img.shields.io/badge/license-Apache--2.0-blue.svg)](LICENSE)

**Mutex for AI agents.** File and function ownership zones for multi-agent codebases.

When multiple Claude/GPT/Copilot agents edit the same repo concurrently, they step on each other's work. `aura-zones` gives each agent a way to claim what it's editing, detect collisions, and send messages — all via the filesystem, no daemon needed.

```toml
[dependencies]
aura-zones = "0.1"
```

## What it does

| Feature | Description |
|---------|-------------|
| **Function claims** | Agent claims `login()` in `auth.rs` — other agents see the collision before they start |
| **Zone rules** | Mark `src/auth/*` as Block — other agents can't edit without coordination |
| **Inter-agent messaging** | Broadcast "I'm refactoring auth" or DM a specific session |
| **Stale cleanup** | Dead PIDs and old messages are automatically reaped |
| **No daemon** | One JSON file per claim/zone/message — just the filesystem |

## Example

```rust
use std::path::PathBuf;
use aura_zones::{SentinelManager, ZoneMode};

let mgr = SentinelManager::new(PathBuf::from(".agents/sentinel"));

// Claim functions before editing
let collisions = mgr.claim_functions(
    "session-1", "claude-opus", std::process::id(),
    "src/auth.rs", &["login".into(), "verify_token".into()],
);
if !collisions.is_empty() {
    eprintln!("collision: {:?}", collisions[0]);
}

// Block other agents from editing auth files
mgr.create_zone("session-1", vec!["src/auth/*".into()], ZoneMode::Block);

// Send a heads-up
mgr.send_message("session-1", "claude-opus", None, "refactoring auth, stay away");

// Other agent checks before editing
if let Some(zone) = mgr.check_zone("session-2", "src/auth/login.rs") {
    match zone.mode {
        ZoneMode::Block => eprintln!("BLOCKED by {}", zone.session_id),
        ZoneMode::Warn  => eprintln!("WARNING: zone owner is {}", zone.session_id),
    }
}
```

## Comparison

| | File locks (flock) | Git branch isolation | aura-zones |
|---|---|---|---|
| Granularity | Whole file | Whole branch | Per function |
| Coordination | None | Merge later | Real-time collision detection |
| Messaging | None | PR comments | In-band, instant |
| Daemon needed | No | No | No |
| Works with AI agents | Not really | Merge conflicts everywhere | Designed for it |

## Status

- ✅ Function-level claims with collision detection
- ✅ Zone rules (Warn / Block modes)
- ✅ Inter-agent messaging (broadcast + DM)
- ✅ PID-based stale cleanup
- ✅ Atomic writes (tmp + rename)
- ⏳ Network-aware zones (for distributed agents)

## Origin

Extracted from [Aura](https://auravcs.com) — the semantic version control engine for AI-generated code. Aura uses `aura-zones` to coordinate multiple Claude Code agents editing the same repository simultaneously.

## License

Apache-2.0
