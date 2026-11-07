import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import fc from "fast-check";
import { expect, test, type Page } from "./fixtures/electron-test";
import { launchElectronApp } from "./fixtures/electron-app";
import { stateDbPathForHomeRoot } from "./fixtures/readme-state-seeding";
import { StateDb } from "../src/main/state/state-db";
import { ThreadTodoService } from "../src/main/thread-todos/thread-todo-service";
import { ThreadTodoStore } from "../src/main/storage/thread-todo-store";

type Labels = { chip: string; machineLine: string; title: string; branch: string; project: string; machine: string };

// Words as people and agents write them, plus unbroken runs: paths, branch
// names and ids that have no space to wrap at.
const word = fc.stringMatching(/^[A-Za-z0-9][A-Za-z0-9_./#-]{0,15}$/);
const unbroken = fc.stringMatching(/^[A-Za-z0-9_./-]{20,90}$/);
const text = fc.array(fc.oneof({ arbitrary: word, weight: 4 }, { arbitrary: unbroken, weight: 1 }), { minLength: 1, maxLength: 16 })
  .map((parts) => parts.join(" "));
const labels: fc.Arbitrary<Labels> = fc.record({
  chip: text, machineLine: text, title: text, project: text, machine: text,
  branch: fc.array(word, { minLength: 1, maxLength: 8 }).map((parts) => parts.join("/")),
});

/**
 * Writes the labels into the rendered destination and its picker rows, then
 * names every box that leaves the card and every text cut without an
 * ellipsis. The PR strip scrolls by design, so its chips are measured
 * against the strip, which itself must stay inside.
 */
async function layoutProblems(page: Page, next: Labels): Promise<string[]> {
  return page.evaluate((labels) => {
    const destination = document.querySelector<HTMLElement>(".todo-message-destination");
    const body = destination?.closest<HTMLElement>(".thread-todo-card__body");
    if (!destination || !body) return ["no destination on screen"];
    const write = (selector: string, value: string) => {
      for (const element of destination.querySelectorAll<HTMLElement>(selector)) element.textContent = value;
    };
    write(".todo-message-destination__target .thread-chip__label", labels.chip);
    write(".todo-message-destination__target small", labels.machineLine);
    write(".jump-palette__row-title", labels.title);
    write(".jump-palette__row-branch", labels.branch);
    write(".jump-palette__row-repo", labels.project);
    write(".chip--instance__label", labels.machine);
    const edge = body.getBoundingClientRect();
    const problems: string[] = [];
    for (const element of destination.querySelectorAll<HTMLElement>("*")) {
      const box = element.getBoundingClientRect();
      const name = `${element.tagName.toLowerCase()}.${[...element.classList].join(".")}`;
      if (box.width > 0 && !element.closest(".jump-palette__row-prs > *")
        && (box.right > edge.right + 0.5 || box.left < edge.left - 0.5)) {
        problems.push(`${name} leaves the card: ${box.left.toFixed(1)}–${box.right.toFixed(1)} vs ${edge.left.toFixed(1)}–${edge.right.toFixed(1)}`);
      }
      const style = getComputedStyle(element);
      const clipsText = element.scrollWidth > element.clientWidth + 0.5 && style.overflowX === "hidden"
        && style.whiteSpace === "nowrap" && [...element.childNodes].some((node) => node.nodeType === Node.TEXT_NODE);
      if (clipsText && style.textOverflow !== "ellipsis") problems.push(`${name} cuts its text without an ellipsis`);
    }
    return problems;
  }, next);
}

/** Contrived Atlas data only. */
test("a to-do destination and its picker rows stay inside the card for any label", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "pwragent-todo-destination-layout-"));
  const fixturePath = path.join(root, "replay.fixture.json");
  const source = "atlas-webhooks";
  const directory = { id: "atlas", label: "atlas", path: "/example/atlas", kind: "local" };
  const thread = (id: string, title: string, gitBranch: string, updatedAt: number) => ({
    id, title, summary: title, source: "codex", executionMode: "default", model: "gpt-5.5", reasoningEffort: "high",
    gitBranch, linkedDirectories: [directory], updatedAt,
  });
  await writeFile(fixturePath, JSON.stringify({
    metadata: { backend: "codex", scenario: "todo-destination-layout", threadId: source },
    steps: [
      { id: "initialize", kind: "response", method: "initialize", result: {
        serverInfo: { name: "Replay Codex", version: "1.0.0" }, methods: ["thread/list", "thread/read", "skills/list"],
      } },
      { id: "threads", kind: "response", method: "thread/list", result: [
        thread(source, "Webhook delivery hardening", "agent/webhook-delivery", 1_791_600_000_000),
        thread("atlas-rate-limits", "Per-route rate limits", "agent/rate-limits", 1_791_599_000_000),
        thread("atlas-signing", "Rotate signing keys", "agent/signing-keys", 1_791_598_000_000),
        thread("atlas-retries", "Bound delivery retries", "main", 1_791_597_000_000),
      ] },
      { id: "read", kind: "response", method: "thread/read", result: {
        entries: [{ type: "message", id: "summary", role: "assistant", text: "Raised the hand-off as a to-do.", createdAt: 1_791_600_000_000 }],
        messages: [], threadStatus: "idle", pagination: { supportsPagination: false, hasPreviousPage: false },
      } },
      { id: "skills", kind: "response", method: "skills/list", result: { data: [] } },
    ],
  }));
  const app = await launchElectronApp({
    fixturePath, contextRailPinned: false,
    preLaunchHook: async (homeRoot) => {
      const db = StateDb.open(stateDbPathForHomeRoot(homeRoot));
      try {
        db.raw.prepare("INSERT OR REPLACE INTO threads(thread_id, payload) VALUES (?, ?)").run(`codex:${source}`, JSON.stringify({
          backend: "codex", threadId: source, executionMode: "default", model: "gpt-5.5", reasoningEffort: "high", extraLinkedDirectories: [],
        }));
        new ThreadTodoService({ store: new ThreadTodoStore(db), now: () => 1_791_600_000_000, newId: () => "atlas-handoff" }).add({
          backend: "codex", threadId: source,
          sourceProject: { key: "directory:atlas", label: "atlas", path: "/example/atlas" },
          input: {
            title: "Share the retry budget with the rate limiter",
            detail: "The limiter should see retries as load.",
            action: { type: "send_message", target: { backend: "codex", threadId: "atlas-rate-limits", title: "Per-route rate limits" },
              prompt: "Count delivery retries against the tenant's route budget." },
          },
        });
      } finally { db.close(); }
    },
  });
  try {
    await app.window.getByRole("button", { name: "Webhook delivery hardening", exact: true }).click();
    const stack = app.window.getByRole("region", { name: "To-dos for this thread" });
    await expect(stack.getByRole("button", { name: "Open thread Per-route rate limits", exact: true })).toBeVisible();
    await stack.getByRole("button", { name: "Change", exact: true }).click();
    const options = stack.getByRole("option");
    // The card's own thread is never offered; the other three are.
    await expect(options).toHaveCount(3);
    await expect(stack.locator(".jump-palette__row-branch").first()).toBeVisible();
    await expect(stack.locator(".jump-palette__row-repo").first()).toBeVisible();

    // A known-long label first, so a green run cannot mean nothing was long.
    const long = "Investigate delayed Telegram typing indicator after the November 4 regression in messaging adapters";
    expect(await layoutProblems(app.window, {
      chip: long, machineLine: long, title: long, project: `${long}-project`, machine: long,
      branch: "agent/investigate-delayed-telegram-typing-indicator-after-the-regression",
    })).toEqual([]);
    expect(await stack.locator(".todo-message-destination__target .thread-chip__label")
      .evaluate((label) => label.scrollWidth > label.clientWidth)).toBe(true);

    await fc.assert(fc.asyncProperty(labels, async (next) => {
      expect(await layoutProblems(app.window, next)).toEqual([]);
    }), { numRuns: 60 });
  } finally {
    await app.close();
    await rm(root, { recursive: true, force: true });
  }
});
