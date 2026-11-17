import type { ResearchThread } from "@pwragent/shared";
import { useThreadLinks } from "../../lib/thread-links";

/**
 * A link to a research member thread. `label` names the destination for
 * assistive technology where several links share one visible title. A thread
 * this window cannot resolve stays focusable and explains why.
 */
export function ResearchThreadButton({ thread, title, label }: { thread: ResearchThread; title: string; label?: string }) {
  const links = useThreadLinks();
  const link = links?.resolve(thread);
  const unavailable = "This thread is not in this window’s thread list";
  return <button type="button" className={`research-link${link ? "" : " tooltip-target"}`} aria-label={label}
    aria-disabled={link ? undefined : true} data-tooltip={link ? undefined : unavailable}
    onClick={() => { if (link) links?.show(link); }}>{title}</button>;
}
