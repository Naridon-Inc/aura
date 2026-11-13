import { useEffect, useState } from "react";
import {
  callScreenshareWorkpaneId,
  getDeafenedPreference,
  getMicEnabledPreference,
  leaveCall,
  setDeafenedPreference,
  setMicEnabledPreference,
  useCallMicLevel,
  useCallSnapshot,
} from "../../lib/callStore";
import {
  Headphones,
  HeadphoneOff,
  Mic,
  MicOff,
  Monitor,
  MonitorOff,
  PhoneOff,
} from "lucide-react";

import { Button } from "../ui/button";
import "../ui/call-strip.css";

// Persistent in-call strip — v0.2.24 (HH.6).
//
// Replaces the old 11px-icon-only "status pill". When the user is in
// (or joining) a huddle this renders a full inline strip with labelled
// controls. It rides in the work header, so with the sidebar's call dock
// closed it is still the one place to see and control the call:
//
//     🎙 #design   🎤 Mic [VU]   🔇 Deafen   🖥 Screen   ⏏ Leave
//
//   • channel chip — click focuses the chat channel + un-minimizes
//     CallPanel
//   • Mic — toggles `setMicEnabledPreference` (persists across calls,
//     writes through to LiveKit when live). VU bar renders right of the
//     icon while mic is enabled, fed by the separate `useCallMicLevel`
//     atom (10Hz, doesn't re-render the rest of the snapshot consumers).
//   • Deafen — toggles `setDeafenedPreference` (mutes RoomAudioRenderer
//     <audio> elements; the dock has a 1s re-apply loop for newcomers)
//   • Screen — tri-state matching VoiceDockPanel (HH.5):
//        - localSharing  → red dot, stops my share
//        - remoteSharing → opens the screenshare workpane tab
//        - idle          → starts my share
//   • Leave — calls `leaveCall()` (dispatches `aura:leave-huddle` →
//     HuddleUI hardLeave → callStore.clearCall via epoch guard)
//
// Subtle background tint signals call state at a glance: green while
// connected, amber while connecting. The controls are the header's own
// ghost buttons, so the call reads as part of the header, not a widget
// dropped into it.
//
// The whole strip carries `data-incall-control="true"` so the
// Esc-to-leave keydown handler (HH.9) can scope itself to in-call
// surfaces and not steal Esc from the chat composer or Monaco.
//
// State comes from the callStore singleton (no Context). Toggles
// dispatch into the live LocalParticipant via the store's imperative
// helpers — the UI doesn't import LiveKit at all.
export function CallStatusPill({ suppressed = false }: { suppressed?: boolean }) {
  const snap = useCallSnapshot();
  // Track preference state via local mirror so the strip re-renders
  // immediately on toggle (the localStorage write isn't observable).
  const [micPref, setMicPref] = useState<boolean>(() =>
    getMicEnabledPreference(),
  );
  const [deafenPref, setDeafenPref] = useState<boolean>(() =>
    getDeafenedPreference(),
  );
  useEffect(() => {
    // Re-sync prefs whenever the call state changes (e.g. join applies
    // them and may have flipped LiveKit underneath).
    setMicPref(getMicEnabledPreference());
    setDeafenPref(getDeafenedPreference());
  }, [snap.active, snap.connecting]);

  if (!snap.active && !snap.connecting) return null;
  // The caller hides the strip while the sidebar's call dock is on screen —
  // one set of call controls at a time.
  if (suppressed) return null;

  const channelLabel = snap.channel
    ? `#${snap.channelName ?? snap.channel}`
    : "Huddle";
  const localSharing = snap.screenshareEnabled;
  const remoteSharing = snap.screenshareTracks.some((t) => !t.isLocal);
  const remoteShareCount = snap.screenshareTracks.filter(
    (t) => !t.isLocal,
  ).length;

  function focusChannel() {
    if (!snap.repoRoot || !snap.channel) return;
    window.dispatchEvent(
      new CustomEvent("aura:focus-channel", {
        detail: { repoRoot: snap.repoRoot, channel: snap.channel },
      }),
    );
  }

  function openShareTab() {
    if (!snap.repoRoot || !snap.channel) return;
    window.dispatchEvent(
      new CustomEvent("aura:open-screenshare", {
        detail: {
          workpaneId: callScreenshareWorkpaneId(snap.repoRoot, snap.channel),
          repoRoot: snap.repoRoot,
          channel: snap.channel,
        },
      }),
    );
  }

  function toggleScreenshare() {
    if (!snap.repoRoot || !snap.channel) return;
    window.dispatchEvent(
      new CustomEvent("aura:toggle-screenshare", {
        detail: { repoRoot: snap.repoRoot, channel: snap.channel },
      }),
    );
  }

  function onScreenClick() {
    if (localSharing) toggleScreenshare();
    else if (remoteSharing) openShareTab();
    else toggleScreenshare();
  }

  function onMicClick() {
    const next = !micPref;
    setMicPref(next);
    void setMicEnabledPreference(next);
  }

  function onDeafenClick() {
    const next = !deafenPref;
    setDeafenPref(next);
    setDeafenedPreference(next);
  }

  // Connecting state — same strip shape, amber tint, controls disabled
  // because LiveKit isn't live yet. Channel chip + Leave still work
  // (Leave cancels the pending join via the CallPanel fallback).
  const isConnecting = snap.connecting && !snap.active;

  return (
    <span
      data-incall-control="true"
      data-state={isConnecting ? "connecting" : "live"}
      className="ui-call-strip"
    >
      <Button
        variant="ghost"
        size="sm"
        onClick={focusChannel}
        title={
          isConnecting
            ? `Joining ${channelLabel}…`
            : `In huddle. Click to focus ${channelLabel}`
        }
        className="ui-call-channel"
      >
        <span className="ui-call-dot" aria-hidden />
        <span className="ui-call-channel-name">{channelLabel}</span>
      </Button>

      <Button
        variant="ghost"
        size="sm"
        onClick={onMicClick}
        disabled={isConnecting}
        title={micPref ? "Mute mic" : "Unmute mic"}
        aria-label={micPref ? "Mute mic" : "Unmute mic"}
        data-off={!micPref}
      >
        {micPref ? <Mic /> : <MicOff />}
        <span className="ui-call-label">{micPref ? "Mic" : "Muted"}</span>
        {micPref && !isConnecting && <MicVuBar />}
      </Button>

      <Button
        variant="ghost"
        size="sm"
        onClick={onDeafenClick}
        disabled={isConnecting}
        title={deafenPref ? "Un-deafen" : "Deafen (mute everyone)"}
        aria-label={deafenPref ? "Un-deafen" : "Deafen"}
        data-off={deafenPref}
      >
        {deafenPref ? <HeadphoneOff /> : <Headphones />}
        <span className="ui-call-label">{deafenPref ? "Deafened" : "Audio"}</span>
      </Button>

      <Button
        variant="ghost"
        size="sm"
        onClick={onScreenClick}
        disabled={isConnecting}
        title={
          localSharing
            ? "Stop sharing your screen"
            : remoteSharing
              ? `Open screenshare${remoteShareCount > 1 ? ` (${remoteShareCount} sharing)` : ""}`
              : "Share your screen"
        }
        aria-label={
          localSharing
            ? "Stop screen share"
            : remoteSharing
              ? "View screen share"
              : "Start screen share"
        }
        data-off={localSharing}
        className="ui-call-screen"
      >
        {localSharing ? <MonitorOff /> : <Monitor />}
        <span className="ui-call-label">
          {localSharing
            ? "Stop"
            : remoteSharing
              ? `View${remoteShareCount > 1 ? ` (${remoteShareCount})` : ""}`
              : "Screen"}
        </span>
        {!localSharing && remoteSharing && remoteShareCount > 1 && (
          <span className="ui-call-count">{remoteShareCount}</span>
        )}
        {localSharing && <span className="ui-call-live" aria-hidden />}
      </Button>

      <Button
        variant="ghost"
        size="sm"
        onClick={() => leaveCall()}
        title="Leave huddle (Esc)"
        aria-label="Leave huddle"
        className="ui-call-leave"
      >
        <PhoneOff />
        Leave
      </Button>
    </span>
  );
}

// Mic VU meter — 12×4 bar fed by the callStore micLevel atom. Lives
// in its own component so re-renders at 10Hz don't bubble into the
// rest of the strip (the parent <CallStatusPill> doesn't subscribe
// to micLevel). Green at low/mid level, amber when peaking (>0.8).
function MicVuBar() {
  const level = useCallMicLevel();
  // Smooth the bar — raw audioLevel is jittery at low input. A simple
  // perceptual curve (sqrt) makes the meter responsive to quiet speech
  // without pinning at the top during normal volume.
  const visual = Math.sqrt(Math.max(0, Math.min(1, level)));
  const widthPx = Math.round(visual * 12);
  const peaking = level > 0.8;
  return (
    <span className="ui-call-vu" aria-hidden>
      <span data-peaking={peaking} style={{ width: widthPx }} />
    </span>
  );
}
