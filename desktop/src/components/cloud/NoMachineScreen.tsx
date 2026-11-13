// A remote workspace with no machine in the book for it. This is not an error
// state — it is the honest first screen for someone who has cloud work but has
// never told this laptop how to reach the box that ran it.

import { Server } from "lucide-react";

import type { Machine } from "../../lib/api";
import { CloudGlyph } from "../ui/cloud-glyph";
import { EmptyState, LoadingState } from "../ui/state";
import "../ui/log-note.css";
import "../ui/remote-workspace.css";

export function NoMachineScreen({
  machines,
  missingMachineId,
  fromThread,
  canAnswerInList,
  onPickMachine,
  onConnectMachine,
}: {
  /** The book, or null while it is still being read. */
  machines: Machine[] | null;
  /** The machine this workspace asked for, when the book no longer has it. */
  missingMachineId: string | null;
  /** Arrived from a cloud job rather than from the machines list. */
  fromThread: boolean;
  /** The conversation can still be read and answered from the cloud list. */
  canAnswerInList: boolean;
  onPickMachine: (id: string) => void;
  onConnectMachine: () => void;
}) {
  if (machines === null) {
    return (
      <div className="ui-remote-empty">
        <LoadingState label="Looking for machines you've connected…" />
      </div>
    );
  }

  // Two ways in, two different first sentences. Arriving from a cloud job, the
  // machine is a fact you're trying to reach; arriving from the machines list
  // it is a thing you're about to add. Telling someone who clicked "Connect a
  // machine" that "this work ran on a machine" describes work they never sent.
  //
  // A machine that is gone has no name left to show. An id from before ids
  // stopped carrying an address still says where it was reached —
  // `user@host:/folder` — which reads as noise in a headline, so the headline
  // says what happened and the address sits in the small print for whoever
  // needs to recognise the box. A newer id says nothing about where the box
  // was, so there is no small print to give.
  const goneAt = missingMachineId?.includes("@") ? missingMachineId : null;
  const title = missingMachineId
    ? "This workspace’s machine isn’t connected to this laptop any more"
    : fromThread
      ? "This work ran on a machine this laptop can’t reach yet"
      : "No machines connected yet";

  return (
    <div className="ui-remote-empty">
      <div className="ui-remote-empty-inner">
        <EmptyState
          icon={Server}
          title={title}
          body="Connect a machine once — its address is kept here, never its key — and it opens as a workspace from then on."
          action={{
            label: missingMachineId ? "Connect it again" : "Connect a machine",
            onClick: onConnectMachine,
          }}
          footnote={
            goneAt || (fromThread && canAnswerInList) ? (
              <>
                {goneAt && <GoneAddress id={goneAt} />}
                {goneAt && fromThread && canAnswerInList && " "}
                {fromThread && canAnswerInList &&
                  "You can still read and answer the conversation from the cloud list while you do."}
              </>
            ) : undefined
          }
        />
        {/* Gone, but not alone. Offering the machines you do have beats
            sending someone through the wizard to re-add a box that is sitting
            one line below — and beats picking one for them, which would open
            shells on the wrong machine and look right. */}
        {missingMachineId && machines.length > 0 && (
          <div className="ui-remote-alternatives">
            <div className="ui-log-note-files-head">
              <span>Open one of these instead</span>
              <span className="ui-log-note-count">{machines.length}</span>
            </div>
            {machines.map((m) => (
              <button
                key={m.id}
                type="button"
                className="ui-menu-row ui-remote-machine-row"
                onClick={() => onPickMachine(m.id)}
              >
                <CloudGlyph size={13} />
                <span>
                  <span>{m.name}</span>
                  <small>
                    {m.user}@{m.host}
                  </small>
                </span>
              </button>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

/** Where the missing machine was reached, from an id that spells it
 *  (`user@host:/folder`), split into the address and the folder so neither
 *  runs into the other. A bare `user@host` is shown whole. */
function GoneAddress({ id }: { id: string }) {
  const at = id.indexOf(":");
  const address = at > 0 ? id.slice(0, at) : id;
  const folder = at > 0 ? id.slice(at + 1) : "";
  return (
    <>
      It was reached at <code>{address}</code>
      {folder && (
        <>
          , in <code>{folder}</code>
        </>
      )}
      .
    </>
  );
}
