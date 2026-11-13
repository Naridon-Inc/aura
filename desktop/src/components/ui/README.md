# Shared desktop interface

The shared React layer owns compact controls, floating surfaces, workspace compositions, and the semantic color system. Import named components from an individual module or from `components/ui/index`.

## Foundations

`interface.css` is imported once by `src/styles.css`. It defines the dark, light, and low-contrast dark appearances and maps existing shell color roles into the shared system. `palette.css` contains the complete semantic color roles, including diffs, statuses, terminal colors, and elevated surfaces. `geometry.ts` exposes the measured control and panel dimensions.

- System sans for interface text; Geist Mono for code and terminals.
- Controls at 24, 28, 32, and 44 px, with 16 px icons.
- Floating context menus at 200 px; custom content can override width.
- Both sidebar sides support controlled or local widths, pointer resizing, and arrow-key resizing. Home/End use the configured limits; double-click restores the default.
- Menus use Radix collision handling and portal focus management. Compose nested menus from the same menu family.

## Components

| Area                | Exports                                                                                                                                                                                                                                      |
| ------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Controls            | Button, Input, Textarea, Select, Checkbox, Switch, Label, Slider, Toggle, ToggleGroup                                                                                                                                                        |
| Floating surfaces   | Dialog, AlertDialog, Popover, DropdownMenu, ContextMenu, Tooltip, HoverCard, Command, Sheet, Drawer                                                                                                                                          |
| Content             | Badge, Card, Alert, Avatar, Code, Table, Tabs, Accordion, Separator, ScrollArea, Progress, Skeleton                                                                                                                                          |
| Navigation          | Sidebar and its slots, NavigationGroups, SidebarGroup, SidebarItem, DiffCount, FileTree, WorkspaceTabs, WorkspacePanels, WorkspaceActionsMenu, WorkspaceActivityBadge, WorkspaceStatusIcon                                                   |
| Chat                | Message, MessageMarkdown, ConversationView, MessageActions, ToolCall, ToolGroup, SubagentRun, ThinkingMessage, TurnFooter, TranscriptSearch, HistoryGap, CompactionSummary, ChatRecovery, SessionBanner, ResetChatDialog, UnsupportedMessage |
| Composition         | Composer, ModelPicker, MessageQueue, PermissionRequest, QuestionRequest, PlanReview, ContextUsageIndicator, McpStatusMenu, ComposerAddMenu, AutoAcceptControl, TerminalCommandNotice                                                         |
| Artifacts and files | ArtifactFrame, ArtifactView, ArtifactBrowser, WorkspaceArtifacts, ArtifactTemplateEditor, ArtifactDeleteDialog, FilePreview, FileDiff, ChangeScopeToolbar, CheckRunList                                                                      |
| Tasks               | TaskList, TaskPanel, TaskManager, TaskEditor, TaskDetails, BackgroundTask, RunningTasksDialog, Timeline                                                                                                                                      |
| Settings            | SettingsLayout, SettingsSection, SettingsRow, SettingsField, SettingsScopeSwitch, KeyboardShortcutEditor, ModelLoadout, ProviderSettings, EnvironmentSettings                                                                                |

AsciiSpinner is the shared six-cell activity matrix. WorkspaceStatusIcon maps lifecycle, attention, and Git states to distinct symbols; a small dot is reserved for unread activity. Skeletons indicate content placement while data is loading.

## Component contracts

Stateful product operations remain with the caller. Composer emits text/file/send/stop callbacks; TaskPanel emits status changes; FileTree emits a selected node. These components do not call an agent, mutate a repository, or invent network results.

The file tree implements a single tab stop, arrow navigation, folder expansion/collapse, Home/End, Enter/Space selection, and typeahead. Give every node a stable unique ID.

Artifact HTML runs in a sandboxed iframe without same-origin access. Scripts can operate inside the artifact but cannot access the surrounding app's storage or DOM. Download exports the selected version's supplied content.

## Live preview

Open `/src/components/ui/__harness__/library.html` on the development server. It mounts the production primitives with explicitly local sample data. The preview provides both sidebars, the composed workspace, full-page settings, a control gallery, and five interaction galleries: Composer, Transcript, Workspace, Artifacts, and Settings. Each gallery includes state switches and working local callbacks for testing. General and appearance preferences are stored under `ui-library.preferences`, separate from product preferences. Sample model loadouts and environment variables remain in memory.

The terminal is an appearance specimen. The preview does not run shell commands, call an agent, or connect a collaboration service. Domain views still need to adopt the new larger compositions; importing the shared palette alone does not replace their structure.

## Validation

Run `npx tsc --noEmit` and `bun test` from `aura-shell`. Browser checks cover overlay focus and Escape, command search, submenu navigation, artifact tab keys, sidebar resize keys, file-tree navigation, and appearance changes. The native application still requires its desktop host for filesystem, terminal, and agent operations.

## Interaction contracts

- Model search uses a 352 px two-surface menu with provider emblems, favorite grips, a Fast switch, and an Edit footer. `onEdit` routes into the host settings page; without it, the standalone visibility manager remains available. Keyboard shortcuts are opt-in. Model search supports keyboard navigation; keyboard arrows enter/leave search. Effort stays inside the dropdown family. Escape closes the active submenu first, then its parent. Submenus portal beyond the scrollable model list. Visibility and order changes are controlled callbacks.
- Composer supports Enter or modifier-Enter submission, IME input, Shift-Enter newlines, mention/command suggestions, file paste/drop, attachment-only messages, minimized mode, edit/cancel, and queue/send while a response is running. Voice and host context selectors are callback surfaces.
- Queues expose collapse, pause/resume, drag or Alt-arrow reorder, edit/save/cancel, remove, and steer-now. The caller owns delivery scheduling.
- Navigation groups expose collapse, counts, inline rename, section reorder, workspace moves, draft/unread/activity rows, and empty groups. Workspace panels fall back to Changes when the selected capability disappears.
- Tasks expose create/edit/status changes and navigable dependency references. Closing with running work offers keep-running, stop, and cancel callbacks.
- Artifact lists include scope/search, loading/error/empty/archived/pagination, templates, versions, and deletion confirmation. HTML is sandboxed. File previews support text, HTML, image, PDF, video, and audio; local unsaved edits require a discard decision. Save failure preserves the editor.
- Settings support seven field types, managed/inherited/invalid states, reset, personal/workspace/organization scope, and editable shortcuts with collision detection.

These are frontend contracts. The local sample does not implement provider authentication, actual microphone recording, collaboration transport, cloud execution, or server persistence. Product screens must adopt the larger compositions separately. The library does not establish whole-application pixel equivalence.

## Provider and configuration compositions

`ModelLoadout` exposes five reorderable slots and a provider catalog through controlled model IDs. `ProviderSettings` has distinct Claude, Codex, Cursor, and OpenCode forms; authentication, key saving, filesystem browsing, and provider configuration require host callbacks and are disabled when unavailable. Keys are never written to browser storage. `EnvironmentSettings` validates names and duplicates, supports multi-line KEY=VALUE input, and emits controlled variable/file changes.

`WorkspaceArtifacts` renders stacked preview tiles. The workspace harness opens files in central tabs, preserves the active file when other tabs close, and keeps sidebar tabs reachable when space is limited. `visual-refinements.css` contains the styles for these larger compositions.

Workspace overview and workflow patterns:

- `WorkspaceDashboard`: project filters, five lifecycle columns, draggable cards, keyboard moves, overflow, and archive actions.
- `WorkspaceHome`: searchable workspace rows, multi-project and archive filters, four sort modes, display controls, and keyboard opening.
- `WorkspaceHoverPreview` / `WorkspacePreviewCard`: shared branch, diff, title, activity, workflow, PR, and age presentation.
- `GitWorkflowToolbar` / `GitWorkflowActions`: controlled Git and PR states, split Create PR actions, merge, checks, and busy states. `GitChangeScope` selects a target branch, all/uncommitted changes, or a commit.
- `PullRequestView`: controlled title, description, branches, reviewers, activity ordering, and a composable follow-up composer.
- `ContextLinkPicker`: grouped workspace/issue selection, search, linked state, loading, and errors. `ComposerAddMenu` opens issue/workspace pickers, Plan mode, and attachments with a deferred dialog handoff.
- `FileActionsMenu`: view, attach, Open in applications, copy paths, and discard callbacks. `WorkspaceTabs` adds unread, rename, fork, transcript, and link actions by tab kind.

The local harness uses sample workspaces and local workflow transitions. Git, remote PR changes, directory selection, external applications, and issue-provider fetching remain host-owned callbacks. The new visual checks do not cover every state or native cloud behavior. Menu keyboard focus uses the same filled highlight as pointer hover; dialogs restore focus without leaving the document pointer-locked.


## Cloud component examples

The local preview includes `#cloud/home`, `#cloud/workspace`, `#cloud/routines`, `#cloud/onboarding`, and cloud settings routes. Shared exports cover CloudHome, CloudWorkspaceDetails, CloudRunPanel, CloudWorkspaceCreateDialog, CloudRoutines, CloudOnboarding, CloudComputerSettings, WorkspaceShare, collaborator avatars, agent connections, members, plans, environment, and service configuration.

Home uses a 40 px toolbar and 44 px full-width rows, multi-owner/project selection, archive/routine filters, sorting, and six display fields. Machine details, the Run empty state, shared message attribution, and cloud footer placement follow the same spacing rules. Routine composition and create dialogs share the dialog and form primitives.

Interaction examples include private creation, per-workspace access and messages, follow/reassign, machine state banners, local sync states, port forwarding forms, routine schedule validation and unsaved-navigation protection, build failure/retry, and keyboard/pointer Run resizing. Hover cards are portaled with viewport collision handling. Teammates use letter avatars and optional presence indicators.

All service actions are local simulations. No cloud computer, collaborator transport, SSH process, credential storage, invitation, subscription, API service, or background routine is provisioned by this harness. Authentication, administration, mobile, and paid-only states are illustrative.
