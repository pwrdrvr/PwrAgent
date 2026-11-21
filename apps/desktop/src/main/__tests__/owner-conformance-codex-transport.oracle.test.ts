import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { expect, it, vi } from "vitest";
import { OwnerConformanceCodexTransport } from "./fixtures/owner-conformance-codex-transport";

vi.mock("node:fs", async (importOriginal) => ({
  ...await importOriginal<typeof import("node:fs")>(),
  // Model a directory watcher that loses the release notification.
  watch: () => ({ close() {} }),
}));

it("the fixture acknowledges a published steer release even without a file notification", async ({ onTestFinished }) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "pa-steer-ack-"));
  const transport = new OwnerConformanceCodexTransport();
  OwnerConformanceCodexTransport.reset();
  OwnerConformanceCodexTransport.recordsFile = path.join(directory, "fixture-threads.json");
  onTestFinished(async () => {
    await transport.close();
    OwnerConformanceCodexTransport.reset();
    await rm(directory, { recursive: true, force: true });
  });
  const received = vi.fn((message: string) => JSON.parse(message));
  transport.setMessageHandler(received);
  const send = (id: number, method: string, params: object) => transport.send(JSON.stringify({ id, method, params }));
  const replies = (id: number) => received.mock.results.map(result => result.value).filter(message => message.id === id);

  send(1, "thread/start", { cwd: directory });
  const threadId = replies(1)[0].result.thread.id;
  send(2, "turn/start", { threadId, input: [{ type: "text", text: "slow" }] });
  const turnId = replies(2)[0].result.turn.id;
  send(3, "turn/steer", { threadId, expectedTurnId: turnId, input: [{ type: "text", text: "hold-steer-ack" }] });
  expect(replies(3)).toEqual([]);

  await writeFile(path.join(directory, "steer.release"), "release");
  await vi.waitFor(() => expect(replies(3)).toEqual([{ jsonrpc: "2.0", id: 3, result: { turnId } }]));
});
