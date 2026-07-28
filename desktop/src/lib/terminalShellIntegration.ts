// VSCode-style shell-integration command decorations for the xterm pane.
//
// The backend already injects the OSC 133 prompt-marking scripts (zsh/bash)
// and forwards the escape sequences to xterm untouched, so we parse them right
// out of the write stream — the same approach VSCode's ShellIntegrationAddon +
// DecorationAddon take — and render a gutter dot per command coloured by its
// exit code, plus a matching tick on the scrollbar overview ruler. This is the
// iconic "did that command pass or fail" marking people know from VSCode.
//
// The OSC 133 contract Aura's scripts emit (see resources/shell-integration/):
//   133;A       prompt start        (a fresh command begins on this line)
//   133;B       prompt end
//   133;C       command pre-exec    (it is now running)
//   133;D;<n>   command end + exit   (n = $?)

import type { IDecoration, IDisposable, IMarker, Terminal as XTerm } from "@xterm/xterm";

// VSCode's terminalCommandDecoration.* default colours.
const DECORATION_COLOR = {
  success: "#1b81a8", // exit 0   — terminalCommandDecoration.successBackground
  error: "#f14c4c", //   exit != 0 — terminalCommandDecoration.errorBackground
} as const;

type Command = {
  marker: IMarker;
  decoration: IDecoration | null;
  /** performance.now() when the command started running (OSC C). 0 until then,
   *  which also flags "nothing actually ran" so an empty prompt gets no dot. */
  startedAt: number;
  finished: boolean;
};

export type ShellIntegration = {
  dispose(): void;
  /** Number of commands that have a rendered decoration — handy for tests. */
  commandCount(): number;
};

/** Attach OSC 133 parsing + command decorations to an already-open xterm.
 *  Call after `term.open()`. Safe to call once per terminal; dispose on
 *  teardown (the terminal's own dispose also cleans markers/decorations, but
 *  this releases the OSC handler explicitly). */
export function registerShellIntegration(term: XTerm): ShellIntegration {
  const commands: Command[] = [];
  let current: Command | null = null;

  function beginCommand(): void {
    // Marker at the current cursor row — the prompt line the command sits on.
    const marker = term.registerMarker(0);
    if (!marker) {
      current = null;
      return;
    }
    current = { marker, decoration: null, startedAt: 0, finished: false };
  }

  function endCommand(exitCode: number): void {
    const cmd = current;
    current = null;
    if (!cmd || cmd.finished) return;
    cmd.finished = true;

    // Only decorate commands that actually ran (OSC C fired). An empty Enter
    // never triggers preexec, so it should leave no mark — matches VSCode.
    if (cmd.startedAt === 0) {
      disposeQuietly(cmd.marker);
      return;
    }

    const color = exitCode === 0 ? DECORATION_COLOR.success : DECORATION_COLOR.error;
    const durationMs = Math.max(0, performance.now() - cmd.startedAt);
    const decoration = term.registerDecoration({
      marker: cmd.marker,
      overviewRulerOptions: { color, position: "left" },
    });
    if (decoration) {
      decoration.onRender((el) => paintGutterDot(el, color, exitCode, durationMs));
      cmd.decoration = decoration;
    }
    commands.push(cmd);
  }

  const oscHandler = term.parser.registerOscHandler(133, (data) => {
    // `data` is everything after "133;": "A", "B", "C", "D", "D;0", "D;1", …
    const sep = data.indexOf(";");
    const kind = sep === -1 ? data : data.slice(0, sep);
    switch (kind) {
      case "A": // prompt start → a fresh command begins on this line
        beginCommand();
        break;
      case "C": // command pre-exec → it is now running
        if (current) current.startedAt = performance.now();
        break;
      case "D": {
        // command end; the tail (if any) is the exit code
        const raw = sep === -1 ? "" : data.slice(sep + 1);
        const exit = raw === "" ? 0 : Number.parseInt(raw, 10);
        endCommand(Number.isNaN(exit) ? 0 : exit);
        break;
      }
      // "B" (prompt end) needs no decoration action.
      default:
        break;
    }
    // Consume the sequence — nothing downstream should print it.
    return true;
  });

  return {
    dispose(): void {
      disposeQuietly(oscHandler);
      for (const c of commands) {
        if (c.decoration) disposeQuietly(c.decoration);
        disposeQuietly(c.marker);
      }
      commands.length = 0;
      if (current) disposeQuietly(current.marker);
      current = null;
    },
    commandCount: () => commands.length,
  };
}

/** Render the small VSCode-style dot inside the decoration's cell element.
 *  onRender can fire repeatedly (scroll/resize), so rebuild idempotently. */
function paintGutterDot(
  el: HTMLElement,
  color: string,
  exitCode: number,
  durationMs: number,
): void {
  el.style.display = "flex";
  el.style.alignItems = "center";
  el.style.justifyContent = "center";
  el.style.width = "100%";
  el.style.height = "100%";
  el.style.pointerEvents = "auto";
  el.style.cursor = "default";
  el.style.zIndex = "6";

  const dot = document.createElement("div");
  dot.style.width = "6px";
  dot.style.height = "6px";
  dot.style.borderRadius = "50%";
  dot.style.backgroundColor = color;
  // A soft ring, like VSCode's, so the dot reads on any cell background.
  dot.style.boxShadow = "0 0 0 1px rgba(0,0,0,0.35)";
  el.replaceChildren(dot);

  el.title =
    exitCode === 0
      ? `Command succeeded${durationSuffix(durationMs)}`
      : `Command exited with code ${exitCode}${durationSuffix(durationMs)}`;
}

function durationSuffix(ms: number): string {
  if (ms < 1) return "";
  if (ms < 1000) return ` · ${Math.round(ms)}ms`;
  const s = ms / 1000;
  if (s < 60) return ` · ${s.toFixed(s < 10 ? 1 : 0)}s`;
  const m = Math.floor(s / 60);
  return ` · ${m}m ${Math.round(s % 60)}s`;
}

function disposeQuietly(d: IDisposable): void {
  try {
    d.dispose();
  } catch {
    /* already disposed */
  }
}
