// Run with: bun test src/components/chat/chatRedesign.test.ts
//
// The chat contract, pinned by source scan.
//
// Every number in the chat — the reading column, the composer's padding and
// floors, the icon scale, the ink steps, the turn rhythm, the menu row — is a
// decision with a reason, and all of them are expressible only as CSS custom
// properties and SVG attributes. Nothing here can be unit-tested by rendering:
// a geometry regression is a stylesheet someone tidied. So this file reads the
// stylesheets and the components as text and asserts the numbers.
//
// Three rules it exists to defend:
//
//   1. The geometry is a system, not a set of preferences. The composer's
//      16/16/12/18 padding is the clearest case: the left is 2px wider than
//      the right on purpose, because the mode control beneath it sits 7px off
//      the box edge and the typed line has to look flush with the label under
//      it, not with the box. Round all four to 12 and the rhythm goes, and
//      nothing else in the app notices.
//   2. The metrics live on `.aura-chat` as their OWN names. `.aura-chat` wraps
//      tool rows, ask cards and plan cards that are meant to stay chrome-sized
//      — a tool roll-up should read smaller than the prose it produced — so
//      raising `--font-size-base` instead would resize the rail, the board,
//      settings and every dialog to match the chat.
//   3. The palette is derived, never literal. Contrast RELATIONSHIPS are
//      pinned (a bubble a step over the page, meta ink at ~70% of prose); the
//      hues come from Aura's own ramp, because a hard-coded hex breaks light
//      mode and the four other accent packs, which track tokens.
//
// What is deliberately NOT pinned is recorded in `the divergences are
// deliberate` below.
import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { UI_GEOMETRY } from "../ui/geometry";

const SRC = join(import.meta.dir, "..", "..");
const read = (rel: string) => readFileSync(join(SRC, rel), "utf8");

/** Declaration blocks of every rule whose selector list is `selector`.
 *  Whitespace inside the list is normalised, so a two-line selector list
 *  matches the one-line spelling of itself. */
function rules(css: string, selector: string): string[] {
  const norm = (s: string) => s.trim().replace(/\s*\n\s*/g, " ").replace(/\s+/g, " ");
  const want = norm(selector);
  const out: string[] = [];
  for (const m of css.replace(/\/\*[\s\S]*?\*\//g, "").matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
    if (norm(m[1]) === want) out.push(m[2]);
  }
  return out;
}

/** The value of one custom property in a joined declaration text. */
function token(decls: string, name: string): string | undefined {
  return decls.match(new RegExp(`${name}:\\s*([^;]+)`))?.[1].trim();
}

// Load order is load-bearing: main.tsx imports App (which reaches
// ChatComposer.css transitively) BEFORE `import "./styles.css"`, so where
// both set the same property on the same selector, styles.css is the one that
// applies. See chatDockColumn.test.ts.
const shellCss = read("styles.css");
const chatComposer = read("components/chat/ChatComposer.css");
const chatView = read("components/agent/chatView.css");
// What the conversation adds around the shared `.ui-composer` box.
const chatComposerBox = read("components/ui/chat-composer.css");

const chatTokens = rules(shellCss, ".aura-chat").join(";");

/** Every conversation composer: each mounts the shared box. */
const COMPOSER_HOSTS = [
  "components/manager/ManagerComposer.tsx",
  "components/agent/chat/AgentChatComposer.tsx",
  "components/agent/normalized/NormalizedTranscript.tsx",
  "components/agent/OpenAiCompatChatView.tsx",
];

describe("the measured geometry", () => {
  test("the reading column is 985, not a round number", () => {
    // A 985px column at a 15/26 prose size is ~90 characters a line, which is
    // the width prose stops needing head movement to scan. Rounding it to
    // 1000 or 960 is the change that makes nobody notice anything except that
    // long answers got harder to read.
    expect(token(chatTokens, "--chat-col")).toBe("985px");
  });

  test("the prose sits inside the column it is typed in", () => {
    // Text column 456..1385 = 930pt, i.e. 27.5 in from the composer's left
    // edge and 28 from its right. The transcript takes the inset and the dock
    // does not — that difference IS the relationship, so both halves of it
    // are pinned.
    expect(token(chatTokens, "--chat-prose-inset")).toBe("28px");
    expect(rules(shellCss, ".aura-chat .p-scroll > *").join(";")).toMatch(
      /max-width:\s*calc\(\s*var\(--chat-col\)\s*-\s*2\s*\*\s*var\(--chat-prose-inset\)\s*\)/,
    );
    // The agent transcript reaches the same column by adding the inset to its
    // padding instead of subtracting it from its cap, so the prose lands in
    // the same place while the dock stays flush.
    const column = rules(chatView, ".chat-reading-column").join(";");
    expect(column).toMatch(/2\s*\*\s*var\(--chat-prose-inset/);
    expect(column).toMatch(/padding:[^;]*var\(--chat-prose-inset/);
  });

  test("prose is set at 15 on 26, not at the chrome step", () => {
    // Measured 15px on a 26.5pt pitch (~1.77). The app is designed at 13/20
    // and that is right for rails and menus; a transcript is the one surface
    // read for minutes at a time.
    expect(token(chatTokens, "--chat-prose-size")).toBe("15px");
    expect(token(chatTokens, "--chat-prose-line")).toBe("26px");
    expect(token(chatTokens, "--chat-prose-gap")).toBe("17px");
  });

  test("the old composer frame left no tokens behind", () => {
    // Both composers are the shared box now, so the box's numbers are the
    // shared rule's. A frame token left in the block is a second spec that
    // nothing reads.
    for (const name of [
      "--chat-composer-radius",
      "--chat-composer-rest",
      "--chat-composer-pad-t",
      "--chat-composer-band",
      "--chat-composer-dur",
      "--chat-send-size",
    ]) {
      expect(token(chatTokens, name)).toBeUndefined();
    }
    // The ghost controls inside the box still read this one.
    expect(token(chatTokens, "--chat-control-size")).toBe("28px");
  });
  test("the composer is the shared box: the well, then a footer row under it", () => {
    // The controls sit in the shared footer, pinned along the bottom of the
    // box under the writing well: the model control on the left, the actions
    // on the right. Every chat mounts that box itself rather than a frame
    // that looks like it.
    const box = read("components/ui/composer.tsx");
    expect(box).toContain("className={`ui-composer-wrap ${className}`}");
    expect(box).toContain('className="ui-composer-footer"');
    expect(box).toContain('className="ui-composer-options"');
    expect(box).toContain('className="ui-composer-actions"');
    for (const host of COMPOSER_HOSTS) {
      const src = read(host);
      expect(src).toMatch(/<Composer\b/);
      expect(src).not.toMatch(/<TiptapComposer|<textarea|<ComposerFrame/);
    }
    // The pinned toolbar is gone from the markup and from the stylesheet.
    expect(chatComposer).not.toContain(".unified-composer-toolbar");
  });

  test("send and stop are filled with the text colour; stop steps back once there is text", () => {
    // Send, Queue and Edit are the box's own 24px icon button, filled with the
    // text colour and drawn at a 1.5 stroke. Stop shares the fill while the box
    // is empty; once there is text to send it turns outlined, so the button
    // that commits the text is the one that stands out.
    const box = read("components/ui/composer.tsx");
    expect(box).toMatch(/className="ui-composer-send"\s+aria-label=\{sendLabel\}/);
    expect(box).toMatch(/className="ui-composer-stop"\s+data-emphasis=\{canSend \? "secondary" : "primary"\}\s+aria-label="Stop response"/);
    expect(box).toContain("<CornerDownLeft strokeWidth={1.5} />");
    // Disabled, send keeps its shape (half-strength fill inside the dimmed button).
    expect(box).toMatch(/aria-label=\{sendLabel\}[\s\S]{0,80}disabled=\{!canSend\}/);
    expect(uiMenuCss).toMatch(/\.ui-composer-send:disabled \{[^}]*color-mix\(in srgb, var\(--ui-fg\) 50%/);
    expect(uiMenuCss).toMatch(/\.ui-composer-stop svg \{[^}]*width:\s*10px[^}]*fill:\s*currentColor/);
    expect(uiMenuCss).toMatch(/\.ui-composer-stop\[data-emphasis="secondary"\] \{[^}]*border-color:\s*var\(--ui-input\)/);
    // The tooltips carry the keys, and the stop key works from inside the box.
    expect(box).toContain("Cancel <Kbd>⌘⇧⌫</Kbd>");
    expect(box).toContain('const sendKeys = sendKey === "enter" ? "↵" : "⌘↵";');
    expect(box).toMatch(/event\.key === "Backspace" &&\s+event\.shiftKey &&\s+\(event\.metaKey \|\| event\.ctrlKey\)/);
    // No host draws a send button of its own beside the box's.
    for (const host of COMPOSER_HOSTS) expect(read(host)).not.toContain('aria-label="Send message"');
    // No chat stylesheet restyles the send button by its label any more.
    expect(chatComposer).not.toMatch(/aria-label="Send message"/);
    expect(chatComposerBox).not.toMatch(/aria-label="Send message"/);
  });

  test("the user bubble is barely rounded and generously padded", () => {
    // Radius read off an 8x magnified corner — the downscaled overview read
    // as much rounder and was misleading. 18pt sides; 11 top/bottom derived
    // from the 48.5pt single-line height at 15/26.
    expect(token(chatTokens, "--chat-bubble-radius")).toBe("5px");
    expect(token(chatTokens, "--chat-bubble-pad-x")).toBe("18px");
    expect(token(chatTokens, "--chat-bubble-pad-y")).toBe("11px");
  });

  test("meta ink is quiet but readable, and derived from our own ramp", () => {
    // Meta ink wants to be ~73% of the prose's lightness: quiet enough to
    // read as secondary, bright enough to read at all. Aura's --color-text-4
    // is 39% of --color-text-1, which is why the footer row was effectively
    // invisible. A mix lands on the ratio while staying a derivative of our own
    // ramp, so light mode and all five accent packs still track it.
    expect(token(chatTokens, "--chat-meta-size")).toBe("12px");
    const ink = token(chatTokens, "--chat-meta-ink") ?? "";
    expect(ink).toMatch(/color-mix/);
    expect(ink).toMatch(/var\(--color-text-2\)/);
    expect(ink).toMatch(/var\(--color-text-3\)/);
  });
});

describe("every chat surface reads the tokens", () => {
  test("both composers take the shared frame", () => {
    // The terminal-agent chat and the manager chat draw the same box: 12px
    // corners on a hairline, from the shared rule, not copies of the numbers.
    const agent = read("components/agent/chat/AgentChatComposer.tsx");
    expect(agent).toContain("<Composer");
    expect(agent).toContain('className={docked ? "composer-docked" : ""}');
    // Its add menu is the shared one. Files go in as paths, which is how a
    // CLI reads.
    expect(agent).toContain("<ComposerAddMenu");
    expect(agent).toContain("pickPath({");
    expect(agent).not.toContain("send-kbd");
    expect(agent).not.toContain("<ChipButton");
    expect(rules(shellCss, ".aura-chat .composer")).toEqual([]);
    expect(shellCss).not.toMatch(/\.aura-chat \.composer[\s.:[{]/);
    expect(chatComposer).not.toMatch(/\.unified-composer\s*[,{]/);
    expect(uiMenuCss).toMatch(/\.ui-composer \{[^}]*border:\s*1px solid var\(--ui-border\)/);
    expect(uiMenuCss).toMatch(/\.ui-composer \{[^}]*border-radius:\s*12px/);
  });
  test("the composer keeps no width steps of its own", () => {
    // The old frame squeezed its own toolbar at two container widths. The
    // shared box has one footer and no steps, so neither stylesheet carries
    // a second spec for it.
    expect(chatComposer).not.toContain("@container composer");
    expect(chatComposerBox).not.toMatch(/\.chat-composer\b/);
  });

  test("an idle composer collapses to a strip and gives the room back", () => {
    // A state, not a size: the attribute goes on the box and the stylesheet
    // owns every number it moves. The well keeps one line — so what you get
    // back is the room, and what you keep is the draft and the caret.
    const box = read("components/ui/composer.tsx");
    expect(box).toContain("data-composer-minimized={minimized}");
    expect(rules(uiMenuCss, '.ui-composer[data-composer-minimized="true"] textarea').join(";")).toMatch(
      /padding:\s*4px 144px 4px 48px/,
    );
    expect(read("components/agent/chat/AgentChatComposer.tsx")).toContain(
      "minimized={collapse.minimized}",
    );
  });

  test("every writing well is the shared textarea at the measured height and type size", () => {
    expect(uiMenuCss).toMatch(/\.ui-composer textarea \{[^}]*font:\s*14px\/1\.5 var\(--font-sans\)/);
    expect(uiMenuCss).toMatch(/\.ui-composer textarea \{[^}]*min-height:\s*88px/);
    expect(uiMenuCss).toMatch(/\.ui-composer textarea \{[^}]*max-height:\s*188px/);
    // The footer row is pinned inside the box, and the field keeps its room.
    expect(uiMenuCss).toMatch(/\.ui-composer textarea \{[^}]*margin:\s*12px 0 48px/);
    // The editor text is set a shade lighter than body copy.
    expect(uiMenuCss).toMatch(/\.ui-composer textarea \{[^}]*font-weight:\s*350/);
    expect(uiMenuCss).toMatch(/\.ui-composer-footer \{[^}]*position:\s*absolute;[^}]*bottom:\s*12px/);
    expect(read("components/ui/composer.tsx")).toContain(
      "Math.max(floor, Math.min(188, textarea.scrollHeight))",
    );
    // No chat stylesheet sizes a rich editor beside it any more.
    expect(chatComposerBox).not.toContain("tiptap-composer-input");
  });

  test("your own words are the shared message bubble in every transcript", () => {
    expect(rules(shellCss, ".aura-chat .user-bubble")).toHaveLength(0);
    expect(rules(chatView, ".chat-user-message")).toHaveLength(0);
    const agent = read("components/agent/normalized/NormalizedTranscript.tsx");
    expect(agent).toMatch(/<Message role="user">\s*<div className="ui-chat-user-stack">\s*<MessageBody tone="user">/);
  });

  test("assistant prose reads the prose tokens from CSS and from React", () => {
    const prose = rules(shellCss, ".aura-chat .agent-text").join(";");
    expect(prose).toMatch(/font-size:\s*var\(--chat-prose-size\)/);
    expect(prose).toMatch(/line-height:\s*var\(--chat-prose-line\)/);

    // The manager chat's answers are the shared message markdown. No inline
    // size or line-height on the body, which would beat every stylesheet —
    // the shared typography sets the prose.
    const md = read("components/manager/chat/Markdown.tsx");
    expect(md).toMatch(/<MessageMarkdown\s+content=\{cleaned\}/);
    expect(md).not.toContain("<ReactMarkdown");
    expect(read("components/ui/transcript-content.tsx")).toContain('<div className="ui-message-markdown">');
    const body = md.slice(md.indexOf("export function MarkdownBody("));
    expect(body).not.toMatch(/fontSize:/);
    expect(body).not.toMatch(/lineHeight:/);
    expect(md).not.toMatch(/fontSize:\s*"13px"/);
  });

  test("the prose gap has one source, for paragraphs and for lists", () => {
    // `MD_COMPONENTS.p` carried `mb-[9px]` while `.aura-chat .agent-text p`
    // ran 12px, so the same conversation paced its paragraphs 3px apart in
    // the two transcripts. The gap is now a stylesheet rule in both, and a
    // utility class here would silently become a third source.
    const md = read("components/manager/chat/Markdown.tsx");
    expect(md).toMatch(/p:\s*\(\{ children \}\) =>\s*<p>/);
    expect(md).not.toContain("mb-[9px]");
    expect(md).not.toContain("space-y-[3px]");
    expect(md).not.toContain("ml-[16px]");
    // An inline line-height beats every stylesheet in the app: at 15px prose
    // the list ran on a 22.5px line under a paragraph on 26, and visibly
    // tightened mid-answer.
    expect(md).not.toMatch(/lineHeight:\s*1\.5\s*\}\}/);

    expect(shellCss).toMatch(
      /\.aura-chat \.aura-md > p \{[^}]*margin-bottom:\s*var\(--chat-prose-gap\)/,
    );
    expect(shellCss).toMatch(
      /\.aura-chat \.aura-md > ul,\s*\.aura-chat \.aura-md > ol \{[^}]*margin-bottom:\s*var\(--chat-prose-gap\)/,
    );
    expect(rules(shellCss, ".aura-chat .agent-text p").join(";")).toMatch(
      /margin:\s*0 0 var\(--chat-prose-gap\)/,
    );
    // The two transcripts' lists have to agree on indent as well as gap, and
    // inside the chat the indent is 25px, so a bullet hangs clear of a 15/26
    // prose line. Outside the chat they stay on the app's chrome-scale 20,
    // which is what `.aura-md ul` keeps.
    expect(rules(shellCss, ".aura-md ul, .aura-md ol").join(";")).toMatch(
      /padding-left:\s*20px/,
    );
    for (const sel of [
      ".aura-chat .aura-md ul, .aura-chat .aura-md ol",
      ".aura-chat .agent-text ul, .aura-chat .agent-text ol",
    ]) {
      expect(rules(shellCss, sel).join(";")).toMatch(
        /padding-left:\s*var\(--chat-list-indent\)/,
      );
    }
  });

  test("the turn's own account of itself is separated from the answer", () => {
    // 19px under the collapsed roll-up and 20px over the footer. At the 2px
    // and 6px they used to carry, both read as part of the paragraph rather
    // than as the turn's own rails.
    expect(rules(shellCss, ".aura-chat .aura-turn-activity").join(";")).toMatch(
      /margin:\s*1px 0 19px/,
    );
    const footer = rules(shellCss, ".aura-chat .aura-msg-actions").join(";");
    expect(footer).toMatch(/margin-top:\s*20px/);
    expect(footer).toMatch(/color:\s*var\(--chat-meta-ink\)/);
    const summary = rules(shellCss, ".aura-chat .aura-turn-activity-summary").join(";");
    expect(summary).toMatch(/color:\s*var\(--chat-meta-ink\)/);
    expect(summary).toMatch(/font-size:\s*var\(--chat-meta-size\)/);
  });

  test("the footer controls are the shared ghost icon buttons", () => {
    // Dictation is the shared box's own pressed/unpressed toggle; the chat
    // hands it the state and draws no microphone of its own.
    const box = read("components/ui/composer.tsx");
    expect(box).toMatch(/aria-label=\{recording \? "Stop voice input" : "Start voice input"\}\s+aria-pressed=\{!!recording\}/);
    const composer = read("components/manager/ManagerComposer.tsx");
    expect(composer).toMatch(/recording=\{listening\}\s+onVoiceToggle=\{toggleListening\}/);
    // The add menu is the shared one, opened from the box's own slot.
    expect(composer).toMatch(/renderAddMenu=\{\(openFiles\) => \(\s*<ComposerAddMenu\s+onAttach=\{openFiles\}/);
    expect(composer).not.toContain('className="icon-btn-sm"');
  });

  test("only send is filled — Stop keeps its own colour", () => {
    // A stylesheet that filled every button in the action cluster once turned
    // Stop white, making the control that interrupts look like the one that
    // commits. The fills now come from the button variants alone, so no chat
    // rule paints a background onto the cluster's buttons.
    for (const css of [chatComposer, chatComposerBox]) {
      expect(css).not.toMatch(/\.unified-composer-actions/);
      expect(css).not.toMatch(/\.ui-composer-actions[^{]*button[^{]*\{[^}]*background/);
    }
  });

  test("the focus chord works without drawing a pill over the draft", () => {
    // ⌘L focuses the composer. The shared box draws no hint over the well,
    // so nothing sits on top of the first line of a draft.
    const composer = read("components/manager/ManagerComposer.tsx");
    expect(composer).toMatch(/\(e\.metaKey \|\| e\.ctrlKey\) && \(e\.key === "l" \|\| e\.key === "L"\)/);
    expect(composer).not.toContain("composer-focus-hint");
    // ⌘U opens the attachment picker, as the add menu's shortcut says. The
    // shared box owns the chord, so it only needs a host that takes files.
    expect(read("components/ui/composer.tsx")).toMatch(
      /\(event\.metaKey \|\| event\.ctrlKey\) && event\.key\.toLowerCase\(\) === "u" && onAttach/,
    );
    expect(composer).toMatch(/onAttach=\{\(files\) => files\.forEach\(ingestFile\)\}/);
  });

  test("assistant prose is no longer capped under the column", () => {
    // A 680px cap inside a 985px column meant the answer stopped ~250px short
    // of the question above it.
    for (const rel of [
      "components/manager/ManagerChatView.tsx",
      "components/manager/chat/ChatBubble.tsx",
      "components/manager/chat/AgentMessageBody.tsx",
    ]) {
      expect(read(rel)).not.toContain("max-w-[680px]");
    }
  });
});

describe("the divergences are deliberate", () => {
  test("the chat type scale does not leak into the app", () => {
    // `.aura-chat` wraps tool rows and cards that must stay chrome-sized.
    // Overriding the base step here would resize the rail, terminal, board,
    // settings and every dialog to match another app's chat.
    expect(chatTokens).not.toMatch(/--font-size-base:/);
    expect(chatTokens).not.toMatch(/--text-base:/);
    // And the roll-up stays BELOW the prose size: it is the account of the
    // work, not the work.
    const meta = Number((token(chatTokens, "--chat-meta-size") ?? "0px").replace("px", ""));
    const prose = Number((token(chatTokens, "--chat-prose-size") ?? "0px").replace("px", ""));
    expect(meta).toBeLessThan(prose);
  });

  test("no borrowed hex reached a declaration", () => {
    // These eleven values were read while working out the contrast
    // RELATIONSHIPS above, and deliberately never used: they belong to a warm
    // brown ramp, ours is cool with a green primary, and a hard-coded hex is
    // dead to light mode and to the four other accent packs, which track
    // tokens. Writing them down here is what keeps the derivation auditable;
    // what must not happen is one of them reaching a declaration.
    const borrowedHexes = [
      "#141110", "#1B1917", "#201E1C", "#373533", "#281E1D",
      "#F2ECE8", "#EAE8E6", "#A4A09D", "#756F6C", "#D5D4D2", "#52504E",
    ];
    // Comments are stripped, not scanned.
    for (const css of [shellCss, chatComposer, chatView]) {
      const declarations = css.replace(/\/\*[\s\S]*?\*\//g, "").toLowerCase();
      for (const hex of borrowedHexes) {
        expect(declarations).not.toContain(hex.toLowerCase());
      }
    }
  });

  test("the agent composer takes the shared box's fill, opaque over a terminal", () => {
    // No fill of its own: the box is the shared rule's. Floating over a
    // terminal it needs a solid ground, because the shared fill is
    // part-transparent in the light theme.
    expect(shellCss).not.toMatch(/\.aura-chat \.composer\s*\{/);
    expect(rules(chatView, ".chat-workspace[data-chat-overlay] .chat-composer").join(";")).toMatch(
      /background:\s*var\(--ui-sidebar\)/,
    );
  });
  test("inline code scales with the prose it sits in", () => {
    // Pinning inline code to a chrome step put it two sizes under 15px prose.
    // Relative keeps the proportion at any prose size.
    expect(rules(shellCss, ".aura-chat .agent-text code").join(";")).toMatch(
      /font-size:\s*0\.86em/,
    );
  });
});

// ── The second pass: icons, chips, rhythm, ink ─────────────────────────────
//
// The first pass settled the chat's GEOMETRY. What was still visibly wrong was
// everything drawn inside that geometry: the icons, the chips, the
// step-to-step spacing, and the number of ink steps. Same discipline — one
// name per metric on `.aura-chat`, no hard-coded hex in any declaration.

const toolCard = read("components/manager/chat/ToolCard.tsx");
const exploring = read("components/manager/chat/ExploringGroup.tsx");
const iconScale = read("components/chat/chatIconScale.ts");

describe("the measured icon scale", () => {
  test("the transcript runs on exactly two icon sizes", () => {
    // Measured by inverting lucide's (inkUnits + strokeWidth) / 24 * size:
    // the roll-up's terminal mark inks 10.5x9pt and its magnifier 11.5x11.5,
    // which both give 14; the footer's copy inks 14.5 square, which gives 16.
    expect(token(chatTokens, "--chat-icon")).toBe("14px");
    expect(token(chatTokens, "--chat-icon-action")).toBe("16px");
  });

  test("the SVG side and the CSS side cannot drift apart", () => {
    // SVG width/height/stroke-width are attributes, not styleable properties,
    // so the numbers have to exist in TS as well. That is two sources for one
    // metric unless something checks they agree — this is that something.
    const ts = (name: string) =>
      Number(iconScale.match(new RegExp(`${name} = ([0-9.]+)`))?.[1]);
    const css = (name: string) =>
      Number((token(chatTokens, name) ?? "").replace("px", ""));
    expect(ts("CHAT_ICON")).toBe(css("--chat-icon"));
    expect(ts("CHAT_ICON_ACTION")).toBe(css("--chat-icon-action"));
    expect(ts("CHAT_ICON")).toBe(css("--chat-icon-col"));
  });

  test("one stroke weight, scaled to whatever viewBox a glyph is drawn on", () => {
    // A column probe through the magnifier's ring reads a 2.0-2.3px stroke at
    // 2x retina — 1.0 to 1.15pt — against the 1.167 lucide draws at 14/2.
    // Our own glyphs are drawn on a 16 viewBox and the status marks on a 12,
    // so an unscaled 2 there would render a third and two thirds heavier
    // respectively than the lucide icon in the same row.
    expect(iconScale).toMatch(/CHAT_ICON_STROKE = 2/);
    expect(iconScale).toMatch(/CHAT_ICON_STROKE_16 = \(CHAT_ICON_STROKE \* 16\) \/ 24/);
    expect(iconScale).toMatch(/CHAT_ICON_STROKE_12 = \(CHAT_ICON_STROKE \* 12\) \/ 24/);
  });

  test("no glyph in the activity stream carries its own size or weight", () => {
    // One tool row once held a 13px/1.25 glyph, an 11px/1.5 chevron and a
    // 9px/1.7 status mark. The rows and groups are now the shared tool call
    // and tool group, which size their glyphs once.
    for (const src of [toolCard, exploring]) {
      expect(src).not.toMatch(/width=\{(9|11|13)\}/);
      expect(src).not.toMatch(/strokeWidth=\{1\.(25|5|7)\}/);
    }
    expect(toolCard).toMatch(/<ToolCall\b/);
    expect(exploring).toMatch(/<ToolGroup\b/);
    expect(exploring).toContain('from "../../ui/transcript-patterns"');
  });

  test("a turn footer's actions are the shared extra-small icon buttons", () => {
    // The turn's own actions (copy, the overflow menu) are drawn by one
    // footer component, on the shared icon button, rather than as hand-sized
    // glyphs in two places.
    const footer = read("components/ui/transcript-patterns.tsx");
    expect(footer).toMatch(/size="iconXs"/);
    expect(footer).toMatch(/aria-label="Message actions"/);
    const manager = read("components/manager/chat/ChatBubble.tsx");
    expect(manager).toContain("<TurnFooter");
    expect(existsSync(join(SRC, "components/ui/chat-turn-footer.tsx"))).toBe(false);
    expect(existsSync(join(SRC, "components/ui/chat-tool-group.tsx"))).toBe(false);
    expect(manager).not.toContain('<div className="aura-msg-actions">');
    expect(manager).not.toContain("function BubbleActions(");
  });

  test("the leading column is 14 + 7, and the expansion hangs off it", () => {
    // A 14px glyph on a 7px gap. It was 16 + 8, which pushed every tool row
    // one notch further from the prose than the row it is summarising.
    expect(token(chatTokens, "--chat-icon-col")).toBe("14px");
    expect(token(chatTokens, "--chat-icon-gap")).toBe("7px");
    expect(token(chatTokens, "--chat-detail-indent")).toBe(
      "calc(var(--chat-icon-col) + var(--chat-icon-gap))",
    );
    for (const sel of [".aura-chat .aura-tool-row", ".aura-chat .aura-tool-chip"]) {
      expect(rules(shellCss, sel).join(";")).toMatch(/gap:\s*var\(--chat-icon-gap\)/);
    }
    for (const sel of [".aura-chat .aura-tool-glyph", ".aura-chat .aura-msg-av"]) {
      const decl = rules(shellCss, sel).join(";");
      expect(decl).toMatch(/width:\s*var\(--chat-icon-col\)/);
      expect(decl).toMatch(/height:\s*var\(--chat-icon-col\)/);
    }
    // The revealed body of an expansion lines up with the verb above it, so
    // the indent is the same token and not a hand-added 24.
    const detail = rules(shellCss, ".aura-chat .aura-tool-detail").join(";");
    expect(detail).toMatch(/margin:\s*2px 0 4px var\(--chat-detail-indent\)/);
    expect(detail).not.toMatch(/24px/);
  });
});

describe("the measured chip", () => {
  test("one chip family: transparent, hairlined, 8px of side padding", () => {
    // The footer's file chips, the attachment chip inside a user bubble and an
    // inline code span are all one thing: 21px tall, no fill, one hairline,
    // 8px of side padding. Ours sat on --color-bg-2, which made three chips in
    // a row read as three buttons.
    expect(token(chatTokens, "--chat-chip-h")).toBe("21px");
    expect(token(chatTokens, "--chat-chip-pad-x")).toBe("8px");
    expect(token(chatTokens, "--chat-chip-radius")).toBe("4px");
    expect(token(chatTokens, "--chat-chip-gap")).toBe("9px");
    expect(token(chatTokens, "--chat-code-radius")).toBe("5px");

    const md = read("components/manager/chat/Markdown.tsx");
    expect(md).toMatch(/background:\s*"transparent"/);
    expect(md).toMatch(/border:\s*"1px solid var\(--chat-chip-line/);
    expect(md).toMatch(/padding:\s*"1px var\(--chat-chip-pad-x/);
    expect(md).not.toMatch(/background:\s*"var\(--color-bg-2\)",\n\s*padding:\s*"0 5px"/);
  });

  test("the chip's edge is an edge you can actually see", () => {
    // A 1px line needs about 1.85:1 against its ground to read as an edge.
    // Aura's --color-line on --color-bg-0 is 1.26:1 — under that point, so the
    // chips were there and you could not see them. 43% of --color-text-3 over
    // the pane lands on 1.86.
    const line = token(chatTokens, "--chat-chip-line") ?? "";
    expect(line).toMatch(/color-mix/);
    expect(line).toMatch(/var\(--color-text-3\)\s*43%/);
    expect(line).toMatch(/transparent/);
  });

  test("inline code in the transcript is framed, not filled or dimmed", () => {
    // Medusa's `Code` bakes its own fill and border, so without an override an
    // inline span was a filled slab while the file chip beside it — styled
    // from CHIP_BASE — was a transparent outline. Inline code is not dimmed
    // either: it is prose you can run, so it sits at the BODY ink.
    const inline = rules(
      shellCss,
      ".aura-chat .aura-md :not(pre) > code, .aura-chat .aura-md-symbol",
    ).join(";");
    expect(inline).toMatch(/background:\s*transparent/);
    expect(inline).toMatch(/border:\s*1px solid var\(--chat-chip-line\)/);
    expect(inline).toMatch(/border-radius:\s*var\(--chat-code-radius\)/);
    expect(inline).toMatch(/padding:\s*1px var\(--chat-chip-pad-x\)/);
    expect(inline).toMatch(/color:\s*var\(--color-text-1\)/);
    // A fenced block keeps its slab — the chip is for inline tokens only.
    expect(rules(shellCss, ".aura-chat .aura-md pre > code").join(";")).toMatch(
      /border:\s*0/,
    );
  });
});

describe("the measured rhythm", () => {
  test("turns are spaced by relation, not by one number", () => {
    // 14px from a roll-up to the answer it produced, 22 from a user bubble to
    // the roll-up answering it, 48 from one exchange to the next. That
    // doubling at each step is what makes a long conversation scan as turns
    // instead of as rows. Both transcripts used ONE gap for every join — 10px
    // and 12px — and read as a list.
    expect(token(chatTokens, "--chat-turn-gap")).toBe("48px");
    expect(token(chatTokens, "--chat-step-gap")).toBe("22px");
    expect(token(chatTokens, "--chat-answer-gap")).toBe("14px");

    for (const [css, scroll, child, bubble] of [
      [shellCss, ".aura-chat .p-scroll", ".aura-chat .p-scroll > * + *", '.aura-chat .p-scroll > *:has([data-message-role="user"])'],
      [chatView, ".chat-reading-column", ".chat-reading-column > * + *", '.chat-reading-column > *:has([data-message-role="user"])'],
    ] as const) {
      // The flat gap has to be gone, or it would stack with the margins.
      expect(rules(css, scroll).join(";")).toMatch(/gap:\s*0/);
      expect(rules(css, child).join(";")).toMatch(/margin-top:\s*var\(--chat-step-gap/);
      expect(rules(css, bubble).join(";")).toMatch(/margin-top:\s*var\(--chat-turn-gap/);
    }
  });
});

describe("the measured ink hierarchy", () => {
  test("there are two steps, and icons sit on the same one as their labels", () => {
    // The headline finding of this pass. Body ink at ~15:1 on the pane, and
    // EVERYTHING secondary — meta, the roll-up label, the roll-up's own ICONS,
    // chip text, the bullet marker — at ~7:1. Two steps, no third, and an icon
    // is never dimmer than the word next to it. Aura's --color-text-4 is
    // 2.43:1; wherever it appeared in the stream it was a step the hierarchy
    // does not have.
    for (const sel of [
      ".aura-chat .aura-tool-chip-aux",
      ".aura-chat .aura-tool-chip-metric",
      ".aura-chat .aura-md li::marker",
      ".aura-chat .agent-text li::marker",
    ]) {
      expect(rules(shellCss, sel).join(";")).toMatch(/color:\s*var\(--chat-meta-ink\)/);
    }
    // The roll-up's count was the loudest case: a text-4 numeral beside a
    // text-2 label, inside one row. The group now carries no ink of its own.
    expect(exploring).not.toMatch(/var\(--color-text-4\)/);
    expect(exploring).not.toMatch(/style=\{\{[^}]*color/);
  });
});

describe("what this pass did NOT measure", () => {
  test("the image treatment is derived and says so", () => {
    // Every other number in this file came from somewhere. This one did not:
    // nothing in the chat settled what an inline image should look like. So
    // the radius is reasoned from its nearest decided neighbour — the user
    // bubble it sits inside — rather than invented, and the token says that
    // out loud by pointing AT the bubble instead of restating 5px.
    expect(token(chatTokens, "--chat-media-radius")).toBe("var(--chat-bubble-radius)");
    expect(shellCss).toMatch(/DERIVED, not measured/);
    // One image treatment, not two. A tool card's screenshot and an attached
    // image are the same object and were drawn with different radii, borders
    // and plates.
    const media = rules(shellCss, ".aura-chat .chat-media").join(";");
    expect(media).toMatch(/border-radius:\s*var\(--chat-media-radius\)/);
    expect(media).toMatch(/border:\s*1px solid var\(--chat-chip-line\)/);
    expect(media).toMatch(/background:\s*transparent/);
    expect(toolCard).toMatch(/className="chat-media"/);
    expect(read("components/agent/normalized/NormalizedTranscript.tsx")).toMatch(
      /className="chat-media"/,
    );
  });
});

// ── The third pass: one model picker ───────────────────────────────────────
//
// The composer has exactly ONE dropdown at the bottom left, and it is the
// shared model picker itself — not a popover built to look like it. Model,
// effort and fast are its own rows; the panel, the search, the rows, the drag
// handles and the footer are the library's. What the chat adds is only data:
// the catalog turned into options, and what a pick does.

const composerCss = read("components/chat/ChatComposer.css");
const uiMenuCss = read("components/ui/interface.css");
const uiModelCss = read("components/ui/visual-refinements.css");
const libraryPicker = read("components/ui/model-picker.tsx");
const managerPicker = read("components/chat/model/ManagerModelPicker.tsx");
const agentPickers = read("components/chat/model/AgentModelPickers.tsx");
const catalogOptionsSrc = read("components/chat/model/catalogOptions.ts");

describe("the model picker is the library's", () => {
  test("every chat mounts the shared ModelPicker", () => {
    expect(managerPicker).toMatch(/<ModelPicker\b/);
    expect(agentPickers.match(/<ModelPicker\b/g)?.length ?? 0).toBeGreaterThanOrEqual(2);
    expect(read("components/manager/ManagerComposer.tsx")).toMatch(/<ManagerModelPicker\b/);
    expect(read("components/agent/chat/AgentChatComposer.tsx")).toMatch(/<AgentCliModelPicker\b/);
    expect(read("components/agent/StreamChatView.tsx")).toMatch(/<AgentTurnModelPicker\b/);
    // The OpenAI-compatible chat runs one configured model, and still shows it
    // in the same trigger rather than as a bare label.
    expect(read("components/agent/OpenAiCompatChatView.tsx")).toMatch(/<ModelPicker\b/);
  });

  test("the look-alike pickers and their rules are gone", () => {
    for (const rel of [
      "components/chat/ModelCatalogPopover.tsx",
      "components/chat/TurnModelControls.tsx",
      "components/chat/ModelLoadoutGroup.tsx",
      "components/chat/MenuRow.tsx",
      "components/manager/BrainPicker.tsx",
      "components/manager/BrainSwitcherModal.tsx",
    ]) {
      expect(existsSync(join(SRC, rel))).toBe(false);
    }
    expect(composerCss).not.toMatch(
      /chat-catalog-|chat-loadout-|composer-selector|composer-model-|chat-menu-|composer-compact-model-icon/,
    );
  });

  test("the panel is the library's model menu, at the library's width", () => {
    expect(libraryPicker).toMatch(/ui-model-menu/);
    const shared = rules(uiModelCss, ".ui-model-menu").join(";");
    expect(shared).toMatch(new RegExp(`width:\\s*${UI_GEOMETRY.modelMenu.width}px`));
    expect(UI_GEOMETRY.modelMenu.width).toBe(352);
    expect(rules(uiModelCss, ".ui-model-option").join(";")).toMatch(/min-height:\s*32px/);
  });

  test("/brain opens the same picker the click does", () => {
    expect(libraryPicker).toMatch(/open: openProp/);
    expect(libraryPicker).toMatch(/onOpenChange\?\.\(next\)/);
    expect(managerPicker).toMatch(/OPEN_BRAIN_PICKER_EVENT[\s\S]*setOpen\(true\)/);
    expect(managerPicker).toMatch(/open=\{open\}/);
  });

  test("the loadout is the picker's list, and Add models is the library's own dialog", () => {
    for (const src of [managerPicker, agentPickers]) {
      expect(src).toMatch(/useModelFavorites\(\)/);
      expect(src).toMatch(/onReorder=/);
      expect(src).toMatch(/onVisibleChange=/);
      // No jump out to Settings: Edit and Add models open the picker's dialog.
      expect(src).not.toMatch(/onEdit=/);
      expect(src).not.toContain('"aura.manager.modelFavorites"');
    }
    expect(managerPicker).toMatch(/shownLoadout\(favorites, ids, rows\)/);
  });
});

describe("the settings rows behind it", () => {
  test("the Effort ladder has five rungs, and says why not seven", () => {
    // `aura_agents::ReasoningEffort` is Low/Medium/High/Max plus the model's
    // own default, and Max already sends the same wire value as High for
    // Codex. A seven-rung ladder would be three more names for behaviour that
    // already exists under one.
    const ladder = catalogOptionsSrc.slice(
      catalogOptionsSrc.indexOf("export const EFFORT_LEVELS"),
      catalogOptionsSrc.indexOf("\n];"),
    );
    expect(ladder.match(/\bvalue: (null|")/g)?.length).toBe(5);
    expect(ladder).toMatch(/value: null, label: "Default"/);
    expect(ladder).not.toMatch(/label: "(Off|Extra high|Ultra)"/);
    expect(catalogOptionsSrc).toMatch(/A rung that lies about what it does/);
  });

  test("the trigger names the level, and the model's own default names nothing", () => {
    expect(catalogOptionsSrc).toMatch(/if \(effort == null\) return undefined;/);
    expect(catalogOptionsSrc).not.toMatch(/blurb/);
  });

  test("a model with no key is shown, and cannot be picked", () => {
    expect(catalogOptionsSrc).toMatch(/disabled: isUnusable\(row\.brain\)/);
  });
});

describe("the one control at the bottom left", () => {
  test("no composer renders a work-mode trigger of its own", () => {
    // `mode` is DATA now. A call site that passes a rendered control is the
    // second dropdown coming back.
    for (const rel of [
      "components/manager/ManagerComposer.tsx",
      "components/agent/normalized/NormalizedTranscript.tsx",
      "components/agent/chat/AgentChatComposer.tsx",
      "components/agent/OpenAiCompatChatView.tsx",
    ]) {
      expect(read(rel)).not.toMatch(/mode=\{</);
      expect(read(rel)).not.toMatch(/<ChatModePicker/);
    }
  });

  test("the work mode is a row in the shared add menu, in every composer that has one", () => {
    // It used to be claimed by the model menu, with a fallback for composers
    // that had none — two homes for one setting. The shared box puts it in the
    // add menu next to plan mode, so it is reachable wherever there is a box.
    for (const rel of [
      "components/manager/ManagerComposer.tsx",
      "components/agent/normalized/NormalizedTranscript.tsx",
      "components/agent/chat/AgentChatComposer.tsx",
    ]) {
      expect(read(rel)).toMatch(/<ComposerAddMenu[\s\S]*<ComposerTurnMenu[\s\S]*<\/ComposerAddMenu>/);
    }
    // The model picker claims no work mode of its own.
    expect(managerPicker).not.toMatch(/useClaimComposerMode|ComposerModeRow/);
    expect(agentPickers).not.toMatch(/useClaimComposerMode|ComposerModeRow/);
  });
});

describe("turn rhythm", () => {
  test("an agent reply sits the same 20px under the prompt as any message", () => {
    // The answer is a flex item, so its own formatting context: a first row's
    // margin (a tool call's 8px) cannot fold into the message's and stacks on
    // it instead. Zeroing the edge rows is what keeps the gap at 20.
    const css = read("components/ui/chat-surface.css");
    expect(rules(css, ".ui-chat-answer > :first-child").join(";")).toMatch(/margin-top:\s*0/);
    expect(rules(css, ".ui-chat-answer > :last-child").join(";")).toMatch(/margin-bottom:\s*0/);
  });
});

describe("the composer's last own parts are the shared ones", () => {
  test("steering a running turn wears the queue's own steer icon", () => {
    expect(read("components/ui/message-queue.tsx")).toMatch(/onClick=\{\(\) => onSteer\(item\)\}\s*>\s*<CornerUpLeft \/>/);
    const composer = read("components/manager/ManagerComposer.tsx");
    expect(composer).toMatch(/aria-label="Steer now"[\s\S]{0,200}<CornerUpLeft \/>/);
    expect(composer).not.toContain("CornerDownRight");
  });

  test("the editor's inline bar is the shared composer box", () => {
    const inline = read("components/editor/EditorInlineComposer.tsx");
    expect(inline).toContain('from "../ui/composer"');
    expect(inline).toMatch(/<Composer\b/);
    expect(inline).toMatch(/<ComposerAddMenu\b[\s\S]*<ComposerTurnMenu\b/);
    expect(inline).toContain("useComposerSuggestions(");
    // No second editor, frame or send button of its own.
    expect(inline).not.toContain("TiptapComposer");
    expect(inline).not.toContain("<button");
    expect(inline).not.toMatch(/rounded-xl|bg-bg-card|shadow-lg/);
    // What it sends and where is unchanged.
    expect(inline).toContain('new CustomEvent("aura:hand-task-to-agent"');
    expect(inline).toContain('const MODE_KEY = "aura.manager.mode"');
  });
});

describe("the manager session's own chrome is the shared parts", () => {
  const surface = () => read("components/manager/ManagerSurface.tsx");

  test("opening, broken and gone are the shared states", () => {
    const src = surface();
    expect(src).toMatch(/<LoadingState\s[\s\S]*label=\{`Loading conversation…/);
    expect(src).toMatch(/<ErrorState\s[\s\S]*onRetry=\{retry\}[\s\S]*retrying=\{retrying\}/);
    expect(src).toMatch(/<EmptyState\s[\s\S]*title="This conversation is gone"/);
    // No hand-built copy box for the backend line: it is the state's footnote.
    expect(src).not.toContain("font-mono text-[11px]");
  });

  test("the header's buttons and menu are library buttons and the library menu", () => {
    const src = surface();
    expect(src).not.toContain('className="icon-btn"');
    expect(src).not.toContain("<svg");
    expect(src).not.toContain("useDismiss");
    expect(src).not.toMatch(/function MenuItem\b/);
    expect(src).toMatch(/<DropdownMenuCheckboxItem checked=\{showDetails\}/);
    expect(src).toMatch(/<DropdownMenuItem variant="destructive"[\s\S]{0,120}Cancel session/);
    expect(read("components/agent/chatView.css")).not.toContain(".manager-chat-heading .icon-btn");
  });

  test("details and loop are the task detail's side column", () => {
    const src = surface();
    expect(src).not.toMatch(/w-\[360px\]|w-\[320px\]/);
    expect(src.match(/<aside className="ui-tasks-detail-aside"/g)).toHaveLength(2);
    expect(src).toMatch(/<TaskDetailSection title="Tasks"[\s\S]*<TaskDetailSection title="Activity"/);
  });

  test("a task is a board card with the board's status glyph, facts and menu", () => {
    const src = surface();
    expect(src).toMatch(/<TaskBoardCard\b[\s\S]*<TaskCardContent\b/);
    expect(src).toContain("<TaskStatusBadge {...TASK_STAGE[task.status]} />");
    expect(src).toMatch(/<TaskFact tone="alert"/);
    expect(src).not.toMatch(/TASK_BORDER|TASK_DOT|StatusChip/);
    // Votes and the task menu are library buttons; Reassign is a submenu
    // that only asks for agents once it opens.
    expect(src).toMatch(/aria-label="Thumbs up"/);
    expect(src).toMatch(/<DropdownMenuSub onOpenChange=\{loadAgents\}>/);
    expect(src).not.toContain('className="block w-full text-left');
  });

  test("the task drawer and the event log are the shared parts", () => {
    const src = surface();
    expect(src).toContain("<Textarea");
    expect(src).not.toContain("<textarea");
    expect(src).toContain('<CodeMessage language="Output">');
    expect(src).toContain("<Timeline entries={entries} />");
    expect(src).not.toContain("<ol ");
    // The usage pill is the library badge.
    expect(src).toMatch(/<Badge variant="outline" title=\{tooltip\}/);
  });
});
