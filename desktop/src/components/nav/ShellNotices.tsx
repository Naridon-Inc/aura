import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { useNoticeSlot } from "./noticeSlot";

// Hosts the app-level notices (update, tracking, impacts, install location).
//
// They are drawn at the foot of the sidebar while it is on screen and at the
// top of the work column while it is hidden. The notices themselves stay
// mounted the whole time — an update that is halfway downloaded must not
// start over because the sidebar was closed — so they render into one box
// this component owns, and only that box moves between the two places.

export function ShellNotices({ children }: { children: ReactNode }) {
  const [box] = useState(() => {
    const el = document.createElement("div");
    el.className = "ui-shell-notice-stack";
    return el;
  });
  const slot = useNoticeSlot();
  const inline = useRef<HTMLDivElement>(null);

  useLayoutEffect(() => {
    const host = slot ?? inline.current;
    if (host && box.parentElement !== host) host.appendChild(box);
  }, [slot, box]);

  useEffect(() => () => box.remove(), [box]);

  return (
    <>
      {!slot && <div ref={inline} className="ui-shell-notice-inline" />}
      {createPortal(children, box)}
    </>
  );
}
