//! `<bin> --version`, asked once rather than on every list.
//!
//! `AgentDescriptor::from_provider` spawns `<bin> --version`, and listing the
//! registry used to do that for every provider, one after another, on every
//! call. Settings → Agents, the model picker, opening a workspace and several
//! slash commands all list the registry. Node-based CLIs take one to three
//! seconds to print a version when warm and much longer cold, so with ten
//! agents installed a single list cost about 13 s warm and close to 40 s cold
//! on a real machine. For all of that time the pane read "Looking for coding
//! agents on this machine…".
//!
//! A CLI's version changes when someone upgrades it, not between two opens of
//! a pane, so the answer is kept per binary:
//!
//!  - A miss probes every missing binary at once, so a cold list costs the
//!    slowest CLI rather than the sum of all of them.
//!  - Concurrent misses share one probe round: the second caller waits on the
//!    fill lock, then finds the answers already there.
//!  - An answer older than [`STALE_AFTER`] is still served at once, and a
//!    refresh runs in the background. No caller waits on a probe when it
//!    already holds an answer.
//!  - A probe that hangs past [`PROBE_DEADLINE`] reads as "unknown" for this
//!    call and is not cached; it may still land later.
//!  - [`forget`] drops everything. `reload()` ("Look again") calls it,
//!    because that is the user saying they just installed or upgraded a CLI.

use std::collections::HashMap;
use std::sync::mpsc;
use std::sync::{Arc, Mutex, OnceLock};
use std::time::{Duration, Instant};

use crate::AgentProvider;

/// How long a version is served without a background re-check.
pub const STALE_AFTER: Duration = Duration::from_secs(10 * 60);

/// How long one list waits on a probe before it gives up on that binary for
/// this call. A CLI that prints nothing in this time is not hanging the pane.
pub const PROBE_DEADLINE: Duration = Duration::from_secs(20);

struct Entry {
    version: Option<String>,
    at: Instant,
}

#[derive(Default)]
struct Store {
    map: HashMap<String, Entry>,
    /// Bumped by [`forget`]. A probe that started before a forget describes
    /// the old install and must not be written back over the new one.
    generation: u64,
    /// One background refresh at a time.
    refreshing: bool,
}

fn store() -> &'static Mutex<Store> {
    static STORE: OnceLock<Mutex<Store>> = OnceLock::new();
    STORE.get_or_init(|| Mutex::new(Store::default()))
}

/// Held while a round of probes runs, so concurrent misses share it.
fn fill_lock() -> &'static Mutex<()> {
    static FILL: OnceLock<Mutex<()>> = OnceLock::new();
    FILL.get_or_init(|| Mutex::new(()))
}

/// The binary is what has a version. The id is in the key too, because two
/// providers can point at one binary and still answer `version()` differently.
fn key_of(p: &dyn AgentProvider) -> String {
    format!("{}\u{0}{}", p.id(), p.bin_name())
}

/// What is known for each provider right now, plus the ones with no answer
/// and the ones whose answer is due a re-check.
struct Lookup {
    known: HashMap<String, Option<String>>,
    missing: Vec<Arc<dyn AgentProvider>>,
    stale: Vec<Arc<dyn AgentProvider>>,
}

fn lookup(providers: &[Arc<dyn AgentProvider>]) -> Lookup {
    let store = store().lock().unwrap_or_else(|e| e.into_inner());
    let mut out = Lookup {
        known: HashMap::new(),
        missing: Vec::new(),
        stale: Vec::new(),
    };
    for p in providers {
        let key = key_of(p.as_ref());
        match store.map.get(&key) {
            Some(entry) => {
                if entry.at.elapsed() >= STALE_AFTER {
                    out.stale.push(p.clone());
                }
                out.known.insert(key, entry.version.clone());
            }
            None => out.missing.push(p.clone()),
        }
    }
    out
}

/// Probe every provider at once and wait up to [`PROBE_DEADLINE`]. Answers
/// that arrive are written back unless a [`forget`] happened since `generation`.
/// Those that do not arrive in time are left out of the result, and their
/// threads write back if they finish later.
fn probe(providers: &[Arc<dyn AgentProvider>], generation: u64) -> HashMap<String, Option<String>> {
    let (tx, rx) = mpsc::channel::<(String, Option<String>)>();
    for p in providers {
        let p = p.clone();
        let tx = tx.clone();
        std::thread::spawn(move || {
            let key = key_of(p.as_ref());
            let version = p.version();
            remember(&key, version.clone(), generation);
            // The list may have stopped waiting; a closed channel is fine.
            let _ = tx.send((key, version));
        });
    }
    drop(tx);
    let deadline = Instant::now() + PROBE_DEADLINE;
    let mut out = HashMap::new();
    while out.len() < providers.len() {
        let left = deadline.saturating_duration_since(Instant::now());
        match rx.recv_timeout(left) {
            Ok((key, version)) => {
                out.insert(key, version);
            }
            Err(_) => break,
        }
    }
    out
}

fn remember(key: &str, version: Option<String>, generation: u64) {
    let mut store = store().lock().unwrap_or_else(|e| e.into_inner());
    if store.generation != generation {
        return;
    }
    store.map.insert(
        key.to_string(),
        Entry {
            version,
            at: Instant::now(),
        },
    );
}

fn current_generation() -> u64 {
    store().lock().unwrap_or_else(|e| e.into_inner()).generation
}

/// Re-check stale answers off the caller's thread. One refresh at a time; a
/// second stale read while one runs simply keeps serving what is known.
fn refresh_in_background(stale: Vec<Arc<dyn AgentProvider>>) {
    {
        let mut store = store().lock().unwrap_or_else(|e| e.into_inner());
        if store.refreshing {
            return;
        }
        store.refreshing = true;
    }
    std::thread::spawn(move || {
        let generation = current_generation();
        let _ = probe(&stale, generation);
        store().lock().unwrap_or_else(|e| e.into_inner()).refreshing = false;
    });
}

/// The version of each provider, in the order given.
///
/// Known answers come back at once. Missing ones are probed together, and
/// concurrent callers share that probe round.
pub fn versions(providers: &[Arc<dyn AgentProvider>]) -> Vec<Option<String>> {
    let mut found = lookup(providers);
    if !found.missing.is_empty() {
        let _fill = fill_lock().lock().unwrap_or_else(|e| e.into_inner());
        // Another caller may have filled these while this one waited.
        found = lookup(providers);
        if !found.missing.is_empty() {
            let probed = probe(&found.missing, current_generation());
            found.known.extend(probed);
        }
    }
    if !found.stale.is_empty() {
        refresh_in_background(found.stale);
    }
    providers
        .iter()
        .map(|p| found.known.get(&key_of(p.as_ref())).cloned().flatten())
        .collect()
}

/// Drop every remembered version. The next list probes again.
pub fn forget() {
    let mut store = store().lock().unwrap_or_else(|e| e.into_inner());
    store.map.clear();
    store.generation += 1;
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{Capabilities, InvokeRequest, Invocation};
    use std::sync::atomic::{AtomicUsize, Ordering};

    /// A provider whose `--version` takes `delay` and counts how often it ran.
    struct Slow {
        id: &'static str,
        delay: Duration,
        calls: Arc<AtomicUsize>,
    }

    impl AgentProvider for Slow {
        fn id(&self) -> &str {
            self.id
        }
        fn label(&self) -> &str {
            self.id
        }
        fn bin_name(&self) -> &str {
            self.id
        }
        fn is_available(&self) -> bool {
            true
        }
        fn version(&self) -> Option<String> {
            self.calls.fetch_add(1, Ordering::SeqCst);
            std::thread::sleep(self.delay);
            Some(format!("{} 1.0", self.id))
        }
        fn capabilities(&self) -> Capabilities {
            Capabilities::default()
        }
        fn build_invocation(&self, _req: &InvokeRequest) -> Result<Invocation, String> {
            Err("test provider".into())
        }
    }

    fn slow(id: &'static str, ms: u64) -> (Arc<dyn AgentProvider>, Arc<AtomicUsize>) {
        let calls = Arc::new(AtomicUsize::new(0));
        let p: Arc<dyn AgentProvider> = Arc::new(Slow {
            id,
            delay: Duration::from_millis(ms),
            calls: calls.clone(),
        });
        (p, calls)
    }

    // The store is process-wide, so every test uses ids no other test uses
    // and never calls `forget` (which would race the others).

    #[test]
    fn a_second_list_does_not_spawn_again() {
        let (a, calls) = slow("vc-test-second", 30);
        let list = vec![a];
        assert_eq!(versions(&list), vec![Some("vc-test-second 1.0".into())]);
        let t = Instant::now();
        assert_eq!(versions(&list), vec![Some("vc-test-second 1.0".into())]);
        assert!(t.elapsed() < Duration::from_millis(20), "warm list waited on a probe");
        assert_eq!(calls.load(Ordering::SeqCst), 1);
    }

    #[test]
    fn missing_versions_are_probed_together_not_one_after_another() {
        let (a, _) = slow("vc-test-par-a", 300);
        let (b, _) = slow("vc-test-par-b", 300);
        let (c, _) = slow("vc-test-par-c", 300);
        let t = Instant::now();
        let got = versions(&[a, b, c]);
        let took = t.elapsed();
        assert!(got.iter().all(|v| v.is_some()));
        assert!(took < Duration::from_millis(800), "three 300 ms probes took {took:?}");
    }

    #[test]
    fn concurrent_cold_lists_share_one_probe() {
        let (a, calls) = slow("vc-test-shared", 200);
        let list = Arc::new(vec![a]);
        let handles: Vec<_> = (0..4)
            .map(|_| {
                let list = list.clone();
                std::thread::spawn(move || versions(&list))
            })
            .collect();
        for h in handles {
            assert_eq!(h.join().unwrap(), vec![Some("vc-test-shared 1.0".into())]);
        }
        assert_eq!(calls.load(Ordering::SeqCst), 1);
    }

    #[test]
    fn a_probe_from_before_a_forget_is_not_written_back() {
        let generation = current_generation();
        remember("vc-test-old\u{0}x", Some("old".into()), generation.wrapping_sub(1));
        let store = store().lock().unwrap();
        assert!(!store.map.contains_key("vc-test-old\u{0}x"));
    }
}
