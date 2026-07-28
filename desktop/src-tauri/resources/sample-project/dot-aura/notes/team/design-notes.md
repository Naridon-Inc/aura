---
{"title": "Design notes — colours & dark mode", "author": "maya", "created_at": "{{ISO_MINUS_1D}}", "updated_at": "{{ISO_MINUS_1D}}", "tags": ["design", "dark-mode"], "visibility": "shared"}
---

# Design notes — colours & dark mode

A few decisions worth remembering, so the next change keeps the same feel.

## Keep it warm

Recipe Box should feel like a kitchen, not a code editor. The light theme is a
warm cream with a terracotta accent. When we added dark mode we gave it its
**own** warm palette rather than just inverting the light one — a cold grey dark
theme looked clinical.

## One accent

Everything interactive uses the single terracotta accent. If a new button needs
attention, reach for the accent before adding another colour.

## Themes live in one place

All colours are CSS variables at the top of `styles.css`, defined twice — once
for light, once for `[data-theme="dark"]`. To retheme, change the variables; you
shouldn't need to touch the components.
