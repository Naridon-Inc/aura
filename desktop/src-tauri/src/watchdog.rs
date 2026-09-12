
//! Main-thread watchdog — notice a wedged window, and get out of it
//! **without killing the agents**.
//!
//! The app can stop responding while every Aura thread is perfectly healthy.
//! The freeze caught on 2026-08-30 (window dead, app up three days, 0% CPU,
//! 62 MB resident, no panic, no crash report) was a macOS AppKit re-entrancy
//! deadlock that happens entirely inside the frameworks. It is one shape a
//! stall takes, not the only one, and the module no longer claims otherwise —
//! see the first bullet under "deliberately does not do":
//!
//! ```text
//! FBSScene didUpdateSettings              ← WindowServer pushes a scene change
//!   -[NSWindow _setFrameCommon:…]         ← AppKit applies the new frame
//!     -[NSView setFrameSize:]             ← layout runs
//!       _postFrameChangeNotification
//!         -[NSWindow _setFrameCommon:…]   ← AppKit re-enters itself
//!           -[FBSScene _sendUpdate:]
//!             performAsyncAndWait         ← waits for the scene queue…
//!               __DISPATCH_WAIT_FOR_QUEUE__   …which the outer callout owns
//! ```
//!
//! Not one Aura frame appears between those two `_setFrameCommon` calls, so
//! there is no line of ours to correct: the main thread is parked in
//! `kevent_id` and is never coming back. The part that *is* ours is that
//! nothing noticed. The window sat there looking alive for three days, wrote
//! no report, and the only way out was Force Quit — a freeze is currently the
//! one failure mode Aura handles worse than a crash, which at least leaves a
//! report and a recovery toast behind.
//!
//! So this module gives a freeze the same treatment a panic already gets. A
//! background thread posts a beat to the main thread every few seconds; a live
//! main thread stamps the clock on its next runloop turn, a wedged one never
//! runs the block at all. After a minute of silence we write a crash-style
//! report into the same directory `crash.rs` writes to — so the launch-time
//! recovery toast explains what happened with no new UI — plus a diagnostic
//! bundle (beat history, live-agent inventory, a `/usr/bin/sample` of the
//! stuck process) that explains *future* stalls, then relaunch.
//!
//! **What recovery refuses to do: kill the user's agents.** A freeze usually
//! lands mid-task, with claude / codex / gemini sessions holding hours of
//! context. So instead of the quit path's child-reaping teardown:
//!
//! * every in-process session's transcript (block list + raw byte tail) is
//!   persisted to `~/.aura/aura-shell-recovery/<ts>/` before the relaunch,
//!   and the child processes are left running — SIGKILL of this process
//!   reparents them to launchd, and the recovery bundle records exactly who
//!   they are;
//! * daemon-backed sessions get the same `pre_relaunch` handshake the
//!   auto-updater uses, so `aura-pty-daemon` keeps their PTYs alive and the
//!   relaunched shell reattaches via `pty_list_alive`.
//!
//! Three things it deliberately does not do:
//!
//! * **Fire on a silent beat alone.** This is the correction of 2026-09-08,
//!   and it matters more than anything else in the module. A missed beat says
//!   the event loop did not *pump*; it does not say the main thread is stuck.
//!   An app whose window is hidden — which is every app of ours whose red
//!   close button has been pressed, since that hides rather than quits — is
//!   fed no events by macOS and parks in `ReceiveNextEventCommon`, which from
//!   the beat's side is indistinguishable from a deadlock. Of the 17 stalls
//!   this app recorded against itself on one machine in a week, replaying the
//!   samples through [`crate::watchdog_sample`] shows **13 had a perfectly
//!   healthy main thread**: thirteen `SIGKILL`s of a working app, mid-session,
//!   each one landing as "it closed by itself while I wasn't looking". So
//!   silence now only earns a `/usr/bin/sample`, and only a sample that finds
//!   the thread inside a call it cannot return from — twice, a beat apart —
//!   ends the process. No evidence means no kill.
//! * **Fire on a suspended process.** System sleep freezes the watchdog thread
//!   too, so on wake the main thread looks like it has been silent for hours.
//!   Our own loop slipping is the tell, and it resets the baseline instead.
//! * **Relaunch a dev build.** Under `tauri dev` the binary is owned by a
//!   harness that would have to be restarted with it, and the developer has a
//!   terminal in front of them. There we write the report + bundle and log
//!   the wedge with the sample command that proves it, and leave the process
//!   alone.

use std::collections::VecDeque;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Arc;
use std::time::{Duration, Instant};

use tauri::{AppHandle, Manager, Wry};

use crate::watchdog_sample::{self, MainThread};
use crate::{crash, telemetry};

/// How often we ask the main thread to prove it is alive. Short enough that a
/// wedge is caught inside a minute, long enough that the beat is invisible
/// next to the runloop's own traffic.
const BEAT_INTERVAL: Duration = Duration::from_secs(5);

/// How long the main thread may stay silent before we call it wedged. A
/// healthy main thread answers within one runloop turn, so any real value here
/// is arbitrary — this one is set for the false-positive side of the trade: a
/// full minute of a completely unresponsive window is never a slow frame, and
/// is already longer than anyone waits before reaching for Force Quit.
const WEDGE_AFTER: Duration = Duration::from_secs(60);

/// Slack on our own loop before we assume the whole process was suspended
/// rather than the main thread wedged. Sleep, SIGSTOP and a debugger stop all
/// look identical from in here, and in all three the main thread never had a
/// chance to answer.
const SUSPEND_SLIP: Duration = Duration::from_secs(20);

/// Samples that must agree the main thread is blocked before the process
/// ends over it. One sample catches a synchronous call that is merely slow —
/// every real stall recorded on this machine was WebKit releasing a process
/// assertion, which round-trips to RunningBoard and normally returns. Two,
/// a beat apart, is a call that has stopped coming back.
const WEDGE_CONFIRMATIONS: u32 = 2;

/// Ticks of (slip, silence) kept for the diagnostic bundle — two minutes of
/// lead-up at the beat interval, enough to see whether a stall arrived
/// suddenly or crept in behind a busy main thread.
const BEAT_HISTORY: usize = 24;

/// Start watching. Returns immediately; the watching happens on its own thread
/// and ends when the process does.
pub fn install(app: &AppHandle<Wry>) {
    let app = app.clone();
    let spawned = std::thread::Builder::new()
        .name("aura-main-watchdog".into())
        .spawn(move || watch(app));
    if let Err(e) = spawned {
        // Losing the watchdog costs us the recovery, not the app.
        tracing::warn!(error = %e, "main-thread watchdog failed to start");
    }
}

fn watch(app: AppHandle<Wry>) {
    let start = Instant::now();
    // Milliseconds since `start` when the main thread last ran one of our
    // blocks. Seeded to zero, which reads as "answered at startup" — the first
    // real beat lands one interval later.
    let last_beat = Arc::new(AtomicU64::new(0));
    let mut prev_tick = Duration::ZERO;
    let mut history: VecDeque<BeatRecord> = VecDeque::with_capacity(BEAT_HISTORY);
    // Consecutive samples that found the main thread genuinely blocked.
    let mut strikes: u32 = 0;

    loop {
        std::thread::sleep(BEAT_INTERVAL);
        let now = start.elapsed();
        let our_slip = now.saturating_sub(prev_tick);
        prev_tick = now;
        let silent = now.saturating_sub(Duration::from_millis(last_beat.load(Ordering::SeqCst)));

        if history.len() == BEAT_HISTORY {
            history.pop_front();
        }
        history.push_back(BeatRecord {
            slip_ms: our_slip.as_millis() as u64,
            silent_ms: silent.as_millis() as u64,
        });

        match assess(our_slip, silent) {
            Verdict::Suspended => {
                // We were frozen too, so the main thread's silence proves
                // nothing. Forgive it and start counting again.
                last_beat.store(now.as_millis() as u64, Ordering::SeqCst);
                continue;
            }
            Verdict::Silent => {
                // Silence earns a sample, not a kill. `probe` is the only
                // thing in this module that can tell a deadlocked main
                // thread from one parked behind a hidden window, and it
                // costs a couple of seconds once per WEDGE_AFTER window.
                let (evidence, sample_file) = probe();
                if !evidence.is_blocked() {
                    tracing::warn!(
                        silent_secs = silent.as_secs(),
                        evidence = %evidence.describe(),
                        "main thread went quiet but the sample clears it; not recovering"
                    );
                    // Healthy. Re-arm the baseline so the next probe is a
                    // whole window away rather than every beat.
                    last_beat.store(now.as_millis() as u64, Ordering::SeqCst);
                    strikes = 0;
                    continue;
                }
                // Blocked once. A synchronous XPC round trip that is slow
                // is still a call that returns; give it one more beat and
                // one more sample before ending the process over it.
                strikes += 1;
                tracing::warn!(
                    silent_secs = silent.as_secs(),
                    strikes,
                    evidence = %evidence.describe(),
                    "main thread appears blocked"
                );
                if strikes < WEDGE_CONFIRMATIONS {
                    continue;
                }
                recover(&app, silent, &history, &evidence, sample_file);
                return;
            }
            Verdict::Alive => strikes = 0,
        }

        let stamp = Arc::clone(&last_beat);
        if app
            .run_on_main_thread(move || {
                stamp.store(start.elapsed().as_millis() as u64, Ordering::SeqCst);
            })
            .is_err()
        {
            // The runtime is tearing down and will not run blocks any more.
            return;
        }
    }
}

/// What one tick of the loop makes of the world.
#[derive(Debug, PartialEq, Eq)]
enum Verdict {
    /// The main thread is answering, or has not been silent long enough to say.
    Alive,
    /// The whole process lost time, not just the main thread.
    Suspended,
    /// The main thread has been silent long enough to be worth sampling.
    /// **Not a sentence.** A silent beat says the event loop did not pump,
    /// which a hidden window and a deadlock produce alike; only the sample
    /// tells them apart.
    Silent,
}

/// Read one tick. `our_slip` is how long this thread's own loop took to come
/// round; `silent` is how long since the main thread last ran one of our
/// blocks.
///
/// Suspension is checked first and on purpose: after a laptop lid closes for an
/// hour both numbers are enormous, and reading that as a wedge would relaunch
/// the app on every wake.
fn assess(our_slip: Duration, silent: Duration) -> Verdict {
    if our_slip > BEAT_INTERVAL + SUSPEND_SLIP {
        return Verdict::Suspended;
    }
    if silent >= WEDGE_AFTER {
        return Verdict::Silent;
    }
    Verdict::Alive
}

/// One watchdog tick as remembered for the diagnostic bundle.
#[derive(serde::Serialize, Clone, Copy, Debug)]
struct BeatRecord {
    slip_ms: u64,
    silent_ms: u64,
}

/// What recovery will and will not do, decided purely from observable
/// state so the "never kills agents" contract is a tested property of a
/// pure function rather than a hope about a side-effecting one.
#[derive(Debug, PartialEq, Eq)]
struct RecoveryPlan {
    /// Crash-style report into `crash.rs`'s directory — feeds the
    /// launch-time recovery toast. Unconditional.
    write_report: bool,
    /// Diagnostic bundle (beat history + agent inventory + sample).
    /// Unconditional — a stall with no explanation is the bug this
    /// module exists to fix.
    write_bundle: bool,
    /// Persist in-process transcripts before the process goes away.
    /// Only when there is something to persist.
    persist_transcripts: bool,
    /// Ask aura-pty-daemon to hold its sessions across the restart.
    signal_daemon: bool,
    /// Queue `open -a` + SIGKILL self. Only when running out of a real
    /// `.app` bundle — a dev binary is report-only.
    relaunch: bool,
    /// The UI-01 contract: watchdog recovery NEVER reaps agent
    /// children. The quit path's kill_all stays where it is (a real
    /// quit); a wedge recovery leaves every agent process running.
    kill_agents: bool,
}

/// Decide the plan. `in_bundle` = running out of a `.app`; counts are the
/// registry's live in-process / daemon-backed session totals.
fn recovery_plan(in_bundle: bool, in_process_sessions: usize, daemon_sessions: usize) -> RecoveryPlan {
    RecoveryPlan {
        write_report: true,
        write_bundle: true,
        persist_transcripts: in_process_sessions > 0,
        signal_daemon: daemon_sessions > 0 || crate::pty_daemon::client::enabled(),
        relaunch: in_bundle,
        kill_agents: false,
    }
}

/// Record the wedge with enough evidence to explain it, keep every agent
/// alive, then get the user a window back.
fn recover(
    app: &AppHandle<Wry>,
    silent: Duration,
    history: &VecDeque<BeatRecord>,
    evidence: &MainThread,
    sample_file: Option<String>,
) {
    let secs = silent.as_secs();
    let bundle = app_bundle();

    let registry = app.state::<crate::cmd_agent_pty::AgentPtyRegistry>();
    let (transcripts, daemon_count) = registry.recovery_snapshot();
    let plan = recovery_plan(bundle.is_some(), transcripts.len(), daemon_count);
    debug_assert!(!plan.kill_agents);

    // What the sample actually measured, not what this module guessed the
    // failure mode would be when it was written.
    let detail = format!(
        "UI froze: the main thread stopped answering {secs}s ago, and {} — \
         confirmed by {WEDGE_CONFIRMATIONS} samples a beat apart.\n\
         Every other thread is running; the window is not, and no code in \
         this process can unblock it.\n\
         Your agents were NOT killed: {} in-process transcript(s) saved to \
         ~/.aura/aura-shell-recovery/, {} daemon session(s) held by \
         aura-pty-daemon.",
        evidence.describe(),
        transcripts.len(),
        daemon_count,
    );
    tracing::error!(silent_secs = secs, "{detail}");
    if plan.write_report {
        crash::write_report(
            detail.clone(),
            Some("watchdog.rs (main thread unresponsive)".to_string()),
            std::thread::current().name().map(String::from),
            String::new(),
        );
    }

    let stamp_ms = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as u64;

    if plan.write_bundle {
        if let Err(e) = write_stall_bundle(
            stamp_ms,
            secs,
            history,
            &transcripts,
            daemon_count,
            bundle.is_some(),
            evidence,
            sample_file,
        ) {
            tracing::warn!(error = %e, "could not write the stall diagnostic bundle");
        }
    }
    if plan.persist_transcripts {
        if let Err(e) = persist_transcripts(stamp_ms, &transcripts) {
            tracing::warn!(error = %e, "could not persist agent transcripts");
        }
    }

    telemetry::track(
        "app_main_thread_wedged",
        Some(serde_json::json!({
            "silent_secs": secs,
            "relaunch": plan.relaunch,
            "in_process_agents": transcripts.len(),
            "daemon_agents": daemon_count,
        })),
    );

    if plan.signal_daemon {
        // Same handshake the auto-updater uses before its relaunch: the
        // daemon marks its sessions keep-alive so the fresh shell can
        // reattach. The async runtime is healthy (only the main thread
        // is stuck), but cap the wait — a recovery path must not hang.
        let signalled = tauri::async_runtime::block_on(async {
            tokio::time::timeout(
                Duration::from_secs(5),
                crate::pty_daemon::client::pre_relaunch(),
            )
            .await
        });
        match signalled {
            Ok(Ok(n)) => tracing::info!(sessions = n, "daemon holding sessions across relaunch"),
            Ok(Err(e)) => tracing::warn!(error = %e, "daemon pre-relaunch signal failed"),
            Err(_) => tracing::warn!("daemon pre-relaunch signal timed out"),
        }
    }

    // Under a dev harness there is nothing safe to relaunch, and someone is
    // watching a terminal that now says exactly what happened.
    if !plan.relaunch {
        return;
    }
    let Some(bundle) = bundle else {
        return;
    };

    // NOTE the deliberate absence of `crate::teardown(app)` here — that is
    // the quit path's child-reaper, and reaping is exactly what a wedge
    // recovery must not do. In-process agent children reparent to launchd
    // when we SIGKILL ourselves and keep running; the daemon holds its own.

    if let Err(e) = relaunch(&bundle) {
        tracing::error!(error = %e, "could not queue the relaunch; leaving the process up");
        return;
    }

    // `app.exit()` and `std::process::exit()` both want the main thread — one
    // for the runloop, one for the atexit handlers AppKit registers there — so
    // neither can end a process whose main thread is the thing that is stuck.
    // SIGKILL also guarantees the RunEvent teardown (agent kill_all) never
    // runs, which on this path is a feature. The relauncher below is already
    // waiting on this pid.
    #[cfg(unix)]
    unsafe {
        libc::kill(std::process::id() as i32, libc::SIGKILL);
    }
}

/// The on-disk diagnostic bundle a future stall investigation starts from.
#[derive(serde::Serialize)]
struct StallBundle<'a> {
    timestamp_ms: u64,
    silent_secs: u64,
    verdict: &'static str,
    /// The frame the sample found the main thread held in — the evidence the
    /// verdict was actually made from.
    blocked_in: String,
    app_version: &'static str,
    pid: u32,
    relaunching: bool,
    /// (slip, silence) per watchdog tick leading up to the verdict.
    beat_history: Vec<BeatRecord>,
    /// Who was alive when the window died — the sessions recovery kept.
    in_process_agents: Vec<StallAgent<'a>>,
    daemon_agent_count: usize,
    /// Where the `/usr/bin/sample` of the wedged process landed, if it ran.
    sample_file: Option<String>,
    /// Where the transcripts landed.
    recovery_dir: String,
}

#[derive(serde::Serialize)]
struct StallAgent<'a> {
    session_id: &'a str,
    agent_id: &'a str,
    repo_root: &'a str,
    blocks: usize,
    raw_tail_bytes: usize,
}

/// Write `<ts>-stall.json` (+ best-effort `<ts>-sample.txt`) next to the
/// crash reports so one directory explains every bad end this app has.
fn write_stall_bundle(
    stamp_ms: u64,
    silent_secs: u64,
    history: &VecDeque<BeatRecord>,
    transcripts: &[crate::cmd_agent_pty::RecoverySessionSnapshot],
    daemon_count: usize,
    relaunching: bool,
    evidence: &MainThread,
    sample_file: Option<String>,
) -> std::io::Result<()> {
    let dir = crash::crashes_dir();
    std::fs::create_dir_all(&dir)?;

    let bundle = StallBundle {
        timestamp_ms: stamp_ms,
        silent_secs,
        verdict: "main_thread_wedged",
        blocked_in: evidence.describe(),
        app_version: env!("CARGO_PKG_VERSION"),
        pid: std::process::id(),
        relaunching,
        beat_history: history.iter().copied().collect(),
        in_process_agents: transcripts
            .iter()
            .map(|t| StallAgent {
                session_id: &t.session_id,
                agent_id: &t.agent_id,
                repo_root: &t.repo_root,
                blocks: t.blocks.len(),
                raw_tail_bytes: t.raw_tail.len(),
            })
            .collect(),
        daemon_agent_count: daemon_count,
        sample_file,
        recovery_dir: recovery_dir(stamp_ms).display().to_string(),
    };
    let path = dir.join(format!("{stamp_ms}-stall.json"));
    std::fs::write(&path, serde_json::to_vec_pretty(&bundle)?)?;
    Ok(())
}

/// `/usr/bin/sample <pid> 2` into the crashes dir — the exact stack proof
/// the 2026-08-30 investigation had to reconstruct by hand. Returns the
/// file path when the sample ran.
fn capture_sample(dir: &Path, stamp_ms: u64) -> Option<String> {
    if !cfg!(target_os = "macos") {
        return None;
    }
    let path = dir.join(format!("{stamp_ms}-sample.txt"));
    let ran = Command::new("/usr/bin/sample")
        .arg(std::process::id().to_string())
        .arg("2")
        .arg("-file")
        .arg(&path)
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .status()
        .map(|s| s.success())
        .unwrap_or(false);
    ran.then(|| path.display().to_string())
}

/// Sample this process and read the main thread's stack. The sample is kept
/// next to the crash reports either way — a stall that turned out to be a
/// parked window is exactly as worth explaining as one that was not.
///
/// A sample that will not run or will not parse comes back
/// [`MainThread::Unreadable`], which is not blocked: with no evidence the
/// process stays up. That is the safe direction. The old code had no
/// evidence at all and killed anyway.
fn probe() -> (MainThread, Option<String>) {
    let dir = crash::crashes_dir();
    if let Err(e) = std::fs::create_dir_all(&dir) {
        tracing::warn!(error = %e, "no crashes dir; cannot sample the main thread");
        return (MainThread::Unreadable, None);
    }
    let stamp_ms = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as u64;
    let Some(path) = capture_sample(&dir, stamp_ms) else {
        return (MainThread::Unreadable, None);
    };
    let verdict = std::fs::read_to_string(&path)
        .map(|t| watchdog_sample::classify(&t))
        .unwrap_or(MainThread::Unreadable);
    (verdict, Some(path))
}

fn recovery_dir(stamp_ms: u64) -> PathBuf {
    let home = dirs::home_dir().unwrap_or_else(|| PathBuf::from("/tmp"));
    home.join(".aura")
        .join("aura-shell-recovery")
        .join(stamp_ms.to_string())
}

/// Per-session transcript files: `<sid>.json` (identity + block list) and
/// `<sid>.raw.bin` (the raw PTY tail, same bytes a reattaching xterm would
/// replay). Written before the SIGKILL so no context is lost even for
/// in-process sessions whose PTY plumbing dies with us.
fn persist_transcripts(
    stamp_ms: u64,
    transcripts: &[crate::cmd_agent_pty::RecoverySessionSnapshot],
) -> std::io::Result<()> {
    let dir = recovery_dir(stamp_ms);
    std::fs::create_dir_all(&dir)?;
    for t in transcripts {
        let meta = serde_json::json!({
            "session_id": t.session_id,
            "agent_id": t.agent_id,
            "repo_root": t.repo_root,
            "saved_at_ms": stamp_ms,
            "reason": "main_thread_wedged",
            "blocks": t.blocks,
        });
        std::fs::write(
            dir.join(format!("{}.json", t.session_id)),
            serde_json::to_vec_pretty(&meta)?,
        )?;
        if !t.raw_tail.is_empty() {
            std::fs::write(dir.join(format!("{}.raw.bin", t.session_id)), &t.raw_tail)?;
        }
    }
    Ok(())
}

/// The `.app` we are running out of, or `None` when this is a bare dev binary.
fn app_bundle() -> Option<PathBuf> {
    let exe = std::env::current_exe().ok()?;
    // …/Aura.app/Contents/MacOS/aura-shell → …/Aura.app
    let bundle = exe.parent()?.parent()?.parent()?;
    (bundle.extension()?.to_str()? == "app").then(|| bundle.to_path_buf())
}

/// Queue a fresh launch for the moment this process is gone.
///
/// `open` would refuse to start a second copy while we are still running, and
/// we cannot run anything after we have exited — so the waiting is handed to a
/// detached shell. The pid and the path go in as arguments rather than
/// interpolated into the script, so a bundle path with a space or a quote in
/// it stays one word.
fn relaunch(bundle: &Path) -> std::io::Result<()> {
    Command::new("/bin/sh")
        .arg("-c")
        .arg("while /bin/kill -0 \"$1\" 2>/dev/null; do /bin/sleep 0.2; done; exec /usr/bin/open -a \"$2\"")
        .arg("aura-watchdog")
        .arg(std::process::id().to_string())
        .arg(bundle)
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .spawn()
        .map(|_| ())
}

#[cfg(test)]
mod tests {
    use super::*;

    // A normal tick: our loop came round on time and the main thread answered
    // the beat we posted last time.
    #[test]
    fn a_main_thread_that_answers_is_alive() {
        assert_eq!(
            assess(BEAT_INTERVAL, Duration::from_millis(30)),
            Verdict::Alive
        );
    }

    // Silence alone is not a wedge. A main thread busy with one long frame
    // still has the whole WEDGE_AFTER window to come back.
    #[test]
    fn a_slow_main_thread_is_given_the_whole_window() {
        assert_eq!(
            assess(BEAT_INTERVAL, WEDGE_AFTER - Duration::from_secs(1)),
            Verdict::Alive
        );
        assert_eq!(assess(BEAT_INTERVAL, WEDGE_AFTER), Verdict::Silent);
    }

    // The case this guard exists for: the lid was shut for an hour. Both
    // numbers are enormous, but our own loop losing the same hour proves the
    // main thread was never given a chance to answer — reading it as a wedge
    // would relaunch the app on every single wake.
    #[test]
    fn a_suspended_process_is_not_a_wedge() {
        let asleep = Duration::from_secs(3600);
        assert_eq!(assess(asleep, asleep), Verdict::Suspended);
    }

    // …and the converse, which is what makes the guard safe to have: a real
    // wedge does not slow this thread down at all, so it is never mistaken for
    // a suspension however long it lasts.
    #[test]
    fn a_wedge_does_not_hide_behind_the_suspend_guard() {
        assert_eq!(
            assess(BEAT_INTERVAL, Duration::from_secs(3600)),
            Verdict::Silent
        );
    }

    // Scheduler jitter is not suspension. The slack has to absorb an ordinary
    // late wake-up, or a loaded machine would keep resetting the baseline and
    // the watchdog would never fire at all.
    #[test]
    fn ordinary_jitter_does_not_reset_the_baseline() {
        assert_eq!(
            assess(BEAT_INTERVAL + Duration::from_secs(1), WEDGE_AFTER),
            Verdict::Silent
        );
    }

    // The window-cycle shape from the UI-01 harness, replayed against the
    // verdict function: restore/resize/navigation churn shows up here as
    // busy-but-answering ticks (small silence, normal slip) and must stay
    // Alive through arbitrarily many cycles; the wedge only lands when the
    // main thread actually stops answering.
    #[test]
    fn repeated_window_cycles_never_trip_the_watchdog() {
        for _cycle in 0..1000 {
            // restore → resize → navigate: each tick answered within a
            // couple of frames, loop on schedule.
            for busy_ms in [16u64, 120, 450, 900, 3_000] {
                assert_eq!(
                    assess(BEAT_INTERVAL, Duration::from_millis(busy_ms)),
                    Verdict::Alive,
                    "an answering main thread mid-cycle must never be declared wedged"
                );
            }
        }
        // …until it genuinely stops answering.
        assert_eq!(assess(BEAT_INTERVAL, WEDGE_AFTER), Verdict::Silent);
    }

    // The regression this module was rewritten for. Between 2026-09-01 and
    // 2026-09-08 this app SIGKILLed itself 17 times on this machine; replaying
    // the samples it captured shows 13 of them had a main thread parked in the
    // ordinary event pump with nothing blocking it. Silence reaching the
    // threshold must therefore reach the sample, and only a blocked sample may
    // reach `recover`.
    #[test]
    fn silence_alone_never_authorises_a_kill() {
        assert_eq!(assess(BEAT_INTERVAL, WEDGE_AFTER), Verdict::Silent);
        assert_ne!(assess(BEAT_INTERVAL, WEDGE_AFTER), Verdict::Alive);

        let parked = "    1353 Thread_1   DispatchQueue_1: com.apple.main-thread  (serial)\n\
                      + 1353 ReceiveNextEventCommon  (in HIToolbox) + 688\n\
                      +   1353 mach_msg2_trap  (in libsystem_kernel.dylib) + 8\n";
        assert!(!watchdog_sample::classify(parked).is_blocked());
        // …and an absent or unreadable sample is not permission either.
        assert!(!watchdog_sample::classify("").is_blocked());
        assert!(!MainThread::Unreadable.is_blocked());
    }

    // One blocked sample is a slow call; the process only ends when two
    // agree. Pinned as a constant so lowering it is a deliberate edit.
    #[test]
    fn a_single_blocked_sample_is_not_enough() {
        assert!(WEDGE_CONFIRMATIONS >= 2);
    }

    // The UI-01 acceptance contract, pinned on the pure plan: whatever the
    // environment (dev build, bundle, agents or none), recovery never
    // includes killing agents, and evidence (report + bundle) is
    // unconditional.
    #[test]
    fn recovery_never_kills_agents_and_always_leaves_evidence() {
        for in_bundle in [false, true] {
            for in_process in [0usize, 3] {
                for daemon in [0usize, 2] {
                    let plan = recovery_plan(in_bundle, in_process, daemon);
                    assert!(!plan.kill_agents, "recovery must preserve agent processes");
                    assert!(plan.write_report && plan.write_bundle);
                    assert_eq!(plan.persist_transcripts, in_process > 0);
                    assert_eq!(plan.relaunch, in_bundle, "dev builds are report-only");
                }
            }
        }
    }

    // Daemon-held sessions must always get the keep-alive handshake when
    // any exist, regardless of relaunch mode.
    #[test]
    fn daemon_sessions_always_get_the_keepalive_handshake() {
        assert!(recovery_plan(true, 0, 1).signal_daemon);
        assert!(recovery_plan(false, 5, 3).signal_daemon);
    }
}
