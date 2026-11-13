// One cloud workspace from the public API, in the usual workspace
// layout: the details title, who is here, the Chat tab, the transcript, the
// composer, and the right panel on a plan that has one.
//
// Several people can be in one workspace. Once someone other than you has
// written in it, each prompt carries the name and face of whoever sent it; a
// prompt the server recorded no author for is drawn as a prompt and not put
// in anyone's mouth. Who has it open, who is typing, who may open it and
// whether you follow it sit in the header and over the composer. Viewers
// follow the workspace live: the reply as it is written and each tool as it
// runs. A workspace with no machine of ours behind it keeps the machine out
// of its details, and the tab menu says plainly that only its chat opens
// here. One on a machine this laptop reaches shows that machine in its
// details: its CPU, memory and disk, a shell on it, and a copy of its files
// here (useWorkspaceMachine).

import { useEffect, useMemo, useState } from "react";
import { Globe, MessageSquare, PanelRight, Plus, Terminal } from "lucide-react";

import { endsLine, openPlanBilling, stoppedComputerAt } from "../../lib/auraComputer";
import { writeClipboardText } from "../../lib/clipboard";
import { insertIntoComposer, withTrailing } from "../../lib/composerBridge";
import { boxChat, cutLine, isDriver } from "../../lib/cloudBoxChat";
import { composerOpen, isBoxDriven, waitingPrompt } from "../../lib/cloudBoxDrive";
import {
  cloudApi,
  cloudProblem,
  ownerOf,
  type CloudWorkspaceRow,
} from "../../lib/cloudWorkspacesApi";
import { setCloudNotice, setCloudPage } from "../../lib/cloudPlace";
import { openExternal } from "../../lib/openExternal";
import { ownerAvatarUrl } from "../../lib/repoAvatar";
import { useAuraComputer } from "../../lib/useAuraComputer";
import { Button } from "../ui/button";
import {
  CloudStatus,
  CloudWorkspaceActions,
  CloudWorkspaceDetails,
  CollaboratorTyping,
  type CloudMember,
  type CloudSession,
  type CloudSessionAction,
  type CloudSessionState,
} from "../ui/cloud-workspace";
import { Composer, type ComposerSuggestion } from "../ui/composer";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "../ui/dropdown-menu";
import { ModelPicker, type ModelSelection } from "../ui/model-picker";
import { EmptyState, ErrorState, LoadingState } from "../ui/state";
import { RepoAvatar } from "../ui/repo-avatar";
import { Tooltip } from "../ui/tooltip";
import { WorkspaceTabs } from "../ui/workspace-tabs";
import { relTime } from "../workspaces/workspacesModel";
import { CloudApiWorkspacePanel, type PanelComments, type PanelTab } from "./CloudApiWorkspacePanel";
import { CloudBoxChat } from "./CloudBoxChat";
import { CloudBoxWorking, HandToComputer, useAnswerPoll, useBoxComputers } from "./CloudBoxDrive";
import { CloudBoxWorkPanel } from "./CloudBoxWorkPanel";
import { CloudCommentsTab } from "./CloudCommentsTab";
import { CloudLiveTurn } from "./CloudLiveTurn";
import { CloudRunOnComputer } from "./CloudRunOnComputer";
import { MoveToLocalDialog } from "./MoveToLocalDialog";
import { TurnRow } from "./CloudTurn";
import { FeedbackRoomProvider, TurnFeedback, useRoom } from "./CloudTurnFeedback";
import { isResolved } from "./cloudFeedback";
import { scrollToFeedback, takeFeedbackFocus, useFeedbackFocus } from "./feedbackFocus";
import {
  addressedTo,
  agentOf,
  authorOf,
  canSeeWorkspace,
  hasOtherAuthors,
  toNames,
  serverSentence,
  typingNamesOf,
  withMention,
} from "./cloudPeople";
import { cloudTeamApi } from "../../lib/cloudTeamApi";
import { reloadCloudPlace } from "./cloudPlaceStore";
import { githubRepoPage } from "./cloudRows";
import { noteTyping, stopTyping, useCloudPresence } from "./cloudTeamStore";
import { CloudWorkspacePeople, useWorkspaceAccess } from "./CloudWorkspacePeople";
import { SetUpCloudAgentButton } from "./CloudAgentsHost";
import { useCloudModels } from "./cloudModels";
import { useKeptTurnIds, useWorkspaceFeedback } from "./useWorkspaceFeedback";
import { useWorkspaceLive } from "./useWorkspaceLive";
import { starterClaude, workspaceInfo } from "./cloudWorkspaceMachine";
import { ArchiveConfirm, useCopyLinkShortcut, useWorkspaceMachine } from "./useWorkspaceMachine";

const CHAT_TAB = [{ id: "chat", label: "Chat", kind: "chat" as const, closeable: false }];
/** The tabs the ＋ menu lists, and why this workspace can't open each one. */
const NEW_TABS = [
  { Icon: MessageSquare, label: "Chat", reason: "This workspace has one chat, and it’s already open." },
  { Icon: Terminal, label: "Cloud terminal", reason: "This workspace has no terminal to open." },
  { Icon: Globe, label: "Browser", reason: "This workspace has no browser to open." },
];

export function sessionStateOf(status: string): CloudSessionState {
  if (status === "running") return "running";
  if (status === "sleeping") return "sleeping";
  if (status === "archived" || status === "ended") return "archived";
  return "starting";
}

export function CloudApiWorkspace({
  row,
  title,
  repository,
  repositoryFullName = null,
  members,
  me,
  owner,
  logins,
  link,
  panel,
  orgName = "",
  watching = false,
}: {
  row: CloudWorkspaceRow;
  title: string;
  /** The repository's short name, or "No repository". */
  repository: string;
  /** `owner/name` on GitHub, when the workspace has a repository: its
   *  owner's picture stands beside the name and its page opens from the row. */
  repositoryFullName?: string | null;
  members: CloudMember[];
  /** Your own member id, when you are among the members. */
  me: string | null;
  /** The member who opened it, when they are in the team. */
  owner: string | undefined;
  /** Member id → GitHub login: the server matches an @mention on the login. */
  logins: Record<string, string>;
  /** The workspace's own page on the console, when there is one to share. */
  link: string | null;
  /** The plan has the right panel. */
  panel: boolean;
  /** The organization, named in the share popover. */
  orgName?: string;
  /** Read, not worked in: the web console's view of a workspace. The
   *  conversation, its changes, its people and its comments, with nothing
   *  that sends, runs, renames, hands on or archives it. */
  watching?: boolean;
}) {
  // A workspace one of the org's machines answers runs Claude there, on the
  // Claude of whoever started it and the model the sender picks; only
  // Claude's models are offered for it, to teammates who never connected
  // their own Claude too.
  const starterId = owner ?? ownerOf(row);
  const mine = !!me && starterId === me;
  const starter = members.find((m) => m.id === starterId)?.name ?? null;
  const runsOn = starterClaude({ mine, starter });
  const { models, model: firstModel } = useCloudModels(
    isBoxDriven(row) ? "claude" : undefined,
    isBoxDriven(row) && !mine,
  );
  const [model, setModel] = useState<ModelSelection>({ model: row.model ?? "" });
  const [draft, setDraft] = useState("");
  const [sending, setSending] = useState(false);
  const [right, setRight] = useState(true);
  const [rightTab, setRightTab] = useState<PanelTab>("Changes");
  const state = sessionStateOf(row.status);
  // A workspace linked to one of the org's machines has its chat there. The
  // member who linked it drives that chat from their laptop; everyone else
  // reads the turns it copies onto the log. A machine that answers by itself
  // has no driver: everyone sends the normal way and its answers land here.
  const machine = row.place?.machine ?? null;
  const boxDriven = isBoxDriven(row);
  // Someone watching from a browser reads the turns the chat copies onto the
  // log, even when they are the member who drives it from their laptop.
  const drives = !watching && isDriver(row, me);
  // A machine that answers by itself needs no laptop, so the browser sends
  // in it like anyone else; any other chat is read there and sent from the app.
  const readsOnly = watching && !boxDriven;
  const driver = members.find((m) => m.id === row.place_linked_by)?.name ?? null;
  const box = useWorkspaceMachine({ row, repository, drives, boxDriven, driver, mine, starter });
  // The team's computer under this workspace, when its payment stopped:
  // everything sent here waits on that, so the chat says so with the fix.
  const { status: computerStatus } = useAuraComputer();
  const unpaid = boxDriven ? stoppedComputerAt(computerStatus, row.place?.place_id) : null;
  const [restarts, setRestarts] = useState(0);
  // Why this laptop couldn't open the chat it drives, while it can't. The
  // chat is then read the way teammates read it, off the cloud, with a way
  // back and a way to have the computer answer by itself instead.
  const [cut, setCut] = useState<string | null>(null);
  useEffect(() => setCut(null), [row.id, machine]);
  const attachedHere = !!machine && drives && state !== "archived" && !cut;
  const handTo = useBoxComputers(!!cut && drives && !!machine);
  const handOffer = (handTo ?? []).filter((c) => c.placeId === row.place?.place_id);
  const [handing, setHanding] = useState<{ busy: string } | { error: string } | null>(null);
  const [archiving, setArchiving] = useState(false);
  const [movingHere, setMovingHere] = useState(false);
  // Moved to a member's computer: the work goes on in the chat there, and
  // this one is kept as it was.
  const moved = row.moved ?? null;
  const movedTo = moved ? moved.name || "a member’s computer" : null;
  // The member driving a machine chat sees it through the chat itself.
  const { messages, failed, live, read } = useWorkspaceLive(row.id, {
    enabled: !attachedHere,
    running: state === "running",
  });

  // A message to people is on the log for them; the computer has nothing to
  // answer there.
  const waiting =
    boxDriven && state !== "archived"
      ? waitingPrompt(messages, row.place?.linked_at, (m) => !!addressedTo(m.body, logins))
      : null;
  useAnswerPoll(waiting?.id ?? null, read);

  useEffect(() => {
    if (!model.model && firstModel.model) setModel(firstModel);
  }, [model.model, firstModel]);

  const repoPage = githubRepoPage(repositoryFullName);
  const repoOwner = repoPage ? (repositoryFullName ?? "").split("/")[0] : null;
  const opener = members.find((m) => m.id === owner);
  const session: CloudSession = {
    id: row.id,
    title,
    repository,
    branch: row.branch ?? "",
    state,
    cpu: 0,
    memory: 0,
    build: 0,
    cost: "",
    createdBy: opener
      ? opener.id === me
        ? "You"
        : opener.name
      : ownerOf(row)
        ? "Someone no longer in this team"
        : "Not recorded",
    createdAt: relTime(Math.floor(Date.parse(row.created_at) / 1000), Date.now()),
    ...box.session,
  };
  const access = useWorkspaceAccess(row.id, row.repo_id);
  const presence = useCloudPresence();
  const typing = useMemo(
    () => typingNamesOf(presence, row.id, members, me),
    [presence, row.id, members, me],
  );
  // The logins a machine chat can address a message to: everyone but you.
  const teammateLogins = useMemo(
    () => members.filter((m) => m.id !== me && logins[m.id]).map((m) => logins[m.id]!),
    [members, me, logins],
  );
  // Who a message to people was for, by turn.
  const toByTurn = useMemo(() => {
    const out = new Map<string, string>();
    for (const m of messages ?? []) {
      if (m.role !== "user") continue;
      const ids = addressedTo(m.body, logins);
      if (ids) out.set(m.id, toNames(ids, members, me));
    }
    return out;
  }, [messages, logins, members, me]);
  // Names over the turns once the conversation has more than you in it:
  // someone else wrote, or you wrote to someone.
  const shared = useMemo(
    () => hasOtherAuthors(messages ?? [], me) || toByTurn.size > 0,
    [messages, me, toByTurn],
  );
  const agent = shared ? agentOf(row) : null;
  const readOnly = access.access?.your_access === "read";
  // An @mention of someone who can't open a private workspace reaches no
  // one; the list says so before you send it.
  const suggestions = useMemo<ComposerSuggestion[]>(
    () =>
      members
        .filter((m) => m.id !== me && logins[m.id])
        .map((m) => ({
          id: m.id,
          label: m.name,
          detail: canSeeWorkspace(m, access.access)
            ? "@" + logins[m.id]
            : "@" + logins[m.id] + " · can’t open this workspace",
          kind: "mention" as const,
          insertText: "@" + logins[m.id] + " ",
        })),
    [members, me, logins, access.access],
  );
  // The same rows in the machine chat's own box, whose list puts the space
  // after a pick itself.
  const chatMentions = useMemo(
    () => suggestions.map((s) => ({ ...s, insertText: s.insertText.trimEnd() })),
    [suggestions],
  );
  const edit = (next: string) => {
    setDraft(next);
    if (next.trim()) noteTyping();
    else stopTyping();
  };
  // Mention from a face in the header: into whichever box sends here. The
  // member driving a machine chat types in that chat's own box.
  const drivingHere = attachedHere;
  const mentionBlocked = readsOnly
    ? "Messages are sent from the Aura app."
    : state === "archived"
      ? "This workspace is archived, so nothing can be sent in it."
      : movedTo
        ? `This workspace moved to ${movedTo}, so nothing can be sent in it here.`
        : readOnly
        ? "You can read this workspace but not send in it."
        : machine && !drives && !boxDriven
          ? `Only ${driver ?? "the member who started it"} can send in this chat for now.`
          : null;
  // Comments: anyone who can open the workspace leaves them, read-only
  // members included; only an archived workspace stops taking them.
  const { feedback, actions: feedbackActions } = useWorkspaceFeedback(row.id);
  const kept = useKeptTurnIds(row.id, drivingHere);
  const canPrompt =
    !readsOnly && (drivingHere || composerOpen(row, { readOnly, archived: state === "archived" }));
  const sendToAgent = canPrompt
    ? (text: string) => {
        // Into the box, never sent: whoever prompts reads it over first.
        if (drivingHere) {
          if (!insertIntoComposer(text)) setCloudNotice("Open the chat to add it to your message.");
          return;
        }
        edit(withTrailing(draft, text));
        setCloudNotice("Added to your message. It isn’t sent until you send it.");
      }
    : null;
  const agentLabel = agentOf(row).name;
  const room = useRoom({
    state: feedback,
    actions: feedbackActions,
    me,
    members,
    suggestions,
    closed:
      state === "archived" ? "This workspace is archived, so it can’t take comments." : null,
    sendToAgent,
    agentName: agentLabel === "Agent" ? "the agent" : agentLabel,
    kept,
  });
  const openThreads =
    Object.values(room.threads.byTurn).reduce((n, ts) => n + ts.filter((t) => !isResolved(t)).length, 0) +
    room.threads.workspace.filter((t) => !isResolved(t)).length;
  const goTo = (messageId: string, commentId: string | null) => {
    room.setOpen(messageId, true);
    scrollToFeedback(messageId, commentId);
  };
  // A notification about a thread here: open it and bring it into view; one
  // on the workspace itself is in the Comments tab.
  const focus = useFeedbackFocus(row.id);
  useEffect(() => {
    if (!focus) return;
    takeFeedbackFocus(focus);
    if (focus.messageId) {
      goTo(focus.messageId, focus.commentId);
    } else if (panel) {
      setRight(true);
      setRightTab("Comments");
      scrollToFeedback(null, focus.commentId);
    }
    // Acted on once per focus; goTo reads the room as it is now.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [focus?.seq]);
  const excerptOf = (messageId: string) => {
    const said = messages?.find((m) => m.id === messageId)?.body?.replace(/\s+/g, " ").trim();
    if (!said) return null;
    return said.length > 60 ? `${said.slice(0, 57).trimEnd()}…` : said;
  };
  const comments: PanelComments = {
    body: <CloudCommentsTab excerptOf={excerptOf} onGoTo={goTo} />,
    count: openThreads || null,
  };
  const mention = (insert: string) => {
    if (drivingHere) {
      // The mention addresses the whole message, so it goes first.
      if (!insertIntoComposer(insert, "start")) setCloudNotice("Open the chat to mention them.");
      return;
    }
    edit(withMention(draft, insert));
  };

  const copy = (text: string, done: string) =>
    void writeClipboardText(text).then((ok) =>
      setCloudNotice(ok ? done : "Couldn’t reach the clipboard."),
    );
  const act = (to: "sleep" | "archive") =>
    // Archiving a machine chat you drive stops it on the machine first, so
    // nothing is left running there.
    (to === "archive" && drives && row.place
      ? boxChat.end(row.id, row.place).catch(() => undefined)
      : Promise.resolve()
    )
      .then(() => cloudApi.setWorkspaceState(row.id, to))
      .then(() => {
        setCloudNotice(to === "sleep" ? "Workspace put to sleep." : "Workspace archived.");
        void reloadCloudPlace();
        if (to === "archive") setCloudPage("home");
      })
      .catch((e) => setCloudNotice(cloudProblem(e).message));
  const rename = (name: string) =>
    cloudApi
      .renameWorkspace(row.id, name)
      .then(() => {
        setCloudNotice("Workspace renamed.");
        void reloadCloudPlace();
      })
      .catch((e) => setCloudNotice(cloudProblem(e).message));
  // Handing it on is the same rule as changing who can open it: the person
  // who opened it, or an org admin. Anyone else isn't offered it at all.
  const reassign =
    access.access?.can_manage && state !== "archived"
      ? (userId: string) => {
          if (userId === owner) return;
          const to = members.find((m) => m.id === userId);
          cloudTeamApi
            .reassign(row.id, userId)
            .then(() => {
              setCloudNotice(
                to?.id === me ? "This workspace is yours now." : `Workspace handed to ${to?.name ?? "your teammate"}.`,
              );
              void reloadCloudPlace();
            })
            .catch((e) => setCloudNotice(serverSentence(e) ?? cloudProblem(e).message));
        }
      : undefined;
  const copyLink = link ? () => copy(link, "Workspace link copied.") : null;
  useCopyLinkShortcut(copyLink);
  const action = (a: CloudSessionAction) => {
    if (a === "copy-link") copyLink?.();
    else if (a === "copy-info")
      copy(
        workspaceInfo({
          title,
          id: row.id,
          repository,
          branch: row.branch,
          state: session.state,
          createdBy: session.createdBy ?? "Not recorded",
          createdAt: session.createdAt ?? "",
          link,
          place: row.place ?? null,
        }),
        "Workspace info copied.",
      );
    // Asks first; the dialog's Archive runs act("archive").
    else if (a === "archive") setArchiving(true);
    else if (a === "restart") {
      setCut(null);
      setRestarts((n) => n + 1);
    }
    else if (a === "connection-details") box.openShell();
    else if (a === "sync") box.toggleSync();
    else if (a === "transfer") box.transfer();
    else if (a === "move-local") setMovingHere(true);
    else if (a === "copy-directory") box.copyDirectory();
  };
  const offers: CloudSessionAction[] = watching ? [...(link ? (["copy-link"] as const) : []), "copy-info"] : [
    ...(link ? (["copy-link"] as const) : []),
    "copy-info",
    ...(box.reachable ? (["transfer"] as const) : []),
    // Its branch, and its chat, brought to this laptop to go on here.
    ...(!moved && !readOnly && state !== "archived" && row.branch ? (["move-local"] as const) : []),
    ...(state !== "archived" ? (["archive"] as const) : []),
  ];

  const send = () => {
    const text = draft.trim();
    if (!text || sending) return;
    setSending(true);
    cloudApi
      // A machine chat driven from a laptop picks its model in that chat; a
      // machine that answers by itself reads the pick off the prompt.
      .prompt(row.id, text, machine && !boxDriven ? null : model.model || null)
      .then(() => {
        setDraft("");
        stopTyping();
        void read();
      })
      .catch((e) => setCloudNotice(cloudProblem(e).message))
      .finally(() => setSending(false));
  };

  return (
    <FeedbackRoomProvider room={room}>
      <div className="ui-cloud-place-split">
        <div className="ui-cloud-place-main">
          <header className="ui-cloud-place-header ui-cloud-header">
            <CloudWorkspaceDetails
              session={session}
              machine={box.reachable}
              resources={box.resources}
              // Restart is the chat this laptop runs on the machine: it lets
              // go of the agent there and attaches again.
              restart={drivingHere && box.reachable ? "restart" : null}
              sshItems={box.sshItems}
              environment={machine ?? "Cloud"}
              // Nothing is set up on the machine before its agent starts.
              setup={null}
              cost={box.cost}
              footer={box.note}
              onOpenChange={(open) => open && box.refresh()}
              offers={offers}
              onSleep={!watching && state === "running" ? () => void act("sleep") : undefined}
              onRename={watching ? undefined : (name) => void rename(name)}
              onAction={action}
              repositoryIcon={
                <RepoAvatar
                  name={repository}
                  avatar={repoOwner ? ownerAvatarUrl(repoOwner) : null}
                />
              }
              onOpenRepository={
                repoPage ? () => void openExternal(repoPage) : undefined
              }
            >
              {box.internals}
            </CloudWorkspaceDetails>
            <span style={{ flex: 1 }} />
            <CloudWorkspacePeople
              workspaceId={row.id}
              members={members}
              me={me}
              owner={owner}
              orgName={orgName}
              access={access}
              onCopyLink={copyLink ?? undefined}
              logins={logins}
              onMention={readsOnly ? undefined : mention}
              mentionBlocked={mentionBlocked}
            />
            {!watching && (
              <CloudWorkspaceActions
                members={members}
                assignee={owner ?? ""}
                following={access.following}
                followBusy={access.followBusy}
                onFollow={access.toggleFollow}
                onReassign={reassign}
                onAction={action}
                offers={offers}
              />
            )}
            {panel && (
              <Button
                variant="ghost"
                size="iconSm"
                aria-label="Toggle right sidebar"
                onClick={() => setRight(!right)}
              >
                <PanelRight />
              </Button>
            )}
          </header>
          <div className="ui-cloud-tab-row">
            <WorkspaceTabs
              tabs={CHAT_TAB}
              value="chat"
              onChange={() => undefined}
              onClose={() => undefined}
              onCopyLink={link ? () => copy(link, "Workspace link copied.") : undefined}
            />
            {!watching && (
              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <Button variant="ghost" size="iconSm" aria-label="New cloud tab">
                    <Plus />
                  </Button>
                </DropdownMenuTrigger>
                <DropdownMenuContent align="end">
                  {NEW_TABS.map(({ Icon, label, reason }) => (
                    // A disabled row takes no pointer, so the reason hangs on
                    // the row's wrapper.
                    <Tooltip key={label} content={reason} side="left">
                      <div>
                        <DropdownMenuItem disabled>
                          <Icon />
                          {label}
                        </DropdownMenuItem>
                      </div>
                    </Tooltip>
                  ))}
                </DropdownMenuContent>
              </DropdownMenu>
            )}
          </div>
          {attachedHere ? (
            <div className="ui-cloud-box-chat">
              <CloudBoxChat
                workspaceId={row.id}
                place={row.place!}
                title={title}
                authorName={members.find((m) => m.id === me)?.name ?? null}
                people={teammateLogins}
                mentions={chatMentions}
                restarts={restarts}
                onFailed={setCut}
              />
            </div>
          ) : (
            <>
              {/* A computer that answers by itself needs no bar: the empty
                  chat and the details already name it. A chat a laptop drives
                  keeps one, as the reason only that member can send. */}
              {machine && cut && drives && state !== "archived" && (
                <div className="ui-cloud-session-banner ui-cloud-run-banner" role="status">
                  <span>
                    {cutLine(machine, cut)}
                    {handing && "error" in handing ? (
                      <em data-tone="error">{handing.error}</em>
                    ) : handing ? (
                      <em>{handing.busy}</em>
                    ) : handOffer.length ? (
                      <em>{`Or run it on ${machine}: it answers everyone’s messages here by itself, so no laptop has to reach it.`}</em>
                    ) : null}
                  </span>
                  <Button size="sm" variant="secondary" onClick={() => setCut(null)}>
                    Reconnect
                  </Button>
                  {handOffer.length > 0 && (
                    <HandToComputer workspaceId={row.id} branch={row.branch} computers={handOffer} onStep={setHanding} />
                  )}
                </div>
              )}
              {machine && !cut && !boxDriven && state !== "archived" && (
                <div className="ui-cloud-session-banner" role="status">
                  <CloudStatus state={state} />
                  <span>
                    {`This chat runs on ${machine}, driven from ${driver ? `${driver}’s` : "another member’s"} laptop. ${live.up ? "You see each turn as it happens." : "Each turn shows here once it finishes."}`}
                  </span>
                </div>
              )}
              {unpaid && state !== "archived" && (
                <div className="ui-cloud-session-banner ui-cloud-run-banner" role="status">
                  <span>
                    {`${unpaid.name} can’t wake until its payment goes through, so nothing sent here runs yet.`}
                    {endsLine(unpaid) && <em>{endsLine(unpaid)}</em>}
                  </span>
                  <Button size="sm" variant="secondary" onClick={openPlanBilling}>
                    Pay again
                  </Button>
                </div>
              )}
              {(state === "sleeping" || state === "archived") && (!machine || state === "archived") && (
                <div className="ui-cloud-session-banner" role="status">
                  <CloudStatus state={state} />
                  <span>
                    {state === "sleeping"
                      ? watching
                        ? "This workspace is asleep. Its chat is kept here."
                        : "Chat history is available while this workspace sleeps. Sending a message wakes it."
                      : "Archived workspace. Its chat is kept here."}
                  </span>
                </div>
              )}
              {movedTo && (
                <div className="ui-cloud-session-banner" role="status">
                  <CloudStatus state={state} />
                  <span>
                    {`Moved to ${movedTo}${moved?.branch ? `, on ${moved.branch}` : ""}. The work goes on there; this chat is kept as it was.`}
                  </span>
                </div>
              )}
              {!watching && !machine && !moved && state !== "sleeping" && state !== "archived" && (
                <CloudRunOnComputer
                  row={row}
                  repositoryFullName={repositoryFullName}
                  messages={messages}
                  me={me}
                  owner={owner}
                  runsOn={runsOn}
                  logins={logins}
                  authorName={members.find((m) => m.id === me)?.name ?? null}
                  people={teammateLogins}
                  canRun={!readOnly}
                />
              )}
              <div className="ui-cloud-transcript ui-cloud-place-transcript">
                {failed && messages === null ? (
                  <ErrorState message={failed} onRetry={() => void read()} />
                ) : messages === null ? (
                  <LoadingState label="Reading the conversation…" />
                ) : messages.length === 0 && !live.working ? (
                  <EmptyState
                    icon={MessageSquare}
                    title="No messages yet"
                    body={
                      watching
                        ? "Nothing has been said in this workspace yet."
                        : boxDriven
                        ? `What you send here goes to ${machine}, which answers it by itself on ${runsOn}.`
                        : machine
                        ? `Turns from the chat on ${machine} show here.`
                        : "What you send here is queued for the runner working this workspace."
                    }
                  />
                ) : (
                  <>
                    {messages.map((m) => (
                      <TurnRow
                        key={m.id}
                        m={m}
                        author={shared ? authorOf(m, members, me) : null}
                        agent={agent}
                        to={shared ? (toByTurn.get(m.id) ?? null) : null}
                        actions={<TurnFeedback messageId={m.id} />}
                      />
                    ))}
                    <CloudLiveTurn live={live} driver={driver} />
                    {waiting && machine && <CloudBoxWorking machine={machine} prompt={waiting} />}
                  </>
                )}
              </div>
              {!readsOnly && (
                <div className="ui-cloud-composer">
                  <CollaboratorTyping names={typing} />
                  <Composer
                    suggestions={suggestions}
                    value={draft}
                    onChange={edit}
                    onSend={send}
                    disabled={sending || !composerOpen(row, { readOnly, archived: state === "archived" })}
                    placeholder={
                      machine && cut && drives
                        ? `Reconnect to ${machine} to send from here`
                        : machine && !boxDriven
                        ? `Only ${driver ?? "the member who started it"} can send to this chat for now`
                        : movedTo
                          ? `Moved to ${movedTo}. The work goes on there`
                          : readOnly
                            ? "You can read this workspace. Ask whoever opened it for write access to send."
                            : "Ask for changes, or @mention a teammate"
                    }
                    footer={
                      // A machine chat driven from a laptop picks its model in
                      // that chat, so a pick here would change nothing.
                      machine && !boxDriven ? undefined : models.length ? (
                        <ModelPicker models={models} value={model} onChange={setModel} />
                      ) : (
                        <SetUpCloudAgentButton />
                      )
                    }
                  />
                </div>
              )}
            </>
          )}
        </div>
        {panel &&
          right &&
          (row.place && !boxDriven && !cut ? (
            // A workspace on one of the org's machines is the files on that
            // machine, read over the chat's own ssh. One the machine answers by
            // itself is read from the cloud: no laptop reaches the machine.
            <CloudBoxWorkPanel
              workspaceId={row.id}
              place={row.place}
              tab={rightTab}
              onTab={setRightTab}
              comments={comments}
              onArchive={!watching && state !== "archived" ? () => setArchiving(true) : undefined}
            />
          ) : (
            <CloudApiWorkspacePanel
              id={row.id}
              branch={row.branch}
              tab={rightTab}
              onTab={setRightTab}
              comments={comments}
              onArchive={!watching && state !== "archived" ? () => setArchiving(true) : undefined}
            />
          ))}
      </div>
      <ArchiveConfirm
        open={archiving}
        onOpenChange={setArchiving}
        onArchive={() => void act("archive")}
        machine={machine}
        drives={drives}
      />
      {movingHere && (
        <MoveToLocalDialog
          row={row}
          title={title}
          repositoryFullName={repositoryFullName}
          messages={messages}
          me={me}
          myName={members.find((m) => m.id === me)?.name ?? null}
          logins={logins}
          onClose={() => setMovingHere(false)}
        />
      )}
    </FeedbackRoomProvider>
  );
}
