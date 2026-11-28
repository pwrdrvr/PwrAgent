import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { Locator } from "@playwright/test";
import type { ThreadOverlayState } from "@pwragent/shared/contracts/navigation";
import type { AppServerReadThreadResponse, AppServerThreadSummary } from "@pwragent/shared/contracts/normalized-app-server";
import type { Cadence, CompletedTrace } from "../src/main/testing/active-paint-owner";
import type { ReplayFixture, ReplayResponseStep } from "../src/main/testing/replay-fixture";
import type { DesktopApi } from "../src/renderer/src/lib/desktop-api";
import { expect, test } from "./fixtures/electron-test";
import { StateDb } from "../src/main/state/state-db";
import { stateDbPathForHomeRoot } from "./fixtures/readme-state-seeding";
import { launchElectronApp } from "./fixtures/electron-app";
import { seedProfileOverlayState } from "./fixtures/overlay-state-seeding";

type Target = { selector?: string; text?: string };
type Frame = { input: number; frame: number; ms: number };
type Options = {
  copies: number;
  cadence: Cadence;
  held: number;
  queueDepth: number;
  redeliveries: number;
  warm: number;
  leadMs: number;
  scenario: "idle" | "active";
};
type Topology = {
  threads: Array<AppServerThreadSummary & Pick<ThreadOverlayState, "pinnedRank" | "parentThreadId" | "parentThreadBackend">
    & { prs?: unknown }>;
  archivedOverlays: Array<Omit<ThreadOverlayState, "executionMode" | "extraLinkedDirectories">>;
};

async function inputToFrame(locator: Locator, target: Target) {
  // Arm the observer before Playwright sends a trusted mouse click. Locator
  // discovery and actionability polling stay outside the measured interval.
  await locator.evaluate((element, target) => {
    const epoch = () => performance.timeOrigin + performance.now();
    const probe = window as Window & { auditVisibleFrame?: Promise<Frame> };
    probe.auditVisibleFrame = new Promise((resolve, reject) => {
      element.addEventListener("click", (event) => {
        if (!event.isTrusted) {
          reject(new Error("The frame probe requires native input"));
          return;
        }
        const input = performance.timeOrigin + event.timeStamp;
        const visible = (node: Element) => {
          const rect = node.getBoundingClientRect();
          return rect.width > 0 && rect.height > 0 && rect.bottom > 0 && rect.top < innerHeight
            && getComputedStyle(node).visibility === "visible";
        };
        const matches = () => {
          if (target.selector) {
            return element.getAttribute("aria-selected") === "true"
              && [...document.querySelectorAll(target.selector)].some(visible);
          }
          return [...document.querySelectorAll("p")].some(node => node.textContent === target.text && visible(node));
        };
        let hadVisibleFrame = false;
        const nextFrame = () => {
          if (epoch() - input > 15000) {
            reject(new Error(`No visible frame for ${JSON.stringify(target)}`));
            return;
          }
          const ready = matches();
          if (ready && hadVisibleFrame) {
            const frame = epoch();
            resolve({ input, frame, ms: frame - input });
          } else {
            hadVisibleFrame = ready;
            requestAnimationFrame(nextFrame);
          }
        };
        requestAnimationFrame(nextFrame);
      }, { capture: true, once: true });
    });
    // Preserve a rejection even if Playwright is still settling the action.
    void probe.auditVisibleFrame.catch(() => {});
  }, target);
  await locator.click();
  return locator.page().evaluate(() => (window as Window & { auditVisibleFrame?: Promise<Frame> }).auditVisibleFrame!);
}

test("measures native navigation under synthetic owner event load", async () => {
  test.setTimeout(180000);
  const options = JSON.parse(process.env.AUDIT_PAINT_CASE!) as Options;
  const { copies, cadence, held, queueDepth, redeliveries, warm, leadMs, scenario } = options;
  const root = await mkdtemp(path.join(os.tmpdir(), "audit-active-"));
  const shape = JSON.parse(await readFile(process.env.AUDIT_PAINT_TOPOLOGY!, "utf8")) as Topology;
  const fixture = JSON.parse(await readFile(path.join(import.meta.dirname, "fixtures/a11y-directories/replay.fixture.json"), "utf8")) as ReplayFixture;
  const response = (method: ReplayResponseStep["method"]) => {
    const step = fixture.steps.find((step): step is ReplayResponseStep => step.kind === "response" && step.method === method);
    assert(step, `Replay fixture needs a ${method} response`);
    return step;
  };
  const listing = response("thread/list");
  const clock = Date.now() - shape.threads.length;
  const rows = shape.threads.map(({ prs: _prs, pinnedRank: _pin, ...row }, index) => ({
    ...row, source: "codex", updatedAt: clock - index, createdAt: clock - index, executionMode: "default",
    ...(row.parentThreadId ? { parentThreadBackend: "codex" } : {}),
  }));
  const pinned = shape.threads.filter(row => row.pinnedRank);
  expect(rows).toHaveLength(869 * copies);
  expect(pinned).toHaveLength(105 * copies);
  const targets = pinned.filter(row => !row.parentThreadId).slice(0, 3);
  const background = shape.threads.filter(row => !row.pinnedRank && !row.parentThreadId).map(row => row.id);
  const [turnThread, ...remaining] = background;
  const markers = targets.map((row, index) => ({ threadId: row.id, title: row.title, text: `Synthetic transcript marker ${index}` }));
  listing.result = rows;
  fixture.metadata = { ...fixture.metadata, scenario: "Synthetic active navigation audit", threadId: markers[0].threadId };
  const read = response("thread/read");
  const template = read.result as AppServerReadThreadResponse["replay"];
  fixture.steps = fixture.steps.filter(step => step !== read);
  for (const marker of markers) {
    const entries = [
      { type: "message", id: "audit-question", role: "user", text: "Show this synthetic thread." },
      { type: "message", id: "audit-response", role: "assistant", text: marker.text },
    ];
    fixture.steps.push({
      ...read, id: `read-${marker.threadId}`, threadId: marker.threadId,
      result: { ...template, entries, messages: entries, lastUserMessage: entries[0].text, lastAssistantMessage: marker.text },
    });
  }
  const fixturePath = path.join(root, "replay.fixture.json");
  await writeFile(fixturePath, JSON.stringify(fixture));
  const app = await launchElectronApp({
    fixturePath, env: { AUDIT_ACTIVE_PAINT: "1" }, windowSize: { width: 1440, height: 900 },
    preLaunchHook: async home => {
      const overlay: ThreadOverlayState[] = shape.threads.filter(row => row.pinnedRank || row.parentThreadId).map(row => ({
        backend: "codex", threadId: row.id, executionMode: "default", extraLinkedDirectories: [],
        ...(row.pinnedRank ? { pinnedRank: row.pinnedRank } : {}),
        ...(row.parentThreadId ? { parentThreadId: row.parentThreadId, parentThreadBackend: "codex" } : {}),
      }));
      await seedProfileOverlayState(home, { threads: [
        ...overlay,
        ...shape.archivedOverlays.map((row): ThreadOverlayState => ({
          ...row, executionMode: "default", extraLinkedDirectories: [],
        })),
      ] });
      const db = StateDb.open(stateDbPathForHomeRoot(home), { profileName: "default" });
      try {
        db.raw.prepare("INSERT OR REPLACE INTO provider_thread_snapshots(backend,schema_version,observed_at,payload) VALUES(?,?,?,?)")
          .run("codex", 1, Date.now(), JSON.stringify(rows));
      } finally { db.close(); }
    },
  });
  try {
    const updated = app.window.getByRole("tab", { name: "Updated", exact: true });
    const directories = app.window.getByRole("tab", { name: "Directories", exact: true });
    await expect(updated).toBeVisible();
    if (await updated.getAttribute("aria-selected") !== "true") await updated.click();
    const row = (index: number) => app.window.getByRole("button", { name: `${markers[index].title}, pinned`, exact: true });
    const counts = () => app.window.evaluate(async () => {
      const api = (window as unknown as { pwragent: DesktopApi }).pwragent;
      try {
        const page = await api.getNavigationQueryPage!({
          protocol: 2, consumer: "main-sidebar", inventory: "viewer", query: { kind: "directory-index" },
        }, "audit-population");
        return page.counts;
      } finally { await api.releaseNavigationQuery!("audit-population"); }
    });

    const expectedInventory = { total: 869 * copies, pinned: 105 * copies };
    await expect.poll(counts, { timeout: 45000 }).toMatchObject(expectedInventory);
    const inventoryReadyAt = performance.now();
    // The owner count can resolve while the first renderer lens page is
    // still pending. Wait for that page to leave its explicit loading state.
    const sidebar = app.window.getByRole("region", { name: "Thread browser", exact: true });
    await expect(sidebar.getByText("Loading threads…", { exact: true })).toBeHidden({ timeout: 60000 });
    const lensReadyAfterInventoryMs = performance.now() - inventoryReadyAt;
    await expect(row(0)).toBeVisible();
    await row(0).click();
    await expect(app.window.getByText(markers[0].text, { exact: true })).toBeVisible();
    const prepared = await app.electronApp.evaluate(async (_electron, args) =>
      globalThis.__activePaint!.prepare(args), {
      cadence, heldThreads: remaining.slice(10, 10 + held), statusThreads: remaining.slice(2, 10),
      turnThread, federationThreads: [remaining[0], remaining[1]] as [string, string], queueDepth, redeliveries,
    });
    // Archived overlays stay out of the owner inventory. Scaling duplicates
    // the entire anonymous live topology, including its manual pin ranks.
    const inventory = await counts();
    expect(inventory).toMatchObject(expectedInventory);
    const began = await app.electronApp.evaluate((_electron, cadence) => globalThis.__activePaint!.start(cadence), cadence);
    if (leadMs) await new Promise(resolve => setTimeout(resolve, leadMs));
    const samples: Array<Frame & { name: string; phase: string; index: number }> = [];
    const result = {
      platform: {
        arch: process.arch, os: os.release(), cpuCount: os.cpus().length,
        gpuDisabled: process.env.PWRAGENT_E2E_DISABLE_GPU === "1",
      },
      options, inventory, prepared, began, samples, lensReadyAfterInventoryMs,
    };
    let owner: CompletedTrace;
    try {
      for (let index = 0; index <= warm; index++) {
        const phase = index === 0 ? "cold" : "warm";
        if (index === 1) {
          await row(2).click();
          await expect(app.window.getByText(markers[2].text, { exact: true })).toBeVisible();
        }
        const thread = index === 0 ? 1 : 1 + (index - 1) % 2;
        for (const [name, action] of [
          ["Directories", () => inputToFrame(directories, { selector: "section.directory-row .directory-row__summary" })],
          ["Updated", () => inputToFrame(updated, { selector: ".sidebar-list--dense .thread-row" })],
          ["Open thread", () => inputToFrame(row(thread), { text: markers[thread].text })],
        ] as const) {
          samples.push({ name, phase, index, ...await action() });
        }
      }
    } finally {
      owner = await app.electronApp.evaluate(() => globalThis.__activePaint!.stop());
      await writeFile(process.env.AUDIT_PAINT_OUTPUT!, JSON.stringify({ ...result, owner }));
    }
    expect(result.samples).toHaveLength((1 + warm) * 3);
    expect(owner.queries.every(query => query.end <= owner.stoppedAt)).toBe(true);
    for (const [lane, interval] of Object.entries(cadence)) {
      const deliveries = owner.deliveries.filter(delivery => delivery.lane === lane);
      if (interval) expect(deliveries.length, `active ${lane} train`).toBeGreaterThan(1);
      else expect(deliveries, `idle ${lane} train`).toHaveLength(0);
    }
    if (cadence.review) {
      expect(owner.events.filter(event => event.method === "turn/completed").length).toBeGreaterThan(1);
      expect(owner.events.some(event => event.method === "thread/pricing/updated")).toBe(true);
      expect(owner.countedReviews).toBeGreaterThan(began.startReviews);
    }
    if (cadence.status) expect(owner.events.some(event => event.method === "thread/status/changed")).toBe(true);
    expect(scenario === "idle").toBe(Object.values(cadence).every(value => value === 0));
    expect(owner.queries.some(query => query.kind.startsWith("navigation:"))).toBe(true);
    expect(owner.queries.some(query => query.kind === `thread:${markers[1].threadId}`)).toBe(true);
    await writeFile(process.env.AUDIT_PAINT_OUTPUT!, JSON.stringify({ ...result, owner, verified: true }));
  } finally {
    await app.close();
    await rm(root, { recursive: true, force: true });
  }
});
