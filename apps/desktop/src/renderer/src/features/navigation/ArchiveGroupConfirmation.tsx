import { useCallback, useEffect, useId, useRef, useState } from "react";
import { createPortal } from "react-dom";
import type { NavigationArchiveMember } from "../../lib/navigation-archive-group";
import { threadSummaryIdentityKey } from "../../lib/federated-thread-events";
import { useModalDialog } from "../../lib/useModalDialog";

/** A confirmation owns the same immutable identity list the archive will execute. */
export function useArchiveGroupConfirmation() {
  const [members, setMembers] = useState<readonly NavigationArchiveMember[]>();
  const pending = useRef<((confirmed: boolean) => void) | undefined>(undefined);
  useEffect(() => () => { pending.current?.(false); pending.current = undefined; }, []);
  const resolve = useCallback((confirmed: boolean) => {
    const complete = pending.current;
    pending.current = undefined;
    setMembers(undefined);
    complete?.(confirmed);
  }, []);
  const confirm = useCallback((snapshot: readonly NavigationArchiveMember[]): Promise<boolean> => {
    // A second request cannot replace the list the operator is reviewing.
    if (pending.current) return Promise.resolve(false);
    return new Promise((complete) => {
      pending.current = complete;
      setMembers(snapshot);
    });
  }, []);
  return { members, confirm, resolve };
}

export function ArchiveGroupConfirmation({ controller }: { controller: ReturnType<typeof useArchiveGroupConfirmation> }) {
  const titleId = useId();
  const descriptionId = useId();
  const dialogRef = useModalDialog({ open: Boolean(controller.members), onClose: () => controller.resolve(false), initialFocus: "dialog" });
  const members = controller.members;
  if (!members) return null;
  const label = `${members.length} ${members.length === 1 ? "Thread" : "Threads"}`;
  return createPortal(
    <div className="rename-thread-backdrop" role="presentation">
      <section ref={dialogRef} className="rename-thread-dialog archive-group-dialog" role="dialog" aria-modal="true"
        aria-labelledby={titleId} aria-describedby={descriptionId} tabIndex={-1}>
        <h2 id={titleId}>Archive {label}?</h2>
        <p id={descriptionId} className="archive-group-dialog__description">Only the threads listed below will be archived.</p>
        <ul className="archive-group-dialog__members" aria-label="Threads to archive" tabIndex={0}>
          {members.map((member) => <li key={threadSummaryIdentityKey(member)}>
            <span>{member.title ?? member.id}</span>
            <small>{member.federation?.instanceLabel ?? "This machine"}</small>
          </li>)}
        </ul>
        <div className="rename-thread-dialog__actions">
          <button className="button button--secondary" type="button" onClick={() => controller.resolve(false)}>Cancel</button>
          <button className="button button--primary" type="button" onClick={() => controller.resolve(true)}>Archive {label}</button>
        </div>
      </section>
    </div>, document.body,
  );
}
