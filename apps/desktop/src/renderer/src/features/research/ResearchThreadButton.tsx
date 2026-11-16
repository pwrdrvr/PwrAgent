import type { ResearchThread } from "@pwragent/shared";
import { useThreadLinks } from "../../lib/thread-links";

export function ResearchThreadButton({ thread, title }: { thread: ResearchThread; title: string }) {
  const links = useThreadLinks();
  const link = links?.resolve(thread);
  return <button type="button" className="research-link" disabled={!link} onClick={() => { if (link) links?.show(link); }}>{title}</button>;
}
