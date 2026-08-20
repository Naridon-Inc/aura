// Overview — the landing of the customization surface. Two things: a single
// "tell the agent what you want" box (describe a change in plain English and a
// real agent goes and makes it), and a grid of cards that show, at a glance,
// what's set up — how many agents are ready, which connections exist, whether
// the safety net is on — each a doorway into its section. Mirrors the
// reference's "Customize Your Agent" home, in Aura's own language and skin.

import { useState, type ReactNode } from "react";
import { ArrowRight, CornerDownLeft, Sparkles } from "lucide-react";

import type { Agent } from "../../../lib/agents";
import type { CustomizeNavItem, CustomizeStores } from "./customizeShared";
import { CountPill, instructionCount } from "./customizeShared";

export function OverviewPane({
  nav,
  agents,
  stores,
  onNavigate,
  onClose,
}: {
  /** The category items (Overview excluded) rendered as cards. */
  nav: CustomizeNavItem[];
  agents: Agent[];
  stores: CustomizeStores;
  onNavigate: (id: CustomizeNavItem["id"]) => void;
  onClose: () => void;
}) {
  const [draft, setDraft] = useState("");
  const target = agents.find((a) => a.available) ?? null;

  // Hand the request to a real agent through the normal launcher, then close
  // so the user lands on the running session. No agent installed → the box is
  // disabled with a hint, so this only fires when there's someone to do it.
  const submit = () => {
    const text = draft.trim();
    if (!text || !target) return;
    window.dispatchEvent(
      new CustomEvent("aura:run-agent-preset", {
        detail: { agentId: target.id, agentLabel: target.label, prompt: text },
      }),
    );
    onClose();
  };

  return (
    <div className="h-full overflow-y-auto">
      <div className="mx-auto max-w-3xl px-8 py-9">
        {/* Hero */}
        <div className="mb-7 text-center">
          <div
            className="mx-auto mb-3 flex h-11 w-11 items-center justify-center rounded-xl"
            style={{
              background:
                "color-mix(in srgb, var(--color-accent) 16%, transparent)",
              color: "var(--color-accent)",
            }}
          >
            <Sparkles size={20} />
          </div>
          <h1 className="text-xl font-semibold text-text-1">
            Customize your agent
          </h1>
          <p className="mx-auto mt-1.5 max-w-md text-base leading-relaxed text-text-3">
            Tell it what you want in plain words, or set things up by hand below, who does the work, what it can reach, and how you stay protected.
          </p>
        </div>

        {/* Prompt box */}
        <div className="mb-8 rounded-xl border border-line-soft bg-bg-1/50 p-2.5 focus-within:border-line-strong">
          <textarea
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) submit();
            }}
            rows={2}
            placeholder={
              target
                ? "e.g. Add a check that runs my tests before every commit"
                : "Install a coding agent to use this"
            }
            disabled={!target}
            className="w-full resize-none bg-transparent px-2 pt-1.5 text-base leading-relaxed text-text-1 placeholder:text-text-4 focus:outline-none disabled:opacity-60"
          />
          <div className="flex items-center justify-between px-1 pt-1">
            <span className="text-xs text-text-4">
              {target
                ? `${target.label} will pick this up`
                : "No agent installed yet"}
            </span>
            <button
              type="button"
              onClick={submit}
              disabled={!draft.trim() || !target}
              className="inline-flex items-center gap-1.5 rounded-md px-3 py-1.5 text-sm font-medium text-white transition-[filter] hover:brightness-110 disabled:opacity-40"
              style={{ background: "var(--color-accent)" }}
            >
              Send
              <CornerDownLeft size={13} />
            </button>
          </div>
        </div>

        {/* Category cards */}
        <div className="grid grid-cols-1 gap-2.5 sm:grid-cols-2">
          {nav.map((item) => (
            <CategoryCard
              key={item.id}
              icon={item.icon}
              label={item.label}
              blurb={item.blurb}
              meta={cardMeta(item.id, agents, stores)}
              onClick={() => onNavigate(item.id)}
            />
          ))}
        </div>
      </div>
    </div>
  );
}

// The live count/status shown on each card — the at-a-glance "what's set up".
function cardMeta(
  id: CustomizeNavItem["id"],
  agents: Agent[],
  stores: CustomizeStores,
): ReactNode {
  switch (id) {
    case "agents": {
      const n = agents.filter((a) => a.available).length;
      return <CountPill>{n === 1 ? "1 ready" : `${n} ready`}</CountPill>;
    }
    case "skills": {
      const n = stores.plugins.filter((p) => p.kind === "skill").length;
      return <CountPill>{n}</CountPill>;
    }
    case "instructions": {
      const n = instructionCount(stores.memory);
      return <CountPill>{n === 1 ? "1 rule" : `${n} rules`}</CountPill>;
    }
    case "hooks":
      return (
        <CountPill>{stores.capture?.enabled ? "On" : "Off"}</CountPill>
      );
    case "mcp":
      return <CountPill>{stores.mcp.length}</CountPill>;
    case "addons": {
      // The Add-ons card now stands for both tracks; the live count we hold is
      // the ADE-native plugins (Extensions are fetched lazily inside the pane),
      // so show installed plugins as the at-a-glance signal.
      const n = stores.plugins.filter((p) => p.kind === "plugin").length;
      return <CountPill>{n === 1 ? "1 plugin" : `${n} plugins`}</CountPill>;
    }
    default:
      return null;
  }
}

function CategoryCard({
  icon,
  label,
  blurb,
  meta,
  onClick,
}: {
  icon: ReactNode;
  label: string;
  blurb: string;
  meta: ReactNode;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="group flex flex-col gap-2 rounded-lg border border-line-soft bg-bg-0 shadow-[var(--shadow-card)] p-3.5 text-left transition-colors hover:border-line-strong hover:bg-state-hover"
    >
      <div className="flex items-center justify-between">
        <span className="flex items-center gap-2 text-text-2">
          {icon}
          <span className="text-base font-medium text-text-1">{label}</span>
        </span>
        {meta}
      </div>
      <p className="text-sm leading-relaxed text-text-4">{blurb}</p>
      <span className="mt-0.5 inline-flex items-center gap-1 text-xs text-text-4 transition-colors group-hover:text-accent">
        Open
        <ArrowRight
          size={12}
          className="transition-transform group-hover:translate-x-0.5"
        />
      </span>
    </button>
  );
}
