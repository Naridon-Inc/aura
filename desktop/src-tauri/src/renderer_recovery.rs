//! What to do when macOS takes the window's renderer away.
//!
//! WKWebView keeps the page in a process of its own
//! (`com.apple.WebKit.WebContent`), and that process sits near the top of the
//! kernel's jetsam list. When the machine runs out of memory the kernel
//! SIGKILLs it and leaves `aura-shell` running with a blank window: the PTYs
//! are still open, the agents are still streaming, and the app answers
//! nothing because the thing that draws is gone.
//!
//! Nothing crashed, so nothing writes a crash report. The only trace is one
//! line in the system log —
//!
//! ```text
//! log show --last 48h --predicate 'process == "runningboardd" AND eventMessage CONTAINS "aura.shell"' \
//!   | grep "termination reported"
//! ```
//!
//! — reading `termination reported by launchd (19, 1, 9)`, where 19 is the
//! jetsam namespace and 9 is SIGKILL. To whoever is using the app it is
//! indistinguishable from a crash, and the only way out is to quit and
//! relaunch. That is the shape of "Aura keeps crashing" on a machine whose
//! swap is full, and it is the one failure here that left no evidence at all.
//!
//! Tauri's default for the event is to do nothing. So: reload the page, back
//! off if the kernel keeps taking it — a machine that is genuinely out of
//! memory must not be spun in a reload loop — and leave a record next to the
//! panics so the next investigation finds something to read.
//!
//! macOS and iOS only; the hook does not exist on the other platforms because
//! their webviews do not split the page into a separate process this way.

use std::collections::HashMap;
use std::sync::{Mutex, OnceLock};
use std::time::{Duration, Instant};

/// How far back a reclaim still counts toward the backoff. Long enough that a
/// machine shedding memory every couple of minutes is recognised as one bad
/// stretch rather than a series of unrelated one-offs.
const MEMORY: Duration = Duration::from_secs(5 * 60);

/// Wait before reloading, by how many reclaims have happened within `MEMORY`.
///
/// The first is instant, because a single eviction should read as a flicker
/// and not as an outage. After that the gaps widen: if the kernel is taking
/// the renderer repeatedly then memory is still gone, and a page that reloads
/// into that only asks for the same allocation again.
const BACKOFF: [Duration; 5] = [
    Duration::ZERO,
    Duration::from_secs(2),
    Duration::from_secs(5),
    Duration::from_secs(15),
    Duration::from_secs(30),
];

/// The reclaims one webview has seen lately.
#[derive(Default)]
pub(crate) struct Tracker {
    seen: Vec<Instant>,
}

impl Tracker {
    /// Record a reclaim at `now`; answer how long to wait before reloading,
    /// and how many reclaims that makes inside the window.
    pub(crate) fn record(&mut self, now: Instant) -> (Duration, usize) {
        self.seen
            .retain(|t| now.saturating_duration_since(*t) < MEMORY);
        self.seen.push(now);
        let nth = self.seen.len();
        let step = nth.min(BACKOFF.len()) - 1;
        (BACKOFF[step], nth)
    }
}

fn trackers() -> &'static Mutex<HashMap<String, Tracker>> {
    static TRACKERS: OnceLock<Mutex<HashMap<String, Tracker>>> = OnceLock::new();
    TRACKERS.get_or_init(|| Mutex::new(HashMap::new()))
}

/// The hook: macOS has just killed this webview's renderer.
///
/// Runs on the main thread, as the delegate callback that carries it does, so
/// everything slow — the record write and the wait — happens elsewhere.
pub fn on_renderer_terminated<R: tauri::Runtime>(webview: &tauri::Webview<R>) {
    let label = webview.label().to_string();
    let (delay, nth) = {
        // A poisoned lock here means a previous call panicked mid-record. The
        // count is a backoff hint, not state worth refusing to recover over.
        let mut map = trackers().lock().unwrap_or_else(|e| e.into_inner());
        map.entry(label.clone()).or_default().record(Instant::now())
    };

    let webview = webview.clone();
    std::thread::spawn(move || {
        crate::crash::record_renderer_reclaimed(&label, delay, nth);
        if !delay.is_zero() {
            std::thread::sleep(delay);
        }
        // `reload` hands the work to the runtime's own thread, so calling it
        // from here is sound; a webview closed while we waited just errors.
        let _ = webview.reload();
    });
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn first_reclaim_reloads_immediately() {
        let mut t = Tracker::default();
        let (delay, nth) = t.record(Instant::now());
        assert_eq!(delay, Duration::ZERO);
        assert_eq!(nth, 1);
    }

    #[test]
    fn repeats_inside_the_window_back_off() {
        let mut t = Tracker::default();
        let now = Instant::now();
        let delays: Vec<Duration> = (0..4).map(|i| t.record(now + ms(i * 10)).0).collect();
        assert_eq!(
            delays,
            vec![
                Duration::ZERO,
                Duration::from_secs(2),
                Duration::from_secs(5),
                Duration::from_secs(15),
            ]
        );
    }

    #[test]
    fn backoff_stops_widening_at_the_cap() {
        let mut t = Tracker::default();
        let now = Instant::now();
        let mut last = Duration::ZERO;
        for i in 0..12 {
            last = t.record(now + ms(i * 10)).0;
        }
        assert_eq!(last, Duration::from_secs(30));
    }

    #[test]
    fn a_reclaim_older_than_the_window_is_forgotten() {
        let mut t = Tracker::default();
        let now = Instant::now();
        t.record(now);
        t.record(now + ms(50));
        // Far enough out that neither of the two still counts.
        let (delay, nth) = t.record(now + MEMORY + Duration::from_secs(1));
        assert_eq!(delay, Duration::ZERO, "a fresh stretch starts instant again");
        assert_eq!(nth, 1);
    }

    #[test]
    fn the_window_prunes_only_what_has_aged_out() {
        let mut t = Tracker::default();
        let now = Instant::now();
        t.record(now);
        // Still inside the window measured from the second call, so the first
        // one counts and this is the second reclaim.
        let (delay, nth) = t.record(now + MEMORY - Duration::from_secs(1));
        assert_eq!(nth, 2);
        assert_eq!(delay, Duration::from_secs(2));
    }

    #[test]
    fn each_webview_backs_off_on_its_own() {
        let mut map: HashMap<String, Tracker> = HashMap::new();
        let now = Instant::now();
        let first = map.entry("main".into()).or_default().record(now);
        let second = map.entry("hud".into()).or_default().record(now + ms(5));
        assert_eq!(first.0, Duration::ZERO);
        assert_eq!(second.0, Duration::ZERO, "the HUD is not charged for main");
        let again = map.entry("main".into()).or_default().record(now + ms(10));
        assert_eq!(again.1, 2);
    }

    fn ms(n: u64) -> Duration {
        Duration::from_millis(n)
    }
}
