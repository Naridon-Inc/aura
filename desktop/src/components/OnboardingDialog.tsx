// First-launch onboarding. A 9-step flow modeled on Superset v2 that
// introduces Aura as the "Agentic Development Environment" (ADE) with
// semantic version control over Git.
//
// Stage A — Welcome wizard (modal, ~720px):
//   welcome  → hero with WELCOME TO AURA in bold display caps
//   intro    → "Let's get you started" body explainer
//   projects → import existing local repos (reads aura.recents)
//   presets  → import terminal-agent CLI presets (claude / amp / codex / …)
//
// Stage B — Fullscreen setup with top stepper:
//   providers   → Connect AI provider (Claude or Codex)
//   github      → GitHub CLI detect + install hint
//   permissions → macOS permissions (Full Disk / Accessibility / Mic)
//   project     → pick the first repo
//   worktrees   → enable worktrees (last step, optional)
//
// Trigger:
//   - Auto-opens on first launch when localStorage["aura.onboarding.complete"]
//     is not "1".
//   - Re-openable from Settings via `aura:open-onboarding` event.

import { useCallback, useEffect, useMemo, useState } from "react";
import { openUrl } from "@tauri-apps/plugin-opener";
import { api } from "../lib/api";
import { Input } from "./ui/input";

const COMPLETE_KEY = "aura.onboarding.complete";
const AGENT_KEY = "aura.defaultAgent";
const PROVIDER_PREF_KEY = "aura.providerPref"; // "claude-pro" | "claude-api" | "claude-custom" | "codex-pro" | ...

type AgentId = "claude" | "amp" | "codex" | "gemini" | "copilot";
type ProviderChoice = "claude-pro" | "claude-api" | "claude-custom";
type CodexChoice = "codex-pro" | "codex-api" | "codex-custom";

// Stage A (modal). Stage B (fullscreen).
type Step =
  | "welcome"
  | "intro"
  | "projects"
  | "presets"
  | "providers"
  | "providers-codex"
  | "github"
  | "permissions"
  | "project"
  | "worktrees"
  | "done";

const MODAL_STEPS: Step[] = ["welcome", "intro", "projects", "presets"];
const FULL_STEPS: Step[] = [
  "providers",
  "providers-codex",
  "github",
  "permissions",
  "project",
  "worktrees",
];

// The five labels shown in the top stepper during Stage B. We collapse
// the two provider sub-steps under "AI providers".
const STEPPER: { key: Step | "providers-group"; label: string }[] = [
  { key: "providers-group", label: "AI providers" },
  { key: "github", label: "GitHub CLI" },
  { key: "permissions", label: "Permissions" },
  { key: "project", label: "Project" },
  { key: "worktrees", label: "Parallel copies" },
];

export function OnboardingDialog() {
  const [open, setOpen] = useState(false);
  const [step, setStep] = useState<Step>("welcome");
  const [agent, setAgent] = useState<AgentId>(() => {
    try {
      return (localStorage.getItem(AGENT_KEY) as AgentId) ?? "claude";
    } catch {
      return "claude";
    }
  });
  const [providerChoice, setProviderChoice] = useState<ProviderChoice>(
    "claude-pro",
  );
  const [codexChoice, setCodexChoice] = useState<CodexChoice>("codex-pro");

  // Auto-open on first launch.
  useEffect(() => {
    try {
      if (localStorage.getItem(COMPLETE_KEY) !== "1") setOpen(true);
    } catch {
      setOpen(true);
    }
  }, []);

  // Re-openable from Settings.
  useEffect(() => {
    function onOpen() {
      try {
        localStorage.removeItem(COMPLETE_KEY);
      } catch {
        /* private mode */
      }
      setStep("welcome");
      setOpen(true);
    }
    window.addEventListener("aura:open-onboarding", onOpen);
    return () => window.removeEventListener("aura:open-onboarding", onOpen);
  }, []);

  const finish = useCallback(() => {
    try {
      localStorage.setItem(COMPLETE_KEY, "1");
      localStorage.setItem(AGENT_KEY, agent);
      localStorage.setItem(PROVIDER_PREF_KEY, providerChoice);
    } catch {
      /* private mode */
    }
    setOpen(false);
  }, [agent, providerChoice]);

  const allSteps: Step[] = useMemo(
    () => [...MODAL_STEPS, ...FULL_STEPS, "done"],
    [],
  );
  const goNext = useCallback(() => {
    const i = allSteps.indexOf(step);
    if (i < 0 || i >= allSteps.length - 1) {
      finish();
      return;
    }
    setStep(allSteps[i + 1]);
  }, [step, allSteps, finish]);
  const goPrev = useCallback(() => {
    const i = allSteps.indexOf(step);
    if (i <= 0) return;
    setStep(allSteps[i - 1]);
  }, [step, allSteps]);

  if (!open) return null;

  // Stage A — modal wizard.
  if (
    step === "welcome" ||
    step === "intro" ||
    step === "projects" ||
    step === "presets"
  ) {
    return (
      // No Escape binding on purpose: the only exit is "Skip onboarding", and a
      // stray Escape should never silently skip first-run setup.
      <div
        className="fixed inset-0 z-[60] bg-black/55 backdrop-blur-[3px] flex items-center justify-center p-6"
        role="dialog"
        aria-modal="true"
        aria-label="Welcome to Aura"
      >
        {step === "welcome" ? (
          <div className="w-[760px] max-w-full bg-bg-chrome rounded-lg border border-line-soft shadow-2xl overflow-hidden">
            <WelcomeHero onClose={finish} onContinue={goNext} />
          </div>
        ) : (
          <ModalShell
            title={modalTitleFor(step)}
            subtitle={modalSubtitleFor(step)}
            onClose={finish}
            onBack={goPrev}
            onNext={goNext}
            nextLabel={step === "presets" ? "Done" : "Next"}
          >
            {step === "intro" && <IntroPanel />}
            {step === "projects" && <ProjectsImportPanel />}
            {step === "presets" && (
              <PresetsImportPanel agent={agent} setAgent={setAgent} />
            )}
          </ModalShell>
        )}
      </div>
    );
  }

  // Stage B — fullscreen with top stepper.
  return (
    <FullscreenShell
      step={step}
      onBack={step === "providers" ? null : goPrev}
      onClose={finish}
    >
      {step === "providers" && (
        <ProvidersPanel
          choice={providerChoice}
          setChoice={setProviderChoice}
          onSkip={goNext}
          onContinueToCodex={goNext}
        />
      )}
      {step === "providers-codex" && (
        <ProvidersCodexPanel
          choice={codexChoice}
          setChoice={setCodexChoice}
          onSkip={goNext}
        />
      )}
      {step === "github" && <GitHubPanel onContinue={goNext} onSkip={goNext} />}
      {step === "permissions" && (
        <PermissionsPanel onContinue={goNext} onSkip={goNext} />
      )}
      {step === "project" && (
        <ProjectPanel onPicked={goNext} onSkip={goNext} />
      )}
      {step === "worktrees" && <WorktreesPanel onFinish={finish} />}
      {step === "done" && <DoneOverlay onFinish={finish} />}
    </FullscreenShell>
  );
}

// ─── Welcome hero (Stage A, step 0) ─────────────────────────────────────────
function WelcomeHero({
  onClose,
  onContinue,
}: {
  onClose: () => void;
  onContinue: () => void;
}) {
  return (
    <div className="flex flex-col">
      <div className="relative aspect-[16/9] overflow-hidden">
        {/* Solid near-black base. This panel is a fixed piece of artwork, not a
            themed surface — the black, the white title and the black vignettes
            below stay literal on purpose so the hero reads identically in every
            theme. The one thing that DOES follow the theme is the accent, so a
            retuned accent never contradicts the rest of the app. */}
        <div className="absolute inset-0 bg-[#050505]" />
        {/* Accent dot halftone, masked by a radial so dots only appear
            where the "light" hits — Superset-style. */}
        <div
          className="absolute inset-0"
          style={{
            backgroundImage:
              "radial-gradient(circle at center, var(--color-accent) 1.1px, transparent 1.35px)",
            backgroundSize: "5px 5px",
            WebkitMaskImage:
              "radial-gradient(ellipse 75% 65% at 58% 42%, black 0%, rgba(0,0,0,0.65) 38%, transparent 78%)",
            maskImage:
              "radial-gradient(ellipse 75% 65% at 58% 42%, black 0%, rgba(0,0,0,0.65) 38%, transparent 78%)",
          }}
        />
        {/* Soft glow on top of the dots for depth. */}
        <div
          className="absolute inset-0 pointer-events-none"
          style={{
            background:
              "radial-gradient(ellipse 45% 38% at 60% 38%, color-mix(in srgb, var(--color-accent) 22%, transparent), transparent 65%)",
          }}
        />
        {/* Vignette to keep title legible. */}
        <div
          className="absolute inset-0 pointer-events-none"
          style={{
            background:
              "radial-gradient(ellipse at center, transparent 35%, rgba(0,0,0,0.55) 100%)",
          }}
        />
        {/* Close */}
        <button
          type="button"
          onClick={onClose}
          aria-label="Skip onboarding"
          className="absolute top-3 right-3 w-7 h-7 rounded-full flex items-center justify-center text-white/80 hover:text-white hover:bg-white/10 transition-colors z-10"
        >
          <svg width="14" height="14" viewBox="0 0 16 16" fill="none">
            <path
              d="M3 3L13 13M13 3L3 13"
              stroke="currentColor"
              strokeWidth="1.6"
              strokeLinecap="round"
            />
          </svg>
        </button>
        {/* Title block — block letters, heavy display weight, tight tracking */}
        <div className="absolute inset-0 flex flex-col items-center justify-center text-center px-12">
          <h1
            style={{
              fontFamily:
                '"SF Pro Display", -apple-system, BlinkMacSystemFont, system-ui, sans-serif',
              fontWeight: 800,
              fontSize: "48px",
              letterSpacing: "0.04em",
              color: "#ffffff",
              textShadow: "0 2px 30px rgba(0,0,0,0.85)",
              lineHeight: 1.05,
            }}
          >
            WELCOME TO AURA
          </h1>
          <p
            style={{
              fontFamily: '"SF Pro Text", -apple-system, system-ui, sans-serif',
              fontSize: "14px",
              color: "#e5e5e5",
              maxWidth: "460px",
              marginTop: "14px",
              letterSpacing: "0.03em",
              textTransform: "uppercase",
              textShadow: "0 1px 12px rgba(0,0,0,0.8)",
            }}
          >
            Agentic Development Environment · Semantic version control over Git
          </p>
        </div>
      </div>
      <div className="h-[72px] px-6 flex items-center justify-end border-t border-line-soft bg-bg-chrome">
        <button
          type="button"
          onClick={onContinue}
          className="text-[13px] px-5 h-[36px] rounded-md bg-white text-black hover:bg-white/90 transition-colors font-semibold tracking-wide"
        >
          Get started
        </button>
      </div>
    </div>
  );
}

// ─── Modal shell (Stage A, steps 1–3) ───────────────────────────────────────
function modalTitleFor(step: Step): string {
  switch (step) {
    case "intro":
      return "Let's get you started";
    case "projects":
      return "Bring over your projects";
    case "presets":
      return "Bring over your terminal presets";
    default:
      return "";
  }
}
function modalSubtitleFor(step: Step): string {
  switch (step) {
    case "intro":
      return "";
    case "projects":
      return "Import each local folder into Aura. Already-imported folders show as Imported.";
    case "presets":
      return "Import each terminal-agent CLI into Aura.";
    default:
      return "";
  }
}

function ModalShell({
  title,
  subtitle,
  onClose,
  onBack,
  onNext,
  nextLabel,
  children,
}: {
  title: string;
  subtitle: string;
  onClose: () => void;
  onBack: () => void;
  onNext: () => void;
  nextLabel: string;
  children: React.ReactNode;
}) {
  const isIntro = !subtitle;
  return (
    <div className="w-[720px] max-w-full bg-bg-chrome rounded-lg border border-line-soft shadow-2xl overflow-hidden flex flex-col">
      {!isIntro && (
        <div className="px-5 pt-4 pb-3.5 flex items-start border-b border-line-soft">
          <div className="flex-1 min-w-0">
            <div className="text-[13.5px] font-semibold text-text-1">{title}</div>
            <div className="text-[11.5px] text-text-4 mt-0.5">{subtitle}</div>
          </div>
          <button
            type="button"
            className="w-6 h-6 rounded-full flex items-center justify-center text-text-4 hover:text-text-1 hover:bg-bg-2"
            title="Refresh"
            onClick={() => window.dispatchEvent(new CustomEvent("aura:onboarding-refresh"))}
          >
            <svg width="13" height="13" viewBox="0 0 16 16" fill="none">
              <path
                d="M14 8a6 6 0 1 1-1.76-4.24M14 3v3h-3"
                stroke="currentColor"
                strokeWidth="1.3"
                strokeLinecap="round"
                strokeLinejoin="round"
              />
            </svg>
          </button>
          <button
            type="button"
            className="w-6 h-6 rounded-full flex items-center justify-center text-text-4 hover:text-text-1 hover:bg-bg-2 ml-1"
            onClick={onClose}
            aria-label="Skip onboarding"
          >
            <svg width="12" height="12" viewBox="0 0 16 16" fill="none">
              <path d="M3 3L13 13M13 3L3 13" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
            </svg>
          </button>
        </div>
      )}
      <div className={`flex-1 ${isIntro ? "min-h-[420px] flex flex-col" : "min-h-[360px]"}`}>
        {isIntro && (
          <div className="px-5 pt-3 flex items-start justify-end">
            <button
              type="button"
              onClick={onClose}
              aria-label="Skip onboarding"
              className="w-6 h-6 rounded-full flex items-center justify-center text-text-4 hover:text-text-1 hover:bg-bg-2"
            >
              <svg width="12" height="12" viewBox="0 0 16 16" fill="none">
                <path d="M3 3L13 13M13 3L3 13" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
              </svg>
            </button>
          </div>
        )}
        {children}
      </div>
      <div className="h-[58px] px-5 flex items-center justify-between border-t border-line-soft">
        <button
          type="button"
          onClick={onBack}
          className="text-[12.5px] px-2 h-[30px] text-text-3 hover:text-text-1 transition-colors"
        >
          Back
        </button>
        <button
          type="button"
          onClick={onNext}
          className="text-[12.5px] px-4 h-[30px] rounded bg-white text-black hover:bg-white/90 transition-colors font-medium"
        >
          {nextLabel}
        </button>
      </div>
    </div>
  );
}

// ─── Intro panel ────────────────────────────────────────────────────────────
function IntroPanel() {
  return (
    <div className="flex-1 flex flex-col items-center justify-center text-center px-12">
      <h2
        className="text-text-1"
        style={{
          fontFamily:
            '"SF Pro Display", -apple-system, BlinkMacSystemFont, system-ui, sans-serif',
          fontWeight: 700,
          fontSize: "28px",
          letterSpacing: "-0.01em",
        }}
      >
        Let's get you started
      </h2>
      <p className="text-[12.5px] text-text-3 mt-3 max-w-[420px] leading-relaxed">
        We'll port over your projects and terminal-agent CLIs, then connect an
        AI provider so Claude / Codex / Gemini run inside Aura's panes. Anything
        you skip is reachable later from Settings.
      </p>
    </div>
  );
}

// ─── Projects import ────────────────────────────────────────────────────────
function ProjectsImportPanel() {
  const [recents, setRecents] = useState<string[]>([]);
  const [imported, setImported] = useState<Set<string>>(new Set());
  useEffect(() => {
    try {
      const raw = localStorage.getItem("aura.recents");
      if (raw) {
        const parsed = JSON.parse(raw);
        if (Array.isArray(parsed)) setRecents(parsed.filter((p) => typeof p === "string"));
      }
    } catch {
      /* ignore */
    }
  }, []);
  const pickFolder = useCallback(() => {
    window.dispatchEvent(new CustomEvent("aura:open-repo-picker"));
  }, []);
  return (
    <div className="px-5 py-3">
      {recents.length === 0 ? (
        <div className="py-10 text-center">
          <div className="text-[12.5px] text-text-3 mb-3">
            No previously-opened repos found.
          </div>
          <button
            type="button"
            onClick={pickFolder}
            className="text-[12px] px-3 h-[30px] rounded border border-line-soft bg-bg-2 text-text-1 hover:bg-bg-3"
          >
            Pick a folder…
          </button>
        </div>
      ) : (
        <div className="space-y-1">
          {recents.map((root) => {
            const name = root.split("/").filter(Boolean).pop() ?? root;
            const isImported = imported.has(root);
            return (
              <div
                key={root}
                className="flex items-center gap-3 px-3 py-2.5 rounded hover:bg-bg-2/60"
              >
                <svg width="16" height="16" viewBox="0 0 16 16" fill="none" className="text-text-3">
                  <path
                    d="M1.5 4.5h4l1.5 1.5h7v7.5a1 1 0 0 1-1 1H2.5a1 1 0 0 1-1-1V4.5z"
                    stroke="currentColor"
                    strokeWidth="1.2"
                    strokeLinejoin="round"
                  />
                </svg>
                <div className="flex-1 min-w-0">
                  <div className="text-[12.5px] text-text-1 font-medium truncate">{name}</div>
                  <div className="text-[10.5px] text-text-4 font-mono truncate">{root}</div>
                </div>
                <button
                  type="button"
                  onClick={() =>
                    setImported((prev) => {
                      const n = new Set(prev);
                      n.add(root);
                      return n;
                    })
                  }
                  disabled={isImported}
                  className={`text-[11.5px] px-3 h-[28px] rounded border transition-colors ${
                    isImported
                      ? "border-line-soft bg-transparent text-text-4 cursor-default"
                      : "border-line-soft bg-bg-2 text-text-1 hover:bg-bg-3"
                  }`}
                >
                  {isImported ? "Imported" : "Import"}
                </button>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

// ─── Terminal presets ───────────────────────────────────────────────────────
function PresetsImportPanel({
  agent,
  setAgent,
}: {
  agent: AgentId;
  setAgent: (a: AgentId) => void;
}) {
  const [imported, setImported] = useState<Set<AgentId>>(new Set());
  const [installed, setInstalled] = useState<Record<AgentId, boolean | null>>({
    claude: null,
    amp: null,
    codex: null,
    gemini: null,
    copilot: null,
  });
  // Detect each CLI. `copilot` is `gh copilot` so we check `gh`.
  useEffect(() => {
    const probes: { id: AgentId; bin: string }[] = [
      { id: "claude", bin: "claude" },
      { id: "amp", bin: "amp" },
      { id: "codex", bin: "codex" },
      { id: "gemini", bin: "gemini" },
      { id: "copilot", bin: "gh" },
    ];
    let cancelled = false;
    Promise.all(
      probes.map((p) =>
        api.cliDetect(p.bin).then((r) => ({ id: p.id, ok: r.installed })),
      ),
    ).then((rows) => {
      if (cancelled) return;
      const next: Record<AgentId, boolean | null> = {
        claude: false,
        amp: false,
        codex: false,
        gemini: false,
        copilot: false,
      };
      rows.forEach((r) => {
        next[r.id] = r.ok;
      });
      setInstalled(next);
    });
    return () => {
      cancelled = true;
    };
  }, []);
  const presets: { id: AgentId; name: string; desc: string }[] = [
    {
      id: "claude",
      name: "Claude",
      desc: "Anthropic's coding agent for reading code, editing files, and running terminal workflows.",
    },
    {
      id: "amp",
      name: "Amp",
      desc: "Amp's coding agent for terminal-first coding, subagents, and task work.",
    },
    {
      id: "codex",
      name: "Codex",
      desc: "OpenAI's coding agent for reading, modifying, and running code across tasks.",
    },
    {
      id: "gemini",
      name: "Gemini",
      desc: "Google's open-source terminal agent for coding, problem-solving, and task work.",
    },
    {
      id: "copilot",
      name: "Copilot",
      desc: "GitHub's coding agent for planning, editing, and building in your repo.",
    },
  ];
  return (
    <div className="px-2 py-1">
      <div className="space-y-1">
        {presets.map((p) => {
          const isImported = imported.has(p.id);
          const here = installed[p.id];
          return (
            <div
              key={p.id}
              className="flex items-center gap-3 px-3 py-2.5 rounded hover:bg-bg-2/60"
            >
              <PromptGlyph />
              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-2">
                  <span className="text-[12.5px] text-text-1 font-medium">{p.name}</span>
                  {here === false && (
                    <span className="text-[9.5px] uppercase tracking-wider text-text-5">
                      Not on PATH
                    </span>
                  )}
                </div>
                <div className="text-[11px] text-text-4 leading-snug">{p.desc}</div>
              </div>
              <button
                type="button"
                onClick={() => {
                  setImported((prev) => {
                    const n = new Set(prev);
                    n.add(p.id);
                    return n;
                  });
                  setAgent(p.id);
                }}
                disabled={isImported || here === false}
                className={`text-[11.5px] px-3 h-[28px] rounded border transition-colors ${
                  isImported || here === false
                    ? "border-line-soft bg-transparent text-text-4 cursor-default"
                    : "border-line-soft bg-bg-2 text-text-1 hover:bg-bg-3"
                }`}
                title={here === false ? "Install this CLI on PATH first" : undefined}
              >
                {isImported ? "Imported" : "Import"}
              </button>
            </div>
          );
        })}
      </div>
      {agent && (
        <div className="px-3 pt-3 text-[10.5px] text-text-5">
          Default agent: <span className="text-text-3">{agent}</span> (change later from the rail)
        </div>
      )}
    </div>
  );
}

function PromptGlyph() {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" className="text-text-3 shrink-0">
      <rect x="2" y="4" width="20" height="16" rx="3" stroke="currentColor" strokeWidth="1.3" />
      <path d="M6 9l3 3-3 3M12 15h6" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

// ─── Fullscreen shell (Stage B) ─────────────────────────────────────────────
function FullscreenShell({
  step,
  onBack,
  onClose,
  children,
}: {
  step: Step;
  onBack: (() => void) | null;
  onClose: () => void;
  children: React.ReactNode;
}) {
  const activeIdx = stepperIndex(step);
  return (
    <div
      className="fixed inset-0 z-[60] bg-bg-0 flex flex-col"
      role="dialog"
      aria-modal="true"
      aria-label="Set up Aura"
    >
      {/* Top bar: Back left, stepper centered, Close right */}
      <div className="h-14 px-6 flex items-center border-b border-line-soft/40">
        <div className="w-24 flex items-center">
          {onBack && (
            <button
              type="button"
              onClick={onBack}
              className="text-[12.5px] text-text-3 hover:text-text-1 flex items-center gap-1.5"
            >
              <svg width="13" height="13" viewBox="0 0 16 16" fill="none">
                <path d="M10 3L5 8l5 5" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" />
              </svg>
              Back
            </button>
          )}
        </div>
        <div className="flex-1 flex items-center justify-center gap-0">
          {STEPPER.map((s, i) => {
            const isActive = i === activeIdx;
            const isDone = i < activeIdx;
            return (
              <div key={s.label} className="flex items-center">
                <div
                  className={`flex items-center gap-1.5 px-2.5 h-[26px] rounded-full text-[11.5px] ${
                    isActive
                      ? "bg-bg-2 text-text-1 border border-line-soft"
                      : "text-text-4"
                  }`}
                >
                  {isDone ? (
                    <svg width="11" height="11" viewBox="0 0 16 16" fill="none">
                      <path d="M3 8l3.5 3.5L13 4.5" stroke="var(--color-accent-green)" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
                    </svg>
                  ) : (
                    <span className={`font-mono ${isActive ? "text-text-2" : "text-text-5"}`}>
                      {i + 1}
                    </span>
                  )}
                  <span>{s.label}</span>
                </div>
                {i < STEPPER.length - 1 && (
                  <span className="w-7 h-px bg-line-soft mx-1" />
                )}
              </div>
            );
          })}
        </div>
        <div className="w-24 flex items-center justify-end">
          <button
            type="button"
            onClick={onClose}
            className="w-7 h-7 rounded-full flex items-center justify-center text-text-4 hover:text-text-1 hover:bg-bg-2"
            aria-label="Close onboarding"
          >
            <svg width="13" height="13" viewBox="0 0 16 16" fill="none">
              <path d="M3 3L13 13M13 3L3 13" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
            </svg>
          </button>
        </div>
      </div>
      <div className="flex-1 overflow-auto">{children}</div>
    </div>
  );
}

function stepperIndex(step: Step): number {
  switch (step) {
    case "providers":
    case "providers-codex":
      return 0;
    case "github":
      return 1;
    case "permissions":
      return 2;
    case "project":
      return 3;
    case "worktrees":
      return 4;
    default:
      return 0;
  }
}

// ─── Providers (Claude) ─────────────────────────────────────────────────────
//
// Each provider panel owns its own connect logic and polls the agent CLI's
// reported auth state. The "Connect" affordance spawns the CLI's native
// login subprocess (which opens the OAuth browser flow against claude.ai /
// chatgpt.com directly) and re-polls once the subprocess exits.

type ClaudeStatus = Awaited<ReturnType<typeof api.claudeAuthStatus>>;
type CodexStatus = Awaited<ReturnType<typeof api.codexAuthStatus>>;
type ConnectStage =
  | { kind: "idle" }
  | { kind: "running" }
  | { kind: "error"; message: string };

function ProvidersPanel({
  choice,
  setChoice,
  onSkip,
  onContinueToCodex,
}: {
  choice: ProviderChoice;
  setChoice: (c: ProviderChoice) => void;
  onSkip: () => void;
  onContinueToCodex: () => void;
}) {
  const [status, setStatus] = useState<ClaudeStatus | null>(null);
  const [stage, setStage] = useState<ConnectStage>({ kind: "idle" });
  const [apiKey, setApiKey] = useState("");
  const [customBase, setCustomBase] = useState(
    () => localStorage.getItem("aura.claudeCustom.baseUrl") ?? "",
  );
  const [customModel, setCustomModel] = useState(
    () => localStorage.getItem("aura.claudeCustom.model") ?? "",
  );
  const [cliMissing, setCliMissing] = useState(false);

  const refresh = useCallback(async () => {
    try {
      const s = await api.claudeAuthStatus();
      setStatus(s);
      setCliMissing(false);
    } catch (e) {
      setCliMissing(String(e).includes("not on PATH"));
      setStatus(null);
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const connectPro = useCallback(async () => {
    setStage({ kind: "running" });
    try {
      await api.claudeAuthLogin("claudeai");
      await refresh();
      setStage({ kind: "idle" });
    } catch (e) {
      setStage({ kind: "error", message: String(e) });
    }
  }, [refresh]);

  const saveApiKey = useCallback(async () => {
    if (!apiKey.trim()) return;
    setStage({ kind: "running" });
    try {
      await api.settingsSetProviderKey("anthropic", apiKey.trim());
      setApiKey("");
      setStage({ kind: "idle" });
      await refresh();
    } catch (e) {
      setStage({ kind: "error", message: String(e) });
    }
  }, [apiKey, refresh]);

  const saveCustom = useCallback(() => {
    try {
      localStorage.setItem("aura.claudeCustom.baseUrl", customBase.trim());
      localStorage.setItem("aura.claudeCustom.model", customModel.trim());
    } catch {
      /* private mode */
    }
    setStage({ kind: "idle" });
  }, [customBase, customModel]);

  const logout = useCallback(async () => {
    try {
      await api.claudeAuthLogout();
    } catch {
      /* ignore */
    }
    await refresh();
  }, [refresh]);

  return (
    <div className="min-h-full flex items-center justify-center py-12 px-6">
      <div className="w-[520px] max-w-full">
        <div className="text-center mb-7">
          <div className="text-[14px] font-semibold text-text-1">Connect AI Provider</div>
          <div className="text-[12px] text-text-3 mt-1">
            Connect Claude Code, Codex, or both to get started.
          </div>
        </div>

        <div className="text-[10.5px] uppercase tracking-wider text-text-5 mb-2">
          Claude Code
        </div>

        {cliMissing ? (
          <CliMissingHint
            name="claude"
            installHint="npm install -g @anthropic-ai/claude-code"
          />
        ) : status?.logged_in ? (
          <ConnectedBadge
            primary={
              status.email
                ? `Connected as ${status.email}`
                : "Connected to Claude Code"
            }
            secondary={[
              status.subscription_type ? `Plan: ${status.subscription_type}` : null,
              status.org_name ? `Org: ${status.org_name}` : null,
              status.auth_method ? `Auth: ${status.auth_method}` : null,
            ]
              .filter(Boolean)
              .join(" · ")}
            onLogout={logout}
          />
        ) : (
          <>
            <div className="space-y-2">
              <ProviderRow
                selected={choice === "claude-pro"}
                onSelect={() => setChoice("claude-pro")}
                icon={<ClaudeGlyph />}
                title="Claude Pro/Max"
                subtitle="Use your Claude subscription. Opens claude.ai in your browser."
                badge="Recommended"
              />
              <ProviderRow
                selected={choice === "claude-api"}
                onSelect={() => setChoice("claude-api")}
                icon={<KeyGlyph />}
                title="Anthropic API Key"
                subtitle="Pay-as-you-go via the Anthropic Console."
              />
              <ProviderRow
                selected={choice === "claude-custom"}
                onSelect={() => setChoice("claude-custom")}
                icon={<GearGlyph />}
                title="Custom Model"
                subtitle="Use a custom base URL and model name."
              />
            </div>

            {choice === "claude-pro" && (
              <div className="flex flex-col items-center gap-2 mt-6">
                <button
                  type="button"
                  onClick={connectPro}
                  disabled={stage.kind === "running"}
                  className="w-[260px] h-[34px] rounded bg-white/95 text-black text-[12.5px] font-medium hover:bg-white disabled:opacity-60"
                >
                  {stage.kind === "running"
                    ? "Waiting for browser…"
                    : "Sign in with claude.ai"}
                </button>
                <p className="text-[10.5px] text-text-5 text-center max-w-[300px]">
                  Opens the Claude Code CLI's native sign-in. A browser window
                  will pop up against claude.ai.
                </p>
              </div>
            )}

            {choice === "claude-api" && (
              <div className="mt-6">
                <label className="block text-[11px] text-text-3 mb-1.5">
                  Anthropic API Key
                </label>
                <Input
                  type="password"
                  value={apiKey}
                  onChange={(e) => setApiKey(e.target.value)}
                  placeholder="sk-ant-…"
                  className="w-full"
                />
                <p className="text-[10.5px] text-text-5 mt-1.5">
                  Stored locally at <code>~/.aura/anthropic_api_key</code> (0600).
                  Aura injects it as <code>ANTHROPIC_API_KEY</code> on every Claude
                  Code spawn.
                </p>
                <button
                  type="button"
                  onClick={() => openUrl("https://console.anthropic.com/settings/keys")}
                  className="text-[11px] text-accent hover:underline mt-1"
                >
                  Get a key at console.anthropic.com →
                </button>
                <div className="mt-4 flex justify-center">
                  <button
                    type="button"
                    onClick={saveApiKey}
                    disabled={!apiKey.trim() || stage.kind === "running"}
                    className="w-[260px] h-[34px] rounded bg-white/95 text-black text-[12.5px] font-medium hover:bg-white disabled:opacity-50"
                  >
                    Save API Key
                  </button>
                </div>
              </div>
            )}

            {choice === "claude-custom" && (
              <div className="mt-6 space-y-3">
                <div>
                  <label className="block text-[11px] text-text-3 mb-1.5">
                    Base URL
                  </label>
                  <Input
                    type="text"
                    value={customBase}
                    onChange={(e) => setCustomBase(e.target.value)}
                    placeholder="https://api.example.com/v1"
                    className="w-full"
                  />
                </div>
                <div>
                  <label className="block text-[11px] text-text-3 mb-1.5">
                    Model
                  </label>
                  <Input
                    type="text"
                    value={customModel}
                    onChange={(e) => setCustomModel(e.target.value)}
                    placeholder="claude-opus-4-7"
                    className="w-full"
                  />
                </div>
                <div className="flex justify-center pt-1">
                  <button
                    type="button"
                    onClick={saveCustom}
                    disabled={!customBase.trim() || !customModel.trim()}
                    className="w-[260px] h-[34px] rounded bg-white/95 text-black text-[12.5px] font-medium hover:bg-white disabled:opacity-50"
                  >
                    Save Custom Provider
                  </button>
                </div>
              </div>
            )}

            {stage.kind === "error" && (
              <p className="text-[11px] text-red text-center mt-3">
                {stage.message}
              </p>
            )}
          </>
        )}

        <div className="flex flex-col items-center gap-2 mt-7">
          <button
            type="button"
            onClick={onContinueToCodex}
            className="text-[12px] text-text-2 hover:text-text-1"
          >
            {status?.logged_in ? "Continue to Codex" : "Set up Codex instead"}
          </button>
          <button
            type="button"
            onClick={onSkip}
            className="text-[12px] text-text-4 hover:text-text-2"
          >
            Skip for now
          </button>
        </div>
      </div>
    </div>
  );
}

function ProvidersCodexPanel({
  choice,
  setChoice,
  onSkip,
}: {
  choice: CodexChoice;
  setChoice: (c: CodexChoice) => void;
  onSkip: () => void;
}) {
  const [status, setStatus] = useState<CodexStatus | null>(null);
  const [stage, setStage] = useState<ConnectStage>({ kind: "idle" });
  const [apiKey, setApiKey] = useState("");
  const [customBase, setCustomBase] = useState(
    () => localStorage.getItem("aura.codexCustom.baseUrl") ?? "",
  );
  const [customModel, setCustomModel] = useState(
    () => localStorage.getItem("aura.codexCustom.model") ?? "",
  );
  const [cliMissing, setCliMissing] = useState(false);

  const refresh = useCallback(async () => {
    try {
      const s = await api.codexAuthStatus();
      setStatus(s);
      // The backend now reports "broken" (on PATH but won't run) and
      // "missing" as states rather than throwing, so treat both as
      // needing the install hint instead of only the legacy throw.
      setCliMissing(s.state === "broken" || s.state === "missing");
    } catch (e) {
      setCliMissing(String(e).includes("not on PATH"));
      setStatus(null);
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const connectPro = useCallback(async () => {
    setStage({ kind: "running" });
    try {
      await api.codexAuthLogin();
      await refresh();
      setStage({ kind: "idle" });
    } catch (e) {
      setStage({ kind: "error", message: String(e) });
    }
  }, [refresh]);

  const saveApiKey = useCallback(async () => {
    if (!apiKey.trim()) return;
    setStage({ kind: "running" });
    try {
      await api.codexAuthLoginApiKey(apiKey.trim());
      setApiKey("");
      setStage({ kind: "idle" });
      await refresh();
    } catch (e) {
      setStage({ kind: "error", message: String(e) });
    }
  }, [apiKey, refresh]);

  const saveCustom = useCallback(() => {
    try {
      localStorage.setItem("aura.codexCustom.baseUrl", customBase.trim());
      localStorage.setItem("aura.codexCustom.model", customModel.trim());
    } catch {
      /* private mode */
    }
    setStage({ kind: "idle" });
  }, [customBase, customModel]);

  return (
    <div className="min-h-full flex items-center justify-center py-12 px-6">
      <div className="w-[520px] max-w-full">
        <div className="text-center mb-7">
          <div className="text-[14px] font-semibold text-text-1">Connect AI Provider</div>
          <div className="text-[12px] text-text-3 mt-1">
            Add another provider or continue to the next step.
          </div>
        </div>

        <div className="text-[10.5px] uppercase tracking-wider text-text-5 mb-2">
          Codex
        </div>

        {cliMissing ? (
          <CliMissingHint
            name="codex"
            installHint="npm install -g @openai/codex"
          />
        ) : status?.logged_in ? (
          <ConnectedBadge
            primary={
              status.method
                ? `Connected via ${status.method}`
                : "Connected to Codex"
            }
            secondary=""
          />
        ) : (
          <>
            <div className="space-y-2">
              <ProviderRow
                selected={choice === "codex-pro"}
                onSelect={() => setChoice("codex-pro")}
                icon={<OpenAIGlyph />}
                title="ChatGPT Plus/Pro"
                subtitle="Sign in with chatgpt.com via the Codex CLI."
                badge="Recommended"
              />
              <ProviderRow
                selected={choice === "codex-api"}
                onSelect={() => setChoice("codex-api")}
                icon={<KeyGlyph />}
                title="OpenAI API Key"
                subtitle="Pay-as-you-go with your own API key."
              />
              <ProviderRow
                selected={choice === "codex-custom"}
                onSelect={() => setChoice("codex-custom")}
                icon={<GearGlyph />}
                title="Custom Model"
                subtitle="Use a custom base URL and model name."
              />
            </div>

            {choice === "codex-pro" && (
              <div className="flex flex-col items-center gap-2 mt-6">
                <button
                  type="button"
                  onClick={connectPro}
                  disabled={stage.kind === "running"}
                  className="w-[260px] h-[34px] rounded bg-white/95 text-black text-[12.5px] font-medium hover:bg-white disabled:opacity-60"
                >
                  {stage.kind === "running"
                    ? "Waiting for browser…"
                    : "Sign in with chatgpt.com"}
                </button>
                <p className="text-[10.5px] text-text-5 text-center max-w-[300px]">
                  Opens the Codex CLI's native sign-in.
                </p>
              </div>
            )}

            {choice === "codex-api" && (
              <div className="mt-6">
                <label className="block text-[11px] text-text-3 mb-1.5">
                  OpenAI API Key
                </label>
                <Input
                  type="password"
                  value={apiKey}
                  onChange={(e) => setApiKey(e.target.value)}
                  placeholder="sk-…"
                  className="w-full"
                />
                <p className="text-[10.5px] text-text-5 mt-1.5">
                  Piped to <code>codex login --with-api-key</code>; never logged.
                </p>
                <button
                  type="button"
                  onClick={() => openUrl("https://platform.openai.com/api-keys")}
                  className="text-[11px] text-accent hover:underline mt-1"
                >
                  Get a key at platform.openai.com →
                </button>
                <div className="mt-4 flex justify-center">
                  <button
                    type="button"
                    onClick={saveApiKey}
                    disabled={!apiKey.trim() || stage.kind === "running"}
                    className="w-[260px] h-[34px] rounded bg-white/95 text-black text-[12.5px] font-medium hover:bg-white disabled:opacity-50"
                  >
                    Save API Key
                  </button>
                </div>
              </div>
            )}

            {choice === "codex-custom" && (
              <div className="mt-6 space-y-3">
                <div>
                  <label className="block text-[11px] text-text-3 mb-1.5">
                    Base URL
                  </label>
                  <Input
                    type="text"
                    value={customBase}
                    onChange={(e) => setCustomBase(e.target.value)}
                    placeholder="https://api.example.com/v1"
                    className="w-full"
                  />
                </div>
                <div>
                  <label className="block text-[11px] text-text-3 mb-1.5">
                    Model
                  </label>
                  <Input
                    type="text"
                    value={customModel}
                    onChange={(e) => setCustomModel(e.target.value)}
                    placeholder="gpt-5"
                    className="w-full"
                  />
                </div>
                <div className="flex justify-center pt-1">
                  <button
                    type="button"
                    onClick={saveCustom}
                    disabled={!customBase.trim() || !customModel.trim()}
                    className="w-[260px] h-[34px] rounded bg-white/95 text-black text-[12.5px] font-medium hover:bg-white disabled:opacity-50"
                  >
                    Save Custom Provider
                  </button>
                </div>
              </div>
            )}

            {stage.kind === "error" && (
              <p className="text-[11px] text-red text-center mt-3">
                {stage.message}
              </p>
            )}
          </>
        )}

        <div className="flex flex-col items-center gap-2 mt-7">
          <button
            type="button"
            onClick={onSkip}
            className="text-[12px] text-text-4 hover:text-text-2"
          >
            {status?.logged_in ? "Continue" : "Skip for now"}
          </button>
        </div>
      </div>
    </div>
  );
}

function ConnectedBadge({
  primary,
  secondary,
  onLogout,
}: {
  primary: string;
  secondary?: string;
  onLogout?: () => void;
}) {
  return (
    <div className="w-full bg-bg-2 border border-line-soft rounded-md p-4 flex flex-col items-center gap-1.5">
      <div className="flex items-center gap-2 text-[12.5px] text-text-1 font-medium">
        <svg width="14" height="14" viewBox="0 0 16 16" fill="none">
          <path
            d="M3 8.5l3 3 7-7"
            stroke="var(--color-accent-green)"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        </svg>
        {primary}
      </div>
      {secondary ? (
        <div className="text-[11px] text-text-4">{secondary}</div>
      ) : null}
      {onLogout ? (
        <button
          type="button"
          onClick={onLogout}
          className="text-[11px] text-text-5 hover:text-text-2 mt-1"
        >
          Sign out
        </button>
      ) : null}
    </div>
  );
}

function CliMissingHint({
  name,
  installHint,
}: {
  name: string;
  installHint: string;
}) {
  return (
    <div className="w-full bg-bg-2 border border-line-soft rounded-md p-4">
      <div className="text-[12.5px] text-text-1 font-medium">
        {name} CLI not found on PATH
      </div>
      <div className="text-[11px] text-text-4 mt-1">
        Aura uses the official CLI for auth. Install it and reopen onboarding:
      </div>
      <code className="block mt-2 text-[11.5px] font-mono text-accent">
        {installHint}
      </code>
    </div>
  );
}

function ProviderRow({
  selected,
  onSelect,
  icon,
  title,
  subtitle,
  badge,
}: {
  selected: boolean;
  onSelect: () => void;
  icon: React.ReactNode;
  title: string;
  subtitle: string;
  badge?: string;
}) {
  return (
    <button
      type="button"
      onClick={onSelect}
      className={`w-full flex items-center gap-3 px-3.5 py-3 rounded-md border text-left transition-colors ${
        selected
          ? "border-accent bg-accent/10"
          : "border-line-soft bg-bg-2/60 hover:bg-bg-2"
      }`}
    >
      <div className="w-9 h-9 rounded-md bg-bg-3/70 flex items-center justify-center shrink-0">
        {icon}
      </div>
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-2">
          <span className="text-[12.5px] font-medium text-text-1">{title}</span>
          {badge && (
            <span className="text-[10px] px-1.5 py-0.5 rounded bg-bg-3 text-text-3">
              {badge}
            </span>
          )}
        </div>
        <div className="text-[11px] text-text-4 mt-0.5">{subtitle}</div>
      </div>
      {selected && (
        <div className="w-5 h-5 rounded-full bg-accent flex items-center justify-center shrink-0">
          <svg width="11" height="11" viewBox="0 0 16 16" fill="none">
            <path d="M3 8l3.5 3.5L13 4.5" stroke="white" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
        </div>
      )}
    </button>
  );
}

function ClaudeGlyph() {
  return (
    <div className="w-7 h-7 rounded bg-caret-orange flex items-center justify-center">
      <svg width="16" height="16" viewBox="0 0 24 24" fill="none">
        <path d="M12 2v20M2 12h20M5 5l14 14M19 5L5 19" stroke="white" strokeWidth="2" strokeLinecap="round" />
      </svg>
    </div>
  );
}
function OpenAIGlyph() {
  return (
    <div className="w-7 h-7 rounded bg-white/90 flex items-center justify-center">
      <svg width="14" height="14" viewBox="0 0 24 24" fill="#000">
        <path d="M22.28 9.82a5.95 5.95 0 0 0-.52-4.93 6 6 0 0 0-6.47-2.87A6 6 0 0 0 4.93 4.93a6 6 0 0 0-4.02 2.9 6.02 6.02 0 0 0 .75 7.05A5.95 5.95 0 0 0 2.18 19.8a6 6 0 0 0 6.47 2.87A6 6 0 0 0 13.07 24a6 6 0 0 0 5.71-4.17 5.97 5.97 0 0 0 3.98-2.91 6 6 0 0 0-.48-7.1zM13.07 22.5a4.46 4.46 0 0 1-2.86-1.04l.14-.08 4.74-2.74a.78.78 0 0 0 .39-.67v-6.69l2 1.16v5.55a4.5 4.5 0 0 1-4.4 4.51zM3.46 18.3a4.45 4.45 0 0 1-.54-3l.14.08L7.8 18.13a.77.77 0 0 0 .78 0l5.79-3.34v2.31a.07.07 0 0 1-.03.06l-4.8 2.77a4.5 4.5 0 0 1-6.08-1.64zM2.23 8.92a4.5 4.5 0 0 1 2.34-1.97v5.66a.77.77 0 0 0 .39.67l5.78 3.33-2 1.16-4.79-2.77a4.51 4.51 0 0 1-1.72-6.08zm16.45 3.83-5.79-3.34 2-1.15 4.78 2.76a4.5 4.5 0 0 1-.69 8.05v-5.65a.78.78 0 0 0-.3-.67zm1.99-2.97-.13-.08-4.74-2.74a.77.77 0 0 0-.78 0L8.99 10.3V7.99a.07.07 0 0 1 .03-.06l4.79-2.76a4.5 4.5 0 0 1 6.69 4.66l-.83-.05z" />
      </svg>
    </div>
  );
}
function KeyGlyph() {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" className="text-text-2">
      <circle cx="8" cy="15" r="4" stroke="currentColor" strokeWidth="1.5" />
      <path d="M11 12l9-9m-3 3l2 2m-4-2l2 2" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
    </svg>
  );
}
function GearGlyph() {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" className="text-text-2">
      <circle cx="12" cy="12" r="3" stroke="currentColor" strokeWidth="1.5" />
      <path
        d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 1 1-4 0v-.09a1.65 1.65 0 0 0-1-1.51 1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 1 1 0-4h.09a1.65 1.65 0 0 0 1.51-1 1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33h0a1.65 1.65 0 0 0 1-1.51V3a2 2 0 1 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82v0a1.65 1.65 0 0 0 1.51 1H21a2 2 0 1 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"
        stroke="currentColor"
        strokeWidth="1.3"
      />
    </svg>
  );
}

// ─── GitHub CLI ─────────────────────────────────────────────────────────────
function GitHubPanel({
  onContinue,
  onSkip,
}: {
  onContinue: () => void;
  onSkip: () => void;
}) {
  const [state, setState] = useState<
    | { kind: "loading" }
    | { kind: "installed"; version: string; location: string }
    | { kind: "missing" }
  >({ kind: "loading" });
  useEffect(() => {
    let cancelled = false;
    api.cliDetect("gh").then((r) => {
      if (cancelled) return;
      if (r.installed && r.path) {
        setState({
          kind: "installed",
          version: r.version ?? "gh (unknown version)",
          location: r.path,
        });
      } else {
        setState({ kind: "missing" });
      }
    });
    return () => {
      cancelled = true;
    };
  }, []);
  const isInstalled = state.kind === "installed";
  return (
    <div className="min-h-full flex items-center justify-center py-12 px-6">
      <div className="w-[460px] max-w-full text-center">
        <div className="relative inline-block">
          <div className="w-14 h-14 rounded-md bg-white flex items-center justify-center mx-auto">
            <svg width="28" height="28" viewBox="0 0 16 16" fill="#000">
              <path d="M8 0C3.58 0 0 3.58 0 8a8 8 0 0 0 5.47 7.59c.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.012 8.012 0 0 0 16 8c0-4.42-3.58-8-8-8z" />
            </svg>
          </div>
          {isInstalled && (
            <div className="absolute -bottom-1 -right-1 w-5 h-5 rounded-full bg-accent-green flex items-center justify-center border-2 border-bg-1">
              <svg width="11" height="11" viewBox="0 0 16 16" fill="none">
                <path d="M3 8l3.5 3.5L13 4.5" stroke="white" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
              </svg>
            </div>
          )}
        </div>
        <div className="mt-4 text-[14px] font-semibold text-text-1">
          {state.kind === "loading"
            ? "Checking GitHub CLI…"
            : isInstalled
              ? "GitHub CLI is installed"
              : "GitHub CLI not found"}
        </div>
        <div className="text-[12px] text-text-3 mt-1">
          {isInstalled
            ? "You're ready to check out PRs and manage issues from Aura."
            : "Install gh to check out PRs and manage issues from Aura."}
        </div>
        {state.kind === "installed" && (
          <div className="mt-5 bg-bg-2 border border-line-soft rounded-md text-left overflow-hidden">
            <div className="flex items-center px-4 py-2.5 border-b border-line-soft">
              <span className="text-[10.5px] uppercase tracking-wider text-text-5">Version</span>
              <span className="flex-1 text-right text-[12px] font-mono text-text-1">{state.version}</span>
            </div>
            <div className="flex items-center px-4 py-2.5">
              <span className="text-[10.5px] uppercase tracking-wider text-text-5">Location</span>
              <span className="flex-1 text-right text-[12px] font-mono text-text-2">{state.location}</span>
            </div>
          </div>
        )}
        <div className="mt-7 flex flex-col items-center gap-2">
          {state.kind === "missing" && (
            <button
              type="button"
              onClick={() => openUrl("https://cli.github.com")}
              className="w-[260px] h-[34px] rounded bg-white/95 text-black text-[12.5px] font-medium hover:bg-white"
            >
              Install GitHub CLI
            </button>
          )}
          {isInstalled && (
            <button
              type="button"
              onClick={onContinue}
              className="w-[260px] h-[34px] rounded bg-white/95 text-black text-[12.5px] font-medium hover:bg-white"
            >
              Continue
            </button>
          )}
          <button
            type="button"
            onClick={onSkip}
            className="text-[12px] text-text-4 hover:text-text-2"
          >
            Skip for now
          </button>
        </div>
      </div>
    </div>
  );
}

// ─── Permissions ────────────────────────────────────────────────────────────
function PermissionsPanel({
  onContinue,
  onSkip,
}: {
  onContinue: () => void;
  onSkip: () => void;
}) {
  const openSetting = (pane: string) => {
    void api.openMacosPrivacyPane(`Privacy_${pane}`);
  };
  return (
    <div className="min-h-full flex items-center justify-center py-12 px-6">
      <div className="w-[520px] max-w-full">
        <div className="text-center mb-6">
          <div className="text-[14px] font-semibold text-text-1">Grant macOS permissions</div>
          <div className="text-[12px] text-text-3 mt-1">
            Aura needs these to read your repos and drive your terminal.
          </div>
        </div>
        <div className="bg-bg-2/60 border border-line-soft rounded-md overflow-hidden">
          <div className="px-4 py-2 text-[10px] uppercase tracking-wider text-text-5 border-b border-line-soft">
            Required
          </div>
          <PermRow
            icon={<ShieldGlyph />}
            title="Full Disk Access"
            badge="REQUIRED"
            desc="Read your project files."
            onOpen={() => openSetting("AllFiles")}
          />
          <PermRow
            icon={<ShieldGlyph />}
            title="Accessibility"
            badge="REQUIRED"
            desc="Drive the terminal and editor on your behalf."
            onOpen={() => openSetting("Accessibility")}
          />
          <div className="px-4 py-2 text-[10px] uppercase tracking-wider text-text-5 border-y border-line-soft">
            Recommended
          </div>
          <PermRow
            icon={<ShieldGlyph />}
            title="Microphone"
            desc="Voice input in chat (optional)."
            onOpen={() => openSetting("Microphone")}
          />
        </div>
        <div className="mt-7 flex flex-col items-center gap-2">
          <button
            type="button"
            onClick={onContinue}
            className="w-[260px] h-[34px] rounded bg-white/95 text-black text-[12.5px] font-medium hover:bg-white"
          >
            Continue
          </button>
          <button
            type="button"
            onClick={onSkip}
            className="text-[12px] text-text-4 hover:text-text-2"
          >
            Skip for now
          </button>
        </div>
      </div>
    </div>
  );
}

function PermRow({
  icon,
  title,
  badge,
  desc,
  onOpen,
}: {
  icon: React.ReactNode;
  title: string;
  badge?: string;
  desc: string;
  onOpen: () => void;
}) {
  return (
    <div className="flex items-center gap-3 px-4 py-3 border-b border-line-soft last:border-b-0">
      <div className="w-7 h-7 rounded bg-bg-3/70 flex items-center justify-center shrink-0">
        {icon}
      </div>
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-2">
          <span className="text-[12.5px] font-medium text-text-1">{title}</span>
          {badge && (
            <span className="text-[9px] tracking-wider text-text-5">{badge}</span>
          )}
        </div>
        <div className="text-[11px] text-text-4 mt-0.5">{desc}</div>
      </div>
      <button
        type="button"
        onClick={onOpen}
        className="text-[11.5px] text-text-2 hover:text-text-1 flex items-center gap-1"
      >
        Open Settings
        <svg width="10" height="10" viewBox="0 0 16 16" fill="none">
          <path d="M4 4h8v8M4 12L12 4" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
        </svg>
      </button>
    </div>
  );
}

function ShieldGlyph() {
  return (
    <svg width="14" height="14" viewBox="0 0 16 16" fill="none" className="text-text-2">
      <path d="M8 1.5l5.5 2v4.25c0 3.07-2.34 5.96-5.5 6.75-3.16-.79-5.5-3.68-5.5-6.75V3.5L8 1.5z" stroke="currentColor" strokeWidth="1.2" />
    </svg>
  );
}

// ─── Project ────────────────────────────────────────────────────────────────
function ProjectPanel({
  onPicked,
  onSkip,
}: {
  onPicked: (path: string) => void;
  onSkip: () => void;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const pick = useCallback(async () => {
    setBusy(true);
    setError(null);
    try {
      const { pickPath } = await import("../lib/nativeDialog");
      const picked = await pickPath({ directory: true, multiple: false });
      if (typeof picked === "string" && picked) {
        window.dispatchEvent(
          new CustomEvent("aura:open-repo-picker-path", { detail: { path: picked } }),
        );
        onPicked(picked);
      }
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(false);
    }
  }, [onPicked]);
  return (
    <div className="min-h-full flex items-center justify-center py-12 px-6">
      <div className="text-center">
        <div className="w-14 h-14 rounded-md bg-bg-2 border border-line-soft mx-auto flex items-center justify-center">
          <svg width="22" height="22" viewBox="0 0 24 24" fill="none" className="text-text-2">
            <path d="M8 18l-4-3 4-3M16 6l4 3-4 3" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
        </div>
        <div className="mt-4 text-[14px] font-semibold text-text-1">Select a repository</div>
        <div className="text-[12px] text-text-3 mt-1">
          Choose a local folder to start working with
        </div>
        <div className="mt-6 flex flex-col items-center gap-2">
          <button
            type="button"
            onClick={pick}
            disabled={busy}
            className="w-[260px] h-[34px] rounded bg-white/95 text-black text-[12.5px] font-medium hover:bg-white disabled:opacity-60"
          >
            {busy ? "Opening…" : "Select new repo"}
          </button>
          <button
            type="button"
            onClick={onSkip}
            className="text-[12px] text-text-4 hover:text-text-2"
          >
            Skip for now
          </button>
          {error && (
            <p className="text-[11px] text-red mt-2">{error}</p>
          )}
        </div>
      </div>
    </div>
  );
}

// ─── Worktrees ──────────────────────────────────────────────────────────────
function WorktreesPanel({ onFinish }: { onFinish: () => void }) {
  return (
    <div className="min-h-full flex items-center justify-center py-12 px-6">
      <div className="w-[520px] max-w-full text-center">
        <div className="w-14 h-14 rounded-md bg-bg-2 border border-line-soft mx-auto flex items-center justify-center">
          <svg width="22" height="22" viewBox="0 0 24 24" fill="none" className="text-text-2">
            <circle cx="6" cy="6" r="2.5" stroke="currentColor" strokeWidth="1.4" />
            <circle cx="18" cy="6" r="2.5" stroke="currentColor" strokeWidth="1.4" />
            <circle cx="12" cy="18" r="2.5" stroke="currentColor" strokeWidth="1.4" />
            <path d="M6 8.5v4a2 2 0 0 0 2 2h8a2 2 0 0 0 2-2v-4" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
            <path d="M12 14.5v1" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
          </svg>
        </div>
        <div className="mt-4 text-[14px] font-semibold text-text-1">Enable parallel copies</div>
        <div className="text-[12px] text-text-3 mt-1">
          Run several AIs at once on the same project — each in its own
          copy, so their edits never step on each other.
        </div>
        <div className="mt-7 flex flex-col items-center gap-2">
          <button
            type="button"
            onClick={onFinish}
            className="w-[260px] h-[34px] rounded bg-white/95 text-black text-[12.5px] font-medium hover:bg-white"
          >
            Finish
          </button>
          <button
            type="button"
            onClick={onFinish}
            className="text-[12px] text-text-4 hover:text-text-2"
          >
            Skip for now
          </button>
        </div>
      </div>
    </div>
  );
}

function DoneOverlay({ onFinish }: { onFinish: () => void }) {
  useEffect(() => {
    const t = window.setTimeout(onFinish, 400);
    return () => window.clearTimeout(t);
  }, [onFinish]);
  return null;
}
