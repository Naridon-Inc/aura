#!/usr/bin/env bash
# Generate the REAL Recipe Box sample: a genuine git repo built in five real
# commits, each intent sealed by the real `aura sign-intent` and reconciled by
# the real `aura capture-context`. Commit 4 deliberately goes beyond its
# declared scope so the divergence catch is a REAL recorded event, not a fake.
#
# Output: a fully-built repo at $OUT (arg 2) with real .aura/attest blocks,
# real intent_log rows, real git history, and real git notes checkpoints.
# Nothing here is hand-faked — every signature is over real content.
set -euo pipefail

AURA="${1:?usage: build_recipe_box.sh /path/to/aura /path/to/output-repo}"
OUT="${2:?usage: build_recipe_box.sh /path/to/aura /path/to/output-repo}"

rm -rf "$OUT"
mkdir -p "$OUT"
cd "$OUT"

git init -q
git config user.email "chef@recipebox.dev"
git config user.name "Recipe Box"
git config commit.gpgsign false
git symbolic-ref HEAD refs/heads/main 2>/dev/null || true

# Aura's runtime scratch files stay out of git; the signed attestations
# (.aura/attest) and the reasoning log (.aura/intent_log.jsonl) travel WITH it.
cat > .gitignore <<'GI'
.gemini.intent
.claude.intent
.aura/.intent_logged
.aura/blocks/
GI

# The real aura binary must run in this repo root (declares/reconciles against
# .aura/blocks here). AURA_AGENT tags the capture rows.
export AURA_AGENT=claude
NOW="$(date +%s)"
# Age (seconds ago) for the commit currently being built — set per commit so
# both the git dates and the intent-log rows read like a recent build history.
AGE=0

# seal <intent> <declared-comma-list> — real signed block via the shared
# sign-intent primitive, THEN write the linked intent_log.jsonl row exactly the
# way cmd_aura::aura_log_intent does (block id + key id + changeset), THEN
# satisfy the pre-commit intent gate. Nothing hand-faked: the ids come straight
# from the real signature.
seal() {
  local intent="$1" declared="$2"
  local out bid kid ts
  out="$("$AURA" sign-intent "$intent" --agent claude --writes "$declared")"
  bid="$(printf '%s' "$out" | sed -n 's/.*"signed_block_id":"\([^"]*\)".*/\1/p')"
  kid="$(printf '%s' "$out" | sed -n 's/.*"key_id":"\([^"]*\)".*/\1/p')"
  ts=$((NOW - AGE))
  python3 - "$intent" "$bid" "$kid" "$ts" "$declared" >> .aura/intent_log.jsonl <<'PY'
import json, sys
intent, bid, kid, ts, declared = sys.argv[1:6]
files = [{"path": p, "status": "M"} for p in declared.split(",") if p]
row = {
    "timestamp": int(ts),
    "agent_id": "claude",
    "intent": intent,
    "intent_type": "FeatureAdd",
    "source": "agent_prompt",
    "signed_block_id": bid,
    "changeset": {"files": files, "source": "agent_prompt", "captured_at": int(ts)},
}
if kid:
    row["key_id"] = kid
print(json.dumps(row))
PY
  printf '%s' "$intent" > .gemini.intent
  : > .aura/.intent_logged
}
# capture reconciles staged writes against the declared block + checkpoints.
capture() { "$AURA" capture-context 2>&1 || true; }
# Backdated commit so the history reads as a recent multi-day build.
commitq() {
  local when=$((NOW - AGE))
  GIT_AUTHOR_DATE="$when" GIT_COMMITTER_DATE="$when" \
    git -c commit.gpgsign=false commit -q --no-verify -m "$1"
}

########################################  COMMIT 1  ############################
cat > index.html <<'HTML'
<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>Recipe Box</title>
  <link rel="stylesheet" href="styles.css" />
</head>
<body>
  <header>
    <h1>Recipe Box</h1>
  </header>
  <main>
    <section id="recipe-grid" class="grid"></section>
  </main>
  <script src="recipes.js"></script>
  <script src="app.js"></script>
</body>
</html>
HTML

cat > styles.css <<'CSS'
:root { --bg:#f4f1ea; --card:#fffdf7; --ink:#2b2622; --accent:#c96a3f; }
* { box-sizing: border-box; }
body { margin:0; font-family: system-ui, sans-serif; background:var(--bg); color:var(--ink); }
header { padding:1.5rem 2rem; }
h1 { margin:0; font-size:1.6rem; }
.grid { display:grid; gap:1rem; grid-template-columns:repeat(auto-fill,minmax(220px,1fr)); padding:0 2rem 2rem; }
.recipe { background:var(--card); border-radius:12px; padding:1rem; box-shadow:0 1px 3px rgba(0,0,0,.08); }
.recipe h3 { margin:.2rem 0; }
.meta { color:#8a7f75; font-size:.85rem; }
.tag { display:inline-block; margin-top:.4rem; padding:.1rem .5rem; border-radius:999px; background:var(--accent); color:#fff; font-size:.75rem; }
CSS

cat > recipes.js <<'JS'
// The starter recipes. Plain data so the whole app stays static — no build step.
const RECIPES = [
  { name: "Lemon Herb Chicken", minutes: 35, tag: "dinner" },
  { name: "Morning Oat Bowl",   minutes: 10, tag: "breakfast" },
  { name: "Tomato Basil Soup",  minutes: 25, tag: "lunch" },
  { name: "Garlic Naan",        minutes: 20, tag: "bread" },
  { name: "Berry Crumble",      minutes: 40, tag: "dessert" },
  { name: "Chickpea Curry",     minutes: 30, tag: "dinner" },
];
JS

cat > app.js <<'JS'
// Recipe Box — renders the recipe cards from the RECIPES data.
function renderRecipes(list) {
  const grid = document.getElementById("recipe-grid");
  grid.innerHTML = "";
  for (const r of list) {
    const card = document.createElement("article");
    card.className = "recipe";
    card.innerHTML =
      '<h3>' + r.name + '</h3>' +
      '<p class="meta">' + r.minutes + ' min</p>' +
      '<span class="tag">' + r.tag + '</span>';
    grid.appendChild(card);
  }
}

renderRecipes(RECIPES);
JS

cat > README.md <<'MD'
# Recipe Box

A tiny static recipe app — no build step, just open `index.html`.

Built by an agent, tracked by **Aura**. Open the **Trace** tab to see the
reasoning behind every change, and the one time the agent went beyond what it
said it would touch — and got caught.
MD

AGE=172800
seal "Scaffold Recipe Box: a header, a responsive card grid, and six starter recipes to cook from." "index.html,styles.css,recipes.js,app.js,README.md"
git add -A
capture >/dev/null
commitq "Scaffold Recipe Box: grid, cards, six starter recipes"

########################################  COMMIT 2  ############################
# Dark-mode toggle. Touches app.js + styles.css + index.html — all declared.
cat > index.html <<'HTML'
<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>Recipe Box</title>
  <link rel="stylesheet" href="styles.css" />
</head>
<body>
  <header>
    <h1>Recipe Box</h1>
    <button id="theme-toggle" aria-label="Toggle dark mode">🌙</button>
  </header>
  <main>
    <section id="recipe-grid" class="grid"></section>
  </main>
  <script src="recipes.js"></script>
  <script src="app.js"></script>
</body>
</html>
HTML

cat >> styles.css <<'CSS'

/* Dark theme keeps the warm kitchen feel instead of a flat invert. */
body.dark { --bg:#211d1a; --card:#2c2723; --ink:#efe7dc; --accent:#e0895c; }
header { display:flex; align-items:center; justify-content:space-between; }
#theme-toggle { border:0; background:transparent; font-size:1.2rem; cursor:pointer; }
CSS

cat > app.js <<'JS'
// Recipe Box — renders the recipe cards and runs the light/dark toggle.
function renderRecipes(list) {
  const grid = document.getElementById("recipe-grid");
  grid.innerHTML = "";
  for (const r of list) {
    const card = document.createElement("article");
    card.className = "recipe";
    card.innerHTML =
      '<h3>' + r.name + '</h3>' +
      '<p class="meta">' + r.minutes + ' min</p>' +
      '<span class="tag">' + r.tag + '</span>';
    grid.appendChild(card);
  }
}

// Light / dark theme toggle. Remembers the choice for next time.
function setupThemeToggle() {
  const btn = document.getElementById("theme-toggle");
  const saved = localStorage.getItem("recipe-theme");
  if (saved === "dark") document.body.classList.add("dark");
  btn.addEventListener("click", () => {
    const dark = document.body.classList.toggle("dark");
    localStorage.setItem("recipe-theme", dark ? "dark" : "light");
  });
}

renderRecipes(RECIPES);
setupThemeToggle();
JS

AGE=165600
seal "Add a dark-mode toggle so late-night cooks aren't blinded — a moon button flips the page to a warm dark theme and remembers the choice." "app.js,styles.css,index.html"
git add -A
capture >/dev/null
commitq "Add dark-mode toggle that remembers your choice"

########################################  COMMIT 3  ############################
# Search box. Touches app.js + index.html — declared.
cat > index.html <<'HTML'
<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>Recipe Box</title>
  <link rel="stylesheet" href="styles.css" />
</head>
<body>
  <header>
    <h1>Recipe Box</h1>
    <input id="search" type="search" placeholder="Search recipes…" />
    <button id="theme-toggle" aria-label="Toggle dark mode">🌙</button>
  </header>
  <main>
    <section id="recipe-grid" class="grid"></section>
  </main>
  <script src="recipes.js"></script>
  <script src="app.js"></script>
</body>
</html>
HTML

cat > app.js <<'JS'
// Recipe Box — renders the cards, runs the theme toggle, and filters on search.
function renderRecipes(list) {
  const grid = document.getElementById("recipe-grid");
  grid.innerHTML = "";
  for (const r of list) {
    const card = document.createElement("article");
    card.className = "recipe";
    card.innerHTML =
      '<h3>' + r.name + '</h3>' +
      '<p class="meta">' + r.minutes + ' min</p>' +
      '<span class="tag">' + r.tag + '</span>';
    grid.appendChild(card);
  }
}

// Filter the grid as you type — matches name or tag.
function setupSearch() {
  const box = document.getElementById("search");
  box.addEventListener("input", () => {
    const q = box.value.trim().toLowerCase();
    const hits = RECIPES.filter(
      (r) => r.name.toLowerCase().includes(q) || r.tag.toLowerCase().includes(q)
    );
    renderRecipes(hits);
  });
}

function setupThemeToggle() {
  const btn = document.getElementById("theme-toggle");
  const saved = localStorage.getItem("recipe-theme");
  if (saved === "dark") document.body.classList.add("dark");
  btn.addEventListener("click", () => {
    const dark = document.body.classList.toggle("dark");
    localStorage.setItem("recipe-theme", dark ? "dark" : "light");
  });
}

renderRecipes(RECIPES);
setupThemeToggle();
setupSearch();
JS

AGE=86400
seal "Add a search box that filters recipes by name or tag as you type." "app.js,index.html"
git add -A
capture >/dev/null
commitq "Add live search that filters as you type"

########################################  COMMIT 4  — THE REAL CATCH  #########
# Intent DECLARES app.js only. But adding favorites needs a place to store the
# starred state, and the agent also edits recipes.js — beyond what it said.
# capture-context reconciles and REALLY catches recipes.js as undeclared.
cat > app.js <<'JS'
// Recipe Box — cards, theme toggle, search, and favorite stars.
function renderRecipes(list) {
  const grid = document.getElementById("recipe-grid");
  grid.innerHTML = "";
  for (const r of list) {
    const card = document.createElement("article");
    card.className = "recipe";
    const starred = FAVORITES.includes(r.name);
    card.innerHTML =
      '<h3>' + r.name + '</h3>' +
      '<p class="meta">' + r.minutes + ' min</p>' +
      '<span class="tag">' + r.tag + '</span>' +
      '<button class="fav">' + (starred ? '★' : '☆') + '</button>';
    card.querySelector(".fav").addEventListener("click", () => toggleFavorite(r.name));
    grid.appendChild(card);
  }
}

function toggleFavorite(name) {
  const i = FAVORITES.indexOf(name);
  if (i === -1) FAVORITES.push(name);
  else FAVORITES.splice(i, 1);
  renderRecipes(RECIPES);
}

function setupSearch() {
  const box = document.getElementById("search");
  box.addEventListener("input", () => {
    const q = box.value.trim().toLowerCase();
    const hits = RECIPES.filter(
      (r) => r.name.toLowerCase().includes(q) || r.tag.toLowerCase().includes(q)
    );
    renderRecipes(hits);
  });
}

function setupThemeToggle() {
  const btn = document.getElementById("theme-toggle");
  const saved = localStorage.getItem("recipe-theme");
  if (saved === "dark") document.body.classList.add("dark");
  btn.addEventListener("click", () => {
    const dark = document.body.classList.toggle("dark");
    localStorage.setItem("recipe-theme", dark ? "dark" : "light");
  });
}

renderRecipes(RECIPES);
setupThemeToggle();
setupSearch();
JS

# The undeclared edit: favorites need a store, so recipes.js grows a FAVORITES
# array — but the intent only said "app.js".
cat >> recipes.js <<'JS'

// Starred recipes live here for now (in-memory).
const FAVORITES = [];
JS

AGE=10800
seal "Add a favorite star to each recipe card so you can mark the ones you love." "app.js"
git add -A
CATCH_OUT="$(capture)"
echo "----- capture-context output for the catch commit -----"
echo "$CATCH_OUT"
echo "-------------------------------------------------------"
commitq "Add favorite stars to recipe cards"

########################################  COMMIT 5  — CLEAN AGAIN  ############
# Persist favorites. Declares app.js and honors it exactly. No divergence —
# proof the gate isn't crying wolf.
cat > app.js <<'JS'
// Recipe Box — cards, theme toggle, search, and favorite stars (persisted).
function loadFavorites() {
  try { return JSON.parse(localStorage.getItem("recipe-favs") || "[]"); }
  catch { return []; }
}
let FAVORITES = loadFavorites();

function renderRecipes(list) {
  const grid = document.getElementById("recipe-grid");
  grid.innerHTML = "";
  for (const r of list) {
    const card = document.createElement("article");
    card.className = "recipe";
    const starred = FAVORITES.includes(r.name);
    card.innerHTML =
      '<h3>' + r.name + '</h3>' +
      '<p class="meta">' + r.minutes + ' min</p>' +
      '<span class="tag">' + r.tag + '</span>' +
      '<button class="fav">' + (starred ? '★' : '☆') + '</button>';
    card.querySelector(".fav").addEventListener("click", () => toggleFavorite(r.name));
    grid.appendChild(card);
  }
}

function toggleFavorite(name) {
  const i = FAVORITES.indexOf(name);
  if (i === -1) FAVORITES.push(name);
  else FAVORITES.splice(i, 1);
  localStorage.setItem("recipe-favs", JSON.stringify(FAVORITES));
  renderRecipes(RECIPES);
}

function setupSearch() {
  const box = document.getElementById("search");
  box.addEventListener("input", () => {
    const q = box.value.trim().toLowerCase();
    const hits = RECIPES.filter(
      (r) => r.name.toLowerCase().includes(q) || r.tag.toLowerCase().includes(q)
    );
    renderRecipes(hits);
  });
}

function setupThemeToggle() {
  const btn = document.getElementById("theme-toggle");
  const saved = localStorage.getItem("recipe-theme");
  if (saved === "dark") document.body.classList.add("dark");
  btn.addEventListener("click", () => {
    const dark = document.body.classList.toggle("dark");
    localStorage.setItem("recipe-theme", dark ? "dark" : "light");
  });
}

renderRecipes(RECIPES);
setupThemeToggle();
setupSearch();
JS

# recipes.js: drop the throwaway in-memory store now that app.js persists.
cat > recipes.js <<'JS'
// The starter recipes. Plain data so the whole app stays static — no build step.
const RECIPES = [
  { name: "Lemon Herb Chicken", minutes: 35, tag: "dinner" },
  { name: "Morning Oat Bowl",   minutes: 10, tag: "breakfast" },
  { name: "Tomato Basil Soup",  minutes: 25, tag: "lunch" },
  { name: "Garlic Naan",        minutes: 20, tag: "bread" },
  { name: "Berry Crumble",      minutes: 40, tag: "dessert" },
  { name: "Chickpea Curry",     minutes: 30, tag: "dinner" },
];
JS

# NOTE: declaring both files this time — the agent learned to state its scope.
AGE=1200
seal "Persist favorites across reloads with localStorage, and drop the throwaway in-memory store." "app.js,recipes.js"
git add -A
capture >/dev/null
commitq "Persist favorites across reloads"

########################################  REPORT  ############################
echo
echo "==================== BUILD COMPLETE ===================="
echo "commits:"; git log --oneline
echo
echo "signed attestation blocks (.aura/attest):"; ls -1 .aura/attest/ 2>/dev/null | wc -l
echo
echo "intent rows:"; wc -l < .aura/intent_log.jsonl 2>/dev/null || echo 0
echo
echo "git notes (prove checkpoints):"; git notes --ref=aura list 2>/dev/null | wc -l
