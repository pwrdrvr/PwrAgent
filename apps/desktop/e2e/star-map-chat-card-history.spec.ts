import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { expect, test } from "@playwright/test";
import { launchElectronApp } from "./fixtures/electron-app";
import {
  startInProcessFederationGateway,
  type InProcessFederationGateway,
} from "./fixtures/federation-gateway";

/**
 * A Star Map chat card must not read or mount a whole large thread.
 *
 * This is the regression that shipped: the card opened on a ~135 MB Codex
 * thread pulled the transcript from its first message and mounted every
 * entry, landing the operator at the OLDEST message. Three separate
 * defects produced it, and NONE of them were catchable in jsdom — one was
 * pure CSS (a wrapper stealing the scroller's overflow, which silently
 * disabled scroll-to-bottom, glue, and paging), and the other two only
 * show up against a backend that reports what it was actually asked for.
 *
 * So the gateway here is a real paging backend over a synthetic ~120 MB
 * transcript: it honours `limit`/`before`, counts the bytes it hands over,
 * and records any read that asked for the thread from the beginning. The
 * assertions are about behaviour a user would notice — how much crossed
 * the wire, how many nodes mounted, where the view landed, and whether
 * scrolling up fetches a BOUNDED page rather than the rest of the thread.
 */

const THREAD_TITLE = "Huge remote transcript";
const ENTRY_COUNT = 20_000;
const BYTES_PER_ENTRY = 6_000;
/** ~120 MB — what a client asking for everything would be served. */
const TOTAL_TRANSCRIPT_BYTES = ENTRY_COUNT * BYTES_PER_ENTRY;

/**
 * Generous on purpose. The point is the ORDER OF MAGNITUDE: a card that
 * mounts the whole thread is in the tens of thousands of nodes, and one
 * that windows correctly is in the hundreds. A threshold this loose still
 * fails hard on the regression without being brittle about how many
 * elements a message bubble happens to render.
 */
const MAX_TRANSCRIPT_NODES = 4_000;
/** Likewise: a bounded open is well under a megabyte. */
const MAX_OPEN_BYTES = 4_000_000;

async function createLocalControlFixture(): Promise<{
  cleanup: () => Promise<void>;
  fixturePath: string;
}> {
  const rootDir = await mkdtemp(
    path.join(os.tmpdir(), "pwragent-chat-card-history-e2e-"),
  );
  const fixturePath = path.join(rootDir, "local.fixture.json");
  await writeFile(
    fixturePath,
    JSON.stringify({
      metadata: { backend: "codex", scenario: "chat-card-history-control" },
      steps: [
        {
          id: "initialize-1",
          kind: "response",
          method: "initialize",
          result: {
            serverInfo: { name: "Replay Codex", version: "1.0.0" },
            methods: ["thread/list", "thread/read", "skills/list", "turn/start"],
          },
        },
        {
          id: "thread-list-1",
          kind: "response",
          method: "thread/list",
          result: [],
        },
      ],
    }),
    "utf8",
  );
  return {
    cleanup: () => rm(rootDir, { recursive: true, force: true }),
    fixturePath,
  };
}

test.describe("star map chat card history", () => {
  let gateway: InProcessFederationGateway | undefined;
  let fixture: { cleanup: () => Promise<void>; fixturePath: string } | undefined;
  let app: Awaited<ReturnType<typeof launchElectronApp>> | undefined;

  test.afterEach(async () => {
    await app?.close();
    await gateway?.close();
    await fixture?.cleanup();
    app = undefined;
    gateway = undefined;
    fixture = undefined;
  });

  test("opens a huge remote thread bounded, at the bottom, and pages on scroll", async () => {
    test.slow();
    gateway = await startInProcessFederationGateway({
      threads: [
        {
          id: "huge-thread",
          title: THREAD_TITLE,
          updatedAt: Date.now(),
          // Without this the thread matches no attention category and
          // never reaches a lane, so the card would never be clickable.
          threadStatus: "active",
          transcript: {
            entryCount: ENTRY_COUNT,
            bytesPerEntry: BYTES_PER_ENTRY,
          },
        },
      ],
    });
    fixture = await createLocalControlFixture();

    app = await launchElectronApp({
      fixturePath: fixture.fixturePath,
      secretStorage: "memory",
    });
    const { window } = app;

    // Enroll into the peer through the real Settings flow.
    await window.getByRole("button", { name: "Open settings" }).click();
    await window
      .getByRole("navigation", { name: "Settings sections" })
      .getByRole("button", { name: "Federation" })
      .click();
    await window.getByLabel("Import invite").fill(gateway.invite);
    await window.getByRole("button", { name: "Import invite" }).click();
    await gateway.waitForConnection(30_000);
    await expect(
      window
        .getByRole("region", { name: "Connection" })
        .getByText("Connected", { exact: true }),
    ).toBeVisible({ timeout: 30_000 });
    await window.getByRole("button", { name: "Exit Settings" }).click();

    // Open the map and the peer's thread as a floating chat card.
    await window.getByRole("button", { name: "Open Star Map" }).click();
    const starMap = window.getByRole("region", {
      name: "Star Map",
      exact: true,
    });
    await expect(starMap).toBeVisible();

    const card = starMap.getByRole("button", {
      name: `Open thread: ${THREAD_TITLE}`,
    });
    await expect(card).toBeVisible({ timeout: 30_000 });
    await card.click();

    const chatCard = window.getByRole("region", {
      name: `Chat: ${THREAD_TITLE}`,
    });
    await expect(chatCard).toBeVisible();
    const scroller = chatCard.locator(".transcript-list__items");
    await expect(scroller).toBeVisible();
    // Wait for the transcript to actually populate before measuring —
    // every assertion below is vacuous against an empty card.
    await expect
      .poll(() => gateway?.transcriptStats.entriesServed ?? 0, {
        timeout: 30_000,
      })
      .toBeGreaterThan(0);
    await expect(scroller.getByText(/^entry \d+ x+/).first()).toBeVisible({
      timeout: 30_000,
    });

    // 1. It never asked for the thread from its first message.
    expect(gateway.transcriptStats.unboundedRequests).toBe(0);

    // 2. What crossed the wire is a rounding error against the thread.
    const openBytes = gateway.transcriptStats.bytesServed;
    expect(openBytes).toBeGreaterThan(0);
    expect(openBytes).toBeLessThan(MAX_OPEN_BYTES);
    expect(openBytes).toBeLessThan(TOTAL_TRANSCRIPT_BYTES / 20);

    // 3. It did not mount tens of thousands of nodes.
    const nodeCount = await chatCard
      .locator(".star-map-chat-card__transcript")
      .evaluate((element) => element.querySelectorAll("*").length);
    expect(nodeCount).toBeGreaterThan(0);
    expect(nodeCount).toBeLessThan(MAX_TRANSCRIPT_NODES);

    // 4. It opened at the NEWEST message. This is the one the CSS-contract
    //    unit test can only approximate: jsdom does no layout, so nothing
    //    else in the suite can tell a working scroller from a dead one.
    const atBottom = await scroller.evaluate((element) => ({
      clientHeight: element.clientHeight,
      distance:
        element.scrollHeight - element.clientHeight - element.scrollTop,
      scrollHeight: element.scrollHeight,
      scrollTop: element.scrollTop,
    }));
    // The scroller must genuinely OVERFLOW, not merely exist. In the
    // broken state the items box grew to its full content height and
    // scrollHeight === clientHeight, which makes `distance` 0 and
    // "scrolled to the bottom" true of a box that cannot scroll at all —
    // the exact defect this test exists to catch, passing itself.
    expect(atBottom.clientHeight).toBeGreaterThan(0);
    expect(atBottom.scrollHeight).toBeGreaterThan(atBottom.clientHeight + 200);
    // And it must have been moved there, not left at the top.
    expect(atBottom.scrollTop).toBeGreaterThan(0);
    expect(atBottom.distance).toBeLessThan(80);

    // 5. Scrolling up fetches a BOUNDED page, not the rest of the thread.
    const bytesBeforeScroll = gateway.transcriptStats.bytesServed;
    const readsBeforeScroll = gateway.calls.filter(
      (call) => call.method === "readThread",
    ).length;
    await scroller.evaluate((element) => {
      element.scrollTop = 0;
      element.dispatchEvent(new Event("scroll", { bubbles: true }));
    });

    await expect
      .poll(
        () => gateway?.calls.filter((call) => call.method === "readThread").length ?? 0,
        { timeout: 30_000 },
      )
      .toBeGreaterThan(readsBeforeScroll);

    const scrollBytes = gateway.transcriptStats.bytesServed - bytesBeforeScroll;
    expect(scrollBytes).toBeLessThan(MAX_OPEN_BYTES);

    // Every read the card ever issued carried a limit.
    const reads = gateway.calls.filter((call) => call.method === "readThread");
    for (const read of reads) {
      expect((read.params as { limit?: number }).limit).toBeGreaterThan(0);
    }
  });
});
