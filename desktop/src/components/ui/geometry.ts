export const UI_GEOMETRY = {
  control: { xs: 24, sm: 28, default: 32, lg: 44 },
  modelMenu: { width: 352, maxHeight: 448, viewportInset: 120 },
  menu: { width: 200, compactWidth: 180, sideOffset: 4, collisionPadding: 8 },
  sidebar: { defaultWidth: 256, minimumWidth: 192, maximumWidth: 480 },
  radius: { xs: 2, sm: 4, md: 6, lg: 8, xl: 12 },
  icon: { small: 12, default: 16, stroke: 1 },
  transition: { fast: 150, normal: 200 },
} as const;
