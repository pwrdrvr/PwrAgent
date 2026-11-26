import { createContext, useContext } from "react";
import type { FederationInstanceId } from "@pwragent/shared/contracts/federation";
import type { ResearchThread } from "@pwragent/shared/research";
import { useThreadLinks } from "../../lib/thread-links";

/**
 * How a window with no thread list of its own opens a research member thread:
 * the Research window asks the main window to show it. The main window's
 * panel leaves this unset and resolves threads through its own list.
 */
export const ResearchThreadOpener = createContext<((thread: ResearchThread) => void) | undefined>(undefined);

/**
 * Owning Federation instance for member threads inside a remote Research panel,
 * so worker/author links resolve against that owner rather than colliding local threads.
 */
export const ResearchThreadOwner = createContext<FederationInstanceId | undefined>(undefined);

/**
 * A link to a research member thread. `label` names the destination for
 * assistive technology where several links share one visible title. A thread
 * this window cannot resolve stays focusable and explains why.
 */
export function ResearchThreadButton({ thread, title, label }: { thread: ResearchThread; title: string; label?: string }) {
  const open = useContext(ResearchThreadOpener);
  const ownerInstanceId = useContext(ResearchThreadOwner);
  const links = useThreadLinks();
  const link = open ? undefined : links?.resolve(ownerInstanceId ? { ...thread, instanceId: ownerInstanceId } : thread);
  const available = Boolean(open || link);
  const unavailable = "This thread is not in this window’s thread list";
  return <button type="button" className={`research-link${available ? "" : " tooltip-target"}`} aria-label={label}
    aria-disabled={available ? undefined : true} data-tooltip={available ? undefined : unavailable}
    onClick={() => { if (open) open(thread); else if (link) links?.show(link); }}>{title}</button>;
}
