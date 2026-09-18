/** Chat Completions accumulator. Tool requests are displayed, never executed
 * by this plain model chat. Actual agent execution belongs to the CLI bridge. */
export type CompletionTool = {
  index: number;
  id?: string;
  name: string;
  arguments: string;
};
export type CompletionState = {
  content: string;
  reasoning?: string;
  refusal?: string;
  tools?: CompletionTool[];
  parts?: unknown[];
  usage?: { input: number; output: number; total: number };
  finishReason?: string;
};
type Obj = Record<string, unknown>;
const obj = (v: unknown): Obj =>
  v && typeof v === "object" && !Array.isArray(v) ? (v as Obj) : {};
const str = (v: unknown) => (typeof v === "string" ? v : "");

export function accumulateCompletion<T extends CompletionState>(
  prev: T,
  event: unknown,
): T {
  const v = obj(event);
  const next = { ...prev };
  if (v.usage && typeof v.usage === "object") {
    const u = obj(v.usage);
    const n = (key: string) =>
      typeof u[key] === "number" && Number.isFinite(u[key])
        ? Math.max(0, u[key] as number)
        : 0;
    next.usage = {
      input: n("prompt_tokens"),
      output: n("completion_tokens"),
      total: n("total_tokens") || n("prompt_tokens") + n("completion_tokens"),
    };
  }
  if (!Array.isArray(v.choices)) {
    next.parts = [...(prev.parts ?? []), event];
    return next;
  }
  // The UI requests the default single choice. Preserve additional choices as
  // inspectable content so endpoints returning multiple alternatives lose none.
  for (const [position, choice] of v.choices.entries()) {
    const c = obj(choice);
    if ((typeof c.index === "number" && c.index !== 0) || position > 0) {
      next.parts = [...(next.parts ?? []), c];
      continue;
    }
    const snapshot = c.message != null;
    const d = obj(snapshot ? c.message : c.delta);
    const merge = (old: string | undefined, value: unknown) =>
      snapshot ? str(value) : (old ?? "") + str(value);
    if (typeof d.content === "string")
      next.content = merge(next.content, d.content);
    else if (Array.isArray(d.content)) {
      const text = d.content.map((p) => str(obj(p).text)).join("");
      next.content = snapshot ? text : next.content + text;
      const parts = d.content.filter(
        (p) => !["text", "output_text"].includes(str(obj(p).type)),
      );
      next.parts = [...(next.parts ?? []), ...parts];
    }
    if (
      typeof d.reasoning_content === "string" ||
      typeof d.reasoning === "string"
    )
      next.reasoning = merge(
        next.reasoning,
        d.reasoning_content ?? d.reasoning,
      );
    if (typeof d.refusal === "string")
      next.refusal = merge(next.refusal, d.refusal);
    if (Array.isArray(d.tool_calls)) {
      const tools = snapshot ? [] : (next.tools ?? []).map((t) => ({ ...t }));
      for (const [i, value] of d.tool_calls.entries()) {
        const t = obj(value),
          f = obj(t.function);
        const index = typeof t.index === "number" ? t.index : i;
        let tool = tools.find((t) => t.index === index);
        if (!tool) {
          tool = { index, name: "", arguments: "" };
          tools.push(tool);
        }
        if (typeof t.id === "string") tool.id = t.id;
        if (typeof f.name === "string") tool.name = f.name;
        tool.arguments += str(f.arguments);
      }
      next.tools = tools;
    }
    if (d.function_call)
      next.parts = [
        ...(next.parts ?? []),
        { type: "function_call", ...obj(d.function_call) },
      ];
    for (const [key, value] of Object.entries(d)) {
      if (
        ![
          "role",
          "content",
          "reasoning",
          "reasoning_content",
          "refusal",
          "tool_calls",
          "function_call",
        ].includes(key) &&
        value != null
      )
        next.parts = [...(next.parts ?? []), { type: key, value }];
    }
    if (typeof c.finish_reason === "string")
      next.finishReason = c.finish_reason;
  }
  return next;
}
