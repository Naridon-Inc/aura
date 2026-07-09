// First-run consent for anonymous product telemetry.
//
// Aura's audience is non-engineers who fear software doing things behind their
// back, so we ask once, in plain language, and send NOTHING until they answer
// (telemetry.rs gates every event on `decided`). We explain what we collect
// (anonymous usage counts + crash reports — never their code, files, prompts,
// or names) and gently make the case for leaving crash reports on, because
// that's the part that actually helps us fix the thing that just broke for
// them. Both switches default on; either can be turned off here and later in
// Settings → Privacy.
//
// Shown only when `telemetryConsentGet().decided === false`. Once answered it
// never reappears.

import { useEffect, useState } from "react";
import { api, type TelemetryConsent as Consent } from "../lib/api";
import { Switch } from "./ui/switch";

export function TelemetryConsent() {
  const [show, setShow] = useState(false);
  const [product, setProduct] = useState(true);
  const [crash, setCrash] = useState(true);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    let alive = true;
    api
      .telemetryConsentGet()
      .then((c: Consent) => {
        if (alive && !c.decided) setShow(true);
      })
      .catch(() => {
        /* no backend / no key — never prompt */
      });
    return () => {
      alive = false;
    };
  }, []);

  if (!show) return null;

  const save = async (p: boolean, c: boolean) => {
    setSaving(true);
    try {
      await api.telemetrySetConsent(p, c);
    } catch {
      /* best-effort — closing either way so we don't nag */
    } finally {
      setShow(false);
    }
  };

  return (
    <div
      style={{
        position: "fixed",
        bottom: 44,
        right: 16,
        zIndex: 9999,
        width: 380,
        background: "var(--color-bg-elevated, #1a1a1a)",
        border: "1px solid var(--color-border, #2a2a2a)",
        borderLeft: "3px solid var(--color-accent, #5aa9e6)",
        borderRadius: 8,
        boxShadow: "0 8px 24px rgba(0,0,0,0.35)",
        color: "var(--color-text, #e5e7eb)",
        padding: "14px 16px",
        fontSize: 12,
        lineHeight: 1.5,
      }}
    >
      <div
        style={{
          fontWeight: 600,
          fontSize: 13,
          marginBottom: 4,
          color: "var(--color-text, #e5e7eb)",
        }}
      >
        Help make Aura better?
      </div>
      <div style={{ color: "var(--color-text-dim, #9ca3af)" }}>
        Aura can send anonymous notes about which features get used and when
        something crashes — so we can see what's working and fix what isn't. It{" "}
        <span style={{ color: "var(--color-text, #e5e7eb)" }}>never</span> sends
        your code, your files, what you type, or your name. You can change this
        anytime in Settings.
      </div>

      <div style={{ marginTop: 12, display: "grid", gap: 10 }}>
        <Row
          on={crash}
          onToggle={() => setCrash((v) => !v)}
          title="Crash reports"
          hint="The most useful — tells us when Aura breaks so we can fix it for you."
        />
        <Row
          on={product}
          onToggle={() => setProduct((v) => !v)}
          title="Usage analytics"
          hint="Anonymous counts of which features people open. No content."
        />
      </div>

      <div
        style={{
          display: "flex",
          gap: 8,
          marginTop: 14,
          justifyContent: "flex-end",
          alignItems: "center",
        }}
      >
        <button
          type="button"
          disabled={saving}
          onClick={() => save(false, false)}
          style={{
            cursor: saving ? "default" : "pointer",
            background: "transparent",
            border: "none",
            color: "var(--color-text-dim, #9ca3af)",
            fontSize: 12,
            padding: "5px 8px",
          }}
        >
          No thanks
        </button>
        <button
          type="button"
          disabled={saving}
          onClick={() => save(product, crash)}
          style={{
            cursor: saving ? "default" : "pointer",
            background: "var(--color-accent, #5aa9e6)",
            border: "1px solid var(--color-accent, #5aa9e6)",
            borderRadius: 6,
            color: "#0b1118",
            fontWeight: 600,
            fontSize: 12,
            padding: "5px 14px",
          }}
        >
          Allow
        </button>
      </div>
    </div>
  );
}

function Row({
  on,
  onToggle,
  title,
  hint,
}: {
  on: boolean;
  onToggle: () => void;
  title: string;
  hint: string;
}) {
  return (
    <div style={{ display: "flex", gap: 10, alignItems: "flex-start" }}>
      <Switch
        checked={on}
        onCheckedChange={onToggle}
        style={{ marginTop: 1, flexShrink: 0 }}
      />
      <div style={{ minWidth: 0 }}>
        <div style={{ color: "var(--color-text, #e5e7eb)", fontWeight: 500 }}>
          {title}
        </div>
        <div style={{ color: "var(--color-text-dim, #9ca3af)", fontSize: 11 }}>
          {hint}
        </div>
      </div>
    </div>
  );
}
