// Recipe Box — cards, theme, search, and favorite stars (persisted).

// --- Favorites persistence: load once, save on every change.
function loadFavorites() {
  try {
    return JSON.parse(localStorage.getItem("recipe-favs") || "[]");
  } catch {
    return [];
  }
}

function saveFavorites() {
  localStorage.setItem("recipe-favs", JSON.stringify(FAVORITES));
}

let FAVORITES = loadFavorites();

function buildRecipeCardElement(recipe) {
  const card = document.createElement("article");
  card.className = "recipe";
  const starred = FAVORITES.includes(recipe.name);
  card.innerHTML =
    '<h3>' + recipe.name + '</h3>' +
    '<p class="meta">' + recipe.minutes + ' min</p>' +
    '<span class="tag">' + recipe.tag + '</span>' +
    '<button class="fav">' + (starred ? '★' : '☆') + '</button>';
  card.querySelector(".fav").addEventListener("click", () => toggleFavorite(recipe.name));
  return card;
}

function renderRecipes(list) {
  const grid = document.getElementById("recipe-grid");
  grid.innerHTML = "";
  for (const recipe of list) {
    grid.appendChild(buildRecipeCardElement(recipe));
  }
}

function toggleFavorite(name) {
  const i = FAVORITES.indexOf(name);
  if (i === -1) FAVORITES.push(name);
  else FAVORITES.splice(i, 1);
  saveFavorites();
  renderRecipes(RECIPES);
}

// --- Search.
function filterRecipes(query) {
  const q = query.trim().toLowerCase();
  return RECIPES.filter(
    (r) => r.name.toLowerCase().includes(q) || r.tag.toLowerCase().includes(q)
  );
}

function setupSearch() {
  const box = document.getElementById("search");
  box.addEventListener("input", () => renderRecipes(filterRecipes(box.value)));
}

// --- Theme.
function applyTheme(mode) {
  document.body.classList.toggle("dark", mode === "dark");
}

function saveThemePreference(mode) {
  localStorage.setItem("recipe-theme", mode);
}

function loadThemePreference() {
  return localStorage.getItem("recipe-theme") || "light";
}

function toggleTheme() {
  const next = document.body.classList.contains("dark") ? "light" : "dark";
  applyTheme(next);
  saveThemePreference(next);
}

function setupThemeToggle() {
  applyTheme(loadThemePreference());
  document.getElementById("theme-toggle").addEventListener("click", toggleTheme);
}

renderRecipes(RECIPES);
setupThemeToggle();
setupSearch();
