// The shared work-board design system — BOTH layouts.
//
// Every surface in the app that renders work items — the Tasks board's list,
// board and sprint views, Mission Control / Crew's activity list and stage
// board, the Workspaces board, the right-rail peek — renders through these
// components, so the look changes in one place.
//
// "Board" here names the *system*, not just the kanban: it covers the lane
// layout (`BoardFrame` / `BoardColumn`), the grouped list layout
// (`BoardListGroup` / `BoardListRow`), the card and chip grammar both share,
// and the switch between them (`BoardLayoutSwitch`). `StateGlyph` is
// re-exported here (it lives with the state pill it was built for) so a
// surface only ever needs to import from `components/board`.

export {
  BOARD_CARD_GAP,
  BOARD_CARD_META_ROW,
  BOARD_CARD_SHELL,
  BOARD_CARD_TITLE,
  BOARD_CHIP,
  BOARD_COLUMN_COLLAPSED_WIDTH,
  BOARD_COLUMN_DRAG_OVER,
  BOARD_COLUMN_GAP,
  BOARD_COLUMN_HEADER,
  BOARD_COLUMN_MIN_BODY,
  BOARD_COLUMN_SHELL,
  BOARD_COLUMN_TITLE,
  BOARD_COLUMN_WIDTH,
  BOARD_DROP_CAP,
  BOARD_FRAME_PADDING_X,
  BOARD_FRAME_PADDING_Y,
} from "./boardTokens";

export { BoardCount, BoardEmptyHint, BoardFrame } from "./BoardFrame";
// The empty states are the app's, not the board's — they moved to
// `ui/state.tsx` alongside loading and error, because five non-board surfaces
// wrote their own rather than import something called `BoardEmpty`. Board call
// sites keep the board names.
export {
  EmptyState as BoardEmpty,
  FilteredEmptyState as BoardFilteredEmpty,
} from "../ui/state";
export { BoardColumn } from "./BoardColumn";
export { BoardListGroup, BoardListRow } from "./BoardList";
export {
  BOARD_LAYOUT_OPTIONS,
  BoardLayoutSwitch,
  useBoardLayout,
  usePersistedLayout,
  type BoardLayout,
  type BoardLayoutOption,
} from "./BoardLayoutSwitch";
export { BOARD_QUICK_ADD_ATTR, BoardQuickAdd } from "./BoardQuickAdd";
export {
  BoardCard,
  BoardCardHandle,
  BoardCardHeader,
  BoardCardLabel,
  BoardCardLabels,
  BoardCardMeta,
  BoardCardMetaRow,
  BoardCardPriority,
  BoardCardTitle,
  type BoardCardOpenEvent,
} from "./BoardCard";
export { StateGlyph } from "../tasks/StatePill";
