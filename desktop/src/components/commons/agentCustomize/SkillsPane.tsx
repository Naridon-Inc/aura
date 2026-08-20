// Skills pane — the real, named abilities your coding agents can already reach
// for. A skill is a packaged "/do-this" an agent runs on demand. We read them
// straight from where each agent keeps them on this machine (Claude's
// `~/.claude/skills`, Codex's prompts, Cursor's rules, plus the copies living
// in this project) so the list matches what your agents can actually do — no
// signed-plugin gate, no mockups. Grouped by the agent that owns them, with its
// brand mark, so it reads at a glance.
//
// Read-only on purpose: these files belong to each agent's own setup (the way
// the agent's CLI manages them). Aura surfaces them so you can see what's there
// and open the file; it doesn't pretend to toggle another tool's config.

import { useCallback, useEffect, useMemo, useState } from "react";
import { FileText, FolderGit2, RefreshCw, ScrollText, Zap } from "lucide-react";

import { api, type AgentSkill } from "../../../lib/api";
import { AgentIcon } from "../../agent/AgentIcon";
import { canonicalAgentId } from "../../../lib/agentIdentity";
import { Button } from "../../ui/button";
import {
  Card,
  CountPill,
  EmptyHint,
  PaneIntro,
  PaneScroll,
  PaneSpinner,
} from "./customizeShared";

// Small per-kind glyph + word so a non-engineer can tell a runnable skill from
// a saved prompt or an always-on rule without knowing the file layout.
const KIND_META: Record<
  AgentSkill["kind"],
  { icon: typeof Zap; word: string }
> = {
  skill: { icon: Zap, word: "Skill" },
  command: { icon: FileText, word: "Command" },
  rule: { icon: ScrollText, word: "Always-on rule" },
};

type Group = {
  agent: string;
  label: string;
  skills: AgentSkill[];
};

export function SkillsPane({ repoRoot }: { repoRoot: string }) {
  const [skills, setSkills] = useState<AgentSkill[]>([]);
  const [loading, setLoading] = useState(true);

  const load = useCallback(() => {
    let live = true;
    setLoading(true);
    api
      .agentSkillsList(repoRoot)
      .then((r) => live && setSkills(r))
      .catch(() => live && setSkills([]))
      .finally(() => live && setLoading(false));
    return () => {
      live = false;
    };
  }, [repoRoot]);

  useEffect(() => load(), [load]);

  // Group by owning agent, preserving the backend's stable agent ordering.
  const groups = useMemo<Group[]>(() => {
    const byAgent = new Map<string, Group>();
    for (const s of skills) {
      let g = byAgent.get(s.agent);
      if (!g) {
        g = { agent: s.agent, label: s.agent_label, skills: [] };
        byAgent.set(s.agent, g);
      }
      g.skills.push(s);
    }
    return [...byAgent.values()];
  }, [skills]);

  return (
    <PaneScroll>
      <PaneIntro
        title="Skills"
        blurb="The named abilities your coding agents can run on demand. Read straight from each agent's own setup on this machine and in this project. This is what they can already do; manage them in the agent that owns them."
        action={
          <Button
            size="sm"
            variant="subtle"
            onClick={load}
            disabled={loading}
            className="gap-1.5"
          >
            <RefreshCw
              size={13}
              className={loading ? "animate-spin" : undefined}
            />
            Rescan
          </Button>
        }
      />

      {loading && skills.length === 0 ? (
        <PaneSpinner label="Scanning your agents for skills…" />
      ) : groups.length === 0 ? (
        <EmptyHint
          icon={Zap}
          title="No agent skills found yet"
          body="When you add skills to an agent (a SKILL.md under ~/.claude/skills, a Codex prompt, a Cursor rule) they show up here automatically, grouped by agent. Nothing to wire up."
        />
      ) : (
        <div className="space-y-6">
          {groups.map((g) => {
            const canonical = canonicalAgentId(g.agent);
            return (
              <section key={g.agent}>
                {/* Agent header — brand mark + label + count. The group IS the
                    organising idea: skills belong to an agent, not to Aura. */}
                <div className="mb-2 flex items-center gap-2.5 px-0.5">
                  <AgentIcon agentId={canonical} label={g.label} size={20} />
                  <span className="text-base font-semibold text-text-1">
                    {g.label}
                  </span>
                  <CountPill>
                    {g.skills.length}{" "}
                    {g.skills.length === 1 ? "skill" : "skills"}
                  </CountPill>
                </div>
                <Card>
                  {g.skills.map((s, i) => {
                    const meta = KIND_META[s.kind] ?? KIND_META.skill;
                    const KindIcon = meta.icon;
                    return (
                      <div
                        key={`${s.path}-${i}`}
                        className={`flex items-start gap-3 px-3.5 py-3 ${
                          i > 0 ? "border-t border-line-soft" : ""
                        }`}
                      >
                        <KindIcon
                          size={15}
                          className="mt-0.5 shrink-0 text-text-4"
                        />
                        <div className="min-w-0 flex-1">
                          <div className="flex items-center gap-2">
                            <span className="truncate text-base font-medium text-text-1">
                              {s.name}
                            </span>
                            {s.scope === "project" ? (
                              <span className="inline-flex items-center gap-1 rounded-full bg-bg-2 px-1.5 py-0.5 text-2xs font-medium text-text-3">
                                <FolderGit2 size={9} />
                                This project
                              </span>
                            ) : null}
                          </div>
                          {s.description ? (
                            <div className="mt-0.5 line-clamp-2 text-sm leading-relaxed text-text-4">
                              {s.description}
                            </div>
                          ) : null}
                        </div>
                        <span className="mt-0.5 shrink-0 text-xs font-medium text-text-4">
                          {meta.word}
                        </span>
                      </div>
                    );
                  })}
                </Card>
              </section>
            );
          })}
        </div>
      )}
    </PaneScroll>
  );
}
