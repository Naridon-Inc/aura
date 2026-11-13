// Skills pane — the real, named abilities your coding agents can already reach
// for. A skill is a packaged "/do-this" an agent runs on demand. We read them
// straight from where each agent keeps them on this machine (Claude's
// `~/.claude/skills`, Codex's prompts, Cursor's rules, plus the copies living
// in this project) so the list matches what your agents can actually do — no
// signed-plugin gate, no mockups. One settings section per agent that owns
// them, each skill a settings row with its kind's mark, so it reads at a glance.
//
// Read-only on purpose: these files belong to each agent's own setup (the way
// the agent's CLI manages them). Aura surfaces them so you can see what's there
// and open the file; it doesn't pretend to toggle another tool's config.

import { useCallback, useEffect, useMemo, useState } from "react";
import { FileText, FolderGit2, RefreshCw, ScrollText, Zap } from "lucide-react";

import { api, type AgentSkill } from "../../../lib/api";
import { AsciiSpinner } from "../../ui/ascii-spinner";
import { Badge } from "../../ui/badge";
import { Button } from "../../ui/button";
import { SettingsMcpToolbar } from "../../ui/settings-mcp-parts";
import { SettingsRow, SettingsSection } from "../../ui/settings-row";
import { SettingsServiceMark, SettingsServiceTitle } from "../../ui/settings-services-row";
import { Card, EmptyHint, PaneIntro, PaneScroll, PaneSpinner } from "./customizeShared";

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
        blurb="The named abilities your coding agents can run on demand. Read straight from each agent's own setup on this machine and in this repository. This is what they can already do; manage them in the agent that owns them."
      />

      <Card>
        <SettingsRow
          title="Agent skills"
          description={
            groups.length > 0
              ? `${skills.length} found across ${groups.length} ${groups.length === 1 ? "agent" : "agents"}`
              : undefined
          }
          control={
            <SettingsMcpToolbar>
              <Button size="sm" variant="ghost" onClick={load} disabled={loading}>
                {loading ? <AsciiSpinner /> : <RefreshCw />}
                Rescan
              </Button>
            </SettingsMcpToolbar>
          }
        />
      </Card>

      {loading && skills.length === 0 ? (
        <PaneSpinner label="Scanning your agents for skills…" />
      ) : groups.length === 0 ? (
        <EmptyHint
          icon={Zap}
          title="No agent skills found yet"
          body="When you add skills to an agent (a SKILL.md under ~/.claude/skills, a Codex prompt, a Cursor rule) they show up here automatically, grouped by agent. Nothing to wire up."
        />
      ) : (
        groups.map((g) => (
          // The group IS the organising idea: skills belong to an agent, not
          // to Aura.
          <SettingsSection
            key={g.agent}
            title={g.label}
            description={`${g.skills.length} ${g.skills.length === 1 ? "skill" : "skills"}`}
          >
            {g.skills.map((s, i) => {
              const meta = KIND_META[s.kind] ?? KIND_META.skill;
              const KindIcon = meta.icon;
              return (
                <SettingsRow
                  key={`${s.path}-${i}`}
                  title={
                    <SettingsServiceTitle
                      mark={
                        <SettingsServiceMark>
                          <KindIcon />
                        </SettingsServiceMark>
                      }
                      badge={
                        s.scope === "project" ? (
                          <Badge variant="outline">
                            <FolderGit2 size={12} />
                            This repository
                          </Badge>
                        ) : undefined
                      }
                    >
                      {s.name}
                    </SettingsServiceTitle>
                  }
                  description={
                    s.description ? (
                      <span className="ui-customize-clamp">{s.description}</span>
                    ) : undefined
                  }
                  control={<span className="ui-customize-kind">{meta.word}</span>}
                />
              );
            })}
          </SettingsSection>
        ))
      )}
    </PaneScroll>
  );
}
