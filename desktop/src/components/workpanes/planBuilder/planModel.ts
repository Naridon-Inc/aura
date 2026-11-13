// The plan as the builder edits it, and how it is written back to
// `.aura/plans/ACTIVE_MILESTONE.xml`.

import type { ParsedPlan } from "../../../lib/planXml";

export type EditableTask = {
  id: string;
  name: string;
  description: string;
  /** The agent pinned to this task; "" lets whoever is free pick it up. */
  agent: string;
  dependencies: string[];
  priority: string;
  tags: string[];
};

export type EditableWave = {
  id: string;
  name: string;
  tasks: EditableTask[];
};

export type EditablePlan = { waves: EditableWave[] };

export const KNOWN_AGENTS: Array<{ id: string; label: string }> = [
  { id: "claude", label: "Claude" },
  { id: "gemini", label: "Gemini" },
  { id: "codex", label: "Codex" },
  { id: "cursor", label: "Cursor" },
  { id: "aura-manager", label: "Aura" },
];

export function toEditable(p: ParsedPlan): EditablePlan {
  return {
    waves: p.waves.map((w) => ({
      id: w.id,
      name: w.name,
      tasks: w.tasks.map((t) => ({
        id: t.id,
        name: t.name,
        description: t.description,
        agent: "",
        dependencies: t.dependencies.slice(),
        priority: t.priority,
        tags: t.tags.slice(),
      })),
    })),
  };
}

export function taskCount(plan: EditablePlan | null): number {
  return (plan?.waves ?? []).reduce((n, w) => n + w.tasks.length, 0);
}

function escapeXml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

export function serializePlan(plan: EditablePlan, objective: string): string {
  const out: string[] = [];
  out.push(`<?xml version="1.0" encoding="UTF-8"?>`);
  out.push(`<milestone>`);
  out.push(`  <objective>${escapeXml(objective)}</objective>`);
  out.push(`  <plan>`);
  for (const wave of plan.waves) {
    out.push(`    <wave id="${escapeXml(wave.id)}" name="${escapeXml(wave.name)}">`);
    for (const t of wave.tasks) {
      out.push(`      <task id="${escapeXml(t.id)}" name="${escapeXml(t.name)}">`);
      if (t.description.trim()) {
        out.push(`        <description>${escapeXml(t.description.trim())}</description>`);
      }
      if (t.agent) out.push(`        <owner>${escapeXml(t.agent)}</owner>`);
      if (t.priority) out.push(`        <priority>${escapeXml(t.priority)}</priority>`);
      if (t.dependencies.length > 0) {
        out.push(`        <dependencies>`);
        for (const d of t.dependencies) {
          out.push(`          <dependency>${escapeXml(d)}</dependency>`);
        }
        out.push(`        </dependencies>`);
      }
      if (t.tags.length > 0) {
        out.push(`        <tags>`);
        for (const tag of t.tags) {
          out.push(`          <tag>${escapeXml(tag)}</tag>`);
        }
        out.push(`        </tags>`);
      }
      out.push(`      </task>`);
    }
    out.push(`    </wave>`);
  }
  out.push(`  </plan>`);
  out.push(`</milestone>`);
  return out.join("\n");
}
