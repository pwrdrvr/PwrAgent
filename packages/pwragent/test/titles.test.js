import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { HeadlessBackend } from "../src/federation-backend.js";

function backendFixture(t, jobs, read = async () => ({ thread: { turns: [] } })) {
  const local = fileURLToPath(new URL("../../../.local/", import.meta.url));
  mkdirSync(local, { recursive: true });
  const directory = mkdtempSync(path.join(local, "titles-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const runtime = { projects: { list: () => [{ path: directory, label: "Fixture" }] }, workspace: directory, loadedThreads: new Set(),
    store: { directory: path.join(directory, "jobs"), jobs }, codex: { request: read }, onFailure: (error) => { throw error; } };
  const published = [];
  const backend = new HeadlessBackend(runtime, (event, eventClass) => published.push({ eventClass, ...event.notification }));
  return { backend, published, registry: () => JSON.parse(readFileSync(backend.file, "utf8")).threads };
}

function job(id, threadId, extra = {}) {
  return { id, threadId, createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-01T00:00:00.000Z", status: "running", sandbox: "read-only", ...extra };
}

test("the first prompt names a placeholder thread and announces it", (t) => {
  const jobs = new Map([["first", job("first", "thread", { turnId: "turn-1" })]]);
  const { backend, published, registry } = backendFixture(t, jobs);
  assert.equal(backend.owned("thread").titleSource, "fallback");
  backend.event({ method: "headless/turnStarted", params: { threadId: "thread", jobId: "first", prompt: "$plan Could you fix the flaky login test" } });
  assert.deepEqual((({ title, titleSource }) => ({ title, titleSource }))(backend.summary(backend.owned("thread"))),
    { title: "Fix the flaky login test", titleSource: "derived" });
  assert.deepEqual(published, [
    { eventClass: "transcript", method: "thread/name/updated", params: { threadId: "thread", threadName: "Fix the flaky login test", titleSource: "derived" } },
    { eventClass: "navigation", method: "navigation/invalidated", params: { threadId: "thread", sourceMethod: "thread/name/updated" } },
  ]);
  assert.equal(registry()[0].title, "Fix the flaky login test", "the registry persists the name");
  assert.ok(!published.some((event) => JSON.stringify(event).includes("$plan")), "the prompt itself is never published");
});

test("a later turn never names a thread; reading it uses Codex's preview, then its first user message", async (t) => {
  const jobs = new Map([["old", job("old", "legacy", { status: "completed", turnId: "turn-0" })], ["new", job("new", "legacy", { turnId: "turn-1" })],
    ["other", job("other", "no-preview", { status: "completed", turnId: "turn-2" })]]);
  const { backend } = backendFixture(t, jobs, async (method, params) => {
    assert.equal(method, "thread/read");
    const user = { type: "userMessage", content: [{ type: "text", text: "Help me audit the docker image size" }] };
    return params.threadId === "legacy" ? { thread: { preview: "Investigate the slow navigation query.", turns: [] } }
      : { thread: { preview: "", turns: [{ id: "turn-2", status: "completed", items: [user, { type: "agentMessage", text: "Done" }] }] } };
  });
  backend.event({ method: "headless/turnStarted", params: { threadId: "legacy", jobId: "new", prompt: "continue" } });
  assert.equal(backend.owned("legacy").titleSource, "fallback");
  await backend.readThread("legacy");
  assert.equal(backend.owned("legacy").title, "Investigate the slow navigation query");
  await backend.readThread("no-preview");
  assert.equal(backend.owned("no-preview").title, "Audit the docker image size");
});

test("an explicit rename is never replaced, and an empty prompt leaves the placeholder", async (t) => {
  const jobs = new Map([["named", job("named", "named", { turnId: "turn-1" })], ["blank", job("blank", "blank", { turnId: "turn-2" })]]);
  const { backend, published } = backendFixture(t, jobs, async () => ({ thread: { preview: "Something else", turns: [] } }));
  await backend.handle("renameThread", { threadId: "named", title: "  Release checklist " });
  assert.deepEqual(published[0], { eventClass: "transcript", method: "thread/name/updated",
    params: { threadId: "named", threadName: "Release checklist", titleSource: "explicit" } });
  backend.event({ method: "headless/turnStarted", params: { threadId: "named", jobId: "named", prompt: "Rewrite everything" } });
  await backend.readThread("named");
  assert.equal(backend.owned("named").title, "Release checklist");
  assert.equal(backend.owned("named").titleSource, "explicit");
  published.length = 0;
  backend.event({ method: "headless/turnStarted", params: { threadId: "blank", jobId: "blank", prompt: "   " } });
  assert.equal(backend.owned("blank").titleSource, "fallback");
  assert.deepEqual(published, []);
});
