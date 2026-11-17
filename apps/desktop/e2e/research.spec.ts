import path from "node:path";
import { fileURLToPath } from "node:url";
import { expect, test } from "./fixtures/electron-test";
import { launchElectronApp } from "./fixtures/electron-app";
import { stateDbPathForHomeRoot } from "./fixtures/readme-state-seeding";
import { LIVE_RESEARCH_OBJECTIVE, LONG_RESEARCH_EVENTS, LONG_RESEARCH_OBJECTIVE, RESEARCH_FIXTURE_OBJECTIVE, enableResearchFixture, readResearchOwnerIdentity, seedLiveResearchRun, seedLongResearchRun, seedResearchState } from "./fixtures/research-state-seeding";

const specDir = path.dirname(fileURLToPath(import.meta.url));

test("research stays hidden until the experiment is enabled and hides again when disabled", async () => {
  const app = await launchElectronApp({
    fixturePath: path.join(specDir, "fixtures/research/replay.fixture.json"),
    preLaunchHook: async (homeRoot) => { seedResearchState(stateDbPathForHomeRoot(homeRoot)); },
  });
  try {
    await app.window.getByRole("button", { name: /Queue ordering research/ }).first().click();
    await expect(app.window.getByRole("tab", { name: "Research", exact: true })).toHaveCount(0);
    await app.window.getByRole("button", { name: "Open settings" }).click();
    const nav = app.window.getByRole("navigation", { name: "Settings sections" });
    await nav.getByRole("button", { name: "Experimental", exact: true }).click();
    const toggle = app.window.getByRole("switch", { name: "Enable research runs", exact: true });
    await expect(toggle).not.toBeChecked();
    await app.window.screenshot({ path: path.resolve(specDir, "../../../.local/research-experiment-off.png") });
    await toggle.click();
    await expect(toggle).toBeChecked();
    await nav.getByRole("button", { name: /Exit Settings/i }).click();
    await app.window.getByRole("tab", { name: "Research", exact: true }).click();
    await expect(app.window.getByRole("region", { name: "Research", exact: true }).getByText(RESEARCH_FIXTURE_OBJECTIVE, { exact: true }).first()).toBeVisible();
    await app.window.getByRole("button", { name: "Open settings" }).click();
    await nav.getByRole("button", { name: "Experimental", exact: true }).click();
    await app.window.getByRole("switch", { name: "Enable research runs", exact: true }).click();
    await nav.getByRole("button", { name: /Exit Settings/i }).click();
    await expect(app.window.getByRole("tab", { name: "Research", exact: true })).toHaveCount(0);
    await expect(app.window.getByRole("region", { name: "Research", exact: true })).toHaveCount(0);
  } finally { await app.close(); }
});

for (const theme of ["dark", "light"] as const) {
  test(`research map, findings, review and items preserve their evidence in ${theme} mode`, async () => {
    const app = await launchElectronApp({
      fixturePath: path.join(specDir, "fixtures/research/replay.fixture.json"),
      appearance: { theme },
      preLaunchHook: async (homeRoot) => { enableResearchFixture(homeRoot); seedResearchState(stateDbPathForHomeRoot(homeRoot)); },
    });
    try {
      await app.window.emulateMedia({ reducedMotion: "reduce" });
      await app.window.getByRole("button", { name: /Queue ordering research/ }).first().click();
      await app.window.getByRole("tab", { name: "Research", exact: true }).click();
      const panel = app.window.getByRole("region", { name: "Research", exact: true });
      await expect(panel.getByLabel("Research map")).toBeVisible();
      await expect(panel.getByText(RESEARCH_FIXTURE_OBJECTIVE, { exact: true }).first()).toBeVisible();
      await expect(panel.getByText("Completed", { exact: true }).first()).toBeVisible();
      await expect(panel.getByRole("button", { name: /^Open worker thread: / })).toHaveCount(4);
      // The focused child nests under the finding it investigated.
      await expect(panel.getByRole("button", { name: /^Focused child · Check independent holds/ })).toBeVisible();
      await app.window.screenshot({ path: path.resolve(specDir, `../../../.local/research-graph-${theme}.png`) });
      await panel.getByRole("tab", { name: "Findings", exact: true }).click();
      await expect(panel.getByLabel("Shared findings")).toBeVisible();
      await panel.getByRole("article").filter({ hasText: "Persisted insertion order agrees" }).getByRole("button", { name: /^Supports: A deterministic/ }).click();
      await expect(panel.getByRole("heading", { name: "Experiment from Event ordering" })).toBeFocused();
      await panel.getByRole("tab", { name: "Review", exact: true }).click();
      await expect(panel.getByText(/It is not formal verification/)).toBeVisible();
      const candidates = panel.getByRole("article", { name: "Candidate from Event ordering" });
      await expect(candidates).toHaveCount(2);
      await expect(candidates.filter({ hasText: "Accepted" })).toHaveCount(1);
      await expect(candidates.filter({ hasText: "Revision requested" })).toHaveCount(1);
      await expect(panel.getByText(/engineering review, not a formal proof/)).toBeVisible();
      await app.window.screenshot({ path: path.resolve(specDir, `../../../.local/research-review-${theme}.png`) });
      await panel.getByRole("tab", { name: "Items", exact: true }).click();
      await expect(panel.getByLabel("Research items")).toBeVisible();
      await panel.getByRole("combobox", { name: "Type" }).click();
      await app.window.getByRole("option", { name: "Findings", exact: true }).click();
      await panel.getByRole("combobox", { name: "Progress" }).click();
      await app.window.getByRole("option", { name: "Completed", exact: true }).click();
      await panel.getByRole("searchbox", { name: "Search items" }).fill("deterministic replay");
      await panel.getByRole("button", { name: "Search", exact: true }).click();
      await expect(panel.getByText("1 item", { exact: true })).toBeVisible();
      await panel.getByRole("button", { name: /^Experiment · Completed A deterministic replay/ }).click();
      await expect(panel.getByRole("heading", { name: "Experiment from Event ordering" })).toBeFocused();
      await expect(panel.getByText("ordering", { exact: true })).toBeVisible();
      await expect(panel.getByRole("button", { name: "Open child thread", exact: true })).toBeVisible();
      await expect(panel.getByText(/focused child reproduced/)).toBeVisible();
      await app.window.screenshot({ path: path.resolve(specDir, `../../../.local/research-items-${theme}.png`) });
      await panel.getByRole("button", { name: "← Back to results", exact: true }).click();
      await expect(panel.getByRole("button", { name: /^Experiment · Completed A deterministic replay/ })).toBeFocused();
      await panel.getByRole("tab", { name: "Activity", exact: true }).click();
      await expect(panel.getByLabel("Research activity")).toBeVisible();
      await app.window.reload();
      await app.window.getByRole("button", { name: /Queue ordering research/ }).first().click();
      await app.window.getByRole("tab", { name: "Research", exact: true }).click();
      await expect(app.window.getByRole("region", { name: "Research", exact: true }).getByText(RESEARCH_FIXTURE_OBJECTIVE, { exact: true }).first()).toBeVisible();
    } finally { await app.close(); }
  });
}

test("a live run shows time left, review work and a confirmed stop", async () => {
  const app = await launchElectronApp({
    fixturePath: path.join(specDir, "fixtures/research/replay.fixture.json"),
    preLaunchHook: async (homeRoot) => { enableResearchFixture(homeRoot); seedResearchState(stateDbPathForHomeRoot(homeRoot)); },
  });
  try {
    await app.window.emulateMedia({ reducedMotion: "reduce" });
    seedLiveResearchRun(stateDbPathForHomeRoot(app.homeRoot), readResearchOwnerIdentity(app.homeRoot, app.electronApp.process().pid!));
    await app.window.reload();
    await app.window.getByRole("button", { name: /Queue ordering research/ }).first().click();
    await app.window.getByRole("tab", { name: "Research", exact: true }).click();
    const panel = app.window.getByRole("region", { name: "Research", exact: true });
    const summary = panel.getByRole("region", { name: "Research run summary" });
    await expect(summary).toContainText(LIVE_RESEARCH_OBJECTIVE);
    await expect(summary).toContainText(/\d+ min left · ends /);
    await expect(summary).toContainText("Accept a candidate to finish the run.");
    // Two original workers and the focused child hold slots; ended workers do not.
    await expect(summary.getByText("3 of 4", { exact: true })).toBeVisible();
    const reviewTab = panel.getByRole("tab", { name: /^Review\b/ });
    await expect(reviewTab).toHaveAccessibleName(/^Review\W+1 to review$/);
    await reviewTab.click();
    const waiting = panel.getByRole("region", { name: "Candidates to review" });
    await expect(waiting.getByRole("article")).toHaveCount(1);
    await expect(waiting.getByRole("button", { name: "Accept", exact: true })).toBeDisabled();
    await panel.getByRole("button", { name: "Stop run…", exact: true }).click();
    await expect(panel.getByRole("button", { name: "Keep running", exact: true })).toBeFocused();
    await panel.getByRole("button", { name: "Keep running", exact: true }).click();
    await expect(summary.getByText("Running", { exact: true })).toBeVisible();
  } finally { await app.close(); }
});

test("a long run's Map, Findings and Activity show its newest work first and page back to the first", async () => {
  const app = await launchElectronApp({
    fixturePath: path.join(specDir, "fixtures/research/replay.fixture.json"),
    preLaunchHook: async (homeRoot) => {
      enableResearchFixture(homeRoot);
      seedResearchState(stateDbPathForHomeRoot(homeRoot));
      seedLongResearchRun(stateDbPathForHomeRoot(homeRoot));
    },
  });
  try {
    await app.window.emulateMedia({ reducedMotion: "reduce" });
    await app.window.getByRole("button", { name: /Queue ordering research/ }).first().click();
    await app.window.getByRole("tab", { name: "Research", exact: true }).click();
    const panel = app.window.getByRole("region", { name: "Research", exact: true });
    await expect(panel.getByRole("region", { name: "Research run summary" })).toContainText(RESEARCH_FIXTURE_OBJECTIVE);
    await panel.getByRole("combobox", { name: "Run" }).click();
    await app.window.getByRole("option", { name: new RegExp(LONG_RESEARCH_OBJECTIVE.slice(0, 30)) }).click();
    await expect(panel.getByRole("region", { name: "Research run summary" })).toContainText(LONG_RESEARCH_OBJECTIVE);
    // The Map draws the approach's newest contributions and counts the rest.
    const findings = LONG_RESEARCH_EVENTS - 4;
    const map = panel.getByLabel("Research map");
    await expect(map.locator(".research-node")).toHaveCount(6);
    await expect(map.locator(".research-node").first()).toContainText(`Delivery attempt ${findings} completed`);
    await expect(panel.getByRole("button", { name: `${findings - 6} more from Retry timing`, exact: true })).toBeVisible();
    // The Map's filter matches what a branch draws, such as that count, and not a contribution the branch only counts.
    await panel.getByLabel("Filter this view").fill(`${findings - 6} MORE FROM retry`);
    await expect(map.locator(".research-node")).toHaveCount(6);
    await panel.getByLabel("Filter this view").fill("Delivery attempt 1 completed");
    await expect(map.getByText("No approaches match this filter.")).toBeVisible();
    await panel.getByLabel("Filter this view").fill("");
    await expect(map.locator(".research-node")).toHaveCount(6);
    // Findings are read a page at a time, and the filter matches what every finding's card shows.
    await panel.getByRole("tab", { name: "Findings", exact: true }).click();
    const list = panel.getByLabel("Shared findings");
    await expect(panel.getByText(`Showing the latest 20 of ${findings} findings.`, { exact: true })).toBeVisible();
    await expect(list.getByRole("article")).toHaveCount(20);
    await expect(list.getByRole("article").first()).toContainText(`Delivery attempt ${findings} completed`);
    await panel.getByRole("button", { name: "Show more", exact: true }).click();
    await expect(list.getByRole("article")).toHaveCount(40);
    await panel.getByLabel("Filter this view").fill("Delivery attempt 5 completed");
    await expect(panel.getByText("All 1 matching finding.", { exact: true })).toBeVisible();
    await expect(list.getByRole("article")).toHaveCount(1);
    // Every card names its approach, so the approach's title finds them all.
    await panel.getByLabel("Filter this view").fill("retry timing");
    await expect(panel.getByText(`Showing the latest 20 of ${findings} matching findings.`, { exact: true })).toBeVisible();
    await expect(list.getByRole("article").first()).toContainText(`Delivery attempt ${findings} completed`);
    await panel.getByLabel("Filter this view").fill("");
    await panel.getByRole("tab", { name: "Activity", exact: true }).click();
    const activity = panel.getByLabel("Research activity");
    await expect(activity.getByRole("listitem")).toHaveCount(100);
    await expect(activity.getByRole("listitem").first()).toContainText("The worker ended without a candidate.");
    await expect(panel.getByText(`Showing the latest 100 of ${LONG_RESEARCH_EVENTS} events.`, { exact: true })).toBeVisible();
    await panel.getByRole("button", { name: "Show older", exact: true }).click();
    await expect(activity.getByRole("listitem")).toHaveCount(200);
    await panel.getByRole("button", { name: "Show older", exact: true }).click();
    await expect(activity.getByRole("listitem")).toHaveCount(LONG_RESEARCH_EVENTS);
    await expect(panel.getByText(`All ${LONG_RESEARCH_EVENTS} events.`, { exact: true })).toBeVisible();
    await expect(activity.getByRole("listitem").last()).toContainText(LONG_RESEARCH_OBJECTIVE);
    await expect(panel.getByRole("button", { name: "Show older", exact: true })).toHaveCount(0);
    await expect(activity).toBeFocused();
  } finally { await app.close(); }
});
