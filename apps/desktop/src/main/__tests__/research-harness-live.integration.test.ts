import { mkdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import path from "node:path";
import { expect, it } from "vitest";
import type { ResearchHarnessConfig, ResearchHarnessRequest } from "@pwragent/shared";
import { ResearchHarnessService } from "@pwragent/owner-core/research-harness-service";
import { probeResearchModel, researchModelRequest } from "@pwragent/owner-core/research-model-adapter";
import { ResearchStore } from "@pwragent/sqlite-storage/research-store";
import { StateDb } from "../state/state-db";
import { openResearchHarnessProcess } from "../research/research-harness-process";
import { selectHarnessModel } from "../research/research-harness-model";

/** Explicit opt-in only. Keep this private configuration and resulting journals out of PR media. */
const configPath = process.env.PWRAGENT_TEST_HARNESS_ACCEPTANCE_CONFIG;
it.skipIf(!configPath)("accepts a deployed Harness through the installed adapter without replaying unknown work", async () => {
  const config = JSON.parse(readFileSync(configPath!, "utf8")) as {
    bridge: ResearchHarnessConfig;
    workspace: string;
    stateDirectory: string;
    request: ResearchHarnessRequest;
  };
  if (!path.isAbsolute(config.stateDirectory) || !config.request.requestId || config.request.budgetAcknowledged !== true) throw new Error("Supply an absolute private state directory and explicit, stable acknowledged request identity");
  const workspace = realpathSync(config.workspace);
  mkdirSync(config.stateDirectory, { recursive: true });
  // Persistent identity prevents a repeated test invocation from replaying an ambiguous start.
  const db = StateDb.open(path.join(config.stateDirectory, "state.db"));
  const store = new ResearchStore(db);
  const selected = selectHarnessModel(config.bridge, config.request.mode);
  const errors: unknown[] = [];
  let service: ResearchHarnessService;
  service = new ResearchHarnessService(store, {
    ownerId: "explicit-harness-acceptance", ownerPid: process.pid, ownerStartedAt: Date.now(), changed: () => {}, onError: (error) => errors.push(error),
    open: (cwd, id) => {
      let modelBusy = false;
      const connection = openResearchHarnessProcess(config.bridge, cwd, async (method, params, signal) => {
        const run = store.get(id);
        if (method !== "model_complete" || !selected || modelBusy || run?.status !== "running" || run.harness?.state !== "running" || Date.now() >= run.deadlineAt) throw new Error("Model admission unavailable");
        modelBusy = true;
        try { return await selected.complete(researchModelRequest(selected.model, params.messages), signal); }
        finally { modelBusy = false; }
      }, (error) => errors.push(error));
      return { ...connection, ...(selected ? { model: { model: selected.model, endpointOrigin: selected.endpointOrigin } } : {}) };
    },
    probe: async (_id, signal) => {
      if (!selected) throw new Error("Explicit model configuration required for execution");
      await probeResearchModel(selected.complete, selected.model, signal);
    },
  });
  try {
    let run = await service.start(config.request, workspace);
    if (config.request.mode === "execute" && run.status === "running") run = await service.stop(run.id, { ...run.coordinator, kind: "operator" }, "stopped", "Explicit acceptance scenario ended");
    // A partial observation or uncertain mutation is evidence to inspect, never a reason to retry.
    expect(run.harness?.state).not.toBe("unknown");
    expect(run.events.some((event) => event.provenance)).toBe(true);
    expect(errors).toHaveLength(0);
    writeFileSync(path.join(config.stateDirectory, "acceptance.json"), JSON.stringify({
      runId: run.id, upstreamRevision: run.harness?.upstreamRevision, source: run.harness?.source ?? "swarm", mode: run.harness?.mode,
      status: run.status, adapterState: run.harness?.state, retainedObservations: run.events.filter((event) => event.provenance).length,
      sourceDigests: run.events.flatMap((event) => event.provenance ? [event.provenance.digest] : []), observedAt: Date.now(),
    }, null, 2));
  } finally { try { await service.close(); } finally { db.close(); } }
}, 180_000);
