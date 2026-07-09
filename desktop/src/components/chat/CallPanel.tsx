// CallPanel — headless host for the LiveKit huddle session.
//
// ## Lifecycle
//
// Mounted exactly once at App level. Renders no visible UI; the
// surface lives in VoiceDockPanel (left-sidebar dock). CallPanel
// listens for `aura:start-huddle` with `{ repoRoot, channel,
// channelName }`, then:
//
//   1. Looks up our `device_identity` (id + display name).
//   2. Looks up the repo-derived `roomId` SHA (same one chat uses).
//   3. Mints a LiveKit JWT via `api.callsToken({...})`.
//   4. Mounts `<LiveKitRoom>` (with `display: contents`) so the
//      session connects to `wss://livekit.auravcs.com` (configurable
//      via `VITE_LIVEKIT_URL`).
//
// All visible state flows through the callStore singleton, which the
// dock + StatusBar pill + ScreenshareTab subscribe to.
//
// ## Why a top-level mount
//
// The huddle outlives any single chat surface — collapsing the right
// rail, swapping repos, or hiding CommsPanel entirely should NOT drop
// the call. Mounting at App level (next to the other dialogs) keeps
// the call alive for the lifetime of the workspace.
//
// ## Screenshare
//
// When the local user toggles screenshare on, LiveKit triggers the OS
// picker. On macOS the Aura app needs Screen Recording permission —
// the existing Permissions onboarding panel covers this, but if it
// didn't get granted earlier the user can re-grant via System
// Settings → Privacy & Security → Screen Recording → enable Aura.
// See HUDDLE-OPS.md for the operator-side checklist.
//
// Incoming screenshare tracks auto-open in a dedicated ScreenshareTab
// workpane — see HuddleUI's publishCallState effect for the
// auto-open trigger.
//
// V0.2.8 — the previous top-right floating shell was retired. The
// dock at the bottom of the left sidebar is the canonical surface.

import { useCallback, useEffect, useRef, useState } from "react";
import {
  LiveKitRoom,
  RoomAudioRenderer,
  useLocalParticipant,
  useParticipants,
  useRoomContext,
  useTracks,
} from "@livekit/components-react";
import {
  RoomEvent,
  Track,
  type LocalParticipant,
  type RemoteParticipant,
  type RemoteTrackPublication,
} from "livekit-client";
import {
  clearCallActivity,
  recordCallActivity,
} from "../../lib/callActivity";
import { api, type CallToken } from "../../lib/api";
import {
  callScreenshareWorkpaneId,
  clearCall,
  currentCallEpoch,
  getDeafenedPreference,
  getMicEnabledPreference,
  publishCallParticipants,
  publishCallState,
  publishMicLevel,
  setCallConnecting,
  type CallParticipant,
  type CallScreenshareTrack,
} from "../../lib/callStore";

type HuddleDetail = {
  repoRoot: string;
  channel: string;
  channelName: string;
};

type Session = {
  detail: HuddleDetail;
  token: CallToken;
};

export function CallPanel() {
  const [pending, setPending] = useState<HuddleDetail | null>(null);
  const [session, setSession] = useState<Session | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [minimized, setMinimized] = useState(false);

  // Track in-flight start requests so a double-click on the huddle
  // button can't race two token mints.
  const startingRef = useRef<string | null>(null);
  // Mirror of the latest `leave` callback, so the `aura:leave-huddle`
  // listener can call it without re-binding on every render. Mutated
  // by the effect that defines `leave` below.
  const leaveRef = useRef<(() => void) | null>(null);

  useEffect(() => {
    const onStart = (ev: Event) => {
      const detail = (ev as CustomEvent<HuddleDetail>).detail;
      if (!detail || !detail.repoRoot || !detail.channel) return;
      // If we're already in this exact huddle, just un-minimize.
      if (session && sameHuddle(session.detail, detail)) {
        setMinimized(false);
        return;
      }
      // If we're in a different huddle, tear it down first.
      setSession(null);
      setError(null);
      setMinimized(false);
      setPending(detail);
      // Flip the singleton into "connecting…" so the StatusBar pill
      // shows up the moment the user clicks Join — without waiting
      // for the token mint + LiveKit handshake round-trip.
      setCallConnecting({
        repoRoot: detail.repoRoot,
        channel: detail.channel,
        channelName: detail.channelName,
      });
    };
    window.addEventListener("aura:start-huddle", onStart as EventListener);
    return () => {
      window.removeEventListener("aura:start-huddle", onStart as EventListener);
    };
  }, [session]);

  // External "leave" trigger — fallback path for the connecting state.
  //
  // When a LiveKitRoom + HuddleUI is already mounted, HuddleUI owns the
  // `aura:leave-huddle` listener: it runs `hardLeave` (unpublish mic +
  // screen, room.disconnect, then `onLeave` → `leave`) — that's the
  // happy path.
  //
  // BUT: if the user clicks Leave while we're still in the `pending`
  // state (token mint / SFU handshake), no HuddleUI exists yet to catch
  // the event. This minimal fallback ensures the pending state still
  // tears down cleanly. It only runs when `session === null && pending
  // !== null` so we don't double-fire with HuddleUI's listener and race
  // the SFU teardown.
  useEffect(() => {
    if (session) return;
    if (!pending && !error) return;
    const onLeaveEvt = () => leaveRef.current?.();
    window.addEventListener("aura:leave-huddle", onLeaveEvt as EventListener);
    return () => {
      window.removeEventListener(
        "aura:leave-huddle",
        onLeaveEvt as EventListener,
      );
    };
  }, [session, pending, error]);

  // V.Y.4 — the StatusBar pill's "click to focus" dispatches
  // `aura:focus-channel`. If the click targets the currently-live
  // huddle, un-minimize the floating shell so the participant list
  // and controls come back into view. CommsPanel handles the actual
  // chat-channel focus side of the same event.
  useEffect(() => {
    const onFocus = (ev: Event) => {
      const detail = (ev as CustomEvent).detail as
        | { repoRoot?: string; channel?: string }
        | undefined;
      if (!detail) return;
      // Re-show the panel only when the event targets our active
      // huddle; an unrelated channel-focus shouldn't ruin a
      // deliberately-minimized call.
      const cur = session?.detail ?? pending;
      if (
        cur &&
        detail.repoRoot === cur.repoRoot &&
        detail.channel === cur.channel
      ) {
        setMinimized(false);
      }
    };
    window.addEventListener("aura:focus-channel", onFocus as EventListener);
    return () => {
      window.removeEventListener("aura:focus-channel", onFocus as EventListener);
    };
  }, [session, pending]);

  // HH.9 — Esc-to-leave keybinding. Only fires when the focused element
  // (or one of its ancestors) carries `data-incall-control="true"` so we
  // don't steal Esc from the chat composer, Monaco editor, or any modal.
  // In-call surfaces that opt in: StatusBar in-call strip, VoiceDockPanel,
  // and ScreenshareTab. Floating PiP picks this up too once HH.13 lands.
  useEffect(() => {
    if (!session && !pending) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      const target = e.target as HTMLElement | null;
      if (!target || typeof target.closest !== "function") return;
      if (!target.closest('[data-incall-control="true"]')) return;
      e.preventDefault();
      e.stopPropagation();
      leaveRef.current?.();
    };
    window.addEventListener("keydown", onKey, true);
    return () => {
      window.removeEventListener("keydown", onKey, true);
    };
  }, [session, pending]);

  // Mint token + open the room. Runs whenever `pending` flips to a new
  // huddle. We stash the token + detail in `session` once both halves
  // succeed; mount of <LiveKitRoom> handles the actual SFU connect.
  useEffect(() => {
    if (!pending) return;
    const key = huddleKey(pending);
    if (startingRef.current === key) return;
    startingRef.current = key;

    let cancelled = false;
    (async () => {
      try {
        // Use the repo-scoped identity so the name in voice matches
        // the name in chat (and in git log). Falls back to the global
        // identity for repos without local user.{name,email}.
        const ident = await api.deviceIdentityForRepo(pending.repoRoot);
        const roomId = await api.deviceRoomId(pending.repoRoot);
        const token = await api.callsToken({
          roomId,
          channel: pending.channel,
          identity: ident.device_id,
          displayName: ident.display_name || ident.device_id,
        });
        if (cancelled) return;
        setSession({ detail: pending, token });
        setPending(null);
        // Announce the join to teammates via the presence beacon. The
        // Tauri command fires an immediate heartbeat so the 🎧 N chip
        // updates without waiting for the periodic tick. Best-effort —
        // a transient cloud error shouldn't block the call itself.
        api.teamVoiceSet(pending.repoRoot, pending.channel).catch(() => {});
      } catch (e) {
        if (cancelled) return;
        const msg = e instanceof Error ? e.message : String(e);
        setError(msg);
        setPending(null);
        // V0.2.8 — the floating shell that used to render this error is
        // gone. Clear the connecting state in the singleton so the dock
        // doesn't get stuck in "Connecting…" forever, and broadcast the
        // failure so any host UI (toast, notifier) can surface it.
        clearCall();
        console.error("Huddle start failed:", msg);
        window.dispatchEvent(
          new CustomEvent("aura:huddle-error", { detail: { message: msg } }),
        );
      } finally {
        if (startingRef.current === key) startingRef.current = null;
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [pending]);

  // Remember the last-joined repoRoot so a `leave()` from a leftover
  // hook (e.g. LiveKitRoom.onDisconnected fired after `session` was
  // cleared) can still clear the cloud-side voice presence. We can't
  // stash this on `session` alone because `leave` runs synchronously
  // and `session` is nulled by the time the cleanup callback fires.
  const lastRepoRootRef = useRef<string | null>(null);
  useEffect(() => {
    if (session) lastRepoRootRef.current = session.detail.repoRoot;
  }, [session]);

  const leave = useCallback(() => {
    // Idempotent — multiple leave paths can race (HuddleUI's hardLeave
    // listener fires onLeave, which calls leave(); LiveKitRoom's
    // onDisconnected ALSO calls leave()). Bail when nothing is live.
    if (!session && !pending && !error) return;
    setSession(null);
    setPending(null);
    setError(null);
    setMinimized(false);
    // Clear the singleton so the StatusBar pill + any open
    // screenshare workpane disappear immediately. CallPanel's own
    // state reset above handles the floating shell.
    clearCall();
    const repoRoot = lastRepoRootRef.current;
    if (repoRoot) {
      // Tell teammates we left voice. Same best-effort pattern as
      // join — the 30-minute presence TTL is the safety net if this
      // POST never lands (e.g. cloud unreachable mid-leave).
      api.teamVoiceSet(repoRoot, null).catch(() => {});
    }
    // Broadcast the leave so the channel-list/header roster can flip
    // immediately, without waiting for the next presence-driven manifest
    // refresh. Detail: `{ channel: null }` — see CommsPanel listener.
    window.dispatchEvent(
      new CustomEvent("aura:huddle-state", { detail: { channel: null } }),
    );
    // Deps MUST include session/pending/error: the guard above reads them,
    // and an empty dep array would freeze this closure on render-0 values
    // (all null/false) — making the guard permanently true and `leave()` a
    // silent no-op. That stranded the user "in call" after clicking Leave
    // (audio dropped on the SFU side, but the UI never cleared).
  }, [session, pending, error]);
  // Keep the ref pointed at the latest callback so the external
  // `aura:leave-huddle` listener (installed once on mount) always
  // invokes the current closure.
  useEffect(() => {
    leaveRef.current = leave;
  }, [leave]);
  // Mirror the active session as an `aura:huddle-state` broadcast — the
  // CommsPanel listens for it to drive the channel-header "Leave" button
  // and the rail's local highlight while the cloud beacon catches up.
  useEffect(() => {
    if (!session) return;
    window.dispatchEvent(
      new CustomEvent("aura:huddle-state", {
        detail: { channel: session.detail.channel },
      }),
    );
  }, [session]);

  // Window-close cleanup: if the user quits the app while in a call,
  // best-effort clear our voice presence so the roster on other clients
  // catches up sooner than the 30-minute TTL. `pagehide` is the only
  // hook the OS gives us a chance to run reliably before tear-down.
  useEffect(() => {
    const onLeave = () => {
      const repoRoot = lastRepoRootRef.current;
      if (!repoRoot) return;
      try {
        api.teamVoiceSet(repoRoot, null).catch(() => {});
      } catch {
        /* shutting down — ignore */
      }
    };
    window.addEventListener("pagehide", onLeave);
    window.addEventListener("beforeunload", onLeave);
    return () => {
      window.removeEventListener("pagehide", onLeave);
      window.removeEventListener("beforeunload", onLeave);
    };
  }, []);

  // Nothing in flight, nothing live — render nothing.
  if (!pending && !session && !error) return null;

  // V0.2.8 — the visible huddle surface moved out of CallPanel and into
  // VoiceDockPanel (left-sidebar dock). CallPanel is now purely a
  // headless host for the LiveKitRoom + state plumbing:
  //   - `pending` and `error` flow into the callStore via
  //     setCallConnecting; the dock renders the "Connecting…" UI.
  //   - The live `<LiveKitRoom>` still mounts so SFU audio plays, but
  //     it renders no visible chrome — HuddleUI returns null and only
  //     side-effects (publishCallState + auto-open screenshare).
  //
  // Don't return null for the pending/error branches — the callStore
  // singleton was already updated upstream (setCallConnecting in the
  // start handler) and the dock reads its own state. There's no
  // <LiveKitRoom> to mount until the token lands, so just emit nothing.
  if (!session) return null;

  // Keep the minimize state referenced so the legacy `aura:focus-channel`
  // un-minimize path (still useful for the dock's focus-channel button)
  // doesn't break — but the value itself is no longer rendered.
  void minimized;

  return (
    <LiveKitRoom
      serverUrl={session.token.url}
      token={session.token.token}
      connect={true}
      audio={true}
      video={false}
      onDisconnected={leave}
      onError={(err) => setError(err.message)}
      // No visible chrome — the dock is the surface. Keep the wrapper
      // div out of the layout flow either way.
      style={{ display: "contents" }}
    >
      <RoomAudioRenderer />
      <HuddleUI onLeave={leave} detail={session.detail} />
    </LiveKitRoom>
  );
}

// Inner side-effect component runs inside <LiveKitRoom> so the LiveKit
// hooks have a Room context. As of v0.2.8 this renders NO visible UI —
// the floating shell was retired in favor of the left-sidebar dock
// (VoiceDockPanel). HuddleUI's only job now is to:
//   1. Publish LiveKit participant state into the callStore singleton
//      so VoiceDockPanel + ScreenshareTab + StatusBar pill stay in sync.
//   2. Auto-open the screenshare workpane the first time a new
//      screen-share track shows up.
//   3. Listen for `aura:leave-huddle` (parent already handles this
//      one too, but the LiveKit-side hard-leave needs to run inside
//      Room context to unpublish tracks before disconnecting).
//   4. Listen for `aura:toggle-screenshare` (dispatched by the dock's
//      screenshare button) and flip the LocalParticipant's screenshare.
function HuddleUI({
  onLeave,
  detail,
}: {
  onLeave: () => void;
  /** Active huddle metadata — needed so HuddleUI can publish the
   *  repoRoot/channel pair into the callStore singleton (the
   *  StatusBar pill + ScreenshareTab + VoiceDockPanel read it back). */
  detail: HuddleDetail;
}) {
  const room = useRoomContext();
  const {
    localParticipant,
    isMicrophoneEnabled,
    isScreenShareEnabled,
    isCameraEnabled,
  } = useLocalParticipant();
  const screenTracks = useTracks([Track.Source.ScreenShare], {
    onlySubscribed: true,
  });
  // Camera tracks + the full participant roster feed the call-stage grid
  // (ScreenshareTab). They publish into the callStore participant atom,
  // which only the stage subscribes to — the dock/pill stay out of the
  // speaking-rate churn.
  const cameraTracks = useTracks([Track.Source.Camera], {
    onlySubscribed: true,
  });
  const allParticipants = useParticipants();
  // useParticipants ticks on join/leave/mute/track changes but NOT on
  // active-speaker changes — bump local state on ActiveSpeakersChanged so
  // the roster effect below re-publishes the speaking flags for the ring.
  const [speakingTick, setSpeakingTick] = useState(0);

  // Capture the callStore epoch at mount-time. Every publishCallState +
  // publishMicLevel below tags writes with this epoch — if clearCall()
  // bumps the global epoch (e.g. a sibling leave path teared down before
  // our HuddleUI unmounted), our late writes get dropped instead of
  // resurrecting a stale "active" snapshot.
  const epochRef = useRef<number>(currentCallEpoch());

  // Apply persisted mic + deafen preferences exactly once per joined room.
  // <LiveKitRoom audio={true}> publishes the mic on connect; if the user
  // had muted themselves from the identity bar before joining, we flip
  // it back off here. Deafen is applied via the RoomAudioRenderer audio
  // elements; the VoiceDockPanel keeps re-applying it on a 1s interval so
  // late-joining remote participants are also muted. A ref-guarded effect
  // ensures we don't loop on the LiveKit `isMicrophoneEnabled` state
  // changes we'd otherwise depend on.
  const appliedPrefsRef = useRef(false);
  useEffect(() => {
    if (appliedPrefsRef.current) return;
    if (!localParticipant) return;
    appliedPrefsRef.current = true;
    const micWanted = getMicEnabledPreference();
    const deafenWanted = getDeafenedPreference();
    if (!micWanted) {
      void localParticipant.setMicrophoneEnabled(false).catch((e) => {
        console.warn("CallPanel: apply mic preference failed", e);
      });
    }
    if (deafenWanted) {
      // Defer one tick — the RAR audio elements may not be in the DOM yet
      // at the moment LiveKitRoom fires its first render.
      window.setTimeout(() => {
        const audios = document.querySelectorAll<HTMLAudioElement>(
          "audio[data-lk-source], audio[data-lk-track-source]",
        );
        audios.forEach((el) => {
          el.muted = true;
        });
      }, 50);
    }
  }, [localParticipant]);

  // Publish to the singleton on every render. setSnapshot inside the
  // store deep-compares so this is cheap when nothing changed (which
  // is most renders — LiveKit only ticks on participant events).
  // Why screenTrackKeys+sigs as deps instead of `screenTracks`: the
  // useTracks hook returns a fresh array reference every render even
  // when contents are stable, so a raw dep would publish + re-fan-out
  // on every paint.
  const screenTrackKeys = screenTracks
    .map((t) => `${t.participant?.sid ?? "?"}:${t.publication?.trackSid ?? "?"}`)
    .join("|");
  // Snapshot the previous screenshare-track key set so we only fire
  // the auto-open event when a NEW track appears (not on every render
  // while it's already showing). A persistent open-on-each-render
  // would fight the user's manual tab closes.
  const lastScreenKeysRef = useRef<string>("");
  useEffect(() => {
    const built: CallScreenshareTrack[] = screenTracks
      .map((t) => {
        const pub = t.publication;
        const tk = pub?.track;
        if (!tk) return null;
        const sid = t.participant?.sid ?? "?";
        const tsid = pub?.trackSid ?? "?";
        const name =
          t.participant?.name || t.participant?.identity || "Someone";
        const isLocal =
          (t.participant as LocalParticipant | undefined)?.isLocal === true;
        const entry: CallScreenshareTrack = {
          key: `${sid}:${tsid}`,
          participantName: name,
          track: tk,
          isLocal,
        };
        return entry;
      })
      .filter((x): x is CallScreenshareTrack => x !== null);
    publishCallState({
      repoRoot: detail.repoRoot,
      channel: detail.channel,
      channelName: detail.channelName,
      micEnabled: isMicrophoneEnabled,
      screenshareEnabled: isScreenShareEnabled,
      cameraEnabled: isCameraEnabled,
      screenshareTracks: built,
      localParticipant,
      epoch: epochRef.current,
    });

    // Auto-open the ScreenshareTab workpane whenever a NEW track key
    // shows up. App.tsx owns the listener so it can route into the
    // active editor's openScreenshare(). Local + remote both
    // auto-open — the local sharer wants the big preview too.
    const currentKeys = built.map((t) => t.key).sort().join("|");
    const prevKeys = lastScreenKeysRef.current;
    if (currentKeys !== prevKeys) {
      const prevSet = new Set(prevKeys ? prevKeys.split("|") : []);
      const newOnes = built.filter((t) => !prevSet.has(t.key));
      if (newOnes.length > 0) {
        window.dispatchEvent(
          new CustomEvent("aura:open-screenshare", {
            detail: {
              workpaneId: callScreenshareWorkpaneId(
                detail.repoRoot,
                detail.channel,
              ),
              repoRoot: detail.repoRoot,
              channel: detail.channel,
            },
          }),
        );
      }
      lastScreenKeysRef.current = currentKeys;
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    detail.repoRoot,
    detail.channel,
    detail.channelName,
    isMicrophoneEnabled,
    isScreenShareEnabled,
    isCameraEnabled,
    screenTrackKeys,
    localParticipant,
  ]);

  // Re-render on active-speaker changes so the roster effect re-runs.
  useEffect(() => {
    if (!room) return;
    const onSpeakers = () => setSpeakingTick((n) => n + 1);
    room.on(RoomEvent.ActiveSpeakersChanged, onSpeakers);
    return () => {
      room.off(RoomEvent.ActiveSpeakersChanged, onSpeakers);
    };
  }, [room]);

  // Publish the live participant roster into the callStore participant
  // atom for the call-stage grid. Keyed on a cheap signature (sid +
  // speaking + mic per participant, plus the camera-track key set) so we
  // only re-publish when something visible changes, not on every tick.
  const cameraKeys = cameraTracks
    .map((t) => `${t.participant?.sid ?? "?"}:${t.publication?.trackSid ?? "?"}`)
    .join("|");
  const rosterSig = allParticipants
    .map((p) => `${p.sid}:${p.isSpeaking ? 1 : 0}:${p.isMicrophoneEnabled ? 1 : 0}`)
    .join("|");
  useEffect(() => {
    const camBySid = new Map<string, Track>();
    for (const t of cameraTracks) {
      const tk = t.publication?.track;
      const sid = t.participant?.sid;
      if (tk && sid) camBySid.set(sid, tk);
    }
    const list: CallParticipant[] = allParticipants.map((p) => ({
      sid: p.sid,
      identity: p.identity,
      name: p.name || p.identity || "Someone",
      isLocal: p.isLocal === true,
      isSpeaking: p.isSpeaking,
      micEnabled: p.isMicrophoneEnabled,
      cameraTrack: camBySid.get(p.sid) ?? null,
    }));
    // Local participant pinned first, then the rest in join order.
    list.sort((a, b) => (a.isLocal === b.isLocal ? 0 : a.isLocal ? -1 : 1));
    publishCallParticipants(list, epochRef.current);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rosterSig, cameraKeys, speakingTick]);

  // Record activity events (join / leave / share) into the
  // callActivity ring buffer. The VoiceDockPanel Activity popover
  // reads from there. Bind exactly once per Room ctor — re-binding on
  // every render would miss events fired in between renders.
  useEffect(() => {
    if (!room) return;
    // Seed with the local user's own join. We record *after* the
    // LocalParticipant is identified so the display name lands right.
    const localName =
      room.localParticipant?.name ||
      room.localParticipant?.identity ||
      "You";
    recordCallActivity("join", localName, true);

    const onPC = (p: RemoteParticipant) => {
      recordCallActivity("join", p.name || p.identity || "Someone", false);
    };
    const onPD = (p: RemoteParticipant) => {
      recordCallActivity("leave", p.name || p.identity || "Someone", false);
    };
    const onTP = (pub: RemoteTrackPublication, p: RemoteParticipant) => {
      if (pub.source !== Track.Source.ScreenShare) return;
      recordCallActivity(
        "screenshare-start",
        p.name || p.identity || "Someone",
        false,
      );
    };
    const onTU = (pub: RemoteTrackPublication, p: RemoteParticipant) => {
      if (pub.source !== Track.Source.ScreenShare) return;
      recordCallActivity(
        "screenshare-stop",
        p.name || p.identity || "Someone",
        false,
      );
    };
    room.on(RoomEvent.ParticipantConnected, onPC);
    room.on(RoomEvent.ParticipantDisconnected, onPD);
    room.on(RoomEvent.TrackPublished, onTP);
    room.on(RoomEvent.TrackUnpublished, onTU);
    return () => {
      room.off(RoomEvent.ParticipantConnected, onPC);
      room.off(RoomEvent.ParticipantDisconnected, onPD);
      room.off(RoomEvent.TrackPublished, onTP);
      room.off(RoomEvent.TrackUnpublished, onTU);
      // HuddleUI is unmounting → call is over → flush the buffer so
      // the next call starts clean.
      clearCallActivity();
    };
  }, [room]);

  // Track local screenshare toggles (LiveKit's TrackPublished fires
  // for remote tracks only — local publish goes through a different
  // event). We sample `isScreenShareEnabled` transitions instead.
  const prevLocalShareRef = useRef<boolean>(false);
  useEffect(() => {
    if (prevLocalShareRef.current === isScreenShareEnabled) return;
    const localName =
      room?.localParticipant?.name ||
      room?.localParticipant?.identity ||
      "You";
    recordCallActivity(
      isScreenShareEnabled ? "screenshare-start" : "screenshare-stop",
      localName,
      true,
    );
    prevLocalShareRef.current = isScreenShareEnabled;
  }, [isScreenShareEnabled, room]);

  // Mic VU meter — sample LocalParticipant.audioLevel at 10 Hz and
  // push into the callStore's dedicated mic-level atom (separate from
  // the main snapshot so 10 Hz updates don't fan out to every consumer).
  // We poll because LiveKit's audioLevel updates come via the speaker
  // events at ~250 ms which is too coarse for a smooth VU bar.
  useEffect(() => {
    if (!localParticipant) return;
    let cancelled = false;
    const tick = () => {
      if (cancelled) return;
      const lvl =
        typeof localParticipant.audioLevel === "number"
          ? localParticipant.audioLevel
          : 0;
      publishMicLevel(isMicrophoneEnabled ? lvl : 0, epochRef.current);
    };
    const handle = window.setInterval(tick, 100);
    return () => {
      cancelled = true;
      window.clearInterval(handle);
    };
  }, [localParticipant, isMicrophoneEnabled]);

  // VoiceDockPanel dispatches `aura:toggle-screenshare` for its
  // screenshare button — it can't call into LocalParticipant directly
  // because the dock lives OUTSIDE the LiveKitRoom subtree. We catch
  // the event here (inside Room context) and flip the publication.
  // Mic toggle goes through callStore.toggleCallMic which already has
  // a direct LocalParticipant reference from publishCallState, so we
  // don't need a similar listener for mic.
  const toggleScreenRef = useRef<() => Promise<void>>(async () => {});
  useEffect(() => {
    toggleScreenRef.current = async () => {
      try {
        await localParticipant.setScreenShareEnabled(!isScreenShareEnabled);
      } catch (e) {
        console.warn("setScreenShareEnabled failed", e);
      }
    };
  }, [localParticipant, isScreenShareEnabled]);
  useEffect(() => {
    const onToggle = (ev: Event) => {
      const d = (ev as CustomEvent).detail as
        | { repoRoot?: string; channel?: string }
        | undefined;
      // Only respond when the event targets the active huddle —
      // protects against a stale dispatch from a previous huddle that
      // got queued during a quick rejoin.
      if (
        d &&
        d.repoRoot &&
        d.channel &&
        (d.repoRoot !== detail.repoRoot || d.channel !== detail.channel)
      ) {
        return;
      }
      void toggleScreenRef.current();
    };
    window.addEventListener(
      "aura:toggle-screenshare",
      onToggle as EventListener,
    );
    return () => {
      window.removeEventListener(
        "aura:toggle-screenshare",
        onToggle as EventListener,
      );
    };
  }, [detail.repoRoot, detail.channel]);

  // Hard-leave — relying on <LiveKitRoom> unmount alone wasn't enough to
  // drop the participant on the SFU side (the room.disconnect() inside
  // the wrapper races with React unmounting and sometimes leaves stale
  // track publications). Unpublish mic + screen explicitly first, then
  // disconnect synchronously, then bubble up to parent so it can clear
  // session state and dismiss the panel.
  const hardLeave = useCallback(async () => {
    // Exit the UI *first*. The user clicked Leave and must be out
    // immediately, even if the SFU socket is unresponsive. Previously the
    // state teardown (onLeave) ran only AFTER awaiting room.disconnect(),
    // so a hung disconnect left the user stranded "in call" with no way
    // out but to quit the app. The LiveKit cleanup below is best-effort
    // and must never gate the exit.
    onLeave();
    try {
      if (isMicrophoneEnabled) {
        await localParticipant.setMicrophoneEnabled(false);
      }
      if (isScreenShareEnabled) {
        await localParticipant.setScreenShareEnabled(false);
      }
    } catch (e) {
      console.warn("unpublish on leave failed", e);
    }
    try {
      await room.disconnect(true);
    } catch (e) {
      console.warn("room.disconnect on leave failed", e);
    }
  }, [
    isMicrophoneEnabled,
    isScreenShareEnabled,
    localParticipant,
    onLeave,
    room,
  ]);

  // Mirror the latest hardLeave so the (static) window listener below
  // always invokes the freshest closure — without it we'd re-register
  // the listener on every render and risk missing an event that fires
  // mid-swap.
  const hardLeaveRef = useRef(hardLeave);
  useEffect(() => {
    hardLeaveRef.current = hardLeave;
  }, [hardLeave]);

  // External "leave" — the channel-header roster's Leave button (and
  // any other remote control) dispatches `aura:leave-huddle`. Route it
  // through hardLeave so the SFU drops the participant; otherwise the
  // parent's listener only clears React state and the call lingers.
  useEffect(() => {
    const onLeaveEvt = () => {
      void hardLeaveRef.current();
    };
    window.addEventListener("aura:leave-huddle", onLeaveEvt as EventListener);
    return () => {
      window.removeEventListener(
        "aura:leave-huddle",
        onLeaveEvt as EventListener,
      );
    };
  }, []);

  // Reference hardLeave to keep useCallback happy without an unused
  // warning — the leave path is exercised via the window listener.
  void hardLeave;

  // No visible chrome — VoiceDockPanel renders the surface. All the
  // hooks above are kept for their side effects: publishCallState,
  // auto-open of the screenshare workpane, and the leave/toggle
  // listeners that bridge dock events into LiveKit.
  return null;
}

function huddleKey(d: HuddleDetail): string {
  return `${d.repoRoot}::${d.channel}`;
}

function sameHuddle(a: HuddleDetail, b: HuddleDetail): boolean {
  return a.repoRoot === b.repoRoot && a.channel === b.channel;
}
