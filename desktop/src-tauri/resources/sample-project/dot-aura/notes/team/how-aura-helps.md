---
{"title": "How Aura helps — the honest version", "author": "aura", "created_at": "{{ISO_MINUS_2D}}", "updated_at": "{{ISO_MINUS_20M}}", "tags": ["start-here", "why-aura"], "visibility": "shared"}
---

# How Aura helps — the honest version

You're letting an AI write your code. Four worries come with that, and Aura
answers each one. Everything below already happened in *this* Recipe Box —
open the **Trace** tab and you can see it for yourself.

## 1. "Did the AI actually do what I asked — not more, not less?"

Before it edits, the agent says which files it's going to touch. When it
commits, Aura compares what it *said* against what it *did*.

That already caught something here. When Claude added the favourite ⭐ button,
it said it would only change the recipe display — but to make favourites stick,
it also quietly changed the recipe list. **Aura noticed and flagged it.** Not to
punish anyone — the change was fine — but so nothing slips in unseen. On the
very next change the agent declared *both* files up front, and the flag went
away. That's the whole point: you get told when the AI colours outside the
lines, every time.

Aura also checks that the *words* of your request line up with the *parts of the
code that changed* — a green "Matches", an amber "Needs review", or a red "No
clear match" on each change.

## 2. "Is it actually finished, or does it just look finished?"

This is the one AI gets wrong most. It says "Done!" and moves on. Aura checks
the code itself instead of taking the AI's word.

Open the **Plan** tab and look at the dark-mode goal. Aura reads the real code
and confirms the pieces a working dark mode needs are all there and connected —
so it reads **"Done — 3 of 3 parts."** Not because the AI claimed it; because
the code backs it up.

Right below it, the "search by ingredient" goal reads **"Almost — 1 of 2
parts."** The search box exists, but matching on ingredients was never built.
Aura won't let that hide behind a hopeful "done."

**Where we're honest with you:** this check confirms the code is *built and
wired together correctly* — it doesn't run the app for you. So each goal also
carries a short plain-language checklist ("tap the moon button, the page turns
dark") for the one thing only a human can confirm: that it *feels* right when
you actually use it. Aura tells you what it can prove, and is clear about what
it can't.

## 3. "Can I understand what changed — and undo it if it breaks?"

Every change gets a plain sentence — what changed and why — written for a person,
not a programmer. No function names, no jargon. The technical detail is still
there if you ever want it, tucked one click away, but you never *need* it.

The **Trace** tab is the whole story of the project in plain words: every change,
the reason behind it, who made it, and a tamper-proof record that it hasn't been
edited since. You can hand this to anyone and they'll understand what your AI has
been doing.

And when a change goes wrong, you don't have to undo everything to fix it. Open
the **Time machine**, find the moment the AI added the favourite ⭐ to your recipe
cards, and press **Bring this back** — it puts *just that one piece* back the way
it was, and leaves the rest of your work exactly as it is. Aura saves a copy first,
so even the undo is undoable. No lost work, no untangling a mess: one wrong piece,
put back, safely.

## 4. "Is this burning through my tokens?"

When the AI needs to know something about your code, Aura answers from a map it
keeps — "this function lives here, and here's what uses it" — instead of feeding
whole files into the AI over and over. Every time it does that, it shows you a
rough **"saved ~N tokens"** so you can see it working. It's an honest estimate,
labelled as one — not a made-up headline number.

---

*Aura's promise isn't "the AI is always right." It's "you always know the
truth" — what it changed, whether it's really done, and what it cost.*
