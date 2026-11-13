// The state glyph: a ring drawn per state bucket (dashed for backlog, solid
// for not started, half filled for started, filled for finished), in the
// state's own colour. Used where a surface draws a custom state's colour,
// such as the crew plan.

export function StateGlyph({
  group,
  color,
  size = 11,
}: {
  group: string;
  color: string;
  size?: number;
}) {
  const base: React.CSSProperties = {
    width: size,
    height: size,
    borderRadius: "50%",
    boxSizing: "border-box",
    flexShrink: 0,
  };
  if (group === "backlog") {
    return (
      <span
        aria-hidden
        style={{ ...base, border: `1.5px dashed ${color}` }}
      />
    );
  }
  if (group === "unstarted") {
    return (
      <span aria-hidden style={{ ...base, border: `1.5px solid ${color}` }} />
    );
  }
  if (group === "started") {
    return (
      <span
        aria-hidden
        style={{
          ...base,
          border: `1.5px solid ${color}`,
          background: `conic-gradient(${color} 50%, transparent 50%)`,
        }}
      />
    );
  }
  // completed / cancelled and any unknown group fall through to filled
  return (
    <span
      aria-hidden
      style={{ ...base, background: color, border: `1.5px solid ${color}` }}
    />
  );
}
