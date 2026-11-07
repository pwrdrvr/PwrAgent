import fc from "fast-check";
import { expect, it, vi } from "vitest";
import type { CodexAppServerClient } from "../codex-app-server/desktop-client";
import { createProviderRuntimeClient } from "../codex-app-server/provider-runtime-client";

async function assertPathRouting(threadId: string, model?: string) {
  const makeClient = () => ({
    onNotification: () => () => {},
    modelProviderForThread: vi.fn((id: string) => id === threadId ? "bonsai" : undefined),
    readThreadSummary: vi.fn(async () => { throw new Error("Source IDs belong to the sender"); }),
    forkThread: vi.fn(async () => ({ threadId: "new-destination" })),
  });
  const primary = makeClient();
  const bonsai = makeClient();
  const client = createProviderRuntimeClient(primary as unknown as CodexAppServerClient, {
    resolveProviders: () => [{
      id: "bonsai", name: "Bonsai", compatibility: "bonsai", baseUrl: "http://127.0.0.1:18080/v1", models: ["Bonsai.gguf"],
    }],
    create: () => bonsai as unknown as CodexAppServerClient,
  });
  const params = { threadId, model, path: "/pwragent/owned/staging/thread.jsonl" };
  await client.forkThread(params);
  expect(primary.modelProviderForThread).not.toHaveBeenCalledWith(threadId);
  expect(primary.readThreadSummary).not.toHaveBeenCalled();
  const requested = model?.startsWith("@bonsai/") ? bonsai : primary;
  const other = requested === primary ? bonsai : primary;
  expect(requested.forkThread).toHaveBeenCalledExactlyOnceWith(params);
  expect(other.forkThread).not.toHaveBeenCalled();
}

it("routes a path fork independently of any receiver-local thread with the same ID", async () => {
  await fc.assert(fc.asyncProperty(
    fc.uuid(), fc.constantFrom(undefined, "gpt-5.5", "@bonsai/Bonsai.gguf"), assertPathRouting,
  ));
});

it("uses the default runtime for a path fork whose source ID matches a local Bonsai thread", async () => {
  await assertPathRouting("00000000-0000-1000-8000-000000000000");
});
