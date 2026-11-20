import { useCallback, useState } from "react";
import type { ResearchCommand, ResearchThread } from "@pwragent/shared/research";
import type { DesktopApi } from "../../lib/desktop-api";

export function researchErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : "Research operation failed";
}

/**
 * What the operator can do to the run on screen, as its coordinating thread:
 * review, stop, finish, reconcile and open evidence. One action at a time;
 * the owner's own message is shown when it refuses.
 */
export function useResearchRunActions(api: DesktopApi | undefined, thread: ResearchThread | undefined, runId: string | undefined) {
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState("");
  const [error, setError] = useState("");
  const backend = thread?.backend, threadId = thread?.threadId;

  const update = useCallback(async (command: ResearchCommand): Promise<boolean> => {
    if (!runId || !backend || !threadId || !api?.updateResearch) return false;
    setBusy(true); setError(""); setNotice("");
    try {
      const result = await api.updateResearch({ backend, threadId, runId, requestId: crypto.randomUUID(), command });
      if (command.action === "review" && command.decision === "revision_requested") {
        const delivery = result.delivery;
        setNotice(delivery?.state === "queued" ? "Revision feedback is queued for the worker." : delivery?.state === "started" ? "The worker received the revision feedback." : "The revision is recorded, but delivery to the worker was not confirmed. Check Activity before you send it again.");
      } else if (command.action === "review") setNotice(`Decision recorded: ${command.decision === "accepted" ? "accepted" : "rejected"}.`);
      else if (command.action === "resume") setNotice("Resume sent. Each worker takes its slot back when its turn starts.");
      else if (command.action === "bounds") setNotice("Bounds saved.");
      return true;
    } catch (failure) { setError(researchErrorMessage(failure)); return false; }
    finally { setBusy(false); }
  }, [api, backend, threadId, runId]);

  const reconcile = useCallback(async () => {
    if (!runId || !backend || !threadId || !api?.reconcileResearchHarness) return;
    setBusy(true); setError(""); setNotice("");
    try { await api.reconcileResearchHarness({ backend, threadId, runId }); }
    catch (failure) { setError(researchErrorMessage(failure)); }
    finally { setBusy(false); }
  }, [api, backend, threadId, runId]);

  const openEvidence = useCallback(async (itemId: string, pathIndex: number) => {
    if (!runId || !backend || !threadId || !api?.openResearchEvidence) return;
    setError("");
    try {
      const result = await api.openResearchEvidence({ backend, threadId, runId, itemId, pathIndex });
      if (!result.opened) throw new Error(result.error ?? "Evidence could not be opened");
    } catch (failure) { setError(researchErrorMessage(failure)); }
  }, [api, backend, threadId, runId]);

  const reset = useCallback(() => { setNotice(""); setError(""); }, []);
  return { busy, notice, error, update, reconcile, openEvidence, reset };
}
