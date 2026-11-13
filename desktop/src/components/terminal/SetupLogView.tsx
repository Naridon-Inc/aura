// What a workspace's setup script printed, in a terminal that only shows:
// no input, no cursor. It draws the shared log as it grows, and starts over
// when a new run begins or the log is read back from disk.

import { useEffect, useRef } from "react";
import { Terminal as XTerm } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { defaultTerminalFontSize, getSettings } from "../../lib/settingsStore";
import { xtermThemeFromTokens } from "../../lib/terminalAppearance";
import { unseenOutput, type ScriptView } from "../../lib/workspaceScripts";

const HIDE_CURSOR = "\u001b[?25l";

export function SetupLogView({ view }: { view: ScriptView }) {
  const hostRef = useRef<HTMLDivElement>(null);
  const termRef = useRef<XTerm | null>(null);
  const drawnRef = useRef({ gen: -1, total: 0 });
  const viewRef = useRef(view);
  viewRef.current = view;

  const draw = () => {
    const term = termRef.current;
    if (!term) return;
    const current = viewRef.current;
    const { reset, text } = unseenOutput(current, drawnRef.current);
    if (reset) {
      term.reset();
      term.write(HIDE_CURSOR);
    }
    if (text) term.write(text);
    drawnRef.current = { gen: current.gen, total: current.total };
  };

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    const term = new XTerm({
      disableStdin: true,
      convertEol: true,
      cursorBlink: false,
      cursorInactiveStyle: "none",
      scrollback: 10000,
      fontFamily: "ui-monospace, SF Mono, Menlo, monospace",
      fontSize: getSettings().terminal.font_size ?? defaultTerminalFontSize(),
      theme: xtermThemeFromTokens(),
    });
    const fit = new FitAddon();
    term.loadAddon(fit);
    term.open(host);
    const refit = () => {
      try {
        fit.fit();
      } catch {
        /* not laid out yet */
      }
    };
    refit();
    const observer = new ResizeObserver(refit);
    observer.observe(host);
    termRef.current = term;
    drawnRef.current = { gen: -1, total: 0 };
    draw();
    return () => {
      observer.disconnect();
      termRef.current = null;
      term.dispose();
    };
    // `draw` reads the latest view through a ref.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(draw, [view]);

  return <div ref={hostRef} className="ui-setup-log" aria-label="Setup script output" />;
}
